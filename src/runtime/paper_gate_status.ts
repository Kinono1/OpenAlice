import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PersistedReleaseGateStatus } from "./release_gate_status.js";
import type { PaperChampionRegistryValidation } from "./paper_champion_registry.js";

export interface PersistedPaperGateStatus {
  version: 1;
  generatedAt: string;
  researchApproved: boolean;
  runtimeHealthy: boolean;
  dataFresh: boolean;
  dataQualityValid: boolean;
  connectorHealthy: boolean;
  riskLimitsLoaded: boolean;
  championLoaded: boolean;
  policyVersionMatch: boolean;
  paperExecutorEnabled: boolean;
  finalAllowPaperTrading: boolean;
  blockingReasons: string[];
  sourceReleaseGateStatusPath?: string;
  sourceChampionRegistryPath?: string;
}

export interface EvaluatePaperGateInput {
  releaseGateStatus: PersistedReleaseGateStatus | null;
  runtimeHealthy: boolean;
  dataFresh: boolean;
  dataQualityValid: boolean;
  connectorHealthy: boolean;
  riskLimitsLoaded: boolean;
  paperExecutorEnabled: boolean;
  championValidation: PaperChampionRegistryValidation;
  sourceReleaseGateStatusPath?: string;
  sourceChampionRegistryPath?: string;
}

export function evaluatePaperGateStatus(
  input: EvaluatePaperGateInput,
): PersistedPaperGateStatus {
  const researchApproved = Boolean(input.releaseGateStatus?.allowPaperTrading);
  const championLoaded = input.championValidation.championLoaded;
  const policyVersionMatch = input.championValidation.policyVersionMatch;
  const blockingReasons = [
    ...(researchApproved ? [] : ["paper_research_not_approved"]),
    ...(input.runtimeHealthy ? [] : ["paper_runtime_unhealthy"]),
    ...(input.dataFresh ? [] : ["paper_data_not_fresh"]),
    ...(input.dataQualityValid ? [] : ["paper_data_quality_invalid"]),
    ...(input.connectorHealthy ? [] : ["paper_connector_unhealthy"]),
    ...(input.riskLimitsLoaded ? [] : ["paper_risk_limits_not_loaded"]),
    ...(championLoaded ? [] : ["paper_champion_not_loaded"]),
    ...(policyVersionMatch ? [] : ["paper_policy_version_mismatch"]),
    ...(input.paperExecutorEnabled ? [] : ["paper_executor_disabled"]),
    ...input.championValidation.blockingReasons,
  ];

  const finalAllowPaperTrading =
    researchApproved &&
    input.runtimeHealthy &&
    input.dataFresh &&
    input.dataQualityValid &&
    input.connectorHealthy &&
    input.riskLimitsLoaded &&
    championLoaded &&
    policyVersionMatch &&
    input.paperExecutorEnabled;

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    researchApproved,
    runtimeHealthy: input.runtimeHealthy,
    dataFresh: input.dataFresh,
    dataQualityValid: input.dataQualityValid,
    connectorHealthy: input.connectorHealthy,
    riskLimitsLoaded: input.riskLimitsLoaded,
    championLoaded,
    policyVersionMatch,
    paperExecutorEnabled: input.paperExecutorEnabled,
    finalAllowPaperTrading,
    blockingReasons: Array.from(new Set(blockingReasons)),
    sourceReleaseGateStatusPath: input.sourceReleaseGateStatusPath,
    sourceChampionRegistryPath: input.sourceChampionRegistryPath,
  };
}

export async function writePaperGateStatus(
  status: PersistedPaperGateStatus,
  opts?: { filePath?: string },
): Promise<PersistedPaperGateStatus> {
  const filePath = opts?.filePath ?? "data/runtime/paper_gate_status.json";
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(status, null, 2)}\n`, "utf-8");
  return status;
}

export async function loadPaperGateStatus(
  filePath = "data/runtime/paper_gate_status.json",
): Promise<PersistedPaperGateStatus | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return normalizePaperGateStatus(JSON.parse(raw));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function normalizePaperGateStatus(raw: unknown): PersistedPaperGateStatus {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid paper gate status payload.");
  }
  const value = raw as Partial<PersistedPaperGateStatus>;
  if (
    value.version !== 1 ||
    typeof value.generatedAt !== "string" ||
    typeof value.researchApproved !== "boolean" ||
    typeof value.runtimeHealthy !== "boolean" ||
    typeof value.dataFresh !== "boolean" ||
    typeof value.dataQualityValid !== "boolean" ||
    typeof value.connectorHealthy !== "boolean" ||
    typeof value.riskLimitsLoaded !== "boolean" ||
    typeof value.championLoaded !== "boolean" ||
    typeof value.policyVersionMatch !== "boolean" ||
    typeof value.paperExecutorEnabled !== "boolean" ||
    typeof value.finalAllowPaperTrading !== "boolean" ||
    !Array.isArray(value.blockingReasons)
  ) {
    throw new Error("Malformed paper gate status.");
  }
  return {
    version: 1,
    generatedAt: value.generatedAt,
    researchApproved: value.researchApproved,
    runtimeHealthy: value.runtimeHealthy,
    dataFresh: value.dataFresh,
    dataQualityValid: value.dataQualityValid,
    connectorHealthy: value.connectorHealthy,
    riskLimitsLoaded: value.riskLimitsLoaded,
    championLoaded: value.championLoaded,
    policyVersionMatch: value.policyVersionMatch,
    paperExecutorEnabled: value.paperExecutorEnabled,
    finalAllowPaperTrading: value.finalAllowPaperTrading,
    blockingReasons: value.blockingReasons,
    sourceReleaseGateStatusPath: value.sourceReleaseGateStatusPath,
    sourceChampionRegistryPath: value.sourceChampionRegistryPath,
  };
}
