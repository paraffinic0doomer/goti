-- ============================================================================
--  Goti hardening — safety features
--
--  Constraints for emergency freeze, group pots and expense envelopes.
--  Same principle as the original hardening: the application produces good
--  error messages, and THESE guarantee the invariant holds even when the
--  application is wrong.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  1. RESERVED CAPACITY — the envelope invariant
-- ----------------------------------------------------------------------------

-- THE constraint for expense envelopes. Spendable balance is
-- `balance_poisha - reserved_poisha`, so reserved must never exceed the balance
-- or spendable would go negative and the debit guard would refuse everything.
--
-- SYSTEM wallets are exempt from the upper bound because their balance is
-- legitimately negative (the genesis account). They never reserve anything, so
-- the lower bound still applies.
ALTER TABLE wallets
  ADD CONSTRAINT wallets_reserved_non_negative
  CHECK (reserved_poisha >= 0);

ALTER TABLE wallets
  ADD CONSTRAINT wallets_reserved_within_balance
  CHECK (type = 'SYSTEM' OR reserved_poisha <= balance_poisha);

-- An envelope cannot hold a negative reservation.
ALTER TABLE expense_envelopes
  ADD CONSTRAINT expense_envelopes_reserved_non_negative
  CHECK (reserved_poisha >= 0);

ALTER TABLE expense_envelopes
  ADD CONSTRAINT expense_envelopes_target_positive
  CHECK (target_poisha IS NULL OR target_poisha > 0);

-- ----------------------------------------------------------------------------
--  2. FREEZE METADATA CONSISTENCY
-- ----------------------------------------------------------------------------

-- A frozen wallet must say WHY, and an active one must not carry a stale
-- reason. Without this, "frozen with no explanation" is reachable — and that is
-- a support call with nothing to work from.
ALTER TABLE wallets
  ADD CONSTRAINT wallets_freeze_metadata_matches_status
  CHECK (
    (status IN ('FROZEN', 'UNDER_REVIEW') AND freeze_reason IS NOT NULL AND frozen_at IS NOT NULL)
    OR (status IN ('ACTIVE', 'CLOSED') AND freeze_reason IS NULL AND frozen_at IS NULL)
  );

-- A security event must actually record a change.
ALTER TABLE wallet_security_events
  ADD CONSTRAINT wallet_security_events_status_changed
  CHECK (previous_status <> new_status);

-- Append-only: the security trail is evidence, and evidence that can be edited
-- is not evidence.
CREATE OR REPLACE FUNCTION goti_reject_security_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'wallet_security_events is append-only: % rejected', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_security_events_immutable ON wallet_security_events;
CREATE TRIGGER trg_wallet_security_events_immutable
  BEFORE UPDATE OR DELETE ON wallet_security_events
  FOR EACH ROW EXECUTE FUNCTION goti_reject_security_event_mutation();

-- ----------------------------------------------------------------------------
--  3. POTS
-- ----------------------------------------------------------------------------

ALTER TABLE pots
  ADD CONSTRAINT pots_target_positive
  CHECK (target_poisha > 0);

-- Only a settled pot references a payout, and it must.
ALTER TABLE pots
  ADD CONSTRAINT pots_settlement_matches_status
  CHECK (
    (status = 'SETTLED' AND settlement_transaction_id IS NOT NULL AND settled_at IS NOT NULL)
    OR (status <> 'SETTLED' AND settlement_transaction_id IS NULL AND settled_at IS NULL)
  );

-- A pot's wallet must be a POT wallet. Pointing a pot at a user's personal
-- wallet would make every contribution land in that person's balance.
CREATE OR REPLACE FUNCTION goti_assert_pot_wallet_type()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  wallet_type text;
BEGIN
  SELECT type INTO wallet_type FROM wallets WHERE id = NEW.wallet_id;
  IF wallet_type <> 'POT' THEN
    RAISE EXCEPTION 'Pot % points at a % wallet; it must be a POT wallet.', NEW.id, wallet_type
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pots_wallet_type ON pots;
CREATE TRIGGER trg_pots_wallet_type
  BEFORE INSERT OR UPDATE OF wallet_id ON pots
  FOR EACH ROW EXECUTE FUNCTION goti_assert_pot_wallet_type();

ALTER TABLE pot_members
  ADD CONSTRAINT pot_members_contribution_non_negative
  CHECK (contributed_poisha >= 0 AND contribution_count >= 0);

-- ----------------------------------------------------------------------------
--  4. PARTIAL INDEXES — background jobs and support queues
-- ----------------------------------------------------------------------------

-- Wallets needing attention. Tiny: almost every wallet is ACTIVE.
CREATE INDEX IF NOT EXISTS idx_wallets_frozen
  ON wallets (status, frozen_at DESC)
  WHERE status IN ('FROZEN', 'UNDER_REVIEW');

-- Wallets with money fenced off — the reconciler cross-checks these against
-- the sum of their envelopes.
CREATE INDEX IF NOT EXISTS idx_wallets_with_reservations
  ON wallets (id)
  WHERE reserved_poisha > 0;

-- Pots still collecting. Settled pots are the majority over time.
CREATE INDEX IF NOT EXISTS idx_pots_collecting
  ON pots (created_at DESC)
  WHERE status IN ('OPEN', 'FUNDED');

-- ----------------------------------------------------------------------------
--  5. RECONCILIATION — envelopes must match the wallet aggregate
-- ----------------------------------------------------------------------------

-- `wallets.reserved_poisha` is a denormalised sum of this wallet's envelopes.
-- Denormalised numbers drift; this view is how drift is DETECTED rather than
-- discovered by a confused user whose spendable balance is wrong.
--
-- Same role as `wallet_balance_drift`, for the reservation aggregate.
CREATE OR REPLACE VIEW wallet_reservation_drift AS
SELECT
  w.id                                              AS wallet_id,
  w.user_id,
  w.reserved_poisha                                 AS aggregate_reserved_poisha,
  COALESCE(SUM(e.reserved_poisha), 0)::bigint       AS envelope_sum_poisha,
  w.reserved_poisha - COALESCE(SUM(e.reserved_poisha), 0)::bigint AS drift_poisha,
  COUNT(e.id)                                       AS envelope_count
FROM wallets w
LEFT JOIN expense_envelopes e ON e.wallet_id = w.id
GROUP BY w.id, w.user_id, w.reserved_poisha
HAVING w.reserved_poisha <> COALESCE(SUM(e.reserved_poisha), 0)::bigint;

COMMENT ON VIEW wallet_reservation_drift IS
  'Wallets whose reserved_poisha disagrees with the sum of their envelopes. MUST be empty.';

-- A pot's balance is its wallet's balance, so pot money is already covered by
-- ledger_conservation_check. This view is the per-member breakdown check: the
-- sum of member contributions should match what the pot wallet received.
CREATE OR REPLACE VIEW pot_contribution_drift AS
SELECT
  p.id                                              AS pot_id,
  p.name,
  w.balance_poisha                                  AS pot_wallet_balance_poisha,
  COALESCE(SUM(m.contributed_poisha), 0)::bigint    AS member_total_poisha,
  w.balance_poisha - COALESCE(SUM(m.contributed_poisha), 0)::bigint AS drift_poisha
FROM pots p
JOIN wallets w ON w.id = p.wallet_id
LEFT JOIN pot_members m ON m.pot_id = p.id
WHERE p.status <> 'SETTLED'
GROUP BY p.id, p.name, w.balance_poisha
HAVING w.balance_poisha <> COALESCE(SUM(m.contributed_poisha), 0)::bigint;

COMMENT ON VIEW pot_contribution_drift IS
  'Unsettled pots where member contribution totals disagree with the pot wallet balance. Display-level drift only — the wallet is always authoritative.';

-- ----------------------------------------------------------------------------
--  6. GRANTS
-- ----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON pots             TO goti_app;
GRANT SELECT, INSERT, UPDATE ON pot_members      TO goti_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON expense_envelopes TO goti_app;

-- Append and read only. No UPDATE, no DELETE — the freeze trail is evidence.
GRANT SELECT, INSERT ON wallet_security_events TO goti_app;

GRANT SELECT ON wallet_reservation_drift, pot_contribution_drift TO goti_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO goti_app;

-- ----------------------------------------------------------------------------
--  7. TABLE COMMENTS
-- ----------------------------------------------------------------------------

COMMENT ON TABLE wallet_security_events IS
  'Append-only freeze/unfreeze history. wallets.status is the current state; this is how it got there.';
COMMENT ON TABLE pots IS
  'Group money collection. The pot OWNS a POT wallet — its balance is a wallet balance, never a counter.';
COMMENT ON TABLE pot_members IS
  'Membership plus a per-member contribution breakdown. Never the source of the pot balance.';
COMMENT ON TABLE expense_envelopes IS
  'Reserved spending capacity. Moves NO money — it constrains the debit, it does not relocate funds.';
COMMENT ON COLUMN wallets.reserved_poisha IS
  'Sum of this wallet''s envelope reservations. Read by the conditional atomic debit: spendable = balance - reserved.';
