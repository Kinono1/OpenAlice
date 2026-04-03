import { describe, expect, it } from 'vitest'
import { buildStrategyExecutionDecision } from './execution.js'
import type { RuntimeFactorSnapshot } from './runtime-evaluator.js'

function makeSnapshot(overrides?: Partial<RuntimeFactorSnapshot>): RuntimeFactorSnapshot {
  return {
    symbol: 'BTC/USDT:USDT',
    factorSignals: [],
    governance: {
      actionStatus: 'attack-lite',
      baseActionStatus: 'attack-lite',
      cappedByEventWindow: false,
      staleDataApplied: false,
      breakdown: {
        totalScore: 75,
        sourceQualityScore: 20,
        marketStructureScore: 20,
        eventSafetyScore: 15,
        sentimentAlignmentScore: 10,
        executionClarityScore: 10,
      },
      context: {
        eventWindowFrozen: false,
        eventSeverity: 'none',
      },
    },
    ensemble: {
      signals: [],
      weights: {},
      aggregateValue: 0.7,
      aggregateConfidence: 0.7,
      consensusScore: 1,
      decisionStrength: 'D2',
    },
    freeze: {
      active: false,
      marketScope: 'crypto',
      activeWindows: [],
      maxActionDuringFreeze: undefined,
    },
    derivedMetrics: {
      return1hPct: 1,
      return6hPct: 2,
      return24hPct: 3,
      return7dPct: 4,
      currentPrice: 50000,
      currentVolume: 100,
      averageVolume: 90,
      realizedVolPct: 10,
      openInterest: 1000,
      openInterestValue: 1000000,
      liquidationCount24h: 2,
      liquidationNotional24h: 500000,
    },
    dataProvenance: {
      candles: { status: 'resolved', source: 'market-data' },
      fundingRate: { status: 'resolved', source: 'account-broker', accountId: 'bybit-main' },
      basis: { status: 'resolved', source: 'derived' },
      openInterest: { status: 'resolved', source: 'account-broker', accountId: 'bybit-main' },
      liquidation: { status: 'resolved', source: 'account-broker', accountId: 'bybit-main' },
      equity: { status: 'resolved', source: 'input' },
      referencePrice: { status: 'missing', source: 'unavailable' },
      completeness: 'full',
    },
    positionSizing: {
      allowed: true,
      maxPositionPctOfEquity: 0.3,
      recommendedPctOfEquity: 0.1,
      requestedPctOfEquity: 0.1,
      recommendedNotionalUsd: 1000,
      assetLayer: 'core',
      equity: 10000,
      method: 'fixed',
      reasons: [],
    },
    ...overrides,
  }
}

describe('buildStrategyExecutionDecision', () => {
  it('applies cap-only sizing to usd_size orders', () => {
    const decision = buildStrategyExecutionDecision({
      snapshot: makeSnapshot(),
      request: {
        symbol: 'BTC/USDT:USDT',
        side: 'buy',
        type: 'market',
        usd_size: 2500,
      },
      isNewOpen: true,
    })
    expect(decision.mode).toBe('applied')
    expect(decision.effectiveUsdSize).toBe(1000)
    expect(decision.effectiveNotionalUsd).toBe(1000)
  })

  it('never increases an order above the requested size', () => {
    const decision = buildStrategyExecutionDecision({
      snapshot: makeSnapshot({
        positionSizing: {
          ...makeSnapshot().positionSizing,
          recommendedNotionalUsd: 5000,
        },
      }),
      request: {
        symbol: 'BTC/USDT:USDT',
        side: 'buy',
        type: 'market',
        usd_size: 2500,
      },
      isNewOpen: true,
    })
    expect(decision.mode).toBe('pass-through')
    expect(decision.effectiveUsdSize).toBe(2500)
  })

  it('falls back when a size order cannot be converted without a reference price', () => {
    const decision = buildStrategyExecutionDecision({
      snapshot: makeSnapshot(),
      request: {
        symbol: 'BTC/USDT:USDT',
        side: 'buy',
        type: 'market',
        size: 0.2,
      },
      isNewOpen: true,
    })
    expect(decision.mode).toBe('fallback')
    expect(decision.fallbackReason).toContain('could not be resolved')
  })

  it('blocks new risk when governance says no-trade', () => {
    const decision = buildStrategyExecutionDecision({
      snapshot: makeSnapshot({
        governance: {
          ...makeSnapshot().governance,
          actionStatus: 'no-trade',
          baseActionStatus: 'no-trade',
        },
      }),
      request: {
        symbol: 'BTC/USDT:USDT',
        side: 'buy',
        type: 'market',
        usd_size: 2500,
      },
      isNewOpen: true,
    })
    expect(decision.mode).toBe('blocked')
    expect(decision.blockReason).toContain('no-trade')
  })

  it('passes through reduce-only orders', () => {
    const decision = buildStrategyExecutionDecision({
      snapshot: makeSnapshot({
        governance: {
          ...makeSnapshot().governance,
          actionStatus: 'no-trade',
          baseActionStatus: 'no-trade',
        },
      }),
      request: {
        symbol: 'BTC/USDT:USDT',
        side: 'sell',
        type: 'market',
        size: 0.1,
        reduceOnly: true,
      },
      isNewOpen: false,
      referencePrice: 50000,
    })
    expect(decision.mode).toBe('pass-through')
    expect(decision.effectiveSize).toBe(0.1)
  })
})
