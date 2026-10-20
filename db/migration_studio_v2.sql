-- Studio v2 — task settings, quotas per gender / age bracket, instructions, rework hours,
-- leaders created by the head leader, no WhatsApp for talents. Safe to run more than once.

-- ---------------------------------------------------------------- task settings
ALTER TABLE recording_tasks ADD COLUMN IF NOT EXISTS instructions        TEXT;                         -- shown to the talent before the first sentence
ALTER TABLE recording_tasks ADD COLUMN IF NOT EXISTS rework_hours        INTEGER NOT NULL DEFAULT 12;  -- time a talent gets to redo rejected recordings
ALTER TABLE recording_tasks ADD COLUMN IF NOT EXISTS use_age_brackets    BOOLEAN NOT NULL DEFAULT false; -- ask the talent child / adult / elderly?
ALTER TABLE recording_tasks ADD COLUMN IF NOT EXISTS use_reference_audio BOOLEAN NOT NULL DEFAULT true;  -- do the sentences have example audio?
DO $$ BEGIN
  ALTER TABLE recording_tasks ADD CONSTRAINT recording_tasks_rework_hours_chk CHECK (rework_hours IN (12, 24));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- "how many talents" is now expressed by the quotas below; old tasks keep their number.
ALTER TABLE recording_tasks ALTER COLUMN quantity DROP NOT NULL;

-- ---------------------------------------------------------------- quotas
-- One row per (gender) — or per (gender, age bracket) when the task uses brackets — saying how many talents
-- may take part. A task with NO rows has no limit (old tasks). When rows exist, a combination without a row
-- is closed. A talent's session counts against its slot unless it was withdrawn (status 'expired').
CREATE TABLE IF NOT EXISTS studio_task_quotas (
  task_id     UUID NOT NULL REFERENCES recording_tasks(id) ON DELETE CASCADE,
  gender      TEXT NOT NULL CHECK (gender IN ('male', 'female')),
  age_bracket TEXT NOT NULL DEFAULT '' CHECK (age_bracket IN ('', 'child', 'adult', 'elderly')),
  max_count   INTEGER NOT NULL CHECK (max_count >= 0),
  PRIMARY KEY (task_id, gender, age_bracket)
);

-- ---------------------------------------------------------------- accounts
ALTER TABLE studio_talents ALTER COLUMN whatsapp DROP NOT NULL;      -- WhatsApp is no longer asked at sign-up
ALTER TABLE studio_leaders ADD COLUMN IF NOT EXISTS is_active  BOOLEAN NOT NULL DEFAULT true;   -- a head leader can switch a leader off
ALTER TABLE studio_leaders ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES studio_head_leaders(id);
