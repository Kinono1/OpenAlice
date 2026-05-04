import { describe, expect, it } from 'vitest'
import { mergeLatestRows, parseCSV, rowsToCSV } from './accumulate_1s_data.js'

describe('accumulate_1s_data CSV handling', () => {
  it('parses rows by header name', () => {
    const parsed = parseCSV([
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
      '1777701000000,2026-05-02T05:50:00.000Z,84.1,84.2,84,84.15,123.4,SOL_USDT_USDT,1s,okx',
    ].join('\n'))

    expect(parsed.rows.get(1777701000000)).toEqual({
      timestamp: 1777701000000,
      open: 84.1,
      high: 84.2,
      low: 84,
      close: 84.15,
      volume: 123.4,
    })
  })

  it('drops incoherent legacy rows', () => {
    const parsed = parseCSV([
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
      '1777701000000,2026-05-02T05:50:00.000Z,2026,2026,2026,2026,2026,SOL_USDT_USDT,1s,okx',
      '1777701001000,2026-05-02T05:50:01.000Z,84.1,84.2,84,84.15,123.4,SOL_USDT_USDT,1s,okx',
    ].join('\n'))

    expect(parsed.rows.has(1777701000000)).toBe(false)
    expect(parsed.rows.has(1777701001000)).toBe(true)
  })

  it('replaces overlapping rows', () => {
    const merged = mergeLatestRows(new Map([
      [1777701001000, {
        timestamp: 1777701001000,
        open: 2026,
        high: 2026,
        low: 2026,
        close: 2026,
        volume: 2026,
      }],
    ]), [{
      timestamp: 1777701001000,
      open: 84.1,
      high: 84.2,
      low: 84,
      close: 84.15,
      volume: 123.4,
    }])

    expect(merged.newBars).toBe(0)
    expect(merged.replacedBars).toBe(1)
    expect(merged.rows.get(1777701001000)?.close).toBe(84.15)
  })

  it('writes rows in chronological order', () => {
    const csv = rowsToCSV(
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
      new Map([
        [2, { timestamp: 2, open: 2, high: 3, low: 1, close: 2.5, volume: 10 }],
        [1, { timestamp: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
      ]),
      'BTC_USDT_USDT',
    )

    const rows = csv.split('\n')
    expect(rows[1]?.startsWith('1,')).toBe(true)
    expect(rows[2]?.startsWith('2,')).toBe(true)
  })
})
