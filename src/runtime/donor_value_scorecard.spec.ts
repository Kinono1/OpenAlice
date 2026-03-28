import { describe, expect, it } from "vitest";
import { buildDonorValueScorecard } from "./donor_value_scorecard";

describe("donor_value_scorecard", () => {
  it("qualifies when donor improves hit rate and expectancy", () => {
    const scorecard = buildDonorValueScorecard({
      generatedAt: "2026-03-28T00:00:00.000Z",
      samples: [
        {
          baselineHit: false,
          donorHit: true,
          baselineExpectancyBps: -2,
          donorExpectancyBps: 4,
          regime: "event_vol",
          explainable: true,
        },
        {
          baselineHit: true,
          donorHit: true,
          baselineExpectancyBps: 3,
          donorExpectancyBps: 7,
          regime: "trend_up",
          explainable: true,
        },
      ],
    });

    expect(scorecard.state).toBe("qualified_for_paper_influence");
    expect(scorecard.metrics.expectancyDeltaBps).toBeGreaterThan(0);
  });

  it("kills donor when fallback ratio is too high", () => {
    const scorecard = buildDonorValueScorecard({
      samples: [
        {
          baselineHit: true,
          donorHit: false,
          baselineExpectancyBps: 3,
          donorExpectancyBps: -1,
          fallbackUsed: true,
          explainable: true,
        },
        {
          baselineHit: true,
          donorHit: false,
          baselineExpectancyBps: 4,
          donorExpectancyBps: 0,
          fallbackUsed: false,
          explainable: true,
        },
      ],
      thresholds: {
        maxFallbackRatio: 0.3,
      },
    });

    expect(scorecard.state).toBe("killed");
    expect(scorecard.reasons).toContain("donor_fallback_ratio_too_high");
  });
});
