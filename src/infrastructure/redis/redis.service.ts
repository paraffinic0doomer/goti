import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { Redis } from 'ioredis';

import { redisConfig } from '../../config/redis.config';
import {
  BIGINT_JSON_MARKER,
  REDIS_CLIENT,
  REDIS_SET_OK,
} from './redis.constants';
import { RedisSerializationError, RedisUnavailableError } from './redis.errors';

/** Outcome of a conditional write. Distinguishes "someone else won" from "it failed". */
export type ReservationOutcome = 'RESERVED' | 'ALREADY_EXISTS';

interface CircuitState {
  consecutiveFailures: number;
  openedAt: number | null;
}

/**
 * The single point of contact with Redis in Goti.
 *
 * NOTHING else in the codebase imports ioredis. That rule buys three things:
 * uniform serialization (including BigInt money, which plain JSON cannot
 * represent), one place where failure policy and circuit breaking live, and a
 * seam where Redis can be swapped or stubbed wholesale.
 *
 * This class is deliberately NOT the abstraction application services consume.
 * Services depend on the ports in `src/application/ports` — `CachePort`,
 * `IdempotencyPort`, `RateLimiterPort` — which this service backs. A use case
 * that injected RedisService would know Redis exists, and that is precisely
 * the dependency ARCHITECTURE.md §3 forbids.
 *
 * Failure contract: every method throws `RedisUnavailableError` when Redis
 * cannot serve the command. It never silently returns a wrong answer, and it
 * never decides what should happen next — that is the adapter's job.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly circuit: CircuitState = { consecutiveFailures: 0, openedAt: null };

  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
  ) {}

  // =========================================================================
  //  Availability and circuit breaking
  // =========================================================================

  /**
   * Whether Redis should be attempted right now.
   *
   * When Redis is down, every request paying a full command timeout turns a
   * cache outage into an application-wide latency incident. The breaker makes
   * the failure cheap: after N consecutive failures the circuit opens and
   * calls return immediately, until a cooldown elapses and one probe is let
   * through.
   */
  isAvailable(): boolean {
    if (this.circuit.openedAt === null) return true;

    const cooledDown = Date.now() - this.circuit.openedAt >= this.config.circuitCooldownMs;
    if (cooledDown) {
      this.logger.log('Redis circuit entering half-open: probing with the next command.');
      this.circuit.openedAt = null;
      this.circuit.consecutiveFailures = 0;
      return true;
    }
    return false;
  }

  /** Connection state as reported by the driver, for health checks and diagnostics. */
  getConnectionStatus(): string {
    return this.client.status;
  }

  private recordSuccess(): void {
    if (this.circuit.consecutiveFailures > 0) {
      this.logger.log('Redis recovered; circuit closed.');
    }
    this.circuit.consecutiveFailures = 0;
    this.circuit.openedAt = null;
  }

  private recordFailure(operation: string, cause: unknown): RedisUnavailableError {
    this.circuit.consecutiveFailures += 1;

    if (
      this.circuit.openedAt === null &&
      this.circuit.consecutiveFailures >= this.config.circuitFailureThreshold
    ) {
      this.circuit.openedAt = Date.now();
      this.logger.error(
        `Redis circuit OPEN after ${this.circuit.consecutiveFailures} consecutive failures. ` +
          `Skipping Redis for ${this.config.circuitCooldownMs}ms. ` +
          'Correctness is unaffected — PostgreSQL remains the source of truth.',
      );
    }

    return new RedisUnavailableError(operation, cause);
  }

  /**
   * Runs a Redis command with breaker accounting.
   *
   * Every public method funnels through here, so there is exactly one place
   * that knows how a failure is recorded and how an error is shaped.
   */
  private async execute<T>(operation: string, command: () => Promise<T>): Promise<T> {
    if (!this.isAvailable()) {
      throw new RedisUnavailableError(`${operation} (circuit open)`);
    }

    try {
      const result = await command();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.logger.warn(`Redis "${operation}" failed: ${(error as Error).message}`);
      throw this.recordFailure(operation, error);
    }
  }

  // =========================================================================
  //  Serialization
  //
  //  Money in Goti is BigInt poisha and `JSON.stringify(100n)` throws. Every
  //  value therefore round-trips through these two functions, so caching a
  //  balance is safe by construction rather than by remembering to convert at
  //  each call site.
  // =========================================================================

  private serialize(value: unknown): string {
    return JSON.stringify(value, (_key, rawValue: unknown) =>
      typeof rawValue === 'bigint'
        ? { [BIGINT_JSON_MARKER]: rawValue.toString() }
        : rawValue,
    );
  }

  private deserialize<T>(key: string, raw: string): T {
    try {
      return JSON.parse(raw, (_key, rawValue: unknown) => {
        if (
          typeof rawValue === 'object' &&
          rawValue !== null &&
          BIGINT_JSON_MARKER in rawValue
        ) {
          return BigInt((rawValue as Record<string, string>)[BIGINT_JSON_MARKER]!);
        }
        return rawValue;
      }) as T;
    } catch (error) {
      throw new RedisSerializationError(key, error);
    }
  }

  // =========================================================================
  //  Core operations
  // =========================================================================

  /**
   * Reads a key. Returns `null` for a genuine miss.
   *
   * A miss and a failure are different things and must stay distinguishable:
   * a miss means "ask the database", a failure means "Redis is degraded".
   * Collapsing them would hide an outage behind a perfectly normal-looking
   * cache-miss rate.
   */
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.execute('GET', () => this.client.get(key));
    if (raw === null) return null;

    try {
      return this.deserialize<T>(key, raw);
    } catch (error) {
      // A shape change after a deploy. Treat as a miss, drop the poisoned key,
      // and let the database answer.
      this.logger.warn(`Discarding unreadable cache value at "${key}".`);
      void this.delete(key).catch(() => undefined);
      throw error as RedisSerializationError;
    }
  }

  /** Writes a key, optionally with a TTL in seconds. A TTL of 0 or less means no expiry. */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const payload = this.serialize(value);

    await this.execute('SET', () =>
      ttlSeconds && ttlSeconds > 0
        ? this.client.set(key, payload, 'EX', ttlSeconds)
        : this.client.set(key, payload),
    );
  }

  /**
   * Atomically writes a key ONLY if it does not already exist (`SET NX EX`).
   *
   * This single command is what makes idempotency reservation race-free.
   * A read-then-write pair cannot do it: two concurrent requests both read
   * "missing", both write, and both proceed — which on a money path is a
   * double payment. `SET NX` collapses check and write into one atomic step,
   * exactly as the conditional balance update does in PostgreSQL
   * (ARCHITECTURE.md §5 Stage 3).
   */
  async setIfNotExists<T>(
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<ReservationOutcome> {
    const reply = await this.execute('SET NX', () =>
      this.client.set(key, this.serialize(value), 'EX', ttlSeconds, 'NX'),
    );

    return reply === REDIS_SET_OK ? 'RESERVED' : 'ALREADY_EXISTS';
  }

  /**
   * Deletes keys and reports how many existed.
   *
   * Uses `UNLINK`, not `DEL`: UNLINK detaches the key immediately and reclaims
   * memory on a background thread, so removing a large value never blocks the
   * single-threaded command loop. On the write path — where invalidation
   * happens — that difference is the difference between a cache eviction and a
   * latency spike for every other client.
   */
  async delete(...keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.execute('UNLINK', () => this.client.unlink(...keys));
  }

  async exists(key: string): Promise<boolean> {
    const count = await this.execute('EXISTS', () => this.client.exists(key));
    return count > 0;
  }

  /**
   * Remaining lifetime in seconds.
   * `-1` = key exists with no expiry, `-2` = key does not exist.
   */
  async ttl(key: string): Promise<number> {
    return this.execute('TTL', () => this.client.ttl(key));
  }

  /** Atomic counter increment. Returns the value after incrementing. */
  async increment(key: string, by = 1): Promise<number> {
    return this.execute('INCRBY', () => this.client.incrby(key, by));
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    const applied = await this.execute('EXPIRE', () => this.client.expire(key, ttlSeconds));
    return applied === 1;
  }

  /**
   * Runs a Lua script atomically on the server.
   *
   * Redis executes a script as one indivisible unit, which is how the sliding
   * window limiter reads two counters and increments one without another
   * request interleaving. The alternative — several round trips guarded by
   * application logic — is a race, and a rate limiter with a race is a rate
   * limiter an attacker walks through.
   */
  async runScript<T>(
    script: string,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<T> {
    return this.execute('EVAL', () =>
      this.client.eval(script, keys.length, ...keys, ...args),
    ) as Promise<T>;
  }

  /**
   * Iterates keys matching a pattern, in batches, without blocking the server.
   *
   * This exists so that `KEYS` never appears anywhere in the codebase. `KEYS`
   * is O(N) over the entire keyspace and runs on Redis's single command
   * thread: at millions of keys it stalls EVERY other client — including the
   * idempotency check on a live payment — for the duration of the scan.
   * `SCAN` is cursor-based and bounded per call, so the server keeps serving
   * between batches.
   *
   * Even so, this is an operations and cleanup tool. It must never appear on a
   * request path; use the explicit key list from `RedisKeys` instead.
   */
  async *scanKeys(pattern: string, batchSize = 100): AsyncGenerator<string[]> {
    let cursor = '0';

    do {
      const [nextCursor, batch] = await this.execute('SCAN', () =>
        this.client.scan(cursor, 'MATCH', pattern, 'COUNT', batchSize),
      );
      cursor = nextCursor;
      if (batch.length > 0) yield batch;
    } while (cursor !== '0');
  }

  /** Round-trip liveness probe for the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      const reply = await this.execute('PING', () => this.client.ping());
      return reply === 'PONG';
    } catch {
      return false;
    }
  }

  // =========================================================================
  //  Lifecycle
  // =========================================================================

  /**
   * Closes the connection on shutdown.
   *
   * `quit()` waits for in-flight commands to finish rather than severing the
   * socket, which matters during a rolling deploy: a pod being drained should
   * finish releasing its idempotency locks before it disappears.
   */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
      this.logger.log('Redis connection closed cleanly.');
    } catch (error) {
      this.logger.warn(`Redis did not close cleanly: ${(error as Error).message}`);
      this.client.disconnect();
    }
  }
}
