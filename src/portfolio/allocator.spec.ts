import { describe, expect, it } from "vitest";
import {
  allocateInverseVolatilityPortfolio,
  allocateSignedRiskConstrainedPortfolio,
  computeAnnualizedVolatility,
  computeCorrelation,
  computePortfolioAnnualizedVolatility,
} from "./allocator";

function makeSeries(length: number, drift: number, volatility: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    const cycle = ((i % 7) - 3) / 3;
    out.push(drift + cycle * volatility);
  }
  return out;
}

describe("portfolio allocator", () => {
  it("assigns lower weight to higher-volatility assets", () => {
    const lowVol = makeSeries(300, 0.001, 0.003);
    const highVol = makeSeries(300, 0.001, 0.02);

    const result = allocateInverseVolatilityPortfolio(
      {
        low: lowVol,
        high: highVol,
      },
      { annualizationFactor: 365 },
    );

    expect(result.normalizedWeights.low).toBeGreaterThan(result.normalizedWeights.high);
    expect(result.normalizedWeights.low + result.normalizedWeights.high).toBeCloseTo(1, 10);
  });

  it("limits concentration when assets are highly correlated", () => {
    const a = makeSeries(250, 0.001, 0.01);
    const b = [...a];
    const c = Array.from({ length: 250 }, (_, i) => ((i % 2 === 0 ? 1 : -1) * 0.012) + (((i % 5) - 2) * 0.0007));

    const result = allocateInverseVolatilityPortfolio(
      { a, b, c },
      {
        correlationThreshold: 0.8,
        maxPairCombinedWeight: 0.55,
        correlationPasses: 5,
      },
    );

    const pairWeight = result.normalizedWeights.a + result.normalizedWeights.b;
    expect(pairWeight).toBeLessThanOrEqual(0.57);
    expect(result.concentrationAdjusted).toBe(true);
  });

  it("applies volatility targeting with leverage cap", () => {
    const x = makeSeries(500, 0.0004, 0.002);
    const y = makeSeries(500, 0.0003, 0.0025);

    const result = allocateInverseVolatilityPortfolio(
      { x, y },
      {
        targetAnnualVolatility: 0.8,
        leverageCap: 1.7,
      },
    );

    expect(result.leverage).toBeLessThanOrEqual(1.7);
    expect(result.grossExposure).toBeCloseTo(result.leverage, 8);
  });

  it("handles near-zero volatility safely", () => {
    const almostFlat = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 1e-9 : -1e-9));
    const noisy = makeSeries(200, 0.0001, 0.01);

    const result = allocateInverseVolatilityPortfolio({ almostFlat, noisy });

    expect(Number.isFinite(result.normalizedWeights.almostFlat)).toBe(true);
    expect(Number.isFinite(result.normalizedWeights.noisy)).toBe(true);
  });

  it("computes statistics helpers consistently", () => {
    const a = makeSeries(300, 0.001, 0.01);
    const b = makeSeries(300, 0.0008, 0.008);
    const vol = computeAnnualizedVolatility(a, 365);
    const corr = computeCorrelation(a, b);
    const portfolioVol = computePortfolioAnnualizedVolatility(
      { a, b },
      { a: 0.5, b: 0.5 },
      365,
    );

    expect(vol).toBeGreaterThan(0);
    expect(corr).toBeGreaterThan(-1);
    expect(corr).toBeLessThanOrEqual(1);
    expect(portfolioVol).toBeGreaterThan(0);
  });

  it("allocates signed alpha without converting shorts into long-only risk budgets", () => {
    const btc = makeSeries(300, 0.001, 0.01);
    const eth = makeSeries(300, 0.0008, 0.012);
    const sol = makeSeries(300, -0.0002, 0.02);

    const result = allocateSignedRiskConstrainedPortfolio(
      { btc, eth, sol },
      { btc: 0.8, eth: -0.6, sol: 0.2 },
      {
        targetGrossExposure: 1,
        maxNetExposure: 0.25,
      },
    );

    expect(result.signedWeights.btc).toBeGreaterThan(0);
    expect(result.signedWeights.eth).toBeLessThan(0);
    expect(Math.abs(result.netExposure)).toBeLessThanOrEqual(0.25 + 1e-12);
    expect(result.grossExposure).toBeLessThanOrEqual(1);
    expect(result.predictedAnnualVolatility).toBeGreaterThan(0);
  });

  it("rejects signed allocation when all alpha scores are neutral", () => {
    expect(() =>
      allocateSignedRiskConstrainedPortfolio(
        {
          btc: makeSeries(100, 0, 0.01),
          eth: makeSeries(100, 0, 0.01),
        },
        { btc: 0, eth: 0 },
      ),
    ).toThrow("zero gross alpha");
  });
});
