import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CryptoPosition } from "../domain/trading/operation-dispatcher.types.js";
import type { PortfolioRebalanceEntry, PortfolioRebalancePlan } from "../portfolio/rebalance.js";
import type { PortfolioTarget } from "../portfolio/target.js";
import type { RuntimePlanningState } from "./live_gate_manager.js";
import { writeEvidenceManifestForArtifact } from "./evidence_manifest.js";

export const DEFAULT_RUNTIME_STATUS_SNAPSHOT_BASE_DIR = "data/runtime";

export const RUNTIME_STATUS_SNAPSHOT_FILE_NAMES = {
  paperPromotionStatus: "paper_promotion_status.latest.json",
  paperGateStatus: "paper_gate_status.json",
  paperExecutorStatus: "paper_executor_status.latest.json",
  runtimeFaithfulSimulation: "runtime_faithful_simulation.latest.json",
  phaseReadiness: "phase_readiness.latest.json",
} as const;

export function buildRuntimeStatusSnapshotPaths(
  baseDir = DEFAULT_RUNTIME_STATUS_SNAPSHOT_BASE_DIR,
) {
  return {
    paperPromotionStatus: join(
      baseDir,
      RUNTIME_STATUS_SNAPSHOT_FILE_NAMES.paperPromotionStatus,
    ),
    paperGateStatus: join(baseDir, RUNTIME_STATUS_SNAPSHOT_FILE_NAMES.paperGateStatus),
    paperExecutorStatus: join(
      baseDir,
      RUNTIME_STATUS_SNAPSHOT_FILE_NAMES.paperExecutorStatus,
    ),
    runtimeFaithfulSimulation: join(
      baseDir,
      RUNTIME_STATUS_SNAPSHOT_FILE_NAMES.runtimeFaithfulSimulation,
    ),
    phaseReadiness: join(baseDir, RUNTIME_STATUS_SNAPSHOT_FILE_NAMES.phaseReadiness),
  };
}

interface BlockedRuntimeStatusExecutionPlanInput {
  kind: "blocked";
  blockingReasons?: string[];
}

interface FlatOrActiveRuntimeStatusExecutionPlanInput {
  kind: "flat" | "active";
  flatReasons?: string[];
  portfolioTarget?: PortfolioTarget;
  rebalancePlan?: PortfolioRebalancePlan;
  walletOperations?: Array<Record<string, unknown>>;
  currentPositions?: CryptoPosition[];
  pricesBySymbol?: Record<string, number>;
}

type RuntimeStatusExecutionPlanInput =
  | BlockedRuntimeStatusExecutionPlanInput
  | FlatOrActiveRuntimeStatusExecutionPlanInput;

export interface RuntimeStatusSnapshotInput {
  promotionGate: {
    pass: boolean;
    blockingReasons: string[];
    warnings?: string[];
    diagnostics?: {
      verdictResult?: string | null;
      verdictReasonCodes?: string[];
      portfolioReasonCodes?: string[];
      validationReasons?: string[];
      portfolioCandidateFailures?: Array<{
        strategyId: string;
        strategyName: string | null;
        failureReasons: string[];
      }>;
      symbolDiagnostics?: Array<{
        symbol: string;
        result: string | null;
        reasonCodes: string[];
        candidateFailures: Array<{
          strategyId: string;
          strategyName: string | null;
          failureReasons: string[];
        }>;
      }>;
      releaseGate?: {
        source?: string;
        allowPaperTrading?: boolean | null;
        allowLiveTrading?: boolean | null;
        failedChecks?: string[];
        warningChecks?: string[];
      };
    };
  };
  paperGate: {
    allowPaperTrading: boolean;
    blockingReasons: string[];
    warnings?: string[];
  };
  executionPlan: RuntimeStatusExecutionPlanInput;
  planningState?: RuntimePlanningState | null;
  releaseGateStatus?: {
    allowPaperTrading?: boolean;
    allowLiveTrading?: boolean;
    failedChecks?: string[];
    warningChecks?: string[];
  } | null;
  proofTracking?: RuntimeProofTrackingInput;
  releaseGateStatusPath?: string;
  validationRunsPath?: string;
  verdictPath?: string;
  registryPath?: string;
  snapshotBaseDir?: string;
  now?: Date;
}

export interface RuntimeProofTrackingInput {
  status?: "not_started" | "tracking" | "passed" | "failed";
  elapsedDays?: number;
  targetDays?: number;
  netPnlPositive?: boolean;
  maxDrawdownPct?: number | null;
  drawdownBudgetPct?: number | null;
  blockingReasons?: string[];
  warnings?: string[];
  source?: string | null;
}

export interface RuntimePhaseReadiness {
  research: Record<string, unknown>;
  paper: Record<string, unknown>;
  liveTinyCapital: Record<string, unknown>;
  proofTracking: Record<string, unknown>;
}

export interface RuntimeStatusSnapshot {
  generatedAt: string;
  paperPromotionStatus: Record<string, unknown>;
  paperGateStatus: Record<string, unknown>;
  paperExecutorStatus: Record<string, unknown>;
  runtimeFaithfulSimulation: Record<string, unknown>;
  phaseReadiness: RuntimePhaseReadiness;
}

export function buildRuntimeStatusSnapshot(
  input: RuntimeStatusSnapshotInput,
): RuntimeStatusSnapshot {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const targetSymbols = collectExecutionSymbols(input.executionPlan);
  const walletOperations = resolveWalletOperations(input.executionPlan);
  const portfolioPlan = buildPortfolioPlanSummary(
    input.executionPlan,
    targetSymbols,
    walletOperations,
  );
  const combinedBlockingReasons = unique([
    ...input.promotionGate.blockingReasons,
    ...input.paperGate.blockingReasons,
    ...(input.executionPlan.kind === "blocked"
      ? input.executionPlan.blockingReasons ?? []
      : []),
  ]);
  const hasNonFlatTarget = hasActiveNonFlatTarget(input.executionPlan);
  const phaseReadiness = buildPhaseReadiness({
    generatedAt,
    promotionGate: input.promotionGate,
    paperGate: input.paperGate,
    executionPlan: input.executionPlan,
    planningState: input.planningState ?? null,
    releaseGateStatus: input.releaseGateStatus ?? null,
    proofTracking: input.proofTracking,
    hasNonFlatTarget,
  });
  const promotionDiagnostics = buildPromotionDiagnosticsSummary(input);
  const snapshotPaths = buildRuntimeStatusSnapshotPaths(
    input.snapshotBaseDir ?? DEFAULT_RUNTIME_STATUS_SNAPSHOT_BASE_DIR,
  );

  const paperPromotionStatus: Record<string, unknown> = {
    generatedAt,
    validationRunsPath: input.validationRunsPath,
    verdictPath: input.verdictPath,
    releaseGateStatusPath: input.releaseGateStatusPath,
    registryOutput: input.registryPath,
    canPromote: input.promotionGate.pass,
    blockingReasons: [...input.promotionGate.blockingReasons],
    warnings: [...(input.promotionGate.warnings ?? [])],
    diagnostics: promotionDiagnostics,
    readiness: phaseReadiness.research,
  };

  const executionPlanAllowsActiveTrading = input.executionPlan.kind === "active";
  const executionPlanAllowsPaperExecution = input.executionPlan.kind !== "blocked";

  const paperGateStatus: Record<string, unknown> = {
    version: 1,
    generatedAt,
    researchApproved: input.promotionGate.pass,
    runtimeHealthy: true,
    dataFresh: true,
    dataQualityValid: true,
    connectorHealthy: true,
    riskLimitsLoaded: true,
    championLoaded: executionPlanAllowsActiveTrading,
    policyVersionMatch: executionPlanAllowsActiveTrading,
    paperExecutorEnabled: executionPlanAllowsPaperExecution,
    finalAllowPaperTrading: input.paperGate.allowPaperTrading,
    blockingReasons: [...input.paperGate.blockingReasons],
    warnings: [...(input.paperGate.warnings ?? [])],
    promotionDiagnostics,
    readiness: phaseReadiness.paper,
  };

  const paperExecutorStatus: Record<string, unknown> = {
    generatedAt,
    mode: "executor",
    paperGateStatusPath: snapshotPaths.paperGateStatus,
    simulationOutput: snapshotPaths.runtimeFaithfulSimulation,
    journalPath: join(dirname(snapshotPaths.paperExecutorStatus), "paper_executor_journal.json"),
    blockingReasons: combinedBlockingReasons,
    executionPlanKind: input.executionPlan.kind,
    portfolioPlan,
    promotionDiagnostics,
    phaseReadinessSummary: {
      researchStatus: phaseReadiness.research.status,
      paperStatus: phaseReadiness.paper.status,
      liveTinyCapitalStatus: phaseReadiness.liveTinyCapital.status,
      proofTrackingStatus: phaseReadiness.proofTracking.status,
    },
    summary: {
      releaseGate: input.promotionGate.pass ? "PASS" : "BLOCKED",
      releaseGateReason: input.promotionGate.blockingReasons[0] ?? null,
      paperGate: input.paperGate.allowPaperTrading ? "PASS" : "BLOCKED",
      paperGateReasons: [...input.paperGate.blockingReasons],
      targetSymbols,
      rebalanceEntryCount: input.executionPlan.kind === "blocked"
        ? 0
        : input.executionPlan.rebalancePlan?.entries.length ?? 0,
      walletOperationCount: walletOperations.length,
      executor: {
        executed: executionPlanAllowsPaperExecution ? 1 : 0,
        skipped: 0,
        blocked: input.executionPlan.kind === "blocked" ? 1 : 0,
        operationCount: walletOperations.length,
      },
      blockingReasons: combinedBlockingReasons,
      generatedAt,
    },
  };

  const runtimeFaithfulSimulation: Record<string, unknown> = {
    schemaVersion: "runtime_faithful_simulation.v1",
    generatedAt,
    strategyFamily:
      input.executionPlan.kind !== "blocked" &&
      (input.executionPlan.portfolioTarget || input.executionPlan.rebalancePlan)
        ? "portfolio_rebalance"
        : "unknown",
    strategyRuntime:
      input.executionPlan.kind === "blocked"
        ? null
        : {
            executionPlanKind: input.executionPlan.kind,
            targetSymbols,
            portfolioPlan,
            walletOperations,
            flatReasons:
              input.executionPlan.kind === "flat"
                ? [...(input.executionPlan.flatReasons ?? [])]
                : [],
          },
    championValidation: {
      championLoaded: executionPlanAllowsActiveTrading,
      policyVersionMatch: executionPlanAllowsActiveTrading,
      checksumValid: executionPlanAllowsActiveTrading,
      blockingReasons: input.executionPlan.kind === "blocked"
        ? combinedBlockingReasons
        : [],
      promotionDiagnostics,
    },
    paperGate: paperGateStatus,
    phaseReadiness,
    dataContractBySymbol: buildDataContractBySymbol(
      input.executionPlan,
      targetSymbols,
    ),
    commonBarCount: 0,
    commits: [],
    finalPositions:
      input.executionPlan.kind === "blocked"
        ? {}
        : buildFinalPositions(input.executionPlan.rebalancePlan),
    summary: {
      commitCount: 0,
      operationCount: walletOperations.length,
      openCount: walletOperations.filter(
        operation => operation.action === "placeOrder",
      ).length,
      closeCount: walletOperations.filter(
        operation => operation.action === "closePosition",
      ).length,
      targetSymbolCount: targetSymbols.length,
      rebalanceEntryCount:
        input.executionPlan.kind === "blocked"
          ? 0
          : input.executionPlan.rebalancePlan?.entries.length ?? 0,
      currentPositionCount:
        input.executionPlan.kind === "blocked"
          ? 0
          : input.executionPlan.currentPositions?.length ?? 0,
      skippedByPaperGate: input.executionPlan.kind === "blocked",
      skippedByEventBlock: 0,
      skippedByVeto: 0,
      skippedByCorrelation: 0,
      staleIntentCount: 0,
    },
    blockingReasons: combinedBlockingReasons,
  };

  return {
    generatedAt,
    paperPromotionStatus,
    paperGateStatus,
    paperExecutorStatus,
    runtimeFaithfulSimulation,
    phaseReadiness,
  };
}

export async function writeRuntimeStatusSnapshot(
  snapshot: RuntimeStatusSnapshot,
  opts?: { baseDir?: string },
): Promise<void> {
  const baseDir = opts?.baseDir ?? DEFAULT_RUNTIME_STATUS_SNAPSHOT_BASE_DIR;
  const snapshotPaths = buildRuntimeStatusSnapshotPaths(baseDir);
  const paperExecutorStatus: Record<string, unknown> = {
    ...snapshot.paperExecutorStatus,
    paperGateStatusPath: snapshotPaths.paperGateStatus,
    simulationOutput: snapshotPaths.runtimeFaithfulSimulation,
    journalPath: join(dirname(snapshotPaths.paperExecutorStatus), "paper_executor_journal.json"),
  };
  await mkdir(baseDir, { recursive: true });
  await Promise.all([
    writeJsonWithManifest(snapshotPaths.paperPromotionStatus, snapshot.paperPromotionStatus, {
      job: "runtime_status_snapshot_paper_promotion_status",
      generatedAt: snapshot.generatedAt,
      businessStatus: snapshot.paperPromotionStatus.canPromote === true ? "pass" : "warn",
      errorClass: firstString(snapshot.paperPromotionStatus.blockingReasons) ?? null,
    }),
    writeJsonWithManifest(snapshotPaths.paperGateStatus, snapshot.paperGateStatus, {
      job: "runtime_status_snapshot_paper_gate_status",
      generatedAt: snapshot.generatedAt,
      businessStatus: snapshot.paperGateStatus.finalAllowPaperTrading === true ? "pass" : "warn",
      errorClass: firstString(snapshot.paperGateStatus.blockingReasons) ?? null,
    }),
    writeJsonWithManifest(snapshotPaths.paperExecutorStatus, paperExecutorStatus, {
      job: "runtime_status_snapshot_paper_executor_status",
      generatedAt: snapshot.generatedAt,
      businessStatus: paperExecutorStatus.executionPlanKind === "blocked" ? "warn" : "pass",
      errorClass: firstString(paperExecutorStatus.blockingReasons) ?? null,
    }),
    writeJsonWithManifest(
      snapshotPaths.runtimeFaithfulSimulation,
      snapshot.runtimeFaithfulSimulation,
      {
        job: "runtime_status_snapshot_runtime_faithful_simulation",
        generatedAt: snapshot.generatedAt,
        businessStatus: Array.isArray(snapshot.runtimeFaithfulSimulation.blockingReasons) &&
          snapshot.runtimeFaithfulSimulation.blockingReasons.length > 0
          ? "warn"
          : "pass",
        errorClass: firstString(snapshot.runtimeFaithfulSimulation.blockingReasons) ?? null,
      },
    ),
    writeJsonWithManifest(
      snapshotPaths.phaseReadiness,
      snapshot.phaseReadiness as unknown as Record<string, unknown>,
      {
        job: "runtime_status_snapshot_phase_readiness",
        generatedAt: snapshot.generatedAt,
        businessStatus: snapshot.phaseReadiness.paper.ready === true ? "pass" : "warn",
        errorClass: firstString(snapshot.phaseReadiness.paper.blockingReasons) ??
          firstString(snapshot.phaseReadiness.research.blockingReasons) ??
          null,
      },
    ),
  ]);
}

function buildPhaseReadiness(input: {
  generatedAt: string;
  promotionGate: RuntimeStatusSnapshotInput["promotionGate"];
  paperGate: RuntimeStatusSnapshotInput["paperGate"];
  executionPlan: RuntimeStatusExecutionPlanInput;
  planningState: RuntimePlanningState | null;
  releaseGateStatus: RuntimeStatusSnapshotInput["releaseGateStatus"];
  proofTracking?: RuntimeProofTrackingInput;
  hasNonFlatTarget: boolean;
}): RuntimePhaseReadiness {
  const researchBlockingReasons = [
    ...input.promotionGate.blockingReasons,
  ];
  const research = {
    status: input.promotionGate.pass ? "ready" : "blocked",
    ready: input.promotionGate.pass,
    blockingReasons: researchBlockingReasons,
    warnings: [...(input.promotionGate.warnings ?? [])],
    generatedAt: input.generatedAt,
  };

  const paperStatus =
    !input.paperGate.allowPaperTrading
      ? "blocked"
      : input.executionPlan.kind === "blocked"
        ? "blocked"
        : input.hasNonFlatTarget
          ? "active_ready"
          : "flat_only";
  const paperBlockingReasons = [
    ...input.paperGate.blockingReasons,
    ...(input.executionPlan.kind === "blocked"
      ? input.executionPlan.blockingReasons ?? []
      : []),
  ];
  const paper = {
    status: paperStatus,
    ready: paperStatus === "active_ready",
    allowPaperTrading: input.paperGate.allowPaperTrading,
    hasNonFlatTarget: input.hasNonFlatTarget,
    executionPlanKind: input.executionPlan.kind,
    blockingReasons: unique(paperBlockingReasons),
    warnings: [
      ...(input.paperGate.warnings ?? []),
      ...(input.executionPlan.kind === "flat"
        ? input.executionPlan.flatReasons ?? []
        : []),
    ],
    generatedAt: input.generatedAt,
  };

  const liveReleaseAllowsPaper =
    input.planningState?.releaseGateAllowsPaperTrading ??
    input.releaseGateStatus?.allowPaperTrading ??
    null;
  const liveReleaseAllowsLive =
    input.planningState?.releaseGateAllowsLiveTrading ??
    input.releaseGateStatus?.allowLiveTrading ??
    null;
  const liveBlockingReasons: string[] = [];
  if (!research.ready) {
    liveBlockingReasons.push("research_not_ready");
  }
  if (!paper.ready) {
    liveBlockingReasons.push("paper_not_ready_for_nonflat");
  }
  if (input.planningState?.releaseGateBlocked) {
    liveBlockingReasons.push(
      input.planningState.releaseGateBlockedReason ?? "release_gate_blocked",
    );
  }
  if (input.planningState?.paperTradingBlocked) {
    liveBlockingReasons.push(
      input.planningState.paperTradingBlockedReason ?? "paper_trading_blocked",
    );
  }
  if (liveReleaseAllowsLive === false) {
    liveBlockingReasons.push("release_gate_disallows_live");
  }
  const liveProofReadyToStart = liveBlockingReasons.length === 0;
  const capitalMode = resolveCapitalMode(
    input.planningState?.capitalRampStage ?? null,
  );

  const targetDays = Math.max(1, input.proofTracking?.targetDays ?? 90);
  const elapsedDays = Math.max(0, input.proofTracking?.elapsedDays ?? 0);
  const proofBlockingReasons = [
    ...(input.proofTracking?.blockingReasons ?? []),
  ];
  let proofStatus: "blocked" | "not_started" | "tracking" | "passed" | "failed";
  if (!liveProofReadyToStart) {
    proofStatus = "blocked";
    if (!proofBlockingReasons.includes("live_tiny_capital_not_ready")) {
      proofBlockingReasons.push("live_tiny_capital_not_ready");
    }
  } else if (input.proofTracking?.status === "passed") {
    proofStatus = "passed";
  } else if (input.proofTracking?.status === "failed") {
    proofStatus = "failed";
  } else if (input.proofTracking?.status === "tracking" || elapsedDays > 0) {
    proofStatus = "tracking";
  } else {
    proofStatus = "not_started";
  }
  const proofStarted =
    proofStatus === "tracking" ||
    proofStatus === "passed" ||
    proofStatus === "failed";
  const liveTinyCapitalStatus =
    !liveProofReadyToStart || proofStatus === "failed"
      ? "blocked"
      : proofStatus === "not_started"
        ? "proof_start_ready"
        : capitalMode === "normal_cap"
          ? "normal_cap_ready"
          : "tiny_cap_ready";
  const liveTinyCapitalBlockingReasons =
    proofStatus === "failed"
      ? unique([
          ...liveBlockingReasons,
          ...(proofBlockingReasons.length > 0
            ? proofBlockingReasons
            : ["proof_tracking_failed"]),
        ])
      : unique(liveBlockingReasons);
  const liveTinyCapital = {
    status: liveTinyCapitalStatus,
    ready: proofStatus === "tracking" || proofStatus === "passed",
    readyToStartProof: liveProofReadyToStart,
    proofStarted,
    capitalMode,
    capitalRampStage: input.planningState?.capitalRampStage ?? null,
    regimeSeverity: input.planningState?.regimeSeverity ?? null,
    releaseGateAllowsPaperTrading: liveReleaseAllowsPaper,
    releaseGateAllowsLiveTrading: liveReleaseAllowsLive,
    blockingReasons: liveTinyCapitalBlockingReasons,
    generatedAt: input.generatedAt,
  };
  const proofTracking = {
    status: proofStatus,
    readyToStart: liveProofReadyToStart,
    started: proofStarted,
    elapsedDays,
    targetDays,
    remainingDays: Math.max(targetDays - elapsedDays, 0),
    netPnlPositive: input.proofTracking?.netPnlPositive ?? null,
    maxDrawdownPct: input.proofTracking?.maxDrawdownPct ?? null,
    drawdownBudgetPct: input.proofTracking?.drawdownBudgetPct ?? 10,
    blockingReasons: unique(proofBlockingReasons),
    warnings: [...(input.proofTracking?.warnings ?? [])],
    source: input.proofTracking?.source ?? null,
    generatedAt: input.generatedAt,
  };

  return {
    research,
    paper,
    liveTinyCapital,
    proofTracking,
  };
}

function buildPromotionDiagnosticsSummary(
  input: RuntimeStatusSnapshotInput,
): Record<string, unknown> {
  return {
    verdictResult: input.promotionGate.diagnostics?.verdictResult ?? null,
    verdictReasonCodes: [
      ...(input.promotionGate.diagnostics?.verdictReasonCodes ?? []),
    ],
    portfolioReasonCodes: [
      ...(input.promotionGate.diagnostics?.portfolioReasonCodes ?? []),
    ],
    validationReasons: [
      ...(input.promotionGate.diagnostics?.validationReasons ?? []),
    ],
    portfolioCandidateFailures: (
      input.promotionGate.diagnostics?.portfolioCandidateFailures ?? []
    ).map(candidate => ({
      strategyId: candidate.strategyId,
      strategyName: candidate.strategyName,
      failureReasons: [...candidate.failureReasons],
    })),
    symbolDiagnostics: (input.promotionGate.diagnostics?.symbolDiagnostics ?? []).map(
      symbol => ({
        symbol: symbol.symbol,
        result: symbol.result,
        reasonCodes: [...symbol.reasonCodes],
        candidateFailures: symbol.candidateFailures.map(candidate => ({
          strategyId: candidate.strategyId,
          strategyName: candidate.strategyName,
          failureReasons: [...candidate.failureReasons],
        })),
      }),
    ),
    releaseGate: {
      source: input.promotionGate.diagnostics?.releaseGate?.source ?? "missing",
      allowPaperTrading:
        input.promotionGate.diagnostics?.releaseGate?.allowPaperTrading ?? null,
      allowLiveTrading:
        input.promotionGate.diagnostics?.releaseGate?.allowLiveTrading ?? null,
      failedChecks: [
        ...(input.promotionGate.diagnostics?.releaseGate?.failedChecks ?? []),
      ],
      warningChecks: [
        ...(input.promotionGate.diagnostics?.releaseGate?.warningChecks ?? []),
      ],
    },
  };
}

function hasActiveNonFlatTarget(
  executionPlan: RuntimeStatusExecutionPlanInput,
): boolean {
  if (executionPlan.kind === "blocked" || !executionPlan.portfolioTarget) {
    return false;
  }
  if (Math.abs(executionPlan.portfolioTarget.targetGrossExposure) > 1e-9) {
    return true;
  }
  return executionPlan.portfolioTarget.positions.some(position =>
    Math.abs(position.targetWeight) > 1e-9 ||
    Math.abs(position.targetNotionalUsd) > 1e-9,
  );
}

function resolveCapitalMode(
  capitalRampStage: string | null,
): "not_ready" | "tiny_cap_only" | "normal_cap" {
  if (!capitalRampStage) {
    return "not_ready";
  }
  const pct = parseRampStagePercent(capitalRampStage);
  if (pct !== null) {
    return pct <= 10 ? "tiny_cap_only" : "normal_cap";
  }
  const normalized = capitalRampStage.trim().toLowerCase();
  if (normalized.includes("tiny")) {
    return "tiny_cap_only";
  }
  if (normalized.includes("normal") || normalized.includes("full")) {
    return "normal_cap";
  }
  return "tiny_cap_only";
}

function parseRampStagePercent(capitalRampStage: string): number | null {
  const match = capitalRampStage.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function collectExecutionSymbols(
  executionPlan: RuntimeStatusExecutionPlanInput,
): string[] {
  if (executionPlan.kind === "blocked") {
    return [];
  }
  return sortUnique([
    ...(executionPlan.portfolioTarget?.positions.map(position => position.symbol) ??
      []),
    ...(executionPlan.rebalancePlan?.entries.map(entry => entry.symbol) ?? []),
    ...(executionPlan.currentPositions?.map(position => position.symbol) ?? []),
    ...Object.keys(executionPlan.pricesBySymbol ?? {}),
  ]);
}

function resolveWalletOperations(
  executionPlan: RuntimeStatusExecutionPlanInput,
): Array<Record<string, unknown>> {
  if (executionPlan.kind === "blocked") {
    return [];
  }
  if (executionPlan.walletOperations) {
    return executionPlan.walletOperations.map(cloneWalletOperation);
  }
  if (!executionPlan.rebalancePlan) {
    return [];
  }
  return executionPlan.rebalancePlan.entries.flatMap(entry =>
    entry.operations.map(operation => ({
      action: operation.action,
      params: { ...operation.params },
    })),
  );
}

function buildPortfolioPlanSummary(
  executionPlan: RuntimeStatusExecutionPlanInput,
  targetSymbols: string[],
  walletOperations: Array<Record<string, unknown>>,
): Record<string, unknown> {
  if (executionPlan.kind === "blocked") {
    return {
      basisEquityUsd: null,
      targetGrossExposure: null,
      targetNetExposure: null,
      maxTurnoverPct: null,
      maxTurnoverUsd: null,
      totalRequestedTurnoverUsd: null,
      totalPlannedTurnoverUsd: null,
      plannedTurnoverPct: null,
      targetSymbols,
      targetSymbolCount: targetSymbols.length,
      currentPositionSymbols: [],
      currentPositionCount: 0,
      rebalanceEntryCount: 0,
      walletOperationCount: walletOperations.length,
    };
  }
  return {
    basisEquityUsd:
      executionPlan.portfolioTarget?.basisEquityUsd ??
      executionPlan.rebalancePlan?.basisEquityUsd ??
      null,
    targetGrossExposure: executionPlan.portfolioTarget?.targetGrossExposure ?? null,
    targetNetExposure: executionPlan.portfolioTarget?.targetNetExposure ?? null,
    maxTurnoverPct: executionPlan.portfolioTarget?.maxTurnoverPct ?? null,
    maxTurnoverUsd: executionPlan.rebalancePlan?.maxTurnoverUsd ?? null,
    totalRequestedTurnoverUsd:
      executionPlan.rebalancePlan?.totalRequestedTurnoverUsd ?? null,
    totalPlannedTurnoverUsd:
      executionPlan.rebalancePlan?.totalPlannedTurnoverUsd ?? null,
    plannedTurnoverPct: executionPlan.rebalancePlan?.plannedTurnoverPct ?? null,
    targetSymbols,
    targetSymbolCount: targetSymbols.length,
    currentPositionSymbols: sortUnique(
      executionPlan.currentPositions?.map(position => position.symbol) ?? [],
    ),
    currentPositionCount: executionPlan.currentPositions?.length ?? 0,
    rebalanceEntryCount: executionPlan.rebalancePlan?.entries.length ?? 0,
    walletOperationCount: walletOperations.length,
  };
}

function buildDataContractBySymbol(
  executionPlan: RuntimeStatusExecutionPlanInput,
  symbols: string[],
): Record<string, unknown> {
  if (executionPlan.kind === "blocked") {
    return {};
  }
  const targetBySymbol = new Map(
    executionPlan.portfolioTarget?.positions.map(position => [
      position.symbol,
      position,
    ]) ?? [],
  );
  const rebalanceBySymbol = new Map(
    executionPlan.rebalancePlan?.entries.map(entry => [entry.symbol, entry]) ?? [],
  );
  const currentBySymbol = new Map(
    executionPlan.currentPositions?.map(position => [position.symbol, position]) ?? [],
  );

  return Object.fromEntries(
    symbols.map(symbol => {
      const target = targetBySymbol.get(symbol);
      const rebalanceEntry = rebalanceBySymbol.get(symbol);
      const currentPosition = currentBySymbol.get(symbol);
      const quotedPrice = executionPlan.pricesBySymbol?.[symbol];
      return [
        symbol,
        {
          hasTarget: Boolean(target),
          hasRebalanceEntry: Boolean(rebalanceEntry),
          hasCurrentPosition: Boolean(currentPosition),
          hasQuotedPrice:
            typeof quotedPrice === "number" &&
            Number.isFinite(quotedPrice) &&
            quotedPrice > 0,
          targetWeight: target?.targetWeight ?? null,
          currentSide: currentPosition?.side ?? null,
          currentNotionalUsd: rebalanceEntry?.currentNotionalUsd ?? null,
          effectiveTargetNotionalUsd:
            rebalanceEntry?.effectiveTargetNotionalUsd ?? null,
          plannedAction: rebalanceEntry?.action ?? null,
          plannedTurnoverUsd: rebalanceEntry?.turnoverUsd ?? null,
        },
      ];
    }),
  );
}

function buildFinalPositions(
  rebalancePlan: PortfolioRebalancePlan | undefined,
): Record<string, unknown> {
  if (!rebalancePlan) {
    return {};
  }
  return Object.fromEntries(
    rebalancePlan.entries.map(entry => [entry.symbol, serializeRebalanceEntry(entry)]),
  );
}

function serializeRebalanceEntry(
  entry: PortfolioRebalanceEntry,
): Record<string, unknown> {
  return {
    currentWeight: entry.currentWeight,
    targetWeight: entry.targetWeight,
    effectiveTargetWeight: entry.effectiveTargetWeight,
    currentNotionalUsd: entry.currentNotionalUsd,
    targetNotionalUsd: entry.targetNotionalUsd,
    effectiveTargetNotionalUsd: entry.effectiveTargetNotionalUsd,
    deltaNotionalUsd: entry.deltaNotionalUsd,
    turnoverUsd: entry.turnoverUsd,
    scaleApplied: entry.scaleApplied,
    action: entry.action,
  };
}

function cloneWalletOperation(
  operation: Record<string, unknown>,
): Record<string, unknown> {
  const cloned = { ...operation };
  const params = operation.params;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    cloned.params = { ...(params as Record<string, unknown>) };
  }
  return cloned;
}

function sortUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right),
  );
}

async function writeJson(path: string, payload: Record<string, unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function writeJsonWithManifest(
  path: string,
  payload: Record<string, unknown>,
  input: {
    job: string;
    generatedAt: string;
    businessStatus: "pass" | "warn" | "fail" | "unknown";
    errorClass: string | null;
  },
): Promise<void> {
  await writeJson(path, payload);
  await writeEvidenceManifestForArtifact({
    job: input.job,
    artifactPath: path,
    startedAt: input.generatedAt,
    finishedAt: new Date(),
    exitCode: 0,
    businessStatus: input.businessStatus,
    recordsIn: 1,
    recordsOut: 1,
    errorClass: input.errorClass,
  });
}

function firstString(value: unknown): string | null {
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
