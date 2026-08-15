import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const COMMIT_RE = /^[a-f0-9]{40}$/
const SHA256_RE = /^[a-f0-9]{64}$/
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const MANIFEST_FILE = 'release_manifest.v2.json'
const ENVIRONMENT_RECEIPT_PATH = 'release-metadata/sidecar_environment_receipt.v1.json'
const D1_BUNDLE_PATH = 'release-metadata/d1_release_bundle.v1.json'
const CONTRACT_PATH = 'sidecars/nautilus_paper/release_runtime_contract.v1.json'
const RUNTIME_LOCK_PATH = 'sidecars/nautilus_paper/requirements-paper-local-runtime-macos-arm64-cp313.lock'
const WHEEL_MANIFEST_PATH = 'sidecars/nautilus_paper/wheelhouse-paper-local-runtime-macos-arm64-cp313.sha256'
const PROTO_PATH = 'src/sidecar/proto/openalice_execution_v1.proto'
const PIPELINE_REGISTRY_PATH = 'release-metadata/pipeline_registry.v1.json'
const DEPENDENCY_LOCK_PATH = 'release-metadata/pnpm-lock.yaml'
const STRATEGY_CONFIG_PATH = 'release-metadata/strategy_release_config.v1.json'
const VERIFIER_PATH = 'sidecars/nautilus_paper/verify_release_environment.py'
const SUPERVISOR_CONFIG_SCHEMA_PATH = 'sidecars/nautilus_paper/supervisor_config.v1.schema.json'
const SUPERVISOR_MODULE = 'sidecars.nautilus_paper.supervisor'
const RUNTIME_ENTRY = 'ops/release/launch_nautilus_paper.sh'
const RUNTIME_MJS_ENTRY = 'ops/release/launch_nautilus_paper.mjs'
const D1_CHECK_IDS = Object.freeze([
  'd1.typescript',
  'd1.sidecar.environment',
  'd1.sidecar.proto',
  'd1.sidecar.python',
  'd1.sidecar.node',
  'd1.sidecar.node_python_uds',
  'd1.release_manifest_launcher',
])
export const PAPER_LOCAL_FORWARDED_SIGNALS = Object.freeze([
  'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT',
])
const RUNTIME_TRUST_MODES = Object.freeze({
  RELEASE_GATE: 'release-gate',
  DEPLOYMENT: 'deployment',
})
const REQUIRED_ARTIFACTS = Object.freeze([
  RUNTIME_ENTRY,
  'ops/release/launch_nautilus_paper.mjs',
  CONTRACT_PATH,
  RUNTIME_LOCK_PATH,
  WHEEL_MANIFEST_PATH,
  PROTO_PATH,
  VERIFIER_PATH,
  'sidecars/nautilus_paper/supervisor.py',
  SUPERVISOR_CONFIG_SCHEMA_PATH,
  'sidecars/nautilus_paper/runtime.py',
  'sidecars/nautilus_paper/grpc_receiver.py',
  'sidecars/nautilus_paper/ledger.py',
  'sidecars/nautilus_paper/offline_execution.py',
  'sidecars/nautilus_paper/offline_effect.py',
  'sidecars/nautilus_paper/offline_receipt.py',
  'sidecars/nautilus_paper/offline_simulator.py',
  'sidecars/nautilus_paper/generated/openalice_execution_v1_pb2.py',
  'sidecars/nautilus_paper/generated/openalice_execution_v1_pb2_grpc.py',
  D1_BUNDLE_PATH,
  ENVIRONMENT_RECEIPT_PATH,
  PIPELINE_REGISTRY_PATH,
  DEPENDENCY_LOCK_PATH,
  STRATEGY_CONFIG_PATH,
])
const D1_STATIC_ARTIFACTS = new Set([
  ...REQUIRED_ARTIFACTS,
  'package.json',
  'pnpm-lock.yaml',
  'dist/proto/openalice_execution_v1.proto',
  'scripts/check_execution_sidecar_proto.ts',
  'src/bootstrap/execution-sidecar.ts',
  'src/domain/trading/execution-lifecycle-read-model.ts',
  'src/domain/trading/execution-offline-receipt-read-model.ts',
  'src/domain/trading/execution-protocol.ts',
  'src/domain/trading/execution-sidecar-read-model.ts',
  'src/domain/trading/execution-sidecar-writer.ts',
  'src/domain/trading/execution-terminal-reducer.ts',
  'src/domain/trading/offline-execution-receipt.ts',
  'src/sidecar/contracts.ts',
  'src/sidecar/execution-grpc-transport.ts',
  'sidecars/nautilus_paper/README.md',
  'sidecars/nautilus_paper/__init__.py',
  'sidecars/nautilus_paper/contract.py',
  'sidecars/nautilus_paper/core.py',
  'sidecars/nautilus_paper/environment.py',
  'sidecars/nautilus_paper/generated/__init__.py',
])
const DECLARED_DIRECTORIES = Object.freeze([
  'dist',
  'scripts',
  'src',
  'sidecars',
  'ops',
  'release-metadata',
])
const D1_FORBIDDEN_CACHE_SEGMENTS = new Set([
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache',
])
const D1_FORBIDDEN_TEST_SEGMENTS = new Set([
  'test', 'tests', '__tests__', 'integration', 'integrations',
])
const D1_FORBIDDEN_EXACT_FILENAMES = new Set([
  'runtime_crash_test_server.py',
  'uds_contract_test_server.py',
  'uds_offline_contract_test_server.py',
  'generate_proto.py',
  'dependency_lock.v1.json',
  'dependency_verification.v1.json',
  'requirements-macos-arm64-cp313.lock',
  'wheelhouse-macos-arm64-cp313.sha256',
])
const SUPERVISOR_BOOTSTRAP = [
  'import os,runpy,sys',
  'root=sys.argv.pop(1)',
  'venv=os.path.dirname(os.path.dirname(sys.executable))',
  'site=os.path.join(venv,"lib","python3.13","site-packages")',
  'sys.path[:0]=[root,site]',
  `runpy.run_module(${JSON.stringify(SUPERVISOR_MODULE)},run_name="__main__")`,
].join(';')

export function parsePaperLocalLauncherArgs(argv) {
  const values = new Map()
  let verifyOnly = false
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--verify-only') {
      if (verifyOnly) throw new Error('duplicate_argument:verify-only')
      verifyOnly = true
      continue
    }
    if (!['--release-root', '--release-id', '--pointer', '--config'].includes(token)) {
      throw new Error(`unknown_argument:${token}`)
    }
    if (values.has(token)) throw new Error(`duplicate_argument:${token.slice(2)}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing_argument:${token.slice(2)}`)
    values.set(token, value)
    index += 1
  }
  const releaseRoot = requiredAbsolute(values.get('--release-root'), 'release-root')
  const config = requiredAbsolute(values.get('--config'), 'config')
  const releaseId = values.get('--release-id') ?? null
  const pointer = values.get('--pointer') ?? null
  if ((releaseId === null) === (pointer === null)) {
    throw new Error('exactly_one_release_id_or_pointer_required')
  }
  if (releaseId !== null && !COMMIT_RE.test(releaseId)) {
    throw new Error('invalid_release_id')
  }
  if (pointer !== null && pointer !== 'research-current') {
    throw new Error('paper_local_pointer_must_be_research_current')
  }
  const python = requiredAbsolute(
    process.env.OPENALICE_NAUTILUS_PYTHON,
    'OPENALICE_NAUTILUS_PYTHON',
  )
  const publisherUid = requiredUid(
    process.env.OPENALICE_RELEASE_PUBLISHER_UID,
    'OPENALICE_RELEASE_PUBLISHER_UID',
  )
  const shellPath = requiredAbsolute(
    process.env.OPENALICE_PAPER_LOCAL_SHELL_PATH,
    'OPENALICE_PAPER_LOCAL_SHELL_PATH',
  )
  return { releaseRoot, releaseId, pointer, config, python, publisherUid, shellPath, verifyOnly }
}

export function validateD1ReleaseManifest(input, freshAt = null) {
  assertPlainObject(input, 'release_manifest_invalid')
  assertExactKeys(input, [
    'schemaVersion', 'manifestHash', 'releaseId', 'sourceCommit',
    'dirtyStateHash', 'builtAt', 'runtimeEntry', 'artifactHashes',
    'pipelineRegistryHash', 'dependencyLockHash', 'strategyConfigHash',
    'validationReceipts', 'sidecarEnvironment', 'admissionDecisionId',
    'engineeringChecks', 'liveExecutionArmed',
  ], 'release_manifest_fields_invalid')
  if (input.schemaVersion !== 'release_manifest.v2') {
    throw new Error('release_manifest_v2_required')
  }
  for (const field of [
    'manifestHash', 'dirtyStateHash', 'pipelineRegistryHash',
    'dependencyLockHash', 'strategyConfigHash',
  ]) {
    if (!SHA256_RE.test(input[field])) throw new Error(`release_manifest_invalid:${field}`)
  }
  for (const field of ['releaseId', 'sourceCommit']) {
    if (!COMMIT_RE.test(input[field])) throw new Error(`release_manifest_invalid:${field}`)
  }
  if (input.releaseId !== input.sourceCommit) throw new Error('release_manifest_source_mismatch')
  if (input.dirtyStateHash !== EMPTY_SHA256) throw new Error('d1_release_source_not_clean')
  if (input.runtimeEntry !== RUNTIME_ENTRY) throw new Error('d1_runtime_entry_mismatch')
  if (input.admissionDecisionId !== null) throw new Error('d1_admission_decision_forbidden')
  if (input.liveExecutionArmed !== false) throw new Error('d1_live_execution_armed')
  if (!isIsoDate(input.builtAt)) throw new Error('release_manifest_built_at_invalid')
  assertExactStringSet(input.engineeringChecks, D1_CHECK_IDS, 'd1_engineering_checks_mismatch')

  assertPlainObject(input.artifactHashes, 'release_artifact_hashes_missing')
  for (const [path, hash] of Object.entries(input.artifactHashes)) {
    if (!isSafeRelativePath(path) || !SHA256_RE.test(hash)) {
      throw new Error(`release_artifact_invalid:${path}`)
    }
    assertD1ArtifactPathAllowed(path)
  }
  for (const path of D1_STATIC_ARTIFACTS) {
    if (!SHA256_RE.test(input.artifactHashes[path] ?? '')) {
      throw new Error(`d1_release_artifact_missing:${path}`)
    }
  }
  for (const [path, hash, field] of [
    [PIPELINE_REGISTRY_PATH, input.pipelineRegistryHash, 'pipelineRegistryHash'],
    [DEPENDENCY_LOCK_PATH, input.dependencyLockHash, 'dependencyLockHash'],
    [STRATEGY_CONFIG_PATH, input.strategyConfigHash, 'strategyConfigHash'],
  ]) {
    if (input.artifactHashes[path] !== hash) {
      throw new Error(`d1_release_metadata_hash_mismatch:${field}`)
    }
  }

  if (!Array.isArray(input.validationReceipts)) {
    throw new Error('d1_validation_receipts_invalid')
  }
  assertExactStringSet(
    input.validationReceipts.map((receipt) => receipt?.checkId),
    D1_CHECK_IDS,
    'd1_validation_receipts_mismatch',
  )
  const receiptPaths = new Set()
  for (const receipt of input.validationReceipts) {
    assertPlainObject(receipt, 'd1_validation_receipt_invalid')
    assertExactKeys(receipt, [
      'checkId', 'path', 'receiptHash', 'sourceCommit', 'dirtyStateHash',
      'executedAt', 'expiresAt', 'status',
    ], 'd1_validation_receipt_invalid')
    if (
      !D1_CHECK_IDS.includes(receipt.checkId)
      || !isSafeRelativePath(receipt.path)
      || receipt.path !== `release-metadata/validation-receipts/${receipt.checkId}.validation_receipt.v1.json`
      || !SHA256_RE.test(receipt.receiptHash)
      || receipt.sourceCommit !== input.sourceCommit
      || receipt.dirtyStateHash !== input.dirtyStateHash
      || receipt.status !== 'pass'
      || !isIsoDate(receipt.executedAt)
      || !isIsoDate(receipt.expiresAt)
      || Date.parse(receipt.executedAt) > Date.parse(input.builtAt)
      || Date.parse(receipt.expiresAt) <= Date.parse(input.builtAt)
      || (freshAt !== null && Date.parse(receipt.expiresAt) <= freshAt.getTime())
      || input.artifactHashes[receipt.path] !== receipt.receiptHash
      || receiptPaths.has(receipt.path)
    ) {
      throw new Error(`d1_validation_receipt_invalid:${receipt.checkId ?? 'unknown'}`)
    }
    receiptPaths.add(receipt.path)
  }

  validateEnvironmentBinding(input.sidecarEnvironment, input)
  const { schemaVersion: _schemaVersion, manifestHash, ...core } = input
  if (sha256Canonical(core) !== manifestHash) {
    throw new Error('release_manifest_hash_mismatch')
  }
  return input
}

export function validateD1BundleBinding(raw, manifest) {
  if (typeof raw !== 'string') throw new Error('d1_release_bundle_invalid')
  let bundle
  try { bundle = JSON.parse(raw) } catch { throw new Error('d1_release_bundle_invalid') }
  assertPlainObject(bundle, 'd1_release_bundle_invalid')
  assertExactKeys(bundle, [
    'schemaVersion', 'bundleId', 'sourceCommit', 'dirtyStateHash',
    'environmentReceipt', 'validationReceipts', 'sealedAt', 'expiresAt',
  ], 'd1_release_bundle_invalid')
  if (
    raw !== `${stableStringify(bundle)}\n`
    || bundle.schemaVersion !== 'd1_release_bundle.v1'
    || !SHA256_RE.test(bundle.bundleId)
    || bundle.sourceCommit !== manifest.sourceCommit
    || bundle.dirtyStateHash !== manifest.dirtyStateHash
    || !isIsoDate(bundle.sealedAt)
    || !isIsoDate(bundle.expiresAt)
    || Date.parse(bundle.sealedAt) > Date.parse(manifest.builtAt)
    || sha256Text(raw) !== manifest.artifactHashes[D1_BUNDLE_PATH]
  ) throw new Error('d1_release_bundle_invalid')
  const { bundleId, ...core } = bundle
  if (sha256Canonical(core) !== bundleId) throw new Error('d1_release_bundle_hash_mismatch')
  assertPlainObject(bundle.environmentReceipt, 'd1_release_bundle_environment_invalid')
  assertExactKeys(bundle.environmentReceipt, ['path', 'sha256'], 'd1_release_bundle_environment_invalid')
  if (
    bundle.environmentReceipt.path !== 'd1.sidecar.environment.environment_receipt.v1.json'
    || bundle.environmentReceipt.sha256 !== manifest.sidecarEnvironment.receiptHash
  ) throw new Error('d1_release_bundle_environment_invalid')
  if (!Array.isArray(bundle.validationReceipts) || bundle.validationReceipts.length !== D1_CHECK_IDS.length) {
    throw new Error('d1_release_bundle_receipts_invalid')
  }
  const manifestReceipts = new Map(manifest.validationReceipts.map(receipt => [receipt.checkId, receipt]))
  for (const [index, receipt] of bundle.validationReceipts.entries()) {
    assertPlainObject(receipt, 'd1_release_bundle_receipts_invalid')
    assertExactKeys(receipt, ['checkId', 'path', 'sha256'], 'd1_release_bundle_receipts_invalid')
    const expectedCheckId = D1_CHECK_IDS[index]
    const manifestReceipt = manifestReceipts.get(expectedCheckId)
    if (
      receipt.checkId !== expectedCheckId
      || receipt.path !== `${expectedCheckId}.validation_receipt.v1.json`
      || !manifestReceipt
      || receipt.sha256 !== manifestReceipt.receiptHash
      || bundle.expiresAt !== manifestReceipt.expiresAt
    ) throw new Error('d1_release_bundle_receipts_invalid')
  }
  return bundle
}

export async function verifyD1Release(options) {
  const root = await realpath(resolve(options.releaseRoot))
  const requested = options.releaseId === null
    ? join(root, options.pointer)
    : join(root, options.releaseId)
  const releasePath = await realpath(requested)
  assertWithin(root, releasePath)
  const releaseStatus = await lstat(releasePath)
  if (
    !releaseStatus.isDirectory()
    || releaseStatus.isSymbolicLink()
    || releaseStatus.mode & 0o022
  ) {
    throw new Error('paper_local_release_directory_unsafe')
  }
  const releaseId = releasePath.split('/').at(-1)
  if (!COMMIT_RE.test(releaseId) || resolve(releasePath) !== resolve(root, releaseId)) {
    throw new Error('release_pointer_target_invalid')
  }
  await assertTrustedD1ReleaseFilesystem({
    releaseRoot: root,
    releasePath,
    publisherUid: options.publisherUid,
  })
  const manifestPath = join(releasePath, MANIFEST_FILE)
  await assertNoSymlinkComponents(releasePath, manifestPath)
  const manifest = validateD1ReleaseManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')),
    options.now ?? new Date(),
  )
  if (manifest.releaseId !== releaseId) throw new Error('release_directory_id_mismatch')
  await assertTrustedD1MaterializedEntrypoint({
    shellPath: options.shellPath,
    publisherUid: options.publisherUid,
    expectedHashes: {
      shell: manifest.artifactHashes[RUNTIME_ENTRY],
      module: manifest.artifactHashes[RUNTIME_MJS_ENTRY],
    },
  })

  for (const [relativePath, expectedHash] of Object.entries(manifest.artifactHashes)) {
    const artifact = resolve(releasePath, relativePath)
    assertWithin(releasePath, artifact)
    await assertNoSymlinkComponents(releasePath, artifact)
    const status = await lstat(artifact)
    if (!status.isFile()) throw new Error(`release_artifact_type_forbidden:${relativePath}`)
    if (await sha256File(artifact) !== expectedHash) {
      throw new Error(`release_artifact_hash_mismatch:${relativePath}`)
    }
  }
  await assertDeclaredClosure(releasePath, manifest.artifactHashes)
  await assertExactD1MaterializedClosure(releasePath, manifest.artifactHashes)

  const environmentReceipt = JSON.parse(
    await readFile(join(releasePath, ENVIRONMENT_RECEIPT_PATH), 'utf8'),
  )
  validateEnvironmentReceipt(environmentReceipt)
  if (stableStringify(environmentReceipt) !== stableStringify(manifest.sidecarEnvironment.receipt)) {
    throw new Error('environment_receipt_manifest_mismatch')
  }
  validateD1BundleBinding(
    await readFile(join(releasePath, D1_BUNDLE_PATH), 'utf8'),
    manifest,
  )
  await validateRuntimeContractBinding(
    join(releasePath, CONTRACT_PATH),
    manifest.sidecarEnvironment.receipt,
  )
  await validateSupervisorConfigBinding(
    options.config,
    manifest.manifestHash,
    manifest.artifactHashes[SUPERVISOR_CONFIG_SCHEMA_PATH],
  )
  return { releasePath, releaseId, manifest }
}

/**
 * Validate the stable, materialized `runtime/bin` pair before trusting it to
 * keep executing the verified release. It is intentionally not required to be
 * inside the selected release: research cutover materializes a fixed pair so a
 * pointer switch cannot change the service-manager entrypoint. The pair must
 * nevertheless be byte-identical to the selected release artifacts and live
 * under the same publisher-owned, service-unwritable hierarchy.
 */
export async function assertTrustedD1MaterializedEntrypoint(options) {
  const ops = options.filesystem ?? { lstat, readdir, access }
  const serviceUid = options.serviceUid ?? process.getuid?.()
  const publisherUid = options.publisherUid
  assertDistinctServiceAndPublisherUid(serviceUid, publisherUid)
  if (typeof options.shellPath !== 'string') {
    throw new Error('paper_local_shell_entrypoint_required')
  }
  const requestedShell = resolve(options.shellPath)
  const requestedMjs = resolve(options.modulePath ?? fileURLToPath(import.meta.url))
  const resolvePath = options.realpath ?? realpath
  let actualShell
  let actualMjs
  try {
    [actualShell, actualMjs] = await Promise.all([
      resolvePath(requestedShell),
      resolvePath(requestedMjs),
    ])
  } catch {
    throw new Error('paper_local_launcher_entrypoint_unsafe')
  }
  if (
    actualShell !== requestedShell
    || actualMjs !== requestedMjs
    || dirname(actualShell) !== dirname(actualMjs)
    || actualShell.split('/').at(-1) !== 'launch_nautilus_paper.sh'
    || actualMjs.split('/').at(-1) !== 'launch_nautilus_paper.mjs'
  ) {
    throw new Error('paper_local_launcher_entrypoint_mismatch')
  }
  await assertTrustedParentHierarchy(
    ops,
    dirname(actualShell),
    publisherUid,
    'paper_local_launcher_parent_unsafe',
  )
  for (const path of [actualShell, actualMjs]) {
    const status = await ops.lstat(path)
    if (
      status.isSymbolicLink()
      || !status.isFile()
      || !isTrustedReleaseOwner(status.uid, publisherUid)
      || (status.mode & 0o022) !== 0
    ) {
      throw new Error('paper_local_launcher_entrypoint_unsafe')
    }
    await assertNotWritableByService(ops.access, path, 'paper_local_launcher_entrypoint_unsafe')
  }
  if (options.expectedHashes) {
    const { shell, module } = options.expectedHashes
    if (!SHA256_RE.test(shell ?? '') || !SHA256_RE.test(module ?? '')) {
      throw new Error('paper_local_launcher_hash_missing')
    }
    const hashFile = options.hashFile ?? sha256File
    if (await hashFile(actualShell) !== shell || await hashFile(actualMjs) !== module) {
      throw new Error('paper_local_launcher_hash_mismatch')
    }
  }
  return { shellPath: actualShell, modulePath: actualMjs }
}

/**
 * The manifest hashes establish content identity but cannot themselves close a
 * verify-then-exec race if the service account can rewrite a release pathname.
 * D1 therefore treats a separately owned, non-writable release hierarchy as a
 * deployment prerequisite.  The publisher identity is supplied by the service
 * manager and checked against the filesystem; it is not an assertion made by
 * the release contents.
 *
 * This function deliberately checks every ancestor to the filesystem root as
 * well as every entry in the selected release tree.  A parent writable by the
 * service could otherwise atomically replace the verified release directory or
 * its `research-current` pointer.  ACL/MAC policy is consulted through
 * `access(W_OK)` for the effective service identity, in addition to rejecting
 * group/world-writable POSIX modes.
 */
export async function assertTrustedD1ReleaseFilesystem(options) {
  const ops = options.filesystem ?? { lstat, readdir, access }
  const serviceUid = options.serviceUid ?? process.getuid?.()
  const publisherUid = options.publisherUid
  assertDistinctServiceAndPublisherUid(serviceUid, publisherUid)

  const root = resolve(options.releaseRoot)
  const release = resolve(options.releasePath)
  assertWithin(root, release)
  await assertTrustedParentHierarchy(ops, root, publisherUid, 'paper_local_release_parent_unsafe')
  await assertTrustedReleaseTree(ops, release, publisherUid)
}

function assertDistinctServiceAndPublisherUid(serviceUid, publisherUid) {
  if (!Number.isSafeInteger(serviceUid) || serviceUid < 0 || serviceUid === 0) {
    throw new Error('paper_local_service_uid_unsafe')
  }
  if (!Number.isSafeInteger(publisherUid) || publisherUid < 0) {
    throw new Error('paper_local_release_publisher_uid_required')
  }
  if (publisherUid === serviceUid) {
    throw new Error('paper_local_release_publisher_must_differ_from_service_uid')
  }
}

async function assertTrustedParentHierarchy(ops, path, publisherUid, errorCode) {
  for (const ancestor of filesystemAncestors(path)) {
    const status = await ops.lstat(ancestor)
    if (
      !status.isDirectory()
      || status.isSymbolicLink()
      || !isTrustedReleaseOwner(status.uid, publisherUid)
      || (status.mode & 0o022) !== 0
    ) {
      throw new Error(errorCode)
    }
    await assertNotWritableByService(ops.access, ancestor, errorCode)
  }
}

async function assertTrustedReleaseTree(ops, path, publisherUid) {
  const status = await ops.lstat(path)
  if (
    status.isSymbolicLink()
    || !isTrustedReleaseOwner(status.uid, publisherUid)
    || (status.mode & 0o022) !== 0
    || (!status.isDirectory() && !status.isFile())
  ) {
    throw new Error('paper_local_release_tree_unsafe')
  }
  await assertNotWritableByService(ops.access, path, 'paper_local_release_tree_unsafe')
  if (!status.isDirectory()) return
  for (const entry of await ops.readdir(path, { withFileTypes: true })) {
    await assertTrustedReleaseTree(ops, join(path, entry.name), publisherUid)
  }
}

function filesystemAncestors(path) {
  const ancestors = []
  let current = resolve(path)
  while (true) {
    ancestors.push(current)
    const parent = dirname(current)
    if (parent === current) return ancestors
    current = parent
  }
}

function isTrustedReleaseOwner(uid, publisherUid) {
  // Root-owned system directories are a trusted part of an otherwise
  // publisher-owned path (for example /var/lib/openalice/releases).
  return uid === publisherUid || uid === 0
}

async function assertNotWritableByService(accessPath, path, errorCode) {
  try {
    await accessPath(path, constants.W_OK)
  } catch (error) {
    if (error && (error.code === 'EACCES' || error.code === 'EPERM')) return
    throw new Error(errorCode)
  }
  throw new Error(errorCode)
}

export async function runEnvironmentVerifier(options) {
  const verifier = join(options.releasePath, VERIFIER_PATH)
  const contract = join(options.releasePath, CONTRACT_PATH)
  const bound = await assertRuntimePythonBinding(
    options.python,
    options.manifest.sidecarEnvironment.receipt,
    {
      trustMode: RUNTIME_TRUST_MODES.DEPLOYMENT,
      publisherUid: options.publisherUid,
      runtimeTrustTestSeam: options.runtimeTrustTestSeam,
    },
  )
  const captured = options.runtimeTrustTestSeam?.runCaptured
  if (captured !== undefined && process.env.NODE_ENV !== 'test') {
    throw new Error('paper_local_runtime_test_seam_forbidden')
  }
  const result = await (captured ?? runCaptured)(bound.python, [
    '-I', '-S', '-B', verifier,
    '--contract', contract,
    '--expected-contract-sha256', options.manifest.sidecarEnvironment.receipt.contractHash,
    '--release-root', options.releasePath,
    '--trust-mode', RUNTIME_TRUST_MODES.DEPLOYMENT,
    '--publisher-uid', String(options.publisherUid),
  ], { cwd: options.releasePath, env: sanitizedEnvironment() })
  if (result.code !== 0) {
    throw new Error(`sidecar_environment_verification_failed:${singleLine(result.stderr)}`)
  }
  let receipt
  try {
    receipt = JSON.parse(result.stdout)
  } catch {
    throw new Error('sidecar_environment_receipt_invalid')
  }
  validateEnvironmentReceipt(receipt)
  const expected = { ...options.manifest.sidecarEnvironment.receipt }
  const actual = { ...receipt }
  delete expected.executedAt
  delete actual.executedAt
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error('sidecar_environment_runtime_drift')
  }
  return Object.freeze({ receipt, runtimeBinding: bound })
}

export async function launchPaperLocal(argv = process.argv.slice(2)) {
  const args = parsePaperLocalLauncherArgs(argv)
  const verified = await verifyD1Release(args)
  const environmentVerification = await runEnvironmentVerifier({
    python: args.python,
    releasePath: verified.releasePath,
    manifest: verified.manifest,
    publisherUid: args.publisherUid,
  })
  const environmentReceipt = environmentVerification.receipt
  const immediatelyReverified = await verifyD1Release(args)
  if (
    immediatelyReverified.releasePath !== verified.releasePath
    || immediatelyReverified.manifest.manifestHash !== verified.manifest.manifestHash
  ) {
    throw new Error('paper_local_release_changed_before_supervisor_start')
  }
  const releaseRecheckBinding = await assertRuntimePythonBinding(
    args.python,
    immediatelyReverified.manifest.sidecarEnvironment.receipt,
    { trustMode: RUNTIME_TRUST_MODES.DEPLOYMENT, publisherUid: args.publisherUid },
  )
  assertStableRuntimeBinding(environmentVerification.runtimeBinding, releaseRecheckBinding)
  const supervisorArgs = [
    '-I', '-S', '-B', '-c', SUPERVISOR_BOOTSTRAP, immediatelyReverified.releasePath,
    '--config', args.config,
  ]
  if (args.verifyOnly) {
    const configPython = await assertRuntimePythonBinding(
      args.python,
      immediatelyReverified.manifest.sidecarEnvironment.receipt,
      { trustMode: RUNTIME_TRUST_MODES.DEPLOYMENT, publisherUid: args.publisherUid },
    )
    assertStableRuntimeBinding(environmentVerification.runtimeBinding, configPython)
    const checked = await runCaptured(configPython.python, [...supervisorArgs, '--check-config'], {
      cwd: verified.releasePath,
      env: sanitizedEnvironment(),
    })
    if (checked.code !== 0) {
      throw new Error(`paper_local_supervisor_config_rejected:${singleLine(checked.stderr)}`)
    }
    return {
      status: 'pass',
      releaseId: verified.releaseId,
      sourceCommit: verified.manifest.sourceCommit,
      manifestHash: verified.manifest.manifestHash,
      environmentContractHash: environmentReceipt.contractHash,
      mode: 'PAPER_LOCAL',
      liveExecutionArmed: false,
      supervisorStarted: false,
    }
  }
  const supervisorPython = await assertRuntimePythonBinding(
    args.python,
    immediatelyReverified.manifest.sidecarEnvironment.receipt,
    { trustMode: RUNTIME_TRUST_MODES.DEPLOYMENT, publisherUid: args.publisherUid },
  )
  assertStableRuntimeBinding(environmentVerification.runtimeBinding, supervisorPython)
  return await runForeground(supervisorPython.python, supervisorArgs, {
    cwd: verified.releasePath,
    env: sanitizedEnvironment(),
  })
}

function validateEnvironmentBinding(binding, manifest) {
  assertPlainObject(binding, 'sidecar_environment_binding_invalid')
  assertExactKeys(binding, ['receiptPath', 'receiptHash', 'contractPath', 'receipt'], 'sidecar_environment_binding_invalid')
  if (
    binding.receiptPath !== ENVIRONMENT_RECEIPT_PATH
    || binding.contractPath !== CONTRACT_PATH
    || !SHA256_RE.test(binding.receiptHash)
    || manifest.artifactHashes[binding.receiptPath] !== binding.receiptHash
  ) {
    throw new Error('sidecar_environment_binding_invalid')
  }
  validateEnvironmentReceipt(binding.receipt)
  if (
    manifest.artifactHashes[CONTRACT_PATH] !== binding.receipt.contractHash
    || manifest.artifactHashes[RUNTIME_LOCK_PATH] !== binding.receipt.lockHash
    || manifest.artifactHashes[WHEEL_MANIFEST_PATH] !== binding.receipt.wheelManifestHash
    || manifest.artifactHashes[PROTO_PATH] !== binding.receipt.protoHash
    || manifest.artifactHashes['dist/proto/openalice_execution_v1.proto'] !== binding.receipt.protoHash
    || Date.parse(binding.receipt.executedAt) > Date.parse(manifest.builtAt)
  ) {
    throw new Error('sidecar_environment_artifact_binding_invalid')
  }
}

function validateEnvironmentReceipt(receipt) {
  assertPlainObject(receipt, 'sidecar_environment_receipt_invalid')
  assertExactKeys(receipt, [
    'schemaVersion', 'contractHash', 'interpreterHash', 'pyvenvCfgHash',
    'baseRuntimeAggregate', 'sitePackagesAggregate', 'installedAggregate', 'lockHash', 'wheelManifestHash', 'protoHash',
    'generatedAggregate', 'target', 'flags', 'executedAt', 'status',
  ], 'sidecar_environment_receipt_invalid')
  if (receipt.schemaVersion !== 'openalice_sidecar_environment_receipt.v1' || receipt.status !== 'pass') {
    throw new Error('sidecar_environment_receipt_invalid')
  }
  for (const field of [
    'contractHash', 'interpreterHash', 'pyvenvCfgHash', 'baseRuntimeAggregate', 'sitePackagesAggregate', 'installedAggregate',
    'lockHash', 'wheelManifestHash', 'protoHash', 'generatedAggregate',
  ]) {
    if (!SHA256_RE.test(receipt[field])) throw new Error('sidecar_environment_receipt_invalid')
  }
  assertPlainObject(receipt.target, 'sidecar_environment_target_invalid')
  assertExactKeys(receipt.target, ['implementation', 'python', 'cacheTag', 'system', 'macosMajor', 'machine'], 'sidecar_environment_target_invalid')
  if (stableStringify(receipt.target) !== stableStringify({
    implementation: 'CPython', python: '3.13.5', cacheTag: 'cpython-313',
    system: 'Darwin', macosMajor: 26, machine: 'arm64',
  })) throw new Error('sidecar_environment_target_invalid')
  assertPlainObject(receipt.flags, 'sidecar_environment_flags_invalid')
  assertExactKeys(receipt.flags, ['paperOnly', 'liveTradingAllowed', 'liveExecutionArmed'], 'sidecar_environment_flags_invalid')
  if (stableStringify(receipt.flags) !== stableStringify({
    paperOnly: true, liveTradingAllowed: false, liveExecutionArmed: false,
  })) throw new Error('sidecar_environment_flags_invalid')
  if (!isIsoDate(receipt.executedAt)) throw new Error('sidecar_environment_receipt_invalid')
}

export async function validateSupervisorConfigBinding(
  path,
  manifestHash,
  supervisorSchemaHash,
) {
  const status = await lstat(path)
  if (status.isSymbolicLink() || !status.isFile() || status.mode & 0o077) {
    throw new Error('paper_local_supervisor_config_unsafe')
  }
  if (typeof process.getuid === 'function' && status.uid !== process.getuid()) {
    throw new Error('paper_local_supervisor_config_unsafe')
  }
  let config
  let raw
  try {
    raw = await readFile(path, 'utf8')
    config = JSON.parse(raw)
  } catch {
    throw new Error('paper_local_supervisor_config_invalid')
  }
  if (
    !config
    || (raw !== stableStringify(config) && raw !== `${stableStringify(config)}\n`)
    || config.schemaVersion !== 'openalice_paper_supervisor_config.v1'
    || config.mode !== 'PAPER_LOCAL'
    || config.releaseManifestHash !== manifestHash
    || config.schemaHash !== supervisorSchemaHash
  ) {
    throw new Error('paper_local_supervisor_config_binding_mismatch')
  }
}

async function validateRuntimeContractBinding(path, receipt) {
  let raw
  let contract
  try {
    raw = await readFile(path, 'utf8')
    contract = JSON.parse(raw)
  } catch {
    throw new Error('paper_local_runtime_contract_invalid')
  }
  if (
    (raw !== stableStringify(contract) && raw !== `${stableStringify(contract)}\n`)
    || !contract
    || typeof contract !== 'object'
    || Array.isArray(contract)
  ) {
    throw new Error('paper_local_runtime_contract_invalid')
  }
  const provenance = contract.runtimeProvenance
  if (
    !provenance
    || typeof provenance !== 'object'
    || Array.isArray(provenance)
    || stableStringify(Object.keys(provenance).sort()) !== stableStringify([
      'baseRuntimeAggregate', 'installedAggregate', 'interpreterSha256', 'pyvenvCfgSha256', 'sitePackagesAggregate', 'status',
    ])
    || provenance.status !== 'frozen'
    || provenance.interpreterSha256 !== receipt.interpreterHash
    || provenance.pyvenvCfgSha256 !== receipt.pyvenvCfgHash
    || provenance.baseRuntimeAggregate !== receipt.baseRuntimeAggregate
    || provenance.sitePackagesAggregate !== receipt.sitePackagesAggregate
    || provenance.installedAggregate !== receipt.installedAggregate
  ) {
    throw new Error('paper_local_runtime_provenance_mismatch')
  }
}

export async function assertRuntimePythonBinding(python, receipt, options = {}) {
  const trustMode = options.trustMode
  const publisherUid = options.publisherUid
  const runtimeOps = runtimeTrustOperations(options.runtimeTrustTestSeam)
  if (!Object.values(RUNTIME_TRUST_MODES).includes(trustMode)) {
    throw new Error('paper_local_runtime_trust_mode_required')
  }
  if (trustMode === RUNTIME_TRUST_MODES.DEPLOYMENT) {
    assertDeploymentIdentity(publisherUid, runtimeOps.identity)
  } else if (publisherUid !== undefined) {
    throw new Error('paper_local_runtime_trust_mode_invalid')
  }
  const entry = await runtimeOps.lstat(python).catch(() => null)
  if (!entry || (!entry.isFile() && !entry.isSymbolicLink())) {
    throw new Error('paper_local_runtime_python_unsafe')
  }
  const binDirectory = dirname(python)
  if (binDirectory.split('/').at(-1) !== 'bin') {
    throw new Error('paper_local_runtime_python_not_venv')
  }
  const venvRoot = dirname(binDirectory)
  const pyvenvConfig = join(venvRoot, 'pyvenv.cfg')
  const sitePackages = join(venvRoot, 'lib', 'python3.13', 'site-packages')
  let basePrefix = null
  let baseRuntimeAggregate = null
  let sitePackagesAggregate = null
  if (trustMode === RUNTIME_TRUST_MODES.DEPLOYMENT) {
    await assertTrustedDeploymentPath(python, publisherUid, {
      code: 'paper_local_runtime_python_unsafe', allowLeafSymlink: true, type: 'file',
    }, runtimeOps)
    await assertTrustedDeploymentPath(venvRoot, publisherUid, {
      code: 'paper_local_runtime_python_not_venv', type: 'directory',
    }, runtimeOps)
    await assertTrustedDeploymentPath(pyvenvConfig, publisherUid, {
      code: 'paper_local_runtime_python_not_venv', type: 'file',
    }, runtimeOps)
    basePrefix = await parseStrictPyvenvBasePrefix(pyvenvConfig, runtimeOps)
    if (!isWithinRuntimeRoot(basePrefix, venvRoot)) {
      throw new Error('paper_local_runtime_base_prefix_outside_runtime_root')
    }
    baseRuntimeAggregate = await assertTrustedDeploymentTree(basePrefix, publisherUid, 'paper_local_runtime_base_prefix_unsafe', runtimeOps)
    if (baseRuntimeAggregate !== receipt.baseRuntimeAggregate) {
      throw new Error('paper_local_runtime_base_runtime_aggregate_mismatch')
    }
    sitePackagesAggregate = await assertTrustedDeploymentTree(sitePackages, publisherUid, 'paper_local_runtime_site_packages_unsafe', runtimeOps)
    if (sitePackagesAggregate !== receipt.sitePackagesAggregate) {
      throw new Error('paper_local_runtime_site_packages_aggregate_mismatch')
    }
  }
  const resolvedPython = await runtimeOps.realpath(python).catch(() => null)
  if (!resolvedPython) throw new Error('paper_local_runtime_python_unsafe')
  const resolvedStatus = await runtimeOps.lstat(resolvedPython).catch(() => null)
  if (
    !resolvedStatus?.isFile()
    || resolvedStatus.isSymbolicLink()
    || (resolvedStatus.mode & 0o022) !== 0
  ) {
    throw new Error('paper_local_runtime_python_unsafe')
  }
  if (await runtimeOps.hashFile(resolvedPython) !== receipt.interpreterHash) {
    throw new Error('paper_local_runtime_interpreter_mismatch')
  }
  const configStatus = await runtimeOps.lstat(pyvenvConfig).catch(() => null)
  if (
    !configStatus?.isFile()
    || configStatus.isSymbolicLink()
    || (configStatus.mode & 0o022) !== 0
  ) {
    throw new Error('paper_local_runtime_python_not_venv')
  }
  const pyvenvCfgHash = await runtimeOps.hashFile(pyvenvConfig)
  if (pyvenvCfgHash !== receipt.pyvenvCfgHash) {
    throw new Error('paper_local_runtime_pyvenv_mismatch')
  }
  if (trustMode === RUNTIME_TRUST_MODES.DEPLOYMENT) {
    await assertTrustedDeploymentPath(resolvedPython, publisherUid, {
      code: 'paper_local_runtime_python_unsafe', type: 'file',
    }, runtimeOps)
    if (!isWithinPath(resolvedPython, venvRoot) && !isWithinPath(resolvedPython, basePrefix)) {
      throw new Error('paper_local_runtime_interpreter_outside_runtime_root')
    }
  }
  return Object.freeze({ python: resolvedPython, venvRoot: resolve(venvRoot), basePrefix, interpreterHash: receipt.interpreterHash, pyvenvCfgHash, baseRuntimeAggregate, sitePackagesAggregate })
}

function runtimeTrustOperations(testSeam) {
  if (testSeam !== undefined && process.env.NODE_ENV !== 'test') throw new Error('paper_local_runtime_test_seam_forbidden')
  const filesystem = testSeam?.filesystem ?? {}
  return {
    lstat: filesystem.lstat ?? lstat,
    readdir: filesystem.readdir ?? readdir,
    realpath: filesystem.realpath ?? realpath,
    readFile: filesystem.readFile ?? readFile,
    access: filesystem.access ?? access,
    hashFile: filesystem.hashFile ?? sha256File,
    identity: testSeam?.identity ?? Object.freeze({ realUid: process.getuid?.(), effectiveUid: process.geteuid?.() }),
  }
}

async function parseStrictPyvenvBasePrefix(pyvenvConfig, runtimeOps) {
  let content
  try {
    content = (await runtimeOps.readFile(pyvenvConfig, 'utf8')).toString()
  } catch {
    throw new Error('paper_local_runtime_pyvenv_invalid')
  }
  const homes = content.split(/\r?\n/).flatMap((line) => {
    const match = /^home = (\/[^\u0000\r\n]+)$/.exec(line)
    return match ? [match[1]] : []
  })
  if (homes.length !== 1 || homes[0] === '/' || resolve(homes[0]) !== homes[0]) throw new Error('paper_local_runtime_pyvenv_invalid')
  return dirname(homes[0])
}

function isWithinPath(candidate, root) {
  if (typeof root !== 'string') return false
  const delta = relative(resolve(root), resolve(candidate))
  return delta === '' || (!delta.startsWith('../') && delta !== '..')
}

function isWithinRuntimeRoot(basePrefix, venvRoot) {
  return isWithinPath(basePrefix, dirname(resolve(venvRoot)))
}

async function assertTrustedDeploymentTree(path, publisherUid, code, runtimeOps) {
  await assertTrustedDeploymentPath(path, publisherUid, { code, type: 'directory' }, runtimeOps)
  const identities = []
  async function visit(current) {
    const status = await runtimeOps.lstat(current).catch(() => null)
    if (!status || status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) throw new Error(code)
    await assertDeploymentMemberWritableState(current, status, publisherUid, code, runtimeOps)
    identities.push({
      path: relative(path, current),
      type: status.isDirectory() ? 'directory' : 'file',
      uid: status.uid,
      mode: status.mode & 0o7777,
      sha256: status.isFile() ? await runtimeOps.hashFile(current) : null,
    })
    if (!status.isDirectory()) return
    for (const entry of await runtimeOps.readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(code)
      await visit(join(current, entry.name))
    }
  }
  await visit(path)
  return sha256Text(stableStringify(identities.sort(compareAggregatePath)))
}

function compareAggregatePath(left, right) {
  return compareUnicodeCodePoints(left.path, right.path)
}

async function assertDeploymentMemberWritableState(path, status, publisherUid, code, runtimeOps) {
  if ((status.uid !== 0 && status.uid !== publisherUid) || (status.mode & 0o022) !== 0) throw new Error(code)
  try {
    await runtimeOps.access(path, constants.W_OK)
    throw new Error(code)
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error
    if (!error || typeof error !== 'object' || !['EACCES', 'EPERM'].includes(error.code)) throw new Error(code)
  }
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertStableRuntimeBinding(first, second) {
  const identity = (binding) => stableStringify({ python: binding.python, venvRoot: binding.venvRoot, basePrefix: binding.basePrefix, interpreterHash: binding.interpreterHash, pyvenvCfgHash: binding.pyvenvCfgHash, baseRuntimeAggregate: binding.baseRuntimeAggregate, sitePackagesAggregate: binding.sitePackagesAggregate })
  if (identity(first) !== identity(second)) throw new Error('paper_local_runtime_changed_before_python_exec')
}

function assertDeploymentIdentity(publisherUid, identity) {
  const { realUid, effectiveUid } = identity
  if (!Number.isSafeInteger(realUid) || !Number.isSafeInteger(effectiveUid) || realUid === 0 || effectiveUid === 0 || realUid !== effectiveUid) throw new Error('paper_local_service_uid_unsafe')
  if (!Number.isSafeInteger(publisherUid) || publisherUid < 0 || publisherUid === realUid) throw new Error('paper_local_release_publisher_must_differ_from_service_uid')
}

async function assertTrustedDeploymentPath(path, publisherUid, options, runtimeOps) {
  const target = resolve(path)
  const parts = target.split('/').filter(Boolean)
  const ancestors = ['/']
  let current = ''
  for (const part of parts) {
    current += `/${part}`
    ancestors.push(current)
  }
  for (let index = 0; index < ancestors.length; index += 1) {
    const candidate = ancestors[index]
    const isLeaf = index === ancestors.length - 1
    const status = await runtimeOps.lstat(candidate).catch(() => null)
    if (!status || (status.uid !== 0 && status.uid !== publisherUid) || (status.mode & 0o022) !== 0) {
      throw new Error(options.code)
    }
    if (status.isSymbolicLink()) {
      if (!(isLeaf && options.allowLeafSymlink === true)) throw new Error(options.code)
    } else if (!isLeaf && !status.isDirectory()) {
      throw new Error(options.code)
    } else if (isLeaf && options.type === 'directory' && !status.isDirectory()) {
      throw new Error(options.code)
    } else if (isLeaf && options.type === 'file' && !status.isFile()) {
      throw new Error(options.code)
    }
    await assertDeploymentMemberWritableState(candidate, status, publisherUid, options.code, runtimeOps)
  }
}

async function assertDeclaredClosure(releasePath, artifactHashes) {
  const declared = new Set(Object.keys(artifactHashes))
  for (const path of declared) assertD1ArtifactPathAllowed(path)
  for (const name of DECLARED_DIRECTORIES) {
    const directory = join(releasePath, name)
    const status = await lstat(directory)
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`release_artifact_type_forbidden:${name}`)
    }
    await walkDeclared(releasePath, directory, declared)
  }
  for (const name of ['package.json', 'pnpm-lock.yaml']) {
    if (!declared.has(name)) throw new Error(`release_executable_closure_missing:${name}`)
  }
}

async function assertExactD1MaterializedClosure(releasePath, artifactHashes) {
  const declared = new Set([
    ...Object.keys(artifactHashes),
    MANIFEST_FILE,
  ])
  async function walk(directory) {
    let hasDeclaredDescendant = false
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name)
      const childRelative = relative(releasePath, child).replaceAll('\\', '/')
      if (entry.isSymbolicLink()) {
        throw new Error(`release_artifact_symlink_forbidden:${childRelative}`)
      }
      if (entry.isDirectory()) {
        if (await walk(child)) hasDeclaredDescendant = true
        continue
      }
      if (!entry.isFile()) throw new Error(`release_artifact_type_forbidden:${childRelative}`)
      if (!declared.has(childRelative)) {
        throw new Error(`d1_release_materialized_artifact_not_declared:${childRelative}`)
      }
      hasDeclaredDescendant = true
    }
    if (directory !== releasePath && !hasDeclaredDescendant) {
      throw new Error(`d1_release_materialized_directory_not_declared:${relative(releasePath, directory)}`)
    }
    return hasDeclaredDescendant
  }
  await walk(releasePath)
}

function assertD1ArtifactPathAllowed(path) {
  const reason = d1ForbiddenReleasePath(path)
  if (reason) throw new Error(`d1_release_forbidden_artifact:${path}:${reason}`)
  if (!D1_STATIC_ARTIFACTS.has(path) && !D1_CHECK_IDS.some((checkId) => (
    path === `release-metadata/validation-receipts/${checkId}.validation_receipt.v1.json`
  ))) {
    throw new Error(`d1_release_artifact_not_in_allowlist:${path}`)
  }
}

function d1ForbiddenReleasePath(path) {
  if (!isSafeRelativePath(path)) return null
  const segments = path.split('/')
  const filename = segments.at(-1)
  if (segments[0] === 'node_modules') return 'node_application_runtime'
  if (segments[0] === 'default') return 'general_default_bundle'
  if (segments[0] === 'dist' && path !== 'dist/proto/openalice_execution_v1.proto') {
    return 'general_application_dist'
  }
  if (segments.some((segment) => D1_FORBIDDEN_CACHE_SEGMENTS.has(segment))) {
    return 'cache'
  }
  if (segments.some((segment) => D1_FORBIDDEN_TEST_SEGMENTS.has(segment))) {
    return 'test_or_integration'
  }
  if (filename === '.DS_Store' || filename.endsWith('.pyc')) return 'cache'
  if (
    filename.endsWith('.spec.ts')
    || filename.endsWith('.test.ts')
    || filename.endsWith('.integration.ts')
    || filename.endsWith('.integration.spec.ts')
    || filename.startsWith('test_') && filename.endsWith('.py')
    || filename.endsWith('_test.py')
    || filename.endsWith('_test_server.py')
  ) return 'test_or_integration'
  if (D1_FORBIDDEN_EXACT_FILENAMES.has(filename)) return 'test_or_helper'

  const isNautilusSidecar = segments.slice(0, 2).join('/') === 'sidecars/nautilus_paper'
  if (!isNautilusSidecar) return null
  if (
    filename.startsWith('provision_')
    || filename.startsWith('install_')
    || filename.startsWith('generate_')
    || filename.startsWith('verify_dependency')
  ) return 'provision_or_dependency_helper'
  if (
    filename.startsWith('requirements-')
    && filename.endsWith('.lock')
    && path !== RUNTIME_LOCK_PATH
  ) return 'broad_runtime_lock'
  if (
    filename.startsWith('wheelhouse-')
    && filename.endsWith('.sha256')
    && path !== WHEEL_MANIFEST_PATH
  ) return 'broad_wheel_manifest'
  return null
}

async function walkDeclared(releasePath, directory, declared) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name)
    const childRelative = relative(releasePath, child).replaceAll('\\', '/')
    if (entry.isSymbolicLink()) throw new Error(`release_artifact_symlink_forbidden:${childRelative}`)
    if (entry.isDirectory()) {
      await walkDeclared(releasePath, child, declared)
    } else if (entry.isFile()) {
      if (!declared.has(childRelative)) throw new Error(`release_artifact_undeclared:${childRelative}`)
    } else {
      throw new Error(`release_artifact_type_forbidden:${childRelative}`)
    }
  }
}

async function assertNoSymlinkComponents(root, path) {
  const rel = relative(root, path)
  if (rel.startsWith('..') || rel.startsWith('/')) throw new Error('release_path_escape')
  let current = root
  for (const part of rel.split('/').filter(Boolean)) {
    current = join(current, part)
    const status = await lstat(current)
    if (status.isSymbolicLink()) {
      throw new Error(`release_artifact_symlink_forbidden:${relative(root, current)}`)
    }
  }
}

function runCaptured(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const append = (field, chunk) => {
      if (field === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
      if (stdout.length + stderr.length > 1024 * 1024) {
        child.kill('SIGKILL')
        reject(new Error('child_output_limit_exceeded'))
      }
    }
    child.stdout.on('data', (chunk) => append('stdout', chunk))
    child.stderr.on('data', (chunk) => append('stderr', chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`child_terminated_by_signal:${signal}`))
      else resolvePromise({ code: code ?? 1, stdout, stderr })
    })
  })
}

function runForeground(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' })
    const handlers = new Map()
    for (const signal of PAPER_LOCAL_FORWARDED_SIGNALS) {
      const handler = () => child.kill(signal)
      handlers.set(signal, handler)
      process.on(signal, handler)
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler)
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      cleanup()
      if (signal) reject(new Error(`paper_local_supervisor_signal:${signal}`))
      else resolvePromise(code ?? 1)
    })
  })
}

function sanitizedEnvironment() {
  return Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' })
}

function requiredAbsolute(value, name) {
  if (typeof value !== 'string' || !value || !value.startsWith('/') || value.includes('\0')) {
    throw new Error(`absolute_${name}_required`)
  }
  return resolve(value)
}

function requiredUid(value, name) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name}_required`)
  }
  const uid = Number(value)
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error(`${name}_required`)
  return uid
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code)
}

function assertExactKeys(value, keys, code) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (stableStringify(actual) !== stableStringify(expected)) throw new Error(code)
}

function assertExactStringSet(value, expected, code) {
  if (
    !Array.isArray(value)
    || value.length !== expected.length
    || value.some((item) => typeof item !== 'string')
  ) throw new Error(code)
  const actual = new Set(value)
  if (actual.size !== expected.length || expected.some((item) => !actual.has(item))) throw new Error(code)
}

function isSafeRelativePath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && path.split('/').every((part) => part && part !== '.' && part !== '..')
}

function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function assertWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) return
  throw new Error(`release_path_escape:${child}`)
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function sha256Canonical(value) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')
}

function stableStringify(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non_finite_canonical_number')
    return Object.is(value, -0) ? '0' : JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  throw new Error(`unsupported_canonical_value:${typeof value}`)
}

function compareUnicodeCodePoints(left, right) {
  const a = Array.from(left, (item) => item.codePointAt(0) ?? 0)
  const b = Array.from(right, (item) => item.codePointAt(0) ?? 0)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return a.length - b.length
}

function singleLine(value) {
  return value.trim().split(/\r?\n/, 1)[0]?.slice(0, 200) || 'unknown'
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  launchPaperLocal().then((result) => {
    if (typeof result === 'number') {
      process.exitCode = result
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
