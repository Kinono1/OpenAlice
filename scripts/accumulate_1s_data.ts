/**
 * Accumulate 1-second live data from OKX for high-leverage paper diagnostics.
 *
 * This is intentionally bounded to a liquid subset so the realtime monitor does
 * not create a large public API workload. It writes local CSV files only.
 *
 * Usage: npx tsx scripts/accumulate_1s_data.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchLiveCandles } from '../src/domain/market-data/live-fetcher.js'
import { defaultSecondLevelUniverseAssets, paperSymbolToCsvFile } from './lib/paper_universe.js'

interface CandleRow {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

const ASSETS = defaultSecondLevelUniverseAssets().map(asset => ({
  instId: asset.okxInstId,
  symbol: asset.storageSymbol,
  file: paperSymbolToCsvFile(asset.paperSymbol, '1s'),
}))

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
  const timestampIndex = columns.indexOf('timestamp')
  const openIndex = columns.indexOf('open')
  const highIndex = columns.indexOf('high')
  const lowIndex = columns.indexOf('low')
  const closeIndex = columns.indexOf('close')
  const volumeIndex = columns.indexOf('volume')
  for (const [name, value] of Object.entries({
    timestamp: timestampIndex,
    open: openIndex,
    high: highIndex,
    low: lowIndex,
    close: closeIndex,
    volume: volumeIndex,
  })) {
    if (value < 0) throw new Error(`CSV missing required column: ${name}`)
  }
  const rows = new Map<number, CandleRow>()

  for (const line of lines.slice(1)) {
    const cols = line.split(',')
    const row = {
      timestamp: Number.parseInt(cols[timestampIndex] ?? '', 10),
      open: Number.parseFloat(cols[openIndex] ?? '0'),
      high: Number.parseFloat(cols[highIndex] ?? '0'),
      low: Number.parseFloat(cols[lowIndex] ?? '0'),
      close: Number.parseFloat(cols[closeIndex] ?? '0'),
      volume: Number.parseFloat(cols[volumeIndex] ?? '0'),
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

export function rowsToCSV(header: string, rows: Map<number, CandleRow>, symbol: string): string {
  const sorted = [...rows.values()].sort((a, b) => a.timestamp - b.timestamp)
  const lines = [header]
  for (const row of sorted) {
    lines.push([
      row.timestamp,
      new Date(row.timestamp).toISOString(),
      row.open,
      row.high,
      row.low,
      row.close,
      row.volume,
      symbol,
      '1s',
      'okx',
    ].join(','))
  }
  return lines.join('\n')
}

async function fetchWithRetry(instId: string): Promise<CandleRow[]> {
  try {
    return await fetchLiveCandles(instId, '1s', 300)
  } catch {
    await new Promise(resolve => setTimeout(resolve, 1500))
    return fetchLiveCandles(instId, '1s', 300)
  }
}

async function main(): Promise<void> {
  const outDir = join(import.meta.dirname ?? '.', '..', 'data', 'market', 'live_1s')
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
    } catch {
      // New file.
    }

    try {
      const latest = await fetchWithRetry(asset.instId)
      const merged = mergeLatestRows(existingRows, latest)

      await writeFile(filePath, rowsToCSV(header, merged.rows, asset.symbol), 'utf-8')
      const sorted = [...merged.rows.values()].sort((a, b) => a.timestamp - b.timestamp)
      const oldest = sorted[0]
      const newest = sorted[sorted.length - 1]
      const range = oldest && newest
        ? `${new Date(oldest.timestamp).toISOString().slice(0, 19)} -> ${new Date(newest.timestamp).toISOString().slice(0, 19)}`
        : 'empty'
      console.log(`${asset.instId}: ${merged.rows.size} 1s bars (${merged.newBars} new, ${merged.replacedBars} refreshed) | ${range}`)
      totalNew += merged.newBars
    } catch (err) {
      console.log(`${asset.instId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`Total new 1s bars: ${totalNew}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
