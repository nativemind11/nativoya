/**
 * Per-person scripts, uploaded codes and "direct" tasks (Studio v3).
 *
 * Supply = how many more talents can still join a task because of its scripts and codes:
 *   - per_person tasks: one script per talent  -> scripts left
 *   - codes tasks:      one code per talent    -> codes of that gender left
 * A task's real "places left" for a gender is min(quota left, codes left, scripts left).
 * Scripts are shared between genders (any free script can go to a boy or a girl); codes are per gender.
 * A talent holds a script / code until the session is withdrawn (status 'expired'), like a quota place.
 */
const Quota = require("./studioQuota");
const GENDERS = Quota.GENDERS, BRACKETS = Quota.BRACKETS;

function httpError(status, message, code) {
  const e = new Error(message); e.statusCode = status; if (code) e.code = code; return e;
}

const isPerPerson = (t) => t.script_mode === "per_person";
const isCodes = (t) => t.identity_mode === "codes";
const codeList = (t, gender) => ((t.identity_codes && t.identity_codes[gender]) || []).map(String);
const hasSupplyLimits = (t) => isPerPerson(t) || isCodes(t);

/** SQL: the sentences one session has to record (its own script, or the shared one). $1 = task id, $2 = session script id (or null). */
const SESSION_SAMPLES_WHERE = `task_id = $1 AND script_id IS NOT DISTINCT FROM $2`;
async function samplesOfSession(db, taskId, scriptId, orderBy = "order_index") {
  return (await db.query(`SELECT * FROM recording_samples WHERE ${SESSION_SAMPLES_WHERE} ORDER BY ${orderBy}`, [taskId, scriptId || null])).rows;
}

/** Loads what is needed to compute supply for these tasks (only the tasks that have limits). */
async function loadSupplyInputs(db, tasks) {
  const limited = tasks.filter(hasSupplyLimits);
  const out = new Map();
  if (!limited.length) return out;
  const ids = limited.map((t) => t.id);
  const [total, used, names] = await Promise.all([
    db.query(`SELECT task_id, COUNT(*)::int AS n FROM studio_task_scripts WHERE task_id = ANY($1::uuid[]) GROUP BY task_id`, [ids]),
    db.query(`SELECT task_id, COUNT(DISTINCT script_id)::int AS n FROM recording_sessions
              WHERE task_id = ANY($1::uuid[]) AND status <> 'expired' AND script_id IS NOT NULL GROUP BY task_id`, [ids]),
    db.query(`SELECT task_id, gender, fake_name FROM recording_sessions WHERE task_id = ANY($1::uuid[]) AND status <> 'expired'`, [ids]),
  ]);
  for (const t of limited) out.set(t.id, { scriptsTotal: 0, scriptsUsed: 0, taken: { male: new Set(), female: new Set() } });
  for (const r of total.rows) out.get(r.task_id).scriptsTotal = r.n;
  for (const r of used.rows) out.get(r.task_id).scriptsUsed = r.n;
  for (const r of names.rows) out.get(r.task_id).taken[r.gender].add(r.fake_name);
  return out;
}

/** { male: {total, left}|null, female: ... } — null = this task puts no limit on that gender. */
function computeSupply(task, inp) {
  if (!hasSupplyLimits(task) || !inp) return { male: null, female: null };
  const out = {};
  for (const g of GENDERS) {
    const totals = [], lefts = [];
    if (isPerPerson(task)) { totals.push(inp.scriptsTotal); lefts.push(Math.max(0, inp.scriptsTotal - inp.scriptsUsed)); }
    if (isCodes(task)) {
      const list = codeList(task, g);
      totals.push(list.length); lefts.push(list.filter((c) => !inp.taken[g].has(c)).length);
    }
    out[g] = { total: Math.min(...totals), left: Math.min(...lefts) };
  }
  return out;
}

/** Adds scripts/codes limits to the { limited, slots } the quota code produced. */
function applySupply(task, supply) {
  if (!supply || (!supply.male && !supply.female)) return task;
  let slots;
  if (task.limited) {
    slots = task.slots.map((s) => {
      const cap = supply[s.gender]; if (!cap) return s;
      const remaining = Math.min(s.remaining, cap.left);
      return { ...s, remaining, full: s.full || remaining <= 0 };
    });
  } else {
    // no quota rows: the scripts / codes ARE the limit
    const brackets = task.use_age_brackets ? BRACKETS : [""];
    slots = [];
    for (const g of GENDERS) {
      const cap = supply[g]; if (!cap) continue;
      for (const b of brackets) slots.push({ gender: g, ageBracket: b, max: cap.total, used: Math.max(0, cap.total - cap.left), remaining: cap.left, full: cap.left <= 0, synthetic: true });   // synthetic = not a quota the head leader typed
    }
  }
  return { ...task, limited: true, slots, supply };
}

/** Quota.attachSlots + the scripts / codes limits. Use this wherever a task is shown to a talent or the head leader. */
async function attachSlots(db, tasks) {
  const withQuota = await Quota.attachSlots(db, tasks);
  const inputs = await loadSupplyInputs(db, withQuota);
  return withQuota.map((t) => {
    const sup = computeSupply(t, inputs.get(t.id));
    const x = applySupply(t, sup);
    if (!hasSupplyLimits(t)) return x;
    const inp = inputs.get(t.id);
    return { ...x, scripts_total: inp.scriptsTotal, scripts_left: Math.max(0, inp.scriptsTotal - inp.scriptsUsed),
      codes_total: { male: codeList(t, "male").length, female: codeList(t, "female").length },
      codes_left: { male: sup.male ? Math.max(0, codeList(t, "male").filter((c) => !inp.taken.male.has(c)).length) : null,
                    female: sup.female ? Math.max(0, codeList(t, "female").filter((c) => !inp.taken.female.has(c)).length) : null } };
  });
}

/** Names / codes a talent of this gender may still pick. */
async function availableNames(db, task, gender) {
  const taken = new Set((await db.query(`SELECT fake_name FROM recording_sessions WHERE task_id = $1 AND status <> 'expired'`, [task.id])).rows.map((r) => r.fake_name));
  const all = isCodes(task) ? (GENDERS.includes(gender) ? codeList(task, gender) : []) : (task.fake_names || []);
  return all.filter((n) => !taken.has(n));
}

const nameIsAllowed = (task, gender, name) => (isCodes(task) ? codeList(task, gender) : (task.fake_names || [])).includes(name);

/**
 * Inside the session-start transaction (the task row is already locked FOR UPDATE):
 * returns the script this talent gets (null for shared-script tasks), or throws 409 when none is left.
 */
async function allocateScript(client, task) {
  if (!isPerPerson(task)) return null;
  const r = await client.query(
    `SELECT s.id FROM studio_task_scripts s
     WHERE s.task_id = $1
       AND NOT EXISTS (SELECT 1 FROM recording_sessions rs WHERE rs.script_id = s.id AND rs.status <> 'expired')
     ORDER BY s.position LIMIT 1`, [task.id]);
  if (!r.rows.length) throw httpError(409, "تم الاكتفاء في المهمة دي — مفيش سكريبتات متاحة.", "QUOTA_FULL");
  return r.rows[0].id;
}

/** Natural sort so script2.txt comes before script10.txt. */
const byName = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });

module.exports = {
  isPerPerson, isCodes, codeList, hasSupplyLimits, samplesOfSession, attachSlots, computeSupply, applySupply,
  availableNames, nameIsAllowed, allocateScript, byName, httpError,
};
