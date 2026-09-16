-- ==========================================================================
-- Migration: gender + payout identifier on users, male/female target
-- quantity on tasks. Run this ONCE in the Supabase SQL Editor on the
-- database you already set up — schema.sql already includes this for
-- anyone setting up fresh.
-- ==========================================================================

-- signup now collects gender (ذكر / أنثى) and a default payout account/number
-- (InstaPay, Vodafone Cash, PayPal email...) used when the head_leader
-- transfers money for tasks. Both are added as NULLable so existing rows
-- don't break.
CREATE TYPE user_gender AS ENUM ('male', 'female');

ALTER TABLE users ADD COLUMN gender user_gender;
ALTER TABLE users ADD COLUMN payout_identifier TEXT;

-- when a head_leader publishes a task, they can now optionally split the
-- total quantity into how many should be done by males vs. females.
ALTER TABLE tasks ADD COLUMN male_quantity INTEGER;
ALTER TABLE tasks ADD COLUMN female_quantity INTEGER;
