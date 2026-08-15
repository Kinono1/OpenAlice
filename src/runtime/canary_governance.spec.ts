import {
  mkdir,
  mkdtemp,
  readFile,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCredentialRotationReceipt, PRIMARY_CREDENTIAL_ROTATION_NAMES } from './credential_rotation.js'
import { buildReleaseManifest } from './release_manifest.js'
import {
  buildCanaryReadinessReceipt,
  captureSwitchPreflight,
  executeControlledSwitch,
  sha256PathTree,
  waitForCronQuiescence,
  type ControlledSwitchAdapter,
} from './canary_governance.js'
import {
  activateRelease,
  readReleasePointer,
  REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES,
  sha256File,
  writeImmutableReleaseManifest,
} from './release_manager.js'
import { resolveRuntimePaths } from './runtime-paths.js'

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)
const DIRTY_HASH = 'd'.repeat(64)

describe('canary governance', () => {
  it('requires isolated roots, alternate ports, no authority and unchanged shared data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-canary-readiness-'))
    const primaryData = join(root, 'primary-data')
    await mkdir(primaryData, { recursive: true })
    await writeFile(join(primaryData, 'snapshot.json'), '{"safe":true}\n')
    const sharedHash = await sha256PathTree(primaryData)
    const runtime = makeCanaryRuntime(root, primaryData)
    const receipt = buildCanaryReadinessReceipt({
      scope: 'isolated_test',
      generatedAt: '2026-08-01T12:00:00.000Z',
      expiresAt: '2026-08-02T12:00:00.000Z',
      releaseId: COMMIT_B,
      manifestHash: '1'.repeat(64),
      runtime,
      primaryPorts: { web: 3100, mcp: 3001 },
      observations: safeObservations(),
      sharedDataBeforeHash: sharedHash,
      sharedDataAfterHash: sharedHash,
      evidenceRefs: ['test:canary-observation'],
    })
    expect(receipt).toMatchObject({ status: 'pass', pathIsolation: 'pass' })
    expect(Object.values(receipt.capabilities)).toEqual([false, false, false, false, false])

    const mutated = buildCanaryReadinessReceipt({
      scope: 'isolated_test',
      generatedAt: '2026-08-01T12:00:00.000Z',
      expiresAt: '2026-08-02T12:00:00.000Z',
      releaseId: COMMIT_B,
      manifestHash: '1'.repeat(64),
      runtime,
      primaryPorts: { web: 3100, mcp: 3001 },
      observations: safeObservations(),
      sharedDataBeforeHash: sharedHash,
      sharedDataAfterHash: '2'.repeat(64),
      evidenceRefs: ['test:canary-observation'],
    })
    expect(mutated.status).toBe('blocked')
    expect(mutated.reasonCodes).toContain('canary_shared_data_changed')
  })

  it('captures pointers, manifests, locks, jobs, data tails and a LaunchAgent backup', async () => {
    const fixture = await createSwitchFixture('preflight')
    const snapshot = await captureSwitchPreflight({
      scope: 'isolated_test',
      releaseRoot: fixture.releaseRoot,
      lockDir: fixture.lockDir,
      jobsStatePath: fixture.jobsStatePath,
      dataTailPaths: [fixture.dataTailPath],
      launchAgentPath: fixture.launchAgentPath,
      backupDir: fixture.backupDir,
      receiptDir: fixture.receiptDir,
      capturedAt: new Date('2026-08-01T12:01:00.000Z'),
    })
    expect(snapshot).toMatchObject({
      status: 'pass',
      currentCommit: COMMIT_A,
      previousCommit: null,
      lockDirectoryObserved: true,
    })
    expect(snapshot.jobsState?.backupHash).toBe(snapshot.jobsState?.contentHash)
    expect(snapshot.launchAgent?.backupHash).toBe(snapshot.launchAgent?.contentHash)
    expect(snapshot.dataTails).toHaveLength(1)
    expect(await readFile(snapshot.launchAgent!.backupPath, 'utf8')).toContain('openalice.test')
  })

  it('waits for in-flight locks and fails closed on timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-canary-locks-'))
    const lockDir = join(root, 'locks')
    const lockPath = join(lockDir, 'cron.lock')
    await mkdir(lockDir)
    await writeFile(lockPath, 'held\n')
    await expect(waitForCronQuiescence({
      lockDir,
      timeoutMs: 20,
      pollIntervalMs: 10,
    })).rejects.toThrow('cron_quiescence_timeout')

    const release = waitForCronQuiescence({
      lockDir,
      timeoutMs: 500,
      pollIntervalMs: 10,
    })
    setTimeout(() => void unlink(lockPath), 20)
    await expect(release).resolves.toBeUndefined()
  })

  it('restores previous release after an injected post-switch failure', async () => {
    const fixture = await createSwitchFixture('rollback')
    const targetManifest = await createRelease(fixture.releaseRoot, COMMIT_B)
    const primaryData = join(fixture.root, 'primary-data')
    await mkdir(primaryData)
    await writeFile(join(primaryData, 'snapshot.json'), '{"unchanged":true}\n')
    const sharedHash = await sha256PathTree(primaryData)
    const canary = buildCanaryReadinessReceipt({
      scope: 'isolated_test',
      generatedAt: '2026-08-01T12:02:00.000Z',
      expiresAt: '2026-08-02T12:02:00.000Z',
      releaseId: COMMIT_B,
      manifestHash: targetManifest.manifestHash,
      runtime: makeCanaryRuntime(fixture.root, primaryData),
      primaryPorts: { web: 3100, mcp: 3001 },
      observations: safeObservations(),
      sharedDataBeforeHash: sharedHash,
      sharedDataAfterHash: sharedHash,
      evidenceRefs: ['test:canary-run'],
    })
    const calls: string[] = []
    const adapter: ControlledSwitchAdapter = {
      async stopOldPrimary() { calls.push('stop') },
      async startTarget() { calls.push('start') },
      async verifyTarget() {
        calls.push('verify')
        return {
          readiness: false,
          portOwnership: true,
          uniqueSchedulerOwner: true,
          dataContinuity: true,
          launchAgentVerified: true,
          reasonCodes: ['injected_readiness_failure'],
          evidenceRefs: ['test:injected-failure'],
        }
      },
      async restorePrevious() { calls.push('restore') },
    }
    const receipt = await executeControlledSwitch({
      action: 'rollback_drill',
      releaseRoot: fixture.releaseRoot,
      targetReleaseId: COMMIT_B,
      credentialRotationReceiptPath: fixture.credentialReceiptPath,
      canaryReadinessReceipt: canary,
      lockDir: fixture.lockDir,
      jobsStatePath: fixture.jobsStatePath,
      dataTailPaths: [fixture.dataTailPath],
      launchAgentPath: fixture.launchAgentPath,
      backupDir: fixture.backupDir,
      receiptDir: fixture.receiptDir,
      lockTimeoutMs: 100,
      now: () => new Date('2026-08-01T12:03:00.000Z'),
      adapter,
    })
    expect(receipt).toMatchObject({
      action: 'rollback_drill',
      scope: 'isolated_test',
      status: 'rolled_back',
      fromCommit: COMMIT_A,
      targetCommit: COMMIT_B,
      finalCommit: COMMIT_A,
    })
    expect(receipt.rollbackReceiptId).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.reasonCodes).toContain('injected_readiness_failure')
    expect(await readReleasePointer(fixture.releaseRoot, 'current')).toBe(COMMIT_A)
    expect(calls).toEqual(['stop', 'start', 'verify', 'restore'])
  })
})

function safeObservations() {
  return {
    readiness: 'pass' as const,
    cronOwners: [],
    accountsInitialized: 0,
    orderSubmissions: 0,
    promotionWrites: 0,
    sharedWrites: 0,
  }
}

function makeCanaryRuntime(root: string, primaryData: string) {
  return resolveRuntimePaths({
    repoRoot: root,
    env: {
      OPENALICE_RUNTIME_ROLE: 'canary',
      OPENALICE_DATA_DIR: primaryData,
      OPENALICE_CANARY_ROOT: join(root, 'canary'),
      OPENALICE_CANARY_WEB_PORT: '4102',
      OPENALICE_CANARY_MCP_PORT: '4101',
    },
  })
}

async function createSwitchFixture(label: string) {
  const root = await mkdtemp(join(tmpdir(), `openalice-canary-${label}-`))
  const releaseRoot = join(root, 'releases')
  const receiptDir = join(root, 'receipts')
  const backupDir = join(root, 'backups')
  const lockDir = join(root, 'locks')
  const jobsStatePath = join(root, 'jobs.json')
  const dataTailPath = join(root, 'market.jsonl')
  const launchAgentPath = join(root, 'ai.openalice.test.plist')
  await Promise.all([
    mkdir(lockDir, { recursive: true }),
    writeFile(jobsStatePath, '{"jobs":[]}\n'),
    writeFile(dataTailPath, '{"t":1}\n'),
    writeFile(launchAgentPath, '<plist><string>openalice.test</string></plist>\n'),
  ])
  await createRelease(releaseRoot, COMMIT_A)
  const credentialReceiptPath = join(root, 'credential-rotation.json')
  const credentialReceipt = buildCredentialRotationReceipt({
    scope: 'isolated_test',
    credentialNames: [...PRIMARY_CREDENTIAL_ROTATION_NAMES],
    rotatedAt: '2026-08-01T12:00:00.000Z',
    newCredentialStored: true,
    oldCredentialRevoked: 'yes',
    argvScan: 'pass',
    plistScan: 'pass',
    logScan: 'pass',
    apiScan: 'pass',
    gitScan: 'pass',
    artifactScan: 'pass',
    fixtureScan: 'pass',
    evidenceRefs: [
      'credential_revocation:external_receipt:sha256:' + '7'.repeat(64),
    ],
  })
  await writeFile(credentialReceiptPath, `${JSON.stringify(credentialReceipt)}\n`)
  const initial = await activateRelease({
    releaseRoot,
    releaseId: COMMIT_A,
    credentialRotationReceiptPath: credentialReceiptPath,
    credentialRotationReceiptScope: 'isolated_test',
    receiptDir,
    now: new Date('2026-08-01T12:00:30.000Z'),
  })
  expect(initial.status).toBe('pass')
  return {
    root,
    releaseRoot,
    receiptDir,
    backupDir,
    lockDir,
    jobsStatePath,
    dataTailPath,
    launchAgentPath,
    credentialReceiptPath,
  }
}

async function createRelease(root: string, commit: string) {
  const path = join(root, commit)
  await mkdir(join(path, 'dist'), { recursive: true })
  await writeFile(join(path, 'dist/main.js'), `console.log(${JSON.stringify(commit)})\n`)
  const closureFiles: Record<string, string> = {
    'scripts/runner.sh': '#!/bin/sh\n',
    'src/runtime.ts': 'export {}\n',
    'sidecars/nautilus_paper/README.md': 'durable-only sidecar fixture\n',
    'ops/pipeline.json': '{}\n',
    'default/config.json': '{}\n',
    'node_modules/.bin/tsx': '#!/bin/sh\nexec node\n',
    'package.json': '{"name":"openalice-test"}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'release-metadata/pipeline_registry.v1.json': '{}\n',
  }
  for (const requiredPath of REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES) {
    closureFiles[requiredPath] = `fixture:${requiredPath}\n`
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
    dirtyStateHash: DIRTY_HASH,
    builtAt: '2026-08-01T12:00:00.000Z',
    runtimeEntry: 'dist/main.js',
    artifactHashes,
    pipelineRegistryHash: '3'.repeat(64),
    dependencyLockHash: '4'.repeat(64),
    strategyConfigHash: '5'.repeat(64),
    validationReceipts: [{
      checkId: 'engineering',
      path: 'receipt.json',
      receiptHash: '6'.repeat(64),
      sourceCommit: commit,
      dirtyStateHash: DIRTY_HASH,
      executedAt: '2026-08-01T11:59:00.000Z',
      expiresAt: '2026-08-02T12:00:00.000Z',
      status: 'pass',
    }],
    admissionDecisionId: null,
    engineeringChecks: ['test'],
    liveExecutionArmed: false,
  })
  await writeImmutableReleaseManifest(path, manifest)
  return manifest
}
