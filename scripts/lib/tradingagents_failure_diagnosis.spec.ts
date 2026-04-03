import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAILURE_DIAGNOSIS_CONFIG,
  diagnoseTradingAgentsFailureMechanism,
} from "./tradingagents_failure_diagnosis.js";

describe("diagnoseTradingAgentsFailureMechanism", () => {
  it("classifies measurement variance reduction separately from structural instability", () => {
    const payload = diagnoseTradingAgentsFailureMechanism({
      paradigmId: "tradingagents_research_sidecar_v2",
      poolProfile: "baseline_independent_guard_v1",
      validationRuns: {
        diagnostics: {
          donorOnlyAggregateMetrics: {
            meanPbo: 0.98,
            meanDsrProbability: 0.68,
            fdrQ: 0.07,
            maxFailedWindowRatio: 0.625,
          },
          questions: {
            donorLeadsNonControls: true,
            controlsAreStrongerThanDonor: false,
          },
        },
        symbols: [
          {
            candidates: [
              {
                role: "donor",
                familyKey: "donor_family",
                correlationBucket: "donor_bucket",
                wfo: {
                  windows: [
                    { gatePassed: true },
                    { gatePassed: true },
                    { gatePassed: false },
                    { gatePassed: false },
                    { gatePassed: false },
                    { gatePassed: false },
                    { gatePassed: true },
                    { gatePassed: false },
                  ],
                },
              },
            ],
          },
        ],
        result: "NO_GO",
      },
      routeMatrix: {
        recommendedProfile: "phaseb_native_spa_candidate_v1",
        profiles: [
          {
            baseAggregateMetrics: {
              fdrDiagnostics: {
                symbolDiagnostics: {
                  "BTC/USD": { benchmarkStrategyId: "BASELINE_CONTROL" },
                },
              },
            },
          },
        ],
      },
      wfoSensitivity: {
        profiles: [
          {
            profile: "native_short_test",
            candidates: [
              {
                role: "donor",
                failedWindowRatio: 0.7333,
                averageDegradation: 25.9,
                medianTradesPerWindow: 2,
                diagnosisHints: ["sample_too_sparse_for_stable_oos"],
              },
            ],
          },
          {
            profile: "medium_oos",
            candidates: [
              {
                role: "donor",
                failedWindowRatio: 0.7273,
                averageDegradation: 0.41,
                medianTradesPerWindow: 4,
                diagnosisHints: [],
              },
            ],
          },
          {
            profile: "long_oos",
            candidates: [
              {
                role: "donor",
                failedWindowRatio: 0.625,
                averageDegradation: 0.145,
                medianTradesPerWindow: 6,
                diagnosisHints: [],
              },
            ],
          },
        ],
      },
      preRegisteredConfig: DEFAULT_FAILURE_DIAGNOSIS_CONFIG,
    });

    expect(payload.primaryRootCause).toBe("measurement_variance_reduction_only");
    expect(payload.secondaryContributors).toContain("sample_sparsity");
    expect(payload.secondaryContributors).toContain("structural_instability");
    expect(payload.decision).toBe("component_salvage_only");
    expect(payload.structuralFixEligibility.eligible).toBe(false);
  });

  it("allows structural fix only for clean horizon mismatch cases", () => {
    const payload = diagnoseTradingAgentsFailureMechanism({
      paradigmId: "tradingagents_research_sidecar_v2",
      validationRuns: {
        diagnostics: {
          donorOnlyAggregateMetrics: {
            meanPbo: 0.3,
            meanDsrProbability: 0.62,
            fdrQ: 0.04,
            maxFailedWindowRatio: 0.35,
          },
          questions: {
            donorLeadsNonControls: true,
            controlsAreStrongerThanDonor: false,
          },
        },
        symbols: [
          {
            candidates: [
              {
                role: "donor",
                familyKey: "donor_family_a",
                correlationBucket: "donor_bucket_a",
                wfo: {
                  windows: [
                    { gatePassed: true },
                    { gatePassed: true },
                    { gatePassed: false },
                    { gatePassed: true },
                    { gatePassed: true },
                    { gatePassed: true },
                  ],
                },
              },
              {
                role: "donor",
                familyKey: "donor_family_b",
                correlationBucket: "donor_bucket_b",
                wfo: { windows: [] },
              },
            ],
          },
        ],
        result: "NO_GO",
      },
      routeMatrix: {
        recommendedProfile: "phaseb_native_spa_candidate_v1",
        profiles: [
          {
            baseAggregateMetrics: {
              fdrDiagnostics: {
                symbolDiagnostics: {
                  "BTC/USD": { benchmarkStrategyId: "BASELINE_CONTROL" },
                },
              },
            },
          },
        ],
      },
      wfoSensitivity: {
        profiles: [
          {
            profile: "native_short_test",
            candidates: [
              {
                role: "donor",
                failedWindowRatio: 0.65,
                averageDegradation: 0.7,
                medianTradesPerWindow: 2,
                diagnosisHints: [],
              },
            ],
          },
          {
            profile: "medium_oos",
            candidates: [
              {
                role: "donor",
                failedWindowRatio: 0.48,
                averageDegradation: 0.38,
                medianTradesPerWindow: 4,
                diagnosisHints: [],
              },
            ],
          },
          {
            profile: "long_oos",
            candidates: [
              {
                role: "donor",
                failedWindowRatio: 0.32,
                averageDegradation: 0.2,
                medianTradesPerWindow: 6,
                diagnosisHints: [],
              },
            ],
          },
        ],
      },
      preRegisteredConfig: DEFAULT_FAILURE_DIAGNOSIS_CONFIG,
    });

    expect(payload.primaryRootCause).toBe("horizon_mismatch");
    expect(payload.structuralFixEligibility.eligible).toBe(true);
    expect(payload.decision).toBe("continue_structural_fix");
  });
});
