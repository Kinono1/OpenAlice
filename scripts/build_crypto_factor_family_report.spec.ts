import { describe, expect, it } from 'vitest'
import {
  buildCryptoFactorFamilyReport,
  parseCryptoFactorFamilyArgs,
} from './build_crypto_factor_family_report.js'

function makeAsset(symbol: string, closes: number[], volumeBase = 1_000) {
  return {
    symbol,
    candles: closes.map((close, index) => ({
      time: Date.parse('2026-01-01T00:00:00.000Z') + index * 3_600_000,
      close,
      volume: volumeBase + index,
    })),
  }
}

function trendSeries(start: number, steps: number[]): number[] {
  const out = [start]
  for (const step of steps) out.push(Math.max(1, out[out.length - 1] + step))
  return out
}

describe('build_crypto_factor_family_report', () => {
  it('parses research-only defaults', () => {
    expect(parseCryptoFactorFamilyArgs([])).toEqual({
      dataDir: 'data/market/live_accumulated',
      outputPath: 'data/research/crypto_factor_family.live_accumulated.latest.json',
      feeSnapshotPath: 'data/runtime/fee_snapshot.latest.json',
      symbols: [],
      lookbackHours: [24, 72, 168, 336],
      forwardHours: [24, 48, 72],
      barMinutes: 60,
      maxRows: null,
      routeCostPct: 0.36,
      minUniverseSize: 20,
      topBottomFraction: 0.25,
      json: false,
    })
  })

  it('evaluates base factor families while keeping execution disabled', () => {
    const stepsA = [
      ...Array(12).fill(1.5),
      ...Array(12).fill(1.2),
      ...Array(12).fill(1.0),
      ...Array(12).fill(0.8),
    ]
    const stepsB = [
      ...Array(12).fill(1.1),
      ...Array(12).fill(1.0),
      ...Array(12).fill(0.9),
      ...Array(12).fill(0.7),
    ]
    const stepsC = [
      ...Array(12).fill(0.7),
      ...Array(12).fill(0.8),
      ...Array(12).fill(0.9),
      ...Array(12).fill(1.0),
    ]
    const stepsD = [
      ...Array(12).fill(0.2),
      ...Array(12).fill(0.3),
      ...Array(12).fill(0.4),
      ...Array(12).fill(0.5),
    ]
    const assets = [
      makeAsset('BTC-USDT', trendSeries(100, stepsA), 10_000),
      makeAsset('ETH-USDT', trendSeries(100, stepsB), 8_000),
      makeAsset('SOL-USDT', trendSeries(100, stepsC), 5_000),
      makeAsset('BNB-USDT', trendSeries(100, stepsD), 4_000),
    ]

    const report = buildCryptoFactorFamilyReport({
      assets,
      generatedAt: '2026-01-02T00:00:00.000Z',
      args: {
        dataDir: '/tmp/live',
        outputPath: null,
        feeSnapshotPath: '/tmp/fee.json',
        symbols: assets.map(asset => asset.symbol),
        lookbackHours: [6, 12],
        forwardHours: [3],
        barMinutes: 60,
        maxRows: null,
        routeCostPct: 0,
        minUniverseSize: 4,
        topBottomFraction: 0.25,
        json: false,
      },
    })

    expect(report.researchOnly).toBe(true)
    expect(report.promotionEligible).toBe(false)
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.configsEvaluated).toBe(16)
    expect(report.bestByFactor.map(item => item.factor)).toEqual([
      'momentum',
      'reversal',
      'size_small',
      'size_large',
      'liquidity_high',
      'liquidity_low',
      'low_vol',
      'high_vol',
    ])
    expect(report.topConfigs.length).toBeGreaterThan(0)
    expect(report.blockers).toEqual(expect.arrayContaining([
      'research_only_not_execution_evidence',
      'route_cost_manual_not_runtime_verified',
      'runtime_fee_not_verified',
      'paper_live_execution_disabled',
    ]))
    expect(report.notes.join(' ')).toContain('cannot authorize paper or live orders')
    expect(report.nextActions.join(' ')).toContain('Do not enable paper/live')
  })

  it('marks route cost runtime-verified when an API fee snapshot is fresh', () => {
    const steps = [...Array(60).fill(1)]
    const assets = [
      makeAsset('BTC-USDT', trendSeries(100, steps), 10_000),
      makeAsset('ETH-USDT', trendSeries(90, steps.map(step => step * 0.9)), 8_000),
      makeAsset('SOL-USDT', trendSeries(80, steps.map(step => step * 0.8)), 5_000),
      makeAsset('BNB-USDT', trendSeries(70, steps.map(step => step * 0.7)), 4_000),
    ]

    const report = buildCryptoFactorFamilyReport({
      assets,
      generatedAt: '2026-01-02T00:00:00.000Z',
      feeSnapshotPath: '/repo/data/runtime/fee_snapshot.latest.json',
      feeSnapshot: {
        source: 'api',
        verifiedByRuntime: true,
        makerFeeBps: 2,
        takerFeeBps: 5,
        sourceFetchedAt: '2026-01-01T23:00:00.000Z',
        expiresAt: '2026-01-03T00:00:00.000Z',
      },
      args: {
        dataDir: '/tmp/live',
        outputPath: null,
        feeSnapshotPath: '/repo/data/runtime/fee_snapshot.latest.json',
        symbols: assets.map(asset => asset.symbol),
        lookbackHours: [6],
        forwardHours: [3],
        barMinutes: 60,
        maxRows: null,
        routeCostPct: 0.36,
        minUniverseSize: 4,
        topBottomFraction: 0.25,
        json: false,
      },
    })

    expect(report.routeCost).toMatchObject({
      source: 'runtime_verified_route_budget',
      runtimeVerified: true,
      pairRoundTripCostPct: 0.36,
      feeSnapshotPath: '/repo/data/runtime/fee_snapshot.latest.json',
      feeSnapshotSource: 'api',
      makerFeeBps: 2,
      takerFeeBps: 5,
    })
    expect(report.blockers).not.toContain('route_cost_manual_not_runtime_verified')
    expect(report.blockers).not.toContain('runtime_fee_not_verified')
    expect(report.notes.join(' ')).toContain('runtime-verified OKX fee snapshot')
  })
})
