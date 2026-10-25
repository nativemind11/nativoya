-- ==========================================================================
-- Studio v4 — (1) a quota PER LEADER, (2) rework ZIPs that hold only the
-- re-recorded sentences (marked "Rework" in the delivery sheet), (3) a free
-- rework time (any number of hours, not just 12 / 24).
--
-- Run ONCE in the Supabase SQL Editor BEFORE deploying the new backend.
-- Safe to re-run. Additive only: no existing column or table is changed,
-- and every task / session that exists today keeps behaving exactly as before.
-- ==========================================================================

-- ---------------------------------------------------------------- 1) quota per leader
-- One row per (task, leader, gender) — or per (task, leader, gender, age bracket) when the task uses brackets.
-- A task with NO rows here works exactly like before (only the task-level quota in studio_task_quotas applies).
-- When rows exist, a talent who picks leader X is counted against X's own slot too, and a leader/gender
-- combination without a row is closed. (The task-level quota is kept equal to the SUM of the leaders' rows,
-- so every existing screen that shows "places left" keeps working.)
CREATE TABLE IF NOT EXISTS studio_task_leader_quotas (
  task_id     UUID NOT NULL REFERENCES recording_tasks(id) ON DELETE CASCADE,
  leader_id   UUID NOT NULL REFERENCES studio_leaders(id)  ON DELETE CASCADE,
  gender      TEXT NOT NULL CHECK (gender IN ('male', 'female')),
  age_bracket TEXT NOT NULL DEFAULT '' CHECK (age_bracket IN ('', 'child', 'adult', 'elderly')),
  max_count   INTEGER NOT NULL CHECK (max_count >= 0),
  PRIMARY KEY (task_id, leader_id, gender, age_bracket)
);
CREATE INDEX IF NOT EXISTS idx_leader_quotas_task ON studio_task_leader_quotas(task_id);

-- ---------------------------------------------------------------- 2) rework-only ZIP
-- Set when a session is re-submitted after COMPANY feedback on something that was already delivered:
-- the ZIP then holds only the re-recorded sentences (same file name as before), and the delivery sheet says "Rework".
ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS zip_is_rework      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS zip_rework_numbers INTEGER[];      -- 1-based recording numbers inside that ZIP

-- Snapshot at delivery time, so an old batch's sheet keeps saying what it said the day it was delivered
-- (the session row itself moves on: later feedback, later re-delivery...).
ALTER TABLE studio_delivery_batch_sessions ADD COLUMN IF NOT EXISTS is_rework      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE studio_delivery_batch_sessions ADD COLUMN IF NOT EXISTS rework_numbers INTEGER[];

-- ---------------------------------------------------------------- 3) free rework time
-- Before: CHECK (rework_hours IN (12, 24)). Now any whole number of hours from 1 up to 30 days (720).
-- Every value stored today (12 / 24) is inside the new range.
ALTER TABLE recording_tasks DROP CONSTRAINT IF EXISTS recording_tasks_rework_hours_chk;
DO $$ BEGIN
  ALTER TABLE recording_tasks ADD CONSTRAINT recording_tasks_rework_hours_chk CHECK (rework_hours BETWEEN 1 AND 720);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
