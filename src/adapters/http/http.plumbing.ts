import {
  ArgumentsHost,
  CallHandler,
  CanActivate,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  UnauthorizedException,
  createParamDecorator,
  SetMetadata,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

import { TOKEN_ISSUER, TokenIssuerPort } from '../../application/ports/security.port';
import { DomainError, isDomainError } from '../../domain/errors/domain-errors';
import { AuditContext } from '../../application/services/audit.service';

// ===========================================================================
//  Authenticated request shape
// ===========================================================================

export interface AuthenticatedUser {
  readonly userId: string;
  readonly phone: string;
}

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
  correlationId?: string;
}

function ensureCorrelationId(request: RequestWithUser): string {
  if (request.correlationId) return request.correlationId;

  const supplied = request.headers['x-correlation-id'];
  request.correlationId =
    typeof supplied === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied)
      ? supplied
      : randomUUID();

  return request.correlationId;
}

/**
 * Injects the authenticated user into a handler.
 *
 * Handlers take the user from the verified TOKEN, never from the request body.
 * A `senderUserId` field in a payload is an authorisation hole — the client
 * would be naming whose money moves.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) {
      // Unreachable behind JwtAuthGuard; thrown rather than assumed so that
      // forgetting the guard fails loudly instead of running unauthenticated.
      throw new UnauthorizedException('Authentication required.');
    }
    return request.user;
  },
);

/** Request metadata for the audit trail. Never used in a business decision. */
export const Audit = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuditContext => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    return {
      actorUserId: request.user?.userId ?? null,
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent')?.slice(0, 255) ?? null,
      correlationId: request.correlationId ?? null,
    };
  },
);

/** Marks a route as public — no token required. */
export const PUBLIC_ROUTE = 'goti:public_route';
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

// ===========================================================================
//  Authentication guard
// ===========================================================================

/**
 * Verifies the bearer token and attaches the user.
 *
 * DEFAULT-DENY: applied globally, so a new controller is protected the moment
 * it exists. Routes opt OUT with `@Public()`. The opposite arrangement —
 * opt-in protection — means every forgotten decorator is an unauthenticated
 * endpoint, and the mistake is invisible until someone finds it.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuerPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('x-correlation-id', ensureCorrelationId(request));

    const handler = context.getHandler();
    if (
      Reflect.getMetadata(PUBLIC_ROUTE, handler) ||
      Reflect.getMetadata(PUBLIC_ROUTE, context.getClass())
    ) {
      return true;
    }

    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication required.');
    }

    const claims = await this.tokens.verify(header.slice('Bearer '.length));
    if (!claims) {
      // One message for expired, malformed and tampered. Distinguishing them
      // only helps an attacker probe the token format.
      throw new UnauthorizedException('Invalid or expired token.');
    }

    request.user = { userId: claims.sub, phone: claims.phone };
    return true;
  }
}

// ===========================================================================
//  Correlation ID
// ===========================================================================

/**
 * Stamps every request with an id that follows it through logs, audit rows and
 * transaction events.
 *
 * Without one, reconstructing "what happened to this transfer" means correlating
 * by timestamp across three tables — which stops working the moment two users
 * transact in the same millisecond.
 */
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const response = context.switchToHttp().getResponse<Response>();

    const correlationId = ensureCorrelationId(request);
    response.setHeader('x-correlation-id', correlationId);

    return next.handle();
  }
}

// ===========================================================================
//  BigInt serialisation
// ===========================================================================

/**
 * Converts BigInt to string on the way out.
 *
 * `JSON.stringify(100n)` THROWS. Money in Goti is BigInt poisha, so without
 * this every response carrying an amount would 500. Serialising as a STRING
 * rather than a number is deliberate: JavaScript's `Number` loses precision
 * above 2^53, and a client parsing a large balance as a float would reintroduce
 * exactly the imprecision the BigInt type exists to prevent.
 */
@Injectable()
export class BigIntSerializerInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((value) => this.convert(value)));
  }

  private convert(value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((item) => this.convert(item));

    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          this.convert(item),
        ]),
      );
    }
    return value;
  }
}

// ===========================================================================
//  Exception filter
// ===========================================================================

/**
 * Maps domain error codes onto HTTP status codes.
 *
 * The mapping lives HERE, in the adapter layer, because HTTP is a delivery
 * detail. A use case that threw `new NotFoundException()` would be coupled to
 * the web, and unusable from a queue consumer or a CLI.
 */
const STATUS_BY_CODE: Readonly<Record<string, HttpStatus>> = {
  // 400 — the request itself is wrong
  INVALID_AMOUNT: HttpStatus.BAD_REQUEST,
  INVALID_DATE_RANGE: HttpStatus.BAD_REQUEST,
  SELF_TRANSFER_NOT_ALLOWED: HttpStatus.BAD_REQUEST,
  SELF_REQUEST_NOT_ALLOWED: HttpStatus.BAD_REQUEST,
  CURRENCY_MISMATCH: HttpStatus.BAD_REQUEST,

  // 401 / 403
  INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
  ACCOUNT_NOT_ACTIVE: HttpStatus.FORBIDDEN,
  NOT_THE_PAYER: HttpStatus.FORBIDDEN,
  BLOCKED_BY_RISK_POLICY: HttpStatus.FORBIDDEN,

  // 404
  USER_NOT_FOUND: HttpStatus.NOT_FOUND,
  WALLET_NOT_FOUND: HttpStatus.NOT_FOUND,
  TRANSACTION_NOT_FOUND: HttpStatus.NOT_FOUND,
  MONEY_REQUEST_NOT_FOUND: HttpStatus.NOT_FOUND,

  // 409 — the request is valid but conflicts with current state
  PHONE_ALREADY_REGISTERED: HttpStatus.CONFLICT,
  REGISTRATION_CONFLICT: HttpStatus.CONFLICT,
  DUPLICATE_REQUEST: HttpStatus.CONFLICT,
  TRANSACTION_IN_PROGRESS: HttpStatus.CONFLICT,
  MONEY_REQUEST_ALREADY_RESOLVED: HttpStatus.CONFLICT,
  ILLEGAL_STATE_TRANSITION: HttpStatus.CONFLICT,
  WALLET_NOT_ACTIVE: HttpStatus.CONFLICT,
  USER_NOT_ACTIVE: HttpStatus.CONFLICT,
  MONEY_REQUEST_EXPIRED: HttpStatus.CONFLICT,

  // 422 — well-formed, but the business says no
  INSUFFICIENT_FUNDS: HttpStatus.UNPROCESSABLE_ENTITY,
  TRANSFER_LIMIT_EXCEEDED: HttpStatus.UNPROCESSABLE_ENTITY,

  // 428 — the request is valid but a precondition (proving ownership) is unmet.
  // Semantically exact, and distinct from 401 so a client never confuses
  // "answer your security question" with "your session expired".
  SECURITY_CHALLENGE_REQUIRED: HttpStatus.PRECONDITION_REQUIRED,
  SECURITY_ANSWER_INCORRECT: HttpStatus.FORBIDDEN,
  SECURITY_CHALLENGE_NOT_FOUND: HttpStatus.GONE,
  SECURITY_ANSWERS_REQUIRED: HttpStatus.BAD_REQUEST,
  SECURITY_LOCKED_CONTACT_SUPPORT: HttpStatus.FORBIDDEN,

  // 429
  RATE_LIMIT_EXCEEDED: HttpStatus.TOO_MANY_REQUESTS,

  // 503 — contention. Retryable, and the client should be told so.
  LOCK_TIMEOUT: HttpStatus.SERVICE_UNAVAILABLE,
  CONCURRENCY_CONFLICT: HttpStatus.SERVICE_UNAVAILABLE,

  // Integrity faults are server incidents, never client mistakes.
  LEDGER_INTEGRITY_VIOLATION: HttpStatus.INTERNAL_SERVER_ERROR,
};

const SAFE_MESSAGE_BY_CODE: Readonly<Record<string, string>> = {
  INVALID_CREDENTIALS: 'Invalid phone number or password.',
  PHONE_ALREADY_REGISTERED: 'An account already exists for this phone number.',
  REGISTRATION_CONFLICT: 'An account already exists with the supplied details.',
  DUPLICATE_REQUEST: 'This idempotency key has already been used.',
  USER_NOT_FOUND: 'The requested user was not found.',
  WALLET_NOT_FOUND: 'Wallet not found.',
  TRANSACTION_NOT_FOUND: 'Transaction not found.',
  MONEY_REQUEST_NOT_FOUND: 'Money request not found.',
  INSUFFICIENT_FUNDS: 'Insufficient balance.',
  LEDGER_INTEGRITY_VIOLATION: 'The transaction could not be completed.',
};

interface ErrorBody {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlationId: string | null;
  readonly timestamp: string;
  readonly details?: unknown;
}

/**
 * The single exit point for every error.
 *
 * TWO RULES IT ENFORCES:
 *
 *  1. INTERNAL DETAIL NEVER REACHES THE CLIENT. An unrecognised error becomes a
 *     flat 500 with a generic message. Stack traces, SQL fragments and driver
 *     messages go to the logs. A leaked constraint name tells an attacker the
 *     schema; a leaked query tells them how to probe it.
 *
 *  2. EVERY RESPONSE CARRIES THE CORRELATION ID. A user reporting "my transfer
 *     failed" can quote one string that finds the request in the logs, the
 *     audit trail and the transaction events.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const httpContext = host.switchToHttp();
    const request = httpContext.getRequest<RequestWithUser>();
    const response = httpContext.getResponse<Response>();
    const correlationId = request.correlationId ?? null;

    const body = this.toBody(exception, correlationId);

    if (
      isDomainError(exception) &&
      exception.code === 'RATE_LIMIT_EXCEEDED' &&
      'retryAfterSeconds' in exception
    ) {
      response.setHeader(
        'Retry-After',
        String((exception as DomainError & { retryAfterSeconds: number }).retryAfterSeconds),
      );
    }

    if (body.statusCode >= 500) {
      this.logger.error(
        `[${correlationId}] ${request.method} ${request.url} → ${body.statusCode}: ` +
          `${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
    } else {
      // Include the field-level details. The correlation ID is the string a
      // user quotes to support, so the line it resolves to must actually say
      // what went wrong — "→ 400 REQUEST_INVALID" alone sends the responder
      // back to the client to ask which field it was.
      const detail = body.details
        ? ` · ${Array.isArray(body.details) ? body.details.join('; ') : String(body.details)}`
        : '';

      this.logger.warn(
        `[${correlationId}] ${request.method} ${request.url} → ${body.statusCode} ${body.code}${detail}`,
      );
    }

    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown, correlationId: string | null): ErrorBody {
    const timestamp = new Date().toISOString();

    if (isDomainError(exception)) {
      const domainError = exception as DomainError;

      // A few errors carry data the client must act on — chiefly the security
      // challenge, which is useless if the question never reaches the user.
      //
      // WHITELISTED EXPLICITLY, field by field. Domain errors are never
      // blanket-serialised: most carry internals (wallet ids, balances, rule
      // thresholds) that must not leave the server, and a spread would leak
      // them the moment someone added a field to an error class.
      const payload = domainError as unknown as Record<string, unknown>;
      const extra =
        domainError.code === 'SECURITY_CHALLENGE_REQUIRED'
          ? {
              challengeId: payload.challengeId,
              questionKey: payload.questionKey,
              prompt: payload.prompt,
              expiresAt: payload.expiresAt,
            }
          : domainError.code === 'SECURITY_ANSWER_INCORRECT'
            ? {
                walletFrozen: payload.walletFrozen,
                attemptsRemaining: payload.attemptsRemaining,
              }
            : undefined;

      return {
        statusCode: STATUS_BY_CODE[domainError.code] ?? HttpStatus.BAD_REQUEST,
        code: domainError.code,
        message: SAFE_MESSAGE_BY_CODE[domainError.code] ?? domainError.message,
        retryable: domainError.retryable,
        correlationId,
        timestamp,
        ...(extra ? { details: extra } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      return {
        statusCode: status,
        code: status === HttpStatus.UNAUTHORIZED ? 'UNAUTHENTICATED' : 'REQUEST_INVALID',
        message: exception.message,
        retryable: false,
        correlationId,
        timestamp,
        // class-validator's field messages are safe to return — they describe
        // the client's own input, not anything internal.
        details:
          typeof payload === 'object' && payload !== null && 'message' in payload
            ? (payload as { message: unknown }).message
            : undefined,
      };
    }

    // Unrecognised. Say nothing useful.
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred. Please try again or contact support.',
      retryable: true,
      correlationId,
      timestamp,
    };
  }
}
