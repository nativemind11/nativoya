/**
 * Withdraws sessions so their fake name / slot / script / code is free again.
 *
 *  1) Rework deadline (12h by default): a REJECTED session whose rework deadline passed without a
 *     re-submission becomes 'expired', and its open feedback items are closed as 'expired'.
 *     Only sessions with rework_enforced = true are touched: sessions rejected before this rule
 *     existed keep their old informational deadline.
 *
 *  2) Idle sessions (v6): an IN_PROGRESS session with no uploaded recording for the task's idle_hours
 *     (8 unless the head leader chose another number for that task) is withdrawn too. Its name, its place in the quotas, its per-person script and its code come
 *     back (the unique index and every counter ignore 'expired' rows). The clips it had uploaded
 *     are deleted from storage afterwards, a few sessions per request (purgeAbandoned).
 *     This needs migration_studio_v6.sql (columns last_activity_at, idle_hours); until it ran, nothing is withdrawn.
 *
 * There is no scheduler on this platform, so this is called lazily at the start of every request
 * that depends on the answer (name list, slot counts, starting/resuming a session, uploads, submit,
 * feedback listings). The result is correct at the moment anyone looks, with nothing to run on a clock.
 */
const IDLE_HOURS = 8;          // the default; every task carries its own idle_hours (chosen when it is published)

async function expireOverdue(db) {
  const r = await db.query(
    `WITH exp AS (
       UPDATE recording_sessions
       SET status = 'expired', expired_at = now(), updated_at = now()
       WHERE status = 'rejected' AND rework_enforced
         AND rework_deadline IS NOT NULL AND rework_deadline < now()
       RETURNING id),
     fb AS (
       UPDATE studio_feedback_items f SET status = 'expired'
       FROM exp WHERE f.session_id = exp.id AND f.status IN ('pending', 'acknowledged')
       RETURNING f.id)
     SELECT (SELECT COUNT(*)::int FROM exp) AS sessions, (SELECT COUNT(*)::int FROM fb) AS items`);
  return r.rows[0];
}

// True once migration_studio_v6.sql has been run (cached once true).
let activityReady = false;
async function activityColumnReady(db) {
  if (activityReady) return true;
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE (table_name = 'recording_sessions' AND column_name = 'last_activity_at')
        OR (table_name = 'recording_tasks' AND column_name = 'idle_hours')`);
  if (r.rows[0].n === 2) activityReady = true;
  return activityReady;
}

/** In-progress sessions idle for their task's idle_hours -> 'expired'. Returns how many were withdrawn. */
async function expireAbandoned(db) {
  if (!(await activityColumnReady(db))) return { sessions: 0 };
  const r = await db.query(
    `UPDATE recording_sessions rs
     SET status = 'expired', expired_at = now(), updated_at = now()
     FROM recording_tasks t
     WHERE t.id = rs.task_id AND rs.status = 'in_progress'
       AND COALESCE(rs.last_activity_at, rs.created_at) < now() - (t.idle_hours * interval '1 hour')
     RETURNING rs.id`);
  return { sessions: r.rowCount };
}

/**
 * Deletes the uploaded clips of sessions withdrawn for idleness (never submitted: no ZIP, no rework deadline).
 * Best effort and time-boxed: a few sessions per call; the rest are picked up by later requests.
 * A session is claimed with an atomic UPDATE (audio_purged_at) before any file is deleted, and the
 * claim is rolled back if a delete fails, so nothing is lost and nothing is deleted twice.
 */
async function purgeAbandoned(db, { limit = 3, budgetMs = 3000, now = Date.now, deleter = null } = {}) {
  const started = now();
  let purged = 0;
  for (let i = 0; i < limit && now() - started < budgetMs; i++) {
    const claim = await db.query(
      `UPDATE recording_sessions SET audio_purged_at = now()
       WHERE id = (SELECT rs.id FROM recording_sessions rs
                   WHERE rs.status = 'expired' AND rs.rework_deadline IS NULL AND rs.zip_file_url IS NULL
                     AND rs.audio_purged_at IS NULL
                     AND EXISTS (SELECT 1 FROM recording_session_samples ss WHERE ss.session_id = rs.id)
                   LIMIT 1 FOR UPDATE SKIP LOCKED)
         AND audio_purged_at IS NULL
       RETURNING id`);
    if (!claim.rows.length) break;
    const id = claim.rows[0].id;
    try {
      const refs = (await db.query(`SELECT audio_file_url FROM recording_session_samples WHERE session_id = $1`, [id]))
        .rows.map((r) => r.audio_file_url).filter(Boolean);
      if (deleter) {                       // tests inject their own deleter; production uses the storage layers below
        for (const ref of refs) await deleter(ref);
      } else {
        const blob = require("./studioBlob");
        const { deleteQuietly, deleteDriveFile } = require("./studioStorage");
        let drive = null;
        for (const ref of refs) {
          if (blob.isBlobRef(ref)) { await deleteDriveFile(null, ref); continue; }
          if (!drive) {
            const { google } = require("googleapis");
            const { getAuthorizedClient } = require("./googleDrive");
            drive = google.drive({ version: "v3", auth: await getAuthorizedClient() });
          }
          await deleteQuietly(drive, ref);
        }
      }
      await db.query(`DELETE FROM recording_session_samples WHERE session_id = $1`, [id]);
      purged++;
    } catch (err) {
      console.error("[expiry] purge failed, will retry later:", err.message);
      await db.query(`UPDATE recording_sessions SET audio_purged_at = NULL WHERE id = $1`, [id]).catch(() => {});
      break;
    }
  }
  return purged;
}

/** Same as the two above, but a failure here must never break the request that triggered it. */
async function safeExpire(db) {
  let out = { sessions: 0, items: 0 };
  try { out = await expireOverdue(db); }
  catch (err) { console.error("[expiry]", err.message); }
  try { await expireAbandoned(db); }
  catch (err) { console.error("[expiry idle]", err.message); }
  try { await purgeAbandoned(db); }
  catch (err) { console.error("[expiry purge]", err.message); }
  return out;
}

/** The message a talent sees when their session was withdrawn: for idleness (with the task's hours when known), or for a missed rework deadline. */
function withdrawnMessage(session, hours) {
  if (session && !session.rework_deadline) {
    return hours
      ? `الجلسة اتسحبت لأنها فضلت من غير تسجيل أكتر من ${hours} ساعة والاسم رجع متاح. ممكن تبدأ تسجيل جديد من قايمة المهام.`
      : "الجلسة اتسحبت لأنها فضلت من غير تسجيل أكتر من المدة المحددة للمهمة والاسم رجع متاح. ممكن تبدأ تسجيل جديد من قايمة المهام.";
  }
  return "انتهت مهلة الإعادة والاسم اتسحب منك. ممكن تبدأ تسجيل جديد من قايمة المهام.";
}

/** The task's idle hours, only looked up when the message needs it (an idle withdrawal). null when unknown. */
async function idleHoursFor(db, session) {
  if (!session || session.rework_deadline) return null;
  try {
    if (!(await activityColumnReady(db))) return null;
    const r = await db.query(`SELECT idle_hours FROM recording_tasks WHERE id = $1`, [session.task_id]);
    return (r.rows[0] && Number(r.rows[0].idle_hours)) || null;
  } catch (_) { return null; }
}

module.exports = { IDLE_HOURS, expireOverdue, expireAbandoned, purgeAbandoned, safeExpire, activityColumnReady, withdrawnMessage, idleHoursFor };
