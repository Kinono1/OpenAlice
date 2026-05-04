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

function averageVolume(
  candles: MarketData[],
  endInclusive: number,
  lookback: number,
): number {
  const start = Math.max(0, endInclusive - lookback + 1)
  const window = candles.slice(start, endInclusive + 1)
  return window.length > 0
    ? window.reduce((sum, candle) => sum + candle.volume, 0) / window.length
    : 0
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

function evaluateShockFade(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  params: ResolvedStrategyParams,
): StrategyDecision {
  const series = closes(candles, index)
  const requiredBars = Math.max(169, getRegimeClassificationMinimumBars(params))
  if (series.length < requiredBars) {
    return {
      strategy: 'shockFade',
      signal: 0,
      reason: 'Not enough bars for shock-fade signal.',
      indicators: { bars: series.length, requiredBars },
    }
  }

  const regime = classifyStrategyRegimeSnapshot({
    candles,
    index,
    params,
  })
  const meanReversionSignal = weightedMeanReversionSignal(series)
  const last = series.length - 1
  const latestClose = series[last]
  const ret1h = last >= 1 ? ((latestClose - series[last - 1]) / series[last - 1]) * 100 : 0
  const ret6h = last >= 6 ? ((latestClose - series[last - 6]) / series[last - 6]) * 100 : ret1h
  const shockMagnitudePct = Math.max(Math.abs(ret1h), Math.abs(ret6h))
  const averageVolume24 = averageVolume(candles, index, 24)
  const volumeRatio = averageVolume24 > 0 ? candles[index].volume / averageVolume24 : 0
  const shockDetected =
    shockMagnitudePct >= params.shockMinAbsReturnPct &&
    volumeRatio >= params.shockMinVolumeRatio
  const rawShockScore =
    ((shockMagnitudePct / Math.max(params.shockMinAbsReturnPct, 1e-6)) - 1) * 0.65 +
    ((volumeRatio / Math.max(params.shockMinVolumeRatio, 1e-6)) - 1) * 0.35
  const normalizedShockScore = Math.max(0, Math.min(1, rawShockScore))
  const signedShockScore =
    ret1h < 0 ? normalizedShockScore : ret1h > 0 ? -normalizedShockScore : 0

  const killSwitchActive =
    regime.volatilityPct >= params.factorKillSwitchVolPct &&
    regime.trendStrengthPct >= params.factorKillSwitchTrendStrengthPct

  if (killSwitchActive) {
    return {
      strategy: 'shockFade',
      signal: 0,
      reason: 'Shock-fade blocked by volatility/trend kill switch.',
      indicators: {
        signal: signedShockScore,
        meanReversionSignal,
        ret1hPct: ret1h,
        ret6hPct: ret6h,
        shockMagnitudePct,
        volumeRatio,
        volatilityPct: regime.volatilityPct,
        trendStrengthPct: regime.trendStrengthPct,
      },
    }
  }

  if (!shockDetected) {
    const shouldExit = currentPosition !== 0 && Math.abs(signedShockScore) <= params.factorExitThreshold
    return {
      strategy: 'shockFade',
      signal: shouldExit ? 0 : currentPosition,
      reason: shouldExit
        ? 'Shock impulse has normalized back inside the exit band.'
        : 'No price-volume shock detected.',
      indicators: {
        signal: signedShockScore,
        meanReversionSignal,
        ret1hPct: ret1h,
        ret6hPct: ret6h,
        shockMagnitudePct,
        volumeRatio,
        volatilityPct: regime.volatilityPct,
        trendStrengthPct: regime.trendStrengthPct,
      },
    }
  }

  if (signedShockScore >= params.factorEntryThreshold && ret1h < 0) {
    return {
      strategy: 'shockFade',
      signal: 1,
      reason: 'Downside price-volume shock triggered a long fade entry.',
      indicators: {
        signal: signedShockScore,
        meanReversionSignal,
        entryThreshold: params.factorEntryThreshold,
        exitThreshold: params.factorExitThreshold,
        ret1hPct: ret1h,
        ret6hPct: ret6h,
        shockMagnitudePct,
        volumeRatio,
        volatilityPct: regime.volatilityPct,
        trendStrengthPct: regime.trendStrengthPct,
      },
    }
  }

  if (signedShockScore <= -params.factorEntryThreshold && ret1h > 0 && params.allowShort) {
    return {
      strategy: 'shockFade',
      signal: -1,
      reason: 'Upside price-volume shock triggered a short fade entry.',
      indicators: {
        signal: signedShockScore,
        meanReversionSignal,
        entryThreshold: params.factorEntryThreshold,
        exitThreshold: params.factorExitThreshold,
        ret1hPct: ret1h,
        ret6hPct: ret6h,
        shockMagnitudePct,
        volumeRatio,
        volatilityPct: regime.volatilityPct,
        trendStrengthPct: regime.trendStrengthPct,
      },
    }
  }

  if (Math.abs(signedShockScore) <= params.factorExitThreshold) {
    return {
      strategy: 'shockFade',
      signal: 0,
      reason: 'Shock-fade signal has reverted inside the exit band.',
      indicators: {
        signal: signedShockScore,
        meanReversionSignal,
        entryThreshold: params.factorEntryThreshold,
        exitThreshold: params.factorExitThreshold,
        ret1hPct: ret1h,
        ret6hPct: ret6h,
        shockMagnitudePct,
        volumeRatio,
        volatilityPct: regime.volatilityPct,
        trendStrengthPct: regime.trendStrengthPct,
      },
    }
  }

  return {
    strategy: 'shockFade',
    signal: currentPosition,
    reason: 'Shock-fade is holding the current position through the unwind.',
    indicators: {
      signal: signedShockScore,
      meanReversionSignal,
      entryThreshold: params.factorEntryThreshold,
      exitThreshold: params.factorExitThreshold,
      ret1hPct: ret1h,
      ret6hPct: ret6h,
      shockMagnitudePct,
      volumeRatio,
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

export function evaluateEnhancedCarry(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  params: ResolvedStrategyParams,
): StrategyDecision {
  const minBars = params.carryMinFundingBars + 2
  if (index + 1 < minBars) {
    return {
      strategy: 'enhancedCarry',
      signal: 0,
      reason: `Need at least ${minBars} bars with funding rate data.`,
      indicators: { bars: index + 1, requiredBars: minBars },
    }
  }

  const fundingRates: number[] = []
  for (let i = index - params.carryMinFundingBars + 1; i <= index; i++) {
    const fr = candles[i]?.fundingRate
    if (typeof fr !== 'number' || !Number.isFinite(fr)) {
      return {
        strategy: 'enhancedCarry',
        signal: currentPosition,
        reason: 'Funding rate data missing or invalid.',
        indicators: { checkedBars: index - i },
      }
    }
    fundingRates.push(fr)
  }

  const mean = fundingRates.reduce((s, r) => s + r, 0) / fundingRates.length
  const variance =
    fundingRates.reduce((s, r) => s + (r - mean) ** 2, 0) / fundingRates.length
  const std = Math.sqrt(Math.max(variance, 1e-14))
  const currentRate = fundingRates[fundingRates.length - 1]
  const zScore = std > 0 ? (currentRate - mean) / std : 0

  if (currentPosition === 0) {
    if (zScore > params.carryZEntry) {
      return {
        strategy: 'enhancedCarry',
        signal: -1,
        reason: `Positive funding z=${zScore.toFixed(2)}: short perp + long spot to collect funding.`,
        indicators: { zScore, currentRate, mean, std },
      }
    }
    if (zScore < -params.carryZEntry && params.allowShort) {
      return {
        strategy: 'enhancedCarry',
        signal: 1,
        reason: `Negative funding z=${zScore.toFixed(2)}: long perp + short spot to collect funding.`,
        indicators: { zScore, currentRate, mean, std },
      }
    }
    return {
      strategy: 'enhancedCarry',
      signal: 0,
      reason: `Funding z=${zScore.toFixed(2)} within entry threshold.`,
      indicators: { zScore, currentRate, mean, std },
    }
  }

  if (Math.abs(zScore) <= params.carryZExit) {
    return {
      strategy: 'enhancedCarry',
      signal: 0,
      reason: `Funding z=${zScore.toFixed(2)} mean-reverted below exit threshold.`,
      indicators: { zScore, currentRate, mean, std },
    }
  }

  const signCheck = currentPosition === -1 ? zScore > 0 : zScore < 0
  if (!signCheck) {
    return {
      strategy: 'enhancedCarry',
      signal: 0,
      reason: `Funding sign flipped: closing position.`,
      indicators: { zScore, currentRate, mean, std },
    }
  }

  return {
    strategy: 'enhancedCarry',
    signal: currentPosition,
    reason: `Holding carry position, z=${zScore.toFixed(2)}.`,
    indicators: { zScore, currentRate, mean, std },
  }
}

export function evaluateLiquidationAftermath(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  params: ResolvedStrategyParams,
): StrategyDecision {
  const lookback = 24
  const minBars = lookback + 2
  if (index + 1 < minBars) {
    return {
      strategy: 'liquidationAftermath',
      signal: 0,
      reason: `Need at least ${minBars} bars.`,
      indicators: { bars: index + 1, requiredBars: minBars },
    }
  }

  const avgVolume = averageVolume(candles, index - 1, lookback)
  const currentVolume = candles[index].volume
  const volumeSurge = avgVolume > 0 ? currentVolume / avgVolume : 1
  const dropPct =
    ((candles[index].open - candles[index].low) / candles[index].open) * 100
  const risePct =
    ((candles[index].high - candles[index].open) / candles[index].open) * 100
  const barRange = ((candles[index].high - candles[index].low) / candles[index].open) * 100

  // Volume normalizing = cascade ending → exit signal for open positions
  const volNormalizing = volumeSurge < 1.5

  if (currentPosition === 0) {
    // Entry: volume surge + large directional move + reversal confirmation
    // Confirmation: price recovered from extreme (close above midpoint for long)
    const barMidpoint = (candles[index].high + candles[index].low) / 2
    const longSignal =
      volumeSurge >= params.cascadeMinVolSurge &&
      dropPct >= params.cascadeMinDropPct &&
      candles[index].close > barMidpoint // price recovered from lows

    const shortSignal =
      volumeSurge >= params.cascadeMinVolSurge &&
      risePct >= params.cascadeMinDropPct &&
      params.allowShort &&
      candles[index].close < barMidpoint // price fell from highs

    if (longSignal) {
      return {
        strategy: 'liquidationAftermath',
        signal: 1,
        reason: `Cascade long: vol=${volumeSurge.toFixed(1)}x, drop=${dropPct.toFixed(1)}%, range=${barRange.toFixed(1)}% (confirmed).`,
        indicators: { volumeSurge, dropPct, barRange, avgVolume, currentVolume },
      }
    }
    if (shortSignal) {
      return {
        strategy: 'liquidationAftermath',
        signal: -1,
        reason: `Cascade short: vol=${volumeSurge.toFixed(1)}x, rise=${risePct.toFixed(1)}% (confirmed).`,
        indicators: { volumeSurge, risePct, barRange, avgVolume, currentVolume },
      }
    }
    return {
      strategy: 'liquidationAftermath',
      signal: 0,
      reason: `No cascade: vol=${volumeSurge.toFixed(1)}x, drop=${dropPct.toFixed(1)}%.`,
      indicators: { volumeSurge, dropPct, avgVolume, currentVolume },
    }
  }

  // Volume normalization exit: cascade is over
  if (volNormalizing) {
    return {
      strategy: 'liquidationAftermath',
      signal: 0,
      reason: `Volume normalized (${volumeSurge.toFixed(1)}x). Cascade over.`,
      indicators: { volumeSurge },
    }
  }

  // Use the bar's close as proxy for current PnL reference
  // The actual stop-loss is handled by the backtest engine via cascadeStopLossPct
  // Here we provide a soft exit signal when momentum fades

  // Check for reversal failure: price made new low after cascade
  const newLow = candles[index].low < candles[index - 1].low
  if (currentPosition === 1 && newLow) {
    return {
      strategy: 'liquidationAftermath',
      signal: 0,
      reason: `Reversal failed: new low made. Exiting.`,
      indicators: { volumeSurge },
    }
  }
  const newHigh = candles[index].high > candles[index - 1].high
  if (currentPosition === -1 && newHigh) {
    return {
      strategy: 'liquidationAftermath',
      signal: 0,
      reason: `Reversal failed: new high made. Exiting.`,
      indicators: { volumeSurge },
    }
  }

  return {
    strategy: 'liquidationAftermath',
    signal: currentPosition,
    reason: `Holding cascade: vol=${volumeSurge.toFixed(1)}x.`,
    indicators: { volumeSurge, dropPct },
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
    case 'shockFade':
      return Math.max(169, getRegimeClassificationMinimumBars(resolved))
    case 'breakout':
      return breakoutBars
    case 'enhancedCarry':
      return resolved.carryMinFundingBars + 2
    case 'liquidationAftermath':
      return 26
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
    case 'shockFade':
      return evaluateShockFade(input.candles, input.index, input.currentPosition, resolved)
    case 'breakout':
      return evaluateBreakout(input.candles, input.index, input.currentPosition, resolved)
    case 'enhancedCarry':
      return evaluateEnhancedCarry(input.candles, input.index, input.currentPosition, resolved)
    case 'liquidationAftermath':
      return evaluateLiquidationAftermath(input.candles, input.index, input.currentPosition, resolved)
    case 'ensemble':
    default:
      return evaluateEnsemble(input.candles, input.index, input.currentPosition, resolved)
  }
}
