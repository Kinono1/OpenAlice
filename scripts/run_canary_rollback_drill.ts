#!/usr/bin/env tsx

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildCredentialRotationReceipt, PRIMARY_CREDENTIAL_ROTATION_NAMES } from '../src/runtime/credential_rotation.js'
import { buildReleaseManifest } from '../src/runtime/release_manifest.js'
import {
  buildCanaryReadinessReceipt,
  executeControlledSwitch,
  sha256PathTree,
  type ControlledSwitchAdapter,
} from '../src/runtime/canary_governance.js'
import {
  activateRelease,
  readReleasePointer,
  sha256File,
  writeImmutableReleaseManifest,
} from '../src/runtime/release_manager.js'
import { resolveRuntimePaths } from '../src/runtime/runtime-paths.js'

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

async function main(): Promise<void> {
  const outputDir = resolve(parseOutputDir(process.argv.slice(2)))
  const root = await mkdtemp(join(tmpdir(), 'openalice-rollback-drill-'))
  const releaseRoot = join(root, 'releases')
  const transientReceipts = join(root, 'transient-receipts')
  const lockDir = join(root, 'locks')
  const primaryData = join(root, 'primary-data')
  const jobsStatePath = join(root, 'jobs.json')
  const dataTailPath = join(root, 'market.jsonl')
  const launchAgentPath = join(root, 'ai.openalice.rollback-drill.plist')
  const credentialReceiptPath = join(root, 'credential-rotation.json')
  const backupDir = join(outputDir, 'backups')
  await Promise.all([
    mkdir(lockDir, { recursive: true }),
    mkdir(primaryData, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
    writeFile(jobsStatePath, '{"jobs":[]}\n'),
    writeFile(dataTailPath, '{"timestamp":"isolated-test"}\n'),
    writeFile(
      launchAgentPath,
      '<plist><dict><key>Label</key><string>ai.openalice.rollback-drill</string></dict></plist>\n',
    ),
    writeFile(join(primaryData, 'snapshot.json'), '{"scope":"isolated_test"}\n'),
  ])

  const [currentManifest, targetManifest] = await Promise.all([
    createFixtureRelease(releaseRoot, COMMIT_A),
    createFixtureRelease(releaseRoot, COMMIT_B),
  ])
  const credentialReceipt = buildCredentialRotationReceipt({
    scope: 'isolated_test',
    credentialNames: [...PRIMARY_CREDENTIAL_ROTATION_NAMES],
    rotatedAt: new Date().toISOString(),
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
      'credential_revocation:isolated_test_fixture:sha256:' + '7'.repeat(64),
    ],
  })
  await writeFile(credentialReceiptPath, `${JSON.stringify(credentialReceipt)}\n`, { mode: 0o400 })
  const initial = await activateRelease({
    releaseRoot,
    releaseId: COMMIT_A,
    credentialRotationReceiptPath: credentialReceiptPath,
    credentialRotationReceiptScope: 'isolated_test',
    receiptDir: transientReceipts,
  })
  if (initial.status !== 'pass') throw new Error('rollback_drill_initial_activation_failed')

  const sharedHash = await sha256PathTree(primaryData)
  const runtime = resolveRuntimePaths({
    repoRoot: root,
    env: {
      OPENALICE_RUNTIME_ROLE: 'canary',
      OPENALICE_DATA_DIR: primaryData,
      OPENALICE_CANARY_ROOT: join(root, 'canary'),
      OPENALICE_CANARY_WEB_PORT: '4102',
      OPENALICE_CANARY_MCP_PORT: '4101',
    },
  })
  const canaryGeneratedAt = new Date()
  const canary = buildCanaryReadinessReceipt({
    scope: 'isolated_test',
    generatedAt: canaryGeneratedAt.toISOString(),
    expiresAt: new Date(canaryGeneratedAt.getTime() + 60 * 60 * 1000).toISOString(),
    releaseId: COMMIT_B,
    manifestHash: targetManifest.manifestHash,
    runtime,
    primaryPorts: { web: 3100, mcp: 3001 },
    observations: {
      readiness: 'pass',
      cronOwners: [],
      accountsInitialized: 0,
      orderSubmissions: 0,
      promotionWrites: 0,
      sharedWrites: 0,
    },
    sharedDataBeforeHash: sharedHash,
    sharedDataAfterHash: sharedHash,
    evidenceRefs: [
      `isolated_test_current_manifest:sha256:${currentManifest.manifestHash}`,
      `isolated_test_target_manifest:sha256:${targetManifest.manifestHash}`,
    ],
  })
  const adapter: ControlledSwitchAdapter = {
    async stopOldPrimary() {},
    async startTarget() {},
    async verifyTarget() {
      return {
        readiness: false,
        portOwnership: true,
        uniqueSchedulerOwner: true,
        dataContinuity: true,
        launchAgentVerified: true,
        reasonCodes: ['injected_readiness_failure'],
        evidenceRefs: ['rollback_drill:injected_failure'],
      }
    },
    async restorePrevious() {},
  }
  const receipt = await executeControlledSwitch({
    action: 'rollback_drill',
    releaseRoot,
    targetReleaseId: COMMIT_B,
    credentialRotationReceiptPath: credentialReceiptPath,
    canaryReadinessReceipt: canary,
    lockDir,
    jobsStatePath,
    dataTailPaths: [dataTailPath],
    launchAgentPath,
    backupDir,
    receiptDir: outputDir,
    lockTimeoutMs: 1_000,
    adapter,
  })
  const restoredCommit = await readReleasePointer(releaseRoot, 'current')
  if (receipt.status !== 'rolled_back' || restoredCommit !== COMMIT_A) {
    throw new Error('rollback_drill_did_not_restore_previous_release')
  }
  console.log(JSON.stringify({
    schemaVersion: 'canary_rollback_drill_summary.v1',
    status: 'pass',
    scope: 'isolated_test',
    controlledSwitchReceiptId: receipt.receiptId,
    rollbackReceiptId: receipt.rollbackReceiptId,
    restoredPrevious: true,
    outputDir,
  }, null, 2))
}

function parseOutputDir(argv: string[]): string {
  const index = argv.indexOf('--outputDir')
  return index >= 0 && argv[index + 1]
    ? argv[index + 1]!
    : 'runtime/canary-drills'
}

async function createFixtureRelease(root: string, commit: string) {
  const path = join(root, commit)
  await mkdir(join(path, 'dist'), { recursive: true })
  await writeFile(join(path, 'dist/main.js'), `console.log(${JSON.stringify(commit)})\n`)
  const manifest = buildReleaseManifest({
    releaseId: commit,
    sourceCommit: commit,
    dirtyStateHash: 'd'.repeat(64),
    builtAt: new Date().toISOString(),
    runtimeEntry: 'dist/main.js',
    artifactHashes: { 'dist/main.js': await sha256File(join(path, 'dist/main.js')) },
    pipelineRegistryHash: '3'.repeat(64),
    dependencyLockHash: '4'.repeat(64),
    strategyConfigHash: '5'.repeat(64),
    validationReceipts: [{
      checkId: 'isolated-test',
      path: 'isolated-test-receipt.json',
      receiptHash: '6'.repeat(64),
      sourceCommit: commit,
      dirtyStateHash: 'd'.repeat(64),
      executedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: 'pass',
    }],
    admissionDecisionId: null,
    engineeringChecks: ['isolated_rollback_drill'],
    liveExecutionArmed: false,
  })
  await writeImmutableReleaseManifest(path, manifest)
  return manifest
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
