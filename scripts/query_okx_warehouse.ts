import { constants } from 'node:fs'
import { access, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import { loadOkxMarketDataConfig, resolveOkxWarehouseRoot } from '../src/domain/market-data/okx-market-data-config.js'
import type { OkxMarketDataset } from '../src/domain/market-data/okx-warehouse-types.js'
import { inspectArchiveStatus, type ArchiveDependencies, type ArchiveBatchManifest } from './lib/okx_ssd_archive.js'
import { atomicWriteJson, listRawSegmentManifests } from './lib/okx_warehouse.js'

const DATASETS = new Set<OkxMarketDataset>([
  'instrument', 'ticker', 'candle', 'funding', 'mark_index', 'open_interest', 'long_short',
  'trade', 'orderbook_snapshot', 'orderbook_delta', 'liquidation',
])

export interface OkxWarehouseQueryReport {
  schemaVersion: 'okx_warehouse_query.v1'
  generatedAt: string
  status: 'complete' | 'blocked_cold_storage_offline' | 'blocked_data_integrity'
  researchOnly: true
  dataset: OkxMarketDataset
  from: string
  to: string
  requestedDates: string[]
  coveredDates: string[]
  missingDates: string[]
  hotFiles: number
  coldFiles: number
  sourceLocations: Array<'hot' | 'cold'>
  rows: number
  minEventTime: string | null
  maxEventTime: string | null
  limited: boolean
  events: Record<string, unknown>[]
  blockers: string[]
}

export async function queryOkxWarehouse(
  argv = process.argv.slice(2),
  dependencies?: ArchiveDependencies,
): Promise<OkxWarehouseQueryReport> {
  const raw = parseRawArgs(argv)
  const dataset = raw.get('dataset') as OkxMarketDataset | undefined
  const from = raw.get('from')
  const to = raw.get('to')
  if (!dataset || !DATASETS.has(dataset)) throw new Error(`query requires a valid --dataset (${[...DATASETS].join(',')})`)
  if (!from || !to || !isDate(from) || !isDate(to) || from > to) throw new Error('query requires --from YYYY-MM-DD and --to YYYY-MM-DD with from <= to')
  const limit = positiveInteger(raw.get('limit'), 10_000, 100_000)
  const config = await loadOkxMarketDataConfig(raw.get('configPath'))
  const warehouseRoot = resolveOkxWarehouseRoot(config)
  const enrollmentPath = raw.get('enrollmentPath') ?? config.archive.enrollmentPath
  const requestedDates = enumerateDates(from, to)
  const localFiles = await collectLocalParquet(warehouseRoot, dataset, from, to)
  const archive = await inspectArchiveStatus({ config, warehouseRoot, enrollmentPath, dependencies })
  const coldFiles = archive.archiveRoot
    ? await collectColdParquet(archive.archiveRoot, dataset, from, to)
    : []
  const allFiles = deduplicateFiles([...localFiles, ...coldFiles])
  const coveredDates = [...new Set(allFiles.map(file => file.date))].sort()
  const missingDates = requestedDates.filter(date => !coveredDates.includes(date))
  const base = {
    schemaVersion: 'okx_warehouse_query.v1' as const,
    generatedAt: new Date().toISOString(),
    researchOnly: true as const,
    dataset, from, to, requestedDates, coveredDates, missingDates,
    hotFiles: localFiles.length, coldFiles: coldFiles.length,
    sourceLocations: [...new Set(allFiles.map(file => file.location))].sort() as Array<'hot' | 'cold'>,
  }
  if (missingDates.length > 0 && !archive.archiveRoot) {
    return persistQueryReport({
      ...base, status: 'blocked_cold_storage_offline', rows: 0, minEventTime: null, maxEventTime: null,
      limited: false, events: [], blockers: ['blocked_cold_storage_offline', `missing_dates:${missingDates.join(',')}`],
    }, config.dataRoot, raw.get('outputPath'))
  }
  if (missingDates.length > 0 || allFiles.length === 0) {
    return persistQueryReport({
      ...base, status: 'blocked_data_integrity', rows: 0, minEventTime: null, maxEventTime: null,
      limited: false, events: [], blockers: [allFiles.length === 0 ? 'no_matching_parquet' : `missing_dates:${missingDates.join(',')}`],
    }, config.dataRoot, raw.get('outputPath'))
  }

  const absolutePaths = allFiles.map(file => file.path).sort()
  const coldPaths = new Set(coldFiles.map(file => file.path))
  const pathList = `[${absolutePaths.map(path => `'${sqlLiteral(path)}'`).join(',')}]`
  const coldPredicate = coldPaths.size > 0
    ? `filename IN [${[...coldPaths].sort().map(path => `'${sqlLiteral(path)}'`).join(',')}]`
    : 'false'
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  try {
    const reader = await connection.runAndReadAll(`
      WITH source AS (
        SELECT *, CASE WHEN ${coldPredicate} THEN 'cold' ELSE 'hot' END AS _sourceLocation
        FROM read_parquet(${pathList}, union_by_name=true, hive_partitioning=false, filename=true)
        WHERE dataset = '${sqlLiteral(dataset)}'
          AND eventTime >= TIMESTAMP '${sqlLiteral(from)} 00:00:00'
          AND eventTime < TIMESTAMP '${sqlLiteral(nextDate(to))} 00:00:00'
      ), deduplicated AS (
        SELECT * EXCLUDE (filename), filename AS _sourcePath,
          ROW_NUMBER() OVER (
            PARTITION BY dedupKey
            ORDER BY CASE WHEN _sourceLocation = 'hot' THEN 0 ELSE 1 END, availableAt ASC, ingestedAt ASC, filename ASC
          ) AS _dedupRank
        FROM source
      )
      SELECT * EXCLUDE (_dedupRank)
      FROM deduplicated
      WHERE _dedupRank = 1
      ORDER BY eventTime, dedupKey
      LIMIT ${limit + 1}
    `)
    const rawRows = (reader.getRowObjectsJson() as Record<string, unknown>[]).map(normalizeWarehouseTimestamps)
    const limited = rawRows.length > limit
    const events = limited ? rawRows.slice(0, limit) : rawRows
    const minEventTime = events.length > 0 ? stringValue(events[0]?.eventTime) : null
    const maxEventTime = events.length > 0 ? stringValue(events.at(-1)?.eventTime) : null
    return persistQueryReport({
      ...base, status: 'complete', rows: events.length, minEventTime, maxEventTime,
      limited, events, blockers: [],
    }, config.dataRoot, raw.get('outputPath'))
  } finally {
    connection.closeSync()
  }
}

interface QueryFile { path: string; date: string; relativePath: string; location: 'hot' | 'cold' }

async function collectLocalParquet(root: string, dataset: OkxMarketDataset, from: string, to: string): Promise<QueryFile[]> {
  const out: QueryFile[] = []
  for (const item of await listRawSegmentManifests(root)) {
    const manifest = item.manifest
    if (manifest.dataset !== dataset || manifest.date < from || manifest.date > to || !manifest.parquetPath) continue
    const path = resolve(root, manifest.parquetPath)
    if (await readable(path)) out.push({ path, date: manifest.date, relativePath: manifest.parquetPath, location: 'hot' })
  }
  return out
}

async function collectColdParquet(archiveRoot: string, dataset: OkxMarketDataset, from: string, to: string): Promise<QueryFile[]> {
  const out: QueryFile[] = []
  const batches = await readdir(join(archiveRoot, 'batches'), { withFileTypes: true }).catch(() => [])
  for (const entry of batches) {
    if (!entry.isDirectory()) continue
    const batchRoot = join(archiveRoot, 'batches', entry.name)
    if (!await readable(join(batchRoot, 'COMMITTED'))) continue
    try {
      const batch = JSON.parse(await readFile(join(batchRoot, 'batch.manifest.json'), 'utf-8')) as ArchiveBatchManifest
      if (batch.status !== 'committed') continue
      for (const file of batch.files) {
        if (file.kind !== 'parquet' || !file.relativePath.includes(`dataset=${dataset}`)) continue
        const date = /date=(\d{4}-\d{2}-\d{2})/.exec(file.relativePath)?.[1]
        if (!date || date < from || date > to) continue
        const path = join(archiveRoot, 'objects', file.relativePath)
        if (await readable(path)) out.push({ path, date, relativePath: file.relativePath, location: 'cold' })
      }
    } catch { /* Invalid or incomplete batches are never queryable. */ }
  }
  return out
}

function deduplicateFiles(files: QueryFile[]): QueryFile[] {
  return [...new Map(files.map(file => [file.path, file])).values()]
}

async function persistQueryReport(report: OkxWarehouseQueryReport, dataRoot: string, outputPath?: string): Promise<OkxWarehouseQueryReport> {
  await atomicWriteJson(resolve(outputPath ?? join(dataRoot, 'runtime', 'okx_warehouse', 'okx_warehouse_query.latest.json')), report)
  return report
}

async function readable(path: string): Promise<boolean> { try { await access(path, constants.R_OK); return true } catch { return false } }
function enumerateDates(from: string, to: string): string[] { const out: string[] = []; for (let value = from; value <= to; value = nextDate(value)) out.push(value); return out }
function nextDate(value: string): string { const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10) }
function isDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value }
function positiveInteger(value: string | undefined, fallback: number, maximum: number): number { const parsed = Number(value ?? fallback); if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`limit must be an integer between 1 and ${maximum}`); return parsed }
function stringValue(value: unknown): string | null { return typeof value === 'string' ? value : value == null ? null : String(value) }
function normalizeWarehouseTimestamps(row: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...row }
  for (const key of ['eventTime', 'availableAt', 'ingestedAt']) {
    if (typeof normalized[key] !== 'string') continue
    const raw = normalized[key] as string
    const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`
    const parsed = Date.parse(iso)
    if (Number.isFinite(parsed)) normalized[key] = new Date(parsed).toISOString()
  }
  return normalized
}
function sqlLiteral(value: string): string { return value.replaceAll("'", "''") }
function parseRawArgs(argv: string[]): Map<string, string> { const out = new Map<string, string>(); for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token?.startsWith('--')) continue; const next = argv[i + 1]; if (!next || next.startsWith('--')) out.set(token.slice(2), 'true'); else { out.set(token.slice(2), next); i += 1 } } return out }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  queryOkxWarehouse().then(report => { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (report.status !== 'complete') process.exitCode = 2 }).catch(error => { console.error(error); process.exitCode = 1 })
}
