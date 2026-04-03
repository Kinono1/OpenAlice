import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";
import {
  DEFAULT_FAILURE_DIAGNOSIS_CONFIG,
  diagnoseTradingAgentsFailureMechanism,
  type FailureDiagnosisConfig,
} from "./lib/tradingagents_failure_diagnosis.js";

interface CliArgs {
  validationRuns: string;
  routeMatrix: string;
  wfoSensitivity: string | null;
  output: string;
  paradigmId: string;
  poolProfile: string;
  preRegisteredConfig: string | null;
  journalPath: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `failure_diagnosis.${new Date().toISOString().replace(/[:.]/g, "")}`;

  await appendExecutionJournal({
    runId,
    batchId: args.paradigmId,
    stage: "assessment",
    action: "failure_diagnosis",
    status: "started",
    inputs: {
      paradigmId: args.paradigmId,
      poolProfile: args.poolProfile,
      validationRuns: resolve(args.validationRuns),
      routeMatrix: resolve(args.routeMatrix),
      wfoSensitivity: args.wfoSensitivity ? resolve(args.wfoSensitivity) : null,
      preRegisteredConfig: args.preRegisteredConfig
        ? resolve(args.preRegisteredConfig)
        : "embedded_default",
      preRegisteredPrimaryMetrics: DEFAULT_FAILURE_DIAGNOSIS_CONFIG.primaryMetrics,
      preRegisteredSupportingMetrics:
        DEFAULT_FAILURE_DIAGNOSIS_CONFIG.supportingMetrics,
      stopConditions: DEFAULT_FAILURE_DIAGNOSIS_CONFIG.stopConditions,
      continueConditions: DEFAULT_FAILURE_DIAGNOSIS_CONFIG.continueConditions,
    },
    outputs: { diagnosis: resolve(args.output) },
    decision: "started",
    codeRefs: ["scripts/diagnose_tradingagents_failure_mechanism.ts"],
  }, args.journalPath);

  try {
    const [validationRuns, routeMatrix, wfoSensitivity, preRegisteredConfig] =
      await Promise.all([
        readJsonOrNull<Record<string, unknown>>(args.validationRuns),
        readJsonOrNull<Record<string, unknown>>(args.routeMatrix),
        args.wfoSensitivity
          ? readJsonOrNull<Record<string, unknown>>(args.wfoSensitivity)
          : Promise.resolve(null),
        args.preRegisteredConfig
          ? readJsonOrNull<FailureDiagnosisConfig>(args.preRegisteredConfig)
          : Promise.resolve(null),
      ]);

    const diagnosis = diagnoseTradingAgentsFailureMechanism({
      paradigmId: args.paradigmId,
      poolProfile: args.poolProfile,
      validationRuns,
      routeMatrix,
      wfoSensitivity,
      preRegisteredConfig: preRegisteredConfig ?? DEFAULT_FAILURE_DIAGNOSIS_CONFIG,
      sourceValidationRuns: resolve(args.validationRuns),
      sourceRouteMatrix: resolve(args.routeMatrix),
      sourceWfoSensitivity: args.wfoSensitivity ? resolve(args.wfoSensitivity) : null,
      sourcePreRegisteredConfig: args.preRegisteredConfig
        ? resolve(args.preRegisteredConfig)
        : null,
    });

    await mkdir(dirname(resolve(args.output)), { recursive: true });
    await writeFile(resolve(args.output), `${JSON.stringify(diagnosis, null, 2)}\n`, "utf-8");

    await appendExecutionJournal({
      runId,
      batchId: args.paradigmId,
      stage: "assessment",
      action: "failure_diagnosis",
      status: "completed",
      inputs: {
        paradigmId: args.paradigmId,
        poolProfile: args.poolProfile,
        validationRuns: resolve(args.validationRuns),
        routeMatrix: resolve(args.routeMatrix),
        wfoSensitivity: args.wfoSensitivity ? resolve(args.wfoSensitivity) : null,
        preRegisteredConfig: args.preRegisteredConfig
          ? resolve(args.preRegisteredConfig)
          : "embedded_default",
      },
      outputs: { diagnosis: resolve(args.output) },
      decision: diagnosis.decision,
      notes: [
        `primaryRootCause=${diagnosis.primaryRootCause}`,
        `secondaryContributors=${diagnosis.secondaryContributors.join(",") || "none"}`,
        `decisionConfidence=${diagnosis.decisionConfidence}`,
        `evidenceCompleteness=${diagnosis.evidenceCompleteness}`,
      ],
      codeRefs: ["scripts/diagnose_tradingagents_failure_mechanism.ts"],
    }, args.journalPath);

    console.log(
      [
        `output=${resolve(args.output)}`,
        `decision=${diagnosis.decision}`,
        `primaryRootCause=${diagnosis.primaryRootCause}`,
        `confidence=${diagnosis.decisionConfidence}`,
      ].join(" | "),
    );
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: args.paradigmId,
      stage: "assessment",
      action: "failure_diagnosis",
      status: "failed",
      inputs: {
        paradigmId: args.paradigmId,
        poolProfile: args.poolProfile,
        validationRuns: resolve(args.validationRuns),
        routeMatrix: resolve(args.routeMatrix),
        wfoSensitivity: args.wfoSensitivity ? resolve(args.wfoSensitivity) : null,
        preRegisteredConfig: args.preRegisteredConfig
          ? resolve(args.preRegisteredConfig)
          : "embedded_default",
      },
      outputs: { diagnosis: resolve(args.output) },
      decision: "failed",
      notes: [sanitizeError(error)],
      codeRefs: ["scripts/diagnose_tradingagents_failure_mechanism.ts"],
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
  const output = raw.get("output");
  if (!output) {
    throw new Error("--output is required.");
  }
  const validationRuns = raw.get("validation-runs");
  const routeMatrix = raw.get("route-matrix");
  const wfoSensitivity = raw.get("wfo-sensitivity") ?? null;
  if (!validationRuns || !routeMatrix) {
    throw new Error("--validation-runs and --route-matrix are required.");
  }
  return {
    validationRuns,
    routeMatrix,
    wfoSensitivity,
    output,
    paradigmId: raw.get("paradigm-id") ?? "tradingagents_research_sidecar_v2",
    poolProfile: raw.get("pool-profile") ?? "baseline_guard_v1",
    preRegisteredConfig: raw.get("pre-registered-config") ?? null,
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
