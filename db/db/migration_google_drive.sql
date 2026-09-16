-- ==========================================================================
-- Migration: Google Drive integration
-- Run this ONCE in the Supabase SQL Editor. schema.sql already includes this
-- for anyone setting up a fresh database.
-- ==========================================================================

-- Holds the OAuth tokens for the ONE Google account (ahmedtaha.11887@gmail.com)
-- that owns the Drive everything gets uploaded to. There's only ever one row.
CREATE TABLE google_auth (
  id              SERIAL PRIMARY KEY,
  account_email   TEXT NOT NULL,
  access_token    TEXT,
  refresh_token   TEXT NOT NULL,
  expiry_date     BIGINT,
  root_folder_id  TEXT,                 -- the "Nativoya — Task Submissions" folder
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every task gets its own Drive folder the moment it's published
ALTER TABLE tasks ADD COLUMN drive_folder_id TEXT;
