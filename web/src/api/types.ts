/**
 * Wire types — mirrors of what the Goti API actually returns.
 *
 * ONE RULE GOVERNS THIS WHOLE FILE:
 *
 *   Every money amount arrives as a STRING, and stays a string.
 *
 * The backend stores money as BigInt poisha and its `BigIntSerializerInterceptor`
 * emits them as strings on purpose: JavaScript's `Number` loses precision above
 * 2^53, so parsing a balance with `Number()` would reintroduce exactly the
 * floating-point imprecision the backend's integer-poisha design exists to
 * prevent. The frontend therefore never does arithmetic on these values — it
 * formats them for display and hands them back verbatim.
 *
 * Where the backend already provides a formatted string (`balanceFormatted`,
 * `amountFormatted`), that is what gets rendered. Formatting is a presentation
 * concern the backend has already settled, and re-deriving it here would be a
 * second implementation that can disagree.
 */

export interface AuthResponse {
  userId: string;
  phone: string;
  displayName: string;
  accessToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
}

export interface UserProfile {
  userId: string;
  phone: string;
  displayName: string;
  status: string;
  walletId: string | null;
}

export interface WalletView {
  walletId: string;
  userId: string;
  ownerName: string;
  /** Poisha, as a string. Never parse this into a Number. */
  balancePoisha: string;
  /** Backend-formatted for display, e.g. "100000.00 BDT". */
  balanceFormatted: string;
  currency: string;
  status: string;
}

export interface BalanceView {
  walletId: string;
  balancePoisha: string;
  balanceFormatted: string;
  currency: string;
  /** Whether this figure came from the Redis cache (≤5s stale) or PostgreSQL. */
  cached: boolean;
}

/**
 * The exact shape of `POST /wallet/send-money` and of the `transfer` inside a
 * pot contribution or a settled money request.
 *
 * A business rejection is a RESULT, not an error: the HTTP status stays 200 and
 * `status` is FAILED, so the client branches on `status` rather than on the
 * response code. The two failure fields are what make the rejections
 * distinguishable — without them, insufficient funds, a frozen wallet and an
 * unknown receiver all look identical.
 */
export interface TransferResponse {
  transactionId: string;
  status: 'COMPLETED' | 'FAILED';
  timestamp: string;
  /** Stable machine code, matching `transactions.failure_reason`. Present on FAILED. */
  failureReason?: string;
  /** Human sentence for the same rejection. */
  failureMessage?: string;
}

export type TransactionDirection = 'SENT' | 'RECEIVED';
export type TransactionStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';

export interface TransactionHistoryItem {
  transactionId: string;
  direction: TransactionDirection;
  counterpartyName: string;
  counterpartyUserId: string | null;
  amountPoisha: string;
  signedAmountPoisha: string;
  balanceAfterPoisha: string;
  currency: string;
  status: TransactionStatus;
  note: string | null;
  occurredAt: string;
  amountFormatted: string;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext?: boolean;
}

/** One step of the engine's lifecycle, from `transaction_events`. */
export interface TimelineEntry {
  type: string;
  label: string;
  occurredAt: string;
  detail: Record<string, unknown>;
}

export interface TransactionDetail {
  transactionId: string;
  type: string;
  status: TransactionStatus;
  amountPoisha: string;
  amountFormatted: string;
  currency: string;
  note: string | null;
  failureReason: string | null;
  senderUserId: string | null;
  senderName: string | null;
  receiverUserId: string | null;
  receiverName: string | null;
  createdAt: string;
  completedAt: string | null;
  ledgerEntries: {
    walletId: string;
    direction: 'DEBIT' | 'CREDIT';
    amountPoisha: string;
    balanceAfterPoisha: string;
  }[];
  timeline: TimelineEntry[];
}

export type MoneyRequestStatus =
  | 'REQUESTED'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface MoneyRequest {
  id: string;
  requesterUserId: string;
  requesterName: string;
  payerUserId: string;
  payerName: string;
  amountPoisha: string;
  currency: string;
  note: string | null;
  status: MoneyRequestStatus;
  expiresAt: string;
  resolvedAt: string | null;
  settlementTransactionId: string | null;
  createdAt: string;
}

export interface RespondToRequestResult {
  requestId: string;
  status: MoneyRequestStatus;
  transfer?: TransferResponse & { failureReason?: string; failureMessage?: string };
}

export interface HealthReport {
  status: 'ok';
  uptimeSeconds: number;
  dependencies: {
    redis: {
      status: 'up' | 'degraded';
      connection: string;
      circuitOpen: boolean;
      latencyMs: number | null;
    };
  };
}

/**
 * The error envelope produced by `DomainExceptionFilter`.
 *
 * `code` is the stable machine identifier and is what the UI branches on.
 * `message` is for the user, `correlationId` is what they quote to support,
 * and `retryable` tells the UI whether offering "try again" is honest.
 */
export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  retryable: boolean;
  correlationId: string | null;
  timestamp: string;
  details?: unknown;
}

// ===========================================================================
//  Safety features — freeze, envelopes, pots
// ===========================================================================

export type WalletSecurityStatus = 'ACTIVE' | 'FROZEN' | 'UNDER_REVIEW' | 'CLOSED';

export interface WalletSecurityEvent {
  id: string;
  action: 'FROZEN' | 'UNFROZEN' | 'MARKED_UNDER_REVIEW' | 'REVIEW_CLEARED';
  previousStatus: WalletSecurityStatus;
  newStatus: WalletSecurityStatus;
  reason: string;
  occurredAt: string;
}

export interface WalletSecurityView {
  walletId: string;
  status: WalletSecurityStatus;
  freezeReason: string | null;
  canSend: boolean;
  /** A frozen wallet still receives — a freeze stops leaks, not salaries. */
  canReceive: boolean;
  canSelfUnfreeze: boolean;
  history: WalletSecurityEvent[];
}

export interface Envelope {
  id: string;
  walletId: string;
  name: string;
  category: string | null;
  icon: string | null;
  reservedPoisha: string;
  reservedFormatted: string;
  targetPoisha: string | null;
  targetFormatted: string | null;
  progressPercent: number | null;
}

/**
 * The full budget picture, returned by EVERY envelope endpoint.
 *
 * All four figures arrive together so the client never re-derives spendable
 * balance itself — that calculation is the backend's, and a second
 * implementation here could disagree with the one the debit guard enforces.
 */
export interface WalletBudget {
  walletId: string;
  balancePoisha: string;
  balanceFormatted: string;
  reservedPoisha: string;
  reservedFormatted: string;
  spendablePoisha: string;
  spendableFormatted: string;
  currency: string;
  envelopes: Envelope[];
}

export type PotStatus = 'OPEN' | 'FUNDED' | 'SETTLED' | 'CANCELLED';

export interface PotMember {
  userId: string;
  displayName: string;
  contributedPoisha: string;
  contributionCount: number;
  joinedAt: string;
  lastContributedAt: string | null;
}

/** What a code-holder sees BEFORE joining — no member list, no amounts. */
export interface PotPreview {
  id: string;
  name: string;
  note: string | null;
  creatorName: string;
  targetPoisha: string;
  collectedPoisha: string;
  currency: string;
  status: PotStatus;
  memberCount: number;
  alreadyMember: boolean;
}

export interface Pot {
  id: string;
  /** Shareable code — the only way a non-member discovers this pot. */
  inviteCode: string;
  walletId: string;
  creatorUserId: string;
  creatorName: string;
  name: string;
  note: string | null;
  targetPoisha: string;
  /** Read from the pot's WALLET — never a counter that could drift. */
  collectedPoisha: string;
  currency: string;
  status: PotStatus;
  memberCount: number;
  members: PotMember[];
  settlementTransactionId: string | null;
  createdAt: string;
}

/** One rule that fired, with the evidence behind it. */
export interface TriggeredRule {
  rule: string;
  explanation: string;
  weight: number;
  evidence?: Record<string, unknown>;
}

export interface RiskFlag {
  id: string;
  transactionId: string | null;
  rule: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'OPEN' | 'UNDER_REVIEW' | 'CONFIRMED' | 'DISMISSED';
  score: number;
  triggeredRules: TriggeredRule[];
  createdAt: string;
}

/**
 * Flags plus the POLICY that produced them.
 *
 * The thresholds ship with the data so the UI can explain the scale honestly —
 * "score 70, HIGH starts at 60, blocking starts at 90" — rather than showing a
 * number with no frame of reference.
 */
export interface RiskFlagsView {
  flags: RiskFlag[];
  counts: { LOW: number; MEDIUM: number; HIGH: number; CRITICAL: number };
  policy: {
    mediumAt: number;
    highAt: number;
    blockAt: number;
    rules: { rule: string; maxWeight: number }[];
  };
}

// ===========================================================================
//  Security questions — the knowledge factor
// ===========================================================================

export type SecurityQuestionKey =
  | 'FIRST_SCHOOL' | 'BEST_FRIEND_NAME' | 'BIRTH_CITY'
  | 'MOTHERS_MAIDEN_NAME' | 'FIRST_PET' | 'CHILDHOOD_NICKNAME';

export interface SecurityQuestionCatalogue {
  questions: { key: SecurityQuestionKey; prompt: string }[];
  required: number;
}

export interface SecurityAnswerInput {
  questionKey: SecurityQuestionKey;
  answer: string;
}

/**
 * The challenge, delivered inside a 428 error body.
 *
 * It arrives as an ERROR rather than a success payload because the request the
 * user made did not happen — a precondition is unmet. Treating it as a normal
 * response would mean every caller had to remember to check for it.
 */
export interface SecurityChallenge {
  challengeId: string;
  questionKey: SecurityQuestionKey;
  prompt: string;
  expiresAt: string;
}

export interface AnswerChallengeResult {
  outcome: 'PASSED' | 'FAILED';
  purpose: 'TRANSFER' | 'UNFREEZE';
  walletFrozen: boolean;
  lockedOut: boolean;
  message: string;
}
