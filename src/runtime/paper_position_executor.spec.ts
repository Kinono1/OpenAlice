import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { PaperPositionExecutor, buildGateVerdict } from './paper_position_executor.js'
import type { ExecutorPosition, ExecutorClosedTrade, UnifiedSignal, ExecutorCallbacks, TradeProfile } from '../domain/strategy/paper_executor_types.js'
import type { MarketIntelContext } from './market_intel_context.js'
import type { SystemFuseState } from './system_fuse.js'

// ==================== Helpers ====================

function fakeCandles(count: number, startPrice = 100, startTime = 1_800_000_000_000): Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: startTime + i * 300_000,
    open: startPrice,
    high: startPrice * 1.01,
    low: startPrice * 0.99,
    close: startPrice,
    volume: 1_000,
  }))
}

function makeSignal(overrides: Partial<UnifiedSignal> = {}): UnifiedSignal {
  return {
    symbol: 'BTC-USDT',
    direction: 'long',
    entryPrice: 100,
    confidence: 0.5,
    barTime: 1_800_000_000_000,
    reason: 'test signal',
    stopLossPrice: null,
    takeProfitPrice: null,
    strategyData: {},
    ...overrides,
  }
}

function makeProfile(overrides: Partial<TradeProfile> = {}): TradeProfile {
  return {
    id: 'test_1x',
    label: 'Test 1x',
    leverage: 1,
    maxPositionFraction: 0.1,
    maxPositions: 3,
    stopLossPct: 0.03,
    takeProfitPct: null,
    maxHoldingBars: 6,
    ...overrides,
  }
}

function makeEmptyAccount() {
  return { equity: 100_000, initialEquity: 100_000, positions: [] as ExecutorPosition[], tradeHistory: [] as unknown[] }
}

function makeContext(overrides: Partial<MarketIntelContext> = {}): MarketIntelContext {
  return {
    contextGeneration: 1,
    validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    riskMode: 'risk_on',
    newsRiskRegime: 'normal',
    semanticValidation: { passed: true },
    coldStartRoundsRemaining: 0,
    bannedSymbols: [],
    allowNewPositionsByLane: {
      cross_sectional: true,
      volume_breakout_1x: true,
      volume_breakout_3x: true,
      microstructure_10x: true,
      microstructure_100x: false,
    },
    flashConfidenceByLane: {},
    suggestedRuleThresholdByLane: {},
    sourceEpoch: { flashEpoch: 0, proEpoch: 0, newsEpoch: 0 },
    trigger: 'test',
    ...overrides,
  } as MarketIntelContext
}

function makeFuse(overrides: Partial<SystemFuseState> = {}): SystemFuseState {
  return { generatedAt: new Date().toISOString(), status: 'ok', reason: null, ...overrides } as SystemFuseState
}

// ==================== buildGateVerdict Tests ====================

describe('buildGateVerdict', () => {
  it('returns allow_new when everything is nominal', () => {
    const verdict = buildGateVerdict(
      { id: 'test', leverage: 1 },
      makeContext(),
      makeFuse(),
      null,
      { lane: 'cross_sectional' },
    )
    expect(verdict.mode).toBe('allow_new')
    expect(verdict.allowNew).toBe(true)
    expect(verdict.reasons).toEqual([])
  })

  it('hard_closes on system fuse risk_off', () => {
    const verdict = buildGateVerdict(
      { id: 'test', leverage: 1 },
      makeContext(),
      makeFuse({ status: 'risk_off', reason: 'circuit_breaker' }),
      null,
      { lane: 'cross_sectional' },
    )
    expect(verdict.mode).toBe('hard_close')
    expect(verdict.allowNew).toBe(false)
    expect(verdict.reasons[0]).toContain('system_fuse')
  })

  it('hard_closes on severe news', () => {
    const verdict = buildGateVerdict(
      { id: 'test', leverage: 1 },
      makeContext({ newsRiskRegime: 'severe' }),
      makeFuse(),
      null,
      { lane: 'cross_sectional' },
    )
    expect(verdict.mode).toBe('hard_close')
    expect(verdict.reasons).toContain('severe_news')
  })

  it('close_only on stale context', () => {
    const verdict = buildGateVerdict(
      { id: 'test', leverage: 1 },
      makeContext({ validUntil: '2020-01-01T00:00:00.000Z' }),
      makeFuse(),
      null,
      { lane: 'cross_sectional' },
    )
    expect(verdict.mode).toBe('close_only')
    expect(verdict.allowNew).toBe(false)
  })

  it('close_only on stale data freshness', () => {
    const verdict = buildGateVerdict(
      { id: 'test', leverage: 1 },
      makeContext(),
      makeFuse(),
      { stale: true, ageMs: 600_000 },
      { lane: 'cross_sectional' },
    )
    expect(verdict.mode).toBe('close_only')
    expect(verdict.reasons[0]).toContain('stale_data')
  })

  it('close_only when lane is not allowed', () => {
    const verdict = buildGateVerdict(
      { id: 'test', leverage: 1 },
      makeContext({
        allowNewPositionsByLane: {
          cross_sectional: false,
          volume_breakout_1x: true,
          volume_breakout_3x: true,
          microstructure_10x: true,
          microstructure_100x: false,
        },
      }),
      makeFuse(),
      null,
      { lane: 'cross_sectional' },
    )
    expect(verdict.mode).toBe('close_only')
  })
})

// ==================== Executor Tests ====================

describe('PaperPositionExecutor', () => {
  const callbacks: ExecutorCallbacks = {
    buildTradeResult: () => {},
    recordShadowOpen: () => {},
  }

  async function createExecutor() {
    const tmpDir = await mkdtemp(join(tmpdir(), 'executor-test-'))
    return new PaperPositionExecutor(tmpDir, tmpDir, callbacks)
  }

  function makeOptions(overrides: Record<string, unknown> = {}) {
    const now = new Date()
    return {
      gate: { mode: 'allow_new' as const, reasons: [] },
      marketData: new Map([['BTC-USDT', fakeCandles(20)]]),
      now,
      nowIso: now.toISOString(),
      nowMs: now.getTime(),
      ...overrides,
    }
  }

  // ---- closePositions ----

  it('closes positions on stop loss (long)', async () => {
    const executor = await createExecutor()
    const account = makeEmptyAccount()
    const price = 90 // >3% down from 100 entry
    const marketData = new Map([['BTC-USDT', fakeCandles(2, price)]])
    const pos: ExecutorPosition = {
      symbol: 'BTC-USDT', direction: 'long', entryPrice: 100, quantity: 1,
      entryTime: new Date().toISOString(), entryBarTime: 1_800_000_000_000,
      stopLossPrice: 95, takeProfitPrice: null, confidence: 0.5,
      profileId: 'test_1x', accountId: 'test_1x', leverage: 1,
      marginUsd: 10_000, notionalUsd: 10_000,
      contextSnapshotId: null, decisionTime: null, marketDataWatermarkAtDecisionTime: null, watermark: null,
      featuresAvailableAtDecisionTime: null, featureSchemaVersion: null, contextGenerationAtOpen: null,
      contextStatus: null, flashContextStatus: null, contextReason: null, flashEpochAtOpen: null,
      flashConfidenceLowAtOpen: null, proEpochAtOpen: null, marketIntelTriggerAtOpen: null,
      estimatedRoundTripCostPctAtOpen: null, estimatedRoundTripCostPctOfMarginAtOpen: null,
      expectedGrossEdgePctAtOpen: null, expectedNetEdgePctAtOpen: null, expectedEdgeSourceAtOpen: null,
      routeCostBpsAtOpen: null, roundTripCostBpsAtOpen: null, markPriceAtOpen: null,
      markPriceTimestampAtOpen: null, matchPriceAtOpen: null, matchPriceSourceAtOpen: null,
      markMatchPenaltyBpsAtOpen: null, markMatchStatusAtOpen: null,
      volumeRatioAtOpen: null, rangeBreakoutPctAtOpen: null, breakQualityAtOpen: null,
      liquidityUsdAtOpen: null, liquidityStatusAtOpen: null, spreadBpsAtOpen: null, spreadStatusAtOpen: null,
      return30sPctAtOpen: null, return60sPctAtOpen: null, microstructureConfidenceAtOpen: null,
      strategyData: {},
    }
    account.positions.push(pos)

    const trades = executor.closePositions(account, makeProfile(), {
      ...makeOptions(), marketData,
    })

    expect(trades).toHaveLength(1)
    expect(trades[0].reason).toBe('stop_loss')
    expect(trades[0].pnl).toBeLessThan(0)
    expect(account.positions).toHaveLength(0)
  })

  it('closes positions on holding expiry (bars)', async () => {
    const executor = await createExecutor()
    const account = makeEmptyAccount()
    const pos: ExecutorPosition = {
      symbol: 'BTC-USDT', direction: 'long', entryPrice: 100, quantity: 1,
      entryTime: new Date().toISOString(), entryBarTime: 1_800_000_000_000,
      stopLossPrice: null, takeProfitPrice: null, confidence: 0.5,
      profileId: 'test_1x', accountId: 'test_1x', leverage: 1,
      marginUsd: 10_000, notionalUsd: 10_000,
      contextSnapshotId: null, decisionTime: null, marketDataWatermarkAtDecisionTime: null, watermark: null,
      featuresAvailableAtDecisionTime: null, featureSchemaVersion: null, contextGenerationAtOpen: null,
      contextStatus: null, flashContextStatus: null, contextReason: null, flashEpochAtOpen: null,
      flashConfidenceLowAtOpen: null, proEpochAtOpen: null, marketIntelTriggerAtOpen: null,
      estimatedRoundTripCostPctAtOpen: null, estimatedRoundTripCostPctOfMarginAtOpen: null,
      expectedGrossEdgePctAtOpen: null, expectedNetEdgePctAtOpen: null, expectedEdgeSourceAtOpen: null,
      routeCostBpsAtOpen: null, roundTripCostBpsAtOpen: null, markPriceAtOpen: null,
      markPriceTimestampAtOpen: null, matchPriceAtOpen: null, matchPriceSourceAtOpen: null,
      markMatchPenaltyBpsAtOpen: null, markMatchStatusAtOpen: null,
      volumeRatioAtOpen: null, rangeBreakoutPctAtOpen: null, breakQualityAtOpen: null,
      liquidityUsdAtOpen: null, liquidityStatusAtOpen: null, spreadBpsAtOpen: null, spreadStatusAtOpen: null,
      return30sPctAtOpen: null, return60sPctAtOpen: null, microstructureConfidenceAtOpen: null,
      strategyData: {},
    }
    account.positions.push(pos)

    // Create candles where entry bar is at index 0 and there are 14 bars total,
    // so barsHeld = 13 >= maxHoldingBars=6 → should close
    const candles = fakeCandles(14, 100, 1_800_000_000_000)
    const marketData = new Map([['BTC-USDT', candles]])
    const profile = makeProfile({ maxHoldingBars: 6 })

    const trades = executor.closePositions(account, profile, {
      ...makeOptions(), marketData,
    })

    expect(trades).toHaveLength(1)
    expect(trades[0].reason).toBe('holding_expired')
  })

  it('does not close positions when conditions are not met', async () => {
    const executor = await createExecutor()
    const account = makeEmptyAccount()
    const pos: ExecutorPosition = {
      symbol: 'BTC-USDT', direction: 'long', entryPrice: 100, quantity: 1,
      entryTime: new Date().toISOString(), entryBarTime: 1_800_000_000_000,
      stopLossPrice: 50, takeProfitPrice: 200, confidence: 0.5,
      profileId: 'test_1x', accountId: 'test_1x', leverage: 1,
      marginUsd: 10_000, notionalUsd: 10_000,
      contextSnapshotId: null, decisionTime: null, marketDataWatermarkAtDecisionTime: null, watermark: null,
      featuresAvailableAtDecisionTime: null, featureSchemaVersion: null, contextGenerationAtOpen: null,
      contextStatus: null, flashContextStatus: null, contextReason: null, flashEpochAtOpen: null,
      flashConfidenceLowAtOpen: null, proEpochAtOpen: null, marketIntelTriggerAtOpen: null,
      estimatedRoundTripCostPctAtOpen: null, estimatedRoundTripCostPctOfMarginAtOpen: null,
      expectedGrossEdgePctAtOpen: null, expectedNetEdgePctAtOpen: null, expectedEdgeSourceAtOpen: null,
      routeCostBpsAtOpen: null, roundTripCostBpsAtOpen: null, markPriceAtOpen: null,
      markPriceTimestampAtOpen: null, matchPriceAtOpen: null, matchPriceSourceAtOpen: null,
      markMatchPenaltyBpsAtOpen: null, markMatchStatusAtOpen: null,
      volumeRatioAtOpen: null, rangeBreakoutPctAtOpen: null, breakQualityAtOpen: null,
      liquidityUsdAtOpen: null, liquidityStatusAtOpen: null, spreadBpsAtOpen: null, spreadStatusAtOpen: null,
      return30sPctAtOpen: null, return60sPctAtOpen: null, microstructureConfidenceAtOpen: null,
      strategyData: {},
    }
    account.positions.push(pos)

    const trades = executor.closePositions(account, makeProfile({ maxHoldingBars: 20 }), makeOptions())

    expect(trades).toHaveLength(0)
    expect(account.positions).toHaveLength(1)
  })

  // ---- openPositions ----

  it('opens positions from signals', async () => {
    const executor = await createExecutor()
    const account = makeEmptyAccount()

    const opened = executor.openPositions(account, makeProfile(), [makeSignal()], makeOptions())

    expect(opened).toBe(1)
    expect(account.positions).toHaveLength(1)
    expect(account.positions[0].symbol).toBe('BTC-USDT')
    expect(account.positions[0].direction).toBe('long')
  })

  it('respects max positions', async () => {
    const executor = await createExecutor()
    const account = makeEmptyAccount()

    const opened = executor.openPositions(account, makeProfile({ maxPositions: 1 }), [
      makeSignal({ symbol: 'BTC-USDT' }),
      makeSignal({ symbol: 'ETH-USDT' }),
    ], makeOptions())

    expect(opened).toBe(1)
    expect(account.positions).toHaveLength(1)
    expect(account.positions[0].symbol).toBe('BTC-USDT')
  })

  it('prevents duplicate symbol positions', async () => {
    const executor = await createExecutor()
    const account = makeEmptyAccount()

    const opened = executor.openPositions(account, makeProfile(), [
      makeSignal({ symbol: 'BTC-USDT' }),
      makeSignal({ symbol: 'BTC-USDT' }),
    ], makeOptions())

    expect(opened).toBe(1)
    expect(account.positions).toHaveLength(1)
  })

  it('does not open when gate mode is not allow_new', async () => {
    const executor = await createExecutor()
    const account = makeEmptyAccount()

    const opened = executor.openPositions(account, makeProfile(), [makeSignal()], {
      ...makeOptions(),
      gate: { mode: 'close_only', reasons: ['test'] },
    })

    expect(opened).toBe(0)
    expect(account.positions).toHaveLength(0)
  })

  // ---- executeCycle ----

  it('executeCycle returns correct counts', async () => {
    const executor = await createExecutor()
    const account = makeEmptyAccount()
    const price = 90 // triggers stop loss at 95
    const marketData = new Map([['BTC-USDT', fakeCandles(14, price)]])
    const pos: ExecutorPosition = {
      symbol: 'BTC-USDT', direction: 'long', entryPrice: 100, quantity: 1,
      entryTime: new Date().toISOString(), entryBarTime: 1_800_000_000_000,
      stopLossPrice: 95, takeProfitPrice: null, confidence: 0.5,
      profileId: 'test_1x', accountId: 'test_1x', leverage: 1,
      marginUsd: 10_000, notionalUsd: 10_000,
      contextSnapshotId: null, decisionTime: null, marketDataWatermarkAtDecisionTime: null, watermark: null,
      featuresAvailableAtDecisionTime: null, featureSchemaVersion: null, contextGenerationAtOpen: null,
      contextStatus: null, flashContextStatus: null, contextReason: null, flashEpochAtOpen: null,
      flashConfidenceLowAtOpen: null, proEpochAtOpen: null, marketIntelTriggerAtOpen: null,
      estimatedRoundTripCostPctAtOpen: null, estimatedRoundTripCostPctOfMarginAtOpen: null,
      expectedGrossEdgePctAtOpen: null, expectedNetEdgePctAtOpen: null, expectedEdgeSourceAtOpen: null,
      routeCostBpsAtOpen: null, roundTripCostBpsAtOpen: null, markPriceAtOpen: null,
      markPriceTimestampAtOpen: null, matchPriceAtOpen: null, matchPriceSourceAtOpen: null,
      markMatchPenaltyBpsAtOpen: null, markMatchStatusAtOpen: null,
      volumeRatioAtOpen: null, rangeBreakoutPctAtOpen: null, breakQualityAtOpen: null,
      liquidityUsdAtOpen: null, liquidityStatusAtOpen: null, spreadBpsAtOpen: null, spreadStatusAtOpen: null,
      return30sPctAtOpen: null, return60sPctAtOpen: null, microstructureConfidenceAtOpen: null,
      strategyData: {},
    }
    account.positions.push(pos)

    const result = executor.executeCycle(account, makeProfile({ maxHoldingBars: 20 }), [makeSignal()], {
      ...makeOptions(), marketData,
    })

    expect(result.closedTrades).toHaveLength(1)
    expect(result.openedPositionCount).toBe(1)
    // Account should have 1 position (old one closed, new one opened)
    expect(account.positions).toHaveLength(1)
  })
})
