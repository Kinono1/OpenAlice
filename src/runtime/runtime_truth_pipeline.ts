import type { CryptoPosition } from "../extension/crypto-trading/interfaces.js";
import type { PortfolioTarget } from "../portfolio/target.js";
import {
  evaluateChampionRegistryCoverage,
  type ChampionRegistryLoadResult,
} from "./champion_registry.js";
import {
  buildPaperExecutionPlan,
  type PaperExecutionPlan,
} from "./paper_execution_plan.js";
import { evaluatePaperGate, type PaperGateVerdict } from "./paper_gate.js";
import {
  evaluatePromotionGate,
  summarizeValidationRuns,
  type PromotionGateVerdict,
} from "./promotion_gate.js";
import type { PersistedReleaseGateStatus } from "./release_gate_status.js";
import {
  buildRuntimeStatusSnapshot,
  type RuntimeProofTrackingInput,
  type RuntimeStatusSnapshot,
} from "./runtime_status_snapshot.js";
import type { RuntimePlanningState } from "./live_gate_manager.js";

export interface RuntimeTruthPipelineInput {
  validationRuns: unknown;
  experimentVerdict: unknown;
  releaseGateStatus: PersistedReleaseGateStatus | null;
  championRegistry: ChampionRegistryLoadResult;
  planningState: RuntimePlanningState;
  portfolioTarget: PortfolioTarget;
  currentPositions: CryptoPosition[];
  pricesBySymbol: Record<string, number>;
  promotionMetadataReady?: boolean;
  supportedStrategyFamilies?: string[];
  championLoaded?: boolean;
  policyVersionMatch?: boolean;
  researchApproved?: boolean;
  runtimeHealthy?: boolean;
  dataFresh?: boolean;
  dataQualityValid?: boolean;
  connectorHealthy?: boolean;
  riskLimitsLoaded?: boolean;
  paperExecutorEnabled?: boolean;
  turnoverCap?: number;
  proofTracking?: RuntimeProofTrackingInput;
  validationRunsPath?: string;
  verdictPath?: string;
  releaseGateStatusPath?: string;
  registryPath?: string;
  now?: Date;
}

export interface RuntimeTruthPipelineResult {
  promotionGate: PromotionGateVerdict;
  paperGate: PaperGateVerdict;
  executionPlan: PaperExecutionPlan;
  snapshot: RuntimeStatusSnapshot;
}

export function evaluateRuntimeTruthPipeline(
  input: RuntimeTruthPipelineInput,
): RuntimeTruthPipelineResult {
  const portfolioSymbols = unique(
    input.portfolioTarget.positions.map(position => position.symbol).filter(Boolean),
  );
  const validationRuns = summarizeValidationRuns(input.validationRuns, {
    portfolioSymbols,
  });
  const registryCoverage =
    input.championRegistry.kind === "valid"
      ? evaluateChampionRegistryCoverage(input.championRegistry.registry, {
          requiredSymbols: portfolioSymbols,
          expectedStrategyIdsBySymbol: validationRuns.expectedStrategyIdsBySymbol,
        })
      : null;

  const promotionGate = evaluatePromotionGate({
    validationRuns: input.validationRuns,
    experimentVerdict: input.experimentVerdict,
    releaseGateStatus: input.releaseGateStatus,
    portfolioSymbols,
    promotionMetadataReady: input.promotionMetadataReady,
    supportedStrategyFamilies: input.supportedStrategyFamilies,
    now: input.now,
  });

  const paperGate = evaluatePaperGate({
    promotionGatePass: promotionGate.pass,
    championRegistryState: input.championRegistry.kind,
    championLoaded:
      input.championLoaded ??
      (input.championRegistry.kind === "valid" &&
        validationRuns.ok &&
        registryCoverage?.ok === true),
    policyVersionMatch:
      input.policyVersionMatch ??
      (input.championRegistry.kind === "valid" &&
        validationRuns.ok &&
        registryCoverage?.ok === true),
    researchApproved:
      input.researchApproved ?? resolveResearchApproved(input.experimentVerdict),
    runtimeHealthy: input.runtimeHealthy ?? true,
    dataFresh: input.dataFresh ?? true,
    dataQualityValid: input.dataQualityValid ?? true,
    connectorHealthy: input.connectorHealthy ?? true,
    riskLimitsLoaded: input.riskLimitsLoaded ?? true,
    paperExecutorEnabled: input.paperExecutorEnabled ?? true,
    now: input.now,
  });

  const executionPlan = buildPaperExecutionPlan({
    promotionPass: promotionGate.pass,
    paperGateAllowsPaperTrading: paperGate.allowPaperTrading,
    championRegistryState: input.championRegistry.kind,
    regimeSeverity: input.planningState.regimeSeverity,
    portfolioTarget: input.portfolioTarget,
    currentPositions: input.currentPositions,
    pricesBySymbol: input.pricesBySymbol,
    turnoverCap: input.turnoverCap,
    now: input.now,
  });

  const snapshot = buildRuntimeStatusSnapshot({
    promotionGate,
    paperGate,
    executionPlan:
      executionPlan.kind === "blocked"
        ? {
            kind: "blocked",
            blockingReasons: executionPlan.blockingReasons,
          }
        : {
            kind: "active",
            portfolioTarget: executionPlan.portfolioTarget,
            rebalancePlan: executionPlan.rebalancePlan,
            walletOperations: executionPlan.walletOperations,
            currentPositions: input.currentPositions,
            pricesBySymbol: input.pricesBySymbol,
          },
    planningState: input.planningState,
    releaseGateStatus: input.releaseGateStatus,
    proofTracking: input.proofTracking,
    releaseGateStatusPath: input.releaseGateStatusPath,
    validationRunsPath: input.validationRunsPath,
    verdictPath: input.verdictPath,
    registryPath: input.registryPath,
    now: input.now,
  });

  return {
    promotionGate,
    paperGate,
    executionPlan,
    snapshot,
  };
}

function resolveResearchApproved(experimentVerdict: unknown): boolean {
  if (!experimentVerdict || typeof experimentVerdict !== "object") {
    return false;
  }
  const value = experimentVerdict as { result?: unknown };
  return value.result === "GO";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
