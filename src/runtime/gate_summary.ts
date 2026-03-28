import type { ExecutePaperExecutorCycleResult } from "./paper_demo_executor.js";
import type { RuntimeFaithfulSimulationArtifact } from "./runtime_faithful_simulation.js";

export type GateSummaryStatus = "PASS" | "BLOCKED";

export interface GateSummary {
  releaseGate: GateSummaryStatus;
  releaseGateReason?: string;
  paperGate: GateSummaryStatus;
  paperGateReasons: string[];
  dataContractBySymbol: Record<string, GateSummaryStatus>;
  executionSemantics: {
    validated: number;
    stale: number;
    rejected: number;
  };
  simulation: {
    commits: number;
    operations: number;
    skipped: Record<string, number>;
  };
  executor?: {
    executed: number;
    skipped: number;
    blocked: number;
    executedOpenCommits: number;
    portfolioTargetsProduced: number;
    executionCostBps: number | null;
  };
  blockingReasons: string[];
  generatedAt: string;
}

export function buildGateSummary(
  artifact: RuntimeFaithfulSimulationArtifact,
  executorResult?: ExecutePaperExecutorCycleResult,
): GateSummary {
  return {
    releaseGate: artifact.paperGate.researchApproved ? "PASS" : "BLOCKED",
    releaseGateReason: artifact.paperGate.researchApproved
      ? undefined
      : artifact.paperGate.blockingReasons.find(
          (reason) => reason === "paper_research_not_approved",
        ) ?? "paper_research_not_approved",
    paperGate: artifact.paperGate.finalAllowPaperTrading ? "PASS" : "BLOCKED",
    paperGateReasons: [...artifact.paperGate.blockingReasons],
    dataContractBySymbol: Object.fromEntries(
      Object.entries(artifact.dataContractBySymbol).map(([symbol, result]) => [
        symbol,
        result.dataQualityValid ? "PASS" : "BLOCKED",
      ]),
    ),
    executionSemantics: {
      validated: artifact.summary.operationCount,
      stale: artifact.summary.staleIntentCount,
      rejected: 0,
    },
    simulation: {
      commits: artifact.summary.commitCount,
      operations: artifact.summary.operationCount,
      skipped: {
        paperGate: artifact.summary.skippedByPaperGate ? 1 : 0,
        eventBlock: artifact.summary.skippedByEventBlock,
        veto: artifact.summary.skippedByVeto,
        correlation: artifact.summary.skippedByCorrelation,
        staleIntent: artifact.summary.staleIntentCount,
      },
    },
    executor: executorResult
      ? (() => {
          const executedCommitIds = new Set(
            executorResult.executedCommits.map(
              (entry) => entry.simulationCommitId,
            ),
          );
          const portfolioTargetsProduced = executorResult.portfolioTargets.filter(
            (entry) => executedCommitIds.has(entry.simulationCommitId),
          ).length;
          const executionCostBps =
            executorResult.executionCostReport?.layers.find(
              (layer) => layer.layer === "paper",
            )?.totalCostBps ?? null;
          return {
            executed: executorResult.executedCommits.length,
            skipped: executorResult.skippedCommitIds.length,
            blocked: executorResult.blockingReasons.length > 0 ? 1 : 0,
            executedOpenCommits: portfolioTargetsProduced,
            portfolioTargetsProduced,
            executionCostBps,
          };
        })()
      : undefined,
    blockingReasons: [...artifact.blockingReasons],
    generatedAt: artifact.generatedAt,
  };
}

export function formatGateSummary(summary: GateSummary): string {
  const lines = [
    "=== Gate Summary ===",
    `releaseGate:        ${summary.releaseGate}${summary.releaseGateReason ? ` (${summary.releaseGateReason})` : ""}`,
    `paperGate:          ${summary.paperGate}${summary.paperGateReasons.length > 0 ? ` (${summary.paperGateReasons.join(", ")})` : ""}`,
    `dataContract:       ${formatDataContracts(summary.dataContractBySymbol)}`,
    `executionSemantics: validated=${summary.executionSemantics.validated} stale=${summary.executionSemantics.stale} rejected=${summary.executionSemantics.rejected}`,
    `simulation:         commits=${summary.simulation.commits} operations=${summary.simulation.operations} skipped=${formatSkipped(summary.simulation.skipped)}`,
  ];

  if (summary.executor) {
    lines.push(
      `executor:           executed=${summary.executor.executed} skipped=${summary.executor.skipped} blocked=${summary.executor.blocked} opens=${summary.executor.executedOpenCommits} targets=${summary.executor.portfolioTargetsProduced} costBps=${summary.executor.executionCostBps ?? "n/a"}`,
    );
  }

  lines.push(
    `blockingReasons:    ${summary.blockingReasons.length > 0 ? summary.blockingReasons.join(", ") : "none"}`,
  );
  return lines.join("\n");
}

function formatDataContracts(
  dataContractBySymbol: Record<string, GateSummaryStatus>,
): string {
  const entries = Object.entries(dataContractBySymbol);
  if (entries.length === 0) {
    return "none";
  }
  return entries.map(([symbol, status]) => `${symbol}=${status}`).join(", ");
}

function formatSkipped(skipped: Record<string, number>): string {
  return Object.entries(skipped)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}
