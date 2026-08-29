import { registerAs } from '@nestjs/config';

/**
 * Typed Redis configuration, resolved once at bootstrap.
 *
 * Every tunable lives here rather than at its use site, so that "how long is
 * an idempotency lock held?" has exactly one answer, discoverable by grep.
 * ARCHITECTURE.md forbids hardcoded values on the money path for the same
 * reason it forbids duplicated business rules: two copies eventually disagree.
 */
export interface RedisConfig {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly db: number;
  readonly keyPrefix: string;
  readonly tlsEnabled: boolean;

  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly maxRetriesPerRequest: number;

  readonly circuitFailureThreshold: number;
  readonly circuitCooldownMs: number;

  readonly idempotency: {
    readonly inFlightTtlSeconds: number;
    readonly resultTtlSeconds: number;
  };

  readonly rateLimit: {
    readonly transactionMax: number;
    readonly transactionWindowSeconds: number;
    readonly fallbackMaxPerInstance: number;
  };

  readonly cache: {
    readonly walletBalanceTtlSeconds: number;
    readonly recentTransactionsTtlSeconds: number;
    readonly ttlJitterSeconds: number;
  };
}

export const REDIS_CONFIG_NAMESPACE = 'redis';

/**
 * Reads an integer from the environment, failing loudly on a malformed value.
 *
 * A silent `NaN` here would surface days later as a TTL of `undefined` — a key
 * that never expires, or a rate limit that never triggers. Configuration
 * mistakes should stop the process at boot, where they are cheap to find.
 */
function readInt(name: string, rawValue: string | undefined, fallback: number): number {
  if (rawValue === undefined || rawValue.trim() === '') return fallback;

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid ${name}: expected a non-negative integer, received "${rawValue}".`,
    );
  }
  return parsed;
}

function readBool(rawValue: string | undefined, fallback: boolean): boolean {
  if (rawValue === undefined || rawValue.trim() === '') return fallback;
  return rawValue.toLowerCase() === 'true';
}

export const redisConfig = registerAs(
  REDIS_CONFIG_NAMESPACE,
  (): RedisConfig => {
    const env = process.env;

    const config: RedisConfig = {
      host: env.REDIS_HOST ?? 'localhost',
      port: readInt('REDIS_PORT', env.REDIS_PORT, 6379),
      // An empty string is not a password — normalise it away so ioredis does
      // not send an AUTH command to a server that has no auth configured.
      password: env.REDIS_PASSWORD?.trim() ? env.REDIS_PASSWORD : undefined,
      db: readInt('REDIS_DB', env.REDIS_DB, 0),
      keyPrefix: env.REDIS_KEY_PREFIX ?? 'goti:dev',
      tlsEnabled: readBool(env.REDIS_TLS_ENABLED, false),

      connectTimeoutMs: readInt('REDIS_CONNECT_TIMEOUT_MS', env.REDIS_CONNECT_TIMEOUT_MS, 5_000),
      commandTimeoutMs: readInt('REDIS_COMMAND_TIMEOUT_MS', env.REDIS_COMMAND_TIMEOUT_MS, 1_000),
      maxRetriesPerRequest: readInt(
        'REDIS_MAX_RETRIES_PER_REQUEST',
        env.REDIS_MAX_RETRIES_PER_REQUEST,
        2,
      ),

      circuitFailureThreshold: readInt(
        'REDIS_CIRCUIT_FAILURE_THRESHOLD',
        env.REDIS_CIRCUIT_FAILURE_THRESHOLD,
        5,
      ),
      circuitCooldownMs: readInt('REDIS_CIRCUIT_COOLDOWN_MS', env.REDIS_CIRCUIT_COOLDOWN_MS, 10_000),

      idempotency: {
        inFlightTtlSeconds: readInt(
          'IDEMPOTENCY_INFLIGHT_TTL_SECONDS',
          env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS,
          60,
        ),
        resultTtlSeconds: readInt(
          'IDEMPOTENCY_RESULT_TTL_SECONDS',
          env.IDEMPOTENCY_RESULT_TTL_SECONDS,
          86_400,
        ),
      },

      rateLimit: {
        transactionMax: readInt('RATE_LIMIT_TRANSACTION_MAX', env.RATE_LIMIT_TRANSACTION_MAX, 100),
        transactionWindowSeconds: readInt(
          'RATE_LIMIT_TRANSACTION_WINDOW_SECONDS',
          env.RATE_LIMIT_TRANSACTION_WINDOW_SECONDS,
          60,
        ),
        fallbackMaxPerInstance: readInt(
          'RATE_LIMIT_FALLBACK_MAX_PER_INSTANCE',
          env.RATE_LIMIT_FALLBACK_MAX_PER_INSTANCE,
          200,
        ),
      },

      cache: {
        walletBalanceTtlSeconds: readInt(
          'CACHE_WALLET_BALANCE_TTL_SECONDS',
          env.CACHE_WALLET_BALANCE_TTL_SECONDS,
          5,
        ),
        recentTransactionsTtlSeconds: readInt(
          'CACHE_RECENT_TRANSACTIONS_TTL_SECONDS',
          env.CACHE_RECENT_TRANSACTIONS_TTL_SECONDS,
          30,
        ),
        ttlJitterSeconds: readInt('CACHE_TTL_JITTER_SECONDS', env.CACHE_TTL_JITTER_SECONDS, 3),
      },
    };

    // The in-flight lock must be shorter than the stored result, or a crashed
    // process would hold a key for the full result window and reject the user's
    // legitimate retry for 24 hours.
    if (config.idempotency.inFlightTtlSeconds >= config.idempotency.resultTtlSeconds) {
      throw new Error(
        'IDEMPOTENCY_INFLIGHT_TTL_SECONDS must be shorter than IDEMPOTENCY_RESULT_TTL_SECONDS. ' +
          'The in-flight value is a lock; the result value is a cached answer.',
      );
    }

    return config;
  },
);
