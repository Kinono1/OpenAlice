/**
 * Declaration merge: adds `aliceId` to IBKR Contract class.
 *
 * aliceId is Alice's unique asset identifier: "{utaId}|{nativeKey}"
 * e.g. "alpaca-paper|META", "bybit-main|ETH/USDT:USDT"
 *
 * Constructed by UTA layer (not broker). Broker uses symbol/localSymbol for resolution.
 * The @traderalice/ibkr package stays a pure IBKR replica.
 *
 * localSymbol semantics by broker:
 * - IBKR: exchange-native symbol (e.g., "AAPL", "ESZ4")
 * - Alpaca: ticker symbol (e.g., "AAPL")
 * - CCXT: unified market symbol (e.g., "ETH/USDT:USDT")
 * UTA uses localSymbol as nativeKey in aliceId: "{utaId}|{nativeKey}"
 */

import '@traderalice/ibkr'

declare module '@traderalice/ibkr' {
  interface Contract {
    aliceId?: string
  }
}
