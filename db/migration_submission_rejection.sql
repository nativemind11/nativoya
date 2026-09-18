-- ==========================================================================
-- Migration: submissions can now be REJECTED (not just approved), with a
-- reason the leader/head_leader writes that the member who uploaded it can
-- see. Run this once in the Supabase SQL Editor.
-- ==========================================================================

-- New enum value. Must run as its own statement (Postgres won't let a new
-- enum value be used in the same transaction it was added in) — if you're
-- pasting this whole file into one query at once, run this ALTER first,
-- then the rest below it separately.
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'rejected';

-- The reason a leader/head_leader gives when rejecting a submission — shown
-- to the member so they know what to fix before resubmitting.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
