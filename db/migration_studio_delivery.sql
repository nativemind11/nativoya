-- ==========================================================================
-- Migration: Head Leader delivery dashboard (Phase 6).
-- Run ONCE in the Supabase SQL Editor. Safe to re-run.
-- ==========================================================================

-- One row per "Collect" the head leader performs: a group of approved
-- sessions (same task + gender + QA reviewer + review day) merged into a
-- single big ZIP on Drive. Delivered batches are the permanent archive —
-- they are never deleted, and their sheet can be re-downloaded any time.
CREATE TABLE IF NOT EXISTS studio_delivery_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES recording_tasks(id),
  gender          TEXT NOT NULL CHECK (gender IN ('male','female')),
  qa_reviewer_id  UUID REFERENCES studio_qa_reviewers(id),  -- NULL = approved before reviewers were tracked
  group_day       DATE NOT NULL,                            -- review day (Africa/Cairo) the group was built from
  status          TEXT NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting','delivered','failed')),
  session_count   INTEGER NOT NULL DEFAULT 0,
  zip_file_name   TEXT,
  zip_file_url    TEXT,
  zip_size_bytes  BIGINT,
  error           TEXT,
  collected_by    UUID REFERENCES studio_head_leaders(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ
);

-- A session is "waiting for delivery" while approved AND delivery_batch_id IS NULL.
-- Claiming it for a batch is an atomic UPDATE, so a double-click (or two
-- head leaders at once) can never collect the same sessions twice.
ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS delivery_batch_id UUID REFERENCES studio_delivery_batches(id);

CREATE INDEX IF NOT EXISTS idx_recording_sessions_delivery ON recording_sessions(delivery_batch_id);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_pending_delivery
  ON recording_sessions(task_id, gender, qa_reviewer_id) WHERE status = 'approved' AND delivery_batch_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_batches_status ON studio_delivery_batches(status, created_at DESC);
