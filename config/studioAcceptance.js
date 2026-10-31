/**
 * "القبول من الشركة" — the company's ACCEPTANCE file.
 *
 * The company sends back a sheet with the people whose work it ACCEPTED. The head leader uploads it per task; it goes through
 * the same steps as the feedback page (parse -> preview with name matching -> apply), and every matched person gets an
 * "accepted by the company" mark that his talent account and his leader's account show.
 *
 * It matches the NAME the company knows the person by, which is what the session stores in `fake_name` in all three kinds of task:
 *   names  : the fake name        ("Marie Louise")
 *   codes  : the code the head leader uploaded ("M-014")  -> matched exactly, never "by first name"
 *   real   : the talent's real (English) name ("Ahmed Ali", "Ahmed Ali 2")
 * Only people whose work really reached the company (a delivered batch) can be accepted, exactly like feedback.
 * Nothing in the recording / QA / delivery / feedback flows is changed by an acceptance: it is a mark on the side.
 */
const F = require("./studioFeedback");
const M = require("./studioFeedbackMatch");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function httpError(status, message, code) { const e = new Error(message); e.statusCode = status; if (code) e.code = code; return e; }

// ---------------------------------------------------------------- readiness (so deploying before the migration breaks nothing)
let ready = false;
async function acceptanceReady(db) {
  if (ready) return true;
  const r = await db.query(`SELECT to_regclass('studio_acceptances') IS NOT NULL AND to_regclass('studio_acceptance_files') IS NOT NULL AS ok`);
  if (r.rows[0].ok) ready = true;
  return ready;
}
const _resetReadyForTests = () => { ready = false; };

const MESSAGES = {
  no_label: "لا يوجد اسم في هذا الصف.",
  not_zip: "الاسم ليس بصيغة ملف ZIP (fake_name-gender-age_bracket-age.zip).",
  no_session: "لا يوجد متسجّل بهذا الاسم في هذه المهمة.",
  ambiguous: "هذا الاسم سُحب من متسجّل وأُعطي لآخر، ولا يمكن تحديد المقصود. اختر المتسجّل يدويًا.",
  expired: "سُحب الاسم من هذا المتسجّل (انتهت مهلته) — لا يمكن قبوله.",
  not_delivered: "لم يُسلَّم للشركة بعد.",
  manual_name_invalid: "الاختيار اليدوي لهذا الاسم لا يتبع هذه المهمة.",
  name_excluded: "تم إلغاء مطابقة هذا الاسم (ليس هو) — اختر المتسجّل الصحيح.",
};

/** Reads the acceptance sheet's columns with the same extractor the feedback page uses: one label per row; an optional status column keeps only the "accepted" values. */
function extractAcceptRows(sheet, { headerRow, labelCol, statusCol = -1, acceptValues = [] }) {
  return F.extractRows(sheet, { headerRow, labelCol, numbersCol: -1, descCol: -1, numbersMode: "row_order", statusCol, rejectValues: acceptValues });
}

// ------------------------------------------------------------------ resolve (writes nothing)
async function resolveAcceptance({ db, taskId, headLeaderId, labelType, rows, startRow = 2, rowNos = null, meta = null }) {
  const task = (await db.query(`SELECT id, title, status, identity_mode FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`, [taskId, headLeaderId])).rows[0];
  if (!task) throw httpError(404, "المهمة غير موجودة");
  const sess = await db.query(
    `SELECT rs.id, rs.fake_name, rs.status, rs.gender, rs.age_bracket, rs.age, rs.leader_id, l.leader_code, l.name AS leader_name,
            tal.name AS real_name, tal.email, a.accepted_at,
            (EXISTS (SELECT 1 FROM studio_delivery_batch_sessions bs JOIN studio_delivery_batches db2 ON db2.id = bs.batch_id
                     WHERE bs.session_id = rs.id AND db2.status = 'delivered')
             OR EXISTS (SELECT 1 FROM studio_feedback_items f0 WHERE f0.session_id = rs.id)) AS delivered,
            EXISTS (SELECT 1 FROM studio_feedback_items f1 WHERE f1.session_id = rs.id AND f1.status IN ('pending', 'acknowledged')) AS open_feedback
     FROM recording_sessions rs
     JOIN studio_leaders l ON l.id = rs.leader_id
     LEFT JOIN studio_talents tal ON tal.id = rs.talent_id
     LEFT JOIN studio_acceptances a ON a.session_id = rs.id
     WHERE rs.task_id = $1`, [taskId]);

  const byName = new Map();
  for (const r of sess.rows) { const k = F.normKeyOf(r.fake_name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(r); }
  const smart = labelType === "smart";
  const strict = task.identity_mode === "codes";                // a code is an exact code: never guessed from "the first part"
  const nameIndex = smart ? M.buildNameIndex(sess.rows) : null;
  const sessById = new Map(sess.rows.map((r) => [r.id, r]));
  const nameMap = (meta && meta.nameMap) || {};
  const alive = (r) => r.status !== "expired";
  const eligible = (r) => alive(r) && !!r.delivered;
  const notDelivered = (r) => !!r && alive(r) && !r.delivered;
  const nameInfo = new Map();
  const noteName = (label, session, how, conflict) => {
    const k = String(label).trim();
    let e = nameInfo.get(k);
    if (!e) {
      const pending = notDelivered(session);
      e = { label: k, rows: 0, sessionId: session && !pending ? session.id : null, how: session && !pending ? how : null, conflict: pending ? null : (conflict || null) };
      if (pending) e.notDelivered = { fakeName: session.fake_name, status: session.status };
      nameInfo.set(k, e);
    }
    e.rows++;
  };
  const pickSession = (list, attrs) => {
    if (list.length === 1) return { session: list[0] };
    if (attrs) {
      const hit = list.filter((c) => c.gender === attrs.gender && c.age_bracket === attrs.bracket && String(c.age == null ? "na" : c.age) === attrs.age);
      if (hit.length === 1) return { session: hit[0] };
    }
    return { ambiguous: true };
  };
  const sug = (list) => list.map((x) => ({ id: x.id, fakeName: x.fake_name, gender: x.gender, ageBracket: x.age_bracket, age: x.age }));

  const results = rows.map((cells, i) => {
    const [labelRaw] = cells;
    const base = { row: rowNos ? rowNos[i] : startRow + i, label: labelRaw, ok: false };
    if (!labelRaw) return { ...base, skipped: true };
    let session;
    const forcedId = nameMap[F.normKeyOf(labelRaw)];
    if (forcedId === "none") {
      if (smart) { noteName(labelRaw, null); nameInfo.get(String(labelRaw).trim()).excluded = true; }
      return { ...base, code: "name_excluded", message: MESSAGES.name_excluded, unmatchedName: true, suggestions: smart ? sug(nameIndex.suggest(labelRaw, 5, eligible)) : [] };
    }
    if (forcedId) {
      session = sessById.get(forcedId);
      if (!session) return { ...base, code: "manual_name_invalid", message: MESSAGES.manual_name_invalid };
      base.viaManual = true;
      if (smart) noteName(labelRaw, session, "manual", null);
    } else if (smart) {
      const found = nameIndex.find(labelRaw, strict ? { strict: true } : undefined);
      if (!found.list.length) {
        noteName(labelRaw, null);
        return { ...base, code: "no_session", message: MESSAGES.no_session, unmatchedName: true, suggestions: sug(nameIndex.suggest(labelRaw, 5, eligible)) };
      }
      session = M.pickByExtras(found.list, found.extras);
      if (!session) {
        noteName(labelRaw, null);
        return { ...base, code: "ambiguous", message: MESSAGES.ambiguous, unmatchedName: true, suggestions: sug(found.list.filter(eligible)) };
      }
      const how = found.list.length > 1 ? "extras" : found.how;
      const bad = M.nameConflicts(found.extras, session);
      noteName(labelRaw, session, how, bad.length ? { fields: bad, file: found.extras } : null);
    } else {
      const lab = F.parseLabel(labelRaw, labelType);
      if (lab.error === "not_zip") return { ...base, code: "not_zip", message: MESSAGES.not_zip };
      if (lab.error) return { ...base, code: "no_label", message: MESSAGES.no_label };
      const candidates = byName.get(F.normKeyOf(lab.fakeName));
      if (!candidates) return { ...base, code: "no_session", message: MESSAGES.no_session };
      const picked = pickSession(candidates, F.parseZipAttrs(labelRaw));
      if (picked.ambiguous) return { ...base, code: "ambiguous", message: MESSAGES.ambiguous };
      session = picked.session;
    }
    base.fakeName = session.fake_name;
    const info = {
      id: session.id, fakeName: session.fake_name, realName: session.real_name, email: session.email,
      leaderCode: session.leader_code, leaderName: session.leader_name, status: session.status,
      gender: session.gender, ageBracket: session.age_bracket, age: session.age,
    };
    base.session = info;
    if (!alive(session)) return { ...base, code: "expired", message: MESSAGES.expired };
    if (!session.delivered) return { ...base, code: "not_delivered", message: MESSAGES.not_delivered, unmatchedName: true, notDelivered: true };
    return { ...base, ok: true, already: !!session.accepted_at, openFeedback: !!session.open_feedback };
  });

  const visible = results.filter((r) => !r.skipped);
  const okRows = visible.filter((r) => r.ok);
  const okPeople = new Map(okRows.map((r) => [r.session.id, r]));
  const alreadyPeople = [...okPeople.values()].filter((r) => r.already).length;
  const warnings = [];
  const openFb = [...okPeople.values()].filter((r) => r.openFeedback);
  if (openFb.length) {
    warnings.push({ code: "open_feedback", count: openFb.length,
      message: `${openFb.length} متسجّل لديهم فيدباك مفتوح (بانتظار إعادة التسجيل): ${openFb.slice(0, 4).map((r) => r.session.fakeName).join(", ")}${openFb.length > 4 ? "…" : ""}. سيتم تسجيلهم كمقبولين أيضًا — تأكد أن الشركة قبلتهم فعلًا.` });
  }
  if (visible.length >= 5 && okRows.length / visible.length < 0.5) {
    warnings.push({ code: "low_match", count: visible.length - okRows.length,
      message: `تطابق أقل من نصف صفوف الملف مع متسجّلين (${okRows.length} من ${visible.length}). تأكد من اختيار عمود الاسم الصحيح وأن هذا هو ملف المهمة المطلوبة.` });
  }
  const people = smart
    ? sess.rows.filter(eligible).slice(0, 3000)
        .map((r) => ({ id: r.id, fakeName: r.fake_name, gender: r.gender, ageBracket: r.age_bracket, age: r.age, status: r.status, accepted: !!r.accepted_at }))
        .sort((x, y) => String(x.fakeName).localeCompare(String(y.fakeName)))
    : undefined;
  const rank = (e) => (!e.sessionId ? 0 : e.how === "extras" || e.conflict ? 1 : 2);
  const names = smart
    ? [...nameInfo.values()].map((e) => ({
        ...e, suggestions: nameIndex.suggest(e.label, 5, eligible).map((x) => x.id),
        person: e.sessionId ? (() => { const x = sessById.get(e.sessionId); return { gender: x.gender, ageBracket: x.age_bracket, age: x.age, status: x.status }; })() : null,
      })).sort((x, y) => rank(x) - rank(y))
    : undefined;
  return {
    task: { id: task.id, title: task.title, identityMode: task.identity_mode }, people, names, results: visible,
    summary: {
      total: visible.length, ok: okRows.length, errors: visible.length - okRows.length,
      sessions: okPeople.size, alreadyAccepted: alreadyPeople, newly: okPeople.size - alreadyPeople,
      ignored: (meta && meta.ignored) || 0, ignoredBy: (meta && meta.ignoredBy) || {},
    },
    warnings,
  };
}

// ------------------------------------------------------------------ apply
async function applyAcceptance({ db, taskId, headLeaderId, labelType, rows, startRow, rowNos = null, meta = null, confirmWarnings = false, fileName = null }) {
  const pre = await resolveAcceptance({ db, taskId, headLeaderId, labelType, rows, startRow, rowNos, meta });
  if (pre.warnings.length && !confirmWarnings) throw httpError(409, "توجد تحذيرات يجب تأكيدها أولًا (راجعها في المعاينة).", "WARNINGS");
  const people = new Map();
  for (const r of pre.results) if (r.ok && !people.has(r.session.id)) people.set(r.session.id, r.label);
  if (!people.size) throw httpError(400, "لا يوجد أي صف صالح للتطبيق.");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const file = (await client.query(
      `INSERT INTO studio_acceptance_files (task_id, file_name, created_by) VALUES ($1, $2, $3) RETURNING id, created_at`,
      [taskId, fileName ? String(fileName).slice(0, 300) : null, headLeaderId])).rows[0];
    // a session that was withdrawn in the meantime is skipped; one that is already accepted keeps its first acceptance
    const ins = await client.query(
      `INSERT INTO studio_acceptances (session_id, task_id, file_id, sheet_label)
       SELECT x.id, rs.task_id, $3, x.label FROM unnest($1::uuid[], $2::text[]) AS x(id, label)
       JOIN recording_sessions rs ON rs.id = x.id AND rs.task_id = $4 AND rs.status <> 'expired'
       ON CONFLICT (session_id) DO NOTHING RETURNING session_id`,
      [[...people.keys()], [...people.values()].map((l) => String(l).slice(0, 200)), file.id, taskId]);
    if (!ins.rows.length) {          // nothing new: do not leave an empty file in the history
      await client.query(`DELETE FROM studio_acceptance_files WHERE id = $1`, [file.id]);
      await client.query("COMMIT");
      return { fileId: null, newly: 0, alreadyAccepted: people.size, skipped: pre.results.filter((r) => !r.ok).length };
    }
    await client.query(`UPDATE studio_acceptance_files SET accepted_count = $2 WHERE id = $1`, [file.id, ins.rows.length]);
    await client.query("COMMIT");
    return { fileId: file.id, newly: ins.rows.length, alreadyAccepted: people.size - ins.rows.length, skipped: pre.results.filter((r) => !r.ok).length };
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }
}

// ------------------------------------------------------------------ the page: every task, ordered
const DELIVERED_SQL = `(EXISTS (SELECT 1 FROM studio_delivery_batch_sessions bs JOIN studio_delivery_batches b ON b.id = bs.batch_id WHERE bs.session_id = rs.id AND b.status = 'delivered')
                       OR EXISTS (SELECT 1 FROM studio_feedback_items f0 WHERE f0.session_id = rs.id))`;

function stateOf(delivered, accepted) {
  if (accepted > 0 && accepted >= delivered) return "full";
  if (accepted > 0) return "partial";
  return delivered > 0 ? "none" : "no_delivery";
}

/** EVERY task of the head leader — published, drafts, closed, storage already cleared — newest first, with its acceptance numbers. */
async function listBoard(db, headLeaderId) {
  const r = await db.query(
    `SELECT t.id, t.title, t.status, t.created_at, t.published_at, t.finalized_at, t.storage_cleared_at, t.identity_mode, t.direct,
            c.people, c.delivered, c.accepted, f.files, f.last_at, f.last_name
     FROM recording_tasks t
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE rs.status <> 'expired')::int AS people,
              COUNT(*) FILTER (WHERE rs.status <> 'expired' AND ${DELIVERED_SQL})::int AS delivered,
              COUNT(*) FILTER (WHERE rs.status <> 'expired' AND a.session_id IS NOT NULL)::int AS accepted
       FROM recording_sessions rs LEFT JOIN studio_acceptances a ON a.session_id = rs.id WHERE rs.task_id = t.id) c ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS files, MAX(created_at) AS last_at, (ARRAY_AGG(file_name ORDER BY created_at DESC))[1] AS last_name
       FROM studio_acceptance_files WHERE task_id = t.id) f ON true
     WHERE t.head_leader_id = $1
     ORDER BY t.created_at DESC, t.title`, [headLeaderId]);
  const tasks = r.rows.map((t) => {
    const delivered = Math.max(t.delivered || 0, t.accepted || 0);
    return {
      id: t.id, title: t.title, status: t.status, createdAt: t.created_at, publishedAt: t.published_at,
      finished: !!t.finalized_at, storageCleared: !!t.storage_cleared_at, identityMode: t.identity_mode, direct: !!t.direct,
      people: t.people || 0, delivered, accepted: t.accepted || 0, files: t.files || 0, lastFileAt: t.last_at, lastFileName: t.last_name,
      state: stateOf(delivered, t.accepted || 0),
    };
  });
  const by = (s) => tasks.filter((t) => t.state === s).length;
  return { tasks, totals: { tasks: tasks.length, full: by("full"), partial: by("partial"), none: by("none"), noDelivery: by("no_delivery") } };
}

/** One task: the acceptance files uploaded for it (newest first) and every person with his acceptance state. */
async function getTaskDetail(db, taskId, headLeaderId) {
  const task = (await db.query(`SELECT id, title, identity_mode FROM recording_tasks WHERE id = $1 AND head_leader_id = $2`, [taskId, headLeaderId])).rows[0];
  if (!task) throw httpError(404, "المهمة غير موجودة");
  const files = (await db.query(`SELECT id, file_name, accepted_count, created_at FROM studio_acceptance_files WHERE task_id = $1 ORDER BY created_at DESC`, [taskId])).rows
    .map((f) => ({ id: f.id, fileName: f.file_name, accepted: f.accepted_count, createdAt: f.created_at }));
  const ppl = await db.query(
    `SELECT rs.id, rs.fake_name, rs.gender, rs.age_bracket, rs.age, rs.status, l.leader_code, l.name AS leader_name, tal.name AS real_name,
            a.accepted_at, a.sheet_label, af.file_name AS accepted_file, ${DELIVERED_SQL} AS delivered
     FROM recording_sessions rs
     JOIN studio_leaders l ON l.id = rs.leader_id
     LEFT JOIN studio_talents tal ON tal.id = rs.talent_id
     LEFT JOIN studio_acceptances a ON a.session_id = rs.id
     LEFT JOIN studio_acceptance_files af ON af.id = a.file_id
     WHERE rs.task_id = $1 AND rs.status <> 'expired'
     ORDER BY (a.accepted_at IS NULL), a.accepted_at DESC, rs.fake_name
     LIMIT 3000`, [taskId]);
  return {
    task: { id: task.id, title: task.title, identityMode: task.identity_mode }, files,
    people: ppl.rows.map((p) => ({
      id: p.id, fakeName: p.fake_name, realName: p.real_name, gender: p.gender, ageBracket: p.age_bracket, age: p.age, status: p.status,
      leaderCode: p.leader_code, leaderName: p.leader_name, delivered: !!p.delivered,
      acceptedAt: p.accepted_at, sheetLabel: p.sheet_label, acceptedFile: p.accepted_file,
    })),
  };
}

/** Undo one acceptance file: the people it accepted go back to "not accepted yet". */
async function deleteFile(db, fileId, headLeaderId) {
  const r = await db.query(
    `DELETE FROM studio_acceptance_files f USING recording_tasks t
     WHERE f.id = $1 AND t.id = f.task_id AND t.head_leader_id = $2 RETURNING f.task_id, f.accepted_count`, [fileId, headLeaderId]);
  if (!r.rows.length) throw httpError(404, "ملف القبول غير موجود");
  return { taskId: r.rows[0].task_id, removed: r.rows[0].accepted_count };
}

/** Undo the acceptance of ONE person. */
async function removeAcceptance(db, sessionId, headLeaderId) {
  const r = await db.query(
    `DELETE FROM studio_acceptances a USING recording_tasks t
     WHERE a.session_id = $1 AND t.id = a.task_id AND t.head_leader_id = $2 RETURNING a.file_id, a.task_id`, [sessionId, headLeaderId]);
  if (!r.rows.length) throw httpError(404, "هذا القبول غير موجود");
  if (r.rows[0].file_id) await db.query(`UPDATE studio_acceptance_files SET accepted_count = (SELECT COUNT(*) FROM studio_acceptances WHERE file_id = $1) WHERE id = $1`, [r.rows[0].file_id]);
  return { taskId: r.rows[0].task_id };
}

/** Which of these sessions the company accepted: Map session id -> accepted_at (empty before the migration, so the other pages never break). */
async function acceptedMap(db, sessionIds) {
  if (!sessionIds.length || !(await acceptanceReady(db))) return new Map();
  const r = await db.query(`SELECT session_id, accepted_at FROM studio_acceptances WHERE session_id = ANY($1::uuid[])`, [sessionIds]);
  return new Map(r.rows.map((x) => [x.session_id, x.accepted_at]));
}

module.exports = {
  UUID, acceptanceReady, _resetReadyForTests, extractAcceptRows, resolveAcceptance, applyAcceptance,
  listBoard, getTaskDetail, deleteFile, removeAcceptance, acceptedMap, stateOf,
};
