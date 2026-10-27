const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const archiver = require("archiver");
const { validateClip } = require("../../config/audioValidate");
const { markAcknowledged, markReworked } = require("../../config/studioFeedback");
const { safeExpire, activityColumnReady, withdrawnMessage, idleHoursFor } = require("../../config/studioExpiry");
const Gate = require("../../config/studioTalentGate");
const { google } = require("googleapis");
const { pool } = require("../../db/pool");
const { requireStudioAuth, optionalStudioAuth, requireStudioRole } = require("../../config/studioAuth");
const { getAuthorizedClient, uploadSubmissionFile } = require("../../config/googleDrive");
const { deleteQuietly } = require("../../config/studioStorage");
const blob = require("../../config/studioBlob");
const refCache = require("../../config/refAudioCache");
const Quota = require("../../config/studioQuota");
const Scripts = require("../../config/studioScripts");
const Rework = require("../../config/studioRework");
const { sendAudio, audioContentType } = require("../../config/studioHttp");
const { getOrCreateStudioRootFolder, getOrCreateSubfolder } = require("../../config/studioDrive");

const router = express.Router();
const DOWNLOAD_CONCURRENCY = 8;

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const parts = [];
    stream.on("data", (c) => parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(parts)));
    stream.on("error", reject);
  });
}

// Retries a Drive call a couple of times (rate-limit / network blips) before giving up.
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const status = err.code || err.status || (err.response && err.response.status);
      if (status === 404 || attempt === tries) break;   // a missing file will not come back
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  throw lastErr;
}

// How many sentences one talent records in this task: the shared script, or (per-person tasks) the first script's.
const FIRST_SCRIPT = `(CASE WHEN t.script_mode = 'per_person' THEN (SELECT id FROM studio_task_scripts WHERE task_id = t.id ORDER BY position LIMIT 1) END)`;
// The public task endpoints must never show the code lists.
const publicTask = ({ identity_codes, ...rest }) => rest;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Browsing tasks/fake-names is PUBLIC (no need to log in just to look).
// Starting a session and everything after it requires a talent account —
// see requireStudioAuth below, applied per-route from here down.

// GET /api/studio/talent/tasks — published tasks open for recording.
router.get("/tasks", optionalStudioAuth, async (req, res) => {
  try {
    await safeExpire(pool);
    const result = await pool.query(`
      SELECT t.id, t.title, t.difficulty, t.quantity, t.recording_settings, t.use_age_brackets, t.use_reference_audio,
        t.direct, t.script_mode, t.identity_mode, t.identity_codes,
        (SELECT COUNT(*) FROM recording_samples WHERE task_id = t.id AND script_id IS NOT DISTINCT FROM ${FIRST_SCRIPT}) AS sample_count,
        (SELECT COUNT(*) FROM recording_sessions WHERE task_id = t.id AND status <> 'expired') AS submission_count
      FROM recording_tasks t
      WHERE t.status = 'published'
      ORDER BY t.published_at DESC
    `);
    // each task also carries { limited, slots:[{gender, ageBracket, max, used, remaining, full}] } = how many places are left
    let list = result.rows;
    // v6: a logged-in talent only sees tasks he can still start (not the ones he already did, and not the ones closed on him)
    if (req.studioUser && req.studioRole === "talent") {
      const blocked = await Gate.blockedTasks(pool, req.studioUser.id);
      list = list.filter((t) => !blocked.has(t.id));
    }
    res.json((await Scripts.attachSlots(pool, list)).map(publicTask));
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

    const sampleCount = await pool.query(
      `SELECT COUNT(*) FROM recording_samples sm JOIN recording_tasks t ON t.id = sm.task_id
       WHERE sm.task_id = $1 AND sm.script_id IS NOT DISTINCT FROM ${FIRST_SCRIPT}`, [req.params.id]);

    const [task] = await Scripts.attachSlots(pool, [taskResult.rows[0]]);

    // v4: the places left under EACH leader code ({} when the task has no per-leader quota)
    let leaderSlots = {};
    try {
      const lq = await Quota.loadLeaderQuotaRows(pool, req.params.id);
      if (lq.length) leaderSlots = Quota.computeLeaderSlots(!!task.use_age_brackets, lq, await Quota.loadLeaderUsage(pool, req.params.id));
    } catch (e) { console.error("[leader slots]", e.message); }

    res.json({ task: publicTask(task), leaders: leaders.rows, sampleCount: Number(sampleCount.rows[0].count), leaderSlots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل تفاصيل المهمة" });
  }
});

// GET /api/studio/talent/samples/:sampleId/reference-audio — streams the
// head_leader's reference clip straight through our server. A raw Google
// Drive link doesn't reliably work as an <audio> src (confirmation pages,
// missing CORS headers...), so we fetch it server-side and pipe the bytes
// through instead — works every time, regardless of Drive's quirks.
router.get("/samples/:sampleId/reference-audio", async (req, res) => {
  try {
    const sampleResult = await pool.query(`SELECT audio_url FROM recording_samples WHERE id = $1`, [req.params.sampleId]);
    if (!sampleResult.rows.length || !sampleResult.rows[0].audio_url) {
      return res.status(404).json({ error: "مفيش سامبل مرجعي للجملة دي" });
    }
    const match = sampleResult.rows[0].audio_url.match(/\/file\/d\/([^/]+)/);
    if (!match) return res.status(404).json({ error: "رابط السامبل غير صالح" });
    const fileId = match[1];

    // Cached per server instance + concurrent requests share one Drive call (see config/refAudioCache.js).
    const clip = await refCache.getOrLoad(fileId, async () => {
      const authClient = await getAuthorizedClient();
      const drive = google.drive({ version: "v3", auth: authClient });
      const meta = await drive.files.get({ fileId, fields: "mimeType, name" });
      const file = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
      return { buf: Buffer.from(file.data), type: audioContentType(meta.data.mimeType, meta.data.name) };
    });
    // Phones only play an <audio> source that answers byte-range requests, so the (small) clip is read whole
    // and served with Content-Length / Accept-Ranges / 206 — not piped as a chunked stream.
    sendAudio(req, res, clip.buf, clip.type);
  } catch (err) {
    console.error(err);
    if (err.code === "DRIVE_NOT_CONNECTED") {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل بالسيرفر." });
    }
    res.status(500).json({ error: "تعذر تشغيل السامبل" });
  }
});

// GET /api/studio/talent/tasks/:id/fake-names — names from the pool that
// NOBODY has reserved yet for this task. Tasks that use CODES list only the codes of ?gender=male|female.
router.get("/tasks/:id/fake-names", async (req, res) => {
  try {
    await safeExpire(pool);
    const taskResult = await pool.query(`SELECT id, fake_names, identity_mode, identity_codes FROM recording_tasks WHERE id = $1`, [req.params.id]);
    if (!taskResult.rows.length) return res.status(404).json({ error: "المهمة مش موجودة" });
    res.json(await Scripts.availableNames(pool, taskResult.rows[0], req.query.gender));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل قائمة الأسامي" });
  }
});

// POST /api/studio/talent/sessions — reserve a fake name + start a session.
// Requires a logged-in talent account (name / email come from that account, not the request body).
// The task row is locked while the place is taken, so two people can never both get the last slot.
// If the task uses age brackets the talent chooses one; otherwise everybody is "adult".
router.post("/sessions", requireStudioAuth, requireStudioRole("talent"), async (req, res) => {
  const { taskId, gender, ageBracket, age, fakeName } = req.body;
  let leaderId = req.body.leaderId;
  if (!taskId || !gender || !fakeName) {
    return res.status(400).json({ error: "البيانات ناقصة، املا كل الحقول المطلوبة" });
  }
  if (!["male", "female"].includes(gender)) return res.status(400).json({ error: "النوع غير صحيح" });

  // Must run BEFORE we hold a connection: it needs one of its own, and holding one while asking the pool for another
  // can leave every connection waiting for a second one (the pool is small) when many talents join at once.
  await safeExpire(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const taskResult = await client.query(`SELECT * FROM recording_tasks WHERE id = $1 AND status = 'published' FOR UPDATE`, [taskId]);
    if (!taskResult.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "المهمة مش متاحة" }); }
    const task = taskResult.rows[0];

    // v6: one go per talent per task (the task row is locked, so a double tap cannot slip through)
    const gate = await Gate.checkStart(client, req.studioUser.id, taskId);
    if (gate) {
      await client.query("ROLLBACK");
      return res.status(gate.status).json({ error: gate.message, code: gate.code, ...(gate.sessionToken ? { sessionToken: gate.sessionToken } : {}) });
    }

    const bracket = task.use_age_brackets ? ageBracket : "adult";
    if (!["child", "adult", "elderly"].includes(bracket)) { await client.query("ROLLBACK"); return res.status(400).json({ error: "الفئة العمرية غير صحيحة" }); }
    if (!Scripts.nameIsAllowed(task, gender, fakeName)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: Scripts.isCodes(task) ? "الكود ده مش من ضمن القائمة المتاحة" : "الاسم ده مش من ضمن القائمة المتاحة" });
    }

    if (task.direct) {
      // direct task: no leader to pick — the session hangs on the hidden system leader
      const sys = await client.query(`SELECT id FROM studio_leaders WHERE is_system LIMIT 1`);
      if (!sys.rows.length) { await client.query("ROLLBACK"); return res.status(500).json({ error: "السيرفر مش جاهز للنشر المباشر (migration v3 ما اتشغّلش)." }); }
      leaderId = sys.rows[0].id;
    } else {
      if (!leaderId) { await client.query("ROLLBACK"); return res.status(400).json({ error: "البيانات ناقصة، املا كل الحقول المطلوبة" }); }
      const leaderResult = await client.query(
        `SELECT 1 FROM recording_task_leaders rtl JOIN studio_leaders l ON l.id = rtl.leader_id
         WHERE rtl.task_id = $1 AND rtl.leader_id = $2 AND l.is_active`, [taskId, leaderId]);
      if (!leaderResult.rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "الكود ده مش مسموح له بالمهمة دي" }); }
    }

    const quotaRows = (await Quota.loadQuotaRows(client, [taskId])).get(taskId);
    const usageRows = (await Quota.loadUsage(client, [taskId])).get(taskId);
    const check = Quota.checkJoin(!!task.use_age_brackets, quotaRows, usageRows, gender, bracket);
    if (!check.ok) { await client.query("ROLLBACK"); return res.status(409).json({ error: check.message, code: check.code }); }

    // v4: a task can also limit how many boys / girls EACH LEADER brings (no rows = no per-leader limit, as before)
    if (!task.direct) {
      const leaderQuotaRows = await Quota.loadLeaderQuotaRows(client, taskId);
      if (leaderQuotaRows.length) {
        const leaderUsage = await Quota.loadLeaderUsage(client, taskId);
        const lcheck = Quota.checkJoinLeader(!!task.use_age_brackets, leaderQuotaRows, leaderUsage, leaderId, gender, bracket);
        if (!lcheck.ok) { await client.query("ROLLBACK"); return res.status(409).json({ error: lcheck.message, code: lcheck.code }); }
      }
    }

    // per-person scripts: this talent gets the first script nobody else holds (the task row is locked, so no two get the same)
    const scriptId = await Scripts.allocateScript(client, task);

    const sessionToken = crypto.randomBytes(24).toString("hex");
    const result = await client.query(
      `INSERT INTO recording_sessions
         (task_id, leader_id, talent_id, session_token, gender, age_bracket, age, fake_name, script_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [taskId, leaderId, req.studioUser.id, sessionToken, gender, bracket, age || null, fakeName, scriptId]
    );
    const samples = await Scripts.samplesOfSession(client, taskId, scriptId);
    await client.query("COMMIT");
    res.status(201).json({ session: result.rows[0], samples });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    if (err.code === "23505") { // unique_violation — someone else just took this name
      return res.status(409).json({ error: "للأسف حد تاني اختار الاسم ده قبلك بثانية. اختار اسم تاني." });
    }
    console.error(err);
    res.status(500).json({ error: "تعذر بدء الجلسة" });
  } finally {
    client.release();
  }
});

// GET /api/studio/talent/sessions/:token — resume: session + samples + what's recorded so far.
router.get("/sessions/:token", requireStudioAuth, requireStudioRole("talent"), async (req, res) => {
  try {
    await safeExpire(pool);
    const sessionResult = await pool.query(`
      SELECT rs.*, t.recording_settings, t.title AS task_title, t.instructions, t.use_reference_audio, t.rework_hours
      FROM recording_sessions rs JOIN recording_tasks t ON t.id = rs.task_id
      WHERE rs.session_token = $1
    `, [req.params.token]);
    if (!sessionResult.rows.length) return res.status(404).json({ error: "الجلسة دي مش موجودة" });
    const session = sessionResult.rows[0];
    if (session.talent_id !== req.studioUser.id) return res.status(403).json({ error: "الجلسة دي مش بتاعتك" });

    const samples = await pool.query(`
      SELECT s.*, ss.audio_file_url, ss.duration AS recorded_duration, ss.retakes, ss.completed_at,
        ss.qa_status, ss.qa_reason
      FROM recording_samples s
      LEFT JOIN recording_session_samples ss ON ss.sample_id = s.id AND ss.session_id = $1
      WHERE s.task_id = $2 AND s.script_id IS NOT DISTINCT FROM $3
      ORDER BY s.order_index
    `, [session.id, session.task_id, session.script_id]);

    // opening the rework screen counts as "seen" for any company feedback on this session
    if (session.status === "rejected") markAcknowledged(pool, session.id).catch((e) => console.error("[feedback ack]", e.message));
    // v6: a session withdrawn for sitting idle tells the screen how long this task allows
    if (session.status === "expired" && !session.rework_deadline) session.idle_hours = await idleHoursFor(pool, session);
    res.json({ session, samples: samples.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل الجلسة" });
  }
});

// POST /api/studio/talent/sessions/:token/samples/:sampleId/audio — upload
// (or replace) the recording for ONE sentence.
router.post("/sessions/:token/samples/:sampleId/audio", requireStudioAuth, requireStudioRole("talent"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لازم ترفع تسجيل صوتي" });

  try {
    await safeExpire(pool);
    const sessionResult = await pool.query(`SELECT * FROM recording_sessions WHERE session_token = $1`, [req.params.token]);
    if (!sessionResult.rows.length) return res.status(404).json({ error: "الجلسة دي مش موجودة" });
    const session = sessionResult.rows[0];
    if (session.talent_id !== req.studioUser.id) return res.status(403).json({ error: "الجلسة دي مش بتاعتك" });
    if (session.status === "expired") return res.status(410).json({ error: withdrawnMessage(session, await idleHoursFor(pool, session)) });

    const mine = await pool.query(
      `SELECT 1 FROM recording_samples WHERE id = $1 AND task_id = $2 AND script_id IS NOT DISTINCT FROM $3`,
      [req.params.sampleId, session.task_id, session.script_id]);
    if (!mine.rows.length) return res.status(404).json({ error: "الجملة دي مش من جلستك" });

    const existingCheck = await pool.query(
      `SELECT * FROM recording_session_samples WHERE session_id = $1 AND sample_id = $2`,
      [session.id, req.params.sampleId]
    );
    const isRework = session.status === "rejected" && existingCheck.rows.length && existingCheck.rows[0].qa_status === "rejected";
    if (session.status !== "in_progress" && !isRework) {
      return res.status(400).json({ error: "الجملة دي مش محتاجة إعادة، أو الجلسة اتسلّمت بالفعل ومش في وضع الإعادة" });
    }

    const taskResult = await pool.query(`SELECT * FROM recording_tasks WHERE id = $1`, [session.task_id]);
    const task = taskResult.rows[0];

    // The browser is not trusted: parse the real file header and refuse any
    // clip that doesn't match the task's sample rate / bit depth / channels /
    // format (or is silent, too short, or not a real WAV/MP3 at all).
    const check = validateClip(req.file.buffer, task.recording_settings || {});
    if (!check.ok) return res.status(422).json({ error: check.error, code: check.code });

    let drive = null;   // only created when something on Google Drive has to be touched
    let audioUrl;
    if (blob.enabled()) {
      // Bucket storage: one PUT, no Drive calls at all. A fresh key per take, so a retake never overwrites the old one.
      const ext = String((task.recording_settings && task.recording_settings.format) || "wav").toLowerCase();
      const key = `studio/${task.id}/sessions/${session.id}/clips/${blob.seg(req.params.sampleId)}-${Date.now()}.${blob.seg(ext)}`;
      audioUrl = (await blob.putBuffer(key, req.file.buffer, req.file.mimetype || "audio/wav")).ref;
    } else {
      const authClient = await getAuthorizedClient();
      drive = google.drive({ version: "v3", auth: authClient });
      const studioRoot = await getOrCreateStudioRootFolder();
      const taskFolderId = await getOrCreateSubfolder(drive, studioRoot, `${task.title} — ${task.id.slice(0, 8)}`);
      const sessionsFolderId = await getOrCreateSubfolder(drive, taskFolderId, "_sessions (working files)");
      const talentFolderId = await getOrCreateSubfolder(drive, sessionsFolderId, session.fake_name);

      const uploaded = await uploadSubmissionFile(talentFolderId, req.file.originalname, req.file.mimetype, req.file.buffer);
      audioUrl = uploaded.id ? `drive:${uploaded.id}` : null; // internal reference, resolved again at zip time
    }
    const duration = Math.round(check.info.duration * 100) / 100; // measured from the file itself, not trusted from the client

    if (existingCheck.rows.length) {
      await pool.query(
        `UPDATE recording_session_samples
         SET audio_file_url = $1, duration = $2, retakes = retakes + 1, completed_at = now(),
             qa_status = 'pending', qa_reason = NULL
         WHERE id = $3`,
        [audioUrl, duration, existingCheck.rows[0].id]
      );
      // the clip this one replaces is garbage now — free its space (never blocks the upload)
      if (existingCheck.rows[0].audio_file_url && existingCheck.rows[0].audio_file_url !== audioUrl) {
        const old = existingCheck.rows[0].audio_file_url;
        if (!blob.isBlobRef(old) && !drive) drive = google.drive({ version: "v3", auth: await getAuthorizedClient() });
        await deleteQuietly(drive, old);
      }
    } else {
      await pool.query(
        `INSERT INTO recording_session_samples (session_id, sample_id, audio_file_url, duration, completed_at)
         VALUES ($1, $2, $3, $4, now())`,
        [session.id, req.params.sampleId, audioUrl, duration]
      );
    }

    // v6: this is what keeps an idle session from being withdrawn (never blocks the upload)
    try {
      if (await activityColumnReady(pool)) await pool.query(`UPDATE recording_sessions SET last_activity_at = now() WHERE id = $1`, [session.id]);
    } catch (e) { console.error("[activity]", e.message); }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    if (err.code === "DRIVE_NOT_CONNECTED") {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل بالسيرفر." });
    }
    if (/storageQuotaExceeded|quota/i.test(String((err.errors && err.errors[0] && err.errors[0].reason) || err.message))) {
      console.error("[storage] DRIVE FULL — head leader must download + clean from the delivery page");
      return res.status(503).json({ error: "السيرفر مش قادر يستقبل تسجيلات دلوقتي. بلّغ الإدارة وحاول بعد شوية — تسجيلك محفوظ على جهازك." });
    }
    res.status(500).json({ error: "تعذر رفع التسجيل" });
  }
});

// POST /api/studio/talent/sessions/:token/submit — all sentences must be
// recorded. Downloads every recorded clip back from Drive, zips them
// locally, names the zip fake_name-gender-age_bracket-age.zip, uploads it
// to that leader code's QA folder, and marks the session submitted.
router.post("/sessions/:token/submit", requireStudioAuth, requireStudioRole("talent"), async (req, res) => {
  try {
    await safeExpire(pool);
    const sessionResult = await pool.query(`SELECT * FROM recording_sessions WHERE session_token = $1`, [req.params.token]);
    if (!sessionResult.rows.length) return res.status(404).json({ error: "الجلسة دي مش موجودة" });
    const session = sessionResult.rows[0];
    if (session.talent_id !== req.studioUser.id) return res.status(403).json({ error: "الجلسة دي مش بتاعتك" });
    if (session.status === "expired") return res.status(410).json({ error: withdrawnMessage(session, await idleHoursFor(pool, session)) });

    const isResubmit = session.status === "rejected";
    if (session.status !== "in_progress" && !isResubmit) {
      return res.status(400).json({ error: "الجلسة دي اتسلّمت بالفعل" });
    }

    const task = (await pool.query(`SELECT * FROM recording_tasks WHERE id = $1`, [session.task_id])).rows[0];
    const leader = (await pool.query(`SELECT * FROM studio_leaders WHERE id = $1`, [session.leader_id])).rows[0];

    const totalSamples = await pool.query(`SELECT COUNT(*) FROM recording_samples WHERE task_id = $1 AND script_id IS NOT DISTINCT FROM $2`, [session.task_id, session.script_id]);
    const recordedSamples = await pool.query(
      `SELECT ss.* FROM recording_session_samples ss WHERE ss.session_id = $1 AND ss.audio_file_url IS NOT NULL`,
      [session.id]
    );
    if (Number(recordedSamples.rows.length) < Number(totalSamples.rows[0].count)) {
      return res.status(400).json({
        error: `لسه مسجّلش كل الجمل (${recordedSamples.rows.length}/${totalSamples.rows[0].count}). كمّل الباقي الأول.`,
      });
    }
    if (isResubmit) {
      const stillRejected = await pool.query(
        `SELECT COUNT(*) FROM recording_session_samples WHERE session_id = $1 AND qa_status = 'rejected'`,
        [session.id]
      );
      if (Number(stillRejected.rows[0].count) > 0) {
        return res.status(400).json({ error: "لسه فيه جمل مرفوضة محتاجة إعادة تسجيل قبل ما تقدر تبعت تاني." });
      }
    }

    // With bucket storage the ZIP is streamed straight up to the bucket (flat memory);
    // otherwise (Google Drive) it is built in memory first. Clips that were recorded
    // before the move are still on Drive, so a Drive client is created only when needed.
    const useBlob = blob.enabled();
    let drive = null;
    const ensureDrive = async () => {
      if (!drive) drive = google.drive({ version: "v3", auth: await getAuthorizedClient() });
      return drive;
    };
    const zipFileName = `${session.fake_name}-${session.gender}-${session.age_bracket}-${session.age || "NA"}.zip`;
    const zipKey = `studio/${task.id}/sessions/${session.id}/${blob.seg(zipFileName)}`;

    // Build the zip by streaming each clip down from storage.
    // level 1: audio barely shrinks, and level 9 on hundreds of clips only burns CPU time.
    const archive = archiver("zip", { zlib: { level: 1 } });
    const chunks = [];
    let archiveFinished;
    if (useBlob) {
      archiveFinished = blob.putStream(zipKey, archive, "application/zip");
    } else {
      archive.on("data", (chunk) => chunks.push(chunk));
      archiveFinished = new Promise((resolve, reject) => {
        archive.on("end", resolve);
        archive.on("error", reject);
      });
    }
    archiveFinished.catch(() => {});   // surfaced below; avoids an unhandled rejection while we stream

    // After the delivered audio was cleaned off Drive (config/studioStorage.js) only the
    // clips recorded since then still exist, so a re-submission is a PARTIAL ZIP holding
    // exactly those recordings (same numbering: 03.wav = recording 3).
    //
    // v4: the same applies to a re-submission after COMPANY feedback on recordings that were already delivered:
    // the ZIP holds ONLY the sentences that were re-recorded since the feedback was applied,
    // under the same file name, and the delivery sheet marks it "Rework".
    const reworkSince = isResubmit ? await Rework.companyReworkSince(pool, session.id).catch((e) => { console.error("[rework]", e.message); return null; }) : null;
    const reworkOnly = !!reworkSince;
    const samplesWithNames = await pool.query(`
      SELECT ss.audio_file_url, s.order_index, s.sentence_name
      FROM recording_session_samples ss
      JOIN recording_samples s ON s.id = ss.sample_id
      JOIN recording_sessions rs ON rs.id = ss.session_id
      WHERE ss.session_id = $1 AND (rs.audio_purged_at IS NULL OR ss.completed_at > rs.audio_purged_at)
        AND ($2::timestamptz IS NULL OR ss.completed_at > $2::timestamptz)
      ORDER BY s.order_index
    `, [session.id, reworkSince]);
    const isPartial = !!session.audio_purged_at || reworkOnly;
    if (isPartial && !samplesWithNames.rows.length) {
      return res.status(400).json({ error: "مفيش تسجيلات معادة تتسلّم." });
    }

    // A task can have ~600 sentences. Downloading them one after another from Drive
    // takes minutes and runs into the serverless time limit, so fetch them in small
    // parallel windows (each retried on a transient Drive error) and append in order.
    const ext = (task.recording_settings.format || "wav").toLowerCase();
    const rows = samplesWithNames.rows;
    try {
      for (let i = 0; i < rows.length; i += DOWNLOAD_CONCURRENCY) {
        const windowRows = rows.slice(i, i + DOWNLOAD_CONCURRENCY);
        const buffers = await Promise.all(windowRows.map((row) => withRetry(async () => {
          const d = blob.isBlobRef(row.audio_file_url) ? null : await ensureDrive();
          const { stream } = await blob.getStream(row.audio_file_url, { drive: d });
          return streamToBuffer(stream);
        })));
        windowRows.forEach((row, j) => {
          archive.append(buffers[j], { name: `${String(row.order_index + 1).padStart(2, "0")}.${ext}` });
        });
      }
    } catch (e) {
      archive.destroy(e);   // also aborts a half-finished bucket upload
      throw e;
    }
    archive.finalize();
    await archiveFinished;

    let zipFileUrl;
    if (useBlob) {
      zipFileUrl = blob.refFor(zipKey);
    } else {
      const zipBuffer = Buffer.concat(chunks);
      const d = await ensureDrive();
      const studioRoot = await getOrCreateStudioRootFolder();
      const taskFolderId = await getOrCreateSubfolder(d, studioRoot, `${task.title} — ${task.id.slice(0, 8)}`);
      const qaFolderId = await getOrCreateSubfolder(d, taskFolderId, `${leader.leader_code} - QA Reviews`);
      const uploadedZip = await uploadSubmissionFile(qaFolderId, zipFileName, "application/zip", zipBuffer);
      zipFileUrl = uploadedZip.webViewLink || `https://drive.google.com/file/d/${uploadedZip.id}/view`;
    }

    const oldZipUrl = session.zip_file_url;
    await pool.query(
      `UPDATE recording_sessions
       SET status = 'submitted', zip_file_url = $1, zip_file_name = $2, updated_at = now(),
           rejection_reason = NULL, rework_deadline = NULL,
           files_on_drive = true, zip_partial_count = $4
       WHERE id = $3`,
      [zipFileUrl, zipFileName, session.id, isPartial ? samplesWithNames.rows.length : null]
    );
    // v4: remember that THIS zip is a rework-only one (and which recordings it holds) — reset on every normal submit
    if (await Rework.reworkColumnsReady(pool).catch(() => false)) {
      await pool.query(
        `UPDATE recording_sessions SET zip_is_rework = $2, zip_rework_numbers = $3::int[] WHERE id = $1`,
        [session.id, reworkOnly, reworkOnly ? rows.map((r) => r.order_index + 1) : null]
      ).catch((e) => console.error("[rework mark]", e.message));
    }
    // the ZIP from the previous submission is superseded — free its space (never blocks the submit)
    if (oldZipUrl && oldZipUrl !== zipFileUrl) {
      const d = blob.isBlobRef(oldZipUrl) ? null : await ensureDrive().catch(() => null);
      await deleteQuietly(d, oldZipUrl);
    }

    if (isResubmit) await markReworked(pool, session.id).catch((e) => console.error("[feedback reworked]", e.message));
    res.json({ ok: true, zipFileName });
  } catch (err) {
    console.error(err);
    if (err.code === "DRIVE_NOT_CONNECTED") {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل بالسيرفر." });
    }
    res.status(500).json({ error: "تعذر تسليم التاسك، حاول تاني" });
  }
});

// GET /api/studio/talent/me/sessions — everything the logged-in talent has
// recorded, across every task/leader they've worked with.
router.get("/me/sessions", requireStudioAuth, requireStudioRole("talent"), async (req, res) => {
  try {
    await safeExpire(pool);
    const result = await pool.query(`
      SELECT rs.*, t.title AS task_title, l.leader_code,
        (SELECT COUNT(*) FROM recording_samples WHERE task_id = t.id AND script_id IS NOT DISTINCT FROM rs.script_id) AS sample_count,
        (SELECT COUNT(*) FROM recording_session_samples WHERE session_id = rs.id AND audio_file_url IS NOT NULL) AS recorded_count
      FROM recording_sessions rs
      JOIN recording_tasks t ON t.id = rs.task_id
      JOIN studio_leaders l ON l.id = rs.leader_id
      WHERE rs.talent_id = $1
      ORDER BY rs.created_at DESC
    `, [req.studioUser.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل تسكياتك" });
  }
});

module.exports = router;
