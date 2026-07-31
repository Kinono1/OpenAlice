import { createHash, randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type {
  OkxMarketEvent,
  OkxRawSegmentManifest,
} from '../../src/domain/market-data/okx-warehouse-types.js'

const GIB = 1024 ** 3

export interface WarehouseAppendResult {
  inputRows: number
  writtenRows: number
  duplicateRows: number
  conflictingDuplicateRows: number
  manifests: OkxRawSegmentManifest[]
  conflictPaths: string[]
}

export interface StoragePressureStatus {
  generatedAt: string
  status: 'healthy' | 'warning' | 'degraded_storage_pressure' | 'critical_storage_pressure' | 'emergency_storage_stop'
  warehouseBytes: number
  warehouseGiB: number
  filesystemFreeBytes: number
  filesystemFreeGiB: number
  highFrequencyAllowed: boolean
  broadCollectionAllowed: boolean
  anyMarketWritesAllowed: boolean
  reasons: string[]
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function payloadHash(value: unknown): string {
  return sha256Hex(stableJson(value))
}

export function buildCollectionRunId(prefix: string, generatedAt = new Date().toISOString()): string {
  return `${prefix}.${generatedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}.${randomUUID().slice(0, 12)}`
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const resolved = resolve(path)
  const temp = `${resolved}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await mkdir(dirname(resolved), { recursive: true })
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  await fsyncFile(temp)
  await rename(temp, resolved)
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  const resolved = resolve(path)
  await mkdir(dirname(resolved), { recursive: true })
  const handle = await open(resolved, 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function appendOkxMarketEvents(
  warehouseRoot: string,
  inputEvents: OkxMarketEvent[],
): Promise<WarehouseAppendResult> {
  const root = resolve(warehouseRoot)
  const groups = new Map<string, OkxMarketEvent[]>()
  for (const event of inputEvents) {
    assertEventContract(event)
    const eventDate = new Date(event.eventTime)
    const availableDate = new Date(event.availableAt)
    if (!Number.isFinite(eventDate.getTime()) || !Number.isFinite(availableDate.getTime())) {
      throw new Error(`invalid OKX event time for ${event.dedupKey}`)
    }
    const date = eventDate.toISOString().slice(0, 10)
    const hour = eventDate.toISOString().slice(11, 13)
    const bar = event.dataset === 'candle' && isRecord(event.payload) && typeof event.payload.bar === 'string'
      ? event.payload.bar
      : null
    const partitionInstrumentId = ['trade', 'orderbook_snapshot', 'orderbook_delta'].includes(event.dataset)
      ? event.instrumentId
      : null
    const key = [event.dataset, event.instrumentType, bar ?? '', partitionInstrumentId ?? '', date, hour, event.collectionRunId].join('|')
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }

  const result: WarehouseAppendResult = {
    inputRows: inputEvents.length,
    writtenRows: 0,
    duplicateRows: 0,
    conflictingDuplicateRows: 0,
    manifests: [],
    conflictPaths: [],
  }

  for (const events of groups.values()) {
    const first = events[0]
    const date = new Date(first.eventTime).toISOString().slice(0, 10)
    const hour = new Date(first.eventTime).toISOString().slice(11, 13)
    const bar = first.dataset === 'candle' && isRecord(first.payload) && typeof first.payload.bar === 'string'
      ? first.payload.bar
      : null
    const partitionInstrumentId = ['trade', 'orderbook_snapshot', 'orderbook_delta'].includes(first.dataset)
      ? first.instrumentId
      : null
    const indexPath = join(root, 'state', 'dedup', first.dataset, `${date}.json`)
    const index = await readDedupIndex(indexPath)
    const unique: OkxMarketEvent[] = []
    let groupDuplicates = 0
    let groupConflicts = 0

    for (const event of events) {
      const existingHash = index[event.dedupKey]
      if (existingHash === event.payloadHash) {
        result.duplicateRows += 1
        groupDuplicates += 1
        continue
      }
      if (existingHash && existingHash !== event.payloadHash) {
        const conflict = {
          schemaVersion: 'okx_dedup_conflict.v1',
          generatedAt: new Date().toISOString(),
          dedupKey: event.dedupKey,
          existingPayloadHash: existingHash,
          incomingPayloadHash: event.payloadHash,
          event,
        }
        const conflictPath = join(root, 'quarantine', 'conflicts', first.dataset, date, `${sha256Hex(event.dedupKey).slice(0, 20)}.${event.payloadHash.slice(0, 12)}.json`)
        await atomicWriteJson(conflictPath, conflict)
        result.conflictingDuplicateRows += 1
        groupConflicts += 1
        result.conflictPaths.push(conflictPath)
        continue
      }
      index[event.dedupKey] = event.payloadHash
      unique.push(event)
    }

    if (unique.length === 0) continue
    unique.sort((left, right) => left.eventTime.localeCompare(right.eventTime) || left.dedupKey.localeCompare(right.dedupKey))
    const segmentId = `${first.collectionRunId}.${first.dataset}.${first.instrumentType}.${date.replaceAll('-', '')}${hour}.${randomUUID().slice(0, 8)}`
    const relativePath = join('raw', `dataset=${first.dataset}`, `instrument_type=${first.instrumentType}`, `date=${date}`, `hour=${hour}`, `${segmentId}.jsonl.gz`)
    const segmentPath = join(root, relativePath)
    const raw = Buffer.from(`${unique.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf-8')
    const compressed = gzipSync(raw, { level: 6 })
    await writeAtomicBuffer(segmentPath, compressed)
    const fileStat = await stat(segmentPath)
    const sealedAt = new Date().toISOString()
    const manifest: OkxRawSegmentManifest = {
      schemaVersion: 'okx_raw_segment_manifest.v1',
      exchange: 'okx',
      segmentId,
      relativePath,
      dataset: first.dataset,
      instrumentType: first.instrumentType,
      bar,
      instrumentId: partitionInstrumentId,
      date,
      hour,
      collectionRunId: first.collectionRunId,
      sealed: true,
      sealedAt,
      rowCount: unique.length,
      duplicateRows: groupDuplicates,
      conflictingDuplicateRows: groupConflicts,
      minEventTime: unique.at(0)?.eventTime ?? null,
      maxEventTime: unique.at(-1)?.eventTime ?? null,
      sha256: sha256Hex(compressed),
      bytes: fileStat.size,
      parquetPath: null,
      parquetSha256: null,
      parquetRows: null,
      archivedBatchId: null,
    }
    await atomicWriteJson(manifestPathFor(root, manifest), manifest)
    // Commit the dedup index after the immutable segment and manifest exist.
    // A crash before this point may create a detectable duplicate on retry, but
    // can never make a successfully indexed event disappear from storage.
    await atomicWriteJson(indexPath, index)
    result.writtenRows += unique.length
    result.manifests.push(manifest)
  }

  return result
}

export async function readRawSegmentEvents(
  warehouseRoot: string,
  manifest: OkxRawSegmentManifest,
): Promise<OkxMarketEvent[]> {
  const compressed = await readFile(join(resolve(warehouseRoot), manifest.relativePath))
  if (sha256Hex(compressed) !== manifest.sha256) throw new Error(`raw segment hash mismatch: ${manifest.segmentId}`)
  const raw = gunzipSync(compressed).toString('utf-8')
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as OkxMarketEvent)
}

export async function listRawSegmentManifests(warehouseRoot: string): Promise<Array<{ path: string; manifest: OkxRawSegmentManifest }>> {
  const root = resolve(warehouseRoot)
  const manifestRoot = join(root, 'manifests', 'raw')
  const paths = await walkFiles(manifestRoot, file => file.endsWith('.manifest.json'))
  const out: Array<{ path: string; manifest: OkxRawSegmentManifest }> = []
  for (const path of paths) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as OkxRawSegmentManifest
      if (parsed.schemaVersion === 'okx_raw_segment_manifest.v1' && parsed.sealed === true) {
        out.push({ path, manifest: parsed })
      }
    } catch {
      // Health audit reports invalid manifests separately; compaction skips them.
    }
  }
  return out.sort((left, right) => left.manifest.sealedAt.localeCompare(right.manifest.sealedAt))
}

export async function directorySize(path: string): Promise<number> {
  let total = 0
  for (const file of await walkFiles(resolve(path), () => true)) {
    try { total += (await stat(file)).size } catch { /* removed concurrently */ }
  }
  return total
}

export async function buildStoragePressureStatus(input: {
  warehouseRoot: string
  budgetGiB?: number
  warningFreeSpaceGiB?: number
  pauseHighFrequencyAtGiB?: number
  pauseBroadCollectionFreeSpaceGiB?: number
  emergencyStopFreeSpaceGiB?: number
  previousStatus?: StoragePressureStatus['status'] | null
  archiveBacklogBytes?: number
  filesystemFreeBytesOverride?: number
  warehouseBytesOverride?: number
}): Promise<StoragePressureStatus> {
  const root = resolve(input.warehouseRoot)
  await mkdir(root, { recursive: true })
  const warehouseBytes = input.warehouseBytesOverride ?? await directorySize(root)
  const fs = input.filesystemFreeBytesOverride == null ? await statfs(root) : null
  const filesystemFreeBytes = input.filesystemFreeBytesOverride ?? (fs!.bavail * fs!.bsize)
  const budgetGiB = input.budgetGiB ?? 30
  const warehouseGiB = warehouseBytes / GIB
  const filesystemFreeGiB = filesystemFreeBytes / GIB
  const reasons: string[] = []
  let status: StoragePressureStatus['status'] = 'healthy'

  if (filesystemFreeGiB < (input.emergencyStopFreeSpaceGiB ?? 10) || warehouseGiB >= budgetGiB) {
    status = 'emergency_storage_stop'
    reasons.push(filesystemFreeGiB < (input.emergencyStopFreeSpaceGiB ?? 10) ? 'filesystem_free_below_10_gib' : 'warehouse_budget_reached')
  } else if (filesystemFreeGiB < (input.pauseBroadCollectionFreeSpaceGiB ?? 15) || warehouseGiB > 29) {
    status = 'critical_storage_pressure'
    reasons.push(filesystemFreeGiB < 15 ? 'filesystem_free_below_15_gib' : 'warehouse_above_29_gib')
  } else if (filesystemFreeGiB < 20 || warehouseGiB > (input.pauseHighFrequencyAtGiB ?? 28)) {
    status = 'degraded_storage_pressure'
    reasons.push(filesystemFreeGiB < 20 ? 'filesystem_free_below_20_gib' : 'warehouse_above_28_gib')
  } else if (filesystemFreeGiB < (input.warningFreeSpaceGiB ?? 25) || warehouseGiB > 26) {
    status = 'warning'
    reasons.push(filesystemFreeGiB < 25 ? 'filesystem_free_below_25_gib' : 'warehouse_above_26_gib')
  }
  const backlogGiB = (input.archiveBacklogBytes ?? 0) / GIB
  let highFrequencyAllowed = status === 'healthy' || status === 'warning'
  let broadCollectionAllowed = status !== 'critical_storage_pressure' && status !== 'emergency_storage_stop'
  const previous = input.previousStatus
  if (previous === 'degraded_storage_pressure' || previous === 'critical_storage_pressure' || previous === 'emergency_storage_stop') {
    if (!(filesystemFreeGiB >= 25 && warehouseGiB < 26 && backlogGiB < 2)) {
      highFrequencyAllowed = false
      reasons.push('high_frequency_resume_hysteresis_not_met')
    }
    if (filesystemFreeGiB < 20 || warehouseGiB >= 29 || status === 'emergency_storage_stop') {
      broadCollectionAllowed = false
      reasons.push('broad_collection_resume_hysteresis_not_met')
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    status,
    warehouseBytes,
    warehouseGiB,
    filesystemFreeBytes,
    filesystemFreeGiB,
    highFrequencyAllowed,
    broadCollectionAllowed,
    anyMarketWritesAllowed: status !== 'emergency_storage_stop',
    reasons,
  }
}

export function manifestPathFor(root: string, manifest: Pick<OkxRawSegmentManifest, 'dataset' | 'date' | 'segmentId'>): string {
  return join(resolve(root), 'manifests', 'raw', manifest.dataset, manifest.date, `${manifest.segmentId}.manifest.json`)
}

export async function updateRawSegmentManifest(
  warehouseRoot: string,
  manifest: OkxRawSegmentManifest,
): Promise<void> {
  await atomicWriteJson(manifestPathFor(warehouseRoot, manifest), manifest)
}

export async function walkFiles(root: string, accept: (path: string) => boolean): Promise<string[]> {
  const out: string[] = []
  async function visit(path: string): Promise<void> {
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && accept(child)) out.push(child)
    }
  }
  await visit(resolve(root))
  return out
}

export function relativeWarehousePath(warehouseRoot: string, path: string): string {
  const value = relative(resolve(warehouseRoot), resolve(path))
  if (value.startsWith('..')) throw new Error(`path escapes warehouse root: ${path}`)
  return value
}

async function readDedupIndex(path: string): Promise<Record<string, string>> {
  try {
    const value = JSON.parse(await readFile(path, 'utf-8')) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, string>
  } catch { /* missing or invalid index starts empty; conflicts remain protected by immutable segments */ }
  return {}
}

async function writeAtomicBuffer(path: string, value: Buffer): Promise<void> {
  const resolved = resolve(path)
  const temp = `${resolved}.${process.pid}.${randomUUID().slice(0, 8)}.partial`
  await mkdir(dirname(resolved), { recursive: true })
  await writeFile(temp, value, { mode: 0o600 })
  await fsyncFile(temp)
  await rename(temp, resolved)
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

function assertEventContract(event: OkxMarketEvent): void {
  if (event.schemaVersion !== 'okx_market_event.v1' || event.exchange !== 'okx') {
    throw new Error('invalid OKX market event envelope')
  }
  if (!event.dedupKey || !event.payloadHash || !event.collectionRunId || !event.sourceEndpoint) {
    throw new Error('OKX market event is missing lineage fields')
  }
  if (event.sourceTransport === 'websocket' && /private|login/i.test(event.channel)) {
    throw new Error('private OKX WebSocket channels are forbidden')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]))
  }
  return value
}
