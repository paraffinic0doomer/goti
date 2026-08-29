# Goti · গতি

> A digital money movement platform. **Not** a banking system.
> Closed wallet ecosystem, fake BDT balances, built to prove one thing:
> **money never disappears and never duplicates, under failure or concurrency.**

---

## Read this first — the 5-minute version

**One sentence:** balances are a *projection* of an immutable double-entry ledger, every money movement goes through a single Transaction Engine, and that engine's correctness rests on one SQL statement.

**The statement everything depends on:**

```sql
UPDATE wallets
   SET balance_poisha = balance_poisha - :amount
 WHERE id = :wallet
   AND status = 'ACTIVE'                              -- freeze enforced HERE
   AND balance_poisha - reserved_poisha >= :amount    -- envelopes enforced HERE
```

Guard and mutation in **one atomic operation**. Application code never holds a balance in a variable, so the classic lost-update race is unrepresentable. `count === 0` means "no" — a business decision, never retried.

**The three numbers that must always hold** (checked by SQL views, verified after every demo):

| Invariant | View |
|---|---|
| Every ledger entry ever written sums to **0** | `ledger_conservation_check` |
| Every wallet's balance equals its ledger sum | `wallet_balance_drift` |
| Every wallet's reserved equals its envelope sum | `wallet_reservation_drift` |

---

## Run it

```bash
# Prerequisites: PostgreSQL 15+ on :5432, Redis on :6379, Node 22
cp .env.example .env          # fill DATABASE_URL, JWT_SECRET
npm install
npx prisma migrate deploy     # 6 migrations
npx prisma db seed            # 50 users, 100,000 BDT each — ISSUED, not assigned
npm run start:dev             # :3000

cd web && cp .env.example .env && npm install && npm run dev   # :5173
```

Then register at http://localhost:5173.

```bash
npm test          # 42 tests, no database or Redis needed
npm run typecheck # strict + noUncheckedIndexedAccess
```

---

## Architecture in one diagram

```
┌──────────────────────────────────────────────────────────────┐
│ L3  INFRASTRUCTURE   Prisma · ioredis · JWT · argon2id       │  ← knows everything
├──────────────────────────────────────────────────────────────┤
│ L2  ADAPTERS         Controllers · DTOs · repositories · SQL │
├──────────────────────────────────────────────────────────────┤
│ L1  APPLICATION      Use cases · PORTS · Transaction Engine  │  ← owns the interfaces
├══════════════════════════════════════════════════════════════┤
│ L0  DOMAIN           Money · errors · state machine          │  ← ZERO imports
└──────────────────────────────────────────────────────────────┘
      calls go DOWN  ·  source dependencies point UP
```

**The rule, and how it is checked:**

```bash
grep -rn "from '@prisma/client'\|from 'ioredis'" src/domain src/application   # must be empty
grep -rn "^import" src/domain                                                 # must be empty
```

`src/domain` genuinely has **zero imports**. That is why 42 tests run in seconds with no infrastructure.

---

## Where things live

```
src/
├── domain/                          L0 — pure, zero imports
│   ├── money/money.ts               BigInt poisha, exact arithmetic
│   └── errors/domain-errors.ts      typed errors + `retryable` flag
│
├── application/                     L1 — depends only on domain
│   ├── ports/                       ★ THE INTERFACES THIS LAYER OWNS
│   │   ├── repositories.port.ts       wallet, transaction, ledger, UoW, clock, ids
│   │   ├── query.port.ts              history reads, money requests, risk
│   │   ├── safety.port.ts             freeze, pots, envelopes
│   │   └── security.port.ts           password hashing, token issuing
│   ├── transaction-engine/          ★ THE CORE — read this first
│   │   ├── transaction.processor.ts     the 7 stages, one DB transaction
│   │   ├── transaction.validator.ts     pre-flight checks, participant resolution
│   │   ├── transaction-lock.service.ts  deadlock avoidance
│   │   ├── transaction.state-machine.ts 13 legal transitions out of 81
│   │   └── transaction-recovery.service.ts  reaper + reconciliation
│   ├── use-cases/                   one class per operation
│   └── services/                    audit · risk engine
│
├── adapters/http/                   L2 — controllers, DTOs, guards, filter
└── infrastructure/                  L3 — Prisma, Redis, security, health
```

**Reading order if you have 20 minutes:**
1. `transaction.processor.ts` — the whole money path, heavily commented
2. `prisma-wallet.repository.ts` → `debitIfSufficient` — the statement above
3. `transaction.state-machine.ts` — why a status field is not enough
4. `prisma/sql/hardening.sql` — the constraints that hold when code is wrong

---

## The 9 tables

| Table | What it is |
|---|---|
| `users` | Identity only. **No money columns at all.** |
| `wallets` | Balance *projection* + `reserved_poisha` + freeze status |
| `transactions` | The command record. Idempotency key. Never deleted. |
| **`ledger_entries`** | **Double-entry postings. THE source of truth.** Immutable. |
| `transaction_events` | Lifecycle timeline **and** transactional outbox |
| `money_requests` | A *claim*, never money |
| `wallet_security_events` | Append-only freeze/unfreeze history |
| `pots` + `pot_members` | Group collection. The pot **owns a wallet**. |
| `expense_envelopes` | Reserved capacity. **Moves no money.** |
| `audit_logs` | Who did what, from where |
| `risk_flags` | Explainable fraud detections |

**Three append-only logs, three different questions:**
`ledger_entries` = *where is the money?* · `transaction_events` = *what happened to this movement?* · `audit_logs` = *who did what?*

---

## The seven decisions that define this system

**1. Money is `BigInt` poisha.** 1 BDT = 100 poisha, `BIGINT` everywhere, never a float. `JSON.stringify(100n)` throws, so a global interceptor emits amounts as **strings** — the frontend never does arithmetic on them.

**2. The ledger is the truth; the balance is a cache.** Every movement writes two signed entries summing to zero. `wallets.balance_poisha` is maintained in the same transaction for O(1) reads. If they ever disagree, the ledger wins and the wallet is frozen.

**3. Pessimistic locks in canonical ID order.** `SELECT … FOR UPDATE ORDER BY id` — sorting removes the *possibility* of a deadlock cycle rather than detecting one after the fact. Two reciprocal transfers serialise instead of one being killed at random.

**4. Two-tier idempotency.** Redis `SET NX` absorbs ~99% of duplicate retries; `UNIQUE (initiator_user_id, idempotency_key)` is the **actual guarantee**. Redis can evict, fail over and restart — a unique index cannot. This is why a Redis outage degrades performance but never correctness.

**5. Business rejection ≠ infrastructure fault.** Insufficient funds *commits* a FAILED row (durable evidence) and is never retried. A lock timeout rolls back entirely, releases the idempotency key, and is retried up to 3× with jittered backoff. Conflating them turns one rejected payment into forty retries on a hot row.

**6. Envelopes reserve capacity, they do not move money.** `spendable = balance − reserved`, enforced by one extra clause in the debit. No ledger entry, no sub-wallet, no new reconciliation.

**7. Pots own a wallet.** No `currentAmount` counter — that would be a second money system outside the ledger's reconciliation. A contribution is an ordinary engine transfer, so pot money is covered by every existing invariant for free.

---

## API surface

| | Endpoint |
|---|---|
| **Auth** | `POST /auth/register` · `POST /auth/login` |
| **User** | `GET /users/profile` |
| **Wallet** | `GET /wallet` · `GET /wallet/balance` · `POST /wallet/send-money` |
| **Security** | `POST /wallet/freeze` · `POST /wallet/unfreeze` · `GET /wallet/security` |
| **Transactions** | `GET /transactions` (page/filter/sort) · `GET /transactions/:id` (+ timeline) |
| **Money requests** | `POST /money-requests` · `:id/accept` · `:id/reject` · `GET /money-requests` |
| **Envelopes** | `GET|POST /envelopes` · `:id/reserve` · `:id/unlock` · `DELETE :id` |
| **Pots** | `GET|POST /pots` · `POST /pots/join` · `GET /pots/preview/:code` · `:id/members` · `:id/contribute` · `:id/settle` |
| **Risk** | `GET /risk-flags` |
| **Health** | `GET /health/live` · `GET /health/ready` |

Every one is reachable from the UI. `GET /pots/:id` and `/money-requests/pending` exist but the UI uses the list endpoints instead — kept because they are the natural REST shape.

---

## Frontend

`web/` — React 18 · TypeScript · Tailwind · Vite. Seven pages: Wallet, Send, Transactions, Envelopes, Pots, Requests, Security, Monitor.

**The one rule:** every network call goes through `web/src/api/client.ts`. **No component calls `fetch`.** Verified:

```bash
grep -rn "fetch(" web/src --include=*.tsx | grep -v api/client   # must be empty
```

The frontend performs **no** balance arithmetic, **no** transaction rules and **no** authorisation. It has exactly one piece of protocol logic that legitimately belongs to it: **minting idempotency keys**, because only the client knows whether a retry is the same intent or a new one.

---

## Demo script (5 minutes, for judges)

1. **Register** → wallet opens with ৳100,000, *issued* from a genesis account so the ledger sums to zero from row one.
2. **Envelopes** → reserve ৳50,000 for Rent. Balance unchanged, spendable drops. Try to send more than spendable → refused.
3. **Send money** → confirm screen shows the idempotency key. Send the same key twice → one charge, same transaction id.
4. **Transaction detail** → 11 lifecycle events and two ledger postings summing to **0**.
5. **Pots** → create, share the invite code, others join and chip in. Every contribution is a real engine transfer.
6. **Security** → freeze the wallet. Outgoing blocked, **incoming still works**. Full history recorded.
7. **Monitor** → `docker stop redis`; transfers keep succeeding.

---

## Honest limitations

- **Concurrent transfers on one wallet fail above ~4 simultaneous requests** with 503s. Money stays correct (verified: conserved, never negative), but Prisma's interactive-transaction timeout fires under contention. Diagnosed — not lock contention, not pool size, not the libuv threadpool alone — **not yet fixed**.
- Single-primary write path. Sharding is designed (ARCHITECTURE.md §8 Phase 3), not built.
- `transaction_feed` read-model projection is deferred; history reads the ledger directly, which is correct well past a million rows per wallet.
- Risk flags are advisory below score 90; `UNDER_REVIEW` is reachable only from code, not from an admin UI.

---

## Documents

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, dependency rule, the transaction engine, scaling to 10M |
| [DATABASE.md](DATABASE.md) | Schema rationale, indexing, migrations, seeding |
| [ENGINE.md](ENGINE.md) | The 7 stages, concurrency control, failure handling |
| [REDIS.md](REDIS.md) | Idempotency, rate limiting, caching, degradation |
| [web/README.md](web/README.md) | Frontend architecture and API layer |

---

<sub>Goti · গতি — motion · PostgreSQL is the source of truth</sub>
