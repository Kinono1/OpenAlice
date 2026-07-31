import { describe, expect, it } from 'vitest'
import {
  buildLiquidityConditionedFactorReport,
  parseLiquidityConditionedFactorArgs,
} from './build_liquidity_conditioned_factor_report.js'

function syntheticLiquidityAssets() {
  const length = 420
  return Array.from({ length: 9 }, (_, assetIndex) => {
    const symbol = `${String.fromCharCode(65 + assetIndex)}-USDT`
    const isHighLiquidity = assetIndex >= 6
    const isLowLiquidity = assetIndex <= 2
    const candles = Array.from({ length }, (_, index) => {
      const cycle = Math.floor(index / 24) % 2
      const laggedTrend = isHighLiquidity
        ? assetIndex * cycle * 0.55
        : isLowLiquidity
          ? (8 - assetIndex) * cycle * 0.45
          : assetIndex * cycle * 0.08
      return {
        time: 1_700_000_000_000 + index * 3_600_000,
        close: 100 + index * 0.02 + laggedTrend,
        volume: isHighLiquidity
          ? 10_000_000 + assetIndex * 1_000_000
          : isLowLiquidity
            ? 100_000 + assetIndex * 10_000
            : 1_000_000 + assetIndex * 100_000,
      }
    })
    return { symbol, candles }
  })
}

describe('build_liquidity_conditioned_factor_report', () => {
  it('parses research-only CLI defaults and custom bucket inputs', () => {
    expect(parseLiquidityConditionedFactorArgs([
      '--dataDir',
      'tmp/live',
      '--output',
      'null',
      '--symbols',
      'BTC-USDT,ETH-USDT',
      '--lookbacks',
      '24,72',
      '--forwards',
      '24',
      '--buckets',
      'high,low',
      '--routeCostPct',
      '0.42',
      '--maxRows',
      '1000',
      '--json',
      'true',
    ])).toMatchObject({
      dataDir: 'tmp/live',
      outputPath: null,
      feeSnapshotPath: 'data/runtime/fee_snapshot.latest.json',
      symbols: ['BTC-USDT', 'ETH-USDT'],
      lookbackHours: [24, 72],
      forwardHours: [24],
      liquidityBuckets: ['high', 'low'],
      routeCostPct: 0.42,
      maxRows: 1000,
      json: true,
    })
  })

  it('emits a research-only liquidity conditioned report and never authorizes execution', () => {
    const report = buildLiquidityConditionedFactorReport({
      assets: syntheticLiquidityAssets(),
      generatedAt: '2026-05-05T00:00:00.000Z',
      args: {
        dataDir: '/repo/data/market/live_accumulated',
        outputPath: null,
        feeSnapshotPath: '/repo/data/runtime/fee_snapshot.latest.json',
        symbols: ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT', 'G-USDT', 'H-USDT', 'I-USDT'],
        lookbackHours: [24],
        forwardHours: [24],
        liquidityBuckets: ['all', 'low', 'high'],
        routeCostPct: 0.01,
        minUniverseSize: 6,
        minBucketAssets: 3,
        topBottomFraction: 0.34,
        barMinutes: 60,
        maxRows: null,
        json: true,
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-05T00:00:00.000Z',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      symbolsLoaded: ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT', 'G-USDT', 'H-USDT', 'I-USDT'],
      dataCadence: {
        barMinutes: 60,
        promotionTimeframe: '1h_required',
        nonHourlyDiagnosticOnly: false,
      },
      routeCost: {
        source: 'manual_diagnostic_override',
        runtimeVerified: false,
        pairRoundTripCostPct: 0.01,
      },
    })
    expect(report.configsEvaluated).toBe(6)
    expect(report.topConfigs.length).toBeGreaterThan(0)
    expect(report.bucketSummaries.map(summary => summary.bucket)).toEqual(['all', 'low', 'high'])
    expect(report.best).toMatchObject({
      configId: expect.any(String),
      liquidityBucket: expect.any(String),
      factor: expect.any(String),
      wfo: {
        windowCount: expect.any(Number),
        failWindowRatioThreshold: 0.3,
        minWindows: 3,
        windows: expect.any(Array),
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'research_only_not_execution_evidence',
      'route_cost_manual_not_runtime_verified',
      'runtime_fee_not_verified',
      'not_trial_ledger_fdr_validated',
      'not_pit_audit_validated',
      'not_paper_execution_evidence',
      'paper_live_execution_disabled',
    ]))
  })

  it('keeps non-hourly experiments diagnostic-only', () => {
    const report = buildLiquidityConditionedFactorReport({
      assets: syntheticLiquidityAssets(),
      generatedAt: '2026-05-05T00:00:00.000Z',
      args: {
        dataDir: '/repo/data/market/live_5m',
        outputPath: null,
        feeSnapshotPath: '/repo/data/runtime/fee_snapshot.latest.json',
        symbols: ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT', 'G-USDT', 'H-USDT', 'I-USDT'],
        lookbackHours: [6],
        forwardHours: [6],
        liquidityBuckets: ['high'],
        routeCostPct: 0.01,
        minUniverseSize: 6,
        minBucketAssets: 3,
        topBottomFraction: 0.34,
        barMinutes: 5,
        maxRows: null,
        json: true,
      },
    })

    expect(report.dataCadence.nonHourlyDiagnosticOnly).toBe(true)
    expect(report.blockers).toEqual(expect.arrayContaining([
      'non_hourly_liquidity_conditioned_research_only',
      'research_only_not_execution_evidence',
    ]))
  })

  it('marks route cost runtime-verified when an API fee snapshot is fresh', () => {
    const report = buildLiquidityConditionedFactorReport({
      assets: syntheticLiquidityAssets(),
      generatedAt: '2026-05-05T00:00:00.000Z',
      feeSnapshotPath: '/repo/data/runtime/fee_snapshot.latest.json',
      feeSnapshot: {
        source: 'api',
        verifiedByRuntime: true,
        makerFeeBps: 2,
        takerFeeBps: 5,
        sourceFetchedAt: '2026-05-04T23:00:00.000Z',
        expiresAt: '2026-05-06T00:00:00.000Z',
      },
      args: {
        dataDir: '/repo/data/market/live_accumulated',
        outputPath: null,
        feeSnapshotPath: '/repo/data/runtime/fee_snapshot.latest.json',
        symbols: ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT', 'G-USDT', 'H-USDT', 'I-USDT'],
        lookbackHours: [24],
        forwardHours: [24],
        liquidityBuckets: ['all', 'low', 'high'],
        routeCostPct: 0.36,
        minUniverseSize: 6,
        minBucketAssets: 3,
        topBottomFraction: 0.34,
        barMinutes: 60,
        maxRows: null,
        json: true,
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

  it('rejects unsupported bucket names', () => {
    expect(() => parseLiquidityConditionedFactorArgs(['--buckets', 'high,tiny'])).toThrow(
      /Unsupported liquidity bucket/,
    )
  })
})
