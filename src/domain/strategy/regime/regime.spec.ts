import { describe, expect, it } from 'vitest'
import { evaluateRegime, evaluateRegimeTransition } from './index.js'

describe('strategy regime', () => {
  it('classifies event freeze as highest priority regime', () => {
    const result = evaluateRegime({
      trendStrength: 0.9,
      realizedVolPct: 8,
      rangeCompressionScore: 0.2,
      eventWindowFrozen: true,
    })

    expect(result.regime).toBe('event-risk-freeze')
  })

  it('classifies high-trend / low-vol environments as trend-follow', () => {
    const result = evaluateRegime({
      trendStrength: 0.8,
      realizedVolPct: 9,
      rangeCompressionScore: 0.2,
    })

    expect(result.regime).toBe('trend-follow')
  })

  it('does not force normal crypto volatility into defensive mode', () => {
    const result = evaluateRegime({
      trendStrength: 0.82,
      realizedVolPct: 55,
      rangeCompressionScore: 0.2,
    })

    expect(result.regime).toBe('trend-follow')
  })

  it('classifies relative volatility stress before trend-follow', () => {
    const result = evaluateRegime({
      trendStrength: 0.9,
      realizedVolPct: 65,
      realizedVolPercentile: 0.94,
      rangeCompressionScore: 0.2,
    })

    expect(result.regime).toBe('vol-stress')
  })

  it('classifies compressed low-vol markets as range-rotation', () => {
    const result = evaluateRegime({
      trendStrength: 0.3,
      realizedVolPct: 8,
      rangeCompressionScore: 0.8,
    })

    expect(result.regime).toBe('range-rotation')
  })

  it('downgrades trend tickets when moving into defensive regime', () => {
    const decision = evaluateRegimeTransition('trend-follow', 'spot-defensive')
    expect(decision.action).toBe('downgrade')
  })

  it('uses hmm state when confidence clears the floor', () => {
    const result = evaluateRegime(
      {
        trendStrength: 0.2,
        realizedVolPct: 14,
        rangeCompressionScore: 0.2,
      },
      {
        hmm: {
          state: 0,
          stateName: 'bull',
          stateProbs: [0.78, 0.08, 0.08, 0.06],
          confidence: 0.78,
          logLikelihood: -12,
          anomaly: false,
          reasons: ['state stabilized'],
          method: 'hmm',
          coldStartMode: 'standard_em',
          effectiveSampleSize: 240,
        },
      },
    )

    expect(result.regime).toBe('trend-follow')
    expect(result.method).toBe('hmm')
    expect(result.fallbackRegime).toBe('spot-defensive')
  })

  it('maps HMM bear and stress states to directional regimes', () => {
    const baseFeatures = {
      trendStrength: 0.2,
      realizedVolPct: 45,
      rangeCompressionScore: 0.2,
    }

    const bear = evaluateRegime(baseFeatures, {
      hmm: {
        state: 1,
        stateName: 'bear',
        stateProbs: [0.05, 0.8, 0.05, 0.1],
        confidence: 0.8,
        logLikelihood: -10,
        anomaly: false,
        reasons: [],
        method: 'hmm',
        coldStartMode: 'standard_em',
        effectiveSampleSize: 300,
      },
    })
    const stress = evaluateRegime(baseFeatures, {
      hmm: {
        state: 3,
        stateName: 'stress',
        stateProbs: [0.05, 0.1, 0.05, 0.8],
        confidence: 0.8,
        logLikelihood: -10,
        anomaly: true,
        reasons: [],
        method: 'hmm',
        coldStartMode: 'standard_em',
        effectiveSampleSize: 300,
      },
    })

    expect(bear.regime).toBe('bear-trend')
    expect(stress.regime).toBe('vol-stress')
  })

  it('uses Wasserstein HMM identity when raw state index drifts', () => {
    const result = evaluateRegime(
      {
        trendStrength: 0.8,
        realizedVolPct: 45,
        rangeCompressionScore: 0.2,
      },
      {
        hmm: {
          state: 0,
          rawState: 0,
          stateName: 'bull',
          stateProbs: [0.05, 0.08, 0.07, 0.8],
          confidence: 0.8,
          logLikelihood: -10,
          anomaly: true,
          reasons: [],
          method: 'hmm',
          coldStartMode: 'standard_em',
          effectiveSampleSize: 300,
          stateIdentity: {
            method: 'wasserstein_template',
            rawState: 0,
            rawStateName: 'bull',
            matchedState: 3,
            matchedStateName: 'stress',
            wassersteinDistance: 0.1,
            identityConfidence: 0.9,
            activeStateCount: 2,
            canonicalStateProbs: [0.05, 0.08, 0.07, 0.8],
            rawToCanonicalState: [3, 0, 1, 2],
          },
        },
      },
    )

    expect(result.regime).toBe('vol-stress')
    expect(result.reasons.some((reason) => reason.includes('hmm identity bull→stress'))).toBe(true)
  })

  it('falls back to threshold regime on low-confidence hmm output', () => {
    const result = evaluateRegime(
      {
        trendStrength: 0.2,
        realizedVolPct: 8,
        rangeCompressionScore: 0.85,
      },
      {
        hmm: {
          state: 0,
          stateName: 'bull',
          stateProbs: [0.34, 0.28, 0.2, 0.18],
          confidence: 0.34,
          logLikelihood: -20,
          anomaly: false,
          reasons: ['uncertain state'],
          method: 'hmm',
          coldStartMode: 'regularized_em',
          effectiveSampleSize: 200,
        },
      },
    )

    expect(result.regime).toBe('range-rotation')
    expect(result.method).toBe('threshold')
  })
})
