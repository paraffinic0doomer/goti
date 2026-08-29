import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  CreateRiskFlagInput,
  RISK_REPOSITORY,
  RiskRepositoryPort,
  RiskSignals,
} from '../ports/query.port';
import { ID_GENERATOR, IdGeneratorPort } from '../ports/repositories.port';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** One rule's verdict, with the evidence that produced it. */
export interface RuleOutcome {
  readonly rule: string;
  readonly triggered: boolean;
  readonly weight: number;
  /** Plain-language reason. Shown to an analyst, and to the user if we block. */
  readonly explanation: string;
  /** The numbers behind the decision, so it can be audited or disputed. */
  readonly evidence: Record<string, unknown>;
}

export interface RiskAssessment {
  readonly level: RiskLevel;
  readonly score: number;
  readonly triggeredRules: readonly RuleOutcome[];
  readonly allRules: readonly RuleOutcome[];
  /** Whether policy says this transfer must not proceed. */
  readonly shouldBlock: boolean;
}

export interface RiskEvaluationInput {
  readonly senderUserId: string;
  readonly receiverUserId: string;
  readonly amountPoisha: bigint;
  readonly senderBalancePoisha: bigint;
}

// ---------------------------------------------------------------------------
//  Thresholds — named constants, never inline numbers.
//
//  Every one of these is a POLICY value that a risk analyst should be able to
//  tune without reading the algorithm. Buried literals are how a threshold gets
//  changed in one rule and forgotten in another.
// ---------------------------------------------------------------------------

const BALANCE_RATIO_ELEVATED = 0.9;
const BALANCE_RATIO_EXTREME = 0.99;

/** 10,000 BDT. Above this, an unknown receiver is materially riskier. */
const LARGE_AMOUNT_POISHA = 10_000_00n;
const NEW_COUNTERPARTY_RATIO = 0.5;

const VELOCITY_ELEVATED_PER_HOUR = 10;
const VELOCITY_EXTREME_PER_HOUR = 25;
const FANOUT_ELEVATED_PER_DAY = 15;

const SCORE_MEDIUM = 30;
const SCORE_HIGH = 60;

/** No activity for this long counts as dormant. Rule 4. */
const DORMANCY_DAYS = 90;
/** A returning dormant account moving this share of its balance is the signal. */
const DORMANT_RETURN_RATIO = 0.5;

/**
 * Blocking threshold.
 *
 * A score at or above this REJECTS the transfer outright rather than flagging
 * it for later review.
 *
 * Set to 90, not 60, deliberately. 60 is HIGH — enough to page an analyst, not
 * enough to refuse a customer's money. 90 requires at least two independent
 * rules to fire together (for example a first-ever transfer to a new receiver
 * for most of the balance, from an account dormant for three months), which is
 * a conjunction that legitimate behaviour very rarely produces.
 *
 * The asymmetry is deliberate: wrongly blocking a real transfer costs a
 * customer their rent payment and their trust; wrongly allowing a flagged one
 * costs a review. A single rule firing is never sufficient to block.
 */
const SCORE_BLOCK = 90;

/**
 * ============================================================================
 *  RISK ENGINE — explainable, rule-based
 * ============================================================================
 *
 * WHY RULES AND NOT MACHINE LEARNING
 * ---------------------------------------------------------------------------
 *   1. NO TRAINING DATA EXISTS. A supervised fraud model needs thousands of
 *      CONFIRMED fraud labels. A new platform has zero. Training on
 *      unlabelled data produces a model that has learned normal traffic and
 *      calls anything unusual fraud — which on day one is every user.
 *
 *   2. EXPLAINABILITY IS A REQUIREMENT, NOT A PREFERENCE. When a transfer is
 *      flagged, three people need an answer: the analyst deciding what to do,
 *      the customer asking why, and the regulator asking how. "The model
 *      scored 0.87" satisfies none of them. "Sent 95% of balance to a receiver
 *      never transacted with before, 14 transfers this hour" satisfies all
 *      three, and is actionable.
 *
 *   3. DETERMINISTIC AND TESTABLE. Same input, same output, every time.
 *      The whole engine is unit-testable in milliseconds with no fixtures, no
 *      model artefact, and no inference server.
 *
 *   4. TUNING IS A CONSTANT CHANGE, NOT A RETRAINING CYCLE. A fraud pattern
 *      seen this morning can be a threshold change deployed this afternoon.
 *
 *   5. IT WORKS AT ZERO USERS. No cold-start problem: the rules encode what is
 *      already known about how wallet fraud works.
 *
 *   6. IT IS CHEAP. Three signals in ONE indexed query, on the pre-transfer
 *      path. Model inference would add a network hop to the money path, which
 *      ARCHITECTURE.md forbids.
 *
 * ML earns its place later, once there is labelled outcome data — and the
 * right first use is RANKING the analyst review queue, not making the
 * block decision.
 *
 * WHERE THIS RUNS
 * ---------------------------------------------------------------------------
 * Assessment happens BEFORE the transfer (cheap, indexed, no external calls).
 * Flag persistence happens AFTER commit, so a risk-store failure can never
 * fail a transfer that already succeeded.
 */
@Injectable()
export class RiskEngineService {
  private readonly logger = new Logger(RiskEngineService.name);

  constructor(
    @Inject(RISK_REPOSITORY) private readonly risk: RiskRepositoryPort,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
  ) {}

  /** Gathers signals and runs every rule. Never throws — risk must not block money. */
  async assess(input: RiskEvaluationInput): Promise<RiskAssessment> {
    let signals: RiskSignals;

    try {
      signals = await this.risk.gatherSignals(input.senderUserId, input.receiverUserId);
    } catch (error) {
      // Fail open. A risk engine that can take down payments is a worse
      // problem than the fraud it prevents.
      this.logger.error(`Risk signal gathering failed: ${(error as Error).message}`);
      signals = {
        transfersInLastHour: 0,
        hasTransactedWithReceiverBefore: true,
        distinctReceiversLast24h: 0,
        daysSinceLastActivity: null,
      };
    }

    return this.evaluate(input, signals);
  }

  /**
   * Pure evaluation — signals in, assessment out.
   *
   * Separated from `assess` so the entire rule set is testable with no
   * repository, no database and no mocks.
   */
  evaluate(input: RiskEvaluationInput, signals: RiskSignals): RiskAssessment {
    const allRules: RuleOutcome[] = [
      this.ruleLargeRelativeToBalance(input),
      this.ruleNewCounterpartyLargeAmount(input, signals),
      this.ruleUnusualFrequency(signals),
      this.ruleReceiverFanOut(signals),
      this.ruleActivityAfterDormancy(input, signals),
    ];

    const triggeredRules = allRules.filter((rule) => rule.triggered);
    const score = triggeredRules.reduce((sum, rule) => sum + rule.weight, 0);

    return {
      level: this.toLevel(score),
      score,
      triggeredRules,
      allRules,
      shouldBlock: score >= SCORE_BLOCK,
    };
  }

  /**
   * RULE 1 — large transfer relative to balance.
   *
   * Draining an account is the tail of most takeover fraud: whoever has
   * control moves everything, once. Weighted MODESTLY on its own, because
   * legitimate "send everything" is common — paying rent, settling a debt. It
   * earns its keep in COMBINATION, which is why the engine sums weights rather
   * than escalating on any single rule.
   */
  private ruleLargeRelativeToBalance(input: RiskEvaluationInput): RuleOutcome {
    const rule = 'amount.large_relative_to_balance';

    if (input.senderBalancePoisha <= 0n) {
      return this.notTriggered(rule, 'Sender has no balance to compare against.');
    }

    // Ratio in basis points keeps this in integer arithmetic — no float ever
    // touches a money value, even in a heuristic.
    const ratioBps = Number((input.amountPoisha * 10_000n) / input.senderBalancePoisha);
    const ratio = ratioBps / 10_000;

    const evidence = {
      amountPoisha: input.amountPoisha.toString(),
      balancePoisha: input.senderBalancePoisha.toString(),
      ratio: Number(ratio.toFixed(4)),
    };

    if (ratio >= BALANCE_RATIO_EXTREME) {
      return {
        rule,
        triggered: true,
        weight: 25,
        explanation: `Transfer is ${(ratio * 100).toFixed(1)}% of the sender's balance — effectively emptying the wallet.`,
        evidence,
      };
    }

    if (ratio >= BALANCE_RATIO_ELEVATED) {
      return {
        rule,
        triggered: true,
        weight: 15,
        explanation: `Transfer is ${(ratio * 100).toFixed(1)}% of the sender's balance.`,
        evidence,
      };
    }

    return this.notTriggered(rule, `Transfer is ${(ratio * 100).toFixed(1)}% of balance.`, evidence);
  }

  /**
   * RULE 2 — first interaction with this receiver, and a large amount.
   *
   * The single strongest signal in the set, and the classic shape of a social
   * engineering scam: a victim is persuaded to send a significant sum to
   * someone they have never paid before. Either half alone is unremarkable —
   * everyone has a first transfer, and large transfers to a known counterparty
   * are routine. The CONJUNCTION is what matters, which is why this is one
   * rule and not two.
   */
  private ruleNewCounterpartyLargeAmount(
    input: RiskEvaluationInput,
    signals: RiskSignals,
  ): RuleOutcome {
    const rule = 'counterparty.first_interaction_large_amount';

    const isNewCounterparty = !signals.hasTransactedWithReceiverBefore;
    const isLargeAbsolute = input.amountPoisha >= LARGE_AMOUNT_POISHA;
    const isLargeRelative =
      input.senderBalancePoisha > 0n &&
      Number((input.amountPoisha * 10_000n) / input.senderBalancePoisha) / 10_000 >=
        NEW_COUNTERPARTY_RATIO;

    const evidence = {
      firstInteraction: isNewCounterparty,
      amountPoisha: input.amountPoisha.toString(),
      largeAbsolute: isLargeAbsolute,
      largeRelative: isLargeRelative,
    };

    if (isNewCounterparty && (isLargeAbsolute || isLargeRelative)) {
      const weight = isLargeAbsolute && isLargeRelative ? 45 : 35;
      return {
        rule,
        triggered: true,
        weight,
        explanation:
          'First transfer to this receiver, and the amount is large ' +
          (isLargeAbsolute && isLargeRelative
            ? 'in both absolute terms and relative to the balance.'
            : isLargeAbsolute
              ? 'in absolute terms.'
              : 'relative to the sender’s balance.'),
        evidence,
      };
    }

    return this.notTriggered(
      rule,
      isNewCounterparty
        ? 'First transfer to this receiver, but the amount is modest.'
        : 'Sender has transacted with this receiver before.',
      evidence,
    );
  }

  /**
   * RULE 3 — unusual transfer frequency.
   *
   * Automation looks different from a person. A human sends a handful of
   * transfers an hour; a compromised account being drained, or a script
   * testing stolen credentials, sends far more. This is also the rule that
   * catches a client stuck in a retry loop, which is an availability problem
   * rather than fraud but is equally worth knowing about.
   */
  private ruleUnusualFrequency(signals: RiskSignals): RuleOutcome {
    const rule = 'velocity.transfers_per_hour';
    const evidence = {
      transfersInLastHour: signals.transfersInLastHour,
      elevatedThreshold: VELOCITY_ELEVATED_PER_HOUR,
      extremeThreshold: VELOCITY_EXTREME_PER_HOUR,
    };

    if (signals.transfersInLastHour >= VELOCITY_EXTREME_PER_HOUR) {
      return {
        rule,
        triggered: true,
        weight: 40,
        explanation: `${signals.transfersInLastHour} transfers in the last hour — far above human pace.`,
        evidence,
      };
    }

    if (signals.transfersInLastHour >= VELOCITY_ELEVATED_PER_HOUR) {
      return {
        rule,
        triggered: true,
        weight: 20,
        explanation: `${signals.transfersInLastHour} transfers in the last hour is unusually frequent.`,
        evidence,
      };
    }

    return this.notTriggered(
      rule,
      `${signals.transfersInLastHour} transfers in the last hour is within normal range.`,
      evidence,
    );
  }

  /**
   * RULE 4 — fan-out to many distinct receivers.
   *
   * Not in the original three, added because it costs nothing (the signal is
   * already fetched) and catches what the others miss: money-mule layering,
   * where funds are split across many accounts to break the audit trail.
   * Velocity alone would not catch 15 transfers spread across a day.
   */
  private ruleReceiverFanOut(signals: RiskSignals): RuleOutcome {
    const rule = 'pattern.receiver_fan_out';
    const evidence = {
      distinctReceiversLast24h: signals.distinctReceiversLast24h,
      threshold: FANOUT_ELEVATED_PER_DAY,
    };

    if (signals.distinctReceiversLast24h >= FANOUT_ELEVATED_PER_DAY) {
      return {
        rule,
        triggered: true,
        weight: 25,
        explanation: `Money sent to ${signals.distinctReceiversLast24h} different people in 24 hours — a layering pattern.`,
        evidence,
      };
    }

    return this.notTriggered(
      rule,
      `${signals.distinctReceiversLast24h} distinct receivers in 24 hours.`,
      evidence,
    );
  }

  /**
   * RULE 4 — a large movement immediately after a long dormancy.
   *
   * The signature of a RECOVERED ACCOUNT. Credentials leaked months ago get
   * sold, tested, and eventually used; the account has been silent the whole
   * time because its owner forgot about it, which is also why nobody noticed
   * the compromise. The first thing an attacker does is move everything.
   *
   * Dormancy alone is innocent — plenty of people use a wallet twice a year.
   * A large amount alone is innocent. The CONJUNCTION is the signal, and it is
   * weighted heavily because a legitimate user returning after 90 days rarely
   * starts by emptying the account.
   *
   * A brand-new account (`daysSinceLastActivity === null`) is explicitly NOT
   * dormant. Scoring "never transacted" as "dormant" would flag every user's
   * genuine first transfer, which is the fastest way to make a fraud engine
   * ignored.
   */
  private ruleActivityAfterDormancy(
    input: RiskEvaluationInput,
    signals: RiskSignals,
  ): RuleOutcome {
    const rule = 'pattern.large_amount_after_dormancy';
    const days = signals.daysSinceLastActivity;

    const evidence = {
      daysSinceLastActivity: days,
      dormancyThresholdDays: DORMANCY_DAYS,
      amountPoisha: input.amountPoisha.toString(),
    };

    if (days === null) {
      return this.notTriggered(rule, 'No prior activity — a new account, not a dormant one.', evidence);
    }
    if (days < DORMANCY_DAYS) {
      return this.notTriggered(rule, `Last active ${days} days ago; within normal range.`, evidence);
    }

    const isLargeAbsolute = input.amountPoisha >= LARGE_AMOUNT_POISHA;
    const isLargeRelative =
      input.senderBalancePoisha > 0n &&
      Number((input.amountPoisha * 10_000n) / input.senderBalancePoisha) / 10_000 >=
        DORMANT_RETURN_RATIO;

    if (isLargeAbsolute || isLargeRelative) {
      return {
        rule,
        triggered: true,
        weight: 40,
        explanation:
          `Account was inactive for ${days} days and its first movement back is a large ` +
          'transfer — the pattern of a recovered or compromised account.',
        evidence: { ...evidence, largeAbsolute: isLargeAbsolute, largeRelative: isLargeRelative },
      };
    }

    return this.notTriggered(
      rule,
      `Returning after ${days} days, but the amount is modest.`,
      evidence,
    );
  }

  /**
   * Persists a flag for analyst review.
   *
   * Called AFTER the transfer commits. Never throws: the money has already
   * moved and is durably recorded, so failing the user's request because the
   * risk store was unavailable would be exactly backwards.
   */
  async recordAssessment(
    assessment: RiskAssessment,
    userId: string,
    transactionId: string | null,
  ): Promise<void> {
    if (assessment.level === 'LOW') return; // nothing worth an analyst's time

    const input: CreateRiskFlagInput = {
      id: this.ids.generate(),
      userId,
      transactionId,
      // The highest-weighted rule names the flag, so the queue sorts by cause.
      rule: assessment.triggeredRules.reduce((top, rule) =>
        rule.weight > top.weight ? rule : top,
      ).rule,
      severity: assessment.level,
      details: {
        score: assessment.score,
        level: assessment.level,
        triggered: assessment.triggeredRules.map((rule) => ({
          rule: rule.rule,
          weight: rule.weight,
          explanation: rule.explanation,
          evidence: rule.evidence,
        })),
      },
    };

    try {
      await this.risk.recordFlag(input);
      this.logger.warn(
        `Risk flag ${assessment.level} (score ${assessment.score}) for user ${userId}: ` +
          assessment.triggeredRules.map((rule) => rule.rule).join(', '),
      );
    } catch (error) {
      this.logger.error(`Could not persist risk flag: ${(error as Error).message}`);
    }
  }

  /**
   * The caller's own risk flags, with each rule's explanation intact.
   *
   * This is what makes the engine EXPLAINABLE in practice rather than in
   * principle: a user (or an analyst on their behalf) can see which rule fired,
   * what the threshold was, and what value crossed it. A score with no
   * explanation would be the same black box the rule-based design exists to
   * avoid.
   */
  async listFlagsForUser(userId: string, limit = 20) {
    const [flags, counts] = await Promise.all([
      this.risk.findForUser(userId, limit),
      this.risk.countsBySeverity(userId),
    ]);

    return {
      flags: flags.map((flag) => ({
        ...flag,
        // Surface the rule list from `details` so the client does not have to
        // know the shape the engine happened to store.
        triggeredRules:
          (flag.details.triggered as { rule: string; explanation: string; weight: number }[]) ?? [],
        score: (flag.details.score as number) ?? 0,
      })),
      counts: {
        LOW: counts.LOW ?? 0,
        MEDIUM: counts.MEDIUM ?? 0,
        HIGH: counts.HIGH ?? 0,
        CRITICAL: counts.CRITICAL ?? 0,
      },
      /** The thresholds themselves, so the UI can explain the scale honestly. */
      policy: {
        mediumAt: SCORE_MEDIUM,
        highAt: SCORE_HIGH,
        blockAt: SCORE_BLOCK,
        rules: [
          { rule: 'amount.large_relative_to_balance', maxWeight: 25 },
          { rule: 'counterparty.first_interaction_large_amount', maxWeight: 45 },
          { rule: 'velocity.transfers_per_hour', maxWeight: 40 },
          { rule: 'pattern.receiver_fan_out', maxWeight: 25 },
          { rule: 'pattern.large_amount_after_dormancy', maxWeight: 40 },
        ],
      },
    };
  }

  private toLevel(score: number): RiskLevel {
    if (score >= SCORE_HIGH) return 'HIGH';
    if (score >= SCORE_MEDIUM) return 'MEDIUM';
    return 'LOW';
  }

  private notTriggered(
    rule: string,
    explanation: string,
    evidence: Record<string, unknown> = {},
  ): RuleOutcome {
    return { rule, triggered: false, weight: 0, explanation, evidence };
  }
}
