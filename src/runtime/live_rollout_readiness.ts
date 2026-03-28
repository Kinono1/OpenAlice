import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  PaperChampionRegistry,
  PaperChampionRegistryValidation,
} from "./paper_champion_registry.js";
import type { PersistedReleaseGateStatus } from "./release_gate_status.js";

export const LIVE_ROLLOUT_READINESS_SCHEMA_VERSION =
  "live_rollout_readiness.v1";

export interface PaperExecutorStatusArtifact {
  generatedAt: string;
  mode: "executor";
  simulationOutput?: string;
  paperGateStatusPath?: string;
  journalPath?: string;
  blockingReasons: string[];
  summary?: {
    executor?: {
      executed: number;
      skipped: number;
      blocked: number;
      executedOpenCommits?: number;
      portfolioTargetsProduced?: number;
      executionCostBps?: number | null;
    };
  };
}

export interface LiveRolloutReadinessConfig {
  enabled: boolean;
  statusPath: string;
  maxExecutionCostBps: number;
  requireEdgeDecayStable: boolean;
  requirePromotedCandidateVerdict: boolean;
  requirePortfolioTargetsForExecutedOpens: boolean;
}

export interface LiveRolloutReadinessArtifact {
  schemaVersion: typeof LIVE_ROLLOUT_READINESS_SCHEMA_VERSION;
  generatedAt: string;
  readyForMicroLive: boolean;
  blockingReasons: string[];
  warnings: string[];
  evidence: {
    allowLiveTrading: boolean;
    championLoaded: boolean;
    checksumValid: boolean;
    policyVersionMatch: boolean;
    candidateId: string | null;
    candidateVerdict: "promote" | "watch" | "reject" | null;
    executionCostBps: number | null;
    edgeDecayStatus: string | null;
    executedOpenCommits: number;
    portfolioTargetsProduced: number;
    executorBlockingReasons: string[];
  };
  sourcePaths: {
    releaseGateStatusPath?: string;
    paperChampionRegistryPath?: string;
    paperExecutorStatusPath?: string;
  };
}

export interface EvaluateLiveRolloutReadinessInput {
  releaseGateStatus: PersistedReleaseGateStatus | null;
  registry: PaperChampionRegistry | null;
  registryValidation: PaperChampionRegistryValidation;
  paperExecutorStatus: PaperExecutorStatusArtifact | null;
  config: Omit<LiveRolloutReadinessConfig, "enabled" | "statusPath">;
  generatedAt?: string;
  sourcePaths?: LiveRolloutReadinessArtifact["sourcePaths"];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonNegativeInteger(value: unknown): number {
  if (!Number.isFinite(value) || typeof value !== "number" || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function evaluateLiveRolloutReadiness(
  input: EvaluateLiveRolloutReadinessInput,
): LiveRolloutReadinessArtifact {
  const blockingReasons: string[] = [];
  const warnings: string[] = [];
  const candidateVerdict = input.registry?.candidate_verdict ?? null;
  const executionCostBps =
    input.paperExecutorStatus?.summary?.executor?.executionCostBps ?? null;
  const executedOpenCommits = Math.max(
    0,
    input.paperExecutorStatus?.summary?.executor?.executedOpenCommits ?? 0,
  );
  const portfolioTargetsProduced = Math.max(
    0,
    input.paperExecutorStatus?.summary?.executor?.portfolioTargetsProduced ?? 0,
  );
  const edgeDecayStatus =
    typeof input.registry?.paper_gate_snapshot.edgeDecayStatus === "string"
      ? input.registry.paper_gate_snapshot.edgeDecayStatus
      : null;
  const executorBlockingReasons = input.paperExecutorStatus?.blockingReasons ?? [];

  if (input.releaseGateStatus?.allowLiveTrading !== true) {
    blockingReasons.push("rollout_release_gate_not_live_approved");
  }
  if (
    !input.registryValidation.championLoaded ||
    !input.registryValidation.checksumValid ||
    !input.registryValidation.policyVersionMatch
  ) {
    blockingReasons.push(...input.registryValidation.blockingReasons);
  }
  if (!input.paperExecutorStatus) {
    blockingReasons.push("rollout_paper_executor_status_missing");
  } else if (executorBlockingReasons.length > 0) {
    blockingReasons.push(
      ...executorBlockingReasons.map(
        (reason) => `rollout_executor_reason:${reason}`,
      ),
    );
  }
  if (executionCostBps == null) {
    blockingReasons.push("rollout_execution_cost_bps_missing");
  } else if (executionCostBps > input.config.maxExecutionCostBps) {
    blockingReasons.push("rollout_execution_cost_bps_above_max");
  }
  if (input.config.requireEdgeDecayStable) {
    if (edgeDecayStatus == null) {
      blockingReasons.push("rollout_edge_decay_status_missing");
    } else if (edgeDecayStatus !== "stable") {
      blockingReasons.push("rollout_edge_decay_not_stable");
    }
  }
  if (input.config.requirePromotedCandidateVerdict) {
    if (candidateVerdict == null) {
      warnings.push("rollout_candidate_verdict_missing");
    } else if (candidateVerdict !== "promote") {
      blockingReasons.push("rollout_candidate_verdict_not_promote");
    }
  }
  if (
    input.config.requirePortfolioTargetsForExecutedOpens &&
    executedOpenCommits > 0 &&
    portfolioTargetsProduced !== executedOpenCommits
  ) {
    blockingReasons.push("rollout_portfolio_target_incomplete");
  }

  return {
    schemaVersion: LIVE_ROLLOUT_READINESS_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    readyForMicroLive: blockingReasons.length === 0,
    blockingReasons: [...new Set(blockingReasons)],
    warnings: [...new Set(warnings)],
    evidence: {
      allowLiveTrading: input.releaseGateStatus?.allowLiveTrading === true,
      championLoaded: input.registryValidation.championLoaded,
      checksumValid: input.registryValidation.checksumValid,
      policyVersionMatch: input.registryValidation.policyVersionMatch,
      candidateId: input.registry?.candidate_id ?? null,
      candidateVerdict,
      executionCostBps,
      edgeDecayStatus,
      executedOpenCommits,
      portfolioTargetsProduced,
      executorBlockingReasons,
    },
    sourcePaths: input.sourcePaths ?? {},
  };
}

export async function writeLiveRolloutReadiness(
  artifact: LiveRolloutReadinessArtifact,
  filePath = "data/runtime/live_rollout_readiness.latest.json",
): Promise<LiveRolloutReadinessArtifact> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  return artifact;
}

export async function loadLiveRolloutReadiness(
  filePath = "data/runtime/live_rollout_readiness.latest.json",
): Promise<LiveRolloutReadinessArtifact | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return normalizeLiveRolloutReadiness(JSON.parse(raw));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

export async function loadPaperExecutorStatusArtifact(
  filePath: string,
): Promise<PaperExecutorStatusArtifact | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return normalizePaperExecutorStatusArtifact(JSON.parse(raw));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

export function normalizeLiveRolloutReadiness(
  raw: unknown,
): LiveRolloutReadinessArtifact {
  if (!isObject(raw)) {
    throw new Error("Invalid live rollout readiness payload");
  }
  if (
    raw.schemaVersion !== LIVE_ROLLOUT_READINESS_SCHEMA_VERSION ||
    typeof raw.generatedAt !== "string" ||
    typeof raw.readyForMicroLive !== "boolean" ||
    !Array.isArray(raw.blockingReasons) ||
    !Array.isArray(raw.warnings) ||
    !isObject(raw.evidence) ||
    !isObject(raw.sourcePaths)
  ) {
    throw new Error("Malformed live rollout readiness payload");
  }

  return {
    schemaVersion: LIVE_ROLLOUT_READINESS_SCHEMA_VERSION,
    generatedAt: raw.generatedAt,
    readyForMicroLive: raw.readyForMicroLive,
    blockingReasons: raw.blockingReasons.filter(
      (item): item is string => typeof item === "string",
    ),
    warnings: raw.warnings.filter(
      (item): item is string => typeof item === "string",
    ),
    evidence: {
      allowLiveTrading: raw.evidence.allowLiveTrading === true,
      championLoaded: raw.evidence.championLoaded === true,
      checksumValid: raw.evidence.checksumValid === true,
      policyVersionMatch: raw.evidence.policyVersionMatch === true,
      candidateId:
        typeof raw.evidence.candidateId === "string"
          ? raw.evidence.candidateId
          : null,
      candidateVerdict:
        raw.evidence.candidateVerdict === "promote" ||
        raw.evidence.candidateVerdict === "watch" ||
        raw.evidence.candidateVerdict === "reject"
          ? raw.evidence.candidateVerdict
          : null,
      executionCostBps: asNullableNumber(raw.evidence.executionCostBps),
      edgeDecayStatus:
        typeof raw.evidence.edgeDecayStatus === "string"
          ? raw.evidence.edgeDecayStatus
          : null,
      executedOpenCommits: asNonNegativeInteger(
        raw.evidence.executedOpenCommits,
      ),
      portfolioTargetsProduced: asNonNegativeInteger(
        raw.evidence.portfolioTargetsProduced,
      ),
      executorBlockingReasons: Array.isArray(raw.evidence.executorBlockingReasons)
        ? raw.evidence.executorBlockingReasons.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    },
    sourcePaths: {
      releaseGateStatusPath:
        typeof raw.sourcePaths.releaseGateStatusPath === "string"
          ? raw.sourcePaths.releaseGateStatusPath
          : undefined,
      paperChampionRegistryPath:
        typeof raw.sourcePaths.paperChampionRegistryPath === "string"
          ? raw.sourcePaths.paperChampionRegistryPath
          : undefined,
      paperExecutorStatusPath:
        typeof raw.sourcePaths.paperExecutorStatusPath === "string"
          ? raw.sourcePaths.paperExecutorStatusPath
          : undefined,
    },
  };
}

export function normalizePaperExecutorStatusArtifact(
  raw: unknown,
): PaperExecutorStatusArtifact {
  if (!isObject(raw)) {
    throw new Error("Invalid paper executor status payload");
  }
  if (
    typeof raw.generatedAt !== "string" ||
    raw.mode !== "executor" ||
    !Array.isArray(raw.blockingReasons)
  ) {
    throw new Error("Malformed paper executor status payload");
  }

  const summary = isObject(raw.summary) ? raw.summary : undefined;
  const executor = summary && isObject(summary.executor) ? summary.executor : undefined;

  return {
    generatedAt: raw.generatedAt,
    mode: "executor",
    simulationOutput:
      typeof raw.simulationOutput === "string" ? raw.simulationOutput : undefined,
    paperGateStatusPath:
      typeof raw.paperGateStatusPath === "string"
        ? raw.paperGateStatusPath
        : undefined,
    journalPath: typeof raw.journalPath === "string" ? raw.journalPath : undefined,
    blockingReasons: raw.blockingReasons.filter(
      (item): item is string => typeof item === "string",
    ),
    summary: executor
      ? {
          executor: {
            executed: asNonNegativeInteger(executor.executed),
            skipped: asNonNegativeInteger(executor.skipped),
            blocked: asNonNegativeInteger(executor.blocked),
            executedOpenCommits: asNonNegativeInteger(
              executor.executedOpenCommits,
            ),
            portfolioTargetsProduced: asNonNegativeInteger(
              executor.portfolioTargetsProduced,
            ),
            executionCostBps: asNullableNumber(executor.executionCostBps),
          },
        }
      : undefined,
  };
}
