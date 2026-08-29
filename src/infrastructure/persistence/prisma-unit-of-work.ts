import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  ConcurrencyConflictError,
  LockAcquisitionError,
} from '../../domain/errors/domain-errors';
import {
  TransactionContext,
  UnitOfWorkOptions,
  UnitOfWorkPort,
} from '../../application/ports/repositories.port';
import { PrismaService, toTransactionContext } from '../prisma/prisma.service';

/** PostgreSQL SQLSTATE codes that mean "contention", not "your request was wrong". */
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';
const LOCK_NOT_AVAILABLE = '55P03';
const QUERY_CANCELED = '57014';

/**
 * Owns transaction scope. THE only place COMMIT and ROLLBACK happen.
 *
 * Repositories deliberately cannot commit: they enlist in the caller's
 * transaction and nothing more. If a repository could commit, a transfer could
 * be half-committed by a repository that decided it was finished — the exact
 * partial-write failure the design exists to make impossible.
 *
 * ISOLATION LEVEL: Read Committed, deliberately (DATABASE.md §4). When an
 * UPDATE meets a row a concurrent transaction has modified, PostgreSQL blocks,
 * then RE-EVALUATES the WHERE clause against the newly committed version. The
 * `balance >= amount` guard is therefore never checked against stale data, so
 * Serializable would add abort-retry cycles for no additional guarantee.
 */
@Injectable()
export class PrismaUnitOfWork implements UnitOfWorkPort {
  private readonly logger = new Logger(PrismaUnitOfWork.name);

  constructor(private readonly prisma: PrismaService) {}

  async runInTransaction<T>(
    work: (context: TransactionContext) => Promise<T>,
    options?: UnitOfWorkOptions,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(
        async (tx) => work(toTransactionContext(tx)),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          // Hard ceiling on lock hold time. A transfer that cannot finish in
          // five seconds is contended, and holding the lock longer only spreads
          // the contention to everyone else queued behind it.
          timeout: options?.timeoutMs ?? 5_000,
          // How long to wait for a pooled connection before giving up. Failing
          // fast here keeps a saturated pool from turning into a request pile-up.
          maxWait: options?.maxWaitMs ?? 2_000,
        },
      );
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Turns driver errors into domain errors that carry a retry policy.
   *
   * The engine must be able to tell contention from a decision without pattern
   * matching on driver internals — that knowledge belongs here, in the layer
   * that already knows which database is behind the port.
   */
  private translate(error: unknown): unknown {
    const code = this.postgresCode(error);

    if (code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED) {
      // Retryable: the transaction rolled back COMPLETELY, so nothing was
      // decided and nothing was written. Trying again is safe.
      return new ConcurrencyConflictError(
        code === DEADLOCK_DETECTED
          ? 'Deadlock detected; the transaction was rolled back in full.'
          : 'Serialization failure; the transaction was rolled back in full.',
      );
    }

    if (code === LOCK_NOT_AVAILABLE || code === QUERY_CANCELED) {
      return new LockAcquisitionError([]);
    }

    // Prisma's own timeout for an interactive transaction.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028') {
      this.logger.warn('Transaction exceeded its timeout and was rolled back.');
      return new LockAcquisitionError([]);
    }

    return error;
  }

  private postgresCode(error: unknown): string | undefined {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const meta = error.meta as { code?: string } | undefined;
      return meta?.code;
    }
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return String((error as { code: unknown }).code);
    }
    return undefined;
  }
}
