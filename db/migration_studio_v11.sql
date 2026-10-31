-- ==========================================================================
-- Studio v11 — "Company acceptance" (القبول من الشركة).
--
-- Run ONCE in the Supabase SQL Editor BEFORE deploying the new backend. Safe to re-run.
-- Additive only: two NEW tables. No existing table, column or row is touched, so everything that runs today
-- keeps running exactly as before; until this is run, the acceptance page simply says it needs the migration
-- and the talent / leader accounts show no acceptance state.
--
--   studio_acceptance_files  one row per acceptance file the head leader uploaded (task, file name, how many people it accepted)
--   studio_acceptances       one row per ACCEPTED person (session): who, which file, the name as the company wrote it, when
--
-- Deleting a task (the existing "delete for good") removes its acceptance rows too (ON DELETE CASCADE).
-- Deleting an acceptance file removes the acceptance of the people it accepted (that is the "undo this file" button).
-- ==========================================================================
CREATE TABLE IF NOT EXISTS studio_acceptance_files (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        UUID NOT NULL REFERENCES recording_tasks(id) ON DELETE CASCADE,
  file_name      TEXT,
  created_by     UUID,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acceptance_files_task ON studio_acceptance_files (task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS studio_acceptances (
  session_id  UUID PRIMARY KEY REFERENCES recording_sessions(id) ON DELETE CASCADE,
  task_id     UUID NOT NULL REFERENCES recording_tasks(id) ON DELETE CASCADE,
  file_id     UUID REFERENCES studio_acceptance_files(id) ON DELETE CASCADE,
  sheet_label TEXT,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acceptances_task ON studio_acceptances (task_id);
CREATE INDEX IF NOT EXISTS idx_acceptances_file ON studio_acceptances (file_id);
