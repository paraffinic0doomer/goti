import { KeyNamespace } from './redis.constants';

/**
 * Every Redis key in Goti is built here.
 *
 * Why centralise: a key built inline at one call site and rebuilt slightly
 * differently at another is a cache that silently never hits, or an
 * idempotency lock that silently never matches. Both fail *quietly*, which on
 * a money path is the worst failure mode there is. One builder per key shape
 * means the writer and the reader cannot drift apart.
 *
 * The environment prefix (`REDIS_KEY_PREFIX`) is applied by ioredis itself, so
 * these builders return the logical key and never repeat the prefix.
 */
export const RedisKeys = {
  /**
   * Idempotency record for one money movement request.
   *
   * Matches the agreed format `transaction:idempotency:{requestId}`.
   *
   * The key is scoped by user as well as request id. Idempotency keys are
   * client-generated, so two different users can pick the same string — and if
   * they did, an unscoped key would let one user's retry return the *other
   * user's* transaction. Scoping mirrors the database's
   * `UNIQUE (initiator_user_id, idempotency_key)` exactly, which matters
   * because the two tiers must agree on what "the same request" means.
   */
  idempotency(userId: string, requestId: string): string {
    return `${KeyNamespace.IDEMPOTENCY}:${userId}:${requestId}`;
  },

  /**
   * Sliding-window rate limit counter for one user, one action, one window.
   *
   * `windowIndex` is `floor(epochMs / windowMs)`. Embedding it in the key is
   * what makes expiry automatic: an old window's key simply ages out, so there
   * is no counter to reset and no sweeper to run.
   */
  rateLimitWindow(action: string, userId: string, windowIndex: number): string {
    return `${KeyNamespace.RATE_LIMIT}:${action}:${userId}:${windowIndex}`;
  },

  /** Cached wallet balance. DISPLAY ONLY — never read for an authorisation decision. */
  walletBalance(walletId: string): string {
    return `${KeyNamespace.CACHE}:wallet:${walletId}:balance`;
  },

  /** Cached recent transaction history page for a wallet. */
  walletRecentTransactions(walletId: string): string {
    return `${KeyNamespace.CACHE}:wallet:${walletId}:recent_transactions`;
  },

  /**
   * Every cache key belonging to one wallet.
   *
   * Returned as an explicit list rather than a `SCAN` pattern: invalidation
   * runs on the write path, and the write path must never wait on a cursor
   * walk. If a future key is added for a wallet, it is added here too — the
   * single place that would otherwise be forgotten.
   */
  allWalletCacheKeys(walletId: string): readonly string[] {
    return [this.walletBalance(walletId), this.walletRecentTransactions(walletId)];
  },
} as const;
