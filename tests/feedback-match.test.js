// Feedback v5: matching by NAME ("Marie Louise_8_f_children" -> "Marie Louise") and by SENTENCE (file number + text).
// Unit tests run anywhere; the flow tests need TEST_DATABASE_URL.
const test = require("node:test");
const assert = require("node:assert");
const ExcelJS = require("exceljs");
const F = require("../config/studioFeedback.js");
const M = require("../config/studioFeedbackMatch.js");

// ----------------------------------------------------------------- names
const sessions = [
  { id: "1", fake_name: "Marie Louise", gender: "female", age_bracket: "child", age: 8 },
  { id: "2", fake_name: "Marie", gender: "female", age_bracket: "adult", age: 30 },
  { id: "3", fake_name: "Super-Eva", gender: "female", age_bracket: "adult", age: 25 },
  { id: "4", fake_name: "Joseph", gender: "male", age_bracket: "child", age: 10 },
  { id: "5", fake_name: "Joseph", gender: "male", age_bracket: "adult", age: 23 },
];
test("names: only the name part is compared; the buyer's extras are ignored; the longest name wins", () => {
  const idx = M.buildNameIndex(sessions);
  const id = (raw) => { const f = idx.find(raw); const s = M.pickByExtras(f.list, f.extras); return s && s.id; };
  assert.strictEqual(id("Marie Louise_8_f_children"), "1");
  assert.strictEqual(id("Marie Louise_8_f_children.zip"), "1");
  assert.strictEqual(id("Marie_8_f_children"), "2", "'Marie' alone is the shorter name");
  assert.strictEqual(id("marie  louise-F-8"), "1", "case, spaces and separators do not matter");
  assert.strictEqual(id("Super-Eva_F_25_adult.zip"), "3", "a hyphen inside a fake name is fine");
  assert.strictEqual(id("folder/sub\\Marie Louise_8.zip"), "1");
  assert.strictEqual(id("Nobody_8_f"), null);
});
test("names: two holders of one name are told apart by the age / group the sheet carries, never guessed", () => {
  const idx = M.buildNameIndex(sessions);
  const f1 = idx.find("Joseph_male_10"), f2 = idx.find("Joseph_23_male_adult"), f3 = idx.find("Joseph");
  assert.strictEqual(M.pickByExtras(f1.list, f1.extras).id, "4");
  assert.strictEqual(M.pickByExtras(f2.list, f2.extras).id, "5");
  assert.strictEqual(M.pickByExtras(f3.list, f3.extras), null);
});
test("names: an unknown name comes with its closest real names", () => {
  const idx = M.buildNameIndex(sessions);
  const f = idx.find("Marei Louise_8_f");
  assert.strictEqual(f.list.length, 0);
  assert.strictEqual(f.nameGuess, "marei louise");
  assert.strictEqual(idx.suggest(f.nameGuess)[0].id, "1");
});

test("names: unique first name wins, then the second name, then gender/age — '.zip' never matters on either side", () => {
  const S = [
    { id: "m", fake_name: "mary-11-f-child.zip", gender: "male", age_bracket: "child", age: 12 },
    { id: "al", fake_name: "Ann Lee", gender: "female", age_bracket: "adult", age: 30 },
    { id: "ak", fake_name: "Ann Kim", gender: "female", age_bracket: "adult", age: 40 },
    { id: "a2", fake_name: "Ann Lee_2", gender: "female", age_bracket: "adult", age: 50 },
  ];
  const idx = M.buildNameIndex(S);
  const hit = (raw) => { const f = idx.find(raw); const p = M.pickByExtras(f.list, f.extras); return [p && p.id, p ? (f.list.length > 1 ? "extras" : f.how) : null]; };
  assert.deepStrictEqual(hit("mary-11-f-child.zip"), ["m", "exact"], "the sheet name equals the fake name (which itself ends in .zip)");
  assert.deepStrictEqual(hit("Mary_9_F_children"), ["m", "first"], "only one Mary in the task -> the first name is enough");
  assert.deepStrictEqual(hit("Ann Kim_40_f"), ["ak", "prefix"]);
  assert.deepStrictEqual(hit("Ann_40_f_adult"), ["ak", "extras"], "three Anns: no second name in the sheet -> the age decides");
  assert.deepStrictEqual(hit("Ann_30_f"), ["al", "extras"]);
  assert.deepStrictEqual(hit("Ann Joy_99_f"), [null, null], "a second name that matches nobody, and no age match -> never guessed");
  assert.deepStrictEqual(hit("Zed_9"), [null, null]);
  // sheet says girl/9, the talent registered boy/12 -> a soft conflict (does not stop the match)
  const f = idx.find("Mary_9_F_children");
  assert.deepStrictEqual(M.nameConflicts(f.extras, S[0]), ["gender", "age"]);
  assert.deepStrictEqual(M.nameConflicts(idx.find("Ann Kim_40_f").extras, S[2]), []);
  // closest names: same first name first
  assert.strictEqual(idx.suggest("Ann_5")[0].id === "al" || idx.suggest("Ann_5")[0].id === "a2" || idx.suggest("Ann_5")[0].id === "ak", true);
});

// -------------------------------------------------------------- sentences
const SCRIPT = [
  "0001\thi kima (hi: Tone 1)\tFast", "0002\thi kima (hi: Tone 1)\tFast", "0003\thi kima (hi: Tone 1)\tNormal",
  "0004\thi kima (hi: Tone 1)\tNormal", "0005\they kima (hey: Tone 1)\tFast", "0006\thello kima\tSlow",
].map((name, i) => ({ order_index: i, sentence_name: name }));
test("sentences: the file number + speed + text must agree (script lines look like 'id<TAB>text<TAB>Speed')", () => {
  const sc = M.buildScriptIndex(SCRIPT);
  const hit = (file, text) => M.matchSentence(sc, file, text);
  assert.deepStrictEqual([hit("BH252_UK_F088_fast_002.wav", "hi kima (hi: Tone 1)").line.idx, hit("BH252_UK_F088_fast_002.wav", "hi kima (hi: Tone 1)").how], [1, "file+text"]);
  assert.strictEqual(hit("X_normal_004.wav", "hi kima (hi: Tone 1)").line.idx, 3, "a repeated sentence is resolved by the file number");
  assert.strictEqual(hit("", "hello kima").line.idx, 5, "unique text needs no file");
  assert.strictEqual(hit("", "  HELLO   kima. ").line.idx, 5, "case, spacing and edge punctuation do not matter");
  assert.strictEqual(hit("X_fast_005.wav", "").how, "file");
  assert.strictEqual(hit("", "hi kima (hi: Tone 1)").error, "sentence_ambiguous", "repeated sentence + no file: refuse, never guess");
  assert.strictEqual(hit("", "something else").error, "sentence_not_found");
  assert.strictEqual(hit("", "").error, "no_sentence");
  const wrongNo = hit("X_fast_006.wav", "hey kima (hey: Tone 1)");      // number points at another sentence; text is unique -> text wins, flagged
  assert.deepStrictEqual([wrongNo.line.idx, wrongNo.how, wrongNo.note], [4, "text", "file_mismatch"]);
  assert.strictEqual(hit("X_slow_001.wav", "").error, "sentence_mismatch", "speed word disagrees with the script");
  assert.strictEqual(hit("X_fast_099.wav", "").error, "file_not_found");
});
test("sentences: a plain script (no ids) uses the file number as the line position; reasons lose the repeated sentence", () => {
  const sc = M.buildScriptIndex([{ order_index: 0, sentence_name: "alpha" }, { order_index: 1, sentence_name: "beta" }]);
  assert.strictEqual(M.matchSentence(sc, "clip_2.wav", "beta").line.idx, 1);
  assert.strictEqual(M.cleanReason("hi kima (hi: Tone 1)|baddata+wrong tune", "hi kima (hi: Tone 1)", null), "baddata+wrong tune");
  assert.strictEqual(M.cleanReason("noise | echo", "other", null), "noise | echo", "a '|' that is not the sentence is kept");
});

test("columns are found by what is inside them, whatever the titles say", () => {
  const idx = M.buildNameIndex(sessions);
  const sentenceSet = new Set(SCRIPT.map((r) => M.normSentence(M.parseScriptLine(r.sentence_name).text)));
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(["Marie Louise_8_f_children", `BH_UK_F1_fast_00${(i % 6) + 1}.wav`, "hi kima (hi: Tone 1)|baddata", "hi kima (hi: Tone 1)", "hi kima (hi: Tone 1)"]);
  for (const titles of [["submission name", "file name", "annotated text", "reference text", "original text"], ["Col1", "Col2", "Col3", "Col4", "Col5"], ["الاسم", "الملف", "ملاحظة", "نص", "الأصل"]]) {
    const grid = [titles, ...rows];
    const d = M.detectColumns({ grid, headerRow: 1, headers: titles, nameIndex: idx, sentenceSet });
    assert.deepStrictEqual([d.labelCol, d.fileCol, d.descCol, d.numbersMode, d.labelType], [0, 1, 2, "match", "smart"], titles.join());
    assert.ok([3, 4].includes(d.textCol));
  }
  const t = ["a", "b", "c", "d", "e"];
  assert.strictEqual(M.detectColumns({ grid: [t, ...rows], headerRow: 1, headers: ["x", "y", "z", "reference text", "original text"], nameIndex: idx, sentenceSet }).textCol, 4, "a tie is settled by the title: 'original' first");
  assert.strictEqual(M.detectColumns({ grid: [["p", "q"], ["zz", "yy"], ["zz", "yy"]], headerRow: 1, headers: ["p", "q"], nameIndex: idx, sentenceSet }), null);
});

// ------------------------------------------------------------------ flow (DB)
const URL_DB = process.env.TEST_DATABASE_URL;
const t = URL_DB ? test : test.skip;
let pool, b;
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
let n = 0;
async function seed() {
  await pool.query(`TRUNCATE studio_feedback_items, studio_delivery_batch_sessions, studio_delivery_batches, recording_session_samples,
    recording_sessions, recording_samples, recording_tasks, studio_talents, studio_leaders, studio_qa_reviewers, studio_head_leaders CASCADE`);
  const hl = await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Head','h@x.com','x') RETURNING id`);
  const leader = await one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('Lea','l@x.com','x','L001') RETURNING id`);
  const task = await one(`INSERT INTO recording_tasks (title,head_leader_id,quantity) VALUES ('Match Task',$1,50) RETURNING id`, [hl.id]);
  const samples = [];
  for (let i = 0; i < SCRIPT.length; i++) samples.push(await one(`INSERT INTO recording_samples (task_id,sentence_name,order_index) VALUES ($1,$2,$3) RETURNING id`, [task.id, SCRIPT[i].sentence_name, i]));
  return { hl, leader, task, samples };
}
async function addSession(fake, { gender = "female", bracket = "adult", age = 30, status = "approved" } = {}) {
  n++;
  const tal = await one(`INSERT INTO studio_talents (name,email,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`Real ${fake}`, `u${n}@m.com`]);
  const s = await one(`INSERT INTO recording_sessions (task_id,leader_id,talent_id,session_token,gender,age_bracket,age,fake_name,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [b.task.id, b.leader.id, tal.id, `tk${n}`, gender, bracket, age, fake, status]);
  for (const sm of b.samples) await pool.query(`INSERT INTO recording_session_samples (session_id,sample_id,audio_file_url,qa_status) VALUES ($1,$2,'drive:x','approved')`, [s.id, sm.id]);
  return s.id;
}
const rejected = async (sid) => (await pool.query(`SELECT s.order_index+1 AS n, ss.qa_reason FROM recording_session_samples ss JOIN recording_samples s ON s.id=ss.sample_id
   WHERE ss.session_id=$1 AND ss.qa_status='rejected' ORDER BY 1`, [sid])).rows;
const META = { numbersMode: "match" };
const R = (rows) => ({ db: pool, taskId: b.task.id, labelType: "smart", rows, startRow: 2, meta: META });
// row = [submission, annotated|reason, file, text]
const row = (label, file, text, reason = "bad") => [label, "", reason, file, text];

t("flow: setup", async () => { const { Pool } = require("pg"); pool = new Pool({ connectionString: URL_DB }); await pool.query("SELECT 1"); b = await seed(); });

t("preview: names by the name part, sentences by file number + text, nothing is written", async () => {
  const marie = await addSession("Marie Louise", { bracket: "child", age: 8 });
  await addSession("Marie");
  const r = await F.resolveRows(R([
    row("Marie Louise_8_f_children.zip", "BH_UK_F1_fast_002.wav", "hi kima (hi: Tone 1)", "hi kima (hi: Tone 1)|baddata+wrong tune"),
    row("Marie Louise_8_f_children.zip", "BH_UK_F1_normal_004.wav", "hi kima (hi: Tone 1)"),
    row("Marie Louise_8_f_children.zip", "", "hello kima"),
    row("Marie Louise_8_f_children.zip", "", "hi kima (hi: Tone 1)"),                  // repeated sentence, no file -> refused
    row("Marie Louise_8_f_children.zip", "BH_fast_099.wav", ""),                       // number not in the script
    row("Nobody_9_f", "BH_fast_001.wav", "hi kima (hi: Tone 1)"),
  ]));
  assert.deepStrictEqual(r.results.map((x) => [x.ok, x.numbers.join(), x.code || ""]), [
    [true, "2", ""], [true, "4", ""], [true, "6", ""], [false, "", "sentence_ambiguous"], [false, "", "file_not_found"], [false, "", "no_session"]]);
  assert.strictEqual(r.results[0].session.id, marie, "'Marie Louise_8_f_children' is Marie Louise, not Marie");
  assert.strictEqual(r.results[0].description, "baddata+wrong tune", "the repeated sentence is stripped from the reason");
  assert.strictEqual(r.results[0].match.how, "file+text");
  assert.ok(r.results[5].suggestions && r.people.length >= 2, "an unknown name comes with names to pick from");
  assert.deepStrictEqual(await rejected(marie), [], "preview writes nothing");
});

test("warning only when the file number and the text disagree", { skip: !URL_DB }, async () => {
  const r = await F.resolveRows(R([row("Marie Louise_8", "X_fast_006.wav", "hey kima (hey: Tone 1)")]));
  assert.strictEqual(r.results[0].match.note, "file_mismatch");
  assert.deepStrictEqual(r.warnings.map((w) => w.code), ["file_text_mismatch"]);
  assert.deepStrictEqual(r.results[0].numbers, [5]);
});

t("manual name choice: applies to every row of that name, and is checked against THIS task", async () => {
  const elena = await addSession("Elena");
  const rows = [row("252_recording_script_EN_female_19", "X_fast_001.wav", "hi kima (hi: Tone 1)"), row("252_recording_script_EN_female_19", "X_slow_006.wav", "hello kima")];
  const bad = await F.resolveRows(R(rows));
  assert.ok(bad.results.every((x) => x.code === "no_session" && x.unmatchedName));
  const key = F.normKeyOf("252_recording_script_EN_female_19");
  const good = await F.resolveRows({ ...R(rows), meta: { ...META, nameMap: { [key]: elena } } });
  assert.ok(good.results.every((x) => x.ok && x.session.id === elena && x.viaManual));
  const other = await F.resolveRows({ ...R(rows), meta: { ...META, nameMap: { [key]: "00000000-0000-4000-8000-000000000000" } } });
  assert.ok(other.results.every((x) => x.code === "manual_name_invalid"), "an id from another task is refused");
});

t("apply: only the named sentences go back, with the cleaned reason", async () => {
  const kite = await addSession("Kite", { bracket: "elderly", age: 52 });
  const r = await F.applyFeedback({ ...R([
    row("Kite_52_f_elderly.zip", "X_fast_001.wav", "hi kima (hi: Tone 1)", "hi kima (hi: Tone 1)|baddata+wrong tune"),
    row("Kite_52_f_elderly.zip", "X_slow_006.wav", "hello kima", "hello kima|baddata+cut off audio"),
  ]), confirmWarnings: false, headLeaderId: b.hl.id });
  assert.strictEqual(r.sessions, 1);
  assert.deepStrictEqual(await rejected(kite), [{ n: 1, qa_reason: "baddata+wrong tune" }, { n: 6, qa_reason: "baddata+cut off audio" }]);
  const st = await one(`SELECT status, rework_deadline FROM recording_sessions WHERE id=$1`, [kite]);
  assert.strictEqual(st.status, "rejected");
  assert.ok(st.rework_deadline);
});

t("per-person scripts: each talent is matched against their OWN script", async () => {
  const sc = await one(`INSERT INTO studio_task_scripts (task_id, position, filename) VALUES ($1, 1, 'a.txt') RETURNING id`, [b.task.id]);
  await pool.query(`INSERT INTO recording_samples (task_id,script_id,sentence_name,order_index) VALUES ($1,$2,'0001\talpha only here\tFast',0),($1,$2,'0002\tbeta only here\tFast',1)`, [b.task.id, sc.id]);
  const tal = await one(`INSERT INTO studio_talents (name,email,password_hash) VALUES ('Real Own','own@m.com','x') RETURNING id`);
  const s = await one(`INSERT INTO recording_sessions (task_id,leader_id,talent_id,session_token,gender,age_bracket,age,fake_name,status,script_id)
     VALUES ($1,$2,$3,'tkown','female','adult',30,'Own','approved',$4) RETURNING id`, [b.task.id, b.leader.id, tal.id, sc.id]);
  await pool.query(`INSERT INTO recording_session_samples (session_id,sample_id,audio_file_url,qa_status) SELECT $1,id,'drive:x','approved' FROM recording_samples WHERE script_id=$2`, [s.id, sc.id]);
  const r = await F.resolveRows(R([row("Own_30_f", "X_fast_002.wav", "beta only here"), row("Own_30_f", "", "hello kima")]));
  assert.deepStrictEqual(r.results.map((x) => [x.ok, x.numbers.join(), x.code || ""]), [[true, "2", ""], [false, "", "sentence_not_found"]]);
});

t("name panel: every sheet name with its match, problems first; the list offers THIS task's active talents only", async () => {
  await pool.query(`INSERT INTO recording_tasks (title,head_leader_id,quantity) VALUES ('Other Task',$1,5)`, [b.hl.id]);
  const other = (await pool.query(`SELECT id FROM recording_tasks WHERE title='Other Task'`)).rows[0].id;
  const tal = await one(`INSERT INTO studio_talents (name,email,password_hash) VALUES ('Real X','x@m.com','x') RETURNING id`);
  await pool.query(`INSERT INTO recording_sessions (task_id,leader_id,talent_id,session_token,gender,age_bracket,age,fake_name,status) VALUES ($1,$2,$3,'tkother','female','adult',30,'Other Task Person','approved')`, [other, b.leader.id, tal.id]);
  const mary = await addSession("mary-11-f-child.zip", { gender: "male", bracket: "child", age: 12 });
  await addSession("Gone", { status: "expired" });
  const r = await F.resolveRows(R([
    row("mary-11-f-child.zip", "X_fast_001.wav", "hi kima (hi: Tone 1)"),
    row("Mary_9_F_children", "X_fast_002.wav", "hi kima (hi: Tone 1)"),
    row("Nobody_9_f", "X_fast_001.wav", "hi kima (hi: Tone 1)"),
  ]));
  const nm = Object.fromEntries(r.names.map((x) => [x.label, x]));
  assert.strictEqual(r.names[0].label, "Nobody_9_f", "the unmatched name is listed first");
  assert.deepStrictEqual([nm["mary-11-f-child.zip"].sessionId, nm["mary-11-f-child.zip"].how, nm["mary-11-f-child.zip"].conflict], [mary, "exact", null]);
  assert.deepStrictEqual([nm["Mary_9_F_children"].sessionId, nm["Mary_9_F_children"].how], [mary, "first"]);
  assert.deepStrictEqual(nm["Mary_9_F_children"].conflict.fields, ["gender", "age"], "the sheet says girl/9, the talent is boy/12: shown, not blocked");
  assert.strictEqual(r.results[1].ok, true, "a soft conflict does not stop the row");
  assert.strictEqual(nm["Nobody_9_f"].sessionId, null);
  const names = r.people.map((p) => p.fakeName);
  assert.ok(names.includes("mary-11-f-child.zip") && !names.includes("Gone") && !names.includes("Other Task Person"),
    "the list holds this task's active talents only (not withdrawn ones, not other tasks')");
});

t("column detection on a real-shaped sheet uses the task's own names and sentences", async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("S").addRows([["submission name", "file name", "annotated text", "reference text", "original text"],
    ["Kite_52_f_elderly.zip", "X_fast_001.wav", "hi kima (hi: Tone 1)|baddata", "hi kima (hi: Tone 1)", "hi kima (hi: Tone 1)"],
    ["Kite_52_f_elderly.zip", "X_slow_006.wav", "hello kima|baddata", "hello kima", "hello kima"]]);
  const sheets = await F.parseSpreadsheet(Buffer.from(await wb.xlsx.writeBuffer()), "x.xlsx");
  const summary = F.sheetSummary(sheets[0]);
  const d = await F.detectForTask({ db: pool, taskId: b.task.id, sheet: sheets[0], summary });
  assert.deepStrictEqual([d.labelCol, d.fileCol, d.textCol, d.descCol, d.numbersMode], [0, 1, 4, 2, "match"]);
  const ex = F.extractRows(sheets[0], { headerRow: summary.headerRow, labelCol: d.labelCol, descCol: d.descCol, numbersMode: "match", fileCol: d.fileCol, textCol: d.textCol });
  assert.deepStrictEqual(ex.rows[0], ["Kite_52_f_elderly.zip", "", "hi kima (hi: Tone 1)|baddata", "X_fast_001.wav", "hi kima (hi: Tone 1)"]);
  assert.throws(() => F.extractRows(sheets[0], { headerRow: 1, labelCol: 0, numbersMode: "match" }), /اسم الملف أو عمود نص الجملة/);
});

t("flow: teardown", async () => { await pool.end(); });
