import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  evaluateLiveProofWindow,
  type EvaluateLiveProofInput,
  type LiveProofDailySnapshot,
  type LiveProofTarget,
  type LiveProofTrade,
} from "./live_proof_tracker.js";
import type { RuntimeProofTrackingInput } from "./runtime_status_snapshot.js";

export interface LiveProofStatusPaths {
  targetPath?: string;
  snapshotsPath?: string;
  tradesPath?: string;
}

const DEFAULT_TARGET_PATH = "data/runtime/live_proof_target.json";
const DEFAULT_SNAPSHOTS_PATH = "data/runtime/live_proof_daily_snapshots.json";
const DEFAULT_TRADES_PATH = "data/runtime/live_proof_trades.json";

export async function loadRuntimeProofTracking(
  paths?: LiveProofStatusPaths,
): Promise<RuntimeProofTrackingInput> {
  const targetPath = paths?.targetPath ?? DEFAULT_TARGET_PATH;
  const snapshotsPath = paths?.snapshotsPath ?? DEFAULT_SNAPSHOTS_PATH;
  const tradesPath = paths?.tradesPath ?? DEFAULT_TRADES_PATH;

  const [targetRaw, snapshotsRaw, tradesRaw] = await Promise.all([
    readJsonOrNull(targetPath),
    readJsonOrNull(snapshotsPath),
    readJsonOrNull(tradesPath),
  ]);

  const target = parseTarget(targetRaw);
  const snapshots = parseSnapshots(snapshotsRaw);
  const trades = parseTrades(tradesRaw);

  if (!target) {
    return {
      status: "not_started",
      targetDays: 90,
      elapsedDays: 0,
      netPnlPositive: undefined,
      maxDrawdownPct: null,
      drawdownBudgetPct: 10,
      blockingReasons: ["proof_target_missing"],
      warnings: [],
      source: "live_proof_status:no_target",
    };
  }

  if (snapshots.length === 0) {
    return {
      status: "not_started",
      targetDays: target.requiredDays,
      elapsedDays: 0,
      netPnlPositive: undefined,
      maxDrawdownPct: null,
      drawdownBudgetPct: target.maxDrawdownPct,
      blockingReasons: ["proof_snapshots_missing"],
      warnings: [],
      source: "live_proof_status:no_snapshots",
    };
  }

  const evaluation = evaluateLiveProofWindow({
    target,
    dailySnapshots: snapshots,
    trades,
  });

  return {
    status:
      evaluation.status === "in_progress" ? "tracking" : evaluation.status,
    elapsedDays: evaluation.metrics.coveredDays,
    targetDays: evaluation.metrics.requiredDays,
    netPnlPositive: evaluation.metrics.netPnlUsd > 0,
    maxDrawdownPct: evaluation.metrics.maxDrawdownPct,
    drawdownBudgetPct: target.maxDrawdownPct,
    blockingReasons: evaluation.breachReasons,
    warnings: evaluation.warnings,
    source: "live_proof_status:evaluated",
  };
}

export async function ensureRuntimeProofArtifacts(
  paths?: LiveProofStatusPaths,
): Promise<Required<LiveProofStatusPaths>> {
  const resolvedPaths: Required<LiveProofStatusPaths> = {
    targetPath: paths?.targetPath ?? DEFAULT_TARGET_PATH,
    snapshotsPath: paths?.snapshotsPath ?? DEFAULT_SNAPSHOTS_PATH,
    tradesPath: paths?.tradesPath ?? DEFAULT_TRADES_PATH,
  };

  await Promise.all([
    ensureJsonFile(resolvedPaths.targetPath, {
      requiredDays: 90,
      maxDrawdownPct: 10,
      requirePositiveNetPnl: true,
      minNetPnlUsd: 0,
      failOnDrawdownBreach: true,
      failOnEquityNonPositive: true,
    }),
    ensureJsonFile(resolvedPaths.snapshotsPath, []),
    ensureJsonFile(resolvedPaths.tradesPath, []),
  ]);

  return resolvedPaths;
}

async function readJsonOrNull(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, "utf-8");
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

async function ensureJsonFile(path: string, defaultValue: unknown): Promise<void> {
  const existing = await readJsonOrNull(path);
  if (existing !== null) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(defaultValue, null, 2)}\n`, "utf-8");
}

function parseTarget(value: unknown): LiveProofTarget | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<LiveProofTarget>;
  if (
    !Number.isInteger(raw.requiredDays) ||
    !Number.isFinite(raw.maxDrawdownPct)
  ) {
    return null;
  }
  return {
    requiredDays: raw.requiredDays as number,
    maxDrawdownPct: raw.maxDrawdownPct as number,
    requirePositiveNetPnl: raw.requirePositiveNetPnl,
    minNetPnlUsd: raw.minNetPnlUsd,
    failOnDrawdownBreach: raw.failOnDrawdownBreach,
    failOnEquityNonPositive: raw.failOnEquityNonPositive,
  };
}

function parseSnapshots(value: unknown): LiveProofDailySnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is { date: string | Date; equityUsd: number } => {
      return Boolean(
        item &&
          typeof item === "object" &&
          "date" in item &&
          "equityUsd" in item,
      );
    })
    .map((item) => ({
      date: item.date,
      equityUsd: item.equityUsd,
    }));
}

function parseTrades(value: unknown): LiveProofTrade[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is {
      closedAt: string | Date;
      realizedPnlUsd: number;
      feesUsd?: number;
    } => {
      return Boolean(
        item &&
          typeof item === "object" &&
          "closedAt" in item &&
          "realizedPnlUsd" in item,
      );
    })
    .map((item) => ({
      closedAt: item.closedAt,
      realizedPnlUsd: item.realizedPnlUsd,
      feesUsd: item.feesUsd,
    }));
}
