import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { CachePort } from '../../../application/ports';
import { redisConfig } from '../../../config/redis.config';
import { RedisService } from '../redis.service';

/**
 * Redis-backed cache.
 *
 * POLICY: fail open, always. Every failure degrades to a miss, and a miss is
 * answered by PostgreSQL — which is the source of truth anyway. There is no
 * failure mode in this class that can produce a wrong balance; the worst case
 * is that the database does all the work, which is exactly what happens with
 * no cache at all.
 */
@Injectable()
export class RedisCacheAdapter implements CachePort {
  private readonly logger = new Logger(RedisCacheAdapter.name);

  /**
   * In-flight loads, keyed by cache key — single-flight / stampede protection.
   *
   * When a hot key expires, every concurrent request misses at once. Without
   * this, one expiry of `wallet:{id}:balance` on a busy wallet sends a burst of
   * identical queries at PostgreSQL — the classic cache stampede, where adding
   * a cache makes the database load spikier than having none.
   *
   * Scope is per process. With N API replicas the worst case is N concurrent
   * loads instead of one per request, which is a bound worth having and costs
   * nothing. A cross-instance lock would be stronger and is not worth the
   * complexity for reads that are already cheap.
   */
  private readonly inFlightLoads = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: RedisService,
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      return await this.redis.get<T>(key);
    } catch (error) {
      // Unavailable, or an unreadable value after a shape change. Both are a
      // miss as far as the caller is concerned.
      this.logger.debug(`Cache read degraded for "${key}": ${(error as Error).message}`);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, value, this.withJitter(ttlSeconds));
    } catch (error) {
      // A cache that cannot store is not an error the caller should handle.
      this.logger.debug(`Cache write degraded for "${key}": ${(error as Error).message}`);
    }
  }

  /**
   * Invalidation is a DELETE, never an UPDATE.
   *
   * Writing the new value into the cache looks more efficient and is unsafe.
   * Two concurrent transfers on one wallet can interleave so that the SLOWER
   * transaction writes its (older) balance into Redis last, leaving a stale
   * value that survives until its TTL — a wrong balance shown to the user with
   * no error anywhere. Deleting has no such ordering hazard: the worst
   * possible outcome is a miss, and a miss reads the truth.
   */
  async invalidate(...keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;

    try {
      await this.redis.delete(...keys);
    } catch (error) {
      // Deliberately swallowed. The write to PostgreSQL has already committed
      // and IS the truth; a surviving stale entry expires within seconds
      // because these TTLs are short by design. Failing the user's transfer
      // because a cache eviction failed would be exactly backwards.
      this.logger.warn(
        `Cache invalidation failed for [${keys.join(', ')}]: ${(error as Error).message}. ` +
          'Stale entries will expire via TTL.',
      );
    }
  }

  async getOrLoad<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    // Join an identical load already running in this process.
    const existing = this.inFlightLoads.get(key);
    if (existing) return existing as Promise<T>;

    const loading = load()
      .then(async (value) => {
        await this.set(key, value, ttlSeconds);
        return value;
      })
      .finally(() => {
        this.inFlightLoads.delete(key);
      });

    this.inFlightLoads.set(key, loading);
    return loading;
  }

  /**
   * Spreads expiry times so keys written together do not expire together.
   *
   * Without jitter, a batch of wallets cached in the same second all expire in
   * the same second, producing a synchronised stampede on a repeating cycle.
   */
  private withJitter(ttlSeconds: number): number {
    const jitterRange = this.config.cache.ttlJitterSeconds;
    if (jitterRange <= 0) return ttlSeconds;
    return ttlSeconds + Math.floor(Math.random() * (jitterRange + 1));
  }
}
