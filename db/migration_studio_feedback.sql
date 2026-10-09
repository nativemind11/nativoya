-- ==========================================================================
-- Migration: Phase 7 — targeted feedback from the buyer's Excel.
-- Run ONCE in the Supabase SQL Editor (after migration_studio_delivery.sql).
-- Safe to re-run.
-- ==========================================================================

-- 1) Immutable delivery history ------------------------------------------
-- A delivered batch must keep showing exactly what was delivered. Before this
-- the archive was rebuilt from recording_sessions.delivery_batch_id, but
-- feedback sends a session back for rework (that pointer is cleared so the
-- session can be delivered again later) — which would silently shrink an old
-- batch. This table is the permanent record of which sessions (and which ZIP
-- file name) each batch contained at the moment it was collected.
CREATE TABLE IF NOT EXISTS studio_delivery_batch_sessions (
  batch_id       UUID NOT NULL REFERENCES studio_delivery_batches(id) ON DELETE CASCADE,
  session_id     UUID NOT NULL REFERENCES recording_sessions(id),
  zip_file_name  TEXT,
  PRIMARY KEY (batch_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_sessions_session ON studio_delivery_batch_sessions(session_id);

-- batches collected before this migration existed
INSERT INTO studio_delivery_batch_sessions (batch_id, session_id, zip_file_name)
SELECT rs.delivery_batch_id, rs.id, rs.zip_file_name
FROM recording_sessions rs
JOIN studio_delivery_batches b ON b.id = rs.delivery_batch_id AND b.status = 'delivered'
ON CONFLICT DO NOTHING;

-- 2) Feedback items --------------------------------------------------------
-- studio_feedback_items already exists (migration_studio.sql). Recording
-- numbers are 1-BASED, exactly as the talent and the ZIP files number them
-- ("03.wav" = recording 3).
ALTER TABLE studio_feedback_items ADD COLUMN IF NOT EXISTS upload_id         UUID;                 -- groups the rows of one Excel upload
ALTER TABLE studio_feedback_items ADD COLUMN IF NOT EXISTS source_row        INTEGER;              -- row number in the Excel file
ALTER TABLE studio_feedback_items ADD COLUMN IF NOT EXISTS previous_batch_id UUID REFERENCES studio_delivery_batches(id); -- batch it had been delivered in
ALTER TABLE studio_feedback_items ADD COLUMN IF NOT EXISTS reworked_at       TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_feedback_items_session ON studio_feedback_items(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_items_status  ON studio_feedback_items(status, rework_deadline);
