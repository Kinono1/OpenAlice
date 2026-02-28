import { describe, expect, it } from "vitest";
import { evaluateRiskSimulation } from "./risk_simulation.js";

function makeReturns(length: number, mean: number, noise = 0.01): number[] {
  const out: number[] = [];
  let seed = 12345;
  const rand = () => {
    seed = (1103515245 * seed + 12345) % 0x80000000;
    return seed / 0x80000000;
  };

  for (let i = 0; i < length; i++) {
    const r = mean + (rand() - 0.5) * noise;
    out.push(r);
  }
  return out;
}

describe("risk_simulation", () => {
  it("produces deterministic simulation output with seed", () => {
    const returns = makeReturns(500, 0.0008, 0.006);

    const a = evaluateRiskSimulation(returns, {
      simulations: 1000,
      horizonBars: 240,
      method: "moving_block_bootstrap",
      seed: 42,
    });
    const b = evaluateRiskSimulation(returns, {
      simulations: 1000,
      horizonBars: 240,
      method: "moving_block_bootstrap",
      seed: 42,
    });

    expect(a.profitProbability).toBeCloseTo(b.profitProbability, 12);
    expect(a.riskOfRuin).toBeCloseTo(b.riskOfRuin, 12);
    expect(a.expectedFinalReturnPct).toBeCloseTo(b.expectedFinalReturnPct, 12);
  });

  it("passes gate on robust synthetic positive-return series", () => {
    const returns = makeReturns(800, 0.0012, 0.005);
    const result = evaluateRiskSimulation(returns, {
      simulations: 2000,
      horizonBars: 240,
      ruinDrawdownPct: 25,
      maxRuinProbability: 0.1,
      minProfitProbability: 0.7,
      seed: 7,
    });

    expect(result.gatePassed).toBe(true);
    expect(result.profitProbability).toBeGreaterThan(0.7);
  });

  it("fails gate on negative expectation series", () => {
    const returns = makeReturns(800, -0.001, 0.006);
    const result = evaluateRiskSimulation(returns, {
      simulations: 1500,
      horizonBars: 240,
      ruinDrawdownPct: 20,
      maxRuinProbability: 0.2,
      minProfitProbability: 0.6,
      seed: 9,
    });

    expect(result.gatePassed).toBe(false);
    expect(result.profitProbability).toBeLessThan(0.6);
  });
});
