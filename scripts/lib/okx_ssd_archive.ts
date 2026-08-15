import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  access,
  constants,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { DuckDBInstance } from '@duckdb/node-api'
import type { OkxMarketDataConfig } from '../../src/domain/market-data/okx-market-data-config.js'
import type { OkxRawSegmentManifest } from '../../src/domain/market-data/okx-warehouse-types.js'
import {
  appendJsonLine,
  atomicWriteJson,
  directorySize,
  listRawSegmentManifests,
  sha256Hex,
  updateRawSegmentManifest,
  walkFiles,
} from './okx_warehouse.js'

const execFileAsync = promisify(execFile)
const GIB = 1024 ** 3

export interface VolumeInfo {
  mountPoint: string
  volumeName: string
  volumeUuid: string
  fileSystem: 'apfs' | 'apfs_encrypted' | 'hfs_journaled' | 'exfat' | 'unsupported'
  deviceNode: string | null
  internal: boolean
  network: boolean
  readOnly: boolean
  totalBytes: number
  freeBytes: number
}

export interface ArchiveEnrollment {
  schemaVersion: 'okx_archive_enrollment.v1'
  enabled: true
  mode: 'enrolled_external_volume'
  enrolledAt: string
  volume: {
    expectedName: 'shield'
    volumeUuid: string
    archiveId: string
    fileSystem: VolumeInfo['fileSystem']
  }
  archiveRelativeRoot: string
  allowedFileSystems: Array<'apfs' | 'apfs_encrypted' | 'hfs_journaled' | 'exfat'>
  local: {
    totalOkxBudgetGiB: 30
    hotHighFrequencyRetentionDays: 7
    warningFreeSpaceGiB: 25
    pauseHighFrequencyFreeSpaceGiB: 20
    pauseBroadCollectionFreeSpaceGiB: 15
    emergencyStopFreeSpaceGiB: 10
  }
  cold: {
    warnUsedPct: 85
    pauseArchiveUsedPct: 92
    automaticDeletion: false
  }
  reminder: {
    timezone: 'Asia/Shanghai'
    weeklyCron: '0 20 * * 0'
    followupCron: '0 20 * * 1-3'
  }
}

export interface ArchiveStatus {
  schemaVersion: 'okx_archive_status.v1'
  generatedAt: string
  status: 'not_enrolled' | 'blocked_ssd_not_mounted' | 'blocked_volume_identity_mismatch' | 'blocked_cold_storage_full' | 'ready' | 'archive_pending' | 'archive_verification_failed' | 'archive_complete'
  enrolled: boolean
  connected: boolean
  identityVerified: boolean
  writable: boolean
  mountPoint: string | null
  volumeUuid: string | null
  archiveId: string | null
  usedPct: number | null
  freeBytes: number | null
  pendingBytes: number
  pendingFiles: number
  earliestPendingDate: string | null
  lastCommittedBatchId: string | null
  blockers: string[]
}

export interface ArchiveBatchManifest {
  schemaVersion: 'okx_archive_batch.v1'
  batchId: string
  generatedAt: string
  committedAt: string | null
  sourceWarehouseRoot: string
  destinationArchiveRoot: string
  files: Array<{
    relativePath: string
    bytes: number
    sha256: string
    kind: 'raw' | 'parquet' | 'manifest' | 'catalog' | 'quarantine'
    segmentId: string
    parquetRows: number | null
  }>
  totalBytes: number
  status: 'planned' | 'copying' | 'verified' | 'committed' | 'failed'
  error: string | null
}

export interface ArchiveDependencies {
  inspectVolume?: (mountPoint: string) => Promise<VolumeInfo>
  listMountedVolumes?: () => Promise<VolumeInfo[]>
  now?: () => Date
  /** Tests may emulate an external volume under a temporary directory. Never exposed by CLI/config. */
  allowNonVolumesMountForTests?: boolean
}

export interface ArchiveRunResult {
  status: ArchiveStatus
  batch: ArchiveBatchManifest | null
  lockStatus: 'acquired' | 'skipped_lock_held' | 'not_attempted'
  staleStaging?: StaleStagingCleanupReport
}

export interface StaleStagingCleanupReport {
  scanned: number
  removed: number
  skippedActiveLease: number
  errors: string[]
  manifests: string[]
}

export async function enrollArchiveVolume(input: {
  mountPoint: string
  config: OkxMarketDataConfig
  warehouseRoot: string
  enrollmentPath?: string
  dependencies?: ArchiveDependencies
}): Promise<ArchiveEnrollment> {
  const inspect = input.dependencies?.inspectVolume ?? inspectMountedVolume
  const info = await inspect(resolve(input.mountPoint))
  validateEnrollmentVolume(info, input.config.archive.expectedName, input.dependencies?.allowNonVolumesMountForTests === true)
  const requiredBytes = Math.max(40 * GIB, (await estimateFourWeekGrowth(input.warehouseRoot)) * 1.5)
  if (info.freeBytes < requiredBytes) throw new Error(`SSD free space insufficient: required=${requiredBytes} actual=${info.freeBytes}`)
  await writeFsyncRenameDeleteCanary(info.mountPoint)
  const archiveId = randomUUID()
  const enrollment: ArchiveEnrollment = {
    schemaVersion: 'okx_archive_enrollment.v1', enabled: true, mode: 'enrolled_external_volume',
    enrolledAt: (input.dependencies?.now ?? (() => new Date()))().toISOString(),
    volume: { expectedName: 'shield', volumeUuid: info.volumeUuid, archiveId, fileSystem: info.fileSystem },
    archiveRelativeRoot: input.config.archive.archiveRelativeRoot,
    allowedFileSystems: ['apfs', 'apfs_encrypted', 'hfs_journaled', 'exfat'],
    local: {
      totalOkxBudgetGiB: 30, hotHighFrequencyRetentionDays: 7, warningFreeSpaceGiB: 25,
      pauseHighFrequencyFreeSpaceGiB: 20, pauseBroadCollectionFreeSpaceGiB: 15,
      emergencyStopFreeSpaceGiB: 10,
    },
    cold: { warnUsedPct: 85, pauseArchiveUsedPct: 92, automaticDeletion: false },
    reminder: { timezone: 'Asia/Shanghai', weeklyCron: '0 20 * * 0', followupCron: '0 20 * * 1-3' },
  }
  const identityDir = join(info.mountPoint, '.openalice-archive')
  await mkdir(identityDir, { recursive: true })
  await atomicWriteJson(join(identityDir, 'identity.json'), {
    schemaVersion: 'openalice_archive_identity.v1', archiveId, volumeUuid: info.volumeUuid,
    expectedName: 'shield', enrolledAt: enrollment.enrolledAt,
  })
  await ensureArchiveLayout(join(info.mountPoint, enrollment.archiveRelativeRoot))
  await atomicWriteJson(input.enrollmentPath ?? input.config.archive.enrollmentPath, enrollment)
  return enrollment
}

export async function inspectArchiveStatus(input: {
  config: OkxMarketDataConfig
  warehouseRoot: string
  enrollmentPath?: string
  dependencies?: ArchiveDependencies
}): Promise<{ status: ArchiveStatus; enrollment: ArchiveEnrollment | null; volume: VolumeInfo | null; archiveRoot: string | null }> {
  const enrollment = await readEnrollment(input.enrollmentPath ?? input.config.archive.enrollmentPath)
  const ledgerPath = archiveLedgerPath(input.config)
  const now = input.dependencies?.now?.() ?? new Date()
  const pending = enrollment
    ? await collectArchiveCandidates(input.warehouseRoot, 2 * 60 * 60 * 1000, now, ledgerPath)
    : []
  const estimatedBacklog = await estimateArchiveBacklog(input.warehouseRoot, 2 * 60 * 60 * 1000, now, ledgerPath)
  const base: ArchiveStatus = {
    schemaVersion: 'okx_archive_status.v1', generatedAt: (input.dependencies?.now ?? (() => new Date()))().toISOString(),
    status: 'not_enrolled', enrolled: Boolean(enrollment), connected: false, identityVerified: false,
    writable: false, mountPoint: null, volumeUuid: enrollment?.volume.volumeUuid ?? null,
    archiveId: enrollment?.volume.archiveId ?? null, usedPct: null, freeBytes: null,
    pendingBytes: enrollment ? pending.reduce((sum, item) => sum + item.bytes, 0) : estimatedBacklog.bytes,
    pendingFiles: enrollment ? pending.length : estimatedBacklog.files,
    earliestPendingDate: estimatedBacklog.earliestDate,
    lastCommittedBatchId: await readLastCommittedBatchId(ledgerPath), blockers: [],
  }
  if (!enrollment) return { status: base, enrollment: null, volume: null, archiveRoot: null }
  const volumes = await (input.dependencies?.listMountedVolumes ?? listMountedExternalVolumes)()
  const volume = volumes.find(item => item.volumeUuid === enrollment.volume.volumeUuid) ?? null
  if (!volume) return { status: { ...base, status: 'blocked_ssd_not_mounted', blockers: ['enrolled_volume_not_mounted'] }, enrollment, volume: null, archiveRoot: null }
  const identity = await readIdentity(volume.mountPoint)
  const identityVerified = identity?.archiveId === enrollment.volume.archiveId && identity?.volumeUuid === enrollment.volume.volumeUuid
  const writable = await isWritable(volume.mountPoint)
  const usedPct = volume.totalBytes > 0 ? ((volume.totalBytes - volume.freeBytes) / volume.totalBytes) * 100 : null
  const archiveRoot = join(volume.mountPoint, enrollment.archiveRelativeRoot)
  if (!identityVerified || volume.volumeName !== enrollment.volume.expectedName) {
    return { status: { ...base, status: 'blocked_volume_identity_mismatch', connected: true, mountPoint: volume.mountPoint, volumeUuid: volume.volumeUuid, identityVerified: false, writable, usedPct, freeBytes: volume.freeBytes, blockers: ['volume_uuid_or_archive_identity_mismatch'] }, enrollment, volume, archiveRoot: null }
  }
  if (!writable) return { status: { ...base, status: 'blocked_volume_identity_mismatch', connected: true, mountPoint: volume.mountPoint, identityVerified: true, writable: false, usedPct, freeBytes: volume.freeBytes, blockers: ['volume_not_writable'] }, enrollment, volume, archiveRoot: null }
  if ((usedPct ?? 100) >= enrollment.cold.pauseArchiveUsedPct || volume.freeBytes < 20 * GIB) {
    return { status: { ...base, status: 'blocked_cold_storage_full', connected: true, mountPoint: volume.mountPoint, identityVerified: true, writable: true, usedPct, freeBytes: volume.freeBytes, blockers: ['cold_storage_capacity_threshold'] }, enrollment, volume, archiveRoot }
  }
  return { status: { ...base, status: pending.length > 0 ? 'archive_pending' : 'ready', connected: true, mountPoint: volume.mountPoint, identityVerified: true, writable: true, usedPct, freeBytes: volume.freeBytes }, enrollment, volume, archiveRoot }
}

export async function archiveSealedWarehouse(input: {
  config: OkxMarketDataConfig
  warehouseRoot: string
  enrollmentPath?: string
  dryRun?: boolean
  minAgeMs?: number
  dependencies?: ArchiveDependencies
}): Promise<ArchiveRunResult> {
  const inspected = await inspectArchiveStatus(input)
  if (!['archive_pending', 'ready'].includes(inspected.status.status) || !inspected.archiveRoot || !inspected.enrollment) {
    await persistArchiveStatus(input.config, inspected.status)
    return { status: inspected.status, batch: null, lockStatus: 'not_attempted' }
  }
  const lock = input.dryRun ? null : await acquireArchiveLock(input.config)
  if (!input.dryRun && !lock) {
    return { status: inspected.status, batch: null, lockStatus: 'skipped_lock_held' }
  }
  try {
    return await archiveSealedWarehouseWithLock(input, inspected, lock ? 'acquired' : 'not_attempted')
  } finally {
    await lock?.release()
  }
}

async function archiveSealedWarehouseWithLock(
  input: {
    config: OkxMarketDataConfig
    warehouseRoot: string
    enrollmentPath?: string
    dryRun?: boolean
    minAgeMs?: number
    dependencies?: ArchiveDependencies
  },
  inspected: Awaited<ReturnType<typeof inspectArchiveStatus>>,
  lockStatus: ArchiveRunResult['lockStatus'],
): Promise<ArchiveRunResult> {
  const now = input.dependencies?.now?.() ?? new Date()
  const staleStaging = input.dryRun
    ? undefined
    : await cleanupStaleArchiveStaging({ archiveRoot: inspected.archiveRoot!, now })
  const ledgerPath = archiveLedgerPath(input.config)
  const candidates = await collectArchiveCandidates(input.warehouseRoot, input.minAgeMs ?? 2 * 60 * 60 * 1000, now, ledgerPath)
  if (candidates.length === 0) {
    const ready = { ...inspected.status, status: 'ready' as const, pendingBytes: 0, pendingFiles: 0 }
    await persistArchiveStatus(input.config, ready)
    return { status: ready, batch: null, lockStatus, staleStaging }
  }
  const batchId = `okx-archive.${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.${randomUUID().slice(0, 12)}`
  const batch: ArchiveBatchManifest = {
    schemaVersion: 'okx_archive_batch.v1', batchId, generatedAt: now.toISOString(), committedAt: null,
    sourceWarehouseRoot: resolve(input.warehouseRoot), destinationArchiveRoot: inspected.archiveRoot,
    files: candidates, totalBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
    status: 'planned', error: null,
  }
  if (input.dryRun) {
    await atomicWriteJson(runtimeStoragePath(input.config, 'ssd_archive_dry_run.latest.json'), batch)
    return { status: inspected.status, batch, lockStatus, staleStaging }
  }
  if ((inspected.volume?.freeBytes ?? 0) < batch.totalBytes + GIB) {
    const blocked = { ...inspected.status, status: 'blocked_cold_storage_full' as const, blockers: ['insufficient_space_for_archive_batch'] }
    await persistArchiveStatus(input.config, blocked)
    return { status: blocked, batch: { ...batch, status: 'failed', error: 'insufficient_space_for_archive_batch' }, lockStatus, staleStaging }
  }

  const stagingRoot = join(inspected.archiveRoot, '.staging', batchId)
  const leasePath = join(stagingRoot, '.lease.json')
  try {
    batch.status = 'copying'
    await mkdir(stagingRoot, { recursive: true })
    await atomicWriteJson(leasePath, { schemaVersion: 'okx_archive_staging_lease.v1', batchId, pid: process.pid, acquiredAt: now.toISOString() })
    await atomicWriteJson(join(stagingRoot, 'batch.manifest.planned.json'), batch)
    for (const file of batch.files) {
      const source = resolve(input.warehouseRoot, file.relativePath)
      const partial = join(stagingRoot, `${file.relativePath}.partial`)
      await mkdir(dirname(partial), { recursive: true })
      await copyFile(source, partial)
      await fsyncFile(partial)
      await verifyCopiedObject(partial, file)
    }
    batch.status = 'verified'
    for (const file of batch.files) {
      const partial = join(stagingRoot, `${file.relativePath}.partial`)
      const target = join(inspected.archiveRoot, 'objects', file.relativePath)
      await mkdir(dirname(target), { recursive: true })
      if (await pathExists(target)) {
        await verifyCopiedObject(target, file)
        await rm(partial, { force: true })
      } else {
        await rename(partial, target)
      }
    }
    batch.status = 'committed'
    batch.committedAt = new Date().toISOString()
    const batchDir = join(inspected.archiveRoot, 'batches', batchId)
    await mkdir(batchDir, { recursive: true })
    await atomicWriteJson(join(batchDir, 'batch.manifest.json'), batch)
    await writeFsyncFile(join(batchDir, 'COMMITTED'), `${batch.batchId}\n${batch.committedAt}\n`)
    await appendJsonLine(ledgerPath, batch)
    await markSegmentsArchived(input.warehouseRoot, batch)
    const complete: ArchiveStatus = { ...inspected.status, status: 'archive_complete', pendingBytes: 0, pendingFiles: 0, lastCommittedBatchId: batchId, blockers: [] }
    await persistArchiveStatus(input.config, complete)
    await rm(stagingRoot, { recursive: true, force: true })
    return { status: complete, batch, lockStatus, staleStaging }
  } catch (error) {
    await rm(leasePath, { force: true }).catch(() => undefined)
    batch.status = 'failed'
    batch.error = error instanceof Error ? error.message : String(error)
    const failed: ArchiveStatus = { ...inspected.status, status: 'archive_verification_failed', blockers: [batch.error] }
    await persistArchiveStatus(input.config, failed)
    await atomicWriteJson(runtimeStoragePath(input.config, 'ssd_archive_failed.latest.json'), batch)
    return { status: failed, batch, lockStatus, staleStaging }
  }
}

export async function cleanupStaleArchiveStaging(input: {
  archiveRoot: string
  now?: Date
  staleAfterMs?: number
}): Promise<StaleStagingCleanupReport> {
  const report: StaleStagingCleanupReport = { scanned: 0, removed: 0, skippedActiveLease: 0, errors: [], manifests: [] }
  const stagingParent = join(resolve(input.archiveRoot), '.staging')
  const now = input.now ?? new Date()
  const staleAfterMs = input.staleAfterMs ?? 7 * 24 * 60 * 60 * 1000
  const entries = await readdir(stagingParent, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    report.scanned += 1
    const stagingRoot = join(stagingParent, entry.name)
    try {
      const info = await stat(stagingRoot)
      if (now.getTime() - info.mtimeMs < staleAfterMs) continue
      const lease = await readStagingLease(join(stagingRoot, '.lease.json'))
      if (lease?.pid && processIsAlive(lease.pid)) {
        report.skippedActiveLease += 1
        continue
      }
      const files = await walkFiles(stagingRoot, () => true)
      const manifestPath = join(
        resolve(input.archiveRoot), 'manifests', 'stale-staging',
        `${entry.name}.${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.json`,
      )
      await atomicWriteJson(manifestPath, {
        schemaVersion: 'okx_stale_staging_cleanup.v1',
        generatedAt: now.toISOString(),
        batchId: entry.name,
        stagingRelativePath: relative(resolve(input.archiveRoot), stagingRoot),
        files: files.map(path => relative(stagingRoot, path)).sort(),
        lease: lease ?? null,
      })
      await rm(stagingRoot, { recursive: true, force: true })
      report.removed += 1
      report.manifests.push(manifestPath)
    } catch (error) {
      report.errors.push(`${entry.name}:${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return report
}

export async function verifyArchiveBatch(input: {
  config: OkxMarketDataConfig
  warehouseRoot: string
  batchId: string
  enrollmentPath?: string
  dependencies?: ArchiveDependencies
}): Promise<{ verified: boolean; batchId: string; checkedFiles: number; errors: string[] }> {
  const inspected = await inspectArchiveStatus(input)
  if (!inspected.archiveRoot) return { verified: false, batchId: input.batchId, checkedFiles: 0, errors: [inspected.status.status] }
  const batchPath = join(inspected.archiveRoot, 'batches', input.batchId, 'batch.manifest.json')
  const commitPath = join(inspected.archiveRoot, 'batches', input.batchId, 'COMMITTED')
  const batch = JSON.parse(await readFile(batchPath, 'utf-8')) as ArchiveBatchManifest
  const errors: string[] = []
  if (!await pathExists(commitPath) || batch.status !== 'committed') errors.push('missing_or_invalid_commit_marker')
  for (const file of batch.files) {
    try { await verifyCopiedObject(join(inspected.archiveRoot, 'objects', file.relativePath), file) }
    catch (error) { errors.push(`${file.relativePath}:${error instanceof Error ? error.message : String(error)}`) }
  }
  const result = { verified: errors.length === 0, batchId: input.batchId, checkedFiles: batch.files.length, errors }
  await atomicWriteJson(runtimeStoragePath(input.config, 'ssd_integrity_audit.latest.json'), { ...result, generatedAt: new Date().toISOString() })
  return result
}

export async function restoreArchiveRange(input: {
  config: OkxMarketDataConfig
  warehouseRoot: string
  dataset: string
  from: string
  to: string
  outputRoot?: string
  enrollmentPath?: string
  dependencies?: ArchiveDependencies
}): Promise<{ status: 'complete' | 'blocked'; outputRoot: string; restoredFiles: number; errors: string[] }> {
  const inspected = await inspectArchiveStatus(input)
  const outputRoot = resolve(input.outputRoot ?? join(input.warehouseRoot, 'restore', `${input.dataset}.${input.from}.${input.to}.${randomUUID().slice(0, 8)}`))
  if (!inspected.archiveRoot) return { status: 'blocked', outputRoot, restoredFiles: 0, errors: [inspected.status.status] }
  const batches = await readdir(join(inspected.archiveRoot, 'batches'), { withFileTypes: true }).catch(() => [])
  const selected = new Map<string, ArchiveBatchManifest['files'][number]>()
  for (const entry of batches) {
    if (!entry.isDirectory()) continue
    try {
      const batch = JSON.parse(await readFile(join(inspected.archiveRoot, 'batches', entry.name, 'batch.manifest.json'), 'utf-8')) as ArchiveBatchManifest
      if (batch.status !== 'committed') continue
      for (const file of batch.files) {
        const date = /date=(\d{4}-\d{2}-\d{2})/.exec(file.relativePath)?.[1]
        if (file.relativePath.includes(`dataset=${input.dataset}`) && date && date >= input.from && date <= input.to) selected.set(file.relativePath, file)
      }
    } catch { /* invalid batch excluded */ }
  }
  const errors: string[] = []
  for (const file of selected.values()) {
    try {
      const source = join(inspected.archiveRoot, 'objects', file.relativePath)
      await verifyCopiedObject(source, file)
      const target = join(outputRoot, file.relativePath)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
      await verifyCopiedObject(target, file)
    } catch (error) { errors.push(`${file.relativePath}:${error instanceof Error ? error.message : String(error)}`) }
  }
  const report = { status: errors.length === 0 ? 'complete' as const : 'blocked' as const, outputRoot, restoredFiles: selected.size - errors.length, errors, generatedAt: new Date().toISOString(), dataset: input.dataset, from: input.from, to: input.to }
  await atomicWriteJson(join(outputRoot, 'restore.manifest.json'), report)
  return report
}

export async function inspectMountedVolume(mountPoint: string): Promise<VolumeInfo> {
  const resolved = resolve(mountPoint)
  const { stdout } = await execFileAsync('/usr/sbin/diskutil', ['info', resolved])
  const fields = parseDiskutilInfo(stdout)
  const fs = await statfs(resolved)
  return {
    mountPoint: fields.get('Mount Point') ?? resolved,
    volumeName: fields.get('Volume Name') ?? basename(resolved),
    volumeUuid: fields.get('Volume UUID') ?? '',
    fileSystem: normalizeFileSystem(fields.get('File System Personality') ?? fields.get('Type (Bundle)') ?? ''),
    deviceNode: fields.get('Device Node') ?? null,
    internal: /^Yes$/i.test(fields.get('Internal') ?? ''),
    network: /network|smb|nfs|afp/i.test(stdout),
    readOnly: /^Yes$/i.test(fields.get('Read-Only Volume') ?? fields.get('Read-Only Media') ?? ''),
    totalBytes: fs.blocks * fs.bsize,
    freeBytes: fs.bavail * fs.bsize,
  }
}

export async function listMountedExternalVolumes(): Promise<VolumeInfo[]> {
  const entries = await readdir('/Volumes', { withFileTypes: true }).catch(() => [])
  const out: VolumeInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const info = await inspectMountedVolume(join('/Volumes', entry.name))
      if (!info.internal && !info.network) out.push(info)
    } catch { /* not a disk mount */ }
  }
  return out
}

export function validateEnrollmentVolume(info: VolumeInfo, expectedName: string, allowNonVolumesMountForTests = false): void {
  if (info.volumeName !== expectedName) throw new Error(`expected volume name ${expectedName}, found ${info.volumeName}`)
  if (!info.volumeUuid) throw new Error('external volume is missing Volume UUID')
  if (info.internal) throw new Error('archive volume must be external physical storage')
  if (info.network) throw new Error('network volumes are not allowed for archive enrollment')
  if (info.readOnly) throw new Error('archive volume is read-only')
  if (!['apfs', 'apfs_encrypted', 'hfs_journaled', 'exfat'].includes(info.fileSystem)) throw new Error(`unsupported archive filesystem: ${info.fileSystem}`)
  if (!allowNonVolumesMountForTests && !resolve(info.mountPoint).startsWith(`/Volumes${sep}`)) throw new Error('archive mount must be a real /Volumes mount')
}

async function estimateArchiveBacklog(
  warehouseRoot: string,
  minAgeMs: number,
  now: Date,
  ledgerPath: string,
): Promise<{ files: number; bytes: number; earliestDate: string | null }> {
  const archivedPaths = await readArchivedObjectPaths(ledgerPath)
  const pendingPaths = new Set<string>()
  let bytes = 0
  let earliestDate: string | null = null
  for (const item of await listRawSegmentManifests(warehouseRoot)) {
    const manifest = item.manifest
    if (manifest.archivedBatchId || manifest.localDeletedAt) continue
    if (now.getTime() - Date.parse(manifest.sealedAt) < minAgeMs) continue
    earliestDate = earliestDate == null || manifest.date < earliestDate ? manifest.date : earliestDate
    for (const relativePath of [manifest.relativePath, manifest.parquetPath].filter((value): value is string => Boolean(value))) {
      if (pendingPaths.has(relativePath) || archivedPaths.has(relativePath)) continue
      try {
        bytes += (await stat(resolve(warehouseRoot, relativePath))).size
        pendingPaths.add(relativePath)
      } catch { /* Health reports missing source objects separately. */ }
    }
  }
  return { files: pendingPaths.size, bytes, earliestDate }
}

async function collectArchiveCandidates(warehouseRoot: string, minAgeMs: number, now: Date, ledgerPath: string): Promise<ArchiveBatchManifest['files']> {
  const root = resolve(warehouseRoot)
  const manifests = await listRawSegmentManifests(root)
  const files = new Map<string, ArchiveBatchManifest['files'][number]>()
  const archivedPaths = await readArchivedObjectPaths(ledgerPath)
  for (const item of manifests) {
    const manifest = item.manifest
    if (manifest.archivedBatchId || manifest.localDeletedAt) continue
    if (now.getTime() - Date.parse(manifest.sealedAt) < minAgeMs) continue
    await addCandidate(files, root, manifest.relativePath, 'raw', manifest.segmentId, null, manifest.sha256)
    if (manifest.parquetPath && manifest.parquetSha256 && manifest.parquetRows != null) {
      await addCandidate(files, root, manifest.parquetPath, 'parquet', manifest.segmentId, manifest.parquetRows, manifest.parquetSha256)
    }
    const manifestRelative = relative(root, item.path)
    await addCandidate(files, root, manifestRelative, 'manifest', manifest.segmentId, null)
  }
  for (const path of await walkFiles(join(root, 'manifests'), candidate => candidate.endsWith('.json'))) {
    const relativePath = relative(root, path)
    if (files.has(relativePath) || archivedPaths.has(relativePath)) continue
    const fileStat = await stat(path)
    if (now.getTime() - fileStat.mtimeMs < minAgeMs) continue
    await addCandidate(files, root, relativePath, 'manifest', `metadata:${sha256Hex(relativePath).slice(0, 20)}`, null)
  }
  for (const path of await walkFiles(join(root, 'quarantine'), () => true)) {
    const relativePath = relative(root, path)
    if (archivedPaths.has(relativePath)) continue
    const fileStat = await stat(path)
    if (now.getTime() - fileStat.mtimeMs < minAgeMs) continue
    await addCandidate(files, root, relativePath, 'quarantine', `quarantine:${sha256Hex(relativePath).slice(0, 20)}`, null)
  }
  const catalogPath = join(root, 'catalog', 'openalice_okx.duckdb')
  if (await pathExists(catalogPath)) {
    const catalogHash = sha256Hex(await readFile(catalogPath))
    const snapshotRelative = join('archive_queue', 'catalog', `openalice_okx.${catalogHash}.duckdb`)
    if (!archivedPaths.has(snapshotRelative)) {
      const snapshotPath = join(root, snapshotRelative)
      if (!await pathExists(snapshotPath)) {
        await mkdir(dirname(snapshotPath), { recursive: true })
        const partial = `${snapshotPath}.${process.pid}.partial`
        await copyFile(catalogPath, partial)
        await fsyncFile(partial)
        if (sha256Hex(await readFile(partial)) !== catalogHash) throw new Error('catalog snapshot hash mismatch')
        await rename(partial, snapshotPath)
      }
      await addCandidate(files, root, snapshotRelative, 'catalog', `catalog:${catalogHash.slice(0, 20)}`, null, catalogHash)
    }
  }
  return [...files.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

async function addCandidate(
  out: Map<string, ArchiveBatchManifest['files'][number]>, root: string, relativePath: string,
  kind: ArchiveBatchManifest['files'][number]['kind'], segmentId: string, parquetRows: number | null, expectedHash?: string,
): Promise<void> {
  const resolved = resolve(root, relativePath)
  if (!resolved.startsWith(`${root}${sep}`)) throw new Error(`archive candidate escapes warehouse root: ${relativePath}`)
  const fileStat = await stat(resolved)
  const hash = sha256Hex(await readFile(resolved))
  if (expectedHash && hash !== expectedHash) throw new Error(`archive candidate hash mismatch: ${relativePath}`)
  out.set(relativePath, { relativePath, bytes: fileStat.size, sha256: hash, kind, segmentId, parquetRows })
}

async function markSegmentsArchived(warehouseRoot: string, batch: ArchiveBatchManifest): Promise<void> {
  const segmentIds = new Set(batch.files.map(file => file.segmentId))
  for (const item of await listRawSegmentManifests(warehouseRoot)) {
    if (!segmentIds.has(item.manifest.segmentId)) continue
    await updateRawSegmentManifest(warehouseRoot, { ...item.manifest, archivedBatchId: batch.batchId, archivedAt: batch.committedAt })
  }
}

async function verifyCopiedObject(path: string, file: ArchiveBatchManifest['files'][number]): Promise<void> {
  const fileStat = await stat(path)
  if (fileStat.size !== file.bytes) throw new Error(`size mismatch expected=${file.bytes} actual=${fileStat.size}`)
  const hash = sha256Hex(await readFile(path))
  if (hash !== file.sha256) throw new Error('sha256 mismatch')
  if (file.kind === 'parquet' && file.parquetRows != null) {
    const instance = await DuckDBInstance.create(':memory:')
    const connection = await instance.connect()
    try {
      const reader = await connection.runAndReadAll(`SELECT count(*)::BIGINT AS row_count FROM read_parquet('${path.replaceAll("'", "''")}')`)
      const actual = Number(reader.getRowObjectsJson()[0]?.row_count ?? 0)
      if (actual !== file.parquetRows) throw new Error(`Parquet row count mismatch expected=${file.parquetRows} actual=${actual}`)
    } finally { connection.closeSync() }
  }
}

async function readEnrollment(path: string): Promise<ArchiveEnrollment | null> {
  try {
    const value = JSON.parse(await readFile(resolve(path), 'utf-8')) as ArchiveEnrollment
    return value.schemaVersion === 'okx_archive_enrollment.v1' ? value : null
  } catch { return null }
}

async function readIdentity(mountPoint: string): Promise<{ archiveId?: string; volumeUuid?: string } | null> {
  try { return JSON.parse(await readFile(join(mountPoint, '.openalice-archive', 'identity.json'), 'utf-8')) } catch { return null }
}

async function ensureArchiveLayout(root: string): Promise<void> {
  for (const child of ['objects', 'manifests', 'batches', 'catalog', 'quarantine', '.staging']) await mkdir(join(root, child), { recursive: true })
}

async function writeFsyncRenameDeleteCanary(mountPoint: string): Promise<void> {
  const dir = join(mountPoint, '.openalice-archive')
  await mkdir(dir, { recursive: true })
  const source = join(dir, `.enroll-canary.${process.pid}.${randomUUID()}.tmp`)
  const target = `${source}.renamed`
  await writeFsyncFile(source, `openalice-archive-canary ${new Date().toISOString()}\n`)
  await rename(source, target)
  const raw = await readFile(target, 'utf-8')
  if (!raw.startsWith('openalice-archive-canary')) throw new Error('archive canary verification failed')
  await rm(target)
}

async function writeFsyncFile(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'w', 0o600)
  try { await handle.writeFile(value, 'utf-8'); await handle.sync() } finally { await handle.close() }
}

async function fsyncFile(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
async function isWritable(path: string): Promise<boolean> { try { await access(path, constants.W_OK); return true } catch { return false } }
async function pathExists(path: string): Promise<boolean> { try { await stat(path); return true } catch { return false } }
async function estimateFourWeekGrowth(warehouseRoot: string): Promise<number> { const bytes = await directorySize(warehouseRoot); return Math.max(bytes, bytes * 4) }
async function readLastCommittedBatchId(path: string): Promise<string | null> { try { const lines = (await readFile(path, 'utf-8')).trim().split('\n').filter(Boolean); return (JSON.parse(lines.at(-1) ?? '{}') as { batchId?: string }).batchId ?? null } catch { return null } }
async function readArchivedObjectPaths(path: string): Promise<Set<string>> {
  try {
    const lines = (await readFile(path, 'utf-8')).trim().split('\n').filter(Boolean)
    const paths = new Set<string>()
    for (const line of lines) {
      const batch = JSON.parse(line) as Partial<ArchiveBatchManifest>
      if (batch.status !== 'committed' || !Array.isArray(batch.files)) continue
      for (const file of batch.files) if (typeof file.relativePath === 'string') paths.add(file.relativePath)
    }
    return paths
  } catch { return new Set() }
}
async function acquireArchiveLock(config: OkxMarketDataConfig): Promise<{ release: () => Promise<void> } | null> {
  const path = resolve(config.dataRoot, 'runtime', 'storage', 'ssd_archive.lock')
  await mkdir(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, 'utf-8')
      await handle.sync()
      return {
        release: async () => {
          await handle.close().catch(() => undefined)
          await rm(path, { force: true })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = await readStagingLease(path)
      if (holder?.pid && processIsAlive(holder.pid)) return null
      await rm(path, { force: true })
    }
  }
  return null
}
async function readStagingLease(path: string): Promise<{ pid?: number; acquiredAt?: string } | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf-8')) as { pid?: unknown; acquiredAt?: unknown }
    return {
      pid: typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : undefined,
      acquiredAt: typeof value.acquiredAt === 'string' ? value.acquiredAt : undefined,
    }
  } catch { return null }
}
function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
function archiveLedgerPath(config: OkxMarketDataConfig): string { return resolve(config.dataRoot, 'runtime', 'storage', 'ssd_archive_ledger.jsonl') }
function runtimeStoragePath(config: OkxMarketDataConfig, file: string): string { return resolve(config.dataRoot, 'runtime', 'storage', file) }
async function persistArchiveStatus(config: OkxMarketDataConfig, status: ArchiveStatus): Promise<void> { await atomicWriteJson(runtimeStoragePath(config, 'ssd_archive_state.json'), status) }

function parseDiskutilInfo(raw: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const match = /^\s*([^:]+):\s*(.*?)\s*$/.exec(line)
    if (match) out.set(match[1].trim(), match[2].trim())
  }
  return out
}

function normalizeFileSystem(raw: string): VolumeInfo['fileSystem'] {
  const value = raw.toLowerCase()
  if (value.includes('apfs') && value.includes('encrypted')) return 'apfs_encrypted'
  if (value.includes('apfs')) return 'apfs'
  if (value.includes('journaled hfs') || value.includes('hfs+')) return 'hfs_journaled'
  if (value.includes('exfat')) return 'exfat'
  return 'unsupported'
}
