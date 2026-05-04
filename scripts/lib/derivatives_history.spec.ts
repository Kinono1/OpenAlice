import { describe, expect, it } from 'vitest'
import { buildCarryEntryGate, buildCarrySignalSeries } from './derivatives_history.ts'

describe('derivatives_history', () => {
  it('aligns funding histories and computes carry spread', () => {
    const series = buildCarrySignalSeries({
      leaderFunding: [
        { symbol: 'ETH', fundingRate: 0.0002, timestamp: 1000 },
        { symbol: 'ETH', fundingRate: 0.0001, timestamp: 2000 },
      ],
      hedgeFunding: [
        { symbol: 'BTC', fundingRate: 0.00005, timestamp: 1000 },
        { symbol: 'BTC', fundingRate: 0.00002, timestamp: 2000 },
      ],
      leaderOpenInterest: [
        { symbol: 'ETH', openInterest: 10, openInterestValue: 200, timestamp: 1000 },
      ],
      hedgeOpenInterest: [
        { symbol: 'BTC', openInterest: 20, openInterestValue: 100, timestamp: 1000 },
      ],
    })

    expect(series).toHaveLength(2)
    expect(series[0]?.fundingSpread).toBeCloseTo(0.00015, 10)
    expect(series[0]?.observedAt).toBe(1000)
    expect(series[0]?.effectiveAt).toBe(1000)
    expect(series[0]?.openInterestValueRatio).toBeCloseTo(2, 10)
    expect(series[0]?.fundingSpreadZScore).toBe(0)
  })

  it('builds entry times from funding spread and optional OI filter', () => {
    const gate = buildCarryEntryGate({
      minAbsFundingSpread: 0.0001,
      minAbsFundingZScore: 1,
      minOpenInterestRatio: 1.2,
      series: [
        { time: 1, fundingSpread: 0.00005, fundingSpreadZScore: 0.5, openInterestValueRatio: 2 },
        { time: 2, fundingSpread: 0.0002, fundingSpreadZScore: 1.5, openInterestValueRatio: 1.5 },
        { time: 3, fundingSpread: -0.0003, fundingSpreadZScore: 2, openInterestValueRatio: 1.1 },
      ],
    })

    expect(gate).toEqual({
      allowedEntryTimes: [2],
    })
  })
})
