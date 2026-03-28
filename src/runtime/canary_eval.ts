import { readFile } from "node:fs/promises";
import type { Config } from "../core/config.js";
import type { WalletExportState } from "../extension/crypto-trading/index.js";
import type { CanaryState } from "./canary_state.js";

const DEFAULT_EVENT_LOG_PATH = "data/event-log/events.jsonl";
const DEFAULT_WALLET_STATE_PATH = "data/crypto-trading/commit.json";

type GateSummaryStatus = "PASS" | "BLOCKED";

interface PaperDiagnosticStatusArtifact {
  generatedAt: string;
  preflight: {
    releaseGateState: "missing" | "blocked" | "pass";
    releaseGateReason?: string;
    championRegistryState: "missing" | "blocked" | "pass";
    championRegistryReasons: string[];
  };
  summary: {
    releaseGate: GateSummaryStatus;
    paperGate: GateSummaryStatus;
    blockingReasons: string[];
  };
}

interface PaperExecutorStatusArtifact {
  generatedAt: string;
  blockingReasons: string[];
  summary: {
    executor?: {
      executed: number;
      skipped: number;
      blocked: number;
    };
  };
}

interface PreflightReport {
  passed: boolean;
}

interface EventEntry {
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

export interface RuntimeHealthSnapshot {
  connectorsHealthy?: boolean;
  heartbeatEnabled?: boolean;
  cryptoAccountReadable?: boolean;
}

export interface CanaryEvaluationResult {
  passed: boolean;
  metrics: CanaryState["metrics"];
  blockingReasons: string[];
}

export interface EvaluateCanaryArtifactsInput {
  config: Config["canary"];
  state: CanaryState;
  now?: Date;
  runtimeHealth?: RuntimeHealthSnapshot;
  eventLogPath?: string;
  walletStatePath?: string;
}

export async function evaluatePaperCanary(
  input: EvaluateCanaryArtifactsInput,
): Promise<CanaryEvaluationResult> {
  const now = input.now ?? new Date();
  const startMs = resolveWindowStartMs(input.state);
  const endMs = now.getTime();
  const [preflight, diagnostic, executor, eventCounts, maxPendingOrderAgeMinutes] =
    await Promise.all([
      readJsonFile<PreflightReport>(
        input.state.artifacts.gatesPreflightReportPath,
      ),
      readJsonFile<PaperDiagnosticStatusArtifact>(
        input.state.artifacts.paperDiagnosticStatusPath,
      ),
      readJsonFile<PaperExecutorStatusArtifact>(
        input.state.artifacts.paperExecutorStatusPath,
      ),
      summarizeCanaryEvents(
        input.eventLogPath ?? DEFAULT_EVENT_LOG_PATH,
        startMs,
        endMs,
      ),
      computeMaxPendingOrderAgeMinutes(
        input.walletStatePath ??
          input.state.artifacts.walletStatePath ??
          DEFAULT_WALLET_STATE_PATH,
        endMs,
      ),
    ]);

  const metrics = {
    eventCounts,
    maxPendingOrderAgeMinutes,
    connectorsHealthy: input.runtimeHealth?.connectorsHealthy,
    heartbeatEnabled: input.runtimeHealth?.heartbeatEnabled,
    cryptoAccountReadable: input.runtimeHealth?.cryptoAccountReadable,
  } satisfies CanaryState["metrics"];

  const blockingReasons: string[] = [];
  if (!preflight?.passed) {
    blockingReasons.push("canary_preflight_not_passed");
  }
  if (!diagnostic) {
    blockingReasons.push("canary_paper_diagnostic_missing");
  } else {
    if (diagnostic.preflight.releaseGateState !== "pass") {
      blockingReasons.push(
        `canary_release_gate_state:${diagnostic.preflight.releaseGateState}`,
      );
    }
    if (diagnostic.preflight.championRegistryState !== "pass") {
      blockingReasons.push(
        `canary_champion_registry_state:${diagnostic.preflight.championRegistryState}`,
      );
    }
    if (diagnostic.summary.paperGate !== "PASS") {
      blockingReasons.push("canary_paper_gate_blocked");
    }
  }
  if (!executor) {
    blockingReasons.push("canary_paper_executor_status_missing");
  } else {
    if ((executor.summary.executor?.blocked ?? 0) > 0) {
      blockingReasons.push("canary_paper_executor_blocked");
    }
    if (executor.blockingReasons.length > 0) {
      blockingReasons.push(...executor.blockingReasons.map((reason) => `canary_executor_reason:${reason}`));
    }
  }

  applyObservationAndHealthThresholds(
    blockingReasons,
    input.config.paper.observationMinMinutes,
    startMs,
    endMs,
    metrics,
    input.config.paper.maxHeartbeatErrors,
    input.config.paper.maxGateCircuitOpen,
    input.config.paper.maxCronPaused,
    input.config.paper.maxPnlReconciliationAlerts,
    input.config.paper.maxIdempotencyDuplicates,
    input.config.paper.maxPendingOrderAgeMinutes,
    input.runtimeHealth,
  );

  const paperExecutorFailures =
    (executor?.summary.executor?.blocked ?? 0) +
    (executor?.blockingReasons.length ?? 0);
  metrics.eventCounts.paperExecutorFailures = paperExecutorFailures;
  if (paperExecutorFailures > input.config.paper.maxPaperExecutorFailures) {
    blockingReasons.push(
      `canary_paper_executor_failures:${paperExecutorFailures}`,
    );
  }

  return {
    passed: blockingReasons.length === 0,
    metrics,
    blockingReasons: unique(blockingReasons),
  };
}

export async function evaluateMicroLiveCanary(
  input: EvaluateCanaryArtifactsInput,
): Promise<CanaryEvaluationResult> {
  const now = input.now ?? new Date();
  const startMs = resolveWindowStartMs(input.state);
  const endMs = now.getTime();
  const [eventCounts, maxPendingOrderAgeMinutes] = await Promise.all([
    summarizeCanaryEvents(
      input.eventLogPath ?? DEFAULT_EVENT_LOG_PATH,
      startMs,
      endMs,
    ),
    computeMaxPendingOrderAgeMinutes(
      input.walletStatePath ??
        input.state.artifacts.walletStatePath ??
        DEFAULT_WALLET_STATE_PATH,
      endMs,
    ),
  ]);

  const metrics = {
    eventCounts,
    maxPendingOrderAgeMinutes,
    connectorsHealthy: input.runtimeHealth?.connectorsHealthy,
    heartbeatEnabled: input.runtimeHealth?.heartbeatEnabled,
    cryptoAccountReadable: input.runtimeHealth?.cryptoAccountReadable,
  } satisfies CanaryState["metrics"];

  const blockingReasons: string[] = [];
  applyObservationAndHealthThresholds(
    blockingReasons,
    input.config.microLive.observationMinMinutes,
    startMs,
    endMs,
    metrics,
    input.config.microLive.maxHeartbeatErrors,
    input.config.microLive.maxGateCircuitOpen,
    input.config.microLive.maxCronPaused,
    input.config.microLive.maxPnlReconciliationAlerts,
    input.config.microLive.maxIdempotencyDuplicates,
    input.config.microLive.maxStalePendingOrderAgeMinutes,
    input.runtimeHealth,
  );

  return {
    passed: blockingReasons.length === 0,
    metrics,
    blockingReasons: unique(blockingReasons),
  };
}

export async function summarizeCanaryEvents(
  eventLogPath: string,
  startMs: number,
  endMs: number,
): Promise<CanaryState["metrics"]["eventCounts"]> {
  const entries = await readEventEntries(eventLogPath);
  const counts = {
    heartbeatErrors: 0,
    gateCircuitOpen: 0,
    cronPaused: 0,
    pnlReconciliationAlerts: 0,
    paperExecutorFailures: 0,
    idempotencyDuplicates: 0,
  };

  for (const entry of entries) {
    if (entry.ts < startMs || entry.ts > endMs) {
      continue;
    }
    if (entry.type === "heartbeat.error") counts.heartbeatErrors += 1;
    if (entry.type === "gate.circuit_open") counts.gateCircuitOpen += 1;
    if (entry.type === "cron.paused") counts.cronPaused += 1;
    if (entry.type === "pnl.reconciliation.alert") counts.pnlReconciliationAlerts += 1;
    if (entry.type === "idempotency.duplicate") counts.idempotencyDuplicates += 1;
    if (entry.type.startsWith("paper_executor_commit_failed")) {
      counts.paperExecutorFailures += 1;
    }
  }

  return counts;
}

export async function computeMaxPendingOrderAgeMinutes(
  walletStatePath: string,
  nowMs: number,
): Promise<number | undefined> {
  const walletState = await readJsonFile<WalletExportState>(walletStatePath);
  if (!walletState) {
    return undefined;
  }

  const orderStatus = new Map<string, string>();
  for (let i = walletState.commits.length - 1; i >= 0; i--) {
    for (const result of walletState.commits[i].results) {
      if (result.orderId && !orderStatus.has(result.orderId)) {
        orderStatus.set(result.orderId, result.status);
      }
    }
  }

  let maxAgeMinutes = 0;
  for (const commit of walletState.commits) {
    for (const result of commit.results) {
      if (
        result.orderId &&
        orderStatus.get(result.orderId) === "pending"
      ) {
        const commitTs = Date.parse(commit.timestamp);
        if (Number.isFinite(commitTs)) {
          maxAgeMinutes = Math.max(
            maxAgeMinutes,
            (nowMs - commitTs) / 60_000,
          );
        }
      }
    }
  }

  return maxAgeMinutes > 0 ? maxAgeMinutes : 0;
}

async function readEventEntries(path: string): Promise<EventEntry[]> {
  const raw = await readTextFile(path);
  if (raw == null) {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as EventEntry];
      } catch {
        return [];
      }
    });
}

async function readJsonFile<T>(path: string | undefined): Promise<T | null> {
  if (!path) {
    return null;
  }
  const raw = await readTextFile(path);
  if (raw == null) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }
}

function applyObservationAndHealthThresholds(
  blockingReasons: string[],
  minObservationMinutes: number,
  startMs: number,
  endMs: number,
  metrics: CanaryState["metrics"],
  maxHeartbeatErrors: number,
  maxGateCircuitOpen: number,
  maxCronPaused: number,
  maxPnlReconciliationAlerts: number,
  maxIdempotencyDuplicates: number,
  maxPendingOrderAgeMinutes: number,
  runtimeHealth?: RuntimeHealthSnapshot,
): void {
  const observedMinutes = (endMs - startMs) / 60_000;
  if (observedMinutes < minObservationMinutes) {
    blockingReasons.push(
      `canary_observation_window_incomplete:${observedMinutes.toFixed(2)}`,
    );
  }
  if (metrics.eventCounts.heartbeatErrors > maxHeartbeatErrors) {
    blockingReasons.push(
      `canary_heartbeat_errors:${metrics.eventCounts.heartbeatErrors}`,
    );
  }
  if (metrics.eventCounts.gateCircuitOpen > maxGateCircuitOpen) {
    blockingReasons.push(
      `canary_gate_circuit_open:${metrics.eventCounts.gateCircuitOpen}`,
    );
  }
  if (metrics.eventCounts.cronPaused > maxCronPaused) {
    blockingReasons.push(
      `canary_cron_paused:${metrics.eventCounts.cronPaused}`,
    );
  }
  if (
    metrics.eventCounts.pnlReconciliationAlerts > maxPnlReconciliationAlerts
  ) {
    blockingReasons.push(
      `canary_pnl_reconciliation_alerts:${metrics.eventCounts.pnlReconciliationAlerts}`,
    );
  }
  if (metrics.eventCounts.idempotencyDuplicates > maxIdempotencyDuplicates) {
    blockingReasons.push(
      `canary_idempotency_duplicates:${metrics.eventCounts.idempotencyDuplicates}`,
    );
  }
  if (
    typeof metrics.maxPendingOrderAgeMinutes === "number" &&
    metrics.maxPendingOrderAgeMinutes > maxPendingOrderAgeMinutes
  ) {
    blockingReasons.push(
      `canary_pending_order_age:${metrics.maxPendingOrderAgeMinutes.toFixed(2)}`,
    );
  }
  if (runtimeHealth?.connectorsHealthy === false) {
    blockingReasons.push("canary_connectors_unhealthy");
  }
  if (runtimeHealth?.heartbeatEnabled === false) {
    blockingReasons.push("canary_heartbeat_disabled");
  }
  if (runtimeHealth?.cryptoAccountReadable === false) {
    blockingReasons.push("canary_crypto_account_unreadable");
  }
}

function resolveWindowStartMs(state: CanaryState): number {
  const candidate = state.window.startedAt ?? state.lastTransitionAt;
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid canary state time anchor: ${candidate}`);
  }
  return parsed;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
