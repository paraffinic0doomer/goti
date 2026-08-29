/**
 * Injection tokens and shared constants for the Redis infrastructure.
 *
 * Tokens are `Symbol`s rather than strings so that two modules cannot silently
 * register providers under the same name, and so a typo becomes a compile error
 * instead of a runtime `undefined`.
 */

/** The raw ioredis client. Injected ONLY into RedisService — never elsewhere. */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

// NOTE: the CACHE_PORT / IDEMPOTENCY_PORT / RATE_LIMITER_PORT tokens are
// deliberately NOT here. They belong to `src/application/ports`, the layer that
// owns those interfaces. Defining them in infrastructure would force the
// application layer to import from infrastructure to inject its own port.

/**
 * Redis key namespaces.
 *
 * Every key in the system begins with one of these. Grouping by purpose makes
 * a production `SCAN` legible ("show me every in-flight idempotency lock") and
 * makes it obvious at a glance whether a key holds coordination state or a
 * disposable cache entry.
 */
export const KeyNamespace = {
  /** Request coordination. Losing these costs a duplicate DB round-trip, nothing more. */
  IDEMPOTENCY: 'transaction:idempotency',
  /** Abuse protection counters. Losing these opens a brief window of unthrottled traffic. */
  RATE_LIMIT: 'ratelimit',
  /** Pure cache. Losing these costs latency only. */
  CACHE: 'cache',
} as const;

export type KeyNamespaceValue = (typeof KeyNamespace)[keyof typeof KeyNamespace];

/**
 * Marker used to round-trip `BigInt` through JSON.
 *
 * Money in Goti is `BigInt` poisha (ARCHITECTURE.md §4) and
 * `JSON.stringify(100n)` throws. Without this, caching a wallet balance would
 * crash at runtime the first time a real amount was written. The marker is
 * deliberately unlikely to collide with genuine application data.
 */
export const BIGINT_JSON_MARKER = '__goti_bigint__';

/** Redis reply for a successful `SET ... NX`. A nil reply means the key existed. */
export const REDIS_SET_OK = 'OK';
