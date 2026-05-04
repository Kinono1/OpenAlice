import {
  buildFactorSignal,
  clamp,
  detectPeggedPercentileRegime,
  safeZScore,
  winsorizedPercentileRank,
} from './helpers.js'
import type { FactorSignal } from './types.js'

export interface BasisFactorInput {
  futuresPrice: number
  spotPrice: number
  daysToExpiry?: number
  rollingMeanPct?: number
  rollingStdPct?: number
  historyPct?: number[]
  peggedLookback?: number
  extremeRank?: number
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
  const percentileRank = input.historyPct
    ? winsorizedPercentileRank(basisPct, input.historyPct)
    : null
  const robustScore = percentileRank === null
    ? clamp(zScore / 3, -1, 1)
    : clamp((percentileRank - 0.5) * 2, -1, 1)
  const pegged = input.historyPct
    ? detectPeggedPercentileRegime({
        current: basisPct,
        history: input.historyPct,
        lookback: input.peggedLookback,
        extremeRank: input.extremeRank,
      })
    : { pegged: false, direction: 0, consecutiveExtreme: 0 }
  const rawContrarianValue = clamp(-robustScore, -1, 1)
  const contrarianValue = pegged.pegged ? 0 : rawContrarianValue
  const confidence = pegged.pegged ? 0 : clamp(Math.abs(robustScore), 0, 1)

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
      percentileRank,
      robustScore,
      rawContrarianValue,
      peggedRegime: pegged.pegged,
      pegDirection: pegged.direction,
      consecutiveExtreme: pegged.consecutiveExtreme,
    },
  })
}
