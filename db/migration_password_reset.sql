-- ==========================================================================
-- Migration: "forgot password" support. Run this ONCE in the Supabase SQL
-- Editor on the database you already set up — schema.sql already includes
-- this for anyone setting up fresh.
-- ==========================================================================

-- We never store the raw reset token — only a sha256 hash of it, so a
-- database leak alone can't be used to reset anyone's password. The link
-- emailed to the user carries the raw token; it expires after 1 hour.
ALTER TABLE users ADD COLUMN reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN reset_token_expires_at TIMESTAMPTZ;
