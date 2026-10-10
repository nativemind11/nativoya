// The whole Studio cycle on BUCKET storage (R2), against a real Postgres + an S3 server:
// record -> retake -> submit (zip streamed to the bucket) -> QA plays + approves ->
// head leader collects the big ZIP -> signed download link -> purge frees the bucket.
// Google Drive is replaced by a stub that FAILS if anything touches it.
// Needs TEST_DATABASE_URL (skipped otherwise).
const URL_DB = process.env.TEST_DATABASE_URL;
const test = require("node:test");
const assert = require("node:assert");
const t = URL_DB ? test : test.skip;
if (URL_DB) { process.env.DATABASE_URL = URL_DB; process.env.JWT_SECRET = "test-secret"; }

let server, base, pool, jwt, s3, blob, ids = {}, tok = {}, driveCalls = 0;
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const read = async (s) => { const c = []; for await (const x of s) c.push(Buffer.from(x)); return Buffer.concat(c); };

function wav(seconds, freq) {                       // 16 kHz / 16-bit / mono sine
  const rate = 16000, n = Math.floor(rate * seconds), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 9000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const zipNames = (buf) => {
  const out = [];
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf.readUInt32LE(i) === 0x04034b50) { const n = buf.readUInt16LE(i + 26); out.push(buf.slice(i + 30, i + 30 + n).toString()); i += 29 + n; }
  }
  return out;
};
const api = (path, { method = "GET", token, body, form } = {}) =>
  fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(form ? {} : { "Content-Type": "application/json" }) },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
const clipForm = (buf) => { const f = new FormData(); f.append("file", new Blob([buf], { type: "audio/wav" }), "clip.wav"); return f; };

t("boot (bucket on, Drive forbidden)", async () => {
  s3 = await require("./helpers/s3server").startS3();
  blob = require("../config/studioBlob");
  const cache = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const boom = () => { driveCalls++; throw new Error("Google Drive must not be used in bucket mode"); };
  cache("../config/googleDrive.js", { getAuthorizedClient: boom, uploadSubmissionFile: boom, shareWithAnyone: boom, shareFileWithAnyone: boom, isConnected: async () => true });
  cache("../config/studioDrive.js", { getOrCreateStudioRootFolder: boom, getOrCreateSubfolder: boom });

  const express = require("express"); jwt = require("jsonwebtoken");
  ({ pool } = require("../db/pool"));
  const app = express(); app.use(express.json());
  app.use("/api/studio/talent", require("../routes/studio/talent"));
  app.use("/api/studio/qa", require("../routes/studio/qa"));
  app.use("/api/studio/delivery", require("../routes/studio/delivery"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/studio`;

  await pool.query(`TRUNCATE studio_delivery_batch_sessions, studio_delivery_batches, recording_session_samples, recording_sessions, recording_samples,
    recording_tasks, studio_talents, studio_leaders, studio_qa_reviewers, studio_head_leaders CASCADE`);
  const hl = await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Head','h@x.com','x') RETURNING id`);
  const leader = await one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('Lea','l@x.com','x','L001') RETURNING id`);
  const qa = await one(`INSERT INTO studio_qa_reviewers (name,email,password_hash) VALUES ('QA One','q@x.com','x') RETURNING id`);
  const task = await one(`INSERT INTO recording_tasks (title,head_leader_id,quantity,recording_settings) VALUES ('Bucket Task',$1,10,$2) RETURNING id`,
    [hl.id, JSON.stringify({ sampleRate: 16000, bitDepth: 16, format: "wav", channels: "mono" })]);
  const samples = [];
  for (let i = 0; i < 2; i++) samples.push((await one(`INSERT INTO recording_samples (task_id,order_index,sentence_name) VALUES ($1,$2,$3) RETURNING id`, [task.id, i, `s${i}`])).id);
  const tal = await one(`INSERT INTO studio_talents (name,email,password_hash) VALUES ('Tal','t@x.com','x') RETURNING id`);
  const sess = await one(
    `INSERT INTO recording_sessions (task_id,leader_id,talent_id,session_token,gender,age_bracket,age,fake_name,status)
     VALUES ($1,$2,$3,'tok-r2','female','adult',30,'Falcon','in_progress') RETURNING id`, [task.id, leader.id, tal.id]);
  ids = { hl: hl.id, qa: qa.id, task: task.id, samples, sess: sess.id };
  tok = {
    talent: jwt.sign({ id: tal.id, studioRole: "talent" }, "test-secret"),
    qa: jwt.sign({ id: qa.id, studioRole: "qa" }, "test-secret"),
    hl: jwt.sign({ id: hl.id, studioRole: "head_leader" }, "test-secret"),
  };
});

const clip = {};
t("clip upload goes to the bucket, a retake replaces (and deletes) the old object", async () => {
  clip[0] = wav(1, 440); clip[1] = wav(1, 660);
  for (let i = 0; i < 2; i++) {
    const res = await api(`/talent/sessions/tok-r2/samples/${ids.samples[i]}/audio`, { method: "POST", token: tok.talent, form: clipForm(clip[i]) });
    assert.strictEqual(res.status, 200, await res.clone().text());
  }
  const rows = (await pool.query(`SELECT id, audio_file_url FROM recording_session_samples WHERE session_id=$1 ORDER BY completed_at`, [ids.sess])).rows;
  assert.ok(rows.every((r) => r.audio_file_url.startsWith("r2:studio/")), "stored as bucket references");
  const first = rows[0].audio_file_url;

  clip[0] = wav(1, 880);   // retake of sentence 1
  const retake = await api(`/talent/sessions/tok-r2/samples/${ids.samples[0]}/audio`, { method: "POST", token: tok.talent, form: clipForm(clip[0]) });
  assert.strictEqual(retake.status, 200);
  const now = (await pool.query(`SELECT audio_file_url, retakes FROM recording_session_samples WHERE session_id=$1 AND sample_id=$2`, [ids.sess, ids.samples[0]])).rows[0];
  assert.notStrictEqual(now.audio_file_url, first);
  assert.strictEqual(now.retakes, 1);
  await assert.rejects(blob.getStream(first), "the replaced take is gone from the bucket");
});

t("a clip with the wrong format is refused before it reaches the bucket", async () => {
  const bad = wav(1, 440); bad.writeUInt32LE(44100, 24);                       // claims 44.1 kHz, task wants 16 kHz
  const res = await api(`/talent/sessions/tok-r2/samples/${ids.samples[1]}/audio`, { method: "POST", token: tok.talent, form: clipForm(bad) });
  assert.strictEqual(res.status, 422);
});

t("submit streams the ZIP into the bucket: 01.wav + 02.wav with the right bytes", async () => {
  const res = await api(`/talent/sessions/tok-r2/submit`, { method: "POST", token: tok.talent });
  assert.strictEqual(res.status, 200, await res.clone().text());
  const s = await one(`SELECT status, zip_file_url, zip_file_name FROM recording_sessions WHERE id=$1`, [ids.sess]);
  assert.strictEqual(s.status, "submitted");
  assert.ok(s.zip_file_url.startsWith("r2:studio/"));
  assert.strictEqual(s.zip_file_name, "Falcon-female-adult-30.zip");
  const zip = await read((await blob.getStream(s.zip_file_url)).stream);
  const AdmZip = require("adm-zip");
  const z = new AdmZip(zip);
  assert.deepStrictEqual(z.getEntries().map((e) => e.entryName), ["01.wav", "02.wav"]);
  assert.ok(z.getEntry("01.wav").getData().equals(clip[0]), "01.wav is the RETAKE, byte for byte");
  assert.ok(z.getEntry("02.wav").getData().equals(clip[1]), "02.wav is intact");
});

t("QA plays a clip straight from the bucket and approves (nothing to move)", async () => {
  const ss = await one(`SELECT id FROM recording_session_samples WHERE session_id=$1 AND sample_id=$2`, [ids.sess, ids.samples[1]]);
  const play = await api(`/qa/samples/${ss.id}/audio`, { token: tok.qa });
  assert.strictEqual(play.status, 200);
  assert.strictEqual(play.headers.get("content-type"), "audio/wav");
  assert.ok(Buffer.from(await play.arrayBuffer()).equals(clip[1]));

  const ok = await api(`/qa/sessions/${ids.sess}/approve`, { method: "POST", token: tok.qa, body: {} });
  assert.strictEqual(ok.status, 200, await ok.clone().text());
  assert.strictEqual((await one(`SELECT status FROM recording_sessions WHERE id=$1`, [ids.sess])).status, "approved");
});

let batch;
t("head leader collects: the big ZIP lands in the bucket and a signed link downloads it", async () => {
  const day = (await one(`SELECT (qa_reviewed_at AT TIME ZONE 'Africa/Cairo')::date::text AS d FROM recording_sessions WHERE id=$1`, [ids.sess])).d;
  const res = await api(`/delivery/collect`, { method: "POST", token: tok.hl, body: { taskId: ids.task, gender: "female", qaReviewerId: ids.qa, day } });
  assert.strictEqual(res.status, 200, await res.clone().text());
  batch = (await res.json()).batch;
  assert.ok(batch.zip_file_url.startsWith("r2:studio/") && batch.zip_file_url.includes("/delivered/"));

  const link = await api(`/delivery/batches/${batch.id}/download`, { token: tok.hl });
  assert.strictEqual(link.status, 200);
  const { url } = await link.json();
  const file = await fetch(url);
  assert.strictEqual(file.status, 200);
  const big = Buffer.from(await file.arrayBuffer());
  assert.deepStrictEqual(zipNames(big).filter((n) => n.endsWith(".zip")), ["Falcon-female-adult-30.zip"]);

  assert.strictEqual((await api(`/delivery/batches/${batch.id}/download`, { token: tok.qa })).status, 403, "only the head leader");
  assert.strictEqual((await api(`/delivery/batches/${batch.id}/download`)).status, 401);
});

t("after 'downloaded' the purge frees the working clips + session ZIP from the bucket, rows stay", async () => {
  const S = require("../config/studioStorage");
  assert.strictEqual((await api(`/delivery/batches/${batch.id}/downloaded`, { method: "POST", token: tok.hl, body: {} })).status, 200);
  const before = await pool.query(`SELECT audio_file_url FROM recording_session_samples WHERE session_id=$1`, [ids.sess]);
  const zipRef = (await one(`SELECT zip_file_url FROM recording_sessions WHERE id=$1`, [ids.sess])).zip_file_url;

  const fakeDrive = { about: { get: async () => ({ data: { storageQuota: { limit: "1000", usage: "100" } } }) } };   // quota only; never used to delete
  const out = await S.runPurge({ repo: S.makeRepo(pool), drive: fakeDrive, mode: "manual" });
  assert.strictEqual(out.sessions, 1);
  for (const r of before.rows) await assert.rejects(blob.getStream(r.audio_file_url), "clip deleted");
  await assert.rejects(blob.getStream(zipRef), "session zip deleted");
  assert.strictEqual((await pool.query(`SELECT 1 FROM recording_session_samples WHERE session_id=$1`, [ids.sess])).rowCount, 2, "rows are kept");
  assert.ok((await read((await blob.getStream(batch.zip_file_url)).stream)).length > 0, "the delivered big ZIP is still there");
  assert.strictEqual(driveCalls, 0, "Google Drive was never touched");
});

t("done", async () => { server.close(); await pool.end(); await s3.stop(); require("./helpers/s3server").stopEnv(); });
