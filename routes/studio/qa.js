const express = require("express");
const { google } = require("googleapis");
const { pool } = require("../../db/pool");
const { requireStudioAuth, requireStudioRole } = require("../../config/studioAuth");
const { getAuthorizedClient, uploadSubmissionFile } = require("../../config/googleDrive");
const { getOrCreateStudioRootFolder, getOrCreateSubfolder } = require("../../config/studioDrive");
const blob = require("../../config/studioBlob");

const router = express.Router();
router.use(requireStudioAuth, requireStudioRole("qa"));

// GET /api/studio/qa/pending — every session waiting for a verdict. Any QA
// reviewer can see/claim any of these (shared queue, no fixed assignment —
// useful when a task has enough volume that several reviewers split it).
router.get("/pending", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT rs.id, rs.fake_name, rs.gender, rs.age_bracket, rs.age, rs.created_at, rs.updated_at,
        t.title AS task_title, l.leader_code,
        (SELECT COUNT(*) FROM recording_session_samples WHERE session_id = rs.id) AS sample_count
      FROM recording_sessions rs
      JOIN recording_tasks t ON t.id = rs.task_id
      JOIN studio_leaders l ON l.id = rs.leader_id
      WHERE rs.status = 'submitted'
      ORDER BY rs.updated_at ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل قائمة المراجعة" });
  }
});

// GET /api/studio/qa/sessions/:id — full detail: every recorded sentence +
// its current QA status, for the per-recording review screen.
router.get("/sessions/:id", async (req, res) => {
  try {
    const sessionResult = await pool.query(`
      SELECT rs.*, t.title AS task_title, l.leader_code
      FROM recording_sessions rs
      JOIN recording_tasks t ON t.id = rs.task_id
      JOIN studio_leaders l ON l.id = rs.leader_id
      WHERE rs.id = $1
    `, [req.params.id]);
    if (!sessionResult.rows.length) return res.status(404).json({ error: "التسليم ده مش موجود" });

    const samples = await pool.query(`
      SELECT ss.*, s.sentence_name, s.order_index
      FROM recording_session_samples ss
      JOIN recording_samples s ON s.id = ss.sample_id
      WHERE ss.session_id = $1
      ORDER BY s.order_index
    `, [req.params.id]);

    res.json({ session: sessionResult.rows[0], samples: samples.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تحميل تفاصيل التسليم" });
  }
});

// GET /api/studio/qa/samples/:sessionSampleId/audio — streams ONE recorded
// clip through our server (same reasoning as the talent-side reference
// audio endpoint: a raw Drive link doesn't reliably play in <audio>).
router.get("/samples/:sessionSampleId/audio", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT audio_file_url FROM recording_session_samples WHERE id = $1`, [req.params.sessionSampleId]
    );
    if (!result.rows.length || !result.rows[0].audio_file_url) {
      return res.status(404).json({ error: "مفيش تسجيل هنا" });
    }
    const { stream, contentType } = await blob.getStream(result.rows[0].audio_file_url);

    res.setHeader("Content-Type", contentType || "audio/webm");
    stream.on("error", (e) => { console.error("[qa audio stream]", e.message); res.destroy(e); });
    stream.pipe(res);
  } catch (err) {
    console.error(err);
    if (err.code === "DRIVE_NOT_CONNECTED") {
      return res.status(503).json({ error: "جوجل درايف لسه مش متصل بالسيرفر." });
    }
    res.status(500).json({ error: "تعذر تشغيل التسجيل" });
  }
});

// POST /api/studio/qa/sessions/:id/approve — quick full approve, every
// recording is fine as-is. Goes straight to the head_leader's approved pile.
router.post("/sessions/:id/approve", async (req, res) => {
  try {
    const result = await finalizeSession(req.params.id, req.studioUser.id, [], null);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "تعذر القبول" });
  }
});

// POST /api/studio/qa/sessions/:id/reject-all — quick full reject, every
// recording needs to be redone. body: { reason? }
router.post("/sessions/:id/reject-all", async (req, res) => {
  try {
    const sampleIds = await getAllSampleIds(req.params.id);
    const result = await finalizeSession(req.params.id, req.studioUser.id, sampleIds, req.body.reason || "التسجيل كله محتاج إعادة");
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "تعذر الرفض" });
  }
});

// POST /api/studio/qa/sessions/:id/review — detailed, per-recording verdicts.
// body: { decisions: [{ sessionSampleId, status: 'approved'|'rejected', reason? }] }
router.post("/sessions/:id/review", async (req, res) => {
  const { decisions } = req.body;
  if (!Array.isArray(decisions) || !decisions.length) {
    return res.status(400).json({ error: "لازم تحدد قرار لكل جملة قبل ما تبعت" });
  }
  try {
    const rejectedIds = decisions.filter(d => d.status === "rejected").map(d => d.sessionSampleId);
    const reasonMap = new Map(decisions.map(d => [d.sessionSampleId, d.reason || null]));
    const result = await finalizeSession(req.params.id, req.studioUser.id, rejectedIds, null, reasonMap);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "تعذر حفظ المراجعة" });
  }
});

async function getAllSampleIds(sessionId) {
  const result = await pool.query(`SELECT id FROM recording_session_samples WHERE session_id = $1`, [sessionId]);
  return result.rows.map(r => r.id);
}

// Shared logic for all 3 verdict routes above: marks the given sessionSample
// ids as rejected (rest approved), decides the session's overall outcome,
// moves the zip to the right Drive folder once genuinely fully approved,
// and sets a 12h rework deadline when anything was rejected.
async function finalizeSession(sessionId, qaReviewerId, rejectedSampleIds, uniformReason, reasonMap) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sessionResult = await client.query(`
      SELECT rs.*, t.title AS task_title, t.id AS task_id, l.leader_code
      FROM recording_sessions rs
      JOIN recording_tasks t ON t.id = rs.task_id
      JOIN studio_leaders l ON l.id = rs.leader_id
      WHERE rs.id = $1
    `, [sessionId]);
    if (!sessionResult.rows.length) { const e = new Error("التسليم ده مش موجود"); e.statusCode = 404; throw e; }
    const session = sessionResult.rows[0];
    if (session.status !== "submitted") { const e = new Error("التسليم ده اتراجع بالفعل"); e.statusCode = 400; throw e; }

    const allSamples = await client.query(`SELECT id FROM recording_session_samples WHERE session_id = $1`, [sessionId]);
    const rejectedSet = new Set(rejectedSampleIds);

    for (const row of allSamples.rows) {
      const isRejected = rejectedSet.has(row.id);
      const reason = isRejected ? (reasonMap ? reasonMap.get(row.id) : uniformReason) : null;
      await client.query(
        `UPDATE recording_session_samples SET qa_status = $1, qa_reason = $2 WHERE id = $3`,
        [isRejected ? "rejected" : "approved", reason, row.id]
      );
    }

    const anyRejected = rejectedSampleIds.length > 0;
    const newStatus = anyRejected ? "rejected" : "approved";
    const aggregateReason = anyRejected
      ? (uniformReason || "في تسجيلات محتاجة إعادة — شوف التفاصيل لكل جملة.")
      : null;
    const reworkDeadline = anyRejected ? new Date(Date.now() + 12 * 60 * 60 * 1000) : null;

    await client.query(
      `UPDATE recording_sessions
       SET status = $1, rejection_reason = $2, rework_deadline = $3, rework_enforced = $6,
           qa_reviewer_id = $4, qa_reviewed_at = now(), updated_at = now()
       WHERE id = $5`,
      [newStatus, aggregateReason, reworkDeadline, qaReviewerId, sessionId, !!reworkDeadline]
    );

    await client.query("COMMIT");

    // Only on a genuine full approval do we move the zip into the
    // head_leader's gendered "Approved" folder — a rejected/partial session
    // stays in the QA folder since it isn't final yet.
    // (Files in the bucket have no folders to move between — the DB status is the "approved" marker.)
    if (!anyRejected && session.zip_file_url && !blob.isBlobRef(session.zip_file_url)) {
      try {
        const authClient = await getAuthorizedClient();
        const drive = google.drive({ version: "v3", auth: authClient });
        const studioRoot = await getOrCreateStudioRootFolder();
        const taskFolderId = await getOrCreateSubfolder(drive, studioRoot, `${session.task_title} — ${session.task_id.slice(0, 8)}`);
        const genderFolderName = session.gender === "male"
          ? `${session.leader_code} - Approved Male`
          : `${session.leader_code} - Approved Female`;
        const approvedFolderId = await getOrCreateSubfolder(drive, taskFolderId, genderFolderName);

        const fileIdMatch = session.zip_file_url.match(/\/file\/d\/([^/]+)/) || session.zip_file_url.match(/[-\w]{25,}/);
        if (fileIdMatch) {
          await drive.files.update({
            fileId: fileIdMatch[1] || fileIdMatch[0],
            addParents: approvedFolderId,
            fields: "id, parents",
          });
        }
      } catch (driveErr) {
        // Non-fatal — the review decision itself already saved successfully.
        console.error("[qa] couldn't move approved zip to its final folder:", driveErr.message);
      }
    }

    return { status: newStatus, rejectedCount: rejectedSampleIds.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
