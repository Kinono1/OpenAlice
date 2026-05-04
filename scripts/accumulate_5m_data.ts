/**
 * Accumulate 5-minute live data from OKX - run every 5 minutes.
 *
 * Flow:
 *   1. Fetch latest 300 5m candles from OKX for each asset
 *   2. Merge with existing CSV (dedup by timestamp)
 *   3. Save updated CSV
 *
 * Usage: npx tsx scripts/accumulate_5m_data.ts
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchLiveCandles } from '../src/domain/market-data/live-fetcher.js'
import { defaultPaperUniverseAssets, paperSymbolToCsvFile } from './lib/paper_universe.js'

const ASSETS = defaultPaperUniverseAssets().map(asset => ({
  instId: asset.okxInstId,
  symbol: asset.storageSymbol,
  file: paperSymbolToCsvFile(asset.paperSymbol, '5m'),
}))

interface CandleRow { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

const CSV_HEADER = 'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange'

function isCoherentCandleRow(row: CandleRow): boolean {
  const values = [row.timestamp, row.open, row.high, row.low, row.close, row.volume]
  const finite = values.every(Number.isFinite)
  const positivePrices = row.open > 0 && row.high > 0 && row.low > 0 && row.close > 0
  const coherentRange =
    row.high >= row.low &&
    row.high >= Math.max(row.open, row.close) &&
    row.low <= Math.min(row.open, row.close)
  const rangeReasonable = row.low > 0 && row.high / row.low - 1 <= 0.5
  const legacyDatetimeShiftCorruption =
    row.open === 2026 &&
    row.high === 2026 &&
    row.low === 2026 &&
    row.close === 2026 &&
    row.volume === 2026
  return finite && positivePrices && coherentRange && rangeReasonable && row.volume >= 0 && !legacyDatetimeShiftCorruption
}

export function parseCSV(csv: string): { header: string; rows: Map<number, CandleRow> } {
  const lines = csv.trim().split('\n').filter(Boolean)
  const header = lines[0] || CSV_HEADER
  const columns = header.split(',')
  const idx = {
    timestamp: columns.indexOf('timestamp'),
    open: columns.indexOf('open'),
    high: columns.indexOf('high'),
    low: columns.indexOf('low'),
    close: columns.indexOf('close'),
    volume: columns.indexOf('volume'),
  }
  for (const [name, value] of Object.entries(idx)) {
    if (value < 0) throw new Error(`CSV missing required column: ${name}`)
  }
  const rows = new Map<number, CandleRow>()
  for (const line of lines.slice(1)) {
    const cols = line.split(',')
    const row = {
      timestamp: Number(cols[idx.timestamp]),
      open: Number(cols[idx.open]),
      high: Number(cols[idx.high]),
      low: Number(cols[idx.low]),
      close: Number(cols[idx.close]),
      volume: Number(cols[idx.volume]),
    }
    if (isCoherentCandleRow(row)) {
      rows.set(row.timestamp, row)
    }
  }
  return { header, rows }
}

export function mergeLatestRows(
  existingRows: Map<number, CandleRow>,
  latest: CandleRow[],
): { rows: Map<number, CandleRow>; newBars: number; replacedBars: number } {
  const rows = new Map(existingRows)
  let newBars = 0
  let replacedBars = 0
  for (const candle of latest) {
    if (!isCoherentCandleRow(candle)) continue
    if (rows.has(candle.timestamp)) {
      replacedBars += 1
    } else {
      newBars += 1
    }
    rows.set(candle.timestamp, candle)
  }
  return { rows, newBars, replacedBars }
}

export function rowsToCSV(header: string, rows: Map<number, CandleRow>, symbol: string, exchange: string): string {
  const sorted = [...rows.values()].sort((a, b) => a.timestamp - b.timestamp)
  const lines = [header]
  for (const r of sorted) {
    lines.push([r.timestamp, new Date(r.timestamp).toISOString(), r.open, r.high, r.low, r.close, r.volume, symbol, '5m', exchange].join(','))
  }
  return lines.join('\n')
}

async function main() {
  const outDir = join(import.meta.dirname ?? '.', '..', 'data', 'market', 'live_5m')
  await mkdir(outDir, { recursive: true })
  let totalNew = 0

  for (const asset of ASSETS) {
    const filePath = join(outDir, asset.file)
    let existingRows = new Map<number, CandleRow>()
    let header = CSV_HEADER
    try {
      const existing = await readFile(filePath, 'utf-8')
      const parsed = parseCSV(existing)
      existingRows = parsed.rows
      header = parsed.header
    } catch { /* new file */ }

    try {
      const latest = await fetchLiveCandles(asset.instId, '5m', 300).catch(async (_err) => {
        await new Promise(r => setTimeout(r, 2000))
        return fetchLiveCandles(asset.instId, '5m', 300)
      })
      const merged = mergeLatestRows(existingRows, latest)
      const csv = rowsToCSV(header, merged.rows, asset.symbol, 'okx')
      await writeFile(filePath, csv)

      const sorted = [...merged.rows.values()].sort((a, b) => a.timestamp - b.timestamp)
      const oldest = sorted[0]
      const newest = sorted[sorted.length - 1]
      const status = merged.newBars > 0 ? 'updated' : 'unchanged'
      console.log(`${status} ${asset.instId}: ${merged.rows.size} bars (${merged.newBars} new, ${merged.replacedBars} refreshed) | ${new Date(oldest.timestamp).toISOString().slice(0, 10)} -> ${new Date(newest.timestamp).toISOString().slice(0, 19)}`)
      totalNew += merged.newBars
    } catch (err) {
      console.log(`error ${asset.instId}: ${err instanceof Error ? err.message : err}`)
    }
  }
  console.log(`Total new 5m bars: ${totalNew}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch(console.error)
}
