/**
 * v7 — the feedback page.
 *
 *   task -> feedback file (name + upload date) -> ONE ROW PER PERSON, with the time left and where the rework is.
 *   Inside each file: a ZIP tab (collect the people who delivered the rework and whose rework QA approved, boys and
 *   girls separately) and a sheet tab (Excel with their names exactly as written in the company's file).
 *   What was collected leaves the live list and sits in the "delivered rework" list with its date.
 *
 * `db` and `storage` are injected, like studioDelivery.js, so this is tested against a real Postgres and a fake storage.
 */
const ExcelJS = require("exceljs");
const D = require("./studioDelivery");
const { reworkColumnsReady, formatNumbers } = require("./studioRework");

const TZ = D.TZ;
const GENDER_LABEL = D.GENDER_LABEL;
const CAIRO_DAY = `(now() AT TIME ZONE '${TZ}')::date`;

function httpError(status, message) { const e = new Error(message); e.statusCode = status; return e; }

// ---------------------------------------------------------------- the rows
// One row per feedback ITEM, with everything needed to describe the person. Grouped per (file, person) in JS.
const PEOPLE_SELECT = `
  SELECT f.id AS item_id, f.session_id, f.task_id, t.title AS task_title,
         COALESCE(NULLIF(f.sheet_label, ''), f.fake_name) AS label,
         f.recording_numbers, f.issue_description, f.status AS item_status, COALESCE(f.is_final, false) AS is_final,
         f.rework_deadline, f.reworked_at, f.rework_batch_id,
         rs.status AS session_status, rs.gender, rs.age_bracket, rs.age, rs.fake_name, rs.zip_file_url, rs.zip_file_name,
         rs.delivery_batch_id, db.status AS delivery_batch_status,
         qa.name AS qa_name, l.leader_code, l.name AS leader_name,
         tal.name AS real_name, tal.email, tal.whatsapp,
         ff.id AS file_id, ff.file_name, ff.created_at AS file_created_at
  FROM studio_feedback_items f
  JOIN studio_feedback_files ff ON ff.upload_id = f.upload_id
  JOIN recording_tasks t ON t.id = f.task_id
  JOIN recording_sessions rs ON rs.id = f.session_id
  JOIN studio_leaders l ON l.id = f.leader_id
  LEFT JOIN studio_delivery_batches db ON db.id = rs.delivery_batch_id
  LEFT JOIN studio_talents tal ON tal.id = rs.talent_id
  LEFT JOIN studio_qa_reviewers qa ON qa.id = rs.qa_reviewer_id`;

/**
 * Where is this person's rework? (looking at the items of ONE file for ONE person)
 *   final      the company rejected it for good — nothing to redo
 *   expired    the time ran out, the name was withdrawn
 *   redoing    the talent still has recordings to redo (time is running)
 *   at_qa      he delivered the rework, QA has not approved it yet
 *   qa_returned QA sent the rework back again
 *   ready      he delivered, QA approved: waiting to be collected
 *   collecting a collect is running right now
 *   collected  it has been collected and delivered to the company
 */
function stateOf(items) {
  const nf = items.filter((i) => !i.is_final);
  if (!nf.length) return "final";
  if (nf.some((i) => i.item_status === "expired")) return "expired";
  if (nf.some((i) => i.item_status === "pending" || i.item_status === "acknowledged")) return "redoing";
  if (nf.every((i) => i.rework_batch_id)) return "collected";
  const s = items[0];
  if (s.delivery_batch_id) return s.delivery_batch_status === "collecting" ? "collecting" : "collected";
  if (s.session_status === "approved") return s.zip_file_url ? "ready" : "at_qa";
  if (s.session_status === "rejected") return "qa_returned";
  if (s.session_status === "expired") return "expired";
  return "at_qa";
}
const STATE_ORDER = { redoing: 0, qa_returned: 1, at_qa: 2, ready: 3, collecting: 4, expired: 5, final: 6, collected: 7 };

function groupPeople(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.file_id}|${r.session_id}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const people = [];
  for (const items of by.values()) {
    const s = items[0];
    const live = items.filter((i) => !i.is_final);
    const shown = live.length ? live : items;
    const numbers = [...new Set(shown.flatMap((i) => i.recording_numbers || []))].sort((a, b) => a - b);
    // "3, 5: noise | 7: cut" — the problem text per recording number(s), without repeating the same sentence
    const problems = [];
    for (const i of shown) {
      const text = (i.issue_description || "").trim();
      const nums = (i.recording_numbers || []).slice().sort((a, b) => a - b);
      const hit = problems.find((p) => p.text === text);
      if (hit) hit.numbers = [...new Set([...hit.numbers, ...nums])].sort((a, b) => a - b); else problems.push({ numbers: nums, text });
    }
    const deadlines = live.filter((i) => i.item_status === "pending" || i.item_status === "acknowledged").map((i) => i.rework_deadline).filter(Boolean);
    const reworkedAts = live.map((i) => i.reworked_at).filter(Boolean);
    people.push({
      fileId: s.file_id, fileName: s.file_name || null, fileCreatedAt: s.file_created_at,
      taskId: s.task_id, taskTitle: s.task_title, sessionId: s.session_id,
      label: s.label, fakeName: s.fake_name, gender: s.gender, ageBracket: s.age_bracket, age: s.age,
      leaderCode: s.leader_code, leaderName: s.leader_name, realName: s.real_name, email: s.email, whatsapp: s.whatsapp,
      qaName: s.qa_name || null, zipFileName: s.zip_file_name || null,
      numbers, problems, state: stateOf(items), sessionStatus: s.session_status,
      deadline: deadlines.length ? new Date(Math.min(...deadlines.map((d) => new Date(d).getTime()))).toISOString() : null,
      reworkedAt: reworkedAts.length ? new Date(Math.max(...reworkedAts.map((d) => new Date(d).getTime()))).toISOString() : null,
      batchId: (live.find((i) => i.rework_batch_id) || {}).rework_batch_id || null,
    });
  }
  return people.sort((a, b) => (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
}

// ------------------------------------------------------------------- board
/** The live list: tasks -> files -> people (what was already collected is not listed, only counted). */
async function listBoard(db, { taskId } = {}) {
  const rows = (await db.query(
    `${PEOPLE_SELECT} WHERE ($1::uuid IS NULL OR f.task_id = $1::uuid) ORDER BY ff.created_at DESC LIMIT 20000`, [taskId || null])).rows;
  const tasks = new Map();
  for (const p of groupPeople(rows)) {
    if (!tasks.has(p.taskId)) tasks.set(p.taskId, { taskId: p.taskId, title: p.taskTitle, files: new Map() });
    const t = tasks.get(p.taskId);
    if (!t.files.has(p.fileId)) t.files.set(p.fileId, { fileId: p.fileId, fileName: p.fileName, createdAt: p.fileCreatedAt, people: [], collected: 0 });
    const f = t.files.get(p.fileId);
    if (p.state === "collected") f.collected++; else f.people.push(p);
  }
  const out = [];
  for (const t of tasks.values()) {
    const files = [...t.files.values()].filter((f) => f.people.length).map((f) => {
      const counts = { redoing: 0, qa_returned: 0, at_qa: 0, ready: 0, collecting: 0, expired: 0, final: 0, collected: f.collected };
      const ready = { male: 0, female: 0 };
      for (const p of f.people) { counts[p.state]++; if (p.state === "ready" && ready[p.gender] != null) ready[p.gender]++; }
      return { ...f, counts, ready };
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (files.length) out.push({ taskId: t.taskId, title: t.title, files });
  }
  return { tasks: out };
}

/** The people of one file who are ready to be collected (delivered the rework, QA approved). */
async function fetchReady(db, fileId, gender) {
  const rows = (await db.query(`${PEOPLE_SELECT} WHERE ff.id = $1::uuid`, [fileId])).rows;
  return groupPeople(rows).filter((p) => p.state === "ready" && (!gender || p.gender === gender));
}

async function fetchFile(db, fileId) {
  const r = await db.query(
    `SELECT ff.id, ff.task_id, ff.file_name, ff.created_at, t.title AS task_title
     FROM studio_feedback_files ff JOIN recording_tasks t ON t.id = ff.task_id WHERE ff.id = $1::uuid`, [fileId]);
  return r.rows[0] || null;
}

// ----------------------------------------------------------------- collect
const READY_ITEM = `EXISTS (SELECT 1 FROM studio_feedback_items f
                            WHERE f.session_id = rs.id AND f.upload_id = $4::uuid AND f.status = 'reworked'
                              AND NOT COALESCE(f.is_final, false) AND f.rework_batch_id IS NULL)`;

function baseName(fileName) { return String(fileName || "feedback").replace(/\.[a-z0-9]{1,5}$/i, ""); }

/**
 * Claim -> stream -> finalize, exactly like the normal delivery collect: the claim is one atomic UPDATE (pressing
 * the button twice can never collect a person twice) and any failure puts everybody back.
 * Collects the people of ONE file and ONE gender who delivered the rework and whose rework QA approved.
 */
async function collectRework({ db, storage, fileId, gender, headLeaderId }) {
  if (gender !== "male" && gender !== "female") throw httpError(400, "اختار ولاد أو بنات");
  await D.releaseStaleBatches(db);
  const file = await fetchFile(db, fileId);
  if (!file) throw httpError(404, "ملف الفيدباك مش موجود");
  const upload = (await db.query(`SELECT upload_id FROM studio_feedback_files WHERE id = $1::uuid`, [fileId])).rows[0].upload_id;

  const client = await db.connect();
  let batch, sessions;
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO studio_delivery_batches (task_id, gender, qa_reviewer_id, group_day, collected_by, feedback_file_id)
       VALUES ($1::uuid, $2, NULL, ${CAIRO_DAY}, $3, $4::uuid) RETURNING *`,
      [file.task_id, gender, headLeaderId, fileId]);
    batch = ins.rows[0];
    const claim = await client.query(
      `UPDATE recording_sessions SET delivery_batch_id = $1
       WHERE id IN (SELECT rs.id FROM recording_sessions rs
                    WHERE rs.status = 'approved' AND rs.delivery_batch_id IS NULL AND rs.zip_file_url IS NOT NULL
                      AND rs.task_id = $2::uuid AND rs.gender = $3 AND ${READY_ITEM}
                    FOR UPDATE OF rs SKIP LOCKED)
       RETURNING id, fake_name, zip_file_name, zip_file_url`,
      [batch.id, file.task_id, gender, upload]);
    if (!claim.rows.length) {
      await client.query("ROLLBACK");
      throw httpError(409, "مفيش ريورك جاهز للتجميع في الملف ده (يمكن اتجمّع قبل كده).");
    }
    sessions = claim.rows.sort((a, b) => a.fake_name.localeCompare(b.fake_name, undefined, { numeric: true }));
    await client.query(`UPDATE studio_delivery_batches SET session_count = $1 WHERE id = $2`, [sessions.length, batch.id]);
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  try {
    const day = (await db.query(`SELECT ${CAIRO_DAY}::text AS d`)).rows[0].d;
    const fileName = D.sanitizeFileName(`Rework - ${file.task_title} - ${baseName(file.file_name)} - ${GENDER_LABEL[gender]} - ${day}`) + ".zip";
    const names = D.uniqueZipNames(sessions);
    const saved = await storage.buildAndSave({
      task: { id: file.task_id, title: file.task_title }, fileName,
      entries: sessions.map((s, i) => ({ name: names[i], session: s })),
    });
    const fin = await db.connect();
    try {
      await fin.query("BEGIN");
      await fin.query(
        `INSERT INTO studio_delivery_batch_sessions (batch_id, session_id, zip_file_name)
         SELECT $1, x.id, x.zip FROM unnest($2::uuid[], $3::text[]) AS x(id, zip) ON CONFLICT DO NOTHING`,
        [batch.id, sessions.map((x) => x.id), names]);
      if (await reworkColumnsReady(fin)) {
        await fin.query(
          `UPDATE studio_delivery_batch_sessions b SET is_rework = rs.zip_is_rework, rework_numbers = rs.zip_rework_numbers
           FROM recording_sessions rs WHERE b.batch_id = $1 AND b.session_id = rs.id`, [batch.id]);
      }
      // the rework these people delivered is now with the company: it leaves the live list for good
      await fin.query(
        `UPDATE studio_feedback_items SET rework_batch_id = $1
         WHERE session_id = ANY($2::uuid[]) AND status = 'reworked' AND NOT COALESCE(is_final, false) AND rework_batch_id IS NULL`,
        [batch.id, sessions.map((x) => x.id)]);
      const done = await fin.query(
        `UPDATE studio_delivery_batches
         SET status = 'delivered', zip_file_name = $2, zip_file_url = $3, zip_size_bytes = $4, delivered_at = now(), error = NULL
         WHERE id = $1 RETURNING id, session_count, zip_file_name, zip_file_url, zip_size_bytes, delivered_at`,
        [batch.id, fileName, saved.url, saved.size || null]);
      await fin.query("COMMIT");
      return done.rows[0];
    } catch (e) {
      try { await fin.query("ROLLBACK"); } catch (_) {}
      throw e;
    } finally { fin.release(); }
  } catch (err) {
    await db.query(`UPDATE recording_sessions SET delivery_batch_id = NULL WHERE delivery_batch_id = $1`, [batch.id]);
    await db.query(`UPDATE studio_delivery_batches SET status = 'failed', error = $2 WHERE id = $1`, [batch.id, String(err.message).slice(0, 500)]);
    throw err;
  }
}

// --------------------------------------------------------------- delivered
/** The delivered rework: tasks -> files -> batches (each with its people and the date). */
async function listReworkBatches(db, { taskId } = {}) {
  await D.releaseStaleBatches(db);
  const batches = (await db.query(
    `SELECT b.id, b.task_id, t.title AS task_title, b.gender, b.status, b.session_count, b.zip_file_name, b.zip_size_bytes,
            b.created_at, b.delivered_at, b.downloaded_at, b.zip_purged_at,
            ff.id AS file_id, ff.file_name, ff.created_at AS file_created_at
     FROM studio_delivery_batches b
     JOIN studio_feedback_files ff ON ff.id = b.feedback_file_id
     JOIN recording_tasks t ON t.id = b.task_id
     WHERE b.feedback_file_id IS NOT NULL AND b.status IN ('delivered', 'collecting') AND ($1::uuid IS NULL OR b.task_id = $1::uuid)
     ORDER BY COALESCE(b.delivered_at, b.created_at) DESC LIMIT 500`, [taskId || null])).rows;
  if (!batches.length) return { tasks: [] };
  const rows = (await db.query(`${PEOPLE_SELECT} WHERE f.rework_batch_id = ANY($1::uuid[])`, [batches.map((b) => b.id)])).rows;
  const byBatch = new Map();
  for (const p of groupPeople(rows)) {
    if (!byBatch.has(p.batchId)) byBatch.set(p.batchId, []);
    byBatch.get(p.batchId).push(p);
  }
  const tasks = new Map();
  for (const b of batches) {
    if (!tasks.has(b.task_id)) tasks.set(b.task_id, { taskId: b.task_id, title: b.task_title, files: new Map() });
    const t = tasks.get(b.task_id);
    if (!t.files.has(b.file_id)) t.files.set(b.file_id, { fileId: b.file_id, fileName: b.file_name, createdAt: b.file_created_at, batches: [] });
    t.files.get(b.file_id).batches.push({
      id: b.id, gender: b.gender, status: b.status, sessionCount: b.session_count, zipFileName: b.zip_file_name,
      zipSizeBytes: b.zip_size_bytes, deliveredAt: b.delivered_at, createdAt: b.created_at, downloadedAt: b.downloaded_at,
      zipPurgedAt: b.zip_purged_at, people: byBatch.get(b.id) || [],
    });
  }
  return { tasks: [...tasks.values()].map((t) => ({ taskId: t.taskId, title: t.title, files: [...t.files.values()] })) };
}

async function fetchBatchForSheet(db, batchId) {
  const b = (await db.query(
    `SELECT b.id, b.gender, b.delivered_at, b.group_day::text AS group_day, ff.id AS file_id, ff.file_name, ff.created_at AS file_created_at, t.title AS task_title
     FROM studio_delivery_batches b JOIN studio_feedback_files ff ON ff.id = b.feedback_file_id JOIN recording_tasks t ON t.id = b.task_id
     WHERE b.id = $1::uuid`, [batchId])).rows[0];
  if (!b) return null;
  const rows = (await db.query(`${PEOPLE_SELECT} WHERE f.rework_batch_id = $1::uuid`, [batchId])).rows;
  return { batch: b, people: groupPeople(rows) };
}

// ------------------------------------------------------------------- sheet
function fmtDate(v) {
  if (!v) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(v)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}
function style(sheet, argb = "FF1F2937") {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/**
 * Sheet 1 (safe to hand over): the names exactly as the company wrote them, the fake name, which recordings were
 * redone, when, and which QA approved the rework. Real names / emails / leaders are on a separate internal sheet.
 * meta = { taskTitle, fileName, fileCreatedAt, gender?, deliveredAt? }
 */
async function buildReworkSheet(people, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Studio"; wb.created = new Date();
  const sheet = wb.addWorksheet("Rework");
  sheet.columns = [
    { header: "#", key: "n", width: 6 },
    { header: "Name in company file", key: "label", width: 34 },
    { header: "Fake name", key: "fake", width: 22 },
    { header: "Gender", key: "gender", width: 10 },
    { header: "Age group", key: "bracket", width: 12 },
    { header: "Age", key: "age", width: 8 },
    { header: "Reworked recordings", key: "nums", width: 22 },
    { header: "Rework delivered on", key: "at", width: 20 },
    { header: "ZIP file", key: "zip", width: 40 },
    { header: "QA reviewer", key: "qa", width: 22 },
  ];
  style(sheet);
  const internal = wb.addWorksheet("Internal - do not share");
  internal.columns = [
    { header: "#", key: "n", width: 6 }, { header: "Name in company file", key: "label", width: 34 },
    { header: "Fake name", key: "fake", width: 22 }, { header: "Real name", key: "name", width: 28 },
    { header: "Email", key: "email", width: 34 }, { header: "WhatsApp", key: "wa", width: 18 },
    { header: "Leader code", key: "leader", width: 12 }, { header: "Leader", key: "leaderName", width: 24 },
    { header: "QA reviewer", key: "qa", width: 22 },
  ];
  style(internal, "FF7F1D1D");
  const zipNames = D.uniqueZipNames(people.map((p) => ({ zip_file_name: p.zipFileName, fake_name: p.fakeName })));
  people.forEach((p, i) => {
    sheet.addRow({
      n: i + 1, label: p.label, fake: p.fakeName, gender: GENDER_LABEL[p.gender] || p.gender, bracket: p.ageBracket || "",
      age: p.age ?? "", nums: formatNumbers(p.numbers), at: fmtDate(p.reworkedAt), zip: zipNames[i], qa: p.qaName || "",
    });
    internal.addRow({
      n: i + 1, label: p.label, fake: p.fakeName, name: p.realName || "", email: p.email || "", wa: p.whatsapp || "",
      leader: p.leaderCode, leaderName: p.leaderName || "", qa: p.qaName || "",
    });
  });
  const info = wb.addWorksheet("Info");
  info.addRows([
    ["Task", meta.taskTitle],
    ["Feedback file", meta.fileName || "(old file)"],
    ["Feedback file uploaded", fmtDate(meta.fileCreatedAt)],
    ["Gender", meta.gender ? (GENDER_LABEL[meta.gender] || meta.gender) : "All"],
    ["Delivered to the company", meta.deliveredAt ? fmtDate(meta.deliveredAt) : "— (not collected yet)"],
    ["People", people.length],
  ]);
  info.getColumn(1).font = { bold: true }; info.getColumn(1).width = 26; info.getColumn(2).width = 44;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { PEOPLE_SELECT, stateOf, groupPeople, listBoard, fetchReady, fetchFile, collectRework, listReworkBatches, fetchBatchForSheet, buildReworkSheet, fmtDate };
