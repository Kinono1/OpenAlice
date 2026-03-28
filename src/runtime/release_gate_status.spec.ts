import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyReleaseGateProvenance,
  isLiveReleaseGateStatusBlocking,
  isPaperReleaseGateStatusBlocking,
  isReleaseGateStatusBlocking,
  isReleaseGateResearchOwned,
  loadReleaseGateStatus,
  normalizeReleaseGateStatus,
  writeReleaseGateStatus,
} from "./release_gate_status.js";

describe("release_gate_status", () => {
  it("persists and reloads release gate status", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "release-gate-status-"));
    const path = join(tempDir, "release_gate_status.json");

    await writeReleaseGateStatus(
      {
        checks: [],
        failedChecks: ["wfo"],
        warningChecks: [],
        hardFail: true,
        allowPaperTrading: false,
        allowLiveTrading: false,
      },
      {
        filePath: path,
        sourceReportPath: "/tmp/report.json",
      },
    );

    const loaded = await loadReleaseGateStatus(path);
    expect(loaded).not.toBeNull();
    expect(loaded?.allowLiveTrading).toBe(false);
    expect(loaded?.failedChecks).toEqual(["wfo"]);
    expect(loaded?.sourceReportPath).toBe("/tmp/report.json");
  });

  it("blocks when status is missing, expired, or failed", () => {
    expect(isReleaseGateStatusBlocking(null).blocking).toBe(true);
    expect(isPaperReleaseGateStatusBlocking(null).blocking).toBe(true);
    expect(isLiveReleaseGateStatusBlocking(null).blocking).toBe(true);

    const paperPassLiveFail = {
      version: 1 as const,
      generatedAt: "2026-02-22T00:00:00.000Z",
      allowPaperTrading: true,
      allowLiveTrading: false,
      failedChecks: ["risk_simulation"],
      warningChecks: [],
    };
    expect(isReleaseGateStatusBlocking(paperPassLiveFail).blocking).toBe(false);
    expect(isReleaseGateStatusBlocking(paperPassLiveFail, new Date(), "paper").blocking).toBe(false);
    expect(isReleaseGateStatusBlocking(paperPassLiveFail, new Date(), "live").blocking).toBe(true);
    expect(isPaperReleaseGateStatusBlocking(paperPassLiveFail).blocking).toBe(false);
    expect(isLiveReleaseGateStatusBlocking(paperPassLiveFail).blocking).toBe(true);

    const paperFailLivePass = {
      version: 1 as const,
      generatedAt: "2026-02-22T00:00:00.000Z",
      allowPaperTrading: false,
      allowLiveTrading: true,
      failedChecks: ["wfo"],
      warningChecks: [],
    };
    expect(isReleaseGateStatusBlocking(paperFailLivePass).blocking).toBe(false);
    expect(isPaperReleaseGateStatusBlocking(paperFailLivePass).blocking).toBe(true);
    expect(isLiveReleaseGateStatusBlocking(paperFailLivePass).blocking).toBe(false);

    const failedAllModes = isReleaseGateStatusBlocking({
      version: 1,
      generatedAt: "2026-02-22T00:00:00.000Z",
      allowPaperTrading: false,
      allowLiveTrading: false,
      failedChecks: ["risk_simulation"],
      warningChecks: [],
    });
    expect(failedAllModes.blocking).toBe(true);
    expect(String(failedAllModes.reason)).toContain("risk_simulation");

    const expired = isReleaseGateStatusBlocking(
      {
        version: 1,
        generatedAt: "2026-02-22T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
        expiresAt: "2026-02-01T00:00:00.000Z",
      },
      new Date("2026-02-22T00:00:00.000Z"),
    );
    expect(expired.blocking).toBe(true);
  });

  it("classifies research-owned and runtime-owned provenance", () => {
    const researchOwned = classifyReleaseGateProvenance({
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      allowPaperTrading: true,
      allowLiveTrading: false,
      failedChecks: [],
      warningChecks: [],
      sourceReportPath:
        "/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/data/research/strategy/strategy_validation_runs.json",
    });
    expect(researchOwned.classification).toBe("research_owned");
    expect(isReleaseGateResearchOwned({
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      allowPaperTrading: true,
      allowLiveTrading: false,
      failedChecks: [],
      warningChecks: [],
      sourceReportPath:
        "/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/data/research/strategy/strategy_validation_runs.json",
    }).ok).toBe(true);

    const runtimeOwned = classifyReleaseGateProvenance({
      version: 1,
      generatedAt: "2026-03-18T00:00:00.000Z",
      allowPaperTrading: false,
      allowLiveTrading: false,
      failedChecks: ["wfo"],
      warningChecks: [],
      sourceReportPath:
        "/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/data/runtime/runtime_faithful_simulation.latest.json",
    });
    expect(runtimeOwned.classification).toBe("runtime_owned");
    expect(String(runtimeOwned.reason)).toContain("runtime_owned");
    expect(
      isReleaseGateResearchOwned({
        version: 1,
        generatedAt: "2026-03-18T00:00:00.000Z",
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ["wfo"],
        warningChecks: [],
        sourceReportPath:
          "/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/data/runtime/runtime_faithful_simulation.latest.json",
      }).ok,
    ).toBe(false);
  });

  it("rejects non-strict ISO timestamps", () => {
    expect(() =>
      normalizeReleaseGateStatus({
        version: 1,
        generatedAt: "2026-02-22 00:00:00Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      }),
    ).toThrow("generatedAt must be a strict ISO-8601 UTC timestamp.");
  });
});
