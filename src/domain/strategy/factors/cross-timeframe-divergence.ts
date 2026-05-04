import { buildFactorSignal, clamp } from './helpers.js'
import type { FactorSignal } from './types.js'

export interface CrossTimeframeDivergenceInput {
  closes: number[]
  shortWindow?: number
  longWindow?: number
}

const DEFAULT_SHORT_WINDOW = 6
const DEFAULT_LONG_WINDOW = 48

export function evaluateCrossTimeframeDivergence(
  input: CrossTimeframeDivergenceInput,
): FactorSignal {
  const shortWindow = input.shortWindow ?? DEFAULT_SHORT_WINDOW
  const longWindow = input.longWindow ?? DEFAULT_LONG_WINDOW
  const closes = input.closes

  if (closes.length < longWindow + 2) {
    return buildFactorSignal({
      name: 'cross-timeframe-divergence',
      rawValue: 0,
      rawConfidence: 0,
      metadata: { reason: 'insufficient_data', barsAvailable: closes.length },
    })
  }

  const shortVol = realizedVol(closes, shortWindow)
  const longVol = realizedVol(closes, longWindow)

  if (longVol < 1e-12) {
    return buildFactorSignal({
      name: 'cross-timeframe-divergence',
      rawValue: 0,
      rawConfidence: 0,
      metadata: { shortVol, longVol, ratio: 0 },
    })
  }

  const ratio = shortVol / longVol
  const expansion = Math.max(0, ratio - 1)
  const meanReversionPenalty = clamp(1 - expansion / 2, 0, 1)
  const momentumConfidenceModifier = ratio >= 1
    ? clamp(1 - Math.max(0, ratio - 2) / 4, 0.5, 1)
    : clamp(0.75 + ratio / 4, 0.5, 1)
  const confidence = clamp(Math.abs(ratio - 1), 0, 1)

  return buildFactorSignal({
    name: 'cross-timeframe-divergence',
    role: 'conditioning_filter',
    rawValue: 0,
    rawConfidence: confidence,
    metadata: {
      shortVol,
      longVol,
      ratio,
      shortWindow,
      longWindow,
      meanReversionPenalty,
      momentumConfidenceModifier,
    },
  })
}

function realizedVol(closes: number[], window: number): number {
  const slice = closes.slice(-window - 1)
  if (slice.length < 2) return 0
  const returns: number[] = []
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1]
    returns.push(prev > 0 ? (slice[i] - prev) / prev : 0)
  }
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length
  return Math.sqrt(Math.max(variance, 0)) * Math.sqrt(24 * 365) * 100
}
