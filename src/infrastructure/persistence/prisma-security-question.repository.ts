import { Injectable } from '@nestjs/common';

import {
  CreateChallengeInput,
  SecurityChallengePurpose,
  SecurityChallengeRecord,
  SecurityChallengeStatus,
  SecurityQuestionKey,
  SecurityQuestionRepositoryPort,
} from '../../application/ports/security-question.port';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrismaSecurityQuestionRepository implements SecurityQuestionRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /** Keys only. Hashes never leave this class except through `findAnswerHash`. */
  async listAnsweredKeys(userId: string): Promise<readonly SecurityQuestionKey[]> {
    const rows = await this.prisma.securityAnswer.findMany({
      where: { userId },
      select: { questionKey: true },
    });
    return rows.map((row) => row.questionKey);
  }

  async findAnswerHash(
    userId: string,
    questionKey: SecurityQuestionKey,
  ): Promise<string | null> {
    const row = await this.prisma.securityAnswer.findUnique({
      where: { userId_questionKey: { userId, questionKey } },
      select: { answerHash: true },
    });
    return row?.answerHash ?? null;
  }

  async createChallenge(input: CreateChallengeInput): Promise<void> {
    await this.prisma.securityChallenge.create({
      data: {
        id: input.id,
        userId: input.userId,
        questionKey: input.questionKey,
        purpose: input.purpose,
        status: 'PENDING',
        boundIdempotencyKey: input.boundIdempotencyKey,
        boundAmountPoisha: input.boundAmountPoisha,
        expiresAt: input.expiresAt,
        ipAddress: input.ipAddress ?? null,
        correlationId: input.correlationId ?? null,
      },
    });
  }

  async findChallenge(challengeId: string): Promise<SecurityChallengeRecord | null> {
    const row = await this.prisma.securityChallenge.findUnique({ where: { id: challengeId } });
    return row ? this.toRecord(row) : null;
  }

  /**
   * The redemption lookup.
   *
   * For a TRANSFER the bound idempotency key is part of the WHERE, so a pass
   * raised for one transfer cannot authorise another. The amount is compared by
   * the caller, which also has the value to compare against.
   */
  async findPassedChallenge(
    userId: string,
    purpose: SecurityChallengePurpose,
    boundIdempotencyKey: string | null,
  ): Promise<SecurityChallengeRecord | null> {
    const row = await this.prisma.securityChallenge.findFirst({
      where: {
        userId,
        purpose,
        status: 'PASSED',
        ...(boundIdempotencyKey ? { boundIdempotencyKey } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.toRecord(row) : null;
  }

  /**
   * Conditional on PENDING — the same compare-and-set shape as the balance
   * debit. Two answers submitted at once race for one row and exactly one wins,
   * so a challenge cannot be both passed and failed.
   */
  async resolveChallenge(
    challengeId: string,
    status: Exclude<SecurityChallengeStatus, 'PENDING'>,
    resolvedAt: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.securityChallenge.updateMany({
      where: { id: challengeId, status: 'PENDING' },
      data: { status, resolvedAt },
    });
    return count === 1;
  }

  async incrementAttempts(challengeId: string): Promise<number> {
    const updated = await this.prisma.securityChallenge.update({
      where: { id: challengeId },
      data: { attemptCount: { increment: 1 } },
      select: { attemptCount: true },
    });
    return updated.attemptCount;
  }

  /**
   * Failed unfreeze attempts in a window — the brute-force counter.
   *
   * Counts across CHALLENGES, not within one, because an attacker would simply
   * abandon a challenge after a wrong guess and raise a fresh one. Per-challenge
   * attempt counting alone would be trivially bypassed.
   */
  async countRecentFailedUnfreezeAttempts(userId: string, since: Date): Promise<number> {
    return this.prisma.securityChallenge.count({
      where: {
        userId,
        purpose: 'UNFREEZE',
        status: { in: ['FAILED', 'EXPIRED'] },
        createdAt: { gte: since },
      },
    });
  }

  private toRecord(row: {
    id: string;
    userId: string;
    questionKey: SecurityQuestionKey;
    purpose: SecurityChallengePurpose;
    status: SecurityChallengeStatus;
    boundIdempotencyKey: string | null;
    boundAmountPoisha: bigint | null;
    attemptCount: number;
    expiresAt: Date;
    createdAt: Date;
  }): SecurityChallengeRecord {
    return {
      id: row.id,
      userId: row.userId,
      questionKey: row.questionKey,
      purpose: row.purpose,
      status: row.status,
      boundIdempotencyKey: row.boundIdempotencyKey,
      boundAmountPoisha: row.boundAmountPoisha,
      attemptCount: row.attemptCount,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }
}
