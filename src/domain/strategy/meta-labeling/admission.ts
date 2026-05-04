import { clamp } from '../factors/helpers.js'
import type { RuntimeFactorSnapshot } from '../runtime-evaluator.js'
import type { MetaLabelAdmissionSummary } from '../runtime-types.js'
import { buildMetaLabelFeatureVector } from './feature-builder.js'
import { computeDynamicThreshold, DEFAULT_ADAPTIVE_THRESHOLD_CONFIG } from './feedback-loop.js'
import type { RegimeType } from './feedback-loop.js'

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

export function evaluateMetaLabelAdmission(input: {
  snapshot: RuntimeFactorSnapshot
  minConfidenceToTrade: number
  enforcementMode?: 'shadow_only' | 'gate'
  adaptiveThresholdFeedback?: {
    recentWinRate: number
    sampleCount: number
  }
}): MetaLabelAdmissionSummary {
  const enforcementMode = input.enforcementMode ?? 'shadow_only'
  const staticThreshold = clamp(input.minConfidenceToTrade, 0, 1)
  const features = buildMetaLabelFeatureVector({ snapshot: input.snapshot }).record
  const adaptiveRegime = inferAdaptiveRegime(features)
  const feedback = input.adaptiveThresholdFeedback
  const hasFeedback =
    feedback != null &&
    feedback.sampleCount > 0 &&
    Number.isFinite(feedback.recentWinRate)
  const dynamicThreshold = hasFeedback
    ? computeDynamicThreshold(
        staticThreshold,
        adaptiveRegime,
        feedback.recentWinRate,
        DEFAULT_ADAPTIVE_THRESHOLD_CONFIG,
      )
    : staticThreshold
  const threshold = roundScore(Math.max(staticThreshold, dynamicThreshold))

  const ensembleConfidence = clamp(features['ensemble-confidence'] ?? 0, 0, 1)
  const governanceScore = clamp((features['governance-total-score'] ?? 0) / 100, 0, 1)
  const sourceQuality = clamp((features['source-quality-score'] ?? 0) / 25, 0, 1)
  const executionClarity = clamp((features['execution-clarity-score'] ?? 0) / 10, 0, 1)
  const regimeConfidence = clamp(
    Math.max(features['regime-confidence'] ?? 0, features['hmm-confidence'] ?? 0),
    0,
    1,
  )
  const consensusScore = clamp(features['consensus-score'] ?? 0, 0, 1)

  let score =
    ensembleConfidence * 0.35
    + governanceScore * 0.25
    + sourceQuality * 0.1
    + executionClarity * 0.15
    + regimeConfidence * 0.1
    + consensusScore * 0.05

  const reasons: string[] = []
  const stressProb = clamp(features['hmm-stress-prob'] ?? 0, 0, 1)
  if (stressProb > 0.25) {
    score *= 1 - stressProb * 0.35
    reasons.push(`stress-regime penalty ${stressProb.toFixed(2)}`)
  }

  if (input.snapshot.governance.staleDataApplied) {
    score *= 0.7
    reasons.push('stale-data penalty applied')
  }

  if (features['freeze-active'] > 0.5) {
    score *= 0.5
    reasons.push('event-freeze penalty applied')
  }

  if (!input.snapshot.positionSizing.allowed) {
    score *= 0.6
    reasons.push('position-sizing penalty applied')
  }

  const normalizedScore = roundScore(clamp(score, 0, 1))
  const admitted = normalizedScore >= threshold
  if (!admitted) {
    reasons.unshift(`meta-label score ${normalizedScore.toFixed(2)} below threshold ${threshold.toFixed(2)}`)
  } else {
    reasons.unshift(`meta-label score ${normalizedScore.toFixed(2)} cleared threshold ${threshold.toFixed(2)}`)
  }

  return {
    enabled: true,
    enforcementMode,
    score: normalizedScore,
    threshold,
    staticThreshold,
    dynamicThreshold: roundScore(dynamicThreshold),
    effectiveThreshold: threshold,
    adaptiveThresholdStatus: hasFeedback ? 'active' : 'fallback_static',
    primaryObjective: 'outperform_skip_after_cost',
    canControlLiveLeverage: false,
    admitted,
    reasons,
  }
}

function inferAdaptiveRegime(features: Record<string, number>): RegimeType {
  const stressProb = clamp(features['hmm-stress-prob'] ?? 0, 0, 1)
  if (stressProb > 0.25) return 'stressed'

  const trendStrength = Math.max(
    features['trend-strength'] ?? 0,
    features['volatility-trend-strength'] ?? 0,
  )
  if (trendStrength > 0.5) return 'trending'

  const meanReversion = Math.max(
    features['mean-reversion-score'] ?? 0,
    features['mean-reversion-confidence'] ?? 0,
  )
  if (meanReversion > 0.5) return 'meanReverting'

  return 'neutral'
}
