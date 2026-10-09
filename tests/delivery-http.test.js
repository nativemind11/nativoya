// HTTP-level test of /api/studio/delivery (auth, validation, sheet download,
// collect success + failure). Needs TEST_DATABASE_URL, otherwise skipped.
const URL_DB = process.env.TEST_DATABASE_URL;
const test = require("node:test");
const assert = require("node:assert");
const t = URL_DB ? test : test.skip;

let server, base, pool, ids, token, qaToken, jwt, ExcelJS;
let storageMode = "ok";

t("boot", async () => {
  process.env.DATABASE_URL = URL_DB;
  process.env.JWT_SECRET = "test-secret";
  const express = require("express");
  jwt = require("jsonwebtoken");
  ExcelJS = require("exceljs");
  ({ pool } = require("../db/pool"));

  // swap the Drive-backed storage for a controllable fake BEFORE the router loads
  const storagePath = require.resolve("../config/studioDeliveryStorage.js");
  const D = require("../config/studioDelivery.js");
  const fake = D.createArchiveStorage({
    openSessionZip: async (s) => require("node:stream").Readable.from([Buffer.from("zip-" + s.id)]),
    uploadStream: ({ stream }) => new Promise((resolve, reject) => {
      if (storageMode === "fail") { stream.resume(); return reject(new Error("Drive is down")); }
      const chunks = [];
      stream.on("data", (c) => chunks.push(c)).on("end", () => resolve({ url: "https://drive.google.com/file/d/BIG/view", size: Buffer.concat(chunks).length })).on("error", reject);
    }),
  });
  require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: { driveStorage: fake } };

  const app = express();
  app.use(express.json());
  app.use("/api/studio/delivery", require("../routes/studio/delivery"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/studio/delivery`;

  await pool.query(`TRUNCATE studio_delivery_batches, recording_session_samples, recording_sessions, recording_samples,
    recording_tasks, studio_talents, studio_leaders, studio_qa_reviewers, studio_head_leaders CASCADE`);
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const hl = await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Head','h@x.com','x') RETURNING id`);
  const leader = await one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('Lea','l@x.com','x','L001') RETURNING id`);
  const qa = await one(`INSERT INTO studio_qa_reviewers (name,email,password_hash) VALUES ('QA One','q1@x.com','x') RETURNING id`);
  const task = await one(`INSERT INTO recording_tasks (title,head_leader_id,quantity) VALUES ('HTTP Task',$1,10) RETURNING id`, [hl.id]);
  for (let i = 1; i <= 3; i++) {
    const tal = await one(`INSERT INTO studio_talents (name,email,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`Person ${i}`, `p${i}@mail.com`]);
    await pool.query(
      `INSERT INTO recording_sessions (task_id,leader_id,talent_id,session_token,gender,age_bracket,age,fake_name,status,zip_file_url,zip_file_name,qa_reviewer_id,qa_reviewed_at)
       VALUES ($1,$2,$3,$4,'female','adult',30,$5,'approved','https://drive.google.com/file/d/X'||$4,$6,$7,'2026-01-10T10:00:00Z')`,
      [task.id, leader.id, tal.id, `httptok${i}`, `Fake${i}`, `Fake${i}-female-adult-30.zip`, qa.id]);
  }
  ids = { hl: hl.id, qa: qa.id, task: task.id };
  token = jwt.sign({ id: hl.id, studioRole: "head_leader" }, "test-secret");
  qaToken = jwt.sign({ id: qa.id, studioRole: "qa" }, "test-secret");
});

const call = (path, { method = "GET", tok = token, body } = {}) =>
  fetch(base + path, { method, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const group = () => ({ taskId: ids.task, gender: "female", qaReviewerId: ids.qa, day: "2026-01-10" });

t("only a head leader can use it (no token = 401, QA = 403)", async () => {
  assert.strictEqual((await call("/pending", { tok: null })).status, 401);
  assert.strictEqual((await call("/pending", { tok: qaToken })).status, 403);
  assert.strictEqual((await call("/collect", { tok: qaToken, method: "POST", body: group() })).status, 403);
});

t("pending returns the nested tree with email + real name + fake name", async () => {
  const res = await call("/pending");
  assert.strictEqual(res.status, 200);
  const { tasks } = await res.json();
  assert.strictEqual(tasks[0].title, "HTTP Task");
  const g = tasks[0].genders.female[0];
  assert.strictEqual(g.sessions.length, 3);
  assert.strictEqual(g.qaName, "QA One");
  assert.ok(g.sessions[0].email.endsWith("@mail.com") && g.sessions[0].realName && g.sessions[0].fakeName);
  assert.deepStrictEqual(tasks[0].genders.male, []);
});

t("bad group parameters are rejected with 400 (no SQL injection surface)", async () => {
  assert.strictEqual((await call("/collect", { method: "POST", body: { ...group(), taskId: "1; DROP TABLE x" } })).status, 400);
  assert.strictEqual((await call("/collect", { method: "POST", body: { ...group(), gender: "other" } })).status, 400);
  assert.strictEqual((await call("/collect", { method: "POST", body: { ...group(), day: "yesterday" } })).status, 400);
  assert.strictEqual((await call(`/sheet?taskId=${ids.task}&gender=female&qaReviewerId=oops&day=2026-01-10`)).status, 400);
});

t("sheet downloads a real .xlsx for a waiting group", async () => {
  const q = new URLSearchParams({ taskId: ids.task, gender: "female", qaReviewerId: ids.qa, day: "2026-01-10" });
  const res = await call(`/sheet?${q}`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("content-type"), /spreadsheetml/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(buf.subarray(0, 2).toString(), "PK");
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  assert.strictEqual(wb.getWorksheet("Delivery").rowCount, 4);
});

t("collect while Drive is down: 500, and the group is still waiting (nothing lost)", async () => {
  storageMode = "fail";
  const res = await call("/collect", { method: "POST", body: group() });
  assert.strictEqual(res.status, 500);
  const { tasks } = await (await call("/pending")).json();
  assert.strictEqual(tasks[0].genders.female[0].sessions.length, 3);
  assert.strictEqual((await (await call("/delivered")).json()).batches.length, 0);
});

t("collect success: group leaves pending, appears in delivered, batch sheet still downloads; repeat gets 409", async () => {
  storageMode = "ok";
  const res = await call("/collect", { method: "POST", body: group() });
  assert.strictEqual(res.status, 200);
  const { batch } = await res.json();
  assert.strictEqual(batch.session_count, 3);

  assert.deepStrictEqual((await (await call("/pending")).json()).tasks, []);
  const delivered = (await (await call("/delivered")).json()).batches;
  assert.strictEqual(delivered.length, 1);
  assert.strictEqual(delivered[0].task_title, "HTTP Task");

  const sheet = await call(`/batches/${delivered[0].id}/sheet`);
  assert.strictEqual(sheet.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await sheet.arrayBuffer()));
  assert.strictEqual(wb.getWorksheet("Delivery").rowCount, 4);

  assert.strictEqual((await call("/collect", { method: "POST", body: group() })).status, 409);
});

t("teardown", async () => { server.close(); await pool.end(); });
