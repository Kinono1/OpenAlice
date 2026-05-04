import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";
import {
  buildEnsembleCandidate,
  buildManifestFromBase,
  buildRegimeTrendCandidate,
  buildTrendCandidate,
  clamp,
  readJson,
  renderCompilerNote,
  tryReadJson,
  type CandidateConfig,
  type CandidateManifest,
  type CompilerProvenance,
  writeCompilerArtifacts,
  writeUnavailableArtifacts,
} from "./lib/btc_paradigm_compiler.js";
import {
  buildSourceEligibilityFields,
  deriveManifestSourceDefaults,
  resolveSourceEligibility,
} from "../src/runtime/source_eligibility.js";

interface V2ReflectionContext {
  schemaVersion?: string;
  symbol?: string;
  recentDirectionalOutcome?: "bullish" | "bearish" | "neutral" | null;
  signalDisagreement?: number | null;
  failurePatternMemory?: number | null;
  provenance?: {
    producer?: string;
    reflectionSource?: string;
    evidenceStrength?: string;
    generation?: string;
    note?: string;
  };
  status?: string;
}

interface CliArgs {
  dryRun: boolean;
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

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: "cryptotrade_btc_manifest_v2",
      command: "materialize_cryptotrade_btc_manifest_v2",
      executionMode: {
        dryRun: true,
        writesExecutionJournal: false,
        readsInputArtifact: false,
        readsBaseManifest: false,
        writesManifest: false,
        writesProvenance: false,
        writesCompilerNote: false,
        promotionEligible: false,
      },
      outputs: {
        manifest: args.output || null,
        provenance: args.provenanceOutput || null,
        note: args.noteOutput || null,
      },
      optIn: {
        materializeManifest: "--dryRun false",
      },
    }, null, 2));
    return;
  }

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
    codeRefs: ["scripts/materialize_cryptotrade_btc_manifest_v2.ts"],
  });

  try {
    const baseManifest = await readJson<CandidateManifest>(args.baseManifest);
    const context = await tryReadContext(args.inputJson);

    if (!context || context.status === "unavailable") {
      const provenance = buildUnavailableProvenance(args, "missing_v2_reflection_context", "CryptoTrade v2 reflection context is missing or unavailable.");
      await writeUnavailableArtifacts({
        provenance,
        provenanceOutput: args.provenanceOutput,
        note: renderCompilerNote({
          paradigmId: args.paradigmId,
          donorRepo: args.donorRepo,
          status: "unavailable",
          sourceLogic: ["v2_history_reflection_proxy", "not_donor_native", "no_verdict_projection"],
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
        codeRefs: ["scripts/materialize_cryptotrade_btc_manifest_v2.ts"],
      });
      return;
    }

    const notes = [
      `source_paradigm=${args.paradigmId}`,
      `source_id=${args.sourceId}`,
      `input_artifact=${resolve(args.inputJson)}`,
      `candidate_cap=${args.candidateCap}`,
      `reflection_source=openalice_paper_history`,
      `not_donor_native=true`,
      "admission_intent=exploratory",
      "promotion_eligible=false",
    ];
    const sourceDefaults = deriveManifestSourceDefaults(notes);
    const candidates = buildCandidates(context)
      .slice(0, args.candidateCap)
      .map(candidate => ({
        ...candidate,
        ...buildSourceEligibilityFields(
          resolveSourceEligibility(context, sourceDefaults),
        ),
      }));
    const manifest = buildManifestFromBase({
      baseManifest,
      batchId: args.batchId,
      batchGoal: args.batchGoal,
      notes,
      candidates,
    });

    const provenance: CompilerProvenance = {
      schemaVersion: "btc_paradigm_provenance.v1",
      generatedAt: new Date().toISOString(),
      paradigmId: args.paradigmId,
      donorRepo: args.donorRepo,
      compiler: "scripts/materialize_cryptotrade_btc_manifest_v2.ts",
      status: "compiled",
      symbol: "BTC/USD",
      candidateCap: args.candidateCap,
      inputArtifact: resolve(args.inputJson),
      baseManifest: resolve(args.baseManifest),
      manifestOutput: resolve(args.output),
      provenanceOutput: resolve(args.provenanceOutput),
      noteOutput: resolve(args.noteOutput),
      sourceLogic: [
        "read_v2_reflection_context_openalice_history_proxy",
        "3_candidates_reflection_driven",
        "no_verdict_reason_code_projection",
        "not_donor_native",
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
      codeRefs: ["scripts/materialize_cryptotrade_btc_manifest_v2.ts"],
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
      codeRefs: ["scripts/materialize_cryptotrade_btc_manifest_v2.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

async function tryReadContext(path: string): Promise<V2ReflectionContext | null> {
  const result = await tryReadJson<V2ReflectionContext>(path);
  return result;
}

function buildCandidates(context: V2ReflectionContext): CandidateConfig[] {
  const narrative = context.recentDirectionalOutcome ?? "neutral";
  const disagreement = clamp(Number(context.signalDisagreement ?? 0.5), 0, 1);
  const failureMemory = clamp(Number(context.failurePatternMemory ?? 0.2), 0, 1);

  return [
    // narrative_conviction: trend candidate conditioned on recent directional outcome
    buildTrendCandidate({
      symbol: "BTC/USD",
      strategyId: "CT_V2_NARRATIVE_CONVICTION",
      strategyName: "ct_v2_narrative_conviction",
      familySuffix: "cryptotrade_v2_narrative_family",
      bucketSuffix: "ct_v2_narrative_conviction",
      fast: narrative === "bullish" ? 15 : narrative === "bearish" ? 25 : 20,
      slow: narrative === "bearish" ? 60 : 50,
      confirmBars: narrative === "bearish" ? 3 : 1,
      minDiffPct: narrative === "neutral" ? 0 : 0.005,
      allowShort: true,
    }),
    // reflection_guard: regime candidate guarded by failure memory
    buildRegimeTrendCandidate({
      symbol: "BTC/USD",
      strategyId: "CT_V2_REFLECTION_GUARD",
      strategyName: "ct_v2_reflection_guard",
      familySuffix: "cryptotrade_v2_reflection_guard_family",
      bucketSuffix: "ct_v2_reflection_guard",
      fast: 12,
      slow: 48,
      allowShort: true,
      allowedEntryRegimes: failureMemory > 0.5 ? ["LowVolTrend"] : ["HighVolTrend", "LowVolTrend"],
      exitOnRegimeMismatch: failureMemory > 0.3,
    }),
    // disagreement_blend: ensemble conditioned on signal disagreement
    buildEnsembleCandidate({
      symbol: "BTC/USD",
      strategyId: "CT_V2_DISAGREEMENT_BLEND",
      strategyName: "ct_v2_disagreement_blend",
      familySuffix: "cryptotrade_v2_disagreement_family",
      bucketSuffix: "ct_v2_disagreement_blend",
      threshold: 0.34,
      allowShort: true,
      weights: disagreement > 0.5
        ? { trend: 0.8, meanReversion: 1.2, breakout: 1.0 }
        : { trend: 1, meanReversion: 1, breakout: 1 },
    }),
  ];
}

function buildUnavailableProvenance(args: CliArgs, failureCode: string, failureMessage: string): CompilerProvenance {
  return {
    schemaVersion: "btc_paradigm_provenance.v1",
    generatedAt: new Date().toISOString(),
    paradigmId: args.paradigmId,
    donorRepo: args.donorRepo,
    compiler: "scripts/materialize_cryptotrade_btc_manifest_v2.ts",
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
    sourceLogic: ["v2_history_reflection_proxy", "not_donor_native", "no_verdict_projection"],
  };
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const dryRun = parseBoolArg(raw.get("dryRun"), true);
  const inputJson = raw.get("input-json");
  const baseManifest = raw.get("base-manifest");
  const output = raw.get("output");
  const provenanceOutput = raw.get("provenance-output");
  const noteOutput = raw.get("note-output");
  if (!dryRun) {
    if (!inputJson) throw new Error("--input-json is required.");
    if (!baseManifest) throw new Error("--base-manifest is required.");
    if (!output) throw new Error("--output is required.");
    if (!provenanceOutput) throw new Error("--provenance-output is required.");
    if (!noteOutput) throw new Error("--note-output is required.");
  }
  return {
    dryRun,
    inputJson: inputJson ?? "",
    baseManifest: baseManifest ?? "",
    output: output ?? "",
    provenanceOutput: provenanceOutput ?? "",
    noteOutput: noteOutput ?? "",
    paradigmId: raw.get("paradigm-id") ?? "cryptotrade_reflection_narrative_v2",
    donorRepo: raw.get("donor-repo") ?? "CryptoTrade",
    sourceId: raw.get("source-id") ?? "cryptotrade_reflection_narrative_v2",
    batchId: raw.get("batch-id") ?? "btc_paradigm_cryptotrade_v2",
    batchGoal: raw.get("batch-goal") ?? "Materialize CryptoTrade v2 history-reflection BTC family.",
    candidateCap: Math.max(1, Number(raw.get("candidate-cap") ?? 3)),
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const withoutPrefix = token.slice(2);
    const eq = withoutPrefix.indexOf("=");
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1));
      continue;
    }
    const key = withoutPrefix;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) { out.set(key, "true"); continue; }
    out.set(key, next);
    index += 1;
  }
  return out;
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  main,
  parseArgs,
};
