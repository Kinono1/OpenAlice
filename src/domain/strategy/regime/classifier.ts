import { clamp } from '../factors/helpers.js'
import type { RegimeEvaluation, RegimeFeatures } from './types.js'

export function evaluateRegime(features: RegimeFeatures): RegimeEvaluation {
  if (features.eventWindowFrozen) {
    return {
      regime: 'event-risk-freeze',
      confidence: 1,
      reasons: ['macro event freeze is active'],
    }
  }

  if (features.trendStrength >= 0.65 && features.realizedVolPct <= 12) {
    return {
      regime: 'trend-follow',
      confidence: clamp(features.trendStrength, 0, 1),
      reasons: ['trend strength is high', 'realized volatility is controlled'],
    }
  }

  if (features.rangeCompressionScore >= 0.6 && features.realizedVolPct <= 10) {
    return {
      regime: 'range-rotation',
      confidence: clamp((features.rangeCompressionScore + (1 - features.realizedVolPct / 20)) / 2, 0, 1),
      reasons: ['range compression is elevated', 'volatility is subdued'],
    }
  }

  return {
    regime: 'spot-defensive',
    confidence: clamp(features.realizedVolPct / 20, 0.3, 1),
    reasons: ['trend is weak or volatility is elevated'],
  }
}
