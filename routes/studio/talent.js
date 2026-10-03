const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const archiver = require("archiver");
const { google } = require("googleapis");
const { pool } = require("../../db/pool");
const { getAuthorizedClient, uploadSubmissionFile } = require("../../config/googleDrive");
const { getOrCreateStudioRootFolder, getOrCreateSubfolder } = require("../../config/studioDrive");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Everything in this file is PUBLIC — talents never have an account. Their
// only "identity" is an opaque session_token kept in their own browser.

// GET /api/studio/talent/tasks — published tasks open for recording.
router.get("/tasks", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.id, t.title, t.difficulty, t.quantity, t.recording_settings,
        (SELECT COUNT(*) FROM recording_samples WHERE task_id = t.id) AS sample_count,
        (SELECT COUNT(*) FROM recording_sessions WHERE task_id = t.id) AS submission_count
      FROM recording_tasks t
      WHERE t.status = 'published'
      ORDER BY t.published_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل المهام" });
  }
});

// GET /api/studio/talent/tasks/:id — detail + which leader codes are open.
router.get("/tasks/:id", async (req, res) => {
  try {
    const taskResult = await pool.query(
      `SELECT * FROM recording_tasks WHERE id = $1 AND status = 'published'`, [req.params.id]
    );
    if (!taskResult.rows.length) return res.status(404).json({ error: "المهمة مش متاحة" });

    const leaders = await pool.query(`
      SELECT l.id, l.leader_code FROM recording_task_leaders rtl
      JOIN studio_leaders l ON l.id = rtl.leader_id
      WHERE rtl.task_id = $1 ORDER BY l.leader_code
    `, [req.params.id]);

    const sampleCount = await pool.query(`SELECT COUNT(*) FROM recording_samples WHERE task_id = $1`, [req.params.id]);

    res.json({ task: taskResult.rows[0], leaders: leaders.rows, sampleCount: Number(sampleCount.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل تفاصيل المهمة" });
  }
});

// GET /api/studio/talent/tasks/:id/fake-names — names from the pool that
// NOBODY has reserved yet for this task.
router.get("/tasks/:id/fake-names", async (req, res) => {
  try {
    const taskResult = await pool.query(`SELECT fake_names FROM recording_tasks WHERE id = $1`, [req.params.id]);
    if (!taskResult.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });

    const taken = await pool.query(`SELECT fake_name FROM recording_sessions WHERE task_id = $1`, [req.params.id]);
    const takenSet = new Set(taken.rows.map(r => r.fake_name));
    const available = taskResult.rows[0].fake_names.filter(n => !takenSet.has(n));
    res.json(available);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل قائمة الأسامي" });
  }
});

// POST /api/studio/talent/sessions — reserve a fake name + start a session.
router.post("/sessions", async (req, res) => {
  const { taskId, leaderId, gender, ageBracket, age, fakeName, realName, whatsapp } = req.body;
  if (!taskId || !leaderId || !gender || !ageBracket || !fakeName) {
    return res.status(400).json({ error: "البيانات ناقصة، املا كل الحقول المطلوبة" });
  }
  if (!["male", "female"].includes(gender)) return res.status(400).json({ error: "النوع غير صحيح" });
  if (!["child", "adult", "elderly"].includes(ageBracket)) return res.status(400).json({ error: "الفئة العمرية غير صحيحة" });

  try {
    const taskResult = await pool.query(`SELECT * FROM recording_tasks WHERE id = $1 AND status = 'published'`, [taskId]);
    if (!taskResult.rows.length) return res.status(404).json({ error: "المهمة مش متاحة" });
    if (!taskResult.rows[0].fake_names.includes(fakeName)) {
      return res.status(400).json({ error: "الاسم ده مش من ضمن القائمة المتاحة" });
    }

    const leaderResult = await pool.query(
      `SELECT 1 FROM recording_task_leaders WHERE task_id = $1 AND leader_id = $2`, [taskId, leaderId]
    );
    if (!leaderResult.rows.length) return res.status(400).json({ error: "الكود ده مش مسموح له بالمهمة دي" });

    const sessionToken = crypto.randomBytes(24).toString("hex");
    const result = await pool.query(
      `INSERT INTO recording_sessions
         (task_id, leader_id, session_token, gender, age_bracket, age, fake_name, real_name, whatsapp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [taskId, leaderId, sessionToken, gender, ageBracket, age || null, fakeName, realName || null, whatsapp || null]
    );

    const samples = await pool.query(
      `SELECT * FROM recording_samples WHERE task_id = $1 ORDER BY order_index`, [taskId]
    );

    res.status(201).json({ session: result.rows[0], samples: samples.rows });
  } catch (err) {
    if (err.code === "23505") { // unique_violation — someone else just took this name
      return res.status(409).json({ error: "للأسف حد تاني اختار الاسم ده قبلك بثانية. اختار اسم تاني." });
    }
    console.error(err);
    res.status(500).json({ error: "تعذر بدء الجلسة" });
  }
});

// GET /api/studio/talent/sessions/:token — resume: session + samples + what's recorded so far.
router.get("/sessions/:token", async (req, res) => {
  try {
    const sessionResult = await pool.query(`
      SELECT rs.*, t.recording_settings, t.title AS task_title
      FROM recording_sessions rs JOIN recording_tasks t ON t.id = rs.task_id
      WHERE rs.session_token = $1
    `, [req.params.token]);
    if (!sessionResult.rows.length) return res.status(404).json({ error: "الجلسة دي مش موجودة" });
    const session = sessionResult.rows[0];

    const samples = await pool.query(`
      SELECT s.*, ss.audio_file_url, ss.duration AS recorded_duration, ss.retakes, ss.completed_at
      FROM recording_samples s
      LEFT JOIN recording_session_samples ss ON ss.sample_id = s.id AND ss.session_id = $1
      WHERE s.task_id = $2
      ORDER BY s.order_index
    `, [session.id, session.task_id]);

    res.json({ session, samples: samples.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل الجلسة" });
  }
});

// POST /api/studio/talent/sessions/:token/samples/:sampleId/audio — upload
// (or replace) the recording for ONE sentence.
router.post("/sessions/:token/samples/:sampleId/audio", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لازم ترفع تسجيل صوتي" });

  try {
    const sessionResult = await pool.query(`SELECT * FROM recording_sessions WHERE session_token = $1`, [req.params.token]);
    if (!sessionResult.rows.length) return res.status(404).json({ error: "الجلسة دي مش موجودة" });
    const session = sessionResult.rows[0];
    if (session.status !== "in_progress") {
      return res.status(400).json({ error: "الجلسة دي خلصت بالفعل، مينفعش تعدّل فيها" });
    }

    const taskResult = await pool.query(`SELECT * FROM recording_tasks WHERE id = $1`, [session.task_id]);
    const task = taskResult.rows[0];

    const authClient = await getAuthorizedClient();
    const drive = google.drive({ version: "v3", auth: authClient });
    const studioRoot = await getOrCreateStudioRootFolder();
    const taskFolderId = await getOrCreateSubfolder(drive, studioRoot, `${task.title} — ${task.id.slice(0, 8)}`);
    const sessionsFolderId = await getOrCreateSubfolder(drive, taskFolderId, "_sessions (working files)");
    const talentFolderId = await getOrCreateSubfolder(drive, sessionsFolderId, session.fake_name);

    const uploaded = await uploadSubmissionFile(talentFolderId, req.file.originalname, req.file.mimetype, req.file.buffer);
    const audioUrl = uploaded.id ? `drive:${uploaded.id}` : null; // internal reference, resolved again at zip time
    const duration = req.body.duration ? Number(req.body.duration) : null;

    const existing = await pool.query(
      `SELECT * FROM recording_session_samples WHERE session_id = $1 AND sample_id = $2`,
      [session.id, req.params.sampleId]
    );
    if (existing.rows.length) {
      await pool.query(
        `UPDATE recording_session_samples
         SET audio_file_url = $1, duration = $2, retakes = retakes + 1, completed_at = now()
         WHERE id = $3`,
        [audioUrl, duration, existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO recording_session_samples (session_id, sample_id, audio_file_url, duration, completed_at)
         VALUES ($1, $2, $3, $4, now())`,
        [session.id, req.params.sampleId, audioUrl, duration]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    if (err.code === "DRIVE_NOT_CONNECTED") {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل بالسيرفر." });
    }
    res.status(500).json({ error: "تعذر رفع التسجيل" });
  }
});

// POST /api/studio/talent/sessions/:token/submit — all sentences must be
// recorded. Downloads every recorded clip back from Drive, zips them
// locally, names the zip fake_name-gender-age_bracket-age.zip, uploads it
// to that leader code's QA folder, and marks the session submitted.
router.post("/sessions/:token/submit", async (req, res) => {
  try {
    const sessionResult = await pool.query(`SELECT * FROM recording_sessions WHERE session_token = $1`, [req.params.token]);
    if (!sessionResult.rows.length) return res.status(404).json({ error: "الجلسة دي مش موجودة" });
    const session = sessionResult.rows[0];
    if (session.status !== "in_progress") {
      return res.status(400).json({ error: "الجلسة دي اتسلّمت بالفعل" });
    }

    const task = (await pool.query(`SELECT * FROM recording_tasks WHERE id = $1`, [session.task_id])).rows[0];
    const leader = (await pool.query(`SELECT * FROM studio_leaders WHERE id = $1`, [session.leader_id])).rows[0];

    const totalSamples = await pool.query(`SELECT COUNT(*) FROM recording_samples WHERE task_id = $1`, [session.task_id]);
    const recordedSamples = await pool.query(
      `SELECT ss.* FROM recording_session_samples ss WHERE ss.session_id = $1 AND ss.audio_file_url IS NOT NULL`,
      [session.id]
    );
    if (Number(recordedSamples.rows.length) < Number(totalSamples.rows[0].count)) {
      return res.status(400).json({
        error: `لسه مسجّلش كل الجمل (${recordedSamples.rows.length}/${totalSamples.rows[0].count}). كمّل الباقي الأول.`,
      });
    }

    const authClient = await getAuthorizedClient();
    const drive = google.drive({ version: "v3", auth: authClient });

    // Build the zip in memory by streaming each clip down from Drive.
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks = [];
    archive.on("data", (chunk) => chunks.push(chunk));
    const archiveFinished = new Promise((resolve, reject) => {
      archive.on("end", resolve);
      archive.on("error", reject);
    });

    const samplesWithNames = await pool.query(`
      SELECT ss.audio_file_url, s.order_index, s.sentence_name
      FROM recording_session_samples ss
      JOIN recording_samples s ON s.id = ss.sample_id
      WHERE ss.session_id = $1 ORDER BY s.order_index
    `, [session.id]);

    for (const row of samplesWithNames.rows) {
      const fileId = row.audio_file_url.replace("drive:", "");
      const fileStream = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
      const ext = (task.recording_settings.format || "wav").toLowerCase();
      archive.append(fileStream.data, { name: `${String(row.order_index + 1).padStart(2, "0")}.${ext}` });
    }
    archive.finalize();
    await archiveFinished;
    const zipBuffer = Buffer.concat(chunks);

    const zipFileName = `${session.fake_name}-${session.gender}-${session.age_bracket}-${session.age || "NA"}.zip`;

    const studioRoot = await getOrCreateStudioRootFolder();
    const taskFolderId = await getOrCreateSubfolder(drive, studioRoot, `${task.title} — ${task.id.slice(0, 8)}`);
    const qaFolderId = await getOrCreateSubfolder(drive, taskFolderId, `${leader.leader_code} - QA Reviews`);
    const uploadedZip = await uploadSubmissionFile(qaFolderId, zipFileName, "application/zip", zipBuffer);
    const zipFileUrl = uploadedZip.webViewLink || `https://drive.google.com/file/d/${uploadedZip.id}/view`;

    await pool.query(
      `UPDATE recording_sessions
       SET status = 'submitted', zip_file_url = $1, zip_file_name = $2, updated_at = now()
       WHERE id = $3`,
      [zipFileUrl, zipFileName, session.id]
    );

    res.json({ ok: true, zipFileName });
  } catch (err) {
    console.error(err);
    if (err.code === "DRIVE_NOT_CONNECTED") {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل بالسيرفر." });
    }
    res.status(500).json({ error: "تعذر تسليم التاسك، حاول تاني" });
  }
});

module.exports = router;
