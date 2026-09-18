-- ==========================================================================
-- Migration: split tasks.price into member_price / leader_price. Run this
-- ONCE in the Supabase SQL Editor on the database you already set up —
-- schema.sql already includes this for anyone setting up fresh.
-- ==========================================================================

-- A task now carries TWO per-unit prices, both set by the head_leader when
-- publishing/editing it:
--   • member_price — paid to regular members, whether they're in a base
--     (no-leader) group OR a leader's invite-link group. Role is what
--     decides this, not which group the member sits in.
--   • leader_price — paid to leader accounts (usually higher, to reflect
--     the extra review/coordination work).
-- The head_leader always sets/sees both. Everyone else is shown only the
-- one that matches their own account role.
ALTER TABLE tasks ADD COLUMN member_price NUMERIC(10,2);
ALTER TABLE tasks ADD COLUMN leader_price NUMERIC(10,2);

-- Backfill: every task published before this migration only had one price —
-- apply it to both columns so nothing regresses for existing tasks.
UPDATE tasks SET member_price = price, leader_price = price WHERE price IS NOT NULL;

-- The old single `price` column is left in place (harmless — nothing reads
-- or writes it anymore after this migration) so this stays a safe, reversible
-- change. Drop it later in a follow-up migration once you've confirmed
-- everything looks right:
--   ALTER TABLE tasks DROP COLUMN price;
