-- "Forgot password" support for ALL studio account types (talent, leader,
-- qa, head_leader) — same pattern as the main site's reset flow.
ALTER TABLE studio_talents ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE studio_talents ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;

ALTER TABLE studio_leaders ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE studio_leaders ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;

ALTER TABLE studio_qa_reviewers ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE studio_qa_reviewers ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;

ALTER TABLE studio_head_leaders ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE studio_head_leaders ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;
