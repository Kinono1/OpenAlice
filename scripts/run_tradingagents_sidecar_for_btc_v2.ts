import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import {
  appendExecutionJournal,
  readJsonIfExists,
  sanitizeError,
} from "./lib/execution_journal.js";

const TOTAL_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 45_000;

interface CliArgs {
  request: string;
  output: string;
  mode: "smoke" | "full";
  tradingAgentsRoot: string;
}

interface ResearchDecision {
  provenance?: {
    producer?: string;
    mode?: string;
    evidenceStrength?: string;
    generation?: string;
  };
}

interface SidecarResult {
  exitCode: number | null;
  timedOut: boolean;
}

interface ArtifactPaths {
  output: string;
  failure: string;
  diagnostics: string;
  probeOutput: string;
  probeDiagnostics: string;
}

interface DiagnosticPayload {
  failureBucket?: string;
  failureMessage?: string;
  success?: boolean | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `tradingagents_sidecar.${new Date().toISOString().replace(/[:.]/g, "")}`;
  const paths = deriveArtifactPaths(args.output);
  let failureAlreadyLogged = false;

  await appendExecutionJournal({
    runId,
    batchId: "btc_paradigm_tradingagents_sidecar",
    stage: "research_sidecar",
    action: "sidecar",
    status: "started",
    inputs: {
      request: resolve(args.request),
      mode: args.mode,
      tradingAgentsRoot: resolve(args.tradingAgentsRoot),
    },
    outputs: {
      output: resolve(paths.output),
      diagnostics: resolve(paths.diagnostics),
      probeOutput: resolve(paths.probeOutput),
      probeDiagnostics: resolve(paths.probeDiagnostics),
    },
    decision: "started",
    codeRefs: ["scripts/run_tradingagents_sidecar_for_btc_v2.ts"],
  });

  try {
    await mkdir(dirname(resolve(paths.output)), { recursive: true });

    const probeResult = await execPythonWithTimeout({
      args,
      outputPath: paths.probeOutput,
      diagnosticsPath: paths.probeDiagnostics,
      timeoutMs: PROBE_TIMEOUT_MS,
      probeOnly: true,
    });

    if (probeResult.timedOut) {
      await ensureDiagnosticsFallback(
        paths.probeDiagnostics,
        "probe_failure",
        `TradingAgents probe timed out after ${PROBE_TIMEOUT_MS}ms.`,
      );
      await writeFailureArtifact(
        paths.failure,
        "probe_failure",
        `TradingAgents diagnostic probe timed out after ${PROBE_TIMEOUT_MS}ms.`,
      );
      await appendExecutionJournal({
        runId,
        batchId: "btc_paradigm_tradingagents_sidecar",
        stage: "research_sidecar",
        action: "probe",
        status: "failed",
        inputs: {
          request: resolve(args.request),
          mode: args.mode,
        },
        outputs: {
          probeOutput: resolve(paths.probeOutput),
          probeDiagnostics: resolve(paths.probeDiagnostics),
          failure: resolve(paths.failure),
        },
        decision: "failed",
        codeRefs: ["scripts/run_tradingagents_sidecar_for_btc_v2.ts"],
        notes: [`probeTimeoutMs=${PROBE_TIMEOUT_MS}`],
      });
      failureAlreadyLogged = true;
      throw new Error(`TradingAgents diagnostic probe timed out after ${PROBE_TIMEOUT_MS}ms.`);
    }

    if (probeResult.exitCode !== 0) {
      const probeDiagnostics = await readJsonIfExists<DiagnosticPayload>(paths.probeDiagnostics);
      const failureBucket = probeDiagnostics?.failureBucket ?? "probe_failure";
      const failureMessage =
        probeDiagnostics?.failureMessage ??
        `TradingAgents diagnostic probe exited with code ${probeResult.exitCode ?? "unknown"}.`;
      await ensureDiagnosticsFallback(paths.probeDiagnostics, failureBucket, failureMessage);
      await writeFailureArtifact(paths.failure, failureBucket, failureMessage);
      await appendExecutionJournal({
        runId,
        batchId: "btc_paradigm_tradingagents_sidecar",
        stage: "research_sidecar",
        action: "probe",
        status: "failed",
        inputs: {
          request: resolve(args.request),
          mode: args.mode,
        },
        outputs: {
          probeOutput: resolve(paths.probeOutput),
          probeDiagnostics: resolve(paths.probeDiagnostics),
          failure: resolve(paths.failure),
        },
        decision: "failed",
        codeRefs: ["scripts/run_tradingagents_sidecar_for_btc_v2.ts"],
        notes: [`probeExitCode=${probeResult.exitCode ?? "unknown"}`],
      });
      failureAlreadyLogged = true;
      throw new Error(failureMessage);
    }

    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_tradingagents_sidecar",
      stage: "research_sidecar",
      action: "probe",
      status: "completed",
      inputs: {
        request: resolve(args.request),
        mode: args.mode,
      },
      outputs: {
        probeOutput: resolve(paths.probeOutput),
        probeDiagnostics: resolve(paths.probeDiagnostics),
      },
      decision: "completed",
      codeRefs: ["scripts/run_tradingagents_sidecar_for_btc_v2.ts"],
    });

    const result = await execPythonWithTimeout({
      args,
      outputPath: paths.output,
      diagnosticsPath: paths.diagnostics,
      timeoutMs: TOTAL_TIMEOUT_MS,
      probeOnly: false,
    });

    if (result.timedOut) {
      await ensureDiagnosticsFallback(
        paths.diagnostics,
        "backend_wait_timeout",
        `TradingAgents sidecar timed out after ${TOTAL_TIMEOUT_MS}ms.`,
      );
      await writeFailureArtifact(
        paths.failure,
        "backend_wait_timeout",
        `TradingAgents sidecar timed out after ${TOTAL_TIMEOUT_MS}ms.`,
      );
      await appendExecutionJournal({
        runId,
        batchId: "btc_paradigm_tradingagents_sidecar",
        stage: "research_sidecar",
        action: "sidecar",
        status: "failed",
        inputs: {
          request: resolve(args.request),
          mode: args.mode,
        },
        outputs: {
          output: resolve(paths.output),
          diagnostics: resolve(paths.diagnostics),
          failure: resolve(paths.failure),
        },
        decision: "failed",
        codeRefs: ["scripts/run_tradingagents_sidecar_for_btc_v2.ts"],
        notes: [`timeoutMs=${TOTAL_TIMEOUT_MS}`],
      });
      failureAlreadyLogged = true;
      throw new Error(`TradingAgents sidecar timed out after ${TOTAL_TIMEOUT_MS}ms.`);
    }

    if (result.exitCode !== 0) {
      const diagnostics = await readJsonIfExists<DiagnosticPayload>(paths.diagnostics);
      const failureBucket = diagnostics?.failureBucket ?? "nonzero_exit";
      const failureMessage =
        diagnostics?.failureMessage ??
        `TradingAgents sidecar exited with code ${result.exitCode ?? "unknown"}.`;
      await ensureDiagnosticsFallback(paths.diagnostics, failureBucket, failureMessage);
      await writeFailureArtifact(paths.failure, failureBucket, failureMessage);
      await appendExecutionJournal({
        runId,
        batchId: "btc_paradigm_tradingagents_sidecar",
        stage: "research_sidecar",
        action: "sidecar",
        status: "failed",
        inputs: {
          request: resolve(args.request),
          mode: args.mode,
        },
        outputs: {
          output: resolve(paths.output),
          diagnostics: resolve(paths.diagnostics),
          failure: resolve(paths.failure),
        },
        decision: "failed",
        codeRefs: ["scripts/run_tradingagents_sidecar_for_btc_v2.ts"],
        notes: [`exitCode=${result.exitCode ?? "unknown"}`],
      });
      failureAlreadyLogged = true;
      throw new Error(failureMessage);
    }

    try {
      await normalizeLiveOutput(paths.output);
    } catch (error) {
      const failureMessage = `TradingAgents sidecar output normalization failed: ${sanitizeError(error)}`;
      await ensureDiagnosticsFallback(
        paths.diagnostics,
        "payload_normalization_failure",
        failureMessage,
      );
      await writeFailureArtifact(
        paths.failure,
        "payload_normalization_failure",
        failureMessage,
      );
      await appendExecutionJournal({
        runId,
        batchId: "btc_paradigm_tradingagents_sidecar",
        stage: "research_sidecar",
        action: "sidecar",
        status: "failed",
        inputs: {
          request: resolve(args.request),
          mode: args.mode,
        },
        outputs: {
          output: resolve(paths.output),
          diagnostics: resolve(paths.diagnostics),
          failure: resolve(paths.failure),
        },
        decision: "failed",
        codeRefs: ["scripts/run_tradingagents_sidecar_for_btc_v2.ts"],
        notes: [failureMessage],
      });
      failureAlreadyLogged = true;
      throw error;
    }

    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_tradingagents_sidecar",
      stage: "research_sidecar",
      action: "sidecar",
      status: "completed",
      inputs: {
        request: resolve(args.request),
        mode: args.mode,
      },
      outputs: {
        output: resolve(paths.output),
        diagnostics: resolve(paths.diagnostics),
      },
      decision: "completed",
      codeRefs: ["scripts/run_tradingagents_sidecar_for_btc_v2.ts"],
    });

    console.log(`output=${resolve(paths.output)} | mode=${args.mode}`);
  } catch (error) {
    if (!failureAlreadyLogged) {
      await appendExecutionJournal({
        runId,
        batchId: "btc_paradigm_tradingagents_sidecar",
        stage: "research_sidecar",
        action: "sidecar",
        status: "failed",
        inputs: {
          request: resolve(args.request),
          mode: args.mode,
        },
        outputs: {
          output: resolve(paths.output),
        },
        decision: "failed",
        codeRefs: ["scripts/run_tradingagents_sidecar_for_btc_v2.ts"],
        notes: [sanitizeError(error)],
      });
    }
    throw error;
  }
}

async function execPythonWithTimeout(input: {
  args: CliArgs;
  outputPath: string;
  diagnosticsPath: string;
  timeoutMs: number;
  probeOnly: boolean;
}): Promise<SidecarResult> {
  const root = resolve(input.args.tradingAgentsRoot);
  const pythonBin = await resolvePythonBin(root);
  const existingPythonPath = process.env.PYTHONPATH;

  return await new Promise<SidecarResult>((resolveResult, rejectResult) => {
    let timedOut = false;
    const scriptArgs = [
      "scripts/run_openalice_research_sidecar.py",
      "--request",
      resolve(input.args.request),
      "--mode",
      input.args.mode,
      "--output",
      resolve(input.outputPath),
      "--diagnostics-output",
      resolve(input.diagnosticsPath),
      "--pretty",
    ];
    if (input.probeOnly) {
      scriptArgs.push("--probe-only");
    }

    const child = spawn(pythonBin, scriptArgs, {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        TRADINGAGENTS_RUNTIME_ROOT: root,
        PYTHONPATH: existingPythonPath ? `${root}:${existingPythonPath}` : root,
      },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, input.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectResult(error);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveResult({
        exitCode: code,
        timedOut,
      });
    });
  });
}

async function normalizeLiveOutput(path: string): Promise<void> {
  const outputPath = resolve(path);
  const payload = JSON.parse(await readFile(outputPath, "utf-8")) as ResearchDecision;
  payload.provenance = {
    producer: payload.provenance?.producer ?? "tradingagents.sidecar.live_completed",
    mode: payload.provenance?.mode ?? "sidecar_live",
    evidenceStrength: payload.provenance?.evidenceStrength ?? "live",
    generation: payload.provenance?.generation ?? "v2_live_donor",
  };
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function ensureDiagnosticsFallback(
  path: string,
  failureBucket: string,
  failureMessage: string,
): Promise<void> {
  const existing = await readJsonIfExists<Record<string, unknown>>(path);
  if (existing) {
    return;
  }
  const payload = {
    schemaVersion: "tradingagents_sidecar_diagnostics.v1",
    generatedAt: new Date().toISOString(),
    success: false,
    failureBucket,
    failureMessage,
    stages: [],
  };
  await writeFile(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function writeFailureArtifact(
  path: string,
  failureCode: string,
  failureMessage: string,
): Promise<void> {
  const payload = {
    schemaVersion: "research_decision.v1",
    generatedAt: new Date().toISOString(),
    symbol: "BTC/USD",
    decisionContext: {
      releaseGateMode: "paper",
    },
    marketContext: null,
    provenance: {
      producer: "tradingagents.sidecar.live_failed",
      mode: "sidecar_failure",
      failureCode,
      failureMessage,
      evidenceStrength: "unavailable",
      generation: "v2_live_donor",
    },
    strategy: {
      signal: 0,
      reason: failureMessage,
      selectedStrategy: "tradingagents_sidecar_failure",
      selectorMode: "sidecar_failure",
      selectorReason: failureCode,
    },
    ml: {
      available: false,
      direction: "hold",
      actionable: false,
      error: failureCode,
    },
    news: {
      totalNews: 0,
      positiveNews: 0,
      negativeNews: 0,
      neutralNews: 0,
      highRiskNews: 0,
      sentimentScore: 0,
      riskScore: 0.5,
      topThemes: [],
      flags: [],
      latestHeadlines: [],
    },
    releaseGate: null,
    decision: {
      action: "flat",
      confidence: 0,
      tradeAllowed: false,
      blockedBy: [failureCode],
      reasons: [
        failureMessage,
        "Use the explicit proxy artifact if this cycle needs a deterministic fallback.",
      ],
      suggestedExposurePct: 0,
    },
  };

  await writeFile(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function resolvePythonBin(root: string): Promise<string> {
  const venvPython = resolve(root, ".venv/bin/python3");
  try {
    await access(venvPython);
    return venvPython;
  } catch {
    return "python3";
  }
}

function deriveArtifactPaths(output: string): ArtifactPaths {
  return {
    output,
    failure: replaceJsonSuffix(output, ".failure.json"),
    diagnostics: replaceJsonSuffix(output, ".diagnostics.json"),
    probeOutput: replaceJsonSuffix(output, ".probe.json"),
    probeDiagnostics: replaceJsonSuffix(output, ".probe.diagnostics.json"),
  };
}

function replaceJsonSuffix(path: string, suffix: string): string {
  return path.endsWith(".json") ? path.slice(0, -5) + suffix : `${path}${suffix}`;
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const request = raw.get("request");
  const output = raw.get("output");
  if (!request) throw new Error("--request is required.");
  if (!output) throw new Error("--output is required.");
  const mode = raw.get("mode") === "full" ? "full" : "smoke";
  return {
    request,
    output,
    mode,
    tradingAgentsRoot:
      raw.get("tradingagents-root") ??
      "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/TradingAgents",
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
