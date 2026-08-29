import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

import { ApiError, NetworkError } from '../api/client';

/**
 * Reusable primitives.
 *
 * Every loading, error and empty state in the app is rendered by one of these,
 * so those states are consistent by construction rather than by each screen
 * remembering to handle them.
 */

// ---------------------------------------------------------------------------
//  Layout
// ---------------------------------------------------------------------------

export function Card({
  children,
  title,
  action,
  className = '',
}: {
  children: ReactNode;
  title?: string;
  action?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={`border border-rule bg-surface ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-4 border-b border-rule bg-surface-alt px-5 py-3">
          {title && (
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-soft">
              {title}
            </h2>
          )}
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
//  Controls
// ---------------------------------------------------------------------------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
};

export function Button({
  variant = 'primary',
  loading = false,
  disabled,
  children,
  className = '',
  ...rest
}: ButtonProps): JSX.Element {
  const styles = {
    primary: 'bg-taka text-white hover:bg-taka/90 disabled:bg-taka/40',
    secondary: 'border border-rule-strong bg-surface text-ink hover:bg-surface-alt disabled:text-ink-faint',
    danger: 'border border-debit bg-debit-soft text-debit hover:bg-debit/10 disabled:opacity-50',
  }[variant];

  return (
    <button
      {...rest}
      // A loading button must also be disabled. Otherwise a second click sends
      // a second request — which on a transfer is exactly the double-submit the
      // idempotency key exists to survive, and better avoided entirely.
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium
        transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
        focus-visible:outline-taka disabled:cursor-not-allowed ${styles} ${className}`}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
};

export function Field({ label, hint, error, className = '', ...rest }: FieldProps): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-soft">
        {label}
      </span>
      <input
        {...rest}
        aria-invalid={error ? true : undefined}
        className={`w-full border bg-surface px-3 py-2 text-sm text-ink
          placeholder:text-ink-faint focus:outline focus:outline-2 focus:outline-offset-[-1px]
          focus:outline-taka ${error ? 'border-debit' : 'border-rule-strong'} ${className}`}
      />
      {error ? (
        <span className="mt-1 block text-xs text-debit">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-ink-faint">{hint}</span>
      ) : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
//  Status
// ---------------------------------------------------------------------------

export function Spinner({ className = 'h-5 w-5' }: { className?: string }): JSX.Element {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z"
      />
    </svg>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3 py-8 text-ink-faint" role="status">
      <Spinner />
      <span className="text-sm">{label}…</span>
    </div>
  );
}

export function Empty({ message }: { message: string }): JSX.Element {
  return (
    <p className="border border-dashed border-rule-strong px-4 py-8 text-center text-sm text-ink-faint">
      {message}
    </p>
  );
}

/**
 * The single error renderer.
 *
 * Shows the backend's own message rather than a generic one — the API already
 * distinguishes "insufficient funds" from "receiver not found", and replacing
 * that with "Something went wrong" throws away the only useful information.
 *
 * The correlation ID is surfaced because it is what makes a support
 * conversation tractable: the user quotes one string that finds the request
 * across the logs, the audit trail and the transaction events.
 */
export function ErrorBanner({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}): JSX.Element | null {
  if (!error) return null;

  const isApi = error instanceof ApiError;
  const isNetwork = error instanceof NetworkError;

  const message = isApi || isNetwork ? error.message : 'An unexpected error occurred.';
  const code = isApi ? error.code : isNetwork ? error.code : 'UNKNOWN';
  const retryable = isApi ? error.retryable : isNetwork;
  const correlationId = isApi ? error.correlationId : null;

  /**
   * Field-level validation messages.
   *
   * For a 400 the top-level `message` is the framework's generic "Bad Request
   * Exception" — accurate and useless. The information the user actually needs
   * ("password must be at least 10 characters") is in `details`, which the DTO
   * produced per field. Rendering only `message` leaves someone staring at a
   * form with no idea which box is wrong.
   */
  const fieldErrors: string[] = isApi
    ? Array.isArray(error.details)
      ? (error.details as unknown[]).map(String)
      : typeof error.details === 'string'
        ? [error.details]
        : []
    : [];

  return (
    <div className="border border-debit bg-debit-soft px-4 py-3" role="alert">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-debit">
            {code}
          </p>
          {/* When the server sent field messages, THEY are the error — the
              generic top-line is demoted to a heading. */}
          <p className="mt-1 text-sm text-ink">
            {fieldErrors.length > 0 ? 'Please fix the following:' : message}
          </p>
          {fieldErrors.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-sm text-ink">
              {fieldErrors.map((detail, index) => (
                <li key={index}>{detail}</li>
              ))}
            </ul>
          )}
          {correlationId && (
            <p className="mt-1.5 font-mono text-[11px] text-ink-faint">
              Reference: {correlationId}
            </p>
          )}
        </div>
        {/* Retry is only offered when the backend says the operation is
            retryable. Offering it on a rejected transfer would invite the user
            to hammer an answer that will not change. */}
        {retryable && onRetry && (
          <Button variant="secondary" onClick={onRetry} className="shrink-0">
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  COMPLETED: 'border-taka bg-taka-soft text-taka',
  ACCEPTED: 'border-taka bg-taka-soft text-taka',
  PENDING: 'border-warn bg-warn-soft text-warn',
  REQUESTED: 'border-warn bg-warn-soft text-warn',
  FAILED: 'border-debit bg-debit-soft text-debit',
  DECLINED: 'border-debit bg-debit-soft text-debit',
  REVERSED: 'border-debit bg-debit-soft text-debit',
  EXPIRED: 'border-rule-strong bg-surface-alt text-ink-faint',
  CANCELLED: 'border-rule-strong bg-surface-alt text-ink-faint',
};

/** Encodes state in FORM as well as text, so status reads at a glance. */
export function StatusBadge({ status }: { status: string }): JSX.Element {
  const style = STATUS_STYLES[status] ?? 'border-rule-strong bg-surface-alt text-ink-soft';
  return (
    <span
      className={`inline-block whitespace-nowrap border px-2 py-0.5 font-mono text-[10px]
        font-semibold uppercase tracking-[0.06em] ${style}`}
    >
      {status}
    </span>
  );
}

/**
 * Renders an amount.
 *
 * Takes a pre-formatted string from the backend where one exists, and only
 * formats a raw poisha string when it does not. Either way the frontend does no
 * arithmetic — `signed` merely selects a colour and a leading glyph.
 */
export function Amount({
  formatted,
  direction,
  className = '',
}: {
  formatted: string;
  direction?: 'SENT' | 'RECEIVED';
  className?: string;
}): JSX.Element {
  const tone =
    direction === 'SENT' ? 'text-debit' : direction === 'RECEIVED' ? 'text-taka' : 'text-ink';
  const sign = direction === 'SENT' ? '−' : direction === 'RECEIVED' ? '+' : '';

  return (
    <span className={`font-mono tabular-nums ${tone} ${className}`}>
      {sign}
      {formatted}
    </span>
  );
}

export function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'good' | 'bad' | 'warn';
}): JSX.Element {
  const toneClass = {
    default: 'text-ink',
    good: 'text-taka',
    bad: 'text-debit',
    warn: 'text-warn',
  }[tone];

  return (
    <div className="border border-rule bg-surface px-4 py-3">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
        {label}
      </p>
      <p className={`mt-1 font-mono text-2xl tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}
