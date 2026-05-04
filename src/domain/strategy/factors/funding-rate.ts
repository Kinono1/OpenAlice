import {
  buildFactorSignal,
  clamp,
  detectPeggedPercentileRegime,
  safeZScore,
  winsorizedPercentileRank,
} from './helpers.js'
import type { FactorSignal } from './types.js'

export interface FundingRateFactorInput {
  currentFundingRatePct: number
  rollingMeanPct: number
  rollingStdPct: number
  historyPct?: number[]
  peggedLookback?: number
  extremeRank?: number
}

export function evaluateFundingRateFactor(
  input: FundingRateFactorInput,
): FactorSignal {
  const zScore = safeZScore(
    input.currentFundingRatePct,
    input.rollingMeanPct,
    input.rollingStdPct,
  )
  const percentileRank = input.historyPct
    ? winsorizedPercentileRank(input.currentFundingRatePct, input.historyPct)
    : null
  const robustScore = percentileRank === null
    ? clamp(zScore / 3, -1, 1)
    : clamp((percentileRank - 0.5) * 2, -1, 1)
  const pegged = input.historyPct
    ? detectPeggedPercentileRegime({
        current: input.currentFundingRatePct,
        history: input.historyPct,
        lookback: input.peggedLookback,
        extremeRank: input.extremeRank,
      })
    : { pegged: false, direction: 0, consecutiveExtreme: 0 }
  const rawContrarianValue = clamp(-robustScore, -1, 1)
  const contrarianValue = pegged.pegged ? 0 : rawContrarianValue
  const confidence = pegged.pegged ? 0 : clamp(Math.abs(robustScore), 0, 1)

  return buildFactorSignal({
    name: 'funding-rate',
    rawValue: contrarianValue,
    rawConfidence: confidence,
    metadata: {
      currentFundingRatePct: input.currentFundingRatePct,
      rollingMeanPct: input.rollingMeanPct,
      rollingStdPct: input.rollingStdPct,
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
