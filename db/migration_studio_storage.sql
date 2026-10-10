-- ==========================================================================
-- Migration: storage management (free Google Drive = ~15 GB, so audio can't
-- stay on Drive forever). Run ONCE in the Supabase SQL Editor, AFTER
-- migration_studio_expiry.sql. Safe to re-run.
--
-- The idea: the head leader downloads each delivered big ZIP to his own
-- device and confirms it (downloaded_at). Only then may the system delete
-- the duplicate copies from Drive. Nothing is ever deleted before that.
-- ==========================================================================

-- 1) the head leader's "I downloaded this ZIP" confirmation, and whether the
--    big ZIP itself was later removed from Drive to free space
ALTER TABLE studio_delivery_batches ADD COLUMN IF NOT EXISTS downloaded_at TIMESTAMPTZ;
ALTER TABLE studio_delivery_batches ADD COLUMN IF NOT EXISTS zip_purged_at TIMESTAMPTZ;

-- 2) per-session bookkeeping
--    files_on_drive    : the working clips + the session ZIP still exist on Drive
--    audio_purged_at   : high-water mark. Clips recorded BEFORE this moment were
--                        deleted from Drive; only clips recorded after it exist.
--                        A re-submission therefore contains only those clips.
--    zip_partial_count : NULL = the session ZIP holds every recording;
--                        N    = it is a partial re-delivery with only N recordings
ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS files_on_drive    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS audio_purged_at   TIMESTAMPTZ;
ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS zip_partial_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_recording_sessions_purgeable
  ON recording_sessions(delivery_batch_id) WHERE status = 'approved' AND files_on_drive;
