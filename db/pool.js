const { Pool } = require("pg");

// DATABASE_URL comes from Supabase / Railway / Render — set in .env, never hardcoded.
// On Vercel every server instance opens its OWN pool, so many instances x many connections can pass the database's
// limit: point DATABASE_URL at Supabase's pooler (port 6543), and lower PG_POOL_MAX if the database complains.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX) || 10,
  // never wait forever for a free connection: fail fast (the request returns an error) instead of hanging until the platform kills it
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 10000,
  // give idle connections back quickly — serverless instances come and go
  idleTimeoutMillis: 10000,
});

// an idle connection dropped by the database must not crash the process
pool.on("error", (err) => console.error("[pg pool] idle client error:", err.message));

module.exports = { pool };
