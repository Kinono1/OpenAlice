import { runStrategyBacktest } from './strategy-validation/backtest.js'
import type {
  MarketData,
  StrategyName,
  StrategyParams,
} from './strategy-validation/types.js'
import type { BacktestCostModel, BacktestMetrics } from './strategy-validation/backtest.js'

export interface WfoWindow {
  trainStart: number
  trainEndExclusive: number
  testStart: number
  testEndExclusive: number
}

export interface WfoConfig {
  trainBars: number
  testBars: number
  stepBars?: number
  degradationThreshold?: number
  minTradesPerWindow?: number
}

export interface WfoCandidate<TParams> {
  id: string
  params: TParams
}

export interface WfoWindowMetrics {
  sharpe: number
  maxDrawdownPct: number
  totalReturnPct: number
  tradeCount: number
}

export interface WfoWindowResult<TParams> {
  windowIndex: number
  window: WfoWindow
  selectedCandidate: WfoCandidate<TParams>
  inSample: WfoWindowMetrics
  outOfSample: WfoWindowMetrics
  degradationRate: number
  gatePassed: boolean
  gateReason?: 'is_non_positive_sharpe' | 'degradation_exceeded' | 'insufficient_oos_trades'
}

export interface WfoResult<TParams> {
  config: Required<WfoConfig>
  windows: WfoWindowResult<TParams>[]
  overallPassed: boolean
  failedWindows: number
}

export interface StrategyWfoInput {
  strategy: StrategyName
  candles: MarketData[]
  candidates: StrategyParams[]
  initialCapital?: number
  costModel?: Partial<BacktestCostModel>
  config: WfoConfig
}

const DEFAULT_WFO_CONFIG: Required<WfoConfig> = {
  trainBars: 24 * 365,
  testBars: 24 * 90,
  stepBars: 24 * 90,
  degradationThreshold: 0.4,
  minTradesPerWindow: 1,
}

export function createRollingWindows(totalBars: number, config: WfoConfig): WfoWindow[] {
  const resolved = resolveWfoConfig(config)
  const windows: WfoWindow[] = []
  if (totalBars < resolved.trainBars + resolved.testBars) {
    return windows
  }

  for (
    let trainStart = 0;
    trainStart + resolved.trainBars + resolved.testBars <= totalBars;
    trainStart += resolved.stepBars
  ) {
    const trainEndExclusive = trainStart + resolved.trainBars
    const testStart = trainEndExclusive
    const testEndExclusive = testStart + resolved.testBars
    windows.push({ trainStart, trainEndExclusive, testStart, testEndExclusive })
  }
  return windows
}

export function runStrategyWalkForward(input: StrategyWfoInput): WfoResult<StrategyParams> {
  const config = resolveWfoConfig(input.config)
  const candidates = input.candidates.map((params, index) => ({
    id: `candidate_${index + 1}`,
    params,
  }))
  if (candidates.length < 1) {
    throw new Error('At least one strategy candidate is required.')
  }

  const windows = createRollingWindows(input.candles.length, config)
  if (windows.length === 0) {
    throw new Error(
      `Not enough candles for WFO. Need at least ${config.trainBars + config.testBars}, got ${input.candles.length}.`,
    )
  }

  const results: WfoWindowResult<StrategyParams>[] = []
  for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
    const window = windows[windowIndex]
    const trainCandles = input.candles.slice(window.trainStart, window.trainEndExclusive)
    const testCandles = input.candles.slice(window.testStart, window.testEndExclusive)

    let selected = candidates[0]
    let selectedInSample = toWindowMetrics(
      runStrategyBacktest({
        strategy: input.strategy,
        candles: trainCandles,
        params: selected.params,
        initialCapital: input.initialCapital,
        costModel: input.costModel,
      }).metrics,
    )

    for (let index = 1; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const metrics = toWindowMetrics(
        runStrategyBacktest({
          strategy: input.strategy,
          candles: trainCandles,
          params: candidate.params,
          initialCapital: input.initialCapital,
          costModel: input.costModel,
        }).metrics,
      )
      if (
        metrics.sharpe > selectedInSample.sharpe ||
        (metrics.sharpe === selectedInSample.sharpe &&
          metrics.totalReturnPct > selectedInSample.totalReturnPct)
      ) {
        selected = candidate
        selectedInSample = metrics
      }
    }

    const outOfSample = toWindowMetrics(
      runStrategyBacktest({
        strategy: input.strategy,
        candles: testCandles,
        params: selected.params,
        initialCapital: input.initialCapital,
        costModel: input.costModel,
      }).metrics,
    )

    const { degradationRate, gatePassed, gateReason } = evaluateWindowGate(
      selectedInSample,
      outOfSample,
      config,
    )

    results.push({
      windowIndex,
      window,
      selectedCandidate: selected,
      inSample: selectedInSample,
      outOfSample,
      degradationRate,
      gatePassed,
      gateReason,
    })
  }

  const failedWindows = results.filter((window) => !window.gatePassed).length
  return {
    config,
    windows: results,
    overallPassed: failedWindows === 0,
    failedWindows,
  }
}

function evaluateWindowGate(
  inSample: WfoWindowMetrics,
  outOfSample: WfoWindowMetrics,
  config: Required<WfoConfig>,
): { degradationRate: number; gatePassed: boolean; gateReason?: WfoWindowResult<StrategyParams>['gateReason'] } {
  if (inSample.sharpe <= 0) {
    return {
      degradationRate: Number.POSITIVE_INFINITY,
      gatePassed: false,
      gateReason: 'is_non_positive_sharpe',
    }
  }
  if (outOfSample.tradeCount < config.minTradesPerWindow) {
    return {
      degradationRate: Number.POSITIVE_INFINITY,
      gatePassed: false,
      gateReason: 'insufficient_oos_trades',
    }
  }
  const degradationRate =
    (inSample.sharpe - outOfSample.sharpe) / Math.abs(inSample.sharpe)
  if (degradationRate > config.degradationThreshold) {
    return {
      degradationRate,
      gatePassed: false,
      gateReason: 'degradation_exceeded',
    }
  }
  return { degradationRate, gatePassed: true }
}

function toWindowMetrics(metrics: BacktestMetrics): WfoWindowMetrics {
  return {
    sharpe: metrics.sharpe,
    maxDrawdownPct: metrics.maxDrawdownPct,
    totalReturnPct: metrics.totalReturnPct,
    tradeCount: metrics.tradeCount,
  }
}

function resolveWfoConfig(config: WfoConfig): Required<WfoConfig> {
  return {
    trainBars: toPositiveInt(config.trainBars ?? DEFAULT_WFO_CONFIG.trainBars, 'trainBars'),
    testBars: toPositiveInt(config.testBars ?? DEFAULT_WFO_CONFIG.testBars, 'testBars'),
    stepBars: toPositiveInt(config.stepBars ?? config.testBars ?? DEFAULT_WFO_CONFIG.testBars, 'stepBars'),
    degradationThreshold: toFinite(
      config.degradationThreshold ?? DEFAULT_WFO_CONFIG.degradationThreshold,
      'degradationThreshold',
    ),
    minTradesPerWindow: toNonNegativeInt(
      config.minTradesPerWindow ?? DEFAULT_WFO_CONFIG.minTradesPerWindow,
      'minTradesPerWindow',
    ),
  }
}

function toPositiveInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer.`)
  }
  return value
}

function toNonNegativeInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`)
  }
  return value
}

function toFinite(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be finite.`)
  }
  return value
}
