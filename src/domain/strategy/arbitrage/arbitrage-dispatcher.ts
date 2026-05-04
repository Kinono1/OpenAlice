/**
 * ArbitrageDispatcher - translates arbitrage signals into dual-leg order pairs.
 *
 * For pairs trading: emits [legA, legB] where legA and legB are opposite sides.
 * For funding arb: emits [spotLeg, perpLeg] delta-neutral.
 *
 * The caller is responsible for submitting both legs via the trading engine.
 * Both legs use market orders by default to minimize leg risk.
 */

import type { CryptoPlaceOrderRequest } from '../../trading/operation-dispatcher.types.js'
import type { PairsSignal } from './types.js'
import type { FundingArbSignal } from './types.js'

export interface ArbLegPair {
  legA: CryptoPlaceOrderRequest
  legB: CryptoPlaceOrderRequest
  /** Human-readable description for logging */
  description: string
}

/**
 * Build dual-leg orders for a cointegrated pairs signal.
 *
 * direction +1 = long A / short B
 * direction -1 = short A / long B
 *
 * @param usdSize - notional USD per leg (both legs equal size for delta-neutral)
 */
export function buildPairsOrders(
  signal: PairsSignal,
  usdSize: number,
  leverage?: number,
): ArbLegPair | null {
  if (signal.direction === 0) return null

  const longSymbol = signal.direction === 1 ? signal.symbolA : signal.symbolB
  const shortSymbol = signal.direction === 1 ? signal.symbolB : signal.symbolA

  const legA: CryptoPlaceOrderRequest = {
    symbol: longSymbol,
    side: 'buy',
    type: 'market',
    usd_size: usdSize,
    leverage,
    idempotencyKey: `pairs_long_${longSymbol}_${Date.now()}`,
  }

  const legB: CryptoPlaceOrderRequest = {
    symbol: shortSymbol,
    side: 'sell',
    type: 'market',
    usd_size: usdSize,
    leverage,
    idempotencyKey: `pairs_short_${shortSymbol}_${Date.now()}`,
  }

  return {
    legA,
    legB,
    description: `pairs z=${signal.zScore.toFixed(2)} long=${longSymbol} short=${shortSymbol} hedge=${signal.hedgeRatio.toFixed(4)}`,
  }
}

/**
 * Build dual-leg orders for a funding rate arbitrage signal.
 *
 * long_spot_short_perp: buy spot + sell perp (collect positive funding)
 * short_spot_long_perp: sell spot + buy perp (collect negative funding)
 *
 * @param spotSymbol - spot market symbol (e.g. 'BTC/USDT')
 * @param perpSymbol - perpetual futures symbol (e.g. 'BTC/USDT:USDT')
 * @param usdSize - notional USD per leg
 */
export function buildFundingArbOrders(
  signal: FundingArbSignal,
  spotSymbol: string,
  perpSymbol: string,
  usdSize: number,
  leverage?: number,
): ArbLegPair | null {
  if (signal.direction === 'none') return null

  const isLongSpot = signal.direction === 'long_spot_short_perp'
  const ts = Date.now()

  const spotLeg: CryptoPlaceOrderRequest = {
    symbol: spotSymbol,
    side: isLongSpot ? 'buy' : 'sell',
    type: 'market',
    usd_size: usdSize,
    idempotencyKey: `funding_arb_spot_${spotSymbol}_${ts}`,
  }

  const perpLeg: CryptoPlaceOrderRequest = {
    symbol: perpSymbol,
    side: isLongSpot ? 'sell' : 'buy',
    type: 'market',
    usd_size: usdSize,
    leverage,
    idempotencyKey: `funding_arb_perp_${perpSymbol}_${ts}`,
  }

  return {
    legA: spotLeg,
    legB: perpLeg,
    description: `funding_arb ${signal.direction} yield=${(signal.annualizedYield * 100).toFixed(1)}%/yr pegged=${signal.isPegged}`,
  }
}

/**
 * Build close orders for an open arb position (both legs reduce-only).
 */
export function buildArbCloseOrders(
  legASymbol: string,
  legACurrentSide: 'buy' | 'sell',
  legBSymbol: string,
  legBCurrentSide: 'buy' | 'sell',
  usdSize: number,
): ArbLegPair {
  const ts = Date.now()
  return {
    legA: {
      symbol: legASymbol,
      side: legACurrentSide === 'buy' ? 'sell' : 'buy',
      type: 'market',
      usd_size: usdSize,
      reduceOnly: true,
      idempotencyKey: `arb_close_a_${legASymbol}_${ts}`,
    },
    legB: {
      symbol: legBSymbol,
      side: legBCurrentSide === 'buy' ? 'sell' : 'buy',
      type: 'market',
      usd_size: usdSize,
      reduceOnly: true,
      idempotencyKey: `arb_close_b_${legBSymbol}_${ts}`,
    },
    description: `arb_close ${legASymbol}/${legBSymbol}`,
  }
}
