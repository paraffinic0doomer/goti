import { Injectable } from '@nestjs/common';

import { IllegalStateTransitionError } from '../../domain/errors/domain-errors';

/**
 * ============================================================================
 *  TRANSACTION STATE MACHINE
 * ============================================================================
 *
 * WHY A STATE MACHINE RATHER THAN `transaction.status = 'COMPLETED'`
 * ---------------------------------------------------------------------------
 * A plain status field makes every transition legal. Nothing stops
 * `FAILED → COMPLETED`, and a system that can perform that assignment is a
 * system that can pay out a transfer it already rejected. The bug is not that
 * someone would write it deliberately — it is that with N statuses there are
 * N² assignments and only a handful are correct, so the ones that are wrong
 * are reachable by ordinary mistakes: a retry handler, a stale object written
 * back, a merge that reorders two lines.
 *
 * A state machine inverts the default. Transitions are DATA — an explicit
 * table of the edges that exist — and everything absent from that table is
 * rejected. Five concrete benefits:
 *
 *   1. ILLEGAL TRANSITIONS BECOME IMPOSSIBLE, not merely unlikely. Reversing
 *      a failed transfer, or completing one twice, throws instead of writing.
 *
 *   2. TERMINAL STATES ARE ENFORCED. COMPLETED, FAILED and CANCELLED have no
 *      outgoing edges except the one deliberate COMPLETED → REVERSING path.
 *      Financial history stops changing once it is written.
 *
 *   3. THE LIFECYCLE IS READABLE IN ONE PLACE. The legal flow is a table, not
 *      a behaviour distributed across every service that touches a status.
 *
 *   4. EVERY TRANSITION IS AN EVENT. Because transitions go through one
 *      function, each can emit a `transaction_events` row for free — which is
 *      what makes "what happened to my money?" answerable.
 *
 *   5. IT IS TESTABLE WITHOUT INFRASTRUCTURE. Pure data and pure functions:
 *      the entire legality matrix is verifiable in microseconds with no
 *      database and no mocks.
 *
 * DEFENCE IN DEPTH: this machine guards transitions in the application. The
 * `goti_guard_transaction_write` trigger in `hardening.sql` guards the same
 * rules in PostgreSQL. If this class is bypassed entirely, the database still
 * refuses — the same layering ARCHITECTURE.md §5 applies to balances.
 */

/**
 * Fine-grained lifecycle phases.
 *
 * Distinct from the persisted `TransactionStatus` (PENDING / COMPLETED /
 * FAILED / REVERSED), which is the DURABLE CHECKPOINT written to the
 * transaction row. These phases are the in-flight timeline; each is recorded
 * as a `transaction_events` row, batched into a single insert before commit.
 *
 * Promoting every phase to a column UPDATE would add five round trips inside
 * the money transaction, extending lock hold time on the hottest rows in the
 * system to store information that belongs in a log.
 */
export enum TransactionPhase {
  /** Request accepted, transaction id minted. Nothing persisted yet. */
  CREATED = 'CREATED',
  /** Running validation: participants, amount, limits. */
  VALIDATING = 'VALIDATING',
  /** Every pre-flight check passed. No money has moved. */
  VALIDATED = 'VALIDATED',
  /** Inside the database transaction, wallets locked, balances moving. */
  PROCESSING = 'PROCESSING',
  /** Committed. Money moved, ledger balanced. TERMINAL. */
  COMPLETED = 'COMPLETED',
  /** Rejected or errored. No money moved. TERMINAL. */
  FAILED = 'FAILED',
  /**
   * Abandoned before processing. TERMINAL.
   *
   * NOT REACHABLE by the synchronous transfer path today: a transfer either
   * completes or fails within one database transaction, so there is no window
   * in which a caller can abandon one. It is modelled now because scheduled
   * and future-dated transfers will reach it, and because leaving a legal
   * terminal state out of the machine is how it later gets bolted on wrongly.
   */
  CANCELLED = 'CANCELLED',
  /** A committed transfer is being compensated by a new, opposite posting. */
  REVERSING = 'REVERSING',
  /** Compensation committed. TERMINAL. */
  REVERSED = 'REVERSED',
}

/**
 * The complete set of legal edges. Anything not listed here is rejected.
 *
 * Read this table as the specification of the lifecycle — it is the only
 * definition, and the code below merely enforces it.
 */
const LEGAL_TRANSITIONS: Readonly<Record<TransactionPhase, readonly TransactionPhase[]>> = {
  [TransactionPhase.CREATED]: [TransactionPhase.VALIDATING, TransactionPhase.CANCELLED],

  // Validation can fail. It cannot skip ahead to PROCESSING.
  [TransactionPhase.VALIDATING]: [
    TransactionPhase.VALIDATED,
    TransactionPhase.FAILED,
    TransactionPhase.CANCELLED,
  ],

  // Last point at which abandoning is free — nothing is locked, nothing moved.
  [TransactionPhase.VALIDATED]: [
    TransactionPhase.PROCESSING,
    TransactionPhase.FAILED,
    TransactionPhase.CANCELLED,
  ],

  // Once processing begins, cancellation is no longer offered: the outcome is
  // decided by the database transaction, not by a caller changing their mind.
  [TransactionPhase.PROCESSING]: [TransactionPhase.COMPLETED, TransactionPhase.FAILED],

  // Terminal — except for the one deliberate compensation path.
  [TransactionPhase.COMPLETED]: [TransactionPhase.REVERSING],
  [TransactionPhase.REVERSING]: [TransactionPhase.REVERSED, TransactionPhase.FAILED],

  // Absolutely terminal. Empty arrays are the point of this table.
  [TransactionPhase.FAILED]: [],
  [TransactionPhase.CANCELLED]: [],
  [TransactionPhase.REVERSED]: [],
};

const TERMINAL_PHASES: ReadonlySet<TransactionPhase> = new Set([
  TransactionPhase.COMPLETED,
  TransactionPhase.FAILED,
  TransactionPhase.CANCELLED,
  TransactionPhase.REVERSED,
]);

/**
 * Maps a fine-grained phase onto the coarse status persisted on the
 * transaction row. Several phases share PENDING because they are all
 * in-flight; only the checkpoints differ.
 */
const PHASE_TO_STATUS: Readonly<Record<TransactionPhase, 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED'>> = {
  [TransactionPhase.CREATED]: 'PENDING',
  [TransactionPhase.VALIDATING]: 'PENDING',
  [TransactionPhase.VALIDATED]: 'PENDING',
  [TransactionPhase.PROCESSING]: 'PENDING',
  [TransactionPhase.REVERSING]: 'COMPLETED',
  [TransactionPhase.COMPLETED]: 'COMPLETED',
  [TransactionPhase.FAILED]: 'FAILED',
  // A cancelled transfer moved no money; FAILED is its durable representation.
  [TransactionPhase.CANCELLED]: 'FAILED',
  [TransactionPhase.REVERSED]: 'REVERSED',
};

/**
 * Validates and applies phase transitions.
 *
 * Stateless and pure — it holds no transaction, so one instance safely serves
 * every concurrent request. The caller owns the current phase; this class owns
 * the rules.
 */
@Injectable()
export class TransactionStateMachine {
  /** Whether an edge exists, without throwing. For pre-checks and tests. */
  canTransition(from: TransactionPhase, to: TransactionPhase): boolean {
    return LEGAL_TRANSITIONS[from].includes(to);
  }

  /**
   * Applies a transition, or throws.
   *
   * Returns the new phase rather than mutating, so a caller cannot half-apply
   * a transition and leave an object in a phase the machine never approved.
   */
  transition(
    from: TransactionPhase,
    to: TransactionPhase,
    transactionId?: string,
  ): TransactionPhase {
    if (!this.canTransition(from, to)) {
      throw new IllegalStateTransitionError(from, to, transactionId);
    }
    return to;
  }

  isTerminal(phase: TransactionPhase): boolean {
    return TERMINAL_PHASES.has(phase);
  }

  /** Phases reachable from here. Used by tests and by the recovery sweep. */
  allowedNext(from: TransactionPhase): readonly TransactionPhase[] {
    return LEGAL_TRANSITIONS[from];
  }

  /** The durable status this phase maps onto. */
  toPersistedStatus(phase: TransactionPhase): 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED' {
    return PHASE_TO_STATUS[phase];
  }

  /**
   * Whether a transaction stranded in this phase can be safely failed by the
   * recovery sweep.
   *
   * Only non-terminal phases qualify. A stranded row in one of these phases
   * never committed a balance change — the money transaction is atomic, so
   * either everything committed (phase COMPLETED) or nothing did.
   */
  isRecoverable(phase: TransactionPhase): boolean {
    return !this.isTerminal(phase);
  }
}
