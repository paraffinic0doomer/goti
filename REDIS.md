# Goti — Redis Infrastructure Layer

> Implements the infrastructure concerns approved in [ARCHITECTURE.md](ARCHITECTURE.md) §3 (L3) and §8.
> NestJS · TypeScript · ioredis · PostgreSQL remains the source of truth.

| | |
|---|---|
| **Scope** | Redis integration, service abstraction, caching, idempotency foundation, rate limiting foundation |
| **Explicitly out of scope** | Transaction processing, money transfer workflow, frontend |
| **Status** | Typechecks clean under `strict` + `noUncheckedIndexedAccess`; 10/10 unit tests pass with no Redis running |

---

## Contents

1. [A correction before anything else](#1-a-correction-before-anything-else)
2. [Redis architecture](#2-redis-architecture)
3. [Design decisions](#3-design-decisions)
4. [Idempotency](#4-idempotency)
5. [Rate limiting](#5-rate-limiting)
6. [Caching](#6-caching)
7. [Redis CLI setup](#7-redis-cli-setup)
8. [Folder structure](#8-folder-structure)
9. [Testing commands](#9-testing-commands)
10. [Engineering explanation](#10-engineering-explanation)

---

## 1. A correction before anything else

The brief for this phase says Redis must guarantee:

> One request = One transaction.

**Redis cannot guarantee that, and the approved design already says so.** [DATABASE.md](DATABASE.md) line 217:

> `UNIQUE (initiator_user_id, idempotency_key)` is what turns a retried request into a no-op instead of a second payment. **Enforced by the database, never by a cache that can race with itself.**

### Why Redis alone is unsafe here

Even with `SET NX` making the check-and-write atomic, three ordinary Redis events destroy the guarantee:

| Event | Consequence |
|---|---|
| Key evicted under `maxmemory` pressure | Retry finds no key → **second payment** |
| Failover to a replica that had not yet received the write (async replication) | Retry finds no key → **second payment** |
| Restart without persistence, or an AOF/RDB gap | Retry finds no key → **second payment** |

None of these is exotic. All three are normal operating events for a cache. A unique index in PostgreSQL has none of them.

### The correction: two tiers, not one

```
Request
   │
   ├── Tier 1 — Redis  ......  fast path. Absorbs ~99% of duplicate retries
   │                            without touching the database. May fail.
   │
   └── Tier 2 — PostgreSQL ..  UNIQUE (initiator_user_id, idempotency_key)
                                THE guarantee. Never optional, never skipped.
```

Redis does real, valuable work — it stops duplicate requests from reaching the transaction engine at all, which is what protects the database under a retry storm. It is simply not the thing that makes the guarantee true.

**This correction is what makes every other failure policy in this document possible.** Because tier 2 is the guarantee, a Redis outage can safely fail *open* — the system keeps moving money, correctly, using PostgreSQL alone. In a Redis-only design a cache outage would have to become a payments outage.

Implemented in [`redis-idempotency.adapter.ts`](src/infrastructure/redis/adapters/redis-idempotency.adapter.ts); the `DEGRADED` outcome is that policy made explicit in the type system.

### A second, smaller correction: the TTL splits in two

The brief specifies a 24-hour TTL. Applied to the `PROCESSING` state, that would mean **a process that crashes mid-transfer holds the key for a full day**, rejecting the user's legitimate retry the entire time — a self-inflicted outage on one key, invisible until someone complains.

So the TTL follows what the value actually *is*:

| State | TTL | Because it is |
|---|---|---|
| `PROCESSING` | 60s | a **lock** — must outlive a normal transaction, expire soon after a crash |
| `COMPLETED` / `FAILED` | 24h | a stored **answer** — must survive long enough to replay to any realistic retry |

The 24-hour requirement is preserved exactly where it matters: replaying the outcome of a finished request.

---

## 2. Redis architecture

### Where Redis sits

```
┌──────────────────────────────────────────────────────────────────┐
│  L2  Controllers                                                  │
│      Receive · validate · respond. No Redis, no business logic.   │
└──────────────────────────────────────────────────────────────────┘
                              │ calls
┌──────────────────────────────────────────────────────────────────┐
│  L1  Application — use cases                                      │
│      Depends on PORTS only:                                       │
│        CachePort · IdempotencyPort · RateLimiterPort              │
│      Does not know Redis exists.                                  │
└──────────────────────────────────────────────────────────────────┘
                              ▲ implements
┌──────────────────────────────────────────────────────────────────┐
│  L3  Infrastructure                                               │
│      RedisCacheAdapter · RedisIdempotencyAdapter                  │
│      RedisRateLimiterAdapter                                      │
│                     │ all go through                              │
│                RedisService  ──────►  ioredis  ──────►  Redis     │
└──────────────────────────────────────────────────────────────────┘
```

**The rule that keeps this clean:** `ioredis` is imported in exactly two files — `redis.module.ts` (to construct the client) and `redis.service.ts` (to use it). Nothing else in the codebase knows Redis exists.

A use case that injected `RedisService` would violate the Dependency Rule and become untestable without a live Redis. It is greppable:

```bash
# Must return nothing. Anything here is an architecture violation.
grep -rn "ioredis\|RedisService" src/application src/domain
```

### Why an owned module rather than a community wrapper

`@nestjs-modules/ioredis` and `@liaoliaots/nestjs-redis` are reasonable packages. Goti does not use them because it needs `SET NX`, server-side Lua, `SCAN`, precise timeout tuning, and deterministic shutdown ordering — exactly the things a wrapper abstracts away — and because a wrapper is a dependency that must track NestJS releases forever. **Roughly forty lines we own is a better trade than a package we do not.**

---

## 3. Design decisions

| Decision | Choice | Why |
|---|---|---|
| Redis client | `ioredis` directly, in an owned module | Lua, `SET NX`, `SCAN`, cluster-ready, full lifecycle control |
| Abstraction | Three narrow ports, not one fat `RedisService` interface | Each port is the smallest surface its consumer needs; a fat interface leaks infrastructure upward |
| `enableOfflineQueue` | **`false`** | Default `true` buffers commands during an outage so they resolve *late*. A 1 ms cache lookup would hang until reconnect, holding a request the whole time. Redis is optional to correctness, so failing fast is strictly better than waiting |
| Failure handling | Circuit breaker, 5 failures → 10 s open | Without it every request pays a full timeout while Redis is down, turning a cache incident into an application-wide latency incident |
| Serialization | JSON with a BigInt replacer/reviver | Money is `BigInt` poisha. `JSON.stringify(100n)` **throws** — caching a real balance would crash at runtime without this |
| Key construction | One builder module, no inline strings | A key built differently by writer and reader fails *silently*, which on a money path is the worst failure mode |
| Deletion | `UNLINK`, not `DEL` | `UNLINK` reclaims memory on a background thread. On the write path, where invalidation happens, that is the difference between an eviction and a latency spike for every other client |
| Key enumeration | `SCAN` only; `KEYS` banned | See [§7](#why-keys-is-banned) |
| Health probe | Degraded Redis returns **200** | A failing readiness probe would pull every healthy pod from the load balancer over a cache outage |

### Failure policy, per concern

Different concerns get different answers, because the cost of being wrong differs:

| Concern | Policy | Reasoning |
|---|---|---|
| Cache | **Fail open** → miss | A miss reads PostgreSQL, which is the truth. No wrong answer is possible |
| Rate limiting | **Fail open** + per-instance fallback | Rejecting real transfers to defend against hypothetical abuse turns a cache outage into an outage. The limiter protects capacity, not correctness |
| Idempotency | **Fail open** → `DEGRADED` | Safe *only* because the database unique constraint is the guarantee |

**Every path degrades performance. No path degrades correctness.**

---

## 4. Idempotency

### The problem

A user taps "Send Money". The response is slow. They tap again. Or the mobile client auto-retries on timeout. Or a flaky network duplicates the request. Without protection, one intent becomes two transfers.

### Key format

```
transaction:idempotency:{userId}:{requestId}
```

Scoped by user as well as request id. Idempotency keys are **client-generated**, so two users can legitimately pick the same string — and with an unscoped key, one user's retry would replay *the other user's transaction*. The scoping mirrors the database's `UNIQUE (initiator_user_id, idempotency_key)` exactly, because the two tiers must agree on what "the same request" means.

### Stored value

```json
{ "status": "PROCESSING", "transactionId": "txn_123", "startedAt": "2026-08-29T11:04:00.000Z" }
```

then on completion:

```json
{ "status": "COMPLETED", "transactionId": "txn_123", "completedAt": "...", "result": { } }
```

### Lifecycle

```
Incoming request with Idempotency-Key
             │
             ▼
   SET NX key {PROCESSING} EX 60      ← atomic: check and write in ONE step
             │
    ┌────────┴────────┐
    │                 │
 RESERVED        key existed
    │                 │
    │            GET the record
    │                 │
    │        ┌────────┴────────┐
    │   PROCESSING          COMPLETED / FAILED
    │        │                 │
    │    409 Conflict      Replay stored result
    │    "in progress"     (no money moves)
    │
    ▼
Transaction Engine
  → tier 2: UNIQUE (initiator_user_id, idempotency_key)
             │
      ┌──────┴──────┐
   success        constraint violation
      │                 │
 complete()        return original transaction
 (24h TTL)
```

### Why `SET NX` and not `GET` then `SET`

A read followed by a write is a race. Two concurrent retries both read "missing", both write, both proceed — a double payment. `SET NX` collapses check and write into one atomic server-side operation.

This is the same shape as the conditional balance update in ARCHITECTURE.md §5 Stage 3: *never read-modify-write on a contended value; make the database do check-and-set in one step.*

### Why Redis suits this problem

- **O(1) lookup with automatic expiry.** TTL is native — no sweeper job, no `DELETE FROM ... WHERE created_at <` cleanup.
- **Atomic conditional write** as a single primitive.
- **Shared across every API instance.** An in-process map would not catch a retry routed to a different replica — which, behind a load balancer, is most of them.
- **Cheap.** A rejected duplicate costs one round trip instead of a database transaction, two row locks and a ledger write.

### Why the database alone is not *efficient* enough

It is sufficient for **correctness** — and it stays the guarantee. But as the *only* mechanism, every duplicate would:

1. open a PostgreSQL transaction,
2. take a connection from the bounded pool,
3. attempt the insert,
4. fail on the constraint,
5. roll back.

Under a retry storm — a mobile client retrying on a flaky network, or a UI bug — that is thousands of pointless transactions competing for connections with real payments. **Redis absorbs them before they reach the database.** That is a throughput argument, not a correctness one, and it is exactly the right job for a cache.

### How this prevents double transactions

Four independent layers, mirroring the defence-in-depth from ARCHITECTURE.md §5:

1. `SET NX` — atomic reservation, no read-modify-write race.
2. `PROCESSING` state → 409, so a concurrent duplicate is never admitted.
3. `UNIQUE (initiator_user_id, idempotency_key)` — the guarantee, immune to eviction and failover.
4. `UNIQUE (transaction_id, wallet_id, direction)` on `ledger_entries` — even a request that somehow passed 1–3 cannot post the same leg twice.

---

## 5. Rate limiting

### Strategy: sliding window counter

Three options were considered.

| Strategy | Memory per user | Boundary burst | Verdict |
|---|---|---|---|
| Fixed window | O(1) — one integer | **Yes — 2× the limit** | Rejected |
| Sliding window log | O(requests) — a ZSET entry per request | No | Rejected |
| **Sliding window counter** | **O(1) — two integers** | **No** | **Selected** |

**Why not fixed window.** 100 requests at 11:59:59 plus 100 at 12:00:00 is 200 transfers in two seconds, every one of them "within limit". For a money endpoint that is precisely the abuse pattern the limit exists to stop.

**Why not sliding window log.** Exact, but stores a timestamp per request: 100 entries per active user per window. At 800k daily actives ([ARCHITECTURE.md §8](ARCHITECTURE.md)) that is tens of millions of sorted-set members to store and trim — precision we do not need at a cost that scales with traffic.

**How the selected strategy works.** Two counters — current window and previous — with the previous weighted by how far into the current window we are:

```
estimated = previous × (1 − elapsedRatio) + current
```

45 seconds into a 60-second window, 25% of the previous window still counts.

### Advantages

- **Constant memory per user**, regardless of request volume.
- **No boundary burst** — the limit is smooth across window edges.
- **Self-expiring.** The window index is part of the key, so old windows simply age out. Nothing to reset, no sweeper to run.
- **Atomic.** The whole read-compute-increment runs as one Lua script. Separate round trips would let concurrent requests all read the same under-limit value and all be admitted — a rate limiter with a race is a rate limiter an attacker walks through.

### Limitations — stated plainly

It is an **approximation**. It assumes the previous window's requests were spread evenly, so a burst concentrated at that window's *start* is over-counted and one at its *end* is under-counted — by a few percent in practice.

For protecting backend capacity, that error is irrelevant. **It would not be acceptable for a financial quota** such as a daily transfer ceiling. That belongs in PostgreSQL, where it can be exact, durable and auditable. The distinction matters: this limiter protects the *server*, not the *money*.

### How it protects backend stability

A single faulty or malicious client can otherwise exhaust the PostgreSQL connection pool, saturate the transaction engine's row locks, and starve every other user. Rejecting at the edge costs one Redis round trip; admitting the request costs a database transaction and two wallet locks. The limiter converts an expensive failure into a cheap one — and returns `Retry-After` so a well-behaved client backs off instead of hammering.

---

## 6. Caching

### Read strategy — read-through with stampede protection

```
Request
   │
   ▼
Check Redis ──── hit ────► return cached
   │
  miss
   │
   ├── Is an identical load already running in this process?
   │        yes → await it (single-flight)
   │
   ▼
Query PostgreSQL  ← the source of truth
   │
   ▼
Store in Redis with TTL + jitter
   │
   ▼
Return
```

**Single-flight** matters: when a hot key expires, every concurrent request misses simultaneously and stampedes the database. Without it, adding a cache makes database load *spikier* than having none. **TTL jitter** prevents keys written together from expiring together on a repeating cycle.

### Invalidation — delete, never update

**On every write that changes wallet state, delete the wallet's cache keys.**

```ts
await cache.invalidate(...RedisKeys.allWalletCacheKeys(walletId));
```

Writing the new balance into the cache looks more efficient and is **unsafe**. Two concurrent transfers can interleave so the *slower* transaction writes its older balance last, leaving a stale value that survives until TTL — a wrong balance shown to the user, with no error anywhere.

Deleting has no such ordering hazard: the worst outcome is a miss, and a miss reads the truth.

**Known limitation, bounded deliberately.** A read that misses, is descheduled, and writes back after a concurrent invalidation can still cache a stale value. The 5-second balance TTL is the bound on that window. A version-stamped key would close it entirely; at these TTLs it is not worth the complexity, and this is documented rather than hidden.

### Why the balance TTL is only 5 seconds

Honest assessment: **caching a wallet balance is barely worth it.** The underlying query is a primary-key lookup PostgreSQL answers in well under a millisecond. The cache saves a network round trip and a connection-pool slot — real under load, but not dramatic.

What it *risks* is showing a user a stale balance, which in a money app is a support ticket. So the TTL is small enough that staleness is imperceptible, and:

> **The cached balance is DISPLAY ONLY. The Transaction Engine never reads it.**

Authorisation reads the balance from PostgreSQL inside the row lock, via the conditional atomic update (ARCHITECTURE.md §5 Stage 3). A cached balance must never be allowed to authorise a debit.

### Why permanently storing balances in Redis would be dangerous

This is the question the brief asks, and it deserves a direct answer. Redis would have to become the source of financial truth, and it fails every requirement that role has:

| Requirement | PostgreSQL | Redis as truth |
|---|---|---|
| **Durability** | WAL, `fsync`, crash-safe | Async persistence. `appendfsync everysec` loses **up to a second of writes** on crash. That second is somebody's money |
| **Atomic multi-key** | Full ACID; debit + credit + 2 ledger rows + outbox commit or roll back together | `MULTI`/Lua is atomic but has **no rollback**. A mid-script failure leaves partial state permanently |
| **Constraints** | `CHECK (balance_poisha >= 0)` refuses a negative balance even if every layer above is buggy | No constraints. A bug writes a negative balance and Redis stores it happily |
| **Eviction** | Never discards committed rows | Under `maxmemory`, keys are **evicted by policy**. A balance can simply vanish |
| **Replication** | Synchronous options; failover does not lose acknowledged commits | **Asynchronous.** Failover silently loses recent writes |
| **Auditability** | Immutable double-entry ledger; `SUM = 0` provable at any moment | No history. "Why is this balance 4,300?" has no answer |
| **Query** | Reconciliation, history, joins | Key-value. No `SUM`, no `GROUP BY`, no reconciliation |

**The decisive one is eviction.** Redis is *designed* to discard data under memory pressure. A datastore whose documented behaviour includes deleting your keys cannot hold the record of what someone owns.

There is also no way to detect the loss. ARCHITECTURE.md §5's reconciliation works because the ledger is immutable and complete — `SUM(ledger_entries) == balance`, checked nightly. If the balance lived in Redis and was silently evicted, the wrong value would be authoritative and there would be nothing to compare it against.

**Redis holds copies and coordination state. PostgreSQL holds the truth. That direction never reverses.**

---

## 7. Redis CLI setup

### Installation

```bash
# macOS
brew install redis
brew services start redis

# Ubuntu / Debian / WSL
sudo apt update && sudo apt install -y redis-server
sudo systemctl enable --now redis-server

# Docker — recommended for Windows and for parity with production
docker run -d --name goti-redis -p 6379:6379 redis:7-alpine \
  redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
```

The Docker flags are deliberate: `--appendonly yes` gives persistence across restarts, and `allkeys-lru` makes eviction behaviour explicit in development rather than a production surprise.

### Connect

```bash
redis-cli                       # local default
redis-cli -h HOST -p 6379 -a PASSWORD
docker exec -it goti-redis redis-cli
redis-cli PING                  # → PONG
```

### The five commands

```bash
# SET — create a key. EX sets a TTL in seconds.
SET transaction:idempotency:123 PROCESSING EX 86400
# → OK

# GET — read the value.
GET transaction:idempotency:123
# → "PROCESSING"

# TTL — remaining lifetime in seconds.
TTL transaction:idempotency:123
# → (integer) 86391
#   -1 = exists, never expires    -2 = key does not exist

# DEL — delete a key, returns how many were removed.
DEL transaction:idempotency:123
# → (integer) 1

# KEYS — pattern search. DO NOT USE IN PRODUCTION (see below).
KEYS transaction:idempotency:*
```

| Command | Purpose |
|---|---|
| `SET` | Creates a key, optionally with an expiry |
| `GET` | Retrieves the stored value |
| `TTL` | Shows remaining time to live |
| `DEL` | Deletes a key |
| `KEYS` | Searches keys by pattern |

### The command that makes idempotency work

```bash
# NX = set only if the key does not exist. Atomic check-and-write.
SET transaction:idempotency:user-a:GOTI_TXN_001 '{"status":"PROCESSING"}' EX 60 NX
# → OK        first caller wins

SET transaction:idempotency:user-a:GOTI_TXN_001 '{"status":"PROCESSING"}' EX 60 NX
# → (nil)     duplicate rejected — no second transaction
```

### Why `KEYS` is banned

`KEYS` scans the **entire keyspace** — O(N) — and Redis executes commands on a **single thread**. With millions of keys it blocks the server for seconds, during which *every other client waits*: the idempotency check on a live payment, every rate limit decision, every cache read. One diagnostic command becomes a site-wide stall.

Use `SCAN`, which is cursor-based and bounded per call, letting the server serve other clients between batches:

```bash
# Safe: iterate in bounded batches.
redis-cli --scan --pattern 'goti:dev:transaction:idempotency:*' --count 100

# Safe bulk delete — UNLINK frees memory on a background thread.
redis-cli --scan --pattern 'goti:dev:cache:wallet:*' | xargs -L 100 redis-cli UNLINK
```

| | `KEYS` | `SCAN` |
|---|---|---|
| Complexity | O(N), one shot | O(1) per call, cursor |
| Blocks the server | **Yes** | No |
| Guarantee | Perfect snapshot | May return duplicates; will not miss a key present throughout |
| Production safe | **No** | Yes |

`RedisService` exposes only `scanKeys()`, an async generator. **`KEYS` appears nowhere in the codebase** — and because `ioredis` is importable in only two files, it cannot be reintroduced casually.

---

## 8. Folder structure

```
goti/
├── prisma/                              (unchanged from the previous phase)
│   ├── schema.prisma
│   ├── seed.ts
│   └── sql/hardening.sql
│
├── src/
│   ├── main.ts                          NEW  bootstrap, validation, shutdown hooks
│   ├── app.module.ts                    NEW  composition root (L3)
│   │
│   ├── config/
│   │   └── redis.config.ts              NEW  typed, validated config — no magic numbers
│   │
│   ├── application/
│   │   └── ports/                       NEW  L1 — interfaces the application OWNS
│   │       ├── cache.port.ts
│   │       ├── idempotency.port.ts
│   │       ├── rate-limiter.port.ts
│   │       └── index.ts
│   │
│   └── infrastructure/                  NEW  L3
│       ├── redis/
│       │   ├── redis.module.ts               DI wiring, ioredis client factory
│       │   ├── redis.service.ts              the ONLY Redis abstraction
│       │   ├── redis.service.spec.ts         10 tests, no Redis required
│       │   ├── redis.constants.ts            injection tokens, namespaces
│       │   ├── redis.keys.ts                 every key built in one place
│       │   ├── redis.errors.ts               typed infrastructure failures
│       │   ├── redis.health.ts               degraded ≠ unhealthy
│       │   └── adapters/                     ports → Redis
│       │       ├── redis-cache.adapter.ts
│       │       ├── redis-idempotency.adapter.ts
│       │       └── redis-rate-limiter.adapter.ts
│       └── health/
│           └── health.controller.ts      /health/live · /health/ready
│
├── .env.example                         NEW  every tunable, documented
├── .gitignore                           NEW
├── package.json                         NEW
└── tsconfig.json                        NEW  strict + noUncheckedIndexedAccess
```

---

## 9. Testing commands

### Setup

```bash
cp .env.example .env
npm install
npx prisma generate
```

### Verify the code

```bash
npm run typecheck    # strict TypeScript, zero errors
npm test             # 10 tests, no Redis needed
npm run build        # compiles to dist/
```

The unit tests run **with no Redis and no database** — that is the port boundary paying off. They cover BigInt round-tripping, cache-miss vs failure, `SET NX` outcomes, circuit-breaker opening, and the rate limiter's fail-open policy.

### Verify against a live Redis

```bash
docker run -d --name goti-redis -p 6379:6379 redis:7-alpine
npm run start:dev

curl localhost:3000/health/live
curl localhost:3000/health/ready | jq
# → dependencies.redis.status: "up", latencyMs: 1
```

### Prove idempotency by hand

```bash
redis-cli
> SET goti:dev:transaction:idempotency:u1:TXN_001 '{"status":"PROCESSING"}' EX 60 NX
OK
> SET goti:dev:transaction:idempotency:u1:TXN_001 '{"status":"PROCESSING"}' EX 60 NX
(nil)          ← duplicate rejected
> TTL goti:dev:transaction:idempotency:u1:TXN_001
(integer) 57
```

### Prove graceful degradation — the important one

```bash
# With the app running against a healthy Redis:
docker stop goti-redis

curl localhost:3000/health/ready | jq
# → status: "ok"                      ← still serving
# → dependencies.redis.status: "degraded"
# → dependencies.redis.circuitOpen: true

docker start goti-redis
curl localhost:3000/health/ready | jq
# → dependencies.redis.status: "up"   ← recovers on its own
```

The application stays up and stays correct with Redis gone. **That is the single most important property of this layer.**

### Watch what the app does to Redis

```bash
redis-cli MONITOR                 # live command stream — dev only, it is costly
redis-cli INFO stats | grep keyspace
redis-cli --scan --pattern 'goti:dev:*' | head -20
```

---

## 10. Engineering explanation

### 1. Why Redis exists in Goti

To keep expensive, repetitive work away from the one component that must never be overwhelmed: the PostgreSQL primary that owns every balance. It does three jobs — deduplicate retries, throttle abuse, cache hot reads — and all three are about **protecting the write path**, which ARCHITECTURE.md §8 identifies as the binding constraint.

### 2. Why Redis does not store financial truth

Because Redis is designed to lose data: it evicts under memory pressure, persists asynchronously, and replicates asynchronously. It has no `CHECK` constraints, no rollback, and no history to reconcile against. Full comparison in [§6](#why-permanently-storing-balances-in-redis-would-be-dangerous).

The one-line version: **a datastore whose documented behaviour includes deleting your keys cannot hold the record of what someone owns.**

### 3. How Redis improves scalability

- **Removes duplicate work before it reaches the database.** A rejected retry costs one round trip instead of a transaction, two row locks and a ledger write.
- **Absorbs the 25:1 read majority** (ARCHITECTURE.md §8) so balance and history reads do not contend with money movement.
- **Protects the connection pool**, which DATABASE.md identifies as the real ceiling — not CPU. Every request Redis answers is a pool slot left for a payment.
- **Keeps the API tier stateless**, so it still scales linearly by replica count.

### 4. How Redis helps handle millions of users

At the modelled load — 800k daily actives, ~2,200 TPS at an Eid spike, ~55,000 read QPS — the numbers that matter are:

| Pressure | Without Redis | With Redis |
|---|---|---|
| Duplicate retries during a network incident | Every one is a DB transaction | Rejected in ~0.5 ms, DB untouched |
| Abuse burst from one client | Saturates the pool, starves real users | Rejected at the edge |
| Balance reads | 55,000 QPS at the database | Served from memory |

Rate limiting is what stops **one** bad client from degrading service for the other **9,999,999**.

### 5. How Redis supports future transaction reliability

The seams are in place for later phases without any of them being built prematurely:

- `IdempotencyPort` is already the front door of the transaction engine — the engine plugs in behind it.
- Redis pub/sub or streams can carry outbox delivery notifications, so the worker reacts in milliseconds instead of waiting for its poll interval. The `transaction_events` outbox stays the durable record.
- Distributed locks (`SET NX` with a fencing token) are available if a future workflow needs coordination beyond a single database transaction.
- Hot-wallet command queueing — the mitigation DATABASE.md names for the real scaling wall — has a natural home here.

### 6. What happens if Redis becomes unavailable

**Nothing that affects correctness.** By concern:

| Concern | Behaviour | User impact |
|---|---|---|
| Idempotency | `DEGRADED` → falls through to the PostgreSQL unique constraint | None. Duplicates still rejected, slightly more DB load |
| Rate limiting | Fails open + per-instance fallback counter | None for legitimate users; abuse protection weakens |
| Cache | Every read is a miss → PostgreSQL | Marginally higher latency |
| Health | `/health/ready` returns **200** with `redis: degraded` | None — pods stay in the load balancer |

Money keeps moving, correctly. The circuit breaker means requests do not even pay a timeout: after 5 consecutive failures Redis is skipped for 10 seconds, then one probe is let through.

**This is only true because of the correction in [§1](#1-a-correction-before-anything-else).** With Redis as the sole idempotency mechanism, this row would read "reject all transfers" — a cache outage becoming a payments outage.

### 7. Fallback strategy

| Layer | Mechanism |
|---|---|
| **Detect** | Circuit breaker opens after 5 consecutive failures; health endpoint reports `degraded` |
| **Degrade** | Per-concern policy, all fail-open; `degraded: true` on every affected response so dashboards distinguish "no traffic" from "no visibility" |
| **Contain** | `enableOfflineQueue: false` and a 1 s command timeout stop requests piling up behind a dead socket |
| **Recover** | Exponential backoff **with jitter**, so 200 replicas do not reconnect in the same millisecond and stampede a recovering server; `reconnectOnError` handles `READONLY` after a failover |
| **Backstop** | In-process fallback rate limiter caps a single client per instance while Redis is gone |
| **Alert** | `redis: degraded` is a page, not a restart. The system is working; something needs a human |

**The principle throughout: Redis failing degrades performance. Nothing about Redis failing may degrade correctness.**

---

<sub>Goti · গতি — motion · Redis infrastructure rev 2026-08-29 · Implements ARCHITECTURE.md §3 (L3) · PostgreSQL remains the source of truth</sub>
