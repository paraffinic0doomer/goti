import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  AUDIT_REPOSITORY,
  AuditRepositoryPort,
  TransactionContext,
} from '../ports/repositories.port';

/**
 * The audit vocabulary.
 *
 * Constants, not free strings: a typo in `'auth.login_faild'` produces a row
 * nobody will ever query, and the gap is only discovered during an incident
 * when the evidence is needed and missing. VarChar in the database (the
 * vocabulary grows weekly), a closed set in code.
 */
export const AuditAction = {
  // Authentication
  LOGIN_SUCCEEDED: 'auth.login_succeeded',
  LOGIN_FAILED: 'auth.login_failed',
  REGISTERED: 'auth.registered',
  PASSWORD_REHASHED: 'auth.password_rehashed',

  // Money movement
  TRANSFER_ATTEMPTED: 'transaction.attempted',
  TRANSFER_COMPLETED: 'transaction.completed',
  TRANSFER_FAILED: 'transaction.failed',
  TRANSFER_DUPLICATE: 'transaction.duplicate_rejected',

  // Money requests
  REQUEST_CREATED: 'money_request.created',
  REQUEST_ACCEPTED: 'money_request.accepted',
  REQUEST_DECLINED: 'money_request.declined',
  REQUEST_CANCELLED: 'money_request.cancelled',

  // Wallet security — emergency freeze
  WALLET_FROZEN: 'wallet.frozen',
  WALLET_UNFROZEN: 'wallet.unfrozen',
  WALLET_UNDER_REVIEW: 'wallet.marked_under_review',

  // Expense envelopes — reserved capacity, never money movement
  ENVELOPE_CREATED: 'envelope.created',
  ENVELOPE_RESERVED: 'envelope.reserved',
  ENVELOPE_RELEASED: 'envelope.released',
  ENVELOPE_DELETED: 'envelope.deleted',

  // Group pots
  POT_CREATED: 'pot.created',
  POT_JOINED: 'pot.joined',
  POT_CONTRIBUTED: 'pot.contributed',
  POT_SETTLED: 'pot.settled',

  // Security questions — the knowledge factor
  SECURITY_CHALLENGE_RAISED: 'security.challenge_raised',
  SECURITY_CHALLENGE_PASSED: 'security.challenge_passed',
  SECURITY_CHALLENGE_FAILED: 'security.challenge_failed',
  SECURITY_AUTO_FROZEN: 'security.auto_frozen_wrong_answer',
  SECURITY_LOCKED_OUT: 'security.locked_out_too_many_attempts',

  // Risk
  RISK_FLAGGED: 'risk.flagged',
  RISK_BLOCKED: 'risk.blocked_transfer',
  RATE_LIMITED: 'security.rate_limited',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

/** Request metadata carried for forensics. Never used in a business decision. */
export interface AuditContext {
  readonly actorUserId: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly correlationId?: string | null;
}

/**
 * Audit trail — the ACTOR axis.
 *
 * Distinct from the other two append-only logs (DATABASE.md §1):
 *   ledger_entries      → where is the money?
 *   transaction_events  → what happened to this movement?
 *   audit_logs          → WHO did what, from where?
 *
 * This is the only one of the three that can record an action which moved no
 * money — a failed login, a password change, an admin freeze — which is
 * precisely why it cannot be folded into the others.
 *
 * FAILURE POLICY: audit writes never throw to the caller. An audit row is
 * evidence, and losing one is bad; failing a user's login because the audit
 * table was briefly unavailable is worse. Failures are logged at `error` so
 * the gap itself is visible.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepositoryPort) {}

  /**
   * Records an action outside any database transaction.
   *
   * For events with no money transaction to join — logins, registrations,
   * rate-limit rejections.
   */
  async record(
    action: AuditActionValue,
    entity: { type: string; id: string },
    context: AuditContext,
    details?: { before?: Record<string, unknown>; after?: Record<string, unknown> },
  ): Promise<void> {
    try {
      await this.audit.recordStandalone({
        actorUserId: context.actorUserId,
        actorType: context.actorUserId ? 'USER' : 'SYSTEM',
        action,
        entityType: entity.type,
        entityId: entity.id,
        before: details?.before ?? null,
        after: details?.after ?? null,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        correlationId: context.correlationId ?? null,
      });
    } catch (error) {
      this.logger.error(
        `AUDIT WRITE FAILED for "${action}" on ${entity.type}:${entity.id}: ` +
          `${(error as Error).message}. The action itself was not affected.`,
      );
    }
  }

  /**
   * Records inside an open transaction, so the audit row shares its atomicity.
   *
   * Used on the money path: a committed transfer always has its audit row, and
   * a rolled-back one has none. Unlike `record`, this DOES propagate failures —
   * inside a money transaction, a failed audit write must roll the whole thing
   * back rather than leave a movement with no trail.
   */
  async recordInTransaction(
    action: AuditActionValue,
    entity: { type: string; id: string },
    context: AuditContext,
    transactionContext: TransactionContext,
    details?: { before?: Record<string, unknown>; after?: Record<string, unknown> },
  ): Promise<void> {
    await this.audit.record(
      {
        actorUserId: context.actorUserId,
        actorType: context.actorUserId ? 'USER' : 'SYSTEM',
        action,
        entityType: entity.type,
        entityId: entity.id,
        before: details?.before ?? null,
        after: details?.after ?? null,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        correlationId: context.correlationId ?? null,
      },
      transactionContext,
    );
  }

  /**
   * Records a failed authentication attempt.
   *
   * The identifier is stored as SUBMITTED, whether or not the account exists.
   * That is deliberate: a burst of failures against non-existent phone numbers
   * is account enumeration, and it is only visible if the misses are recorded
   * alongside the hits. `actorUserId` stays null — nobody is authenticated.
   */
  async recordFailedLogin(
    submittedPhone: string,
    reason: string,
    context: Omit<AuditContext, 'actorUserId'>,
  ): Promise<void> {
    await this.record(
      AuditAction.LOGIN_FAILED,
      { type: 'AuthAttempt', id: submittedPhone },
      { ...context, actorUserId: null },
      // The reason is recorded internally but never returned to the client —
      // see LoginUserUseCase on why the response must not distinguish causes.
      { after: { reason, submittedPhone } },
    );
  }
}
