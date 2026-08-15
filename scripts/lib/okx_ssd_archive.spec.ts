import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OkxMarketDataConfig } from '../../src/domain/market-data/okx-market-data-config.js'
import type { OkxMarketEvent } from '../../src/domain/market-data/okx-warehouse-types.js'
import { defaultOkxMarketDataConfig } from '../../src/domain/market-data/okx-market-data-config.js'
import { appendOkxMarketEvents, listRawSegmentManifests, payloadHash } from './okx_warehouse.js'
import { archiveSealedWarehouse, cleanupStaleArchiveStaging, enrollArchiveVolume, inspectArchiveStatus, restoreArchiveRange, validateEnrollmentVolume, verifyArchiveBatch, type VolumeInfo } from './okx_ssd_archive.js'

function volume(mountPoint: string, overrides: Partial<VolumeInfo> = {}): VolumeInfo {
  return { mountPoint, volumeName: 'shield', volumeUuid: 'UUID-1', fileSystem: 'apfs', deviceNode: '/dev/disk9s1', internal: false, network: false, readOnly: false, totalBytes: 500 * 1024 ** 3, freeBytes: 400 * 1024 ** 3, ...overrides }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oa-ssd-'))
  const dataRoot = join(root, 'data')
  const warehouseRoot = join(dataRoot, 'warehouse', 'okx')
  const mountPoint = join(root, 'Volumes', 'shield')
  const enrollmentPath = join(root, 'enrollment.json')
  const config: OkxMarketDataConfig = { ...defaultOkxMarketDataConfig(), dataRoot, archive: { ...defaultOkxMarketDataConfig().archive, enrollmentPath } }
  const payload = { last: 100 }
  const event: OkxMarketEvent = { schemaVersion: 'okx_market_event.v1', exchange: 'okx', dataset: 'ticker', instrumentType: 'SWAP', instrumentId: 'BTC-USDT-SWAP', instrumentFamily: 'BTC-USDT', symbol: 'BTC-USDT-SWAP', channel: 'tickers', sourceTransport: 'rest', sourceEndpoint: '/api/v5/market/tickers', eventTime: '2026-07-01T00:00:00Z', availableAt: '2026-07-01T00:00:01Z', ingestedAt: '2026-07-01T00:00:02Z', confirmed: null, sequenceId: null, checksum: null, collectionRunId: 'ssd-test', universeManifestId: null, dedupKey: 'okx|ticker|BTC-USDT-SWAP|2026-07-01T00:00:00Z', payloadHash: payloadHash(payload), payload }
  await appendOkxMarketEvents(warehouseRoot, [event])
  const testNow = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const deps = { inspectVolume: async () => volume(mountPoint), listMountedVolumes: async () => [volume(mountPoint)], now: () => testNow, allowNonVolumesMountForTests: true }
  return { root, dataRoot, warehouseRoot, mountPoint, enrollmentPath, config, deps }
}

describe('okx SSD archive', () => {
  it('rejects internal, network, read-only, unsupported and wrong-name volumes', () => {
    expect(() => validateEnrollmentVolume(volume('/Volumes/shield', { internal: true }), 'shield')).toThrow('external')
    expect(() => validateEnrollmentVolume(volume('/Volumes/shield', { network: true }), 'shield')).toThrow('network')
    expect(() => validateEnrollmentVolume(volume('/Volumes/shield', { readOnly: true }), 'shield')).toThrow('read-only')
    expect(() => validateEnrollmentVolume(volume('/Volumes/shield', { fileSystem: 'unsupported' }), 'shield')).toThrow('unsupported')
    expect(() => validateEnrollmentVolume(volume('/Volumes/shield', { volumeName: 'other' }), 'shield')).toThrow('expected volume name')
  })

  it('enrolls by UUID plus archiveId and blocks identity mismatch', async () => {
    const fx = await fixture()
    const enrolled = await enrollArchiveVolume({ mountPoint: fx.mountPoint, config: fx.config, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, dependencies: fx.deps })
    expect(enrolled.volume.volumeUuid).toBe('UUID-1')
    const ready = await inspectArchiveStatus({ config: fx.config, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, dependencies: fx.deps })
    expect(ready.status.status).toBe('archive_pending')
    await writeFile(join(fx.mountPoint, '.openalice-archive', 'identity.json'), '{"archiveId":"wrong","volumeUuid":"UUID-1"}\n')
    const blocked = await inspectArchiveStatus({ config: fx.config, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, dependencies: fx.deps })
    expect(blocked.status.status).toBe('blocked_volume_identity_mismatch')
  })

  it('copies, verifies, commits and restores without deleting source', async () => {
    const fx = await fixture()
    await mkdir(join(fx.warehouseRoot, 'manifests', 'universe'), { recursive: true })
    await writeFile(join(fx.warehouseRoot, 'manifests', 'universe', 'universe-1.json'), '{"manifestId":"universe-1"}\n')
    await mkdir(join(fx.warehouseRoot, 'quarantine', 'gaps'), { recursive: true })
    await writeFile(join(fx.warehouseRoot, 'quarantine', 'gaps', 'gap-1.json'), '{"gap":true}\n')
    await mkdir(join(fx.warehouseRoot, 'catalog'), { recursive: true })
    await writeFile(join(fx.warehouseRoot, 'catalog', 'openalice_okx.duckdb'), 'catalog-snapshot-fixture')
    await enrollArchiveVolume({ mountPoint: fx.mountPoint, config: fx.config, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, dependencies: fx.deps })
    const archived = await archiveSealedWarehouse({ config: fx.config, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, minAgeMs: 0, dependencies: fx.deps })
    expect(archived.status.status).toBe('archive_complete')
    expect(archived.batch?.status).toBe('committed')
    const manifests = await listRawSegmentManifests(fx.warehouseRoot)
    expect(manifests[0].manifest.archivedBatchId).toBe(archived.batch?.batchId)
    await expect(stat(join(fx.warehouseRoot, manifests[0].manifest.relativePath))).resolves.toBeDefined()
    const verified = await verifyArchiveBatch({ config: fx.config, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, batchId: archived.batch!.batchId, dependencies: fx.deps })
    expect(verified.verified).toBe(true)
    expect(archived.batch?.files.map(file => file.kind)).toEqual(expect.arrayContaining(['raw', 'manifest', 'catalog', 'quarantine']))
    expect(archived.batch?.files.some(file => file.relativePath.includes('manifests/universe/universe-1.json'))).toBe(true)
    const restored = await restoreArchiveRange({ config: fx.config, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, dataset: 'ticker', from: '2026-07-01', to: '2026-07-01', outputRoot: join(fx.root, 'restore'), dependencies: fx.deps })
    expect(restored).toMatchObject({ status: 'complete', restoredFiles: 1, errors: [] })
  })

  it('returns blocked_not_mounted without creating a fake /Volumes directory', async () => {
    const fx = await fixture()
    await enrollArchiveVolume({ mountPoint: fx.mountPoint, config: fx.config, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, dependencies: fx.deps })
    const status = await inspectArchiveStatus({ config: fx.config, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, dependencies: { ...fx.deps, listMountedVolumes: async () => [] } })
    expect(status.status.status).toBe('blocked_ssd_not_mounted')
  })

  it('estimates pending bytes and earliest date before first enrollment', async () => {
    const fx = await fixture()
    const status = await inspectArchiveStatus({ config: fx.config, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, dependencies: { ...fx.deps, listMountedVolumes: async () => [] } })
    expect(status.status).toMatchObject({ status: 'not_enrolled', enrolled: false, pendingFiles: 1, earliestPendingDate: '2026-07-01' })
    expect(status.status.pendingBytes).toBeGreaterThan(0)
  })

  it('skips a second archive run while the single-instance lock is held', async () => {
    const fx = await fixture()
    await enrollArchiveVolume({ mountPoint: fx.mountPoint, config: fx.config, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, dependencies: fx.deps })
    const lockPath = join(fx.dataRoot, 'runtime', 'storage', 'ssd_archive.lock')
    await mkdir(join(fx.dataRoot, 'runtime', 'storage'), { recursive: true })
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`)
    const result = await archiveSealedWarehouse({ config: fx.config, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, minAgeMs: 0, dependencies: fx.deps })
    expect(result).toMatchObject({ lockStatus: 'skipped_lock_held', batch: null })
    const manifests = await listRawSegmentManifests(fx.warehouseRoot)
    expect(manifests[0].manifest.archivedBatchId).toBeNull()
  })

  it('cleans only stale staging without an active lease and records a manifest', async () => {
    const fx = await fixture()
    const archiveRoot = join(fx.mountPoint, fx.config.archive.archiveRelativeRoot)
    const stale = join(archiveRoot, '.staging', 'stale-batch')
    const active = join(archiveRoot, '.staging', 'active-batch')
    await mkdir(stale, { recursive: true })
    await mkdir(active, { recursive: true })
    await writeFile(join(stale, 'object.partial'), 'partial')
    await writeFile(join(active, '.lease.json'), `${JSON.stringify({ pid: process.pid, acquiredAt: '2026-07-01T00:00:00Z' })}\n`)
    const old = new Date('2026-07-01T00:00:00Z')
    await utimes(stale, old, old)
    await utimes(active, old, old)

    const report = await cleanupStaleArchiveStaging({ archiveRoot, now: new Date('2026-07-19T00:00:00Z') })
    expect(report).toMatchObject({ scanned: 2, removed: 1, skippedActiveLease: 1, errors: [] })
    await expect(stat(stale)).rejects.toThrow()
    await expect(stat(active)).resolves.toBeDefined()
    expect(report.manifests).toHaveLength(1)
    expect(JSON.parse(await readFile(report.manifests[0], 'utf-8'))).toMatchObject({ batchId: 'stale-batch' })
  })
})
