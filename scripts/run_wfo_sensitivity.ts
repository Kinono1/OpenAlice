import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { safePathComponent } from "../src/core/path-safety.js";
import {
  appendExecutionJournal,
  extractSummaryMetrics,
  sanitizeError,
} from "./lib/execution_journal.js";

type MultipleTestingUnit = "candidate" | "family";
type FdrMethod = "bh" | "by" | "cv_storey_bh" | "stepc" | "spa";

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

interface WfoSensitivityProfileSpec {
  id: string;
  sourceId?: string;
  multipleTestingUnit?: MultipleTestingUnit;
  fdrMethod?: FdrMethod;
  notes?: string[];
  overrides?: Partial<RouteManifest>;
}

interface WfoSensitivitySpec {
  schemaVersion?: string;
  sensitivityId: string;
  sourceId?: string;
  manifest: string;
  defaultMultipleTestingUnit?: MultipleTestingUnit;
  defaultFdrMethod?: FdrMethod;
  summaryOutput?: string;
  markdownOutput?: string;
  profiles: WfoSensitivityProfileSpec[];
}

interface CandidateWfoSummary {
  symbol: string;
  strategyId: string;
  strategyName: string;
  strategy: string;
  role: string | null;
  failedWindows: number | null;
  windowCount: number | null;
  failedWindowRatio: number | null;
  averageDegradation: number | null;
  tradeCountPerWindow: number[];
  medianTradesPerWindow: number | null;
  sharpe: number | null;
  pbo: number | null;
  dsrProbability: number | null;
  fdrQ: number | null;
  diagnosisHints: string[];
}

interface WfoSensitivityResult {
  profile: string;
  sourceId: string | null;
  multipleTestingUnit: MultipleTestingUnit;
  fdrMethod: FdrMethod;
  result: string | null;
  reasonCodes: string[];
  outputs: {
    manifest: string;
    validationRuns: string;
    verdict: string;
    releaseGateStatus: string;
    status: string;
    phaseReadiness: string;
  };
  candidates: CandidateWfoSummary[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const spec = await readJson<WfoSensitivitySpec>(args.config);
  if (!spec.sensitivityId) {
    throw new Error("wfo sensitivity config must include sensitivityId.");
  }
  if (!Array.isArray(spec.profiles) || spec.profiles.length < 1) {
    throw new Error("wfo sensitivity config must include at least one profile.");
  }

  const summaryOutput =
    spec.summaryOutput ??
    `data/research/strategy/analysis/${sanitizeTag(spec.sensitivityId)}.json`;
  const markdownOutput =
    spec.markdownOutput ??
    `data/research/strategy/analysis/${sanitizeTag(spec.sensitivityId)}.md`;
  const runId = `${sanitizeTag(spec.sensitivityId)}.${new Date().toISOString().replace(/[:.]/g, "")}`;
  const journalInputs = {
    config: resolve(args.config),
    sensitivityId: spec.sensitivityId,
    sourceId: spec.sourceId ?? null,
    manifest: resolve(spec.manifest),
  };
  const journalOutputs = {
    summary: resolve(summaryOutput),
    markdown: resolve(markdownOutput),
  };
  await appendExecutionJournal({
    runId,
    batchId: spec.sensitivityId,
    stage: "matrix",
    action: "wfo_sensitivity",
    status: "started",
    inputs: journalInputs,
    outputs: journalOutputs,
    decision: "started",
    codeRefs: ["scripts/run_wfo_sensitivity.ts", "scripts/run_route_af.ts"],
  });

  try {
    const baseManifest = await readJson<RouteManifest>(spec.manifest);
    const tmpRoot = await mkdtemp(join(tmpdir(), "openalice-wfo-sensitivity-"));

    const results: WfoSensitivityResult[] = [];
    for (const profile of spec.profiles) {
      const tag = sanitizeTag(`${spec.sensitivityId}.${profile.id}`);
      const multipleTestingUnit =
        profile.multipleTestingUnit ??
        spec.defaultMultipleTestingUnit ??
        ((baseManifest.significance?.multipleTestingUnit as MultipleTestingUnit | undefined) ??
          "candidate");
      const fdrMethod =
        profile.fdrMethod ??
        spec.defaultFdrMethod ??
        (((baseManifest.significance?.fdrMethod as FdrMethod | undefined) ?? "spa"));

      const manifest = deepMerge(baseManifest, profile.overrides ?? {});
      manifest.generatedAt = new Date().toISOString();
      manifest.batchId = tag;
      manifest.notes = [
        ...(Array.isArray(baseManifest.notes) ? baseManifest.notes : []),
        `wfo_sensitivity_id=${spec.sensitivityId}`,
        `wfo_profile=${profile.id}`,
        `source_id=${profile.sourceId ?? spec.sourceId ?? "unknown"}`,
        ...(profile.notes ?? []),
      ];
      manifest.significance = {
        ...(manifest.significance ?? {}),
        multipleTestingUnit,
        fdrMethod,
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

      await execNode([
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
        "--fdr-method",
        fdrMethod,
        "--statusOutput",
        outputs.status,
        "--phaseReadinessOutput",
        outputs.phaseReadiness,
      ]);

      const [runs, verdict] = await Promise.all([
        readJson<Record<string, unknown>>(outputs.validationRuns),
        readJson<Record<string, unknown>>(outputs.verdict),
      ]);

      results.push({
        profile: profile.id,
        sourceId: profile.sourceId ?? spec.sourceId ?? null,
        multipleTestingUnit,
        fdrMethod,
        result: typeof verdict.result === "string" ? verdict.result : null,
        reasonCodes: Array.isArray(verdict.reasonCodes)
          ? verdict.reasonCodes.filter((item): item is string => typeof item === "string")
          : [],
        outputs,
        candidates: extractCandidateWfoSummaries(runs),
      });
    }

    const payload = {
      schemaVersion: "wfo_sensitivity_result.v1",
      sensitivityId: spec.sensitivityId,
      generatedAt: new Date().toISOString(),
      sourceId: spec.sourceId ?? null,
      baseManifest: resolve(spec.manifest),
      profiles: results,
    };

    await mkdir(dirname(resolve(summaryOutput)), { recursive: true });
    await Promise.all([
      writeFile(resolve(summaryOutput), `${JSON.stringify(payload, null, 2)}\n`, "utf-8"),
      writeFile(resolve(markdownOutput), renderMarkdown(payload), "utf-8"),
    ]);

    await appendExecutionJournal({
      runId,
      batchId: spec.sensitivityId,
      stage: "matrix",
      action: "wfo_sensitivity",
      status: "completed",
      inputs: journalInputs,
      outputs: journalOutputs,
      summaryMetrics: extractSummaryMetrics(payload),
      decision: "completed",
      codeRefs: ["scripts/run_wfo_sensitivity.ts", "scripts/run_route_af.ts"],
    });

    console.log(
      [
        `summary=${resolve(summaryOutput)}`,
        `markdown=${resolve(markdownOutput)}`,
        `profiles=${results.length}`,
      ].join(" | "),
    );
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: spec.sensitivityId,
      stage: "matrix",
      action: "wfo_sensitivity",
      status: "failed",
      inputs: journalInputs,
      outputs: journalOutputs,
      decision: "failed",
      codeRefs: ["scripts/run_wfo_sensitivity.ts", "scripts/run_route_af.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

function extractCandidateWfoSummaries(runs: Record<string, unknown>): CandidateWfoSummary[] {
  const symbols = Array.isArray(runs.symbols) ? runs.symbols : [];
  const out: CandidateWfoSummary[] = [];
  for (const symbolPayload of symbols) {
    if (!isPlainObject(symbolPayload) || !Array.isArray(symbolPayload.candidates)) {
      continue;
    }
    const symbol = typeof symbolPayload.symbol === "string" ? symbolPayload.symbol : "unknown";
    for (const candidate of symbolPayload.candidates) {
      if (!isPlainObject(candidate)) {
        continue;
      }
      const windows = Array.isArray(candidate.wfo?.windows) ? candidate.wfo.windows : [];
      const tradeCountPerWindow = windows
        .map((window) => Number(window?.outOfSample?.tradeCount))
        .filter((value) => Number.isFinite(value));
      const failedWindowRatio = extractFailedWindowRatio(candidate.releaseGate);
      const averageDegradation = extractAverageDegradation(candidate.releaseGate);
      out.push({
        symbol,
        strategyId: String(candidate.strategyId ?? "unknown"),
        strategyName: String(candidate.strategyName ?? "unknown"),
        strategy: String(candidate.strategy ?? "unknown"),
        role: typeof candidate.role === "string" ? candidate.role : null,
        failedWindows: toFiniteNumber(candidate.wfo?.failedWindows),
        windowCount: toFiniteNumber(candidate.wfo?.windowCount),
        failedWindowRatio,
        averageDegradation,
        tradeCountPerWindow,
        medianTradesPerWindow:
          tradeCountPerWindow.length > 0 ? median(tradeCountPerWindow) : null,
        sharpe: toFiniteNumber(candidate.backtestMetrics?.sharpe),
        pbo: toFiniteNumber(candidate.significance?.pbo),
        dsrProbability: toFiniteNumber(candidate.significance?.dsrProbability),
        fdrQ: toFiniteNumber(candidate.fdr?.qValue),
        diagnosisHints: buildDiagnosisHints({
          failedWindowRatio,
          averageDegradation,
          medianTradesPerWindow:
            tradeCountPerWindow.length > 0 ? median(tradeCountPerWindow) : null,
        }),
      });
    }
  }
  return out;
}

function buildDiagnosisHints(input: {
  failedWindowRatio: number | null;
  averageDegradation: number | null;
  medianTradesPerWindow: number | null;
}): string[] {
  const out: string[] = [];
  if (input.medianTradesPerWindow !== null && input.medianTradesPerWindow < 3) {
    out.push("sample_too_sparse_for_stable_oos");
  }
  if (input.failedWindowRatio !== null && input.failedWindowRatio >= 0.5) {
    out.push("high_window_failure_density");
  }
  if (
    input.averageDegradation !== null &&
    Number.isFinite(input.averageDegradation) &&
    input.averageDegradation > 0.4
  ) {
    out.push("degradation_exceeds_release_gate_threshold");
  }
  return out;
}

function extractFailedWindowRatio(releaseGate: unknown): number | null {
  if (!isPlainObject(releaseGate) || !Array.isArray(releaseGate.checks)) {
    return null;
  }
  const wfoCheck = releaseGate.checks.find(
    (check) => isPlainObject(check) && check.name === "wfo",
  );
  return toFiniteNumber((wfoCheck as Record<string, unknown> | undefined)?.metrics?.failedWindowRatio);
}

function extractAverageDegradation(releaseGate: unknown): number | null {
  if (!isPlainObject(releaseGate) || !Array.isArray(releaseGate.checks)) {
    return null;
  }
  const wfoCheck = releaseGate.checks.find(
    (check) => isPlainObject(check) && check.name === "wfo",
  );
  return toFiniteNumber((wfoCheck as Record<string, unknown> | undefined)?.metrics?.averageDegradation);
}

function parseArgs(argv: string[]): { config: string } {
  const raw = parseRawArgs(argv);
  const config = raw.get("config");
  if (!config) {
    throw new Error("--config is required.");
  }
  return { config };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
    out.set(key, next);
    index += 1;
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

function isPlainObject(value: unknown): value is Record<string, any> {
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

function toFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function sanitizeTag(value: string): string {
  return safePathComponent(value.replace(/[^a-zA-Z0-9._-]+/g, "_"), {
    kind: "runtime tag",
    maxLength: 128,
  });
}

function renderMarkdown(payload: {
  sensitivityId: string;
  generatedAt: string;
  sourceId: string | null;
  profiles: WfoSensitivityResult[];
}) {
  const lines = [
    `# WFO Sensitivity ${payload.sensitivityId}`,
    "",
    `- generatedAt: ${payload.generatedAt}`,
    `- sourceId: ${payload.sourceId ?? "unknown"}`,
    "",
  ];

  for (const profile of payload.profiles) {
    lines.push(`## ${profile.profile}`, "");
    lines.push(
      "| strategyId | role | failedWindowRatio | avgDegradation | medianTradesPerWindow | sharpe | dsrProbability | fdrQ | hints |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const candidate of profile.candidates) {
      lines.push(
        `| ${candidate.strategyId} | ${candidate.role ?? "unknown"} | ${formatNumber(candidate.failedWindowRatio)} | ${formatNumber(candidate.averageDegradation)} | ${formatNumber(candidate.medianTradesPerWindow)} | ${formatNumber(candidate.sharpe)} | ${formatNumber(candidate.dsrProbability)} | ${formatNumber(candidate.fdrQ)} | ${candidate.diagnosisHints.join(", ") || "-"} |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function formatNumber(value: number | null): string {
  return value === null ? "-" : String(Number(value.toFixed(6)));
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
  process.exitCode = 1;
});
