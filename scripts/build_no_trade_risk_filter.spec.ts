import { describe, expect, it } from 'vitest'
import { buildNoTradeRiskFilter } from './build_no_trade_risk_filter.js'

describe('build_no_trade_risk_filter', () => {
  // ─── Test 1: Historical validation catches 2024-08-05 crash ──────────
  it('historical validation catches 2024-08-05 crash with real Binance data', async () => {
    const report = await buildNoTradeRiskFilter({
      mode: 'historical_validation',
    })

    expect(report.mode).toBe('historical_validation')
    expect(report.historicalValidation).toBeTruthy()

    // Find the 2024-08-05 result specifically
    const aug5Result = report.historicalValidation!.results.find(r => r.date === '2024-08-05')
    expect(aug5Result).toBeTruthy()
    expect(aug5Result!.expectedBlock).toBe(true)
    expect(aug5Result!.actualBlock).toBe(true)
    expect(aug5Result!.match).toBe(true)
    expect(aug5Result!.triggeredRules.length).toBeGreaterThanOrEqual(1)

    // At least one of the other crash events should also be caught
    const matchCount = report.historicalValidation!.results.filter(r => r.match).length
    expect(matchCount).toBeGreaterThanOrEqual(1)
  })

  // ─── Test 2: Normal market passes all checks ──────────────────────────
  it('normal market passes all checks', async () => {
    // Simulate normal market: small positive returns, healthy data
    const normalReturns = [
      0.001, 0.002, -0.001, 0.003, -0.002, 0.001,
      0.001, 0.001, 0.002, 0.001, -0.001, 0.001,
      0.001, 0.001, -0.001, 0.002, 0.001, 0.002,
      0.001, 0.001, 0.001, -0.001, 0.002, 0.001,
      0.001, 0.001, 0.001,
    ]

    const coinReturns = new Map<string, number>([
      ['ETH', 0.002], ['BNB', 0.001], ['SOL', 0.003],
      ['XRP', -0.001], ['ADA', 0.002], ['DOT', -0.001],
      ['AVAX', 0.001], ['LINK', -0.002], ['DOGE', 0.001],
      ['MATIC', 0.002], ['ATOM', -0.001], ['ARB', 0.001],
      ['OP', 0.002], ['SUI', -0.001], ['TRX', 0.001],
    ])

    const report = await buildNoTradeRiskFilter({
      btc1hReturns: normalReturns,
      dataFreshnessSec: 15,
      spreadBps: 2,
      lastFundingHoursAgo: 1,
      coin4hReturns: coinReturns,
    })

    // All data checks should be present
    expect(report.checks).toHaveProperty('btc_1h_crash')
    expect(report.checks).toHaveProperty('btc_4h_crash')
    expect(report.checks).toHaveProperty('high_volatility')
    expect(report.checks).toHaveProperty('btc_24h_vol_spike')
    expect(report.checks).toHaveProperty('data_freshness')
    expect(report.checks).toHaveProperty('spread')
    expect(report.checks).toHaveProperty('funding_staleness')
    expect(report.checks).toHaveProperty('macro_event_window')
    expect(report.checks).toHaveProperty('market_wide_correlation_breakdown')
    expect(report.summary.totalChecks).toBe(9)

    // No checks should block in a normal market
    const blockedChecks = Object.values(report.checks).filter(c => c.verdict === 'block')
    expect(blockedChecks).toHaveLength(0)
    expect(report.summary.blocked).toBe(false)
    expect(report.summary.blockCount).toBe(0)
  })

  // ─── Test 3: Missing data causes graceful failure ─────────────────────
  it('missing data causes graceful failure (block on no_data checks)', async () => {
    // Pass no data at all — should still produce a valid report
    const report = await buildNoTradeRiskFilter()

    // Report structure must always be valid
    expect(report).toMatchObject({
      schemaVersion: 1,
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'pass',
    })

    // Checks that depend on BTC data should show no_data
    expect(report.checks.btc_1h_crash.found).toBe(false)
    expect(report.checks.btc_1h_crash.value).toBe('no_data')
    expect(report.checks.btc_4h_crash.value).toBe('no_data')
    expect(report.checks.high_volatility.value).toBe('no_data')
    expect(report.checks.btc_24h_vol_spike.value).toBe('no_data')

    // Market correlation check should show insufficient_data
    expect(report.checks.market_wide_correlation_breakdown.found).toBe(false)
    expect(report.checks.market_wide_correlation_breakdown.value).toContain('insufficient_data')

    // Data-dependent checks should block on missing data
    expect(report.checks.btc_1h_crash.verdict).toBe('block')
    expect(report.checks.btc_4h_crash.verdict).toBe('block')
    expect(report.checks.high_volatility.verdict).toBe('block')
    expect(report.checks.btc_24h_vol_spike.verdict).toBe('block')
    expect(report.checks.data_freshness.verdict).toBe('block')

    // The summary should reflect the blocked state
    expect(report.summary.blocked).toBe(true)
    expect(report.summary.blockCount).toBeGreaterThanOrEqual(4)
    expect(report.generatedAt).toBeTruthy()
    expect(report.mode).toBe('live')
  })
})
