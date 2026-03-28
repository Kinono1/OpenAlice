import { describe, expect, it } from "vitest";
import {
  buildExecutionIntentV1,
  buildResearchDecisionV1FromExpertQuantArtifact,
  validateExecutionIntentV1,
  validateResearchDecisionV1,
} from "./research_execution_contracts.js";

describe("research_execution_contracts", () => {
  it("builds a canonical research decision from the expert-quant artifact shape", () => {
    const windowStart = Date.parse("2026-03-26T00:00:00.000Z") / 1000;
    const windowEnd = Date.parse("2026-03-26T23:00:00.000Z") / 1000;

    const payload = buildResearchDecisionV1FromExpertQuantArtifact({
      symbol: "BTC/USD",
      generatedAt: "2026-03-26T14:00:00.000Z",
      lookbackBars: 240,
      window: {
        from: windowStart,
        to: windowEnd,
      },
      strategy: {
        signal: 1,
        reason: "Ensemble long",
        ensembleScore: 0.62,
        selectedStrategy: "ensemble",
        selectorMode: "strength",
        selectorReason: "best risk-adjusted signal",
        indicators: {
          ensembleScore: 0.62,
        },
        candidates: [
          {
            strategy: "trend",
            signal: 1,
            strength: 0.58,
            reason: "trend confirms breakout",
          },
        ],
      },
      ml: {
        available: true,
        direction: "buy",
        confidence: 0.78,
        expectedReturnPct: 0.06,
        actionable: true,
      },
      news: {
        totalNews: 4,
        positiveNews: 3,
        negativeNews: 0,
        neutralNews: 1,
        highRiskNews: 0,
        sentimentScore: 0.31,
        riskScore: 0.18,
        topThemes: [
          { theme: "institutional_flow", count: 2 },
          { theme: "onchain_flow", count: 1 },
        ],
        flags: [],
        latestHeadlines: [
          {
            time: "2026-03-26T13:00:00.000Z",
            title: "ETF inflows remain positive",
          },
        ],
      },
      releaseGate: {
        generatedAt: "2026-03-26T13:30:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: ["wfo"],
        warningChecks: [],
      },
      decision: {
        symbol: "BTC/USD",
        action: "long",
        confidence: 0.61,
        tradeAllowed: true,
        blockedBy: [],
        reasons: ["Ensemble long", "News stable"],
        suggestedExposurePct: 35,
        components: {
          strategyScore: 0.3,
          mlScore: 0.2,
          newsScore: 0.1,
          newsRiskPenalty: 0.05,
          disagreementPenalty: 0,
          totalScore: 0.55,
        },
        policy: {
          requireReleaseGatePass: true,
          requireMl: false,
          allowShort: true,
          minCompositeScore: 0.2,
          minMlConfidence: 0.55,
          minExpectedReturnPct: 0.03,
          riskOffNewsScore: 0.65,
        },
      },
    });

    expect(payload.schemaVersion).toBe("research_decision.v1");
    expect(payload.marketContext.windowStart).toBe("2026-03-26T00:00:00.000Z");
    expect(payload.marketContext.windowEnd).toBe("2026-03-26T23:00:00.000Z");
    expect(payload.decision.action).toBe("long");
    expect(validateResearchDecisionV1(payload).valid).toBe(true);
  });

  it("rejects malformed research decision payloads", () => {
    const result = validateResearchDecisionV1({
      schemaVersion: "research_decision.v1",
      generatedAt: "2026-03-26T14:00:00.000Z",
    });

    expect(result.valid).toBe(false);
    expect(result.blockingReasons.some((reason) => reason.includes("research_decision_schema_invalid"))).toBe(true);
  });

  it("builds and validates a canonical execution intent", () => {
    const payload = buildExecutionIntentV1({
      generatedAt: "2026-03-26T14:05:00.000Z",
      symbol: "BTC/USD",
      action: "placeOrder",
      side: "buy",
      type: "market",
      reduceOnly: false,
      usdSize: 500,
      expectedPrice: 87_500,
      idempotencyKey: "intent:btc:20260326:1405",
      signalBarCloseTs: 1_774_000_000_000,
      submitDecisionTs: 1_774_000_005_000,
      submitDeadlineMs: 15_000,
      orderStaleMs: 30_000,
      producer: "openalice.research_desk",
      strategyFamily: "vol_gated_trend",
      edgeScore: 0.42,
      releaseGateMode: "paper",
      sourceDecisionSchemaVersion: "research_decision.v1",
      sourceDecisionAction: "long",
    });

    expect(payload.schemaVersion).toBe("execution_intent.v1");
    expect(payload.order.usdSize).toBe(500);
    expect(validateExecutionIntentV1(payload).valid).toBe(true);
  });

  it("rejects execution intents that violate routing semantics", () => {
    const result = validateExecutionIntentV1(
      {
        schemaVersion: "execution_intent.v1",
        generatedAt: "2026-03-26T14:05:00.000Z",
        symbol: "BTC/USD",
        action: "closePosition",
        decisionContext: {
          releaseGateMode: "live",
        },
        provenance: {
          producer: "openalice.runtime",
        },
        order: {
          side: "sell",
          type: "limit",
          reduceOnly: false,
        },
        semantics: {
          idempotencyKey: "intent-002",
          signalBarCloseTs: 10_000,
          submitDecisionTs: 50_000,
          submitDeadlineMs: 15_000,
          orderStaleMs: 30_000,
        },
      },
      { rejectStale: true, nowMs: 50_001 },
    );

    expect(result.valid).toBe(false);
    expect(result.blockingReasons).toContain(
      "execution_intent_close_position_must_reduce_only",
    );
    expect(result.blockingReasons).toContain(
      "execution_intent_limit_price_missing",
    );
    expect(result.blockingReasons).toContain("execution_intent_stale");
  });
});
