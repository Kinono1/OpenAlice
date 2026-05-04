import { buildFactorSignal, clamp, safeZScore } from './helpers.js'
import type { FactorSignal } from './types.js'

export interface MeanReversionInput {
  closes: number[]
  lookback?: number
  seriesKind?: 'raw_price' | 'stationary_spread' | 'fractional_diff' | 'funding' | 'basis'
  allowRawPrice?: boolean
}

const DEFAULT_LOOKBACK = 48

export function evaluateMeanReversion(input: MeanReversionInput): FactorSignal {
  const lookback = input.lookback ?? DEFAULT_LOOKBACK
  const closes = input.closes

  if (closes.length < lookback + 1) {
    return buildFactorSignal({
      name: 'mean-reversion',
      rawValue: 0,
      rawConfidence: 0,
      metadata: { reason: 'insufficient_data', barsAvailable: closes.length, lookback },
    })
  }

  const window = closes.slice(-lookback)
  const sma = window.reduce((s, v) => s + v, 0) / window.length
  const variance = window.reduce((s, v) => s + (v - sma) ** 2, 0) / window.length
  const std = Math.sqrt(Math.max(variance, 0))
  const current = closes[closes.length - 1]
  const zScore = safeZScore(current, sma, std)
  const clampedZ = clamp(zScore, -3, 3)
  const signal = clamp(-clampedZ / 3, -1, 1)

  const rsi = computeRsi(closes, Math.min(14, Math.floor(lookback / 3)))
  const rsiDeviation = (rsi - 50) / 50
  const rsiConfirm = Math.abs(rsiDeviation) > 0.3 && Math.sign(rsiDeviation) === Math.sign(clampedZ) ? 1 : 0

  const confidence = clamp(
    (Math.abs(clampedZ) / 3) * (0.7 + 0.3 * rsiConfirm),
    0,
    1,
  )
  const seriesKind = input.seriesKind ?? 'raw_price'
  const stationaritySafe =
    input.allowRawPrice === true ||
    seriesKind === 'stationary_spread' ||
    seriesKind === 'fractional_diff' ||
    seriesKind === 'funding' ||
    seriesKind === 'basis'

  return buildFactorSignal({
    name: 'mean-reversion',
    role: stationaritySafe ? 'alpha' : 'diagnostic',
    rawValue: stationaritySafe ? signal : 0,
    rawConfidence: stationaritySafe ? confidence : 0,
    metadata: {
      bollingerZScore: zScore,
      rawMeanReversionSignal: signal,
      rawMeanReversionConfidence: confidence,
      sma,
      std,
      rsi,
      rsiDeviation,
      rsiConfirm,
      lookback,
      seriesKind,
      stationaritySafe,
      reason: stationaritySafe ? null : 'nonstationary_raw_price_disabled',
    },
  })
}

function computeRsi(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50
  const changes: number[] = []
  const start = closes.length - period - 1
  for (let i = start + 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1])
  }
  let avgGain = 0, avgLoss = 0
  for (const c of changes) {
    if (c > 0) avgGain += c
    else avgLoss += Math.abs(c)
  }
  avgGain /= period
  avgLoss /= period
  if (avgLoss < 1e-12) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}
