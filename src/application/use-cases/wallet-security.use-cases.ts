import { Inject, Injectable, Logger } from '@nestjs/common';

import { DomainError, WalletNotFoundError } from '../../domain/errors/domain-errors';
import {
  CACHE_PORT,
  CachePort,
} from '../ports';
import {
  WALLET_SECURITY_REPOSITORY,
  WalletSecurityEventRecord,
  WalletSecurityRepositoryPort,
} from '../ports/safety.port';
import {
  WALLET_REPOSITORY,
  WalletRepositoryPort,
  WalletStatus,
} from '../ports/repositories.port';
import { AuditAction, AuditContext, AuditService } from '../services/audit.service';
import {
  SecurityChallengeRequiredError,
  SecurityQuestionService,
} from '../services/security-question.service';

export class WalletAlreadyFrozenError extends DomainError {
  readonly code = 'WALLET_ALREADY_FROZEN';
  readonly retryable = false;
  constructor() {
    super('This wallet is already frozen.');
  }
}

export class WalletNotFrozenError extends DomainError {
  readonly code = 'WALLET_NOT_FROZEN';
  readonly retryable = false;
  constructor(readonly status: string) {
    super(`This wallet is ${status.toLowerCase()}, so there is nothing to unfreeze.`);
  }
}

/**
 * A wallet held by the platform cannot be released by its owner.
 *
 * The distinction matters: a user freezing their own wallet is a safety tool
 * they must be able to undo instantly. A wallet the RISK ENGINE froze is an
 * open investigation, and letting the suspected party clear it would make the
 * control worthless.
 */
export class ReviewHoldError extends DomainError {
  readonly code = 'WALLET_UNDER_REVIEW';
  readonly retryable = false;
  constructor() {
    super(
      'This wallet is under review by our team and cannot be unfrozen from the app. ' +
        'Contact support.',
    );
  }
}

export interface FreezeWalletCommand {
  readonly userId: string;
  readonly reason: string;
}

export interface WalletSecurityView {
  readonly walletId: string;
  readonly status: WalletStatus;
  readonly freezeReason: string | null;
  readonly canSend: boolean;
  readonly canReceive: boolean;
  readonly canSelfUnfreeze: boolean;
  readonly history: readonly WalletSecurityEventRecord[];
}

/**
 * ============================================================================
 *  EMERGENCY WALLET FREEZE
 * ============================================================================
 *
 * WHY THE CHECK BELONGS BEFORE TRANSACTION PROCESSING — AND ALSO INSIDE IT
 *
 * Freezing is not a UI state. It is a precondition on money movement, and the
 * only place a precondition on money is trustworthy is where the money moves.
 *
 * So the status is enforced at THREE depths, and the deepest one is the one
 * that counts:
 *
 *   1. Pre-flight (validator)  — fails fast with a clear message, no lock taken.
 *   2. Under the row lock      — `assertStillValidUnderLock` re-reads status
 *                                after the lock, catching a freeze that landed
 *                                between validation and the lock.
 *   3. Inside the atomic debit — `WHERE status = 'ACTIVE'` is part of the same
 *                                UPDATE that moves the balance.
 *
 * Layer 3 is why this design actually works. A freeze issued at the exact
 * moment a transfer is mid-flight still wins, because the debit and the status
 * check are ONE statement evaluated by PostgreSQL against the newest committed
 * row. There is no window — not a microsecond — where a frozen wallet can pay
 * out.
 *
 * A freeze that only ran in a controller or a middleware would have exactly
 * that window, and it is the window an attacker with stolen credentials races
 * for: they submit while the owner taps freeze.
 *
 * INCOMING money is deliberately still allowed. A frozen wallet is a wallet
 * that must not LEAK; refusing a salary payment because someone lost their
 * phone punishes the victim. Receiving is safe because the attacker cannot get
 * it out.
 */
@Injectable()
export class WalletSecurityUseCases {
  private readonly logger = new Logger(WalletSecurityUseCases.name);

  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort,
    @Inject(WALLET_SECURITY_REPOSITORY)
    private readonly security: WalletSecurityRepositoryPort,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    private readonly audit: AuditService,
    private readonly securityQuestions: SecurityQuestionService,
  ) {}

  /**
   * Freezes the caller's own wallet. Immediate, and never rate limited.
   *
   * NO RATE LIMIT ON THIS PATH, deliberately. Every other money endpoint is
   * throttled, but throttling an emergency stop means the one moment a user
   * most needs it is the moment it refuses. A user spamming their own freeze
   * button costs one UPDATE; a user who cannot freeze during an active
   * compromise loses their balance.
   */
  async freeze(command: FreezeWalletCommand, context: AuditContext): Promise<WalletSecurityView> {
    const wallet = await this.requireWallet(command.userId);

    if (wallet.status === 'FROZEN') throw new WalletAlreadyFrozenError();
    if (wallet.status === 'UNDER_REVIEW') throw new ReviewHoldError();

    // Compare-and-set: only from ACTIVE. Two taps race, one wins, and the event
    // log records exactly one freeze rather than two.
    const applied = await this.security.transitionStatus(
      {
        walletId: wallet.id,
        action: 'FROZEN',
        previousStatus: wallet.status,
        newStatus: 'FROZEN',
        reason: command.reason,
        actorUserId: command.userId,
        actorType: 'USER',
        ipAddress: context.ipAddress ?? null,
        correlationId: context.correlationId ?? null,
      },
      ['ACTIVE'],
    );

    if (!applied) throw new WalletAlreadyFrozenError();

    // The cached balance is display-only and never authorises a debit, but a
    // frozen wallet should stop showing a spendable figure immediately.
    await this.invalidate(wallet.id);

    await this.audit.record(
      AuditAction.WALLET_FROZEN,
      { type: 'Wallet', id: wallet.id },
      context,
      { before: { status: wallet.status }, after: { status: 'FROZEN', reason: command.reason } },
    );

    this.logger.warn(`Wallet ${wallet.id} FROZEN by owner: ${command.reason}`);
    return this.getSecurityState(command.userId);
  }

  /**
   * Returns a self-frozen wallet to ACTIVE.
   *
   * Refuses when the platform placed the hold — see `ReviewHoldError`.
   */
  async unfreeze(
    command: FreezeWalletCommand,
    context: AuditContext,
  ): Promise<WalletSecurityView> {
    const wallet = await this.requireWallet(command.userId);

    if (wallet.status === 'UNDER_REVIEW') throw new ReviewHoldError();
    if (wallet.status !== 'FROZEN') throw new WalletNotFrozenError(wallet.status);

    // THE ATTACKER'S LAST DOOR.
    //
    // Freezing is deliberately frictionless — a panicking user must not be
    // slowed down. UNFREEZING is the opposite: whoever releases the wallet has
    // to prove they are the owner, or a thief who triggered the freeze could
    // simply undo it with the password they already stole.
    if (!(await this.securityQuestions.hasPassedUnfreezeChallenge(command.userId))) {
      const challenge = await this.securityQuestions.raiseChallenge(
        command.userId,
        'UNFREEZE',
        null,
        { ipAddress: context.ipAddress, correlationId: context.correlationId },
      );
      throw new SecurityChallengeRequiredError(
        challenge.challengeId,
        challenge.questionKey,
        challenge.prompt,
        challenge.expiresAt,
      );
    }

    const applied = await this.security.transitionStatus(
      {
        walletId: wallet.id,
        action: 'UNFROZEN',
        previousStatus: 'FROZEN',
        newStatus: 'ACTIVE',
        reason: command.reason,
        actorUserId: command.userId,
        actorType: 'USER',
        ipAddress: context.ipAddress ?? null,
        correlationId: context.correlationId ?? null,
      },
      ['FROZEN'],
    );

    if (!applied) throw new WalletNotFrozenError(wallet.status);

    await this.invalidate(wallet.id);
    await this.audit.record(
      AuditAction.WALLET_UNFROZEN,
      { type: 'Wallet', id: wallet.id },
      context,
      { before: { status: 'FROZEN' }, after: { status: 'ACTIVE', reason: command.reason } },
    );

    this.logger.log(`Wallet ${wallet.id} unfrozen by owner.`);
    return this.getSecurityState(command.userId);
  }

  /**
   * Freezes on the platform's behalf, after a failed proof of ownership.
   *
   * Separate from `freeze` because the ACTOR differs: this was not the owner's
   * choice, and the audit trail must not attribute it to the person whose
   * account may already be compromised.
   */
  async freezeAsSystem(
    userId: string,
    reason: string,
    correlationId: string | null,
  ): Promise<boolean> {
    const wallet = await this.requireWallet(userId);
    if (wallet.status !== 'ACTIVE') return false;

    const applied = await this.security.transitionStatus(
      {
        walletId: wallet.id,
        action: 'FROZEN',
        previousStatus: 'ACTIVE',
        newStatus: 'FROZEN',
        reason,
        actorUserId: null,
        actorType: 'SYSTEM',
        correlationId,
      },
      ['ACTIVE'],
    );

    if (applied) {
      await this.invalidate(wallet.id);
      this.logger.error(`Wallet ${wallet.id} AUTO-FROZEN: ${reason}`);
    }
    return applied;
  }

  /**
   * Places a wallet under review. SYSTEM-initiated, from the risk engine.
   *
   * Not exposed as a user endpoint: this is the platform acting, and the
   * subject of an investigation must not be able to trigger or clear it.
   */
  async markUnderReview(
    walletId: string,
    reason: string,
    correlationId: string | null,
  ): Promise<boolean> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) return false;

    const applied = await this.security.transitionStatus(
      {
        walletId,
        action: 'MARKED_UNDER_REVIEW',
        previousStatus: wallet.status,
        newStatus: 'UNDER_REVIEW',
        reason,
        actorUserId: null,
        actorType: 'SYSTEM',
        correlationId,
      },
      ['ACTIVE', 'FROZEN'],
    );

    if (applied) {
      await this.invalidate(walletId);
      this.logger.error(`Wallet ${walletId} placed UNDER_REVIEW by risk policy: ${reason}`);
    }
    return applied;
  }

  async getSecurityState(userId: string): Promise<WalletSecurityView> {
    const wallet = await this.requireWallet(userId);
    const history = await this.security.findEvents(wallet.id, 20);

    return {
      walletId: wallet.id,
      status: wallet.status,
      freezeReason: wallet.freezeReason ?? null,
      // Outgoing money requires ACTIVE. Anything else blocks it.
      canSend: wallet.status === 'ACTIVE',
      // Incoming is allowed while frozen — a freeze stops leaks, not salaries.
      canReceive: wallet.status === 'ACTIVE' || wallet.status === 'FROZEN',
      canSelfUnfreeze: wallet.status === 'FROZEN',
      history,
    };
  }

  private async requireWallet(userId: string) {
    const wallet = await this.wallets.findByUserId(userId);
    if (!wallet) throw new WalletNotFoundError(userId);
    return wallet;
  }

  private async invalidate(walletId: string): Promise<void> {
    await this.cache.invalidate(
      `cache:wallet:${walletId}:balance`,
      `cache:wallet:${walletId}:recent_transactions`,
    );
  }
}
