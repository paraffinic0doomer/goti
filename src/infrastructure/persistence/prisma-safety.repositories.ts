import { Injectable } from '@nestjs/common';

import {
  CreateEnvelopeInput,
  CreatePotInput,
  EnvelopeRepositoryPort,
  EnvelopeSnapshot,
  PotRepositoryPort,
  PotSnapshot,
  PotStatus,
  SecurityTransitionInput,
  WalletSecurityEventRecord,
  WalletSecurityRepositoryPort,
} from '../../application/ports/safety.port';
import { TransactionContext, WalletStatus } from '../../application/ports/repositories.port';
import { PrismaService, clientFor } from '../prisma/prisma.service';

// ===========================================================================
//  WALLET SECURITY
// ===========================================================================

@Injectable()
export class PrismaWalletSecurityRepository implements WalletSecurityRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Compare-and-set on `wallets.status`, plus the event row, in ONE transaction.
   *
   * The `status: { in: expectedCurrentStatus }` guard is the same shape as the
   * balance debit: check and mutate in a single statement so two concurrent
   * freezes cannot both believe they succeeded. Without it the event log would
   * record two freezes for one actual transition, and the second event's
   * `previousStatus` would be a lie.
   *
   * The event is written in the same transaction as the status change, so a
   * frozen wallet ALWAYS has the event explaining why. A status with no
   * explanation is a support ticket nobody can answer.
   */
  async transitionStatus(
    input: SecurityTransitionInput,
    expectedCurrentStatus: readonly WalletStatus[],
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const freezing = input.newStatus !== 'ACTIVE';

      const { count } = await tx.wallet.updateMany({
        where: {
          id: input.walletId,
          status: { in: expectedCurrentStatus as WalletStatus[] },
        },
        data: {
          status: input.newStatus,
          // Metadata is set on freeze and CLEARED on unfreeze — a stale
          // "frozen because X" on an active wallet would be worse than none.
          freezeReason: freezing ? input.reason : null,
          frozenAt: freezing ? new Date() : null,
          frozenByUserId: freezing ? input.actorUserId : null,
          version: { increment: 1 },
        },
      });

      if (count !== 1) return false;

      await tx.walletSecurityEvent.create({
        data: {
          walletId: input.walletId,
          action: input.action,
          previousStatus: input.previousStatus,
          newStatus: input.newStatus,
          reason: input.reason,
          actorUserId: input.actorUserId,
          actorType: input.actorType,
          ipAddress: input.ipAddress ?? null,
          correlationId: input.correlationId ?? null,
        },
      });

      return true;
    });
  }

  async findEvents(walletId: string, limit: number): Promise<readonly WalletSecurityEventRecord[]> {
    const rows = await this.prisma.walletSecurityEvent.findMany({
      where: { walletId },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });

    return rows.map((row) => ({
      id: row.id.toString(),
      walletId: row.walletId,
      action: row.action,
      previousStatus: row.previousStatus,
      newStatus: row.newStatus,
      reason: row.reason,
      actorUserId: row.actorUserId,
      actorType: row.actorType,
      occurredAt: row.occurredAt,
    }));
  }
}

// ===========================================================================
//  POTS
// ===========================================================================

const POT_INCLUDE = {
  wallet: { select: { balancePoisha: true, currency: true } },
  creator: { select: { displayName: true } },
  members: {
    include: { user: { select: { displayName: true } } },
    orderBy: { contributedPoisha: 'desc' as const },
  },
};

@Injectable()
export class PrismaPotRepository implements PotRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates the pot, its wallet, and the creator's membership atomically.
   *
   * The wallet is `type = POT` with `userId = null`, so it is subject to the
   * same non-negative CHECK a user wallet is — pot money is real money held for
   * contributors, never exempt the way the genesis account is.
   */
  async create(input: CreatePotInput): Promise<PotSnapshot> {
    await this.prisma.$transaction(async (tx) => {
      await tx.wallet.create({
        data: {
          id: input.walletId,
          userId: null,
          type: 'POT',
          currency: input.currency,
          balancePoisha: 0n,
          status: 'ACTIVE',
        },
      });

      await tx.pot.create({
        data: {
          id: input.potId,
          inviteCode: input.inviteCode,
          walletId: input.walletId,
          creatorUserId: input.creatorUserId,
          name: input.name,
          note: input.note ?? null,
          targetPoisha: input.targetPoisha,
          currency: input.currency,
          status: 'OPEN',
        },
      });

      // The creator is a member from the start — otherwise they would have to
      // join their own pot before funding it.
      await tx.potMember.create({
        data: { id: input.creatorMemberId, potId: input.potId, userId: input.creatorUserId },
      });
    });

    const created = await this.findById(input.potId);
    if (!created) throw new Error(`Pot ${input.potId} vanished immediately after creation.`);
    return created;
  }

  async findById(potId: string, context?: TransactionContext): Promise<PotSnapshot | null> {
    const pot = await clientFor(this.prisma, context).pot.findUnique({
      where: { id: potId },
      include: POT_INCLUDE,
    });
    return pot ? this.toSnapshot(pot) : null;
  }

  /** Case-insensitive: a code shared over chat gets retyped in any case. */
  async findByInviteCode(inviteCode: string): Promise<PotSnapshot | null> {
    const pot = await this.prisma.pot.findUnique({
      where: { inviteCode: inviteCode.trim().toUpperCase() },
      include: POT_INCLUDE,
    });
    return pot ? this.toSnapshot(pot) : null;
  }

  async findByWalletId(walletId: string): Promise<PotSnapshot | null> {
    const pot = await this.prisma.pot.findUnique({
      where: { walletId },
      include: POT_INCLUDE,
    });
    return pot ? this.toSnapshot(pot) : null;
  }

  /** Idempotent. Returns false when the user was already a member. */
  async addMember(potId: string, userId: string, memberId: string): Promise<boolean> {
    const existing = await this.prisma.potMember.findUnique({
      where: { potId_userId: { potId, userId } },
    });
    if (existing) return false;

    try {
      await this.prisma.potMember.create({ data: { id: memberId, potId, userId } });
      return true;
    } catch {
      // Lost a race with a concurrent join. The unique index is the guarantee;
      // both callers end up members, which is the intended outcome.
      return false;
    }
  }

  async isMember(potId: string, userId: string, context?: TransactionContext): Promise<boolean> {
    const member = await clientFor(this.prisma, context).potMember.findUnique({
      where: { potId_userId: { potId, userId } },
    });
    return member !== null;
  }

  async recordContribution(
    potId: string,
    userId: string,
    amountPoisha: bigint,
    at: Date,
    context?: TransactionContext,
  ): Promise<void> {
    await clientFor(this.prisma, context).potMember.updateMany({
      where: { potId, userId },
      data: {
        contributedPoisha: { increment: amountPoisha },
        contributionCount: { increment: 1 },
        lastContributedAt: at,
      },
    });
  }

  /** Conditional on the current status, so two settles cannot both succeed. */
  async updateStatus(
    potId: string,
    status: PotStatus,
    expectedCurrent: readonly PotStatus[],
    settlement?: { transactionId: string; settledAt: Date },
  ): Promise<boolean> {
    const { count } = await this.prisma.pot.updateMany({
      where: { id: potId, status: { in: expectedCurrent as PotStatus[] } },
      data: {
        status,
        ...(settlement
          ? {
              settlementTransactionId: settlement.transactionId,
              settledAt: settlement.settledAt,
            }
          : {}),
      },
    });
    return count === 1;
  }

  async listForUser(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: readonly PotSnapshot[]; total: number }> {
    // Every pot the user is a member of — which includes the ones they created,
    // since a creator is enrolled at creation.
    const where = { members: { some: { userId } } };

    const [rows, total] = await Promise.all([
      this.prisma.pot.findMany({
        where,
        include: POT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.pot.count({ where }),
    ]);

    return { items: rows.map((row) => this.toSnapshot(row)), total };
  }

  private toSnapshot(row: {
    id: string;
    inviteCode: string;
    walletId: string;
    creatorUserId: string;
    name: string;
    note: string | null;
    targetPoisha: bigint;
    currency: string;
    status: string;
    settlementTransactionId: string | null;
    createdAt: Date;
    wallet: { balancePoisha: bigint; currency: string };
    creator: { displayName: string };
    members: {
      userId: string;
      contributedPoisha: bigint;
      contributionCount: number;
      joinedAt: Date;
      lastContributedAt: Date | null;
      user: { displayName: string };
    }[];
  }): PotSnapshot {
    return {
      id: row.id,
      inviteCode: row.inviteCode,
      walletId: row.walletId,
      creatorUserId: row.creatorUserId,
      creatorName: row.creator.displayName,
      name: row.name,
      note: row.note,
      targetPoisha: row.targetPoisha,
      // READ FROM THE WALLET. There is no `currentAmount` column, deliberately:
      // the pot's balance is a wallet balance, so reconciliation already covers
      // it and it cannot drift from the ledger.
      collectedPoisha: row.wallet.balancePoisha,
      currency: row.currency.trim(),
      status: row.status as PotStatus,
      memberCount: row.members.length,
      members: row.members.map((member) => ({
        userId: member.userId,
        displayName: member.user.displayName,
        contributedPoisha: member.contributedPoisha,
        contributionCount: member.contributionCount,
        joinedAt: member.joinedAt,
        lastContributedAt: member.lastContributedAt,
      })),
      settlementTransactionId: row.settlementTransactionId,
      createdAt: row.createdAt,
    };
  }
}

// ===========================================================================
//  EXPENSE ENVELOPES
// ===========================================================================

@Injectable()
export class PrismaEnvelopeRepository implements EnvelopeRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateEnvelopeInput): Promise<EnvelopeSnapshot> {
    const created = await this.prisma.expenseEnvelope.create({
      data: {
        id: input.envelopeId,
        walletId: input.walletId,
        name: input.name,
        category: input.category ?? null,
        icon: input.icon ?? null,
        targetPoisha: input.targetPoisha ?? null,
        reservedPoisha: 0n,
      },
    });
    return this.toSnapshot(created);
  }

  async findById(envelopeId: string): Promise<EnvelopeSnapshot | null> {
    const found = await this.prisma.expenseEnvelope.findUnique({ where: { id: envelopeId } });
    return found ? this.toSnapshot(found) : null;
  }

  async listForWallet(walletId: string): Promise<readonly EnvelopeSnapshot[]> {
    const rows = await this.prisma.expenseEnvelope.findMany({
      where: { walletId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toSnapshot(row));
  }

  async delete(envelopeId: string, walletId: string): Promise<boolean> {
    const { count } = await this.prisma.expenseEnvelope.deleteMany({
      where: { id: envelopeId, walletId },
    });
    return count === 1;
  }

  /**
   * ==========================================================================
   *  THE RESERVATION WRITE — the one place envelope state changes
   * ==========================================================================
   *
   * Moves `deltaPoisha` into (positive) or out of (negative) an envelope, and
   * mirrors it onto `wallets.reserved_poisha`, in ONE transaction under the
   * wallet's row lock.
   *
   * WHY THE LOCK
   * `wallets.reserved_poisha` is read by the conditional atomic debit. Without
   * the lock, a reservation and a transfer could interleave so that both see
   * enough balance and both proceed — the wallet would end up with
   * `reserved > balance`, meaning money fenced off that is not there.
   *
   * WHY THE GUARDS ARE IN SQL
   * Both conditions — `reserved + delta >= 0` on the envelope, and
   * `0 <= reserved + delta <= balance` on the wallet — are evaluated by
   * PostgreSQL inside the UPDATE. Checking them in TypeScript first would be a
   * read-modify-write, which under concurrency is exactly the bug this whole
   * codebase is built to avoid.
   *
   * A rejection rolls the transaction back, so the envelope and the wallet
   * aggregate can never disagree.
   */
  async adjustReservation(
    envelopeId: string,
    walletId: string,
    deltaPoisha: bigint,
  ): Promise<'APPLIED' | 'REJECTED_INSUFFICIENT' | 'REJECTED_NEGATIVE' | 'NOT_FOUND'> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialise against concurrent reservations AND against transfers,
        // which lock the same row.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM wallets WHERE id = ${walletId}::uuid FOR UPDATE
        `;
        if (locked.length === 0) return 'NOT_FOUND' as const;

        // Envelope side: a release cannot take an envelope below zero.
        const envelopeUpdated = await tx.$executeRaw`
          UPDATE expense_envelopes
             SET reserved_poisha = reserved_poisha + ${deltaPoisha}::bigint,
                 updated_at      = now()
           WHERE id = ${envelopeId}::uuid
             AND wallet_id = ${walletId}::uuid
             AND reserved_poisha + ${deltaPoisha}::bigint >= 0
        `;

        if (envelopeUpdated !== 1) {
          const exists = await tx.expenseEnvelope.count({
            where: { id: envelopeId, walletId },
          });
          return exists === 0 ? ('NOT_FOUND' as const) : ('REJECTED_NEGATIVE' as const);
        }

        // Wallet side: total reservations must stay within the balance. This is
        // what makes `spendable = balance - reserved` never go negative.
        const walletUpdated = await tx.$executeRaw`
          UPDATE wallets
             SET reserved_poisha = reserved_poisha + ${deltaPoisha}::bigint,
                 version         = version + 1,
                 updated_at      = now()
           WHERE id = ${walletId}::uuid
             AND reserved_poisha + ${deltaPoisha}::bigint >= 0
             AND reserved_poisha + ${deltaPoisha}::bigint <= balance_poisha
        `;

        if (walletUpdated !== 1) {
          // Throwing rolls back the envelope update too — the two numbers are
          // never allowed to disagree, not even momentarily.
          throw new ReservationRejected();
        }

        return 'APPLIED' as const;
      });
    } catch (error) {
      if (error instanceof ReservationRejected) return 'REJECTED_INSUFFICIENT';
      throw error;
    }
  }

  private toSnapshot(row: {
    id: string;
    walletId: string;
    name: string;
    category: string | null;
    icon: string | null;
    reservedPoisha: bigint;
    targetPoisha: bigint | null;
    createdAt: Date;
    updatedAt: Date;
  }): EnvelopeSnapshot {
    return {
      id: row.id,
      walletId: row.walletId,
      name: row.name,
      category: row.category,
      icon: row.icon,
      reservedPoisha: row.reservedPoisha,
      targetPoisha: row.targetPoisha,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** Internal signal used to roll back a reservation the wallet cannot cover. */
class ReservationRejected extends Error {
  constructor() {
    super('Reservation exceeds the wallet balance.');
  }
}
