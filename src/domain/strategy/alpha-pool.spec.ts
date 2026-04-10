import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
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
              featureNames: ['momentum-composite'],
              trainWindow: { start: '2023-01-01', end: '2024-01-01' },
              testWindow: { start: '2024-01-01', end: '2025-01-01' },
              oosIc: 0.08,
              costAdjustedSharpe: 1.2,
              turnover: 0.5,
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
    expect(summary.qcmCandidateCount).toBe(1)
    expect(summary.shadowOnlyCount).toBe(1)
    expect(summary.shadowEligibleCount).toBe(1)
    expect(summary.bestOosIc).toBe(0.12)
  })
})
