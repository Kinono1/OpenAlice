import { describe, expect, it } from 'vitest'
import { computeAtrTrailingStop } from './atr-trailing-stop.js'

describe('ATR trailing stop', () => {
  it('only ratchets a long stop upward', () => {
    const first = computeAtrTrailingStop({
      side: 'long',
      price: 100,
      atr: 4,
      multiplier: 2,
    })
    const lowerCandidate = computeAtrTrailingStop({
      side: 'long',
      price: 98,
      atr: 5,
      multiplier: 2,
      previousStop: first.stop,
    })
    const higherCandidate = computeAtrTrailingStop({
      side: 'long',
      price: 112,
      atr: 3,
      multiplier: 2,
      previousStop: lowerCandidate.stop,
    })

    expect(first.stop).toBe(92)
    expect(lowerCandidate.stop).toBe(92)
    expect(lowerCandidate.tightened).toBe(false)
    expect(higherCandidate.stop).toBe(106)
    expect(higherCandidate.tightened).toBe(true)
  })

  it('only ratchets a short stop downward', () => {
    const first = computeAtrTrailingStop({
      side: 'short',
      price: 100,
      atr: 4,
      multiplier: 2,
    })
    const higherCandidate = computeAtrTrailingStop({
      side: 'short',
      price: 105,
      atr: 5,
      multiplier: 2,
      previousStop: first.stop,
    })
    const lowerCandidate = computeAtrTrailingStop({
      side: 'short',
      price: 88,
      atr: 3,
      multiplier: 2,
      previousStop: higherCandidate.stop,
    })

    expect(first.stop).toBe(108)
    expect(higherCandidate.stop).toBe(108)
    expect(higherCandidate.tightened).toBe(false)
    expect(lowerCandidate.stop).toBe(94)
  })
})
