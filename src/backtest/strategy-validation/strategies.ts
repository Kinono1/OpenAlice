import { ATR, BBANDS, RSI } from '../../domain/analysis/indicator/functions/technical.js'
import { SMA } from '../../domain/analysis/indicator/functions/statistics.js'
import type {
  MarketData,
  PositionSignal,
  ResolvedStrategyParams,
  StrategyDecision,
  StrategyEvaluationInput,
  StrategyName,
  StrategyParams,
  StrategyRegimeLabel,
} from './types.js'
import { resolveStrategyParams } from './types.js'

export interface StrategyRegimeSnapshot {
  label: StrategyRegimeLabel
  volatilityPct: number
  trendStrengthPct: number
}

function closes(candles: MarketData[], endInclusive: number): number[] {
  return candles.slice(0, endInclusive + 1).map((candle) => candle.close)
}

function highs(candles: MarketData[], start: number, endInclusive: number): number[] {
  return candles.slice(start, endInclusive + 1).map((candle) => candle.high)
}

function lows(candles: MarketData[], start: number, endInclusive: number): number[] {
  return candles.slice(start, endInclusive + 1).map((candle) => candle.low)
}

function mean(values: number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0
}

function std(values: number[]): number {
  if (values.length < 1) {
    return 0
  }
  const center = mean(values)
  const variance =
    values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length
  return Math.sqrt(Math.max(variance, 0))
}

function pctDiff(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right) || right === 0) {
    return 0
  }
  return ((left - right) / right) * 100
}

function weightedMeanReversionSignal(series: number[]): number {
  const last = series.length - 1
  const latest = series[last]
  if (!Number.isFinite(latest) || latest === 0) {
    return 0
  }
  const ret1h = last >= 1 ? ((latest - series[last - 1]) / series[last - 1]) * 100 : 0
  const ret6h = last >= 6 ? ((latest - series[last - 6]) / series[last - 6]) * 100 : 0
  const ret24h = last >= 24 ? ((latest - series[last - 24]) / series[last - 24]) * 100 : 0
  const ret7d = last >= 168 ? ((latest - series[last - 168]) / series[last - 168]) * 100 : 0
  const weightedScore = ret1h * 0.15 + ret6h * 0.2 + ret24h * 0.3 + ret7d * 0.35
  const normalizedMomentum = Math.max(-1, Math.min(1, weightedScore / 8))
  return -normalizedMomentum
}

function evaluateTrend(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  params: ResolvedStrategyParams,
): StrategyDecision {
  const series = closes(candles, index)
  const requiredBars = params.trendSlowPeriod + params.trendConfirmBars - 1
  if (series.length < requiredBars) {
    return {
      strategy: 'trend',
      signal: 0,
      reason: 'Not enough bars for trend signal.',
      indicators: { bars: series.length, requiredBars },
    }
  }

  const fastHistory: number[] = []
  const slowHistory: number[] = []
  for (let offset = params.trendConfirmBars - 1; offset >= 0; offset -= 1) {
    const end = series.length - 1 - offset
    const window = series.slice(0, end + 1)
    fastHistory.push(SMA(window, params.trendFastPeriod))
    slowHistory.push(SMA(window, params.trendSlowPeriod))
  }

  const minDiffPct = params.trendMinDiffPct
  const bullish = fastHistory.every((fast, i) => pctDiff(fast, slowHistory[i]) >= minDiffPct)
  const bearish = fastHistory.every((fast, i) => pctDiff(slowHistory[i], fast) >= minDiffPct)
  const latestFast = fastHistory[fastHistory.length - 1]
  const latestSlow = slowHistory[slowHistory.length - 1]

  if (bullish) {
    return {
      strategy: 'trend',
      signal: 1,
      reason: 'Fast SMA is consistently above slow SMA.',
      indicators: { fast: latestFast, slow: latestSlow },
    }
  }
  if (bearish && params.allowShort) {
    return {
      strategy: 'trend',
      signal: -1,
      reason: 'Fast SMA is consistently below slow SMA.',
      indicators: { fast: latestFast, slow: latestSlow },
    }
  }
  return {
    strategy: 'trend',
    signal: currentPosition === 0 ? 0 : currentPosition,
    reason: 'Trend crossover is inconclusive.',
    indicators: { fast: latestFast, slow: latestSlow },
  }
}

function classifyRegime(candles: MarketData[], index: number, params: ResolvedStrategyParams): StrategyRegimeSnapshot {
  const series = closes(candles, index)
  const returns = series.slice(-params.regimeVolWindow).map((close, idx, arr) => {
    if (idx === 0 || arr[idx - 1] === 0) {
      return 0
    }
    return (close - arr[idx - 1]) / arr[idx - 1]
  })
  const volatilityPct = std(returns) * 100
  const fast = SMA(series, params.regimeFastPeriod)
  const slow = SMA(series, params.regimeSlowPeriod)
  const trendStrengthPct = Math.abs(pctDiff(fast, slow))
  const atr = ATR(
    highs(candles, Math.max(0, index - params.regimeAtrPeriod), index),
    lows(candles, Math.max(0, index - params.regimeAtrPeriod), index),
    series.slice(-(params.regimeAtrPeriod + 1)),
    Math.min(params.regimeAtrPeriod, series.length - 1),
  )
  const atrPct = series[series.length - 1] > 0 ? (atr / series[series.length - 1]) * 100 : 0
  const highVol = Math.max(volatilityPct, atrPct) >= Math.max(1, volatilityPct * 0.75)
  const trending = trendStrengthPct >= 0.25

  const label: StrategyRegimeLabel = highVol
    ? trending
      ? 'HighVolTrend'
      : 'HighVolMeanRevert'
    : trending
      ? 'LowVolTrend'
      : 'LowVolCarry'

  return { label, volatilityPct, trendStrengthPct }
}

function getRegimeClassificationMinimumBars(params: ResolvedStrategyParams): number {
  return Math.max(
    2,
    params.regimeFastPeriod,
    params.regimeSlowPeriod,
    params.regimeAtrPeriod + 1,
    params.regimeVolWindow + 1,
  )
}

export function classifyStrategyRegimeSnapshot(input: {
  candles: MarketData[]
  index: number
  params?: StrategyParams
}): StrategyRegimeSnapshot {
  const resolved = resolveStrategyParams(input.params)
  const requiredBars = getRegimeClassificationMinimumBars(resolved)
  if (input.index + 1 < requiredBars) {
    return {
      label: 'LowVolCarry',
      volatilityPct: 0,
      trendStrengthPct: 0,
    }
  }
  return classifyRegime(
    input.candles,
    input.index,
    resolved,
  )
}

function evaluateRegimeTrend(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  params: ResolvedStrategyParams,
): StrategyDecision {
  const regime = classifyStrategyRegimeSnapshot({
    candles,
    index,
    params,
  })
  const trend = evaluateTrend(candles, index, currentPosition, params)
  const regimeAllowed = params.allowedEntryRegimes.includes(regime.label)

  if (!regimeAllowed) {
    return {
      strategy: 'regimeTrend',
      signal: params.exitOnRegimeMismatch ? 0 : currentPosition,
      reason: 'Trend signal blocked by current regime.',
      indicators: {
        regimeCode: params.allowedEntryRegimes.indexOf(regime.label),
        volatilityPct: regime.volatilityPct,
        trendStrengthPct: regime.trendStrengthPct,
      },
    }
  }

  return {
    strategy: 'regimeTrend',
    signal: trend.signal,
    reason: `Trend signal allowed in ${regime.label}.`,
    indicators: {
      ...trend.indicators,
      volatilityPct: regime.volatilityPct,
      trendStrengthPct: regime.trendStrengthPct,
    },
  }
}

function evaluateMeanReversion(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  params: ResolvedStrategyParams,
): StrategyDecision {
  const series = closes(candles, index)
  if (series.length < Math.max(params.rsiPeriod + 1, params.bbPeriod)) {
    return {
      strategy: 'meanReversion',
      signal: 0,
      reason: 'Not enough bars for mean reversion signal.',
      indicators: { bars: series.length },
    }
  }

  const rsi = RSI(series, params.rsiPeriod)
  const bands = BBANDS(series, params.bbPeriod, params.bbStdDev)
  const lastClose = series[series.length - 1]

  if (lastClose <= bands.lower && rsi <= params.rsiOversold) {
    return {
      strategy: 'meanReversion',
      signal: 1,
      reason: 'Price is below lower band with oversold RSI.',
      indicators: { rsi, upper: bands.upper, middle: bands.middle, lower: bands.lower },
    }
  }

  if (lastClose >= bands.upper && rsi >= params.rsiOverbought && params.allowShort) {
    return {
      strategy: 'meanReversion',
      signal: -1,
      reason: 'Price is above upper band with overbought RSI.',
      indicators: { rsi, upper: bands.upper, middle: bands.middle, lower: bands.lower },
    }
  }

  const shouldExitLong = currentPosition === 1 && lastClose >= bands.middle
  const shouldExitShort = currentPosition === -1 && lastClose <= bands.middle
  return {
    strategy: 'meanReversion',
    signal: shouldExitLong || shouldExitShort ? 0 : currentPosition,
    reason: 'Mean reversion trigger not active.',
    indicators: { rsi, upper: bands.upper, middle: bands.middle, lower: bands.lower },
  }
}

function evaluateFactorMeanReversion(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  params: ResolvedStrategyParams,
): StrategyDecision {
  const series = closes(candles, index)
  const requiredBars = Math.max(169, getRegimeClassificationMinimumBars(params))
  if (series.length < requiredBars) {
    return {
      strategy: 'factorMeanReversion',
      signal: 0,
      reason: 'Not enough bars for factor mean reversion signal.',
      indicators: { bars: series.length, requiredBars },
    }
  }

  const regime = classifyStrategyRegimeSnapshot({
    candles,
    index,
    params,
  })
  const signal = weightedMeanReversionSignal(series)
  const latestClose = series[series.length - 1]
  const entryThreshold = params.factorEntryThreshold
  const exitThreshold = params.factorExitThreshold

  const killSwitchActive =
    regime.volatilityPct >= params.factorKillSwitchVolPct &&
    regime.trendStrengthPct >= params.factorKillSwitchTrendStrengthPct

  if (killSwitchActive) {
    return {
      strategy: 'factorMeanReversion',
      signal: 0,
      reason: 'Factor mean reversion blocked by volatility/trend kill switch.',
      indicators: {
        signal,
        volatilityPct: regime.volatilityPct,
        trendStrengthPct: regime.trendStrengthPct,
        close: latestClose,
      },
    }
  }

  if (signal >= entryThreshold) {
    return {
      strategy: 'factorMeanReversion',
      signal: 1,
      reason: 'Contrarian factor signal crossed long threshold.',
      indicators: {
        signal,
        entryThreshold,
        exitThreshold,
        volatilityPct: regime.volatilityPct,
        trendStrengthPct: regime.trendStrengthPct,
      },
    }
  }

  if (signal <= -entryThreshold && params.allowShort) {
    return {
      strategy: 'factorMeanReversion',
      signal: -1,
      reason: 'Contrarian factor signal crossed short threshold.',
      indicators: {
        signal,
        entryThreshold,
        exitThreshold,
        volatilityPct: regime.volatilityPct,
        trendStrengthPct: regime.trendStrengthPct,
      },
    }
  }

  if (Math.abs(signal) <= exitThreshold) {
    return {
      strategy: 'factorMeanReversion',
      signal: 0,
      reason: 'Contrarian factor signal reverted inside exit band.',
      indicators: {
        signal,
        entryThreshold,
        exitThreshold,
        volatilityPct: regime.volatilityPct,
        trendStrengthPct: regime.trendStrengthPct,
      },
    }
  }

  return {
    strategy: 'factorMeanReversion',
    signal: currentPosition,
    reason: 'Factor mean reversion holding current position.',
    indicators: {
      signal,
      entryThreshold,
      exitThreshold,
      volatilityPct: regime.volatilityPct,
      trendStrengthPct: regime.trendStrengthPct,
    },
  }
}

function evaluateBreakout(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  params: ResolvedStrategyParams,
): StrategyDecision {
  const requiredBars = Math.max(params.breakoutPeriod + 1, params.breakoutExitPeriod + 1)
  if (index + 1 < requiredBars) {
    return {
      strategy: 'breakout',
      signal: 0,
      reason: 'Not enough bars for breakout signal.',
      indicators: { bars: index + 1, requiredBars },
    }
  }

  const close = candles[index].close
  const breakoutHigh = Math.max(...highs(candles, index - params.breakoutPeriod, index - 1))
  const breakoutLow = Math.min(...lows(candles, index - params.breakoutPeriod, index - 1))
  const exitHigh = Math.max(...highs(candles, index - params.breakoutExitPeriod, index - 1))
  const exitLow = Math.min(...lows(candles, index - params.breakoutExitPeriod, index - 1))

  if (close > breakoutHigh) {
    return {
      strategy: 'breakout',
      signal: 1,
      reason: 'Price broke above prior breakout range.',
      indicators: { breakoutHigh, breakoutLow, exitHigh, exitLow },
    }
  }
  if (close < breakoutLow && params.allowShort) {
    return {
      strategy: 'breakout',
      signal: -1,
      reason: 'Price broke below prior breakout range.',
      indicators: { breakoutHigh, breakoutLow, exitHigh, exitLow },
    }
  }

  const shouldExit =
    (currentPosition === 1 && close < exitLow) ||
    (currentPosition === -1 && close > exitHigh)
  return {
    strategy: 'breakout',
    signal: shouldExit ? 0 : currentPosition,
    reason: 'Breakout is inactive.',
    indicators: { breakoutHigh, breakoutLow, exitHigh, exitLow },
  }
}

function evaluateEnsemble(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  params: ResolvedStrategyParams,
): StrategyDecision {
  const trend = evaluateTrend(candles, index, currentPosition, params)
  const meanReversion = evaluateMeanReversion(candles, index, currentPosition, params)
  const breakout = evaluateBreakout(candles, index, currentPosition, params)
  const weighted =
    trend.signal * params.ensembleWeights.trend +
    meanReversion.signal * params.ensembleWeights.meanReversion +
    breakout.signal * params.ensembleWeights.breakout
  const totalWeight =
    params.ensembleWeights.trend +
    params.ensembleWeights.meanReversion +
    params.ensembleWeights.breakout
  const score = totalWeight > 0 ? weighted / totalWeight : 0

  let signal: PositionSignal = 0
  if (score >= params.ensembleThreshold) {
    signal = 1
  } else if (score <= -params.ensembleThreshold && params.allowShort) {
    signal = -1
  } else {
    signal = currentPosition === 0 ? 0 : currentPosition
  }

  return {
    strategy: 'ensemble',
    signal,
    reason: 'Weighted ensemble of trend, mean reversion, and breakout signals.',
    indicators: {
      score,
      trend: trend.signal,
      meanReversion: meanReversion.signal,
      breakout: breakout.signal,
    },
  }
}

export function getStrategyMinimumBars(
  strategy: StrategyName,
  params?: StrategyParams,
): number {
  const resolved = resolveStrategyParams(params)
  const trendBars = resolved.trendSlowPeriod + resolved.trendConfirmBars - 1
  const regimeBars = Math.max(
    trendBars,
    getRegimeClassificationMinimumBars(resolved),
  )
  const meanReversionBars = Math.max(resolved.rsiPeriod + 1, resolved.bbPeriod)
  const breakoutBars = Math.max(
    resolved.breakoutPeriod + 1,
    resolved.breakoutExitPeriod + 1,
  )

  switch (strategy) {
    case 'trend':
      return trendBars
    case 'regimeTrend':
      return regimeBars
    case 'meanReversion':
      return meanReversionBars
    case 'factorMeanReversion':
      return Math.max(169, getRegimeClassificationMinimumBars(resolved))
    case 'breakout':
      return breakoutBars
    case 'ensemble':
    default:
      return Math.max(trendBars, meanReversionBars, breakoutBars)
  }
}

export function evaluateStrategy(
  input: StrategyEvaluationInput & { strategy: StrategyName },
): StrategyDecision {
  const resolved = resolveStrategyParams(input.params)
  if (input.index < 0 || input.index >= input.candles.length) {
    throw new Error(`index out of bounds: ${input.index}`)
  }

  switch (input.strategy) {
    case 'trend':
      return evaluateTrend(input.candles, input.index, input.currentPosition, resolved)
    case 'regimeTrend':
      return evaluateRegimeTrend(input.candles, input.index, input.currentPosition, resolved)
    case 'meanReversion':
      return evaluateMeanReversion(input.candles, input.index, input.currentPosition, resolved)
    case 'factorMeanReversion':
      return evaluateFactorMeanReversion(input.candles, input.index, input.currentPosition, resolved)
    case 'breakout':
      return evaluateBreakout(input.candles, input.index, input.currentPosition, resolved)
    case 'ensemble':
    default:
      return evaluateEnsemble(input.candles, input.index, input.currentPosition, resolved)
  }
}
