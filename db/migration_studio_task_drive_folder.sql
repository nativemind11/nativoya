-- Small addendum to migration_studio.sql — run this too (safe to re-run).
-- Each task gets ONE root Drive folder (created when it's published). The
-- per-leader-code subfolders (QA Reviews / Approved Male / Approved Female)
-- are created lazily inside it later, when the first talent submits under
-- that leader — see Phase 3/4.
ALTER TABLE recording_tasks ADD COLUMN IF NOT EXISTS drive_root_folder_id TEXT;
