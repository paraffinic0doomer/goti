-- Goti hardening: CHECK constraints, partial indexes, immutability
-- triggers, role grants and reconciliation views.
--
-- Source: prisma/sql/hardening.sql
-- CONCURRENTLY stripped (7 occurrences): the initial deploy runs against
-- empty tables, where a plain CREATE INDEX is instant.

-- ============================================================================
--  Goti — database hardening
--
--  Everything the approved architecture requires that Prisma has no syntax for:
--  CHECK constraints, partial indexes, immutability triggers, column-level
--  grants, and the reconciliation views.
--
--  THE SCHEMA IS NOT CORRECT WITHOUT THIS FILE.
--
--  How to apply
--  ---------------------------------------------------------------------------
--    npx prisma migrate dev --create-only --name hardening
--    # then paste this file into the generated migration.sql
--    npx prisma migrate dev
--
--  This is idempotent where PostgreSQL allows it, so it is safe to re-run
--  while iterating locally.
--
--  Never run `prisma db push` against a database with this applied — push
--  diffs against schema.prisma alone and will drop every object below.
-- ============================================================================


-- ============================================================================
--  1. CHECK CONSTRAINTS — the invariants that must hold even when the
--     application is wrong.
--
--  ARCHITECTURE.md §5: "Four independent guards against a negative balance.
--  The first three produce good error messages; the last one is what
--  guarantees the invariant holds even when the first three are wrong."
--  These are that last guard.
-- ============================================================================

-- --- wallets ---------------------------------------------------------------

-- THE constraint. A user wallet can never go negative, no matter what bug
-- exists above it. SYSTEM wallets are exempt: the genesis account holds the
-- negative of all money ever issued, which is what makes the system-wide
-- ledger sum exactly zero.
ALTER TABLE wallets
  ADD CONSTRAINT wallets_balance_non_negative
  CHECK (balance_poisha >= 0 OR type = 'SYSTEM');

-- A USER wallet must belong to someone; a SYSTEM wallet must not.
ALTER TABLE wallets
  ADD CONSTRAINT wallets_ownership_matches_type
  CHECK ((type = 'USER' AND user_id IS NOT NULL)
      OR (type = 'SYSTEM' AND user_id IS NULL));

ALTER TABLE wallets
  ADD CONSTRAINT wallets_version_non_negative
  CHECK (version >= 0);


-- --- transactions ----------------------------------------------------------

-- Direction is carried by source/dest, never by sign. A zero or negative
-- amount is meaningless.
ALTER TABLE transactions
  ADD CONSTRAINT transactions_amount_positive
  CHECK (amount_poisha > 0);

-- ARCHITECTURE.md §7: self-transfer is rejected before any lock is taken.
-- This is the structural backstop for that rule.
ALTER TABLE transactions
  ADD CONSTRAINT transactions_no_self_transfer
  CHECK (source_wallet_id <> dest_wallet_id);

-- A COMPLETED transaction without a completion timestamp is a corrupt record.
ALTER TABLE transactions
  ADD CONSTRAINT transactions_completed_has_timestamp
  CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL);

-- A failure reason belongs only on a failure.
ALTER TABLE transactions
  ADD CONSTRAINT transactions_failure_reason_only_when_failed
  CHECK (failure_reason IS NULL OR status = 'FAILED');

-- Only a REVERSAL may point at a reversed transaction, and it must.
ALTER TABLE transactions
  ADD CONSTRAINT transactions_reversal_link_matches_type
  CHECK ((type = 'REVERSAL' AND reversal_of_id IS NOT NULL)
      OR (type <> 'REVERSAL' AND reversal_of_id IS NULL));

-- Only a settlement may reference an originating request, and it must.
ALTER TABLE transactions
  ADD CONSTRAINT transactions_request_link_matches_type
  CHECK ((type = 'REQUEST_SETTLEMENT' AND origin_request_id IS NOT NULL)
      OR (type <> 'REQUEST_SETTLEMENT' AND origin_request_id IS NULL));


-- --- ledger_entries --------------------------------------------------------

-- Makes the deliberate redundancy between `direction` and the sign of
-- `amount_poisha` safe: the two can never disagree. DEBIT is negative, CREDIT
-- is positive, so SUM(amount_poisha) over a balanced transaction is exactly 0.
ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_direction_matches_sign
  CHECK ((direction = 'DEBIT'  AND amount_poisha < 0)
      OR (direction = 'CREDIT' AND amount_poisha > 0));


-- --- money_requests --------------------------------------------------------

ALTER TABLE money_requests
  ADD CONSTRAINT money_requests_amount_positive
  CHECK (amount_poisha > 0);

-- Asking yourself for money is not a thing.
ALTER TABLE money_requests
  ADD CONSTRAINT money_requests_no_self_request
  CHECK (requester_user_id <> payer_user_id);

ALTER TABLE money_requests
  ADD CONSTRAINT money_requests_expiry_after_creation
  CHECK (expires_at > created_at);

-- Terminal states must record when they were reached; REQUESTED must not.
ALTER TABLE money_requests
  ADD CONSTRAINT money_requests_resolution_matches_status
  CHECK ((status = 'REQUESTED' AND resolved_at IS NULL)
      OR (status <> 'REQUESTED' AND resolved_at IS NOT NULL));


-- --- risk_flags ------------------------------------------------------------

-- A reviewed flag records who reviewed it and when; an open one does neither.
ALTER TABLE risk_flags
  ADD CONSTRAINT risk_flags_review_fields_consistent
  CHECK ((status IN ('OPEN', 'UNDER_REVIEW') AND reviewed_at IS NULL AND reviewed_by_user_id IS NULL)
      OR (status IN ('CONFIRMED', 'DISMISSED') AND reviewed_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL));


-- ============================================================================
--  2. PARTIAL INDEXES
--
--  Every one of these covers a query that touches a tiny minority of rows in a
--  table that grows without bound. A full index on the same column would carry
--  millions of dead entries and slow every insert on the hot write path.
-- ============================================================================

-- Outbox claim. THE most important index in the schema: `transaction_events`
-- grows to billions, but unpublished rows number in the hundreds, so this
-- index stays a few kilobytes forever.
CREATE INDEX IF NOT EXISTS idx_transaction_events_unpublished
  ON transaction_events (id)
  WHERE published_at IS NULL;

-- The reaper sweeping transactions stuck in PENDING (ARCHITECTURE.md §7).
CREATE INDEX IF NOT EXISTS idx_transactions_pending
  ON transactions (created_at)
  WHERE status = 'PENDING';

-- Wallets needing attention. ~99.9% of rows are ACTIVE and never match.
CREATE INDEX IF NOT EXISTS idx_wallets_needs_attention
  ON wallets (status, updated_at)
  WHERE status <> 'ACTIVE';

-- The money-request expiry sweep. Never scans settled requests.
CREATE INDEX IF NOT EXISTS idx_money_requests_expiring
  ON money_requests (expires_at)
  WHERE status = 'REQUESTED';

-- Money-request notifications still to be delivered.
CREATE INDEX IF NOT EXISTS idx_money_requests_unnotified
  ON money_requests (updated_at)
  WHERE notified_at IS NULL;

-- The analyst review queue.
CREATE INDEX IF NOT EXISTS idx_risk_flags_open
  ON risk_flags (severity DESC, created_at DESC)
  WHERE status IN ('OPEN', 'UNDER_REVIEW');

-- NOTE ON `CONCURRENTLY`: it cannot run inside a transaction block, and Prisma
-- wraps each migration in one. Put these six statements in their OWN migration
-- directory containing only this section, and mark it as needing to run
-- outside a transaction. On an empty database (first deploy) plain
-- `CREATE INDEX` is fine and simpler — drop the CONCURRENTLY keyword. See
-- DATABASE.md "The CREATE INDEX problem".


-- ============================================================================
--  3. IMMUTABILITY TRIGGERS
--
--  The requirement is absolute: transactions are never deleted, and every
--  money movement keeps a complete history. Grants alone are not enough,
--  because migrations and any superuser connection bypass them. A trigger
--  refuses regardless of who is asking.
-- ============================================================================

-- --- ledger_entries: fully immutable, no exceptions ------------------------

CREATE OR REPLACE FUNCTION goti_reject_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entries is append-only: % rejected on entry %',
    TG_OP, COALESCE(OLD.id::text, '(unknown)')
    USING ERRCODE = 'restrict_violation',
          HINT = 'Correct a bad posting with a compensating REVERSAL transaction, never by editing history.';
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER trg_ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION goti_reject_ledger_mutation();


-- --- transactions: never deleted; terminal states never reopened -----------

CREATE OR REPLACE FUNCTION goti_guard_transaction_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transactions are never deleted (id %)', OLD.id
      USING ERRCODE = 'restrict_violation',
            HINT = 'Reverse the transaction instead. Financial history is permanent.';
  END IF;

  -- COMPLETED may still advance to REVERSED. FAILED and REVERSED are final.
  IF OLD.status = 'COMPLETED' AND NEW.status NOT IN ('COMPLETED', 'REVERSED') THEN
    RAISE EXCEPTION 'illegal transition COMPLETED -> % on transaction %', NEW.status, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status IN ('FAILED', 'REVERSED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'transaction % is in terminal state % and cannot change', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The financial facts of a movement are fixed at creation.
  IF NEW.amount_poisha     IS DISTINCT FROM OLD.amount_poisha
  OR NEW.source_wallet_id  IS DISTINCT FROM OLD.source_wallet_id
  OR NEW.dest_wallet_id    IS DISTINCT FROM OLD.dest_wallet_id
  OR NEW.idempotency_key   IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'immutable field changed on transaction %', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_transactions_guard ON transactions;
CREATE TRIGGER trg_transactions_guard
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION goti_guard_transaction_write();


-- --- transaction_events: append-only, except the outbox marker -------------

CREATE OR REPLACE FUNCTION goti_guard_transaction_event_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transaction_events is append-only: DELETE rejected on event %', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The outbox worker marks delivery. Nothing else may change.
  IF NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
  OR NEW.type           IS DISTINCT FROM OLD.type
  OR NEW.payload        IS DISTINCT FROM OLD.payload
  OR NEW.occurred_at    IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'only published_at may be updated on transaction_events (event %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_transaction_events_append_only ON transaction_events;
CREATE TRIGGER trg_transaction_events_append_only
  BEFORE UPDATE OR DELETE ON transaction_events
  FOR EACH ROW EXECUTE FUNCTION goti_guard_transaction_event_write();


-- --- audit_logs: fully immutable -------------------------------------------

CREATE OR REPLACE FUNCTION goti_reject_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % rejected', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION goti_reject_audit_mutation();


-- ============================================================================
--  4. ROLE SEPARATION AND GRANTS
--
--  Two roles, because the role that can reshape the schema must not be the
--  role serving traffic:
--    goti_migrator — owns every object; runs `prisma migrate deploy`.
--    goti_app      — the runtime connection. Cannot drop, cannot delete money.
--
--  Run this section as the migrator/owner. Replace the password with a value
--  from your secret store; never commit a real one.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goti_app') THEN
    CREATE ROLE goti_app LOGIN PASSWORD 'change-me-in-secrets-manager';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO goti_app;

-- Mutable operational tables.
GRANT SELECT, INSERT, UPDATE ON users          TO goti_app;
GRANT SELECT, INSERT, UPDATE ON wallets        TO goti_app;
GRANT SELECT, INSERT, UPDATE ON money_requests TO goti_app;
GRANT SELECT, INSERT, UPDATE ON risk_flags     TO goti_app;

-- Transactions: status advances, but rows are never removed.
GRANT SELECT, INSERT, UPDATE ON transactions TO goti_app;

-- The ledger: append and read. No UPDATE. No DELETE. Ever.
GRANT SELECT, INSERT ON ledger_entries TO goti_app;

-- Events: append and read, plus a COLUMN-LEVEL update so the outbox worker can
-- mark delivery and change nothing else.
GRANT SELECT, INSERT ON transaction_events TO goti_app;
GRANT UPDATE (published_at) ON transaction_events TO goti_app;

-- Audit: append and read only.
GRANT SELECT, INSERT ON audit_logs TO goti_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO goti_app;

-- No blanket default privileges: a table added by a future migration must be
-- granted deliberately. Silence is the safe default for a money system.


-- ============================================================================
--  5. RECONCILIATION VIEWS
--
--  ARCHITECTURE.md §5: "A nightly reconciliation job asserts, per wallet, that
--  the sum of its ledger entries equals its stored balance, and that the sum of
--  every entry in the system is zero."
--
--  These views are that assertion, expressed once, in the database.
-- ============================================================================

-- Per-wallet drift. Any row returned by this view is a bug that has ALREADY
-- happened; the reconciler freezes the wallet and alerts.
CREATE OR REPLACE VIEW wallet_balance_drift AS
SELECT
  w.id                                        AS wallet_id,
  w.user_id,
  w.type,
  w.status,
  w.balance_poisha                            AS projected_balance_poisha,
  COALESCE(SUM(le.amount_poisha), 0)::bigint  AS ledger_balance_poisha,
  w.balance_poisha - COALESCE(SUM(le.amount_poisha), 0)::bigint AS drift_poisha,
  COUNT(le.id)                                AS entry_count,
  MAX(le.created_at)                          AS last_posting_at
FROM wallets w
LEFT JOIN ledger_entries le ON le.wallet_id = w.id
GROUP BY w.id, w.user_id, w.type, w.status, w.balance_poisha
HAVING w.balance_poisha <> COALESCE(SUM(le.amount_poisha), 0)::bigint;

COMMENT ON VIEW wallet_balance_drift IS
  'Wallets whose cached balance disagrees with their ledger. MUST be empty. Any row is a financial bug.';


-- System-wide conservation. Double-entry means this total is always exactly 0.
-- If it is not, money was created or destroyed.
CREATE OR REPLACE VIEW ledger_conservation_check AS
SELECT
  COALESCE(SUM(amount_poisha), 0)::bigint AS net_poisha,
  COUNT(*)                                AS total_entries,
  COUNT(DISTINCT transaction_id)          AS total_transactions
FROM ledger_entries;

COMMENT ON VIEW ledger_conservation_check IS
  'Sum of every ledger entry ever written. MUST be exactly 0.';


-- Individually unbalanced movements — a narrower, faster signal than the
-- system-wide total, and it names the culprit.
CREATE OR REPLACE VIEW unbalanced_transactions AS
SELECT
  t.id                                        AS transaction_id,
  t.type,
  t.status,
  t.amount_poisha,
  COALESCE(SUM(le.amount_poisha), 0)::bigint  AS entry_sum_poisha,
  COUNT(le.id)                                AS entry_count,
  t.created_at
FROM transactions t
LEFT JOIN ledger_entries le ON le.transaction_id = t.id
WHERE t.status IN ('COMPLETED', 'REVERSED')
GROUP BY t.id, t.type, t.status, t.amount_poisha, t.created_at
HAVING COALESCE(SUM(le.amount_poisha), 0) <> 0
    OR COUNT(le.id) <> 2;

COMMENT ON VIEW unbalanced_transactions IS
  'Completed movements whose postings do not sum to zero, or do not have exactly two legs. MUST be empty.';

GRANT SELECT ON wallet_balance_drift, ledger_conservation_check, unbalanced_transactions TO goti_app;


-- ============================================================================
--  6. TABLE COMMENTS — the design intent, readable from psql
-- ============================================================================

COMMENT ON TABLE wallets IS
  'Balance PROJECTION, not the source of truth. Derived from ledger_entries; if they disagree, the ledger wins.';
COMMENT ON TABLE transactions IS
  'Money movement command record: intent, idempotency and outcome. Never deleted.';
COMMENT ON TABLE ledger_entries IS
  'Double-entry postings. THE financial source of truth. Append-only, trigger-enforced.';
COMMENT ON TABLE transaction_events IS
  'Transaction lifecycle log AND transactional outbox. Written inside the money transaction.';
COMMENT ON TABLE money_requests IS
  'A claim, not money. Never touches a balance. Only acceptance creates a transaction.';
COMMENT ON TABLE audit_logs IS
  'Actor truth: who did what, from where. Covers non-financial actions. Append-only.';
COMMENT ON TABLE risk_flags IS
  'Asynchronous post-hoc detection, fed by the outbox. Never blocks the money path.';

COMMENT ON COLUMN wallets.balance_poisha IS
  'Integer poisha (1 BDT = 100 poisha). Written ONLY by the Transaction Engine.';
COMMENT ON COLUMN ledger_entries.amount_poisha IS
  'SIGNED integer poisha. Negative = DEBIT, positive = CREDIT. Sums to 0 per transaction.';
