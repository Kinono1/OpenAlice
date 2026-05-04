import { describe, expect, it } from 'vitest'
import { assertPIT, computeEmbargo, PITViolationError, type TimedFactorValue } from './pit-guard.js'

const now = new Date('2026-05-01T14:30:00Z')

function makeFeature(available_time: string): TimedFactorValue {
  return {
    symbol: 'BTC-USDT',
    factor: 'momentum',
    value: 1.5,
    event_time: '2026-05-01T14:00:00Z',
    available_time,
  }
}

describe('PIT Guard', () => {
  it('passes when all features available before decision', () => {
    const features = [
      makeFeature('2026-05-01T14:00:00Z'),  // 30min before decision
      makeFeature('2026-05-01T14:29:59Z'),  // 1sec before decision
    ]
    expect(() => assertPIT(features, now)).not.toThrow()
  })

  it('throws on future data leak', () => {
    const features = [makeFeature('2026-05-01T15:00:00Z')]  // 30min AFTER decision
    expect(() => assertPIT(features, now)).toThrow(PITViolationError)
    expect(() => assertPIT(features, now)).toThrow(/FUTURE LEAK/)
  })

  it('throws on invalid available_time', () => {
    const features = [makeFeature('not-a-date')]
    expect(() => assertPIT(features, now)).toThrow(PITViolationError)
  })

  it('allows exact equality (available == decision)', () => {
    const features = [makeFeature('2026-05-01T14:30:00Z')]
    expect(() => assertPIT(features, now)).not.toThrow()
  })

  it('empty features pass', () => {
    expect(() => assertPIT([], now)).not.toThrow()
  })
})

describe('computeEmbargo', () => {
  it('sums sequential lags (NOT max)', () => {
    const result = computeEmbargo(1, 0.5, 0.08)
    expect(result).toBeCloseTo(1.58)  // 1 + 0.5 + 0.08, not max=1
  })

  it('is always >= any single lag', () => {
    const result = computeEmbargo(24, 2, 0.1)
    expect(result).toBeGreaterThan(24)
    expect(result).toBeCloseTo(26.1)
  })
})
