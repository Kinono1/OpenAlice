import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isReleaseGateStatusBlocking,
  loadReleaseGateStatus,
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

    const failed = isReleaseGateStatusBlocking({
      version: 1,
      generatedAt: "2026-02-22T00:00:00.000Z",
      allowPaperTrading: true,
      allowLiveTrading: false,
      failedChecks: ["risk_simulation"],
      warningChecks: [],
    });
    expect(failed.blocking).toBe(true);
    expect(String(failed.reason)).toContain("risk_simulation");

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
});
