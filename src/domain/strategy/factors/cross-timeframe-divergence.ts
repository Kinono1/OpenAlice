import { buildFactorSignal, clamp } from './helpers.js'
import type { FactorSignal } from './types.js'

export interface CrossTimeframeDivergenceInput {
  return1hPct: number
  return6hPct: number
  return24hPct: number
  return7dPct: number
}

export function evaluateCrossTimeframeDivergence(
  input: CrossTimeframeDivergenceInput,
): FactorSignal {
  const shortTerm = input.return1hPct * 0.5 + input.return6hPct * 0.5
  const longTerm = input.return24hPct * 0.4 + input.return7dPct * 0.6
  const baselineSign = Math.sign(longTerm === 0 ? shortTerm : longTerm) || 1
  const divergence = baselineSign * (shortTerm - longTerm)
  const sameDirection =
    Math.sign(shortTerm) === Math.sign(longTerm) || shortTerm === 0 || longTerm === 0
  const rawValue = clamp(divergence / 10, -1, 1)
  const rawConfidence = clamp(
    Math.abs(shortTerm - longTerm) / 5 + (sameDirection ? 0 : 0.2),
    0,
    1,
  )

  return buildFactorSignal({
    name: 'cross-timeframe-divergence',
    rawValue,
    rawConfidence,
    metadata: {
      shortTerm,
      longTerm,
      divergence,
      sameDirection: sameDirection ? 1 : 0,
    },
  })
}
