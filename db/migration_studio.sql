-- ==========================================================================
-- Nativoya Studio — full schema for the recording studio sub-system.
-- Completely separate from the main site's users/tasks/groups tables:
-- its own account tables (head leaders, leaders, QA reviewers) and its own
-- "talent" sessions that need NO Nativoya account at all — just a fake name
-- reserved against a task.
--
-- Run this ONCE in the Supabase SQL Editor. Safe to re-run (every statement
-- is guarded with IF NOT EXISTS).
-- ==========================================================================

-- ---------------------------------------------------------------------
-- PHASE 1 — accounts
-- ---------------------------------------------------------------------

-- Only ever 2 of these in practice. No public signup — created directly in
-- the database (see the INSERT template at the bottom of this file).
CREATE TABLE IF NOT EXISTS studio_head_leaders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Leaders sign up for the studio themselves — a completely separate account
-- from any Nativoya login they might also have. leader_code (L001, L002...)
-- is what talents pick from, and what every task/session is tagged with.
CREATE TABLE IF NOT EXISTS studio_leaders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  leader_code   TEXT UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Created by a head_leader (not public signup) once the QA phase is wired up.
CREATE TABLE IF NOT EXISTS studio_qa_reviewers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  created_by      UUID REFERENCES studio_head_leaders(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- PHASE 2 — tasks
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recording_tasks (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                 TEXT NOT NULL,
  script_file_url       TEXT,             -- Drive link to the .txt of sentence names
  script_file_name      TEXT,
  head_leader_id        UUID NOT NULL REFERENCES studio_head_leaders(id),
  quantity              INTEGER NOT NULL, -- how many talents wanted in total
  difficulty            TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  recording_settings    JSONB NOT NULL DEFAULT '{"sampleRate":16000,"bitDepth":16,"format":"wav","channels":"mono"}',
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at          TIMESTAMPTZ
);

-- Which leader codes are allowed to work a given task — a task can be
-- opened to several leaders at once, per the head_leader's choice.
CREATE TABLE IF NOT EXISTS recording_task_leaders (
  task_id    UUID NOT NULL REFERENCES recording_tasks(id) ON DELETE CASCADE,
  leader_id  UUID NOT NULL REFERENCES studio_leaders(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, leader_id)
);

-- The individual sentences a talent must record for a task, each with its
-- own reference audio sample to imitate.
CREATE TABLE IF NOT EXISTS recording_samples (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL REFERENCES recording_tasks(id) ON DELETE CASCADE,
  sentence_name TEXT NOT NULL,
  audio_url     TEXT,             -- reference/example audio (Drive link)
  duration      NUMERIC(6,2),
  order_index   INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- PHASE 3 — talent recording sessions (NO Nativoya account involved)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recording_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           UUID NOT NULL REFERENCES recording_tasks(id) ON DELETE CASCADE,
  leader_id         UUID NOT NULL REFERENCES studio_leaders(id), -- which leader code they picked
  session_token     TEXT UNIQUE NOT NULL,  -- opaque token kept in the talent's browser so they can resume
  gender            TEXT NOT NULL CHECK (gender IN ('male','female')),
  age_bracket       TEXT NOT NULL CHECK (age_bracket IN ('child','adult','elderly')),
  age               INTEGER,
  fake_name         TEXT NOT NULL,         -- reserved from the task's name list; visible to QA
  real_name         TEXT,                  -- PRIVATE — only ever shown to the owning leader
  whatsapp          TEXT,                  -- PRIVATE — only ever shown to the owning leader
  status            TEXT NOT NULL DEFAULT 'in_progress'
                      CHECK (status IN ('in_progress','submitted','reviewing','approved','rejected')),
  rejection_reason  TEXT,
  rework_deadline   TIMESTAMPTZ,           -- set to submitted_at + 12h on rejection
  attempt_number    INTEGER NOT NULL DEFAULT 1,
  zip_file_url      TEXT,
  zip_file_name     TEXT,                  -- auto-generated: fake_name-gender-age_bracket-age.zip
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, fake_name)              -- a fake name, once picked for a task, is locked
);

CREATE TABLE IF NOT EXISTS recording_session_samples (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  sample_id       UUID NOT NULL REFERENCES recording_samples(id) ON DELETE CASCADE,
  audio_file_url  TEXT,             -- the talent's actual recording for this sentence
  duration        NUMERIC(6,2),
  retakes         INTEGER NOT NULL DEFAULT 0,
  completed_at    TIMESTAMPTZ,
  UNIQUE (session_id, sample_id)
);

-- ---------------------------------------------------------------------
-- PHASE 4 — QA review
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_qa_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL UNIQUE REFERENCES recording_sessions(id) ON DELETE CASCADE,
  qa_reviewer_id  UUID NOT NULL REFERENCES studio_qa_reviewers(id),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  feedback        TEXT,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per task — the 3 Drive folder ids that make up its structure
-- (submissions awaiting QA, plus approved-male / approved-female).
CREATE TABLE IF NOT EXISTS studio_drive_folders (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id                   UUID NOT NULL UNIQUE REFERENCES recording_tasks(id) ON DELETE CASCADE,
  root_folder_id            TEXT,
  qa_folder_id              TEXT,
  approved_male_folder_id   TEXT,
  approved_female_folder_id TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- PHASE 7 — feedback from the client, routed to the right leader
-- (simplified: no AI/PDF — the head_leader just tells us which columns of
-- their Excel mean what, and we read + route it)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS studio_feedback_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id            UUID NOT NULL REFERENCES recording_tasks(id) ON DELETE CASCADE,
  session_id         UUID REFERENCES recording_sessions(id),   -- resolved from fake_name/zip filename
  leader_id          UUID NOT NULL REFERENCES studio_leaders(id),
  fake_name          TEXT NOT NULL,
  recording_numbers  INTEGER[] NOT NULL,     -- which sample order_index values need a redo
  issue_description  TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','acknowledged','reworked')),
  rework_deadline    TIMESTAMPTZ,            -- created_at + 12h
  created_by         UUID REFERENCES studio_head_leaders(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The Studio reuses the SAME connected Google account as the main site
-- (google_auth table — one head_leader connects it once from the main
-- admin dashboard), just under its own root folder so nothing mixes with
-- regular task submissions.
ALTER TABLE google_auth ADD COLUMN IF NOT EXISTS studio_root_folder_id TEXT;

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_recording_tasks_head_leader ON recording_tasks(head_leader_id);
CREATE INDEX IF NOT EXISTS idx_recording_task_leaders_leader ON recording_task_leaders(leader_id);
CREATE INDEX IF NOT EXISTS idx_recording_samples_task ON recording_samples(task_id);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_task ON recording_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_leader ON recording_sessions(leader_id);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_status ON recording_sessions(status);
CREATE INDEX IF NOT EXISTS idx_session_samples_session ON recording_session_samples(session_id);
CREATE INDEX IF NOT EXISTS idx_qa_reviews_reviewer ON studio_qa_reviews(qa_reviewer_id);
CREATE INDEX IF NOT EXISTS idx_qa_reviews_status ON studio_qa_reviews(status);
CREATE INDEX IF NOT EXISTS idx_feedback_items_leader ON studio_feedback_items(leader_id);
CREATE INDEX IF NOT EXISTS idx_feedback_items_task ON studio_feedback_items(task_id);

-- ---------------------------------------------------------------------
-- One-time setup: create your 2 head_leader accounts.
-- Replace the email/name below, then run ONLY this part with a real
-- bcrypt hash — easiest way: ask Claude to hash a password for you, or
-- temporarily add a throwaway /api/studio/auth/dev-hash route.
-- ---------------------------------------------------------------------
-- INSERT INTO studio_head_leaders (name, email, password_hash) VALUES
--   ('Head Leader 1', 'headleader1@example.com', '$2a$10$REPLACE_WITH_BCRYPT_HASH'),
--   ('Head Leader 2', 'headleader2@example.com', '$2a$10$REPLACE_WITH_BCRYPT_HASH');
