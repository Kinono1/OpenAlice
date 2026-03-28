import { describe, expect, it } from "vitest";
import { evaluateExpertDecision } from "./expert_decision.js";
import type { NewsImpactSummary } from "./news_impact.js";

const neutralNews: NewsImpactSummary = {
  totalNews: 0,
  positiveNews: 0,
  negativeNews: 0,
  neutralNews: 0,
  highRiskNews: 0,
  sentimentScore: 0,
  riskScore: 0,
  topThemes: [],
  flags: [],
};

describe("expert_decision", () => {
  it("blocks trading when release gate disallows live trading", () => {
    const result = evaluateExpertDecision({
      symbol: "BTC/USD",
      strategy: {
        signal: 1,
        reason: "Ensemble long",
        ensembleScore: 0.6,
      },
      ml: {
        available: true,
        direction: "buy",
        confidence: 0.78,
        expectedReturnPct: 0.08,
        actionable: true,
      },
      news: neutralNews,
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-02-22T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: ["wfo"],
        warningChecks: [],
      },
      releaseGateMode: "live",
      policy: {
        requireReleaseGatePass: true,
      },
    });

    expect(result.tradeAllowed).toBe(false);
    expect(result.action).toBe("flat");
    expect(result.blockedBy.some((reason) => reason.includes("release_gate_failed"))).toBe(true);
  });

  it("allows paper-mode decisions when the release gate only approves paper trading", () => {
    const result = evaluateExpertDecision({
      symbol: "BTC/USD",
      strategy: {
        signal: 1,
        reason: "Paper long",
        ensembleScore: 0.65,
      },
      ml: {
        available: true,
        direction: "buy",
        confidence: 0.8,
        expectedReturnPct: 0.07,
        actionable: true,
      },
      news: neutralNews,
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-02-22T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: ["wfo"],
        warningChecks: [],
      },
      releaseGateMode: "paper",
      policy: {
        requireReleaseGatePass: true,
      },
    });

    expect(result.blockedBy).toHaveLength(0);
    expect(result.tradeAllowed).toBe(true);
    expect(result.action).toBe("long");
  });

  it("returns long decision when strategy and ML align with low risk news", () => {
    const result = evaluateExpertDecision({
      symbol: "BTC/USD",
      strategy: {
        signal: 1,
        reason: "Ensemble long",
        ensembleScore: 0.55,
      },
      ml: {
        available: true,
        direction: "buy",
        confidence: 0.8,
        expectedReturnPct: 0.09,
        actionable: true,
      },
      news: {
        ...neutralNews,
        totalNews: 5,
        positiveNews: 4,
        sentimentScore: 0.45,
        riskScore: 0.18,
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-02-22T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
    });

    expect(result.blockedBy).toHaveLength(0);
    expect(result.action).toBe("long");
    expect(result.tradeAllowed).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it("activates risk-off when news risk crosses threshold", () => {
    const result = evaluateExpertDecision({
      symbol: "ETH/USD",
      strategy: {
        signal: 1,
        reason: "Ensemble long",
        ensembleScore: 0.4,
      },
      ml: {
        available: true,
        direction: "buy",
        confidence: 0.74,
        expectedReturnPct: 0.06,
        actionable: true,
      },
      news: {
        ...neutralNews,
        totalNews: 8,
        negativeNews: 6,
        riskScore: 0.82,
        sentimentScore: -0.35,
        highRiskNews: 5,
      },
      policy: {
        riskOffNewsScore: 0.7,
      },
    });

    expect(result.tradeAllowed).toBe(false);
    expect(result.action).toBe("flat");
    expect(result.blockedBy).toContain("news_risk_breaker");
  });
});
