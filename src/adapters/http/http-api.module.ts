import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { ApplicationModule } from '../../application/application.module';
import { AuthController } from './controllers/auth.controller';
import { MoneyRequestController } from './controllers/money-request.controller';
import { TransactionController } from './controllers/transaction.controller';
import { UserController } from './controllers/user.controller';
import { WalletController } from './controllers/wallet.controller';
import {
  EnvelopeController,
  PotController,
  RiskFlagController,
  WalletSecurityController,
  SecurityQuestionController,
} from './controllers/safety.controller';
import {
  BigIntSerializerInterceptor,
  CorrelationIdInterceptor,
  DomainExceptionFilter,
  JwtAuthGuard,
} from './http.plumbing';

@Module({
  imports: [ApplicationModule],
  controllers: [
    WalletSecurityController,
    EnvelopeController,
    PotController,
    RiskFlagController,
    SecurityQuestionController,
    AuthController,
    UserController,
    WalletController,
    MoneyRequestController,
    TransactionController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: CorrelationIdInterceptor },
    { provide: APP_INTERCEPTOR, useClass: BigIntSerializerInterceptor },
  ],
})
export class HttpApiModule {}
