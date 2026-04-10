import { buildFactorSignal, clamp, safeZScore } from './helpers.js'
import type { FactorSignal } from './types.js'

export interface FundingRateFactorInput {
  currentFundingRatePct: number
  rollingMeanPct: number
  rollingStdPct: number
}

export function evaluateFundingRateFactor(
  input: FundingRateFactorInput,
): FactorSignal {
  const zScore = safeZScore(
    input.currentFundingRatePct,
    input.rollingMeanPct,
    input.rollingStdPct,
  )
  const contrarianValue = clamp(-zScore / 3, -1, 1)
  const confidence = clamp(Math.abs(zScore) / 3, 0, 1)

  return buildFactorSignal({
    name: 'funding-rate',
    rawValue: contrarianValue,
    rawConfidence: confidence,
    metadata: {
      currentFundingRatePct: input.currentFundingRatePct,
      rollingMeanPct: input.rollingMeanPct,
      rollingStdPct: input.rollingStdPct,
      zScore,
    },
  })
}
