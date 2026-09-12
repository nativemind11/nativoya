const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../config/auth");
const driveService = require("../config/googleDrive");

const router = express.Router();

// POST /api/auth/signup
router.post("/signup", async (req, res) => {
  const { firstName, email, password, whatsappNumber, country, role } = req.body;
  if (!firstName || !email || !password) {
    return res.status(400).json({ error: "firstName, email and password are required" });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (first_name, email, password_hash, whatsapp_number, country, role)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'member')::user_role)
       RETURNING id, first_name, email, role`,
      [firstName, email, passwordHash, whatsappNumber, country, role]
    );
    const user = result.rows[0];
    const token = signToken(user);
    res.status(201).json({ user, token });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Email already registered" });
    console.error(err);
    res.status(500).json({ error: "Signup failed" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const token = signToken(user);
    res.json({ user: { id: user.id, first_name: user.first_name, email: user.email, role: user.role }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// GET /api/auth/me — the current user's full profile, including their
// language/group if they've joined one. Dashboards call this on load so
// they always reflect the real DB state instead of a stale localStorage copy.
router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.first_name, u.email, u.role, u.language, u.reputation_score,
              g.id AS group_id, g.group_number, g.leader_id
       FROM users u
       LEFT JOIN groups g ON g.id = u.group_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "User not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load profile" });
  }
});

// GET /api/auth/google/connect?token=...  (head_leader only)
// This is opened as a plain link (not a fetch call), so the token can't ride
// in an Authorization header — it comes as a query param instead.
router.get("/google/connect", (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).send("Missing token");
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== "head_leader") return res.status(403).send("Forbidden — head_leader only");
  } catch (err) {
    return res.status(401).send("Invalid or expired token");
  }
  res.redirect(driveService.getAuthUrl());
});

// GET /api/auth/google/callback — Google redirects here after consent
router.get("/google/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Google returned an error: ${error}`);
  if (!code) return res.status(400).send("Missing ?code from Google.");

  try {
    const email = await driveService.saveTokensFromCode(code);
    res.send(`
      <div style="font-family:sans-serif; padding:40px; text-align:center;">
        <h2>✅ اتوصل جوجل درايف بنجاح</h2>
        <p>الحساب المتصل: <b>${email}</b></p>
        <p>تقدر تقفل الصفحة دي وترجع للوحة الأدمن.</p>
      </div>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("Could not complete Google connection: " + err.message);
  }
});

// GET /api/auth/google/status  (head_leader only) — is Drive connected?
router.get("/google/status", requireAuth, requireRole("head_leader"), async (req, res) => {
  const email = await driveService.isConnected();
  res.json({ connected: Boolean(email), email: email || null });
});

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

module.exports = router;
