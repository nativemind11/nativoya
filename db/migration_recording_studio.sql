-- ==========================================================================
-- Nativoya — Recording Studio + QA System Migration
-- Adds: recording settings, scripts, sessions, QA reviews
-- ==========================================================================

-- 1. Add recording settings and script columns to tasks table
ALTER TABLE tasks 
ADD COLUMN recording_settings JSONB,
ADD COLUMN instructions_script_url TEXT,
ADD COLUMN instructions_script_name TEXT;

-- 2. Recording Scripts table — stores the text scripts for voice recording tasks
CREATE TABLE recording_scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  script_url TEXT NOT NULL,           -- Google Drive link to the script file
  script_name TEXT NOT NULL,          -- Original filename
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Recording Sessions table — temporary storage for ongoing recording sessions
CREATE TABLE recording_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_claim_id UUID NOT NULL REFERENCES task_claims(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress, completed
  audio_files JSONB NOT NULL DEFAULT '[]',     -- Array of {filename, url, duration}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  UNIQUE(user_id, task_claim_id)
);

-- 4. QA Reviews table — head_leader reviews submissions before final approval
CREATE TABLE qa_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES users(id),  -- head_leader
  status TEXT NOT NULL DEFAULT 'pending',          -- pending, approved, rejected
  feedback TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Add QA status column to submissions
ALTER TABLE submissions 
ADD COLUMN qa_status TEXT DEFAULT 'pending';  -- pending, under_review, approved_by_qa, rejected_by_qa

-- 6. Indexes for performance
CREATE INDEX idx_recording_sessions_user ON recording_sessions(user_id);
CREATE INDEX idx_recording_sessions_claim ON recording_sessions(task_claim_id);
CREATE INDEX idx_recording_sessions_status ON recording_sessions(status);
CREATE INDEX idx_qa_reviews_reviewer ON qa_reviews(reviewer_id);
CREATE INDEX idx_qa_reviews_status ON qa_reviews(status);
CREATE INDEX idx_submissions_qa_status ON submissions(qa_status);

-- 7. Insert default recording services if not exists (for clarity)
INSERT INTO services (slug, name_ar, name_en, icon) 
VALUES ('voice_recording', 'تسجيل صوتي', 'Voice Recording', '🎙️')
ON CONFLICT DO NOTHING;
