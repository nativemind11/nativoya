// UI test for studio/delivery.html. Needs:  npm i -D jsdom   (skipped if jsdom is absent)
let JSDOM;
try { ({ JSDOM } = require("jsdom")); } catch (_) { console.log("skipped: jsdom not installed"); process.exit(0); }
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const html = fs.readFileSync(path.join(__dirname, "../studio/delivery.html"), "utf8");

const NOW = "2026-01-10T10:00:00.000Z";
const mkSession = (n, extra = {}) => ({ id: "s" + n, fakeName: "Fake" + n, realName: "Real " + n, email: `p${n}@mail.com`, whatsapp: "010", ageBracket: "adult", age: 30, zipFileName: `Fake${n}.zip`, leaderCode: "L001", sampleCount: 20, reviewedAt: NOW, ...extra });
let tree = [{
  taskId: "t1", title: "Task <b>One</b>", total: 4,
  genders: {
    male: [{ params: { taskId: "t1", gender: "male", qaReviewerId: "q1", day: "2026-01-10" }, day: "2026-01-10", qaName: "QA One", qaReviewerId: "q1", firstAt: NOW, lastAt: "2026-01-10T14:30:00.000Z",
             sessions: [mkSession(1, { fakeName: '<img src=x onerror="window.__xss=1">' }), mkSession(2)] }],
    female: [{ params: { taskId: "t1", gender: "female", qaReviewerId: null, day: "2026-01-09" }, day: "2026-01-09", qaName: null, qaReviewerId: null, firstAt: NOW, lastAt: NOW,
               sessions: [mkSession(3), mkSession(4)] }],
  },
}];
const calls = { collect: [], sheet: [], batchSheet: [] };
const delivered = [];

(async () => {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "https://example.com/studio/delivery.html",
    beforeParse(w) {
      w.confirm = () => true;
      w.NMStudio = {
        requireStudioRole: () => ({ name: "Head" }), logout() {},
        apiGetPendingDelivery: async () => ({ tasks: tree }),
        apiGetDeliveredBatches: async () => ({ batches: delivered }),
        apiCollectGroup: async (p) => { calls.collect.push(p);
          tree = tree.map((t) => ({ ...t, genders: { ...t.genders, male: [] } }));
          delivered.push({ id: "b1", task_id: "t1", task_title: "Task <b>One</b>", gender: "male", group_day: "2026-01-10", status: "delivered", session_count: 2, zip_file_name: "x.zip", zip_file_url: "https://drive.google.com/file/d/BIG/view", zip_size_bytes: 3145728, delivered_at: NOW, qa_name: "QA One" });
          return { ok: true, batch: { session_count: 2, zip_file_url: "https://drive.google.com/file/d/BIG/view" } }; },
        downloadGroupSheet: async (p, name) => { calls.sheet.push([p, name]); },
        downloadBatchSheet: async (id, name) => { calls.batchSheet.push([id, name]); },
      };
    },
  });
  const d = dom.window.document;
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  await wait();

  // structure
  assert.strictEqual(d.querySelectorAll(".dl-group").length, 2, "male group + female group");
  assert.ok(d.body.textContent.includes("👨 ذكور") && d.body.textContent.includes("👩 إناث"));
  assert.ok(d.body.textContent.includes("QA One") && d.body.textContent.includes("غير معروف"));
  assert.strictEqual(d.querySelectorAll('button[data-act="collect"]').length, 2);
  assert.strictEqual(d.querySelectorAll('button[data-act="sheet"]').length, 2);
  assert.strictEqual(d.getElementById("count-pending").textContent, "(4)");
  assert.ok(d.body.textContent.includes("p1@mail.com") && d.body.textContent.includes("Real 1"), "email + real name shown");
  // XSS: names are text, never markup
  assert.strictEqual(d.querySelectorAll("img").length, 0, "no injected <img>");
  assert.strictEqual(dom.window.__xss, undefined);
  assert.strictEqual(d.querySelector(".dl-task h3").innerHTML, "Task &lt;b&gt;One&lt;/b&gt;");
  console.log("ok render: tasks > gender > groups, buttons, email/real/fake names, XSS-safe");

  // sheet button
  d.querySelector('button[data-act="sheet"]').click();
  await wait();
  assert.deepStrictEqual(calls.sheet[0][0], { taskId: "t1", gender: "male", qaReviewerId: "q1", day: "2026-01-10" });
  assert.strictEqual(calls.sheet[0][1], "Sheet - Task -b-One--b- - Male - QA One - 2026-01-10.xlsx");
  console.log("ok sheet button sends the right group + file name");

  // collect button -> group disappears, appears in "delivered"
  d.querySelector('button[data-act="collect"]').click();
  await wait(120);
  assert.deepStrictEqual(calls.collect[0], { taskId: "t1", gender: "male", qaReviewerId: "q1", day: "2026-01-10" });
  assert.strictEqual(d.querySelectorAll(".dl-group").length, 1, "collected group left the waiting list");
  assert.ok(!d.querySelector("#pending-wrap").textContent.includes("QA One"));
  assert.strictEqual(d.getElementById("count-delivered").textContent, "(1)");
  const del = d.getElementById("delivered-wrap");
  assert.ok(del.textContent.includes("Task <b>One</b>") && del.textContent.includes("QA One") && del.textContent.includes("3.0 MB"));
  assert.ok(del.querySelector('a[href="https://drive.google.com/file/d/BIG/view"]'));
  assert.ok(d.getElementById("toast").textContent.includes("اتجمّع 2 تاسك"));
  console.log("ok collect: calls API, hides group, shows it under delivered with ZIP link");

  // delivered sheet
  del.querySelector("button[data-batch]").click();
  await wait();
  assert.strictEqual(calls.batchSheet[0][0], "b1");
  console.log("ok delivered archive sheet button");

  // tabs
  d.getElementById("tab-delivered").click();
  assert.ok(d.getElementById("pending-wrap").classList.contains("hidden") && !del.classList.contains("hidden"));
  console.log("ok tabs");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
