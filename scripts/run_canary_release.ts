import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { loadConfig } from "../src/core/config.js";
import {
  assertCanaryPhaseTransition,
  createDraftCanaryState,
  safeReadCanaryState,
  writeCanaryState,
  type CanaryEnvironment,
  type CanaryPhase,
  type CanaryState,
} from "../src/runtime/canary_state.js";
import {
  evaluateMicroLiveCanary,
  evaluatePaperCanary,
  type RuntimeHealthSnapshot,
} from "../src/runtime/canary_eval.js";
import {
  loadPaperChampionRegistry,
  validatePaperChampionRegistryForRuntime,
} from "../src/runtime/paper_champion_registry.js";
import { loadReleaseGateStatus } from "../src/runtime/release_gate_status.js";
import {
  evaluateLiveRolloutReadiness,
  loadLiveRolloutReadiness,
  loadPaperExecutorStatusArtifact,
  writeLiveRolloutReadiness,
  type LiveRolloutReadinessArtifact,
} from "../src/runtime/live_rollout_readiness.js";

const execFileAsync = promisify(execFile);

interface CliArgs {
  command:
    | "preflight"
    | "start-paper"
    | "evaluate-paper"
    | "approve-micro-live"
    | "start-micro-live"
    | "evaluate-micro-live"
    | "rollback"
    | "status";
  statePath?: string;
  approvedBy?: string;
  allowedSymbols?: string[];
  reason?: string;
}

interface CommandResult {
  ok: boolean;
  state?: CanaryState;
  blockingReasons?: string[];
  runtimeHealth?: RuntimeHealthSnapshot;
  rolloutReadiness?: LiveRolloutReadinessArtifact | null;
  command?: string;
  error?: string;
}

interface SubprocessResult {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const statePath = resolve(args.statePath ?? config.canary.statePath);

  const result = await runCommand(args, config, statePath);
  const exitCode = result.ok ? 0 : 2;
  console.log(
    JSON.stringify(
      {
        command: args.command,
        ok: result.ok,
        statePath,
        phase: result.state?.phase ?? null,
        blockingReasons: result.blockingReasons ?? result.state?.blockingReasons ?? [],
        runtimeHealth: result.runtimeHealth ?? null,
        rolloutReadiness: result.rolloutReadiness ?? null,
        error: result.error ?? null,
      },
      null,
      2,
    ),
  );
  process.exit(exitCode);
}

async function runCommand(
  args: CliArgs,
  config: Awaited<ReturnType<typeof loadConfig>>,
  statePath: string,
): Promise<CommandResult> {
  switch (args.command) {
    case "preflight":
      return runPreflight(config, statePath);
    case "start-paper":
      return transitionToPaperRunning(config, statePath);
    case "evaluate-paper":
      return evaluatePaper(config, statePath);
    case "approve-micro-live":
      return approveMicroLive(config, statePath, args);
    case "start-micro-live":
      return transitionToMicroLiveRunning(config, statePath);
    case "evaluate-micro-live":
      return evaluateMicroLive(config, statePath);
    case "rollback":
      return rollbackCanary(config, statePath, args.reason);
    case "status":
      return reportStatus(config, statePath);
    default:
      return { ok: false, error: `Unsupported command: ${String(args.command)}` };
  }
}

async function runPreflight(
  config: Awaited<ReturnType<typeof loadConfig>>,
  statePath: string,
): Promise<CommandResult> {
  const current = await loadStateForMutatingCommand(statePath, "preflight");
  const baseState = current ?? createDraftCanaryState();
  assertCanaryPhaseTransition(baseState.phase, "preflight_passed");

  const artifacts = defaultArtifacts(config);
  const commands = [
    await runSubprocess("python3", [
      "scripts/gates_preflight.py",
      "--output",
      artifacts.gatesPreflightReportPath!,
    ]),
    await runSubprocess("python3", [
      "scripts/build_gate_checkpoints.py",
      "--output-dir",
      resolve("data/runtime/gates"),
    ]),
    await runSubprocess(process.execPath, [
      "--import",
      "tsx",
      "scripts/run_paper_runtime_diagnostic.ts",
      "--statusOutput",
      artifacts.paperDiagnosticStatusPath!,
      "--releaseGateStatusPath",
      artifacts.releaseGateStatusPath!,
    ]),
  ];

  const blockingReasons: string[] = commands
    .filter((result) => !result.ok)
    .map((result) => `canary_preflight_command_failed:${result.command}`);

  const [releaseGateStatus, registry] = await Promise.all([
    loadReleaseGateStatus(artifacts.releaseGateStatusPath),
    loadPaperChampionRegistry(artifacts.paperChampionRegistryPath!),
  ]);

  if (!releaseGateStatus?.allowPaperTrading) {
    blockingReasons.push("canary_release_gate_not_approved");
  }
  const registryValidation = validatePaperChampionRegistryForRuntime(registry);
  if (!registryValidation.championLoaded || !registryValidation.checksumValid || !registryValidation.policyVersionMatch) {
    blockingReasons.push(...registryValidation.blockingReasons.map((reason) => `canary_registry:${reason}`));
  }

  const nextPhase: CanaryPhase =
    blockingReasons.length === 0 ? "preflight_passed" : "blocked";
  const nextEnvironment: CanaryEnvironment = "paper";
  const nowIso = new Date().toISOString();
  const state = await writeCanaryState({
    ...baseState,
    phase: nextPhase,
    environment: nextEnvironment,
    artifacts: {
      ...baseState.artifacts,
      ...artifacts,
    },
    window: {
      startedAt: undefined,
      completedAt: undefined,
      minObservationMinutes: config.canary.paper.observationMinMinutes,
    },
    metrics: {
      ...baseState.metrics,
      eventCounts: {
        ...baseState.metrics.eventCounts,
      },
    },
    blockingReasons,
    approvedBy: undefined,
    allowedSymbols: [],
    limits: {},
    lastTransitionAt: nowIso,
  }, statePath);

  return {
    ok: blockingReasons.length === 0,
    state,
    blockingReasons,
  };
}

async function transitionToPaperRunning(
  config: Awaited<ReturnType<typeof loadConfig>>,
  statePath: string,
): Promise<CommandResult> {
  const current = await requireValidState(statePath);
  assertCanaryPhaseTransition(current.phase, "paper_running");
  const nowIso = new Date().toISOString();
  const state = await writeCanaryState({
    ...current,
    phase: "paper_running",
    environment: "paper",
    window: {
      startedAt: nowIso,
      completedAt: undefined,
      minObservationMinutes: config.canary.paper.observationMinMinutes,
    },
    metrics: {
      ...current.metrics,
      eventCounts: {
        heartbeatErrors: 0,
        gateCircuitOpen: 0,
        cronPaused: 0,
        pnlReconciliationAlerts: 0,
        paperExecutorFailures: 0,
        idempotencyDuplicates: 0,
      },
    },
    blockingReasons: [],
    lastTransitionAt: nowIso,
  }, statePath);
  return { ok: true, state };
}

async function evaluatePaper(
  config: Awaited<ReturnType<typeof loadConfig>>,
  statePath: string,
): Promise<CommandResult> {
  const current = await requireValidState(statePath);
  if (current.phase !== "paper_running") {
    return {
      ok: false,
      state: current,
      error: `evaluate-paper requires phase paper_running, got ${current.phase}`,
    };
  }

  const runtimeHealth = await probeRuntimeHealth(config);
  const evaluation = await evaluatePaperCanary({
    config: config.canary,
    state: current,
    runtimeHealth,
  });
  const nextPhase: CanaryPhase = evaluation.passed ? "paper_passed" : "blocked";
  const nowIso = new Date().toISOString();
  const state = await writeCanaryState({
    ...current,
    phase: nextPhase,
    environment: "paper",
    metrics: evaluation.metrics,
    blockingReasons: evaluation.blockingReasons,
    window: {
      ...current.window,
      completedAt: nowIso,
    },
    lastTransitionAt: nowIso,
  }, statePath);

  return {
    ok: evaluation.passed,
    state,
    blockingReasons: evaluation.blockingReasons,
    runtimeHealth,
  };
}

async function approveMicroLive(
  config: Awaited<ReturnType<typeof loadConfig>>,
  statePath: string,
  args: CliArgs,
): Promise<CommandResult> {
  const current = await requireValidState(statePath);
  assertCanaryPhaseTransition(current.phase, "micro_live_approved");
  const rolloutReadiness = await evaluateAndPersistRolloutReadiness(
    config,
    current.artifacts,
  );
  if (rolloutReadiness && !rolloutReadiness.readyForMicroLive) {
    return {
      ok: false,
      state: current,
      blockingReasons: rolloutReadiness.blockingReasons,
      rolloutReadiness,
      error: "live rollout not ready for micro-live approval",
    };
  }
  const approvedSymbols = normalizeApprovedSymbols(
    args.allowedSymbols,
    config,
  );
  if (approvedSymbols.length > config.canary.microLive.maxSymbols) {
    return {
      ok: false,
      state: current,
      error: `allowedSymbols exceeds maxSymbols=${config.canary.microLive.maxSymbols}`,
    };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + config.canary.microLive.approvalTtlHours * 60 * 60 * 1000,
  ).toISOString();
  const approvedBy = args.approvedBy ?? process.env.USER ?? process.env.LOGNAME ?? "unknown";
  const state = await writeCanaryState({
    ...current,
    phase: "micro_live_approved",
    environment: "micro_live",
    artifacts: {
      ...defaultArtifacts(config),
      ...current.artifacts,
    },
    approvedBy,
    allowedSymbols: approvedSymbols,
    limits: {
      maxSymbols: config.canary.microLive.maxSymbols,
      maxConcurrentOpens: config.canary.microLive.maxConcurrentOpens,
      maxNotionalUsd: config.canary.microLive.maxNotionalUsd,
      maxEquityPct: config.canary.microLive.maxEquityPct,
    },
    window: {
      startedAt: undefined,
      completedAt: undefined,
      minObservationMinutes: config.canary.microLive.observationMinMinutes,
      expiresAt,
    },
    blockingReasons: [],
    metrics: {
      ...current.metrics,
      eventCounts: {
        heartbeatErrors: 0,
        gateCircuitOpen: 0,
        cronPaused: 0,
        pnlReconciliationAlerts: 0,
        paperExecutorFailures: 0,
        idempotencyDuplicates: 0,
      },
    },
    lastTransitionAt: nowIso,
  }, statePath);
  return { ok: true, state, rolloutReadiness };
}

async function transitionToMicroLiveRunning(
  config: Awaited<ReturnType<typeof loadConfig>>,
  statePath: string,
): Promise<CommandResult> {
  const current = await requireValidState(statePath);
  assertCanaryPhaseTransition(current.phase, "micro_live_running");
  if (isExpired(current, new Date())) {
    const state = await writeCanaryState({
      ...current,
      phase: "blocked",
      blockingReasons: ["canary_state_expired"],
      lastTransitionAt: new Date().toISOString(),
    }, statePath);
    return {
      ok: false,
      state,
      blockingReasons: state.blockingReasons,
      error: "micro-live approval expired",
    };
  }

  const rolloutReadiness = await evaluateAndPersistRolloutReadiness(
    config,
    current.artifacts,
  );
  if (rolloutReadiness && !rolloutReadiness.readyForMicroLive) {
    const state = await writeCanaryState({
      ...current,
      phase: "blocked",
      artifacts: {
        ...defaultArtifacts(config),
        ...current.artifacts,
      },
      blockingReasons: rolloutReadiness.blockingReasons,
      lastTransitionAt: new Date().toISOString(),
    }, statePath);
    return {
      ok: false,
      state,
      blockingReasons: state.blockingReasons,
      rolloutReadiness,
      error: "live rollout not ready for micro-live start",
    };
  }

  const nowIso = new Date().toISOString();
  const state = await writeCanaryState({
    ...current,
    phase: "micro_live_running",
    environment: "micro_live",
    artifacts: {
      ...defaultArtifacts(config),
      ...current.artifacts,
    },
    window: {
      ...current.window,
      startedAt: nowIso,
      completedAt: undefined,
    },
    metrics: {
      ...current.metrics,
      eventCounts: {
        heartbeatErrors: 0,
        gateCircuitOpen: 0,
        cronPaused: 0,
        pnlReconciliationAlerts: 0,
        paperExecutorFailures: 0,
        idempotencyDuplicates: 0,
      },
    },
    blockingReasons: [],
    lastTransitionAt: nowIso,
  }, statePath);
  return { ok: true, state, rolloutReadiness };
}

async function evaluateMicroLive(
  config: Awaited<ReturnType<typeof loadConfig>>,
  statePath: string,
): Promise<CommandResult> {
  const current = await requireValidState(statePath);
  if (current.phase !== "micro_live_running") {
    return {
      ok: false,
      state: current,
      error: `evaluate-micro-live requires phase micro_live_running, got ${current.phase}`,
    };
  }

  const runtimeHealth = await probeRuntimeHealth(config);
  const evaluation = await evaluateMicroLiveCanary({
    config: config.canary,
    state: current,
    runtimeHealth,
  });
  const nextPhase: CanaryPhase = evaluation.passed ? "micro_live_passed" : "blocked";
  const nowIso = new Date().toISOString();
  const state = await writeCanaryState({
    ...current,
    phase: nextPhase,
    environment: "micro_live",
    metrics: evaluation.metrics,
    blockingReasons: evaluation.blockingReasons,
    window: {
      ...current.window,
      completedAt: nowIso,
    },
    lastTransitionAt: nowIso,
  }, statePath);

  return {
    ok: evaluation.passed,
    state,
    blockingReasons: evaluation.blockingReasons,
    runtimeHealth,
  };
}

async function rollbackCanary(
  config: Awaited<ReturnType<typeof loadConfig>>,
  statePath: string,
  reason: string | undefined,
): Promise<CommandResult> {
  const current = await loadStateForMutatingCommand(statePath, "rollback");
  const baseState = current ?? createDraftCanaryState();
  const nextPhase = "rolled_back";
  if (current) {
    assertCanaryPhaseTransition(baseState.phase, nextPhase);
  }
  const state = await writeCanaryState({
    ...baseState,
    phase: nextPhase,
    environment: baseState.environment,
    blockingReasons: [reason ?? "manual_rollback"],
    lastTransitionAt: new Date().toISOString(),
    artifacts: {
      ...defaultArtifacts(config),
      ...baseState.artifacts,
    },
  }, statePath);
  return { ok: true, state };
}

async function reportStatus(
  config: Awaited<ReturnType<typeof loadConfig>>,
  statePath: string,
): Promise<CommandResult> {
  const readResult = await safeReadCanaryState(statePath);
  if (!readResult.ok) {
    return {
      ok: false,
      command: "status",
      error: `canary_state_${readResult.reason}`,
      blockingReasons: [`canary_state_${readResult.reason}`],
    };
  }
  const runtimeHealth = await probeRuntimeHealth(config);
  const rolloutReadiness = await loadLiveRolloutReadiness(
    readResult.state.artifacts.liveRolloutReadinessPath ??
      resolve(config.governance.rolloutReadiness.statusPath),
  );
  return {
    ok: true,
    state: readResult.state,
    runtimeHealth,
    rolloutReadiness,
    blockingReasons: readResult.state.blockingReasons,
  };
}

async function requireValidState(statePath: string): Promise<CanaryState> {
  const result = await safeReadCanaryState(statePath);
  if (!result.ok) {
    throw new Error(`Invalid canary state: ${result.reason}`);
  }
  return result.state;
}

async function loadStateForMutatingCommand(
  statePath: string,
  command: CliArgs["command"],
): Promise<CanaryState | null> {
  const result = await safeReadCanaryState(statePath);
  if (!result.ok) {
    if (command === "preflight" || command === "rollback") {
      return null;
    }
    throw new Error(`Invalid canary state: ${result.reason}`);
  }
  return result.state;
}

function normalizeApprovedSymbols(
  rawSymbols: string[] | undefined,
  config: Awaited<ReturnType<typeof loadConfig>>,
): string[] {
  const base =
    rawSymbols && rawSymbols.length > 0
      ? rawSymbols
      : config.crypto.allowedSymbols.length > 0
        ? config.crypto.allowedSymbols
        : config.engine.pairs;
  return [...new Set(base.map((symbol) => symbol.trim()).filter(Boolean))];
}

function defaultArtifacts(
  config: Awaited<ReturnType<typeof loadConfig>>,
): CanaryState["artifacts"] {
  return {
    gatesPreflightReportPath: resolve("data/runtime/gates_preflight_report.json"),
    paperDiagnosticStatusPath: resolve("data/runtime/paper_diagnostic_status.latest.json"),
    paperExecutorStatusPath: resolve("data/runtime/paper_executor_status.latest.json"),
    releaseGateStatusPath: resolve(config.governance.releaseGate.statusPath),
    paperChampionRegistryPath: resolve("data/runtime/paper_champion_registry.json"),
    liveRolloutReadinessPath: resolve(
      config.governance.rolloutReadiness.statusPath,
    ),
    gateCheckpointsIndexPath: resolve("data/runtime/gates/gate_checkpoints_index.v1.json"),
    walletStatePath: resolve("data/crypto-trading/commit.json"),
  };
}

async function evaluateAndPersistRolloutReadiness(
  config: Awaited<ReturnType<typeof loadConfig>>,
  existingArtifacts: CanaryState["artifacts"],
): Promise<LiveRolloutReadinessArtifact | null> {
  if (!config.governance.rolloutReadiness.enabled) {
    return null;
  }

  const artifacts = {
    ...defaultArtifacts(config),
    ...existingArtifacts,
  };
  const [releaseGateStatus, registry, paperExecutorStatus] = await Promise.all([
    loadReleaseGateStatus(artifacts.releaseGateStatusPath),
    loadPaperChampionRegistry(artifacts.paperChampionRegistryPath!),
    loadPaperExecutorStatusArtifact(artifacts.paperExecutorStatusPath!),
  ]);
  const registryValidation = validatePaperChampionRegistryForRuntime(registry);
  const readiness = evaluateLiveRolloutReadiness({
    releaseGateStatus,
    registry,
    registryValidation,
    paperExecutorStatus,
    config: {
      maxExecutionCostBps: config.governance.rolloutReadiness.maxExecutionCostBps,
      requireEdgeDecayStable:
        config.governance.rolloutReadiness.requireEdgeDecayStable,
      requirePromotedCandidateVerdict:
        config.governance.rolloutReadiness.requirePromotedCandidateVerdict,
      requirePortfolioTargetsForExecutedOpens:
        config.governance.rolloutReadiness.requirePortfolioTargetsForExecutedOpens,
    },
    sourcePaths: {
      releaseGateStatusPath: artifacts.releaseGateStatusPath,
      paperChampionRegistryPath: artifacts.paperChampionRegistryPath,
      paperExecutorStatusPath: artifacts.paperExecutorStatusPath,
    },
  });
  await writeLiveRolloutReadiness(
    readiness,
    artifacts.liveRolloutReadinessPath,
  );
  return readiness;
}

async function probeRuntimeHealth(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<RuntimeHealthSnapshot> {
  const baseUrl = `http://127.0.0.1:${config.connectors.web.port}`;
  const [registry, heartbeat, account] = await Promise.all([
    fetchJson(`${baseUrl}/api/dev/registry`),
    fetchJson(`${baseUrl}/api/heartbeat/status`),
    fetchJson(`${baseUrl}/api/crypto/account`),
  ]);

  const connectors = Array.isArray((registry.payload as { connectors?: unknown[] } | null)?.connectors)
    ? ((registry.payload as { connectors?: Array<{ channel?: string }> }).connectors ?? [])
    : [];
  const connectorChannels = new Set(
    connectors
      .map((connector) => connector?.channel)
      .filter((value): value is string => typeof value === "string"),
  );

  return {
    connectorsHealthy:
      connectorChannels.has("web") &&
      (!configHasTelegramRequired(config) || connectorChannels.has("telegram")),
    heartbeatEnabled:
      heartbeat.ok &&
      typeof (heartbeat.payload as { enabled?: unknown } | null)?.enabled === "boolean"
        ? Boolean((heartbeat.payload as { enabled?: boolean }).enabled)
        : false,
    cryptoAccountReadable: account.ok,
  };
}

async function fetchJson(
  url: string,
): Promise<{ ok: boolean; payload: unknown | null }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      return { ok: false, payload: null };
    }
    return { ok: true, payload: await response.json() };
  } catch {
    return { ok: false, payload: null };
  }
}

function configHasTelegramRequired(
  config: Awaited<ReturnType<typeof loadConfig>>,
): boolean {
  return Boolean(config.connectors.telegram.enabled);
}

function isExpired(state: CanaryState, now: Date): boolean {
  if (!state.window.expiresAt) {
    return false;
  }
  const expiresAt = Date.parse(state.window.expiresAt);
  return Number.isFinite(expiresAt) && now.getTime() > expiresAt;
}

async function runSubprocess(
  command: string,
  args: string[],
): Promise<SubprocessResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: process.cwd(),
    });
    return {
      ok: true,
      command: [command, ...args].join(" "),
      exitCode: 0,
      stdout,
      stderr,
    };
  } catch (err) {
    const exitCode =
      err instanceof Error && "code" in err && typeof err.code === "number"
        ? err.code
        : 1;
    const stdout =
      err && typeof err === "object" && "stdout" in err && typeof err.stdout === "string"
        ? err.stdout
        : "";
    const stderr =
      err && typeof err === "object" && "stderr" in err && typeof err.stderr === "string"
        ? err.stderr
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ok: false,
      command: [command, ...args].join(" "),
      exitCode,
      stdout,
      stderr,
    };
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const command = argv[0] as CliArgs["command"] | undefined;
  if (
    !command ||
    ![
      "preflight",
      "start-paper",
      "evaluate-paper",
      "approve-micro-live",
      "start-micro-live",
      "evaluate-micro-live",
      "rollback",
      "status",
    ].includes(command)
  ) {
    throw new Error(
      "Usage: run_canary_release.ts <preflight|start-paper|evaluate-paper|approve-micro-live|start-micro-live|evaluate-micro-live|rollback|status> [--statePath path] [--approvedBy name] [--allowedSymbols BTC/USD,ETH/USD] [--reason text]",
    );
  }
  return {
    command,
    statePath: raw.get("statePath"),
    approvedBy: raw.get("approvedBy"),
    allowedSymbols: raw.get("allowedSymbols")
      ? raw
          .get("allowedSymbols")!
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : undefined,
    reason: raw.get("reason"),
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
    out.set(key, next);
    i += 1;
  }
  return out;
}

main().catch((err) => {
  console.error("run_canary_release failed:", err);
  process.exit(1);
});
