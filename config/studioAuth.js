const jwt = require("jsonwebtoken");
const { pool } = require("../db/pool");

// Completely separate from config/auth.js (the main site's auth) — a studio
// token can NEVER be used against main-site routes or vice versa, because
// each middleware looks the id up in a different set of tables.
const TABLES = {
  head_leader: "studio_head_leaders",
  leader: "studio_leaders",
  qa: "studio_qa_reviewers",
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

    delete result.rows[0].password_hash;
    req.studioUser = result.rows[0];
    req.studioRole = payload.studioRole; // 'head_leader' | 'leader' | 'qa'
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireStudioRole(...roles) {
  return (req, res, next) => {
    if (!req.studioRole || !roles.includes(req.studioRole)) {
      return res.status(403).json({ error: "Forbidden — insufficient role" });
    }
    next();
  };
}

module.exports = { requireStudioAuth, requireStudioRole, TABLES };
