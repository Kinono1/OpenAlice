import { buildFactorSignal, clamp } from './helpers.js'
import type { FactorSignal } from './types.js'

export interface LiquidationPressureInput {
  fundingRateZScore: number
  volumeSurgeStrength: number
  volExpansionScore: number
  priceReturnPct: number
  openInterestPressure?: number
  componentWeights?: {
    fundingPressure: number
    cascadePressure: number
    openInterestPressure: number
  }
}

export const DEFAULT_LIQUIDATION_PRESSURE_COMPONENT_WEIGHTS = {
  fundingPressure: 1 / 3,
  cascadePressure: 1 / 3,
  openInterestPressure: 1 / 3,
} as const

export function evaluateLiquidationPressure(
  input: LiquidationPressureInput,
): FactorSignal {
  const weights = input.componentWeights ?? DEFAULT_LIQUIDATION_PRESSURE_COMPONENT_WEIGHTS
  const fundingPressure =
    clamp(Math.abs(input.fundingRateZScore) / 3, 0, 1) *
    (input.fundingRateZScore >= 0 ? -1 : 1)
  const cascadePressure =
    clamp(input.volumeSurgeStrength * input.volExpansionScore, 0, 1) *
    (input.priceReturnPct >= 0 ? -1 : 1)
  const openInterestPressure = clamp(input.openInterestPressure ?? 0, -1, 1)
  const rawValue = clamp(
    weights.fundingPressure * fundingPressure +
      weights.cascadePressure * cascadePressure +
      weights.openInterestPressure * openInterestPressure,
    -1,
    1,
  )
  const rawConfidence = clamp(
    (Math.abs(fundingPressure) + Math.abs(cascadePressure) + Math.abs(openInterestPressure)) / 3,
    0,
    1,
  )

  return buildFactorSignal({
    name: 'liquidation-pressure',
    rawValue,
    rawConfidence,
    metadata: {
      fundingRateZScore: input.fundingRateZScore,
      fundingPressure,
      volumeSurgeStrength: input.volumeSurgeStrength,
      volExpansionScore: input.volExpansionScore,
      cascadePressure,
      openInterestPressure,
      weightFundingPressure: weights.fundingPressure,
      weightCascadePressure: weights.cascadePressure,
      weightOpenInterestPressure: weights.openInterestPressure,
    },
  })
}
