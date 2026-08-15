import { describe, expect, it } from 'vitest'
import {
  parseBackfill1hArgs,
  sortCandlesChronologically,
} from './backfill_1h_live_data.js'

describe('backfill_1h_live_data', () => {
  it('parses safe explicit backfill defaults', () => {
    expect(parseBackfill1hArgs([])).toEqual({
      outputDir: 'data/market/live_accumulated',
      symbols: [],
      maxCandles: 1500,
      dryRun: false,
    })
    expect(parseBackfill1hArgs([
      '--dataDir',
      'tmp/live',
      '--symbols',
      'BTC-USDT,ETH',
      '--maxCandles',
      '1200',
      '--dryRun',
      'true',
    ])).toEqual({
      outputDir: 'tmp/live',
      symbols: ['BTC-USDT', 'ETH'],
      maxCandles: 1200,
      dryRun: true,
    })
  })

  it('deduplicates and writes candles oldest first', () => {
    expect(sortCandlesChronologically([
      { timestamp: 3, open: 3, high: 3, low: 3, close: 3, volume: 3 },
      { timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { timestamp: 3, open: 30, high: 30, low: 30, close: 30, volume: 30 },
      { timestamp: 2, open: 2, high: 2, low: 2, close: 2, volume: 2 },
    ])).toEqual([
      { timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { timestamp: 2, open: 2, high: 2, low: 2, close: 2, volume: 2 },
      { timestamp: 3, open: 30, high: 30, low: 30, close: 30, volume: 30 },
    ])
  })
})
