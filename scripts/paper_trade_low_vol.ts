/**
 * Low-Vol Strategy — Enhanced Paper Decision Lane.
 *
 * Flow:
 *   1. Read daily low-vol rank report from data/research/daily_low_vol_rank_report.json
 *   2. Read Risk Filter from data/runtime/no_trade_risk_filter.latest.json
 *   3. Load OHLCV 1h data from data/market/live_accumulated/ for all symbols
 *   4. Compute per-symbol analytics (vol, volume, correlation, percentiles)
 *   5. Pass through quality gate
 *   6. Generate enhanced signals with quality metrics
 *   7. Build portfolio allocation with constraints:
 *      - Max position size: 20%
 *      - Max sector exposure: 40%
 *      - Min diversification: >= 3 sectors
 *   8. (Optional --simulate) Backtest last 60d portfolio vs BTC buy-hold
 *   9. Output to data/runtime/low_vol_paper_decision.latest.json
 *
 * Usage:
 *   npx tsx scripts/paper_trade_low_vol.ts
 *   npx tsx scripts/paper_trade_low_vol.ts --simulate
 *
 * This is a research-only lane. No exchange leverage or live-money execution.
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

// ==================== Types ====================

interface RankReportEntry {
  symbol: string
  vol_21d: number
  price: number
}

/** Entry in the new adaptive-vol signals array. */
interface SignalEntry {
  symbol: string
  vol: number
  price: number
  weight: number
  volume_usdt: number
}

/** Adaptive volatility parameters from the backtest. */
interface AdaptiveParams {
  vol_window_selected: number
  win_rate_365d: number
}

interface DailyLowVolRankReport {
  status: string
  generated_at: string
  date: string
  n_mainstream_symbols: number
  n_symbols_with_data: number
  btc_vol_21d: number
  btc_vol_percentile: number
  buy_candidates: RankReportEntry[]
  avoid: RankReportEntry[]
  adaptive_params?: AdaptiveParams
  signals?: {
    long: SignalEntry[]
    short: SignalEntry[]
  }
  note?: string
}

interface RiskFilterCheck {
  found: boolean
  value: string
  verdict: 'pass' | 'block'
}

interface NoTradeRiskFilter {
  schemaVersion: number
  generatedAt: string
  researchOnly: boolean
  diagnosticOnly: boolean
  promotionEligible: boolean
  paperTradingAllowed: boolean
  liveTradingAllowed: boolean
  executionAllowed: boolean
  status: 'pass' | 'block'
  mode: string
  checks: Record<string, RiskFilterCheck>
  summary: {
    blockCount: number
    totalChecks: number
    blocked: boolean
    primaryReason: string
  }
  blockers?: string[]
}

/** Per-coin quality metrics computed from cross-sectional data. */
interface SignalQualityMetrics {
  vol_percentile: number      // 0..1 rank among all coins (0 = lowest vol)
  volume_percentile: number   // 0..1 rank among all coins (0 = lowest volume)
  signal_strength: number     // confidence × (1 - vol_percentile)
  diversification_score: number // avg abs pairwise correlation with other selected coins
}

interface LowVolSignal {
  symbol: string
  direction: 'long' | 'short'
  confidence: number
  reason: string
  quality_metrics: SignalQualityMetrics
}

/** Portfolio allocation entry. */
interface PortfolioAllocationEntry {
  symbol: string
  direction: 'long' | 'short'
  target_weight: number       // signed weight, sum(|weight|) = 1.0
  sector: string
  confidence: number
  signal_strength: number
}

interface PortfolioAllocation {
  entries: PortfolioAllocationEntry[]
  total_sectors: number
  sectors_represented: string[]
  constraints_applied: string[]  // which constraints were active
  expected_portfolio_vol: number | null   // annualized, from cov matrix
  expected_portfolio_return: number | null // annualized, from weighted signals
  expected_sharpe: number | null
}

interface SimulationResult {
  portfolio_cumulative_return: number
  portfolio_annualized_return: number
  portfolio_annualized_vol: number
  portfolio_sharpe: number
  btc_cumulative_return: number
  btc_annualized_return: number
  btc_annualized_vol: number
  btc_sharpe: number
  portfolio_vs_btc_return_ratio: number
  n_days: number
  date_range: { start: string; end: string }
}

interface LowVolPaperDecision {
  schemaVersion: number
  generatedAt: string
  researchOnly: boolean
  executionAllowed: boolean
  paperTradingAllowed: boolean
  liveTradingAllowed: boolean
  signals: LowVolSignal[]
  portfolio_allocation: PortfolioAllocation | null
  simulation: SimulationResult | null
  riskFilterPassed: boolean
  riskFilterStatus: string | null
  rankReportDate: string | null
  blockers: string[]
  notes: string[]
}

// ==================== Constants ====================

const RANK_REPORT_PATH = join(
  import.meta.dirname ?? '.', '..',
  'data', 'research', 'daily_low_vol_rank_report.json',
)

const RISK_FILTER_PATH = join(
  import.meta.dirname ?? '.', '..',
  'data', 'runtime', 'no_trade_risk_filter.latest.json',
)

const OUTPUT_PATH = join(
  import.meta.dirname ?? '.', '..',
  'data', 'runtime', 'low_vol_paper_decision.latest.json',
)

const MARKET_DATA_DIR = join(
  import.meta.dirname ?? '.', '..',
  'data', 'market', 'live_accumulated',
)

const MIN_BUY_CANDIDATES = 3
const MIN_CONFIDENCE = 0.5
const MAX_CONFIDENCE = 0.95

/** Portfolio constraints. */
const MAX_POSITION_WEIGHT = 0.20
const MAX_SECTOR_EXPOSURE = 0.40
const MIN_SECTORS = 3

/** Days of returns used for correlation and simulation. */
const CORRELATION_LOOKBACK_DAYS = 60
const VOL_LOOKBACK_DAYS = 21

/**
 * Sector mapping for the 34 mainstream symbols.
 * Derived from strategy_multi_asset_report.json groups and domain knowledge.
 * Broad categories: L1, L2, DeFi, Meme, CEX, AI, Storage, Infra, Modular, Ordinals
 */
const SECTOR_MAP: Record<string, string> = {
  // Layer 1 — Smart Contract Platforms
  BTCUSDT: 'L1',
  ETHUSDT: 'L1',
  SOLUSDT: 'L1',
  ADAUSDT: 'L1',
  AVAXUSDT: 'L1',
  NEARUSDT: 'L1',
  TRXUSDT: 'L1',
  ATOMUSDT: 'L1',
  DOTUSDT: 'L1',
  APTUSDT: 'L1',
  SUIUSDT: 'L1',
  TONUSDT: 'L1',
  ETCUSDT: 'L1',
  // Payment / Settlement coins
  BCHUSDT: 'Payments',
  LTCUSDT: 'Payments',
  XRPUSDT: 'Payments',
  // Layer 2 Scaling
  ARBUSDT: 'L2',
  OPUSDT: 'L2',
  POLUSDT: 'L2',
  // Decentralized Finance
  UNIUSDT: 'DeFi',
  AAVEUSDT: 'DeFi',
  MKRUSDT: 'DeFi',
  INJUSDT: 'DeFi',
  LINKUSDT: 'DeFi',
  JUPUSDT: 'DeFi',
  // Meme
  DOGEUSDT: 'Meme',
  SHIBUSDT: 'Meme',
  PEPEUSDT: 'Meme',
  WIFUSDT: 'Meme',
  // Exchange
  BNBUSDT: 'CEX',
  // AI
  WLDUSDT: 'AI',
  // Storage / Data
  FILUSDT: 'Storage',
  // Infrastructure
  SEIUSDT: 'Infra',
  // Modular
  TIAUSDT: 'Modular',
  // Ordinals / Bitcoin Ecosystem
  ORDIUSDT: 'Ordinals',
}

// ==================== CSV Parser ====================

interface OhlcvRow {
  timestamp: number
  datetime: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  symbol: string
}

function parseCsvRow(line: string): OhlcvRow | null {
  const cols = line.split(',')
  if (cols.length < 10) return null
  // CSV: timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange
  const ts = Number(cols[0])
  if (isNaN(ts)) return null
  const open = Number(cols[2])
  const high = Number(cols[3])
  const low = Number(cols[4])
  const close = Number(cols[5])
  const volume = Number(cols[6])
  const symbol = cols[7].replace(/^"(.*)"$/, '$1') // strip quotes if present
  if (isNaN(close) || close <= 0) return null
  return {
    timestamp: ts,
    datetime: cols[1].replace(/^"(.*)"$/, '$1'),
    open,
    high,
    low,
    close,
    volume: isNaN(volume) ? 0 : volume,
    symbol,
  }
}

/** Extract base symbol from OHLCV symbol field, e.g., "BTC_USDT_USDT" => "BTCUSDT". */
function baseSymbolFromOhlcvSymbol(ohlcvSymbol: string): string {
  return ohlcvSymbol.split('_')[0] + 'USDT'
}

// ==================== Statistics Utilities ====================

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

function stddev(values: number[], avg?: number): number {
  if (values.length < 2) return 0
  const m = avg ?? mean(values)
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length)
  if (n < 3) return 0
  const xSlice = x.slice(-n)
  const ySlice = y.slice(-n)
  const mx = mean(xSlice)
  const my = mean(ySlice)
  const sx = stddev(xSlice, mx)
  const sy = stddev(ySlice, my)
  if (sx === 0 || sy === 0) return 0
  const cov = xSlice.reduce((s, xi, i) => s + (xi - mx) * (ySlice[i] - my), 0) / (n - 1)
  return cov / (sx * sy)
}

/** Compute percentile rank (0..1) of a value in an array.
 *  0 = lowest value gets 0, highest gets 1. */
function percentileRank(value: number, sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0.5
  if (sortedValues.length === 1) return sortedValues[0] === value ? 0.5 : 0
  // Find position in sorted array
  let countBelow = 0
  for (const v of sortedValues) {
    if (v < value) countBelow++
  }
  // Linear interpolation for ties
  let countEqual = 0
  for (const v of sortedValues) {
    if (v === value) countEqual++
  }
  if (countEqual === sortedValues.length) return 0.5
  return (countBelow + countEqual / 2) / sortedValues.length
}

// ==================== Data Loaders ====================

async function loadRankReport(): Promise<DailyLowVolRankReport | null> {
  try {
    const raw = await readFile(RANK_REPORT_PATH, 'utf-8')
    const report = JSON.parse(raw) as DailyLowVolRankReport
    // Prefer new signals.long format, fallback to buy_candidates
    const hasSignals = report.signals?.long && Array.isArray(report.signals.long)
    if (!hasSignals && (!report.buy_candidates || !Array.isArray(report.buy_candidates))) {
      console.error('  Rank report missing signals.long or buy_candidates array')
      return null
    }
    return report
  } catch (err) {
    console.error('  Failed to read rank report:', (err as Error).message)
    return null
  }
}

async function loadRiskFilter(): Promise<NoTradeRiskFilter | null> {
  try {
    const raw = await readFile(RISK_FILTER_PATH, 'utf-8')
    return JSON.parse(raw) as NoTradeRiskFilter
  } catch (err) {
    console.error('  Failed to read risk filter:', (err as Error).message)
    return null
  }
}

// ==================== OHLCV Data Loader ====================

interface DailyBar {
  date: string       // YYYY-MM-DD
  close: number
  volume: number
}

interface SymbolData {
  baseSymbol: string    // e.g. "BTCUSDT"
  dailyBars: DailyBar[]
  dailyReturns: number[]  // aligned with dailyBars[1..n]
}

async function loadAllOhlcvData(): Promise<Map<string, SymbolData>> {
  const symbolDataMap = new Map<string, SymbolData>()

  if (!existsSync(MARKET_DATA_DIR)) {
    console.warn(`  Market data dir not found: ${MARKET_DATA_DIR}`)
    return symbolDataMap
  }

  const files = await readdir(MARKET_DATA_DIR)
  const csvFiles = files.filter(f => f.endsWith('_1h.csv'))
  console.log(`  Found ${csvFiles.length} 1h CSV files`)

  let loaded = 0
  for (const file of csvFiles) {
    const filePath = join(MARKET_DATA_DIR, file)
    try {
      const content = await readFile(filePath, 'utf-8')
      const lines = content.trim().split('\n')
      if (lines.length < 2) continue

      const rows: OhlcvRow[] = []
      for (let i = 1; i < lines.length; i++) {
        const row = parseCsvRow(lines[i])
        if (row) rows.push(row)
      }
      if (rows.length < 24) continue  // need at least 1 day of data

      const baseSym = baseSymbolFromOhlcvSymbol(rows[0].symbol)

      // Aggregate 1h bars to daily bars
      const dailyMap = new Map<string, { closes: number[]; volumes: number[] }>()
      for (const row of rows) {
        const date = row.datetime.slice(0, 10) // YYYY-MM-DD
        if (!dailyMap.has(date)) {
          dailyMap.set(date, { closes: [], volumes: [] })
        }
        const day = dailyMap.get(date)!
        day.closes.push(row.close)
        day.volumes.push(row.volume)
      }

      const dailyBars: DailyBar[] = []
      const sortedDates = Array.from(dailyMap.keys()).sort()
      for (const date of sortedDates) {
        const day = dailyMap.get(date)!
        dailyBars.push({
          date,
          close: day.closes[day.closes.length - 1], // last close of the day
          volume: day.volumes.reduce((s, v) => s + v, 0),
        })
      }

      if (dailyBars.length < 22) continue // need at least 22 days for 21d vol

      // Compute daily returns
      const dailyReturns: number[] = []
      for (let i = 1; i < dailyBars.length; i++) {
        const prevClose = dailyBars[i - 1].close
        dailyReturns.push((dailyBars[i].close - prevClose) / prevClose)
      }

      symbolDataMap.set(baseSym, { baseSymbol: baseSym, dailyBars, dailyReturns })
      loaded++
    } catch (err) {
      console.warn(`  Failed to parse ${file}: ${(err as Error).message}`)
    }
  }
  console.log(`  Loaded ${loaded} symbols with daily data`)
  return symbolDataMap
}

// ==================== Analytics Engine ====================

interface CrossSectionalAnalytics {
  bySymbol: Map<string, {
    vol21d: number
    avgVolume21d: number
    dailyReturns: number[]
  }>
  allVol21d: number[]       // sorted, for percentile computation
  allAvgVolume21d: number[] // sorted, for percentile computation
  correlationMatrix: Map<string, Map<string, number>> // symbol x symbol Pearson r
}

function computeAnalytics(
  symbolDataMap: Map<string, SymbolData>,
  lookbackDays: number,
): CrossSectionalAnalytics {
  const bySymbol = new Map<string, { vol21d: number; avgVolume21d: number; dailyReturns: number[] }>()
  const allVol21d: number[] = []
  const allAvgVolume21d: number[] = []

  // Step 1: Compute per-symbol metrics from recent data
  for (const [baseSym, data] of symbolDataMap) {
    const returns = data.dailyReturns
    if (returns.length < VOL_LOOKBACK_DAYS) continue

    // 21d annualized volatility
    const recentReturns = returns.slice(-VOL_LOOKBACK_DAYS)
    const vol21d = stddev(recentReturns) * Math.sqrt(365)

    // 21d average daily volume
    const recentBars = data.dailyBars.slice(-VOL_LOOKBACK_DAYS)
    const avgVolume21d = mean(recentBars.map(b => b.volume))

    bySymbol.set(baseSym, { vol21d, avgVolume21d, dailyReturns: returns })
    allVol21d.push(vol21d)
    allAvgVolume21d.push(avgVolume21d)
  }

  allVol21d.sort((a, b) => a - b)
  allAvgVolume21d.sort((a, b) => a - b)

  // Step 2: Compute correlation matrix (60d returns)
  const correlationMatrix = new Map<string, Map<string, number>>()
  const symbols = Array.from(bySymbol.keys())

  for (let i = 0; i < symbols.length; i++) {
    const symI = symbols[i]
    const retI = bySymbol.get(symI)!.dailyReturns
    const row = new Map<string, number>()

    for (let j = 0; j < symbols.length; j++) {
      const symJ = symbols[j]
      if (i === j) {
        row.set(symJ, 1)
        continue
      }
      const retJ = bySymbol.get(symJ)!.dailyReturns
      const maxLen = Math.min(retI.length, retJ.length, lookbackDays)
      const sliceI = retI.slice(-maxLen)
      const sliceJ = retJ.slice(-maxLen)
      const corr = pearsonCorrelation(sliceI, sliceJ)
      row.set(symJ, isNaN(corr) ? 0 : corr)
    }
    correlationMatrix.set(symI, row)
  }

  return { bySymbol, allVol21d, allAvgVolume21d, correlationMatrix }
}

// ==================== Signal Enhancement ====================

function enhanceSignals(
  signals: LowVolSignal[],
  analytics: CrossSectionalAnalytics,
  allSymbolData: Map<string, SymbolData>,
): LowVolSignal[] {
  return signals.map((signal, idx) => {
    const symData = analytics.bySymbol.get(signal.symbol)
    const volPercentile = symData
      ? percentileRank(symData.vol21d, analytics.allVol21d)
      : 0.5
    const volumePercentile = symData
      ? percentileRank(symData.avgVolume21d, analytics.allAvgVolume21d)
      : 0.5
    const signalStrength = signal.confidence * (1 - volPercentile)

    // Diversification score: avg abs correlation with other selected signals
    let divScore = 0.5
    const thisCorrRow = analytics.correlationMatrix.get(signal.symbol)
    if (thisCorrRow && signals.length > 1) {
      const otherCorrs: number[] = []
      for (let j = 0; j < signals.length; j++) {
        if (j === idx) continue
        const otherSym = signals[j].symbol
        const c = thisCorrRow.get(otherSym)
        if (c !== undefined) otherCorrs.push(Math.abs(c))
      }
      if (otherCorrs.length > 0) {
        divScore = mean(otherCorrs)
      }
    }

    const quality: SignalQualityMetrics = {
      vol_percentile: Math.round(volPercentile * 1000) / 1000,
      volume_percentile: Math.round(volumePercentile * 1000) / 1000,
      signal_strength: Math.round(signalStrength * 1000) / 1000,
      diversification_score: Math.round(divScore * 1000) / 1000,
    }

    return { ...signal, quality_metrics: quality }
  })
}

// ==================== Quality Gate ====================

interface QualityGateResult {
  passed: boolean
  blockers: string[]
}

function checkQualityGate(
  report: DailyLowVolRankReport,
  riskFilter: NoTradeRiskFilter | null,
): QualityGateResult {
  const blockers: string[] = []

  if (!riskFilter) {
    blockers.push('no_trade_risk_filter_unavailable')
  } else if (riskFilter.summary.blocked) {
    blockers.push(`risk_filter_blocked:${riskFilter.summary.primaryReason}`)
  }

  if (report.status !== 'completed') {
    blockers.push(`rank_report_status:${report.status}`)
  }

  const nCandidates = report.signals?.long?.length ?? report.buy_candidates.length
  if (nCandidates < MIN_BUY_CANDIDATES) {
    blockers.push(
      `insufficient_buy_candidates:${nCandidates}<${MIN_BUY_CANDIDATES}`,
    )
  }

  // Research-only constraint (always enforced)
  blockers.push('paperTradingAllowed=false')
  blockers.push('liveTradingAllowed=false')
  blockers.push('executionAllowed=false')

  return {
    passed: blockers.filter(b => !b.endsWith('=false')).length === 0,
    blockers,
  }
}

// ==================== Signal Generation ====================

function generateSignals(report: DailyLowVolRankReport): LowVolSignal[] {
  const signals: LowVolSignal[] = []
  const btcVol = report.btc_vol_21d

  // Prefer new signals.long format, fallback to buy_candidates
  const longEntries: { symbol: string; vol: number; price: number }[] =
    report.signals?.long?.map(s => ({ symbol: s.symbol, vol: s.vol, price: s.price }))
    ?? report.buy_candidates.map(c => ({ symbol: c.symbol, vol: c.vol_21d, price: c.price }))

  const shortEntries: { symbol: string; vol: number; price: number }[] =
    report.signals?.short?.map(s => ({ symbol: s.symbol, vol: s.vol, price: s.price }))
    ?? report.avoid.map(c => ({ symbol: c.symbol, vol: c.vol_21d, price: c.price }))

  for (const entry of longEntries) {
    const volRatio = btcVol > 0 ? entry.vol / btcVol : 1
    const rawConfidence = Math.max(MIN_CONFIDENCE, Math.min(MAX_CONFIDENCE, 0.60 + (1 - volRatio) * 0.40))
    const confidence = Math.round(rawConfidence * 100) / 100

    signals.push({
      symbol: entry.symbol,
      direction: 'long',
      confidence,
      reason: `low_vol:vol=${entry.vol.toFixed(6)},btc_vol=${btcVol.toFixed(6)},ratio=${volRatio.toFixed(4)}`,
      quality_metrics: {
        vol_percentile: 0,
        volume_percentile: 0,
        signal_strength: 0,
        diversification_score: 0,
      },
    })
  }

  for (const entry of shortEntries) {
    const volRatio = btcVol > 0 ? entry.vol / btcVol : 1
    const rawConfidence = Math.max(MIN_CONFIDENCE, Math.min(MAX_CONFIDENCE, 0.40 + (volRatio - 1) * 0.25))
    const confidence = Math.round(rawConfidence * 100) / 100

    signals.push({
      symbol: entry.symbol,
      direction: 'short',
      confidence,
      reason: `high_vol_avoid:vol=${entry.vol.toFixed(6)},btc_vol=${btcVol.toFixed(6)},ratio=${volRatio.toFixed(4)}`,
      quality_metrics: {
        vol_percentile: 0,
        volume_percentile: 0,
        signal_strength: 0,
        diversification_score: 0,
      },
    })
  }

  signals.sort((a, b) => b.confidence - a.confidence)
  return signals
}

// ==================== Portfolio Construction ====================

function buildPortfolio(
  signals: LowVolSignal[],
  analytics: CrossSectionalAnalytics,
): PortfolioAllocation {
  const constraintsApplied: string[] = []

  // Step 1: Filter and sort by signal_strength
  let candidates = signals
    .filter(s => s.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.quality_metrics.signal_strength - a.quality_metrics.signal_strength)

  if (candidates.length === 0) {
    return {
      entries: [],
      total_sectors: 0,
      sectors_represented: [],
      constraints_applied: ['no_candidates_above_min_confidence'],
      expected_portfolio_vol: null,
      expected_portfolio_return: null,
      expected_sharpe: null,
    }
  }

  // Step 2: Ensure minimum sector diversification
  const sectorsUsed = new Set<string>()
  const diversifiedCandidates: typeof candidates = []

  // First pass: pick the best signal from each sector
  for (const c of candidates) {
    const sector = SECTOR_MAP[c.symbol] ?? 'Other'
    if (!sectorsUsed.has(sector)) {
      sectorsUsed.add(sector)
      diversifiedCandidates.push({ ...c, quality_metrics: { ...c.quality_metrics } })
    }
  }

  // Second pass: if we still have room (and need > 3 sectors), add remaining
  if (sectorsUsed.size < MIN_SECTORS) {
    constraintsApplied.push(`min_diversification:only_${sectorsUsed.size}_sectors_available`)
  } else {
    // Add remaining candidates sorted by strength
    const addedSyms = new Set(diversifiedCandidates.map(c => c.symbol))
    for (const c of candidates) {
      if (!addedSyms.has(c.symbol)) {
        diversifiedCandidates.push(c)
        addedSyms.add(c.symbol)
      }
    }
  }

  // Step 3: Compute raw weights from signal_strength and direction
  interface WeightedEntry {
    symbol: string
    direction: 'long' | 'short'
    sector: string
    confidence: number
    signal_strength: number
    rawWeight: number
  }

  let weighted = diversifiedCandidates.map(c => {
    const sector = SECTOR_MAP[c.symbol] ?? 'Other'
    const directionSign = c.direction === 'long' ? 1 : -1
    // Use product of confidence and signal_strength for weight
    const rawWeight = directionSign * c.quality_metrics.signal_strength * c.confidence
    return {
      symbol: c.symbol,
      direction: c.direction,
      sector,
      confidence: c.confidence,
      signal_strength: c.quality_metrics.signal_strength,
      rawWeight,
    }
  })

  // Step 4: Normalize so sum(|weight|) = 1.0
  let totalAbsWeight = weighted.reduce((s, w) => s + Math.abs(w.rawWeight), 0)
  if (totalAbsWeight > 0) {
    weighted = weighted.map(w => ({ ...w, rawWeight: w.rawWeight / totalAbsWeight }))
  } else {
    // Equal weight fallback
    const equalW = 1 / weighted.length
    const dirSigns = weighted.map(w => (w.direction === 'long' ? 1 : -1))
    const netSign = dirSigns.reduce((s, d) => s + d, 0)
    weighted = weighted.map((w, i) => ({
      ...w,
      rawWeight: equalW * (w.direction === 'long' ? 1 : -1) * Math.sign(netSign || 1),
    }))
  }

  // Step 5: Iterative constraint application
  let iteration = 0
  const maxIterations = 20
  let changed = true

  while (changed && iteration < maxIterations) {
    changed = false
    iteration++

    // 5a. Max position size: no single |weight| > 20%
    for (let i = 0; i < weighted.length; i++) {
      if (Math.abs(weighted[i].rawWeight) > MAX_POSITION_WEIGHT) {
        const excess = Math.abs(weighted[i].rawWeight) - MAX_POSITION_WEIGHT
        weighted[i] = {
          ...weighted[i],
          rawWeight: MAX_POSITION_WEIGHT * Math.sign(weighted[i].rawWeight),
        }
        // Distribute excess proportionally to other positions
        const otherAbsSum = weighted.reduce(
          (s, w, j) => (j !== i ? s + Math.abs(w.rawWeight) : s),
          0,
        )
        if (otherAbsSum > 0) {
          weighted = weighted.map((w, j) => {
            if (j === i) return w
            const share = Math.abs(w.rawWeight) / otherAbsSum
            return {
              ...w,
              rawWeight: w.rawWeight + share * excess * Math.sign(w.rawWeight),
            }
          })
        }
        if (!constraintsApplied.includes('max_position_size:20%')) {
          constraintsApplied.push('max_position_size:20%')
        }
        changed = true
      }
    }

    // 5b. Max sector exposure: no sector sum(|weight|) > 40%
    const sectorAbsExposure = new Map<string, number>()
    for (const w of weighted) {
      const cur = sectorAbsExposure.get(w.sector) ?? 0
      sectorAbsExposure.set(w.sector, cur + Math.abs(w.rawWeight))
    }

    for (const [sector, exposure] of sectorAbsExposure) {
      if (exposure > MAX_SECTOR_EXPOSURE) {
        const sectorScale = MAX_SECTOR_EXPOSURE / exposure
        const excessTotal = exposure - MAX_SECTOR_EXPOSURE
        // Scale down sector weights
        weighted = weighted.map(w => {
          if (w.sector !== sector) return w
          return { ...w, rawWeight: w.rawWeight * sectorScale }
        })
        // Distribute excess to other sectors
        const otherWeight = weighted.filter(w => w.sector !== sector)
        const otherAbsSum = otherWeight.reduce((s, w) => s + Math.abs(w.rawWeight), 0)
        if (otherAbsSum > 0 && excessTotal > 0) {
          weighted = weighted.map(w => {
            if (w.sector === sector) return w
            const share = Math.abs(w.rawWeight) / otherAbsSum
            return {
              ...w,
              rawWeight: w.rawWeight + share * excessTotal * Math.sign(w.rawWeight),
            }
          })
        }
        if (!constraintsApplied.includes(`max_sector_exposure:${sector}`)) {
          constraintsApplied.push(`max_sector_exposure:${sector}>40%`)
        }
        changed = true
      }
    }

    // 5c. Re-normalize after capping
    const newTotalAbs = weighted.reduce((s, w) => s + Math.abs(w.rawWeight), 0)
    if (newTotalAbs > 0 && Math.abs(newTotalAbs - 1.0) > 0.001) {
      weighted = weighted.map(w => ({
        ...w,
        rawWeight: w.rawWeight / newTotalAbs,
      }))
      changed = true
    }
  }

  // Step 6: Build entries
  const entries: PortfolioAllocationEntry[] = weighted
    .filter(w => Math.abs(w.rawWeight) > 0.0001)
    .map(w => ({
      symbol: w.symbol,
      direction: w.direction,
      target_weight: Math.round(w.rawWeight * 10000) / 10000,
      sector: w.sector,
      confidence: w.confidence,
      signal_strength: w.signal_strength,
    }))

  // Re-normalize to ensure sum(abs) = 1.0 after rounding
  const absSumAfterRounding = entries.reduce((s, e) => s + Math.abs(e.target_weight), 0)
  if (absSumAfterRounding > 0 && Math.abs(absSumAfterRounding - 1.0) > 0.001) {
    for (const e of entries) {
      e.target_weight = Math.round((e.target_weight / absSumAfterRounding) * 10000) / 10000
    }
    // Fix rounding leftovers into largest weight
    const finalAbsSum = entries.reduce((s, e) => s + Math.abs(e.target_weight), 0)
    if (Math.abs(finalAbsSum - 1.0) > 0.0001 && entries.length > 0) {
      const diff = 1.0 - finalAbsSum
      // Apply diff to the largest absolute weight
      let maxIdx = 0
      let maxAbs = 0
      for (let i = 0; i < entries.length; i++) {
        if (Math.abs(entries[i].target_weight) > maxAbs) {
          maxAbs = Math.abs(entries[i].target_weight)
          maxIdx = i
        }
      }
      entries[maxIdx] = {
        ...entries[maxIdx],
        target_weight: Math.round((entries[maxIdx].target_weight + diff * Math.sign(entries[maxIdx].target_weight)) * 10000) / 10000,
      }
    }
  }

  const sectorsRep = Array.from(new Set(entries.map(e => e.sector)))

  // Step 7: Compute expected portfolio vol and return from covariance matrix
  const symbolOrder = entries.map(e => e.symbol)
  const weights = entries.map(e => e.target_weight)

  let portfolioVol: number | null = null
  let portfolioReturn: number | null = null
  let sharpe: number | null = null

  if (symbolOrder.length > 0) {
    // Build covariance matrix
    const n = symbolOrder.length
    const covMatrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0))

    for (let i = 0; i < n; i++) {
      const symI = symbolOrder[i]
      const retI = analytics.bySymbol.get(symI)?.dailyReturns ?? []
      const retISlice = retI.slice(-CORRELATION_LOOKBACK_DAYS)
      const meanI = mean(retISlice)

      for (let j = i; j < n; j++) {
        const symJ = symbolOrder[j]
        const retJ = analytics.bySymbol.get(symJ)?.dailyReturns ?? []
        const retJSlice = retJ.slice(-CORRELATION_LOOKBACK_DAYS)

        const maxLen = Math.min(retISlice.length, retJSlice.length)
        const si = retISlice.slice(-maxLen)
        const sj = retJSlice.slice(-maxLen)
        const mi = mean(si)
        const mj = mean(sj)
        let cov = 0
        for (let k = 0; k < maxLen; k++) {
          cov += (si[k] - mi) * (sj[k] - mj)
        }
        cov = maxLen > 1 ? cov / (maxLen - 1) : 0
        covMatrix[i][j] = cov
        covMatrix[j][i] = cov
      }
    }

    // Portfolio variance = w^T * Cov * w
    let variance = 0
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        variance += weights[i] * weights[j] * covMatrix[i][j]
      }
    }
    const dailyVol = Math.sqrt(Math.max(0, variance))
    portfolioVol = dailyVol * Math.sqrt(365)

    // Expected return: confidence-weighted average of signal directions
    let weightedReturn = 0
    let weightSum = 0
    for (let i = 0; i < n; i++) {
      const entry = entries[i]
      const expectedDailyRet = (entry.confidence - 0.5) * 2 * (entry.direction === 'long' ? 1 : -1) * 0.001
      weightedReturn += entry.target_weight * expectedDailyRet
      weightSum += Math.abs(entry.target_weight)
    }
    if (weightSum > 0) {
      portfolioReturn = (weightedReturn / weightSum) * 365 // annualized
    }

    // Sharpe (assuming 0 risk-free rate)
    if (portfolioVol && portfolioVol > 0 && portfolioReturn !== null) {
      sharpe = portfolioReturn / portfolioVol
    }
  }

  return {
    entries,
    total_sectors: sectorsRep.length,
    sectors_represented: sectorsRep,
    constraints_applied: constraintsApplied.length > 0 ? constraintsApplied : ['none'],
    expected_portfolio_vol: portfolioVol !== null ? Math.round(portfolioVol * 10000) / 10000 : null,
    expected_portfolio_return: portfolioReturn !== null ? Math.round(portfolioReturn * 10000) / 10000 : null,
    expected_sharpe: sharpe !== null ? Math.round(sharpe * 1000) / 1000 : null,
  }
}

// ==================== Simulation ====================

function runSimulation(
  allocation: PortfolioAllocation,
  analytics: CrossSectionalAnalytics,
  allSymbolData: Map<string, SymbolData>,
): SimulationResult | null {
  if (allocation.entries.length === 0) return null

  // Filter to only symbols that have OHLCV data (some like MKRUSDT have no 1h csv)
  const simEntries = allocation.entries.filter(e => allSymbolData.has(e.symbol))
  if (simEntries.length === 0) return null

  // Renormalize weights for the subset that has data
  const totalAbsWeight = simEntries.reduce((s, e) => s + Math.abs(e.target_weight), 0)
  if (totalAbsWeight === 0) return null

  const weightMap = new Map<string, number>()
  for (const entry of simEntries) {
    weightMap.set(entry.symbol, entry.target_weight / totalAbsWeight)
  }

  // Get daily returns for all portfolio symbols over the lookback period
  // Align by date — find common date range
  const allDailyBarsByDate = new Map<string, Map<string, number>>()

  for (const [sym, data] of allSymbolData) {
    if (!weightMap.has(sym)) continue
    for (let i = 1; i < data.dailyBars.length; i++) {
      const date = data.dailyBars[i].date
      const prevClose = data.dailyBars[i - 1].close
      const ret = (data.dailyBars[i].close - prevClose) / prevClose
      if (!allDailyBarsByDate.has(date)) {
        allDailyBarsByDate.set(date, new Map())
      }
      allDailyBarsByDate.get(date)!.set(sym, ret)
    }
  }

  // Also get BTC returns for comparison
  const btcData = allSymbolData.get('BTCUSDT')
  const btcReturnsByDate = new Map<string, number>()
  if (btcData) {
    for (let i = 1; i < btcData.dailyBars.length; i++) {
      const date = btcData.dailyBars[i].date
      const prevClose = btcData.dailyBars[i - 1].close
      btcReturnsByDate.set(date, (btcData.dailyBars[i].close - prevClose) / prevClose)
    }
  }

  // Use last CORRELATION_LOOKBACK_DAYS days that have all portfolio symbol data
  const sortedDates = Array.from(allDailyBarsByDate.keys()).sort()

  // Find the lookback window where all portfolio symbols have data
  const activeSyms = Array.from(weightMap.keys())
  const validDates = sortedDates.filter(date => {
    const row = allDailyBarsByDate.get(date)!
    return activeSyms.every(sym => row.has(sym))
  })

  const simDays = Math.min(validDates.length, CORRELATION_LOOKBACK_DAYS)
  const simDates = validDates.slice(-simDays)

  if (simDates.length < 5) return null

  // Compute daily portfolio returns
  const portfolioDailyReturns: number[] = []
  const btcDailyReturns: number[] = []

  for (const date of simDates) {
    const row = allDailyBarsByDate.get(date)!
    let portRet = 0
    for (const [sym, weight] of weightMap) {
      const symRet = row.get(sym)
      if (symRet !== undefined) {
        portRet += weight * symRet
      }
    }
    portfolioDailyReturns.push(portRet)
    btcDailyReturns.push(btcReturnsByDate.get(date) ?? 0)
  }

  // Compute statistics
  const cumulativePortRet = portfolioDailyReturns.reduce((p, r) => p * (1 + r), 1) - 1
  const cumulativeBtcRet = btcDailyReturns.reduce((p, r) => p * (1 + r), 1) - 1

  const annualizationFactor = 365 / simDates.length
  const meanPortRet = mean(portfolioDailyReturns)
  const meanBtcRet = mean(btcDailyReturns)
  const portVol = stddev(portfolioDailyReturns) * Math.sqrt(365)
  const btcVol = stddev(btcDailyReturns) * Math.sqrt(365)

  const annualizedPortRet = (1 + cumulativePortRet) ** annualizationFactor - 1
  const annualizedBtcRet = (1 + cumulativeBtcRet) ** annualizationFactor - 1

  const portSharpe = portVol > 0 ? annualizedPortRet / portVol : 0
  const btcSharpe = btcVol > 0 ? annualizedBtcRet / btcVol : 0

  return {
    portfolio_cumulative_return: Math.round(cumulativePortRet * 10000) / 10000,
    portfolio_annualized_return: Math.round(annualizedPortRet * 10000) / 10000,
    portfolio_annualized_vol: Math.round(portVol * 10000) / 10000,
    portfolio_sharpe: Math.round(portSharpe * 1000) / 1000,
    btc_cumulative_return: Math.round(cumulativeBtcRet * 10000) / 10000,
    btc_annualized_return: Math.round(annualizedBtcRet * 10000) / 10000,
    btc_annualized_vol: Math.round(btcVol * 10000) / 10000,
    btc_sharpe: Math.round(btcSharpe * 1000) / 1000,
    portfolio_vs_btc_return_ratio: cumulativeBtcRet !== 0
      ? Math.round((cumulativePortRet / cumulativeBtcRet) * 1000) / 1000
      : cumulativePortRet > 0 ? 999 : -999,
    n_days: simDates.length,
    date_range: {
      start: simDates[0],
      end: simDates[simDates.length - 1],
    },
  }
}

// ==================== Output Writer ====================

async function writeOutput(decision: LowVolPaperDecision) {
  const dir = join(import.meta.dirname ?? '.', '..', 'data', 'runtime')
  await mkdir(dir, { recursive: true })
  await writeFile(OUTPUT_PATH, JSON.stringify(decision, null, 2) + '\n', 'utf-8')
  console.log(`  Written: ${OUTPUT_PATH}`)
}

// ==================== Main ====================

async function main() {
  console.log('Low-Vol Paper Decision Lane (Enhanced)')
  console.log('=======================================\n')

  // Parse CLI flags
  const isSimulate = process.argv.includes('--simulate')
  if (isSimulate) {
    console.log('*** --simulate flag detected: running backtest ***\n')
  }

  // 1. Load rank report
  console.log('Step 1: Reading low-vol rank report...')
  const report = await loadRankReport()
  if (!report) {
    console.error('  Aborting: rank report required\n')
    await writeOutput({
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      researchOnly: true,
      executionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      signals: [],
      portfolio_allocation: null,
      simulation: null,
      riskFilterPassed: false,
      riskFilterStatus: null,
      rankReportDate: null,
      blockers: ['rank_report_unavailable'],
      notes: ['rank report could not be loaded or parsed'],
    })
    process.exit(1)
  }
  const nLong = report.signals?.long?.length ?? report.buy_candidates.length
  const nShort = report.signals?.short?.length ?? report.avoid.length
  console.log(`  Date: ${report.date}`)
  console.log(`  Long signals: ${nLong}`)
  console.log(`  Short signals: ${nShort}`)
  console.log(`  BTC vol 21d: ${report.btc_vol_21d}`)
  if (report.adaptive_params) {
    console.log(`  Adaptive vol window: ${report.adaptive_params.vol_window_selected}`)
    console.log(`  Win rate 365d: ${(report.adaptive_params.win_rate_365d * 100).toFixed(1)}%`)
  }
  console.log()

  // 2. Load risk filter
  console.log('Step 2: Reading risk filter...')
  const riskFilter = await loadRiskFilter()
  if (riskFilter) {
    console.log(`  Status: ${riskFilter.status}`)
    console.log(`  Blocked: ${riskFilter.summary.blocked}`)
    console.log(`  Primary reason: ${riskFilter.summary.primaryReason}\n`)
  } else {
    console.log('  Risk filter unavailable (non-blocking)\n')
  }

  // 3. Load OHLCV data for cross-sectional analytics
  console.log('Step 3: Loading OHLCV market data...')
  const symbolDataMap = await loadAllOhlcvData()
  console.log(`  Total symbols with usable data: ${symbolDataMap.size}\n`)

  if (symbolDataMap.size === 0) {
    console.error('  Warning: No OHLCV data available. Quality metrics will use defaults.\n')
  }

  // 4. Compute cross-sectional analytics
  console.log('Step 4: Computing cross-sectional analytics...')
  const analytics = computeAnalytics(symbolDataMap, CORRELATION_LOOKBACK_DAYS)
  if (analytics.bySymbol.size > 0) {
    // Report top-level stats
    const sampleSym = Array.from(analytics.bySymbol.keys()).slice(0, 5)
    console.log(`  Symbols analyzed: ${analytics.bySymbol.size}`)
    console.log(`  Sample symbols: ${sampleSym.join(', ')}`)
    const avgVol = mean(analytics.allVol21d)
    console.log(`  Avg 21d vol (annualized): ${(avgVol * 100).toFixed(2)}%\n`)
  } else {
    console.log('  No analytics computed (no data).\n')
  }

  // 5. Apply quality gate
  console.log('Step 5: Applying quality gate...')
  const gate = checkQualityGate(report, riskFilter)
  for (const blocker of gate.blockers) {
    console.log(`  Blocker: ${blocker}`)
  }
  console.log(`  Gate passed: ${gate.passed}\n`)

  // 6. Generate signals
  console.log('Step 6: Generating signals...')
  const baseSignals = generateSignals(report)
  console.log(`  Total signals: ${baseSignals.length}`)
  console.log(`  Long signals: ${baseSignals.filter(s => s.direction === 'long').length}`)
  console.log(`  Short signals: ${baseSignals.filter(s => s.direction === 'short').length}\n`)

  // 7. Enhance signals with quality metrics
  console.log('Step 7: Enhancing signal quality metrics...')
  const signals = enhanceSignals(baseSignals, analytics, symbolDataMap)
  for (const sig of signals) {
    const q = sig.quality_metrics
    console.log(
      `  ${sig.symbol} (${sig.direction}, conf=${sig.confidence}): ` +
      `vol_pct=${q.vol_percentile.toFixed(3)}, ` +
      `volm_pct=${q.volume_percentile.toFixed(3)}, ` +
      `strength=${q.signal_strength.toFixed(3)}, ` +
      `div_score=${q.diversification_score.toFixed(3)}`,
    )
  }
  console.log()

  // 8. Build portfolio allocation
  console.log('Step 8: Building portfolio allocation...')
  const portfolio = buildPortfolio(signals, analytics)
  if (portfolio.entries.length > 0) {
    console.log(`  Entries: ${portfolio.entries.length}`)
    console.log(`  Sectors: ${portfolio.total_sectors} (${portfolio.sectors_represented.join(', ')})`)
    console.log(`  Constraints: ${portfolio.constraints_applied.join(', ')}`)
    for (const entry of portfolio.entries) {
      const dir = entry.direction === 'long' ? '+' : '-'
      console.log(
        `  ${dir} ${entry.symbol} (${entry.sector}): ` +
        `${(entry.target_weight * 100).toFixed(2)}% ` +
        `[conf=${entry.confidence}]`,
      )
    }
    if (portfolio.expected_portfolio_vol !== null) {
      console.log(
        `  Expected portfolio vol: ${(portfolio.expected_portfolio_vol * 100).toFixed(2)}% ann.`,
      )
    }
    if (portfolio.expected_portfolio_return !== null) {
      console.log(
        `  Expected portfolio return: ${(portfolio.expected_portfolio_return * 100).toFixed(2)}% ann.`,
      )
    }
    if (portfolio.expected_sharpe !== null) {
      console.log(`  Expected Sharpe: ${portfolio.expected_sharpe.toFixed(3)}`)
    }
  } else {
    console.log('  No portfolio entries generated.\n')
  }
  console.log()

  // 9. Simulation (--simulate flag)
  let simulation: SimulationResult | null = null
  if (isSimulate) {
    console.log('Step 9: Running simulation (--simulate)...')
    simulation = runSimulation(portfolio, analytics, symbolDataMap)
    if (simulation) {
      console.log(`  Period: ${simulation.date_range.start} to ${simulation.date_range.end}`)
      console.log(`  Days: ${simulation.n_days}`)
      console.log(`  Portfolio cumulative return: ${(simulation.portfolio_cumulative_return * 100).toFixed(2)}%`)
      console.log(`  BTC cumulative return:       ${(simulation.btc_cumulative_return * 100).toFixed(2)}%`)
      console.log(`  Portfolio ann. return: ${(simulation.portfolio_annualized_return * 100).toFixed(2)}%`)
      console.log(`  BTC ann. return:       ${(simulation.btc_annualized_return * 100).toFixed(2)}%`)
      console.log(`  Portfolio ann. vol:   ${(simulation.portfolio_annualized_vol * 100).toFixed(2)}%`)
      console.log(`  BTC ann. vol:         ${(simulation.btc_annualized_vol * 100).toFixed(2)}%`)
      console.log(`  Portfolio Sharpe: ${simulation.portfolio_sharpe.toFixed(3)}`)
      console.log(`  BTC Sharpe:       ${simulation.btc_sharpe.toFixed(3)}`)
      console.log(`  Return ratio (port/BTC): ${simulation.portfolio_vs_btc_return_ratio.toFixed(3)}`)
    } else {
      console.log('  Simulation could not be computed (insufficient data).')
    }
    console.log()
  }

  // 10. Build and write output
  console.log('Step 10: Writing output...')
  await writeOutput({
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    executionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    signals,
    portfolio_allocation: portfolio,
    simulation,
    riskFilterPassed: riskFilter ? !riskFilter.summary.blocked : false,
    riskFilterStatus: riskFilter?.status ?? null,
    rankReportDate: report.date,
    blockers: gate.blockers,
    notes: [
      'research-only low-vol paper decision lane (enhanced)',
      'observation signals only — no exchange leverage or live-money execution',
      'signals derived from daily_low_vol_rank_report.json',
      'quality metrics from 1h OHLCV data in data/market/live_accumulated/',
      `sector mapping uses ${Object.keys(SECTOR_MAP).length} symbols across ${new Set(Object.values(SECTOR_MAP)).size} sectors`,
      'portfolio allocation: target weights normalized to sum(|weight|)=1.0',
      `constraints: max_position=${(MAX_POSITION_WEIGHT * 100)}%, max_sector=${(MAX_SECTOR_EXPOSURE * 100)}%, min_sectors=${MIN_SECTORS}`,
      isSimulate ? `simulation: ${simulation ? `${simulation.n_days}d portfolio vs BTC buy-hold` : 'not available'}` : 'use --simulate flag for backtest',
      report.adaptive_params
        ? `adaptive_vol: window=${report.adaptive_params.vol_window_selected}, win_rate_365d=${(report.adaptive_params.win_rate_365d * 100).toFixed(1)}%`
        : 'adaptive_vol: not available (legacy report format)',
    ],
  })

  console.log('Done.')
}

// Run
main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
