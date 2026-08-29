import type { MoneyRequestRepositoryPort, MoneyRequestSnapshot } from '../ports/query.port';
import type { ClockPort } from '../ports/repositories.port';
import type { TransactionProcessor } from '../transaction-engine/transaction.processor';
import type { TransferResult } from '../transaction-engine/transaction.types';
import type { AuditService } from '../services/audit.service';
import { RespondToMoneyRequestUseCase } from './money-request.use-cases';

describe('RespondToMoneyRequestUseCase', () => {
  const now = new Date('2026-08-29T10:00:00.000Z');
  const request: MoneyRequestSnapshot = {
    id: '50000000-0001-7000-8000-000000000001',
    requesterUserId: '10000000-0001-7000-8000-000000000001',
    requesterName: 'Requester',
    payerUserId: '10000000-0002-7000-8000-000000000002',
    payerName: 'Payer',
    amountPoisha: 50_00n,
    currency: 'BDT',
    note: null,
    status: 'REQUESTED',
    expiresAt: new Date('2026-09-01T00:00:00.000Z'),
    resolvedAt: null,
    settlementTransactionId: null,
    createdAt: now,
  };

  it('links a successful settlement to its request', async () => {
    const repositories = createDependencies({
      outcome: 'COMPLETED',
      transactionId: '30000000-0001-7000-8000-000000000001',
      status: 'COMPLETED',
      timestamp: now,
      amountPoisha: request.amountPoisha,
      currency: 'BDT',
      completedAt: now,
    });

    const result = await repositories.useCase.execute(
      {
        requestId: request.id,
        actingUserId: request.payerUserId,
        decision: 'ACCEPT',
        idempotencyKey: 'accept_123',
      },
      { actorUserId: request.payerUserId },
    );

    expect(result.status).toBe('ACCEPTED');
    expect(repositories.process).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'REQUEST_SETTLEMENT',
        originRequestId: request.id,
      }),
    );
    expect(repositories.restore).not.toHaveBeenCalled();
  });

  it('restores a request when a settlement moves no money', async () => {
    const repositories = createDependencies({
      outcome: 'FAILED',
      transactionId: '30000000-0002-7000-8000-000000000002',
      status: 'FAILED',
      timestamp: now,
      amountPoisha: request.amountPoisha,
      currency: 'BDT',
      failureReason: 'INSUFFICIENT_FUNDS',
    });

    const result = await repositories.useCase.execute(
      {
        requestId: request.id,
        actingUserId: request.payerUserId,
        decision: 'ACCEPT',
        idempotencyKey: 'accept_456',
      },
      { actorUserId: request.payerUserId },
    );

    expect(result.status).toBe('REQUESTED');
    expect(repositories.restore).toHaveBeenCalledWith(request.id);
  });

  function createDependencies(transfer: TransferResult) {
    const restore = jest.fn().mockResolvedValue(true);
    const requestRepository = {
      findById: jest.fn().mockResolvedValue(request),
      resolveIfPending: jest.fn().mockResolvedValue(true),
      restoreAfterFailedSettlement: restore,
    } as unknown as MoneyRequestRepositoryPort;
    const process = jest.fn().mockResolvedValue(transfer);
    const processor = { process } as unknown as TransactionProcessor;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const clock = { now: () => now } as ClockPort;
    const rateLimiter = {
      consume: jest.fn().mockResolvedValue({
        allowed: true,
        limit: 100,
        remaining: 99,
        retryAfterSeconds: 0,
        degraded: false,
      }),
    } as never;

    return {
      useCase: new RespondToMoneyRequestUseCase(
        requestRepository,
        clock,
        processor,
        audit,
        rateLimiter,
      ),
      process,
      restore,
    };
  }
});
