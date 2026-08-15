import { describe, expect, it } from 'vitest'
import { buildOkxMarketEvent } from '../src/domain/market-data/okx-warehouse-mappers.js'
import type { OkxMarketEvent } from '../src/domain/market-data/okx-warehouse-types.js'
import { deriveCanonicalEvents } from './derive_okx_canonical.js'

function candle(minute: number, values: { open: number; high: number; low: number; close: number; volume: number }): OkxMarketEvent {
  const eventTime = new Date(Date.UTC(2026, 6, 18, 0, minute)).toISOString()
  return buildOkxMarketEvent({
    dataset: 'candle', instrumentType: 'SWAP', instrumentId: 'BTC-USDT-SWAP', channel: 'candle5m',
    sourceTransport: 'rest', sourceEndpoint: '/api/v5/market/candles', eventTime,
    availableAt: new Date(Date.parse(eventTime) + 1_000).toISOString(), confirmed: true,
    collectionRunId: 'source', dedupKey: `source-${minute}`,
    payload: { bar: '5m', ...values, confirmed: true },
  })
}

describe('derive_okx_canonical', () => {
  it('derives a closed 15m candle only from a complete contiguous source bucket', () => {
    const rows = [
      candle(0, { open: 100, high: 103, low: 99, close: 102, volume: 2 }),
      candle(5, { open: 102, high: 105, low: 101, close: 104, volume: 3 }),
      candle(10, { open: 104, high: 106, low: 98, close: 101, volume: 5 }),
    ]
    const derived = deriveCanonicalEvents(rows, { generatedAt: '2026-07-18T01:00:00.000Z', collectionRunId: 'derived' })
    const target = derived.find(event => (event.payload as any).bar === '15m')
    expect(target).toMatchObject({
      dataset: 'candle', sourceTransport: 'derived', confirmed: true,
      eventTime: '2026-07-18T00:00:00.000Z',
      payload: { bar: '15m', sourceBar: '5m', open: 100, high: 106, low: 98, close: 101, volume: 10, parentCount: 3 },
    })
    expect(deriveCanonicalEvents(rows.slice(0, 2), { generatedAt: '2026-07-18T01:00:00.000Z', collectionRunId: 'derived' })
      .some(event => (event.payload as any).bar === '15m')).toBe(false)
  })

  it('derives PIT-safe 1s trade bars without filling missing seconds', () => {
    const trades = [
      ['1', '100', '2', 'buy', '2026-07-18T00:00:00.100Z'],
      ['2', '101', '1', 'sell', '2026-07-18T00:00:00.800Z'],
      ['3', '105', '3', 'buy', '2026-07-18T00:00:02.100Z'],
    ].map(([id, px, sz, side, eventTime]) => buildOkxMarketEvent({
      dataset: 'trade', instrumentType: 'SWAP', instrumentId: 'BTC-USDT-SWAP', channel: 'trades-all',
      sourceTransport: 'websocket', sourceEndpoint: 'okx-business-ws/trades-all', eventTime,
      availableAt: new Date(Date.parse(eventTime) + 10).toISOString(), sequenceId: id,
      collectionRunId: 'trades', dedupKey: `trade-${id}`, payload: { tradeId: id, px, sz, side },
    }))
    const derived = deriveCanonicalEvents(trades, { generatedAt: '2026-07-18T00:01:00.000Z', collectionRunId: 'derived', tradeMinAgeMs: 0 })
      .filter(event => (event.payload as any).bar === '1s')
    expect(derived).toHaveLength(2)
    expect(derived[0].payload).toMatchObject({ open: 100, high: 101, low: 100, close: 101, volume: 3, signedVolume: 1, tradeCount: 2 })
    expect(derived.map(event => event.eventTime)).toEqual(['2026-07-18T00:00:00.000Z', '2026-07-18T00:00:02.000Z'])
  })
})
