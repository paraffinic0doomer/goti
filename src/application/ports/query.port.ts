/**
 * Query and write ports for the application modules.
 *
 * Kept separate from `repositories.port.ts`, which serves the Transaction
 * Engine's write path. These are the READ side plus the money-request
 * aggregate — different consumers, different shapes, and a change to a history
 * query should not touch the file the money path depends on.
 */

import { PersistedTransactionStatus, TransactionContext } from './repositories.port';

export const USER_WRITE_REPOSITORY = Symbol('USER_WRITE_REPOSITORY');
export const MONEY_REQUEST_REPOSITORY = Symbol('MONEY_REQUEST_REPOSITORY');
export const TRANSACTION_QUERY_REPOSITORY = Symbol('TRANSACTION_QUERY_REPOSITORY');
export const RISK_REPOSITORY = Symbol('RISK_REPOSITORY');

// ---------------------------------------------------------------------------
//  User registration
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  readonly userId: string;
  readonly walletId: string;
  readonly phone: string;
  readonly displayName: string;
  readonly email?: string | null;
  readonly passwordHash: string;
  /** Opening balance, issued as a real ledger posting — never assigned. */
  readonly openingBalancePoisha: bigint;
  readonly genesisWalletId: string;
  readonly transactionId: string;
  readonly debitEntryId: string;
  readonly creditEntryId: string;
  /**
   * Hashed security answers, written in the SAME transaction as the user.
   *
   * Structural, not a later check: an account without its questions cannot be
   * created at all, so "every user has security questions" cannot be broken by
   * a code path that forgets to enforce it.
   */
  readonly securityAnswers: readonly {
    readonly id: string;
    readonly questionKey: string;
    readonly answerHash: string;
  }[];
}

export interface UserWriteRepositoryPort {
  /**
   * Creates a user, their wallet, and the opening-balance posting — atomically.
   *
   * The opening balance is ISSUED from the genesis wallet, not assigned. A bare
   * `balance = 100000` would make `wallet_balance_drift` non-empty from the
   * user's first second, and an alarm the team learns to ignore is worse than
   * no alarm (DATABASE.md §8).
   */
  createWithWallet(input: CreateUserInput): Promise<void>;

  existsByPhone(phone: string): Promise<boolean>;

  /** The credential lookup. Returns the hash so the use case can verify it. */
  findCredentialsByPhone(
    phone: string,
  ): Promise<{ userId: string; passwordHash: string; status: string } | null>;

  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
}

// ---------------------------------------------------------------------------
//  Money requests — a claim, never money
// ---------------------------------------------------------------------------

export type MoneyRequestStatus =
  | 'REQUESTED'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface MoneyRequestSnapshot {
  readonly id: string;
  readonly requesterUserId: string;
  readonly requesterName: string;
  readonly payerUserId: string;
  readonly payerName: string;
  readonly amountPoisha: bigint;
  readonly currency: string;
  readonly note: string | null;
  readonly status: MoneyRequestStatus;
  readonly expiresAt: Date;
  readonly resolvedAt: Date | null;
  readonly settlementTransactionId: string | null;
  readonly createdAt: Date;
}

export interface CreateMoneyRequestInput {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly requesterUserId: string;
  readonly payerUserId: string;
  readonly amountPoisha: bigint;
  readonly currency: string;
  readonly note?: string | null;
  readonly expiresAt: Date;
}

export interface MoneyRequestRepositoryPort {
  create(input: CreateMoneyRequestInput): Promise<MoneyRequestSnapshot>;
  findById(id: string, context?: TransactionContext): Promise<MoneyRequestSnapshot | null>;

  /**
   * Moves a request out of REQUESTED, but ONLY from REQUESTED.
   *
   * Returns false when no row matched — the request was already resolved by a
   * concurrent call. This is the same conditional-update pattern as the balance
   * debit: the guard and the mutation are one statement, so two taps on
   * "Accept" cannot both succeed and settle a request twice.
   */
  resolveIfPending(
    id: string,
    status: Exclude<MoneyRequestStatus, 'REQUESTED'>,
    resolvedAt: Date,
    context?: TransactionContext,
  ): Promise<boolean>;

  /** Restores a claimed request after a settlement that moved no money. */
  restoreAfterFailedSettlement(id: string): Promise<boolean>;

  /** The payer's inbox, or the requester's outbox. Uses the composite indexes. */
  findForUser(
    userId: string,
    role: 'payer' | 'requester',
    status: MoneyRequestStatus | undefined,
    limit: number,
    offset: number,
    activeAt?: Date,
  ): Promise<{ items: readonly MoneyRequestSnapshot[]; total: number }>;
}

// ---------------------------------------------------------------------------
//  Transaction history — the READ side
// ---------------------------------------------------------------------------

export type TransactionDirection = 'SENT' | 'RECEIVED';

export interface TransactionHistoryItem {
  readonly transactionId: string;
  readonly direction: TransactionDirection;
  readonly counterpartyName: string;
  readonly counterpartyUserId: string | null;
  readonly amountPoisha: bigint;
  /** Signed as it affected THIS wallet: negative sent, positive received. */
  readonly signedAmountPoisha: bigint;
  readonly balanceAfterPoisha: bigint;
  readonly currency: string;
  readonly status: string;
  readonly note: string | null;
  readonly occurredAt: Date;
}

export interface TransactionHistoryQuery {
  readonly walletId: string;
  readonly limit: number;
  readonly offset: number;
  readonly direction?: TransactionDirection;
  readonly status?: PersistedTransactionStatus;
  readonly fromDate?: Date;
  readonly toDate?: Date;
  readonly sort: 'newest' | 'oldest' | 'largest' | 'smallest';
}

export interface TransactionDetail {
  readonly transactionId: string;
  readonly type: string;
  readonly status: string;
  readonly amountPoisha: bigint;
  readonly currency: string;
  readonly note: string | null;
  readonly failureReason: string | null;
  readonly senderUserId: string | null;
  readonly senderName: string | null;
  readonly receiverUserId: string | null;
  readonly receiverName: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly ledgerEntries: readonly {
    readonly walletId: string;
    readonly direction: 'DEBIT' | 'CREDIT';
    readonly amountPoisha: bigint;
    readonly balanceAfterPoisha: bigint;
  }[];
}

export interface TransactionQueryRepositoryPort {
  /**
   * A wallet's history.
   *
   * Reads `ledger_entries`, NOT `transactions` — one wallet per row means the
   * `(walletId, createdAt DESC, id)` index serves this with no `OR` and no sort
   * (DATABASE.md "Why history reads the ledger"). Querying `transactions` would
   * need `WHERE source = $1 OR dest = $1`, which forces a BitmapOr plus a sort
   * of the union.
   */
  findHistory(
    query: TransactionHistoryQuery,
  ): Promise<{ items: readonly TransactionHistoryItem[]; total: number }>;

  /** Full detail. Returns null if the transaction does not involve this wallet. */
  findDetailForWallet(
    transactionId: string,
    walletId: string,
  ): Promise<TransactionDetail | null>;
}

// ---------------------------------------------------------------------------
//  Risk
// ---------------------------------------------------------------------------

export interface CreateRiskFlagInput {
  readonly id: string;
  readonly userId: string;
  readonly transactionId?: string | null;
  readonly rule: string;
  readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly details: Record<string, unknown>;
}

export interface RiskSignals {
  /** Transfers this user initiated in the lookback window. Rule 3. */
  readonly transfersInLastHour: number;
  /** Whether the sender has ever transacted with this receiver before. Rule 2. */
  readonly hasTransactedWithReceiverBefore: boolean;
  /** Distinct receivers in the last 24h — burst-to-many is a mule pattern. */
  readonly distinctReceiversLast24h: number;
  /**
   * Days since this user's previous money movement. Rule 4.
   *
   * `null` means they have never transacted — a brand-new account, which is
   * NOT the same as a dormant one and must not be scored as if it were.
   */
  readonly daysSinceLastActivity: number | null;
}

export interface RiskFlagRecord {
  readonly id: string;
  readonly userId: string;
  readonly transactionId: string | null;
  readonly rule: string;
  readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly status: 'OPEN' | 'UNDER_REVIEW' | 'CONFIRMED' | 'DISMISSED';
  /** The evidence: which rules fired, their weights, and the numbers behind them. */
  readonly details: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface RiskRepositoryPort {
  /** All three signals in ONE round trip — risk sits on the pre-transfer path. */
  gatherSignals(senderUserId: string, receiverUserId: string): Promise<RiskSignals>;
  recordFlag(input: CreateRiskFlagInput): Promise<void>;

  /**
   * A user's own risk flags, newest first.
   *
   * Scoped to the caller by design. A flag names the rules that fired and the
   * thresholds they crossed — showing one user another's flags would hand an
   * attacker the exact detection boundaries to stay under.
   */
  findForUser(userId: string, limit: number): Promise<readonly RiskFlagRecord[]>;

  /** Counts by severity, for the monitoring dashboard. */
  countsBySeverity(userId: string): Promise<Record<string, number>>;
}
