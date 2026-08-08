import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { sha256Canonical } from '../sidecar/contracts.js'
import {
  assertPrimaryCredentialRotationReady,
  type CredentialRotationReceiptV1,
} from './credential_rotation.js'
import {
  validateReleaseManifest,
  type ReleaseManifestV1,
  type ReleaseValidationReceiptBinding,
} from './release_manifest.js'

const SHA256_RE = /^[a-f0-9]{64}$/
const COMMIT_RE = /^[a-f0-9]{40}$/
const EMPTY_DIRTY_STATE_HASH = createHash('sha256').update('').digest('hex')
const REQUIRED_RELEASE_CLOSURE = [
  'dist/',
  'scripts/',
  'src/',
  'ops/',
  'default/',
  'package.json',
  'release-metadata/',
] as const

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
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export async function verifyReleaseDirectory(
  releaseRoot: string,
  releaseId: string,
): Promise<ReleaseManifestV1> {
  assertReleaseId(releaseId)
  const root = await realpath(resolve(releaseRoot))
  const releasePath = resolve(root, releaseId)
  assertWithin(root, releasePath)
  const manifestPath = join(releasePath, 'release_manifest.v1.json')
  const manifest = validateReleaseManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  )
  if (manifest.releaseId !== releaseId) throw new Error('release_directory_id_mismatch')
  for (const [relativePath, expectedHash] of Object.entries(manifest.artifactHashes)) {
    const artifactPath = resolve(releasePath, relativePath)
    assertWithin(releasePath, artifactPath)
    const actualHash = await sha256File(artifactPath)
    if (actualHash !== expectedHash) {
      throw new Error(`release_artifact_hash_mismatch:${relativePath}`)
    }
  }
  return manifest
}

export async function writeImmutableReleaseManifest(
  releasePath: string,
  manifest: ReleaseManifestV1,
): Promise<string> {
  const validated = validateReleaseManifest(manifest)
  const path = join(resolve(releasePath), 'release_manifest.v1.json')
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
  try {
    if (!options.credentialRotationReceiptPath) {
      throw new Error('credential_rotation_receipt_missing')
    }
    credentialRotation = await loadCredentialRotationReceiptBinding(
      options.credentialRotationReceiptPath,
      options.credentialRotationReceiptScope ?? 'production',
    )
    const manifest = await verifyReleaseDirectory(options.releaseRoot, options.releaseId)
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
    await persistSwitchReceipt(options.releaseRoot, receipt, options.receiptDir)
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
  try {
    const manifest = await verifyReleaseDirectory(options.releaseRoot, options.releaseId)
    if (manifest.dirtyStateHash !== EMPTY_DIRTY_STATE_HASH) {
      throw new Error('research_release_dirty_source')
    }
    assertFullReleaseClosure(manifest)
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
    await persistSwitchReceipt(options.releaseRoot, receipt, options.receiptDir)
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
  try {
    if (!fromCommit) throw new Error('current_release_pointer_missing')
    if (!toCommit) throw new Error('previous_release_pointer_missing')
    const manifest = await verifyReleaseDirectory(options.releaseRoot, toCommit)
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
    await persistSwitchReceipt(options.releaseRoot, receipt, options.receiptDir)
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
  try {
    if (!fromCommit) throw new Error('research_current_release_pointer_missing')
    if (!toCommit) throw new Error('research_previous_release_pointer_missing')
    const manifest = await verifyReleaseDirectory(options.releaseRoot, toCommit)
    if (manifest.liveExecutionArmed !== false) throw new Error('research_release_live_execution_armed')
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
    await persistSwitchReceipt(options.releaseRoot, receipt, options.receiptDir)
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
    await persistSwitchReceipt(options.releaseRoot, receipt, options.receiptDir)
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

export async function loadValidationReceiptBinding(options: {
  path: string
  sourceCommit: string
  dirtyStateHash: string
  now?: Date
}): Promise<ReleaseValidationReceiptBinding> {
  const now = options.now ?? new Date()
  const raw = await readFile(options.path)
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

function assertFullReleaseClosure(manifest: ReleaseManifestV1): void {
  const paths = Object.keys(manifest.artifactHashes)
  for (const prefix of REQUIRED_RELEASE_CLOSURE) {
    if (!paths.some((path) => path === prefix || path.startsWith(prefix))) {
      throw new Error(`research_release_closure_missing:${prefix}`)
    }
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
