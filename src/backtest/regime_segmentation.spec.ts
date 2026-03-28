import { describe, expect, it } from "vitest";
import { segmentRegimes } from "./regime_segmentation.js";

type TestCandle = {
  time: number;
  close: number;
};

function makeRegimeCandles(
  bars: number,
  splitAt: number,
  preShiftMean = 0.0018,
  postShiftMean = -0.0018,
): TestCandle[] {
  const out: TestCandle[] = [];
  let price = 100;

  for (let i = 0; i < bars; i++) {
    if (i > 0) {
      const regimeMean = i < splitAt ? preShiftMean : postShiftMean;
      const deterministicNoise = (((i * 17) % 13) - 6) * 0.0002;
      const logReturn = regimeMean + deterministicNoise;
      price *= Math.exp(logReturn);
    }

    out.push({
      time: 1_700_000_000 + i * 3600,
      close: price,
    });
  }

  return out;
}

describe("regime_segmentation", () => {
  it("does not split when series is too short for minSegmentBars", () => {
    const candles = makeRegimeCandles(36, 18);
    const result = segmentRegimes(candles, {
      method: "change_point",
      maxSegments: 4,
      minSegmentBars: 20,
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].startIndex).toBe(0);
    expect(result.segments[0].endExclusive).toBe(candles.length);
  });

  it("splits into multiple segments on a clear synthetic regime shift", () => {
    const splitAt = 150;
    const candles = makeRegimeCandles(300, splitAt);
    const result = segmentRegimes(candles, {
      method: "change_point",
      maxSegments: 4,
      minSegmentBars: 40,
    });

    expect(result.segments.length).toBeGreaterThanOrEqual(2);

    const boundaries = result.segments
      .slice(0, -1)
      .map((segment) => segment.endExclusive);
    expect(boundaries.some((boundary) => Math.abs(boundary - splitAt) <= 25)).toBe(
      true,
    );
  });

  it("returns contiguous non-overlapping boundaries with weights summing to 1", () => {
    const candles = makeRegimeCandles(240, 120);
    const result = segmentRegimes(candles, {
      method: "change_point",
      maxSegments: 5,
      minSegmentBars: 30,
    });

    const totalWeight = result.segments.reduce((sum, segment) => sum + segment.weight, 0);
    expect(totalWeight).toBeCloseTo(1, 10);

    expect(result.segments[0].startIndex).toBe(0);
    expect(result.segments[result.segments.length - 1].endExclusive).toBe(candles.length);

    for (let i = 0; i < result.segments.length; i++) {
      const current = result.segments[i];
      expect(current.bars).toBe(current.endExclusive - current.startIndex);
      expect(current.weight).toBeCloseTo(current.bars / candles.length, 12);

      if (i > 0) {
        const previous = result.segments[i - 1];
        expect(current.startIndex).toBe(previous.endExclusive);
      }
    }
  });
});
