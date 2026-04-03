import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  ensureRuntimeProofArtifacts,
  loadRuntimeProofTracking,
} from "../src/runtime/live_proof_status.js";
import {
  appendExecutionJournal,
  extractSummaryMetrics,
  sanitizeError,
} from "./lib/execution_journal.js";

interface CliArgs {
  candidates: string;
  tag: string;
  runValidation: boolean;
  output: string;
  verdictOutput: string;
  releaseGateStatusPath: string;
  statusOutput: string;
  phaseReadinessOutput: string;
  multipleTestingUnit?: "candidate" | "family";
  sourceId?: string;
  protocolProfile?: string;
  fdrMethod?: "bh" | "by" | "cv_storey_bh" | "stepc" | "spa";
  wfoProfile?: "stable" | "shift" | "stress";
  storeyLambda?: number;
  cvAggQuantile?: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `${args.tag}.${new Date().toISOString().replace(/[:.]/g, "")}`;
  const journalInputs = {
    candidates: resolve(args.candidates),
    tag: args.tag,
    runValidation: args.runValidation,
    sourceId: args.sourceId ?? null,
    protocolProfile: args.protocolProfile ?? null,
    multipleTestingUnit: args.multipleTestingUnit ?? "candidate",
    fdrMethod: args.fdrMethod ?? "bh",
    wfoProfile: args.wfoProfile ?? "stable",
    storeyLambda: args.storeyLambda ?? null,
    cvAggQuantile: args.cvAggQuantile ?? null,
  };
  const journalOutputs = {
    validationRuns: resolve(args.output),
    verdict: resolve(args.verdictOutput),
    releaseGateStatus: resolve(args.releaseGateStatusPath),
    status: resolve(args.statusOutput),
    phaseReadiness: resolve(args.phaseReadinessOutput),
  };

  await appendExecutionJournal({
    runId,
    batchId: args.tag,
    stage: "route",
    action: "route",
    status: "started",
    inputs: journalInputs,
    outputs: journalOutputs,
    decision: "started",
    codeRefs: ["scripts/run_route_af.ts", "scripts/run_strategy_mvp_validation.ts"],
  });

  try {
    if (args.runValidation) {
      await runValidation(args);
    }

    const [verdict, releaseGateStatus, proofPaths, phaseReadiness, validationRuns] =
      await Promise.all([
        readJsonOrNull(args.verdictOutput),
        readJsonOrNull(args.releaseGateStatusPath),
        ensureRuntimeProofArtifacts(),
        readJsonOrNull("data/runtime/phase_readiness.latest.json"),
        readJsonOrNull(args.output),
      ]);
    const proofTracking = await loadRuntimeProofTracking(proofPaths);
    const effectivePhaseReadiness = buildEffectivePhaseReadiness({
      verdict,
      releaseGateStatus,
      phaseReadiness,
      proofTracking,
    });

    const summary = {
      generatedAt: new Date().toISOString(),
      tag: args.tag,
      candidates: resolve(args.candidates),
      sourceId: args.sourceId ?? null,
      protocolProfile: args.protocolProfile ?? null,
      multipleTestingUnit: args.multipleTestingUnit ?? "candidate",
      fdrMethod: args.fdrMethod ?? "bh",
      wfoProfile: args.wfoProfile ?? "stable",
      methodologyArgs: {
        storeyLambda: args.storeyLambda ?? null,
        cvAggQuantile: args.cvAggQuantile ?? null,
      },
      outputs: {
        validationRuns: resolve(args.output),
        verdict: resolve(args.verdictOutput),
        releaseGateStatus: resolve(args.releaseGateStatusPath),
        phaseReadiness: resolve(args.phaseReadinessOutput),
        proofTarget: resolve(proofPaths.targetPath),
        proofSnapshots: resolve(proofPaths.snapshotsPath),
        proofTrades: resolve(proofPaths.tradesPath),
      },
      phases: buildPhaseSummary(verdict, effectivePhaseReadiness, proofTracking),
    };

    await mkdir(dirname(resolve(args.statusOutput)), { recursive: true });
    await Promise.all([
      writeFile(
        resolve(args.statusOutput),
        `${JSON.stringify(summary, null, 2)}\n`,
        "utf-8",
      ),
      writeFile(
        resolve(args.phaseReadinessOutput),
        `${JSON.stringify(effectivePhaseReadiness, null, 2)}\n`,
        "utf-8",
      ),
    ]);

    await appendExecutionJournal({
      runId,
      batchId: args.tag,
      stage: "route",
      action: "route",
      status: "completed",
      inputs: journalInputs,
      outputs: {
        ...journalOutputs,
        proofTarget: resolve(proofPaths.targetPath),
        proofSnapshots: resolve(proofPaths.snapshotsPath),
        proofTrades: resolve(proofPaths.tradesPath),
      },
      summaryMetrics: extractSummaryMetrics(verdict ?? validationRuns),
      decision:
        (verdict as { result?: unknown } | null)?.result === "GO"
          ? "promoted_to_route"
          : "failed",
      codeRefs: ["scripts/run_route_af.ts", "scripts/run_strategy_mvp_validation.ts"],
    });

    console.log(
      [
        `route-af status: ${resolve(args.statusOutput)}`,
        `validation=${args.runValidation ? "ran" : "skipped"}`,
        `source=${args.sourceId ?? "unknown"}`,
        `profile=${args.protocolProfile ?? "default"}`,
        `fdr=${args.fdrMethod ?? "bh"}`,
        `wfo=${args.wfoProfile ?? "stable"}`,
        `research=${String(summary.phases.research.status)}`,
        `paper=${String(summary.phases.paper.status)}`,
        `live=${String(summary.phases.live.status)}`,
        `proof=${String(summary.phases.proof.status)}`,
      ].join(" | "),
    );
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: args.tag,
      stage: "route",
      action: "route",
      status: "failed",
      inputs: journalInputs,
      outputs: journalOutputs,
      decision: "failed",
      codeRefs: ["scripts/run_route_af.ts", "scripts/run_strategy_mvp_validation.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

function buildEffectivePhaseReadiness(input: {
  verdict: unknown;
  releaseGateStatus: unknown;
  phaseReadiness: unknown;
  proofTracking: Awaited<ReturnType<typeof loadRuntimeProofTracking>>;
}) {
  if (input.phaseReadiness && typeof input.phaseReadiness === "object") {
    return input.phaseReadiness as Record<string, unknown>;
  }

  const verdict =
    input.verdict && typeof input.verdict === "object"
      ? (input.verdict as {
          result?: unknown;
          reasonCodes?: unknown;
        })
      : {};
  const releaseGate =
    input.releaseGateStatus && typeof input.releaseGateStatus === "object"
      ? (input.releaseGateStatus as {
          allowPaperTrading?: unknown;
          allowLiveTrading?: unknown;
          failedChecks?: unknown;
        })
      : {};

  const researchReady = verdict.result === "GO";
  const paperReady = researchReady && releaseGate.allowPaperTrading === true;
  const liveStatus =
    !paperReady
      ? "blocked"
      : releaseGate.allowLiveTrading === true
        ? "normal_cap_ready"
        : "tiny_cap_ready";

  return {
    research: {
      status: researchReady ? "ready" : "blocked",
      ready: researchReady,
      blockingReasons: Array.isArray(verdict.reasonCodes) ? verdict.reasonCodes : [],
      warnings: [],
    },
    paper: {
      status: paperReady ? "active_ready" : "blocked",
      ready: paperReady,
      allowPaperTrading: releaseGate.allowPaperTrading === true,
      hasNonFlatTarget: false,
      executionPlanKind: paperReady ? "active" : "blocked",
      blockingReasons: Array.isArray(verdict.reasonCodes) ? verdict.reasonCodes : [],
      warnings: [],
    },
    liveTinyCapital: {
      status: liveStatus,
      ready: liveStatus !== "blocked",
      capitalMode:
        liveStatus === "normal_cap_ready"
          ? "normal_cap"
          : liveStatus === "tiny_cap_ready"
            ? "tiny_cap_only"
            : "not_ready",
      capitalRampStage: null,
      regimeSeverity: null,
      releaseGateAllowsPaperTrading: releaseGate.allowPaperTrading === true,
      releaseGateAllowsLiveTrading: releaseGate.allowLiveTrading === true,
      blockingReasons: paperReady ? [] : ["paper_not_ready_for_nonflat"],
    },
    proofTracking: {
      status: input.proofTracking.status ?? "not_started",
      readyToStart: paperReady,
      elapsedDays: input.proofTracking.elapsedDays ?? 0,
      targetDays: input.proofTracking.targetDays ?? 90,
      remainingDays: Math.max(
        (input.proofTracking.targetDays ?? 90) - (input.proofTracking.elapsedDays ?? 0),
        0,
      ),
      netPnlPositive: input.proofTracking.netPnlPositive ?? null,
      maxDrawdownPct: input.proofTracking.maxDrawdownPct ?? null,
      drawdownBudgetPct: input.proofTracking.drawdownBudgetPct ?? 10,
      blockingReasons: input.proofTracking.blockingReasons ?? [],
      warnings: input.proofTracking.warnings ?? [],
      source: input.proofTracking.source ?? null,
    },
  };
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const tag = raw.get("tag") ?? "route_batch3.v1";
  return {
    candidates:
      raw.get("candidates") ??
      "docs/research/strategy_candidates.route_batch3.v1.json",
    tag,
    runValidation: parseBool(raw.get("runValidation"), true),
    output:
      raw.get("output") ??
      `data/research/strategy/strategy_validation_runs.${tag}.json`,
    verdictOutput:
      raw.get("verdictOutput") ??
      `data/research/strategy/experiment_verdict.${tag}.json`,
    releaseGateStatusPath:
      raw.get("releaseGateStatusPath") ??
      `data/runtime/release_gate_status.${tag}.json`,
    statusOutput:
      raw.get("statusOutput") ?? "data/runtime/route_af_status.latest.json",
    phaseReadinessOutput:
      raw.get("phaseReadinessOutput") ??
      `data/runtime/phase_readiness.${tag}.json`,
    multipleTestingUnit:
      raw.get("multiple-testing-unit") === "family" ||
      raw.get("multipleTestingUnit") === "family"
        ? "family"
        : raw.get("multiple-testing-unit") === "candidate" ||
            raw.get("multipleTestingUnit") === "candidate"
          ? "candidate"
          : undefined,
    sourceId: raw.get("source-id") ?? raw.get("sourceId") ?? undefined,
    protocolProfile:
      raw.get("protocol-profile") ?? raw.get("protocolProfile") ?? undefined,
    fdrMethod:
      raw.get("fdr-method") === "by" ||
      raw.get("fdr-method") === "cv_storey_bh" ||
      raw.get("fdr-method") === "stepc" ||
      raw.get("fdr-method") === "spa"
        ? (raw.get("fdr-method") as
            | "by"
            | "cv_storey_bh"
            | "stepc"
            | "spa")
        : raw.get("fdr-method") === "bh"
          ? "bh"
          : undefined,
    wfoProfile:
      raw.get("wfo-profile") === "shift" ||
      raw.get("wfo-profile") === "stress" ||
      raw.get("wfo-profile") === "stable"
        ? (raw.get("wfo-profile") as "stable" | "shift" | "stress")
        : undefined,
    storeyLambda: parseOptionalNumber(raw.get("storey-lambda")),
    cvAggQuantile: parseOptionalNumber(raw.get("cv-agg-quantile")),
  };
}

async function runValidation(args: CliArgs): Promise<void> {
  const execArgs = [
    "--import",
    "tsx",
    "./scripts/run_strategy_mvp_validation.ts",
    "--candidates",
    args.candidates,
    "--output",
    args.output,
    "--verdict-output",
    args.verdictOutput,
    "--release-gate-status-path",
    args.releaseGateStatusPath,
  ];
  if (args.multipleTestingUnit) {
    execArgs.push("--multiple-testing-unit", args.multipleTestingUnit);
  }
  if (args.fdrMethod) {
    execArgs.push("--fdr-method", args.fdrMethod);
  }
  if (args.wfoProfile) {
    execArgs.push("--wfo-profile", args.wfoProfile);
  }
  if (args.storeyLambda !== undefined) {
    execArgs.push("--storey-lambda", String(args.storeyLambda));
  }
  if (args.cvAggQuantile !== undefined) {
    execArgs.push("--cv-agg-quantile", String(args.cvAggQuantile));
  }
  await execNode(execArgs);
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function buildPhaseSummary(
  verdict: unknown,
  phaseReadiness: unknown,
  proofTracking: Awaited<ReturnType<typeof loadRuntimeProofTracking>>,
) {
  const verdictObj =
    verdict && typeof verdict === "object"
      ? (verdict as {
          result?: unknown;
          aggregateMetrics?: unknown;
          reasonCodes?: unknown;
        })
      : {};
  const readinessObj =
    phaseReadiness && typeof phaseReadiness === "object"
      ? (phaseReadiness as Record<string, unknown>)
      : {};

  return {
    research: {
      status:
        typeof verdictObj.result === "string"
          ? verdictObj.result === "GO"
            ? "ready"
            : "blocked"
          : "unknown",
      result: verdictObj.result ?? null,
      aggregateMetrics: verdictObj.aggregateMetrics ?? null,
      reasonCodes: verdictObj.reasonCodes ?? [],
    },
    paper: readinessObj.paper ?? {
      status: "unknown",
      ready: false,
    },
    live: readinessObj.liveTinyCapital ?? {
      status: "unknown",
      ready: false,
    },
    proof: proofTracking,
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
    out.set(key, next);
  }
  return out;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

async function execNode(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0 || code === 2) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Command failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function readJsonOrNull(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(resolve(path), "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error("run_route_af failed:", error);
  process.exitCode = 1;
});
