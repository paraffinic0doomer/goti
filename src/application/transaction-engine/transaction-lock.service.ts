import { Inject, Injectable, Logger } from '@nestjs/common';

import { WalletNotFoundError } from '../../domain/errors/domain-errors';
import {
  TransactionContext,
  WALLET_REPOSITORY,
  WalletRepositoryPort,
  WalletSnapshot,
} from '../ports/repositories.port';

/** Both participants, freshly read while their rows are locked. */
export interface LockedWalletPair {
  readonly sender: WalletSnapshot;
  readonly receiver: WalletSnapshot;
}

/**
 * ============================================================================
 *  WALLET LOCKING — pessimistic, with a canonical acquisition order
 * ============================================================================
 *
 * WHY PESSIMISTIC LOCKING WAS CHOSEN
 * ---------------------------------------------------------------------------
 * HOW THE RACE HAPPENS
 *
 *   Balance: 1000. Request A sends 700, request B sends 600, simultaneously.
 *
 *     A: read balance → 1000        B: read balance → 1000
 *     A: 1000 ≥ 700, ok             B: 1000 ≥ 600, ok
 *     A: write 300                  B: write 400
 *
 *   Both succeed. 1300 left a wallet holding 1000, and the final balance is
 *   whichever write landed last. The wallet has spent money that never existed.
 *
 *   The defect is the GAP between reading a balance and acting on it. Any
 *   design that reads a balance into application memory and later spends
 *   against that read has this bug, no matter how carefully it is written.
 *
 * OPTIMISTIC LOCKING — considered, rejected as the primary mechanism
 *
 *   A `version` column with `UPDATE ... WHERE version = :seen`, retrying on
 *   conflict. It works, and it is excellent under LOW contention because no
 *   request ever waits.
 *
 *   Rejected here because contention in a wallet system is concentrated, not
 *   uniform: payroll accounts, merchants, and any wallet in a viral moment take
 *   many concurrent writes. Optimistic control degrades exactly there — retries
 *   rise, and every retry redoes the whole transaction. Worst case is livelock,
 *   where competing writers keep aborting each other and throughput collapses
 *   under the load it most needs to survive. It also turns a rejection into a
 *   RETRY rather than an answer, so "insufficient funds" arrives late and after
 *   wasted work.
 *
 * PESSIMISTIC LOCKING — selected
 *
 *   `SELECT ... FOR UPDATE` takes the row lock BEFORE any decision. Concurrent
 *   transfers on the same wallet queue instead of colliding. Under contention
 *   throughput is bounded but STABLE and fair, which is the property a payment
 *   system needs. Latency is predictable, and a rejection is final on the first
 *   attempt.
 *
 * THE ACTUAL DESIGN IS A HYBRID, AND THAT MATTERS
 *
 *   The lock alone does not enforce sufficiency — it only serialises. The
 *   sufficiency check is the conditional atomic update
 *   (`UPDATE ... WHERE balance >= amount`), which is a compare-and-set
 *   performed by the database. The lock gives deterministic ordering and a
 *   consistent read for the ledger's `balance_after`; the conditional update
 *   guarantees no balance ever goes negative. Neither alone is sufficient:
 *   without the lock the two transfers deadlock, without the conditional
 *   update the balance check could still be evaluated against a stale row.
 *
 * TRADE-OFFS ACCEPTED
 *   - Throughput per wallet is capped by lock hold time. Mitigated by keeping
 *     the critical section to four statements and by validating outside it.
 *   - A held lock blocks readers that also want FOR UPDATE. Plain reads
 *     (balance display, history) are unaffected — PostgreSQL MVCC lets them
 *     proceed against the last committed snapshot.
 *   - A hot wallet is a hard ceiling. DATABASE.md names the mitigation for
 *     when that day comes: sub-balances that reconcile to one.
 *
 * DEADLOCK AVOIDANCE — the whole reason this class exists
 * ---------------------------------------------------------------------------
 * Two reciprocal transfers, A→B and B→A, arriving at once:
 *
 *   Locking in arrival order:  T1 holds A wants B, T2 holds B wants A.
 *                              A cycle. PostgreSQL kills one at random.
 *
 *   Locking in ID order:       both sort {A,B} and take A first.
 *                              T2 simply waits. No cycle can form.
 *
 * Sorting removes the POSSIBILITY of a cycle rather than detecting one after
 * the fact — a structural fix, not a retry loop around a symptom
 * (ARCHITECTURE.md §5 Figure 4).
 */
@Injectable()
export class TransactionLockService {
  private readonly logger = new Logger(TransactionLockService.name);

  constructor(@Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort) {}

  /**
   * Locks both wallets and returns their state as of the lock.
   *
   * The returned snapshots are read INSIDE the lock, so they are the newest
   * committed values and cannot be invalidated by a concurrent writer while
   * the enclosing transaction lives.
   *
   * Ordering is applied by the repository, not requested from the caller — a
   * rule enforced only by convention is a rule that eventually gets skipped by
   * a new code path.
   */
  async lockWalletPair(
    senderWalletId: string,
    receiverWalletId: string,
    context: TransactionContext,
  ): Promise<LockedWalletPair> {
    const locked = await this.wallets.lockForUpdate([senderWalletId, receiverWalletId], context);

    const sender = locked.find((wallet) => wallet.id === senderWalletId);
    const receiver = locked.find((wallet) => wallet.id === receiverWalletId);

    // A wallet that existed during validation but not under the lock means it
    // was deleted mid-flight — which the schema's `onDelete: Restrict` makes
    // impossible. Treated as a hard failure rather than assumed unreachable.
    if (!sender) throw new WalletNotFoundError(senderWalletId);
    if (!receiver) throw new WalletNotFoundError(receiverWalletId);

    this.logger.debug(
      `Locked wallets in canonical order: [${[senderWalletId, receiverWalletId]
        .slice()
        .sort()
        .join(', ')}]`,
    );

    return { sender, receiver };
  }
}
