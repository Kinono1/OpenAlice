import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeDailyGateSummary } from "./daily_gate_summary.js";
import { createDefaultRiskBreakerState } from "./risk_breaker_state.js";

describe("daily_gate_summary", () => {
  it("writes summary file once and returns non-overwrite on repeat", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "daily-gate-summary-"));
    const payload = {
      date: "2026-02-22",
      generatedAt: "2026-02-22T12:00:00.000Z",
      capitalRampStage: "10%",
      executionSummary: null,
      executionGateDecision: null,
      rampEvaluation: null,
      regimeShift: null,
      riskBreaker: createDefaultRiskBreakerState(),
      consecutiveLossStats: { days: 0, cumulativePct: 0 },
      manualOverride: { pauseNewOpens: false },
      notes: ["ok"],
    };

    const first = await writeDailyGateSummary(payload, { baseDir: tempDir });
    const second = await writeDailyGateSummary(payload, { baseDir: tempDir });

    expect(first.written).toBe(true);
    expect(second.written).toBe(false);

    const persisted = JSON.parse(await readFile(first.path, "utf-8"));
    expect(persisted.date).toBe("2026-02-22");
    expect(persisted.capitalRampStage).toBe("10%");
  });
});
