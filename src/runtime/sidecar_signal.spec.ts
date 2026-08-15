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
  validateSidecarEnvelope,
  computeCurrentSlotId,
  cryptoDlSidecarEnvelopeV1Schema,
  cryptoDlSignalV1Schema,
  signalHealthV1Schema,
  executionTopOfBookEvidenceV1Schema,
} from "./sidecar_signal.js";
import {
  PROMOTION_V2_SCHEMA_VERSION,
  buildPromotionReadinessV2,
  makeGateResult,
  type PromotionReadinessV2,
  type SchemaMeta,
} from "./promotion_v2.js";
import { pctToBps, floatToBps, awayFromZeroRounding } from "../domain/trading/risk.js";

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

// ── V5 plan tests ─────────────────────────────────────────────────

describe("v5 plan - envelope-level validation", () => {
  it("rejects bare array (returns valid=false from validateSidecarEnvelope)", () => {
    const result = validateSidecarEnvelope([{ symbol: "XRP/USDT", position_pct: 0.1 }])
    expect(result.valid).toBe(false)
  })

  it("rejects expired TTL", () => {
    const old = new Date(Date.now() - 86400000).toISOString() // 1 day ago
    const envelope = {
      schema_version: 1,
      slot_id: computeCurrentSlotId(new Date()),
      run_id: "test",
      generated_at: old,
      ttl_ms: 100, // 100ms — well past 1 day
      signals: [],
      producer: "test",
    }
    const result = validateSidecarEnvelope(envelope)
    expect(result.valid).toBe(false)
    expect(result.reason?.toLowerCase()).toContain("ttl")
  })

  it("rejects old slot_id", () => {
    const now = new Date()
    const envelope = {
      schema_version: 1,
      slot_id: "slot-20200101-00",
      run_id: "old",
      generated_at: now.toISOString(),
      ttl_ms: 3600000,
      signals: [{
        source: "cryptotrade" as const,
        strategy_id: "crypto_dl",
        symbol: "XRP/USDT",
        as_of: now.toISOString(),
        target_position_bps: 200,
        confidence_bps: 8000,
        model_id: "v1",
        thesis: "test",
        label_horizon_bars: 1,
        bar_interval_ms: 3600000,
        target_start_delay_bars: 1,
        target_start_at: now.toISOString(),
        target_end_at: new Date(now.getTime() + 86400000).toISOString(),
      }],
      producer: "test",
    }
    const result = validateSidecarEnvelope(envelope)
    expect(result.valid).toBe(false)
    expect(result.reason?.toLowerCase()).toContain("slot")
  })

  it("accepts valid envelope", () => {
    const now = new Date()
    const envelope = {
      schema_version: 1,
      slot_id: computeCurrentSlotId(now),
      run_id: "test",
      generated_at: now.toISOString(),
      ttl_ms: 3600000,
      signals: [{
        source: "cryptotrade" as const,
        strategy_id: "crypto_dl",
        symbol: "XRP/USDT",
        as_of: now.toISOString(),
        target_position_bps: 200,
        confidence_bps: 8000,
        model_id: "v1",
        thesis: "test signal",
        label_horizon_bars: 6,
        bar_interval_ms: 3600000,
        target_start_delay_bars: 1,
        target_start_at: now.toISOString(),
        target_end_at: new Date(now.getTime() + 86400000).toISOString(),
      }],
      producer: "test",
    }
    const result = validateSidecarEnvelope(envelope)
    expect(result.valid).toBe(true)
  })
})

describe("v5 plan - signal schema validation", () => {
  it("rejects missing source", () => {
    const bad = {
      strategy_id: "crypto_dl",
      symbol: "XRP/USDT",
      as_of: new Date().toISOString(),
      target_position_bps: 200,
      confidence_bps: 8000,
      model_id: "v1",
      thesis: "test",
      label_horizon_bars: 6,
      bar_interval_ms: 3600000,
      target_start_delay_bars: 1,
      target_start_at: new Date().toISOString(),
      target_end_at: new Date(Date.now() + 86400000).toISOString(),
    }
    expect(() => cryptoDlSignalV1Schema.parse(bad)).toThrow()
  })

  it("rejects missing target_position_bps", () => {
    const bad = {
      source: "cryptotrade" as const,
      strategy_id: "crypto_dl",
      symbol: "XRP/USDT",
      as_of: new Date().toISOString(),
      confidence_bps: 8000,
      model_id: "v1",
      thesis: "test",
      label_horizon_bars: 6,
      bar_interval_ms: 3600000,
      target_start_delay_bars: 1,
      target_start_at: new Date().toISOString(),
      target_end_at: new Date(Date.now() + 86400000).toISOString(),
    }
    expect(() => cryptoDlSignalV1Schema.parse(bad)).toThrow()
  })

  it("rejects missing horizon metadata", () => {
    const bad = {
      source: "cryptotrade" as const,
      strategy_id: "crypto_dl",
      symbol: "XRP/USDT",
      as_of: new Date().toISOString(),
      target_position_bps: 200,
      confidence_bps: 8000,
      model_id: "v1",
      thesis: "test",
      target_start_delay_bars: 1,
      target_start_at: new Date().toISOString(),
      target_end_at: new Date(Date.now() + 86400000).toISOString(),
    }
    expect(() => cryptoDlSignalV1Schema.parse(bad)).toThrow()
  })

  it("rejects wrong source value", () => {
    const bad = {
      source: "tradingagents",
      strategy_id: "crypto_dl",
      symbol: "XRP/USDT",
      as_of: new Date().toISOString(),
      target_position_bps: 200,
      confidence_bps: 8000,
      model_id: "v1",
      thesis: "test",
      label_horizon_bars: 6,
      bar_interval_ms: 3600000,
      target_start_delay_bars: 1,
      target_start_at: new Date().toISOString(),
      target_end_at: new Date(Date.now() + 86400000).toISOString(),
    }
    expect(() => cryptoDlSignalV1Schema.parse(bad)).toThrow()
  })
})

describe("v5 plan - sidecar status schema", () => {
  it("accepts ready: false as valid status", async () => {
    const { cryptoDlSidecarStatusV1Schema } = await import("./sidecar_signal.js")
    const status = {
      status: "running",
      slot_id: "slot-20260511-00",
      run_id: "test-run",
      started_at: new Date().toISOString(),
      finished_at: null,
      ready: false,
      signals_count: 0,
    }
    const parsed = cryptoDlSidecarStatusV1Schema.parse(status)
    expect(parsed.ready).toBe(false)
  })
})

describe("v5 plan - computeCurrentSlotId", () => {
  it("returns expected format", () => {
    const slot = computeCurrentSlotId(new Date("2026-05-11T10:30:00Z"))
    expect(slot).toMatch(/^slot-\d{8}-0[48]$/)
  })

  it("returns correct slot for hour 0-3", () => {
    const slot = computeCurrentSlotId(new Date("2026-05-11T01:30:00Z"))
    expect(slot).toBe("slot-20260511-00")
  })

  it("returns correct slot for hour 4-7", () => {
    const slot = computeCurrentSlotId(new Date("2026-05-11T05:30:00Z"))
    expect(slot).toBe("slot-20260511-04")
  })

  it("returns correct slot for hour 8-11", () => {
    const slot = computeCurrentSlotId(new Date("2026-05-11T10:30:00Z"))
    expect(slot).toBe("slot-20260511-08")
  })

  it("returns correct slot for hour 20-23", () => {
    const slot = computeCurrentSlotId(new Date("2026-05-11T22:30:00Z"))
    expect(slot).toBe("slot-20260511-20")
  })
})

describe("v5 plan - integer precision boundaries", () => {
  it("pctToBps converts correctly", () => {
    expect(pctToBps(50)).toBe(5000)
    expect(pctToBps(100)).toBe(10000)
    expect(pctToBps(0.02)).toBe(2) // 0.02% = 2 bps
  })

  it("floatToBps converts correctly", () => {
    expect(floatToBps(0.5)).toBe(5000)   // 0.50 = 50% = 5000 bps
    expect(floatToBps(1.0)).toBe(10000)  // 1.0 = 100% = 10000 bps
    expect(floatToBps(0.02)).toBe(200)   // 0.02 = 2% = 200 bps
  })

  it("awayFromZeroRounding works", () => {
    expect(awayFromZeroRounding(9999.999999)).toBe(10000)
    expect(awayFromZeroRounding(10000.000001)).toBe(10000)
  })
})
