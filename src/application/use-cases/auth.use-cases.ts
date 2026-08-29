import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { DomainError } from '../../domain/errors/domain-errors';
import { Money } from '../../domain/money/money';
import {
  PASSWORD_HASHER,
  PasswordHasherPort,
  TOKEN_ISSUER,
  TokenIssuerPort,
} from '../ports/security.port';
import { USER_WRITE_REPOSITORY, UserWriteRepositoryPort } from '../ports/query.port';
import {
  ID_GENERATOR,
  IdGeneratorPort,
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../ports/repositories.port';
import { AuditAction, AuditContext, AuditService } from '../services/audit.service';
import {
  AnswerSubmission,
  SecurityQuestionService,
} from '../services/security-question.service';
import { RATE_LIMITER_PORT, RateLimitAction, RateLimiterPort } from '../ports/rate-limiter.port';
import { RateLimitExceededError } from '../errors/application-errors';

/** ARCHITECTURE.md: every new user starts with 100,000 BDT of fake money. */
const OPENING_BALANCE = Money.fromTaka(100_000);

/**
 * The genesis wallet. Every taka in Goti is ISSUED from here.
 *
 * Its balance is the negative of all money in circulation, which is what keeps
 * the system-wide ledger sum at exactly zero. Matches the fixed id the seed
 * creates (DATABASE.md §8).
 */
const GENESIS_WALLET_ID = '00000000-0000-7000-8000-000000000001';

// ---------------------------------------------------------------------------
//  Errors
// ---------------------------------------------------------------------------

export class PhoneAlreadyRegisteredError extends DomainError {
  readonly code = 'PHONE_ALREADY_REGISTERED';
  readonly retryable = false;
  constructor() {
    super('An account already exists for this phone number.');
  }
}

/**
 * ONE error for every authentication failure.
 *
 * Deliberately does not distinguish "no such user" from "wrong password". See
 * `LoginUserUseCase` for why.
 */
export class InvalidCredentialsError extends DomainError {
  readonly code = 'INVALID_CREDENTIALS';
  readonly retryable = false;
  constructor() {
    super('Invalid phone number or password.');
  }
}

export class AccountNotActiveError extends DomainError {
  readonly code = 'ACCOUNT_NOT_ACTIVE';
  readonly retryable = false;
  constructor() {
    super('This account is not active. Contact support.');
  }
}

export interface RegisterCommand {
  readonly phone: string;
  readonly displayName: string;
  readonly password: string;
  readonly email?: string;
  /**
   * Three security answers. REQUIRED — there is no registration path without
   * them, because the freeze control they protect is worthless if an attacker
   * with the password can also use it.
   */
  readonly securityAnswers: readonly AnswerSubmission[];
}

export interface LoginCommand {
  readonly phone: string;
  readonly password: string;
}

export interface AuthResult {
  readonly userId: string;
  readonly phone: string;
  readonly displayName: string;
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresInSeconds: number;
}

/**
 * Registration.
 *
 * The wallet and its opening balance are created in the SAME database
 * transaction as the user (see `UserWriteRepositoryPort.createWithWallet`). A
 * user without a wallet is unusable, and a wallet created by a second request
 * that might fail is a support ticket waiting to happen.
 */
@Injectable()
export class RegisterUserUseCase {
  private readonly logger = new Logger(RegisterUserUseCase.name);

  constructor(
    @Inject(USER_WRITE_REPOSITORY) private readonly users: UserWriteRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuerPort,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
    private readonly audit: AuditService,
    private readonly securityQuestions: SecurityQuestionService,
    @Inject(RATE_LIMITER_PORT) private readonly rateLimiter: RateLimiterPort,
  ) {}

  async execute(command: RegisterCommand, context: AuditContext): Promise<AuthResult> {
    await this.enforceAuthRateLimit(command.phone, context);
    // A pre-check for a good error message. The UNIQUE index on `phone` is the
    // actual guarantee — this read can go stale between check and insert, and
    // the constraint catches the race.
    if (await this.users.existsByPhone(command.phone)) {
      throw new PhoneAlreadyRegisteredError();
    }

    // Validated and hashed BEFORE anything is written, so a bad answer set
    // fails the request rather than leaving a half-registered account.
    const securityAnswers = await this.securityQuestions.prepareAnswers(
      command.securityAnswers,
    );

    // Hash BEFORE the transaction. Argon2id is intentionally slow (~50-100ms);
    // doing it inside the transaction would hold a database connection for the
    // entire duration for no reason.
    const passwordHash = await this.hasher.hash(command.password);

    const userId = this.ids.generate();
    const walletId = this.ids.generate();

    await this.users.createWithWallet({
      userId,
      walletId,
      phone: command.phone,
      displayName: command.displayName,
      email: command.email ?? null,
      passwordHash,
      openingBalancePoisha: OPENING_BALANCE.poisha,
      genesisWalletId: GENESIS_WALLET_ID,
      transactionId: this.ids.generate(),
      debitEntryId: this.ids.generate(),
      creditEntryId: this.ids.generate(),
      securityAnswers,
    });

    await this.audit.record(
      AuditAction.REGISTERED,
      { type: 'User', id: userId },
      { ...context, actorUserId: userId },
      { after: { phone: command.phone, openingBalancePoisha: OPENING_BALANCE.poisha.toString() } },
    );

    const token = await this.tokens.issue({ sub: userId, phone: command.phone });
    this.logger.log(`Registered user ${userId}.`);

    return {
      userId,
      phone: command.phone,
      displayName: command.displayName,
      accessToken: token.accessToken,
      tokenType: token.tokenType,
      expiresInSeconds: token.expiresInSeconds,
    };
  }

  private async enforceAuthRateLimit(phone: string, context: AuditContext): Promise<void> {
    const key = `${context.ipAddress ?? 'unknown'}:${phone}`;
    const decision = await this.rateLimiter.consume(RateLimitAction.AUTH, key, {
      limit: 10,
      windowSeconds: 300,
    });
    if (decision.allowed) return;

    await this.audit.record(
      AuditAction.RATE_LIMITED,
      { type: 'AuthAttempt', id: phone },
      context,
      { after: { action: 'register', retryAfterSeconds: decision.retryAfterSeconds } },
    );
    throw new RateLimitExceededError(decision.retryAfterSeconds);
  }
}

/**
 * Login.
 *
 * SECURITY DECISIONS, and why each one is made this way:
 *
 *  1. ONE ERROR FOR EVERY FAILURE. "No such user" and "wrong password" return
 *     the identical `InvalidCredentialsError`. Distinguishing them turns the
 *     login endpoint into a user-enumeration oracle: an attacker submits phone
 *     numbers, and a different error confirms which ones have accounts. That
 *     list is then worth selling, and is the input to a credential-stuffing run.
 *
 *  2. HASH EVEN WHEN THE USER DOES NOT EXIST. Without this the response time
 *     leaks the same information the error message was hiding: a missing user
 *     returns in ~1ms, a real one in ~80ms after argon2 runs. The verification
 *     is performed against a dummy hash so both paths cost the same.
 *
 *  3. TRANSPARENT REHASH ON LOGIN. KDF cost parameters must rise as hardware
 *     gets faster. Login is the only moment the plaintext is legitimately in
 *     hand, so it is the only place a hash can be upgraded without asking the
 *     user to change their password.
 *
 *  4. FAILURES ARE AUDITED WITH THE SUBMITTED IDENTIFIER, whether or not the
 *     account exists. A burst against non-existent numbers is enumeration in
 *     progress, and it is invisible unless the misses are recorded too.
 */
@Injectable()
export class LoginUserUseCase implements OnModuleInit {
  private readonly logger = new Logger(LoginUserUseCase.name);

  /**
   * A real argon2id hash of a value nobody knows, used to burn the same CPU
   * time when the account does not exist. Computed once at startup.
   */
  private dummyHash: string | null = null;

  constructor(
    @Inject(USER_WRITE_REPOSITORY) private readonly users: UserWriteRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly userReads: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuerPort,
    private readonly audit: AuditService,
    @Inject(RATE_LIMITER_PORT) private readonly rateLimiter: RateLimiterPort,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hasher.hash('goti-timing-equalisation-placeholder');
  }

  async execute(command: LoginCommand, context: AuditContext): Promise<AuthResult> {
    await this.enforceAuthRateLimit(command.phone, context);
    const credentials = await this.users.findCredentialsByPhone(command.phone);

    if (!credentials) {
      // Decision 2: spend the same time as a real verification, so the timing
      // does not reveal what the error message refuses to.
      await this.burnEquivalentTime(command.password);
      await this.audit.recordFailedLogin(command.phone, 'NO_SUCH_ACCOUNT', context);
      throw new InvalidCredentialsError();
    }

    const passwordMatches = await this.hasher.verify(credentials.passwordHash, command.password);

    if (!passwordMatches) {
      await this.audit.recordFailedLogin(command.phone, 'WRONG_PASSWORD', context);
      throw new InvalidCredentialsError();
    }

    // Checked AFTER the password, deliberately. Reporting "this account is
    // suspended" to someone who has not proved they own it confirms the account
    // exists — the same enumeration leak, through a different door.
    if (credentials.status !== 'ACTIVE') {
      await this.audit.recordFailedLogin(command.phone, `ACCOUNT_${credentials.status}`, context);
      throw new AccountNotActiveError();
    }

    // Decision 3: upgrade the hash while we legitimately hold the plaintext.
    if (this.hasher.needsRehash(credentials.passwordHash)) {
      await this.upgradeHash(credentials.userId, command.password, context);
    }

    const user = await this.userReads.findById(credentials.userId);
    const token = await this.tokens.issue({ sub: credentials.userId, phone: command.phone });

    await this.audit.record(
      AuditAction.LOGIN_SUCCEEDED,
      { type: 'User', id: credentials.userId },
      { ...context, actorUserId: credentials.userId },
    );

    return {
      userId: credentials.userId,
      phone: command.phone,
      displayName: user?.displayName ?? '',
      accessToken: token.accessToken,
      tokenType: token.tokenType,
      expiresInSeconds: token.expiresInSeconds,
    };
  }

  private async enforceAuthRateLimit(phone: string, context: AuditContext): Promise<void> {
    const key = `${context.ipAddress ?? 'unknown'}:${phone}`;
    const decision = await this.rateLimiter.consume(RateLimitAction.AUTH, key, {
      limit: 10,
      windowSeconds: 300,
    });
    if (decision.allowed) return;

    await this.audit.record(
      AuditAction.RATE_LIMITED,
      { type: 'AuthAttempt', id: phone },
      context,
      { after: { action: 'login', retryAfterSeconds: decision.retryAfterSeconds } },
    );
    throw new RateLimitExceededError(decision.retryAfterSeconds);
  }

  private async burnEquivalentTime(submittedPassword: string): Promise<void> {
    this.dummyHash ??= await this.hasher.hash('goti-timing-equalisation-placeholder');
    await this.hasher.verify(this.dummyHash, submittedPassword);
  }

  /** Best-effort. A failed upgrade must never fail a valid login. */
  private async upgradeHash(
    userId: string,
    password: string,
    context: AuditContext,
  ): Promise<void> {
    try {
      await this.users.updatePasswordHash(userId, await this.hasher.hash(password));
      await this.audit.record(
        AuditAction.PASSWORD_REHASHED,
        { type: 'User', id: userId },
        { ...context, actorUserId: userId },
      );
      this.logger.log(`Upgraded password hash parameters for user ${userId}.`);
    } catch (error) {
      this.logger.warn(`Password rehash failed for ${userId}: ${(error as Error).message}`);
    }
  }
}
