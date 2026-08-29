import { Transform, Type } from 'class-transformer';
import { SecurityAnswerDto } from './safety.dto';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsEmail,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidateNested,
} from 'class-validator';

/**
 * Request DTOs — the HTTP boundary's shape validation.
 *
 * These validate SHAPE, never business rules. "Is this a well-formed positive
 * integer?" belongs here; "does this user have enough money?" belongs in the
 * domain. Mixing the two is how business rules end up duplicated in every
 * controller and drift apart (ARCHITECTURE.md §4).
 *
 * `forbidNonWhitelisted` is enabled globally, so any property not declared here
 * causes a 400 rather than being silently dropped. On a money endpoint, a
 * silently ignored field is a request the client believes it made and the
 * server never saw.
 */

/** Bangladeshi E.164: +8801XXXXXXXXX. */
const BD_PHONE = /^\+8801[3-9]\d{8}$/;

@ValidatorConstraint({ name: 'exactlyOneIdentifier', async: false })
class ExactlyOneIdentifierConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, arguments_: ValidationArguments): boolean {
    const object = arguments_.object as Record<string, unknown>;
    const fields = arguments_.constraints as string[];
    return fields.filter((field) => object[field] !== undefined).length === 1;
  }

  defaultMessage(arguments_: ValidationArguments): string {
    return `exactly one of ${(arguments_.constraints as string[]).join(' or ')} is required`;
  }
}

export class RegisterRequestDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Matches(BD_PHONE, {
    message: 'phone must be a Bangladeshi mobile number in E.164 format, e.g. +8801712345678',
  })
  phone!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  displayName!: string;

  /**
   * Length is the only rule enforced.
   *
   * Composition requirements (a digit, a symbol, mixed case) push users toward
   * predictable patterns like `Password1!` and are no longer recommended by
   * NIST. Length is what actually resists guessing.
   */
  @IsString()
  @MinLength(10, { message: 'password must be at least 10 characters' })
  @MaxLength(256)
  password!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email?: string;

  /**
   * Exactly three DIFFERENT security questions. REQUIRED.
   *
   * There is no registration path without them. A stolen password otherwise
   * gives an attacker the freeze button too — the one control meant to save the
   * victim would be in the thief's hands.
   */
  @IsArray()
  @ArrayMinSize(3, { message: 'choose 3 security questions' })
  @ArrayMaxSize(3, { message: 'choose exactly 3 security questions' })
  @ValidateNested({ each: true })
  @Type(() => SecurityAnswerDto)
  securityAnswers!: SecurityAnswerDto[];
}

export class LoginRequestDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Matches(BD_PHONE, { message: 'phone must be in E.164 format' })
  phone!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;
}

export class SendMoneyRequestDto {
  /** Exactly one of receiverId / receiverPhone. */
  @ValidateIf((dto: SendMoneyRequestDto) => !dto.receiverPhone)
  @IsString()
  @IsUUID(undefined, { message: 'receiverId must be a UUID' })
  receiverId?: string;

  @ValidateIf((dto: SendMoneyRequestDto) => !dto.receiverId)
  @Matches(BD_PHONE, { message: 'receiverPhone must be in E.164 format' })
  receiverPhone?: string;

  @Validate(ExactlyOneIdentifierConstraint, ['receiverId', 'receiverPhone'])
  private readonly receiverIdentifierCheck?: never;

  /**
   * Amount in POISHA, as an integer. 1 BDT = 100 poisha.
   *
   * Poisha rather than taka on the wire, deliberately: a JSON number for taka
   * invites `12.34`, and floating point cannot represent that exactly. An
   * integer count of the smallest unit has no such ambiguity, and the field
   * name says which unit it is so a client cannot guess wrong.
   */
  @Type(() => Number)
  @IsInt({ message: 'amount must be a whole number of poisha (1 BDT = 100 poisha)' })
  @Min(1, { message: 'amount must be at least 1' })
  @Max(Number.MAX_SAFE_INTEGER)
  amount!: number;

  /**
   * Client-generated, and REQUIRED.
   *
   * Not optional: a transfer without one cannot be safely retried, and a client
   * that omits it will eventually double-charge a user on a flaky network. The
   * server refuses to accept that risk on the client's behalf.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'idempotencyKey must be URL-safe (letters, digits, underscore, hyphen)',
  })
  idempotencyKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  note?: string;
}

export class CreateMoneyRequestDto {
  @ValidateIf((dto: CreateMoneyRequestDto) => !dto.payerPhone)
  @IsString()
  @IsUUID(undefined, { message: 'payerId must be a UUID' })
  payerId?: string;

  @ValidateIf((dto: CreateMoneyRequestDto) => !dto.payerId)
  @Matches(BD_PHONE, { message: 'payerPhone must be in E.164 format' })
  payerPhone?: string;

  @Validate(ExactlyOneIdentifierConstraint, ['payerId', 'payerPhone'])
  private readonly payerIdentifierCheck?: never;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amount!: number;

  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  idempotencyKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  note?: string;
}

export class RespondToMoneyRequestDto {
  @IsEnum(['ACCEPT', 'DECLINE'], { message: 'decision must be ACCEPT or DECLINE' })
  decision!: 'ACCEPT' | 'DECLINE';

  /** Required on ACCEPT — it becomes the settlement transfer's idempotency key. */
  @ValidateIf((dto: RespondToMoneyRequestDto) => dto.decision === 'ACCEPT')
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  idempotencyKey?: string;
}

export class AcceptMoneyRequestDto {
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  idempotencyKey!: string;
}

/** An explicit empty DTO makes reject endpoints reject accidental payload fields. */
export class RejectMoneyRequestDto {}

/**
 * Pagination and filtering for transaction history.
 *
 * `pageSize` is capped at 100 here AND clamped again in the use case. The DTO
 * protects the HTTP boundary; the clamp protects every other caller, because a
 * DTO can be bypassed and a use case cannot.
 */
export class ListTransactionsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100, { message: 'pageSize cannot exceed 100' })
  pageSize = 20;

  @IsOptional()
  @IsEnum(['SENT', 'RECEIVED'])
  direction?: 'SENT' | 'RECEIVED';

  @IsOptional()
  @IsEnum(['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'])
  status?: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';

  @IsOptional()
  @IsISO8601({}, { message: 'fromDate must be an ISO 8601 date' })
  fromDate?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'toDate must be an ISO 8601 date' })
  toDate?: string;

  @IsOptional()
  @IsEnum(['newest', 'oldest', 'largest', 'smallest'])
  sort: 'newest' | 'oldest' | 'largest' | 'smallest' = 'newest';
}

export class ListMoneyRequestsQueryDto {
  @IsOptional()
  @IsEnum(['payer', 'requester'])
  @Transform(({ value }: { value: unknown }) => value ?? 'payer')
  role: 'payer' | 'requester' = 'payer';

  @IsOptional()
  @IsEnum(['REQUESTED', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'])
  status?: 'REQUESTED' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}
