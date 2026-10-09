const express = require("express");
const { pool } = require("../../db/pool");
const { requireStudioAuth, requireStudioRole } = require("../../config/studioAuth");
const D = require("../../config/studioDelivery");
const { driveStorage } = require("../../config/studioDeliveryStorage");

const router = express.Router();
router.use(requireStudioAuth, requireStudioRole("head_leader"));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Validates the 4 values that identify one group (task × gender × QA × day).
function parseGroup(src) {
  const { taskId, gender, qaReviewerId, day } = src || {};
  if (!UUID.test(String(taskId || ""))) return null;
  if (gender !== "male" && gender !== "female") return null;
  if (qaReviewerId && qaReviewerId !== "none" && !UUID.test(String(qaReviewerId))) return null;
  if (!DAY.test(String(day || ""))) return null;
  return { taskId, gender, day, qaReviewerId: !qaReviewerId || qaReviewerId === "none" ? null : qaReviewerId };
}

function sendXlsx(res, buffer) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
}

// GET /api/studio/delivery/pending — approved sessions waiting for delivery,
// nested task → gender → (QA reviewer + day) group → sessions.
router.get("/pending", async (req, res) => {
  try {
    await D.releaseStaleBatches(pool);
    res.json({ tasks: D.buildPendingTree(await D.fetchPending(pool)) });
  } catch (err) {
    console.error("[delivery:pending]", err);
    res.status(500).json({ error: "تعذر تحميل التسليمات" });
  }
});

// GET /api/studio/delivery/delivered — the permanent archive of collected batches.
router.get("/delivered", async (req, res) => {
  try {
    res.json({ batches: await D.listDelivered(pool) });
  } catch (err) {
    console.error("[delivery:delivered]", err);
    res.status(500).json({ error: "تعذر تحميل الأرشيف" });
  }
});

// GET /api/studio/delivery/sheet?taskId&gender&qaReviewerId&day — Excel for a waiting group.
router.get("/sheet", async (req, res) => {
  const group = parseGroup(req.query);
  if (!group) return res.status(400).json({ error: "بيانات المجموعة غير صحيحة" });
  try {
    const rows = await D.fetchGroupRows(pool, group);
    if (!rows.length) return res.status(404).json({ error: "المجموعة دي مفيهاش تسليمات (يمكن اتجمّعت)." });
    sendXlsx(res, await D.buildSheet(rows, { taskTitle: rows[0].task_title, gender: group.gender, qaName: rows[0].qa_name, day: group.day }));
  } catch (err) {
    console.error("[delivery:sheet]", err);
    res.status(500).json({ error: "تعذر إنشاء الشيت" });
  }
});

// GET /api/studio/delivery/batches/:id/sheet — Excel for an already-delivered batch.
router.get("/batches/:id/sheet", async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: "رقم غير صحيح" });
  try {
    const batch = await D.fetchBatchMeta(pool, req.params.id);
    const rows = batch ? await D.fetchBatchRows(pool, req.params.id) : [];
    if (!rows.length) return res.status(404).json({ error: "التجميع ده مش موجود" });
    sendXlsx(res, await D.buildSheet(rows, { taskTitle: batch.task_title, gender: batch.gender, qaName: batch.qa_name, day: batch.group_day }));
  } catch (err) {
    console.error("[delivery:batch-sheet]", err);
    res.status(500).json({ error: "تعذر إنشاء الشيت" });
  }
});

// POST /api/studio/delivery/collect — merge the group's ZIPs into one big ZIP,
// move the group to the delivered archive. Body: { taskId, gender, qaReviewerId, day }.
router.post("/collect", async (req, res) => {
  const group = parseGroup(req.body);
  if (!group) return res.status(400).json({ error: "بيانات المجموعة غير صحيحة" });
  try {
    const batch = await D.collectGroup({ db: pool, storage: driveStorage, params: group, headLeaderId: req.studioUser.id });
    res.json({ ok: true, batch });
  } catch (err) {
    console.error("[delivery:collect]", err);
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    if (err.code === "DRIVE_NOT_CONNECTED") return res.status(503).json({ error: "جوجل درايف لسه مش متصل بالسيرفر." });
    res.status(500).json({ error: "تعذر التجميع — المجموعة رجعت لقايمة الانتظار، جرّب تاني." });
  }
});

module.exports = router;
