import { describe, it, expect } from 'vitest'
import { evaluateFundingArb, computeFundingPnl } from './funding-arb.js'

describe('evaluateFundingArb', () => {
  it('returns direction=none when yield below threshold', () => {
    const sig = evaluateFundingArb('BTC', 0.0001, [], { minAnnualizedYield: 0.10, paymentsPerYear: 1095 })
    // 0.0001 * 1095 = 0.1095 > 0.10 -> actually triggers. Use smaller rate:
    const sig2 = evaluateFundingArb('BTC', 0.00005, [], { minAnnualizedYield: 0.10, paymentsPerYear: 1095 })
    expect(sig2.direction).toBe('none')
    expect(sig2.confidence).toBe(0)
  })

  it('returns long_spot_short_perp for positive funding above threshold', () => {
    const sig = evaluateFundingArb('BTC', 0.001, [], { minAnnualizedYield: 0.10, paymentsPerYear: 1095 })
    // 0.001 * 1095 = 1.095 = 109.5% APY >> 10%
    expect(sig.direction).toBe('long_spot_short_perp')
    expect(sig.deltaNeutral).toBe(true)
    expect(sig.netAnnualizedYield).toBeCloseTo(sig.annualizedYield)
    expect(sig.confidence).toBeGreaterThan(0)
    expect(sig.annualizedYield).toBeCloseTo(1.095)
  })

  it('returns short_spot_long_perp for negative funding above threshold', () => {
    const sig = evaluateFundingArb('BTC', -0.001, [], { minAnnualizedYield: 0.10, paymentsPerYear: 1095 })
    expect(sig.direction).toBe('short_spot_long_perp')
  })

  it('detects pegged regime when consecutive extreme readings', () => {
    const extremeRates = Array(6).fill(0.001)
    const sig = evaluateFundingArb('BTC', 0.001, extremeRates, { peggedMinBars: 6 })
    expect(sig.isPegged).toBe(true)
  })

  it('does not flag pegged when rates are mixed sign', () => {
    const mixedRates = [0.001, -0.001, 0.001, -0.001, 0.001, -0.001]
    const sig = evaluateFundingArb('BTC', 0.001, mixedRates, { peggedMinBars: 6 })
    expect(sig.isPegged).toBe(false)
  })

  it('confidence is capped at 1', () => {
    const sig = evaluateFundingArb('BTC', 0.1, [], { minAnnualizedYield: 0.10, paymentsPerYear: 1095 })
    expect(sig.confidence).toBeLessThanOrEqual(1)
    expect(sig.confidence).toBeGreaterThanOrEqual(0)
  })

  it('annualizedYield = |fundingRate| * paymentsPerYear', () => {
    const sig = evaluateFundingArb('ETH', 0.0005, [], { paymentsPerYear: 1095 })
    expect(sig.annualizedYield).toBeCloseTo(0.0005 * 1095)
  })

  it('blocks funding arb when explicit carry costs consume the net yield', () => {
    const sig = evaluateFundingArb('ETH', 0.0005, [], {
      paymentsPerYear: 1095,
      minAnnualizedYield: 0.10,
      minNetAnnualizedYield: 0.20,
      annualizedCostDrag: 0.40,
    })

    expect(sig.annualizedYield).toBeCloseTo(0.5475)
    expect(sig.netAnnualizedYield).toBeCloseTo(0.1475)
    expect(sig.direction).toBe('none')
    expect(sig.reasons.some((reason) => reason.includes('net annualized yield'))).toBe(true)
  })
})

describe('computeFundingPnl', () => {
  it('positive funding with short perp yields positive PnL', () => {
    // fundingRate=0.001, perpSize=-10 (short) -> pnl = -0.001 * -10 = 0.01
    const pnl = computeFundingPnl(0.001, -10)
    expect(pnl).toBeCloseTo(0.01)
  })

  it('negative funding with long perp yields positive PnL', () => {
    // fundingRate=-0.001, perpSize=10 (long) -> pnl = -(-0.001) * 10 = 0.01
    const pnl = computeFundingPnl(-0.001, 10)
    expect(pnl).toBeCloseTo(0.01)
  })

  it('zero funding yields zero PnL', () => {
    expect(computeFundingPnl(0, -10)).toBe(0)
  })
})
