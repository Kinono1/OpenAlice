import { describe, expect, it } from "vitest";
import { benjaminiHochberg } from "./fdr.js";

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
});
