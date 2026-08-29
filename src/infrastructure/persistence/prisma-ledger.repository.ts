import { Injectable } from '@nestjs/common';

import { LedgerIntegrityError } from '../../domain/errors/domain-errors';
import {
  LedgerEntryInput,
  LedgerRepositoryPort,
  TransactionContext,
} from '../../application/ports/repositories.port';
import { PrismaService, clientFor, fromTransactionContext } from '../prisma/prisma.service';

/**
 * The ledger — append only. No update method, no delete method, by design.
 *
 * The absence is the interface: there is no way to express "edit history"
 * through this class. `hardening.sql` enforces the same rule independently with
 * a trigger that rejects UPDATE and DELETE outright, and by withholding those
 * grants from the application role.
 */
@Injectable()
export class PrismaLedgerRepository implements LedgerRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends a balanced set of postings.
   *
   * THE ZERO-SUM CHECK RUNS BEFORE THE WRITE, deliberately. These rows become
   * immutable the moment they commit — there is no UPDATE path to fix them
   * afterwards, only a compensating reversal. Catching an unbalanced posting
   * here costs an exception; catching it tomorrow costs a reconciliation
   * incident and a manual correction.
   */
  async postEntries(
    entries: readonly LedgerEntryInput[],
    context: TransactionContext,
  ): Promise<void> {
    if (entries.length === 0) return;

    const net = entries.reduce((sum, entry) => sum + entry.amountPoisha, 0n);
    if (net !== 0n) {
      throw new LedgerIntegrityError(
        `Refusing to post ${entries.length} entries summing to ${net} poisha. ` +
          'Double-entry postings must net to exactly zero.',
      );
    }

    // Guards the redundancy between `direction` and the sign of the amount,
    // matching the CHECK constraint in hardening.sql. Failing here produces a
    // message naming the offending entry; failing at the constraint produces
    // an opaque SQLSTATE.
    for (const entry of entries) {
      const signCorrect =
        (entry.direction === 'DEBIT' && entry.amountPoisha < 0n) ||
        (entry.direction === 'CREDIT' && entry.amountPoisha > 0n);

      if (!signCorrect) {
        throw new LedgerIntegrityError(
          `Entry ${entry.id} is ${entry.direction} with amount ${entry.amountPoisha}. ` +
            'DEBIT must be negative, CREDIT must be positive.',
        );
      }
    }

    const tx = fromTransactionContext(context);
    await tx.ledgerEntry.createMany({
      data: entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        walletId: entry.walletId,
        direction: entry.direction,
        amountPoisha: entry.amountPoisha,
        balanceAfterPoisha: entry.balanceAfterPoisha,
        currency: entry.currency,
      })),
    });
  }

  /** The authoritative balance for a wallet: the sum of its postings. */
  async sumForWallet(walletId: string, context?: TransactionContext): Promise<bigint> {
    const result = await clientFor(this.prisma, context).ledgerEntry.aggregate({
      where: { walletId },
      _sum: { amountPoisha: true },
    });
    return result._sum.amountPoisha ?? 0n;
  }

  /** The recovery sweep's safety check — see `TransactionRecoveryService`. */
  async countEntriesForTransaction(
    transactionId: string,
    context?: TransactionContext,
  ): Promise<number> {
    return clientFor(this.prisma, context).ledgerEntry.count({ where: { transactionId } });
  }
}
