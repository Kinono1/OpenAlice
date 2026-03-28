import { describe, expect, it } from "vitest";
import type { MarketData } from "../analysis-kit/data/interfaces";
import { evaluateStrategy } from "./strategies";

function makeTrendCandles(count: number, driftPerBar: number): MarketData[] {
  const out: MarketData[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = Math.max(1, price + driftPerBar + ((i % 7) - 3) * 0.02);
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

function makeStrongDowntrendCandles(count: number): MarketData[] {
  const out: MarketData[] = [];
  let price = 220;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = Math.max(1, price - 0.45 - (i % 5) * 0.03);
    const high = Math.max(open, close) + 0.05;
    const low = Math.min(open, close) - 0.05;
    out.push({
      symbol: "BTC/USD",
      time: 1_700_900_000 + i * 3600,
      open,
      high,
      low,
      close,
      volume: 1_200 + i,
    });
    price = close;
  }
  return out;
}

describe("strategy volatility mappings", () => {
  it("keeps vol no-trade filter flat and reports filter state", () => {
    const candles = makeTrendCandles(500, 0.25);
    const decision = evaluateStrategy({
      strategy: "volNoTradeFilter",
      candles,
      index: candles.length - 1,
      currentPosition: 0,
      params: {
        volWindowBars: 30,
        volBaselineBars: 120,
        volTriggerRatio: 1.05,
      },
    });

    expect(decision.strategy).toBe("volNoTradeFilter");
    expect(decision.signal).toBe(0);
    expect(decision.indicators.volFilterActive).toBeTypeOf("number");
    expect(decision.indicators.volGateOpen).toBeTypeOf("number");
  });

  it("suppresses new vol-trend entries when the gate is closed", () => {
    const candles = makeTrendCandles(500, 0.25);
    const decision = evaluateStrategy({
      strategy: "volTrend",
      candles,
      index: candles.length - 1,
      currentPosition: 0,
      params: {
        allowShort: false,
        trendFastPeriod: 10,
        trendSlowPeriod: 30,
        volWindowBars: 30,
        volBaselineBars: 120,
        volTriggerRatio: 10,
      },
    });

    expect(decision.strategy).toBe("volTrend");
    expect(decision.signal).toBe(0);
    expect(decision.reason).toContain("suppressed");
  });

  it("allows vol-trend entries when the gate is open", () => {
    const candles = makeTrendCandles(500, 0.25);
    const decision = evaluateStrategy({
      strategy: "volTrend",
      candles,
      index: candles.length - 1,
      currentPosition: 0,
      params: {
        allowShort: false,
        trendFastPeriod: 10,
        trendSlowPeriod: 30,
        volWindowBars: 30,
        volBaselineBars: 120,
        volTriggerRatio: 0.9,
      },
    });

    expect(decision.strategy).toBe("volTrend");
    expect(decision.signal).toBe(1);
    expect(decision.reason).toContain("Vol gate open");
  });

  it("still lets vol-trend exit an existing long when the gate is closed", () => {
    const candles = makeStrongDowntrendCandles(220);
    const decision = evaluateStrategy({
      strategy: "volTrend",
      candles,
      index: candles.length - 1,
      currentPosition: 1,
      params: {
        allowShort: false,
        trendFastPeriod: 10,
        trendSlowPeriod: 30,
        volWindowBars: 30,
        volBaselineBars: 120,
        volTriggerRatio: 10,
      },
    });

    expect(decision.strategy).toBe("volTrend");
    expect(decision.signal).toBe(0);
    expect(decision.reason).toContain("existing position");
  });
});
