import { describe, expect, it } from 'vitest'
import { alignPairCandles, buildRelativeValueCandles } from './pair_market_data.ts'

describe('pair_market_data', () => {
  it('aligns candles by shared timestamp', () => {
    const leader = [
      { symbol: 'ETH', time: 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
      { symbol: 'ETH', time: 2, open: 11, high: 12, low: 10, close: 11.5, volume: 110 },
    ]
    const hedge = [
      { symbol: 'BTC', time: 2, open: 20, high: 21, low: 19, close: 20.5, volume: 200 },
      { symbol: 'BTC', time: 3, open: 21, high: 22, low: 20, close: 21.5, volume: 210 },
    ]

    const aligned = alignPairCandles(leader, hedge)
    expect(aligned).toHaveLength(1)
    expect(aligned[0]?.leader.time).toBe(2)
    expect(aligned[0]?.hedge.time).toBe(2)
  })

  it('builds a ratio candle stream from aligned leader and hedge data', () => {
    const candles = buildRelativeValueCandles({
      symbol: 'ETH/BTC_RV',
      leader: [
        { symbol: 'ETH', time: 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
      ],
      hedge: [
        { symbol: 'BTC', time: 1, open: 20, high: 22, low: 19, close: 21, volume: 200 },
      ],
    })

    expect(candles).toHaveLength(1)
    expect(candles[0]?.symbol).toBe('ETH/BTC_RV')
    expect(candles[0]?.open).toBeCloseTo(0.5, 10)
    expect(candles[0]?.high).toBeCloseTo(11 / 19, 10)
    expect(candles[0]?.low).toBeCloseTo(9 / 22, 10)
    expect(candles[0]?.close).toBeCloseTo(0.5, 10)
    expect(candles[0]?.volume).toBe(100)
  })
})
