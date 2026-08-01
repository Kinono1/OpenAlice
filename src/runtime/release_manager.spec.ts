import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReleaseManifest } from './release_manifest.js'
import {
  activateRelease,
  readReleasePointer,
  rollbackRelease,
  sha256File,
  verifyReleaseDirectory,
  writeImmutableReleaseManifest,
} from './release_manager.js'

const COMMIT_A = '1'.repeat(40)
const COMMIT_B = '2'.repeat(40)
const DIRTY_HASH = '3'.repeat(64)

describe('local release manager', () => {
  it('verifies immutable releases and atomically maintains current/previous', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-release-'))
    await createRelease(root, COMMIT_A)
    await createRelease(root, COMMIT_B)

    const first = await activateRelease({ releaseRoot: root, releaseId: COMMIT_A })
    expect(first.status).toBe('pass')
    expect(await readReleasePointer(root, 'current')).toBe(COMMIT_A)

    const second = await activateRelease({ releaseRoot: root, releaseId: COMMIT_B })
    expect(second.status).toBe('pass')
    expect(await readReleasePointer(root, 'current')).toBe(COMMIT_B)
    expect(await readReleasePointer(root, 'previous')).toBe(COMMIT_A)

    const rollback = await rollbackRelease({ releaseRoot: root, drill: true })
    expect(rollback).toMatchObject({ status: 'pass', action: 'rollback_drill' })
    expect(await readReleasePointer(root, 'current')).toBe(COMMIT_A)
    expect(await readReleasePointer(root, 'previous')).toBe(COMMIT_B)
  })

  it('blocks activation when a release artifact was tampered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-release-tamper-'))
    await createRelease(root, COMMIT_A)
    await writeFile(join(root, COMMIT_A, 'dist/main.js'), 'tampered\n')

    await expect(verifyReleaseDirectory(root, COMMIT_A)).rejects.toThrow(
      'release_artifact_hash_mismatch',
    )
    const receipt = await activateRelease({ releaseRoot: root, releaseId: COMMIT_A })
    expect(receipt.status).toBe('blocked')
    expect(await readReleasePointer(root, 'current')).toBeNull()
  })

  it('does not overwrite an existing manifest with different bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-release-immutable-'))
    const manifest = await createRelease(root, COMMIT_A)
    await expect(writeImmutableReleaseManifest(join(root, COMMIT_A), {
      ...manifest,
      engineeringChecks: ['different'],
    })).rejects.toThrow()
    expect(JSON.parse(await readFile(
      join(root, COMMIT_A, 'release_manifest.v1.json'),
      'utf8',
    ))).toEqual(manifest)
  })
})

async function createRelease(root: string, commit: string) {
  const path = join(root, commit)
  await mkdir(join(path, 'dist'), { recursive: true })
  await writeFile(join(path, 'dist/main.js'), `console.log(${JSON.stringify(commit)})\n`)
  const artifactHash = await sha256File(join(path, 'dist/main.js'))
  const manifest = buildReleaseManifest({
    releaseId: commit,
    sourceCommit: commit,
    dirtyStateHash: DIRTY_HASH,
    builtAt: '2026-08-01T12:00:00.000Z',
    runtimeEntry: 'dist/main.js',
    artifactHashes: { 'dist/main.js': artifactHash },
    pipelineRegistryHash: '4'.repeat(64),
    dependencyLockHash: '5'.repeat(64),
    strategyConfigHash: '6'.repeat(64),
    validationReceipts: [{
      checkId: 'engineering',
      path: 'receipt.json',
      receiptHash: '7'.repeat(64),
      sourceCommit: commit,
      dirtyStateHash: DIRTY_HASH,
      executedAt: '2026-08-01T11:59:00.000Z',
      expiresAt: '2026-08-02T12:00:00.000Z',
      status: 'pass',
    }],
    admissionDecisionId: null,
    engineeringChecks: ['build', 'typecheck', 'tests'],
    liveExecutionArmed: false,
  })
  await writeImmutableReleaseManifest(path, manifest)
  return manifest
}
