import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface CsvRow {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface Comparison {
  symbol: string
  timeframe: '5m' | '1h'
  oldRows: number
  newRows: number
  overlapRows: number
  oldOnlyRows: number
  newOnlyRows: number
  mismatchedRows: number
  maxAbsoluteDiff: Record<'open' | 'high' | 'low' | 'close' | 'volume', number>
  oldLatestTimestamp: number | null
  newLatestTimestamp: number | null
}

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'] as const
const TIMEFRAMES = ['5m', '1h'] as const

export async function compareOkxCompatibilityCanary(argv = process.argv.slice(2)) {
  const raw = parseRawArgs(argv)
  const oldRoot = resolve(raw.get('oldRoot') ?? 'data/market')
  const newRoot = resolve(raw.get('newRoot') ?? '')
  if (!raw.get('newRoot')) throw new Error('--newRoot is required')
  const comparisons: Comparison[] = []
  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      const directory = timeframe === '5m' ? 'live_5m' : 'live_accumulated'
      const name = `${symbol}_USDT_USDT_${timeframe}.csv`
      const oldRows = await readCsv(join(oldRoot, directory, name))
      const newRows = await readCsv(join(newRoot, directory, name))
      comparisons.push(compareRows(symbol, timeframe, oldRows, newRows))
    }
  }
  const totals = {
    overlapRows: comparisons.reduce((sum, item) => sum + item.overlapRows, 0),
    mismatchedRows: comparisons.reduce((sum, item) => sum + item.mismatchedRows, 0),
    oldOnlyRows: comparisons.reduce((sum, item) => sum + item.oldOnlyRows, 0),
    newOnlyRows: comparisons.reduce((sum, item) => sum + item.newOnlyRows, 0),
  }
  return {
    schemaVersion: 'okx_compatibility_canary_compare.v1',
    generatedAt: new Date().toISOString(),
    oldRoot,
    newRoot,
    status: totals.mismatchedRows === 0 && totals.overlapRows > 0 ? 'pass' : 'fail',
    totals,
    comparisons,
  }
}

function compareRows(symbol: string, timeframe: '5m' | '1h', oldRows: CsvRow[], newRows: CsvRow[]): Comparison {
  const oldByTs = new Map(oldRows.map(row => [row.timestamp, row]))
  const newByTs = new Map(newRows.map(row => [row.timestamp, row]))
  const fields = ['open', 'high', 'low', 'close', 'volume'] as const
  const maxAbsoluteDiff = { open: 0, high: 0, low: 0, close: 0, volume: 0 }
  let overlapRows = 0
  let mismatchedRows = 0
  for (const [timestamp, oldRow] of oldByTs) {
    const next = newByTs.get(timestamp)
    if (!next) continue
    overlapRows += 1
    let mismatch = false
    for (const field of fields) {
      const difference = Math.abs(oldRow[field] - next[field])
      maxAbsoluteDiff[field] = Math.max(maxAbsoluteDiff[field], difference)
      const tolerance = field === 'volume' ? 1e-8 * Math.max(1, Math.abs(oldRow[field])) : 1e-10 * Math.max(1, Math.abs(oldRow[field]))
      if (difference > tolerance) mismatch = true
    }
    if (mismatch) mismatchedRows += 1
  }
  return {
    symbol,
    timeframe,
    oldRows: oldRows.length,
    newRows: newRows.length,
    overlapRows,
    oldOnlyRows: oldRows.length - overlapRows,
    newOnlyRows: newRows.length - overlapRows,
    mismatchedRows,
    maxAbsoluteDiff,
    oldLatestTimestamp: oldRows.at(-1)?.timestamp ?? null,
    newLatestTimestamp: newRows.at(-1)?.timestamp ?? null,
  }
}

async function readCsv(path: string): Promise<CsvRow[]> {
  const lines = (await readFile(path, 'utf-8')).trim().split('\n')
  const header = lines.shift()?.split(',') ?? []
  const index = Object.fromEntries(header.map((name, position) => [name, position])) as Record<string, number>
  for (const required of ['timestamp', 'open', 'high', 'low', 'close', 'volume']) {
    if (index[required] == null) throw new Error(`missing column ${required}: ${path}`)
  }
  return lines.filter(Boolean).map(line => {
    const values = line.split(',')
    return {
      timestamp: Number(values[index.timestamp]),
      open: Number(values[index.open]),
      high: Number(values[index.high]),
      low: Number(values[index.low]),
      close: Number(values[index.close]),
      volume: Number(values[index.volume]),
    }
  }).sort((left, right) => left.timestamp - right.timestamp)
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) out.set(token.slice(2), 'true')
    else { out.set(token.slice(2), next); index += 1 }
  }
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  compareOkxCompatibilityCanary().then(report => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.status !== 'pass') process.exitCode = 1
  }).catch(error => { console.error(error); process.exitCode = 1 })
}
