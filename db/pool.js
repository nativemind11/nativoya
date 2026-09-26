const { Pool } = require("pg");

// DATABASE_URL comes from Supabase / Railway / Render — set in .env, never hardcoded.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

module.exports = { pool };
