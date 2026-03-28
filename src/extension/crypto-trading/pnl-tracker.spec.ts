import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PnLTracker } from "./pnl-tracker.js";

function tempJsonlPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "openalice-pnl-"));
  return join(dir, `${randomUUID()}.jsonl`);
}

describe("PnLTracker", () => {
  it("persists fills to JSONL and restores state on restart", async () => {
    const logPath = tempJsonlPath();
    const tracker = await PnLTracker.create({
      reconciliationThresholdPct: 5,
      persistencePath: logPath,
    });

    tracker.recordFill({
      symbol: "BTC/USD",
      side: "buy",
      size: 2,
      price: 100,
      timestamp: 1_700_000_000_000,
      orderId: "ord-1",
    });
    tracker.recordFill({
      symbol: "BTC/USD",
      side: "sell",
      size: 1,
      price: 110,
      timestamp: 1_700_000_060_000,
      orderId: "ord-2",
    });

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const restored = await PnLTracker.create({
      reconciliationThresholdPct: 5,
      persistencePath: logPath,
    });
    const position = restored.getAvgCostPosition("BTC/USD");
    expect(position).toMatchObject({
      symbol: "BTC/USD",
      side: "long",
      size: 1,
      avgCostBasis: 100,
      realizedPnL: 10,
    });
  });

  it("raises reconciliation alert when avg-cost and fifo diverge beyond threshold", () => {
    const tracker = new PnLTracker({ reconciliationThresholdPct: 5 });

    tracker.recordFill({
      symbol: "ETH/USD",
      side: "buy",
      size: 1,
      price: 100,
      timestamp: 1,
    });
    tracker.recordFill({
      symbol: "ETH/USD",
      side: "buy",
      size: 1,
      price: 200,
      timestamp: 2,
    });
    tracker.recordFill({
      symbol: "ETH/USD",
      side: "sell",
      size: 1,
      price: 250,
      timestamp: 3,
    });

    const reconciliation = tracker.reconcile("ETH/USD");
    expect(reconciliation.avgCostRealizedPnL).toBe(100);
    expect(reconciliation.fifoRealizedPnL).toBe(150);
    expect(reconciliation.alert).toBe(true);
  });

  it("does not persist the same cumulative fill twice", async () => {
    const logPath = tempJsonlPath();
    const tracker = await PnLTracker.create({
      reconciliationThresholdPct: 5,
      persistencePath: logPath,
    });

    tracker.recordFill({
      symbol: "WIF/USD",
      side: "buy",
      size: 1,
      price: 0.1631,
      timestamp: 1,
      orderId: "ord-dup",
    });
    tracker.recordFill({
      symbol: "WIF/USD",
      side: "buy",
      size: 1,
      price: 0.1631,
      timestamp: 2,
      orderId: "ord-dup",
    });

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(tracker.getAvgCostPosition("WIF/USD")).toMatchObject({
      symbol: "WIF/USD",
      side: "long",
      size: 1,
      avgCostBasis: 0.1631,
      realizedPnL: 0,
    });
    expect(tracker.getFIFOPosition("WIF/USD")).toMatchObject({
      symbol: "WIF/USD",
      side: "long",
      realizedPnL: 0,
    });
    expect(tracker.getFIFOPosition("WIF/USD")?.lots).toHaveLength(1);
  });

  it("records later partial fills for the same orderId using only the incremental size", async () => {
    const logPath = tempJsonlPath();
    const tracker = await PnLTracker.create({
      reconciliationThresholdPct: 5,
      persistencePath: logPath,
    });

    tracker.recordFill({
      symbol: "BTC/USD",
      side: "buy",
      size: 1,
      price: 100,
      timestamp: 1,
      orderId: "ord-partial",
    });
    tracker.recordFill({
      symbol: "BTC/USD",
      side: "buy",
      size: 2,
      price: 105,
      timestamp: 2,
      orderId: "ord-partial",
    });

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);

    expect(tracker.getAvgCostPosition("BTC/USD")).toMatchObject({
      symbol: "BTC/USD",
      side: "long",
      size: 2,
      avgCostBasis: 105,
      realizedPnL: 0,
    });

    const restored = await PnLTracker.create({
      reconciliationThresholdPct: 5,
      persistencePath: logPath,
    });
    expect(restored.getAvgCostPosition("BTC/USD")).toMatchObject({
      symbol: "BTC/USD",
      side: "long",
      size: 2,
      avgCostBasis: 105,
      realizedPnL: 0,
    });
    expect(restored.getFIFOPosition("BTC/USD")?.lots).toHaveLength(2);
  });

  it("rejects synchronous construction with persistencePath", () => {
    expect(
      () =>
        new PnLTracker({
          reconciliationThresholdPct: 5,
          persistencePath: tempJsonlPath(),
        }),
    ).toThrow("Use PnLTracker.create()");
  });
});
