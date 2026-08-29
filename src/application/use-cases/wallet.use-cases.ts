import { Inject, Injectable, Logger } from '@nestjs/common';

import { UserNotFoundError, WalletNotFoundError } from '../../domain/errors/domain-errors';
import { Money } from '../../domain/money/money';
import { CACHE_PORT, CachePort, RATE_LIMITER_PORT, RateLimitAction, RateLimiterPort } from '../ports';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
  WALLET_REPOSITORY,
  WalletRepositoryPort,
} from '../ports/repositories.port';
import { TransactionProcessor } from '../transaction-engine/transaction.processor';
import { TransferResult } from '../transaction-engine/transaction.types';
import { AuditAction, AuditContext, AuditService } from '../services/audit.service';
import { RiskEngineService } from '../services/risk-engine.service';
import {
  SecurityChallengeRequiredError,
  SecurityQuestionService,
} from '../services/security-question.service';
import { DomainError } from '../../domain/errors/domain-errors';
import { RateLimitExceededError } from '../errors/application-errors';
import { ApplicationCacheKeys } from '../cache/cache.keys';

/** DISPLAY-ONLY cache. Short by design — a stale balance is a support ticket. */
const BALANCE_CACHE_TTL_SECONDS = 5;

export class TransferBlockedByRiskError extends DomainError {
  readonly code = 'BLOCKED_BY_RISK_POLICY';
  readonly retryable = false;
  constructor(readonly reasons: readonly string[]) {
    super(`Transfer blocked by risk policy: ${reasons.join('; ')}`);
  }
}

export interface WalletView {
  readonly walletId: string;
  readonly userId: string;
  readonly ownerName: string;
  readonly balancePoisha: bigint;
  readonly balanceFormatted: string;
  readonly currency: string;
  readonly status: string;
}

export interface BalanceView {
  readonly walletId: string;
  readonly balancePoisha: bigint;
  readonly balanceFormatted: string;
  readonly currency: string;
  /** True when served from cache. Lets a client know how fresh the figure is. */
  readonly cached: boolean;
}

/**
 * Wallet reads.
 *
 * THE CACHING RULE, stated once and enforced everywhere:
 *
 *   The cached balance is DISPLAY ONLY. The Transaction Engine never reads it.
 *
 * Authorisation reads the balance from PostgreSQL inside the row lock, via the
 * conditional atomic update. A cached balance authorising a debit would make
 * every cache staleness window an overdraft window.
 *
 * The TTL is 5 seconds because the underlying query is a primary-key lookup
 * PostgreSQL answers in well under a millisecond — the cache saves a network
 * round trip and a pool slot, not a slow query, so there is no reason to accept
 * more staleness than that (REDIS.md §6).
 */
@Injectable()
export class GetWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
  ) {}

  async getWallet(userId: string): Promise<WalletView> {
    const [wallet, user] = await Promise.all([
      this.wallets.findByUserId(userId),
      this.users.findById(userId),
    ]);

    if (!wallet) throw new WalletNotFoundError(userId);
    if (!user) throw new UserNotFoundError(userId);

    // Read straight from PostgreSQL, uncached. The full wallet view is a rare
    // call, and correctness of the figure matters more than 1ms.
    return {
      walletId: wallet.id,
      userId,
      ownerName: user.displayName,
      balancePoisha: wallet.balancePoisha,
      balanceFormatted: Money.fromPoisha(wallet.balancePoisha, wallet.currency).format(),
      currency: wallet.currency,
      status: wallet.status,
    };
  }

  /**
   * The hot read — cached with read-through.
   *
   * `getOrLoad` collapses concurrent misses within an instance into a single
   * database query, so a hot key expiring cannot send a burst of identical
   * lookups at PostgreSQL.
   */
  async getBalance(userId: string): Promise<BalanceView> {
    const key = ApplicationCacheKeys.walletBalanceByUser(userId);
    const cachedValue = await this.cache.get<{
      walletId: string;
      balancePoisha: bigint;
      currency: string;
    }>(key);

    if (cachedValue) {
      return {
        walletId: cachedValue.walletId,
        balancePoisha: cachedValue.balancePoisha,
        balanceFormatted: Money.fromPoisha(
          cachedValue.balancePoisha,
          cachedValue.currency,
        ).format(),
        currency: cachedValue.currency,
        cached: true,
      };
    }

    const wallet = await this.wallets.findByUserId(userId);
    if (!wallet) throw new WalletNotFoundError(userId);

    await this.cache.set(
      key,
      { walletId: wallet.id, balancePoisha: wallet.balancePoisha, currency: wallet.currency },
      BALANCE_CACHE_TTL_SECONDS,
    );

    return {
      walletId: wallet.id,
      balancePoisha: wallet.balancePoisha,
      balanceFormatted: Money.fromPoisha(wallet.balancePoisha, wallet.currency).format(),
      currency: wallet.currency,
      cached: false,
    };
  }
}

export interface SendMoneyCommand {
  readonly senderUserId: string;
  readonly receiverId?: string;
  readonly receiverPhone?: string;
  readonly amountPoisha: bigint;
  readonly idempotencyKey: string;
  readonly note?: string | null;
}

/**
 * Send money — the application-layer orchestration around the engine.
 *
 * WHAT THIS CLASS DOES AND DOES NOT DO
 *
 * It does NOT move money. It sequences the concerns that surround a transfer:
 * throttling, risk assessment, delegation to the engine, audit, and mapping the
 * outcome to something a controller can render. Every balance change happens
 * inside `TransactionProcessor`, which is the only component permitted to make
 * one.
 *
 * ORDERING IS DELIBERATE. Rate limit first (cheapest rejection), then risk
 * (three indexed reads), then the engine (locks and writes). Each stage is more
 * expensive than the last, so the cheapest gate rejects the most traffic.
 */
@Injectable()
export class SendMoneyUseCase {
  private readonly logger = new Logger(SendMoneyUseCase.name);

  constructor(
    private readonly processor: TransactionProcessor,
    private readonly risk: RiskEngineService,
    private readonly audit: AuditService,
    private readonly securityQuestions: SecurityQuestionService,
    @Inject(RATE_LIMITER_PORT) private readonly rateLimiter: RateLimiterPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(command: SendMoneyCommand, context: AuditContext): Promise<TransferResult> {
    // --- Gate 1: throttle. Cheapest possible rejection. ---
    const limit = await this.rateLimiter.consume(
      RateLimitAction.TRANSACTION,
      command.senderUserId,
    );

    if (!limit.allowed) {
      await this.audit.record(
        AuditAction.RATE_LIMITED,
        { type: 'User', id: command.senderUserId },
        context,
        { after: { action: 'send_money', retryAfterSeconds: limit.retryAfterSeconds } },
      );
      throw new RateLimitExceededError(limit.retryAfterSeconds);
    }

    await this.audit.record(
      AuditAction.TRANSFER_ATTEMPTED,
      { type: 'Transaction', id: command.idempotencyKey },
      context,
      { after: { amountPoisha: command.amountPoisha.toString(), receiverId: command.receiverId } },
    );

    // --- Gate 2: THE KNOWLEDGE FACTOR ---
    //
    // A large transfer must be authorised by someone who knows the security
    // answer, not merely someone who knows the password. This is what makes a
    // stolen password insufficient to drain an account.
    //
    // The check runs BEFORE risk and before the engine, so an attacker never
    // reaches the money path at all.
    const senderWallet = await this.wallets.findByUserId(command.senderUserId);
    if (
      senderWallet &&
      this.securityQuestions.requiresChallenge(
        command.amountPoisha,
        senderWallet.balancePoisha,
      )
    ) {
      const alreadyAuthorised = await this.securityQuestions.hasPassedTransferChallenge(
        command.senderUserId,
        command.idempotencyKey,
        command.amountPoisha,
      );

      if (!alreadyAuthorised) {
        const challenge = await this.securityQuestions.raiseChallenge(
          command.senderUserId,
          'TRANSFER',
          { idempotencyKey: command.idempotencyKey, amountPoisha: command.amountPoisha },
          { ipAddress: context.ipAddress, correlationId: context.correlationId },
        );

        await this.audit.record(
          AuditAction.SECURITY_CHALLENGE_RAISED,
          { type: 'SecurityChallenge', id: challenge.challengeId },
          context,
          { after: { purpose: 'TRANSFER', amountPoisha: command.amountPoisha.toString() } },
        );

        throw new SecurityChallengeRequiredError(
          challenge.challengeId,
          challenge.questionKey,
          challenge.prompt,
          challenge.expiresAt,
        );
      }
    }

    // --- Gate 3: risk. Assessed BEFORE the transfer, flagged after. ---
    const assessment = await this.assessRisk(command);

    if (assessment?.shouldBlock) {
      await this.risk.recordAssessment(assessment, command.senderUserId, null);
      await this.audit.record(
        AuditAction.RISK_BLOCKED,
        { type: 'User', id: command.senderUserId },
        context,
        { after: { score: assessment.score, level: assessment.level } },
      );
      throw new TransferBlockedByRiskError(
        assessment.triggeredRules.map((rule) => rule.explanation),
      );
    }

    // --- Gate 4: the engine. Locks, debits, credits, posts, commits. ---
    let result: TransferResult;
    try {
      result = await this.processor.process({
        idempotencyKey: command.idempotencyKey,
        initiatorUserId: command.senderUserId,
        senderUserId: command.senderUserId,
        receiverUserId: command.receiverId,
        receiverPhone: command.receiverPhone,
        amountPoisha: command.amountPoisha,
        currency: 'BDT',
        note: command.note ?? null,
        type: 'P2P_TRANSFER',
        correlationId: context.correlationId ?? null,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      });
    } catch (error) {
      await this.audit.record(
        AuditAction.TRANSFER_FAILED,
        { type: 'TransferAttempt', id: command.idempotencyKey },
        context,
        { after: { failureType: (error as Error).name || 'UnknownError' } },
      );
      throw error;
    }

    // Persisted AFTER commit: the money has moved and is durably recorded, so a
    // risk-store failure must not be able to fail a transfer that succeeded.
    if (assessment) {
      await this.risk.recordAssessment(
        assessment,
        command.senderUserId,
        result.status === 'COMPLETED' ? result.transactionId : null,
      );

      if (assessment.level !== 'LOW') {
        await this.audit.record(
          AuditAction.RISK_FLAGGED,
          { type: 'Transaction', id: result.transactionId },
          context,
          {
            after: {
              score: assessment.score,
              level: assessment.level,
              rules: assessment.triggeredRules.map((rule) => rule.rule),
            },
          },
        );
      }
    }

    await this.audit.record(
      result.outcome === 'REPLAYED'
        ? AuditAction.TRANSFER_DUPLICATE
        : result.status === 'COMPLETED'
          ? AuditAction.TRANSFER_COMPLETED
          : AuditAction.TRANSFER_FAILED,
      { type: 'Transaction', id: result.transactionId },
      context,
      { after: { outcome: result.outcome, failureReason: result.failureReason ?? null } },
    );

    return result;
  }

  /**
   * Risk assessment. Returns null and proceeds if anything goes wrong.
   *
   * A risk engine that can take down payments is a worse problem than the fraud
   * it prevents, so every failure path here is fail-open.
   */
  private async assessRisk(
    command: SendMoneyCommand,
  ): Promise<Awaited<ReturnType<RiskEngineService['assess']>> | null> {
    try {
      const senderWallet = await this.wallets.findByUserId(command.senderUserId);
      if (!senderWallet) return null;

      const receiverUserId =
        command.receiverId ??
        (command.receiverPhone
          ? (await this.users.findByPhone(command.receiverPhone))?.id
          : undefined);

      if (!receiverUserId) return null; // the validator will reject this shortly

      return await this.risk.assess({
        senderUserId: command.senderUserId,
        receiverUserId,
        amountPoisha: command.amountPoisha,
        senderBalancePoisha: senderWallet.balancePoisha,
      });
    } catch (error) {
      this.logger.error(`Risk assessment skipped: ${(error as Error).message}`);
      return null;
    }
  }
}
