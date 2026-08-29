import { Global, Logger, Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

import { redisConfig } from '../../config/redis.config';
// Port tokens come from the APPLICATION layer, which owns the interfaces.
// Infrastructure depending on application is the Dependency Rule working
// correctly — dependencies point inward.
import {
  CACHE_PORT,
  IDEMPOTENCY_PORT,
  RATE_LIMITER_PORT,
} from '../../application/ports';
import { REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';
import { RedisHealthIndicator } from './redis.health';
import { RedisCacheAdapter } from './adapters/redis-cache.adapter';
import { RedisIdempotencyAdapter } from './adapters/redis-idempotency.adapter';
import { RedisRateLimiterAdapter } from './adapters/redis-rate-limiter.adapter';

/**
 * Builds the ioredis client.
 *
 * Written by hand rather than pulling in a community Nest/Redis wrapper. Goti
 * needs `SET NX`, server-side Lua, `SCAN`, precise timeout tuning and
 * deterministic shutdown ordering; the wrappers abstract exactly those away and
 * add a dependency that must track NestJS releases. Roughly forty lines we own
 * is a better trade than a package we do not.
 */
const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [redisConfig.KEY],
  useFactory: (config: ConfigType<typeof redisConfig>): Redis => {
    const logger = new Logger('RedisClient');

    const options: RedisOptions = {
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,

      // Applied by the driver to every key, so no builder has to repeat it and
      // several environments can safely share one Redis instance.
      keyPrefix: `${config.keyPrefix}:`,

      connectTimeout: config.connectTimeoutMs,
      commandTimeout: config.commandTimeoutMs,
      maxRetriesPerRequest: config.maxRetriesPerRequest,

      // CRITICAL: do not buffer commands while disconnected.
      //
      // With the offline queue enabled (the default), commands issued during an
      // outage pile up and resolve late — so a cache lookup that should have
      // failed in 1ms instead hangs until the socket recovers, and every
      // request holds a connection while it waits. Redis is optional to
      // correctness in Goti, so failing fast is strictly better than waiting.
      enableOfflineQueue: false,

      // Connect during bootstrap so a misconfiguration is visible immediately
      // rather than on the first user request.
      lazyConnect: false,

      retryStrategy: (attempt: number): number => {
        // Exponential backoff with jitter, capped. Jitter matters: without it,
        // every replica reconnects in the same millisecond and stampedes a
        // Redis instance that is still recovering.
        const backoff = Math.min(attempt * 200, 3_000);
        const jitter = Math.floor(Math.random() * 200);
        logger.warn(`Redis reconnect attempt ${attempt}; retrying in ${backoff + jitter}ms.`);
        return backoff + jitter;
      },

      // Reconnect on a failover, when the node we are attached to has become a
      // read-only replica.
      reconnectOnError: (error: Error): boolean => error.message.includes('READONLY'),

      ...(config.tlsEnabled ? { tls: {} } : {}),
    };

    const client = new Redis(options);

    client.on('connect', () => logger.log(`Connected to Redis at ${config.host}:${config.port}`));
    client.on('ready', () => logger.log('Redis ready.'));
    client.on('close', () => logger.warn('Redis connection closed.'));
    client.on('reconnecting', () => logger.warn('Redis reconnecting…'));

    // An 'error' listener is mandatory. Without one, ioredis emits an unhandled
    // 'error' event and Node terminates the process — a Redis blip would take
    // down an application that is designed to survive Redis being absent.
    client.on('error', (error: Error) => {
      logger.error(`Redis error: ${error.message}`);
    });

    return client;
  },
};

/**
 * Infrastructure module for Redis (ARCHITECTURE.md §3, L3).
 *
 * Exports the three PORTS, plus `RedisService` for infrastructure-level
 * consumers such as health checks and maintenance jobs.
 *
 * Application services must inject the port tokens — `CACHE_PORT`,
 * `IDEMPOTENCY_PORT`, `RATE_LIMITER_PORT` — and never `RedisService`. A use
 * case holding `RedisService` knows Redis exists, which is exactly the
 * dependency the Clean Architecture boundary is there to prevent, and it makes
 * that use case untestable without a running Redis.
 *
 * `@Global` so consuming modules do not each re-import it. Justified here
 * because these are cross-cutting infrastructure concerns with a single
 * connection; it is not a pattern to copy for domain modules.
 */
@Global()
@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [
    redisClientProvider,
    RedisService,
    RedisHealthIndicator,
    { provide: CACHE_PORT, useClass: RedisCacheAdapter },
    { provide: IDEMPOTENCY_PORT, useClass: RedisIdempotencyAdapter },
    { provide: RATE_LIMITER_PORT, useClass: RedisRateLimiterAdapter },
  ],
  exports: [CACHE_PORT, IDEMPOTENCY_PORT, RATE_LIMITER_PORT, RedisService, RedisHealthIndicator],
})
export class RedisModule {}
