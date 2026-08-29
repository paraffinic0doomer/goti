import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';

import {
  GetTransactionDetailUseCase,
  ListTransactionsUseCase,
} from '../../../application/use-cases/transaction-history.use-cases';
import { ListTransactionsQueryDto } from '../dto/request.dto';
import { AuthenticatedUser, CurrentUser } from '../http.plumbing';

@Controller('transactions')
export class TransactionController {
  constructor(
    private readonly listTransactions: ListTransactionsUseCase,
    private readonly getTransaction: GetTransactionDetailUseCase,
  ) {}

  @Get()
  list(@Query() query: ListTransactionsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.listTransactions.execute({
      userId: user.userId,
      page: query.page,
      pageSize: query.pageSize,
      direction: query.direction,
      status: query.status,
      fromDate: query.fromDate ? new Date(query.fromDate) : undefined,
      toDate: query.toDate ? new Date(query.toDate) : undefined,
      sort: query.sort,
    });
  }

  @Get(':id')
  detail(
    @Param('id', new ParseUUIDPipe({ version: '7' })) transactionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.getTransaction.execute(transactionId, user.userId);
  }
}
