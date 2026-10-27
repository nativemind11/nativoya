const jwt = require("jsonwebtoken");
const { pool } = require("../db/pool");

// Completely separate from config/auth.js (the main site's auth) — a studio
// token can NEVER be used against main-site routes or vice versa, because
// each middleware looks the id up in a different set of tables.
const TABLES = {
  head_leader: "studio_head_leaders",
  leader: "studio_leaders",
  qa: "studio_qa_reviewers",
  talent: "studio_talents",
};

async function requireStudioAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const table = TABLES[payload.studioRole];
    if (!table) return res.status(401).json({ error: "Invalid or expired token" });

    const result = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [payload.id]);
    if (!result.rows.length) return res.status(401).json({ error: "Invalid or expired token" });

    if (result.rows[0].is_active === false) return res.status(403).json({ error: "الحساب ده متوقف. كلّم الهيد ليدر." });
    delete result.rows[0].password_hash;
    req.studioUser = result.rows[0];
    req.studioRole = payload.studioRole; // 'head_leader' | 'leader' | 'qa'
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Like requireStudioAuth, but never rejects: a valid token fills req.studioUser / req.studioRole, anything else
// (no token, bad token, disabled account) simply leaves them unset. For public routes that look a bit
// different for a logged-in user (e.g. the talent's own "available tasks" list).
async function optionalStudioAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const table = TABLES[payload.studioRole];
    if (!table) return next();
    const result = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [payload.id]);
    if (!result.rows.length || result.rows[0].is_active === false) return next();
    delete result.rows[0].password_hash;
    req.studioUser = result.rows[0];
    req.studioRole = payload.studioRole;
  } catch (_) { /* treated as logged out */ }
  next();
}

function requireStudioRole(...roles) {
  return (req, res, next) => {
    if (!req.studioRole || !roles.includes(req.studioRole)) {
      return res.status(403).json({ error: "Forbidden — insufficient role" });
    }
    next();
  };
}

module.exports = { requireStudioAuth, optionalStudioAuth, requireStudioRole, TABLES };
