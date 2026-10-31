// Company acceptance (القبول من الشركة) against a REAL Postgres + real HTTP. Needs TEST_DATABASE_URL (skipped otherwise).
const URL_DB = process.env.TEST_DATABASE_URL;
const test = require("node:test");
const assert = require("node:assert");
const t = URL_DB ? test : test.skip;
if (URL_DB) { process.env.DATABASE_URL = URL_DB; process.env.JWT_SECRET = "test-secret"; }

let server, root, pool, jwt, A;
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const sign = (id, role) => jwt.sign({ id, studioRole: role }, "test-secret");
const call = (path, tok, method = "GET", body) => fetch(`${root}${path}`, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
let hl, hlTok, n = 0;

const csv = (lines) => Buffer.from("\ufeff" + lines.join("\n"), "utf8");
async function upload(path, tok, taskId, buf, fields = {}) {
  const f = new FormData();
  f.append("file", new Blob([buf], { type: "text/csv" }), fields.__name || "company-accepted.csv");
  f.append("taskId", taskId);
  for (const [k, v] of Object.entries(fields)) if (k !== "__name") f.append(k, String(v));
  return fetch(`${root}/acceptance/${path}`, { method: "POST", headers: { Authorization: `Bearer ${tok}` }, body: f });
}
const MAP = { sheetIndex: 0, headerRow: 1, labelCol: 0, labelType: "smart", statusCol: -1 };

async function reset() {
  await pool.query(`TRUNCATE studio_acceptances, studio_acceptance_files, studio_delivery_batch_sessions, studio_delivery_batches, studio_feedback_items,
    recording_session_samples, recording_sessions, recording_samples, recording_task_leaders, recording_tasks, studio_talents, studio_leaders, studio_qa_reviewers, studio_head_leaders CASCADE`);
  hl = await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Head','h@x.com','x') RETURNING id`);
  hlTok = sign(hl.id, "head_leader");
}
const mkLeader = (code) => one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ($1,$2,'x',$1) RETURNING id`, [code, `${code}@x.com`]);
const mkTask = (title, extra = {}, owner) => one(`INSERT INTO recording_tasks (title, head_leader_id, quantity, status, identity_mode) VALUES ($1,$2,50,$3,$4) RETURNING id`, [title, owner || hl.id, extra.status || "published", extra.identity || "names"]);
async function mkPerson(task, leader, fake, { gender = "male", age = 30, status = "approved", delivered = true, bracket = "adult" } = {}) {
  n++;
  await pool.query(`INSERT INTO recording_task_leaders (task_id, leader_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [task.id, leader.id]);
  const tal = await one(`INSERT INTO studio_talents (name,email,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`Real ${n}`, `p${n}@m.com`]);
  const s = await one(`INSERT INTO recording_sessions (task_id,leader_id,talent_id,session_token,gender,age_bracket,age,fake_name,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [task.id, leader.id, tal.id, `tok${n}`, gender, bracket, age, fake, status]);
  if (delivered) {
    let b = await one(`SELECT id FROM studio_delivery_batches WHERE task_id=$1 AND gender=$2 AND status='delivered' LIMIT 1`, [task.id, gender]);
    if (!b) b = await one(`INSERT INTO studio_delivery_batches (task_id,gender,group_day,status,session_count) VALUES ($1,$2,'2026-01-10','delivered',1) RETURNING id`, [task.id, gender]);
    await pool.query(`INSERT INTO studio_delivery_batch_sessions (batch_id,session_id) VALUES ($1,$2)`, [b.id, s.id]);
  }
  return { id: s.id, talentId: tal.id, tok: sign(tal.id, "talent") };
}
const accepted = async (taskId) => (await pool.query(`SELECT s.fake_name FROM studio_acceptances a JOIN recording_sessions s ON s.id=a.session_id WHERE a.task_id=$1 ORDER BY 1`, [taskId])).rows.map((r) => r.fake_name);

t("boot", async () => {
  const express = require("express"); jwt = require("jsonwebtoken"); A = require("../config/studioAcceptance");
  ({ pool } = require("../db/pool"));
  const app = express(); app.use(express.json());
  app.use("/api/studio/acceptance", require("../routes/studio/acceptance"));
  app.use("/api/studio/headleader", require("../routes/studio/headleader"));
  app.use("/api/studio/talent", require("../routes/studio/talent"));
  app.use("/api/studio/leader", require("../routes/studio/leader"));
  await new Promise((r) => { server = app.listen(0, r); });
  root = `http://127.0.0.1:${server.address().port}/api/studio`;
});

t("fake-name task: preview matches by name (+ extras), writes nothing; apply marks only matched + delivered people; talent and leader see it", async () => {
  await reset();
  const l1 = await mkLeader("L001"), l2 = await mkLeader("L002");
  const task = await mkTask("French");
  const marie = await mkPerson(task, l1, "Marie Louise", { gender: "female", age: 8, bracket: "child" });
  const omar = await mkPerson(task, l1, "Omar");
  const zed = await mkPerson(task, l2, "Zed");
  await mkPerson(task, l2, "Pending Guy", { delivered: false });
  await mkPerson(task, l2, "Gone", { status: "expired" });
  const file = csv(["Name", "Marie Louise_8_f_children", "omar.zip", "Nobody", "Pending Guy", "Gone", "Omar"]);

  const pv = await (await upload("preview", hlTok, task.id, file, MAP)).json();
  assert.strictEqual(pv.summary.total, 6);
  assert.strictEqual(pv.summary.sessions, 2, "Marie + Omar (Omar is listed twice but counted once)");
  assert.strictEqual(pv.summary.errors, 3);
  const bad = Object.fromEntries(pv.results.filter((r) => !r.ok).map((r) => [r.label, r.code]));
  assert.deepStrictEqual(bad, { Nobody: "no_session", "Pending Guy": "not_delivered", Gone: "expired" });
  assert.strictEqual((await accepted(task.id)).length, 0, "preview writes nothing");
  assert.ok(pv.names.length >= 4 && pv.people.length === 3, "name panel + the pick-list offer only delivered, live people");

  const ap = await (await upload("apply", hlTok, task.id, file, MAP)).json();
  assert.deepStrictEqual([ap.newly, ap.alreadyAccepted], [2, 0]);
  assert.deepStrictEqual(await accepted(task.id), ["Marie Louise", "Omar"]);

  // the same file again: nothing new, no empty file in the history
  const again = await (await upload("apply", hlTok, task.id, file, MAP)).json();
  assert.deepStrictEqual([again.newly, again.alreadyAccepted, again.fileId], [0, 2, null]);
  assert.strictEqual((await one(`SELECT COUNT(*)::int AS c FROM studio_acceptance_files`)).c, 1);

  // talent account: accepted for the accepted one, not for the others
  const mine = await (await call("/talent/me/sessions", omar.tok)).json();
  assert.ok(mine[0].accepted_at, "Omar sees it");
  assert.strictEqual((await (await call("/talent/me/sessions", zed.tok)).json())[0].accepted_at, null);
  // leader account: per person + per task
  const ov = await (await call("/leader/overview", sign((await one(`SELECT id FROM studio_leaders WHERE leader_code='L001'`)).id, "leader"))).json();
  assert.deepStrictEqual(ov.sessions.map((s) => [s.fake_name, !!s.accepted_at]).sort(), [["Marie Louise", true], ["Omar", true]]);
  assert.strictEqual(ov.tasks.find((x) => x.id === task.id).accepted, 2);
  const ov2 = await (await call("/leader/overview", sign((await one(`SELECT id FROM studio_leaders WHERE leader_code='L002'`)).id, "leader"))).json();
  assert.strictEqual(ov2.tasks.find((x) => x.id === task.id).accepted, 0);
});

t("an acceptance never changes the leader's boxes or the talent's status", async () => {
  await reset();
  const l1 = await mkLeader("L001"); const task = await mkTask("Boxes");
  await mkPerson(task, l1, "A"); await mkPerson(task, l1, "B", { status: "rejected" }); await mkPerson(task, l1, "C", { status: "in_progress", delivered: false });
  const tok = sign(l1.id, "leader");
  const before = await (await call("/leader/overview", tok)).json();
  const r = await upload("apply", hlTok, task.id, csv(["Name", "A"]), MAP); assert.strictEqual(r.status, 200);
  const after = await (await call("/leader/overview", tok)).json();
  assert.deepStrictEqual(after.stats, before.stats);
  assert.deepStrictEqual(after.sessions.map((s) => [s.fake_name, s.status, s.cat]).sort(), before.sessions.map((s) => [s.fake_name, s.status, s.cat]).sort());
});

t("codes task: a code matches exactly and is never guessed from its first part", async () => {
  await reset();
  const l1 = await mkLeader("L001"); const task = await mkTask("Codes", { identity: "codes" });
  await mkPerson(task, l1, "M-014"); await mkPerson(task, l1, "M-015"); await mkPerson(task, l1, "F-001", { gender: "female" });
  const pv = await (await upload("preview", hlTok, task.id, csv(["Code", "M-014", "m 015", "M-999", "F-001"]), MAP)).json();
  assert.deepStrictEqual(pv.results.filter((r) => r.ok).map((r) => r.session.fakeName).sort(), ["F-001", "M-014", "M-015"]);
  const miss = pv.results.find((r) => r.label === "M-999");
  assert.strictEqual(miss.ok, false); assert.strictEqual(miss.code, "no_session", "M-999 does not fall back to another M- code");
  // exact (non-smart) mode works the same
  const ex = await (await upload("preview", hlTok, task.id, csv(["Code", "M-014", "M-016"]), { ...MAP, labelType: "fake" })).json();
  assert.deepStrictEqual([ex.summary.ok, ex.summary.errors], [1, 1]);
});

t("real-name task: the company's real names match, a repeated name keeps its number", async () => {
  await reset();
  const l1 = await mkLeader("L001"); const task = await mkTask("Real", { identity: "real" });
  await mkPerson(task, l1, "Ahmed Ali"); await mkPerson(task, l1, "Ahmed Ali 2"); await mkPerson(task, l1, "Sara Hassan", { gender: "female" });
  const ap = await (await upload("apply", hlTok, task.id, csv(["Name", "Ahmed Ali 2", "Sara Hassan"]), MAP)).json();
  assert.strictEqual(ap.newly, 2);
  assert.deepStrictEqual(await accepted(task.id), ["Ahmed Ali 2", "Sara Hassan"]);
});

t("status column: only the rows marked accepted count, the rest are ignored", async () => {
  await reset();
  const l1 = await mkLeader("L001"); const task = await mkTask("Status");
  await mkPerson(task, l1, "Ann", { gender: "female" }); await mkPerson(task, l1, "Bob"); await mkPerson(task, l1, "Cid");
  const f = csv(["Name,Status", "Ann,Accepted", "Bob,Rejected", "Cid,Accepted"]);
  const pv = await (await upload("preview", hlTok, task.id, f, { ...MAP, statusCol: 1, acceptValues: JSON.stringify(["Accepted"]) })).json();
  assert.deepStrictEqual([pv.summary.ok, pv.summary.ignored, pv.summary.ignoredBy], [2, 1, { Rejected: 1 }]);
  const noValues = await upload("preview", hlTok, task.id, f, { ...MAP, statusCol: 1 });
  assert.strictEqual(noValues.status, 400, "a status column needs the values that mean accepted");
});

t("manual pick / 'not this person' work like on the feedback page, and are checked against THIS task", async () => {
  await reset();
  const l1 = await mkLeader("L001"); const task = await mkTask("Manual"); const other = await mkTask("Other");
  const kim = await mkPerson(task, l1, "Kimberly"); await mkPerson(task, l1, "Zoe", { gender: "female" });
  const foreign = await mkPerson(other, l1, "Kimmy");
  const f = csv(["Name", "Kimmy Q", "Zoe"]);
  const hand = await (await upload("preview", hlTok, task.id, f, { ...MAP, nameMap: JSON.stringify({ "Kimmy Q": kim.id }) })).json();
  assert.deepStrictEqual(hand.results.filter((r) => r.ok).map((r) => r.session.fakeName).sort(), ["Kimberly", "Zoe"]);
  const wrong = await (await upload("preview", hlTok, task.id, f, { ...MAP, nameMap: JSON.stringify({ "Kimmy Q": foreign.id }) })).json();
  assert.strictEqual(wrong.results.find((r) => r.label === "Kimmy Q").code, "manual_name_invalid", "a person of another task is refused");
  const none = await (await upload("preview", hlTok, task.id, f, { ...MAP, nameMap: JSON.stringify({ Zoe: "none" }) })).json();
  assert.strictEqual(none.results.find((r) => r.label === "Zoe").code, "name_excluded");
});

t("warnings: someone with open rework feedback needs an explicit confirmation", async () => {
  await reset();
  const l1 = await mkLeader("L001"); const task = await mkTask("Warn");
  const p = await mkPerson(task, l1, "Dan"); await mkPerson(task, l1, "Eve", { gender: "female" });
  await pool.query(`INSERT INTO studio_feedback_items (task_id, session_id, leader_id, fake_name, recording_numbers, issue_description, status) VALUES ($1,$2,$3,'Dan','{1}','x','pending')`, [task.id, p.id, l1.id]);
  const f = csv(["Name", "Dan", "Eve"]);
  const pv = await (await upload("preview", hlTok, task.id, f, MAP)).json();
  assert.deepStrictEqual(pv.warnings.map((w) => w.code), ["open_feedback"]);
  const refused = await upload("apply", hlTok, task.id, f, MAP);
  assert.strictEqual(refused.status, 409); assert.strictEqual((await accepted(task.id)).length, 0, "nothing written without the confirmation");
  const ok = await upload("apply", hlTok, task.id, f, { ...MAP, confirmWarnings: "1" });
  assert.strictEqual(ok.status, 200); assert.deepStrictEqual(await accepted(task.id), ["Dan", "Eve"]);
});

t("the board lists EVERY task (draft / published / closed / finished), newest first, with its state; the detail lists files and people", async () => {
  await reset();
  const l1 = await mkLeader("L001");
  const old = await mkTask("Old finished", { status: "closed" });
  await pool.query(`UPDATE recording_tasks SET created_at = now() - interval '90 days', finalized_at = now() - interval '60 days', storage_cleared_at = now() - interval '60 days' WHERE id=$1`, [old.id]);
  const mid = await mkTask("Middle"); await pool.query(`UPDATE recording_tasks SET created_at = now() - interval '10 days' WHERE id=$1`, [mid.id]);
  const draft = await mkTask("Draft", { status: "draft" });
  const fresh = await mkTask("Fresh");
  for (const nm of ["P1", "P2"]) await mkPerson(old, l1, nm);
  for (const nm of ["Q1", "Q2", "Q3"]) await mkPerson(mid, l1, nm);
  await mkPerson(fresh, l1, "R1", { delivered: false });
  await upload("apply", hlTok, old.id, csv(["Name", "P1", "P2"]), MAP);
  await upload("apply", hlTok, mid.id, csv(["Name", "Q1"]), MAP);
  const strangerHead = await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Other','o@x.com','x') RETURNING id`);
  await mkTask("Somebody else's", {}, strangerHead.id);

  const board = await (await call("/acceptance/board", hlTok)).json();
  assert.deepStrictEqual(board.tasks.map((x) => x.title), ["Fresh", "Draft", "Middle", "Old finished"], "newest first, and only my tasks");
  const by = Object.fromEntries(board.tasks.map((x) => [x.title, x]));
  assert.deepStrictEqual([by["Old finished"].state, by["Old finished"].accepted, by["Old finished"].delivered, by["Old finished"].finished, by["Old finished"].status], ["full", 2, 2, true, "closed"]);
  assert.deepStrictEqual([by.Middle.state, by.Middle.accepted, by.Middle.delivered], ["partial", 1, 3]);
  assert.strictEqual(by.Fresh.state, "no_delivery"); assert.strictEqual(by.Draft.state, "no_delivery");
  assert.deepStrictEqual(board.totals, { tasks: 4, full: 1, partial: 1, none: 0, noDelivery: 2 });
  assert.strictEqual(by.Middle.lastFileName, "company-accepted.csv");

  const d = await (await call(`/acceptance/tasks/${mid.id}`, hlTok)).json();
  assert.strictEqual(d.files.length, 1); assert.strictEqual(d.files[0].accepted, 1);
  assert.deepStrictEqual(d.people.map((p) => [p.fakeName, !!p.acceptedAt]), [["Q1", true], ["Q2", false], ["Q3", false]], "accepted first");
  assert.strictEqual((await call(`/acceptance/tasks/${(await mkTask("x", {}, strangerHead.id)).id}`, hlTok)).status, 404, "another head leader's task is not mine");
});

t("undo: deleting an acceptance file un-accepts its people; one person can be un-accepted; a new file can accept again", async () => {
  await reset();
  const l1 = await mkLeader("L001"); const task = await mkTask("Undo");
  for (const nm of ["A", "B", "C"]) await mkPerson(task, l1, nm);
  const f1 = await (await upload("apply", hlTok, task.id, csv(["Name", "A", "B"]), { ...MAP, __name: "first.csv" })).json();
  const f2 = await (await upload("apply", hlTok, task.id, csv(["Name", "B", "C"]), { ...MAP, __name: "second.csv" })).json();
  assert.deepStrictEqual([f1.newly, f2.newly, f2.alreadyAccepted], [2, 1, 1]);
  const one1 = (await pool.query(`SELECT a.session_id FROM studio_acceptances a JOIN recording_sessions s ON s.id=a.session_id WHERE s.fake_name='C'`)).rows[0].session_id;
  assert.strictEqual((await call(`/acceptance/sessions/${one1}`, hlTok, "DELETE")).status, 200);
  assert.deepStrictEqual(await accepted(task.id), ["A", "B"]);
  assert.strictEqual((await one(`SELECT accepted_count AS c FROM studio_acceptance_files WHERE id=$1`, [f2.fileId])).c, 0, "the file's count follows");
  assert.strictEqual((await call(`/acceptance/files/${f1.fileId}`, hlTok, "DELETE")).status, 200);
  assert.deepStrictEqual(await accepted(task.id), [], "everyone the first file accepted is back to not accepted");
  assert.strictEqual((await call(`/acceptance/files/${f1.fileId}`, hlTok, "DELETE")).status, 404);
  const again = await (await upload("apply", hlTok, task.id, csv(["Name", "A", "B", "C"]), MAP)).json();
  assert.strictEqual(again.newly, 3);
});

t("deleting a task for good (the existing button) also removes its acceptance files and marks — no foreign-key error", async () => {
  await reset();
  const l1 = await mkLeader("L001"); const task = await mkTask("Doomed");
  await mkPerson(task, l1, "A"); await upload("apply", hlTok, task.id, csv(["Name", "A"]), MAP);
  assert.strictEqual((await one(`SELECT COUNT(*)::int AS c FROM studio_acceptances`)).c, 1);
  const r = await call(`/headleader/tasks/${task.id}`, hlTok, "DELETE", { confirm: "Doomed" });
  assert.strictEqual(r.status, 200, await r.clone().text());
  assert.deepStrictEqual([(await one(`SELECT COUNT(*)::int AS c FROM studio_acceptances`)).c, (await one(`SELECT COUNT(*)::int AS c FROM studio_acceptance_files`)).c, (await one(`SELECT COUNT(*)::int AS c FROM recording_tasks`)).c], [0, 0, 0]);
  assert.strictEqual((await call(`/acceptance/board`, hlTok).then((x) => x.json())).tasks.length, 0, "gone from the page");
});

t("access: only the owning head leader; a talent or a leader cannot touch any of it", async () => {
  await reset();
  const l1 = await mkLeader("L001"); const task = await mkTask("Guarded"); const p = await mkPerson(task, l1, "A");
  const stranger = await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Other','o@x.com','x') RETURNING id`);
  assert.strictEqual((await upload("apply", sign(stranger.id, "head_leader"), task.id, csv(["Name", "A"]), MAP)).status, 404);
  for (const tok of [p.tok, sign(l1.id, "leader"), "nonsense"]) {
    assert.ok([401, 403].includes((await call("/acceptance/board", tok)).status));
    assert.ok([401, 403].includes((await upload("apply", tok, task.id, csv(["Name", "A"]), MAP)).status));
  }
  assert.strictEqual((await accepted(task.id)).length, 0);
  assert.strictEqual((await upload("apply", hlTok, "not-a-uuid", csv(["Name", "A"]), MAP)).status, 400);
  assert.strictEqual((await upload("apply", hlTok, task.id, csv(["Name", "Nobody"]), MAP)).status, 400, "no valid row -> refused, nothing written");
});

t("before the migration runs nothing breaks: the readiness check says so and the account lookups return nothing", async () => {
  A._resetReadyForTests();
  const fake = { query: async () => ({ rows: [{ ok: false }] }) };
  assert.strictEqual(await A.acceptanceReady(fake), false);
  assert.strictEqual((await A.acceptedMap(fake, ["x"])).size, 0);
  A._resetReadyForTests();
});

t("done", async () => { server.close(); await pool.end(); });
