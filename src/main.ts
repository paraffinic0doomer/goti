import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // Input validation belongs at the HTTP boundary (ARCHITECTURE.md §4:
  // controllers validate shape, services own rules).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,            // strip unknown properties
      forbidNonWhitelisted: true, // and reject requests that send them
      transform: true,
    }),
  );

  // CORS — required for any browser client, since the SPA is served from a
  // different origin than the API.
  //
  // An explicit allow-list, never `origin: true`. Reflecting whatever Origin
  // the request carried, combined with credentials, lets any site a logged-in
  // user visits call this API with their session. The token lives in memory
  // rather than a cookie, so `credentials` stays off and the Authorization
  // header is what must be permitted.
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
    exposedHeaders: ['X-Correlation-Id'],
    credentials: false,
    maxAge: 600,
  });

  // Drain in-flight work before the process exits. During a rolling deploy this
  // is what lets a departing instance finish releasing its idempotency locks
  // and close the Redis connection cleanly, instead of leaving keys held until
  // their TTL expires.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  logger.log(`Goti listening on port ${port}`);
}

void bootstrap();
