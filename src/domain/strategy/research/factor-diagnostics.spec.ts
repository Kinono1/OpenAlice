import { describe, it, expect } from 'vitest'
import { runFactorDiagnostics } from './factor-diagnostics.js'
import type { FactorTimeSeries } from './factor-diagnostics.js'

function makeTimestamps(count: number, startMs = 0): number[] {
  const hourMs = 60 * 60 * 1000
  return Array.from({ length: count }, (_, i) => startMs + i * hourMs)
}

describe('runFactorDiagnostics', () => {
  it('detects perfectly correlated factors (rho ~= 1)', () => {
    const n = 100
    const ts = makeTimestamps(n)
    const values = Array.from({ length: n }, (_, i) => Math.sin(i * 0.1))

    const factors: FactorTimeSeries[] = [
      { name: 'momentum', values, timestamps: ts },
      { name: 'neg-momentum', values: values.map((v) => -v), timestamps: ts },
    ]
    const returns = { values: values.map((v) => v * 0.01), timestamps: ts }

    const report = runFactorDiagnostics({
      factors,
      returns,
      icHorizons: [1],
      minSamples: 10,
    })

    expect(report.correlationMatrix).toHaveLength(1)
    expect(report.correlationMatrix[0].spearmanRho).toBeLessThan(-0.9)
    expect(report.redundantPairs).toHaveLength(1)
  })

  it('reports independent factors as non-redundant', () => {
    const n = 100
    const ts = makeTimestamps(n)
    const factorA = Array.from({ length: n }, (_, i) => Math.sin(i * 0.1))
    const factorB = Array.from({ length: n }, (_, i) => Math.cos(i * 0.3 + 2))

    const factors: FactorTimeSeries[] = [
      { name: 'alpha', values: factorA, timestamps: ts },
      { name: 'beta', values: factorB, timestamps: ts },
    ]
    const returns = { values: factorA.map((v) => v * 0.01), timestamps: ts }

    const report = runFactorDiagnostics({
      factors,
      returns,
      icHorizons: [1],
      minSamples: 10,
    })

    expect(Math.abs(report.correlationMatrix[0].spearmanRho)).toBeLessThan(0.5)
    expect(report.redundantPairs).toHaveLength(0)
  })

  it('computes ablation results', () => {
    const n = 100
    const ts = makeTimestamps(n)
    const signal = Array.from({ length: n }, (_, i) => Math.sin(i * 0.1))
    const noise = Array.from({ length: n }, () => (Math.random() - 0.5) * 0.01)

    const factors: FactorTimeSeries[] = [
      { name: 'signal', values: signal, timestamps: ts },
      { name: 'noise', values: noise, timestamps: ts },
    ]
    const returns = { values: signal.map((v) => v * 0.01), timestamps: ts }

    const report = runFactorDiagnostics({
      factors,
      returns,
      icHorizons: [1],
      minSamples: 10,
    })

    expect(report.ablationResults).toHaveLength(2)
    const signalAblation = report.ablationResults.find((a) => a.removedFactor === 'signal')!
    const noiseAblation = report.ablationResults.find((a) => a.removedFactor === 'noise')!
    expect(signalAblation.marginalContribution).toBeGreaterThan(noiseAblation.marginalContribution)
  })

  it('computes effective factor count via eigenvalue entropy', () => {
    const n = 100
    const ts = makeTimestamps(n)
    const factors: FactorTimeSeries[] = [
      { name: 'a', values: Array.from({ length: n }, (_, i) => Math.sin(i * 0.1)), timestamps: ts },
      { name: 'b', values: Array.from({ length: n }, (_, i) => Math.cos(i * 0.3 + 2)), timestamps: ts },
      { name: 'c', values: Array.from({ length: n }, (_, i) => Math.sin(i * 0.7 + 5)), timestamps: ts },
    ]
    const returns = { values: Array.from({ length: n }, () => Math.random() - 0.5), timestamps: ts }

    const report = runFactorDiagnostics({
      factors,
      returns,
      icHorizons: [1],
      minSamples: 10,
    })

    expect(report.effectiveFactorCount).toBeGreaterThan(1)
    expect(report.effectiveFactorCount).toBeLessThanOrEqual(3)
  })

  it('uses cumulative forward returns over the full horizon', () => {
    const hourMs = 60 * 60 * 1000
    const factorTimestamps = Array.from({ length: 12 }, (_, index) => index * 3 * hourMs)
    const factorValues = Array.from({ length: 12 }, (_, index) => index + 1)
    const returnTimestamps = makeTimestamps(40)
    const returnValues = Array.from({ length: 40 }, () => 0)

    for (let index = 0; index < factorTimestamps.length; index += 1) {
      const base = index * 3
      const strength = factorValues[index] * 0.001
      returnValues[base + 1] = strength * 4
      returnValues[base + 2] = -strength
    }

    const report = runFactorDiagnostics({
      factors: [{ name: 'cumulative-alpha', values: factorValues, timestamps: factorTimestamps }],
      returns: { values: returnValues, timestamps: returnTimestamps },
      icHorizons: [2],
      minSamples: 8,
    })

    expect(report.icProfiles[0]?.ic.meanIc).toBeGreaterThan(0.8)
  })
})
