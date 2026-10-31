const express = require("express");
const multer = require("multer");
const { pool } = require("../../db/pool");
const { requireStudioAuth, requireStudioRole } = require("../../config/studioAuth");
const F = require("../../config/studioFeedback");
const A = require("../../config/studioAcceptance");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });   // Vercel rejects bigger bodies anyway
const headLeader = [requireStudioAuth, requireStudioRole("head_leader")];
const uploadFile = (req, res, next) => upload.single("file")(req, res, (err) => (err ? fail(res, err, "تعذر رفع الملف") : next()));

function fail(res, err, fallback) {
  if (err.statusCode) return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "الملف أكبر من 4 ميجا." });
  console.error("[acceptance]", err);
  return res.status(500).json({ error: fallback });
}
const needMigration = async (res) => {
  if (await A.acceptanceReady(pool)) return true;
  res.status(503).json({ error: "هذه الصفحة تحتاج إلى تشغيل migration_studio_v11.sql في Supabase أولًا." });
  return false;
};
const badId = (id) => !A.UUID.test(String(id || ""));

function originalName(file) {      // multer reads the name as latin-1: put Arabic names back
  const n = String((file && file.originalname) || "");
  try { const fixed = Buffer.from(n, "latin1").toString("utf8"); return fixed.includes("\ufffd") ? n : fixed; } catch (_) { return n; }
}

async function ownTask(taskId, headLeaderId) {
  if (badId(taskId)) throw Object.assign(new Error("اختر المهمة أولًا"), { statusCode: 400 });
  const r = await pool.query(`SELECT id FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`, [taskId, headLeaderId]);
  if (!r.rows.length) throw Object.assign(new Error("المهمة غير موجودة"), { statusCode: 404 });
}

function readMapping(body, sheets) {
  const int = (v) => (v === undefined || v === null || v === "" ? NaN : Number(v));
  const sheetIndex = int(body.sheetIndex);
  const sheet = sheets[Number.isInteger(sheetIndex) ? sheetIndex : 0];
  if (!sheet) throw Object.assign(new Error("الشيت غير موجود"), { statusCode: 400 });
  const labelType = body.labelType === "zip" ? "zip" : body.labelType === "smart" ? "smart" : "fake";
  const arr = (raw) => { try { const a = JSON.parse(raw); return Array.isArray(a) ? a.slice(0, 50).map((x) => String(x).slice(0, 100)) : []; } catch (_) { return []; } };
  const nameMap = {};
  if (body.nameMap) {
    try {
      const o = JSON.parse(body.nameMap);
      if (o && typeof o === "object" && !Array.isArray(o)) {
        for (const [k, v] of Object.entries(o).slice(0, 2000)) if (v === "none" || A.UUID.test(String(v))) nameMap[F.normKeyOf(k)] = String(v);
      }
    } catch (_) { /* ignore */ }
  }
  const statusCol = int(body.statusCol);
  const ex = A.extractAcceptRows(sheet, {
    headerRow: int(body.headerRow), labelCol: int(body.labelCol),
    statusCol: Number.isInteger(statusCol) ? statusCol : -1, acceptValues: arr(body.acceptValues),
  });
  return { rows: ex.rows, startRow: ex.startRow, rowNos: ex.rowNos, labelType, meta: { ignored: ex.ignored, ignoredBy: ex.ignoredBy, nameMap } };
}

// POST /api/studio/acceptance/parse — sheets / columns + a guess of which column holds the names.
router.post("/parse", ...headLeader, uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ارفع ملف Excel أو CSV" });
  try {
    if (req.body.taskId) await ownTask(req.body.taskId, req.studioUser.id);
    const sheets = await F.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const out = sheets.map(F.sheetSummary);
    if (req.body.taskId) {      // look INSIDE the columns (which one holds the people's names) — whatever the titles are
      for (let i = 0; i < sheets.length; i++) {
        try { out[i].detect = await F.detectForTask({ db: pool, taskId: req.body.taskId, sheet: sheets[i], summary: out[i] }); }
        catch (e) { console.error("[acceptance] detect failed:", e && e.message); out[i].detect = null; }
      }
    }
    res.json({ sheets: out });
  } catch (err) { fail(res, err, "تعذر قراءة الملف"); }
});

// POST /api/studio/acceptance/preview — matches every row to a person, writes nothing.
router.post("/preview", ...headLeader, uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ارفع الملف" });
  try {
    if (!(await needMigration(res))) return;
    await ownTask(req.body.taskId, req.studioUser.id);
    const sheets = await F.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const m = readMapping(req.body, sheets);
    res.json(await A.resolveAcceptance({ db: pool, taskId: req.body.taskId, headLeaderId: req.studioUser.id, ...m }));
  } catch (err) { fail(res, err, "تعذر معاينة الملف"); }
});

// POST /api/studio/acceptance/apply — marks the matched people as accepted (re-resolves from the file: nothing the browser says is trusted).
router.post("/apply", ...headLeader, uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ارفع الملف" });
  try {
    if (!(await needMigration(res))) return;
    await ownTask(req.body.taskId, req.studioUser.id);
    const sheets = await F.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const m = readMapping(req.body, sheets);
    const confirmWarnings = req.body.confirmWarnings === "1" || req.body.confirmWarnings === "true";
    res.json({ ok: true, ...(await A.applyAcceptance({ db: pool, taskId: req.body.taskId, headLeaderId: req.studioUser.id, ...m, confirmWarnings, fileName: originalName(req.file) })) });
  } catch (err) { fail(res, err, "تعذر تسجيل القبول"); }
});

// GET /api/studio/acceptance/board — every task (published, draft, closed, finished) with its acceptance numbers, newest first.
router.get("/board", ...headLeader, async (req, res) => {
  try {
    if (!(await needMigration(res))) return;
    res.json(await A.listBoard(pool, req.studioUser.id));
  } catch (err) { fail(res, err, "تعذر تحميل القبول"); }
});

// GET /api/studio/acceptance/tasks/:id — the acceptance files of one task + every person with his state.
router.get("/tasks/:id", ...headLeader, async (req, res) => {
  if (badId(req.params.id)) return res.status(404).json({ error: "المهمة غير موجودة" });
  try {
    if (!(await needMigration(res))) return;
    res.json(await A.getTaskDetail(pool, req.params.id, req.studioUser.id));
  } catch (err) { fail(res, err, "تعذر تحميل تفاصيل المهمة"); }
});

// DELETE /api/studio/acceptance/files/:id — undo an acceptance file (its people go back to "not accepted yet").
router.delete("/files/:id", ...headLeader, async (req, res) => {
  if (badId(req.params.id)) return res.status(404).json({ error: "ملف القبول غير موجود" });
  try {
    if (!(await needMigration(res))) return;
    res.json({ ok: true, ...(await A.deleteFile(pool, req.params.id, req.studioUser.id)) });
  } catch (err) { fail(res, err, "تعذر إلغاء الملف"); }
});

// DELETE /api/studio/acceptance/sessions/:id — undo the acceptance of one person.
router.delete("/sessions/:id", ...headLeader, async (req, res) => {
  if (badId(req.params.id)) return res.status(404).json({ error: "هذا القبول غير موجود" });
  try {
    if (!(await needMigration(res))) return;
    res.json({ ok: true, ...(await A.removeAcceptance(pool, req.params.id, req.studioUser.id)) });
  } catch (err) { fail(res, err, "تعذر إلغاء القبول"); }
});

module.exports = router;
