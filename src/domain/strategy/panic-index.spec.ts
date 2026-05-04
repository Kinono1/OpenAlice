import { describe, expect, it } from 'vitest'
import { computePanicIndex, type PanicIndexInput } from './panic-index.js'

const NORMAL_INPUT: PanicIndexInput = {
  impliedVolPct: 55,
  fundingRateAnnualized: 0.04,
  realizedVolPercentile: 0.4,
  orderBookImbalance: 0,
  stablecoinFlowRatio: 0,
  drawdownFromAthPct: 12,
  volumeSurgeRatio: 1.5,
  liquidationRatio: 0.01,
}

describe('computePanicIndex', () => {
  it('maps normal conditions to a non-risk-off regime', () => {
    const result = computePanicIndex(NORMAL_INPUT)

    expect(result.panicIndex).toBeGreaterThanOrEqual(0)
    expect(result.panicIndex).toBeLessThan(75)
    expect(result.tradingSignal).not.toBe('risk_off')
  })

  it('maps severe stress to risk_off', () => {
    const result = computePanicIndex({
      impliedVolPct: 140,
      fundingRateAnnualized: -0.5,
      realizedVolPercentile: 0.99,
      orderBookImbalance: -0.9,
      stablecoinFlowRatio: -0.1,
      drawdownFromAthPct: 55,
      volumeSurgeRatio: 5,
      liquidationRatio: 0.2,
    })

    expect(result.regime).toBe('extreme_fear')
    expect(result.tradingSignal).toBe('risk_off')
  })

  it('fails closed to risk_off when required inputs are non-finite', () => {
    expect(computePanicIndex({
      ...NORMAL_INPUT,
      impliedVolPct: Number.NaN,
    })).toMatchObject({
      panicIndex: 100,
      regime: 'extreme_fear',
      tradingSignal: 'risk_off',
    })
  })
})
