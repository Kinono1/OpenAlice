/**
 * CCXT Trading Engine
 *
 * CCXT implementation of ICryptoTradingEngine, connecting to 100+ exchanges via ccxt unified API
 * No polling/waiting; placeOrder returns the exchange's immediate response directly
 */

import ccxt from "ccxt";
import type { Exchange, Order as CcxtOrder } from "ccxt";
import type {
  ICryptoTradingEngine,
  CryptoPlaceOrderRequest,
  CryptoOrderResult,
  CryptoPosition,
  CryptoOrder,
  CryptoAccountInfo,
  CryptoTicker,
  CryptoFundingRate,
  CryptoOrderBook,
  CryptoOrderBookLevel,
} from '../../interfaces.js';
import { SymbolMapper } from './symbol-map.js';

export interface CcxtEngineConfig {
  exchange: string;
  apiKey: string;
  apiSecret: string;
  password?: string;
  sandbox: boolean;
  demoTrading?: boolean;
  defaultMarketType: 'spot' | 'swap';
  options?: Record<string, unknown>;
  realizedPnlLedgerFallback?: {
    pageLimit?: number;
    maxPages?: number;
  };
}

export class CcxtTradingEngine implements ICryptoTradingEngine {
  private exchange: Exchange;
  private symbolMapper: SymbolMapper;
  private initialized = false;

  // Maintain orderId -> ccxtSymbol mapping for cancelOrder
  private orderSymbolCache = new Map<string, string>();

  constructor(private config: CcxtEngineConfig) {
    const exchangeOptions = this.buildExchangeOptions(config);
    const exchanges = ccxt as unknown as Record<
      string,
      new (opts: Record<string, unknown>) => Exchange
    >;
    const ExchangeClass = exchanges[config.exchange];
    if (!ExchangeClass) {
      throw new Error(`Unknown CCXT exchange: ${config.exchange}`);
    }

    this.exchange = new ExchangeClass({
      apiKey: config.apiKey,
      secret: config.apiSecret,
      password: config.password,
      options: config.options,
    });

    // OKX can fail on startup when CCXT fetches authenticated currency metadata.
    // We only need markets + trading/account endpoints for this engine, so skip it.
    if (config.exchange === "okx") {
      (
        this.exchange as unknown as { has: Record<string, unknown> }
      ).has.fetchCurrencies = false;
    }

    if (config.sandbox) {
      this.exchange.setSandboxMode(true);
    }

    if (config.demoTrading) {
      (
        this.exchange as unknown as {
          enableDemoTrading: (enable: boolean) => void;
        }
      ).enableDemoTrading(true);
    }

    this.symbolMapper = new SymbolMapper(
      config.defaultMarketType,
    );
  }

  private buildExchangeOptions(
    config: CcxtEngineConfig
  ): Record<string, unknown> {
    const raw = (config.options ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...raw };

    // OKX is more stable with a longer timeout on some networks.
    if (config.exchange === "okx") {
      if (merged.timeout == null) merged.timeout = 30_000;
      if (merged.enableRateLimit == null) merged.enableRateLimit = true;

      const nested = (merged.options ?? {}) as Record<string, unknown>;
      if (nested.defaultType == null)
        nested.defaultType = config.defaultMarketType;
      if (nested.fetchMarkets == null) {
        nested.fetchMarkets = { types: [config.defaultMarketType] };
      }
      merged.options = nested;
    }

    return merged;
  }

  async init(): Promise<void> {
    if (this.config.exchange === "okx") {
      await this.loadOkxMarketsWithHostFallback();
    } else {
      await this.exchange.loadMarkets();
    }
    this.symbolMapper.init(
      this.exchange.markets as unknown as Record<
        string,
        {
          symbol: string;
          base: string;
          quote: string;
          type: string;
          settle?: string;
          active?: boolean;
          precision?: { price?: number; amount?: number };
        }
      >
    );
    this.initialized = true;
  }

  private async loadOkxMarketsWithHostFallback(): Promise<void> {
    const ex = this.exchange as unknown as {
      hostname?: string;
      loadMarkets: (reload?: boolean) => Promise<void>;
    };

    const configuredHost = ex.hostname;
    const candidates = [configuredHost, "www.okx.com", "aws.okx.com"].filter(
      (v, i, arr): v is string => Boolean(v) && arr.indexOf(v) === i
    );

    let lastError: unknown;
    for (const host of candidates) {
      try {
        ex.hostname = host;
        // Use reload=true so CCXT does not reuse a previously failed marketsLoading promise.
        await ex.loadMarkets(true);
        return;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("OKX loadMarkets failed for all fallback hostnames");
  }

  // ==================== ICryptoTradingEngine ====================

  async placeOrder(
    order: CryptoPlaceOrderRequest,
    _currentTime?: Date
  ): Promise<CryptoOrderResult> {
    this.ensureInit();

    const ccxtSymbol = this.symbolMapper.toCcxt(order.symbol);
    let size = order.size;

    // usd_size -> coin size conversion
    if (!size && order.usd_size) {
      const ticker = await this.exchange.fetchTicker(ccxtSymbol);
      const price = order.price ?? ticker.last;
      if (!price) {
        return {
          success: false,
          error: "Cannot determine price for USD size conversion",
        };
      }
      size = order.usd_size / price;
    }

    if (!size) {
      return {
        success: false,
        error: "Either size or usd_size must be provided",
      };
    }

    try {
      // Futures: set leverage first
      if (order.leverage && order.leverage > 1) {
        try {
          await this.exchange.setLeverage(order.leverage, ccxtSymbol);
        } catch {
          // Some exchanges don't support setLeverage or leverage is already set; ignore
        }
      }

      const params: Record<string, unknown> = {};
      if (order.reduceOnly) params.reduceOnly = true;
      if (order.idempotencyKey) {
        const capability = getExchangeCapability(this.config.exchange);
        if (capability.supportsClientOrderId && capability.clientOrderIdField) {
          params[capability.clientOrderIdField] = order.idempotencyKey;
        }
      }

      const ccxtOrder = await this.exchange.createOrder(
        ccxtSymbol,
        order.type,
        order.side,
        size,
        order.type === "limit" ? order.price : undefined,
        params
      );

      // Cache orderId -> symbol mapping
      if (ccxtOrder.id) {
        this.orderSymbolCache.set(ccxtOrder.id, ccxtSymbol);
      }

      const status = this.mapOrderStatus(
        ccxtOrder.status,
        ccxtOrder.filled,
        ccxtOrder.amount
      );
      const filledSize =
        typeof ccxtOrder.filled === "number" ? ccxtOrder.filled : undefined;
      const requestedSize =
        typeof ccxtOrder.amount === "number" ? ccxtOrder.amount : size;
      const remainingSize =
        typeof requestedSize === "number" && typeof filledSize === "number"
          ? Math.max(0, requestedSize - filledSize)
          : undefined;
      const exchangeUpdateTs =
        ccxtOrder.lastTradeTimestamp ?? ccxtOrder.timestamp ?? Date.now();
      const hasAnyFill = typeof filledSize === "number" && filledSize > 0;
      const averageFillPrice = hasAnyFill
        ? (ccxtOrder.average ?? ccxtOrder.price ?? undefined)
        : undefined;

      return {
        success: true,
        orderId: ccxtOrder.id,
        message: `Order ${ccxtOrder.id} ${status}`,
        orderStatus: status,
        requestedSize,
        remainingSize,
        filledPrice: averageFillPrice,
        filledSize,
        averageFillPrice,
        firstFillAtMs: hasAnyFill ? exchangeUpdateTs : undefined,
        completedAtMs:
          status === "filled" || status === "cancelled" || status === "rejected"
            ? exchangeUpdateTs
            : undefined,
        exchangeUpdateTs,
        idempotencyKey: order.idempotencyKey,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getPositions(): Promise<CryptoPosition[]> {
    this.ensureInit();

    const raw = await this.exchange.fetchPositions();
    const result: CryptoPosition[] = [];

    for (const p of raw) {
      const internalSymbol = this.symbolMapper.tryToInternal(p.symbol);
      if (!internalSymbol) continue;

      const size = Math.abs(
        parseFloat(String(p.contracts ?? 0)) *
          parseFloat(String(p.contractSize ?? 1))
      );
      if (size === 0) continue;

      result.push({
        symbol: internalSymbol,
        side: p.side === "long" ? "long" : "short",
        size,
        entryPrice: parseFloat(String(p.entryPrice ?? 0)),
        leverage: parseFloat(String(p.leverage ?? 1)),
        margin: parseFloat(String(p.initialMargin ?? p.collateral ?? 0)),
        liquidationPrice: parseFloat(String(p.liquidationPrice ?? 0)),
        markPrice: parseFloat(String(p.markPrice ?? 0)),
        unrealizedPnL: parseFloat(String(p.unrealizedPnl ?? 0)),
        positionValue: size * parseFloat(String(p.markPrice ?? 0)),
      });
    }

    return result;
  }

  async getOrders(): Promise<CryptoOrder[]> {
    this.ensureInit();

    const allOrders: CcxtOrder[] = [];

    try {
      const open = await this.exchange.fetchOpenOrders();
      allOrders.push(...open);
    } catch {
      // Some exchanges don't support fetchOpenOrders
    }

    try {
      const closed = await this.exchange.fetchClosedOrders(
        undefined,
        undefined,
        50
      );
      allOrders.push(...closed);
    } catch {
      // Some exchanges don't support fetchClosedOrders
    }

    const result: CryptoOrder[] = [];

    for (const o of allOrders) {
      const internalSymbol = this.symbolMapper.tryToInternal(o.symbol);
      if (!internalSymbol) continue;

      // Cache orderId -> symbol
      if (o.id) {
        this.orderSymbolCache.set(o.id, o.symbol);
      }

      const mappedStatus = this.mapOrderStatus(o.status, o.filled, o.amount);
      result.push({
        id: o.id,
        symbol: internalSymbol,
        side: o.side as CryptoOrder["side"],
        type: (o.type ?? "market") as CryptoOrder["type"],
        size: o.amount ?? 0,
        price: o.price,
        leverage: undefined,
        reduceOnly: o.reduceOnly ?? false,
        status: mappedStatus,
        filledPrice: o.average,
        filledSize: o.filled,
        requestedSize: o.amount,
        remainingSize:
          typeof o.amount === "number" && typeof o.filled === "number"
            ? Math.max(0, o.amount - o.filled)
            : undefined,
        averageFillPrice: o.average,
        firstFillAtMs:
          typeof o.filled === "number" && o.filled > 0
            ? (o.lastTradeTimestamp ?? o.timestamp ?? undefined)
            : undefined,
        completedAtMs:
          mappedStatus === "filled" ||
          mappedStatus === "cancelled" ||
          mappedStatus === "rejected"
            ? (o.lastTradeTimestamp ?? o.timestamp ?? undefined)
            : undefined,
        exchangeUpdateTs: o.lastTradeTimestamp ?? o.timestamp ?? undefined,
        filledAt: o.lastTradeTimestamp
          ? new Date(o.lastTradeTimestamp)
          : undefined,
        createdAt: new Date(o.timestamp ?? Date.now()),
      });
    }

    return result;
  }

  async getAccount(): Promise<CryptoAccountInfo> {
    this.ensureInit();

    const [balance, rawPositions] = await Promise.all([
      this.exchange.fetchBalance(),
      this.exchange.fetchPositions(),
    ]);

    // CCXT Balance uses indexer to access currency
    const bal = balance as unknown as Record<string, Record<string, unknown>>;
    const total = parseFloat(
      String(bal["total"]?.["USDT"] ?? bal["total"]?.["USD"] ?? 0)
    );
    const free = parseFloat(
      String(bal["free"]?.["USDT"] ?? bal["free"]?.["USD"] ?? 0)
    );
    const used = parseFloat(
      String(bal["used"]?.["USDT"] ?? bal["used"]?.["USD"] ?? 0)
    );

    // Aggregate PnL from raw positions
    let unrealizedPnL = 0;
    let realizedPnL = 0;
    for (const p of rawPositions) {
      if (!this.symbolMapper.tryToInternal(p.symbol)) continue;
      unrealizedPnL += parseFloat(String(p.unrealizedPnl ?? 0));
      realizedPnL += parseFloat(String((p as unknown as Record<string, unknown>).realizedPnl ?? 0));
    }

    return {
      balance: free,
      totalMargin: used,
      unrealizedPnL,
      equity: total,
      realizedPnL,
      totalPnL: realizedPnL + unrealizedPnL,
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    this.ensureInit();

    try {
      const ccxtSymbol = this.orderSymbolCache.get(orderId);
      await this.exchange.cancelOrder(orderId, ccxtSymbol);
      return true;
    } catch {
      return false;
    }
  }

  async adjustLeverage(
    symbol: string,
    newLeverage: number
  ): Promise<{ success: boolean; error?: string }> {
    this.ensureInit();

    const ccxtSymbol = this.symbolMapper.toCcxt(symbol);
    try {
      await this.exchange.setLeverage(newLeverage, ccxtSymbol);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getTicker(symbol: string): Promise<CryptoTicker> {
    this.ensureInit();

    const ccxtSymbol = this.symbolMapper.toCcxt(symbol);
    const ticker = await this.exchange.fetchTicker(ccxtSymbol);

    return {
      symbol,
      last: ticker.last ?? 0,
      bid: ticker.bid ?? 0,
      ask: ticker.ask ?? 0,
      high: ticker.high ?? 0,
      low: ticker.low ?? 0,
      volume: ticker.baseVolume ?? 0,
      timestamp: new Date(ticker.timestamp ?? Date.now()),
    };
  }

  async getFundingRate(symbol: string): Promise<CryptoFundingRate> {
    this.ensureInit();

    const ccxtSymbol = this.symbolMapper.toCcxt(symbol);
    const funding = await this.exchange.fetchFundingRate(ccxtSymbol);

    return {
      symbol,
      fundingRate: funding.fundingRate ?? 0,
      nextFundingTime: funding.fundingDatetime
        ? new Date(funding.fundingDatetime)
        : undefined,
      previousFundingRate: funding.previousFundingRate ?? undefined,
      timestamp: new Date(funding.timestamp ?? Date.now()),
    };
  }

  async getOrderBook(symbol: string, limit?: number): Promise<CryptoOrderBook> {
    this.ensureInit();

    const ccxtSymbol = this.symbolMapper.toCcxt(symbol);
    const book = await this.exchange.fetchOrderBook(ccxtSymbol, limit);

    return {
      symbol,
      bids: book.bids.map(([p, a]) => [p ?? 0, a ?? 0] as CryptoOrderBookLevel),
      asks: book.asks.map(([p, a]) => [p ?? 0, a ?? 0] as CryptoOrderBookLevel),
      timestamp: new Date(book.timestamp ?? Date.now()),
    };
  }

  // ==================== Helpers ====================

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error("CcxtTradingEngine not initialized. Call init() first.");
    }
  }

  private mapOrderStatus(
    status: string | undefined,
    filled?: number,
    amount?: number
  ): CryptoOrder["status"] {
    const hasPartialFill =
      typeof filled === "number" &&
      filled > 0 &&
      typeof amount === "number" &&
      filled < amount;

    switch (status) {
      case "closed":
        return "filled";
      case "partially_filled":
        return "partially_filled";
      case "open":
        return hasPartialFill ? "partially_filled" : "pending";
      case "canceled":
      case "cancelled":
        return "cancelled";
      case "expired":
      case "rejected":
        return "rejected";
      default:
        return hasPartialFill ? "partially_filled" : "pending";
    }
  }

  private async extractRealizedPnlFromClosedTrades(): Promise<{
    found: boolean;
    realizedPnl: number;
  }> {
    const hasMyTrades = (this.exchange as unknown as { has?: Record<string, unknown> })
      .has?.fetchMyTrades;
    if (!hasMyTrades) {
      return { found: false, realizedPnl: 0 };
    }

    // Daily risk guard uses daily realized PnL; use UTC-day ledger fallback.
    const utcStart = new Date();
    utcStart.setUTCHours(0, 0, 0, 0);
    let sinceMs = utcStart.getTime();
    const { pageLimit, maxPages } = this.getLedgerFallbackPagingConfig();

    try {
      const aggregatedTrades: unknown[] = [];
      for (let page = 0; page < maxPages; page++) {
        const trades = await this.exchange.fetchMyTrades(
          undefined,
          sinceMs,
          pageLimit
        );
        if (!Array.isArray(trades) || trades.length === 0) {
          break;
        }
        aggregatedTrades.push(...trades);
        if (trades.length < pageLimit) {
          break;
        }
        const nextSince = this.computeNextSinceMs(trades, sinceMs);
        if (nextSince == null) {
          break;
        }
        sinceMs = nextSince;
      }

      const extracted =
        extractRealizedPnlDetailsFromClosedTradesLedger(aggregatedTrades);
      return { found: extracted.found, realizedPnl: extracted.realizedPnl };
    } catch {
      return { found: false, realizedPnl: 0 };
    }
  }

  private getLedgerFallbackPagingConfig(): {
    pageLimit: number;
    maxPages: number;
  } {
    const raw = this.config.realizedPnlLedgerFallback;
    return {
      pageLimit: normalizePositiveInteger(
        raw?.pageLimit,
        DEFAULT_LEDGER_FALLBACK_PAGE_LIMIT
      ),
      maxPages: normalizePositiveInteger(
        raw?.maxPages,
        DEFAULT_LEDGER_FALLBACK_MAX_PAGES
      ),
    };
  }

  private computeNextSinceMs(
    trades: unknown[],
    currentSinceMs: number
  ): number | null {
    let maxTradeTs = Number.NEGATIVE_INFINITY;
    for (const trade of trades) {
      if (!trade || typeof trade !== "object") {
        continue;
      }
      const ts = parseTradeTimestamp(
        (trade as Record<string, unknown>).timestamp
      );
      if (typeof ts === "number" && Number.isFinite(ts) && ts > maxTradeTs) {
        maxTradeTs = ts;
      }
    }

    if (!Number.isFinite(maxTradeTs)) {
      return null;
    }
    const nextSince = maxTradeTs + 1;
    if (!Number.isFinite(nextSince) || nextSince <= currentSinceMs) {
      return null;
    }
    return nextSince;
  }

  async close(): Promise<void> {
    // ccxt exchanges typically don't need explicit closing
  }
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function parseTradeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}
