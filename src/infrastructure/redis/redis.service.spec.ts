import { ConfigType } from '@nestjs/config';

import { redisConfig } from '../../config/redis.config';
import { RedisKeys } from './redis.keys';
import { RedisService } from './redis.service';
import { RedisUnavailableError } from './redis.errors';
import { RedisRateLimiterAdapter } from './adapters/redis-rate-limiter.adapter';
import { RateLimitAction } from '../../application/ports';

/**
 * These tests run with NO Redis and NO database.
 *
 * That is the point of the port boundary: the behaviour that matters —
 * BigInt-safe serialization, circuit breaking, and the fail-open policy — is
 * verifiable in milliseconds against a stub client. ARCHITECTURE.md §10 calls
 * for exactly this; infrastructure that can only be tested against live
 * infrastructure does not get tested.
 */

type StubClient = {
  get: jest.Mock;
  set: jest.Mock;
  unlink: jest.Mock;
  exists: jest.Mock;
  ttl: jest.Mock;
  incrby: jest.Mock;
  expire: jest.Mock;
  eval: jest.Mock;
  scan: jest.Mock;
  ping: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
  status: string;
};

const createStubClient = (): StubClient => ({
  get: jest.fn(),
  set: jest.fn(),
  unlink: jest.fn(),
  exists: jest.fn(),
  ttl: jest.fn(),
  incrby: jest.fn(),
  expire: jest.fn(),
  eval: jest.fn(),
  scan: jest.fn(),
  ping: jest.fn(),
  quit: jest.fn(),
  disconnect: jest.fn(),
  status: 'ready',
});

const testConfig = (): ConfigType<typeof redisConfig> =>
  ({
    host: 'localhost',
    port: 6379,
    db: 0,
    keyPrefix: 'goti:test',
    tlsEnabled: false,
    connectTimeoutMs: 5_000,
    commandTimeoutMs: 1_000,
    maxRetriesPerRequest: 2,
    circuitFailureThreshold: 3,
    circuitCooldownMs: 10_000,
    idempotency: { inFlightTtlSeconds: 60, resultTtlSeconds: 86_400 },
    rateLimit: {
      transactionMax: 100,
      transactionWindowSeconds: 60,
      fallbackMaxPerInstance: 200,
    },
    cache: {
      walletBalanceTtlSeconds: 5,
      recentTransactionsTtlSeconds: 30,
      ttlJitterSeconds: 0,
    },
  }) as ConfigType<typeof redisConfig>;

describe('RedisKeys', () => {
  it('scopes idempotency keys by user, mirroring the database unique constraint', () => {
    // Two users may legitimately send the same client-generated request id.
    // If the key were not user-scoped, one user's retry would replay the
    // OTHER user's transaction.
    const a = RedisKeys.idempotency('user-a', 'GOTI_TXN_001');
    const b = RedisKeys.idempotency('user-b', 'GOTI_TXN_001');

    expect(a).not.toEqual(b);
    expect(a).toBe('transaction:idempotency:user-a:GOTI_TXN_001');
  });

  it('lists every cache key belonging to a wallet so invalidation cannot miss one', () => {
    const keys = RedisKeys.allWalletCacheKeys('wallet-1');

    expect(keys).toContain(RedisKeys.walletBalance('wallet-1'));
    expect(keys).toContain(RedisKeys.walletRecentTransactions('wallet-1'));
  });
});

describe('RedisService serialization', () => {
  let client: StubClient;
  let service: RedisService;

  beforeEach(() => {
    client = createStubClient();
    service = new RedisService(client as never, testConfig());
  });

  it('round-trips BigInt money without throwing', async () => {
    // JSON.stringify(100n) throws. Money in Goti is BigInt poisha, so caching
    // a balance would crash at runtime without the custom replacer/reviver.
    const balance = { walletId: 'w1', balancePoisha: 10_000_000n };

    client.set.mockResolvedValue('OK');
    await service.set('cache:wallet:w1:balance', balance, 5);

    const written = client.set.mock.calls[0]![1] as string;
    expect(written).toContain('__goti_bigint__');

    client.get.mockResolvedValue(written);
    const read = await service.get<typeof balance>('cache:wallet:w1:balance');

    expect(read?.balancePoisha).toBe(10_000_000n);
    expect(typeof read?.balancePoisha).toBe('bigint');
  });

  it('distinguishes a cache miss from a failure', async () => {
    client.get.mockResolvedValue(null);
    await expect(service.get('missing')).resolves.toBeNull();

    client.get.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.get('boom')).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it('reports whether SET NX won the race', async () => {
    client.set.mockResolvedValue('OK');
    await expect(service.setIfNotExists('k', { v: 1 }, 60)).resolves.toBe('RESERVED');

    client.set.mockResolvedValue(null); // nil reply: the key already existed
    await expect(service.setIfNotExists('k', { v: 1 }, 60)).resolves.toBe('ALREADY_EXISTS');
  });
});

describe('RedisService circuit breaker', () => {
  it('opens after the failure threshold and then short-circuits without touching the socket', async () => {
    const client = createStubClient();
    const service = new RedisService(client as never, testConfig()); // threshold: 3
    client.get.mockRejectedValue(new Error('ETIMEDOUT'));

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(service.get('k')).rejects.toBeInstanceOf(RedisUnavailableError);
    }

    expect(service.isAvailable()).toBe(false);

    // With the circuit open, further calls fail immediately rather than each
    // paying a full command timeout — which is what stops a Redis outage from
    // becoming an application-wide latency incident.
    const callsBefore = client.get.mock.calls.length;
    await expect(service.get('k')).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(client.get.mock.calls.length).toBe(callsBefore);
  });
});

describe('RedisRateLimiterAdapter', () => {
  let client: StubClient;
  let limiter: RedisRateLimiterAdapter;

  beforeEach(() => {
    client = createStubClient();
    const service = new RedisService(client as never, testConfig());
    limiter = new RedisRateLimiterAdapter(service, testConfig());
  });

  it('allows a request the Lua script admits', async () => {
    client.eval.mockResolvedValue([1, 5, 5]);

    const decision = await limiter.consume(RateLimitAction.TRANSACTION, 'user-1');

    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(95);
    expect(decision.degraded).toBe(false);
  });

  it('rejects with a Retry-After when the window is full', async () => {
    client.eval.mockResolvedValue([0, 100, 100]);

    const decision = await limiter.consume(RateLimitAction.TRANSACTION, 'user-1');

    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('FAILS OPEN when Redis is unavailable, flagging the decision as degraded', async () => {
    // Rejecting real transfers because a cache is down would turn a Redis
    // incident into a payments outage. The limiter protects capacity, not
    // correctness, so it must never be able to cause one.
    client.eval.mockRejectedValue(new Error('ECONNREFUSED'));

    const decision = await limiter.consume(RateLimitAction.TRANSACTION, 'user-1');

    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);
  });

  it('still bounds a single client through the per-instance fallback', async () => {
    client.eval.mockRejectedValue(new Error('ECONNREFUSED'));

    let lastAllowed = true;
    for (let i = 0; i < 205; i++) {
      const decision = await limiter.consume(RateLimitAction.TRANSACTION, 'flooder');
      lastAllowed = decision.allowed;
    }

    // Fail-open is not unlimited: the local counter still caps one client at
    // `fallbackMaxPerInstance` (200) while Redis is unreachable.
    expect(lastAllowed).toBe(false);
  });
});
