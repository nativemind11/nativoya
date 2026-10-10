const express = require("express");
const multer = require("multer");
const { pool } = require("../../db/pool");
const { requireStudioAuth, requireStudioRole } = require("../../config/studioAuth");
const F = require("../../config/studioFeedback");
const { safeExpire } = require("../../config/studioExpiry");

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
  const labelType = body.labelType === "zip" ? "zip" : "fake";
  const descCol = int(body.descCol);
  const { rows, startRow } = F.extractRows(sheet, {
    headerRow: int(body.headerRow), labelCol: int(body.labelCol), numbersCol: int(body.numbersCol),
    descCol: Number.isInteger(descCol) ? descCol : -1,
  });
  return { rows, startRow, labelType };
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
    res.json({ sheets: sheets.map(F.sheetSummary) });
  } catch (err) { fail(res, err, "تعذر قراءة الملف"); }
});

// POST /api/studio/feedback/preview — matches every row to a session, writes nothing.
router.post("/preview", ...headLeader, uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ارفع الملف" });
  try {
    const taskId = requireTask(req.body);
    await safeExpire(pool);
    const sheets = await F.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const { rows, startRow, labelType } = readMapping(req.body, sheets);
    res.json(await F.resolveRows({ db: pool, taskId, labelType, rows, startRow }));
  } catch (err) { fail(res, err, "تعذر معاينة الملف"); }
});

// POST /api/studio/feedback/apply — sends the named recordings back for rework (12h).
router.post("/apply", ...headLeader, uploadFile, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ارفع الملف" });
  try {
    const taskId = requireTask(req.body);
    await safeExpire(pool);
    const sheets = await F.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const { rows, startRow, labelType } = readMapping(req.body, sheets);
    res.json({ ok: true, ...(await F.applyFeedback({ db: pool, taskId, labelType, rows, startRow, headLeaderId: req.studioUser.id })) });
  } catch (err) { fail(res, err, "تعذر تطبيق الفيدباك"); }
});

// GET /api/studio/feedback/items?taskId= — tracking list for the head leader.
router.get("/items", ...headLeader, async (req, res) => {
  const taskId = req.query.taskId;
  if (taskId && !UUID.test(String(taskId))) return res.status(400).json({ error: "رقم المهمة غير صحيح" });
  try { await safeExpire(pool); res.json({ items: await F.listForHeadLeader(pool, { taskId }) }); }
  catch (err) { fail(res, err, "تعذر تحميل الفيدباك"); }
});

// GET /api/studio/feedback/mine — a talent's own feedback / a leader's team feedback.
router.get("/mine", requireStudioAuth, requireStudioRole("talent", "leader"), async (req, res) => {
  try { await safeExpire(pool); res.json({ items: await F.listMine(pool, req.studioRole, req.studioUser.id) }); }
  catch (err) { fail(res, err, "تعذر تحميل الفيدباك"); }
});

module.exports = router;
