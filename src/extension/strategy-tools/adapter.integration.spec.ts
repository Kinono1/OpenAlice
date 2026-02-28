import { describe, expect, it } from "vitest";
import type { IAnalysisContext } from "../analysis-tools/interfaces";
import type { IMarketDataProvider, MarketData } from "../analysis-kit/data/interfaces";
import { createStrategyTools } from "./adapter";

function makeCandles(count: number): MarketData[] {
  const out: MarketData[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const wave = ((i % 10) - 5) * 0.04;
    const open = price;
    const close = Math.max(1, price + 0.2 + wave);
    const high = Math.max(open, close) + 0.1;
    const low = Math.min(open, close) - 0.1;
    out.push({
      symbol: "BTC/USD",
      time: 1_700_000_000 + i * 3600,
      open,
      high,
      low,
      close,
      volume: 1000 + i,
    });
    price = close;
  }
  return out;
}

const candles = makeCandles(500);

const marketDataProvider: IMarketDataProvider = {
  async getMarketData() {
    return candles[candles.length - 1];
  },
  async getMarketDataRange(_startTime: Date, _endTime: Date, _symbol: string) {
    return candles;
  },
  getAvailableSymbols() {
    return ["BTC/USD"];
  },
};

const ctx: IAnalysisContext = {
  getPlayheadTime: () => new Date(),
  getLatestOHLCV: async () => [],
  getNewsV2: async () => [],
  getAvailableSymbols: () => ["BTC/USD"],
  calculatePreviousTime: (lookback: number) => {
    const d = new Date();
    d.setHours(d.getHours() - lookback);
    return d;
  },
  marketDataProvider,
};

describe("strategy-tools adapter integration", () => {
  it("returns WFO and significance sections for strategyBacktest", async () => {
    const tools = createStrategyTools(ctx);

    const result = await (tools.strategyBacktest as any).execute({
      symbol: "BTC/USD",
      strategy: "trend",
      lookbackBars: 400,
      initialCapital: 10_000,
      params: {
        allowShort: false,
        trendFastPeriod: 10,
        trendSlowPeriod: 35,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
      },
      wfo: {
        enabled: true,
        trainBars: 180,
        testBars: 60,
        stepBars: 60,
        candidates: [
          { allowShort: false, trendFastPeriod: 8, trendSlowPeriod: 30 },
          { allowShort: false, trendFastPeriod: 12, trendSlowPeriod: 45 },
        ],
      },
      significance: {
        enabled: true,
        partitions: 8,
        trialCount: 4,
        pboThreshold: 1,
        dsrMin: -10,
        candidates: [
          { allowShort: false, trendFastPeriod: 8, trendSlowPeriod: 30 },
          { allowShort: false, trendFastPeriod: 12, trendSlowPeriod: 45 },
        ],
      },
    });

    expect(result).toHaveProperty("wfo");
    expect(result).toHaveProperty("significance");
    expect(result.wfo.windows.length).toBeGreaterThan(0);
    expect(typeof result.significance.pbo).toBe("number");
  });

  it("returns portfolio comparison for strategyCompare", async () => {
    const tools = createStrategyTools(ctx);

    const result = await (tools.strategyCompare as any).execute({
      symbol: "BTC/USD",
      strategies: ["trend", "breakout"],
      lookbackBars: 400,
      initialCapital: 10_000,
      params: {
        allowShort: false,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
      },
      portfolio: {
        enabled: true,
        targetAnnualVolatility: 0.2,
        leverageCap: 2,
      },
    });

    expect(result).toHaveProperty("portfolioComparison");
    expect(result.portfolioComparison).toHaveProperty("equalWeighted");
    expect(result.portfolioComparison).toHaveProperty("inverseVolWeighted");
  });
});
