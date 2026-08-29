/**
 * Typed domain errors — L0, zero imports.
 *
 * WHY TYPED ERRORS RATHER THAN STRINGS
 * The engine must distinguish a DECISION from a FAILURE, because the retry
 * policy is opposite for each (ARCHITECTURE.md §7):
 *
 *   Business rejection  → the answer is "no". Record it, never retry.
 *   Infrastructure fault → nothing was decided. Roll back, retry is safe.
 *
 * Collapsing them is how one rejected payment becomes forty retries hammering
 * a hot row. The `retryable` flag makes the distinction structural rather than
 * a convention someone has to remember.
 */

export abstract class DomainError extends Error {
  /** Stable machine code, stored in `transactions.failure_reason`. */
  abstract readonly code: string;

  /** Whether re-attempting the identical request could produce a different outcome. */
  abstract readonly retryable: boolean;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

// ---------------------------------------------------------------------------
//  Business rejections — a real, stable answer. NEVER retried.
// ---------------------------------------------------------------------------

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
  readonly retryable = false;

  constructor(
    readonly walletId: string,
    readonly requestedPoisha: bigint,
    readonly availablePoisha: bigint,
  ) {
    super(
      `Wallet ${walletId} holds ${availablePoisha} poisha; ${requestedPoisha} was requested.`,
    );
  }
}

export class SelfTransferError extends DomainError {
  readonly code = 'SELF_TRANSFER_NOT_ALLOWED';
  readonly retryable = false;
  constructor(readonly walletId: string) {
    super(`A wallet cannot send money to itself (${walletId}).`);
  }
}

export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';
  readonly retryable = false;
  constructor(reason: string) {
    super(`Invalid transfer amount: ${reason}`);
  }
}

export class WalletNotActiveError extends DomainError {
  readonly code = 'WALLET_NOT_ACTIVE';
  readonly retryable = false;
  constructor(
    readonly walletId: string,
    readonly status: string,
  ) {
    super(`Wallet ${walletId} is ${status} and cannot participate in a transfer.`);
  }
}

export class UserNotFoundError extends DomainError {
  readonly code = 'USER_NOT_FOUND';
  readonly retryable = false;
  constructor(readonly identifier: string) {
    super(`No user found for "${identifier}".`);
  }
}

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';
  readonly retryable = false;
  constructor(readonly identifier: string) {
    super(`No wallet found for "${identifier}".`);
  }
}

export class UserNotActiveError extends DomainError {
  readonly code = 'USER_NOT_ACTIVE';
  readonly retryable = false;
  constructor(
    readonly userId: string,
    readonly status: string,
  ) {
    super(`User ${userId} is ${status} and cannot move money.`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  readonly retryable = false;
  constructor(from: string, to: string) {
    super(`Cannot transfer between a ${from} wallet and a ${to} wallet.`);
  }
}

export class TransferLimitExceededError extends DomainError {
  readonly code = 'TRANSFER_LIMIT_EXCEEDED';
  readonly retryable = false;
  constructor(
    readonly limitPoisha: bigint,
    readonly requestedPoisha: bigint,
  ) {
    super(`Transfer of ${requestedPoisha} poisha exceeds the per-transfer limit of ${limitPoisha}.`);
  }
}

/** An attempt to move a transaction along an edge the state machine does not have. */
export class IllegalStateTransitionError extends DomainError {
  readonly code = 'ILLEGAL_STATE_TRANSITION';
  readonly retryable = false;
  constructor(
    readonly from: string,
    readonly to: string,
    readonly transactionId?: string,
  ) {
    super(
      `Illegal transition ${from} → ${to}` +
        (transactionId ? ` on transaction ${transactionId}.` : '.'),
    );
  }
}

/**
 * A duplicate request caught by the database unique constraint.
 *
 * Not a failure — the correct response is to return the ORIGINAL transaction.
 */
export class DuplicateRequestError extends DomainError {
  readonly code = 'DUPLICATE_REQUEST';
  readonly retryable = false;
  constructor(
    readonly idempotencyKey: string,
    readonly existingTransactionId?: string,
  ) {
    super(`Request "${idempotencyKey}" has already been processed.`);
  }
}

/** An identical request is executing right now. The client should retry shortly. */
export class TransactionInProgressError extends DomainError {
  readonly code = 'TRANSACTION_IN_PROGRESS';
  readonly retryable = true;
  constructor(readonly idempotencyKey: string) {
    super(`Request "${idempotencyKey}" is currently being processed.`);
  }
}

// ---------------------------------------------------------------------------
//  Infrastructure faults — nothing was decided. Roll back; retry is safe.
// ---------------------------------------------------------------------------

/** Could not acquire a wallet lock in time. Contention, not a decision. */
export class LockAcquisitionError extends DomainError {
  readonly code = 'LOCK_TIMEOUT';
  readonly retryable = true;
  constructor(readonly walletIds: readonly string[]) {
    super(`Timed out acquiring locks on wallets [${walletIds.join(', ')}].`);
  }
}

/** PostgreSQL aborted the transaction under concurrency. Bounded retry applies. */
export class ConcurrencyConflictError extends DomainError {
  readonly code = 'CONCURRENCY_CONFLICT';
  readonly retryable = true;
  constructor(message = 'The transaction conflicted with a concurrent write.') {
    super(message);
  }
}

/**
 * The ledger did not balance, or a projected balance disagreed with it.
 *
 * NOT retryable and NOT recoverable in-process. Money integrity is in question,
 * so the transaction is aborted and a human is paged.
 */
export class LedgerIntegrityError extends DomainError {
  readonly code = 'LEDGER_INTEGRITY_VIOLATION';
  readonly retryable = false;
  constructor(readonly detail: string) {
    super(`Ledger integrity violation: ${detail}`);
  }
}

/** Narrows an unknown catch value to a DomainError. */
export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/** True when a retry could plausibly succeed. Drives the engine's retry loop. */
export function isRetryable(error: unknown): boolean {
  return isDomainError(error) && error.retryable;
}
