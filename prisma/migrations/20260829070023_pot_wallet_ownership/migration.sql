-- Teach `wallets_ownership_matches_type` about POT wallets.
--
-- The original constraint predates group pots and allowed exactly two shapes:
-- a USER wallet with an owner, or a SYSTEM wallet without one. A POT wallet is
-- a third legitimate shape — it holds real money (so it is NOT exempt from the
-- non-negative check the way SYSTEM is) but has no owning user, because it
-- belongs to a group rather than a person.
--
-- Dropped and recreated rather than loosened: the constraint should still
-- reject a POT wallet that somehow acquired an owner, since that would make
-- group money spendable from one member's account.
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_ownership_matches_type;

ALTER TABLE wallets
  ADD CONSTRAINT wallets_ownership_matches_type
  CHECK (
       (type = 'USER'   AND user_id IS NOT NULL)
    OR (type = 'POT'    AND user_id IS NULL)
    OR (type = 'SYSTEM' AND user_id IS NULL)
  );
