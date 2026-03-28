import { createHash } from "node:crypto";
import {
  buildExecutionIntentV1,
  type ExecutionIntentV1,
  type ResearchDecisionV1,
} from "./research_execution_contracts.js";
import type { TradingAgentsVerdictArtifact } from "./tradingagents_advisory_scorecard.js";
import type { PortfolioTargetArtifact } from "../portfolio/index.js";

export const TRADING_AGENTS_EXECUTION_INFLUENCE_SCHEMA_VERSION =
  "tradingagents_execution_influence.v1";

export interface TradingAgentsCurrentPositionState {
  symbol: string;
  netPosition: -1 | 0 | 1;
  currentWeight?: number;
}

export interface TradingAgentsPaperGateSnapshot {
  finalAllowPaperTrading: boolean;
  blockingReasons: string[];
}

export interface TradingAgentsHumanApprovalSnapshot {
  approved: boolean;
  approvedAt?: string;
  expiresAt?: string;
}

export interface TradingAgentsExecutionInfluenceInput {
  baselineDecision: ResearchDecisionV1;
  donorDecision?: ResearchDecisionV1 | null;
  verdict?: TradingAgentsVerdictArtifact | null;
  currentPosition: TradingAgentsCurrentPositionState;
  portfolioTarget?: PortfolioTargetArtifact | null;
  paperGate: TradingAgentsPaperGateSnapshot;
  humanApproval?: TradingAgentsHumanApprovalSnapshot | null;
  accountEquityUsd?: number;
  expectedPrice?: number;
  signalBarCloseTs: number;
  submitDecisionTs: number;
  submitDeadlineMs?: number;
  orderStaleMs?: number;
  generatedAt?: string;
}

export interface TradingAgentsExecutionInfluenceArtifact {
  schemaVersion: typeof TRADING_AGENTS_EXECUTION_INFLUENCE_SCHEMA_VERSION;
  generatedAt: string;
  symbol: string;
  verdictState: TradingAgentsVerdictArtifact["state"] | "missing";
  outcome: "baseline_only" | "paper_influence_applied" | "blocked";
  influenceAction:
    | "baseline_passthrough"
    | "promote_long"
    | "reduce_only_close"
    | "suppress_new_open"
    | "noop";
  reasonCodes: string[];
  paperGate: TradingAgentsPaperGateSnapshot;
  humanApprovalObserved: TradingAgentsHumanApprovalSnapshot | null;
  currentPosition: TradingAgentsCurrentPositionState;
  baseline: {
    action: ResearchDecisionV1["decision"]["action"];
    tradeAllowed: boolean;
    suggestedExposurePct: number;
  };
  donor: {
    action: ResearchDecisionV1["decision"]["action"];
    tradeAllowed: boolean;
    suggestedExposurePct: number;
  } | null;
  executionIntent: ExecutionIntentV1 | null;
}

type DecisionIntentPlan =
  | {
      kind: "noop";
      reasonCode: string;
    }
  | {
      kind: "intent";
      actionKind:
        | "baseline_open_long"
        | "baseline_scale_in_long"
        | "baseline_trim_long"
        | "baseline_close"
        | "donor_promote_long"
        | "donor_scale_in_long"
        | "donor_trim_long"
        | "donor_reduce_only_close";
      intent: ExecutionIntentV1;
      reasonCodes: string[];
    };

export function buildTradingAgentsExecutionInfluence(
  input: TradingAgentsExecutionInfluenceInput,
): TradingAgentsExecutionInfluenceArtifact {
  assertMatchingSymbol(input);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (!input.paperGate.finalAllowPaperTrading) {
    return finalizeArtifact(input, {
      generatedAt,
      verdictState: input.verdict?.state ?? "missing",
      outcome: "blocked",
      influenceAction: "noop",
      reasonCodes: [
        "paper_gate_blocked",
        ...input.paperGate.blockingReasons,
      ],
      executionIntent: null,
    });
  }

  const baselinePlan = buildBaselinePlan(input);
  const verdictState = input.verdict?.state ?? "missing";
  if (!input.donorDecision) {
    return finalizeFromPlan(input, baselinePlan, {
      generatedAt,
      verdictState,
      outcome: "baseline_only",
      influenceAction: "baseline_passthrough",
      extraReasonCodes: ["donor_missing"],
    });
  }

  if (verdictState !== "qualified_for_paper_influence") {
    return finalizeFromPlan(input, baselinePlan, {
      generatedAt,
      verdictState,
      outcome: "baseline_only",
      influenceAction: "baseline_passthrough",
      extraReasonCodes:
        verdictState === "killed"
          ? ["donor_verdict_killed"]
          : ["donor_not_qualified_for_paper_influence"],
    });
  }

  if (isBearishDecision(input.donorDecision)) {
    const reduceOnlyPlan = buildReduceOnlyPlan(input);
    if (reduceOnlyPlan.kind === "intent") {
      return finalizeArtifact(input, {
        generatedAt,
        verdictState,
        outcome: "paper_influence_applied",
        influenceAction: "reduce_only_close",
        reasonCodes: [
          "donor_bearish_reduce_only_applied",
          "donor_bearish_never_crosses_into_short",
          ...reduceOnlyPlan.reasonCodes,
        ],
        executionIntent: reduceOnlyPlan.intent,
      });
    }

    if (input.currentPosition.netPosition === 0) {
      return finalizeArtifact(input, {
        generatedAt,
        verdictState,
        outcome: "paper_influence_applied",
        influenceAction: "suppress_new_open",
        reasonCodes: [
          "donor_bearish_suppressed_new_open",
          reduceOnlyPlan.reasonCode,
        ],
        executionIntent: null,
      });
    }

    return finalizeFromPlan(input, baselinePlan, {
      generatedAt,
      verdictState,
      outcome: "baseline_only",
      influenceAction: "baseline_passthrough",
      extraReasonCodes: [reduceOnlyPlan.reasonCode],
    });
  }

  if (
    isBullishDecision(input.donorDecision) &&
    input.baselineDecision.decision.action === "flat" &&
    input.currentPosition.netPosition === 0
  ) {
    const promoteLongPlan = buildLongOpenIntent(input, input.donorDecision, {
      actionKind: "donor_promote_long",
    });
    if (promoteLongPlan.kind === "intent") {
      return finalizeArtifact(input, {
        generatedAt,
        verdictState,
        outcome: "paper_influence_applied",
        influenceAction: "promote_long",
        reasonCodes: [
          "donor_bullish_promoted_flat_to_long",
          ...promoteLongPlan.reasonCodes,
        ],
        executionIntent: promoteLongPlan.intent,
      });
    }

    return finalizeArtifact(input, {
      generatedAt,
      verdictState,
      outcome: "blocked",
      influenceAction: "noop",
      reasonCodes: [promoteLongPlan.reasonCode],
      executionIntent: null,
    });
  }

  return finalizeFromPlan(input, baselinePlan, {
    generatedAt,
    verdictState,
    outcome: "paper_influence_applied",
    influenceAction: "baseline_passthrough",
    extraReasonCodes: ["donor_did_not_change_baseline_path"],
  });
}

function buildBaselinePlan(
  input: TradingAgentsExecutionInfluenceInput,
): DecisionIntentPlan {
  const baseline = input.baselineDecision;
  if (baseline.decision.action === "long") {
    return buildLongOpenIntent(input, baseline, {
      actionKind: "baseline_open_long",
    });
  }

  if (input.currentPosition.netPosition === 1) {
    return buildCloseIntent(
      input,
      "sell",
      "baseline_close",
      "baseline_flat_reduce_only_close",
    );
  }

  if (input.currentPosition.netPosition === -1) {
    return buildCloseIntent(
      input,
      "buy",
      "baseline_close",
      "baseline_flat_reduce_only_buy_to_close",
    );
  }

  return {
    kind: "noop",
    reasonCode:
      baseline.decision.action === "short"
        ? "baseline_short_suppressed_without_open_short"
        : "baseline_flat_no_position",
  };
}

function buildReduceOnlyPlan(
  input: TradingAgentsExecutionInfluenceInput,
): DecisionIntentPlan {
  if (input.currentPosition.netPosition === 1) {
    return buildCloseIntent(
      input,
      "sell",
      "donor_reduce_only_close",
      "donor_bearish_close_long",
    );
  }
  if (input.currentPosition.netPosition === -1) {
    return buildCloseIntent(
      input,
      "buy",
      "donor_reduce_only_close",
      "donor_bearish_close_short",
    );
  }
  return {
    kind: "noop",
    reasonCode: "reduce_only_no_position",
  };
}

function buildLongOpenIntent(
  input: TradingAgentsExecutionInfluenceInput,
  decision: ResearchDecisionV1,
  metadata: {
    actionKind:
      | "baseline_open_long"
      | "baseline_scale_in_long"
      | "baseline_trim_long"
      | "donor_promote_long"
      | "donor_scale_in_long"
      | "donor_trim_long";
  },
): DecisionIntentPlan {
  if (!decision.decision.tradeAllowed) {
    return {
      kind: "noop",
      reasonCode: "decision_not_tradable",
    };
  }
  if (input.currentPosition.netPosition === -1) {
    return {
      kind: "noop",
      reasonCode: "short_position_not_supported_in_influence_v1",
    };
  }
  if (
    !Number.isFinite(input.accountEquityUsd) ||
    (input.accountEquityUsd ?? 0) <= 0
  ) {
    return {
      kind: "noop",
      reasonCode: "account_equity_required_for_open_long",
    };
  }

  const targetWeight = resolveTargetWeight(input, decision);
  if (targetWeight != null && targetWeight <= 0) {
    return {
      kind: "noop",
      reasonCode: "portfolio_target_non_positive_for_long",
    };
  }

  const desiredWeight =
    targetWeight ?? decision.decision.suggestedExposurePct / 100;
  const currentWeight = resolveCurrentWeight(input.currentPosition);
  let side: "buy" | "sell" = "buy";
  let reduceOnly = false;
  let weightDelta = desiredWeight;
  const reasonCodes =
    targetWeight == null
      ? ["sizing_source_suggested_exposure"]
      : ["sizing_source_portfolio_target"];

  if (input.currentPosition.netPosition === 1 && currentWeight == null) {
    return {
      kind: "noop",
      reasonCode: "already_long",
    };
  }

  if (input.currentPosition.netPosition === 1 && currentWeight != null) {
    const delta = desiredWeight - currentWeight;
    if (Math.abs(delta) < 1e-6) {
      return {
        kind: "noop",
        reasonCode: "already_at_target_long_weight",
      };
    }
    if (delta > 0) {
      side = "buy";
      reduceOnly = false;
      weightDelta = delta;
      reasonCodes.push("portfolio_target_scale_in_long");
    } else {
      side = "sell";
      reduceOnly = true;
      weightDelta = Math.abs(delta);
      reasonCodes.push("portfolio_target_trim_long");
    }
  } else if (targetWeight != null) {
    reasonCodes.push("portfolio_target_open_long");
  }

  const usdSize = roundUsd((input.accountEquityUsd ?? 0) * weightDelta);
  if (!Number.isFinite(usdSize) || usdSize <= 0) {
    return {
      kind: "noop",
      reasonCode: "open_long_usd_size_invalid",
    };
  }

  const intent = buildExecutionIntentV1({
    symbol: input.baselineDecision.symbol,
    action: "placeOrder",
    side,
    type: "market",
    reduceOnly,
    usdSize,
    expectedPrice: input.expectedPrice,
    idempotencyKey: buildInfluenceIdempotencyKey(
      input.baselineDecision.symbol,
      input.signalBarCloseTs,
      metadata.actionKind,
    ),
    signalBarCloseTs: input.signalBarCloseTs,
    submitDecisionTs: input.submitDecisionTs,
    submitDeadlineMs: input.submitDeadlineMs ?? 15_000,
    orderStaleMs: input.orderStaleMs ?? 30_000,
    producer: "openalice.tradingagents_execution_influence",
    strategyFamily: "tradingagents_paper_influence",
    edgeScore: decision.decision.confidence,
    releaseGateMode: input.baselineDecision.decisionContext.releaseGateMode,
    sourceDecisionSchemaVersion: decision.schemaVersion,
    sourceDecisionAction: decision.decision.action,
  });

  return {
    kind: "intent",
    actionKind: metadata.actionKind,
    intent,
    reasonCodes,
  };
}

function buildCloseIntent(
  input: TradingAgentsExecutionInfluenceInput,
  side: "buy" | "sell",
  actionKind: "baseline_close" | "donor_reduce_only_close",
  _reasonCode: string,
): DecisionIntentPlan {
  const intent = buildExecutionIntentV1({
    symbol: input.baselineDecision.symbol,
    action: "closePosition",
    side,
    type: "market",
    reduceOnly: true,
    expectedPrice: input.expectedPrice,
    idempotencyKey: buildInfluenceIdempotencyKey(
      input.baselineDecision.symbol,
      input.signalBarCloseTs,
      actionKind,
    ),
    signalBarCloseTs: input.signalBarCloseTs,
    submitDecisionTs: input.submitDecisionTs,
    submitDeadlineMs: input.submitDeadlineMs ?? 15_000,
    orderStaleMs: input.orderStaleMs ?? 30_000,
    producer: "openalice.tradingagents_execution_influence",
    strategyFamily: "tradingagents_paper_influence",
    edgeScore: input.baselineDecision.decision.confidence,
    releaseGateMode: input.baselineDecision.decisionContext.releaseGateMode,
    sourceDecisionSchemaVersion: input.baselineDecision.schemaVersion,
    sourceDecisionAction: input.baselineDecision.decision.action,
  });
  return {
    kind: "intent",
    actionKind,
    intent,
    reasonCodes: [],
  };
}

function finalizeFromPlan(
  input: TradingAgentsExecutionInfluenceInput,
  plan: DecisionIntentPlan,
  metadata: {
    generatedAt: string;
    verdictState: TradingAgentsVerdictArtifact["state"] | "missing";
    outcome: TradingAgentsExecutionInfluenceArtifact["outcome"];
    influenceAction: TradingAgentsExecutionInfluenceArtifact["influenceAction"];
    extraReasonCodes: string[];
  },
): TradingAgentsExecutionInfluenceArtifact {
  if (plan.kind === "intent") {
    return finalizeArtifact(input, {
      generatedAt: metadata.generatedAt,
      verdictState: metadata.verdictState,
      outcome: metadata.outcome,
      influenceAction: metadata.influenceAction,
      reasonCodes: [...metadata.extraReasonCodes, ...plan.reasonCodes],
      executionIntent: plan.intent,
    });
  }
  return finalizeArtifact(input, {
    generatedAt: metadata.generatedAt,
    verdictState: metadata.verdictState,
    outcome: metadata.outcome,
    influenceAction: "noop",
    reasonCodes: [...metadata.extraReasonCodes, plan.reasonCode],
    executionIntent: null,
  });
}

function finalizeArtifact(
  input: TradingAgentsExecutionInfluenceInput,
  value: {
    generatedAt: string;
    verdictState: TradingAgentsVerdictArtifact["state"] | "missing";
    outcome: TradingAgentsExecutionInfluenceArtifact["outcome"];
    influenceAction: TradingAgentsExecutionInfluenceArtifact["influenceAction"];
    reasonCodes: string[];
    executionIntent: ExecutionIntentV1 | null;
  },
): TradingAgentsExecutionInfluenceArtifact {
  return {
    schemaVersion: TRADING_AGENTS_EXECUTION_INFLUENCE_SCHEMA_VERSION,
    generatedAt: value.generatedAt,
    symbol: input.baselineDecision.symbol,
    verdictState: value.verdictState,
    outcome: value.outcome,
    influenceAction: value.influenceAction,
    reasonCodes: [...new Set(value.reasonCodes)],
    paperGate: {
      finalAllowPaperTrading: input.paperGate.finalAllowPaperTrading,
      blockingReasons: [...input.paperGate.blockingReasons],
    },
    humanApprovalObserved: input.humanApproval ?? null,
    currentPosition: input.currentPosition,
    baseline: {
      action: input.baselineDecision.decision.action,
      tradeAllowed: input.baselineDecision.decision.tradeAllowed,
      suggestedExposurePct: input.baselineDecision.decision.suggestedExposurePct,
    },
    donor: input.donorDecision
      ? {
          action: input.donorDecision.decision.action,
          tradeAllowed: input.donorDecision.decision.tradeAllowed,
          suggestedExposurePct:
            input.donorDecision.decision.suggestedExposurePct,
        }
      : null,
    executionIntent: value.executionIntent,
  };
}

function isBullishDecision(decision: ResearchDecisionV1): boolean {
  return (
    decision.decision.action === "long" &&
    decision.decision.tradeAllowed &&
    decision.strategy.signal > 0
  );
}

function isBearishDecision(decision: ResearchDecisionV1): boolean {
  return decision.strategy.signal < 0 || decision.decision.action === "short";
}

function assertMatchingSymbol(input: TradingAgentsExecutionInfluenceInput): void {
  const symbol = input.baselineDecision.symbol;
  if (input.currentPosition.symbol !== symbol) {
    throw new Error(
      `Current position symbol mismatch: ${input.currentPosition.symbol} vs ${symbol}`,
    );
  }
  if (input.donorDecision && input.donorDecision.symbol !== symbol) {
    throw new Error(
      `Donor decision symbol mismatch: ${input.donorDecision.symbol} vs ${symbol}`,
    );
  }
}

function buildInfluenceIdempotencyKey(
  symbol: string,
  signalBarCloseTs: number,
  actionKind: string,
): string {
  const safeSymbol = symbol.replace(/[^A-Za-z0-9]+/g, "_");
  const digest = createHash("sha256")
    .update(`${symbol}:${signalBarCloseTs}:${actionKind}`)
    .digest("hex")
    .slice(0, 12);
  return `ta_influence:${safeSymbol}:${signalBarCloseTs}:${actionKind}:${digest}`;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(2));
}

function resolveTargetWeight(
  input: TradingAgentsExecutionInfluenceInput,
  decision: ResearchDecisionV1,
): number | null {
  const targetWeight = input.portfolioTarget?.targetWeights?.[decision.symbol];
  return typeof targetWeight === "number" && Number.isFinite(targetWeight)
    ? targetWeight
    : null;
}

function resolveCurrentWeight(
  position: TradingAgentsCurrentPositionState,
): number | null {
  if (
    typeof position.currentWeight === "number" &&
    Number.isFinite(position.currentWeight)
  ) {
    return Math.max(0, position.currentWeight);
  }
  if (position.netPosition === 0) {
    return 0;
  }
  return null;
}
