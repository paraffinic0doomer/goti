import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * DTOs for the safety and money-management endpoints.
 *
 * Shape only — never business rules. "Is this a positive integer?" lives here;
 * "does this wallet have enough spendable balance?" lives in the domain and is
 * ultimately enforced by the database.
 */

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]+$/;
const BD_PHONE = /^\+8801[3-9]\d{8}$/;

// ---------------------------------------------------------------------------
//  Wallet freeze
// ---------------------------------------------------------------------------

const QUESTION_KEYS = [
  'FIRST_SCHOOL', 'BEST_FRIEND_NAME', 'BIRTH_CITY',
  'MOTHERS_MAIDEN_NAME', 'FIRST_PET', 'CHILDHOOD_NICKNAME',
] as const;

export class SecurityAnswerDto {
  @IsEnum(QUESTION_KEYS, { message: 'questionKey must be one of the offered questions' })
  questionKey!: (typeof QUESTION_KEYS)[number];

  /**
   * Minimum 2 characters after trimming. Short answers are guessable, and the
   * service normalises before hashing so whitespace alone is not an answer.
   */
  @IsString()
  @MinLength(2, { message: 'answer must be at least 2 characters' })
  @MaxLength(120)
  answer!: string;
}

export class AnswerChallengeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  answer!: string;
}

export class FreezeWalletDto {
  /**
   * Why the user is freezing.
   *
   * REQUIRED, and shown back to them later. A freeze with no reason becomes a
   * wallet somebody finds locked weeks later with no idea why — and the support
   * call that follows has nothing to work with.
   */
  @IsString()
  @MinLength(3, { message: 'reason must say something useful' })
  @MaxLength(200)
  reason!: string;
}

export class UnfreezeWalletDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason!: string;
}

// ---------------------------------------------------------------------------
//  Expense envelopes
// ---------------------------------------------------------------------------

export class CreateEnvelopeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  icon?: string;

  /** Optional goal, in poisha. Progress display only — never enforced. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  targetAmount?: number;
}

export class AdjustEnvelopeDto {
  /**
   * Amount in POISHA to reserve or release. Always POSITIVE — the direction is
   * carried by the endpoint (`/reserve` vs `/unlock`), not by the sign.
   *
   * A signed amount here would let a client release money through the reserve
   * endpoint, which is the kind of ambiguity that turns into a bug report.
   */
  @Type(() => Number)
  @IsInt({ message: 'amount must be a whole number of poisha (1 BDT = 100 poisha)' })
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amount!: number;
}

// ---------------------------------------------------------------------------
//  Pots
// ---------------------------------------------------------------------------

export class CreatePotDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;

  /** What the group is collecting toward, in poisha. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  targetAmount!: number;
}

export class ContributeToPotDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amount!: number;

  /**
   * Required, exactly as on `/wallet/send-money`.
   *
   * A pot contribution IS a transfer through the same engine, so it carries the
   * same retry hazard and needs the same protection. Making it optional here
   * would leave one money path unguarded.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(IDEMPOTENCY_KEY)
  idempotencyKey!: string;
}

/** Joining a pot from a code someone shared. */
export class JoinPotByCodeDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MinLength(6)
  @MaxLength(12)
  @Matches(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]+$/, {
    message: 'invite code contains characters that are not used in Goti codes',
  })
  code!: string;
}

/** The creator adding someone by phone. Membership moves no money. */
export class AddPotMemberDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Matches(BD_PHONE, { message: 'phone must be in E.164 format, e.g. +8801712345678' })
  phone!: string;
}

export class SettlePotDto {
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(IDEMPOTENCY_KEY)
  idempotencyKey!: string;
}

export class ListPotsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize = 20;
}
