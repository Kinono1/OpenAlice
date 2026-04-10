import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CryptoPosition } from "../extension/crypto-trading/interfaces.js";
import type { PortfolioRebalanceEntry, PortfolioRebalancePlan } from "../portfolio/rebalance.js";
import type { PortfolioTarget } from "../portfolio/target.js";
import type { RuntimePlanningState } from "./live_gate_manager.js";

interface RuntimeStatusExecutionPlanInput {
  kind: "blocked" | "active";
  blockingReasons?: string[];
  portfolioTarget?: PortfolioTarget;
  rebalancePlan?: PortfolioRebalancePlan;
  walletOperations?: Array<Record<string, unknown>>;
  currentPositions?: CryptoPosition[];
  pricesBySymbol?: Record<string, number>;
}

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
    ...(input.executionPlan.blockingReasons ?? []),
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

  const paperGateStatus: Record<string, unknown> = {
    version: 1,
    generatedAt,
    researchApproved: input.promotionGate.pass,
    runtimeHealthy: true,
    dataFresh: true,
    dataQualityValid: true,
    connectorHealthy: true,
    riskLimitsLoaded: true,
    championLoaded: input.executionPlan.kind === "active",
    policyVersionMatch: input.executionPlan.kind === "active",
    paperExecutorEnabled: true,
    finalAllowPaperTrading: input.paperGate.allowPaperTrading,
    blockingReasons: [...input.paperGate.blockingReasons],
    warnings: [...(input.paperGate.warnings ?? [])],
    promotionDiagnostics,
    readiness: phaseReadiness.paper,
  };

  const paperExecutorStatus: Record<string, unknown> = {
    generatedAt,
    mode: "executor",
    paperGateStatusPath:
      input.releaseGateStatusPath ?? "data/runtime/paper_gate_status.json",
    journalPath: "data/runtime/paper_executor_journal.json",
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
      rebalanceEntryCount: input.executionPlan.rebalancePlan?.entries.length ?? 0,
      walletOperationCount: walletOperations.length,
      executor: {
        executed: input.executionPlan.kind === "active" ? 1 : 0,
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
      input.executionPlan.portfolioTarget || input.executionPlan.rebalancePlan
        ? "portfolio_rebalance"
        : "unknown",
    strategyRuntime:
      input.executionPlan.kind === "active"
        ? {
            executionPlanKind: input.executionPlan.kind,
            targetSymbols,
            portfolioPlan,
            walletOperations,
          }
        : null,
    championValidation: {
      championLoaded: input.executionPlan.kind === "active",
      policyVersionMatch: input.executionPlan.kind === "active",
      checksumValid: input.executionPlan.kind === "active",
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
    finalPositions: buildFinalPositions(input.executionPlan.rebalancePlan),
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
      rebalanceEntryCount: input.executionPlan.rebalancePlan?.entries.length ?? 0,
      currentPositionCount: input.executionPlan.currentPositions?.length ?? 0,
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
  const baseDir = opts?.baseDir ?? "data/runtime";
  await mkdir(baseDir, { recursive: true });
  await Promise.all([
    writeJson(
      join(baseDir, "paper_promotion_status.latest.json"),
      snapshot.paperPromotionStatus,
    ),
    writeJson(join(baseDir, "paper_gate_status.json"), snapshot.paperGateStatus),
    writeJson(
      join(baseDir, "paper_executor_status.latest.json"),
      snapshot.paperExecutorStatus,
    ),
    writeJson(
      join(baseDir, "runtime_faithful_simulation.latest.json"),
      snapshot.runtimeFaithfulSimulation,
    ),
    writeJson(
      join(baseDir, "phase_readiness.latest.json"),
      snapshot.phaseReadiness as unknown as Record<string, unknown>,
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
      : input.executionPlan.kind !== "active"
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
    warnings: [...(input.paperGate.warnings ?? [])],
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
  const capitalMode = resolveCapitalMode(
    input.planningState?.capitalRampStage ?? null,
  );
  const liveTinyCapitalStatus =
    liveBlockingReasons.length > 0
      ? "blocked"
      : capitalMode === "normal_cap"
        ? "normal_cap_ready"
        : "tiny_cap_ready";
  const liveTinyCapital = {
    status: liveTinyCapitalStatus,
    ready:
      liveTinyCapitalStatus === "tiny_cap_ready" ||
      liveTinyCapitalStatus === "normal_cap_ready",
    capitalMode,
    capitalRampStage: input.planningState?.capitalRampStage ?? null,
    regimeSeverity: input.planningState?.regimeSeverity ?? null,
    releaseGateAllowsPaperTrading: liveReleaseAllowsPaper,
    releaseGateAllowsLiveTrading: liveReleaseAllowsLive,
    blockingReasons: unique(liveBlockingReasons),
    generatedAt: input.generatedAt,
  };

  const targetDays = Math.max(1, input.proofTracking?.targetDays ?? 90);
  const elapsedDays = Math.max(0, input.proofTracking?.elapsedDays ?? 0);
  const proofBlockingReasons = [
    ...(input.proofTracking?.blockingReasons ?? []),
  ];
  let proofStatus: "blocked" | "not_started" | "tracking" | "passed" | "failed";
  if (!liveTinyCapital.ready) {
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
  const proofTracking = {
    status: proofStatus,
    readyToStart: liveTinyCapital.ready,
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
  if (!executionPlan.portfolioTarget) {
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

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
