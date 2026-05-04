import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/runtime/paper_trade_result.js', async () => {
  const actual = await vi.importActual<typeof import('../src/runtime/paper_trade_result.js')>('../src/runtime/paper_trade_result.js')
  return {
    ...actual,
    appendPaperTradeResult: vi.fn(),
  }
})
vi.mock('../src/runtime/paper_policy_shadow_ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../src/runtime/paper_policy_shadow_ledger.js')>('../src/runtime/paper_policy_shadow_ledger.js')
  return {
    ...actual,
    appendPaperPolicyShadowOpen: vi.fn(),
  }
})

import {
  assertCompleteVolumeBreakoutPredictedOpenEvidenceForTest,
  closeExpiredPositions,
  filterExecutableVolumeBreakoutSignals,
  openNewPositions,
  recordRejectedVolumeBreakoutSignalShadowOpenForTest,
  shouldAllowUngatedPaperLane,
  shouldDryRun,
} from './paper_trade_volume_breakout.js'
import { appendPaperTradeResult } from '../src/runtime/paper_trade_result.js'
import { appendPaperPolicyShadowOpen } from '../src/runtime/paper_policy_shadow_ledger.js'
import { buildPaperOpenContextSnapshot } from '../src/runtime/paper_open_context.js'
import { createBootstrapMarketIntelContext } from '../src/runtime/market_intel_context.js'
import { evaluateVolumeBreakout } from '../src/domain/strategy/volume-breakout.js'
import { clearPaperMarkMatchSnapshotCacheForTest } from './lib/paper_mark_match.js'

describe('paper_trade_volume_breakout safety guard', () => {
  beforeEach(() => {
    vi.mocked(appendPaperTradeResult).mockClear()
    vi.mocked(appendPaperPolicyShadowOpen).mockClear()
    process.env.OPENALICE_EXTERNAL_DERIVATIVES_EVENTS_PATH = '/tmp/openalice-volume-breakout-no-mark.jsonl'
    clearPaperMarkMatchSnapshotCacheForTest()
    vi.useRealTimers()
  })

  afterEach(() => {
    delete process.env.OPENALICE_EXTERNAL_DERIVATIVES_EVENTS_PATH
    clearPaperMarkMatchSnapshotCacheForTest()
  })

  it('requires an explicit diagnostic override for ungated paper execution', () => {
    expect(shouldAllowUngatedPaperLane([])).toBe(false)
    expect(shouldAllowUngatedPaperLane(['--allowUngatedPaperLane', 'true'])).toBe(true)
    expect(shouldAllowUngatedPaperLane(['--allowUngatedPaperLane=false'])).toBe(false)
  })

  it('defaults the CLI entrypoint to dry-run before paper state mutation', () => {
    expect(shouldDryRun([])).toBe(true)
    expect(shouldDryRun(['--dryRun', 'false'])).toBe(false)
    expect(shouldDryRun(['--dryRun=false'])).toBe(false)
  })

  it('blocks weak or suspicious breakout signals before opening positions', () => {
    const strongSignal = {
      symbol: 'BTC-USDT',
      signal: 1 as const,
      confidence: 0.42,
      barTime: 1,
      entryPrice: 100,
      volumeRatio: 8,
      rangeBreakoutPct: 2.5,
      breakQuality: 0.8,
      liquidityUsd: 1_000_000,
      liquidityStatus: 'pass' as const,
      spreadBps: null,
      spreadStatus: 'unknown' as const,
      stopLossPrice: 99.5,
      reason: 'strong breakout',
    }
    const weakSignal = {
      ...strongSignal,
      symbol: 'LINK-USDT',
      confidence: 0.00002,
      rangeBreakoutPct: 0.0002,
      reason: 'tiny break',
    }
    const suspiciousVolumeSignal = {
      ...strongSignal,
      symbol: 'FIL-USDT',
      volumeRatio: 500_000,
      reason: 'bad median volume artifact',
    }

    const result = filterExecutableVolumeBreakoutSignals([
      weakSignal,
      suspiciousVolumeSignal,
      strongSignal,
    ])

    expect(result.executableSignals.map(s => s.symbol)).toEqual(['BTC-USDT'])
    expect(result.rejectedSignals.map(s => s.symbol)).toEqual(['LINK-USDT', 'FIL-USDT'])
    expect(result.rejectedSignals[0].reason).toContain('confidence')
    expect(result.rejectedSignals[0].reason).toContain('break')
    expect(result.rejectedSignals[1].reason).toContain('volume ratio')
  })

  it('blocks missing break quality instead of opening trades with null expected edge', () => {
    const signal = buildExecutableSignal()
    delete (signal as Partial<typeof signal>).breakQuality

    const result = filterExecutableVolumeBreakoutSignals([
      signal as ReturnType<typeof evaluateVolumeBreakout>,
    ])

    expect(result.executableSignals).toHaveLength(0)
    expect(result.rejectedSignals).toHaveLength(1)
    expect(result.rejectedSignals[0]).toMatchObject({
      symbol: 'BTC-USDT',
      breakQuality: undefined,
    })
    expect(result.rejectedSignals[0].reason).toContain('break quality missing or invalid')
  })

  it('fails closed if a caller bypasses filtering and tries to open without predicted edge evidence', () => {
    const profile = buildProfile()
    const account = buildAccount()
    const signal = buildExecutableSignal()
    delete (signal as Partial<typeof signal>).breakQuality

    expect(() =>
      openNewPositions(
        profile,
        account,
        [signal as ReturnType<typeof evaluateVolumeBreakout>],
        buildGate(),
      ),
    ).toThrow('volume_breakout_open_position_missing_predicted_open_evidence:expectedGrossEdgePctAtOpen,expectedNetEdgePctAtOpen,expectedEdgeSourceAtOpen')
    expect(account.positions).toEqual([])
    expect(account.tradeHistory).toEqual([])
  })

  it('exposes a test seam for predicted-open evidence completeness', () => {
    expect(() =>
      assertCompleteVolumeBreakoutPredictedOpenEvidenceForTest('position', {
        estimatedRoundTripCostPctAtOpen: 0.43,
        estimatedRoundTripCostPctOfMarginAtOpen: 0.43,
        expectedGrossEdgePctAtOpen: 2.255,
        expectedNetEdgePctAtOpen: 1.825,
        expectedEdgeSourceAtOpen: 'volume_breakout_range_break_pct_x_quality_minus_paper_route_cost',
        routeCostBpsAtOpen: 43,
        roundTripCostBpsAtOpen: 43,
        matchPriceAtOpen: 100,
        matchPriceSourceAtOpen: 'simulated_fill',
        markMatchPenaltyBpsAtOpen: 15,
        markMatchStatusAtOpen: 'stale_or_missing',
      }),
    ).not.toThrow()
    expect(() =>
      assertCompleteVolumeBreakoutPredictedOpenEvidenceForTest('trade', {
        estimatedRoundTripCostPctAtOpen: 0.43,
        estimatedRoundTripCostPctOfMarginAtOpen: 0.43,
        expectedGrossEdgePctAtOpen: 2.255,
        expectedNetEdgePctAtOpen: 1.825,
        expectedEdgeSourceAtOpen: '',
        routeCostBpsAtOpen: 43,
        roundTripCostBpsAtOpen: 43,
        matchPriceAtOpen: 100,
        matchPriceSourceAtOpen: 'simulated_fill',
        markMatchPenaltyBpsAtOpen: 15,
        markMatchStatusAtOpen: 'stale_or_missing',
      }),
    ).toThrow('volume_breakout_open_trade_missing_predicted_open_evidence:expectedEdgeSourceAtOpen')
  })

  it('keeps missing spread data as unknown fallback instead of blocking all volume breakouts', () => {
    const candles = buildBreakoutCandles({ latestClose: 103, latestVolume: 20_000 })

    const signal = evaluateVolumeBreakout('BTC-USDT', candles, {
      volumeMultiplier: 2,
      minVolumeUsd: 100_000,
      minBreakQuality: 0.35,
      maxSpreadBps: 20,
    })

    expect(signal.signal).toBe(1)
    expect(signal.liquidityStatus).toBe('pass')
    expect(signal.liquidityUsd).toBeGreaterThan(100_000)
    expect(signal.spreadStatus).toBe('unknown')
    expect(signal.spreadBps).toBeNull()
    expect(signal.breakQuality).toBeGreaterThanOrEqual(0.35)
  })

  it('blocks explicit low liquidity and explicit wide spread without requiring those fields to exist', () => {
    const lowLiquidity = evaluateVolumeBreakout('THIN-USDT', buildBreakoutCandles({
      latestClose: 103,
      latestVolume: 200,
      baselineVolume: 10,
    }), {
      volumeMultiplier: 2,
      minVolumeUsd: 100_000,
      minBreakQuality: 0.35,
    })
    const wideSpread = evaluateVolumeBreakout('WIDE-USDT', buildBreakoutCandles({
      latestClose: 103,
      latestVolume: 20_000,
      spreadBps: 80,
    }), {
      volumeMultiplier: 2,
      minVolumeUsd: 100_000,
      minBreakQuality: 0.35,
      maxSpreadBps: 40,
    })

    expect(lowLiquidity.signal).toBe(0)
    expect(lowLiquidity.liquidityStatus).toBe('fail')
    expect(lowLiquidity.reason).toContain('Liquidity')
    expect(wideSpread.signal).toBe(0)
    expect(wideSpread.spreadStatus).toBe('fail')
    expect(wideSpread.reason).toContain('Spread')
  })

  it('blocks weak close-through quality after a volume spike', () => {
    const signal = evaluateVolumeBreakout('WICK-USDT', buildBreakoutCandles({
      latestOpen: 102.9,
      latestHigh: 104,
      latestLow: 99,
      latestClose: 103,
      latestVolume: 20_000,
    }), {
      volumeMultiplier: 2,
      minVolumeUsd: 100_000,
      minBreakQuality: 0.85,
    })

    expect(signal.signal).toBe(0)
    expect(signal.reason).toContain('Break quality')
    expect(signal.breakQuality).toBeLessThan(0.85)
  })

  it('captures MarketIntel open context for the volume breakout lane', () => {
    const now = new Date('2026-05-02T00:00:00.000Z')
    const context = {
      ...createBootstrapMarketIntelContext(now),
      contextGeneration: 42,
      validUntil: '2026-05-02T00:05:00.000Z',
      riskMode: 'risk_on' as const,
      allowNewPositionsByLane: {
        cross_sectional: true,
        volume_breakout_1x: true,
        volume_breakout_3x: true,
        microstructure_10x: false,
        microstructure_100x: false,
      },
      coldStartRoundsRemaining: 0,
      sourceEpoch: { flashEpoch: 7, proEpoch: 9, newsEpoch: 11 },
      flashConfidenceByLane: {
        volume_breakout_1x: { confidence: 0.72, confidenceLow: 0.61, confidenceHigh: 0.84 },
      },
      trigger: 'cached_market_intel',
    }

    const snapshot = buildPaperOpenContextSnapshot(context, 'volume_breakout_1x', now)

    expect(snapshot).toMatchObject({
      contextSnapshotId: 'market_intel:schema:1:generation:42:lane:volume_breakout_1x:flash:7:pro:9:news:11',
      decisionTime: '2026-05-02T00:00:00.000Z',
      marketDataWatermarkAtDecisionTime: '2026-05-02T00:00:00.000Z',
      watermark: '2026-05-02T00:00:00.000Z',
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      contextGenerationAtOpen: 42,
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      contextReason: null,
      flashEpochAtOpen: 7,
      proEpochAtOpen: 9,
      flashConfidenceLowAtOpen: 0.61,
      marketIntelTriggerAtOpen: 'cached_market_intel',
    })
  })

  it('propagates signal-quality fields into opened positions and open trade records', () => {
    const profile = buildProfile()
    const account = buildAccount()
    const signal = buildExecutableSignal()

    openNewPositions(profile, account, [signal as ReturnType<typeof evaluateVolumeBreakout>], buildGate())

    expect(account.positions).toHaveLength(1)
    expect(account.tradeHistory).toHaveLength(1)
    expect(account.positions[0]).toMatchObject({
      symbol: 'BTC-USDT',
      contextSnapshotId: 'market_intel:schema:1:generation:42:lane:volume_breakout_1x:flash:7:pro:9:news:11',
      decisionTime: expect.any(String),
      marketDataWatermarkAtDecisionTime: '2026-05-02T00:00:00.000Z',
      watermark: '2026-05-02T00:00:00.000Z',
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      volumeRatioAtOpen: 12.5,
      rangeBreakoutPctAtOpen: 2.75,
      breakQualityAtOpen: 0.82,
      liquidityUsdAtOpen: 2_500_000,
      liquidityStatusAtOpen: 'pass',
      spreadBpsAtOpen: 4.2,
      spreadStatusAtOpen: 'pass',
      estimatedRoundTripCostPctAtOpen: 0.43,
      estimatedRoundTripCostPctOfMarginAtOpen: 0.43,
      expectedGrossEdgePctAtOpen: 2.255,
      expectedNetEdgePctAtOpen: 1.825,
      expectedEdgeSourceAtOpen: 'volume_breakout_range_break_pct_x_quality_minus_paper_route_cost',
      routeCostBpsAtOpen: 43,
      roundTripCostBpsAtOpen: 43,
      matchPriceAtOpen: 100,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
    })
    expect(account.tradeHistory[0]).toMatchObject({
      id: expect.stringContaining('open_spot_1x_BTC-USDT_'),
      contextSnapshotId: 'market_intel:schema:1:generation:42:lane:volume_breakout_1x:flash:7:pro:9:news:11',
      marketDataWatermarkAtDecisionTime: '2026-05-02T00:00:00.000Z',
      watermark: '2026-05-02T00:00:00.000Z',
      featureSchemaVersion: 'paper_open_context.v3',
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      volumeRatioAtOpen: 12.5,
      rangeBreakoutPctAtOpen: 2.75,
      breakQualityAtOpen: 0.82,
      liquidityUsdAtOpen: 2_500_000,
      liquidityStatusAtOpen: 'pass',
      spreadBpsAtOpen: 4.2,
      spreadStatusAtOpen: 'pass',
      estimatedRoundTripCostPctAtOpen: 0.43,
      roundTripCostBpsAtOpen: 43,
      expectedGrossEdgePctAtOpen: 2.255,
      expectedNetEdgePctAtOpen: 1.825,
      expectedEdgeSourceAtOpen: 'volume_breakout_range_break_pct_x_quality_minus_paper_route_cost',
      matchPriceAtOpen: 100,
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
    })
    expect(appendPaperTradeResult).not.toHaveBeenCalled()
  })

  it('uses PIT-safe premiumIndex mark evidence when opening volume-breakout positions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-02T00:05:00.000Z'))
    process.env.OPENALICE_EXTERNAL_DERIVATIVES_EVENTS_PATH = await writePremiumIndexEvents([{
      symbol: 'BTCUSDT',
      sourceTimestamp: '2026-05-02T00:04:00.000Z',
      fetchTimestamp: '2026-05-02T00:04:02.000Z',
      ingestedAt: '2026-05-02T00:04:03.000Z',
      markPrice: '100',
    }])
    clearPaperMarkMatchSnapshotCacheForTest()
    const profile = buildProfile()
    const account = buildAccount()
    const signal = buildExecutableSignal()
    signal.entryPrice = 101

    openNewPositions(profile, account, [signal as ReturnType<typeof evaluateVolumeBreakout>], buildGate())

    expect(account.positions[0]).toMatchObject({
      symbol: 'BTC-USDT',
      estimatedRoundTripCostPctAtOpen: 1.28,
      expectedGrossEdgePctAtOpen: 2.255,
      expectedNetEdgePctAtOpen: 0.975,
      routeCostBpsAtOpen: 128,
      roundTripCostBpsAtOpen: 128,
      markPriceAtOpen: 100,
      markPriceTimestampAtOpen: '2026-05-02T00:04:00.000Z',
      matchPriceAtOpen: 101,
      markMatchPenaltyBpsAtOpen: 100,
      markMatchStatusAtOpen: 'ok',
    })
    expect(account.tradeHistory[0]).toMatchObject({
      markPriceAtOpen: 100,
      markMatchPenaltyBpsAtOpen: 100,
      markMatchStatusAtOpen: 'ok',
    })
  })

  it('propagates open-time signal-quality fields into closed trades and append payloads', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-02T00:00:00.000Z'))
    const profile = buildProfile()
    const account = buildAccount()
    const signal = buildExecutableSignal()
    const gate = buildGate()

    openNewPositions(profile, account, [signal as ReturnType<typeof evaluateVolumeBreakout>], gate)

    closeExpiredPositions(profile, account, [{
      symbol: 'BTC-USDT',
      candles: buildExpiryCandles(signal.barTime, 106),
    }], gate)

    expect(account.positions).toHaveLength(0)
    expect(account.tradeHistory).toHaveLength(2)
    expect(account.tradeHistory[1]).toMatchObject({
      id: expect.stringContaining('close_spot_1x_BTC-USDT_'),
      contextSnapshotId: 'market_intel:schema:1:generation:42:lane:volume_breakout_1x:flash:7:pro:9:news:11',
      marketDataWatermarkAtDecisionTime: '2026-05-02T00:00:00.000Z',
      watermark: '2026-05-02T00:00:00.000Z',
      featureSchemaVersion: 'paper_open_context.v3',
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      volumeRatioAtOpen: 12.5,
      rangeBreakoutPctAtOpen: 2.75,
      breakQualityAtOpen: 0.82,
      liquidityUsdAtOpen: 2_500_000,
      liquidityStatusAtOpen: 'pass',
      spreadBpsAtOpen: 4.2,
      spreadStatusAtOpen: 'pass',
      estimatedRoundTripCostPctAtOpen: 0.43,
      roundTripCostBpsAtOpen: 43,
      expectedGrossEdgePctAtOpen: 2.255,
      expectedNetEdgePctAtOpen: 1.825,
      expectedEdgeSourceAtOpen: 'volume_breakout_range_break_pct_x_quality_minus_paper_route_cost',
      matchPriceAtOpen: 100,
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
    })
    expect(appendPaperTradeResult).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendPaperTradeResult).mock.calls[0][0]).toMatchObject({
      lane: 'volume_breakout_1x',
      symbol: 'BTC-USDT',
      contextSnapshotId: 'market_intel:schema:1:generation:42:lane:volume_breakout_1x:flash:7:pro:9:news:11',
      marketDataWatermarkAtDecisionTime: '2026-05-02T00:00:00.000Z',
      watermark: '2026-05-02T00:00:00.000Z',
      featureSchemaVersion: 'paper_open_context.v3',
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      volumeRatioAtOpen: 12.5,
      rangeBreakoutPctAtOpen: 2.75,
      breakQualityAtOpen: 0.82,
      liquidityUsdAtOpen: 2_500_000,
      liquidityStatusAtOpen: 'pass',
      spreadBpsAtOpen: 4.2,
      spreadStatusAtOpen: 'pass',
      estimatedRoundTripCostPctAtOpen: 0.43,
      routeCostBpsAtOpen: 43,
      roundTripCostBpsAtOpen: 43,
      expectedGrossEdgePctAtOpen: 2.255,
      expectedNetEdgePctAtOpen: 1.825,
      expectedEdgeSourceAtOpen: 'volume_breakout_range_break_pct_x_quality_minus_paper_route_cost',
      markPriceAtOpen: null,
      markPriceTimestampAtOpen: null,
      matchPriceAtOpen: 100,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
      costEvidenceSource: 'paper_cost_model_at_open',
      costEvidenceStatus: 'paper_model_not_exchange_reconciled',
      realizedRoundTripCostBps: null,
      realizedCostBps: null,
      fillAdjustedCostBps: null,
      fillAdjustedCostPct: null,
      mfeBps: 600,
      maeBps: -100,
      timeToMfeSec: 0,
      timeToMaeSec: 0,
      timeToStopSec: null,
      mfeBeforeStop: null,
    })
  })

  it('propagates cost evidence into rejected volume-breakout shadow opens', () => {
    const profile = buildProfile()
    const signal = {
      ...buildExecutableSignal(),
      confidence: 0.1,
    }

    const appendResult = recordRejectedVolumeBreakoutSignalShadowOpenForTest(
      profile,
      signal as ReturnType<typeof evaluateVolumeBreakout>,
      'profile_min_confidence 0.100 < 0.2',
      buildGate().context,
    )

    expect(appendResult).toBeUndefined()
    expect(appendPaperPolicyShadowOpen).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendPaperPolicyShadowOpen).mock.calls[0][0]).toMatchObject({
      eventType: 'open',
      lane: 'volume_breakout_1x',
      symbol: 'BTC-USDT',
      quality: {
        volumeRatioAtOpen: 12.5,
        breakQualityAtOpen: 0.82,
      },
      cost: {
        estimatedRoundTripCostPctAtOpen: 0.43,
        estimatedRoundTripCostPctOfMarginAtOpen: 0.43,
        expectedGrossEdgePctAtOpen: 2.255,
        expectedNetEdgePctAtOpen: 1.825,
        expectedEdgeSourceAtOpen: 'volume_breakout_range_break_pct_x_quality_minus_paper_route_cost',
        routeCostBpsAtOpen: 43,
        roundTripCostBpsAtOpen: 43,
        matchPriceAtOpen: 100,
        matchPriceSourceAtOpen: 'simulated_fill',
        markMatchPenaltyBpsAtOpen: 15,
        markMatchStatusAtOpen: 'stale_or_missing',
      },
      context: {
        watermark: '2026-05-02T00:00:00.000Z',
        flashContextStatus: 'ok',
        featureSchemaVersion: 'paper_open_context.v3',
      },
    })
  })

  it('rejects stale volume-breakout context before opening and records a shadow open', () => {
    const profile = buildProfile()
    const account = buildAccount()
    const signal = buildExecutableSignal()
    const gate = buildGate()
    gate.context.validUntil = '1970-01-01T00:00:00.000Z'

    openNewPositions(profile, account, [signal as ReturnType<typeof evaluateVolumeBreakout>], gate)

    expect(account.positions).toEqual([])
    expect(account.tradeHistory).toEqual([])
    expect(appendPaperPolicyShadowOpen).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendPaperPolicyShadowOpen).mock.calls[0][0]).toMatchObject({
      eventType: 'open',
      lane: 'volume_breakout_1x',
      symbol: 'BTC-USDT',
      blockReasons: expect.arrayContaining([
        'features_not_available_at_decision_time',
        'context_status:stale',
        'flash_context_status:stale',
      ]),
      context: {
        contextStatus: 'stale',
        flashContextStatus: 'stale',
      },
    })
  })

  it('rejects missing flash confidence before opening and records a shadow open', () => {
    const profile = buildProfile()
    const account = buildAccount()
    const signal = buildExecutableSignal()
    const gate = buildGate()
    gate.context.flashConfidenceByLane = {}

    openNewPositions(profile, account, [signal as ReturnType<typeof evaluateVolumeBreakout>], gate)

    expect(account.positions).toEqual([])
    expect(account.tradeHistory).toEqual([])
    expect(appendPaperPolicyShadowOpen).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendPaperPolicyShadowOpen).mock.calls[0][0]).toMatchObject({
      eventType: 'open',
      lane: 'volume_breakout_1x',
      symbol: 'BTC-USDT',
      blockReasons: expect.arrayContaining([
        'missing_flashConfidenceLowAtOpen',
      ]),
      context: {
        contextStatus: 'ok',
        flashContextStatus: 'ok',
        flashConfidenceLowAtOpen: null,
        featureSchemaVersion: 'paper_open_context.v3',
      },
    })
  })

  it('surfaces invalid v3 context when rejected volume-breakout shadow append fails', () => {
    vi.mocked(appendPaperPolicyShadowOpen).mockReturnValueOnce({
      appended: false,
      shadowId: 'shadow-1',
      reason: 'invalid_v3_context',
      missingContextFields: ['flashConfidenceLowAtOpen'],
    })

    const appendResult = recordRejectedVolumeBreakoutSignalShadowOpenForTest(
      buildProfile(),
      buildExecutableSignal() as ReturnType<typeof evaluateVolumeBreakout>,
      'profile_min_confidence',
      {
        ...buildGate().context,
        flashConfidenceByLane: {},
      },
    )

    expect(appendResult).toMatchObject({
      appended: false,
      reason: 'invalid_v3_context',
      missingContextFields: ['flashConfidenceLowAtOpen'],
    })
  })
})

function buildProfile() {
  return {
    id: 'spot_1x',
    label: 'Spot 1x baseline',
    leverage: 1,
    positionFraction: 0.1,
    maxPositions: 3,
  }
}

function buildAccount() {
  return {
    equity: 100_000,
    initialEquity: 100_000,
    positions: [],
    tradeHistory: [],
  }
}

function buildGate() {
  return {
    allowNew: true,
    reasons: [],
    context: {
      ...createBootstrapMarketIntelContext(new Date('2026-05-02T00:00:00.000Z')),
      contextGeneration: 42,
      validUntil: '2099-05-02T00:05:00.000Z',
      riskMode: 'risk_on' as const,
      allowNewPositionsByLane: {
        cross_sectional: true,
        volume_breakout_1x: true,
        volume_breakout_3x: true,
        microstructure_10x: false,
        microstructure_100x: false,
      },
      coldStartRoundsRemaining: 0,
      sourceEpoch: { flashEpoch: 7, proEpoch: 9, newsEpoch: 11 },
      flashConfidenceByLane: {
        volume_breakout_1x: { confidence: 0.72, confidenceLow: 0.61, confidenceHigh: 0.84 },
      },
      trigger: 'cached_market_intel',
    },
    fuse: {
      generatedAt: '2026-05-02T00:00:00.000Z',
      status: 'ok',
      reason: null,
    },
  }
}

function buildExecutableSignal() {
  return {
    symbol: 'BTC-USDT',
    signal: 1 as const,
    confidence: 0.62,
    barTime: Date.parse('2026-05-02T00:00:00.000Z'),
    entryPrice: 100,
    volumeRatio: 12.5,
    rangeBreakoutPct: 2.75,
    breakQuality: 0.82,
    liquidityUsd: 2_500_000,
    liquidityStatus: 'pass' as const,
    spreadBps: 4.2,
    spreadStatus: 'pass' as const,
    stopLossPrice: 96,
    reason: 'volume breakout',
  }
}

function buildExpiryCandles(entryBarTime: number, latestClose: number) {
  return Array.from({ length: 14 }, (_, index) => ({
    timestamp: entryBarTime + index * 300_000,
    open: 100,
    high: Math.max(101, latestClose),
    low: 99,
    close: index === 13 ? latestClose : 100,
    volume: 1_000,
  }))
}

async function writePremiumIndexEvents(rows: Array<{
  symbol: string
  sourceTimestamp: string
  fetchTimestamp: string
  ingestedAt: string
  markPrice: string
}>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vb-premium-index-'))
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

function buildBreakoutCandles(options: {
  latestOpen?: number
  latestHigh?: number
  latestLow?: number
  latestClose: number
  latestVolume: number
  baselineVolume?: number
  spreadBps?: number
}) {
  const candles = Array.from({ length: 30 }, (_, index) => ({
    timestamp: 1_800_000_000_000 + index * 300_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: options.baselineVolume ?? 1_000,
  }))
  candles.push({
    timestamp: 1_800_000_000_000 + 30 * 300_000,
    open: options.latestOpen ?? 100,
    high: options.latestHigh ?? Math.max(options.latestClose, 103.5),
    low: options.latestLow ?? 99.5,
    close: options.latestClose,
    volume: options.latestVolume,
    ...(options.spreadBps === undefined ? {} : { spreadBps: options.spreadBps }),
  })
  return candles
}
