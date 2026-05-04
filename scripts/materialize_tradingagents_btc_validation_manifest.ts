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
  buildTradingAgentsValidationPool,
  type TradingAgentsValidationPoolProfile,
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
  poolProfile: TradingAgentsValidationPoolProfile;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: "tradingagents_btc_validation_manifest",
      command: "materialize_tradingagents_btc_validation_manifest",
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
    action: "validation_manifest_materialization",
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
    codeRefs: ["scripts/materialize_tradingagents_btc_validation_manifest.ts"],
  });

  try {
    const baseManifest = await readJson<CandidateManifest>(args.baseManifest);
    const decision = await readDecision(args.inputJson);
    if (!decision) {
      const provenance = buildUnavailableProvenance(
        args,
        "missing_input_artifact",
        "TradingAgents research decision artifact is missing.",
      );
      await writeUnavailableArtifacts({
        provenance,
        provenanceOutput: args.provenanceOutput,
        note: renderCompilerNote({
          paradigmId: args.paradigmId,
          donorRepo: args.donorRepo,
          status: "unavailable",
          sourceLogic: [
            "Consume TradingAgents research_decision.v1 output as a research-only donor.",
            "Build a 3-candidate validation pool using one donor candidate plus preregistered controls.",
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
        action: "validation_manifest_materialization",
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
        codeRefs: ["scripts/materialize_tradingagents_btc_validation_manifest.ts"],
      });
      return;
    }

    const validationPool = buildTradingAgentsValidationPool(
      decision,
      "BTC/USD",
      args.poolProfile,
    );
    const usesRobustnessAnchor =
      validationPool.profile === "baseline_robust_anchor_v1";
    const usesIndependentGuard =
      validationPool.profile === "baseline_independent_guard_v1";
    const notes = [
      `source_paradigm=${args.paradigmId}`,
      `source_id=${args.sourceId}`,
      `input_artifact=${resolve(args.inputJson)}`,
      `donor_action=${validationPool.donorAction}`,
      `donor_signal=${validationPool.donorSignal}`,
      `compiler_mode=single_donor_plus_controls`,
      `validation_pool_size=${validationPool.candidates.length}`,
      `benchmark_strategy_id=${validationPool.benchmarkStrategyId}`,
      `donor_strategy_id=${validationPool.donorCandidate.strategyId}`,
      `validation_pool_profile=${validationPool.profile}`,
      "baseline_control_profile=trend_50_100_long_only",
      "baseline_control_window_compat_adjustment=true",
      "admission_intent=exploratory",
      "promotion_eligible=false",
      usesRobustnessAnchor
        ? "robustness_anchor_source=route_batch8_btc_phaseb_baseline.phaseb_native_v1.HC001_COS_34_65_ls"
        : usesIndependentGuard
          ? "independent_guard_source=route_batch35_btc_20260303T034851Z_trial0_base.HC001_REG_48_16_lo"
          : "controls_preregistered=true",
      usesRobustnessAnchor
        ? "neutral_guard_replaced_with_fixed_robustness_anchor=true"
        : usesIndependentGuard
          ? "neutral_guard_replaced_with_fixed_independent_guard=true"
          : "neutral_guard_retained=true",
    ];
    const sourceDefaults = deriveManifestSourceDefaults(notes);
    const sourceBlockedCandidates = validationPool.candidates.map((candidate) => ({
      ...candidate,
      ...buildSourceEligibilityFields(
        resolveSourceEligibility(
          candidate.strategyId === validationPool.donorCandidate.strategyId
            ? decision
            : { role: candidate.role },
          sourceDefaults,
        ),
      ),
    }));
    const manifestBase = buildManifestFromBase({
      baseManifest,
      batchId: args.batchId,
      batchGoal: args.batchGoal,
      notes,
      candidates: sourceBlockedCandidates,
    });

    const manifest: CandidateManifest = {
      ...manifestBase,
      significance: {
        ...(manifestBase.significance ?? {}),
        multipleTestingUnit:
          (manifestBase.significance as { multipleTestingUnit?: unknown } | undefined)
            ?.multipleTestingUnit ?? "family",
        benchmarkStrategyIdBySymbol: {
          ...(((manifestBase.significance as {
            benchmarkStrategyIdBySymbol?: Record<string, string>;
          } | undefined)?.benchmarkStrategyIdBySymbol) ?? {}),
          "BTC/USD": validationPool.benchmarkStrategyId,
        },
        spaBootstrapSamples:
          (manifestBase.significance as { spaBootstrapSamples?: unknown } | undefined)
            ?.spaBootstrapSamples ?? 400,
        spaBlockSize:
          (manifestBase.significance as { spaBlockSize?: unknown } | undefined)
            ?.spaBlockSize ?? 12,
      },
    };

    const provenance: CompilerProvenance = {
      schemaVersion: "btc_paradigm_provenance.v1",
      generatedAt: new Date().toISOString(),
      paradigmId: args.paradigmId,
      donorRepo: args.donorRepo,
      compiler: "scripts/materialize_tradingagents_btc_validation_manifest.ts",
      status: "compiled",
      symbol: "BTC/USD",
      candidateCap: validationPool.candidates.length,
      inputArtifact: resolve(args.inputJson),
      baseManifest: resolve(args.baseManifest),
      manifestOutput: resolve(args.output),
      provenanceOutput: resolve(args.provenanceOutput),
      noteOutput: resolve(args.noteOutput),
      sourceLogic: [
        "TradingAgents donor candidate is preserved exactly as the single-candidate compiler emits it.",
        usesRobustnessAnchor
          ? "Validation pool adds preregistered baseline_control plus a fixed robustness_anchor control from the current strongest BTC upstream route."
          : usesIndependentGuard
            ? "Validation pool adds preregistered baseline_control plus a fixed independent_guard breakout control selected for lower donor correlation."
            : "Validation pool adds preregistered baseline_control and neutral_guard controls.",
        "Manifest is intended for benchmark-aware validation, not for replacing the main TradingAgents v2 lane.",
      ],
      emittedCandidateIds: sourceBlockedCandidates.map((candidate) => candidate.strategyId),
      inputsSnapshot: {
        validationPoolProfile: validationPool.profile,
        donorAction: validationPool.donorAction,
        donorSignal: validationPool.donorSignal,
        donorStrategyId: validationPool.donorCandidate.strategyId,
        benchmarkStrategyId: validationPool.benchmarkStrategyId,
        baselineControlProfile: "trend_50_100_long_only",
        robustnessAnchorStrategyId: usesRobustnessAnchor ? "ROBUSTNESS_ANCHOR" : null,
        independentGuardStrategyId: usesIndependentGuard ? "INDEPENDENT_GUARD" : null,
        validationPoolSize: validationPool.candidates.length,
        action: decision.decision?.action ?? null,
        confidence: decision.decision?.confidence ?? null,
        signal: decision.strategy?.signal ?? null,
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
      action: "validation_manifest_materialization",
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
      codeRefs: ["scripts/materialize_tradingagents_btc_validation_manifest.ts"],
      notes: validationPool.candidates.map((candidate) => candidate.strategyId),
    });

    console.log(
      [
        `manifest=${resolve(args.output)}`,
        `provenance=${resolve(args.provenanceOutput)}`,
        `candidateCount=${validationPool.candidates.length}`,
      ].join(" | "),
    );
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: args.batchId,
      stage: "compiler",
      action: "validation_manifest_materialization",
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
      codeRefs: ["scripts/materialize_tradingagents_btc_validation_manifest.ts"],
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
    compiler: "scripts/materialize_tradingagents_btc_validation_manifest.ts",
    status: "unavailable",
    symbol: "BTC/USD",
    candidateCap: 3,
    inputArtifact: resolve(args.inputJson),
    baseManifest: resolve(args.baseManifest),
    manifestOutput: resolve(args.output),
    provenanceOutput: resolve(args.provenanceOutput),
    noteOutput: resolve(args.noteOutput),
    failureCode,
    failureMessage,
    sourceLogic: [
      "Consume TradingAgents research_decision.v1 output as a research-only donor.",
      "Build a 3-candidate validation pool using one donor candidate plus fixed validation controls.",
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
    paradigmId:
      raw.get("paradigm-id") ?? "tradingagents_research_sidecar_v2_validation",
    donorRepo: raw.get("donor-repo") ?? "TradingAgents",
    sourceId:
      raw.get("source-id") ?? "tradingagents_research_sidecar_v2_validation",
    poolProfile:
      raw.get("pool-profile") === "baseline_robust_anchor_v1"
        ? "baseline_robust_anchor_v1"
        : raw.get("pool-profile") === "baseline_independent_guard_v1"
          ? "baseline_independent_guard_v1"
        : "baseline_guard_v1",
    batchId:
      raw.get("batch-id") ?? "btc_paradigm_tradingagents_v2_validation",
    batchGoal:
      raw.get("batch-goal") ??
      "Materialize a TradingAgents donor-signal BTC validation pool with preregistered controls.",
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
    console.error(
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    process.exitCode = 1;
  });
}

export {
  main,
  parseArgs,
};
