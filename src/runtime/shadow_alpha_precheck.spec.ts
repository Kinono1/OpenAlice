import { describe, expect, it } from "vitest";
import type { MarketData } from "../extension/analysis-kit/data/interfaces.js";
import type { ResearchDecisionV1 } from "./research_execution_contracts.js";
import { runShadowAlphaPrecheck } from "./shadow_alpha_precheck.js";

function makeBars(symbol: string, closes: number[]): MarketData[] {
  const startMs = Date.parse("2026-03-20T00:00:00.000Z");
  return closes.map((close, index) => ({
    symbol,
    time: (startMs + index * 60 * 60 * 1000) / 1000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000 + index,
  }));
}

function makeDecision(input: {
  symbol?: string;
  windowEnd: string;
  signal: -1 | 0 | 1;
  producer?: string;
  reason?: string;
  reasons?: string[];
}): ResearchDecisionV1 {
  return {
    schemaVersion: "research_decision.v1",
    generatedAt: "2026-03-26T12:00:00.000Z",
    symbol: input.symbol ?? "BTC/USD",
    decisionContext: {
      releaseGateMode: "paper",
    },
    marketContext: {
      lookbackBars: 240,
      windowStart: "2026-03-16T12:00:00.000Z",
      windowEnd: input.windowEnd,
    },
    provenance: {
      producer: input.producer ?? "tradingagents.sidecar",
      mode: "sidecar",
      sourceId: "tradingagents.sidecar",
    },
    strategy: {
      signal: input.signal,
      reason: input.reason ?? "Documented rationale.",
    },
    ml: {
      available: false,
      direction: "hold",
    },
    news: {
      totalNews: 0,
      positiveNews: 0,
      negativeNews: 0,
      neutralNews: 0,
      highRiskNews: 0,
      sentimentScore: 0,
      riskScore: 0,
      topThemes: [],
      flags: [],
    },
    releaseGate: null,
    decision: {
      action: input.signal > 0 ? "long" : input.signal < 0 ? "short" : "flat",
      confidence: 0.6,
      tradeAllowed: true,
      blockedBy: [],
      reasons: input.reasons ?? ["Documented rationale."],
      suggestedExposurePct: input.signal === 0 ? 0 : 25,
    },
  };
}

describe("runShadowAlphaPrecheck", () => {
  it("triggers kill criteria when donor directionality and operational quality are weak", () => {
    const bars = makeBars("BTC/USD", [100, 110, 120, 130, 140]);
    const baselineDecisions = [
      makeDecision({ windowEnd: "2026-03-20T00:00:00.000Z", signal: 1 }),
      makeDecision({ windowEnd: "2026-03-20T01:00:00.000Z", signal: 1 }),
      makeDecision({ windowEnd: "2026-03-20T02:00:00.000Z", signal: 1 }),
    ];
    const donorDecisions = [
      makeDecision({
        windowEnd: "2026-03-20T00:00:00.000Z",
        signal: -1,
        reason: "",
        reasons: [],
      }),
      makeDecision({
        windowEnd: "2026-03-20T01:00:00.000Z",
        signal: -1,
        reason: "",
        reasons: [],
      }),
      makeDecision({
        windowEnd: "2026-03-20T02:00:00.000Z",
        signal: -1,
        reason: "",
        reasons: [],
      }),
    ];

    const artifact = runShadowAlphaPrecheck({
      baselineDecisions,
      donorDecisions,
      priceBarsBySymbol: {
        "BTC/USD": bars,
      },
      donorFailures: {
        totalAttempts: 5,
        fallbackCount: 2,
        invalidCount: 1,
      },
      config: {
        lookaheadBars: 1,
        neutralReturnBps: 0,
      },
      generatedAt: "2026-03-26T12:00:00.000Z",
    });

    expect(artifact.schemaVersion).toBe("shadow_alpha_precheck.v1");
    expect(artifact.metrics.baselineOverlapHitRate).toBe(1);
    expect(artifact.metrics.donorOverlapHitRate).toBe(0);
    expect(artifact.metrics.directionalHitRateDelta).toBe(-1);
    expect(artifact.metrics.fallbackInvalidRatio).toBe(0.6);
    expect(artifact.killCriterion.shouldKill).toBe(true);
    expect(artifact.killCriterion.reasons).toEqual(
      expect.arrayContaining([
        "kill_overlap_hit_rate_below_min",
        "kill_donor_delta_not_positive",
        "kill_fallback_invalid_ratio_too_high",
        "kill_explainability_too_low",
      ]),
    );
    expect(artifact.perSymbol).toEqual([
      {
        symbol: "BTC/USD",
        baselineEvaluableCount: 3,
        donorEvaluableCount: 3,
        overlapCount: 3,
        baselineHitRate: 1,
        donorHitRate: 0,
        hitRateDelta: -1,
      },
    ]);
  });

  it("marks promotion eligible when donor beats baseline with clean coverage", () => {
    const bars = makeBars("BTC/USD", [100, 110, 120, 130]);
    const baselineDecisions = [
      makeDecision({
        windowEnd: "2026-03-20T00:00:00.000Z",
        signal: 0,
        producer: "openalice.expert_quant_tools",
      }),
      makeDecision({
        windowEnd: "2026-03-20T01:00:00.000Z",
        signal: -1,
        producer: "openalice.expert_quant_tools",
      }),
    ];
    const donorDecisions = [
      makeDecision({ windowEnd: "2026-03-20T00:00:00.000Z", signal: 1 }),
      makeDecision({ windowEnd: "2026-03-20T01:00:00.000Z", signal: 1 }),
    ];

    const artifact = runShadowAlphaPrecheck({
      baselineDecisions,
      donorDecisions,
      priceBarsBySymbol: {
        "BTC/USD": bars,
      },
      donorFailures: {
        totalAttempts: 2,
        fallbackCount: 0,
        invalidCount: 0,
      },
      config: {
        lookaheadBars: 1,
        neutralReturnBps: 0,
      },
      generatedAt: "2026-03-26T12:00:00.000Z",
    });

    expect(artifact.metrics.donorCoverageRatio).toBe(1);
    expect(artifact.metrics.overlapCoverageRatio).toBe(1);
    expect(artifact.metrics.baselineOverlapHitRate).toBe(0);
    expect(artifact.metrics.donorOverlapHitRate).toBe(1);
    expect(artifact.metrics.directionalHitRateDelta).toBe(1);
    expect(artifact.metrics.explainabilityCompleteness).toBe(1);
    expect(artifact.killCriterion.shouldKill).toBe(false);
    expect(artifact.promotionCheck.eligible).toBe(true);
    expect(artifact.promotionCheck.reasons).toEqual([]);
    expect(artifact.samples.donorOverlap.every((sample) => sample.hit)).toBe(true);
  });
});
