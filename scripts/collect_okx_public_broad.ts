import { pathToFileURL } from 'node:url'
import { mapOkxCandle, mapOkxDerivativeMetric } from '../src/domain/market-data/okx-warehouse-mappers.js'
import type { OkxInstrumentRecord, OkxMarketEvent } from '../src/domain/market-data/okx-warehouse-types.js'
import { okxPublicGet } from '../src/domain/market-data/live-fetcher.js'
import { buildCollectionRunId } from './lib/okx_warehouse.js'
import { classifyCollectorError, fetchOkxRows, isUsdtQuotedPublicInstrument, mapRateLimited, parseCsvList, parseRawArgs, readInstrumentMaster, runOkxCollector } from './lib/okx_collector_common.js'

export async function collectOkxPublicBroad(argv = process.argv.slice(2)) {
  const raw = parseRawArgs(argv)
  const runId = raw.get('runId') ?? buildCollectionRunId('okx-broad')
  return runOkxCollector({
    task: 'okx_public_broad_refresh', runId, configPath: raw.get('configPath'),
    requireEnabled: raw.get('allowDisabled') !== 'true', pressureClass: 'broad',
    fetchEvents: async ({ availableAt, warehouseRoot }) => {
      const master = await readInstrumentMaster(warehouseRoot)
      const explicit = new Set(parseCsvList(raw.get('symbols')))
      const { broad, swaps } = selectBroadInstruments(master, explicit)
      const errors: Array<{ target: string; error: string; errorClass: string; permanent: boolean }> = []
      const [candleGroups, derivativeEvents] = await Promise.all([
        mapRateLimited(broad, explicit.size > 0 ? 4 : 20, explicit.size > 0 ? 0 : 1_050, async instrument => fetchCandles(instrument, availableAt, runId, errors)),
        fetchDerivativeSnapshotBatch(swaps, availableAt, runId, errors, explicit.size > 0),
      ])
      return { events: [...candleGroups.flat(), ...derivativeEvents], errors }
    },
  })
}

export function selectBroadInstruments(master: OkxInstrumentRecord[], explicit: Set<string>): { broad: OkxInstrumentRecord[]; swaps: OkxInstrumentRecord[] } {
  const broad = master.filter(instrument => {
    if (explicit.size > 0) {
      return explicit.has(instrument.instrumentId) &&
        (instrument.instrumentType === 'SPOT' || instrument.instrumentType === 'SWAP')
    }
    return instrument.state === 'live' &&
      (instrument.instrumentType === 'SPOT' || instrument.instrumentType === 'SWAP') &&
      isUsdtQuotedPublicInstrument(instrument)
  })
  const swaps = master.filter(instrument =>
    instrument.state === 'live' && instrument.instrumentType === 'SWAP' &&
    ['USDT', 'USDC'].includes(instrument.settleCurrency ?? '') &&
    (explicit.size === 0 || explicit.has(instrument.instrumentId)))
  return { broad, swaps }
}

async function fetchCandles(instrument: OkxInstrumentRecord, availableAt: string, runId: string, errors: Array<{ target: string; error: string; errorClass: string; permanent: boolean }>): Promise<OkxMarketEvent[]> {
  try {
    const response = await okxPublicGet<{ code: string; data?: unknown[][] }>(`/api/v5/market/candles?instId=${encodeURIComponent(instrument.instrumentId)}&bar=5m&limit=3`)
    return (response.data ?? [])
      .map(row => mapOkxCandle({ raw: row, instrumentId: instrument.instrumentId, instrumentType: instrument.instrumentType as 'SPOT' | 'SWAP', bar: '5m', collectionRunId: runId, availableAt }))
      .filter(event => event.confirmed === true)
  } catch (error) {
    const classified = classifyCollectorError(error)
    errors.push({ target: `${instrument.instrumentId}/candle5m`, error: classified.message, errorClass: classified.errorClass, permanent: classified.permanent })
    return []
  }
}

async function fetchDerivativeSnapshotBatch(
  swaps: OkxInstrumentRecord[],
  availableAt: string,
  runId: string,
  errors: Array<{ target: string; error: string; errorClass: string; permanent: boolean }>,
  explicitCanary: boolean,
): Promise<OkxMarketEvent[]> {
  const batchRows = await fetchDerivativeBatchRows(errors)
  const batchEvents = mapDerivativeBatchRows(swaps, batchRows, availableAt, runId)
  const fundingGroups = await mapRateLimited(
    swaps,
    explicitCanary ? 3 : 5,
    explicitCanary ? 0 : 1_050,
    async instrument => {
      const path = `/api/v5/public/funding-rate?instId=${encodeURIComponent(instrument.instrumentId)}`
      try {
        return (await fetchOkxRows(path)).map(row => mapOkxDerivativeMetric({
          dataset: 'funding', instrumentId: instrument.instrumentId, sourceEndpoint: '/api/v5/public/funding-rate',
          raw: row, collectionRunId: runId, availableAt,
        }))
      } catch (error) {
        const classified = classifyCollectorError(error)
        errors.push({ target: `${instrument.instrumentId}/funding`, error: classified.message, errorClass: classified.errorClass, permanent: classified.permanent })
        return []
      }
    },
  )
  return [...batchEvents, ...fundingGroups.flat()]
}

async function fetchDerivativeBatchRows(
  errors: Array<{ target: string; error: string; errorClass: string; permanent: boolean }>,
): Promise<{ openInterest: Record<string, unknown>[]; marks: Record<string, unknown>[]; indices: Record<string, unknown>[] }> {
  const tasks: Array<{ key: 'openInterest' | 'marks' | 'indices'; path: string }> = [
    { key: 'openInterest', path: '/api/v5/public/open-interest?instType=SWAP' },
    { key: 'marks', path: '/api/v5/public/mark-price?instType=SWAP' },
    { key: 'indices', path: '/api/v5/market/index-tickers?quoteCcy=USDT' },
    { key: 'indices', path: '/api/v5/market/index-tickers?quoteCcy=USDC' },
  ]
  const output = { openInterest: [] as Record<string, unknown>[], marks: [] as Record<string, unknown>[], indices: [] as Record<string, unknown>[] }
  for (const task of tasks) {
    try { output[task.key].push(...await fetchOkxRows(task.path)) }
    catch (error) {
      const classified = classifyCollectorError(error)
      errors.push({ target: `batch/${task.key}`, error: classified.message, errorClass: classified.errorClass, permanent: classified.permanent })
    }
  }
  return output
}

export function mapDerivativeBatchRows(
  swaps: OkxInstrumentRecord[],
  rows: { openInterest: Record<string, unknown>[]; marks: Record<string, unknown>[]; indices: Record<string, unknown>[] },
  availableAt: string,
  runId: string,
): OkxMarketEvent[] {
  const oi = new Map(rows.openInterest.map(row => [String(row.instId ?? ''), row]))
  const marks = new Map(rows.marks.map(row => [String(row.instId ?? ''), row]))
  const indices = new Map(rows.indices.map(row => [String(row.instId ?? ''), row]))
  const events: OkxMarketEvent[] = []
  for (const instrument of swaps) {
    const oiRow = oi.get(instrument.instrumentId)
    if (oiRow) events.push(mapOkxDerivativeMetric({
      dataset: 'open_interest', instrumentId: instrument.instrumentId, sourceEndpoint: '/api/v5/public/open-interest',
      raw: oiRow, collectionRunId: runId, availableAt,
    }))
    const mark = marks.get(instrument.instrumentId)
    const index = instrument.instrumentFamily ? indices.get(instrument.instrumentFamily) : undefined
    if (!mark && !index) continue
    const markPx = numeric(mark?.markPx)
    const indexPx = numeric(index?.idxPx)
    const payload = {
      instId: instrument.instrumentId, instrumentFamily: instrument.instrumentFamily,
      markPx, indexPx, premium: markPx != null && indexPx != null && indexPx !== 0 ? (markPx - indexPx) / indexPx : null,
      ts: Math.max(Number(mark?.ts ?? 0), Number(index?.ts ?? 0)).toString(),
    }
    events.push(mapOkxDerivativeMetric({
      dataset: 'mark_index', instrumentId: instrument.instrumentId,
      sourceEndpoint: '/api/v5/public/mark-price+/api/v5/market/index-tickers',
      raw: payload, collectionRunId: runId, availableAt,
    }))
  }
  return events
}

function numeric(value: unknown): number | null {
  const parsed = Number(value)
  return value !== '' && value != null && Number.isFinite(parsed) ? parsed : null
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  collectOkxPublicBroad().then(report => { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (report.status === 'error') process.exitCode = 1 }).catch(error => { console.error(error); process.exitCode = 1 })
}
