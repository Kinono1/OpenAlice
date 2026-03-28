import { describe, expect, it } from "vitest";
import type { MarketData } from "../extension/analysis-kit/data/interfaces.js";
import type { ResearchDecisionDisagreementArtifact } from "../extension/strategy-research-tradingagents/disagreement.js";
import type { ResearchDecisionV1 } from "./research_execution_contracts.js";
import {
  buildTradingAgentsAdvisoryScorecard,
  buildTradingAgentsVerdict,
} from "./tradingagents_advisory_scorecard.js";
import type { DonorValueScorecard } from "./donor_value_scorecard.js";

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
  windowEnd: string;
  signal: -1 | 0 | 1;
  producer?: string;
  symbol?: string;
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
      mode: input.producer ? "native" : "sidecar",
      sourceId: input.producer ? "openalice.expert_quant_tools" : "tradingagents.sidecar",
    },
    strategy: {
      signal: input.signal,
      reason: "Documented rationale.",
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
      tradeAllowed: input.signal >= 0,
      blockedBy: [],
      reasons: ["Documented rationale."],
      suggestedExposurePct: input.signal === 0 ? 0 : 25,
    },
  };
}

function makeDisagreement(
  relation: ResearchDecisionDisagreementArtifact["summary"]["relation"],
): ResearchDecisionDisagreementArtifact {
  return {
    schemaVersion: "research_disagreement.v1",
    generatedAt: "2026-03-26T12:00:00.000Z",
    symbol: "BTC/USD",
    baseline: {
      sourceId: "openalice.expert_quant_tools",
      symbol: "BTC/USD",
      action: "flat",
      signal: 0,
      confidence: 0.4,
      tradeAllowed: true,
      blockedBy: [],
      headline: "flat",
      topReasons: [],
      topThemes: [],
    },
    donor: {
      sourceId: "tradingagents.sidecar",
      symbol: "BTC/USD",
      action: "long",
      signal: 1,
      confidence: 0.7,
      tradeAllowed: true,
      blockedBy: [],
      headline: "long",
      topReasons: [],
      topThemes: [],
    },
    summary: {
      relation,
      headline: relation,
      confidenceDelta: 0.3,
      actionDelta: {
        baseline: "flat",
        donor: "long",
      },
      tradeAllowedDelta: {
        baseline: true,
        donor: true,
      },
      blockedByOnlyInBaseline: [],
      blockedByOnlyInDonor: [],
    },
  };
}

function makeDonorValueScorecard(
  state: DonorValueScorecard["state"],
  reasons: string[] = [],
): DonorValueScorecard {
  return {
    schemaVersion: "donor_value_scorecard.v1",
    generatedAt: "2026-03-26T12:00:00.000Z",
    state,
    counts: {
      sampleCount: 4,
      fallbackCount: state === "killed" ? 2 : 0,
    },
    metrics: {
      baselineHitRate: 0.5,
      donorHitRate: state === "qualified_for_paper_influence" ? 0.75 : 0.45,
      hitRateDelta: state === "qualified_for_paper_influence" ? 0.25 : -0.05,
      baselineExpectancyBps: 5,
      donorExpectancyBps: state === "qualified_for_paper_influence" ? 12 : 2,
      expectancyDeltaBps: state === "qualified_for_paper_influence" ? 7 : -3,
      fallbackRatio: state === "killed" ? 0.5 : 0,
      explainabilityCompleteness: 1,
    },
    byRegime: [],
    thresholds: {
      minHitRateDelta: 0,
      minExpectancyDeltaBps: 0,
      maxFallbackRatio: 0.1,
      minExplainability: 0.85,
    },
    reasons,
  };
}

describe("tradingagents_advisory_scorecard", () => {
  it("qualifies for paper influence when donor outperforms with sufficient evidence", () => {
    const bars = makeBars("BTC/USD", [100, 105, 110, 115, 120]);
    const baselineDecisions = [
      makeDecision({
        windowEnd: "2026-03-20T00:00:00.000Z",
        signal: 0,
        producer: "openalice.expert_quant_tools",
      }),
      makeDecision({
        windowEnd: "2026-03-21T00:00:00.000Z",
        signal: 0,
        producer: "openalice.expert_quant_tools",
      }),
    ];
    const donorDecisions = [
      makeDecision({ windowEnd: "2026-03-20T00:00:00.000Z", signal: 1 }),
      makeDecision({ windowEnd: "2026-03-21T00:00:00.000Z", signal: 1 }),
    ];

    const scorecard = buildTradingAgentsAdvisoryScorecard({
      baselineDecisions,
      donorDecisions,
      priceBarsBySymbol: { "BTC/USD": bars },
      donorFailures: {
        totalAttempts: 2,
        fallbackCount: 0,
        invalidCount: 0,
      },
      disagreements: [makeDisagreement("action_mismatch")],
      generatedAt: "2026-03-26T12:00:00.000Z",
      shadowConfig: {
        lookaheadBars: 1,
        neutralReturnBps: 0,
      },
      thresholds: {
        shadowActionableOverlapMin: 2,
        effectivePaperDaysMin: 2,
        donorAttemptCountMin: 2,
      },
    });
    const verdict = buildTradingAgentsVerdict(scorecard);

    expect(scorecard.metrics.donorOverlapHitRate).toBe(1);
    expect(scorecard.metrics.baselineOverlapHitRate).toBe(0);
    expect(scorecard.metrics.expectancyDeltaBps).toBeGreaterThan(0);
    expect(scorecard.disagreementSummary.byRelation.action_mismatch).toBe(1);
    expect(scorecard.regimeBuckets).not.toHaveLength(0);
    expect(verdict.state).toBe("qualified_for_paper_influence");
    expect(verdict.paperInfluenceAllowed).toBe(true);
    expect(verdict.automaticRunsBlocked).toBe(false);
  });

  it("kills the donor when shadow precheck is actionable and clearly bad", () => {
    const bars = makeBars("BTC/USD", [100, 110, 120, 130, 140]);
    const baselineDecisions = [
      makeDecision({
        windowEnd: "2026-03-20T00:00:00.000Z",
        signal: 1,
        producer: "openalice.expert_quant_tools",
      }),
      makeDecision({
        windowEnd: "2026-03-20T01:00:00.000Z",
        signal: 1,
        producer: "openalice.expert_quant_tools",
      }),
    ];
    const donorDecisions = [
      makeDecision({ windowEnd: "2026-03-20T00:00:00.000Z", signal: -1 }),
      makeDecision({ windowEnd: "2026-03-20T01:00:00.000Z", signal: -1 }),
    ];

    const scorecard = buildTradingAgentsAdvisoryScorecard({
      baselineDecisions,
      donorDecisions,
      priceBarsBySymbol: { "BTC/USD": bars },
      donorFailures: {
        totalAttempts: 3,
        fallbackCount: 1,
        invalidCount: 1,
      },
      generatedAt: "2026-03-26T12:00:00.000Z",
      shadowConfig: {
        lookaheadBars: 1,
        neutralReturnBps: 0,
      },
      thresholds: {
        shadowActionableOverlapMin: 2,
      },
    });
    const verdict = buildTradingAgentsVerdict(scorecard);

    expect(scorecard.shadowPrecheck.killCriterion.shouldKill).toBe(true);
    expect(verdict.state).toBe("killed");
    expect(verdict.automaticRunsBlocked).toBe(true);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining(["shadow_kill_overlap_hit_rate_below_min"]),
    );
  });

  it("downgrades an otherwise qualified donor to insufficient evidence when donor value is advisory only", () => {
    const bars = makeBars("BTC/USD", [100, 105, 110, 115, 120]);
    const baselineDecisions = [
      makeDecision({
        windowEnd: "2026-03-20T00:00:00.000Z",
        signal: 0,
        producer: "openalice.expert_quant_tools",
      }),
      makeDecision({
        windowEnd: "2026-03-21T00:00:00.000Z",
        signal: 0,
        producer: "openalice.expert_quant_tools",
      }),
    ];
    const donorDecisions = [
      makeDecision({ windowEnd: "2026-03-20T00:00:00.000Z", signal: 1 }),
      makeDecision({ windowEnd: "2026-03-21T00:00:00.000Z", signal: 1 }),
    ];

    const scorecard = buildTradingAgentsAdvisoryScorecard({
      baselineDecisions,
      donorDecisions,
      priceBarsBySymbol: { "BTC/USD": bars },
      donorFailures: {
        totalAttempts: 2,
        fallbackCount: 0,
        invalidCount: 0,
      },
      generatedAt: "2026-03-26T12:00:00.000Z",
      shadowConfig: {
        lookaheadBars: 1,
        neutralReturnBps: 0,
      },
      thresholds: {
        shadowActionableOverlapMin: 2,
        effectivePaperDaysMin: 2,
        donorAttemptCountMin: 2,
      },
    });

    const verdict = buildTradingAgentsVerdict(
      scorecard,
      makeDonorValueScorecard("advisory_only", [
        "donor_expectancy_below_min",
      ]),
    );

    expect(verdict.state).toBe("insufficient_evidence");
    expect(verdict.paperInfluenceAllowed).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        "donor_value_advisory_only",
        "donor_expectancy_below_min",
      ]),
    );
  });

  it("kills the donor immediately when donor value scorecard is killed", () => {
    const bars = makeBars("BTC/USD", [100, 105, 110, 115, 120]);
    const baselineDecisions = [
      makeDecision({
        windowEnd: "2026-03-20T00:00:00.000Z",
        signal: 0,
        producer: "openalice.expert_quant_tools",
      }),
      makeDecision({
        windowEnd: "2026-03-21T00:00:00.000Z",
        signal: 0,
        producer: "openalice.expert_quant_tools",
      }),
    ];
    const donorDecisions = [
      makeDecision({ windowEnd: "2026-03-20T00:00:00.000Z", signal: 1 }),
      makeDecision({ windowEnd: "2026-03-21T00:00:00.000Z", signal: 1 }),
    ];

    const scorecard = buildTradingAgentsAdvisoryScorecard({
      baselineDecisions,
      donorDecisions,
      priceBarsBySymbol: { "BTC/USD": bars },
      donorFailures: {
        totalAttempts: 2,
        fallbackCount: 0,
        invalidCount: 0,
      },
      generatedAt: "2026-03-26T12:00:00.000Z",
      shadowConfig: {
        lookaheadBars: 1,
        neutralReturnBps: 0,
      },
      thresholds: {
        shadowActionableOverlapMin: 2,
        effectivePaperDaysMin: 2,
        donorAttemptCountMin: 2,
      },
    });

    const verdict = buildTradingAgentsVerdict(
      scorecard,
      makeDonorValueScorecard("killed", ["donor_fallback_ratio_too_high"]),
    );

    expect(verdict.state).toBe("killed");
    expect(verdict.automaticRunsBlocked).toBe(true);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        "donor_value_killed",
        "donor_fallback_ratio_too_high",
      ]),
    );
  });
});
