/**
 * Quotas: how many talents a task wants, per gender — and per age bracket when the task uses brackets.
 *
 * A task with NO quota rows has no limit (that is how every task behaved before). Once a task has rows,
 * a combination that has no row is closed. A talent's session uses up a slot from the moment it is
 * created, until it is withdrawn (status 'expired'): a rejected session still holds its place.
 */
const GENDERS = ["male", "female"];
const BRACKETS = ["child", "adult", "elderly"];
const GENDER_WORD = { male: "الأولاد", female: "البنات" };
const BRACKET_WORD = { child: "الأطفال", adult: "البالغين", elderly: "كبار السن" };

function httpError(status, message, code) {
  const e = new Error(message); e.statusCode = status; if (code) e.code = code; return e;
}
const label = (gender, bracket) => `${GENDER_WORD[gender] || gender}${bracket ? ` (${BRACKET_WORD[bracket] || bracket})` : ""}`;

/** Validates what the dashboard sends: [{ gender, ageBracket?, max }]. Returns clean rows. */
function normalizeQuotas(input, useBrackets) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw httpError(400, "صيغة الحصص غير صحيحة");
  const seen = new Set(), out = [];
  for (const q of input) {
    const gender = String((q && q.gender) || "");
    if (!GENDERS.includes(gender)) throw httpError(400, "النوع في الحصة غير صحيح");
    const bracket = q.ageBracket == null ? "" : String(q.ageBracket);
    if (useBrackets) { if (!BRACKETS.includes(bracket)) throw httpError(400, "حدّد الفئة العمرية لكل حصة"); }
    else if (bracket !== "") throw httpError(400, "الفئات العمرية مش مفعّلة للمهمة دي");
    const max = Number(q.max);
    if (!Number.isInteger(max) || max < 0 || max > 100000) throw httpError(400, "العدد في الحصة لازم يكون رقم صحيح بين 0 و 100000");
    const key = `${gender}|${bracket}`;
    if (seen.has(key)) throw httpError(400, "في حصة اتكررت");
    seen.add(key);
    out.push({ gender, ageBracket: bracket, max });
  }
  return out;
}

/** quotaRows: [{gender, ageBracket, max}] ; usageRows: [{gender, age_bracket, used}] */
function computeSlots(useBrackets, quotaRows, usageRows) {
  if (!quotaRows.length) return { limited: false, slots: [] };
  const used = new Map();
  for (const u of usageRows) {
    const key = `${u.gender}|${useBrackets ? u.age_bracket : ""}`;
    used.set(key, (used.get(key) || 0) + Number(u.used));
  }
  const slots = quotaRows.map((q) => {
    const n = used.get(`${q.gender}|${useBrackets ? q.ageBracket : ""}`) || 0;
    return { gender: q.gender, ageBracket: q.ageBracket, max: q.max, used: n, remaining: Math.max(0, q.max - n), full: n >= q.max };
  });
  return { limited: true, slots };
}

/** Can this person still join? */
function checkJoin(useBrackets, quotaRows, usageRows, gender, bracket) {
  const { limited, slots } = computeSlots(useBrackets, quotaRows, usageRows);
  if (!limited) return { ok: true };
  const b = useBrackets ? bracket : "";
  const slot = slots.find((s) => s.gender === gender && s.ageBracket === b);
  if (!slot || slot.max === 0) return { ok: false, code: "NOT_WANTED", message: `${label(gender, b)} مش مطلوبين في المهمة دي.` };
  if (slot.full) return { ok: false, code: "QUOTA_FULL", message: `تم الاكتفاء من ${label(gender, b)} في المهمة دي.`, slot };
  return { ok: true, slot };
}

/** An edit may not drop a slot below the number of people already in it (and may not remove a used slot). */
function validateEdit(useBrackets, newRows, usageRows) {
  const next = new Map(newRows.map((r) => [`${r.gender}|${r.ageBracket}`, r.max]));
  const used = new Map();
  for (const u of usageRows) {
    const key = `${u.gender}|${useBrackets ? u.age_bracket : ""}`;
    used.set(key, (used.get(key) || 0) + Number(u.used));
  }
  for (const [key, n] of used) {
    if (n <= 0) continue;
    const [gender, bracket] = key.split("|");
    if (!newRows.length) continue;                                  // removing every limit is always fine
    const max = next.has(key) ? next.get(key) : 0;
    if (max < n) throw httpError(409, `مينفعش تخلّي ${label(gender, bracket)} أقل من ${n} (العدد المسجّل حالياً).`);
  }
}

const fromDb = (r) => ({ gender: r.gender, ageBracket: r.age_bracket, max: r.max_count });

async function loadQuotaRows(db, taskIds) {
  const out = new Map(taskIds.map((id) => [id, []]));
  if (!taskIds.length) return out;
  const r = await db.query(`SELECT task_id, gender, age_bracket, max_count FROM studio_task_quotas WHERE task_id = ANY($1::uuid[]) ORDER BY gender, age_bracket`, [taskIds]);
  for (const row of r.rows) out.get(row.task_id).push(fromDb(row));
  return out;
}
async function loadUsage(db, taskIds) {
  const out = new Map(taskIds.map((id) => [id, []]));
  if (!taskIds.length) return out;
  const r = await db.query(
    `SELECT task_id, gender, age_bracket, COUNT(*)::int AS used FROM recording_sessions
     WHERE task_id = ANY($1::uuid[]) AND status <> 'expired' GROUP BY task_id, gender, age_bracket`, [taskIds]);
  for (const row of r.rows) out.get(row.task_id).push(row);
  return out;
}

/** Adds { limited, slots } to each task row (tasks must carry use_age_brackets). */
async function attachSlots(db, tasks) {
  const ids = tasks.map((t) => t.id);
  const [quotas, usage] = await Promise.all([loadQuotaRows(db, ids), loadUsage(db, ids)]);
  return tasks.map((t) => ({ ...t, ...computeSlots(!!t.use_age_brackets, quotas.get(t.id), usage.get(t.id)) }));
}

/** Replaces all quota rows of a task (call inside a transaction). */
async function replaceQuotas(client, taskId, rows) {
  await client.query(`DELETE FROM studio_task_quotas WHERE task_id = $1`, [taskId]);
  for (const r of rows) {
    await client.query(`INSERT INTO studio_task_quotas (task_id, gender, age_bracket, max_count) VALUES ($1, $2, $3, $4)`, [taskId, r.gender, r.ageBracket, r.max]);
  }
}

// ======================================================================================
// v4 — a quota PER LEADER (additive: a task without rows in studio_task_leader_quotas behaves exactly as before).
//
// Per-leader rows say "leader X wants N boys and M girls (per age bracket when the task uses them)". The task-level
// quota (studio_task_quotas) is kept equal to the SUM of those rows, so everything that already reads the task-level
// quota — the places left on the task list, the head leader's totals — stays correct. A join is checked against BOTH.
// ======================================================================================
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates what the dashboard sends: [{ leaderId, quotas: [{ gender, ageBracket?, max }] }].
 * Returns flat rows [{ leaderId, gender, ageBracket, max }]. Every leader must be one of allowedLeaderIds.
 * Returns [] when nothing is limited (every box 0 / nothing sent) = "no per-leader limit".
 */
function normalizeLeaderQuotas(input, useBrackets, allowedLeaderIds) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw httpError(400, "صيغة حصص الليدرز غير صحيحة");
  const allowed = new Set((allowedLeaderIds || []).map(String));
  const seen = new Set(), out = [];
  for (const entry of input) {
    const leaderId = String((entry && entry.leaderId) || "");
    if (!UUID_RE.test(leaderId)) throw httpError(400, "ليدر غير صحيح في حصص الليدرز");
    if (!allowed.has(leaderId)) throw httpError(400, "فيه ليدر في الحصص مش من ليدرز المهمة");
    if (seen.has(leaderId)) throw httpError(400, "ليدر اتكرر في الحصص");
    seen.add(leaderId);
    for (const q of normalizeQuotas(entry.quotas, useBrackets)) out.push({ leaderId, gender: q.gender, ageBracket: q.ageBracket, max: q.max });
  }
  return out.some((r) => r.max > 0) ? out : [];
}

/** The task-level quota that matches a set of per-leader rows: the sum per (gender, age bracket). */
function sumLeaderQuotas(leaderRows) {
  const sums = new Map();
  for (const r of leaderRows) {
    const key = `${r.gender}|${r.ageBracket}`;
    sums.set(key, (sums.get(key) || 0) + r.max);
  }
  return [...sums.entries()].map(([key, max]) => { const [gender, ageBracket] = key.split("|"); return { gender, ageBracket, max }; });
}

// True once migration_studio_v4.sql has been run. Until then every per-leader loader answers "no per-leader quota",
// so deploying the code before the migration can never break a join or a listing.
let leaderQuotasTableReady = false;
async function leaderQuotasReady(db) {
  if (leaderQuotasTableReady) return true;
  const r = await db.query(`SELECT to_regclass('studio_task_leader_quotas') IS NOT NULL AS ok`);
  if (r.rows[0].ok) leaderQuotasTableReady = true;
  return !!r.rows[0].ok;
}

/** Per-leader rows of one task: [{ leaderId, gender, ageBracket, max }] */
async function loadLeaderQuotaRows(db, taskId) {
  if (!(await leaderQuotasReady(db))) return [];
  const r = await db.query(
    `SELECT leader_id, gender, age_bracket, max_count FROM studio_task_leader_quotas WHERE task_id = $1 ORDER BY leader_id, gender, age_bracket`, [taskId]);
  return r.rows.map((x) => ({ leaderId: x.leader_id, gender: x.gender, ageBracket: x.age_bracket, max: x.max_count }));
}

/** Live usage per leader: [{ leader_id, gender, age_bracket, used }] (withdrawn / expired sessions do not count). */
async function loadLeaderUsage(db, taskId) {
  const r = await db.query(
    `SELECT leader_id, gender, age_bracket, COUNT(*)::int AS used FROM recording_sessions
     WHERE task_id = $1 AND status <> 'expired' GROUP BY leader_id, gender, age_bracket`, [taskId]);
  return r.rows;
}

/** { [leaderId]: { limited:true, slots:[{gender, ageBracket, max, used, remaining, full}] } } — empty when the task has no per-leader quota. */
function computeLeaderSlots(useBrackets, leaderRows, usageRows) {
  const out = {};
  if (!leaderRows.length) return out;
  const byLeader = new Map();
  for (const r of leaderRows) { if (!byLeader.has(r.leaderId)) byLeader.set(r.leaderId, []); byLeader.get(r.leaderId).push(r); }
  for (const [leaderId, rows] of byLeader) {
    out[leaderId] = computeSlots(useBrackets, rows, usageRows.filter((u) => u.leader_id === leaderId));
  }
  return out;
}

/**
 * Can this person still join under THIS leader? Only meaningful when the task has per-leader rows.
 * A leader with no row for the chosen gender / bracket is closed.
 */
function checkJoinLeader(useBrackets, leaderRows, usageRows, leaderId, gender, bracket) {
  if (!leaderRows.length) return { ok: true };                              // task without per-leader quota: nothing to check
  const mine = leaderRows.filter((r) => r.leaderId === leaderId);
  const b = useBrackets ? bracket : "";
  const slot = mine.find((r) => r.gender === gender && r.ageBracket === b);
  if (!slot || slot.max === 0) return { ok: false, code: "NOT_WANTED", message: `${label(gender, b)} مش مطلوبين مع الليدر ده في المهمة دي.` };
  const used = usageRows.filter((u) => u.leader_id === leaderId && u.gender === gender && (useBrackets ? u.age_bracket === b : true))
    .reduce((n, u) => n + Number(u.used), 0);
  if (used >= slot.max) return { ok: false, code: "QUOTA_FULL", message: `تم الاكتفاء من ${label(gender, b)} مع الليدر ده في المهمة دي.` };
  return { ok: true };
}

/** An edit may not drop a leader's slot below the people already under him (and may not remove a used slot). */
function validateLeaderEdit(useBrackets, newRows, usageRows, leaderNames = new Map()) {
  const next = new Map(newRows.map((r) => [`${r.leaderId}|${r.gender}|${r.ageBracket}`, r.max]));
  const used = new Map();
  for (const u of usageRows) {
    const key = `${u.leader_id}|${u.gender}|${useBrackets ? u.age_bracket : ""}`;
    used.set(key, (used.get(key) || 0) + Number(u.used));
  }
  for (const [key, n] of used) {
    if (n <= 0) continue;
    const [leaderId, gender, bracket] = key.split("|");
    const max = next.has(key) ? next.get(key) : 0;
    if (max < n) {
      const who = leaderNames.get(leaderId) || "الليدر";
      throw httpError(409, `مينفعش تخلّي ${label(gender, bracket)} مع ${who} أقل من ${n} (العدد المسجّل حالياً).`);
    }
  }
}

/** Replaces every per-leader row of a task (call inside a transaction). An empty list removes the per-leader quota. */
async function replaceLeaderQuotas(client, taskId, rows) {
  await client.query(`DELETE FROM studio_task_leader_quotas WHERE task_id = $1`, [taskId]);
  for (const r of rows) {
    await client.query(
      `INSERT INTO studio_task_leader_quotas (task_id, leader_id, gender, age_bracket, max_count) VALUES ($1, $2, $3, $4, $5)`,
      [taskId, r.leaderId, r.gender, r.ageBracket, r.max]);
  }
}

module.exports = {
  GENDERS, BRACKETS, normalizeQuotas, computeSlots, checkJoin, validateEdit, loadQuotaRows, loadUsage, attachSlots, replaceQuotas, label,
  normalizeLeaderQuotas, sumLeaderQuotas, loadLeaderQuotaRows, loadLeaderUsage, computeLeaderSlots, checkJoinLeader, validateLeaderEdit, replaceLeaderQuotas,
};
