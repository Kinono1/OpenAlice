import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import {
  appendExecutionJournal,
  extractSummaryMetrics,
  readJsonIfExists,
  sanitizeError,
} from "./lib/execution_journal.js";

interface RegistryPolicy {
  symbol: string;
  protocolProfile: string;
  multipleTestingUnit: "candidate" | "family";
  fdrMethod: "bh" | "by" | "cv_storey_bh" | "stepc" | "spa";
  wfoProfile: "stable" | "shift" | "stress";
  incumbentMetrics: {
    totalGap: number;
    fdrGap: number;
    wfoFailureDensity: number;
    meanSharpe: number;
  };
}

interface ParadigmSpec {
  paradigmId: string;
  donorRepo: string;
  compilerScript: string;
  inputArtifact: string;
  baseManifest: string;
  manifestOutput: string;
  provenanceOutput: string;
  noteOutput: string;
  routeTag: string;
  routeStatusOutput: string;
  phaseReadinessOutput: string;
  enabled?: boolean;
  candidateCap: number;
  promotionEligibility?: string;
}

interface RegistryPayload {
  schemaVersion?: string;
  comparisonId: string;
  policy: RegistryPolicy;
  summaryOutput?: string;
  markdownOutput?: string;
  paradigms: ParadigmSpec[];
}

interface ComparisonEntry {
  paradigmId: string;
  donorRepo: string;
  compilerStatus: "compiled" | "unavailable";
  routeStatus: "GO" | "NO_GO" | "UNAVAILABLE";
  candidateCount: number;
  summaryMetrics: ReturnType<typeof extractSummaryMetrics>;
  recommendation: "stop" | "refine" | "promote";
  manifestOutput: string;
  provenanceOutput: string;
  noteOutput: string;
  routeTag: string;
  verdictPath?: string;
  validationRunsPath?: string;
  reason?: string | null;
}

interface CliArgs {
  registry: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registry = await readJson<RegistryPayload>(args.registry);
  const summaryOutput =
    registry.summaryOutput ??
    `data/research/strategy/analysis/${registry.comparisonId}.json`;
  const markdownOutput =
    registry.markdownOutput ??
    `data/research/strategy/analysis/${registry.comparisonId}.md`;
  const runId = `${registry.comparisonId}.${new Date().toISOString().replace(/[:.]/g, "")}`;

  await appendExecutionJournal({
    runId,
    batchId: registry.comparisonId,
    stage: "comparison",
    action: "paradigm_comparison",
    status: "started",
    inputs: {
      registry: resolve(args.registry),
      paradigmCount: registry.paradigms.length,
      policy: registry.policy,
    },
    outputs: {
      summary: resolve(summaryOutput),
      markdown: resolve(markdownOutput),
    },
    decision: "started",
    codeRefs: ["scripts/run_btc_paradigm_comparison.ts"],
  });

  try {
    const results: ComparisonEntry[] = [];
    for (const paradigm of registry.paradigms.filter(item => item.enabled !== false)) {
      await execNode([
        "--import",
        "tsx",
        `./${paradigm.compilerScript.replace(/^\.\//, "")}`,
        "--input-json",
        paradigm.inputArtifact,
        "--base-manifest",
        paradigm.baseManifest,
        "--output",
        paradigm.manifestOutput,
        "--provenance-output",
        paradigm.provenanceOutput,
        "--note-output",
        paradigm.noteOutput,
        "--paradigm-id",
        paradigm.paradigmId,
        "--donor-repo",
        paradigm.donorRepo,
        "--source-id",
        paradigm.paradigmId,
        "--batch-id",
        paradigm.routeTag,
        "--batch-goal",
        `Materialize ${paradigm.paradigmId} BTC candidate family for fixed-policy route comparison.`,
        "--candidate-cap",
        String(paradigm.candidateCap),
      ]);

      const provenance = await readJson<Record<string, unknown>>(paradigm.provenanceOutput);
      const compilerStatus = provenance.status === "compiled" ? "compiled" : "unavailable";
      if (compilerStatus !== "compiled") {
        results.push({
          paradigmId: paradigm.paradigmId,
          donorRepo: paradigm.donorRepo,
          compilerStatus,
          routeStatus: "UNAVAILABLE",
          candidateCount: 0,
          summaryMetrics: extractSummaryMetrics(provenance),
          recommendation: "stop",
          manifestOutput: resolve(paradigm.manifestOutput),
          provenanceOutput: resolve(paradigm.provenanceOutput),
          noteOutput: resolve(paradigm.noteOutput),
          routeTag: paradigm.routeTag,
          reason: String(provenance.failureCode ?? "compiler_unavailable"),
        });
        continue;
      }

      await execNode([
        "--import",
        "tsx",
        "./scripts/run_route_af.ts",
        "--candidates",
        paradigm.manifestOutput,
        "--tag",
        paradigm.routeTag,
        "--source-id",
        paradigm.paradigmId,
        "--protocol-profile",
        registry.policy.protocolProfile,
        "--multiple-testing-unit",
        registry.policy.multipleTestingUnit,
        "--fdr-method",
        registry.policy.fdrMethod,
        "--wfo-profile",
        registry.policy.wfoProfile,
        "--statusOutput",
        paradigm.routeStatusOutput,
        "--phaseReadinessOutput",
        paradigm.phaseReadinessOutput,
      ]);

      const verdictPath = `data/research/strategy/experiment_verdict.${paradigm.routeTag}.json`;
      const validationRunsPath = `data/research/strategy/strategy_validation_runs.${paradigm.routeTag}.json`;
      const [verdict, validationRuns, manifest] = await Promise.all([
        readJson<Record<string, unknown>>(verdictPath),
        readJson<Record<string, unknown>>(validationRunsPath),
        readJson<{ candidates?: unknown[] }>(paradigm.manifestOutput),
      ]);
      const metrics = mergeMetrics(extractSummaryMetrics(verdict), extractSummaryMetrics(validationRuns));
      results.push({
        paradigmId: paradigm.paradigmId,
        donorRepo: paradigm.donorRepo,
        compilerStatus,
        routeStatus: verdict.result === "GO" ? "GO" : "NO_GO",
        candidateCount: Array.isArray(manifest.candidates) ? manifest.candidates.length : 0,
        summaryMetrics: metrics,
        recommendation: compareAgainstIncumbent(metrics, registry.policy.incumbentMetrics),
        manifestOutput: resolve(paradigm.manifestOutput),
        provenanceOutput: resolve(paradigm.provenanceOutput),
        noteOutput: resolve(paradigm.noteOutput),
        routeTag: paradigm.routeTag,
        verdictPath: resolve(verdictPath),
        validationRunsPath: resolve(validationRunsPath),
        reason: verdict.result === "GO" ? "route_go" : "route_no_go",
      });
    }

    const rankedParadigms = rankParadigms(results);
    const strongestParadigm = rankedParadigms[0] ?? null;
    const payload = {
      schemaVersion: "btc_paradigm_comparison.v1",
      generatedAt: new Date().toISOString(),
      comparisonId: registry.comparisonId,
      policy: registry.policy,
      strongestParadigmId: strongestParadigm?.paradigmId ?? null,
      recommendation: strongestParadigm?.recommendation ?? "stop",
      paradigms: results,
      rankedParadigms,
    };

    await mkdir(dirname(resolve(summaryOutput)), { recursive: true });
    await Promise.all([
      writeFile(resolve(summaryOutput), `${JSON.stringify(payload, null, 2)}\n`, "utf-8"),
      writeFile(resolve(markdownOutput), renderMarkdown(payload), "utf-8"),
    ]);

    await appendExecutionJournal({
      runId,
      batchId: registry.comparisonId,
      stage: "comparison",
      action: "paradigm_comparison",
      status: "completed",
      inputs: {
        registry: resolve(args.registry),
        policy: registry.policy,
      },
      outputs: {
        summary: resolve(summaryOutput),
        markdown: resolve(markdownOutput),
      },
      summaryMetrics: strongestParadigm?.summaryMetrics ?? {},
      decision: strongestParadigm?.recommendation ?? "stop",
      codeRefs: ["scripts/run_btc_paradigm_comparison.ts", "scripts/run_route_af.ts"],
    });

    console.log(
      [
        `summary=${resolve(summaryOutput)}`,
        `markdown=${resolve(markdownOutput)}`,
        `strongestParadigm=${strongestParadigm?.paradigmId ?? "none"}`,
        `recommendation=${strongestParadigm?.recommendation ?? "stop"}`,
      ].join(" | "),
    );
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: registry.comparisonId,
      stage: "comparison",
      action: "paradigm_comparison",
      status: "failed",
      inputs: {
        registry: resolve(args.registry),
      },
      outputs: {
        summary: resolve(summaryOutput),
        markdown: resolve(markdownOutput),
      },
      decision: "failed",
      codeRefs: ["scripts/run_btc_paradigm_comparison.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

function compareAgainstIncumbent(
  metrics: ReturnType<typeof extractSummaryMetrics>,
  incumbent: RegistryPolicy["incumbentMetrics"],
): "stop" | "refine" | "promote" {
  const totalGap = metrics.totalGap ?? Number.POSITIVE_INFINITY;
  const fdrGap = (metrics.fdrQ ?? 1) - 0.1;
  const wfo = metrics.wfoFailureDensity ?? Number.POSITIVE_INFINITY;
  const meanSharpe = metrics.meanSharpe ?? Number.NEGATIVE_INFINITY;

  const frontierCompetitive =
    totalGap < incumbent.totalGap ||
    (totalGap === incumbent.totalGap &&
      fdrGap <= incumbent.fdrGap &&
      wfo < incumbent.wfoFailureDensity);

  if (frontierCompetitive) {
    return "promote";
  }

  const nearMiss =
    totalGap <= incumbent.totalGap + 0.1 &&
    fdrGap <= incumbent.fdrGap + 0.1 &&
    wfo <= incumbent.wfoFailureDensity + 0.1 &&
    meanSharpe >= incumbent.meanSharpe - 0.3;

  return nearMiss ? "refine" : "stop";
}

function rankParadigms(results: ComparisonEntry[]): ComparisonEntry[] {
  return [...results].sort((left, right) => {
    const leftGap = left.summaryMetrics.totalGap ?? Number.POSITIVE_INFINITY;
    const rightGap = right.summaryMetrics.totalGap ?? Number.POSITIVE_INFINITY;
    if (leftGap !== rightGap) {
      return leftGap - rightGap;
    }
    const leftFdrGap = (left.summaryMetrics.fdrQ ?? 1) - 0.1;
    const rightFdrGap = (right.summaryMetrics.fdrQ ?? 1) - 0.1;
    if (leftFdrGap !== rightFdrGap) {
      return leftFdrGap - rightFdrGap;
    }
    const leftWfo = left.summaryMetrics.wfoFailureDensity ?? Number.POSITIVE_INFINITY;
    const rightWfo = right.summaryMetrics.wfoFailureDensity ?? Number.POSITIVE_INFINITY;
    if (leftWfo !== rightWfo) {
      return leftWfo - rightWfo;
    }
    const leftSharpe = left.summaryMetrics.meanSharpe ?? Number.NEGATIVE_INFINITY;
    const rightSharpe = right.summaryMetrics.meanSharpe ?? Number.NEGATIVE_INFINITY;
    if (leftSharpe !== rightSharpe) {
      return rightSharpe - leftSharpe;
    }
    const leftCorr =
      left.summaryMetrics.meanAverageAbsoluteCorrelation ?? Number.POSITIVE_INFINITY;
    const rightCorr =
      right.summaryMetrics.meanAverageAbsoluteCorrelation ?? Number.POSITIVE_INFINITY;
    return leftCorr - rightCorr;
  });
}

function mergeMetrics(
  primary: ReturnType<typeof extractSummaryMetrics>,
  secondary: ReturnType<typeof extractSummaryMetrics>,
) {
  return {
    meanPbo: primary.meanPbo ?? secondary.meanPbo ?? null,
    meanDsrProbability: primary.meanDsrProbability ?? secondary.meanDsrProbability ?? null,
    fdrQ: primary.fdrQ ?? secondary.fdrQ ?? null,
    wfoFailureDensity:
      primary.wfoFailureDensity ?? secondary.wfoFailureDensity ?? null,
    totalGap: primary.totalGap ?? secondary.totalGap ?? null,
    meanSharpe: primary.meanSharpe ?? secondary.meanSharpe ?? null,
    meanAverageAbsoluteCorrelation:
      secondary.meanAverageAbsoluteCorrelation ?? primary.meanAverageAbsoluteCorrelation ?? null,
    maxAbsoluteCorrelation:
      secondary.maxAbsoluteCorrelation ?? primary.maxAbsoluteCorrelation ?? null,
  };
}

function renderMarkdown(payload: {
  comparisonId: string;
  strongestParadigmId: string | null;
  recommendation: string;
  paradigms: ComparisonEntry[];
}) {
  const lines = [
    `# BTC Paradigm Comparison ${payload.comparisonId}`,
    "",
    `- strongestParadigmId: ${payload.strongestParadigmId ?? "none"}`,
    `- recommendation: ${payload.recommendation}`,
    "",
    "| paradigm | compilerStatus | routeStatus | candidateCount | totalGap | fdrQ | wfoFailureDensity | meanSharpe | recommendation |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of payload.paradigms) {
    lines.push(
      `| ${item.paradigmId} | ${item.compilerStatus} | ${item.routeStatus} | ${item.candidateCount} | ${item.summaryMetrics.totalGap ?? "n/a"} | ${item.summaryMetrics.fdrQ ?? "n/a"} | ${item.summaryMetrics.wfoFailureDensity ?? "n/a"} | ${item.summaryMetrics.meanSharpe ?? "n/a"} | ${item.recommendation} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const registry = raw.get("registry");
  if (!registry) throw new Error("--registry is required.");
  return { registry };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
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

async function execNode(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.on("error", rejectPromise);
    child.on("exit", code => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Command failed with exit code ${code ?? "unknown"}`));
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
