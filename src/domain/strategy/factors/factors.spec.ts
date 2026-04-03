import { describe, expect, it } from 'vitest'
import {
  combineFactorSignals,
  combineFactorSignalsWithGovernance,
  evaluateBasisFactor,
  evaluateFundingRateFactor,
  evaluateMomentumComposite,
  evaluateVolumeSurgeFactor,
} from './index.js'

describe('strategy factors', () => {
  it('treats extreme positive funding as contrarian bearish', () => {
    const signal = evaluateFundingRateFactor({
      currentFundingRatePct: 0.15,
      rollingMeanPct: 0.02,
      rollingStdPct: 0.03,
    })

    expect(signal.value).toBeLessThan(0)
    expect(signal.confidence).toBeGreaterThan(0)
  })

  it('treats rich futures basis as contrarian bearish', () => {
    const signal = evaluateBasisFactor({
      futuresPrice: 105,
      spotPrice: 100,
      daysToExpiry: 30,
    })

    expect(signal.value).toBeLessThan(0)
  })

  it('detects bullish volume surge when price and volume jump together', () => {
    const signal = evaluateVolumeSurgeFactor({
      currentVolume: 300,
      averageVolume: 100,
      priceReturnPct: 6,
    })

    expect(signal.value).toBeGreaterThan(0)
    expect(signal.confidence).toBeGreaterThan(0.5)
  })

  it('computes positive composite momentum for aligned uptrend returns', () => {
    const signal = evaluateMomentumComposite({
      return1hPct: 1,
      return6hPct: 2,
      return24hPct: 4,
      return7dPct: 8,
      realizedVolPct: 6,
    })

    expect(signal.value).toBeGreaterThan(0)
    expect(signal.confidence).toBeGreaterThan(0)
  })

  it('reduces ensemble confidence when signals conflict', () => {
    const bullish = evaluateMomentumComposite({
      return1hPct: 1,
      return6hPct: 2,
      return24hPct: 4,
      return7dPct: 6,
    })
    const bearish = evaluateFundingRateFactor({
      currentFundingRatePct: 0.15,
      rollingMeanPct: 0.02,
      rollingStdPct: 0.03,
    })

    const ensemble = combineFactorSignals([bullish, bearish])
    expect(ensemble.consensusScore).toBeLessThan(1)
  })

  it('can project factor ensemble into governance', () => {
    const bullish = evaluateMomentumComposite({
      return1hPct: 1,
      return6hPct: 2,
      return24hPct: 4,
      return7dPct: 8,
    })
    const volume = evaluateVolumeSurgeFactor({
      currentVolume: 250,
      averageVolume: 100,
      priceReturnPct: 7,
    })

    const result = combineFactorSignalsWithGovernance(
      [bullish, volume],
      {
        sourceTier: 'L2',
        useType: 'U1',
        sentiment: 'S0',
      },
    )

    expect(result.aggregateValue).toBeGreaterThan(0)
    expect(result.governance.actionStatus).not.toBe('no-trade')
  })
})
