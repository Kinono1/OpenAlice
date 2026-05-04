import { describe, expect, it } from 'vitest'
import { evaluateMultiAssetBreakout, evaluateVolumeBreakout } from './volume-breakout.js'

function candles(overrides: Partial<{
  latestOpen: number
  latestHigh: number
  latestLow: number
  latestClose: number
  latestVolume: number
  baselineVolume: number
  spreadBps: number
  liquidityUsd: number
}> = {}) {
  const baselineVolume = overrides.baselineVolume ?? 100
  const bars: Array<{
    timestamp: number
    open: number
    high: number
    low: number
    close: number
    volume: number
    quoteVolumeUsd?: number
    liquidityUsd?: number
    spreadBps?: number
  }> = Array.from({ length: 30 }, (_, index) => ({
    timestamp: index * 300_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: baselineVolume,
    quoteVolumeUsd: baselineVolume * 100,
  }))
  bars.push({
    timestamp: 30 * 300_000,
    open: overrides.latestOpen ?? 101,
    high: overrides.latestHigh ?? 104,
    low: overrides.latestLow ?? 100,
    close: overrides.latestClose ?? 103,
    volume: overrides.latestVolume ?? 500,
    quoteVolumeUsd: (overrides.latestVolume ?? 500) * (overrides.latestClose ?? 103),
    liquidityUsd: overrides.liquidityUsd,
    spreadBps: overrides.spreadBps,
  })
  return bars
}

describe('evaluateVolumeBreakout', () => {
  it('emits a long breakout only when volume, quality, liquidity, and spread pass', () => {
    const signal = evaluateVolumeBreakout('BTC-USDT', candles({
      latestVolume: 1_000,
      liquidityUsd: 1_000_000,
      spreadBps: 8,
    }), {
      volumeMultiplier: 2,
      minVolumeUsd: 100_000,
      minBreakQuality: 0.35,
      maxSpreadBps: 20,
    })

    expect(signal).toMatchObject({
      symbol: 'BTC-USDT',
      signal: 1,
      liquidityStatus: 'pass',
      spreadStatus: 'pass',
    })
    expect(signal.breakQuality).toBeGreaterThanOrEqual(0.35)
    expect(signal.stopLossPrice).toBeLessThan(signal.entryPrice)
  })

  it('blocks explicit wide spread even when the breakout is otherwise strong', () => {
    const signal = evaluateVolumeBreakout('BTC-USDT', candles({
      latestVolume: 1_000,
      liquidityUsd: 1_000_000,
      spreadBps: 80,
    }), {
      volumeMultiplier: 2,
      maxSpreadBps: 20,
    })

    expect(signal.signal).toBe(0)
    expect(signal.spreadStatus).toBe('fail')
    expect(signal.reason).toContain('Spread')
  })

  it('sorts multi-asset breakouts by confidence', () => {
    const signals = evaluateMultiAssetBreakout([
      { symbol: 'LOW-USDT', candles: candles({ latestClose: 102, latestVolume: 500, liquidityUsd: 1_000_000 }) },
      { symbol: 'HIGH-USDT', candles: candles({ latestClose: 104, latestVolume: 1_000, liquidityUsd: 1_000_000 }) },
    ], {
      volumeMultiplier: 2,
      minVolumeUsd: 100_000,
      minBreakQuality: 0.35,
    })

    expect(signals.map(signal => signal.symbol)).toEqual(['HIGH-USDT', 'LOW-USDT'])
  })
})
