import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RampUpStore } from "./ramp_up_store.js";

describe("ramp_up_store", () => {
  it("promotes stage when guard conditions pass", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ramp-up-store-"));
    const store = await RampUpStore.load(join(tempDir, "ramp_up_state.json"));
    await store.setStageByLabel("5%", "2026-02-01");

    const evaluation = await store.recordDay(
      { date: "2026-02-01", dayReturnPct: 1.0, tradeCount: 10 },
      {
        minTradingDays: 1,
        minTrades: 10,
        stageThresholdOverrides: {
          5: { minDurationDays: 1, maxDrawdownPct: 5 },
        },
      },
    );

    expect(evaluation.decision).toBe("promote");
    expect(store.getCurrentStageLabel()).toBe("10%");
  });

  it("rolls back on drawdown breach and supports manual stage override", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ramp-up-rollback-"));
    const store = await RampUpStore.load(join(tempDir, "ramp_up_state.json"));

    await store.setStageByLabel("25%", "2026-02-01");

    const evaluation = await store.recordDay(
      { date: "2026-02-02", dayReturnPct: -20, tradeCount: 5 },
      {
        minTradingDays: 1,
        minTrades: 1,
        stageThresholdOverrides: {
          25: { minDurationDays: 1, maxDrawdownPct: 1.0 },
        },
      },
    );

    expect(evaluation.decision).toBe("rollback");
    expect(store.getCurrentStageLabel()).toBe("10%");
  });
});
