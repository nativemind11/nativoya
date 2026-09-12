const express = require("express");
const multer = require("multer");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../config/auth");
const driveService = require("../config/googleDrive");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

// POST /api/tasks  (head_leader only) — publish a new task to all leaders
router.post("/", requireAuth, requireRole("head_leader"), async (req, res) => {
  const { serviceSlug, title, instructions, totalQuantity } = req.body;
  const result = await pool.query(
    `INSERT INTO tasks (service_slug, title, instructions, total_quantity, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [serviceSlug, title, instructions, totalQuantity, req.user.id]
  );
  const task = result.rows[0];

  // Best-effort: give this task its own Drive folder. If Drive isn't
  // connected yet, the task still works — members just can't upload real
  // files until a head_leader connects it from the admin dashboard.
  try {
    const folderId = await driveService.createTaskFolder(task.title, task.id);
    await pool.query("UPDATE tasks SET drive_folder_id = $1 WHERE id = $2", [folderId, task.id]);
    task.drive_folder_id = folderId;
  } catch (err) {
    console.warn("Drive folder not created for task", task.id, "-", err.message);
  }

  res.status(201).json(task);
});

// GET /api/tasks/open — tasks with remaining unclaimed quantity
router.get("/open", requireAuth, async (req, res) => {
  const result = await pool.query(`
    SELECT t.*, t.total_quantity - COALESCE(SUM(c.quantity), 0) AS remaining
    FROM tasks t
    LEFT JOIN task_claims c ON c.task_id = t.id
    GROUP BY t.id
    HAVING t.total_quantity - COALESCE(SUM(c.quantity), 0) > 0
    ORDER BY t.created_at DESC
  `);
  res.json(result.rows);
});

// GET /api/tasks/claims/mine  (leader only) — everything MY group has claimed,
// with how much capacity is still unfilled inside each claim
router.get("/claims/mine", requireAuth, requireRole("leader"), async (req, res) => {
  const me = await pool.query("SELECT group_id FROM users WHERE id = $1", [req.user.id]);
  const groupId = me.rows[0]?.group_id;
  if (!groupId) return res.json([]);

  const result = await pool.query(`
    SELECT tc.id AS claim_id, tc.quantity, tc.claimed_at,
           t.id AS task_id, t.title, t.instructions,
           tc.quantity - COALESCE(sc.submitted_count, 0) AS remaining_in_claim
    FROM task_claims tc
    JOIN tasks t ON t.id = tc.task_id
    LEFT JOIN (SELECT task_claim_id, COUNT(*) AS submitted_count FROM submissions GROUP BY task_claim_id) sc
      ON sc.task_claim_id = tc.id
    WHERE tc.group_id = $1
    ORDER BY tc.claimed_at DESC
  `, [groupId]);
  res.json(result.rows);
});

// GET /api/tasks/claims/for-my-group — claims my LEADER made for my group that
// still have room, i.e. what a member can actually submit work against
router.get("/claims/for-my-group", requireAuth, async (req, res) => {
  const me = await pool.query("SELECT group_id FROM users WHERE id = $1", [req.user.id]);
  const groupId = me.rows[0]?.group_id;
  if (!groupId) return res.json([]);

  const result = await pool.query(`
    SELECT tc.id AS claim_id, tc.quantity,
           t.id AS task_id, t.title, t.instructions,
           tc.quantity - COALESCE(sc.submitted_count, 0) AS remaining_in_claim
    FROM task_claims tc
    JOIN tasks t ON t.id = tc.task_id
    LEFT JOIN (SELECT task_claim_id, COUNT(*) AS submitted_count FROM submissions GROUP BY task_claim_id) sc
      ON sc.task_claim_id = tc.id
    WHERE tc.group_id = $1
      AND (tc.quantity - COALESCE(sc.submitted_count, 0)) > 0
    ORDER BY tc.claimed_at DESC
  `, [groupId]);
  res.json(result.rows);
});

// GET /api/tasks/review-queue  (leader only) — submissions from MY group's
// members that are still waiting for a decision
router.get("/review-queue", requireAuth, requireRole("leader"), async (req, res) => {
  const me = await pool.query("SELECT group_id FROM users WHERE id = $1", [req.user.id]);
  const groupId = me.rows[0]?.group_id;
  if (!groupId) return res.json([]);

  const result = await pool.query(`
    SELECT s.id AS submission_id, s.file_url, s.created_at,
           t.title AS task_title, u.first_name AS member_name
    FROM submissions s
    JOIN task_claims tc ON tc.id = s.task_claim_id
    JOIN tasks t ON t.id = tc.task_id
    JOIN users u ON u.id = s.submitted_by
    WHERE tc.group_id = $1 AND s.status = 'in_review'
    ORDER BY s.created_at ASC
  `, [groupId]);
  res.json(result.rows);
});

// GET /api/tasks/my-submissions — everything the current member has sent in,
// with its review status
router.get("/my-submissions", requireAuth, async (req, res) => {
  const result = await pool.query(`
    SELECT s.id, s.file_url, s.status, s.created_at, t.title AS task_title
    FROM submissions s
    JOIN task_claims tc ON tc.id = s.task_claim_id
    JOIN tasks t ON t.id = tc.task_id
    WHERE s.submitted_by = $1
    ORDER BY s.created_at DESC
  `, [req.user.id]);
  res.json(result.rows);
});

// POST /api/tasks/:id/claim  (leader only)
router.post("/:id/claim", requireAuth, requireRole("leader"), async (req, res) => {
  const { quantity } = req.body;
  const leader = await pool.query("SELECT group_id FROM users WHERE id = $1", [req.user.id]);
  const groupId = leader.rows[0]?.group_id;
  if (!groupId) return res.status(400).json({ error: "Leader has no group assigned" });

  const result = await pool.query(
    `INSERT INTO task_claims (task_id, group_id, claimed_by, quantity)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.params.id, groupId, req.user.id, quantity]
  );
  res.status(201).json(result.rows[0]);
});

// POST /api/tasks/claims/:claimId/submissions  (member submits a file)
router.post("/claims/:claimId/submissions", requireAuth, requireRole("member"), async (req, res) => {
  const { fileUrl } = req.body; // uploaded to Google Drive first, URL passed here
  const result = await pool.query(
    `INSERT INTO submissions (task_claim_id, submitted_by, file_url)
     VALUES ($1, $2, $3) RETURNING *`,
    [req.params.claimId, req.user.id, fileUrl]
  );
  res.status(201).json(result.rows[0]);
});

// POST /api/tasks/claims/:claimId/upload  (member submits a file — REAL upload)
// Sends the file straight to that task's Google Drive folder and records the
// resulting link as the submission — no manual link-pasting needed.
router.post("/claims/:claimId/upload", requireAuth, requireRole("member"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file was attached" });

  try {
    const claimResult = await pool.query(
      `SELECT tc.id, tc.group_id, t.id AS task_id, t.drive_folder_id
       FROM task_claims tc JOIN tasks t ON t.id = tc.task_id
       WHERE tc.id = $1`,
      [req.params.claimId]
    );
    if (!claimResult.rows.length) return res.status(404).json({ error: "Claim not found" });
    const claim = claimResult.rows[0];

    const me = await pool.query("SELECT group_id, first_name FROM users WHERE id = $1", [req.user.id]);
    if (me.rows[0]?.group_id !== claim.group_id) {
      return res.status(403).json({ error: "This claim doesn't belong to your group" });
    }
    if (!claim.drive_folder_id) {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل — لازم الهيد ليدر يوصله الأول من لوحة الأدمن." });
    }

    const filename = `${me.rows[0].first_name || "member"} - ${Date.now()}-${req.file.originalname}`;
    const uploaded = await driveService.uploadSubmissionFile(
      claim.drive_folder_id, filename, req.file.mimetype, req.file.buffer
    );

    const result = await pool.query(
      `INSERT INTO submissions (task_claim_id, submitted_by, file_url)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.claimId, req.user.id, uploaded.webViewLink]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "DRIVE_NOT_CONNECTED") {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل — لازم الهيد ليدر يوصله الأول من لوحة الأدمن." });
    }
    res.status(500).json({ error: "Upload failed" });
  }
});

// POST /api/submissions/:id/review  (leader approves/rejects)
router.post("/submissions/:id/review", requireAuth, requireRole("leader"), async (req, res) => {
  const { approve } = req.body;
  const result = await pool.query(
    `UPDATE submissions SET status = $1, reviewed_by = $2, reviewed_at = now()
     WHERE id = $3 RETURNING *`,
    [approve ? "completed" : "in_review", req.user.id, req.params.id]
  );
  res.json(result.rows[0]);
});

module.exports = router;
