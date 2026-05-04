import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";
import {
  buildManifestFromBase,
  readJson,
  renderCompilerNote,
  type CandidateManifest,
  type CompilerProvenance,
  writeCompilerArtifacts,
  writeUnavailableArtifacts,
} from "./lib/btc_paradigm_compiler.js";
import {
  buildTradingAgentsDonorCandidate,
  normalizeTradingAgentsAction,
  type TradingAgentsDecision,
} from "./lib/tradingagents_manifest.js";
import {
  buildSourceEligibilityFields,
  deriveManifestSourceDefaults,
  resolveSourceEligibility,
} from "../src/runtime/source_eligibility.js";

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
      family: "tradingagents_btc_manifest",
      command: "materialize_tradingagents_btc_manifest",
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
    inputs: {
      paradigmId: args.paradigmId,
      inputJson: resolve(args.inputJson),
      baseManifest: resolve(args.baseManifest),
      candidateCap: args.candidateCap,
    },
    outputs: {
      manifest: resolve(args.output),
      provenance: resolve(args.provenanceOutput),
      note: resolve(args.noteOutput),
    },
    decision: "started",
    codeRefs: ["scripts/materialize_tradingagents_btc_manifest.ts"],
  });

  try {
    const baseManifest = await readJson<CandidateManifest>(args.baseManifest);
    const decision = await readDecision(args.inputJson);
    if (!decision) {
      const provenance = buildUnavailableProvenance(args, "missing_input_artifact", "TradingAgents research decision artifact is missing.");
      await writeUnavailableArtifacts({
        provenance,
        provenanceOutput: args.provenanceOutput,
        note: renderCompilerNote({
          paradigmId: args.paradigmId,
          donorRepo: args.donorRepo,
          status: "unavailable",
          sourceLogic: [
            "Consume TradingAgents research_decision.v1 output as a research-only donor.",
            "Project one donor-signal BTC candidate instead of a heuristic multi-candidate family.",
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
        codeRefs: ["scripts/materialize_tradingagents_btc_manifest.ts"],
      });
      return;
    }

    const normalizedAction = normalizeTradingAgentsAction(decision);
    const notes = [
      `source_paradigm=${args.paradigmId}`,
      `source_id=${args.sourceId}`,
      `input_artifact=${resolve(args.inputJson)}`,
      `donor_action=${normalizedAction}`,
      `donor_signal=${Number(decision.strategy?.signal ?? 0)}`,
      `candidate_cap=${args.candidateCap}`,
      "compiler_mode=single_donor_signal",
      "admission_intent=exploratory",
      "promotion_eligible=false",
    ];
    const sourceDefaults = deriveManifestSourceDefaults(notes);
    const candidate = {
      ...buildTradingAgentsDonorCandidate(decision),
      ...buildSourceEligibilityFields(
        resolveSourceEligibility(decision, sourceDefaults),
      ),
    };
    const candidates = [candidate].slice(0, args.candidateCap);
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
      compiler: "scripts/materialize_tradingagents_btc_manifest.ts",
      status: "compiled",
      symbol: "BTC/USD",
      candidateCap: args.candidateCap,
      inputArtifact: resolve(args.inputJson),
      baseManifest: resolve(args.baseManifest),
      manifestOutput: resolve(args.output),
      provenanceOutput: resolve(args.provenanceOutput),
      noteOutput: resolve(args.noteOutput),
      sourceLogic: [
        "TradingAgents remains research-only and does not touch execution.",
        "Decision direction is retained as an exploratory donor-signal diagnostic.",
        "Donor single-signal compiler output is source-blocked from promotion and champion materialization.",
      ],
      emittedCandidateIds: candidates.map(item => item.strategyId),
      inputsSnapshot: {
        normalizedAction,
        action: decision.decision?.action ?? null,
        confidence: decision.decision?.confidence ?? null,
        signal: decision.strategy?.signal ?? null,
        sentimentScore: decision.news?.sentimentScore ?? null,
        riskScore: decision.news?.riskScore ?? null,
      },
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
        candidateCap: args.candidateCap,
      },
      outputs: {
        manifest: resolve(args.output),
        provenance: resolve(args.provenanceOutput),
        note: resolve(args.noteOutput),
      },
      decision: "completed",
      codeRefs: ["scripts/materialize_tradingagents_btc_manifest.ts"],
      notes: [
        ...candidates.map(item => item.strategyId),
        `normalizedAction=${normalizedAction}`,
      ],
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
      codeRefs: ["scripts/materialize_tradingagents_btc_manifest.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

async function readDecision(path: string): Promise<TradingAgentsDecision | null> {
  try {
    return await readJson<TradingAgentsDecision>(path);
  } catch {
    return null;
  }
}

function buildUnavailableProvenance(
  args: CliArgs,
  failureCode: string,
  failureMessage: string,
): CompilerProvenance {
  return {
    schemaVersion: "btc_paradigm_provenance.v1",
    generatedAt: new Date().toISOString(),
    paradigmId: args.paradigmId,
    donorRepo: args.donorRepo,
    compiler: "scripts/materialize_tradingagents_btc_manifest.ts",
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
      "Consume TradingAgents research_decision.v1 output as a research-only donor.",
      "Project one donor-signal BTC candidate instead of a heuristic multi-candidate family.",
    ],
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
    paradigmId: raw.get("paradigm-id") ?? "tradingagents_research_sidecar",
    donorRepo: raw.get("donor-repo") ?? "TradingAgents",
    sourceId: raw.get("source-id") ?? "tradingagents_research_sidecar",
    batchId: raw.get("batch-id") ?? "btc_paradigm_tradingagents_v1",
    batchGoal:
      raw.get("batch-goal") ??
      "Materialize a single TradingAgents donor-signal BTC candidate.",
    candidateCap: Math.max(1, Number(raw.get("candidate-cap") ?? 1)),
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
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
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
