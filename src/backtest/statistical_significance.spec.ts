import { describe, expect, it } from 'vitest'
import {
  buildTrialLedgerSummary,
  computeSpaLikePValues,
  computeDeflatedSharpe,
  estimatePboCscv,
  evaluateSignificanceGate,
} from './statistical_significance'

function repeat(value: number, count: number): number[] {
  return Array.from({ length: count }, () => value)
}

describe('statistical_significance', () => {
  it('defaults trial-ledger completeness to fail-closed unless explicitly declared', () => {
    expect(buildTrialLedgerSummary({
      rawM: 10,
      survivingTrialCount: 2,
    })).toMatchObject({
      rawMComplete: false,
      includesFailedTrials: false,
      failedTrialCount: 8,
      survivingTrialCount: 2,
      fdrMethodPrimary: 'BY_raw_m',
    })

    expect(buildTrialLedgerSummary({
      rawM: 10,
      survivingTrialCount: 2,
      rawMComplete: true,
      includesFailedTrials: true,
    })).toMatchObject({
      rawMComplete: true,
      includesFailedTrials: true,
    })
  })

  it('estimates PBO from CSCV splits', () => {
    const candidateReturns = [
      [...repeat(0.015, 64), ...repeat(-0.015, 64)],
      repeat(0.003, 128),
      repeat(0.002, 128),
    ]

    const result = estimatePboCscv({
      candidateReturns,
      partitions: 8,
    })

    expect(result.splitsEvaluated).toBeGreaterThan(0)
    expect(result.pbo).toBeGreaterThanOrEqual(0)
    expect(result.pbo).toBeLessThanOrEqual(1)
    expect(result.logits.length).toBe(result.splitsEvaluated)
  })

  it('computes deflated sharpe and yields positive dsrValue for robust returns', () => {
    const returns = Array.from({ length: 240 }, (_, i) => 0.002 + ((i % 9) - 4) * 0.0002)

    const result = computeDeflatedSharpe({
      returns,
      trialCount: 20,
    })

    expect(result.observedSharpe).toBeGreaterThan(0)
    expect(result.dsrValue).toBeGreaterThan(0)
    expect(result.dsrProbability).toBeGreaterThan(0.5)
    expect(result.diagnosticQuality).toBe('ok')
  })

  it('nulls DSR probability for low independent-bet samples', () => {
    const returns = Array.from({ length: 50 }, (_, i) => 0.0015 + ((i % 7) - 3) * 0.00015)

    const result = computeDeflatedSharpe({
      returns,
      trialCount: 1,
    })

    expect(result.observedSharpe).toBeGreaterThan(0)
    expect(result.dsrProbability).toBeNull()
    expect(result.diagnosticQuality).toBe('low_sample')
    expect(result.independentBets).toBe(50)
    expect(result.minimumIndependentBets).toBe(100)
    expect(result.promotionEligible).toBe(false)
    expect(result.blockedReason).toBe('independent_bets_below_100')
  })

  it('clamps single-candidate trialCount to support donor-only lanes when independent bets are sufficient', () => {
    const returns = Array.from({ length: 240 }, (_, i) => 0.0015 + ((i % 7) - 3) * 0.00015)

    const result = computeDeflatedSharpe({
      returns,
      trialCount: 1,
    })

    expect(result.observedSharpe).toBeGreaterThan(0)
    expect(result.dsrProbability).not.toBeNull()
    expect(result.dsrProbability).toBeGreaterThanOrEqual(0)
    expect(result.dsrProbability).toBeLessThanOrEqual(1)
  })

  it('uses sample variance for Sharpe estimates', () => {
    const result = computeDeflatedSharpe({
      returns: [1, 2, 3, 4],
      trialCount: 2,
      minimumIndependentBets: 4,
    })

    expect(result.observedSharpe).toBeCloseTo(1.9364916731037085, 12)
  })

  it('fails gate when adjusted sharpe is not positive', () => {
    const candidateReturns = [
      Array.from({ length: 128 }, (_, i) => ((i % 2 === 0 ? 1 : -1) * 0.002)),
      repeat(-0.001, 128),
    ]

    const selectedReturns = repeat(-0.0015, 128)

    const gate = evaluateSignificanceGate({
      candidateReturns,
      selectedReturns,
      partitions: 8,
      trialCount: 10,
      pboThreshold: 0.9,
      dsrMin: 0,
    })

    expect(gate.passed).toBe(false)
    expect(gate.dsrResult.dsrValue).toBeLessThanOrEqual(0)
    expect(gate.dsrResult.dsrProbability).not.toBeNull()
  })

  it('gates deflated Sharpe on DSR probability', () => {
    const selectedReturns = Array.from(
      { length: 128 },
      (_, i) => 0.001 + ((i % 5) - 2) * 0.0001,
    )

    const gate = evaluateSignificanceGate({
      candidateReturns: [
        selectedReturns,
        selectedReturns.map((value) => value * 0.8),
      ],
      selectedReturns,
      partitions: 8,
      trialCount: 10,
      pboThreshold: 1,
      dsrMin: 0.5,
    })

    expect(gate.dsrResult.dsrProbability).toBeGreaterThan(0.5)
    expect(gate.passed).toBe(true)
  })

  it('uses a conservative PBO fallback for single-candidate lanes', () => {
    const selectedReturns = Array.from(
      { length: 128 },
      (_, i) => 0.001 + ((i % 5) - 2) * 0.0001,
    )

    const gate = evaluateSignificanceGate({
      candidateReturns: [selectedReturns],
      selectedReturns,
      partitions: 8,
      trialCount: 1,
      pboThreshold: 0.9,
      dsrMin: 0,
    })

    expect(gate.pboResult.pbo).toBe(1)
    expect(gate.pboResult.splitsEvaluated).toBe(0)
    expect(gate.passed).toBe(false)
  })

  it('computes benchmark-aware SPA-like p-values', () => {
    const benchmark = Array.from(
      { length: 128 },
      (_, i) => 0.001 + ((i % 7) - 3) * 0.0001,
    )
    const superior = benchmark.map((value, index) => value + 0.0008 + (index % 3) * 0.00005)
    const inferior = benchmark.map((value, index) => value - 0.0006 - (index % 5) * 0.00003)

    const result = computeSpaLikePValues({
      candidateReturns: [benchmark, superior, inferior],
      benchmarkIndex: 0,
      bootstrapSamples: 120,
      blockSize: 8,
    })

    expect(result.items).toHaveLength(3)
    expect(result.items[0].pValue).toBe(1)
    expect(result.items[1].observedMeanExcess).toBeGreaterThan(0)
    expect(result.items[1].pValue).toBeLessThan(0.1)
    expect(result.items[2].observedMeanExcess).toBeLessThan(0)
    expect(result.items[2].pValue).toBe(1)
  })

  it('reports SPA block-size sensitivity around the primary block size', () => {
    const benchmark = Array.from(
      { length: 128 },
      (_, i) => 0.001 + ((i % 7) - 3) * 0.0001,
    )
    const superior = benchmark.map((value, index) => value + 0.0008 + (index % 3) * 0.00005)
    const inferior = benchmark.map((value, index) => value - 0.0006 - (index % 5) * 0.00003)

    const result = computeSpaLikePValues({
      candidateReturns: [benchmark, superior, inferior],
      benchmarkIndex: 0,
      bootstrapSamples: 120,
      blockSize: 8,
      alpha: 0.1,
    })

    expect(result.blockSize).toBe(8)
    expect(result.alpha).toBe(0.1)
    expect(result.blockSizeSet).toEqual([4, 8, 16])
    expect(typeof result.bootstrapDirectionStable).toBe('boolean')
    expect(Array.isArray(result.unstableBootstrapCandidateIndexes)).toBe(true)

    for (const item of result.items) {
      expect(item.blockSensitivity).toHaveLength(3)
      expect(item.blockSensitivity.map((entry) => entry.blockSize)).toEqual([4, 8, 16])
      for (const sensitivity of item.blockSensitivity) {
        expect(sensitivity.pValue).toBeGreaterThanOrEqual(0)
        expect(sensitivity.pValue).toBeLessThanOrEqual(1)
        expect(typeof sensitivity.passed).toBe('boolean')
      }
      expect(typeof item.bootstrapDirectionStable).toBe('boolean')
      expect(item.unstableBootstrap).toBe(!item.bootstrapDirectionStable)
    }
  })

  it('keeps the primary SPA block size in sensitivity when caller overrides the set', () => {
    const benchmark = repeat(0.001, 64)
    const superior = benchmark.map((value, index) => value + 0.0006 + (index % 4) * 0.00001)

    const result = computeSpaLikePValues({
      candidateReturns: [benchmark, superior],
      benchmarkIndex: 0,
      bootstrapSamples: 80,
      blockSize: 8,
      blockSizeSet: [4, 12],
      alpha: 0.1,
    })

    expect(result.blockSizeSet).toEqual([4, 8, 12])
    expect(result.items[1].blockSensitivity.map((entry) => entry.blockSize)).toEqual([4, 8, 12])
  })
})
