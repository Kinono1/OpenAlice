import type { CryptoPlaceOrderRequest, OperationAction } from '../domain/trading/operation-dispatcher.types.js'

export type DataQualityState = 'good' | 'degraded' | 'bad' | 'unknown'

export type DataQualityGateAction =
  | 'allow'
  | 'block_new_orders'
  | 'cancel_only_hold'
  | 'allow_reduce_with_protected_limit'
  | 'manual_override_required'

export interface DataQualityOrderGateInput {
  state: DataQualityState
  action: OperationAction
  order?: Pick<CryptoPlaceOrderRequest, 'type' | 'reduceOnly' | 'price'>
  hasIndependentTrustedPrice?: boolean
  manualOverride?: boolean
  reason?: string
}

export interface DataQualityOrderGateDecision {
  approved: boolean
  action: DataQualityGateAction
  reason: string
}

export interface OhlcvCandleLike {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface CandleDataQualityOptions {
  expectedIntervalMs?: number
  minBars?: number
  maxStalenessMs?: number
  maxGapRatio?: number
  maxInvalidRatio?: number
  maxBarRangePct?: number
  now?: Date
}

export interface CandleDataQualityReport {
  symbol: string
  state: DataQualityState
  barCount: number
  startTime: string | null
  endTime: string | null
  expectedIntervalMs: number
  staleHours: number | null
  duplicateTimestamps: number
  nonMonotonicTimestamps: number
  gapCount: number
  maxGapHours: number
  invalidOhlcvCount: number
  zeroVolumeCount: number
  reasons: string[]
}

export function evaluateDataQualityOrderGate(
  input: DataQualityOrderGateInput,
): DataQualityOrderGateDecision {
  if (input.state === 'good') {
    return {
      approved: true,
      action: 'allow',
      reason: 'data_quality_good',
    }
  }

  if (input.action === 'cancelOrder') {
    return {
      approved: true,
      action: 'cancel_only_hold',
      reason: buildReason(input, 'data_quality_allows_cancel_only'),
    }
  }

  const isReduceOnly = input.order?.reduceOnly === true
  const isProtectedLimit =
    input.order?.type === 'limit' &&
    typeof input.order.price === 'number' &&
    Number.isFinite(input.order.price) &&
    input.order.price > 0

  if (input.state === 'degraded') {
    if (isReduceOnly && isProtectedLimit && input.hasIndependentTrustedPrice === true) {
      return {
        approved: true,
        action: 'allow_reduce_with_protected_limit',
        reason: buildReason(input, 'data_quality_degraded_reduce_only_protected_limit'),
      }
    }
    return {
      approved: false,
      action: isReduceOnly ? 'manual_override_required' : 'block_new_orders',
      reason: buildReason(input, isReduceOnly
        ? 'data_quality_degraded_reduce_requires_protected_limit_and_trusted_price'
        : 'data_quality_degraded_blocks_new_orders'),
    }
  }

  if (input.manualOverride === true && isReduceOnly && isProtectedLimit && input.hasIndependentTrustedPrice === true) {
    return {
      approved: true,
      action: 'allow_reduce_with_protected_limit',
      reason: buildReason(input, 'data_quality_bad_manual_reduce_only_protected_limit'),
    }
  }

  return {
    approved: false,
    action: 'cancel_only_hold',
    reason: buildReason(input, 'data_quality_bad_cancel_only_hold'),
  }
}

export function evaluateCandleDataQuality(
  symbol: string,
  candles: OhlcvCandleLike[],
  options: CandleDataQualityOptions = {},
): CandleDataQualityReport {
  const expectedIntervalMs = options.expectedIntervalMs ?? 3_600_000
  const minBars = options.minBars ?? 120
  const maxStalenessMs = options.maxStalenessMs ?? 6 * expectedIntervalMs
  const maxGapRatio = options.maxGapRatio ?? 0.01
  const maxInvalidRatio = options.maxInvalidRatio ?? 0
  const maxBarRangePct = options.maxBarRangePct ?? 0.5
  const nowMs = (options.now ?? new Date()).getTime()
  const reasons: string[] = []

  if (candles.length === 0) {
    return {
      symbol,
      state: 'bad',
      barCount: 0,
      startTime: null,
      endTime: null,
      expectedIntervalMs,
      staleHours: null,
      duplicateTimestamps: 0,
      nonMonotonicTimestamps: 0,
      gapCount: 0,
      maxGapHours: 0,
      invalidOhlcvCount: 0,
      zeroVolumeCount: 0,
      reasons: ['no_candles'],
    }
  }

  let duplicateTimestamps = 0
  let nonMonotonicTimestamps = 0
  let gapCount = 0
  let maxGapMs = 0
  let invalidOhlcvCount = 0
  let zeroVolumeCount = 0
  const seen = new Set<number>()

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]
    const fields = [
      candle.time,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
    ]
    const finite = fields.every((value) => Number.isFinite(value))
    const positivePrices =
      candle.open > 0 &&
      candle.high > 0 &&
      candle.low > 0 &&
      candle.close > 0
    const coherentRange =
      candle.high >= candle.low &&
      candle.high >= Math.max(candle.open, candle.close) &&
      candle.low <= Math.min(candle.open, candle.close)
    const rangePct = candle.low > 0 ? candle.high / candle.low - 1 : Number.POSITIVE_INFINITY
    const rangeReasonable = rangePct <= maxBarRangePct

    if (!finite || !positivePrices || !coherentRange || !rangeReasonable || candle.volume < 0) {
      invalidOhlcvCount++
    }
    if (candle.volume === 0) zeroVolumeCount++
    if (seen.has(candle.time)) duplicateTimestamps++
    seen.add(candle.time)

    const previous = candles[i - 1]
    if (!previous) continue
    const delta = candle.time - previous.time
    if (delta <= 0) {
      nonMonotonicTimestamps++
      continue
    }
    if (delta > expectedIntervalMs * 1.5) {
      gapCount++
      maxGapMs = Math.max(maxGapMs, delta)
    }
  }

  const first = candles[0]
  const last = candles[candles.length - 1]
  const staleMs = nowMs - last.time
  const staleHours = Number.isFinite(staleMs) ? staleMs / 3_600_000 : null
  const invalidRatio = invalidOhlcvCount / candles.length
  const gapRatio = gapCount / Math.max(candles.length - 1, 1)

  if (candles.length < minBars) reasons.push(`insufficient_bars:${candles.length}<${minBars}`)
  if (duplicateTimestamps > 0) reasons.push(`duplicate_timestamps:${duplicateTimestamps}`)
  if (nonMonotonicTimestamps > 0) reasons.push(`non_monotonic_timestamps:${nonMonotonicTimestamps}`)
  if (gapRatio > maxGapRatio) reasons.push(`gap_ratio:${gapRatio.toFixed(4)}>${maxGapRatio}`)
  if (invalidRatio > maxInvalidRatio) reasons.push(`invalid_ohlcv_ratio:${invalidRatio.toFixed(4)}>${maxInvalidRatio}`)
  if (staleMs > maxStalenessMs) reasons.push(`stale:${Math.round(staleMs / 3_600_000)}h`)
  if (staleMs < -expectedIntervalMs) reasons.push(`future_timestamp:${Math.round(Math.abs(staleMs) / 3_600_000)}h`)

  const hardBad =
    candles.length < minBars ||
    invalidRatio > Math.max(maxInvalidRatio, 0.001) ||
    nonMonotonicTimestamps > 0 ||
    duplicateTimestamps > 0

  const state: DataQualityState = hardBad
    ? 'bad'
    : reasons.length > 0
      ? 'degraded'
      : 'good'

  return {
    symbol,
    state,
    barCount: candles.length,
    startTime: new Date(first.time).toISOString(),
    endTime: new Date(last.time).toISOString(),
    expectedIntervalMs,
    staleHours,
    duplicateTimestamps,
    nonMonotonicTimestamps,
    gapCount,
    maxGapHours: maxGapMs / 3_600_000,
    invalidOhlcvCount,
    zeroVolumeCount,
    reasons,
  }
}

function buildReason(input: DataQualityOrderGateInput, code: string): string {
  return input.reason ? `${code}:${input.reason}` : code
}
