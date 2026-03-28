import { performance } from "node:perf_hooks";
import { join } from "node:path";
import type { EventLog } from "../core/event-log.js";
import { RampUpStore } from "../deployment/ramp_up_store.js";
import type { RampUpEvaluation } from "../deployment/ramp_up.js";
import type {
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
  ICryptoTradingEngine,
} from "../extension/crypto-trading/interfaces.js";
import type {
  RiskConfig,
  RiskCheckContext,
  RiskCheckResult,
} from "../extension/crypto-trading/risk.js";
import { ExecutionQualityStore } from "../live/execution_quality_store.js";
import type {
  SlippageDriftGateConfig,
  SlippageGateDecision,
} from "../live/execution_quality.js";
import { loadManualOverride } from "./manual_override.js";
import { RiskBreakerStore } from "./risk_breaker_state.js";
import {
  evaluateLiveCanaryGate,
  safeReadCanaryState,
} from "./canary_state.js";
import { writeDailyGateSummary } from "./daily_gate_summary.js";
import { detectRegimeShift, type RegimeShiftResult } from "./regime_shift.js";
import {
  summarizeIdempotencyEventsForDate,
  type IdempotencyGovernanceSummary,
} from "./idempotency_event_summary.js";
import {
  isLiveReleaseGateStatusBlocking,
  isPaperReleaseGateStatusBlocking,
  loadReleaseGateStatus,
  type ReleaseGateMode,
  type PersistedReleaseGateStatus,
} from "./release_gate_status.js";
import {
  loadLiveRolloutReadiness,
  type LiveRolloutReadinessArtifact,
} from "./live_rollout_readiness.js";

export interface LiveMarketDataBar {
  symbol: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tsOpenMs?: number;
  barIntervalMs?: number;
  barCloseMs?: number;
  completed?: boolean;
  sourceDomain?: string;
  instId?: string;
  ccxtSymbol?: string;
  clockSkewMs?: number;
}

export interface LiveMarketDataProvider {
  getMarketData(
    time: Date,
    symbol: string
  ): Promise<LiveMarketDataBar>;
  getMarketDataRange(
    startTime: Date,
    endTime: Date,
    symbol: string
  ): Promise<LiveMarketDataBar[]>;
}

export interface LiveMarketContext {
  marketDataProvider: LiveMarketDataProvider;
  getPlayheadTime(): Date;
  calculatePreviousTime(lookbackBars: number): Date;
  getAvailableSymbols(): string[];
}

export interface LiveGateManagerConfig {
  executionGate: SlippageDriftGateConfig;
  volatilityCurrentWindowBars: number;
  volatilityHistoryBars: number;
  volatilitySymbol?: string;
  requireReleaseGatePass: boolean;
  gateMode: ReleaseGateMode;
  releaseGateStatusPath: string;
  releaseGateStatusCacheTtlMs: number;
  liveCanary: {
    enabled: boolean;
    statePath: string;
  };
  rolloutReadiness: {
    enabled: boolean;
    statusPath: string;
  };
  gateFailureCircuit: {
    threshold: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
  };
  regimeShift: {
    enabled: boolean;
    symbol?: string;
    checkIntervalMs: number;
    recentBars: number;
    baselineBars: number;
    volZWatch: number;
    volZHigh: number;
    trendZWatch: number;
    trendZHigh: number;
    watchStageReduction: number;
    highStageReduction: number;
  };
}

export interface LiveGateManagerOptions {
  engine: ICryptoTradingEngine;
  marketContext?: LiveMarketContext;
  /** @deprecated Temporary compatibility alias while callers migrate. */
  klineStore?: LiveMarketContext;
  riskConfig?: Pick<RiskConfig, "cvarLookbackDays" | "cvarTailAlpha">;
  eventLog?: EventLog;
  baseDir?: string;
  manualOverridePath?: string;
  config?: Partial<LiveGateManagerConfig>;
}

const DEFAULT_CONFIG: LiveGateManagerConfig = {
  executionGate: {
    driftMultiplierThreshold: 2,
    consecutiveDays: 3,
    baselineSlippageBps: 5,
    minimumBaselineBps: 0.5,
  },
  volatilityCurrentWindowBars: 24,
  volatilityHistoryBars: 24 * 90,
  requireReleaseGatePass: true,
  gateMode: "live",
  releaseGateStatusPath: "data/runtime/release_gate_status.json",
  releaseGateStatusCacheTtlMs: 60_000,
  liveCanary: {
    enabled: true,
    statePath: "data/runtime/canary_state.json",
  },
  rolloutReadiness: {
    enabled: false,
    statusPath: "data/runtime/live_rollout_readiness.latest.json",
  },
  gateFailureCircuit: {
    threshold: 3,
    baseBackoffMs: 30_000,
    maxBackoffMs: 15 * 60_000,
  },
  regimeShift: {
    enabled: true,
    checkIntervalMs: 60_000,
    recentBars: 24,
    baselineBars: 24 * 90,
    volZWatch: 1.5,
    volZHigh: 2.5,
    trendZWatch: 1.5,
    trendZHigh: 2.5,
    watchStageReduction: 1,
    highStageReduction: 2,
  },
};

export class GateEvalError extends Error {
  constructor(
    public readonly scope: string,
    message: string,
    public readonly causeValue?: unknown,
  ) {
    super(message);
    this.name = "GateEvalError";
  }
}

export class LiveGateManager {
  static async create(opts: LiveGateManagerOptions): Promise<LiveGateManager> {
    const executionStore = await ExecutionQualityStore.load();
    const rampStore = await RampUpStore.load();
    const riskBreakerStore = await RiskBreakerStore.load();
    return new LiveGateManager(
      opts,
      executionStore,
      rampStore,
      riskBreakerStore
    );
  }

  private readonly config: LiveGateManagerConfig;
  private readonly baseDir: string;
  private readonly manualOverridePath: string;
  private currentDate: string;
  private volatilityCache: { atMs: number; quantile: number } | null = null;
  private releaseGateCache: {
    atMs: number;
    status: PersistedReleaseGateStatus | null;
  } | null = null;
  private rolloutReadinessCache: {
    atMs: number;
    artifact: LiveRolloutReadinessArtifact | null;
  } | null = null;
  private regimeShiftCache: {
    atMs: number;
    result: RegimeShiftResult | null;
  } | null = null;

  private constructor(
    private readonly opts: LiveGateManagerOptions,
    private readonly executionStore: ExecutionQualityStore,
    private readonly rampStore: RampUpStore,
    private readonly riskBreakerStore: RiskBreakerStore
  ) {
    this.baseDir = opts.baseDir ?? "data";
    this.manualOverridePath =
      opts.manualOverridePath ?? "data/runtime/manual_override.json";
    this.config = {
      ...DEFAULT_CONFIG,
      ...opts.config,
      executionGate: {
        ...DEFAULT_CONFIG.executionGate,
        ...(opts.config?.executionGate ?? {}),
      },
      liveCanary: {
        ...DEFAULT_CONFIG.liveCanary,
        ...(opts.config?.liveCanary ?? {}),
      },
      rolloutReadiness: {
        ...DEFAULT_CONFIG.rolloutReadiness,
        ...(opts.config?.rolloutReadiness ?? {}),
      },
      gateFailureCircuit: {
        ...DEFAULT_CONFIG.gateFailureCircuit,
        ...(opts.config?.gateFailureCircuit ?? {}),
      },
      regimeShift: {
        ...DEFAULT_CONFIG.regimeShift,
        ...(opts.config?.regimeShift ?? {}),
      },
    };
    this.currentDate = toDateKey(new Date());
  }

  getCurrentRampStageLabel(): string {
    return this.rampStore.getCurrentStageLabel();
  }

  private getMarketContext(): LiveMarketContext | null {
    return this.opts.marketContext ?? this.opts.klineStore ?? null;
  }

  private async evaluateCanaryLiveGate(
    req: CryptoPlaceOrderRequest,
  ): Promise<string | null> {
    const readResult = await safeReadCanaryState(
      this.config.liveCanary.statePath,
    );
    if (!readResult.ok) {
      await this.appendEvent("canary.invalid_state", {
        reason: readResult.reason,
        error: readResult.error ?? null,
        path: this.config.liveCanary.statePath,
      });
      return `canary_state_${readResult.reason}`;
    }

    const state = readResult.state;
    const [account, positions] = await Promise.all([
      this.opts.engine.getAccount(),
      this.opts.engine.getPositions(),
    ]);

    const expectedPrice =
      typeof req.usd_size === "number" && req.usd_size > 0
        ? undefined
        : await this.estimateExpectedPrice(req);
    const expectedNotionalUsd =
      typeof req.usd_size === "number" && req.usd_size > 0
        ? req.usd_size
        : typeof req.size === "number" &&
            req.size > 0 &&
            typeof expectedPrice === "number" &&
            expectedPrice > 0
          ? req.size * expectedPrice
          : undefined;

    const result = evaluateLiveCanaryGate({
      state,
      request: req,
      now: new Date(),
      accountEquity: account.equity,
      openPositionSymbols: positions
        .filter((position) => position.size > 0)
        .map((position) => position.symbol),
      expectedNotionalUsd,
    });

    if (!result.approved && result.reason === "canary_state_expired") {
      await this.appendEvent("canary.expired", {
        expiresAt: state.window.expiresAt ?? null,
        path: this.config.liveCanary.statePath,
      });
    }
    if (!result.approved) {
      await this.appendEvent("canary.blocked", {
        reason: result.reason ?? "unknown",
        symbol: req.symbol,
        expectedNotionalUsd: expectedNotionalUsd ?? null,
      });
    }

    return result.approved ? null : result.reason ?? "unknown";
  }

  private monotonicNow(): number {
    return performance.now();
  }

  private async recordGateEvalSuccess(): Promise<void> {
    await this.riskBreakerStore.recordGateEvaluationSuccess().catch(() => {});
  }

  private async recordGateEvalFailure(
    error: GateEvalError,
  ): Promise<Awaited<ReturnType<RiskBreakerStore["recordGateEvaluationFailure"]>>> {
    const result = await this.riskBreakerStore.recordGateEvaluationFailure({
      scope: error.scope,
      error: error.message,
      threshold: this.config.gateFailureCircuit.threshold,
      baseBackoffMs: this.config.gateFailureCircuit.baseBackoffMs,
      maxBackoffMs: this.config.gateFailureCircuit.maxBackoffMs,
    });
    await this.appendEvent("gate.eval_error", {
      scope: error.scope,
      error: error.message,
    });
    if (result.opened) {
      await this.appendEvent("gate.circuit_open", {
        scope: error.scope,
        consecutiveFailures: result.consecutiveFailures,
        backoffMs: result.backoffMs,
        blockedUntilMs: result.blockedUntilMs,
      });
    }
    return result;
  }

  private async failGateEvaluation(
    scope: string,
    err: unknown,
  ): Promise<never> {
    const gateError =
      err instanceof GateEvalError
        ? err
        : new GateEvalError(
            scope,
            err instanceof Error ? err.message : String(err),
            err,
          );
    await this.recordGateEvalFailure(gateError);
    throw gateError;
  }

  async beforePlaceOrder(
    req: CryptoPlaceOrderRequest
  ): Promise<RiskCheckResult | undefined> {
    const block = async (reason: string): Promise<RiskCheckResult> => {
      await this.appendEvent("live-gate.blocked", {
        symbol: req.symbol,
        reason,
        gateMode: this.config.gateMode,
        reduceOnly: Boolean(req.reduceOnly),
      });
      return {
        approved: false,
        reason,
      };
    };
    const succeed = async (
      result: RiskCheckResult | undefined,
    ): Promise<RiskCheckResult | undefined> => {
      await this.recordGateEvalSuccess();
      return result;
    };
    const manualOverride = await loadManualOverride(this.manualOverridePath);
    if (!req.reduceOnly && manualOverride.pauseNewOpens) {
      return block("Manual override is pausing new opens.");
    }

    if (
      !req.reduceOnly &&
      this.config.gateMode === "live" &&
      this.config.liveCanary.enabled
    ) {
      const canaryBlockReason = await this.evaluateCanaryLiveGate(req);
      if (canaryBlockReason) {
        return block(`Live canary blocking new opens: ${canaryBlockReason}`);
      }
    }

    if (!req.reduceOnly && this.riskBreakerStore.isGateFailureBreakerActive()) {
      return block(
        this.riskBreakerStore.getGateFailureBreakerReason() ??
          "Gate evaluation circuit breaker is active.",
      );
    }

    if (
      !req.reduceOnly &&
      this.config.requireReleaseGatePass &&
      !manualOverride.ignoreReleaseGate
    ) {
      const gateStatus = await this.loadReleaseGateStatus(false, false);
      const blocked =
        this.config.gateMode === "paper"
          ? isPaperReleaseGateStatusBlocking(gateStatus)
          : isLiveReleaseGateStatusBlocking(gateStatus);
      if (blocked.blocking) {
        return succeed(
          await block(
            `Release gate blocking new opens: ${blocked.reason ?? "unknown"}`,
          ),
        );
      }
    }

    if (
      !req.reduceOnly &&
      this.config.gateMode === "live" &&
      this.config.rolloutReadiness.enabled
    ) {
      const rolloutReadiness = await this.loadLiveRolloutReadiness(false, false);
      if (!rolloutReadiness?.readyForMicroLive) {
        const reason =
          rolloutReadiness?.blockingReasons[0] ??
          "live_rollout_readiness_missing";
        await this.appendEvent("live_gate.rollout_readiness_blocked", {
          symbol: req.symbol,
          reason,
          gateMode: this.config.gateMode,
          reduceOnly: Boolean(req.reduceOnly),
        });
        return succeed(await block(`live_rollout_not_ready:${reason}`));
      }
    }

    if (!req.reduceOnly && !manualOverride.ignoreRegimeShift) {
      const regime = await this.refreshRegimeShiftSignal(false, false);
      if (regime && regime.triggered && regime.severity === "high") {
        return succeed(
          await block(
            `Regime-shift high severity: ${regime.reason}; new opens are paused.`,
          ),
        );
      }
    }

    if (!req.reduceOnly && this.riskBreakerStore.isExecutionBreakerActive()) {
      return succeed(
        await block(
          this.riskBreakerStore.getExecutionBreakerReason() ??
            "Execution-quality breaker is active.",
        ),
      );
    }

    if (req.reduceOnly) {
      return undefined;
    }

    return succeed(undefined);
  }

  async buildRiskContext(): Promise<RiskCheckContext | undefined> {
    const manualOverride = await loadManualOverride(this.manualOverridePath);
    const account = await this.opts.engine.getAccount();
    const consecutive = this.riskBreakerStore.getConsecutiveLossStats();
    const tailLoss = this.riskBreakerStore.getTailLossStats({
      lookbackDays: this.opts.riskConfig?.cvarLookbackDays,
      tailAlpha: this.opts.riskConfig?.cvarTailAlpha,
    });

    const inferredDailyLossPct =
      account.equity > 0
        ? (account.totalPnL / account.equity) * 100
        : undefined;

    const volatilityQuantile =
      manualOverride.forceVolatilityQuantile ??
      (await this.estimateVolatilityQuantile());

    const regime = manualOverride.ignoreRegimeShift
      ? null
      : await this.refreshRegimeShiftSignal();

    let stageLabel =
      manualOverride.forceCapitalRampStage ??
      this.rampStore.getCurrentStageLabel();
    if (!manualOverride.forceCapitalRampStage && regime?.triggered) {
      const reduction =
        regime.severity === "high"
          ? this.config.regimeShift.highStageReduction
          : regime.severity === "watch"
            ? this.config.regimeShift.watchStageReduction
            : 0;
      if (reduction > 0) {
        stageLabel = this.getReducedStageLabel(reduction);
      }
    }

    return {
      dailyLossPct: manualOverride.forceDailyLossPct ?? inferredDailyLossPct,
      cvarDailyLossPct:
        manualOverride.forceCvarDailyLossPct ?? tailLoss.cvarPct,
      consecutiveLossDays:
        manualOverride.forceConsecutiveLossDays ?? consecutive.days,
      consecutiveLossPct:
        manualOverride.forceConsecutiveLossPct ?? consecutive.cumulativePct,
      volatilityQuantile,
      capitalRampStage: stageLabel,
    };
  }

  async estimateExpectedPrice(
    req: CryptoPlaceOrderRequest
  ): Promise<number | undefined> {
    if (typeof req.price === "number" && req.price > 0) {
      return req.price;
    }

    try {
      const marketContext = this.getMarketContext();
      if (!marketContext) {
        return undefined;
      }
      const marketData =
        await marketContext.marketDataProvider.getMarketData(
          marketContext.getPlayheadTime(),
          req.symbol
        );
      if (Number.isFinite(marketData.close) && marketData.close > 0) {
        await this.recordGateEvalSuccess();
        return marketData.close;
      }
    } catch (err) {
      return this.failGateEvaluation("estimate_expected_price", err);
    }

    return undefined;
  }

  async recordExecution(
    req: CryptoPlaceOrderRequest,
    result: CryptoOrderResult,
    expectedPrice?: number
  ): Promise<void> {
    if (!result.success) {
      return;
    }

    const fallbackPriceRaw = expectedPrice ?? req.price ?? result.filledPrice;
    if (
      typeof fallbackPriceRaw !== "number" ||
      !Number.isFinite(fallbackPriceRaw) ||
      fallbackPriceRaw <= 0
    ) {
      return;
    }
    const fallbackPrice = fallbackPriceRaw;

    const filledPrice = result.filledPrice ?? fallbackPrice;
    const requestedQty =
      (typeof result.requestedSize === "number" && result.requestedSize > 0
        ? result.requestedSize
        : undefined) ??
      (req.size && req.size > 0
        ? req.size
        : req.usd_size && req.usd_size > 0
          ? req.usd_size / fallbackPrice
          : (result.filledSize ?? 0));
    const filledQty = result.filledSize ?? requestedQty;

    if (!(filledQty > 0) || !(requestedQty > 0)) {
      return;
    }

    const nowMs = Date.now();
    const firstFillAtMs =
      typeof result.firstFillAtMs === "number" ? result.firstFillAtMs : nowMs;
    const completedAtMs =
      typeof result.completedAtMs === "number" ? result.completedAtMs : null;
    const exchangeUpdateTs =
      typeof result.exchangeUpdateTs === "number"
        ? result.exchangeUpdateTs
        : nowMs;
    await this.executionStore.addRecord({
      orderId:
        result.orderId ??
        `order_${nowMs}_${Math.floor(Math.random() * 1_000_000)}`,
      symbol: req.symbol,
      side: req.side,
      expectedPrice: fallbackPrice,
      actualPrice: filledPrice,
      requestedQty,
      filledQty,
      submittedAtMs: Math.min(nowMs, firstFillAtMs, exchangeUpdateTs),
      firstFillAtMs,
      completedAtMs,
    });
  }

  async tick(now: Date): Promise<void> {
    const date = toDateKey(now);
    if (date === this.currentDate) {
      return;
    }

    const previousDate = this.currentDate;
    this.currentDate = date;

    const executionSummary = await this.executionStore.finalizeDate(
      previousDate,
      {
        writeDailyReport: true,
        reportBaseDir: this.baseDir,
      }
    );

    const executionDecision = await this.executionStore.evaluateGate(
      this.config.executionGate
    );
    await this.riskBreakerStore.applyExecutionGateDecision(executionDecision);
    const regimeShift = await this.refreshRegimeShiftSignal(true);

    let rampEvaluation: RampUpEvaluation | null = null;
    try {
      const account = await this.opts.engine.getAccount();
      const dailyReturnPct =
        account.equity > 0 ? (account.totalPnL / account.equity) * 100 : 0;
      await this.riskBreakerStore.upsertDailyPnl(previousDate, dailyReturnPct);
      rampEvaluation = await this.rampStore.recordDay({
        date: previousDate,
        dayReturnPct: dailyReturnPct,
        tradeCount: executionSummary?.filledOrderCount ?? 0,
      });
    } catch (err) {
      await this.appendEvent("gate.daily.pnl_failed", {
        date: previousDate,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const manualOverride = await loadManualOverride(this.manualOverridePath);
    const consecutiveLoss = this.riskBreakerStore.getConsecutiveLossStats();
    const riskBreakerState = this.riskBreakerStore.getState();
    const stageLabel =
      manualOverride.forceCapitalRampStage ??
      this.rampStore.getCurrentStageLabel();
    let idempotencyEvents: IdempotencyGovernanceSummary | undefined;
    try {
      idempotencyEvents = await summarizeIdempotencyEventsForDate(
        this.opts.eventLog,
        previousDate
      );
    } catch (err) {
      idempotencyEvents = undefined;
      await this.appendEvent("gate.daily.idempotency_summary_failed", {
        date: previousDate,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await writeDailyGateSummary(
      {
        date: previousDate,
        generatedAt: new Date().toISOString(),
        capitalRampStage: stageLabel,
        executionSummary,
        executionGateDecision: executionDecision,
        rampEvaluation,
        regimeShift,
        riskBreaker: riskBreakerState,
        consecutiveLossStats: consecutiveLoss,
        manualOverride,
        idempotencyEvents,
      },
      { baseDir: join(this.baseDir, "runtime") }
    );

    await this.appendEvent("gate.daily.finalized", {
      date: previousDate,
      stage: stageLabel,
      executionGateAction: executionDecision.action,
      executionBreakerActive: riskBreakerState.executionBreakerActive,
      rampDecision: rampEvaluation?.decision ?? null,
      rampReason: rampEvaluation?.reason ?? null,
      regimeShiftSeverity: regimeShift?.severity ?? null,
      regimeShiftReason: regimeShift?.reason ?? null,
      idempotencyDuplicateCount: idempotencyEvents?.duplicateCount ?? 0,
      idempotencyRetryOverrideCount:
        idempotencyEvents?.retryOverrideCount ?? 0,
      idempotencyRetryRejectedCount:
        idempotencyEvents?.retryRejectedCount ?? 0,
    });
  }

  private async estimateVolatilityQuantile(): Promise<number | undefined> {
    const nowMs = this.monotonicNow();
    if (this.volatilityCache && nowMs - this.volatilityCache.atMs <= 60_000) {
      await this.recordGateEvalSuccess();
      return this.volatilityCache.quantile;
    }

    const marketContext = this.getMarketContext();
    if (!marketContext) {
      return undefined;
    }

    const symbol =
      this.config.volatilitySymbol ??
      marketContext.getAvailableSymbols()[0];
    if (!symbol) {
      await this.recordGateEvalSuccess();
      return undefined;
    }

    try {
      const end = marketContext.getPlayheadTime();
      const start = marketContext.calculatePreviousTime(
        this.config.volatilityHistoryBars
      );
      const bars =
        await marketContext.marketDataProvider.getMarketDataRange(
          start,
          end,
          symbol
        );
      if (bars.length < this.config.volatilityCurrentWindowBars + 2) {
        await this.recordGateEvalSuccess();
        return undefined;
      }

      const closes = bars
        .map(bar => bar.close)
        .filter(value => Number.isFinite(value) && value > 0);
      if (closes.length < this.config.volatilityCurrentWindowBars + 2) {
        await this.recordGateEvalSuccess();
        return undefined;
      }

      const returns: number[] = [];
      for (let i = 1; i < closes.length; i++) {
        returns.push(closes[i] / closes[i - 1] - 1);
      }

      const vols: number[] = [];
      for (
        let i = this.config.volatilityCurrentWindowBars;
        i <= returns.length;
        i++
      ) {
        const window = returns.slice(
          i - this.config.volatilityCurrentWindowBars,
          i
        );
        vols.push(stdDev(window));
      }
      if (vols.length < 2) {
        await this.recordGateEvalSuccess();
        return undefined;
      }

      const currentVol = vols[vols.length - 1];
      const lessOrEqual = vols.filter(value => value <= currentVol).length;
      const quantile = lessOrEqual / vols.length;

      this.volatilityCache = { atMs: nowMs, quantile };
      await this.recordGateEvalSuccess();
      return quantile;
    } catch (err) {
      return this.failGateEvaluation("volatility_quantile", err);
    }
  }

  private getReducedStageLabel(reduction: number): string {
    const currentIdx = this.rampStore.getCurrentStageIndex();
    const reducedIdx = Math.max(0, currentIdx - reduction);
    return this.rampStore.getStageLabelByIndex(reducedIdx);
  }

  private async loadReleaseGateStatus(
    forceRefresh = false,
    recordSuccess = true,
  ): Promise<PersistedReleaseGateStatus | null> {
    const now = this.monotonicNow();
    if (
      !forceRefresh &&
      this.releaseGateCache &&
      now - this.releaseGateCache.atMs <=
        this.config.releaseGateStatusCacheTtlMs
    ) {
      if (recordSuccess) {
        await this.recordGateEvalSuccess();
      }
      return this.releaseGateCache.status;
    }

    try {
      const status = await loadReleaseGateStatus(
        this.config.releaseGateStatusPath
      );
      this.releaseGateCache = {
        atMs: now,
        status,
      };
      if (recordSuccess) {
        await this.recordGateEvalSuccess();
      }
      return status;
    } catch (err) {
      return this.failGateEvaluation("release_gate_status", err);
    }
  }

  private async loadLiveRolloutReadiness(
    forceRefresh = false,
    recordSuccess = true,
  ): Promise<LiveRolloutReadinessArtifact | null> {
    const now = this.monotonicNow();
    if (
      !forceRefresh &&
      this.rolloutReadinessCache &&
      now - this.rolloutReadinessCache.atMs <=
        this.config.releaseGateStatusCacheTtlMs
    ) {
      if (recordSuccess) {
        await this.recordGateEvalSuccess();
      }
      return this.rolloutReadinessCache.artifact;
    }

    try {
      const artifact = await loadLiveRolloutReadiness(
        this.config.rolloutReadiness.statusPath,
      );
      this.rolloutReadinessCache = {
        atMs: now,
        artifact,
      };
      if (recordSuccess) {
        await this.recordGateEvalSuccess();
      }
      return artifact;
    } catch (err) {
      return this.failGateEvaluation("live_rollout_readiness", err);
    }
  }

  private async refreshRegimeShiftSignal(
    forceRefresh = false,
    recordSuccess = true,
  ): Promise<RegimeShiftResult | null> {
    if (!this.config.regimeShift.enabled) {
      if (recordSuccess) {
        await this.recordGateEvalSuccess();
      }
      return null;
    }

    const nowMs = this.monotonicNow();
    if (
      !forceRefresh &&
      this.regimeShiftCache &&
      nowMs - this.regimeShiftCache.atMs <=
        this.config.regimeShift.checkIntervalMs
    ) {
      if (recordSuccess) {
        await this.recordGateEvalSuccess();
      }
      return this.regimeShiftCache.result;
    }

    const symbol =
      this.config.regimeShift.symbol ??
      this.getMarketContext()?.getAvailableSymbols()[0];
    if (!symbol) {
      this.regimeShiftCache = { atMs: nowMs, result: null };
      if (recordSuccess) {
        await this.recordGateEvalSuccess();
      }
      return null;
    }

    const marketContext = this.getMarketContext();
    if (!marketContext) {
      this.regimeShiftCache = { atMs: nowMs, result: null };
      if (recordSuccess) {
        await this.recordGateEvalSuccess();
      }
      return null;
    }

    const barsNeeded =
      this.config.regimeShift.baselineBars +
      this.config.regimeShift.recentBars +
      2;
    try {
      const end = marketContext.getPlayheadTime();
      const start = marketContext.calculatePreviousTime(barsNeeded);
      const bars =
        await marketContext.marketDataProvider.getMarketDataRange(
          start,
          end,
          symbol
        );
      if (bars.length < barsNeeded) {
        this.regimeShiftCache = { atMs: nowMs, result: null };
        if (recordSuccess) {
          await this.recordGateEvalSuccess();
        }
        return null;
      }

      const closes = bars
        .map(bar => bar.close)
        .filter(value => Number.isFinite(value));
      const result = detectRegimeShift(closes, {
        recentBars: this.config.regimeShift.recentBars,
        baselineBars: this.config.regimeShift.baselineBars,
        volZWatch: this.config.regimeShift.volZWatch,
        volZHigh: this.config.regimeShift.volZHigh,
        trendZWatch: this.config.regimeShift.trendZWatch,
        trendZHigh: this.config.regimeShift.trendZHigh,
      });

      this.regimeShiftCache = {
        atMs: nowMs,
        result,
      };
      if (recordSuccess) {
        await this.recordGateEvalSuccess();
      }
      return result;
    } catch (err) {
      this.regimeShiftCache = { atMs: nowMs, result: null };
      return this.failGateEvaluation("regime_shift", err);
    }
  }

  private async appendEvent(type: string, payload: unknown): Promise<void> {
    if (!this.opts.eventLog) {
      return;
    }
    try {
      await this.opts.eventLog.append(type, payload);
    } catch {
      // ignore event-log failures
    }
  }
}

function stdDev(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => {
      const centered = value - mean;
      return sum + centered * centered;
    }, 0) / values.length;
  return Math.sqrt(Math.max(variance, 0));
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
