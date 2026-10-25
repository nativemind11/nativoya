/**
 * What a leader sees on their dashboard: the tasks they were attached to, and every
 * talent who signed up under their code, with the state of that talent's submission.
 * (Until now the page only listed company feedback — submissions never reached it.)
 *
 * A leader only ever sees THEIR OWN team: every query is scoped by leader_id = $1.
 * The talents' real name / email / WhatsApp are shown to the owning leader on purpose
 * (that is why a leader exists: to follow up with their people).
 */
// Every session of the leader's team gets ONE category, so the boxes never count a person twice:
//   company   company feedback is open: the talent has sentences to redo (pending / acknowledged)
//   final     the company rejected for good (no redo), or the redo deadline passed -> the feedback item is closed as 'expired'
//   ours      QA approved it (it goes to the head leader, who delivers it to the company)  [delivered = already handed to the company]
//   rejected  QA sent it back for rework
//   progress  still recording   |   reviewing  waiting for QA
const CAT_SQL = `
  SELECT rs.id, rs.task_id, rs.status, (rs.delivery_batch_id IS NOT NULL) AS delivered,
    CASE
      WHEN EXISTS (SELECT 1 FROM studio_feedback_items f WHERE f.session_id = rs.id AND f.status IN ('pending','acknowledged')) THEN 'company'
      WHEN EXISTS (SELECT 1 FROM studio_feedback_items f WHERE f.session_id = rs.id AND f.status = 'expired') THEN 'final'
      WHEN rs.status = 'approved' THEN 'ours'
      WHEN rs.status = 'rejected' THEN 'rejected'
      WHEN rs.status = 'in_progress' THEN 'progress'
      WHEN rs.status IN ('submitted','reviewing') THEN 'reviewing'
      ELSE 'other' END AS cat
  FROM recording_sessions rs
  JOIN recording_tasks t ON t.id = rs.task_id
  WHERE rs.leader_id = $1`;

const TASKS_SQL = `
  WITH sc AS (${CAT_SQL})
  SELECT t.id, t.title, t.status, t.published_at,
         COUNT(sc.id) FILTER (WHERE sc.cat <> 'other')::int                       AS sessions,
         COUNT(sc.id) FILTER (WHERE sc.cat = 'progress')::int                     AS in_progress,
         COUNT(sc.id) FILTER (WHERE sc.cat = 'reviewing')::int                    AS reviewing,
         COUNT(sc.id) FILTER (WHERE sc.cat = 'ours')::int                         AS reviewed_by_us,
         COUNT(sc.id) FILTER (WHERE sc.cat = 'ours' AND sc.delivered)::int        AS reviewed_by_us_delivered,
         COUNT(sc.id) FILTER (WHERE sc.cat = 'company')::int                      AS reviewed_by_company,
         COUNT(sc.id) FILTER (WHERE sc.cat = 'final')::int                        AS final_rejected,
         COUNT(sc.id) FILTER (WHERE sc.cat = 'rejected')::int                     AS rejected
  FROM recording_task_leaders rtl
  JOIN recording_tasks t ON t.id = rtl.task_id AND t.status IN ('published','closed')
  LEFT JOIN sc ON sc.task_id = t.id
  WHERE rtl.leader_id = $1
  GROUP BY t.id
  ORDER BY t.published_at DESC NULLS LAST, t.created_at DESC`;

const SESSIONS_SQL = `
  WITH sc AS (${CAT_SQL})
  SELECT rs.id, rs.task_id, t.title AS task_title, rs.fake_name, rs.gender, rs.age_bracket, rs.age,
         rs.status, rs.rejection_reason, rs.rework_deadline, rs.attempt_number, rs.updated_at,
         (rs.delivery_batch_id IS NOT NULL) AS delivered, sc.cat,
         tl.name AS real_name, tl.email, tl.whatsapp,
         (SELECT COUNT(*) FROM recording_session_samples ss
            WHERE ss.session_id = rs.id AND ss.audio_file_url IS NOT NULL)::int AS recorded,
         (SELECT COUNT(*) FROM recording_samples sm WHERE sm.task_id = rs.task_id AND sm.script_id IS NOT DISTINCT FROM rs.script_id)::int AS total
  FROM recording_sessions rs
  JOIN sc ON sc.id = rs.id
  JOIN recording_tasks t ON t.id = rs.task_id
  LEFT JOIN studio_talents tl ON tl.id = rs.talent_id
  WHERE rs.leader_id = $1 AND (rs.status <> 'expired' OR sc.cat = 'final')
  ORDER BY rs.updated_at DESC
  LIMIT 200`;

const COUNTS_SQL = `
  WITH sc AS (${CAT_SQL})
  SELECT COUNT(*) FILTER (WHERE cat = 'progress')::int                      AS in_progress,
         COUNT(*) FILTER (WHERE cat = 'reviewing')::int                     AS reviewing,
         COUNT(*) FILTER (WHERE cat = 'ours')::int                          AS reviewed_by_us,
         COUNT(*) FILTER (WHERE cat = 'ours' AND delivered)::int            AS reviewed_by_us_delivered,
         COUNT(*) FILTER (WHERE cat = 'company')::int                       AS reviewed_by_company,
         COUNT(*) FILTER (WHERE cat = 'final')::int                         AS final_rejected,
         COUNT(*) FILTER (WHERE cat = 'rejected')::int                      AS rejected,
         COUNT(*) FILTER (WHERE delivered AND status <> 'expired')::int     AS delivered
  FROM sc`;

async function getOverview(db, leaderId) {
  const [tasks, sessions, counts] = await Promise.all([
    db.query(TASKS_SQL, [leaderId]),
    db.query(SESSIONS_SQL, [leaderId]),
    db.query(COUNTS_SQL, [leaderId]),
  ]);
  const c = counts.rows[0] || {};
  return {
    stats: {
      openTasks: tasks.rows.filter((t) => t.status === "published").length,
      inProgress: c.in_progress || 0,
      reviewing: c.reviewing || 0,                         // waiting for QA (not shown as a box any more; still in the team table)
      reviewedByUs: c.reviewed_by_us || 0,                 // QA approved it
      reviewedByUsDelivered: c.reviewed_by_us_delivered || 0,   // ...of which the head leader already handed to the company
      reviewedByCompany: c.reviewed_by_company || 0,       // company feedback: sentences to redo
      finalRejected: c.final_rejected || 0,                // company rejected for good / redo deadline missed
      rejected: c.rejected || 0,                           // QA sent it back
      delivered: c.delivered || 0,
    },
    tasks: tasks.rows,
    sessions: sessions.rows,
  };
}

module.exports = { getOverview, CAT_SQL, TASKS_SQL, SESSIONS_SQL, COUNTS_SQL };
