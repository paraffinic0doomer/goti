import { Controller, Get } from '@nestjs/common';

import { Public } from '../../adapters/http/http.plumbing';

import {
  RedisHealthIndicator,
  RedisHealthReport,
} from '../redis/redis.health';

interface HealthResponse {
  readonly status: 'ok';
  readonly uptimeSeconds: number;
  readonly dependencies: {
    readonly redis: RedisHealthReport;
  };
}

/**
 * Infrastructure health endpoints.
 *
 * Contains no business logic — it receives a request, calls one indicator, and
 * shapes a response, which is the full extent of a controller's job under
 * ARCHITECTURE.md §4.
 */
@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly redisHealth: RedisHealthIndicator) {}

  /**
   * Liveness. Answers "is this process running?" and nothing more.
   *
   * Deliberately checks no dependencies: a liveness probe that fails on a
   * dependency outage causes the orchestrator to restart healthy pods, which
   * removes capacity at exactly the moment the system is under stress.
   */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness with dependency detail.
   *
   * Returns 200 even when Redis is degraded — see `RedisHealthIndicator` for
   * why. The `dependencies.redis.status` field is what monitoring alerts on.
   */
  @Get('ready')
  async ready(): Promise<HealthResponse> {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      dependencies: {
        redis: await this.redisHealth.check(),
      },
    };
  }
}
