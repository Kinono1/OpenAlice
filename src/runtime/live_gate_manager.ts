import { dirname, join } from "node:path";
import type { EventLog } from "../core/event-log.js";
import { RampUpStore } from "../deployment/ramp_up_store.js";
import type { RampUpEvaluation } from "../deployment/ramp_up.js";
import type { KlineStore } from "../extension/analysis-kit/kline/KlineStore.js";
import type {
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
  ICryptoTradingEngine,
  RiskConfig,
  RiskCheckContext,
  RiskCheckResult,
} from "../domain/trading/operation-dispatcher.types.js";
import { ExecutionQualityStore } from "../live/execution_quality_store.js";
import type {
  SlippageDriftGateConfig,
  SlippageGateDecision,
} from "../live/execution_quality.js";
import {
  buildExecutionRecord,
  estimateRequestedNotionalUsd,
} from "./live_gate_manager.execution.js";
import { loadManualOverride } from "./manual_override.js";
import { RiskBreakerStore } from "./risk_breaker_state.js";
import { writeDailyGateSummary } from "./daily_gate_summary.js";
import { detectRegimeShift, type RegimeShiftResult } from "./regime_shift.js";
import {
  summarizeIdempotencyEventsForDate,
  type IdempotencyGovernanceSummary,
} from "./idempotency_event_summary.js";
import {
  getSkippedRequiredLiveChecks,
  isReleaseGateStatusBlocking,
  loadReleaseGateStatus,
  type PersistedReleaseGateStatus,
} from "./release_gate_status.js"
import {
  evaluatePromotionReadinessForLiveOrders,
} from "./promotion_v2.js";
import {
  DEFAULT_PROMOTION_READINESS_V2_PATH,
  tryLoadPromotionReadinessV2,
  tryLoadValidatedPromotionReadinessV2,
} from "./promotion_v2_artifacts.js";
import type { ToxicFlowAlert } from "../domain/strategy/microstructure/types.js";

export interface LiveGateManagerConfig {
  executionGate: SlippageDriftGateConfig;
  volatilityCurrentWindowBars: number;
  volatilityHistoryBars: number;
  volatilitySymbol?: string;
  requireReleaseGatePass: boolean;
  releaseGateStatusPath: string;
  releaseGateStatusCacheTtlMs: number;
  requirePromotionV2ForLiveOrders: boolean;
  promotionReadinessV2Path: string;
  validatePromotionV2Artifacts: boolean;
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
  deploymentRamp: {
    enabled: boolean;
    tinyCapitalMaxUsd: number;
    tinyCapitalMaxEquityFraction: number;
  };
}

export type LiveGateManagerConfigOverride = Omit<
  Partial<LiveGateManagerConfig>,
  "executionGate" | "regimeShift" | "deploymentRamp"
> & {
  executionGate?: Partial<LiveGateManagerConfig["executionGate"]>;
  regimeShift?: Partial<LiveGateManagerConfig["regimeShift"]>;
  deploymentRamp?: Partial<LiveGateManagerConfig["deploymentRamp"]>;
};

export interface LiveGateManagerOptions {
  engine: ICryptoTradingEngine;
  klineStore: KlineStore;
  riskConfig?: Pick<RiskConfig, "cvarLookbackDays" | "cvarTailAlpha">;
  eventLog?: EventLog;
  baseDir?: string;
  manualOverridePath?: string;
  config?: LiveGateManagerConfigOverride;
}

export interface RuntimePlanningState {
  regimeSeverity: "stable" | "watch" | "high";
  regimeReason: string | null;
  capitalRampStage: string;
  releaseGateStatus: PersistedReleaseGateStatus | null;
  releaseGateBlocked: boolean;
  releaseGateBlockedReason: string | null;
  releaseGateAllowsPaperTrading?: boolean | null;
  releaseGateAllowsLiveTrading?: boolean | null;
  paperTradingBlocked?: boolean;
  paperTradingBlockedReason?: string | null;
  availableSymbols?: string[];
  regimeShiftSymbol?: string | null;
  volatilitySymbol?: string | null;
  liveDeploymentMode?: "not_ready" | "tiny_cap_only" | "normal_cap";
  liveDeploymentReason?: string | null;
  tinyCapitalMaxUsd?: number | null;
  tinyCapitalMaxEquityFraction?: number | null;
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
  releaseGateStatusPath: "data/runtime/release_gate_status.json",
  releaseGateStatusCacheTtlMs: 60_000,
  requirePromotionV2ForLiveOrders: false,
  promotionReadinessV2Path: DEFAULT_PROMOTION_READINESS_V2_PATH,
  validatePromotionV2Artifacts: true,
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
  deploymentRamp: {
    enabled: false,
    tinyCapitalMaxUsd: 100,
    tinyCapitalMaxEquityFraction: 0.02,
  },
};

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
  private regimeShiftCache: {
    atMs: number;
    result: RegimeShiftResult | null;
  } | null = null;
  private toxicFlowAlert: ToxicFlowAlert | null = null;

  constructor(
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
      regimeShift: {
        ...DEFAULT_CONFIG.regimeShift,
        ...(opts.config?.regimeShift ?? {}),
      },
      deploymentRamp: {
        ...DEFAULT_CONFIG.deploymentRamp,
        ...(opts.config?.deploymentRamp ?? {}),
      },
    };
    this.currentDate = toDateKey(new Date());
  }

  getCurrentRampStageLabel(): string {
    return this.rampStore.getCurrentStageLabel();
  }

  /**
   * Update the toxic-flow alert state from the microstructure layer.
   * Only accepts alerts with a timestamp >= the current alert to prevent
   * stale updates from overwriting fresher alerts when multiple producers
   * or delayed callbacks are in flight.
   */
  setToxicFlowAlert(alert: ToxicFlowAlert): void {
    if (
      this.toxicFlowAlert &&
      this.toxicFlowAlert.timestamp > alert.timestamp
    ) {
      return
    }
    this.toxicFlowAlert = alert
  }

  clearToxicFlowAlert(): void {
    this.toxicFlowAlert = null
  }

  async beforePlaceOrder(
    req: CryptoPlaceOrderRequest
  ): Promise<RiskCheckResult | undefined> {
    const manualOverride = await loadManualOverride({
      filePath: this.manualOverridePath,
      eventLog: this.opts.eventLog,
    });
    if (!req.reduceOnly && manualOverride.pauseNewOpens) {
      return {
        approved: false,
        reason: "Manual override is pausing new opens.",
      };
    }

    if (
      !req.reduceOnly &&
      this.config.requireReleaseGatePass &&
      !manualOverride.ignoreReleaseGate
    ) {
      const gateStatus = await this.loadReleaseGateStatus();
      const deployment = this.resolveLiveDeploymentMode(gateStatus);
      if (deployment.mode === "not_ready") {
        return {
          approved: false,
          reason: `Release gate blocking new opens: ${deployment.reason ?? "unknown"}`,
        };
      }

      if (deployment.mode === "tiny_cap_only") {
        const expectedPrice = await this.estimateExpectedPrice(req);
        const requestedNotionalUsd = estimateRequestedNotionalUsd(
          req,
          expectedPrice,
        );
        if (!(requestedNotionalUsd && requestedNotionalUsd > 0)) {
          return {
            approved: false,
            reason: "Tiny-capital mode requires a positive order notional.",
          };
        }

        const account = await this.opts.engine.getAccount();
        const equity = account.equity > 0 ? account.equity : account.balance;
        const tinyCapLimitUsd = this.resolveTinyCapitalLimitUsd(equity);
        if (requestedNotionalUsd > tinyCapLimitUsd) {
          return {
            approved: false,
            reason:
              `Tiny-capital mode allows at most ${tinyCapLimitUsd.toFixed(2)} USD ` +
              `per new open; requested ${requestedNotionalUsd.toFixed(2)} USD.`,
          };
        }
      }
    }

    if (!req.reduceOnly && this.config.requirePromotionV2ForLiveOrders) {
      const promotionV2Decision = await this.evaluatePromotionV2LiveOrderGate();
      if (promotionV2Decision) {
        return promotionV2Decision;
      }
    }

    if (!req.reduceOnly && !manualOverride.ignoreRegimeShift) {
      const regime = await this.refreshRegimeShiftSignal();
      if (regime && regime.triggered && regime.severity === "high") {
        return {
          approved: false,
          reason: `Regime-shift high severity: ${regime.reason}; new opens are paused.`,
        };
      }
    }

    if (!req.reduceOnly && this.riskBreakerStore.isExecutionBreakerActive()) {
      return {
        approved: false,
        reason:
          this.riskBreakerStore.getExecutionBreakerReason() ??
          "Execution-quality breaker is active.",
      };
    }

    if (!req.reduceOnly && this.toxicFlowAlert?.severity === 'critical') {
      return {
        approved: false,
        reason: `Toxic flow critical: ${this.toxicFlowAlert.reason}. New opens blocked.`,
      }
    }

    return undefined;
  }

  private async evaluatePromotionV2LiveOrderGate(): Promise<RiskCheckResult | undefined> {
    const loaded = this.config.validatePromotionV2Artifacts
      ? await tryLoadValidatedPromotionReadinessV2(
          dirname(this.config.promotionReadinessV2Path),
        )
      : await tryLoadPromotionReadinessV2(
          this.config.promotionReadinessV2Path,
        );
    if (loaded.kind !== "loaded" && !(loaded.kind === "invalid" && loaded.readiness)) {
      return {
        approved: false,
        reason: `Promotion v2 readiness ${loaded.kind}: ${loaded.error}`,
      };
    }

    const hardBlocks = evaluatePromotionReadinessForLiveOrders(
      loaded.readiness,
      {
        required: true,
        now: new Date(),
      },
    );
    if (hardBlocks.length > 0) {
      return {
        approved: false,
        reason: `Promotion v2 blocking live order generation: ${hardBlocks.join(",")}`,
      };
    }

    return undefined;
  }

  async buildRiskContext(): Promise<RiskCheckContext | undefined> {
    const manualOverride = await loadManualOverride({
      filePath: this.manualOverridePath,
      eventLog: this.opts.eventLog,
    });
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
      const marketData =
        await this.opts.klineStore.marketDataProvider.getMarketData(
          this.opts.klineStore.getPlayheadTime(),
          req.symbol
        );
      if (Number.isFinite(marketData.close) && marketData.close > 0) {
        return marketData.close;
      }
    } catch {
      // no-op: fall through to undefined
    }

    return undefined;
  }

  async buildRuntimePlanningState(): Promise<RuntimePlanningState> {
    const manualOverride = await loadManualOverride({
      filePath: this.manualOverridePath,
      eventLog: this.opts.eventLog,
    });
    const gateStatus = await this.loadReleaseGateStatus();
    const now = new Date();
    const releaseGateDecision =
      this.config.requireReleaseGatePass && !manualOverride.ignoreReleaseGate
        ? isReleaseGateStatusBlocking(gateStatus, "live", now)
        : { blocking: false as const };
    const paperGateDecision =
      this.config.requireReleaseGatePass && !manualOverride.ignoreReleaseGate
        ? getPaperReleaseGateStatusBlocking(gateStatus, now)
        : { blocking: false as const };
    const regime = manualOverride.ignoreRegimeShift
      ? null
      : await this.refreshRegimeShiftSignal();
    const availableSymbols = this.opts.klineStore.getAvailableSymbols();
    const deployment = manualOverride.ignoreReleaseGate
      ? {
          mode: "normal_cap" as const,
          reason: "manual_override_ignore_release_gate",
        }
      : this.resolveLiveDeploymentMode(gateStatus);

    let capitalRampStage =
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
        capitalRampStage = this.getReducedStageLabel(reduction);
      }
    }

    return {
      regimeSeverity:
        regime?.triggered && regime.severity !== "none"
          ? regime.severity
          : "stable",
      regimeReason: regime?.reason ?? null,
      capitalRampStage,
      releaseGateStatus: gateStatus,
      releaseGateBlocked: releaseGateDecision.blocking,
      releaseGateBlockedReason: releaseGateDecision.reason ?? null,
      releaseGateAllowsPaperTrading: gateStatus?.allowPaperTrading ?? null,
      releaseGateAllowsLiveTrading: gateStatus?.allowLiveTrading ?? null,
      paperTradingBlocked: paperGateDecision.blocking,
      paperTradingBlockedReason: paperGateDecision.reason ?? null,
      availableSymbols,
      regimeShiftSymbol: resolvePlanningSymbol(
        this.config.regimeShift.symbol,
        availableSymbols
      ),
      volatilitySymbol: resolvePlanningSymbol(
        this.config.volatilitySymbol,
        availableSymbols
      ),
      liveDeploymentMode: deployment.mode,
      liveDeploymentReason: deployment.reason,
      tinyCapitalMaxUsd: this.config.deploymentRamp.enabled
        ? this.config.deploymentRamp.tinyCapitalMaxUsd
        : null,
      tinyCapitalMaxEquityFraction: this.config.deploymentRamp.enabled
        ? this.config.deploymentRamp.tinyCapitalMaxEquityFraction
        : null,
    };
  }

  async recordExecution(
    req: CryptoPlaceOrderRequest,
    result: CryptoOrderResult,
    expectedPrice?: number
  ): Promise<void> {
    const record = buildExecutionRecord(req, result, expectedPrice);
    if (!record) {
      return;
    }
    await this.executionStore.addRecord(record);
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

    const manualOverride = await loadManualOverride({
      filePath: this.manualOverridePath,
      eventLog: this.opts.eventLog,
    });
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
    const nowMs = Date.now();
    if (this.volatilityCache && nowMs - this.volatilityCache.atMs <= 60_000) {
      return this.volatilityCache.quantile;
    }

    const symbol =
      this.config.volatilitySymbol ??
      this.opts.klineStore.getAvailableSymbols()[0];
    if (!symbol) {
      return undefined;
    }

    try {
      const end = this.opts.klineStore.getPlayheadTime();
      const start = this.opts.klineStore.calculatePreviousTime(
        this.config.volatilityHistoryBars
      );
      const bars =
        await this.opts.klineStore.marketDataProvider.getMarketDataRange(
          start,
          end,
          symbol
        );
      if (bars.length < this.config.volatilityCurrentWindowBars + 2) {
        return undefined;
      }

      const closes = bars
        .map(bar => bar.close)
        .filter(value => Number.isFinite(value) && value > 0);
      if (closes.length < this.config.volatilityCurrentWindowBars + 2) {
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
        return undefined;
      }

      const currentVol = vols[vols.length - 1];
      const lessOrEqual = vols.filter(value => value <= currentVol).length;
      const quantile = lessOrEqual / vols.length;

      this.volatilityCache = { atMs: nowMs, quantile };
      return quantile;
    } catch {
      return undefined;
    }
  }

  private getReducedStageLabel(reduction: number): string {
    const currentIdx = this.rampStore.getCurrentStageIndex();
    const reducedIdx = Math.max(0, currentIdx - reduction);
    return this.rampStore.getStageLabelByIndex(reducedIdx);
  }

  private async loadReleaseGateStatus(
    forceRefresh = false
  ): Promise<PersistedReleaseGateStatus | null> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.releaseGateCache &&
      now - this.releaseGateCache.atMs <=
        this.config.releaseGateStatusCacheTtlMs
    ) {
      return this.releaseGateCache.status;
    }

    const status = await loadReleaseGateStatus(
      this.config.releaseGateStatusPath
    );
    this.releaseGateCache = {
      atMs: now,
      status,
    };
    return status;
  }

  private async refreshRegimeShiftSignal(
    forceRefresh = false
  ): Promise<RegimeShiftResult | null> {
    if (!this.config.regimeShift.enabled) {
      return null;
    }

    const nowMs = Date.now();
    if (
      !forceRefresh &&
      this.regimeShiftCache &&
      nowMs - this.regimeShiftCache.atMs <=
        this.config.regimeShift.checkIntervalMs
    ) {
      return this.regimeShiftCache.result;
    }

    const symbol =
      this.config.regimeShift.symbol ??
      this.opts.klineStore.getAvailableSymbols()[0];
    if (!symbol) {
      this.regimeShiftCache = { atMs: nowMs, result: null };
      return null;
    }

    const barsNeeded =
      this.config.regimeShift.baselineBars +
      this.config.regimeShift.recentBars +
      2;
    try {
      const end = this.opts.klineStore.getPlayheadTime();
      const start = this.opts.klineStore.calculatePreviousTime(barsNeeded);
      const bars =
        await this.opts.klineStore.marketDataProvider.getMarketDataRange(
          start,
          end,
          symbol
        );
      if (bars.length < barsNeeded) {
        this.regimeShiftCache = { atMs: nowMs, result: null };
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
      return result;
    } catch {
      this.regimeShiftCache = { atMs: nowMs, result: null };
      return null;
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

  private resolveLiveDeploymentMode(
    gateStatus: PersistedReleaseGateStatus | null,
  ): {
    mode: "not_ready" | "tiny_cap_only" | "normal_cap";
    reason: string | null;
  } {
    if (!gateStatus) {
      return {
        mode: "not_ready",
        reason: "release_gate_status_missing",
      };
    }

    if (gateStatus.expiresAt) {
      const expiresAt = Date.parse(gateStatus.expiresAt);
      if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
        return {
          mode: "not_ready",
          reason: `release_gate_status_expired:${gateStatus.expiresAt}`,
        };
      }
    }

    const skippedRequiredLiveChecks = getSkippedRequiredLiveChecks(gateStatus);
    if (skippedRequiredLiveChecks.length > 0) {
      return {
        mode: "not_ready",
        reason: `live_release_gate_required_checks_skipped:${skippedRequiredLiveChecks.join(",")}`,
      };
    }

    if (gateStatus.allowLiveTrading) {
      return {
        mode: "normal_cap",
        reason: null,
      };
    }

    if (gateStatus.failedChecks.length > 0) {
      return {
        mode: "not_ready",
        reason: `live_release_gate_failed:${gateStatus.failedChecks.join(",")}`,
      };
    }

    if (
      this.config.deploymentRamp.enabled &&
      gateStatus.allowTinyCapLiveTrading === true &&
      gateStatus.allowPaperTrading &&
      getSkippedRequiredLiveChecks(gateStatus).length === 0
    ) {
      return {
        mode: "tiny_cap_only",
        reason: "paper_ready_live_tiny_cap_only",
      };
    }

    return {
      mode: "not_ready",
      reason: gateStatus.allowPaperTrading
        ? "live_release_gate_not_passed"
        : "paper_release_gate_not_passed",
    };
  }

  private resolveTinyCapitalLimitUsd(equity: number): number {
    const byUsd = Math.max(0, this.config.deploymentRamp.tinyCapitalMaxUsd);
    const byEquity =
      equity > 0
        ? equity * Math.max(0, this.config.deploymentRamp.tinyCapitalMaxEquityFraction)
        : byUsd;
    return Math.max(0, Math.min(byUsd, byEquity));
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

function getPaperReleaseGateStatusBlocking(
  status: PersistedReleaseGateStatus | null,
  now: Date = new Date()
): { blocking: boolean; reason?: string } {
  if (!status) {
    return {
      blocking: true,
      reason: "release_gate_status_missing",
    };
  }

  if (status.expiresAt) {
    const expiresAt = Date.parse(status.expiresAt);
    if (Number.isFinite(expiresAt) && now.getTime() > expiresAt) {
      return {
        blocking: true,
        reason: `release_gate_status_expired:${status.expiresAt}`,
      };
    }
  }

  if (!status.allowPaperTrading) {
    return {
      blocking: true,
      reason: `paper_release_gate_failed:${status.failedChecks.join(",") || "unknown"}`,
    };
  }

  return { blocking: false };
}

function resolvePlanningSymbol(
  configuredSymbol: string | undefined,
  availableSymbols: string[]
): string | null {
  if (configuredSymbol && configuredSymbol.trim().length > 0) {
    return configuredSymbol;
  }
  return availableSymbols[0] ?? null;
}
