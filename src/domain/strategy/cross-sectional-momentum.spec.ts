import { describe, expect, it } from 'vitest'
import {
  evaluateCrossSectionalMomentum,
  type CrossSectionalAsset,
} from './cross-sectional-momentum.js'

function asset(symbol: string, primaryReturn: number, fundingRatePct = 0): CrossSectionalAsset {
  return {
    symbol,
    currentPrice: 100,
    returns: {
      '168h': primaryReturn,
      '720h': primaryReturn * 0.5,
    },
    realizedVolPct: 25,
    avgVolume24h: 1_000_000,
    dailyVolumeUsd: 100_000_000,
    fundingRatePct,
  }
}

describe('evaluateCrossSectionalMomentum', () => {
  it('returns flat ranks when the universe is too small', () => {
    const ranks = evaluateCrossSectionalMomentum([
      asset('BTC-USDT', 5),
      asset('ETH-USDT', -4),
    ])

    expect(ranks.every(rank => rank.signal === 0)).toBe(true)
    expect(ranks[0].reason).toContain('Universe too small')
  })

  it('produces contrarian long loser and short winner signals after dispersion clears threshold', () => {
    const ranks = evaluateCrossSectionalMomentum([
      asset('A-USDT', -20, -0.03),
      asset('B-USDT', -14, -0.02),
      asset('C-USDT', -2),
      asset('D-USDT', 3),
      asset('E-USDT', 14, 0.02),
      asset('F-USDT', 21, 0.03),
    ], {
      minUniverseSize: 6,
      topN: 1,
      bottomN: 1,
      minSpreadPct: 5,
    })

    expect(ranks.find(rank => rank.symbol === 'A-USDT')).toMatchObject({
      signal: 1,
      positionFraction: 0.15,
    })
    expect(ranks.find(rank => rank.symbol === 'F-USDT')).toMatchObject({
      signal: -1,
      positionFraction: 0.15,
    })
    expect(ranks.find(rank => rank.symbol === 'A-USDT')?.confidence).toBeGreaterThan(0)
    expect(ranks.find(rank => rank.symbol === 'F-USDT')?.confidence).toBeGreaterThan(0)
  })

  it('keeps all assets flat when cross-sectional spread is too small after costs', () => {
    const ranks = evaluateCrossSectionalMomentum([
      asset('A-USDT', -1),
      asset('B-USDT', -0.5),
      asset('C-USDT', 0),
      asset('D-USDT', 0.2),
      asset('E-USDT', 0.6),
      asset('F-USDT', 1),
    ], {
      minUniverseSize: 6,
      minSpreadPct: 5,
    })

    expect(ranks.every(rank => rank.signal === 0)).toBe(true)
    expect(ranks[0].reason).toContain('below threshold')
  })

  it('filters out assets with excessive spread or insufficient USD liquidity', () => {
    const ranks = evaluateCrossSectionalMomentum([
      { ...asset('A-USDT', -20), spreadBps: 25 },
      { ...asset('B-USDT', -14), dailyVolumeUsd: 2_000_000 },
      asset('C-USDT', -2),
      asset('D-USDT', 3),
      asset('E-USDT', 14),
      asset('F-USDT', 21),
    ], {
      minUniverseSize: 4,
      topN: 1,
      bottomN: 1,
      minSpreadPct: 5,
      maxSpreadBps: 20,
      minDailyVolumeUsd: 10_000_000,
    })

    expect(ranks.find(rank => rank.symbol === 'A-USDT')).toMatchObject({
      signal: 0,
      reason: 'Filtered out (vol/liq/spread)',
    })
    expect(ranks.find(rank => rank.symbol === 'B-USDT')).toMatchObject({
      signal: 0,
      reason: 'Filtered out (vol/liq/spread)',
    })
    expect(ranks.some(rank => Math.abs(rank.signal) === 1)).toBe(true)
  })
})
