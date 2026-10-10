-- ==========================================================================
-- Migration: rework deadline is ENFORCED — when the 12 hours pass without the
-- talent re-submitting, the session is withdrawn ("expired"), the fake name is
-- released and the slot is open again for anyone (male or female) on the same
-- task. Run ONCE in the Supabase SQL Editor (after migration_studio_feedback.sql).
-- Safe to re-run.
-- ==========================================================================

-- 1) a new session state + audit columns
ALTER TABLE recording_sessions DROP CONSTRAINT IF EXISTS recording_sessions_status_check;
ALTER TABLE recording_sessions ADD CONSTRAINT recording_sessions_status_check
  CHECK (status IN ('in_progress','submitted','reviewing','approved','rejected','expired'));

ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

-- Only deadlines created by the new code are enforced. Sessions that were
-- rejected BEFORE this migration keep their old, informational-only deadline —
-- otherwise the first request after deploying would withdraw every session
-- that was rejected days ago, when nobody was told a deadline was real.
ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS rework_enforced BOOLEAN NOT NULL DEFAULT false;

-- 2) the fake-name lock ignores withdrawn sessions
-- (was: UNIQUE (task_id, fake_name) — a name could never come back).
-- The withdrawn session keeps its name for the audit trail and for the ZIPs
-- that were already delivered under it.
ALTER TABLE recording_sessions DROP CONSTRAINT IF EXISTS recording_sessions_task_id_fake_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_recording_sessions_live_fake_name
  ON recording_sessions(task_id, fake_name) WHERE status <> 'expired';

-- 3) feedback items can expire with their session
ALTER TABLE studio_feedback_items DROP CONSTRAINT IF EXISTS studio_feedback_items_status_check;
ALTER TABLE studio_feedback_items ADD CONSTRAINT studio_feedback_items_status_check
  CHECK (status IN ('pending','acknowledged','reworked','expired'));

CREATE INDEX IF NOT EXISTS idx_recording_sessions_rework_due
  ON recording_sessions(rework_deadline) WHERE status = 'rejected' AND rework_enforced;
