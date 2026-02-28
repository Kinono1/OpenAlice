import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CryptoAccountInfo,
  CryptoOrder,
  CryptoPlaceOrderRequest,
  CryptoPosition,
  ICryptoTradingEngine,
} from "./interfaces.js";
import { DecisionTicketStore } from "./decision-ticket.js";
import type {
  IntentLedger,
  IntentResult,
  TradeIntent,
} from "./intent-ledger.js";
import { TradeIdempotencyStore } from "./idempotency-store.js";
import { KillSwitch } from "./kill-switch.js";
import { createCryptoOperationDispatcher } from "./operation-dispatcher.js";

class MockEngine implements ICryptoTradingEngine {
  constructor(
    private readonly account: CryptoAccountInfo,
    private readonly positions: CryptoPosition[] = []
  ) {}

  async placeOrder(_order: CryptoPlaceOrderRequest) {
    return {
      success: true,
      orderId: "order-1",
      filledPrice: 101,
      filledSize: 1,
    };
  }

  async getPositions(): Promise<CryptoPosition[]> {
    return this.positions;
  }

  async getOrders(): Promise<CryptoOrder[]> {
    return [];
  }

  async getAccount(): Promise<CryptoAccountInfo> {
    return this.account;
  }

  async cancelOrder(_orderId: string): Promise<boolean> {
    return true;
  }

  async adjustLeverage(_symbol: string, _newLeverage: number) {
    return { success: true };
  }
}

const healthyAccount: CryptoAccountInfo = {
  balance: 10_000,
  totalMargin: 0,
  unrealizedPnL: 0,
  equity: 10_000,
  realizedPnL: 0,
  totalPnL: 0,
  realizedPnlSource: "balance_payload",
  realizedPnlConfidence: 0.95,
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("operation-dispatcher", () => {
  it("supports legacy risk-config argument and dispatches successful order", async () => {
    const engine = new MockEngine(healthyAccount);
    const { dispatch } = createCryptoOperationDispatcher(engine, {
      enabled: true,
      killSwitch: false,
      maxOpenPositions: 5,
      maxLeverage: 5,
      maxOrderUsd: 10_000,
      maxPositionPctOfEquity: 50,
      maxDailyLossUsd: 5_000,
    });

    const result = (await dispatch({
      action: "placeOrder",
      params: {
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 1000,
      },
    })) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.order).toMatchObject({
      id: "order-1",
      status: "filled",
      filledPrice: 101,
    });
  });

  it("applies dynamic risk context from getRiskContext", async () => {
    const engine = new MockEngine(healthyAccount);
    const { dispatch } = createCryptoOperationDispatcher(engine, {
      riskConfig: {
        enabled: true,
        killSwitch: false,
        maxOpenPositions: 5,
        maxLeverage: 5,
        maxOrderUsd: 10_000,
        maxPositionPctOfEquity: 50,
        maxDailyLossUsd: 5_000,
        dailyLossPctSoftCap: -5,
      },
      getRiskContext: async () => ({ dailyLossPct: -6 }),
    });

    const result = (await dispatch({
      action: "placeOrder",
      params: {
        symbol: "ETH/USD",
        side: "buy",
        type: "market",
        usd_size: 1000,
      },
    })) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("dailyLossPctSoftCap");
  });

  it("runs before/after hooks and blocks when pre-hook rejects", async () => {
    const engine = new MockEngine(healthyAccount);
    const afterHook = vi.fn();
    const { dispatch } = createCryptoOperationDispatcher(engine, {
      riskConfig: {
        enabled: true,
        killSwitch: false,
        maxOpenPositions: 5,
        maxLeverage: 5,
        maxOrderUsd: 10_000,
        maxPositionPctOfEquity: 50,
        maxDailyLossUsd: 5_000,
      },
      beforePlaceOrderGate: async () => ({
        approved: false,
        reason: "manual block",
      }),
      afterPlaceOrder: afterHook,
    });

    const blocked = (await dispatch({
      action: "placeOrder",
      params: {
        symbol: "SOL/USD",
        side: "buy",
        type: "market",
        usd_size: 500,
      },
    })) as Record<string, unknown>;

    expect(blocked.success).toBe(false);
    expect(afterHook).not.toHaveBeenCalled();
  });

  it("calls afterPlaceOrder hook for successful order", async () => {
    const engine = new MockEngine(healthyAccount);
    const afterHook = vi.fn();
    const { dispatch } = createCryptoOperationDispatcher(engine, {
      riskConfig: {
        enabled: true,
        killSwitch: false,
        maxOpenPositions: 5,
        maxLeverage: 5,
        maxOrderUsd: 10_000,
        maxPositionPctOfEquity: 50,
        maxDailyLossUsd: 5_000,
      },
      estimateExpectedPrice: async () => 100,
      afterPlaceOrder: afterHook,
    });

    await dispatch({
      action: "placeOrder",
      params: {
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 500,
      },
    });

    expect(afterHook).toHaveBeenCalledTimes(1);
    const [arg] = afterHook.mock.calls[0];
    expect(arg.expectedPrice).toBe(100);
    expect(arg.result.success).toBe(true);
  });

  it("does not block placeOrder when ticket store exists but ticketId is missing", async () => {
    const engine = new MockEngine(healthyAccount);
    const ticketStore = new DecisionTicketStore({ required: true });
    const { dispatch } = createCryptoOperationDispatcher(engine, {
      ticketStore,
    });

    const result = (await dispatch({
      action: "placeOrder",
      params: {
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 500,
      },
    })) as Record<string, unknown>;

    expect(result.success).toBe(true);
  });

  it("still rejects invalid ticketId when ticketId is provided", async () => {
    const engine = new MockEngine(healthyAccount);
    const ticketStore = new DecisionTicketStore({ required: true });
    const { dispatch } = createCryptoOperationDispatcher(engine, {
      ticketStore,
    });

    const result = (await dispatch({
      action: "placeOrder",
      params: {
        ticketId: "non-existent-ticket",
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 500,
      },
    })) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("ticket:");
  });

  it("records kill-switch rejections as failed intent results", async () => {
    const engine = new MockEngine(healthyAccount);
    const killSwitch = new KillSwitch({ defaultPolicy: "block_new_only" });
    killSwitch.activate("BTC/USD", "manual-stop", "block_new_only");

    const intents: TradeIntent[] = [];
    const results: IntentResult[] = [];
    const intentLedger = {
      recordIntent: async (intent: TradeIntent) => {
        intents.push(intent);
      },
      recordResult: async (result: IntentResult) => {
        results.push(result);
      },
    } as unknown as IntentLedger;

    const { dispatch } = createCryptoOperationDispatcher(engine, {
      killSwitch,
      intentLedger,
    });

    const blocked = (await dispatch({
      action: "placeOrder",
      params: {
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 500,
      },
    })) as Record<string, unknown>;

    expect(blocked.success).toBe(false);
    expect(String(blocked.error)).toContain("kill-switch");
    expect(intents).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].intentId).toBe(intents[0].intentId);
    expect(results[0].status).toBe("failed");
  });

  it("serializes risk-check + placeOrder to prevent concurrent limit bypass", async () => {
    const positions: CryptoPosition[] = [];
    const raceEngine: ICryptoTradingEngine = {
      async placeOrder(order: CryptoPlaceOrderRequest) {
        await sleep(30);
        if (!order.reduceOnly) {
          const markPrice = 100;
          const size =
            typeof order.size === "number" && order.size > 0
              ? order.size
              : typeof order.usd_size === "number" && order.usd_size > 0
                ? order.usd_size / markPrice
                : 1;
          positions.push({
            symbol: order.symbol,
            side: order.side === "buy" ? "long" : "short",
            size,
            entryPrice: markPrice,
            leverage: order.leverage ?? 1,
            margin: 0,
            liquidationPrice: 0,
            markPrice,
            unrealizedPnL: 0,
            positionValue: size * markPrice,
          });
        }
        return {
          success: true,
          orderId: `order-${positions.length}-${Date.now()}`,
          filledPrice: 100,
          filledSize:
            typeof order.size === "number" && order.size > 0 ? order.size : 1,
        };
      },
      async getPositions(): Promise<CryptoPosition[]> {
        return positions.map(p => ({ ...p }));
      },
      async getOrders(): Promise<CryptoOrder[]> {
        return [];
      },
      async getAccount(): Promise<CryptoAccountInfo> {
        return healthyAccount;
      },
      async cancelOrder(_orderId: string): Promise<boolean> {
        return true;
      },
      async adjustLeverage(_symbol: string, _newLeverage: number) {
        return { success: true };
      },
    };

    const { dispatch } = createCryptoOperationDispatcher(raceEngine, {
      riskConfig: {
        enabled: true,
        killSwitch: false,
        maxOpenPositions: 1,
        maxLeverage: 5,
        maxOrderUsd: 10_000,
        maxPositionPctOfEquity: 50,
        maxDailyLossUsd: 5_000,
      },
    });

    const [resA, resB] = await Promise.all([
      dispatch({
        action: "placeOrder",
        params: {
          symbol: "BTC/USD",
          side: "buy",
          type: "market",
          usd_size: 500,
        },
      }),
      dispatch({
        action: "placeOrder",
        params: {
          symbol: "ETH/USD",
          side: "buy",
          type: "market",
          usd_size: 500,
        },
      }),
    ]);

    const outcomes = [resA, resB] as Array<Record<string, unknown>>;
    const successCount = outcomes.filter(
      result => result.success === true
    ).length;
    const failed = outcomes.find(result => result.success === false);

    expect(successCount).toBe(1);
    expect(failed).toBeDefined();
    expect(String(failed?.error)).toContain("maxOpenPositions");
  });

  it("blocks duplicate placeOrder across dispatcher instances using persistent idempotency store", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "crypto-idempotency-"));
    const storePath = join(tempDir, "idempotency.json");
    const idempotencyStoreA = new TradeIdempotencyStore(storePath, 60_000);
    const idempotencyStoreB = new TradeIdempotencyStore(storePath, 60_000);
    let orderCalls = 0;

    const engine: ICryptoTradingEngine = {
      async placeOrder(_order: CryptoPlaceOrderRequest) {
        orderCalls++;
        return {
          success: true,
          orderId: `order-${orderCalls}`,
          filledPrice: 100,
          filledSize: 1,
        };
      },
      async getPositions(): Promise<CryptoPosition[]> {
        return [];
      },
      async getOrders(): Promise<CryptoOrder[]> {
        return [];
      },
      async getAccount(): Promise<CryptoAccountInfo> {
        return healthyAccount;
      },
      async cancelOrder(_orderId: string): Promise<boolean> {
        return true;
      },
      async adjustLeverage(_symbol: string, _newLeverage: number) {
        return { success: true };
      },
    };

    const first = createCryptoOperationDispatcher(engine, {
      idempotencyStore: idempotencyStoreA,
    });
    const second = createCryptoOperationDispatcher(engine, {
      idempotencyStore: idempotencyStoreB,
    });

    const resultA = (await first.dispatch({
      action: "placeOrder",
      params: {
        ticketId: "ticket-fixed-123",
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 100,
      },
    })) as Record<string, unknown>;

    const resultB = (await second.dispatch({
      action: "placeOrder",
      params: {
        ticketId: "ticket-fixed-123",
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 100,
      },
    })) as Record<string, unknown>;

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(false);
    expect(String(resultB.error)).toContain("duplicate key");
    expect(orderCalls).toBe(1);
  });

  it("allows explicit retry of failed idempotency key when forceRetryIdempotency is set", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "crypto-idempotency-retry-"));
    const storePath = join(tempDir, "idempotency.json");
    const idempotencyStore = new TradeIdempotencyStore(storePath, 60_000);
    let calls = 0;

    const engine: ICryptoTradingEngine = {
      async placeOrder() {
        calls++;
        if (calls === 1) {
          return {
            success: false,
            error: "transient exchange timeout",
          };
        }
        return {
          success: true,
          orderId: `order-${calls}`,
          filledPrice: 100,
          filledSize: 1,
        };
      },
      async getPositions(): Promise<CryptoPosition[]> {
        return [];
      },
      async getOrders(): Promise<CryptoOrder[]> {
        return [];
      },
      async getAccount(): Promise<CryptoAccountInfo> {
        return healthyAccount;
      },
      async cancelOrder(_orderId: string): Promise<boolean> {
        return true;
      },
      async adjustLeverage(_symbol: string, _newLeverage: number) {
        return { success: true };
      },
    };

    const { dispatch } = createCryptoOperationDispatcher(engine, {
      idempotencyStore,
    });

    const first = (await dispatch({
      action: "placeOrder",
      params: {
        ticketId: "ticket-retry-001",
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 200,
      },
    })) as Record<string, unknown>;

    const duplicate = (await dispatch({
      action: "placeOrder",
      params: {
        ticketId: "ticket-retry-001",
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 200,
      },
    })) as Record<string, unknown>;

    const retried = (await dispatch({
      action: "placeOrder",
      params: {
        ticketId: "ticket-retry-001",
        forceRetryIdempotency: true,
        retryReason: "operator-approved transient failure retry",
        retryApprovedBy: "ops-user",
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 200,
      },
    })) as Record<string, unknown>;

    expect(first.success).toBe(false);
    expect(String(first.error)).toContain("transient exchange timeout");
    expect(duplicate.success).toBe(false);
    expect(String(duplicate.error)).toContain("duplicate key");
    expect(retried.success).toBe(true);
    expect(calls).toBe(2);
  });

  it("rejects forceRetryIdempotency when retryReason is missing", async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), "crypto-idempotency-retry-reason-")
    );
    const storePath = join(tempDir, "idempotency.json");
    const idempotencyStore = new TradeIdempotencyStore(storePath, 60_000);
    let calls = 0;

    const engine: ICryptoTradingEngine = {
      async placeOrder() {
        calls++;
        if (calls === 1) {
          return {
            success: false,
            error: "transient exchange timeout",
          };
        }
        return {
          success: true,
          orderId: `order-${calls}`,
          filledPrice: 100,
          filledSize: 1,
        };
      },
      async getPositions(): Promise<CryptoPosition[]> {
        return [];
      },
      async getOrders(): Promise<CryptoOrder[]> {
        return [];
      },
      async getAccount(): Promise<CryptoAccountInfo> {
        return healthyAccount;
      },
      async cancelOrder(_orderId: string): Promise<boolean> {
        return true;
      },
      async adjustLeverage(_symbol: string, _newLeverage: number) {
        return { success: true };
      },
    };

    const { dispatch } = createCryptoOperationDispatcher(engine, {
      idempotencyStore,
    });

    const first = (await dispatch({
      action: "placeOrder",
      params: {
        ticketId: "ticket-retry-reason-001",
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 200,
      },
    })) as Record<string, unknown>;

    const retriedWithoutReason = (await dispatch({
      action: "placeOrder",
      params: {
        ticketId: "ticket-retry-reason-001",
        forceRetryIdempotency: true,
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 200,
      },
    })) as Record<string, unknown>;

    expect(first.success).toBe(false);
    expect(retriedWithoutReason.success).toBe(false);
    expect(String(retriedWithoutReason.error)).toContain("retryReason");
    expect(calls).toBe(1);
  });

  it("requires retryApprovalTicketId when ticketStore is enabled", async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), "crypto-idempotency-retry-ticket-")
    );
    const storePath = join(tempDir, "idempotency.json");
    const idempotencyStore = new TradeIdempotencyStore(storePath, 60_000);
    const ticketStore = new DecisionTicketStore({ required: true });
    let calls = 0;

    const engine: ICryptoTradingEngine = {
      async placeOrder() {
        calls++;
        if (calls === 1) {
          return {
            success: false,
            error: "transient exchange timeout",
          };
        }
        return {
          success: true,
          orderId: `order-${calls}`,
          filledPrice: 100,
          filledSize: 1,
        };
      },
      async getPositions(): Promise<CryptoPosition[]> {
        return [];
      },
      async getOrders(): Promise<CryptoOrder[]> {
        return [];
      },
      async getAccount(): Promise<CryptoAccountInfo> {
        return healthyAccount;
      },
      async cancelOrder(_orderId: string): Promise<boolean> {
        return true;
      },
      async adjustLeverage(_symbol: string, _newLeverage: number) {
        return { success: true };
      },
    };

    const { dispatch } = createCryptoOperationDispatcher(engine, {
      idempotencyStore,
      ticketStore,
    });
    const retryKey = "idemp-retry-ticket-001";

    const first = (await dispatch({
      action: "placeOrder",
      params: {
        idempotencyKey: retryKey,
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 200,
      },
    })) as Record<string, unknown>;

    const retriedMissingApprovalTicket = (await dispatch({
      action: "placeOrder",
      params: {
        idempotencyKey: retryKey,
        forceRetryIdempotency: true,
        retryReason: "manual override",
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 200,
      },
    })) as Record<string, unknown>;

    const invalidRetryTicket = (await dispatch({
      action: "placeOrder",
      params: {
        idempotencyKey: retryKey,
        forceRetryIdempotency: true,
        retryReason: "manual override",
        retryApprovalTicketId: "not-exist-ticket",
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 200,
      },
    })) as Record<string, unknown>;

    const retryTicket = ticketStore.issue({
      symbol: "BTC/USD",
      action: "placeOrder",
    });
    const validRetry = (await dispatch({
      action: "placeOrder",
      params: {
        idempotencyKey: retryKey,
        forceRetryIdempotency: true,
        retryReason: "manual override",
        retryApprovalTicketId: retryTicket.ticketId,
        retryApprovedBy: "risk-oncall",
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 200,
      },
    })) as Record<string, unknown>;

    expect(first.success).toBe(false);
    expect(retriedMissingApprovalTicket.success).toBe(false);
    expect(String(retriedMissingApprovalTicket.error)).toContain(
      "retryApprovalTicketId"
    );
    expect(invalidRetryTicket.success).toBe(false);
    expect(String(invalidRetryTicket.error)).toContain(
      "retry approval ticket invalid"
    );
    expect(validRetry.success).toBe(true);
    expect(calls).toBe(2);
  });
});
