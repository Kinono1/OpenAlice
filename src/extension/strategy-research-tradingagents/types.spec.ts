import { describe, expect, it } from "vitest";
import {
  computeTradingAgentsRequestInputHash,
  createTradingAgentsRequestMeta,
  normalizeTradingAgentsResearchRequest,
  validateTradingAgentsRequestFreshness,
  validateTradingAgentsStrictResearchRequest,
  type TradingAgentsResearchPayload,
  type TradingAgentsStrictResearchRequest,
} from "./types.js";

function makePayload(): TradingAgentsResearchPayload {
  return {
    symbol: "BTC/USD",
    marketContext: {
      lookbackBars: 240,
      windowStart: "2026-03-16T12:00:00.000Z",
      windowEnd: "2026-03-26T12:00:00.000Z",
      candles: [
        {
          symbol: "BTC/USD",
          time: 1_774_992_000,
          open: 100,
          high: 105,
          low: 99,
          close: 104,
          volume: 1_000,
        },
      ],
    },
    newsContext: {
      lookback: "72h",
      items: [
        {
          time: "2026-03-26T11:00:00.000Z",
          title: "ETF flows stay constructive",
          content: "Flows remain positive.",
          metadata: {
            source: "Desk",
            sentiment: "positive",
          },
        },
      ],
    },
    decisionContext: {
      releaseGateMode: "paper",
      requireReleaseGatePass: true,
      selectedAnalysts: ["market", "news"],
      researchDepth: 2,
    },
    derivedContext: {
      featureSummary: "momentum-positive",
      promptReadySummary: "BTC/USD with constructive momentum and supportive news.",
      aggregatedIndicators: {
        rsi: 63,
        macd: 1.2,
      },
    },
    supplementalContext: {
      fundamentals: "No material balance-sheet stress detected.",
      macroSummary: "Macro backdrop is stable.",
      providerMetadata: {
        vendor: "openalice",
        version: 1,
      },
      toolDiagnostics: {
        latencyMs: 42,
        usedCache: false,
      },
    },
  };
}

function makeStrictRequest(): TradingAgentsStrictResearchRequest {
  const payload = makePayload();
  return {
    schemaVersion: "tradingagents_sidecar_request.v1",
    requestMeta: createTradingAgentsRequestMeta({
      requestId: "req-1",
      sidecarRunId: "run-1",
      generatedAt: "2026-03-26T12:00:00.000Z",
      payload,
    }),
    payload,
  };
}

describe("strategy-research-tradingagents strict request helpers", () => {
  it("computes a canonical inputHash regardless of object insertion order", () => {
    const payloadA = makePayload();
    const payloadB: TradingAgentsResearchPayload = {
      supplementalContext: {
        toolDiagnostics: {
          usedCache: false,
          latencyMs: 42,
        },
        providerMetadata: {
          version: 1,
          vendor: "openalice",
        },
        macroSummary: "Macro backdrop is stable.",
        fundamentals: "No material balance-sheet stress detected.",
      },
      derivedContext: {
        aggregatedIndicators: {
          macd: 1.2,
          rsi: 63,
        },
        promptReadySummary: "BTC/USD with constructive momentum and supportive news.",
        featureSummary: "momentum-positive",
      },
      decisionContext: {
        researchDepth: 2,
        selectedAnalysts: ["market", "news"],
        requireReleaseGatePass: true,
        releaseGateMode: "paper",
      },
      newsContext: {
        items: [
          {
            metadata: {
              sentiment: "positive",
              source: "Desk",
            },
            content: "Flows remain positive.",
            title: "ETF flows stay constructive",
            time: "2026-03-26T11:00:00.000Z",
          },
        ],
        lookback: "72h",
      },
      marketContext: {
        candles: [
          {
            volume: 1_000,
            close: 104,
            low: 99,
            high: 105,
            open: 100,
            time: 1_774_992_000,
            symbol: "BTC/USD",
          },
        ],
        windowEnd: "2026-03-26T12:00:00.000Z",
        windowStart: "2026-03-16T12:00:00.000Z",
        lookbackBars: 240,
      },
      symbol: "BTC/USD",
    };

    expect(computeTradingAgentsRequestInputHash(payloadA)).toBe(
      computeTradingAgentsRequestInputHash(payloadB),
    );
  });

  it("normalizes a legacy request into strict request metadata with a stable hash", () => {
    const normalized = normalizeTradingAgentsResearchRequest(
      {
        schemaVersion: "tradingagents_sidecar_request.v1",
        generatedAt: "2026-03-26T12:00:00.000Z",
        symbol: "BTC/USD",
        marketContext: makePayload().marketContext,
        newsContext: makePayload().newsContext,
        decisionContext: makePayload().decisionContext,
      },
      {
        requestId: "legacy-req",
        sidecarRunId: "legacy-run",
      },
    );

    expect(normalized.requestMeta.requestId).toBe("legacy-req");
    expect(normalized.requestMeta.sidecarRunId).toBe("legacy-run");
    expect(normalized.requestMeta.inputHash).toBe(
      computeTradingAgentsRequestInputHash(normalized.payload),
    );
    expect(normalized.symbol).toBe(normalized.payload.symbol);
  });

  it("rejects strict requests with tampered payloads or missing required fields", () => {
    const request = makeStrictRequest();
    request.payload.symbol = "";
    request.payload.newsContext.lookback = "";

    const errors = validateTradingAgentsStrictResearchRequest(request);

    expect(errors).toContain("missing_symbol");
    expect(errors).toContain("missing_news_lookback");
  });

  it("detects input hash mismatches and stale request freshness", () => {
    const request = makeStrictRequest();
    request.payload.marketContext.windowEnd = "2026-03-26T12:05:00.000Z";

    expect(validateTradingAgentsStrictResearchRequest(request)).toContain(
      "input_hash_mismatch",
    );
    expect(
      validateTradingAgentsRequestFreshness(
        request.requestMeta,
        new Date("2026-03-26T12:06:00.001Z"),
      ),
    ).toContain("stale_context");
  });

  it("flags invalid generatedAt freshness metadata", () => {
    const request = makeStrictRequest();
    request.requestMeta.generatedAt = "not-a-timestamp";

    expect(
      validateTradingAgentsRequestFreshness(
        request.requestMeta,
        new Date("2026-03-26T12:00:00.000Z"),
      ),
    ).toEqual(["invalid_generated_at"]);
  });
});
