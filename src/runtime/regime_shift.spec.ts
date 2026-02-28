import { describe, expect, it } from "vitest";
import { detectRegimeShift } from "./regime_shift.js";

function makeStableCloses(length: number): number[] {
  const out: number[] = [];
  let price = 100;
  for (let i = 0; i < length; i++) {
    price *= 1 + Math.sin(i / 10) * 0.0005;
    out.push(price);
  }
  return out;
}

describe("regime_shift", () => {
  it("returns none for stable series", () => {
    const closes = makeStableCloses(24 * 120);
    const result = detectRegimeShift(closes, {
      recentBars: 24,
      baselineBars: 24 * 90,
    });

    expect(result.severity).toBe("none");
    expect(result.triggered).toBe(false);
  });

  it("returns high severity when volatility spikes sharply", () => {
    const closes = makeStableCloses(24 * 120);
    let price = closes[closes.length - 1];
    for (let i = 0; i < 30; i++) {
      const shock = i % 2 === 0 ? 0.05 : -0.05;
      price *= 1 + shock;
      closes.push(price);
    }

    const result = detectRegimeShift(closes, {
      recentBars: 24,
      baselineBars: 24 * 90,
      volZWatch: 1.5,
      volZHigh: 2.2,
    });

    expect(result.severity).toBe("high");
    expect(result.triggered).toBe(true);
  });
});
