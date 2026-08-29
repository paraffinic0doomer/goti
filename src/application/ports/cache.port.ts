/**
 * Cache port — owned by the application layer (ARCHITECTURE.md §3, L1).
 *
 * The interface lives here, the Redis implementation lives in L3. That
 * inversion is what lets a use case be tested with an in-memory fake and what
 * would let Redis be replaced without touching business logic.
 *
 * Notice what this interface does NOT expose: no TTL introspection, no
 * pattern scanning, no raw commands. A port should offer the smallest surface
 * the application actually needs — every extra method is a way for
 * infrastructure detail to leak upward.
 */

/**
 * DI token. Defined HERE, in the layer that owns the interface — not in
 * infrastructure. A token living beside its implementation would mean the
 * application layer importing from infrastructure to inject its own port,
 * inverting the dependency the port exists to invert.
 */
export const CACHE_PORT = Symbol('CACHE_PORT');

export interface CachePort {
  /**
   * Reads a cached value. `null` means "not cached" — never "failed".
   *
   * An unavailable cache is reported as a miss on purpose: the caller's
   * correct response to both is identical, which is to ask the database.
   */
  get<T>(key: string): Promise<T | null>;

  /** Writes a value with a TTL. Failures are swallowed — a cache that cannot store is not an error. */
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;

  /**
   * Removes keys. Called on every write that changes cached state.
   *
   * Invalidation is a DELETE, never an UPDATE — see `RedisCacheAdapter` for
   * why writing the new value into the cache is unsafe under concurrency.
   */
  invalidate(...keys: readonly string[]): Promise<void>;

  /**
   * Read-through: return the cached value, or load it, cache it and return it.
   *
   * Concurrent misses for the same key within one instance are collapsed into
   * a single load, so a cold or newly-expired hot key cannot send a burst of
   * identical queries at PostgreSQL.
   */
  getOrLoad<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T>;
}
