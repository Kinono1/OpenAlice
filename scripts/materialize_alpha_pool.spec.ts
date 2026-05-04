import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { strategySchema } from '../src/core/config.js'
import { summarizeAlphaPoolArtifact } from '../src/domain/strategy/alpha-pool.js'
import {
  buildRuntimeAlphaPoolArtifact,
  materializeRuntimeAlphaPool,
} from './materialize_alpha_pool.ts'

describe('materialize_alpha_pool', () => {
  it('builds a runtime alpha admission artifact from configured handcrafted factors', () => {
    const artifact = buildRuntimeAlphaPoolArtifact({
      config: strategySchema.parse({}),
      symbol: 'BTC/USD',
      generatedAt: '2026-04-28T00:00:00.000Z',
    })
    const summary = summarizeAlphaPoolArtifact(artifact, 'memory://alpha-pool')

    expect(artifact.artifactVersion).toBe('v1')
    expect(artifact.symbol).toBe('BTC/USD')
    expect(summary.available).toBe(true)
    expect(summary.totalCandidates).toBeGreaterThan(0)
    expect(summary.acceptedCount).toBeGreaterThan(0)
    expect(summary.runtimeAcceptedAdmissionGateFailedCount).toBe(0)
    expect(
      artifact.entries.find((entry) => entry.alphaId === 'runtime_factor_cross_timeframe_vol_divergence_v2')
        ?.acceptedForRuntime,
    ).toBe(false)
  })

  it('writes the alpha pool artifact to disk for validation evidence consumption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-alpha-pool-'))
    const output = join(root, 'latest.json')
    const result = await materializeRuntimeAlphaPool({
      output,
      symbol: 'runtime-test',
      includeDisabled: true,
      selfCheck: false,
    })
    const persisted = JSON.parse(await readFile(output, 'utf-8')) as {
      artifactVersion: string
      symbol: string
      entries: unknown[]
    }

    expect(result.output).toBe(output)
    expect(result.runtimeAdmissionFailures).toEqual([])
    expect(persisted.artifactVersion).toBe('v1')
    expect(persisted.symbol).toBe('runtime-test')
    expect(persisted.entries.length).toBe(result.summary.totalCandidates)
  })
})
