import { describe, expect, it } from "vitest";
import type { IAnalysisContext } from "../analysis-tools/interfaces";
import type { IMarketDataProvider, MarketData } from "../analysis-kit/data/interfaces";
import { createStrategyTools } from "./adapter";

function makeCandles(
  symbol: string,
  count: number,
  driftPerBar: number,
  waveScale: number,
): MarketData[] {
  const out: MarketData[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const wave = ((i % 10) - 5) * waveScale;
    const open = price;
    const close = Math.max(1, price + driftPerBar + wave);
    const high = Math.max(open, close) + 0.1;
    const low = Math.min(open, close) - 0.1;
    out.push({
      symbol,
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

const candlesBySymbol: Record<string, MarketData[]> = {
  "BTC/USD": makeCandles("BTC/USD", 500, 0.22, 0.04),
  "ETH/USD": makeCandles("ETH/USD", 500, 0.18, 0.025),
};

const marketDataProvider: IMarketDataProvider = {
  async getMarketData(_time: Date, symbol: string) {
    const candles = candlesBySymbol[symbol];
    if (!candles) {
      throw new Error(`Missing ${symbol} market data.`);
    }
    return candles[candles.length - 1];
  },
  async getMarketDataRange(_startTime: Date, _endTime: Date, symbol: string) {
    const candles = candlesBySymbol[symbol];
    if (!candles) {
      throw new Error(`Missing ${symbol} market data.`);
    }
    return candles;
  },
  getAvailableSymbols() {
    return Object.keys(candlesBySymbol);
  },
};

const ctx: IAnalysisContext = {
  getPlayheadTime: () => new Date(),
  getLatestOHLCV: async () => [],
  getNewsV2: async () => [],
  getAvailableSymbols: () => Object.keys(candlesBySymbol),
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

  it("accepts regimeTrend in strategyBacktest", async () => {
    const tools = createStrategyTools(ctx);

    const result = await (tools.strategyBacktest as any).execute({
      symbol: "BTC/USD",
      strategy: "regimeTrend",
      lookbackBars: 400,
      initialCapital: 10_000,
      params: {
        allowShort: false,
        trendFastPeriod: 10,
        trendSlowPeriod: 35,
        allowedEntryRegimes: ["LowVolTrend", "HighVolTrend"],
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
      },
    });

    expect(result.strategy).toBe("regimeTrend");
    expect(result.metrics).toHaveProperty("tradeCount");
    expect(result.lastDecision).toHaveProperty("strategy", "regimeTrend");
  });

  it("accepts regimeTrend plus regime params through strategyBacktest", async () => {
    const tools = createStrategyTools(ctx);

    const result = await (tools.strategyBacktest as any).execute({
      symbol: "BTC/USD",
      strategy: "regimeTrend",
      lookbackBars: 400,
      initialCapital: 10_000,
      params: {
        allowShort: false,
        trendFastPeriod: 10,
        trendSlowPeriod: 35,
        regimeVolWindow: 20,
        regimeAtrPeriod: 14,
        regimeFastPeriod: 12,
        regimeSlowPeriod: 48,
        allowedEntryRegimes: ["HighVolTrend", "LowVolTrend"],
        exitOnRegimeMismatch: true,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
      },
    });

    expect(result.strategy).toBe("regimeTrend");
    expect(result.lastDecision.strategy).toBe("regimeTrend");
    expect(result.lastDecision.indicators).toHaveProperty("regimeAllowed");
    expect(result.lastDecision.indicators).toHaveProperty("currentRegimeCode");
  });

  it("supports regimeTrend in strategyBacktest", async () => {
    const tools = createStrategyTools(ctx);

    const result = await (tools.strategyBacktest as any).execute({
      symbol: "BTC/USD",
      strategy: "regimeTrend",
      lookbackBars: 400,
      initialCapital: 10_000,
      params: {
        allowShort: false,
        trendFastPeriod: 10,
        trendSlowPeriod: 35,
        allowedEntryRegimes: ["HighVolTrend", "LowVolTrend"],
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
      },
    });

    expect(result.strategy).toBe("regimeTrend");
    expect(result.metrics.tradeCount).toBeGreaterThanOrEqual(0);
    expect(result.lastDecision.strategy).toBe("regimeTrend");
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
    expect(result.portfolioComparison.inverseVolWeighted).toHaveProperty(
      "portfolioTarget"
    );
    expect(
      result.portfolioComparison.inverseVolWeighted.portfolioTarget.basisEquityUsd
    ).toBe(10_000);
  });

  it("returns dual-symbol portfolio research for BTC and ETH with trend baseline context", async () => {
    const tools = createStrategyTools(ctx);

    const result = await (tools.strategyCompare as any).execute({
      symbol: "BTC/USD",
      symbols: ["BTC/USD", "ETH/USD"],
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
      significance: {
        enabled: true,
        partitions: 8,
        trialCount: 2,
        pboThreshold: 1,
        dsrMin: -10,
      },
    });

    expect(result.symbols).toEqual(["BTC/USD", "ETH/USD"]);
    expect(result.baselineStrategy).toBe("trend");
    expect(result.multiSymbolResearch.symbols).toEqual(["BTC/USD", "ETH/USD"]);
    expect(result.multiSymbolResearch.perSymbol).toHaveLength(2);
    expect(result.multiSymbolResearch.baseline.equalWeighted.strategy).toBe("trend");
    expect(
      result.multiSymbolResearch.inverseVolWeightedStrategyPortfolioRanking[0].significance
    ).toHaveProperty("candidateSetSize", 2);
    expect(
      result.multiSymbolResearch.baseline.inverseVolWeighted.portfolioTarget.positions.map(
        (position: any) => position.symbol,
      ),
    ).toEqual(["BTC/USD", "ETH/USD"]);
  });
});
