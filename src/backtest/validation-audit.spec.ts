import { describe, it, expect } from 'vitest'
import { pruneCandidates } from './candidate-pruning.js'
import { computeAcfEmbargo } from './acf-embargo.js'

describe('pruneCandidates', () => {
  it('preserves effectiveTrialCount as total generated', () => {
    const good = Array.from({ length: 100 }, () => 0.01 + Math.random() * 0.005)
    const bad = Array.from({ length: 100 }, () => -0.01 + Math.random() * 0.005)
    const result = pruneCandidates({ candidateReturns: [good, bad] })

    expect(result.totalGeneratedCandidates).toBe(2)
    expect(result.effectiveTrialCount).toBe(2)
    expect(result.survivingIndices).toContain(0)
  })

  it('prunes candidates with negative median subsample Sharpe', () => {
    const good = Array.from({ length: 200 }, () => 0.02 + Math.random() * 0.01)
    const noise = Array.from({ length: 200 }, () => (Math.random() - 0.5) * 0.1)
    const bad = Array.from({ length: 200 }, () => -0.03 + Math.random() * 0.01)

    const result = pruneCandidates({ candidateReturns: [good, noise, bad] })
    expect(result.totalGeneratedCandidates).toBe(3)
    expect(result.survivingIndices).toContain(0)
    expect(result.survivingIndices).not.toContain(2)
  })
})

describe('computeAcfEmbargo', () => {
  it('returns short embargo for uncorrelated series', () => {
    const series = Array.from({ length: 500 }, () => Math.random() - 0.5)
    const result = computeAcfEmbargo({ factorSeries: [series] })

    expect(result.embargoBars).toBeGreaterThanOrEqual(1)
    expect(result.embargoBars).toBeLessThanOrEqual(72)
    expect(result.method).toBe('acf_adaptive')
  })

  it('returns longer embargo for autocorrelated series', () => {
    const series: number[] = [0]
    for (let i = 1; i < 500; i++) {
      series.push(series[i - 1] * 0.95 + (Math.random() - 0.5) * 0.1)
    }
    const result = computeAcfEmbargo({ factorSeries: [series] })
    expect(result.embargoBars).toBeGreaterThan(1)
  })

  it('respects min and max bounds', () => {
    const series = Array.from({ length: 500 }, () => Math.random())
    const result = computeAcfEmbargo({
      factorSeries: [series],
      minEmbargoBars: 24,
      maxEmbargoBars: 72,
    })
    expect(result.embargoBars).toBeGreaterThanOrEqual(24)
    expect(result.embargoBars).toBeLessThanOrEqual(72)
  })
})
