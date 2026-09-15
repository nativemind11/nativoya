const express = require("express");
const multer = require("multer");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../config/auth");
const driveService = require("../config/googleDrive");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

function cleanUrlList(list) {
  return Array.isArray(list) ? list.map((u) => String(u || "").trim()).filter(Boolean) : [];
}

// POST /api/tasks  (head_leader only) — publish a new task, either to every
// group (targetAll: true) or to a specific list of groupIds. videoUrls and
// audioSampleUrls each accept an ARRAY of links (a task can have several).
router.post("/", requireAuth, requireRole("head_leader"), async (req, res) => {
  const {
    skillSlug, title, instructions, totalQuantity,
    price, currency, videoUrls, audioSampleUrls,
    targetAll, groupIds,
  } = req.body;

  const isTargetAll = targetAll !== false; // default true
  if (!isTargetAll && (!Array.isArray(groupIds) || !groupIds.length)) {
    return res.status(400).json({ error: "groupIds is required when targetAll is false" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO tasks (skill_slug, title, instructions, total_quantity, price, currency,
                           video_urls, audio_sample_urls, target_all, created_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'USD'), $7, $8, $9, $10) RETURNING *`,
      [skillSlug, title, instructions, totalQuantity, price || null, currency,
       cleanUrlList(videoUrls), cleanUrlList(audioSampleUrls), isTargetAll, req.user.id]
    );
    const task = result.rows[0];

    if (!isTargetAll) {
      for (const groupId of groupIds) {
        await client.query(
          `INSERT INTO task_targets (task_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [task.id, groupId]
        );
      }
    }
    await client.query("COMMIT");

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
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[tasks:create]", err);
    res.status(500).json({ error: "Could not publish task" });
  } finally {
    client.release();
  }
});

// GET /api/tasks/open — tasks visible to the current user with remaining
// unclaimed quantity. head_leader sees everything; a leader/member only
// sees tasks that are target_all=true or specifically targeted at one of
// the groups they belong to.
router.get("/open", requireAuth, async (req, res) => {
  try {
    const isHeadLeader = req.user.role === "head_leader";
    const result = await pool.query(
      `
      SELECT t.id, t.title, t.skill_slug, s.name_ar AS skill_name_ar, s.name_en AS skill_name_en,
             s.icon AS skill_icon, t.total_quantity, t.target_all, t.created_at,
             t.total_quantity - COALESCE(SUM(c.quantity), 0) AS remaining
      FROM tasks t
      JOIN services s ON s.slug = t.skill_slug
      LEFT JOIN task_claims c ON c.task_id = t.id
      WHERE ($1 = true) OR t.target_all = true OR EXISTS (
        SELECT 1 FROM task_targets tt
        JOIN user_groups ug ON ug.group_id = tt.group_id
        WHERE tt.task_id = t.id AND ug.user_id = $2
      )
      GROUP BY t.id, s.name_ar, s.name_en, s.icon
      HAVING t.total_quantity - COALESCE(SUM(c.quantity), 0) > 0
      ORDER BY t.created_at DESC
      `,
      [isHeadLeader, req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[tasks:open]", err);
    res.status(500).json({ error: "Could not load tasks" });
  }
});

// GET /api/tasks/:id — full task detail (video(s), audio sample(s), price,
// instructions) — only if the task is visible to this user.
// GET /api/tasks/claims/mine  (leader only) — everything the group I lead
// has claimed, with how much capacity is still unfilled inside each claim
router.get("/claims/mine", requireAuth, requireRole("leader"), async (req, res) => {
  try {
    const led = await pool.query("SELECT id FROM groups WHERE leader_id = $1", [req.user.id]);
    const groupId = led.rows[0]?.id;
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
  } catch (err) {
    console.error("[tasks:claims-mine]", err);
    res.status(500).json({ error: "Could not load your claims" });
  }
});

// GET /api/tasks/claims/for-my-group — claims made for ANY of the groups I
// belong to that still have room, i.e. what I can actually submit work against
router.get("/claims/for-my-group", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT tc.id AS claim_id, tc.quantity,
             t.id AS task_id, t.title, t.instructions, t.video_urls, t.audio_sample_urls,
             t.price, t.currency, s.name_ar AS skill_name_ar, s.icon AS skill_icon,
             tc.quantity - COALESCE(sc.submitted_count, 0) AS remaining_in_claim
      FROM task_claims tc
      JOIN tasks t ON t.id = tc.task_id
      JOIN services s ON s.slug = t.skill_slug
      LEFT JOIN (SELECT task_claim_id, COUNT(*) AS submitted_count FROM submissions GROUP BY task_claim_id) sc
        ON sc.task_claim_id = tc.id
      WHERE tc.group_id IN (SELECT group_id FROM user_groups WHERE user_id = $1)
        AND (tc.quantity - COALESCE(sc.submitted_count, 0)) > 0
      ORDER BY tc.claimed_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error("[tasks:claims-for-my-group]", err);
    res.status(500).json({ error: "Could not load available claims" });
  }
});

// GET /api/tasks/review-queue  (leader only) — submissions from the group I
// lead that are still waiting for a decision
router.get("/review-queue", requireAuth, requireRole("leader"), async (req, res) => {
  try {
    const led = await pool.query("SELECT id FROM groups WHERE leader_id = $1", [req.user.id]);
    const groupId = led.rows[0]?.id;
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
  } catch (err) {
    console.error("[tasks:review-queue]", err);
    res.status(500).json({ error: "Could not load the review queue" });
  }
});

// GET /api/tasks/my-submissions — everything the current member has sent in,
// with its review status
router.get("/my-submissions", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.file_url, s.status, s.created_at, t.title AS task_title
      FROM submissions s
      JOIN task_claims tc ON tc.id = s.task_claim_id
      JOIN tasks t ON t.id = tc.task_id
      WHERE s.submitted_by = $1
      ORDER BY s.created_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error("[tasks:my-submissions]", err);
    res.status(500).json({ error: "Could not load your submissions" });
  }
});

// GET /api/tasks/:id — full task detail (video(s), audio sample(s), price,
// instructions) — only if the task is visible to this user.
// IMPORTANT: this wildcard route must stay registered AFTER every specific
// GET path above (/open, /review-queue, /my-submissions, etc.) — Express
// matches routes in registration order, and "/:id" matches ANY single path
// segment, so if it came first it would swallow requests to those routes
// too (treating "review-queue" as if it were a task id, for example).
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const isHeadLeader = req.user.role === "head_leader";
    const result = await pool.query(
      `
      SELECT t.*, s.name_ar AS skill_name_ar, s.name_en AS skill_name_en, s.icon AS skill_icon,
             t.total_quantity - COALESCE((SELECT SUM(quantity) FROM task_claims WHERE task_id = t.id), 0) AS remaining
      FROM tasks t
      JOIN services s ON s.slug = t.skill_slug
      WHERE t.id = $1 AND (
        $2 = true OR t.target_all = true OR EXISTS (
          SELECT 1 FROM task_targets tt
          JOIN user_groups ug ON ug.group_id = tt.group_id
          WHERE tt.task_id = t.id AND ug.user_id = $3
        )
      )
      `,
      [req.params.id, isHeadLeader, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Task not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("[tasks:detail]", err);
    res.status(500).json({ error: "Could not load task" });
  }
});

// POST /api/tasks/:id/claim  (leader only) — claim quantity for the group I lead
router.post("/:id/claim", requireAuth, requireRole("leader"), async (req, res) => {
  try {
    const quantity = Number(req.body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Enter a valid quantity greater than zero" });
    }

    const led = await pool.query("SELECT id FROM groups WHERE leader_id = $1", [req.user.id]);
    const groupId = led.rows[0]?.id;
    if (!groupId) return res.status(400).json({ error: "Leader has no group assigned" });

    const taskCheck = await pool.query("SELECT id FROM tasks WHERE id = $1", [req.params.id]);
    if (!taskCheck.rows.length) return res.status(404).json({ error: "Task not found" });

    const result = await pool.query(
      `INSERT INTO task_claims (task_id, group_id, claimed_by, quantity)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, groupId, req.user.id, quantity]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("[tasks:claim]", err);
    res.status(500).json({ error: "Could not claim this task" });
  }
});

// POST /api/tasks/claims/:claimId/submissions  (member submits a file)
router.post("/claims/:claimId/submissions", requireAuth, requireRole("member"), async (req, res) => {
  try {
    const { fileUrl } = req.body; // uploaded to Google Drive first, URL passed here
    const result = await pool.query(
      `INSERT INTO submissions (task_claim_id, submitted_by, file_url)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.claimId, req.user.id, fileUrl]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("[tasks:submissions-link]", err);
    res.status(500).json({ error: "Could not submit your work" });
  }
});

// POST /api/tasks/claims/:claimId/upload  (member submits a file — REAL upload)
// Sends the file straight to that task's Google Drive folder and records the
// resulting link as the submission — no manual link-pasting needed.
//
// Drive filename convention:
//   • member is under a Leader's group  -> "<task title> - <leader first name>"
//   • member is under the Head Leader's group (no leader) -> "<member first name> - <year>"
router.post("/claims/:claimId/upload", requireAuth, requireRole("member"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file was attached" });

  try {
    const claimResult = await pool.query(
      `SELECT tc.id, tc.group_id, t.id AS task_id, t.title, t.drive_folder_id,
              g.leader_id, lu.first_name AS leader_first_name
       FROM task_claims tc
       JOIN tasks t ON t.id = tc.task_id
       JOIN groups g ON g.id = tc.group_id
       LEFT JOIN users lu ON lu.id = g.leader_id
       WHERE tc.id = $1`,
      [req.params.claimId]
    );
    if (!claimResult.rows.length) return res.status(404).json({ error: "Claim not found" });
    const claim = claimResult.rows[0];

    const membership = await pool.query(
      "SELECT 1 FROM user_groups WHERE user_id = $1 AND group_id = $2",
      [req.user.id, claim.group_id]
    );
    if (!membership.rows.length) {
      return res.status(403).json({ error: "This claim doesn't belong to your group" });
    }
    if (!claim.drive_folder_id) {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل — لازم الهيد ليدر يوصله الأول من لوحة الأدمن." });
    }

    const me = await pool.query("SELECT first_name FROM users WHERE id = $1", [req.user.id]);
    const memberName = me.rows[0]?.first_name || "member";
    const filename = claim.leader_id
      ? `${claim.title} - ${claim.leader_first_name || "leader"} - ${Date.now()}-${req.file.originalname}`
      : `${memberName} - ${new Date().getFullYear()} - ${Date.now()}-${req.file.originalname}`;

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
    console.error("[tasks:upload]", err);
    if (err.code === "DRIVE_NOT_CONNECTED") {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل — لازم الهيد ليدر يوصله الأول من لوحة الأدمن." });
    }
    res.status(500).json({ error: "Upload failed" });
  }
});

// POST /api/tasks/submissions/:id/review  (leader approves/rejects)
router.post("/submissions/:id/review", requireAuth, requireRole("leader"), async (req, res) => {
  try {
    const { approve } = req.body;
    const result = await pool.query(
      `UPDATE submissions SET status = $1, reviewed_by = $2, reviewed_at = now()
       WHERE id = $3 RETURNING *`,
      [approve ? "completed" : "in_review", req.user.id, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Submission not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("[tasks:review]", err);
    res.status(500).json({ error: "Could not review this submission" });
  }
});

module.exports = router;
