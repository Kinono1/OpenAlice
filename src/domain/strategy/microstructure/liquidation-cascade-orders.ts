/**
 * Liquidation Cascade Order Builder.
 *
 * Translates a LiquidationCascadeSignal into a grid of limit-maker orders
 * spread across the entry zone. After cascade momentum exhausts (detected via
 * tStat momentum flip), caller should submit reduce-only market close.
 */

import type { CryptoPlaceOrderRequest } from '../../trading/operation-dispatcher.types.js'
import type { LiquidationCascadeSignal } from './liquidation-cascade.js'

export interface CascadeOrderGridConfig {
  /** Total USD notional to deploy across the grid */
  totalUsdSize: number
  /** Number of limit orders to spread across the entry zone (default 4) */
  gridLevels?: number
  /** Leverage for the orders (default 1 = spot-equivalent) */
  leverage?: number
}

export interface CascadeOrderGrid {
  orders: CryptoPlaceOrderRequest[]
  /** Side of the grid (buy for long-liq cascade, sell for short-liq cascade) */
  side: 'buy' | 'sell'
  entryZone: [number, number]
  description: string
}

/**
 * Build a grid of limit-maker orders to catch a liquidation cascade.
 * Returns null if the signal is not a cascade or has no entry zone.
 */
export function buildCascadeOrderGrid(
  signal: LiquidationCascadeSignal,
  config: CascadeOrderGridConfig,
): CascadeOrderGrid | null {
  if (!signal.isCascade || !signal.entryZone) return null
  if (signal.dominantSide === 'mixed') return null

  const { totalUsdSize, gridLevels = 4, leverage } = config
  const [lower, upper] = signal.entryZone
  const side: 'buy' | 'sell' = signal.dominantSide === 'long' ? 'buy' : 'sell'
  const usdPerLevel = totalUsdSize / gridLevels
  const priceStep = (upper - lower) / Math.max(gridLevels - 1, 1)
  const ts = Date.now()

  const orders: CryptoPlaceOrderRequest[] = []
  for (let i = 0; i < gridLevels; i++) {
    // For buy grid: densest near upper (closer to current price), spread down
    // For sell grid: densest near lower (closer to current price), spread up
    const price = side === 'buy'
      ? upper - i * priceStep
      : lower + i * priceStep

    orders.push({
      symbol: signal.symbol,
      side,
      type: 'limit',
      price,
      usd_size: usdPerLevel,
      leverage,
      idempotencyKey: `cascade_${signal.symbol}_${side}_${i}_${ts}`,
    })
  }

  return {
    orders,
    side,
    entryZone: signal.entryZone,
    description: `cascade_grid ${signal.symbol} ${side} ${gridLevels}L conf=${signal.confidence.toFixed(2)} zone=[${lower.toFixed(2)},${upper.toFixed(2)}]`,
  }
}

/**
 * Build reduce-only close orders for an open cascade grid position.
 * Call this when momentum tStat flips (exhaustion signal).
 */
export function buildCascadeCloseOrders(
  symbol: string,
  openSide: 'buy' | 'sell',
  totalUsdSize: number,
): CryptoPlaceOrderRequest[] {
  return [{
    symbol,
    side: openSide === 'buy' ? 'sell' : 'buy',
    type: 'market',
    usd_size: totalUsdSize,
    reduceOnly: true,
    idempotencyKey: `cascade_close_${symbol}_${Date.now()}`,
  }]
}
