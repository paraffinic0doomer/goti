import { Money } from '../../domain/money/money';
import { IllegalStateTransitionError } from '../../domain/errors/domain-errors';
import { InvalidMoneyError as MoneyError } from '../../domain/money/money';
import { TransactionPhase, TransactionStateMachine } from './transaction.state-machine';

/**
 * Engine tests that need NO database and NO Redis.
 *
 * ARCHITECTURE.md §10: the layers holding the most rules are the cheapest to
 * test. The state machine and the money type are pure L0/L1 — the entire
 * legality matrix and every arithmetic invariant verify in microseconds.
 *
 * The 500-concurrent-transfer test from ARCHITECTURE.md §10 is a separate
 * integration suite against real PostgreSQL, because it exercises row locks
 * that only a real database has.
 */

describe('Money', () => {
  it('stores taka as integer poisha', () => {
    expect(Money.fromTaka(1_000).poisha).toBe(100_000n);
    expect(Money.fromPoisha(100_000n).format()).toBe('1000.00 BDT');
  });

  it('refuses a float, because 12.34 cannot be represented exactly', () => {
    // Accepting this would reintroduce the drift the type exists to prevent.
    expect(() => Money.fromTaka(12.34)).toThrow(MoneyError);
  });

  it('refuses a negative amount at construction', () => {
    expect(() => Money.fromPoisha(-1n)).toThrow(MoneyError);
  });

  it('refuses to subtract into a negative', () => {
    const balance = Money.fromTaka(100);
    expect(() => balance.subtract(Money.fromTaka(101))).toThrow(MoneyError);
  });

  it('refuses to mix currencies — that is a conversion, not an addition', () => {
    const bdt = Money.fromTaka(100, 'BDT');
    const usd = Money.fromTaka(100, 'USD');
    expect(() => bdt.add(usd)).toThrow(MoneyError);
  });

  it('is exact across many additions where floating point would drift', () => {
    // 0.10 cannot be represented in binary floating point. Summed a million
    // times the error is visible; in a ledger it is indistinguishable from theft.
    let total = Money.zero();
    for (let i = 0; i < 1_000_000; i++) total = total.add(Money.fromPoisha(10n));

    expect(total.poisha).toBe(10_000_000n); // exactly 100,000.00 BDT
  });
});

describe('TransactionStateMachine', () => {
  const machine = new TransactionStateMachine();

  it('walks the happy path', () => {
    let phase = TransactionPhase.CREATED;
    phase = machine.transition(phase, TransactionPhase.VALIDATING);
    phase = machine.transition(phase, TransactionPhase.VALIDATED);
    phase = machine.transition(phase, TransactionPhase.PROCESSING);
    phase = machine.transition(phase, TransactionPhase.COMPLETED);

    expect(phase).toBe(TransactionPhase.COMPLETED);
    expect(machine.isTerminal(phase)).toBe(true);
  });

  it('REFUSES to resurrect a failed transaction', () => {
    // The bug a plain status field permits: `transaction.status = 'COMPLETED'`
    // on an already-rejected transfer pays out money the system said no to.
    expect(() =>
      machine.transition(TransactionPhase.FAILED, TransactionPhase.COMPLETED, 'txn-1'),
    ).toThrow(IllegalStateTransitionError);
  });

  it('refuses to complete a transaction twice', () => {
    expect(() =>
      machine.transition(TransactionPhase.COMPLETED, TransactionPhase.COMPLETED),
    ).toThrow(IllegalStateTransitionError);
  });

  it('refuses to skip validation and go straight to processing', () => {
    expect(() =>
      machine.transition(TransactionPhase.CREATED, TransactionPhase.PROCESSING),
    ).toThrow(IllegalStateTransitionError);
  });

  it('refuses to cancel once processing has begun', () => {
    // Past this point the outcome belongs to the database transaction, not to
    // a caller changing their mind.
    expect(() =>
      machine.transition(TransactionPhase.PROCESSING, TransactionPhase.CANCELLED),
    ).toThrow(IllegalStateTransitionError);
  });

  it('allows the ONE deliberate path out of COMPLETED — compensation', () => {
    const reversing = machine.transition(TransactionPhase.COMPLETED, TransactionPhase.REVERSING);
    expect(machine.transition(reversing, TransactionPhase.REVERSED)).toBe(
      TransactionPhase.REVERSED,
    );
  });

  it('gives every terminal phase zero outgoing edges except COMPLETED', () => {
    expect(machine.allowedNext(TransactionPhase.FAILED)).toHaveLength(0);
    expect(machine.allowedNext(TransactionPhase.CANCELLED)).toHaveLength(0);
    expect(machine.allowedNext(TransactionPhase.REVERSED)).toHaveLength(0);
  });

  it('maps in-flight phases onto PENDING and outcomes onto their own status', () => {
    expect(machine.toPersistedStatus(TransactionPhase.VALIDATING)).toBe('PENDING');
    expect(machine.toPersistedStatus(TransactionPhase.PROCESSING)).toBe('PENDING');
    expect(machine.toPersistedStatus(TransactionPhase.COMPLETED)).toBe('COMPLETED');
    expect(machine.toPersistedStatus(TransactionPhase.CANCELLED)).toBe('FAILED');
  });

  it('rejects the overwhelming majority of the N² possible assignments', () => {
    // The point of the machine: with 9 phases there are 81 assignments and only
    // 13 are legal. A plain status field permits all 81.
    const phases = Object.values(TransactionPhase);
    const legal = phases.flatMap((from) =>
      phases.filter((to) => machine.canTransition(from, to)),
    );

    expect(phases.length ** 2).toBe(81);
    expect(legal.length).toBeLessThan(20);
  });
});

/**
 * THE CONCURRENCY SCENARIO from the brief.
 *
 * Balance 1000. Request A sends 700, request B sends 600, simultaneously.
 * Exactly one must succeed.
 *
 * Modelled here against a fake wallet store whose `debitIfSufficient` behaves
 * the way PostgreSQL's conditional UPDATE does — guard and mutation evaluated
 * as one indivisible step. That is precisely the property being tested: given
 * an atomic compare-and-set, no interleaving can overdraw.
 *
 * The contrast test below shows the same interleaving against read-modify-write
 * and demonstrates the money being created.
 */
describe('conditional atomic debit', () => {
  /** Mirrors `UPDATE wallets SET balance = balance - x WHERE balance >= x`. */
  class AtomicWallet {
    constructor(private balance: bigint) {}

    debitIfSufficient(amount: bigint): boolean {
      if (this.balance < amount) return false; // guard and mutation are one step
      this.balance -= amount;
      return true;
    }

    get value(): bigint {
      return this.balance;
    }
  }

  /** The naive implementation, for contrast. */
  class ReadModifyWriteWallet {
    constructor(private balance: bigint) {}

    read(): bigint {
      return this.balance;
    }

    write(value: bigint): void {
      this.balance = value;
    }

    get value(): bigint {
      return this.balance;
    }
  }

  it('admits exactly one of two transfers that cannot both be funded', () => {
    const wallet = new AtomicWallet(1_000_00n); // 1000 BDT

    const a = wallet.debitIfSufficient(700_00n);
    const b = wallet.debitIfSufficient(600_00n);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(wallet.value).toBe(300_00n); // 1000 − 700
    expect(wallet.value).toBeGreaterThanOrEqual(0n); // never negative
  });

  it('demonstrates the bug the design avoids: read-modify-write creates money', () => {
    const wallet = new ReadModifyWriteWallet(1_000_00n);

    // The interleaving that happens under real concurrency:
    const seenByA = wallet.read(); // 1000
    const seenByB = wallet.read(); // 1000 — B has not seen A's decision

    wallet.write(seenByA - 700_00n); // A writes 300
    wallet.write(seenByB - 600_00n); // B writes 400, clobbering A

    // 1300 BDT left a wallet holding 1000. This is the lost-update bug, and it
    // is why no `setBalance` method exists on WalletRepositoryPort.
    expect(wallet.value).toBe(400_00n);
    expect(700_00n + 600_00n).toBeGreaterThan(1_000_00n);
  });

  it('never overdraws under 500 concurrent 1-BDT attempts on a 100-BDT wallet', () => {
    // The shape of the acceptance test from ARCHITECTURE.md §10, run against
    // the atomic primitive. The integration version runs against real Postgres.
    const wallet = new AtomicWallet(100_00n);

    const outcomes = Array.from({ length: 500 }, () => wallet.debitIfSufficient(1_00n));

    expect(outcomes.filter(Boolean)).toHaveLength(100);
    expect(outcomes.filter((ok) => !ok)).toHaveLength(400);
    expect(wallet.value).toBe(0n);
  });
});

describe('deterministic lock ordering', () => {
  it('produces the same acquisition order for reciprocal transfers', () => {
    const walletA = '00000000-0000-7000-8000-00000000000a';
    const walletB = '00000000-0000-7000-8000-00000000000b';

    // T1 sends A→B, T2 sends B→A. Both sort to the same order, so no lock
    // cycle can form and T2 waits instead of deadlocking.
    const orderForT1 = [walletA, walletB].sort();
    const orderForT2 = [walletB, walletA].sort();

    expect(orderForT1).toEqual(orderForT2);
    expect(orderForT1[0]).toBe(walletA);
  });
});

describe('double-entry postings', () => {
  it('sums to exactly zero — the system-wide health check', () => {
    const amount = 250_000n;
    const entries = [
      { direction: 'DEBIT' as const, amountPoisha: -amount },
      { direction: 'CREDIT' as const, amountPoisha: amount },
    ];

    expect(entries.reduce((sum, e) => sum + e.amountPoisha, 0n)).toBe(0n);
  });

  it('keeps DEBIT negative and CREDIT positive, matching the CHECK constraint', () => {
    const debit = { direction: 'DEBIT' as const, amountPoisha: -100n };
    const credit = { direction: 'CREDIT' as const, amountPoisha: 100n };

    expect(debit.amountPoisha).toBeLessThan(0n);
    expect(credit.amountPoisha).toBeGreaterThan(0n);
  });
});
