import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { diagnoseTradingAgentsFailureMechanism } from "./tradingagents_failure_diagnosis.js";
import { buildTradingAgentsTerminalArtifacts } from "./tradingagents_terminal_artifacts.js";
import { summarizeTradingAgentsTerminalDecision } from "./tradingagents_terminal_decision.js";

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), relativePath), "utf-8"),
  ) as T;
}

const GOLDEN_FIXTURES = [
  "data/research/strategy/strategy_validation_runs.btc_paradigm_tradingagents_v2_validation_diag_20260402.json",
  "data/research/strategy/analysis/route_matrix_btc_paradigm_tradingagents_v2_validation_20260401.json",
  "data/research/strategy/strategy_validation_runs.btc_paradigm_tradingagents_v2_validation_robust_anchor_diag_20260402.json",
  "data/research/strategy/analysis/route_matrix_btc_paradigm_tradingagents_v2_robustness_20260401.json",
  "data/research/strategy/analysis/wfo_sensitivity_btc_paradigm_tradingagents_v2_robust_anchor_20260402.json",
  "data/research/strategy/strategy_validation_runs.wfo_sensitivity_btc_paradigm_tradingagents_v2_independent_guard_20260402.native_short_test.json",
  "data/research/strategy/analysis/wfo_sensitivity_btc_paradigm_tradingagents_v2_independent_guard_20260402.json",
];

describe("TradingAgents terminal decision golden inputs", () => {
  it.skipIf(GOLDEN_FIXTURES.some((path) => !existsSync(resolve(process.cwd(), path))))(
    "keeps the pooled donor lane at component salvage only on the current BTC inputs",
    () => {
    const baselineValidationRuns = readJson<Record<string, unknown>>(
      "data/research/strategy/strategy_validation_runs.btc_paradigm_tradingagents_v2_validation_diag_20260402.json",
    );
    const validationRouteMatrix = readJson<Record<string, unknown>>(
      "data/research/strategy/analysis/route_matrix_btc_paradigm_tradingagents_v2_validation_20260401.json",
    );
    const robustAnchorValidationRuns = readJson<Record<string, unknown>>(
      "data/research/strategy/strategy_validation_runs.btc_paradigm_tradingagents_v2_validation_robust_anchor_diag_20260402.json",
    );
    const robustAnchorRouteMatrix = readJson<Record<string, unknown>>(
      "data/research/strategy/analysis/route_matrix_btc_paradigm_tradingagents_v2_robustness_20260401.json",
    );
    const robustAnchorWfoSensitivity = readJson<Record<string, unknown>>(
      "data/research/strategy/analysis/wfo_sensitivity_btc_paradigm_tradingagents_v2_robust_anchor_20260402.json",
    );
    const independentGuardValidationRuns = readJson<Record<string, unknown>>(
      "data/research/strategy/strategy_validation_runs.wfo_sensitivity_btc_paradigm_tradingagents_v2_independent_guard_20260402.native_short_test.json",
    );
    const independentGuardWfoSensitivity = readJson<Record<string, unknown>>(
      "data/research/strategy/analysis/wfo_sensitivity_btc_paradigm_tradingagents_v2_independent_guard_20260402.json",
    );

    const baselineDiagnosis = diagnoseTradingAgentsFailureMechanism({
      paradigmId: "tradingagents_research_sidecar_v2",
      poolProfile: "baseline_guard_v1",
      validationRuns: baselineValidationRuns,
      routeMatrix: validationRouteMatrix,
      wfoSensitivity: null,
    });
    const robustAnchorDiagnosis = diagnoseTradingAgentsFailureMechanism({
      paradigmId: "tradingagents_research_sidecar_v2",
      poolProfile: "baseline_robust_anchor_v1",
      validationRuns: robustAnchorValidationRuns,
      routeMatrix: robustAnchorRouteMatrix,
      wfoSensitivity: robustAnchorWfoSensitivity,
    });
    const independentGuardDiagnosis = diagnoseTradingAgentsFailureMechanism({
      paradigmId: "tradingagents_research_sidecar_v2",
      poolProfile: "baseline_independent_guard_v1",
      validationRuns: independentGuardValidationRuns,
      routeMatrix: validationRouteMatrix,
      wfoSensitivity: independentGuardWfoSensitivity,
    });

    expect(baselineDiagnosis.primaryRootCause).toBe("measurement_variance_reduction_only");
    expect(baselineDiagnosis.secondaryContributors).toEqual([
      "candidate_source_concentration",
    ]);
    expect(baselineDiagnosis.decision).toBe("component_salvage_only");
    expect(baselineDiagnosis.decisionConfidence).toBe("medium");
    expect(baselineDiagnosis.evidenceCompleteness).toBe("partial");
    expect(baselineDiagnosis.stageSnapshot.currentStage).toBe("A");
    expect(baselineDiagnosis.stageSnapshot.currentStageStatus).toBe("fail");

    expect(robustAnchorDiagnosis.primaryRootCause).toBe(
      "measurement_variance_reduction_only",
    );
    expect(robustAnchorDiagnosis.secondaryContributors).toEqual(
      expect.arrayContaining([
        "sample_sparsity",
        "selection_path_misalignment",
        "structural_instability",
        "candidate_source_concentration",
      ]),
    );
    expect(robustAnchorDiagnosis.decision).toBe("component_salvage_only");
    expect(robustAnchorDiagnosis.decisionConfidence).toBe("high");
    expect(robustAnchorDiagnosis.evidenceCompleteness).toBe("sufficient");

    expect(independentGuardDiagnosis.primaryRootCause).toBe(
      "measurement_variance_reduction_only",
    );
    expect(independentGuardDiagnosis.secondaryContributors).toEqual(
      expect.arrayContaining([
        "sample_sparsity",
        "structural_instability",
        "candidate_source_concentration",
      ]),
    );
    expect(independentGuardDiagnosis.decision).toBe("component_salvage_only");
    expect(independentGuardDiagnosis.decisionConfidence).toBe("high");
    expect(independentGuardDiagnosis.evidenceCompleteness).toBe("sufficient");

    const summary = summarizeTradingAgentsTerminalDecision({
      paradigmId: "tradingagents_research_sidecar_v2",
      diagnoses: [
        baselineDiagnosis,
        robustAnchorDiagnosis,
        independentGuardDiagnosis,
      ],
      diagnosisInputs: [
        "baseline_guard_v1.latest.json",
        "baseline_robust_anchor_v1.latest.json",
        "baseline_independent_guard_v1.latest.json",
      ],
      generatedAt: "2026-04-02T00:00:00.000Z",
    });

    expect(summary.terminalDecision).toBe("component_salvage_only");
    expect(summary.pooledSummary.diagnosisCount).toBe(3);
    expect(summary.pooledSummary.structuralFixEligibleCount).toBe(0);
    expect(summary.pooledSummary.horizonMismatchCount).toBe(0);
    expect(summary.pooledSummary.structuralInstabilitySecondaryCount).toBe(2);
    expect(summary.pooledSummary.componentSalvageCount).toBe(3);
    expect(summary.terminalDecisionConfidence).toBe("medium");
    expect(summary.terminalEvidenceCompleteness).toBe("partial");
    expect(summary.pooledSalvageTaxonomy).toEqual(
      expect.arrayContaining([
        "evaluation_pattern_only",
        "signal_component",
        "state_filter_component",
        "ranking_component",
      ]),
    );

    const artifacts = buildTradingAgentsTerminalArtifacts({
      paradigmId: "tradingagents_research_sidecar_v2",
      diagnoses: [
        baselineDiagnosis,
        robustAnchorDiagnosis,
        independentGuardDiagnosis,
      ],
      diagnosisInputs: summary.diagnosisInputs,
      generatedAt: "2026-04-02T00:00:00.000Z",
      artifactPaths: {
        diagnosisInputs: summary.diagnosisInputs,
        analysisTerminalDecisionJson: "/tmp/terminal_decision.json",
        analysisSalvageRegistryJson: "/tmp/salvage_registry.json",
        analysisTerminalPostmortemJson: "/tmp/terminal_postmortem.json",
        latestTerminalDecisionJson: "/tmp/terminal_decision.latest.json",
        latestSalvageRegistryJson: "/tmp/salvage_registry.latest.json",
        latestTerminalPostmortemJson: "/tmp/terminal_postmortem.latest.json",
        latestTerminalStatusJson: "/tmp/terminal_status.latest.json",
      },
      terminalDecision: summary,
    });

    expect(artifacts.terminalStatus.structuralFixLaneClosed).toBe(true);
    expect(artifacts.terminalStatus.currentStage).toBe("A");
    expect(artifacts.terminalStatus.currentStageStatus).toBe("fail");
    expect(artifacts.salvageRegistry.items.map((item) => item.taxonomy)).toEqual(
      expect.arrayContaining([
        "evaluation_pattern_only",
        "signal_component",
        "state_filter_component",
        "ranking_component",
      ]),
    );
    expect(artifacts.terminalPostmortem.rootCauseSynthesis.mixedState).toBe(false);
    expect(artifacts.terminalPostmortem.failureModeTag).toContain(
      "component_salvage_only",
    );
    },
  );
});
