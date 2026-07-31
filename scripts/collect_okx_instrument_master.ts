import { pathToFileURL } from 'node:url'
import { buildOkxMarketEvent, mapOkxInstrument } from '../src/domain/market-data/okx-warehouse-mappers.js'
import type { OkxInstrumentType } from '../src/domain/market-data/okx-warehouse-types.js'
import { buildCollectionRunId } from './lib/okx_warehouse.js'
import { fetchOkxRows, parseRawArgs, readInstrumentMaster, runOkxCollector, writeInstrumentMaster } from './lib/okx_collector_common.js'

type InstrumentRowsFetcher = (path: string) => Promise<Array<Record<string, unknown>>>

export async function collectOkxInstrumentMaster(argv = process.argv.slice(2)) {
  const raw = parseRawArgs(argv)
  const runId = raw.get('runId') ?? buildCollectionRunId('okx-instruments')
  return runOkxCollector({
    task: 'okx_instrument_master_refresh', runId, configPath: raw.get('configPath'),
    requireEnabled: raw.get('allowDisabled') !== 'true', pressureClass: 'essential',
    fetchEvents: async ({ config, availableAt, warehouseRoot }) => {
      const types = config.publicMarkets.instruments as OkxInstrumentType[]
      const previous = new Map((await readInstrumentMaster(warehouseRoot)).map(item => [item.instrumentId, item.payloadHash]))
      const instruments = []
      const events = []
      for (const type of types) {
        const rows = await fetchInstrumentRows(type, fetchOkxRows)
        for (const row of rows) {
          const instrument = mapOkxInstrument(row, availableAt)
          instruments.push(instrument)
          if (previous.get(instrument.instrumentId) === instrument.payloadHash) continue
          events.push(buildOkxMarketEvent({
            dataset: 'instrument', instrumentType: instrument.instrumentType,
            instrumentId: instrument.instrumentId, instrumentFamily: instrument.instrumentFamily,
            channel: 'instruments', sourceTransport: 'rest',
            sourceEndpoint: `/api/v5/public/instruments?instType=${type}`,
            eventTime: instrument.eventTime, availableAt, collectionRunId: runId,
            dedupKey: `okx|instrument|${instrument.instrumentId}|${availableAt}|${instrument.payloadHash}`,
            payload: instrument,
          }))
        }
      }
      await writeInstrumentMaster(warehouseRoot, instruments)
      return { events }
    },
  })
}

export async function fetchInstrumentRows(type: OkxInstrumentType, fetcher: InstrumentRowsFetcher): Promise<Array<Record<string, unknown>>> {
  if (type !== 'OPTION') {
    return filterIdentifiedInstrumentRows(await fetcher(`/api/v5/public/instruments?instType=${type}`))
  }
  const underlyings = await fetcher('/api/v5/public/underlying?instType=OPTION')
  const values = [...new Set(underlyings.flatMap(row => {
    const raw = Array.isArray(row) ? row : Object.values(row).flatMap(value => Array.isArray(value) ? value : [value])
    return raw.filter((value): value is string => typeof value === 'string' && value.length > 0)
  }))]
  const rows: Array<Record<string, unknown>> = []
  for (const underlying of values.sort()) {
    rows.push(...await fetcher(`/api/v5/public/instruments?instType=OPTION&uly=${encodeURIComponent(underlying)}`))
  }
  return filterIdentifiedInstrumentRows(rows)
}

/**
 * OKX can publish a pre-open FUTURES placeholder whose instId is still empty.
 * It is not an addressable instrument and cannot safely enter the versioned
 * master or any downstream ticker/candle universe. Ignore only those transient
 * placeholder rows; valid pre-open instruments with an instId are preserved.
 */
function filterIdentifiedInstrumentRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.filter(row => typeof row.instId === 'string' && row.instId.trim().length > 0)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  collectOkxInstrumentMaster().then(report => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.status === 'error') process.exitCode = 1
  }).catch(error => { console.error(error); process.exitCode = 1 })
}
