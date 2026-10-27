const express = require("express");
const multer = require("multer");
const { pool } = require("../../db/pool");
const { requireStudioAuth, requireStudioRole } = require("../../config/studioAuth");
const F = require("../../config/studioFeedback");
const { safeExpire } = require("../../config/studioExpiry");
const { v7Ready } = require("../../config/studioV7");
const Board = require("../../config/studioReworkBoard");
const { driveStorage } = require("../../config/studioDeliveryStorage");

const router = express.Router();
// 4MB: Vercel rejects larger request bodies anyway, and a feedback sheet is tiny.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headLeader = [requireStudioAuth, requireStudioRole("head_leader")];
// multer reports an oversized file via next(err); turn that into a clear 413
// instead of letting it fall through to a generic 500.
const uploadFile = (req, res, next) =>
  upload.single("file")(req, res, (err) => (err ? fail(res, err, "تعذر رفع الملف") : next()));

function fail(res, err, fallback) {
  if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
  if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "الملف أكبر من 4 ميجا." });
  console.error("[feedback]", err);
  return res.status(500).json({ error: fallback });
}

// The file travels with every step (parse -> preview -> apply) instead of the
// server keeping state: nothing to expire, nothing to clean up, and "apply"
// always works from the real file rather than from what the browser claims.
function readMapping(body, sheets) {
  const int = (v) => (v === undefined || v === null || v === "" ? NaN : Number(v));
  const sheetIndex = int(body.sheetIndex);
  const sheet = sheets[Number.isInteger(sheetIndex) ? sheetIndex : 0];
  if (!sheet) throw Object.assign(new Error("الشيت غير موجود"), { statusCode: 400 });
  const labelType = body.labelType === "zip" ? "zip" : body.labelType === "smart" ? "smart" : "fake";
  const descCol = int(body.descCol);
  const numbersMode = body.numbersMode === "row_order" ? "row_order" : body.numbersMode === "match" ? "match" : "column";
  const fileCol = int(body.fileCol), textCol = int(body.textCol);
  // manual name choices: { "<label as in the sheet>": "<session id>" } — validated against the task's sessions when resolving
  let nameMap = {};
  if (body.nameMap) {
    try {
      const o = JSON.parse(body.nameMap);
      if (o && typeof o === "object" && !Array.isArray(o)) {
        for (const [k, v] of Object.entries(o).slice(0, 2000)) if (v === "none" || UUID.test(String(v))) nameMap[F.normKeyOf(k)] = String(v);
      }
    } catch (_) { /* ignore */ }
  }
  const statusCol = int(body.statusCol);
  let rejectValues = [];
  if (body.rejectValues) {
    try { const a = JSON.parse(body.rejectValues); if (Array.isArray(a)) rejectValues = a.slice(0, 50).map((x) => String(x).slice(0, 100)); } catch (_) { /* ignore */ }
  }
  let finalValues = [];
  if (body.finalValues) {
    try { const a = JSON.parse(body.finalValues); if (Array.isArray(a)) finalValues = a.slice(0, 50).map((x) => String(x).slice(0, 100)); } catch (_) { /* ignore */ }
  }
  const allFinal = body.allFinal === "1" || body.allFinal === "true";
  const ex = F.extractRows(sheet, {
    headerRow: int(body.headerRow), labelCol: int(body.labelCol), numbersCol: int(body.numbersCol),
    descCol: Number.isInteger(descCol) ? descCol : -1,
    numbersMode, statusCol: Number.isInteger(statusCol) ? statusCol : -1, rejectValues,
    fileCol: Number.isInteger(fileCol) ? fileCol : -1, textCol: Number.isInteger(textCol) ? textCol : -1,
    finalValues, allFinal,
  });
  return {
    rows: ex.rows, startRow: ex.startRow, rowNos: ex.rowNos, labelType,
    meta: { numbersMode: ex.numbersMode, rowCounts: ex.rowCounts, ignored: ex.ignored, ignoredBy: ex.ignoredBy, nameMap },
  };
}

function requireTask(body) {
  if (!UUID.test(String(body.taskId || ""))) throw Object.assign(new Error("اختار المهمة الأول"), { statusCode: 400 });
  return body.taskId;
}

// POST /api/studio/feedback/parse — reads the file, returns sheets/columns + guessed mapping.
router.post("/parse", ...headLeader, uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ارفع ملف Excel أو CSV" });
  try {
    const sheets = await F.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const out = sheets.map(F.sheetSummary);
    // v5: when the task is known, look at what is INSIDE the columns (names / audio files / sentences) to suggest the mapping
    if (UUID.test(String(req.body.taskId || ""))) {
      for (let i = 0; i < sheets.length; i++) {
        try { out[i].detect = await F.detectForTask({ db: pool, taskId: req.body.taskId, sheet: sheets[i], summary: out[i] }); }
        catch (e) { console.error("[feedback] detect failed:", e && e.message); out[i].detect = null; }
      }
    }
    res.json({ sheets: out });
  } catch (err) { fail(res, err, "تعذر قراءة الملف"); }
});

// POST /api/studio/feedback/preview — matches every row to a session, writes nothing.
router.post("/preview", ...headLeader, uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ارفع الملف" });
  try {
    const taskId = requireTask(req.body);
    await safeExpire(pool);
    const sheets = await F.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const { rows, startRow, rowNos, labelType, meta } = readMapping(req.body, sheets);
    res.json(await F.resolveRows({ db: pool, taskId, labelType, rows, startRow, rowNos, meta }));
  } catch (err) { fail(res, err, "تعذر معاينة الملف"); }
});

// multer reads the uploaded file's name as latin-1: put Arabic names back
function originalName(file) {
  const n = String((file && file.originalname) || "");
  try { const fixed = Buffer.from(n, "latin1").toString("utf8"); return fixed.includes("\ufffd") ? n : fixed; } catch (_) { return n; }
}

// POST /api/studio/feedback/apply — sends the named recordings back for rework (the task's hours, or `reworkHours` from the form).
router.post("/apply", ...headLeader, uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ارفع الملف" });
  try {
    const taskId = requireTask(req.body);
    await safeExpire(pool);
    const sheets = await F.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const { rows, startRow, rowNos, labelType, meta } = readMapping(req.body, sheets);
    const confirmWarnings = req.body.confirmWarnings === "1" || req.body.confirmWarnings === "true";
    res.json({ ok: true, ...(await F.applyFeedback({ db: pool, taskId, labelType, rows, startRow, rowNos, meta, confirmWarnings, headLeaderId: req.studioUser.id, reworkHours: req.body.reworkHours, fileName: originalName(req.file) })) });
  } catch (err) { fail(res, err, "تعذر تطبيق الفيدباك"); }
});

// GET /api/studio/feedback/items?taskId= — tracking list for the head leader.
router.get("/items", ...headLeader, async (req, res) => {
  const taskId = req.query.taskId;
  if (taskId && !UUID.test(String(taskId))) return res.status(400).json({ error: "رقم المهمة غير صحيح" });
  try { await safeExpire(pool); res.json({ items: await F.listForHeadLeader(pool, { taskId }) }); }
  catch (err) { fail(res, err, "تعذر تحميل الفيدباك"); }
});

// ------------------------------------------------------------------ v7: the feedback page
const needV7 = async (res) => {
  if (await v7Ready(pool)) return true;
  res.status(503).json({ error: "الصفحة دي محتاجة تشغيل migration_studio_v7.sql في Supabase الأول." });
  return false;
};
const sendXlsx = (res, buf, name) => {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(name)}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(buf);
};

// GET /api/studio/feedback/board?taskId= — task -> feedback file -> one row per person (the live list).
router.get("/board", ...headLeader, async (req, res) => {
  const taskId = req.query.taskId;
  if (taskId && !UUID.test(String(taskId))) return res.status(400).json({ error: "رقم المهمة غير صحيح" });
  try {
    if (!(await needV7(res))) return;
    await safeExpire(pool);
    res.json(await Board.listBoard(pool, { taskId }));
  } catch (err) { fail(res, err, "تعذر تحميل الفيدباك"); }
});

// GET /api/studio/feedback/files/:id/sheet?gender= — Excel of the people of this file who are ready (names as in the company's file).
router.get("/files/:id/sheet", ...headLeader, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: "رقم غير صحيح" });
  const gender = req.query.gender === "male" || req.query.gender === "female" ? req.query.gender : null;
  try {
    if (!(await needV7(res))) return;
    const file = await Board.fetchFile(pool, req.params.id);
    if (!file) return res.status(404).json({ error: "ملف الفيدباك مش موجود" });
    const people = await Board.fetchReady(pool, req.params.id, gender);
    if (!people.length) return res.status(404).json({ error: "مفيش حد جاهز في الملف ده دلوقتي (يمكن اتجمّعوا)." });
    sendXlsx(res, await Board.buildReworkSheet(people, { taskTitle: file.task_title, fileName: file.file_name, fileCreatedAt: file.created_at, gender }), `Rework sheet - ${file.task_title}.xlsx`);
  } catch (err) { fail(res, err, "تعذر إنشاء الشيت"); }
});

// POST /api/studio/feedback/files/:id/collect { gender } — ZIP of the people who delivered the rework and QA approved.
router.post("/files/:id/collect", ...headLeader, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: "رقم غير صحيح" });
  try {
    if (!(await needV7(res))) return;
    const batch = await Board.collectRework({ db: pool, storage: driveStorage, fileId: req.params.id, gender: (req.body || {}).gender, headLeaderId: req.studioUser.id });
    res.json({ ok: true, batch });
  } catch (err) {
    if (err.code === "DRIVE_NOT_CONNECTED") return res.status(503).json({ error: "جوجل درايف لسه مش متصل بالسيرفر." });
    fail(res, err, "تعذر التجميع — الناس رجعت لقايمة الانتظار، جرّب تاني.");
  }
});

// GET /api/studio/feedback/delivered?taskId= — the delivered rework: task -> file -> batches (with people and dates).
router.get("/delivered", ...headLeader, async (req, res) => {
  const taskId = req.query.taskId;
  if (taskId && !UUID.test(String(taskId))) return res.status(400).json({ error: "رقم المهمة غير صحيح" });
  try {
    if (!(await needV7(res))) return;
    res.json(await Board.listReworkBatches(pool, { taskId }));
  } catch (err) { fail(res, err, "تعذر تحميل الريورك المتسلّم"); }
});

// GET /api/studio/feedback/batches/:id/sheet — Excel of one delivered rework batch.
router.get("/batches/:id/sheet", ...headLeader, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: "رقم غير صحيح" });
  try {
    if (!(await needV7(res))) return;
    const found = await Board.fetchBatchForSheet(pool, req.params.id);
    if (!found || !found.people.length) return res.status(404).json({ error: "التجميع ده مش موجود" });
    const { batch, people } = found;
    sendXlsx(res, await Board.buildReworkSheet(people, { taskTitle: batch.task_title, fileName: batch.file_name, fileCreatedAt: batch.file_created_at, gender: batch.gender, deliveredAt: batch.delivered_at }), `Rework sheet - ${batch.task_title}.xlsx`);
  } catch (err) { fail(res, err, "تعذر إنشاء الشيت"); }
});

// GET /api/studio/feedback/mine — a talent's own feedback / a leader's team feedback.
router.get("/mine", requireStudioAuth, requireStudioRole("talent", "leader"), async (req, res) => {
  try { await safeExpire(pool); res.json({ items: await F.listMine(pool, req.studioRole, req.studioUser.id) }); }
  catch (err) { fail(res, err, "تعذر تحميل الفيدباك"); }
});

module.exports = router;
