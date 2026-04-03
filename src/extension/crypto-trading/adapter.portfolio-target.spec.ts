import { describe, expect, it, vi } from "vitest";
import { createCryptoTradingTools } from "./adapter.js";
import type {
  CryptoAccountInfo,
  CryptoPosition,
  CryptoTicker,
  ICryptoTradingEngine,
} from "./interfaces.js";
import type { IWallet } from "./wallet/interfaces.js";
import type {
  AddResult,
  CommitLogEntry,
  CommitPrepareResult,
  CommitHash,
  OrderStatusUpdate,
  PriceChangeInput,
  PushResult,
  SimulatePriceChangeResult,
  SyncResult,
  WalletCommit,
  WalletExportState,
  WalletState,
  WalletStatus,
} from "./wallet/types.js";

describe("crypto adapter portfolio target staging", () => {
  it("turns a portfolio target into staged wallet operations", async () => {
    const add = vi.fn((operation) => ({
      staged: true,
      index: 0,
      operation,
    }));

    const wallet: IWallet = {
      add,
      commit: vi.fn() as unknown as (message: string) => CommitPrepareResult,
      push: vi.fn() as unknown as () => Promise<PushResult>,
      log: vi.fn() as unknown as (options?: { limit?: number; symbol?: string }) => CommitLogEntry[],
      show: vi.fn() as unknown as (hash: CommitHash) => WalletCommit | null,
      status: vi.fn() as unknown as () => WalletStatus,
      sync: vi.fn() as unknown as (
        updates: OrderStatusUpdate[],
        currentState: WalletState
      ) => Promise<SyncResult>,
      getPendingOrderIds: vi.fn() as unknown as () => Array<{ orderId: string; symbol: string }>,
      exportState: vi.fn() as unknown as () => WalletExportState,
      setCurrentRound: vi.fn(),
      simulatePriceChange: vi.fn() as unknown as (
        priceChanges: PriceChangeInput[]
      ) => Promise<SimulatePriceChangeResult>,
    };

    const tradingEngine = createMockEngine({
      getAccount: vi.fn().mockResolvedValue({
        balance: 1_000,
        totalMargin: 0,
        unrealizedPnL: 0,
        equity: 1_000,
        realizedPnL: 0,
        totalPnL: 0,
      } satisfies CryptoAccountInfo),
      getPositions: vi.fn().mockResolvedValue([
        {
          symbol: "BTC/USD",
          side: "long",
          size: 2,
          entryPrice: 190,
          leverage: 1,
          margin: 400,
          liquidationPrice: 100,
          markPrice: 200,
          unrealizedPnL: 20,
          positionValue: 400,
        } satisfies CryptoPosition,
      ]),
      getTicker: vi.fn().mockImplementation(async (symbol: string) => ({
        symbol,
        last: symbol === "ETH/USD" ? 100 : 200,
        bid: symbol === "ETH/USD" ? 99 : 199,
        ask: symbol === "ETH/USD" ? 101 : 201,
        high: symbol === "ETH/USD" ? 105 : 205,
        low: symbol === "ETH/USD" ? 95 : 195,
        volume: 1_000,
        timestamp: new Date(),
      } satisfies CryptoTicker)),
    });

    const tools = createCryptoTradingTools(tradingEngine, wallet);
    const result = await (tools.cryptoStagePortfolioTarget as any).execute({
      positions: [
        { symbol: "BTC/USD", targetWeight: 0.2, sizingReason: "reduce winner" },
        { symbol: "ETH/USD", targetWeight: 0.3, sizingReason: "new challenger" },
      ],
      maxTurnoverPct: 1,
      minTradeNotionalUsd: 10,
    });

    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[0][0]).toEqual({
      action: "closePosition",
      params: {
        symbol: "BTC/USD",
        size: 1,
      },
    });
    expect(add.mock.calls[1][0]).toEqual({
      action: "placeOrder",
      params: {
        symbol: "ETH/USD",
        side: "buy",
        type: "market",
        usd_size: 300,
      },
    });
    expect(result.stagedCount).toBe(2);
    expect(result.target.basisEquityUsd).toBe(1_000);
    expect(result.plan.entries).toHaveLength(2);
  });
});

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
