import { describe, expect, it } from 'vitest'
import { evaluateLayerLimits, fractionalKelly, volatilityTargetSize } from './index.js'

describe('strategy position sizing', () => {
  it('computes a fractional Kelly size', () => {
    const size = fractionalKelly(0.6, 1.8, 0.15)
    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThanOrEqual(1)
  })

  it('returns zero Kelly size for weak edge', () => {
    const size = fractionalKelly(0.45, 1.0, 0.15)
    expect(size).toBe(0)
  })

  it('computes a capped volatility-target size', () => {
    const size = volatilityTargetSize(10, 20, 0.3)
    expect(size).toBe(0.3)
  })

  it('allows a core-layer probe inside limits', () => {
    const decision = evaluateLayerLimits(
      {
        layer: 'core',
        maxPositions: 5,
        maxPositionPctOfEquity: 0.3,
        minActionStatusToTrade: 'probe',
        requiresCoreNotRiskOff: false,
      },
      {
        actionStatus: 'attack-lite',
        assetLayer: 'core',
        currentOpenPositions: 2,
        currentLayerOpenPositions: 2,
        equity: 100000,
      },
      0.25,
      'kelly',
    )

    expect(decision.allowed).toBe(true)
    expect(decision.recommendedPctOfEquity).toBe(0.25)
  })

  it('blocks an extended-layer trade when core is risk-off', () => {
    const decision = evaluateLayerLimits(
      {
        layer: 'extended',
        maxPositions: 3,
        maxPositionPctOfEquity: 0.15,
        minActionStatusToTrade: 'attack-lite',
        requiresCoreNotRiskOff: true,
      },
      {
        actionStatus: 'attack',
        assetLayer: 'extended',
        currentOpenPositions: 1,
        currentLayerOpenPositions: 1,
        equity: 100000,
        coreRiskOff: true,
      },
      0.1,
      'volTarget',
    )

    expect(decision.allowed).toBe(false)
    expect(decision.recommendedPctOfEquity).toBe(0)
  })
})
