/**
 * Storage management for the free Google Drive quota (~15 GB).
 *
 * Why it exists: every talent leaves up to three copies of the same audio on
 * Drive (the working clips, the session ZIP, the big delivery ZIP). A head
 * leader downloads the big ZIP to his own device and presses "downloaded";
 * only after that confirmation may anything be deleted:
 *
 *   stage 1 — the working clips + session ZIP of sessions inside a downloaded batch
 *   stage 2 — (only if still above the limit) the big delivery ZIPs, oldest first
 *
 * Safety rules (each one is covered by tests/storage.test.js):
 *   - nothing is touched before the head leader confirmed the download
 *   - a session is CLAIMED with an atomic UPDATE before any file is deleted, so
 *     a feedback arriving at the same moment can never lose clips it needs
 *   - a failed delete rolls the claim back; a 404 (already gone) counts as success
 *   - the database rows (names, recording numbers, statuses) are never deleted:
 *     a rework after the audio is gone still works, with only the re-recorded clips
 */
const { google } = require("googleapis");
const { getAuthorizedClient } = require("./googleDrive");
const blob = require("./studioBlob");

const AUTO_THRESHOLD = 0.8;  // start cleaning when Drive is 80 % full
const TARGET = 0.6;          // ...and stop once it is back under 60 %
const DELETE_CONCURRENCY = 6;

/** "drive:<id>" (a clip) or a Drive URL (a ZIP) -> file id, or null. */
function fileIdFromRef(ref) {
  if (!ref) return null;
  const s = String(ref);
  if (s.startsWith("drive:")) return s.slice(6) || null;
  const m = s.match(/\/file\/d\/([^/?#]+)/) || s.match(/[?&]id=([^&#]+)/);
  return m ? m[1] : null;
}

const is404 = (e) => e && (e.code === 404 || e.status === 404 || (e.response && e.response.status === 404));

/** Deletes one Drive file for good. Already-gone counts as success. */
async function deleteDriveFile(drive, ref) {
  if (blob.isBlobRef(ref)) return blob.remove(ref);   // bucket object: no Drive client needed
  const fileId = fileIdFromRef(ref);
  if (!fileId) return false;
  try {
    await drive.files.delete({ fileId });
    return true;
  } catch (e) {
    if (is404(e)) return false;
    throw e;
  }
}

async function deleteMany(drive, refs) {
  const queue = [...new Set(refs.filter(Boolean))];
  let deleted = 0;
  const worker = async () => {
    while (queue.length) {
      const ref = queue.shift();
      if (await deleteDriveFile(drive, ref)) deleted++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, queue.length) }, worker));
  return deleted;
}

/** Same as deleteDriveFile but never throws — for clean-up that must not break a request. */
async function deleteQuietly(drive, ref) {
  try { return await deleteDriveFile(drive, ref); }
  catch (e) { console.error("[storage] could not delete", String(ref).slice(0, 80), e.message); return false; }
}

/** Real numbers from Google (shared with Gmail/Photos on the same account). */
async function getQuota(drive) {
  const r = await drive.about.get({ fields: "storageQuota" });
  const q = r.data.storageQuota || {};
  const limit = q.limit ? Number(q.limit) : null;     // null = unlimited account
  const usage = q.usage ? Number(q.usage) : 0;
  return { limit, usage, pct: limit ? usage / limit : 0 };
}

// ------------------------------------------------------------------ database
function makeRepo(db) {
  return {
    async countEligible() {
      const r = await db.query(
        `SELECT COUNT(*)::int AS n FROM recording_sessions rs
         JOIN studio_delivery_batches b ON b.id = rs.delivery_batch_id
         WHERE rs.status = 'approved' AND rs.files_on_drive AND b.status = 'delivered' AND b.downloaded_at IS NOT NULL`);
      return r.rows[0].n;
    },
    async countAwaitingDownload() {
      const r = await db.query(`SELECT COUNT(*)::int AS n FROM studio_delivery_batches WHERE status = 'delivered' AND downloaded_at IS NULL`);
      return r.rows[0].n;
    },
    async listEligibleSessions(limit) {
      const r = await db.query(
        `SELECT rs.id, rs.zip_file_url, rs.audio_purged_at::text AS audio_purged_at   -- text: keeps Postgres' microseconds (a JS Date would cut them and the claim would never match)
         FROM recording_sessions rs
         JOIN studio_delivery_batches b ON b.id = rs.delivery_batch_id
         WHERE rs.status = 'approved' AND rs.files_on_drive AND b.status = 'delivered' AND b.downloaded_at IS NOT NULL
         ORDER BY b.delivered_at ASC, rs.id LIMIT $1`, [limit]);
      return r.rows;
    },
    /** Atomic claim. Returns false if the session changed meanwhile (feedback, already claimed). */
    async claimSession(id, prevPurgedAt) {
      const r = await db.query(
        `UPDATE recording_sessions SET files_on_drive = false, audio_purged_at = now()
         WHERE id = $1 AND status = 'approved' AND files_on_drive AND delivery_batch_id IS NOT NULL
           AND audio_purged_at IS NOT DISTINCT FROM $2::timestamptz
         RETURNING id`, [id, prevPurgedAt]);
      return r.rowCount === 1;
    },
    async unclaimSession(id, prevPurgedAt) {
      await db.query(`UPDATE recording_sessions SET files_on_drive = true, audio_purged_at = $2::timestamptz WHERE id = $1`, [id, prevPurgedAt]);
    },
    /** Only the clips that can still exist on Drive: those recorded after the previous purge. */
    async clipRefs(sessionId, since) {
      const r = await db.query(
        `SELECT audio_file_url FROM recording_session_samples
         WHERE session_id = $1 AND audio_file_url IS NOT NULL AND ($2::timestamptz IS NULL OR completed_at > $2::timestamptz)`,
        [sessionId, since]);
      return r.rows.map((x) => x.audio_file_url);
    },
    async listEligibleBatches(limit) {
      const r = await db.query(
        `SELECT id, zip_file_url FROM studio_delivery_batches
         WHERE status = 'delivered' AND downloaded_at IS NOT NULL AND zip_purged_at IS NULL AND zip_file_url IS NOT NULL
         ORDER BY delivered_at ASC LIMIT $1`, [limit]);
      return r.rows;
    },
    async claimBatch(id) {
      const r = await db.query(
        `UPDATE studio_delivery_batches SET zip_purged_at = now()
         WHERE id = $1 AND status = 'delivered' AND downloaded_at IS NOT NULL AND zip_purged_at IS NULL RETURNING id`, [id]);
      return r.rowCount === 1;
    },
    async unclaimBatch(id) {
      await db.query(`UPDATE studio_delivery_batches SET zip_purged_at = NULL WHERE id = $1`, [id]);
    },
  };
}

// --------------------------------------------------------------------- purge
/**
 * mode "auto"   : does nothing below 80 %, otherwise cleans until 60 %.
 * mode "manual" : cleans every duplicate of a downloaded batch (stage 1), then
 *                 stage 2 only while Drive is still above 80 %.
 * Stops at budgetMs so one HTTP request can never run into the platform timeout;
 * whatever is left stays eligible for the next call.
 */
async function runPurge({ repo, drive, mode = "manual", budgetMs = 40000, now = Date.now }) {
  const started = now();
  const timeLeft = () => budgetMs - (now() - started);
  let quota = await getQuota(drive);
  const result = { sessions: 0, batches: 0, stoppedEarly: false, before: quota, after: quota };

  if (mode === "auto" && quota.pct < AUTO_THRESHOLD) return result;
  const satisfied = () => mode === "auto" && quota.pct < TARGET;

  // stage 1 — duplicates of downloaded batches
  let sinceCheck = 0;
  while (!satisfied()) {
    if (timeLeft() <= 0) { result.stoppedEarly = true; break; }
    const list = await repo.listEligibleSessions(20);
    if (!list.length) break;
    let progressed = false;
    for (const s of list) {
      if (timeLeft() <= 0) { result.stoppedEarly = true; break; }
      const prev = s.audio_purged_at || null;
      if (!(await repo.claimSession(s.id, prev))) continue;          // changed under us — skip, never delete
      try {
        const refs = await repo.clipRefs(s.id, prev);
        await deleteMany(drive, [...refs, s.zip_file_url]);
        result.sessions++; progressed = true;
      } catch (e) {
        await repo.unclaimSession(s.id, prev);                        // put it back, try again next time
        console.error("[storage] session purge failed", s.id, e.message);
        result.error = e.message;
        break;
      }
      if (++sinceCheck % 5 === 0) { quota = await getQuota(drive); if (satisfied()) break; }
    }
    if (result.error || result.stoppedEarly || !progressed) break;
  }
  quota = await getQuota(drive);

  // stage 2 — the big delivery ZIPs, only if Drive is still too full
  while (!result.error && !result.stoppedEarly && quota.pct >= AUTO_THRESHOLD) {
    if (timeLeft() <= 0) { result.stoppedEarly = true; break; }
    const list = await repo.listEligibleBatches(5);
    if (!list.length) break;
    for (const b of list) {
      if (!(await repo.claimBatch(b.id))) continue;
      try { await deleteDriveFile(drive, b.zip_file_url); result.batches++; }
      catch (e) { await repo.unclaimBatch(b.id); console.error("[storage] batch purge failed", b.id, e.message); result.error = e.message; break; }
    }
    quota = await getQuota(drive);
    if (result.error) break;
  }

  result.after = quota;
  return result;
}

/** Everything the dashboard needs in one object. */
async function getStatus({ repo, drive }) {
  const [quota, eligibleSessions, awaitingDownload] = await Promise.all([getQuota(drive), repo.countEligible(), repo.countAwaitingDownload()]);
  return { ...quota, eligibleSessions, awaitingDownload, autoThreshold: AUTO_THRESHOLD };
}

async function driveClient() {
  return google.drive({ version: "v3", auth: await getAuthorizedClient() });
}

module.exports = {
  fileIdFromRef, deleteDriveFile, deleteQuietly, getQuota, makeRepo, runPurge, getStatus, driveClient,
  AUTO_THRESHOLD, TARGET,
};
