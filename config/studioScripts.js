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
const Lock = require("./studioTaskLock");
const GENDERS = Quota.GENDERS, BRACKETS = Quota.BRACKETS;

function httpError(status, message, code) {
  const e = new Error(message); e.statusCode = status; if (code) e.code = code; return e;
}

const isPerPerson = (t) => t.script_mode === "per_person";
const isCodes = (t) => t.identity_mode === "codes";
/** v8: files carry the talent's real (English) name — nothing to pick, no list to run out of. */
const isReal = (t) => t.identity_mode === "real";
const BR = Quota.BRACKETS;
/** What is stored for one gender: a plain array (all ages) or { child, adult, elderly } (split by age group). */
const rawCodes = (t, gender) => (t.identity_codes && t.identity_codes[gender]) || [];
const isSplit = (t, gender) => { const v = rawCodes(t, gender); return !!v && !Array.isArray(v) && typeof v === "object"; };
/** Codes of one gender. With a bracket: only that age group's (plain lists are for every age group). Without: all of them. */
function codeList(t, gender, bracket) {
  const v = rawCodes(t, gender);
  if (Array.isArray(v)) return v.map(String);
  if (!v || typeof v !== "object") return [];
  if (bracket) return (v[bracket] || []).map(String);
  return BR.flatMap((b) => (v[b] || []).map(String));
}
/** { child:[..], adult:[..], elderly:[..] } of a split gender (empty arrays for the missing ones). */
const codeLists = (t, gender) => Object.fromEntries(BR.map((b) => [b, codeList(t, gender, b)]));
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
    db.query(`SELECT task_id, gender, COUNT(*)::int AS n FROM studio_task_scripts WHERE task_id = ANY($1::uuid[]) GROUP BY task_id, gender`, [ids]),
    db.query(`SELECT s.task_id, s.gender, COUNT(DISTINCT rs.script_id)::int AS n
              FROM recording_sessions rs JOIN studio_task_scripts s ON s.id = rs.script_id
              WHERE rs.task_id = ANY($1::uuid[]) AND rs.status <> 'expired' GROUP BY s.task_id, s.gender`, [ids]),
    db.query(`SELECT task_id, gender, fake_name FROM recording_sessions WHERE task_id = ANY($1::uuid[]) AND status <> 'expired'`, [ids]),
  ]);
  const blank = () => ({ male: 0, female: 0, any: 0 });
  for (const t of limited) out.set(t.id, { scriptsTotal: 0, scriptsUsed: 0, scTotal: blank(), scUsed: blank(), taken: { male: new Set(), female: new Set() } });
  for (const r of total.rows) { const i = out.get(r.task_id); i.scTotal[r.gender || "any"] += r.n; i.scriptsTotal += r.n; }
  for (const r of used.rows) { const i = out.get(r.task_id); i.scUsed[r.gender || "any"] += r.n; i.scriptsUsed += r.n; }
  for (const r of names.rows) out.get(r.task_id).taken[r.gender].add(r.fake_name);
  return out;
}

/** Scripts a talent of this gender can still get: the ones reserved for his gender + the ones for anybody. */
function scriptSupply(inp, g) {
  const own = inp.scTotal[g] - inp.scUsed[g], any = inp.scTotal.any - inp.scUsed.any;
  return { total: inp.scTotal[g] + inp.scTotal.any, left: Math.max(0, own) + Math.max(0, any) };
}

/**
 * { male: {total, left, brackets?}, female: ... } — null = this task puts no limit on that gender.
 * brackets = { child:{total,left}, adult:.., elderly:.. } only when that gender's codes are split by age group.
 */
function computeSupply(task, inp) {
  if (!hasSupplyLimits(task) || !inp) return { male: null, female: null };
  const out = {};
  for (const g of GENDERS) {
    const sc = isPerPerson(task) ? scriptSupply(inp, g) : null;
    const cut = (a) => (sc ? { total: Math.min(a.total, sc.total), left: Math.min(a.left, sc.left) } : a);
    if (!isCodes(task)) { out[g] = { total: sc.total, left: sc.left }; continue; }
    const free = (list) => list.filter((c) => !inp.taken[g].has(c)).length;
    if (isSplit(task, g)) {
      const brackets = {};
      let total = 0, left = 0;
      for (const b of BR) { const l = codeList(task, g, b); brackets[b] = cut({ total: l.length, left: free(l) }); total += l.length; left += free(l); }
      out[g] = { ...cut({ total, left }), brackets };
    } else {
      const l = codeList(task, g);
      out[g] = cut({ total: l.length, left: free(l) });
    }
  }
  return out;
}

/** Adds scripts/codes limits to the { limited, slots } the quota code produced. */
function applySupply(task, supply) {
  if (!supply || (!supply.male && !supply.female)) return task;
  let slots;
  if (task.limited) {
    slots = task.slots.map((s) => {
      const g = supply[s.gender]; if (!g) return s;
      const cap = (s.ageBracket && g.brackets && g.brackets[s.ageBracket]) || g;
      const remaining = Math.min(s.remaining, cap.left);
      return { ...s, remaining, full: s.full || remaining <= 0 };
    });
  } else {
    // no quota rows: the scripts / codes ARE the limit
    const brackets = task.use_age_brackets ? BRACKETS : [""];
    slots = [];
    for (const g of GENDERS) {
      const gcap = supply[g]; if (!gcap) continue;
      for (const b of brackets) {
        const cap = (b && gcap.brackets && gcap.brackets[b]) || gcap;
        slots.push({ gender: g, ageBracket: b, max: cap.total, used: Math.max(0, cap.total - cap.left), remaining: cap.left, full: cap.left <= 0, synthetic: true });   // synthetic = not a quota the head leader typed
      }
    }
  }
  return { ...task, limited: true, slots, supply };
}

/** Quota.attachSlots + the scripts / codes limits. Use this wherever a task is shown to a talent or the head leader. */
async function attachSlots(db, tasks) {
  const withQuota = await Quota.attachSlots(db, tasks);
  const inputs = await loadSupplyInputs(db, withQuota);
  const built = withQuota.map((t) => {
    const sup = computeSupply(t, inputs.get(t.id));
    const x = applySupply(t, sup);
    if (!hasSupplyLimits(t)) return x;
    const inp = inputs.get(t.id);
    const leftOf = (g) => (sup[g] ? Math.max(0, codeList(t, g).filter((c) => !inp.taken[g].has(c)).length) : null);
    const byBracket = (g) => (isCodes(t) && isSplit(t, g)
      ? Object.fromEntries(BR.map((b) => { const l = codeList(t, g, b); return [b, { total: l.length, left: l.filter((c) => !inp.taken[g].has(c)).length }]; }))
      : null);
    return { ...x, scripts_total: inp.scriptsTotal, scripts_left: Math.max(0, inp.scriptsTotal - inp.scriptsUsed),
      // v9: scripts split by gender — what is reserved for boys / girls / anybody, and how many of each are still free
      scripts_by_gender: { male: { total: inp.scTotal.male, left: Math.max(0, inp.scTotal.male - inp.scUsed.male) },
                           female: { total: inp.scTotal.female, left: Math.max(0, inp.scTotal.female - inp.scUsed.female) },
                           any: { total: inp.scTotal.any, left: Math.max(0, inp.scTotal.any - inp.scUsed.any) } },
      codes_total: { male: codeList(t, "male").length, female: codeList(t, "female").length },
      codes_left: { male: leftOf("male"), female: leftOf("female") },
      // v9: only for the genders whose codes were uploaded split by age group: { child:{total,left}, adult:.., elderly:.. }
      codes_by_bracket: { male: byBracket("male"), female: byBracket("female") } };
  });
  // v10: the password hash never leaves the server — the row carries only password_protected (true / false)
  return built.map(Lock.expose);
}

/** Names / codes a talent of this gender (and age group, for codes split by age group) may still pick. */
async function availableNames(db, task, gender, bracket) {
  const taken = new Set((await db.query(`SELECT fake_name FROM recording_sessions WHERE task_id = $1 AND status <> 'expired'`, [task.id])).rows.map((r) => r.fake_name));
  if (isReal(task)) return [];
  let all;
  if (!isCodes(task)) all = task.fake_names || [];
  else if (!GENDERS.includes(gender)) all = [];
  else if (isSplit(task, gender) && !BR.includes(bracket)) all = [];       // split by age group: the age group is needed
  else all = codeList(task, gender, bracket);
  return all.filter((n) => !taken.has(n));
}

const nameIsAllowed = (task, gender, name, bracket) => (isCodes(task)
  ? (isSplit(task, gender) && !BR.includes(bracket) ? [] : codeList(task, gender, bracket))
  : (task.fake_names || [])).includes(name);

/**
 * Real-name tasks: the name the files will carry. Two talents can share a name ("Ahmed Ali"), but a live session's
 * name is unique inside a task, so the second one becomes "Ahmed Ali 2", the third "Ahmed Ali 3"...
 * Call it inside the session-start transaction (task row locked), so two talents never get the same one.
 */
async function realFileName(db, taskId, base) {
  const taken = new Set((await db.query(
    `SELECT fake_name FROM recording_sessions WHERE task_id = $1 AND status <> 'expired'`, [taskId])).rows.map((r) => r.fake_name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/**
 * Inside the session-start transaction (the task row is already locked FOR UPDATE):
 * returns the script this talent gets (null for shared-script tasks), or throws 409 when none is left.
 * v9: only a script reserved for his gender, or one reserved for nobody, can go to him — the ones reserved for his
 * gender first, so the "anybody" scripts stay free for whoever runs out.
 */
async function allocateScript(client, task, gender) {
  if (!isPerPerson(task)) return null;
  const r = await client.query(
    `SELECT s.id FROM studio_task_scripts s
     WHERE s.task_id = $1
       AND (s.gender IS NULL OR s.gender = $2)
       AND NOT EXISTS (SELECT 1 FROM recording_sessions rs WHERE rs.script_id = s.id AND rs.status <> 'expired')
     ORDER BY (s.gender IS NULL), s.position LIMIT 1`, [task.id, GENDERS.includes(gender) ? gender : null]);
  if (!r.rows.length) throw httpError(409, "تم الاكتفاء في المهمة دي — مفيش سكريبتات متاحة.", "QUOTA_FULL");
  return r.rows[0].id;
}

/** Natural sort so script2.txt comes before script10.txt. */
const byName = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });

module.exports = {
  isPerPerson, isCodes, isReal, realFileName, codeList, codeLists, isSplit, hasSupplyLimits, samplesOfSession, attachSlots, computeSupply, applySupply,
  availableNames, nameIsAllowed, allocateScript, byName, httpError,
};
