const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { google } = require("googleapis");
const { pool } = require("../../db/pool");
const { requireStudioAuth, requireStudioRole } = require("../../config/studioAuth");
const { getAuthorizedClient, uploadSubmissionFile, isConnected } = require("../../config/googleDrive");
const { getOrCreateStudioRootFolder, getOrCreateSubfolder } = require("../../config/studioDrive");
const { readLines } = require("../../config/textFile");
const Quota = require("../../config/studioQuota");
const Scripts = require("../../config/studioScripts");
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
      FROM studio_leaders l WHERE NOT l.is_system ORDER BY l.leader_code`);
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
    scriptMode, identityMode, direct,
  } = req.body;
  const sMode = scriptMode == null || scriptMode === "" ? "shared" : String(scriptMode);
  const iMode = identityMode == null || identityMode === "" ? "names" : String(identityMode);
  if (!["shared", "per_person"].includes(sMode)) return res.status(400).json({ error: "نمط السكريبت غير صحيح" });
  if (!["names", "codes"].includes(iMode)) return res.status(400).json({ error: "نمط الهوية غير صحيح" });

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
                                    instructions, rework_hours, use_age_brackets, use_reference_audio,
                                    script_mode, identity_mode, direct, identity_codes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [String(title).trim(), req.studioUser.id, total, difficulty || "medium", JSON.stringify(settings),
       instructions && String(instructions).trim() ? String(instructions).trim() : null, hours,
       !!useAgeBrackets, useReferenceAudio === undefined ? true : !!useReferenceAudio,
       sMode, iMode, !!direct, iMode === "codes" ? JSON.stringify({ male: [], female: [] }) : null]
    );
    const task = taskResult.rows[0];
    await Quota.replaceQuotas(client, task.id, quotaRows);
    for (const id of (direct ? [] : new Set(ids))) {
      await client.query(`INSERT INTO recording_task_leaders (task_id, leader_id) VALUES ($1, $2)`, [task.id, id]);
    }
    await client.query("COMMIT");
    const [withSlots] = await Scripts.attachSlots(pool, [task]);
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
  const { title, instructions, reworkHours, useReferenceAudio, difficulty,
          sampleRate, bitDepth, format, channels, scriptMode, identityMode, direct } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(`SELECT * FROM recording_tasks WHERE id = $1 AND head_leader_id = $2 FOR UPDATE`, [req.params.id, req.studioUser.id]);
    if (!cur.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "المهمة مش موجودة" }); }
    const task = cur.rows[0];
    const sets = [], vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    const fail = async (code, msg) => { await client.query("ROLLBACK"); return res.status(code).json({ error: msg }); };

    if (title !== undefined) {
      if (!String(title).trim()) return fail(400, "اسم المهمة مينفعش يبقى فاضي");
      add("title", String(title).trim());
    }
    if (instructions !== undefined) add("instructions", instructions && String(instructions).trim() ? String(instructions).trim() : null);
    if (reworkHours !== undefined) {
      if (![12, 24].includes(Number(reworkHours))) return fail(400, "مهلة الإعادة لازم تكون 12 أو 24 ساعة");
      add("rework_hours", Number(reworkHours));
    }
    if (useReferenceAudio !== undefined) add("use_reference_audio", !!useReferenceAudio);
    if (difficulty !== undefined) {
      if (!["easy", "medium", "hard"].includes(String(difficulty))) return fail(400, "مستوى الصعوبة غير صحيح");
      add("difficulty", String(difficulty));
    }

    // recording settings (sample rate / bit depth / format / channels) — merged into the existing JSON
    if ([sampleRate, bitDepth, format, channels].some((v) => v !== undefined)) {
      const cs = Object.assign({ sampleRate: 16000, bitDepth: 16, format: "wav", channels: "mono" }, task.recording_settings || {});
      if (sampleRate !== undefined) { if (![16000, 22050, 44100, 48000].includes(Number(sampleRate))) return fail(400, "معدل العينة غير صحيح"); cs.sampleRate = Number(sampleRate); }
      if (bitDepth !== undefined) { if (![16, 24].includes(Number(bitDepth))) return fail(400, "عمق البت غير صحيح"); cs.bitDepth = Number(bitDepth); }
      if (format !== undefined) { if (!["wav", "mp3"].includes(String(format))) return fail(400, "الصيغة غير صحيحة"); cs.format = String(format); }
      if (channels !== undefined) { if (!["mono", "stereo"].includes(String(channels))) return fail(400, "القناة غير صحيحة"); cs.channels = String(channels); }
      add("recording_settings", JSON.stringify(cs));
    }

    // system modes (script per person / codes / direct). Changing them rewires who gets what, so it is only allowed
    // while NOBODY has started recording; the sentences / scripts uploaded for the old mode are dropped.
    const wantS = scriptMode === undefined ? task.script_mode : String(scriptMode);
    const wantI = identityMode === undefined ? task.identity_mode : String(identityMode);
    const wantD = direct === undefined ? !!task.direct : !!direct;
    if (!["shared", "per_person"].includes(wantS)) return fail(400, "نمط السكريبت غير صحيح");
    if (!["names", "codes"].includes(wantI)) return fail(400, "نمط الهوية غير صحيح");
    const modesChanged = wantS !== task.script_mode || wantI !== task.identity_mode || wantD !== !!task.direct;
    if (modesChanged) {
      const started = await client.query(`SELECT 1 FROM recording_sessions WHERE task_id = $1 LIMIT 1`, [task.id]);
      if (started.rows.length) return fail(409, "فيه ناس بدأت تسجّل على المهمة — مينفعش تغيّر نظامها دلوقتي.");
      if (wantS !== task.script_mode) {
        await client.query(`DELETE FROM recording_samples WHERE task_id = $1`, [task.id]);
        await client.query(`DELETE FROM studio_task_scripts WHERE task_id = $1`, [task.id]);
        add("script_file_url", null); add("script_file_name", null);
        add("script_mode", wantS);
      }
      if (wantI !== task.identity_mode) {
        add("identity_mode", wantI);
        if (wantI === "codes" && !task.identity_codes) add("identity_codes", JSON.stringify({ male: [], female: [] }));
      }
      if (wantD !== !!task.direct) add("direct", wantD);
      if (task.status === "published") add("status", "draft");   // it lost its sentences / identities: upload them, then publish again
    }

    if (!sets.length) return fail(400, "مفيش حاجة تتعدّل");
    vals.push(task.id);
    const r = await client.query(`UPDATE recording_tasks SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
    await client.query("COMMIT");
    const [withSlots] = await Scripts.attachSlots(pool, [r.rows[0]]);
    res.json(withSlots);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "22P02") return res.status(404).json({ error: "المهمة مش موجودة" });
    console.error(err);
    res.status(500).json({ error: "تعذر تعديل المهمة" });
  } finally {
    client.release();
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
    const [withSlots] = await Scripts.attachSlots(pool, [updated.rows[0]]);
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
    const t = await pool.query(`SELECT id, direct FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`, [req.params.id, req.studioUser.id]);
    if (!t.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });
    if (t.rows[0].direct) return res.status(400).json({ error: "المهمة دي نشر مباشر — مفيهاش ليدرز." });
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
    if (Scripts.isPerPerson(task)) return res.status(400).json({ error: "المهمة دي سكريبتاتها منفصلة لكل شخص — ارفعهم كملفات من خطوة السكريبتات." });

    const lines = readLines(req.file.buffer);
    if (!lines.length) return res.status(400).json({ error: "الملف فاضي أو مفيهوش جمل" });

    const started = await client.query(`SELECT 1 FROM recording_sessions WHERE task_id = $1 AND status <> 'expired' LIMIT 1`, [task.id]);
    if (started.rows.length) return res.status(409).json({ error: "فيه ناس بدأت تسجّل على المهمة — مينفعش تستبدل ملف الجمل دلوقتي (التسجيلات هتضيع)." });

    const scriptFile = await uploadWithFolderRetry(client, task, req.file);

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
    if (err.code === "DRIVE_SCOPE") {
      return res.status(503).json({ error: "حساب جوجل درايف المتصل مش واخد صلاحية الرفع. افصله واربطه من جديد، وفي شاشة جوجل علّم على كل الصلاحيات (خصوصًا صلاحية الملفات) قبل ما تكمّل." });
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


// ---------------------------------------------------------------------
// Drive upload that survives a stale folder id.
// A cached folder id (the Studio root, or a task's folder) can stop being usable: it was made by another Google
// account / OAuth app, or it was deleted. Google then answers "insufficientPermissions" / "notFound" even though
// the connected account is fine. We tell the two cases apart:
//   - the token itself lacks the Drive permission  -> DRIVE_SCOPE (the head leader must reconnect Drive)
//   - the token is fine                            -> forget the cached folders, make fresh ones, retry ONCE
// ---------------------------------------------------------------------
const STALE_FOLDER = /insufficientPermissions|insufficientFilePermissions|notFound|forbidden|File not found|insufficient/i;
const errReason = (e) => String((e && e.errors && e.errors[0] && e.errors[0].reason) || (e && e.message) || "");

async function uploadOnce(client, task, file) {
  const authClient = await getAuthorizedClient();
  const drive = google.drive({ version: "v3", auth: authClient });
  const studioRoot = await getOrCreateStudioRootFolder();
  const folderId = await ensureTaskRootFolder(client, drive, task, studioRoot);
  return uploadSubmissionFile(folderId, file.originalname, file.mimetype, file.buffer);
}

async function uploadWithFolderRetry(client, task, file) {
  try { return await uploadOnce(client, task, file); }
  catch (err) {
    if (err && err.code === "DRIVE_NOT_CONNECTED") throw err;
    if (!STALE_FOLDER.test(errReason(err))) throw err;
    const ok = await isConnected().catch(() => null);          // checks the live token AND its scopes
    if (!ok) throw Object.assign(new Error("drive scope missing"), { code: "DRIVE_SCOPE" });
    console.warn("[studio:script] cached Drive folder unusable, recreating:", errReason(err));
    await pool.query(`UPDATE google_auth SET studio_root_folder_id = NULL`);
    await client.query(`UPDATE recording_tasks SET drive_root_folder_id = NULL WHERE id = $1`, [task.id]);
    task.drive_root_folder_id = null;
    return uploadOnce(client, task, file);
  }
}

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

    if (Scripts.isCodes(taskResult.rows[0])) return res.status(400).json({ error: "المهمة دي بتستخدم أكواد — ارفع قايمة الأكواد بدل الأسامي." });
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


// POST /api/studio/headleader/tasks/:id/scripts — per-person tasks: upload many .txt files, EACH FILE = ONE script
// (its lines are that script's sentences). Field name "files". mode: "append" (default, adds after the existing
// scripts) or "replace" (only while nobody has started: it throws the old scripts away).
router.post("/tasks/:id/scripts", upload.array("files", 100), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "لازم ترفع ملف txt واحد على الأقل" });
  const mode = req.body.mode === "replace" ? "replace" : "append";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const t = await client.query(`SELECT * FROM recording_tasks WHERE id = $1 AND head_leader_id = $2 FOR UPDATE`, [req.params.id, req.studioUser.id]);
    if (!t.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "المهمة مش موجودة" }); }
    const task = t.rows[0];
    if (!Scripts.isPerPerson(task)) { await client.query("ROLLBACK"); return res.status(400).json({ error: "المهمة دي مش مضبوطة على سكريبت منفصل لكل شخص." }); }

    const parsed = [], empty = [];
    for (const f of [...files].sort((a, b) => Scripts.byName(a.originalname, b.originalname))) {
      const lines = readLines(f.buffer);
      if (!lines.length) empty.push(f.originalname); else parsed.push({ name: f.originalname, lines });
    }
    if (empty.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: `الملفات دي فاضية: ${empty.slice(0, 5).join(", ")}${empty.length > 5 ? "…" : ""}` }); }

    if (mode === "replace") {
      const started = await client.query(`SELECT 1 FROM recording_sessions WHERE task_id = $1 AND script_id IS NOT NULL LIMIT 1`, [task.id]);
      if (started.rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ error: "مينفعش تستبدل السكريبتات بعد ما فيه ناس بدأت. ضيف سكريبتات جديدة بس." }); }
      await client.query(`DELETE FROM studio_task_scripts WHERE task_id = $1`, [task.id]);   // its sentences go with it (cascade)
    }
    let pos = (await client.query(`SELECT COALESCE(MAX(position) + 1, 0)::int AS n FROM studio_task_scripts WHERE task_id = $1`, [task.id])).rows[0].n;
    for (const p of parsed) {
      const sc = await client.query(`INSERT INTO studio_task_scripts (task_id, position, filename) VALUES ($1, $2, $3) RETURNING id`, [task.id, pos++, p.name]);
      await client.query(
        `INSERT INTO recording_samples (task_id, script_id, sentence_name, order_index)
         SELECT $1, $2, x.name, x.ord - 1 FROM unnest($3::text[]) WITH ORDINALITY AS x(name, ord)`, [task.id, sc.rows[0].id, p.lines]);
    }
    await client.query("COMMIT");
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM studio_task_scripts WHERE task_id = $1`, [task.id])).rows[0].n;
    res.json({ added: parsed.length, scriptCount: total });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    if (err.code === "22P02") return res.status(404).json({ error: "المهمة مش موجودة" });
    console.error(err);
    res.status(500).json({ error: "تعذر رفع السكريبتات" });
  } finally {
    client.release();
  }
});

// POST /api/studio/headleader/tasks/:id/codes — tasks that use CODES instead of fake names: the head leader uploads
// two lists, "male" and "female" (one code per line). A talent only sees the codes of the gender they pick.
// mode: "replace" (default) swaps a list, "append" adds new codes to it. A code a talent already holds stays theirs.
router.post("/tasks/:id/codes", upload.fields([{ name: "male", maxCount: 1 }, { name: "female", maxCount: 1 }]), async (req, res) => {
  const files = req.files || {};
  if (!files.male && !files.female) return res.status(400).json({ error: "ارفع قايمة أكواد واحدة على الأقل (ولاد أو بنات)" });
  const mode = req.body.mode === "append" ? "append" : "replace";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const t = await client.query(`SELECT * FROM recording_tasks WHERE id = $1 AND head_leader_id = $2 FOR UPDATE`, [req.params.id, req.studioUser.id]);
    if (!t.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "المهمة مش موجودة" }); }
    const task = t.rows[0];
    if (!Scripts.isCodes(task)) { await client.query("ROLLBACK"); return res.status(400).json({ error: "المهمة دي بتستخدم أسامي مستعارة مش أكواد." }); }

    const next = { male: Scripts.codeList(task, "male"), female: Scripts.codeList(task, "female") };
    const label = { male: "الأولاد", female: "البنات" };
    let skipped = 0;
    for (const g of ["male", "female"]) {
      const f = files[g] && files[g][0]; if (!f) continue;
      const lines = readLines(f.buffer);
      if (!lines.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: `قايمة أكواد ${label[g]} فاضية` }); }
      const seen = new Set();
      for (const c of lines) {
        if (seen.has(c)) { await client.query("ROLLBACK"); return res.status(400).json({ error: `الكود "${c}" اتكرر في قايمة ${label[g]}` }); }
        seen.add(c);
      }
      if (mode === "append") {
        const have = new Set(next[g]);
        const fresh = lines.filter((c) => !have.has(c));
        skipped += lines.length - fresh.length;
        next[g] = [...next[g], ...fresh];
      } else next[g] = lines;
    }
    const maleSet = new Set(next.male);
    const both = next.female.find((c) => maleSet.has(c));
    if (both) { await client.query("ROLLBACK"); return res.status(400).json({ error: `الكود "${both}" موجود في قايمة الأولاد والبنات — لازم كل كود يبقى في قايمة واحدة بس` }); }

    await client.query(`UPDATE recording_tasks SET identity_codes = $2 WHERE id = $1`, [task.id, JSON.stringify(next)]);
    await client.query("COMMIT");
    res.json({ male: next.male.length, female: next.female.length, skipped });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    if (err.code === "22P02") return res.status(404).json({ error: "المهمة مش موجودة" });
    console.error(err);
    res.status(500).json({ error: "تعذر رفع الأكواد" });
  } finally {
    client.release();
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
      return res.status(400).json({ error: Scripts.isPerPerson(task) ? "لازم ترفع ملفات السكريبتات الأول قبل النشر" : "لازم ترفع ملف السكريبت الأول قبل النشر" });
    }
    if (!task.direct) {
      const leaderCount = await pool.query(`SELECT COUNT(*) FROM recording_task_leaders WHERE task_id = $1`, [task.id]);
      if (Number(leaderCount.rows[0].count) === 0) {
        return res.status(400).json({ error: "لازم تحدد كود ليدر واحد على الأقل قبل النشر" });
      }
    }
    if (Scripts.isCodes(task)) {
      if (!Scripts.codeList(task, "male").length && !Scripts.codeList(task, "female").length) {
        return res.status(400).json({ error: "لازم ترفع قايمة الأكواد قبل النشر" });
      }
    } else if (!task.fake_names || task.fake_names.length === 0) {
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
        (SELECT COUNT(*) FROM recording_samples WHERE task_id = t.id AND script_id IS NOT DISTINCT FROM
           (CASE WHEN t.script_mode = 'per_person' THEN (SELECT id FROM studio_task_scripts WHERE task_id = t.id ORDER BY position LIMIT 1) END)) AS sample_count,
        (SELECT COUNT(*) FROM studio_task_scripts WHERE task_id = t.id) AS script_count,
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
    res.json(await Scripts.attachSlots(pool, result.rows));
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
      `SELECT * FROM recording_samples WHERE task_id = $1 AND script_id IS NULL ORDER BY order_index`, [req.params.id]
    );
    const leaders = await pool.query(`
      SELECT l.id, l.name, l.leader_code, l.email
      FROM recording_task_leaders rtl JOIN studio_leaders l ON l.id = rtl.leader_id
      WHERE rtl.task_id = $1 ORDER BY l.leader_code
    `, [req.params.id]);
    const scripts = await pool.query(`
      SELECT s.id, s.position, s.filename, COUNT(sm.id)::int AS sentence_count,
             EXISTS (SELECT 1 FROM recording_sessions rs WHERE rs.script_id = s.id AND rs.status <> 'expired') AS taken
      FROM studio_task_scripts s LEFT JOIN recording_samples sm ON sm.script_id = s.id
      WHERE s.task_id = $1 GROUP BY s.id ORDER BY s.position`, [req.params.id]);

    const [task] = await Scripts.attachSlots(pool, [taskResult.rows[0]]);
    const qa = await pool.query(`
      SELECT q.id, q.name, COUNT(*)::int AS n FROM recording_sessions rs
      JOIN studio_qa_reviewers q ON q.id = rs.qa_reviewer_id
      WHERE rs.task_id = $1 AND rs.status <> 'expired' GROUP BY q.id, q.name ORDER BY n DESC, q.name`, [req.params.id]);
    res.json({ task, samples: samples.rows, leaders: leaders.rows, qa: qa.rows, scripts: scripts.rows });
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

// ---------------------------------------------------------------------
// More task editing
// ---------------------------------------------------------------------

// DELETE /tasks/:id/leaders/:leaderId — take a leader off a task (people already recorded under them stay).
router.delete("/tasks/:id/leaders/:leaderId", async (req, res) => {
  try {
    const t = await pool.query(`SELECT id, status, direct FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`, [req.params.id, req.studioUser.id]);
    if (!t.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });
    if (t.rows[0].status === "published" && !t.rows[0].direct) {
      const n = await pool.query(`SELECT COUNT(*)::int AS n FROM recording_task_leaders WHERE task_id = $1`, [t.rows[0].id]);
      if (n.rows[0].n <= 1) return res.status(400).json({ error: "المهمة منشورة ومحتاجة ليدر واحد على الأقل — ضيف ليدر تاني الأول." });
    }
    await pool.query(`DELETE FROM recording_task_leaders WHERE task_id = $1 AND leader_id = $2`, [req.params.id, req.params.leaderId]);
    const leaders = await pool.query(`
      SELECT l.id, l.name, l.leader_code, l.email FROM recording_task_leaders rtl
      JOIN studio_leaders l ON l.id = rtl.leader_id WHERE rtl.task_id = $1 ORDER BY l.leader_code`, [req.params.id]);
    res.json({ leaders: leaders.rows });
  } catch (err) {
    if (err.code === "22P02") return res.status(404).json({ error: "المهمة أو الليدر مش موجود" });
    console.error(err);
    res.status(500).json({ error: "تعذر شيل الليدر" });
  }
});

// PATCH /tasks/:id/samples/:sampleId — fix the text of ONE sentence (only while nobody recorded it yet).
router.patch("/tasks/:id/samples/:sampleId", async (req, res) => {
  const text = req.body && req.body.sentenceName != null ? String(req.body.sentenceName).trim() : "";
  if (!text) return res.status(400).json({ error: "اكتب نص الجملة" });
  try {
    const own = await pool.query(`SELECT 1 FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`, [req.params.id, req.studioUser.id]);
    if (!own.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });
    const rec = await pool.query(`SELECT 1 FROM recording_session_samples WHERE sample_id = $1 AND audio_file_url IS NOT NULL LIMIT 1`, [req.params.sampleId]);
    if (rec.rows.length) return res.status(409).json({ error: "فيه ناس سجّلت الجملة دي بالنص القديم — مينفعش تتغيّر." });
    const r = await pool.query(`UPDATE recording_samples SET sentence_name = $1 WHERE id = $2 AND task_id = $3 RETURNING *`, [text, req.params.sampleId, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "الجملة مش موجودة" });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === "22P02") return res.status(404).json({ error: "الجملة مش موجودة" });
    console.error(err);
    res.status(500).json({ error: "تعذر تعديل الجملة" });
  }
});

// DELETE /tasks/:id/scripts/:scriptId — remove one per-person script that nobody took.
router.delete("/tasks/:id/scripts/:scriptId", async (req, res) => {
  try {
    const own = await pool.query(`SELECT 1 FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`, [req.params.id, req.studioUser.id]);
    if (!own.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });
    const used = await pool.query(`SELECT 1 FROM recording_sessions WHERE script_id = $1 LIMIT 1`, [req.params.scriptId]);
    if (used.rows.length) return res.status(409).json({ error: "السكريبت ده اتحجز قبل كده — مينفعش يتمسح." });
    const r = await pool.query(`DELETE FROM studio_task_scripts WHERE id = $1 AND task_id = $2`, [req.params.scriptId, req.params.id]);   // its sentences go with it
    if (!r.rowCount) return res.status(404).json({ error: "السكريبت مش موجود" });
    res.json({ deleted: true });
  } catch (err) {
    if (err.code === "22P02") return res.status(404).json({ error: "السكريبت مش موجود" });
    console.error(err);
    res.status(500).json({ error: "تعذر مسح السكريبت" });
  }
});

// ---------------------------------------------------------------------
// DELETE /tasks/:id — delete a task FOR GOOD: its files (Drive + bucket) and every database row about it
// (sentences, scripts, talents' sessions and recordings, QA reviews, feedback, delivery history).
// Body: { confirm: "<the task title>" } — the head leader has to type the title. Cannot be undone.
// A storage problem (Drive not connected, ...) does not stop the delete: it is reported as storageWarning.
// ---------------------------------------------------------------------
router.delete("/tasks/:id", async (req, res) => {
  if (!F.UUID.test(String(req.params.id || ""))) return res.status(404).json({ error: "المهمة مش موجودة" });
  try {
    const t = await pool.query(`SELECT id, title, drive_root_folder_id FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`, [req.params.id, req.studioUser.id]);
    if (!t.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });
    const task = t.rows[0];
    if (String((req.body && req.body.confirm) || "").trim() !== String(task.title).trim()) {
      return res.status(400).json({ error: "اكتب اسم المهمة بالظبط عشان تأكّد المسح." });
    }

    // 1) files first (best effort)
    const warnings = [];
    try {
      if (finalizeBlob.enabled()) {
        const r = await finalizeBlob.removePrefix(`studio/${task.id}/`, { budgetMs: 25000 });
        if (!r.complete) warnings.push("ملفات R2 مخلصتش كلها");
      }
    } catch (e) { console.error("[task:delete:r2]", e); warnings.push("تعذر مسح ملفات R2"); }
    try {
      const has = task.drive_root_folder_id || (await pool.query(`SELECT 1 FROM google_auth LIMIT 1`)).rows.length;
      if (has) {
        const drive = await finalizeStorage.driveClient();
        const ids = new Set();
        if (task.drive_root_folder_id) ids.add(task.drive_root_folder_id);
        const root = (await pool.query(`SELECT studio_root_folder_id FROM google_auth LIMIT 1`)).rows[0];
        if (root && root.studio_root_folder_id) {
          const name = `${task.title} — ${task.id.slice(0, 8)}`.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
          const found = await drive.files.list({ q: `'${root.studio_root_folder_id}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, fields: "files(id)" });
          for (const f of (found.data && found.data.files) || []) ids.add(f.id);
        }
        for (const id of ids) {
          try { await drive.files.delete({ fileId: id }); }
          catch (e) { if (!(e && (e.code === 404 || e.status === 404))) throw e; }
        }
      }
    } catch (e) { console.error("[task:delete:drive]", e); warnings.push("تعذر مسح ملفات جوجل درايف (ممكن تتمسح يدويًا)"); }

    // 2) database, one transaction, children before parents
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const id = task.id;
      await client.query(`DELETE FROM studio_feedback_items WHERE task_id = $1`, [id]);
      await client.query(`DELETE FROM studio_delivery_batch_sessions WHERE session_id IN (SELECT id FROM recording_sessions WHERE task_id = $1)
                          OR batch_id IN (SELECT id FROM studio_delivery_batches WHERE task_id = $1)`, [id]);
      await client.query(`DELETE FROM recording_sessions WHERE task_id = $1`, [id]);          // + their recordings and QA reviews (cascade)
      await client.query(`DELETE FROM studio_delivery_batches WHERE task_id = $1`, [id]);
      await client.query(`DELETE FROM recording_samples WHERE task_id = $1`, [id]);
      await client.query(`DELETE FROM studio_task_scripts WHERE task_id = $1`, [id]);
      await client.query(`DELETE FROM recording_tasks WHERE id = $1`, [id]);                  // quotas, leaders, drive folders (cascade)
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    res.json({ deleted: true, storageWarning: warnings.length ? warnings.join(" — ") : null });
  } catch (err) {
    console.error("[task:delete]", err);
    res.status(500).json({ error: "تعذر مسح المهمة — لسه موجودة زي ما هي. جرّب تاني." });
  }
});

module.exports = router;
