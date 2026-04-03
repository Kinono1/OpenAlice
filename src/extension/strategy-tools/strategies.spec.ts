import { describe, expect, it } from "vitest";
import type { MarketData } from "../analysis-kit/data/interfaces";
import { evaluateStrategy, getStrategyMinimumBars } from "./strategies";

function makeCandles(closes: number[]): MarketData[] {
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1];
    return {
      symbol: "BTC/USD",
      time: 1_700_000_000 + index * 3600,
      open,
      high: Math.max(open, close) + 0.1,
      low: Math.min(open, close) - 0.1,
      close,
      volume: 1000 + index,
    };
  });
}

function makeRegimeCandles(kind: "highVolTrend" | "lowVolCarry"): MarketData[] {
  const out: MarketData[] = [];
  let price = 100;
  for (let index = 0; index < 160; index++) {
    const open = price;
    const highVolPhase = kind === "highVolTrend" && index >= 120;
    const drift = highVolPhase ? 1.2 : kind === "highVolTrend" ? 0.08 : 0.04;
    const wave = highVolPhase ? ((index % 5) - 2) * 0.15 : 0;
    const close = price + drift + wave;
    const range = highVolPhase ? 4.5 : kind === "highVolTrend" ? 0.25 : 0.18;
    out.push({
      symbol: "BTC/USD",
      time: 1_700_000_000 + index * 3600,
      open,
      high: Math.max(open, close) + range,
      low: Math.min(open, close) - range,
      close,
      volume: 1000 + index,
    });
    price = close;
  }
  return out;
}

describe("trend strategy confirmation controls", () => {
  it("requires multiple confirming bars before changing direction", () => {
    const candles = makeCandles([10, 10, 10, 10, 10, 9, 8, 9, 12]);

    const withoutConfirmation = evaluateStrategy({
      strategy: "trend",
      candles,
      index: candles.length - 1,
      currentPosition: 0,
      params: {
        trendFastPeriod: 2,
        trendSlowPeriod: 4,
      },
    });
    const withConfirmation = evaluateStrategy({
      strategy: "trend",
      candles,
      index: candles.length - 1,
      currentPosition: 0,
      params: {
        trendFastPeriod: 2,
        trendSlowPeriod: 4,
        trendConfirmBars: 2,
      },
    });

    expect(withoutConfirmation.signal).toBe(1);
    expect(withConfirmation.signal).toBe(0);
  });

  it("stays flat when SMA spread is below the minimum diff threshold", () => {
    const candles = makeCandles([100, 100, 100, 100, 100, 100, 100.2, 100.4]);

    const unconstrained = evaluateStrategy({
      strategy: "trend",
      candles,
      index: candles.length - 1,
      currentPosition: 0,
      params: {
        trendFastPeriod: 2,
        trendSlowPeriod: 4,
      },
    });
    const constrained = evaluateStrategy({
      strategy: "trend",
      candles,
      index: candles.length - 1,
      currentPosition: 0,
      params: {
        trendFastPeriod: 2,
        trendSlowPeriod: 4,
        trendMinDiffPct: 0.5,
      },
    });

    expect(unconstrained.signal).toBe(1);
    expect(constrained.signal).toBe(0);
  });

  it("increases minimum bar requirement when confirmation bars are enabled", () => {
    const defaultBars = getStrategyMinimumBars("trend", {
      trendFastPeriod: 10,
      trendSlowPeriod: 30,
    });
    const confirmedBars = getStrategyMinimumBars("trend", {
      trendFastPeriod: 10,
      trendSlowPeriod: 30,
      trendConfirmBars: 3,
    });

    expect(defaultBars).toBe(30);
    expect(confirmedBars).toBe(32);
  });
});

describe("regimeTrend strategy", () => {
  it("blocks entry in a disallowed low-vol regime", () => {
    const candles = makeRegimeCandles("lowVolCarry");
    const decision = evaluateStrategy({
      strategy: "regimeTrend",
      candles,
      index: candles.length - 1,
      currentPosition: 0,
      params: {
        trendFastPeriod: 10,
        trendSlowPeriod: 30,
        allowedEntryRegimes: ["HighVolTrend"],
      },
    });

    expect(decision.signal).toBe(0);
    expect(decision.indicators.regimeAllowed).toBe(0);
  });

  it("allows entry in an allowed high-vol trend regime", () => {
    const candles = makeRegimeCandles("highVolTrend");
    const decision = evaluateStrategy({
      strategy: "regimeTrend",
      candles,
      index: candles.length - 1,
      currentPosition: 0,
      params: {
        trendFastPeriod: 10,
        trendSlowPeriod: 30,
        allowedEntryRegimes: ["HighVolTrend"],
      },
    });

    expect(decision.signal).toBe(1);
    expect(decision.indicators.regimeAllowed).toBe(1);
  });

  it("exits on regime mismatch when enabled", () => {
    const candles = makeRegimeCandles("lowVolCarry");
    const decision = evaluateStrategy({
      strategy: "regimeTrend",
      candles,
      index: candles.length - 1,
      currentPosition: 1,
      params: {
        trendFastPeriod: 10,
        trendSlowPeriod: 30,
        allowedEntryRegimes: ["HighVolTrend"],
        exitOnRegimeMismatch: true,
      },
    });

    expect(decision.signal).toBe(0);
  });

  it("holds position on regime mismatch when exit is disabled", () => {
    const candles = makeRegimeCandles("lowVolCarry");
    const decision = evaluateStrategy({
      strategy: "regimeTrend",
      candles,
      index: candles.length - 1,
      currentPosition: 1,
      params: {
        trendFastPeriod: 10,
        trendSlowPeriod: 30,
        allowedEntryRegimes: ["HighVolTrend"],
        exitOnRegimeMismatch: false,
      },
    });

    expect(decision.signal).toBe(1);
  });

  it("uses the larger trend/regime window for minimum bars", () => {
    const minimumBars = getStrategyMinimumBars("regimeTrend", {
      trendFastPeriod: 10,
      trendSlowPeriod: 30,
      trendConfirmBars: 3,
      regimeVolWindow: 20,
      regimeAtrPeriod: 14,
      regimeFastPeriod: 12,
      regimeSlowPeriod: 48,
    });

    expect(minimumBars).toBe(48);
  });
});
