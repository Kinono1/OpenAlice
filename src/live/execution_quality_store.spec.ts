import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionQualityStore } from "./execution_quality_store.js";
import type { OrderExecutionRecord } from "./execution_quality.js";

function makeRecord(date: string, overrides: Partial<OrderExecutionRecord> = {}): OrderExecutionRecord {
  const baseMs = Date.parse(`${date}T12:00:00.000Z`);
  return {
    orderId: `o-${date}`,
    symbol: "BTC/USD",
    side: "buy",
    expectedPrice: 100,
    actualPrice: 101,
    requestedQty: 1,
    filledQty: 1,
    submittedAtMs: baseMs,
    firstFillAtMs: baseMs + 10,
    completedAtMs: baseMs + 20,
    ...overrides,
  };
}

describe("execution_quality_store", () => {
  it("persists records and finalizes daily summary with report output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "execution-store-"));
    const storePath = join(tempDir, "execution_state.json");
    const store = await ExecutionQualityStore.load(storePath);

    await store.addRecord(makeRecord("2026-02-01"), "2026-02-01");
    const summary = await store.finalizeDate("2026-02-01", {
      writeDailyReport: true,
      reportBaseDir: tempDir,
    });

    expect(summary).not.toBeNull();
    expect(summary?.date).toBe("2026-02-01");
    expect(summary?.orderCount).toBe(1);
    expect(summary?.filledOrderCount).toBe(1);

    const reportPath = join(tempDir, "execution_logs", "2026-02-01.json");
    const report = JSON.parse(await readFile(reportPath, "utf-8"));
    expect(report.date).toBe("2026-02-01");

    const reloaded = await ExecutionQualityStore.load(storePath);
    expect(reloaded.getSummary("2026-02-01")?.orderCount).toBe(1);
  });

  it("computes gate decision across consecutive breach days", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "execution-gate-"));
    const store = await ExecutionQualityStore.load(join(tempDir, "execution_state.json"));

    const days = ["2026-02-01", "2026-02-02", "2026-02-03"];
    for (const date of days) {
      await store.addRecord(
        makeRecord(date, { expectedPrice: 100, actualPrice: 103 }),
        date,
      );
      await store.finalizeDate(date, {
        writeDailyReport: false,
      });
    }

    const gate = await store.evaluateGate({
      driftMultiplierThreshold: 2,
      consecutiveDays: 3,
      baselineSlippageBps: 100,
    });

    expect(gate.action).toBe("reduce_or_pause");
    expect(gate.consecutiveBreaches).toBe(3);
    expect(gate.breachedDates).toEqual(days);
  });
});
