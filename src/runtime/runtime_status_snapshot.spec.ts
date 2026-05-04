import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CryptoPosition } from "../domain/trading/operation-dispatcher.types.js";
import { buildPortfolioTargetFromWeights } from "../portfolio/target.js";
import { buildPaperExecutionPlan } from "./paper_execution_plan.js";
import {
  buildRuntimeStatusSnapshot,
  buildRuntimeStatusSnapshotPaths,
  writeRuntimeStatusSnapshot,
} from "./runtime_status_snapshot.js";

const portfolioTarget = buildPortfolioTargetFromWeights({
  basisEquityUsd: 1_000,
  weights: {
    "BTC/USD": 0.25,
    "ETH/USD": 0.15,
  },
  maxTurnoverPct: 1,
});

const pricesBySymbol = {
  "BTC/USD": 100,
  "ETH/USD": 50,
};

const currentPositions: CryptoPosition[] = [
  {
    symbol: "BTC/USD",
    side: "long",
    size: 2,
    entryPrice: 95,
    leverage: 1,
    margin: 200,
    liquidationPrice: 0,
    markPrice: 100,
    unrealizedPnL: 10,
    positionValue: 200,
  },
  {
    symbol: "ETH/USD",
    side: "short",
    size: 1,
    entryPrice: 55,
    leverage: 1,
    margin: 50,
    liquidationPrice: 0,
    markPrice: 50,
    unrealizedPnL: 5,
    positionValue: 50,
  },
];

describe("runtime_status_snapshot", () => {
  it("builds a blocked snapshot from formal inputs", () => {
    const snapshot = buildRuntimeStatusSnapshot({
      promotionGate: {
        pass: false,
        blockingReasons: ["promotion_requires_go_verdict"],
        diagnostics: {
          verdictResult: "NO_GO",
          verdictReasonCodes: ["HARD_FDR_THRESHOLD_FAIL"],
          portfolioReasonCodes: ["HARD_RELEASE_GATE_BLOCKED"],
          validationReasons: ["validation_symbol_missing:ETH/USD"],
          portfolioCandidateFailures: [
            {
              strategyId: "BTC_TREND",
              strategyName: "BTC Trend",
              failureReasons: ["HARD_FDR_THRESHOLD_FAIL"],
            },
          ],
          symbolDiagnostics: [
            {
              symbol: "BTC/USD",
              result: "NO_GO",
              reasonCodes: ["HARD_FDR_THRESHOLD_FAIL"],
              candidateFailures: [
                {
                  strategyId: "BTC_TREND",
                  strategyName: "BTC Trend",
                  failureReasons: ["HARD_FDR_THRESHOLD_FAIL"],
                },
              ],
            },
          ],
          releaseGate: {
            source: "experiment_verdict",
            allowPaperTrading: false,
            allowLiveTrading: false,
            failedChecks: ["wfo"],
            warningChecks: [],
          },
        },
      },
      paperGate: {
        allowPaperTrading: false,
        blockingReasons: ["paper_research_not_approved"],
      },
      executionPlan: {
        kind: "blocked",
        blockingReasons: ["paper_gate_blocked"],
      },
      validationRunsPath: "/tmp/strategy_validation_runs.json",
      verdictPath: "/tmp/experiment_verdict.v2.json",
      registryPath: "/tmp/paper_champion_registry.json",
    });

    expect(snapshot.paperPromotionStatus.canPromote).toBe(false);
    expect(snapshot.paperPromotionStatus.diagnostics).toMatchObject({
      verdictResult: "NO_GO",
      verdictReasonCodes: ["HARD_FDR_THRESHOLD_FAIL"],
      portfolioReasonCodes: ["HARD_RELEASE_GATE_BLOCKED"],
      validationReasons: ["validation_symbol_missing:ETH/USD"],
      portfolioCandidateFailures: [
        {
          strategyId: "BTC_TREND",
          strategyName: "BTC Trend",
          failureReasons: ["HARD_FDR_THRESHOLD_FAIL"],
        },
      ],
      symbolDiagnostics: [
        {
          symbol: "BTC/USD",
          result: "NO_GO",
          reasonCodes: ["HARD_FDR_THRESHOLD_FAIL"],
          candidateFailures: [
            {
              strategyId: "BTC_TREND",
              strategyName: "BTC Trend",
              failureReasons: ["HARD_FDR_THRESHOLD_FAIL"],
            },
          ],
        },
      ],
      releaseGate: {
        source: "experiment_verdict",
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ["wfo"],
        warningChecks: [],
      },
    });
    expect(snapshot.paperGateStatus.promotionDiagnostics).toMatchObject({
      verdictResult: "NO_GO",
      validationReasons: ["validation_symbol_missing:ETH/USD"],
    });
    expect(snapshot.paperGateStatus.finalAllowPaperTrading).toBe(false);
    expect(snapshot.phaseReadiness.research).toMatchObject({
      status: "blocked",
      ready: false,
    });
    expect(snapshot.phaseReadiness.paper).toMatchObject({
      status: "blocked",
      ready: false,
    });
    expect(snapshot.phaseReadiness.liveTinyCapital).toMatchObject({
      status: "blocked",
      ready: false,
    });
    expect(snapshot.phaseReadiness.proofTracking).toMatchObject({
      status: "blocked",
      readyToStart: false,
    });
    expect(snapshot.paperExecutorStatus.blockingReasons).toEqual([
      "promotion_requires_go_verdict",
      "paper_research_not_approved",
      "paper_gate_blocked",
    ]);
    expect(snapshot.runtimeFaithfulSimulation.summary).toMatchObject({
      skippedByPaperGate: true,
    });
  });

  it("builds a portfolio-level active snapshot for BTC and ETH execution truth", () => {
    const executionPlan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: true,
      paperGateMode: "active",
      paperGateAllowsExecution: true,
      championRegistryState: "valid",
      championSetComplete: true,
      regimeSeverity: "stable",
      portfolioTarget,
      currentPositions,
      pricesBySymbol,
    });

    expect(executionPlan.kind).toBe("active");
    const snapshot = buildRuntimeStatusSnapshot({
      promotionGate: {
        pass: true,
        blockingReasons: [],
      },
      paperGate: {
        allowPaperTrading: true,
        blockingReasons: [],
      },
      executionPlan:
        executionPlan.kind === "blocked"
          ? executionPlan
          : {
              kind: executionPlan.kind,
              flatReasons:
                executionPlan.kind === "flat" ? executionPlan.flatReasons : undefined,
              portfolioTarget: executionPlan.portfolioTarget,
              rebalancePlan: executionPlan.rebalancePlan,
              walletOperations: executionPlan.walletOperations,
              currentPositions,
              pricesBySymbol,
            },
      planningState: {
        regimeSeverity: "stable",
        regimeReason: null,
        capitalRampStage: "5%",
        releaseGateStatus: null,
        releaseGateBlocked: false,
        releaseGateBlockedReason: null,
        releaseGateAllowsPaperTrading: true,
        releaseGateAllowsLiveTrading: true,
      },
      releaseGateStatus: {
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      proofTracking: {
        status: "tracking",
        elapsedDays: 14,
        targetDays: 90,
        netPnlPositive: true,
        maxDrawdownPct: 4.2,
        drawdownBudgetPct: 10,
        source: "paper-shadow",
      },
    });

    expect(snapshot.paperPromotionStatus.canPromote).toBe(true);
    expect(snapshot.paperGateStatus.finalAllowPaperTrading).toBe(true);
    expect(snapshot.phaseReadiness.research).toMatchObject({
      status: "ready",
      ready: true,
    });
    expect(snapshot.phaseReadiness.paper).toMatchObject({
      status: "active_ready",
      ready: true,
      hasNonFlatTarget: true,
    });
    expect(snapshot.phaseReadiness.liveTinyCapital).toMatchObject({
      status: "tiny_cap_ready",
      ready: true,
      capitalMode: "tiny_cap_only",
    });
    expect(snapshot.phaseReadiness.proofTracking).toMatchObject({
      status: "tracking",
      elapsedDays: 14,
      remainingDays: 76,
      readyToStart: true,
    });
    expect(snapshot.paperExecutorStatus.summary).toMatchObject({
      releaseGate: "PASS",
      paperGate: "PASS",
      targetSymbols: ["BTC/USD", "ETH/USD"],
      walletOperationCount: 3,
    });
    expect(snapshot.paperExecutorStatus.portfolioPlan).toMatchObject({
      targetSymbolCount: 2,
      currentPositionCount: 2,
      totalPlannedTurnoverUsd: 250,
    });
    expect(snapshot.runtimeFaithfulSimulation.summary).toMatchObject({
      operationCount: 3,
      openCount: 2,
      closeCount: 1,
      targetSymbolCount: 2,
      rebalanceEntryCount: 2,
      currentPositionCount: 2,
      skippedByPaperGate: false,
    });
    expect(snapshot.runtimeFaithfulSimulation.dataContractBySymbol).toMatchObject({
      "BTC/USD": {
        hasTarget: true,
        hasRebalanceEntry: true,
        hasCurrentPosition: true,
        hasQuotedPrice: true,
        plannedAction: "increase_long",
      },
      "ETH/USD": {
        hasTarget: true,
        hasRebalanceEntry: true,
        hasCurrentPosition: true,
        hasQuotedPrice: true,
        plannedAction: "flip_to_long",
      },
    });
    expect(snapshot.runtimeFaithfulSimulation.finalPositions).toMatchObject({
      "BTC/USD": {
        currentNotionalUsd: 200,
        effectiveTargetNotionalUsd: 250,
        action: "increase_long",
      },
      "ETH/USD": {
        currentNotionalUsd: -50,
        effectiveTargetNotionalUsd: 150,
        action: "flip_to_long",
      },
    });
    expect(snapshot.runtimeFaithfulSimulation.blockingReasons).toEqual([]);
  });

  it("requires proof tracking to start before marking tiny-cap readiness as live-ready", () => {
    const executionPlan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: true,
      paperGateMode: "active",
      paperGateAllowsExecution: true,
      championRegistryState: "valid",
      championSetComplete: true,
      regimeSeverity: "stable",
      portfolioTarget,
      currentPositions,
      pricesBySymbol,
    });

    expect(executionPlan.kind).toBe("active");
    const snapshot = buildRuntimeStatusSnapshot({
      promotionGate: {
        pass: true,
        blockingReasons: [],
      },
      paperGate: {
        allowPaperTrading: true,
        blockingReasons: [],
      },
      executionPlan:
        executionPlan.kind === "blocked"
          ? executionPlan
          : {
              kind: executionPlan.kind,
              flatReasons:
                executionPlan.kind === "flat" ? executionPlan.flatReasons : undefined,
              portfolioTarget: executionPlan.portfolioTarget,
              rebalancePlan: executionPlan.rebalancePlan,
              walletOperations: executionPlan.walletOperations,
              currentPositions,
              pricesBySymbol,
            },
      planningState: {
        regimeSeverity: "stable",
        regimeReason: null,
        capitalRampStage: "5%",
        releaseGateStatus: null,
        releaseGateBlocked: false,
        releaseGateBlockedReason: null,
        releaseGateAllowsPaperTrading: true,
        releaseGateAllowsLiveTrading: true,
      },
      releaseGateStatus: {
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
    });

    expect(snapshot.phaseReadiness.paper).toMatchObject({
      status: "active_ready",
      ready: true,
      hasNonFlatTarget: true,
    });
    expect(snapshot.phaseReadiness.liveTinyCapital).toMatchObject({
      status: "proof_start_ready",
      proofStarted: false,
      capitalMode: "tiny_cap_only",
    });
    expect(snapshot.phaseReadiness.proofTracking).toMatchObject({
      status: "not_started",
      readyToStart: true,
      started: false,
      elapsedDays: 0,
      remainingDays: 90,
    });
  });

  it("writes runtime status artifacts with sidecar evidence manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-status-snapshot-manifest-"));
    const snapshot = buildRuntimeStatusSnapshot({
      promotionGate: {
        pass: false,
        blockingReasons: ["promotion_requires_go_verdict"],
      },
      paperGate: {
        allowPaperTrading: false,
        blockingReasons: ["paper_research_not_approved"],
      },
      executionPlan: {
        kind: "blocked",
        blockingReasons: ["release_gate_not_approved"],
      },
      now: new Date("2026-05-03T00:00:00.000Z"),
    });

    await writeRuntimeStatusSnapshot(snapshot, { baseDir: root });

    const paths = buildRuntimeStatusSnapshotPaths(root);
    for (const path of [
      paths.paperPromotionStatus,
      paths.paperGateStatus,
      paths.paperExecutorStatus,
      paths.runtimeFaithfulSimulation,
      paths.phaseReadiness,
    ]) {
      const manifest = JSON.parse(await readFile(`${path}.manifest.json`, "utf-8"));
      expect(manifest).toMatchObject({
        artifactPath: path,
        exitCode: 0,
        evidenceTrust: expect.stringMatching(/^(pass|quarantine)$/),
      });
      expect(typeof manifest.artifactHash).toBe("string");
    }
  });

  it("marks paper as flat-only and blocks proof start when the portfolio target is flat", () => {
    const flatTarget = buildPortfolioTargetFromWeights({
      basisEquityUsd: 1_000,
      weights: {
        "BTC/USD": 0,
        "ETH/USD": 0,
      },
      maxTurnoverPct: 1,
    });
    const executionPlan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: true,
      paperGateMode: "active",
      paperGateAllowsExecution: true,
      championRegistryState: "valid",
      championSetComplete: true,
      regimeSeverity: "stable",
      portfolioTarget: flatTarget,
      currentPositions,
      pricesBySymbol,
    });

    expect(executionPlan.kind).toBe("active");
    const snapshot = buildRuntimeStatusSnapshot({
      promotionGate: {
        pass: true,
        blockingReasons: [],
      },
      paperGate: {
        allowPaperTrading: true,
        blockingReasons: [],
      },
      executionPlan:
        executionPlan.kind === "blocked"
          ? executionPlan
          : {
              kind: executionPlan.kind,
              flatReasons:
                executionPlan.kind === "flat" ? executionPlan.flatReasons : undefined,
              portfolioTarget: executionPlan.portfolioTarget,
              rebalancePlan: executionPlan.rebalancePlan,
              walletOperations: executionPlan.walletOperations,
              currentPositions,
              pricesBySymbol,
            },
      planningState: {
        regimeSeverity: "stable",
        regimeReason: null,
        capitalRampStage: "5%",
        releaseGateStatus: null,
        releaseGateBlocked: false,
        releaseGateBlockedReason: null,
        releaseGateAllowsPaperTrading: true,
        releaseGateAllowsLiveTrading: true,
      },
      releaseGateStatus: {
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
    });

    expect(snapshot.phaseReadiness.paper).toMatchObject({
      status: "flat_only",
      ready: false,
      hasNonFlatTarget: false,
    });
    expect(snapshot.phaseReadiness.liveTinyCapital).toMatchObject({
      status: "blocked",
      ready: false,
      readyToStartProof: false,
      proofStarted: false,
    });
    expect(snapshot.phaseReadiness.proofTracking).toMatchObject({
      status: "blocked",
      readyToStart: false,
      started: false,
      blockingReasons: ["live_tiny_capital_not_ready"],
    });
  });

  it("writes all runtime snapshot files", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runtime-status-snapshot-"));
    const executionPlan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: true,
      paperGateMode: "active",
      paperGateAllowsExecution: true,
      championRegistryState: "valid",
      championSetComplete: true,
      regimeSeverity: "stable",
      portfolioTarget,
      currentPositions,
      pricesBySymbol,
    });
    const snapshot = buildRuntimeStatusSnapshot({
      promotionGate: { pass: true, blockingReasons: [] },
      paperGate: { allowPaperTrading: true, blockingReasons: [] },
      executionPlan:
        executionPlan.kind === "blocked"
          ? executionPlan
          : {
              kind: executionPlan.kind,
              flatReasons:
                executionPlan.kind === "flat" ? executionPlan.flatReasons : undefined,
              portfolioTarget: executionPlan.portfolioTarget,
              rebalancePlan: executionPlan.rebalancePlan,
              walletOperations: executionPlan.walletOperations,
              currentPositions,
              pricesBySymbol,
            },
      snapshotBaseDir: tempDir,
    });

    await writeRuntimeStatusSnapshot(snapshot, { baseDir: tempDir });

    const snapshotPaths = buildRuntimeStatusSnapshotPaths(tempDir);
    const promotion = JSON.parse(
      await readFile(snapshotPaths.paperPromotionStatus, "utf-8"),
    ) as { canPromote: boolean };
    const paperGate = JSON.parse(
      await readFile(snapshotPaths.paperGateStatus, "utf-8"),
    ) as { finalAllowPaperTrading: boolean };
    const executor = JSON.parse(
      await readFile(snapshotPaths.paperExecutorStatus, "utf-8"),
    ) as {
      paperGateStatusPath: string;
      simulationOutput: string;
      summary: { paperGate: string; walletOperationCount: number };
    };
    const simulation = JSON.parse(
      await readFile(snapshotPaths.runtimeFaithfulSimulation, "utf-8"),
    ) as { summary: { skippedByPaperGate: boolean; targetSymbolCount: number } };
    const readiness = JSON.parse(
      await readFile(snapshotPaths.phaseReadiness, "utf-8"),
    ) as { research: { status: string }; paper: { status: string } };

    expect(promotion.canPromote).toBe(true);
    expect(paperGate.finalAllowPaperTrading).toBe(true);
    expect(executor.paperGateStatusPath).toBe(snapshotPaths.paperGateStatus);
    expect(executor.simulationOutput).toBe(snapshotPaths.runtimeFaithfulSimulation);
    expect(executor.summary.paperGate).toBe("PASS");
    expect(executor.summary.walletOperationCount).toBe(3);
    expect(simulation.summary.skippedByPaperGate).toBe(false);
    expect(simulation.summary.targetSymbolCount).toBe(2);
    expect(readiness.research.status).toBe("ready");
    expect(readiness.paper.status).toBe("active_ready");
  });
});
