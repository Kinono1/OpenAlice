/**
 * Backfill 1h OKX public candles into the live_accumulated store.
 *
 * This is an explicit research data-repair command, not a scheduled hourly job.
 * It paginates OKX public candle history and merges into the existing CSV files.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  fetchExtendedCandles,
  type LiveCandle,
} from '../src/domain/market-data/live-fetcher.js'
import {
  mergeLatestRows,
  parseCSV,
  rowsToCSV,
} from './accumulate_live_data.js'
import { defaultPaperUniverseAssets } from './lib/paper_universe.js'

interface CliArgs {
  outputDir: string
  symbols: string[]
  maxCandles: number
  dryRun: boolean
}

interface BackfillAssetResult {
  instId: string
  file: string
  fetchedBars: number
  rowsAfterMerge: number
  newBars: number
  replacedBars: number
  oldestTimestamp: number | null
  newestTimestamp: number | null
  error: string | null
}

const CSV_HEADER = 'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange'
const DEFAULT_OUTPUT_DIR = 'data/market/live_accumulated'
const DEFAULT_MAX_CANDLES = 1_500

async function main(): Promise<void> {
  const args = parseBackfill1hArgs(process.argv.slice(2))
  const outputDir = resolve(args.outputDir)
  await mkdir(outputDir, { recursive: true })

  console.log(`=== Backfill OKX 1h Live Data - ${new Date().toISOString().slice(0, 19)} ===`)
  console.log(`outputDir=${outputDir}`)
  console.log(`maxCandles=${args.maxCandles}`)
  console.log(`dryRun=${args.dryRun}`)
  console.log('')

  let totalNew = 0
  let totalFetched = 0
  let errors = 0

  for (const asset of selectAssets(args.symbols)) {
    const result = await backfillAsset({
      outputDir,
      file: asset.file,
      instId: asset.okxInstId,
      storageSymbol: asset.storageSymbol,
      maxCandles: args.maxCandles,
      dryRun: args.dryRun,
    })
    totalNew += result.newBars
    totalFetched += result.fetchedBars
    if (result.error) errors += 1
    console.log(renderAssetResult(result))
  }

  console.log('')
  console.log(`Total fetched 1h bars: ${totalFetched}`)
  console.log(`Total new 1h bars: ${totalNew}`)
  console.log(`Errors: ${errors}`)
}

export function parseBackfill1hArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputDir: raw.get('outputDir') ?? raw.get('dataDir') ?? DEFAULT_OUTPUT_DIR,
    symbols: parseSymbols(raw.get('symbols')),
    maxCandles: parsePositiveInteger(raw.get('maxCandles'), DEFAULT_MAX_CANDLES, 'maxCandles'),
    dryRun: parseBool(raw.get('dryRun'), false),
  }
}

async function backfillAsset(input: {
  outputDir: string
  file: string
  instId: string
  storageSymbol: string
  maxCandles: number
  dryRun: boolean
}): Promise<BackfillAssetResult> {
  const filePath = join(input.outputDir, input.file)
  try {
    let existingRows = new Map<number, LiveCandle>()
    let header = CSV_HEADER
    try {
      const existing = await readFile(filePath, 'utf-8')
      const parsed = parseCSV(existing)
      existingRows = parsed.rows
      header = parsed.header
    } catch {
      // File does not exist yet; this command can create it.
    }

    const fetched = sortCandlesChronologically(
      await fetchExtendedCandles(input.instId, '1H', input.maxCandles),
    )
    const merged = mergeLatestRows(existingRows, fetched)
    const sortedRows = sortCandlesChronologically([...merged.rows.values()])

    if (!input.dryRun) {
      await writeFile(filePath, rowsToCSV(header, merged.rows, input.storageSymbol, 'okx'))
    }

    return {
      instId: input.instId,
      file: input.file,
      fetchedBars: fetched.length,
      rowsAfterMerge: merged.rows.size,
      newBars: merged.newBars,
      replacedBars: merged.replacedBars,
      oldestTimestamp: sortedRows[0]?.timestamp ?? null,
      newestTimestamp: sortedRows.at(-1)?.timestamp ?? null,
      error: null,
    }
  } catch (error) {
    return {
      instId: input.instId,
      file: input.file,
      fetchedBars: 0,
      rowsAfterMerge: 0,
      newBars: 0,
      replacedBars: 0,
      oldestTimestamp: null,
      newestTimestamp: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function sortCandlesChronologically(candles: LiveCandle[]): LiveCandle[] {
  return [...new Map(candles.map(candle => [candle.timestamp, candle])).values()]
    .sort((left, right) => left.timestamp - right.timestamp)
}

function selectAssets(symbols: string[]) {
  const assets = defaultPaperUniverseAssets()
  if (symbols.length === 0) return assets
  const wanted = new Set(symbols.map(symbol => symbol.trim().toUpperCase()))
  return assets.filter(asset =>
    wanted.has(asset.paperSymbol.toUpperCase()) ||
    wanted.has(asset.base.toUpperCase()) ||
    wanted.has(asset.okxInstId.toUpperCase()),
  )
}

function renderAssetResult(result: BackfillAssetResult): string {
  if (result.error) return `error ${result.instId}: ${result.error}`
  const oldest = result.oldestTimestamp == null
    ? 'missing'
    : new Date(result.oldestTimestamp).toISOString().slice(0, 19)
  const newest = result.newestTimestamp == null
    ? 'missing'
    : new Date(result.newestTimestamp).toISOString().slice(0, 19)
  const status = result.newBars > 0 ? 'backfilled' : 'unchanged'
  return `${status} ${result.instId}: fetched=${result.fetchedBars}, rows=${result.rowsAfterMerge}, new=${result.newBars}, refreshed=${result.replacedBars} | ${oldest} -> ${newest}`
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const tokens = argv.filter(token => token !== '--')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token?.startsWith('--')) continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      out.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = tokens[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(body, next)
      index += 1
    } else {
      out.set(body, 'true')
    }
  }
  return out
}

function parseSymbols(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(symbol => symbol.trim())
    .filter(Boolean)
}

function parsePositiveInteger(raw: string | undefined, fallback: number, field: string): number {
  if (raw == null) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer.`)
  return parsed
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch(error => {
    console.error('backfill_1h_live_data failed:', error)
    process.exit(1)
  })
}
