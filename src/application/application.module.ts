import { Module } from '@nestjs/common';

import { AuditService } from './services/audit.service';
import { SecurityQuestionService } from './services/security-question.service';
import { AnswerSecurityChallengeUseCase } from './use-cases/security-challenge.use-cases';
import { EnvelopeUseCases } from './use-cases/envelope.use-cases';
import { PotUseCases } from './use-cases/pot.use-cases';
import { WalletSecurityUseCases } from './use-cases/wallet-security.use-cases';
import { RiskEngineService } from './services/risk-engine.service';
import { TransactionEngineModule } from './transaction-engine/transaction-engine.module';
import { LoginUserUseCase, RegisterUserUseCase } from './use-cases/auth.use-cases';
import {
  CreateMoneyRequestUseCase,
  ListMoneyRequestsUseCase,
  RespondToMoneyRequestUseCase,
} from './use-cases/money-request.use-cases';
import {
  GetTransactionDetailUseCase,
  ListTransactionsUseCase,
} from './use-cases/transaction-history.use-cases';
import { GetUserProfileUseCase } from './use-cases/user.use-cases';
import { GetWalletUseCase, SendMoneyUseCase } from './use-cases/wallet.use-cases';

const APPLICATION_PROVIDERS = [
  AuditService,
  RiskEngineService,
  RegisterUserUseCase,
  LoginUserUseCase,
  GetUserProfileUseCase,
  GetWalletUseCase,
  SendMoneyUseCase,
  CreateMoneyRequestUseCase,
  RespondToMoneyRequestUseCase,
  ListMoneyRequestsUseCase,
  ListTransactionsUseCase,
  GetTransactionDetailUseCase,
  // Safety and money management. Every one of these depends only on ports, so
  // they are wired exactly like the use cases above — no special casing.
  WalletSecurityUseCases,
  EnvelopeUseCases,
  PotUseCases,
  SecurityQuestionService,
  AnswerSecurityChallengeUseCase,
];

/** Framework wiring for application interactors; business code remains in use cases. */
@Module({
  imports: [TransactionEngineModule],
  providers: APPLICATION_PROVIDERS,
  exports: APPLICATION_PROVIDERS,
})
export class ApplicationModule {}
