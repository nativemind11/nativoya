// UI tests for the Phase 7 pages, run in a simulated browser with the API stubbed.
//   npm i -D jsdom     (skipped automatically if jsdom is absent)
let JSDOM;
try { ({ JSDOM } = require("jsdom")); } catch (_) { console.log("skipped: jsdom not installed"); process.exit(0); }
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const page = (name) => fs.readFileSync(path.join(__dirname, "../studio", name), "utf8");
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const timeLeft = (iso) => {                       // same contract as the real helper
  const ms = new Date(iso).getTime() - Date.now();
  return ms >= 0 ? { text: "باقي 11 ساعة", overdue: false } : { text: "المهلة خلصت من ساعة", overdue: true };
};
const FUTURE = new Date(Date.now() + 11 * 3600000).toISOString();
const PAST = new Date(Date.now() - 3600000).toISOString();

async function feedbackPage() {
  const calls = { parse: [], preview: [], apply: [] };
  let items = [];
  const sheet = {
    name: "Report", rowCount: 4, colCount: 3, headerRow: 2,
    columns: [{ index: 0, letter: "A", header: "Audio file" }, { index: 1, letter: "B", header: "Clip no." }, { index: 2, letter: "C", header: "Problem" }],
    preview: [["Company report", "", ""], ["Audio file", "Clip no.", "Problem"], ["Eagle-male-adult-30.zip", "2, 4", "echo"], ["Nobody-male-adult-30.zip", "9", "x"]],
    guess: { labelCol: 0, labelType: "zip", numbersCol: 1, descCol: 2 },
  };
  const previewResult = {
    task: { id: "t1", title: "Task One" }, sampleCount: 5,
    summary: { total: 2, ok: 1, errors: 1, sessions: 1 },
    results: [
      { row: 3, label: "Eagle-male-adult-30.zip", numbers: [2, 4], description: '<img src=x onerror="window.__xss=1">', ok: true,
        session: { id: "s1", fakeName: "Eagle", realName: "Real Eagle", email: "eagle@mail.com", leaderCode: "L001" } },
      { row: 4, label: "Nobody-male-adult-30.zip", numbers: [], description: "x", ok: false, code: "no_session", message: "مفيش متسجّل بالاسم ده في المهمة دي." },
    ],
  };
  const dom = new JSDOM(page("feedback.html"), {
    runScripts: "dangerously", url: "https://example.com/studio/feedback.html",
    beforeParse(w) {
      w.confirm = () => true;
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.NMStudio = {
        requireStudioRole: () => ({ name: "Head" }), logout() {}, timeLeft,
        apiGetMyTasks: async () => [{ id: "t1", title: "Task <b>One</b>" }],
        apiFeedbackParse: async (f) => { calls.parse.push(f.name); return { sheets: [sheet] }; },
        apiFeedbackPreview: async (f, m) => { calls.preview.push(m); return previewResult; },
        apiFeedbackApply: async (f, m) => { calls.apply.push(m);
          items = [{ id: "i1", task_id: "t1", task_title: "Task One", fake_name: "Eagle", real_name: "Real Eagle", email: "eagle@mail.com", leader_code: "L001",
                     recording_numbers: [2, 4], issue_description: "echo", status: "pending", overdue: false, rework_deadline: FUTURE, created_at: new Date().toISOString() },
                   { id: "i2", task_id: "t1", task_title: "Task One", fake_name: "Falcon", real_name: "Real Falcon", email: "f@mail.com", leader_code: "L001",
                     recording_numbers: [1], issue_description: "", status: "pending", overdue: true, rework_deadline: PAST, created_at: new Date().toISOString() },
                   { id: "i4", task_id: "t1", task_title: "Task One", fake_name: "Kite", real_name: "Real Kite", email: "k@mail.com", leader_code: "L001",
                     recording_numbers: [2], issue_description: "", status: "expired", overdue: false, rework_deadline: PAST, created_at: new Date().toISOString() },
                   { id: "i3", task_id: "t1", task_title: "Task One", fake_name: "Owl", real_name: "Real Owl", email: "o@mail.com", leader_code: "L001",
                     recording_numbers: [3], issue_description: "", status: "reworked", overdue: false, rework_deadline: PAST, reworked_at: new Date().toISOString(), created_at: new Date().toISOString() }];
          return { ok: true, sessions: 1, samples: 2, items: 1, skipped: [{ row: 4 }], reworkHours: 12 }; },
        apiFeedbackItems: async () => ({ items }),
      };
    },
  });
  await wait();
  return { dom, d: dom.window.document, calls };
}

(async () => {
  // ------------------------------------------------------------ feedback.html
  const { dom, d, calls } = await feedbackPage();
  assert.ok(d.getElementById("task-select").innerHTML.includes("Task &lt;b&gt;One&lt;/b&gt;"), "task titles are escaped");
  assert.ok(d.getElementById("step-map").classList.contains("hidden") && d.getElementById("step-preview").classList.contains("hidden"));
  assert.ok(d.getElementById("items-wrap").textContent.includes("لسه مفيش فيدباك"));

  // clicking "read file" without a task / file shows a clear message and calls nothing
  d.getElementById("parse-btn").click(); await wait();
  assert.ok(d.getElementById("upload-error").textContent.includes("اختار المهمة"));
  assert.strictEqual(calls.parse.length, 0);

  d.getElementById("task-select").value = "t1";
  Object.defineProperty(d.getElementById("file-input"), "files", { value: [new dom.window.File(["x"], "company.xlsx")] });
  d.getElementById("parse-btn").click(); await wait();
  assert.deepStrictEqual(calls.parse, ["company.xlsx"]);
  assert.ok(!d.getElementById("step-map").classList.contains("hidden"));
  assert.ok(d.getElementById("sheet-field").classList.contains("hidden"), "one sheet -> no sheet picker");
  assert.strictEqual(d.getElementById("header-row").value, "2");
  assert.strictEqual(d.getElementById("label-col").value, "0");
  assert.strictEqual(d.getElementById("numbers-col").value, "1");
  assert.strictEqual(d.getElementById("desc-col").value, "2");
  assert.strictEqual(d.querySelector('input[name="label-type"]:checked').value, "zip", "detected a zip-name column");
  assert.ok(d.querySelector("#raw-table .col-label") && d.querySelector("#raw-table .col-numbers") && d.querySelector("#raw-table .col-desc"), "chosen columns are highlighted");
  assert.ok(d.getElementById("raw-table").textContent.includes("Eagle-male-adult-30.zip"));
  console.log("ok upload + auto-detected column mapping");

  d.getElementById("preview-btn").click(); await wait();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.preview[0])), { taskId: "t1", sheetIndex: "0", headerRow: "2", labelCol: "0", numbersCol: "1", descCol: "2", labelType: "zip" });
  assert.ok(!d.getElementById("step-preview").classList.contains("hidden"));
  assert.ok(d.getElementById("summary").textContent.includes("1 صف صالح") && d.getElementById("summary").textContent.includes("1 فيهم مشكلة"));
  assert.strictEqual(d.querySelectorAll("#result-table .fb-row-bad").length, 1);
  assert.ok(d.getElementById("result-table").textContent.includes("eagle@mail.com") && d.getElementById("result-table").textContent.includes("Real Eagle"));
  assert.strictEqual(d.querySelectorAll("#result-table .fb-chip").length, 2, "recording numbers shown as chips");
  assert.strictEqual(d.querySelectorAll("#result-table img").length, 0, "description is text, never markup");
  assert.strictEqual(dom.window.__xss, undefined);
  assert.strictEqual(d.getElementById("apply-btn").disabled, false);
  console.log("ok preview: matches, bad row flagged, XSS-safe");

  d.getElementById("apply-btn").click(); await wait(120);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.apply[0])), JSON.parse(JSON.stringify(calls.preview[0])), "apply uses exactly the previewed mapping");
  assert.ok(d.getElementById("toast").textContent.includes("اتسجّل فيدباك على 1 متسجّل"));
  assert.ok(d.getElementById("step-map").classList.contains("hidden") && d.getElementById("step-preview").classList.contains("hidden"));
  const rows = d.querySelectorAll("#items-wrap tbody tr");
  assert.strictEqual(rows.length, 4);
  assert.ok(rows[2].textContent.includes("اتسحب الاسم") && rows[2].textContent.includes("الاسم اتسحب") && !rows[2].querySelector(".fb-late"), "withdrawn is not shown as late");
  assert.ok(rows[0].textContent.includes("مستني المتسجّل") && rows[0].textContent.includes("باقي 11 ساعة"));
  assert.ok(rows[1].textContent.includes("متأخر") && rows[1].querySelector(".fb-late"), "overdue is flagged red");
  assert.ok(rows[3].textContent.includes("اتعادت"));
  console.log("ok apply: toast, steps reset, tracking list with pending / overdue / reworked");

  // a preview with zero valid rows can't be applied
  const p2 = await feedbackPage();
  p2.d.getElementById("task-select").value = "t1";
  Object.defineProperty(p2.d.getElementById("file-input"), "files", { value: [new p2.dom.window.File(["x"], "c.xlsx")] });
  p2.d.getElementById("parse-btn").click(); await wait();
  p2.dom.window.NMStudio.apiFeedbackPreview = async () => ({ task: { title: "T" }, sampleCount: 5, summary: { total: 1, ok: 0, errors: 1, sessions: 0 }, results: [{ row: 3, label: "x", numbers: [], ok: false, message: "bad" }] });
  p2.d.getElementById("preview-btn").click(); await wait();
  assert.strictEqual(p2.d.getElementById("apply-btn").disabled, true);
  console.log("ok apply is disabled when no row is valid");

  // --------------------------------------------------------- talent dashboard
  const talentItems = [
    { task_title: "Task <b>One</b>", recording_numbers: [2, 4], issue_description: "echo", status: "pending", rework_deadline: FUTURE, session_status: "rejected", session_token: "tok 1" },
    { task_title: "Done task", recording_numbers: [1], issue_description: "", status: "reworked", rework_deadline: PAST, session_status: "submitted", session_token: "tok2" },
    { task_title: "Gone task", recording_numbers: [3], issue_description: "", status: "expired", rework_deadline: PAST, session_status: "expired", session_token: "tok3" },
  ];
  const talentSessions = [{ task_title: "Gone task", leader_code: "L001", fake_name: "Eagle", recorded_count: 3, sample_count: 3, status: "expired", session_token: "tok3", rejection_reason: null }];
  const td = new JSDOM(page("talent-dashboard.html"), {
    runScripts: "dangerously", url: "https://example.com/studio/talent-dashboard.html",
    beforeParse(w) {
      w.NMTalent = { requireLogin: () => ({ name: "Sara" }), logout() {}, timeLeft,
        getMySessions: async () => talentSessions, getMyFeedback: async () => ({ items: talentItems }) };
    },
  });
  await wait();
  const tw = td.window.document.getElementById("feedback-wrap");
  assert.ok(!tw.classList.contains("hidden"));
  assert.ok(tw.textContent.includes("2") && tw.textContent.includes("4") && tw.textContent.includes("echo") && tw.textContent.includes("باقي 11 ساعة"));
  assert.ok(!tw.textContent.includes("Done task"), "reworked items are not shown as to-do");
  assert.strictEqual(tw.querySelector("a").getAttribute("href"), "recording.html?session=tok%201", "link goes to the rework screen (token encoded)");
  assert.ok(tw.innerHTML.includes("Task &lt;b&gt;One&lt;/b&gt;"));
  assert.ok(tw.textContent.includes("الاسم بيتسحب منك"), "warns up front that the name is withdrawn if the deadline is missed");
  assert.ok(tw.textContent.includes("Gone task") && tw.textContent.includes("اتسحب منك الاسم"), "a withdrawn one is explained");
  assert.strictEqual(tw.querySelectorAll("a").length, 1, "no rework link for the withdrawn one");
  const sw = td.window.document.getElementById("sessions-wrap");
  assert.ok(sw.textContent.includes("انتهت مهلة الإعادة") && sw.querySelector(".status-rejected"), "sessions table shows the withdrawal");
  assert.strictEqual(sw.querySelectorAll("a").length, 0, "no continue / redo button on a withdrawn session");
  console.log("ok talent dashboard: shows only open feedback with recordings, deadline, warning, and explains a withdrawn name");

  const td2 = new JSDOM(page("talent-dashboard.html"), {
    runScripts: "dangerously", url: "https://example.com/studio/talent-dashboard.html",
    beforeParse(w) { w.NMTalent = { requireLogin: () => ({ name: "Sara" }), logout() {}, timeLeft, getMySessions: async () => [], getMyFeedback: async () => { throw new Error("boom"); } }; },
  });
  await wait();
  assert.ok(td2.window.document.getElementById("feedback-wrap").classList.contains("hidden"), "a feedback error never breaks the dashboard");
  console.log("ok talent dashboard survives a feedback API error");

  // ---------------------------------------------------------- leader dashboard
  const ld = new JSDOM(page("dashboard-leader.html"), {
    runScripts: "dangerously", url: "https://example.com/studio/dashboard-leader.html",
    beforeParse(w) {
      w.NMStudio = { requireStudioRole: () => ({ name: "Lea", leader_code: "L001" }), logout() {}, timeLeft,
        apiMyFeedback: async () => ({ items: [
          { fake_name: "Eagle", real_name: "Real <i>Eagle</i>", email: "eagle@mail.com", task_title: "Task One", recording_numbers: [2], issue_description: "echo", status: "pending", overdue: true, rework_deadline: PAST },
          { fake_name: "Owl", real_name: "Real Owl", email: "o@mail.com", task_title: "Task One", recording_numbers: [1], issue_description: "", status: "reworked", overdue: false, rework_deadline: PAST },
          { fake_name: "Kite", real_name: "Real Kite", email: "k@mail.com", task_title: "Task One", recording_numbers: [2], issue_description: "", status: "expired", overdue: false, rework_deadline: PAST } ] }) };
    },
  });
  await wait();
  const lw = ld.window.document.getElementById("feedback-wrap");
  assert.strictEqual(lw.querySelectorAll("tbody tr").length, 3);
  assert.ok(lw.textContent.includes("eagle@mail.com") && lw.textContent.includes("متأخر") && lw.textContent.includes("اتعادت"));
  const kite = [...lw.querySelectorAll("tbody tr")].find((r) => r.textContent.includes("Kite"));
  assert.ok(kite.textContent.includes("اتسحب الاسم") && !kite.textContent.includes("المهلة خلصت"), "withdrawn: own label, no countdown");
  assert.ok(lw.innerHTML.includes("Real &lt;i&gt;Eagle&lt;/i&gt;"));
  console.log("ok leader dashboard: team feedback with real names, overdue / reworked, escaped");
  // ------------------------------------------------------------ recording page
  const rp = new JSDOM(page("recording.html"), {
    runScripts: "dangerously", url: "https://example.com/studio/recording.html?session=tok1",
    beforeParse(w) {
      w.NMTalent = { requireLogin() {}, timeLeft,
        getSession: async () => ({
          session: { status: "rejected", fake_name: "Eagle", rejection_reason: "فيدباك من الشركة — تسجيل 2: echo", rework_deadline: FUTURE, recording_settings: { sampleRate: 16000, bitDepth: 16, format: "wav", channels: "mono" } },
          samples: [{ id: "a", order_index: 0, sentence_name: "S1", qa_status: "approved", audio_file_url: "x" }, { id: "b", order_index: 1, sentence_name: "S2", qa_status: "rejected", audio_file_url: "x" }] }) };
      w.StudioRecorder = { isSupported: () => true };
      w.StudioQueue = { pendingFor: async () => [] };
      w.WavEngine = {}; w.WaveformVisualizer = function () {};
    },
  });
  await wait(100);
  const rd = rp.window.document;
  assert.ok(!rd.getElementById("rework-banner").classList.contains("hidden"));
  assert.ok(rd.getElementById("rework-reason-text").textContent.includes("فيدباك من الشركة"));
  assert.ok(rd.getElementById("rework-deadline-text").textContent.includes("باقي 11 ساعة"), "countdown is shown");
  assert.strictEqual(rd.getElementById("sample-number").textContent, "جملة 1 من 1", "only the recording to redo is offered");
  assert.strictEqual(rd.getElementById("sentence-text").textContent, "S2");
  assert.ok(rd.getElementById("rework-deadline-text").textContent.includes("الاسم بيتسحب منك"), "warns before the deadline");
  console.log("ok recording page: rework banner with the 12h countdown + withdrawal warning, only the requested recording");

  const ep = new JSDOM(page("recording.html"), {
    runScripts: "dangerously", url: "https://example.com/studio/recording.html?session=tok9",
    beforeParse(w) {
      w.NMTalent = { requireLogin() {}, timeLeft, getSession: async () => ({ session: { status: "expired", fake_name: "Eagle", recording_settings: {} }, samples: [{ id: "a", order_index: 0, sentence_name: "S1" }] }) };
      w.StudioRecorder = { isSupported: () => true }; w.StudioQueue = { pendingFor: async () => [] }; w.WavEngine = {}; w.WaveformVisualizer = function () {};
    },
  });
  await wait(100);
  const ed = ep.window.document;
  assert.ok(!ed.getElementById("expired-box").classList.contains("hidden"));
  assert.ok(ed.getElementById("recorder-box").classList.contains("hidden"), "the recorder is not offered");
  assert.ok(ed.getElementById("done-box").classList.contains("hidden"), "and it is not mistaken for a successful delivery");
  console.log("ok recording page: a withdrawn session shows the explanation, no recorder");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
