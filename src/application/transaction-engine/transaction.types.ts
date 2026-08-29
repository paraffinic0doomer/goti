/**
 * The command and result types of the Transaction Engine.
 *
 * ARCHITECTURE.md §5: every feature that moves money — a peer-to-peer send, an
 * accepted money request, a reversal, a future top-up — enters through ONE
 * function with ONE signature. These are that signature.
 */

export interface TransferCommand {
  /** Client-supplied. Scoped to the initiator; the basis of idempotency. */
  readonly idempotencyKey: string;

  /** Whose money moves. Idempotency is scoped to this user, not the requester. */
  readonly initiatorUserId: string;

  /**
   * Who is sending. Optional ONLY when `senderWalletId` is given.
   *
   * A POT wallet has no owning user, so a pot payout addresses the sender by
   * wallet. Every user-initiated transfer still names a user.
   */
  readonly senderUserId?: string;
  /** Addresses the sender by wallet. Used for POT_PAYOUT. */
  readonly senderWalletId?: string;

  /** Exactly one of these identifies the receiver. */
  readonly receiverUserId?: string;
  readonly receiverPhone?: string;
  /** Addresses the receiver by wallet. Used for POT_CONTRIBUTION. */
  readonly receiverWalletId?: string;

  readonly amountPoisha: bigint;
  readonly currency: string;
  readonly note?: string | null;

  readonly type?:
    | 'P2P_TRANSFER'
    | 'REQUEST_SETTLEMENT'
    | 'POT_CONTRIBUTION'
    | 'POT_PAYOUT';

  /** Links a request settlement to the claim it resolves. */
  readonly originRequestId?: string | null;

  /** Request metadata for the audit trail. Never used in a business decision. */
  readonly correlationId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export type TransferOutcome =
  /** Money moved. The ledger balanced. */
  | 'COMPLETED'
  /** A business rejection. No money moved; the attempt is recorded. */
  | 'FAILED'
  /** A duplicate request. The ORIGINAL result is returned; nothing re-executed. */
  | 'REPLAYED';

export interface TransferResult {
  readonly outcome: TransferOutcome;
  readonly transactionId: string;
  readonly status: 'COMPLETED' | 'FAILED';
  /** When this terminal outcome was recorded (or originally recorded on replay). */
  readonly timestamp: Date;

  /** Balances after the movement. Absent on a rejection, which changes nothing. */
  readonly senderBalancePoisha?: bigint;
  readonly receiverBalancePoisha?: bigint;

  readonly amountPoisha: bigint;
  readonly currency: string;

  /** Stable machine code on failure — matches `transactions.failure_reason`. */
  readonly failureReason?: string;
  readonly failureMessage?: string;

  readonly completedAt?: Date;

  /**
   * True when the Redis fast path was unavailable and the request relied
   * solely on the database unique constraint. Surfaced for observability —
   * correctness is identical either way (REDIS.md §1).
   */
  readonly idempotencyDegraded?: boolean;
}
