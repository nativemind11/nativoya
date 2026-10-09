// HTTP-level test for /api/studio/feedback: real multipart uploads of an .xlsx,
// roles, validation, preview/apply, and what a talent / leader get back.
const URL_DB = process.env.TEST_DATABASE_URL;
const test = require("node:test");
const assert = require("node:assert");
const t = URL_DB ? test : test.skip;

let server, base, pool, jwt, ExcelJS, ids, tok = {};

t("boot", async () => {
  process.env.DATABASE_URL = URL_DB;
  process.env.JWT_SECRET = "test-secret";
  const express = require("express");
  jwt = require("jsonwebtoken");
  ExcelJS = require("exceljs");
  ({ pool } = require("../db/pool"));
  const app = express();
  app.use(express.json());
  app.use("/api/studio/feedback", require("../routes/studio/feedback"));
  app.use("/api/studio/talent", require("../routes/studio/talent"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/studio/feedback`;

  await pool.query(`TRUNCATE studio_feedback_items, studio_delivery_batch_sessions, studio_delivery_batches, recording_session_samples,
    recording_sessions, recording_samples, recording_tasks, studio_talents, studio_leaders, studio_qa_reviewers, studio_head_leaders CASCADE`);
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const hl = await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Head','h@x.com','x') RETURNING id`);
  const leader = await one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('Lea','l@x.com','x','L001') RETURNING id`);
  const otherLeader = await one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('Other','o@x.com','x','L002') RETURNING id`);
  const qa = await one(`INSERT INTO studio_qa_reviewers (name,email,password_hash) VALUES ('QA','q@x.com','x') RETURNING id`);
  const task = await one(`INSERT INTO recording_tasks (title,head_leader_id,quantity) VALUES ('HTTP FB',$1,10) RETURNING id`, [hl.id]);
  const samples = [];
  for (let i = 0; i < 4; i++) samples.push(await one(`INSERT INTO recording_samples (task_id,sentence_name,order_index) VALUES ($1,$2,$3) RETURNING id`, [task.id, `S${i}`, i]));
  const mk = async (fake, ldr) => {
    const tal = await one(`INSERT INTO studio_talents (name,email,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`Real ${fake}`, `${fake}@mail.com`]);
    const s = await one(`INSERT INTO recording_sessions (task_id,leader_id,talent_id,session_token,gender,age_bracket,age,fake_name,status,zip_file_url,zip_file_name,qa_reviewer_id,qa_reviewed_at)
      VALUES ($1,$2,$3,$4,'male','adult',30,$5,'approved','https://drive.google.com/file/d/Q'||$4,$6,$7,now()) RETURNING id`,
      [task.id, ldr.id, tal.id, `httpfb-${fake}`, fake, `${fake}-male-adult-30.zip`, qa.id]);
    for (const sm of samples) await pool.query(`INSERT INTO recording_session_samples (session_id,sample_id,audio_file_url,qa_status) VALUES ($1,$2,'drive:x','approved')`, [s.id, sm.id]);
    return { id: s.id, talentId: tal.id };
  };
  const eagle = await mk("Eagle", leader);
  const falcon = await mk("Falcon", otherLeader);
  ids = { hl: hl.id, leader: leader.id, otherLeader: otherLeader.id, qa: qa.id, task: task.id, eagle, falcon };
  const sign = (id, role) => jwt.sign({ id, studioRole: role }, "test-secret");
  tok = { hl: sign(hl.id, "head_leader"), leader: sign(leader.id, "leader"), otherLeader: sign(otherLeader.id, "leader"),
          qa: sign(qa.id, "qa"), eagle: sign(eagle.talentId, "talent"), falcon: sign(falcon.talentId, "talent") };
});

async function sheetBuffer() {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Company feedback").addRows([
    ["Company QA report"],
    ["Audio file", "Clip no.", "What is wrong"],
    ["Eagle-male-adult-30.zip", "2, 3", "echo in the room"],
    ["Falcon-male-adult-30.zip", 1, "too quiet"],
    ["Ghost-male-adult-30.zip", 1, "unknown person"],
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
function form(buf, fields = {}, name = "feedback.xlsx") {
  const f = new FormData();
  f.append("file", new Blob([buf]), name);
  for (const [k, v] of Object.entries(fields)) f.append(k, String(v));
  return f;
}
const MAP = () => ({ taskId: ids.task, sheetIndex: 0, headerRow: 2, labelCol: 0, numbersCol: 1, descCol: 2, labelType: "zip" });
const post = (path, tk, body) => fetch(base + path, { method: "POST", headers: tk ? { Authorization: `Bearer ${tk}` } : {}, body });
const get = (path, tk) => fetch(base + path, { headers: tk ? { Authorization: `Bearer ${tk}` } : {} });

t("roles: only the head leader uploads; only talent/leader read /mine", async () => {
  const buf = await sheetBuffer();
  assert.strictEqual((await post("/parse", null, form(buf))).status, 401);
  for (const who of ["leader", "qa", "eagle"]) assert.strictEqual((await post("/parse", tok[who], form(buf))).status, 403, who);
  assert.strictEqual((await get("/items", tok.leader)).status, 403);
  assert.strictEqual((await get("/mine", tok.hl)).status, 403);
  assert.strictEqual((await get("/mine", tok.qa)).status, 403);
  assert.strictEqual((await get("/mine", null)).status, 401);
});

t("parse: returns sheets, headers, preview and a guessed mapping", async () => {
  const res = await post("/parse", tok.hl, form(await sheetBuffer()));
  assert.strictEqual(res.status, 200);
  const { sheets } = await res.json();
  assert.strictEqual(sheets[0].name, "Company feedback");
  assert.strictEqual(sheets[0].headerRow, 2);
  assert.deepStrictEqual(sheets[0].columns.map((c) => c.header), ["Audio file", "Clip no.", "What is wrong"]);
  assert.deepStrictEqual(sheets[0].guess, { labelCol: 0, labelType: "zip", numbersCol: 1, descCol: 2 });
});

t("bad input is rejected with clear errors (no file, not a spreadsheet, too big, bad ids/columns)", async () => {
  assert.strictEqual((await post("/parse", tok.hl, new FormData())).status, 400);
  const notSheet = await post("/parse", tok.hl, form(Buffer.from("hello"), {}, "x.xlsx"));
  assert.strictEqual(notSheet.status, 400);
  assert.match((await notSheet.json()).error, /Excel/);
  assert.strictEqual((await post("/parse", tok.hl, form(Buffer.alloc(4.5 * 1024 * 1024)))).status, 413);
  const buf = await sheetBuffer();
  assert.strictEqual((await post("/preview", tok.hl, form(buf, { ...MAP(), taskId: "nope" }))).status, 400);
  assert.strictEqual((await post("/preview", tok.hl, form(buf, { ...MAP(), labelCol: 99 }))).status, 400);
  assert.strictEqual((await post("/preview", tok.hl, form(buf, { ...MAP(), numbersCol: "" }))).status, 400);
  assert.strictEqual((await post("/preview", tok.hl, form(buf, { ...MAP(), taskId: "00000000-0000-0000-0000-000000000000" }))).status, 404);
});

t("preview: matches rows, flags the unknown one, writes nothing", async () => {
  const res = await post("/preview", tok.hl, form(await sheetBuffer(), MAP()));
  assert.strictEqual(res.status, 200);
  const out = await res.json();
  assert.deepStrictEqual(out.summary, { total: 3, ok: 2, errors: 1, sessions: 2 });
  assert.strictEqual(out.results[0].row, 3, "Excel row numbers match the file");
  assert.strictEqual(out.results[0].session.email, "Eagle@mail.com");
  assert.strictEqual(out.results[2].code, "no_session");
  assert.strictEqual((await pool.query(`SELECT count(*)::int c FROM studio_feedback_items`)).rows[0].c, 0);
});

t("apply: rework starts; head leader / talent / leader each see the right thing", async () => {
  const res = await post("/apply", tok.hl, form(await sheetBuffer(), MAP()));
  assert.strictEqual(res.status, 200);
  const out = await res.json();
  assert.deepStrictEqual([out.sessions, out.items, out.samples, out.skipped.length, out.reworkHours], [2, 2, 3, 1, 12]);

  const items = (await (await get("/items", tok.hl)).json()).items;
  assert.strictEqual(items.length, 2);
  assert.ok(items.every((i) => i.status === "pending" && i.overdue === false && !("session_token" in i)));
  assert.strictEqual((await (await get(`/items?taskId=${ids.task}`, tok.hl)).json()).items.length, 2);
  assert.strictEqual((await get("/items?taskId=zzz", tok.hl)).status, 400);

  const eagleView = (await (await get("/mine", tok.eagle)).json()).items;
  assert.strictEqual(eagleView.length, 1, "talent sees only their own");
  assert.deepStrictEqual(eagleView[0].recording_numbers, [2, 3]);
  assert.strictEqual(eagleView[0].issue_description, "echo in the room");
  assert.strictEqual(eagleView[0].session_token, "httpfb-Eagle");
  assert.ok(!("email" in eagleView[0]));

  const leaderView = (await (await get("/mine", tok.leader)).json()).items;
  assert.deepStrictEqual(leaderView.map((i) => i.fake_name), ["Eagle"], "a leader only sees their own team");
  assert.strictEqual(leaderView[0].real_name, "Real Eagle");
  assert.ok(!("session_token" in leaderView[0]));
  assert.deepStrictEqual((await (await get("/mine", tok.otherLeader)).json()).items.map((i) => i.fake_name), ["Falcon"]);
});

t("the talent opening the rework screen (real talent route) acknowledges the feedback; the deadline is on the session", async () => {
  const talentBase = base.replace("/feedback", "/talent");
  const res = await fetch(`${talentBase}/sessions/httpfb-Eagle`, { headers: { Authorization: `Bearer ${tok.eagle}` } });
  assert.strictEqual(res.status, 200);
  const { session, samples } = await res.json();
  assert.strictEqual(session.status, "rejected");
  assert.ok(new Date(session.rework_deadline) - Date.now() > 11 * 3600000, "12h deadline is exposed to the rework screen");
  assert.match(session.rejection_reason, /فيدباك من الشركة/);
  assert.deepStrictEqual(samples.filter((x) => x.qa_status === "rejected").map((x) => x.order_index), [1, 2], "only recordings 2 and 3 are open for rework");
  await new Promise((r) => setTimeout(r, 150));   // the acknowledge runs right after the response
  const mine = (await (await get("/mine", tok.eagle)).json()).items;
  assert.strictEqual(mine[0].status, "acknowledged");
  const other = (await (await get("/mine", tok.falcon)).json()).items;
  assert.strictEqual(other[0].status, "pending", "another talent's feedback is untouched");
});

t("apply with nothing valid is a 400, not a silent success", async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("x").addRows([["file", "n", "d"], ["Nobody-male-adult-30.zip", 1, "x"]]);
  const res = await post("/apply", tok.hl, form(Buffer.from(await wb.xlsx.writeBuffer()), { ...MAP(), headerRow: 1 }));
  assert.strictEqual(res.status, 400);
});

t("teardown", async () => { server.close(); await pool.end(); });
