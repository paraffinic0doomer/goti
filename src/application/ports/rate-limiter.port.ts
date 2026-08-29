/**
 * Rate limiter port — owned by the application layer.
 *
 * Protects backend stability, not financial correctness. A limiter cannot
 * create or destroy money; it decides whether a request is allowed to consume
 * server resources. That distinction determines the failure policy: when Redis
 * is unavailable the limiter FAILS OPEN, because rejecting real traffic to
 * defend against hypothetical abuse turns a cache outage into an outage.
 */

/**
 * DI token. Defined HERE, in the layer that owns the interface — not in
 * infrastructure. A token living beside its implementation would mean the
 * application layer importing from infrastructure to inject its own port,
 * inverting the dependency the port exists to invert.
 */
export const RATE_LIMITER_PORT = Symbol('RATE_LIMITER_PORT');

/** Named limits, so a policy change is one edit rather than a grep across the codebase. */
export const RateLimitAction = {
  /** Money movement attempts — send, and accepting a request. */
  TRANSACTION: 'transaction_requests',
  /** Creating money requests. Cheaper, but still abusable as spam. */
  MONEY_REQUEST: 'money_requests',
  /** Authentication attempts. Tighter limits belong here. */
  AUTH: 'auth_attempts',
} as const;

export type RateLimitActionValue = (typeof RateLimitAction)[keyof typeof RateLimitAction];

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Requests permitted per window. Echoed to the client as `X-RateLimit-Limit`. */
  readonly limit: number;
  /** Requests left in the current window. Never negative. */
  readonly remaining: number;
  /** Seconds until capacity frees up. Sent as `Retry-After` on a rejection. */
  readonly retryAfterSeconds: number;
  /**
   * True when the decision came from the in-process fallback rather than Redis.
   * Surfaced so dashboards can distinguish "traffic is fine" from
   * "we stopped being able to measure traffic accurately".
   */
  readonly degraded: boolean;
}

export interface RateLimiterPort {
  /**
   * Consumes one unit of quota and reports the decision.
   *
   * Check and increment happen atomically inside Redis. Doing them as separate
   * round trips lets concurrent requests all read the same under-limit value
   * and all be admitted — precisely the burst the limiter exists to stop.
   */
  consume(
    action: RateLimitActionValue,
    userId: string,
    overrides?: { limit?: number; windowSeconds?: number },
  ): Promise<RateLimitDecision>;

  /** Reads current usage without consuming quota. For admin views and tests. */
  peek(action: RateLimitActionValue, userId: string): Promise<RateLimitDecision>;

  /** Clears a user's counter. Support tooling for a wrongly throttled customer. */
  reset(action: RateLimitActionValue, userId: string): Promise<void>;
}
