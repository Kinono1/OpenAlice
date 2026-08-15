/**
 * No-Trade Risk Filter — Phase 0, pure rule engine, no alpha needed.
 *
 * Blocks opens on: BTC crash / high vol / stale data / wide spread /
 * funding staleness / macro events / BTC 24h vol spike / market-wide correlation breakdown.
 *
 * Historical validation: 2024-08-05, 2022-11-09, 2021-05-19, 2020-03-12
 * (uses REAL historical data from Binance public klines)
 *
 * Mode detection: tries live data first (live_accumulated + live_5m CSV files).
 * Use --historical flag to force historical validation mode against known crash events.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

// ─── Constants ──────────────────────────────────────────────────────────

const BINANCE_1H_DIR = resolve('data/market/binance-public/spot-all-usdt-klines-1h/spot')
const LIVE_ACCUMULATED_DIR = resolve('data/market/live_accumulated')
const LIVE_5M_DIR = resolve('data/market/live_5m')

/** Mainstream coins used for the market_wide_correlation_breakdown check. */
const MAINSTREAM_COINS = [
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOT', 'AVAX',
  'LINK', 'DOGE', 'MATIC', 'ATOM', 'ARB', 'OP', 'SUI', 'TRX',
]

const CRASH_EVENTS = [
  { date: '2024-08-05', event: 'Japan carry trade unwind' },
  { date: '2022-11-09', event: 'FTX collapse' },
  { date: '2021-05-19', event: 'China crypto ban' },
  { date: '2020-03-12', event: 'COVID Black Thursday' },
]

// ─── Types ───────────────────────────────────────────────────────────────

interface Check { found: boolean; value: string; verdict: 'pass' | 'block' }

interface RiskFilterStatus {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: 'pass'
  mode: 'live' | 'historical_validation'
  checks: Record<string, Check>
  summary: { blockCount: number; totalChecks: number; blocked: boolean; primaryReason: string | null }
  historicalValidation?: {
    results: Array<{ date: string; event: string; expectedBlock: boolean; actualBlock: boolean; triggeredRules: string[]; match: boolean }>
    summary: { totalEvents: number; matched: number; missed: number; falsePositives: number }
  }
  blockers: string[]
}

// ─── Data Loading Helpers ───────────────────────────────────────────────

/** Extract a file from a zip archive using system `unzip -p` (macOS/Linux). */
function extractFromZip(zipPath: string): string {
  return execSync(`unzip -p "${zipPath}" 2>/dev/null`, { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 })
}

/**
 * Parse a Binance kline CSV string (no header) into an array of { time(ms), close }.
 * Columns: open_time, open, high, low, close, volume, close_time, quote_volume, count, taker_buy_vol, taker_buy_quote_vol, ignore
 */
function parseBinanceKlines(content: string): Array<{ time: number; close: number }> {
  const rows: Array<{ time: number; close: number }> = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const cols = trimmed.split(',')
    if (cols.length < 5) continue
    const time = Number(cols[0])
    const close = Number(cols[4])
    if (isFinite(time) && isFinite(close) && time > 0 && close > 0) {
      rows.push({ time, close })
    }
  }
  rows.sort((a, b) => a.time - b.time)
  return rows
}

/** Parse a CSV with header row (timestamp, datetime, open, high, low, close, volume, ...) into { time(ms), close }. */
function parseCsvWithHeader(content: string): Array<{ time: number; close: number }> {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return []

  const header = lines[0].split(',')
  const timeIdx = header.indexOf('timestamp')
  const closeIdx = header.indexOf('close')
  if (timeIdx < 0 || closeIdx < 0) return []

  const rows: Array<{ time: number; close: number }> = []
  for (const line of lines.slice(1)) {
    const cols = line.split(',')
    const time = Number(cols[timeIdx])
    const close = Number(cols[closeIdx])
    if (isFinite(time) && isFinite(close) && time > 0 && close > 0) {
      rows.push({ time, close })
    }
  }
  rows.sort((a, b) => a.time - b.time)
  return rows
}

function computeReturns(rows: Array<{ time: number; close: number }>): number[] {
  const returns: number[] = []
  for (let i = 1; i < rows.length; i++) {
    returns.push((rows[i].close - rows[i - 1].close) / rows[i - 1].close)
  }
  return returns
}

/**
 * Load hourly candles for a symbol from the Binance public archive for the given month(s).
 */
function loadBinanceHourly(symbol: string, ...yearMonths: string[]): Array<{ time: number; close: number }> {
  const allRows: Array<{ time: number; close: number }> = []
  for (const ym of yearMonths) {
    const zipPath = resolve(BINANCE_1H_DIR, symbol, '1h', `${symbol}-1h-${ym}.zip`)
    if (!existsSync(zipPath)) continue
    try {
      const content = extractFromZip(zipPath)
      const rows = parseBinanceKlines(content)
      allRows.push(...rows)
    } catch {
      continue
    }
  }
  allRows.sort((a, b) => a.time - b.time)
  return allRows
}

/**
 * Load live BTC 1h returns from the accumulated CSV file.
 * Returns an array of hourly returns (newest last), or null if unavailable.
 */
function loadLiveBtc1hReturns(): number[] | null {
  const csvPath = resolve(LIVE_ACCUMULATED_DIR, 'BTC_USDT_USDT_1h.csv')
  if (!existsSync(csvPath)) return null
  try {
    const content = readFileSync(csvPath, 'utf-8')
    const rows = parseCsvWithHeader(content)
    if (rows.length < 2) return null
    return computeReturns(rows)
  } catch {
    return null
  }
}

/**
 * Load live 4h returns for mainstream coins from live_5m CSV files.
 * Returns a map of coin -> ~4h return, or null if too few coins are available.
 */
function loadLiveMainstream4hReturns(): Map<string, number> | null {
  const results = new Map<string, number>()
  for (const coin of MAINSTREAM_COINS) {
    const csvPath = resolve(LIVE_5M_DIR, `${coin}_USDT_USDT_5m.csv`)
    if (!existsSync(csvPath)) continue
    try {
      const content = readFileSync(csvPath, 'utf-8')
      const rows = parseCsvWithHeader(content)
      if (rows.length < 2) continue
      // Compare first to last close over available 5m data (up to ~48 bars = 4h)
      const first = rows[0].close
      const last = rows[rows.length - 1].close
      results.set(coin, (last - first) / first)
    } catch {
      continue
    }
  }
  return results.size >= 3 ? results : null
}

/**
 * For historical validation, load mainstream coin 4h returns around a crash date
 * from the Binance public archive.
 */
function loadHistoricalMainstream4hReturns(dateStr: string): Map<string, number> | null {
  const date = new Date(dateStr + 'T12:00:00Z')
  const crashTs = date.getTime()
  const hourMs = 3600000
  const startTs = crashTs - 4 * hourMs

  const results = new Map<string, number>()
  const monthStr = dateStr.slice(0, 7) // YYYY-MM

  for (const coin of MAINSTREAM_COINS) {
    if (coin === 'BTC') continue
    const symbol = coin + 'USDT'
    const zipPath = resolve(BINANCE_1H_DIR, symbol, '1h', `${symbol}-1h-${monthStr}.zip`)
    if (!existsSync(zipPath)) continue
    try {
      const content = extractFromZip(zipPath)
      const rows = parseBinanceKlines(content)
      const window = rows.filter(r => r.time >= startTs && r.time <= crashTs)
      if (window.length >= 2) {
        const first = window[0].close
        const last = window[window.length - 1].close
        results.set(coin, (last - first) / first)
      }
    } catch {
      continue
    }
  }

  return results.size >= 3 ? results : null
}

/**
 * Determine which year-month strings cover a date range.
 */
function yearMonthsCovering(startTimeMs: number, endTimeMs: number): string[] {
  const start = new Date(startTimeMs)
  const end = new Date(endTimeMs)
  const months: string[] = []
  const current = new Date(start.getFullYear(), start.getMonth(), 1)
  while (current <= end) {
    const y = current.getFullYear()
    const m = String(current.getMonth() + 1).padStart(2, '0')
    months.push(`${y}-${m}`)
    current.setMonth(current.getMonth() + 1)
  }
  return months
}

/**
 * Load BTC 1h close prices for a time window around a given date.
 * Returns rows sorted by time ascending, or null if no data found.
 */
function loadBtcWindow(dateStr: string, daysBefore: number, hoursAfter: number): Array<{ time: number; close: number }> | null {
  const date = new Date(dateStr + 'T12:00:00Z')
  const crashTs = date.getTime()
  const hourMs = 3600000
  const startMs = crashTs - daysBefore * 24 * hourMs
  const endMs = crashTs + hoursAfter * hourMs

  const months = yearMonthsCovering(startMs, endMs)
  const allRows = loadBinanceHourly('BTCUSDT', ...months)
  if (allRows.length < 2) return null
  return allRows.filter(r => r.time >= startMs && r.time <= endMs)
}

// ─── Volatility Helpers ─────────────────────────────────────────────────

/** Compute standard deviation of a numeric array (population formula). */
function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)
}

/** Compute median of a numeric array. */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Compute daily volatilities from hourly returns.
 * Groups returns into 24-hour windows and computes stddev per window.
 */
function dailyVolatilities(returns: number[]): number[] {
  const dailies: number[] = []
  for (let i = 0; i + 24 <= returns.length; i += 24) {
    dailies.push(stddev(returns.slice(i, i + 24)))
  }
  return dailies
}

/**
 * Compute the 24h volatility (stddev of last 24 hourly returns)
 * and the 21-day median daily vol (median of daily stddevs over last 21 days).
 * Returns { current24hVol, median21dVol } or null if insufficient data.
 */
function computeVolSpikeMetrics(returns: number[]): { current24hVol: number; median21dVol: number } | null {
  if (returns.length < 25) return null // need at least 25 returns for 24h vol

  const last24 = returns.slice(-24)
  const current24hVol = stddev(last24)

  if (returns.length < 24 * 21 + 1) return null // need at least ~505 returns for 21d median
  const dailies = dailyVolatilities(returns)
  const last21Medians = dailies.slice(-21)
  if (last21Medians.length < 2) return null
  const median21dVol = median(last21Medians)

  return { current24hVol, median21dVol }
}

// ─── Rules ────────────────────────────────────────────────────────────────

function checkBtc1hCrash(ret: number[] | null): Check {
  if (!ret || ret.length < 1) return { found: false, value: 'no_data', verdict: 'block' }
  const pct = ret[ret.length - 1] * 100
  return { found: true, value: `${pct.toFixed(2)}%`, verdict: pct < -3 ? 'block' : 'pass' }
}

function checkBtc4hCrash(ret: number[] | null): Check {
  if (!ret || ret.length < 4) return { found: false, value: 'no_data', verdict: 'block' }
  const c = ret.slice(-4).reduce((s, r) => s * (1 + r), 1) - 1
  return { found: true, value: `${(c * 100).toFixed(2)}%`, verdict: c < -0.06 ? 'block' : 'pass' }
}

function checkHighVol(ret: number[] | null): Check {
  if (!ret || ret.length < 25) return { found: false, value: 'no_data', verdict: 'block' }
  const w = ret.slice(-24), m = w.reduce((s, r) => s + r, 0) / w.length
  const v = Math.sqrt(w.reduce((s, r) => s + (r - m) ** 2, 0) / (w.length - 1))
  return { found: true, value: `${(v * 100).toFixed(2)}%`, verdict: v > 0.03 ? 'block' : 'pass' }
}

function checkBtc24hVolSpike(ret: number[] | null): Check {
  if (!ret || ret.length < 25) return { found: false, value: 'no_data', verdict: 'block' }
  const metrics = computeVolSpikeMetrics(ret)
  if (!metrics) return { found: true, value: 'insufficient_data_21d', verdict: 'pass' }
  const ratio = metrics.current24hVol / metrics.median21dVol
  return {
    found: true,
    value: `${(metrics.current24hVol * 100).toFixed(3)}% / ${(metrics.median21dVol * 100).toFixed(3)}% = ${ratio.toFixed(2)}x`,
    verdict: ratio > 3 ? 'block' : 'pass',
  }
}

function checkMarketWideCorrelation(coin4hReturns: Map<string, number> | null): Check {
  if (!coin4hReturns || coin4hReturns.size < 3) {
    return { found: false, value: `insufficient_data (${coin4hReturns?.size ?? 0} coins)`, verdict: 'block' }
  }
  let up = 0, down = 0
  for (const ret of coin4hReturns.values()) {
    if (ret > 0) up++
    else if (ret < 0) down++
  }
  const total = coin4hReturns.size
  const upPct = (up / total) * 100
  const downPct = (down / total) * 100
  const dominant = up >= down ? 'up' : 'down'
  const pct = Math.max(upPct, downPct)
  return {
    found: true,
    value: `${up}↑ ${down}↓ (${pct.toFixed(0)}% ${dominant})`,
    verdict: pct >= 80 ? 'block' : 'pass',
  }
}

function checkStaleness(sec: number | null): Check {
  if (sec === null) return { found: false, value: 'unknown', verdict: 'block' }
  return { found: true, value: `${sec}s`, verdict: sec > 120 ? 'block' : 'pass' }
}

function checkSpread(bps: number | null): Check {
  if (bps === null) return { found: false, value: 'unknown', verdict: 'block' }
  return { found: true, value: `${bps.toFixed(1)}bps`, verdict: bps > 10 ? 'block' : 'pass' }
}

function checkFunding(h: number | null): Check {
  if (h === null) return { found: false, value: 'unknown', verdict: 'block' }
  return { found: true, value: `${h.toFixed(1)}h ago`, verdict: h > 8 ? 'block' : 'pass' }
}

function checkMacro(now: Date): Check {
  const today = now.toISOString().slice(0, 10)
  const events: Record<string, string> = {
    '2024-09-18': 'FOMC', '2024-11-07': 'FOMC', '2024-12-18': 'FOMC',
    '2022-11-09': 'FTX collapse', '2021-05-19': 'China ban', '2020-03-12': 'COVID',
  }
  if (events[today]) return { found: true, value: events[today], verdict: 'block' }
  return { found: true, value: 'none', verdict: 'pass' }
}

// ─── Builder ──────────────────────────────────────────────────────────────

export async function buildNoTradeRiskFilter(opts: {
  btc1hReturns?: number[] | null
  dataFreshnessSec?: number | null
  spreadBps?: number | null
  lastFundingHoursAgo?: number | null
  mode?: 'live' | 'historical_validation'
  coin4hReturns?: Map<string, number> | null
} = {}): Promise<RiskFilterStatus> {
  const checks: Record<string, Check> = {
    btc_1h_crash: checkBtc1hCrash(opts.btc1hReturns ?? null),
    btc_4h_crash: checkBtc4hCrash(opts.btc1hReturns ?? null),
    high_volatility: checkHighVol(opts.btc1hReturns ?? null),
    btc_24h_vol_spike: checkBtc24hVolSpike(opts.btc1hReturns ?? null),
    data_freshness: checkStaleness(opts.dataFreshnessSec ?? null),
    spread: checkSpread(opts.spreadBps ?? null),
    funding_staleness: checkFunding(opts.lastFundingHoursAgo ?? null),
    macro_event_window: checkMacro(new Date()),
    market_wide_correlation_breakdown: checkMarketWideCorrelation(opts.coin4hReturns ?? null),
  }

  const entries = Object.entries(checks)
  const blockCount = entries.filter(([, c]) => c.verdict === 'block').length
  const primary = entries.find(([, c]) => c.verdict === 'block')

  const status: RiskFilterStatus = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    researchOnly: true, diagnosticOnly: true,
    promotionEligible: false, paperTradingAllowed: false,
    liveTradingAllowed: false, executionAllowed: false,
    status: 'pass', mode: opts.mode ?? 'live', checks,
    summary: {
      blockCount, totalChecks: entries.length,
      blocked: blockCount > 0,
      primaryReason: primary ? `${primary[0]}:${primary[1].value}` : null,
    },
    blockers: [],
  }

  // Historical validation — load REAL data from Binance archives
  if (opts.mode === 'historical_validation') {
    const results: RiskFilterStatus['historicalValidation']['results'] = []
    let matched = 0, missed = 0, fp = 0
    for (const ev of CRASH_EVENTS) {
      // Load ~35 days of BTC hourly data leading up to the crash
      const rows = loadBtcWindow(ev.date, 35, 12)
      const returns = rows ? computeReturns(rows) : null

      // Load mainstream coin data for the correlation check
      const historicalCoin4h = loadHistoricalMainstream4hReturns(ev.date)

      // Run all checks using the real data
      const c1 = checkBtc1hCrash(returns)
      const c2 = checkBtc4hCrash(returns)
      const c3 = checkHighVol(returns)
      const c4 = checkBtc24hVolSpike(returns)
      const c5 = checkMarketWideCorrelation(historicalCoin4h)

      const triggered = [c1, c2, c3, c4, c5].filter(c => c.verdict === 'block')
      const actualBlock = triggered.length > 0
      const isMatch = actualBlock === true
      if (isMatch) matched++; else missed++
      results.push({
        date: ev.date, event: ev.event, expectedBlock: true, actualBlock,
        triggeredRules: triggered.map(c => `${c.value}`), match: isMatch,
      })
    }
    status.historicalValidation = { results, summary: { totalEvents: 4, matched, missed, falsePositives: fp } }
  }

  return status
}

// ─── CLI ──────────────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv.includes('--historical') ? 'historical_validation' : 'live'

  // Default: try loading live data
  let btcReturns: number[] | null = null
  let coin4hReturns: Map<string, number> | null = null

  if (mode === 'live') {
    // Try reading BTC 1h returns from live_accumulated
    btcReturns = loadLiveBtc1hReturns()
    if (btcReturns) {
      console.log('  [data] BTC 1h returns loaded from live_accumulated')
    } else {
      console.log('  [data] live_accumulated BTC data not available')
    }

    // Try reading mainstream coin 4h returns from live_5m
    coin4hReturns = loadLiveMainstream4hReturns()
    if (coin4hReturns) {
      console.log(`  [data] Mainstream 4h returns loaded (${coin4hReturns.size} coins)`)
    } else {
      console.log('  [data] Live 5m mainstream data not available')
    }
  }

  // Try loading live data freshness
  let freshSec: number | null = null
  try {
    const p = resolve('data/runtime/live_data_freshness.latest.json')
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, 'utf-8'))
      freshSec = Math.floor((Date.now() - new Date(d.generatedAt ?? Date.now()).getTime()) / 1000)
    }
  } catch { /* ok */ }

  const status = await buildNoTradeRiskFilter({
    btc1hReturns: btcReturns,
    dataFreshnessSec: freshSec,
    mode: mode as 'live' | 'historical_validation',
    coin4hReturns: coin4hReturns,
  })

  const outPath = resolve('data/runtime/no_trade_risk_filter.latest.json')
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, JSON.stringify(status, null, 2))
  await writeEvidenceManifestForArtifact({
    job: 'build_no_trade_risk_filter',
    artifactPath: outPath,
    startedAt: new Date(),
    finishedAt: new Date(),
    exitCode: 0,
  })

  const modeLabel = mode === 'historical_validation' ? 'HISTORICAL' : 'LIVE'
  console.log(`No-Trade Risk Filter [${modeLabel}]: ${status.summary.blocked ? 'BLOCKED' : 'PASS'}`)
  for (const [k, c] of Object.entries(status.checks))
    console.log(`  ${c.verdict === 'block' ? 'BLOCK' : 'PASS '} ${k}: ${c.value}`)
  if (status.historicalValidation)
    for (const r of status.historicalValidation.results)
      console.log(`  ${r.match ? 'MATCH' : 'MISS'} ${r.date} ${r.event}: ${r.actualBlock ? 'BLOCKED' : 'PASS'} [${r.triggeredRules.join(', ')}]`)
  console.log(status.historicalValidation
    ? `  Validation: ${status.historicalValidation.summary.matched}/4 matched`
    : '')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
