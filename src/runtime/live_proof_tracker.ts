export type LiveProofStatus = "in_progress" | "passed" | "failed";

export interface LiveProofTarget {
  requiredDays: number;
  maxDrawdownPct: number;
  requirePositiveNetPnl?: boolean;
  minNetPnlUsd?: number;
  failOnDrawdownBreach?: boolean;
  failOnEquityNonPositive?: boolean;
}

export interface LiveProofDailySnapshot {
  date: string | Date;
  equityUsd: number;
}

export interface LiveProofTrade {
  closedAt: string | Date;
  realizedPnlUsd: number;
  feesUsd?: number;
}

export interface LiveProofMetrics {
  coveredDays: number;
  requiredDays: number;
  daysRemaining: number;
  progressRatio: number;
  startDate: string | null;
  endDate: string | null;
  startEquityUsd: number | null;
  endEquityUsd: number | null;
  netPnlUsd: number;
  netPnlPct: number;
  maxDrawdownPct: number;
  realizedTradePnlUsd: number;
  tradeCount: number;
}

export interface LiveProofEvaluation {
  status: LiveProofStatus;
  metrics: LiveProofMetrics;
  breachReasons: string[];
  warnings: string[];
  decidedAt: string;
}

export interface EvaluateLiveProofInput {
  target: LiveProofTarget;
  dailySnapshots: LiveProofDailySnapshot[];
  trades?: LiveProofTrade[];
  now?: Date;
}

const DEFAULT_TARGETS = {
  requirePositiveNetPnl: true,
  minNetPnlUsd: 0,
  failOnDrawdownBreach: true,
  failOnEquityNonPositive: true,
} as const;

export function evaluateLiveProofWindow(
  input: EvaluateLiveProofInput,
): LiveProofEvaluation {
  const target = resolveTarget(input.target);
  const warnings: string[] = [];
  const snapshots = normalizeSnapshots(input.dailySnapshots, warnings);
  const trades = normalizeTrades(input.trades ?? []);

  const metrics = buildMetrics(target.requiredDays, snapshots, trades);
  const breachReasons = evaluateBreaches(target, metrics);

  let status: LiveProofStatus = "in_progress";
  if (breachReasons.length > 0) {
    status = "failed";
  } else if (metrics.coveredDays >= target.requiredDays) {
    status = "passed";
  }

  if (metrics.coveredDays === 0) {
    warnings.push("proof_no_snapshots");
  }

  return {
    status,
    metrics,
    breachReasons,
    warnings: Array.from(new Set(warnings)),
    decidedAt: (input.now ?? new Date()).toISOString(),
  };
}

function resolveTarget(target: LiveProofTarget) {
  if (!Number.isInteger(target.requiredDays) || target.requiredDays <= 0) {
    throw new Error("requiredDays must be a positive integer.");
  }
  if (!Number.isFinite(target.maxDrawdownPct) || target.maxDrawdownPct < 0) {
    throw new Error("maxDrawdownPct must be a finite number >= 0.");
  }

  return {
    requiredDays: target.requiredDays,
    maxDrawdownPct: target.maxDrawdownPct,
    requirePositiveNetPnl:
      target.requirePositiveNetPnl ?? DEFAULT_TARGETS.requirePositiveNetPnl,
    minNetPnlUsd: target.minNetPnlUsd ?? DEFAULT_TARGETS.minNetPnlUsd,
    failOnDrawdownBreach:
      target.failOnDrawdownBreach ?? DEFAULT_TARGETS.failOnDrawdownBreach,
    failOnEquityNonPositive:
      target.failOnEquityNonPositive ?? DEFAULT_TARGETS.failOnEquityNonPositive,
  };
}

function normalizeSnapshots(
  snapshots: LiveProofDailySnapshot[],
  warnings: string[],
): Array<{ date: string; equityUsd: number }> {
  const byDate = new Map<string, { date: string; equityUsd: number }>();

  for (const snapshot of snapshots) {
    const date = toDateKey(snapshot.date);
    if (!Number.isFinite(snapshot.equityUsd)) {
      throw new Error(`equityUsd must be finite for snapshot ${date}.`);
    }
    byDate.set(date, {
      date,
      equityUsd: snapshot.equityUsd,
    });
  }

  const normalized = [...byDate.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  if (normalized.length !== snapshots.length) {
    warnings.push("proof_duplicate_snapshot_dates_collapsed");
  }
  return normalized;
}

function normalizeTrades(
  trades: LiveProofTrade[],
): Array<{ closedAt: string; realizedPnlUsd: number }> {
  return trades.map((trade) => {
    if (!Number.isFinite(trade.realizedPnlUsd)) {
      throw new Error("realizedPnlUsd must be finite.");
    }
    const feesUsd = trade.feesUsd ?? 0;
    if (!Number.isFinite(feesUsd)) {
      throw new Error("feesUsd must be finite when provided.");
    }
    return {
      closedAt: toDateTimeKey(trade.closedAt),
      realizedPnlUsd: trade.realizedPnlUsd - feesUsd,
    };
  });
}

function buildMetrics(
  requiredDays: number,
  snapshots: Array<{ date: string; equityUsd: number }>,
  trades: Array<{ closedAt: string; realizedPnlUsd: number }>,
): LiveProofMetrics {
  const coveredDays = snapshots.length;
  const progressRatio =
    requiredDays > 0 ? Math.min(1, coveredDays / requiredDays) : 1;
  const start = snapshots[0] ?? null;
  const end = snapshots[snapshots.length - 1] ?? null;
  const startEquityUsd = start?.equityUsd ?? null;
  const endEquityUsd = end?.equityUsd ?? null;
  const netPnlUsd =
    startEquityUsd !== null && endEquityUsd !== null
      ? endEquityUsd - startEquityUsd
      : 0;
  const netPnlPct =
    startEquityUsd && startEquityUsd > 0
      ? (netPnlUsd / startEquityUsd) * 100
      : 0;

  return {
    coveredDays,
    requiredDays,
    daysRemaining: Math.max(0, requiredDays - coveredDays),
    progressRatio,
    startDate: start?.date ?? null,
    endDate: end?.date ?? null,
    startEquityUsd,
    endEquityUsd,
    netPnlUsd,
    netPnlPct,
    maxDrawdownPct: computeMaxDrawdownPct(snapshots),
    realizedTradePnlUsd: trades.reduce(
      (sum, trade) => sum + trade.realizedPnlUsd,
      0,
    ),
    tradeCount: trades.length,
  };
}

function evaluateBreaches(
  target: ReturnType<typeof resolveTarget>,
  metrics: LiveProofMetrics,
): string[] {
  const reasons: string[] = [];

  if (
    target.failOnEquityNonPositive &&
    typeof metrics.endEquityUsd === "number" &&
    metrics.endEquityUsd <= 0
  ) {
    reasons.push("proof_equity_non_positive");
  }

  if (
    target.failOnDrawdownBreach &&
    metrics.maxDrawdownPct > target.maxDrawdownPct
  ) {
    reasons.push("proof_max_drawdown_breached");
  }

  if (metrics.coveredDays >= target.requiredDays) {
    if (
      target.requirePositiveNetPnl &&
      metrics.netPnlUsd <= target.minNetPnlUsd
    ) {
      reasons.push("proof_net_pnl_not_positive");
    }
  }

  return reasons;
}

function computeMaxDrawdownPct(
  snapshots: Array<{ date: string; equityUsd: number }>,
): number {
  let peak = Number.NEGATIVE_INFINITY;
  let maxDrawdown = 0;

  // Drawdown is measured from the running peak of end-of-day equity.
  for (const snapshot of snapshots) {
    peak = Math.max(peak, snapshot.equityUsd);
    if (peak > 0) {
      maxDrawdown = Math.max(
        maxDrawdown,
        ((peak - snapshot.equityUsd) / peak) * 100,
      );
    }
  }

  return maxDrawdown;
}

function toDateKey(input: string | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${String(input)}`);
  }
  return date.toISOString().slice(0, 10);
}

function toDateTimeKey(input: string | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid datetime value: ${String(input)}`);
  }
  return date.toISOString();
}
