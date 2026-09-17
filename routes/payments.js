const express = require("express");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../config/auth");

const router = express.Router();

// POST /api/payments  (head_leader only) — record a payment owed to a leader
router.post("/", requireAuth, requireRole("head_leader"), async (req, res) => {
  const { recipientId, amount, currency, payoutMethod, payoutIdentifier } = req.body;
  const result = await pool.query(
    `INSERT INTO payments (recipient_id, amount, currency, payout_method, payout_identifier)
     VALUES ($1, $2, COALESCE($3, 'EGP'), $4, $5) RETURNING *`,
    [recipientId, amount, currency, payoutMethod, payoutIdentifier]
  );
  res.status(201).json(result.rows[0]);
});

// GET /api/payments/pending  (head_leader dashboard — the payouts table)
router.get("/pending", requireAuth, requireRole("head_leader"), async (req, res) => {
  const result = await pool.query(`
    SELECT p.*, u.first_name AS recipient_name
    FROM payments p JOIN users u ON u.id = p.recipient_id
    WHERE p.status = 'pending'
    ORDER BY p.created_at ASC
  `);
  res.json(result.rows);
});

// POST /api/payments/:id/mark-transferred
// This is the single "✅ تم التحويل" button action from the admin dashboard.
// The actual money movement happens OUTSIDE this system (the head_leader
// transfers manually via InstaPay/Vodafone Cash/PayPal/etc); this endpoint
// only updates the tracked status.
router.post("/:id/mark-transferred", requireAuth, requireRole("head_leader"), async (req, res) => {
  const result = await pool.query(
    `UPDATE payments SET status = 'transferred', released_by = $1, released_at = now()
     WHERE id = $2 AND status = 'pending' RETURNING *`,
    [req.user.id, req.params.id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Payment not found or already transferred" });
  }
  res.json(result.rows[0]);
});

module.exports = router;
