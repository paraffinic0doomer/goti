import { Inject, Injectable } from '@nestjs/common';

import { Money } from '../../domain/money/money';
import {
  CurrencyMismatchError,
  InvalidAmountError,
  SelfTransferError,
  TransferLimitExceededError,
  UserNotActiveError,
  UserNotFoundError,
  WalletNotActiveError,
  WalletNotFoundError,
} from '../../domain/errors/domain-errors';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
  WALLET_REPOSITORY,
  WalletRepositoryPort,
  WalletSnapshot,
} from '../ports/repositories.port';

/** Everything the processor needs, resolved once so it is not looked up twice. */
export interface ValidatedTransfer {
  /** NULL when the side is a Pot wallet, which has no owning user. */
  readonly senderUserId: string | null;
  readonly senderWallet: WalletSnapshot;
  readonly receiverUserId: string | null;
  readonly receiverWallet: WalletSnapshot;
  readonly amount: Money;
}

export interface TransferValidationInput {
  /** Present for every user-initiated transfer. Absent only for a POT_PAYOUT. */
  readonly senderUserId?: string;
  /** Addresses the sender by wallet — a POT wallet has no owning user. */
  readonly senderWalletId?: string;
  /** Exactly one of these identifies the receiver. */
  readonly receiverUserId?: string;
  readonly receiverPhone?: string;
  readonly receiverWalletId?: string;
  readonly amountPoisha: bigint;
  readonly currency: string;
}

/** Per-transfer ceiling. A policy value, not a fraud signal. */
const MAX_TRANSFER_POISHA = 5_000_000_00n; // 5,000,000 BDT

/**
 * Pre-flight validation — everything checkable BEFORE taking a lock.
 *
 * WHY VALIDATE OUTSIDE THE LOCK
 * Every check performed while holding a wallet lock is time no other transfer
 * involving that wallet can make progress. Rejecting a malformed amount or a
 * missing receiver costs two indexed reads out here; done under the lock it
 * would serialise unrelated traffic behind a request that was never going to
 * succeed.
 *
 * WHY THIS IS NOT A TOCTOU BUG
 * State can change between validation and the lock — a wallet could be frozen,
 * a balance drained. That is fine, because nothing here is the authority. The
 * checks that MUST hold are re-run inside the lock by the processor, and the
 * balance check is not performed here at all: it is the conditional atomic
 * update itself. This class exists to fail fast with a good error message, not
 * to make guarantees.
 */
@Injectable()
export class TransactionValidator {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort,
  ) {}

  /**
   * Steps 2–6 of the workflow: validate the request, verify both participants,
   * validate the amount.
   *
   * Deliberately does NOT check the balance. Reading a balance and later
   * spending against that read is precisely the lost-update bug (constraint
   * C1); the only safe balance check is the conditional update inside the lock.
   */
  async validate(input: TransferValidationInput): Promise<ValidatedTransfer> {
    // --- Step 5 first: amount validation is free and rejects the most common
    // --- bad input without touching the database at all.
    const amount = this.validateAmount(input.amountPoisha, input.currency);

    // --- Steps 3 & 4: resolve both participants ---
    //
    // Each side is addressed EITHER by user (a person) OR by wallet (a Pot,
    // which has no owning user). Resolving both through one helper keeps the
    // two addressing modes from drifting apart — a pot contribution gets
    // exactly the same status checks a peer-to-peer send does.
    const senderSide = await this.resolveParticipant({
      userId: input.senderUserId,
      walletId: input.senderWalletId,
      label: 'sender',
    });
    const receiverSide = await this.resolveParticipant({
      userId: input.receiverUserId,
      phone: input.receiverPhone,
      walletId: input.receiverWalletId,
      label: 'receiver',
    });

    // Caught here rather than at the wallet level so the message names the
    // thing the user actually did. Only meaningful when both sides are people.
    if (senderSide.userId && receiverSide.userId && senderSide.userId === receiverSide.userId) {
      throw new SelfTransferError(senderSide.wallet.id);
    }

    const senderWallet = senderSide.wallet;
    const receiverWallet = receiverSide.wallet;

    if (senderWallet.id === receiverWallet.id) {
      throw new SelfTransferError(senderWallet.id);
    }

    // A cross-currency transfer is a conversion — a different operation, with
    // a rate and its own audit trail. Silently moving BDT into a USD wallet
    // would corrupt both balances.
    if (senderWallet.currency !== receiverWallet.currency) {
      throw new CurrencyMismatchError(senderWallet.currency, receiverWallet.currency);
    }
    if (senderWallet.currency !== amount.currency) {
      throw new CurrencyMismatchError(amount.currency, senderWallet.currency);
    }

    return {
      senderUserId: senderSide.userId,
      senderWallet,
      receiverUserId: receiverSide.userId,
      receiverWallet,
      amount,
    };
  }

  /**
   * Resolves one side of a transfer to a usable wallet.
   *
   * Accepts a user id, a phone number, or a wallet id. Whichever route is
   * taken, the SAME checks run: the owning user (if there is one) must be
   * active, and the wallet must be ACTIVE — so a frozen wallet is rejected
   * identically whether it was addressed by phone or by wallet id.
   *
   * A wallet with no owning user is legitimate: that is a Pot. A wallet-
   * addressed participant therefore returns `userId: null`, and callers that
   * need a person must handle that rather than assume one exists.
   */
  private async resolveParticipant(input: {
    userId?: string;
    phone?: string;
    walletId?: string;
    label: string;
  }): Promise<{ userId: string | null; wallet: WalletSnapshot }> {
    if (input.walletId) {
      const wallet = await this.wallets.findById(input.walletId);
      if (!wallet) throw new WalletNotFoundError(input.walletId);
      this.assertStatusForRole(wallet, input.label);

      // A wallet owned by a person still has to have an active owner — a
      // suspended user's wallet must not move money just because it was
      // addressed by id instead of by phone.
      if (wallet.userId) {
        const owner = await this.users.findById(wallet.userId);
        if (owner && owner.status !== 'ACTIVE') {
          throw new UserNotActiveError(owner.id, owner.status);
        }
      }
      return { userId: wallet.userId, wallet };
    }

    const user = input.userId
      ? await this.users.findById(input.userId)
      : input.phone
        ? await this.users.findByPhone(input.phone)
        : null;

    if (!user) {
      throw new UserNotFoundError(input.userId ?? input.phone ?? `(no ${input.label} given)`);
    }
    if (user.status !== 'ACTIVE') throw new UserNotActiveError(user.id, user.status);

    const wallet = await this.requireWallet(user.id);
    this.assertStatusForRole(wallet, input.label);
    return { userId: user.id, wallet };
  }

  /**
   * Re-checks, under the lock, only what can change and must be true.
   *
   * Wallet status is the whole list: a wallet frozen between validation and
   * the lock must not be debited. Balance is NOT here — it is enforced by the
   * conditional update, which is the only check that cannot go stale.
   */
  assertStillValidUnderLock(sender: WalletSnapshot, receiver: WalletSnapshot): void {
    this.assertWalletUsable(sender);
    this.assertCanReceive(receiver);
  }

  private validateAmount(amountPoisha: bigint, currency: string): Money {
    // `Money` rejects negatives and non-bigints at construction, so anything
    // that survives is a valid magnitude.
    const amount = Money.fromPoisha(amountPoisha, currency);

    if (amount.isZero()) {
      throw new InvalidAmountError('a transfer must move a positive amount.');
    }
    if (amount.poisha > MAX_TRANSFER_POISHA) {
      throw new TransferLimitExceededError(MAX_TRANSFER_POISHA, amount.poisha);
    }
    return amount;
  }

  private async requireWallet(userId: string): Promise<WalletSnapshot> {
    const wallet = await this.wallets.findByUserId(userId);
    if (!wallet) throw new WalletNotFoundError(userId);
    return wallet;
  }

  /** Applies the sender rule or the (looser) receiver rule. */
  private assertStatusForRole(wallet: WalletSnapshot, label: string): void {
    if (label === 'receiver') this.assertCanReceive(wallet);
    else this.assertWalletUsable(wallet);
  }

  /** Sending money requires a fully ACTIVE wallet. Nothing else may pay out. */
  private assertWalletUsable(wallet: WalletSnapshot): void {
    if (wallet.status !== 'ACTIVE') {
      throw new WalletNotActiveError(wallet.id, wallet.status);
    }
  }

  /**
   * RECEIVING is deliberately more permissive than sending.
   *
   * A freeze exists to stop a compromised wallet from LEAKING money. Refusing
   * money coming IN punishes the victim — someone who froze their wallet after
   * losing their phone would also lose their salary that week, and the incoming
   * funds are perfectly safe precisely because the attacker cannot get them out.
   *
   * The same reasoning covers UNDER_REVIEW: money arriving during an
   * investigation is traceable and harmless.
   *
   * CLOSED is the one status that cannot receive — there is nobody left to
   * spend it, so a credit would strand the money permanently.
   */
  private assertCanReceive(wallet: WalletSnapshot): void {
    if (wallet.status === 'CLOSED') {
      throw new WalletNotActiveError(wallet.id, wallet.status);
    }
  }
}
