# Goti — Frontend

> React · TypeScript · Tailwind · Vite
> A demonstration layer. **The backend is the authority.**

| | |
|---|---|
| **Status** | Typechecks clean under `strict` + `noUncheckedIndexedAccess`; production build OK (209 kB JS / 66 kB gzip) |
| **API base** | `VITE_API_BASE_URL`, default `http://localhost:3000` (no global prefix) |
| **Verified** | Zero `fetch(` calls outside the API service layer |

---

## Running it

```bash
# 1. Backend (from goti/)
docker run -d --name goti-redis -p 6379:6379 redis:7-alpine
npx prisma migrate deploy && npx prisma db seed
npm run start:dev            # :3000

# 2. Frontend (from goti/web/)
cp .env.example .env
npm install
npm run dev                  # :5173
```

CORS is configured in the backend for `http://localhost:5173`. Override with
`CORS_ORIGINS` (comma-separated) if the dev server moves.

---

## How the frontend talks to the backend architecture

### One choke point, mirroring the backend's own

Every network call goes through a single `request()` function in
[`src/api/client.ts`](src/api/client.ts). No component calls `fetch`.

That mirrors the backend's Transaction Engine — one function every money
movement passes through — and buys the same things: one place that attaches the
token, one place that shapes errors, one place to add a retry or a request log.
A component calling `fetch` itself would have to re-implement all four and would
get one of them subtly wrong.

```
Component  →  api.wallet.sendMoney()  →  request()  →  fetch  →  POST /wallet/send-money
                                            │
                                    attaches Bearer token
                                    normalises ApiError
                                    clears session on 401
```

### The layer boundary is the same one the backend draws

| Backend layer | Frontend equivalent | Responsibility |
|---|---|---|
| Controller (L2) | Page component | Collect input, render output |
| Use case (L1) | `useAction` / `useAsync` | Sequence one operation, hold its state |
| Port (L1) | `api.*` methods | Named operations, no transport detail |
| Adapter (L2) | `request()` | HTTP, headers, error shaping |

### What the frontend deliberately does NOT do

- **No balance arithmetic.** Amounts arrive as **strings** (the backend's
  `BigIntSerializerInterceptor` emits BigInt poisha as strings, because
  JavaScript's `Number` loses precision above 2^53). They are rendered, never
  summed. Where the backend supplies `balanceFormatted` or `amountFormatted`,
  that string is what appears on screen — re-deriving it here would be a second
  implementation that can disagree.
- **No transaction rules.** The send screen never checks whether the balance is
  sufficient. A client-side check would be wrong the moment two transfers race,
  and the backend's conditional atomic update is the only correct place for it.
- **No security logic.** `RequireAuth` is *navigation*, not authorisation.
  Bypassing it in a console yields an empty shell whose every request 401s.
  `JwtAuthGuard` verifies each call server-side, and each use case re-checks
  ownership against the database.
- **No risk evaluation.** The monitor page describes the rules the backend runs;
  it does not run them.

### The one piece of protocol logic that DOES belong here

**Idempotency keys.** Minted once when the user confirms a transfer, reused for
every retry of that intent, and regenerated only for a genuinely new one.

Only the client knows whether a retry is the *same intent* or a new one — the
server cannot infer it, which is why the DTO makes the field required. Generating
a fresh key on retry would defeat the mechanism entirely and turn one intent into
two payments.

### Errors are handled by code, never by message

`ApiError` carries the backend's envelope — `code`, `retryable`,
`correlationId`. The UI branches on `code`; message text is for humans and will
be reworded. "Try again" is offered **only** when the backend says `retryable`,
so the app never invites a user to hammer an answer that will not change.

Every error surfaces the correlation ID, which is what makes a support
conversation tractable: one string finds the request across the logs, the audit
trail and the transaction events.

---

## Pages

| Route | Page | Backend endpoints |
|---|---|---|
| `/login`, `/register` | Auth | `POST /auth/login`, `POST /auth/register` |
| `/` | Wallet dashboard | `GET /wallet`, `GET /transactions` |
| `/send` | Send money (4 steps) | `POST /wallet/send-money` |
| `/transactions` | History — paged, filtered, sorted | `GET /transactions` |
| `/transactions/:id` | Detail + lifecycle timeline + ledger | `GET /transactions/:id` |
| `/requests` | Create / accept / decline | `POST\|GET /money-requests`, `:id/accept`, `:id/reject` |
| `/monitor` | Judge-facing system view | `GET /health/ready`, `GET /transactions?status=` |

Pagination, filtering and sorting are all **query parameters** handled by the
backend. Nothing is filtered or sorted in an in-memory array — client-side paging
would mean fetching every row to show twenty, and the backend already serves this
from a composite index built for exactly this access pattern.

---

## What to demonstrate

1. **The transaction timeline** (`/transactions/:id`) — eleven lifecycle events
   read from `transaction_events`, plus the two ledger postings summing to
   exactly **0**. That zero is the system's health check.

2. **Idempotency** — the confirm screen shows the key before sending. Send the
   same one twice; the second call returns the original transaction and moves no
   money.

3. **Graceful degradation** — `docker stop goti-redis`, then watch `/monitor`.
   Redis turns amber, the circuit breaker opens, and **transfers keep
   succeeding**. Redis failing degrades performance, never correctness.

---

## Known gap

The backend writes risk flags to `risk_flags` after every transfer but exposes
**no read endpoint**. The monitor's risk panel therefore explains what the engine
evaluates rather than showing live flags — marked as a gap on the page itself
rather than filled with invented data. `GET /risk-flags` would complete it.

A monitoring dashboard that fabricates data is worse than none: the one thing
this system exists to prove is that its numbers can be trusted.

---

<sub>Goti · গতি — motion · Frontend demonstration layer · PostgreSQL is the source of truth</sub>
