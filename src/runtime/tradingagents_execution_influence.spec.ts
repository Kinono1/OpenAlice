import { describe, expect, it } from "vitest";
import type { ResearchDecisionV1 } from "./research_execution_contracts.js";
import type { TradingAgentsVerdictArtifact } from "./tradingagents_advisory_scorecard.js";
import { buildTradingAgentsExecutionInfluence } from "./tradingagents_execution_influence.js";
import type { PortfolioTargetArtifact } from "../portfolio/index.js";

function makeDecision(input: {
  action: "long" | "short" | "flat";
  signal?: -1 | 0 | 1;
  tradeAllowed?: boolean;
  suggestedExposurePct?: number;
}): ResearchDecisionV1 {
  const signal =
    input.signal ??
    (input.action === "long" ? 1 : input.action === "short" ? -1 : 0);
  return {
    schemaVersion: "research_decision.v1",
    generatedAt: "2026-03-27T00:00:00.000Z",
    symbol: "BTC/USD",
    decisionContext: {
      releaseGateMode: "paper",
    },
    marketContext: {
      lookbackBars: 240,
      windowStart: "2026-03-26T00:00:00.000Z",
      windowEnd: "2026-03-27T00:00:00.000Z",
    },
    provenance: {
      producer:
        input.action === "flat"
          ? "openalice.expert_quant_tools"
          : "tradingagents.sidecar",
      mode: input.action === "flat" ? "native" : "sidecar",
      sourceId:
        input.action === "flat"
          ? "openalice.expert_quant_tools"
          : "tradingagents.sidecar",
    },
    strategy: {
      signal,
      reason: "Reasoned view.",
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
      action: input.action,
      confidence: 0.7,
      tradeAllowed: input.tradeAllowed ?? true,
      blockedBy: [],
      reasons: ["Reasoned view."],
      suggestedExposurePct: input.suggestedExposurePct ?? 20,
    },
  };
}

function makeVerdict(
  state: TradingAgentsVerdictArtifact["state"],
): TradingAgentsVerdictArtifact {
  return {
    schemaVersion: "tradingagents_verdict.v1",
    generatedAt: "2026-03-27T00:00:00.000Z",
    sourceId: "tradingagents.sidecar",
    state,
    automaticRunsBlocked: state === "killed",
    paperInfluenceAllowed: state === "qualified_for_paper_influence",
    reasons: state === "killed" ? ["killed"] : [],
    evidence: {
      effectivePaperDays: 30,
      donorAttemptCount: 100,
      overlapCount: 25,
      donorOverlapHitRate: 0.6,
      directionalHitRateDelta: 0.1,
      fallbackInvalidRatio: 0.01,
    },
  };
}

function makePortfolioTarget(
  targetWeight: number,
): PortfolioTargetArtifact {
  return {
    schemaVersion: "portfolio_target.v1",
    generatedAt: "2026-03-27T00:00:00.000Z",
    targetWeights: {
      "BTC/USD": targetWeight,
    },
    grossExposure: Math.abs(targetWeight),
    netExposure: targetWeight,
    turnoverUsed: Math.abs(targetWeight),
    reasonCodes: [],
  };
}

describe("tradingagents_execution_influence", () => {
  it("returns baseline execution when donor verdict is killed", () => {
    const artifact = buildTradingAgentsExecutionInfluence({
      baselineDecision: makeDecision({ action: "long" }),
      donorDecision: makeDecision({ action: "long" }),
      verdict: makeVerdict("killed"),
      currentPosition: {
        symbol: "BTC/USD",
        netPosition: 0,
      },
      paperGate: {
        finalAllowPaperTrading: true,
        blockingReasons: [],
      },
      accountEquityUsd: 10_000,
      signalBarCloseTs: 1_700_000_000_000,
      submitDecisionTs: 1_700_000_000_000,
    });

    expect(artifact.outcome).toBe("baseline_only");
    expect(artifact.executionIntent?.action).toBe("placeOrder");
    expect(artifact.executionIntent?.order.side).toBe("buy");
    expect(artifact.reasonCodes).toContain("donor_verdict_killed");
  });

  it("promotes baseline flat to paper long when donor is qualified and bullish", () => {
    const artifact = buildTradingAgentsExecutionInfluence({
      baselineDecision: makeDecision({
        action: "flat",
        signal: 0,
        suggestedExposurePct: 0,
      }),
      donorDecision: makeDecision({
        action: "long",
        suggestedExposurePct: 25,
      }),
      verdict: makeVerdict("qualified_for_paper_influence"),
      currentPosition: {
        symbol: "BTC/USD",
        netPosition: 0,
      },
      paperGate: {
        finalAllowPaperTrading: true,
        blockingReasons: [],
      },
      accountEquityUsd: 10_000,
      signalBarCloseTs: 1_700_000_000_000,
      submitDecisionTs: 1_700_000_000_000,
    });

    expect(artifact.outcome).toBe("paper_influence_applied");
    expect(artifact.influenceAction).toBe("promote_long");
    expect(artifact.executionIntent?.action).toBe("placeOrder");
    expect(artifact.executionIntent?.order.usdSize).toBe(2500);
  });

  it("uses reduceOnly close when a qualified donor turns bearish while long", () => {
    const artifact = buildTradingAgentsExecutionInfluence({
      baselineDecision: makeDecision({ action: "long" }),
      donorDecision: makeDecision({ action: "short" }),
      verdict: makeVerdict("qualified_for_paper_influence"),
      currentPosition: {
        symbol: "BTC/USD",
        netPosition: 1,
      },
      paperGate: {
        finalAllowPaperTrading: true,
        blockingReasons: [],
      },
      accountEquityUsd: 10_000,
      signalBarCloseTs: 1_700_000_000_000,
      submitDecisionTs: 1_700_000_000_000,
    });

    expect(artifact.outcome).toBe("paper_influence_applied");
    expect(artifact.influenceAction).toBe("reduce_only_close");
    expect(artifact.executionIntent?.action).toBe("closePosition");
    expect(artifact.executionIntent?.order.reduceOnly).toBe(true);
    expect(artifact.executionIntent?.order.side).toBe("sell");
  });

  it("suppresses a new long open when the donor is bearish and there is no position", () => {
    const artifact = buildTradingAgentsExecutionInfluence({
      baselineDecision: makeDecision({ action: "long" }),
      donorDecision: makeDecision({ action: "short" }),
      verdict: makeVerdict("qualified_for_paper_influence"),
      currentPosition: {
        symbol: "BTC/USD",
        netPosition: 0,
      },
      paperGate: {
        finalAllowPaperTrading: true,
        blockingReasons: [],
      },
      accountEquityUsd: 10_000,
      signalBarCloseTs: 1_700_000_000_000,
      submitDecisionTs: 1_700_000_000_000,
    });

    expect(artifact.outcome).toBe("paper_influence_applied");
    expect(artifact.influenceAction).toBe("suppress_new_open");
    expect(artifact.executionIntent).toBeNull();
    expect(artifact.reasonCodes).toContain("donor_bearish_suppressed_new_open");
  });

  it("uses portfolio target weight instead of suggested exposure for new long sizing", () => {
    const artifact = buildTradingAgentsExecutionInfluence({
      baselineDecision: makeDecision({
        action: "flat",
        signal: 0,
        suggestedExposurePct: 0,
      }),
      donorDecision: makeDecision({
        action: "long",
        suggestedExposurePct: 25,
      }),
      verdict: makeVerdict("qualified_for_paper_influence"),
      currentPosition: {
        symbol: "BTC/USD",
        netPosition: 0,
      },
      portfolioTarget: makePortfolioTarget(0.1),
      paperGate: {
        finalAllowPaperTrading: true,
        blockingReasons: [],
      },
      accountEquityUsd: 10_000,
      signalBarCloseTs: 1_700_000_000_000,
      submitDecisionTs: 1_700_000_000_000,
    });

    expect(artifact.executionIntent?.action).toBe("placeOrder");
    expect(artifact.executionIntent?.order.usdSize).toBe(1000);
    expect(artifact.reasonCodes).toContain("sizing_source_portfolio_target");
  });

  it("scales into an existing long when portfolio target exceeds current weight", () => {
    const artifact = buildTradingAgentsExecutionInfluence({
      baselineDecision: makeDecision({ action: "long", suggestedExposurePct: 20 }),
      donorDecision: makeDecision({ action: "long", suggestedExposurePct: 20 }),
      verdict: makeVerdict("killed"),
      currentPosition: {
        symbol: "BTC/USD",
        netPosition: 1,
        currentWeight: 0.1,
      },
      portfolioTarget: makePortfolioTarget(0.25),
      paperGate: {
        finalAllowPaperTrading: true,
        blockingReasons: [],
      },
      accountEquityUsd: 10_000,
      signalBarCloseTs: 1_700_000_000_000,
      submitDecisionTs: 1_700_000_000_000,
    });

    expect(artifact.executionIntent?.action).toBe("placeOrder");
    expect(artifact.executionIntent?.order.side).toBe("buy");
    expect(artifact.executionIntent?.order.reduceOnly).toBe(false);
    expect(artifact.executionIntent?.order.usdSize).toBe(1500);
    expect(artifact.reasonCodes).toContain("portfolio_target_scale_in_long");
  });

  it("trims an existing long with reduceOnly sizing when portfolio target is lower", () => {
    const artifact = buildTradingAgentsExecutionInfluence({
      baselineDecision: makeDecision({ action: "long", suggestedExposurePct: 20 }),
      donorDecision: makeDecision({ action: "long", suggestedExposurePct: 20 }),
      verdict: makeVerdict("killed"),
      currentPosition: {
        symbol: "BTC/USD",
        netPosition: 1,
        currentWeight: 0.25,
      },
      portfolioTarget: makePortfolioTarget(0.1),
      paperGate: {
        finalAllowPaperTrading: true,
        blockingReasons: [],
      },
      accountEquityUsd: 10_000,
      signalBarCloseTs: 1_700_000_000_000,
      submitDecisionTs: 1_700_000_000_000,
    });

    expect(artifact.executionIntent?.action).toBe("placeOrder");
    expect(artifact.executionIntent?.order.side).toBe("sell");
    expect(artifact.executionIntent?.order.reduceOnly).toBe(true);
    expect(artifact.executionIntent?.order.usdSize).toBe(1500);
    expect(artifact.reasonCodes).toContain("portfolio_target_trim_long");
  });
});
