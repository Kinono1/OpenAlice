/**
 * Volume Breakout Strategy — minute-level momentum.
 *
 * Logic: when a 5m bar's volume exceeds N × trailing median volume AND
 * the price breaks above/below the recent range, enter in the breakout direction.
 *
 * Hold for a fixed number of bars (typically 3-6 bars = 15-30 min).
 * Exit on: hold expiry, opposite breakout, or stop-loss.
 */

export interface VolumeBreakoutConfig {
  /** Number of 5m bars for volume baseline (default 24 = 2 hours) */
  volumeLookbackBars: number
  /** Volume multiplier threshold (default 2.5) */
  volumeMultiplier: number
  /** Number of 5m bars for price range (default 12 = 1 hour) */
  rangeLookbackBars: number
  /** Hold for this many bars before auto-close (default 4 = 20 min) */
  holdBars: number
  /** Stop loss as fraction of entry price (default 0.005 = 0.5%) */
  stopLossPct: number
  /** Minimum volume in USD to consider the asset (default 100k) */
  minVolumeUsd: number
  /** Minimum close-through / candle-quality score. 0 disables the filter. */
  minBreakQuality: number
  /** Maximum spread in basis points when spread data is available. */
  maxSpreadBps: number
}

export interface VolumeBreakoutSignal {
  symbol: string
  signal: 1 | -1 | 0 // 1=long breakout, -1=short breakdown, 0=none
  confidence: number
  barTime: number
  entryPrice: number
  volumeRatio: number // current volume / median volume
  rangeBreakoutPct: number // how far price broke through range
  breakQuality: number
  liquidityUsd: number | null
  liquidityStatus: 'pass' | 'fail' | 'unknown'
  spreadBps: number | null
  spreadStatus: 'pass' | 'fail' | 'unknown'
  stopLossPrice: number
  reason: string
}

export const DEFAULT_VB_CONFIG: VolumeBreakoutConfig = {
  volumeLookbackBars: 12, // 1 hour
  volumeMultiplier: 0.8,
  rangeLookbackBars: 3, // 15 minutes
  holdBars: 2, // 10 minutes
  stopLossPct: 0.02, // 2.0%
  minVolumeUsd: 100_000,
  minBreakQuality: 0.01,
  maxSpreadBps: 40,
}

interface Bar {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolumeUsd?: number | null
  liquidityUsd?: number | null
  spreadBps?: number | null
  bid?: number | null
  ask?: number | null
}

const EMPTY_MARKET_QUALITY = {
  breakQuality: 0,
  liquidityUsd: null,
  liquidityStatus: 'unknown' as const,
  spreadBps: null,
  spreadStatus: 'unknown' as const,
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Evaluate volume breakout for a single asset at the latest bar */
export function evaluateVolumeBreakout(
  symbol: string,
  candles: Bar[],
  config: Partial<VolumeBreakoutConfig> = {},
): VolumeBreakoutSignal {
  const cfg = { ...DEFAULT_VB_CONFIG, ...config }
  const n = candles.length
  if (n < cfg.volumeLookbackBars + 2) {
    return { symbol, signal: 0, confidence: 0, barTime: 0, entryPrice: 0, volumeRatio: 0, rangeBreakoutPct: 0, ...EMPTY_MARKET_QUALITY, stopLossPrice: 0, reason: 'Insufficient bars' }
  }

  const latest = candles[n - 1]
  const prevVolumes: number[] = []
  for (let i = n - 2; i >= n - 1 - cfg.volumeLookbackBars; i--) {
    prevVolumes.push(candles[i].volume)
  }
  const medianVol = median(prevVolumes)
  if (medianVol <= 0) {
    return { symbol, signal: 0, confidence: 0, barTime: latest.timestamp, entryPrice: latest.close, volumeRatio: 0, rangeBreakoutPct: 0, ...EMPTY_MARKET_QUALITY, stopLossPrice: 0, reason: 'Zero median volume' }
  }

  const volumeRatio = latest.volume / medianVol
  const liquidity = resolveLiquidity(latest, cfg.minVolumeUsd)
  const spread = resolveSpread(latest, cfg.maxSpreadBps)
  if (volumeRatio < cfg.volumeMultiplier) {
    return { symbol, signal: 0, confidence: 0, barTime: latest.timestamp, entryPrice: latest.close, volumeRatio, rangeBreakoutPct: 0, breakQuality: 0, ...liquidity, ...spread, stopLossPrice: 0, reason: `Volume ratio ${volumeRatio.toFixed(1)} < ${cfg.volumeMultiplier}` }
  }
  if (liquidity.liquidityStatus === 'fail') {
    return { symbol, signal: 0, confidence: 0, barTime: latest.timestamp, entryPrice: latest.close, volumeRatio, rangeBreakoutPct: 0, breakQuality: 0, ...liquidity, ...spread, stopLossPrice: 0, reason: `Liquidity ${liquidity.liquidityUsd?.toFixed(0) ?? 'unknown'} USD < ${cfg.minVolumeUsd}` }
  }
  if (spread.spreadStatus === 'fail') {
    return { symbol, signal: 0, confidence: 0, barTime: latest.timestamp, entryPrice: latest.close, volumeRatio, rangeBreakoutPct: 0, breakQuality: 0, ...liquidity, ...spread, stopLossPrice: 0, reason: `Spread ${spread.spreadBps?.toFixed(1) ?? 'unknown'} bps > ${cfg.maxSpreadBps}` }
  }

  // Find recent price range (excluding current bar)
  let rangeHigh = -Infinity, rangeLow = Infinity
  for (let i = n - 2; i >= n - 1 - cfg.rangeLookbackBars; i--) {
    if (candles[i].high > rangeHigh) rangeHigh = candles[i].high
    if (candles[i].low < rangeLow) rangeLow = candles[i].low
  }

  const rangeSize = rangeHigh - rangeLow
  if (rangeSize <= 0) {
    return { symbol, signal: 0, confidence: 0, barTime: latest.timestamp, entryPrice: latest.close, volumeRatio, rangeBreakoutPct: 0, breakQuality: 0, ...liquidity, ...spread, stopLossPrice: 0, reason: 'Zero range' }
  }

  // Check breakout direction
  const breakoutUp = latest.close > rangeHigh
  const breakoutDown = latest.close < rangeLow

  if (breakoutUp) {
    const breakoutPct = (latest.close - rangeHigh) / rangeSize
    const breakQuality = computeBreakQuality(latest, 'long')
    if (breakQuality < cfg.minBreakQuality) {
      return { symbol, signal: 0, confidence: 0, barTime: latest.timestamp, entryPrice: latest.close, volumeRatio, rangeBreakoutPct: breakoutPct * 100, breakQuality, ...liquidity, ...spread, stopLossPrice: 0, reason: `Break quality ${breakQuality.toFixed(2)} < ${cfg.minBreakQuality}` }
    }
    const confidence = Math.min(volumeRatio / cfg.volumeMultiplier, 3) / 3 * Math.min(breakoutPct * 10, 1) * breakQuality
    const stopLoss = latest.close * (1 - cfg.stopLossPct)
    return {
      symbol, signal: 1, confidence,
      barTime: latest.timestamp, entryPrice: latest.close,
      volumeRatio, rangeBreakoutPct: breakoutPct * 100,
      breakQuality, ...liquidity, ...spread,
      stopLossPrice: stopLoss,
      reason: `Breakout up: vol ${volumeRatio.toFixed(1)}x, break ${(breakoutPct*100).toFixed(1)}% of range, quality ${breakQuality.toFixed(2)}, liquidity ${liquidity.liquidityStatus}, spread ${spread.spreadStatus}`,
    }
  }

  if (breakoutDown) {
    const breakoutPct = (rangeLow - latest.close) / rangeSize
    const breakQuality = computeBreakQuality(latest, 'short')
    if (breakQuality < cfg.minBreakQuality) {
      return { symbol, signal: 0, confidence: 0, barTime: latest.timestamp, entryPrice: latest.close, volumeRatio, rangeBreakoutPct: breakoutPct * 100, breakQuality, ...liquidity, ...spread, stopLossPrice: 0, reason: `Break quality ${breakQuality.toFixed(2)} < ${cfg.minBreakQuality}` }
    }
    const confidence = Math.min(volumeRatio / cfg.volumeMultiplier, 3) / 3 * Math.min(breakoutPct * 10, 1) * breakQuality
    const stopLoss = latest.close * (1 + cfg.stopLossPct)
    return {
      symbol, signal: -1, confidence,
      barTime: latest.timestamp, entryPrice: latest.close,
      volumeRatio, rangeBreakoutPct: breakoutPct * 100,
      breakQuality, ...liquidity, ...spread,
      stopLossPrice: stopLoss,
      reason: `Breakdown down: vol ${volumeRatio.toFixed(1)}x, break ${(breakoutPct*100).toFixed(1)}% of range, quality ${breakQuality.toFixed(2)}, liquidity ${liquidity.liquidityStatus}, spread ${spread.spreadStatus}`,
    }
  }

  return { symbol, signal: 0, confidence: 0, barTime: latest.timestamp, entryPrice: latest.close, volumeRatio, rangeBreakoutPct: 0, breakQuality: 0, ...liquidity, ...spread, stopLossPrice: 0, reason: 'No price breakout despite volume surge' }
}

function computeBreakQuality(bar: Bar, side: 'long' | 'short'): number {
  const range = bar.high - bar.low
  if (!Number.isFinite(range) || range <= 0) return 0
  const closeLocation = side === 'long'
    ? (bar.close - bar.low) / range
    : (bar.high - bar.close) / range
  const body = Math.abs(bar.close - bar.open) / range
  const directionalBody = side === 'long'
    ? bar.close > bar.open
    : bar.close < bar.open
  const bodyScore = directionalBody ? Math.min(1, body) : 0
  return Math.max(0, Math.min(1, closeLocation * 0.7 + bodyScore * 0.3))
}

function resolveLiquidity(
  bar: Bar,
  minVolumeUsd: number,
): Pick<VolumeBreakoutSignal, 'liquidityUsd' | 'liquidityStatus'> {
  const explicit = bar.liquidityUsd ?? bar.quoteVolumeUsd
  const inferred = Number.isFinite(explicit ?? NaN)
    ? explicit
    : bar.volume > 0 && bar.close > 0
      ? bar.volume * bar.close
      : null
  if (typeof inferred !== 'number' || !Number.isFinite(inferred) || inferred <= 0) {
    return { liquidityUsd: null, liquidityStatus: 'unknown' }
  }
  return {
    liquidityUsd: inferred,
    liquidityStatus: inferred >= minVolumeUsd ? 'pass' : 'fail',
  }
}

function resolveSpread(
  bar: Bar,
  maxSpreadBps: number,
): Pick<VolumeBreakoutSignal, 'spreadBps' | 'spreadStatus'> {
  const fromBidAsk = typeof bar.bid === 'number' && typeof bar.ask === 'number' && bar.bid > 0 && bar.ask >= bar.bid
    ? ((bar.ask - bar.bid) / ((bar.ask + bar.bid) / 2)) * 10_000
    : null
  const spreadBps = typeof bar.spreadBps === 'number' && Number.isFinite(bar.spreadBps)
    ? bar.spreadBps
    : fromBidAsk
  if (typeof spreadBps !== 'number' || !Number.isFinite(spreadBps)) {
    return { spreadBps: null, spreadStatus: 'unknown' }
  }
  return {
    spreadBps,
    spreadStatus: spreadBps <= maxSpreadBps ? 'pass' : 'fail',
  }
}

/** Evaluate breakout for multiple assets, return sorted by confidence */
export function evaluateMultiAssetBreakout(
  assets: Array<{ symbol: string; candles: Bar[] }>,
  config?: Partial<VolumeBreakoutConfig>,
): VolumeBreakoutSignal[] {
  return assets
    .map(a => evaluateVolumeBreakout(a.symbol, a.candles, config))
    .filter(s => s.signal !== 0)
    .sort((a, b) => b.confidence - a.confidence)
}
