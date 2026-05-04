import { describe, expect, it } from 'vitest'
import { mergeLatestRows, parseCSV, rowsToCSV } from './accumulate_5m_data.js'

describe('accumulate_5m_data CSV handling', () => {
  it('parses rows by header name instead of fixed offsets', () => {
    const parsed = parseCSV([
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
      '1777701000000,2026-05-02T05:50:00.000Z,0.1784,0.179,0.1779,0.1787,123.4,JUP_USDT_USDT,5m,okx',
    ].join('\n'))

    expect(parsed.rows.get(1777701000000)).toEqual({
      timestamp: 1777701000000,
      open: 0.1784,
      high: 0.179,
      low: 0.1779,
      close: 0.1787,
      volume: 123.4,
    })
  })

  it('drops header-shifted placeholder rows while parsing existing CSV', () => {
    const parsed = parseCSV([
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
      '1777701000000,2026-05-02T05:50:00.000Z,2026,2026,2026,2026,2026,JUP_USDT_USDT,5m,okx',
      '1777701300000,2026-05-02T05:55:00.000Z,0.1784,0.179,0.1779,0.1787,123.4,JUP_USDT_USDT,5m,okx',
    ].join('\n'))

    expect(parsed.rows.has(1777701000000)).toBe(false)
    expect(parsed.rows.has(1777701300000)).toBe(true)
  })

  it('refreshes overlapping rows so newly fetched data repairs corrupt candles', () => {
    const existing = new Map([
      [1777701300000, {
        timestamp: 1777701300000,
        open: 2026,
        high: 2026,
        low: 2026,
        close: 2026,
        volume: 2026,
      }],
    ])

    const merged = mergeLatestRows(existing, [{
      timestamp: 1777701300000,
      open: 0.1784,
      high: 0.179,
      low: 0.1779,
      close: 0.1787,
      volume: 123.4,
    }])

    expect(merged.newBars).toBe(0)
    expect(merged.replacedBars).toBe(1)
    expect(merged.rows.get(1777701300000)?.open).toBe(0.1784)
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
