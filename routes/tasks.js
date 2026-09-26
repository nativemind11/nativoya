const express = require("express");
const multer = require("multer");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../config/auth");
const driveService = require("../config/googleDrive");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const rawChunk = express.raw({ type: "*/*", limit: "4mb" });
const router = express.Router();

function cleanUrlList(list) {
  return Array.isArray(list) ? list.map((u) => String(u || "").trim()).filter(Boolean) : [];
}

// googleapis errors nest the actual reason from Google deep inside the
// response body (err.response.data.error.message), not in err.message
// itself — so a generic "Could not start the upload" response was hiding
// exactly which Drive API call failed and why (bad folder id, permission
// denied, quota, etc.). This pulls out the most specific string available
// so it can be surfaced in the response instead of only in server logs.
function driveErrorDetail(err) {
  return (
    err?.response?.data?.error?.message ||
    err?.errors?.[0]?.message ||
    err?.message ||
    String(err)
  );
}

// POST /api/tasks  (head_leader only) — publish a new task, either to every
// group (targetAll: true) or to a specific list of groupIds. videoUrls and
// audioSampleUrls each accept an ARRAY of links (a task can have several).
// maleQuantity/femaleQuantity are OPTIONAL — a head_leader can split the
// total quantity by gender (e.g. "60 male, 40 female") so leaders/members
// know how many of each are still needed; leave them out to skip the split.
router.post("/", requireAuth, requireRole("head_leader"), async (req, res) => {
  const {
    skillSlug, title, instructions, totalQuantity,
    memberPrice, leaderPrice, currency, videoUrls, audioSampleUrls, audioSampleTitles,
    targetAll, groupIds, maleQuantity, femaleQuantity,
    recordingSettings, instructionsScriptUrl, instructionsScriptName,
  } = req.body;

  const isTargetAll = targetAll !== false; // default true
  if (!isTargetAll && (!Array.isArray(groupIds) || !groupIds.length)) {
    return res.status(400).json({ error: "groupIds is required when targetAll is false" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO tasks (skill_slug, title, instructions, total_quantity, male_quantity, female_quantity,
                           member_price, leader_price, currency, video_urls, audio_sample_urls, audio_sample_titles, target_all, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'USD'), $10, $11, $12, $13, $14) RETURNING *`,
      [skillSlug, title, instructions, totalQuantity,
       maleQuantity != null && maleQuantity !== "" ? Number(maleQuantity) : null,
       femaleQuantity != null && femaleQuantity !== "" ? Number(femaleQuantity) : null,
       memberPrice || null, leaderPrice || null, currency,
       cleanUrlList(videoUrls), cleanUrlList(audioSampleUrls), cleanUrlList(audioSampleTitles), isTargetAll, req.user.id]
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

    // Add recording settings if this is a voice recording task
    if (skillSlug === "voice_recording" && recordingSettings) {
      await client.query(
        `UPDATE tasks SET recording_settings = $1 WHERE id = $2`,
        [JSON.stringify(recordingSettings), task.id]
      );
    }

    // Add script URL if provided
    if (skillSlug === "voice_recording" && instructionsScriptUrl && instructionsScriptName) {
      await client.query(
        `INSERT INTO recording_scripts (task_id, script_url, script_name, uploaded_by)
         VALUES ($1, $2, $3, $4) ON CONFLICT(task_id) DO UPDATE SET script_url = $2, script_name = $3`,
        [task.id, instructionsScriptUrl, instructionsScriptName, req.user.id]
      );
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

// POST /api/tasks/:id/instructions-file  (head_leader only) — attach or
// replace the task's uploaded PDF/TXT instructions file. Kept as its own
// endpoint (multipart) so the main create/update routes above can stay
// plain JSON.
router.post("/:id/instructions-file", requireAuth, requireRole("head_leader"), upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "مفيش ملف اتبعت." });

    const taskResult = await pool.query("SELECT id, title, drive_folder_id FROM tasks WHERE id = $1", [req.params.id]);
    const task = taskResult.rows[0];
    if (!task) return res.status(404).json({ error: "Task not found" });

    let folderId = task.drive_folder_id;
    if (!folderId) {
      // The task's own folder is normally created at publish time — this is
      // just a fallback for a task published before Drive was connected.
      folderId = await driveService.createTaskFolder(task.title, task.id);
      await pool.query("UPDATE tasks SET drive_folder_id = $1 WHERE id = $2", [folderId, task.id]);
    }

    const uploaded = await driveService.uploadSubmissionFile(
      folderId, req.file.originalname, req.file.mimetype, req.file.buffer
    );

    const result = await pool.query(
      `UPDATE tasks SET instructions_file_url = $1, instructions_file_name = $2 WHERE id = $3 RETURNING *`,
      [uploaded.webViewLink, req.file.originalname, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("[tasks:instructions-file]", err);
    res.status(503).json({ error: "تعذّر رفع الملف — تأكد إن جوجل درايف متصل." });
  }
});

// POST /api/tasks/:id/recording-script  (head_leader only) — upload script text
// for voice recording tasks. This is the text that members will record.
router.post("/:id/recording-script", requireAuth, requireRole("head_leader"), upload.single("script"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "لا يوجد ملف مرفوع" });

    const taskResult = await pool.query("SELECT id, title, drive_folder_id FROM tasks WHERE id = $1", [req.params.id]);
    const task = taskResult.rows[0];
    if (!task) return res.status(404).json({ error: "Task not found" });

    let folderId = task.drive_folder_id;
    if (!folderId) {
      folderId = await driveService.createTaskFolder(task.title, task.id);
      await pool.query("UPDATE tasks SET drive_folder_id = $1 WHERE id = $2", [folderId, task.id]);
    }

    const uploaded = await driveService.uploadSubmissionFile(
      folderId, req.file.originalname, req.file.mimetype, req.file.buffer
    );

    // Save script reference in recording_scripts table
    const result = await pool.query(
      `INSERT INTO recording_scripts (task_id, script_url, script_name, uploaded_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(task_id) DO UPDATE SET script_url = $2, script_name = $3, uploaded_by = $4
       RETURNING *`,
      [req.params.id, uploaded.webViewLink, req.file.originalname, req.user.id]
    );

    // Also update task with script URLs
    await pool.query(
      `UPDATE tasks SET instructions_script_url = $1, instructions_script_name = $2 WHERE id = $3`,
      [uploaded.webViewLink, req.file.originalname, req.params.id]
    );

    res.json({ success: true, script: result.rows[0] });
  } catch (err) {
    console.error("[tasks:recording-script]", err);
    res.status(503).json({ error: "تعذّر رفع ملف النص — تأكد إن جوجل درايف متصل." });
  }
});

// GET /api/tasks/:id/claims  (head_leader only) — full breakdown of who has
// claimed how much of this task (which group/leader) and every individual
// submission made against it (which member, from which group). Also returns
// genderBreakdown: how many males/females have submitted work on this task.
router.get("/:id/claims", requireAuth, requireRole("head_leader"), async (req, res) => {
  try {
    const claims = await pool.query(`
      SELECT tc.id AS claim_id, tc.quantity, tc.claimed_at,
             g.language, g.group_number, g.leader_id,
             lu.first_name AS leader_name,
             t.drive_folder_id AS task_drive_folder_id,
             COALESCE(sc.submitted_count, 0) AS submitted_count
      FROM task_claims tc
      JOIN groups g ON g.id = tc.group_id
      JOIN tasks t ON t.id = tc.task_id
      LEFT JOIN users lu ON lu.id = g.leader_id
      LEFT JOIN (SELECT task_claim_id, COUNT(*) AS submitted_count FROM submissions GROUP BY task_claim_id) sc
        ON sc.task_claim_id = tc.id
      WHERE tc.task_id = $1
      ORDER BY tc.claimed_at ASC
    `, [req.params.id]);

    // Each row gets a Drive folder link to open directly: a leader-led group
    // has its own subfolder (same one uploads actually land in — created
    // lazily here too, harmless if it already exists); a leaderless group's
    // work sits straight in the task's own root folder, shared by all of them.
    for (const row of claims.rows) {
      if (!row.task_drive_folder_id) { row.drive_folder_id = null; continue; }
      if (!row.leader_id) { row.drive_folder_id = row.task_drive_folder_id; continue; }
      try {
        const label = `ليدر ${row.leader_name || "؟"} — جروب #${row.group_number}`;
        row.drive_folder_id = await driveService.getOrCreateLeaderFolder(row.task_drive_folder_id, label);
      } catch (err) {
        console.warn("[tasks:claims-breakdown] couldn't resolve leader folder:", err.message);
        row.drive_folder_id = null;
      }
    }

    const submissions = await pool.query(`
      SELECT s.id, s.status, s.file_url, s.rejection_reason, s.created_at,
             u.first_name AS member_name, u.gender AS member_gender, g.language, g.group_number,
             lu.first_name AS leader_name
      FROM submissions s
      JOIN task_claims tc ON tc.id = s.task_claim_id
      JOIN groups g ON g.id = tc.group_id
      JOIN users u ON u.id = s.submitted_by
      LEFT JOIN users lu ON lu.id = g.leader_id
      WHERE tc.task_id = $1
      ORDER BY s.created_at DESC
    `, [req.params.id]);

    const genderCounts = await pool.query(`
      SELECT u.gender, COUNT(*) AS cnt
      FROM submissions s
      JOIN task_claims tc ON tc.id = s.task_claim_id
      JOIN users u ON u.id = s.submitted_by
      WHERE tc.task_id = $1
      GROUP BY u.gender
    `, [req.params.id]);
    const genderBreakdown = { male: 0, female: 0, unspecified: 0 };
    for (const row of genderCounts.rows) {
      if (row.gender === "male") genderBreakdown.male = Number(row.cnt);
      else if (row.gender === "female") genderBreakdown.female = Number(row.cnt);
      else genderBreakdown.unspecified += Number(row.cnt);
    }

    res.json({ claims: claims.rows, submissions: submissions.rows, genderBreakdown });
  } catch (err) {
    console.error("[tasks:claims-breakdown]", err);
    res.status(500).json({ error: "Could not load claim breakdown" });
  }
});

// GET /api/tasks/manage  (head_leader only) — every task ever published,
// with full details + how much has been claimed, for the admin management table
router.get("/manage", requireAuth, requireRole("head_leader"), async (req, res) => {
  try {
    // claimed_quantity here means "genuinely claimed by a leader to work on"
    // — it excludes auto_claimed rows on purpose. Auto-claims are just an
    // internal availability pool handed to leaderless groups the moment a
    // member opens their dashboard (see /claims/for-my-group), not real
    // work assigned by anyone; counting them here made this column jump to
    // the full total_quantity as soon as any leaderless member loaded their
    // dashboard, even with zero actual submissions.
    const result = await pool.query(`
      SELECT t.*, s.name_ar AS skill_name_ar, s.icon AS skill_icon,
             COALESCE((SELECT SUM(quantity) FROM task_claims WHERE task_id = t.id AND NOT auto_claimed), 0) AS claimed_quantity,
             t.total_quantity - COALESCE((SELECT COUNT(*) FROM submissions s2
                                             JOIN task_claims tc2 ON tc2.id = s2.task_claim_id
                                            WHERE tc2.task_id = t.id), 0) AS remaining
      FROM tasks t
      JOIN services s ON s.slug = t.skill_slug
      ORDER BY t.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("[tasks:manage-list]", err);
    res.status(500).json({ error: "Could not load tasks" });
  }
});

// PUT /api/tasks/:id  (head_leader only) — edit a task's own details.
// total_quantity can't drop below what's already been claimed by groups.
router.put("/:id", requireAuth, requireRole("head_leader"), async (req, res) => {
  try {
    const {
      title, instructions, totalQuantity, memberPrice, leaderPrice, currency,
      videoUrls, audioSampleUrls, audioSampleTitles, maleQuantity, femaleQuantity,
    } = req.body;

    const claimedResult = await pool.query(
      "SELECT COALESCE(SUM(quantity), 0) AS c FROM task_claims WHERE task_id = $1", [req.params.id]
    );
    const claimed = Number(claimedResult.rows[0].c);
    if (totalQuantity != null && Number(totalQuantity) < claimed) {
      return res.status(400).json({ error: `مينفعش الكمية الإجمالية تقل عن ${claimed} — ده اللي اتاستلم بالفعل من المهمة دي.` });
    }

    const result = await pool.query(
      `UPDATE tasks SET
         title = $1, instructions = $2, total_quantity = $3, member_price = $4, leader_price = $5,
         currency = $6, video_urls = $7, audio_sample_urls = $8, audio_sample_titles = $9,
         male_quantity = $10, female_quantity = $11
       WHERE id = $12 RETURNING *`,
      [title, instructions, totalQuantity, memberPrice || null, leaderPrice || null, currency,
       cleanUrlList(videoUrls), cleanUrlList(audioSampleUrls), cleanUrlList(audioSampleTitles),
       maleQuantity != null && maleQuantity !== "" ? Number(maleQuantity) : null,
       femaleQuantity != null && femaleQuantity !== "" ? Number(femaleQuantity) : null,
       req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Task not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("[tasks:update]", err);
    res.status(500).json({ error: "Could not update this task" });
  }
});

// DELETE /api/tasks/:id  (head_leader only) — removes the task and everything
// under it (claims + submissions). task_targets cascades automatically.
router.delete("/:id", requireAuth, requireRole("head_leader"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM submissions WHERE task_claim_id IN (SELECT id FROM task_claims WHERE task_id = $1)`,
      [req.params.id]
    );
    await client.query(`DELETE FROM task_claims WHERE task_id = $1`, [req.params.id]);
    const result = await client.query(`DELETE FROM tasks WHERE id = $1 RETURNING id`, [req.params.id]);
    await client.query("COMMIT");
    if (!result.rows.length) return res.status(404).json({ error: "Task not found" });
    res.json({ deleted: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[tasks:delete]", err);
    res.status(500).json({ error: "Could not delete this task" });
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
             t.total_quantity - COALESCE(sub.submitted_count, 0) AS remaining
      FROM tasks t
      JOIN services s ON s.slug = t.skill_slug
      LEFT JOIN (
        SELECT tc.task_id, COUNT(*) AS submitted_count
        FROM submissions s2 JOIN task_claims tc ON tc.id = s2.task_claim_id
        GROUP BY tc.task_id
      ) sub ON sub.task_id = t.id
      WHERE (($1 = true) OR t.target_all = true OR EXISTS (
        SELECT 1 FROM task_targets tt
        JOIN user_groups ug ON ug.group_id = tt.group_id
        WHERE tt.task_id = t.id AND ug.user_id = $2
      ))
      AND t.total_quantity - COALESCE(sub.submitted_count, 0) > 0
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
// GET /api/tasks/claims/mine?groupId=X  (leader only) — everything a group I
// lead has claimed, with how much capacity is still unfilled inside each claim
router.get("/claims/mine", requireAuth, requireRole("leader"), async (req, res) => {
  try {
    let groupId = req.query.groupId;
    if (groupId) {
      const owns = await pool.query("SELECT 1 FROM groups WHERE id = $1 AND leader_id = $2", [groupId, req.user.id]);
      if (!owns.rows.length) return res.status(403).json({ error: "You don't lead this group" });
    } else {
      const led = await pool.query("SELECT id FROM groups WHERE leader_id = $1 ORDER BY created_at ASC LIMIT 1", [req.user.id]);
      groupId = led.rows[0]?.id;
    }
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
// belong to that still have room, i.e. what I can actually submit work against.
//
// Members whose group has NO leader (they registered without an invite link,
// so they sit directly under the Head Leader) don't have anyone to manually
// "claim" a task for their group — so for those groups we auto-claim the
// full remaining quantity of every visible task the first time it's needed,
// letting the member upload immediately without waiting on a leader.
router.get("/claims/for-my-group", requireAuth, async (req, res) => {
  try {
    // Find every (task, leaderless-group-I'm-in) pair that's visible to me
    // and doesn't have an auto-claim yet.
    const candidates = await pool.query(
      `
      SELECT DISTINCT t.id AS task_id, g.id AS group_id, t.created_by
      FROM tasks t
      JOIN user_groups ug ON ug.user_id = $1
      JOIN groups g ON g.id = ug.group_id AND g.leader_id IS NULL
      WHERE (t.target_all = true OR EXISTS (
              SELECT 1 FROM task_targets tt WHERE tt.task_id = t.id AND tt.group_id = g.id
            ))
        AND NOT EXISTS (SELECT 1 FROM task_claims tc WHERE tc.task_id = t.id AND tc.group_id = g.id)
      `,
      [req.user.id]
    );

    // Auto-claim them ONE AT A TIME, each as its own statement, and — this is
    // the fix — each leaderless group's share is based on how much has
    // actually been SUBMITTED so far (real, delivered work), not on how much
    // OTHER leaderless groups have merely been auto-claimed. Before this,
    // "remaining" was total_quantity minus the SUM of every existing claim
    // (including other groups' auto-claims), so the very first leaderless
    // group to load its dashboard after a task went live would auto-claim
    // the task's ENTIRE quantity for itself, leaving 0 "remaining" for every
    // other leaderless group (i.e. every other language) from that point on
    // — new members joining any of those other groups, or anyone whose group
    // just hadn't had its turn yet, would never get an auto-claim and the
    // task would silently never appear for them at all, even though nobody
    // had actually delivered any real work yet. Each eligible group now gets
    // its own full share independent of the others; genuine over-delivery
    // across many groups on one task is a separate, much rarer concern than
    // a task being invisible to whole languages' worth of members.
    for (const c of candidates.rows) {
      await pool.query(
        `
        INSERT INTO task_claims (task_id, group_id, claimed_by, quantity, auto_claimed)
        SELECT $1, $2, $3, remaining, true
        FROM (
          SELECT t.total_quantity - COALESCE((
            SELECT COUNT(*) FROM submissions s2
            JOIN task_claims tc2 ON tc2.id = s2.task_claim_id
            WHERE tc2.task_id = t.id
          ), 0) AS remaining
          FROM tasks t WHERE t.id = $1
        ) x
        WHERE remaining > 0
        ON CONFLICT (task_id, group_id) WHERE auto_claimed DO NOTHING
        `,
        [c.task_id, c.group_id, c.created_by]
      );
    }

    const result = await pool.query(`
      SELECT DISTINCT ON (t.id)
             tc.id AS claim_id, tc.quantity, tc.group_id,
             t.id AS task_id, t.title, t.instructions, t.video_urls, t.audio_sample_urls,
             t.member_price, t.leader_price, t.currency, s.name_ar AS skill_name_ar, s.icon AS skill_icon,
             g.leader_id, g.group_number, lu.first_name AS leader_name,
             tc.quantity - COALESCE(sc.submitted_count, 0) AS remaining_in_claim
      FROM task_claims tc
      JOIN tasks t ON t.id = tc.task_id
      JOIN groups g ON g.id = tc.group_id
      LEFT JOIN users lu ON lu.id = g.leader_id
      JOIN services s ON s.slug = t.skill_slug
      LEFT JOIN (SELECT task_claim_id, COUNT(*) AS submitted_count FROM submissions GROUP BY task_claim_id) sc
        ON sc.task_claim_id = tc.id
      WHERE tc.group_id IN (SELECT group_id FROM user_groups WHERE user_id = $1)
        AND (tc.quantity - COALESCE(sc.submitted_count, 0)) > 0
      ORDER BY t.id, remaining_in_claim DESC, tc.claimed_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error("[tasks:claims-for-my-group]", err);
    res.status(500).json({ error: "Could not load available claims" });
  }
});

// GET /api/tasks/review-queue?groupId=X  (leader only) — submissions from a
// group I lead that are still waiting for a decision
router.get("/review-queue", requireAuth, requireRole("leader"), async (req, res) => {
  try {
    let groupId = req.query.groupId;
    if (groupId) {
      const owns = await pool.query("SELECT 1 FROM groups WHERE id = $1 AND leader_id = $2", [groupId, req.user.id]);
      if (!owns.rows.length) return res.status(403).json({ error: "You don't lead this group" });
    } else {
      const led = await pool.query("SELECT id FROM groups WHERE leader_id = $1 ORDER BY created_at ASC LIMIT 1", [req.user.id]);
      groupId = led.rows[0]?.id;
    }
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

// GET /api/tasks/review-queue/all  (head_leader only) — every submission on
// the platform still waiting for a decision, across every group/leader —
// since approving/rejecting is now a head_leader-only action.
router.get("/review-queue/all", requireAuth, requireRole("head_leader"), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id AS submission_id, s.file_url, s.created_at,
             t.title AS task_title, u.first_name AS member_name,
             g.language, g.group_number, lu.first_name AS leader_name
      FROM submissions s
      JOIN task_claims tc ON tc.id = s.task_claim_id
      JOIN tasks t ON t.id = tc.task_id
      JOIN users u ON u.id = s.submitted_by
      JOIN groups g ON g.id = tc.group_id
      LEFT JOIN users lu ON lu.id = g.leader_id
      WHERE s.status = 'in_review'
      ORDER BY s.created_at ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("[tasks:review-queue-all]", err);
    res.status(500).json({ error: "Could not load the review queue" });
  }
});

// GET /api/tasks/my-submissions — everything the current member has sent in,
// with its review status
router.get("/my-submissions", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.file_url, s.status, s.rejection_reason, s.created_at, t.title AS task_title
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
             t.total_quantity - COALESCE((SELECT COUNT(*) FROM submissions s2
                                             JOIN task_claims tc2 ON tc2.id = s2.task_claim_id
                                            WHERE tc2.task_id = t.id), 0) AS remaining
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

// POST /api/tasks/:id/claim  (leader only) — claim quantity for one of the
// groups I lead (groupId required once a leader leads more than one language)
router.post("/:id/claim", requireAuth, requireRole("leader"), async (req, res) => {
  try {
    const quantity = Number(req.body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Enter a valid quantity greater than zero" });
    }

    let groupId = req.body.groupId;
    if (groupId) {
      const owns = await pool.query("SELECT 1 FROM groups WHERE id = $1 AND leader_id = $2", [groupId, req.user.id]);
      if (!owns.rows.length) return res.status(403).json({ error: "You don't lead this group" });
    } else {
      const led = await pool.query("SELECT id FROM groups WHERE leader_id = $1 ORDER BY created_at ASC LIMIT 1", [req.user.id]);
      groupId = led.rows[0]?.id;
    }
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

// POST /api/tasks/claims/:claimId/submissions  (member or leader submits a file)
router.post("/claims/:claimId/submissions", requireAuth, requireRole("member", "leader"), async (req, res) => {
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

// POST /api/tasks/claims/:claimId/upload-init — step 1 of a direct-to-Drive
// upload (member OR leader submitting against a claim their own group
// holds). Large recordings can exceed our host's request-body limit if
// relayed through our own server, so the file bytes go straight from the
// browser to Google Drive; our server only resolves the right destination
// folder and hands back a one-time upload URL.
//
// Drive filename convention: "<uploader name> - <uploader WhatsApp> - <ذكر/أنثى> - <original name>"
router.post("/claims/:claimId/upload-init", requireAuth, requireRole("member", "leader"), async (req, res) => {
  try {
    const { filename, mimeType } = req.body;
    if (!filename) return res.status(400).json({ error: "filename is required" });

    // Only .zip and .pdf are accepted deliverables — no text files, audio
    // files, or anything else. Checked here (not just client-side in the
    // <input accept> attribute) because that's only a UI hint and anyone
    // calling the API directly could send whatever they want otherwise.
    const ext = (filename.match(/\.[^.]+$/) || [""])[0].toLowerCase();
    if (ext !== ".zip" && ext !== ".pdf") {
      return res.status(400).json({ error: "مسموح بس برفع ملفات ZIP أو PDF — أي نوع ملف تاني (نصوص، صوت، إلخ) مش مقبول." });
    }

    const claimResult = await pool.query(
      `SELECT tc.id, tc.group_id, t.id AS task_id, t.title, t.drive_folder_id,
              g.leader_id, g.group_number, lu.first_name AS leader_first_name
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

    // Member's own base (leaderless) group → straight into the task's root
    // folder. Member inside a leader's group → into a subfolder named for
    // that leader, so the leader can find exactly their group's work.
    let targetFolderId = claim.drive_folder_id;
    if (claim.leader_id) {
      const leaderLabel = `ليدر ${claim.leader_first_name || "؟"} — جروب #${claim.group_number}`;
      // Advisory lock keyed to this exact (task, group) pair — so if two
      // members of the same leader upload in the same instant, they can't
      // both "look, not found, create" at once and end up with two
      // duplicate folders. Whoever gets the lock first creates it; the
      // other just finds it already there once it's their turn.
      const lockClient = await pool.connect();
      try {
        await lockClient.query("BEGIN");
        await lockClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`leader-folder:${claim.task_id}:${claim.group_id}`]);
        targetFolderId = await driveService.getOrCreateLeaderFolder(claim.drive_folder_id, leaderLabel);
        await lockClient.query("COMMIT");
      } catch (lockErr) {
        await lockClient.query("ROLLBACK").catch(() => {});
        throw lockErr;
      } finally {
        lockClient.release();
      }
    }

    const me = await pool.query("SELECT first_name, whatsapp_number, gender FROM users WHERE id = $1", [req.user.id]);
    const uploaderName = me.rows[0]?.first_name || "member";
    const uploaderWhatsapp = me.rows[0]?.whatsapp_number || "بدون رقم";
    const genderLabel = me.rows[0]?.gender === "male" ? "ذكر" : me.rows[0]?.gender === "female" ? "أنثى" : "غير محدد";
    // Name - WhatsApp number - Gender - original filename (extension preserved).
    const finalFilename = `${uploaderName} - ${uploaderWhatsapp} - ${genderLabel} - ${filename}`;

    const uploadUrl = await driveService.initResumableUpload(targetFolderId, finalFilename, mimeType, req.headers.origin);
    res.json({ uploadUrl });
  } catch (err) {
    console.error("[tasks:upload-init]", err);
    if (err.code === "DRIVE_NOT_CONNECTED") {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل — لازم الهيد ليدر يوصله الأول من لوحة الأدمن." });
    }
    // Surface Google's own reason (permission denied, invalid folder, quota,
    // etc.) instead of the old opaque "Could not start the upload" — that
    // message wasn't mapped to anything specific client-side, so every
    // distinct failure here looked identical and undiagnosable from the UI.
    res.status(500).json({ error: "Could not start the upload", detail: driveErrorDetail(err) });
  }
});

// POST /api/tasks/upload-chunk — relays one piece of the file to the Drive
// resumable session from upload-init. Google's upload endpoint doesn't
// allow the browser to PUT to it directly (no CORS support), so the browser
// sends the file in small pieces to OUR server instead — each comfortably
// under our host's per-request size limit — and we forward each one
// straight through to Drive, server-to-server, where no such limit applies.
router.post("/upload-chunk", requireAuth, requireRole("member", "leader"), rawChunk, async (req, res) => {
  try {
    const uploadUrl = req.headers["x-upload-url"];
    const contentRange = req.headers["x-content-range"];
    if (!uploadUrl || !contentRange) {
      return res.status(400).json({ error: "Missing upload metadata" });
    }
    // Only ever relay to a genuine Drive resumable session we ourselves
    // opened — never let this become an open relay to an arbitrary URL.
    if (!/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/.test(uploadUrl)) {
      return res.status(400).json({ error: "Invalid upload target" });
    }

    const driveRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Range": contentRange,
        "Content-Length": String(req.body.length),
      },
      body: req.body,
    });

    if (driveRes.status === 308) {
      // Drive's own "keep going, send the next chunk" response.
      return res.status(308).end();
    }
    const data = await driveRes.json().catch(() => null);
    if (!driveRes.ok) {
      console.error("[tasks:upload-chunk] Drive rejected chunk", driveRes.status, data);
      return res.status(502).json({ error: "تعذر رفع الملف على جوجل درايف. حاول تاني." });
    }
    res.json({ id: data && data.id });
  } catch (err) {
    console.error("[tasks:upload-chunk]", err);
    res.status(500).json({ error: "Could not relay upload to Drive", detail: driveErrorDetail(err) });
  }
});

// POST /api/tasks/claims/:claimId/upload-finalize — step 2, called by the
// browser once its own direct PUT of the file bytes to the upload-init URL
// has finished. We just verify the claim is still theirs and record the
// submission — the file itself is already on Drive by this point.
router.post("/claims/:claimId/upload-finalize", requireAuth, requireRole("member", "leader"), async (req, res) => {
  try {
    const { fileId } = req.body;
    if (!fileId) return res.status(400).json({ error: "fileId is required" });

    const membership = await pool.query(
      `SELECT 1 FROM task_claims tc
       JOIN user_groups ug ON ug.group_id = tc.group_id
       WHERE tc.id = $1 AND ug.user_id = $2`,
      [req.params.claimId, req.user.id]
    );
    if (!membership.rows.length) {
      return res.status(403).json({ error: "This claim doesn't belong to your group" });
    }

    const webViewLink = await driveService.shareFileWithAnyone(fileId);

    const result = await pool.query(
      `INSERT INTO submissions (task_claim_id, submitted_by, file_url)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.claimId, req.user.id, webViewLink]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("[tasks:upload-finalize]", err);
    res.status(500).json({ error: "Could not save the submission", detail: driveErrorDetail(err) });
  }
});

// POST /api/tasks/submissions/:id/review  (head_leader only — approving or
// rejecting a submission is now a head_leader-only action; leaders can see
// their group's pending submissions but the decision itself belongs to the
// head_leader alone)
router.post("/submissions/:id/review", requireAuth, requireRole("head_leader"), async (req, res) => {
  try {
    const { approve, reason } = req.body;
    if (!approve && !String(reason || "").trim()) {
      return res.status(400).json({ error: "لازم تكتب سبب الرفض عشان يظهر للعضو." });
    }
    const result = await pool.query(
      `UPDATE submissions SET status = $1, rejection_reason = $2, reviewed_by = $3, reviewed_at = now()
       WHERE id = $4 RETURNING *`,
      [approve ? "completed" : "rejected", approve ? null : reason.trim(), req.user.id, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Submission not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("[tasks:review]", err);
    res.status(500).json({ error: "Could not review this submission" });
  }
});

module.exports = router;
