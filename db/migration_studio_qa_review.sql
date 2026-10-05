-- Addendum: per-recording QA decisions (not just one verdict for the whole
-- submission). A session can end up "rejected" with only SOME of its
-- recordings flagged — the talent only has to redo those, not everything.

ALTER TABLE recording_session_samples ADD COLUMN IF NOT EXISTS qa_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (qa_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE recording_session_samples ADD COLUMN IF NOT EXISTS qa_reason TEXT;

ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS qa_reviewer_id UUID REFERENCES studio_qa_reviewers(id);
ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS qa_reviewed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_session_samples_qa_status ON recording_session_samples(qa_status);
