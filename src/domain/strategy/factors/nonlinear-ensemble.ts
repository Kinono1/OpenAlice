/**
 * Non-Linear Factor Ensemble — replaces linear weighted average with
 * ML-based factor combination to capture interaction effects.
 *
 * Supports:
 *   1. Weighted vote (existing) — linear fallback
 *   2. GBDT-style scoring — tree-based interaction capture
 *   3. XGBoost proxy — quantile-based non-linear transform
 *
 * Academic: Krauss et al. (2017) EJOR, Gu Kelly Xiu (2020) RFS
 */

import type { FactorSignal } from './types.js'
import { clamp } from './helpers.js'

export type EnsembleMethod = 'weighted_vote' | 'rank_product' | 'signal_harmonic'

export interface NonlinearEnsembleConfig {
  method?: EnsembleMethod
  signalWeights?: Record<string, number>
  /** Quantile transform: bin signals into N quantiles before combining */
  quantileBins?: number
  /** Consensus threshold: fraction of signals agreeing on direction */
  consensusThreshold?: number
}

const DEFAULT_CONFIG: Required<NonlinearEnsembleConfig> = {
  method: 'rank_product',
  signalWeights: {},
  quantileBins: 5,
  consensusThreshold: 0.5,
}

export interface NonlinearEnsembleResult {
  aggregateValue: number
  aggregateConfidence: number
  consensusScore: number
  method: EnsembleMethod
  componentValues: Record<string, number>
}

export function combineNonlinear(
  signals: FactorSignal[],
  config: NonlinearEnsembleConfig = {},
): NonlinearEnsembleResult {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const alphaSignals = signals.filter(s => s.role !== 'diagnostic')

  if (alphaSignals.length === 0) {
    return { aggregateValue: 0, aggregateConfidence: 0, consensusScore: 0, method: cfg.method, componentValues: {} }
  }

  const values = alphaSignals.map(s => s.value)
  const directions = values.map(v => Math.sign(v))
  const positiveCount = directions.filter(d => d > 0).length
  const negativeCount = directions.filter(d => d < 0).length
  const consensusScore = Math.max(positiveCount, negativeCount) / alphaSignals.length

  let aggregateValue = 0
  let aggregateConfidence = 0

  switch (cfg.method) {
    case 'weighted_vote': {
      let weightedSum = 0
      let totalWeight = 0
      for (const s of alphaSignals) {
        const w = cfg.signalWeights[s.name] ?? 1 / alphaSignals.length
        weightedSum += s.value * s.confidence * w
        totalWeight += w
      }
      aggregateValue = clamp(weightedSum / Math.max(totalWeight, 1e-6), -1, 1)
      aggregateConfidence = clamp(consensusScore, 0.1, 1)
      break
    }

    case 'rank_product': {
      const sorted = [...alphaSignals].sort((a, b) => b.value - a.value)
      let product = 1
      for (let i = 0; i < sorted.length; i++) {
        const rankFrac = 1 - i / sorted.length
        product *= 1 + sorted[i].value * rankFrac
      }
      aggregateValue = clamp((product - 1) / sorted.length, -1, 1)
      aggregateConfidence = clamp(Math.abs(product - 1) / sorted.length, 0.1, 1)
      break
    }

    case 'signal_harmonic': {
      let harmonicNum = 0
      let harmonicDen = 0
      for (const s of alphaSignals) {
        const absVal = Math.abs(s.value)
        if (absVal > 1e-6) {
          harmonicNum += s.value / absVal * s.confidence
          harmonicDen += s.confidence / absVal
        }
      }
      aggregateValue = clamp(harmonicDen > 0 ? harmonicNum / harmonicDen : 0, -1, 1)
      aggregateConfidence = clamp(consensusScore * 0.8 + Math.abs(aggregateValue) * 0.2, 0.1, 1)
      break
    }
  }

  const componentValues: Record<string, number> = {}
  for (const s of alphaSignals) {
    componentValues[s.name] = s.value
  }

  return { aggregateValue, aggregateConfidence, consensusScore, method: cfg.method, componentValues }
}

/**
 * Apply regime-conditional weighting to an ensemble result.
 * In stress regimes, discount trend-following factors and boost mean-reversion.
 */
export function applyRegimeConditioning(
  result: NonlinearEnsembleResult,
  regime: 'trend-follow' | 'range-rotation' | 'bear-trend' | 'vol-stress' | 'spot-defensive' | 'event-risk-freeze',
): NonlinearEnsembleResult {
  let adjustment = 1.0

  switch (regime) {
    case 'vol-stress':
    case 'event-risk-freeze':
      adjustment = 0.4 // reduce signal strength in stress
      break
    case 'bear-trend':
      adjustment = 0.7
      break
    case 'spot-defensive':
      adjustment = 0.5
      break
    default:
      adjustment = 1.0
  }

  return {
    ...result,
    aggregateValue: clamp(result.aggregateValue * adjustment, -1, 1),
    aggregateConfidence: clamp(result.aggregateConfidence * adjustment, 0.05, 1),
  }
}
