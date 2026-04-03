import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  appendExecutionJournal,
  extractSummaryMetrics,
  sanitizeError,
} from "./lib/execution_journal.js";

type MultipleTestingUnit = "candidate" | "family";

interface TrialCandidate {
  strategyId?: string;
  strategyName?: string;
  strategy?: string;
  params?: Record<string, unknown>;
}

interface TrialRecord {
  trial?: number;
  template?: string[];
  candidates?: TrialCandidate[];
}

interface SearchPayload {
  run_id?: string;
  allTrials?: TrialRecord[];
}

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

interface SweepResult {
  trial: number;
  template: string[];
  sourceId: string;
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
  searchJson: string;
  baseManifest: string;
  overrideJson?: string;
  sweepId: string;
  symbol: string;
  inputCsv?: string;
  lookbackBars?: number;
  sourceId?: string;
  protocolProfile?: string;
  multipleTestingUnit?: MultipleTestingUnit;
  fdrMethod?: "bh" | "by" | "cv_storey_bh" | "stepc" | "spa";
  wfoProfile?: "stable" | "shift" | "stress";
  storeyLambda?: number;
  cvAggQuantile?: number;
  trialList?: number[];
  summaryOutput?: string;
  markdownOutput?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `${sanitizeTag(args.sweepId)}.${new Date().toISOString().replace(/[:.]/g, "")}`;
  const summaryOutput =
    args.summaryOutput ??
    `data/research/strategy/analysis/${sanitizeTag(args.sweepId)}.json`;
  const markdownOutput =
    args.markdownOutput ??
    `data/research/strategy/analysis/${sanitizeTag(args.sweepId)}.md`;
  const journalInputs = {
    searchJson: resolve(args.searchJson),
    baseManifest: resolve(args.baseManifest),
    overrideJson: args.overrideJson ? resolve(args.overrideJson) : null,
    sweepId: args.sweepId,
    symbol: args.symbol,
    sourceId: args.sourceId ?? null,
    protocolProfile: args.protocolProfile ?? null,
    multipleTestingUnit: args.multipleTestingUnit ?? null,
    fdrMethod: args.fdrMethod ?? "bh",
    wfoProfile: args.wfoProfile ?? "stable",
    trialList: args.trialList ?? null,
  };
  const journalOutputs = {
    summary: resolve(summaryOutput),
    markdown: resolve(markdownOutput),
  };

  await appendExecutionJournal({
    runId,
    batchId: args.sweepId,
    stage: "sweep",
    action: "sweep",
    status: "started",
    inputs: journalInputs,
    outputs: journalOutputs,
    decision: "started",
    codeRefs: ["scripts/run_phaseb_trial_sweep.ts", "scripts/run_route_af.ts"],
  });

  try {
    const [searchPayload, baseManifest, manifestOverride] = await Promise.all([
      readJson<SearchPayload>(args.searchJson),
      readJson<RouteManifest>(args.baseManifest),
      args.overrideJson
        ? readJson<Partial<RouteManifest>>(args.overrideJson)
        : Promise.resolve(null),
    ]);

  const allTrials = Array.isArray(searchPayload.allTrials) ? searchPayload.allTrials : [];
  if (allTrials.length === 0) {
    throw new Error(`No allTrials found in ${args.searchJson}`);
  }

  const targetTrials = filterTrials(allTrials, args.trialList);
  if (targetTrials.length === 0) {
    throw new Error("No trials selected for sweep.");
  }

  const resolvedBaseManifest = manifestOverride
    ? deepMerge(baseManifest, manifestOverride)
    : baseManifest;
  const dataset = buildDataset(resolvedBaseManifest.dataset, args);
  const multipleTestingUnit =
    args.multipleTestingUnit ??
    (((resolvedBaseManifest.significance?.multipleTestingUnit as MultipleTestingUnit | undefined) ??
      "candidate"));
  const protocolProfile =
    args.protocolProfile ?? normalizeOptionalString(args.sweepId) ?? "phaseb_sweep";
  const tmpRoot = await mkdtemp(join(tmpdir(), "openalice-phaseb-trial-sweep-"));

  const results: SweepResult[] = [];
  for (const trial of targetTrials) {
    if (!Array.isArray(trial.candidates) || trial.candidates.length === 0) {
      continue;
    }
    const trialNumber = trial.trial ?? -1;
    const sourceId =
      args.sourceId ??
      `${searchPayload.run_id ?? "phaseb"}:trial${String(trialNumber).padStart(3, "0")}`;
    const tag = sanitizeTag(`${args.sweepId}.trial_${String(trialNumber).padStart(3, "0")}`);
    const manifest: RouteManifest = {
      ...resolvedBaseManifest,
      generatedAt: new Date().toISOString(),
      batchId: tag,
      batchGoal:
        resolvedBaseManifest.batchGoal ??
        `Sweep phase-B trial ${trialNumber} for ${args.symbol} under ${protocolProfile}.`,
      notes: [
        ...(Array.isArray(resolvedBaseManifest.notes) ? resolvedBaseManifest.notes : []),
        `sweep_id=${args.sweepId}`,
        `source_run_id=${searchPayload.run_id ?? "unknown"}`,
        `source_trial=${trialNumber}`,
        `source_template=${(trial.template ?? []).join("+") || "unknown"}`,
        `source_id=${sourceId}`,
        `protocol_profile=${protocolProfile}`,
        `multiple_testing_unit=${multipleTestingUnit}`,
      ],
      dataset,
      significance: {
        ...(resolvedBaseManifest.significance ?? {}),
        multipleTestingUnit,
      },
      candidates: trial.candidates.map((candidate, index) =>
        materializeCandidate(candidate, args.symbol, trialNumber, index)
      ),
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

    await execNodeQuiet([
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
      sourceId,
      "--protocol-profile",
      protocolProfile,
      ...(args.fdrMethod ? ["--fdr-method", args.fdrMethod] : []),
      ...(args.wfoProfile ? ["--wfo-profile", args.wfoProfile] : []),
      ...(args.storeyLambda !== undefined
        ? ["--storey-lambda", String(args.storeyLambda)]
        : []),
      ...(args.cvAggQuantile !== undefined
        ? ["--cv-agg-quantile", String(args.cvAggQuantile)]
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
      trial: trialNumber,
      template: Array.isArray(trial.template) ? trial.template : [],
      sourceId,
      verdict,
      runs,
      outputs,
    });
    results.push(result);

    console.log(
      [
        `trial=${trialNumber}`,
        `template=${result.template.join("+") || "unknown"}`,
        `result=${result.result ?? "unknown"}`,
        `totalGap=${result.hardGap?.totalGap ?? "n/a"}`,
        `wfoFailureDensity=${result.wfoFailureDensity ?? "n/a"}`,
        `meanSharpe=${result.meanSharpe ?? "n/a"}`,
      ].join(" | ")
    );
  }

  const rankedTrials = rankResults(results);
  const recommendedTrial = rankedTrials[0]?.trial ?? null;
  const payload = {
    schemaVersion: "phaseb_trial_sweep_result.v1",
    sweepId: args.sweepId,
    generatedAt: new Date().toISOString(),
    sourceRunId: searchPayload.run_id ?? null,
    sourceId: args.sourceId ?? null,
    protocolProfile,
    fdrMethod: args.fdrMethod ?? "bh",
    wfoProfile: args.wfoProfile ?? "stable",
    symbol: args.symbol,
    dataset,
    trialCount: results.length,
    recommendedTrial,
    rankedTrials,
    trials: results,
  };

    await mkdir(dirname(resolve(summaryOutput)), { recursive: true });
    await Promise.all([
      writeFile(resolve(summaryOutput), `${JSON.stringify(payload, null, 2)}\n`, "utf-8"),
      writeFile(resolve(markdownOutput), renderMarkdown(payload), "utf-8"),
    ]);

    await appendExecutionJournal({
      runId,
      batchId: args.sweepId,
      stage: "sweep",
      action: "sweep",
      status: "completed",
      inputs: journalInputs,
      outputs: journalOutputs,
      summaryMetrics: extractSummaryMetrics(payload),
      decision: recommendedTrial === null ? "failed" : "completed",
      codeRefs: ["scripts/run_phaseb_trial_sweep.ts", "scripts/run_route_af.ts"],
    });

    console.log(
      [
        `summary=${resolve(summaryOutput)}`,
        `markdown=${resolve(markdownOutput)}`,
        `recommendedTrial=${recommendedTrial ?? "none"}`,
      ].join(" | ")
    );
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: args.sweepId,
      stage: "sweep",
      action: "sweep",
      status: "failed",
      inputs: journalInputs,
      outputs: journalOutputs,
      decision: "failed",
      codeRefs: ["scripts/run_phaseb_trial_sweep.ts", "scripts/run_route_af.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const searchJson = raw.get("search-json");
  const baseManifest = raw.get("base-manifest");
  const overrideJson = raw.get("override-json");
  const sweepId = raw.get("sweep-id");
  const symbol = raw.get("symbol");
  if (!searchJson) throw new Error("--search-json is required.");
  if (!baseManifest) throw new Error("--base-manifest is required.");
  if (!sweepId) throw new Error("--sweep-id is required.");
  if (!symbol) throw new Error("--symbol is required.");

  const trialListRaw = normalizeOptionalString(
    raw.get("trial-list") ?? raw.get("trials")
  );
  const trialList = trialListRaw
    ? trialListRaw
        .split(",")
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isInteger(item) && item >= 0)
    : undefined;
  const lookbackBarsRaw = raw.get("lookback-bars") ?? raw.get("lookbackBars");
  const lookbackBars =
    lookbackBarsRaw && Number.isInteger(Number(lookbackBarsRaw))
      ? Number(lookbackBarsRaw)
      : undefined;

  return {
    searchJson,
    baseManifest,
    overrideJson: normalizeOptionalString(overrideJson),
    sweepId,
    symbol,
    inputCsv: normalizeOptionalString(raw.get("input-csv") ?? raw.get("inputCsv")),
    lookbackBars,
    sourceId: normalizeOptionalString(raw.get("source-id") ?? raw.get("sourceId")),
    protocolProfile: normalizeOptionalString(
      raw.get("protocol-profile") ?? raw.get("protocolProfile")
    ),
    fdrMethod:
      raw.get("fdr-method") === "by" ||
      raw.get("fdr-method") === "cv_storey_bh" ||
      raw.get("fdr-method") === "stepc" ||
      raw.get("fdr-method") === "spa"
        ? (raw.get("fdr-method") as
            | "by"
            | "cv_storey_bh"
            | "stepc"
            | "spa")
        : raw.get("fdr-method") === "bh"
          ? "bh"
          : undefined,
    wfoProfile:
      raw.get("wfo-profile") === "shift" ||
      raw.get("wfo-profile") === "stress" ||
      raw.get("wfo-profile") === "stable"
        ? (raw.get("wfo-profile") as "stable" | "shift" | "stress")
        : undefined,
    storeyLambda: parseOptionalNumber(raw.get("storey-lambda")),
    cvAggQuantile: parseOptionalNumber(raw.get("cv-agg-quantile")),
    multipleTestingUnit:
      raw.get("multiple-testing-unit") === "family" ? "family" : "candidate",
    trialList,
    summaryOutput: normalizeOptionalString(raw.get("summary-output")),
    markdownOutput: normalizeOptionalString(raw.get("markdown-output")),
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

function filterTrials(allTrials: TrialRecord[], trialList?: number[]) {
  if (!trialList || trialList.length === 0) {
    return allTrials.filter((item) => Number.isInteger(item.trial));
  }
  const wanted = new Set(trialList);
  return allTrials.filter((item) => Number.isInteger(item.trial) && wanted.has(item.trial!));
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

function buildDataset(base: Record<string, unknown> | undefined, args: CliArgs) {
  const baseLookback = toPositiveInt(base?.lookbackBars) ?? 3000;
  return {
    ...(base ?? {}),
    inputCsv: args.inputCsv ?? normalizeString(base?.inputCsv, ""),
    symbol: args.symbol,
    lookbackBars: args.lookbackBars ?? baseLookback,
  };
}

function materializeCandidate(
  candidate: TrialCandidate,
  symbol: string,
  trialNumber: number,
  index: number
) {
  const baseStrategyId = normalizeString(
    candidate.strategyId,
    `TRIAL${String(trialNumber).padStart(3, "0")}_${index + 1}`
  );
  return {
    strategyId: `${symbolToIdPrefix(symbol)}_${baseStrategyId}`,
    strategyName: normalizeString(candidate.strategyName, baseStrategyId),
    strategy: normalizeStrategy(candidate.strategy),
    applicableSymbols: [symbol],
    params: isPlainObject(candidate.params) ? candidate.params : {},
  };
}

function normalizeStrategy(value: unknown): string {
  const strategy = normalizeString(value, "trend");
  return strategy;
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf-8");
  return JSON.parse(raw) as T;
}

async function execNodeQuiet(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let stderr = "";
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => {
      // Intentionally suppress child stdout; sweep prints its own compact progress lines.
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0 || code === 2) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`Command failed with exit code ${code ?? "unknown"}${stderr ? `: ${stderr}` : ""}`)
      );
    });
  });
}

function buildResult(input: {
  trial: number;
  template: string[];
  sourceId: string;
  verdict: Record<string, unknown>;
  runs: Record<string, unknown>;
  outputs: SweepResult["outputs"];
}): SweepResult {
  const aggregateMetrics = isPlainObject(input.verdict.aggregateMetrics)
    ? input.verdict.aggregateMetrics
    : null;
  const thresholds = isPlainObject(input.verdict.thresholds)
    ? input.verdict.thresholds
    : null;
  return {
    trial: input.trial,
    template: input.template,
    sourceId: input.sourceId,
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

function rankResults(results: SweepResult[]): SweepResult[] {
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

function renderMarkdown(payload: {
  sweepId: string;
  generatedAt: string;
  symbol: string;
  protocolProfile: string;
  fdrMethod?: string;
  wfoProfile?: string;
  recommendedTrial: number | null;
  rankedTrials: SweepResult[];
}) {
  const lines = [
    `# Phase-B Trial Sweep ${payload.sweepId}`,
    "",
    `- generatedAt: ${payload.generatedAt}`,
    `- symbol: ${payload.symbol}`,
    `- protocolProfile: ${payload.protocolProfile}`,
    `- fdrMethod: ${payload.fdrMethod ?? "bh"}`,
    `- wfoProfile: ${payload.wfoProfile ?? "stable"}`,
    `- recommendedTrial: ${payload.recommendedTrial ?? "none"}`,
    "",
    "| trial | template | result | totalGap | fdrGap | wfoFailureDensity | meanSharpe |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of payload.rankedTrials) {
    lines.push(
      `| ${item.trial} | ${item.template.join("+") || "unknown"} | ${item.result ?? "unknown"} | ${item.hardGap?.totalGap ?? "n/a"} | ${item.hardGap?.fdrGap ?? "n/a"} | ${item.wfoFailureDensity ?? "n/a"} | ${item.meanSharpe ?? "n/a"} |`
    );
    lines.push(
      `| reasons | ${item.reasonCodes.join(", ") || "none"} | metrics | ${JSON.stringify(item.aggregateMetrics ?? {})} | baseMetrics | ${JSON.stringify(item.baseAggregateMetrics ?? {})} | |`
    );
  }
  return `${lines.join("\n")}\n`;
}

function sanitizeTag(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function symbolToIdPrefix(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "SYMBOL";
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function toPositiveInt(value: unknown): number | null {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

main().catch((error) => {
  console.error("run_phaseb_trial_sweep failed:", error);
  process.exit(1);
});
