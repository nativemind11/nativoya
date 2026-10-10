const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { google } = require("googleapis");
const { pool } = require("../../db/pool");
const { requireStudioAuth, requireStudioRole } = require("../../config/studioAuth");
const { getAuthorizedClient, uploadSubmissionFile } = require("../../config/googleDrive");
const { getOrCreateStudioRootFolder, getOrCreateSubfolder } = require("../../config/studioDrive");
const { readLines } = require("../../config/textFile");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.use(requireStudioAuth, requireStudioRole("head_leader"));

// POST /api/studio/headleader/qa-reviewers — create a QA reviewer account.
// No public signup for these — only a head_leader can create one.
router.post("/qa-reviewers", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "الاسم والإيميل وكلمة المرور مطلوبين" });
  if (password.length < 6) return res.status(400).json({ error: "كلمة المرور لازم تكون 6 أحرف على الأقل" });

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO studio_qa_reviewers (name, email, password_hash, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id, name, email, created_at`,
      [name, email, passwordHash, req.studioUser.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "فيه حساب بالإيميل ده بالفعل" });
    console.error(err);
    res.status(500).json({ error: "تعذر إنشاء الحساب" });
  }
});

// GET /api/studio/headleader/qa-reviewers — list them.
router.get("/qa-reviewers", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, created_at FROM studio_qa_reviewers ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل قائمة المراجعين" });
  }
});

// GET /api/studio/headleader/leaders — every registered leader, so the
// publish-task page can show a pick-list instead of making the head_leader
// remember/type codes by hand.
router.get("/leaders", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, leader_code FROM studio_leaders ORDER BY leader_code`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل قائمة الليدرز" });
  }
});

// POST /api/studio/headleader/tasks — create a new DRAFT task. leaderIds is
// an array of studio_leaders.id, picked from the list on the publish page
// (no more typing codes by hand).
router.post("/tasks", async (req, res) => {
  const {
    title, quantity, difficulty,
    sampleRate, bitDepth, format, channels,
    leaderIds,
  } = req.body;

  if (!title || !quantity) return res.status(400).json({ error: "العنوان والكمية مطلوبين" });
  if (!Array.isArray(leaderIds) || !leaderIds.length) {
    return res.status(400).json({ error: "لازم تختار ليدر واحد على الأقل" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const leadersResult = await client.query(
      `SELECT id, leader_code FROM studio_leaders WHERE id = ANY($1::uuid[])`,
      [leaderIds]
    );
    if (leadersResult.rows.length !== leaderIds.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "في ليدر محدد مش موجود، حدّث الصفحة وجرّب تاني" });
    }

    const settings = {
      sampleRate: Number(sampleRate) || 16000,
      bitDepth: Number(bitDepth) || 16,
      format: format || "wav",
      channels: channels || "mono",
    };

    const taskResult = await client.query(
      `INSERT INTO recording_tasks (title, head_leader_id, quantity, difficulty, recording_settings)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title, req.studioUser.id, Number(quantity), difficulty || "medium", JSON.stringify(settings)]
    );
    const task = taskResult.rows[0];

    for (const leader of leadersResult.rows) {
      await client.query(
        `INSERT INTO recording_task_leaders (task_id, leader_id) VALUES ($1, $2)`,
        [task.id, leader.id]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(task);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "تعذر إنشاء المهمة" });
  } finally {
    client.release();
  }
});

// POST /api/studio/headleader/tasks/:id/script — upload the .txt script.
// Every non-empty line becomes one recording_samples row, in order. Calling
// this again on the same task REPLACES the sentence list entirely (safer
// than trying to merge/diff two scripts).
router.post("/tasks/:id/script", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لازم ترفع ملف txt" });

  const client = await pool.connect();
  try {
    const taskResult = await client.query(
      `SELECT * FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`,
      [req.params.id, req.studioUser.id]
    );
    if (!taskResult.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });
    const task = taskResult.rows[0];

    const lines = readLines(req.file.buffer);
    if (!lines.length) return res.status(400).json({ error: "الملف فاضي أو مفيهوش جمل" });

    const authClient = await getAuthorizedClient();
    const drive = google.drive({ version: "v3", auth: authClient });
    const studioRoot = await getOrCreateStudioRootFolder();
    const taskFolderId = await ensureTaskRootFolder(client, drive, task, studioRoot);
    const scriptFile = await uploadSubmissionFile(taskFolderId, req.file.originalname, req.file.mimetype, req.file.buffer);

    await client.query("BEGIN");
    await client.query(`DELETE FROM recording_samples WHERE task_id = $1`, [task.id]);
    // ONE statement for all sentences (a script can have 600 lines; one round-trip
    // per line to the database took long enough to hit the server time limit).
    await client.query(
      `INSERT INTO recording_samples (task_id, sentence_name, order_index)
       SELECT $1, x.name, x.ord - 1 FROM unnest($2::text[]) WITH ORDINALITY AS x(name, ord)`,
      [task.id, lines]
    );
    await client.query(
      `UPDATE recording_tasks SET script_file_url = $1, script_file_name = $2 WHERE id = $3`,
      [scriptFile.webViewLink || scriptFileSafe(scriptFile), req.file.originalname, task.id]
    );
    await client.query("COMMIT");

    const samples = await pool.query(
      `SELECT * FROM recording_samples WHERE task_id = $1 ORDER BY order_index`, [task.id]
    );
    res.json({ sampleCount: lines.length, samples: samples.rows });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    if (err.code === "DRIVE_NOT_CONNECTED") {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل بالسيرفر." });
    }
    const reason = String((err.errors && err.errors[0] && err.errors[0].reason) || err.message || "");
    if (/invalid_grant/i.test(reason)) {
      return res.status(503).json({ error: "اتصال جوجل درايف انتهى. اربطه من جديد من لوحة الموقع الرئيسي." });
    }
    if (/storageQuotaExceeded|quota/i.test(reason)) {
      return res.status(503).json({ error: "مساحة جوجل درايف امتلت. نضّف المساحة من صفحة التسليم وجرّب تاني." });
    }
    res.status(500).json({ error: "تعذر رفع ملف السكريبت" });
  } finally {
    client.release();
  }
});

// small guard: uploadSubmissionFile's return shape may not always include
// webViewLink depending on the Drive API response — fall back to the id.
function scriptFileSafe(file) { return file.id ? `https://drive.google.com/file/d/${file.id}/view` : null; }

// Lazily creates (and caches on the task row) the Drive folder for this
// task, named after its title.
async function ensureTaskRootFolder(client, drive, task, studioRootId) {
  if (task.drive_root_folder_id) return task.drive_root_folder_id;
  const folderId = await getOrCreateSubfolder(drive, studioRootId, `${task.title} — ${task.id.slice(0, 8)}`);
  await client.query(`UPDATE recording_tasks SET drive_root_folder_id = $1 WHERE id = $2`, [folderId, task.id]);
  return folderId;
}

// POST /api/studio/headleader/tasks/:id/fake-names — upload the .txt pool
// of fake names talents will pick from (one per line). Separate from the
// sentences script. Calling this again REPLACES the whole pool — any name
// already reserved by a talent (in recording_sessions) stays reserved
// regardless, since reservations are checked against sessions, not this list.
router.post("/tasks/:id/fake-names", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لازم ترفع ملف txt" });

  try {
    const taskResult = await pool.query(
      `SELECT * FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`,
      [req.params.id, req.studioUser.id]
    );
    if (!taskResult.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });

    const names = readLines(req.file.buffer);
    if (!names.length) return res.status(400).json({ error: "الملف فاضي أو مفيهوش أسامي" });

    await pool.query(`UPDATE recording_tasks SET fake_names = $1 WHERE id = $2`, [names, req.params.id]);
    res.json({ nameCount: names.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر رفع ملف الأسامي" });
  }
});

// POST /api/studio/headleader/tasks/:id/samples/:sampleId/audio — upload
// the reference/example audio for ONE sentence.
router.post("/tasks/:id/samples/:sampleId/audio", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لازم ترفع ملف صوتي" });

  try {
    const taskResult = await pool.query(
      `SELECT * FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`,
      [req.params.id, req.studioUser.id]
    );
    if (!taskResult.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });
    const task = taskResult.rows[0];

    const sampleResult = await pool.query(
      `SELECT * FROM recording_samples WHERE id = $1 AND task_id = $2`,
      [req.params.sampleId, task.id]
    );
    if (!sampleResult.rows.length) return res.status(404).json({ error: "الجملة مش موجودة" });

    const authClient = await getAuthorizedClient();
    const drive = google.drive({ version: "v3", auth: authClient });
    const studioRoot = await getOrCreateStudioRootFolder();
    const client = await pool.connect();
    let taskFolderId;
    try { taskFolderId = await ensureTaskRootFolder(client, drive, task, studioRoot); }
    finally { client.release(); }

    const referenceFolderId = await getOrCreateSubfolder(drive, taskFolderId, "Reference Audio");
    const uploaded = await uploadSubmissionFile(referenceFolderId, req.file.originalname, req.file.mimetype, req.file.buffer);
    const audioUrl = uploaded.id ? `https://drive.google.com/file/d/${uploaded.id}/view` : null;

    const duration = req.body.duration ? Number(req.body.duration) : null;
    await pool.query(
      `UPDATE recording_samples SET audio_url = $1, duration = $2 WHERE id = $3`,
      [audioUrl, duration, req.params.sampleId]
    );
    res.json({ audioUrl });
  } catch (err) {
    console.error(err);
    if (err.code === "DRIVE_NOT_CONNECTED") {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل بالسيرفر." });
    }
    res.status(500).json({ error: "تعذر رفع الملف الصوتي" });
  }
});

// POST /api/studio/headleader/tasks/:id/samples/bulk-audio — upload ONE
// reference audio file and apply it to several sentences at once (e.g.
// "Fast1, Fast2, Fast3" all sharing the same reference clip), instead of
// uploading the same file over and over per sentence.
router.post("/tasks/:id/samples/bulk-audio", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لازم ترفع ملف صوتي" });

  let sampleIds;
  try { sampleIds = JSON.parse(req.body.sampleIds || "[]"); } catch (_) { sampleIds = []; }
  if (!Array.isArray(sampleIds) || !sampleIds.length) {
    return res.status(400).json({ error: "اختار جملة واحدة على الأقل قبل رفع السامبل" });
  }

  try {
    const taskResult = await pool.query(
      `SELECT * FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`,
      [req.params.id, req.studioUser.id]
    );
    if (!taskResult.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });
    const task = taskResult.rows[0];

    const samplesCheck = await pool.query(
      `SELECT id FROM recording_samples WHERE task_id = $1 AND id = ANY($2::uuid[])`,
      [task.id, sampleIds]
    );
    if (samplesCheck.rows.length !== sampleIds.length) {
      return res.status(400).json({ error: "في جملة محددة مش موجودة، حدّث الصفحة وجرّب تاني" });
    }

    const authClient = await getAuthorizedClient();
    const drive = google.drive({ version: "v3", auth: authClient });
    const studioRoot = await getOrCreateStudioRootFolder();
    const client = await pool.connect();
    let taskFolderId;
    try { taskFolderId = await ensureTaskRootFolder(client, drive, task, studioRoot); }
    finally { client.release(); }

    const referenceFolderId = await getOrCreateSubfolder(drive, taskFolderId, "Reference Audio");
    const uploaded = await uploadSubmissionFile(referenceFolderId, req.file.originalname, req.file.mimetype, req.file.buffer);
    const audioUrl = uploaded.id ? `https://drive.google.com/file/d/${uploaded.id}/view` : null;
    const duration = req.body.duration ? Number(req.body.duration) : null;

    await pool.query(
      `UPDATE recording_samples SET audio_url = $1, duration = $2 WHERE id = ANY($3::uuid[])`,
      [audioUrl, duration, sampleIds]
    );

    const samples = await pool.query(
      `SELECT * FROM recording_samples WHERE task_id = $1 ORDER BY order_index`, [task.id]
    );
    res.json({ audioUrl, appliedTo: sampleIds.length, samples: samples.rows });
  } catch (err) {
    console.error(err);
    if (err.code === "DRIVE_NOT_CONNECTED") {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل بالسيرفر." });
    }
    res.status(500).json({ error: "تعذر رفع السامبل المشترك" });
  }
});

// POST /api/studio/headleader/tasks/:id/publish
router.post("/tasks/:id/publish", async (req, res) => {
  try {
    const taskResult = await pool.query(
      `SELECT * FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`,
      [req.params.id, req.studioUser.id]
    );
    if (!taskResult.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });
    const task = taskResult.rows[0];

    const sampleCount = await pool.query(`SELECT COUNT(*) FROM recording_samples WHERE task_id = $1`, [task.id]);
    if (Number(sampleCount.rows[0].count) === 0) {
      return res.status(400).json({ error: "لازم ترفع ملف السكريبت الأول قبل النشر" });
    }
    const leaderCount = await pool.query(`SELECT COUNT(*) FROM recording_task_leaders WHERE task_id = $1`, [task.id]);
    if (Number(leaderCount.rows[0].count) === 0) {
      return res.status(400).json({ error: "لازم تحدد كود ليدر واحد على الأقل قبل النشر" });
    }
    if (!task.fake_names || task.fake_names.length === 0) {
      return res.status(400).json({ error: "لازم ترفع ملف الأسامي المستعارة قبل النشر" });
    }

    const result = await pool.query(
      `UPDATE recording_tasks SET status = 'published', published_at = now() WHERE id = $1 RETURNING *`,
      [task.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر نشر المهمة" });
  }
});

// GET /api/studio/headleader/tasks — every task this head_leader created,
// with a quick submission-count summary per task.
router.get("/tasks", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM recording_samples WHERE task_id = t.id) AS sample_count,
        (SELECT COUNT(*) FROM recording_task_leaders WHERE task_id = t.id) AS leader_count,
        (SELECT COUNT(*) FROM recording_sessions WHERE task_id = t.id AND status <> 'expired') AS submission_count,
        (SELECT COUNT(*) FROM recording_sessions WHERE task_id = t.id AND status = 'approved' AND gender = 'male') AS approved_male_count,
        (SELECT COUNT(*) FROM recording_sessions WHERE task_id = t.id AND status = 'approved' AND gender = 'female') AS approved_female_count
      FROM recording_tasks t
      WHERE t.head_leader_id = $1
      ORDER BY t.created_at DESC
    `, [req.studioUser.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل المهام" });
  }
});

// GET /api/studio/headleader/tasks/:id — full detail: samples + assigned leaders.
router.get("/tasks/:id", async (req, res) => {
  try {
    const taskResult = await pool.query(
      `SELECT * FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`,
      [req.params.id, req.studioUser.id]
    );
    if (!taskResult.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });

    const samples = await pool.query(
      `SELECT * FROM recording_samples WHERE task_id = $1 ORDER BY order_index`, [req.params.id]
    );
    const leaders = await pool.query(`
      SELECT l.id, l.name, l.leader_code, l.email
      FROM recording_task_leaders rtl JOIN studio_leaders l ON l.id = rtl.leader_id
      WHERE rtl.task_id = $1 ORDER BY l.leader_code
    `, [req.params.id]);

    res.json({ task: taskResult.rows[0], samples: samples.rows, leaders: leaders.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل تفاصيل المهمة" });
  }
});

module.exports = router;
