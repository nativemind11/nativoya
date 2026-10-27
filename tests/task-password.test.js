// Studio v10 — an optional password on a task.
// Part 1 needs nothing (pure functions). Part 2 is real HTTP + real Postgres (needs TEST_DATABASE_URL with every
// migration up to v10 applied, otherwise skipped).
const URL_DB = process.env.TEST_DATABASE_URL;
const test = require("node:test");
const assert = require("node:assert");
const t = URL_DB ? test : test.skip;
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
const Lock = require("../config/studioTaskLock");

// ------------------------------------------------------------------------------------------ part 1: the module
test("validatePassword: trims, 4 to 64 characters", () => {
  assert.strictEqual(Lock.validatePassword("  abcd  "), "abcd");
  assert.throws(() => Lock.validatePassword("abc"), (e) => e.statusCode === 400);
  assert.throws(() => Lock.validatePassword("   "), (e) => e.statusCode === 400);
  assert.throws(() => Lock.validatePassword("x".repeat(65)), (e) => e.statusCode === 400);
  assert.strictEqual(Lock.validatePassword("x".repeat(64)).length, 64);
});

test("hash / verify: right and wrong, and the password is never the hash", async () => {
  const h = await Lock.hashPassword("Secret123");
  assert.notStrictEqual(h, "Secret123");
  assert.ok(await Lock.verifyPassword("Secret123", h));
  assert.ok(await Lock.verifyPassword("  Secret123 ", h), "spaces around what the talent typed do not matter");
  assert.ok(!(await Lock.verifyPassword("secret123", h)), "case matters");
  assert.ok(!(await Lock.verifyPassword("", h)));
  assert.ok(!(await Lock.verifyPassword(undefined, h)));
});

test("unlock token: bound to task, talent and the current password", async () => {
  const task = { id: "T1", access_password_hash: await Lock.hashPassword("pw1234") };
  const tok = Lock.signUnlock(task, "A");
  assert.ok(Lock.checkUnlock(tok, task, "A"));
  assert.ok(!Lock.checkUnlock(tok, task, "B"), "another talent");
  assert.ok(!Lock.checkUnlock(tok, { ...task, id: "T2" }, "A"), "another task");
  assert.ok(!Lock.checkUnlock(tok, { ...task, access_password_hash: await Lock.hashPassword("other1") }, "A"), "password changed");
  assert.ok(!Lock.checkUnlock("garbage", task, "A"));
  assert.ok(!Lock.checkUnlock("", task, "A"));
  assert.ok(!Lock.checkUnlock(undefined, task, "A"));
  assert.ok(Lock.checkUnlock(undefined, { id: "T3", access_password_hash: null }, "A"), "an open task needs nothing");
});

test("limiter: 5 wrong tries lock that talent on that task for 10 minutes only", () => {
  Lock.resetLimiter();
  const now = 1_000_000;
  for (let i = 0; i < 4; i++) Lock.noteFail("A", "T", now);
  assert.strictEqual(Lock.lockedFor("A", "T", now), 0);
  Lock.noteFail("A", "T", now);
  assert.ok(Lock.lockedFor("A", "T", now + 1000) > 9 * 60 * 1000);
  assert.strictEqual(Lock.lockedFor("B", "T", now), 0, "another talent is free");
  assert.strictEqual(Lock.lockedFor("A", "T2", now), 0, "another task is free");
  assert.strictEqual(Lock.lockedFor("A", "T", now + 10 * 60 * 1000 + 1), 0, "after 10 minutes it opens again");
  Lock.resetLimiter();
});

test("expose: the hash is removed and replaced by a yes / no", () => {
  assert.deepStrictEqual(Lock.expose({ id: 1, access_password_hash: "h" }), { id: 1, password_protected: true });
  assert.deepStrictEqual(Lock.expose({ id: 1, access_password_hash: null }), { id: 1, password_protected: false });
  assert.deepStrictEqual(Lock.expose({ id: 1 }), { id: 1, password_protected: false });
  assert.ok(!("access_password_hash" in Lock.expose({ access_password_hash: "h" })));
});

// -------------------------------------------------------------------------------------- part 2: real HTTP + DB
let server, base, pool, jwt, hlTok, leaderId;
const talents = {};
const call = async (path, { method = "GET", tok, body, form, headers: extra } = {}) => {
  const headers = { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(extra || {}) };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : form });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
};
const hl = (path, o = {}) => call(`/api/studio/headleader${path}`, { tok: hlTok, ...o });
const tal = (path, key, o = {}) => call(`/api/studio/talent${path}`, { tok: key ? talents[key].tok : undefined, ...o });
const file = (name, text) => { const f = new FormData(); f.append("file", new Blob([text]), name); return f; };
// per-person scripts are stored in the database (the single shared script goes to Google Drive, which a test has not got)
const scripts = (n) => { const f = new FormData(); for (let i = 1; i <= n; i++) f.append("files", new Blob([`line one ${i}\nline two ${i}`]), `s${i}.txt`); return f; };
async function addTalent(key, gender, name) {
  const row = (await pool.query(
    `INSERT INTO studio_talents (name, email, password_hash, gender, age, age_bracket) VALUES ($1,$2,'x',$3,25,'adult') RETURNING id`,
    [name, `${key}@mail.test`, gender])).rows[0];
  talents[key] = { id: row.id, tok: jwt.sign({ id: row.id, studioRole: "talent" }, process.env.JWT_SECRET) };
}
// a published direct task with real names, so nothing else is needed to start a session
async function publishedTask(body = {}) {
  const r = await hl("/tasks", { method: "POST", body: { title: "Locked", direct: true, identityMode: "real", scriptMode: "per_person", instructions: "Be quiet", ...body } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const up = await hl(`/tasks/${r.data.id}/scripts`, { method: "POST", form: scripts(8) });
  assert.strictEqual(up.status, 200, JSON.stringify(up.data));
  const pub = await hl(`/tasks/${r.data.id}/publish`, { method: "POST" });
  assert.strictEqual(pub.status, 200, JSON.stringify(pub.data));
  return { create: r.data, published: pub.data, id: r.data.id };
}
const unlock = (key, id, password) => tal(`/tasks/${id}/unlock`, key, { method: "POST", body: { password } });
const start = (key, id, extra = {}, headers) => tal("/sessions", key, { method: "POST", body: { taskId: id, ...extra }, headers });

t("boot", async () => {
  process.env.DATABASE_URL = URL_DB;
  const express = require("express");
  jwt = require("jsonwebtoken");
  ({ pool } = require("../db/pool"));
  const app = express();
  app.use(express.json());
  app.use("/api/studio/headleader", require("../routes/studio/headleader"));
  app.use("/api/studio/talent", require("../routes/studio/talent"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await pool.query(`TRUNCATE studio_delivery_batches, recording_session_samples, recording_sessions, recording_samples, studio_task_scripts,
    recording_tasks, studio_talents, studio_leaders, studio_qa_reviewers, studio_head_leaders CASCADE`);
  const h = (await pool.query(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Head','h@x.com','x') RETURNING id`)).rows[0];
  hlTok = jwt.sign({ id: h.id, studioRole: "head_leader" }, process.env.JWT_SECRET);
  leaderId = (await pool.query(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('Lea','l@x.com','x','L001') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO studio_leaders (name,email,password_hash,leader_code,is_system,is_active) VALUES ('Direct','d@x.invalid','!','DIRECT',true,false)`);
  for (const [k, g, n] of [["a", "male", "Adam Alpha"], ["b", "male", "Boris Bravo"], ["c", "female", "Cora Charlie"], ["d", "male", "Dave Delta"], ["e", "male", "Eli Echo"]]) await addTalent(k, g, n);
});

t("a task without a password behaves exactly as before", async () => {
  const task = await publishedTask({ title: "Open" });
  assert.strictEqual(task.create.password_protected, false);
  assert.ok(!("access_password_hash" in task.create));
  const un = await unlock("a", task.id, "anything");
  assert.strictEqual(un.status, 200);
  assert.strictEqual(un.data.unlockToken, null);
  const s = await start("a", task.id);
  assert.strictEqual(s.status, 201, JSON.stringify(s.data));
});

t("create with a password: stored as a hash, never returned by any endpoint", async () => {
  const task = await publishedTask({ title: "Locked 1", accessPassword: "  Open-Sesame1 " });
  assert.strictEqual(task.create.password_protected, true);
  assert.strictEqual(task.published.password_protected, true);
  const row = (await pool.query(`SELECT access_password_hash FROM recording_tasks WHERE id = $1`, [task.id])).rows[0];
  assert.ok(/^\$2[aby]\$/.test(row.access_password_hash), "bcrypt hash in the database");
  assert.ok(!row.access_password_hash.includes("Open-Sesame1"));

  const everything = JSON.stringify([
    (await hl("/tasks")).data, (await hl(`/tasks/${task.id}`)).data, task.create, task.published,
    (await tal("/tasks", "a")).data, (await tal("/tasks")).data, (await tal(`/tasks/${task.id}`)).data,
  ]);
  assert.ok(!everything.includes("access_password_hash"), "the hash field is nowhere");
  assert.ok(!everything.includes(row.access_password_hash), "the hash value is nowhere");
  assert.ok(!everything.includes("Open-Sesame1"), "the password is nowhere");

  const list = (await tal("/tasks")).data;
  assert.strictEqual(list.find((x) => x.id === task.id).password_protected, true, "it still shows to everybody");
  assert.strictEqual(list.find((x) => x.title === "Open").password_protected, false);
  assert.strictEqual((await hl("/tasks")).data.find((x) => x.id === task.id).password_protected, true);
  const detail = (await tal(`/tasks/${task.id}`)).data.task;
  assert.strictEqual(detail.password_protected, true);
  assert.ok(!("instructions" in detail), "instructions of a locked task are kept back");
  const openDetail = (await tal(`/tasks/${(await pool.query(`SELECT id FROM recording_tasks WHERE title='Open'`)).rows[0].id}`)).data.task;
  assert.strictEqual(openDetail.instructions, "Be quiet", "an open task still shows them");
});

t("too short a password is refused on create and on edit", async () => {
  let r = await hl("/tasks", { method: "POST", body: { title: "X", direct: true, accessPassword: "abc" } });
  assert.strictEqual(r.status, 400);
  const task = await publishedTask({ title: "Edit me" });
  r = await hl(`/tasks/${task.id}`, { method: "PATCH", body: { accessPassword: "123" } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await pool.query(`SELECT access_password_hash FROM recording_tasks WHERE id=$1`, [task.id])).rows[0].access_password_hash, null);
});

t("cannot start without unlocking; wrong password; right password; token is personal", async () => {
  Lock.resetLimiter();
  const task = await publishedTask({ title: "Locked 2", accessPassword: "Pass-2222" });

  let r = await start("b", task.id);
  assert.strictEqual(r.status, 403); assert.strictEqual(r.data.code, "task_locked");
  r = await start("b", task.id, { unlockToken: "garbage" });
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await tal("/sessions", "b", { method: "POST", body: { taskId: task.id } })).status, 403);

  r = await unlock("b", task.id, "wrong");
  assert.strictEqual(r.status, 403); assert.strictEqual(r.data.code, "wrong_password");
  assert.strictEqual((await unlock("b", task.id, "")).status, 403);
  assert.strictEqual((await tal(`/tasks/${task.id}/unlock`, null, { method: "POST", body: { password: "Pass-2222" } })).status, 401, "must be logged in");
  assert.strictEqual((await hl(`/tasks/${task.id}`)).status, 200);
  assert.strictEqual((await call(`/api/studio/talent/tasks/${task.id}/unlock`, { method: "POST", tok: hlTok, body: { password: "Pass-2222" } })).status, 403, "a head leader token is not a talent");

  r = await unlock("b", task.id, "Pass-2222");
  assert.strictEqual(r.status, 200);
  const token = r.data.unlockToken;
  assert.ok(token);

  assert.strictEqual((await start("c", task.id, { unlockToken: token })).status, 403, "another talent cannot use it");
  const other = await publishedTask({ title: "Locked 3", accessPassword: "Pass-3333" });
  assert.strictEqual((await start("b", other.id, { unlockToken: token })).status, 403, "not for another task");

  r = await start("b", task.id, { unlockToken: token });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.session.session_token);
  // the header works too (that is what the page sends for the names list)
  assert.strictEqual((await start("d", task.id, {}, { "X-Task-Unlock": (await unlock("d", task.id, "Pass-2222")).data.unlockToken })).status, 201);
});

t("5 wrong tries lock that talent for a while, even with the right password; others are not affected", async () => {
  Lock.resetLimiter();
  const task = await publishedTask({ title: "Brute", accessPassword: "Right-1234" });
  for (let i = 0; i < 5; i++) assert.strictEqual((await unlock("e", task.id, "nope" + i)).status, 403);
  let r = await unlock("e", task.id, "Right-1234");
  assert.strictEqual(r.status, 429); assert.strictEqual(r.data.code, "too_many_tries");
  assert.strictEqual((await unlock("c", task.id, "Right-1234")).status, 200, "somebody else is fine");
  Lock.resetLimiter();
  assert.strictEqual((await unlock("e", task.id, "Right-1234")).status, 200);
});

t("names list of a locked task needs the unlock; open tasks stay public", async () => {
  Lock.resetLimiter();
  const mk = async (title, accessPassword) => {
    const r = await hl("/tasks", { method: "POST", body: { title, leaderIds: [leaderId], scriptMode: "per_person", ...(accessPassword ? { accessPassword } : {}) } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.strictEqual((await hl(`/tasks/${r.data.id}/scripts`, { method: "POST", form: scripts(4) })).status, 200);
    assert.strictEqual((await hl(`/tasks/${r.data.id}/fake-names`, { method: "POST", form: file("n.txt", "Falcon\nHawk\nEagle") })).status, 200);
    assert.strictEqual((await hl(`/tasks/${r.data.id}/publish`, { method: "POST" })).status, 200);
    return r.data.id;
  };
  const locked = await mk("Names locked", "Names-1234");
  const open = await mk("Names open");

  assert.deepStrictEqual((await tal(`/tasks/${open}/fake-names`, null)).data.sort(), ["Eagle", "Falcon", "Hawk"], "open: public, no login needed");
  let r = await tal(`/tasks/${locked}/fake-names`, null);
  assert.strictEqual(r.status, 403); assert.strictEqual(r.data.code, "task_locked");
  r = await tal(`/tasks/${locked}/fake-names`, "a");
  assert.strictEqual(r.status, 403, "logged in but not unlocked");
  const token = (await unlock("a", locked, "Names-1234")).data.unlockToken;
  r = await tal(`/tasks/${locked}/fake-names`, "a", { headers: { "X-Task-Unlock": token } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.length, 3);
  assert.strictEqual((await tal(`/tasks/${locked}/fake-names`, "b", { headers: { "X-Task-Unlock": token } })).status, 403, "token of another talent");

  r = await start("a", locked, { leaderId, fakeName: "Falcon", unlockToken: token });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual((await start("b", locked, { leaderId, fakeName: "Hawk" })).status, 403);
});

t("edit: change the password (old unlocks stop working), keep it, remove it; started sessions are never affected", async () => {
  Lock.resetLimiter();
  const task = await publishedTask({ title: "Change", accessPassword: "First-1111" });
  const tokA = (await unlock("a", task.id, "First-1111")).data.unlockToken;
  const started = await start("a", task.id, { unlockToken: tokA });
  assert.strictEqual(started.status, 201);
  const tokB = (await unlock("b", task.id, "First-1111")).data.unlockToken;

  // an edit that does not mention the password leaves it alone
  let r = await hl(`/tasks/${task.id}`, { method: "PATCH", body: { title: "Change 2" } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.password_protected, true);
  assert.ok(Lock.checkUnlock(tokB, (await pool.query(`SELECT * FROM recording_tasks WHERE id=$1`, [task.id])).rows[0], talents.b.id), "token still good");

  // a new password cancels every token made with the old one
  r = await hl(`/tasks/${task.id}`, { method: "PATCH", body: { accessPassword: "Second-2222" } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.password_protected, true);
  assert.ok(!JSON.stringify(r.data).includes("access_password_hash"));
  assert.strictEqual((await start("b", task.id, { unlockToken: tokB })).status, 403, "old unlock is dead");
  assert.strictEqual((await unlock("b", task.id, "First-1111")).status, 403, "old password is dead");
  assert.strictEqual((await unlock("b", task.id, "Second-2222")).status, 200);

  // the talent who had already started simply carries on
  const resume = await tal(`/sessions/${started.data.session.session_token}`, "a");
  assert.strictEqual(resume.status, 200);

  // remove: open for everybody again
  r = await hl(`/tasks/${task.id}`, { method: "PATCH", body: { accessPassword: null } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.password_protected, false);
  assert.strictEqual((await start("c", task.id)).status, 201, "no password, no token");
  // an empty text means the same as null
  const again = await publishedTask({ title: "Empty", accessPassword: "Some-pass1" });
  r = await hl(`/tasks/${again.id}`, { method: "PATCH", body: { accessPassword: "   " } });
  assert.strictEqual(r.data.password_protected, false);
  // and a password can be added to an open task later
  r = await hl(`/tasks/${again.id}`, { method: "PATCH", body: { accessPassword: "Later-3333" } });
  assert.strictEqual(r.data.password_protected, true);
  assert.strictEqual((await start("d", again.id)).status, 403);
});

t("only the owner head leader can touch the password", async () => {
  const task = await publishedTask({ title: "Mine" });
  const other = (await pool.query(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Other','o@x.com','x') RETURNING id`)).rows[0];
  const tok = jwt.sign({ id: other.id, studioRole: "head_leader" }, process.env.JWT_SECRET);
  const r = await call(`/api/studio/headleader/tasks/${task.id}`, { method: "PATCH", tok, body: { accessPassword: "Hijack-1" } });
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await pool.query(`SELECT access_password_hash FROM recording_tasks WHERE id=$1`, [task.id])).rows[0].access_password_hash, null);
});

t("shutdown", async () => { await new Promise((r) => server.close(r)); await pool.end(); });
