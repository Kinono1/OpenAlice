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

import {
  buildClosedPaperTradeResult,
  buildMicroSignalQualityAtOpen,
  evaluateMicroSignal,
  MICRO_PROFILES,
  assertCompleteMicroPredictedOpenEvidenceForTest,
  openMicroPositionsForTest,
  recordRejectedMicroSignalShadowOpenForTest,
  shouldAllowUngatedPaperLane,
  shouldDryRun,
  type MicroAccount,
  type MicroSignal,
  type MicroPosition,
  type MicroTrade,
  type PaperRuntimeGate,
} from './paper_trade_microstructure_stress.js'
import { appendPaperPolicyShadowOpen } from '../src/runtime/paper_policy_shadow_ledger.js'
import {
  buildPaperOpenContextSnapshot,
  paperOpenContextAcceptRejectReasons,
} from '../src/runtime/paper_open_context.js'
import { createBootstrapMarketIntelContext } from '../src/runtime/market_intel_context.js'
import { clearPaperMarkMatchSnapshotCacheForTest } from './lib/paper_mark_match.js'

describe('paper_trade_microstructure_stress', () => {
  beforeEach(() => {
    vi.mocked(appendPaperPolicyShadowOpen).mockClear()
    process.env.OPENALICE_EXTERNAL_DERIVATIVES_EVENTS_PATH = '/tmp/openalice-microstructure-no-mark.jsonl'
    clearPaperMarkMatchSnapshotCacheForTest()
    vi.useRealTimers()
  })

  afterEach(() => {
    delete process.env.OPENALICE_EXTERNAL_DERIVATIVES_EVENTS_PATH
    clearPaperMarkMatchSnapshotCacheForTest()
  })

  it('keeps 10x as paper-trade and 100x as stress-only diagnostics', () => {
    expect(MICRO_PROFILES.map(profile => ({
      id: profile.id,
      mode: profile.mode,
      cadence: profile.cadence,
      timeframe: profile.timeframe,
      strategyLane: profile.strategyLane,
      leverage: profile.leverage,
    }))).toEqual([
      {
        id: 'stress_10x',
        mode: 'paper_trade',
        cadence: 'second',
        timeframe: '1s',
        strategyLane: 'microstructure_stress',
        leverage: 10,
      },
      {
        id: 'liquidation_probe_100x',
        mode: 'stress_only',
        cadence: 'second',
        timeframe: '1s',
        strategyLane: 'microstructure_stress',
        leverage: 100,
      },
    ])
    expect(MICRO_PROFILES.find(profile => profile.id === 'liquidation_probe_100x')).toMatchObject({
      marginFraction: 0.001,
      maxPositions: 1,
      maxHoldingSeconds: 30,
      stopLossPct: 0.08,
      takeProfitPct: 0.12,
    })
  })

  it('detects 1s impulse direction from recent return and volume', () => {
    const candles = Array.from({ length: 130 }, (_, index) => {
      const timestamp = 1_800_000_000_000 + index * 1000
      const close = index < 120 ? 100 : 100 + (index - 119) * 0.02
      return {
        timestamp,
        open: close,
        high: close,
        low: close,
        close,
        volume: index < 120 ? 10 : 40,
      }
    })

    const signal = evaluateMicroSignal('BTC-USDT', candles)

    expect(signal).toMatchObject({
      symbol: 'BTC-USDT',
      direction: 'long',
    })
    expect(signal?.return30sPct).toBeGreaterThan(0.1)
    expect(signal?.volumeRatio).toBeGreaterThan(2)
    expect(signal?.liquidityUsd).toBeCloseTo(40_080)

    expect(buildMicroSignalQualityAtOpen(signal!)).toMatchObject({
      volumeRatioAtOpen: signal?.volumeRatio,
      return30sPctAtOpen: signal?.return30sPct,
      return60sPctAtOpen: signal?.return60sPct,
      microstructureConfidenceAtOpen: signal?.confidence,
      liquidityUsdAtOpen: 40_080,
      spreadStatusAtOpen: 'unknown',
    })
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

  it('preserves microstructure flash-confidence context through the shared snapshot', () => {
    const now = new Date('2026-05-02T00:00:00.000Z')
    const context = {
      ...createBootstrapMarketIntelContext(now),
      contextGeneration: 12,
      validUntil: '2026-05-02T00:05:00.000Z',
      riskMode: 'risk_on' as const,
      allowNewPositionsByLane: {
        cross_sectional: true,
        volume_breakout_1x: true,
        volume_breakout_3x: true,
        microstructure_10x: true,
        microstructure_100x: false,
      },
      coldStartRoundsRemaining: 0,
      sourceEpoch: { flashEpoch: 5, proEpoch: 8, newsEpoch: 13 },
      flashConfidenceByLane: {
        microstructure_10x: { confidence: 0.81, confidenceLow: 0.76, confidenceHigh: 0.9 },
      },
      trigger: 'cached_flash_context',
    }

    const snapshot = buildPaperOpenContextSnapshot(context, 'microstructure_10x', now)

    expect(snapshot).toMatchObject({
      contextSnapshotId: 'market_intel:schema:1:generation:12:lane:microstructure_10x:flash:5:pro:8:news:13',
      decisionTime: '2026-05-02T00:00:00.000Z',
      marketDataWatermarkAtDecisionTime: '2026-05-02T00:00:00.000Z',
      watermark: '2026-05-02T00:00:00.000Z',
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      contextGenerationAtOpen: 12,
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      contextReason: null,
      flashEpochAtOpen: 5,
      proEpochAtOpen: 8,
      flashConfidenceLowAtOpen: 0.76,
      marketIntelTriggerAtOpen: 'cached_flash_context',
    })
  })

  it('rejects microstructure v3 context when flash confidence is missing or watermark is not PIT-safe', () => {
    const now = new Date('2026-05-02T00:00:00.000Z')
    const context = {
      ...createBootstrapMarketIntelContext(now),
      contextGeneration: 12,
      generatedAt: '2026-05-02T00:00:00.000Z',
      validUntil: '2026-05-02T00:05:00.000Z',
      riskMode: 'risk_on' as const,
      allowNewPositionsByLane: {
        cross_sectional: true,
        volume_breakout_1x: true,
        volume_breakout_3x: true,
        microstructure_10x: true,
        microstructure_100x: false,
      },
      coldStartRoundsRemaining: 0,
      sourceEpoch: { flashEpoch: 5, proEpoch: 8, newsEpoch: 13 },
      flashConfidenceByLane: {},
      trigger: 'cached_flash_context',
    }
    const missingFlash = buildPaperOpenContextSnapshot(context, 'microstructure_10x', now)

    expect(paperOpenContextAcceptRejectReasons(missingFlash)).toContain('missing_flashConfidenceLowAtOpen')

    const futureWatermark = {
      ...missingFlash,
      flashConfidenceLowAtOpen: 0.76,
      marketDataWatermarkAtDecisionTime: '2026-05-02T00:00:01.000Z',
      watermark: '2026-05-02T00:00:01.000Z',
    }

    expect(paperOpenContextAcceptRejectReasons(futureWatermark)).toContain('marketDataWatermark_after_decisionTime')
  })

  it('builds close result with microstructure signal-quality fields', () => {
    const profile = MICRO_PROFILES[0]
    const position: MicroPosition = {
      symbol: 'BTC-USDT',
      direction: 'long',
      entryPrice: 100,
      quantity: 10,
      entryTime: '2026-05-02T00:00:00.000Z',
      entryBarTime: 1_800_000_000_000,
      stopLossPrice: 99.75,
      takeProfitPrice: 100.35,
      confidence: 0.73,
      accountId: profile.id,
      accountLabel: profile.label,
      leverage: profile.leverage,
      marginUsd: 1000,
      notionalUsd: 10_000,
      liquidationMovePctApprox: 10,
      contextSnapshotId: 'market_intel:schema:1:generation:12:lane:microstructure_10x:flash:5:pro:8:news:13',
      decisionTime: '2026-05-02T00:00:00.000Z',
      marketDataWatermarkAtDecisionTime: '2026-05-02T00:00:00.000Z',
      watermark: '2026-05-02T00:00:00.000Z',
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      contextGenerationAtOpen: 12,
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      contextReason: null,
      flashEpochAtOpen: 5,
      flashConfidenceLowAtOpen: 0.76,
      ruleScoreAtOpen: 0.73,
      proEpochAtOpen: 8,
      marketIntelTriggerAtOpen: 'cached_flash_context',
      volumeRatioAtOpen: 2.5,
      return30sPctAtOpen: 0.12,
      return60sPctAtOpen: 0.2,
      microstructureConfidenceAtOpen: 0.73,
      liquidityUsdAtOpen: 123_456,
      spreadStatusAtOpen: 'unknown',
      estimatedRoundTripCostPctAtOpen: 0.28,
      estimatedRoundTripCostPctOfMarginAtOpen: 2.8,
      expectedGrossEdgePctAtOpen: 0.146,
      expectedNetEdgePctAtOpen: -0.134,
      expectedEdgeSourceAtOpen: 'microstructure_impulse_pct_x_confidence_minus_paper_route_cost',
      routeCostBpsAtOpen: 28,
      roundTripCostBpsAtOpen: 28,
      markPriceAtOpen: null,
      markPriceTimestampAtOpen: null,
      matchPriceAtOpen: 100,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
    }
    const trade: MicroTrade = {
      id: 'close_stress_10x_BTC-USDT_1800000030000',
      symbol: position.symbol,
      direction: position.direction,
      entryPrice: position.entryPrice,
      exitPrice: 100.35,
      entryTime: position.entryTime,
      exitTime: '2026-05-02T00:00:30.000Z',
      quantity: position.quantity,
      pnl: 35,
      pnlPct: 0.35,
      reason: 'take_profit:0.350%',
      accountId: profile.id,
      accountLabel: profile.label,
      leverage: profile.leverage,
      marginUsd: position.marginUsd,
      notionalUsd: position.notionalUsd,
      liquidationMovePctApprox: position.liquidationMovePctApprox,
      liquidated: false,
      volumeRatioAtOpen: position.volumeRatioAtOpen,
      return30sPctAtOpen: position.return30sPctAtOpen,
      return60sPctAtOpen: position.return60sPctAtOpen,
      microstructureConfidenceAtOpen: position.microstructureConfidenceAtOpen,
      liquidityUsdAtOpen: position.liquidityUsdAtOpen,
      spreadStatusAtOpen: position.spreadStatusAtOpen,
      estimatedRoundTripCostPctAtOpen: position.estimatedRoundTripCostPctAtOpen,
      estimatedRoundTripCostPctOfMarginAtOpen: position.estimatedRoundTripCostPctOfMarginAtOpen,
      expectedGrossEdgePctAtOpen: position.expectedGrossEdgePctAtOpen,
      expectedNetEdgePctAtOpen: position.expectedNetEdgePctAtOpen,
      expectedEdgeSourceAtOpen: position.expectedEdgeSourceAtOpen,
      routeCostBpsAtOpen: position.routeCostBpsAtOpen,
      roundTripCostBpsAtOpen: position.roundTripCostBpsAtOpen,
      markPriceAtOpen: position.markPriceAtOpen,
      markPriceTimestampAtOpen: position.markPriceTimestampAtOpen,
      matchPriceAtOpen: position.matchPriceAtOpen,
      matchPriceSourceAtOpen: position.matchPriceSourceAtOpen,
      markMatchPenaltyBpsAtOpen: position.markMatchPenaltyBpsAtOpen,
      markMatchStatusAtOpen: position.markMatchStatusAtOpen,
    }

    const result = buildClosedPaperTradeResult({
      profile,
      position,
      trade,
      closeReason: 'take_profit',
      priceSource: '1s',
      priceStale: false,
      candles: [
        { timestamp: Date.parse('2026-05-02T00:00:00.000Z'), open: 100, high: 100.1, low: 99.95, close: 100, volume: 100 },
        { timestamp: Date.parse('2026-05-02T00:00:15.000Z'), open: 100, high: 100.4, low: 99.9, close: 100.2, volume: 100 },
        { timestamp: Date.parse('2026-05-02T00:00:30.000Z'), open: 100.2, high: 100.35, low: 100.1, close: 100.35, volume: 100 },
      ],
    })

    expect(result).toMatchObject({
      tradeId: trade.id,
      lane: 'microstructure_10x',
      symbol: 'BTC-USDT',
      closeReason: 'take_profit',
      priceSource: '1s',
      priceStale: false,
      contextSnapshotId: 'market_intel:schema:1:generation:12:lane:microstructure_10x:flash:5:pro:8:news:13',
      decisionTime: '2026-05-02T00:00:00.000Z',
      marketDataWatermarkAtDecisionTime: '2026-05-02T00:00:00.000Z',
      watermark: '2026-05-02T00:00:00.000Z',
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      volumeRatioAtOpen: 2.5,
      return30sPctAtOpen: 0.12,
      return60sPctAtOpen: 0.2,
      microstructureConfidenceAtOpen: 0.73,
      liquidityUsdAtOpen: 123_456,
      spreadStatusAtOpen: 'unknown',
      estimatedRoundTripCostPctAtOpen: 0.28,
      estimatedRoundTripCostPctOfMarginAtOpen: 2.8,
      expectedGrossEdgePctAtOpen: 0.146,
      expectedNetEdgePctAtOpen: -0.134,
      expectedEdgeSourceAtOpen: 'microstructure_impulse_pct_x_confidence_minus_paper_route_cost',
      routeCostBpsAtOpen: 28,
      roundTripCostBpsAtOpen: 28,
      markPriceAtOpen: null,
      markPriceTimestampAtOpen: null,
      matchPriceAtOpen: 100,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
      realizedRoundTripCostBps: null,
      realizedCostBps: null,
      fillAdjustedCostBps: null,
      fillAdjustedCostPct: null,
      costEvidenceSource: 'paper_cost_model_at_open',
      costEvidenceStatus: 'paper_model_not_exchange_reconciled',
      predictedOpenEvidenceStatus: 'ok',
      predictedOpenEvidenceReason: null,
      mfeBps: 40,
      maeBps: -10,
      timeToMfeSec: 15,
      timeToMaeSec: 15,
      timeToStopSec: null,
      mfeBeforeStop: null,
    })
  })

  it('records rejected microstructure signals into the shadow ledger with v3 context', () => {
    const profile = MICRO_PROFILES[0]
    const signal: MicroSignal = {
      symbol: 'BTC-USDT',
      direction: 'long',
      confidence: 0.1,
      price: 100,
      barTime: 1_800_000_000_000,
      return30sPct: 0.02,
      return60sPct: 0.03,
      volumeRatio: 1.1,
      liquidityUsd: 50_000,
      reason: 'weak impulse',
    }
    const context = {
      ...createBootstrapMarketIntelContext(new Date('2026-05-02T00:00:00.000Z')),
      contextGeneration: 12,
      validUntil: '2099-05-02T00:05:00.000Z',
      riskMode: 'risk_on' as const,
      allowNewPositionsByLane: {
        cross_sectional: true,
        volume_breakout_1x: true,
        volume_breakout_3x: true,
        microstructure_10x: true,
        microstructure_100x: false,
      },
      coldStartRoundsRemaining: 0,
      sourceEpoch: { flashEpoch: 5, proEpoch: 8, newsEpoch: 13 },
      flashConfidenceByLane: {
        microstructure_10x: { confidence: 0.81, confidenceLow: 0.76, confidenceHigh: 0.9 },
      },
      trigger: 'cached_flash_context',
    }

    recordRejectedMicroSignalShadowOpenForTest(profile, signal, 'profile_filter_rejected', {
      allowNew: true,
      closeMode: 'none',
      closeReason: null,
      reasons: [],
      context,
      fuse: {
        schemaVersion: 1,
        generation: 0,
        updatedAt: '2026-05-02T00:00:00.000Z',
        status: 'ok',
        reason: null,
        heartbeatAgeMs: null,
      },
      dataFreshness: { latestTs: 1_800_000_000_000, ageMs: 0, stale: false },
    })

    expect(appendPaperPolicyShadowOpen).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendPaperPolicyShadowOpen).mock.calls[0][0]).toMatchObject({
      eventType: 'open',
      lane: 'microstructure_10x',
      symbol: 'BTC-USDT',
      side: 'long',
      entryPrice: 100,
      horizonMs: 120_000,
      blockReasons: ['profile_filter_rejected'],
      context: {
        contextSnapshotId: 'market_intel:schema:1:generation:12:lane:microstructure_10x:flash:5:pro:8:news:13',
        featureSchemaVersion: 'paper_open_context.v3',
        flashContextStatus: 'ok',
        flashConfidenceLowAtOpen: 0.76,
      },
      quality: {
        microstructureConfidenceAtOpen: 0.1,
        liquidityUsdAtOpen: 50_000,
      },
      cost: {
        roundTripCostBpsAtOpen: 43,
        expectedGrossEdgePctAtOpen: 0.003,
        expectedNetEdgePctAtOpen: -0.427,
        expectedEdgeSourceAtOpen: 'microstructure_impulse_pct_x_confidence_minus_paper_route_cost',
        matchPriceAtOpen: 100,
        markMatchPenaltyBpsAtOpen: 15,
        markMatchStatusAtOpen: 'stale_or_missing',
      },
    })
  })

  it('exposes a test seam for microstructure predicted-open evidence completeness', () => {
    expect(() =>
      assertCompleteMicroPredictedOpenEvidenceForTest('position', {
        estimatedRoundTripCostPctAtOpen: 0.43,
        estimatedRoundTripCostPctOfMarginAtOpen: 4.3,
        expectedGrossEdgePctAtOpen: 0.16,
        expectedNetEdgePctAtOpen: -0.27,
        expectedEdgeSourceAtOpen: 'microstructure_impulse_pct_x_confidence_minus_paper_route_cost',
        routeCostBpsAtOpen: 43,
        roundTripCostBpsAtOpen: 43,
        matchPriceAtOpen: 100,
        matchPriceSourceAtOpen: 'simulated_fill',
        markMatchPenaltyBpsAtOpen: 15,
        markMatchStatusAtOpen: 'stale_or_missing',
      }),
    ).not.toThrow()
    expect(() =>
      assertCompleteMicroPredictedOpenEvidenceForTest('trade', {
        estimatedRoundTripCostPctAtOpen: 0.43,
        estimatedRoundTripCostPctOfMarginAtOpen: 4.3,
        expectedGrossEdgePctAtOpen: 0.16,
        expectedNetEdgePctAtOpen: -0.27,
        expectedEdgeSourceAtOpen: '',
        routeCostBpsAtOpen: 43,
        roundTripCostBpsAtOpen: 43,
        matchPriceAtOpen: 100,
        matchPriceSourceAtOpen: 'simulated_fill',
        markMatchPenaltyBpsAtOpen: 15,
        markMatchStatusAtOpen: 'stale_or_missing',
      }),
    ).toThrow('microstructure_open_trade_missing_predicted_open_evidence:expectedEdgeSourceAtOpen')
  })

  it('fails closed before persisting microstructure opens with missing predicted edge evidence', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-02T00:05:00.000Z'))
    const profile = MICRO_PROFILES[0]
    const account: MicroAccount = {
      equity: 100_000,
      initialEquity: 100_000,
      positions: [],
      tradeHistory: [],
    }
    const signal: MicroSignal = {
      symbol: 'BTC-USDT',
      direction: 'long',
      confidence: 0.8,
      price: 101,
      barTime: 1_800_000_000_000,
      return30sPct: Number.NaN,
      return60sPct: 0.1,
      volumeRatio: 3.5,
      liquidityUsd: 500_000,
      reason: 'invalid impulse bypass',
    }
    const context = {
      ...createBootstrapMarketIntelContext(new Date('2026-05-02T00:00:00.000Z')),
      contextGeneration: 12,
      validUntil: '2099-05-02T00:05:00.000Z',
      riskMode: 'risk_on' as const,
      allowNewPositionsByLane: {
        cross_sectional: true,
        volume_breakout_1x: true,
        volume_breakout_3x: true,
        microstructure_10x: true,
        microstructure_100x: false,
      },
      coldStartRoundsRemaining: 0,
      suggestedRuleThresholdByLane: {
        microstructure_10x: 0.15,
        microstructure_100x: 0.95,
      },
      sourceEpoch: { flashEpoch: 5, proEpoch: 8, newsEpoch: 13 },
      flashConfidenceByLane: {
        microstructure_10x: { confidence: 0.81, confidenceLow: 0.76, confidenceHigh: 0.9 },
      },
      trigger: 'cached_flash_context',
    }

    const result = openMicroPositionsForTest(profile, account, [signal], {
      allowNew: true,
      closeMode: 'none',
      closeReason: null,
      reasons: [],
      context,
      fuse: {
        schemaVersion: 1,
        generation: 0,
        updatedAt: '2026-05-02T00:00:00.000Z',
        status: 'ok',
        reason: null,
        heartbeatAgeMs: null,
      },
      dataFreshness: { latestTs: Date.parse('2026-05-02T00:05:00.000Z'), ageMs: 0, stale: false },
    })

    expect(result.executedTrades).toEqual([])
    expect(result.rejectedSignals).toHaveLength(1)
    expect(result.rejectedSignals[0].gateReasons).toContain('invalid_return_window')
    expect(account.positions).toEqual([])
    expect(account.tradeHistory).toEqual([])
  })

  it('persists accepted microstructure opens with full decision-time cost and edge context', async () => {
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
    const profile = MICRO_PROFILES[0]
    const account: MicroAccount = {
      equity: 100_000,
      initialEquity: 100_000,
      positions: [],
      tradeHistory: [],
    }
    const signal: MicroSignal = {
      symbol: 'BTC-USDT',
      direction: 'long',
      confidence: 0.8,
      price: 101,
      barTime: Date.parse('2026-05-02T00:05:00.000Z'),
      return30sPct: 0.2,
      return60sPct: 0.1,
      volumeRatio: 3.5,
      liquidityUsd: 500_000,
      reason: 'strong impulse',
    }
    const context = {
      ...createBootstrapMarketIntelContext(new Date('2026-05-02T00:00:00.000Z')),
      contextGeneration: 12,
      validUntil: '2099-05-02T00:05:00.000Z',
      riskMode: 'risk_on' as const,
      allowNewPositionsByLane: {
        cross_sectional: true,
        volume_breakout_1x: true,
        volume_breakout_3x: true,
        microstructure_10x: true,
        microstructure_100x: false,
      },
      coldStartRoundsRemaining: 0,
      suggestedRuleThresholdByLane: {
        microstructure_10x: 0.15,
        microstructure_100x: 0.95,
      },
      sourceEpoch: { flashEpoch: 5, proEpoch: 8, newsEpoch: 13 },
      flashConfidenceByLane: {
        microstructure_10x: { confidence: 0.81, confidenceLow: 0.76, confidenceHigh: 0.9 },
      },
      trigger: 'cached_flash_context',
    }
    const gate: PaperRuntimeGate = {
      allowNew: true,
      closeMode: 'none',
      closeReason: null,
      reasons: [],
      context,
      fuse: {
        schemaVersion: 1,
        generation: 0,
        updatedAt: '2026-05-02T00:00:00.000Z',
        status: 'ok',
        reason: null,
        heartbeatAgeMs: null,
      },
      dataFreshness: {
        latestTs: Date.parse('2026-05-02T00:05:00.000Z'),
        ageMs: 0,
        stale: false,
      },
    }

    const result = openMicroPositionsForTest(profile, account, [signal], gate)
    const persisted = JSON.parse(JSON.stringify(account)) as MicroAccount

    expect(result).toMatchObject({
      proposedOrders: [expect.objectContaining({ symbol: 'BTC-USDT' })],
      executedTrades: [expect.objectContaining({ symbol: 'BTC-USDT' })],
      rejectedSignals: [],
    })
    expect(persisted.positions[0]).toMatchObject({
      contextSnapshotId: 'market_intel:schema:1:generation:12:lane:microstructure_10x:flash:5:pro:8:news:13',
      decisionTime: '2026-05-02T00:05:00.000Z',
      marketDataWatermarkAtDecisionTime: '2026-05-02T00:00:00.000Z',
      watermark: '2026-05-02T00:00:00.000Z',
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      flashContextStatus: 'ok',
      flashConfidenceLowAtOpen: 0.76,
      ruleScoreAtOpen: 0.8,
      volumeRatioAtOpen: 3.5,
      return30sPctAtOpen: 0.2,
      return60sPctAtOpen: 0.1,
      microstructureConfidenceAtOpen: 0.8,
      liquidityUsdAtOpen: 500_000,
      spreadStatusAtOpen: 'unknown',
      estimatedRoundTripCostPctAtOpen: 1.28,
      estimatedRoundTripCostPctOfMarginAtOpen: 12.8,
      expectedGrossEdgePctAtOpen: 0.16,
      expectedNetEdgePctAtOpen: -1.12,
      expectedEdgeSourceAtOpen: 'microstructure_impulse_pct_x_confidence_minus_paper_route_cost',
      routeCostBpsAtOpen: 128,
      roundTripCostBpsAtOpen: 128,
      markPriceAtOpen: 100,
      markPriceTimestampAtOpen: '2026-05-02T00:04:00.000Z',
      matchPriceAtOpen: 101,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 100,
      markMatchStatusAtOpen: 'ok',
    })
    expect(persisted.tradeHistory[0]).toMatchObject({
      contextSnapshotId: persisted.positions[0].contextSnapshotId,
      decisionTime: persisted.positions[0].decisionTime,
      marketDataWatermarkAtDecisionTime: persisted.positions[0].marketDataWatermarkAtDecisionTime,
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      flashContextStatus: 'ok',
      flashConfidenceLowAtOpen: 0.76,
      expectedGrossEdgePctAtOpen: 0.16,
      expectedNetEdgePctAtOpen: -1.12,
      expectedEdgeSourceAtOpen: 'microstructure_impulse_pct_x_confidence_minus_paper_route_cost',
      routeCostBpsAtOpen: 128,
      roundTripCostBpsAtOpen: 128,
      matchPriceAtOpen: 101,
      markMatchPenaltyBpsAtOpen: 100,
      markMatchStatusAtOpen: 'ok',
    })
  })

  it('uses PIT-safe premiumIndex mark evidence in rejected microstructure shadow cost', async () => {
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
    const profile = MICRO_PROFILES[0]
    const signal: MicroSignal = {
      symbol: 'BTC-USDT',
      direction: 'long',
      confidence: 0.1,
      price: 101,
      barTime: 1_800_000_000_000,
      return30sPct: 0.02,
      return60sPct: 0.03,
      volumeRatio: 1.1,
      liquidityUsd: 50_000,
      reason: 'weak impulse',
    }
    const context = {
      ...createBootstrapMarketIntelContext(new Date('2026-05-02T00:00:00.000Z')),
      contextGeneration: 12,
      validUntil: '2099-05-02T00:05:00.000Z',
      riskMode: 'risk_on' as const,
      allowNewPositionsByLane: {
        cross_sectional: true,
        volume_breakout_1x: true,
        volume_breakout_3x: true,
        microstructure_10x: true,
        microstructure_100x: false,
      },
      coldStartRoundsRemaining: 0,
      sourceEpoch: { flashEpoch: 5, proEpoch: 8, newsEpoch: 13 },
      flashConfidenceByLane: {
        microstructure_10x: { confidence: 0.81, confidenceLow: 0.76, confidenceHigh: 0.9 },
      },
      trigger: 'cached_flash_context',
    }

    recordRejectedMicroSignalShadowOpenForTest(profile, signal, 'profile_filter_rejected', {
      allowNew: true,
      closeMode: 'none',
      closeReason: null,
      reasons: [],
      context,
      fuse: {
        schemaVersion: 1,
        generation: 0,
        updatedAt: '2026-05-02T00:00:00.000Z',
        status: 'ok',
        reason: null,
        heartbeatAgeMs: null,
      },
      dataFreshness: { latestTs: 1_800_000_000_000, ageMs: 0, stale: false },
    })

    expect(vi.mocked(appendPaperPolicyShadowOpen).mock.calls[0][0]).toMatchObject({
      cost: {
        estimatedRoundTripCostPctAtOpen: 1.28,
        routeCostBpsAtOpen: 128,
        roundTripCostBpsAtOpen: 128,
        matchPriceAtOpen: 101,
        markPriceAtOpen: 100,
        markPriceTimestampAtOpen: '2026-05-02T00:04:00.000Z',
        markMatchPenaltyBpsAtOpen: 100,
        markMatchStatusAtOpen: 'ok',
      },
    })
  })
})

async function writePremiumIndexEvents(rows: Array<{
  symbol: string
  sourceTimestamp: string
  fetchTimestamp: string
  ingestedAt: string
  markPrice: string
}>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'micro-premium-index-'))
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
