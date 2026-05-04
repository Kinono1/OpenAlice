export interface MarketData {
  symbol: string
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type StrategyName =
  | 'trend'
  | 'regimeTrend'
  | 'meanReversion'
  | 'factorMeanReversion'
  | 'breakout'
  | 'ensemble'

export type PositionSignal = -1 | 0 | 1

export type StrategyRegimeLabel =
  | 'HighVolTrend'
  | 'HighVolMeanRevert'
  | 'LowVolTrend'
  | 'LowVolCarry'

export interface StrategyEnsembleWeights {
  trend?: number
  meanReversion?: number
  breakout?: number
}

export interface StrategyParams {
  allowShort?: boolean

  trendFastPeriod?: number
  trendSlowPeriod?: number
  trendConfirmBars?: number
  trendMinDiffPct?: number

  regimeVolWindow?: number
  regimeAtrPeriod?: number
  regimeFastPeriod?: number
  regimeSlowPeriod?: number
  allowedEntryRegimes?: StrategyRegimeLabel[]
  exitOnRegimeMismatch?: boolean

  rsiPeriod?: number
  rsiOversold?: number
  rsiOverbought?: number
  bbPeriod?: number
  bbStdDev?: number

  factorEntryThreshold?: number
  factorExitThreshold?: number
  factorPositionPctOfEquity?: number
  factorMaxHoldingBars?: number
  factorStopLossPct?: number
  factorKillSwitchVolPct?: number
  factorKillSwitchTrendStrengthPct?: number

  breakoutPeriod?: number
  breakoutExitPeriod?: number

  ensembleThreshold?: number
  ensembleWeights?: StrategyEnsembleWeights
}

export interface StrategyDecision {
  strategy: StrategyName
  signal: PositionSignal
  reason: string
  indicators: Record<string, number>
}

export interface StrategyEvaluationInput {
  candles: MarketData[]
  index: number
  currentPosition: PositionSignal
  params?: StrategyParams
}

export interface ResolvedStrategyParams {
  allowShort: boolean
  trendFastPeriod: number
  trendSlowPeriod: number
  trendConfirmBars: number
  trendMinDiffPct: number
  regimeVolWindow: number
  regimeAtrPeriod: number
  regimeFastPeriod: number
  regimeSlowPeriod: number
  allowedEntryRegimes: StrategyRegimeLabel[]
  exitOnRegimeMismatch: boolean
  rsiPeriod: number
  rsiOversold: number
  rsiOverbought: number
  bbPeriod: number
  bbStdDev: number
  factorEntryThreshold: number
  factorExitThreshold: number
  factorPositionPctOfEquity: number
  factorMaxHoldingBars: number
  factorStopLossPct: number
  factorKillSwitchVolPct: number
  factorKillSwitchTrendStrengthPct: number
  breakoutPeriod: number
  breakoutExitPeriod: number
  ensembleThreshold: number
  ensembleWeights: {
    trend: number
    meanReversion: number
    breakout: number
  }
}

export const DEFAULT_STRATEGY_PARAMS: ResolvedStrategyParams = {
  allowShort: true,
  trendFastPeriod: 20,
  trendSlowPeriod: 50,
  trendConfirmBars: 1,
  trendMinDiffPct: 0,
  regimeVolWindow: 20,
  regimeAtrPeriod: 14,
  regimeFastPeriod: 12,
  regimeSlowPeriod: 48,
  allowedEntryRegimes: ['HighVolTrend', 'LowVolTrend'],
  exitOnRegimeMismatch: true,
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  bbPeriod: 20,
  bbStdDev: 2,
  factorEntryThreshold: 0.35,
  factorExitThreshold: 0.10,
  factorPositionPctOfEquity: 0.03,
  factorMaxHoldingBars: 24,
  factorStopLossPct: 0.0125,
  factorKillSwitchVolPct: 3.0,
  factorKillSwitchTrendStrengthPct: 0.8,
  breakoutPeriod: 20,
  breakoutExitPeriod: 10,
  ensembleThreshold: 0.34,
  ensembleWeights: {
    trend: 1,
    meanReversion: 1,
    breakout: 1,
  },
}

export function isStrategyName(value: unknown): value is StrategyName {
  return (
    value === 'trend' ||
    value === 'regimeTrend' ||
    value === 'meanReversion' ||
    value === 'factorMeanReversion' ||
    value === 'breakout' ||
    value === 'ensemble'
  )
}

function normalizeRegimeLabel(value: unknown): StrategyRegimeLabel | null {
  return value === 'HighVolTrend' ||
    value === 'HighVolMeanRevert' ||
    value === 'LowVolTrend' ||
    value === 'LowVolCarry'
    ? value
    : null
}

function resolveAllowedEntryRegimes(
  input: StrategyParams['allowedEntryRegimes'],
): StrategyRegimeLabel[] {
  const normalized = Array.isArray(input)
    ? input
        .map((item) => normalizeRegimeLabel(item))
        .filter((item): item is StrategyRegimeLabel => item !== null)
    : []
  return normalized.length > 0
    ? Array.from(new Set(normalized))
    : [...DEFAULT_STRATEGY_PARAMS.allowedEntryRegimes]
}

function sanitizeWeight(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return fallback
  }
  return value
}

export function resolveStrategyParams(
  params: StrategyParams | undefined,
): ResolvedStrategyParams {
  const rawThreshold =
    params?.ensembleThreshold ?? DEFAULT_STRATEGY_PARAMS.ensembleThreshold
  const ensembleThreshold = Math.max(0, Math.min(1, rawThreshold))
  return {
    allowShort: params?.allowShort ?? DEFAULT_STRATEGY_PARAMS.allowShort,
    trendFastPeriod:
      params?.trendFastPeriod ?? DEFAULT_STRATEGY_PARAMS.trendFastPeriod,
    trendSlowPeriod:
      params?.trendSlowPeriod ?? DEFAULT_STRATEGY_PARAMS.trendSlowPeriod,
    trendConfirmBars: Math.max(
      1,
      Math.floor(
        params?.trendConfirmBars ?? DEFAULT_STRATEGY_PARAMS.trendConfirmBars,
      ),
    ),
    trendMinDiffPct: Math.max(
      0,
      params?.trendMinDiffPct ?? DEFAULT_STRATEGY_PARAMS.trendMinDiffPct,
    ),
    regimeVolWindow: Math.max(
      2,
      Math.floor(
        params?.regimeVolWindow ?? DEFAULT_STRATEGY_PARAMS.regimeVolWindow,
      ),
    ),
    regimeAtrPeriod: Math.max(
      2,
      Math.floor(
        params?.regimeAtrPeriod ?? DEFAULT_STRATEGY_PARAMS.regimeAtrPeriod,
      ),
    ),
    regimeFastPeriod: Math.max(
      2,
      Math.floor(
        params?.regimeFastPeriod ?? DEFAULT_STRATEGY_PARAMS.regimeFastPeriod,
      ),
    ),
    regimeSlowPeriod: Math.max(
      3,
      Math.floor(
        params?.regimeSlowPeriod ?? DEFAULT_STRATEGY_PARAMS.regimeSlowPeriod,
      ),
    ),
    allowedEntryRegimes: resolveAllowedEntryRegimes(params?.allowedEntryRegimes),
    exitOnRegimeMismatch:
      params?.exitOnRegimeMismatch ??
      DEFAULT_STRATEGY_PARAMS.exitOnRegimeMismatch,
    rsiPeriod: Math.max(
      2,
      Math.floor(params?.rsiPeriod ?? DEFAULT_STRATEGY_PARAMS.rsiPeriod),
    ),
    rsiOversold: params?.rsiOversold ?? DEFAULT_STRATEGY_PARAMS.rsiOversold,
    rsiOverbought:
      params?.rsiOverbought ?? DEFAULT_STRATEGY_PARAMS.rsiOverbought,
    bbPeriod: Math.max(
      2,
      Math.floor(params?.bbPeriod ?? DEFAULT_STRATEGY_PARAMS.bbPeriod),
    ),
    bbStdDev: params?.bbStdDev ?? DEFAULT_STRATEGY_PARAMS.bbStdDev,
    factorEntryThreshold: Math.max(
      0,
      Math.min(1, params?.factorEntryThreshold ?? DEFAULT_STRATEGY_PARAMS.factorEntryThreshold),
    ),
    factorExitThreshold: Math.max(
      0,
      Math.min(1, params?.factorExitThreshold ?? DEFAULT_STRATEGY_PARAMS.factorExitThreshold),
    ),
    factorPositionPctOfEquity: Math.max(
      0.001,
      Math.min(1, params?.factorPositionPctOfEquity ?? DEFAULT_STRATEGY_PARAMS.factorPositionPctOfEquity),
    ),
    factorMaxHoldingBars: Math.max(
      1,
      Math.floor(params?.factorMaxHoldingBars ?? DEFAULT_STRATEGY_PARAMS.factorMaxHoldingBars),
    ),
    factorStopLossPct: Math.max(
      0,
      params?.factorStopLossPct ?? DEFAULT_STRATEGY_PARAMS.factorStopLossPct,
    ),
    factorKillSwitchVolPct: Math.max(
      0,
      params?.factorKillSwitchVolPct ?? DEFAULT_STRATEGY_PARAMS.factorKillSwitchVolPct,
    ),
    factorKillSwitchTrendStrengthPct: Math.max(
      0,
      params?.factorKillSwitchTrendStrengthPct ?? DEFAULT_STRATEGY_PARAMS.factorKillSwitchTrendStrengthPct,
    ),
    breakoutPeriod: Math.max(
      2,
      Math.floor(
        params?.breakoutPeriod ?? DEFAULT_STRATEGY_PARAMS.breakoutPeriod,
      ),
    ),
    breakoutExitPeriod: Math.max(
      2,
      Math.floor(
        params?.breakoutExitPeriod ??
          DEFAULT_STRATEGY_PARAMS.breakoutExitPeriod,
      ),
    ),
    ensembleThreshold,
    ensembleWeights: {
      trend: sanitizeWeight(
        params?.ensembleWeights?.trend,
        DEFAULT_STRATEGY_PARAMS.ensembleWeights.trend,
      ),
      meanReversion: sanitizeWeight(
        params?.ensembleWeights?.meanReversion,
        DEFAULT_STRATEGY_PARAMS.ensembleWeights.meanReversion,
      ),
      breakout: sanitizeWeight(
        params?.ensembleWeights?.breakout,
        DEFAULT_STRATEGY_PARAMS.ensembleWeights.breakout,
      ),
    },
  }
}
