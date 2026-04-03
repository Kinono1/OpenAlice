import { describe, expect, it } from "vitest";
import {
  buildInverseVolatilityPortfolioTarget,
  buildPortfolioTargetFromWeights,
} from "./target.js";

function makeSeries(length: number, drift: number, volatility: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    const cycle = ((i % 7) - 3) / 3;
    out.push(drift + cycle * volatility);
  }
  return out;
}

describe("portfolio target", () => {
  it("builds a concrete target contract from weights", () => {
    const target = buildPortfolioTargetFromWeights({
      basisEquityUsd: 1_000,
      weights: {
        "BTC/USD": 0.4,
        "ETH/USD": -0.1,
      },
      maxTurnoverPct: 0.35,
      confidenceBySymbol: { "BTC/USD": 0.8 },
      sizingReasonBySymbol: { "BTC/USD": "champion" },
    });

    expect(target.basisEquityUsd).toBe(1_000);
    expect(target.targetGrossExposure).toBeCloseTo(0.5, 8);
    expect(target.targetNetExposure).toBeCloseTo(0.3, 8);
    expect(target.maxTurnoverPct).toBeCloseTo(0.35, 8);
    expect(target.positions).toEqual([
      expect.objectContaining({
        symbol: "BTC/USD",
        targetWeight: 0.4,
        targetNotionalUsd: 400,
        confidence: 0.8,
        sizingReason: "champion",
      }),
      expect.objectContaining({
        symbol: "ETH/USD",
        targetWeight: -0.1,
        targetNotionalUsd: -100,
      }),
    ]);
  });

  it("wraps inverse-vol allocation into the same target schema", () => {
    const lowVol = makeSeries(300, 0.001, 0.003);
    const highVol = makeSeries(300, 0.001, 0.02);

    const result = buildInverseVolatilityPortfolioTarget({
      basisEquityUsd: 5_000,
      returnsByAsset: {
        low: lowVol,
        high: highVol,
      },
      allocatorConfig: {
        annualizationFactor: 365,
      },
    });

    expect(result.target.basisEquityUsd).toBe(5_000);
    expect(result.target.positions).toHaveLength(2);
    const bySymbol = Object.fromEntries(
      result.target.positions.map(position => [position.symbol, position])
    );
    expect(bySymbol.low.targetNotionalUsd).toBeCloseTo(
      result.allocation.scaledWeights.low * 5_000,
      8
    );
    expect(bySymbol.high.targetNotionalUsd).toBeCloseTo(
      result.allocation.scaledWeights.high * 5_000,
      8
    );
  });
});
