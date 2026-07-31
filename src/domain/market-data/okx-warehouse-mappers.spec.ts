import { describe, expect, it } from 'vitest'
import { mapOkxCandle, mapOkxInstrument, mapOkxTicker } from './okx-warehouse-mappers.js'

describe('OKX warehouse mappers', () => {
  it('maps instrument metadata without private fields', () => {
    const row = mapOkxInstrument({ instId: 'BTC-USDT-SWAP', instType: 'SWAP', instFamily: 'BTC-USDT', tickSz: '0.1', lotSz: '0.01', minSz: '0.01', state: 'live', listTime: '1700000000000' }, '2026-07-18T00:00:00.000Z')
    expect(row).toMatchObject({ exchange: 'okx', instrumentId: 'BTC-USDT-SWAP', instrumentType: 'SWAP', state: 'live' })
    expect(row.availableAt).toBe('2026-07-18T00:00:00.000Z')
  })

  it('maps ticker spread and quote turnover', () => {
    const row = mapOkxTicker({ instId: 'BTC-USDT-SWAP', ts: '1784332800000', last: '100', bidPx: '99', askPx: '101', vol24h: '2', volCcy24h: '200' }, 'SWAP', 'run', '2026-07-18T00:00:01.000Z')
    expect(row.payload).toMatchObject({ last: 100, spread: 2, spreadBps: 200, quoteVolume24h: 200 })
    expect(row.availableAt).not.toBe(row.eventTime)
  })

  it('marks open candles as unconfirmed', () => {
    const row = mapOkxCandle({ raw: ['1784332800000', '1', '2', '0.5', '1.5', '10', '11', '12', '0'], instrumentId: 'BTC-USDT-SWAP', instrumentType: 'SWAP', bar: '5m', collectionRunId: 'run', availableAt: '2026-07-18T00:00:01.000Z' })
    expect(row.confirmed).toBe(false)
    expect(row.dedupKey).toContain('|5m|1784332800000')
  })
})
