import { Injectable } from '@nestjs/common';

import { RedisService } from './redis.service';

export interface RedisHealthReport {
  /**
   * `up` — reachable and responding.
   * `degraded` — unreachable, or the circuit is open. The application is still
   *              serving correctly on PostgreSQL alone.
   */
  readonly status: 'up' | 'degraded';
  readonly connection: string;
  readonly circuitOpen: boolean;
  readonly latencyMs: number | null;
}

/**
 * Health reporting for Redis.
 *
 * THE IMPORTANT DECISION: a degraded Redis must NOT make the readiness probe
 * fail.
 *
 * Redis is not the source of financial truth. If an unreachable Redis marked
 * instances unready, an orchestrator would pull every healthy pod out of the
 * load balancer and turn a cache incident into a total outage — while the
 * application was still perfectly capable of moving money using PostgreSQL.
 *
 * So this reports `degraded`, loudly and visibly, and the readiness probe stays
 * green. Alert on it, page on it, but do not restart on it.
 */
@Injectable()
export class RedisHealthIndicator {
  constructor(private readonly redis: RedisService) {}

  async check(): Promise<RedisHealthReport> {
    const startedAt = Date.now();
    const reachable = await this.redis.ping();
    const latencyMs = reachable ? Date.now() - startedAt : null;

    return {
      status: reachable ? 'up' : 'degraded',
      connection: this.redis.getConnectionStatus(),
      circuitOpen: !this.redis.isAvailable(),
      latencyMs,
    };
  }
}
