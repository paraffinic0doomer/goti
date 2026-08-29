import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';

import type { AuditContext } from '../../../application/services/audit.service';
import { EnvelopeUseCases } from '../../../application/use-cases/envelope.use-cases';
import { PotUseCases } from '../../../application/use-cases/pot.use-cases';
import { RiskEngineService } from '../../../application/services/risk-engine.service';
import {
  REQUIRED_ANSWER_COUNT,
  SecurityQuestionService,
} from '../../../application/services/security-question.service';
import { AnswerSecurityChallengeUseCase } from '../../../application/use-cases/security-challenge.use-cases';
import { WalletSecurityUseCases } from '../../../application/use-cases/wallet-security.use-cases';
import {
  AddPotMemberDto,
  AdjustEnvelopeDto,
  AnswerChallengeDto,
  ContributeToPotDto,
  CreateEnvelopeDto,
  CreatePotDto,
  FreezeWalletDto,
  JoinPotByCodeDto,
  ListPotsQueryDto,
  SettlePotDto,
  UnfreezeWalletDto,
} from '../dto/safety.dto';
import { Audit, AuthenticatedUser, CurrentUser, Public } from '../http.plumbing';

/**
 * Emergency wallet freeze.
 *
 * Mounted under `/wallet` so the security controls sit beside the wallet they
 * protect rather than in a separate "security" area a panicking user has to go
 * looking for.
 */
@Controller('wallet')
export class WalletSecurityController {
  constructor(private readonly security: WalletSecurityUseCases) {}

  /**
   * Freezes the caller's own wallet immediately.
   *
   * Deliberately NOT rate limited — see `WalletSecurityUseCases.freeze`. This is
   * the one endpoint where throttling would fail the user at the exact moment
   * they need it most.
   */
  @Post('freeze')
  @HttpCode(HttpStatus.OK)
  freeze(
    @Body() body: FreezeWalletDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.security.freeze({ userId: user.userId, reason: body.reason }, audit);
  }

  @Post('unfreeze')
  @HttpCode(HttpStatus.OK)
  unfreeze(
    @Body() body: UnfreezeWalletDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.security.unfreeze({ userId: user.userId, reason: body.reason }, audit);
  }

  /** Current security state plus the freeze/unfreeze history. */
  @Get('security')
  security_state(@CurrentUser() user: AuthenticatedUser) {
    return this.security.getSecurityState(user.userId);
  }
}

/**
 * Expense envelopes — reserved spending capacity.
 *
 * Every response is the FULL budget view (balance, reserved, spendable, all
 * envelopes), not just the object that changed. A budgeting UI needs all four
 * numbers to stay consistent after any edit, and returning them together means
 * the client never has to re-derive spendable balance itself — which is exactly
 * the calculation that must not drift from the backend's.
 */
@Controller('envelopes')
export class EnvelopeController {
  constructor(private readonly envelopes: EnvelopeUseCases) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.envelopes.getBudget(user.userId);
  }

  @Post()
  create(
    @Body() body: CreateEnvelopeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.envelopes.create(
      user.userId,
      {
        name: body.name,
        category: body.category,
        icon: body.icon,
        targetPoisha: body.targetAmount === undefined ? undefined : BigInt(body.targetAmount),
      },
      audit,
    );
  }

  @Post(':id/reserve')
  @HttpCode(HttpStatus.OK)
  reserve(
    @Param('id', new ParseUUIDPipe({ version: '7' })) envelopeId: string,
    @Body() body: AdjustEnvelopeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.envelopes.reserve(user.userId, envelopeId, BigInt(body.amount), audit);
  }

  @Post(':id/unlock')
  @HttpCode(HttpStatus.OK)
  unlock(
    @Param('id', new ParseUUIDPipe({ version: '7' })) envelopeId: string,
    @Body() body: AdjustEnvelopeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.envelopes.unlock(user.userId, envelopeId, BigInt(body.amount), audit);
  }

  @Delete(':id')
  remove(
    @Param('id', new ParseUUIDPipe({ version: '7' })) envelopeId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.envelopes.remove(user.userId, envelopeId, audit);
  }
}

/**
 * Security questions — the knowledge factor.
 *
 * The catalogue is PUBLIC because the registration form needs it before an
 * account exists. Listing the questions reveals nothing: the prompts are
 * generic, and only the ANSWERS are secret.
 */
@Controller('security')
export class SecurityQuestionController {
  constructor(
    private readonly questions: SecurityQuestionService,
    private readonly answerChallenge: AnswerSecurityChallengeUseCase,
  ) {}

  @Public()
  @Get('questions')
  list() {
    return { questions: this.questions.listQuestions(), required: REQUIRED_ANSWER_COUNT };
  }

  /**
   * Answers a challenge.
   *
   * A WRONG answer on a transfer challenge freezes the wallet immediately —
   * the attack triggers the defence.
   */
  @Post('challenges/:id/answer')
  @HttpCode(HttpStatus.OK)
  answer(
    @Param('id', new ParseUUIDPipe({ version: '7' })) challengeId: string,
    @Body() body: AnswerChallengeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.answerChallenge.execute(challengeId, user.userId, body.answer, audit);
  }
}

/**
 * Risk flags — the read side of the fraud engine.
 *
 * Scoped to the caller. A flag names the rules that fired and the thresholds
 * they crossed; exposing another user's flags would hand an attacker the exact
 * detection boundaries to stay beneath.
 */
@Controller('risk-flags')
export class RiskFlagController {
  constructor(private readonly risk: RiskEngineService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.risk.listFlagsForUser(user.userId, 25);
  }
}

/** Group pots. Every money movement here goes through the Transaction Engine. */
@Controller('pots')
export class PotController {
  constructor(private readonly pots: PotUseCases) {}

  @Get()
  list(@Query() query: ListPotsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.pots.listForUser(
      user.userId,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    );
  }

  @Post()
  create(
    @Body() body: CreatePotDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.pots.create(
      {
        creatorUserId: user.userId,
        name: body.name,
        note: body.note,
        targetPoisha: BigInt(body.targetAmount),
      },
      audit,
    );
  }

  /**
   * Joins from a shared code — how anyone who did not create the pot gets in.
   *
   * Declared BEFORE `:id` routes: Nest matches in declaration order, and
   * `/pots/join` would otherwise be captured by `/pots/:id`.
   */
  @Post('join')
  @HttpCode(HttpStatus.OK)
  joinByCode(
    @Body() body: JoinPotByCodeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.pots.joinByCode(body.code, user.userId, audit);
  }

  /** What a code-holder sees before joining. No member list, no amounts. */
  @Get('preview/:code')
  preview(@Param('code') code: string, @CurrentUser() user: AuthenticatedUser) {
    return this.pots.previewByCode(code, user.userId);
  }

  /** Full detail. MEMBERS ONLY — a non-member gets the same 404 as a bad id. */
  @Get(':id')
  view(
    @Param('id', new ParseUUIDPipe({ version: '7' })) potId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.pots.view(potId, user.userId);
  }

  /** The creator adds someone directly by phone. */
  @Post(':id/members')
  @HttpCode(HttpStatus.OK)
  addMember(
    @Param('id', new ParseUUIDPipe({ version: '7' })) potId: string,
    @Body() body: AddPotMemberDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.pots.addMemberByPhone(potId, user.userId, body.phone, audit);
  }

  @Post(':id/join')
  @HttpCode(HttpStatus.OK)
  join(
    @Param('id', new ParseUUIDPipe({ version: '7' })) potId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.pots.join(potId, user.userId, audit);
  }

  @Post(':id/contribute')
  @HttpCode(HttpStatus.OK)
  contribute(
    @Param('id', new ParseUUIDPipe({ version: '7' })) potId: string,
    @Body() body: ContributeToPotDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.pots.contribute(
      {
        potId,
        userId: user.userId,
        amountPoisha: BigInt(body.amount),
        idempotencyKey: body.idempotencyKey,
      },
      audit,
    );
  }

  /** Pays the pot out to its creator. Also an engine transfer. */
  @Post(':id/settle')
  @HttpCode(HttpStatus.OK)
  settle(
    @Param('id', new ParseUUIDPipe({ version: '7' })) potId: string,
    @Body() body: SettlePotDto,
    @CurrentUser() user: AuthenticatedUser,
    @Audit() audit: AuditContext,
  ) {
    return this.pots.settle(potId, user.userId, body.idempotencyKey, audit);
  }
}
