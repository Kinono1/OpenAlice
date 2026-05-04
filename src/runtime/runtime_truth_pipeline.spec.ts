import { describe, expect, it } from "vitest";
import { buildPortfolioTargetFromWeights } from "../portfolio/target.js";
import {
  evaluateRuntimeTruthPipeline,
} from "./runtime_truth_pipeline.js";

const portfolioTarget = buildPortfolioTargetFromWeights({
  basisEquityUsd: 1_000,
  weights: {
    "BTC/USD": 0.6,
    "ETH/USD": 0.4,
  },
  maxTurnoverPct: 1,
});

describe("runtime_truth_pipeline", () => {
  it("produces a blocked pipeline result from failing inputs", () => {
    const result = evaluateRuntimeTruthPipeline({
      validationRuns: {
        championSet: [
          { symbol: "BTC/USD", strategyId: "BTC_TREND" },
          { symbol: "ETH/USD", strategyId: "ETH_ENSEMBLE" },
        ],
        candidates: [
          {
            strategyId: "BTC_TREND",
            strategyName: "BTC Trend",
            strategy: "trend",
            promotionEligible: true,
            admissionIntent: "promotion",
            runtimeMode: "real_runtime",
            sourceLineage: "openalice_native",
          },
          {
            strategyId: "ETH_ENSEMBLE",
            strategyName: "ETH Ensemble",
            strategy: "ensemble",
            promotionEligible: true,
            admissionIntent: "promotion",
            runtimeMode: "real_runtime",
            sourceLineage: "openalice_native",
          },
        ],
      },
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "NO_GO",
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-28T00:00:00.000Z",
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ["wfo"],
        warningChecks: [],
      },
      championRegistry: { kind: "missing" },
      planningState: {
        regimeSeverity: "stable",
        regimeReason: null,
        capitalRampStage: "5%",
        releaseGateStatus: null,
        releaseGateBlocked: true,
        releaseGateBlockedReason: "release_gate_not_approved",
      },
      portfolioTarget,
      currentPositions: [],
      pricesBySymbol: {
        "BTC/USD": 100,
        "ETH/USD": 50,
      },
    });

    expect(result.promotionGate.pass).toBe(false);
    expect(result.paperGate.allowPaperTrading).toBe(false);
    expect(result.executionPlan.kind).toBe("blocked");
    expect(result.snapshot.paperPromotionStatus.canPromote).toBe(false);
    expect(result.snapshot.phaseReadiness).toMatchObject({
      research: {
        status: "blocked",
      },
      paper: {
        status: "blocked",
      },
      liveTinyCapital: {
        status: "blocked",
      },
      proofTracking: {
        status: "blocked",
      },
    });
  });

  it("produces an active pipeline result from passing inputs", () => {
    const result = evaluateRuntimeTruthPipeline({
      validationRuns: {
        championSet: [
          { symbol: "BTC/USD", strategyId: "BTC_TREND" },
          { symbol: "ETH/USD", strategyId: "ETH_ENSEMBLE" },
        ],
        candidates: [
          {
            strategyId: "BTC_TREND",
            strategyName: "BTC Trend",
            strategy: "trend",
            promotionEligible: true,
            admissionIntent: "promotion",
            runtimeMode: "real_runtime",
            sourceLineage: "openalice_native",
          },
          {
            strategyId: "ETH_ENSEMBLE",
            strategyName: "ETH Ensemble",
            strategy: "ensemble",
            promotionEligible: true,
            admissionIntent: "promotion",
            runtimeMode: "real_runtime",
            sourceLineage: "openalice_native",
          },
        ],
      },
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "GO",
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-28T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      championRegistry: {
        kind: "valid",
        registry: {
          version: 1,
          generatedAt: "2026-03-28T00:00:00.000Z",
          entries: [
            {
              strategyId: "BTC_TREND",
              strategyFamily: "trend",
              symbols: ["BTC/USD"],
            },
            {
              strategyId: "ETH_ENSEMBLE",
              strategyFamily: "ensemble",
              symbols: ["ETH/USD"],
            },
          ],
        },
      },
      planningState: {
        regimeSeverity: "stable",
        regimeReason: null,
        capitalRampStage: "5%",
        releaseGateStatus: null,
        releaseGateBlocked: false,
        releaseGateBlockedReason: null,
      },
      portfolioTarget,
      currentPositions: [],
      pricesBySymbol: {
        "BTC/USD": 100,
        "ETH/USD": 50,
      },
      validationRunsPath: "/tmp/strategy_validation_runs.json",
      verdictPath: "/tmp/experiment_verdict.v2.json",
      releaseGateStatusPath: "/tmp/release_gate_status.json",
      registryPath: "/tmp/paper_champion_registry.json",
      proofTracking: {
        status: "tracking",
        elapsedDays: 21,
        targetDays: 90,
        netPnlPositive: true,
      },
    });

    expect(result.promotionGate.pass).toBe(true);
    expect(result.paperGate.allowPaperTrading).toBe(true);
    expect(result.executionPlan.kind).toBe("active");
    expect(result.snapshot.paperExecutorStatus.summary).toMatchObject({
      releaseGate: "PASS",
      paperGate: "PASS",
    });
    expect(result.snapshot.phaseReadiness).toMatchObject({
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
        elapsedDays: 21,
        remainingDays: 69,
      },
    });
  });

  it("blocks when dual-symbol portfolio inputs only provide a legacy singleton champion", () => {
    const result = evaluateRuntimeTruthPipeline({
      validationRuns: {
        champion: { strategyId: "BTC_TREND" },
        candidates: [
          {
            strategyId: "BTC_TREND",
            strategyName: "BTC Trend",
            strategy: "trend",
            promotionEligible: true,
            admissionIntent: "promotion",
            runtimeMode: "real_runtime",
            sourceLineage: "openalice_native",
          },
        ],
      },
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "GO",
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-28T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      championRegistry: {
        kind: "valid",
        registry: {
          version: 1,
          generatedAt: "2026-03-28T00:00:00.000Z",
          entries: [
            {
              strategyId: "BTC_TREND",
              strategyFamily: "trend",
              symbols: ["BTC/USD"],
            },
          ],
        },
      },
      planningState: {
        regimeSeverity: "stable",
        regimeReason: null,
        capitalRampStage: "5%",
        releaseGateStatus: null,
        releaseGateBlocked: false,
        releaseGateBlockedReason: null,
      },
      portfolioTarget,
      currentPositions: [],
      pricesBySymbol: {
        "BTC/USD": 100,
        "ETH/USD": 50,
      },
    });

    expect(result.promotionGate.pass).toBe(false);
    expect(result.paperGate.allowPaperTrading).toBe(false);
    expect(result.paperGate.blockingReasons).toContain(
      "paper_champion_not_loaded",
    );
    expect(result.snapshot.phaseReadiness.paper).toMatchObject({
      status: "blocked",
      ready: false,
    });
    expect(result.executionPlan.kind).toBe("blocked");
  });


  it("keeps live tiny-cap readiness separate from proof-start readiness when proof has not started", () => {
    const result = evaluateRuntimeTruthPipeline({
      validationRuns: {
        championSet: [
          { symbol: "BTC/USD", strategyId: "BTC_TREND" },
          { symbol: "ETH/USD", strategyId: "ETH_ENSEMBLE" },
        ],
        candidates: [
          {
            strategyId: "BTC_TREND",
            strategyName: "BTC Trend",
            strategy: "trend",
            promotionEligible: true,
            admissionIntent: "promotion",
            runtimeMode: "real_runtime",
            sourceLineage: "openalice_native",
          },
          {
            strategyId: "ETH_ENSEMBLE",
            strategyName: "ETH Ensemble",
            strategy: "ensemble",
            promotionEligible: true,
            admissionIntent: "promotion",
            runtimeMode: "real_runtime",
            sourceLineage: "openalice_native",
          },
        ],
      },
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "GO",
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-28T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      championRegistry: {
        kind: "valid",
        registry: {
          version: 1,
          generatedAt: "2026-03-28T00:00:00.000Z",
          entries: [
            {
              strategyId: "BTC_TREND",
              strategyFamily: "trend",
              symbols: ["BTC/USD"],
            },
            {
              strategyId: "ETH_ENSEMBLE",
              strategyFamily: "ensemble",
              symbols: ["ETH/USD"],
            },
          ],
        },
      },
      planningState: {
        regimeSeverity: "stable",
        regimeReason: null,
        capitalRampStage: "5%",
        releaseGateStatus: null,
        releaseGateBlocked: false,
        releaseGateBlockedReason: null,
      },
      portfolioTarget,
      currentPositions: [],
      pricesBySymbol: {
        "BTC/USD": 100,
        "ETH/USD": 50,
      },
    });

    expect(result.executionPlan.kind).toBe("active");
    expect(result.snapshot.phaseReadiness).toMatchObject({
      research: {
        status: "ready",
      },
      paper: {
        status: "active_ready",
        ready: true,
      },
      liveTinyCapital: {
        status: "proof_start_ready",
        ready: false,
        readyToStartProof: true,
        proofStarted: false,
      },
      proofTracking: {
        status: "not_started",
        readyToStart: true,
        started: false,
      },
    });
  });


  it("keeps flat research-approved targets out of live/proof readiness", () => {
    const flatTarget = buildPortfolioTargetFromWeights({
      basisEquityUsd: 1_000,
      weights: {
        "BTC/USD": 0,
        "ETH/USD": 0,
      },
      maxTurnoverPct: 1,
    });

    const result = evaluateRuntimeTruthPipeline({
      validationRuns: {
        championSet: [
          { symbol: "BTC/USD", strategyId: "BTC_TREND" },
          { symbol: "ETH/USD", strategyId: "ETH_ENSEMBLE" },
        ],
        candidates: [
          {
            strategyId: "BTC_TREND",
            strategyName: "BTC Trend",
            strategy: "trend",
            promotionEligible: true,
            admissionIntent: "promotion",
            runtimeMode: "real_runtime",
            sourceLineage: "openalice_native",
          },
          {
            strategyId: "ETH_ENSEMBLE",
            strategyName: "ETH Ensemble",
            strategy: "ensemble",
            promotionEligible: true,
            admissionIntent: "promotion",
            runtimeMode: "real_runtime",
            sourceLineage: "openalice_native",
          },
        ],
      },
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "GO",
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-28T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      championRegistry: {
        kind: "valid",
        registry: {
          version: 1,
          generatedAt: "2026-03-28T00:00:00.000Z",
          entries: [
            {
              strategyId: "BTC_TREND",
              strategyFamily: "trend",
              symbols: ["BTC/USD"],
            },
            {
              strategyId: "ETH_ENSEMBLE",
              strategyFamily: "ensemble",
              symbols: ["ETH/USD"],
            },
          ],
        },
      },
      planningState: {
        regimeSeverity: "stable",
        regimeReason: null,
        capitalRampStage: "5%",
        releaseGateStatus: null,
        releaseGateBlocked: false,
        releaseGateBlockedReason: null,
      },
      portfolioTarget: flatTarget,
      currentPositions: [],
      pricesBySymbol: {
        "BTC/USD": 100,
        "ETH/USD": 50,
      },
    });

    expect(result.executionPlan.kind).toBe("active");
    expect(result.snapshot.phaseReadiness).toMatchObject({
      research: {
        status: "ready",
      },
      paper: {
        status: "flat_only",
        ready: false,
        hasNonFlatTarget: false,
      },
      liveTinyCapital: {
        status: "blocked",
        ready: false,
        readyToStartProof: false,
        proofStarted: false,
      },
      proofTracking: {
        status: "blocked",
        readyToStart: false,
        started: false,
      },
    });
  });

  it("blocks when the champion registry disagrees with the research truth for a portfolio symbol", () => {
    const result = evaluateRuntimeTruthPipeline({
      validationRuns: {
        championSet: [
          { symbol: "BTC/USD", strategyId: "BTC_TREND" },
          { symbol: "ETH/USD", strategyId: "ETH_ENSEMBLE" },
        ],
        candidates: [
          {
            strategyId: "BTC_TREND",
            strategyName: "BTC Trend",
            strategy: "trend",
            promotionEligible: true,
            admissionIntent: "promotion",
            runtimeMode: "real_runtime",
            sourceLineage: "openalice_native",
          },
          {
            strategyId: "ETH_ENSEMBLE",
            strategyName: "ETH Ensemble",
            strategy: "ensemble",
            promotionEligible: true,
            admissionIntent: "promotion",
            runtimeMode: "real_runtime",
            sourceLineage: "openalice_native",
          },
        ],
      },
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "GO",
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-28T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      championRegistry: {
        kind: "valid",
        registry: {
          version: 1,
          generatedAt: "2026-03-28T00:00:00.000Z",
          entries: [
            {
              strategyId: "BTC_TREND",
              strategyFamily: "trend",
              symbols: ["BTC/USD"],
            },
            {
              strategyId: "ETH_BREAKOUT",
              strategyFamily: "breakout",
              symbols: ["ETH/USD"],
            },
          ],
        },
      },
      planningState: {
        regimeSeverity: "stable",
        regimeReason: null,
        capitalRampStage: "5%",
        releaseGateStatus: null,
        releaseGateBlocked: false,
        releaseGateBlockedReason: null,
      },
      portfolioTarget,
      currentPositions: [],
      pricesBySymbol: {
        "BTC/USD": 100,
        "ETH/USD": 50,
      },
    });

    expect(result.promotionGate.pass).toBe(true);
    expect(result.paperGate.allowPaperTrading).toBe(false);
    expect(result.paperGate.blockingReasons).toContain("paper_champion_not_loaded");
    expect(result.paperGate.blockingReasons).toContain("paper_policy_version_mismatch");
    expect(result.executionPlan.kind).toBe("blocked");
  });
});
