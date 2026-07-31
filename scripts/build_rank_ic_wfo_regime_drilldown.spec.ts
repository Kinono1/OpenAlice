import { describe, expect, it } from 'vitest'
import {
  buildRankIcWfoRegimeDrilldownReport,
  parseRankIcWfoRegimeDrilldownArgs,
  type WfoDrilldownAssetSeries,
} from './build_rank_ic_wfo_regime_drilldown.js'

function makeAsset(symbol: string, closes: number[]): WfoDrilldownAssetSeries {
  return {
    symbol,
    candles: closes.map((close, index) => ({
      time: Date.parse('2026-01-01T00:00:00.000Z') + index * 3_600_000,
      close,
      volume: 100 + index,
    })),
  }
}

describe('build_rank_ic_wfo_regime_drilldown', () => {
  it('parses research-only drilldown defaults', () => {
    expect(parseRankIcWfoRegimeDrilldownArgs([])).toEqual({
      rankIcReportPath: 'data/research/cross_sectional_rank_ic.live_accumulated_fwd72.latest.json',
      dataDir: 'data/market/live_accumulated',
      outputPath: 'data/research/rank_ic_wfo_regime_drilldown.latest.json',
      symbols: [],
      barMinutes: null,
      maxRows: null,
      json: false,
    })
  })

  it('explains negative-direction and positive-spread unstable WFO failures without granting promotion', () => {
    const assets = [
      makeAsset('BTC-USDT', [100, 101, 102, 103, 104, 105]),
      makeAsset('ETH-USDT', [100, 98, 97, 100, 102, 103]),
      makeAsset('SOL-USDT', [100, 92, 88, 90, 91, 93]),
    ]
    const report = buildRankIcWfoRegimeDrilldownReport({
      rankIcReportPath: '/tmp/rank_ic.json',
      dataDir: '/tmp/live',
      barMinutes: 60,
      assets,
      generatedAt: '2026-01-02T00:00:00.000Z',
      rankIcReport: {
        commonPeriods: 6,
        symbolsLoaded: assets.map(asset => asset.symbol),
        dataCadence: { barMinutes: 60 },
        best: {
          factor: 'signal_confidence',
          lookbackHours: 120,
          secondaryLookbackHours: 336,
          forwardHours: 72,
          mtfWeight: 0.5,
        },
        wfo: {
          status: 'fail',
          blockers: ['wfo_failed_window_ratio:1>0.3'],
          windows: [
            {
              windowIndex: 0,
              startIndex: 0,
              endIndexExclusive: 3,
              observations: 30,
              periods: 3,
              signalPeriods: 3,
              meanIc: -0.08,
              icIr: -0.4,
              winRate: 0.2,
              averageLongShortSpreadPct: -1.2,
              longShortWinRate: 0.33,
              passed: false,
            },
            {
              windowIndex: 1,
              startIndex: 3,
              endIndexExclusive: 6,
              observations: 30,
              periods: 3,
              signalPeriods: 3,
              meanIc: 0.04,
              icIr: 0.2,
              winRate: 0.67,
              averageLongShortSpreadPct: 0.8,
              longShortWinRate: 0.67,
              passed: false,
            },
          ],
        },
      },
    })

    expect(report.researchOnly).toBe(true)
    expect(report.promotionEligible).toBe(false)
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.dataAlignment).toMatchObject({
      rankIcCommonPeriods: 6,
      loadedCommonPeriods: 6,
      alignmentStatus: 'aligned',
      blockers: [],
    })
    expect(report.summary).toMatchObject({
      windowCount: 2,
      passedWindows: 0,
      failedWindows: 2,
      negativeDirectionWindows: 1,
      weakIcIrWindows: 2,
      negativeSpreadWindows: 1,
      positiveSpreadButFailedWindows: 1,
    })
    expect(report.windows.map(window => window.windowIndex)).toEqual([0, 1])
    expect(report.summary.latestWindow?.windowIndex).toBe(1)
    expect(report.windows[0].failureTags).toEqual(expect.arrayContaining([
      'negative_direction',
      'negative_long_short_spread',
    ]))
    expect(report.windows[1].failureTags).toContain('weak_ic_ir')
    expect(report.windows[1].failureTags).not.toContain('negative_long_short_spread')
    expect(report.blockers).toEqual(expect.arrayContaining([
      'research_only_not_promotion_evidence',
      'rank_ic_wfo_failed_windows:2',
    ]))
    expect(report.nextActions.join(' ')).toContain('Keep paper/live blocked')
  })
})
