import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finalizeCanaryObservation } from './finalize_canary_observation.js'

const RELEASE_ID = 'a'.repeat(40)
const EMPTY_DIRTY_STATE_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function validStart(root: string) {
  return {
    schemaVersion: 'canary_observation_start.v1',
    status: 'observing',
    observedAt: '2026-08-08T00:00:00.000Z',
    releaseId: RELEASE_ID,
    sourceCommit: RELEASE_ID,
    sourceKind: 'verified_release',
    dirtyStateHash: EMPTY_DIRTY_STATE_HASH,
    manifestHash: 'b'.repeat(64),
    runtimeRole: 'canary',
    process: { pid: 123, entry: `${root}/${RELEASE_ID}/dist/main.js` },
    release: {
      releaseRoot: resolve(root),
      releasePath: resolve(root, RELEASE_ID),
      canaryReleaseRoot: resolve(root),
    },
    paths: {
      state: resolve(root, 'state'),
      artifact: resolve(root, 'artifact'),
      log: resolve(root, 'log'),
      sharedDataInput: resolve(root, 'input'),
    },
    ports: { web: 4102, mcp: 4101, primaryWeb: 3002, primaryMcp: 3001 },
    capabilities: {
      ownsCron: false,
      initializesAccounts: false,
      orderSubmissionPathEnabled: false,
      writesPromotion: false,
      writesSharedData: false,
    },
    isolation: {
      configReadOnly: true,
      telegramEnabled: false,
      cronOwner: false,
      executionAllowed: false,
      productionPointersTouched: false,
    },
    evidenceRefs: [],
  }
}

describe('finalize_canary_observation', () => {
  it('rejects an invalid observation identity before touching release state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-canary-finalize-invalid-'))
    const start = join(root, 'start.json')
    const monitor = join(root, 'monitor.jsonl')
    await writeFile(start, JSON.stringify({ schemaVersion: 'canary_observation_start.v1', status: 'observing' }))
    await writeFile(monitor, '')

    await expect(finalizeCanaryObservation({
      startPath: start,
      monitorPath: monitor,
      releaseRoot: root,
      releaseId: RELEASE_ID,
      outputPath: join(root, 'receipt.json'),
    })).rejects.toThrow('canary_observation_start_identity_invalid')
  })

  it('fails closed when the monitor has not emitted a completion record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-canary-finalize-incomplete-'))
    const start = join(root, 'start.json')
    const monitor = join(root, 'monitor.jsonl')
    await writeFile(start, JSON.stringify(validStart(root)))
    await writeFile(monitor, '')

    await expect(finalizeCanaryObservation({
      startPath: start,
      monitorPath: monitor,
      releaseRoot: root,
      releaseId: RELEASE_ID,
      outputPath: join(root, 'receipt.json'),
    })).rejects.toThrow('canary_observation_window_not_complete')
  })

  it('does not treat a missing completion duration as a completed window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-canary-finalize-duration-'))
    const start = join(root, 'start.json')
    const monitor = join(root, 'monitor.jsonl')
    await writeFile(start, JSON.stringify(validStart(root)))
    const observation = (observedAt: string) => ({
      schemaVersion: 'canary_observation.v1',
      observedAt,
      pid: 123,
      expectedPid: 123,
      listenerCount: 1,
      webHealthHttp: 200,
      mcpUnauthHttp: 401,
      cwd: resolve(root, RELEASE_ID),
      processCommand: `${resolve(root, RELEASE_ID)}/dist/main.js`,
      releasePath: resolve(root, RELEASE_ID),
      releaseManifestHash: 'b'.repeat(64),
      releaseManifestVerified: true,
      inputTreeHash: EMPTY_DIRTY_STATE_HASH,
      inputTreeUnchanged: true,
      rssBytes: 1024,
      resourceAnomaly: false,
      writableOpenPaths: [],
      unexpectedWritePaths: [],
      logIdentityValid: true,
      representativeTaskStatus: 'pass',
      pidStable: true,
      crashDetected: false,
    })
    await writeFile(monitor, [
      observation('2026-08-08T00:00:01.000Z'),
      observation('2026-08-08T00:01:01.000Z'),
      {
        schemaVersion: 'canary_monitor_completion.v1',
        status: 'observation_window_elapsed',
        completedAt: '2026-08-09T00:00:00.000Z',
        durationSeconds: 86_399,
        releasePath: resolve(root, RELEASE_ID),
        pid: 123,
      },
    ].map((value) => JSON.stringify(value)).join('\n') + '\n')

    await expect(finalizeCanaryObservation({
      startPath: start,
      monitorPath: monitor,
      releaseRoot: root,
      releaseId: RELEASE_ID,
      outputPath: join(root, 'receipt.json'),
    })).rejects.toThrow('canary_observation_completion_less_than_24h')
  })
})
