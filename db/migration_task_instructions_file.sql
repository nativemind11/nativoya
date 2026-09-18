-- ==========================================================================
-- Migration: a task can now carry an uploaded PDF/TXT instructions file
-- (in addition to the plain-text instructions field), shown to members and
-- leaders as a download link. Run this once in the Supabase SQL Editor.
-- ==========================================================================

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS instructions_file_url TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS instructions_file_name TEXT;
