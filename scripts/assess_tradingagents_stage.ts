import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";
import { buildTradingAgentsStageSnapshot } from "./lib/tradingagents_stage_assessment.js";

interface AssessmentPayload {
  schemaVersion: "tradingagents_stage_assessment.v1";
  generatedAt: string;
  paradigmId: string;
  sourceValidationRuns: string | null;
  sourceRouteMatrix: string | null;
  sourceWfoSensitivity: string | null;
  currentStage: "A" | "B" | "C" | "D";
  currentStageStatus: "pass" | "fail" | "inconclusive";
  stages: ReturnType<typeof buildTradingAgentsStageSnapshot>["stages"];
  recommendation: string;
}

interface CliArgs {
  validationRuns: string;
  routeMatrix: string;
  wfoSensitivity: string | null;
  output: string;
  paradigmId: string;
  journalPath: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `stage_assessment.${new Date().toISOString().replace(/[:.]/g, "")}`;

  await appendExecutionJournal({
    runId,
    batchId: args.paradigmId,
    stage: "assessment",
    action: "stage_assessment",
    status: "started",
    inputs: {
      paradigmId: args.paradigmId,
      validationRuns: resolve(args.validationRuns),
      routeMatrix: resolve(args.routeMatrix),
      wfoSensitivity: args.wfoSensitivity ? resolve(args.wfoSensitivity) : null,
    },
    outputs: { assessment: resolve(args.output) },
    decision: "started",
    codeRefs: ["scripts/assess_tradingagents_stage.ts"],
  }, args.journalPath);

  try {
    const [validationRuns, routeMatrix, wfoSensitivity] = await Promise.all([
      readJsonOrNull<Record<string, unknown>>(args.validationRuns),
      readJsonOrNull<Record<string, unknown>>(args.routeMatrix),
      args.wfoSensitivity
        ? readJsonOrNull<Record<string, unknown>>(args.wfoSensitivity)
        : Promise.resolve(null),
    ]);

    const snapshot = buildTradingAgentsStageSnapshot({
      validationRuns,
      routeMatrix,
      wfoSensitivity,
    });

    const payload: AssessmentPayload = {
      schemaVersion: "tradingagents_stage_assessment.v1",
      generatedAt: new Date().toISOString(),
      paradigmId: args.paradigmId,
      sourceValidationRuns: resolve(args.validationRuns),
      sourceRouteMatrix: resolve(args.routeMatrix),
      sourceWfoSensitivity: args.wfoSensitivity ? resolve(args.wfoSensitivity) : null,
      currentStage: snapshot.currentStage,
      currentStageStatus: snapshot.currentStageStatus,
      stages: snapshot.stages,
      recommendation: snapshot.recommendation,
    };

    await mkdir(dirname(resolve(args.output)), { recursive: true });
    await writeFile(resolve(args.output), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

    await appendExecutionJournal({
      runId,
      batchId: args.paradigmId,
      stage: "assessment",
      action: "stage_assessment",
      status: "completed",
      inputs: {
        paradigmId: args.paradigmId,
        validationRuns: resolve(args.validationRuns),
        routeMatrix: resolve(args.routeMatrix),
        wfoSensitivity: args.wfoSensitivity ? resolve(args.wfoSensitivity) : null,
      },
      outputs: { assessment: resolve(args.output) },
      decision: "completed",
      codeRefs: ["scripts/assess_tradingagents_stage.ts"],
    }, args.journalPath);

    console.log(
      [
        `output=${resolve(args.output)}`,
        `currentStage=${snapshot.currentStage}`,
        `status=${snapshot.currentStageStatus}`,
      ].join(" | "),
    );
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: args.paradigmId,
      stage: "assessment",
      action: "stage_assessment",
      status: "failed",
      inputs: {
        paradigmId: args.paradigmId,
        validationRuns: resolve(args.validationRuns),
        routeMatrix: resolve(args.routeMatrix),
        wfoSensitivity: args.wfoSensitivity ? resolve(args.wfoSensitivity) : null,
      },
      outputs: { assessment: resolve(args.output) },
      decision: "failed",
      codeRefs: ["scripts/assess_tradingagents_stage.ts"],
      notes: [sanitizeError(error)],
    }, args.journalPath);
    throw error;
  }
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(resolve(path), "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const validationRuns = raw.get("validation-runs");
  const routeMatrix = raw.get("route-matrix");
  const wfoSensitivity = raw.get("wfo-sensitivity") ?? null;
  const output = raw.get("output");
  if (!output) {
    throw new Error("--output is required.");
  }
  return {
    validationRuns: validationRuns ?? "",
    routeMatrix: routeMatrix ?? "",
    wfoSensitivity: wfoSensitivity ?? "",
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
