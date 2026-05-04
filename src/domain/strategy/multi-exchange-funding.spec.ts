import { describe, expect, it } from 'vitest'
import {
  aggregateExchangeFundingStats,
  detectFundingSpreadOpportunities,
  type ExchangeFundingRate,
} from './multi-exchange-funding.js'

const NOW_MS = Date.UTC(2026, 4, 4, 0, 0, 0)

function rate(
  exchange: ExchangeFundingRate['exchange'],
  fundingRate: number,
  overrides: Partial<ExchangeFundingRate> = {},
): ExchangeFundingRate {
  return {
    exchange,
    symbol: 'BTC-USDT',
    fundingRate,
    nextFundingTime: NOW_MS + 3_600_000,
    markPrice: 60_000,
    indexPrice: 60_010,
    timestamp: NOW_MS - 60_000,
    ...overrides,
  }
}

describe('multi-exchange funding helpers', () => {
  it('detects cross-exchange spreads only after round-trip costs', () => {
    const opportunities = detectFundingSpreadOpportunities([
      rate('binance', 0.0012),
      rate('okx', 0.0002),
    ], {
      nowMs: NOW_MS,
      symbols: ['BTC-USDT'],
      roundTripCostBps: 5,
      minSpreadAnnualized: 0.05,
    })

    expect(opportunities).toHaveLength(1)
    expect(opportunities[0]).toMatchObject({
      symbol: 'BTC-USDT',
      longExchange: 'okx',
      shortExchange: 'binance',
    })
    expect(opportunities[0].netAfterFeesAnnualized).toBeCloseTo(0.5475)
  })

  it('skips opportunities too close to funding settlement', () => {
    expect(detectFundingSpreadOpportunities([
      rate('binance', 0.0012, { nextFundingTime: NOW_MS + 120_000 }),
      rate('okx', 0.0002, { nextFundingTime: NOW_MS + 120_000 }),
    ], {
      nowMs: NOW_MS,
      symbols: ['BTC-USDT'],
      minTimeToSettlementMs: 600_000,
    })).toEqual([])
  })

  it('aggregates only usable funding rows', () => {
    const stats = aggregateExchangeFundingStats([
      rate('binance', 0.001),
      rate('okx', -0.0005),
      rate('bybit', Number.NaN),
    ])

    expect(stats.get('BTC-USDT')).toEqual({
      min: -0.0005,
      max: 0.001,
      mean: 0.00025,
      spread: 0.0015,
      count: 2,
    })
  })
})
