import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { buildReleaseManifest } from '../src/runtime/release_manifest.js'

const execFileAsync = promisify(execFile)

describe('stable current release launcher', () => {
  it('verifies manifest and artifact hashes before resolving current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-launcher-'))
    const commit = '1'.repeat(40)
    const releasePath = join(root, commit)
    await mkdir(join(releasePath, 'dist'), { recursive: true })
    const entry = 'console.log("release")\n'
    await writeFile(join(releasePath, 'dist/main.js'), entry)
    const manifest = buildReleaseManifest({
      releaseId: commit,
      sourceCommit: commit,
      dirtyStateHash: '2'.repeat(64),
      builtAt: '2026-08-01T12:00:00.000Z',
      runtimeEntry: 'dist/main.js',
      artifactHashes: {
        'dist/main.js': createHash('sha256').update(entry).digest('hex'),
      },
      pipelineRegistryHash: '3'.repeat(64),
      dependencyLockHash: '4'.repeat(64),
      strategyConfigHash: '5'.repeat(64),
      validationReceipts: [{
        checkId: 'engineering',
        path: 'receipt.json',
        receiptHash: '6'.repeat(64),
        sourceCommit: commit,
        dirtyStateHash: '2'.repeat(64),
        executedAt: '2026-08-01T11:59:00.000Z',
        expiresAt: '2026-08-02T12:00:00.000Z',
        status: 'pass',
      }],
      admissionDecisionId: null,
      engineeringChecks: ['engineering'],
      liveExecutionArmed: false,
    })
    await writeFile(
      join(releasePath, 'release_manifest.v1.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    await symlink(commit, join(root, 'current'), 'dir')

    const launcher = resolve('ops/release/launch_current.mjs')
    const result = await execFileAsync(process.execPath, [launcher, '--verify-only'], {
      env: { ...process.env, OPENALICE_RELEASE_DIR: root },
    })
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'pass',
      sourceCommit: commit,
      liveExecutionArmed: false,
    })
  })

  it('fails closed when current content no longer matches the manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-launcher-tamper-'))
    const commit = '1'.repeat(40)
    const releasePath = join(root, commit)
    await mkdir(join(releasePath, 'dist'), { recursive: true })
    await writeFile(join(releasePath, 'dist/main.js'), 'tampered\n')
    const manifest = buildReleaseManifest({
      releaseId: commit,
      sourceCommit: commit,
      dirtyStateHash: '2'.repeat(64),
      builtAt: '2026-08-01T12:00:00.000Z',
      runtimeEntry: 'dist/main.js',
      artifactHashes: { 'dist/main.js': '3'.repeat(64) },
      pipelineRegistryHash: '4'.repeat(64),
      dependencyLockHash: '5'.repeat(64),
      strategyConfigHash: '6'.repeat(64),
      validationReceipts: [{
        checkId: 'engineering',
        path: 'receipt.json',
        receiptHash: '7'.repeat(64),
        sourceCommit: commit,
        dirtyStateHash: '2'.repeat(64),
        executedAt: '2026-08-01T11:59:00.000Z',
        expiresAt: '2026-08-02T12:00:00.000Z',
        status: 'pass',
      }],
      admissionDecisionId: null,
      engineeringChecks: ['engineering'],
      liveExecutionArmed: false,
    })
    await writeFile(join(releasePath, 'release_manifest.v1.json'), JSON.stringify(manifest))
    await symlink(commit, join(root, 'current'), 'dir')

    await expect(execFileAsync(process.execPath, [
      resolve('ops/release/launch_current.mjs'),
      '--verify-only',
    ], {
      env: { ...process.env, OPENALICE_RELEASE_DIR: root },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('release_artifact_hash_mismatch'),
    })
  })
})
