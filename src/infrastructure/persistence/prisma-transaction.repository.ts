import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { DuplicateRequestError } from '../../domain/errors/domain-errors';
import {
  CreateTransactionInput,
  TransactionContext,
  TransactionRepositoryPort,
  TransactionSnapshot,
} from '../../application/ports/repositories.port';
import { PrismaService, clientFor, fromTransactionContext } from '../prisma/prisma.service';

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class PrismaTransactionRepository implements TransactionRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inserts the PENDING command record — TIER 2 IDEMPOTENCY.
   *
   * The unique index on `(initiator_user_id, idempotency_key)` is the actual
   * guarantee behind "one request = one transaction". Unlike the Redis fast
   * path, it cannot be evicted under memory pressure, lost in a failover, or
   * dropped on a restart (REDIS.md §1).
   *
   * Translating the driver's P2002 into `DuplicateRequestError` here is the
   * repository's job: the engine reasons about domain errors, never SQLSTATE.
   */
  async create(
    input: CreateTransactionInput,
    context: TransactionContext,
  ): Promise<TransactionSnapshot> {
    const tx = fromTransactionContext(context);

    try {
      const created = await tx.transaction.create({
        data: {
          id: input.id,
          idempotencyKey: input.idempotencyKey,
          initiatorUserId: input.initiatorUserId,
          type: input.type,
          sourceWalletId: input.sourceWalletId,
          destWalletId: input.destWalletId,
          amountPoisha: input.amountPoisha,
          currency: input.currency,
          status: 'PENDING',
          note: input.note ?? null,
          originRequestId: input.originRequestId ?? null,
        },
      });
      return this.toSnapshot(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        throw new DuplicateRequestError(input.idempotencyKey);
      }
      throw error;
    }
  }

  async findById(
    transactionId: string,
    context?: TransactionContext,
  ): Promise<TransactionSnapshot | null> {
    const found = await clientFor(this.prisma, context).transaction.findUnique({
      where: { id: transactionId },
    });
    return found ? this.toSnapshot(found) : null;
  }

  async findByIdempotencyKey(
    initiatorUserId: string,
    idempotencyKey: string,
    context?: TransactionContext,
  ): Promise<TransactionSnapshot | null> {
    const found = await clientFor(this.prisma, context).transaction.findUnique({
      where: { initiatorUserId_idempotencyKey: { initiatorUserId, idempotencyKey } },
    });
    return found ? this.toSnapshot(found) : null;
  }

  async markCompleted(
    transactionId: string,
    completedAt: Date,
    context: TransactionContext,
    settlement?: { originRequestId: string },
  ): Promise<void> {
    const tx = fromTransactionContext(context);
    await tx.transaction.update({
      where: { id: transactionId },
      data: {
        status: 'COMPLETED',
        completedAt,
        ...(settlement
          ? { type: 'REQUEST_SETTLEMENT', originRequestId: settlement.originRequestId }
          : {}),
      },
    });
  }

  /**
   * Records a business rejection.
   *
   * The `goti_guard_transaction_write` trigger refuses this if the row is
   * already in a terminal state — the same rules the application's state
   * machine enforces, held independently in the database.
   */
  async markFailed(
    transactionId: string,
    failureReason: string,
    context: TransactionContext,
  ): Promise<void> {
    const tx = fromTransactionContext(context);
    await tx.transaction.update({
      where: { id: transactionId },
      data: { status: 'FAILED', failureReason },
    });
  }

  /**
   * Rows stranded in PENDING. Backs the recovery sweep.
   *
   * Served by the partial index `idx_transactions_pending`, so this never scans
   * the full transactions table however large it grows.
   */
  async findStalePending(
    olderThan: Date,
    limit: number,
  ): Promise<readonly TransactionSnapshot[]> {
    const rows = await this.prisma.transaction.findMany({
      where: { status: 'PENDING', createdAt: { lt: olderThan } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => this.toSnapshot(row));
  }

  private toSnapshot(row: {
    id: string;
    idempotencyKey: string;
    initiatorUserId: string;
    type: string;
    sourceWalletId: string;
    destWalletId: string;
    amountPoisha: bigint;
    currency: string;
    status: string;
    note: string | null;
    failureReason: string | null;
    createdAt: Date;
    completedAt: Date | null;
  }): TransactionSnapshot {
    return {
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      initiatorUserId: row.initiatorUserId,
      type: row.type as TransactionSnapshot['type'],
      sourceWalletId: row.sourceWalletId,
      destWalletId: row.destWalletId,
      amountPoisha: row.amountPoisha,
      currency: row.currency.trim(),
      status: row.status as TransactionSnapshot['status'],
      note: row.note,
      failureReason: row.failureReason,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }
}
