import { describe, expect, it } from 'vitest'
import { evaluateRuntimeFactorSnapshot } from './runtime-evaluator.js'
import type { StrategyConfig } from '../../core/config.js'

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
})
