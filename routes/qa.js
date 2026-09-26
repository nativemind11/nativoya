const express = require("express");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../config/auth");

const router = express.Router();

// GET /api/qa/pending-reviews
// Head leader only - get all submissions pending review
router.get("/pending-reviews", requireAuth, requireRole("head_leader"), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.id AS submission_id,
        s.file_url,
        s.created_at,
        s.status,
        s.qa_status,
        u.first_name AS member_name,
        u.id AS member_id,
        g.language,
        g.group_number,
        t.title AS task_title,
        t.id AS task_id,
        lu.first_name AS leader_name,
        COALESCE(qr.status, 'not_reviewed') AS qa_review_status,
        qr.feedback,
        qr.reviewed_at
      FROM submissions s
      JOIN task_claims tc ON tc.id = s.task_claim_id
      JOIN tasks t ON t.id = tc.task_id
      JOIN users u ON u.id = s.submitted_by
      JOIN groups g ON g.id = tc.group_id
      LEFT JOIN users lu ON lu.id = g.leader_id
      LEFT JOIN qa_reviews qr ON qr.submission_id = s.id
      WHERE s.qa_status = 'pending' OR qr.status = 'pending'
      ORDER BY s.created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("[qa:pending-reviews]", err);
    res.status(500).json({ error: "Could not fetch pending reviews" });
  }
});

// GET /api/qa/submission/:submissionId
// Head leader only - get full details of a submission
router.get("/submission/:submissionId", requireAuth, requireRole("head_leader"), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.id AS submission_id,
        s.file_url,
        s.created_at,
        s.status,
        s.qa_status,
        s.rejection_reason,
        u.first_name AS member_name,
        u.whatsapp_number,
        u.gender,
        u.id AS member_id,
        g.language,
        g.group_number,
        t.title AS task_title,
        t.id AS task_id,
        t.recording_settings,
        lu.first_name AS leader_name,
        tc.id AS claim_id,
        COALESCE(qr.status, 'not_reviewed') AS qa_review_status,
        qr.feedback,
        qr.reviewed_at
      FROM submissions s
      JOIN task_claims tc ON tc.id = s.task_claim_id
      JOIN tasks t ON t.id = tc.task_id
      JOIN users u ON u.id = s.submitted_by
      JOIN groups g ON g.id = tc.group_id
      LEFT JOIN users lu ON lu.id = g.leader_id
      LEFT JOIN qa_reviews qr ON qr.submission_id = s.id
      WHERE s.id = $1
    `, [req.params.submissionId]);

    if (!result.rows.length) return res.status(404).json({ error: "Submission not found" });

    res.json(result.rows[0]);
  } catch (err) {
    console.error("[qa:submission]", err);
    res.status(500).json({ error: "Could not fetch submission details" });
  }
});

// POST /api/qa/submission/:submissionId/review
// Head leader only - approve or reject a submission
router.post("/submission/:submissionId/review", requireAuth, requireRole("head_leader"), async (req, res) => {
  try {
    const { approve, feedback } = req.body;

    if (typeof approve !== "boolean") {
      return res.status(400).json({ error: "approve (true/false) is required" });
    }

    if (!approve && !feedback) {
      return res.status(400).json({ error: "feedback is required when rejecting" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Check if submission exists
      const submissionResult = await client.query(
        "SELECT id, status FROM submissions WHERE id = $1",
        [req.params.submissionId]
      );
      if (!submissionResult.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Submission not found" });
      }

      // Update submission status
      const newStatus = approve ? "completed" : "rejected";
      const rejectionReason = approve ? null : feedback;

      await client.query(
        `UPDATE submissions 
         SET status = $1, qa_status = 'approved_by_qa', rejection_reason = $2, reviewed_by = $3, reviewed_at = now()
         WHERE id = $4`,
        [newStatus, rejectionReason, req.user.id, req.params.submissionId]
      );

      // Create or update QA review record
      const qaReviewResult = await client.query(
        `SELECT id FROM qa_reviews WHERE submission_id = $1`,
        [req.params.submissionId]
      );

      if (qaReviewResult.rows.length) {
        await client.query(
          `UPDATE qa_reviews 
           SET status = $1, feedback = $2, reviewed_at = now()
           WHERE submission_id = $3`,
          [approve ? "approved" : "rejected", feedback, req.params.submissionId]
        );
      } else {
        await client.query(
          `INSERT INTO qa_reviews (submission_id, reviewer_id, status, feedback, reviewed_at)
           VALUES ($1, $2, $3, $4, now())`,
          [req.params.submissionId, req.user.id, approve ? "approved" : "rejected", feedback]
        );
      }

      await client.query("COMMIT");

      res.json({
        success: true,
        message: approve ? "Submission approved" : "Submission rejected",
        submissionId: req.params.submissionId,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[qa:review]", err);
    res.status(500).json({ error: "Could not process review" });
  }
});

// GET /api/qa/stats
// Head leader only - QA statistics
router.get("/stats", requireAuth, requireRole("head_leader"), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(CASE WHEN s.qa_status = 'pending' THEN 1 END) AS pending_count,
        COUNT(CASE WHEN qr.status = 'approved' THEN 1 END) AS approved_count,
        COUNT(CASE WHEN qr.status = 'rejected' THEN 1 END) AS rejected_count,
        AVG(EXTRACT(EPOCH FROM (qr.reviewed_at - s.created_at))) AS avg_review_time_seconds
      FROM submissions s
      LEFT JOIN qa_reviews qr ON qr.submission_id = s.id
      WHERE s.status IN ('in_review', 'completed', 'rejected')
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error("[qa:stats]", err);
    res.status(500).json({ error: "Could not fetch QA statistics" });
  }
});

module.exports = router;
