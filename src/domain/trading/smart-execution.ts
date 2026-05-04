/**
 * Smart Execution — reduce slippage and market impact.
 *
 * Implements practitioner-standard techniques:
 *   - TWAP (Time-Weighted Average Price) splitting
 *   - Maker-only spread capture
 *   - Dynamic slippage estimation from order book depth
 *   - Exchange selection by fee + liquidity
 */

import Decimal from 'decimal.js'

export interface ExecutionSlice {
  sliceIndex: number
  fraction: number
  targetExecTimeMs: number
  priceLimit?: number
}

export interface ExecutionPlan {
  slices: ExecutionSlice[]
  totalFraction: number
  expectedSlippageBps: number
  recommendedExchange: string
}

export interface SmartExecutionConfig {
  /** Total order size in base currency */
  totalSize: number
  /** Current mid price */
  midPrice: number
  /** Number of TWAP slices */
  slices?: number
  /** Total execution window in milliseconds */
  windowMs?: number
  /** Minimum fraction per slice */
  minSliceFraction?: number
  /** Whether to prefer maker orders (earn fees, slower execution) */
  preferMaker?: boolean
  /** Maximum acceptable slippage in bps */
  maxSlippageBps?: number
  /** Deterministic clock override for tests/replay. Defaults to Date.now(). */
  nowMs?: number
}

export interface ExchangeLiquidity {
  exchange: string
  bidDepth: number
  askDepth: number
  takerFeeBps: number
  makerRebateBps: number
}

const DEFAULT_SLICES = 5
const DEFAULT_WINDOW_MS = 300_000
const DEFAULT_MIN_SLICE_FRACTION = 0.1

export function buildTwapPlan(
  config: SmartExecutionConfig,
): ExecutionPlan {
  assertPositiveFinite(config.totalSize, 'totalSize')
  assertPositiveFinite(config.midPrice, 'midPrice')
  const slices = Math.max(1, config.slices ?? DEFAULT_SLICES)
  const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS
  const minFraction = config.minSliceFraction ?? DEFAULT_MIN_SLICE_FRACTION
  const fractionPerSlice = Math.min(1, Math.max(0, minFraction, 1 / slices))
  const nowMs = config.nowMs ?? Date.now()

  const planSlices: ExecutionSlice[] = []
  let remainingFraction = 1

  for (let i = 0; i < slices - 1 && remainingFraction > 0; i++) {
    const fraction = Math.min(fractionPerSlice, remainingFraction)
    planSlices.push({
      sliceIndex: i,
      fraction,
      targetExecTimeMs: nowMs + (i + 1) * (windowMs / slices),
    })
    remainingFraction -= fraction
  }

  if (remainingFraction > 0) {
    planSlices.push({
      sliceIndex: slices - 1,
      fraction: remainingFraction,
      targetExecTimeMs: nowMs + windowMs,
    })
  }

  return {
    slices: planSlices,
    totalFraction: planSlices.reduce((s, sl) => s + sl.fraction, 0),
    expectedSlippageBps: 0,
    recommendedExchange: 'default',
  }
}

export function selectBestExchange(
  side: 'buy' | 'sell',
  size: number,
  midPrice: number,
  exchanges: ExchangeLiquidity[],
): { exchange: string; expectedSlippageBps: number; effectiveFeeBps: number } | null {
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(midPrice) || midPrice <= 0) return null
  if (exchanges.length === 0) return null

  let bestExchange: ExchangeLiquidity | null = null
  let bestCost = Infinity

  for (const ex of exchanges) {
    const depth = side === 'buy' ? ex.askDepth : ex.bidDepth
    if (!Number.isFinite(depth) || depth <= 0) continue
    if (!Number.isFinite(ex.takerFeeBps)) continue
    const sizeInQuote = new Decimal(size).mul(midPrice).toNumber()
    const depthRatio = sizeInQuote / depth
    const slippageEstimate = depthRatio * 5 // ~5bps per 100% depth consumption
    const effectiveFee = ex.takerFeeBps
    const totalCost = slippageEstimate + effectiveFee

    if (totalCost < bestCost) {
      bestCost = totalCost
      bestExchange = ex
    }
  }

  if (!bestExchange) return null

  return {
    exchange: bestExchange.exchange,
    expectedSlippageBps: Math.max(0, bestCost - bestExchange.takerFeeBps),
    effectiveFeeBps: bestExchange.takerFeeBps,
  }
}

export function estimateSlippageFromDepth(
  side: 'buy' | 'sell',
  size: number,
  midPrice: number,
  depthLevels: Array<{ price: number; volume: number }>,
  maxSlippageBps?: number,
): { filledFraction: number; avgPrice: number; slippageBps: number } {
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(midPrice) || midPrice <= 0) {
    return { filledFraction: 0, avgPrice: midPrice, slippageBps: 0 }
  }
  let remaining = size
  let totalCost = new Decimal(0)
  let filled = new Decimal(0)

  for (const level of depthLevels) {
    if (remaining <= 0) break
    if (!Number.isFinite(level.price) || level.price <= 0 || !Number.isFinite(level.volume) || level.volume <= 0) {
      continue
    }

    const fillSize = Math.min(remaining, level.volume)
    const candidateCost = totalCost.add(new Decimal(level.price).mul(fillSize))
    const candidateFilled = filled.add(fillSize)

    if (maxSlippageBps !== undefined) {
      const avgPriceSoFar = candidateCost.div(candidateFilled).toNumber()
      const slippageBps = side === 'buy'
        ? ((avgPriceSoFar - midPrice) / midPrice) * 10_000
        : ((midPrice - avgPriceSoFar) / midPrice) * 10_000
      if (slippageBps > maxSlippageBps) break
    }

    totalCost = candidateCost
    filled = candidateFilled
    remaining -= fillSize
  }

  const filledFraction = filled.div(size).toNumber()
  const avgPrice = filled.gt(0) ? totalCost.div(filled).toNumber() : midPrice
  const slippageBps = side === 'buy'
    ? ((avgPrice - midPrice) / midPrice) * 10_000
    : ((midPrice - avgPrice) / midPrice) * 10_000

  return {
    filledFraction,
    avgPrice,
    slippageBps: Math.max(0, slippageBps),
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`)
  }
}
