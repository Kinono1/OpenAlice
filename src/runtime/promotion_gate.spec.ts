import { describe, expect, it } from "vitest";
import { evaluatePromotionGate } from "./promotion_gate.js";

const validValidationRuns = {
  championSet: [
    {
      symbol: "BTC/USD",
      strategyId: "BTC_TREND",
    },
    {
      symbol: "ETH/USD",
      strategyId: "ETH_ENSEMBLE",
    },
  ],
  candidates: [
    {
      strategyId: "BTC_TREND",
      strategyName: "BTC Trend",
      strategy: "trend",
    },
    {
      strategyId: "ETH_ENSEMBLE",
      strategyName: "ETH Ensemble",
      strategy: "ensemble",
    },
  ],
};

const validReleaseGate = {
  version: 1 as const,
  generatedAt: "2026-03-28T00:00:00.000Z",
  allowPaperTrading: true,
  allowLiveTrading: true,
  failedChecks: [],
  warningChecks: [],
  sourceReportPath: "/tmp/validation.json",
};

describe("promotion_gate", () => {
  it("blocks when verdict is missing or invalid", () => {
    const verdict = evaluatePromotionGate({
      validationRuns: validValidationRuns,
      experimentVerdict: null,
      releaseGateStatus: validReleaseGate,
      portfolioSymbols: ["BTC/USD", "ETH/USD"],
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.blockingReasons).toContain("verdict_missing_or_invalid");
  });

  it("blocks when verdict result is NO_GO", () => {
    const verdict = evaluatePromotionGate({
      validationRuns: validValidationRuns,
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "NO_GO",
      },
      releaseGateStatus: validReleaseGate,
      portfolioSymbols: ["BTC/USD", "ETH/USD"],
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.blockingReasons).toContain("promotion_requires_go_verdict");
  });

  it("blocks when release gate is not approved", () => {
    const verdict = evaluatePromotionGate({
      validationRuns: validValidationRuns,
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "GO",
      },
      releaseGateStatus: {
        ...validReleaseGate,
        allowLiveTrading: false,
        failedChecks: ["wfo"],
      },
      portfolioSymbols: ["BTC/USD", "ETH/USD"],
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.blockingReasons).toContain("release_gate_not_approved");
    expect(verdict.warnings).toContain("release_gate_failed:wfo");
  });

  it("passes when verdict, release gate, and supported family all allow", () => {
    const verdict = evaluatePromotionGate({
      validationRuns: validValidationRuns,
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "GO",
        outputPaths: {
          validationRuns: "/tmp/strategy_validation_runs.json",
          releaseGateStatus: "/tmp/release_gate_status.json",
        },
      },
      releaseGateStatus: validReleaseGate,
      portfolioSymbols: ["BTC/USD", "ETH/USD"],
    });

    expect(verdict.pass).toBe(true);
    expect(verdict.blockingReasons).toEqual([]);
    expect(verdict.evidenceRefs).toEqual([
      "/tmp/strategy_validation_runs.json",
      "/tmp/release_gate_status.json",
      "/tmp/validation.json",
    ]);
  });

  it("treats regimeTrend as a supported default family", () => {
    const verdict = evaluatePromotionGate({
      validationRuns: {
        championSet: [
          {
            symbol: "BTC/USD",
            strategyId: "BTC_REGIME",
          },
        ],
        candidates: [
          {
            strategyId: "BTC_REGIME",
            strategyName: "BTC Regime Trend",
            strategy: "regimeTrend",
          },
        ],
      },
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "GO",
      },
      releaseGateStatus: validReleaseGate,
      portfolioSymbols: ["BTC/USD"],
    });

    expect(verdict.pass).toBe(true);
    expect(verdict.blockingReasons).toEqual([]);
  });

  it("blocks when metadata is not ready", () => {
    const verdict = evaluatePromotionGate({
      validationRuns: validValidationRuns,
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "GO",
      },
      releaseGateStatus: validReleaseGate,
      promotionMetadataReady: false,
      portfolioSymbols: ["BTC/USD", "ETH/USD"],
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.blockingReasons).toContain("promotion_metadata_not_ready");
  });

  it("blocks unsupported strategy family", () => {
    const verdict = evaluatePromotionGate({
      validationRuns: {
        championSet: [
          {
            symbol: "BTC/USD",
            strategyId: "S1",
          },
          {
            symbol: "ETH/USD",
            strategyId: "S2",
          },
        ],
        candidates: [
          {
            strategyId: "S1",
            strategyName: "Donor",
            strategy: "customFamily",
          },
          {
            strategyId: "S2",
            strategyName: "Peer",
            strategy: "trend",
          },
        ],
      },
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "GO",
      },
      releaseGateStatus: validReleaseGate,
      supportedStrategyFamilies: ["trend", "ensemble"],
      portfolioSymbols: ["BTC/USD", "ETH/USD"],
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.blockingReasons).toContain(
      "promotion_strategy_family_unsupported:customFamily",
    );
  });

  it("blocks a dual-symbol portfolio when the champion set omits a required symbol", () => {
    const verdict = evaluatePromotionGate({
      validationRuns: {
        championSet: [
          {
            symbol: "BTC/USD",
            strategyId: "BTC_TREND",
          },
        ],
        candidates: [
          {
            strategyId: "BTC_TREND",
            strategyName: "BTC Trend",
            strategy: "trend",
          },
        ],
      },
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "GO",
      },
      releaseGateStatus: validReleaseGate,
      portfolioSymbols: ["BTC/USD", "ETH/USD"],
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.blockingReasons).toContain("promotion_candidate_missing_or_invalid");
  });

  it("keeps legacy singleton validation runs working for a single-symbol portfolio only", () => {
    const verdict = evaluatePromotionGate({
      validationRuns: {
        champion: {
          strategyId: "BTC_TREND",
        },
        candidates: [
          {
            strategyId: "BTC_TREND",
            strategyName: "BTC Trend",
            strategy: "trend",
          },
        ],
      },
      experimentVerdict: {
        schemaVersion: "experiment_verdict.v2",
        result: "GO",
      },
      releaseGateStatus: validReleaseGate,
      portfolioSymbols: ["BTC/USD"],
    });

    expect(verdict.pass).toBe(true);
    expect(verdict.blockingReasons).toEqual([]);
  });
});
