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

export interface MakerQueueTradePrint {
  price: number;
  qty: number;
  atMs?: number;
}

export interface MakerQueueSimulationInput {
  side: ExecutionSide;
  orderPrice: number;
  orderQty: number;
  initialQueueQtyAhead: number;
  tradePrints: MakerQueueTradePrint[];
}

export interface MakerQueueSimulationResult {
  filledQty: number;
  remainingQty: number;
  fillRate: number;
  fullyFilled: boolean;
  firstFillAtMs: number | null;
  completedAtMs: number | null;
  remainingQueueQtyAhead: number;
}

export type IntradayLiquiditySession = "asia" | "europe" | "us" | "off_hours";

export interface SessionAwareSlippageConfig {
  asiaMultiplier?: number;
  europeMultiplier?: number;
  usMultiplier?: number;
  offHoursMultiplier?: number;
  handoffPenaltyBps?: number;
  handoffWindowMinutes?: number;
}

export interface SessionAwareSlippageEstimate {
  session: IntradayLiquiditySession;
  utcHour: number;
  baselineSlippageBps: number;
  multiplier: number;
  handoffPenaltyBps: number;
  estimatedSlippageBps: number;
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

/**
 * Deterministic queue-position simulator for maker fills.
 *
 * A passive buy is fill-eligible only when trade prints occur at or below the
 * bid price; a passive sell is fill-eligible only when prints occur at or
 * above the ask price. Volume first consumes the queue ahead of our order, and
 * only remaining eligible volume fills us. This prevents backtests from
 * assuming maker fills merely because the candle touched our limit price.
 */
export function simulateMakerQueueFill(
  input: MakerQueueSimulationInput
): MakerQueueSimulationResult {
  const orderPrice = positiveOrNull(input.orderPrice);
  const orderQty = positiveOrNull(input.orderQty);
  if (orderPrice === null) {
    throw new Error("orderPrice must be a finite number > 0");
  }
  if (orderQty === null) {
    throw new Error("orderQty must be a finite number > 0");
  }

  let queueAhead = nonNegative(input.initialQueueQtyAhead);
  let remainingQty = orderQty;
  let firstFillAtMs: number | null = null;
  let completedAtMs: number | null = null;

  for (const trade of input.tradePrints) {
    if (remainingQty <= 0) break;
    const tradeQty = nonNegative(trade.qty);
    if (tradeQty <= 0 || !isMakerFillEligible(input.side, orderPrice, trade.price)) {
      continue;
    }

    const queueConsumed = Math.min(queueAhead, tradeQty);
    queueAhead -= queueConsumed;
    const volumeAfterQueue = tradeQty - queueConsumed;
    if (volumeAfterQueue <= 0) {
      continue;
    }

    const fillQty = Math.min(remainingQty, volumeAfterQueue);
    remainingQty -= fillQty;
    if (fillQty > 0 && firstFillAtMs === null && Number.isFinite(trade.atMs)) {
      firstFillAtMs = trade.atMs ?? null;
    }
    if (remainingQty <= 0 && Number.isFinite(trade.atMs)) {
      completedAtMs = trade.atMs ?? null;
    }
  }

  const filledQty = orderQty - remainingQty;
  return {
    filledQty,
    remainingQty,
    fillRate: filledQty / orderQty,
    fullyFilled: remainingQty <= 0,
    firstFillAtMs,
    completedAtMs,
    remainingQueueQtyAhead: queueAhead,
  };
}

export function sessionAwareSlippageEstimate(
  submittedAtMs: number,
  baselineSlippageBps: number,
  config: SessionAwareSlippageConfig = {}
): SessionAwareSlippageEstimate {
  if (!Number.isFinite(submittedAtMs)) {
    throw new Error("submittedAtMs must be finite");
  }
  if (!Number.isFinite(baselineSlippageBps) || baselineSlippageBps < 0) {
    throw new Error("baselineSlippageBps must be a finite number >= 0");
  }

  const date = new Date(submittedAtMs);
  const utcHour = date.getUTCHours() + date.getUTCMinutes() / 60;
  const session = classifyIntradayLiquiditySession(utcHour);
  const multiplier = sessionMultiplier(session, config);
  const handoffPenaltyBps = isSessionHandoffWindow(date, config.handoffWindowMinutes ?? 30)
    ? config.handoffPenaltyBps ?? 0.5
    : 0;

  return {
    session,
    utcHour,
    baselineSlippageBps,
    multiplier,
    handoffPenaltyBps,
    estimatedSlippageBps: baselineSlippageBps * multiplier + handoffPenaltyBps,
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

function isMakerFillEligible(
  side: ExecutionSide,
  orderPrice: number,
  tradePrice: number
): boolean {
  if (!Number.isFinite(tradePrice) || tradePrice <= 0) return false;
  return side === "buy" ? tradePrice <= orderPrice : tradePrice >= orderPrice;
}

function classifyIntradayLiquiditySession(utcHour: number): IntradayLiquiditySession {
  if (utcHour >= 0 && utcHour < 8) return "asia";
  if (utcHour >= 8 && utcHour < 13) return "europe";
  if (utcHour >= 13 && utcHour < 21) return "us";
  return "off_hours";
}

function sessionMultiplier(
  session: IntradayLiquiditySession,
  config: SessionAwareSlippageConfig
): number {
  switch (session) {
    case "asia":
      return positiveOrFallback(config.asiaMultiplier, 1.05);
    case "europe":
      return positiveOrFallback(config.europeMultiplier, 0.95);
    case "us":
      return positiveOrFallback(config.usMultiplier, 1);
    case "off_hours":
    default:
      return positiveOrFallback(config.offHoursMultiplier, 1.25);
  }
}

function isSessionHandoffWindow(date: Date, windowMinutes: number): boolean {
  const safeWindow = Math.max(0, windowMinutes);
  const minuteOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();
  const handoffs = [8 * 60, 13 * 60, 21 * 60];
  return handoffs.some((handoff) => Math.abs(minuteOfDay - handoff) <= safeWindow);
}

function positiveOrFallback(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : fallback;
}

function isEEXIST(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}
