import { buildFactorSignal, clamp } from './helpers.js'
import type { FactorSignal } from './types.js'

export interface LiquidationAftermathInput {
  liquidationHistory?: { value: number; timestampMs: number }[]
  currentPrice: number
  return1hPct: number
  nowUtcMs?: number
}

const HOUR_MS = 60 * 60 * 1000
const EVENT_LOOKBACK_MS = 24 * HOUR_MS
const AFTERMATH_MIN_MS = 4 * HOUR_MS
const AFTERMATH_MAX_MS = 12 * HOUR_MS

export function evaluateLiquidationAftermath(
  input: LiquidationAftermathInput,
): FactorSignal | null {
  const history = input.liquidationHistory
  if (!history || history.length < 10) return null

  const now = input.nowUtcMs ?? Date.now()
  const observedHistory = history.filter(
    (h) =>
      Number.isFinite(h.value) &&
      Number.isFinite(h.timestampMs) &&
      h.timestampMs <= now,
  )
  const values = observedHistory.map((h) => h.value)
  if (values.length < 10) return null

  const sorted = [...values].sort((a, b) => a - b)
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]

  const recent24h = observedHistory.filter((h) => now - h.timestampMs <= EVENT_LOOKBACK_MS)
  const cumLiq24h = recent24h.reduce((s, h) => s + h.value, 0)
  const isEvent = cumLiq24h > p90 && p90 > 0

  if (!isEvent) {
    return buildFactorSignal({
      name: 'liquidation-aftermath',
      rawValue: 0,
      rawConfidence: 0,
      metadata: { cumLiq24h, p90, isEvent: 0 },
    })
  }

  const peakEntry = recent24h.reduce(
    (max, h) => (h.value > max.value ? h : max),
    recent24h[0],
  )
  const timeSincePeakMs = now - peakEntry.timestampMs

  if (timeSincePeakMs < AFTERMATH_MIN_MS || timeSincePeakMs > AFTERMATH_MAX_MS) {
    return buildFactorSignal({
      name: 'liquidation-aftermath',
      rawValue: 0,
      rawConfidence: 0,
      metadata: { cumLiq24h, p90, isEvent: 1, timeSincePeakMs, inWindow: 0 },
    })
  }

  const signal = clamp(-Math.sign(input.return1hPct) * (cumLiq24h / p90 - 1) / 3, -1, 1)
  const confidence = clamp((cumLiq24h / p90 - 1) / 2, 0, 1)

  return buildFactorSignal({
    name: 'liquidation-aftermath',
    rawValue: signal,
    rawConfidence: confidence,
    metadata: {
      cumLiq24h,
      p90,
      isEvent: 1,
      inWindow: 1,
      timeSincePeakMs,
      return1hPct: input.return1hPct,
    },
  })
}
