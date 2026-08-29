import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  ConcurrencyConflictError,
  DomainError,
  DuplicateRequestError,
  InsufficientFundsError,
  LedgerIntegrityError,
  TransactionInProgressError,
  isDomainError,
  isRetryable,
} from '../../domain/errors/domain-errors';
import {
  AUDIT_REPOSITORY,
  AuditRepositoryPort,
  CLOCK,
  ClockPort,
  ID_GENERATOR,
  IdGeneratorPort,
  LEDGER_REPOSITORY,
  LedgerRepositoryPort,
  TRANSACTION_REPOSITORY,
  TransactionContext,
  TransactionRepositoryPort,
  TransactionSnapshot,
  UNIT_OF_WORK,
  UnitOfWorkPort,
  WALLET_REPOSITORY,
  WalletRepositoryPort,
} from '../ports/repositories.port';
import { CACHE_PORT, CachePort, IDEMPOTENCY_PORT, IdempotencyPort } from '../ports';
import { TransactionEventCollector, TransactionEventService } from './transaction-event.service';
import { TransactionLockService } from './transaction-lock.service';
import { TransactionPhase, TransactionStateMachine } from './transaction.state-machine';
import { TransactionValidator } from './transaction.validator';
import { TransferCommand, TransferResult } from './transaction.types';
import { ApplicationCacheKeys } from '../cache/cache.keys';

/** Bounded retry for CONTENTION only. Business rejections are never retried. */
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 25;

/** Ceiling on lock hold time. A transfer that cannot finish here is contended. */
const TRANSACTION_TIMEOUT_MS = 5_000;
const TRANSACTION_MAX_WAIT_MS = 2_000;

/**
 * ============================================================================
 *  THE TRANSACTION ENGINE
 * ============================================================================
 *
 * The ONLY component in Goti permitted to change a balance. Every money
 * movement — send, request settlement, reversal, future top-up — passes
 * through `process()`. That single choke point is what makes the system
 * auditable: there is exactly one place where money changes, so there is
 * exactly one place to review, test and instrument.
 *
 * THE ATOMICITY GUARANTEE
 * ---------------------------------------------------------------------------
 * Steps 8–14 of the workflow run inside ONE PostgreSQL transaction: insert the
 * command record, lock both wallets, debit, credit, post two ledger entries,
 * write the timeline, write the audit row, mark the outcome. They commit
 * together or not at all.
 *
 * That is the answer to "sender debited, then the app crashed". There is no
 * instant at which the debit is durable and the credit is not. PostgreSQL's
 * write-ahead log makes the whole set atomic: on crash recovery an uncommitted
 * transaction is rolled back in full. The failure mode the brief describes is
 * not handled — it is UNREACHABLE.
 *
 * TWO KINDS OF FAILURE, TWO OPPOSITE RESPONSES
 * ---------------------------------------------------------------------------
 *   BUSINESS REJECTION (insufficient funds, frozen wallet)
 *     A real, stable answer. The transaction row is COMMITTED as FAILED — no
 *     ledger entries, no balance change — so the attempt is durably auditable
 *     and the idempotency key is consumed. Never retried: the answer is "no".
 *
 *   INFRASTRUCTURE FAULT (lock timeout, serialization failure, crash)
 *     Nothing was decided. The transaction rolls back COMPLETELY, leaving no
 *     row at all, and a bounded retry with jittered backoff is safe because
 *     the same idempotency key still guards the retry.
 *
 * Conflating these is how one rejected payment becomes forty retries hammering
 * a hot row (ARCHITECTURE.md §7).
 */
@Injectable()
export class TransactionProcessor {
  private readonly logger = new Logger(TransactionProcessor.name);

  constructor(
    private readonly validator: TransactionValidator,
    private readonly locks: TransactionLockService,
    private readonly stateMachine: TransactionStateMachine,
    private readonly eventService: TransactionEventService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactions: TransactionRepositoryPort,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepositoryPort,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepositoryPort,
    @Inject(IDEMPOTENCY_PORT) private readonly idempotency: IdempotencyPort,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
  ) {}

  /**
   * Executes one money movement.
   *
   * Steps 1–7 happen here, outside any database transaction. Steps 8–15 happen
   * inside `executeMoneyMovement`.
   */
  async process(command: TransferCommand): Promise<TransferResult> {
    // --- Step 7: mint the transaction id up front ---
    // UUIDv7 from the IdGenerator port — time-ordered, so B-tree inserts stay
    // at the right edge of the index instead of scattering (DATABASE.md §6).
    // Minted before the idempotency reservation so the reservation can name it.
    const transactionId = this.ids.generate();

    // ================= TIER 1 IDEMPOTENCY — Redis fast path =================
    const reservation = await this.idempotency.reserve(
      command.initiatorUserId,
      command.idempotencyKey,
      transactionId,
    );

    if (reservation.outcome === 'REPLAY') {
      // Already finished. Return the original answer without touching a balance.
      this.logger.log(`Replaying stored result for "${command.idempotencyKey}".`);
      return this.toReplayedResult(command, reservation.record);
    }

    if (reservation.outcome === 'IN_FLIGHT') {
      // An identical request is executing right now. Starting a second would
      // race it; the correct answer is "ask again shortly".
      throw new TransactionInProgressError(command.idempotencyKey);
    }

    const degraded = reservation.outcome === 'DEGRADED';
    if (degraded) {
      this.logger.warn(
        `Idempotency fast path unavailable for "${command.idempotencyKey}". ` +
          'Relying on the database unique constraint.',
      );
    }

    // Phase tracking begins. Every move goes through the state machine, so an
    // illegal step throws rather than silently writing.
    let phase = TransactionPhase.CREATED;
    const events = this.eventService.createCollector(transactionId);
    events.record('TRANSACTION_INITIATED', {
      idempotencyKey: command.idempotencyKey,
      amountPoisha: command.amountPoisha.toString(),
      currency: command.currency,
    });

    try {
      // ============ Steps 2–6: validation, OUTSIDE the lock ============
      phase = this.stateMachine.transition(phase, TransactionPhase.VALIDATING, transactionId);

      const validated = await this.validator.validate({
        senderUserId: command.senderUserId,
        // Wallet-addressed participants (Pot contributions and payouts) must be
        // forwarded too — a Pot wallet has no owning user to resolve by phone.
        senderWalletId: command.senderWalletId,
        receiverUserId: command.receiverUserId,
        receiverPhone: command.receiverPhone,
        receiverWalletId: command.receiverWalletId,
        amountPoisha: command.amountPoisha,
        currency: command.currency,
      });

      events.record('SENDER_VERIFIED', {
        userId: validated.senderUserId,
        walletId: validated.senderWallet.id,
      });
      events.record('RECEIVER_VERIFIED', {
        userId: validated.receiverUserId,
        walletId: validated.receiverWallet.id,
      });
      events.record('VALIDATION_PASSED', { amount: validated.amount.format() });

      phase = this.stateMachine.transition(phase, TransactionPhase.VALIDATED, transactionId);

      // ============ Steps 8–15: the money movement ============
      const result = await this.withRetry(command, () =>
        this.executeMoneyMovement(command, validated, transactionId, events, phase),
      );

      // Store the outcome so later retries replay it rather than re-executing.
      await this.idempotency.complete(
        command.initiatorUserId,
        command.idempotencyKey,
        transactionId,
        result,
      );

      // Delete, never update (REDIS.md §6): writing the new balance in risks a
      // slower transaction landing its older value last and leaving it stale.
      await this.invalidateWalletCaches(
        // A POT wallet has no owning user; fall back to the initiator so the
        // cache key set is still complete.
        validated.senderUserId ?? command.initiatorUserId,
        validated.receiverUserId ?? command.initiatorUserId,
        validated.senderWallet.id,
        validated.receiverWallet.id,
      );

      return { ...result, idempotencyDegraded: degraded };
    } catch (error) {
      return this.handleFailure(command, transactionId, error, degraded);
    }
  }

  /**
   * ==========================================================================
   *  THE CRITICAL SECTION — one database transaction, steps 8 through 15
   * ==========================================================================
   *
   * WHY EVERY BALANCE UPDATE MUST BE IN ONE TRANSACTION
   *
   *   Without it, "debit sender" and "credit receiver" are two independent
   *   writes with a window between them. Anything that interrupts that window —
   *   a crash, a network partition, a killed pod during deploy, an exception —
   *   leaves money debited and never credited. It has VANISHED: no error will
   *   ever surface it, the sender is simply poorer, and only a customer
   *   complaint reveals it.
   *
   *   Compensating afterwards does not fix it. A "credit it back" step is
   *   itself a write that can fail, and now there are two ways to be wrong
   *   instead of one.
   *
   *   Inside a transaction the question does not arise. PostgreSQL's WAL makes
   *   the entire set atomic: either every write is durable, or none is. There
   *   is no state in which the debit exists without the credit — not for a
   *   microsecond, not during recovery, not after a hard power loss.
   *
   *   This is also why the ledger entries, the timeline and the audit row are
   *   in here. A transfer whose ledger did not commit would be money that moved
   *   without a record, which is indistinguishable from a bug.
   */
  private async executeMoneyMovement(
    command: TransferCommand,
    validated: Awaited<ReturnType<TransactionValidator['validate']>>,
    transactionId: string,
    events: TransactionEventCollector,
    entryPhase: TransactionPhase,
  ): Promise<TransferResult> {
    let phase = this.stateMachine.transition(
      entryPhase,
      TransactionPhase.PROCESSING,
      transactionId,
    );
    events.record('PROCESSING_STARTED');

    return this.unitOfWork.runInTransaction(
      async (context: TransactionContext) => {
        // --- Step 8: the command record. TIER 2 IDEMPOTENCY. ---
        // The unique index on (initiator_user_id, idempotency_key) is the
        // actual guarantee behind "one request = one transaction". A duplicate
        // throws DuplicateRequestError from the repository.
        await this.transactions.create(
          {
            id: transactionId,
            idempotencyKey: command.idempotencyKey,
            initiatorUserId: command.initiatorUserId,
            // A request's unique settlement link is consumed only if money
            // actually moves. Until completion this is stored as a normal
            // attempt; otherwise an insufficient-funds row would permanently
            // prevent the request from being accepted after the payer tops up.
            type: command.type === 'REQUEST_SETTLEMENT' ? 'P2P_TRANSFER' : command.type ?? 'P2P_TRANSFER',
            sourceWalletId: validated.senderWallet.id,
            destWalletId: validated.receiverWallet.id,
            amountPoisha: validated.amount.poisha,
            currency: validated.amount.currency,
            note: command.note ?? null,
            originRequestId: null,
          },
          context,
        );

        // --- Step 9: lock both wallets, in canonical ID order ---
        const locked = await this.locks.lockWalletPair(
          validated.senderWallet.id,
          validated.receiverWallet.id,
          context,
        );
        events.record('WALLETS_LOCKED', {
          order: [validated.senderWallet.id, validated.receiverWallet.id].slice().sort(),
        });

        // Re-check what can go stale. NOT the balance — that is the conditional
        // update's job, and it is the only check that cannot be stale.
        this.validator.assertStillValidUnderLock(locked.sender, locked.receiver);

        // --- Step 10: the conditional atomic debit ---
        // One statement: `UPDATE ... WHERE balance >= amount AND status = ACTIVE`.
        // The database evaluates guard and mutation together and reports
        // whether a row changed. No balance is ever held in a variable and
        // spent against later, which is exactly why the lost-update race
        // (constraint C1) cannot occur here.
        const debited = await this.wallets.debitIfSufficient(
          locked.sender.id,
          validated.amount.poisha,
          context,
        );

        if (!debited) {
          // A DECISION, not a fault. Commit a FAILED record: no ledger entries,
          // no balance change, but a durable record that the attempt happened
          // and why. Returning rather than throwing is deliberate — throwing
          // would roll back the transaction row too, erasing the evidence.
          events.record('BALANCE_CHECKED', {
            sufficient: false,
            availablePoisha: locked.sender.balancePoisha.toString(),
            requestedPoisha: validated.amount.poisha.toString(),
          });

          return this.commitRejection(
            transactionId,
            command,
            validated,
            events,
            context,
            new InsufficientFundsError(
              locked.sender.id,
              validated.amount.poisha,
              locked.sender.balancePoisha,
            ),
          );
        }

        events.record('BALANCE_CHECKED', { sufficient: true });
        events.record('SENDER_DEBITED', {
          walletId: locked.sender.id,
          amountPoisha: validated.amount.poisha.toString(),
        });

        // --- Step 11: credit the receiver ---
        await this.wallets.credit(locked.receiver.id, validated.amount.poisha, context);
        events.record('RECEIVER_CREDITED', {
          walletId: locked.receiver.id,
          amountPoisha: validated.amount.poisha.toString(),
        });

        const senderBalanceAfter = locked.sender.balancePoisha - validated.amount.poisha;
        const receiverBalanceAfter = locked.receiver.balancePoisha + validated.amount.poisha;

        // A balance computed under the lock that came out negative would mean
        // the conditional update's guard did not hold — a contradiction. Assert
        // rather than trust, and abort the whole transaction if it ever fires.
        if (senderBalanceAfter < 0n) {
          throw new LedgerIntegrityError(
            `Sender balance would be ${senderBalanceAfter} after a debit that reported success.`,
          );
        }

        // --- Step 12a: double-entry postings ---
        // Signed amounts that sum to zero. The repository re-checks the sum
        // before writing, because these rows are immutable once committed.
        await this.ledger.postEntries(
          [
            {
              id: this.ids.generate(),
              transactionId,
              walletId: locked.sender.id,
              direction: 'DEBIT',
              amountPoisha: -validated.amount.poisha,
              balanceAfterPoisha: senderBalanceAfter,
              currency: validated.amount.currency,
            },
            {
              id: this.ids.generate(),
              transactionId,
              walletId: locked.receiver.id,
              direction: 'CREDIT',
              amountPoisha: validated.amount.poisha,
              balanceAfterPoisha: receiverBalanceAfter,
              currency: validated.amount.currency,
            },
          ],
          context,
        );
        events.record('LEDGER_POSTED', { entryCount: 2, netPoisha: '0' });

        // --- Step 15: the durable outcome ---
        const completedAt = this.clock.now();
        phase = this.stateMachine.transition(phase, TransactionPhase.COMPLETED, transactionId);
        await this.transactions.markCompleted(
          transactionId,
          completedAt,
          context,
          command.originRequestId
            ? { originRequestId: command.originRequestId }
            : undefined,
        );

        events.record('TRANSACTION_COMPLETED', {
          senderBalancePoisha: senderBalanceAfter.toString(),
          receiverBalancePoisha: receiverBalanceAfter.toString(),
        });

        // --- Step 12b: the timeline, in ONE batched insert ---
        await this.eventService.flush(events, context);

        // --- Step 13: the audit row, inside the same transaction ---
        await this.audit.record(
          {
            actorUserId: command.initiatorUserId,
            actorType: 'USER',
            action: 'transaction.completed',
            entityType: 'Transaction',
            entityId: transactionId,
            after: {
              amountPoisha: validated.amount.poisha.toString(),
              sourceWalletId: locked.sender.id,
              destWalletId: locked.receiver.id,
            },
            ipAddress: command.ipAddress ?? null,
            userAgent: command.userAgent ?? null,
            correlationId: command.correlationId ?? null,
          },
          context,
        );

        // --- Step 14: COMMIT happens here, when this callback returns ---
        return {
          outcome: 'COMPLETED' as const,
          transactionId,
          status: 'COMPLETED' as const,
          timestamp: completedAt,
          senderBalancePoisha: senderBalanceAfter,
          receiverBalancePoisha: receiverBalanceAfter,
          amountPoisha: validated.amount.poisha,
          currency: validated.amount.currency,
          completedAt,
        };
      },
      { timeoutMs: TRANSACTION_TIMEOUT_MS, maxWaitMs: TRANSACTION_MAX_WAIT_MS },
    );
  }

  /**
   * Commits a business rejection as a durable FAILED record.
   *
   * Runs inside the same transaction, and by design writes NO ledger entries —
   * nothing moved, so nothing is posted. What commits is the evidence: the
   * transaction row, its timeline, and an audit entry.
   */
  private async commitRejection(
    transactionId: string,
    command: TransferCommand,
    validated: Awaited<ReturnType<TransactionValidator['validate']>>,
    events: TransactionEventCollector,
    context: TransactionContext,
    reason: DomainError,
  ): Promise<TransferResult> {
    events.record('TRANSACTION_FAILED', { code: reason.code, message: reason.message });

    await this.transactions.markFailed(transactionId, reason.code, context);
    await this.eventService.flush(events, context);

    await this.audit.record(
      {
        actorUserId: command.initiatorUserId,
        actorType: 'USER',
        action: 'transaction.failed',
        entityType: 'Transaction',
        entityId: transactionId,
        after: { failureReason: reason.code },
        ipAddress: command.ipAddress ?? null,
        userAgent: command.userAgent ?? null,
        correlationId: command.correlationId ?? null,
      },
      context,
    );

    const failedAt = this.clock.now();
    return {
      outcome: 'FAILED',
      transactionId,
      status: 'FAILED',
      timestamp: failedAt,
      amountPoisha: validated.amount.poisha,
      currency: validated.amount.currency,
      failureReason: reason.code,
      failureMessage: reason.message,
    };
  }

  /**
   * Bounded retry for CONTENTION ONLY.
   *
   * ARCHITECTURE.md §7: "Retry contention; never retry a decision."
   * A serialization failure or lock timeout means nothing happened and the
   * transaction rolled back completely — trying again is safe, and the same
   * idempotency key still guards it. A business rejection means the answer is
   * "no", and retrying it would be both pointless and, on a hot wallet,
   * actively harmful.
   *
   * Jitter matters: without it, N transfers contending for one wallet all
   * retry in the same millisecond and collide again.
   */
  private async withRetry<T>(
    command: TransferCommand,
    operation: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // A duplicate is an ANSWER, not contention. Surface it immediately.
        if (error instanceof DuplicateRequestError) throw error;

        if (!isRetryable(error) || attempt === MAX_RETRY_ATTEMPTS) throw error;

        const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 25;
        this.logger.warn(
          `Contention on "${command.idempotencyKey}" (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}): ` +
            `${(error as Error).message}. Retrying in ${Math.round(delayMs)}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  }

  /**
   * Turns a thrown error into a result, or rethrows.
   *
   * Business rejections raised OUTSIDE the transaction (validation failures)
   * never created a transaction row, so there is nothing to commit — the
   * idempotency key records the outcome instead, which is what makes a retry
   * of a rejected request return the same answer rather than re-validating.
   */
  private async handleFailure(
    command: TransferCommand,
    transactionId: string,
    error: unknown,
    degraded: boolean,
  ): Promise<TransferResult> {
    // A duplicate that slipped past Redis and was caught by the database.
    // The correct response is the ORIGINAL transaction, not an error.
    if (error instanceof DuplicateRequestError) {
      const existing = await this.transactions.findByIdempotencyKey(
        command.initiatorUserId,
        command.idempotencyKey,
      );
      if (existing) {
        this.logger.log(
          `Duplicate caught by the database constraint for "${command.idempotencyKey}"; ` +
            `returning transaction ${existing.id}.`,
        );
        return this.fromSnapshot(existing, 'REPLAYED', degraded);
      }
    }

    if (isDomainError(error) && !error.retryable) {
      // A decision. Record it so retries replay the same answer.
      await this.idempotency.fail(
        command.initiatorUserId,
        command.idempotencyKey,
        transactionId,
        error.code,
      );

      return {
        outcome: 'FAILED',
        transactionId,
        status: 'FAILED',
        timestamp: this.clock.now(),
        amountPoisha: command.amountPoisha,
        currency: command.currency,
        failureReason: error.code,
        failureMessage: error.message,
        idempotencyDegraded: degraded,
      };
    }

    // An infrastructure fault. Nothing was decided and nothing committed, so
    // RELEASE the key — this request must remain retryable. Storing a failure
    // here would permanently reject a transfer that never actually failed.
    await this.idempotency.release(command.initiatorUserId, command.idempotencyKey);

    this.logger.error(
      `Transaction ${transactionId} aborted: ${(error as Error).message}`,
      (error as Error).stack,
    );
    throw error;
  }

  private async invalidateWalletCaches(
    senderUserId: string,
    receiverUserId: string,
    senderWalletId: string,
    receiverWalletId: string,
  ): Promise<void> {
    // Never throws — the money is already committed and IS the truth. Failing
    // the user's transfer because a cache eviction failed would be backwards.
    await this.cache.invalidate(
      ApplicationCacheKeys.walletBalanceByUser(senderUserId),
      ApplicationCacheKeys.recentTransactionsByWallet(senderWalletId),
      ApplicationCacheKeys.walletBalanceByUser(receiverUserId),
      ApplicationCacheKeys.recentTransactionsByWallet(receiverWalletId),
    );
  }

  private toReplayedResult(
    command: TransferCommand,
    record: { status: string; transactionId: string; result?: unknown; failureReason?: string },
  ): TransferResult {
    if (record.status === 'COMPLETED' && record.result) {
      return { ...(record.result as TransferResult), outcome: 'REPLAYED' };
    }
    return {
      outcome: 'REPLAYED',
      transactionId: record.transactionId,
      status: 'FAILED',
      timestamp: this.clock.now(),
      amountPoisha: command.amountPoisha,
      currency: command.currency,
      failureReason: record.failureReason ?? 'UNKNOWN',
    };
  }

  private fromSnapshot(
    snapshot: TransactionSnapshot,
    outcome: 'REPLAYED',
    degraded: boolean,
  ): TransferResult {
    return {
      outcome,
      transactionId: snapshot.id,
      status: snapshot.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
      timestamp: snapshot.completedAt ?? snapshot.createdAt,
      amountPoisha: snapshot.amountPoisha,
      currency: snapshot.currency,
      failureReason: snapshot.failureReason ?? undefined,
      completedAt: snapshot.completedAt ?? undefined,
      idempotencyDegraded: degraded,
    };
  }
}

/** Re-exported so consumers do not reach into the domain layer for it. */
export { ConcurrencyConflictError };
