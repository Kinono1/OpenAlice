import type { OhlcvData } from '../../../analysis/indicator/types.js'
import { safeZScore } from '../../factors/helpers.js'
import type { HmmObservation, RegimeHmmConfig } from './types.js'

function standardDeviation(values: number[]): number {
  if (values.length === 0) {
    return 0
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(Math.max(variance, 0))
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function rollingZScore(
  values: number[],
  index: number,
  window: number,
): number {
  const start = Math.max(0, index - window + 1)
  const slice = values.slice(start, index + 1)
  return safeZScore(values[index], mean(slice), standardDeviation(slice))
}

export function extractHmmObservations(
  candles: OhlcvData[],
  config: Pick<
    RegimeHmmConfig,
    'realizedVolWindow' | 'volumeBaselineWindow' | 'zScoreWindow'
  >,
): HmmObservation[] {
  if (candles.length < 2) {
    return []
  }

  const returns: number[] = []
  const realizedVolSeries: number[] = []
  const volumeChangeSeries: number[] = []

  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index]
    const previous = candles[index - 1]
    const return1h = previous.close > 0 ? (current.close - previous.close) / previous.close : 0
    returns.push(return1h)

    const volStart = Math.max(0, returns.length - config.realizedVolWindow)
    const returnWindow = returns.slice(volStart)
    realizedVolSeries.push(standardDeviation(returnWindow))

    const volumeWindow = candles
      .slice(Math.max(0, index - config.volumeBaselineWindow), index)
      .map((candle) => candle.volume ?? 0)
      .filter((value) => Number.isFinite(value))
    const baselineVolume = mean(volumeWindow)
    const currentVolume = current.volume ?? 0
    volumeChangeSeries.push(
      baselineVolume > 0 ? (currentVolume - baselineVolume) / baselineVolume : 0,
    )
  }

  return returns.map((value, index) => ({
    return1h: rollingZScore(returns, index, config.zScoreWindow),
    realizedVol: rollingZScore(realizedVolSeries, index, config.zScoreWindow),
    volumeChangeRate: rollingZScore(volumeChangeSeries, index, config.zScoreWindow),
    sourceIndex: index + 1,
    sourceDate: candles[index + 1]?.date,
  }))
}
