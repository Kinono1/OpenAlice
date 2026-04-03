import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildTradingAgentsStageSnapshot } from "./tradingagents_stage_assessment.js";
import { diagnoseTradingAgentsFailureMechanism } from "./tradingagents_failure_diagnosis.js";

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), relativePath), "utf-8"),
  ) as T;
}

describe("TradingAgents diagnosis golden artifacts", () => {
  it("keeps baseline validation artifact at Stage A pass and selection-path partial", () => {
    const validationRuns = readJson<Record<string, unknown>>(
      "data/research/strategy/strategy_validation_runs.btc_paradigm_tradingagents_v2_validation.json",
    );
    const routeMatrix = readJson<Record<string, unknown>>(
      "data/research/strategy/analysis/route_matrix_btc_paradigm_tradingagents_v2_validation_20260401.json",
    );
    const wfoSensitivity = readJson<Record<string, unknown>>(
      "data/research/strategy/analysis/wfo_sensitivity_btc_paradigm_tradingagents_v2_independent_guard_20260402.json",
    );

    const stageSnapshot = buildTradingAgentsStageSnapshot({
      validationRuns,
      routeMatrix,
      wfoSensitivity,
    });
    const diagnosis = diagnoseTradingAgentsFailureMechanism({
      paradigmId: "tradingagents_research_sidecar_v2",
      poolProfile: "baseline_guard_v1",
      validationRuns,
      routeMatrix,
      wfoSensitivity,
    });

    expect(stageSnapshot.currentStage).toBe("A");
    expect(stageSnapshot.currentStageStatus).toBe("pass");
    expect(diagnosis.selectionPathSanity.status).toBe("partial");
    expect(diagnosis.primaryRootCause).toBe("measurement_variance_reduction_only");
    expect(diagnosis.decision).toBe("component_salvage_only");
  });
});
