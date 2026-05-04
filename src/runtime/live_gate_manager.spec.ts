import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IMarketDataProvider, MarketData } from "../extension/analysis-kit/data/interfaces.js";
import type { KlineStore } from "../extension/analysis-kit/kline/KlineStore.js";
import { RampUpStore } from "../deployment/ramp_up_store.js";
import { ExecutionQualityStore } from "../live/execution_quality_store.js";
import type {
  CryptoAccountInfo,
  CryptoFundingRate,
  CryptoOrder,
  CryptoOrderBook,
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
  CryptoTicker,
  ICryptoTradingEngine,
} from "../domain/trading/operation-dispatcher.types.js";
import { RiskBreakerStore } from "./risk_breaker_state.js";
import {
  LiveGateManager,
  type LiveGateManagerOptions,
  type LiveGateManagerOptionsConfig,
} from "./live_gate_manager.js";
import type { RegimeShiftResult } from "./regime_shift.js";
import {
  PROMOTION_V2_SCHEMA_VERSION,
  buildPromotionReadinessV2,
  makeGateResult,
  type PromotionReadinessV2,
  type SchemaMeta,
} from "./promotion_v2.js";

describe("live_gate_manager", () => {
  it("beforePlaceOrder blocks new opens when manual override pauses them", async () => {
    const harness = await createHarness({
      manualOverride: { pauseNewOpens: true },
    });

    const blocked = await harness.manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
    });
    expect(blocked?.approved).toBe(false);
    expect(String(blocked?.reason)).toContain("Manual override");

    const reduceOnlyAllowed = await harness.manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "sell",
      type: "market",
      reduceOnly: true,
    });
    expect(reduceOnlyAllowed).toBeUndefined();
  });

  it("beforePlaceOrder blocks on release gate and execution breaker", async () => {
    const gateHarness = await createHarness({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: ["wfo"],
        warningChecks: [],
      },
      config: {
        releaseGateStatusCacheTtlMs: 0,
        regimeShift: { enabled: false },
      },
    });

    const gateBlocked = await gateHarness.manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
    });
    expect(gateBlocked?.approved).toBe(false);
    expect(String(gateBlocked?.reason)).toContain("Release gate");

    const breakerHarness = await createHarness({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      config: {
        regimeShift: { enabled: false },
      },
    });
    await breakerHarness.riskBreakerStore.applyExecutionGateDecision({
      action: "reduce_or_pause",
      consecutiveBreaches: 3,
      requiredConsecutiveDays: 3,
      breachedDates: ["2026-03-27"],
      latestDriftMultiplier: 4,
    });

    const breakerBlocked = await breakerHarness.manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
    });
    expect(breakerBlocked?.approved).toBe(false);
    expect(String(breakerBlocked?.reason)).toContain("execution_drift");
  });

  it("beforePlaceOrder blocks live new opens when required promotion v2 readiness is missing", async () => {
    const harness = await createHarness({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      config: {
        requirePromotionV2ForLiveOrders: true,
        validatePromotionV2Artifacts: false,
        regimeShift: { enabled: false },
      },
    });

    const blocked = await harness.manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
    });

    expect(blocked?.approved).toBe(false);
    expect(String(blocked?.reason)).toContain("Promotion v2 readiness missing");
  });

  it("beforePlaceOrder requires tiny-cap promotion v2 readiness for live new opens", async () => {
    const paperOnlyHarness = await createHarness({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      promotionReadinessV2: createPromotionReadiness({ liveReady: false }),
      config: {
        requirePromotionV2ForLiveOrders: true,
        validatePromotionV2Artifacts: false,
        regimeShift: { enabled: false },
      },
    });

    const paperOnlyBlocked = await paperOnlyHarness.manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
    });
    expect(paperOnlyBlocked?.approved).toBe(false);
    expect(String(paperOnlyBlocked?.reason)).toContain(
      "promotion_v2_blocks_live_orders:paper_allowed",
    );

    const tinyCapHarness = await createHarness({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      promotionReadinessV2: createPromotionReadiness({ liveReady: true }),
      config: {
        requirePromotionV2ForLiveOrders: true,
        validatePromotionV2Artifacts: false,
        regimeShift: { enabled: false },
      },
    });

    const allowed = await tinyCapHarness.manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
    });
    expect(allowed).toBeUndefined();
  });

  it("buildRiskContext respects manual override forced values", async () => {
    const harness = await createHarness({
      engine: createMockEngine({
        getAccount: vi.fn().mockResolvedValue({
          balance: 10_000,
          totalMargin: 0,
          unrealizedPnL: 0,
          equity: 1_000,
          realizedPnL: 0,
          totalPnL: -100,
        }),
      }),
      manualOverride: {
        pauseNewOpens: false,
        ignoreRegimeShift: true,
        forceCapitalRampStage: "25%",
        forceVolatilityQuantile: 0.9,
        forceDailyLossPct: -2,
        forceCvarDailyLossPct: -4,
        forceConsecutiveLossDays: 3,
        forceConsecutiveLossPct: -5,
      },
    });

    await harness.riskBreakerStore.upsertDailyPnl("2026-03-25", -1);
    await harness.riskBreakerStore.upsertDailyPnl("2026-03-26", -1.5);

    const context = await harness.manager.buildRiskContext();
    expect(context).toEqual({
      dailyLossPct: -2,
      cvarDailyLossPct: -4,
      consecutiveLossDays: 3,
      consecutiveLossPct: -5,
      volatilityQuantile: 0.9,
      capitalRampStage: "25%",
    });
  });

  it("recordExecution normalizes fallback prices and quantities into the execution store", async () => {
    const harness = await createHarness();
    const completedAtMs = Date.parse("2026-03-27T12:00:00.000Z");

    await harness.manager.recordExecution(
      {
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 950,
      },
      {
        success: true,
        orderId: "ord-1",
        firstFillAtMs: completedAtMs,
        completedAtMs,
      },
      95
    );

    const state = harness.executionStore.getState();
    expect(state.recordsByDate["2026-03-27"]).toHaveLength(1);
    expect(state.recordsByDate["2026-03-27"][0]).toMatchObject({
      orderId: "ord-1",
      symbol: "BTC/USD",
      side: "buy",
      expectedPrice: 95,
      actualPrice: 95,
      requestedQty: 10,
      filledQty: 10,
    });
  });

  it("buildRuntimePlanningState exposes stable planning inputs", async () => {
    const harness = await createHarness({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      config: {
        regimeShift: { enabled: false },
      },
    });

    const state = await harness.manager.buildRuntimePlanningState();
    expect(state).toMatchObject({
      regimeSeverity: "stable",
      regimeReason: null,
      capitalRampStage: "5%",
      releaseGateBlocked: false,
      releaseGateBlockedReason: null,
      releaseGateAllowsPaperTrading: true,
      releaseGateAllowsLiveTrading: true,
      paperTradingBlocked: false,
      paperTradingBlockedReason: null,
      availableSymbols: ["BTC/USD"],
      regimeShiftSymbol: "BTC/USD",
      volatilitySymbol: "BTC/USD",
    });
    expect(state.releaseGateStatus?.allowLiveTrading).toBe(true);
  });

  it("buildRuntimePlanningState exposes paper-first release-gate truth independently from live gating", async () => {
    const harness = await createHarness({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: false,
        allowLiveTrading: true,
        failedChecks: ["paper_consistency"],
        warningChecks: [],
      },
      config: {
        regimeShift: { enabled: false },
      },
    });

    const state = await harness.manager.buildRuntimePlanningState();
    expect(state.releaseGateBlocked).toBe(false);
    expect(state.releaseGateBlockedReason).toBeNull();
    expect(state.releaseGateAllowsPaperTrading).toBe(false);
    expect(state.releaseGateAllowsLiveTrading).toBe(true);
    expect(state.paperTradingBlocked).toBe(true);
    expect(String(state.paperTradingBlockedReason)).toContain(
      "paper_release_gate_failed"
    );
  });

  it("buildRuntimePlanningState applies watch-stage reduction and blocked release gate", async () => {
    const harness = await createHarness({
      initialRampStageLabel: "25%",
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: ["wfo"],
        warningChecks: [],
      },
      config: {
        regimeShift: {
          enabled: true,
          watchStageReduction: 1,
          highStageReduction: 2,
        },
      },
      regimeShiftCacheResult: {
        triggered: true,
        severity: "watch",
        reason: "watch_regime_shift",
        metrics: {
          recentVol: 1,
          baselineVolMean: 0.5,
          baselineVolStd: 0.1,
          recentMeanReturn: 0.02,
          baselineMeanReturn: 0.001,
          baselineMeanStd: 0.001,
          volZ: 5,
          trendZ: 19,
        },
      },
    });

    const state = await harness.manager.buildRuntimePlanningState();
    expect(state.regimeSeverity).toBe("watch");
    expect(state.regimeReason).toBe("watch_regime_shift");
    expect(state.capitalRampStage).toBe("10%");
    expect(state.releaseGateBlocked).toBe(true);
    expect(String(state.releaseGateBlockedReason)).toContain("release_gate_failed");
  });

  it("beforePlaceOrder enforces tiny-capital notional limits when live is tiny-cap only", async () => {
    const harness = await createHarness({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        allowTinyCapLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      config: {
        regimeShift: { enabled: false },
        deploymentRamp: {
          enabled: true,
          tinyCapitalMaxUsd: 100,
          tinyCapitalMaxEquityFraction: 0.05,
        },
      },
    });

    const blocked = await harness.manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      usd_size: 150,
    });
    expect(blocked?.approved).toBe(false);
    expect(String(blocked?.reason)).toContain("Tiny-capital mode allows at most 100.00 USD");

    const allowed = await harness.manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      usd_size: 75,
    });
    expect(allowed).toBeUndefined();
  });

  it("does not allow tiny-cap deployment when required live checks were skipped", async () => {
    const harness = await createHarness({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        allowTinyCapLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
        checks: [
          {
            name: "execution_quality",
            status: "skipped",
            summary: "Execution quality gate not provided; skipping gate.",
            metrics: {},
          },
          {
            name: "ramp_up",
            status: "skipped",
            summary: "Ramp-up status not provided; skipping gate.",
            metrics: {},
          },
          {
            name: "regime_shift",
            status: "skipped",
            summary: "Regime-shift gate not provided; skipping gate.",
            metrics: {},
          },
        ],
      },
      config: {
        regimeShift: { enabled: false },
        deploymentRamp: {
          enabled: true,
          tinyCapitalMaxUsd: 125,
          tinyCapitalMaxEquityFraction: 0.025,
        },
      },
    });

    const blocked = await harness.manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      usd_size: 75,
    });
    expect(blocked?.approved).toBe(false);
    expect(String(blocked?.reason)).toContain("Release gate");

    const state = await harness.manager.buildRuntimePlanningState();
    expect(state.liveDeploymentMode).toBe("not_ready");
    expect(String(state.liveDeploymentReason)).toContain("required_checks_skipped");
    expect(state.releaseGateAllowsPaperTrading).toBe(true);
    expect(state.releaseGateAllowsLiveTrading).toBe(false);
  });

  it("does not allow tiny-cap deployment when the release gate status is expired", async () => {
    const harness = await createHarness({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        expiresAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        allowTinyCapLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      config: {
        releaseGateStatusCacheTtlMs: 0,
        regimeShift: { enabled: false },
        deploymentRamp: {
          enabled: true,
          tinyCapitalMaxUsd: 125,
          tinyCapitalMaxEquityFraction: 0.025,
        },
      },
    });

    const blocked = await harness.manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      usd_size: 75,
    });
    expect(blocked?.approved).toBe(false);
    expect(String(blocked?.reason)).toContain("release_gate_status_expired");

    const state = await harness.manager.buildRuntimePlanningState();
    expect(state.liveDeploymentMode).toBe("not_ready");
    expect(String(state.liveDeploymentReason)).toContain("release_gate_status_expired");
  });

  it("buildRuntimePlanningState exposes normal-cap mode when live release gate passes", async () => {
    const harness = await createHarness({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      config: {
        regimeShift: { enabled: false },
        deploymentRamp: {
          enabled: true,
          tinyCapitalMaxUsd: 125,
          tinyCapitalMaxEquityFraction: 0.025,
        },
      },
    });

    const state = await harness.manager.buildRuntimePlanningState();
    expect(state.liveDeploymentMode).toBe("normal_cap");
    expect(state.liveDeploymentReason).toBeNull();
  });

  it("buildRuntimePlanningState exposes high severity without stage forcing", async () => {
    const harness = await createHarness({
      initialRampStageLabel: "25%",
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      config: {
        regimeShift: {
          enabled: true,
          watchStageReduction: 1,
          highStageReduction: 2,
        },
      },
      regimeShiftCacheResult: {
        triggered: true,
        severity: "high",
        reason: "high_regime_shift",
        metrics: {
          recentVol: 2,
          baselineVolMean: 0.5,
          baselineVolStd: 0.1,
          recentMeanReturn: 0.05,
          baselineMeanReturn: 0.001,
          baselineMeanStd: 0.001,
          volZ: 15,
          trendZ: 49,
        },
      },
    });

    const state = await harness.manager.buildRuntimePlanningState();
    expect(state.regimeSeverity).toBe("high");
    expect(state.regimeReason).toBe("high_regime_shift");
    expect(state.capitalRampStage).toBe("5%");
    expect(state.releaseGateBlocked).toBe(false);
  });

  it("buildRuntimePlanningState exposes dual-symbol planning anchors", async () => {
    const harness = await createHarness({
      availableSymbols: ["BTC/USD", "ETH/USD"],
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
      },
      config: {
        volatilitySymbol: "ETH/USD",
        regimeShift: {
          enabled: false,
          symbol: "BTC/USD",
        },
      },
    });

    const state = await harness.manager.buildRuntimePlanningState();
    expect(state.availableSymbols).toEqual(["BTC/USD", "ETH/USD"]);
    expect(state.regimeShiftSymbol).toBe("BTC/USD");
    expect(state.volatilitySymbol).toBe("ETH/USD");
  });

  it("tick finalizes the previous day and writes a daily gate summary", async () => {
    const harness = await createHarness({
      engine: createMockEngine({
        getAccount: vi.fn().mockResolvedValue({
          balance: 10_000,
          totalMargin: 0,
          unrealizedPnL: 0,
          equity: 1_000,
          realizedPnL: 0,
          totalPnL: 50,
        }),
      }),
      config: {
        regimeShift: { enabled: false },
      },
    });
    const completedAtMs = Date.parse("2026-03-27T12:00:00.000Z");

    await harness.manager.recordExecution(
      {
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        size: 1,
      },
      {
        success: true,
        orderId: "ord-2",
        requestedSize: 1,
        filledSize: 1,
        filledPrice: 101,
        firstFillAtMs: completedAtMs,
        completedAtMs,
      },
      100
    );

    setManagerCurrentDate(harness.manager, "2026-03-27");

    await harness.manager.tick(new Date("2026-03-28T00:00:00.000Z"));

    expect(harness.executionStore.getSummary("2026-03-27")).not.toBeNull();
    expect(harness.riskBreakerStore.getState().dailyPnl).toContainEqual({
      date: "2026-03-27",
      dailyReturnPct: 5,
    });

    const summaryPath = join(
      harness.tempDir,
      "runtime",
      "gate_summaries",
      "2026-03-27.json"
    );
    const summary = JSON.parse(await readFile(summaryPath, "utf-8")) as {
      executionSummary: { filledOrderCount: number } | null;
      capitalRampStage: string;
    };
    expect(summary.executionSummary?.filledOrderCount).toBe(1);
    expect(summary.capitalRampStage).toBe("5%");
  });
});

interface HarnessOptions {
  engine?: ICryptoTradingEngine;
  manualOverride?: Record<string, unknown>;
  releaseGateStatus?: Record<string, unknown>;
  config?: LiveGateManagerOptionsConfig;
  promotionReadinessV2?: PromotionReadinessV2;
  marketDataRange?: MarketData[];
  initialRampStageLabel?: string;
  regimeShiftCacheResult?: RegimeShiftResult;
  availableSymbols?: string[];
}

async function createHarness(opts?: HarnessOptions) {
  const tempDir = await mkdtemp(join(tmpdir(), "live-gate-manager-"));
  const manualOverridePath = join(tempDir, "manual_override.json");
  const releaseGateStatusPath = join(tempDir, "release_gate_status.json");
  const promotionReadinessV2Path = join(tempDir, "strategy_promotion.latest.json");

  if (opts?.manualOverride) {
    await writeFile(
      manualOverridePath,
      `${JSON.stringify(opts.manualOverride, null, 2)}\n`,
      "utf-8"
    );
  }
  if (opts?.releaseGateStatus) {
    await writeFile(
      releaseGateStatusPath,
      `${JSON.stringify(opts.releaseGateStatus, null, 2)}\n`,
      "utf-8"
    );
  }
  if (opts?.promotionReadinessV2) {
    await writeFile(
      promotionReadinessV2Path,
      `${JSON.stringify(opts.promotionReadinessV2, null, 2)}\n`,
      "utf-8"
    );
  }

  const executionStore = await ExecutionQualityStore.load(
    join(tempDir, "execution_quality_state.json")
  );
  const rampStore = await RampUpStore.load(join(tempDir, "ramp_up_state.json"));
  if (opts?.initialRampStageLabel) {
    await rampStore.setStageByLabel(opts.initialRampStageLabel, "2026-03-27");
  }
  const riskBreakerStore = await RiskBreakerStore.load(
    join(tempDir, "risk_breaker_state.json")
  );

  const engine = opts?.engine ?? createMockEngine();
  const playhead = new Date("2026-03-28T00:00:00.000Z");
  const marketDataProvider: IMarketDataProvider = {
    getMarketData: vi.fn().mockResolvedValue(buildMarketData(95, playhead, "BTC/USD")),
    getMarketDataRange: vi.fn().mockResolvedValue(opts?.marketDataRange ?? []),
    getAvailableSymbols: vi.fn(() => opts?.availableSymbols ?? ["BTC/USD"]),
  };
  const klineStore: KlineStore = {
    marketDataProvider,
    getPlayheadTime: vi.fn(() => playhead),
    calculatePreviousTime: vi.fn((bars: number) => {
      return new Date(playhead.getTime() - bars * 60 * 60 * 1000);
    }),
    getAvailableSymbols: vi.fn(() => opts?.availableSymbols ?? ["BTC/USD"]),
  };

  const config: LiveGateManagerOptionsConfig = {
    releaseGateStatusPath,
    promotionReadinessV2Path,
    regimeShift: {
      enabled: false,
      ...(opts?.config?.regimeShift ?? {}),
    },
    ...opts?.config,
  };

  const Ctor = LiveGateManager as unknown as new (
    opts: LiveGateManagerOptions,
    executionStore: ExecutionQualityStore,
    rampStore: RampUpStore,
    riskBreakerStore: RiskBreakerStore
  ) => LiveGateManager;

  const manager = new Ctor(
    createManagerOptions({
      engine,
      klineStore,
      tempDir,
      manualOverridePath,
      config,
    }),
    executionStore,
    rampStore,
    riskBreakerStore
  );
  if (opts?.regimeShiftCacheResult) {
    setManagerRegimeShiftCache(manager, opts.regimeShiftCacheResult);
  }

  return {
    tempDir,
    manager,
    engine,
    executionStore,
    rampStore,
    riskBreakerStore,
  };
}

function createManagerOptions(input: {
  engine: ICryptoTradingEngine;
  klineStore: unknown;
  tempDir: string;
  manualOverridePath: string;
  config: LiveGateManagerOptionsConfig;
}): LiveGateManagerOptions {
  return {
    engine: input.engine,
    klineStore: input.klineStore as any,
    baseDir: input.tempDir,
    manualOverridePath: input.manualOverridePath,
    config: input.config,
  };
}

function buildRegimeBars(opts: { shock: "watch" | "high" }): MarketData[] {
  const baselineBars = 24 * 90 + 24 + 2;
  const closes: number[] = [];
  let price = 100;
  for (let i = 0; i < baselineBars; i++) {
    if (i < baselineBars - 24) {
      price += i % 2 === 0 ? 0.05 : -0.05;
    } else if (opts.shock === "watch") {
      price += i % 2 === 0 ? 1.2 : -1.2;
    } else {
      price += i % 2 === 0 ? 3 : -3;
    }
    closes.push(price);
  }
  return closes.map((close, index) =>
    buildMarketData(
      close,
      new Date(Date.parse("2026-03-01T00:00:00.000Z") + index * 60 * 60 * 1000),
      "BTC/USD"
    )
  );
}

function buildMarketData(close: number, time: Date, symbol: string): MarketData {
  return {
    symbol,
    time: time.getTime(),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  };
}

function createMockEngine(
  overrides: Partial<ICryptoTradingEngine> = {}
): ICryptoTradingEngine {
  return {
    placeOrder: vi.fn().mockResolvedValue({
      success: true,
      orderId: "ord-001",
      filledPrice: 95_000,
      filledSize: 0.1,
    } satisfies CryptoOrderResult),
    getPositions: vi.fn().mockResolvedValue([]),
    getOrders: vi.fn().mockResolvedValue([] as CryptoOrder[]),
    getAccount: vi.fn().mockResolvedValue({
      balance: 10_000,
      totalMargin: 0,
      unrealizedPnL: 0,
      equity: 10_000,
      realizedPnL: 0,
      totalPnL: 0,
    } satisfies CryptoAccountInfo),
    cancelOrder: vi.fn().mockResolvedValue(true),
    adjustLeverage: vi.fn().mockResolvedValue({ success: true }),
    getTicker: vi.fn().mockResolvedValue({
      symbol: "BTC/USD",
      last: 95_000,
      bid: 94_999,
      ask: 95_001,
      high: 96_000,
      low: 94_000,
      volume: 1_000,
      timestamp: new Date(),
    } satisfies CryptoTicker),
    getFundingRate: vi.fn().mockResolvedValue({
      symbol: "BTC/USD",
      fundingRate: 0.0001,
      timestamp: new Date(),
    } satisfies CryptoFundingRate),
    getOrderBook: vi.fn().mockResolvedValue({
      symbol: "BTC/USD",
      bids: [],
      asks: [],
      timestamp: new Date(),
    } satisfies CryptoOrderBook),
    ...overrides,
  };
}

function createPromotionReadiness(input: { liveReady: boolean }): PromotionReadinessV2 {
  const generatedAt = "2026-03-28T00:00:00.000Z";
  const expiresAt = "2099-03-28T01:00:00.000Z";
  const schemaMeta: SchemaMeta = {
    schemaName: "strategy_promotion",
    schemaVersion: PROMOTION_V2_SCHEMA_VERSION,
    createdBy: "vitest",
    createdAt: generatedAt,
    codeCommit: "test",
  };

  return buildPromotionReadinessV2({
    schemaMeta,
    strategyId: "cross-sectional-v2",
    experimentId: "experiment-1",
    generatedAt,
    globalReleaseGate: makeGateResult({ gateName: "global_release", expiresAt }),
    researchGate: makeGateResult({ gateName: "research", expiresAt }),
    monetizationGate: makeGateResult({ gateName: "monetization", expiresAt }),
    paperGate: makeGateResult({ gateName: "paper", expiresAt }),
    liveGate: input.liveReady
      ? makeGateResult({ gateName: "live", expiresAt })
      : makeGateResult({
          gateName: "live",
          hardBlocks: ["tiny_cap_not_reviewed"],
          expiresAt,
        }),
    monetization: {
      netExpectancyBpsPerTrade: 30,
      netExpectancyUsdPerTrade: 3,
      netExpectancyUsdPerDay: 6,
      netExpectancyUsdPerMonth: 180,
      validSignalsPerMonth: 30,
      executableCapacityUsd: 5_000,
      turnoverPerDay: 0.2,
      routeAdjustedBreakEvenBps: 14,
      benchmarkExcessReturnBps: 18,
    },
    execution: {
      recentOrderCount: 20,
      slippageViolationCount: 0,
      actualToSimulatedCostRatio: 1.1,
      missedFillRate: 0.2,
      decayCircuitBreakerTriggered: false,
    },
    dataFreshness: {
      latestDecisionStatus: "fresh",
      staleBlockCount: 0,
      maxDataLatencyMinutes: 3,
    },
    evidence: {
      supportingEvidenceIds: ["evidence-1"],
      blockingEvidenceIds: [],
      missingRequiredEvidence: [],
    },
    now: new Date(generatedAt),
  });
}

function setManagerCurrentDate(manager: LiveGateManager, currentDate: string): void {
  (
    manager as unknown as {
      currentDate: string;
    }
  ).currentDate = currentDate;
}

function setManagerRegimeShiftCache(
  manager: LiveGateManager,
  result: RegimeShiftResult
): void {
  (
    manager as unknown as {
      regimeShiftCache: { atMs: number; result: RegimeShiftResult | null };
    }
  ).regimeShiftCache = {
    atMs: Date.now(),
    result,
  };
}
