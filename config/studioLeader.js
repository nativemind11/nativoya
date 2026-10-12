/**
 * What a leader sees on their dashboard: the tasks they were attached to, and every
 * talent who signed up under their code, with the state of that talent's submission.
 * (Until now the page only listed company feedback — submissions never reached it.)
 *
 * A leader only ever sees THEIR OWN team: every query is scoped by leader_id = $1.
 * The talents' real name / email / WhatsApp are shown to the owning leader on purpose
 * (that is why a leader exists: to follow up with their people).
 */
const TASKS_SQL = `
  SELECT t.id, t.title, t.status, t.published_at,
         COUNT(rs.id) FILTER (WHERE rs.status <> 'expired')::int                  AS sessions,
         COUNT(rs.id) FILTER (WHERE rs.status = 'in_progress')::int               AS in_progress,
         COUNT(rs.id) FILTER (WHERE rs.status IN ('submitted','reviewing'))::int  AS reviewing,
         COUNT(rs.id) FILTER (WHERE rs.status = 'approved')::int                  AS approved,
         COUNT(rs.id) FILTER (WHERE rs.status = 'rejected')::int                  AS rejected
  FROM recording_task_leaders rtl
  JOIN recording_tasks t ON t.id = rtl.task_id AND t.status IN ('published','closed')
  LEFT JOIN recording_sessions rs ON rs.task_id = t.id AND rs.leader_id = rtl.leader_id
  WHERE rtl.leader_id = $1
  GROUP BY t.id
  ORDER BY t.published_at DESC NULLS LAST, t.created_at DESC`;

const SESSIONS_SQL = `
  SELECT rs.id, rs.task_id, t.title AS task_title, rs.fake_name, rs.gender, rs.age_bracket, rs.age,
         rs.status, rs.rejection_reason, rs.rework_deadline, rs.attempt_number, rs.updated_at,
         (rs.delivery_batch_id IS NOT NULL) AS delivered,
         tl.name AS real_name, tl.email, tl.whatsapp,
         (SELECT COUNT(*) FROM recording_session_samples ss
            WHERE ss.session_id = rs.id AND ss.audio_file_url IS NOT NULL)::int AS recorded,
         (SELECT COUNT(*) FROM recording_samples sm WHERE sm.task_id = rs.task_id)::int AS total
  FROM recording_sessions rs
  JOIN recording_tasks t ON t.id = rs.task_id
  LEFT JOIN studio_talents tl ON tl.id = rs.talent_id
  WHERE rs.leader_id = $1 AND rs.status <> 'expired'
  ORDER BY rs.updated_at DESC
  LIMIT 200`;

const COUNTS_SQL = `
  SELECT COUNT(*) FILTER (WHERE status = 'in_progress')::int                 AS in_progress,
         COUNT(*) FILTER (WHERE status IN ('submitted','reviewing'))::int    AS reviewing,
         COUNT(*) FILTER (WHERE status = 'approved')::int                    AS approved,
         COUNT(*) FILTER (WHERE status = 'rejected')::int                    AS rejected,
         COUNT(*) FILTER (WHERE delivery_batch_id IS NOT NULL)::int          AS delivered
  FROM recording_sessions WHERE leader_id = $1 AND status <> 'expired'`;

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
      reviewing: c.reviewing || 0,
      approved: c.approved || 0,
      rejected: c.rejected || 0,
      delivered: c.delivered || 0,
    },
    tasks: tasks.rows,
    sessions: sessions.rows,
  };
}

module.exports = { getOverview, TASKS_SQL, SESSIONS_SQL, COUNTS_SQL };
