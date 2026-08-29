import { Injectable, Logger } from '@nestjs/common';

import { AuditAction, AuditContext, AuditService } from '../services/audit.service';
import {
  ChallengeNotFoundError,
  InvalidSecurityAnswerError,
  SecurityQuestionService,
  TooManyFailedAttemptsError,
} from '../services/security-question.service';
import { WalletSecurityUseCases } from './wallet-security.use-cases';

/** Window over which failed unfreeze attempts accumulate toward lockout. */
const ATTEMPT_WINDOW_HOURS = 24;

export interface AnswerChallengeResult {
  readonly outcome: 'PASSED' | 'FAILED';
  readonly purpose: 'TRANSFER' | 'UNFREEZE';
  /** True when the wrong answer froze the wallet. */
  readonly walletFrozen: boolean;
  /** True when repeated failures escalated to UNDER_REVIEW. */
  readonly lockedOut: boolean;
  readonly message: string;
}

/**
 * ============================================================================
 *  ANSWERING A SECURITY CHALLENGE
 * ============================================================================
 *
 * THE CONSEQUENCE OF A WRONG ANSWER IS THE POINT OF THE FEATURE.
 *
 * On a TRANSFER challenge, one wrong answer FREEZES THE WALLET immediately. An
 * attacker holding a stolen password does not get a second guess, and the act of
 * guessing is what locks them out — the attack triggers the defence.
 *
 * That asymmetry is deliberate and it does cost honest users: someone who
 * genuinely misremembers their own answer freezes their own wallet. That is the
 * right trade. A frozen wallet is an inconvenience recoverable in minutes; a
 * drained one is not recoverable at all.
 *
 * On an UNFREEZE challenge, wrong answers are COUNTED rather than instantly
 * escalating, because the wallet is already frozen and nothing can leave it.
 * After three failures within a day the wallet moves to UNDER_REVIEW, which only
 * support can release. That cap is the anti-brute-force control: security
 * answers have a small search space, and without it an attacker could grind the
 * question until the wallet opened.
 */
@Injectable()
export class AnswerSecurityChallengeUseCase {
  private readonly logger = new Logger(AnswerSecurityChallengeUseCase.name);

  constructor(
    private readonly securityQuestions: SecurityQuestionService,
    private readonly walletSecurity: WalletSecurityUseCases,
    private readonly audit: AuditService,
  ) {}

  async execute(
    challengeId: string,
    userId: string,
    answer: string,
    context: AuditContext,
  ): Promise<AnswerChallengeResult> {
    const verdict = await this.securityQuestions.verifyAnswer(challengeId, userId, answer);

    if (verdict.outcome === 'GONE') throw new ChallengeNotFoundError();

    // ---------- correct ----------
    if (verdict.outcome === 'PASSED') {
      await this.audit.record(
        AuditAction.SECURITY_CHALLENGE_PASSED,
        { type: 'SecurityChallenge', id: challengeId },
        context,
        { after: { purpose: verdict.challenge.purpose } },
      );

      return {
        outcome: 'PASSED',
        purpose: verdict.challenge.purpose,
        walletFrozen: false,
        lockedOut: false,
        message:
          verdict.challenge.purpose === 'TRANSFER'
            ? 'Verified. Submit your transfer again to complete it.'
            : 'Verified. You can now unfreeze your wallet.',
      };
    }

    // ---------- wrong ----------
    await this.securityQuestions.failChallenge(challengeId);
    await this.audit.record(
      AuditAction.SECURITY_CHALLENGE_FAILED,
      { type: 'SecurityChallenge', id: challengeId },
      context,
      { after: { purpose: verdict.challenge.purpose, attempt: verdict.attemptCount } },
    );

    if (verdict.challenge.purpose === 'TRANSFER') {
      // ONE wrong answer on a transfer freezes the wallet. No second chance —
      // the whole point is that an attacker cannot keep guessing.
      const frozen = await this.freezeAfterWrongAnswer(userId, context);

      this.logger.error(
        `Wrong security answer on a TRANSFER challenge for user ${userId}. ` +
          `Wallet ${frozen ? 'FROZEN' : 'already not active'}.`,
      );

      throw new InvalidSecurityAnswerError(frozen, 0);
    }

    // UNFREEZE: count failures across challenges, because abandoning one and
    // raising another would otherwise reset a per-challenge counter.
    const since = new Date(Date.now() - ATTEMPT_WINDOW_HOURS * 60 * 60 * 1000);
    const failures = await this.countUnfreezeFailures(userId, since);

    if (this.securityQuestions.hasExhaustedUnfreezeAttempts(failures)) {
      await this.walletSecurity.markUnderReview(
        await this.resolveWalletId(userId),
        `Locked after ${failures} incorrect security answers`,
        context.correlationId ?? null,
      );
      await this.audit.record(
        AuditAction.SECURITY_LOCKED_OUT,
        { type: 'User', id: userId },
        context,
        { after: { failedAttempts: failures } },
      );
      throw new TooManyFailedAttemptsError();
    }

    throw new InvalidSecurityAnswerError(
      false,
      this.securityQuestions.maxUnfreezeAttempts - failures,
    );
  }

  /**
   * Freezes the wallet as SYSTEM, not as the user.
   *
   * The actor matters: this freeze was triggered by the platform detecting a
   * failed proof of ownership, and the audit trail must not attribute it to the
   * person whose account is possibly compromised.
   */
  private async freezeAfterWrongAnswer(
    userId: string,
    context: AuditContext,
  ): Promise<boolean> {
    try {
      const state = await this.walletSecurity.getSecurityState(userId);
      if (state.status !== 'ACTIVE') return false;

      const frozen = await this.walletSecurity.freezeAsSystem(
        userId,
        'Incorrect security answer on a large transfer',
        context.correlationId ?? null,
      );

      if (frozen) {
        await this.audit.record(
          AuditAction.SECURITY_AUTO_FROZEN,
          { type: 'User', id: userId },
          { ...context, actorUserId: null },
        );
      }
      return frozen;
    } catch (error) {
      this.logger.error(`Auto-freeze failed for user ${userId}: ${(error as Error).message}`);
      return false;
    }
  }

  private async countUnfreezeFailures(userId: string, since: Date): Promise<number> {
    return this.securityQuestions.countFailedUnfreezeAttempts(userId, since);
  }

  private async resolveWalletId(userId: string): Promise<string> {
    return (await this.walletSecurity.getSecurityState(userId)).walletId;
  }
}
