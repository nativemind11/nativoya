// Leader dashboard boxes (every talent counted in exactly ONE box) + "final rejection" feedback (v5).
// Needs TEST_DATABASE_URL (migration_studio_v5.sql applied).
const test = require("node:test");
const assert = require("node:assert");
const F = require("../config/studioFeedback.js");
const { getOverview } = require("../config/studioLeader.js");
const { expireOverdue } = require("../config/studioExpiry.js");

// ------------------------------------------------------------ unit: the sheet
test("extractRows: 'final' only exists in the rows when the feature is used (old shape untouched)", () => {
  const sheet = { name: "S", grid: [["name", "no", "why", "status"], ["Eagle", "1", "echo", "Rejected"], ["Falcon", "2", "bad", "Final reject"], ["Owl", "3", "ok", "Approved"]] };
  const plain = F.extractRows(sheet, { headerRow: 1, labelCol: 0, numbersCol: 1, descCol: 2 });
  assert.deepStrictEqual(plain.rows[0], ["Eagle", "1", "echo"], "no 6th cell without the feature");
  const st = F.extractRows(sheet, { headerRow: 1, labelCol: 0, numbersCol: 1, descCol: 2, statusCol: 3, rejectValues: ["Rejected"], finalValues: ["Final reject"] });
  assert.deepStrictEqual(st.rows.map((r) => [r[0], r[5]]), [["Eagle", ""], ["Falcon", "1"]], "Approved is ignored, 'Final reject' is final (and needs no separate tick as 'rejected')");
  const all = F.extractRows(sheet, { headerRow: 1, labelCol: 0, numbersCol: 1, descCol: 2, allFinal: true });
  assert.ok(all.rows.every((r) => r[5] === "1"));
});

// ------------------------------------------------------------------ flow (DB)
const URL_DB = process.env.TEST_DATABASE_URL;
const t = URL_DB ? test : test.skip;
let pool, hl, L1, L2, T1, T2, qa, samples1;
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
let n = 0;
async function addSession(task, leader, fake, status, { delivered = false, samples = [] } = {}) {
  n++;
  const tal = await one(`INSERT INTO studio_talents (name,email,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`Real ${fake}`, `b${n}@m.com`]);
  const s = await one(`INSERT INTO recording_sessions (task_id,leader_id,talent_id,session_token,gender,age_bracket,age,fake_name,status,rework_enforced)
    VALUES ($1,$2,$3,$4,'male','adult',30,$5,$6,true) RETURNING id`, [task, leader, tal.id, `bx${n}`, fake, status]);
  for (const sm of samples) await pool.query(`INSERT INTO recording_session_samples (session_id,sample_id,audio_file_url,qa_status) VALUES ($1,$2,'drive:x','approved')`, [s.id, sm]);
  if (delivered) {
    const b = await one(`INSERT INTO studio_delivery_batches (task_id,gender,qa_reviewer_id,group_day,status,session_count,zip_file_url) VALUES ($1,'male',$2,current_date,'delivered',1,'https://drive.google.com/file/d/B/view') RETURNING id`, [task, qa.id]);
    await pool.query(`UPDATE recording_sessions SET delivery_batch_id=$1 WHERE id=$2`, [b.id, s.id]);
  }
  return s.id;
}
const sheetRows = (label, nos, extra = []) => ({ db: pool, taskId: T1, labelType: "fake", rows: [[label, nos, "echo", ...extra]], startRow: 2 });

t("setup", async () => {
  const { Pool } = require("pg"); pool = new Pool({ connectionString: URL_DB });
  await pool.query(`TRUNCATE studio_feedback_items, studio_delivery_batch_sessions, studio_delivery_batches, recording_session_samples,
    recording_sessions, recording_samples, recording_task_leaders, recording_tasks, studio_talents, studio_leaders, studio_qa_reviewers, studio_head_leaders CASCADE`);
  hl = await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Head','h@x.com','x') RETURNING id`);
  L1 = (await one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('L1','l1@x.com','x','L001') RETURNING id`)).id;
  L2 = (await one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('L2','l2@x.com','x','L002') RETURNING id`)).id;
  qa = await one(`INSERT INTO studio_qa_reviewers (name,email,password_hash) VALUES ('QA','q@x.com','x') RETURNING id`);
  T1 = (await one(`INSERT INTO recording_tasks (title,head_leader_id,quantity,status) VALUES ('Open Task',$1,50,'published') RETURNING id`, [hl.id])).id;
  T2 = (await one(`INSERT INTO recording_tasks (title,head_leader_id,quantity,status) VALUES ('Finished Task',$1,50,'closed') RETURNING id`, [hl.id])).id;
  for (const task of [T1, T2]) for (const l of [L1, L2]) await pool.query(`INSERT INTO recording_task_leaders (task_id, leader_id) VALUES ($1,$2)`, [task, l]);
  samples1 = [];
  for (let i = 0; i < 3; i++) samples1.push((await one(`INSERT INTO recording_samples (task_id,sentence_name,order_index) VALUES ($1,$2,$3) RETURNING id`, [T1, `S${i + 1}`, i])).id);
});

t("each talent lands in exactly one box; the company / final / approved boxes follow the feedback and the task's end", async () => {
  await addSession(T1, L1, "Prog", "in_progress");
  await addSession(T1, L1, "Waiting", "submitted");
  await addSession(T1, L1, "OursA", "approved", { samples: samples1 });
  await addSession(T1, L1, "OursB", "approved", { samples: samples1, delivered: true });
  await addSession(T1, L1, "QaRej", "rejected", { samples: samples1 });
  const comp = await addSession(T1, L1, "Comp", "approved", { samples: samples1, delivered: true });
  const fin = await addSession(T1, L1, "Fin", "approved", { samples: samples1, delivered: true });
  const late = await addSession(T1, L1, "Late", "approved", { samples: samples1, delivered: true });
  await addSession(T1, L2, "Other", "approved", { samples: samples1 });          // another leader's: never counted for L1

  // company feedback: Comp -> rework; Fin -> FINAL rejection; Late -> rework whose deadline passes
  const ex = (allFinal) => F.extractRows({ grid: [["n", "no", "why"], ["x", "1", "echo"]] }, { headerRow: 1, labelCol: 0, numbersCol: 1, descCol: 2, allFinal });
  await F.applyFeedback({ db: pool, taskId: T1, labelType: "fake", rows: [["Comp", "1", "echo"]], startRow: 2, headLeaderId: hl.id });
  await F.applyFeedback({ db: pool, taskId: T1, labelType: "fake", rows: [["Late", "2", "noise"]], startRow: 2, headLeaderId: hl.id });
  const fr = ex(true).rows[0]; fr[0] = "Fin"; fr[1] = "3";
  const res = await F.applyFeedback({ db: pool, taskId: T1, labelType: "fake", rows: [fr], startRow: 2, headLeaderId: hl.id });
  assert.deepStrictEqual([res.sessions, res.samples, res.finalItems], [1, 0, 1], "a final rejection marks no recording and counts one item");

  // a final rejection changes NOTHING about the session / its recordings
  const finRow = await one(`SELECT status, rework_deadline, delivery_batch_id FROM recording_sessions WHERE id=$1`, [fin]);
  assert.strictEqual(finRow.status, "approved"); assert.strictEqual(finRow.rework_deadline, null); assert.ok(finRow.delivery_batch_id);
  assert.strictEqual((await one(`SELECT count(*)::int c FROM recording_session_samples WHERE session_id=$1 AND qa_status='rejected'`, [fin])).c, 0);
  const item = await one(`SELECT status, is_final, rework_deadline FROM studio_feedback_items WHERE session_id=$1`, [fin]);
  assert.deepStrictEqual([item.status, item.is_final, item.rework_deadline], ["expired", true, null]);

  // Late: the redo deadline passes -> the session expires, its item is closed
  await pool.query(`UPDATE recording_sessions SET rework_deadline = now() - interval '1 hour' WHERE id=$1`, [late]);
  await expireOverdue(pool);
  assert.strictEqual((await one(`SELECT status FROM recording_sessions WHERE id=$1`, [late])).status, "expired");
  assert.strictEqual((await one(`SELECT is_final FROM studio_feedback_items WHERE session_id=$1`, [late])).is_final, false, "missed deadline is not an explicit final item, but still counts as final for the leader");
  // the final item is untouched by the expiry job
  assert.strictEqual((await one(`SELECT status FROM studio_feedback_items WHERE session_id=$1`, [fin])).status, "expired");

  // the other task is finished: an approved talent there is "approved"; one that redid company feedback too
  await pool.query(`UPDATE recording_tasks SET finalized_at = now() WHERE id=$1`, [T2]);
  await addSession(T2, L1, "Done", "approved");
  const redone = await addSession(T2, L1, "Redone", "approved");
  await pool.query(`INSERT INTO studio_feedback_items (task_id,session_id,leader_id,fake_name,recording_numbers,status,reworked_at) VALUES ($1,$2,$3,'Redone','{1}','reworked',now())`, [T2, redone, L1]);

  const o = await getOverview(pool, L1);
  assert.deepStrictEqual(o.stats, {
    openTasks: 1, inProgress: 1, reviewing: 1,
    reviewedByUs: 2, reviewedByUsDelivered: 1,        // OursA, OursB (OursB already delivered)
    reviewedByCompany: 1,                             // Comp
    finalRejected: 2,                                 // Fin (explicit) + Late (redo deadline missed)
    approved: 2,                                      // Done + Redone, task finished, nothing outstanding
    rejected: 1,                                      // QaRej (QA) — company rework is NOT counted here
    delivered: 2,                                     // OursB, Fin (Comp was sent back: its delivery pointer is cleared by design; Late expired)
  });
  const total = o.stats.inProgress + o.stats.reviewing + o.stats.reviewedByUs + o.stats.reviewedByCompany + o.stats.finalRejected + o.stats.approved + o.stats.rejected;
  assert.strictEqual(total, 10, "10 talents of this leader, each in exactly one box");
  const t1 = o.tasks.find((x) => x.id === T1), t2 = o.tasks.find((x) => x.id === T2);
  assert.deepStrictEqual([t1.reviewed_by_us, t1.reviewed_by_company, t1.final_rejected, t1.approved, t1.rejected], [2, 1, 2, 0, 1]);
  assert.deepStrictEqual([t2.approved, t2.reviewed_by_us], [2, 0]);
  const cats = Object.fromEntries(o.sessions.map((s) => [s.fake_name, s.cat]));
  assert.deepStrictEqual(cats, { Prog: "progress", Waiting: "reviewing", OursA: "ours", OursB: "ours", QaRej: "rejected", Comp: "company", Fin: "final", Late: "final", Done: "approved", Redone: "approved" });
  assert.ok(!("Other" in cats), "another leader's talent never shows");

  // what the talent / leader read
  const mine = await F.listMine(pool, "talent", (await one(`SELECT talent_id FROM recording_sessions WHERE id=$1`, [fin])).talent_id);
  assert.strictEqual(mine[0].is_final, true);
});

t("a final rejection together with ordinary rework rows in one upload: only the rework ones go back", async () => {
  const sid = await addSession(T1, L1, "Mixed", "approved", { samples: samples1, delivered: true });
  const rows = [["Mixed", "1", "echo", "", "", ""], ["Mixed", "2", "noise", "", "", "1"]];
  const r = await F.applyFeedback({ db: pool, taskId: T1, labelType: "fake", rows, startRow: 2, headLeaderId: hl.id });
  assert.deepStrictEqual([r.samples, r.finalItems, r.items], [1, 1, 2]);
  const rej = (await pool.query(`SELECT s.order_index+1 AS n FROM recording_session_samples ss JOIN recording_samples s ON s.id=ss.sample_id WHERE ss.session_id=$1 AND ss.qa_status='rejected'`, [sid])).rows;
  assert.deepStrictEqual(rej.map((x) => x.n), [1]);
  assert.strictEqual((await one(`SELECT status FROM recording_sessions WHERE id=$1`, [sid])).status, "rejected");
});

t("teardown", async () => { await pool.end(); });
