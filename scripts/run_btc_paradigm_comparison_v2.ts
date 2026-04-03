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

interface EvidenceStrengthPolicy {
  eligibleForRefinement?: boolean;
  eligibleForPromotion?: boolean;
  requiresLiveEvidence?: boolean;
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
  generation?: Generation;
  evidenceStrengthPolicy?: EvidenceStrengthPolicy;
}

interface RegistryPayload {
  schemaVersion?: string;
  comparisonId: string;
  policy: RegistryPolicy;
  summaryOutput?: string;
  markdownOutput?: string;
  paradigms: ParadigmSpec[];
}

type Generation = "v1_proxy" | "v2_external_context" | "v2_live_donor";
type EvidenceStrength = "live" | "external" | "internal_history" | "proxy" | "unavailable";
type ExecutionStatus = "compiled_and_routed" | "compiled_only" | "unavailable";
type ResearchConclusion = "failed_cleanly" | "near_miss" | "frontier_competitive";
type EngineeringConclusion = "framework_valid" | "input_quality_insufficient" | "runtime_blocked";

interface ComparisonEntry {
  paradigmId: string;
  donorRepo: string;
  compilerStatus: "compiled" | "unavailable";
  routeStatus: "GO" | "NO_GO" | "UNAVAILABLE";
  candidateCount: number;
  summaryMetrics: ReturnType<typeof extractSummaryMetrics>;
  recommendation: "stop" | "refine" | "promote";
  generation: Generation;
  evidenceStrength: EvidenceStrength;
  executionStatus: ExecutionStatus;
  researchConclusion: ResearchConclusion;
  engineeringConclusion: EngineeringConclusion;
  manifestOutput: string;
  provenanceOutput: string;
  noteOutput: string;
  routeTag: string;
  verdictPath?: string;
  validationRunsPath?: string;
  reason?: string | null;
}

interface DiagnosticsSummaryRow {
  lane: string;
  artifactPath: string;
  artifactStatus: string;
  evidenceStrength: string;
  failureBucket: string;
  nextAction: string;
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
    codeRefs: ["scripts/run_btc_paradigm_comparison_v2.ts"],
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
      const inputArtifact = await readJsonIfExists<Record<string, unknown>>(paradigm.inputArtifact);
      const compilerStatus = provenance.status === "compiled" ? "compiled" : "unavailable";
      const { generation, evidenceStrength } = extractProvenanceInfo(
        paradigm,
        provenance,
        inputArtifact,
      );

      if (compilerStatus !== "compiled") {
        const engineeringConclusion = determineEngineeringConclusion(
          generation,
          evidenceStrength,
        );
        results.push({
          paradigmId: paradigm.paradigmId,
          donorRepo: paradigm.donorRepo,
          compilerStatus,
          routeStatus: "UNAVAILABLE",
          candidateCount: 0,
          summaryMetrics: extractSummaryMetrics(provenance),
          recommendation: "stop",
          generation,
          evidenceStrength,
          executionStatus: "unavailable",
          researchConclusion: "failed_cleanly",
          engineeringConclusion,
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
      const metrics = mergeMetrics(
        extractSummaryMetrics(verdict),
        extractSummaryMetrics(validationRuns),
      );
      const recommendation = compareAgainstIncumbent(
        metrics,
        registry.policy.incumbentMetrics,
        evidenceStrength,
        paradigm.evidenceStrengthPolicy,
      );
      const { researchConclusion, engineeringConclusion } = determineConclusions(
        metrics,
        registry.policy.incumbentMetrics,
        generation,
        evidenceStrength,
        recommendation,
      );

      results.push({
        paradigmId: paradigm.paradigmId,
        donorRepo: paradigm.donorRepo,
        compilerStatus,
        routeStatus: verdict.result === "GO" ? "GO" : "NO_GO",
        candidateCount: Array.isArray(manifest.candidates) ? manifest.candidates.length : 0,
        summaryMetrics: metrics,
        recommendation,
        generation,
        evidenceStrength,
        executionStatus: "compiled_and_routed",
        researchConclusion,
        engineeringConclusion,
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
    const waveConclusion = determineWaveConclusion(rankedParadigms);
    const diagnosticsSummary = await buildDiagnosticsSummary(
      registry.paradigms,
      results,
    );
    const payload = {
      schemaVersion: "btc_paradigm_comparison.v2",
      generatedAt: new Date().toISOString(),
      comparisonId: registry.comparisonId,
      policy: registry.policy,
      strongestParadigmId: strongestParadigm?.paradigmId ?? null,
      waveConclusion,
      recommendation: strongestParadigm?.recommendation ?? "stop",
      paradigms: results,
      rankedParadigms,
      diagnosticsSummary,
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
      decision: strongestParadigm?.recommendation ?? waveConclusion,
      codeRefs: ["scripts/run_btc_paradigm_comparison_v2.ts", "scripts/run_route_af.ts"],
    });

    console.log(
      [
        `summary=${resolve(summaryOutput)}`,
        `markdown=${resolve(markdownOutput)}`,
        `strongestParadigm=${strongestParadigm?.paradigmId ?? "none"}`,
        `recommendation=${strongestParadigm?.recommendation ?? "stop"}`,
        `waveConclusion=${waveConclusion}`,
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
      codeRefs: ["scripts/run_btc_paradigm_comparison_v2.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

function extractProvenanceInfo(
  paradigm: ParadigmSpec,
  compilerProvenance: Record<string, unknown>,
  inputArtifact: Record<string, unknown> | null,
): {
  generation: Generation;
  evidenceStrength: EvidenceStrength;
} {
  const inputProvenance = pickNestedProvenance(inputArtifact);
  const inputSnapshot = asRecord(compilerProvenance.inputsSnapshot);
  const snapshotProvenance = pickNestedProvenance(inputSnapshot);
  const topLevelProvenance = pickNestedProvenance(compilerProvenance);

  const evidenceStrength =
    normalizeEvidenceStrength(inputProvenance?.evidenceStrength) ??
    normalizeEvidenceStrength(snapshotProvenance?.evidenceStrength) ??
    normalizeEvidenceStrength(topLevelProvenance?.evidenceStrength) ??
    inferEvidenceStrengthFromProducer(inputProvenance?.producer) ??
    inferEvidenceStrengthFromProducer(snapshotProvenance?.producer) ??
    inferEvidenceStrengthFromProducer(topLevelProvenance?.producer) ??
    normalizeEvidenceStrength(compilerProvenance.evidenceStrength) ??
    (compilerProvenance.status === "compiled" ? "unavailable" : "unavailable");

  const generation =
    normalizeGeneration(inputProvenance?.generation) ??
    normalizeGeneration(snapshotProvenance?.generation) ??
    normalizeGeneration(topLevelProvenance?.generation) ??
    normalizeGeneration(paradigm.generation) ??
    inferGenerationFromEvidenceStrength(evidenceStrength);

  return {
    generation,
    evidenceStrength,
  };
}

function compareAgainstIncumbent(
  metrics: ReturnType<typeof extractSummaryMetrics>,
  incumbent: RegistryPolicy["incumbentMetrics"],
  evidenceStrength: EvidenceStrength,
  policy?: EvidenceStrengthPolicy,
): "stop" | "refine" | "promote" {
  if ((policy?.requiresLiveEvidence ?? true) && evidenceStrength !== "live") {
    return "stop";
  }

  const totalGap = metrics.totalGap ?? Number.POSITIVE_INFINITY;
  const meanPbo = metrics.meanPbo ?? 1;
  const meanDsr = metrics.meanDsrProbability ?? 0;
  const fdrQ = metrics.fdrQ ?? 1;

  const frontierCompetitive =
    totalGap < incumbent.totalGap ||
    (totalGap === incumbent.totalGap &&
      fdrQ <= incumbent.fdrGap &&
      meanDsr >= 0.5);

  if (frontierCompetitive && (policy?.eligibleForPromotion ?? true)) {
    return "promote";
  }

  const refinementEligible =
    totalGap <= incumbent.totalGap + 0.15 &&
    meanPbo <= 0.35 &&
    meanDsr >= 0.45 &&
    fdrQ <= 0.5;

  if (refinementEligible && (policy?.eligibleForRefinement ?? true)) {
    return "refine";
  }

  return "stop";
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
    wfoFailureDensity: primary.wfoFailureDensity ?? secondary.wfoFailureDensity ?? null,
    totalGap: primary.totalGap ?? secondary.totalGap ?? null,
    meanSharpe: primary.meanSharpe ?? secondary.meanSharpe ?? null,
    meanAverageAbsoluteCorrelation:
      secondary.meanAverageAbsoluteCorrelation ?? primary.meanAverageAbsoluteCorrelation ?? null,
    maxAbsoluteCorrelation:
      secondary.maxAbsoluteCorrelation ?? primary.maxAbsoluteCorrelation ?? null,
  };
}

function determineConclusions(
  metrics: ReturnType<typeof extractSummaryMetrics>,
  incumbent: RegistryPolicy["incumbentMetrics"],
  generation: Generation,
  evidenceStrength: EvidenceStrength,
  recommendation: "stop" | "refine" | "promote",
): { researchConclusion: ResearchConclusion; engineeringConclusion: EngineeringConclusion } {
  const researchConclusion = determineResearchConclusion(
    metrics,
    incumbent,
    recommendation,
  );
  const engineeringConclusion = determineEngineeringConclusion(
    generation,
    evidenceStrength,
  );
  return { researchConclusion, engineeringConclusion };
}

function determineResearchConclusion(
  metrics: ReturnType<typeof extractSummaryMetrics>,
  incumbent: RegistryPolicy["incumbentMetrics"],
  recommendation: "stop" | "refine" | "promote",
): ResearchConclusion {
  if (recommendation === "promote") {
    return "frontier_competitive";
  }
  const totalGap = metrics.totalGap ?? Number.POSITIVE_INFINITY;
  if (totalGap <= incumbent.totalGap + 0.3) {
    return "near_miss";
  }
  return "failed_cleanly";
}

function determineEngineeringConclusion(
  generation: Generation,
  evidenceStrength: EvidenceStrength,
): EngineeringConclusion {
  if (generation === "v2_live_donor" && evidenceStrength !== "live") {
    return "runtime_blocked";
  }
  if (generation === "v2_external_context" && evidenceStrength === "unavailable") {
    return "input_quality_insufficient";
  }
  return "framework_valid";
}

function determineWaveConclusion(
  rankedParadigms: ComparisonEntry[],
): "second_wave_failed_cleanly" | "second_wave_near_miss" | "second_wave_frontier_competitive" {
  const strongest = rankedParadigms[0];
  if (!strongest) {
    return "second_wave_failed_cleanly";
  }
  if (strongest.recommendation === "promote") {
    return "second_wave_frontier_competitive";
  }
  if (strongest.recommendation === "refine") {
    return "second_wave_near_miss";
  }

  const totalGap = strongest.summaryMetrics.totalGap ?? Number.POSITIVE_INFINITY;
  const meanPbo = strongest.summaryMetrics.meanPbo ?? 1;
  const fdrQ = strongest.summaryMetrics.fdrQ ?? 1;
  if (totalGap > 1.3 || meanPbo >= 0.7 || fdrQ >= 0.9) {
    return "second_wave_failed_cleanly";
  }
  return "second_wave_near_miss";
}

function renderMarkdown(payload: {
  comparisonId: string;
  strongestParadigmId: string | null;
  waveConclusion: string;
  recommendation: string;
  paradigms: ComparisonEntry[];
  rankedParadigms: ComparisonEntry[];
  diagnosticsSummary: DiagnosticsSummaryRow[];
}) {
  const lines = [
    `# BTC Paradigm Comparison ${payload.comparisonId}`,
    "",
    `- strongestParadigmId: ${payload.strongestParadigmId ?? "none"}`,
    `- recommendation: ${payload.recommendation}`,
    `- waveConclusion: ${payload.waveConclusion}`,
    "",
    "| paradigm | generation | evidenceStrength | executionStatus | researchConclusion | engineeringConclusion | routeStatus | candidateCount | totalGap | fdrQ | wfoFailureDensity | meanSharpe | recommendation |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of payload.rankedParadigms) {
    lines.push(
      `| ${item.paradigmId} | ${item.generation} | ${item.evidenceStrength} | ${item.executionStatus} | ${item.researchConclusion} | ${item.engineeringConclusion} | ${item.routeStatus} | ${item.candidateCount} | ${item.summaryMetrics.totalGap ?? "n/a"} | ${item.summaryMetrics.fdrQ ?? "n/a"} | ${item.summaryMetrics.wfoFailureDensity ?? "n/a"} | ${item.summaryMetrics.meanSharpe ?? "n/a"} | ${item.recommendation} |`,
    );
  }
  lines.push("");
  if (payload.diagnosticsSummary.length > 0) {
    lines.push("## Diagnostics", "");
    lines.push(
      "| lane | artifactPath | artifactStatus | evidenceStrength | failureBucket | nextAction |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const row of payload.diagnosticsSummary) {
      lines.push(
        `| ${row.lane} | ${row.artifactPath} | ${row.artifactStatus} | ${row.evidenceStrength} | ${row.failureBucket} | ${row.nextAction} |`,
      );
    }
    lines.push("");
  }
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

async function execNode(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("node", args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`node ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

function normalizeGeneration(value: unknown): Generation | null {
  if (
    value === "v1_proxy" ||
    value === "v2_external_context" ||
    value === "v2_live_donor"
  ) {
    return value;
  }
  return null;
}

function normalizeEvidenceStrength(value: unknown): EvidenceStrength | null {
  if (
    value === "live" ||
    value === "external" ||
    value === "internal_history" ||
    value === "proxy" ||
    value === "unavailable"
  ) {
    return value;
  }
  return null;
}

function inferGenerationFromEvidenceStrength(
  evidenceStrength: EvidenceStrength,
): Generation {
  if (evidenceStrength === "live") {
    return "v2_live_donor";
  }
  if (evidenceStrength === "proxy") {
    return "v1_proxy";
  }
  return "v2_external_context";
}

function inferEvidenceStrengthFromProducer(
  producer: string | undefined,
): EvidenceStrength | null {
  if (!producer) {
    return null;
  }
  if (producer.includes("live_completed")) {
    return "live";
  }
  if (producer.includes("external_api_proxy")) {
    return "external";
  }
  if (producer.includes("openalice_history_proxy")) {
    return "internal_history";
  }
  if (producer.includes("local_proxy")) {
    return "proxy";
  }
  if (producer.includes("live_failed")) {
    return "unavailable";
  }
  return null;
}

function pickNestedProvenance(
  payload: Record<string, unknown> | null,
): { generation?: string; evidenceStrength?: string; producer?: string } | null {
  if (!payload) {
    return null;
  }
  const provenance = asRecord(payload.provenance);
  if (!provenance) {
    return null;
  }
  return {
    generation:
      typeof provenance.generation === "string" ? provenance.generation : undefined,
    evidenceStrength:
      typeof provenance.evidenceStrength === "string"
        ? provenance.evidenceStrength
        : undefined,
    producer: typeof provenance.producer === "string" ? provenance.producer : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

async function buildDiagnosticsSummary(
  paradigms: ParadigmSpec[],
  results: ComparisonEntry[],
): Promise<DiagnosticsSummaryRow[]> {
  const rows: DiagnosticsSummaryRow[] = [];
  for (const paradigm of paradigms) {
    const result = results.find(item => item.paradigmId === paradigm.paradigmId);
    if (!result) {
      continue;
    }
    const artifact = await readJsonIfExists<Record<string, unknown>>(paradigm.inputArtifact);
    const diagnostics = await resolveLaneDiagnostics(paradigm);
    rows.push({
      lane: paradigm.paradigmId,
      artifactPath: resolve(paradigm.inputArtifact),
      artifactStatus: resolveArtifactStatus(artifact, result),
      evidenceStrength: result.evidenceStrength,
      failureBucket: diagnostics.failureBucket ?? result.reason ?? "none",
      nextAction: determineNextAction(result),
    });
  }
  return rows;
}

async function resolveLaneDiagnostics(paradigm: ParadigmSpec): Promise<{
  failureBucket?: string;
}> {
  const diagnosticsPath = replaceJsonSuffix(paradigm.inputArtifact, ".diagnostics.json");
  const probeDiagnosticsPath = replaceJsonSuffix(
    paradigm.inputArtifact,
    ".probe.diagnostics.json",
  );
  const failurePath = replaceJsonSuffix(paradigm.inputArtifact, ".failure.json");
  const [diagnostics, probeDiagnostics, failureArtifact] = await Promise.all([
    readJsonIfExists<Record<string, unknown>>(diagnosticsPath),
    readJsonIfExists<Record<string, unknown>>(probeDiagnosticsPath),
    readJsonIfExists<Record<string, unknown>>(failurePath),
  ]);

  const failureBucket =
    pickString(diagnostics?.failureBucket) ??
    pickString(probeDiagnostics?.failureBucket) ??
    pickString(asRecord(failureArtifact?.provenance)?.failureCode);

  return { failureBucket };
}

function resolveArtifactStatus(
  artifact: Record<string, unknown> | null,
  result: ComparisonEntry,
): string {
  const explicitStatus = pickString(artifact?.status);
  if (explicitStatus) {
    return explicitStatus;
  }
  if (artifact) {
    return "available";
  }
  return result.executionStatus === "unavailable" ? "missing" : "available";
}

function determineNextAction(result: ComparisonEntry): string {
  if (result.paradigmId.includes("tradingagents")) {
    if (result.evidenceStrength === "live") {
      return result.recommendation === "stop"
        ? "separate_strategy_assessment"
        : "continue_live_lane";
    }
    return "continue_runtime_recovery";
  }
  if (result.evidenceStrength === "unavailable") {
    return "retain_control_lane";
  }
  return "keep_as_comparison_control";
}

function replaceJsonSuffix(path: string, suffix: string): string {
  return path.endsWith(".json") ? path.slice(0, -5) + suffix : `${path}${suffix}`;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf-8");
  return JSON.parse(raw) as T;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
