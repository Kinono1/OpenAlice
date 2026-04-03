import { describe, expect, it } from "vitest";
import { evaluateLiveProofWindow } from "./live_proof_tracker.js";

describe("live_proof_tracker", () => {
  it("reports in_progress while the proof window is still incomplete", () => {
    const result = evaluateLiveProofWindow({
      target: {
        requiredDays: 90,
        maxDrawdownPct: 10,
      },
      dailySnapshots: [
        { date: "2026-01-01", equityUsd: 1000 },
        { date: "2026-01-02", equityUsd: 1010 },
        { date: "2026-01-03", equityUsd: 1020 },
      ],
      trades: [{ closedAt: "2026-01-03T10:00:00Z", realizedPnlUsd: 20 }],
      now: new Date("2026-01-03T12:00:00Z"),
    });

    expect(result.status).toBe("in_progress");
    expect(result.metrics.coveredDays).toBe(3);
    expect(result.metrics.daysRemaining).toBe(87);
    expect(result.metrics.netPnlUsd).toBe(20);
    expect(result.breachReasons).toEqual([]);
  });

  it("passes when the full window is covered, pnl is positive, and drawdown is within budget", () => {
    const snapshots = Array.from({ length: 5 }, (_, index) => ({
      date: `2026-01-0${index + 1}`,
      equityUsd: 1000 + index * 15,
    }));

    const result = evaluateLiveProofWindow({
      target: {
        requiredDays: 5,
        maxDrawdownPct: 10,
      },
      dailySnapshots: snapshots,
      trades: [{ closedAt: "2026-01-05T10:00:00Z", realizedPnlUsd: 60 }],
      now: new Date("2026-01-05T12:00:00Z"),
    });

    expect(result.status).toBe("passed");
    expect(result.metrics.netPnlUsd).toBe(60);
    expect(result.metrics.netPnlPct).toBe(6);
    expect(result.metrics.maxDrawdownPct).toBe(0);
  });

  it("fails immediately when drawdown breaches the configured limit", () => {
    const result = evaluateLiveProofWindow({
      target: {
        requiredDays: 90,
        maxDrawdownPct: 10,
      },
      dailySnapshots: [
        { date: "2026-01-01", equityUsd: 1000 },
        { date: "2026-01-02", equityUsd: 1080 },
        { date: "2026-01-03", equityUsd: 940 },
      ],
      now: new Date("2026-01-03T12:00:00Z"),
    });

    expect(result.status).toBe("failed");
    expect(result.breachReasons).toContain("proof_max_drawdown_breached");
    expect(result.metrics.maxDrawdownPct).toBeGreaterThan(10);
  });

  it("fails at the end of the window when pnl is not positive", () => {
    const result = evaluateLiveProofWindow({
      target: {
        requiredDays: 3,
        maxDrawdownPct: 20,
      },
      dailySnapshots: [
        { date: "2026-01-01", equityUsd: 1000 },
        { date: "2026-01-02", equityUsd: 1005 },
        { date: "2026-01-03", equityUsd: 999 },
      ],
      now: new Date("2026-01-03T12:00:00Z"),
    });

    expect(result.status).toBe("failed");
    expect(result.breachReasons).toContain("proof_net_pnl_not_positive");
  });

  it("collapses duplicate snapshot dates and accounts for fees in realized trade pnl", () => {
    const result = evaluateLiveProofWindow({
      target: {
        requiredDays: 2,
        maxDrawdownPct: 20,
      },
      dailySnapshots: [
        { date: "2026-01-01", equityUsd: 1000 },
        { date: "2026-01-01", equityUsd: 1002 },
        { date: "2026-01-02", equityUsd: 1010 },
      ],
      trades: [
        {
          closedAt: "2026-01-02T08:00:00Z",
          realizedPnlUsd: 15,
          feesUsd: 2,
        },
      ],
      now: new Date("2026-01-02T12:00:00Z"),
    });

    expect(result.status).toBe("passed");
    expect(result.metrics.coveredDays).toBe(2);
    expect(result.metrics.realizedTradePnlUsd).toBe(13);
    expect(result.warnings).toContain("proof_duplicate_snapshot_dates_collapsed");
  });
});
