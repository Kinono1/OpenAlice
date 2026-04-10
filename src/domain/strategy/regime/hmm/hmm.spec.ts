import { describe, expect, it } from 'vitest'
import { trainBaumWelch } from './baum-welch.js'
import { studentTLogPdf } from './emissions.js'
import { calibrateStateConditionedFactorWeights } from './factor-weights.js'
import { runForwardBackward } from './forward-backward.js'
import { extractHmmObservations } from './observation-buffer.js'
import { RegimeHmm } from './regime-hmm.js'
import { DEFAULT_HMM_PARAMS, type HmmObservation } from './types.js'
import { decodeViterbiPath } from './viterbi.js'

function makeObservations(count: number): HmmObservation[] {
  return Array.from({ length: count }, (_, index) => {
    const phase = index % 4
    if (phase === 0) {
      return { return1h: 0.8, realizedVol: -0.4, volumeChangeRate: 0.1 }
    }
    if (phase === 1) {
      return { return1h: -0.7, realizedVol: 0.5, volumeChangeRate: 0.2 }
    }
    if (phase === 2) {
      return { return1h: 0, realizedVol: -0.6, volumeChangeRate: -0.2 }
    }
    return { return1h: -0.1, realizedVol: 1.2, volumeChangeRate: 1.1 }
  })
}

function makeCandles(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-02-${String((index % 28) + 1).padStart(2, '0')}`,
    open: 100 + index * 0.4,
    high: 100.5 + index * 0.4,
    low: 99.5 + index * 0.4,
    close: 100 + index * 0.45 + Math.sin(index / 6),
    volume: 1000 + (index % 7) * 90,
  }))
}

describe('strategy regime hmm', () => {
  it('keeps student-t log-pdf finite and centered around the mean', () => {
    const atMean = studentTLogPdf(0, 0, 1, 5)
    const offMean = studentTLogPdf(3, 0, 1, 5)

    expect(Number.isFinite(atMean)).toBe(true)
    expect(atMean).toBeGreaterThan(offMean)
  })

  it('normalizes forward-backward probabilities', () => {
    const result = runForwardBackward(makeObservations(12), DEFAULT_HMM_PARAMS)
    expect(result.gamma).toHaveLength(12)
    result.gamma.forEach((row) => {
      const total = row.reduce((sum, value) => sum + value, 0)
      expect(total).toBeCloseTo(1, 6)
    })
  })

  it('decodes a viterbi path for the full sequence', () => {
    const result = decodeViterbiPath(makeObservations(10), DEFAULT_HMM_PARAMS)
    expect(result.path).toHaveLength(10)
    expect(Number.isFinite(result.logLikelihood)).toBe(true)
  })

  it('runs a bounded Baum-Welch update without losing probability mass', () => {
    const trained = trainBaumWelch(makeObservations(32), DEFAULT_HMM_PARAMS, {
      coldStartMode: 'regularized_em',
      maxIterations: 3,
      regularization: 1e-4,
      tolerance: 1e-4,
    })

    expect(trained.params.transitionMatrix).toHaveLength(4)
    trained.params.transitionMatrix.forEach((row) => {
      expect(row.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6)
    })
  })

  it('extracts z-scored observations from candles', () => {
    const observations = extractHmmObservations(makeCandles(60), {
      realizedVolWindow: 24,
      volumeBaselineWindow: 24,
      zScoreWindow: 32,
    })

    expect(observations).toHaveLength(59)
    expect(Number.isFinite(observations[10].return1h)).toBe(true)
    expect(Number.isFinite(observations[10].realizedVol)).toBe(true)
    expect(Number.isFinite(observations[10].volumeChangeRate)).toBe(true)
  })

  it('falls back to threshold mode when observations are scarce', () => {
    const output = new RegimeHmm().classify(makeObservations(12))
    expect(output?.method).toBe('threshold')
    expect(output?.coldStartMode).toBe('threshold_only')
  })

  it('applies state-conditioned factor weights', () => {
    const conditioned = calibrateStateConditionedFactorWeights({
      baseWeights: {
        'momentum-composite': 1,
        'volume-surge': 1,
      },
      hmmOutput: {
        state: 0,
        stateName: 'bull',
        stateProbs: [0.8, 0.1, 0.05, 0.05],
        confidence: 0.8,
        logLikelihood: -10,
        anomaly: false,
        reasons: [],
        method: 'hmm',
        coldStartMode: 'standard_em',
        effectiveSampleSize: 300,
      },
    })

    expect(conditioned.weights['momentum-composite']).toBeGreaterThan(1)
    expect(conditioned.weights['volume-surge']).toBeLessThan(1)
  })
})
