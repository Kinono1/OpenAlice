import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ExecutionSide = "buy" | "sell";

/**
 * Canonical execution record for quality analytics.
 * - expectedPrice: benchmark/reference price at decision time
 * - actualPrice: realized execution price
 * - requestedQty vs filledQty allows fill-rate analysis
 */
export interface OrderExecutionRecord {
  orderId: string;
  symbol: string;
  side: ExecutionSide;
  expectedPrice: number;
  actualPrice: number;
  requestedQty: number;
  filledQty: number;
  submittedAtMs: number;
  firstFillAtMs: number | null;
  completedAtMs: number | null;
}

export interface LatencyMetrics {
  sampleCount: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export interface ExecutionDailySummary {
  date: string;
  orderCount: number;
  filledOrderCount: number;
  totalRequestedQty: number;
  totalFilledQty: number;
  fillRate: number;
  volumeWeightedSlippageBps: number | null;
  latencyMs: {
    toFirstFill: LatencyMetrics;
    toComplete: LatencyMetrics;
  };
}

export type ExecutionGateAction = "monitor" | "reduce_or_pause";

export interface SlippageDriftGateConfig {
  driftMultiplierThreshold: number;
  consecutiveDays: number;
  baselineSlippageBps: number;
  minimumBaselineBps?: number;
}

export interface SlippageGateDecision {
  action: ExecutionGateAction;
  consecutiveBreaches: number;
  requiredConsecutiveDays: number;
  breachedDates: string[];
  latestDriftMultiplier: number | null;
}

export interface DailyExecutionReportWriteResult {
  path: string;
  written: boolean;
}

export interface ExecutionReportIO {
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>;
  writeFile(
    path: string,
    data: string,
    opts: { encoding: BufferEncoding; flag?: string }
  ): Promise<void>;
}

const DEFAULT_REPORT_IO: ExecutionReportIO = {
  mkdir: async (path, opts) => {
    await mkdir(path, opts);
  },
  writeFile: async (path, data, opts) => {
    await writeFile(path, data, opts);
  },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Signed slippage in basis points where positive means "worse execution".
 * - buy: actual > expected => positive
 * - sell: actual < expected => positive
 */
export function computeExecutionSlippageBps(
  record: OrderExecutionRecord
): number | null {
  const expected = positiveOrNull(record.expectedPrice);
  const actual = positiveOrNull(record.actualPrice);
  const filledQty = positiveOrNull(record.filledQty);
  if (expected === null || actual === null || filledQty === null) return null;

  const signed =
    record.side === "buy"
      ? (actual - expected) / expected
      : (expected - actual) / expected;

  return signed * 10_000;
}

export function computeDailyExecutionSummary(
  date: string,
  records: OrderExecutionRecord[]
): ExecutionDailySummary {
  if (!DATE_RE.test(date)) {
    throw new Error(`Invalid date format: "${date}". Expected YYYY-MM-DD`);
  }

  const firstFillLatencies: number[] = [];
  const completionLatencies: number[] = [];

  let totalRequestedQty = 0;
  let totalFilledQty = 0;
  let filledOrderCount = 0;
  let weightedSlippage = 0;
  let weightedSlippageQty = 0;

  for (const record of records) {
    const requestedQty = nonNegative(record.requestedQty);
    const filledQty = nonNegative(record.filledQty);

    totalRequestedQty += requestedQty;
    totalFilledQty += filledQty;

    if (filledQty > 0) {
      filledOrderCount += 1;
    }

    const slippageBps = computeExecutionSlippageBps(record);
    if (slippageBps !== null && filledQty > 0) {
      weightedSlippage += slippageBps * filledQty;
      weightedSlippageQty += filledQty;
    }

    const firstFillLatency = latencyOrNull(
      record.submittedAtMs,
      record.firstFillAtMs
    );
    if (firstFillLatency !== null) {
      firstFillLatencies.push(firstFillLatency);
    }

    const completionLatency = latencyOrNull(
      record.submittedAtMs,
      record.completedAtMs
    );
    if (completionLatency !== null) {
      completionLatencies.push(completionLatency);
    }
  }

  return {
    date,
    orderCount: records.length,
    filledOrderCount,
    totalRequestedQty,
    totalFilledQty,
    fillRate: totalRequestedQty > 0 ? totalFilledQty / totalRequestedQty : 0,
    volumeWeightedSlippageBps:
      weightedSlippageQty > 0 ? weightedSlippage / weightedSlippageQty : null,
    latencyMs: {
      toFirstFill: summarizeLatency(firstFillLatencies),
      toComplete: summarizeLatency(completionLatencies),
    },
  };
}

export function evaluateSlippageDriftGate(
  dailySummaries: ExecutionDailySummary[],
  config: SlippageDriftGateConfig
): SlippageGateDecision {
  if (
    !Number.isFinite(config.driftMultiplierThreshold) ||
    config.driftMultiplierThreshold <= 0
  ) {
    throw new Error("driftMultiplierThreshold must be a positive number");
  }
  if (
    !Number.isInteger(config.consecutiveDays) ||
    config.consecutiveDays <= 0
  ) {
    throw new Error("consecutiveDays must be a positive integer");
  }

  const sorted = [...dailySummaries].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  const baseline = Math.max(
    Math.abs(nonNegative(config.baselineSlippageBps)),
    config.minimumBaselineBps ?? 1e-6
  );

  let consecutiveBreaches = 0;
  const breachedDates: string[] = [];

  for (let i = sorted.length - 1; i >= 0; i--) {
    const day = sorted[i];
    const drift = driftMultiplier(day.volumeWeightedSlippageBps, baseline);
    if (drift !== null && drift > config.driftMultiplierThreshold) {
      consecutiveBreaches += 1;
      breachedDates.unshift(day.date);
      continue;
    }
    break;
  }

  const latest = sorted.length > 0 ? sorted[sorted.length - 1] : null;

  return {
    action:
      consecutiveBreaches >= config.consecutiveDays
        ? "reduce_or_pause"
        : "monitor",
    consecutiveBreaches,
    requiredConsecutiveDays: config.consecutiveDays,
    breachedDates,
    latestDriftMultiplier:
      latest === null
        ? null
        : driftMultiplier(latest.volumeWeightedSlippageBps, baseline),
  };
}

/**
 * Writes data/execution_logs/YYYY-MM-DD.json.
 * Non-destructive: existing reports are never overwritten.
 */
export async function writeDailyExecutionReport(
  summary: ExecutionDailySummary,
  opts?: {
    baseDir?: string;
    io?: ExecutionReportIO;
  }
): Promise<DailyExecutionReportWriteResult> {
  if (!DATE_RE.test(summary.date)) {
    throw new Error(
      `Invalid summary date: "${summary.date}". Expected YYYY-MM-DD`
    );
  }

  const baseDir = opts?.baseDir ?? "data";
  const io = opts?.io ?? DEFAULT_REPORT_IO;
  const logsDir = join(baseDir, "execution_logs");
  const reportPath = join(logsDir, `${summary.date}.json`);
  const payload = JSON.stringify(summary, null, 2) + "\n";

  await io.mkdir(logsDir, { recursive: true });

  try {
    await io.writeFile(reportPath, payload, { encoding: "utf-8", flag: "wx" });
    return { path: reportPath, written: true };
  } catch (err: unknown) {
    if (isEEXIST(err)) {
      return { path: reportPath, written: false };
    }
    throw err;
  }
}

function summarizeLatency(values: number[]): LatencyMetrics {
  if (values.length === 0) {
    return {
      sampleCount: 0,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      minMs: null,
      maxMs: null,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);

  return {
    sampleCount: sorted.length,
    avgMs: sum / sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}

function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];

  const position = (sortedValues.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight = position - lower;
  return (
    sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight
  );
}

function driftMultiplier(
  slippageBps: number | null,
  baselineBps: number
): number | null {
  if (slippageBps === null || !Number.isFinite(slippageBps)) return null;
  return slippageBps / baselineBps;
}

function latencyOrNull(
  startAtMs: number,
  endAtMs: number | null
): number | null {
  if (
    !Number.isFinite(startAtMs) ||
    endAtMs === null ||
    !Number.isFinite(endAtMs)
  )
    return null;
  if (endAtMs < startAtMs) return null;
  return endAtMs - startAtMs;
}

function positiveOrNull(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isEEXIST(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}
