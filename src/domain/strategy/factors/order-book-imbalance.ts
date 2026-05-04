/**
 * Order Book Imbalance (OBI) Factor.
 *
 * Computes a weighted order book imbalance signal from level-2 book data.
 * This is the strongest short-term predictive signal in crypto markets
 * according to practitioner consensus (Wintermute, Jump, GSR).
 *
 * OBI = (bid_vol_L1 + bid_vol_L2 - ask_vol_L1 - ask_vol_L2) /
 *       (bid_vol_L1 + bid_vol_L2 + ask_vol_L1 + ask_vol_L2)
 *
 * Range: [-1, 1]. Positive = buying pressure, negative = selling pressure.
 */

import { buildFactorSignal, clamp } from './helpers.js'
import type { FactorSignal } from './types.js'

export interface OrderBookLevel {
  price: number
  volume: number
}

export interface OrderBookImbalanceInput {
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  /** Number of levels to include (default 5) */
  depth?: number
  /** Aggressor buy ratio in [0,1] — trade-level confirmation (optional) */
  aggressorBuyRatio?: number
}

const DEFAULT_DEPTH = 5

export function evaluateOrderBookImbalance(
  input: OrderBookImbalanceInput,
): FactorSignal {
  const depth = Math.max(1, input.depth ?? DEFAULT_DEPTH)
  const bids = input.bids.slice(0, depth)
  const asks = input.asks.slice(0, depth)

  let bidWeightedVol = 0
  let askWeightedVol = 0
  let totalWeight = 0

  for (let i = 0; i < Math.max(bids.length, asks.length); i++) {
    const weight = Math.exp(-i * 0.5)
    totalWeight += weight
    if (i < bids.length) {
      bidWeightedVol += bids[i].volume * weight
    }
    if (i < asks.length) {
      askWeightedVol += asks[i].volume * weight
    }
  }

  const totalVol = bidWeightedVol + askWeightedVol
  const rawObi = totalVol > 0
    ? (bidWeightedVol - askWeightedVol) / totalVol
    : 0

  let adjusted = rawObi

  if (typeof input.aggressorBuyRatio === 'number' && Number.isFinite(input.aggressorBuyRatio)) {
    const aggressorSignal = (input.aggressorBuyRatio - 0.5) * 2
    adjusted = rawObi * 0.6 + aggressorSignal * 0.4
  }

  const signal = clamp(adjusted * 3, -1, 1)
  const confidence = clamp(Math.abs(rawObi) * 2.5, 0.1, 1)

  return buildFactorSignal({
    name: 'order-book-imbalance',
    rawValue: signal,
    rawConfidence: confidence,
    metadata: {
      rawObi,
      bidWeightedVol,
      askWeightedVol,
      depth,
      aggressorBuyRatio: input.aggressorBuyRatio ?? -1,
    },
  })
}
