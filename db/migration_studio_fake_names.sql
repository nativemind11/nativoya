-- Addendum: the pool of fake names a talent picks from for a task (a
-- separate .txt file from the sentences script). Safe to re-run.
ALTER TABLE recording_tasks ADD COLUMN IF NOT EXISTS fake_names TEXT[] NOT NULL DEFAULT '{}';
