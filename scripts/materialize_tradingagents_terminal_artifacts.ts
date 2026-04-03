import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";
import type { FailureDiagnosisPayload } from "./lib/tradingagents_failure_diagnosis.js";
import {
  buildTradingAgentsTerminalArtifacts,
  renderTradingAgentsSalvageRegistryMarkdown,
  renderTradingAgentsTerminalDecisionMarkdown,
  renderTradingAgentsTerminalPostmortemMarkdown,
} from "./lib/tradingagents_terminal_artifacts.js";

interface CliArgs {
  diagnoses: string[];
  paradigmId: string;
  analysisDir: string;
  paradigmDir: string;
  dateTag: string;
  journalPath: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `terminal_artifacts.${new Date().toISOString().replace(/[:.]/g, "")}`;
  const resolvedDiagnosisInputs = args.diagnoses.map((path) => resolve(path));
  const outputPaths = buildOutputPaths(args.analysisDir, args.paradigmDir, args.dateTag);

  await appendExecutionJournal({
    runId,
    batchId: args.paradigmId,
    stage: "assessment",
    action: "terminal_artifact_materialization",
    status: "started",
    inputs: {
      paradigmId: args.paradigmId,
      diagnoses: resolvedDiagnosisInputs,
      analysisDir: resolve(args.analysisDir),
      paradigmDir: resolve(args.paradigmDir),
      dateTag: args.dateTag,
    },
    outputs: outputPaths,
    decision: "started",
    codeRefs: ["scripts/materialize_tradingagents_terminal_artifacts.ts"],
  }, args.journalPath);

  try {
    const diagnoses = await Promise.all(
      args.diagnoses.map((path) => readJson<FailureDiagnosisPayload>(path)),
    );
    const artifacts = buildTradingAgentsTerminalArtifacts({
      paradigmId: args.paradigmId,
      diagnoses,
      diagnosisInputs: resolvedDiagnosisInputs,
      artifactPaths: {
        diagnosisInputs: resolvedDiagnosisInputs,
        analysisTerminalDecisionJson: outputPaths.analysisTerminalDecisionJson,
        analysisTerminalDecisionMarkdown: outputPaths.analysisTerminalDecisionMarkdown,
        analysisSalvageRegistryJson: outputPaths.analysisSalvageRegistryJson,
        analysisSalvageRegistryMarkdown: outputPaths.analysisSalvageRegistryMarkdown,
        analysisTerminalPostmortemJson: outputPaths.analysisTerminalPostmortemJson,
        analysisTerminalPostmortemMarkdown: outputPaths.analysisTerminalPostmortemMarkdown,
        latestTerminalDecisionJson: outputPaths.latestTerminalDecisionJson,
        latestSalvageRegistryJson: outputPaths.latestSalvageRegistryJson,
        latestTerminalPostmortemJson: outputPaths.latestTerminalPostmortemJson,
        latestTerminalStatusJson: outputPaths.latestTerminalStatusJson,
      },
    });

    await Promise.all([
      writeJson(outputPaths.analysisTerminalDecisionJson, artifacts.terminalDecision),
      writeText(
        outputPaths.analysisTerminalDecisionMarkdown,
        renderTradingAgentsTerminalDecisionMarkdown(artifacts.terminalDecision),
      ),
      writeJson(outputPaths.analysisSalvageRegistryJson, artifacts.salvageRegistry),
      writeText(
        outputPaths.analysisSalvageRegistryMarkdown,
        renderTradingAgentsSalvageRegistryMarkdown(artifacts.salvageRegistry),
      ),
      writeJson(outputPaths.analysisTerminalPostmortemJson, artifacts.terminalPostmortem),
      writeText(
        outputPaths.analysisTerminalPostmortemMarkdown,
        renderTradingAgentsTerminalPostmortemMarkdown(artifacts.terminalPostmortem),
      ),
      writeJson(outputPaths.latestTerminalDecisionJson, artifacts.terminalDecision),
      writeJson(outputPaths.latestSalvageRegistryJson, artifacts.salvageRegistry),
      writeJson(outputPaths.latestTerminalPostmortemJson, artifacts.terminalPostmortem),
      writeJson(outputPaths.latestTerminalStatusJson, artifacts.terminalStatus),
    ]);

    await appendExecutionJournal({
      runId,
      batchId: args.paradigmId,
      stage: "assessment",
      action: "terminal_artifact_materialization",
      status: "completed",
      inputs: {
        paradigmId: args.paradigmId,
        diagnoses: resolvedDiagnosisInputs,
        analysisDir: resolve(args.analysisDir),
        paradigmDir: resolve(args.paradigmDir),
        dateTag: args.dateTag,
      },
      outputs: outputPaths,
      decision: artifacts.terminalDecision.terminalDecision,
      notes: [
        `decisionConfidence=${artifacts.terminalDecision.terminalDecisionConfidence}`,
        `evidenceCompleteness=${artifacts.terminalDecision.terminalEvidenceCompleteness}`,
        `salvageTaxonomy=${artifacts.terminalDecision.pooledSalvageTaxonomy.join(",") || "none"}`,
      ],
      codeRefs: ["scripts/materialize_tradingagents_terminal_artifacts.ts"],
    }, args.journalPath);

    console.log(
      [
        `terminalDecision=${artifacts.terminalDecision.terminalDecision}`,
        `analysisJson=${outputPaths.analysisTerminalDecisionJson}`,
        `statusJson=${outputPaths.latestTerminalStatusJson}`,
      ].join(" | "),
    );
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: args.paradigmId,
      stage: "assessment",
      action: "terminal_artifact_materialization",
      status: "failed",
      inputs: {
        paradigmId: args.paradigmId,
        diagnoses: resolvedDiagnosisInputs,
        analysisDir: resolve(args.analysisDir),
        paradigmDir: resolve(args.paradigmDir),
        dateTag: args.dateTag,
      },
      outputs: outputPaths,
      decision: "failed",
      notes: [sanitizeError(error)],
      codeRefs: ["scripts/materialize_tradingagents_terminal_artifacts.ts"],
    }, args.journalPath);
    throw error;
  }
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf-8");
  return JSON.parse(raw) as T;
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${content.trimEnd()}\n`, "utf-8");
}

function buildOutputPaths(analysisDir: string, paradigmDir: string, dateTag: string) {
  const analysisRoot = resolve(analysisDir);
  const paradigmRoot = resolve(paradigmDir);
  return {
    analysisTerminalDecisionJson: resolve(
      analysisRoot,
      `tradingagents_btc_terminal_decision_${dateTag}.json`,
    ),
    analysisTerminalDecisionMarkdown: resolve(
      analysisRoot,
      `tradingagents_btc_terminal_decision_${dateTag}.md`,
    ),
    analysisSalvageRegistryJson: resolve(
      analysisRoot,
      `tradingagents_btc_component_salvage_registry_${dateTag}.json`,
    ),
    analysisSalvageRegistryMarkdown: resolve(
      analysisRoot,
      `tradingagents_btc_component_salvage_registry_${dateTag}.md`,
    ),
    analysisTerminalPostmortemJson: resolve(
      analysisRoot,
      `tradingagents_btc_terminal_postmortem_${dateTag}.json`,
    ),
    analysisTerminalPostmortemMarkdown: resolve(
      analysisRoot,
      `tradingagents_btc_terminal_postmortem_${dateTag}.md`,
    ),
    latestTerminalDecisionJson: resolve(
      paradigmRoot,
      "btc_terminal_decision.latest.json",
    ),
    latestSalvageRegistryJson: resolve(
      paradigmRoot,
      "btc_component_salvage_registry.latest.json",
    ),
    latestTerminalPostmortemJson: resolve(
      paradigmRoot,
      "btc_terminal_postmortem.latest.json",
    ),
    latestTerminalStatusJson: resolve(
      paradigmRoot,
      "btc_terminal_status.latest.json",
    ),
  };
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const diagnoses = argv.filter((token, index) => argv[index - 1] === "--diagnosis");
  if (diagnoses.length < 1) {
    throw new Error("At least one --diagnosis <path> is required.");
  }
  return {
    diagnoses,
    paradigmId: raw.get("paradigm-id") ?? "tradingagents_research_sidecar_v2",
    analysisDir:
      raw.get("analysis-dir") ?? "data/research/strategy/analysis",
    paradigmDir:
      raw.get("paradigm-dir") ??
      "data/research/strategy/paradigms/tradingagents",
    dateTag: raw.get("date-tag") ?? currentDateTag(),
    journalPath:
      raw.get("journal-path") ?? "data/research/strategy/execution_journal.jsonl",
  };
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

function currentDateTag(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
