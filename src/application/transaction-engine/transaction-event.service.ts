import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  ClockPort,
  TRANSACTION_EVENT_REPOSITORY,
  TransactionContext,
  TransactionEventInput,
  TransactionEventRepositoryPort,
  TransactionEventType,
} from '../ports/repositories.port';

/** One step of the timeline, rendered for a person rather than a machine. */
export interface TimelineEntry {
  readonly type: TransactionEventType;
  readonly label: string;
  readonly occurredAt: Date;
  readonly detail: Record<string, unknown>;
}

/**
 * Human-readable labels.
 *
 * The user-facing question is "what happened to my money?" — an answer of
 * `SENDER_DEBITED` is a log line, not an answer. Translation lives here so the
 * enum stays a machine contract and the wording can change without a migration.
 */
const EVENT_LABELS: Readonly<Record<TransactionEventType, string>> = {
  TRANSACTION_INITIATED: 'Transaction created',
  SENDER_VERIFIED: 'Sender verified',
  RECEIVER_VERIFIED: 'Receiver verified',
  VALIDATION_PASSED: 'Validation passed',
  WALLETS_LOCKED: 'Accounts secured',
  BALANCE_CHECKED: 'Balance checked',
  PROCESSING_STARTED: 'Processing started',
  SENDER_DEBITED: 'Amount debited from sender',
  RECEIVER_CREDITED: 'Receiver credited',
  LEDGER_POSTED: 'Recorded in ledger',
  TRANSACTION_COMPLETED: 'Completed',
  TRANSACTION_FAILED: 'Failed',
  TRANSACTION_REVERSED: 'Reversed',
};

/**
 * Events that leave the system as notifications.
 *
 * Everything else is an internal lifecycle step, written with `publishedAt`
 * already set so the outbox worker skips it. This is what lets ONE table serve
 * as both the timeline and the outbox (DATABASE.md §1.2) — without it, either
 * users get seven push notifications per transfer, or a second table is needed.
 */
const DELIVERABLE_EVENTS: ReadonlySet<TransactionEventType> = new Set<TransactionEventType>([
  'TRANSACTION_COMPLETED',
  'TRANSACTION_FAILED',
  'TRANSACTION_REVERSED',
]);

/**
 * Collects lifecycle events during one transfer, then writes them once.
 *
 * WHY A COLLECTOR RATHER THAN WRITING AS WE GO
 * Each event written individually is a database round trip taken while holding
 * wallet locks. Seven events would multiply the critical section for data that
 * nobody reads synchronously. The collector accumulates in memory and the
 * processor flushes ONE batched insert immediately before commit — same
 * atomicity, one round trip.
 *
 * NOT INJECTABLE AS A SINGLETON: one instance per transaction, created by the
 * processor. A shared instance would interleave events from concurrent
 * transfers, attributing one user's steps to another's transaction.
 */
export class TransactionEventCollector {
  private readonly events: TransactionEventInput[] = [];

  constructor(
    private readonly transactionId: string,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Records a lifecycle step.
   *
   * `publishedAt` is decided here, once, from `DELIVERABLE_EVENTS` — so no
   * call site can accidentally emit a push notification for "Balance checked".
   */
  record(type: TransactionEventType, payload: Record<string, unknown> = {}): void {
    const now = this.clock.now();

    this.events.push({
      transactionId: this.transactionId,
      type,
      payload,
      occurredAt: now,
      publishedAt: DELIVERABLE_EVENTS.has(type) ? null : now,
    });
  }

  /** The events collected so far, in order. */
  drain(): readonly TransactionEventInput[] {
    return [...this.events];
  }

  get size(): number {
    return this.events.length;
  }
}

/**
 * Persists and reads transaction timelines.
 *
 * The write side is only ever called from inside the money transaction, so the
 * timeline is as atomic as the money: a transfer that committed always has its
 * events, and one that rolled back has none. A timeline that could disagree
 * with the ledger would be worse than no timeline.
 */
@Injectable()
export class TransactionEventService {
  constructor(
    @Inject(TRANSACTION_EVENT_REPOSITORY)
    private readonly events: TransactionEventRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** One collector per transaction. Never shared across concurrent transfers. */
  createCollector(transactionId: string): TransactionEventCollector {
    return new TransactionEventCollector(transactionId, this.clock);
  }

  /** Flushes a collector inside the caller's transaction. */
  async flush(
    collector: TransactionEventCollector,
    context: TransactionContext,
  ): Promise<void> {
    const events = collector.drain();
    if (events.length === 0) return;
    await this.events.appendMany(events, context);
  }

  /**
   * The user-facing answer to "what happened to my money?".
   *
   * Read from the append-only event log rather than reconstructed from the
   * transaction's current status — a status field can only say where a
   * transfer ENDED, never how it got there or where it stopped.
   */
  async getTimeline(transactionId: string): Promise<readonly TimelineEntry[]> {
    const records = await this.events.findByTransactionId(transactionId);

    return records.map((record) => ({
      type: record.type,
      label: EVENT_LABELS[record.type],
      occurredAt: record.occurredAt,
      detail: record.payload,
    }));
  }
}
