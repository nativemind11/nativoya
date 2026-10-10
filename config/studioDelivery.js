/**
 * Phase 6 — head-leader delivery.
 *
 * Approved sessions wait here until the head leader "collects" them. A group
 * is: one task  ×  one gender  ×  one QA reviewer  ×  one review day.
 *
 *  - buildPendingTree()  nested view for the dashboard
 *  - collectGroup()      atomically claims the group, streams every session ZIP
 *                        into ONE big ZIP, and only then marks it delivered.
 *                        Any failure releases the sessions back to "waiting".
 *  - buildSheet()        Excel file for a group / batch
 *
 * `db` (a pg Pool) and `storage` are injected, so the same code is tested
 * against a real Postgres and a fake storage (see tests/delivery.test.js).
 */
const archiver = require("archiver");
const ExcelJS = require("exceljs");

const TZ = "Africa/Cairo";
const STALE_MINUTES = 15;
const GENDER_LABEL = { male: "Male", female: "Female" };

function httpError(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  return e;
}

// ---------------------------------------------------------------- SQL pieces
// The review day is always computed in Cairo time, and falls back to
// updated_at for sessions approved before qa_reviewed_at was tracked.
const DAY_EXPR = `to_char(COALESCE(rs.qa_reviewed_at, rs.updated_at) AT TIME ZONE '${TZ}', 'YYYY-MM-DD')`;

// zipExpr/extraJoin let the archive read the ZIP name that was delivered at the
// time (studio_delivery_batch_sessions) instead of the session's current one.
function sessionsSelect(zipExpr = "rs.zip_file_name", extraJoin = "") {
  return `
  SELECT rs.id, rs.task_id, t.title AS task_title, rs.gender, rs.age_bracket, rs.age, rs.fake_name,
         ${zipExpr} AS zip_file_name, rs.zip_file_url, rs.qa_reviewer_id, qa.name AS qa_name,
         COALESCE(rs.qa_reviewed_at, rs.updated_at) AS reviewed_at,
         ${DAY_EXPR} AS group_day,
         tal.name AS real_name, tal.email, tal.whatsapp, l.leader_code,
         COALESCE(rs.zip_partial_count, (SELECT COUNT(*)::int FROM recording_session_samples ss WHERE ss.session_id = rs.id)) AS sample_count,
         rs.zip_partial_count IS NOT NULL AS is_partial,
         EXISTS (SELECT 1 FROM studio_feedback_items f WHERE f.session_id = rs.id AND f.status = 'reworked') AS is_redelivery
  FROM recording_sessions rs
  JOIN recording_tasks t ON t.id = rs.task_id
  JOIN studio_leaders l ON l.id = rs.leader_id
  LEFT JOIN studio_talents tal ON tal.id = rs.talent_id
  LEFT JOIN studio_qa_reviewers qa ON qa.id = rs.qa_reviewer_id
  ${extraJoin}`;
}
const SELECT_SESSIONS = sessionsSelect();

const WAITING = `rs.status = 'approved' AND rs.delivery_batch_id IS NULL AND rs.zip_file_url IS NOT NULL`;

/** WHERE fragment matching exactly one group; params start at $from. */
function groupWhere(from) {
  return `${WAITING}
    AND rs.task_id = $${from}::uuid
    AND rs.gender = $${from + 1}
    AND rs.qa_reviewer_id IS NOT DISTINCT FROM $${from + 2}::uuid
    AND ${DAY_EXPR} = $${from + 3}`;
}
const groupParams = (p) => [p.taskId, p.gender, p.qaReviewerId || null, p.day];

// ------------------------------------------------------------------- queries
async function fetchPending(db) {
  const r = await db.query(`${SELECT_SESSIONS} WHERE ${WAITING} ORDER BY reviewed_at ASC`);
  return r.rows;
}

async function fetchGroupRows(db, params) {
  const r = await db.query(`${SELECT_SESSIONS} WHERE ${groupWhere(1)} ORDER BY reviewed_at ASC`, groupParams(params));
  return r.rows;
}

async function fetchBatchRows(db, batchId) {
  const sql = sessionsSelect("COALESCE(bs.zip_file_name, rs.zip_file_name)", "JOIN studio_delivery_batch_sessions bs ON bs.session_id = rs.id");
  const r = await db.query(`${sql} WHERE bs.batch_id = $1 ORDER BY reviewed_at ASC`, [batchId]);
  return r.rows;
}

/** The batch itself (task, gender, QA, day) — used for the archive sheet's header info. */
async function fetchBatchMeta(db, batchId) {
  const r = await db.query(
    `SELECT b.id, b.gender, b.group_day::text AS group_day, b.status, t.title AS task_title, qa.name AS qa_name
     FROM studio_delivery_batches b
     JOIN recording_tasks t ON t.id = b.task_id
     LEFT JOIN studio_qa_reviewers qa ON qa.id = b.qa_reviewer_id
     WHERE b.id = $1`, [batchId]);
  return r.rows[0] || null;
}

/** A collect that died mid-way (timeout, crash) must not hide sessions forever. */
async function releaseStaleBatches(db, minutes = STALE_MINUTES) {
  await db.query(
    `WITH stale AS (
       UPDATE studio_delivery_batches
       SET status = 'failed', error = 'لم يكتمل التجميع (انتهت المهلة) — اتعاد المجموعة لقايمة الانتظار.'
       WHERE status = 'collecting' AND created_at < now() - ($1::int * interval '1 minute')
       RETURNING id)
     UPDATE recording_sessions SET delivery_batch_id = NULL
     WHERE delivery_batch_id IN (SELECT id FROM stale)`,
    [minutes]
  );
}

// ------------------------------------------------------------- dashboard tree
/**
 * rows -> [{ taskId, title, total, genders: { male: [group], female: [group] } }]
 * group = { params, day, qaName, qaReviewerId, firstAt, lastAt, sessions[] }
 */
function buildPendingTree(rows) {
  const tasks = new Map();
  for (const r of rows) {
    if (!tasks.has(r.task_id)) {
      tasks.set(r.task_id, { taskId: r.task_id, title: r.task_title, total: 0, genders: { male: new Map(), female: new Map() } });
    }
    const task = tasks.get(r.task_id);
    task.total++;
    const key = `${r.qa_reviewer_id || "none"}|${r.group_day}`;
    const groups = task.genders[r.gender];
    if (!groups.has(key)) {
      groups.set(key, {
        params: { taskId: r.task_id, gender: r.gender, qaReviewerId: r.qa_reviewer_id || null, day: r.group_day },
        day: r.group_day, qaName: r.qa_name || null, qaReviewerId: r.qa_reviewer_id || null,
        firstAt: r.reviewed_at, lastAt: r.reviewed_at, sessions: [],
      });
    }
    const g = groups.get(key);
    if (r.reviewed_at < g.firstAt) g.firstAt = r.reviewed_at;
    if (r.reviewed_at > g.lastAt) g.lastAt = r.reviewed_at;
    g.sessions.push({
      id: r.id, fakeName: r.fake_name, realName: r.real_name, email: r.email, whatsapp: r.whatsapp,
      ageBracket: r.age_bracket, age: r.age, zipFileName: r.zip_file_name, leaderCode: r.leader_code,
      sampleCount: r.sample_count, reviewedAt: r.reviewed_at, isRedelivery: !!r.is_redelivery, isPartial: !!r.is_partial,
    });
  }
  const sortGroups = (m) => [...m.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : (a.qaName || "").localeCompare(b.qaName || "")));
  return [...tasks.values()].map((t) => ({
    taskId: t.taskId, title: t.title, total: t.total,
    genders: { male: sortGroups(t.genders.male), female: sortGroups(t.genders.female) },
  }));
}

async function listDelivered(db) {
  await releaseStaleBatches(db);
  const r = await db.query(`
    SELECT b.id, b.task_id, t.title AS task_title, b.gender, b.group_day::text AS group_day, b.status,
           b.session_count, b.zip_file_name, b.zip_file_url, b.zip_size_bytes, b.created_at, b.delivered_at,
           b.downloaded_at, b.zip_purged_at,
           qa.name AS qa_name
    FROM studio_delivery_batches b
    JOIN recording_tasks t ON t.id = b.task_id
    LEFT JOIN studio_qa_reviewers qa ON qa.id = b.qa_reviewer_id
    WHERE b.status IN ('delivered', 'collecting')
    ORDER BY COALESCE(b.delivered_at, b.created_at) DESC`);
  return r.rows;
}

// -------------------------------------------------------------------- naming
function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 150);
}

function deliveryBaseName({ taskTitle, gender, qaName, day }) {
  return sanitizeFileName(`Delivery - ${taskTitle} - ${GENDER_LABEL[gender] || gender} - ${qaName || "QA"} - ${day}`);
}

/** Entry names inside the big ZIP; guarantees no two entries collide. */
function uniqueZipNames(sessions) {
  const seen = new Map();
  return sessions.map((s) => {
    const base = sanitizeFileName(s.zip_file_name || `${s.fake_name}.zip`);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    if (n === 1) return base;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? `${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${base}-${n}`;
  });
}

// ------------------------------------------------------------------- collect
/**
 * Claim → stream → finalize. The claim is one atomic UPDATE, so pressing
 * Collect twice (or two head leaders at once) can never collect a session
 * twice: the second call finds nothing left and gets a 409.
 */
async function collectGroup({ db, storage, params, headLeaderId }) {
  await releaseStaleBatches(db);

  const client = await db.connect();
  let batch, sessions;
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO studio_delivery_batches (task_id, gender, qa_reviewer_id, group_day, collected_by)
       VALUES ($1::uuid, $2, $3::uuid, $4::date, $5) RETURNING *`,
      [params.taskId, params.gender, params.qaReviewerId || null, params.day, headLeaderId]
    );
    batch = ins.rows[0];
    const claim = await client.query(
      `UPDATE recording_sessions SET delivery_batch_id = $1
       WHERE id IN (SELECT rs.id FROM recording_sessions rs WHERE ${groupWhere(2)} FOR UPDATE SKIP LOCKED)
       RETURNING id, fake_name, zip_file_name, zip_file_url`,
      [batch.id, ...groupParams(params)]
    );
    if (!claim.rows.length) {
      await client.query("ROLLBACK");
      throw httpError(409, "المجموعة دي اتجمّعت قبل كده أو مفيش فيها تسليمات.");
    }
    // RETURNING has no guaranteed order — sort so the ZIP's contents are deterministic.
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
    const meta = await db.query(
      `SELECT t.id, t.title, (SELECT name FROM studio_qa_reviewers WHERE id = $2::uuid) AS qa_name
       FROM recording_tasks t WHERE t.id = $1::uuid`,
      [params.taskId, params.qaReviewerId || null]
    );
    const task = meta.rows[0];
    const fileName = deliveryBaseName({ taskTitle: task.title, gender: params.gender, qaName: meta.rows[0].qa_name, day: params.day }) + ".zip";
    const names = uniqueZipNames(sessions);
    const saved = await storage.buildAndSave({
      task: { id: task.id, title: task.title },
      fileName,
      entries: sessions.map((s, i) => ({ name: names[i], session: s })),
    });
    // Mark delivered AND write the permanent membership record in one
    // transaction. The membership comes from the list captured at claim time,
    // so a session that is sent back for feedback while the ZIP was building
    // is still recorded as part of what this ZIP actually contained.
    const fin = await db.connect();
    try {
      await fin.query("BEGIN");
      await fin.query(
        `INSERT INTO studio_delivery_batch_sessions (batch_id, session_id, zip_file_name)
         SELECT $1, x.id, x.zip FROM unnest($2::uuid[], $3::text[]) AS x(id, zip) ON CONFLICT DO NOTHING`,
        [batch.id, sessions.map((x) => x.id), sessions.map((x, i) => names[i])]
      );
      const done = await fin.query(
        `UPDATE studio_delivery_batches
         SET status = 'delivered', zip_file_name = $2, zip_file_url = $3, zip_size_bytes = $4, delivered_at = now(), error = NULL
         WHERE id = $1 RETURNING id, session_count, zip_file_name, zip_file_url, zip_size_bytes, delivered_at`,
        [batch.id, fileName, saved.url, saved.size || null]
      );
      await fin.query("COMMIT");
      return done.rows[0];
    } catch (e) {
      try { await fin.query("ROLLBACK"); } catch (_) {}
      throw e;
    } finally {
      fin.release();
    }
  } catch (err) {
    // put every session back in the waiting list — nothing is lost or hidden
    await db.query(`UPDATE recording_sessions SET delivery_batch_id = NULL WHERE delivery_batch_id = $1`, [batch.id]);
    await db.query(`UPDATE studio_delivery_batches SET status = 'failed', error = $2 WHERE id = $1`, [batch.id, String(err.message).slice(0, 500)]);
    throw err;
  }
}

/**
 * Builds the storage used by collectGroup: ONE streaming ZIP pipeline.
 * Each session ZIP is appended only after the previous one finished, and the
 * archive is piped straight into the upload, so memory stays flat no matter
 * how many sessions are in the group. Entries are stored, not recompressed
 * (they are already ZIPs full of audio).
 */
function createArchiveStorage({ openSessionZip, uploadStream }) {
  return {
    async buildAndSave({ task, fileName, entries }) {
      const archive = archiver("zip", { store: true });
      let failure = null;
      archive.on("warning", (w) => { failure = failure || w; });
      archive.on("error", (e) => { failure = failure || e; });

      const uploading = uploadStream({ task, fileName, stream: archive });
      uploading.catch(() => {}); // surfaced below; avoids an unhandled rejection while we stream

      try {
        for (const entry of entries) {
          if (failure) throw failure;
          const src = await openSessionZip(entry.session);
          const appended = new Promise((resolve, reject) => {
            const onEntry = () => { archive.removeListener("error", reject); resolve(); };
            archive.once("entry", onEntry);
            archive.once("error", reject);
          });
          archive.append(src, { name: entry.name });
          await appended;
        }
        await archive.finalize();
      } catch (err) {
        archive.abort();
        throw err;
      }
      if (failure) throw failure;
      const saved = await uploading;
      return { url: saved.url, size: saved.size || archive.pointer() };
    },
  };
}

// --------------------------------------------------------------------- sheet
function styleHeader(sheet) {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  row.alignment = { vertical: "middle" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/**
 * Sheet 1 is safe to hand to the buyer (fake names only). Real names, emails
 * and WhatsApp numbers live on a separate, clearly-labelled internal sheet.
 */
async function buildSheet(rows, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Nativoya Studio";
  wb.created = new Date();

  const del = wb.addWorksheet("Delivery");
  del.columns = [
    { header: "#", key: "n", width: 6 },
    { header: "Fake name", key: "fake", width: 26 },
    { header: "Gender", key: "gender", width: 10 },
    { header: "Age group", key: "bracket", width: 12 },
    { header: "Age", key: "age", width: 8 },
    { header: "Recordings", key: "count", width: 12 },
    { header: "ZIP file", key: "zip", width: 44 },
  ];
  styleHeader(del);

  const internal = wb.addWorksheet("Internal - do not share");
  internal.columns = [
    { header: "#", key: "n", width: 6 },
    { header: "Fake name", key: "fake", width: 26 },
    { header: "Real name", key: "name", width: 28 },
    { header: "Email", key: "email", width: 34 },
    { header: "WhatsApp", key: "wa", width: 18 },
    { header: "Leader code", key: "leader", width: 12 },
    { header: "ZIP file", key: "zip", width: 44 },
  ];
  styleHeader(internal);
  internal.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7F1D1D" } };

  const names = uniqueZipNames(rows);
  rows.forEach((r, i) => {
    del.addRow({
      n: i + 1, fake: r.fake_name, gender: GENDER_LABEL[r.gender] || r.gender, bracket: r.age_bracket,
      age: r.age ?? "", count: r.sample_count, zip: names[i],
    });
    internal.addRow({
      n: i + 1, fake: r.fake_name, name: r.real_name || "", email: r.email || "", wa: r.whatsapp || "",
      leader: r.leader_code, zip: names[i],
    });
  });

  const info = wb.addWorksheet("Info");
  info.addRows([
    ["Task", meta.taskTitle],
    ["Gender", GENDER_LABEL[meta.gender] || meta.gender],
    ["QA reviewer", meta.qaName || "—"],
    ["Review day", meta.day],
    ["Total ZIP files", rows.length],
  ]);
  info.getColumn(1).font = { bold: true };
  info.getColumn(1).width = 18;
  info.getColumn(2).width = 40;

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = {
  fetchPending, fetchGroupRows, fetchBatchRows, fetchBatchMeta, releaseStaleBatches, buildPendingTree, listDelivered,
  collectGroup, createArchiveStorage, buildSheet, deliveryBaseName, uniqueZipNames, sanitizeFileName,
  GENDER_LABEL, TZ,
};
