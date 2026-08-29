/**
 * Repository ports — owned by the application layer (ARCHITECTURE.md §3, L1).
 *
 * These interfaces describe persistence in DOMAIN terms. No SQL, no Prisma
 * type, no `WHERE` clause crosses this boundary. The Prisma implementations
 * live in L2 and are bound to these tokens in the composition root.
 *
 * `TransactionContext` is deliberately opaque: the engine passes it between
 * repositories to keep them inside one database transaction, but it cannot
 * inspect it or open one itself. Transaction scope is owned by the UnitOfWork.
 */

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
export const TRANSACTION_REPOSITORY = Symbol('TRANSACTION_REPOSITORY');
export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');
export const TRANSACTION_EVENT_REPOSITORY = Symbol('TRANSACTION_EVENT_REPOSITORY');
export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');

/** An opaque handle to an open database transaction. Never constructed by L1. */
export interface TransactionContext {
  readonly __brand: 'TransactionContext';
}

// ---------------------------------------------------------------------------
//  Read models — plain data, no ORM types.
// ---------------------------------------------------------------------------

export type WalletStatus = 'ACTIVE' | 'FROZEN' | 'UNDER_REVIEW' | 'CLOSED';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export type PersistedTransactionStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';
export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface WalletSnapshot {
  readonly id: string;
  readonly userId: string | null;
  /** POT wallets hold group money and have no owning user. */
  readonly type: 'USER' | 'POT' | 'SYSTEM';
  readonly currency: string;
  readonly balancePoisha: bigint;
  /** Spending capacity withheld by ExpenseEnvelopes. Never moved, only fenced. */
  readonly reservedPoisha: bigint;
  readonly status: WalletStatus;
  readonly version: number;
  /** Why the wallet was frozen. Present only when status is not ACTIVE. */
  readonly freezeReason?: string | null;
}

export interface UserSnapshot {
  readonly id: string;
  readonly phone: string;
  readonly displayName: string;
  readonly status: UserStatus;
  readonly walletId: string | null;
}

export interface TransactionSnapshot {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly initiatorUserId: string;
  readonly type:
    | 'P2P_TRANSFER'
    | 'REQUEST_SETTLEMENT'
    | 'GENESIS_ISSUANCE'
    | 'REVERSAL'
    | 'POT_CONTRIBUTION'
    | 'POT_PAYOUT';
  readonly sourceWalletId: string;
  readonly destWalletId: string;
  readonly amountPoisha: bigint;
  readonly currency: string;
  readonly status: PersistedTransactionStatus;
  readonly note: string | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

// ---------------------------------------------------------------------------
//  Unit of Work — owns transaction scope
// ---------------------------------------------------------------------------

export interface UnitOfWorkOptions {
  /** Hard ceiling on how long the money transaction may hold its locks. */
  readonly timeoutMs?: number;
  /** How long to wait for a connection before giving up. */
  readonly maxWaitMs?: number;
}

export interface UnitOfWorkPort {
  /**
   * Runs `work` inside ONE database transaction.
   *
   * Commits when the callback returns, rolls back if it throws. The engine
   * never issues COMMIT or ROLLBACK itself — that authority lives here, which
   * is what guarantees a repository cannot commit half a transfer.
   *
   * Read Committed is the isolation level (DATABASE.md §4): the conditional
   * balance update re-evaluates its guard against the newest committed row
   * version, so a stricter level would add abort-retry cycles for no
   * additional guarantee.
   */
  runInTransaction<T>(
    work: (context: TransactionContext) => Promise<T>,
    options?: UnitOfWorkOptions,
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
//  Wallet repository
// ---------------------------------------------------------------------------

export interface WalletRepositoryPort {
  findById(walletId: string, context?: TransactionContext): Promise<WalletSnapshot | null>;
  findByUserId(userId: string, context?: TransactionContext): Promise<WalletSnapshot | null>;

  /**
   * Acquires row locks on the given wallets IN ASCENDING ID ORDER.
   *
   * ARCHITECTURE.md §5 Figure 4: the ordering is what makes a lock CYCLE
   * impossible, so two reciprocal transfers serialise instead of deadlocking.
   * The implementation must sort — callers must not be trusted to.
   */
  lockForUpdate(
    walletIds: readonly string[],
    context: TransactionContext,
  ): Promise<readonly WalletSnapshot[]>;

  /**
   * THE conditional atomic debit (ARCHITECTURE.md §5 Stage 3).
   *
   * Compiles to one `UPDATE ... WHERE balance >= amount AND status = 'ACTIVE'`.
   * Returns TRUE if a row changed, FALSE if the guard rejected it.
   *
   * There is deliberately no `getBalance` + `setBalance` pair on this port.
   * Offering one would invite read-modify-write, which is the lost-update bug
   * (constraint C1) that this whole design exists to make unrepresentable.
   */
  debitIfSufficient(
    walletId: string,
    amountPoisha: bigint,
    context: TransactionContext,
  ): Promise<boolean>;

  /** Unconditional credit. A credit cannot fail a balance check. */
  credit(walletId: string, amountPoisha: bigint, context: TransactionContext): Promise<void>;
}

// ---------------------------------------------------------------------------
//  User repository
// ---------------------------------------------------------------------------

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface UserRepositoryPort {
  findById(userId: string, context?: TransactionContext): Promise<UserSnapshot | null>;
  findByPhone(phone: string, context?: TransactionContext): Promise<UserSnapshot | null>;
}

// ---------------------------------------------------------------------------
//  Transaction repository
// ---------------------------------------------------------------------------

export interface CreateTransactionInput {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly initiatorUserId: string;
  readonly type: TransactionSnapshot['type'];
  readonly sourceWalletId: string;
  readonly destWalletId: string;
  readonly amountPoisha: bigint;
  readonly currency: string;
  readonly note?: string | null;
  /** Present when this movement settles a money request. */
  readonly originRequestId?: string | null;
}

export interface TransactionRepositoryPort {
  /**
   * Inserts the PENDING command record.
   *
   * THROWS `DuplicateRequestError` when the unique index on
   * `(initiator_user_id, idempotency_key)` rejects the insert. That constraint
   * is TIER 2 — the actual guarantee behind "one request = one transaction"
   * (REDIS.md §1). The Redis check only spares the database the round trip.
   */
  create(input: CreateTransactionInput, context: TransactionContext): Promise<TransactionSnapshot>;

  findById(transactionId: string, context?: TransactionContext): Promise<TransactionSnapshot | null>;

  findByIdempotencyKey(
    initiatorUserId: string,
    idempotencyKey: string,
    context?: TransactionContext,
  ): Promise<TransactionSnapshot | null>;

  markCompleted(
    transactionId: string,
    completedAt: Date,
    context: TransactionContext,
    settlement?: { originRequestId: string },
  ): Promise<void>;

  markFailed(transactionId: string, failureReason: string, context: TransactionContext): Promise<void>;

  /** Rows stranded in PENDING past the threshold. Backs the recovery sweep. */
  findStalePending(olderThan: Date, limit: number): Promise<readonly TransactionSnapshot[]>;
}

// ---------------------------------------------------------------------------
//  Ledger repository — append only. No update, no delete, by design.
// ---------------------------------------------------------------------------

export interface LedgerEntryInput {
  readonly id: string;
  readonly transactionId: string;
  readonly walletId: string;
  readonly direction: LedgerDirection;
  /** SIGNED: negative for DEBIT, positive for CREDIT, so a pair sums to zero. */
  readonly amountPoisha: bigint;
  readonly balanceAfterPoisha: bigint;
  readonly currency: string;
}

export interface LedgerRepositoryPort {
  /**
   * Appends a balanced set of postings.
   *
   * The implementation MUST reject a set whose signed amounts do not sum to
   * zero. That check is the last chance to catch an unbalanced posting before
   * it becomes permanent, immutable history.
   */
  postEntries(entries: readonly LedgerEntryInput[], context: TransactionContext): Promise<void>;

  /** Sum of a wallet's postings. The authoritative balance, used by reconciliation. */
  sumForWallet(walletId: string, context?: TransactionContext): Promise<bigint>;

  /**
   * How many postings exist for a transaction.
   *
   * The recovery sweep's safety check: a PENDING transaction with entries means
   * money actually moved, so it must NOT be marked failed.
   */
  countEntriesForTransaction(transactionId: string, context?: TransactionContext): Promise<number>;
}

// ---------------------------------------------------------------------------
//  Reconciliation — the money-integrity assertion
// ---------------------------------------------------------------------------

export const RECONCILIATION_PORT = Symbol('RECONCILIATION_PORT');

export interface ReconciliationResult {
  readonly walletsWithDrift: number;
  readonly ledgerNetPoisha: bigint;
  readonly healthy: boolean;
}

export interface ReconciliationPort {
  /**
   * Asserts that every wallet balance equals its ledger sum, and that the whole
   * ledger sums to zero.
   *
   * Backed by the `wallet_balance_drift` and `ledger_conservation_check` views
   * in `hardening.sql`, so the assertion is expressed once — in the database,
   * where the data is.
   */
  check(): Promise<ReconciliationResult>;
}

// ---------------------------------------------------------------------------
//  Transaction event repository — lifecycle log AND outbox
// ---------------------------------------------------------------------------

export type TransactionEventType =
  | 'TRANSACTION_INITIATED'
  | 'SENDER_VERIFIED'
  | 'RECEIVER_VERIFIED'
  | 'VALIDATION_PASSED'
  | 'WALLETS_LOCKED'
  | 'BALANCE_CHECKED'
  | 'PROCESSING_STARTED'
  | 'SENDER_DEBITED'
  | 'RECEIVER_CREDITED'
  | 'LEDGER_POSTED'
  | 'TRANSACTION_COMPLETED'
  | 'TRANSACTION_FAILED'
  | 'TRANSACTION_REVERSED';

export interface TransactionEventInput {
  readonly transactionId: string;
  readonly type: TransactionEventType;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  /**
   * Pre-set for internal lifecycle steps so the outbox worker skips them.
   * Left null ONLY for events that should be delivered as notifications —
   * COMPLETED, FAILED, REVERSED.
   */
  readonly publishedAt: Date | null;
}

export interface TransactionEventRecord extends TransactionEventInput {
  readonly id: bigint;
}

export interface TransactionEventRepositoryPort {
  /**
   * Appends events in ONE batched insert.
   *
   * Batched on purpose: writing seven events as seven round trips inside the
   * money transaction would multiply lock hold time on the hottest rows in the
   * system for no benefit.
   */
  appendMany(events: readonly TransactionEventInput[], context: TransactionContext): Promise<void>;

  /** The user-facing timeline — "what happened to my money?", in order. */
  findByTransactionId(transactionId: string): Promise<readonly TransactionEventRecord[]>;
}

// ---------------------------------------------------------------------------
//  Audit repository
// ---------------------------------------------------------------------------

export interface AuditLogInput {
  readonly actorUserId: string | null;
  readonly actorType: 'USER' | 'SYSTEM' | 'ADMIN';
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly correlationId?: string | null;
}

export interface AuditRepositoryPort {
  /** Inside the money transaction, so the audit trail shares its atomicity. */
  record(entry: AuditLogInput, context: TransactionContext): Promise<void>;
  /** Outside any transaction, for non-financial actions (login, PIN change). */
  recordStandalone(entry: AuditLogInput): Promise<void>;
}

// ---------------------------------------------------------------------------
//  Small ports — injected rather than called ambiently, so that time and
//  identity are controllable in tests (ARCHITECTURE.md §3, L1).
// ---------------------------------------------------------------------------

export interface ClockPort {
  now(): Date;
}

export interface IdGeneratorPort {
  /** UUIDv7 — time-ordered, so B-tree inserts stay local (DATABASE.md §6). */
  generate(): string;
}
