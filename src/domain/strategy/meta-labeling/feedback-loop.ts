import { clamp } from '../factors/helpers.js'

export type RegimeType = 'trending' | 'meanReverting' | 'stressed' | 'neutral'

export interface AdaptiveThresholdConfig {
  baseThreshold: number
  minThreshold: number
  maxThreshold: number
  regimeAdjustment: {
    trending: number
    meanReverting: number
    stressed: number
    neutral: number
  }
  performanceAdjustment: {
    lookbackTrades: number
    targetWinRate: number
    adjustmentStep: number
  }
}

export const DEFAULT_ADAPTIVE_THRESHOLD_CONFIG: AdaptiveThresholdConfig = {
  baseThreshold: 0.55,
  minThreshold: 0.4,
  maxThreshold: 0.85,
  regimeAdjustment: {
    trending: -0.10,
    meanReverting: -0.05,
    stressed: 0.20,
    neutral: 0,
  },
  performanceAdjustment: {
    lookbackTrades: 50,
    targetWinRate: 0.50,
    adjustmentStep: 0.05,
  },
}

export interface FeedbackMetrics {
  recentWinRate: number
  admissionScoreVsPnlCorrelation: number
  retrainRecommended: boolean
  sampleCount: number
}

export function computeDynamicThreshold(
  base: number,
  regime: RegimeType,
  recentWinRate: number,
  config: AdaptiveThresholdConfig = DEFAULT_ADAPTIVE_THRESHOLD_CONFIG,
  consecutiveLosses = 0,
): number {
  let threshold = base

  const regimeAdj = config.regimeAdjustment[regime] ?? 0
  threshold += regimeAdj

  if (recentWinRate < 0.40) {
    threshold += config.performanceAdjustment.adjustmentStep
  } else if (recentWinRate > 0.60) {
    threshold -= config.performanceAdjustment.adjustmentStep * 0.6
  }

  if (consecutiveLosses >= 3) {
    threshold += 0.1
  }

  return clamp(threshold, config.minThreshold, config.maxThreshold)
}

export function evaluateFeedbackMetrics(
  outcomes: Array<{ admissionScore: number; tripleBarrierLabel: 0 | 1; realizedReturnPct: number }>,
): FeedbackMetrics {
  if (outcomes.length === 0) {
    return {
      recentWinRate: 0.5,
      admissionScoreVsPnlCorrelation: 0,
      retrainRecommended: false,
      sampleCount: 0,
    }
  }

  const wins = outcomes.filter((o) => o.tripleBarrierLabel === 1).length
  const recentWinRate = wins / outcomes.length

  const scores = outcomes.map((o) => o.admissionScore)
  const returns = outcomes.map((o) => o.realizedReturnPct)
  const admissionScoreVsPnlCorrelation = pearsonCorrelation(scores, returns)

  const retrainRecommended = recentWinRate < 0.45 && outcomes.length >= 30

  return {
    recentWinRate,
    admissionScoreVsPnlCorrelation,
    retrainRecommended,
    sampleCount: outcomes.length,
  }
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length)
  if (n < 3) {
    return 0
  }
  const xSlice = x.slice(0, n)
  const ySlice = y.slice(0, n)

  const xMean = xSlice.reduce((s, v) => s + v, 0) / n
  const yMean = ySlice.reduce((s, v) => s + v, 0) / n

  let num = 0
  let dx2 = 0
  let dy2 = 0
  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - xMean
    const dy = ySlice[i] - yMean
    num += dx * dy
    dx2 += dx * dx
    dy2 += dy * dy
  }

  const denom = Math.sqrt(Math.max(dx2, 0) * Math.max(dy2, 0))
  return denom > 1e-12 ? num / denom : 0
}
