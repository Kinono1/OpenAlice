import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  evaluateAlphaFactorAdmission,
  readAlphaPoolArtifactSync,
  summarizeAlphaPoolArtifact,
} from './alpha-pool.js'

describe('strategy alpha pool', () => {
  it('returns null for missing artifacts', () => {
    const artifact = readAlphaPoolArtifactSync('/tmp/openalice-missing-alpha-pool.json')
    const summary = summarizeAlphaPoolArtifact(artifact, '/tmp/openalice-missing-alpha-pool.json')

    expect(artifact).toBeNull()
    expect(summary.available).toBe(false)
    expect(summary.acceptedCount).toBe(0)
    expect(summary.runtimeAcceptedAdmissionGateFailedCount).toBe(0)
    expect(summary.shadowOnlyCount).toBe(0)
    expect(summary.shadowEligibleCount).toBe(0)
  })

  it('reads and summarizes a valid alpha pool artifact', () => {
    const dir = '/tmp/openalice-alpha-pool-test'
    const path = `${dir}/latest.json`
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path,
      JSON.stringify(
        {
          generatedAt: '2026-04-04T00:00:00Z',
          artifactVersion: 'v1',
          symbol: 'BTC/USDT:USDT',
          entries: [
            {
              alphaId: 'alpha-1',
              expression: 'factor_momentum',
              source: 'alpha_qcm',
              hypothesis: 'momentum signal should forecast continuation',
              featureNames: ['momentum-composite'],
              trainWindow: { start: '2023-01-01', end: '2024-01-01' },
              testWindow: { start: '2024-01-01', end: '2025-01-01' },
              oosIc: 0.08,
              costAdjustedSharpe: 1.2,
              turnover: 0.5,
              noveltyScore: 0.8,
              hypothesisAlignmentScore: 0.9,
              complexityScore: 0.2,
              regimeSummary: { bull: { ic: 0.1 }, shadowEligible: true },
              acceptedForRuntime: false,
            },
            {
              alphaId: 'alpha-2',
              expression: 'factor_mean_reversion',
              source: 'handcrafted',
              featureNames: ['momentum-transform'],
              trainWindow: { start: '2023-01-01', end: '2024-01-01' },
              testWindow: { start: '2024-01-01', end: '2025-01-01' },
              oosIc: 0.12,
              costAdjustedSharpe: 1.5,
              turnover: 0.2,
              regimeSummary: {},
              acceptedForRuntime: true,
            },
          ],
        },
        null,
        2,
      ),
    )

    const artifact = readAlphaPoolArtifactSync(path)
    const summary = summarizeAlphaPoolArtifact(artifact, path)

    expect(artifact?.entries).toHaveLength(2)
    expect(summary.available).toBe(true)
    expect(summary.acceptedCount).toBe(1)
    expect(summary.admissionGatePassedCount).toBe(2)
    expect(summary.admissionGateFailedCount).toBe(0)
    expect(summary.runtimeAcceptedAdmissionGateFailedCount).toBe(0)
    expect(summary.qcmCandidateCount).toBe(1)
    expect(summary.shadowOnlyCount).toBe(1)
    expect(summary.shadowEligibleCount).toBe(1)
    expect(summary.bestOosIc).toBe(0.12)
  })

  it('blocks duplicate alpha candidates without hypothesis alignment evidence', () => {
    const existing = {
      alphaId: 'existing',
      expression: 'rank(ts_mean(momentum, 24))',
      source: 'alpha_qcm' as const,
      hypothesis: 'momentum continuation',
      featureNames: ['momentum'],
      trainWindow: { start: '2023-01-01', end: '2024-01-01' },
      testWindow: { start: '2024-01-01', end: '2025-01-01' },
      oosIc: 0.05,
      costAdjustedSharpe: 1.1,
      turnover: 0.4,
      regimeSummary: {},
      acceptedForRuntime: false,
    }
    const candidate = {
      ...existing,
      alphaId: 'candidate',
      hypothesis: 'unrelated funding carry premise',
    }

    const decision = evaluateAlphaFactorAdmission(candidate, {
      existingEntries: [existing, candidate],
    })

    expect(decision.passed).toBe(false)
    expect(decision.noveltyScore).toBe(0)
    expect(decision.reasons.some((reason) => reason.includes('novelty_score'))).toBe(true)
    expect(
      decision.reasons.some((reason) => reason.includes('hypothesis_alignment_score')),
    ).toBe(true)
  })

  it('admits simple novel candidates with explicit alignment metadata', () => {
    const decision = evaluateAlphaFactorAdmission({
      alphaId: 'carry-1',
      expression: 'clip(percentile_rank(funding_8h, 180), 0.05, 0.95)',
      source: 'alpha_qcm',
      hypothesis: 'extreme funding carry predicts perp spot relative value',
      featureNames: ['funding_8h', 'perp_basis'],
      trainWindow: { start: '2023-01-01', end: '2024-01-01' },
      testWindow: { start: '2024-01-01', end: '2025-01-01' },
      oosIc: 0.09,
      costAdjustedSharpe: 1.4,
      turnover: 0.2,
      noveltyScore: 0.75,
      hypothesisAlignmentScore: 0.85,
      complexityScore: 0.25,
      regimeSummary: {},
      acceptedForRuntime: false,
    })

    expect(decision.passed).toBe(true)
    expect(decision.reasons).toEqual([])
  })
})
