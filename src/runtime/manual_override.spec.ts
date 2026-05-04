import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadManualOverride,
  normalizeManualOverride,
} from "./manual_override.js";

describe("manual_override", () => {
  it("returns default config when override file is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "manual-override-"));
    const value = await loadManualOverride(join(tempDir, "missing.json"));
    expect(value).toEqual({ pauseNewOpens: false });
  });

  it("normalizes typed fields from a loose payload", () => {
    const normalized = normalizeManualOverride({
      pauseNewOpens: 1,
      ignoreReleaseGate: 1,
      ignoreRegimeShift: 0,
      forceCapitalRampStage: " 25% ",
      forceVolatilityQuantile: 0.9,
      forceDailyLossPct: -4,
      forceCvarDailyLossPct: -2.8,
      forceConsecutiveLossDays: 2.7,
      forceConsecutiveLossPct: -3.2,
      note: " test ",
      updatedAt: "2026-02-22T00:00:00.000Z",
    });

    expect(normalized).toEqual({
      pauseNewOpens: true,
      ignoreReleaseGate: true,
      ignoreRegimeShift: false,
      forceCapitalRampStage: "25%",
      forceVolatilityQuantile: 0.9,
      forceDailyLossPct: -4,
      forceCvarDailyLossPct: -2.8,
      forceConsecutiveLossDays: 2,
      forceConsecutiveLossPct: -3.2,
      note: "test",
      updatedAt: "2026-02-22T00:00:00.000Z",
    });
  });

  it("loads override config from disk", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "manual-override-load-"));
    const file = join(tempDir, "manual_override.json");
    await writeFile(
      file,
      JSON.stringify({
        pauseNewOpens: true,
        ignoreReleaseGate: true,
        forceCapitalRampStage: "10%",
      }),
      "utf-8"
    );

    const loaded = await loadManualOverride(file);
    expect(loaded.pauseNewOpens).toBe(true);
    expect(loaded.ignoreReleaseGate).toBe(true);
    expect(loaded.forceCapitalRampStage).toBe("10%");
  });
});
