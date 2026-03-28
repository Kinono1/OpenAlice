import { describe, expect, it } from "vitest";
import { applyFdr, benjaminiHochberg } from "./fdr.js";

describe("benjaminiHochberg", () => {
  it("computes monotonic q-values in original order", () => {
    const result = benjaminiHochberg([0.03, 0.001, 0.2, 0.07], 0.1);

    expect(result).toHaveLength(4);
    expect(result[1].qValue).toBeLessThanOrEqual(result[3].qValue);
    expect(result[3].qValue).toBeLessThanOrEqual(result[2].qValue);
    expect(result.every((item) => item.qValue >= 0 && item.qValue <= 1)).toBe(
      true
    );
  });

  it("marks items with q <= alpha as passed", () => {
    const result = benjaminiHochberg([0.001, 0.01, 0.4], 0.05);
    const passed = result.filter((item) => item.passed);

    expect(passed.length).toBe(2);
    expect(passed.every((item) => item.qValue <= 0.05)).toBe(true);
  });

  it("throws on invalid input", () => {
    expect(() => benjaminiHochberg([], 0.1)).toThrow(
      "pValues must be a non-empty array."
    );
    expect(() => benjaminiHochberg([0.1], 2)).toThrow(
      "alpha must be in (0, 1]."
    );
    expect(() => benjaminiHochberg([1.2], 0.1)).toThrow(
      "pValues[0] must be within [0, 1]."
    );
  });

  it("BY should be at least as conservative as BH", () => {
    const pValues = [0.001, 0.01, 0.03, 0.2, 0.4];
    const bh = applyFdr(pValues, 0.1, { method: "bh" });
    const by = applyFdr(pValues, 0.1, { method: "by" });
    expect(by.diagnostics.harmonicFactorCm).not.toBeNull();
    for (let i = 0; i < pValues.length; i++) {
      expect(by.items[i].qValue).toBeGreaterThanOrEqual(bh.items[i].qValue);
    }
  });

  it("storey_bh should expose diagnostics and often be less conservative than BH", () => {
    const pValues = [0.001, 0.02, 0.04, 0.08, 0.12, 0.9];
    const bh = applyFdr(pValues, 0.1, { method: "bh" });
    const storey = applyFdr(pValues, 0.1, {
      method: "storey_bh",
      storeyLambda: 0.5,
    });
    expect(storey.diagnostics.method).toBe("storey_bh");
    expect(storey.diagnostics.storeyPi0).not.toBeNull();
    expect(storey.diagnostics.storeyLambda).toBe(0.5);
    expect(storey.items[0].qValue).toBeLessThanOrEqual(bh.items[0].qValue);
  });

  it("storey_bh should avoid degenerate pi0=0 on tiny samples", () => {
    const pValues = [0.29, 0.31, 0.33];
    const storey = applyFdr(pValues, 0.1, {
      method: "storey_bh",
      storeyLambda: 0.5,
    });
    expect(storey.diagnostics.storeyPi0).toBeGreaterThan(0);
    expect(storey.diagnostics.storeyPi0).toBeGreaterThanOrEqual(1 / pValues.length);
    expect(storey.items.every((item) => item.qValue > 0)).toBe(true);
  });

  it("storey_bh handles all-significant p-values without collapsing pi0 below the finite-sample floor", () => {
    const pValues = [1e-6, 2e-6, 5e-6, 1e-5];
    const storey = applyFdr(pValues, 0.05, {
      method: "storey_bh",
      storeyLambda: 0.5,
    });

    expect(storey.diagnostics.storeyPi0).toBe(1 / pValues.length);
    expect(storey.items.every((item) => item.passed)).toBe(true);
    expect(storey.items.every((item) => item.qValue <= 0.05)).toBe(true);
  });

  it("storey_bh handles all-null p-values with pi0 capped at 1", () => {
    const pValues = [0.8, 0.85, 0.9, 0.95];
    const storey = applyFdr(pValues, 0.05, {
      method: "storey_bh",
      storeyLambda: 0.5,
    });

    expect(storey.diagnostics.storeyPi0).toBe(1);
    expect(storey.items.every((item) => item.passed === false)).toBe(true);
    expect(storey.items.every((item) => item.qValue >= item.pValue)).toBe(true);
  });

  it("throws for invalid storey lambda", () => {
    expect(() =>
      applyFdr([0.1, 0.2, 0.3], 0.1, {
        method: "storey_bh",
        storeyLambda: 1,
      })
    ).toThrow("storeyLambda must be in [0, 1).");
  });

  it("e_bh should produce bounded q-values and retain strong small-p candidates", () => {
    const pValues = [0.001, 0.02, 0.2, 0.8];
    const result = applyFdr(pValues, 0.1, { method: "e_bh" });
    expect(result.diagnostics.method).toBe("e_bh");
    expect(result.items.every((item) => item.qValue >= 0 && item.qValue <= 1)).toBe(true);
    expect(result.items[0].passed).toBe(true);
    expect(result.items[3].passed).toBe(false);
  });
});
