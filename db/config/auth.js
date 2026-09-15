const jwt = require("jsonwebtoken");
const { pool } = require("../db/pool");

// Verifies the token's signature/expiry, then re-checks the user's CURRENT
// role straight from the database (not the role baked into the token at
// login time). Without this, someone promoted to leader/head_leader mid-
// session would keep getting 403s on their new permissions until they
// happened to log out and back in — since a JWT's claims never update
// themselves once issued.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query("SELECT id, email, role FROM users WHERE id = $1", [payload.id]);
    if (!result.rows.length) return res.status(401).json({ error: "Invalid or expired token" });
    req.user = result.rows[0]; // always the live role, not whatever the token said at login
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden — insufficient role" });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
