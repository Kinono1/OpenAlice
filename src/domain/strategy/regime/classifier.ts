import { clamp } from '../factors/helpers.js'
import type { HmmRegimeOutput } from './hmm/types.js'
import type { RegimeEvaluation, RegimeFeatures } from './types.js'

export interface RegimeClassifierOptions {
  hmm?: HmmRegimeOutput | null
  hmmConfidenceFloor?: number
}

export function mapHmmStateToMarketRegime(
  hmm: Pick<HmmRegimeOutput, 'state' | 'stateName' | 'stateIdentity'>,
): RegimeEvaluation['regime'] {
  const stateName = hmm.stateIdentity?.matchedStateName ?? hmm.stateName
  switch (stateName) {
    case 'bull':
      return 'trend-follow'
    case 'bear':
      return 'bear-trend'
    case 'calm':
      return 'range-rotation'
    case 'stress':
      return 'vol-stress'
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

  const volPercentile = resolveVolatilityPercentile(features)
  const volumeShock = typeof features.volumeChangeRate === 'number' && features.volumeChangeRate >= 2.5
  if (volPercentile >= 0.9 || volumeShock) {
    return {
      regime: 'vol-stress',
      confidence: clamp(Math.max(volPercentile, volumeShock ? 0.85 : 0), 0.3, 1),
      reasons: [
        volPercentile >= 0.9 ? 'realized volatility is in stress percentile' : 'volume shock is elevated',
      ],
      method: 'threshold',
    }
  }

  if (features.trendStrength >= 0.65 && volPercentile <= 0.75) {
    return {
      regime: 'trend-follow',
      confidence: clamp((features.trendStrength + (1 - volPercentile)) / 2, 0, 1),
      reasons: ['trend strength is high', 'realized volatility is controlled for crypto'],
      method: 'threshold',
    }
  }

  if (features.rangeCompressionScore >= 0.6 && volPercentile <= 0.45) {
    return {
      regime: 'range-rotation',
      confidence: clamp((features.rangeCompressionScore + (1 - volPercentile)) / 2, 0, 1),
      reasons: ['range compression is elevated', 'relative volatility is subdued'],
      method: 'threshold',
    }
  }

  return {
    regime: 'spot-defensive',
    confidence: clamp(volPercentile, 0.3, 1),
    reasons: ['trend is weak or relative volatility is elevated'],
    method: 'threshold',
  }
}

function resolveVolatilityPercentile(features: RegimeFeatures): number {
  if (
    typeof features.realizedVolPercentile === 'number' &&
    Number.isFinite(features.realizedVolPercentile)
  ) {
    return clamp(features.realizedVolPercentile, 0, 1)
  }

  // Crypto fallback: 40-80% annualized vol is ordinary, not automatically
  // defensive. Treat 20-100% as the broad normal-to-stress mapping until a
  // real rolling percentile is available.
  return clamp((features.realizedVolPct - 20) / 80, 0, 1)
}

export function evaluateRegime(
  features: RegimeFeatures,
  options: RegimeClassifierOptions = {},
): RegimeEvaluation {
  const threshold = evaluateThresholdRegime(features)
  if (threshold.regime === 'event-risk-freeze') {
    return { ...threshold, features }
  }

  if (!options.hmm) {
    return { ...threshold, features }
  }

  const confidenceFloor = options.hmmConfidenceFloor ?? 0.4
  if (options.hmm.method !== 'hmm' || options.hmm.confidence < confidenceFloor) {
    return {
      ...threshold,
      fallbackRegime: threshold.regime,
      hmm: options.hmm,
      features,
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
      ...(options.hmm.stateIdentity
        ? [
            `hmm identity ${options.hmm.stateIdentity.rawStateName}→${options.hmm.stateIdentity.matchedStateName}`,
          ]
        : []),
      ...options.hmm.reasons,
    ],
    method: 'hmm',
    fallbackRegime: threshold.regime,
    hmm: options.hmm,
    features,
  }
}
