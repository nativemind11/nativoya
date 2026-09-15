const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db/pool");
const { requireAuth, requireRole } = require("../config/auth");
const driveService = require("../config/googleDrive");
const firebaseAdmin = require("../config/firebaseAdmin");

const router = express.Router();

// POST /api/auth/signup
// body: { firstName, email, password, whatsappNumber, country, languages: [..], skills: [..] }
// Creates the user, records the skills they offer, and auto-joins them into
// a group (#1) for every language/dialect they picked — a member can end up
// in several groups at once this way.
router.post("/signup", async (req, res) => {
  const { firstName, email, password, whatsappNumber, country, languages, skills } = req.body;
  if (!firstName || !email || !password) {
    return res.status(400).json({ error: "firstName, email and password are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (first_name, email, password_hash, whatsapp_number, country)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, first_name, email, role`,
      [firstName, email, passwordHash, whatsappNumber, country]
    );
    const user = userResult.rows[0];

    const skillList = Array.isArray(skills) ? skills.filter(Boolean) : [];
    for (const slug of skillList) {
      await client.query(
        `INSERT INTO user_skills (user_id, skill_slug) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [user.id, slug]
      );
    }

    const languageList = Array.isArray(languages) ? languages.filter(Boolean) : [];
    for (const language of languageList) {
      let groupResult = await client.query(
        "SELECT * FROM groups WHERE language = $1 AND group_number = 1",
        [language]
      );
      let group = groupResult.rows[0];
      if (!group) {
        const created = await client.query(
          `INSERT INTO groups (language, group_number) VALUES ($1, 1) RETURNING *`,
          [language]
        );
        group = created.rows[0];
      }
      await client.query(
        `INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [user.id, group.id]
      );
    }

    await client.query("COMMIT");
    const token = signToken(user);
    res.status(201).json({ user, token });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "Email already registered" });
    console.error(err);
    res.status(500).json({ error: "Signup failed" });
  } finally {
    client.release();
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

// GET /api/auth/me — the current user's full profile: role, every group
// they belong to (one per language/dialect), the skills they offer, and
// (if they're a leader) the group they lead. Dashboards call this on load
// so they always reflect the real DB state instead of a stale localStorage copy.
router.get("/me", requireAuth, async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT id, first_name, email, role, country, reputation_score FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!userResult.rows.length) return res.status(404).json({ error: "User not found" });
    const user = userResult.rows[0];

    const groupsResult = await pool.query(
      `SELECT g.id, g.language, g.group_number, g.leader_id
       FROM user_groups ug JOIN groups g ON g.id = ug.group_id
       WHERE ug.user_id = $1
       ORDER BY g.language`,
      [req.user.id]
    );

    const skillsResult = await pool.query(
      `SELECT skill_slug FROM user_skills WHERE user_id = $1`,
      [req.user.id]
    );

    let ledGroups = [];
    if (user.role === "leader") {
      const ledResult = await pool.query(`SELECT * FROM groups WHERE leader_id = $1 ORDER BY created_at ASC`, [req.user.id]);
      ledGroups = ledResult.rows;
    }
    const ledGroup = ledGroups[0] || null; // first led group, kept for backward compatibility

    res.json({
      ...user,
      groups: groupsResult.rows,
      languages: groupsResult.rows.map((g) => g.language),
      skills: skillsResult.rows.map((r) => r.skill_slug),
      led_groups: ledGroups, // ALL groups this user leads (a leader can now lead several languages)
      led_group: ledGroup,
      // kept for backward-compatible clients that still read a single group
      group_id: ledGroup ? ledGroup.id : (groupsResult.rows[0] ? groupsResult.rows[0].id : null),
      group_number: ledGroup ? ledGroup.group_number : (groupsResult.rows[0] ? groupsResult.rows[0].group_number : null),
      language: ledGroup ? ledGroup.language : (groupsResult.rows[0] ? groupsResult.rows[0].language : null),
    });
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

// GET /api/auth/firebase-token — lets a logged-in user (via our own JWT)
// also sign into Firebase Auth, so Firestore Security Rules can trust who
// they are (role + which groups they belong to) without a separate login.
router.get("/firebase-token", requireAuth, async (req, res) => {
  try {
    const userResult = await pool.query("SELECT role FROM users WHERE id = $1", [req.user.id]);
    if (!userResult.rows.length) return res.status(404).json({ error: "User not found" });
    const { role } = userResult.rows[0];

    const groupsResult = await pool.query(
      `SELECT group_id FROM user_groups WHERE user_id = $1`,
      [req.user.id]
    );
    const groupIds = groupsResult.rows.map((r) => r.group_id);

    const token = await firebaseAdmin.mintCustomToken(req.user.id, {
      role,
      groupIds,
    });
    res.json({ token, groupIds });
  } catch (err) {
    console.error(err);
    if (err.code === "FIREBASE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "الشات لسه مش متصل بالسيرفر — لازم تُضاف بيانات Firebase الأول." });
    }
    res.status(500).json({ error: "Could not start a chat session" });
  }
});

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

module.exports = router;
