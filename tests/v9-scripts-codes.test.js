// Studio v9 — scripts reserved for boys / girls, and codes split by gender AND age group.
// Real HTTP + real Postgres (needs TEST_DATABASE_URL with every migration up to v9 applied, otherwise skipped).
const URL_DB = process.env.TEST_DATABASE_URL;
const test = require("node:test");
const assert = require("node:assert");
const t = URL_DB ? test : test.skip;

let server, base, pool, jwt, hlTok, hlId, leaderId;
const talents = {};          // key -> { id, tok }
const call = async (path, { method = "GET", tok, body, form } = {}) => {
  const headers = tok ? { Authorization: `Bearer ${tok}` } : {};
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : form });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
};
const hl = (path, o = {}) => call(`/api/studio/headleader${path}`, { tok: hlTok, ...o });
const tal = (path, key, o = {}) => call(`/api/studio/talent${path}`, { tok: key ? talents[key].tok : undefined, ...o });
const formOf = (fields, extra = {}) => {
  const f = new FormData();
  for (const [name, files] of Object.entries(fields)) for (const [fname, text] of files) f.append(name, new Blob([text]), fname);
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  return f;
};
const scriptFiles = (names) => names.map((n) => [n, `${n} line one\n${n} line two\n${n} line three`]);
const codeFile = (codes) => [["codes.txt", codes.join("\n")]];

async function newTask(body) {
  const r = await hl("/tasks", { method: "POST", body: { title: "T", ...body } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
async function addTalent(key, gender, age, name) {
  const bracket = age < 18 ? "child" : age >= 60 ? "elderly" : "adult";
  const row = (await pool.query(
    `INSERT INTO studio_talents (name, email, password_hash, gender, age, age_bracket) VALUES ($1,$2,'x',$3,$4,$5) RETURNING id`,
    [name || `Person ${key}`, `${key}@mail.test`, gender, age, bracket])).rows[0];
  talents[key] = { id: row.id, tok: jwt.sign({ id: row.id, studioRole: "talent" }, "test-secret") };
}
const start = (key, task, extra = {}) => tal("/sessions", key, { method: "POST", body: { taskId: task.id, ...extra } });

t("boot", async () => {
  process.env.DATABASE_URL = URL_DB;
  process.env.JWT_SECRET = "test-secret";
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
  hlId = h.id; hlTok = jwt.sign({ id: h.id, studioRole: "head_leader" }, "test-secret");
  leaderId = (await pool.query(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('Lea','l@x.com','x','L001') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO studio_leaders (name,email,password_hash,leader_code,is_system,is_active) VALUES ('Direct','d@x.invalid','!','DIRECT',true,false)`);
  for (let i = 1; i <= 6; i++) await addTalent(`m${i}`, "male", 25, `Boy Number${String.fromCharCode(64 + i)}`);
  for (let i = 1; i <= 4; i++) await addTalent(`f${i}`, "female", 25, `Girl Number${String.fromCharCode(64 + i)}`);
  await addTalent("mc", "male", 10, "Kid Boy");
  await addTalent("me", "male", 70, "Old Boy");
  await addTalent("fc", "female", 12, "Kid Girl");
});

// ------------------------------------------------------------------------------------------------- scripts by gender
t("scripts: boys' scripts go to boys, girls' to girls, 'any' scripts to whoever runs out (direct task)", async () => {
  const task = await newTask({ scriptMode: "per_person", identityMode: "real", direct: true });
  let r = await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["b1.txt", "b2.txt"]) }, { gender: "male", mode: "replace_all" }) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(r.data.byGender, { male: 2, female: 0, any: 0 });
  r = await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["g1.txt"]) }, { gender: "female" }) });
  assert.deepStrictEqual(r.data.byGender, { male: 2, female: 1, any: 0 });
  r = await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["any1.txt"]) }) });     // no gender = anybody
  assert.deepStrictEqual(r.data.byGender, { male: 2, female: 1, any: 1 });
  assert.strictEqual((await hl(`/tasks/${task.id}/publish`, { method: "POST" })).status, 200);

  const detail = (await hl(`/tasks/${task.id}`)).data;
  assert.deepStrictEqual(detail.scripts.map((s) => [s.filename, s.gender]), [["b1.txt", "male"], ["b2.txt", "male"], ["g1.txt", "female"], ["any1.txt", null]]);
  assert.deepStrictEqual(detail.task.supply.male, { total: 3, left: 3 });
  assert.deepStrictEqual(detail.task.supply.female, { total: 2, left: 2 });

  const fileOf = async (resp) => (await pool.query(`SELECT s.filename FROM recording_sessions rs JOIN studio_task_scripts s ON s.id = rs.script_id WHERE rs.session_token = $1`, [resp.data.session.session_token])).rows[0].filename;
  const m1 = await start("m1", task); assert.strictEqual(m1.status, 201, JSON.stringify(m1.data)); assert.strictEqual(await fileOf(m1), "b1.txt");
  const m2 = await start("m2", task); assert.strictEqual(await fileOf(m2), "b2.txt");
  const f1 = await start("f1", task); assert.strictEqual(await fileOf(f1), "g1.txt");
  assert.strictEqual(m1.data.samples.length, 3);
  assert.ok(m1.data.samples.every((s) => s.sentence_name.startsWith("b1")), "a boy gets only the sentences of his own script");
  const m3 = await start("m3", task); assert.strictEqual(await fileOf(m3), "any1.txt");        // boys' scripts are over -> the 'anybody' one
  const m4 = await start("m4", task); assert.strictEqual(m4.status, 409); assert.strictEqual(m4.data.code, "QUOTA_FULL");
  const f2 = await start("f2", task); assert.strictEqual(f2.status, 409, "the only 'anybody' script went to a boy");

  // a withdrawn session gives its script back — to its own gender's pool
  await pool.query(`UPDATE recording_sessions SET status = 'expired' WHERE session_token = $1`, [m1.data.session.session_token]);
  const f3 = await start("f3", task); assert.strictEqual(f3.status, 409, "b1.txt is reserved for boys, a girl must not get it");
  const m5 = await start("m5", task); assert.strictEqual(await fileOf(m5), "b1.txt");
});

t("scripts: the same rules for a task that goes through a leader", async () => {
  const task = await newTask({ scriptMode: "per_person", identityMode: "real", leaderIds: [leaderId] });
  await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["g1.txt", "g2.txt"]) }, { gender: "female", mode: "replace_all" }) });
  await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["b1.txt"]) }, { gender: "male" }) });
  assert.strictEqual((await hl(`/tasks/${task.id}/publish`, { method: "POST" })).status, 200);
  const a = await start("f1", task, { leaderId }); assert.strictEqual(a.status, 201);
  const b = await start("m1", task, { leaderId }); assert.strictEqual(b.status, 201);
  const c = await start("m2", task, { leaderId }); assert.strictEqual(c.status, 409, "only one boys' script");
  const d = await start("f2", task, { leaderId }); assert.strictEqual(d.status, 201);
  const names = (await pool.query(`SELECT rs.gender, s.gender AS sg FROM recording_sessions rs JOIN studio_task_scripts s ON s.id = rs.script_id WHERE rs.task_id = $1`, [task.id])).rows;
  assert.ok(names.every((x) => x.gender === x.sg));
});

t("scripts: parallel talents never share a script and never get the other gender's one", async () => {
  const task = await newTask({ scriptMode: "per_person", identityMode: "real", direct: true });
  await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["b1.txt", "b2.txt"]) }, { gender: "male", mode: "replace_all" }) });
  await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["g1.txt", "g2.txt"]) }, { gender: "female" }) });
  await hl(`/tasks/${task.id}/publish`, { method: "POST" });
  const keys = ["m1", "m2", "m3", "m4", "m5", "m6", "f1", "f2", "f3", "f4"];
  const results = await Promise.all(keys.map((k) => start(k, task)));
  const ok = results.filter((r) => r.status === 201);
  assert.strictEqual(ok.length, 4, "2 boys' + 2 girls' scripts -> exactly 4 sessions");
  const rows = (await pool.query(`SELECT rs.gender, rs.script_id, s.gender AS sg FROM recording_sessions rs JOIN studio_task_scripts s ON s.id = rs.script_id WHERE rs.task_id = $1`, [task.id])).rows;
  assert.strictEqual(new Set(rows.map((r) => r.script_id)).size, 4, "no script twice");
  assert.ok(rows.every((r) => r.gender === r.sg));
  assert.strictEqual(rows.filter((r) => r.gender === "male").length, 2);
  for (const r of results.filter((x) => x.status !== 201)) assert.strictEqual(r.status, 409);
});

t("scripts: assign already-uploaded scripts to boys / girls (and not the ones somebody holds)", async () => {
  const task = await newTask({ scriptMode: "per_person", identityMode: "real", direct: true });
  await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["s1.txt", "s2.txt", "s3.txt", "s4.txt"]) }, { mode: "replace_all" }) });
  await hl(`/tasks/${task.id}/publish`, { method: "POST" });
  const ids = (await hl(`/tasks/${task.id}`)).data.scripts.map((s) => s.id);
  let r = await hl(`/tasks/${task.id}/scripts/assign`, { method: "POST", body: { scriptIds: ids.slice(0, 2), gender: "male" } });
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.data.byGender, { male: 2, female: 0, any: 2 });
  r = await hl(`/tasks/${task.id}/scripts/assign`, { method: "POST", body: { scriptIds: ids.slice(2), gender: "female" } });
  assert.deepStrictEqual(r.data.byGender, { male: 2, female: 2, any: 0 });
  const g = await start("f1", task); assert.strictEqual(g.status, 201);
  // the girl now holds one of the girls' scripts: it cannot be moved any more
  r = await hl(`/tasks/${task.id}/scripts/assign`, { method: "POST", body: { scriptIds: ids.slice(2), gender: "male" } });
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual((await hl(`/tasks/${task.id}`)).data.scripts.map((s) => s.gender), ["male", "male", "female", "female"]);
  assert.strictEqual((await hl(`/tasks/${task.id}/scripts/assign`, { method: "POST", body: { scriptIds: ids, gender: "robot" } })).status, 400);
  assert.strictEqual((await hl(`/tasks/${task.id}/scripts/assign`, { method: "POST", body: { scriptIds: [], gender: "male" } })).status, 400);
  assert.strictEqual((await hl(`/tasks/${task.id}/scripts/assign`, { method: "POST", body: { scriptIds: [ids[0], "00000000-0000-0000-0000-000000000000"], gender: "male" } })).status, 404);
});

t("scripts: replace only touches the scripts of its own gender group; replace_all is refused once somebody started", async () => {
  const task = await newTask({ scriptMode: "per_person", identityMode: "real", direct: true });
  await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["b1.txt", "b2.txt"]) }, { gender: "male", mode: "replace_all" }) });
  await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["g1.txt"]) }, { gender: "female" }) });
  let r = await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["bX.txt"]) }, { gender: "male", mode: "replace" }) });
  assert.deepStrictEqual(r.data.byGender, { male: 1, female: 1, any: 0 });
  await hl(`/tasks/${task.id}/publish`, { method: "POST" });
  await start("f1", task);
  r = await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["gY.txt"]) }, { gender: "female", mode: "replace" }) });
  assert.strictEqual(r.status, 409, "the girls' script is held");
  r = await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["bY.txt"]) }, { gender: "male", mode: "replace" }) });
  assert.strictEqual(r.status, 200, "nobody holds a boys' script, so the boys' group can still be replaced");
  r = await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["z.txt"]) }, { mode: "replace_all" }) });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["z.txt"]) }, { gender: "robot" }) })).status, 400);
});

t("scripts: old tasks (every script has no gender) behave exactly as before", async () => {
  const task = await newTask({ scriptMode: "per_person", identityMode: "real", direct: true });
  await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["a.txt", "b.txt"]) }, { mode: "replace_all" }) });
  await hl(`/tasks/${task.id}/publish`, { method: "POST" });
  assert.strictEqual((await start("m1", task)).status, 201);
  assert.strictEqual((await start("f1", task)).status, 201);
  assert.strictEqual((await start("m2", task)).status, 409);
});

// ------------------------------------------------------------------------------------------------- codes by gender + age group
const bracketTask = (extra = {}) => newTask({ identityMode: "codes", direct: true, useAgeBrackets: true, ...extra });
async function publishShared(task) {          // a shared script so the task can be published (rows inserted directly: the real upload goes to Google Drive)
  await pool.query(`INSERT INTO recording_samples (task_id, sentence_name, order_index) VALUES ($1,'one',0), ($1,'two',1)`, [task.id]);
  return hl(`/tasks/${task.id}/publish`, { method: "POST" });
}

t("codes: split by gender AND age group — each talent only sees and may only take his own list", async () => {
  const task = await bracketTask();
  const r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({
    male_child: codeFile(["MC1", "MC2"]), male_adult: codeFile(["MA1", "MA2", "MA3"]), male_elderly: codeFile(["ME1"]),
    female_adult: codeFile(["FA1", "FA2"]), female_child: codeFile(["FC1"]) }) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.male, 6); assert.strictEqual(r.data.female, 3);
  assert.deepStrictEqual(r.data.byBracket.male, { child: 2, adult: 3, elderly: 1 });
  assert.strictEqual((await publishShared(task)).status, 200);

  const names = async (g, b) => (await tal(`/tasks/${task.id}/fake-names?gender=${g}${b ? `&bracket=${b}` : ""}`)).data;
  assert.deepStrictEqual(await names("male", "adult"), ["MA1", "MA2", "MA3"]);
  assert.deepStrictEqual(await names("male", "child"), ["MC1", "MC2"]);
  assert.deepStrictEqual(await names("female", "adult"), ["FA1", "FA2"]);
  assert.deepStrictEqual(await names("female", "elderly"), [], "no elderly girls' list");
  assert.deepStrictEqual(await names("male"), [], "a split list needs the age group");

  // wrong gender / wrong age group are refused by the server even if the code exists
  let s = await start("m1", task, { fakeName: "FA1" }); assert.strictEqual(s.status, 400, "a girl's code for a boy");
  s = await start("m1", task, { fakeName: "MC1" }); assert.strictEqual(s.status, 400, "a child's code for an adult");
  s = await start("mc", task, { fakeName: "MA1" }); assert.strictEqual(s.status, 400, "an adult's code for a child");
  s = await start("m1", task, { fakeName: "MA1" }); assert.strictEqual(s.status, 201, JSON.stringify(s.data));
  assert.strictEqual(s.data.session.fake_name, "MA1"); assert.strictEqual(s.data.session.age_bracket, "adult");
  s = await start("mc", task, { fakeName: "MC2" }); assert.strictEqual(s.status, 201); assert.strictEqual(s.data.session.age_bracket, "child");
  s = await start("me", task, { fakeName: "ME1" }); assert.strictEqual(s.status, 201); assert.strictEqual(s.data.session.age_bracket, "elderly");
  s = await start("f1", task, { fakeName: "FA1" }); assert.strictEqual(s.status, 201);
  s = await start("m2", task, { fakeName: "MA1" }); assert.strictEqual(s.status, 409, "MA1 is taken");
  assert.deepStrictEqual(await names("male", "adult"), ["MA2", "MA3"]);

  // places left per (gender, age group) = the codes left in that group
  const slots = (await tal(`/tasks`)).data.find((x) => x.id === task.id).slots;
  const slot = (g, b) => slots.find((x) => x.gender === g && x.ageBracket === b);
  assert.strictEqual(slot("male", "adult").remaining, 2);
  assert.strictEqual(slot("male", "child").remaining, 1);
  assert.strictEqual(slot("male", "elderly").remaining, 0); assert.ok(slot("male", "elderly").full);
  assert.strictEqual(slot("female", "adult").remaining, 1);
  assert.strictEqual(slot("female", "elderly").remaining, 0);
  // the code lists themselves are never sent to a talent
  assert.ok(!("identity_codes" in (await tal(`/tasks`)).data.find((x) => x.id === task.id)));
});

t("codes: a task can have boys' codes split by age group and girls' codes as one plain list", async () => {
  const task = await bracketTask();
  const r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ male_adult: codeFile(["MA1"]), male_child: codeFile(["MC1"]), female: codeFile(["F1", "F2"]) }) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.byBracket.female, null);
  await publishShared(task);
  const names = async (g, b) => (await tal(`/tasks/${task.id}/fake-names?gender=${g}&bracket=${b}`)).data;
  assert.deepStrictEqual(await names("female", "child"), ["F1", "F2"], "a plain list is for every age group");
  assert.deepStrictEqual(await names("female", "elderly"), ["F1", "F2"]);
  assert.deepStrictEqual(await names("male", "child"), ["MC1"]);
  assert.strictEqual((await start("fc", task, { fakeName: "F1" })).status, 201);
  assert.strictEqual((await start("f1", task, { fakeName: "F1" })).status, 409);
});

t("codes: every mistake in the upload is refused with a clear message", async () => {
  const task = await bracketTask();
  let r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ male: codeFile(["A"]), male_adult: codeFile(["B"]) }) });
  assert.strictEqual(r.status, 400, "plain list + age lists for the same gender");
  r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ male_adult: codeFile(["A", "B"]), female_adult: codeFile(["B"]) }) });
  assert.strictEqual(r.status, 400); assert.match(r.data.error, /"B"/, "same code in two lists");
  r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ male_adult: codeFile(["A", "B"]), male_child: codeFile(["A"]) }) });
  assert.strictEqual(r.status, 400, "same code in two age groups");
  r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ male_adult: codeFile(["A", "A"]) }) });
  assert.strictEqual(r.status, 400, "code twice in one file");
  r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ male_adult: [["e.txt", "\n\n"]]}) });
  assert.strictEqual(r.status, 400, "empty file");
  r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({}) });
  assert.strictEqual(r.status, 400, "nothing sent");
  assert.deepStrictEqual((await pool.query(`SELECT identity_codes FROM recording_tasks WHERE id = $1`, [task.id])).rows[0].identity_codes, { male: [], female: [] }, "a refused upload changes nothing");

  const noBr = await newTask({ identityMode: "codes", direct: true });                 // age groups are off
  r = await hl(`/tasks/${noBr.id}/codes`, { method: "POST", form: formOf({ male_adult: codeFile(["A"]) }) });
  assert.strictEqual(r.status, 400); assert.match(r.data.error, /الفئات العمرية/);
});

t("codes: append adds to the right age group, shape changes need 'replace', and brackets can't be switched off under split codes", async () => {
  const task = await bracketTask();
  await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ male_adult: codeFile(["A1", "A2"]), female: codeFile(["F1"]) }) });
  let r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ male_adult: codeFile(["A2", "A3"]), male_child: codeFile(["C1"]) }, { mode: "append" }) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.strictEqual(r.data.skipped, 1);
  assert.deepStrictEqual(r.data.byBracket.male, { child: 1, adult: 3, elderly: 0 });
  assert.strictEqual(r.data.female, 1, "the girls' list was not touched");
  r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ male: codeFile(["X"]) }, { mode: "append" }) });
  assert.strictEqual(r.status, 400, "append a plain list onto a split one");
  r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ female_adult: codeFile(["Y"]) }, { mode: "append" }) });
  assert.strictEqual(r.status, 400, "append a split list onto a plain one");
  r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ female_adult: codeFile(["Y"]) }, { mode: "replace" }) });
  assert.strictEqual(r.status, 200, "replace may change the shape");
  r = await hl(`/tasks/${task.id}/quotas`, { method: "PUT", body: { useAgeBrackets: false, quotas: [] } });
  assert.strictEqual(r.status, 409, JSON.stringify(r.data));
  r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ male: codeFile(["A1", "A2", "A3", "C1"]), female: codeFile(["Y"]) }, { mode: "replace" }) });
  assert.strictEqual(r.status, 200);
  r = await hl(`/tasks/${task.id}/quotas`, { method: "PUT", body: { useAgeBrackets: false, quotas: [] } });
  assert.strictEqual(r.status, 200, "plain lists again: brackets can go");
});

t("codes: tasks stored in the OLD shape ({male:[..],female:[..]}) keep working untouched", async () => {
  const task = await newTask({ identityMode: "codes", direct: true });
  await pool.query(`UPDATE recording_tasks SET identity_codes = $2 WHERE id = $1`, [task.id, JSON.stringify({ male: ["OM1", "OM2"], female: ["OF1"] })]);
  await publishShared(task);
  assert.deepStrictEqual((await tal(`/tasks/${task.id}/fake-names?gender=male`)).data, ["OM1", "OM2"]);
  assert.deepStrictEqual((await tal(`/tasks/${task.id}/fake-names?gender=female`)).data, ["OF1"]);
  assert.strictEqual((await start("f1", task, { fakeName: "OM1" })).status, 400);
  assert.strictEqual((await start("f1", task, { fakeName: "OF1" })).status, 201);
  assert.strictEqual((await start("f2", task, { fakeName: "OF1" })).status, 409);
  const d = (await hl(`/tasks/${task.id}`)).data.task;
  assert.deepStrictEqual(d.codes_total, { male: 2, female: 1 }); assert.deepStrictEqual(d.codes_left, { male: 2, female: 0 });
  assert.deepStrictEqual(d.codes_by_bracket, { male: null, female: null });
  // and a plain codes upload still works the way it did
  const r = await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ male: codeFile(["N1"]) }, { mode: "append" }) });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.male, 3);
});

t("codes + scripts together: boys' scripts and boys' codes of one age group both limit the places", async () => {
  const task = await newTask({ identityMode: "codes", scriptMode: "per_person", direct: true, useAgeBrackets: true });
  await hl(`/tasks/${task.id}/scripts`, { method: "POST", form: formOf({ files: scriptFiles(["b1.txt", "b2.txt"]) }, { gender: "male", mode: "replace_all" }) });
  await hl(`/tasks/${task.id}/codes`, { method: "POST", form: formOf({ male_adult: codeFile(["A1", "A2", "A3"]), male_child: codeFile(["C1"]), female_adult: codeFile(["G1"]) }) });
  assert.strictEqual((await hl(`/tasks/${task.id}/publish`, { method: "POST" })).status, 200);
  const slots = (await tal(`/tasks`)).data.find((x) => x.id === task.id).slots;
  const slot = (g, b) => slots.find((x) => x.gender === g && x.ageBracket === b);
  assert.strictEqual(slot("male", "adult").remaining, 2, "3 codes but only 2 boys' scripts");
  assert.strictEqual(slot("male", "child").remaining, 1);
  assert.strictEqual(slot("female", "adult").remaining, 0, "a girl's code but no script for girls");
  assert.ok(slot("female", "adult").full);
  assert.strictEqual((await start("f1", task, { fakeName: "G1" })).status, 409);
  assert.strictEqual((await start("m1", task, { fakeName: "A1" })).status, 201);
  assert.strictEqual((await start("mc", task, { fakeName: "C1" })).status, 201);
  assert.strictEqual((await start("m2", task, { fakeName: "A2" })).status, 409, "boys' scripts are over");
});

t("shutdown", async () => { await new Promise((r) => server.close(r)); await pool.end(); });
