import { describe, expect, it } from "vitest";
import { evaluatePaperChampionPromotion } from "./paper_champion_promotion.js";
import type { PromotionMetadata } from "./paper_promotion_metadata.js";

function makeMetadata(): PromotionMetadata {
  return {
    candidateSourcePath: "/tmp/candidates.json",
    candidateListHash: "cand",
    searchPolicyHash: "policy",
    trialCount: 47,
    costModelVersion: "cost:v1:abc",
    vetoPolicyVersion: "veto.v1",
    runtimeSchemaVersion: "runtime.v1",
    researchDatasetHash: "dataset",
    barDataSnapshotId: "bars-123",
    featurePipelineVersion: "stage_c_round4_mapping.v1",
    signalCodeCommitHash: "head-123",
    fdrMethod: "cv_storey_bh",
    pboMethod: "cscv_pbo.v1",
    dsrMethod: "deflated_sharpe_ratio.v1",
  };
}

function makeInput() {
  return {
    validationRuns: {
      champion: {
        strategyId: "C1",
        releaseGateAllowPaper: true,
      },
      candidates: [
        {
          strategyId: "C1",
          strategyName: "candidate-1",
          strategy: "volBreakout",
          params: { breakoutPeriod: 12 },
          backtestMetrics: { profitFactor: 1.2 },
          significance: { pbo: 0.2 },
          fdr: { qValue: 0.1 },
          hardGap: { totalGap: 0 },
          wfoSummary: { totalWindows: 8 },
          wfoGatePassed: true,
        },
      ],
      config: {
        dataset: { symbol: "BTC/USD", lookbackBars: 3600 },
        wfo: { trainBars: 840, testBars: 120, stepBars: 180 },
        wfoProfile: "shift",
      },
      promotionMetadataReady: true,
      promotionMetadata: makeMetadata(),
      promotionMetadataBlockingReasons: [],
    },
    validationRunsPath: "/tmp/runs.json",
    verdict: {
      result: "GO",
      reasonCodes: [],
    },
    verdictPath: "/tmp/verdict.json",
    releaseGateStatus: {
      version: 1 as const,
      generatedAt: "2026-03-18T00:00:00.000Z",
      allowPaperTrading: true,
      allowLiveTrading: false,
      failedChecks: [],
      warningChecks: [],
      sourceReportPath:
        "/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/data/research/strategy/strategy_validation_runs.json",
    },
    releaseGateStatusPath: "/tmp/release_gate_status.json",
    gitState: {
      head: "head-123",
      isClean: true,
    },
    resolvedMarketIdentity: {
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
    symbols: ["BTC/USD"],
    barInterval: "1h",
    now: () => new Date("2026-03-18T00:00:00.000Z"),
  };
}

describe("paper_champion_promotion", () => {
  it("blocks promotion when verdict is not GO", () => {
    const input = makeInput();
    input.verdict.result = "NO_GO";

    const result = evaluatePaperChampionPromotion(input);

    expect(result.canPromote).toBe(false);
    expect(result.blockingReasons).toContain("promotion_requires_go_verdict");
  });

  it("blocks promotion on runtime-owned release gate provenance", () => {
    const input = makeInput();
    input.releaseGateStatus.sourceReportPath =
      "/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/data/runtime/runtime_faithful_simulation.latest.json";

    const result = evaluatePaperChampionPromotion(input);

    expect(result.canPromote).toBe(false);
    expect(result.releaseGateProvenance).toBe("runtime_owned");
    expect(
      result.blockingReasons.some((reason) => reason.includes("runtime_owned")),
    ).toBe(true);
  });

  it("blocks unsupported families such as volNoTradeFilter", () => {
    const input = makeInput();
    input.validationRuns.candidates[0].strategy = "volNoTradeFilter";

    const result = evaluatePaperChampionPromotion(input);

    expect(result.canPromote).toBe(false);
    expect(result.blockingReasons).toContain(
      "promotion_strategy_family_unsupported:volNoTradeFilter",
    );
  });

  it("blocks dirty worktrees", () => {
    const input = makeInput();
    input.gitState.isClean = false;

    const result = evaluatePaperChampionPromotion(input);

    expect(result.canPromote).toBe(false);
    expect(result.blockingReasons).toContain("promotion_git_dirty");
  });

  it("builds a registry payload for runtime-supported breakout families", () => {
    const result = evaluatePaperChampionPromotion(makeInput());

    expect(result.canPromote).toBe(true);
    expect(result.registryPayload?.strategy_family).toBe("vol_gated_breakout");
    expect(result.registryPayload?.symbols).toEqual(["BTC/USD"]);
    expect(result.registryPayload?.trial_count).toBe(47);
  });

  it("builds a registry payload for runtime-supported trend families", () => {
    const input = makeInput();
    input.validationRuns.candidates[0].strategy = "volTrend";

    const result = evaluatePaperChampionPromotion(input);

    expect(result.canPromote).toBe(true);
    expect(result.registryPayload?.strategy_family).toBe("vol_gated_trend");
  });

  it("blocks promotion when tournament verdict is not promote", () => {
    const input = makeInput();
    input.validationRuns.champion.candidateId = "candidate-1";
    input.validationRuns.candidates[0].candidateId = "candidate-1";
    input.validationRuns.tournamentLeaderboard = {
      winnerCandidateId: "candidate-1",
      entries: [
        {
          candidateId: "candidate-1",
          rank: 1,
          verdict: "watch",
          family: "vol_gated_breakout",
          strategy: "volBreakout",
        },
      ],
    };

    const result = evaluatePaperChampionPromotion(input);

    expect(result.canPromote).toBe(false);
    expect(result.blockingReasons).toContain(
      "promotion_tournament_verdict_not_promote",
    );
  });

  it("blocks promotion when execution cost drag is above the max", () => {
    const input = makeInput();

    const result = evaluatePaperChampionPromotion({
      ...input,
      executionCostReport: {
        schemaVersion: "execution_cost_report.v1",
        generatedAt: "2026-03-18T00:00:00.000Z",
        layers: [
          {
            layer: "paper",
            orderCount: 10,
            fillCount: 10,
            fillRate: 1,
            notionalUsd: 10000,
            feesUsd: 5,
            slippageUsd: 30,
            fundingUsd: 0,
            totalCostUsd: 35,
            feeBps: 5,
            slippageBps: 30,
            fundingBps: 0,
            totalCostBps: 35,
            latencyP50Ms: 100,
            latencyP95Ms: 200,
          },
        ],
        comparisons: [],
        warnings: ["high_cost_drag:paper"],
      },
    });

    expect(result.canPromote).toBe(false);
    expect(result.blockingReasons).toContain(
      "promotion_execution_cost_bps_above_max",
    );
  });

  it("blocks promotion when edge decay is degraded", () => {
    const input = makeInput();

    const result = evaluatePaperChampionPromotion({
      ...input,
      edgeDecayReport: {
        schemaVersion: "edge_decay_report.v1",
        generatedAt: "2026-03-18T00:00:00.000Z",
        overallVerdict: "degraded",
        thresholds: {
          degradedNetDeltaBps: -5,
          brokenNetDeltaBps: -15,
          degradedHitRateDelta: -0.03,
          brokenHitRateDelta: -0.08,
        },
        reasons: ["retained_edge_below_min"],
        layers: [
          {
            layer: "research",
            sampleCount: 10,
            rawExpectancyBps: 18,
            netExpectancyBps: 14,
            hitRate: 0.58,
          },
          {
            layer: "paper",
            sampleCount: 10,
            rawExpectancyBps: 10,
            netExpectancyBps: 6,
            hitRate: 0.53,
          },
        ],
        transitions: [
          {
            fromLayer: "research",
            toLayer: "paper",
            netExpectancyDeltaBps: -8,
            rawExpectancyDeltaBps: -8,
            hitRateDelta: -0.05,
            verdict: "degraded",
            reasons: ["net_expectancy_degraded", "hit_rate_degraded"],
          },
        ],
      },
    });

    expect(result.canPromote).toBe(false);
    expect(result.blockingReasons).toContain("promotion_edge_decay_degraded");
  });

  it("persists tournament challenger lifecycle and promotion gate snapshot fields", () => {
    const input = makeInput();
    input.validationRuns.champion.candidateId = "candidate-1";
    input.validationRuns.candidates[0].candidateId = "candidate-1";
    input.validationRuns.tournamentLeaderboard = {
      winnerCandidateId: "candidate-1",
      entries: [
        {
          candidateId: "candidate-1",
          rank: 1,
          verdict: "promote",
          family: "vol_gated_breakout",
          strategy: "volBreakout",
        },
        {
          candidateId: "candidate-2",
          rank: 2,
          verdict: "watch",
          family: "vol_gated_trend",
          strategy: "volTrend",
        },
      ],
    };

    const result = evaluatePaperChampionPromotion({
      ...input,
      executionCostReport: {
        schemaVersion: "execution_cost_report.v1",
        generatedAt: "2026-03-18T00:00:00.000Z",
        layers: [
          {
            layer: "paper",
            orderCount: 10,
            fillCount: 10,
            fillRate: 1,
            notionalUsd: 10000,
            feesUsd: 2,
            slippageUsd: 8,
            fundingUsd: 0,
            totalCostUsd: 10,
            feeBps: 2,
            slippageBps: 8,
            fundingBps: 0,
            totalCostBps: 10,
            latencyP50Ms: 80,
            latencyP95Ms: 140,
          },
        ],
        comparisons: [],
        warnings: [],
      },
      edgeDecayReport: {
        schemaVersion: "edge_decay_report.v1",
        generatedAt: "2026-03-18T00:00:00.000Z",
        overallVerdict: "stable",
        thresholds: {
          degradedNetDeltaBps: -5,
          brokenNetDeltaBps: -15,
          degradedHitRateDelta: -0.03,
          brokenHitRateDelta: -0.08,
        },
        reasons: [],
        layers: [
          {
            layer: "research",
            sampleCount: 10,
            rawExpectancyBps: 18,
            netExpectancyBps: 14,
            hitRate: 0.58,
          },
          {
            layer: "paper",
            sampleCount: 10,
            rawExpectancyBps: 17,
            netExpectancyBps: 13,
            hitRate: 0.57,
          },
        ],
        transitions: [
          {
            fromLayer: "research",
            toLayer: "paper",
            netExpectancyDeltaBps: -1,
            rawExpectancyDeltaBps: -1,
            hitRateDelta: -0.01,
            verdict: "stable",
            reasons: [],
          },
        ],
      },
    });

    expect(result.canPromote).toBe(true);
    expect(result.registryPayload?.candidate_id).toBe("candidate-1");
    expect(result.registryPayload?.candidate_rank).toBe(1);
    expect(result.registryPayload?.candidate_verdict).toBe("promote");
    expect(result.registryPayload?.challengers).toEqual([
      {
        candidate_id: "candidate-2",
        rank: 2,
        verdict: "watch",
        strategy: "volTrend",
        family: "vol_gated_trend",
      },
    ]);
    expect(result.registryPayload?.paper_gate_snapshot).toMatchObject({
      executionCostBps: 10,
      edgeDecayStatus: "stable",
      edgeDecayReasons: [],
    });
  });
});
