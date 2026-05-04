import { describe, expect, it } from "vitest";
import type {
  CryptoAccountInfo,
  CryptoFundingRate,
  CryptoOrderBook,
  CryptoOrderResult,
  CryptoPosition,
  CryptoTicker,
  ICryptoTradingEngine,
} from "../extension/crypto-trading/interfaces.js";
import { createEventLog } from "../core/event-log.js";
import {
  buildPortfolioTargetFromSidecarSignal,
  runSidecarSignalPaperIntake,
  validateNormalizedSidecarSignal,
} from "./sidecar_signal.js";

class MockEngine implements ICryptoTradingEngine {
  constructor(
    private readonly account: CryptoAccountInfo,
    private readonly positions: CryptoPosition[],
    private readonly tickers: Record<string, CryptoTicker>,
  ) {}

  async placeOrder(): Promise<CryptoOrderResult> {
    throw new Error("not implemented");
  }
  async getPositions() {
    return this.positions;
  }
  async getOrders() {
    return [];
  }
  async getAccount() {
    return this.account;
  }
  async cancelOrder() {
    return true;
  }
  async adjustLeverage() {
    return { success: true };
  }
  async getTicker(symbol: string) {
    const ticker = this.tickers[symbol];
    if (!ticker) {
      throw new Error(`missing ticker for ${symbol}`);
    }
    return ticker;
  }
  async getFundingRate(symbol: string): Promise<CryptoFundingRate> {
    throw new Error("not implemented");
  }
  async getOrderBook(symbol: string): Promise<CryptoOrderBook> {
    throw new Error("not implemented");
  }
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
});
