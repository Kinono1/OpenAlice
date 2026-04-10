import { clamp } from '../factors/helpers.js'
import type { HmmRegimeOutput } from './hmm/types.js'
import type { RegimeEvaluation, RegimeFeatures } from './types.js'

export interface RegimeClassifierOptions {
  hmm?: HmmRegimeOutput | null
  hmmConfidenceFloor?: number
}

export function mapHmmStateToMarketRegime(
  hmm: Pick<HmmRegimeOutput, 'state' | 'stateName'>,
): RegimeEvaluation['regime'] {
  if (hmm.state === 0) {
    return 'trend-follow'
  }
  if (hmm.state === 2) {
    return 'range-rotation'
  }
  return 'spot-defensive'
}

function evaluateThresholdRegime(features: RegimeFeatures): RegimeEvaluation {
  if (features.eventWindowFrozen) {
    return {
      regime: 'event-risk-freeze',
      confidence: 1,
      reasons: ['macro event freeze is active'],
      method: 'threshold',
    }
  }

  if (features.trendStrength >= 0.65 && features.realizedVolPct <= 12) {
    return {
      regime: 'trend-follow',
      confidence: clamp(features.trendStrength, 0, 1),
      reasons: ['trend strength is high', 'realized volatility is controlled'],
      method: 'threshold',
    }
  }

  if (features.rangeCompressionScore >= 0.6 && features.realizedVolPct <= 10) {
    return {
      regime: 'range-rotation',
      confidence: clamp((features.rangeCompressionScore + (1 - features.realizedVolPct / 20)) / 2, 0, 1),
      reasons: ['range compression is elevated', 'volatility is subdued'],
      method: 'threshold',
    }
  }

  return {
    regime: 'spot-defensive',
    confidence: clamp(features.realizedVolPct / 20, 0.3, 1),
    reasons: ['trend is weak or volatility is elevated'],
    method: 'threshold',
  }
}

export function evaluateRegime(
  features: RegimeFeatures,
  options: RegimeClassifierOptions = {},
): RegimeEvaluation {
  const threshold = evaluateThresholdRegime(features)
  if (threshold.regime === 'event-risk-freeze') {
    return threshold
  }

  if (!options.hmm) {
    return threshold
  }

  const confidenceFloor = options.hmmConfidenceFloor ?? 0.4
  if (options.hmm.method !== 'hmm' || options.hmm.confidence < confidenceFloor) {
    return {
      ...threshold,
      fallbackRegime: threshold.regime,
      hmm: options.hmm,
      reasons: [
        ...threshold.reasons,
        `hmm confidence ${options.hmm.confidence.toFixed(2)} below floor`,
      ],
    }
  }

  const regime = mapHmmStateToMarketRegime(options.hmm)
  return {
    regime,
    confidence: clamp(options.hmm.confidence, 0, 1),
    reasons: [
      `hmm state ${options.hmm.stateName} selected`,
      ...options.hmm.reasons,
    ],
    method: 'hmm',
    fallbackRegime: threshold.regime,
    hmm: options.hmm,
  }
}
