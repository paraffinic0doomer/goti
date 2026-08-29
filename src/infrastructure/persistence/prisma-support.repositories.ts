import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import {
  AuditLogInput,
  AuditRepositoryPort,
  ClockPort,
  IdGeneratorPort,
  ReconciliationPort,
  ReconciliationResult,
  TransactionContext,
  TransactionEventInput,
  TransactionEventRecord,
  TransactionEventRepositoryPort,
  TransactionEventType,
  UserRepositoryPort,
  UserSnapshot,
} from '../../application/ports/repositories.port';
import { PrismaService, clientFor, fromTransactionContext } from '../prisma/prisma.service';

// ===========================================================================
//  Users
// ===========================================================================

@Injectable()
export class PrismaUserRepository implements UserRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findById(userId: string, context?: TransactionContext): Promise<UserSnapshot | null> {
    const user = await clientFor(this.prisma, context).user.findUnique({
      where: { id: userId },
      include: { wallet: { select: { id: true } } },
    });
    return user ? this.toSnapshot(user) : null;
  }

  async findByPhone(phone: string, context?: TransactionContext): Promise<UserSnapshot | null> {
    const user = await clientFor(this.prisma, context).user.findUnique({
      where: { phone },
      include: { wallet: { select: { id: true } } },
    });
    return user ? this.toSnapshot(user) : null;
  }

  private toSnapshot(user: {
    id: string;
    phone: string;
    displayName: string;
    status: string;
    wallet: { id: string } | null;
  }): UserSnapshot {
    return {
      id: user.id,
      phone: user.phone,
      displayName: user.displayName,
      status: user.status as UserSnapshot['status'],
      walletId: user.wallet?.id ?? null,
    };
  }
}

// ===========================================================================
//  Transaction events — the timeline AND the outbox
// ===========================================================================

@Injectable()
export class PrismaTransactionEventRepository implements TransactionEventRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ONE batched insert for the whole timeline.
   *
   * Seven events written as seven round trips would multiply the critical
   * section — the window during which both wallets are locked — for data
   * nobody reads synchronously. `createMany` makes it one statement.
   */
  async appendMany(
    events: readonly TransactionEventInput[],
    context: TransactionContext,
  ): Promise<void> {
    if (events.length === 0) return;

    const tx = fromTransactionContext(context);
    await tx.transactionEvent.createMany({
      data: events.map((event) => ({
        transactionId: event.transactionId,
        type: event.type,
        payload: event.payload as object,
        occurredAt: event.occurredAt,
        // Pre-set for internal lifecycle steps so the outbox worker skips them;
        // null only for the three events that become notifications.
        publishedAt: event.publishedAt,
      })),
    });
  }

  async findByTransactionId(transactionId: string): Promise<readonly TransactionEventRecord[]> {
    const rows = await this.prisma.transactionEvent.findMany({
      where: { transactionId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      transactionId: row.transactionId,
      type: row.type as TransactionEventType,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      occurredAt: row.occurredAt,
      publishedAt: row.publishedAt,
    }));
  }
}

// ===========================================================================
//  Audit
// ===========================================================================

@Injectable()
export class PrismaAuditRepository implements AuditRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /** Inside the money transaction, so the audit trail shares its atomicity. */
  async record(entry: AuditLogInput, context: TransactionContext): Promise<void> {
    const tx = fromTransactionContext(context);
    await tx.auditLog.create({ data: this.toRow(entry) });
  }

  /** For non-financial actions with no transaction to join — login, PIN change. */
  async recordStandalone(entry: AuditLogInput): Promise<void> {
    await this.prisma.auditLog.create({ data: this.toRow(entry) });
  }

  private toRow(entry: AuditLogInput) {
    return {
      actorUserId: entry.actorUserId,
      actorType: entry.actorType,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: (entry.before ?? undefined) as object | undefined,
      after: (entry.after ?? undefined) as object | undefined,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
      correlationId: entry.correlationId ?? null,
    };
  }
}

// ===========================================================================
//  Reconciliation — the money-integrity assertion
// ===========================================================================

@Injectable()
export class PrismaReconciliationAdapter implements ReconciliationPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads the two views from `hardening.sql`.
   *
   * The assertion lives in the database, expressed once, next to the data —
   * not reimplemented in TypeScript where it could drift from the SQL that
   * defines correctness.
   */
  async check(): Promise<ReconciliationResult> {
    const [driftRows, conservation] = await Promise.all([
      this.prisma.$queryRaw<{ wallet_id: string }[]>`
        SELECT wallet_id FROM wallet_balance_drift
      `,
      this.prisma.$queryRaw<{ net_poisha: bigint }[]>`
        SELECT net_poisha FROM ledger_conservation_check
      `,
    ]);

    const net = conservation[0]?.net_poisha ?? 0n;
    const walletsWithDrift = driftRows.length;

    return {
      walletsWithDrift,
      ledgerNetPoisha: BigInt(net),
      healthy: walletsWithDrift === 0 && BigInt(net) === 0n,
    };
  }
}

// ===========================================================================
//  Clock and ID generation
// ===========================================================================

/** Injected rather than called ambiently, so tests can freeze time. */
@Injectable()
export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}

/**
 * UUIDv7 generator — time-ordered identifiers.
 *
 * DATABASE.md §6: UUIDv4 is uniformly random, so inserts scatter across the
 * whole B-tree instead of appending at its right edge. At `ledger_entries`
 * volumes (6.4M rows/day) that means constant page splits, poor cache locality
 * and index bloat.
 *
 * Layout (RFC 9562): 48-bit millisecond timestamp, 4-bit version, 12-bit
 * counter, 2-bit variant, 62 bits of randomness. The counter keeps IDs minted
 * within the same millisecond strictly increasing, so ordering holds even under
 * the burst rates this engine is built for.
 */
@Injectable()
export class UuidV7Generator implements IdGeneratorPort {
  private lastTimestampMs = 0;
  private counter = 0;

  generate(): string {
    const now = Date.now();
    const timestamp = Math.max(now, this.lastTimestampMs);

    if (timestamp === this.lastTimestampMs) {
      // 12 bits of counter space. Overflow within one millisecond would break
      // monotonicity, so borrow from the next millisecond instead of wrapping.
      this.counter += 1;
      if (this.counter > 0xfff) {
        this.lastTimestampMs += 1;
        this.counter = 0;
      }
    } else {
      this.lastTimestampMs = timestamp;
      this.counter = 0;
    }

    const timestampHex = this.lastTimestampMs.toString(16).padStart(12, '0');
    const counterHex = this.counter.toString(16).padStart(3, '0');

    const random = randomBytes(8);

    // Variant bits: 10xxxxxx in the first byte of the final block.
    random[0] = (random[0]! & 0x3f) | 0x80;
    const randomHex = random.toString('hex');

    return [
      timestampHex.slice(0, 8),
      timestampHex.slice(8, 12),
      `7${counterHex}`,
      randomHex.slice(0, 4),
      randomHex.slice(4, 16),
    ].join('-');
  }
}
