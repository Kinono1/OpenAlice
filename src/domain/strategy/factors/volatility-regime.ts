import { buildFactorSignal, clamp } from './helpers.js'
import type { FactorSignal } from './types.js'

export interface VolatilityRegimeInput {
  realizedVolPct: number
  previousRealizedVolPct: number
  volOfVolPct: number
  volOfVolNormPct?: number
  consecutiveHighVol: number
  componentWeights?: {
    volExpansion: number
    volClustering: number
    volOfVol: number
  }
}

export const DEFAULT_VOLATILITY_REGIME_COMPONENT_WEIGHTS = {
  volExpansion: 1 / 3,
  volClustering: 1 / 3,
  volOfVol: 1 / 3,
} as const

export function evaluateVolatilityRegime(
  input: VolatilityRegimeInput,
): FactorSignal {
  const weights = input.componentWeights ?? DEFAULT_VOLATILITY_REGIME_COMPONENT_WEIGHTS
  const volExpansion = clamp(
    (input.realizedVolPct / Math.max(input.previousRealizedVolPct, 1e-6) - 1) / 2,
    -1,
    1,
  )
  const volClustering = clamp(input.consecutiveHighVol / 12, 0, 1)
  const volOfVolScore = clamp(
    input.volOfVolPct / Math.max(input.volOfVolNormPct ?? 5, 1e-6),
    0,
    1,
  )
  const stressScore =
    weights.volExpansion * Math.max(volExpansion, 0) +
    weights.volClustering * volClustering +
    weights.volOfVol * volOfVolScore
  const rawValue = clamp(-stressScore, -1, 1)
  const rawConfidence = clamp(
    (Math.abs(volExpansion) + volClustering + volOfVolScore) / 3,
    0,
    1,
  )

  return buildFactorSignal({
    name: 'volatility-regime',
    rawValue,
    rawConfidence,
    metadata: {
      realizedVolPct: input.realizedVolPct,
      previousRealizedVolPct: input.previousRealizedVolPct,
      volOfVolPct: input.volOfVolPct,
      volExpansion,
      volClustering,
      volOfVolScore,
      stressScore,
      weightVolExpansion: weights.volExpansion,
      weightVolClustering: weights.volClustering,
      weightVolOfVol: weights.volOfVol,
    },
  })
}
