import { Inject, Injectable, Logger } from '@nestjs/common';

import { InvalidAmountError, DomainError, UserNotFoundError } from '../../domain/errors/domain-errors';
import { Money } from '../../domain/money/money';
import {
  MONEY_REQUEST_REPOSITORY,
  MoneyRequestRepositoryPort,
  MoneyRequestSnapshot,
  MoneyRequestStatus,
} from '../ports/query.port';
import {
  CLOCK,
  ClockPort,
  ID_GENERATOR,
  IdGeneratorPort,
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../ports/repositories.port';
import { TransactionProcessor } from '../transaction-engine/transaction.processor';
import { TransferResult } from '../transaction-engine/transaction.types';
import { AuditAction, AuditContext, AuditService } from '../services/audit.service';
import { RATE_LIMITER_PORT, RateLimitAction, RateLimiterPort } from '../ports/rate-limiter.port';
import { RateLimitExceededError } from '../errors/application-errors';

/** A claim nobody answers should not sit in an inbox forever. */
const DEFAULT_EXPIRY_DAYS = 7;

export class MoneyRequestNotFoundError extends DomainError {
  readonly code = 'MONEY_REQUEST_NOT_FOUND';
  readonly retryable = false;
  constructor(id: string) {
    super(`No money request found with id ${id}.`);
  }
}

export class NotTheRequestPayerError extends DomainError {
  readonly code = 'NOT_THE_PAYER';
  readonly retryable = false;
  constructor() {
    super('Only the person being asked can accept or decline this request.');
  }
}

export class MoneyRequestAlreadyResolvedError extends DomainError {
  readonly code = 'MONEY_REQUEST_ALREADY_RESOLVED';
  readonly retryable = false;
  constructor(readonly status: string) {
    super(`This request is already ${status.toLowerCase()} and cannot be changed.`);
  }
}

export class MoneyRequestExpiredError extends DomainError {
  readonly code = 'MONEY_REQUEST_EXPIRED';
  readonly retryable = false;
  constructor() {
    super('This request has expired.');
  }
}

export class SelfRequestError extends DomainError {
  readonly code = 'SELF_REQUEST_NOT_ALLOWED';
  readonly retryable = false;
  constructor() {
    super('You cannot request money from yourself.');
  }
}

export interface CreateMoneyRequestCommand {
  readonly requesterUserId: string;
  readonly payerUserId?: string;
  readonly payerPhone?: string;
  readonly amountPoisha: bigint;
  readonly note?: string | null;
  readonly idempotencyKey: string;
}

/**
 * ============================================================================
 *  MONEY REQUESTS — the workflow
 * ============================================================================
 *
 * THE DESIGN RULE, from ARCHITECTURE.md §5:
 *
 *     A money request is a CLAIM, not money. It never touches a balance.
 *
 * Only acceptance — performed by the PAYER — constructs a transfer, and that
 * transfer goes through the identical seven engine stages as a direct send. It
 * gets no shortcut and no privileged path.
 *
 * Keeping the claim lifecycle out of the ledger is what stops "pending" from
 * contaminating what a balance means. If a request reserved funds, a user's
 * spendable balance and their actual balance would differ, and every part of
 * the system would need to know which one it was looking at.
 *
 *     REQUESTED ─┬─→ ACCEPTED   payer accepts → a Transaction is created
 *                ├─→ DECLINED   payer refuses
 *                ├─→ CANCELLED  requester withdraws
 *                └─→ EXPIRED    expires_at passes
 *
 * Terminal states are final, enforced by a CHECK constraint and by the
 * conditional `resolveIfPending` update.
 */
@Injectable()
export class CreateMoneyRequestUseCase {
  constructor(
    @Inject(MONEY_REQUEST_REPOSITORY) private readonly requests: MoneyRequestRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly audit: AuditService,
    @Inject(RATE_LIMITER_PORT) private readonly rateLimiter: RateLimiterPort,
  ) {}

  async execute(
    command: CreateMoneyRequestCommand,
    context: AuditContext,
  ): Promise<MoneyRequestSnapshot> {
    const rateLimit = await this.rateLimiter.consume(
      RateLimitAction.MONEY_REQUEST,
      command.requesterUserId,
    );
    if (!rateLimit.allowed) {
      await this.audit.record(
        AuditAction.RATE_LIMITED,
        { type: 'User', id: command.requesterUserId },
        context,
        { after: { action: 'create_money_request', retryAfterSeconds: rateLimit.retryAfterSeconds } },
      );
      throw new RateLimitExceededError(rateLimit.retryAfterSeconds);
    }

    // Validated by `Money`, which refuses zero and negative amounts outright.
    const amount = Money.fromPoisha(command.amountPoisha);
    if (amount.isZero()) {
      throw new InvalidAmountError('a money request must be for a positive amount.');
    }

    const payer = command.payerUserId
      ? await this.users.findById(command.payerUserId)
      : command.payerPhone
        ? await this.users.findByPhone(command.payerPhone)
        : null;

    if (!payer) {
      throw new UserNotFoundError(command.payerUserId ?? command.payerPhone ?? '(none given)');
    }
    if (payer.id === command.requesterUserId) throw new SelfRequestError();

    const expiresAt = new Date(
      this.clock.now().getTime() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );

    const created = await this.requests.create({
      id: this.ids.generate(),
      // Requests are idempotent too — a retried "ask Rahim for 500" must not
      // put two claims in his inbox.
      idempotencyKey: command.idempotencyKey,
      requesterUserId: command.requesterUserId,
      payerUserId: payer.id,
      amountPoisha: amount.poisha,
      currency: 'BDT',
      note: command.note ?? null,
      expiresAt,
    });

    await this.audit.record(
      AuditAction.REQUEST_CREATED,
      { type: 'MoneyRequest', id: created.id },
      context,
      { after: { payerUserId: payer.id, amountPoisha: amount.poisha.toString() } },
    );

    return created;
  }
}

export interface RespondToMoneyRequestCommand {
  readonly requestId: string;
  /** The authenticated caller. Authorisation is checked against this, not input. */
  readonly actingUserId: string;
  readonly decision: 'ACCEPT' | 'DECLINE';
  /** Required on ACCEPT — it becomes the resulting transfer's idempotency key. */
  readonly idempotencyKey?: string;
}

export interface RespondToMoneyRequestResult {
  readonly requestId: string;
  readonly status: MoneyRequestStatus;
  readonly transfer?: TransferResult;
}

/**
 * Accept or decline.
 *
 * THE ORDERING THAT MATTERS ON ACCEPT
 *
 * The request is resolved to ACCEPTED *before* the transfer runs, using a
 * conditional update that only matches a row still in REQUESTED. Two taps on
 * "Accept" therefore race for one row, exactly one wins, and only the winner
 * reaches the engine.
 *
 * If the transfer then fails (insufficient funds), the request is rolled back
 * to REQUESTED so the payer can top up and try again. That compensation is
 * safe precisely because a money request holds no money — there is nothing to
 * reverse, only a status to restore.
 */
@Injectable()
export class RespondToMoneyRequestUseCase {
  private readonly logger = new Logger(RespondToMoneyRequestUseCase.name);

  constructor(
    @Inject(MONEY_REQUEST_REPOSITORY) private readonly requests: MoneyRequestRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly processor: TransactionProcessor,
    private readonly audit: AuditService,
    @Inject(RATE_LIMITER_PORT) private readonly rateLimiter: RateLimiterPort,
  ) {}

  async execute(
    command: RespondToMoneyRequestCommand,
    context: AuditContext,
  ): Promise<RespondToMoneyRequestResult> {
    const request = await this.requests.findById(command.requestId);
    if (!request) throw new MoneyRequestNotFoundError(command.requestId);

    // Authorisation against the AUTHENTICATED user, never against a body field.
    if (request.payerUserId !== command.actingUserId) throw new NotTheRequestPayerError();

    if (request.status !== 'REQUESTED') {
      throw new MoneyRequestAlreadyResolvedError(request.status);
    }
    if (request.expiresAt <= this.clock.now()) {
      await this.requests.resolveIfPending(request.id, 'EXPIRED', this.clock.now());
      throw new MoneyRequestExpiredError();
    }

    if (command.decision === 'ACCEPT') {
      const rateLimit = await this.rateLimiter.consume(
        RateLimitAction.TRANSACTION,
        command.actingUserId,
      );
      if (!rateLimit.allowed) {
        await this.audit.record(
          AuditAction.RATE_LIMITED,
          { type: 'MoneyRequest', id: request.id },
          context,
          { after: { action: 'accept_money_request', retryAfterSeconds: rateLimit.retryAfterSeconds } },
        );
        throw new RateLimitExceededError(rateLimit.retryAfterSeconds);
      }
    }

    if (command.decision === 'DECLINE') {
      await this.resolve(request, 'DECLINED', context, AuditAction.REQUEST_DECLINED);
      return { requestId: request.id, status: 'DECLINED' };
    }

    // Claim the request. Conditional on it still being REQUESTED, so a second
    // concurrent accept finds no row to update and is rejected.
    const claimed = await this.requests.resolveIfPending(
      request.id,
      'ACCEPTED',
      this.clock.now(),
    );
    if (!claimed) throw new MoneyRequestAlreadyResolvedError('ACCEPTED');

    try {
      await this.audit.record(
        AuditAction.TRANSFER_ATTEMPTED,
        { type: 'MoneyRequest', id: request.id },
        context,
        { after: { amountPoisha: request.amountPoisha.toString() } },
      );

      // Settlement goes through the SAME engine as a direct send. The payer is
      // the initiator, because it is their money that moves and idempotency
      // must be scoped to whoever is being debited.
      const transfer = await this.processor.process({
        idempotencyKey: command.idempotencyKey ?? `money-request-${request.id}`,
        initiatorUserId: request.payerUserId,
        senderUserId: request.payerUserId,
        receiverUserId: request.requesterUserId,
        amountPoisha: request.amountPoisha,
        currency: request.currency,
        note: request.note,
        type: 'REQUEST_SETTLEMENT',
        originRequestId: request.id,
        correlationId: context.correlationId ?? null,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      });

      if (transfer.status === 'FAILED') {
        // Restore the claim so the payer can top up and accept again. Safe
        // because no money was reserved — a request is only ever a claim.
        await this.restoreToPending(request.id);
        return { requestId: request.id, status: 'REQUESTED', transfer };
      }

      await this.audit.record(
        AuditAction.REQUEST_ACCEPTED,
        { type: 'MoneyRequest', id: request.id },
        context,
        { after: { transactionId: transfer.transactionId } },
      );

      return { requestId: request.id, status: 'ACCEPTED', transfer };
    } catch (error) {
      await this.restoreToPending(request.id);
      throw error;
    }
  }

  private async resolve(
    request: MoneyRequestSnapshot,
    status: Exclude<MoneyRequestStatus, 'REQUESTED'>,
    context: AuditContext,
    action: (typeof AuditAction)[keyof typeof AuditAction],
  ): Promise<void> {
    const resolved = await this.requests.resolveIfPending(
      request.id,
      status,
      this.clock.now(),
    );
    if (!resolved) throw new MoneyRequestAlreadyResolvedError(status);

    await this.audit.record(action, { type: 'MoneyRequest', id: request.id }, context, {
      before: { status: 'REQUESTED' },
      after: { status },
    });
  }

  /**
   * Best-effort compensation.
   *
   * If this fails the request is stuck in ACCEPTED with no settlement — visible
   * to support, and not a money problem, because no balance ever changed.
   */
  private async restoreToPending(requestId: string): Promise<void> {
    try {
      const restored = await this.requests.restoreAfterFailedSettlement(requestId);
      if (!restored) {
        this.logger.error(
          `Could not restore money request ${requestId}: it was no longer an unsettled ACCEPTED request.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Could not restore money request ${requestId} to REQUESTED: ${(error as Error).message}. ` +
          'No money moved; the request needs manual review.',
      );
    }
  }
}

export interface ListMoneyRequestsQuery {
  readonly userId: string;
  readonly role: 'payer' | 'requester';
  readonly status?: MoneyRequestStatus;
  readonly limit: number;
  readonly offset: number;
}

/** The payer's inbox and the requester's outbox. Served by composite indexes. */
@Injectable()
export class ListMoneyRequestsUseCase {
  constructor(
    @Inject(MONEY_REQUEST_REPOSITORY) private readonly requests: MoneyRequestRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(
    query: ListMoneyRequestsQuery,
  ): Promise<{ items: readonly MoneyRequestSnapshot[]; total: number }> {
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const offset = Math.max(query.offset, 0);

    return this.requests.findForUser(
      query.userId,
      query.role,
      query.status,
      limit,
      offset,
      query.status === 'REQUESTED' ? this.clock.now() : undefined,
    );
  }
}
