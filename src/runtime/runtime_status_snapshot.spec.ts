import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CryptoPosition } from "../extension/crypto-trading/interfaces.js";
import { buildPortfolioTargetFromWeights } from "../portfolio/target.js";
import { buildPaperExecutionPlan } from "./paper_execution_plan.js";
import {
  buildRuntimeStatusSnapshot,
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
      championRegistryState: "valid",
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
        executionPlan.kind === "active"
          ? {
              ...executionPlan,
              currentPositions,
              pricesBySymbol,
            }
          : executionPlan,
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

  it("writes all runtime snapshot files", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runtime-status-snapshot-"));
    const executionPlan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: true,
      championRegistryState: "valid",
      regimeSeverity: "stable",
      portfolioTarget,
      currentPositions,
      pricesBySymbol,
    });
    const snapshot = buildRuntimeStatusSnapshot({
      promotionGate: { pass: true, blockingReasons: [] },
      paperGate: { allowPaperTrading: true, blockingReasons: [] },
      executionPlan:
        executionPlan.kind === "active"
          ? {
              ...executionPlan,
              currentPositions,
              pricesBySymbol,
            }
          : executionPlan,
    });

    await writeRuntimeStatusSnapshot(snapshot, { baseDir: tempDir });

    const promotion = JSON.parse(
      await readFile(join(tempDir, "paper_promotion_status.latest.json"), "utf-8"),
    ) as { canPromote: boolean };
    const paperGate = JSON.parse(
      await readFile(join(tempDir, "paper_gate_status.json"), "utf-8"),
    ) as { finalAllowPaperTrading: boolean };
    const executor = JSON.parse(
      await readFile(join(tempDir, "paper_executor_status.latest.json"), "utf-8"),
    ) as { summary: { paperGate: string; walletOperationCount: number } };
    const simulation = JSON.parse(
      await readFile(
        join(tempDir, "runtime_faithful_simulation.latest.json"),
        "utf-8",
      ),
    ) as { summary: { skippedByPaperGate: boolean; targetSymbolCount: number } };
    const readiness = JSON.parse(
      await readFile(join(tempDir, "phase_readiness.latest.json"), "utf-8"),
    ) as { research: { status: string }; paper: { status: string } };

    expect(promotion.canPromote).toBe(true);
    expect(paperGate.finalAllowPaperTrading).toBe(true);
    expect(executor.summary.paperGate).toBe("PASS");
    expect(executor.summary.walletOperationCount).toBe(3);
    expect(simulation.summary.skippedByPaperGate).toBe(false);
    expect(simulation.summary.targetSymbolCount).toBe(2);
    expect(readiness.research.status).toBe("ready");
    expect(readiness.paper.status).toBe("active_ready");
  });
});
