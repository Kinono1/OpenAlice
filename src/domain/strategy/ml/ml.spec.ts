import { describe, expect, it } from 'vitest'
import { evaluateRuntimeFactorSnapshot } from '../runtime-evaluator.js'
import {
  buildFeatureNormalizationStats,
  buildStrategyMlFeatureVector,
  denormalizeFeatureVector,
  normalizeFeatureVector,
  STRATEGY_ML_FEATURE_NAMES,
  validateFeatureNormalizationStats,
} from './feature-pipeline.js'
import {
  runStrategyOnnxInference,
  StrategyOnnxInputError,
  StrategyOnnxModelNotFoundError,
} from './onnx-inference.js'
import type { StrategyConfig } from '../../../core/config.js'

function makeCandles(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-03-${String((index % 28) + 1).padStart(2, '0')}`,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index + Math.sin(index / 8),
    volume: 1000 + index * 10,
  }))
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

describe('strategy ml feature pipeline', () => {
  it('builds a feature vector from the runtime snapshot', () => {
    const snapshot = evaluateRuntimeFactorSnapshot({
      symbol: 'BTC/USD',
      candles: makeCandles(72),
      strategyConfig: config,
      sourceTier: 'L2',
      useType: 'U1',
      sentiment: 'S0',
      fundingRatePct: 0.03,
    })

    const vector = buildStrategyMlFeatureVector(snapshot)
    expect(vector.names).toEqual(STRATEGY_ML_FEATURE_NAMES)
    expect(vector.values.length).toBe(vector.names.length)
    expect(vector.names).toContain('mean-reversion')
    expect(vector.names).toContain('liquidation-pressure')
  })

  it('normalizes and denormalizes vectors consistently', () => {
    const rows = [
      [1, 2, 3],
      [2, 3, 4],
      [3, 4, 5],
    ]
    const stats = buildFeatureNormalizationStats(rows, ['a', 'b', 'c'])
    const normalized = normalizeFeatureVector(
      {
        names: ['a', 'b', 'c'],
        values: [2, 3, 4],
        record: { a: 2, b: 3, c: 4 },
      },
      stats,
    )
    const denormalized = denormalizeFeatureVector(normalized, stats)

    expect(denormalized.values[0]).toBeCloseTo(2, 6)
    expect(denormalized.values[1]).toBeCloseTo(3, 6)
    expect(denormalized.values[2]).toBeCloseTo(4, 6)
  })

  it('rejects normalization stats with mismatched feature names', () => {
    expect(() => validateFeatureNormalizationStats({
      featureNames: ['wrong'],
      mean: [0],
      std: [1],
    })).toThrow()
  })

  it('rejects empty ONNX inference windows before runtime loading', async () => {
    await expect(runStrategyOnnxInference({
      modelPath: '/tmp/does-not-matter.onnx',
      window: [],
    })).rejects.toBeInstanceOf(StrategyOnnxInputError)
  })

  it('rejects missing ONNX model files before runtime loading', async () => {
    await expect(runStrategyOnnxInference({
      modelPath: '/tmp/definitely-missing-model.onnx',
      window: [[1, 2, 3]],
      expectedFeatureCount: 3,
    })).rejects.toBeInstanceOf(StrategyOnnxModelNotFoundError)
  })
})
