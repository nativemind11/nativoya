const express = require("express");
const { pool } = require("../../db/pool");
const { requireStudioAuth, requireStudioRole } = require("../../config/studioAuth");
const { getOverview } = require("../../config/studioLeader");

const router = express.Router();

// GET /api/studio/leader/overview — the leader's own tasks + the talents under their code.
router.get("/overview", requireStudioAuth, requireStudioRole("leader"), async (req, res) => {
  try {
    res.json(await getOverview(pool, req.studioUser.id));
  } catch (err) {
    console.error("[leader:overview]", err);
    res.status(500).json({ error: "تعذر تحميل لوحة الليدر" });
  }
});

module.exports = router;
