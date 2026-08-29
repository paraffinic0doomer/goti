import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { HttpApiModule } from './adapters/http/http-api.module';
import { redisConfig } from './config/redis.config';
import { HealthController } from './infrastructure/health/health.controller';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { SecurityModule } from './infrastructure/security/security.module';

/**
 * Composition root (ARCHITECTURE.md §3, L3).
 *
 * The only place that knows the whole system exists. Ports are bound to
 * implementations here and in the infrastructure modules; nothing below this
 * layer knows which technology backs which port.
 *
 * Infrastructure adapters, application interactors and HTTP delivery are
 * composed here without leaking concrete technologies into the inner layers.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Loaded once at bootstrap. `.env.local` overrides `.env` so a developer
      // can point at a local Redis without touching the shared file.
      envFilePath: ['.env.local', '.env'],
      load: [redisConfig],
      cache: true,
    }),
    // Infrastructure (L3) — binds every port to its implementation.
    RedisModule,
    PersistenceModule,
    // Application (L1) — depends only on those ports.
    // Security and HTTP composition over the application use cases.
    SecurityModule,
    HttpApiModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
