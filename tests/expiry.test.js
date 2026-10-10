// The 12h rework deadline is enforced: past it, the session is withdrawn, its
// fake name and slot are free again for anyone (male or female) on the task.
// Needs TEST_DATABASE_URL (skipped otherwise).
const URL_DB = process.env.TEST_DATABASE_URL;
const test = require("node:test");
const assert = require("node:assert");
const t = URL_DB ? test : test.skip;

let pool, server, base, jwt, F, D, E, ids, tok;
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const past = "now() - interval '1 hour'";
const future = "now() + interval '5 hours'";

t("boot", async () => {
  process.env.DATABASE_URL = URL_DB;
  process.env.JWT_SECRET = "test-secret";
  const express = require("express");
  jwt = require("jsonwebtoken");
  ({ pool } = require("../db/pool"));
  F = require("../config/studioFeedback"); D = require("../config/studioDelivery"); E = require("../config/studioExpiry");
  const app = express();
  app.use(express.json());
  app.use("/api/studio/talent", require("../routes/studio/talent"));
  app.use("/api/studio/feedback", require("../routes/studio/feedback"));
  app.use("/api/studio/qa", require("../routes/studio/qa"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/studio`;
});

async function reset() {
  await pool.query(`TRUNCATE studio_feedback_items, studio_delivery_batch_sessions, studio_delivery_batches, studio_qa_reviews,
    recording_session_samples, recording_task_leaders, recording_sessions, recording_samples, recording_tasks,
    studio_talents, studio_leaders, studio_qa_reviewers, studio_head_leaders CASCADE`);
  const hl = await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Head','h@x.com','x') RETURNING id`);
  const leader = await one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('Lea','l@x.com','x','L001') RETURNING id`);
  const qa = await one(`INSERT INTO studio_qa_reviewers (name,email,password_hash) VALUES ('QA','q@x.com','x') RETURNING id`);
  const task = await one(`INSERT INTO recording_tasks (title,head_leader_id,quantity,status,fake_names) VALUES ('Exp Task',$1,10,'published',ARRAY['Eagle','Falcon','Owl']) RETURNING id`, [hl.id]);
  await pool.query(`INSERT INTO recording_task_leaders (task_id,leader_id) VALUES ($1,$2)`, [task.id, leader.id]);
  const samples = [];
  for (let i = 0; i < 3; i++) samples.push(await one(`INSERT INTO recording_samples (task_id,sentence_name,order_index) VALUES ($1,$2,$3) RETURNING id`, [task.id, `S${i + 1}`, i]));
  ids = { hl, leader, qa, task, samples };
  tok = {};
  return ids;
}

let n = 0;
async function talent(label) {
  n++;
  const tal = await one(`INSERT INTO studio_talents (name,email,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`Real ${label}`, `${label}${n}@mail.com`]);
  tok[label] = jwt.sign({ id: tal.id, studioRole: "talent" }, "test-secret");
  return tal.id;
}
async function session(label, fake, { status, deadline, enforced = true, gender = "male", age = 30 }) {
  const talentId = await talent(label);
  const s = await one(
    `INSERT INTO recording_sessions (task_id,leader_id,talent_id,session_token,gender,age_bracket,age,fake_name,status,rework_deadline,rework_enforced,
        zip_file_url,zip_file_name,qa_reviewer_id,qa_reviewed_at)
     VALUES ($1,$2,$3,$4,$5,'adult',$6,$7,$8,${deadline || "NULL"},$9,'https://drive.google.com/file/d/ZZ'||$4,$10,$11,now()) RETURNING id`,
    [ids.task.id, ids.leader.id, talentId, `tok-${label}`, gender, age, fake, status, enforced, `${fake}-${gender}-adult-${age}.zip`, ids.qa.id]);
  for (const sm of ids.samples) {
    await pool.query(`INSERT INTO recording_session_samples (session_id,sample_id,audio_file_url,qa_status) VALUES ($1,$2,'drive:x',$3)`,
      [s.id, sm.id, status === "rejected" ? "rejected" : "approved"]);
  }
  return { id: s.id, talentId, token: `tok-${label}` };
}
const status = async (id) => (await one(`SELECT status, expired_at FROM recording_sessions WHERE id=$1`, [id]));
const api = (path, who, opts = {}) => fetch(base + path, { ...opts, headers: { ...(who ? { Authorization: `Bearer ${tok[who] || who}` } : {}), ...(opts.headers || {}) } });

// ------------------------------------------------------------------- the sweep
t("sweep: only enforced + rejected + overdue sessions are withdrawn", async () => {
  await reset();
  const due = await session("due", "Eagle", { status: "rejected", deadline: past });
  const notYet = await session("notyet", "Falcon", { status: "rejected", deadline: future });
  const legacy = await session("legacy", "Owl", { status: "rejected", deadline: past, enforced: false });
  const submitted = await session("submitted", "S4", { status: "submitted", deadline: past });
  const approved = await session("approved", "S5", { status: "approved", deadline: past });
  await pool.query(`INSERT INTO studio_feedback_items (task_id,session_id,leader_id,fake_name,recording_numbers,status,rework_deadline) VALUES
    ($1,$2,$3,'Eagle','{1}','pending',${past}), ($1,$2,$3,'Eagle','{2}','acknowledged',${past}), ($1,$2,$3,'Eagle','{3}','reworked',${past})`,
    [ids.task.id, due.id, ids.leader.id]);

  assert.deepStrictEqual(await E.expireOverdue(pool), { sessions: 1, items: 2 });
  const d = await status(due.id);
  assert.strictEqual(d.status, "expired");
  assert.ok(d.expired_at);
  for (const [s, expected] of [[notYet, "rejected"], [legacy, "rejected"], [submitted, "submitted"], [approved, "approved"]]) {
    assert.strictEqual((await status(s.id)).status, expected);
  }
  const items = (await pool.query(`SELECT recording_numbers[1] AS n, status FROM studio_feedback_items ORDER BY 1`)).rows;
  assert.deepStrictEqual(items.map((i) => i.status), ["expired", "expired", "reworked"], "a finished item is left alone");
  assert.deepStrictEqual(await E.expireOverdue(pool), { sessions: 0, items: 0 }, "idempotent");
});

t("a talent who re-submits before the deadline is never withdrawn", async () => {
  await reset();
  const s = await session("quick", "Eagle", { status: "rejected", deadline: future });
  await pool.query(`UPDATE recording_sessions SET status='submitted' WHERE id=$1`, [s.id]);
  await pool.query(`UPDATE recording_sessions SET rework_deadline = ${past} WHERE id=$1`, [s.id]);
  await E.expireOverdue(pool);
  assert.strictEqual((await status(s.id)).status, "submitted");
});

// ------------------------------------------- name + slot released, via real routes
t("withdrawn session frees the fake name and the slot; anyone (either gender) can take it; delivered archive is untouched", async () => {
  await reset();
  // Eagle was delivered to the buyer, then got company feedback (12h) and never fixed it
  const eagle = await session("A", "Eagle", { status: "approved", deadline: null, enforced: false, gender: "male", age: 30 });
  const batch = await one(`INSERT INTO studio_delivery_batches (task_id,gender,qa_reviewer_id,group_day,status,session_count,zip_file_url)
    VALUES ($1,'male',$2,current_date,'delivered',1,'https://drive.google.com/file/d/BIG/view') RETURNING id`, [ids.task.id, ids.qa.id]);
  await pool.query(`UPDATE recording_sessions SET delivery_batch_id=$1 WHERE id=$2`, [batch.id, eagle.id]);
  await pool.query(`INSERT INTO studio_delivery_batch_sessions (batch_id,session_id,zip_file_name) SELECT $1,id,zip_file_name FROM recording_sessions WHERE id=$2`, [batch.id, eagle.id]);
  await session("B", "Falcon", { status: "approved", deadline: null, enforced: false });
  const applied = await F.applyFeedback({ db: pool, taskId: ids.task.id, labelType: "fake", rows: [["Eagle", "2", "echo"]], startRow: 2, headLeaderId: ids.hl.id });
  assert.strictEqual(applied.sessions, 1);
  assert.strictEqual((await one(`SELECT rework_enforced FROM recording_sessions WHERE id=$1`, [eagle.id])).rework_enforced, true, "feedback deadlines are enforced");

  // before the deadline nothing is released
  let names = await (await api(`/talent/tasks/${ids.task.id}/fake-names`)).json();
  assert.deepStrictEqual(names.sort(), ["Owl"], "Eagle (in rework) and Falcon are still held");
  let tasks = await (await api("/talent/tasks")).json();
  assert.strictEqual(Number(tasks[0].submission_count), 2);

  // the 12 hours pass
  await pool.query(`UPDATE recording_sessions SET rework_deadline = ${past} WHERE id=$1`, [eagle.id]);

  names = await (await api(`/talent/tasks/${ids.task.id}/fake-names`)).json();
  assert.deepStrictEqual(names.sort(), ["Eagle", "Owl"], "Eagle is available again");
  tasks = await (await api("/talent/tasks")).json();
  assert.strictEqual(Number(tasks[0].submission_count), 1, "the slot is open again");
  assert.strictEqual((await status(eagle.id)).status, "expired");

  // a FEMALE talent takes the freed name, on the same task
  const cId = await talent("C");
  const start = (who, fakeName, gender) => api("/talent/sessions", who, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: ids.task.id, leaderId: ids.leader.id, gender, ageBracket: "adult", age: 25, fakeName }),
  });
  const taken = await start("C", "Eagle", "female");
  assert.strictEqual(taken.status, 201);
  assert.strictEqual((await taken.json()).session.gender, "female");
  // ...and now it is locked again: nobody else can take it while she holds it
  await talent("D");
  assert.strictEqual((await start("D", "Eagle", "male")).status, 409);

  // both rows exist; the old one keeps its name for the record
  const holders = (await pool.query(`SELECT status, gender FROM recording_sessions WHERE fake_name='Eagle' ORDER BY created_at`)).rows;
  assert.deepStrictEqual(holders.map((h) => h.status), ["expired", "in_progress"]);

  // the buyer's archive still shows exactly what was delivered
  const archived = await D.fetchBatchRows(pool, batch.id);
  assert.deepStrictEqual(archived.map((r) => r.fake_name), ["Eagle"]);
  assert.strictEqual(archived[0].zip_file_name, "Eagle-male-adult-30.zip");
  assert.strictEqual((await D.listDelivered(pool)).length, 1);
});

t("the withdrawn talent is told, and can no longer upload or submit (410)", async () => {
  await reset();
  const a = await session("A", "Eagle", { status: "rejected", deadline: past });
  // reads still work so the page can explain what happened
  const view = await (await api(`/talent/sessions/${a.token}`, "A")).json();
  assert.strictEqual(view.session.status, "expired");
  const mine = await (await api("/talent/me/sessions", "A")).json();
  assert.strictEqual(mine[0].status, "expired");

  const f = new FormData(); f.append("file", new Blob([Buffer.from("x")]), "a.wav");
  const up = await api(`/talent/sessions/${a.token}/samples/${ids.samples[0].id}/audio`, "A", { method: "POST", body: f });
  assert.strictEqual(up.status, 410);
  assert.match((await up.json()).error, /اتسحب/);
  assert.strictEqual((await api(`/talent/sessions/${a.token}/submit`, "A", { method: "POST" })).status, 410);
});

t("deadline is enforced even if nobody swept it yet: submit after the deadline is refused and withdraws it", async () => {
  await reset();
  const late = await session("L", "Owl", { status: "rejected", deadline: past });
  assert.strictEqual((await status(late.id)).status, "rejected", "not swept yet");
  const res = await api(`/talent/sessions/${late.token}/submit`, "L", { method: "POST" });
  assert.strictEqual(res.status, 410);
  assert.strictEqual((await status(late.id)).status, "expired");
});

t("another talent can't read or reuse someone else's withdrawn session", async () => {
  await reset();
  const a = await session("A", "Eagle", { status: "rejected", deadline: past });
  await talent("Z");
  assert.strictEqual((await api(`/talent/sessions/${a.token}`, "Z")).status, 403);
});

// --------------------------------------------------- feedback sees the withdrawal
t("feedback: a withdrawn holder can't be reworked; an alias given to someone else is never guessed", async () => {
  await reset();
  const oldEagle = await session("A", "Eagle", { status: "rejected", deadline: past, gender: "male", age: 30 });
  await session("O", "Owl", { status: "rejected", deadline: past });
  await E.expireOverdue(pool);
  await talent("N");
  const newEagle = await api("/talent/sessions", "N", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: ids.task.id, leaderId: ids.leader.id, gender: "female", ageBracket: "adult", age: 25, fakeName: "Eagle" }) });
  assert.strictEqual(newEagle.status, 201);
  const live = await one(`UPDATE recording_sessions SET status='approved' WHERE fake_name='Eagle' AND status='in_progress' RETURNING id`);
  for (const sm of ids.samples) await pool.query(`INSERT INTO recording_session_samples (session_id,sample_id,audio_file_url,qa_status) VALUES ($1,$2,'drive:x','approved')`, [live.id, sm.id]);

  const res = (rows, type = "fake") => F.resolveRows({ db: pool, taskId: ids.task.id, labelType: type, rows, startRow: 2 });
  const out = (await res([["Eagle", "1", ""], ["Eagle-female-adult-25.zip", "1", ""], ["Eagle-male-adult-30.zip", "1", ""], ["Owl", "1", ""]])).results;
  assert.strictEqual(out[0].code, "ambiguous", "same alias, two holders: refuse to guess");
  assert.strictEqual(out[1].ok, true, "the full zip name picks the current holder");
  assert.strictEqual(out[1].session.status, "approved");
  assert.strictEqual(out[2].code, "expired", "the old holder's zip name points at the withdrawn session");
  assert.strictEqual(out[3].code, "expired", "a lone withdrawn holder is explained, not 'unknown'");
  assert.match(out[2].message, /اتسحب/);

  // and apply never touches the wrong person
  const applied = await F.applyFeedback({ db: pool, taskId: ids.task.id, labelType: "fake", rows: [["Eagle", "1", "x"], ["Eagle-female-adult-25.zip", "2", "y"]], startRow: 2, headLeaderId: ids.hl.id });
  assert.strictEqual(applied.sessions, 1);
  assert.strictEqual((await status(oldEagle.id)).status, "expired");
  assert.strictEqual(applied.skipped.length, 1);
});

t("feedback listings: expired items are 'expired', never 'overdue'", async () => {
  await reset();
  const a = await session("A", "Eagle", { status: "rejected", deadline: future });
  await pool.query(`INSERT INTO studio_feedback_items (task_id,session_id,leader_id,fake_name,recording_numbers,status,rework_deadline) VALUES ($1,$2,$3,'Eagle','{1}','pending',$4)`,
    [ids.task.id, a.id, ids.leader.id, new Date(Date.now() - 3600000)]);
  await pool.query(`UPDATE recording_sessions SET rework_deadline = ${past} WHERE id=$1`, [a.id]);
  const mine = (await (await api("/feedback/mine", "A")).json()).items;     // runs the sweep first
  assert.strictEqual(mine[0].status, "expired");
  assert.strictEqual(mine[0].overdue, false);
});

// ------------------------------------------------ QA rejections get the same rule
t("QA rejection starts an ENFORCED 12h deadline; a legacy rejection is left alone", async () => {
  await reset();
  tok.qa = jwt.sign({ id: ids.qa.id, studioRole: "qa" }, "test-secret");
  const s = await session("Q", "Eagle", { status: "submitted", deadline: null, enforced: false });
  await pool.query(`UPDATE recording_session_samples SET qa_status='pending' WHERE session_id=$1`, [s.id]);
  const res = await api(`/qa/sessions/${s.id}/reject-all`, "qa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "noisy" }) });
  assert.strictEqual(res.status, 200, await res.clone().text());
  const row = await one(`SELECT status, rework_enforced, rework_deadline FROM recording_sessions WHERE id=$1`, [s.id]);
  assert.strictEqual(row.status, "rejected");
  assert.strictEqual(row.rework_enforced, true);
  assert.ok(new Date(row.rework_deadline) - Date.now() > 11.9 * 3600000);

  // a session rejected before this rule existed (flag false) survives any sweep
  const legacy = await session("Old", "Falcon", { status: "rejected", deadline: past, enforced: false });
  await E.expireOverdue(pool);
  assert.strictEqual((await status(legacy.id)).status, "rejected");
});

t("expiry: teardown", async () => { server.close(); await pool.end(); });
