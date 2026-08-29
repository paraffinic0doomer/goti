import { Module } from '@nestjs/common';

import { TransactionEventService } from './transaction-event.service';
import { TransactionLockService } from './transaction-lock.service';
import { TransactionProcessor } from './transaction.processor';
import { TransactionRecoveryService } from './transaction-recovery.service';
import { TransactionStateMachine } from './transaction.state-machine';
import { TransactionValidator } from './transaction.validator';

/**
 * The Transaction Engine (ARCHITECTURE.md §4 — L1, APPLICATION).
 *
 * NOTE ON PLACEMENT: the brief named `src/transaction-engine/`. It lives under
 * `src/application/` instead because ARCHITECTURE.md §4 classifies the engine
 * as `L1 · APPLICATION`, and the layer boundary is enforced by path:
 *
 *     grep -rn "@prisma/client\|ioredis" src/application src/domain
 *
 * must return nothing. A top-level `src/transaction-engine/` would sit outside
 * that check, and a rule that cannot be checked is a rule that erodes. The file
 * names are exactly as specified.
 *
 * Every dependency arrives through a PORT token bound in `PersistenceModule`
 * and `RedisModule`. This module imports neither Prisma nor Redis, which is why
 * the whole engine can be exercised against in-memory fakes.
 */
@Module({
  providers: [
    TransactionProcessor,
    TransactionValidator,
    TransactionStateMachine,
    TransactionLockService,
    TransactionEventService,
    TransactionRecoveryService,
  ],
  exports: [
    TransactionProcessor,
    TransactionEventService,
    TransactionRecoveryService,
    TransactionStateMachine,
  ],
})
export class TransactionEngineModule {}
