import { describe, expect, it } from 'vitest'
import {
  combineFactorSignals,
  combineFactorSignalsWithGovernance,
  evaluateBasisFactor,
  evaluateCrossTimeframeDivergence,
  evaluateFundingRateFactor,
  evaluateLiquidationAftermath,
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

  it('uses robust funding percentiles and disables contrarian signals during pegged funding', () => {
    const history = [
      ...Array.from({ length: 40 }, (_, index) => -0.02 + index * 0.001),
      0.1,
      0.11,
      0.12,
      0.13,
      0.14,
      0.15,
    ]
    const signal = evaluateFundingRateFactor({
      currentFundingRatePct: 0.16,
      rollingMeanPct: 0.01,
      rollingStdPct: 0.02,
      historyPct: history,
      peggedLookback: 4,
      extremeRank: 0.9,
    })

    expect(signal.value).toBe(0)
    expect(signal.confidence).toBe(0)
    expect(signal.metadata.peggedRegime).toBe(true)
    expect(signal.metadata.rawContrarianValue).toBeLessThan(0)
  })

  it('treats rich futures basis as contrarian bearish', () => {
    const signal = evaluateBasisFactor({
      futuresPrice: 105,
      spotPrice: 100,
      daysToExpiry: 30,
    })

    expect(signal.value).toBeLessThan(0)
  })

  it('uses robust basis percentiles and disables pegged basis mean reversion', () => {
    const history = [
      ...Array.from({ length: 40 }, (_, index) => -1 + index * 0.05),
      5,
      5.5,
      6,
      6.5,
      7,
      7.5,
    ]
    const signal = evaluateBasisFactor({
      futuresPrice: 102,
      spotPrice: 100,
      daysToExpiry: 90,
      historyPct: history,
      peggedLookback: 4,
      extremeRank: 0.9,
    })

    expect(signal.metadata.peggedRegime).toBe(true)
    expect(signal.value).toBe(0)
    expect(signal.confidence).toBe(0)
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

  it('bounds extreme crypto momentum with tanh t-stat normalization', () => {
    const signal = evaluateMomentumComposite({
      return1hPct: 25,
      return6hPct: 30,
      return24hPct: 45,
      return7dPct: 80,
      realizedVolPct: 40,
    })

    expect(signal.value).toBeLessThanOrEqual(1)
    expect(signal.value).toBeGreaterThan(0.9)
    expect(signal.metadata.tStat).toBeGreaterThan(3)
    expect(signal.metadata.volPenalty).toBeUndefined()
  })

  it('builds mean reversion from Bollinger z-score', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.1) * 5)
    closes[closes.length - 1] = 115
    const signal = evaluateMeanReversion({
      closes,
      seriesKind: 'stationary_spread',
    })

    expect(signal.name).toBe('mean-reversion')
    expect(signal.value).toBeLessThan(0)
    expect(signal.confidence).toBeGreaterThan(0)
  })

  it('does not trade raw-price mean reversion without a stationarity-safe series', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i)
    closes[closes.length - 1] = 170
    const signal = evaluateMeanReversion({ closes })

    expect(signal.role).toBe('diagnostic')
    expect(signal.value).toBe(0)
    expect(signal.confidence).toBe(0)
    expect(signal.metadata.reason).toBe('nonstationary_raw_price_disabled')
    expect(signal.metadata.rawMeanReversionSignal).toBeLessThan(0)
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

  it('excludes future liquidation rows from event thresholds and recent windows', () => {
    const now = 1_700_000_000_000
    const hourMs = 60 * 60 * 1000
    const history = Array.from({ length: 10 }, (_, index) => ({
      value: 100,
      timestampMs: now - (30 + index) * hourMs,
    }))
    history.push({
      value: 1_000_000,
      timestampMs: now + hourMs,
    })

    const signal = evaluateLiquidationAftermath({
      liquidationHistory: history,
      currentPrice: 100,
      return1hPct: 2,
      nowUtcMs: now,
    })

    expect(signal?.metadata.p90).toBe(100)
    expect(signal?.metadata.cumLiq24h).toBe(0)
    expect(signal?.metadata.isEvent).toBe(0)
  })

  it('uses cross-timeframe vol divergence as a conditioning filter, not directional alpha', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.3) * 3)
    closes[closes.length - 1] = 110
    closes[closes.length - 2] = 108
    const signal = evaluateCrossTimeframeDivergence({ closes })

    expect(signal.name).toBe('cross-timeframe-divergence')
    expect(signal.role).toBe('conditioning_filter')
    expect(signal.value).toBe(0)
    expect(signal.metadata.meanReversionPenalty).toBeGreaterThanOrEqual(0)
    expect(signal.metadata.momentumConfidenceModifier).toBeGreaterThanOrEqual(0.5)
  })

  it('does not let conditioning filters vote in the ensemble direction', () => {
    const filter = evaluateCrossTimeframeDivergence({
      closes: Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.3) * 3),
    })

    const ensemble = combineFactorSignals([filter])
    expect(ensemble.aggregateValue).toBe(0)
    expect(ensemble.weights['cross-timeframe-divergence']).toBe(0)
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
