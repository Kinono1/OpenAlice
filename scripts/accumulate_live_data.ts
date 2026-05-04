/**
 * Accumulate live market data - run every hour to build history.
 *
 * Flow:
 *   1. Fetch latest 300 1H candles from OKX for each asset
 *   2. Merge with existing CSV (dedup by timestamp)
 *   3. Save updated CSV
 *   4. Report new bars added
 *
 * Run this hourly via cron or loop to accumulate weeks/months of data.
 * Usage: npx tsx scripts/accumulate_live_data.ts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  fetchLiveCandles,
  type LiveCandle,
} from '../src/domain/market-data/live-fetcher.js'
import { defaultPaperUniverseAssets } from './lib/paper_universe.js'

interface CandleRow {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function isCoherentCandleRow(row: CandleRow): boolean {
  const values = [row.timestamp, row.open, row.high, row.low, row.close, row.volume]
  const finite = values.every(Number.isFinite)
  const positivePrices = row.open > 0 && row.high > 0 && row.low > 0 && row.close > 0
  const coherentRange =
    row.high >= row.low &&
    row.high >= Math.max(row.open, row.close) &&
    row.low <= Math.min(row.open, row.close)
  const rangeReasonable = row.low > 0 && row.high / row.low - 1 <= 0.5
  return finite && positivePrices && coherentRange && rangeReasonable && row.volume >= 0
}

export function parseCSV(csv: string): { header: string; rows: Map<number, CandleRow> } {
  const lines = csv.trim().split('\n')
  const header = lines[0]
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
    if (value < 0) {
      throw new Error(`CSV missing required column: ${name}`)
    }
  }
  const rows = new Map<number, CandleRow>()
  for (const line of lines.slice(1)) {
    const cols = line.split(',')
    const ts = Number(cols[idx.timestamp])
    const open = Number(cols[idx.open])
    const high = Number(cols[idx.high])
    const low = Number(cols[idx.low])
    const close = Number(cols[idx.close])
    const volume = Number(cols[idx.volume])
    if ([ts, open, high, low, close, volume].every(Number.isFinite)) {
      const row = {
        timestamp: ts,
        open,
        high,
        low,
        close,
        volume,
      }
      if (isCoherentCandleRow(row)) {
        rows.set(ts, row)
      }
    }
  }
  return { header, rows }
}

export function mergeLatestRows(
  existingRows: Map<number, CandleRow>,
  latest: LiveCandle[],
): { rows: Map<number, CandleRow>; newBars: number; replacedBars: number } {
  const rows = new Map(existingRows)
  let newBars = 0
  let replacedBars = 0

  for (const c of latest) {
    if (rows.has(c.timestamp)) {
      replacedBars++
    } else {
      newBars++
    }
    rows.set(c.timestamp, c)
  }

  return { rows, newBars, replacedBars }
}

export function rowsToCSV(header: string, rows: Map<number, CandleRow>, symbol: string, exchange: string): string {
  const sorted = [...rows.values()].sort((a, b) => a.timestamp - b.timestamp)
  const lines = [header]
  for (const r of sorted) {
    lines.push([
      r.timestamp,
      new Date(r.timestamp).toISOString(),
      r.open, r.high, r.low, r.close, r.volume,
      symbol, '1h', exchange,
    ].join(','))
  }
  return lines.join('\n')
}

async function main() {
  const outDir = join(import.meta.dirname ?? '.', '..', 'data', 'market', 'live_accumulated')
  await mkdir(outDir, { recursive: true })
  const now = new Date()
  let totalNew = 0

  console.log(`=== Accumulate Live Data - ${now.toISOString().slice(0, 19)} ===\n`)

  for (const asset of defaultPaperUniverseAssets()) {
    const filePath = join(outDir, asset.file)

    // Load existing data
    let existingRows = new Map<number, CandleRow>()
    let header = 'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange'
    try {
      const existing = await readFile(filePath, 'utf-8')
      const parsed = parseCSV(existing)
      existingRows = parsed.rows
      header = parsed.header
    } catch {
      // File doesn't exist yet; will create.
    }

    // Fetch latest from OKX
    try {
      const latest = await fetchLiveCandles(asset.okxInstId, '1H', 300).catch(async (err) => {
        await new Promise(r => setTimeout(r, 2000))
        return fetchLiveCandles(asset.okxInstId, '1H', 300)
      })
      const merged = mergeLatestRows(existingRows, latest)

      // Save
      const csv = rowsToCSV(header, merged.rows, asset.storageSymbol, 'okx')
      await writeFile(filePath, csv)

      const oldest = [...merged.rows.values()].sort((a, b) => a.timestamp - b.timestamp)[0]
      const newest = [...merged.rows.values()].sort((a, b) => b.timestamp - a.timestamp)[0]
      const status = merged.newBars > 0 ? 'updated' : 'unchanged'
      console.log(`${status} ${asset.okxInstId}: ${merged.rows.size} bars (${merged.newBars} new, ${merged.replacedBars} refreshed) | ${new Date(oldest.timestamp).toISOString().slice(0, 10)} -> ${new Date(newest.timestamp).toISOString().slice(0, 10)}`)
      totalNew += merged.newBars
    } catch (err) {
      console.log(`error ${asset.okxInstId}: ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(`\nTotal new bars: ${totalNew}`)
  console.log(`Next run: hourly. Data dir: ${outDir}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch(console.error)
}
