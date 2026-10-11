/**
 * "Finish the task for good" — frees every file a task took from storage.
 *
 * Where a task's files live:
 *   - Google Drive : ONE folder per task ("<title> — <id8>") under the Studio root. Working
 *                    clips, session ZIPs, QA folders, Approved, Delivered and the reference
 *                    audio are all inside it, so deleting that folder removes everything.
 *   - R2 bucket    : every object key starts with "studio/<task id>/".
 *
 * What stays: the database rows (sentence names, numbers, statuses, delivery sheets), so
 * history and Excel exports keep working. Only the audio / ZIP files go.
 *
 * Safety (each rule is covered by tests/finalize.test.js):
 *   - refuses while anything could still need the files: feedback waiting for a rework,
 *     recordings still waiting for QA, approved recordings that were never delivered, or
 *     delivery ZIPs the head leader has not confirmed as downloaded;
 *   - the task is closed first, so no talent can start / continue a recording on it;
 *   - the database is only marked as cleared AFTER the files are really gone; a failure
 *     in the middle leaves it re-runnable (deleting an already-deleted file is fine);
 *   - the bucket prefix is built from a validated UUID, never from user text.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const is404 = (e) => e && (e.code === 404 || e.status === 404 || (e.response && e.response.status === 404));

// ------------------------------------------------------------------ checks
function blockersFrom(c) {
  const out = [];
  if (c.open_feedback > 0) out.push({ code: "feedback", count: c.open_feedback, message: `فيه ${c.open_feedback} فيدباك لسه مستني إعادة تسجيل من المتسجّلين.` });
  if (c.awaiting_qa > 0) out.push({ code: "qa", count: c.awaiting_qa, message: `فيه ${c.awaiting_qa} تسليم لسه مستني مراجعة QA.` });
  if (c.undelivered > 0) out.push({ code: "undelivered", count: c.undelivered, message: `فيه ${c.undelivered} تسجيل معتمد لسه ماتسلّمش — اعمل تجميع وتسليم الأول.` });
  if (c.collecting > 0) out.push({ code: "collecting", count: c.collecting, message: `فيه ${c.collecting} تجميع شغّال دلوقتي — استنى لحد ما يخلص.` });
  if (c.not_downloaded > 0) out.push({ code: "not_downloaded", count: c.not_downloaded, message: `فيه ${c.not_downloaded} ملف تسليم لسه ماتحمّلش — حمّله وأكّد التحميل الأول.` });
  return out;
}

function makeRepo(db) {
  return {
    async getTask(taskId, headLeaderId) {
      const r = await db.query(
        `SELECT id, title, status, drive_root_folder_id, finalized_at, storage_cleared_at, storage_freed_bytes
         FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`, [taskId, headLeaderId]);
      return r.rows[0] || null;
    },
    async counts(taskId) {
      const r = await db.query(
        `SELECT
           (SELECT COUNT(*) FROM studio_feedback_items WHERE task_id = $1 AND status IN ('pending','acknowledged'))::int AS open_feedback,
           (SELECT COUNT(*) FROM recording_sessions WHERE task_id = $1 AND status IN ('submitted','reviewing'))::int AS awaiting_qa,
           (SELECT COUNT(*) FROM recording_sessions WHERE task_id = $1 AND status = 'approved' AND delivery_batch_id IS NULL)::int AS undelivered,
           (SELECT COUNT(*) FROM studio_delivery_batches WHERE task_id = $1 AND status = 'collecting')::int AS collecting,
           (SELECT COUNT(*) FROM studio_delivery_batches WHERE task_id = $1 AND status = 'delivered' AND downloaded_at IS NULL AND zip_purged_at IS NULL)::int AS not_downloaded,
           (SELECT COUNT(*) FROM recording_sessions WHERE task_id = $1 AND files_on_drive)::int AS sessions_with_files,
           (SELECT COUNT(*) FROM recording_sessions WHERE task_id = $1 AND status = 'in_progress')::int AS in_progress,
           (SELECT COUNT(*) FROM studio_delivery_batches WHERE task_id = $1 AND zip_file_url IS NOT NULL AND zip_purged_at IS NULL)::int AS zips`, [taskId]);
      return r.rows[0];
    },
    async begin(taskId) {
      await db.query(`UPDATE recording_tasks SET status = 'closed', finalized_at = COALESCE(finalized_at, now()) WHERE id = $1`, [taskId]);
    },
    async hasBlobRefs(taskId) {
      const r = await db.query(
        `SELECT EXISTS (
           SELECT 1 FROM recording_sessions rs WHERE rs.task_id = $1 AND rs.zip_file_url LIKE 'r2:%' AND rs.files_on_drive
           UNION ALL SELECT 1 FROM recording_session_samples ss JOIN recording_sessions rs ON rs.id = ss.session_id
                     WHERE rs.task_id = $1 AND rs.files_on_drive AND ss.audio_file_url LIKE 'r2:%'
           UNION ALL SELECT 1 FROM studio_delivery_batches b WHERE b.task_id = $1 AND b.zip_purged_at IS NULL AND b.zip_file_url LIKE 'r2:%'
         ) AS yes`, [taskId]);
      return r.rows[0].yes;
    },
    async hasDriveRefs(taskId) {
      const r = await db.query(
        `SELECT EXISTS (
           SELECT 1 FROM recording_sessions rs WHERE rs.task_id = $1 AND rs.files_on_drive AND rs.zip_file_url IS NOT NULL AND rs.zip_file_url NOT LIKE 'r2:%'
           UNION ALL SELECT 1 FROM recording_session_samples ss JOIN recording_sessions rs ON rs.id = ss.session_id
                     WHERE rs.task_id = $1 AND rs.files_on_drive AND ss.audio_file_url IS NOT NULL AND ss.audio_file_url NOT LIKE 'r2:%'
           UNION ALL SELECT 1 FROM studio_delivery_batches b WHERE b.task_id = $1 AND b.zip_purged_at IS NULL AND b.zip_file_url IS NOT NULL AND b.zip_file_url NOT LIKE 'r2:%'
           UNION ALL SELECT 1 FROM recording_samples WHERE task_id = $1 AND audio_url IS NOT NULL
           UNION ALL SELECT 1 FROM recording_tasks WHERE id = $1 AND (script_file_url IS NOT NULL OR drive_root_folder_id IS NOT NULL)
         ) AS yes`, [taskId]);
      return r.rows[0].yes;
    },
    async studioRootFolderId() {
      const r = await db.query(`SELECT studio_root_folder_id FROM google_auth LIMIT 1`);
      return (r.rows[0] && r.rows[0].studio_root_folder_id) || null;
    },
    /** Everything is gone from storage -> record it. One transaction. */
    async markCleared(taskId, freedBytes) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(`UPDATE recording_sessions SET files_on_drive = false, audio_purged_at = now() WHERE task_id = $1 AND files_on_drive`, [taskId]);
        await client.query(`UPDATE studio_delivery_batches SET zip_purged_at = now() WHERE task_id = $1 AND zip_file_url IS NOT NULL AND zip_purged_at IS NULL`, [taskId]);
        await client.query(`UPDATE recording_samples SET audio_url = NULL WHERE task_id = $1`, [taskId]);
        await client.query(`DELETE FROM studio_drive_folders WHERE task_id = $1`, [taskId]);
        await client.query(
          `UPDATE recording_tasks SET script_file_url = NULL, drive_root_folder_id = NULL, storage_cleared_at = now(),
                  storage_freed_bytes = COALESCE(storage_freed_bytes, 0) + $2 WHERE id = $1`, [taskId, Math.max(0, Math.round(freedBytes || 0))]);
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
      finally { client.release(); }
    },
    /** Bytes freed in a call that did not finish yet (the next call adds its own). */
    async addFreed(taskId, bytes) {
      if (bytes > 0) await db.query(`UPDATE recording_tasks SET storage_freed_bytes = COALESCE(storage_freed_bytes, 0) + $2 WHERE id = $1`, [taskId, Math.round(bytes)]);
    },
  };
}

/** What the confirmation dialog shows: what will be deleted and what is in the way. */
async function getFinalizeInfo({ repo, taskId, headLeaderId }) {
  if (!UUID.test(String(taskId || ""))) return { notFound: true };
  const task = await repo.getTask(taskId, headLeaderId);
  if (!task) return { notFound: true };
  const c = await repo.counts(taskId);
  const blockers = blockersFrom(c);
  const warnings = [];
  if (c.in_progress > 0) warnings.push({ code: "in_progress", count: c.in_progress, message: `فيه ${c.in_progress} تسجيل مش مكتمل (المتسجّل ماكمّلش) — هيتمسح معاهم.` });
  return {
    task: { id: task.id, title: task.title, status: task.status, finalized_at: task.finalized_at, storage_cleared_at: task.storage_cleared_at, storage_freed_bytes: task.storage_freed_bytes },
    alreadyCleared: !!task.storage_cleared_at,
    blockers, warnings,
    counts: { sessions: c.sessions_with_files, zips: c.zips, inProgress: c.in_progress },
    canFinalize: !task.storage_cleared_at && blockers.length === 0,
  };
}

/**
 * Does the deleting. Resumable: stops at budgetMs with done:false and can be called again.
 * deps (all injectable for tests): blob, getDrive() -> drive client, getQuota(drive), now
 */
async function runFinalize({ repo, taskId, headLeaderId, deps, budgetMs = 40000 }) {
  const { blob, getDrive, getQuota, now = Date.now } = deps;
  const info = await getFinalizeInfo({ repo, taskId, headLeaderId });
  if (info.notFound) return { status: 404, error: "المهمة مش موجودة" };
  if (info.alreadyCleared) return { status: 200, done: true, already: true, freedBytes: Number(info.task.storage_freed_bytes) || 0 };
  if (info.blockers.length) return { status: 409, error: "المهمة لسه مش جاهزة للإنهاء النهائي.", blockers: info.blockers };

  const started = now();
  const task = await repo.getTask(taskId, headLeaderId);
  await repo.begin(taskId);                      // closed from now on: no new recordings on it

  let freed = 0, r2Deleted = 0, driveFolders = 0;
  const finish = async () => { try { await repo.addFreed(taskId, freed); } catch (_) {} };   // partial progress is remembered

  // ---- 1) bucket objects
  if (blob.enabled()) {
    const res = await blob.removePrefix(`studio/${task.id}/`, { budgetMs: Math.max(1000, budgetMs - (now() - started)), now });
    freed += res.bytes; r2Deleted += res.deleted;
    if (!res.complete) { await finish(); return { status: 200, done: false, stoppedEarly: true, r2Deleted, freedBytes: freed }; }
  } else if (await repo.hasBlobRefs(taskId)) {
    return { status: 503, error: "ملفات المهمة على R2 لكن إعدادات R2 مش متظبطة على السيرفر." };
  }

  // ---- 2) Google Drive: the task's folder takes everything inside it along
  if (await repo.hasDriveRefs(taskId)) {
    let drive;
    try { drive = await getDrive(); }
    catch (e) {
      await finish();
      if (e && e.code === "DRIVE_NOT_CONNECTED") return { status: 503, error: "جوجل درايف لسه مش متصل بالسيرفر." };
      throw e;
    }
    let before = null;
    try { before = await getQuota(drive); } catch (_) {}
    const ids = new Set();
    if (task.drive_root_folder_id) ids.add(task.drive_root_folder_id);
    const root = await repo.studioRootFolderId();
    if (root) {      // same folder, found by name — catches a copy made by an older version
      const name = `${task.title} — ${task.id.slice(0, 8)}`.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const found = await drive.files.list({ q: `'${root}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, fields: "files(id)" });
      for (const f of (found.data && found.data.files) || []) ids.add(f.id);
    }
    for (const id of ids) {
      try { await drive.files.delete({ fileId: id }); driveFolders++; }
      catch (e) { if (!is404(e)) { await finish(); throw e; } }
    }
    try { const after = await getQuota(drive); if (before && after && after.usage < before.usage) freed += before.usage - after.usage; } catch (_) {}
  }

  // ---- 3) only now the database says "cleared"
  await repo.markCleared(taskId, freed);
  return { status: 200, done: true, r2Deleted, driveFolders, freedBytes: freed };
}

module.exports = { UUID, blockersFrom, makeRepo, getFinalizeInfo, runFinalize };
