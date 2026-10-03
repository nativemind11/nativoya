-- Addendum: talents now have real accounts (email + password), so feedback
-- from QA/head_leader can follow them wherever they log in — not just show
-- up anonymously or only to their leader.

CREATE TABLE IF NOT EXISTS studio_talents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,        -- real name, kept private from everyone except their leader + QA
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  whatsapp      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Link each session to the talent account that made it. real_name/whatsapp
-- used to live per-session (back when sessions were anonymous); that's now
-- fixed, account-level identity instead, so those two columns are dropped.
ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS talent_id UUID REFERENCES studio_talents(id);
ALTER TABLE recording_sessions DROP COLUMN IF EXISTS real_name;
ALTER TABLE recording_sessions DROP COLUMN IF EXISTS whatsapp;

CREATE INDEX IF NOT EXISTS idx_recording_sessions_talent ON recording_sessions(talent_id);
