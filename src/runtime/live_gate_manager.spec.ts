import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
  ICryptoTradingEngine,
} from "../extension/crypto-trading/interfaces.js";
import { writeCanaryState } from "./canary_state.js";
import { writeLiveRolloutReadiness } from "./live_rollout_readiness.js";

const fakeExecutionStore = {
  addRecord: vi.fn(),
  finalizeDate: vi.fn(),
  evaluateGate: vi.fn(),
};

const fakeRampStore = {
  getCurrentStageLabel: vi.fn(() => "5%"),
  getCurrentStageIndex: vi.fn(() => 0),
  getStageLabelByIndex: vi.fn(() => "5%"),
  recordDay: vi.fn(),
};

const fakeRiskBreakerStore = {
  isExecutionBreakerActive: vi.fn(() => false),
  getExecutionBreakerReason: vi.fn(() => null),
  isGateFailureBreakerActive: vi.fn(() => false),
  getGateFailureBreakerReason: vi.fn(() => null),
  recordGateEvaluationSuccess: vi.fn(async () => undefined),
  recordGateEvaluationFailure: vi.fn(async () => ({
    opened: false,
    consecutiveFailures: 1,
    backoffMs: null,
    blockedUntilMs: null,
  })),
  getConsecutiveLossStats: vi.fn(() => ({ days: 0, cumulativePct: 0 })),
  getTailLossStats: vi.fn(() => ({ windowDays: 30, tailAlpha: 0.2, sampleCount: 0, tailCount: 0 })),
  applyExecutionGateDecision: vi.fn(),
  upsertDailyPnl: vi.fn(),
  getState: vi.fn(() => ({
    version: 1,
    executionBreakerActive: false,
    executionBreakerReason: null,
    gateFailureBreakerActive: false,
    gateFailureBreakerReason: null,
    gateFailureConsecutiveFailures: 0,
    gateFailureBackoffMs: null,
    gateFailureBlockedUntilMs: null,
    dailyPnl: [],
    lastUpdatedAt: "2026-03-11T00:00:00.000Z",
  })),
};

const mockLoadManualOverride = vi.fn();
const mockLoadReleaseGateStatus = vi.fn();

vi.mock("../live/execution_quality_store.js", () => ({
  ExecutionQualityStore: {
    load: vi.fn(async () => fakeExecutionStore),
  },
}));

vi.mock("../deployment/ramp_up_store.js", () => ({
  RampUpStore: {
    load: vi.fn(async () => fakeRampStore),
  },
}));

vi.mock("./risk_breaker_state.js", () => ({
  RiskBreakerStore: {
    load: vi.fn(async () => fakeRiskBreakerStore),
  },
}));

vi.mock("./manual_override.js", () => ({
  loadManualOverride: mockLoadManualOverride,
}));

vi.mock("./release_gate_status.js", async () => {
  const actual = await vi.importActual<typeof import("./release_gate_status.js")>(
    "./release_gate_status.js"
  );
  return {
    ...actual,
    loadReleaseGateStatus: mockLoadReleaseGateStatus,
  };
});

const { LiveGateManager } = await import("./live_gate_manager.js");

function createMockEngine(
  overrides: Partial<ICryptoTradingEngine> = {}
): ICryptoTradingEngine {
  return {
    placeOrder: vi.fn(),
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
    cancelOrder: vi.fn(),
    adjustLeverage: vi.fn(),
    getTicker: vi.fn(),
    getFundingRate: vi.fn(),
    getOrderBook: vi.fn(),
    ...overrides,
  };
}

function createMarketContext(close = 101) {
  return {
    getPlayheadTime: () => new Date("2026-03-11T12:00:00.000Z"),
    calculatePreviousTime: (lookbackBars: number) => {
      const base = new Date("2026-03-11T12:00:00.000Z");
      base.setHours(base.getHours() - lookbackBars);
      return base;
    },
    getAvailableSymbols: () => ["BTC/USD"],
    marketDataProvider: {
      async getMarketData() {
        return {
          symbol: "BTC/USD",
          time: Date.parse("2026-03-11T12:00:00.000Z") / 1000,
          open: close,
          high: close,
          low: close,
          close,
          volume: 1000,
        };
      },
      async getMarketDataRange() {
        return [
          {
            symbol: "BTC/USD",
            time: Date.parse("2026-03-11T11:00:00.000Z") / 1000,
            open: close - 1,
            high: close,
            low: close - 2,
            close: close - 1,
            volume: 900,
          },
          {
            symbol: "BTC/USD",
            time: Date.parse("2026-03-11T12:00:00.000Z") / 1000,
            open: close,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1000,
          },
        ];
      },
    },
  };
}

async function createManager(opts?: {
  engine?: ICryptoTradingEngine;
  marketContext?: ReturnType<typeof createMarketContext>;
  config?: Record<string, unknown>;
  eventLog?: { append: ReturnType<typeof vi.fn> };
}) {
  const engine = opts?.engine ?? createMockEngine();
  const marketContext = opts?.marketContext ?? createMarketContext();

  return LiveGateManager.create({
    engine,
    marketContext,
    // Backward-compat hedge while source is being refactored.
    klineStore: marketContext,
    baseDir: "/tmp/openalice-live-gate-tests",
    manualOverridePath: "/tmp/openalice-live-gate-tests/manual_override.json",
    riskConfig: {
      cvarLookbackDays: 30,
      cvarTailAlpha: 0.2,
    },
    eventLog: opts?.eventLog,
    config: {
      liveCanary: {
        enabled: false,
      },
      rolloutReadiness: {
        enabled: false,
      },
      ...(opts?.config ?? {}),
    },
  } as any);
}

describe("live_gate_manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadManualOverride.mockReset();
    mockLoadReleaseGateStatus.mockReset();
    fakeRampStore.getCurrentStageLabel.mockReturnValue("5%");
    fakeRampStore.getCurrentStageIndex.mockReturnValue(0);
    fakeRampStore.getStageLabelByIndex.mockReturnValue("5%");
    fakeRiskBreakerStore.isExecutionBreakerActive.mockReturnValue(false);
    fakeRiskBreakerStore.getExecutionBreakerReason.mockReturnValue(null);
    fakeRiskBreakerStore.isGateFailureBreakerActive.mockReturnValue(false);
    fakeRiskBreakerStore.getGateFailureBreakerReason.mockReturnValue(null);
    fakeRiskBreakerStore.recordGateEvaluationSuccess.mockResolvedValue(undefined);
    fakeRiskBreakerStore.recordGateEvaluationFailure.mockResolvedValue({
      opened: false,
      consecutiveFailures: 1,
      backoffMs: null,
      blockedUntilMs: null,
    });
    fakeRiskBreakerStore.getConsecutiveLossStats.mockReturnValue({
      days: 0,
      cumulativePct: 0,
    });
    fakeRiskBreakerStore.getTailLossStats.mockReturnValue({
      windowDays: 30,
      tailAlpha: 0.2,
      sampleCount: 0,
      tailCount: 0,
    });
    mockLoadManualOverride.mockResolvedValue({
      pauseNewOpens: false,
    });
    mockLoadReleaseGateStatus.mockResolvedValue({
      version: 1,
      generatedAt: "2026-03-11T00:00:00.000Z",
      allowPaperTrading: true,
      allowLiveTrading: true,
      failedChecks: [],
      warningChecks: [],
    });
  });

  it("blocks new opens when release gate status is missing", async () => {
    mockLoadReleaseGateStatus.mockResolvedValueOnce(null);
    const eventLog = { append: vi.fn(async () => undefined) };
    const manager = await createManager({ eventLog });

    const result = await manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      size: 0.1,
    });

    expect(result?.approved).toBe(false);
    expect(result?.reason).toContain("release_gate_status_missing");
    expect(eventLog.append).toHaveBeenCalledWith(
      "live-gate.blocked",
      expect.objectContaining({
        symbol: "BTC/USD",
        gateMode: "live",
        reduceOnly: false,
      }),
    );
  });

  it("blocks new opens when gate evaluation circuit breaker is active", async () => {
    fakeRiskBreakerStore.isGateFailureBreakerActive.mockReturnValue(true);
    fakeRiskBreakerStore.getGateFailureBreakerReason.mockReturnValue(
      "gate_eval_failure scope=regime_shift failures=3 error=provider unavailable",
    );
    const manager = await createManager();

    const result = await manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      size: 0.1,
    });

    expect(result?.approved).toBe(false);
    expect(result?.reason).toContain("gate_eval_failure");
  });

  it("blocks live opens when canary state file is missing", async () => {
    const eventLog = { append: vi.fn(async () => undefined) };
    const manager = await createManager({
      eventLog,
      config: {
        liveCanary: {
          enabled: true,
          statePath: "/tmp/openalice-live-gate-tests/missing-canary-state.json",
        },
      },
    });

    const result = await manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      size: 0.1,
    });

    expect(result?.approved).toBe(false);
    expect(result?.reason).toContain("canary_state_missing");
    expect(eventLog.append).toHaveBeenCalledWith(
      "canary.invalid_state",
      expect.objectContaining({
        reason: "missing",
      }),
    );
  });

  it("blocks live opens when micro-live approval has expired", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openalice-canary-live-gate-"));
    const statePath = join(tempDir, "canary_state.json");
    await writeCanaryState({
      version: 1,
      phase: "micro_live_running",
      environment: "micro_live",
      allowedSymbols: ["BTC/USD"],
      limits: {
        maxSymbols: 1,
        maxConcurrentOpens: 1,
        maxNotionalUsd: 25,
        maxEquityPct: 0.25,
      },
      window: {
        startedAt: "2026-03-10T00:00:00.000Z",
        minObservationMinutes: 240,
        expiresAt: "2026-03-10T01:00:00.000Z",
      },
      artifacts: {},
      metrics: {
        eventCounts: {
          heartbeatErrors: 0,
          gateCircuitOpen: 0,
          cronPaused: 0,
          pnlReconciliationAlerts: 0,
          paperExecutorFailures: 0,
          idempotencyDuplicates: 0,
        },
      },
      blockingReasons: [],
      approvedBy: "tester",
      lastTransitionAt: "2026-03-10T00:00:00.000Z",
    }, statePath);
    const eventLog = { append: vi.fn(async () => undefined) };
    const manager = await createManager({
      eventLog,
      config: {
        liveCanary: {
          enabled: true,
          statePath,
        },
      },
    });

    const result = await manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      usd_size: 10,
    });

    expect(result?.approved).toBe(false);
    expect(result?.reason).toContain("canary_state_expired");
    expect(eventLog.append).toHaveBeenCalledWith(
      "canary.expired",
      expect.objectContaining({
        path: statePath,
      }),
    );
  });

  it("blocks new opens when release gate status is expired", async () => {
    mockLoadReleaseGateStatus.mockResolvedValueOnce({
      version: 1,
      generatedAt: "2026-03-11T00:00:00.000Z",
      allowPaperTrading: true,
      allowLiveTrading: true,
      failedChecks: [],
      warningChecks: [],
      expiresAt: "2026-03-01T00:00:00.000Z",
    });
    const manager = await createManager();

    const result = await manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      size: 0.1,
    });

    expect(result?.approved).toBe(false);
    expect(result?.reason).toContain("release_gate_status_expired");
  });

  it("blocks live opens when rollout readiness artifact is missing", async () => {
    const eventLog = { append: vi.fn(async () => undefined) };
    const manager = await createManager({
      eventLog,
      config: {
        rolloutReadiness: {
          enabled: true,
          statusPath: "/tmp/openalice-live-gate-tests/missing-readiness.json",
        },
      },
    });

    const result = await manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      size: 0.1,
    });

    expect(result?.approved).toBe(false);
    expect(result?.reason).toContain("live_rollout_not_ready:live_rollout_readiness_missing");
    expect(eventLog.append).toHaveBeenCalledWith(
      "live_gate.rollout_readiness_blocked",
      expect.objectContaining({
        symbol: "BTC/USD",
        reason: "live_rollout_readiness_missing",
      }),
    );
  });

  it("blocks live opens when rollout readiness is not ready", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openalice-rollout-readiness-"));
    const readinessPath = join(tempDir, "live_rollout_readiness.latest.json");
    await writeLiveRolloutReadiness(
      {
        schemaVersion: "live_rollout_readiness.v1",
        generatedAt: "2026-03-28T00:00:00.000Z",
        readyForMicroLive: false,
        blockingReasons: ["rollout_execution_cost_bps_above_max"],
        warnings: [],
        evidence: {
          allowLiveTrading: true,
          championLoaded: true,
          checksumValid: true,
          policyVersionMatch: true,
          candidateId: "cand-1",
          candidateVerdict: "promote",
          executionCostBps: 40,
          edgeDecayStatus: "stable",
          executedOpenCommits: 1,
          portfolioTargetsProduced: 1,
          executorBlockingReasons: [],
        },
        sourcePaths: {},
      },
      readinessPath,
    );
    const manager = await createManager({
      config: {
        rolloutReadiness: {
          enabled: true,
          statusPath: readinessPath,
        },
      },
    });

    const result = await manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      size: 0.1,
    });

    expect(result?.approved).toBe(false);
    expect(result?.reason).toContain(
      "live_rollout_not_ready:rollout_execution_cost_bps_above_max",
    );
  });

  it("does not apply release-gate blocking to reduceOnly requests", async () => {
    mockLoadReleaseGateStatus.mockResolvedValueOnce(null);
    const eventLog = { append: vi.fn(async () => undefined) };
    const manager = await createManager({ eventLog });

    const result = await manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "sell",
      type: "market",
      size: 0.1,
      reduceOnly: true,
    });

    expect(result).toBeUndefined();
    expect(mockLoadReleaseGateStatus).not.toHaveBeenCalled();
    expect(eventLog.append).not.toHaveBeenCalled();
  });

  it("uses paper gate semantics when configured for paper mode", async () => {
    mockLoadReleaseGateStatus.mockResolvedValueOnce({
      version: 1,
      generatedAt: "2026-03-11T00:00:00.000Z",
      allowPaperTrading: true,
      allowLiveTrading: false,
      failedChecks: ["wfo"],
      warningChecks: [],
    });
    const manager = await createManager({
      config: {
        gateMode: "paper",
      },
    });

    const result = await manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      size: 0.1,
    });

    expect(result).toBeUndefined();
  });

  it("blocks paper-mode opens when paper release gate is false", async () => {
    mockLoadReleaseGateStatus.mockResolvedValueOnce({
      version: 1,
      generatedAt: "2026-03-11T00:00:00.000Z",
      allowPaperTrading: false,
      allowLiveTrading: true,
      failedChecks: ["significance"],
      warningChecks: [],
    });
    const manager = await createManager({
      config: {
        gateMode: "paper",
      },
    });

    const result = await manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      size: 0.1,
    });

    expect(result?.approved).toBe(false);
    expect(result?.reason).toContain("paper_release_gate_failed");
  });

  it("returns explicit request price before consulting market data", async () => {
    const marketContext = createMarketContext(222);
    const manager = await createManager({ marketContext });

    const expectedPrice = await manager.estimateExpectedPrice({
      symbol: "BTC/USD",
      side: "buy",
      type: "limit",
      size: 0.1,
      price: 123.45,
    });

    expect(expectedPrice).toBe(123.45);
  });

  it("uses market context close when request price is absent", async () => {
    const marketContext = createMarketContext(234.56);
    const manager = await createManager({ marketContext });

    const expectedPrice = await manager.estimateExpectedPrice({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      size: 0.1,
    });

    expect(expectedPrice).toBe(234.56);
  });

  it("records gate evaluation failure when expected-price lookup throws", async () => {
    const eventLog = { append: vi.fn(async () => undefined) };
    const marketContext = {
      ...createMarketContext(234.56),
      marketDataProvider: {
        async getMarketData() {
          throw new Error("provider unavailable");
        },
        async getMarketDataRange() {
          return [];
        },
      },
    };
    const manager = await createManager({ marketContext, eventLog });

    await expect(
      manager.estimateExpectedPrice({
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        size: 0.1,
      }),
    ).rejects.toMatchObject({
      name: "GateEvalError",
      scope: "estimate_expected_price",
    });
    expect(fakeRiskBreakerStore.recordGateEvaluationFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "estimate_expected_price",
        error: "provider unavailable",
        threshold: 3,
      }),
    );
    expect(eventLog.append).toHaveBeenCalledWith(
      "gate.eval_error",
      expect.objectContaining({
        scope: "estimate_expected_price",
        error: "provider unavailable",
      }),
    );
  });

  it("does not clear gate-failure streak on partial success before a later gate error", async () => {
    let failures = 2;
    fakeRiskBreakerStore.recordGateEvaluationSuccess.mockImplementation(async () => {
      failures = 0;
    });
    fakeRiskBreakerStore.recordGateEvaluationFailure.mockImplementation(async () => {
      failures += 1;
      return {
        opened: failures === 3,
        consecutiveFailures: failures,
        backoffMs: failures >= 3 ? 30_000 : null,
        blockedUntilMs: failures >= 3 ? Date.now() + 30_000 : null,
      };
    });
    fakeRiskBreakerStore.isGateFailureBreakerActive.mockImplementation(
      () => failures >= 3,
    );
    fakeRiskBreakerStore.getGateFailureBreakerReason.mockImplementation(() =>
      failures >= 3
        ? `gate_eval_failure scope=regime_shift failures=${failures} error=provider unavailable`
        : null,
    );

    const marketContext = {
      ...createMarketContext(234.56),
      marketDataProvider: {
        async getMarketData() {
          return {
            symbol: "BTC/USD",
            time: Date.parse("2026-03-11T12:00:00.000Z") / 1000,
            open: 234.56,
            high: 234.56,
            low: 234.56,
            close: 234.56,
            volume: 1000,
          };
        },
        async getMarketDataRange() {
          throw new Error("provider unavailable");
        },
      },
    };
    const manager = await createManager({ marketContext });

    await expect(
      manager.beforePlaceOrder({
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        size: 0.1,
      }),
    ).rejects.toMatchObject({
      name: "GateEvalError",
      scope: "regime_shift",
    });

    expect(fakeRiskBreakerStore.recordGateEvaluationSuccess).not.toHaveBeenCalled();
    expect(failures).toBe(3);

    const blocked = await manager.beforePlaceOrder({
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      size: 0.1,
    });

    expect(blocked?.approved).toBe(false);
    expect(blocked?.reason).toContain("gate_eval_failure");
  });

  it("records execution quality side effects for successful fills", async () => {
    const manager = await createManager();
    const req: CryptoPlaceOrderRequest = {
      symbol: "BTC/USD",
      side: "buy",
      type: "market",
      size: 0.2,
    };
    const result: CryptoOrderResult = {
      success: true,
      orderId: "ord-123",
      requestedSize: 0.2,
      filledSize: 0.2,
      filledPrice: 105,
      firstFillAtMs: 10,
      completedAtMs: 20,
      exchangeUpdateTs: 30,
    };

    await manager.recordExecution(req, result, 100);

    expect(fakeExecutionStore.addRecord).toHaveBeenCalledTimes(1);
    expect(fakeExecutionStore.addRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "ord-123",
        symbol: "BTC/USD",
        side: "buy",
        expectedPrice: 100,
        actualPrice: 105,
        requestedQty: 0.2,
        filledQty: 0.2,
      })
    );
  });
});
