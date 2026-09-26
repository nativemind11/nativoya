const express = require("express");
const multer = require("multer");
const archiver = require("archiver");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../config/auth");
const driveService = require("../config/googleDrive");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const router = express.Router();

// POST /api/recording/init-session
// Initialize a new recording session for a task claim
router.post("/init-session", requireAuth, requireRole("member", "leader"), async (req, res) => {
  try {
    const { claimId } = req.body;
    if (!claimId) return res.status(400).json({ error: "claimId is required" });

    // Verify user belongs to this claim's group
    const claimResult = await pool.query(
      `SELECT tc.id, tc.task_id, tc.group_id, t.recording_settings
       FROM task_claims tc
       JOIN tasks t ON t.id = tc.task_id
       WHERE tc.id = $1`,
      [claimId]
    );
    if (!claimResult.rows.length) return res.status(404).json({ error: "Claim not found" });

    const claim = claimResult.rows[0];
    const membership = await pool.query(
      "SELECT 1 FROM user_groups WHERE user_id = $1 AND group_id = $2",
      [req.user.id, claim.group_id]
    );
    if (!membership.rows.length) {
      return res.status(403).json({ error: "This claim doesn't belong to your group" });
    }

    // Check if a session already exists
    const existingSession = await pool.query(
      "SELECT id FROM recording_sessions WHERE user_id = $1 AND task_claim_id = $2 AND status = 'in_progress'",
      [req.user.id, claimId]
    );

    let sessionId;
    if (existingSession.rows.length) {
      sessionId = existingSession.rows[0].id;
    } else {
      const newSession = await pool.query(
        `INSERT INTO recording_sessions (user_id, task_claim_id, status)
         VALUES ($1, $2, 'in_progress') RETURNING id`,
        [req.user.id, claimId]
      );
      sessionId = newSession.rows[0].id;
    }

    res.json({
      sessionId,
      recordingSettings: claim.recording_settings,
      taskId: claim.task_id,
    });
  } catch (err) {
    console.error("[recording:init-session]", err);
    res.status(500).json({ error: "Could not initialize recording session" });
  }
});

// POST /api/recording/upload-chunk
// Upload a single audio file chunk to the session
router.post("/upload-chunk", requireAuth, requireRole("member", "leader"), upload.single("audio"), async (req, res) => {
  try {
    const { sessionId, filename, duration } = req.body;
    if (!sessionId || !filename || !req.file) {
      return res.status(400).json({ error: "sessionId, filename, and audio file are required" });
    }

    // Verify session belongs to this user
    const sessionResult = await pool.query(
      "SELECT id, audio_files FROM recording_sessions WHERE id = $1 AND user_id = $2",
      [sessionId, req.user.id]
    );
    if (!sessionResult.rows.length) return res.status(404).json({ error: "Session not found" });

    const session = sessionResult.rows[0];
    const audioFiles = Array.isArray(session.audio_files) ? session.audio_files : [];

    // For now, store file metadata locally (will be uploaded to Drive on finalize)
    const fileMetadata = {
      filename,
      mimeType: req.file.mimetype,
      size: req.file.size,
      duration: parseFloat(duration) || 0,
      uploadedAt: new Date().toISOString(),
      buffer: req.file.buffer.toString("base64"), // Store as base64 temporarily
    };

    audioFiles.push(fileMetadata);

    // Update session with new file
    await pool.query(
      "UPDATE recording_sessions SET audio_files = $1 WHERE id = $2",
      [JSON.stringify(audioFiles), sessionId]
    );

    res.json({
      success: true,
      fileCount: audioFiles.length,
      lastFile: filename,
    });
  } catch (err) {
    console.error("[recording:upload-chunk]", err);
    res.status(500).json({ error: "Could not upload audio file" });
  }
});

// POST /api/recording/finalize
// Package all recordings into a ZIP file and create submission
router.post("/finalize", requireAuth, requireRole("member", "leader"), async (req, res) => {
  try {
    const { sessionId, claimId } = req.body;
    if (!sessionId || !claimId) {
      return res.status(400).json({ error: "sessionId and claimId are required" });
    }

    // Verify session and claim
    const sessionResult = await pool.query(
      `SELECT rs.id, rs.audio_files, rs.task_claim_id, tc.task_id, tc.group_id
       FROM recording_sessions rs
       JOIN task_claims tc ON tc.id = rs.task_claim_id
       WHERE rs.id = $1 AND rs.user_id = $2 AND rs.task_claim_id = $3`,
      [sessionId, req.user.id, claimId]
    );
    if (!sessionResult.rows.length) return res.status(404).json({ error: "Session or claim not found" });

    const session = sessionResult.rows[0];
    const audioFiles = Array.isArray(session.audio_files) ? session.audio_files : [];

    if (audioFiles.length === 0) {
      return res.status(400).json({ error: "No audio files in this session" });
    }

    // Get Drive folder for this task
    const taskResult = await pool.query(
      "SELECT drive_folder_id FROM tasks WHERE id = $1",
      [session.task_id]
    );
    const task = taskResult.rows[0];
    if (!task || !task.drive_folder_id) {
      return res.status(503).json({ error: "Google Drive folder not connected" });
    }

    // Get user details for folder naming
    const userResult = await pool.query(
      "SELECT first_name, whatsapp_number, gender FROM users WHERE id = $1",
      [req.user.id]
    );
    const user = userResult.rows[0];
    const uploaderName = user?.first_name || "member";
    const genderLabel = user?.gender === "male" ? "ذكر" : user?.gender === "female" ? "أنثى" : "غير محدد";

    // Create ZIP file in memory
    const archiveBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      const archive = archiver("zip", { zlib: { level: 9 } });

      archive.on("data", (data) => chunks.push(data));
      archive.on("end", () => resolve(Buffer.concat(chunks)));
      archive.on("error", reject);

      // Add each audio file to the archive
      audioFiles.forEach((file, index) => {
        const buffer = Buffer.from(file.buffer, "base64");
        const entryName = `${index + 1}_${file.filename}`;
        archive.append(buffer, { name: entryName });
      });

      archive.finalize();
    });

    // Upload ZIP to Drive
    const zipFilename = `${uploaderName}_${genderLabel}_${new Date().getTime()}.zip`;
    const driveUpload = await driveService.uploadSubmissionFile(
      task.drive_folder_id,
      zipFilename,
      "application/zip",
      archiveBuffer
    );

    // Mark session as completed
    await pool.query(
      "UPDATE recording_sessions SET status = 'completed', submitted_at = now() WHERE id = $1",
      [sessionId]
    );

    // Create submission in database
    const submissionResult = await pool.query(
      `INSERT INTO submissions (task_claim_id, submitted_by, file_url, status, qa_status)
       VALUES ($1, $2, $3, 'in_review', 'pending') RETURNING *`,
      [claimId, req.user.id, driveUpload.webViewLink]
    );

    res.status(201).json({
      success: true,
      submission: submissionResult.rows[0],
      zipUrl: driveUpload.webViewLink,
      message: "Recording package submitted for review",
    });
  } catch (err) {
    console.error("[recording:finalize]", err);
    res.status(500).json({ error: "Could not finalize recording", detail: err.message });
  }
});

// POST /api/recording/delete-file
// Delete a single file from the active session
router.post("/delete-file", requireAuth, requireRole("member", "leader"), async (req, res) => {
  try {
    const { sessionId, filename } = req.body;
    if (!sessionId || !filename) {
      return res.status(400).json({ error: "sessionId and filename are required" });
    }

    const sessionResult = await pool.query(
      "SELECT audio_files FROM recording_sessions WHERE id = $1 AND user_id = $2",
      [sessionId, req.user.id]
    );
    if (!sessionResult.rows.length) return res.status(404).json({ error: "Session not found" });

    let audioFiles = Array.isArray(sessionResult.rows[0].audio_files) ? sessionResult.rows[0].audio_files : [];

    // Remove the file
    audioFiles = audioFiles.filter((f) => f.filename !== filename);

    await pool.query(
      "UPDATE recording_sessions SET audio_files = $1 WHERE id = $2",
      [JSON.stringify(audioFiles), sessionId]
    );

    res.json({ success: true, fileCount: audioFiles.length });
  } catch (err) {
    console.error("[recording:delete-file]", err);
    res.status(500).json({ error: "Could not delete file" });
  }
});

// GET /api/recording/session/:sessionId
// Get current session status and files
router.get("/session/:sessionId", requireAuth, requireRole("member", "leader"), async (req, res) => {
  try {
    const sessionResult = await pool.query(
      "SELECT id, audio_files, status, created_at FROM recording_sessions WHERE id = $1 AND user_id = $2",
      [req.params.sessionId, req.user.id]
    );

    if (!sessionResult.rows.length) return res.status(404).json({ error: "Session not found" });

    const session = sessionResult.rows[0];
    const audioFiles = Array.isArray(session.audio_files) ? session.audio_files : [];

    // Don't send base64 data back
    const filesMetadata = audioFiles.map((f) => ({
      filename: f.filename,
      duration: f.duration,
      size: f.size,
      uploadedAt: f.uploadedAt,
    }));

    res.json({
      sessionId: session.id,
      status: session.status,
      files: filesMetadata,
      fileCount: filesMetadata.length,
      createdAt: session.created_at,
    });
  } catch (err) {
    console.error("[recording:session]", err);
    res.status(500).json({ error: "Could not fetch session" });
  }
});

module.exports = router;
