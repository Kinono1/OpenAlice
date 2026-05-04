import { describe, expect, it } from 'vitest'
import { evaluateRuntimeFactorSnapshot } from './runtime-evaluator.js'
import type { StrategyConfig } from '../../core/config.js'
import { DEFAULT_REGIME_HMM_CONFIG } from './regime/index.js'

function makeCandles(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 1000 + index * 10,
  }))
}

const baseConfig: StrategyConfig = {
  enabled: true,
  governance: {
    useGovernanceGate: true,
    staleDataCapsExecution: true,
    preferReduceOnWeakSignal: false,
  },
  runtime: {
    marketScope: 'crypto',
    runtimeIntegrationEnabled: false,
  },
  eventCalendar: {
    enabled: true,
    events: [],
  },
  factors: {
    fundingRate: { enabled: true, weight: 1 },
    basis: { enabled: true, weight: 1 },
    volumeSurge: { enabled: true, weight: 1 },
    momentumComposite: { enabled: true, weight: 1 },
    meanReversion: { enabled: true, weight: 1 },
    volatilityRegime: { enabled: true, weight: 1 },
    liquidationPressure: { enabled: true, weight: 1 },
    crossTimeframeDivergence: { enabled: true, weight: 1 },
  },
  positionSizing: {
    enabled: true,
    method: 'fixed',
    defaultAssetLayer: 'core',
    targetVolPct: 10,
    maxPctOfEquity: 0.3,
    kellyFraction: 0.15,
    layerConfigs: [
      {
        layer: 'core',
        maxPositions: 5,
        maxPositionPctOfEquity: 0.3,
        minActionStatusToTrade: 'probe',
        requiresCoreNotRiskOff: false,
      },
      {
        layer: 'extended',
        maxPositions: 3,
        maxPositionPctOfEquity: 0.15,
        minActionStatusToTrade: 'attack-lite',
        requiresCoreNotRiskOff: true,
      },
      {
        layer: 'watch-only',
        maxPositions: 1,
        maxPositionPctOfEquity: 0.05,
        minActionStatusToTrade: 'attack',
        requiresCoreNotRiskOff: true,
      },
    ],
  },
  metaLabeling: {
    enabled: false,
    enforcementMode: 'shadow_only',
    upperBarrierPct: 2,
    lowerBarrierPct: 1,
    maxHoldingBars: 24,
    minConfidenceToTrade: 0.55,
  },
}

describe('strategy runtime evaluator', () => {
  it('builds factor signals from runtime market data', () => {
    const result = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: makeCandles(48),
      strategyConfig: baseConfig,
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: 0.08,
    })

    expect(result.factorSignals.length).toBeGreaterThanOrEqual(3)
    expect(result.governance.actionStatus).toBeTruthy()
    expect(result.derivedMetrics.return24hPct).toBeGreaterThan(0)
    expect(result.ensemble.weights['momentum-composite']).toBe(1)
    expect(result.positionSizing.recommendedPctOfEquity).toBeGreaterThan(0)
  })

  it('evaluates mean reversion independently when momentum is disabled', () => {
    const result = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: makeCandles(48),
      strategyConfig: {
        ...baseConfig,
        factors: {
          fundingRate: { enabled: false, weight: 0 },
          basis: { enabled: false, weight: 0 },
          volumeSurge: { enabled: false, weight: 0 },
          momentumComposite: { enabled: false, weight: 0 },
          meanReversion: { enabled: true, weight: 1.5 },
          volatilityRegime: { enabled: false, weight: 0 },
          liquidationPressure: { enabled: false, weight: 0 },
          crossTimeframeDivergence: { enabled: false, weight: 0 },
        },
      },
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
    })

    expect(result.factorSignals.map((signal) => signal.name)).toEqual([
      'mean-reversion',
    ])
    expect(result.ensemble.weights['momentum-composite']).toBeUndefined()
    expect(result.ensemble.weights['mean-reversion']).toBe(1.5)
  })

  it('caps governance during active freeze windows', () => {
    const result = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: makeCandles(48),
      strategyConfig: {
        ...baseConfig,
        eventCalendar: {
          enabled: true,
          events: [
            {
              name: 'CPI',
              releaseTimeUtc: Date.now() + 30 * 60_000,
              severity: 'high',
              marketScope: ['crypto'],
              freezeRule: {
                preFreezeHours: 2,
                postFreezeHours: 1,
                maxActionDuringFreeze: 'reduce',
              },
            },
          ],
        },
      },
      sourceTier: 'L1',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: -0.12,
    })

    expect(result.freeze.active).toBe(true)
    expect(['reduce', 'exit', 'no-trade', 'hold']).toContain(result.governance.actionStatus)
  })

  it('honors factor enable flags and weights from strategy config', () => {
    const result = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: makeCandles(48),
      strategyConfig: {
        ...baseConfig,
        factors: {
          fundingRate: { enabled: false, weight: 0 },
          basis: { enabled: false, weight: 0 },
          volumeSurge: { enabled: true, weight: 0.2 },
          momentumComposite: { enabled: true, weight: 2 },
          meanReversion: { enabled: false, weight: 0 },
          volatilityRegime: { enabled: false, weight: 0 },
          liquidationPressure: { enabled: false, weight: 0 },
          crossTimeframeDivergence: { enabled: false, weight: 0 },
        },
      },
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: 0.2,
    })

    expect(result.factorSignals.map((signal) => signal.name)).toEqual([
      'momentum-composite',
      'volume-surge',
    ])
    expect(result.ensemble.weights['momentum-composite']).toBe(2)
    expect(result.ensemble.weights['volume-surge']).toBe(0.2)
    expect(result.ensemble.weights['funding-rate']).toBeUndefined()
  })

  it('normalizes funding-rate with rolling history instead of a fixed divisor', () => {
    const result = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: makeCandles(48),
      strategyConfig: {
        ...baseConfig,
        factors: {
          fundingRate: { enabled: true, weight: 1 },
          basis: { enabled: false, weight: 0 },
          volumeSurge: { enabled: false, weight: 0 },
          momentumComposite: { enabled: false, weight: 0 },
          meanReversion: { enabled: false, weight: 0 },
          volatilityRegime: { enabled: false, weight: 0 },
          liquidationPressure: { enabled: false, weight: 0 },
          crossTimeframeDivergence: { enabled: false, weight: 0 },
        },
      },
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: 0.06,
      fundingRateHistoryPct: [0.02, 0.04, 0.06],
    })

    const fundingSignal = result.factorSignals.find((signal) => signal.name === 'funding-rate')
    expect(fundingSignal).toBeTruthy()
    expect(fundingSignal?.metadata.rollingMeanPct).toBeCloseTo(0.04, 6)
    expect(fundingSignal?.metadata.rollingStdPct).toBeCloseTo(0.01632993, 6)
    expect(fundingSignal?.value).toBeCloseTo(-0.408248, 6)
    expect(result.ensemble.weights['funding-rate']).toBe(1)
  })

  it('uses carry-spread as the funding/basis replacement when both legs are available', () => {
    const result = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USDT:USDT',
      candles: makeCandles(48),
      strategyConfig: {
        ...baseConfig,
        factors: {
          fundingRate: { enabled: true, weight: 1 },
          basis: { enabled: true, weight: 1 },
          volumeSurge: { enabled: false, weight: 0 },
          momentumComposite: { enabled: false, weight: 0 },
          meanReversion: { enabled: false, weight: 0 },
          volatilityRegime: { enabled: false, weight: 0 },
          liquidationPressure: { enabled: false, weight: 0 },
          crossTimeframeDivergence: { enabled: false, weight: 0 },
        },
      },
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: 0.06,
      fundingRateHistoryPct: [0.02, 0.04, 0.06],
      basisInput: {
        futuresPrice: 102,
        spotPrice: 100,
      },
    })

    expect(result.factorSignals.map((signal) => signal.name)).toEqual(['carry-spread'])
    expect(result.ensemble.weights['carry-spread']).toBe(1)
    expect(result.ensemble.weights['funding-rate']).toBeUndefined()
    expect(result.ensemble.weights.basis).toBeUndefined()
  })

  it('rolls IC monitor state through snapshots without same-timestamp signal/return pairing', () => {
    const hourMs = 60 * 60 * 1000
    const baseTime = 1_700_000_000_000
    const icMonitorConfig = {
      enabled: true,
      mode: 'shadow' as const,
      icHorizons: [1],
      lookbackWindows: [24],
      minSamples: 5,
      minSampleCount: 5,
      warmupWindows: 1,
      decayThresholds: {
        meanIcFloor: 0.03,
        icIrFloor: 0.5,
        signStabilityFloor: 0.6,
      },
      autoDisable: true,
    }
    let icMonitorSnapshot = undefined

    for (let index = 0; index < 8; index += 1) {
      const snapshot = evaluateRuntimeFactorSnapshot({
        symbol: 'BTC/USD',
        candles: makeCandles(48 + index),
        strategyConfig: {
          ...baseConfig,
          factors: {
            fundingRate: { enabled: false, weight: 0 },
            basis: { enabled: false, weight: 0 },
            volumeSurge: { enabled: false, weight: 0 },
            momentumComposite: { enabled: true, weight: 1 },
            meanReversion: { enabled: false, weight: 0 },
            volatilityRegime: { enabled: false, weight: 0 },
            liquidationPressure: { enabled: false, weight: 0 },
            crossTimeframeDivergence: { enabled: false, weight: 0 },
          },
        },
        sourceTier: 'L2',
        useType: 'U1',
        sentiment: 'S0',
        nowUtcMs: baseTime + index * hourMs,
        icMonitorConfig,
        icMonitorSnapshot,
      })
      icMonitorSnapshot = snapshot.icMonitorSnapshot
    }

    expect(icMonitorSnapshot?.signals).toHaveLength(8)
    expect(icMonitorSnapshot?.returns).toHaveLength(8)
    expect(icMonitorSnapshot?.signals[7]?.timestamp).toBe(baseTime + 7 * hourMs)
    expect(icMonitorSnapshot?.returns[7]?.timestamp).toBe(baseTime + 7 * hourMs)
    expect(icMonitorSnapshot?.signals[7]?.symbol).toBe('BTC/USD')
    expect(icMonitorSnapshot?.returns[7]?.symbol).toBe('BTC/USD')
  })

  it('feeds open-interest crowding into liquidation pressure only when OI data exists', () => {
    const strategyConfig: StrategyConfig = {
      ...baseConfig,
      factors: {
        fundingRate: { enabled: false, weight: 0 },
        basis: { enabled: false, weight: 0 },
        volumeSurge: { enabled: true, weight: 1 },
        momentumComposite: { enabled: false, weight: 0 },
        meanReversion: { enabled: false, weight: 0 },
        volatilityRegime: { enabled: false, weight: 0 },
        liquidationPressure: { enabled: true, weight: 1 },
        crossTimeframeDivergence: { enabled: false, weight: 0 },
      },
    }

    const withOpenInterest = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: makeCandles(48),
      strategyConfig,
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      openInterest: 1000,
      openInterestValue: 5_000_000,
    })

    const withoutOpenInterest = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: makeCandles(48),
      strategyConfig,
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
    })

    const withSignal = withOpenInterest.factorSignals.find((signal) => signal.name === 'liquidation-pressure')
    const withoutSignal = withoutOpenInterest.factorSignals.find((signal) => signal.name === 'liquidation-pressure')

    expect(withSignal).toBeTruthy()
    expect(withSignal?.metadata.openInterestPressure).toBeLessThan(0)
    expect(withSignal?.metadata.weightOpenInterestPressure).toBeGreaterThan(0)
    expect(withOpenInterest.ensemble.weights['liquidation-pressure']).toBe(1)

    expect(withoutSignal).toBeTruthy()
    expect(withoutSignal?.metadata.openInterestPressure).toBe(0)
    expect(withoutSignal?.metadata.weightOpenInterestPressure).toBe(0)
    expect(withoutOpenInterest.ensemble.weights['liquidation-pressure']).toBeCloseTo(2 / 3, 6)
  })

  it('computes kelly-driven position recommendation when equity is available', () => {
    const result = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: makeCandles(48),
      strategyConfig: {
        ...baseConfig,
        positionSizing: {
          ...baseConfig.positionSizing,
          method: 'kelly',
          kellyFraction: 0.15,
        },
      },
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      winRate: 0.6,
      avgWinLossRatio: 1.8,
      equity: 100000,
    })

    expect(result.positionSizing.method).toBe('kelly')
    expect(result.positionSizing.recommendedPctOfEquity).toBeGreaterThan(0)
    expect(result.positionSizing.recommendedNotionalUsd).toBeGreaterThan(0)
  })

  it('adds hmm regime diagnostics and conditioned factor weights when enabled', () => {
    const result = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: makeCandles(220),
      strategyConfig: {
        ...baseConfig,
        regime: {
          hmm: {
            ...DEFAULT_REGIME_HMM_CONFIG,
            enabled: true,
            maxIterations: 4,
          },
        },
      },
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: 0.04,
    })

    expect(result.regimeEvaluation).toBeTruthy()
    expect(result.hmmRegime).toBeTruthy()
    expect(result.researchDiagnostics?.hmmEnabled).toBe(true)
    expect(result.researchDiagnostics?.observationCount).toBeGreaterThan(30)
    expect(result.researchDiagnostics?.factorDirectionMultipliers).toBeTruthy()
    expect(result.ensemble.weights['momentum-composite']).toBeGreaterThan(0)
  })

  it('emits meta-label admission diagnostics when enabled', () => {
    const result = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: makeCandles(72),
      strategyConfig: {
        ...baseConfig,
        metaLabeling: {
          ...baseConfig.metaLabeling!,
          enabled: true,
          minConfidenceToTrade: 0.6,
        },
      },
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: 0.04,
    })

    expect(result.metaLabeling?.enabled).toBe(true)
    expect(result.metaLabeling?.enforcementMode).toBe('shadow_only')
    expect(result.metaLabeling?.threshold).toBe(0.6)
    expect(result.metaLabeling?.canControlLiveLeverage).toBe(false)
    expect(result.metaLabeling?.score).toBeGreaterThanOrEqual(0)
    expect(result.metaLabeling?.score).toBeLessThanOrEqual(1)
    expect(result.metaLabeling?.reasons.length).toBeGreaterThan(0)
  })

  it('applies stale-data penalty when runtime inputs are stale', () => {
    const result = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: makeCandles(48),
      strategyConfig: baseConfig,
      sourceTier: 'L1',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: 0.08,
      staleData: true,
    })

    expect(result.governance.staleDataApplied).toBe(true)
    expect(result.governance.breakdown.executionClarityScore).toBe(4)
  })

  it('blocks trades when current layer positions already hit the configured max', () => {
    const result = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: makeCandles(48),
      strategyConfig: baseConfig,
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      equity: 100000,
      assetLayer: 'core',
      currentOpenPositions: 5,
      currentLayerOpenPositions: 5,
    })

    expect(result.positionSizing.allowed).toBe(false)
    expect(result.positionSizing.reasons[0]).toContain('layer core already has 5 open positions')
  })
})
