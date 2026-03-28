import { describe, expect, it } from "vitest";
import type { IAnalysisContext } from "../analysis-tools/interfaces.js";
import type { IMarketDataProvider, MarketData, NewsItem } from "../analysis-kit/data/interfaces.js";
import { createExpertQuantTools } from "./adapter.js";

function makeCandles(count: number): MarketData[] {
  const out: MarketData[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = 0.18 + ((i % 11) - 5) * 0.02;
    const open = price;
    const close = Math.max(1, price + drift);
    out.push({
      symbol: "BTC/USD",
      time: 1_700_000_000 + i * 3600,
      open,
      high: Math.max(open, close) + 0.12,
      low: Math.min(open, close) - 0.12,
      close,
      volume: 1_000 + i,
    });
    price = close;
  }
  return out;
}

const candles = makeCandles(600);

function makeRangeCandles(count: number): MarketData[] {
  const out: MarketData[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = i % 2 === 0 ? 0.08 : -0.08;
    const open = price;
    const close = Math.max(1, price + drift);
    out.push({
      symbol: "BTC/USD",
      time: 1_700_000_000 + i * 3600,
      open,
      high: Math.max(open, close) + 0.12,
      low: Math.min(open, close) - 0.12,
      close,
      volume: 1_000 + i,
    });
    price = close;
  }
  return out;
}

const mockNews: NewsItem[] = [
  {
    time: new Date("2026-02-22T09:00:00.000Z"),
    title: "Spot ETF records net inflow and institutional accumulation",
    content: "Inflow remains positive and market sentiment stabilizes.",
    metadata: { source: "TechFlow", category: "crypto-news" },
  },
  {
    time: new Date("2026-02-22T10:00:00.000Z"),
    title: "Ethereum roadmap upgrade gains developer support",
    content: "Upgrade and adoption narrative improve medium-term confidence.",
    metadata: { source: "TechFlow", category: "crypto-news" },
  },
];

const benignNews: NewsItem[] = [
  {
    time: new Date("2026-02-22T09:00:00.000Z"),
    title: "ETF inflow remains steady and desks report balanced positioning",
    content: "Liquidity stays healthy while market commentary remains calm.",
    metadata: { source: "TechFlow", category: "crypto-news" },
  },
];

function makeContext(input: {
  candles: MarketData[];
  news?: NewsItem[];
}): IAnalysisContext {
  const marketDataProvider: IMarketDataProvider = {
    async getMarketData() {
      return input.candles[input.candles.length - 1];
    },
    async getMarketDataRange(
      _startTime: Date,
      _endTime: Date,
      _symbol: string,
    ) {
      return input.candles;
    },
    getAvailableSymbols() {
      return ["BTC/USD"];
    },
  };

  return {
    getPlayheadTime: () => new Date("2026-02-22T12:00:00.000Z"),
    getLatestOHLCV: async () => [],
    getNewsV2: async () => input.news ?? mockNews,
    getAvailableSymbols: () => ["BTC/USD"],
    calculatePreviousTime: (lookback: number) => {
      const now = new Date("2026-02-22T12:00:00.000Z");
      now.setHours(now.getHours() - lookback);
      return now;
    },
    marketDataProvider,
  };
}

describe("expert-quant-tools adapter integration", () => {
  it("returns structured expert decision output", async () => {
    const tools = createExpertQuantTools(
      makeContext({ candles, news: mockNews }),
    );

    const result = await (tools.expertQuantDecision as any).execute({
      symbol: "BTC/USD",
      lookbackBars: 500,
      useMl: false,
      requireReleaseGatePass: false,
      policy: {
        minCompositeScore: 0.15,
        allowShort: true,
      },
    });

    expect(result.symbol).toBe("BTC/USD");
    expect(result).toHaveProperty("strategy");
    expect(result).toHaveProperty("news");
    expect(result).toHaveProperty("decision");
    expect(result).toHaveProperty("researchDecision");
    expect(result).toHaveProperty("regimeSnapshot");
    expect(result.decision).toHaveProperty("action");
    expect(["long", "short", "flat"]).toContain(result.decision.action);
    expect(typeof result.decision.confidence).toBe("number");
    expect(result.news.totalNews).toBeGreaterThan(0);
    expect(result.regimeSnapshot.schemaVersion).toBe("regime_snapshot.v1");
    expect(result.researchDecision.schemaVersion).toBe("research_decision.v1");
    expect(result.researchDecision.symbol).toBe("BTC/USD");
  });

  it("filters strategy families and bumps thresholds in range regimes", async () => {
    const tools = createExpertQuantTools(
      makeContext({
        candles: makeRangeCandles(600),
        news: benignNews,
      }),
    );

    const result = await (tools.expertQuantDecision as any).execute({
      symbol: "BTC/USD",
      lookbackBars: 500,
      useMl: false,
      requireReleaseGatePass: false,
      policy: {
        minCompositeScore: 0.2,
        allowShort: true,
      },
    });

    expect(result.regimeSnapshot.regimeId).toBe("range");
    expect(result.strategy.candidates.map((item: any) => item.strategy)).toEqual(
      expect.arrayContaining(["meanReversion", "ensemble"]),
    );
    expect(result.strategy.candidates).toHaveLength(2);
    expect(result.decision.policy.minCompositeScore).toBe(0.25);
    expect(result.decision.reasons).toContain(
      "Regime range exposureScale=0.70 minCompositeScoreBump=0.05.",
    );
  });
});
