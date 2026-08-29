import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

import { TransactionContext } from '../../application/ports/repositories.port';

/**
 * The Prisma client, owned by the infrastructure layer.
 *
 * Nothing outside `src/infrastructure` imports `@prisma/client`. Repositories
 * take this service; the application layer sees only ports.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('PostgreSQL connected.');
  }

  async onModuleDestroy(): Promise<void> {
    // Lets in-flight money transactions finish before the socket closes. During
    // a rolling deploy this is the difference between a clean drain and a
    // transaction aborted mid-commit.
    await this.$disconnect();
    this.logger.log('PostgreSQL disconnected.');
  }
}

/**
 * Bridges the opaque `TransactionContext` and Prisma's transaction client.
 *
 * The application layer passes a `TransactionContext` between repositories to
 * keep them in one database transaction, but cannot inspect it or create one.
 * These two functions are the only place the disguise is removed, and they
 * live in infrastructure where knowing about Prisma is allowed.
 */
export function toTransactionContext(client: Prisma.TransactionClient): TransactionContext {
  return client as unknown as TransactionContext;
}

export function fromTransactionContext(context: TransactionContext): Prisma.TransactionClient {
  return context as unknown as Prisma.TransactionClient;
}

/**
 * Resolves the client to use: the transaction's if one is open, otherwise the
 * pooled connection.
 *
 * This is what lets a repository method serve both a read outside any
 * transaction and a write inside the money transaction, without two code paths.
 */
export function clientFor(
  prisma: PrismaService,
  context?: TransactionContext,
): Prisma.TransactionClient {
  return context ? fromTransactionContext(context) : prisma;
}
