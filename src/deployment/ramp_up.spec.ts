import { describe, expect, it } from "vitest";
import {
  DEFAULT_RAMP_UP_STAGES,
  RAMP_UP_STAGE_SEQUENCE,
  evaluateRampUpSnapshot,
} from "./ramp_up.js";

describe("ramp_up", () => {
  it("exports canonical stage metadata", () => {
    expect(RAMP_UP_STAGE_SEQUENCE).toEqual([5, 10, 25, 50, 100]);
    expect(DEFAULT_RAMP_UP_STAGES).toHaveLength(5);
    expect(DEFAULT_RAMP_UP_STAGES.map((stage) => stage.allocationPct)).toEqual([
      5, 10, 25, 50, 100,
    ]);
  });

  it("promotes when all guards pass and drawdown is within stage threshold", () => {
    const evaluation = evaluateRampUpSnapshot(
      {
        stageIndex: 1,
        elapsedDays: 8,
        tradingDays: 12,
        trades: 30,
        maxDrawdownPct: 1.8,
      },
      {
        stageThresholdOverrides: {
          10: { minDurationDays: 8, maxDrawdownPct: 2.0 },
        },
        minTradingDays: 12,
        minTrades: 30,
      },
    );

    expect(evaluation.decision).toBe("promote");
    expect(evaluation.reason).toBe("promotion_ready");
    expect(evaluation.currentStage.allocationPct).toBe(10);
    expect(evaluation.targetStage.allocationPct).toBe(25);
    expect(evaluation.guardStatus).toEqual({
      durationMet: true,
      tradingDaysMet: true,
      tradesMet: true,
    });
    expect(evaluation.drawdownBreached).toBe(false);
  });

  it("holds at 100% stage even when sample quality is sufficient", () => {
    const evaluation = evaluateRampUpSnapshot({
      stageIndex: 4,
      elapsedDays: 30,
      tradingDays: 25,
      trades: 80,
      maxDrawdownPct: 2.0,
    });

    expect(evaluation.decision).toBe("stay");
    expect(evaluation.reason).toBe("max_stage_reached");
    expect(evaluation.currentStage.allocationPct).toBe(100);
    expect(evaluation.targetStage.allocationPct).toBe(100);
    expect(evaluation.guardStatus).toEqual({
      durationMet: true,
      tradingDaysMet: true,
      tradesMet: true,
    });
  });

  it("rolls back one stage when drawdown breaches the current stage threshold", () => {
    const evaluation = evaluateRampUpSnapshot({
      stageIndex: 3,
      elapsedDays: 20,
      tradingDays: 15,
      trades: 40,
      maxDrawdownPct: 4.6,
    });

    expect(evaluation.decision).toBe("rollback");
    expect(evaluation.reason).toBe("drawdown_breach");
    expect(evaluation.currentStage.allocationPct).toBe(50);
    expect(evaluation.targetStage.allocationPct).toBe(25);
    expect(evaluation.drawdownBreached).toBe(true);
  });

  it("stays when trading-day/trade sample guards are not met", () => {
    const evaluation = evaluateRampUpSnapshot({
      stageIndex: 2,
      elapsedDays: 20,
      tradingDays: 8,
      trades: 19,
      maxDrawdownPct: 1.5,
    });

    expect(evaluation.decision).toBe("stay");
    expect(evaluation.reason).toBe("insufficient_sample");
    expect(evaluation.currentStage.allocationPct).toBe(25);
    expect(evaluation.targetStage.allocationPct).toBe(25);
    expect(evaluation.guardStatus).toEqual({
      durationMet: true,
      tradingDaysMet: false,
      tradesMet: false,
    });
    expect(evaluation.drawdownBreached).toBe(false);
  });
});
