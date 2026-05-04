import { buildFactorSignal } from './helpers.js'
import { evaluateBasisFactor } from './basis.js'
import { evaluateFundingRateFactor } from './funding-rate.js'
import type { FactorSignal } from './types.js'

export interface CarrySpreadInput {
  currentFundingRatePct?: number
  rollingFundingMeanPct?: number
  rollingFundingStdPct?: number
  fundingHistoryPct?: number[]
  basisInput?: {
    futuresPrice: number
    spotPrice: number
    daysToExpiry?: number
    historyPct?: number[]
  }
}

export function evaluateCarrySpread(input: CarrySpreadInput): FactorSignal | null {
  const hasFunding =
    typeof input.currentFundingRatePct === 'number' &&
    typeof input.rollingFundingMeanPct === 'number' &&
    typeof input.rollingFundingStdPct === 'number'
  const hasBasis = input.basisInput != null

  if (!hasFunding && !hasBasis) return null

  let fundingSignal = 0
  let fundingConfidence = 0
  let fundingZScore = 0
  let fundingPercentileRank: number | null = null
  let fundingPeggedRegime = false

  if (hasFunding) {
    const funding = evaluateFundingRateFactor({
      currentFundingRatePct: input.currentFundingRatePct!,
      rollingMeanPct: input.rollingFundingMeanPct!,
      rollingStdPct: input.rollingFundingStdPct!,
      historyPct: input.fundingHistoryPct,
    })
    fundingSignal = funding.value
    fundingConfidence = funding.confidence
    fundingZScore = numberMetadata(funding.metadata.zScore)
    fundingPercentileRank = nullableNumberMetadata(funding.metadata.percentileRank)
    fundingPeggedRegime = funding.metadata.peggedRegime === true
  }

  let basisSignal = 0
  let basisConfidence = 0
  let basisPct = 0
  let basisPercentileRank: number | null = null
  let basisPeggedRegime = false

  if (hasBasis) {
    const b = input.basisInput!
    const basis = evaluateBasisFactor({
      futuresPrice: b.futuresPrice,
      spotPrice: b.spotPrice,
      daysToExpiry: b.daysToExpiry,
      historyPct: b.historyPct,
    })
    basisSignal = basis.value
    basisConfidence = basis.confidence
    basisPct = numberMetadata(basis.metadata.basisPct)
    basisPercentileRank = nullableNumberMetadata(basis.metadata.percentileRank)
    basisPeggedRegime = basis.metadata.peggedRegime === true
  }

  const fundingWeight = hasFunding ? 0.65 : 0
  const basisWeight = hasBasis ? 0.35 : 0
  const totalWeight = fundingWeight + basisWeight

  const signal = totalWeight > 0
    ? (fundingSignal * fundingWeight + basisSignal * basisWeight) / totalWeight
    : 0
  const confidence = totalWeight > 0
    ? (fundingConfidence * fundingWeight + basisConfidence * basisWeight) / totalWeight
    : 0

  return buildFactorSignal({
    name: 'carry-spread',
    rawValue: signal,
    rawConfidence: confidence,
    metadata: {
      fundingZScore,
      fundingPercentileRank,
      fundingSignal,
      fundingConfidence,
      fundingPeggedRegime,
      basisPct,
      basisPercentileRank,
      basisSignal,
      basisConfidence,
      basisPeggedRegime,
      fundingWeight,
      basisWeight,
    },
  })
}

function numberMetadata(value: number | string | boolean | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function nullableNumberMetadata(value: number | string | boolean | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
