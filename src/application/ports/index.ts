/**
 * Every port the application layer defines.
 *
 * Use cases import from here and nowhere else in the infrastructure direction.
 * A single barrel makes the Dependency Rule reviewable: an import of
 * `ioredis`, `@prisma/client` or `RedisService` anywhere under
 * `src/application` or `src/domain` is a violation, and is trivial to grep for.
 */
export * from './cache.port';
export * from './idempotency.port';
export * from './rate-limiter.port';
