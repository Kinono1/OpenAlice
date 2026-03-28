import { describe, expect, it } from "vitest";
import type { MarketData } from "../analysis-kit/data/interfaces";
import { runStrategyBacktest } from "./backtest";

function makeUptrendCandles(count: number): MarketData[] {
  const out: MarketData[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = 0.3 + (i % 10 === 0 ? 0.2 : 0);
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + 0.1;
    const low = Math.min(open, close) - 0.1;
    out.push({
      symbol: "BTC/USD",
      time: 1_700_000_000 + i * 3600,
      open,
      high,
      low,
      close,
      volume: 1_000 + i,
    });
    price = close;
  }
  return out;
}

function makeDowntrendCandles(count: number): MarketData[] {
  const out: MarketData[] = [];
  let price = 200;
  for (let i = 0; i < count; i++) {
    const drift = 0.35 + (i % 9 === 0 ? 0.15 : 0);
    const open = price;
    const close = Math.max(1, price - drift);
    const high = Math.max(open, close) + 0.1;
    const low = Math.min(open, close) - 0.1;
    out.push({
      symbol: "BTC/USD",
      time: 1_700_500_000 + i * 3600,
      open,
      high,
      low,
      close,
      volume: 900 + i,
    });
    price = close;
  }
  return out;
}

function makeShortSqueezeCandles(): MarketData[] {
  const out: MarketData[] = [];
  let price = 100;
  for (let i = 0; i < 140; i++) {
    let ret = -0.004;
    if (i >= 110) {
      ret = 0.003;
    }
    if (i === 100) {
      // +250% gap while strategy is likely short.
      ret = 2.5;
    }
    const open = price;
    const close = Math.max(0.01, price * (1 + ret));
    const high = Math.max(open, close) * 1.001;
    const low = Math.min(open, close) * 0.999;
    out.push({
      symbol: "BTC/USD",
      time: 1_700_100_000 + i * 3600,
      open,
      high,
      low,
      close,
      volume: 1_000 + i,
    });
    price = close;
  }
  return out;
}

describe("runStrategyBacktest", () => {
  it("produces positive return on an uptrend for trend strategy", () => {
    const candles = makeUptrendCandles(300);
    const result = runStrategyBacktest({
      strategy: "trend",
      candles,
      params: {
        allowShort: false,
        trendFastPeriod: 10,
        trendSlowPeriod: 30,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
        fundingRatePer8h: 0,
      },
    });

    expect(result.metrics.totalReturnPct).toBeGreaterThan(0);
    expect(result.metrics.tradeCount).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBe(candles.length);
  });

  it("supports ensemble strategy with weighted voting", () => {
    const candles = makeUptrendCandles(300);
    const result = runStrategyBacktest({
      strategy: "ensemble",
      candles,
      params: {
        allowShort: false,
        trendFastPeriod: 10,
        trendSlowPeriod: 30,
        ensembleThreshold: 0.2,
        ensembleWeights: {
          trend: 3,
          meanReversion: 1,
          breakout: 1,
        },
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
        fundingRatePer8h: 0,
      },
    });

    expect(result.metrics.totalReturnPct).toBeGreaterThan(0);
    expect(result.lastDecision.strategy).toBe("ensemble");
    expect(result.lastDecision.indicators.ensembleScore).toBeTypeOf("number");
  });

  it("supports a volatility-gated breakout seed family", () => {
    const candles = makeUptrendCandles(500);
    const result = runStrategyBacktest({
      strategy: "volBreakout",
      candles,
      params: {
        allowShort: false,
        breakoutPeriod: 20,
        breakoutExitPeriod: 10,
        volWindowBars: 30,
        volBaselineBars: 120,
        volTriggerRatio: 1.05,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
        fundingRatePer8h: 0,
      },
    });

    expect(result.lastDecision.strategy).toBe("volBreakout");
    expect(result.lastDecision.indicators.volRatio).toBeTypeOf("number");
    expect(result.equityCurve.length).toBe(candles.length);
  });

  it("keeps the pure vol no-trade filter flat", () => {
    const candles = makeUptrendCandles(500);
    const result = runStrategyBacktest({
      strategy: "volNoTradeFilter",
      candles,
      params: {
        allowShort: false,
        volWindowBars: 30,
        volBaselineBars: 120,
        volTriggerRatio: 1.05,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
        fundingRatePer8h: 0,
      },
    });

    expect(result.lastDecision.strategy).toBe("volNoTradeFilter");
    expect(result.metrics.tradeCount).toBe(0);
    expect(result.metrics.finalEquity).toBe(10_000);
    expect(result.lastDecision.indicators.volFilterActive).toBeTypeOf("number");
  });

  it("supports a volatility-gated trend mapping", () => {
    const candles = makeUptrendCandles(500);
    const result = runStrategyBacktest({
      strategy: "volTrend",
      candles,
      params: {
        allowShort: false,
        trendFastPeriod: 10,
        trendSlowPeriod: 30,
        volWindowBars: 30,
        volBaselineBars: 120,
        volTriggerRatio: 0.9,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
        fundingRatePer8h: 0,
      },
    });

    expect(result.lastDecision.strategy).toBe("volTrend");
    expect(result.metrics.totalReturnPct).toBeGreaterThan(0);
    expect(result.lastDecision.indicators.volGateOpen).toBeTypeOf("number");
  });

  it("keeps vol-trend flat when the gate is closed", () => {
    const candles = makeDowntrendCandles(500);
    const result = runStrategyBacktest({
      strategy: "volTrend",
      candles,
      params: {
        allowShort: false,
        trendFastPeriod: 10,
        trendSlowPeriod: 30,
        volWindowBars: 30,
        volBaselineBars: 120,
        volTriggerRatio: 10,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
        fundingRatePer8h: 0,
      },
      initialCapital: 10_000,
    });

    expect(result.lastDecision.strategy).toBe("volTrend");
    expect(result.lastDecision.signal).toBe(0);
    expect(result.lastDecision.reason).toContain("Vol gate closed");
  });

  it("caps liquidation path at zero equity instead of exploding metrics", () => {
    const candles = makeShortSqueezeCandles();
    const result = runStrategyBacktest({
      strategy: "trend",
      candles,
      params: {
        allowShort: true,
        trendFastPeriod: 8,
        trendSlowPeriod: 30,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
        fundingRatePer8h: 0,
      },
    });

    expect(result.metrics.finalEquity).toBeGreaterThanOrEqual(0);
    expect(result.metrics.totalReturnPct).toBeGreaterThanOrEqual(-100);
    expect(result.metrics.maxDrawdownPct).toBeLessThanOrEqual(100);
    expect(result.equityCurve[result.equityCurve.length - 1].equity).toBe(0);
  });
});
