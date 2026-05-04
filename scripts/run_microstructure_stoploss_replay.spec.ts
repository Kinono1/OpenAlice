import { describe, expect, it } from 'vitest'
import {
  buildMicrostructureStoplossReplayReport,
  parseMicrostructureStoplossReplayArgs,
  renderMicrostructureStoplossReplayMarkdown,
  type ReplayVariantName,
} from './run_microstructure_stoploss_replay.js'
import type { NormalizedPaperTrade } from './analyze_paper_pnl.js'

describe('run_microstructure_stoploss_replay', () => {
  it('reports improvement when the max-loss 100x stop-loss cluster is disabled or leverage-capped', () => {
    const trades: NormalizedPaperTrade[] = [
      makeTrade({ tradeId: 'sl-1', symbol: 'DOGE-USDT', pnlPct: -8, closeReason: 'stop_loss' }),
      makeTrade({ tradeId: 'sl-2', symbol: 'DOGE-USDT', pnlPct: -6, closeReason: 'stop_loss' }),
      makeTrade({ tradeId: 'sl-3', symbol: 'DOGE-USDT', pnlPct: -4, closeReason: 'stop_loss' }),
      makeTrade({ tradeId: 'win-1', symbol: 'BTC-USDT', pnlPct: 3, closeReason: 'take_profit' }),
      makeTrade({ tradeId: 'hold-1', symbol: 'ETH-USDT', pnlPct: 1, closeReason: 'holding_expired' }),
      makeTrade({
        tradeId: 'ignored-10x',
        lane: 'microstructure_10x',
        leverage: 10,
        symbol: 'SOL-USDT',
        pnlPct: -50,
        closeReason: 'stop_loss',
      }),
    ]

    const report = buildMicrostructureStoplossReplayReport({
      paperDir: '/repo/data/paper_trading',
      outputPath: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
      closedTradesLoaded: trades.length,
      trades,
    })

    const baseline = variant(report, 'baseline')
    const disabled = variant(report, 'disable_100x')
    const cap25 = variant(report, 'cap_leverage_25x')
    const cap10 = variant(report, 'cap_leverage_10x')
    const widened = variant(report, 'stress_stop_loss_loss_1_5x')

    expect(report.coverage.closedTradesLoaded).toBe(6)
    expect(report.coverage.microstructure100xClosedTrades).toBe(5)
    expect(report.scope).toBe('microstructure_100x_lane_only')
    expect(report.metricBasis).toBe('price_return_pct')
    expect(report.clusterDiagnostics.every(cluster =>
      cluster.diagnosticUse === 'closed_row_cluster_replay' &&
      cluster.promotionEligible === false &&
      cluster.policyMutationAllowed === false,
    )).toBe(true)
    expect(baseline.metrics).toMatchObject({
      metricBasis: 'price_return_pct',
      trades: 5,
      sumPriceReturnPct: -14,
      totalPnlPct: -14,
      stopLossCount: 3,
      maxLossPct: -8,
    })
    expect(baseline.metrics.PF).toBeCloseTo(4 / 18, 6)
    expect(baseline.metrics.stopLossNegativePriceReturnSharePct).toBe(100)

    expect(disabled.metrics).toMatchObject({
      trades: 0,
      sumPriceReturnPct: 0,
      totalPnlPct: 0,
      winRate: null,
      stopLossCount: 0,
      maxLossPct: 0,
    })
    expect(disabled.deltaVsBaseline.totalPnlPct).toBe(14)
    expect(disabled.deltaVsBaseline.sumPriceReturnPct).toBe(14)
    expect(disabled.deltaVsBaseline.removedLaneContributionPct).toBe(14)
    expect(disabled.deltaVsBaseline.winRate).toBeNull()
    expect(disabled.deltaVsBaseline.stopLossNegativePriceReturnSharePct).toBeNull()
    expect(disabled.deltaVsBaseline.maxLossPct).toBeNull()

    expect(cap25.metrics.sumPriceReturnPct).toBeCloseTo(-3.5, 6)
    expect(cap25.metrics.maxLossPct).toBeCloseTo(-2, 6)
    expect(cap25.metrics.PF).toBeCloseTo(baseline.metrics.PF ?? 0, 6)
    expect(cap25.deltaVsBaseline.sumPriceReturnPct).toBeCloseTo(10.5, 6)
    expect(cap25.deltaVsBaseline.maxLossPct).toBeCloseTo(6, 6)

    expect(cap10.metrics.sumPriceReturnPct).toBeCloseTo(-1.4, 6)
    expect(cap10.metrics.maxLossPct).toBeCloseTo(-0.8, 6)
    expect(cap10.deltaVsBaseline.sumPriceReturnPct).toBeCloseTo(12.6, 6)
    expect(cap10.deltaVsBaseline.maxLossPct).toBeCloseTo(7.2, 6)

    expect(widened.metrics.sumPriceReturnPct).toBe(-23)
    expect(widened.metrics.maxLossPct).toBe(-12)
    expect(widened.assumptions.join(' ')).toContain('no post-stop path')
    expect(report.notes.join(' ')).toContain('Pro review only')
    expect(report.notes.join(' ')).toContain('clusterDiagnostics')
  })

  it('adds deterministic closed-row cluster diagnostics without changing the global scope', () => {
    const trades: NormalizedPaperTrade[] = [
      makeTrade({ tradeId: 'doge-long-sl', symbol: 'DOGE-USDT', side: 'long', pnlPct: -8, closeReason: 'stop_loss' }),
      makeTrade({ tradeId: 'doge-long-win', symbol: 'DOGE-USDT', side: 'long', pnlPct: 2, closeReason: 'take_profit' }),
      makeTrade({ tradeId: 'doge-short-sl', symbol: 'DOGE-USDT', side: 'short', pnlPct: -4, closeReason: 'stop_loss' }),
      makeTrade({ tradeId: 'btc-long-win', symbol: 'BTC-USDT', side: 'long', pnlPct: 3, closeReason: 'take_profit' }),
      makeTrade({
        tradeId: 'ignored-10x',
        lane: 'microstructure_10x',
        leverage: 10,
        symbol: 'DOGE-USDT',
        side: 'long',
        pnlPct: -100,
        closeReason: 'stop_loss',
      }),
    ]

    const report = buildMicrostructureStoplossReplayReport({
      paperDir: '/repo/data/paper_trading',
      outputPath: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
      closedTradesLoaded: trades.length,
      trades,
    })

    expect(report.scope).toBe('microstructure_100x_lane_only')
    expect(report.coverage.microstructure100xClosedTrades).toBe(4)
    expect(report.variants.find(item => item.name === 'baseline')?.metrics.sumPriceReturnPct).toBe(-7)

    const keys = report.clusterDiagnostics.map(cluster => `${cluster.dimension}:${cluster.key}`)
    expect(keys).toEqual([
      'lane:microstructure_100x',
      'symbol:BTC-USDT',
      'symbol:DOGE-USDT',
      'side:long',
      'side:short',
      'lane_symbol:microstructure_100x|BTC-USDT',
      'lane_symbol:microstructure_100x|DOGE-USDT',
      'lane_side:microstructure_100x|long',
      'lane_side:microstructure_100x|short',
      'symbol_side:BTC-USDT|long',
      'symbol_side:DOGE-USDT|long',
      'symbol_side:DOGE-USDT|short',
      'lane_symbol_side:microstructure_100x|BTC-USDT|long',
      'lane_symbol_side:microstructure_100x|DOGE-USDT|long',
      'lane_symbol_side:microstructure_100x|DOGE-USDT|short',
    ])

    const dogeLong = cluster(report, 'lane_symbol_side', 'microstructure_100x|DOGE-USDT|long')
    expect(dogeLong).toMatchObject({
      diagnosticUse: 'closed_row_cluster_replay',
      promotionEligible: false,
      policyMutationAllowed: false,
      lane: 'microstructure_100x',
      symbol: 'DOGE-USDT',
      side: 'long',
      coverage: {
        closedTrades: 2,
        stopLossTrades: 1,
        earliestCloseTs: '2026-05-01T00:01:00.000Z',
        latestCloseTs: '2026-05-01T00:01:00.000Z',
      },
    })
    expect(clusterVariant(dogeLong, 'baseline').metrics.sumPriceReturnPct).toBe(-6)
    expect(clusterVariant(dogeLong, 'cap_leverage_25x').metrics.sumPriceReturnPct).toBeCloseTo(-1.5, 6)
    expect(clusterVariant(dogeLong, 'cap_leverage_25x').deltaVsBaseline.sumPriceReturnPct).toBeCloseTo(4.5, 6)
    expect(clusterVariant(dogeLong, 'stress_stop_loss_loss_1_5x').metrics.sumPriceReturnPct).toBe(-10)

    const dogeSymbol = cluster(report, 'symbol', 'DOGE-USDT')
    expect(dogeSymbol.coverage).toMatchObject({
      closedTrades: 3,
      stopLossTrades: 2,
    })
    expect(dogeSymbol.variants.every(item => !('trades' in item))).toBe(true)
  })

  it('renders markdown and keeps the stop stress diagnostic assumption visible', () => {
    const report = buildMicrostructureStoplossReplayReport({
      paperDir: '/repo/data/paper_trading',
      trades: [
        makeTrade({ tradeId: 'sl-1', pnlPct: -1, closeReason: 'stop_loss' }),
      ],
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    const markdown = renderMicrostructureStoplossReplayMarkdown(report)

    expect(markdown).toContain('# Microstructure 100x Stop-Loss Replay')
    expect(markdown).toContain('stress_stop_loss_loss_1_5x')
    expect(markdown).toContain('Metric basis: `price_return_pct`')
    expect(markdown).toContain('paper-only retrospective')
    expect(markdown).toContain('microstructure_100x closed trades: 1')
    expect(markdown).toContain('## Cluster Diagnostics')
    expect(markdown).toContain('promotionEligible=false')
  })

  it('parses --json and --outputPath without requiring a default write path', () => {
    expect(parseMicrostructureStoplossReplayArgs([])).toEqual({
      paperDir: 'data/paper_trading',
      outputPath: null,
      lookbackHours: null,
      json: false,
    })
    expect(parseMicrostructureStoplossReplayArgs([
      '--paperDir',
      'tmp/paper',
      '--outputPath',
      'tmp/replay.json',
      '--lookbackHours',
      '12',
      '--json',
    ])).toEqual({
      paperDir: 'tmp/paper',
      outputPath: 'tmp/replay.json',
      lookbackHours: 12,
      json: true,
    })
  })
})

function variant(
  report: ReturnType<typeof buildMicrostructureStoplossReplayReport>,
  name: ReplayVariantName,
) {
  const found = report.variants.find((item) => item.name === name)
  expect(found).toBeDefined()
  return found!
}

function cluster(
  report: ReturnType<typeof buildMicrostructureStoplossReplayReport>,
  dimension: string,
  key: string,
) {
  const found = report.clusterDiagnostics.find((item) => item.dimension === dimension && item.key === key)
  expect(found).toBeDefined()
  return found!
}

function clusterVariant(
  clusterDiagnostic: ReturnType<typeof cluster>,
  name: ReplayVariantName,
) {
  const found = clusterDiagnostic.variants.find((item) => item.name === name)
  expect(found).toBeDefined()
  return found!
}

function makeTrade(overrides: Partial<NormalizedPaperTrade>): NormalizedPaperTrade {
  return {
    tradeId: overrides.tradeId ?? 'trade',
    source: 'test',
    lane: overrides.lane ?? 'microstructure_100x',
    accountId: 'liquidation_probe_100x',
    accountLabel: 'Liquidation probe 100x',
    symbol: overrides.symbol ?? 'DOGE-USDT',
    side: overrides.side ?? 'long',
    leverage: overrides.leverage ?? 100,
    openTs: overrides.openTs ?? '2026-05-01T00:00:00.000Z',
    closeTs: overrides.closeTs ?? '2026-05-01T00:01:00.000Z',
    openPrice: overrides.openPrice ?? 1,
    closePrice: overrides.closePrice ?? 0.99,
    pnlPct: overrides.pnlPct ?? 0,
    pnlUsd: overrides.pnlUsd ?? null,
    closeReason: overrides.closeReason ?? 'holding_expired',
    rawReason: overrides.rawReason ?? overrides.closeReason ?? null,
    holdingSeconds: overrides.holdingSeconds ?? 60,
    closeHourUtc: overrides.closeHourUtc ?? 0,
    priceSource: overrides.priceSource ?? '1s',
    priceStale: overrides.priceStale ?? false,
    volumeRatioAtOpen: overrides.volumeRatioAtOpen ?? null,
    breakQualityAtOpen: overrides.breakQualityAtOpen ?? null,
    liquidityStatusAtOpen: overrides.liquidityStatusAtOpen ?? null,
    spreadStatusAtOpen: overrides.spreadStatusAtOpen ?? null,
    spreadBpsAtOpen: overrides.spreadBpsAtOpen ?? null,
    contextGenerationAtOpen: overrides.contextGenerationAtOpen ?? 1,
    flashConfidenceLowAtOpen: overrides.flashConfidenceLowAtOpen ?? null,
    ruleScoreAtOpen: overrides.ruleScoreAtOpen ?? null,
    proEpochAtOpen: overrides.proEpochAtOpen ?? null,
    marketIntelTriggerAtOpen: overrides.marketIntelTriggerAtOpen ?? null,
    contextCoverageBucket: overrides.contextCoverageBucket ?? 'ok',
    liquidated: overrides.liquidated ?? false,
  }
}
