import { buildFactorSignal, clamp, safeZScore } from './helpers.js'
import type { FactorSignal } from './types.js'

export interface BasisFactorInput {
  futuresPrice: number
  spotPrice: number
  daysToExpiry?: number
  rollingMeanPct?: number
  rollingStdPct?: number
}

function computeBasisPct(input: BasisFactorInput): number {
  const rawBasis = (input.futuresPrice / input.spotPrice - 1) * 100
  if (typeof input.daysToExpiry === 'number' && input.daysToExpiry > 0) {
    return rawBasis * (365 / input.daysToExpiry)
  }
  return rawBasis
}

export function evaluateBasisFactor(input: BasisFactorInput): FactorSignal {
  const basisPct = computeBasisPct(input)
  const zScore =
    typeof input.rollingMeanPct === 'number' &&
    typeof input.rollingStdPct === 'number'
      ? safeZScore(basisPct, input.rollingMeanPct, input.rollingStdPct)
      : basisPct / 5
  const contrarianValue = clamp(-zScore / 3, -1, 1)
  const confidence = clamp(Math.abs(zScore) / 3, 0, 1)

  return buildFactorSignal({
    name: 'basis',
    rawValue: contrarianValue,
    rawConfidence: confidence,
    metadata: {
      basisPct,
      futuresPrice: input.futuresPrice,
      spotPrice: input.spotPrice,
      daysToExpiry: input.daysToExpiry ?? 0,
      zScore,
    },
  })
}
