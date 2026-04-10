import { describe, expect, it } from 'vitest'
import {
  combineFactorSignals,
  combineFactorSignalsWithGovernance,
  evaluateBasisFactor,
  evaluateCrossTimeframeDivergence,
  evaluateFundingRateFactor,
  evaluateLiquidationPressure,
  evaluateMeanReversion,
  evaluateMomentumComposite,
  evaluateVolatilityRegime,
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

  it('builds mean reversion as the sign-inverted momentum factor', () => {
    const signal = evaluateMeanReversion({
      return1hPct: 1,
      return6hPct: 2,
      return24hPct: 4,
      return7dPct: 8,
      realizedVolPct: 6,
    })

    expect(signal.value).toBeLessThan(0)
    expect(signal.confidence).toBeGreaterThan(0)
  })

  it('treats expanding stressed volatility as bearish', () => {
    const signal = evaluateVolatilityRegime({
      realizedVolPct: 18,
      previousRealizedVolPct: 8,
      volOfVolPct: 4,
      consecutiveHighVol: 10,
    })

    expect(signal.value).toBeLessThan(0)
    expect(signal.confidence).toBeGreaterThan(0.5)
  })

  it('treats crowded upside moves as liquidation pressure against trend', () => {
    const signal = evaluateLiquidationPressure({
      fundingRateZScore: 2.5,
      volumeSurgeStrength: 0.9,
      volExpansionScore: 0.8,
      priceReturnPct: 3,
    })

    expect(signal.value).toBeLessThan(0)
    expect(signal.confidence).toBeGreaterThan(0.5)
  })

  it('measures divergence between short and long timeframes', () => {
    const signal = evaluateCrossTimeframeDivergence({
      return1hPct: 2,
      return6hPct: 1,
      return24hPct: -3,
      return7dPct: -4,
    })

    expect(Math.abs(signal.value)).toBeGreaterThan(0)
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
