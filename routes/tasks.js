const express = require("express");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../config/auth");

const router = express.Router();

// POST /api/tasks  (head_leader only) — publish a new task to all leaders
router.post("/", requireAuth, requireRole("head_leader"), async (req, res) => {
  const { serviceSlug, title, instructions, totalQuantity } = req.body;
  const result = await pool.query(
    `INSERT INTO tasks (service_slug, title, instructions, total_quantity, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [serviceSlug, title, instructions, totalQuantity, req.user.id]
  );
  res.status(201).json(result.rows[0]);
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
