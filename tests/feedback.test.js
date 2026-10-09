// Phase 7 tests. Unit tests run anywhere; the flow tests need TEST_DATABASE_URL.
const test = require("node:test");
const assert = require("node:assert");
const ExcelJS = require("exceljs");
const F = require("../config/studioFeedback.js");
const D = require("../config/studioDelivery.js");

// ---------------------------------------------------------------- unit: labels
test("parseLabel: full zip name -> fake name (fake names may contain hyphens)", () => {
  assert.deepStrictEqual(F.parseLabel("Eagle-male-adult-30.zip", "zip"), { fakeName: "Eagle" });
  assert.deepStrictEqual(F.parseLabel("Super-Eva-female-elderly-NA.zip", "zip"), { fakeName: "Super-Eva" });
  assert.deepStrictEqual(F.parseLabel("  folder/sub\\Eagle-male-child-9.ZIP ", "zip"), { fakeName: "Eagle" });
  assert.strictEqual(F.parseLabel("Eagle", "zip").error, "not_zip");
  assert.strictEqual(F.parseLabel("", "zip").error, "empty");
});

test("parseLabel: fake-name column is used as is, but a full zip name there is still understood", () => {
  assert.deepStrictEqual(F.parseLabel(" Falcon ", "fake"), { fakeName: "Falcon" });
  assert.deepStrictEqual(F.parseLabel("Falcon-female-adult-22.zip", "fake"), { fakeName: "Falcon" });
  assert.deepStrictEqual(F.parseLabel("Falcon.zip", "fake"), { fakeName: "Falcon" });
});

// --------------------------------------------------------------- unit: numbers
test("parseNumbers: lists, ranges, Arabic digits, separators, words", () => {
  const n = (s, max = 20) => F.parseNumbers(s, max);
  assert.deepStrictEqual(n("3").numbers, [3]);
  assert.deepStrictEqual(n("3, 5, 7").numbers, [3, 5, 7]);
  assert.deepStrictEqual(n("7,3,5,3").numbers, [3, 5, 7], "sorted and de-duplicated");
  assert.deepStrictEqual(n("2-4").numbers, [2, 3, 4]);
  assert.deepStrictEqual(n("1-3, 7").numbers, [1, 2, 3, 7]);
  assert.deepStrictEqual(n("٣ و ٥").numbers, [3, 5], "Arabic-Indic digits");
  assert.deepStrictEqual(n("۱۲،۱۴").numbers, [12, 14], "Persian digits + Arabic comma");
  assert.deepStrictEqual(n("3.0").numbers, [3], "numeric cells that arrive as 3.0");
  assert.deepStrictEqual(n("5 to 7").numbers, [5, 6, 7]);
  assert.deepStrictEqual(n("2 – 3").numbers, [2, 3], "en dash");
  assert.deepStrictEqual(n("recordings 4 and 9").numbers, [4, 9], "words around the numbers are ignored");
  assert.strictEqual(n("all", 4).numbers.length, 4);
  assert.strictEqual(n("الكل", 4).numbers.length, 4);
  assert.strictEqual(n("").error, "empty");
  assert.strictEqual(n("see notes").error, "no_numbers");
});

test("parseNumbers: out-of-range numbers are an error, never silently dropped", () => {
  const r = F.parseNumbers("3, 25, 0", 20);
  assert.strictEqual(r.error, "out_of_range");
  assert.deepStrictEqual(r.bad.sort(), [0, 25]);
  assert.strictEqual(F.parseNumbers("18-22", 20).error, "out_of_range");
});

// ---------------------------------------------------------- unit: spreadsheets
async function xlsx(rows, sheetName = "Feedback") {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet(sheetName).addRows(rows);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("parseSpreadsheet reads xlsx (incl. numeric cells, rich text) and csv", async () => {
  const buf = await xlsx([["Title row only"], ["File", "Recording", "Issue"], ["Eagle-male-adult-30.zip", 3, "noise"], ["Falcon-female-adult-22.zip", "4-5", { richText: [{ text: "clip" }, { text: "ping" }] }]]);
  const sheets = await F.parseSpreadsheet(buf, "fb.xlsx");
  const s = F.sheetSummary(sheets[0]);
  assert.strictEqual(s.headerRow, 2, "skips a one-cell title row");
  assert.deepStrictEqual(s.columns.map((c) => c.header), ["File", "Recording", "Issue"]);
  assert.deepStrictEqual(s.guess, { labelCol: 0, labelType: "zip", numbersCol: 1, descCol: 2 });
  assert.strictEqual(sheets[0].grid[2][1], "3");
  assert.strictEqual(sheets[0].grid[3][2], "clipping");

  const csv = Buffer.from("name,recordings,comment\nEagle,\"2,4\",bad\n");
  const c = await F.parseSpreadsheet(csv, "fb.csv");
  assert.deepStrictEqual(c[0].grid[1], ["Eagle", "2,4", "bad"]);

  await assert.rejects(() => F.parseSpreadsheet(Buffer.from("not a spreadsheet"), "x.xlsx"), /Excel/);
});

test("guessColumns understands Arabic headers too", () => {
  const g = F.guessColumns(["اسم المتسجل", "رقم التسجيل", "الملاحظات"]);
  assert.deepStrictEqual(g, { labelCol: 0, labelType: "fake", numbersCol: 1, descCol: 2 });
});

test("extractRows pulls the 3 mapped columns and validates the mapping", async () => {
  const sheets = await F.parseSpreadsheet(await xlsx([["a", "b", "c"], ["x", "1", "p"], ["y", "2", "q"]]), "f.xlsx");
  const { rows, startRow } = F.extractRows(sheets[0], { headerRow: 1, labelCol: 0, numbersCol: 1, descCol: 2 });
  assert.deepStrictEqual(rows, [["x", "1", "p"], ["y", "2", "q"]]);
  assert.strictEqual(startRow, 2);
  assert.throws(() => F.extractRows(sheets[0], { headerRow: 1, labelCol: 9, numbersCol: 1, descCol: -1 }), /اختار/);
  assert.throws(() => F.extractRows(sheets[0], { headerRow: 99, labelCol: 0, numbersCol: 1, descCol: -1 }), /صف العناوين/);
});

// ------------------------------------------------------------------ flow (DB)
const URL_DB = process.env.TEST_DATABASE_URL;
const t = URL_DB ? test : test.skip;
let pool, base;
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
let counter = 0;

async function seed(sampleCount = 5) {
  await pool.query(`TRUNCATE studio_feedback_items, studio_delivery_batch_sessions, studio_delivery_batches, recording_session_samples,
    recording_sessions, recording_samples, recording_tasks, studio_talents, studio_leaders, studio_qa_reviewers, studio_head_leaders CASCADE`);
  const hl = await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Head','h@x.com','x') RETURNING id`);
  const leader = await one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('Lea Leader','l@x.com','x','L001') RETURNING id`);
  const qa = await one(`INSERT INTO studio_qa_reviewers (name,email,password_hash) VALUES ('QA One','q@x.com','x') RETURNING id`);
  const task = await one(`INSERT INTO recording_tasks (title,head_leader_id,quantity) VALUES ('FB Task',$1,50) RETURNING id`, [hl.id]);
  const samples = [];
  for (let i = 0; i < sampleCount; i++) samples.push(await one(`INSERT INTO recording_samples (task_id,sentence_name,order_index) VALUES ($1,$2,$3) RETURNING id`, [task.id, `Sentence ${i + 1}`, i]));
  return { hl, leader, qa, task, samples };
}
async function addSession(b, { fake, status = "approved", gender = "male", withSamples = true }) {
  counter++;
  const tal = await one(`INSERT INTO studio_talents (name,email,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`Real ${fake}`, `${fake.toLowerCase()}@mail.com`]);
  const s = await one(
    `INSERT INTO recording_sessions (task_id,leader_id,talent_id,session_token,gender,age_bracket,age,fake_name,status,zip_file_url,zip_file_name,qa_reviewer_id,qa_reviewed_at)
     VALUES ($1,$2,$3,$4,$5,'adult',30,$6,$7,$8,$9,$10,now()) RETURNING id`,
    [b.task.id, b.leader.id, tal.id, `tok${counter}`, gender, fake, status, `https://drive.google.com/file/d/Z${counter}abcdefghijklmnopqrstuvwxyz/view`, `${fake}-${gender}-adult-30.zip`, b.qa.id]);
  if (withSamples) for (const sm of b.samples) await pool.query(`INSERT INTO recording_session_samples (session_id,sample_id,audio_file_url,qa_status) VALUES ($1,$2,'drive:x','approved')`, [s.id, sm.id]);
  return { id: s.id, talentId: tal.id };
}
async function deliver(b, session) {   // put the session into a delivered batch, with the immutable snapshot
  const batch = await one(`INSERT INTO studio_delivery_batches (task_id,gender,qa_reviewer_id,group_day,status,session_count,zip_file_url) VALUES ($1,'male',$2,current_date,'delivered',1,'https://drive.google.com/file/d/BIG/view') RETURNING id`, [b.task.id, b.qa.id]);
  await pool.query(`UPDATE recording_sessions SET delivery_batch_id=$1 WHERE id=$2`, [batch.id, session.id]);
  await pool.query(`INSERT INTO studio_delivery_batch_sessions (batch_id,session_id,zip_file_name) SELECT $1,id,zip_file_name FROM recording_sessions WHERE id=$2`, [batch.id, session.id]);
  return batch;
}
const sampleState = async (sessionId) => (await pool.query(
  `SELECT s.order_index+1 AS n, ss.qa_status, ss.qa_reason FROM recording_session_samples ss JOIN recording_samples s ON s.id=ss.sample_id WHERE ss.session_id=$1 ORDER BY s.order_index`, [sessionId])).rows;

t("flow: setup", async () => { const { Pool } = require("pg"); pool = new Pool({ connectionString: URL_DB }); await pool.query("SELECT 1"); });

t("preview matches rows to people and explains every bad row (writes nothing)", async () => {
  base = await seed(5);
  const eagle = await addSession(base, { fake: "Eagle" });
  await addSession(base, { fake: "Falcon", gender: "female" });
  await addSession(base, { fake: "Wip", status: "in_progress", withSamples: false });
  await addSession(base, { fake: "AtQa", status: "submitted" });
  const rows = [
    ["Eagle-male-adult-30.zip", "2, 4", "background noise"],
    ["falcon", "٣", ""],                       // other case + Arabic digit + no description
    ["Nobody-male-adult-30.zip", "1", "x"],
    ["Eagle-male-adult-30.zip", "9", "bad number"],
    ["Wip", "1", ""],
    ["AtQa", "1", ""],
    ["", "", ""],                              // blank row is ignored entirely
    ["Falcon", "see notes", ""],
  ];
  const out = await F.resolveRows({ db: pool, taskId: base.task.id, labelType: "fake", rows, startRow: 2 });
  assert.deepStrictEqual(out.summary, { total: 7, ok: 2, errors: 5, sessions: 2 });
  const byRow = Object.fromEntries(out.results.map((r) => [r.row, r]));
  assert.strictEqual(byRow[2].ok, true);
  assert.strictEqual(byRow[2].session.email, "eagle@mail.com");
  assert.strictEqual(byRow[2].session.realName, "Real Eagle");
  assert.strictEqual(byRow[2].session.leaderCode, "L001");
  assert.deepStrictEqual(byRow[3].numbers, [3]);
  assert.strictEqual(byRow[4].code, "no_session");
  assert.strictEqual(byRow[5].code, "out_of_range");
  assert.strictEqual(byRow[6].code, "in_progress");
  assert.strictEqual(byRow[7].code, "submitted");
  assert.strictEqual(byRow[9].code, "bad_numbers");
  assert.strictEqual((await sampleState(eagle.id)).every((s) => s.qa_status === "approved"), true, "preview must not change anything");
  assert.strictEqual((await pool.query(`SELECT count(*)::int c FROM studio_feedback_items`)).rows[0].c, 0);
});

t("apply: ONLY the named recordings go back, 12h deadline starts, delivered archive stays intact", async () => {
  base = await seed(5);
  const eagle = await addSession(base, { fake: "Eagle" });
  const falcon = await addSession(base, { fake: "Falcon", gender: "female" });
  const batch = await deliver(base, eagle);
  const rows = [
    ["Eagle-male-adult-30.zip", "2, 4", "background noise"],
    ["Eagle-male-adult-30.zip", "4", "also clipped"],   // same recording, second comment
    ["Falcon", "1-2", ""],
    ["Nobody", "1", "skipped"],
  ];
  const before = Date.now();
  const res = await F.applyFeedback({ db: pool, taskId: base.task.id, labelType: "fake", rows, startRow: 2, headLeaderId: base.hl.id });
  assert.strictEqual(res.sessions, 2);
  assert.strictEqual(res.items, 3);
  assert.strictEqual(res.samples, 4, "Eagle 2 and 4, Falcon 1 and 2");
  assert.strictEqual(res.skipped.length, 1);
  assert.strictEqual(res.skipped[0].label, "Nobody");

  const e = await sampleState(eagle.id);
  assert.deepStrictEqual(e.map((s) => s.qa_status), ["approved", "rejected", "approved", "rejected", "approved"]);
  assert.strictEqual(e[1].qa_reason, "background noise");
  assert.strictEqual(e[3].qa_reason, "background noise | also clipped", "both comments kept for recording 4");

  const sess = await one(`SELECT status, rejection_reason, rework_deadline, delivery_batch_id FROM recording_sessions WHERE id=$1`, [eagle.id]);
  assert.strictEqual(sess.status, "rejected");
  assert.match(sess.rejection_reason, /تسجيل 2: background noise/);
  const hours = (new Date(sess.rework_deadline).getTime() - before) / 3600000;
  assert.ok(hours > 11.99 && hours < 12.01, `deadline is ${hours}h away`);
  assert.strictEqual(sess.delivery_batch_id, null, "released so it can be delivered again after rework");

  // the old batch still shows exactly what was delivered
  const archived = await D.fetchBatchRows(pool, batch.id);
  assert.deepStrictEqual(archived.map((r) => r.fake_name), ["Eagle"]);
  assert.strictEqual(archived[0].zip_file_name, "Eagle-male-adult-30.zip");

  const items = await pool.query(`SELECT * FROM studio_feedback_items ORDER BY source_row`);
  assert.strictEqual(items.rows.length, 3);
  assert.deepStrictEqual(items.rows[0].recording_numbers, [2, 4]);
  assert.strictEqual(items.rows[0].previous_batch_id, batch.id);
  assert.strictEqual(new Set(items.rows.map((r) => r.upload_id)).size, 1);
  assert.strictEqual(items.rows[0].leader_id, base.leader.id);
  // rejected sessions are not waiting for delivery
  assert.strictEqual((await D.fetchPending(pool)).length, 0);
});

t("full cycle: acknowledge -> talent resubmits -> reworked -> QA approves -> back in the delivery list flagged as re-delivery", async () => {
  base = await seed(3);
  const eagle = await addSession(base, { fake: "Eagle" });
  await deliver(base, eagle);
  await F.applyFeedback({ db: pool, taskId: base.task.id, labelType: "fake", rows: [["Eagle", "2", "echo"]], startRow: 2, headLeaderId: base.hl.id });

  await F.markAcknowledged(pool, eagle.id);
  assert.strictEqual((await one(`SELECT status FROM studio_feedback_items`)).status, "acknowledged");

  // talent re-records recording 2 and re-submits (what the upload + submit routes do)
  await pool.query(`UPDATE recording_session_samples SET qa_status='pending', qa_reason=NULL WHERE session_id=$1 AND qa_status='rejected'`, [eagle.id]);
  await pool.query(`UPDATE recording_sessions SET status='submitted', rejection_reason=NULL, rework_deadline=NULL WHERE id=$1`, [eagle.id]);
  await F.markReworked(pool, eagle.id);
  const item = await one(`SELECT status, reworked_at FROM studio_feedback_items`);
  assert.strictEqual(item.status, "reworked");
  assert.ok(item.reworked_at);

  // QA approves again -> it is waiting for delivery again, marked as a re-delivery
  await pool.query(`UPDATE recording_sessions SET status='approved', qa_reviewed_at=now() WHERE id=$1`, [eagle.id]);
  const pending = await D.fetchPending(pool);
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].is_redelivery, true);
  assert.strictEqual(D.buildPendingTree(pending)[0].genders.male[0].sessions[0].isRedelivery, true);
});

t("feedback on a session that is being collected right now is refused", async () => {
  base = await seed(3);
  const eagle = await addSession(base, { fake: "Eagle" });
  const b = await one(`INSERT INTO studio_delivery_batches (task_id,gender,qa_reviewer_id,group_day,status) VALUES ($1,'male',$2,current_date,'collecting') RETURNING id`, [base.task.id, base.qa.id]);
  await pool.query(`UPDATE recording_sessions SET delivery_batch_id=$1 WHERE id=$2`, [b.id, eagle.id]);
  const out = await F.resolveRows({ db: pool, taskId: base.task.id, labelType: "fake", rows: [["Eagle", "1", ""]], startRow: 2 });
  assert.strictEqual(out.results[0].code, "collecting");
  await assert.rejects(() => F.applyFeedback({ db: pool, taskId: base.task.id, labelType: "fake", rows: [["Eagle", "1", ""]], startRow: 2, headLeaderId: base.hl.id }), /مفيش أي صف صالح/);
});

t("applying twice in a row merges cleanly (a session already in rework gets more recordings + a fresh 12h)", async () => {
  base = await seed(5);
  const eagle = await addSession(base, { fake: "Eagle" });
  await F.applyFeedback({ db: pool, taskId: base.task.id, labelType: "fake", rows: [["Eagle", "1", "a"]], startRow: 2, headLeaderId: base.hl.id });
  await pool.query(`UPDATE recording_sessions SET rework_deadline = now() + interval '1 hour' WHERE id=$1`, [eagle.id]);
  const r2 = await F.applyFeedback({ db: pool, taskId: base.task.id, labelType: "fake", rows: [["Eagle", "3", "b"]], startRow: 2, headLeaderId: base.hl.id });
  assert.strictEqual(r2.sessions, 1);
  assert.deepStrictEqual((await sampleState(eagle.id)).map((s) => s.qa_status), ["rejected", "approved", "rejected", "approved", "approved"]);
  const dl = await one(`SELECT rework_deadline FROM recording_sessions WHERE id=$1`, [eagle.id]);
  assert.ok(new Date(dl.rework_deadline) - Date.now() > 11 * 3600000, "deadline was renewed to ~12h");
});

t("listings: talent sees own items with their link; leader sees the team with real names; overdue is computed", async () => {
  base = await seed(3);
  const eagle = await addSession(base, { fake: "Eagle" });
  const falcon = await addSession(base, { fake: "Falcon" });
  await F.applyFeedback({ db: pool, taskId: base.task.id, labelType: "fake", rows: [["Eagle", "1", "echo"], ["Falcon", "2", "clipping"]], startRow: 2, headLeaderId: base.hl.id });
  await pool.query(`UPDATE studio_feedback_items SET rework_deadline = now() - interval '1 hour' WHERE fake_name = 'Falcon'`);

  const mineTalent = await F.listMine(pool, "talent", eagle.talentId);
  assert.strictEqual(mineTalent.length, 1, "a talent only sees their own");
  assert.ok(mineTalent[0].session_token, "talent gets the link to the rework screen");
  assert.ok(!("real_name" in mineTalent[0]) && !("email" in mineTalent[0]));
  assert.strictEqual(mineTalent[0].overdue, false);
  assert.deepStrictEqual(mineTalent[0].recording_numbers, [1]);

  const mineLeader = await F.listMine(pool, "leader", base.leader.id);
  assert.strictEqual(mineLeader.length, 2);
  assert.ok(mineLeader.every((i) => i.real_name && i.email && !("session_token" in i)), "leader sees real names, never the talent's private link");
  assert.strictEqual(mineLeader.find((i) => i.fake_name === "Falcon").overdue, true);

  const hl = await F.listForHeadLeader(pool, {});
  assert.strictEqual(hl.length, 2);
  assert.ok(!("session_token" in hl[0]));
  assert.strictEqual((await F.listForHeadLeader(pool, { taskId: base.task.id })).length, 2);
  assert.strictEqual((await F.listForHeadLeader(pool, { taskId: "00000000-0000-0000-0000-000000000000" })).length, 0);

  // once reworked it is never "overdue" any more
  await F.markReworked(pool, falcon.id);
  assert.strictEqual((await F.listMine(pool, "leader", base.leader.id)).find((i) => i.fake_name === "Falcon").overdue, false);
});

t("flow: teardown", async () => { await pool.end(); });
