import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  CryptoOrder,
  CryptoPosition,
  CryptoTicker,
  ICryptoTradingEngine,
} from "../domain/trading/operation-dispatcher.types.js";
import { refreshRuntimeTruthMainline } from "./runtime_truth_mainline.js";
import { admissionDecisionId, type AdmissionDecisionV1 } from "./admission.js";
import {
  PROMOTION_V2_SCHEMA_VERSION,
  buildPromotionReadinessV2,
  makeGateResult,
  type PromotionReadinessV2,
  type SchemaMeta,
} from "./promotion_v2.js";

describe("runtime_truth_mainline", () => {
  it("writes blocked snapshots when no portfolio target file exists", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runtime-truth-mainline-"));
    await writeFile(
      join(tempDir, "strategy_validation_runs.json"),
      JSON.stringify({
        champion: { strategyId: "S1" },
        candidates: [{ strategyId: "S1", strategy: "trend", promotionEligible: true, admissionIntent: "promotion", runtimeMode: "real_runtime", sourceLineage: "openalice_native" }],
      }),
    );
    await writeFile(
      join(tempDir, "experiment_verdict.v2.json"),
      JSON.stringify({ schemaVersion: "experiment_verdict.v2", result: "NO_GO" }),
    );
    await writeFile(
      join(tempDir, "release_gate_status.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-03-29T00:00:00.000Z",
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ["wfo"],
        warningChecks: [],
      }),
    );

    const result = await refreshRuntimeTruthMainline(
      createEngine(),
      createPlanningStateProvider(),
      {
        symbols: ["BTC/USD", "ETH/USD"],
        validationRunsPath: join(tempDir, "strategy_validation_runs.json"),
        verdictPath: join(tempDir, "experiment_verdict.v2.json"),
        releaseGateStatusPath: join(tempDir, "release_gate_status.json"),
        registryPath: join(tempDir, "missing_registry.json"),
        portfolioTargetPath: join(tempDir, "missing_target.json"),
        snapshotBaseDir: tempDir,
        now: new Date("2026-03-29T00:00:00.000Z"),
      },
    );

    expect(result.portfolioTargetSource).toBe("fallback_zero_target");
    expect(result.runtimeAvailability).toEqual({
      healthy: true,
      reason: null,
    });
    expect(result.truth.promotionGate.pass).toBe(false);
    expect(result.truth.executionPlan.kind).toBe("blocked");
    expect(result.phaseReadiness.research).toMatchObject({
      status: "blocked",
    });

    const snapshot = JSON.parse(
      await readFile(join(tempDir, "paper_gate_status.json"), "utf-8"),
    ) as { finalAllowPaperTrading: boolean };
    expect(snapshot.finalAllowPaperTrading).toBe(false);
  });

  it("uses an explicit portfolio target file when present", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runtime-truth-mainline-target-"));
    await writePaperAdmissionDecision(tempDir);
    await writeFile(
      join(tempDir, "strategy_validation_runs.json"),
      JSON.stringify({
        champion: { strategyId: "S1" },
        candidates: [{ strategyId: "S1", strategy: "trend", promotionEligible: true, admissionIntent: "promotion", runtimeMode: "real_runtime", sourceLineage: "openalice_native" }],
      }),
    );
    await writeFile(
      join(tempDir, "experiment_verdict.v2.json"),
      JSON.stringify({ schemaVersion: "experiment_verdict.v2", result: "GO" }),
    );
    await writeFile(
      join(tempDir, "release_gate_status.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-03-29T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      }),
    );
    await writeFile(
      join(tempDir, "paper_champion_registry.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-03-29T00:00:00.000Z",
        entries: [
          { strategyId: "S1", strategyFamily: "trend", symbols: ["BTC/USD"] },
        ],
      }),
    );
    await writeFile(
      join(tempDir, "paper_portfolio_target.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-03-29T00:00:00.000Z",
        basisEquityUsd: 1000,
        targetGrossExposure: 0.5,
        targetNetExposure: 0.5,
        maxTurnoverPct: 1,
        positions: [
          {
            symbol: "BTC/USD",
            targetWeight: 0.5,
            targetNotionalUsd: 500,
          },
        ],
      }),
    );
    await writeFile(
      join(tempDir, "runtime_publish_state.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-03-29T00:00:00.000Z",
        mode: "publish",
        status: "complete",
        bundleDir: "/tmp/runtime-bundle",
        backupDir: "/tmp/runtime-backup",
        runtimeStatePath: join(tempDir, "runtime_publish_state.json"),
        targets: [
          {
            name: "validationRuns",
            sourcePath: "/tmp/source-validation",
            targetPath: "/tmp/target-validation",
            backupPath: null,
            existedBefore: false,
          },
          {
            name: "experimentVerdict",
            sourcePath: "/tmp/source-verdict",
            targetPath: "/tmp/target-verdict",
            backupPath: null,
            existedBefore: false,
          },
          {
            name: "releaseGateStatus",
            sourcePath: "/tmp/source-gate",
            targetPath: "/tmp/target-gate",
            backupPath: null,
            existedBefore: false,
          },
          {
            name: "championRegistry",
            sourcePath: "/tmp/source-registry",
            targetPath: "/tmp/target-registry",
            backupPath: null,
            existedBefore: false,
          },
          {
            name: "paperPortfolioTarget",
            sourcePath: "/tmp/source-target",
            targetPath: "/tmp/target-target",
            backupPath: null,
            existedBefore: false,
          },
        ],
      }),
    );

    const result = await refreshRuntimeTruthMainline(
      createEngine(),
      createPlanningStateProvider(),
      {
        symbols: ["BTC/USD", "ETH/USD"],
        validationRunsPath: join(tempDir, "strategy_validation_runs.json"),
        verdictPath: join(tempDir, "experiment_verdict.v2.json"),
        releaseGateStatusPath: join(tempDir, "release_gate_status.json"),
        registryPath: join(tempDir, "paper_champion_registry.json"),
        portfolioTargetPath: join(tempDir, "paper_portfolio_target.json"),
        snapshotBaseDir: tempDir,
        admissionDecisionPath: join(tempDir, "admission_decision.v1.json"),
        proofTracking: {
          status: "tracking",
          elapsedDays: 7,
          targetDays: 90,
          netPnlPositive: true,
        },
        now: new Date("2026-03-29T00:00:00.000Z"),
      },
    );

    expect(result.portfolioTargetSource).toBe("file");
    expect(result.runtimeAvailability).toEqual({
      healthy: true,
      reason: null,
    });
    expect(result.truth.executionPlan.kind).toBe("active");
    expect(result.phaseReadiness).toMatchObject({
      research: {
        status: "ready",
      },
      paper: {
        status: "active_ready",
      },
      liveTinyCapital: {
        status: "tiny_cap_ready",
      },
      proofTracking: {
        status: "tracking",
        elapsedDays: 7,
      },
    });
    const snapshot = JSON.parse(
      await readFile(join(tempDir, "paper_executor_status.latest.json"), "utf-8"),
    ) as { summary: { releaseGate: string; paperGate: string } };
    expect(snapshot.summary.releaseGate).toBe("PASS");
    expect(snapshot.summary.paperGate).toBe("PASS");
  });

  it("blocks the mainline paper executor when required promotion v2 readiness is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runtime-truth-mainline-promotion-v2-"));
    await writePassingMainlineArtifacts(tempDir);

    const result = await refreshRuntimeTruthMainline(
      createEngine(),
      createPlanningStateProvider(),
      {
        symbols: ["BTC/USD", "ETH/USD"],
        validationRunsPath: join(tempDir, "strategy_validation_runs.json"),
        verdictPath: join(tempDir, "experiment_verdict.v2.json"),
        releaseGateStatusPath: join(tempDir, "release_gate_status.json"),
        registryPath: join(tempDir, "paper_champion_registry.json"),
        portfolioTargetPath: join(tempDir, "paper_portfolio_target.json"),
        runtimePublishStatePath: join(tempDir, "runtime_publish_state.json"),
        promotionReadinessV2Path: join(tempDir, "missing_strategy_promotion.latest.json"),
        requirePromotionV2: true,
        admissionDecisionPath: join(tempDir, "admission_decision.v1.json"),
        snapshotBaseDir: tempDir,
        now: new Date("2026-03-29T00:00:00.000Z"),
      },
    );

    expect(result.promotionV2).toMatchObject({
      required: true,
      loadStatus: "missing",
    });
    expect(result.truth.executionPlan.kind).toBe("blocked");
    if (result.truth.executionPlan.kind === "blocked") {
      expect(result.truth.executionPlan.blockingReasons).toContain(
        "promotion_v2_readiness_missing",
      );
    }
  });

  it("loads promotion v2 readiness before allowing the mainline paper executor", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runtime-truth-mainline-promotion-v2-loaded-"));
    await writePassingMainlineArtifacts(tempDir);
    const readinessPath = join(tempDir, "strategy_promotion.latest.json");
    await writeFile(
      readinessPath,
      `${JSON.stringify(createPromotionReadiness(), null, 2)}\n`,
    );

    const result = await refreshRuntimeTruthMainline(
      createEngine(),
      createPlanningStateProvider(),
      {
        symbols: ["BTC/USD", "ETH/USD"],
        validationRunsPath: join(tempDir, "strategy_validation_runs.json"),
        verdictPath: join(tempDir, "experiment_verdict.v2.json"),
        releaseGateStatusPath: join(tempDir, "release_gate_status.json"),
        registryPath: join(tempDir, "paper_champion_registry.json"),
        portfolioTargetPath: join(tempDir, "paper_portfolio_target.json"),
        runtimePublishStatePath: join(tempDir, "runtime_publish_state.json"),
        promotionReadinessV2Path: readinessPath,
        requirePromotionV2: true,
        validatePromotionV2Artifacts: false,
        admissionDecisionPath: join(tempDir, "admission_decision.v1.json"),
        snapshotBaseDir: tempDir,
        now: new Date("2026-03-29T00:00:00.000Z"),
      },
    );

    expect(result.promotionV2.loadStatus).toBe("loaded");
    expect(result.truth.executionPlan.kind).toBe("active");
  });

  it("treats a pending runtime publish state as unavailable even if a target file exists", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runtime-truth-mainline-pending-"));
    await writeFile(
      join(tempDir, "strategy_validation_runs.json"),
      JSON.stringify({
        champion: { strategyId: "S1" },
        candidates: [{ strategyId: "S1", strategy: "trend", promotionEligible: true, admissionIntent: "promotion", runtimeMode: "real_runtime", sourceLineage: "openalice_native" }],
      }),
    );
    await writeFile(
      join(tempDir, "experiment_verdict.v2.json"),
      JSON.stringify({ schemaVersion: "experiment_verdict.v2", result: "GO" }),
    );
    await writeFile(
      join(tempDir, "release_gate_status.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-03-29T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      }),
    );
    await writeFile(
      join(tempDir, "paper_champion_registry.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-03-29T00:00:00.000Z",
        entries: [
          { strategyId: "S1", strategyFamily: "trend", symbols: ["BTC/USD"] },
        ],
      }),
    );
    await writeFile(
      join(tempDir, "paper_portfolio_target.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-03-29T00:00:00.000Z",
        basisEquityUsd: 1000,
        targetGrossExposure: 0.75,
        targetNetExposure: 0.75,
        maxTurnoverPct: 1,
        positions: [
          {
            symbol: "BTC/USD",
            targetWeight: 0.75,
            targetNotionalUsd: 750,
          },
        ],
      }),
    );
    await writeFile(
      join(tempDir, "runtime_publish_state.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-03-29T00:00:00.000Z",
        mode: "publish",
        status: "pending",
        bundleDir: "/tmp/runtime-bundle",
        backupDir: "/tmp/runtime-backup",
        runtimeStatePath: join(tempDir, "runtime_publish_state.json"),
        targets: [
          {
            name: "validationRuns",
            sourcePath: "/tmp/source-validation",
            targetPath: "/tmp/target-validation",
            backupPath: null,
            existedBefore: false,
          },
          {
            name: "experimentVerdict",
            sourcePath: "/tmp/source-verdict",
            targetPath: "/tmp/target-verdict",
            backupPath: null,
            existedBefore: false,
          },
        ],
      }),
    );

    const result = await refreshRuntimeTruthMainline(
      createEngine(),
      createPlanningStateProvider(),
      {
        symbols: ["BTC/USD", "ETH/USD"],
        validationRunsPath: join(tempDir, "strategy_validation_runs.json"),
        verdictPath: join(tempDir, "experiment_verdict.v2.json"),
        releaseGateStatusPath: join(tempDir, "release_gate_status.json"),
        registryPath: join(tempDir, "paper_champion_registry.json"),
        portfolioTargetPath: join(tempDir, "paper_portfolio_target.json"),
        runtimePublishStatePath: join(tempDir, "runtime_publish_state.json"),
        snapshotBaseDir: tempDir,
        now: new Date("2026-03-29T00:00:00.000Z"),
      },
    );

    expect(result.runtimeAvailability).toEqual({
      healthy: false,
      reason: "runtime_publish_state_pending",
    });
    expect(result.portfolioTargetSource).toBe("fallback_zero_target");
    expect(result.truth.paperGate.blockingReasons).toContain(
      "paper_runtime_unhealthy",
    );
    expect(result.truth.paperGate.blockingReasons).toContain(
      "paper_executor_disabled",
    );
    expect(result.truth.executionPlan.kind).toBe("blocked");
    const paperGateStatus = JSON.parse(
      await readFile(join(tempDir, "paper_gate_status.json"), "utf-8"),
    ) as { runtimeHealthy: boolean };
    expect(paperGateStatus.runtimeHealthy).toBe(false);
  });
});

async function writePassingMainlineArtifacts(tempDir: string): Promise<void> {
  await writePaperAdmissionDecision(tempDir);
  await writeFile(
    join(tempDir, "strategy_validation_runs.json"),
    JSON.stringify({
      champion: { strategyId: "S1" },
      candidates: [
        {
          strategyId: "S1",
          strategy: "trend",
          promotionEligible: true,
          admissionIntent: "promotion",
          runtimeMode: "real_runtime",
          sourceLineage: "openalice_native",
        },
      ],
    }),
  );
  await writeFile(
    join(tempDir, "experiment_verdict.v2.json"),
    JSON.stringify({ schemaVersion: "experiment_verdict.v2", result: "GO" }),
  );
  await writeFile(
    join(tempDir, "release_gate_status.json"),
    JSON.stringify({
      version: 1,
      generatedAt: "2026-03-29T00:00:00.000Z",
      allowPaperTrading: true,
      allowLiveTrading: true,
      failedChecks: [],
      warningChecks: [],
    }),
  );
  await writeFile(
    join(tempDir, "paper_champion_registry.json"),
    JSON.stringify({
      version: 1,
      generatedAt: "2026-03-29T00:00:00.000Z",
      entries: [
        { strategyId: "S1", strategyFamily: "trend", symbols: ["BTC/USD"] },
      ],
    }),
  );
  await writeFile(
    join(tempDir, "paper_portfolio_target.json"),
    JSON.stringify({
      version: 1,
      generatedAt: "2026-03-29T00:00:00.000Z",
      basisEquityUsd: 1000,
      targetGrossExposure: 0.5,
      targetNetExposure: 0.5,
      maxTurnoverPct: 1,
      positions: [
        {
          symbol: "BTC/USD",
          targetWeight: 0.5,
          targetNotionalUsd: 500,
        },
      ],
    }),
  );
  await writeFile(
    join(tempDir, "runtime_publish_state.json"),
    JSON.stringify({
      version: 1,
      generatedAt: "2026-03-29T00:00:00.000Z",
      mode: "publish",
      status: "complete",
      bundleDir: "/tmp/runtime-bundle",
      backupDir: "/tmp/runtime-backup",
      runtimeStatePath: join(tempDir, "runtime_publish_state.json"),
      targets: [
        {
          name: "validationRuns",
          sourcePath: "/tmp/source-validation",
          targetPath: "/tmp/target-validation",
          backupPath: null,
          existedBefore: false,
        },
        {
          name: "experimentVerdict",
          sourcePath: "/tmp/source-verdict",
          targetPath: "/tmp/target-verdict",
          backupPath: null,
          existedBefore: false,
        },
        {
          name: "releaseGateStatus",
          sourcePath: "/tmp/source-gate",
          targetPath: "/tmp/target-gate",
          backupPath: null,
          existedBefore: false,
        },
        {
          name: "championRegistry",
          sourcePath: "/tmp/source-registry",
          targetPath: "/tmp/target-registry",
          backupPath: null,
          existedBefore: false,
        },
        {
          name: "paperPortfolioTarget",
          sourcePath: "/tmp/source-target",
          targetPath: "/tmp/target-target",
          backupPath: null,
          existedBefore: false,
        },
      ],
    }),
  );
}

async function writePaperAdmissionDecision(tempDir: string): Promise<void> {
  const core: Omit<AdmissionDecisionV1, "schemaVersion" | "decisionId"> = {
    candidateId: "runtime-mainline-candidate",
    evaluatedAt: "2026-03-29T00:00:00.000Z",
    expiresAt: "2026-03-29T00:05:00.000Z",
    sourceCommit: "1".repeat(40),
    dirtyStateHash: "2".repeat(64),
    releaseManifestHash: "3".repeat(64),
    stage: "paper_allowed",
    paperTradingAllowed: true,
    liveTradingAllowed: false,
    liveExecutionArmed: false,
    gateResults: [{
      gateId: "promotion_v2_6",
      status: "pass",
      evidenceRefs: ["4".repeat(64)],
      reasonCodes: [],
    }],
    blockingReasons: ["missing_gate_evidence:tiny_cap_review"],
    evidenceRefs: ["4".repeat(64)],
    approvalRefs: [],
    accountScope: ["paper-main"],
    assetScope: ["BTC/USD", "ETH/USD"],
  };
  await writeFile(
    join(tempDir, "admission_decision.v1.json"),
    `${JSON.stringify({
      schemaVersion: "admission_decision.v1",
      decisionId: admissionDecisionId(core),
      ...core,
    }, null, 2)}\n`,
  );
}

function createPromotionReadiness(): PromotionReadinessV2 {
  const generatedAt = "2026-03-29T00:00:00.000Z";
  const expiresAt = "2026-03-29T01:00:00.000Z";
  const schemaMeta: SchemaMeta = {
    schemaName: "strategy_promotion",
    schemaVersion: PROMOTION_V2_SCHEMA_VERSION,
    createdBy: "vitest",
    createdAt: generatedAt,
    codeCommit: "test",
  };

  return buildPromotionReadinessV2({
    schemaMeta,
    strategyId: "cross-sectional-v2",
    experimentId: "experiment-1",
    generatedAt,
    globalReleaseGate: makeGateResult({ gateName: "global_release", expiresAt }),
    researchGate: makeGateResult({ gateName: "research", expiresAt }),
    monetizationGate: makeGateResult({ gateName: "monetization", expiresAt }),
    paperGate: makeGateResult({ gateName: "paper", expiresAt }),
    liveGate: makeGateResult({
      gateName: "live",
      hardBlocks: ["tiny_cap_not_reviewed"],
      expiresAt,
    }),
    monetization: {
      netExpectancyBpsPerTrade: 30,
      netExpectancyUsdPerTrade: 3,
      netExpectancyUsdPerDay: 6,
      netExpectancyUsdPerMonth: 180,
      validSignalsPerMonth: 30,
      executableCapacityUsd: 5_000,
      turnoverPerDay: 0.2,
      routeAdjustedBreakEvenBps: 14,
      benchmarkExcessReturnBps: 18,
    },
    execution: {
      recentOrderCount: 20,
      slippageViolationCount: 0,
      actualToSimulatedCostRatio: 1.1,
      missedFillRate: 0.2,
      decayCircuitBreakerTriggered: false,
    },
    dataFreshness: {
      latestDecisionStatus: "fresh",
      staleBlockCount: 0,
      maxDataLatencyMinutes: 3,
    },
    evidence: {
      supportingEvidenceIds: ["evidence-1"],
      blockingEvidenceIds: [],
      missingRequiredEvidence: [],
    },
    now: new Date(generatedAt),
  });
}

function createPlanningStateProvider() {
  return {
    buildRuntimePlanningState: vi.fn().mockResolvedValue({
      regimeSeverity: "stable",
      regimeReason: null,
      capitalRampStage: "5%",
      releaseGateStatus: null,
      releaseGateBlocked: false,
      releaseGateBlockedReason: null,
    }),
  };
}

function createEngine(
  positions: CryptoPosition[] = [],
): ICryptoTradingEngine {
  return {
    placeOrder: vi.fn() as unknown as ICryptoTradingEngine["placeOrder"],
    getPositions: vi.fn().mockResolvedValue(positions),
    getOrders: vi.fn().mockResolvedValue([] as CryptoOrder[]),
    getAccount: vi.fn() as unknown as ICryptoTradingEngine["getAccount"],
    cancelOrder: vi.fn() as unknown as ICryptoTradingEngine["cancelOrder"],
    adjustLeverage: vi.fn() as unknown as ICryptoTradingEngine["adjustLeverage"],
    getTicker: vi.fn().mockImplementation(async (symbol: string) => ({
      symbol,
      last: symbol === "ETH/USD" ? 100 : 200,
      bid: symbol === "ETH/USD" ? 99 : 199,
      ask: symbol === "ETH/USD" ? 101 : 201,
      high: symbol === "ETH/USD" ? 105 : 205,
      low: symbol === "ETH/USD" ? 95 : 195,
      volume: 1000,
      timestamp: new Date("2026-03-29T00:00:00.000Z"),
    } satisfies CryptoTicker)),
    getFundingRate: vi.fn() as unknown as ICryptoTradingEngine["getFundingRate"],
    getOrderBook: vi.fn() as unknown as ICryptoTradingEngine["getOrderBook"],
  };
}
