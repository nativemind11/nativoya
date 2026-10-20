-- Studio v3 — a different script for every talent, upload-your-own CODES instead of fake names,
-- and "direct" tasks (no leader). Safe to run more than once. Run it BEFORE uploading the new backend.

-- ---------------------------------------------------------------- task modes
ALTER TABLE recording_tasks ADD COLUMN IF NOT EXISTS script_mode   TEXT    NOT NULL DEFAULT 'shared';  -- 'shared' = one script for all, 'per_person' = one script file per talent
ALTER TABLE recording_tasks ADD COLUMN IF NOT EXISTS identity_mode TEXT    NOT NULL DEFAULT 'names';   -- 'names' = fake names pool, 'codes' = codes uploaded per gender
ALTER TABLE recording_tasks ADD COLUMN IF NOT EXISTS direct        BOOLEAN NOT NULL DEFAULT false;     -- true = no leader: talents join straight from the task
ALTER TABLE recording_tasks ADD COLUMN IF NOT EXISTS identity_codes JSONB;                               -- {"male":[...],"female":[...]} when identity_mode = 'codes'
DO $$ BEGIN
  ALTER TABLE recording_tasks ADD CONSTRAINT recording_tasks_script_mode_chk   CHECK (script_mode   IN ('shared', 'per_person'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE recording_tasks ADD CONSTRAINT recording_tasks_identity_mode_chk CHECK (identity_mode IN ('names', 'codes'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- one row per script file
CREATE TABLE IF NOT EXISTS studio_task_scripts (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id  UUID NOT NULL REFERENCES recording_tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  filename TEXT,
  UNIQUE (task_id, position)
);

-- sentences of a per-person task belong to ONE script (script_id); NULL = the task's shared script (all old tasks)
ALTER TABLE recording_samples  ADD COLUMN IF NOT EXISTS script_id UUID REFERENCES studio_task_scripts(id) ON DELETE CASCADE;
ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS script_id UUID REFERENCES studio_task_scripts(id);
CREATE INDEX IF NOT EXISTS idx_recording_samples_task_script ON recording_samples (task_id, script_id, order_index);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_script ON recording_sessions (script_id) WHERE script_id IS NOT NULL;

-- ---------------------------------------------------------------- the hidden leader of "direct" tasks
-- recording_sessions.leader_id is NOT NULL and many queries join studio_leaders, so a direct task's sessions
-- hang on one system leader. It can never log in (inactive, no usable password) and is hidden from leader lists.
ALTER TABLE studio_leaders ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
INSERT INTO studio_leaders (name, email, password_hash, leader_code, is_system, is_active)
SELECT 'Direct (system)', 'direct@system.invalid', '!no-login', 'DIRECT', true, false
WHERE NOT EXISTS (SELECT 1 FROM studio_leaders WHERE is_system);
