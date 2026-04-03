import { describe, expect, it } from "vitest";
import { evaluatePaperGate } from "./paper_gate.js";

describe("paper_gate", () => {
  it("encodes the current blocked-state reasons", () => {
    const verdict = evaluatePaperGate({
      promotionGatePass: false,
      championRegistryState: "missing",
      championLoaded: false,
      policyVersionMatch: false,
      researchApproved: false,
      runtimeHealthy: true,
      dataFresh: true,
      dataQualityValid: true,
      connectorHealthy: true,
      riskLimitsLoaded: true,
      paperExecutorEnabled: true,
    });

    expect(verdict.allowPaperTrading).toBe(false);
    expect(verdict.blockingReasons).toEqual([
      "paper_research_not_approved",
      "paper_champion_registry_missing",
      "paper_champion_not_loaded",
      "paper_policy_version_mismatch",
    ]);
  });

  it("distinguishes invalid registry from missing registry", () => {
    const verdict = evaluatePaperGate({
      promotionGatePass: true,
      championRegistryState: "invalid",
      championLoaded: false,
      policyVersionMatch: true,
      researchApproved: true,
      runtimeHealthy: true,
      dataFresh: true,
      dataQualityValid: true,
      connectorHealthy: true,
      riskLimitsLoaded: true,
      paperExecutorEnabled: true,
    });

    expect(verdict.blockingReasons).toContain("paper_champion_registry_invalid");
  });

  it("allows paper trading when every gate is satisfied", () => {
    const verdict = evaluatePaperGate({
      promotionGatePass: true,
      championRegistryState: "valid",
      championLoaded: true,
      championSetComplete: true,
      policyVersionMatch: true,
      researchApproved: true,
      runtimeHealthy: true,
      dataFresh: true,
      dataQualityValid: true,
      connectorHealthy: true,
      riskLimitsLoaded: true,
      paperExecutorEnabled: true,
      stabilityWindow: {
        consecutiveStableCycles: 3,
        requiredStableCycles: 3,
      },
    });

    expect(verdict.mode).toBe("active");
    expect(verdict.allowPaperTrading).toBe(true);
    expect(verdict.allowPaperExecution).toBe(true);
    expect(verdict.allowActivePaperTrading).toBe(true);
    expect(verdict.blockingReasons).toEqual([]);
    expect(verdict.flatOnlyReasons).toEqual([]);
  });

  it("adds runtime, data, connector, and risk blockers", () => {
    const verdict = evaluatePaperGate({
      promotionGatePass: true,
      championRegistryState: "valid",
      championLoaded: true,
      policyVersionMatch: true,
      researchApproved: true,
      runtimeHealthy: false,
      dataFresh: false,
      dataQualityValid: false,
      connectorHealthy: false,
      riskLimitsLoaded: false,
      paperExecutorEnabled: false,
    });

    expect(verdict.blockingReasons).toEqual([
      "paper_runtime_unhealthy",
      "paper_data_not_fresh",
      "paper_data_quality_invalid",
      "paper_connector_unhealthy",
      "paper_risk_limits_missing",
      "paper_executor_disabled",
    ]);
  });

  it("allows paper execution but forces flat mode when stability window is incomplete", () => {
    const verdict = evaluatePaperGate({
      promotionGatePass: true,
      championRegistryState: "valid",
      championLoaded: true,
      championSetComplete: true,
      policyVersionMatch: true,
      researchApproved: true,
      runtimeHealthy: true,
      dataFresh: true,
      dataQualityValid: true,
      connectorHealthy: true,
      riskLimitsLoaded: true,
      paperExecutorEnabled: true,
      stabilityWindow: {
        consecutiveStableCycles: 2,
        requiredStableCycles: 3,
      },
    });

    expect(verdict.mode).toBe("flat");
    expect(verdict.allowPaperExecution).toBe(true);
    expect(verdict.allowPaperTrading).toBe(false);
    expect(verdict.allowActivePaperTrading).toBe(false);
    expect(verdict.blockingReasons).toEqual([]);
    expect(verdict.flatOnlyReasons).toEqual([
      "paper_stability_window_incomplete",
    ]);
  });

  it("keeps paper flat when champion set is incomplete even if registry is valid", () => {
    const verdict = evaluatePaperGate({
      promotionGatePass: true,
      championRegistryState: "valid",
      championLoaded: true,
      championSetComplete: false,
      policyVersionMatch: true,
      researchApproved: true,
      runtimeHealthy: true,
      dataFresh: true,
      dataQualityValid: true,
      connectorHealthy: true,
      riskLimitsLoaded: true,
      paperExecutorEnabled: true,
    });

    expect(verdict.mode).toBe("flat");
    expect(verdict.allowPaperExecution).toBe(true);
    expect(verdict.flatOnlyReasons).toContain("paper_champion_set_incomplete");
  });

  it("treats promotion shortfall as flat-only when paper infrastructure is otherwise healthy", () => {
    const verdict = evaluatePaperGate({
      promotionGatePass: false,
      championRegistryState: "valid",
      championLoaded: true,
      championSetComplete: true,
      policyVersionMatch: true,
      researchApproved: true,
      runtimeHealthy: true,
      dataFresh: true,
      dataQualityValid: true,
      connectorHealthy: true,
      riskLimitsLoaded: true,
      paperExecutorEnabled: true,
    });

    expect(verdict.mode).toBe("flat");
    expect(verdict.blockingReasons).toEqual([]);
    expect(verdict.flatOnlyReasons).toContain("promotion_gate_blocked");
  });
});
