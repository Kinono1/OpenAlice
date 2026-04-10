import { describe, expect, it } from 'vitest'
import { evaluateRuntimeFactorSnapshot } from '../runtime-evaluator.js'
import { buildMetaLabelFeatureVector } from './feature-builder.js'
import { evaluateTripleBarrierLabel } from './triple-barrier.js'
import type { StrategyConfig } from '../../../core/config.js'

function makeCandles() {
  return [
    { date: '2026-03-01', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    { date: '2026-03-02', open: 100, high: 103, low: 99.5, close: 102, volume: 1200 },
    { date: '2026-03-03', open: 102, high: 106, low: 101, close: 105, volume: 1400 },
    { date: '2026-03-04', open: 105, high: 106, low: 97, close: 98, volume: 1600 },
  ]
}

const config: StrategyConfig = {
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
    ],
  },
}

describe('strategy meta-labeling', () => {
  it('labels take-profit before stop-loss for long trades', () => {
    const result = evaluateTripleBarrierLabel({
      candles: makeCandles(),
      entryIndex: 0,
      upperBarrierPct: 3,
      lowerBarrierPct: 2,
      maxHoldingBars: 3,
      side: 'long',
    })

    expect(result.label).toBe(1)
    expect(result.exitReason).toBe('take-profit')
  })

  it('labels stop-loss before take-profit for short trades', () => {
    const result = evaluateTripleBarrierLabel({
      candles: makeCandles(),
      entryIndex: 1,
      upperBarrierPct: 2,
      lowerBarrierPct: 2,
      maxHoldingBars: 2,
      side: 'short',
    })

    expect(result.exitReason).toBe('stop-loss')
    expect(result.label).toBe(0)
    expect(result.hitUpperBarrier).toBe(true)
    expect(result.hitLowerBarrier).toBe(false)
  })

  it('labels take-profit on the lower price barrier for short trades', () => {
    const result = evaluateTripleBarrierLabel({
      candles: makeCandles(),
      entryIndex: 0,
      upperBarrierPct: 2,
      lowerBarrierPct: 1,
      maxHoldingBars: 3,
      side: 'short',
    })

    expect(result.exitReason).toBe('stop-loss')
  })

  it('builds meta-label features from a strategy snapshot', () => {
    const snapshot = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: Array.from({ length: 48 }, (_, index) => ({
        date: `2026-03-${String((index % 28) + 1).padStart(2, '0')}`,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100 + index,
        volume: 1000 + index * 10,
      })),
      strategyConfig: config,
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: 0.02,
    })

    const vector = buildMetaLabelFeatureVector({ snapshot })
    expect(vector.names).toContain('ensemble-value')
    expect(vector.names).toContain('hmm-stress-prob')
    expect(vector.names).toContain('return-24h-pct')
    expect(vector.values.length).toBe(vector.names.length)
  })
})
