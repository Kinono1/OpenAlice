export type PaperGateMode = "blocked" | "flat" | "active";

export interface PaperGateStabilityWindow {
  consecutiveStableCycles?: number;
  requiredStableCycles?: number;
}

export interface PaperGateVerdict {
  mode: PaperGateMode;
  allowPaperTrading: boolean;
  allowPaperExecution: boolean;
  allowActivePaperTrading: boolean;
  blockingReasons: string[];
  flatOnlyReasons: string[];
  warnings: string[];
  decidedAt: string;
}

export interface PaperGateInput {
  promotionGatePass: boolean;
  championRegistryState: "valid" | "missing" | "invalid";
  championLoaded?: boolean;
  policyVersionMatch?: boolean;
  researchApproved?: boolean;
  runtimeHealthy?: boolean;
  dataFresh?: boolean;
  dataQualityValid?: boolean;
  connectorHealthy?: boolean;
  riskLimitsLoaded?: boolean;
  paperExecutorEnabled?: boolean;
  championSetComplete?: boolean;
  stabilityWindow?: PaperGateStabilityWindow;
  now?: Date;
}

export function evaluatePaperGate(input: PaperGateInput): PaperGateVerdict {
  const blockingReasons: string[] = [];
  const flatOnlyReasons: string[] = [];
  const warnings: string[] = [];

  if (input.researchApproved !== true) {
    blockingReasons.push("paper_research_not_approved");
  }

  if (input.championRegistryState === "missing") {
    blockingReasons.push("paper_champion_registry_missing");
  } else if (input.championRegistryState === "invalid") {
    blockingReasons.push("paper_champion_registry_invalid");
  }

  if (input.championLoaded !== true) {
    blockingReasons.push("paper_champion_not_loaded");
  }

  if (input.policyVersionMatch !== true) {
    blockingReasons.push("paper_policy_version_mismatch");
  }

  if (input.runtimeHealthy === false) {
    blockingReasons.push("paper_runtime_unhealthy");
  }

  if (input.dataFresh === false) {
    blockingReasons.push("paper_data_not_fresh");
  }

  if (input.dataQualityValid === false) {
    blockingReasons.push("paper_data_quality_invalid");
  }

  if (input.connectorHealthy === false) {
    blockingReasons.push("paper_connector_unhealthy");
  }

  if (input.riskLimitsLoaded === false) {
    blockingReasons.push("paper_risk_limits_missing");
  }

  if (input.paperExecutorEnabled === false) {
    blockingReasons.push("paper_executor_disabled");
  }

  if (!input.promotionGatePass && input.researchApproved === true) {
    flatOnlyReasons.push("promotion_gate_blocked");
  }

  const championSetComplete = input.championSetComplete ?? input.championLoaded === true;
  if (!championSetComplete && input.researchApproved === true) {
    flatOnlyReasons.push("paper_champion_set_incomplete");
  }

  const stableCycles = Math.max(0, Math.floor(input.stabilityWindow?.consecutiveStableCycles ?? 0));
  const requiredStableCycles = Math.max(
    0,
    Math.floor(input.stabilityWindow?.requiredStableCycles ?? 0),
  );
  if (requiredStableCycles > 0 && stableCycles < requiredStableCycles) {
    flatOnlyReasons.push("paper_stability_window_incomplete");
    warnings.push(
      `paper_stability_progress=${stableCycles}/${requiredStableCycles}`,
    );
  }

  const uniqueBlockingReasons = Array.from(new Set(blockingReasons));
  const uniqueFlatOnlyReasons = Array.from(new Set(flatOnlyReasons));
  const mode: PaperGateMode =
    uniqueBlockingReasons.length > 0
      ? "blocked"
      : uniqueFlatOnlyReasons.length > 0
        ? "flat"
        : "active";

  if (requiredStableCycles > 0 && stableCycles >= requiredStableCycles) {
    warnings.push(
      `paper_stability_progress=${stableCycles}/${requiredStableCycles}`,
    );
  }

  return {
    mode,
    allowPaperTrading: mode === "active",
    allowPaperExecution: mode !== "blocked",
    allowActivePaperTrading: mode === "active",
    blockingReasons: uniqueBlockingReasons,
    flatOnlyReasons: uniqueFlatOnlyReasons,
    warnings,
    decidedAt: (input.now ?? new Date()).toISOString(),
  };
}
