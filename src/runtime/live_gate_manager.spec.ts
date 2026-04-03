import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RampUpStore } from "../deployment/ramp_up_store.js";
import { ExecutionQualityStore } from "../live/execution_quality_store.js";
import type {
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
  ICryptoTradingEngine,
} from "../extension/crypto-trading/interfaces.js";
import { RiskBreakerStore } from "./risk_breaker_state.js";
import { LiveGateManager, type LiveGateManagerConfig } from "./live_gate_manager.js";

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
        failedChecks: ["significance"],
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

  it("buildRuntimePlanningState exposes tiny-cap-only deployment mode", async () => {
    const harness = await createHarness({
      releaseGateStatus: {
        version: 1,
        generatedAt: "2026-03-27T00:00:00.000Z",
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: ["significance"],
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
    expect(state.liveDeploymentMode).toBe("tiny_cap_only");
    expect(state.liveDeploymentReason).toBe("paper_ready_live_tiny_cap_only");
    expect(state.tinyCapitalMaxUsd).toBe(125);
    expect(state.tinyCapitalMaxEquityFraction).toBe(0.025);
    expect(state.releaseGateBlocked).toBe(true);
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

    (harness.manager as unknown as { currentDate: string }).currentDate =
      "2026-03-27";

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

async function createHarness(opts?: {
  engine?: ICryptoTradingEngine;
  manualOverride?: Record<string, unknown>;
  releaseGateStatus?: Record<string, unknown>;
  config?: Partial<LiveGateManagerConfig>;
  marketDataRange?: Array<{ close: number }>;
  initialRampStageLabel?: string;
  regimeShiftCacheResult?: Record<string, unknown>;
  availableSymbols?: string[];
}) {
  const tempDir = await mkdtemp(join(tmpdir(), "live-gate-manager-"));
  const manualOverridePath = join(tempDir, "manual_override.json");
  const releaseGateStatusPath = join(tempDir, "release_gate_status.json");

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
  const klineStore = {
    marketDataProvider: {
      getMarketData: vi.fn().mockResolvedValue({ close: 95 }),
      getMarketDataRange: vi
        .fn()
        .mockResolvedValue(opts?.marketDataRange ?? []),
    },
    getPlayheadTime: vi.fn(() => playhead),
    calculatePreviousTime: vi.fn((bars: number) => {
      return new Date(playhead.getTime() - bars * 60 * 60 * 1000);
    }),
    getAvailableSymbols: vi.fn(() => opts?.availableSymbols ?? ["BTC/USD"]),
  };

  const config: Partial<LiveGateManagerConfig> = {
    releaseGateStatusPath,
    ...(opts?.config ?? {}),
    regimeShift: {
      enabled: false,
      ...(opts?.config?.regimeShift ?? {}),
    },
  };

  const Ctor = LiveGateManager as unknown as new (
    opts: ConstructorParameters<typeof createManagerOptions>[0],
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
    (manager as unknown as {
      regimeShiftCache: { atMs: number; result: Record<string, unknown> };
    }).regimeShiftCache = {
      atMs: Date.now(),
      result: opts.regimeShiftCacheResult,
    };
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
  config: Partial<LiveGateManagerConfig>;
}) {
  return {
    engine: input.engine,
    klineStore: input.klineStore as any,
    baseDir: input.tempDir,
    manualOverridePath: input.manualOverridePath,
    config: input.config,
  };
}

function buildRegimeBars(opts: { shock: "watch" | "high" }): Array<{ close: number }> {
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
  return closes.map(close => ({ close }));
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
    }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOrders: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue({
      balance: 10_000,
      totalMargin: 0,
      unrealizedPnL: 0,
      equity: 10_000,
      realizedPnL: 0,
      totalPnL: 0,
    }),
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
    }),
    getFundingRate: vi.fn().mockResolvedValue({
      symbol: "BTC/USD",
      fundingRate: 0.0001,
      timestamp: new Date(),
    }),
    getOrderBook: vi.fn().mockResolvedValue({
      symbol: "BTC/USD",
      bids: [],
      asks: [],
      timestamp: new Date(),
    }),
    ...overrides,
  };
}
