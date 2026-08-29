import { DomainError } from '../../domain/errors/domain-errors';

/** Capacity/security rejection shared by authentication and money use cases. */
export class RateLimitExceededError extends DomainError {
  readonly code = 'RATE_LIMIT_EXCEEDED';
  readonly retryable = true;

  constructor(readonly retryAfterSeconds: number) {
    super(`Too many requests. Try again in ${retryAfterSeconds} seconds.`);
  }
}

/** Stable registration conflict returned instead of a Prisma constraint error. */
export class RegistrationConflictError extends DomainError {
  readonly code = 'REGISTRATION_CONFLICT';
  readonly retryable = false;

  constructor() {
    super('An account already exists with the supplied details.');
  }
}
