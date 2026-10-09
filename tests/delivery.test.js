// Integration tests for Phase 6 against a REAL Postgres (set TEST_DATABASE_URL;
// without it these tests are skipped so `npm test` still works anywhere).
//   TEST_DATABASE_URL=postgres://postgres:test@localhost/nativoya_test npm test
const test = require("node:test");
const assert = require("node:assert");
const { Readable, Writable } = require("node:stream");
const ExcelJS = require("exceljs");
const D = require("../config/studioDelivery.js");

const URL = process.env.TEST_DATABASE_URL;
const t = URL ? test : test.skip;
let pool;

// ---------------------------------------------------------------- helpers
async function reset() {
  await pool.query(`TRUNCATE studio_delivery_batches, recording_session_samples, recording_sessions, recording_samples,
    recording_tasks, studio_talents, studio_leaders, studio_qa_reviewers, studio_head_leaders CASCADE`);
}
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

async function seedBase() {
  const hl = await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Head','h@x.com','x') RETURNING id`);
  const leader = await one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('Lea','l@x.com','x','L001') RETURNING id`);
  const qa1 = await one(`INSERT INTO studio_qa_reviewers (name,email,password_hash) VALUES ('QA One','q1@x.com','x') RETURNING id`);
  const qa2 = await one(`INSERT INTO studio_qa_reviewers (name,email,password_hash) VALUES ('QA Two','q2@x.com','x') RETURNING id`);
  const taskA = await one(`INSERT INTO recording_tasks (title,head_leader_id,quantity) VALUES ('Task A',$1,50) RETURNING id`, [hl.id]);
  const taskB = await one(`INSERT INTO recording_tasks (title,head_leader_id,quantity) VALUES ('Task B',$1,50) RETURNING id`, [hl.id]);
  return { hl, leader, qa1, qa2, taskA, taskB };
}

let counter = 0;
async function addSession(base, o) {
  counter++;
  const talent = await one(
    `INSERT INTO studio_talents (name,email,password_hash,whatsapp) VALUES ($1,$2,'x','0100000${counter}') RETURNING id`,
    [o.realName || `Real ${counter}`, o.email || `t${counter}@mail.com`]
  );
  const fake = o.fake || `Fake${counter}`;
  return one(
    `INSERT INTO recording_sessions (task_id,leader_id,talent_id,session_token,gender,age_bracket,age,fake_name,status,
        zip_file_url,zip_file_name,qa_reviewer_id,qa_reviewed_at)
     VALUES ($1,$2,$3,$4,$5,'adult',$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [o.task.id, base.leader.id, talent.id, `tok${counter}`, o.gender || "male", o.age || 30, fake,
     o.status || "approved",
     o.zipUrl === undefined ? `https://drive.google.com/file/d/FILE${counter}abcdefghijklmnopqrstuvwxyz/view` : o.zipUrl,
     o.zipName || `${fake}-${o.gender || "male"}-adult-30.zip`,
     o.qa === undefined ? base.qa1.id : (o.qa && o.qa.id), o.at || "2026-01-10T10:00:00Z"]
  );
}

// ---- tiny ZIP reader (central directory) so tests don't depend on unzip/adm-zip
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  assert.ok(eocd >= 0, "not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 24), nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32), localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    out[name] = buf.subarray(dataStart, dataStart + size);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function fakeStorage({ contents, delayMs = 0, failId = null, captured }) {
  return D.createArchiveStorage({
    openSessionZip: async (session) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (failId && session.id === failId) throw new Error("drive download failed");
      return Readable.from([contents.get(session.id) || Buffer.from("zipbytes-" + session.id)]);
    },
    uploadStream: ({ fileName, stream }) => new Promise((resolve, reject) => {
      const chunks = [];
      stream.pipe(new Writable({
        write(c, _e, cb) { chunks.push(c); cb(); },
        final(cb) { const buf = Buffer.concat(chunks); captured.push({ fileName, buf }); resolve({ url: "https://drive.google.com/file/d/BIG/view", size: buf.length }); cb(); },
      })).on("error", reject);
      stream.on("error", reject);
    }),
  });
}

const GROUP = (base, task, qa, gender = "male", day = "2026-01-10") =>
  ({ taskId: task.id, gender, qaReviewerId: qa ? qa.id : null, day });

// ------------------------------------------------------------------ tests
t("setup", async () => {
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: URL });
  await pool.query("SELECT 1");
});

t("pending tree: grouped by task > gender > QA+day, excludes rejected / no-zip / already delivered", async () => {
  await reset();
  const b = await seedBase();
  await addSession(b, { task: b.taskA, qa: b.qa1, at: "2026-01-10T08:00:00Z" });
  await addSession(b, { task: b.taskA, qa: b.qa1, at: "2026-01-10T12:00:00Z" });
  await addSession(b, { task: b.taskA, qa: b.qa2, at: "2026-01-10T09:00:00Z" });
  await addSession(b, { task: b.taskA, qa: b.qa1, at: "2026-01-11T09:00:00Z" });
  await addSession(b, { task: b.taskA, qa: b.qa1, gender: "female", at: "2026-01-10T09:00:00Z" });
  await addSession(b, { task: b.taskB, qa: b.qa1 });
  await addSession(b, { task: b.taskA, qa: b.qa1, status: "rejected" });
  await addSession(b, { task: b.taskA, qa: b.qa1, zipUrl: null });
  const delivered = await addSession(b, { task: b.taskA, qa: b.qa1 });
  const batch = await one(`INSERT INTO studio_delivery_batches (task_id,gender,qa_reviewer_id,group_day,status) VALUES ($1,'male',$2,'2026-01-10','delivered') RETURNING id`, [b.taskA.id, b.qa1.id]);
  await pool.query(`UPDATE recording_sessions SET delivery_batch_id=$1 WHERE id=$2`, [batch.id, delivered.id]);

  const tree = D.buildPendingTree(await D.fetchPending(pool));
  const A = tree.find((x) => x.title === "Task A");
  assert.strictEqual(A.total, 5);
  assert.strictEqual(A.genders.male.length, 3);
  assert.strictEqual(A.genders.female.length, 1);
  assert.deepStrictEqual(A.genders.male.map((g) => g.day), ["2026-01-11", "2026-01-10", "2026-01-10"]); // newest day first
  const qa1Day10 = A.genders.male.find((g) => g.day === "2026-01-10" && g.qaName === "QA One");
  assert.strictEqual(qa1Day10.sessions.length, 2);
  assert.ok(qa1Day10.firstAt < qa1Day10.lastAt);
  const s = qa1Day10.sessions[0];
  assert.ok(s.email && s.realName && s.fakeName, "each session shows email + real name + fake name");
  assert.strictEqual(tree.find((x) => x.title === "Task B").total, 1);
});

t("review day is computed in Cairo time (23:30 vs 00:30 land on different days)", async () => {
  await reset();
  const b = await seedBase();
  await addSession(b, { task: b.taskA, at: "2026-01-10T21:30:00Z" }); // 23:30 Cairo, Jan 10
  await addSession(b, { task: b.taskA, at: "2026-01-10T22:30:00Z" }); // 00:30 Cairo, Jan 11
  const days = D.buildPendingTree(await D.fetchPending(pool))[0].genders.male.map((g) => g.day).sort();
  assert.deepStrictEqual(days, ["2026-01-10", "2026-01-11"]);
});

t("legacy approved sessions with no QA reviewer still group and collect", async () => {
  await reset();
  const b = await seedBase();
  await addSession(b, { task: b.taskA, qa: null });
  const g = D.buildPendingTree(await D.fetchPending(pool))[0].genders.male[0];
  assert.strictEqual(g.qaReviewerId, null);
  const captured = [];
  const res = await D.collectGroup({ db: pool, storage: fakeStorage({ contents: new Map(), captured }), params: g.params, headLeaderId: b.hl.id });
  assert.strictEqual(res.session_count, 1);
});

t("collect: one big ZIP with every session ZIP intact, batch delivered, group leaves the waiting list", async () => {
  await reset();
  const b = await seedBase();
  const s1 = await addSession(b, { task: b.taskA, zipName: "Same-name.zip" });
  const s2 = await addSession(b, { task: b.taskA, zipName: "Same-name.zip" }); // collision on purpose
  const s3 = await addSession(b, { task: b.taskA, zipName: "Other.zip" });
  await addSession(b, { task: b.taskA, qa: b.qa2 }); // other QA -> must NOT be collected
  const contents = new Map([[s1.id, Buffer.from("AAAA-111")], [s2.id, Buffer.from("BBBB-222")], [s3.id, Buffer.from("CCCC-333")]]);
  const captured = [];

  const res = await D.collectGroup({ db: pool, storage: fakeStorage({ contents, captured }), params: GROUP(b, b.taskA, b.qa1), headLeaderId: b.hl.id });
  assert.strictEqual(res.session_count, 3);
  assert.ok(res.zip_file_name.startsWith("Delivery - Task A - Male - QA One - 2026-01-10"));

  const entries = readZip(captured[0].buf);
  assert.deepStrictEqual(Object.keys(entries).sort(), ["Other.zip", "Same-name-2.zip", "Same-name.zip"]);
  assert.strictEqual(entries["Same-name.zip"].toString(), "AAAA-111");
  assert.strictEqual(entries["Same-name-2.zip"].toString(), "BBBB-222");
  assert.strictEqual(entries["Other.zip"].toString(), "CCCC-333");

  const tree = D.buildPendingTree(await D.fetchPending(pool));
  assert.strictEqual(tree[0].total, 1, "only the other-QA session is still waiting");
  const archive = await D.listDelivered(pool);
  assert.strictEqual(archive.length, 1);
  assert.strictEqual(archive[0].status, "delivered");
  assert.strictEqual(archive[0].qa_name, "QA One");
  assert.strictEqual(archive[0].session_count, 3);
  const batchRows = await D.fetchBatchRows(pool, archive[0].id);
  assert.strictEqual(batchRows.length, 3, "archive sheet can still be rebuilt from the batch");
});

t("collect failure (Drive error) puts every session back, marks the batch failed, and retry works", async () => {
  await reset();
  const b = await seedBase();
  const s1 = await addSession(b, { task: b.taskA });
  const s2 = await addSession(b, { task: b.taskA });
  const failing = fakeStorage({ contents: new Map(), failId: s2.id, captured: [] });
  await assert.rejects(() => D.collectGroup({ db: pool, storage: failing, params: GROUP(b, b.taskA, b.qa1), headLeaderId: b.hl.id }), /drive download failed/);

  assert.strictEqual((await D.fetchPending(pool)).length, 2, "nothing was hidden by the failed attempt");
  const batches = (await pool.query(`SELECT status, error FROM studio_delivery_batches`)).rows;
  assert.deepStrictEqual(batches.map((x) => x.status), ["failed"]);
  assert.match(batches[0].error, /drive download failed/);
  assert.strictEqual((await D.listDelivered(pool)).length, 0, "failed attempts don't pollute the delivered archive");

  const captured = [];
  const ok = await D.collectGroup({ db: pool, storage: fakeStorage({ contents: new Map(), captured }), params: GROUP(b, b.taskA, b.qa1), headLeaderId: b.hl.id });
  assert.strictEqual(ok.session_count, 2);
  assert.strictEqual((await D.fetchPending(pool)).length, 0);
});

t("double-click / two head leaders at once: exactly one collect wins, the other gets 409", async () => {
  await reset();
  const b = await seedBase();
  for (let i = 0; i < 4; i++) await addSession(b, { task: b.taskA });
  const captured = [];
  const mk = () => D.collectGroup({ db: pool, storage: fakeStorage({ contents: new Map(), delayMs: 60, captured }), params: GROUP(b, b.taskA, b.qa1), headLeaderId: b.hl.id });
  const results = await Promise.allSettled([mk(), mk(), mk()]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const conflicts = results.filter((r) => r.status === "rejected" && r.reason.statusCode === 409);
  assert.strictEqual(ok.length, 1);
  assert.strictEqual(conflicts.length, 2);
  assert.strictEqual(captured.length, 1, "the big ZIP was built exactly once");
  assert.strictEqual((await pool.query(`SELECT count(*)::int c FROM studio_delivery_batches`)).rows[0].c, 1, "losers leave no junk batch rows");
});

t("a collect that died mid-way is released after the stale window", async () => {
  await reset();
  const b = await seedBase();
  const s = await addSession(b, { task: b.taskA });
  const batch = await one(`INSERT INTO studio_delivery_batches (task_id,gender,qa_reviewer_id,group_day,status,created_at) VALUES ($1,'male',$2,'2026-01-10','collecting', now() - interval '30 minutes') RETURNING id`, [b.taskA.id, b.qa1.id]);
  await pool.query(`UPDATE recording_sessions SET delivery_batch_id=$1 WHERE id=$2`, [batch.id, s.id]);
  assert.strictEqual((await D.fetchPending(pool)).length, 0, "claimed while the batch looks alive");
  await D.releaseStaleBatches(pool);
  assert.strictEqual((await D.fetchPending(pool)).length, 1, "released after 15 min");
  assert.strictEqual((await one(`SELECT status FROM studio_delivery_batches WHERE id=$1`, [batch.id])).status, "failed");
});

t("sheet: Delivery tab is safe to share (no real names/emails); Internal tab has them", async () => {
  await reset();
  const b = await seedBase();
  await addSession(b, { task: b.taskA, fake: "Eagle", realName: "Mohamed Real", email: "mo@secret.com", age: 41 });
  await addSession(b, { task: b.taskA, fake: "Falcon", realName: "Sara Real", email: "sara@secret.com" });
  const rows = await D.fetchGroupRows(pool, GROUP(b, b.taskA, b.qa1));
  const buf = await D.buildSheet(rows, { taskTitle: "Task A", gender: "male", qaName: "QA One", day: "2026-01-10" });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ["Delivery", "Internal - do not share", "Info"]);
  const delivery = wb.getWorksheet("Delivery");
  assert.strictEqual(delivery.rowCount, 3);
  assert.strictEqual(delivery.getRow(2).getCell(2).value, "Eagle");
  const everything = JSON.stringify(delivery.getSheetValues());
  assert.ok(!/Real|secret\.com/.test(everything), "buyer-facing sheet must not leak private data");
  const internal = wb.getWorksheet("Internal - do not share");
  assert.strictEqual(internal.getRow(2).getCell(3).value, "Mohamed Real");
  assert.strictEqual(internal.getRow(2).getCell(4).value, "mo@secret.com");
  assert.strictEqual(wb.getWorksheet("Info").getRow(1).getCell(2).value, "Task A");
});

t("teardown", async () => { await pool.end(); });
