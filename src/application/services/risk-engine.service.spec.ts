import type { RiskRepositoryPort, RiskSignals } from '../ports/query.port';
import type { IdGeneratorPort } from '../ports/repositories.port';
import { RiskEngineService } from './risk-engine.service';

describe('RiskEngineService', () => {
  const repository = {} as RiskRepositoryPort;
  const ids = { generate: () => '60000000-0001-7000-8000-000000000001' } as IdGeneratorPort;
  const service = new RiskEngineService(repository, ids);

  const ordinary: RiskSignals = {
    transfersInLastHour: 1,
    hasTransactedWithReceiverBefore: true,
    distinctReceiversLast24h: 2,
  daysSinceLastActivity: null,
  };

  it('returns LOW when no rule triggers', () => {
    const result = service.evaluate(
      {
        senderUserId: 'sender',
        receiverUserId: 'receiver',
        amountPoisha: 10_000n,
        senderBalancePoisha: 1_000_000n,
      },
      ordinary,
    );

    expect(result.level).toBe('LOW');
    expect(result.triggeredRules).toHaveLength(0);
  });

  it('returns MEDIUM with an explainable first-large-interaction rule', () => {
    const result = service.evaluate(
      {
        senderUserId: 'sender',
        receiverUserId: 'new-receiver',
        amountPoisha: 1_000_000n,
        senderBalancePoisha: 10_000_000n,
      },
      { ...ordinary, hasTransactedWithReceiverBefore: false },
    );

    expect(result.level).toBe('MEDIUM');
    expect(result.triggeredRules[0]).toMatchObject({
      rule: 'counterparty.first_interaction_large_amount',
      triggered: true,
    });
    expect(result.triggeredRules[0]?.explanation).toContain('First transfer');
  });

  it('returns HIGH when combined rules indicate a near-total drain to a new receiver', () => {
    const result = service.evaluate(
      {
        senderUserId: 'sender',
        receiverUserId: 'new-receiver',
        amountPoisha: 9_900_000n,
        senderBalancePoisha: 10_000_000n,
      },
      { ...ordinary, hasTransactedWithReceiverBefore: false },
    );

    expect(result.level).toBe('HIGH');
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.triggeredRules.map((rule) => rule.rule)).toEqual(
      expect.arrayContaining([
        'amount.large_relative_to_balance',
        'counterparty.first_interaction_large_amount',
      ]),
    );
  });

  it('detects unusual transfer frequency', () => {
    const result = service.evaluate(
      {
        senderUserId: 'sender',
        receiverUserId: 'receiver',
        amountPoisha: 10_000n,
        senderBalancePoisha: 1_000_000n,
      },
      { ...ordinary, transfersInLastHour: 25 },
    );

    expect(result.triggeredRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'velocity.transfers_per_hour', weight: 40 }),
      ]),
    );
  });
});
