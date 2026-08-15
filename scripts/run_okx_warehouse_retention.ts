import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadOkxMarketDataConfig, resolveOkxWarehouseRoot } from '../src/domain/market-data/okx-market-data-config.js'
import type { OkxRawSegmentManifest } from '../src/domain/market-data/okx-warehouse-types.js'
import { inspectArchiveStatus, verifyArchiveBatch, type ArchiveDependencies } from './lib/okx_ssd_archive.js'
import { atomicWriteJson, listRawSegmentManifests, readRawSegmentEvents, updateRawSegmentManifest } from './lib/okx_warehouse.js'

export interface RetentionReport {
  schemaVersion: 'okx_warehouse_retention.v1'
  generatedAt: string
  status: 'complete' | 'blocked' | 'partial'
  researchOnly: true
  deletedFiles: number
  deletedBytes: number
  eligibleSegments: number
  verifiedBatches: string[]
  skipped: Array<{ segmentId: string; reason: string }>
  errors: Array<{ segmentId: string; error: string }>
}

export async function runOkxWarehouseRetention(argv = process.argv.slice(2), dependencies?: ArchiveDependencies): Promise<RetentionReport> {
  const raw = parseRawArgs(argv)
  const config = await loadOkxMarketDataConfig(raw.get('configPath'))
  const warehouseRoot = resolveOkxWarehouseRoot(config)
  const now = raw.get('now') ? new Date(raw.get('now')!) : new Date()
  const inspected = await inspectArchiveStatus({ config, warehouseRoot, dependencies })
  const base: RetentionReport = { schemaVersion: 'okx_warehouse_retention.v1', generatedAt: now.toISOString(), status: 'blocked', researchOnly: true, deletedFiles: 0, deletedBytes: 0, eligibleSegments: 0, verifiedBatches: [], skipped: [], errors: [] }
  if (!inspected.archiveRoot || !inspected.status.identityVerified) {
    base.skipped.push({ segmentId: '*', reason: inspected.status.status })
    await persist(base, config.dataRoot)
    return base
  }
  const manifests = await listRawSegmentManifests(warehouseRoot)
  const verified = new Map<string, boolean>()
  for (const item of manifests) {
    const manifest = item.manifest
    if (!manifest.archivedBatchId || !manifest.archivedAt || manifest.localDeletedAt) {
      base.skipped.push({ segmentId: manifest.segmentId, reason: manifest.localDeletedAt ? 'already_deleted' : 'not_archived' })
      continue
    }
    const retentionDays = await retentionDaysFor(warehouseRoot, manifest)
    if (!Number.isFinite(retentionDays)) {
      base.skipped.push({ segmentId: manifest.segmentId, reason: 'long_term_local_retention' })
      continue
    }
    const ageMs = now.getTime() - Date.parse(manifest.maxEventTime ?? manifest.sealedAt)
    if (ageMs < retentionDays * 24 * 60 * 60 * 1000) {
      base.skipped.push({ segmentId: manifest.segmentId, reason: `within_${retentionDays}d_hot_window` })
      continue
    }
    base.eligibleSegments += 1
    let batchVerified = verified.get(manifest.archivedBatchId)
    if (batchVerified == null) {
      const result = await verifyArchiveBatch({ config, warehouseRoot, batchId: manifest.archivedBatchId, dependencies })
      batchVerified = result.verified
      verified.set(manifest.archivedBatchId, batchVerified)
      if (batchVerified) base.verifiedBatches.push(manifest.archivedBatchId)
    }
    if (!batchVerified) {
      base.skipped.push({ segmentId: manifest.segmentId, reason: 'archive_batch_verification_failed' })
      continue
    }
    try {
      const deleted: Array<{ relativePath: string; bytes: number }> = []
      for (const relativePath of [manifest.relativePath, manifest.parquetPath].filter((value): value is string => Boolean(value))) {
        const target = resolve(warehouseRoot, relativePath)
        const fileStat = await stat(target).catch(() => null)
        if (!fileStat) continue
        await rm(target)
        deleted.push({ relativePath, bytes: fileStat.size })
        base.deletedFiles += 1
        base.deletedBytes += fileStat.size
      }
      const deletionManifestPath = join(warehouseRoot, 'manifests', 'deletions', manifest.date, `${manifest.segmentId}.deletion.json`)
      await atomicWriteJson(deletionManifestPath, {
        schemaVersion: 'okx_local_deletion.v1', generatedAt: now.toISOString(), segmentId: manifest.segmentId,
        archiveBatchId: manifest.archivedBatchId, archiveBatchVerified: true, retentionDays, deleted,
      })
      await updateRawSegmentManifest(warehouseRoot, { ...manifest, localDeletedAt: now.toISOString(), localDeletionManifestPath: deletionManifestPath })
    } catch (error) {
      base.errors.push({ segmentId: manifest.segmentId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  base.status = base.errors.length > 0 ? (base.deletedFiles > 0 ? 'partial' : 'blocked') : 'complete'
  await persist(base, config.dataRoot)
  return base
}

async function retentionDaysFor(root: string, manifest: OkxRawSegmentManifest): Promise<number> {
  if (['trade', 'orderbook_snapshot', 'orderbook_delta', 'liquidation'].includes(manifest.dataset)) return 7
  if (manifest.dataset === 'ticker') return 30
  if (['funding', 'mark_index', 'open_interest', 'long_short'].includes(manifest.dataset)) return 90
  if (manifest.dataset === 'instrument') return Infinity
  if (manifest.dataset === 'candle') {
    try {
      const first = (await readRawSegmentEvents(root, manifest))[0]
      const bar = (first?.payload as { bar?: unknown })?.bar
      if (bar === '1s') return 7
      if (bar === '1m') return 30
      if (bar === '5m') return 90
    } catch { return Infinity }
  }
  return Infinity
}

async function persist(report: RetentionReport, dataRoot: string): Promise<void> {
  await atomicWriteJson(resolve(dataRoot, 'runtime', 'storage', 'okx_warehouse_retention.latest.json'), report)
  await atomicWriteJson(resolve(dataRoot, 'runtime', 'storage', 'okx_warehouse_retention_notification.json'), {
    shouldNotify: report.errors.length > 0,
    deliveryDecision: report.errors.length > 0 ? 'notify' : 'suppress',
    headline: `OKX local retention: ${report.status}`,
    fullText: `OKX retention status=${report.status} eligible=${report.eligibleSegments} deletedFiles=${report.deletedFiles} deletedBytes=${report.deletedBytes} errors=${report.errors.length}`,
  })
}

function parseRawArgs(argv: string[]): Map<string, string> { const out = new Map<string, string>(); for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token?.startsWith('--')) continue; const next = argv[i + 1]; if (!next || next.startsWith('--')) out.set(token.slice(2), 'true'); else { out.set(token.slice(2), next); i += 1 } } return out }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) runOkxWarehouseRetention().then(report => { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (report.errors.length > 0) process.exitCode = 1 }).catch(error => { console.error(error); process.exitCode = 1 })
