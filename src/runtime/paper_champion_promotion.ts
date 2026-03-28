import type { PersistedReleaseGateStatus } from "./release_gate_status.js";
import {
  classifyReleaseGateProvenance,
  isReleaseGateResearchOwned,
} from "./release_gate_status.js";
import type {
  PaperChampionRegistry,
  ResolvedMarketIdentity,
} from "./paper_champion_registry.js";
import type { PromotionMetadata } from "./paper_promotion_metadata.js";
import {
  RUNTIME_SCHEMA_VERSION,
  VETO_POLICY_VERSION,
} from "./paper_runtime_versions.js";
import type { ExecutionCostReportArtifact } from "./execution_cost_report.js";
import type { EdgeDecayReportArtifact } from "./edge_decay_report.js";

interface ValidationChampion {
  strategyId?: string;
  candidateId?: string;
  releaseGateAllowPaper?: boolean;
}

interface ValidationCandidate {
  strategyId?: string;
  candidateId?: string;
  strategyName?: string;
  strategy?: string;
  params?: Record<string, unknown>;
  backtestMetrics?: Record<string, unknown>;
  significance?: Record<string, unknown>;
  fdr?: Record<string, unknown>;
  hardGap?: Record<string, unknown>;
  wfoSummary?: Record<string, unknown>;
  wfoGatePassed?: boolean;
}

interface ValidationTournamentEntry {
  candidateId?: string;
  rank?: number;
  verdict?: "promote" | "watch" | "reject";
  family?: string;
  strategy?: string;
}

interface ValidationTournamentLeaderboard {
  winnerCandidateId?: string | null;
  entries?: ValidationTournamentEntry[];
}

interface ValidationRunsPayload {
  champion?: ValidationChampion;
  candidates?: ValidationCandidate[];
  tournamentLeaderboard?: ValidationTournamentLeaderboard;
  config?: Record<string, unknown>;
  promotionMetadataReady?: boolean;
  promotionMetadata?: PromotionMetadata | null;
  promotionMetadataBlockingReasons?: string[];
}

interface ExperimentVerdictPayload {
  result?: string;
  reasonCodes?: string[];
}

export interface PaperChampionPromotionInput {
  validationRuns: ValidationRunsPayload;
  validationRunsPath: string;
  verdict: ExperimentVerdictPayload;
  verdictPath: string;
  releaseGateStatus: PersistedReleaseGateStatus | null;
  releaseGateStatusPath: string;
  executionCostReport?: ExecutionCostReportArtifact | null;
  edgeDecayReport?: EdgeDecayReportArtifact | null;
  gitState: {
    head: string;
    isClean: boolean;
  };
  resolvedMarketIdentity: Record<string, ResolvedMarketIdentity>;
  symbols: string[];
  barInterval: string;
  now?: () => Date;
}

export interface PaperChampionPromotionResult {
  canPromote: boolean;
  blockingReasons: string[];
  releaseGateProvenance:
    ReturnType<typeof classifyReleaseGateProvenance>["classification"];
  registryPayload?: Omit<PaperChampionRegistry, "checksum">;
}

export function evaluatePaperChampionPromotion(
  input: PaperChampionPromotionInput,
): PaperChampionPromotionResult {
  const blockingReasons: string[] = [];
  const now = input.now ?? (() => new Date());
  const provenance = classifyReleaseGateProvenance(input.releaseGateStatus);

  if (input.verdict.result !== "GO") {
    blockingReasons.push("promotion_requires_go_verdict");
  }
  if (!input.gitState.isClean) {
    blockingReasons.push("promotion_git_dirty");
  }
  if (!input.releaseGateStatus) {
    blockingReasons.push("promotion_release_gate_missing");
  } else if (!input.releaseGateStatus.allowPaperTrading) {
    blockingReasons.push("promotion_release_gate_not_approved");
  }
  if (!isReleaseGateResearchOwned(input.releaseGateStatus).ok) {
    blockingReasons.push(
      provenance.reason ?? "promotion_release_gate_provenance_invalid",
    );
  }

  const promotionMetadata = input.validationRuns.promotionMetadata ?? null;
  const paperExecutionCostBps =
    input.executionCostReport?.layers.find((layer) => layer.layer === "paper")
      ?.totalCostBps ?? null;

  if (!input.validationRuns.promotionMetadataReady || !promotionMetadata) {
    blockingReasons.push("promotion_metadata_not_ready");
    blockingReasons.push(
      ...(input.validationRuns.promotionMetadataBlockingReasons ?? []),
    );
  }

  const champion = input.validationRuns.champion ?? {};
  if (champion.releaseGateAllowPaper !== true) {
    blockingReasons.push("promotion_champion_release_gate_not_approved");
  }

  const candidate = (input.validationRuns.candidates ?? []).find(
    (item) => item.strategyId === champion.strategyId,
  );
  if (!candidate) {
    blockingReasons.push("promotion_champion_candidate_missing");
  }

  const tournamentEntries = input.validationRuns.tournamentLeaderboard?.entries ?? [];
  const championCandidateId = champion.candidateId ?? candidate?.candidateId;
  if (championCandidateId && tournamentEntries.length > 0) {
    const tournamentEntry = tournamentEntries.find(
      (entry) => entry.candidateId === championCandidateId,
    );
    if (!tournamentEntry) {
      blockingReasons.push("promotion_tournament_candidate_missing");
    } else if (tournamentEntry.verdict !== "promote") {
      blockingReasons.push("promotion_tournament_verdict_not_promote");
    }
    if (
      input.validationRuns.tournamentLeaderboard?.winnerCandidateId &&
      input.validationRuns.tournamentLeaderboard.winnerCandidateId !== championCandidateId
    ) {
      blockingReasons.push("promotion_tournament_winner_mismatch");
    }
  }

  const mappedFamily = mapStrategyToRegistryFamily(candidate?.strategy);
  if (!mappedFamily && candidate?.strategy) {
    blockingReasons.push(
      `promotion_strategy_family_unsupported:${candidate.strategy}`,
    );
  }

  for (const symbol of input.symbols) {
    if (!input.resolvedMarketIdentity[symbol]) {
      blockingReasons.push(`promotion_market_identity_missing:${symbol}`);
    }
  }

  if (promotionMetadata) {
    if (promotionMetadata.signalCodeCommitHash !== input.gitState.head) {
      blockingReasons.push("promotion_signal_code_commit_hash_mismatch");
    }
    if (promotionMetadata.vetoPolicyVersion !== VETO_POLICY_VERSION) {
      blockingReasons.push("promotion_veto_policy_version_mismatch");
    }
    if (promotionMetadata.runtimeSchemaVersion !== RUNTIME_SCHEMA_VERSION) {
      blockingReasons.push("promotion_runtime_schema_version_mismatch");
    }
  }

  if (paperExecutionCostBps != null && paperExecutionCostBps > 25) {
    blockingReasons.push("promotion_execution_cost_bps_above_max");
  }
  if (
    input.edgeDecayReport &&
    input.edgeDecayReport.overallVerdict !== "stable"
  ) {
    blockingReasons.push("promotion_edge_decay_degraded");
  }

  const uniqueReasons = Array.from(new Set(blockingReasons));
  if (uniqueReasons.length > 0 || !candidate || !mappedFamily || !promotionMetadata) {
    return {
      canPromote: false,
      blockingReasons: uniqueReasons,
      releaseGateProvenance: provenance.classification,
    };
  }

  return {
    canPromote: true,
    blockingReasons: [],
    releaseGateProvenance: provenance.classification,
    registryPayload: {
      version: 1,
      strategy_family: mappedFamily,
      strategy_params: candidate.params ?? {},
      candidate_id: championCandidateId,
      candidate_rank:
        tournamentEntries.find((entry) => entry.candidateId === championCandidateId)
          ?.rank,
      candidate_verdict:
        tournamentEntries.find((entry) => entry.candidateId === championCandidateId)
          ?.verdict,
      challengers: tournamentEntries
        .filter(
          (entry) =>
            entry.candidateId &&
            entry.candidateId !== championCandidateId &&
            (entry.verdict === "promote" || entry.verdict === "watch"),
        )
        .slice(0, 5)
        .map((entry) => ({
          candidate_id: entry.candidateId!,
          rank: entry.rank ?? 999,
          verdict: entry.verdict ?? "watch",
          strategy: entry.strategy,
          family: entry.family,
        })),
      symbols: [...input.symbols],
      bar_interval: input.barInterval,
      resolved_market_identity: input.resolvedMarketIdentity,
      paper_gate_snapshot: {
        generatedAt: now().toISOString(),
        validationRunsPath: input.validationRunsPath,
        verdictPath: input.verdictPath,
        releaseGateStatusPath: input.releaseGateStatusPath,
        verdictResult: input.verdict.result,
        verdictReasonCodes: input.verdict.reasonCodes ?? [],
        releaseGateGeneratedAt: input.releaseGateStatus?.generatedAt,
        releaseGateSourceReportPath: input.releaseGateStatus?.sourceReportPath,
        executionCostBps: paperExecutionCostBps,
        edgeDecayStatus: input.edgeDecayReport?.overallVerdict ?? null,
        edgeDecayReasons: input.edgeDecayReport?.reasons ?? [],
      },
      cost_model_version: promotionMetadata.costModelVersion,
      veto_policy_version: promotionMetadata.vetoPolicyVersion,
      runtime_schema_version: promotionMetadata.runtimeSchemaVersion,
      research_dataset_hash: promotionMetadata.researchDatasetHash,
      bar_data_snapshot_id: promotionMetadata.barDataSnapshotId,
      feature_pipeline_version: promotionMetadata.featurePipelineVersion,
      signal_code_commit_hash: promotionMetadata.signalCodeCommitHash,
      candidate_list_hash: promotionMetadata.candidateListHash,
      search_policy_hash: promotionMetadata.searchPolicyHash,
      trial_count: promotionMetadata.trialCount,
      accepted_oos_window: {
        dataset: (input.validationRuns.config ?? {}).dataset ?? null,
        wfo: (input.validationRuns.config ?? {}).wfo ?? null,
        wfoProfile: (input.validationRuns.config ?? {}).wfoProfile ?? null,
      },
      accepted_metrics: {
        strategyId: candidate.strategyId,
        strategyName: candidate.strategyName,
        backtestMetrics: candidate.backtestMetrics ?? null,
        significance: candidate.significance ?? null,
        fdr: candidate.fdr ?? null,
        hardGap: candidate.hardGap ?? null,
        wfoSummary: candidate.wfoSummary ?? null,
        wfoGatePassed: candidate.wfoGatePassed ?? null,
      },
      generated_at: now().toISOString(),
    },
  };
}

function mapStrategyToRegistryFamily(strategy: string | undefined): string | null {
  if (strategy === "volBreakout") {
    return "vol_gated_breakout";
  }
  if (strategy === "volTrend") {
    return "vol_gated_trend";
  }
  return null;
}
