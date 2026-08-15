import { mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import { loadOkxMarketDataConfig, resolveOkxWarehouseRoot } from '../src/domain/market-data/okx-market-data-config.js'
import {
  atomicWriteJson,
  listRawSegmentManifests,
  sha256Hex,
  updateRawSegmentManifest,
} from './lib/okx_warehouse.js'
import { readFile } from 'node:fs/promises'

export interface CompactReport {
  schemaVersion: 'okx_warehouse_compaction.v1'
  generatedAt: string
  finishedAt: string
  status: 'complete' | 'partial' | 'blocked'
  researchOnly: true
  warehouseRoot: string
  catalogPath: string
  candidates: number
  compacted: number
  skippedAlreadyCompacted: number
  errors: Array<{ segmentId: string; error: string }>
}

export async function compactOkxWarehouse(argv = process.argv.slice(2)): Promise<CompactReport> {
  const raw = parseRawArgs(argv)
  const config = await loadOkxMarketDataConfig(raw.get('configPath'))
  const warehouseRoot = resolveOkxWarehouseRoot(config)
  const catalogPath = resolve(raw.get('catalogPath') ?? join(warehouseRoot, 'catalog', 'openalice_okx.duckdb'))
  const allowDisabled = raw.get('allowDisabled') === 'true'
  const generatedAt = new Date().toISOString()
  if (!config.enabled && !allowDisabled) {
    const blocked: CompactReport = {
      schemaVersion: 'okx_warehouse_compaction.v1', generatedAt, finishedAt: new Date().toISOString(),
      status: 'blocked', researchOnly: true, warehouseRoot, catalogPath, candidates: 0,
      compacted: 0, skippedAlreadyCompacted: 0, errors: [],
    }
    await persistReport(blocked, config.dataRoot)
    return blocked
  }

  await mkdir(dirname(catalogPath), { recursive: true })
  const instance = await DuckDBInstance.create(catalogPath, { threads: '2' })
  const connection = await instance.connect()
  const all = await listRawSegmentManifests(warehouseRoot)
  const candidates = all.filter(item => item.manifest.parquetPath == null)
  const errors: CompactReport['errors'] = []
  let compacted = 0
  try {
    await connection.run(`CREATE TABLE IF NOT EXISTS raw_segments (
      segment_id VARCHAR PRIMARY KEY,
      dataset VARCHAR NOT NULL,
      instrument_type VARCHAR NOT NULL,
      date VARCHAR NOT NULL,
      hour VARCHAR NOT NULL,
      raw_path VARCHAR NOT NULL,
      raw_sha256 VARCHAR NOT NULL,
      row_count BIGINT NOT NULL,
      parquet_path VARCHAR NOT NULL,
      parquet_sha256 VARCHAR NOT NULL,
      compacted_at TIMESTAMP NOT NULL
    )`)
    for (const item of candidates) {
      const manifest = item.manifest
      try {
        const rawPath = resolve(warehouseRoot, manifest.relativePath)
        const partitions = [
          'parquet', `dataset=${manifest.dataset}`, `instrument_type=${manifest.instrumentType}`,
          ...(manifest.bar ? [`bar=${sanitizePartitionValue(manifest.bar)}`] : []),
          ...(manifest.instrumentId ? [`instrument_id=${sanitizePartitionValue(manifest.instrumentId)}`] : []),
          `date=${manifest.date}`, `hour=${manifest.hour}`,
        ]
        const parquetRelative = join(...partitions, `${manifest.segmentId}.parquet`)
        const parquetPath = resolve(warehouseRoot, parquetRelative)
        await mkdir(dirname(parquetPath), { recursive: true })
        await connection.run(`COPY (
          SELECT * FROM read_json_auto('${sqlLiteral(rawPath)}', format='newline_delimited', compression='gzip', maximum_object_size=16777216)
        ) TO '${sqlLiteral(parquetPath)}' (FORMAT PARQUET, COMPRESSION ZSTD)`)
        const countReader = await connection.runAndReadAll(`SELECT count(*)::BIGINT AS row_count FROM read_parquet('${sqlLiteral(parquetPath)}')`)
        const rowCount = Number(countReader.getRowObjectsJson()[0]?.row_count ?? 0)
        if (rowCount !== manifest.rowCount) throw new Error(`Parquet row count mismatch: expected=${manifest.rowCount} actual=${rowCount}`)
        const parquetRaw = await readFile(parquetPath)
        const parquetSha256 = sha256Hex(parquetRaw)
        const fileStat = await stat(parquetPath)
        if (fileStat.size <= 0) throw new Error('Parquet output is empty')
        const updated = { ...manifest, parquetPath: parquetRelative, parquetSha256, parquetRows: rowCount }
        await updateRawSegmentManifest(warehouseRoot, updated)
        await connection.run(`INSERT OR REPLACE INTO raw_segments VALUES (
          '${sqlLiteral(manifest.segmentId)}', '${sqlLiteral(manifest.dataset)}', '${sqlLiteral(manifest.instrumentType)}',
          '${sqlLiteral(manifest.date)}', '${sqlLiteral(manifest.hour)}', '${sqlLiteral(manifest.relativePath)}',
          '${sqlLiteral(manifest.sha256)}', ${manifest.rowCount}, '${sqlLiteral(parquetRelative)}',
          '${parquetSha256}', current_timestamp
        )`)
        compacted += 1
      } catch (error) {
        errors.push({ segmentId: item.manifest.segmentId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    await rebuildViews(connection, warehouseRoot)
  } finally {
    connection.closeSync()
  }

  const report: CompactReport = {
    schemaVersion: 'okx_warehouse_compaction.v1', generatedAt, finishedAt: new Date().toISOString(),
    status: errors.length === 0 ? 'complete' : compacted > 0 ? 'partial' : 'blocked',
    researchOnly: true, warehouseRoot, catalogPath, candidates: candidates.length, compacted,
    skippedAlreadyCompacted: all.length - candidates.length, errors,
  }
  await persistReport(report, config.dataRoot)
  return report
}

export async function rebuildViews(
  connection: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>,
  warehouseRoot: string,
  parquetRelativePaths?: string[],
): Promise<void> {
  const paths = parquetRelativePaths ?? (await listRawSegmentManifests(warehouseRoot))
    .map(item => item.manifest.parquetPath)
    .filter((value): value is string => value != null)
  if (paths.length === 0) {
    await connection.run(`CREATE OR REPLACE VIEW okx_market_events AS SELECT NULL::VARCHAR AS schemaVersion WHERE false`)
    return
  }
  const absolute = [...new Set(paths.map(path => resolve(warehouseRoot, path)))].sort()
  const list = `[${absolute.map(path => `'${sqlLiteral(path)}'`).join(',')}]`
  await connection.run(`CREATE OR REPLACE VIEW okx_market_events AS
    SELECT * FROM read_parquet(${list}, union_by_name=true, hive_partitioning=false, filename=true)`)
  const reader = await connection.runAndReadAll('SELECT count(*)::BIGINT AS row_count FROM okx_market_events')
  const count = Number(reader.getRowObjectsJson()[0]?.row_count ?? 0)
  if (count <= 0) throw new Error('okx_market_events view is empty despite registered Parquet files')
}

async function persistReport(report: CompactReport, dataRoot: string): Promise<void> {
  await atomicWriteJson(resolve(dataRoot, 'runtime', 'okx_warehouse', 'okx_warehouse_compact.latest.json'), report)
  await atomicWriteJson(resolve(dataRoot, 'runtime', 'okx_warehouse', 'okx_warehouse_compact_notification.json'), {
    shouldNotify: report.errors.length > 0,
    deliveryDecision: report.errors.length > 0 ? 'notify' : 'suppress',
    headline: `OKX warehouse compaction: ${report.status}`,
    fullText: `OKX warehouse compaction status=${report.status} candidates=${report.candidates} compacted=${report.compacted} errors=${report.errors.length}`,
  })
}

function sqlLiteral(value: string): string { return value.replaceAll("'", "''") }
function sanitizePartitionValue(value: string): string { return value.replaceAll('/', '_').replaceAll('=', '_') }
function parseRawArgs(argv: string[]): Map<string, string> { const out = new Map<string, string>(); for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token?.startsWith('--')) continue; const next = argv[i + 1]; if (!next || next.startsWith('--')) out.set(token.slice(2), 'true'); else { out.set(token.slice(2), next); i += 1 } } return out }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  compactOkxWarehouse().then(report => { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (report.errors.length > 0) process.exitCode = 1 }).catch(error => { console.error(error); process.exitCode = 1 })
}
