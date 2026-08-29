import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import {
  RateLimitActionValue,
  RateLimitDecision,
  RateLimiterPort,
} from '../../../application/ports';
import { redisConfig } from '../../../config/redis.config';
import { RedisKeys } from '../redis.keys';
import { RedisService } from '../redis.service';

/**
 * Atomic sliding-window-counter check, executed server-side.
 *
 * Reads the previous and current window counters, computes a weighted estimate,
 * and increments only if the request is admitted — all as one indivisible
 * operation. Doing this as separate round trips would let concurrent requests
 * all read the same under-limit value and all be admitted, which is the exact
 * burst the limiter exists to prevent.
 *
 * Returns: [allowed(1|0), estimatedCount, currentWindowCount]
 */
const SLIDING_WINDOW_SCRIPT = `
local currentKey  = KEYS[1]
local previousKey = KEYS[2]
local limit       = tonumber(ARGV[1])
local windowTtl   = tonumber(ARGV[2])
local elapsedRatio = tonumber(ARGV[3])

local current  = tonumber(redis.call('GET', currentKey))  or 0
local previous = tonumber(redis.call('GET', previousKey)) or 0

-- The previous window's contribution decays as we advance through the current
-- one: 45s into a 60s window, 25% of the previous window still counts.
local estimated = (previous * (1 - elapsedRatio)) + current

if estimated >= limit then
  return { 0, math.floor(estimated), current }
end

current = redis.call('INCR', currentKey)
if current == 1 then
  -- Two windows of TTL: the current window must survive long enough to serve
  -- as "previous" for the window that follows it.
  redis.call('EXPIRE', currentKey, windowTtl * 2)
end

return { 1, math.floor(estimated) + 1, current }
`;

/** Per-instance fallback counter, used only while Redis is unavailable. */
interface FallbackCounter {
  count: number;
  windowIndex: number;
}

/**
 * Redis-backed rate limiter using a SLIDING WINDOW COUNTER.
 *
 * WHY THIS STRATEGY
 * ---------------------------------------------------------------------------
 * Three options were considered:
 *
 *   Fixed window        — one INCR + EXPIRE. Cheapest and simplest, but has a
 *                         boundary burst: 100 requests at 11:59:59 and 100 more
 *                         at 12:00:00 is 200 requests in two seconds, all
 *                         "within limit". For a transfer endpoint that is
 *                         exactly the abuse pattern the limit is meant to stop.
 *
 *   Sliding window log  — a sorted set holding a timestamp per request. Exact,
 *                         with no boundary artefact, but memory is O(requests):
 *                         100 entries per active user per window. At 800k daily
 *                         actives that is tens of millions of members to store
 *                         and trim. Precision we do not need, at a cost that
 *                         scales with traffic.
 *
 *   Sliding window      — SELECTED. Two integer counters per user; the previous
 *   counter               window is weighted by how far into the current window
 *                         we are. O(1) memory like fixed window, and no boundary
 *                         burst.
 *
 * ADVANTAGES: constant memory per user regardless of traffic; smooth limits
 * across boundaries; two small keys that expire on their own, so nothing needs
 * resetting and no sweeper is required.
 *
 * LIMITATION: it is an APPROXIMATION. It assumes requests were spread evenly
 * through the previous window, so a burst concentrated at that window's start
 * is over-counted and one at its end is under-counted — by a few percent in
 * practice. For protecting backend capacity that error is irrelevant. It would
 * NOT be acceptable for enforcing a financial quota such as a daily transfer
 * ceiling; that belongs in PostgreSQL, where it can be exact and durable.
 */
@Injectable()
export class RedisRateLimiterAdapter implements RateLimiterPort {
  private readonly logger = new Logger(RedisRateLimiterAdapter.name);

  /**
   * Per-process fallback used when Redis is unavailable.
   *
   * Bounded and cleared as windows roll over, so it cannot grow without limit.
   * It is a stampede backstop, not an accurate quota: with N replicas the
   * effective ceiling is N × the fallback limit.
   */
  private readonly fallbackCounters = new Map<string, FallbackCounter>();

  constructor(
    private readonly redis: RedisService,
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
  ) {}

  async consume(
    action: RateLimitActionValue,
    userId: string,
    overrides?: { limit?: number; windowSeconds?: number },
  ): Promise<RateLimitDecision> {
    const limit = overrides?.limit ?? this.config.rateLimit.transactionMax;
    const windowSeconds = overrides?.windowSeconds ?? this.config.rateLimit.transactionWindowSeconds;
    const windowMs = windowSeconds * 1000;

    const now = Date.now();
    const windowIndex = Math.floor(now / windowMs);
    const elapsedRatio = (now % windowMs) / windowMs;

    const currentKey = RedisKeys.rateLimitWindow(action, userId, windowIndex);
    const previousKey = RedisKeys.rateLimitWindow(action, userId, windowIndex - 1);

    try {
      const [allowed, estimated] = await this.redis.runScript<[number, number, number]>(
        SLIDING_WINDOW_SCRIPT,
        [currentKey, previousKey],
        [limit, windowSeconds, elapsedRatio.toFixed(6)],
      );

      return {
        allowed: allowed === 1,
        limit,
        remaining: Math.max(0, limit - estimated),
        retryAfterSeconds: allowed === 1 ? 0 : this.secondsUntilNextWindow(now, windowMs),
        degraded: false,
      };
    } catch (error) {
      this.logger.warn(
        `Rate limiter degraded for user "${userId}": ${(error as Error).message}. ` +
          'Using the per-instance fallback counter.',
      );
      return this.consumeFallback(action, userId, windowIndex, now, windowMs);
    }
  }

  async peek(action: RateLimitActionValue, userId: string): Promise<RateLimitDecision> {
    const limit = this.config.rateLimit.transactionMax;
    const windowMs = this.config.rateLimit.transactionWindowSeconds * 1000;

    const now = Date.now();
    const windowIndex = Math.floor(now / windowMs);
    const elapsedRatio = (now % windowMs) / windowMs;

    try {
      const [current, previous] = await Promise.all([
        this.redis.get<number>(RedisKeys.rateLimitWindow(action, userId, windowIndex)),
        this.redis.get<number>(RedisKeys.rateLimitWindow(action, userId, windowIndex - 1)),
      ]);

      const estimated = (previous ?? 0) * (1 - elapsedRatio) + (current ?? 0);

      return {
        allowed: estimated < limit,
        limit,
        remaining: Math.max(0, limit - Math.floor(estimated)),
        retryAfterSeconds: estimated < limit ? 0 : this.secondsUntilNextWindow(now, windowMs),
        degraded: false,
      };
    } catch {
      // Unknown usage is reported as full capacity with the degraded flag set,
      // so a dashboard can tell "no traffic" from "no visibility".
      return { allowed: true, limit, remaining: limit, retryAfterSeconds: 0, degraded: true };
    }
  }

  async reset(action: RateLimitActionValue, userId: string): Promise<void> {
    const windowMs = this.config.rateLimit.transactionWindowSeconds * 1000;
    const windowIndex = Math.floor(Date.now() / windowMs);

    try {
      await this.redis.delete(
        RedisKeys.rateLimitWindow(action, userId, windowIndex),
        RedisKeys.rateLimitWindow(action, userId, windowIndex - 1),
      );
      this.fallbackCounters.delete(this.fallbackKey(action, userId));
    } catch (error) {
      this.logger.warn(`Rate limit reset failed for "${userId}": ${(error as Error).message}`);
    }
  }

  /**
   * Fallback path — a fixed-window counter local to this process.
   *
   * FAIL OPEN, not closed. Rejecting every transfer because a cache is down
   * would convert a Redis incident into a payments outage; a rate limiter is
   * not on the correctness path and must never be able to cause one. The local
   * counter still stops a single client from saturating one instance, which is
   * the failure this actually needs to prevent.
   */
  private consumeFallback(
    action: RateLimitActionValue,
    userId: string,
    windowIndex: number,
    now: number,
    windowMs: number,
  ): RateLimitDecision {
    const limit = this.config.rateLimit.fallbackMaxPerInstance;
    const key = this.fallbackKey(action, userId);
    const existing = this.fallbackCounters.get(key);

    const counter: FallbackCounter =
      existing && existing.windowIndex === windowIndex
        ? { count: existing.count + 1, windowIndex }
        : { count: 1, windowIndex };

    this.fallbackCounters.set(key, counter);

    // Opportunistic cleanup: drop entries from expired windows so a Redis
    // outage cannot leak memory for every user who was active during it.
    if (this.fallbackCounters.size > 10_000) this.pruneFallbackCounters(windowIndex);

    return {
      allowed: counter.count <= limit,
      limit,
      remaining: Math.max(0, limit - counter.count),
      retryAfterSeconds: counter.count <= limit ? 0 : this.secondsUntilNextWindow(now, windowMs),
      degraded: true,
    };
  }

  private pruneFallbackCounters(currentWindowIndex: number): void {
    for (const [key, counter] of this.fallbackCounters) {
      if (counter.windowIndex < currentWindowIndex) this.fallbackCounters.delete(key);
    }
  }

  private fallbackKey(action: RateLimitActionValue, userId: string): string {
    return `${action}:${userId}`;
  }

  private secondsUntilNextWindow(now: number, windowMs: number): number {
    return Math.ceil((windowMs - (now % windowMs)) / 1000);
  }
}
