import { Inject, Injectable, Logger } from '@nestjs/common';

import { DomainError } from '../../domain/errors/domain-errors';
import { PASSWORD_HASHER, PasswordHasherPort } from '../ports/security.port';
import {
  SECURITY_QUESTION_REPOSITORY,
  SecurityChallengeRecord,
  SecurityQuestionKey,
  SecurityQuestionRepositoryPort,
} from '../ports/security-question.port';
import { CLOCK, ClockPort, ID_GENERATOR, IdGeneratorPort } from '../ports/repositories.port';

// ---------------------------------------------------------------------------
//  Policy — every value here is a security decision, so none is inline.
// ---------------------------------------------------------------------------

/** How many questions a user must set at registration. */
export const REQUIRED_ANSWER_COUNT = 3;

/**
 * A transfer of at least this SHARE of the balance triggers a challenge.
 *
 * Draining an account is the signature of a takeover: whoever has control moves
 * everything, once.
 */
const CHALLENGE_BALANCE_RATIO = 0.5;

/** …or this ABSOLUTE amount, so a large transfer from a large balance still asks. */
const CHALLENGE_ABSOLUTE_POISHA = 25_000_00n; // 25,000 BDT

/** A challenge is useless once stale, and a long window is a window to guess in. */
const CHALLENGE_TTL_MINUTES = 10;

/**
 * Wrong answers allowed on an UNFREEZE challenge before the wallet escalates to
 * UNDER_REVIEW.
 *
 * THIS IS THE MOST IMPORTANT NUMBER IN THE FILE. Security answers have a tiny
 * search space — "first school" in one city is a list of a few hundred. Without
 * a hard cap, an attacker who froze the wallet by failing a transfer challenge
 * could simply grind the unfreeze question until it opened. Three attempts, then
 * only support can release it.
 */
const MAX_UNFREEZE_ATTEMPTS = 3;

/** The prompts. Text lives in code so wording can change without a migration. */
export const SECURITY_QUESTION_PROMPTS: Readonly<Record<SecurityQuestionKey, string>> = {
  FIRST_SCHOOL: 'What was the name of your first school?',
  BEST_FRIEND_NAME: "What is your childhood best friend's name?",
  BIRTH_CITY: 'In which city were you born?',
  MOTHERS_MAIDEN_NAME: "What is your mother's maiden name?",
  FIRST_PET: 'What was the name of your first pet?',
  CHILDHOOD_NICKNAME: 'What was your childhood nickname?',
};

export const ALL_QUESTION_KEYS = Object.keys(
  SECURITY_QUESTION_PROMPTS,
) as SecurityQuestionKey[];

// ---------------------------------------------------------------------------
//  Errors
// ---------------------------------------------------------------------------

/**
 * A large transfer, or an unfreeze, needs the owner to answer a question.
 *
 * Carries the challenge so the client can present it immediately — a challenge
 * the user has to go hunting for is a challenge they abandon.
 */
export class SecurityChallengeRequiredError extends DomainError {
  readonly code = 'SECURITY_CHALLENGE_REQUIRED';
  readonly retryable = false;
  constructor(
    readonly challengeId: string,
    readonly questionKey: SecurityQuestionKey,
    readonly prompt: string,
    readonly expiresAt: Date,
  ) {
    super('Please answer your security question to continue.');
  }
}

export class InvalidSecurityAnswerError extends DomainError {
  readonly code = 'SECURITY_ANSWER_INCORRECT';
  readonly retryable = false;
  constructor(
    readonly walletFrozen: boolean,
    readonly attemptsRemaining: number | null,
  ) {
    super(
      walletFrozen
        ? 'That answer was incorrect. Your wallet has been frozen to protect it.'
        : 'That answer was incorrect.',
    );
  }
}

export class ChallengeNotFoundError extends DomainError {
  readonly code = 'SECURITY_CHALLENGE_NOT_FOUND';
  readonly retryable = false;
  constructor() {
    super('That security challenge has expired or was already used. Start again.');
  }
}

export class SecurityAnswersRequiredError extends DomainError {
  readonly code = 'SECURITY_ANSWERS_REQUIRED';
  readonly retryable = false;
  constructor() {
    super(`You must set ${REQUIRED_ANSWER_COUNT} different security questions.`);
  }
}

export class TooManyFailedAttemptsError extends DomainError {
  readonly code = 'SECURITY_LOCKED_CONTACT_SUPPORT';
  readonly retryable = false;
  constructor() {
    super(
      'Too many incorrect answers. Your wallet is now under review and can only be ' +
        'released by our support team.',
    );
  }
}

export interface AnswerSubmission {
  readonly questionKey: SecurityQuestionKey;
  readonly answer: string;
}

export interface ChallengeView {
  readonly challengeId: string;
  readonly questionKey: SecurityQuestionKey;
  readonly prompt: string;
  readonly expiresAt: Date;
}

/**
 * ============================================================================
 *  SECURITY QUESTIONS — the knowledge factor
 * ============================================================================
 *
 * THE THREAT THIS CLOSES
 *
 * A stolen password gives an attacker everything, INCLUDING the freeze button.
 * The victim cannot lock their own wallet, because the attacker has already
 * changed the password and locked them out. The one control designed to save
 * them is in the attacker's hands.
 *
 * Security questions break that, because they are a SEPARATE secret the
 * password does not unlock:
 *
 *   - A large transfer is challenged. An attacker with the password but not the
 *     answer cannot drain the account.
 *   - A WRONG answer freezes the wallet immediately. The attack itself triggers
 *     the defence — the attacker locks the account by trying.
 *   - Unfreezing requires the answer too, so they cannot undo it.
 *   - Three wrong unfreeze attempts escalate to UNDER_REVIEW, which only support
 *     can release. That cap is what stops the small answer space being ground
 *     through.
 *
 * WHY ANSWERS ARE HASHED
 * With argon2id, exactly like passwords. People reuse "mother's maiden name"
 * across every site they own; a plaintext column would turn one leak here into
 * a compromise of accounts that have nothing to do with Goti.
 *
 * WHY NORMALISED
 * Trimmed, lowercased, inner whitespace collapsed — so "Dhaka" and " dhaka "
 * match. Without it the feature fails honest users far more often than
 * attackers, and a security control users cannot pass is a control they route
 * around.
 */
@Injectable()
export class SecurityQuestionService {
  private readonly logger = new Logger(SecurityQuestionService.name);

  constructor(
    @Inject(SECURITY_QUESTION_REPOSITORY)
    private readonly repository: SecurityQuestionRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** The catalogue, for the registration form. */
  listQuestions(): { key: SecurityQuestionKey; prompt: string }[] {
    return ALL_QUESTION_KEYS.map((key) => ({ key, prompt: SECURITY_QUESTION_PROMPTS[key] }));
  }

  /**
   * Validates and hashes a registration's answers.
   *
   * Called BEFORE the user row is created, so an account can never exist
   * without its questions — the requirement is structural, not a later check
   * somebody can forget to run.
   */
  async prepareAnswers(
    submissions: readonly AnswerSubmission[],
  ): Promise<{ id: string; questionKey: SecurityQuestionKey; answerHash: string }[]> {
    const distinct = new Set(submissions.map((s) => s.questionKey));

    if (submissions.length !== REQUIRED_ANSWER_COUNT || distinct.size !== REQUIRED_ANSWER_COUNT) {
      throw new SecurityAnswersRequiredError();
    }
    if (submissions.some((s) => this.normalise(s.answer).length < 2)) {
      throw new SecurityAnswersRequiredError();
    }

    return Promise.all(
      submissions.map(async (submission) => ({
        id: this.ids.generate(),
        questionKey: submission.questionKey,
        answerHash: await this.hasher.hash(this.normalise(submission.answer)),
      })),
    );
  }

  /**
   * Whether this transfer needs the owner to prove themselves.
   *
   * Two triggers, either sufficient: a large SHARE of the balance (draining), or
   * a large ABSOLUTE amount (so a wealthy account is not exempt just because
   * 50,000 is a small fraction of what it holds).
   */
  requiresChallenge(amountPoisha: bigint, balancePoisha: bigint): boolean {
    if (amountPoisha >= CHALLENGE_ABSOLUTE_POISHA) return true;
    if (balancePoisha <= 0n) return false;

    // Basis points keeps this integer — no float ever touches a money value.
    const ratioBps = Number((amountPoisha * 10_000n) / balancePoisha);
    return ratioBps / 10_000 >= CHALLENGE_BALANCE_RATIO;
  }

  /**
   * Has this exact transfer already been authorised?
   *
   * Matches on BOTH the idempotency key and the amount. Matching on the key
   * alone would let an attacker answer a challenge for a small transfer and
   * then resubmit the same key with a larger amount.
   */
  async hasPassedTransferChallenge(
    userId: string,
    idempotencyKey: string,
    amountPoisha: bigint,
  ): Promise<boolean> {
    const passed = await this.repository.findPassedChallenge(
      userId,
      'TRANSFER',
      idempotencyKey,
    );
    return passed !== null && passed.boundAmountPoisha === amountPoisha;
  }

  async hasPassedUnfreezeChallenge(userId: string): Promise<boolean> {
    const passed = await this.repository.findPassedChallenge(userId, 'UNFREEZE', null);
    if (!passed) return false;
    // An unfreeze pass is single-use and short-lived, so it cannot be banked.
    return passed.createdAt.getTime() > this.clock.now().getTime() - CHALLENGE_TTL_MINUTES * 60_000;
  }

  /**
   * Raises a challenge, picking one of the user's questions AT RANDOM.
   *
   * Random rather than fixed: an attacker who learned one answer through social
   * engineering would otherwise pass every time. With three questions asked at
   * random they have a one-in-three chance per attempt — and a wrong answer
   * freezes the wallet, so there is no second attempt to average over.
   */
  async raiseChallenge(
    userId: string,
    purpose: 'TRANSFER' | 'UNFREEZE',
    binding: { idempotencyKey: string; amountPoisha: bigint } | null,
    meta: { ipAddress?: string | null; correlationId?: string | null },
  ): Promise<ChallengeView> {
    const keys = await this.repository.listAnsweredKeys(userId);
    if (keys.length === 0) throw new SecurityAnswersRequiredError();

    const questionKey = keys[Math.floor(Math.random() * keys.length)]!;
    const challengeId = this.ids.generate();
    const expiresAt = new Date(this.clock.now().getTime() + CHALLENGE_TTL_MINUTES * 60_000);

    await this.repository.createChallenge({
      id: challengeId,
      userId,
      questionKey,
      purpose,
      boundIdempotencyKey: binding?.idempotencyKey ?? null,
      boundAmountPoisha: binding?.amountPoisha ?? null,
      expiresAt,
      ipAddress: meta.ipAddress ?? null,
      correlationId: meta.correlationId ?? null,
    });

    return {
      challengeId,
      questionKey,
      prompt: SECURITY_QUESTION_PROMPTS[questionKey],
      expiresAt,
    };
  }

  /**
   * Verifies an answer.
   *
   * Returns the challenge on success. On failure the CALLER decides what to do —
   * freeze on a transfer challenge, count attempts on an unfreeze — because the
   * consequences differ and this service should not reach into wallet state.
   */
  async verifyAnswer(
    challengeId: string,
    userId: string,
    answer: string,
  ): Promise<
    | { outcome: 'PASSED'; challenge: SecurityChallengeRecord }
    | { outcome: 'WRONG'; challenge: SecurityChallengeRecord; attemptCount: number }
    | { outcome: 'GONE' }
  > {
    const challenge = await this.repository.findChallenge(challengeId);

    // A challenge belonging to someone else is reported as missing, not as
    // forbidden — otherwise challenge ids become probeable.
    if (!challenge || challenge.userId !== userId) return { outcome: 'GONE' };
    if (challenge.status !== 'PENDING') return { outcome: 'GONE' };

    if (challenge.expiresAt <= this.clock.now()) {
      await this.repository.resolveChallenge(challengeId, 'EXPIRED', this.clock.now());
      return { outcome: 'GONE' };
    }

    const stored = await this.repository.findAnswerHash(userId, challenge.questionKey);
    if (!stored) return { outcome: 'GONE' };

    const correct = await this.hasher.verify(stored, this.normalise(answer));

    if (correct) {
      await this.repository.resolveChallenge(challengeId, 'PASSED', this.clock.now());
      return { outcome: 'PASSED', challenge };
    }

    const attemptCount = await this.repository.incrementAttempts(challengeId);
    this.logger.warn(
      `Incorrect security answer for user ${userId} on a ${challenge.purpose} challenge ` +
        `(attempt ${attemptCount}).`,
    );

    return { outcome: 'WRONG', challenge, attemptCount };
  }

  /** Marks a challenge failed once the caller has applied its consequence. */
  async failChallenge(challengeId: string): Promise<void> {
    await this.repository.resolveChallenge(challengeId, 'FAILED', this.clock.now());
  }

  /** Consumes a passed challenge so it cannot authorise a second action. */
  async consumeChallenge(challengeId: string): Promise<void> {
    await this.repository.resolveChallenge(challengeId, 'FAILED', this.clock.now());
  }

  /** Failed unfreeze attempts in a window, counted ACROSS challenges. */
  async countFailedUnfreezeAttempts(userId: string, since: Date): Promise<number> {
    return this.repository.countRecentFailedUnfreezeAttempts(userId, since);
  }

  hasExhaustedUnfreezeAttempts(attemptCount: number): boolean {
    return attemptCount >= MAX_UNFREEZE_ATTEMPTS;
  }

  get maxUnfreezeAttempts(): number {
    return MAX_UNFREEZE_ATTEMPTS;
  }

  /**
   * Canonical form of an answer.
   *
   * Lowercase, trimmed, inner whitespace collapsed, and punctuation stripped —
   * "St. Joseph's" and "st josephs" are the same memory, and a user who cannot
   * reproduce their own punctuation a year later is locked out by the control
   * meant to protect them.
   */
  private normalise(answer: string): string {
    return answer
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ');
  }
}
