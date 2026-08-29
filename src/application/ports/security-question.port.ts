/**
 * Security question port — owned by the application layer.
 *
 * Answers and challenges live in PostgreSQL rather than Redis, deliberately.
 * Every other ephemeral thing in Goti is cached in Redis and fails OPEN when
 * Redis is down; that is correct for a cache and catastrophic for a security
 * control. A challenge that silently stops being raised during a Redis outage
 * is a bypass, and it would be invisible.
 */

export const SECURITY_QUESTION_REPOSITORY = Symbol('SECURITY_QUESTION_REPOSITORY');

export type SecurityQuestionKey =
  | 'FIRST_SCHOOL'
  | 'BEST_FRIEND_NAME'
  | 'BIRTH_CITY'
  | 'MOTHERS_MAIDEN_NAME'
  | 'FIRST_PET'
  | 'CHILDHOOD_NICKNAME';

export type SecurityChallengePurpose = 'TRANSFER' | 'UNFREEZE';
export type SecurityChallengeStatus = 'PENDING' | 'PASSED' | 'FAILED' | 'EXPIRED';

export interface SecurityChallengeRecord {
  readonly id: string;
  readonly userId: string;
  readonly questionKey: SecurityQuestionKey;
  readonly purpose: SecurityChallengePurpose;
  readonly status: SecurityChallengeStatus;
  readonly boundIdempotencyKey: string | null;
  readonly boundAmountPoisha: bigint | null;
  readonly attemptCount: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface CreateChallengeInput {
  readonly id: string;
  readonly userId: string;
  readonly questionKey: SecurityQuestionKey;
  readonly purpose: SecurityChallengePurpose;
  readonly boundIdempotencyKey: string | null;
  readonly boundAmountPoisha: bigint | null;
  readonly expiresAt: Date;
  readonly ipAddress?: string | null;
  readonly correlationId?: string | null;
}

export interface SecurityQuestionRepositoryPort {
  /**
   * Which questions this user has answered.
   *
   * Returns KEYS only — never hashes. A challenge picks one at random from
   * these, so the caller needs the set but never the secrets.
   */
  listAnsweredKeys(userId: string): Promise<readonly SecurityQuestionKey[]>;

  /** The stored hash for one question. The only place a hash leaves the database. */
  findAnswerHash(userId: string, questionKey: SecurityQuestionKey): Promise<string | null>;

  createChallenge(input: CreateChallengeInput): Promise<void>;
  findChallenge(challengeId: string): Promise<SecurityChallengeRecord | null>;

  /**
   * A PASSED, unexpired challenge for this action.
   *
   * `boundIdempotencyKey` is part of the lookup for transfers so a pass cannot
   * be redeemed against a different transfer than the one it was raised for.
   */
  findPassedChallenge(
    userId: string,
    purpose: SecurityChallengePurpose,
    boundIdempotencyKey: string | null,
  ): Promise<SecurityChallengeRecord | null>;

  /** Conditional on PENDING, so two answers cannot both resolve one challenge. */
  resolveChallenge(
    challengeId: string,
    status: Exclude<SecurityChallengeStatus, 'PENDING'>,
    resolvedAt: Date,
  ): Promise<boolean>;

  incrementAttempts(challengeId: string): Promise<number>;

  /** Consecutive failed UNFREEZE attempts — the brute-force counter. */
  countRecentFailedUnfreezeAttempts(userId: string, since: Date): Promise<number>;
}
