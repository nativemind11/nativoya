const express = require("express");
const { pool } = require("../db/pool");
const { requireAuth } = require("../config/auth");

const router = express.Router();

// POST /api/groups/join  { language }
// Assigns the current user to the next-numbered group for that language,
// creating a new group if this is the first member of that language.
router.post("/join", requireAuth, async (req, res) => {
  const { language } = req.body;
  if (!language) return res.status(400).json({ error: "language is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // find (or create) the most recent open group for this language.
    // Simplified rule for MVP: always create a new group per N members could
    // be added later; for now we just increment group_number per language.
    const countResult = await client.query(
      "SELECT COALESCE(MAX(group_number), 0) + 1 AS next_number FROM groups WHERE language = $1",
      [language]
    );
    const nextNumber = countResult.rows[0].next_number;

    const groupResult = await client.query(
      `INSERT INTO groups (language, group_number) VALUES ($1, $2) RETURNING *`,
      [language, nextNumber]
    );
    const group = groupResult.rows[0];

    await client.query(
      "UPDATE users SET language = $1, group_id = $2 WHERE id = $3",
      [language, group.id, req.user.id]
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

// GET /api/groups  (head_leader overview)
router.get("/", requireAuth, async (req, res) => {
  const result = await pool.query(`
    SELECT g.*, u.first_name AS leader_name,
      (SELECT COUNT(*) FROM users WHERE group_id = g.id) AS member_count
    FROM groups g LEFT JOIN users u ON u.id = g.leader_id
    ORDER BY g.language, g.group_number
  `);
  res.json(result.rows);
});

module.exports = router;
