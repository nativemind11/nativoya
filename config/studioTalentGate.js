/**
 * One task, one go, per talent (v6).
 *
 * A talent who already has a session on a task that is still alive (in progress, submitted, with QA, approved,
 * or sent back for rework) does not get that task again: it disappears from his "available" list and the
 * server refuses to start it a second time — even from an old link. Two things reopen it for him:
 *   - his session was WITHDRAWN (status 'expired': idle for 8 hours, or the rework deadline passed),
 *   - nothing else. A FINAL rejection from the company (feedback item is_final) closes the task for him for good.
 *
 * Everything here is read-only; it never changes a session.
 */

/** Map<taskId, 'active' | 'final'> — the tasks this talent can no longer start. */
async function blockedTasks(db, talentId) {
  const out = new Map();
  const active = await db.query(
    `SELECT DISTINCT task_id FROM recording_sessions WHERE talent_id = $1 AND status <> 'expired'`, [talentId]);
  for (const r of active.rows) out.set(r.task_id, "active");
  try {
    const fin = await db.query(
      `SELECT DISTINCT rs.task_id FROM studio_feedback_items f
       JOIN recording_sessions rs ON rs.id = f.session_id
       WHERE rs.talent_id = $1 AND f.is_final`, [talentId]);
    for (const r of fin.rows) out.set(r.task_id, "final");      // final wins over active
  } catch (err) {
    console.error("[gate final]", err.message);                  // is_final column missing (v5 not run): ignore
  }
  return out;
}

/**
 * Called inside the start-session transaction, after the task row is locked (so two taps cannot both pass).
 * Returns null when the talent may start, otherwise { status, code, message, sessionToken? }.
 */
async function checkStart(db, talentId, taskId) {
  const rows = (await db.query(
    `SELECT status, session_token FROM recording_sessions WHERE talent_id = $1 AND task_id = $2 AND status <> 'expired'
     ORDER BY created_at DESC`, [talentId, taskId])).rows;
  let isFinal = false;
  // inside the caller's transaction: a failed query would poison it, so it runs behind a savepoint
  await db.query("SAVEPOINT gate_final");
  try {
    isFinal = (await db.query(
      `SELECT 1 FROM studio_feedback_items f JOIN recording_sessions rs ON rs.id = f.session_id
       WHERE rs.talent_id = $1 AND rs.task_id = $2 AND f.is_final LIMIT 1`, [talentId, taskId])).rows.length > 0;
    await db.query("RELEASE SAVEPOINT gate_final");
  } catch (err) {
    console.error("[gate final]", err.message);                  // is_final column missing (v5 not run): ignore
    await db.query("ROLLBACK TO SAVEPOINT gate_final");
  }
  if (isFinal) {
    return { status: 409, code: "final_rejected", message: "المهمة دي اتقفلت عليك: الشركة رفضت تسليمك رفضًا نهائيًا." };
  }
  if (!rows.length) return null;
  const running = rows.find((r) => r.status === "in_progress");
  if (running) {
    return { status: 409, code: "already_started", sessionToken: running.session_token,
             message: "عندك جلسة شغالة في المهمة دي. كمّلها من حسابك." };
  }
  return { status: 409, code: "already_done", message: "إنت سلّمت المهمة دي قبل كده. تقدر تتابعها من حسابك." };
}

module.exports = { blockedTasks, checkStart };
