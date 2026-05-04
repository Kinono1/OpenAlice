import { describe, expect, it } from 'vitest'
import {
  benjaminiHochberg,
  benjaminiYekutieli,
  runFdrCorrection,
  runLedgerBoundFdrCorrection,
} from './fdr.js'

describe('benjaminiHochberg', () => {
  it('computes monotonic q-values in original order', () => {
    const result = benjaminiHochberg([0.03, 0.001, 0.2, 0.07], 0.1)

    expect(result).toHaveLength(4)
    expect(result[1].qValue).toBeLessThanOrEqual(result[3].qValue)
    expect(result[3].qValue).toBeLessThanOrEqual(result[2].qValue)
    expect(result.every((item) => item.qValue >= 0 && item.qValue <= 1)).toBe(
      true,
    )
  })

  it('marks items with q <= alpha as passed', () => {
    const result = benjaminiHochberg([0.001, 0.01, 0.4], 0.05)
    const passed = result.filter((item) => item.passed)

    expect(passed.length).toBe(2)
    expect(passed.every((item) => item.qValue <= 0.05)).toBe(true)
  })

  it('throws on invalid input', () => {
    expect(() => benjaminiHochberg([], 0.1)).toThrow(
      'pValues must be a non-empty array.',
    )
    expect(() => benjaminiHochberg([0.1], 2)).toThrow(
      'alpha must be in (0, 1].',
    )
    expect(() => benjaminiHochberg([1.2], 0.1)).toThrow(
      'pValues[0] must be within [0, 1].',
    )
  })
})

describe('benjaminiYekutieli', () => {
  it('is at least as conservative as BH on the same inputs', () => {
    const bh = benjaminiHochberg([0.01, 0.02, 0.04], 0.1)
    const by = benjaminiYekutieli([0.01, 0.02, 0.04], 0.1)

    expect(by).toHaveLength(bh.length)
    expect(by.every((item, index) => item.qValue >= bh[index].qValue)).toBe(
      true,
    )
  })
})

describe('runFdrCorrection', () => {
  it('returns BY diagnostics and q-values', () => {
    const result = runFdrCorrection({
      pValues: [0.01, 0.02, 0.04],
      alpha: 0.1,
      method: 'by',
    })

    expect(result.diagnostics.method).toBe('by')
    expect(result.diagnostics.harmonicFactorCm).toBeGreaterThan(1)
    expect(result.items).toHaveLength(3)
  })

  it('aggregates cv_storey_bh from window p-values', () => {
    const result = runFdrCorrection({
      pValues: [0.4, 0.5],
      alpha: 0.1,
      method: 'cv_storey_bh',
      cvAggQuantile: 0.9,
      storeyLambda: 0.5,
      windowPValuesByCandidate: [
        [0.02, 0.03, 0.04, 0.05],
        [0.2, 0.3, 0.4, 0.5],
      ],
    })

    expect(result.diagnostics.method).toBe('cv_storey_bh')
    expect(result.diagnostics.storeyLambda).toBe(0.5)
    expect(result.diagnostics.cvAggQuantile).toBe(0.9)
    expect(result.diagnostics.candidateWindowCounts).toEqual([4, 4])
    expect(result.effectivePValues[0]).toBe(0.05)
    expect(result.effectivePValues[1]).toBe(0.5)
    expect(result.items[0].qValue).toBeLessThanOrEqual(result.items[1].qValue)
  })

  it('throws on invalid methodology parameters', () => {
    expect(() =>
      runFdrCorrection({
        pValues: [0.1, 0.2],
        method: 'cv_storey_bh',
        cvAggQuantile: 1,
      }),
    ).toThrow('cvAggQuantile must be in (0, 1).')
    expect(() =>
      runFdrCorrection({
        pValues: [0.1, 0.2],
        method: 'cv_storey_bh',
        storeyLambda: 0,
      }),
    ).toThrow('storeyLambda must be in (0, 1).')
  })

  it('computes stepc diagnostics and monotonic combined p-values', () => {
    const result = runFdrCorrection({
      pValues: [0.01, 0.015, 0.4],
      alpha: 0.1,
      method: 'stepc',
    })

    expect(result.diagnostics.method).toBe('stepc')
    expect(result.diagnostics.approximation).toContain('stepwise_cauchy')
    expect(result.diagnostics.orderedPValues).toEqual([0.01, 0.015, 0.4])
    expect(result.diagnostics.stepcCombinedPValues?.length).toBe(3)
    expect(result.diagnostics.selectionCutoff).toBeGreaterThanOrEqual(1)
    expect(result.items[0].qValue).toBeLessThanOrEqual(result.items[2].qValue)
  })

  it('passes SPA benchmark metadata through diagnostics', () => {
    const result = runFdrCorrection({
      pValues: [1, 0.03, 0.4],
      alpha: 0.1,
      method: 'spa',
      benchmarkStrategyId: 'BTC_BENCH',
      benchmarkStrategyIndex: 0,
    })

    expect(result.diagnostics.method).toBe('spa')
    expect(result.diagnostics.benchmarkStrategyId).toBe('BTC_BENCH')
    expect(result.diagnostics.benchmarkStrategyIndex).toBe(0)
    expect(result.items[1].passed).toBe(true)
    expect(result.items[0].passed).toBe(false)
  })

  it('passes SPA block sensitivity diagnostics through unchanged', () => {
    const spaBootstrapDiagnostics = {
      bootstrapDirectionStable: false,
      unstableBootstrapCandidateIndexes: [1],
      blockSizeSet: [4, 8, 16],
      blockSensitivityByCandidate: [
        {
          candidateIndex: 0,
          blockSensitivity: [
            { blockSize: 4, observedMeanExcess: 0, pValue: 1, passed: false },
            { blockSize: 8, observedMeanExcess: 0, pValue: 1, passed: false },
            { blockSize: 16, observedMeanExcess: 0, pValue: 1, passed: false },
          ],
          bootstrapDirectionStable: true,
          unstableBootstrap: false,
        },
        {
          candidateIndex: 1,
          blockSensitivity: [
            { blockSize: 4, observedMeanExcess: 0.01, pValue: 0.03, passed: true },
            { blockSize: 8, observedMeanExcess: 0.01, pValue: 0.09, passed: true },
            { blockSize: 16, observedMeanExcess: 0.01, pValue: 0.14, passed: false },
          ],
          bootstrapDirectionStable: false,
          unstableBootstrap: true,
        },
      ],
    }

    const result = runFdrCorrection({
      pValues: [1, 0.09],
      alpha: 0.1,
      method: 'spa',
      spaBootstrapDiagnostics,
    })

    expect(result.diagnostics.bootstrapDirectionStable).toBe(false)
    expect(result.diagnostics.unstableBootstrapCandidateIndexes).toEqual([1])
    expect(result.diagnostics.blockSizeSet).toEqual([4, 8, 16])
    expect(result.diagnostics.blockSensitivityByCandidate).toEqual(
      spaBootstrapDiagnostics.blockSensitivityByCandidate,
    )
  })

  it('rejects stale or mismatched SPA bootstrap diagnostics', () => {
    const validSensitivity = [
      {
        candidateIndex: 0,
        blockSensitivity: [
          { blockSize: 4, observedMeanExcess: 0, pValue: 1, passed: false },
          { blockSize: 8, observedMeanExcess: 0, pValue: 1, passed: false },
        ],
        bootstrapDirectionStable: true,
        unstableBootstrap: false,
      },
      {
        candidateIndex: 1,
        blockSensitivity: [
          { blockSize: 4, observedMeanExcess: 0.01, pValue: 0.03, passed: true },
          { blockSize: 8, observedMeanExcess: 0.01, pValue: 0.09, passed: true },
        ],
        bootstrapDirectionStable: true,
        unstableBootstrap: false,
      },
    ]

    expect(() => runFdrCorrection({
      pValues: [1, 0.09],
      method: 'spa',
      spaBootstrapDiagnostics: {
        bootstrapDirectionStable: true,
        unstableBootstrapCandidateIndexes: [],
        blockSizeSet: [4, 8],
        blockSensitivityByCandidate: [validSensitivity[0]],
      },
    })).toThrow('spaBootstrapDiagnostics.blockSensitivityByCandidate length must match pValues length.')
    expect(() => runFdrCorrection({
      pValues: [1, 0.09],
      method: 'spa',
      spaBootstrapDiagnostics: {
        bootstrapDirectionStable: true,
        unstableBootstrapCandidateIndexes: [],
        blockSizeSet: [4, 8],
        blockSensitivityByCandidate: [
          validSensitivity[0],
          { ...validSensitivity[1], candidateIndex: 2 },
        ],
      },
    })).toThrow('candidateIndex is out of range')
    expect(() => runFdrCorrection({
      pValues: [1, 0.09],
      method: 'spa',
      spaBootstrapDiagnostics: {
        bootstrapDirectionStable: true,
        unstableBootstrapCandidateIndexes: [],
        blockSizeSet: [4, 16],
        blockSensitivityByCandidate: validSensitivity,
      },
    })).toThrow('blockSensitivity block sizes must match blockSizeSet')
    expect(() => runFdrCorrection({
      pValues: [1, 0.09],
      method: 'spa',
      spaBootstrapDiagnostics: {
        bootstrapDirectionStable: false,
        unstableBootstrapCandidateIndexes: [2],
        blockSizeSet: [4, 8],
        blockSensitivityByCandidate: validSensitivity,
      },
    })).toThrow('unstableBootstrapCandidateIndexes[0] is out of range')
  })
})

describe('runLedgerBoundFdrCorrection', () => {
  const completeLedger = {
    rawM: 5,
    effectiveM: 3,
    rawMComplete: true,
    includesFailedTrials: true,
    failedTrialCount: 2,
    survivingTrialCount: 3,
    fdrMethodPrimary: 'BY_raw_m',
  } as const

  it('runs BY FDR only when the raw trial ledger is complete', () => {
    const result = runLedgerBoundFdrCorrection({
      pValues: [0.01, 0.03, 0.2],
      alpha: 0.1,
      trialLedger: completeLedger,
    })

    expect(result.diagnostics.method).toBe('by')
    expect(result.diagnostics.candidateCount).toBe(3)
    expect(result.items).toHaveLength(3)
  })

  it('rejects survivor-only or non-BY FDR inputs before computing q-values', () => {
    expect(() => runLedgerBoundFdrCorrection({
      pValues: [0.01, 0.03],
      trialLedger: {
        ...completeLedger,
        rawMComplete: false,
      },
    })).toThrow('trialLedger.rawMComplete must be true for ledger-bound FDR.')

    expect(() => runLedgerBoundFdrCorrection({
      pValues: [0.01, 0.03],
      trialLedger: {
        ...completeLedger,
        includesFailedTrials: false,
      },
    })).toThrow('trialLedger.includesFailedTrials must be true for ledger-bound FDR.')

    expect(() => runLedgerBoundFdrCorrection({
      pValues: [0.01, 0.03],
      trialLedger: {
        ...completeLedger,
        fdrMethodPrimary: 'BH_secondary',
      },
    })).toThrow('trialLedger.fdrMethodPrimary must be BY_raw_m for ledger-bound FDR.')

    expect(() => runLedgerBoundFdrCorrection({
      pValues: [0.01, 0.03],
      method: 'spa',
      trialLedger: completeLedger,
    })).toThrow('ledger-bound FDR must use BY_raw_m; set method to by or omit it.')
  })

  it('rejects trial ledgers that cannot cover the p-value universe', () => {
    expect(() => runLedgerBoundFdrCorrection({
      pValues: [0.01, 0.02, 0.03],
      trialLedger: {
        ...completeLedger,
        rawM: 2,
      },
    })).toThrow('trialLedger.rawM must be >= pValues length for ledger-bound FDR.')

    expect(() => runLedgerBoundFdrCorrection({
      pValues: [0.01],
      trialLedger: {
        ...completeLedger,
        failedTrialCount: 4,
        survivingTrialCount: 2,
      },
    })).toThrow('trialLedger failed + surviving counts must not exceed rawM.')
  })
})
