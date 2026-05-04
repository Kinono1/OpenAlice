import { resolve } from "node:path";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";
import {
  buildBreakoutCandidate,
  buildManifestFromBase,
  buildRegimeTrendCandidate,
  buildTrendCandidate,
  clamp,
  readJson,
  renderCompilerNote,
  type CandidateConfig,
  type CandidateManifest,
  type CompilerProvenance,
  writeCompilerArtifacts,
  writeUnavailableArtifacts,
} from "./lib/btc_paradigm_compiler.js";

interface V2ExecutionContext {
  schemaVersion?: string;
  symbol?: string;
  routingFrictionProxy?: number | null;
  venueDispersionProxy?: number | null;
  liquidityStateProxy?: number | null;
  provenance?: {
    producer?: string;
    dataSource?: string;
    evidenceStrength?: string;
    generation?: string;
  };
  status?: string;
}

interface CliArgs {
  inputJson: string;
  baseManifest: string;
  output: string;
  provenanceOutput: string;
  noteOutput: string;
  paradigmId: string;
  donorRepo: string;
  sourceId: string;
  batchId: string;
  batchGoal: string;
  candidateCap: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `${args.paradigmId}.${new Date().toISOString().replace(/[:.]/g, "")}`;
  await appendExecutionJournal({
    runId,
    batchId: args.batchId,
    stage: "compiler",
    action: "manifest_materialization",
    status: "started",
    inputs: { paradigmId: args.paradigmId, inputJson: resolve(args.inputJson), baseManifest: resolve(args.baseManifest) },
    outputs: { manifest: resolve(args.output), provenance: resolve(args.provenanceOutput), note: resolve(args.noteOutput) },
    decision: "started",
    codeRefs: ["scripts/materialize_alphaswarm_btc_manifest_v2.ts"],
  });

  try {
    const baseManifest = await readJson<CandidateManifest>(args.baseManifest);
    const context = await tryReadContext(args.inputJson);

    if (!context || context.status === "unavailable") {
      const provenance = buildUnavailableProvenance(args, "missing_v2_execution_context", "alphaswarm v2 execution context artifact is missing or unavailable.");
      await writeUnavailableArtifacts({
        provenance,
        provenanceOutput: args.provenanceOutput,
        note: renderCompilerNote({
          paradigmId: args.paradigmId,
          donorRepo: args.donorRepo,
          status: "unavailable",
          sourceLogic: ["v2_external_context_only", "no_validation_result_projection"],
          failureCode: provenance.failureCode,
          failureMessage: provenance.failureMessage,
          provenanceOutput: args.provenanceOutput,
        }),
        noteOutput: args.noteOutput,
      });
      await appendExecutionJournal({
        runId,
        batchId: args.batchId,
        stage: "compiler",
        action: "manifest_materialization",
        status: "unavailable",
        inputs: { paradigmId: args.paradigmId },
        outputs: { provenance: resolve(args.provenanceOutput), note: resolve(args.noteOutput) },
        decision: "unavailable",
        codeRefs: ["scripts/materialize_alphaswarm_btc_manifest_v2.ts"],
      });
      return;
    }

    const candidates = buildCandidates(context).slice(0, args.candidateCap);
    const manifest = buildManifestFromBase({
      baseManifest,
      batchId: args.batchId,
      batchGoal: args.batchGoal,
      notes: [
        `source_paradigm=${args.paradigmId}`,
        `generation=v2_external_context`,
        `input_artifact=${resolve(args.inputJson)}`,
        `candidate_cap=${args.candidateCap}`,
      ],
      candidates,
    });

    const provenance: CompilerProvenance = {
      schemaVersion: "btc_paradigm_provenance.v1",
      generatedAt: new Date().toISOString(),
      paradigmId: args.paradigmId,
      donorRepo: args.donorRepo,
      compiler: "scripts/materialize_alphaswarm_btc_manifest_v2.ts",
      status: "compiled",
      symbol: "BTC/USD",
      candidateCap: args.candidateCap,
      inputArtifact: resolve(args.inputJson),
      baseManifest: resolve(args.baseManifest),
      manifestOutput: resolve(args.output),
      provenanceOutput: resolve(args.provenanceOutput),
      noteOutput: resolve(args.noteOutput),
      sourceLogic: [
        "read_v2_execution_context_external_api_proxy",
        "3_candidates_context_driven",
        "no_validation_result_projection",
      ],
      emittedCandidateIds: candidates.map(c => c.strategyId),
      inputsSnapshot: context as unknown as Record<string, unknown>,
    };

    const note = renderCompilerNote({
      paradigmId: args.paradigmId,
      donorRepo: args.donorRepo,
      status: "compiled",
      sourceLogic: provenance.sourceLogic,
      manifestOutput: args.output,
      provenanceOutput: args.provenanceOutput,
      emittedCandidateIds: provenance.emittedCandidateIds,
    });

    await writeCompilerArtifacts({ manifest, manifestOutput: args.output, provenance, provenanceOutput: args.provenanceOutput, note, noteOutput: args.noteOutput });

    await appendExecutionJournal({
      runId,
      batchId: args.batchId,
      stage: "compiler",
      action: "manifest_materialization",
      status: "completed",
      inputs: { paradigmId: args.paradigmId },
      outputs: { manifest: resolve(args.output), provenance: resolve(args.provenanceOutput), note: resolve(args.noteOutput) },
      decision: "completed",
      codeRefs: ["scripts/materialize_alphaswarm_btc_manifest_v2.ts"],
      notes: candidates.map(c => c.strategyId),
    });

    console.log(`manifest=${resolve(args.output)} | provenance=${resolve(args.provenanceOutput)} | candidateCount=${candidates.length}`);
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: args.batchId,
      stage: "compiler",
      action: "manifest_materialization",
      status: "failed",
      inputs: { paradigmId: args.paradigmId },
      outputs: { manifest: resolve(args.output), provenance: resolve(args.provenanceOutput), note: resolve(args.noteOutput) },
      decision: "failed",
      codeRefs: ["scripts/materialize_alphaswarm_btc_manifest_v2.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

async function tryReadContext(path: string): Promise<V2ExecutionContext | null> {
  try {
    return await readJson<V2ExecutionContext>(path);
  } catch {
    return null;
  }
}

function buildCandidates(context: V2ExecutionContext): CandidateConfig[] {
  const dispersion = clamp(Number(context.venueDispersionProxy ?? 0.3), 0, 1);
  const friction = clamp(Number(context.routingFrictionProxy ?? 0.2), 0, 1);
  const liquidity = clamp(Number(context.liquidityStateProxy ?? 0.5), 0, 1);

  return [
    buildTrendCandidate({
      symbol: "BTC/USD",
      strategyId: "AS_V2_DISPERSION_TREND",
      strategyName: "as_v2_dispersion_conditioned_trend",
      familySuffix: "alphaswarm_v2_dispersion_family",
      bucketSuffix: "as_v2_dispersion_trend",
      fast: 20 + Math.floor(dispersion * 10),
      slow: 50 + Math.floor(dispersion * 15),
      confirmBars: dispersion > 0.5 ? 1 + Math.floor(dispersion * 2) : 1,
      minDiffPct: 0,
      allowShort: true,
    }),
    buildRegimeTrendCandidate({
      symbol: "BTC/USD",
      strategyId: "AS_V2_LIQUIDITY_REGIME",
      strategyName: "as_v2_liquidity_guarded_regime",
      familySuffix: "alphaswarm_v2_liquidity_family",
      bucketSuffix: "as_v2_liquidity_regime",
      fast: 12,
      slow: 48,
      allowShort: true,
      allowedEntryRegimes: liquidity < 0.3 ? ["LowVolTrend"] : ["HighVolTrend", "LowVolTrend"],
      exitOnRegimeMismatch: liquidity < 0.5,
    }),
    buildBreakoutCandidate({
      symbol: "BTC/USD",
      strategyId: "AS_V2_FRICTION_BREAKOUT",
      strategyName: "as_v2_friction_conditioned_breakout",
      familySuffix: "alphaswarm_v2_friction_family",
      bucketSuffix: "as_v2_friction_breakout",
      breakoutPeriod: 20 + Math.floor(friction * 15),
      exitPeriod: 10 + Math.floor(friction * 8),
      allowShort: true,
    }),
  ];
}

function buildUnavailableProvenance(args: CliArgs, failureCode: string, failureMessage: string): CompilerProvenance {
  return {
    schemaVersion: "btc_paradigm_provenance.v1",
    generatedAt: new Date().toISOString(),
    paradigmId: args.paradigmId,
    donorRepo: args.donorRepo,
    compiler: "scripts/materialize_alphaswarm_btc_manifest_v2.ts",
    status: "unavailable",
    symbol: "BTC/USD",
    candidateCap: args.candidateCap,
    inputArtifact: resolve(args.inputJson),
    baseManifest: resolve(args.baseManifest),
    manifestOutput: resolve(args.output),
    provenanceOutput: resolve(args.provenanceOutput),
    noteOutput: resolve(args.noteOutput),
    failureCode,
    failureMessage,
    sourceLogic: ["v2_external_context_only", "no_validation_result_projection"],
  };
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const inputJson = raw.get("input-json");
  const baseManifest = raw.get("base-manifest");
  const output = raw.get("output");
  const provenanceOutput = raw.get("provenance-output");
  const noteOutput = raw.get("note-output");
  if (!inputJson) throw new Error("--input-json is required.");
  if (!baseManifest) throw new Error("--base-manifest is required.");
  if (!output) throw new Error("--output is required.");
  if (!provenanceOutput) throw new Error("--provenance-output is required.");
  if (!noteOutput) throw new Error("--note-output is required.");
  return {
    inputJson,
    baseManifest,
    output,
    provenanceOutput,
    noteOutput,
    paradigmId: raw.get("paradigm-id") ?? "alphaswarm_execution_context_v2",
    donorRepo: raw.get("donor-repo") ?? "alphaswarm",
    sourceId: raw.get("source-id") ?? "alphaswarm_execution_context_v2",
    batchId: raw.get("batch-id") ?? "btc_paradigm_alphaswarm_v2",
    batchGoal: raw.get("batch-goal") ?? "Materialize alphaswarm v2 external-context BTC family.",
    candidateCap: Math.max(1, Number(raw.get("candidate-cap") ?? 3)),
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) { out.set(key, "true"); continue; }
    out.set(key, next);
    index += 1;
  }
  return out;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
