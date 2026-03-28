import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { CryptoPlaceOrderRequest } from "../extension/crypto-trading/interfaces.js";

export const DEFAULT_CANARY_STATE_PATH = "data/runtime/canary_state.json";

const LOCK_RETRY_MS = 25;
const STRICT_UTC_ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const canaryPhaseSchema = z.enum([
  "draft",
  "preflight_passed",
  "paper_running",
  "paper_passed",
  "micro_live_approved",
  "micro_live_running",
  "micro_live_passed",
  "blocked",
  "rolled_back",
]);

export type CanaryPhase = z.infer<typeof canaryPhaseSchema>;
export type CanaryEnvironment = "paper" | "micro_live";

const canaryStateSchema = z.object({
  version: z.literal(1),
  phase: canaryPhaseSchema,
  environment: z.enum(["paper", "micro_live"]),
  allowedSymbols: z.array(z.string()).default([]),
  limits: z.object({
    maxSymbols: z.number().int().positive().optional(),
    maxConcurrentOpens: z.number().int().positive().optional(),
    maxNotionalUsd: z.number().positive().optional(),
    maxEquityPct: z.number().positive().optional(),
  }).default({}),
  window: z.object({
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    minObservationMinutes: z.number().int().positive(),
    expiresAt: z.string().optional(),
  }),
  artifacts: z.object({
    gatesPreflightReportPath: z.string().optional(),
    paperDiagnosticStatusPath: z.string().optional(),
    paperExecutorStatusPath: z.string().optional(),
    releaseGateStatusPath: z.string().optional(),
    paperChampionRegistryPath: z.string().optional(),
    liveRolloutReadinessPath: z.string().optional(),
    gateCheckpointsIndexPath: z.string().optional(),
    walletStatePath: z.string().optional(),
  }).default({}),
  metrics: z.object({
    eventCounts: z.object({
      heartbeatErrors: z.number().int().min(0).default(0),
      gateCircuitOpen: z.number().int().min(0).default(0),
      cronPaused: z.number().int().min(0).default(0),
      pnlReconciliationAlerts: z.number().int().min(0).default(0),
      paperExecutorFailures: z.number().int().min(0).default(0),
      idempotencyDuplicates: z.number().int().min(0).default(0),
    }).default({
      heartbeatErrors: 0,
      gateCircuitOpen: 0,
      cronPaused: 0,
      pnlReconciliationAlerts: 0,
      paperExecutorFailures: 0,
      idempotencyDuplicates: 0,
    }),
    maxPendingOrderAgeMinutes: z.number().min(0).optional(),
    connectorsHealthy: z.boolean().optional(),
    heartbeatEnabled: z.boolean().optional(),
    cryptoAccountReadable: z.boolean().optional(),
  }).default({
    eventCounts: {
      heartbeatErrors: 0,
      gateCircuitOpen: 0,
      cronPaused: 0,
      pnlReconciliationAlerts: 0,
      paperExecutorFailures: 0,
      idempotencyDuplicates: 0,
    },
  }),
  blockingReasons: z.array(z.string()).default([]),
  approvedBy: z.string().optional(),
  lastTransitionAt: z.string(),
  checksum: z.string().min(1),
});

export type CanaryState = z.infer<typeof canaryStateSchema>;

export type CanaryStateInvalidReason =
  | "missing"
  | "parse_error"
  | "checksum_mismatch"
  | "schema_invalid";

export type CanaryStateReadResult =
  | { ok: true; state: CanaryState }
  | { ok: false; reason: CanaryStateInvalidReason; error?: string };

export interface LiveCanaryGateInput {
  state: CanaryState;
  request: CryptoPlaceOrderRequest;
  now?: Date;
  accountEquity: number;
  openPositionSymbols: string[];
  expectedNotionalUsd?: number;
}

export interface LiveCanaryGateResult {
  approved: boolean;
  reason?: string;
}

export function createEmptyCanaryMetrics(): CanaryState["metrics"] {
  return {
    eventCounts: {
      heartbeatErrors: 0,
      gateCircuitOpen: 0,
      cronPaused: 0,
      pnlReconciliationAlerts: 0,
      paperExecutorFailures: 0,
      idempotencyDuplicates: 0,
    },
  };
}

export function createDraftCanaryState(
  now = new Date(),
): CanaryState {
  const state = {
    version: 1 as const,
    phase: "draft" as const,
    environment: "paper" as const,
    allowedSymbols: [],
    limits: {},
    window: {
      minObservationMinutes: 1,
    },
    artifacts: {},
    metrics: createEmptyCanaryMetrics(),
    blockingReasons: [],
    lastTransitionAt: now.toISOString(),
    checksum: "",
  };
  return applyCanaryChecksum(state);
}

export function assertCanaryPhaseTransition(
  from: CanaryPhase,
  to: CanaryPhase,
): void {
  const allowed: Record<CanaryPhase, CanaryPhase[]> = {
    draft: ["preflight_passed", "blocked", "rolled_back"],
    preflight_passed: ["paper_running", "blocked", "rolled_back"],
    paper_running: ["paper_passed", "blocked", "rolled_back"],
    paper_passed: ["micro_live_approved", "blocked", "rolled_back"],
    micro_live_approved: ["micro_live_running", "blocked", "rolled_back"],
    micro_live_running: ["micro_live_passed", "blocked", "rolled_back"],
    micro_live_passed: ["blocked", "rolled_back"],
    blocked: ["preflight_passed", "paper_running", "micro_live_approved", "rolled_back"],
    rolled_back: ["preflight_passed", "paper_running", "micro_live_approved", "blocked"],
  };

  if (!allowed[from].includes(to)) {
    throw new Error(`Invalid canary phase transition: ${from} -> ${to}`);
  }
}

export function applyCanaryChecksum(
  state: Omit<CanaryState, "checksum"> | CanaryState,
): CanaryState {
  const { checksum: _ignored, ...rest } = state as CanaryState;
  return {
    ...rest,
    checksum: computeCanaryStateChecksum(rest),
  };
}

export function computeCanaryStateChecksum(
  state: Omit<CanaryState, "checksum">,
): string {
  return createHash("sha256")
    .update(stableSerialize(state))
    .digest("hex");
}

export async function writeCanaryState(
  state: Omit<CanaryState, "checksum"> | CanaryState,
  filePath = DEFAULT_CANARY_STATE_PATH,
  opts?: { lockTimeoutMs?: number },
): Promise<CanaryState> {
  const normalized = normalizeCanaryState(applyCanaryChecksum(state));
  const lockPath = `${filePath}.lock`;
  const lockTimeoutMs = Math.max(1_000, Math.floor(opts?.lockTimeoutMs ?? 5_000));

  await withWriteLock(lockPath, lockTimeoutMs, async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
    await rename(tmpPath, filePath);
  });

  return normalized;
}

export async function safeReadCanaryState(
  filePath = DEFAULT_CANARY_STATE_PATH,
): Promise<CanaryStateReadResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if (isEnoent(err)) {
      return { ok: false, reason: "missing" };
    }
    return {
      ok: false,
      reason: "parse_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "parse_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const state = normalizeCanaryState(parsed);
    if (!isCanaryChecksumValid(state)) {
      return { ok: false, reason: "checksum_mismatch" };
    }
    return { ok: true, state };
  } catch (err) {
    return {
      ok: false,
      reason: "schema_invalid",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function normalizeCanaryState(raw: unknown): CanaryState {
  const parsed = canaryStateSchema.parse(raw);
  assertIsoField("lastTransitionAt", parsed.lastTransitionAt);
  if (parsed.window.startedAt) {
    assertIsoField("window.startedAt", parsed.window.startedAt);
  }
  if (parsed.window.completedAt) {
    assertIsoField("window.completedAt", parsed.window.completedAt);
  }
  if (parsed.window.expiresAt) {
    assertIsoField("window.expiresAt", parsed.window.expiresAt);
  }
  return parsed;
}

export function isCanaryChecksumValid(state: CanaryState): boolean {
  const { checksum, ...rest } = state;
  return checksum === computeCanaryStateChecksum(rest);
}

export function evaluateLiveCanaryGate(
  input: LiveCanaryGateInput,
): LiveCanaryGateResult {
  const now = input.now ?? new Date();
  const { state, request } = input;
  if (state.phase !== "micro_live_running" && state.phase !== "micro_live_passed") {
    return {
      approved: false,
      reason:
        state.phase === "micro_live_approved"
          ? "canary_micro_live_not_started"
          : `canary_phase_${state.phase}`,
    };
  }

  const expiresAt = state.window.expiresAt
    ? parseStrictIso(state.window.expiresAt)
    : null;
  if (expiresAt !== null && now.getTime() > expiresAt) {
    return {
      approved: false,
      reason: "canary_state_expired",
    };
  }

  if (!state.allowedSymbols.includes(request.symbol)) {
    return {
      approved: false,
      reason: `canary_symbol_not_allowed:${request.symbol}`,
    };
  }

  if (
    typeof state.limits.maxSymbols === "number" &&
    state.allowedSymbols.length > state.limits.maxSymbols
  ) {
    return {
      approved: false,
      reason: "canary_allowed_symbols_exceeds_limit",
    };
  }

  const uniqueOpenSymbols = [...new Set(input.openPositionSymbols)];
  if (
    typeof state.limits.maxConcurrentOpens === "number" &&
    uniqueOpenSymbols.length >= state.limits.maxConcurrentOpens
  ) {
    return {
      approved: false,
      reason: `canary_concurrent_open_limit:${uniqueOpenSymbols.length}`,
    };
  }

  if (!Number.isFinite(input.accountEquity) || input.accountEquity <= 0) {
    return {
      approved: false,
      reason: "canary_account_equity_invalid",
    };
  }

  if (
    typeof input.expectedNotionalUsd !== "number" ||
    !Number.isFinite(input.expectedNotionalUsd) ||
    input.expectedNotionalUsd <= 0
  ) {
    return {
      approved: false,
      reason: "canary_notional_unknown",
    };
  }

  if (
    typeof state.limits.maxNotionalUsd === "number" &&
    input.expectedNotionalUsd > state.limits.maxNotionalUsd
  ) {
    return {
      approved: false,
      reason: `canary_notional_limit_exceeded:${input.expectedNotionalUsd.toFixed(2)}`,
    };
  }

  const equityPct = (input.expectedNotionalUsd / input.accountEquity) * 100;
  if (
    typeof state.limits.maxEquityPct === "number" &&
    equityPct > state.limits.maxEquityPct
  ) {
    return {
      approved: false,
      reason: `canary_equity_pct_limit_exceeded:${equityPct.toFixed(4)}`,
    };
  }

  return { approved: true };
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function withWriteLock<T>(
  lockPath: string,
  lockTimeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  await mkdir(dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const lockFd = await open(lockPath, "wx");
      try {
        return await fn();
      } finally {
        await lockFd.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        if (Date.now() - startedAt >= lockTimeoutMs) {
          throw new Error(
            `CanaryState write lock timeout after ${lockTimeoutMs}ms (${lockPath})`,
          );
        }
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      throw err;
    }
  }
}

function parseStrictIso(value: string): number {
  assertIsoField("timestamp", value);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ISO-8601 UTC timestamp: ${value}`);
  }
  return parsed;
}

function assertIsoField(field: string, value: string): void {
  if (!STRICT_UTC_ISO_8601.test(value)) {
    throw new Error(`${field} must be a strict ISO-8601 UTC timestamp.`);
  }
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
