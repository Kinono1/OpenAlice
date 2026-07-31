import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import { loadOkxMarketDataConfig, resolveOkxWarehouseRoot } from '../src/domain/market-data/okx-market-data-config.js'
import { atomicWriteJson, listRawSegmentManifests, sha256Hex } from './lib/okx_warehouse.js'

export interface CompatibilityRow {
  timestamp: number
  datetime: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  symbol: string
  timeframe: '1s' | '5m' | '1h'
  exchange: 'okx'
  instrumentId: string
  availableAt: string
  sourceTransport: string
  sourceEndpoint: string
}

interface MaterializeReport {
  schemaVersion: 'okx_compatibility_materializer.v1'
  generatedAt: string
  status: 'complete' | 'blocked' | 'partial'
  researchOnly: true
  warehouseRoot: string
  catalogPath: string
  uncompactedRawSegments: number
  outputs: Array<{ timeframe: string; instrumentId: string; path: string; rows: number; sha256: string; minTimestamp: number; maxTimestamp: number }>
  errors: Array<{ timeframe: string; instrumentId: string; error: string }>
  blockers: string[]
}

const CSV_HEADER = 'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange'
const SUPPORTED_TIMEFRAMES = ['1s', '5m', '1h'] as const

export async function materializeOkxCompatibility(argv = process.argv.slice(2)): Promise<MaterializeReport> {
  const raw = parseRawArgs(argv)
  const config = await loadOkxMarketDataConfig(raw.get('configPath'))
  const warehouseRoot = resolveOkxWarehouseRoot(config)
  const catalogPath = resolve(raw.get('catalogPath') ?? join(warehouseRoot, 'catalog', 'openalice_okx.duckdb'))
  const generatedAt = new Date().toISOString()
  const blockers: string[] = []
  if (!config.enabled && raw.get('allowDisabled') !== 'true') blockers.push('collector_disabled_by_config')
  try { await stat(catalogPath) } catch { blockers.push('duckdb_catalog_missing') }
  if (blockers.length > 0) {
    const blocked: MaterializeReport = { schemaVersion: 'okx_compatibility_materializer.v1', generatedAt, status: 'blocked', researchOnly: true, warehouseRoot, catalogPath, uncompactedRawSegments: 0, outputs: [], errors: [], blockers }
    await persistReport(blocked, config.dataRoot, raw.get('reportPath'))
    return blocked
  }

  const timeframes = parseTimeframes(raw.get('timeframes'))
  const outputRoot = resolve(raw.get('outputRoot') ?? 'data/market')
  const uncompactedRawPaths = (await listRawSegmentManifests(warehouseRoot))
    .filter(item => item.manifest.dataset === 'candle' && item.manifest.parquetPath == null)
    .map(item => resolve(warehouseRoot, item.manifest.relativePath))
  const instance = await DuckDBInstance.create(catalogPath, { threads: '2' })
  const connection = await instance.connect()
  const outputs: MaterializeReport['outputs'] = []
  const errors: MaterializeReport['errors'] = []
  try {
    for (const timeframe of timeframes) {
      let rows: CompatibilityRow[] = []
      try {
        rows = await queryCompatibilityRows(connection, timeframe, uncompactedRawPaths)
      } catch (error) {
        errors.push({ timeframe, instrumentId: '*', error: error instanceof Error ? error.message : String(error) })
        continue
      }
      if (rows.length === 0) {
        errors.push({ timeframe, instrumentId: '*', error: `no_confirmed_canonical_rows:${timeframe}` })
        continue
      }
      const byInstrument = new Map<string, CompatibilityRow[]>()
      for (const row of rows) {
        const group = byInstrument.get(row.instrumentId) ?? []
        group.push(row)
        byInstrument.set(row.instrumentId, group)
      }
      for (const [instrumentId, instrumentRows] of byInstrument) {
        const target = compatibilityPath(outputRoot, instrumentId, timeframe)
        try {
          const written = await writeCompatibilityCsvAtomic(target, instrumentRows, timeframe)
          outputs.push({ timeframe, instrumentId, path: target, ...written })
        } catch (error) {
          errors.push({ timeframe, instrumentId, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
  } finally {
    connection.closeSync()
  }

  const report: MaterializeReport = {
    schemaVersion: 'okx_compatibility_materializer.v1', generatedAt,
    status: errors.length === 0 ? 'complete' : outputs.length > 0 ? 'partial' : 'blocked',
    researchOnly: true, warehouseRoot, catalogPath, uncompactedRawSegments: uncompactedRawPaths.length,
    outputs, errors, blockers: [],
  }
  await persistReport(report, config.dataRoot, raw.get('reportPath'))
  return report
}

async function queryCompatibilityRows(
  connection: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>,
  timeframe: CompatibilityRow['timeframe'],
  uncompactedRawPaths: string[] = [],
): Promise<CompatibilityRow[]> {
  const sourceRelation = compatibilitySourceRelation(uncompactedRawPaths)
  const reader = await connection.runAndReadAll(`
    WITH source_events AS (
      ${sourceRelation}
    ), candidates AS (
      SELECT
        instrumentId,
        eventTime,
        availableAt,
        sourceTransport,
        sourceEndpoint,
        TRY_CAST(payload.open AS DOUBLE) AS open,
        TRY_CAST(payload.high AS DOUBLE) AS high,
        TRY_CAST(payload.low AS DOUBLE) AS low,
        TRY_CAST(payload.close AS DOUBLE) AS close,
        TRY_CAST(payload.volume AS DOUBLE) AS volume,
        ROW_NUMBER() OVER (
          PARTITION BY instrumentId, eventTime, payload.bar
          ORDER BY
            CASE
              WHEN '${sqlLiteral(timeframe)}' = '5m' AND sourceTransport = 'rest' THEN 3
              WHEN sourceTransport = 'derived' THEN 2
              ELSE 1
            END DESC,
            availableAt ASC,
            dedupKey ASC
        ) AS source_rank
      FROM source_events
      WHERE dataset = 'candle'
        AND instrumentType = 'SWAP'
        AND confirmed = true
        AND payload.bar = '${sqlLiteral(timeframe)}'
        AND instrumentId LIKE '%-USDT-SWAP'
    )
    SELECT * EXCLUDE (source_rank)
    FROM candidates
    WHERE source_rank = 1
      AND open > 0 AND high > 0 AND low > 0 AND close > 0 AND volume >= 0
    ORDER BY instrumentId, eventTime
  `)
  return reader.getRowObjectsJson().map(raw => {
    const instrumentId = String(raw.instrumentId ?? '')
    const timestamp = parseDuckDbUtcTimestamp(raw.eventTime)
    return {
      timestamp,
      datetime: new Date(timestamp).toISOString(),
      open: Number(raw.open), high: Number(raw.high), low: Number(raw.low), close: Number(raw.close), volume: Number(raw.volume),
      symbol: storageSymbol(instrumentId), timeframe, exchange: 'okx' as const, instrumentId,
      availableAt: duckDbUtcIso(raw.availableAt), sourceTransport: String(raw.sourceTransport ?? ''), sourceEndpoint: String(raw.sourceEndpoint ?? ''),
    }
  })
}

export function compatibilitySourceRelation(uncompactedRawPaths: string[]): string {
  if (uncompactedRawPaths.length === 0) return 'SELECT * FROM okx_market_events'
  const paths = `[${[...new Set(uncompactedRawPaths)].sort().map(path => `'${sqlLiteral(path)}'`).join(',')}]`
  return `
    SELECT * FROM okx_market_events
    UNION ALL BY NAME
    SELECT * FROM read_json_auto(${paths}, format='newline_delimited', compression='gzip', union_by_name=true, maximum_object_size=16777216)
  `
}

/** DuckDB TIMESTAMP is UTC in this catalog but the Node binding returns a zone-less string. */
export function parseDuckDbUtcTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  const raw = String(value ?? '').trim()
  const explicit = Date.parse(raw)
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) {
    return Date.parse(`${raw.replace(' ', 'T')}Z`)
  }
  return explicit
}

function duckDbUtcIso(value: unknown): string {
  const timestamp = parseDuckDbUtcTimestamp(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ''
}

export async function writeCompatibilityCsvAtomic(
  path: string,
  rows: CompatibilityRow[],
  expectedTimeframe: CompatibilityRow['timeframe'],
): Promise<{ rows: number; sha256: string; minTimestamp: number; maxTimestamp: number }> {
  const validated = validateCompatibilityRows(rows, expectedTimeframe)
  const csv = `${CSV_HEADER}\n${validated.map(row => [
    row.timestamp, row.datetime, row.open, row.high, row.low, row.close, row.volume,
    row.symbol, row.timeframe, row.exchange,
  ].join(',')).join('\n')}\n`
  const resolved = resolve(path)
  const temp = `${resolved}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await mkdir(dirname(resolved), { recursive: true })
  const handle = await open(temp, 'w', 0o600)
  try {
    await handle.writeFile(csv, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  const reparsed = parseCompatibilityCsv(await readFile(temp, 'utf-8'))
  validateCompatibilityRows(reparsed, expectedTimeframe)
  await rename(temp, resolved)
  return {
    rows: validated.length,
    sha256: sha256Hex(csv),
    minTimestamp: validated[0].timestamp,
    maxTimestamp: validated.at(-1)!.timestamp,
  }
}

export function validateCompatibilityRows(rows: CompatibilityRow[], expectedTimeframe: CompatibilityRow['timeframe']): CompatibilityRow[] {
  if (rows.length === 0) throw new Error(`compatibility materializer has no ${expectedTimeframe} rows`)
  const sorted = [...rows].sort((left, right) => left.timestamp - right.timestamp)
  const instrumentId = sorted[0].instrumentId
  const symbol = sorted[0].symbol
  let previous = -Infinity
  for (const row of sorted) {
    if (!Number.isFinite(row.timestamp) || row.timestamp <= previous) throw new Error(`non_monotonic_or_duplicate_timestamp:${row.timestamp}`)
    if (row.timeframe !== expectedTimeframe) throw new Error(`timeframe_mismatch:${row.timeframe}`)
    if (row.exchange !== 'okx') throw new Error(`exchange_mismatch:${row.exchange}`)
    if (row.instrumentId !== instrumentId || row.symbol !== symbol) throw new Error('mixed_instrument_output')
    if (![row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)) throw new Error(`non_finite_ohlcv:${row.timestamp}`)
    if (row.open <= 0 || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close) || row.low <= 0 || row.volume < 0) throw new Error(`invalid_ohlcv:${row.timestamp}`)
    previous = row.timestamp
  }
  return sorted
}

function parseCompatibilityCsv(csv: string): CompatibilityRow[] {
  const lines = csv.trim().split('\n')
  if (lines[0] !== CSV_HEADER) throw new Error('compatibility_header_mismatch')
  return lines.slice(1).filter(Boolean).map(line => {
    const [timestamp, datetime, open, high, low, close, volume, symbol, timeframe, exchange] = line.split(',')
    const base = symbol.replace(/_USDT_USDT$/, '')
    return {
      timestamp: Number(timestamp), datetime, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume),
      symbol, timeframe: timeframe as CompatibilityRow['timeframe'], exchange: exchange as 'okx',
      instrumentId: `${base}-USDT-SWAP`, availableAt: datetime, sourceTransport: 'materialized', sourceEndpoint: 'duckdb_parquet',
    }
  })
}

function compatibilityPath(outputRoot: string, instrumentId: string, timeframe: CompatibilityRow['timeframe']): string {
  const directory = timeframe === '5m' ? 'live_5m' : timeframe === '1h' ? 'live_accumulated' : 'live_1s'
  return join(outputRoot, directory, `${storageSymbol(instrumentId)}_${timeframe}.csv`)
}

function storageSymbol(instrumentId: string): string {
  const match = /^([A-Z0-9]+)-USDT-SWAP$/.exec(instrumentId)
  if (!match?.[1]) throw new Error(`unsupported compatibility instrument: ${instrumentId}`)
  return `${match[1]}_USDT_USDT`
}

function parseTimeframes(raw: string | undefined): CompatibilityRow['timeframe'][] {
  const values = raw?.split(',').map(value => value.trim()).filter(Boolean) ?? [...SUPPORTED_TIMEFRAMES]
  for (const value of values) if (!SUPPORTED_TIMEFRAMES.includes(value as any)) throw new Error(`unsupported compatibility timeframe: ${value}`)
  return [...new Set(values)] as CompatibilityRow['timeframe'][]
}

async function persistReport(report: MaterializeReport, dataRoot: string, path?: string): Promise<void> {
  await atomicWriteJson(resolve(path ?? join(dataRoot, 'runtime', 'okx_warehouse', 'okx_compatibility_materializer.latest.json')), report)
}

function sqlLiteral(value: string): string { return value.replaceAll("'", "''") }
function parseRawArgs(argv: string[]): Map<string, string> { const out = new Map<string, string>(); for (let index = 0; index < argv.length; index += 1) { const token = argv[index]; if (!token?.startsWith('--')) continue; const next = argv[index + 1]; if (!next || next.startsWith('--')) out.set(token.slice(2), 'true'); else { out.set(token.slice(2), next); index += 1 } } return out }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  materializeOkxCompatibility().then(report => { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (report.status !== 'complete') process.exitCode = 1 }).catch(error => { console.error(error); process.exitCode = 1 })
}
