import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveRuntimePaths } from './runtime-paths.js'
import {
  loadSystemStatus,
  serializeSystemStatus,
  systemStatusV1Schema,
} from './system_status.js'

async function makeRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'openalice-system-status-'))
  return {
    root,
    runtime: resolveRuntimePaths({
      repoRoot: root,
      osTmpDir: tmpdir(),
      env: {
        OPENALICE_RUNTIME_ROLE: 'test',
        OPENALICE_TEST_ROOT: root,
      },
    }),
  }
}

describe('SystemStatusV1', () => {
  it('fails closed when release and executed receipts are missing', async () => {
    const { runtime } = await makeRuntime()
    const now = new Date('2026-08-01T00:00:00.000Z')
    const status = await loadSystemStatus({ runtime, now })

    expect(systemStatusV1Schema.parse(status)).toEqual(status)
    expect(status.statusSource).toBe('missing')
    expect(status.release.evidenceTrust).toBe('blocked')
    expect(status.release.runtimeRole).toBe('test')
    expect(status.scheduler.owner).toBeNull()
    expect(status.admission.paperTradingAllowed).toBe(false)
    expect(status.admission.liveTradingAllowed).toBe(false)
    expect(status.admission.liveExecutionArmed).toBe(false)
    expect(status.sidecars.map((sidecar) => sidecar.status)).toEqual(['unknown', 'unknown'])
    expect(JSON.parse(serializeSystemStatus(status))).toEqual(status)
  })

  it('recomputes market-data age and never trusts a stale report label', async () => {
    const { root, runtime } = await makeRuntime()
    const freshnessPath = join(root, 'freshness.json')
    await writeFile(freshnessPath, JSON.stringify({
      directories: [
        {
          timeframe: '1h',
          status: 'fresh',
          commonLatestTimestamp: Date.parse('2026-07-31T20:00:00.000Z'),
          maxAgeMsAllowed: 2 * 60 * 60 * 1000,
        },
      ],
    }))

    const status = await loadSystemStatus({
      runtime,
      freshnessPath,
      now: new Date('2026-08-01T00:00:00.000Z'),
    })

    expect(status.dataFreshness.market_1h.status).toBe('stale')
    expect(status.dataFreshness.market_1h.ageMs).toBe(4 * 60 * 60 * 1000)
    expect(status.dataFreshness.market_5m.status).toBe('missing')
  })

  it('reports registry coverage from unique registered entrypoints', async () => {
    const { root, runtime } = await makeRuntime()
    const registryPath = join(root, 'pipeline_registry.v1.json')
    await mkdir(join(root, 'unused'), { recursive: true })
    await writeFile(registryPath, JSON.stringify({
      schemaVersion: 'pipeline_registry.v1',
      entryCount: 2,
      entries: [
        { entrypoint: 'scripts/a.ts' },
        { entrypoint: 'scripts/b.ts' },
      ],
    }))

    const status = await loadSystemStatus({
      runtime,
      pipelineRegistryPath: registryPath,
      now: new Date('2026-08-01T00:00:00.000Z'),
    })

    expect(status.pipelineRegistry).toMatchObject({
      registered: 2,
      total: 2,
      coveragePct: 100,
    })
    expect(status.pipelineRegistry.registryHash).toMatch(/^[a-f0-9]{64}$/)
  })
})
