/**
 * Ports for the safety and money-management features.
 *
 * Wallet freeze · group Pots · expense Envelopes.
 *
 * All three obey the rule the rest of the system already follows: the
 * application layer declares what it needs in domain terms, and infrastructure
 * supplies it. Nothing here mentions Prisma, SQL or Redis.
 */

import { TransactionContext, WalletStatus } from './repositories.port';

export const WALLET_SECURITY_REPOSITORY = Symbol('WALLET_SECURITY_REPOSITORY');
export const POT_REPOSITORY = Symbol('POT_REPOSITORY');
export const ENVELOPE_REPOSITORY = Symbol('ENVELOPE_REPOSITORY');

// ===========================================================================
//  WALLET SECURITY — emergency freeze
// ===========================================================================

export type WalletSecurityAction =
  | 'FROZEN'
  | 'UNFROZEN'
  | 'MARKED_UNDER_REVIEW'
  | 'REVIEW_CLEARED';

export interface WalletSecurityEventRecord {
  readonly id: string;
  readonly walletId: string;
  readonly action: WalletSecurityAction;
  readonly previousStatus: WalletStatus;
  readonly newStatus: WalletStatus;
  readonly reason: string;
  readonly actorUserId: string | null;
  readonly actorType: 'USER' | 'SYSTEM' | 'ADMIN';
  readonly occurredAt: Date;
}

export interface SecurityTransitionInput {
  readonly walletId: string;
  readonly action: WalletSecurityAction;
  readonly previousStatus: WalletStatus;
  readonly newStatus: WalletStatus;
  readonly reason: string;
  readonly actorUserId: string | null;
  readonly actorType: 'USER' | 'SYSTEM' | 'ADMIN';
  readonly ipAddress?: string | null;
  readonly correlationId?: string | null;
}

export interface WalletSecurityRepositoryPort {
  /**
   * Moves a wallet between security states, but ONLY from an expected current
   * status, and records the event — in one database transaction.
   *
   * `expectedCurrentStatus` makes this a compare-and-set, the same shape as the
   * balance debit. Two "freeze" taps race for one row and exactly one wins, so
   * the event log cannot record a freeze that did not actually change anything.
   *
   * Returns false when no row matched: someone else already moved it.
   */
  transitionStatus(
    input: SecurityTransitionInput,
    expectedCurrentStatus: readonly WalletStatus[],
  ): Promise<boolean>;

  /** This wallet's security history, newest first. The support view. */
  findEvents(walletId: string, limit: number): Promise<readonly WalletSecurityEventRecord[]>;
}

// ===========================================================================
//  POTS — group money collection
// ===========================================================================

export type PotStatus = 'OPEN' | 'FUNDED' | 'SETTLED' | 'CANCELLED';

export interface PotMemberSnapshot {
  readonly userId: string;
  readonly displayName: string;
  readonly contributedPoisha: bigint;
  readonly contributionCount: number;
  readonly joinedAt: Date;
  readonly lastContributedAt: Date | null;
}

export interface PotSnapshot {
  readonly id: string;
  /** The shareable code. How a non-member finds this pot at all. */
  readonly inviteCode: string;
  readonly walletId: string;
  readonly creatorUserId: string;
  readonly creatorName: string;
  readonly name: string;
  readonly note: string | null;
  readonly targetPoisha: bigint;
  /**
   * The pot's balance — read from its WALLET, never from a counter on the pot.
   * That is what keeps pot money inside the ledger's reconciliation.
   */
  readonly collectedPoisha: bigint;
  readonly currency: string;
  readonly status: PotStatus;
  readonly memberCount: number;
  readonly members: readonly PotMemberSnapshot[];
  readonly settlementTransactionId: string | null;
  readonly createdAt: Date;
}

export interface CreatePotInput {
  readonly potId: string;
  readonly inviteCode: string;
  readonly walletId: string;
  readonly creatorUserId: string;
  readonly creatorMemberId: string;
  readonly name: string;
  readonly note?: string | null;
  readonly targetPoisha: bigint;
  readonly currency: string;
}

export interface PotRepositoryPort {
  /**
   * Creates the pot AND its wallet atomically.
   *
   * A pot without a wallet has nowhere to hold money; a wallet without a pot is
   * an orphan nobody can reach. Creating them in separate transactions would
   * make both states reachable.
   */
  create(input: CreatePotInput): Promise<PotSnapshot>;

  findById(potId: string, context?: TransactionContext): Promise<PotSnapshot | null>;
  findByWalletId(walletId: string): Promise<PotSnapshot | null>;
  /** Resolves a shared code to a pot. The entry point for joining. */
  findByInviteCode(inviteCode: string): Promise<PotSnapshot | null>;

  /** Idempotent: joining twice is a no-op, not an error. */
  addMember(potId: string, userId: string, memberId: string): Promise<boolean>;
  isMember(potId: string, userId: string, context?: TransactionContext): Promise<boolean>;

  /**
   * Updates a member's running total AFTER the transfer committed.
   *
   * Deliberately a separate call rather than part of the money transaction: the
   * pot's real balance is its wallet's, so this counter is a per-member
   * breakdown. Losing an update costs a display inaccuracy the reconciler can
   * rebuild — never money.
   */
  recordContribution(
    potId: string,
    userId: string,
    amountPoisha: bigint,
    at: Date,
    context?: TransactionContext,
  ): Promise<void>;

  /** Conditional: only from the expected status, so two settles cannot both win. */
  updateStatus(
    potId: string,
    status: PotStatus,
    expectedCurrent: readonly PotStatus[],
    settlement?: { transactionId: string; settledAt: Date },
  ): Promise<boolean>;

  listForUser(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: readonly PotSnapshot[]; total: number }>;
}

// ===========================================================================
//  EXPENSE ENVELOPES — reserved spending capacity
// ===========================================================================

export interface EnvelopeSnapshot {
  readonly id: string;
  readonly walletId: string;
  readonly name: string;
  readonly category: string | null;
  readonly icon: string | null;
  readonly reservedPoisha: bigint;
  readonly targetPoisha: bigint | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateEnvelopeInput {
  readonly envelopeId: string;
  readonly walletId: string;
  readonly name: string;
  readonly category?: string | null;
  readonly icon?: string | null;
  readonly targetPoisha?: bigint | null;
}

export interface EnvelopeRepositoryPort {
  create(input: CreateEnvelopeInput): Promise<EnvelopeSnapshot>;
  findById(envelopeId: string): Promise<EnvelopeSnapshot | null>;
  listForWallet(walletId: string): Promise<readonly EnvelopeSnapshot[]>;
  delete(envelopeId: string, walletId: string): Promise<boolean>;

  /**
   * Changes an envelope's reservation and the wallet's `reserved_poisha`
   * aggregate TOGETHER, in one transaction, under the wallet's row lock.
   *
   * `deltaPoisha` is signed: positive reserves more, negative releases.
   *
   * WHY THIS MUST BE ATOMIC AND LOCKED
   * `wallets.reserved_poisha` is what the debit guard reads. If the envelope
   * row and the aggregate could drift apart, the wallet would enforce a
   * reservation that does not match any envelope — money fenced off for a
   * reason nobody can see, or worse, rent money left spendable.
   *
   * Returns REJECTED when reserving more than the spendable balance allows.
   * The check is `reserved + delta <= balance`, evaluated in the database
   * under the lock, so it cannot be decided against a stale balance.
   */
  adjustReservation(
    envelopeId: string,
    walletId: string,
    deltaPoisha: bigint,
  ): Promise<'APPLIED' | 'REJECTED_INSUFFICIENT' | 'REJECTED_NEGATIVE' | 'NOT_FOUND'>;
}
