/**
 * Rework-only ZIPs (v4).
 *
 * When the buyer sends feedback on something that was ALREADY delivered, the talent re-records only the
 * sentences named in the feedback. The ZIP that goes back to QA and then to the buyer must hold ONLY those
 * sentences (same file name as the first delivery), and the delivery sheet must say "Rework" — because a
 * different talent may be recording the same task at the same moment, and the buyer has to be able to tell
 * the two kinds of file apart.
 *
 * Everything here is opt-in by data: it only reacts to a feedback item that remembers the batch it had been
 * delivered in (previous_batch_id). A session that was approved but never delivered, and a session QA rejected,
 * keep getting a full ZIP exactly as before.
 */

// True once migration_studio_v4.sql has been run. Until then nothing in this file changes behaviour,
// so the code can be deployed before the migration without breaking a submit or a delivery.
let ready = false;
async function reworkColumnsReady(db) {
  if (ready) return true;
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE (table_name = 'recording_sessions' AND column_name IN ('zip_is_rework', 'zip_rework_numbers'))
        OR (table_name = 'studio_delivery_batch_sessions' AND column_name IN ('is_rework', 'rework_numbers'))`);
  if (r.rows[0].n === 4) ready = true;
  return ready;
}

/**
 * Is this session being re-submitted because of company feedback on already-delivered recordings?
 * Returns the moment the feedback was applied (a Date) — the re-recorded sentences are exactly the ones recorded
 * AFTER it — or null when this is not a company rework.
 */
async function companyReworkSince(db, sessionId) {
  if (!(await reworkColumnsReady(db))) return null;
  const r = await db.query(
    `SELECT MIN(created_at) AS since FROM studio_feedback_items
     WHERE session_id = $1 AND status IN ('pending', 'acknowledged') AND previous_batch_id IS NOT NULL`, [sessionId]);
  return (r.rows[0] && r.rows[0].since) || null;
}

/** "3, 5, 7" for the sheet: 1-based recording numbers, sorted, deduplicated. */
function formatNumbers(nums) {
  if (!Array.isArray(nums) || !nums.length) return "";
  return [...new Set(nums.map(Number).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b).join(", ");
}

module.exports = { reworkColumnsReady, companyReworkSince, formatNumbers };
