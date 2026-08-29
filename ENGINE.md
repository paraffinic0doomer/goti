# Goti — Transaction Engine

> The only component permitted to change a balance.
> Implements ARCHITECTURE.md §5 · NestJS · Prisma · PostgreSQL · Redis fast path.

| | |
|---|---|
| **Guarantee** | Money never disappears · money never duplicates · every movement has a traceable lifecycle |
| **Status** | Typechecks clean under `strict`; 31/31 tests pass with no database and no Redis; build OK |
| **Boundaries verified** | `src/domain` has **zero imports**; no Prisma or ioredis under `src/domain` or `src/application`; raw SQL confined to two infrastructure files |

---

## 1. Three conflicts with the brief, and how they were resolved

The brief asked for things the approved design already answers differently. Each is resolved below rather than silently overridden.

### 1.1 The requested states do not fit the persisted enum

The brief specifies `CREATED → VALIDATING → VALIDATED → PROCESSING → COMPLETED / FAILED / CANCELLED`. The schema's `TransactionStatus` has four values — `PENDING, COMPLETED, FAILED, REVERSED` — and `hardening.sql` installs a trigger that guards transitions between exactly those.

**Resolution: two levels of state, not one.**

| | Values | Where it lives | What it is |
|---|---|---|---|
| `TransactionStatus` | 4 | `transactions.status` column | The **durable checkpoint**. Trigger-guarded. |
| `TransactionPhase` | 9 | `transaction_events` rows | The **fine-grained timeline**. |

Promoting every phase to a column `UPDATE` would mean five extra round trips *inside the money transaction*, extending lock hold time on the hottest rows in the system to store information nobody reads synchronously. Instead the engine accumulates phases in memory and writes them in **one batched insert** before commit.

The brief's requirement — "every state transition must be stored" — is met in full, atomically, at a fraction of the lock cost.

### 1.2 `CANCELLED` is not reachable today

There is no synchronous path to it. A transfer either completes or fails inside one database transaction, so no window exists in which a caller can abandon one.

It is modelled anyway, as a terminal phase with zero outgoing edges, because scheduled and future-dated transfers will reach it — and leaving a legal terminal state out of the machine is how it later gets bolted on wrongly. It is documented as reserved rather than quietly wired to nothing.

### 1.3 The engine belongs in the application layer, not at `src/`

ARCHITECTURE.md §4 classifies the Transaction Engine as `L1 · APPLICATION`. It lives at `src/application/transaction-engine/` with the exact file names requested, because the layer boundary is enforced **by path**:

```bash
grep -rn "from '@prisma/client'\|from 'ioredis'" src/domain src/application
# must return nothing
```

A top-level `src/transaction-engine/` would sit outside that check, and a rule that cannot be checked is a rule that erodes.

---

## 2. Why a state machine beats status updates

A plain status field makes **every** transition legal. Nothing stops:

```ts
transaction.status = 'COMPLETED';   // on a transfer that was already rejected
```

That single assignment pays out money the system said no to. The danger is not that someone writes it deliberately — it is that with 9 phases there are **81 possible assignments and only 13 are correct**, so the wrong ones are reachable by ordinary mistakes: a retry handler, a stale object written back, a merge that reorders two lines.

A state machine inverts the default. Transitions are **data** — an explicit table of edges — and everything absent from that table is rejected.

| | Plain status field | State machine |
|---|---|---|
| Legal transitions | All 81 | 13, enumerated |
| Resurrect a `FAILED` transfer | Allowed | Throws |
| Complete twice | Allowed | Throws |
| Skip validation | Allowed | Throws |
| Where the lifecycle is defined | Spread across every service | One table |
| Testable without a database | No | Yes, in microseconds |

Terminal states have **empty arrays** — that is the point of the table. `FAILED`, `CANCELLED` and `REVERSED` have no outgoing edges at all; `COMPLETED` has exactly one, to `REVERSING`, because compensation is a deliberate operation that writes *new* opposite postings and never mutates history.

**Defence in depth:** this machine guards transitions in the application; `goti_guard_transaction_write` guards the same rules inside PostgreSQL. Bypass the engine entirely and the database still refuses — the same layering ARCHITECTURE.md §5 applies to balances.

---

## 3. The transfer workflow

All fifteen steps, and where each runs:

```
OUTSIDE any database transaction
  ├─ Rate limit check                        Redis, fails open
  ├─ 1. Receive request
  ├─ TIER 1 IDEMPOTENCY — Redis SET NX
  │     REPLAY   → return the stored result, no money moves
  │     IN_FLIGHT→ 409, do NOT start a second transaction
  │     DEGRADED → proceed; tier 2 is the guarantee
  ├─ 7. Mint transaction id (UUIDv7)
  ├─ 2. Validate request data
  ├─ 5. Validate amount           ← free, rejects the commonest bad input first
  ├─ 3. Verify sender exists + active
  ├─ 4. Verify receiver exists + active
  └─ Currency and self-transfer checks

INSIDE ONE POSTGRESQL TRANSACTION  ── all of it commits, or none of it does
  ├─  8. INSERT transaction PENDING     ← TIER 2 IDEMPOTENCY (unique index)
  ├─  9. SELECT … FOR UPDATE ORDER BY id   ← both wallets, canonical order
  │      └─ re-check wallet status under the lock
  ├─  6. UPDATE … WHERE balance >= amount  ← THE balance check
  ├─ 10.    ↳ affected 0 rows → commit a FAILED record, no ledger entries
  ├─ 11. Credit receiver
  ├─ 12a. INSERT 2 ledger entries, summing to zero
  ├─ 15. UPDATE transaction → COMPLETED
  ├─ 12b. INSERT all timeline events    ← ONE batched statement
  ├─ 13. INSERT audit row
  └─ 14. COMMIT

AFTER COMMIT — failure here cannot corrupt money
  ├─ Store idempotency result (24h)
  └─ Invalidate wallet caches (delete, never update)
```

### Why every balance update must be in one transaction

Without it, "debit sender" and "credit receiver" are two independent writes with a **window** between them. Anything that interrupts that window — a crash, a network partition, a pod killed during deploy, an unhandled exception — leaves money debited and never credited.

It has **vanished**. No error surfaces it. The sender is simply poorer, and only a customer complaint reveals it.

Compensating afterwards does not fix this. A "credit it back" step is itself a write that can fail, and now there are two ways to be wrong instead of one.

Inside a transaction the question does not arise. PostgreSQL's write-ahead log makes the whole set atomic: **either every write is durable, or none is.** There is no state in which the debit exists without the credit — not for a microsecond, not during crash recovery, not after a hard power loss.

The ledger entries, the timeline and the audit row are inside the same boundary for the same reason. A transfer whose ledger did not commit would be money that moved without a record, which is indistinguishable from a bug.

---

## 4. Concurrency control

### The race, precisely

```
Balance: 1000.  A sends 700, B sends 600, simultaneously.

  A: read balance → 1000          B: read balance → 1000
  A: 1000 ≥ 700, ok               B: 1000 ≥ 600, ok
  A: write 300                    B: write 400

Both succeed. 1300 left a wallet holding 1000.
```

The defect is the **gap between reading a balance and acting on it**. Any design that reads a balance into application memory and later spends against that read has this bug, however carefully written.

### Selected: pessimistic locking — with an important nuance

| | Optimistic | **Pessimistic (selected)** |
|---|---|---|
| Mechanism | `version` column, CAS, retry on conflict | `SELECT … FOR UPDATE` before deciding |
| Low contention | Excellent — nobody waits | Slight lock overhead |
| **High contention** | **Degrades — retries rise, each redoes the whole transaction; worst case is livelock** | Bounded, stable, fair |
| A rejection is… | A retry, arriving late after wasted work | Final on the first attempt |

Contention in a wallet system is **concentrated, not uniform**: payroll accounts, merchants, and any wallet in a viral moment take many concurrent writes. Optimistic control degrades exactly there — under the load it most needs to survive.

**The actual design is a hybrid, and that matters.** The lock alone does not enforce sufficiency; it only serialises. Sufficiency is the conditional atomic update:

```ts
const { count } = await tx.wallet.updateMany({
  where: { id, status: 'ACTIVE', balancePoisha: { gte: amount } },  // the guard
  data:  { balancePoisha: { decrement: amount } },                  // the mutation
});
if (count === 0) { /* insufficient funds — a decision, never retried */ }
```

One statement. The database evaluates guard and mutation together. **At no point does application code hold a balance in a variable and spend against it** — which is exactly why the race above cannot occur.

`updateMany`, not `update`: `update` throws when the where-clause misses, conflating "insufficient funds" with "wallet does not exist". The count is the distinction we need.

Under Read Committed, PostgreSQL **re-evaluates the `WHERE` clause against the newest committed row version** when it meets a concurrently-modified row. The guard therefore can never be decided on stale data — which is why Serializable would add abort-retry cycles for no additional guarantee.

### Deadlock avoidance

```
Arrival order:   T1 holds A wants B,  T2 holds B wants A   → cycle, random abort
Ascending id:    both sort {A,B}, take A first             → T2 waits, no cycle
```

Sorting removes the **possibility** of a cycle rather than detecting one after the fact. The sort happens inside `PrismaWalletRepository.lockForUpdate` — not requested from callers, because a rule enforced only by convention is one a new code path eventually skips.

### Trade-offs accepted

- Per-wallet throughput is capped by lock hold time. Mitigated by keeping the critical section to four statements and validating outside it.
- A held lock blocks other `FOR UPDATE` readers. Plain reads — balance display, history — are unaffected; MVCC serves them from the last committed snapshot.
- A hot wallet is a hard ceiling. DATABASE.md names the mitigation for that day: sub-balances that reconcile to one.

---

## 5. Idempotency

### Two tiers

```
Tier 1  Redis SET NX   →  absorbs ~99% of duplicates before they reach Postgres.
                          May be evicted, lost in failover, lost on restart.
Tier 2  UNIQUE (initiator_user_id, idempotency_key)
                       →  THE guarantee. None of those failure modes.
```

Full reasoning in [REDIS.md §1](REDIS.md). The short version: Redis alone cannot guarantee "one request = one transaction", because a cache is *designed* to lose data. The database constraint is the guarantee; Redis spares it the load.

### Behaviour for `requestId: ABC123`

| Arrival | Path | Result |
|---|---|---|
| 1st | Redis `SET NX` wins → engine runs → `INSERT` succeeds | Transaction created |
| 2nd, after completion | Redis `REPLAY` | Original result, no money moves |
| 2nd, while 1st is running | Redis `IN_FLIGHT` | 409 — retry shortly |
| 2nd, Redis unavailable | `DEGRADED` → `INSERT` hits the unique index → `DuplicateRequestError` | Original transaction returned |

That last row is the important one: **correctness is identical with Redis switched off.** Only load changes.

### Why idempotency is essential in payment systems

A timeout is not a failure — it is an **unknown**. The client cannot tell whether the money moved. Its only safe move is to retry, and mobile clients do so automatically. Without idempotency each retry is a fresh payment.

This is unlike almost any other domain: a duplicated read is harmless, a duplicated write to a profile is idempotent by nature. A duplicated *transfer* takes money from someone who authorised it once.

---

## 6. Failure handling

### The scenario the brief describes is unreachable

> Step 1: sender balance deducted · Step 2: application crashes · Step 3: receiver update fails

**This state cannot exist.** The debit and the credit are in the same PostgreSQL transaction. On crash, the WAL rolls back every uncommitted write during recovery — automatically, before the database accepts connections. There is no partial transfer to repair.

That is worth stating plainly, because most systems need a compensating-transaction engine here and this one does not. The atomicity was bought at design time.

### Two kinds of failure, opposite responses

| | Business rejection | Infrastructure fault |
|---|---|---|
| Examples | Insufficient funds, frozen wallet | Lock timeout, deadlock, crash |
| What happened | A decision was made | Nothing was decided |
| Transaction row | **Committed as `FAILED`** — durable evidence, no ledger entries | Rolled back — no row at all |
| Idempotency key | Stored, so retries replay the same answer | **Released**, so the request stays retryable |
| Retry | **Never** | Bounded: 3 attempts, exponential backoff **with jitter** |

Committing the rejection rather than throwing is deliberate: throwing would roll back the transaction row too, **erasing the evidence** that the attempt happened.

Releasing the key on an infrastructure fault is equally deliberate: storing a failure there would permanently reject a transfer that never actually failed.

Jitter matters — without it, N transfers contending for one wallet all retry in the same millisecond and collide again.

### Recovery service

Since partial transfers cannot exist, recovery does two other things:

1. **Reaps stranded `PENDING` rows.** Should always find zero — which is exactly why it runs. A non-empty result means an invariant broke, and it logs at `error`. It refuses to fail any transaction that *has* ledger entries, since that would make the row contradict the ledger.
2. **Reconciles.** Every wallet's balance must equal its ledger sum, and the whole ledger must sum to zero. Backed by the `wallet_balance_drift` and `ledger_conservation_check` views.

A wallet in drift is **frozen, not corrected**. An automatic correction would overwrite the evidence of a bug with a guess.

---

## 7. Transaction events — "what happened to my money?"

Every transfer produces an ordered timeline:

```
Transaction created      → TRANSACTION_INITIATED
Sender verified          → SENDER_VERIFIED
Receiver verified        → RECEIVER_VERIFIED
Validation passed        → VALIDATION_PASSED
Accounts secured         → WALLETS_LOCKED
Balance checked          → BALANCE_CHECKED
Processing started       → PROCESSING_STARTED
Amount debited           → SENDER_DEBITED
Receiver credited        → RECEIVER_CREDITED
Recorded in ledger       → LEDGER_POSTED
Completed                → TRANSACTION_COMPLETED
```

**One table serves as both timeline and outbox.** Internal lifecycle steps are written with `publishedAt` already set, so the outbox worker skips them; only `COMPLETED`, `FAILED` and `REVERSED` are left unpublished and delivered as notifications. Without that distinction, either users get eleven push notifications per transfer or a second table is needed.

The `TransactionEventCollector` is **one instance per transaction**, created by the processor — never a shared singleton, which would interleave events from concurrent transfers and attribute one user's steps to another's transaction.

---

## 8. Engineering explanation

### 1. How money correctness is guaranteed

Six independent layers, each sufficient to catch what the others miss:

| Layer | Guard |
|---|---|
| Type system | `Money` cannot hold a negative or a float; `WalletRepositoryPort` has no `setBalance` |
| Validation | Amount, participants, currency, limits — before any lock |
| Engine | Conditional atomic update: guard and mutation in one step |
| State machine | 13 legal transitions out of 81 possible |
| Database constraint | `CHECK (balance_poisha >= 0)`, unique idempotency index, `CHECK` on posting signs |
| Reconciliation | `SUM(ledger) == balance` per wallet; whole ledger sums to zero |

Plus double-entry: every movement writes two signed entries summing to **exactly zero**. That zero is the system's health check.

### 2. How ACID is used

- **Atomicity** — insert, lock, debit, credit, post, log, audit, mark: one transaction. WAL guarantees all-or-nothing.
- **Consistency** — CHECK constraints and triggers reject any write that would break an invariant, regardless of which code path issued it.
- **Isolation** — Read Committed plus `SELECT … FOR UPDATE`. The guard is re-evaluated against the newest committed version, so it is never decided on stale data.
- **Durability** — `fsync`'d WAL. A committed transfer survives power loss.

### 3. How concurrency problems are solved

Lost update → conditional atomic update (no read-modify-write anywhere). Deadlock → canonical ascending lock order. Contention → bounded retry with jittered backoff, retrying *only* infrastructure faults. Hot rows → short critical section, validation outside the lock.

### 4. How duplicate transactions are prevented

Four independent layers: Redis `SET NX` (atomic, no read-then-write race); the `PROCESSING` state returning 409; `UNIQUE (initiator_user_id, idempotency_key)`; and `UNIQUE (transaction_id, wallet_id, direction)` on the ledger, which stops a duplicate leg even if everything above failed.

### 5. How failures are recovered

Partial transfers cannot occur, so there is nothing to compensate. What remains: full rollback on any infrastructure fault, a released idempotency key so the retry is safe, a reaper for stranded `PENDING` rows that should always find zero, and reconciliation that detects drift in minutes rather than by customer complaint.

### 6. How this architecture scales

- The engine depends only on **ports**. Swapping PostgreSQL for a sharded cluster changes `PersistenceModule`; zero files change in `src/domain` or `src/application`.
- Reads never enter the engine. History reads the ledger's `(walletId, createdAt DESC, id)` index; balance reads come from cache or a replica.
- The critical section is four statements, so per-wallet throughput is bounded by ~1 ms of lock time rather than by the whole request.
- Double-entry is what makes Phase 3 sharding possible: a cross-shard transfer becomes two balanced half-postings against a clearing account, with the system-wide sum still zero at every instant. **None of that is possible if a balance is a column you edit.**

---

<sub>Goti · গতি — motion · Transaction Engine rev 2026-08-29 · Implements ARCHITECTURE.md §5</sub>
