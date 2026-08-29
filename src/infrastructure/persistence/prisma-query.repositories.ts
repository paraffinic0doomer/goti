import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  CreateMoneyRequestInput,
  CreateRiskFlagInput,
  CreateUserInput,
  MoneyRequestRepositoryPort,
  MoneyRequestSnapshot,
  MoneyRequestStatus,
  RiskFlagRecord,
  RiskRepositoryPort,
  RiskSignals,
  TransactionDetail,
  TransactionHistoryItem,
  TransactionHistoryQuery,
  TransactionQueryRepositoryPort,
  UserWriteRepositoryPort,
} from '../../application/ports/query.port';
import { TransactionContext } from '../../application/ports/repositories.port';
import { RegistrationConflictError } from '../../application/errors/application-errors';
import { DuplicateRequestError } from '../../domain/errors/domain-errors';
import { PrismaService, clientFor } from '../prisma/prisma.service';

// ===========================================================================
//  User registration
// ===========================================================================

@Injectable()
export class PrismaUserWriteRepository implements UserWriteRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates the user, their wallet, and the opening-balance posting atomically.
   *
   * THE OPENING BALANCE IS ISSUED, NEVER ASSIGNED. Writing
   * `balancePoisha = 10_000_000` directly would leave the new wallet's balance
   * disagreeing with its (empty) ledger, so `wallet_balance_drift` would report
   * it from the user's first second. An alarm the team learns to ignore is
   * worse than no alarm (DATABASE.md §8).
   *
   * Instead the genesis wallet is debited and the new wallet credited, exactly
   * as the engine would do it, so the system-wide ledger sum stays zero.
   */
  async createWithWallet(input: CreateUserInput): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: input.userId,
          phone: input.phone,
          displayName: input.displayName,
          email: input.email,
          passwordHash: input.passwordHash,
          status: 'ACTIVE',
          wallet: {
            create: { id: input.walletId, type: 'USER', balancePoisha: 0n, status: 'ACTIVE' },
          },
        },
      });

      // Security answers, in the SAME transaction as the user row.
      //
      // Structural rather than a later check: an account without its security
      // questions cannot exist even momentarily, so "every user has questions"
      // cannot be broken by a future code path that forgets to enforce it.
      await tx.securityAnswer.createMany({
        data: input.securityAnswers.map((answer) => ({
          id: answer.id,
          userId: input.userId,
          questionKey: answer.questionKey as never,
          answerHash: answer.answerHash,
        })),
      });

      // An atomic decrement acquires PostgreSQL's row lock and computes the
      // returned balance from the latest committed value. A read followed by
      // `balance = old - amount` loses one decrement when two registrations
      // run concurrently.
      const genesis = await tx.wallet.update({
        where: { id: input.genesisWalletId },
        data: {
          balancePoisha: { decrement: input.openingBalancePoisha },
          version: { increment: 1 },
        },
        select: { balancePoisha: true },
      });
      const genesisAfter = genesis.balancePoisha;

      await tx.transaction.create({
        data: {
          id: input.transactionId,
          idempotencyKey: `genesis-issuance-${input.userId}`,
          initiatorUserId: input.userId,
          type: 'GENESIS_ISSUANCE',
          sourceWalletId: input.genesisWalletId,
          destWalletId: input.walletId,
          amountPoisha: input.openingBalancePoisha,
          status: 'COMPLETED',
          note: 'Opening balance',
          completedAt: new Date(),
        },
      });

      // Two legs summing to exactly zero.
      await tx.ledgerEntry.createMany({
        data: [
          {
            id: input.debitEntryId,
            transactionId: input.transactionId,
            walletId: input.genesisWalletId,
            direction: 'DEBIT',
            amountPoisha: -input.openingBalancePoisha,
            balanceAfterPoisha: genesisAfter,
          },
          {
            id: input.creditEntryId,
            transactionId: input.transactionId,
            walletId: input.walletId,
            direction: 'CREDIT',
            amountPoisha: input.openingBalancePoisha,
            balanceAfterPoisha: input.openingBalancePoisha,
          },
        ],
      });

      await tx.wallet.update({
        where: { id: input.walletId },
        data: { balancePoisha: input.openingBalancePoisha, version: { increment: 1 } },
      });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new RegistrationConflictError();
      }
      throw error;
    }
  }

  async existsByPhone(phone: string): Promise<boolean> {
    return (await this.prisma.user.count({ where: { phone } })) > 0;
  }

  async findCredentialsByPhone(
    phone: string,
  ): Promise<{ userId: string; passwordHash: string; status: string } | null> {
    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true, passwordHash: true, status: true },
    });
    return user ? { userId: user.id, passwordHash: user.passwordHash, status: user.status } : null;
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  }
}

// ===========================================================================
//  Money requests
// ===========================================================================

@Injectable()
export class PrismaMoneyRequestRepository implements MoneyRequestRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  private readonly withNames = {
    requester: { select: { displayName: true } },
    payer: { select: { displayName: true } },
    settlement: { select: { id: true } },
  };

  async create(input: CreateMoneyRequestInput): Promise<MoneyRequestSnapshot> {
    try {
      const created = await this.prisma.moneyRequest.create({
        data: {
          id: input.id,
          idempotencyKey: input.idempotencyKey,
          requesterUserId: input.requesterUserId,
          payerUserId: input.payerUserId,
          amountPoisha: input.amountPoisha,
          currency: input.currency,
          note: input.note ?? null,
          status: 'REQUESTED',
          expiresAt: input.expiresAt,
        },
        include: this.withNames,
      });
      return this.toSnapshot(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.moneyRequest.findUnique({
          where: {
            requesterUserId_idempotencyKey: {
              requesterUserId: input.requesterUserId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          include: this.withNames,
        });
        if (existing) {
          const sameRequest =
            existing.payerUserId === input.payerUserId &&
            existing.amountPoisha === input.amountPoisha &&
            existing.currency.trim() === input.currency &&
            existing.note === (input.note ?? null);
          if (sameRequest) return this.toSnapshot(existing);
          throw new DuplicateRequestError(input.idempotencyKey, existing.id);
        }
      }
      throw error;
    }
  }

  async findById(id: string, context?: TransactionContext): Promise<MoneyRequestSnapshot | null> {
    const found = await clientFor(this.prisma, context).moneyRequest.findUnique({
      where: { id },
      include: this.withNames,
    });
    return found ? this.toSnapshot(found) : null;
  }

  /**
   * Conditional status change — the same compare-and-set shape as the balance
   * debit.
   *
   * `updateMany` with `status: 'REQUESTED'` in the WHERE means two concurrent
   * "Accept" taps race for one row and exactly one wins. A read-then-write
   * would let both observe REQUESTED and both proceed, settling the request
   * twice.
   *
   */
  async resolveIfPending(
    id: string,
    status: Exclude<MoneyRequestStatus, 'REQUESTED'>,
    resolvedAt: Date,
    context?: TransactionContext,
  ): Promise<boolean> {
    const client = clientFor(this.prisma, context);

    const { count } = await client.moneyRequest.updateMany({
      where: { id, status: 'REQUESTED' },
      data: { status, resolvedAt },
    });

    return count === 1;
  }

  async restoreAfterFailedSettlement(id: string): Promise<boolean> {
    const { count } = await this.prisma.moneyRequest.updateMany({
      where: {
        id,
        status: 'ACCEPTED',
        // Never reopen a request after a transaction has actually committed.
        settlement: null,
      },
      data: { status: 'REQUESTED', resolvedAt: null },
    });

    return count === 1;
  }

  async findForUser(
    userId: string,
    role: 'payer' | 'requester',
    status: MoneyRequestStatus | undefined,
    limit: number,
    offset: number,
    activeAt?: Date,
  ): Promise<{ items: readonly MoneyRequestSnapshot[]; total: number }> {
    // Matches the composite indexes: (payerUserId, status, createdAt DESC) and
    // (requesterUserId, createdAt DESC).
    const where: Prisma.MoneyRequestWhereInput = {
      ...(role === 'payer' ? { payerUserId: userId } : { requesterUserId: userId }),
      ...(status ? { status } : {}),
      ...(status === 'REQUESTED' && activeAt ? { expiresAt: { gt: activeAt } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.moneyRequest.findMany({
        where,
        include: this.withNames,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.moneyRequest.count({ where }),
    ]);

    return { items: rows.map((row) => this.toSnapshot(row)), total };
  }

  private toSnapshot(row: {
    id: string;
    requesterUserId: string;
    payerUserId: string;
    amountPoisha: bigint;
    currency: string;
    note: string | null;
    status: string;
    expiresAt: Date;
    resolvedAt: Date | null;
    createdAt: Date;
    requester: { displayName: string };
    payer: { displayName: string };
    settlement: { id: string } | null;
  }): MoneyRequestSnapshot {
    return {
      id: row.id,
      requesterUserId: row.requesterUserId,
      requesterName: row.requester.displayName,
      payerUserId: row.payerUserId,
      payerName: row.payer.displayName,
      amountPoisha: row.amountPoisha,
      currency: row.currency.trim(),
      note: row.note,
      status: row.status as MoneyRequestStatus,
      expiresAt: row.expiresAt,
      resolvedAt: row.resolvedAt,
      settlementTransactionId: row.settlement?.id ?? null,
      createdAt: row.createdAt,
    };
  }
}

// ===========================================================================
//  Transaction history — the READ side
// ===========================================================================

@Injectable()
export class PrismaTransactionQueryRepository implements TransactionQueryRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads LEDGER ENTRIES, not transactions.
   *
   * One wallet per row means `(wallet_id, created_at DESC, id)` serves this
   * with no `OR` and no sort — a bounded index scan of exactly `limit` rows.
   * Querying `transactions` would need `WHERE source = $1 OR dest = $1`, which
   * forces a BitmapOr plus a sort of the union.
   */
  async findHistory(
    query: TransactionHistoryQuery,
  ): Promise<{ items: readonly TransactionHistoryItem[]; total: number }> {
    const where: Prisma.LedgerEntryWhereInput = {
      walletId: query.walletId,
      ...(query.direction ? { direction: query.direction === 'SENT' ? 'DEBIT' : 'CREDIT' } : {}),
      ...(query.fromDate || query.toDate
        ? {
            createdAt: {
              ...(query.fromDate ? { gte: query.fromDate } : {}),
              ...(query.toDate ? { lte: query.toDate } : {}),
            },
          }
        : {}),
      ...(query.status ? { transaction: { status: query.status } } : {}),
    };

    const orderBy: Prisma.LedgerEntryOrderByWithRelationInput[] =
      query.sort === 'oldest'
        ? [{ createdAt: 'asc' }, { id: 'asc' }]
        : query.sort === 'largest'
          ? [{ transaction: { amountPoisha: 'desc' } }, { createdAt: 'desc' }, { id: 'desc' }]
          : query.sort === 'smallest'
            ? [{ transaction: { amountPoisha: 'asc' } }, { createdAt: 'desc' }, { id: 'desc' }]
            : [{ createdAt: 'desc' }, { id: 'desc' }];

    const [rows, total] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where,
        orderBy,
        take: query.limit,
        skip: query.offset,
        include: {
          transaction: {
            select: {
              id: true,
              status: true,
              note: true,
              sourceWalletId: true,
              destWalletId: true,
              sourceWallet: { select: { user: { select: { id: true, displayName: true } } } },
              destWallet: { select: { user: { select: { id: true, displayName: true } } } },
            },
          },
        },
      }),
      this.prisma.ledgerEntry.count({ where }),
    ]);

    const items = rows.map((row): TransactionHistoryItem => {
      const sent = row.direction === 'DEBIT';
      // The counterparty is whichever side of the transfer is not this wallet.
      const counterparty = sent
        ? row.transaction.destWallet.user
        : row.transaction.sourceWallet.user;

      return {
        transactionId: row.transactionId,
        direction: sent ? 'SENT' : 'RECEIVED',
        counterpartyName: counterparty?.displayName ?? 'Goti System',
        counterpartyUserId: counterparty?.id ?? null,
        // Magnitude for display; the signed value is kept for arithmetic.
        amountPoisha: row.amountPoisha < 0n ? -row.amountPoisha : row.amountPoisha,
        signedAmountPoisha: row.amountPoisha,
        balanceAfterPoisha: row.balanceAfterPoisha,
        currency: row.currency.trim(),
        status: row.transaction.status,
        note: row.transaction.note,
        occurredAt: row.createdAt,
      };
    });

    return { items, total };
  }

  /**
   * Full detail, scoped to the caller's wallet.
   *
   * The wallet filter is part of the QUERY, not a check afterwards. A
   * transaction the caller was not party to returns null, indistinguishable
   * from one that does not exist — so transaction ids cannot be enumerated.
   */
  async findDetailForWallet(
    transactionId: string,
    walletId: string,
  ): Promise<TransactionDetail | null> {
    const found = await this.prisma.transaction.findFirst({
      where: {
        id: transactionId,
        OR: [{ sourceWalletId: walletId }, { destWalletId: walletId }],
      },
      include: {
        sourceWallet: { select: { user: { select: { id: true, displayName: true } } } },
        destWallet: { select: { user: { select: { id: true, displayName: true } } } },
        ledgerEntries: {
          select: {
            walletId: true,
            direction: true,
            amountPoisha: true,
            balanceAfterPoisha: true,
          },
        },
      },
    });

    if (!found) return null;

    return {
      transactionId: found.id,
      type: found.type,
      status: found.status,
      amountPoisha: found.amountPoisha,
      currency: found.currency.trim(),
      note: found.note,
      failureReason: found.failureReason,
      senderUserId: found.sourceWallet.user?.id ?? null,
      senderName: found.sourceWallet.user?.displayName ?? 'Goti System',
      receiverUserId: found.destWallet.user?.id ?? null,
      receiverName: found.destWallet.user?.displayName ?? 'Goti System',
      createdAt: found.createdAt,
      completedAt: found.completedAt,
      ledgerEntries: found.ledgerEntries.map((entry) => ({
        walletId: entry.walletId,
        direction: entry.direction,
        amountPoisha: entry.amountPoisha,
        balanceAfterPoisha: entry.balanceAfterPoisha,
      })),
    };
  }
}

// ===========================================================================
//  Risk signals
// ===========================================================================

@Injectable()
export class PrismaRiskRepository implements RiskRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * All three risk signals in ONE round trip.
   *
   * Risk sits on the pre-transfer path, so three separate queries would add
   * three network round trips to every send. One statement with three
   * subqueries keeps the added latency to a single hop.
   */
  async gatherSignals(senderUserId: string, receiverUserId: string): Promise<RiskSignals> {
    const rows = await this.prisma.$queryRaw<
      {
        transfers_last_hour: bigint;
        prior_with_receiver: bigint;
        distinct_receivers: bigint;
        days_since_activity: number | null;
      }[]
    >`
      SELECT
        (SELECT COUNT(*) FROM transactions
          WHERE initiator_user_id = ${senderUserId}::uuid
            AND created_at > NOW() - INTERVAL '1 hour')          AS transfers_last_hour,

        (SELECT COUNT(*) FROM transactions t
          JOIN wallets w ON w.id = t.dest_wallet_id
          WHERE t.initiator_user_id = ${senderUserId}::uuid
            AND w.user_id = ${receiverUserId}::uuid
            AND t.status = 'COMPLETED')                          AS prior_with_receiver,

        (SELECT COUNT(DISTINCT w.user_id) FROM transactions t
          JOIN wallets w ON w.id = t.dest_wallet_id
          WHERE t.initiator_user_id = ${senderUserId}::uuid
            AND t.created_at > NOW() - INTERVAL '24 hours')      AS distinct_receivers,

        (SELECT EXTRACT(DAY FROM NOW() - MAX(created_at))::int FROM transactions
          WHERE initiator_user_id = ${senderUserId}::uuid
            AND status = 'COMPLETED'
            AND type <> 'GENESIS_ISSUANCE')                       AS days_since_activity
    `;

    const row = rows[0];

    return {
      transfersInLastHour: Number(row?.transfers_last_hour ?? 0n),
      hasTransactedWithReceiverBefore: Number(row?.prior_with_receiver ?? 0n) > 0,
      distinctReceiversLast24h: Number(row?.distinct_receivers ?? 0n),
      // GENESIS_ISSUANCE is excluded above: the opening-balance posting would
      // otherwise make every brand-new account look "recently active".
      daysSinceLastActivity: row?.days_since_activity ?? null,
    };
  }

  /** Served by the `(userId, status, createdAt DESC)` composite index. */
  async findForUser(userId: string, limit: number): Promise<readonly RiskFlagRecord[]> {
    const rows = await this.prisma.riskFlag.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      transactionId: row.transactionId,
      rule: row.rule,
      severity: row.severity,
      status: row.status,
      details: (row.details ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt,
    }));
  }

  async countsBySeverity(userId: string): Promise<Record<string, number>> {
    const grouped = await this.prisma.riskFlag.groupBy({
      by: ['severity'],
      where: { userId },
      _count: { _all: true },
    });
    return Object.fromEntries(grouped.map((g) => [g.severity, g._count._all]));
  }

  async recordFlag(input: CreateRiskFlagInput): Promise<void> {
    await this.prisma.riskFlag.create({
      data: {
        id: input.id,
        userId: input.userId,
        transactionId: input.transactionId ?? null,
        rule: input.rule,
        severity: input.severity,
        status: 'OPEN',
        details: input.details as object,
      },
    });
  }
}
