/**
 * Withdraws sessions whose 12-hour rework deadline passed without a
 * re-submission: the session becomes 'expired' (its fake name is free again —
 * the unique index ignores expired rows — and it no longer counts toward the
 * task's slots), and its open feedback items are closed as 'expired'.
 *
 * There is no scheduler on this platform, so this is called lazily at the
 * start of every request that depends on the answer (name list, slot counts,
 * starting/resuming a session, uploads, submit, feedback listings). That makes
 * the result correct at the moment anyone looks, with nothing to run on a clock.
 *
 * Only sessions with rework_enforced = true are touched: sessions rejected
 * before this rule existed keep their old informational deadline.
 */
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

/** Same, but a failure here must never break the request that triggered it. */
async function safeExpire(db) {
  try { return await expireOverdue(db); }
  catch (err) { console.error("[expiry]", err.message); return { sessions: 0, items: 0 }; }
}

module.exports = { expireOverdue, safeExpire };
