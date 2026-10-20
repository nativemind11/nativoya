const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { google } = require("googleapis");
const { pool } = require("../../db/pool");
const { requireStudioAuth, requireStudioRole } = require("../../config/studioAuth");
const { getAuthorizedClient, uploadSubmissionFile } = require("../../config/googleDrive");
const { getOrCreateStudioRootFolder, getOrCreateSubfolder } = require("../../config/studioDrive");
const { readLines } = require("../../config/textFile");
const Quota = require("../../config/studioQuota");
const { createLeader } = require("../../config/studioLeaders");

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

// GET /api/studio/headleader/leaders — every leader with a quick summary (team size, tasks, state).
// The publish page uses it as a pick-list; the dashboard shows it as the "leaders" table.
router.get("/leaders", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l.id, l.name, l.email, l.leader_code, l.is_active, l.created_at,
        (SELECT COUNT(DISTINCT talent_id) FROM recording_sessions WHERE leader_id = l.id AND status <> 'expired')::int AS talents,
        (SELECT COUNT(*) FROM recording_sessions WHERE leader_id = l.id AND status <> 'expired')::int AS sessions,
        (SELECT COUNT(*) FROM recording_task_leaders WHERE leader_id = l.id)::int AS tasks
      FROM studio_leaders l ORDER BY l.leader_code`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل قائمة الليدرز" });
  }
});

// POST /api/studio/headleader/leaders — create a leader account. There is no public sign-up for leaders:
// only a head leader creates them (same as QA reviewers), so nobody can pose as a leader.
router.post("/leaders", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "الاسم والإيميل وكلمة المرور مطلوبين" });
  if (String(password).length < 6) return res.status(400).json({ error: "كلمة المرور لازم تكون 6 أحرف على الأقل" });
  try {
    const leader = await createLeader(pool, { name: String(name).trim(), email: String(email), password: String(password), createdBy: req.studioUser.id });
    res.status(201).json(leader);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "فيه حساب بالإيميل ده بالفعل" });
    console.error(err);
    res.status(500).json({ error: "تعذر إنشاء حساب الليدر" });
  }
});

// PATCH /api/studio/headleader/leaders/:id — switch a leader on/off, rename, or set a new password.
router.patch("/leaders/:id", async (req, res) => {
  const { isActive, name, password } = req.body;
  const sets = [], vals = [];
  if (isActive !== undefined) { vals.push(!!isActive); sets.push(`is_active = $${vals.length}`); }
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: "الاسم مينفعش يبقى فاضي" });
    vals.push(String(name).trim()); sets.push(`name = $${vals.length}`);
  }
  if (password !== undefined) {
    if (String(password).length < 6) return res.status(400).json({ error: "كلمة المرور لازم تكون 6 أحرف على الأقل" });
    vals.push(await bcrypt.hash(String(password), 10)); sets.push(`password_hash = $${vals.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "مفيش حاجة تتعدّل" });
  try {
    vals.push(req.params.id);
    const r = await pool.query(`UPDATE studio_leaders SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING id, name, email, leader_code, is_active`, vals);
    if (!r.rows.length) return res.status(404).json({ error: "الليدر مش موجود" });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === "22P02") return res.status(404).json({ error: "الليدر مش موجود" });
    console.error(err);
    res.status(500).json({ error: "تعذر تعديل الليدر" });
  }
});

// GET /api/studio/headleader/qa-stats — every QA reviewer with how many submissions they handled.
router.get("/qa-stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT q.id, q.name, q.email, q.created_at,
        COUNT(rs.id) FILTER (WHERE rs.status IN ('approved', 'rejected'))::int AS reviewed,
        COUNT(rs.id) FILTER (WHERE rs.status = 'approved')::int AS approved,
        COUNT(rs.id) FILTER (WHERE rs.status = 'rejected')::int AS rejected
      FROM studio_qa_reviewers q
      LEFT JOIN recording_sessions rs ON rs.qa_reviewer_id = q.id AND rs.status <> 'expired'
      GROUP BY q.id ORDER BY reviewed DESC, q.name`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل إحصائيات المراجعين" });
  }
});

// POST /api/studio/headleader/tasks — create a new DRAFT task.
// Besides title + recording settings it takes: instructions (shown to the talent before the first sentence),
// reworkHours (12 | 24), useAgeBrackets, useReferenceAudio, quotas ([{gender, ageBracket?, max}]) and leaderIds
// (optional here — leaders can also be added later, but a task needs at least one to be published).
router.post("/tasks", async (req, res) => {
  const {
    title, quantity, difficulty, sampleRate, bitDepth, format, channels,
    leaderIds, instructions, reworkHours, useAgeBrackets, useReferenceAudio, quotas,
  } = req.body;

  if (!title || !String(title).trim()) return res.status(400).json({ error: "اسم المهمة مطلوب" });
  const hours = reworkHours == null || reworkHours === "" ? 12 : Number(reworkHours);
  if (![12, 24].includes(hours)) return res.status(400).json({ error: "مهلة الإعادة لازم تكون 12 أو 24 ساعة" });
  let quotaRows;
  try { quotaRows = Quota.normalizeQuotas(quotas, !!useAgeBrackets); }
  catch (e) { return res.status(e.statusCode || 400).json({ error: e.message }); }
  const ids = Array.isArray(leaderIds) ? leaderIds : [];
  const total = quotaRows.length ? quotaRows.reduce((n, r) => n + r.max, 0) : (Number(quantity) > 0 ? Number(quantity) : null);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (ids.length) {
      const leadersResult = await client.query(`SELECT id FROM studio_leaders WHERE id = ANY($1::uuid[])`, [ids]);
      if (leadersResult.rows.length !== new Set(ids).size) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "في ليدر محدد مش موجود، حدّث الصفحة وجرّب تاني" });
      }
    }
    const settings = {
      sampleRate: Number(sampleRate) || 16000, bitDepth: Number(bitDepth) || 16,
      format: format || "wav", channels: channels || "mono",
    };
    const taskResult = await client.query(
      `INSERT INTO recording_tasks (title, head_leader_id, quantity, difficulty, recording_settings,
                                    instructions, rework_hours, use_age_brackets, use_reference_audio)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [String(title).trim(), req.studioUser.id, total, difficulty || "medium", JSON.stringify(settings),
       instructions && String(instructions).trim() ? String(instructions).trim() : null, hours,
       !!useAgeBrackets, useReferenceAudio === undefined ? true : !!useReferenceAudio]
    );
    const task = taskResult.rows[0];
    await Quota.replaceQuotas(client, task.id, quotaRows);
    for (const id of new Set(ids)) {
      await client.query(`INSERT INTO recording_task_leaders (task_id, leader_id) VALUES ($1, $2)`, [task.id, id]);
    }
    await client.query("COMMIT");
    const [withSlots] = await Quota.attachSlots(pool, [task]);
    res.status(201).json(withSlots);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error(err);
    res.status(500).json({ error: "تعذر إنشاء المهمة" });
  } finally {
    client.release();
  }
});

// PATCH /api/studio/headleader/tasks/:id — change a task at any time (even after publishing):
// title, instructions, rework hours, whether the sentences have example audio.
router.patch("/tasks/:id", async (req, res) => {
  const { title, instructions, reworkHours, useReferenceAudio } = req.body;
  const sets = [], vals = [];
  if (title !== undefined) {
    if (!String(title).trim()) return res.status(400).json({ error: "اسم المهمة مينفعش يبقى فاضي" });
    vals.push(String(title).trim()); sets.push(`title = $${vals.length}`);
  }
  if (instructions !== undefined) { vals.push(instructions && String(instructions).trim() ? String(instructions).trim() : null); sets.push(`instructions = $${vals.length}`); }
  if (reworkHours !== undefined) {
    if (![12, 24].includes(Number(reworkHours))) return res.status(400).json({ error: "مهلة الإعادة لازم تكون 12 أو 24 ساعة" });
    vals.push(Number(reworkHours)); sets.push(`rework_hours = $${vals.length}`);
  }
  if (useReferenceAudio !== undefined) { vals.push(!!useReferenceAudio); sets.push(`use_reference_audio = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: "مفيش حاجة تتعدّل" });
  try {
    vals.push(req.params.id, req.studioUser.id);
    const r = await pool.query(`UPDATE recording_tasks SET ${sets.join(", ")} WHERE id = $${vals.length - 1} AND head_leader_id = $${vals.length} RETURNING *`, vals);
    if (!r.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });
    const [withSlots] = await Quota.attachSlots(pool, [r.rows[0]]);
    res.json(withSlots);
  } catch (err) {
    if (err.code === "22P02") return res.status(404).json({ error: "المهمة مش موجودة" });
    console.error(err);
    res.status(500).json({ error: "تعذر تعديل المهمة" });
  }
});

// PUT /api/studio/headleader/tasks/:id/quotas — change how many boys / girls (and age brackets) a task wants,
// even while it is running. Body: { quotas: [{gender, ageBracket?, max}], useAgeBrackets? }.
// A slot can never be set below the number of people already in it.
router.put("/tasks/:id/quotas", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const t = await client.query(`SELECT * FROM recording_tasks WHERE id = $1 AND head_leader_id = $2 FOR UPDATE`, [req.params.id, req.studioUser.id]);
    if (!t.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "المهمة مش موجودة" }); }
    const task = t.rows[0];
    const useB = req.body.useAgeBrackets === undefined ? !!task.use_age_brackets : !!req.body.useAgeBrackets;
    const rows = Quota.normalizeQuotas(req.body.quotas, useB);
    const usage = (await Quota.loadUsage(client, [task.id])).get(task.id);
    Quota.validateEdit(useB, rows, usage);
    await Quota.replaceQuotas(client, task.id, rows);
    const updated = await client.query(
      `UPDATE recording_tasks SET use_age_brackets = $2, quantity = $3 WHERE id = $1 RETURNING *`,
      [task.id, useB, rows.length ? rows.reduce((n, r) => n + r.max, 0) : task.quantity]);
    await client.query("COMMIT");
    const [withSlots] = await Quota.attachSlots(pool, [updated.rows[0]]);
    res.json(withSlots);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    if (err.code === "22P02") return res.status(404).json({ error: "المهمة مش موجودة" });
    console.error(err);
    res.status(500).json({ error: "تعذر تعديل الحصص" });
  } finally {
    client.release();
  }
});

// POST /api/studio/headleader/tasks/:id/leaders — add one more leader to a task (before or after publishing).
router.post("/tasks/:id/leaders", async (req, res) => {
  const { leaderId } = req.body;
  if (!leaderId) return res.status(400).json({ error: "اختار الليدر" });
  try {
    const t = await pool.query(`SELECT id FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`, [req.params.id, req.studioUser.id]);
    if (!t.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });
    const l = await pool.query(`SELECT id, is_active FROM studio_leaders WHERE id = $1`, [leaderId]);
    if (!l.rows.length) return res.status(404).json({ error: "الليدر مش موجود" });
    if (!l.rows[0].is_active) return res.status(400).json({ error: "الليدر ده متوقف" });
    await pool.query(`INSERT INTO recording_task_leaders (task_id, leader_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.params.id, leaderId]);
    const leaders = await pool.query(`
      SELECT l.id, l.name, l.leader_code, l.email FROM recording_task_leaders rtl
      JOIN studio_leaders l ON l.id = rtl.leader_id WHERE rtl.task_id = $1 ORDER BY l.leader_code`, [req.params.id]);
    res.status(201).json({ leaders: leaders.rows });
  } catch (err) {
    if (err.code === "22P02") return res.status(404).json({ error: "المهمة أو الليدر مش موجود" });
    console.error(err);
    res.status(500).json({ error: "تعذر إضافة الليدر" });
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
    // route is head-leader only, so showing the technical reason is safe and lets us diagnose without server logs
    res.status(500).json({ error: `تعذر رفع ملف السكريبت — السبب: ${reason.slice(0, 160) || "غير معروف"}` });
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
        (SELECT COUNT(*) FROM recording_sessions WHERE task_id = t.id AND status = 'approved' AND gender = 'female') AS approved_female_count,
        (SELECT COALESCE(json_agg(x ORDER BY x.n DESC, x.name), '[]'::json) FROM (
           SELECT q.name, COUNT(*)::int AS n FROM recording_sessions rs
           JOIN studio_qa_reviewers q ON q.id = rs.qa_reviewer_id
           WHERE rs.task_id = t.id AND rs.status <> 'expired' GROUP BY q.id, q.name) x) AS qa_summary
      FROM recording_tasks t
      WHERE t.head_leader_id = $1
      ORDER BY t.created_at DESC
    `, [req.studioUser.id]);
    res.json(await Quota.attachSlots(pool, result.rows));
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

    const [task] = await Quota.attachSlots(pool, [taskResult.rows[0]]);
    const qa = await pool.query(`
      SELECT q.id, q.name, COUNT(*)::int AS n FROM recording_sessions rs
      JOIN studio_qa_reviewers q ON q.id = rs.qa_reviewer_id
      WHERE rs.task_id = $1 AND rs.status <> 'expired' GROUP BY q.id, q.name ORDER BY n DESC, q.name`, [req.params.id]);
    res.json({ task, samples: samples.rows, leaders: leaders.rows, qa: qa.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل تفاصيل المهمة" });
  }
});

// ---------------------------------------------------------------------
// "Finish the task for good": deletes every file of a finished task from storage.
//   GET  /tasks/:id/finalize  -> what would be deleted + what is in the way (nothing is touched)
//   POST /tasks/:id/finalize  -> does it. Stops after ~40 s with { done:false } — call again to continue.
// ---------------------------------------------------------------------
const F = require("../../config/studioFinalize");
const finalizeBlob = require("../../config/studioBlob");
const finalizeStorage = require("../../config/studioStorage");

router.get("/tasks/:id/finalize", async (req, res) => {
  try {
    const info = await F.getFinalizeInfo({ repo: F.makeRepo(pool), taskId: req.params.id, headLeaderId: req.studioUser.id });
    if (info.notFound) return res.status(404).json({ error: "المهمة مش موجودة" });
    res.json(info);
  } catch (err) {
    console.error("[finalize:info]", err);
    res.status(500).json({ error: "تعذر فحص المهمة" });
  }
});

router.post("/tasks/:id/finalize", async (req, res) => {
  try {
    const out = await F.runFinalize({
      repo: F.makeRepo(pool), taskId: req.params.id, headLeaderId: req.studioUser.id,
      deps: { blob: finalizeBlob, getDrive: finalizeStorage.driveClient, getQuota: finalizeStorage.getQuota },
    });
    const { status, ...body } = out;
    res.status(status).json(body);
  } catch (err) {
    console.error("[finalize:run]", err);
    res.status(500).json({ error: "تعذر تفضية مساحة المهمة — جرّب تاني، اللي اتمسح فعلاً مش هيتأثر." });
  }
});

module.exports = router;
