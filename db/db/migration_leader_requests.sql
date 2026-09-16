-- ==========================================================================
-- Migration: leader_requests table (leadership now needs head_leader approval)
-- Run this ONCE in the Supabase SQL Editor on the database you already set
-- up — schema.sql already includes this for anyone setting up fresh.
-- ==========================================================================

CREATE TYPE leader_request_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE leader_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  language      TEXT NOT NULL,
  status        leader_request_status NOT NULL DEFAULT 'pending',
  decided_by    UUID REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_leader_requests_status ON leader_requests(status);
