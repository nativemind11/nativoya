-- ==========================================================================
-- Nativoya — Database Schema (PostgreSQL)
-- Adapted from NativeMind_Full_Spec.md section 4, with the payments table
-- redesigned for MANUAL payouts (InstaPay/Vodafone Cash/etc.) instead of
-- an automated Paymob integration.
-- ==========================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- --------------------------------------------------------------------------
-- USERS
-- --------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('member', 'leader', 'head_leader', 'tourist');

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name        TEXT NOT NULL,
  email             TEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  whatsapp_number   TEXT,
  country           TEXT,
  role              user_role NOT NULL DEFAULT 'member',
  language          TEXT,                 -- native language, e.g. "French"
  group_id          UUID,                 -- FK added below, after groups table exists
  reputation_score  INTEGER NOT NULL DEFAULT 100,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- LANGUAGE GROUPS (auto-numbered per language, e.g. French Group #7)
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

ALTER TABLE users
  ADD CONSTRAINT fk_users_group FOREIGN KEY (group_id) REFERENCES groups(id);

-- --------------------------------------------------------------------------
-- SERVICES (the 6 fixed service types)
-- --------------------------------------------------------------------------
CREATE TABLE services (
  slug  TEXT PRIMARY KEY,   -- tour-guides | translation | transcription | dubbing | annotation | subtitling
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL
);

INSERT INTO services (slug, name_ar, name_en) VALUES
  ('tour-guides',   'مرشدين سياحيين', 'Tour Guides'),
  ('translation',   'ترجمة',          'Translation'),
  ('transcription', 'تفريغ صوتي',     'Transcription'),
  ('dubbing',       'دبلجة',          'Dubbing'),
  ('annotation',    'توسيم بيانات',   'Annotation'),
  ('subtitling',    'ترجمة أفلام',    'Subtitling');

-- --------------------------------------------------------------------------
-- TASKS (published by head_leader, claimed by leaders for their group)
-- --------------------------------------------------------------------------
CREATE TYPE task_status AS ENUM ('open', 'claimed', 'in_review', 'completed');

CREATE TABLE tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_slug    TEXT NOT NULL REFERENCES services(slug),
  title           TEXT NOT NULL,
  instructions    TEXT,
  total_quantity  INTEGER NOT NULL,
  created_by      UUID NOT NULL REFERENCES users(id), -- head_leader
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- how much of a task each group/leader has claimed
CREATE TABLE task_claims (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL REFERENCES tasks(id),
  group_id      UUID NOT NULL REFERENCES groups(id),
  claimed_by    UUID NOT NULL REFERENCES users(id), -- leader
  quantity      INTEGER NOT NULL,
  claimed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- individual member submissions against a claim
CREATE TABLE submissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_claim_id UUID NOT NULL REFERENCES task_claims(id),
  submitted_by  UUID NOT NULL REFERENCES users(id), -- member
  file_url      TEXT,                                -- Google Drive file link
  status        task_status NOT NULL DEFAULT 'in_review',
  reviewed_by   UUID REFERENCES users(id),           -- leader who approved
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- PAYMENTS — redesigned for MANUAL payout (no Paymob)
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
-- CERTIFICATES
-- --------------------------------------------------------------------------
CREATE TABLE certificates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  service_slug  TEXT NOT NULL REFERENCES services(slug),
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- TOUR GUIDE LISTINGS (for the tourist-facing directory)
-- --------------------------------------------------------------------------
CREATE TABLE guide_listings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  bio           TEXT,
  cities        TEXT[],           -- e.g. {"Cairo","Luxor"}
  languages     TEXT[],
  rating        NUMERIC(2,1) DEFAULT 5.0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Indexes
-- --------------------------------------------------------------------------
CREATE INDEX idx_users_group ON users(group_id);
CREATE INDEX idx_tasks_service ON tasks(service_slug);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_task_claims_group ON task_claims(group_id);
