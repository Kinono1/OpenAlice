import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SlippageGateDecision } from "../live/execution_quality.js";

export interface RiskDailyPnl {
  date: string;
  dailyReturnPct: number;
}

export interface ConsecutiveLossStats {
  days: number;
  cumulativePct: number;
}

export interface TailLossStats {
  windowDays: number;
  tailAlpha: number;
  sampleCount: number;
  tailCount: number;
  varPct?: number;
  cvarPct?: number;
}

export interface RiskBreakerState {
  version: 1;
  executionBreakerActive: boolean;
  executionBreakerReason: string | null;
  gateFailureBreakerActive: boolean;
  gateFailureBreakerReason: string | null;
  gateFailureConsecutiveFailures: number;
  gateFailureBackoffMs: number | null;
  gateFailureBlockedUntilMs: number | null;
  dailyPnl: RiskDailyPnl[];
  lastUpdatedAt: string;
}

export function createDefaultRiskBreakerState(
  now: Date = new Date()
): RiskBreakerState {
  return {
    version: 1,
    executionBreakerActive: false,
    executionBreakerReason: null,
    gateFailureBreakerActive: false,
    gateFailureBreakerReason: null,
    gateFailureConsecutiveFailures: 0,
    gateFailureBackoffMs: null,
    gateFailureBlockedUntilMs: null,
    dailyPnl: [],
    lastUpdatedAt: now.toISOString(),
  };
}

export class RiskBreakerStore {
  static async load(
    filePath = "data/runtime/risk_breaker_state.json"
  ): Promise<RiskBreakerStore> {
    try {
      const raw = await readFile(filePath, "utf-8");
      return new RiskBreakerStore(
        filePath,
        normalizeRiskBreakerState(JSON.parse(raw))
      );
    } catch (err: unknown) {
      if (isEnoent(err)) {
        return new RiskBreakerStore(filePath, createDefaultRiskBreakerState());
      }
      throw err;
    }
  }

  private constructor(
    private readonly filePath: string,
    private state: RiskBreakerState
  ) {}

  getState(): RiskBreakerState {
    return structuredClone(this.state);
  }

  isExecutionBreakerActive(): boolean {
    return this.state.executionBreakerActive;
  }

  getExecutionBreakerReason(): string | null {
    return this.state.executionBreakerReason;
  }

  isGateFailureBreakerActive(nowMs = Date.now()): boolean {
    return Boolean(
      this.state.gateFailureBreakerActive &&
        typeof this.state.gateFailureBlockedUntilMs === "number" &&
        this.state.gateFailureBlockedUntilMs > nowMs
    );
  }

  getGateFailureBreakerReason(nowMs = Date.now()): string | null {
    return this.isGateFailureBreakerActive(nowMs)
      ? this.state.gateFailureBreakerReason
      : null;
  }

  async recordGateEvaluationSuccess(): Promise<void> {
    const changed =
      this.state.gateFailureBreakerActive ||
      this.state.gateFailureConsecutiveFailures !== 0 ||
      this.state.gateFailureBreakerReason !== null ||
      this.state.gateFailureBackoffMs !== null ||
      this.state.gateFailureBlockedUntilMs !== null;

    this.state.gateFailureBreakerActive = false;
    this.state.gateFailureBreakerReason = null;
    this.state.gateFailureConsecutiveFailures = 0;
    this.state.gateFailureBackoffMs = null;
    this.state.gateFailureBlockedUntilMs = null;

    if (changed) {
      await this.persist();
    }
  }

  async recordGateEvaluationFailure(input: {
    scope: string;
    error: string;
    threshold?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    nowMs?: number;
  }): Promise<{
    opened: boolean;
    consecutiveFailures: number;
    backoffMs: number | null;
    blockedUntilMs: number | null;
  }> {
    const threshold = Math.max(1, Math.floor(input.threshold ?? 3));
    const baseBackoffMs = Math.max(1_000, Math.floor(input.baseBackoffMs ?? 30_000));
    const maxBackoffMs = Math.max(
      baseBackoffMs,
      Math.floor(input.maxBackoffMs ?? 15 * 60_000)
    );
    const nowMs = input.nowMs ?? Date.now();

    const previousActive = this.isGateFailureBreakerActive(nowMs);
    const consecutiveFailures = this.state.gateFailureConsecutiveFailures + 1;
    const shouldOpen = consecutiveFailures >= threshold;
    const backoffExponent = Math.max(0, consecutiveFailures - threshold);
    const backoffMs = shouldOpen
      ? Math.min(baseBackoffMs * 2 ** backoffExponent, maxBackoffMs)
      : null;
    const blockedUntilMs = backoffMs === null ? null : nowMs + backoffMs;

    this.state.gateFailureConsecutiveFailures = consecutiveFailures;
    this.state.gateFailureBreakerActive = shouldOpen;
    this.state.gateFailureBackoffMs = backoffMs;
    this.state.gateFailureBlockedUntilMs = blockedUntilMs;
    this.state.gateFailureBreakerReason = [
      "gate_eval_failure",
      `scope=${input.scope}`,
      `failures=${consecutiveFailures}`,
      `error=${input.error}`,
    ].join(" ");
    await this.persist();

    return {
      opened: shouldOpen && !previousActive,
      consecutiveFailures,
      backoffMs,
      blockedUntilMs,
    };
  }

  async applyExecutionGateDecision(
    decision: SlippageGateDecision
  ): Promise<void> {
    if (decision.action === "reduce_or_pause") {
      this.state.executionBreakerActive = true;
      this.state.executionBreakerReason = [
        "execution_drift",
        `consecutiveBreaches=${decision.consecutiveBreaches}`,
        `required=${decision.requiredConsecutiveDays}`,
      ].join(" ");
    } else {
      this.state.executionBreakerActive = false;
      this.state.executionBreakerReason = null;
    }
    await this.persist();
  }

  async upsertDailyPnl(date: string, dailyReturnPct: number): Promise<void> {
    assertDate(date);
    if (!Number.isFinite(dailyReturnPct)) {
      throw new Error("dailyReturnPct must be finite.");
    }
    const idx = this.state.dailyPnl.findIndex(item => item.date === date);
    const record = { date, dailyReturnPct };
    if (idx >= 0) {
      this.state.dailyPnl[idx] = record;
    } else {
      this.state.dailyPnl.push(record);
    }
    this.state.dailyPnl.sort((a, b) => a.date.localeCompare(b.date));
    await this.persist();
  }

  getConsecutiveLossStats(): ConsecutiveLossStats {
    const sorted = [...this.state.dailyPnl].sort((a, b) =>
      a.date.localeCompare(b.date)
    );
    let days = 0;
    let cumulativePct = 0;

    for (let i = sorted.length - 1; i >= 0; i--) {
      const day = sorted[i];
      if (day.dailyReturnPct >= 0) {
        break;
      }
      days += 1;
      cumulativePct += day.dailyReturnPct;
    }

    return { days, cumulativePct };
  }

  getTailLossStats(opts?: {
    lookbackDays?: number;
    tailAlpha?: number;
  }): TailLossStats {
    const requestedWindow = Math.max(1, Math.floor(opts?.lookbackDays ?? 30));
    const requestedAlpha = opts?.tailAlpha ?? 0.2;
    const normalizedAlpha = Math.min(0.5, Math.max(0.01, requestedAlpha));

    const sortedByDate = [...this.state.dailyPnl].sort((a, b) =>
      a.date.localeCompare(b.date)
    );
    const windowed = sortedByDate.slice(-requestedWindow);
    const returns = windowed
      .map(item => item.dailyReturnPct)
      .filter(value => Number.isFinite(value))
      .sort((a, b) => a - b);

    if (returns.length === 0) {
      return {
        windowDays: requestedWindow,
        tailAlpha: normalizedAlpha,
        sampleCount: 0,
        tailCount: 0,
      };
    }

    const tailCount = Math.max(1, Math.ceil(returns.length * normalizedAlpha));
    const tail = returns.slice(0, tailCount);
    const tailSum = tail.reduce((sum, value) => sum + value, 0);
    const cvarPct = tailSum / tail.length;
    const varPct = tail[tail.length - 1];

    return {
      windowDays: requestedWindow,
      tailAlpha: normalizedAlpha,
      sampleCount: returns.length,
      tailCount,
      varPct,
      cvarPct,
    };
  }

  async persist(): Promise<void> {
    this.state.lastUpdatedAt = new Date().toISOString();
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(this.state, null, 2)}\n`,
      "utf-8"
    );
  }
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date: ${value}. Expected YYYY-MM-DD.`);
  }
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function normalizeRiskBreakerState(raw: unknown): RiskBreakerState {
  const defaults = createDefaultRiskBreakerState();
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const value = raw as Partial<RiskBreakerState>;
  return {
    version: 1,
    executionBreakerActive: value.executionBreakerActive ?? false,
    executionBreakerReason: value.executionBreakerReason ?? null,
    gateFailureBreakerActive: value.gateFailureBreakerActive ?? false,
    gateFailureBreakerReason: value.gateFailureBreakerReason ?? null,
    gateFailureConsecutiveFailures: value.gateFailureConsecutiveFailures ?? 0,
    gateFailureBackoffMs: value.gateFailureBackoffMs ?? null,
    gateFailureBlockedUntilMs: value.gateFailureBlockedUntilMs ?? null,
    dailyPnl: Array.isArray(value.dailyPnl) ? value.dailyPnl : [],
    lastUpdatedAt: value.lastUpdatedAt ?? defaults.lastUpdatedAt,
  };
}
