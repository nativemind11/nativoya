// v8: the account carries gender / age / age bracket; "real name" tasks name files with the account's English name.
// Real HTTP + real Postgres (skipped without TEST_DATABASE_URL). It TRUNCATEs — never point it at a live database.
const URL_DB = process.env.TEST_DATABASE_URL;
const test = require("node:test");
const assert = require("node:assert");
const t = URL_DB ? test : test.skip;

let server, base, pool, jwt, ids = {};
const J = { "Content-Type": "application/json" };
const call = async (method, path, body, token) => {
  const r = await fetch(base + path, { method, headers: { ...J, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
};
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const signup = (o) => call("POST", "/api/studio/auth/talent/signup", { password: "secret1", ...o });

t("boot", async () => {
  process.env.DATABASE_URL = URL_DB; process.env.JWT_SECRET = "test-secret";
  const express = require("express"); jwt = require("jsonwebtoken");
  ({ pool } = require("../db/pool"));
  const app = express(); app.use(express.json());
  app.use("/api/studio/auth", require("../routes/studio/auth"));
  app.use("/api/studio/talent", require("../routes/studio/talent"));
  app.use("/api/studio/headleader", require("../routes/studio/headleader"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await pool.query(`TRUNCATE studio_feedback_items, studio_delivery_batch_sessions, studio_delivery_batches, recording_session_samples, recording_sessions,
    recording_samples, studio_task_scripts, recording_task_leaders, studio_task_quotas, studio_task_leader_quotas, recording_tasks, studio_talents, studio_leaders,
    studio_qa_reviewers, studio_head_leaders CASCADE`);
  ids.hl = (await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Head','h@x.com','x') RETURNING id`)).id;
  ids.leader = (await one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('Lea','l@x.com','x','L001') RETURNING id`)).id;
  ids.hlTok = jwt.sign({ id: ids.hl, studioRole: "head_leader" }, "test-secret");
});

const mkTask = async (title, { identity = "names", brackets = false, quotas = [], names = ["Fox", "Owl"] } = {}) => {
  const task = await one(`INSERT INTO recording_tasks (title, head_leader_id, identity_mode, use_age_brackets, fake_names, status, published_at)
    VALUES ($1,$2,$3,$4,$5,'published',now()) RETURNING id`, [title, ids.hl, identity, brackets, names]);
  await pool.query(`INSERT INTO recording_samples (task_id, sentence_name, order_index) VALUES ($1,'S0',0)`, [task.id]);
  await pool.query(`INSERT INTO recording_task_leaders (task_id, leader_id) VALUES ($1,$2)`, [task.id, ids.leader]);
  for (const q of quotas) await pool.query(`INSERT INTO studio_task_quotas (task_id, gender, age_bracket, max_count) VALUES ($1,$2,$3,$4)`, [task.id, q.g, q.b || "", q.max]);
  return task.id;
};
const start = (taskId, token, extra = {}) => call("POST", "/api/studio/talent/sessions", { taskId, leaderId: ids.leader, ...extra }, token);

t("signup: real data is validated, normalised and the bracket is computed", async () => {
  assert.equal((await signup({ name: "أحمد علي", email: "a@x.com", gender: "male", age: 27 })).status, 400, "Arabic name refused");
  assert.equal((await signup({ name: "Ahmed Ali", email: "a@x.com", age: 27 })).status, 400, "gender required");
  assert.equal((await signup({ name: "Ahmed Ali", email: "a@x.com", gender: "boy", age: 27 })).status, 400, "gender must be male/female");
  assert.equal((await signup({ name: "Ahmed Ali", email: "a@x.com", gender: "male" })).status, 400, "age required");
  assert.equal((await signup({ name: "Ahmed Ali", email: "a@x.com", gender: "male", age: "abc" })).status, 400);
  assert.equal((await signup({ name: "Ahmed Ali", email: "a@x.com", gender: "male", age: 2 })).status, 400, "too young");
  const ok = await signup({ name: "  Ahmed   Ali ", email: "a@x.com", gender: "male", age: "٢٧" });   // Arabic-Indic digits
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.data.user.name, ok.data.user.gender, ok.data.user.age, ok.data.user.age_bracket], ["Ahmed Ali", "male", 27, "adult"]);
  assert.equal((await signup({ name: "Kid", email: "k@x.com", gender: "female", age: 13 })).data.user.age_bracket, "child");
  assert.equal((await signup({ name: "Old Man", email: "o@x.com", gender: "male", age: 60 })).data.user.age_bracket, "elderly");
  assert.equal((await signup({ name: "Edge", email: "e@x.com", gender: "female", age: 59 })).data.user.age_bracket, "adult");
  assert.equal((await signup({ name: "Teen", email: "te@x.com", gender: "male", age: 14 })).data.user.age_bracket, "adult", "14 is the first adult age");
  assert.equal((await signup({ name: "Five", email: "f5@x.com", gender: "male", age: 5 })).data.user.age_bracket, "child");
  assert.equal((await signup({ name: "Eighty", email: "e80@x.com", gender: "female", age: 80 })).data.user.age_bracket, "elderly");
  assert.equal((await signup({ name: "TooOld", email: "e81@x.com", gender: "female", age: 81 })).status, 400, "81 is over the limit");
  assert.equal((await signup({ name: "Ahmed Ali", email: "a@x.com", gender: "male", age: 30 })).status, 409, "same email");
  const row = await one(`SELECT gender, age, age_bracket FROM studio_talents WHERE email='a@x.com'`);
  assert.deepEqual(row, { gender: "male", age: 27, age_bracket: "adult" });
});

t("real-name task: file name = account data; the request cannot change it", async () => {
  const task = await mkTask("Real A", { identity: "real", names: [] });
  const me = await signup({ name: "Sara Hassan", email: "s@x.com", gender: "female", age: 34 });
  // the body tries to say "male / child / fake name" — all ignored
  const r = await start(task, me.data.token, { gender: "male", ageBracket: "child", age: 9, fakeName: "Hacker" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const s = r.data.session;
  assert.deepEqual([s.fake_name, s.gender, s.age_bracket, s.age, s.talent_id], ["Sara Hassan", "female", "adult", 34, me.data.user.id]);
  assert.equal(`${s.fake_name}-${s.gender}-${s.age_bracket}-${s.age}.zip`, "Sara Hassan-female-adult-34.zip");
});

t("real-name task: two talents with the same name get different names, a withdrawn session frees it", async () => {
  const task = await mkTask("Real B", { identity: "real", names: [] });
  const a = await signup({ name: "Omar Said", email: "o1@x.com", gender: "male", age: 20 });
  const b = await signup({ name: "Omar Said", email: "o2@x.com", gender: "male", age: 41 });
  const c = await signup({ name: "Omar Said", email: "o3@x.com", gender: "male", age: 22 });
  assert.equal((await start(task, a.data.token)).data.session.fake_name, "Omar Said");
  const rb = await start(task, b.data.token);
  assert.equal(rb.data.session.fake_name, "Omar Said 2");
  assert.equal((await start(task, c.data.token)).data.session.fake_name, "Omar Said 3");
  await pool.query(`UPDATE recording_sessions SET status='expired' WHERE id=$1`, [rb.data.session.id]);
  const d = await signup({ name: "Omar Said", email: "o4@x.com", gender: "male", age: 50 });
  assert.equal((await start(task, d.data.token)).data.session.fake_name, "Omar Said 2", "freed name is reused");
});

t("real-name task without age groups still records the REAL bracket; quotas by gender still apply", async () => {
  const task = await mkTask("Real C", { identity: "real", names: [], quotas: [{ g: "male", max: 1 }, { g: "female", max: 5 }] });
  const kid = await signup({ name: "Young Boy", email: "yb@x.com", gender: "male", age: 12 });
  const old = await signup({ name: "Old Boy", email: "ob@x.com", gender: "male", age: 70 });
  const r = await start(task, kid.data.token);
  assert.equal(r.status, 201); assert.equal(r.data.session.age_bracket, "child");
  const full = await start(task, old.data.token);
  assert.equal(full.status, 409); assert.equal(full.data.code, "QUOTA_FULL");
});

t("fake-name / code tasks: gender and age come from the account, bracket 'adult' without age groups", async () => {
  const task = await mkTask("Names A", { names: ["Fox", "Owl"] });
  const me = await signup({ name: "Mona Adel", email: "m@x.com", gender: "female", age: 15 });
  const bad = await start(task, me.data.token, { gender: "male" });                 // no fakeName
  assert.equal(bad.status, 400);
  const r = await start(task, me.data.token, { gender: "male", fakeName: "Fox" }); // body gender ignored
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.session.fake_name, r.data.session.gender, r.data.session.age_bracket, r.data.session.age], ["Fox", "female", "adult", 15]);
});

t("task with age groups: the talent's own bracket is used, and a closed bracket is refused", async () => {
  const task = await mkTask("Names B", { brackets: true, names: ["Fox", "Owl"], quotas: [{ g: "male", b: "adult", max: 3 }, { g: "male", b: "child", max: 0 }] });
  const kid = await signup({ name: "Little Ali", email: "la@x.com", gender: "male", age: 10 });
  const man = await signup({ name: "Big Ali", email: "ba@x.com", gender: "male", age: 33 });
  const closed = await start(task, kid.data.token, { fakeName: "Fox", ageBracket: "adult" });   // cannot pick another bracket
  assert.equal(closed.status, 409);
  const ok = await start(task, man.data.token, { fakeName: "Owl" });
  assert.equal(ok.status, 201); assert.equal(ok.data.session.age_bracket, "adult");
});

t("an old account without gender / age is asked to be re-created", async () => {
  const task = await mkTask("Old", { identity: "real", names: [] });
  const old = await one(`INSERT INTO studio_talents (name,email,password_hash) VALUES ('Old Account','old@x.com','x') RETURNING id`);
  const tok = jwt.sign({ id: old.id, studioRole: "talent" }, "test-secret");
  const r = await start(task, tok);
  assert.equal(r.status, 409); assert.equal(r.data.code, "profile_incomplete");
});

t("an Arabic account name on a real-name task is refused (it would break file names)", async () => {
  const task = await mkTask("Arabic", { identity: "real", names: [] });
  const x = await one(`INSERT INTO studio_talents (name,email,password_hash,gender,age,age_bracket) VALUES ('محمد','ar@x.com','x','male',30,'adult') RETURNING id`);
  const r = await start(task, jwt.sign({ id: x.id, studioRole: "talent" }, "test-secret"));
  assert.equal(r.status, 409); assert.equal(r.data.code, "profile_incomplete");
});

t("head leader: a 'real' task is created and published with no names list; the names upload is refused", async () => {
  const hl = (m, p, b) => call(m, `/api/studio/headleader${p}`, b, ids.hlTok);
  const created = await hl("POST", "/tasks", { title: "Real via API", identityMode: "real", leaderIds: [ids.leader], quotas: [{ gender: "male", max: 2 }] });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.identity_mode, "real");
  await pool.query(`INSERT INTO recording_samples (task_id, sentence_name, order_index) VALUES ($1,'S0',0)`, [created.data.id]);
  const pub = await hl("POST", `/tasks/${created.data.id}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  const names = await (async () => {                       // multipart upload of a names file
    const fd = new FormData(); fd.append("file", new Blob(["a\nb\n"]), "n.txt");
    const r = await fetch(`${base}/api/studio/headleader/tasks/${created.data.id}/fake-names`, { method: "POST", headers: { Authorization: `Bearer ${ids.hlTok}` }, body: fd });
    return r.status;
  })();
  assert.equal(names, 400);
  // a normal 'names' task still cannot be published without its list
  const n = await hl("POST", "/tasks", { title: "Names via API", leaderIds: [ids.leader] });
  await pool.query(`INSERT INTO recording_samples (task_id, sentence_name, order_index) VALUES ($1,'S0',0)`, [n.data.id]);
  assert.equal((await hl("POST", `/tasks/${n.data.id}/publish`)).status, 400);
  assert.equal((await hl("POST", "/tasks", { title: "bad", identityMode: "nope" })).status, 400);
});

t("the public fake-names list of a real-name task is empty", async () => {
  const task = await mkTask("Real D", { identity: "real", names: ["Leftover"] });
  const r = await call("GET", `/api/studio/talent/tasks/${task}/fake-names?gender=male`);
  assert.deepEqual(r.data, []);
});

t("shutdown", async () => { server.close(); await pool.end(); });
