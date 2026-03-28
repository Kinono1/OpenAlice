import { afterEach, describe, expect, it, vi } from "vitest";
import { CcxtTradingEngine, type CcxtEngineConfig } from "./CcxtTradingEngine.js";

const BASE_CONFIG: CcxtEngineConfig = {
  exchange: "binance",
  apiKey: "k",
  apiSecret: "s",
  sandbox: true,
  defaultMarketType: "swap",
  allowedSymbols: ["BTC-USD-SWAP"],
};

describe("CcxtTradingEngine.getAccount", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps OKX test urls to demo urls before enabling demo trading", () => {
    const engine = new CcxtTradingEngine({
      exchange: "okx",
      apiKey: "k",
      apiSecret: "s",
      password: "p",
      sandbox: false,
      demoTrading: true,
      defaultMarketType: "swap",
    });

    const exchange = engine as unknown as {
      exchange: {
        urls: {
          api: { rest: string };
          demo?: { rest: string };
          test?: { rest: string };
        };
      };
    };

    expect(exchange.exchange.urls.test?.rest).toBeDefined();
    expect(exchange.exchange.urls.demo?.rest).toBe(
      exchange.exchange.urls.test?.rest
    );
    expect(exchange.exchange.urls.api.rest).toBe(
      exchange.exchange.urls.test?.rest
    );
  });

  it("sets OKX posSide for swap opens and reduce-only closes", async () => {
    const createOrder = vi.fn().mockResolvedValue({
      id: "ord-1",
      status: "closed",
      filled: 1,
      amount: 1,
      average: 0.16,
      price: 0.16,
      timestamp: 1_700_000_000_000,
    });
    const engine = createEngineWithExchange(
      {
        createOrder,
      },
      {
        exchange: "okx",
        apiKey: "k",
        apiSecret: "s",
        password: "p",
        sandbox: false,
        demoTrading: false,
        defaultMarketType: "swap",
      }
    );
    (
      engine as unknown as {
        symbolMapper: { toCcxt: (symbol: string) => string };
      }
    ).symbolMapper = { toCcxt: () => "WIF/USDT:USDT" };

    await engine.placeOrder({
      symbol: "WIF/USD",
      side: "buy",
      type: "market",
      size: 1,
      leverage: 1,
    });
    await engine.placeOrder({
      symbol: "WIF/USD",
      side: "sell",
      type: "market",
      size: 1,
      reduceOnly: true,
    });

    expect(createOrder).toHaveBeenNthCalledWith(
      1,
      "WIF/USDT:USDT",
      "market",
      "buy",
      1,
      undefined,
      expect.objectContaining({ posSide: "long" })
    );
    expect(createOrder).toHaveBeenNthCalledWith(
      2,
      "WIF/USDT:USDT",
      "market",
      "sell",
      1,
      undefined,
      expect.objectContaining({ posSide: "long", reduceOnly: true })
    );
  });

  it("prefers balance payload realized PnL when recognized key exists", async () => {
    const fetchMyTrades = vi.fn();
    const engine = createEngineWithExchange({
      fetchBalance: vi.fn().mockResolvedValue({
        total: { USDT: 1000 },
        free: { USDT: 900 },
        used: { USDT: 100 },
        info: { totalRealizedPnl: "0" },
      }),
      has: { fetchMyTrades: true },
      fetchMyTrades,
    });

    const account = await engine.getAccount();

    expect(account.realizedPnL).toBe(0);
    expect(account.realizedPnlSource).toBe("balance_payload");
    expect(account.realizedPnlConfidence).toBe(0.9);
    expect(fetchMyTrades).not.toHaveBeenCalled();
  });

  it("falls back to closed-trades ledger when balance payload lacks realized fields", async () => {
    const fetchMyTrades = vi.fn().mockResolvedValue([
      { id: "t1", info: { realizedPnl: "-5.5" } },
      { id: "t2", pnl: "2.25" },
    ]);
    const engine = createEngineWithExchange({
      fetchBalance: vi.fn().mockResolvedValue({
        total: { USDT: 1000 },
        free: { USDT: 800 },
        used: { USDT: 200 },
        info: { equity: "1000" },
      }),
      has: { fetchMyTrades: true },
      fetchMyTrades,
    });

    const account = await engine.getAccount();

    expect(account.realizedPnL).toBeCloseTo(-3.25);
    expect(account.realizedPnlSource).toBe("closed_trades_ledger");
    expect(account.realizedPnlConfidence).toBe(0.75);
    expect(fetchMyTrades).toHaveBeenCalledTimes(1);
  });

  it("uses derived fallback when neither balance nor ledger expose realized PnL", async () => {
    const fetchMyTrades = vi.fn();
    const engine = createEngineWithExchange({
      fetchBalance: vi.fn().mockResolvedValue({
        total: { USDT: 1000 },
        free: { USDT: 750 },
        used: { USDT: 250 },
      }),
      has: { fetchMyTrades: false },
      fetchMyTrades,
    });

    const account = await engine.getAccount();

    expect(account.realizedPnL).toBe(0);
    expect(account.realizedPnlSource).toBe("derived_fallback");
    expect(account.realizedPnlConfidence).toBe(0.2);
    expect(fetchMyTrades).not.toHaveBeenCalled();
  });

  it("paginates closed-trades fallback and advances since cursor", async () => {
    const utcStart = new Date();
    utcStart.setUTCHours(0, 0, 0, 0);
    const startMs = utcStart.getTime();

    const fetchMyTrades = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "t1", timestamp: startMs + 10, info: { realizedPnl: "1.5" } },
        { id: "t2", timestamp: startMs + 20, info: { realizedPnl: "-0.5" } },
      ])
      .mockResolvedValueOnce([
        { id: "t3", timestamp: startMs + 30, info: { realizedPnl: "2.0" } },
        { id: "t4", timestamp: startMs + 40, info: { realizedPnl: "-1.0" } },
      ])
      .mockResolvedValueOnce([]);

    const engine = createEngineWithExchange(
      {
        fetchBalance: vi.fn().mockResolvedValue({
          total: { USDT: 1000 },
          free: { USDT: 780 },
          used: { USDT: 220 },
          info: { equity: "1000" },
        }),
        has: { fetchMyTrades: true },
        fetchMyTrades,
      },
      {
        realizedPnlLedgerFallback: {
          pageLimit: 2,
          maxPages: 4,
        },
      }
    );

    const account = await engine.getAccount();

    expect(account.realizedPnL).toBeCloseTo(2.0);
    expect(account.realizedPnlSource).toBe("closed_trades_ledger");
    expect(fetchMyTrades).toHaveBeenCalledTimes(3);
    expect(fetchMyTrades.mock.calls[0][1]).toBe(startMs);
    expect(fetchMyTrades.mock.calls[1][1]).toBeGreaterThan(
      fetchMyTrades.mock.calls[0][1]
    );
    expect(fetchMyTrades.mock.calls[2][1]).toBeGreaterThan(
      fetchMyTrades.mock.calls[1][1]
    );
  });

  it("exports resolved market identities for promotion fingerprints", () => {
    const engine = createEngineWithExchange(
      {
        markets: {
          "BTC/USDT:USDT": {
            id: "BTC-USDT-SWAP",
            symbol: "BTC/USDT:USDT",
            base: "BTC",
            quote: "USDT",
            settle: "USDT",
            type: "swap",
            info: {
              instId: "BTC-USDT-SWAP",
              instType: "SWAP",
              settleCcy: "USDT",
            },
          },
        },
        hostname: "www.okx.com",
      },
      {
        exchange: "okx",
        apiKey: "k",
        apiSecret: "s",
        password: "p",
        sandbox: false,
        demoTrading: true,
        defaultMarketType: "swap",
      }
    );
    (
      engine as unknown as {
        symbolMapper: { toCcxt: (symbol: string) => string };
      }
    ).symbolMapper = { toCcxt: () => "BTC/USDT:USDT" };

    const identities = engine.getResolvedMarketIdentities(["BTC/USD"]);

    expect(identities["BTC/USD"]).toEqual({
      internalSymbol: "BTC/USD",
      ccxtSymbol: "BTC/USDT:USDT",
      instId: "BTC-USDT-SWAP",
      instType: "SWAP",
      settleCcy: "USDT",
      defaultMarketType: "swap",
      domainBaseUrl: "www.okx.com",
      demoMode: true,
    });
  });
});

function createEngineWithExchange(
  exchange: Record<string, unknown>,
  overrides?: Partial<CcxtEngineConfig>
): CcxtTradingEngine {
  const engine = new CcxtTradingEngine({
    ...BASE_CONFIG,
    ...overrides,
  });
  (engine as unknown as { initialized: boolean }).initialized = true;
  (engine as unknown as { exchange: unknown }).exchange = exchange;
  vi.spyOn(engine, "getPositions").mockResolvedValue([]);
  return engine;
}
