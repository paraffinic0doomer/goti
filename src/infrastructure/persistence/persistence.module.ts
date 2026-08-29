import { Global, Module } from '@nestjs/common';

import {
  AUDIT_REPOSITORY,
  CLOCK,
  ID_GENERATOR,
  LEDGER_REPOSITORY,
  RECONCILIATION_PORT,
  TRANSACTION_EVENT_REPOSITORY,
  TRANSACTION_REPOSITORY,
  UNIT_OF_WORK,
  USER_REPOSITORY,
  WALLET_REPOSITORY,
} from '../../application/ports/repositories.port';
import {
  MONEY_REQUEST_REPOSITORY,
  RISK_REPOSITORY,
  TRANSACTION_QUERY_REPOSITORY,
  USER_WRITE_REPOSITORY,
} from '../../application/ports/query.port';
import {
  ENVELOPE_REPOSITORY,
  POT_REPOSITORY,
  WALLET_SECURITY_REPOSITORY,
} from '../../application/ports/safety.port';
import { SECURITY_QUESTION_REPOSITORY } from '../../application/ports/security-question.port';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaSecurityQuestionRepository } from './prisma-security-question.repository';
import {
  PrismaEnvelopeRepository,
  PrismaPotRepository,
  PrismaWalletSecurityRepository,
} from './prisma-safety.repositories';
import { PrismaLedgerRepository } from './prisma-ledger.repository';
import { PrismaTransactionRepository } from './prisma-transaction.repository';
import { PrismaUnitOfWork } from './prisma-unit-of-work';
import { PrismaWalletRepository } from './prisma-wallet.repository';
import {
  PrismaMoneyRequestRepository,
  PrismaRiskRepository,
  PrismaTransactionQueryRepository,
  PrismaUserWriteRepository,
} from './prisma-query.repositories';
import {
  PrismaAuditRepository,
  PrismaReconciliationAdapter,
  PrismaTransactionEventRepository,
  PrismaUserRepository,
  SystemClock,
  UuidV7Generator,
} from './prisma-support.repositories';

/**
 * Binds every persistence PORT to its Prisma implementation.
 *
 * This module is the seam ARCHITECTURE.md §9 describes: replacing PostgreSQL
 * with a distributed SQL engine, or moving a projection to another store,
 * changes the `useClass` entries here and the classes they name. **Zero files
 * change in the domain or application layers** — and the existing test suite
 * proves it, because those layers never had a database to begin with.
 *
 * `@Global` because these are cross-cutting infrastructure concerns backed by a
 * single connection pool. Not a pattern to copy for domain modules.
 */
@Global()
@Module({
  providers: [
    PrismaService,
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },
    { provide: WALLET_REPOSITORY, useClass: PrismaWalletRepository },
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: TRANSACTION_REPOSITORY, useClass: PrismaTransactionRepository },
    { provide: LEDGER_REPOSITORY, useClass: PrismaLedgerRepository },
    { provide: TRANSACTION_EVENT_REPOSITORY, useClass: PrismaTransactionEventRepository },
    { provide: AUDIT_REPOSITORY, useClass: PrismaAuditRepository },
    { provide: USER_WRITE_REPOSITORY, useClass: PrismaUserWriteRepository },
    { provide: MONEY_REQUEST_REPOSITORY, useClass: PrismaMoneyRequestRepository },
    { provide: TRANSACTION_QUERY_REPOSITORY, useClass: PrismaTransactionQueryRepository },
    { provide: RISK_REPOSITORY, useClass: PrismaRiskRepository },
    { provide: RECONCILIATION_PORT, useClass: PrismaReconciliationAdapter },
    { provide: WALLET_SECURITY_REPOSITORY, useClass: PrismaWalletSecurityRepository },
    { provide: POT_REPOSITORY, useClass: PrismaPotRepository },
    { provide: ENVELOPE_REPOSITORY, useClass: PrismaEnvelopeRepository },
    { provide: SECURITY_QUESTION_REPOSITORY, useClass: PrismaSecurityQuestionRepository },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
  ],
  exports: [
    PrismaService,
    UNIT_OF_WORK,
    WALLET_REPOSITORY,
    USER_REPOSITORY,
    TRANSACTION_REPOSITORY,
    LEDGER_REPOSITORY,
    TRANSACTION_EVENT_REPOSITORY,
    AUDIT_REPOSITORY,
    USER_WRITE_REPOSITORY,
    MONEY_REQUEST_REPOSITORY,
    TRANSACTION_QUERY_REPOSITORY,
    RISK_REPOSITORY,
    RECONCILIATION_PORT,
    CLOCK,
    ID_GENERATOR,
    WALLET_SECURITY_REPOSITORY,
    POT_REPOSITORY,
    ENVELOPE_REPOSITORY,
    SECURITY_QUESTION_REPOSITORY,
  ],
})
export class PersistenceModule {}
