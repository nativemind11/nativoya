-- ==========================================================================
-- Migration: named audio samples. Run this ONCE in the Supabase SQL Editor
-- on the database you already set up — schema.sql already includes this
-- for anyone setting up fresh.
-- ==========================================================================

-- Each task can carry several example audio samples (audio_sample_urls).
-- This adds a parallel array of titles, matched by index, so a task with
-- multiple samples can label each one (e.g. "مثال ١ — نبرة هادئة") instead
-- of showing a bare, unlabeled row of players. A title is optional per
-- sample — an empty string at that index just means that one has no title.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS audio_sample_titles TEXT[] NOT NULL DEFAULT '{}';
