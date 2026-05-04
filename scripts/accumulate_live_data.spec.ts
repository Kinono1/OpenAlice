import { describe, expect, it } from 'vitest'
import { mergeLatestRows, parseCSV, rowsToCSV } from './accumulate_live_data.js'

describe('accumulate_live_data CSV handling', () => {
  it('parses rows by header name instead of fixed offsets', () => {
    const parsed = parseCSV([
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
      '1777435200000,2026-04-29T04:00:00.000Z,76946.5,76973.6,76843.9,76910.1,123.4,BTC_USDT_USDT,1h,okx',
    ].join('\n'))

    expect(parsed.rows.get(1777435200000)).toEqual({
      timestamp: 1777435200000,
      open: 76946.5,
      high: 76973.6,
      low: 76843.9,
      close: 76910.1,
      volume: 123.4,
    })
  })

  it('drops corrupted header-shifted rows while parsing existing CSV', () => {
    const parsed = parseCSV([
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
      '1776358800000,2026-04-16T17:00:00.000Z,2026,2026,0.09679,0.09782,0.09644,DOGE_USDT_USDT,1h,okx',
      '1777435200000,2026-04-29T04:00:00.000Z,0.1013,0.10156,0.1011,0.1012,123.4,DOGE_USDT_USDT,1h,okx',
    ].join('\n'))

    expect(parsed.rows.has(1776358800000)).toBe(false)
    expect(parsed.rows.has(1777435200000)).toBe(true)
  })

  it('refreshes overlapping live rows to repair previously corrupted candles', () => {
    const existing = new Map([
      [1777435200000, {
        timestamp: 1777435200000,
        open: 2026,
        high: 2026,
        low: 76946.5,
        close: 76973.6,
        volume: 76843.9,
      }],
    ])

    const merged = mergeLatestRows(existing, [{
      timestamp: 1777435200000,
      open: 76946.5,
      high: 76973.6,
      low: 76843.9,
      close: 76910.1,
      volume: 123.4,
    }])

    expect(merged.newBars).toBe(0)
    expect(merged.replacedBars).toBe(1)
    expect(merged.rows.get(1777435200000)?.open).toBe(76946.5)
    expect(merged.rows.get(1777435200000)?.close).toBe(76910.1)
  })

  it('writes rows in chronological order', () => {
    const csv = rowsToCSV(
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
      new Map([
        [2, { timestamp: 2, open: 2, high: 3, low: 1, close: 2.5, volume: 10 }],
        [1, { timestamp: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
      ]),
      'BTC_USDT_USDT',
      'okx',
    )

    const rows = csv.split('\n')
    expect(rows[1]?.startsWith('1,')).toBe(true)
    expect(rows[2]?.startsWith('2,')).toBe(true)
  })
})
