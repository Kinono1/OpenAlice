import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReleaseManifest } from './release_manifest.js'
import {
  buildCredentialRotationReceipt,
  PRIMARY_CREDENTIAL_ROTATION_NAMES,
} from './credential_rotation.js'
import {
  activateRelease,
  activateResearchRelease,
  readReleasePointer,
  rollbackRelease,
  rollbackResearchRelease,
  sha256File,
  verifyReleaseDirectory,
  writeImmutableReleaseManifest,
} from './release_manager.js'

const COMMIT_A = '1'.repeat(40)
const COMMIT_B = '2'.repeat(40)
const DIRTY_HASH = '3'.repeat(64)
const EMPTY_DIRTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

describe('local release manager', () => {
  it('verifies immutable releases and atomically maintains current/previous', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-release-'))
    await createRelease(root, COMMIT_A)
    await createRelease(root, COMMIT_B)
    const credentialRotationReceiptPath = await createCredentialRotationReceipt(root)

    const first = await activateRelease({
      releaseRoot: root,
      releaseId: COMMIT_A,
      credentialRotationReceiptPath,
    })
    expect(first.status).toBe('pass')
    expect(await readReleasePointer(root, 'current')).toBe(COMMIT_A)

    const second = await activateRelease({
      releaseRoot: root,
      releaseId: COMMIT_B,
      credentialRotationReceiptPath,
    })
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
    const credentialRotationReceiptPath = await createCredentialRotationReceipt(root)
    await writeFile(join(root, COMMIT_A, 'dist/main.js'), 'tampered\n')

    await expect(verifyReleaseDirectory(root, COMMIT_A)).rejects.toThrow(
      'release_artifact_hash_mismatch',
    )
    const receipt = await activateRelease({
      releaseRoot: root,
      releaseId: COMMIT_A,
      credentialRotationReceiptPath,
    })
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

  it('blocks activation without a passing credential rotation receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-release-credential-block-'))
    await createRelease(root, COMMIT_A)

    const missing = await activateRelease({ releaseRoot: root, releaseId: COMMIT_A })
    expect(missing).toMatchObject({
      status: 'blocked',
      reasonCodes: ['credential_rotation_receipt_missing'],
    })
    expect(await readReleasePointer(root, 'current')).toBeNull()

    const blockedPath = await createCredentialRotationReceipt(root, false)
    const blocked = await activateRelease({
      releaseRoot: root,
      releaseId: COMMIT_A,
      credentialRotationReceiptPath: blockedPath,
    })
    expect(blocked.status).toBe('blocked')
    expect(blocked.reasonCodes).toContain('credential_rotation_receipt_blocked')
    expect(await readReleasePointer(root, 'current')).toBeNull()
  })

  it('activates and rolls back research pointers without production credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-research-release-'))
    await createRelease(root, COMMIT_A, { dirtyStateHash: EMPTY_DIRTY_HASH })
    await createRelease(root, COMMIT_B, { dirtyStateHash: EMPTY_DIRTY_HASH })

    const first = await activateResearchRelease({
      releaseRoot: root,
      releaseId: COMMIT_A,
    })
    expect(first).toMatchObject({
      status: 'pass',
      action: 'activate_research',
      credentialRotationReceiptId: null,
    })
    expect(await readReleasePointer(root, 'research-current')).toBe(COMMIT_A)
    expect(await readReleasePointer(root, 'current')).toBeNull()

    const second = await activateResearchRelease({
      releaseRoot: root,
      releaseId: COMMIT_B,
    })
    expect(second.status).toBe('pass')
    expect(await readReleasePointer(root, 'research-current')).toBe(COMMIT_B)
    expect(await readReleasePointer(root, 'research-previous')).toBe(COMMIT_A)
    expect(await readReleasePointer(root, 'current')).toBeNull()

    const rollback = await rollbackResearchRelease({
      releaseRoot: root,
      drill: true,
    })
    expect(rollback).toMatchObject({
      status: 'pass',
      action: 'rollback_research_drill',
    })
    expect(await readReleasePointer(root, 'research-current')).toBe(COMMIT_A)
    expect(await readReleasePointer(root, 'research-previous')).toBe(COMMIT_B)
  })

  it('blocks the first research activation when an admission decision is bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-research-admission-block-'))
    await createRelease(root, COMMIT_A, {
      admissionDecisionId: '9'.repeat(64),
      dirtyStateHash: EMPTY_DIRTY_HASH,
    })

    const receipt = await activateResearchRelease({
      releaseRoot: root,
      releaseId: COMMIT_A,
    })
    expect(receipt).toMatchObject({
      status: 'blocked',
      action: 'activate_research',
      reasonCodes: ['research_release_admission_decision_must_be_null'],
    })
    expect(await readReleasePointer(root, 'research-current')).toBeNull()
  })

  it('fails closed for a manifest that claims live execution is armed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-research-live-block-'))
    const releasePath = join(root, COMMIT_A)
    await mkdir(join(releasePath, 'dist'), { recursive: true })
    await writeFile(join(releasePath, 'dist/main.js'), 'candidate\n')
    await writeFile(join(releasePath, 'release_manifest.v1.json'), `${JSON.stringify({
      schemaVersion: 'release_manifest.v1',
      manifestHash: 'a'.repeat(64),
      releaseId: COMMIT_A,
      sourceCommit: COMMIT_A,
      dirtyStateHash: DIRTY_HASH,
      builtAt: '2026-08-01T12:00:00.000Z',
      runtimeEntry: 'dist/main.js',
      artifactHashes: { 'dist/main.js': 'b'.repeat(64) },
      pipelineRegistryHash: '4'.repeat(64),
      dependencyLockHash: '5'.repeat(64),
      strategyConfigHash: '6'.repeat(64),
      validationReceipts: [{
        checkId: 'engineering',
        path: 'receipt.json',
        receiptHash: '7'.repeat(64),
        sourceCommit: COMMIT_A,
        dirtyStateHash: DIRTY_HASH,
        executedAt: '2026-08-01T11:59:00.000Z',
        expiresAt: '2026-08-02T12:00:00.000Z',
        status: 'pass',
      }],
      admissionDecisionId: null,
      engineeringChecks: ['build'],
      liveExecutionArmed: true,
    })}\n`)

    const receipt = await activateResearchRelease({
      releaseRoot: root,
      releaseId: COMMIT_A,
    })
    expect(receipt.status).toBe('blocked')
    expect(receipt.reasonCodes[0]).toContain('liveExecutionArmed')
    expect(await readReleasePointer(root, 'research-current')).toBeNull()
  })
})

async function createCredentialRotationReceipt(
  root: string,
  ready = true,
): Promise<string> {
  const path = join(root, ready ? 'credential-pass.json' : 'credential-blocked.json')
  const receipt = buildCredentialRotationReceipt({
    scope: 'production',
    credentialNames: [...PRIMARY_CREDENTIAL_ROTATION_NAMES],
    rotatedAt: '2026-08-01T12:00:00.000Z',
    newCredentialStored: ready,
    oldCredentialRevoked: ready ? 'yes' : 'unknown',
    argvScan: 'pass',
    plistScan: 'pass',
    logScan: 'pass',
    apiScan: 'pass',
    gitScan: 'pass',
    artifactScan: 'pass',
    fixtureScan: 'pass',
    evidenceRefs: [
      'credential_revocation:external_receipt:sha256:' + '8'.repeat(64),
    ],
  })
  await writeFile(path, `${JSON.stringify(receipt)}\n`)
  return path
}

async function createRelease(
  root: string,
  commit: string,
  overrides: { admissionDecisionId?: string | null; dirtyStateHash?: string } = {},
) {
  const path = join(root, commit)
  await mkdir(join(path, 'dist'), { recursive: true })
  await writeFile(join(path, 'dist/main.js'), `console.log(${JSON.stringify(commit)})\n`)
  const closureFiles: Record<string, string> = {
    'scripts/runner.sh': '#!/bin/sh\n',
    'src/runtime.ts': 'export {}\n',
    'ops/pipeline.json': '{}\n',
    'default/config.json': '{}\n',
    'package.json': '{"name":"openalice-test"}\n',
    'release-metadata/pipeline_registry.v1.json': '{"schemaVersion":"pipeline_registry.v1","entries":[]}\n',
  }
  for (const [relativePath, content] of Object.entries(closureFiles)) {
    await mkdir(dirname(join(path, relativePath)), { recursive: true })
    await writeFile(join(path, relativePath), content)
  }
  const artifactHashes: Record<string, string> = {
    'dist/main.js': await sha256File(join(path, 'dist/main.js')),
  }
  for (const relativePath of Object.keys(closureFiles)) {
    artifactHashes[relativePath] = await sha256File(join(path, relativePath))
  }
  const manifest = buildReleaseManifest({
    releaseId: commit,
    sourceCommit: commit,
    dirtyStateHash: overrides.dirtyStateHash ?? DIRTY_HASH,
    builtAt: '2026-08-01T12:00:00.000Z',
    runtimeEntry: 'dist/main.js',
    artifactHashes,
    pipelineRegistryHash: '4'.repeat(64),
    dependencyLockHash: '5'.repeat(64),
    strategyConfigHash: '6'.repeat(64),
    validationReceipts: [{
      checkId: 'engineering',
      path: 'receipt.json',
      receiptHash: '7'.repeat(64),
      sourceCommit: commit,
      dirtyStateHash: overrides.dirtyStateHash ?? DIRTY_HASH,
      executedAt: '2026-08-01T11:59:00.000Z',
      expiresAt: '2026-08-02T12:00:00.000Z',
      status: 'pass',
    }],
    admissionDecisionId: overrides.admissionDecisionId ?? null,
    engineeringChecks: ['build', 'typecheck', 'tests'],
    liveExecutionArmed: false,
  })
  await writeImmutableReleaseManifest(path, manifest)
  return manifest
}
