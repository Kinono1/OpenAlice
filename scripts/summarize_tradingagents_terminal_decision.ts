import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";
import type { FailureDiagnosisPayload } from "./lib/tradingagents_failure_diagnosis.js";
import {
  summarizeTradingAgentsTerminalDecision,
  type TerminalDecisionPayload,
} from "./lib/tradingagents_terminal_decision.js";

interface CliArgs {
  diagnoses: string[];
  output: string;
  paradigmId: string;
  journalPath: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `terminal_decision.${new Date().toISOString().replace(/[:.]/g, "")}`;

  await appendExecutionJournal({
    runId,
    batchId: args.paradigmId,
    stage: "assessment",
    action: "terminal_decision_summary",
    status: "started",
    inputs: {
      paradigmId: args.paradigmId,
      diagnoses: args.diagnoses.map((path) => resolve(path)),
    },
    outputs: { summary: resolve(args.output) },
    decision: "started",
    codeRefs: ["scripts/summarize_tradingagents_terminal_decision.ts"],
  }, args.journalPath);

  try {
    const diagnoses = await Promise.all(
      args.diagnoses.map((path) => readJson<FailureDiagnosisPayload>(path)),
    );

    const payload: TerminalDecisionPayload = summarizeTradingAgentsTerminalDecision({
      paradigmId: args.paradigmId,
      diagnoses,
      diagnosisInputs: args.diagnoses.map((path) => resolve(path)),
    });

    await mkdir(dirname(resolve(args.output)), { recursive: true });
    await writeFile(resolve(args.output), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

    await appendExecutionJournal({
      runId,
      batchId: args.paradigmId,
      stage: "assessment",
      action: "terminal_decision_summary",
      status: "completed",
      inputs: {
        paradigmId: args.paradigmId,
        diagnoses: args.diagnoses.map((path) => resolve(path)),
      },
      outputs: { summary: resolve(args.output) },
      decision: payload.terminalDecision,
      notes: payload.rationale,
      codeRefs: ["scripts/summarize_tradingagents_terminal_decision.ts"],
    }, args.journalPath);

    console.log(
      [
        `output=${resolve(args.output)}`,
        `terminalDecision=${payload.terminalDecision}`,
        `diagnosisCount=${diagnoses.length}`,
      ].join(" | "),
    );
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: args.paradigmId,
      stage: "assessment",
      action: "terminal_decision_summary",
      status: "failed",
      inputs: {
        paradigmId: args.paradigmId,
        diagnoses: args.diagnoses.map((path) => resolve(path)),
      },
      outputs: { summary: resolve(args.output) },
      decision: "failed",
      notes: [sanitizeError(error)],
      codeRefs: ["scripts/summarize_tradingagents_terminal_decision.ts"],
    }, args.journalPath);
    throw error;
  }
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf-8");
  return JSON.parse(raw) as T;
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const output = raw.get("output");
  if (!output) {
    throw new Error("--output is required.");
  }
  const diagnoses = argv.filter((token, index) => argv[index - 1] === "--diagnosis");
  if (diagnoses.length < 1) {
    throw new Error("At least one --diagnosis <path> is required.");
  }
  return {
    diagnoses,
    output,
    paradigmId: raw.get("paradigm-id") ?? "tradingagents_research_sidecar_v2",
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
