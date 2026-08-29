import { Injectable } from '@nestjs/common';

import {
  TransactionContext,
  WalletRepositoryPort,
  WalletSnapshot,
} from '../../application/ports/repositories.port';
import { PrismaService, clientFor, fromTransactionContext } from '../prisma/prisma.service';

interface WalletRow {
  id: string;
  user_id: string | null;
  type: 'USER' | 'POT' | 'SYSTEM';
  currency: string;
  balance_poisha: bigint;
  reserved_poisha: bigint;
  status: 'ACTIVE' | 'FROZEN' | 'UNDER_REVIEW' | 'CLOSED';
  version: number;
  freeze_reason: string | null;
}

/**
 * Wallet persistence. The most safety-critical repository in the system.
 *
 * Note what this class does NOT expose: there is no `setBalance`, and no
 * `getBalance` intended for arithmetic. Offering either would invite
 * read-modify-write, which is the lost-update bug (constraint C1). The only
 * way to reduce a balance here is `debitIfSufficient`, which cannot be used
 * unsafely.
 */
@Injectable()
export class PrismaWalletRepository implements WalletRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findById(walletId: string, context?: TransactionContext): Promise<WalletSnapshot | null> {
    const wallet = await clientFor(this.prisma, context).wallet.findUnique({
      where: { id: walletId },
    });
    return wallet ? this.toSnapshot(wallet) : null;
  }

  async findByUserId(userId: string, context?: TransactionContext): Promise<WalletSnapshot | null> {
    const wallet = await clientFor(this.prisma, context).wallet.findUnique({
      where: { userId },
    });
    return wallet ? this.toSnapshot(wallet) : null;
  }

  /**
   * Acquires row locks in ASCENDING ID ORDER — the deadlock-avoidance rule.
   *
   * `ORDER BY id` inside the statement is not cosmetic. It is what guarantees
   * every transaction in the system takes locks in the same total order, so a
   * lock CYCLE cannot form and two reciprocal transfers serialise instead of
   * deadlocking (ARCHITECTURE.md §5 Figure 4).
   *
   * Sorting happens HERE rather than being asked of the caller: a rule enforced
   * only by convention is a rule a new code path eventually skips.
   *
   * Raw SQL because Prisma has no `FOR UPDATE`. This is one of the few places
   * the escape hatch is mandatory rather than convenient.
   */
  async lockForUpdate(
    walletIds: readonly string[],
    context: TransactionContext,
  ): Promise<readonly WalletSnapshot[]> {
    const tx = fromTransactionContext(context);
    const ordered = [...new Set(walletIds)].sort();

    const rows = await tx.$queryRaw<WalletRow[]>`
      SELECT id, user_id, type, currency, balance_poisha, reserved_poisha,
             status, version, freeze_reason
      FROM wallets
      WHERE id = ANY(${ordered}::uuid[])
      ORDER BY id
      FOR UPDATE
    `;

    return rows.map((row) => this.fromRow(row));
  }

  /**
   * THE conditional atomic debit (ARCHITECTURE.md §5 Stage 3).
   *
   * Compiles to ONE statement:
   *   UPDATE wallets SET balance_poisha = balance_poisha - $1, version = version + 1
   *   WHERE id = $2 AND status = 'ACTIVE' AND balance_poisha >= $1
   *
   * The database evaluates the guard and performs the mutation as one atomic
   * operation and reports how many rows changed. `count === 0` means the guard
   * rejected it — insufficient funds, or a wallet that stopped being active.
   *
   * `updateMany`, not `update`: `update` targets a unique row and THROWS when
   * the where-clause does not match, which would conflate "insufficient funds"
   * with "wallet does not exist". `updateMany` returns a count, which is the
   * distinction we need.
   *
   * The `balance_poisha >= amount` guard is also re-evaluated by PostgreSQL
   * against the newest committed row version under Read Committed, so it can
   * never be decided on stale data.
   */
  async debitIfSufficient(
    walletId: string,
    amountPoisha: bigint,
    context: TransactionContext,
  ): Promise<boolean> {
    const tx = fromTransactionContext(context);

    // Raw SQL, not `updateMany`, for ONE reason: the guard is now a
    // COLUMN-TO-COLUMN comparison — `balance_poisha - reserved_poisha >= :amount`
    // — and Prisma's query builder cannot express one field referencing another.
    //
    // Keeping it a single statement is non-negotiable. Reading `reserved_poisha`
    // into application code and subtracting there would reintroduce exactly the
    // read-modify-write race (constraint C1) that this method exists to prevent:
    // two concurrent transfers would each see enough spendable balance and both
    // proceed, spending reserved rent money twice.
    //
    // SYSTEM wallets are exempt from the sufficiency test, matching
    // `wallets_balance_non_negative` in hardening.sql — the genesis account is
    // supposed to run negative, since its balance is the negative of all money
    // ever issued.
    const affected = await tx.$executeRaw`
      UPDATE wallets
         SET balance_poisha = balance_poisha - ${amountPoisha}::bigint,
             version        = version + 1,
             updated_at     = now()
       WHERE id = ${walletId}::uuid
         AND status = 'ACTIVE'
         AND (
           type = 'SYSTEM'
           OR balance_poisha - reserved_poisha >= ${amountPoisha}::bigint
         )
    `;

    return affected === 1;
  }

  /**
   * Unconditional credit.
   *
   * Guarded on `status <> 'CLOSED'`, NOT on `status = 'ACTIVE'` — deliberately
   * looser than the debit.
   *
   * A freeze stops a wallet LEAKING money; it must not stop money arriving.
   * Blocking incoming funds would mean someone who froze their wallet after
   * losing their phone also loses that week's salary, while the incoming money
   * is perfectly safe precisely because the attacker cannot get it out.
   *
   * CLOSED is the exception: there is nobody left to spend it, so a credit
   * would strand the money permanently.
   *
   * This mirrors `TransactionValidator.assertCanReceive`, and this is the layer
   * that actually enforces it.
   */
  async credit(
    walletId: string,
    amountPoisha: bigint,
    context: TransactionContext,
  ): Promise<void> {
    const tx = fromTransactionContext(context);

    const { count } = await tx.wallet.updateMany({
      where: { id: walletId, status: { not: 'CLOSED' } },
      data: {
        balancePoisha: { increment: amountPoisha },
        version: { increment: 1 },
      },
    });

    if (count !== 1) {
      // Rolls back the whole transfer — including the debit. Money is never
      // taken from one wallet without arriving in another.
      throw new Error(`Credit failed: wallet ${walletId} is closed or does not exist.`);
    }
  }

  private toSnapshot(wallet: {
    id: string;
    userId: string | null;
    type: 'USER' | 'POT' | 'SYSTEM';
    currency: string;
    balancePoisha: bigint;
    reservedPoisha: bigint;
    status: 'ACTIVE' | 'FROZEN' | 'UNDER_REVIEW' | 'CLOSED';
    version: number;
    freezeReason?: string | null;
  }): WalletSnapshot {
    return {
      id: wallet.id,
      userId: wallet.userId,
      type: wallet.type,
      currency: wallet.currency.trim(),
      balancePoisha: wallet.balancePoisha,
      reservedPoisha: wallet.reservedPoisha,
      status: wallet.status,
      version: wallet.version,
      freezeReason: wallet.freezeReason ?? null,
    };
  }

  /** Raw-SQL rows come back snake_case, unlike the Prisma client's mapping. */
  private fromRow(row: WalletRow): WalletSnapshot {
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type,
      currency: row.currency.trim(),
      balancePoisha: BigInt(row.balance_poisha),
      reservedPoisha: BigInt(row.reserved_poisha),
      status: row.status,
      version: Number(row.version),
      freezeReason: row.freeze_reason,
    };
  }
}
