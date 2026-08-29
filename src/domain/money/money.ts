/**
 * Money — integer poisha, exact arithmetic, impossible to construct invalid.
 *
 * ARCHITECTURE.md §4: 1 BDT = 100 poisha, always BigInt, never a float.
 * Floating point cannot represent 0.10 exactly; summing a million transactions
 * accumulates drift, and in a ledger drift is indistinguishable from theft.
 *
 * L0 — zero imports. No framework, no database, no clock.
 */

export const POISHA_PER_BDT = 100n;

/** BIGINT ceiling. Guards against an overflow silently wrapping a balance. */
const MAX_POISHA = 9_223_372_036_854_775_807n;

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class Money {
  private constructor(
    readonly poisha: bigint,
    readonly currency: string,
  ) {}

  /**
   * Builds an amount from raw poisha.
   *
   * Rejects negatives at construction: an amount is a magnitude, and direction
   * is carried by source/destination. A negative "amount" anywhere in this
   * system is a bug, and the type refuses to represent one.
   */
  static fromPoisha(poisha: bigint, currency = 'BDT'): Money {
    if (typeof poisha !== 'bigint') {
      throw new InvalidMoneyError(`Amount must be a bigint, received ${typeof poisha}.`);
    }
    if (poisha < 0n) {
      throw new InvalidMoneyError(`Amount cannot be negative: ${poisha} poisha.`);
    }
    if (poisha > MAX_POISHA) {
      throw new InvalidMoneyError(`Amount exceeds the representable maximum: ${poisha}.`);
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyError(`Currency must be a 3-letter ISO 4217 code, got "${currency}".`);
    }
    return new Money(poisha, currency);
  }

  /**
   * Builds from whole taka. Integers only.
   *
   * Accepting a float here would reintroduce the exact imprecision the type
   * exists to prevent — `12.34` cannot be represented, and rounding it silently
   * is how a cent goes missing.
   */
  static fromTaka(taka: number, currency = 'BDT'): Money {
    if (!Number.isInteger(taka)) {
      throw new InvalidMoneyError(
        `Taka must be a whole number; use fromPoisha for sub-taka precision. Got ${taka}.`,
      );
    }
    return Money.fromPoisha(BigInt(taka) * POISHA_PER_BDT, currency);
  }

  static zero(currency = 'BDT'): Money {
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromPoisha(this.poisha + other.poisha, this.currency);
  }

  /** Throws rather than returning a negative — the caller must check first. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    if (other.poisha > this.poisha) {
      throw new InvalidMoneyError(
        `Subtracting ${other.poisha} from ${this.poisha} poisha would produce a negative amount.`,
      );
    }
    return Money.fromPoisha(this.poisha - other.poisha, this.currency);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.poisha > other.poisha;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.poisha >= other.poisha;
  }

  isZero(): boolean {
    return this.poisha === 0n;
  }

  isPositive(): boolean {
    return this.poisha > 0n;
  }

  equals(other: Money): boolean {
    return this.poisha === other.poisha && this.currency === other.currency;
  }

  /** Display only. Never use the string form for arithmetic or comparison. */
  format(): string {
    const whole = this.poisha / POISHA_PER_BDT;
    const fraction = this.poisha % POISHA_PER_BDT;
    return `${whole}.${fraction.toString().padStart(2, '0')} ${this.currency}`;
  }

  toString(): string {
    return this.format();
  }

  /**
   * Mixing currencies in one operation is always a bug, never a conversion.
   * Conversion is an explicit business operation with a rate and an audit trail.
   */
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new InvalidMoneyError(
        `Cannot combine ${this.currency} with ${other.currency}. Currency conversion is an explicit operation.`,
      );
    }
  }
}
