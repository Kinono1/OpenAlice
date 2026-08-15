import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { sha256Canonical, stableStringify } from '../sidecar/contracts.js'
import {
  assertPrimaryCredentialRotationReady,
  type CredentialRotationReceiptV1,
} from './credential_rotation.js'
import {
  D1_RELEASE_CHECK_IDS,
  D1_RELEASE_REQUIRED_ARTIFACT_PATHS,
  RELEASE_MANIFEST_V2,
  assertNoForbiddenD1ReleaseArtifactPaths,
  validateAnyReleaseManifest,
  validateReleaseManifest,
  validateReleaseManifestV2,
  sidecarEnvironmentReceiptV1Schema,
  type ReleaseManifest,
  type ReleaseManifestV1,
  type ReleaseManifestV2,
  type ReleaseValidationReceiptBinding,
  type SidecarEnvironmentReceiptV1,
} from './release_manifest.js'

const SHA256_RE = /^[a-f0-9]{64}$/
const COMMIT_RE = /^[a-f0-9]{40}$/
const EMPTY_DIRTY_STATE_HASH = createHash('sha256').update('').digest('hex')
export const PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_REQUIRED =
  'paper_local_two_identity_deployment_required' as const
export const D1_RELEASE_GATE_BUNDLE_FILENAME = 'd1_release_bundle.v1.json' as const
const REQUIRED_RELEASE_CLOSURE_V1 = [
  'dist/',
  'scripts/',
  'src/',
  'sidecars/',
  'ops/',
  'default/',
  'node_modules/.bin/tsx',
  'package.json',
  'pnpm-lock.yaml',
  'release-metadata/',
] as const

// V2 uses a protected Node launcher to start the standalone Python PAPER_LOCAL
// sidecar.  It must not inherit the application deploy image (including
// dist/main.js or node_modules) merely because V1 did.  The exact materialized
// artifact set is explicitly required below; it is not a rebuildable Node app.
const REQUIRED_RELEASE_CLOSURE_V2 = [
  'dist/',
  'scripts/',
  'src/',
  'sidecars/',
  'ops/',
  'package.json',
  'pnpm-lock.yaml',
  'release-metadata/',
] as const

const d1ReleaseGateBundleSchema = z.object({
  schemaVersion: z.literal('d1_release_bundle.v1'),
  bundleId: z.string().regex(SHA256_RE),
  sourceCommit: z.string().regex(COMMIT_RE),
  dirtyStateHash: z.string().regex(SHA256_RE),
  environmentReceipt: z.object({
    path: z.literal('d1.sidecar.environment.environment_receipt.v1.json'),
    sha256: z.string().regex(SHA256_RE),
  }).strict(),
  validationReceipts: z.array(z.object({
    checkId: z.enum(D1_RELEASE_CHECK_IDS),
    path: z.string().trim().min(1).max(300),
    sha256: z.string().regex(SHA256_RE),
  }).strict()).length(D1_RELEASE_CHECK_IDS.length),
  sealedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict()

export const REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES = [
  'dist/proto/openalice_execution_v1.proto',
  'src/sidecar/proto/openalice_execution_v1.proto',
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
  'sidecars/nautilus_paper/artifacts.py',
  'sidecars/nautilus_paper/contract.py',
  'sidecars/nautilus_paper/core.py',
  'sidecars/nautilus_paper/dependency_lock.v1.json',
  'sidecars/nautilus_paper/dependency_verification.v1.json',
  'sidecars/nautilus_paper/environment.py',
  'sidecars/nautilus_paper/generate_proto.py',
  'sidecars/nautilus_paper/generated/__init__.py',
  'sidecars/nautilus_paper/generated/openalice_execution_v1_pb2.py',
  'sidecars/nautilus_paper/generated/openalice_execution_v1_pb2_grpc.py',
  'sidecars/nautilus_paper/grpc_receiver.py',
  'sidecars/nautilus_paper/ledger.py',
  'sidecars/nautilus_paper/offline_effect.py',
  'sidecars/nautilus_paper/offline_execution.py',
  'sidecars/nautilus_paper/offline_receipt.py',
  'sidecars/nautilus_paper/offline_simulator.py',
  'sidecars/nautilus_paper/runtime.py',
  'sidecars/nautilus_paper/nautilus_artifacts.v1.json',
  'sidecars/nautilus_paper/requirements-macos-arm64-cp313.lock',
  'sidecars/nautilus_paper/wheelhouse-macos-arm64-cp313.sha256',
] as const

/**
 * D1's materialized PAPER_LOCAL sidecar closure. Test servers, fixed test keys,
 * dependency provisioning helpers, caches, and the broad research lock are
 * intentionally absent from this list.
 */
export const REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES_V2 =
  D1_RELEASE_REQUIRED_ARTIFACT_PATHS.filter((path) => (
    path !== 'package.json'
    && path !== 'pnpm-lock.yaml'
    && !path.startsWith('release-metadata/')
  ))

export const EXECUTION_SIDECAR_RUNTIME_COPY_FILES =
  REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES_V2.filter((path) => (
    path.startsWith('sidecars/nautilus_paper/')
  ))

export const releaseSwitchReceiptV1Schema = z.object({
  schemaVersion: z.literal('release_switch_receipt.v1'),
  receiptId: z.string().regex(SHA256_RE),
  action: z.enum([
    'activate',
    'rollback',
    'rollback_drill',
    'activate_research',
    'rollback_research',
    'rollback_research_drill',
  ]),
  executedAt: z.string().datetime(),
  status: z.enum(['pass', 'blocked']),
  fromCommit: z.string().regex(COMMIT_RE).nullable(),
  toCommit: z.string().regex(COMMIT_RE).nullable(),
  currentCommit: z.string().regex(COMMIT_RE).nullable(),
  previousCommit: z.string().regex(COMMIT_RE).nullable(),
  manifestHash: z.string().regex(SHA256_RE).nullable(),
  credentialRotationReceiptId: z.string().regex(SHA256_RE).nullable().optional(),
  credentialRotationReceiptHash: z.string().regex(SHA256_RE).nullable().optional(),
  reasonCodes: z.array(z.string().trim().min(1)),
}).strict()

export type ReleaseSwitchReceiptV1 = z.infer<typeof releaseSwitchReceiptV1Schema>

export type ReleasePointerName =
  | 'current'
  | 'previous'
  | 'research-current'
  | 'research-previous'

export async function sha256File(path: string): Promise<string> {
  const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const status = await handle.stat()
    if (!status.isFile()) throw new Error(`hash_target_not_regular_file:${path}`)
    return createHash('sha256').update(await handle.readFile()).digest('hex')
  } finally {
    await handle.close()
  }
}

export async function verifyReleaseDirectory(
  releaseRoot: string,
  releaseId: string,
): Promise<ReleaseManifest> {
  assertReleaseId(releaseId)
  const root = await realpath(resolve(releaseRoot))
  const releasePath = resolve(root, releaseId)
  assertWithin(root, releasePath)
  const v1ManifestPath = join(releasePath, 'release_manifest.v1.json')
  const v2ManifestPath = join(releasePath, 'release_manifest.v2.json')
  const hasV1 = await pathExists(v1ManifestPath)
  const hasV2 = await pathExists(v2ManifestPath)
  if (hasV1 && hasV2) throw new Error('release_manifest_multiple_versions')
  if (!hasV1 && !hasV2) throw new Error('release_manifest_missing')
  const manifestPath = hasV2 ? v2ManifestPath : v1ManifestPath
  const manifest = validateAnyReleaseManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  )
  if (manifest.releaseId !== releaseId) throw new Error('release_directory_id_mismatch')
  for (const [relativePath, expectedHash] of Object.entries(manifest.artifactHashes)) {
    const artifactPath = resolve(releasePath, relativePath)
    assertWithin(releasePath, artifactPath)
    await assertNoSymlinkComponents(releasePath, artifactPath)
    const artifactStat = await lstat(artifactPath)
    if (artifactStat.isSymbolicLink()) {
      throw new Error(`release_artifact_symlink_forbidden:${relativePath}`)
    }
    const actualHash = await sha256File(artifactPath)
    if (actualHash !== expectedHash) {
      throw new Error(`release_artifact_hash_mismatch:${relativePath}`)
    }
  }
  assertFullReleaseClosure(manifest)
  await assertDeclaredClosure(
    releasePath,
    manifest.artifactHashes,
    manifest.schemaVersion,
  )
  if (manifest.schemaVersion === RELEASE_MANIFEST_V2) {
    await assertExactD1MaterializedClosure(releasePath, manifest.artifactHashes)
  }
  return manifest
}

export async function writeImmutableReleaseManifest(
  releasePath: string,
  manifest: ReleaseManifest,
): Promise<string> {
  const validated = manifest.schemaVersion === RELEASE_MANIFEST_V2
    ? validateReleaseManifestV2(manifest)
    : validateReleaseManifest(manifest)
  const filename = validated.schemaVersion === RELEASE_MANIFEST_V2
    ? 'release_manifest.v2.json'
    : 'release_manifest.v1.json'
  const path = join(resolve(releasePath), filename)
  const bytes = `${JSON.stringify(validated, null, 2)}\n`
  try {
    const existing = await readFile(path, 'utf8')
    if (existing !== bytes) throw new Error('immutable_release_manifest_conflict')
    return path
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o444 })
  return path
}

export async function activateRelease(options: {
  releaseRoot: string
  releaseId: string
  credentialRotationReceiptPath?: string
  credentialRotationReceiptScope?: CredentialRotationReceiptV1['scope']
  receiptDir?: string
  now?: Date
}): Promise<ReleaseSwitchReceiptV1> {
  const now = options.now ?? new Date()
  let fromCommit: string | null = null
  let credentialRotation: CredentialRotationReceiptBinding | null = null
  let suppressBlockedReceipt = false
  try {
    const manifest = await verifyReleaseDirectory(options.releaseRoot, options.releaseId)
    if (manifest.schemaVersion === RELEASE_MANIFEST_V2) {
      suppressBlockedReceipt = true
      throw new Error(PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_REQUIRED)
    }
    if (!options.credentialRotationReceiptPath) {
      throw new Error('credential_rotation_receipt_missing')
    }
    credentialRotation = await loadCredentialRotationReceiptBinding(
      options.credentialRotationReceiptPath,
      options.credentialRotationReceiptScope ?? 'production',
    )
    fromCommit = await readReleasePointer(options.releaseRoot, 'current')
    if (fromCommit && fromCommit !== options.releaseId) {
      await atomicReplaceReleasePointer(options.releaseRoot, 'previous', fromCommit)
    }
    await atomicReplaceReleasePointer(options.releaseRoot, 'current', options.releaseId)
    const receipt = buildSwitchReceipt({
      action: 'activate',
      executedAt: now.toISOString(),
      status: 'pass',
      fromCommit,
      toCommit: options.releaseId,
      currentCommit: options.releaseId,
      previousCommit: fromCommit && fromCommit !== options.releaseId ? fromCommit : null,
      manifestHash: manifest.manifestHash,
      credentialRotationReceiptId: credentialRotation.receipt.receiptId,
      credentialRotationReceiptHash: credentialRotation.receiptHash,
      reasonCodes: [],
    })
    await persistSwitchReceipt(options.releaseRoot, receipt, options.receiptDir)
    return receipt
  } catch (error) {
    const receipt = buildSwitchReceipt({
      action: 'activate',
      executedAt: now.toISOString(),
      status: 'blocked',
      fromCommit,
      toCommit: options.releaseId,
      currentCommit: await readReleasePointer(options.releaseRoot, 'current'),
      previousCommit: await readReleasePointer(options.releaseRoot, 'previous'),
      manifestHash: null,
      credentialRotationReceiptId: credentialRotation?.receipt.receiptId ?? null,
      credentialRotationReceiptHash: credentialRotation?.receiptHash ?? null,
      reasonCodes: [error instanceof Error ? error.message : String(error)],
    })
    if (!suppressBlockedReceipt) {
      await persistSwitchReceipt(options.releaseRoot, receipt, options.receiptDir)
    }
    return receipt
  }
}

/**
 * Activate an engineering-only research release.  This deliberately has no
 * credential-rotation escape hatch and never touches production pointers.
 */
export async function activateResearchRelease(options: {
  releaseRoot: string
  releaseId: string
  receiptDir?: string
  now?: Date
}): Promise<ReleaseSwitchReceiptV1> {
  const now = options.now ?? new Date()
  let fromCommit: string | null = null
  let suppressBlockedReceipt = false
  try {
    const manifest = await verifyReleaseDirectory(options.releaseRoot, options.releaseId)
    if (manifest.schemaVersion === RELEASE_MANIFEST_V2) {
      suppressBlockedReceipt = true
      throw new Error(PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_REQUIRED)
    }
    if (manifest.dirtyStateHash !== EMPTY_DIRTY_STATE_HASH) {
      throw new Error('research_release_dirty_source')
    }
    if (manifest.liveExecutionArmed !== false) {
      throw new Error('research_release_live_execution_armed')
    }
    if (manifest.admissionDecisionId !== null) {
      throw new Error('research_release_admission_decision_must_be_null')
    }
    fromCommit = await readReleasePointer(options.releaseRoot, 'research-current')
    if (fromCommit && fromCommit !== options.releaseId) {
      await atomicReplaceReleasePointer(options.releaseRoot, 'research-previous', fromCommit)
    }
    await atomicReplaceReleasePointer(options.releaseRoot, 'research-current', options.releaseId)
    const receipt = buildSwitchReceipt({
      action: 'activate_research',
      executedAt: now.toISOString(),
      status: 'pass',
      fromCommit,
      toCommit: options.releaseId,
      currentCommit: options.releaseId,
      previousCommit: fromCommit && fromCommit !== options.releaseId ? fromCommit : null,
      manifestHash: manifest.manifestHash,
      credentialRotationReceiptId: null,
      credentialRotationReceiptHash: null,
      reasonCodes: [],
    })
    await persistSwitchReceipt(options.releaseRoot, receipt, options.receiptDir)
    return receipt
  } catch (error) {
    const receipt = buildSwitchReceipt({
      action: 'activate_research',
      executedAt: now.toISOString(),
      status: 'blocked',
      fromCommit,
      toCommit: options.releaseId,
      currentCommit: await readReleasePointer(options.releaseRoot, 'research-current'),
      previousCommit: await readReleasePointer(options.releaseRoot, 'research-previous'),
      manifestHash: null,
      credentialRotationReceiptId: null,
      credentialRotationReceiptHash: null,
      reasonCodes: [error instanceof Error ? error.message : String(error)],
    })
    if (!suppressBlockedReceipt) {
      await persistSwitchReceipt(options.releaseRoot, receipt, options.receiptDir)
    }
    return receipt
  }
}

export async function rollbackRelease(options: {
  releaseRoot: string
  receiptDir?: string
  now?: Date
  drill?: boolean
}): Promise<ReleaseSwitchReceiptV1> {
  const now = options.now ?? new Date()
  const fromCommit = await readReleasePointer(options.releaseRoot, 'current')
  const toCommit = await readReleasePointer(options.releaseRoot, 'previous')
  let suppressBlockedReceipt = false
  try {
    if (!fromCommit) throw new Error('current_release_pointer_missing')
    if (!toCommit) throw new Error('previous_release_pointer_missing')
    const manifest = await verifyReleaseDirectory(options.releaseRoot, toCommit)
    if (manifest.schemaVersion === RELEASE_MANIFEST_V2) {
      suppressBlockedReceipt = true
      throw new Error(PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_REQUIRED)
    }
    await atomicReplaceReleasePointer(options.releaseRoot, 'current', toCommit)
    await atomicReplaceReleasePointer(options.releaseRoot, 'previous', fromCommit)
    const receipt = buildSwitchReceipt({
      action: options.drill ? 'rollback_drill' : 'rollback',
      executedAt: now.toISOString(),
      status: 'pass',
      fromCommit,
      toCommit,
      currentCommit: toCommit,
      previousCommit: fromCommit,
      manifestHash: manifest.manifestHash,
      credentialRotationReceiptId: null,
      credentialRotationReceiptHash: null,
      reasonCodes: [],
    })
    await persistSwitchReceipt(options.releaseRoot, receipt, options.receiptDir)
    return receipt
  } catch (error) {
    const receipt = buildSwitchReceipt({
      action: options.drill ? 'rollback_drill' : 'rollback',
      executedAt: now.toISOString(),
      status: 'blocked',
      fromCommit,
      toCommit,
      currentCommit: await readReleasePointer(options.releaseRoot, 'current'),
      previousCommit: await readReleasePointer(options.releaseRoot, 'previous'),
      manifestHash: null,
      credentialRotationReceiptId: null,
      credentialRotationReceiptHash: null,
      reasonCodes: [error instanceof Error ? error.message : String(error)],
    })
    if (!suppressBlockedReceipt) {
      await persistSwitchReceipt(options.releaseRoot, receipt, options.receiptDir)
    }
    return receipt
  }
}

export async function rollbackResearchRelease(options: {
  releaseRoot: string
  receiptDir?: string
  now?: Date
  drill?: boolean
}): Promise<ReleaseSwitchReceiptV1> {
  const now = options.now ?? new Date()
  const fromCommit = await readReleasePointer(options.releaseRoot, 'research-current')
  const toCommit = await readReleasePointer(options.releaseRoot, 'research-previous')
  let suppressBlockedReceipt = false
  try {
    if (!fromCommit) throw new Error('research_current_release_pointer_missing')
    if (!toCommit) throw new Error('research_previous_release_pointer_missing')
    const manifest = await verifyReleaseDirectory(options.releaseRoot, toCommit)
    if (manifest.schemaVersion === RELEASE_MANIFEST_V2) {
      suppressBlockedReceipt = true
      throw new Error(PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_REQUIRED)
    }
    if (manifest.dirtyStateHash !== EMPTY_DIRTY_STATE_HASH) {
      throw new Error('research_release_dirty_source')
    }
    if (manifest.liveExecutionArmed !== false) throw new Error('research_release_live_execution_armed')
    if (manifest.admissionDecisionId !== null) {
      throw new Error('research_release_admission_decision_must_be_null')
    }
    await atomicReplaceReleasePointer(options.releaseRoot, 'research-current', toCommit)
    await atomicReplaceReleasePointer(options.releaseRoot, 'research-previous', fromCommit)
    const receipt = buildSwitchReceipt({
      action: options.drill ? 'rollback_research_drill' : 'rollback_research',
      executedAt: now.toISOString(),
      status: 'pass',
      fromCommit,
      toCommit,
      currentCommit: toCommit,
      previousCommit: fromCommit,
      manifestHash: manifest.manifestHash,
      credentialRotationReceiptId: null,
      credentialRotationReceiptHash: null,
      reasonCodes: [],
    })
    if (!suppressBlockedReceipt) {
      await persistSwitchReceipt(options.releaseRoot, receipt, options.receiptDir)
    }
    return receipt
  } catch (error) {
    const receipt = buildSwitchReceipt({
      action: options.drill ? 'rollback_research_drill' : 'rollback_research',
      executedAt: now.toISOString(),
      status: 'blocked',
      fromCommit,
      toCommit,
      currentCommit: await readReleasePointer(options.releaseRoot, 'research-current'),
      previousCommit: await readReleasePointer(options.releaseRoot, 'research-previous'),
      manifestHash: null,
      credentialRotationReceiptId: null,
      credentialRotationReceiptHash: null,
      reasonCodes: [error instanceof Error ? error.message : String(error)],
    })
    if (!suppressBlockedReceipt) {
      await persistSwitchReceipt(options.releaseRoot, receipt, options.receiptDir)
    }
    return receipt
  }
}

export async function readReleasePointer(
  releaseRoot: string,
  name: ReleasePointerName,
): Promise<string | null> {
  const root = await realpath(resolve(releaseRoot))
  const path = join(root, name)
  try {
    const stat = await lstat(path)
    if (!stat.isSymbolicLink()) throw new Error(`release_pointer_not_symlink:${name}`)
    const target = await readlink(path)
    const targetPath = resolve(root, target)
    assertWithin(root, targetPath)
    const resolvedPath = await realpath(targetPath)
    assertWithin(root, resolvedPath)
    const releaseId = basename(resolvedPath)
    assertReleaseId(releaseId)
    return releaseId
  } catch (error) {
    if (isEnoent(error)) return null
    throw error
  }
}

export async function loadD1ReleaseGateBundle(options: {
  bundleDir: string
  sourceCommit: string
  dirtyStateHash: string
  now?: Date
}): Promise<{
  bundlePath: string
  bundleHash: string
  environmentReceiptPath: string
  environment: { receipt: SidecarEnvironmentReceiptV1; receiptHash: string }
  validationReceiptPaths: readonly string[]
  validationReceipts: readonly ReleaseValidationReceiptBinding[]
}> {
  const now = options.now ?? new Date()
  const bundleDir = resolve(options.bundleDir)
  const directoryStatus = await lstat(bundleDir)
  if (
    directoryStatus.isSymbolicLink()
    || !directoryStatus.isDirectory()
    || (directoryStatus.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && directoryStatus.uid !== process.getuid())
  ) {
    throw new Error('d1_release_bundle_directory_unsafe')
  }
  const expectedEntries = [
    D1_RELEASE_GATE_BUNDLE_FILENAME,
    'd1.sidecar.environment.environment_receipt.v1.json',
    ...D1_RELEASE_CHECK_IDS.map(checkId => (
      `${checkId}.validation_receipt.v1.json`
    )),
  ].sort()
  const entries = await readdir(bundleDir, { withFileTypes: true })
  if (
    entries.some(entry => !entry.isFile() || entry.isSymbolicLink())
    || stableStringify(entries.map(entry => entry.name).sort())
      !== stableStringify(expectedEntries)
  ) {
    throw new Error('d1_release_bundle_closure_mismatch')
  }
  const bundlePath = join(bundleDir, D1_RELEASE_GATE_BUNDLE_FILENAME)
  const handle = await open(bundlePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let raw: Buffer
  try {
    raw = await handle.readFile()
  } finally {
    await handle.close()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('d1_release_bundle_invalid')
  }
  const bundle = d1ReleaseGateBundleSchema.parse(parsed)
  if (
    !raw.equals(Buffer.from(`${stableStringify(bundle)}\n`))
    || bundle.sourceCommit !== options.sourceCommit
    || bundle.dirtyStateHash !== options.dirtyStateHash
    || Date.parse(bundle.sealedAt) > now.getTime()
    || Date.parse(bundle.expiresAt) <= now.getTime()
  ) {
    throw new Error('d1_release_bundle_invalid')
  }
  const { bundleId, ...bundleCore } = bundle
  if (sha256Canonical(bundleCore) !== bundleId) {
    throw new Error('d1_release_bundle_hash_mismatch')
  }
  if (
    bundle.validationReceipts.some((receipt, index) => (
      receipt.checkId !== D1_RELEASE_CHECK_IDS[index]
      || receipt.path !== `${receipt.checkId}.validation_receipt.v1.json`
    ))
  ) {
    throw new Error('d1_release_bundle_receipts_mismatch')
  }
  const environmentReceiptPath = join(
    bundleDir,
    bundle.environmentReceipt.path,
  )
  const environment = await loadSidecarEnvironmentReceiptBinding(
    environmentReceiptPath,
  )
  if (environment.receiptHash !== bundle.environmentReceipt.sha256) {
    throw new Error('d1_release_bundle_environment_hash_mismatch')
  }
  const validationReceiptPaths = bundle.validationReceipts.map(receipt => (
    join(bundleDir, receipt.path)
  ))
  const validationReceipts = await Promise.all(
    bundle.validationReceipts.map(async (receipt, index) => {
      const loaded = await loadValidationReceiptBinding({
        path: validationReceiptPaths[index]!,
        sourceCommit: options.sourceCommit,
        dirtyStateHash: options.dirtyStateHash,
        environmentReceiptHash: environment.receiptHash,
        now,
      })
      if (
        loaded.checkId !== receipt.checkId
        || loaded.receiptHash !== receipt.sha256
        || loaded.expiresAt !== bundle.expiresAt
      ) {
        throw new Error(`d1_release_bundle_receipt_mismatch:${receipt.checkId}`)
      }
      return loaded
    }),
  )
  return {
    bundlePath,
    bundleHash: createHash('sha256').update(raw).digest('hex'),
    environmentReceiptPath,
    environment,
    validationReceiptPaths,
    validationReceipts,
  }
}

export async function loadValidationReceiptBinding(options: {
  path: string
  sourceCommit: string
  dirtyStateHash: string
  environmentReceiptHash?: string
  now?: Date
}): Promise<ReleaseValidationReceiptBinding> {
  const now = options.now ?? new Date()
  const resolvedPath = resolve(options.path)
  const stat = await lstat(resolvedPath)
  if (stat.isSymbolicLink()) throw new Error(`validation_receipt_symlink_forbidden:${options.path}`)
  if (!stat.isFile()) throw new Error(`validation_receipt_not_regular_file:${options.path}`)
  const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let raw: Buffer
  try {
    const openedStat = await handle.stat()
    if (!openedStat.isFile()) {
      throw new Error(`validation_receipt_not_regular_file:${options.path}`)
    }
    raw = await handle.readFile()
  } finally {
    await handle.close()
  }
  const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  if (value.schemaVersion !== 'validation_receipt.v1') {
    throw new Error(`validation_receipt_schema_unknown:${options.path}`)
  }
  if (value.status !== 'pass' || value.exitCode !== 0 || value.sourceClean !== true) {
    throw new Error(`validation_receipt_not_passed:${options.path}`)
  }
  if (value.sourceCommit !== options.sourceCommit) {
    throw new Error(`validation_receipt_source_commit_mismatch:${options.path}`)
  }
  if (value.dirtyStateHash !== options.dirtyStateHash) {
    throw new Error(`validation_receipt_dirty_hash_mismatch:${options.path}`)
  }
  if (
    options.environmentReceiptHash !== undefined
    && value.environmentReceiptHash !== options.environmentReceiptHash
  ) {
    throw new Error(`validation_receipt_environment_hash_mismatch:${options.path}`)
  }
  const expiresAt = requiredString(value.expiresAt, 'expiresAt')
  if (Date.parse(expiresAt) <= now.getTime()) {
    throw new Error(`validation_receipt_stale:${options.path}`)
  }
  return {
    checkId: requiredString(value.checkId, 'checkId'),
    path: options.path,
    receiptHash: createHash('sha256').update(raw).digest('hex'),
    sourceCommit: options.sourceCommit,
    dirtyStateHash: options.dirtyStateHash,
    executedAt: requiredString(value.executedAt, 'executedAt'),
    expiresAt,
    status: 'pass',
  }
}

export async function loadSidecarEnvironmentReceiptBinding(
  path: string,
): Promise<{ receipt: SidecarEnvironmentReceiptV1; receiptHash: string }> {
  const resolvedPath = resolve(path)
  const stat = await lstat(resolvedPath)
  if (stat.isSymbolicLink()) throw new Error('sidecar_environment_receipt_symlink_forbidden')
  if (!stat.isFile()) throw new Error('sidecar_environment_receipt_not_regular_file')
  const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const openedStat = await handle.stat()
    if (!openedStat.isFile()) {
      throw new Error('sidecar_environment_receipt_not_regular_file')
    }
    const raw = await handle.readFile()
    return {
      receipt: sidecarEnvironmentReceiptV1Schema.parse(
        JSON.parse(raw.toString('utf8')),
      ),
      receiptHash: createHash('sha256').update(raw).digest('hex'),
    }
  } finally {
    await handle.close()
  }
}

export async function assertSidecarRuntimeContractReceiptBinding(
  path: string,
  receipt: SidecarEnvironmentReceiptV1,
): Promise<void> {
  const resolvedPath = resolve(path)
  const status = await lstat(resolvedPath)
  if (
    status.isSymbolicLink()
    || !status.isFile()
    || (status.mode & 0o022) !== 0
    || (typeof process.getuid === 'function' && status.uid !== process.getuid())
  ) {
    throw new Error('sidecar_runtime_contract_unsafe')
  }
  const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let raw: Buffer
  try {
    raw = await handle.readFile()
  } finally {
    await handle.close()
  }
  if (createHash('sha256').update(raw).digest('hex') !== receipt.contractHash) {
    throw new Error('sidecar_runtime_contract_hash_mismatch')
  }
  let contract: Record<string, unknown>
  try {
    contract = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error('sidecar_runtime_contract_invalid')
  }
  if (
    !raw.equals(Buffer.from(`${stableStringify(contract)}\n`))
    && !raw.equals(Buffer.from(stableStringify(contract)))
  ) {
    throw new Error('sidecar_runtime_contract_not_canonical')
  }
  const provenance = contract.runtimeProvenance
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new Error('sidecar_runtime_provenance_invalid')
  }
  const value = provenance as Record<string, unknown>
  if (
    stableStringify(Object.keys(value).sort()) !== stableStringify([
      'baseRuntimeAggregate', 'installedAggregate', 'interpreterSha256',
      'pyvenvCfgSha256', 'sitePackagesAggregate', 'status',
    ])
    || value.status !== 'frozen'
    || value.interpreterSha256 !== receipt.interpreterHash
    || value.pyvenvCfgSha256 !== receipt.pyvenvCfgHash
    || value.baseRuntimeAggregate !== receipt.baseRuntimeAggregate
    || value.sitePackagesAggregate !== receipt.sitePackagesAggregate
    || value.installedAggregate !== receipt.installedAggregate
  ) {
    throw new Error('sidecar_runtime_provenance_mismatch')
  }
}

interface CredentialRotationReceiptBinding {
  receipt: CredentialRotationReceiptV1
  receiptHash: string
}

export async function loadCredentialRotationReceiptBinding(
  path: string,
  requiredScope: CredentialRotationReceiptV1['scope'] = 'production',
): Promise<CredentialRotationReceiptBinding> {
  const resolvedPath = resolve(path)
  const stat = await lstat(resolvedPath)
  if (stat.isSymbolicLink()) throw new Error('credential_rotation_receipt_symlink_forbidden')
  if (!stat.isFile()) throw new Error('credential_rotation_receipt_not_regular_file')
  const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const openedStat = await handle.stat()
    if (!openedStat.isFile()) throw new Error('credential_rotation_receipt_not_regular_file')
    const raw = await handle.readFile()
    return {
      receipt: assertPrimaryCredentialRotationReady(
        JSON.parse(raw.toString('utf8')),
        requiredScope,
      ),
      receiptHash: createHash('sha256').update(raw).digest('hex'),
    }
  } finally {
    await handle.close()
  }
}

async function atomicReplaceReleasePointer(
  releaseRoot: string,
  name: ReleasePointerName,
  releaseId: string,
): Promise<void> {
  assertReleaseId(releaseId)
  const requestedRoot = resolve(releaseRoot)
  await mkdir(requestedRoot, { recursive: true })
  const root = await realpath(requestedRoot)
  const releasePath = resolve(root, releaseId)
  assertWithin(root, releasePath)
  await realpath(releasePath)
  const target = join(root, name)
  const temp = join(root, `.${name}.${randomUUID()}.tmp`)
  await symlink(releaseId, temp, 'dir')
  await rename(temp, target)
}

function buildSwitchReceipt(
  core: Omit<ReleaseSwitchReceiptV1, 'schemaVersion' | 'receiptId'>,
): ReleaseSwitchReceiptV1 {
  return releaseSwitchReceiptV1Schema.parse({
    schemaVersion: 'release_switch_receipt.v1',
    receiptId: sha256Canonical(core),
    ...core,
  })
}

async function persistSwitchReceipt(
  releaseRoot: string,
  receipt: ReleaseSwitchReceiptV1,
  receiptDir?: string,
): Promise<void> {
  const dir = resolve(receiptDir ?? join(releaseRoot, 'receipts'))
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${receipt.executedAt.replaceAll(':', '-')}.${receipt.receiptId}.json`)
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o444,
  })
}

function assertReleaseId(value: string): void {
  if (!COMMIT_RE.test(value)) throw new Error(`invalid_release_id:${value}`)
}

function assertWithin(parent: string, child: string): void {
  const rel = relative(resolve(parent), resolve(child))
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) return
  throw new Error(`release_path_escape:${child}`)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing_${field}`)
  return value
}

function assertFullReleaseClosure(manifest: ReleaseManifest): void {
  const paths = Object.keys(manifest.artifactHashes)
  if (manifest.schemaVersion === RELEASE_MANIFEST_V2) {
    assertNoForbiddenD1ReleaseArtifactPaths(paths)
  }
  const requiredClosure = manifest.schemaVersion === RELEASE_MANIFEST_V2
    ? REQUIRED_RELEASE_CLOSURE_V2
    : REQUIRED_RELEASE_CLOSURE_V1
  for (const prefix of requiredClosure) {
    if (!paths.some((path) => path === prefix || path.startsWith(prefix))) {
      throw new Error(`research_release_closure_missing:${prefix}`)
    }
  }
  const requiredFiles = manifest.schemaVersion === RELEASE_MANIFEST_V2
    ? REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES_V2
    : REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES
  for (const requiredPath of requiredFiles) {
    if (!paths.includes(requiredPath)) {
      throw new Error(`execution_sidecar_release_artifact_missing:${requiredPath}`)
    }
  }
}

async function assertDeclaredClosure(
  releasePath: string,
  artifactHashes: Record<string, string>,
  schemaVersion?: ReleaseManifest['schemaVersion'],
): Promise<void> {
  const declared = new Set(Object.keys(artifactHashes))
  if (schemaVersion === RELEASE_MANIFEST_V2) {
    assertNoForbiddenD1ReleaseArtifactPaths(declared)
  }
  const requiredClosure = schemaVersion === RELEASE_MANIFEST_V2
    ? REQUIRED_RELEASE_CLOSURE_V2
    : REQUIRED_RELEASE_CLOSURE_V1
  for (const closure of requiredClosure) {
    const candidate = resolve(releasePath, closure)
    assertWithin(releasePath, candidate)
    if (closure.endsWith('/')) {
      await walkDeclaredClosure(releasePath, candidate, declared)
    } else if (await pathExists(candidate)) {
      const stat = await lstat(candidate)
      if (stat.isSymbolicLink()) throw new Error(`release_artifact_symlink_forbidden:${closure}`)
      if (!stat.isFile()) throw new Error(`release_artifact_type_forbidden:${closure}`)
      if (!declared.has(closure)) throw new Error(`release_artifact_undeclared:${closure}`)
    }
  }
}

/** V2 has no undeclared payload: include only hash-bound artifacts and its manifest. */
async function assertExactD1MaterializedClosure(
  releasePath: string,
  artifactHashes: Record<string, string>,
): Promise<void> {
  const declared = new Set([
    ...Object.keys(artifactHashes),
    'release_manifest.v2.json',
  ])
  async function walk(directory: string): Promise<boolean> {
    let hasDeclaredDescendant = false
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = resolve(directory, entry.name)
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

async function assertNoSymlinkComponents(parent: string, child: string): Promise<void> {
  const root = resolve(parent)
  const rel = relative(root, resolve(child))
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error(`release_path_escape:${child}`)
  }
  let current = root
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, part)
    const status = await lstat(current)
    if (status.isSymbolicLink()) {
      throw new Error(`release_artifact_symlink_forbidden:${relative(root, current)}`)
    }
  }
}

async function walkDeclaredClosure(
  releasePath: string,
  directory: string,
  declared: Set<string>,
): Promise<void> {
  if (!await pathExists(directory)) return
  const directoryStat = await lstat(directory)
  if (directoryStat.isSymbolicLink()) {
    throw new Error(`release_artifact_symlink_forbidden:${relative(releasePath, directory)}`)
  }
  if (!directoryStat.isDirectory()) {
    throw new Error(`release_artifact_type_forbidden:${relative(releasePath, directory)}`)
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = resolve(directory, entry.name)
    assertWithin(releasePath, child)
    const childRelative = relative(releasePath, child).replaceAll('\\', '/')
    if (entry.isSymbolicLink()) {
      throw new Error(`release_artifact_symlink_forbidden:${childRelative}`)
    }
    if (entry.isDirectory()) {
      await walkDeclaredClosure(releasePath, child, declared)
    } else if (entry.isFile()) {
      if (!declared.has(childRelative)) throw new Error(`release_artifact_undeclared:${childRelative}`)
    } else {
      throw new Error(`release_artifact_type_forbidden:${childRelative}`)
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
