/**
 * Crypto Trading Engine interface definitions
 *
 * Only defines interfaces and data types; implementation is provided by external trading services
 */

// ==================== Asset whitelist ====================

export let CRYPTO_ALLOWED_SYMBOLS: readonly string[] = [
  'BTC/USD',
  'ETH/USD',
  'SOL/USD',
  'BNB/USD',
  'APT/USD',
  'SUI/USD',
  'HYPE/USD',
  'DOGE/USD',
  'XRP/USD',
];

export function initCryptoAllowedSymbols(symbols: string[]): void {
  CRYPTO_ALLOWED_SYMBOLS = Object.freeze([...symbols]);
}

export type CryptoAllowedSymbol = string;

// ==================== Core interfaces ====================

export interface ICryptoTradingEngine {
  placeOrder(order: CryptoPlaceOrderRequest, currentTime?: Date): Promise<CryptoOrderResult>;
  getPositions(): Promise<CryptoPosition[]>;
  getOrders(): Promise<CryptoOrder[]>;
  getAccount(): Promise<CryptoAccountInfo>;
  cancelOrder(orderId: string): Promise<boolean>;
  adjustLeverage(symbol: string, newLeverage: number): Promise<{ success: boolean; error?: string }>;
}

// ==================== Orders ====================

export interface CryptoPlaceOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  size?: number;
  usd_size?: number;
  price?: number;
  leverage?: number;
  reduceOnly?: boolean;
  /** Stable idempotency key for cross-process dedupe and exchange-side client order ID. */
  idempotencyKey?: string;
}

export type CryptoOrderStatus =
  | 'pending'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'rejected';

export interface CryptoOrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  message?: string;
  orderStatus?: CryptoOrderStatus;
  requestedSize?: number;
  remainingSize?: number;
  filledPrice?: number;
  filledSize?: number;
  averageFillPrice?: number;
  firstFillAtMs?: number;
  completedAtMs?: number;
  exchangeUpdateTs?: number;
  idempotencyKey?: string;
  retryOfOrderId?: string;
}

export interface CryptoOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  size: number;
  price?: number;
  leverage?: number;
  reduceOnly?: boolean;
  status: CryptoOrderStatus;
  filledPrice?: number;
  filledSize?: number;
  requestedSize?: number;
  remainingSize?: number;
  averageFillPrice?: number;
  firstFillAtMs?: number;
  completedAtMs?: number;
  exchangeUpdateTs?: number;
  filledAt?: Date;
  createdAt: Date;
  rejectReason?: string;
}

// ==================== Positions ====================

export interface CryptoPosition {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  leverage: number;
  margin: number;
  liquidationPrice: number;
  markPrice: number;
  unrealizedPnL: number;
  positionValue: number;
}

// ==================== Account ====================

export interface CryptoAccountInfo {
  balance: number;
  totalMargin: number;
  unrealizedPnL: number;
  equity: number;
  realizedPnL: number;
  totalPnL: number;
  realizedPnlSource?: "balance_payload" | "closed_trades_ledger" | "derived_fallback";
  realizedPnlConfidence?: number;
}

// ==================== Precision ====================

export interface SymbolPrecision {
  price: number;
  size: number;
}
