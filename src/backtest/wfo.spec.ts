import { describe, expect, it } from "vitest";
import type { MarketData } from "../extension/analysis-kit/data/interfaces";
import { createRollingWindows, runStrategyWalkForward } from "./wfo";

function makeCandles(count: number, trendPerBar = 0.25): MarketData[] {
  const out: MarketData[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const wave = ((i % 12) - 6) * 0.03;
    const open = price;
    const close = Math.max(1, price + trendPerBar + wave);
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

describe("wfo", () => {
  it("creates deterministic rolling windows", () => {
    const windows = createRollingWindows(500, {
      trainBars: 200,
      testBars: 60,
      stepBars: 60,
    });

    expect(windows.length).toBe(5);
    expect(windows[0]).toEqual({
      trainStart: 0,
      trainEndExclusive: 200,
      testStart: 200,
      testEndExclusive: 260,
    });
    expect(windows[4]).toEqual({
      trainStart: 240,
      trainEndExclusive: 440,
      testStart: 440,
      testEndExclusive: 500,
    });
  });

  it("runs walk-forward and returns per-window decisions", () => {
    const candles = makeCandles(420, 0.3);

    const result = runStrategyWalkForward({
      strategy: "trend",
      candles,
      candidates: [
        { allowShort: false, trendFastPeriod: 8, trendSlowPeriod: 30 },
        { allowShort: false, trendFastPeriod: 15, trendSlowPeriod: 45 },
      ],
      config: {
        trainBars: 180,
        testBars: 60,
        stepBars: 60,
        degradationThreshold: 0.8,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
      },
    });

    expect(result.windows.length).toBeGreaterThan(0);
    expect(result.windows[0].selectedCandidate.id).toMatch(/^candidate_/);
    expect(Number.isFinite(result.windows[0].degradationRate)).toBe(true);
  });

  it("fails gate when OOS trade-count gate is impossible to satisfy", () => {
    const candles = makeCandles(360, 0.15);

    const result = runStrategyWalkForward({
      strategy: "trend",
      candles,
      candidates: [{ allowShort: false, trendFastPeriod: 10, trendSlowPeriod: 30 }],
      config: {
        trainBars: 180,
        testBars: 60,
        stepBars: 60,
        minTradesPerWindow: 99_999,
      },
      costModel: {
        feeRate: 0.01,
        slippageBps: 500,
        latencyBars: 1,
      },
    });

    expect(result.overallPassed).toBe(false);
    expect(result.windows.some((w) => w.gateReason === "insufficient_oos_trades")).toBe(true);
  });
});
