import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  DSR_METHOD_VERSION,
  PBO_METHOD_VERSION,
  RUNTIME_SCHEMA_VERSION,
  VETO_POLICY_VERSION,
} from "./paper_runtime_versions.js";

const execFileAsync = promisify(execFile);

export interface PromotionMetadata {
  candidateSourcePath: string;
  candidateListHash: string;
  searchPolicyHash: string;
  trialCount: number;
  costModelVersion: string;
  vetoPolicyVersion: string;
  runtimeSchemaVersion: string;
  researchDatasetHash: string;
  barDataSnapshotId: string;
  featurePipelineVersion: string;
  signalCodeCommitHash: string;
  fdrMethod: string;
  pboMethod: string;
  dsrMethod: string;
}

export interface PromotionMetadataResult {
  ready: boolean;
  metadata: PromotionMetadata | null;
  blockingReasons: string[];
}

export interface GitState {
  head: string;
  isClean: boolean;
}

export interface BuildPromotionMetadataInput {
  repoRoot: string;
  candidatesFilePath: string;
  candidatesFilePayload: Record<string, unknown>;
  datasetInputCsvPath: string;
  costModel: Record<string, unknown>;
  fdrMethod: string;
}

export interface PromotionMetadataDeps {
  getGitState: (repoRoot: string) => Promise<GitState>;
  readJson: (path: string) => Promise<Record<string, unknown>>;
  sha256File: (path: string) => Promise<string>;
}

export async function buildPromotionMetadata(
  input: BuildPromotionMetadataInput,
  deps: PromotionMetadataDeps = createDefaultDeps(),
): Promise<PromotionMetadataResult> {
  const blockingReasons: string[] = [];
  const gitState = await deps.getGitState(input.repoRoot);
  if (!gitState.isClean) {
    blockingReasons.push("promotion_metadata_git_dirty");
  }

  const candidateSourcePath = resolve(input.candidatesFilePath);
  const candidateListHash = sha256Hex(
    stableSerialize(input.candidatesFilePayload.candidates ?? []),
  );
  const searchPolicyHash = sha256Hex(
    stableSerialize({
      thresholds: input.candidatesFilePayload.thresholds ?? null,
      wfo: input.candidatesFilePayload.wfo ?? null,
      significance: input.candidatesFilePayload.significance ?? null,
      riskSimulation: input.candidatesFilePayload.riskSimulation ?? null,
      costModel: input.candidatesFilePayload.costModel ?? null,
      hypothesisCompile: input.candidatesFilePayload.hypothesisCompile ?? null,
      stageCRound4Mapping:
        input.candidatesFilePayload.stageCRound4Mapping ?? null,
    }),
  );

  const trialCount = await resolveTrialCount(input.candidatesFilePayload, deps);
  if (trialCount == null || !Number.isInteger(trialCount) || trialCount <= 0) {
    blockingReasons.push("promotion_metadata_trial_count_missing");
  }

  const featurePipelineVersion = resolveFeaturePipelineVersion(
    input.candidatesFilePayload,
  );
  if (!featurePipelineVersion) {
    blockingReasons.push("promotion_metadata_feature_pipeline_version_missing");
  }

  const inputCsvPath = resolve(input.datasetInputCsvPath);
  const csvHash = await deps.sha256File(inputCsvPath);
  const researchDatasetHash = sha256Hex(
    stableSerialize({
      dataset: input.candidatesFilePayload.dataset ?? null,
      inputCsvPath,
      inputCsvSha256: csvHash,
    }),
  );

  if (blockingReasons.length > 0) {
    return {
      ready: false,
      metadata: null,
      blockingReasons,
    };
  }

  const resolvedTrialCount = trialCount as number;
  const resolvedFeaturePipelineVersion = featurePipelineVersion as string;

  return {
    ready: true,
    metadata: {
      candidateSourcePath,
      candidateListHash,
      searchPolicyHash,
      trialCount: resolvedTrialCount,
      costModelVersion: `cost:v1:${sha256Hex(stableSerialize(input.costModel))}`,
      vetoPolicyVersion: VETO_POLICY_VERSION,
      runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
      researchDatasetHash,
      barDataSnapshotId: `bars-${csvHash.slice(0, 24)}`,
      featurePipelineVersion: resolvedFeaturePipelineVersion,
      signalCodeCommitHash: gitState.head,
      fdrMethod: input.fdrMethod,
      pboMethod: PBO_METHOD_VERSION,
      dsrMethod: DSR_METHOD_VERSION,
    },
    blockingReasons,
  };
}

export async function readGitState(repoRoot: string): Promise<GitState> {
  const { stdout: headStdout } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoRoot },
  );
  const { stdout: statusStdout } = await execFileAsync(
    "git",
    ["status", "--porcelain"],
    { cwd: repoRoot },
  );
  return {
    head: headStdout.trim(),
    isClean: statusStdout.trim().length === 0,
  };
}

export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function resolveTrialCount(
  payload: Record<string, unknown>,
  deps: PromotionMetadataDeps,
): Promise<number | null> {
  const direct = firstPositiveInteger([
    payload.trial_count,
    payload.trialCount,
    payload.trialId,
  ]);
  if (direct) {
    return direct;
  }

  const hypothesisCompile = asObject(payload.hypothesisCompile);
  const inputs = asObject(hypothesisCompile?.inputs);
  const bestTripletSource =
    typeof inputs?.bestTripletSource === "string"
      ? resolve(inputs.bestTripletSource)
      : null;
  if (!bestTripletSource) {
    return null;
  }

  try {
    const bestTriplet = await deps.readJson(bestTripletSource);
    return firstPositiveInteger([
      bestTriplet.trial_count,
      bestTriplet.trialCount,
      bestTriplet.trialId,
    ]);
  } catch {
    return null;
  }
}

function resolveFeaturePipelineVersion(
  payload: Record<string, unknown>,
): string | null {
  const round4 = asObject(payload.stageCRound4Mapping);
  if (typeof round4?.schemaVersion === "string" && round4.schemaVersion.trim()) {
    return round4.schemaVersion;
  }

  const hypothesisCompile = asObject(payload.hypothesisCompile);
  if (
    typeof hypothesisCompile?.schemaVersion === "string" &&
    hypothesisCompile.schemaVersion.trim()
  ) {
    return hypothesisCompile.schemaVersion;
  }

  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function firstPositiveInteger(values: unknown[]): number | null {
  for (const value of values) {
    const num = Number(value);
    if (Number.isInteger(num) && num > 0) {
      return num;
    }
  }
  return null;
}

function createDefaultDeps(): PromotionMetadataDeps {
  return {
    getGitState: readGitState,
    readJson: async (path: string) => JSON.parse(await readFile(path, "utf-8")),
    sha256File: async (path: string) =>
      sha256Hex(await readFile(path, "utf-8")),
  };
}
