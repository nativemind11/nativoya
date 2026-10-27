-- ==========================================================================
-- Studio v8 — real data on the talent's ACCOUNT, and a task mode that names files with the real name.
--
-- Run ONCE in the Supabase SQL Editor BEFORE deploying the new backend. Safe to re-run.
-- Additive only: three new columns on the accounts, and one wider CHECK on recording_tasks.
--
--   studio_talents.gender / age / age_bracket  asked once when the account is created
--                                              (age_bracket is computed from age: <18 child, 18-59 adult, 60+ elderly)
--   recording_tasks.identity_mode              now also accepts 'real' = files are named with the talent's real
--                                              (English) name instead of a fake name or a code
--
-- Old talent accounts have no gender / age. The head leader decided to delete them (see the optional
-- clean-up at the bottom); an old account that is kept is simply asked to be re-created when it starts a task.
-- ==========================================================================

-- 1) the account data
ALTER TABLE studio_talents ADD COLUMN IF NOT EXISTS gender      TEXT;
ALTER TABLE studio_talents ADD COLUMN IF NOT EXISTS age         INTEGER;
ALTER TABLE studio_talents ADD COLUMN IF NOT EXISTS age_bracket TEXT;
DO $$ BEGIN
  ALTER TABLE studio_talents ADD CONSTRAINT studio_talents_gender_chk CHECK (gender IS NULL OR gender IN ('male', 'female'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE studio_talents ADD CONSTRAINT studio_talents_bracket_chk CHECK (age_bracket IS NULL OR age_bracket IN ('child', 'adult', 'elderly'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE studio_talents ADD CONSTRAINT studio_talents_age_chk CHECK (age IS NULL OR age BETWEEN 1 AND 120);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) a task can name its files with the real name
ALTER TABLE recording_tasks DROP CONSTRAINT IF EXISTS recording_tasks_identity_mode_chk;
DO $$ BEGIN
  ALTER TABLE recording_tasks ADD CONSTRAINT recording_tasks_identity_mode_chk CHECK (identity_mode IN ('names', 'codes', 'real'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ==========================================================================
-- OPTIONAL — delete ALL old talent accounts (and everything they recorded).
-- Not run automatically. Uncomment the block, read it once, then run it. IT CANNOT BE UNDONE.
-- Only do this when no real work is in progress: it removes their sessions, clips records,
-- QA reviews, delivery links and company feedback rows. Audio files already on Drive / R2 stay
-- there until the task is finalized from the head leader dashboard.
-- ==========================================================================
-- BEGIN;
--   DELETE FROM studio_delivery_batch_sessions WHERE session_id IN (SELECT id FROM recording_sessions WHERE talent_id IS NOT NULL);
--   DELETE FROM studio_feedback_items          WHERE session_id IN (SELECT id FROM recording_sessions WHERE talent_id IS NOT NULL);
--   DELETE FROM recording_sessions             WHERE talent_id IS NOT NULL;   -- clips + QA reviews go with them (ON DELETE CASCADE)
--   DELETE FROM studio_talents;
-- COMMIT;
