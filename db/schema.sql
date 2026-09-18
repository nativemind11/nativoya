-- ==========================================================================
-- Nativoya — Database Schema (PostgreSQL)
-- AI-data-training marketplace: Head Leader / Leader / Member, tasks with
-- video walkthrough + audio sample + price, manual payouts (no gateway).
-- ==========================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- --------------------------------------------------------------------------
-- USERS
-- --------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('member', 'leader', 'head_leader');
CREATE TYPE user_gender AS ENUM ('male', 'female');

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name        TEXT NOT NULL,
  email             TEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  whatsapp_number   TEXT,
  country           TEXT,                 -- selected from a fixed dropdown list
  gender            user_gender,          -- selected at signup (ذكر / أنثى)
  payout_identifier TEXT,                 -- default account/number for task payouts (InstaPay, Vodafone Cash, PayPal email...)
  reset_token_hash       TEXT,            -- sha256 of the raw "forgot password" token (never store the raw token)
  reset_token_expires_at TIMESTAMPTZ,     -- reset link expires 1 hour after it's requested
  role              user_role NOT NULL DEFAULT 'member',
  reputation_score  INTEGER NOT NULL DEFAULT 100,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- LANGUAGE GROUPS (auto-numbered per language/dialect, e.g. French Group #7)
-- --------------------------------------------------------------------------
CREATE TABLE groups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  language      TEXT NOT NULL,
  group_number  INTEGER NOT NULL,          -- auto-incremented per language
  leader_id     UUID REFERENCES users(id),
  drive_folder_id TEXT,                    -- linked Google Drive folder
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (language, group_number)
);

-- --------------------------------------------------------------------------
-- USER <-> GROUP membership (many-to-many): a user picks every language/
-- dialect they speak at signup and is auto-joined into a group for each one.
-- A leader also has one row here for the group they lead.
-- --------------------------------------------------------------------------
CREATE TABLE user_groups (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, group_id)
);

-- --------------------------------------------------------------------------
-- LEADER REQUESTS — becoming a leader needs head_leader approval; picking a
-- language as a regular member never does.
-- --------------------------------------------------------------------------
CREATE TYPE leader_request_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE leader_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  language      TEXT NOT NULL,
  status        leader_request_status NOT NULL DEFAULT 'pending',
  decided_by    UUID REFERENCES users(id),   -- the head_leader who approved/rejected
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_leader_requests_status ON leader_requests(status);

-- --------------------------------------------------------------------------
-- SKILLS (the task/skill categories a member can offer and be assigned)
-- --------------------------------------------------------------------------
CREATE TABLE services (
  slug  TEXT PRIMARY KEY,   -- voice_recording | transcription | data_annotation | translation | subtitling | dubbing | conversational_data | copywriting_nlp
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  icon  TEXT NOT NULL DEFAULT '🧩'
);

INSERT INTO services (slug, name_ar, name_en, icon) VALUES
  ('voice_recording',     'تسجيل صوتي',        'Voice Recording',      '🎙️'),
  ('transcription',       'تفريغ نصي',         'Transcription',        '📝'),
  ('data_annotation',     'توسيم بيانات',      'Data Annotation',      '🏷️'),
  ('translation',         'ترجمة',             'Translation',          '🌐'),
  ('subtitling',          'ترجمة أفلام',       'Subtitling',           '🎬'),
  ('dubbing',             'دبلجة',             'Dubbing',              '🔊'),
  ('conversational_data', 'بيانات محادثة',     'Conversational Data',  '💬'),
  ('copywriting_nlp',     'كتابة محتوى / NLP', 'Copywriting / NLP',    '✍️');

-- which skills each user offers (selected at signup, editable later)
CREATE TABLE user_skills (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_slug  TEXT NOT NULL REFERENCES services(slug),
  PRIMARY KEY (user_id, skill_slug)
);

-- --------------------------------------------------------------------------
-- TASKS (published by head_leader; either to ALL groups, or to specific
-- groups only) — each task carries a walkthrough video, an audio sample,
-- and a price so a member can decide before taking it.
-- --------------------------------------------------------------------------
CREATE TYPE task_status AS ENUM ('open', 'claimed', 'in_review', 'completed', 'rejected');

CREATE TABLE tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_slug      TEXT NOT NULL REFERENCES services(slug),
  title           TEXT NOT NULL,
  instructions    TEXT,
  video_urls      TEXT[] NOT NULL DEFAULT '{}',        -- one or more walkthrough videos
  audio_sample_urls TEXT[] NOT NULL DEFAULT '{}',       -- one or more example audio samples
  member_price    NUMERIC(10,2),                          -- per-unit price for regular members (base groups AND leader-invite groups alike)
  leader_price    NUMERIC(10,2),                          -- per-unit price for leaders — usually higher; head_leader sets/sees both
  currency        TEXT NOT NULL DEFAULT 'USD',
  total_quantity  INTEGER NOT NULL,
  male_quantity   INTEGER,                                -- optional split: how many units should come from males
  female_quantity INTEGER,                                -- optional split: how many units should come from females
  target_all      BOOLEAN NOT NULL DEFAULT true,          -- true = every group sees it
  created_by      UUID NOT NULL REFERENCES users(id),     -- head_leader
  drive_folder_id TEXT,                                   -- this task's Google Drive folder
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- when target_all = false, only these groups can see/claim the task
CREATE TABLE task_targets (
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, group_id)
);

-- how much of a task each group/leader has claimed
CREATE TABLE task_claims (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL REFERENCES tasks(id),
  group_id      UUID NOT NULL REFERENCES groups(id),
  claimed_by    UUID NOT NULL REFERENCES users(id), -- leader (or the task's creator, for auto-claims)
  quantity      INTEGER NOT NULL,
  auto_claimed  BOOLEAN NOT NULL DEFAULT false, -- true for the automatic claim a leaderless group gets
  claimed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A leaderless group can only ever get ONE auto-claim per task — this is what
-- actually stops the duplicate-claim bug (an app-level "IF NOT EXISTS" check
-- alone isn't atomic and can still double-insert under quick repeat requests).
-- Real leaders can still claim the same task for their group multiple times
-- (topping up in batches), since this constraint only applies to auto-claims.
CREATE UNIQUE INDEX task_claims_auto_unique ON task_claims (task_id, group_id) WHERE auto_claimed;

-- individual member submissions against a claim
CREATE TABLE submissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_claim_id UUID NOT NULL REFERENCES task_claims(id),
  submitted_by  UUID NOT NULL REFERENCES users(id), -- member
  file_url      TEXT,                                -- Google Drive file link
  status        task_status NOT NULL DEFAULT 'in_review',
  rejection_reason TEXT,                              -- shown to the member when a leader/head_leader rejects their submission
  reviewed_by   UUID REFERENCES users(id),           -- leader who approved
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- PAYMENTS — MANUAL payout (InstaPay / Vodafone Cash / etc.), no gateway
-- --------------------------------------------------------------------------
CREATE TYPE payout_method AS ENUM (
  'instapay', 'vodafone_cash', 'etisalat_cash', 'syriatel_cash', 'sham_cash', 'paypal'
);
CREATE TYPE payment_status AS ENUM ('pending', 'transferred');

CREATE TABLE payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id        UUID NOT NULL REFERENCES users(id),  -- the leader being paid
  amount              NUMERIC(10,2) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'EGP',
  payout_method       payout_method NOT NULL,
  payout_identifier   TEXT NOT NULL,                        -- phone number / PayPal email
  status              payment_status NOT NULL DEFAULT 'pending',
  released_by         UUID REFERENCES users(id),            -- head_leader who clicked "Transferred"
  released_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- GOOGLE DRIVE — one connected account (the head_leader's) owns the Drive
-- that every task's submission folder lives in. Folder naming convention:
--   • member under a Leader's group  -> "<task title> - <leader first name>"
--   • member under Head Leader group -> "<member first name> - <year>"
-- (applied by the app when creating/uploading into the task's folder)
-- --------------------------------------------------------------------------
CREATE TABLE google_auth (
  id              SERIAL PRIMARY KEY,
  account_email   TEXT NOT NULL,
  access_token    TEXT,
  refresh_token   TEXT NOT NULL,
  expiry_date     BIGINT,
  root_folder_id  TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- CERTIFICATES
-- --------------------------------------------------------------------------
CREATE TABLE certificates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  service_slug  TEXT NOT NULL REFERENCES services(slug),
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Indexes
-- --------------------------------------------------------------------------
CREATE INDEX idx_user_groups_user ON user_groups(user_id);
CREATE INDEX idx_user_groups_group ON user_groups(group_id);
CREATE INDEX idx_user_skills_user ON user_skills(user_id);
CREATE INDEX idx_tasks_skill ON tasks(skill_slug);
CREATE INDEX idx_task_targets_group ON task_targets(group_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_task_claims_group ON task_claims(group_id);
