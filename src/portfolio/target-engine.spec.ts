import { describe, expect, it } from "vitest";
import { buildPortfolioTarget } from "./target-engine";

function makeReturns(length: number, drift: number, volatility: number): number[] {
  return Array.from({ length }, (_, index) => drift + (((index % 5) - 2) / 2) * volatility);
}

describe("portfolio target engine", () => {
  it("caps gross exposure and per-symbol weight", () => {
    const result = buildPortfolioTarget({
      signals: [
        { symbol: "BTC/USD", conviction: 1 },
        { symbol: "ETH/USD", conviction: 1 },
        { symbol: "SOL/USD", conviction: 1 },
      ],
      config: {
        grossExposureCap: 0.9,
        perSymbolCap: 0.35,
      },
    });

    expect(result.grossExposure).toBeLessThanOrEqual(0.9);
    expect(Math.abs(result.targetWeights["BTC/USD"])).toBeLessThanOrEqual(0.35);
  });

  it("applies turnover budget against current weights", () => {
    const result = buildPortfolioTarget({
      signals: [
        { symbol: "BTC/USD", conviction: 1, currentWeight: 0.5 },
        { symbol: "ETH/USD", conviction: -1, currentWeight: -0.3 },
      ],
      config: {
        turnoverBudget: 0.1,
      },
    });

    expect(result.turnoverUsed).toBeLessThanOrEqual(0.100001);
    expect(result.reasonCodes).toContain("turnover_budget_applied");
  });

  it("shrinks highly correlated pairs", () => {
    const a = makeReturns(200, 0.001, 0.01);
    const b = [...a];
    const result = buildPortfolioTarget({
      signals: [
        { symbol: "BTC/USD", conviction: 1 },
        { symbol: "ETH/USD", conviction: 1 },
      ],
      returnsByAsset: {
        "BTC/USD": a,
        "ETH/USD": b,
      },
      config: {
        correlationThreshold: 0.8,
        correlatedPairCap: 0.4,
      },
    });

    const combined =
      Math.abs(result.targetWeights["BTC/USD"]) +
      Math.abs(result.targetWeights["ETH/USD"]);
    expect(combined).toBeLessThanOrEqual(0.40001);
  });
});
