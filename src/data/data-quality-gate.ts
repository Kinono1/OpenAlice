export interface DataQualityReport {
  symbol: string
  missing_bar_rate: number
  duplicate_bar_count: number
  zero_volume_rate: number
  extreme_return_count: number
  stale_price_detected: boolean
  spread_anomaly?: boolean
  verdict: 'PASS' | 'WARN' | 'BLOCK' | 'STALE'
}

export interface DataQualityConfig {
  maxMissingBarRate: number     // default 0.01 (1%)
  maxMissingBarRateBlock: number // default 0.05 (5%)
  maxZeroVolumeRate: number     // default 0.05 (5%)
  extremeReturnSigma: number    // default 10
  staleBarCount: number         // default 5 (consecutive same price)
}

const DEFAULT_CONFIG: DataQualityConfig = {
  maxMissingBarRate: 0.01,
  maxMissingBarRateBlock: 0.05,
  maxZeroVolumeRate: 0.05,
  extremeReturnSigma: 10,
  staleBarCount: 5,
}

interface OHLCVBar {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export function evaluateDataQuality(
  symbol: string,
  bars: OHLCVBar[],
  config: Partial<DataQualityConfig> = {},
): DataQualityReport {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const n = bars.length
  if (n === 0) {
    return { symbol, missing_bar_rate: 1, duplicate_bar_count: 0, zero_volume_rate: 0,
      extreme_return_count: 0, stale_price_detected: true, verdict: 'BLOCK' }
  }

  // Missing bars (expected uniform interval)
  let gapCount = 0
  if (n >= 2) {
    const expectedInterval = (bars[n - 1].timestamp - bars[0].timestamp) / (n - 1)
    for (let i = 1; i < n; i++) {
      const gap = bars[i].timestamp - bars[i - 1].timestamp
      if (gap > expectedInterval * 1.5) gapCount++
    }
  }
  const missing_bar_rate = gapCount / n

  // Duplicate timestamps
  const timestamps = new Set<number>()
  let duplicate_bar_count = 0
  for (const bar of bars) {
    if (timestamps.has(bar.timestamp)) duplicate_bar_count++
    timestamps.add(bar.timestamp)
  }

  // Zero volume
  const zeroVolCount = bars.filter(b => b.volume === 0).length
  const zero_volume_rate = zeroVolCount / n

  // Extreme returns (> N sigma)
  let extreme_return_count = 0
  if (n >= 2) {
    const returns: number[] = []
    for (let i = 1; i < n; i++) {
      if (bars[i - 1].close > 0) returns.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close)
    }
    if (returns.length > 0) {
      const mean = returns.reduce((s, v) => s + v, 0) / returns.length
      const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length
      const std = Math.sqrt(variance)
      if (std > 0) {
        extreme_return_count = returns.filter(r => Math.abs(r - mean) > cfg.extremeReturnSigma * std).length
      }
    }
  }

  // Stale price (consecutive same close)
  let staleCount = 0
  let maxStale = 0
  for (let i = 1; i < n; i++) {
    if (bars[i].close === bars[i - 1].close) {
      staleCount++
      maxStale = Math.max(maxStale, staleCount)
    } else {
      staleCount = 0
    }
  }
  const stale_price_detected = maxStale >= cfg.staleBarCount

  // Verdict
  let verdict: DataQualityReport['verdict'] = 'PASS'
  if (missing_bar_rate > cfg.maxMissingBarRateBlock) verdict = 'BLOCK'
  else if (missing_bar_rate > cfg.maxMissingBarRate) verdict = 'WARN'
  if (zero_volume_rate > cfg.maxZeroVolumeRate) {
    verdict = verdict === 'BLOCK' ? 'BLOCK' : 'WARN'
  }
  if (stale_price_detected && verdict !== 'BLOCK') {
    verdict = 'STALE'
  }

  return {
    symbol, missing_bar_rate, duplicate_bar_count, zero_volume_rate,
    extreme_return_count, stale_price_detected, verdict,
  }
}
