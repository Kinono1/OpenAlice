import type { LOBSnapshot, OFIResult } from './types.js'

/**
 * Multi-level Order Flow Imbalance (OFI) following Cont, Kukanov & Stoikov (2014).
 *
 * For each level i:
 *   - If bid price increases: add new bid size (aggressive buy pressure)
 *   - If bid price unchanged: add deltabidSize (positive = more bids added)
 *   - If bid price decreases: subtract old bid size
 *   - Mirror logic for ask side (sign-flipped)
 *
 * Levels are weighted by exponential decay: weight_i = exp(-decay * i)
 */
export function computeOFI(
  prev: LOBSnapshot,
  curr: LOBSnapshot,
  options: { levels?: number; decayFactor?: number } = {},
): OFIResult {
  const { levels = 10, decayFactor = 0.5 } = options
  const n = Math.min(levels, prev.bids.length, curr.bids.length, prev.asks.length, curr.asks.length)

  const levelOfi: number[] = []
  let totalOfi = 0
  let totalDepth = 0

  for (let i = 0; i < n; i++) {
    const prevBid = prev.bids[i]!
    const currBid = curr.bids[i]!
    const prevAsk = prev.asks[i]!
    const currAsk = curr.asks[i]!

    let bidOfi: number
    if (currBid.price > prevBid.price) {
      bidOfi = currBid.size
    } else if (currBid.price === prevBid.price) {
      bidOfi = currBid.size - prevBid.size
    } else {
      bidOfi = -prevBid.size
    }

    let askOfi: number
    if (currAsk.price < prevAsk.price) {
      askOfi = -currAsk.size
    } else if (currAsk.price === prevAsk.price) {
      askOfi = -(currAsk.size - prevAsk.size)
    } else {
      askOfi = prevAsk.size
    }

    const weight = Math.exp(-decayFactor * i)
    const levelContrib = weight * (bidOfi + askOfi)
    levelOfi.push(levelContrib)
    totalOfi += levelContrib
    totalDepth += weight * (currBid.size + currAsk.size)
  }

  const normalizedOfi = totalDepth > 0 ? Math.max(-1, Math.min(1, totalOfi / totalDepth)) : 0

  return {
    ofi: totalOfi,
    normalizedOfi,
    levelOfi,
    timestamp: curr.timestamp,
  }
}
