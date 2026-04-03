import {
  buildBreakoutCandidate,
  buildTrendCandidate,
  type CandidateConfig,
} from "./btc_paradigm_compiler.js";

export interface TradingAgentsDecision {
  schemaVersion?: string;
  symbol?: string;
  strategy?: {
    signal?: number;
    reason?: string;
  };
  news?: {
    sentimentScore?: number;
    riskScore?: number;
    positiveNews?: number;
    negativeNews?: number;
  };
  decision?: {
    action?: string;
    confidence?: number;
    tradeAllowed?: boolean;
    blockedBy?: string[];
    suggestedExposurePct?: number;
  };
}

export type TradingAgentsAction = "bullish" | "bearish" | "neutral";
export type TradingAgentsValidationPoolProfile =
  | "baseline_guard_v1"
  | "baseline_robust_anchor_v1"
  | "baseline_independent_guard_v1";

export const TRADINGAGENTS_VALIDATION_BENCHMARK_STRATEGY_ID = "BASELINE_CONTROL";
export const TRADINGAGENTS_ROBUSTNESS_ANCHOR_STRATEGY_ID = "ROBUSTNESS_ANCHOR";

export function normalizeTradingAgentsAction(
  decision: TradingAgentsDecision,
): TradingAgentsAction {
  const action = String(decision.decision?.action ?? "").toLowerCase();
  const signal = Number(decision.strategy?.signal ?? 0);
  const blockedBy = Array.isArray(decision.decision?.blockedBy)
    ? decision.decision.blockedBy.map((item) => String(item).toLowerCase())
    : [];
  if (action === "long" || signal > 0) {
    return "bullish";
  }
  if (
    signal < 0 ||
    blockedBy.some((item) => item.includes("sell") || item.includes("underweight"))
  ) {
    return "bearish";
  }
  return "neutral";
}

export function buildTradingAgentsDonorCandidate(
  decision: TradingAgentsDecision,
  symbol = "BTC/USD",
): CandidateConfig {
  const action = normalizeTradingAgentsAction(decision);

  if (action === "bearish") {
    return buildTrendCandidate({
      symbol,
      strategyId: "TA_DONOR_SHORT_SIGNAL",
      strategyName: "ta_donor_short_signal",
      familySuffix: "tradingagents_donor_signal_family",
      bucketSuffix: "ta_donor_short_signal",
      role: "donor",
      fast: 21,
      slow: 70,
      confirmBars: 1,
      minDiffPct: 0.005,
      allowShort: true,
    });
  }

  if (action === "bullish") {
    return buildTrendCandidate({
      symbol,
      strategyId: "TA_DONOR_LONG_SIGNAL",
      strategyName: "ta_donor_long_signal",
      familySuffix: "tradingagents_donor_signal_family",
      bucketSuffix: "ta_donor_long_signal",
      role: "donor",
      fast: 21,
      slow: 70,
      confirmBars: 1,
      minDiffPct: 0.005,
      allowShort: false,
    });
  }

  return buildTrendCandidate({
    symbol,
    strategyId: "TA_DONOR_NEUTRAL_GUARD",
    strategyName: "ta_donor_neutral_guard",
    familySuffix: "tradingagents_donor_signal_family",
    bucketSuffix: "ta_donor_neutral_guard",
    role: "donor",
    fast: 34,
    slow: 97,
    confirmBars: 3,
    minDiffPct: 0.01,
    allowShort: true,
  });
}

export function buildTradingAgentsBaselineControlCandidate(
  symbol = "BTC/USD",
): CandidateConfig {
  return buildTrendCandidate({
    symbol,
    strategyId: TRADINGAGENTS_VALIDATION_BENCHMARK_STRATEGY_ID,
    strategyName: "baseline_control_trend",
    familySuffix: "baseline_control_family",
    bucketSuffix: "baseline_control_bucket",
    role: "benchmark_control",
    fast: 50,
    slow: 100,
    confirmBars: 1,
    minDiffPct: 0,
    allowShort: false,
  });
}

export function buildTradingAgentsNeutralGuardControlCandidate(
  symbol = "BTC/USD",
): CandidateConfig {
  return buildTrendCandidate({
    symbol,
    strategyId: "NEUTRAL_GUARD",
    strategyName: "neutral_guard_trend",
    familySuffix: "neutral_guard_family",
    bucketSuffix: "neutral_guard_bucket",
    role: "independent_guard",
    fast: 34,
    slow: 97,
    confirmBars: 3,
    minDiffPct: 0.01,
    allowShort: true,
  });
}

export function buildTradingAgentsRobustnessAnchorCandidate(
  symbol = "BTC/USD",
): CandidateConfig {
  return buildTrendCandidate({
    symbol,
    strategyId: TRADINGAGENTS_ROBUSTNESS_ANCHOR_STRATEGY_ID,
    strategyName: "robustness_anchor_trend",
    familySuffix: "robustness_anchor_family",
    bucketSuffix: "robustness_anchor_bucket",
    role: "robustness_anchor",
    fast: 34,
    slow: 65,
    confirmBars: 1,
    minDiffPct: 0,
    allowShort: true,
  });
}

export function buildTradingAgentsIndependentGuardCandidate(
  symbol = "BTC/USD",
): CandidateConfig {
  return buildBreakoutCandidate({
    symbol,
    strategyId: "INDEPENDENT_GUARD",
    strategyName: "independent_guard_breakout",
    familySuffix: "independent_guard_breakout_family",
    bucketSuffix: "independent_guard_breakout_bucket",
    role: "independent_guard",
    breakoutPeriod: 48,
    exitPeriod: 16,
    allowShort: false,
  });
}

export function buildTradingAgentsValidationPool(
  decision: TradingAgentsDecision,
  symbol = "BTC/USD",
  profile: TradingAgentsValidationPoolProfile = "baseline_guard_v1",
): {
  benchmarkStrategyId: string;
  profile: TradingAgentsValidationPoolProfile;
  donorAction: TradingAgentsAction;
  donorCandidate: CandidateConfig;
  donorSignal: number;
  candidates: CandidateConfig[];
} {
  const donorAction = normalizeTradingAgentsAction(decision);
  const donorCandidate = buildTradingAgentsDonorCandidate(decision, symbol);
  const candidates =
    profile === "baseline_robust_anchor_v1"
      ? [
          donorCandidate,
          buildTradingAgentsBaselineControlCandidate(symbol),
          buildTradingAgentsRobustnessAnchorCandidate(symbol),
        ]
      : profile === "baseline_independent_guard_v1"
        ? [
            donorCandidate,
            buildTradingAgentsBaselineControlCandidate(symbol),
            buildTradingAgentsIndependentGuardCandidate(symbol),
          ]
      : [
          donorCandidate,
          buildTradingAgentsBaselineControlCandidate(symbol),
          buildTradingAgentsNeutralGuardControlCandidate(symbol),
        ];
  return {
    benchmarkStrategyId: TRADINGAGENTS_VALIDATION_BENCHMARK_STRATEGY_ID,
    profile,
    donorAction,
    donorCandidate,
    donorSignal: Number(decision.strategy?.signal ?? 0),
    candidates,
  };
}
