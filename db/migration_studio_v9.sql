-- ==========================================================================
-- Studio v9 — a script can be reserved for boys or for girls.
--
-- Run ONCE in the Supabase SQL Editor BEFORE deploying the new backend. Safe to re-run.
-- Additive only: one new column. Every script that exists today has gender = NULL = "any talent",
-- which is exactly how it behaved before, so no running task changes.
--
--   studio_task_scripts.gender   NULL     = any talent can get this script (as before)
--                                'male'   = only boys get it
--                                'female' = only girls get it
--
-- Codes need NO migration: recording_tasks.identity_codes (JSONB) now also accepts, per gender, an object
-- split by age group  {"male": {"child":[..],"adult":[..],"elderly":[..]}, "female": [..]}
-- next to the old plain list  {"male": [..], "female": [..]}. Old tasks keep their plain lists.
-- ==========================================================================
ALTER TABLE studio_task_scripts ADD COLUMN IF NOT EXISTS gender TEXT;
DO $$ BEGIN
  ALTER TABLE studio_task_scripts ADD CONSTRAINT studio_task_scripts_gender_chk CHECK (gender IS NULL OR gender IN ('male', 'female'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_task_scripts_gender ON studio_task_scripts (task_id, gender);
