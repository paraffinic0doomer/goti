/**
 * Redis failures are infrastructure facts, not business outcomes.
 *
 * `RedisService` reports what happened; each adapter decides the policy —
 * fail-open for cache and rate limiting, degrade-to-database for idempotency.
 * Keeping the two separate is what stops "Redis was slow" from ever being
 * presented to a user as "your transfer was rejected".
 */

/** Base class so a caller can catch every Redis-originated failure in one clause. */
export abstract class RedisInfrastructureError extends Error {
  protected constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/**
 * Redis could not serve the command: disconnected, timed out, or the circuit
 * breaker is open.
 *
 * This is expected under failure, not exceptional. Every adapter must handle
 * it explicitly — an unhandled instance of this reaching a controller means a
 * fallback policy was forgotten.
 */
export class RedisUnavailableError extends RedisInfrastructureError {
  constructor(readonly operation: string, cause?: unknown) {
    super(`Redis unavailable during "${operation}".`, cause);
  }
}

/**
 * A value was stored but could not be read back as the expected shape.
 *
 * Almost always a deploy where the cached shape changed without the key
 * namespace changing. Treated as a cache miss rather than a crash: the
 * database is the source of truth and can always answer.
 */
export class RedisSerializationError extends RedisInfrastructureError {
  constructor(readonly key: string, cause?: unknown) {
    super(`Failed to deserialize value at key "${key}".`, cause);
  }
}
