import { describe, expect, it } from "vitest";
import { applyRegimeSegmentedFdr, __testOnly } from "./regime_fdr.js";
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

describe("applyRegimeSegmentedFdr", () => {
  it("max aggregation is at least as conservative as weighted_mean", () => {
    const segments = [
      {
        segmentId: "trend",
        bars: 120,
        weight: 2,
        pValues: [0.01, 0.03, 0.2, 0.5],
      },
      {
        segmentId: "range",
        bars: 80,
        weight: 1,
        pValues: [0.02, 0.04, 0.25, 0.6],
      },
    ];

    const maxResult = applyRegimeSegmentedFdr(segments, 0.1, "max");
    const weightedResult = applyRegimeSegmentedFdr(segments, 0.1, "weighted_mean");

    expect(maxResult.items).toHaveLength(weightedResult.items.length);
    for (let index = 0; index < maxResult.items.length; index++) {
      expect(maxResult.items[index].qValue).toBeGreaterThanOrEqual(
        weightedResult.items[index].qValue,
      );
    }
  });

  it("throws on invalid segment shapes", () => {
    expect(() =>
      applyRegimeSegmentedFdr(
        [
          {
            segmentId: "a",
            bars: 100,
            weight: 1,
            pValues: [0.01, 0.02],
          },
          {
            segmentId: "b",
            bars: 120,
            weight: 1,
            pValues: [0.03],
          },
        ],
        0.1,
      ),
    ).toThrow("segments[1].pValues must match candidate count (2).");
  });

  it("uses alpha against aggregated q-values for pass/fail", () => {
    const result = applyRegimeSegmentedFdr(
      [
        {
          segmentId: "s1",
          bars: 100,
          weight: 1,
          pValues: [0.001, 0.2],
        },
        {
          segmentId: "s2",
          bars: 110,
          weight: 1,
          pValues: [0.01, 0.3],
        },
      ],
      0.05,
      "max",
    );

    expect(result.items[0].passed).toBe(true);
    expect(result.items[1].passed).toBe(false);
    expect(result.items.every((item) => item.passed === (item.qValue <= 0.05))).toBe(true);
  });

  it("falls back to max aggregation when weighted_mean has no positive weights", () => {
    const segments = [
      {
        segmentId: "s1",
        bars: 100,
        weight: 0,
        pValues: [0.02, 0.11, 0.4],
      },
      {
        segmentId: "s2",
        bars: 100,
        weight: 0,
        pValues: [0.03, 0.12, 0.5],
      },
    ];

    const weightedResult = applyRegimeSegmentedFdr(segments, 0.1, "weighted_mean");
    const maxResult = applyRegimeSegmentedFdr(segments, 0.1, "max");

    expect(weightedResult.diagnostics.fallbackUsed).toBe(true);
    expect(weightedResult.diagnostics.fallbackReason).toContain("fell back to max");
    expect(weightedResult.diagnostics.positiveWeightSegmentCount).toBe(0);
    expect(weightedResult.items).toEqual(maxResult.items);
  });

  it("integrates segmentation output into segmented FDR without cardinality drift", () => {
    const candles = makeRegimeCandles(320, 160);
    const segmentation = segmentRegimes(candles, {
      method: "change_point",
      maxSegments: 4,
      minSegmentBars: 40,
    });
    expect(segmentation.segments.length).toBeGreaterThanOrEqual(2);

    const segmentInputs = segmentation.segments.map((segment, idx) => {
      const base = idx * 0.01;
      return {
        segmentId: segment.id,
        bars: segment.bars,
        weight: segment.weight,
        pValues: [0.01 + base, 0.06 + base, 0.2 + base],
      };
    });

    const result = applyRegimeSegmentedFdr(segmentInputs, 0.1, "weighted_mean");

    expect(result.items).toHaveLength(3);
    expect(result.diagnostics.segmentCount).toBe(segmentInputs.length);
    for (const item of result.items) {
      expect(item.regimeDetails).toHaveLength(segmentInputs.length);
    }
    expect(result.items.some((item) => item.passed)).toBe(true);
  });

  it("regression: max aggregation does not assume non-negative values", () => {
    const details = [
      {
        segmentId: "s1",
        pValue: -0.2,
        qValue: -0.1,
        rank: 1,
        threshold: 0.1,
        weight: 1,
        bars: 100,
      },
      {
        segmentId: "s2",
        pValue: -0.4,
        qValue: -0.3,
        rank: 1,
        threshold: 0.1,
        weight: 1,
        bars: 100,
      },
    ];

    expect(__testOnly.aggregateMetric(details, "pValue", "max")).toBe(-0.2);
    expect(__testOnly.aggregateMetric(details, "qValue", "max")).toBe(-0.1);
  });
});
