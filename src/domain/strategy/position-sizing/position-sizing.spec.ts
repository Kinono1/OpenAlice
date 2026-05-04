import { describe, expect, it } from 'vitest'
import { evaluateLayerLimits, fractionalKelly, volatilityTargetSize } from './index.js'

describe('strategy position sizing', () => {
  it('computes a fractional Kelly size', () => {
    const size = fractionalKelly(0.6, 1.8, 0.15)
    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThanOrEqual(1)
  })

  it('shrinks weak-edge Kelly toward prior via Bayesian shrinkage', () => {
    const size = fractionalKelly(0.45, 1.0, 0.15)
    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThan(0.15)
  })

  it('computes a capped volatility-target size', () => {
    const size = volatilityTargetSize(10, 20, 0.3)
    expect(size).toBe(0.3)
  })

  it('does not over-penalize normal crypto vol-of-vol', () => {
    const baseline = volatilityTargetSize(10, 40, 0.5)
    const withNormalVolOfVol = volatilityTargetSize(10, 40, 0.5, 30)

    expect(withNormalVolOfVol).toBeCloseTo(baseline)
  })

  it('shrinks only elevated vol-of-vol above the crypto baseline', () => {
    const baseline = volatilityTargetSize(30, 40, 1.0)
    const stressed = volatilityTargetSize(30, 40, 1.0, 70)

    // Baseline: 30/40 = 0.75. Stressed: 0.75 * 1/(1+55/30) ≈ 0.265
    expect(stressed).toBeLessThan(baseline)
    expect(stressed).toBeGreaterThan(0.2)
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
