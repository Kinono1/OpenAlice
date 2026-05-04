import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  buildEvidenceId,
  canonicalizeEvidenceInput,
  evidenceIdToPathKey,
  hashEvidenceComponent,
} from './evidence_id.js'

const baseInput = {
  strategyFamily: 'low_turnover_cross_sectional_reversal',
  strategyConfigHash: 'sha256:strategy',
  dataManifestHash: 'sha256:data',
  featureSchemaHash: 'sha256:feature',
  validationProfileHash: 'sha256:validation',
  costModelHash: 'sha256:cost',
}

describe('evidence_id', () => {
  it('builds the same evidence_id for semantically identical canonical input', () => {
    const left = buildEvidenceId(baseInput)
    const right = buildEvidenceId({
      costModelHash: 'sha256:cost',
      validationProfileHash: 'sha256:validation',
      featureSchemaHash: 'sha256:feature',
      dataManifestHash: 'sha256:data',
      strategyConfigHash: 'sha256:strategy',
      strategyFamily: 'low_turnover_cross_sectional_reversal',
    })

    expect(left).toEqual(right)
    expect(left.evidenceId).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('changes when a strategy semantic hash changes', () => {
    const left = buildEvidenceId(baseInput)
    const right = buildEvidenceId({
      ...baseInput,
      strategyConfigHash: 'sha256:strategy-v2',
    })

    expect(left.evidenceId).not.toBe(right.evidenceId)
  })

  it('does not include created_at or code_commit metadata in component hashes', () => {
    const left = hashEvidenceComponent({
      ...baseInput,
      created_at: '2026-05-02T00:00:00.000Z',
      code_commit: 'commit-a',
    })
    const right = hashEvidenceComponent({
      ...baseInput,
      created_at: '2026-05-03T00:00:00.000Z',
      code_commit: 'commit-b',
    })

    expect(left).toBe(right)
  })

  it('removes volatile local absolute path fields from canonicalized input', () => {
    const canonical = canonicalizeEvidenceInput({
      candidate_id: 'candidate-1',
      localAbsolutePath: '/tmp/openalice/private/path.json',
      machine_hostname: 'devbox',
    })

    expect(canonical).toEqual({
      candidate_id: 'candidate-1',
    })
  })

  it('normalizes path-like values to repo-relative paths when possible', () => {
    const repoPath = join(process.cwd(), 'data', 'market', 'candles.csv')

    expect(canonicalizeEvidenceInput({ artifactPath: repoPath })).toEqual({
      artifactPath: 'data/market/candles.csv',
    })
  })

  it('uses raw hex as filesystem path key for sha256 evidence IDs', () => {
    const { evidenceId, hashHex } = buildEvidenceId(baseInput)

    expect(evidenceIdToPathKey(evidenceId)).toBe(hashHex)
    expect(evidenceIdToPathKey('sha256:abc')).toBe('sha256_abc')
  })
})
