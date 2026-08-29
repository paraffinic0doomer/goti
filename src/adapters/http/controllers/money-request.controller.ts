import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';

import type { AuditContext } from '../../../application/services/audit.service';
import {
  CreateMoneyRequestUseCase,
  ListMoneyRequestsUseCase,
  RespondToMoneyRequestUseCase,
} from '../../../application/use-cases/money-request.use-cases';
import {
  AcceptMoneyRequestDto,
  CreateMoneyRequestDto,
  ListMoneyRequestsQueryDto,
  RejectMoneyRequestDto,
} from '../dto/request.dto';
import { Audit, AuthenticatedUser, CurrentUser } from '../http.plumbing';

@Controller('money-requests')
export class MoneyRequestController {
  constructor(
    private readonly createRequest: CreateMoneyRequestUseCase,
    private readonly respondToRequest: RespondToMoneyRequestUseCase,
    private readonly listRequests: ListMoneyRequestsUseCase,
  ) {}

  @Post()
  create(
    @Body() body: CreateMoneyRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.createRequest.execute(
      {
        requesterUserId: user.userId,
        payerUserId: body.payerId,
        payerPhone: body.payerPhone,
        amountPoisha: BigInt(body.amount),
        note: body.note,
        idempotencyKey: body.idempotencyKey,
      },
      audit,
    );
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(
    @Param('id', new ParseUUIDPipe({ version: '7' })) requestId: string,
    @Body() body: AcceptMoneyRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.respondToRequest.execute(
      {
        requestId,
        actingUserId: user.userId,
        decision: 'ACCEPT',
        idempotencyKey: body.idempotencyKey,
      },
      audit,
    );
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', new ParseUUIDPipe({ version: '7' })) requestId: string,
    @Body() _body: RejectMoneyRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.respondToRequest.execute(
      { requestId, actingUserId: user.userId, decision: 'DECLINE' },
      audit,
    );
  }

  @Get('pending')
  async pending(
    @Query() query: ListMoneyRequestsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paginatedList(user.userId, { ...query, status: 'REQUESTED' });
  }

  @Get()
  async list(
    @Query() query: ListMoneyRequestsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paginatedList(user.userId, query);
  }

  private async paginatedList(userId: string, query: ListMoneyRequestsQueryDto) {
    const result = await this.listRequests.execute({
      userId,
      role: query.role,
      status: query.status,
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    });

    return {
      ...result,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(result.total / query.pageSize),
    };
  }
}
