import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RiskBreakerStore } from "./risk_breaker_state.js";

describe("risk_breaker_state", () => {
  it("tracks consecutive loss statistics from daily returns", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "risk-breaker-"));
    const store = await RiskBreakerStore.load(
      join(tempDir, "risk_breaker_state.json")
    );

    await store.upsertDailyPnl("2026-02-01", 1.2);
    await store.upsertDailyPnl("2026-02-02", -0.5);
    await store.upsertDailyPnl("2026-02-03", -1.1);

    const stats = store.getConsecutiveLossStats();
    expect(stats.days).toBe(2);
    expect(stats.cumulativePct).toBeCloseTo(-1.6, 10);
  });

  it("activates and clears execution breaker based on gate action", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "risk-breaker-gate-"));
    const store = await RiskBreakerStore.load(
      join(tempDir, "risk_breaker_state.json")
    );

    await store.applyExecutionGateDecision({
      action: "reduce_or_pause",
      consecutiveBreaches: 3,
      requiredConsecutiveDays: 3,
      breachedDates: ["2026-02-01", "2026-02-02", "2026-02-03"],
      latestDriftMultiplier: 2.3,
    });

    expect(store.isExecutionBreakerActive()).toBe(true);

    await store.applyExecutionGateDecision({
      action: "monitor",
      consecutiveBreaches: 0,
      requiredConsecutiveDays: 3,
      breachedDates: [],
      latestDriftMultiplier: 1.1,
    });

    expect(store.isExecutionBreakerActive()).toBe(false);
    expect(store.getExecutionBreakerReason()).toBeNull();
  });

  it("computes CVaR tail-loss stats from recent daily returns", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "risk-breaker-cvar-"));
    const store = await RiskBreakerStore.load(
      join(tempDir, "risk_breaker_state.json")
    );

    await store.upsertDailyPnl("2026-02-01", 1.2);
    await store.upsertDailyPnl("2026-02-02", -0.4);
    await store.upsertDailyPnl("2026-02-03", -1.8);
    await store.upsertDailyPnl("2026-02-04", -3.0);
    await store.upsertDailyPnl("2026-02-05", 0.7);

    const tail = store.getTailLossStats({ lookbackDays: 5, tailAlpha: 0.4 });
    expect(tail.sampleCount).toBe(5);
    expect(tail.tailCount).toBe(2);
    expect(tail.varPct).toBeCloseTo(-1.8, 10);
    expect(tail.cvarPct).toBeCloseTo(-2.4, 10);
  });
});
