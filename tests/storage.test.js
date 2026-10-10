// Storage management (config/studioStorage.js + the 3 delivery endpoints).
// Part 1 needs nothing. Part 2 needs TEST_DATABASE_URL (skipped otherwise) and
// the migrations up to migration_studio_storage.sql.
const test = require("node:test");
const assert = require("node:assert");
const URL_DB = process.env.TEST_DATABASE_URL;
if (URL_DB) { process.env.DATABASE_URL = URL_DB; process.env.JWT_SECRET = "test-secret"; }   // before db/pool loads
const S = require("../config/studioStorage.js");
const tdb = URL_DB ? test : test.skip;

// ------------------------------------------------------------------ fakes
function fakeDrive({ pct = 0.9, failOn = null } = {}) {
  const d = { deleted: [], pct, step: 0.05 };
  d.about = { get: async () => ({ data: { storageQuota: { limit: "1000", usage: String(Math.round(1000 * d.pct)) } } }) };
  d.files = {
    delete: async ({ fileId }) => {
      if (failOn && fileId === failOn) { const e = new Error("boom"); e.code = 500; throw e; }
      if (fileId.startsWith("GONE")) { const e = new Error("nf"); e.code = 404; throw e; }
      d.deleted.push(fileId); d.pct = Math.max(0, d.pct - d.step);
    },
  };
  return d;
}
function fakeRepo({ sessions = [], batches = [], claim = () => true } = {}) {
  const r = { claimed: [], unclaimed: [], batchClaimed: [], sessions: [...sessions], batches: [...batches] };
  r.listEligibleSessions = async () => r.sessions.filter((s) => !r.claimed.includes(s.id)).slice(0, 20);
  r.claimSession = async (id) => { if (!claim(id)) { r.sessions = r.sessions.filter((s) => s.id !== id); return false; } r.claimed.push(id); return true; };
  r.unclaimSession = async (id) => { r.unclaimed.push(id); r.claimed = r.claimed.filter((x) => x !== id); };
  r.clipRefs = async (id) => [`drive:${id}-clip1`, `drive:${id}-clip2`];
  r.listEligibleBatches = async () => r.batches.filter((b) => !r.batchClaimed.includes(b.id));
  r.claimBatch = async (id) => { r.batchClaimed.push(id); return true; };
  r.unclaimBatch = async (id) => { r.batchClaimed = r.batchClaimed.filter((x) => x !== id); };
  return r;
}
const sess = (id) => ({ id, zip_file_url: `https://drive.google.com/file/d/${id}-zip/view`, audio_purged_at: null });

// ------------------------------------------------------------------ part 1
test("fileIdFromRef understands clip refs and Drive URLs", () => {
  assert.strictEqual(S.fileIdFromRef("drive:ABC123"), "ABC123");
  assert.strictEqual(S.fileIdFromRef("https://drive.google.com/file/d/XYZ_9-q/view?usp=sharing"), "XYZ_9-q");
  assert.strictEqual(S.fileIdFromRef(null), null);
  assert.strictEqual(S.fileIdFromRef("drive:"), null);
});

test("deleteDriveFile: already-gone (404) is success, any other error is thrown", async () => {
  const d = fakeDrive({ failOn: "BAD" });
  assert.strictEqual(await S.deleteDriveFile(d, "drive:GONE1"), false);
  assert.strictEqual(await S.deleteDriveFile(d, "drive:OK1"), true);
  await assert.rejects(() => S.deleteDriveFile(d, "drive:BAD"));
  assert.strictEqual(await S.deleteQuietly(d, "drive:BAD"), false);      // quiet never throws
});

test("auto mode does nothing while Drive is under 80 %", async () => {
  const d = fakeDrive({ pct: 0.5 }); const repo = fakeRepo({ sessions: [sess("a")] });
  const out = await S.runPurge({ repo, drive: d, mode: "auto" });
  assert.strictEqual(out.sessions, 0); assert.deepStrictEqual(d.deleted, []);
});

test("auto mode cleans oldest first and stops once Drive is back under 60 %", async () => {
  const d = fakeDrive({ pct: 0.85 }); d.step = 0.06;                       // each deleted file frees 6 %
  const repo = fakeRepo({ sessions: ["s1", "s2", "s3", "s4", "s5", "s6"].map(sess) });
  const out = await S.runPurge({ repo, drive: d, mode: "auto" });
  assert.ok(out.sessions >= 1 && out.sessions < 6, "stopped before cleaning everything");
  assert.ok(out.after.pct < S.TARGET + 0.001);
  assert.strictEqual(repo.claimed[0], "s1");
});

test("manual mode purges every eligible session: clips AND the session ZIP", async () => {
  const d = fakeDrive({ pct: 0.3 }); d.step = 0;
  const repo = fakeRepo({ sessions: [sess("a"), sess("b")] });
  const out = await S.runPurge({ repo, drive: d, mode: "manual" });
  assert.strictEqual(out.sessions, 2);
  assert.deepStrictEqual(d.deleted.sort(), ["a-clip1", "a-clip2", "a-zip", "b-clip1", "b-clip2", "b-zip"]);
  assert.strictEqual(out.batches, 0, "big ZIPs are untouched while Drive has room");
});

test("a session that changed meanwhile (claim refused) is skipped and NOTHING of it is deleted", async () => {
  const d = fakeDrive({ pct: 0.3 }); d.step = 0;
  const repo = fakeRepo({ sessions: [sess("a"), sess("b")], claim: (id) => id !== "a" });
  const out = await S.runPurge({ repo, drive: d, mode: "manual" });
  assert.strictEqual(out.sessions, 1);
  assert.ok(!d.deleted.some((x) => x.startsWith("a-")));
});

test("a failed delete rolls the claim back and reports the error", async () => {
  const d = fakeDrive({ pct: 0.3, failOn: "a-clip2" }); d.step = 0;
  const repo = fakeRepo({ sessions: [sess("a")] });
  const out = await S.runPurge({ repo, drive: d, mode: "manual" });
  assert.strictEqual(out.sessions, 0);
  assert.deepStrictEqual(repo.unclaimed, ["a"]);
  assert.ok(out.error);
});

test("stage 2 (big delivery ZIPs) only runs while Drive is still above 80 %", async () => {
  let d = fakeDrive({ pct: 0.9 }); d.step = 0.04;
  let repo = fakeRepo({ batches: [{ id: "B1", zip_file_url: "https://drive.google.com/file/d/BIG1/view" }, { id: "B2", zip_file_url: "https://drive.google.com/file/d/BIG2/view" }, { id: "B3", zip_file_url: "https://drive.google.com/file/d/BIG3/view" }] });
  let out = await S.runPurge({ repo, drive: d, mode: "manual" });
  assert.ok(out.batches >= 1 && out.batches <= 3);
  assert.ok(out.after.pct < 0.8 + 0.001 || out.batches === 3);
  assert.strictEqual(d.deleted[0], "BIG1", "oldest first");

  d = fakeDrive({ pct: 0.5 });
  repo = fakeRepo({ batches: [{ id: "B1", zip_file_url: "https://drive.google.com/file/d/BIG1/view" }] });
  out = await S.runPurge({ repo, drive: d, mode: "manual" });
  assert.strictEqual(out.batches, 0);
});

test("the time budget stops a long clean-up cleanly (stoppedEarly), leaving the rest for next time", async () => {
  const d = fakeDrive({ pct: 0.3 }); d.step = 0;
  const repo = fakeRepo({ sessions: ["a", "b", "c"].map(sess) });
  let t = 0; const now = () => (t += 600);
  const out = await S.runPurge({ repo, drive: d, mode: "manual", budgetMs: 1500, now });
  assert.ok(out.stoppedEarly);
  assert.ok(out.sessions < 3);
});

// ------------------------------------------------------------------ part 2 (real Postgres)
let pool, server, base, jwt, ids = {};
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

tdb("db: boot + seed", async () => {
  process.env.DATABASE_URL = URL_DB; process.env.JWT_SECRET = "test-secret";
  const express = require("express"); jwt = require("jsonwebtoken");
  ({ pool } = require("../db/pool"));
  S.driveClient = async () => (ids.drive = ids.drive || fakeDrive({ pct: 0.9 }));
  const app = express(); app.use(express.json());
  app.use("/api/studio/delivery", require("../routes/studio/delivery"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/studio/delivery`;

  await pool.query(`TRUNCATE studio_delivery_batches, recording_session_samples, recording_sessions, recording_samples,
    recording_tasks, studio_talents, studio_leaders, studio_qa_reviewers, studio_head_leaders CASCADE`);
  const hl = await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Head','h@x.com','x') RETURNING id`);
  const leader = await one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('Lea','l@x.com','x','L001') RETURNING id`);
  const qa = await one(`INSERT INTO studio_qa_reviewers (name,email,password_hash) VALUES ('QA','q@x.com','x') RETURNING id`);
  const task = await one(`INSERT INTO recording_tasks (title,head_leader_id,quantity) VALUES ('T',$1,10) RETURNING id`, [hl.id]);
  const samples = [];
  for (let i = 0; i < 3; i++) samples.push((await one(`INSERT INTO recording_samples (task_id,order_index,sentence_name) VALUES ($1,$2,$3) RETURNING id`, [task.id, i, `s${i}`])).id);
  ids = { ...ids, hl: hl.id, leader: leader.id, qa: qa.id, task: task.id, samples, token: jwt.sign({ id: hl.id, studioRole: "head_leader" }, "test-secret") };
});

async function makeDeliveredSession(n, { downloaded }) {
  const tal = await one(`INSERT INTO studio_talents (name,email,password_hash) VALUES ($1,$2,'x') RETURNING id`, [`P${n}`, `p${n}@m.com`]);
  const batch = await one(
    `INSERT INTO studio_delivery_batches (task_id,gender,qa_reviewer_id,group_day,status,session_count,zip_file_name,zip_file_url,delivered_at,downloaded_at)
     VALUES ($1,'male',$2,'2026-01-10','delivered',1,'big.zip',$3,now(),$4) RETURNING id`,
    [ids.task, ids.qa, `https://drive.google.com/file/d/BIG${n}/view`, downloaded ? new Date() : null]);
  const s = await one(
    `INSERT INTO recording_sessions (task_id,leader_id,talent_id,session_token,gender,age_bracket,age,fake_name,status,zip_file_url,zip_file_name,qa_reviewer_id,qa_reviewed_at,delivery_batch_id)
     VALUES ($1,$2,$3,$4,'male','adult',30,$5,'approved',$6,$7,$8,now(),$9) RETURNING id`,
    [ids.task, ids.leader, tal.id, `stok${n}`, `Fake${n}`, `https://drive.google.com/file/d/ZIP${n}/view`, `Fake${n}-male-adult-30.zip`, ids.qa, batch.id]);
  for (let i = 0; i < 3; i++) {
    await pool.query(`INSERT INTO recording_session_samples (session_id,sample_id,audio_file_url,duration,completed_at,qa_status)
      VALUES ($1,$2,$3,2,now() - interval '1 day','approved')`, [s.id, ids.samples[i], `drive:CLIP${n}_${i}`]);
  }
  return { session: s.id, batch: batch.id };
}

tdb("db: nothing is eligible until the head leader confirms the download", async () => {
  const a = await makeDeliveredSession(1, { downloaded: false });
  const repo = S.makeRepo(pool);
  assert.strictEqual(await repo.countEligible(), 0);
  assert.strictEqual(await repo.countAwaitingDownload(), 1);
  const d = fakeDrive({ pct: 0.95 });
  const out = await S.runPurge({ repo, drive: d, mode: "manual" });
  assert.strictEqual(out.sessions + out.batches, 0);
  assert.deepStrictEqual(d.deleted, []);
  ids.a = a;
});

tdb("db: endpoint marks it downloaded (head leader only), undo works, a missing batch is 404", async () => {
  const call = (p, o = {}) => fetch(base + p, { method: o.method || "GET", headers: { Authorization: `Bearer ${o.tok === undefined ? ids.token : o.tok}`, "Content-Type": "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined });
  const qaTok = jwt.sign({ id: ids.qa, studioRole: "qa" }, "test-secret");
  assert.strictEqual((await call(`/batches/${ids.a.batch}/downloaded`, { method: "POST", tok: qaTok })).status, 403);
  assert.strictEqual((await call(`/batches/not-a-uuid/downloaded`, { method: "POST" })).status, 400);
  assert.strictEqual((await call(`/batches/${ids.a.batch}/downloaded`, { method: "POST", body: {} })).status, 200);
  assert.ok((await one(`SELECT downloaded_at FROM studio_delivery_batches WHERE id=$1`, [ids.a.batch])).downloaded_at);
  assert.strictEqual((await call(`/batches/${ids.a.batch}/downloaded`, { method: "POST", body: { downloaded: false } })).status, 200);
  assert.strictEqual((await one(`SELECT downloaded_at FROM studio_delivery_batches WHERE id=$1`, [ids.a.batch])).downloaded_at, null);
  assert.strictEqual((await call(`/batches/00000000-0000-4000-8000-000000000000/downloaded`, { method: "POST", body: {} })).status, 404);
  await call(`/batches/${ids.a.batch}/downloaded`, { method: "POST", body: {} });        // confirm again for the next tests
});

tdb("db: purge deletes the clips + session ZIP, keeps every row, and records the high-water mark", async () => {
  const d = fakeDrive({ pct: 0.5 }); d.step = 0;
  const out = await S.runPurge({ repo: S.makeRepo(pool), drive: d, mode: "manual" });
  assert.strictEqual(out.sessions, 1);
  assert.deepStrictEqual(d.deleted.sort(), ["CLIP1_0", "CLIP1_1", "CLIP1_2", "ZIP1"]);
  const row = await one(`SELECT files_on_drive, audio_purged_at, status FROM recording_sessions WHERE id=$1`, [ids.a.session]);
  assert.strictEqual(row.files_on_drive, false); assert.ok(row.audio_purged_at); assert.strictEqual(row.status, "approved");
  assert.strictEqual((await pool.query(`SELECT 1 FROM recording_session_samples WHERE session_id=$1`, [ids.a.session])).rowCount, 3, "sample rows survive");
  const again = await S.runPurge({ repo: S.makeRepo(pool), drive: d, mode: "manual" });
  assert.strictEqual(again.sessions, 0, "idempotent");
});

tdb("db: a session that went back for rework (feedback) can't be claimed — its clips are safe", async () => {
  const b = await makeDeliveredSession(2, { downloaded: true });
  await pool.query(`UPDATE recording_sessions SET status='rejected', delivery_batch_id=NULL WHERE id=$1`, [b.session]);
  const repo = S.makeRepo(pool);
  assert.strictEqual(await repo.claimSession(b.session, null), false);
  const d = fakeDrive({ pct: 0.95 });
  await S.runPurge({ repo, drive: d, mode: "manual" });
  assert.ok(!d.deleted.some((x) => x.startsWith("CLIP2")), "clips of a session in rework are never deleted");
});

tdb("db: after a purge only clips recorded later count (partial re-submission), and a 2nd purge deletes just those", async () => {
  const repo = S.makeRepo(pool);
  const { session } = ids.a;
  // feedback: recording 2 goes back; the talent re-records it today
  await pool.query(`UPDATE recording_sessions SET status='rejected' WHERE id=$1`, [session]);
  await pool.query(`UPDATE recording_session_samples SET audio_file_url='drive:NEWCLIP', completed_at=now(), qa_status='pending'
    WHERE session_id=$1 AND sample_id=$2`, [session, ids.samples[1]]);
  const purgedAt = (await one(`SELECT audio_purged_at::text AS t FROM recording_sessions WHERE id=$1`, [session])).t;
  const present = await pool.query(
    `SELECT s.order_index FROM recording_session_samples ss JOIN recording_samples s ON s.id=ss.sample_id
     WHERE ss.session_id=$1 AND ss.completed_at > $2::timestamptz ORDER BY 1`, [session, purgedAt]);
  assert.deepStrictEqual(present.rows.map((r) => r.order_index), [1], "the partial ZIP would hold only recording 2");
  // re-submitted + approved + delivered again (what talent.js /submit does to the flags)
  await pool.query(`UPDATE recording_sessions SET status='approved', files_on_drive=true, zip_partial_count=1,
    zip_file_url='https://drive.google.com/file/d/ZIPNEW/view' WHERE id=$1`, [session]);
  assert.deepStrictEqual(await repo.clipRefs(session, purgedAt), ["drive:NEWCLIP"], "only the new clip is looked up for deletion");
  const d = fakeDrive({ pct: 0.5 }); d.step = 0;
  const out = await S.runPurge({ repo, drive: d, mode: "manual" });
  assert.strictEqual(out.sessions, 1);
  assert.deepStrictEqual(d.deleted.sort(), ["NEWCLIP", "ZIPNEW"]);
});

tdb("db: GET /storage reports usage + counts; POST /storage/purge auto acts only above 80 %", async () => {
  const call = (p, o = {}) => fetch(base + p, { method: o.method || "GET", headers: { Authorization: `Bearer ${ids.token}`, "Content-Type": "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined });
  await makeDeliveredSession(3, { downloaded: true });
  ids.drive = fakeDrive({ pct: 0.4 });
  let st = await (await call("/storage")).json();
  assert.strictEqual(st.limit, 1000); assert.strictEqual(st.eligibleSessions, 1);
  let out = await (await call("/storage/purge", { method: "POST", body: { mode: "auto" } })).json();
  assert.strictEqual(out.sessions, 0, "40 % full: auto leaves it alone");
  ids.drive = fakeDrive({ pct: 0.85 });
  out = await (await call("/storage/purge", { method: "POST", body: { mode: "auto" } })).json();
  assert.strictEqual(out.sessions, 1, "85 % full: auto cleans");
  server.close(); await pool.end();
});
