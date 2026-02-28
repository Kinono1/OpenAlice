import { describe, expect, it } from "vitest";
import {
  computeDeflatedSharpe,
  estimatePboCscv,
  evaluateSignificanceGate,
} from "./statistical_significance";

function repeat(value: number, count: number): number[] {
  return Array.from({ length: count }, () => value);
}

describe("statistical_significance", () => {
  it("estimates PBO from CSCV splits", () => {
    const candidateReturns = [
      [...repeat(0.015, 64), ...repeat(-0.015, 64)],
      repeat(0.003, 128),
      repeat(0.002, 128),
    ];

    const result = estimatePboCscv({
      candidateReturns,
      partitions: 8,
    });

    expect(result.splitsEvaluated).toBeGreaterThan(0);
    expect(result.pbo).toBeGreaterThanOrEqual(0);
    expect(result.pbo).toBeLessThanOrEqual(1);
    expect(result.logits.length).toBe(result.splitsEvaluated);
  });

  it("computes deflated sharpe and yields positive dsrValue for robust returns", () => {
    const returns = Array.from({ length: 240 }, (_, i) => 0.002 + ((i % 9) - 4) * 0.0002);

    const result = computeDeflatedSharpe({
      returns,
      trialCount: 20,
    });

    expect(result.observedSharpe).toBeGreaterThan(0);
    expect(result.dsrValue).toBeGreaterThan(0);
    expect(result.dsrProbability).toBeGreaterThan(0.5);
  });

  it("fails gate when adjusted sharpe is not positive", () => {
    const candidateReturns = [
      Array.from({ length: 128 }, (_, i) => ((i % 2 === 0 ? 1 : -1) * 0.002)),
      repeat(-0.001, 128),
    ];

    const selectedReturns = repeat(-0.0015, 128);

    const gate = evaluateSignificanceGate({
      candidateReturns,
      selectedReturns,
      partitions: 8,
      trialCount: 10,
      pboThreshold: 0.9,
      dsrMin: 0,
    });

    expect(gate.passed).toBe(false);
    expect(gate.dsrResult.dsrValue).toBeLessThanOrEqual(0);
  });
});
