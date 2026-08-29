import { Inject, Injectable } from '@nestjs/common';

import { DomainError, WalletNotFoundError } from '../../domain/errors/domain-errors';
import { Money } from '../../domain/money/money';
import {
  ENVELOPE_REPOSITORY,
  EnvelopeRepositoryPort,
  EnvelopeSnapshot,
} from '../ports/safety.port';
import {
  ID_GENERATOR,
  IdGeneratorPort,
  WALLET_REPOSITORY,
  WalletRepositoryPort,
} from '../ports/repositories.port';
import { AuditAction, AuditContext, AuditService } from '../services/audit.service';

/** A wallet with unlimited envelopes is a wallet with an unusable envelope screen. */
const MAX_ENVELOPES_PER_WALLET = 12;

export class EnvelopeNotFoundError extends DomainError {
  readonly code = 'ENVELOPE_NOT_FOUND';
  readonly retryable = false;
  constructor(id: string) {
    super(`No envelope ${id} found on your wallet.`);
  }
}

export class EnvelopeLimitReachedError extends DomainError {
  readonly code = 'ENVELOPE_LIMIT_REACHED';
  readonly retryable = false;
  constructor() {
    super(`You can have at most ${MAX_ENVELOPES_PER_WALLET} envelopes.`);
  }
}

export class DuplicateEnvelopeNameError extends DomainError {
  readonly code = 'ENVELOPE_NAME_TAKEN';
  readonly retryable = false;
  constructor(name: string) {
    super(`You already have an envelope called "${name}".`);
  }
}

/**
 * Reserving more than is spendable.
 *
 * A rejection, not a failure: the answer is "no", and it is stable until the
 * balance changes.
 */
export class InsufficientSpendableError extends DomainError {
  readonly code = 'INSUFFICIENT_SPENDABLE_BALANCE';
  readonly retryable = false;
  constructor(
    readonly requestedPoisha: bigint,
    readonly spendablePoisha: bigint,
  ) {
    super(
      `You can reserve at most ${Money.fromPoisha(spendablePoisha).format()}; ` +
        `${Money.fromPoisha(requestedPoisha).format()} was requested.`,
    );
  }
}

export class ReleaseExceedsReservedError extends DomainError {
  readonly code = 'RELEASE_EXCEEDS_RESERVED';
  readonly retryable = false;
  constructor() {
    super('You cannot release more than this envelope holds.');
  }
}

export interface EnvelopeView extends Omit<EnvelopeSnapshot, 'reservedPoisha' | 'targetPoisha'> {
  readonly reservedPoisha: bigint;
  readonly reservedFormatted: string;
  readonly targetPoisha: bigint | null;
  readonly targetFormatted: string | null;
  /** 0–100, capped. Display only; a goal is never enforced. */
  readonly progressPercent: number | null;
}

export interface WalletBudgetView {
  readonly walletId: string;
  readonly balancePoisha: bigint;
  readonly balanceFormatted: string;
  readonly reservedPoisha: bigint;
  readonly reservedFormatted: string;
  /** balance − reserved. THE number that governs what a transfer may spend. */
  readonly spendablePoisha: bigint;
  readonly spendableFormatted: string;
  readonly currency: string;
  readonly envelopes: readonly EnvelopeView[];
}

/**
 * ============================================================================
 *  SMART-RESERVE EXPENSE ENVELOPES
 * ============================================================================
 *
 * THE RULE THAT DEFINES THIS FEATURE: reserving money MOVES NOTHING.
 *
 * No transfer, no ledger entry, no change to `balance_poisha`. Reserving 5,000
 * for rent does not relocate 5,000 anywhere — it raises the floor the wallet
 * refuses to spend below.
 *
 *     spendable = balance − reserved
 *
 * That is why envelopes are not sub-wallets. Sub-wallets would need their own
 * postings, their own reconciliation, and moving money between envelopes would
 * be a real transfer with real failure modes. Reserved capacity needs none of
 * it: it is a CONSTRAINT ON THE DEBIT, not a place funds live.
 *
 * It also means `ledger_conservation_check` is completely unaffected by this
 * feature — a reservation cannot break an invariant it never touches.
 *
 * WHERE THE CONSTRAINT IS ACTUALLY ENFORCED
 * Not here. This class maintains the numbers; the enforcement is one clause in
 * the conditional atomic debit:
 *
 *     AND balance_poisha - reserved_poisha >= :amount
 *
 * Checking spendable balance in application code would be the lost-update bug
 * wearing a different hat — two concurrent transfers would each read enough
 * spendable capacity and both proceed, spending the rent twice.
 */
@Injectable()
export class EnvelopeUseCases {
  constructor(
    @Inject(ENVELOPE_REPOSITORY) private readonly envelopes: EnvelopeRepositoryPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
    private readonly audit: AuditService,
  ) {}

  async create(
    userId: string,
    input: { name: string; category?: string; icon?: string; targetPoisha?: bigint },
    context: AuditContext,
  ): Promise<WalletBudgetView> {
    const wallet = await this.requireWallet(userId);
    const existing = await this.envelopes.listForWallet(wallet.id);

    if (existing.length >= MAX_ENVELOPES_PER_WALLET) throw new EnvelopeLimitReachedError();
    if (existing.some((e) => e.name.toLowerCase() === input.name.trim().toLowerCase())) {
      throw new DuplicateEnvelopeNameError(input.name);
    }

    const envelopeId = this.ids.generate();
    await this.envelopes.create({
      envelopeId,
      walletId: wallet.id,
      name: input.name.trim(),
      category: input.category ?? null,
      icon: input.icon ?? null,
      targetPoisha: input.targetPoisha ?? null,
    });

    await this.audit.record(
      AuditAction.ENVELOPE_CREATED,
      { type: 'ExpenseEnvelope', id: envelopeId },
      context,
      { after: { name: input.name, walletId: wallet.id } },
    );

    return this.getBudget(userId);
  }

  /**
   * Reserves more capacity into an envelope.
   *
   * The sufficiency check happens in the repository, in SQL, under the wallet's
   * row lock — never here. This method's job is to translate the outcome into a
   * domain error the API can render.
   */
  async reserve(
    userId: string,
    envelopeId: string,
    amountPoisha: bigint,
    context: AuditContext,
  ): Promise<WalletBudgetView> {
    const wallet = await this.requireWallet(userId);
    const amount = Money.fromPoisha(amountPoisha, wallet.currency);
    if (amount.isZero()) throw new ReleaseExceedsReservedError();

    const outcome = await this.envelopes.adjustReservation(envelopeId, wallet.id, amount.poisha);

    if (outcome === 'NOT_FOUND') throw new EnvelopeNotFoundError(envelopeId);
    if (outcome === 'REJECTED_INSUFFICIENT') {
      // Re-read to report the CURRENT spendable figure, not the one from before
      // the attempt — a concurrent transfer may have moved it.
      const fresh = await this.requireWallet(userId);
      throw new InsufficientSpendableError(
        amount.poisha,
        fresh.balancePoisha - fresh.reservedPoisha,
      );
    }

    await this.audit.record(
      AuditAction.ENVELOPE_RESERVED,
      { type: 'ExpenseEnvelope', id: envelopeId },
      context,
      { after: { deltaPoisha: amount.poisha.toString() } },
    );

    return this.getBudget(userId);
  }

  /** Releases capacity back to spendable. Cannot release more than is held. */
  async unlock(
    userId: string,
    envelopeId: string,
    amountPoisha: bigint,
    context: AuditContext,
  ): Promise<WalletBudgetView> {
    const wallet = await this.requireWallet(userId);
    const amount = Money.fromPoisha(amountPoisha, wallet.currency);

    const outcome = await this.envelopes.adjustReservation(envelopeId, wallet.id, -amount.poisha);

    if (outcome === 'NOT_FOUND') throw new EnvelopeNotFoundError(envelopeId);
    if (outcome === 'REJECTED_NEGATIVE') throw new ReleaseExceedsReservedError();

    await this.audit.record(
      AuditAction.ENVELOPE_RELEASED,
      { type: 'ExpenseEnvelope', id: envelopeId },
      context,
      { after: { deltaPoisha: (-amount.poisha).toString() } },
    );

    return this.getBudget(userId);
  }

  /** Deleting releases the whole reservation first — money is never stranded. */
  async remove(userId: string, envelopeId: string, context: AuditContext): Promise<WalletBudgetView> {
    const wallet = await this.requireWallet(userId);
    const envelope = await this.envelopes.findById(envelopeId);

    if (!envelope || envelope.walletId !== wallet.id) throw new EnvelopeNotFoundError(envelopeId);

    if (envelope.reservedPoisha > 0n) {
      await this.envelopes.adjustReservation(envelopeId, wallet.id, -envelope.reservedPoisha);
    }
    await this.envelopes.delete(envelopeId, wallet.id);

    await this.audit.record(
      AuditAction.ENVELOPE_DELETED,
      { type: 'ExpenseEnvelope', id: envelopeId },
      context,
      { before: { name: envelope.name, reservedPoisha: envelope.reservedPoisha.toString() } },
    );

    return this.getBudget(userId);
  }

  /**
   * The budget view: balance, reserved, spendable, and every envelope.
   *
   * `spendable` is computed from the WALLET's aggregate, not by summing
   * envelopes, so what the user sees is exactly what the debit guard will
   * enforce. Summing here instead would let the display and the enforcement
   * disagree, which is the most confusing failure a budgeting feature can have.
   */
  async getBudget(userId: string): Promise<WalletBudgetView> {
    const wallet = await this.requireWallet(userId);
    const envelopes = await this.envelopes.listForWallet(wallet.id);
    const spendable = wallet.balancePoisha - wallet.reservedPoisha;

    return {
      walletId: wallet.id,
      balancePoisha: wallet.balancePoisha,
      balanceFormatted: Money.fromPoisha(wallet.balancePoisha, wallet.currency).format(),
      reservedPoisha: wallet.reservedPoisha,
      reservedFormatted: Money.fromPoisha(wallet.reservedPoisha, wallet.currency).format(),
      spendablePoisha: spendable,
      spendableFormatted: Money.fromPoisha(
        spendable < 0n ? 0n : spendable,
        wallet.currency,
      ).format(),
      currency: wallet.currency,
      envelopes: envelopes.map((envelope) => this.toView(envelope, wallet.currency)),
    };
  }

  private toView(envelope: EnvelopeSnapshot, currency: string): EnvelopeView {
    const progress =
      envelope.targetPoisha && envelope.targetPoisha > 0n
        ? Math.min(
            100,
            Number((envelope.reservedPoisha * 100n) / envelope.targetPoisha),
          )
        : null;

    return {
      ...envelope,
      reservedFormatted: Money.fromPoisha(envelope.reservedPoisha, currency).format(),
      targetFormatted: envelope.targetPoisha
        ? Money.fromPoisha(envelope.targetPoisha, currency).format()
        : null,
      progressPercent: progress,
    };
  }

  private async requireWallet(userId: string) {
    const wallet = await this.wallets.findByUserId(userId);
    if (!wallet) throw new WalletNotFoundError(userId);
    return wallet;
  }
}
