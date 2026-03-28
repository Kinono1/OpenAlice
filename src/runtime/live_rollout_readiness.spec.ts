import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateLiveRolloutReadiness,
  loadLiveRolloutReadiness,
  normalizePaperExecutorStatusArtifact,
  writeLiveRolloutReadiness,
  type PaperExecutorStatusArtifact,
} from "./live_rollout_readiness.js";
import type { PaperChampionRegistry } from "./paper_champion_registry.js";
import type { PersistedReleaseGateStatus } from "./release_gate_status.js";

function makeReleaseGateStatus(): PersistedReleaseGateStatus {
  return {
    version: 1,
    generatedAt: "2026-03-28T00:00:00.000Z",
    allowPaperTrading: true,
    allowLiveTrading: true,
    failedChecks: [],
    warningChecks: [],
    sourceReportPath: "/tmp/research/release_gate.json",
  };
}

function makeRegistry(): PaperChampionRegistry {
  return {
    version: 1,
    strategy_family: "vol_gated_breakout",
    strategy_params: { breakoutPeriod: 20 },
    candidate_id: "cand-1",
    candidate_rank: 1,
    candidate_verdict: "promote",
    symbols: ["BTC/USD"],
    bar_interval: "1h",
    resolved_market_identity: {
      "BTC/USD": {
        internalSymbol: "BTC/USD",
        ccxtSymbol: "BTC/USDT:USDT",
        instId: "BTC-USDT-SWAP",
        instType: "SWAP",
        settleCcy: "USDT",
        defaultMarketType: "swap",
        domainBaseUrl: "www.okx.com",
        demoMode: true,
      },
    },
    paper_gate_snapshot: {
      executionCostBps: 8,
      edgeDecayStatus: "stable",
      edgeDecayReasons: [],
    },
    cost_model_version: "cost.v1",
    veto_policy_version: "veto.v1",
    runtime_schema_version: "runtime.v1",
    research_dataset_hash: "dataset",
    bar_data_snapshot_id: "bars-123",
    feature_pipeline_version: "feature.v1",
    signal_code_commit_hash: "commit-123",
    candidate_list_hash: "cand-list",
    search_policy_hash: "search",
    trial_count: 20,
    accepted_oos_window: {},
    accepted_metrics: {},
    generated_at: "2026-03-28T00:00:00.000Z",
  };
}

function makePaperExecutorStatus(): PaperExecutorStatusArtifact {
  return {
    generatedAt: "2026-03-28T00:00:00.000Z",
    mode: "executor",
    blockingReasons: [],
    summary: {
      executor: {
        executed: 2,
        skipped: 0,
        blocked: 0,
        executedOpenCommits: 1,
        portfolioTargetsProduced: 1,
        executionCostBps: 8,
      },
    },
  };
}

describe("live_rollout_readiness", () => {
  it("passes when live gate, registry, and paper executor evidence are aligned", () => {
    const readiness = evaluateLiveRolloutReadiness({
      releaseGateStatus: makeReleaseGateStatus(),
      registry: makeRegistry(),
      registryValidation: {
        championLoaded: true,
        policyVersionMatch: true,
        checksumValid: true,
        blockingReasons: [],
      },
      paperExecutorStatus: makePaperExecutorStatus(),
      config: {
        maxExecutionCostBps: 25,
        requireEdgeDecayStable: true,
        requirePromotedCandidateVerdict: true,
        requirePortfolioTargetsForExecutedOpens: true,
      },
    });

    expect(readiness.readyForMicroLive).toBe(true);
    expect(readiness.blockingReasons).toEqual([]);
    expect(readiness.evidence.executionCostBps).toBe(8);
  });

  it("blocks when execution cost, edge decay, and portfolio target coverage degrade", () => {
    const readiness = evaluateLiveRolloutReadiness({
      releaseGateStatus: makeReleaseGateStatus(),
      registry: {
        ...makeRegistry(),
        candidate_verdict: "watch",
        paper_gate_snapshot: {
          executionCostBps: 40,
          edgeDecayStatus: "degraded",
          edgeDecayReasons: ["net_expectancy_degraded"],
        },
      },
      registryValidation: {
        championLoaded: true,
        policyVersionMatch: true,
        checksumValid: true,
        blockingReasons: [],
      },
      paperExecutorStatus: {
        ...makePaperExecutorStatus(),
        summary: {
          executor: {
            ...makePaperExecutorStatus().summary!.executor!,
            executedOpenCommits: 2,
            portfolioTargetsProduced: 1,
            executionCostBps: 40,
          },
        },
      },
      config: {
        maxExecutionCostBps: 25,
        requireEdgeDecayStable: true,
        requirePromotedCandidateVerdict: true,
        requirePortfolioTargetsForExecutedOpens: true,
      },
    });

    expect(readiness.readyForMicroLive).toBe(false);
    expect(readiness.blockingReasons).toEqual(
      expect.arrayContaining([
        "rollout_candidate_verdict_not_promote",
        "rollout_execution_cost_bps_above_max",
        "rollout_edge_decay_not_stable",
        "rollout_portfolio_target_incomplete",
      ]),
    );
  });

  it("warns when legacy registry payload is missing candidate verdict but otherwise passes", () => {
    const readiness = evaluateLiveRolloutReadiness({
      releaseGateStatus: makeReleaseGateStatus(),
      registry: {
        ...makeRegistry(),
        candidate_verdict: undefined,
      },
      registryValidation: {
        championLoaded: true,
        policyVersionMatch: true,
        checksumValid: true,
        blockingReasons: [],
      },
      paperExecutorStatus: makePaperExecutorStatus(),
      config: {
        maxExecutionCostBps: 25,
        requireEdgeDecayStable: true,
        requirePromotedCandidateVerdict: true,
        requirePortfolioTargetsForExecutedOpens: true,
      },
    });

    expect(readiness.readyForMicroLive).toBe(true);
    expect(readiness.warnings).toContain("rollout_candidate_verdict_missing");
  });

  it("writes and reloads a normalized readiness artifact", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rollout-readiness-"));
    const path = join(tempDir, "live_rollout_readiness.latest.json");
    const artifact = evaluateLiveRolloutReadiness({
      releaseGateStatus: makeReleaseGateStatus(),
      registry: makeRegistry(),
      registryValidation: {
        championLoaded: true,
        policyVersionMatch: true,
        checksumValid: true,
        blockingReasons: [],
      },
      paperExecutorStatus: makePaperExecutorStatus(),
      config: {
        maxExecutionCostBps: 25,
        requireEdgeDecayStable: true,
        requirePromotedCandidateVerdict: true,
        requirePortfolioTargetsForExecutedOpens: true,
      },
    });

    await writeLiveRolloutReadiness(artifact, path);
    const loaded = await loadLiveRolloutReadiness(path);

    expect(loaded).toEqual(artifact);
  });

  it("normalizes executor readiness fields from status payloads", () => {
    const status = normalizePaperExecutorStatusArtifact({
      generatedAt: "2026-03-28T00:00:00.000Z",
      mode: "executor",
      blockingReasons: [],
      summary: {
        executor: {
          executed: 2,
          skipped: 0,
          blocked: 0,
          executedOpenCommits: 1,
          portfolioTargetsProduced: 1,
          executionCostBps: 12,
        },
      },
    });

    expect(status.summary?.executor).toEqual({
      executed: 2,
      skipped: 0,
      blocked: 0,
      executedOpenCommits: 1,
      portfolioTargetsProduced: 1,
      executionCostBps: 12,
    });
  });
});
