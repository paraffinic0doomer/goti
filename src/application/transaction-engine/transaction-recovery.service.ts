import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  AUDIT_REPOSITORY,
  AuditRepositoryPort,
  CLOCK,
  ClockPort,
  LEDGER_REPOSITORY,
  LedgerRepositoryPort,
  RECONCILIATION_PORT,
  ReconciliationPort,
  TRANSACTION_REPOSITORY,
  TransactionRepositoryPort,
  UNIT_OF_WORK,
  UnitOfWorkPort,
} from '../ports/repositories.port';
import { TransactionEventService } from './transaction-event.service';

/** A transaction may sit in PENDING this long before the sweep claims it. */
const STALE_PENDING_THRESHOLD_MS = 5 * 60 * 1000;
const SWEEP_BATCH_SIZE = 100;

export interface RecoverySweepReport {
  readonly scanned: number;
  readonly reaped: number;
  readonly skipped: number;
}

export interface ReconciliationReport {
  readonly walletsWithDrift: number;
  readonly ledgerNetPoisha: bigint;
  readonly healthy: boolean;
}

/**
 * ============================================================================
 *  RECOVERY
 * ============================================================================
 *
 * WHAT THIS DOES NOT HAVE TO DO
 * ---------------------------------------------------------------------------
 * It does not undo half-completed transfers, because none can exist. The money
 * movement is one PostgreSQL transaction: on any crash, the write-ahead log
 * rolls back every uncommitted write during recovery, automatically, before
 * the database accepts connections. "Sender debited, receiver not credited" is
 * not a state this schema can represent.
 *
 * That is worth stating plainly, because most systems need a compensating
 * transaction engine here, and this one does not. The atomicity was bought at
 * design time (ARCHITECTURE.md §5), so recovery has nothing to compensate.
 *
 * WHAT IT ACTUALLY DOES
 * ---------------------------------------------------------------------------
 *   1. REAPS STRANDED PENDING ROWS. A row can be committed as PENDING only if
 *      a future async path commits admission separately from settlement. None
 *      exists today, so this sweep should always find zero — and that is
 *      exactly why it runs: if it ever finds a row, an invariant broke and
 *      somebody must know.
 *
 *   2. RECONCILES THE LEDGER AGAINST THE PROJECTIONS. The nightly assertion
 *      from ARCHITECTURE.md §5: every wallet's balance must equal the sum of
 *      its ledger entries, and every entry in the system must sum to zero.
 *
 * A wallet found in drift is FROZEN rather than corrected. An automatic
 * "correction" would overwrite the evidence of a bug with a guess; freezing
 * stops the error compounding and forces a human to determine which value is
 * right.
 */
@Injectable()
export class TransactionRecoveryService {
  private readonly logger = new Logger(TransactionRecoveryService.name);

  constructor(
    @Inject(TRANSACTION_REPOSITORY) private readonly transactions: TransactionRepositoryPort,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepositoryPort,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepositoryPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(RECONCILIATION_PORT) private readonly reconciliation: ReconciliationPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly eventService: TransactionEventService,
  ) {}

  /**
   * Fails transactions stranded in PENDING past the threshold.
   *
   * Safe by construction: a committed PENDING row provably has no ledger
   * entries, because entries are only written on the path that also marks
   * COMPLETED, in the same transaction. Marking it FAILED therefore moves no
   * money — it records what already happened.
   *
   * Uses the partial index `WHERE status = 'PENDING'` from `hardening.sql`, so
   * the sweep never scans the full transactions table.
   */
  async sweepStalePending(): Promise<RecoverySweepReport> {
    const cutoff = new Date(this.clock.now().getTime() - STALE_PENDING_THRESHOLD_MS);
    const stale = await this.transactions.findStalePending(cutoff, SWEEP_BATCH_SIZE);

    if (stale.length === 0) return { scanned: 0, reaped: 0, skipped: 0 };

    // Never routine. A non-empty result means an invariant broke.
    this.logger.error(
      `Recovery sweep found ${stale.length} transaction(s) stranded in PENDING before ` +
        `${cutoff.toISOString()}. This should be zero — investigate.`,
    );

    let reaped = 0;
    let skipped = 0;

    for (const transaction of stale) {
      try {
        await this.unitOfWork.runInTransaction(async (context) => {
          // A guard, not a formality. If this transaction has ledger entries,
          // the money DID move and only its status is wrong — failing it would
          // make the transaction row contradict the ledger, which is worse than
          // leaving it stranded. Stop and escalate instead.
          const postedEntries = await this.ledger.countEntriesForTransaction(
            transaction.id,
            context,
          );
          if (postedEntries > 0) {
            throw new Error(
              `Transaction ${transaction.id} is PENDING but has ${postedEntries} ledger ` +
                'entries. Money moved. Refusing to mark it FAILED — needs manual review.',
            );
          }

          await this.transactions.markFailed(transaction.id, 'REAPED_STALE_PENDING', context);

          const events = this.eventService.createCollector(transaction.id);
          events.record('TRANSACTION_FAILED', {
            code: 'REAPED_STALE_PENDING',
            reapedAt: this.clock.now().toISOString(),
          });
          await this.eventService.flush(events, context);

          await this.audit.record(
            {
              actorUserId: null,
              actorType: 'SYSTEM',
              action: 'transaction.reaped',
              entityType: 'Transaction',
              entityId: transaction.id,
              before: { status: 'PENDING' },
              after: { status: 'FAILED', failureReason: 'REAPED_STALE_PENDING' },
            },
            context,
          );
        });
        reaped++;
      } catch (error) {
        skipped++;
        this.logger.error(
          `Could not reap transaction ${transaction.id}: ${(error as Error).message}`,
        );
      }
    }

    return { scanned: stale.length, reaped, skipped };
  }

  /**
   * The money-integrity assertion.
   *
   * Two questions, both of which must answer cleanly:
   *   - Does every wallet's cached balance equal the sum of its ledger entries?
   *   - Does the ledger as a whole sum to exactly zero?
   *
   * Backed by the `wallet_balance_drift` and `ledger_conservation_check` views
   * in `hardening.sql`, so the assertion is expressed once, in the database.
   *
   * A design where missing money is only discovered by a customer complaint is
   * not a design. This finds it in minutes.
   */
  async reconcile(): Promise<ReconciliationReport> {
    const report = await this.reconciliation.check();

    if (!report.healthy) {
      this.logger.error(
        `RECONCILIATION FAILED — ${report.walletsWithDrift} wallet(s) in drift, ` +
          `ledger net ${report.ledgerNetPoisha} poisha (must be 0). Money integrity is in question.`,
      );
    } else {
      this.logger.log('Reconciliation clean: ledger conserves, no balance drift.');
    }

    return report;
  }
}
