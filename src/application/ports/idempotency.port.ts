/**
 * Idempotency port — owned by the application layer.
 *
 * READ THIS BEFORE USING IT
 * ---------------------------------------------------------------------------
 * This is the FAST PATH of a two-tier design, not the guarantee.
 *
 *   Tier 1 (this port, Redis)  — cheap, absorbs ~99% of duplicate retries
 *                                without touching PostgreSQL.
 *   Tier 2 (PostgreSQL)        — `UNIQUE (initiator_user_id, idempotency_key)`.
 *                                THE guarantee. Never optional.
 *
 * Redis alone cannot guarantee "one request = one transaction". A key can be
 * evicted under memory pressure, lost in a failover to a replica that had not
 * yet received the write, or lost on a restart without persistence. Any of
 * those turns a retry into a second payment. The database constraint has none
 * of those failure modes, which is why DATABASE.md states deduplication is
 * "enforced by the database, never by a cache that can race with itself".
 *
 * The value of this tier is load, not correctness: it stops duplicate requests
 * from reaching the transaction engine at all.
 */

/**
 * DI token. Defined HERE, in the layer that owns the interface — not in
 * infrastructure. A token living beside its implementation would mean the
 * application layer importing from infrastructure to inject its own port,
 * inverting the dependency the port exists to invert.
 */
export const IDEMPOTENCY_PORT = Symbol('IDEMPOTENCY_PORT');

/** Lifecycle of one idempotent request. Mirrors the agreed stored shape. */
export type IdempotencyStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';

interface IdempotencyRecordBase {
  readonly status: IdempotencyStatus;
  readonly transactionId: string;
}

export interface ProcessingRecord extends IdempotencyRecordBase {
  readonly status: 'PROCESSING';
  readonly startedAt: string;
}

export interface CompletedRecord extends IdempotencyRecordBase {
  readonly status: 'COMPLETED';
  readonly completedAt: string;
  /** The original response, replayed verbatim to a retry. */
  readonly result: unknown;
}

export interface FailedRecord extends IdempotencyRecordBase {
  readonly status: 'FAILED';
  readonly completedAt: string;
  /** A stable machine code, matching `transactions.failure_reason`. */
  readonly failureReason: string;
}

export type IdempotencyRecord = ProcessingRecord | CompletedRecord | FailedRecord;

/**
 * Result of attempting to claim an idempotency key.
 *
 * Four outcomes, because the caller must react differently to each. Collapsing
 * them into a boolean is how "already processing" gets mistaken for "already
 * completed" and a user is shown a result that does not exist yet.
 */
export type ReservationResult =
  /** First time seen. Proceed with the transaction. */
  | { readonly outcome: 'RESERVED' }
  /**
   * An identical request is executing right now, elsewhere.
   * Answer 409 and let the client retry — do NOT start a second transaction.
   */
  | { readonly outcome: 'IN_FLIGHT'; readonly record: ProcessingRecord }
  /** Already finished. Replay the stored outcome without touching any balance. */
  | { readonly outcome: 'REPLAY'; readonly record: CompletedRecord | FailedRecord }
  /**
   * Redis could not answer. Proceed to the transaction engine anyway.
   *
   * This is safe ONLY because the database unique constraint is the real
   * guarantee. If Redis were the only tier, this outcome would have to reject
   * the request — and a Redis outage would become a payments outage.
   */
  | { readonly outcome: 'DEGRADED'; readonly reason: string };

export interface IdempotencyPort {
  /**
   * Atomically claims the key for this request.
   *
   * Implemented with `SET NX`, not read-then-write: two concurrent retries of
   * the same request must not both observe "missing" and both proceed.
   */
  reserve(
    userId: string,
    requestId: string,
    transactionId: string,
  ): Promise<ReservationResult>;

  /** Records a successful outcome so later retries replay it instead of re-executing. */
  complete(
    userId: string,
    requestId: string,
    transactionId: string,
    result: unknown,
  ): Promise<void>;

  /**
   * Records a business failure (insufficient funds, frozen wallet).
   *
   * Stored, not released: the answer to "did my transfer go through?" is
   * "no, and here is why" — and it must stay stable across retries.
   */
  fail(
    userId: string,
    requestId: string,
    transactionId: string,
    failureReason: string,
  ): Promise<void>;

  /**
   * Releases the claim so the request can be retried immediately.
   *
   * For INFRASTRUCTURE failures only — a lock timeout, a lost database
   * connection — where nothing was decided and nothing was committed. Never
   * call this after a business decision; that would let a rejected transfer be
   * silently re-attempted.
   */
  release(userId: string, requestId: string): Promise<void>;
}
