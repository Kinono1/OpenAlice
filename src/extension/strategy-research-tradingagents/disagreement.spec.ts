import { describe, expect, it } from "vitest";
import type { ResearchDecisionV1 } from "../../runtime/research_execution_contracts.js";
import {
  buildResearchDecisionOperatorSummary,
  buildTradingAgentsFallbackSummary,
  createResearchDecisionDisagreementArtifact,
} from "./disagreement.js";

function makeDecision(
  overrides: Partial<ResearchDecisionV1> & {
    decision?: Partial<ResearchDecisionV1["decision"]>;
    strategy?: Partial<ResearchDecisionV1["strategy"]>;
    news?: Partial<ResearchDecisionV1["news"]>;
    provenance?: Partial<ResearchDecisionV1["provenance"]>;
  } = {},
): ResearchDecisionV1 {
  return {
    schemaVersion: "research_decision.v1",
    generatedAt: "2026-03-26T12:00:00.000Z",
    symbol: "BTC/USD",
    decisionContext: {
      releaseGateMode: "paper",
    },
    marketContext: {
      lookbackBars: 240,
      windowStart: "2026-03-16T12:00:00.000Z",
      windowEnd: "2026-03-26T12:00:00.000Z",
    },
    provenance: {
      producer: "openalice.expert_quant_tools",
      mode: "native",
      ...overrides.provenance,
    },
    strategy: {
      signal: 1,
      reason: "Momentum remains constructive.",
      ...overrides.strategy,
    },
    ml: {
      available: false,
      direction: "hold",
    },
    news: {
      totalNews: 2,
      positiveNews: 1,
      negativeNews: 0,
      neutralNews: 1,
      highRiskNews: 0,
      sentimentScore: 0.2,
      riskScore: 0.1,
      topThemes: [
        { theme: "etf_flows", count: 1 },
        { theme: "macro", count: 1 },
      ],
      flags: [],
      ...overrides.news,
    },
    releaseGate: null,
    decision: {
      action: "long",
      confidence: 0.64,
      tradeAllowed: true,
      blockedBy: [],
      reasons: [
        "Momentum remains constructive.",
        "Risk score is contained.",
      ],
      suggestedExposurePct: 25,
      ...overrides.decision,
    },
    ...overrides,
  };
}

describe("strategy-research-tradingagents disagreement helpers", () => {
  it("builds an operator summary with compact headline and top reasons", () => {
    const summary = buildResearchDecisionOperatorSummary(makeDecision());

    expect(summary.sourceId).toBe("openalice.expert_quant_tools");
    expect(summary.headline).toContain("long");
    expect(summary.topReasons).toHaveLength(2);
    expect(summary.topThemes).toEqual(["etf_flows", "macro"]);
  });

  it("prefers provenance.sourceId when present in operator summaries", () => {
    const summary = buildResearchDecisionOperatorSummary(
      makeDecision({
        provenance: {
          producer: "tradingagents.raw_runner",
          sourceId: "tradingagents.sidecar",
          requestId: "req-1",
        },
      }),
    );

    expect(summary.sourceId).toBe("tradingagents.sidecar");
  });

  it("classifies action mismatches between baseline and donor", () => {
    const artifact = createResearchDecisionDisagreementArtifact({
      baseline: makeDecision(),
      donor: makeDecision({
        provenance: {
          producer: "tradingagents.sidecar",
          mode: "sidecar",
        },
        strategy: {
          signal: 0,
          reason: "No clear edge.",
        },
        decision: {
          action: "flat",
          confidence: 0.41,
          tradeAllowed: false,
          blockedBy: ["tradingagents_rating_missing"],
          reasons: ["No clear edge."],
          suggestedExposurePct: 0,
        },
      }),
      generatedAt: "2026-03-26T12:05:00.000Z",
    });

    expect(artifact.schemaVersion).toBe("research_disagreement.v1");
    expect(artifact.summary.relation).toBe("action_mismatch");
    expect(artifact.summary.actionDelta).toEqual({
      baseline: "long",
      donor: "flat",
    });
    expect(artifact.summary.tradeAllowedDelta.donor).toBe(false);
  });

  it("builds operator-facing fallback summaries with stable metadata", () => {
    const summary = buildTradingAgentsFallbackSummary({
      sourceId: "tradingagents.sidecar",
      symbol: "BTC/USD",
      requestId: "req-1",
      sidecarRunId: "run-1",
      inputHash: "abc123",
      failureCode: "sidecar_timeout",
      fallbackReason: "Timed out waiting for sidecar output.",
      timedOut: true,
      stderrDigest: "traceback:timeout",
      generatedAt: "2026-03-26T12:10:00.000Z",
    });

    expect(summary.schemaVersion).toBe("tradingagents_fallback_summary.v1");
    expect(summary.operatorVisible).toBe(true);
    expect(summary.timedOut).toBe(true);
    expect(summary.headline).toContain("sidecar_timeout");
    expect(summary.requestId).toBe("req-1");
    expect(summary.sidecarRunId).toBe("run-1");
    expect(summary.inputHash).toBe("abc123");
  });
});
