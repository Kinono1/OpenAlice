import type { RuntimeFactorSnapshot } from '../runtime-evaluator.js'
import type {
  FeatureNormalizationStats,
  StrategyMlFeatureVector,
} from './types.js'

export const STRATEGY_ML_FEATURE_NAMES = [
  'funding-rate',
  'basis',
  'volume-surge',
  'momentum-composite',
  'mean-reversion',
  'volatility-regime',
  'liquidation-pressure',
  'cross-timeframe-divergence',
  'hmm-bull-prob',
  'hmm-bear-prob',
  'hmm-calm-prob',
  'hmm-stress-prob',
  'return-1h-pct',
  'return-6h-pct',
  'return-24h-pct',
  'return-7d-pct',
  'realized-vol-pct',
  'volume-ratio',
  'rsi-proxy',
  'macd-hist-proxy',
  'bb-position-proxy',
  'atr-pct-proxy',
  'ensemble-value',
  'ensemble-confidence',
  'regime-confidence',
  'governance-total-score',
] as const

export type StrategyMlFeatureName = (typeof STRATEGY_ML_FEATURE_NAMES)[number]

function signalValue(
  snapshot: RuntimeFactorSnapshot,
  name: string,
): number {
  return snapshot.factorSignals.find((signal) => signal.name === name)?.value ?? 0
}

function safeDivide(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || Math.abs(denominator) <= 1e-12) {
    return 0
  }
  return numerator / denominator
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function rsiProxy(snapshot: RuntimeFactorSnapshot): number {
  const momentum = snapshot.derivedMetrics.return24hPct + snapshot.derivedMetrics.return7dPct * 0.25
  return clamp(50 + momentum * 2, 0, 100)
}

function macdHistProxy(snapshot: RuntimeFactorSnapshot): number {
  return snapshot.derivedMetrics.return24hPct - snapshot.derivedMetrics.return7dPct / 7
}

function bbPositionProxy(snapshot: RuntimeFactorSnapshot): number {
  const range = Math.max(snapshot.derivedMetrics.realizedVolPct, 1e-6)
  return clamp(0.5 + snapshot.derivedMetrics.return24hPct / (range * 4), 0, 1)
}

function atrPctProxy(snapshot: RuntimeFactorSnapshot): number {
  return Math.max(0, snapshot.derivedMetrics.realizedVolPct / Math.sqrt(24 * 365))
}

export function buildStrategyMlFeatureVector(
  snapshot: RuntimeFactorSnapshot,
): StrategyMlFeatureVector {
  const featureEntries: Array<[StrategyMlFeatureName, number]> = [
    ['funding-rate', signalValue(snapshot, 'funding-rate')],
    ['basis', signalValue(snapshot, 'basis')],
    ['volume-surge', signalValue(snapshot, 'volume-surge')],
    ['momentum-composite', signalValue(snapshot, 'momentum-composite')],
    ['mean-reversion', signalValue(snapshot, 'mean-reversion')],
    ['volatility-regime', signalValue(snapshot, 'volatility-regime')],
    ['liquidation-pressure', signalValue(snapshot, 'liquidation-pressure')],
    ['cross-timeframe-divergence', signalValue(snapshot, 'cross-timeframe-divergence')],
    ['hmm-bull-prob', snapshot.hmmRegime?.stateProbs[0] ?? 0],
    ['hmm-bear-prob', snapshot.hmmRegime?.stateProbs[1] ?? 0],
    ['hmm-calm-prob', snapshot.hmmRegime?.stateProbs[2] ?? 0],
    ['hmm-stress-prob', snapshot.hmmRegime?.stateProbs[3] ?? 0],
    ['return-1h-pct', snapshot.derivedMetrics.return1hPct],
    ['return-6h-pct', snapshot.derivedMetrics.return6hPct],
    ['return-24h-pct', snapshot.derivedMetrics.return24hPct],
    ['return-7d-pct', snapshot.derivedMetrics.return7dPct],
    ['realized-vol-pct', snapshot.derivedMetrics.realizedVolPct],
    [
      'volume-ratio',
      safeDivide(
        snapshot.derivedMetrics.currentVolume,
        snapshot.derivedMetrics.averageVolume,
      ),
    ],
    ['rsi-proxy', rsiProxy(snapshot)],
    ['macd-hist-proxy', macdHistProxy(snapshot)],
    ['bb-position-proxy', bbPositionProxy(snapshot)],
    ['atr-pct-proxy', atrPctProxy(snapshot)],
    ['ensemble-value', snapshot.ensemble.aggregateValue],
    ['ensemble-confidence', snapshot.ensemble.aggregateConfidence],
    ['regime-confidence', snapshot.regimeEvaluation?.confidence ?? 0],
    ['governance-total-score', snapshot.governance.breakdown.totalScore],
  ]

  return {
    names: featureEntries.map(([name]) => name),
    values: featureEntries.map(([, value]) => value),
    record: Object.fromEntries(featureEntries),
  }
}

export function validateFeatureNormalizationStats(
  stats: FeatureNormalizationStats,
  expectedFeatureNames: readonly string[] = STRATEGY_ML_FEATURE_NAMES,
): void {
  if (stats.featureNames.length !== expectedFeatureNames.length) {
    throw new Error(
      `Feature normalization stats expected ${expectedFeatureNames.length} features, received ${stats.featureNames.length}.`,
    )
  }

  expectedFeatureNames.forEach((name, index) => {
    if (stats.featureNames[index] !== name) {
      throw new Error(
        `Feature normalization stats mismatch at index ${index}: expected ${name}, received ${stats.featureNames[index]}.`,
      )
    }
  })
}

export function buildFeatureNormalizationStats(
  rows: number[][],
  featureNames: string[],
): FeatureNormalizationStats {
  if (rows.length === 0) {
    return {
      featureNames,
      mean: Array.from({ length: featureNames.length }, () => 0),
      std: Array.from({ length: featureNames.length }, () => 1),
    }
  }

  const mean = featureNames.map((_, columnIndex) => (
    rows.reduce((sum, row) => sum + (row[columnIndex] ?? 0), 0) / rows.length
  ))
  const std = featureNames.map((_, columnIndex) => {
    const variance = rows.reduce((sum, row) => (
      sum + ((row[columnIndex] ?? 0) - mean[columnIndex]) ** 2
    ), 0) / rows.length
    return Math.max(Math.sqrt(variance), 1e-6)
  })

  return {
    featureNames,
    mean,
    std,
  }
}

export function normalizeFeatureVector(
  vector: StrategyMlFeatureVector,
  stats: FeatureNormalizationStats,
): StrategyMlFeatureVector {
  const record = Object.fromEntries(vector.names.map((name, index) => {
    const mean = stats.mean[index] ?? 0
    const std = stats.std[index] ?? 1
    return [name, (vector.values[index] - mean) / std]
  }))
  return {
    names: [...vector.names],
    values: vector.names.map((name) => record[name]),
    record,
  }
}

export function denormalizeFeatureVector(
  vector: StrategyMlFeatureVector,
  stats: FeatureNormalizationStats,
): StrategyMlFeatureVector {
  const record = Object.fromEntries(vector.names.map((name, index) => {
    const mean = stats.mean[index] ?? 0
    const std = stats.std[index] ?? 1
    return [name, vector.values[index] * std + mean]
  }))
  return {
    names: [...vector.names],
    values: vector.names.map((name) => record[name]),
    record,
  }
}
