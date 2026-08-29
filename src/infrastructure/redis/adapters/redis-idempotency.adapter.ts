import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import {
  CompletedRecord,
  FailedRecord,
  IdempotencyPort,
  IdempotencyRecord,
  ProcessingRecord,
  ReservationResult,
} from '../../../application/ports';
import { redisConfig } from '../../../config/redis.config';
import { RedisKeys } from '../redis.keys';
import { RedisService } from '../redis.service';

/**
 * Redis-backed idempotency — TIER 1 of two.
 *
 * Tier 2 is `UNIQUE (initiator_user_id, idempotency_key)` on `transactions`,
 * and it is the actual guarantee. This tier exists to absorb duplicate retries
 * cheaply so they never reach the transaction engine or the database.
 *
 * POLICY: fail open (`DEGRADED`). If Redis cannot answer, the request proceeds
 * and the database constraint decides. That is safe here and would NOT be safe
 * in a Redis-only design — which is the whole reason the second tier exists.
 *
 * THE TWO TTLs
 * ---------------------------------------------------------------------------
 * The agreed spec said "TTL: 24 hours". Applying 24h to the PROCESSING state
 * would mean a process that crashes mid-transfer holds that key for a full day,
 * and the user's legitimate retry is rejected the entire time — a self-inflicted
 * outage on one key, invisible until someone complains.
 *
 * So the TTL splits by what the value actually is:
 *
 *   PROCESSING  → 60s (`inFlightTtlSeconds`)  — a LOCK. Must outlive a normal
 *                 transaction and expire soon after a crash.
 *   COMPLETED   → 24h (`resultTtlSeconds`)    — a stored ANSWER. Must survive
 *   FAILED        long enough to replay to any realistic retry.
 *
 * The 24-hour requirement is preserved exactly where it matters: replaying the
 * outcome of a finished request.
 */
@Injectable()
export class RedisIdempotencyAdapter implements IdempotencyPort {
  private readonly logger = new Logger(RedisIdempotencyAdapter.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
  ) {}

  async reserve(
    userId: string,
    requestId: string,
    transactionId: string,
  ): Promise<ReservationResult> {
    const key = RedisKeys.idempotency(userId, requestId);

    const record: ProcessingRecord = {
      status: 'PROCESSING',
      transactionId,
      startedAt: new Date().toISOString(),
    };

    try {
      // SET NX: check and write as one atomic step. A GET followed by a SET
      // would let two concurrent retries both see "missing" and both proceed.
      const outcome = await this.redis.setIfNotExists(
        key,
        record,
        this.config.idempotency.inFlightTtlSeconds,
      );

      if (outcome === 'RESERVED') return { outcome: 'RESERVED' };

      // Someone else holds the key. Read it to find out what to tell the client.
      const existing = await this.redis.get<IdempotencyRecord>(key);

      if (existing === null) {
        // Expired between the SET NX and the GET — a genuine race, and rare.
        // Degrade rather than guess: the database constraint still decides.
        return {
          outcome: 'DEGRADED',
          reason: 'Idempotency record expired mid-check.',
        };
      }

      if (existing.status === 'PROCESSING') {
        return { outcome: 'IN_FLIGHT', record: existing };
      }

      return { outcome: 'REPLAY', record: existing };
    } catch (error) {
      // Redis is down or the circuit is open. Proceed — and say so loudly,
      // because the system is now leaning entirely on tier 2.
      this.logger.warn(
        `Idempotency check degraded for "${requestId}": ${(error as Error).message}. ` +
          'Falling through to the PostgreSQL unique constraint.',
      );
      return { outcome: 'DEGRADED', reason: (error as Error).message };
    }
  }

  async complete(
    userId: string,
    requestId: string,
    transactionId: string,
    result: unknown,
  ): Promise<void> {
    const record: CompletedRecord = {
      status: 'COMPLETED',
      transactionId,
      completedAt: new Date().toISOString(),
      result,
    };

    // Overwrites the PROCESSING lock and extends the TTL to the full result
    // window: the lock becomes the stored answer.
    await this.store(userId, requestId, record);
  }

  async fail(
    userId: string,
    requestId: string,
    transactionId: string,
    failureReason: string,
  ): Promise<void> {
    const record: FailedRecord = {
      status: 'FAILED',
      transactionId,
      completedAt: new Date().toISOString(),
      failureReason,
    };

    // A business rejection is a real, stable answer. Storing it means a retry
    // is told "insufficient funds" again rather than re-running the transfer —
    // which matters if the balance changed in between.
    await this.store(userId, requestId, record);
  }

  async release(userId: string, requestId: string): Promise<void> {
    const key = RedisKeys.idempotency(userId, requestId);

    try {
      await this.redis.delete(key);
    } catch (error) {
      // Not fatal: the PROCESSING lock expires on its own within
      // `inFlightTtlSeconds`. The retry is delayed, never lost.
      this.logger.warn(
        `Could not release idempotency key "${requestId}": ${(error as Error).message}. ` +
          `It will expire in ≤${this.config.idempotency.inFlightTtlSeconds}s.`,
      );
    }
  }

  /**
   * Writes a terminal record.
   *
   * Failures are logged and swallowed on purpose. By the time this runs the
   * transaction has already committed to PostgreSQL — the money has moved and
   * the outcome is recorded in `transactions`. Throwing here would fail a
   * request that actually succeeded, which is a far worse answer than losing
   * the fast-path replay for one key.
   */
  private async store(
    userId: string,
    requestId: string,
    record: IdempotencyRecord,
  ): Promise<void> {
    try {
      await this.redis.set(
        RedisKeys.idempotency(userId, requestId),
        record,
        this.config.idempotency.resultTtlSeconds,
      );
    } catch (error) {
      this.logger.warn(
        `Could not store idempotency result for "${requestId}": ${(error as Error).message}. ` +
          'The transaction is committed; a retry will be caught by the database constraint.',
      );
    }
  }
}
