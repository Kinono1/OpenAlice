import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CryptoAccountInfo,
  CryptoPosition,
  CryptoTicker,
  ICryptoTradingEngine,
} from "../domain/trading/operation-dispatcher.types.js";
import { createEventLog } from "../core/event-log.js";
import {
  buildPortfolioTargetFromSidecarSignal,
  runSidecarSignalPaperIntake,
  validateNormalizedSidecarSignal,
} from "./sidecar_signal.js";
import {
  PROMOTION_V2_SCHEMA_VERSION,
  buildPromotionReadinessV2,
  makeGateResult,
  type PromotionReadinessV2,
  type SchemaMeta,
} from "./promotion_v2.js";

class MockEngine implements ICryptoTradingEngine {
  constructor(
    private readonly account: CryptoAccountInfo,
    private readonly positions: CryptoPosition[],
    private readonly tickers: Record<string, CryptoTicker>,
  ) {}

  placeOrder: ICryptoTradingEngine["placeOrder"] = async () => {
    throw new Error("not implemented");
  };

  getPositions: ICryptoTradingEngine["getPositions"] = async () => {
    return this.positions;
  };

  getOrders: ICryptoTradingEngine["getOrders"] = async () => {
    return [];
  };

  getAccount: ICryptoTradingEngine["getAccount"] = async () => {
    return this.account;
  };

  cancelOrder: ICryptoTradingEngine["cancelOrder"] = async () => {
    return true;
  };

  adjustLeverage: ICryptoTradingEngine["adjustLeverage"] = async () => {
    return { success: true };
  };

  getTicker: ICryptoTradingEngine["getTicker"] = async (symbol: string) => {
    const ticker = this.tickers[symbol];
    if (!ticker) {
      throw new Error(`missing ticker for ${symbol}`);
    }
    return ticker;
  };

  getFundingRate: ICryptoTradingEngine["getFundingRate"] = async () => {
    throw new Error("not implemented");
  };

  getOrderBook: ICryptoTradingEngine["getOrderBook"] = async () => {
    throw new Error("not implemented");
  };
}

const baseSignal = {
  signal_id: "sig-1",
  source: "tradingagents" as const,
  strategy_id: "ta_graph_v1",
  symbol: "BTC/USDT",
  as_of: "2026-04-02T12:00:00.000Z",
  ttl_ms: 60_000,
  target_position_pct: 0.5,
  confidence: 0.8,
  thesis: "bullish breakout",
  trace: { sidecar: "ta" },
};

describe("sidecar signal runtime", () => {
  it("validates the normalized contract", () => {
    const signal = validateNormalizedSidecarSignal(baseSignal);
    expect(signal.signal_id).toBe("sig-1");
    expect(signal.target_position_pct).toBe(0.5);
  });

  it("builds a portfolio target from a single signal", () => {
    const target = buildPortfolioTargetFromSidecarSignal({
      signal: baseSignal,
      account: {
        balance: 1_000,
        totalMargin: 0,
        unrealizedPnL: 0,
        equity: 1_500,
        realizedPnL: 0,
        totalPnL: 0,
      },
    });

    expect(target.positions).toHaveLength(1);
    expect(target.positions[0]?.symbol).toBe("BTC/USDT");
    expect(target.positions[0]?.targetNotionalUsd).toBe(750);
  });

  it("rejects expired signals", async () => {
    const log = await createEventLog({
      logPath: "data/test/event-log.sidecar.expired.jsonl",
    });
    const engine = new MockEngine(
      {
        balance: 1_000,
        totalMargin: 0,
        unrealizedPnL: 0,
        equity: 1_000,
        realizedPnL: 0,
        totalPnL: 0,
      },
      [],
      {},
    );

    const result = await runSidecarSignalPaperIntake({
      signal: {
        ...baseSignal,
        ttl_ms: 1,
      },
      engine,
      eventLog: log,
      now: new Date("2026-04-02T12:01:00.000Z"),
    });

    expect(result.accepted).toBe(false);
    expect(result.paper_result).toBe("expired");
    expect(result.block_reason).toBe("signal_expired");
    await log._resetForTest();
    await log.close();
  });

  it("produces a paper-only rebalance result for a valid signal", async () => {
    const log = await createEventLog({
      logPath: "data/test/event-log.sidecar.valid.jsonl",
    });
    const engine = new MockEngine(
      {
        balance: 1_000,
        totalMargin: 0,
        unrealizedPnL: 0,
        equity: 1_000,
        realizedPnL: 0,
        totalPnL: 0,
      },
      [],
      {
        "BTC/USDT": {
          symbol: "BTC/USDT",
          last: 100_000,
          bid: 99_900,
          ask: 100_100,
          high: 101_000,
          low: 99_000,
          volume: 1,
          timestamp: new Date("2026-04-02T12:00:00.000Z"),
        },
      },
    );

    const result = await runSidecarSignalPaperIntake({
      signal: baseSignal,
      engine,
      eventLog: log,
      supportedSymbols: ["BTC/USDT", "ETH/USDT"],
      now: new Date("2026-04-02T12:00:30.000Z"),
      artifactPath: "data/test/sidecar_signal_intake.latest.json",
    });

    expect(result.accepted).toBe(true);
    expect(result.paper_result).toBe("executed");
    expect(result.live_result).toBe("skipped");
    expect(result.execution_plan_kind).toBe("active");
    expect(result.proposed_delta?.symbol).toBe("BTC/USDT");
    expect(result.audit_refs.received_seq).toBeTypeOf("number");
    expect(result.audit_refs.planned_seq).toBeTypeOf("number");
    await log._resetForTest();
    await log.close();
  });

  it("blocks paper intake when promotion v2 is required and the latest artifact is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sidecar-promotion-v2-missing-"));
    const log = await createEventLog({
      logPath: join(tempDir, "event-log.jsonl"),
    });
    const engine = createTickerEngine();

    const result = await runSidecarSignalPaperIntake({
      signal: baseSignal,
      engine,
      eventLog: log,
      supportedSymbols: ["BTC/USDT"],
      now: new Date("2026-04-02T12:00:30.000Z"),
      artifactPath: join(tempDir, "sidecar_signal_intake.latest.json"),
      promotionReadinessV2Path: join(tempDir, "missing_strategy_promotion.latest.json"),
      requirePromotionV2: true,
    });

    expect(result.accepted).toBe(true);
    expect(result.paper_result).toBe("rejected");
    expect(result.block_reason).toBe("promotion_v2_readiness_missing");
    const artifact = JSON.parse(
      await readFile(join(tempDir, "sidecar_signal_intake.latest.json"), "utf-8"),
    ) as { promotionV2: { loadStatus: string } };
    expect(artifact.promotionV2.loadStatus).toBe("missing");
    await log._resetForTest();
    await log.close();
  });

  it("loads promotion v2 readiness from disk before allowing paper intake", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sidecar-promotion-v2-loaded-"));
    const readinessPath = join(tempDir, "strategy_promotion.latest.json");
    await writeFile(
      readinessPath,
      `${JSON.stringify(createPromotionReadiness(), null, 2)}\n`,
      "utf-8",
    );
    const log = await createEventLog({
      logPath: join(tempDir, "event-log.jsonl"),
    });
    const engine = createTickerEngine();

    const result = await runSidecarSignalPaperIntake({
      signal: baseSignal,
      engine,
      eventLog: log,
      supportedSymbols: ["BTC/USDT"],
      now: new Date("2026-04-02T12:00:30.000Z"),
      artifactPath: join(tempDir, "sidecar_signal_intake.latest.json"),
      promotionReadinessV2Path: readinessPath,
      requirePromotionV2: true,
      validatePromotionV2Artifacts: false,
    });

    expect(result.accepted).toBe(true);
    expect(result.paper_result).toBe("executed");
    expect(result.execution_plan_kind).toBe("active");
    const artifact = JSON.parse(
      await readFile(join(tempDir, "sidecar_signal_intake.latest.json"), "utf-8"),
    ) as { promotionV2: { loadStatus: string } };
    expect(artifact.promotionV2.loadStatus).toBe("loaded");
    await log._resetForTest();
    await log.close();
  });
});

function createTickerEngine(): ICryptoTradingEngine {
  return new MockEngine(
    {
      balance: 1_000,
      totalMargin: 0,
      unrealizedPnL: 0,
      equity: 1_000,
      realizedPnL: 0,
      totalPnL: 0,
    },
    [],
    {
      "BTC/USDT": {
        symbol: "BTC/USDT",
        last: 100_000,
        bid: 99_900,
        ask: 100_100,
        high: 101_000,
        low: 99_000,
        volume: 1,
        timestamp: new Date("2026-04-02T12:00:00.000Z"),
      },
    },
  );
}

function createPromotionReadiness(): PromotionReadinessV2 {
  const generatedAt = "2026-04-02T12:00:00.000Z";
  const expiresAt = "2026-04-02T13:00:00.000Z";
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
    liveGate: makeGateResult({
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
