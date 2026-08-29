import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  DomainError,
  InvalidAmountError,
  UserNotFoundError,
  WalletNotFoundError,
} from '../../domain/errors/domain-errors';
import { Money } from '../../domain/money/money';
import {
  POT_REPOSITORY,
  PotRepositoryPort,
  PotSnapshot,
  PotStatus,
} from '../ports/safety.port';
import {
  CLOCK,
  ClockPort,
  ID_GENERATOR,
  IdGeneratorPort,
  USER_REPOSITORY,
  UserRepositoryPort,
  WALLET_REPOSITORY,
  WalletRepositoryPort,
} from '../ports/repositories.port';
import { TransactionProcessor } from '../transaction-engine/transaction.processor';
import { TransferResult } from '../transaction-engine/transaction.types';
import { AuditAction, AuditContext, AuditService } from '../services/audit.service';

export class PotNotFoundError extends DomainError {
  readonly code = 'POT_NOT_FOUND';
  readonly retryable = false;
  constructor(id: string) {
    super(`No pot found with id ${id}.`);
  }
}

export class NotAPotMemberError extends DomainError {
  readonly code = 'NOT_A_POT_MEMBER';
  readonly retryable = false;
  constructor() {
    super('Join this pot before contributing to it.');
  }
}

export class PotClosedError extends DomainError {
  readonly code = 'POT_CLOSED';
  readonly retryable = false;
  constructor(readonly status: string) {
    super(`This pot is ${status.toLowerCase()} and no longer accepts contributions.`);
  }
}

export class NotThePotCreatorError extends DomainError {
  readonly code = 'NOT_THE_POT_CREATOR';
  readonly retryable = false;
  constructor() {
    super('Only the person who created this pot can settle it.');
  }
}

export class PotEmptyError extends DomainError {
  readonly code = 'POT_EMPTY';
  readonly retryable = false;
  constructor() {
    super('This pot holds no money to pay out.');
  }
}

export class InvalidInviteCodeError extends DomainError {
  readonly code = 'INVALID_INVITE_CODE';
  readonly retryable = false;
  constructor() {
    super('No pot found with that code. Check it and try again.');
  }
}

export class NotAPotViewerError extends DomainError {
  readonly code = 'POT_ACCESS_DENIED';
  readonly retryable = false;
  constructor() {
    super('You are not a member of this pot.');
  }
}

/** A pot preview shown BEFORE joining — no member list, no contribution figures. */
export interface PotPreview {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly creatorName: string;
  readonly targetPoisha: bigint;
  readonly collectedPoisha: bigint;
  readonly currency: string;
  readonly status: PotStatus;
  readonly memberCount: number;
  readonly alreadyMember: boolean;
}

export interface CreatePotCommand {
  readonly creatorUserId: string;
  readonly name: string;
  readonly note?: string | null;
  readonly targetPoisha: bigint;
}

export interface ContributeCommand {
  readonly potId: string;
  readonly userId: string;
  readonly amountPoisha: bigint;
  readonly idempotencyKey: string;
}

export interface ContributeResult {
  readonly pot: PotSnapshot;
  readonly transfer: TransferResult;
}

/**
 * ============================================================================
 *  POT SYSTEM — group money collection
 * ============================================================================
 *
 * WHY THIS REUSES THE TRANSACTION ENGINE INSTEAD OF ITS OWN LEDGER
 *
 * The shortcut every group-savings feature reaches for is a `currentAmount`
 * counter that contributions increment, plus a balance decrement on the
 * contributor. Two writes, no ledger, done in an afternoon.
 *
 * That creates a SECOND MONEY SYSTEM, and every guarantee the platform has
 * stops applying to it:
 *
 *   - `ledger_conservation_check` cannot see it, so pot money is outside the
 *     one assertion that proves money was neither created nor destroyed.
 *   - `wallet_balance_drift` cannot check it — there is no ledger to compare
 *     the counter against, so a wrong value is undetectable rather than merely
 *     wrong.
 *   - The counter and the contributor's balance are two independent writes. A
 *     crash between them takes money from a member that never reaches the pot,
 *     and nothing in the system can find it afterwards.
 *   - Concurrency has to be solved again from scratch: two members contributing
 *     at once race on `currentAmount` — the same lost-update bug the engine
 *     already solved once.
 *
 * So a Pot OWNS A WALLET (`type = POT`), and a contribution is an ordinary
 * transfer through the Transaction Engine: member wallet → pot wallet, one
 * atomic transaction, two balanced ledger postings, an idempotency key, a
 * lifecycle timeline, an audit row.
 *
 * The payoff is that this feature adds NO new money invariant. The pot's
 * balance is a wallet balance, so reconciliation already covers it, freezes
 * already apply to it, and the concurrency guarantees are the ones that were
 * already tested. The only genuinely new code is membership and a target.
 *
 * `pot_members.contributed_poisha` is the one derived number, and it is a
 * per-member BREAKDOWN — never the pot's balance. Losing an update to it costs
 * a display inaccuracy that can be rebuilt from the ledger. It can never cost
 * money.
 */
@Injectable()
export class PotUseCases {
  private readonly logger = new Logger(PotUseCases.name);

  constructor(
    @Inject(POT_REPOSITORY) private readonly pots: PotRepositoryPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly processor: TransactionProcessor,
    private readonly audit: AuditService,
  ) {}

  /** Creates the pot and its wallet atomically, and enrols the creator. */
  async create(command: CreatePotCommand, context: AuditContext): Promise<PotSnapshot> {
    const creator = await this.users.findById(command.creatorUserId);
    if (!creator) throw new UserNotFoundError(command.creatorUserId);

    const target = Money.fromPoisha(command.targetPoisha);
    if (target.isZero()) {
      throw new InvalidAmountError('a pot needs a positive target amount.');
    }

    const potId = this.ids.generate();
    const pot = await this.pots.create({
      potId,
      inviteCode: this.generateInviteCode(),
      walletId: this.ids.generate(),
      creatorUserId: command.creatorUserId,
      creatorMemberId: this.ids.generate(),
      name: command.name.trim(),
      note: command.note ?? null,
      targetPoisha: target.poisha,
      currency: 'BDT',
    });

    await this.audit.record(
      AuditAction.POT_CREATED,
      { type: 'Pot', id: potId },
      context,
      { after: { name: pot.name, targetPoisha: target.poisha.toString(), walletId: pot.walletId } },
    );

    return pot;
  }

  /** Joining is idempotent — tapping twice is not an error. */
  async join(potId: string, userId: string, context: AuditContext): Promise<PotSnapshot> {
    const pot = await this.requireOpenPot(potId);

    const added = await this.pots.addMember(potId, userId, this.ids.generate());
    if (added) {
      await this.audit.record(AuditAction.POT_JOINED, { type: 'Pot', id: potId }, context);
    }

    return (await this.pots.findById(potId)) ?? pot;
  }

  /**
   * Contributes to a pot.
   *
   * The whole method is a thin wrapper around `processor.process`. It resolves
   * the pot's wallet, checks membership, and hands the money movement to the
   * SAME engine a peer-to-peer send uses — with the same idempotency, the same
   * lock ordering, the same conditional atomic debit, and the same ledger
   * postings.
   *
   * A frozen contributor is rejected by the engine, not by a check here. An
   * envelope reservation is respected by the engine, not by a check here.
   * Everything the platform already guarantees applies for free.
   */
  async contribute(command: ContributeCommand, context: AuditContext): Promise<ContributeResult> {
    const pot = await this.requireOpenPot(command.potId);

    if (!(await this.pots.isMember(command.potId, command.userId))) {
      throw new NotAPotMemberError();
    }

    const potWallet = await this.wallets.findById(pot.walletId);
    if (!potWallet) throw new WalletNotFoundError(pot.walletId);

    // A POT wallet has no `userId`, so the transfer is addressed by WALLET,
    // not by phone. That is the only structural difference from a P2P send.
    const transfer = await this.processor.process({
      idempotencyKey: command.idempotencyKey,
      initiatorUserId: command.userId,
      senderUserId: command.userId,
      receiverWalletId: pot.walletId,
      amountPoisha: command.amountPoisha,
      currency: pot.currency,
      note: `Contribution to ${pot.name}`,
      type: 'POT_CONTRIBUTION',
      correlationId: context.correlationId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });

    if (transfer.status === 'COMPLETED') {
      // AFTER commit. The money is already durably in the pot's wallet; this
      // only updates the per-member breakdown.
      await this.pots.recordContribution(
        command.potId,
        command.userId,
        command.amountPoisha,
        this.clock.now(),
      );

      await this.audit.record(
        AuditAction.POT_CONTRIBUTED,
        { type: 'Pot', id: command.potId },
        context,
        { after: { amountPoisha: command.amountPoisha.toString(), transactionId: transfer.transactionId } },
      );

      await this.markFundedIfTargetReached(command.potId);
    }

    const refreshed = await this.pots.findById(command.potId);
    return { pot: refreshed ?? pot, transfer };
  }

  /**
   * Pays the pot out to its creator and closes it.
   *
   * Also a plain engine transfer — pot wallet → creator wallet — so the payout
   * is as auditable as every contribution that funded it.
   */
  async settle(
    potId: string,
    actingUserId: string,
    idempotencyKey: string,
    context: AuditContext,
  ): Promise<ContributeResult> {
    const pot = await this.requirePot(potId);

    if (pot.creatorUserId !== actingUserId) throw new NotThePotCreatorError();
    if (pot.status === 'SETTLED' || pot.status === 'CANCELLED') throw new PotClosedError(pot.status);
    if (pot.collectedPoisha <= 0n) throw new PotEmptyError();

    const creatorWallet = await this.wallets.findByUserId(pot.creatorUserId);
    if (!creatorWallet) throw new WalletNotFoundError(pot.creatorUserId);

    const transfer = await this.processor.process({
      idempotencyKey,
      // The pot's creator initiates, because idempotency is scoped to whoever
      // authorised the movement — and a POT wallet has no user of its own.
      initiatorUserId: pot.creatorUserId,
      senderWalletId: pot.walletId,
      receiverUserId: pot.creatorUserId,
      amountPoisha: pot.collectedPoisha,
      currency: pot.currency,
      note: `Payout from ${pot.name}`,
      type: 'POT_PAYOUT',
      correlationId: context.correlationId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });

    if (transfer.status === 'COMPLETED') {
      await this.pots.updateStatus(potId, 'SETTLED', ['OPEN', 'FUNDED'], {
        transactionId: transfer.transactionId,
        settledAt: this.clock.now(),
      });
      await this.audit.record(
        AuditAction.POT_SETTLED,
        { type: 'Pot', id: potId },
        context,
        { after: { payoutPoisha: pot.collectedPoisha.toString(), transactionId: transfer.transactionId } },
      );
      this.logger.log(`Pot ${potId} settled: ${pot.collectedPoisha} poisha paid to creator.`);
    }

    const refreshed = await this.pots.findById(potId);
    return { pot: refreshed ?? pot, transfer };
  }

  /**
   * Joins a pot from a shared code.
   *
   * THE ENTRY POINT FOR EVERYONE WHO DID NOT CREATE THE POT. `GET /pots` only
   * returns pots you already belong to, so without this a pot would be
   * unreachable by the people it exists to collect from.
   *
   * A code rather than an open directory: a pot is private to a group. You join
   * because someone sent you the code, not because you browsed strangers' trip
   * funds.
   */
  async joinByCode(
    inviteCode: string,
    userId: string,
    context: AuditContext,
  ): Promise<PotSnapshot> {
    const pot = await this.pots.findByInviteCode(inviteCode);
    if (!pot) throw new InvalidInviteCodeError();

    const open: PotStatus[] = ['OPEN', 'FUNDED'];
    if (!open.includes(pot.status)) throw new PotClosedError(pot.status);

    const added = await this.pots.addMember(pot.id, userId, this.ids.generate());
    if (added) {
      await this.audit.record(
        AuditAction.POT_JOINED,
        { type: 'Pot', id: pot.id },
        context,
        { after: { via: 'invite_code' } },
      );
    }

    return (await this.pots.findById(pot.id)) ?? pot;
  }

  /**
   * Shows just enough for someone holding a code to decide whether to join.
   *
   * Deliberately WITHOUT the member list or per-member contributions. Anyone who
   * gets hold of a code should be able to see what the pot is for — not who is
   * in it and how much each person has given. That detail is for members.
   */
  async previewByCode(inviteCode: string, userId: string): Promise<PotPreview> {
    const pot = await this.pots.findByInviteCode(inviteCode);
    if (!pot) throw new InvalidInviteCodeError();

    return {
      id: pot.id,
      name: pot.name,
      note: pot.note,
      creatorName: pot.creatorName,
      targetPoisha: pot.targetPoisha,
      collectedPoisha: pot.collectedPoisha,
      currency: pot.currency,
      status: pot.status,
      memberCount: pot.memberCount,
      alreadyMember: pot.members.some((member) => member.userId === userId),
    };
  }

  /**
   * The creator adds someone directly, by phone number.
   *
   * Safe to do without the invitee's consent because MEMBERSHIP MOVES NO MONEY.
   * Being added to a pot only grants the ability to contribute — it can never
   * debit the new member's wallet, which still requires them to act and still
   * goes through the engine with their own idempotency key.
   *
   * Restricted to the creator so a pot cannot be used to spam strangers into
   * group lists.
   */
  async addMemberByPhone(
    potId: string,
    actingUserId: string,
    phone: string,
    context: AuditContext,
  ): Promise<PotSnapshot> {
    const pot = await this.requireOpenPot(potId);
    if (pot.creatorUserId !== actingUserId) throw new NotThePotCreatorError();

    const invitee = await this.users.findByPhone(phone);
    if (!invitee) throw new UserNotFoundError(phone);

    const added = await this.pots.addMember(potId, invitee.id, this.ids.generate());
    if (added) {
      await this.audit.record(
        AuditAction.POT_JOINED,
        { type: 'Pot', id: potId },
        context,
        { after: { addedUserId: invitee.id, via: 'creator_invite' } },
      );
    }

    return (await this.pots.findById(potId)) ?? pot;
  }

  /**
   * Full pot detail — MEMBERS ONLY.
   *
   * Previously this had no authorisation at all, so any authenticated user could
   * read any pot's member list and contribution amounts by knowing its id. The
   * membership check closes that: non-members get the same NOT_FOUND a
   * non-existent pot would produce, so pot ids cannot be probed either.
   */
  async view(potId: string, viewerUserId: string): Promise<PotSnapshot> {
    const pot = await this.requirePot(potId);
    if (!pot.members.some((member) => member.userId === viewerUserId)) {
      throw new PotNotFoundError(potId);
    }
    return pot;
  }

  /**
   * Eight characters from an alphabet without 0/O/1/I/L.
   *
   * Invite codes get read aloud, screenshotted and retyped — those four
   * characters are where transcription errors come from. 31^8 ≈ 8.5e11
   * combinations; the unique index catches any collision that still happens.
   */
  private generateInviteCode(): string {
    const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
  }

  async listForUser(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: readonly PotSnapshot[]; total: number }> {
    return this.pots.listForUser(userId, limit, offset);
  }

  /**
   * Marks a pot FUNDED once its wallet reaches the target.
   *
   * FUNDED still accepts contributions. Refusing someone's money because the
   * group over-collected by 50 taka is worse than a slightly over-funded trip —
   * the status is a signal, not a gate.
   */
  private async markFundedIfTargetReached(potId: string): Promise<void> {
    const pot = await this.pots.findById(potId);
    if (pot && pot.status === 'OPEN' && pot.collectedPoisha >= pot.targetPoisha) {
      await this.pots.updateStatus(potId, 'FUNDED', ['OPEN']);
    }
  }

  private async requirePot(potId: string): Promise<PotSnapshot> {
    const pot = await this.pots.findById(potId);
    if (!pot) throw new PotNotFoundError(potId);
    return pot;
  }

  private async requireOpenPot(potId: string): Promise<PotSnapshot> {
    const pot = await this.requirePot(potId);
    const open: PotStatus[] = ['OPEN', 'FUNDED'];
    if (!open.includes(pot.status)) throw new PotClosedError(pot.status);
    return pot;
  }
}
