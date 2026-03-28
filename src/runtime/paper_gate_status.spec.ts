import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluatePaperGateStatus,
  loadPaperGateStatus,
  writePaperGateStatus,
} from "./paper_gate_status.js";

describe("paper_gate_status", () => {
  it("computes finalAllowPaperTrading only when all booleans pass", () => {
    const status = evaluatePaperGateStatus({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-13T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: [],
        warningChecks: [],
      },
      runtimeHealthy: true,
      dataFresh: true,
      dataQualityValid: true,
      connectorHealthy: true,
      riskLimitsLoaded: true,
      paperExecutorEnabled: true,
      championValidation: {
        championLoaded: true,
        policyVersionMatch: true,
        checksumValid: true,
        blockingReasons: [],
      },
    });

    expect(status.finalAllowPaperTrading).toBe(true);
    expect(status.blockingReasons).toHaveLength(0);
  });

  it("accumulates blocking reasons when paper inputs fail", () => {
    const status = evaluatePaperGateStatus({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-13T00:00:00.000Z",
        allowPaperTrading: false,
        allowLiveTrading: true,
        failedChecks: ["wfo"],
        warningChecks: [],
      },
      runtimeHealthy: false,
      dataFresh: true,
      dataQualityValid: false,
      connectorHealthy: true,
      riskLimitsLoaded: false,
      paperExecutorEnabled: false,
      championValidation: {
        championLoaded: false,
        policyVersionMatch: false,
        checksumValid: false,
        blockingReasons: ["paper_champion_registry_missing"],
      },
    });

    expect(status.finalAllowPaperTrading).toBe(false);
    expect(status.blockingReasons).toContain("paper_research_not_approved");
    expect(status.blockingReasons).toContain("paper_runtime_unhealthy");
    expect(status.blockingReasons).toContain("paper_data_quality_invalid");
    expect(status.blockingReasons).toContain("paper_risk_limits_not_loaded");
    expect(status.blockingReasons).toContain("paper_executor_disabled");
    expect(status.blockingReasons).toContain("paper_champion_registry_missing");
  });

  it("persists and reloads paper gate status", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "paper-gate-"));
    const path = join(tempDir, "paper_gate_status.json");
    const status = evaluatePaperGateStatus({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-13T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: [],
        warningChecks: [],
      },
      runtimeHealthy: true,
      dataFresh: true,
      dataQualityValid: true,
      connectorHealthy: true,
      riskLimitsLoaded: true,
      paperExecutorEnabled: true,
      championValidation: {
        championLoaded: true,
        policyVersionMatch: true,
        checksumValid: true,
        blockingReasons: [],
      },
      sourceReleaseGateStatusPath: "/tmp/release_gate_status.json",
      sourceChampionRegistryPath: "/tmp/paper_champion_registry.json",
    });

    await writePaperGateStatus(status, { filePath: path });
    const loaded = await loadPaperGateStatus(path);
    expect(loaded?.finalAllowPaperTrading).toBe(true);
    expect(loaded?.sourceChampionRegistryPath).toBe(
      "/tmp/paper_champion_registry.json",
    );
  });
});
