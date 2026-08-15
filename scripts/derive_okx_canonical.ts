import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { loadOkxMarketDataConfig, resolveOkxWarehouseRoot } from '../src/domain/market-data/okx-market-data-config.js'
import { buildOkxMarketEvent } from '../src/domain/market-data/okx-warehouse-mappers.js'
import type { OkxMarketEvent } from '../src/domain/market-data/okx-warehouse-types.js'
import { appendOkxMarketEvents, atomicWriteJson, buildCollectionRunId, listRawSegmentManifests, readRawSegmentEvents } from './lib/okx_warehouse.js'

interface CandlePayload {
  bar?: unknown
  open?: unknown
  high?: unknown
  low?: unknown
  close?: unknown
  volume?: unknown
  volumeCurrency?: unknown
  volumeQuote?: unknown
}

interface CanonicalReport {
  schemaVersion: 'okx_canonical_derivation.v1'
  generatedAt: string
  status: 'complete' | 'blocked' | 'partial'
  researchOnly: true
  warehouseRoot: string
  inputEvents: number
  derivedEvents: number
  writtenRows: number
  duplicateRows: number
  conflictingDuplicateRows: number
  errors: string[]
  blockers: string[]
}

const BAR_MS: Record<string, number> = {
  '1s': 1_000,
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

const RESAMPLE_TARGETS: Record<string, string[]> = {
  '1m': ['5m', '15m', '1h'],
  '5m': ['15m', '1h', '4h', '1d'],
}

export async function deriveOkxCanonical(argv = process.argv.slice(2)): Promise<CanonicalReport> {
  const raw = parseRawArgs(argv)
  const config = await loadOkxMarketDataConfig(raw.get('configPath'))
  const warehouseRoot = resolveOkxWarehouseRoot(config)
  const generatedAt = raw.get('now') ?? new Date().toISOString()
  const blockers: string[] = []
  if (!config.enabled && raw.get('allowDisabled') !== 'true') blockers.push('collector_disabled_by_config')
  if (blockers.length > 0) {
    const blocked: CanonicalReport = {
      schemaVersion: 'okx_canonical_derivation.v1', generatedAt, status: 'blocked', researchOnly: true,
      warehouseRoot, inputEvents: 0, derivedEvents: 0, writtenRows: 0, duplicateRows: 0,
      conflictingDuplicateRows: 0, errors: [], blockers,
    }
    await persistReport(blocked, config.dataRoot, raw.get('reportPath'))
    return blocked
  }

  const manifests = await listRawSegmentManifests(warehouseRoot)
  const sourceEvents: OkxMarketEvent[] = []
  const errors: string[] = []
  for (const item of manifests) {
    if (item.manifest.dataset !== 'candle' && item.manifest.dataset !== 'trade') continue
    try {
      const events = await readRawSegmentEvents(warehouseRoot, item.manifest)
      sourceEvents.push(...events.filter(event =>
        (event.dataset === 'candle' && event.confirmed === true && event.sourceTransport !== 'derived') ||
        (event.dataset === 'trade' && event.sourceTransport === 'websocket')))
    } catch (error) {
      errors.push(`${item.manifest.segmentId}:${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const runId = raw.get('runId') ?? buildCollectionRunId('okx-canonical', generatedAt)
  const derived = deriveCanonicalEvents(sourceEvents, {
    generatedAt,
    collectionRunId: runId,
    tradeMinAgeMs: positiveInt(raw.get('tradeMinAgeMs'), 10_000),
  })
  const appended = await appendOkxMarketEvents(warehouseRoot, derived)
  const report: CanonicalReport = {
    schemaVersion: 'okx_canonical_derivation.v1', generatedAt,
    status: errors.length === 0 ? 'complete' : appended.writtenRows > 0 ? 'partial' : 'blocked',
    researchOnly: true, warehouseRoot, inputEvents: sourceEvents.length, derivedEvents: derived.length,
    writtenRows: appended.writtenRows, duplicateRows: appended.duplicateRows,
    conflictingDuplicateRows: appended.conflictingDuplicateRows, errors, blockers: [],
  }
  await persistReport(report, config.dataRoot, raw.get('reportPath'))
  return report
}

export function deriveCanonicalEvents(
  events: OkxMarketEvent[],
  options: { generatedAt: string; collectionRunId: string; tradeMinAgeMs?: number },
): OkxMarketEvent[] {
  const out: OkxMarketEvent[] = []
  const directCandles = uniqueEvents(events.filter(event => event.dataset === 'candle' && event.confirmed === true && event.sourceTransport !== 'derived'))
  for (const sourceBar of Object.keys(RESAMPLE_TARGETS)) {
    const source = directCandles.filter(event => candleBar(event) === sourceBar)
    for (const targetBar of RESAMPLE_TARGETS[sourceBar]) {
      out.push(...resampleCandles(source, sourceBar, targetBar, options.collectionRunId, options.generatedAt))
    }
  }
  out.push(...deriveTradeCandles(
    uniqueEvents(events.filter(event => event.dataset === 'trade' && event.sourceTransport === 'websocket')),
    '1s', options.collectionRunId, options.generatedAt, options.tradeMinAgeMs ?? 10_000,
  ))
  out.push(...deriveTradeCandles(
    uniqueEvents(events.filter(event => event.dataset === 'trade' && event.sourceTransport === 'websocket')),
    '1m', options.collectionRunId, options.generatedAt, options.tradeMinAgeMs ?? 10_000,
  ))
  return out.sort((left, right) => left.eventTime.localeCompare(right.eventTime) || left.dedupKey.localeCompare(right.dedupKey))
}

function resampleCandles(events: OkxMarketEvent[], sourceBar: string, targetBar: string, runId: string, generatedAt: string): OkxMarketEvent[] {
  const sourceMs = BAR_MS[sourceBar]
  const targetMs = BAR_MS[targetBar]
  const expected = targetMs / sourceMs
  if (!Number.isInteger(expected) || expected <= 1) return []
  const groups = new Map<string, OkxMarketEvent[]>()
  for (const event of events) {
    const timestamp = Date.parse(event.eventTime)
    if (!Number.isFinite(timestamp)) continue
    const bucket = Math.floor(timestamp / targetMs) * targetMs
    const key = `${event.instrumentType}|${event.instrumentId}|${bucket}`
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }
  const out: OkxMarketEvent[] = []
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => left.eventTime.localeCompare(right.eventTime))
    const bucket = Math.floor(Date.parse(ordered[0].eventTime) / targetMs) * targetMs
    const expectedTimes = new Set(Array.from({ length: expected }, (_, index) => bucket + index * sourceMs))
    const exact = new Map(ordered.map(event => [Date.parse(event.eventTime), event]))
    if (expectedTimes.size !== exact.size || [...expectedTimes].some(timestamp => !exact.has(timestamp))) continue
    const payloads = ordered.map(event => asCandlePayload(event.payload))
    if (payloads.some(payload => payload == null)) continue
    const candles = payloads as Required<Pick<CandlePayload, 'open' | 'high' | 'low' | 'close' | 'volume'>>[]
    const open = finite(candles[0].open)
    const close = finite(candles.at(-1)?.close)
    const highs = candles.map(item => finite(item.high))
    const lows = candles.map(item => finite(item.low))
    const volumes = candles.map(item => finite(item.volume))
    if (open == null || close == null || highs.some(value => value == null) || lows.some(value => value == null) || volumes.some(value => value == null)) continue
    const eventTime = new Date(bucket).toISOString()
    const instrument = ordered[0]
    const availableAt = maxIso(ordered.map(event => event.availableAt))
    const payload = {
      bar: targetBar, sourceBar, openTime: eventTime, open,
      high: Math.max(...highs as number[]), low: Math.min(...lows as number[]), close,
      volume: (volumes as number[]).reduce((sum, value) => sum + value, 0),
      volumeCurrency: sumNullable(payloads.map(item => finite(item?.volumeCurrency))),
      volumeQuote: sumNullable(payloads.map(item => finite(item?.volumeQuote))),
      confirmed: true, canonical: true, parentCount: ordered.length,
      parentDedupKeys: ordered.map(event => event.dedupKey),
    }
    out.push(buildOkxMarketEvent({
      dataset: 'candle', instrumentType: instrument.instrumentType, instrumentId: instrument.instrumentId,
      instrumentFamily: instrument.instrumentFamily, channel: `canonical-candle-${targetBar}`,
      sourceTransport: 'derived', sourceEndpoint: `derived:okx-canonical/${sourceBar}->${targetBar}`,
      eventTime, availableAt, ingestedAt: generatedAt, confirmed: true, collectionRunId: runId,
      universeManifestId: instrument.universeManifestId,
      dedupKey: `okx|candle-derived|${instrument.instrumentId}|${sourceBar}|${targetBar}|${bucket}`,
      payload,
    }))
  }
  return out
}

function deriveTradeCandles(events: OkxMarketEvent[], targetBar: '1s' | '1m', runId: string, generatedAt: string, minAgeMs: number): OkxMarketEvent[] {
  const targetMs = BAR_MS[targetBar]
  const cutoff = Date.parse(generatedAt) - minAgeMs
  const groups = new Map<string, OkxMarketEvent[]>()
  for (const event of events) {
    const timestamp = Date.parse(event.eventTime)
    if (!Number.isFinite(timestamp)) continue
    const bucket = Math.floor(timestamp / targetMs) * targetMs
    if (bucket + targetMs > cutoff) continue
    const key = `${event.instrumentId}|${bucket}`
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }
  const out: OkxMarketEvent[] = []
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => left.eventTime.localeCompare(right.eventTime) || left.dedupKey.localeCompare(right.dedupKey))
    const trades = ordered.map(event => {
      const payload = isRecord(event.payload) ? event.payload : {}
      return { event, price: finite(payload.px ?? payload.price), size: finite(payload.sz ?? payload.size), side: String(payload.side ?? '').toLowerCase() }
    }).filter(item => item.price != null && item.size != null && item.price > 0 && item.size >= 0)
    if (trades.length === 0) continue
    const bucket = Math.floor(Date.parse(trades[0].event.eventTime) / targetMs) * targetMs
    const prices = trades.map(item => item.price as number)
    const volume = trades.reduce((sum, item) => sum + (item.size as number), 0)
    const quoteNotional = trades.reduce((sum, item) => sum + (item.price as number) * (item.size as number), 0)
    const signedVolume = trades.reduce((sum, item) => sum + (item.side === 'sell' ? -1 : 1) * (item.size as number), 0)
    const eventTime = new Date(bucket).toISOString()
    const instrument = trades[0].event
    out.push(buildOkxMarketEvent({
      dataset: 'candle', instrumentType: instrument.instrumentType, instrumentId: instrument.instrumentId,
      instrumentFamily: instrument.instrumentFamily, channel: `trades-derived-candle-${targetBar}`,
      sourceTransport: 'derived', sourceEndpoint: `derived:okx-trades/${targetBar}`,
      eventTime, availableAt: maxIso(trades.map(item => item.event.availableAt)), ingestedAt: generatedAt,
      confirmed: true, collectionRunId: runId, universeManifestId: instrument.universeManifestId,
      dedupKey: `okx|candle-derived|${instrument.instrumentId}|trades|${targetBar}|${bucket}`,
      payload: {
        bar: targetBar, sourceBar: 'trade', openTime: eventTime,
        open: prices[0], high: Math.max(...prices), low: Math.min(...prices), close: prices.at(-1),
        volume, volumeQuote: quoteNotional, confirmed: true, canonical: true,
        tradeCount: trades.length, signedVolume, vwap: volume > 0 ? quoteNotional / volume : null,
        parentDedupKeys: trades.map(item => item.event.dedupKey),
      },
    }))
  }
  return out
}

function uniqueEvents(events: OkxMarketEvent[]): OkxMarketEvent[] {
  const map = new Map<string, OkxMarketEvent>()
  for (const event of events) if (!map.has(event.dedupKey)) map.set(event.dedupKey, event)
  return [...map.values()]
}

function candleBar(event: OkxMarketEvent): string | null {
  return isRecord(event.payload) && typeof event.payload.bar === 'string' ? event.payload.bar : null
}

function asCandlePayload(value: unknown): CandlePayload | null { return isRecord(value) ? value : null }
function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function finite(value: unknown): number | null { const parsed = Number(value); return value !== '' && value != null && Number.isFinite(parsed) ? parsed : null }
function maxIso(values: string[]): string { return values.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest) }
function sumNullable(values: Array<number | null>): number | null { const present = values.filter((value): value is number => value != null); return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) }
function positiveInt(value: string | undefined, fallback: number): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback }
function parseRawArgs(argv: string[]): Map<string, string> { const out = new Map<string, string>(); for (let index = 0; index < argv.length; index += 1) { const token = argv[index]; if (!token?.startsWith('--')) continue; const next = argv[index + 1]; if (!next || next.startsWith('--')) out.set(token.slice(2), 'true'); else { out.set(token.slice(2), next); index += 1 } } return out }

async function persistReport(report: CanonicalReport, dataRoot: string, path?: string): Promise<void> {
  await atomicWriteJson(resolve(path ?? join(dataRoot, 'runtime', 'okx_warehouse', 'okx_canonical_derivation.latest.json')), report)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  deriveOkxCanonical().then(report => { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (report.status === 'partial') process.exitCode = 1 }).catch(error => { console.error(error); process.exitCode = 1 })
}
