import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadOkxMarketDataConfig, resolveOkxWarehouseRoot } from '../src/domain/market-data/okx-market-data-config.js'
import { atomicWriteJson, buildStoragePressureStatus, listRawSegmentManifests, sha256Hex, walkFiles } from './lib/okx_warehouse.js'

export interface OkxMarketDataHealthReport {
  schemaVersion: 'okx_market_data_health.v1'
  generatedAt: string
  status: 'ready' | 'degraded_partial_coverage' | 'degraded_stream_unavailable' | 'degraded_storage_pressure' | 'blocked_ssd_not_mounted' | 'blocked_volume_identity_mismatch' | 'blocked_cold_storage_full' | 'blocked_data_integrity' | 'circuit_open'
  researchOnly: true
  promotionAllowed: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  privateApiCallCount: 0
  warehouse: {
    root: string
    rawSegments: number
    uncompactedSegments: number
    invalidManifests: number
    hashMismatches: number
    conflictingDuplicates: number
    latestEventTime: string | null
  }
  coverage: {
    instruments: number
    liveInstruments: number
    tickerEligibleInstruments: number
    tickers: number
    liveTickerCoveragePct: number | null
    liveSwaps: number
    swapMetricEvents: number
  }
  rest: {
    instrument: CollectorHealthSummary
    fast: CollectorHealthSummary
    broad: CollectorHealthSummary
  }
  storage: Awaited<ReturnType<typeof buildStoragePressureStatus>>
  stream: { enabled: boolean; status: string; lastEventAt: string | null; reconnectAttempts: number; sequenceGaps: number; checksumMismatches: number }
  archive: Record<string, unknown>
  compaction: { status: string; candidates: number; compacted: number; errors: number }
  universe: { fixed: string[]; dynamic: string[]; mode: string | null }
  circuits: Array<{ task: string; status: 'open'; errorClasses: string[] }>
  blockers: string[]
  warnings: string[]
}

interface CollectorHealthSummary {
  available: boolean
  status: string | null
  finishedAt: string | null
  ageMs: number | null
  fetchedRows: number
  writtenRows: number
  errors: number
  permanentErrors: number
}

export async function buildOkxMarketDataHealth(argv = process.argv.slice(2)): Promise<OkxMarketDataHealthReport> {
  const raw = parseRawArgs(argv)
  const config = await loadOkxMarketDataConfig(raw.get('configPath'))
  const root = resolveOkxWarehouseRoot(config)
  const manifests = await listRawSegmentManifests(root)
  let hashMismatches = 0
  let latestEventTime: string | null = null
  for (const item of manifests) {
    latestEventTime = maxIso(latestEventTime, item.manifest.maxEventTime)
    try {
      const content = await readFile(join(root, item.manifest.relativePath))
      if (sha256Hex(content) !== item.manifest.sha256) hashMismatches += 1
    } catch { hashMismatches += 1 }
  }
  const invalidManifests = Math.max(0, (await walkFiles(join(root, 'manifests', 'raw'), path => path.endsWith('.manifest.json'))).length - manifests.length)
  const conflicts = (await walkFiles(join(root, 'quarantine', 'conflicts'), path => path.endsWith('.json'))).length
  const instrumentSnapshot = await readJson(join(root, 'state', 'instrument-master.latest.json')) as { instruments?: Array<{ state?: string; instrumentType?: string }> } | null
  const tickerSnapshot = await readJson(join(root, 'state', 'ticker-snapshot.latest.json')) as { tickers?: unknown[] } | null
  const instruments = instrumentSnapshot?.instruments ?? []
  const live = instruments.filter(item => item.state === 'live')
  const tickers = tickerSnapshot?.tickers ?? []
  const tickerEligible = live.filter(item => ['SPOT', 'SWAP', 'FUTURES'].includes(String(item.instrumentType)))
  const liveSwaps = live.filter(item => item.instrumentType === 'SWAP').length
  const swapMetricEvents = manifests.filter(item => ['funding', 'mark_index', 'open_interest'].includes(item.manifest.dataset)).reduce((sum, item) => sum + item.manifest.rowCount, 0)
  const storage = await buildStoragePressureStatus({
    warehouseRoot: root, budgetGiB: config.storage.budgetGiB,
    warningFreeSpaceGiB: config.storage.warningFreeSpaceGiB,
    pauseHighFrequencyAtGiB: config.storage.pauseHighFrequencyAtGiB,
    pauseBroadCollectionFreeSpaceGiB: config.storage.pauseBroadCollectionFreeSpaceGiB,
    emergencyStopFreeSpaceGiB: config.storage.emergencyStopFreeSpaceGiB,
  })
  const stream = await readJson(join(root, 'state', 'stream-health.latest.json')) as Record<string, unknown> | null
  const archive = await readJson(resolve(config.dataRoot, 'runtime', 'storage', 'ssd_archive_state.json')) as Record<string, unknown> | null
  const [instrumentCollector, fastCollector, broadCollector, compact, universe] = await Promise.all([
    readJson(join(root, 'state', 'okx_instrument_master_refresh.latest.json')),
    readJson(join(root, 'state', 'okx_public_fast_refresh.latest.json')),
    readJson(join(root, 'state', 'okx_public_broad_refresh.latest.json')),
    readJson(resolve(config.dataRoot, 'runtime', 'okx_warehouse', 'okx_warehouse_compact.latest.json')),
    readJson(join(root, 'state', 'depth-universe.latest.json')),
  ])
  const rest = {
    instrument: collectorSummary(instrumentCollector),
    fast: collectorSummary(fastCollector),
    broad: collectorSummary(broadCollector),
  }
  const circuits = Object.entries(rest).filter(([, value]) => value.permanentErrors > 0).map(([task, value]) => ({ task, status: 'open' as const, errorClasses: ['remote_permanent'] }))
  const blockers: string[] = []
  const warnings: string[] = []
  if (hashMismatches > 0 || invalidManifests > 0 || conflicts > 0) blockers.push('warehouse_integrity_failure')
  if (storage.status === 'emergency_storage_stop') blockers.push('emergency_storage_stop')
  else if (storage.status !== 'healthy') warnings.push(storage.status)
  if (config.enabled && tickerEligible.length > 0 && tickers.length / tickerEligible.length < 0.99) warnings.push('ticker_coverage_below_99pct')
  if (config.stream.enabled && stream?.status !== 'ready') warnings.push('stream_not_ready')
  if (circuits.length > 0) blockers.push(`circuit_open:${circuits.map(item => item.task).join(',')}`)
  if (config.enabled && (!rest.instrument.available || !rest.fast.available || !rest.broad.available)) warnings.push('rest_collector_health_missing')
  if (archive?.status === 'blocked_volume_identity_mismatch') blockers.push('blocked_volume_identity_mismatch')
  if (archive?.status === 'blocked_cold_storage_full') blockers.push('blocked_cold_storage_full')
  if (archive?.status === 'blocked_ssd_not_mounted') warnings.push('blocked_ssd_not_mounted')
  const status: OkxMarketDataHealthReport['status'] = blockers.some(item => item.startsWith('circuit_open:'))
    ? 'circuit_open'
    : blockers.includes('warehouse_integrity_failure') || blockers.includes('emergency_storage_stop')
    ? 'blocked_data_integrity'
    : blockers.includes('blocked_volume_identity_mismatch') ? 'blocked_volume_identity_mismatch'
      : blockers.includes('blocked_cold_storage_full') ? 'blocked_cold_storage_full'
        : storage.status !== 'healthy' ? 'degraded_storage_pressure'
          : config.stream.enabled && stream?.status !== 'ready' ? 'degraded_stream_unavailable'
            : warnings.includes('blocked_ssd_not_mounted') ? 'blocked_ssd_not_mounted'
              : warnings.length > 0 ? 'degraded_partial_coverage' : 'ready'

  const report: OkxMarketDataHealthReport = {
    schemaVersion: 'okx_market_data_health.v1', generatedAt: new Date().toISOString(), status,
    researchOnly: true, promotionAllowed: false, paperTradingAllowed: false, liveTradingAllowed: false,
    privateApiCallCount: 0,
    warehouse: { root, rawSegments: manifests.length, uncompactedSegments: manifests.filter(item => item.manifest.parquetPath == null).length, invalidManifests, hashMismatches, conflictingDuplicates: conflicts, latestEventTime },
    coverage: {
      instruments: instruments.length, liveInstruments: live.length, tickerEligibleInstruments: tickerEligible.length,
      tickers: tickers.length, liveTickerCoveragePct: tickerEligible.length > 0 ? (tickers.length / tickerEligible.length) * 100 : null,
      liveSwaps, swapMetricEvents,
    },
    rest,
    storage,
    stream: {
      enabled: config.stream.enabled,
      status: typeof stream?.status === 'string' ? stream.status : config.stream.enabled ? 'missing' : 'disabled',
      lastEventAt: typeof stream?.lastEventAt === 'string' ? stream.lastEventAt : null,
      reconnectAttempts: numberValue(stream?.reconnectAttempts),
      sequenceGaps: numberValue(stream?.sequenceGaps),
      checksumMismatches: numberValue(stream?.checksumMismatches),
    },
    archive: archive ?? { status: 'not_enrolled_or_unavailable' },
    compaction: {
      status: isRecord(compact) && typeof compact.status === 'string' ? compact.status : 'missing',
      candidates: numberValue(isRecord(compact) ? compact.candidates : null),
      compacted: numberValue(isRecord(compact) ? compact.compacted : null),
      errors: isRecord(compact) && Array.isArray(compact.errors) ? compact.errors.length : 0,
    },
    universe: {
      fixed: isRecord(universe) && Array.isArray(universe.fixedDeepInstruments) ? universe.fixedDeepInstruments.filter((value): value is string => typeof value === 'string') : [],
      dynamic: isRecord(universe) && Array.isArray(universe.dynamicInstruments) ? universe.dynamicInstruments.filter((value): value is string => typeof value === 'string') : [],
      mode: isRecord(universe) && typeof universe.mode === 'string' ? universe.mode : null,
    },
    circuits, blockers, warnings,
  }
  const outputPath = resolve(raw.get('outputPath') ?? join(config.dataRoot, 'runtime', 'okx_market_data_health.latest.json'))
  await atomicWriteJson(outputPath, report)
  await atomicWriteJson(resolve(config.dataRoot, 'runtime', 'okx_warehouse', 'okx_market_data_health_notification.json'), {
    shouldNotify: blockers.length > 0 || warnings.some(item => item !== 'blocked_ssd_not_mounted'),
    deliveryDecision: blockers.length > 0 || warnings.some(item => item !== 'blocked_ssd_not_mounted') ? 'notify' : 'suppress',
    headline: `OKX market data health: ${status}`,
    fullText: `OKX market data health status=${status} instruments=${instruments.length} tickers=${tickers.length} rawSegments=${manifests.length} uncompacted=${report.warehouse.uncompactedSegments} storage=${storage.status} blockers=${blockers.join(',') || 'none'} warnings=${warnings.join(',') || 'none'}`,
  })
  return report
}

async function readJson(path: string): Promise<unknown> { try { await access(resolve(path), constants.R_OK); return JSON.parse(await readFile(resolve(path), 'utf-8')) } catch { return null } }
function collectorSummary(value: unknown): CollectorHealthSummary {
  if (!isRecord(value)) return { available: false, status: null, finishedAt: null, ageMs: null, fetchedRows: 0, writtenRows: 0, errors: 0, permanentErrors: 0 }
  const finishedAt = typeof value.finishedAt === 'string' ? value.finishedAt : null
  const errors = Array.isArray(value.errors) ? value.errors.filter(isRecord) : []
  return {
    available: true,
    status: typeof value.status === 'string' ? value.status : null,
    finishedAt,
    ageMs: finishedAt && Number.isFinite(Date.parse(finishedAt)) ? Math.max(0, Date.now() - Date.parse(finishedAt)) : null,
    fetchedRows: numberValue(value.fetchedRows), writtenRows: numberValue(value.writtenRows),
    errors: errors.length, permanentErrors: errors.filter(error => error.permanent === true).length,
  }
}
function numberValue(value: unknown): number { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : 0 }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function maxIso(left: string | null, right: string | null): string | null { if (!left) return right; if (!right) return left; return left > right ? left : right }
function parseRawArgs(argv: string[]): Map<string, string> { const out = new Map<string, string>(); for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token?.startsWith('--')) continue; const next = argv[i + 1]; if (!next || next.startsWith('--')) out.set(token.slice(2), 'true'); else { out.set(token.slice(2), next); i += 1 } } return out }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) buildOkxMarketDataHealth().then(report => { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (report.blockers.length > 0) process.exitCode = 1 }).catch(error => { console.error(error); process.exitCode = 1 })
