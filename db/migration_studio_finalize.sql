-- "Finish task for good" button (head leader): when a task is completely done
-- (all feedback closed, everything delivered + downloaded) the head leader can
-- delete every file of that task from storage (Google Drive / R2) in one click.
--   finalized_at         : the head leader pressed the button (the task is closed from then on)
--   storage_cleared_at   : every file of the task is gone from storage
--   storage_freed_bytes  : how much space that freed (as far as it could be measured)
-- The database rows (names, numbers, statuses) are kept, so history and the
-- Excel sheets still work — only the audio / ZIP files are deleted.
ALTER TABLE recording_tasks ADD COLUMN IF NOT EXISTS finalized_at        TIMESTAMPTZ;
ALTER TABLE recording_tasks ADD COLUMN IF NOT EXISTS storage_cleared_at  TIMESTAMPTZ;
ALTER TABLE recording_tasks ADD COLUMN IF NOT EXISTS storage_freed_bytes BIGINT;
