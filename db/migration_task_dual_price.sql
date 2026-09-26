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
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS member_price NUMERIC(10,2);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS leader_price NUMERIC(10,2);

-- Backfill: on a database that already had an old single `price` column,
-- carry it into both new columns so existing tasks don't regress. Guarded
-- with a column-existence check so this stays safe to run even on a database
-- that never had a `price` column at all.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'price'
  ) THEN
    UPDATE tasks SET member_price = price, leader_price = price WHERE price IS NOT NULL;
  END IF;
END $$;

-- If an old `price` column exists, it's left in place (harmless — nothing
-- reads or writes it anymore after this migration) so this stays a safe,
-- reversible change. Drop it later in a follow-up migration once you've
-- confirmed everything looks right:
--   ALTER TABLE tasks DROP COLUMN price;
