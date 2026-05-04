import { describe, expect, it } from 'vitest'
import { checkExchangeRisk, type ExchangeBalance } from './exchange-risk-check.js'

const NOW_MS = Date.UTC(2026, 4, 4, 0, 0, 0)

function balance(overrides: Partial<ExchangeBalance> = {}): ExchangeBalance {
  return {
    exchange: 'binance',
    usdValue: 20_000,
    unrealizedPnl: 500,
    lastWithdrawalMs: NOW_MS - 2 * 3_600_000,
    withdrawalEnabled: true,
    ...overrides,
  }
}

describe('checkExchangeRisk', () => {
  it('passes diversified exchange balances without stale settlement recommendations', () => {
    const result = checkExchangeRisk([
      balance({ exchange: 'binance', usdValue: 25_000 }),
      balance({ exchange: 'okx', usdValue: 20_000 }),
    ], 100_000, { nowMs: NOW_MS })

    expect(result.passed).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.recommendations).toEqual([])
  })

  it('fails when a single exchange exceeds the capital fraction limit', () => {
    const result = checkExchangeRisk([
      balance({ exchange: 'binance', usdValue: 45_000 }),
    ], 100_000, { nowMs: NOW_MS })

    expect(result.passed).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({
      exchange: 'binance',
      rule: 'max_single_exchange_fraction',
      severity: 'warning',
    }))
    expect(result.recommendations.join('\n')).toContain('Reduce binance exposure')
  })

  it('normalizes blocked exchange names case-insensitively', () => {
    const result = checkExchangeRisk([
      balance({ exchange: 'Binance', usdValue: 10_000 }),
    ], 100_000, {
      nowMs: NOW_MS,
      blockedExchanges: new Set(['BINANCE']),
    })

    expect(result.passed).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({
      exchange: 'Binance',
      rule: 'blocked_exchange',
      severity: 'critical',
    }))
  })

  it('reports stale withdrawal recommendations without turning them into violations', () => {
    const result = checkExchangeRisk([
      balance({
        exchange: 'okx',
        usdValue: 150_000,
        lastWithdrawalMs: NOW_MS - 30 * 3_600_000,
      }),
    ], 1_000_000, { nowMs: NOW_MS })

    expect(result.violations).toEqual([])
    expect(result.recommendations.join('\n')).toContain('Auto-settle recommended')
  })

  it('fails closed on invalid balances', () => {
    const result = checkExchangeRisk([
      balance({ exchange: 'bad-data', usdValue: Number.NaN }),
    ], 100_000, { nowMs: NOW_MS })

    expect(result.passed).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({
      exchange: 'bad-data',
      rule: 'invalid_exchange_balance',
      severity: 'critical',
    }))
  })
})
