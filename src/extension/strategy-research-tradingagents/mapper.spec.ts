import { describe, expect, it } from "vitest";
import {
  mapTradingAgentsSidecarReportToResearchDecision,
  parseTradingAgentsSidecarReport,
  toTradingAgentsTicker,
} from "./mapper.js";
import type { TradingAgentsResearchRequest } from "./types.js";

function makeRequest(): TradingAgentsResearchRequest {
  return {
    schemaVersion: "tradingagents_sidecar_request.v1",
    generatedAt: "2026-03-26T12:00:00.000Z",
    symbol: "BTC/USD",
    marketContext: {
      lookbackBars: 240,
      windowStart: "2026-03-16T12:00:00.000Z",
      windowEnd: "2026-03-26T12:00:00.000Z",
      candles: [],
    },
    newsContext: {
      lookback: "72h",
      items: [
        {
          time: "2026-03-26T10:00:00.000Z",
          title: "ETF inflow remains constructive",
          content: "Strong demand and positive flow continue.",
          metadata: { source: "DeskWire" },
        },
        {
          time: "2026-03-26T11:00:00.000Z",
          title: "Exchange hack investigation expands",
          content: "Risk sentiment worsens after exploit headlines.",
          metadata: { source: "DeskWire" },
        },
      ],
    },
    decisionContext: {
      releaseGateMode: "paper",
      requireReleaseGatePass: true,
      selectedAnalysts: ["market", "news"],
      researchDepth: 2,
    },
  };
}

function makeReport(rating: string) {
  return parseTradingAgentsSidecarReport({
    schemaVersion: "tradingagents_sidecar_report.v1",
    generatedAt: "2026-03-26T12:00:00.000Z",
    symbol: "BTC-USD",
    tradeDate: "2026-03-26",
    provenance: {
      producer: "tradingagents",
      entrypoint: "run_openalice_research_sidecar.py",
      mode: "full",
    },
    config: {
      selectedAnalysts: ["market", "news"],
    },
    reports: {
      market: "Market regime remains constructive.",
      news: "Mixed news with one exploit-related headline.",
    },
    research: {
      portfolioManagerDecision: `FINAL TRANSACTION PROPOSAL: **${rating}**`,
      normalizedRecommendation: {
        rating,
        parser: "deterministic_regex",
      },
    },
  });
}

describe("strategy-research-tradingagents mapper", () => {
  it("maps BUY into a tradable long research decision when release gate passes", () => {
    const request = makeRequest();
    const decision = mapTradingAgentsSidecarReportToResearchDecision({
      report: makeReport("BUY"),
      request,
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-26T11:59:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: [],
        warningChecks: [],
      },
    });

    expect(decision.symbol).toBe("BTC/USD");
    expect(decision.provenance.mode).toBe("sidecar");
    expect(decision.strategy.signal).toBe(1);
    expect(decision.decision.action).toBe("long");
    expect(decision.decision.tradeAllowed).toBe(true);
    expect(decision.news.totalNews).toBe(2);
    expect(decision.news.highRiskNews).toBe(1);
  });

  it("keeps SELL advisory-only and blocks execution", () => {
    const decision = mapTradingAgentsSidecarReportToResearchDecision({
      report: makeReport("SELL"),
      request: makeRequest(),
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-26T11:59:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
    });

    expect(decision.strategy.signal).toBe(-1);
    expect(decision.decision.action).toBe("flat");
    expect(decision.decision.tradeAllowed).toBe(false);
    expect(decision.decision.blockedBy).toContain(
      "tradingagents_sell_requires_manual_translation",
    );
  });

  it("normalizes OpenAlice symbols into yfinance-style TradingAgents tickers", () => {
    expect(toTradingAgentsTicker("btc/usd")).toBe("BTC-USD");
  });
});
