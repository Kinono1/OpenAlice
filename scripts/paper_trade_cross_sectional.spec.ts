import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/runtime/paper_policy_shadow_ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/runtime/paper_policy_shadow_ledger.js')>('../src/runtime/paper_policy_shadow_ledger.js')
  return {
    ...actual,
    appendPaperPolicyShadowOpen: vi.fn(),
  }
})

vi.mock('../src/runtime/paper_trade_result.js', async () => {
  const actual = await vi.importActual<typeof import('../src/runtime/paper_trade_result.js')>('../src/runtime/paper_trade_result.js')
  return {
    ...actual,
    appendPaperTradeResult: vi.fn(),
  }
})

vi.mock('../src/runtime/promotion_v2_artifacts.js', async () => {
  const actual = await vi.importActual<typeof import('../src/runtime/promotion_v2_artifacts.js')>('../src/runtime/promotion_v2_artifacts.js')
  return {
    ...actual,
    tryLoadPromotionReadinessV2: vi.fn(actual.tryLoadPromotionReadinessV2),
    tryLoadValidatedPromotionReadinessV2: vi.fn(actual.tryLoadValidatedPromotionReadinessV2),
  }
})

import {
  applySignalsToPaperAccount,
  assertCompletePredictedOpenEvidenceForTest,
  buildClosedCrossSectionalPaperTradeResult,
  buildPromotionReadiness,
  defaultPaperAccountProfiles,
  mapCrossSectionalCloseReason,
  parsePaperTraderArgs,
  recordRejectedCrossSectionalShadowOpenForTest,
  resolvePromotionReadinessV2ForPaperTrader,
  selectAssetDataForMode,
  type LoadedAssetData,
  type PaperAccount,
} from './paper_trade_cross_sectional.js'
import type { CrossSectionalAsset, CrossSectionalRank } from '../src/domain/strategy/cross-sectional-momentum.js'
import type { CandleDataQualityReport } from '../src/runtime/data_quality_gate.js'
import type { MarketIntelContext } from '../src/runtime/market_intel_context.js'
import { appendPaperPolicyShadowOpen } from '../src/runtime/paper_policy_shadow_ledger.js'
import { appendPaperTradeResult } from '../src/runtime/paper_trade_result.js'
import {
  tryLoadPromotionReadinessV2,
  tryLoadValidatedPromotionReadinessV2,
} from '../src/runtime/promotion_v2_artifacts.js'
import { clearPaperMarkMatchSnapshotCacheForTest } from './lib/paper_mark_match.js'

describe('paper_trade_cross_sectional live shadow gates', () => {
  beforeEach(() => {
    vi.mocked(appendPaperPolicyShadowOpen).mockClear()
    vi.mocked(appendPaperTradeResult).mockClear()
    vi.mocked(tryLoadPromotionReadinessV2).mockClear()
    vi.mocked(tryLoadValidatedPromotionReadinessV2).mockClear()
    process.env.OPENALICE_EXTERNAL_DERIVATIVES_EVENTS_PATH = '/tmp/openalice-cross-sectional-no-mark.jsonl'
    clearPaperMarkMatchSnapshotCacheForTest()
  })

  afterEach(() => {
    delete process.env.OPENALICE_EXTERNAL_DERIVATIVES_EVENTS_PATH
    clearPaperMarkMatchSnapshotCacheForTest()
  })

  it('parses data mode with auto as the safe default', () => {
    expect(parsePaperTraderArgs([]).dataMode).toBe('auto')
    expect(parsePaperTraderArgs([]).dryRun).toBe(true)
    expect(parsePaperTraderArgs(['--dryRun', 'false']).dryRun).toBe(false)
    expect(parsePaperTraderArgs(['--dataMode', 'live_only']).dataMode).toBe('live_only')
    expect(parsePaperTraderArgs(['--dataMode=live_only']).dataMode).toBe('live_only')
    expect(() => parsePaperTraderArgs(['--dataMode', 'live'])).toThrow(/Invalid dataMode/)
  })

  it('parses optional promotion v2 pre-trade gate flags', () => {
    expect(parsePaperTraderArgs([])).toMatchObject({
      requirePromotionV2: false,
      validatePromotionV2Artifacts: false,
      promotionReadinessV2Path: null,
      skipSecondLevel: false,
    })

    expect(parsePaperTraderArgs([
      '--requirePromotionV2',
      'true',
      '--promotionReadinessV2Path',
      'tmp/strategy_promotion.latest.json',
      '--skipSecondLevel',
      'true',
    ])).toMatchObject({
      requirePromotionV2: true,
      validatePromotionV2Artifacts: true,
      promotionReadinessV2Path: 'tmp/strategy_promotion.latest.json',
      skipSecondLevel: true,
    })
  })

  it('forces validated promotion-v2 readiness when paper order gating is required', async () => {
    vi.mocked(tryLoadValidatedPromotionReadinessV2).mockResolvedValueOnce({
      kind: 'loaded',
      path: 'tmp/promotion/strategy_promotion.latest.json',
      readiness: {
        finalVerdict: 'paper_ready',
      } as any,
      validation: {
        hardBlocks: [],
      } as any,
    })

    const loaded = await resolvePromotionReadinessV2ForPaperTrader({
      dataMode: 'live_only',
      requirePromotionV2: true,
      validatePromotionV2Artifacts: false,
      promotionReadinessV2Path: 'tmp/promotion/strategy_promotion.latest.json',
      skipSecondLevel: true,
      allocatorShadow: false,
    }, new Date('2026-05-03T00:00:00.000Z'))

    expect(tryLoadValidatedPromotionReadinessV2).toHaveBeenCalledWith('tmp/promotion', {
      now: new Date('2026-05-03T00:00:00.000Z'),
    })
    expect(tryLoadPromotionReadinessV2).not.toHaveBeenCalled()
    expect(loaded.summary).toMatchObject({
      required: true,
      path: 'tmp/promotion/strategy_promotion.latest.json',
      loadStatus: 'loaded',
      finalVerdict: 'paper_ready',
      validationHardBlocks: [],
    })
  })

  it('blocks live-only mode on insufficient live bars without selecting historical fallback', () => {
    const live = makeAsset('BTC-USDT', 'live_accumulated', 'bad', 300, ['insufficient_bars:300<507'])
    const fallback = makeAsset('BTC-USDT', 'multi_assets', 'good', 700, [])

    const liveOnly = selectAssetDataForMode({
      dataMode: 'live_only',
      symbol: 'BTC-USDT',
      live,
      fallback,
      requiredBars: 507,
    })
    const auto = selectAssetDataForMode({
      dataMode: 'auto',
      symbol: 'BTC-USDT',
      live,
      fallback,
      requiredBars: 507,
    })

    expect(liveOnly.selected?.source).toBe('live_accumulated')
    expect(liveOnly.fallbackUsed).toBe(false)
    expect(liveOnly.blockReason).toBe('live_only_insufficient_bars:BTC-USDT:300<507')
    expect(auto.selected?.source).toBe('multi_assets')
    expect(auto.fallbackUsed).toBe(true)
  })

  it('keeps promotion blocked when gross edge is thin after round-trip costs', () => {
    const account = makeAccount(14, 20)
    const readiness = buildPromotionReadiness({
      dataMode: 'live_only',
      requiredBars: 507,
      selectedDataQuality: [],
      liveDataQuality: Array.from({ length: 6 }, (_, index) => ({
        ...makeQuality(`ASSET-${index}`, 'good', 600, []),
        source: 'live_accumulated',
      })),
      bestConfigEvidence: {
        avgSpreadPct: 0.388,
        winRatePct: 53.46,
        signals: 7925,
        score: 34.54,
        discoveredAt: '2026-04-29T05:32:38.531Z',
        dataRange: { start: '2025-03-08T13:00:00.000Z', end: '2026-04-29T04:00:00.000Z' },
        assetCount: 6,
      },
      estimatedRoundTripCostPct: 0.28,
      account,
      combinedRisk: { hardVeto: false, riskRegime: 'normal' },
    })

    expect(readiness.ready).toBe(false)
    expect(readiness.netEdgePct).toBeCloseTo(0.108)
    expect(readiness.reasons).toContain('net_edge_below_threshold:0.108<0.250')
    expect(readiness.reasons).toContain('gross_to_cost_ratio_below_threshold:1.39<2.00')
  })

  it('defines separate local virtual profiles for baseline, 10x stress, and 100x liquidation diagnostics', () => {
    const profiles = defaultPaperAccountProfiles()

    expect(profiles.map(profile => profile.id)).toEqual([
      'spot_1x',
      'conservative_3x',
      'stress_10x',
      'liquidation_probe_100x',
    ])
    expect(profiles.find(profile => profile.id === 'stress_10x')).toMatchObject({
      leverage: 10,
      mode: 'paper_trade',
      cadence: 'second',
      timeframe: '1s',
      strategyLane: 'microstructure_stress',
      minDecisionIntervalMs: 1_000,
    })
    expect(profiles.find(profile => profile.id === 'liquidation_probe_100x')).toMatchObject({
      leverage: 100,
      mode: 'stress_only',
      cadence: 'second',
      timeframe: '1s',
      strategyLane: 'microstructure_stress',
      minDecisionIntervalMs: 1_000,
      maxPositionFraction: 0.005,
    })
    expect(profiles.find(profile => profile.id === 'spot_1x')).toMatchObject({
      leverage: 1,
      cadence: 'minute',
      timeframe: '5m',
      strategyLane: 'volume_breakout',
      minDecisionIntervalMs: 300_000,
    })
    expect(profiles.find(profile => profile.id === 'conservative_3x')).toMatchObject({
      leverage: 3,
      cadence: 'minute',
      timeframe: '5m',
      strategyLane: 'volume_breakout',
      minDecisionIntervalMs: 300_000,
    })
  })

  it('can omit second-level 1s profiles for non-second cron runs', () => {
    const profiles = defaultPaperAccountProfiles({ includeSecondLevel: false })

    expect(profiles.map(profile => profile.id)).toEqual([
      'spot_1x',
      'conservative_3x',
    ])
  })

  it('scales virtual notional by profile leverage while keeping maxPositionFraction as margin fraction', () => {
    const profile = defaultPaperAccountProfiles().find(item => item.id === 'stress_10x')!
    const account = makeAccount(0, 0)

    const result = applySignalsToPaperAccount({
      profile,
      account,
      ranks: [makeRank('BTC-USDT', 1)],
      csAssets: [makeCsAsset('BTC-USDT', 100)],
      exposureMultiplier: 1,
      fwdHours: 48,
      now: new Date('2026-04-30T00:00:00.000Z'),
      today: '2026-04-30',
      marketIntelContext: makeMarketIntelContext({
        contextGeneration: 7,
        flashEpoch: 11,
        proEpoch: 13,
        confidenceLow: 0.64,
        trigger: 'event:market-intel-refresh',
      }),
    })

    expect(result.profileReport.status).toBe('traded')
    expect(result.profileReport.proposedOrders[0]).toMatchObject({
      accountId: 'stress_10x',
      leverage: 10,
      cadence: 'second',
      timeframe: '1s',
      strategyLane: 'microstructure_stress',
      marginUsd: 3_000,
      notionalUsd: 30_000,
      quantity: 300,
      estimatedRoundTripCostPctOfMargin: 4.3,
      liquidationMovePctApprox: 10,
    })
    expect(result.profileReport.executedTrades[0]).toMatchObject({
      accountId: 'stress_10x',
      leverage: 10,
      marginUsd: 3_000,
      notionalUsd: 30_000,
    })
    expect(result.account?.positions[0]).toMatchObject({
      accountId: 'stress_10x',
      leverage: 10,
      marginUsd: 3_000,
      notionalUsd: 30_000,
    })
  })

  it('rejects new cross-sectional opens when decision-time MarketIntel context is missing', () => {
    const profile = defaultPaperAccountProfiles({ includeSecondLevel: false }).find(item => item.id === 'spot_1x')!
    const account = makeAccount(0, 0)

    const result = applySignalsToPaperAccount({
      profile,
      account,
      ranks: [makeRank('BTC-USDT', 1)],
      csAssets: [makeCsAsset('BTC-USDT', 100)],
      exposureMultiplier: 1,
      fwdHours: 48,
      now: new Date('2026-04-30T00:00:00.000Z'),
      today: '2026-04-30',
    })

    expect(result.profileReport.status).toBe('no_signal')
    expect(result.profileReport.proposedOrders).toHaveLength(1)
    expect(result.profileReport.rejectedOrders).toHaveLength(1)
    expect(result.profileReport.rejectedOrders[0]).toMatchObject({
      symbol: 'BTC-USDT',
      rejectReason: expect.stringContaining('missing_contextSnapshotId'),
      shadowAppendResult: undefined,
    })
    expect(result.profileReport.rejectedOrders[0].rejectReason).toContain('missing_decisionTime')
    expect(result.profileReport.rejectedOrders[0].rejectReason).toContain('features_not_available_at_decision_time')
    expect(result.profileReport.executedTrades).toEqual([])
    expect(result.account?.positions).toEqual([])
    expect(result.account?.tradeHistory).toEqual([])
  })

  it('surfaces invalid v3 context for missing cross-sectional context shadow opens', () => {
    vi.mocked(appendPaperPolicyShadowOpen).mockReturnValueOnce({
      appended: false,
      shadowId: 'cross-shadow-missing',
      reason: 'invalid_v3_context',
      missingContextFields: ['contextSnapshotId'],
    })
    const profile = defaultPaperAccountProfiles({ includeSecondLevel: false }).find(item => item.id === 'spot_1x')!

    const result = recordRejectedCrossSectionalShadowOpenForTest({
      profile,
      order: {
        ...makeOrder('BTC-USDT'),
        rejectReason: 'missing_contextSnapshotId',
      },
      rejectReason: 'missing_contextSnapshotId',
      now: new Date('2026-04-30T00:00:00.000Z'),
      fwdHours: 48,
    })

    expect(result).toMatchObject({
      appended: false,
      reason: 'invalid_v3_context',
      missingContextFields: ['contextSnapshotId'],
    })
  })

  it('records stale cross-sectional rejects as durable shadow opens when v3 structure exists', () => {
    const profile = defaultPaperAccountProfiles({ includeSecondLevel: false }).find(item => item.id === 'spot_1x')!
    const context = {
      ...makeMarketIntelContext({
        contextGeneration: 7,
        flashEpoch: 11,
        proEpoch: 13,
        confidenceLow: 0.64,
        trigger: 'event:market-intel-refresh',
      }),
      validUntil: '1970-01-01T00:00:00.000Z',
    }

    recordRejectedCrossSectionalShadowOpenForTest({
      profile,
      order: makeOrder('BTC-USDT'),
      rejectReason: 'context_status:stale; flash_context_status:stale',
      marketIntelContext: context,
      now: new Date('2026-04-30T00:00:00.000Z'),
      fwdHours: 48,
    })

    expect(appendPaperPolicyShadowOpen).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendPaperPolicyShadowOpen).mock.calls[0][0]).toMatchObject({
      eventType: 'open',
      lane: 'cross_sectional',
      symbol: 'BTC-USDT',
      side: 'long',
      entryPrice: 100,
      horizonMs: 172_800_000,
      notionalUsd: 15_000,
      blockReasons: ['context_status:stale', 'flash_context_status:stale'],
      context: {
        contextSnapshotId: 'market_intel:schema:1:generation:7:lane:cross_sectional:flash:11:pro:13:news:17',
        featureSchemaVersion: 'paper_open_context.v3',
        contextStatus: 'stale',
        flashContextStatus: 'stale',
        flashConfidenceLowAtOpen: 0.64,
      },
      quality: {
        rankAtOpen: 1,
        signalConfidenceAtOpen: 0.8,
      },
      cost: {
        roundTripCostBpsAtOpen: 28,
        expectedGrossEdgePctAtOpen: 0,
        expectedNetEdgePctAtOpen: -0.28,
        expectedEdgeSourceAtOpen: 'cross_sectional_missing_rank_spread_conservative_zero_edge',
        matchPriceAtOpen: 100,
        markMatchStatusAtOpen: 'stale_or_missing',
      },
    })
  })

  it('captures cached MarketIntel context on newly opened cross-sectional paper positions', () => {
    const profile = defaultPaperAccountProfiles({ includeSecondLevel: false }).find(item => item.id === 'spot_1x')!
    const account = makeAccount(0, 0)
    const marketIntelContext = makeMarketIntelContext({
      contextGeneration: 7,
      flashEpoch: 11,
      proEpoch: 13,
      confidenceLow: 0.64,
      trigger: 'event:market-intel-refresh',
    })

    const result = applySignalsToPaperAccount({
      profile,
      account,
      ranks: [makeRank('BTC-USDT', 1)],
      csAssets: [makeCsAsset('BTC-USDT', 100)],
      exposureMultiplier: 1,
      fwdHours: 48,
      now: new Date('2026-04-30T00:00:00.000Z'),
      today: '2026-04-30',
      marketIntelContext,
    })

    expect(result.account?.positions[0]).toMatchObject({
      symbol: 'BTC-USDT',
      contextSnapshotId: 'market_intel:schema:1:generation:7:lane:cross_sectional:flash:11:pro:13:news:17',
      decisionTime: '2026-04-30T00:00:00.000Z',
      marketDataWatermarkAtDecisionTime: '2026-04-30T00:00:00.000Z',
      watermark: '2026-04-30T00:00:00.000Z',
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      contextGenerationAtOpen: 7,
      flashEpochAtOpen: 11,
      proEpochAtOpen: 13,
      flashConfidenceLowAtOpen: 0.64,
      ruleScoreAtOpen: 0.8,
      marketIntelTriggerAtOpen: 'event:market-intel-refresh',
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      contextReason: null,
      rankAtOpen: 1,
      rankSpreadPctAtOpen: null,
      estimatedRoundTripCostPctAtOpen: 0.43,
      estimatedRoundTripCostPctOfMarginAtOpen: 0.43,
      expectedGrossEdgePctAtOpen: 0,
      expectedNetEdgePctAtOpen: -0.43,
      expectedEdgeSourceAtOpen: 'cross_sectional_missing_rank_spread_conservative_zero_edge',
      routeCostBpsAtOpen: 43,
      roundTripCostBpsAtOpen: 43,
      markPriceAtOpen: null,
      markPriceTimestampAtOpen: null,
      matchPriceAtOpen: 100,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
      signalConfidenceAtOpen: 0.8,
    })
    expect(result.profileReport.executedTrades[0]).toMatchObject({
      id: expect.stringContaining('open_spot_1x_BTC-USDT'),
      contextSnapshotId: 'market_intel:schema:1:generation:7:lane:cross_sectional:flash:11:pro:13:news:17',
      decisionTime: '2026-04-30T00:00:00.000Z',
      marketDataWatermarkAtDecisionTime: '2026-04-30T00:00:00.000Z',
      watermark: '2026-04-30T00:00:00.000Z',
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      contextGenerationAtOpen: 7,
      flashEpochAtOpen: 11,
      proEpochAtOpen: 13,
      flashConfidenceLowAtOpen: 0.64,
      ruleScoreAtOpen: 0.8,
      marketIntelTriggerAtOpen: 'event:market-intel-refresh',
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      contextReason: null,
      rankAtOpen: 1,
      rankSpreadPctAtOpen: null,
      estimatedRoundTripCostPctAtOpen: 0.43,
      estimatedRoundTripCostPctOfMarginAtOpen: 0.43,
      expectedGrossEdgePctAtOpen: 0,
      expectedNetEdgePctAtOpen: -0.43,
      expectedEdgeSourceAtOpen: 'cross_sectional_missing_rank_spread_conservative_zero_edge',
      routeCostBpsAtOpen: 43,
      roundTripCostBpsAtOpen: 43,
      markPriceAtOpen: null,
      markPriceTimestampAtOpen: null,
      matchPriceAtOpen: 100,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
      signalConfidenceAtOpen: 0.8,
    })
  })

  it('keeps accepted cross-sectional predicted-open evidence through account JSON persistence', () => {
    const profile = defaultPaperAccountProfiles({ includeSecondLevel: false }).find(item => item.id === 'spot_1x')!
    const account = makeAccount(0, 0)

    const result = applySignalsToPaperAccount({
      profile,
      account,
      ranks: [makeRank('BTC-USDT', 1, 'Rank 1/6, spread 7.5%')],
      csAssets: [makeCsAsset('BTC-USDT', 100)],
      exposureMultiplier: 1,
      fwdHours: 48,
      now: new Date('2026-04-30T00:00:00.000Z'),
      today: '2026-04-30',
      marketIntelContext: makeMarketIntelContext({
        contextGeneration: 7,
        flashEpoch: 11,
        proEpoch: 13,
        confidenceLow: 0.64,
        trigger: 'event:market-intel-refresh',
      }),
    })

    const persisted = JSON.parse(JSON.stringify(result.account))

    expect(persisted.positions[0]).toMatchObject({
      roundTripCostBpsAtOpen: 43,
      routeCostBpsAtOpen: 43,
      expectedGrossEdgePctAtOpen: 7.5,
      expectedNetEdgePctAtOpen: 7.07,
      expectedEdgeSourceAtOpen: 'rank_spread_pct_minus_paper_route_cost',
      matchPriceAtOpen: 100,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
    })
    expect(persisted.tradeHistory[0]).toMatchObject({
      roundTripCostBpsAtOpen: 43,
      routeCostBpsAtOpen: 43,
      expectedGrossEdgePctAtOpen: 7.5,
      expectedNetEdgePctAtOpen: 7.07,
      expectedEdgeSourceAtOpen: 'rank_spread_pct_minus_paper_route_cost',
      matchPriceAtOpen: 100,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
    })
  })

  it('fails closed before persisting cross-sectional opens with missing predicted-open evidence', () => {
    expect(() => assertCompletePredictedOpenEvidenceForTest('position', {
      estimatedRoundTripCostPctAtOpen: 0.43,
      estimatedRoundTripCostPctOfMarginAtOpen: 0.43,
      expectedGrossEdgePctAtOpen: null,
      expectedNetEdgePctAtOpen: -0.43,
      expectedEdgeSourceAtOpen: 'rank_spread_pct_minus_paper_route_cost',
      routeCostBpsAtOpen: 43,
      roundTripCostBpsAtOpen: 43,
      matchPriceAtOpen: 100,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
    })).toThrow(/cross_sectional_open_position_missing_predicted_open_evidence:expectedGrossEdgePctAtOpen/)

    expect(() => assertCompletePredictedOpenEvidenceForTest('trade', {
      estimatedRoundTripCostPctAtOpen: 0.43,
      estimatedRoundTripCostPctOfMarginAtOpen: 0.43,
      expectedGrossEdgePctAtOpen: 0,
      expectedNetEdgePctAtOpen: -0.43,
      expectedEdgeSourceAtOpen: 'rank_spread_pct_minus_paper_route_cost',
      routeCostBpsAtOpen: 43,
      roundTripCostBpsAtOpen: 43,
      matchPriceAtOpen: 100,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
    })).not.toThrow()
  })

  it('uses PIT-safe premiumIndex mark evidence when opening cross-sectional positions', async () => {
    process.env.OPENALICE_EXTERNAL_DERIVATIVES_EVENTS_PATH = await writePremiumIndexEvents([{
      symbol: 'BTCUSDT',
      sourceTimestamp: '2026-04-29T23:59:00.000Z',
      fetchTimestamp: '2026-04-29T23:59:02.000Z',
      ingestedAt: '2026-04-29T23:59:03.000Z',
      markPrice: '100',
    }])
    clearPaperMarkMatchSnapshotCacheForTest()
    const profile = defaultPaperAccountProfiles({ includeSecondLevel: false }).find(item => item.id === 'spot_1x')!
    const account = makeAccount(0, 0)

    const result = applySignalsToPaperAccount({
      profile,
      account,
      ranks: [makeRank('BTC-USDT', 1, 'Rank 1/6, spread 7.5%')],
      csAssets: [makeCsAsset('BTC-USDT', 101)],
      exposureMultiplier: 1,
      fwdHours: 48,
      now: new Date('2026-04-30T00:00:00.000Z'),
      today: '2026-04-30',
      marketIntelContext: makeMarketIntelContext({
        contextGeneration: 7,
        flashEpoch: 11,
        proEpoch: 13,
        confidenceLow: 0.64,
        trigger: 'event:market-intel-refresh',
      }),
    })

    expect(result.account?.positions[0]).toMatchObject({
      symbol: 'BTC-USDT',
      estimatedRoundTripCostPctAtOpen: 1.28,
      estimatedRoundTripCostPctOfMarginAtOpen: 1.28,
      expectedGrossEdgePctAtOpen: 7.5,
      expectedNetEdgePctAtOpen: 6.22,
      routeCostBpsAtOpen: 128,
      roundTripCostBpsAtOpen: 128,
      markPriceAtOpen: 100,
      markPriceTimestampAtOpen: '2026-04-29T23:59:00.000Z',
      matchPriceAtOpen: 101,
      markMatchPenaltyBpsAtOpen: 100,
      markMatchStatusAtOpen: 'ok',
    })
    expect(result.profileReport.executedTrades[0]).toMatchObject({
      markPriceAtOpen: 100,
      markMatchPenaltyBpsAtOpen: 100,
      markMatchStatusAtOpen: 'ok',
    })
  })

  it('copies the original open MarketIntel context into later closed paper trades', () => {
    const profile = defaultPaperAccountProfiles({ includeSecondLevel: false }).find(item => item.id === 'spot_1x')!
    const opened = applySignalsToPaperAccount({
      profile,
      account: makeAccount(0, 0),
      ranks: [makeRank('BTC-USDT', 1, 'Rank 1/6, spread 7.5%')],
      csAssets: [makeCsAsset('BTC-USDT', 100)],
      exposureMultiplier: 1,
      fwdHours: 1,
      now: new Date('2026-04-30T00:00:00.000Z'),
      today: '2026-04-30',
      marketIntelContext: makeMarketIntelContext({
        contextGeneration: 7,
        flashEpoch: 11,
        proEpoch: 13,
        confidenceLow: 0.64,
        trigger: 'event:market-intel-refresh',
      }),
    })

    const closed = applySignalsToPaperAccount({
      profile,
      account: opened.account,
      ranks: [],
      csAssets: [makeCsAsset('BTC-USDT', 102)],
      exposureMultiplier: 0,
      fwdHours: 1,
      now: new Date('2026-04-30T02:00:00.000Z'),
      today: '2026-04-30',
      marketIntelContext: makeMarketIntelContext({
        contextGeneration: 99,
        flashEpoch: 101,
        proEpoch: 103,
        confidenceLow: 0.21,
        trigger: 'ttl:new-context',
      }),
    })

    expect(closed.closedTrades[0]).toMatchObject({
      id: expect.stringContaining('close_spot_1x_BTC-USDT'),
      exitTime: '2026-04-30T02:00:00.000Z',
      contextSnapshotId: 'market_intel:schema:1:generation:7:lane:cross_sectional:flash:11:pro:13:news:17',
      decisionTime: '2026-04-30T00:00:00.000Z',
      marketDataWatermarkAtDecisionTime: '2026-04-30T00:00:00.000Z',
      watermark: '2026-04-30T00:00:00.000Z',
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      contextGenerationAtOpen: 7,
      flashEpochAtOpen: 11,
      proEpochAtOpen: 13,
      flashConfidenceLowAtOpen: 0.64,
      ruleScoreAtOpen: 0.8,
      marketIntelTriggerAtOpen: 'event:market-intel-refresh',
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      contextReason: null,
      rankAtOpen: 1,
      rankSpreadPctAtOpen: 7.5,
      estimatedRoundTripCostPctAtOpen: 0.43,
      estimatedRoundTripCostPctOfMarginAtOpen: 0.43,
      expectedGrossEdgePctAtOpen: 7.5,
      expectedNetEdgePctAtOpen: 7.07,
      expectedEdgeSourceAtOpen: 'rank_spread_pct_minus_paper_route_cost',
      routeCostBpsAtOpen: 43,
      roundTripCostBpsAtOpen: 43,
      markPriceAtOpen: null,
      markPriceTimestampAtOpen: null,
      matchPriceAtOpen: 100,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
      signalConfidenceAtOpen: 0.8,
    })
    expect(closed.profileReport.executedTrades[0]).toEqual(closed.closedTrades[0])
    expect(closed.account?.positions).toEqual([])
  })

  it('records cross-sectional MFE/MAE evidence on the common close ledger when candles are available', () => {
    const profile = defaultPaperAccountProfiles({ includeSecondLevel: false }).find(item => item.id === 'spot_1x')!
    const opened = applySignalsToPaperAccount({
      profile,
      account: makeAccount(0, 0),
      ranks: [makeRank('BTC-USDT', 1, 'Rank 1/6, spread 7.5%')],
      csAssets: [makeCsAsset('BTC-USDT', 100)],
      exposureMultiplier: 1,
      fwdHours: 1,
      now: new Date('2026-04-30T00:00:00.000Z'),
      today: '2026-04-30',
      marketIntelContext: makeMarketIntelContext({
        contextGeneration: 7,
        flashEpoch: 11,
        proEpoch: 13,
        confidenceLow: 0.64,
        trigger: 'event:market-intel-refresh',
      }),
    })

    applySignalsToPaperAccount({
      profile,
      account: opened.account,
      ranks: [],
      csAssets: [makeCsAsset('BTC-USDT', 102)],
      exposureMultiplier: 0,
      fwdHours: 1,
      now: new Date('2026-04-30T02:00:00.000Z'),
      today: '2026-04-30',
      recordClosedTradeResult: true,
      priceSource: '5m',
      priceStale: false,
      assetCandlesBySymbol: new Map([
        ['BTC-USDT', [
          { timestamp: Date.parse('2026-04-30T00:00:00.000Z'), high: 101, low: 99, close: 100 },
          { timestamp: Date.parse('2026-04-30T01:00:00.000Z'), high: 105, low: 98, close: 104 },
          { timestamp: Date.parse('2026-04-30T02:00:00.000Z'), high: 103, low: 100, close: 102 },
        ]],
      ]),
    })

    expect(appendPaperTradeResult).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendPaperTradeResult).mock.calls[0][0]).toMatchObject({
      lane: 'cross_sectional',
      symbol: 'BTC-USDT',
      side: 'long',
      openPrice: 100,
      closePrice: 102,
      closeReason: 'holding_expired',
      priceSource: '5m',
      mfeBps: 500,
      maeBps: -200,
      timeToMfeSec: 3600,
      timeToMaeSec: 3600,
      timeToStopSec: null,
      mfeBeforeStop: null,
    })
  })

  it('builds common paper trade results for closed cross-sectional trades with context and cost fields', () => {
    const profile = defaultPaperAccountProfiles({ includeSecondLevel: false }).find(item => item.id === 'spot_1x')!
    const opened = applySignalsToPaperAccount({
      profile,
      account: makeAccount(0, 0),
      ranks: [makeRank('BTC-USDT', 1, 'Rank 1/6, spread 7.5%')],
      csAssets: [makeCsAsset('BTC-USDT', 100)],
      exposureMultiplier: 1,
      fwdHours: 1,
      now: new Date('2026-04-30T00:00:00.000Z'),
      today: '2026-04-30',
      marketIntelContext: makeMarketIntelContext({
        contextGeneration: 7,
        flashEpoch: 11,
        proEpoch: 13,
        confidenceLow: 0.64,
        trigger: 'event:market-intel-refresh',
      }),
    })
    const openPosition = opened.account!.positions[0]
    const closed = applySignalsToPaperAccount({
      profile,
      account: opened.account,
      ranks: [],
      csAssets: [makeCsAsset('BTC-USDT', 102)],
      exposureMultiplier: 0,
      fwdHours: 1,
      now: new Date('2026-04-30T02:00:00.000Z'),
      today: '2026-04-30',
    })
    const trade = closed.closedTrades[0]

    expect(mapCrossSectionalCloseReason(trade)).toBe('holding_expired')
    expect(buildClosedCrossSectionalPaperTradeResult({
      profile,
      position: openPosition,
      trade,
      closeReason: mapCrossSectionalCloseReason(trade),
      priceSource: '5m',
      priceStale: false,
    })).toMatchObject({
      tradeId: trade.id,
      lane: 'cross_sectional',
      symbol: 'BTC-USDT',
      leverage: 1,
      side: 'long',
      openTs: '2026-04-30T00:00:00.000Z',
      closeTs: '2026-04-30T02:00:00.000Z',
      openPrice: 100,
      closePrice: 102,
      pnlPct: 2,
      pnlUsd: 300,
      closeReason: 'holding_expired',
      priceSource: '5m',
      priceStale: false,
      contextSnapshotId: 'market_intel:schema:1:generation:7:lane:cross_sectional:flash:11:pro:13:news:17',
      decisionTime: '2026-04-30T00:00:00.000Z',
      marketDataWatermarkAtDecisionTime: '2026-04-30T00:00:00.000Z',
      watermark: '2026-04-30T00:00:00.000Z',
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      contextGenerationAtOpen: 7,
      flashEpochAtOpen: 11,
      proEpochAtOpen: 13,
      flashConfidenceLowAtOpen: 0.64,
      ruleScoreAtOpen: 0.8,
      marketIntelTriggerAtOpen: 'event:market-intel-refresh',
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      rankAtOpen: 1,
      rankSpreadPctAtOpen: 7.5,
      estimatedRoundTripCostPctAtOpen: 0.43,
      estimatedRoundTripCostPctOfMarginAtOpen: 0.43,
      expectedGrossEdgePctAtOpen: 7.5,
      expectedNetEdgePctAtOpen: 7.07,
      expectedEdgeSourceAtOpen: 'rank_spread_pct_minus_paper_route_cost',
      routeCostBpsAtOpen: 43,
      roundTripCostBpsAtOpen: 43,
      markPriceAtOpen: null,
      markPriceTimestampAtOpen: null,
      matchPriceAtOpen: 100,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
      signalConfidenceAtOpen: 0.8,
      realizedRoundTripCostBps: null,
      realizedCostBps: null,
      fillAdjustedCostBps: null,
      fillAdjustedCostPct: null,
      costEvidenceSource: 'paper_cost_model_at_open',
      costEvidenceStatus: 'paper_model_not_exchange_reconciled',
      predictedOpenEvidenceStatus: 'ok',
      predictedOpenEvidenceReason: null,
      mfeBps: null,
      maeBps: null,
      timeToMfeSec: null,
      timeToMaeSec: null,
      timeToStopSec: null,
      mfeBeforeStop: null,
    })
  })

  it('marks already-open cross-sectional dirty positions when they close without predicted-open evidence', () => {
    const profile = defaultPaperAccountProfiles({ includeSecondLevel: false }).find(item => item.id === 'spot_1x')!
    const position: any = {
      symbol: 'DOGE-USDT',
      direction: 'long',
      entryPrice: 0.1,
      quantity: 1000,
      entryTime: '2026-05-02T12:17:05.427Z',
      signalConfidence: 0.7,
      accountId: 'spot_1x',
      leverage: 1,
      marginUsd: 100,
      notionalUsd: 100,
      liquidationMovePctApprox: 100,
      contextSnapshotId: 'ctx:doge',
      decisionTime: '2026-05-02T12:17:05.427Z',
      marketDataWatermarkAtDecisionTime: '2026-05-02T12:17:05.000Z',
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      contextGenerationAtOpen: 1,
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      flashConfidenceLowAtOpen: 0.5,
      estimatedRoundTripCostPctAtOpen: 0.28,
      routeCostBpsAtOpen: 28,
      roundTripCostBpsAtOpen: 28,
      matchPriceAtOpen: 0.1,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchStatusAtOpen: 'stale_or_missing',
    }
    const trade: any = {
      id: 'close_spot_1x_DOGE-USDT_1777738625427',
      symbol: 'DOGE-USDT',
      direction: 'long',
      entryPrice: 0.1,
      exitPrice: 0.11,
      entryTime: position.entryTime,
      exitTime: '2026-05-02T13:17:05.427Z',
      quantity: 1000,
      pnl: 10,
      pnlPct: 10,
      reason: 'Holding period expired (1h >= 1h)',
      accountId: 'spot_1x',
      leverage: 1,
      liquidated: false,
    }

    expect(buildClosedCrossSectionalPaperTradeResult({
      profile,
      position,
      trade,
      closeReason: 'holding_expired',
      priceSource: 'last_known',
      priceStale: false,
    })).toMatchObject({
      predictedOpenEvidenceStatus: 'transitional_dirty_open',
      predictedOpenEvidenceReason: 'missing:expectedGrossEdgePctAtOpen,expectedNetEdgePctAtOpen,expectedEdgeSourceAtOpen,markMatchPenaltyBpsAtOpen',
      contextCoverageStatus: 'ok',
    })
  })

  it('maps cross-sectional liquidation and banned-symbol closes to common result reasons', () => {
    expect(mapCrossSectionalCloseReason({
      reason: 'Virtual liquidation threshold reached (1.20% >= 1.00%)',
      liquidated: true,
    })).toBe('virtual_liquidation_guard')
    expect(mapCrossSectionalCloseReason({
      reason: 'MarketIntel banned symbol',
      liquidated: false,
    })).toBe('banned_symbol')
    expect(mapCrossSectionalCloseReason({
      reason: 'manual signal close',
      liquidated: false,
    })).toBe('signal')
  })

  it('keeps the 100x liquidation probe as stress-only diagnostics without mutating an account', () => {
    const profile = defaultPaperAccountProfiles().find(item => item.id === 'liquidation_probe_100x')!
    const account = makeAccount(0, 0)

    const result = applySignalsToPaperAccount({
      profile,
      account,
      ranks: [makeRank('BTC-USDT', 1), makeRank('ETH-USDT', -1)],
      csAssets: [makeCsAsset('BTC-USDT', 100), makeCsAsset('ETH-USDT', 200)],
      exposureMultiplier: 1,
      fwdHours: 48,
      now: new Date('2026-04-30T00:00:00.000Z'),
      today: '2026-04-30',
    })

    expect(result.account).toBeNull()
    expect(result.profileReport.status).toBe('stress_only')
    expect(result.profileReport.proposedOrders).toHaveLength(2)
    expect(result.profileReport.executedTrades).toEqual([])
    expect(result.profileReport.risk.liquidationMovePctApprox).toBe(1)
    expect(result.profileReport.risk.estimatedRoundTripCostPctOfMargin).toBeCloseTo(43)
    expect(account.positions).toEqual([])
    expect(account.tradeHistory).toEqual([])
    expect(account.dailyPnL).toEqual([])
  })
})

function makeAsset(
  symbol: string,
  source: LoadedAssetData['source'],
  state: CandleDataQualityReport['state'],
  barCount: number,
  reasons: string[],
): LoadedAssetData {
  return {
    symbol,
    source,
    path: `${source}/${symbol}.csv`,
    candles: [],
    dataQuality: makeQuality(symbol, state, barCount, reasons),
  }
}

function makeQuality(
  symbol: string,
  state: CandleDataQualityReport['state'],
  barCount: number,
  reasons: string[],
): CandleDataQualityReport {
  return {
    symbol,
    state,
    barCount,
    startTime: '2026-04-01T00:00:00.000Z',
    endTime: '2026-04-29T00:00:00.000Z',
    expectedIntervalMs: 3_600_000,
    staleHours: 1,
    duplicateTimestamps: 0,
    nonMonotonicTimestamps: 0,
    gapCount: 0,
    maxGapHours: 0,
    invalidOhlcvCount: 0,
    zeroVolumeCount: 0,
    reasons,
  }
}

function makeAccount(days: number, closedTrades: number): PaperAccount {
  return {
    equity: 100_000,
    initialEquity: 100_000,
    positions: [],
    dailyPnL: Array.from({ length: days }, (_, index) => ({
      date: `2026-04-${String(index + 1).padStart(2, '0')}`,
      pnl: 0,
      pnlPct: 0,
    })),
    tradeHistory: Array.from({ length: closedTrades }, (_, index) => ({
      id: `closed-${index}`,
      symbol: 'BTC-USDT',
      direction: 'long',
      entryPrice: 100,
      exitPrice: 101,
      entryTime: '2026-04-01T00:00:00.000Z',
      exitTime: '2026-04-03T00:00:00.000Z',
      quantity: 1,
      pnl: 1,
      pnlPct: 1,
      reason: 'test',
    })),
  }
}

function makeRank(symbol: string, signal: number, reason = 'test signal'): CrossSectionalRank {
  return {
    symbol,
    rank: signal === 1 ? 1 : 2,
    momentumScore: 0,
    riskAdjustedScore: 0,
    signal,
    positionFraction: 0.15,
    confidence: 0.8,
    reason,
  }
}

function makeOrder(symbol: string) {
  return {
    symbol,
    direction: 'long' as const,
    price: 100,
    accountId: 'spot_1x',
    accountLabel: 'Spot 1x',
    accountMode: 'paper_trade' as const,
    cadence: 'hourly' as const,
    timeframe: '1h' as const,
    strategyLane: 'cross_sectional' as const,
    leverage: 1,
    marginUsd: 15_000,
    notionalUsd: 15_000,
    quantity: 150,
    confidence: 0.8,
    reason: 'test signal',
    rankAtOpen: 1,
    rankSpreadPctAtOpen: null,
    estimatedRoundTripCostPct: 0.28,
    estimatedRoundTripCostUsd: 42,
    estimatedRoundTripCostPctOfMargin: 0.28,
    expectedGrossEdgePctAtOpen: 0,
    expectedNetEdgePctAtOpen: -0.28,
    expectedEdgeSourceAtOpen: 'cross_sectional_missing_rank_spread_conservative_zero_edge',
    routeCostBpsAtOpen: 28,
    roundTripCostBpsAtOpen: 28,
    markPriceAtOpen: null,
    markPriceTimestampAtOpen: null,
    matchPriceAtOpen: 100,
    matchPriceSourceAtOpen: 'simulated_fill',
    markMatchPenaltyBpsAtOpen: null,
    markMatchStatusAtOpen: 'stale_or_missing',
    liquidationMovePctApprox: 100,
    wouldLiquidate: false,
  }
}

function makeCsAsset(symbol: string, currentPrice: number): CrossSectionalAsset {
  return {
    symbol,
    currentPrice,
    returns: { '24h': 1 },
    realizedVolPct: 50,
    avgVolume24h: 1_000,
  }
}

function makeMarketIntelContext(input: {
  contextGeneration: number
  flashEpoch: number
  proEpoch: number
  confidenceLow: number
  trigger: string
}): MarketIntelContext {
  return {
    schemaVersion: 1,
    contextGeneration: input.contextGeneration,
    generatedAt: '2026-04-30T00:00:00.000Z',
    validUntil: '2026-05-01T00:00:00.000Z',
    riskMode: 'risk_on',
    newsRiskRegime: 'normal',
    allowNewPositionsByLane: {
      cross_sectional: true,
      volume_breakout_1x: true,
      volume_breakout_3x: true,
      microstructure_10x: true,
      microstructure_100x: true,
    },
    exposureMultiplierByLane: {
      cross_sectional: 1,
      volume_breakout_1x: 1,
      volume_breakout_3x: 1,
      microstructure_10x: 1,
      microstructure_100x: 1,
    },
    bannedSymbols: [],
    suggestedRuleThresholdByLane: { cross_sectional: 0.2 },
    coldStartRoundsRemaining: 0,
    flashConfidenceByLane: {
      cross_sectional: {
        confidence: Math.min(1, input.confidenceLow + 0.1),
        confidenceLow: input.confidenceLow,
        confidenceHigh: Math.min(1, input.confidenceLow + 0.2),
      },
    },
    semanticValidation: { passed: true, violations: [] },
    sourceEpoch: {
      flashEpoch: input.flashEpoch,
      proEpoch: input.proEpoch,
      newsEpoch: 17,
    },
    autoApplyPolicy: 'risk_reduction_only',
    trigger: input.trigger,
    reasons: [],
  }
}

async function writePremiumIndexEvents(rows: Array<{
  symbol: string
  sourceTimestamp: string
  fetchTimestamp: string
  ingestedAt: string
  markPrice: string
}>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cross-premium-index-'))
  await mkdir(root, { recursive: true })
  const path = join(root, 'events.jsonl')
  await writeFile(path, rows.map(row => JSON.stringify({
    schemaVersion: 'external_derivatives_event.v1',
    exchange: 'binance',
    market: 'usdm',
    symbol: row.symbol,
    sourceEndpoint: '/fapi/v1/premiumIndex',
    sourceTimestamp: row.sourceTimestamp,
    sourceTimestampBasis: 'exchange_event',
    fetchTimestamp: row.fetchTimestamp,
    payloadReceivedAt: row.fetchTimestamp,
    ingestedAt: row.ingestedAt,
    dedupKey: `binance|usdm|premiumIndex|${row.symbol}|${Date.parse(row.sourceTimestamp)}`,
    rawPayloadHash: 'hash',
    payload: {
      symbol: row.symbol,
      markPrice: row.markPrice,
      time: Date.parse(row.sourceTimestamp),
    },
  })).join('\n') + '\n', 'utf-8')
  return path
}
