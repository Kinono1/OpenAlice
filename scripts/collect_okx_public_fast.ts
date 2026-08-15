import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mapOkxCandle, mapOkxTicker } from '../src/domain/market-data/okx-warehouse-mappers.js'
import type { OkxInstrumentRecord, OkxMarketEvent } from '../src/domain/market-data/okx-warehouse-types.js'
import { okxPublicGet } from '../src/domain/market-data/live-fetcher.js'
import { buildCollectionRunId } from './lib/okx_warehouse.js'
import { fetchOkxRows, isUsdtQuotedPublicInstrument, parseCsvList, parseRawArgs, persistTickerSnapshot, readInstrumentMaster, runOkxCollector } from './lib/okx_collector_common.js'

export async function collectOkxPublicFast(argv = process.argv.slice(2)) {
  const raw = parseRawArgs(argv)
  const runId = raw.get('runId') ?? buildCollectionRunId('okx-fast')
  return runOkxCollector({
    task: 'okx_public_fast_refresh', runId, configPath: raw.get('configPath'),
    requireEnabled: raw.get('allowDisabled') !== 'true', pressureClass: 'high_frequency',
    fetchEvents: async ({ config, availableAt, warehouseRoot }) => {
      const tickerEvents: OkxMarketEvent[] = []
      for (const instrumentType of config.publicMarkets.tickers) {
        const rows = await fetchOkxRows(`/api/v5/market/tickers?instType=${instrumentType}`)
        for (const row of rows) tickerEvents.push(mapOkxTicker(row, instrumentType, runId, availableAt))
      }
      await persistTickerSnapshot(warehouseRoot, tickerEvents)

      const explicit = parseCsvList(raw.get('symbols'))
      const instruments = explicit.length > 0
        ? explicit.map(instrumentId => ({ instrumentId, instrumentType: instrumentId.endsWith('-SWAP') ? 'SWAP' : 'SPOT' }) as Pick<OkxInstrumentRecord, 'instrumentId' | 'instrumentType'>)
        : await resolveTopMinuteUniverse(warehouseRoot, config.universe.topMinuteCandleCount)
      const candleEvents: OkxMarketEvent[] = []
      for (const instrument of instruments) {
        if (instrument.instrumentType !== 'SPOT' && instrument.instrumentType !== 'SWAP') continue
        const response = await okxPublicGet<{ code: string; data?: unknown[][] }>(`/api/v5/market/candles?instId=${encodeURIComponent(instrument.instrumentId)}&bar=1m&limit=3`)
        for (const row of response.data ?? []) {
          const event = mapOkxCandle({ raw: row, instrumentId: instrument.instrumentId, instrumentType: instrument.instrumentType, bar: '1m', collectionRunId: runId, availableAt })
          if (event.confirmed === true) candleEvents.push(event)
        }
      }
      return { events: [...tickerEvents, ...candleEvents] }
    },
  })
}

async function resolveTopMinuteUniverse(warehouseRoot: string, count: number): Promise<Array<Pick<OkxInstrumentRecord, 'instrumentId' | 'instrumentType'>>> {
  try {
    const manifest = JSON.parse(await readFile(join(warehouseRoot, 'state', 'top-minute-universe.latest.json'), 'utf-8')) as { instruments?: string[] }
    if (Array.isArray(manifest.instruments) && manifest.instruments.length > 0) {
      return manifest.instruments.slice(0, count).map(instrumentId => ({ instrumentId, instrumentType: instrumentId.endsWith('-SWAP') ? 'SWAP' : 'SPOT' }))
    }
  } catch { /* use liquid fallback */ }
  const master = await readInstrumentMaster(warehouseRoot)
  return master.filter(item => item.state === 'live' && (item.instrumentType === 'SPOT' || item.instrumentType === 'SWAP') && isUsdtQuotedPublicInstrument(item)).slice(0, count)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  collectOkxPublicFast().then(report => { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (report.status === 'error') process.exitCode = 1 }).catch(error => { console.error(error); process.exitCode = 1 })
}
