const bcrypt = require("bcryptjs");

// Next leader code (L001, L002, ...). Locks the table for the transaction, so two accounts created at the
// same moment can never get the same code.
async function nextLeaderCode(client) {
  await client.query("LOCK TABLE studio_leaders IN SHARE ROW EXCLUSIVE MODE");
  const r = await client.query(`SELECT leader_code FROM studio_leaders WHERE NOT is_system ORDER BY created_at DESC, leader_code DESC LIMIT 1`);
  const last = r.rows[0] && r.rows[0].leader_code;
  const n = last ? parseInt(last.replace(/\D/g, ""), 10) || 0 : 0;
  return `L${String(n + 1).padStart(3, "0")}`;
}

/** Creates a leader account. Only a head leader does this (there is no public sign-up for leaders). */
async function createLeader(pool, { name, email, password, createdBy }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const code = await nextLeaderCode(client);
    const hash = await bcrypt.hash(password, 10);
    const r = await client.query(
      `INSERT INTO studio_leaders (name, email, password_hash, leader_code, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, leader_code, is_active, created_at`,
      [name, email.trim().toLowerCase(), hash, code, createdBy || null]);
    await client.query("COMMIT");
    return r.rows[0];
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally { client.release(); }
}

module.exports = { nextLeaderCode, createLeader };
