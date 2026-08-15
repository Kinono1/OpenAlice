import { chmod, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  D1_RELEASE_BUNDLE_METADATA_PATH,
  D1_RELEASE_CHECK_IDS,
  DEPENDENCY_LOCK_METADATA_PATH,
  EXECUTION_PROTO_PATH,
  PIPELINE_REGISTRY_METADATA_PATH,
  SIDECAR_ENVIRONMENT_RECEIPT_PATH,
  SIDECAR_RUNTIME_CONTRACT_PATH,
  SIDECAR_RUNTIME_LOCK_PATH,
  SIDECAR_RUNTIME_WHEEL_MANIFEST_PATH,
  STRATEGY_CONFIG_METADATA_PATH,
  buildReleaseManifest,
  buildReleaseManifestV2,
  releaseManifestHash,
  type SidecarEnvironmentReceiptV1,
} from './release_manifest.js'
import {
  buildCredentialRotationReceipt,
  PRIMARY_CREDENTIAL_ROTATION_NAMES,
} from './credential_rotation.js'
import {
  activateRelease,
  activateResearchRelease,
  assertSidecarRuntimeContractReceiptBinding,
  readReleasePointer,
  REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES,
  REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES_V2,
  PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_REQUIRED,
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
  it('requires the environment receipt to match source-frozen runtime provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-runtime-contract-'))
    const path = join(root, 'release_runtime_contract.v1.json')
    const interpreterHash = 'a'.repeat(64)
    const pyvenvCfgHash = 'b'.repeat(64)
    const installedAggregate = 'c'.repeat(64)
    const baseRuntimeAggregate = 'd'.repeat(64)
    const sitePackagesAggregate = 'e'.repeat(64)
    await writeFile(path, `{"runtimeProvenance":{"baseRuntimeAggregate":"${baseRuntimeAggregate}","installedAggregate":"${installedAggregate}","interpreterSha256":"${interpreterHash}","pyvenvCfgSha256":"${pyvenvCfgHash}","sitePackagesAggregate":"${sitePackagesAggregate}","status":"frozen"}}\n`)
    const receipt: SidecarEnvironmentReceiptV1 = {
      schemaVersion: 'openalice_sidecar_environment_receipt.v1',
      contractHash: await sha256File(path),
      interpreterHash,
      pyvenvCfgHash,
      baseRuntimeAggregate,
      sitePackagesAggregate,
      installedAggregate,
      lockHash: 'f'.repeat(64),
      wheelManifestHash: '1'.repeat(64),
      protoHash: 'f'.repeat(64),
      generatedAggregate: '1'.repeat(64),
      target: {
        implementation: 'CPython', python: '3.13.5', cacheTag: 'cpython-313',
        system: 'Darwin', macosMajor: 26, machine: 'arm64',
      },
      flags: {
        paperOnly: true, liveTradingAllowed: false, liveExecutionArmed: false,
      },
      executedAt: '2026-08-15T00:00:00.000Z',
      status: 'pass',
    }
    await expect(assertSidecarRuntimeContractReceiptBinding(path, receipt))
      .resolves.toBeUndefined()

    await writeFile(path, '{"runtimeProvenance":{"baseRuntimeAggregate":null,"installedAggregate":null,"interpreterSha256":null,"pyvenvCfgSha256":null,"sitePackagesAggregate":null,"status":"unfrozen"}}\n')
    await expect(assertSidecarRuntimeContractReceiptBinding(path, {
      ...receipt,
      contractHash: await sha256File(path),
    })).rejects.toThrow('sidecar_runtime_provenance_mismatch')
  })

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

  it('rejects a superficially complete release missing one generated sidecar binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-release-sidecar-missing-'))
    const missing = 'sidecars/nautilus_paper/generated/openalice_execution_v1_pb2_grpc.py'
    await createRelease(root, COMMIT_A, { omitArtifact: missing })

    await expect(verifyReleaseDirectory(root, COMMIT_A)).rejects.toThrow(
      `execution_sidecar_release_artifact_missing:${missing}`,
    )
  })

  it('rejects a release missing the managed durable sidecar runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-release-runtime-missing-'))
    const missing = 'sidecars/nautilus_paper/runtime.py'
    await createRelease(root, COMMIT_A, { omitArtifact: missing })

    await expect(verifyReleaseDirectory(root, COMMIT_A)).rejects.toThrow(
      `execution_sidecar_release_artifact_missing:${missing}`,
    )
  })

  it('verifies a V2 PAPER_LOCAL release and uses the versioned manifest filename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-release-v2-'))
    const manifest = await createV2Release(root, COMMIT_A)

    await expect(verifyReleaseDirectory(root, COMMIT_A)).resolves.toEqual(manifest)
    expect(JSON.parse(await readFile(
      join(root, COMMIT_A, 'release_manifest.v2.json'),
      'utf8',
    ))).toEqual(manifest)
    await expect(readFile(
      join(root, COMMIT_A, 'release_manifest.v1.json'),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' })

    await createRelease(root, COMMIT_B)
    await symlink(COMMIT_B, join(root, 'current'))
    await symlink(COMMIT_A, join(root, 'previous'))
    const receiptDir = join(root, 'receipts')
    const beforeEntries = (await readdir(root)).sort()
    const receipt = await activateRelease({
      releaseRoot: root,
      releaseId: COMMIT_A,
      receiptDir,
    })
    expect(receipt).toMatchObject({
      status: 'blocked',
      action: 'activate',
      reasonCodes: [PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_REQUIRED],
    })
    expect(await readReleasePointer(root, 'current')).toBe(COMMIT_B)
    expect(await readReleasePointer(root, 'previous')).toBe(COMMIT_A)
    expect((await readdir(root)).sort()).toEqual(beforeEntries)
    await expect(readdir(receiptDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('blocks generic rollback into a V2 release without pointer or receipt side effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-v2-generic-rollback-'))
    await createV2Release(root, COMMIT_A)
    await createRelease(root, COMMIT_B)
    await symlink(COMMIT_B, join(root, 'current'))
    await symlink(COMMIT_A, join(root, 'previous'))

    const receiptDir = join(root, 'receipts')
    const beforeEntries = (await readdir(root)).sort()
    const receipt = await rollbackRelease({ releaseRoot: root, receiptDir })

    expect(receipt).toMatchObject({
      status: 'blocked',
      action: 'rollback',
      fromCommit: COMMIT_B,
      toCommit: COMMIT_A,
      reasonCodes: [PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_REQUIRED],
    })
    expect(await readReleasePointer(root, 'current')).toBe(COMMIT_B)
    expect(await readReleasePointer(root, 'previous')).toBe(COMMIT_A)
    expect((await readdir(root)).sort()).toEqual(beforeEntries)
    await expect(readdir(receiptDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows generic rollback from a V2 current release into a V1 previous release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-v2-to-v1-rollback-'))
    await createV2Release(root, COMMIT_A)
    const previousManifest = await createRelease(root, COMMIT_B)
    await symlink(COMMIT_A, join(root, 'current'))
    await symlink(COMMIT_B, join(root, 'previous'))

    const receiptDir = join(root, 'receipts')
    const receipt = await rollbackRelease({ releaseRoot: root, receiptDir })

    expect(receipt).toMatchObject({
      status: 'pass',
      action: 'rollback',
      fromCommit: COMMIT_A,
      toCommit: COMMIT_B,
      currentCommit: COMMIT_B,
      previousCommit: COMMIT_A,
      manifestHash: previousManifest.manifestHash,
    })
    expect(await readReleasePointer(root, 'current')).toBe(COMMIT_B)
    expect(await readReleasePointer(root, 'previous')).toBe(COMMIT_A)
    expect((await readdir(root)).sort()).toEqual([
      COMMIT_A,
      COMMIT_B,
      'current',
      'previous',
      'receipts',
    ].sort())
    expect(await readdir(receiptDir)).toHaveLength(1)
  })

  it('blocks V2 research activation without pointer or receipt side effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-v2-research-activation-'))
    await createV2Release(root, COMMIT_A)

    const receipt = await activateResearchRelease({
      releaseRoot: root,
      releaseId: COMMIT_A,
      receiptDir: join(root, 'receipts'),
    })

    expect(receipt).toMatchObject({
      status: 'blocked',
      action: 'activate_research',
      reasonCodes: [PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_REQUIRED],
    })
    expect(await readReleasePointer(root, 'research-current')).toBeNull()
    expect(await readdir(root)).toEqual([COMMIT_A])
  })

  it('blocks V2 research rollback without changing either pointer or writing a receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-v2-research-rollback-'))
    await createV2Release(root, COMMIT_A)
    await symlink(COMMIT_A, join(root, 'research-current'))
    await symlink(COMMIT_A, join(root, 'research-previous'))

    const receipt = await rollbackResearchRelease({
      releaseRoot: root,
      receiptDir: join(root, 'receipts'),
    })

    expect(receipt).toMatchObject({
      status: 'blocked',
      action: 'rollback_research',
      reasonCodes: [PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_REQUIRED],
    })
    expect(await readReleasePointer(root, 'research-current')).toBe(COMMIT_A)
    expect(await readReleasePointer(root, 'research-previous')).toBe(COMMIT_A)
    expect((await readdir(root)).sort()).toEqual([
      COMMIT_A,
      'research-current',
      'research-previous',
    ])
  })

  it('rejects undeclared Python test harnesses in a V2 executable closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-release-v2-test-harness-'))
    await createV2Release(root, COMMIT_A)
    const undeclared = join(
      root,
      COMMIT_A,
      'sidecars/nautilus_paper/uds_contract_test_server.py',
    )
    await writeFile(undeclared, 'raise RuntimeError("test only")\n')

    await expect(verifyReleaseDirectory(root, COMMIT_A)).rejects.toThrow(
      'release_artifact_undeclared:sidecars/nautilus_paper/uds_contract_test_server.py',
    )
  })

  it('rejects a root-level extra file in a V2 materialized release tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-release-v2-root-extra-'))
    await createV2Release(root, COMMIT_A)
    await writeFile(join(root, COMMIT_A, 'unexpected.txt'), 'not hash-bound\n')

    await expect(verifyReleaseDirectory(root, COMMIT_A)).rejects.toThrow(
      'd1_release_materialized_artifact_not_declared:unexpected.txt',
    )
  })

  it('rejects an allowlist escape even when its manifest hash and file hash are valid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-release-v2-allowlist-'))
    const manifest = await createV2Release(root, COMMIT_A)
    const path = 'src/domain/trading/brokers/ccxt/evil.ts'
    const absolutePath = join(root, COMMIT_A, path)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, 'export const evil = true\n')
    const { schemaVersion: _schemaVersion, manifestHash: _manifestHash, ...core } = manifest
    const replacedCore = {
      ...core,
      artifactHashes: {
        ...core.artifactHashes,
        [path]: await sha256File(absolutePath),
      },
    }
    const replaced = {
      schemaVersion: 'release_manifest.v2',
      manifestHash: releaseManifestHash(replacedCore),
      ...replacedCore,
    }
    await chmod(join(root, COMMIT_A, 'release_manifest.v2.json'), 0o600)
    await writeFile(
      join(root, COMMIT_A, 'release_manifest.v2.json'),
      `${JSON.stringify(replaced)}\n`,
    )

    await expect(verifyReleaseDirectory(root, COMMIT_A)).rejects.toThrow('exact allowlist')
  })

  it.each([
    'src/domain/trading/execution-lifecycle-read-model.ts',
    'src/domain/trading/execution-offline-receipt-read-model.ts',
    'src/domain/trading/execution-terminal-reducer.ts',
    'src/domain/trading/offline-execution-receipt.ts',
    'src/sidecar/execution-grpc-transport.ts',
    'sidecars/nautilus_paper/offline_effect.py',
    'sidecars/nautilus_paper/offline_execution.py',
    'sidecars/nautilus_paper/offline_receipt.py',
    'sidecars/nautilus_paper/offline_simulator.py',
  ])('rejects a release missing critical execution sidecar artifact %s', async (missing) => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-release-phase-b-missing-'))
    await createRelease(root, COMMIT_A, { omitArtifact: missing })

    await expect(verifyReleaseDirectory(root, COMMIT_A)).rejects.toThrow(
      `execution_sidecar_release_artifact_missing:${missing}`,
    )
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

  it('fails closed when a research rollback target is not eligible for research', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-research-rollback-admission-block-'))
    await createRelease(root, COMMIT_A, {
      admissionDecisionId: '9'.repeat(64),
      dirtyStateHash: EMPTY_DIRTY_HASH,
    })
    await createRelease(root, COMMIT_B, { dirtyStateHash: EMPTY_DIRTY_HASH })

    const current = await activateResearchRelease({
      releaseRoot: root,
      releaseId: COMMIT_B,
    })
    expect(current.status).toBe('pass')
    await symlink(COMMIT_A, join(root, 'research-previous'))

    const rollback = await rollbackResearchRelease({ releaseRoot: root })
    expect(rollback).toMatchObject({
      status: 'blocked',
      action: 'rollback_research',
      reasonCodes: ['research_release_admission_decision_must_be_null'],
    })
    expect(await readReleasePointer(root, 'research-current')).toBe(COMMIT_B)
    expect(await readReleasePointer(root, 'research-previous')).toBe(COMMIT_A)
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
  overrides: {
    admissionDecisionId?: string | null
    dirtyStateHash?: string
    omitArtifact?: string
  } = {},
) {
  const path = join(root, commit)
  await mkdir(join(path, 'dist'), { recursive: true })
  await writeFile(join(path, 'dist/main.js'), `console.log(${JSON.stringify(commit)})\n`)
  const closureFiles: Record<string, string> = {
    'scripts/runner.sh': '#!/bin/sh\n',
    'src/runtime.ts': 'export {}\n',
    'ops/pipeline.json': '{}\n',
    'default/config.json': '{}\n',
    'node_modules/.bin/tsx': '#!/bin/sh\nexec node\n',
    'package.json': '{"name":"openalice-test"}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'release-metadata/pipeline_registry.v1.json': '{"schemaVersion":"pipeline_registry.v1","entries":[]}\n',
  }
  for (const requiredPath of REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES) {
    if (requiredPath !== overrides.omitArtifact) {
      closureFiles[requiredPath] = `fixture:${requiredPath}\n`
    }
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

async function createV2Release(root: string, commit: string) {
  const path = join(root, commit)
  const builtAt = '2026-08-15T01:10:00.000Z'
  const cleanHash = EMPTY_DIRTY_HASH
  const closureFiles: Record<string, string> = {
    'package.json': '{"name":"openalice-paper-local-test"}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    [PIPELINE_REGISTRY_METADATA_PATH]: '{}\n',
    [DEPENDENCY_LOCK_METADATA_PATH]: 'lockfileVersion: 9.0\n',
    [STRATEGY_CONFIG_METADATA_PATH]: '{"paperLocal":true}\n',
    [D1_RELEASE_BUNDLE_METADATA_PATH]: '{"schemaVersion":"d1_release_bundle.v1"}\n',
  }
  for (const requiredPath of REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES_V2) {
    closureFiles[requiredPath] = `fixture:${requiredPath}\n`
  }
  closureFiles[SIDECAR_RUNTIME_CONTRACT_PATH] = '{"contract":"paper-local"}\n'
  closureFiles[SIDECAR_RUNTIME_LOCK_PATH] = 'locked runtime\n'
  closureFiles[SIDECAR_RUNTIME_WHEEL_MANIFEST_PATH] = 'wheel manifest\n'
  closureFiles[EXECUTION_PROTO_PATH] = 'syntax = "proto3";\n'
  closureFiles['dist/proto/openalice_execution_v1.proto'] =
    closureFiles[EXECUTION_PROTO_PATH]!

  const validationReceipts = D1_RELEASE_CHECK_IDS.map((checkId, index) => {
    const receiptPath = `release-metadata/validation-receipts/${checkId}.validation_receipt.v1.json`
    closureFiles[receiptPath] = `${JSON.stringify({ checkId, status: 'pass' })}\n`
    return { checkId, receiptPath, index }
  })
  for (const [relativePath, content] of Object.entries(closureFiles)) {
    await mkdir(dirname(join(path, relativePath)), { recursive: true })
    await writeFile(join(path, relativePath), content)
  }

  const contractHash = await sha256File(join(path, SIDECAR_RUNTIME_CONTRACT_PATH))
  const lockHash = await sha256File(join(path, SIDECAR_RUNTIME_LOCK_PATH))
  const wheelManifestHash = await sha256File(
    join(path, SIDECAR_RUNTIME_WHEEL_MANIFEST_PATH),
  )
  const protoHash = await sha256File(join(path, EXECUTION_PROTO_PATH))
  const environmentReceipt = {
    schemaVersion: 'openalice_sidecar_environment_receipt.v1' as const,
    contractHash,
    interpreterHash: '1'.repeat(64),
    pyvenvCfgHash: '2'.repeat(64),
    baseRuntimeAggregate: '4'.repeat(64),
    sitePackagesAggregate: '5'.repeat(64),
    installedAggregate: '3'.repeat(64),
    lockHash,
    wheelManifestHash,
    protoHash,
    generatedAggregate: '4'.repeat(64),
    target: {
      implementation: 'CPython' as const,
      python: '3.13.5' as const,
      cacheTag: 'cpython-313' as const,
      system: 'Darwin' as const,
      macosMajor: 26 as const,
      machine: 'arm64' as const,
    },
    flags: {
      paperOnly: true as const,
      liveTradingAllowed: false as const,
      liveExecutionArmed: false as const,
    },
    executedAt: '2026-08-15T00:59:00.000Z',
    status: 'pass' as const,
  }
  await mkdir(dirname(join(path, SIDECAR_ENVIRONMENT_RECEIPT_PATH)), {
    recursive: true,
  })
  await writeFile(
    join(path, SIDECAR_ENVIRONMENT_RECEIPT_PATH),
    `${JSON.stringify(environmentReceipt)}\n`,
  )
  const environmentReceiptHash = await sha256File(
    join(path, SIDECAR_ENVIRONMENT_RECEIPT_PATH),
  )

  const artifactHashes: Record<string, string> = {}
  for (const relativePath of Object.keys(closureFiles)) {
    artifactHashes[relativePath] = await sha256File(join(path, relativePath))
  }
  artifactHashes[SIDECAR_ENVIRONMENT_RECEIPT_PATH] = environmentReceiptHash
  const receiptBindings = await Promise.all(validationReceipts.map(async ({
    checkId,
    receiptPath,
  }) => ({
    checkId,
    path: receiptPath,
    receiptHash: await sha256File(join(path, receiptPath)),
    sourceCommit: commit,
    dirtyStateHash: cleanHash,
    executedAt: '2026-08-15T01:00:00.000Z',
    expiresAt: '2026-08-15T02:00:00.000Z',
    status: 'pass' as const,
  })))
  const manifest = buildReleaseManifestV2({
    releaseId: commit,
    sourceCommit: commit,
    dirtyStateHash: cleanHash,
    builtAt,
    runtimeEntry: 'ops/release/launch_nautilus_paper.sh',
    artifactHashes,
    pipelineRegistryHash: artifactHashes[PIPELINE_REGISTRY_METADATA_PATH]!,
    dependencyLockHash: artifactHashes[DEPENDENCY_LOCK_METADATA_PATH]!,
    strategyConfigHash: artifactHashes[STRATEGY_CONFIG_METADATA_PATH]!,
    validationReceipts: receiptBindings,
    sidecarEnvironment: {
      receiptPath: SIDECAR_ENVIRONMENT_RECEIPT_PATH,
      receiptHash: environmentReceiptHash,
      contractPath: SIDECAR_RUNTIME_CONTRACT_PATH,
      receipt: environmentReceipt,
    },
    admissionDecisionId: null,
    engineeringChecks: [...D1_RELEASE_CHECK_IDS],
    liveExecutionArmed: false,
  })
  await writeImmutableReleaseManifest(path, manifest)
  return manifest
}
