import { describe, it, expect } from 'vitest'
import { computeBlackLitterman, factorSignalsToBLViews } from './black-litterman.js'

const assets = ['BTC', 'ETH', 'SOL']
// Simple diagonal covariance (annualized variances)
const cov = [
  [0.09, 0,    0   ],
  [0,    0.16, 0   ],
  [0,    0,    0.25],
]
const mktWeights = [0.5, 0.3, 0.2]

describe('computeBlackLitterman', () => {
  it('returns prior returns when no views provided', () => {
    const { posteriorReturns } = computeBlackLitterman(assets, cov, mktWeights, [])
    // Prior: π = δ * Σ * w
    // BTC: 2.5 * 0.09 * 0.5 = 0.1125
    expect(posteriorReturns['BTC']).toBeCloseTo(2.5 * 0.09 * 0.5, 3)
    expect(posteriorReturns['ETH']).toBeCloseTo(2.5 * 0.16 * 0.3, 3)
    expect(posteriorReturns['SOL']).toBeCloseTo(2.5 * 0.25 * 0.2, 3)
  })

  it('posterior returns are finite for all assets', () => {
    const views = [{ assets: ['BTC'], weights: [1], expectedReturn: 0.3, confidence: 0.8 }]
    const { posteriorReturns } = computeBlackLitterman(assets, cov, mktWeights, views)
    for (const a of assets) {
      expect(Number.isFinite(posteriorReturns[a]!)).toBe(true)
    }
  })

  it('high-confidence bullish view on BTC raises BTC posterior return', () => {
    const noViews = computeBlackLitterman(assets, cov, mktWeights, [])
    const withView = computeBlackLitterman(assets, cov, mktWeights, [
      { assets: ['BTC'], weights: [1], expectedReturn: 0.5, confidence: 0.9 },
    ])
    expect(withView.posteriorReturns['BTC']!).toBeGreaterThan(noViews.posteriorReturns['BTC']!)
  })

  it('posterior variance equals diagonal covariance', () => {
    const { posteriorVariance } = computeBlackLitterman(assets, cov, mktWeights, [])
    expect(posteriorVariance['BTC']).toBeCloseTo(0.09)
    expect(posteriorVariance['ETH']).toBeCloseTo(0.16)
    expect(posteriorVariance['SOL']).toBeCloseTo(0.25)
  })

  it('relative view: long BTC / short ETH raises BTC and lowers ETH', () => {
    const noViews = computeBlackLitterman(assets, cov, mktWeights, [])
    const withView = computeBlackLitterman(assets, cov, mktWeights, [
      { assets: ['BTC', 'ETH'], weights: [1, -1], expectedReturn: 0.2, confidence: 0.7 },
    ])
    expect(withView.posteriorReturns['BTC']!).toBeGreaterThan(noViews.posteriorReturns['BTC']!)
    expect(withView.posteriorReturns['ETH']!).toBeLessThan(noViews.posteriorReturns['ETH']!)
  })
})

describe('factorSignalsToBLViews', () => {
  it('creates one view per asset', () => {
    const signals = {
      BTC: { tStat: 2.0, confidence: 0.8 },
      ETH: { tStat: -1.5, confidence: 0.6 },
    }
    const views = factorSignalsToBLViews(signals)
    expect(views).toHaveLength(2)
  })

  it('positive tStat produces positive expectedReturn', () => {
    const views = factorSignalsToBLViews({ BTC: { tStat: 3.0, confidence: 0.9 } })
    expect(views[0]!.expectedReturn).toBeGreaterThan(0)
  })

  it('negative tStat produces negative expectedReturn', () => {
    const views = factorSignalsToBLViews({ ETH: { tStat: -3.0, confidence: 0.9 } })
    expect(views[0]!.expectedReturn).toBeLessThan(0)
  })

  it('confidence is clamped to [0, 1]', () => {
    const views = factorSignalsToBLViews({ BTC: { tStat: 1.0, confidence: 1.5 } })
    expect(views[0]!.confidence).toBeLessThanOrEqual(1)
    expect(views[0]!.confidence).toBeGreaterThanOrEqual(0)
  })

  it('uses annualizedReturn when provided', () => {
    const views = factorSignalsToBLViews({ BTC: { tStat: 1.0, confidence: 0.8, annualizedReturn: 0.42 } })
    expect(views[0]!.expectedReturn).toBeCloseTo(0.42)
  })
})
