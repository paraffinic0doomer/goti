import type {
  ApiErrorBody,
  AuthResponse,
  BalanceView,
  HealthReport,
  MoneyRequest,
  MoneyRequestStatus,
  Paginated,
  RespondToRequestResult,
  TransactionDetail,
  TransactionDirection,
  TransactionHistoryItem,
  TransactionStatus,
  TransferResponse,
  Pot,
  PotPreview,
  AnswerChallengeResult,
  RiskFlagsView,
  SecurityAnswerInput,
  SecurityChallenge,
  SecurityQuestionCatalogue,
  UserProfile,
  WalletBudget,
  WalletSecurityView,
  WalletView,
} from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

/**
 * A failed API call, carrying the backend's error envelope.
 *
 * The UI branches on `code`, never on `message`. Message text is for humans and
 * will be reworded; codes are a contract. Matching on prose is how a UI quietly
 * stops handling "insufficient funds" after someone improves the wording.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
    readonly correlationId: string | null,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The server was reachable but said no for a business reason. */
  get isBusinessRejection(): boolean {
    return this.statusCode >= 400 && this.statusCode < 500;
  }
}

/**
 * Extracts a security challenge from a 428 error, if that is what it is.
 *
 * The challenge travels in the error body because the action was REFUSED, not
 * completed. Centralising the extraction means no screen has to know the
 * envelope shape.
 */
export function challengeFrom(error: unknown): SecurityChallenge | null {
  if (!(error instanceof ApiError) || error.code !== 'SECURITY_CHALLENGE_REQUIRED') return null;
  const details = error.details as Record<string, unknown> | undefined;
  if (!details?.challengeId) return null;

  return {
    challengeId: String(details.challengeId),
    questionKey: details.questionKey as SecurityChallenge['questionKey'],
    prompt: String(details.prompt),
    expiresAt: String(details.expiresAt),
  };
}

/** Raised when the network itself failed — the request may or may not have run. */
export class NetworkError extends Error {
  readonly code = 'NETWORK_UNREACHABLE';
  readonly retryable = true;
  constructor(cause: unknown) {
    super('Could not reach the Goti server. Check your connection and try again.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

type TokenReader = () => string | null;
type UnauthorizedHandler = () => void;

let readToken: TokenReader = () => null;
let onUnauthorized: UnauthorizedHandler = () => undefined;

/**
 * Wires the client to the auth store.
 *
 * The token is supplied through a callback rather than imported, so this module
 * has no dependency on React state and stays usable from anywhere.
 */
export function configureApiAuth(reader: TokenReader, unauthorized: UnauthorizedHandler): void {
  readToken = reader;
  onUnauthorized = unauthorized;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** Skips the Authorization header. Only for login and register. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

/**
 * ============================================================================
 *  THE API SERVICE LAYER
 * ============================================================================
 *
 * Every network call in the application goes through this one function. No
 * component calls `fetch` directly.
 *
 * That single choke point mirrors the backend's own design — where every money
 * movement passes through one Transaction Engine — and buys the same things:
 * one place that attaches the token, one place that shapes errors, one place to
 * add a retry or a request log. A component that called `fetch` itself would
 * need to re-implement all four, and would get one of them subtly wrong.
 *
 * WHAT THIS LAYER DELIBERATELY DOES NOT DO
 *   - It does not decide whether a transfer is allowed.
 *   - It does not compute or adjust a balance.
 *   - It does not evaluate risk, limits, or ownership.
 *
 * Those are the backend's job, and duplicating any of them here would create a
 * second implementation that can disagree with the authoritative one. The
 * frontend's entire responsibility is to ask correctly and render honestly.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  if (!options.anonymous) {
    const token = readToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (cause) {
    // A network failure is NOT a business failure. It is genuinely unknown
    // whether the server processed the request — which is exactly why every
    // money-moving call carries an idempotency key, so a retry is safe.
    throw new NetworkError(cause);
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const body = (payload ?? {}) as Partial<ApiErrorBody>;

    // A 401 means the token is gone or expired. Clear the session once, here,
    // rather than making every screen handle it.
    if (response.status === 401) onUnauthorized();

    throw new ApiError(
      body.code ?? 'UNKNOWN_ERROR',
      body.message ?? 'Something went wrong.',
      response.status,
      body.retryable ?? false,
      body.correlationId ?? response.headers.get('x-correlation-id'),
      body.details,
    );
  }

  return payload as T;
}

function toQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

/**
 * Generates an idempotency key.
 *
 * THIS IS GENUINELY THE CLIENT'S RESPONSIBILITY, and one of the few pieces of
 * protocol logic that legitimately belongs in the frontend.
 *
 * The key must identify one INTENT, and stay stable across every retry of that
 * intent. It is therefore minted once when the user confirms a transfer and
 * reused if the request is retried — generating a fresh key on retry would
 * defeat the entire mechanism and let one intent become two payments.
 *
 * `crypto.randomUUID` is available in every browser this targets.
 */
export function newIdempotencyKey(prefix = 'GOTI'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * Converts a taka string from a text input into integer poisha.
 *
 * NOT a balance calculation — it is unit parsing at the input boundary, done
 * with string manipulation rather than `parseFloat` precisely so no float ever
 * touches a money value. "12.34" becomes 1234, exactly.
 */
export function takaInputToPoisha(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;

  const [whole = '0', fraction = ''] = trimmed.split('.');
  const paddedFraction = fraction.padEnd(2, '0');

  const poisha = Number(`${whole}${paddedFraction}`);
  return Number.isSafeInteger(poisha) && poisha > 0 ? poisha : null;
}

/** Formats a poisha string for display. Presentation only — never arithmetic. */
export function formatPoisha(poisha: string, currency = 'BDT'): string {
  const negative = poisha.startsWith('-');
  const digits = (negative ? poisha.slice(1) : poisha).padStart(3, '0');

  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return `${negative ? '−' : ''}${grouped}.${fraction} ${currency}`;
}

// ===========================================================================
//  Endpoints — one method per backend route, named after what it does.
// ===========================================================================

export const api = {
  auth: {
    register: (body: {
      phone: string;
      displayName: string;
      password: string;
      email?: string;
      /** Exactly 3. There is no registration path without them. */
      securityAnswers: SecurityAnswerInput[];
    }) => request<AuthResponse>('/auth/register', { method: 'POST', body, anonymous: true }),

    login: (body: { phone: string; password: string }) =>
      request<AuthResponse>('/auth/login', { method: 'POST', body, anonymous: true }),
  },

  wallet: {
    get: () => request<WalletView>('/wallet'),
    balance: () => request<BalanceView>('/wallet/balance'),

    /**
     * Sends money.
     *
     * `amount` is integer POISHA — the field name on the wire is `amount`, and
     * the DTO rejects anything that is not a positive whole number.
     */
    sendMoney: (body: {
      receiverId?: string;
      receiverPhone?: string;
      amount: number;
      idempotencyKey: string;
      note?: string;
    }) => request<TransferResponse>('/wallet/send-money', { method: 'POST', body }),
  },

  transactions: {
    list: (params: {
      page?: number;
      pageSize?: number;
      direction?: TransactionDirection;
      status?: TransactionStatus;
      fromDate?: string;
      toDate?: string;
      sort?: 'newest' | 'oldest' | 'largest' | 'smallest';
    } = {}) =>
      request<Paginated<TransactionHistoryItem>>(`/transactions${toQueryString(params)}`),

    detail: (transactionId: string) =>
      request<TransactionDetail>(`/transactions/${transactionId}`),
  },

  moneyRequests: {
    create: (body: {
      payerId?: string;
      payerPhone?: string;
      amount: number;
      idempotencyKey: string;
      note?: string;
    }) => request<MoneyRequest>('/money-requests', { method: 'POST', body }),

    /** The payer settles the claim. This is what creates a transfer. */
    accept: (requestId: string, idempotencyKey: string) =>
      request<RespondToRequestResult>(`/money-requests/${requestId}/accept`, {
        method: 'POST',
        body: { idempotencyKey },
      }),

    reject: (requestId: string) =>
      request<RespondToRequestResult>(`/money-requests/${requestId}/reject`, {
        method: 'POST',
        body: {},
      }),

    pending: (params: { role?: 'payer' | 'requester'; page?: number; pageSize?: number } = {}) =>
      request<Paginated<MoneyRequest>>(`/money-requests/pending${toQueryString(params)}`),

    list: (
      params: {
        role?: 'payer' | 'requester';
        status?: MoneyRequestStatus;
        page?: number;
        pageSize?: number;
      } = {},
    ) => request<Paginated<MoneyRequest>>(`/money-requests${toQueryString(params)}`),
  },

  /** Emergency freeze. Never rate limited — see the backend use case. */
  security: {
    state: () => request<WalletSecurityView>('/wallet/security'),
    freeze: (reason: string) =>
      request<WalletSecurityView>('/wallet/freeze', { method: 'POST', body: { reason } }),
    unfreeze: (reason: string) =>
      request<WalletSecurityView>('/wallet/unfreeze', { method: 'POST', body: { reason } }),
  },

  /**
   * Expense envelopes.
   *
   * Every call returns the FULL budget, so a component can replace its whole
   * state from any response rather than patching one field and hoping the
   * others still agree.
   */
  envelopes: {
    list: () => request<WalletBudget>('/envelopes'),
    create: (body: { name: string; category?: string; icon?: string; targetAmount?: number }) =>
      request<WalletBudget>('/envelopes', { method: 'POST', body }),
    reserve: (envelopeId: string, amount: number) =>
      request<WalletBudget>(`/envelopes/${envelopeId}/reserve`, { method: 'POST', body: { amount } }),
    unlock: (envelopeId: string, amount: number) =>
      request<WalletBudget>(`/envelopes/${envelopeId}/unlock`, { method: 'POST', body: { amount } }),
    remove: (envelopeId: string) =>
      request<WalletBudget>(`/envelopes/${envelopeId}`, { method: 'DELETE' }),
  },

  /** Group pots. Contributions are real transfers through the engine. */
  pots: {
    list: (params: { page?: number; pageSize?: number } = {}) =>
      request<Paginated<Pot>>(`/pots${toQueryString(params)}`),
    create: (body: { name: string; note?: string; targetAmount: number }) =>
      request<Pot>('/pots', { method: 'POST', body }),
    view: (potId: string) => request<Pot>(`/pots/${potId}`),
    /** Joining from a shared code — how anyone who did not create the pot gets in. */
    joinByCode: (code: string) => request<Pot>('/pots/join', { method: 'POST', body: { code } }),
    /** Preview before joining. Deliberately without the member breakdown. */
    preview: (code: string) => request<PotPreview>(`/pots/preview/${encodeURIComponent(code)}`),
    /** Creator adds someone directly. Membership moves no money. */
    addMember: (potId: string, phone: string) =>
      request<Pot>(`/pots/${potId}/members`, { method: 'POST', body: { phone } }),
    contribute: (potId: string, amount: number, idempotencyKey: string) =>
      request<{ pot: Pot; transfer: TransferResponse }>(`/pots/${potId}/contribute`, {
        method: 'POST',
        body: { amount, idempotencyKey },
      }),
    settle: (potId: string, idempotencyKey: string) =>
      request<{ pot: Pot; transfer: TransferResponse }>(`/pots/${potId}/settle`, {
        method: 'POST',
        body: { idempotencyKey },
      }),
  },

  security_questions: {
    /** Public — the registration form needs this before an account exists. */
    catalogue: () =>
      request<SecurityQuestionCatalogue>('/security/questions', { anonymous: true }),
    answer: (challengeId: string, answer: string) =>
      request<AnswerChallengeResult>(`/security/challenges/${challengeId}/answer`, {
        method: 'POST',
        body: { answer },
      }),
  },

  /** The read side of the fraud engine. Scoped to the caller. */
  risk: {
    flags: () => request<RiskFlagsView>('/risk-flags'),
  },

  users: {
    profile: () => request<UserProfile>('/users/profile'),
  },

  health: {
    ready: () => request<HealthReport>('/health/ready', { anonymous: true }),
  },
};
