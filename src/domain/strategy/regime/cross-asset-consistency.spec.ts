import { describe, expect, it } from 'vitest'
import { evaluateCrossAssetRegimeConsistency } from './cross-asset-consistency.js'

describe('cross-asset regime consistency', () => {
  it('flags high-confidence BTC/ETH systemic disagreement', () => {
    const result = evaluateCrossAssetRegimeConsistency({
      states: [
        { symbol: 'BTC/USDT:USDT', regime: 'vol-stress', confidence: 0.86 },
        { symbol: 'ETH/USDT:USDT', regime: 'trend-follow', confidence: 0.8 },
        { symbol: 'SOL/USDT:USDT', regime: 'trend-follow', confidence: 0.7 },
      ],
    })

    expect(result.consistent).toBe(false)
    expect(result.anchorDisagreement).toBe(true)
    expect(result.disagreementCount).toBeGreaterThan(0)
    expect(result.reasons.join(' ')).toContain('systemic stress')
  })

  it('does not block when only one asset has high-confidence regime evidence', () => {
    const result = evaluateCrossAssetRegimeConsistency({
      states: [
        { symbol: 'BTC', regime: 'vol-stress', confidence: 0.9 },
        { symbol: 'ETH', regime: 'trend-follow', confidence: 0.3 },
      ],
    })

    expect(result.consistent).toBe(true)
    expect(result.reasons[0]).toContain('insufficient high-confidence')
  })
})
