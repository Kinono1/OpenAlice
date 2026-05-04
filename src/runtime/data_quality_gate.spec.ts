import { describe, expect, it } from 'vitest'

import {
  evaluateCandleDataQuality,
  evaluateDataQualityOrderGate,
} from './data_quality_gate.js'

describe('data_quality_gate', () => {
  it('allows normal flow when data quality is good', () => {
    expect(evaluateDataQualityOrderGate({
      state: 'good',
      action: 'placeOrder',
      order: { type: 'market', reduceOnly: false },
    })).toMatchObject({
      approved: true,
      action: 'allow',
    })
  })

  it('forces cancel-only hold when data quality is bad', () => {
    const decision = evaluateDataQualityOrderGate({
      state: 'bad',
      action: 'placeOrder',
      order: { type: 'market', reduceOnly: true },
      reason: 'orderbook_stale',
    })

    expect(decision.approved).toBe(false)
    expect(decision.action).toBe('cancel_only_hold')
    expect(decision.reason).toContain('orderbook_stale')
  })

  it('allows cancellation while blind', () => {
    expect(evaluateDataQualityOrderGate({
      state: 'unknown',
      action: 'cancelOrder',
    })).toMatchObject({
      approved: true,
      action: 'cancel_only_hold',
    })
  })

  it('allows degraded reduce-only only with a protected limit and trusted price', () => {
    const allowed = evaluateDataQualityOrderGate({
      state: 'degraded',
      action: 'placeOrder',
      order: { type: 'limit', reduceOnly: true, price: 100 },
      hasIndependentTrustedPrice: true,
    })
    const marketReduce = evaluateDataQualityOrderGate({
      state: 'degraded',
      action: 'placeOrder',
      order: { type: 'market', reduceOnly: true },
      hasIndependentTrustedPrice: true,
    })

    expect(allowed).toMatchObject({
      approved: true,
      action: 'allow_reduce_with_protected_limit',
    })
    expect(marketReduce).toMatchObject({
      approved: false,
      action: 'manual_override_required',
    })
  })

  it('requires explicit manual override for bad-quality protected reduce-only orders', () => {
    const withoutOverride = evaluateDataQualityOrderGate({
      state: 'bad',
      action: 'placeOrder',
      order: { type: 'limit', reduceOnly: true, price: 100 },
      hasIndependentTrustedPrice: true,
    })
    const withOverride = evaluateDataQualityOrderGate({
      state: 'bad',
      action: 'placeOrder',
      order: { type: 'limit', reduceOnly: true, price: 100 },
      hasIndependentTrustedPrice: true,
      manualOverride: true,
    })

    expect(withoutOverride).toMatchObject({
      approved: false,
      action: 'cancel_only_hold',
    })
    expect(withOverride).toMatchObject({
      approved: true,
      action: 'allow_reduce_with_protected_limit',
    })
  })

  it('classifies coherent ascending candles as good', () => {
    const now = new Date('2026-04-29T05:00:00.000Z')
    const start = Date.parse('2026-04-29T00:00:00.000Z')
    const candles = Array.from({ length: 5 }, (_, index) => ({
      time: start + index * 3_600_000,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 1000,
    }))

    expect(evaluateCandleDataQuality('BTC-USDT', candles, {
      minBars: 5,
      now,
    })).toMatchObject({
      state: 'good',
      duplicateTimestamps: 0,
      nonMonotonicTimestamps: 0,
      invalidOhlcvCount: 0,
    })
  })

  it('blocks descending or corrupted candle streams', () => {
    const now = new Date('2026-04-29T05:00:00.000Z')
    const candles = [
      {
        time: Date.parse('2026-04-29T02:00:00.000Z'),
        open: 2026,
        high: 2026,
        low: 74_137,
        close: 74_414,
        volume: 73_866,
      },
      {
        time: Date.parse('2026-04-29T01:00:00.000Z'),
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 1000,
      },
    ]

    const report = evaluateCandleDataQuality('BTC-USDT', candles, {
      minBars: 2,
      now,
    })

    expect(report.state).toBe('bad')
    expect(report.nonMonotonicTimestamps).toBe(1)
    expect(report.invalidOhlcvCount).toBe(1)
  })

  it('flags header-shifted candles with unrealistic hourly range', () => {
    const now = new Date('2026-04-29T05:00:00.000Z')
    const report = evaluateCandleDataQuality('DOGE-USDT', [{
      time: Date.parse('2026-04-29T04:00:00.000Z'),
      open: 2026,
      high: 2026,
      low: 0.09679,
      close: 0.09782,
      volume: 0.09644,
    }], {
      minBars: 1,
      now,
    })

    expect(report.state).toBe('bad')
    expect(report.invalidOhlcvCount).toBe(1)
  })
})
