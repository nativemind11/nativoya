const express = require("express");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../config/auth");

const router = express.Router();

// POST /api/groups/join  { language, groupNumber? }
// Adds ANOTHER language group to the current user (on top of whatever they
// already joined at signup) — used for "join another language" later, or
// for the invite-link flow (joining a SPECIFIC leader's group by number).
//   • groupNumber provided  -> joins that EXACT existing group (invite link)
//   • not provided          -> joins the language's ORIGINAL group (#1),
//                               creating it if nobody has picked it yet
router.post("/join", requireAuth, async (req, res) => {
  const { language, groupNumber } = req.body;
  if (!language) return res.status(400).json({ error: "language is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const targetNumber = groupNumber || 1;
    const existing = await client.query(
      "SELECT * FROM groups WHERE language = $1 AND group_number = $2",
      [language, targetNumber]
    );

    let group;
    if (existing.rows.length) {
      group = existing.rows[0];
    } else if (!groupNumber) {
      const created = await client.query(
        `INSERT INTO groups (language, group_number) VALUES ($1, 1) RETURNING *`,
        [language]
      );
      group = created.rows[0];
    } else {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Invite group not found" });
    }

    await client.query(
      `INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.id, group.id]
    );

    await client.query("COMMIT");
    res.status(201).json({ group });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Could not join group" });
  } finally {
    client.release();
  }
});

// POST /api/groups/leader-requests  { language }
// A member asks to become a leader for a language. This does NOT create
// a group yet — it just queues a request for the head_leader to approve.
router.post("/leader-requests", requireAuth, async (req, res) => {
  const { language } = req.body;
  if (!language) return res.status(400).json({ error: "language is required" });

  try {
    const existing = await pool.query(
      "SELECT * FROM leader_requests WHERE user_id = $1 AND status = 'pending'",
      [req.user.id]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: "Already have a pending leader request", request: existing.rows[0] });
    }

    const result = await pool.query(
      `INSERT INTO leader_requests (user_id, language) VALUES ($1, $2) RETURNING *`,
      [req.user.id, language]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not submit leader request" });
  }
});

// GET /api/groups/leader-requests/mine — my own latest leadership request, if any
router.get("/leader-requests/mine", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM leader_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [req.user.id]
  );
  res.json(result.rows[0] || null);
});

// GET /api/groups/leader-requests/pending  (head_leader only)
router.get("/leader-requests/pending", requireAuth, requireRole("head_leader"), async (req, res) => {
  const result = await pool.query(`
    SELECT lr.*, u.first_name, u.email, u.whatsapp_number, u.country
    FROM leader_requests lr
    JOIN users u ON u.id = lr.user_id
    WHERE lr.status = 'pending'
    ORDER BY lr.created_at ASC
  `);
  res.json(result.rows);
});

// POST /api/groups/leader-requests/:id/approve  (head_leader only)
// Approving is what actually creates the brand-new group, promotes the
// user to "leader", and adds them as a member of the group they now lead.
router.post("/leader-requests/:id/approve", requireAuth, requireRole("head_leader"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const reqResult = await client.query(
      "SELECT * FROM leader_requests WHERE id = $1 AND status = 'pending' FOR UPDATE",
      [req.params.id]
    );
    if (!reqResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Request not found or already decided" });
    }
    const request = reqResult.rows[0];

    const countResult = await client.query(
      "SELECT COALESCE(MAX(group_number), 0) + 1 AS next_number FROM groups WHERE language = $1",
      [request.language]
    );
    const nextNumber = countResult.rows[0].next_number;

    const groupResult = await client.query(
      `INSERT INTO groups (language, group_number, leader_id) VALUES ($1, $2, $3) RETURNING *`,
      [request.language, nextNumber, request.user_id]
    );
    const group = groupResult.rows[0];

    await client.query("UPDATE users SET role = 'leader' WHERE id = $1", [request.user_id]);
    await client.query(
      `INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [request.user_id, group.id]
    );
    await client.query(
      "UPDATE leader_requests SET status = 'approved', decided_by = $1, decided_at = now() WHERE id = $2",
      [req.user.id, request.id]
    );

    await client.query("COMMIT");
    res.json({ request: { ...request, status: "approved" }, group });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Could not approve request" });
  } finally {
    client.release();
  }
});

// POST /api/groups/leader-requests/:id/reject  (head_leader only)
router.post("/leader-requests/:id/reject", requireAuth, requireRole("head_leader"), async (req, res) => {
  const result = await pool.query(
    `UPDATE leader_requests SET status = 'rejected', decided_by = $1, decided_at = now()
     WHERE id = $2 AND status = 'pending' RETURNING *`,
    [req.user.id, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: "Request not found or already decided" });
  res.json(result.rows[0]);
});

// GET /api/groups/roster  (leader only) — the members of the group I lead
router.get("/roster", requireAuth, requireRole("leader"), async (req, res) => {
  try {
    const led = await pool.query("SELECT id FROM groups WHERE leader_id = $1", [req.user.id]);
    const groupId = led.rows[0]?.id;
    if (!groupId) return res.json([]);

    const result = await pool.query(
      `SELECT u.id, u.first_name, u.reputation_score,
              (SELECT COUNT(*) FROM submissions s
                 WHERE s.submitted_by = u.id AND s.status = 'completed') AS completed_count
       FROM user_groups ug
       JOIN users u ON u.id = ug.user_id
       WHERE ug.group_id = $1 AND u.id != $2
       ORDER BY u.created_at ASC`,
      [groupId, req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load roster" });
  }
});

// GET /api/groups  (head_leader overview + used to populate the "target
// specific groups" picker when publishing a task)
router.get("/", requireAuth, async (req, res) => {
  const result = await pool.query(`
    SELECT g.*, u.first_name AS leader_name,
      (SELECT COUNT(*) FROM user_groups WHERE group_id = g.id) AS member_count
    FROM groups g LEFT JOIN users u ON u.id = g.leader_id
    ORDER BY g.language, g.group_number
  `);
  res.json(result.rows);
});

module.exports = router;
