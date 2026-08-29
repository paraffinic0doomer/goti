import { Inject, Injectable } from '@nestjs/common';

import { DomainError, WalletNotFoundError } from '../../domain/errors/domain-errors';
import { Money } from '../../domain/money/money';
import {
  TRANSACTION_QUERY_REPOSITORY,
  TransactionDetail,
  TransactionDirection,
  TransactionHistoryItem,
  TransactionQueryRepositoryPort,
} from '../ports/query.port';
import {
  PersistedTransactionStatus,
  WALLET_REPOSITORY,
  WalletRepositoryPort,
} from '../ports/repositories.port';
import { TimelineEntry, TransactionEventService } from '../transaction-engine/transaction-event.service';

/** Bounded so a client cannot ask for a million rows and exhaust the pool. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export class TransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';
  readonly retryable = false;
  constructor(id: string) {
    super(`No transaction ${id} found for this account.`);
  }
}

export class InvalidTransactionDateRangeError extends DomainError {
  readonly code = 'INVALID_DATE_RANGE';
  readonly retryable = false;
  constructor() {
    super('fromDate must be earlier than or equal to toDate.');
  }
}

export interface ListTransactionsQuery {
  readonly userId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly direction?: TransactionDirection;
  readonly status?: PersistedTransactionStatus;
  readonly fromDate?: Date;
  readonly toDate?: Date;
  readonly sort: 'newest' | 'oldest' | 'largest' | 'smallest';
}

export interface PaginatedTransactions {
  readonly items: readonly (TransactionHistoryItem & { amountFormatted: string })[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly hasNext: boolean;
}

/**
 * Transaction history.
 *
 * WHY THIS READS THE LEDGER RATHER THAN THE TRANSACTIONS TABLE
 *
 * The obvious query is:
 *
 *     WHERE source_wallet_id = $1 OR dest_wallet_id = $1 ORDER BY created_at DESC
 *
 * That `OR` across two columns cannot use one index. PostgreSQL resolves it
 * with a BitmapOr over two indexes and then SORTS the union — at millions of
 * rows per active wallet, sorting thousands of rows to return twenty.
 *
 * `ledger_entries` has ONE WALLET PER ROW, so the same question becomes a
 * single-index, already-sorted, bounded scan of exactly twenty rows using
 * `(wallet_id, created_at DESC, id)`.
 *
 * This is the double-entry ledger paying for itself a second time: once for
 * auditability, once for the read path (DATABASE.md).
 */
@Injectable()
export class ListTransactionsUseCase {
  constructor(
    @Inject(TRANSACTION_QUERY_REPOSITORY)
    private readonly queries: TransactionQueryRepositoryPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort,
  ) {}

  async execute(query: ListTransactionsQuery): Promise<PaginatedTransactions> {
    if (query.fromDate && query.toDate && query.fromDate > query.toDate) {
      throw new InvalidTransactionDateRangeError();
    }

    const wallet = await this.wallets.findByUserId(query.userId);
    if (!wallet) throw new WalletNotFoundError(query.userId);

    // Clamped in the use case, not trusted from the controller. A DTO can be
    // bypassed by an internal caller; this cannot.
    const pageSize = Math.min(Math.max(1, query.pageSize), MAX_PAGE_SIZE);
    const page = Math.max(1, query.page);

    const { items, total } = await this.queries.findHistory({
      walletId: wallet.id,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      direction: query.direction,
      status: query.status,
      fromDate: query.fromDate,
      toDate: query.toDate,
      sort: query.sort,
    });

    const totalPages = Math.ceil(total / pageSize);

    return {
      items: items.map((item) => ({
        ...item,
        amountFormatted: Money.fromPoisha(item.amountPoisha, item.currency).format(),
      })),
      page,
      pageSize,
      total,
      totalPages,
      hasNext: page < totalPages,
    };
  }
}

export interface TransactionDetailView extends TransactionDetail {
  readonly amountFormatted: string;
  /** The answer to "what happened to my money?", in order. */
  readonly timeline: readonly TimelineEntry[];
}

/**
 * One transaction, with its full lifecycle timeline.
 *
 * AUTHORISATION IS PART OF THE QUERY, not a check after it. The repository
 * filters by wallet, so a transaction the caller was not party to comes back as
 * `null` and is indistinguishable from one that does not exist. Fetching first
 * and checking ownership afterwards is how an ID-enumeration leak gets written:
 * the "not yours" and "not found" paths differ, and the difference is
 * observable.
 */
@Injectable()
export class GetTransactionDetailUseCase {
  constructor(
    @Inject(TRANSACTION_QUERY_REPOSITORY)
    private readonly queries: TransactionQueryRepositoryPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort,
    private readonly events: TransactionEventService,
  ) {}

  async execute(transactionId: string, userId: string): Promise<TransactionDetailView> {
    const wallet = await this.wallets.findByUserId(userId);
    if (!wallet) throw new WalletNotFoundError(userId);

    const detail = await this.queries.findDetailForWallet(transactionId, wallet.id);
    if (!detail) throw new TransactionNotFoundError(transactionId);

    const timeline = await this.events.getTimeline(transactionId);

    return {
      ...detail,
      amountFormatted: Money.fromPoisha(detail.amountPoisha, detail.currency).format(),
      timeline,
    };
  }
}
