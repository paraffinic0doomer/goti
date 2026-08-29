import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';

import type { AuditContext } from '../../../application/services/audit.service';
import {
  GetWalletUseCase,
  SendMoneyUseCase,
} from '../../../application/use-cases/wallet.use-cases';
import { SendMoneyRequestDto } from '../dto/request.dto';
import { Audit, AuthenticatedUser, CurrentUser } from '../http.plumbing';

@Controller('wallet')
export class WalletController {
  constructor(
    private readonly getWallet: GetWalletUseCase,
    private readonly sendMoney: SendMoneyUseCase,
  ) {}

  @Get()
  wallet(@CurrentUser() user: AuthenticatedUser) {
    return this.getWallet.getWallet(user.userId);
  }

  @Get('balance')
  balance(@CurrentUser() user: AuthenticatedUser) {
    return this.getWallet.getBalance(user.userId);
  }

  @Post('send-money')
  @HttpCode(HttpStatus.OK)
  async transfer(
    @Body() body: SendMoneyRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    const result = await this.sendMoney.execute(
      {
        senderUserId: user.userId,
        receiverId: body.receiverId,
        receiverPhone: body.receiverPhone,
        amountPoisha: BigInt(body.amount),
        idempotencyKey: body.idempotencyKey,
        note: body.note,
      },
      audit,
    );

    // A business rejection is a RESULT, not an exception: the engine commits a
    // durable FAILED record and returns it, so the HTTP status stays 200 and
    // the client branches on `status`.
    //
    // The reason must travel with it. Without these two fields every rejection
    // — insufficient funds, self-transfer, unknown receiver — is
    // indistinguishable to the caller, and the only thing a user can be told is
    // "it didn't work". `failureReason` is the stable machine code (matching
    // `transactions.failure_reason`); `failureMessage` is the human sentence.
    return {
      transactionId: result.transactionId,
      status: result.status,
      timestamp: result.timestamp,
      ...(result.failureReason ? { failureReason: result.failureReason } : {}),
      ...(result.failureMessage ? { failureMessage: result.failureMessage } : {}),
    };
  }
}
