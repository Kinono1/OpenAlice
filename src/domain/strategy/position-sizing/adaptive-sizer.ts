import { clamp } from '../factors/helpers.js'
import { fractionalKelly } from './kelly.js'
import { volatilityTargetSize } from './volatility-target.js'

export interface AdaptiveSizerInput {
  targetVolPct: number
  currentVolPct: number
  volOfVolPct?: number
  maxPctOfEquity: number
  kellyFraction: number
  winRate: number
  avgWinLossRatio: number
  ensembleConfidence: number
  sampleCount?: number
}

export interface AdaptiveSizerResult {
  recommendedPct: number
  volTargetPct: number
  kellyPct: number
  method: 'adaptive'
}

export function computeAdaptiveSize(input: AdaptiveSizerInput): AdaptiveSizerResult {
  const volTargetPct = volatilityTargetSize(
    input.targetVolPct,
    Math.max(input.currentVolPct, 0.0001),
    input.maxPctOfEquity,
    input.volOfVolPct,
  )

  const kellyPct = fractionalKelly(
    input.winRate,
    input.avgWinLossRatio,
    input.kellyFraction,
    input.kellyFraction,
    input.sampleCount,
  )

  const basePct = Math.min(volTargetPct, kellyPct)
  const confidence = clamp(input.ensembleConfidence, 0, 1)
  const recommendedPct = clamp(basePct * confidence, 0, input.maxPctOfEquity)

  return { recommendedPct, volTargetPct, kellyPct, method: 'adaptive' }
}
