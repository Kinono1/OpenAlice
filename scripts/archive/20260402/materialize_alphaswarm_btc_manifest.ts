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

interface ExecutionContext {
  schemaVersion?: string;
  symbol?: string;
  venueDispersionPct?: number;
  routingFrictionBps?: number;
  liquidityScore?: number;
  latencyScore?: number;
  onChainCongestionScore?: number;
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
    inputs: {
      paradigmId: args.paradigmId,
      inputJson: resolve(args.inputJson),
      baseManifest: resolve(args.baseManifest),
    },
    outputs: {
      manifest: resolve(args.output),
      provenance: resolve(args.provenanceOutput),
      note: resolve(args.noteOutput),
    },
    decision: "started",
    codeRefs: ["scripts/materialize_alphaswarm_btc_manifest.ts"],
  });

  try {
    const baseManifest = await readJson<CandidateManifest>(args.baseManifest);
    const context = await tryReadContext(args.inputJson);
    if (!context) {
      const provenance = unavailable(args, "missing_execution_context", "alphaswarm-inspired execution context artifact is missing.");
      await writeUnavailableArtifacts({
        provenance,
        provenanceOutput: args.provenanceOutput,
        note: renderCompilerNote({
          paradigmId: args.paradigmId,
          donorRepo: args.donorRepo,
          status: "unavailable",
          sourceLogic: [
            "Use venue dispersion, routing friction, and liquidity state as the candidate source.",
            "Prefer execution-context-conditioned BTC candidates over pure price-pattern search.",
          ],
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
        inputs: {
          paradigmId: args.paradigmId,
          inputJson: resolve(args.inputJson),
          baseManifest: resolve(args.baseManifest),
        },
        outputs: {
          provenance: resolve(args.provenanceOutput),
          note: resolve(args.noteOutput),
        },
        decision: "unavailable",
        codeRefs: ["scripts/materialize_alphaswarm_btc_manifest.ts"],
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
        `source_id=${args.sourceId}`,
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
      compiler: "scripts/materialize_alphaswarm_btc_manifest.ts",
      status: "compiled",
      symbol: "BTC/USD",
      candidateCap: args.candidateCap,
      inputArtifact: resolve(args.inputJson),
      baseManifest: resolve(args.baseManifest),
      manifestOutput: resolve(args.output),
      provenanceOutput: resolve(args.provenanceOutput),
      noteOutput: resolve(args.noteOutput),
      sourceLogic: [
        "Venue dispersion and routing friction decide whether to prefer trend, breakout, or regime-conditioned entries.",
        "Liquidity and latency state control how defensive the family becomes.",
      ],
      emittedCandidateIds: candidates.map(item => item.strategyId),
      inputsSnapshot: context as Record<string, unknown>,
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
    await writeCompilerArtifacts({
      manifest,
      manifestOutput: args.output,
      provenance,
      provenanceOutput: args.provenanceOutput,
      note,
      noteOutput: args.noteOutput,
    });
    await appendExecutionJournal({
      runId,
      batchId: args.batchId,
      stage: "compiler",
      action: "manifest_materialization",
      status: "completed",
      inputs: {
        paradigmId: args.paradigmId,
        inputJson: resolve(args.inputJson),
        baseManifest: resolve(args.baseManifest),
      },
      outputs: {
        manifest: resolve(args.output),
        provenance: resolve(args.provenanceOutput),
        note: resolve(args.noteOutput),
      },
      decision: "completed",
      codeRefs: ["scripts/materialize_alphaswarm_btc_manifest.ts"],
      notes: candidates.map(item => item.strategyId),
    });
    console.log(
      [
        `manifest=${resolve(args.output)}`,
        `provenance=${resolve(args.provenanceOutput)}`,
        `candidateCount=${candidates.length}`,
      ].join(" | "),
    );
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: args.batchId,
      stage: "compiler",
      action: "manifest_materialization",
      status: "failed",
      inputs: {
        paradigmId: args.paradigmId,
        inputJson: resolve(args.inputJson),
        baseManifest: resolve(args.baseManifest),
      },
      outputs: {
        manifest: resolve(args.output),
        provenance: resolve(args.provenanceOutput),
        note: resolve(args.noteOutput),
      },
      decision: "failed",
      codeRefs: ["scripts/materialize_alphaswarm_btc_manifest.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

async function tryReadContext(path: string): Promise<ExecutionContext | null> {
  try {
    return await readJson<ExecutionContext>(path);
  } catch {
    return null;
  }
}

function buildCandidates(context: ExecutionContext): CandidateConfig[] {
  const dispersion = clamp(Number(context.venueDispersionPct ?? 0.2), 0, 1);
  const friction = clamp(Number(context.routingFrictionBps ?? 5), 0, 50);
  const liquidity = clamp(Number(context.liquidityScore ?? 0.5), 0, 1);
  const congestion = clamp(Number(context.onChainCongestionScore ?? 0.3), 0, 1);

  return [
    buildTrendCandidate({
      symbol: "BTC/USD",
      strategyId: "AS_DISPERSION_CORE",
      strategyName: "as_venue_dispersion_core",
      familySuffix: "alphaswarm_dispersion_family",
      bucketSuffix: "as_dispersion_core",
      fast: dispersion > 0.5 ? 18 : 34,
      slow: dispersion > 0.5 ? 70 : 89,
      confirmBars: friction > 12 ? 2 : 1,
      minDiffPct: friction > 12 ? 0.005 : 0,
      allowShort: true,
    }),
    buildRegimeTrendCandidate({
      symbol: "BTC/USD",
      strategyId: "AS_LIQUIDITY_REGIME",
      strategyName: "as_liquidity_regime_guard",
      familySuffix: "alphaswarm_liquidity_regime_family",
      bucketSuffix: "as_liquidity_regime",
      fast: 21,
      slow: liquidity < 0.4 ? 96 : 84,
      allowShort: true,
      allowedEntryRegimes: liquidity < 0.4 ? ["HighVolTrend"] : ["HighVolTrend", "LowVolTrend"],
    }),
    buildBreakoutCandidate({
      symbol: "BTC/USD",
      strategyId: "AS_ROUTING_BREAKOUT",
      strategyName: "as_routing_breakout",
      familySuffix: "alphaswarm_routing_breakout_family",
      bucketSuffix: "as_routing_breakout",
      breakoutPeriod: congestion > 0.5 ? 55 : 34,
      exitPeriod: friction > 12 ? 18 : 13,
      allowShort: true,
    }),
  ];
}

function unavailable(args: CliArgs, failureCode: string, failureMessage: string): CompilerProvenance {
  return {
    schemaVersion: "btc_paradigm_provenance.v1",
    generatedAt: new Date().toISOString(),
    paradigmId: args.paradigmId,
    donorRepo: args.donorRepo,
    compiler: "scripts/materialize_alphaswarm_btc_manifest.ts",
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
    sourceLogic: [
      "Use venue dispersion, routing friction, and liquidity state as the candidate source.",
      "Prefer execution-context-conditioned BTC candidates over pure price-pattern search.",
    ],
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
    paradigmId: raw.get("paradigm-id") ?? "alphaswarm_execution_context",
    donorRepo: raw.get("donor-repo") ?? "alphaswarm",
    sourceId: raw.get("source-id") ?? "alphaswarm_execution_context",
    batchId: raw.get("batch-id") ?? "btc_paradigm_alphaswarm_v1",
    batchGoal:
      raw.get("batch-goal") ??
      "Materialize an alphaswarm-inspired BTC execution-context family.",
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
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
    out.set(key, next);
    index += 1;
  }
  return out;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

