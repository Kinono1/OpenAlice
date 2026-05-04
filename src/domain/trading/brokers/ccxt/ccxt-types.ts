export interface CcxtBrokerConfig {
  id?: string
  label?: string
  exchange: string
  sandbox: boolean
  demoTrading?: boolean
  options?: Record<string, unknown>
  // CCXT standard credential fields (all optional — each exchange requires a different subset)
  apiKey?: string
  secret?: string
  apiSecret?: string
  uid?: string
  accountId?: string
  login?: string
  password?: string
  twofa?: string
  privateKey?: string
  walletAddress?: string
  token?: string
}

/** CCXT standard credential field names (matches base Exchange.requiredCredentials map). */
export const CCXT_CREDENTIAL_FIELDS = [
  'apiKey', 'secret', 'uid', 'accountId', 'login',
  'password', 'twofa', 'privateKey', 'walletAddress', 'token',
] as const

export type CcxtCredentialField = typeof CCXT_CREDENTIAL_FIELDS[number]

export interface CcxtMarket {
  id: string        // exchange-native symbol, e.g. "BTCUSDT"
  symbol: string    // CCXT unified format, e.g. "BTC/USDT:USDT"
  base: string      // e.g. "BTC"
  quote: string     // e.g. "USDT"
  type: string      // "spot" | "swap" | "future" | "option"
  settle?: string   // e.g. "USDT" (for derivatives)
  active?: boolean
  precision?: { price?: number; amount?: number }
}

export const MAX_INIT_RETRIES = 8
export const INIT_RETRY_BASE_MS = 500

// ==================== CCXT-specific types (not part of IBroker) ====================

import type { Contract } from '@traderalice/ibkr'
import type { Position } from '../types.js'

/** Position with crypto-specific fields (leverage, margin, liquidation). */
export interface CcxtPosition extends Position {
  leverage?: number
  margin?: number
  liquidationPrice?: number
}

export interface FundingRate {
  contract: Contract
  fundingRate: number
  nextFundingTime?: Date
  previousFundingRate?: number
  timestamp: Date
}

export interface OpenInterestSnapshot {
  contract: Contract
  openInterest: number
  openInterestValue?: number
  timestamp: Date
}

export interface LiquidationSummary {
  contract: Contract
  count: number
  totalContracts: number
  totalNotional?: number
  sinceMs?: number
  limit?: number
  timestamp: Date
}

/** [price, amount] */
export type OrderBookLevel = [price: number, amount: number]

export interface OrderBook {
  contract: Contract
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  timestamp: Date
}
