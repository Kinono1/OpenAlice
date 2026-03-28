import { describe, expect, it } from "vitest";
import type { MarketData } from "../extension/analysis-kit/data/interfaces.js";
import { buildRegimeSnapshot } from "./regime_snapshot";

function makeBars(deltas: number[]): MarketData[] {
  let price = 100;
  return deltas.map((delta, index) => {
    const open = price;
    price += delta;
    const close = price;
    return {
      symbol: "BTC/USD",
      time: 1_700_000_000 + index * 3600,
      open,
      high: Math.max(open, close) + 0.2,
      low: Math.min(open, close) - 0.2,
      close,
      volume: 1000 + index,
    };
  });
}

describe("regime snapshot", () => {
  it("classifies upward momentum as trend_up", () => {
    const bars = makeBars(Array.from({ length: 120 }, () => 0.4));
    const snapshot = buildRegimeSnapshot({
      symbol: "BTC/USD",
      bars,
      config: { recentBars: 24, momentumThresholdPct: 0.01 },
    });

    expect(snapshot.regimeId).toBe("trend_up");
    expect(snapshot.thresholdProfile.maxExposureScale).toBe(1);
    expect(snapshot.allowedStrategyFamilies).toContain("core_trend");
  });

  it("classifies downward momentum as trend_down", () => {
    const bars = makeBars(Array.from({ length: 120 }, () => -0.3));
    const snapshot = buildRegimeSnapshot({
      symbol: "BTC/USD",
      bars,
      config: { recentBars: 24, momentumThresholdPct: 0.01 },
    });

    expect(snapshot.regimeId).toBe("trend_down");
    expect(snapshot.allowedStrategyFamilies).toContain("core_breakout");
  });

  it("classifies low momentum as range", () => {
    const bars = makeBars(
      Array.from({ length: 120 }, (_, index) => (index % 2 === 0 ? 0.04 : -0.04)),
    );
    const snapshot = buildRegimeSnapshot({
      symbol: "BTC/USD",
      bars,
      config: { recentBars: 24, momentumThresholdPct: 0.02 },
    });

    expect(snapshot.regimeId).toBe("range");
    expect(snapshot.thresholdProfile.allowAdding).toBe(false);
  });

  it("classifies elevated event intensity as event_vol", () => {
    const bars = makeBars(
      Array.from({ length: 120 }, (_, index) => (index % 2 === 0 ? 0.1 : -0.08)),
    );
    const snapshot = buildRegimeSnapshot({
      symbol: "BTC/USD",
      bars,
      eventIntensity: 0.9,
    });

    expect(snapshot.regimeId).toBe("event_vol");
    expect(snapshot.reasonCodes).toContain("event_intensity_above_threshold");
    expect(snapshot.allowedStrategyFamilies).toEqual([
      "volatility_gated",
      "core_ensemble",
    ]);
  });
});
