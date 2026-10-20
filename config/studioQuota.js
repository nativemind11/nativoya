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

module.exports = { GENDERS, BRACKETS, normalizeQuotas, computeSlots, checkJoin, validateEdit, loadQuotaRows, loadUsage, attachSlots, replaceQuotas, label };
