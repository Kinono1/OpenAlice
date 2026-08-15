import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { okxPublicGet, OkxPublicApiError } from '../../src/domain/market-data/live-fetcher.js'
import { loadOkxMarketDataConfig, resolveOkxWarehouseRoot } from '../../src/domain/market-data/okx-market-data-config.js'
import type { OkxInstrumentRecord, OkxMarketEvent } from '../../src/domain/market-data/okx-warehouse-types.js'
import { appendOkxMarketEvents, atomicWriteJson, buildStoragePressureStatus, type StoragePressureStatus } from './okx_warehouse.js'

export interface CollectorReport {
  schemaVersion: 'okx_warehouse_collector_report.v1'
  task: string
  generatedAt: string
  finishedAt: string
  status: 'complete' | 'partial' | 'blocked' | 'error'
  researchOnly: true
  privateDataCalls: 0
  warehouseRoot: string
  runId: string
  fetchedRows: number
  writtenRows: number
  duplicateRows: number
  conflictingDuplicateRows: number
  collectorLockStatus: 'acquired' | 'skipped_lock_held'
  errors: Array<{ target: string; error: string; errorClass: string; permanent: boolean }>
  blockers: string[]
}

export interface RunCollectorOptions {
  task: string
  runId: string
  configPath?: string
  requireEnabled?: boolean
  pressureClass: 'high_frequency' | 'broad' | 'essential'
  fetchEvents: (context: {
    warehouseRoot: string
    config: Awaited<ReturnType<typeof loadOkxMarketDataConfig>>
    runId: string
    availableAt: string
  }) => Promise<{ events: OkxMarketEvent[]; errors?: CollectorReport['errors'] }>
}

export async function runOkxCollector(options: RunCollectorOptions): Promise<CollectorReport> {
  const generatedAt = new Date().toISOString()
  const config = await loadOkxMarketDataConfig(options.configPath)
  const warehouseRoot = resolveOkxWarehouseRoot(config)
  await mkdir(warehouseRoot, { recursive: true })
  const lock = await acquireCollectorLock(config.dataRoot, options.task)
  if (!lock) {
    const report = emptyReport(options, generatedAt, warehouseRoot, ['skipped_lock_held'], 'skipped_lock_held')
    await persistCollectorArtifacts(report, warehouseRoot, config.dataRoot)
    return report
  }
  try {
    return await runOkxCollectorWithLock(options, generatedAt, config, warehouseRoot)
  } finally {
    await lock.release()
  }
}

async function runOkxCollectorWithLock(
  options: RunCollectorOptions,
  generatedAt: string,
  config: Awaited<ReturnType<typeof loadOkxMarketDataConfig>>,
  warehouseRoot: string,
): Promise<CollectorReport> {
  const previousPressure = await readJson(join(warehouseRoot, 'state', 'storage-pressure.latest.json')) as StoragePressureStatus | null
  const archiveState = await readJson(resolve(config.dataRoot, 'runtime', 'storage', 'ssd_archive_state.json')) as Record<string, unknown> | null
  const pressure = await buildStoragePressureStatus({
    warehouseRoot,
    budgetGiB: config.storage.budgetGiB,
    warningFreeSpaceGiB: config.storage.warningFreeSpaceGiB,
    pauseHighFrequencyAtGiB: config.storage.pauseHighFrequencyAtGiB,
    pauseBroadCollectionFreeSpaceGiB: config.storage.pauseBroadCollectionFreeSpaceGiB,
    emergencyStopFreeSpaceGiB: config.storage.emergencyStopFreeSpaceGiB,
    previousStatus: previousPressure?.status,
    archiveBacklogBytes: numberValue(archiveState?.pendingBytes) ?? 0,
  })
  await atomicWriteJson(join(warehouseRoot, 'state', 'storage-pressure.latest.json'), pressure)
  const blockers: string[] = []
  if (options.requireEnabled !== false && !config.enabled) blockers.push('collector_disabled_by_config')
  if (!pressure.anyMarketWritesAllowed) blockers.push('emergency_storage_stop')
  if (options.pressureClass === 'high_frequency' && !pressure.highFrequencyAllowed) blockers.push('high_frequency_paused_storage_pressure')
  if (options.pressureClass === 'broad' && !pressure.broadCollectionAllowed) blockers.push('broad_collection_paused_storage_pressure')

  if (blockers.length > 0) {
    const report = emptyReport(options, generatedAt, warehouseRoot, blockers)
    await persistCollectorArtifacts(report, warehouseRoot, config.dataRoot)
    return report
  }

  try {
    const fetched = await options.fetchEvents({ warehouseRoot, config, runId: options.runId, availableAt: new Date().toISOString() })
    const append = await appendOkxMarketEvents(warehouseRoot, fetched.events)
    const errors = fetched.errors ?? []
    const status = errors.length === 0 ? 'complete' : append.writtenRows > 0 ? 'partial' : 'error'
    const report: CollectorReport = {
      schemaVersion: 'okx_warehouse_collector_report.v1', task: options.task, generatedAt,
      finishedAt: new Date().toISOString(), status, researchOnly: true, privateDataCalls: 0,
      warehouseRoot, runId: options.runId, fetchedRows: fetched.events.length,
      writtenRows: append.writtenRows, duplicateRows: append.duplicateRows,
      conflictingDuplicateRows: append.conflictingDuplicateRows, collectorLockStatus: 'acquired', errors, blockers: [],
    }
    await persistCollectorArtifacts(report, warehouseRoot, config.dataRoot)
    return report
  } catch (error) {
    const classified = classifyCollectorError(error)
    const report: CollectorReport = {
      ...emptyReport(options, generatedAt, warehouseRoot, []), status: 'error',
      errors: [{ target: options.task, error: classified.message, errorClass: classified.errorClass, permanent: classified.permanent }],
    }
    await persistCollectorArtifacts(report, warehouseRoot, config.dataRoot)
    return report
  }
}

export async function fetchOkxRows(path: string): Promise<Array<Record<string, unknown>>> {
  const response = await okxPublicGet<{ code: string; msg?: string; data?: Array<Record<string, unknown>> }>(path)
  if (response.code !== '0' || !Array.isArray(response.data)) {
    throw new Error(`OKX business response ${response.code}: ${response.msg ?? 'missing data'}`)
  }
  return response.data
}

export async function readInstrumentMaster(warehouseRoot: string): Promise<OkxInstrumentRecord[]> {
  try {
    const value = JSON.parse(await readFile(join(resolve(warehouseRoot), 'state', 'instrument-master.latest.json'), 'utf-8')) as { instruments?: unknown }
    return Array.isArray(value.instruments) ? value.instruments as OkxInstrumentRecord[] : []
  } catch { return [] }
}

export async function writeInstrumentMaster(warehouseRoot: string, instruments: OkxInstrumentRecord[]): Promise<void> {
  await atomicWriteJson(join(resolve(warehouseRoot), 'state', 'instrument-master.latest.json'), {
    schemaVersion: 'okx_instrument_master_snapshot.v1', generatedAt: new Date().toISOString(),
    researchOnly: true, count: instruments.length, instruments,
  })
}

export async function persistTickerSnapshot(warehouseRoot: string, events: OkxMarketEvent[]): Promise<void> {
  await atomicWriteJson(join(resolve(warehouseRoot), 'state', 'ticker-snapshot.latest.json'), {
    schemaVersion: 'okx_ticker_snapshot.v1', generatedAt: new Date().toISOString(), researchOnly: true,
    count: events.length, tickers: events.map(event => ({
      instrumentId: event.instrumentId, instrumentType: event.instrumentType,
      eventTime: event.eventTime, availableAt: event.availableAt, payload: event.payload,
    })),
  })
}

/**
 * OKX SPOT instruments expose quoteCcy while derivative instruments expose
 * settleCcy. Keeping the distinction here prevents USDT-margined swaps from
 * silently disappearing when quoteCcy is empty in the public instrument API.
 */
export function isUsdtQuotedPublicInstrument(instrument: Pick<OkxInstrumentRecord, 'instrumentType' | 'quoteCurrency' | 'settleCurrency'>): boolean {
  if (instrument.instrumentType === 'SPOT') return instrument.quoteCurrency === 'USDT'
  if (instrument.instrumentType === 'SWAP' || instrument.instrumentType === 'FUTURES') return instrument.settleCurrency === 'USDT'
  return false
}

export async function mapLimit<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = next++
      if (index >= items.length) return
      out[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, () => worker()))
  return out
}

export async function mapRateLimited<T, R>(
  items: T[],
  batchSize: number,
  intervalMs: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = []
  const size = Math.max(1, Math.floor(batchSize))
  for (let offset = 0; offset < items.length; offset += size) {
    const batch = items.slice(offset, offset + size)
    out.push(...await Promise.all(batch.map((item, index) => mapper(item, offset + index))))
    if (offset + size < items.length && intervalMs > 0) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, intervalMs))
    }
  }
  return out
}

export function classifyCollectorError(error: unknown): { message: string; errorClass: string; permanent: boolean } {
  if (error instanceof OkxPublicApiError) return { message: error.message, errorClass: error.errorClass, permanent: error.permanent }
  const message = error instanceof Error ? error.message : String(error)
  if (/HTTP\s+(401|403|451)\b/i.test(message)) return { message, errorClass: 'remote_permanent', permanent: true }
  if (/HTTP\s+429\b/i.test(message)) return { message, errorClass: 'rate_limited', permanent: false }
  if (/HTTP\s+5\d\d\b/i.test(message)) return { message, errorClass: 'remote_server_error', permanent: false }
  if (/timeout|ECONNRESET|ENETUNREACH|EAI_AGAIN|fetch failed/i.test(message)) return { message, errorClass: 'transient_network', permanent: false }
  return { message, errorClass: 'collector_error', permanent: false }
}

export function parseRawArgs(argv: string[]): Map<string, string> {
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

export function parseCsvList(raw: string | undefined): string[] {
  return raw?.split(/[\s,]+/).map(value => value.trim()).filter(Boolean) ?? []
}

export function buildCronNotification(report: CollectorReport): Record<string, unknown> {
  const shouldNotify = report.status === 'error' || report.conflictingDuplicateRows > 0
  return {
    shouldNotify,
    deliveryDecision: shouldNotify ? 'notify' : 'suppress',
    headline: `${report.task}: ${report.status}`,
    fullText: `${report.task} status=${report.status} fetched=${report.fetchedRows} written=${report.writtenRows} duplicates=${report.duplicateRows} conflicts=${report.conflictingDuplicateRows} errors=${report.errors.length} blockers=${report.blockers.join(',') || 'none'}`,
  }
}

async function persistCollectorArtifacts(report: CollectorReport, warehouseRoot: string, dataRoot: string): Promise<void> {
  const runtimeDir = resolve(dataRoot, 'runtime', 'okx_warehouse')
  const reportPath = join(runtimeDir, `${report.task}.latest.json`)
  const notificationPath = join(runtimeDir, `${report.task}_notification.json`)
  await mkdir(dirname(reportPath), { recursive: true })
  await atomicWriteJson(reportPath, report)
  await atomicWriteJson(notificationPath, buildCronNotification(report))
  await atomicWriteJson(join(warehouseRoot, 'state', `${report.task}.latest.json`), report)
}

function emptyReport(
  options: RunCollectorOptions,
  generatedAt: string,
  warehouseRoot: string,
  blockers: string[],
  collectorLockStatus: CollectorReport['collectorLockStatus'] = 'acquired',
): CollectorReport {
  return {
    schemaVersion: 'okx_warehouse_collector_report.v1', task: options.task, generatedAt,
    finishedAt: new Date().toISOString(), status: 'blocked', researchOnly: true, privateDataCalls: 0,
    warehouseRoot, runId: options.runId, fetchedRows: 0, writtenRows: 0, duplicateRows: 0,
    conflictingDuplicateRows: 0, collectorLockStatus, errors: [], blockers,
  }
}

async function acquireCollectorLock(dataRoot: string, task: string): Promise<{ release: () => Promise<void> } | null> {
  const path = resolve(dataRoot, 'runtime', 'locks', `${task}.collector.lock`)
  await mkdir(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, 'utf-8')
      await handle.sync()
      return { release: async () => { await handle.close().catch(() => undefined); await rm(path, { force: true }) } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = await readJson(path) as { pid?: unknown } | null
      if (typeof owner?.pid === 'number' && processAlive(owner.pid)) return null
      await rm(path, { force: true })
    }
  }
  return null
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

async function readJson(path: string): Promise<unknown> { try { return JSON.parse(await readFile(path, 'utf-8')) } catch { return null } }
function numberValue(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }
