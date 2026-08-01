import { describe, expect, it } from 'vitest'
import {
  buildReleaseManifest,
  validateReleaseManifest,
  type ReleaseManifestCore,
} from './release_manifest.js'

const COMMIT = '1'.repeat(40)
const HASH = '2'.repeat(64)
const BUILT_AT = '2026-08-01T12:00:00.000Z'

describe('ReleaseManifestV1', () => {
  it('binds an engineering release to source, artifacts, registry and receipts', () => {
    const manifest = buildReleaseManifest(makeCore())
    expect(validateReleaseManifest(manifest)).toEqual(manifest)
    expect(manifest.releaseId).toBe(COMMIT)
    expect(manifest.liveExecutionArmed).toBe(false)
  })

  it('rejects tampering and stale or mismatched receipts', () => {
    const manifest = buildReleaseManifest(makeCore())
    expect(() => validateReleaseManifest({
      ...manifest,
      runtimeEntry: 'dist/other.js',
    })).toThrow()

    expect(() => buildReleaseManifest({
      ...makeCore(),
      validationReceipts: [{
        ...makeCore().validationReceipts[0],
        sourceCommit: '3'.repeat(40),
      }],
    })).toThrow('sourceCommit mismatch')
  })

  it('forbids unsafe paths and any armed engineering release', () => {
    expect(() => buildReleaseManifest({
      ...makeCore(),
      runtimeEntry: '../dist/main.js',
      artifactHashes: { '../dist/main.js': HASH },
    })).toThrow('safe relative path')

    expect(() => buildReleaseManifest({
      ...makeCore(),
      liveExecutionArmed: true,
    } as never)).toThrow()
  })
})

function makeCore(): ReleaseManifestCore {
  return {
    releaseId: COMMIT,
    sourceCommit: COMMIT,
    dirtyStateHash: HASH,
    builtAt: BUILT_AT,
    runtimeEntry: 'dist/main.js',
    artifactHashes: {
      'dist/main.js': '3'.repeat(64),
      'package.json': '4'.repeat(64),
    },
    pipelineRegistryHash: '5'.repeat(64),
    dependencyLockHash: '6'.repeat(64),
    strategyConfigHash: '7'.repeat(64),
    validationReceipts: [{
      checkId: 'typescript',
      path: 'runtime/control-plane/receipts/typescript.json',
      receiptHash: '8'.repeat(64),
      sourceCommit: COMMIT,
      dirtyStateHash: HASH,
      executedAt: BUILT_AT,
      expiresAt: '2026-08-02T12:00:00.000Z',
      status: 'pass',
    }],
    admissionDecisionId: null,
    engineeringChecks: ['build', 'typecheck', 'tests'],
    liveExecutionArmed: false,
  }
}
