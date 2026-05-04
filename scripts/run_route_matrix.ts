import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { z } from "zod";
import { safePathComponent } from "../src/core/path-safety.js";
import { RuntimeCheckpointStore } from "../src/runtime/runtime_checkpoint.js";
import {
  appendExecutionJournal,
  extractSummaryMetrics,
  sanitizeError,
} from "./lib/execution_journal.js";

type MultipleTestingUnit = "candidate" | "family";

interface RouteManifest {
  schemaVersion?: string;
  generatedAt?: string;
  batchId?: string;
  batchGoal?: string;
  notes?: string[];
  dataset?: Record<string, unknown>;
  thresholds?: Record<string, unknown>;
  wfo?: Record<string, unknown>;
  significance?: Record<string, unknown>;
  riskSimulation?: Record<string, unknown>;
  costModel?: Record<string, unknown>;
  candidates?: Array<Record<string, unknown>>;
}

interface MatrixProfileSpec {
  id: string;
  sourceId?: string;
  multipleTestingUnit?: MultipleTestingUnit;
  fdrMethod?: "bh" | "by" | "cv_storey_bh" | "stepc" | "spa";
  wfoProfile?: "stable" | "shift" | "stress";
  storeyLambda?: number;
  cvAggQuantile?: number;
  notes?: string[];
  overrides?: Partial<RouteManifest>;
}

interface RouteMatrixSpec {
  schemaVersion?: string;
  matrixId: string;
  sourceId?: string;
  manifest: string;
  defaultMultipleTestingUnit?: MultipleTestingUnit;
  rankingObjective?: string;
  summaryOutput?: string;
  markdownOutput?: string;
  profiles: MatrixProfileSpec[];
}

interface RouteMatrixResult {
  profile: string;
  sourceId: string | null;
  multipleTestingUnit: MultipleTestingUnit;
  fdrMethod: string | null;
  wfoProfile: string | null;
  result: string | null;
  reasonCodes: string[];
  baseAggregateMetrics: Record<string, unknown> | null;
  aggregateMetrics: Record<string, unknown> | null;
  hardGap: {
    pboGap: number;
    dsrGap: number;
    fdrGap: number;
    totalGap: number;
  } | null;
  wfoFailureDensity: number | null;
  meanSharpe: number | null;
  outputs: {
    manifest: string;
    validationRuns: string;
    verdict: string;
    releaseGateStatus: string;
    status: string;
    phaseReadiness: string;
  };
}

interface CliArgs {
  matrixConfig: string;
  resume: boolean;
  fresh: boolean;
  runId?: string;
  checkpointRoot?: string;
}

type RouteMatrixStep =
  | "started"
  | "loaded_inputs"
  | "profile_completed"
  | "wrote_outputs";

const ROUTE_MATRIX_STEPS = new Set<RouteMatrixStep>([
  "started",
  "loaded_inputs",
  "profile_completed",
  "wrote_outputs",
]);

interface RouteMatrixCheckpointState {
  matrixId: string;
  matrixConfig: string;
  matrixConfigHash: string;
  manifest: string;
  manifestHash: string;
  summaryOutput: string;
  markdownOutput: string;
  completedProfiles: string[];
  results: RouteMatrixResult[];
}

interface RouteMatrixRunnerDeps {
  execNode?: (args: string[]) => Promise<void>;
  appendExecutionJournal?: typeof appendExecutionJournal;
  now?: () => Date;
}

const RouteMatrixCheckpointStateSchema: z.ZodType<RouteMatrixCheckpointState> = z.object({
  matrixId: z.string(),
  matrixConfig: z.string(),
  matrixConfigHash: z.string(),
  manifest: z.string(),
  manifestHash: z.string(),
  summaryOutput: z.string(),
  markdownOutput: z.string(),
  completedProfiles: z.array(z.string()),
  results: z.array(z.custom<RouteMatrixResult>((value) => isPlainObject(value))),
});

export async function runRouteMatrix(
  args: CliArgs,
  deps: RouteMatrixRunnerDeps = {},
): Promise<{
  summaryOutput: string;
  markdownOutput: string;
  recommendedProfile: string | null;
}> {
  const now = deps.now ?? (() => new Date());
  const executeNode = deps.execNode ?? execNode;
  const appendJournal = deps.appendExecutionJournal ?? appendExecutionJournal;
  const matrixConfigPath = resolve(args.matrixConfig);
  const matrixConfigRaw = await readFile(matrixConfigPath, "utf-8");
  const matrixConfigHash = hashString(matrixConfigRaw);
  const spec = JSON.parse(matrixConfigRaw) as RouteMatrixSpec;
  if (!spec.matrixId) {
    throw new Error("matrix config must include matrixId.");
  }
  if (!Array.isArray(spec.profiles) || spec.profiles.length === 0) {
    throw new Error("matrix config must include non-empty profiles.");
  }
  if (args.resume && args.fresh) {
    throw new Error("--resume and --fresh are mutually exclusive.");
  }
  const runId = args.runId
    ? safePathComponent(args.runId, { kind: "route matrix runId", maxLength: 128 })
    : buildDefaultRunId(spec, matrixConfigRaw);
  const summaryOutput =
    spec.summaryOutput ??
    `data/research/strategy/analysis/${sanitizeTag(spec.matrixId)}.json`;
  const markdownOutput =
    spec.markdownOutput ??
    `data/research/strategy/analysis/${sanitizeTag(spec.matrixId)}.md`;
  const checkpointStore = new RuntimeCheckpointStore({
    rootDir: args.checkpointRoot,
    namespace: "route_matrix",
  });
  if (args.fresh) {
    checkpointStore.clear(runId);
  }
  const checkpoint = checkpointStore.load(runId, RouteMatrixCheckpointStateSchema);
  if (checkpoint.ok) {
    if (!args.resume && !args.fresh) {
      throw new Error(
        [
          `Checkpoint exists for route matrix runId=${runId}.`,
          "Use --resume to continue or --fresh to discard it.",
        ].join(" ")
      );
    }
    if (!ROUTE_MATRIX_STEPS.has(checkpoint.checkpoint.step as RouteMatrixStep)) {
      throw new Error(
        `Cannot resume route matrix runId=${runId}: unknown checkpoint step ${checkpoint.checkpoint.step}.`
      );
    }
  } else if (args.resume) {
    const reason = checkpoint.diagnostic.kind === "missing"
      ? "checkpoint missing"
      : `checkpoint ${checkpoint.diagnostic.kind}`;
    throw new Error(`Cannot resume route matrix runId=${runId}: ${reason}.`);
  }
  const journalInputs = {
    matrixConfig: matrixConfigPath,
    matrixId: spec.matrixId,
    sourceId: spec.sourceId ?? null,
    manifest: resolve(spec.manifest),
    defaultMultipleTestingUnit: spec.defaultMultipleTestingUnit ?? null,
  };
  const journalOutputs = {
    summary: resolve(summaryOutput),
    markdown: resolve(markdownOutput),
  };
  await appendJournal({
    runId,
    batchId: spec.matrixId,
    stage: "matrix",
    action: "matrix",
    status: "started",
    inputs: journalInputs,
    outputs: journalOutputs,
    decision: "started",
    codeRefs: ["scripts/run_route_matrix.ts", "scripts/run_route_af.ts"],
  });

  try {
    const manifestPath = resolve(spec.manifest);
    const baseManifestRaw = await readFile(manifestPath, "utf-8");
    const manifestHash = hashString(baseManifestRaw);
    const baseManifest = JSON.parse(baseManifestRaw) as RouteManifest;
    const tmpRoot = await mkdtemp(join(tmpdir(), "openalice-route-matrix-"));
    const resumeState = checkpoint.ok ? checkpoint.checkpoint.state : null;
    if (resumeState) {
      validateResumeState({
        runId,
        state: resumeState,
        matrixId: spec.matrixId,
        matrixConfigHash,
        manifest: manifestPath,
        manifestHash,
        summaryOutput: resolve(summaryOutput),
        markdownOutput: resolve(markdownOutput),
      });
    }
    const results: RouteMatrixResult[] = resumeState?.results ?? [];
    const completedProfiles = new Set(resumeState?.completedProfiles ?? []);
    checkpointStore.save<RouteMatrixCheckpointState>({
      runId,
      step: "loaded_inputs",
      now: now(),
      state: {
        matrixId: spec.matrixId,
        matrixConfig: matrixConfigPath,
        matrixConfigHash,
        manifest: manifestPath,
        manifestHash,
        summaryOutput: resolve(summaryOutput),
        markdownOutput: resolve(markdownOutput),
        completedProfiles: Array.from(completedProfiles),
        results,
      },
    });

  for (const profile of spec.profiles) {
    if (completedProfiles.has(profile.id)) {
      continue;
    }
    const tag = sanitizeTag(`${spec.matrixId}.${profile.id}`);
    const multipleTestingUnit =
      profile.multipleTestingUnit ??
      spec.defaultMultipleTestingUnit ??
      ((baseManifest.significance?.multipleTestingUnit as MultipleTestingUnit | undefined) ??
        "candidate");

    const manifest = deepMerge(baseManifest, profile.overrides ?? {});
    manifest.generatedAt = now().toISOString();
    manifest.batchId = tag;
    manifest.notes = [
      ...(Array.isArray(baseManifest.notes) ? baseManifest.notes : []),
      `matrix_id=${spec.matrixId}`,
      `protocol_profile=${profile.id}`,
      `source_id=${profile.sourceId ?? spec.sourceId ?? "unknown"}`,
      `multiple_testing_unit=${multipleTestingUnit}`,
      ...(profile.notes ?? []),
    ];
    manifest.significance = {
      ...(manifest.significance ?? {}),
      multipleTestingUnit,
    };

    const tempManifestPath = resolve(tmpRoot, `${tag}.manifest.json`);
    await writeFile(tempManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

    const outputs = {
      manifest: tempManifestPath,
      validationRuns: resolve(`data/research/strategy/strategy_validation_runs.${tag}.json`),
      verdict: resolve(`data/research/strategy/experiment_verdict.${tag}.json`),
      releaseGateStatus: resolve(`data/runtime/release_gate_status.${tag}.json`),
      status: resolve(`data/runtime/route_af_status.${tag}.latest.json`),
      phaseReadiness: resolve(`data/runtime/phase_readiness.${tag}.latest.json`),
    };

    await executeNode([
      "--import",
      "tsx",
      "./scripts/run_route_af.ts",
      "--candidates",
      tempManifestPath,
      "--tag",
      tag,
      "--multiple-testing-unit",
      multipleTestingUnit,
      "--source-id",
      profile.sourceId ?? spec.sourceId ?? "unknown",
      "--protocol-profile",
      profile.id,
      ...(profile.fdrMethod ? ["--fdr-method", profile.fdrMethod] : []),
      ...(profile.wfoProfile ? ["--wfo-profile", profile.wfoProfile] : []),
      ...(profile.storeyLambda !== undefined
        ? ["--storey-lambda", String(profile.storeyLambda)]
        : []),
      ...(profile.cvAggQuantile !== undefined
        ? ["--cv-agg-quantile", String(profile.cvAggQuantile)]
        : []),
      "--statusOutput",
      outputs.status,
      "--phaseReadinessOutput",
      outputs.phaseReadiness,
    ]);

    const [verdict, runs] = await Promise.all([
      readJson<Record<string, unknown>>(outputs.verdict),
      readJson<Record<string, unknown>>(outputs.validationRuns),
    ]);
    const result = buildResult({
      profile,
      sourceId: profile.sourceId ?? spec.sourceId ?? null,
      multipleTestingUnit,
      fdrMethod: profile.fdrMethod ?? null,
      wfoProfile: profile.wfoProfile ?? null,
      verdict,
      runs,
      outputs,
    });
    results.push(result);
    completedProfiles.add(profile.id);
    checkpointStore.save<RouteMatrixCheckpointState>({
      runId,
      step: "profile_completed",
      now: now(),
      state: {
        matrixId: spec.matrixId,
        matrixConfig: matrixConfigPath,
        matrixConfigHash,
        manifest: manifestPath,
        manifestHash,
        summaryOutput: resolve(summaryOutput),
        markdownOutput: resolve(markdownOutput),
        completedProfiles: Array.from(completedProfiles),
        results,
      },
    });
  }

  const recommendedProfile = rankProfiles(results)[0]?.profile ?? null;
  const payload = {
    schemaVersion: "route_matrix_result.v1",
    matrixId: spec.matrixId,
    generatedAt: now().toISOString(),
    sourceId: spec.sourceId ?? null,
    baseManifest: resolve(spec.manifest),
    rankingObjective:
      spec.rankingObjective ??
      "min(hardGap.totalGap) -> min(wfoFailureDensity) -> min(hardGap.fdrGap) -> max(meanSharpe)",
    summary: {
      profileCount: results.length,
      validProfiles: results.filter((item) => item.aggregateMetrics !== null).length,
      goProfiles: results.filter((item) => item.result === "GO").length,
    },
    recommendedProfile,
    profiles: results,
    rankedProfiles: rankProfiles(results),
  };

    await mkdir(dirname(resolve(summaryOutput)), { recursive: true });
    await Promise.all([
      writeFile(resolve(summaryOutput), `${JSON.stringify(payload, null, 2)}\n`, "utf-8"),
      writeFile(resolve(markdownOutput), renderMarkdown(payload), "utf-8"),
    ]);

    checkpointStore.save<RouteMatrixCheckpointState>({
      runId,
      step: "wrote_outputs",
      now: now(),
      state: {
        matrixId: spec.matrixId,
        matrixConfig: matrixConfigPath,
        matrixConfigHash,
        manifest: manifestPath,
        manifestHash,
        summaryOutput: resolve(summaryOutput),
        markdownOutput: resolve(markdownOutput),
        completedProfiles: Array.from(completedProfiles),
        results,
      },
    });
    checkpointStore.clear(runId);

    await appendJournal({
      runId,
      batchId: spec.matrixId,
      stage: "matrix",
      action: "matrix",
      status: "completed",
      inputs: journalInputs,
      outputs: journalOutputs,
      summaryMetrics: extractSummaryMetrics(payload),
      decision: recommendedProfile === null ? "failed" : "promoted_to_matrix",
      codeRefs: ["scripts/run_route_matrix.ts", "scripts/run_route_af.ts"],
    });

    console.log(
      [
        `summary=${resolve(summaryOutput)}`,
        `markdown=${resolve(markdownOutput)}`,
        `recommendedProfile=${recommendedProfile ?? "none"}`,
      ].join(" | ")
    );
    return {
      summaryOutput: resolve(summaryOutput),
      markdownOutput: resolve(markdownOutput),
      recommendedProfile,
    };
  } catch (error) {
    await appendJournal({
      runId,
      batchId: spec.matrixId,
      stage: "matrix",
      action: "matrix",
      status: "failed",
      inputs: journalInputs,
      outputs: journalOutputs,
      decision: "failed",
      codeRefs: ["scripts/run_route_matrix.ts", "scripts/run_route_af.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

export async function main(): Promise<void> {
  await runRouteMatrix(parseArgs(process.argv.slice(2)));
}

export function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const matrixConfig = raw.get("matrix-config");
  if (!matrixConfig) {
    throw new Error("--matrix-config is required.");
  }
  const resume = raw.get("resume") === "true";
  const fresh = raw.get("fresh") === "true";
  if (resume && fresh) {
    throw new Error("--resume and --fresh are mutually exclusive.");
  }
  return {
    matrixConfig,
    resume,
    fresh,
    runId: normalizeOptionalString(raw.get("run-id") ?? raw.get("runId")),
    checkpointRoot: normalizeOptionalString(raw.get("checkpoint-root") ?? raw.get("checkpointRoot")),
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
    out.set(key, next);
    i += 1;
  }
  return out;
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf-8");
  return JSON.parse(raw) as T;
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override as T) ?? base;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
      continue;
    }
    out[key] = value;
  }
  return out as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function execNode(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0 || code === 2) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Command failed with exit code ${code ?? "unknown"}`));
    });
  });
}

function buildResult(input: {
  profile: MatrixProfileSpec;
  sourceId: string | null;
  multipleTestingUnit: MultipleTestingUnit;
  fdrMethod: string | null;
  wfoProfile: string | null;
  verdict: Record<string, unknown>;
  runs: Record<string, unknown>;
  outputs: RouteMatrixResult["outputs"];
}): RouteMatrixResult {
  const aggregateMetrics = isPlainObject(input.verdict.aggregateMetrics)
    ? input.verdict.aggregateMetrics
    : null;
  const thresholds = isPlainObject(input.verdict.thresholds)
    ? input.verdict.thresholds
    : null;
  return {
    profile: input.profile.id,
    sourceId: input.sourceId,
    multipleTestingUnit: input.multipleTestingUnit,
    fdrMethod:
      input.fdrMethod ??
      (typeof aggregateMetrics?.fdrMethod === "string" ? aggregateMetrics.fdrMethod : null),
    wfoProfile:
      input.wfoProfile ??
      (typeof aggregateMetrics?.wfoProfile === "string" ? aggregateMetrics.wfoProfile : null),
    result: typeof input.verdict.result === "string" ? input.verdict.result : null,
    reasonCodes: Array.isArray(input.verdict.reasonCodes)
      ? input.verdict.reasonCodes.filter((item): item is string => typeof item === "string")
      : [],
    baseAggregateMetrics: extractBaseAggregateMetrics(input.runs),
    aggregateMetrics,
    hardGap: buildHardGap(aggregateMetrics, thresholds),
    wfoFailureDensity: computeWfoFailureDensity(input.runs),
    meanSharpe: computeMeanSharpe(input.runs),
    outputs: input.outputs,
  };
}

function extractBaseAggregateMetrics(runs: Record<string, unknown>) {
  return isPlainObject(runs.aggregateMetrics) ? runs.aggregateMetrics : null;
}

function buildHardGap(
  aggregateMetrics: Record<string, unknown> | null,
  thresholds: Record<string, unknown> | null
) {
  if (!aggregateMetrics || !thresholds) {
    return null;
  }
  const meanPbo = toFiniteNumber(aggregateMetrics.meanPbo);
  const meanDsr = toFiniteNumber(aggregateMetrics.meanDsrProbability);
  const fdrQ = toFiniteNumber(aggregateMetrics.fdrQ);
  const pboMax = toFiniteNumber(thresholds.meanPboMax);
  const dsrMin = toFiniteNumber(thresholds.meanDsrProbabilityMin);
  const fdrMax = toFiniteNumber(thresholds.fdrQMax);
  if (
    meanPbo === null ||
    meanDsr === null ||
    fdrQ === null ||
    pboMax === null ||
    dsrMin === null ||
    fdrMax === null
  ) {
    return null;
  }
  const pboGap = Math.max(meanPbo - pboMax, 0);
  const dsrGap = Math.max(dsrMin - meanDsr, 0);
  const fdrGap = Math.max(fdrQ - fdrMax, 0);
  return {
    pboGap: round6(pboGap),
    dsrGap: round6(dsrGap),
    fdrGap: round6(fdrGap),
    totalGap: round6(pboGap + dsrGap + fdrGap),
  };
}

function computeWfoFailureDensity(runs: Record<string, unknown>): number | null {
  const symbols = Array.isArray(runs.symbols) ? runs.symbols : [];
  const values: number[] = [];
  for (const symbol of symbols) {
    if (!isPlainObject(symbol) || !Array.isArray(symbol.candidates)) {
      continue;
    }
    for (const candidate of symbol.candidates) {
      if (!isPlainObject(candidate) || !isPlainObject(candidate.releaseGate)) {
        continue;
      }
      const checks = Array.isArray(candidate.releaseGate.checks)
        ? candidate.releaseGate.checks
        : [];
      const wfo = checks.find(
        (check) => isPlainObject(check) && check.name === "wfo"
      ) as Record<string, unknown> | undefined;
      const metrics = isPlainObject(wfo?.metrics) ? wfo.metrics : null;
      const failedWindowRatio = metrics ? toFiniteNumber(metrics.failedWindowRatio) : null;
      if (failedWindowRatio !== null) {
        values.push(failedWindowRatio);
      }
    }
  }
  return values.length > 0 ? round6(mean(values)) : null;
}

function computeMeanSharpe(runs: Record<string, unknown>): number | null {
  const symbols = Array.isArray(runs.symbols) ? runs.symbols : [];
  const values: number[] = [];
  for (const symbol of symbols) {
    if (!isPlainObject(symbol) || !Array.isArray(symbol.candidates)) {
      continue;
    }
    for (const candidate of symbol.candidates) {
      if (!isPlainObject(candidate) || !isPlainObject(candidate.backtestMetrics)) {
        continue;
      }
      const sharpe = toFiniteNumber(candidate.backtestMetrics.sharpe);
      if (sharpe !== null) {
        values.push(sharpe);
      }
    }
  }
  return values.length > 0 ? round6(mean(values)) : null;
}

function toFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function rankProfiles(results: RouteMatrixResult[]): RouteMatrixResult[] {
  return [...results].sort((left, right) => {
    const leftGap = left.hardGap?.totalGap ?? Number.POSITIVE_INFINITY;
    const rightGap = right.hardGap?.totalGap ?? Number.POSITIVE_INFINITY;
    if (leftGap !== rightGap) {
      return leftGap - rightGap;
    }
    const leftWfo = left.wfoFailureDensity ?? Number.POSITIVE_INFINITY;
    const rightWfo = right.wfoFailureDensity ?? Number.POSITIVE_INFINITY;
    if (leftWfo !== rightWfo) {
      return leftWfo - rightWfo;
    }
    const leftFdr = left.hardGap?.fdrGap ?? Number.POSITIVE_INFINITY;
    const rightFdr = right.hardGap?.fdrGap ?? Number.POSITIVE_INFINITY;
    if (leftFdr !== rightFdr) {
      return leftFdr - rightFdr;
    }
    return (right.meanSharpe ?? Number.NEGATIVE_INFINITY) - (left.meanSharpe ?? Number.NEGATIVE_INFINITY);
  });
}

function sanitizeTag(value: string): string {
  return safePathComponent(value.replace(/[^a-zA-Z0-9._-]+/g, "_"), {
    kind: "runtime tag",
    maxLength: 128,
  });
}

function buildDefaultRunId(spec: RouteMatrixSpec, matrixConfigRaw: string): string {
  const configHash = hashString(matrixConfigRaw).slice(0, 12);
  return sanitizeTag([
    spec.matrixId,
    spec.sourceId ?? "source",
    String(spec.profiles.length),
    configHash,
  ].join("."));
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateResumeState(input: {
  runId: string;
  state: RouteMatrixCheckpointState;
  matrixId: string;
  matrixConfigHash: string;
  manifest: string;
  manifestHash: string;
  summaryOutput: string;
  markdownOutput: string;
}): void {
  const mismatches = [
    input.state.matrixId === input.matrixId ? null : "matrixId",
    input.state.matrixConfigHash === input.matrixConfigHash ? null : "matrixConfigHash",
    input.state.manifest === input.manifest ? null : "manifest",
    input.state.manifestHash === input.manifestHash ? null : "manifestHash",
    input.state.summaryOutput === input.summaryOutput ? null : "summaryOutput",
    input.state.markdownOutput === input.markdownOutput ? null : "markdownOutput",
  ].filter((item): item is string => item !== null);
  if (mismatches.length > 0) {
    throw new Error(
      `Cannot resume route matrix runId=${input.runId}: checkpoint does not match current config (${mismatches.join(", ")}).`
    );
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function renderMarkdown(payload: {
  matrixId: string;
  generatedAt: string;
  sourceId: string | null;
  recommendedProfile: string | null;
  profiles: RouteMatrixResult[];
}) {
  const lines = [
    `# Route Matrix ${payload.matrixId}`,
    "",
    `- generatedAt: ${payload.generatedAt}`,
    `- sourceId: ${payload.sourceId ?? "unknown"}`,
    `- recommendedProfile: ${payload.recommendedProfile ?? "none"}`,
    "",
    "| profile | result | multipleTestingUnit | fdrMethod | wfoProfile | totalGap | fdrGap | wfoFailureDensity | meanSharpe |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of payload.profiles) {
    lines.push(
      `| ${item.profile} | ${item.result ?? "unknown"} | ${item.multipleTestingUnit} | ${item.fdrMethod ?? "bh"} | ${item.wfoProfile ?? "stable"} | ${item.hardGap?.totalGap ?? "n/a"} | ${item.hardGap?.fdrGap ?? "n/a"} | ${item.wfoFailureDensity ?? "n/a"} | ${item.meanSharpe ?? "n/a"} |`
    );
    lines.push(
      `| reasons | ${item.reasonCodes.join(", ") || "none"} | metrics | ${JSON.stringify(item.aggregateMetrics ?? {})} | baseMetrics | ${JSON.stringify(item.baseAggregateMetrics ?? {})} | |`
    );
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error("run_route_matrix failed:", error);
    process.exit(1);
  });
}
