import { describe, expect, it } from "vitest";
import {
  buildTradingAgentsDonorCandidate,
  buildTradingAgentsIndependentGuardCandidate,
  buildTradingAgentsRobustnessAnchorCandidate,
  buildTradingAgentsValidationPool,
  normalizeTradingAgentsAction,
  type TradingAgentsDecision,
} from "./tradingagents_manifest.js";

function makeDecision(input: {
  signal: number;
  action?: string;
  blockedBy?: string[];
}): TradingAgentsDecision {
  return {
    strategy: {
      signal: input.signal,
    },
    decision: {
      action: input.action,
      blockedBy: input.blockedBy ?? [],
    },
  };
}

describe("tradingagents_manifest", () => {
  it("maps bearish donor decisions into the short donor candidate and validation pool", () => {
    const decision = makeDecision({
      signal: -1,
      action: "flat",
      blockedBy: ["tradingagents_sell_requires_manual_translation"],
    });

    expect(normalizeTradingAgentsAction(decision)).toBe("bearish");
    expect(buildTradingAgentsDonorCandidate(decision).strategyId).toBe(
      "TA_DONOR_SHORT_SIGNAL",
    );

    const pool = buildTradingAgentsValidationPool(decision);
    expect(pool.benchmarkStrategyId).toBe("BASELINE_CONTROL");
    expect(pool.donorAction).toBe("bearish");
    expect(pool.candidates.map((candidate) => candidate.strategyId)).toEqual([
      "TA_DONOR_SHORT_SIGNAL",
      "BASELINE_CONTROL",
      "NEUTRAL_GUARD",
    ]);
    expect(pool.candidates.map((candidate) => candidate.role)).toEqual([
      "donor",
      "benchmark_control",
      "independent_guard",
    ]);
    expect(new Set(pool.candidates.map((candidate) => candidate.hypothesisFamily)).size).toBe(3);
  });

  it("maps bullish donor decisions into the long donor candidate and validation pool", () => {
    const decision = makeDecision({
      signal: 1,
      action: "long",
    });

    expect(normalizeTradingAgentsAction(decision)).toBe("bullish");
    expect(buildTradingAgentsDonorCandidate(decision).strategyId).toBe(
      "TA_DONOR_LONG_SIGNAL",
    );

    const pool = buildTradingAgentsValidationPool(decision);
    expect(pool.donorAction).toBe("bullish");
    expect(pool.donorCandidate.strategyId).toBe("TA_DONOR_LONG_SIGNAL");
    expect(pool.candidates).toHaveLength(3);
  });

  it("maps neutral donor decisions into the neutral donor guard candidate and keeps fixed controls", () => {
    const decision = makeDecision({
      signal: 0,
      action: "flat",
    });

    expect(normalizeTradingAgentsAction(decision)).toBe("neutral");
    expect(buildTradingAgentsDonorCandidate(decision).strategyId).toBe(
      "TA_DONOR_NEUTRAL_GUARD",
    );

    const pool = buildTradingAgentsValidationPool(decision);
    expect(pool.donorAction).toBe("neutral");
    expect(pool.candidates.map((candidate) => candidate.strategy)).toEqual([
      "trend",
      "trend",
      "trend",
    ]);
    expect(pool.candidates[1]?.params).toMatchObject({
      trendFastPeriod: 50,
      trendSlowPeriod: 100,
      allowShort: false,
    });
    expect(pool.candidates[2]?.params).toMatchObject({
      trendFastPeriod: 34,
      trendSlowPeriod: 97,
      trendConfirmBars: 3,
      trendMinDiffPct: 0.01,
      allowShort: true,
    });
  });

  it("builds the robustness-anchor validation pool variant without changing donor or benchmark", () => {
    const decision = makeDecision({
      signal: -1,
      action: "flat",
      blockedBy: ["tradingagents_sell_requires_manual_translation"],
    });

    const anchor = buildTradingAgentsRobustnessAnchorCandidate();
    expect(anchor.strategyId).toBe("ROBUSTNESS_ANCHOR");
    expect(anchor.params).toMatchObject({
      trendFastPeriod: 34,
      trendSlowPeriod: 65,
      trendConfirmBars: 1,
      trendMinDiffPct: 0,
      allowShort: true,
    });

    const pool = buildTradingAgentsValidationPool(
      decision,
      "BTC/USD",
      "baseline_robust_anchor_v1",
    );
    expect(pool.profile).toBe("baseline_robust_anchor_v1");
    expect(pool.candidates.map((candidate) => candidate.strategyId)).toEqual([
      "TA_DONOR_SHORT_SIGNAL",
      "BASELINE_CONTROL",
      "ROBUSTNESS_ANCHOR",
    ]);
    expect(new Set(pool.candidates.map((candidate) => candidate.hypothesisFamily)).size).toBe(3);
    expect(new Set(pool.candidates.map((candidate) => candidate.correlationBucket)).size).toBe(3);
  });

  it("builds the independent-guard validation pool variant using a fixed mean-reversion control", () => {
    const decision = makeDecision({
      signal: -1,
      action: "flat",
      blockedBy: ["tradingagents_sell_requires_manual_translation"],
    });

    const independentGuard = buildTradingAgentsIndependentGuardCandidate();
    expect(independentGuard.strategy).toBe("breakout");
    expect(independentGuard.role).toBe("independent_guard");
    expect(independentGuard.params).toMatchObject({
      breakoutPeriod: 48,
      breakoutExitPeriod: 16,
      allowShort: false,
    });

    const pool = buildTradingAgentsValidationPool(
      decision,
      "BTC/USD",
      "baseline_independent_guard_v1",
    );
    expect(pool.profile).toBe("baseline_independent_guard_v1");
    expect(pool.candidates.map((candidate) => candidate.strategyId)).toEqual([
      "TA_DONOR_SHORT_SIGNAL",
      "BASELINE_CONTROL",
      "INDEPENDENT_GUARD",
    ]);
    expect(pool.candidates.map((candidate) => candidate.role)).toEqual([
      "donor",
      "benchmark_control",
      "independent_guard",
    ]);
  });
});
