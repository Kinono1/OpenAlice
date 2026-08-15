/**
 * Shared feature builder — computes features from OHLCV data.
 *
 * Same Builder principle: identical logic for BOTH historical training
 * and OKX live inference. PIT (Point-in-Time) enforcement ensures no
 * look-ahead bias.
 *
 * All features gracefully handle missing data by returning null.
 * Rows with feature_freshness < 0.8 are excluded from results.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface Bar {
  timestamp: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface FundingPoint {
  timestamp: string
  rate: number
}

export interface OIPoint {
  timestamp: string
  oi: number
}

export interface Features {
  ret_1h: number | null
  ret_4h: number | null
  ret_24h: number | null
  realized_vol_24h: number | null
  volume_z_24h: number | null
  funding_rate: number | null
  funding_z_30d: number | null
  oi_change_24h: number | null
  basis_bps: number | null
  btc_ret_24h: number | null
  market_dispersion: number | null
}

export interface FeatureRow {
  timestamp: string
  symbol: string
  features: Features
  metadata: {
    feature_freshness: number
    data_lag_ms: number
    decision_time: string
  }
}

export interface FeatureData {
  ohlcv: Map<string, Bar[]>
  funding?: Map<string, FundingPoint[]>
  oi?: Map<string, OIPoint[]>
  markPrice?: Map<string, Bar[]>
  spotPrice?: Map<string, Bar[]>
}

export interface BuildOptions {
  /** PIT constraint: all data timestamps must precede this. */
  decisionTime?: string
  /**
   * Minimum delay to account for data propagation.
   * Default: 0 for historical, 500ms for live.
   */
  forcedDelayMs?: number
}

// ─── Constants ────────────────────────────────────────────────────────────

const ALL_FEATURE_KEYS: (keyof Features)[] = [
  'ret_1h',
  'ret_4h',
  'ret_24h',
  'realized_vol_24h',
  'volume_z_24h',
  'funding_rate',
  'funding_z_30d',
  'oi_change_24h',
  'basis_bps',
  'btc_ret_24h',
  'market_dispersion',
]

const FRESHNESS_THRESHOLD = 0.8
const FUNDING_30D_PERIODS = 720

// ─── Utilities ────────────────────────────────────────────────────────────

function toMs(ts: string): number {
  return new Date(ts).getTime()
}

function fromMs(ms: number): string {
  return new Date(ms).toISOString()
}

export function mean(values: number[]): number {
  if (values.length === 0) return NaN
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]
  return sum / values.length
}

/** Sample standard deviation (ddof = 1). */
export function std(values: number[]): number {
  if (values.length < 2) return NaN
  const m = mean(values)
  let sumSq = 0
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - m
    sumSq += d * d
  }
  return Math.sqrt(sumSq / (values.length - 1))
}

function zScore(value: number, arr: number[]): number | null {
  const m = mean(arr)
  const s = std(arr)
  if (!Number.isFinite(s) || s === 0) return null
  return (value - m) / s
}

// ─── Data Preprocessing ───────────────────────────────────────────────────

interface TimestampedEntry<T> {
  item: T
  ms: number
}

function indexByMs<T extends { timestamp: string }>(
  map: Map<string, T[]> | undefined,
): Map<string, TimestampedEntry<T>[]> {
  const result = new Map<string, TimestampedEntry<T>[]>()
  if (!map) return result
  for (const [key, items] of map) {
    const entries = items
      .map(item => ({ item, ms: toMs(item.timestamp) }))
      .sort((a, b) => a.ms - b.ms)
    result.set(key, entries)
  }
  return result
}

/**
 * Return items with ms <= cutoffMs.
 * Returns the filtered array and the latest ms (or null if empty).
 */
function filterBefore<T>(entries: TimestampedEntry<T>[], cutoffMs: number) {
  const filtered: TimestampedEntry<T>[] = []
  let latestMs: number | null = null
  for (const e of entries) {
    if (e.ms <= cutoffMs) {
      filtered.push(e)
      latestMs = e.ms
    }
  }
  return { filtered, latestMs }
}

// ─── Feature Computation ──────────────────────────────────────────────────

/**
 * Compute all per-symbol features from pre-filtered (PIT-compliant) data arrays.
 *
 * btc_ret_24h and market_dispersion are filled in a second pass
 * and should not be relied on from this function.
 */
function computeSymbolFeatures(
  bars: Bar[],
  funding: FundingPoint[],
  oi: OIPoint[],
  markPrice: Bar[],
  spotPrice: Bar[],
): Features {
  const n = bars.length
  const VOL_WINDOW = 24

  const f: Features = {
    ret_1h: null,
    ret_4h: null,
    ret_24h: null,
    realized_vol_24h: null,
    volume_z_24h: null,
    funding_rate: null,
    funding_z_30d: null,
    oi_change_24h: null,
    basis_bps: null,
    btc_ret_24h: null,
    market_dispersion: null,
  }

  // ret_1h
  if (n >= 2) {
    const prev = bars[n - 2].close
    if (prev !== 0 && Number.isFinite(prev)) {
      f.ret_1h = (bars[n - 1].close - prev) / prev
    }
  }

  // ret_4h
  if (n >= 5) {
    const prev = bars[n - 5].close
    if (prev !== 0 && Number.isFinite(prev)) {
      f.ret_4h = (bars[n - 1].close - prev) / prev
    }
  }

  // ret_24h
  if (n >= 25) {
    const prev = bars[n - 25].close
    if (prev !== 0 && Number.isFinite(prev)) {
      f.ret_24h = (bars[n - 1].close - prev) / prev
    }
  }

  // realized_vol_24h: std of last 24 ret_1h values
  if (n >= VOL_WINDOW + 1) {
    const rets: number[] = []
    for (let i = n - VOL_WINDOW; i < n; i++) {
      const prev = bars[i - 1].close
      if (prev !== 0 && Number.isFinite(prev)) {
        rets.push((bars[i].close - prev) / prev)
      }
    }
    if (rets.length >= 2) {
      const v = std(rets)
      f.realized_vol_24h = Number.isFinite(v) ? v : null
    }
  }

  // volume_z_24h
  if (n >= VOL_WINDOW) {
    const volumes = new Array<number>(VOL_WINDOW)
    for (let i = 0; i < VOL_WINDOW; i++) volumes[i] = bars[n - VOL_WINDOW + i].volume
    const latestVolume = bars[n - 1].volume
    f.volume_z_24h = zScore(latestVolume, volumes)
  }

  // funding_rate
  if (funding.length >= 1) {
    f.funding_rate = funding[funding.length - 1].rate
  }

  // funding_z_30d
  if (funding.length >= FUNDING_30D_PERIODS) {
    const window = funding.slice(-FUNDING_30D_PERIODS)
    const rates = window.map(f => f.rate)
    const latestRate = window[window.length - 1].rate
    f.funding_z_30d = zScore(latestRate, rates)
  }

  // oi_change_24h
  if (oi.length >= 25) {
    const lastOi = oi[oi.length - 1].oi
    const prevOi = oi[oi.length - 25].oi
    if (prevOi !== 0 && Number.isFinite(prevOi)) {
      f.oi_change_24h = (lastOi - prevOi) / prevOi
    }
  }

  // basis_bps
  if (markPrice.length >= 1 && spotPrice.length >= 1) {
    const futures = markPrice[markPrice.length - 1].close
    const spot = spotPrice[spotPrice.length - 1].close
    if (spot !== 0 && Number.isFinite(spot)) {
      f.basis_bps = ((futures - spot) / spot) * 10000
    }
  }

  return f
}

// ─── Freshness ────────────────────────────────────────────────────────────

/**
 * Compute the fraction of non-null features out of the total possible features
 * given the available data sources.
 *
 * Features that can never be non-null (due to missing data sources or
 * fundamental constraints like btc_ret_24h being always null for BTC itself)
 * are excluded from the denominator.
 */
function computeMaxPossible(symbol: string, btcSymbol: string | undefined, hasFunding: boolean, hasOi: boolean, hasMarkAndSpot: boolean, multiSymbolHasRet24h: boolean): number {
  let count = 5 // ret_1h, ret_4h, ret_24h, realized_vol_24h, volume_z_24h — always possible from OHLCV
  if (hasFunding) count += 2 // funding_rate, funding_z_30d
  if (hasOi) count += 1 // oi_change_24h
  if (hasMarkAndSpot) count += 1 // basis_bps
  if (btcSymbol !== undefined && symbol !== btcSymbol) count += 1 // btc_ret_24h
  if (multiSymbolHasRet24h) count += 1 // market_dispersion
  return count
}

function computeFreshness(features: Features, maxPossible: number): number {
  if (maxPossible === 0) return 1
  let nonNull = 0
  for (const key of ALL_FEATURE_KEYS) {
    if (features[key] !== null) nonNull++
  }
  return nonNull / maxPossible
}

// ─── Main Entry Point ─────────────────────────────────────────────────────

/**
 * Compute feature matrix from OHLCV (and optional funding/OI/mark/spot) data.
 *
 * @param mode  'historical' — produces rows at every bar timestamp across all symbols
 *              'live'       — produces rows at a single decision time
 * @param symbols  list of symbol identifiers (e.g. ["BTCUSDT", "ETHUSDT"])
 * @param data     OHLCV bars and optional funding / OI / mark / spot data
 * @param options  optional config (decisionTime, forcedDelayMs)
 * @returns FeatureRow[]  — rows with freshness < 0.8 are excluded
 */
export function buildFeatureMatrix(
  mode: 'historical' | 'live',
  symbols: string[],
  data: FeatureData,
  options?: BuildOptions,
): FeatureRow[] {
  const forcedDelayMs = options?.forcedDelayMs ?? (mode === 'live' ? 500 : 0)

  // Determine decision timestamps
  const decisionTimestamps: string[] = []

  if (mode === 'live') {
    const dt = options?.decisionTime ?? new Date().toISOString()
    decisionTimestamps.push(dt)
  } else {
    // Historical: collect all unique, sorted bar timestamps from all symbols
    const tsSet = new Set<number>()
    for (const [, bars] of data.ohlcv) {
      for (const bar of bars) {
        tsSet.add(toMs(bar.timestamp))
      }
    }
    const sortedMs = Array.from(tsSet).sort((a, b) => a - b)
    for (const ms of sortedMs) {
      decisionTimestamps.push(fromMs(ms))
    }
  }

  // Pre-index all data by ms for fast filtering
  const ohlcvIdx = indexByMs(data.ohlcv)
  const fundingIdx = indexByMs(data.funding)
  const oiIdx = indexByMs(data.oi)
  const markPriceIdx = indexByMs(data.markPrice)
  const spotPriceIdx = indexByMs(data.spotPrice)

  const rows: FeatureRow[] = []

  for (const decisionTs of decisionTimestamps) {
    const cutoffMs = toMs(decisionTs) - forcedDelayMs
    const cutoffBeforeBoundaryMs = cutoffMs // already subtracted delay

    // Phase 1: per-symbol features
    const symbolFeats = new Map<string, Features>()
    const symbolLatestBarMs = new Map<string, number | null>()

    for (const symbol of symbols) {
      const barEntries = ohlcvIdx.get(symbol)
      if (!barEntries || barEntries.length === 0) {
        symbolFeats.set(symbol, {
          ret_1h: null, ret_4h: null, ret_24h: null,
          realized_vol_24h: null, volume_z_24h: null,
          funding_rate: null, funding_z_30d: null,
          oi_change_24h: null, basis_bps: null,
          btc_ret_24h: null, market_dispersion: null,
        })
        symbolLatestBarMs.set(symbol, null)
        continue
      }

      const { filtered: barsFiltered, latestMs } = filterBefore(barEntries, cutoffBeforeBoundaryMs)
      symbolLatestBarMs.set(symbol, latestMs)

      const bars = barsFiltered.map(e => e.item as Bar)

      const { filtered: fundFiltered } = filterBefore(fundingIdx.get(symbol) ?? [], cutoffBeforeBoundaryMs)
      const fundPoints = fundFiltered.map(e => e.item as FundingPoint)

      const { filtered: oiFiltered } = filterBefore(oiIdx.get(symbol) ?? [], cutoffBeforeBoundaryMs)
      const oiPoints = oiFiltered.map(e => e.item as OIPoint)

      const { filtered: markFiltered } = filterBefore(markPriceIdx.get(symbol) ?? [], cutoffBeforeBoundaryMs)
      const markBars = markFiltered.map(e => e.item as Bar)

      const { filtered: spotFiltered } = filterBefore(spotPriceIdx.get(symbol) ?? [], cutoffBeforeBoundaryMs)
      const spotBars = spotFiltered.map(e => e.item as Bar)

      const features = computeSymbolFeatures(bars, fundPoints, oiPoints, markBars, spotBars)
      symbolFeats.set(symbol, features)
    }

    // Phase 2: cross-sectional features

    // btc_ret_24h
    const btcSymbol = symbols.find(
      s => s.toLowerCase().startsWith('btc') || s.toLowerCase().includes('btc'),
    )
    const btcFeats = btcSymbol ? symbolFeats.get(btcSymbol) : undefined
    const btcRet24h = btcFeats?.ret_24h ?? null

    for (const [sym, feats] of symbolFeats) {
      feats.btc_ret_24h = sym === btcSymbol ? null : btcRet24h
    }

    // market_dispersion: std of ret_24h across all symbols
    const ret24hValues: number[] = []
    for (const [, feats] of symbolFeats) {
      if (feats.ret_24h !== null) ret24hValues.push(feats.ret_24h)
    }
    let marketDisp: number | null = null
    if (ret24hValues.length >= 2) {
      const d = std(ret24hValues)
      marketDisp = Number.isFinite(d) ? d : null
    }
    for (const [, feats] of symbolFeats) {
      feats.market_dispersion = marketDisp
    }

    // Phase 3: build rows, filter by freshness
    const hasAnyFunding = fundingIdx.size > 0
    const hasAnyOi = oiIdx.size > 0
    const hasAnyMarkPrice = markPriceIdx.size > 0
    const hasAnySpotPrice = spotPriceIdx.size > 0
    const multiSymbolHasRet24h = ret24hValues.length >= 2

    for (const symbol of symbols) {
      const feats = symbolFeats.get(symbol)
      if (!feats) continue

      const symHasFunding = hasAnyFunding && (fundingIdx.get(symbol)?.length ?? 0) > 0
      const symHasOi = hasAnyOi && (oiIdx.get(symbol)?.length ?? 0) > 0
      const symHasMarkAndSpot = hasAnyMarkPrice && hasAnySpotPrice &&
        (markPriceIdx.get(symbol)?.length ?? 0) > 0 &&
        (spotPriceIdx.get(symbol)?.length ?? 0) > 0
      const maxPossible = computeMaxPossible(symbol, btcSymbol, symHasFunding, symHasOi, symHasMarkAndSpot, multiSymbolHasRet24h)
      const freshness = computeFreshness(feats, maxPossible)
      if (freshness < FRESHNESS_THRESHOLD) continue

      const latestMs = symbolLatestBarMs.get(symbol) ?? null
      const dataLagMs = latestMs !== null ? cutoffBeforeBoundaryMs - latestMs : 0

      rows.push({
        timestamp: decisionTs,
        symbol,
        features: {
          ret_1h: feats.ret_1h,
          ret_4h: feats.ret_4h,
          ret_24h: feats.ret_24h,
          realized_vol_24h: feats.realized_vol_24h,
          volume_z_24h: feats.volume_z_24h,
          funding_rate: feats.funding_rate,
          funding_z_30d: feats.funding_z_30d,
          oi_change_24h: feats.oi_change_24h,
          basis_bps: feats.basis_bps,
          btc_ret_24h: feats.btc_ret_24h,
          market_dispersion: feats.market_dispersion,
        },
        metadata: {
          feature_freshness: freshness,
          data_lag_ms: Math.max(0, dataLagMs),
          decision_time: decisionTs,
        },
      })
    }
  }

  return rows
}
