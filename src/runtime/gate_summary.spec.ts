import { describe, expect, it } from "vitest";
import type { ExecutePaperExecutorCycleResult } from "./paper_demo_executor.js";
import {
  buildGateSummary,
  formatGateSummary,
} from "./gate_summary.js";
import type { RuntimeFaithfulSimulationArtifact } from "./runtime_faithful_simulation.js";

function makeArtifact(): RuntimeFaithfulSimulationArtifact {
  return {
    schemaVersion: "runtime_faithful_simulation.v1",
    generatedAt: "2026-03-15T00:00:00.000Z",
    strategyFamily: "vol_gated_trend",
    strategyRuntime: "volTrend",
    registryChecksum: "checksum",
    championValidation: {
      championLoaded: true,
      policyVersionMatch: true,
      checksumValid: true,
      blockingReasons: [],
    },
    paperGate: {
      version: 1,
      generatedAt: "2026-03-15T00:00:00.000Z",
      researchApproved: true,
      runtimeHealthy: true,
      dataFresh: true,
      dataQualityValid: true,
      connectorHealthy: true,
      riskLimitsLoaded: true,
      championLoaded: true,
      policyVersionMatch: true,
      paperExecutorEnabled: true,
      finalAllowPaperTrading: true,
      blockingReasons: [],
    },
    dataContractBySymbol: {
      "BTC/USD": {
        dataQualityValid: true,
        blockingReasons: [],
        duplicateBarsDetected: false,
        missingBarCount: 0,
        timestampAligned: true,
        allBarsCompleted: true,
        validOhlc: true,
        clockSkewValid: true,
      },
    },
    commonBarCount: 20,
    commits: [],
    finalPositions: { "BTC/USD": 0 },
    summary: {
      commitCount: 0,
      operationCount: 0,
      openCount: 0,
      closeCount: 0,
      skippedByPaperGate: false,
      skippedByEventBlock: 0,
      skippedByVeto: 0,
      skippedByCorrelation: 0,
      staleIntentCount: 0,
    },
    blockingReasons: [],
  };
}

function makeExecutorResult(): ExecutePaperExecutorCycleResult {
  return {
    journal: {
      version: 1,
      lastUpdatedAt: "2026-03-15T00:00:00.000Z",
      entries: [],
    },
    executedCommits: [
      {
        simulationCommitId: "sim-1",
        walletCommitHash: "wallet-1",
        operationCount: 1,
      },
    ],
    portfolioTargets: [
      {
        simulationCommitId: "sim-1",
        portfolioTarget: {
          schemaVersion: "portfolio_target.v1",
          generatedAt: "2026-03-15T00:00:00.000Z",
          targetWeights: { "BTC/USD": 0.25 },
          grossExposure: 0.25,
          netExposure: 0.25,
          turnoverUsed: 0.25,
          reasonCodes: [],
        },
      },
    ],
    executionCostReport: {
      schemaVersion: "execution_cost_report.v1",
      generatedAt: "2026-03-15T00:00:00.000Z",
      layers: [
        {
          layer: "paper",
          orderCount: 1,
          fillCount: 1,
          fillRate: 1,
          notionalUsd: 2500,
          feesUsd: 0,
          slippageUsd: 2.5,
          fundingUsd: 0,
          totalCostUsd: 2.5,
          feeBps: 0,
          slippageBps: 10,
          fundingBps: 0,
          totalCostBps: 10,
          latencyP50Ms: 0,
          latencyP95Ms: 0,
        },
      ],
      comparisons: [],
      warnings: [],
    },
    skippedCommitIds: ["sim-0"],
    blockingReasons: [],
  };
}

describe("gate_summary", () => {
  it("builds an all-pass summary without executor", () => {
    const summary = buildGateSummary(makeArtifact());

    expect(summary.releaseGate).toBe("PASS");
    expect(summary.paperGate).toBe("PASS");
    expect(summary.dataContractBySymbol).toEqual({ "BTC/USD": "PASS" });
    expect(summary.executor).toBeUndefined();
  });

  it("reports blocked paper and release gates", () => {
    const artifact = makeArtifact();
    artifact.paperGate.researchApproved = false;
    artifact.paperGate.finalAllowPaperTrading = false;
    artifact.paperGate.blockingReasons = [
      "paper_research_not_approved",
      "paper_champion_registry_missing",
    ];
    artifact.blockingReasons = [...artifact.paperGate.blockingReasons];

    const summary = buildGateSummary(artifact);

    expect(summary.releaseGate).toBe("BLOCKED");
    expect(summary.releaseGateReason).toBe("paper_research_not_approved");
    expect(summary.paperGate).toBe("BLOCKED");
    expect(summary.paperGateReasons).toContain("paper_champion_registry_missing");
  });

  it("reports mixed data contract status across symbols", () => {
    const artifact = makeArtifact();
    artifact.dataContractBySymbol["ETH/USD"] = {
      dataQualityValid: false,
      blockingReasons: ["data_contract_empty_window"],
      duplicateBarsDetected: false,
      missingBarCount: 0,
      timestampAligned: false,
      allBarsCompleted: false,
      validOhlc: false,
      clockSkewValid: false,
    };

    const summary = buildGateSummary(artifact);

    expect(summary.dataContractBySymbol).toEqual({
      "BTC/USD": "PASS",
      "ETH/USD": "BLOCKED",
    });
  });

  it("includes executor summary when execution result is present", () => {
    const summary = buildGateSummary(makeArtifact(), makeExecutorResult());

    expect(summary.executor).toEqual({
      executed: 1,
      skipped: 1,
      blocked: 0,
      executedOpenCommits: 1,
      portfolioTargetsProduced: 1,
      executionCostBps: 10,
    });
  });

  it("formats the summary into human-readable text", () => {
    const artifact = makeArtifact();
    artifact.paperGate.researchApproved = false;
    artifact.paperGate.finalAllowPaperTrading = false;
    artifact.paperGate.blockingReasons = ["paper_research_not_approved"];
    artifact.blockingReasons = ["paper_research_not_approved"];

    const text = formatGateSummary(buildGateSummary(artifact, makeExecutorResult()));

    expect(text).toContain("=== Gate Summary ===");
    expect(text).toContain("releaseGate:        BLOCKED");
    expect(text).toContain(
      "executor:           executed=1 skipped=1 blocked=0 opens=1 targets=1 costBps=10",
    );
  });
});
