import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveGuards } from "./registry.js";
import { createGuardPipeline } from "./guard-pipeline.js";
import { createCryptoOperationDispatcher } from "../operation-dispatcher.js";
import type { ICryptoTradingEngine } from "../interfaces.js";
import type { Operation } from "../wallet/types.js";

function createMockEngine(): ICryptoTradingEngine {
  return {
    placeOrder: vi.fn().mockResolvedValue({
      success: true,
      orderId: "ord-guard-001",
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
      realizedPnlSource: "balance_payload",
      realizedPnlConfidence: 0.95,
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
  };
}

describe("resolveGuards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips deprecated numeric risk guards with a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const guards = resolveGuards([
      { type: "max-position-size", options: { maxPercentOfEquity: 10 } },
      { type: "max-leverage", options: { maxLeverage: 2 } },
      { type: "cooldown", options: { minIntervalMs: 1_000 } },
    ]);

    expect(guards).toHaveLength(1);
    expect(guards[0]?.name).toBe("cooldown");
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('"max-position-size"');
    expect(warnSpy.mock.calls[1]?.[0]).toContain('"max-leverage"');
  });

  it("keeps numeric execution limits in riskConfig even when deprecated guards are present", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = createMockEngine();
    const rawDispatcher = createCryptoOperationDispatcher(engine, {
      riskConfig: {
        enabled: true,
        killSwitch: false,
        maxOpenPositions: 5,
        maxLeverage: 2,
        maxOrderUsd: 5_000,
        maxPositionPctOfEquity: 50,
        maxDailyLossUsd: 1_000,
        enforceRealizedPnlConfidence: true,
        minRealizedPnlConfidence: 0.7,
        trustedRealizedPnlSources: ["balance_payload", "closed_trades_ledger"],
      },
    } as any);
    const guards = resolveGuards([
      { type: "max-leverage", options: { maxLeverage: 1 } },
    ]);
    const pipeline = createGuardPipeline(rawDispatcher, engine, guards);

    const allowedResult = await pipeline({
      action: "placeOrder",
      params: {
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 1_000,
        leverage: 1.5,
      },
    } as Operation);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"max-leverage" is deprecated')
    );
    expect((allowedResult as any).success).toBe(true);

    const blockedResult = await pipeline({
      action: "placeOrder",
      params: {
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 1_000,
        leverage: 3,
      },
    } as Operation);

    expect((blockedResult as any).success).toBe(false);
    expect((blockedResult as any).error).toContain("maxLeverage 2x");
  });
});
