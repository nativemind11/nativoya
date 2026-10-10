// The talent /submit route after the delivered audio was cleaned off Drive:
// a re-submission is a PARTIAL ZIP with only the re-recorded clips; a normal
// first submission is still a full ZIP. Drive is faked. Needs TEST_DATABASE_URL.
const URL_DB = process.env.TEST_DATABASE_URL;
const test = require("node:test");
const assert = require("node:assert");
const t = URL_DB ? test : test.skip;
if (URL_DB) { process.env.DATABASE_URL = URL_DB; process.env.JWT_SECRET = "test-secret"; }

const { Readable } = require("node:stream");
let server, base, pool, jwt, ids, tok;
const uploads = [], driveDeleted = [];

const zipNames = (buf) => {            // names of the entries in a ZIP (local file headers)
  const out = [];
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf.readUInt32LE(i) === 0x04034b50) { const n = buf.readUInt16LE(i + 26); out.push(buf.slice(i + 30, i + 30 + n).toString()); i += 29 + n; }
  }
  return out;
};
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

t("boot", async () => {
  const cache = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  cache("../config/googleDrive.js", {
    getAuthorizedClient: async () => ({}),
    uploadSubmissionFile: async (folder, name, mime, buffer) => { uploads.push({ name, names: zipNames(buffer) }); return { id: "NEWZIP", webViewLink: "https://drive.google.com/file/d/NEWZIP/view" }; },
    shareWithAnyone: async () => {}, shareFileWithAnyone: async () => {}, isConnected: async () => true,
  });
  cache("../config/studioDrive.js", { getOrCreateStudioRootFolder: async () => "ROOT", getOrCreateSubfolder: async () => "SUB" });
  require("googleapis").google.drive = () => ({
    files: {
      get: async ({ fileId }) => ({ data: Readable.from([Buffer.from("audio-" + fileId)]) }),
      delete: async ({ fileId }) => { driveDeleted.push(fileId); },
    },
  });

  const express = require("express"); jwt = require("jsonwebtoken");
  ({ pool } = require("../db/pool"));
  const app = express(); app.use(express.json());
  app.use("/api/studio/talent", require("../routes/studio/talent"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/studio/talent`;

  await pool.query(`TRUNCATE studio_delivery_batches, recording_session_samples, recording_sessions, recording_samples,
    recording_tasks, studio_talents, studio_leaders, studio_qa_reviewers, studio_head_leaders CASCADE`);
  const hl = await one(`INSERT INTO studio_head_leaders (name,email,password_hash) VALUES ('Head','h@x.com','x') RETURNING id`);
  const leader = await one(`INSERT INTO studio_leaders (name,email,password_hash,leader_code) VALUES ('Lea','l@x.com','x','L001') RETURNING id`);
  const task = await one(`INSERT INTO recording_tasks (title,head_leader_id,quantity,recording_settings) VALUES ('T',$1,10,'{"format":"wav"}') RETURNING id`, [hl.id]);
  const samples = [];
  for (let i = 0; i < 3; i++) samples.push((await one(`INSERT INTO recording_samples (task_id,order_index,sentence_name) VALUES ($1,$2,$3) RETURNING id`, [task.id, i, `s${i}`])).id);
  ids = { hl: hl.id, leader: leader.id, task: task.id, samples };
  tok = {};
});

async function mkSession(label, { status, purgedAt, oldZip, clips }) {
  const tal = await one(`INSERT INTO studio_talents (name,email,password_hash) VALUES ($1,$2,'x') RETURNING id`, [label, `${label}@m.com`]);
  tok[label] = jwt.sign({ id: tal.id, studioRole: "talent" }, "test-secret");
  const s = await one(
    `INSERT INTO recording_sessions (task_id,leader_id,talent_id,session_token,gender,age_bracket,age,fake_name,status,zip_file_url,audio_purged_at,files_on_drive)
     VALUES ($1,$2,$3,$4,'male','adult',30,$5,$6,$7,$8::timestamptz,$9) RETURNING id, session_token`,
    [ids.task, ids.leader, tal.id, `sub-${label}`, `Fake${label}`, status, oldZip || null, purgedAt || null, !purgedAt]);
  for (let i = 0; i < 3; i++) {
    await pool.query(`INSERT INTO recording_session_samples (session_id,sample_id,audio_file_url,duration,completed_at,qa_status)
      VALUES ($1,$2,$3,2,$4::timestamptz,$5)`, [s.id, ids.samples[i], `drive:${label}${i}`, clips[i].at, clips[i].qa || "pending"]);
  }
  return s;
}
const submit = (label, token) => fetch(`${base}/sessions/${token}/submit`, { method: "POST", headers: { Authorization: `Bearer ${tok[label]}`, "Content-Type": "application/json" } });
const day = (d) => `2026-01-${String(d).padStart(2, "0")}T10:00:00Z`;

t("a normal first submission is still a FULL zip (01,02,03) and not marked partial", async () => {
  const s = await mkSession("F", { status: "in_progress", clips: [{ at: day(5) }, { at: day(5) }, { at: day(5) }] });
  const res = await submit("F", s.session_token);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(uploads.at(-1).names, ["01.wav", "02.wav", "03.wav"]);
  const row = await one(`SELECT status, zip_partial_count, files_on_drive FROM recording_sessions WHERE id=$1`, [s.id]);
  assert.deepStrictEqual([row.status, row.zip_partial_count, row.files_on_drive], ["submitted", null, true]);
});

t("after a purge, the re-submission is a PARTIAL zip with only the re-recorded clip, the old zip is deleted", async () => {
  const s = await mkSession("P", {
    status: "rejected", purgedAt: day(10), oldZip: "https://drive.google.com/file/d/OLDZIP/view",
    clips: [{ at: day(5), qa: "approved" }, { at: day(20), qa: "pending" }, { at: day(5), qa: "approved" }],   // only recording 2 was redone
  });
  const before = driveDeleted.length;
  const res = await submit("P", s.session_token);
  assert.strictEqual(res.status, 200, await res.clone().text());
  assert.deepStrictEqual(uploads.at(-1).names, ["02.wav"], "recordings 1 and 3 no longer exist on Drive — not in the zip");
  const row = await one(`SELECT status, zip_partial_count, files_on_drive, zip_file_url FROM recording_sessions WHERE id=$1`, [s.id]);
  assert.deepStrictEqual([row.status, row.zip_partial_count, row.files_on_drive], ["submitted", 1, true]);
  assert.ok(row.zip_file_url.includes("NEWZIP"));
  assert.ok(driveDeleted.slice(before).includes("OLDZIP"), "superseded zip freed");
});

t("after a purge with nothing re-recorded there is nothing to submit (400)", async () => {
  const s = await mkSession("N", { status: "rejected", purgedAt: day(10), clips: [{ at: day(5) }, { at: day(5) }, { at: day(5) }] });
  const res = await submit("N", s.session_token);
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await one(`SELECT status FROM recording_sessions WHERE id=$1`, [s.id])).status, "rejected");
});

t("done", async () => { server.close(); await pool.end(); });
