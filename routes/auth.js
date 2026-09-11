const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db/pool");

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

// GET /api/auth/google/callback
// Placeholder for the real Google OAuth flow (Drive + Sheets access for the
// head_leader account). Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
// GOOGLE_REDIRECT_URI to be set in .env before this is wired up.
router.get("/google/callback", (req, res) => {
  res.status(501).json({ error: "Google OAuth not yet configured. See .env.example." });
});

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

module.exports = router;
