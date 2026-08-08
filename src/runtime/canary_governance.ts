import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { sha256Canonical } from '../sidecar/contracts.js'
import type { RuntimePaths } from './runtime-paths.js'
import {
  activateRelease,
  readReleasePointer,
  rollbackRelease,
  verifyReleaseDirectory,
  type ReleaseSwitchReceiptV1,
} from './release_manager.js'

const SHA256_RE = /^[a-f0-9]{64}$/
const COMMIT_RE = /^[a-f0-9]{40}$/
const runtimeCapabilitiesSchema = z.object({
  ownsCron: z.boolean(),
  initializesAccounts: z.boolean(),
  orderSubmissionPathEnabled: z.boolean(),
  writesPromotion: z.boolean(),
  writesSharedData: z.boolean(),
}).strict()

export const canaryReadinessReceiptV1Schema = z.object({
  schemaVersion: z.literal('canary_readiness_receipt.v1'),
  receiptId: z.string().regex(SHA256_RE),
  scope: z.enum(['isolated_test', 'production_canary']),
  generatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  /** Wall-clock observation duration used by the production cutover gate. */
  observationDurationSeconds: z.number().int().nonnegative().optional(),
  releaseId: z.string().regex(COMMIT_RE),
  manifestHash: z.string().regex(SHA256_RE),
  runtimeRole: z.enum(['primary', 'canary', 'test']),
  pathFingerprints: z.object({
    state: z.string().regex(SHA256_RE),
    artifact: z.string().regex(SHA256_RE),
    log: z.string().regex(SHA256_RE),
    sharedDataInput: z.string().regex(SHA256_RE),
  }).strict(),
  paths: z.object({
    state: z.string().min(1),
    artifact: z.string().min(1),
    log: z.string().min(1),
    sharedDataInput: z.string().min(1),
  }).strict(),
  pathIsolation: z.enum(['pass', 'fail']),
  ports: z.object({
    web: z.number().int().min(1024).max(65535).nullable(),
    mcp: z.number().int().min(1024).max(65535).nullable(),
    primaryWeb: z.number().int().min(1024).max(65535),
    primaryMcp: z.number().int().min(1024).max(65535),
  }).strict(),
  capabilities: runtimeCapabilitiesSchema,
  observations: z.object({
    readiness: z.enum(['pass', 'fail']),
    cronOwners: z.array(z.string().trim().min(1)),
    accountsInitialized: z.number().int().nonnegative(),
    orderSubmissions: z.number().int().nonnegative(),
    promotionWrites: z.number().int().nonnegative(),
    sharedWrites: z.number().int().nonnegative(),
  }).strict(),
  sharedDataBeforeHash: z.string().regex(SHA256_RE),
  sharedDataAfterHash: z.string().regex(SHA256_RE),
  status: z.enum(['pass', 'blocked']),
  reasonCodes: z.array(z.string().trim().min(1)),
  evidenceRefs: z.array(z.string().trim().min(1)).min(1),
}).strict().superRefine((value, ctx) => {
  const expectedReasons = computeCanaryReasonCodes(value)
  if (JSON.stringify(value.reasonCodes) !== JSON.stringify(expectedReasons)) {
    ctx.addIssue({
      code: 'custom',
      path: ['reasonCodes'],
      message: 'reasonCodes do not match canary evidence',
    })
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.generatedAt)) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt must follow generatedAt' })
  }
  const expected = expectedReasons.length === 0 ? 'pass' : 'blocked'
  if (value.status !== expected) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: `status must be ${expected}` })
  }
})

export type CanaryReadinessReceiptV1 = z.infer<typeof canaryReadinessReceiptV1Schema>

export interface CanaryReadinessObservations {
  readiness: 'pass' | 'fail'
  cronOwners: string[]
  accountsInitialized: number
  orderSubmissions: number
  promotionWrites: number
  sharedWrites: number
}

function computeCanaryReasonCodes(input: {
  runtimeRole: RuntimePaths['role']
  pathFingerprints: { state: string; artifact: string; log: string; sharedDataInput: string }
  paths: { state: string; artifact: string; log: string; sharedDataInput: string }
  pathIsolation: 'pass' | 'fail'
  ports: { web: number | null; mcp: number | null; primaryWeb: number; primaryMcp: number }
  capabilities: {
    ownsCron: boolean
    initializesAccounts: boolean
    orderSubmissionPathEnabled: boolean
    writesPromotion: boolean
    writesSharedData: boolean
  }
  observations: CanaryReadinessObservations
  sharedDataBeforeHash: string
  sharedDataAfterHash: string
}): string[] {
  const reasons: string[] = []
  if (input.runtimeRole !== 'canary') reasons.push('runtime_role_not_canary')
  if (!Object.values(input.capabilities).every((enabled) => enabled === false)) {
    reasons.push('canary_capability_enabled')
  }
  const writeRoots = [input.paths.state, input.paths.artifact, input.paths.log]
  const topologyIsolated = rootsAreDisjoint(writeRoots)
    && writeRoots.every((path) => rootsAreDisjoint([path, input.paths.sharedDataInput]))
  if (!topologyIsolated || input.pathIsolation !== 'pass') {
    reasons.push('canary_write_path_not_isolated')
  }
  for (const key of ['state', 'artifact', 'log', 'sharedDataInput'] as const) {
    if (sha256Text(resolve(input.paths[key])) !== input.pathFingerprints[key]) {
      reasons.push('canary_path_fingerprint_mismatch')
      break
    }
  }
  const { web, mcp, primaryWeb, primaryMcp } = input.ports
  if (!web || !mcp) reasons.push('canary_ports_missing')
  if (web === primaryWeb || mcp === primaryMcp || web === mcp) {
    reasons.push('canary_ports_not_distinct')
  }
  if (input.observations.readiness !== 'pass') reasons.push('canary_readiness_failed')
  if (input.observations.cronOwners.length > 0) reasons.push('canary_cron_owner_present')
  if (input.observations.accountsInitialized > 0) reasons.push('canary_accounts_initialized')
  if (input.observations.orderSubmissions > 0) reasons.push('canary_order_submission_observed')
  if (input.observations.promotionWrites > 0) reasons.push('canary_promotion_write_observed')
  if (input.observations.sharedWrites > 0) reasons.push('canary_shared_write_observed')
  if (input.sharedDataBeforeHash !== input.sharedDataAfterHash) {
    reasons.push('canary_shared_data_changed')
  }
  return [...new Set(reasons)].sort()
}

export function buildCanaryReadinessReceipt(input: {
  scope: CanaryReadinessReceiptV1['scope']
  generatedAt: string
  expiresAt: string
  releaseId: string
  manifestHash: string
  runtime: RuntimePaths
  primaryPorts: { web: number; mcp: number }
  observations: CanaryReadinessObservations
  sharedDataBeforeHash: string
  sharedDataAfterHash: string
  evidenceRefs: string[]
  observationDurationSeconds?: number
}): CanaryReadinessReceiptV1 {
  const writeRoots = [
    input.runtime.stateDir,
    input.runtime.artifactDir,
    input.runtime.logDir,
  ]
  const pathIsolation = rootsAreDisjoint(writeRoots)
    && writeRoots.every((path) => rootsAreDisjoint([path, input.runtime.sharedDataInputDir]))
  const web = input.runtime.portOverrides.web
  const mcp = input.runtime.portOverrides.mcp
  const evidence = {
    scope: input.scope,
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
    releaseId: input.releaseId,
    manifestHash: input.manifestHash,
    ...(input.observationDurationSeconds !== undefined
      ? { observationDurationSeconds: input.observationDurationSeconds }
      : {}),
    runtimeRole: input.runtime.role,
    pathFingerprints: {
      state: sha256Text(resolve(input.runtime.stateDir)),
      artifact: sha256Text(resolve(input.runtime.artifactDir)),
      log: sha256Text(resolve(input.runtime.logDir)),
      sharedDataInput: sha256Text(resolve(input.runtime.sharedDataInputDir)),
    },
    paths: {
      state: resolve(input.runtime.stateDir),
      artifact: resolve(input.runtime.artifactDir),
      log: resolve(input.runtime.logDir),
      sharedDataInput: resolve(input.runtime.sharedDataInputDir),
    },
    pathIsolation: pathIsolation ? 'pass' as const : 'fail' as const,
    ports: {
      web: web ?? null,
      mcp: mcp ?? null,
      primaryWeb: input.primaryPorts.web,
      primaryMcp: input.primaryPorts.mcp,
    },
    capabilities: { ...input.runtime.capabilities },
    observations: {
      ...input.observations,
      cronOwners: [...new Set(input.observations.cronOwners)].sort(),
    },
    sharedDataBeforeHash: input.sharedDataBeforeHash,
    sharedDataAfterHash: input.sharedDataAfterHash,
  }
  const reasons = computeCanaryReasonCodes(evidence)
  const core = {
    ...evidence,
    status: reasons.length === 0 ? 'pass' as const : 'blocked' as const,
    reasonCodes: [...new Set(reasons)].sort(),
    evidenceRefs: [...new Set(input.evidenceRefs)].sort(),
  }
  return canaryReadinessReceiptV1Schema.parse({
    schemaVersion: 'canary_readiness_receipt.v1',
    receiptId: sha256Canonical(core),
    ...core,
  })
}

export function validateCanaryReadinessReceipt(input: unknown): CanaryReadinessReceiptV1 {
  const receipt = canaryReadinessReceiptV1Schema.parse(input)
  const { schemaVersion: _schemaVersion, receiptId, ...core } = receipt
  if (sha256Canonical(core) !== receiptId) throw new Error('canary_readiness_receipt_hash_mismatch')
  return receipt
}

export function assertCanaryReady(
  input: unknown,
  requiredScope: CanaryReadinessReceiptV1['scope'],
  now = new Date(),
): CanaryReadinessReceiptV1 {
  const receipt = validateCanaryReadinessReceipt(input)
  if (receipt.scope !== requiredScope) throw new Error('canary_readiness_scope_mismatch')
  if (receipt.status !== 'pass') throw new Error('canary_readiness_blocked')
  if (Date.parse(receipt.expiresAt) <= now.getTime()) throw new Error('canary_readiness_stale')
  return receipt
}

const fileEvidenceSchema = z.object({
  sourceFingerprint: z.string().regex(SHA256_RE),
  contentHash: z.string().regex(SHA256_RE),
  backupPath: z.string().min(1),
  backupHash: z.string().regex(SHA256_RE),
}).strict()

export const switchPreflightSnapshotV1Schema = z.object({
  schemaVersion: z.literal('switch_preflight_snapshot.v1'),
  snapshotId: z.string().regex(SHA256_RE),
  scope: z.enum(['isolated_test', 'production']),
  capturedAt: z.string().datetime(),
  currentCommit: z.string().regex(COMMIT_RE).nullable(),
  previousCommit: z.string().regex(COMMIT_RE).nullable(),
  currentManifestHash: z.string().regex(SHA256_RE).nullable(),
  previousManifestHash: z.string().regex(SHA256_RE).nullable(),
  lockDirectoryObserved: z.boolean(),
  cronLocks: z.array(z.object({
    nameFingerprint: z.string().regex(SHA256_RE),
    contentHash: z.string().regex(SHA256_RE),
    mtimeMs: z.number().nonnegative(),
  }).strict()),
  jobsState: fileEvidenceSchema.nullable(),
  launchAgent: fileEvidenceSchema.nullable(),
  dataTails: z.array(z.object({
    sourceFingerprint: z.string().regex(SHA256_RE),
    size: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative(),
    tailHash: z.string().regex(SHA256_RE),
  }).strict()),
  status: z.enum(['pass', 'blocked']),
  reasonCodes: z.array(z.string().trim().min(1)),
  evidenceRefs: z.array(z.string().trim().min(1)).min(1),
}).strict().superRefine((value, ctx) => {
  const expected = value.reasonCodes.length === 0 ? 'pass' : 'blocked'
  if (value.status !== expected) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: `status must be ${expected}` })
  }
})

export type SwitchPreflightSnapshotV1 = z.infer<typeof switchPreflightSnapshotV1Schema>

export async function captureSwitchPreflight(options: {
  scope: SwitchPreflightSnapshotV1['scope']
  releaseRoot: string
  lockDir: string
  jobsStatePath: string
  dataTailPaths: string[]
  launchAgentPath: string
  backupDir: string
  receiptDir?: string
  capturedAt?: Date
}): Promise<SwitchPreflightSnapshotV1> {
  const capturedAt = options.capturedAt ?? new Date()
  const currentCommit = await readReleasePointer(options.releaseRoot, 'current')
  const previousCommit = await readReleasePointer(options.releaseRoot, 'previous')
  const currentManifest = currentCommit
    ? await verifyReleaseDirectory(options.releaseRoot, currentCommit)
    : null
  const previousManifest = previousCommit
    ? await verifyReleaseDirectory(options.releaseRoot, previousCommit)
    : null
  const lockState = await captureLockState(options.lockDir)
  const [jobsState, launchAgent, dataTails] = await Promise.all([
    captureAndBackupFile(options.jobsStatePath, options.backupDir, 'jobs-state'),
    captureAndBackupFile(options.launchAgentPath, options.backupDir, 'launch-agent'),
    Promise.all(options.dataTailPaths.map((path) => captureDataTail(path))),
  ])
  const reasons: string[] = []
  if (!currentCommit || !currentManifest) reasons.push('current_release_missing')
  if (!lockState.observed) reasons.push('cron_lock_directory_missing')
  if (!jobsState) reasons.push('jobs_state_missing')
  if (!launchAgent) reasons.push('launch_agent_missing')
  if (dataTails.length === 0) reasons.push('data_tail_evidence_missing')
  const core = {
    scope: options.scope,
    capturedAt: capturedAt.toISOString(),
    currentCommit,
    previousCommit,
    currentManifestHash: currentManifest?.manifestHash ?? null,
    previousManifestHash: previousManifest?.manifestHash ?? null,
    lockDirectoryObserved: lockState.observed,
    cronLocks: lockState.locks,
    jobsState,
    launchAgent,
    dataTails,
    status: reasons.length === 0 ? 'pass' as const : 'blocked' as const,
    reasonCodes: reasons.sort(),
    evidenceRefs: [
      `release_root:sha256:${sha256Text(resolve(options.releaseRoot))}`,
      `backup_dir:sha256:${sha256Text(resolve(options.backupDir))}`,
    ],
  }
  const snapshot = switchPreflightSnapshotV1Schema.parse({
    schemaVersion: 'switch_preflight_snapshot.v1',
    snapshotId: sha256Canonical(core),
    ...core,
  })
  if (options.receiptDir) {
    await persistImmutableJson(
      join(resolve(options.receiptDir), `${snapshot.capturedAt.replaceAll(':', '-')}.${snapshot.snapshotId}.preflight.json`),
      snapshot,
    )
  }
  return snapshot
}

export async function waitForCronQuiescence(options: {
  lockDir: string
  timeoutMs: number
  pollIntervalMs?: number
}): Promise<void> {
  const started = Date.now()
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 250)
  while (true) {
    const state = await captureLockState(options.lockDir)
    if (!state.observed) throw new Error('cron_lock_directory_missing')
    if (state.locks.length === 0) return
    if (Date.now() - started >= options.timeoutMs) throw new Error('cron_quiescence_timeout')
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs))
  }
}

export interface PostSwitchChecks {
  readiness: boolean
  portOwnership: boolean
  uniqueSchedulerOwner: boolean
  dataContinuity: boolean
  launchAgentVerified: boolean
  reasonCodes: string[]
  evidenceRefs: string[]
}

export interface ControlledSwitchAdapter {
  stopOldPrimary(snapshot: SwitchPreflightSnapshotV1): Promise<void>
  startTarget(releaseId: string): Promise<void>
  verifyTarget(): Promise<PostSwitchChecks>
  restorePrevious(snapshot: SwitchPreflightSnapshotV1): Promise<void>
}

export const controlledSwitchReceiptV1Schema = z.object({
  schemaVersion: z.literal('controlled_switch_receipt.v1'),
  receiptId: z.string().regex(SHA256_RE),
  action: z.enum(['primary_switch', 'rollback_drill']),
  scope: z.enum(['isolated_test', 'production']),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  status: z.enum(['pass', 'rolled_back', 'blocked']),
  fromCommit: z.string().regex(COMMIT_RE).nullable(),
  targetCommit: z.string().regex(COMMIT_RE),
  finalCommit: z.string().regex(COMMIT_RE).nullable(),
  canaryReceiptId: z.string().regex(SHA256_RE).nullable(),
  preflightSnapshotId: z.string().regex(SHA256_RE).nullable(),
  activationReceiptId: z.string().regex(SHA256_RE).nullable(),
  rollbackReceiptId: z.string().regex(SHA256_RE).nullable(),
  postSwitchChecks: z.object({
    readiness: z.boolean(),
    portOwnership: z.boolean(),
    uniqueSchedulerOwner: z.boolean(),
    dataContinuity: z.boolean(),
    launchAgentVerified: z.boolean(),
    manifestVerified: z.boolean(),
  }).strict().nullable(),
  reasonCodes: z.array(z.string().trim().min(1)),
  evidenceRefs: z.array(z.string().trim().min(1)),
}).strict()

export type ControlledSwitchReceiptV1 = z.infer<typeof controlledSwitchReceiptV1Schema>

export async function executeControlledSwitch(options: {
  action: ControlledSwitchReceiptV1['action']
  releaseRoot: string
  targetReleaseId: string
  credentialRotationReceiptPath: string
  canaryReadinessReceipt: unknown
  lockDir: string
  jobsStatePath: string
  dataTailPaths: string[]
  launchAgentPath: string
  backupDir: string
  receiptDir: string
  lockTimeoutMs: number
  pollIntervalMs?: number
  adapter: ControlledSwitchAdapter
  now?: () => Date
}): Promise<ControlledSwitchReceiptV1> {
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const scope = options.action === 'primary_switch' ? 'production' as const : 'isolated_test' as const
  const requiredCanaryScope = options.action === 'primary_switch'
    ? 'production_canary' as const
    : 'isolated_test' as const
  let canary: CanaryReadinessReceiptV1
  let preflight: SwitchPreflightSnapshotV1 | null = null
  let activation: ReleaseSwitchReceiptV1 | null = null
  let rollback: ReleaseSwitchReceiptV1 | null = null
  let postSwitchChecks: ControlledSwitchReceiptV1['postSwitchChecks'] = null
  let stoppedOldPrimary = false
  const reasonCodes: string[] = []
  const evidenceRefs: string[] = []

  try {
    canary = assertCanaryReady(options.canaryReadinessReceipt, requiredCanaryScope, now())
    if (canary.releaseId !== options.targetReleaseId) throw new Error('canary_release_id_mismatch')
    const targetManifest = await verifyReleaseDirectory(options.releaseRoot, options.targetReleaseId)
    if (targetManifest.manifestHash !== canary.manifestHash) {
      throw new Error('canary_manifest_hash_mismatch')
    }
  } catch (error) {
    let fallbackId: string | null = null
    try {
      fallbackId = validateCanaryReadinessReceipt(options.canaryReadinessReceipt).receiptId
    } catch {
      // Invalid input has no trustworthy identifier and must remain blocked.
    }
    return persistControlledSwitchReceipt(options.receiptDir, {
      schemaVersion: 'controlled_switch_receipt.v1',
      receiptId: '',
      action: options.action,
      scope,
      startedAt,
      completedAt: now().toISOString(),
      status: 'blocked',
      fromCommit: await safeReadPointer(options.releaseRoot, 'current'),
      targetCommit: options.targetReleaseId,
      finalCommit: await safeReadPointer(options.releaseRoot, 'current'),
      canaryReceiptId: fallbackId,
      preflightSnapshotId: null,
      activationReceiptId: null,
      rollbackReceiptId: null,
      postSwitchChecks: null,
      reasonCodes: [errorMessage(error)],
      evidenceRefs: [],
    })
  }

  try {
    preflight = await captureSwitchPreflight({
      scope,
      releaseRoot: options.releaseRoot,
      lockDir: options.lockDir,
      jobsStatePath: options.jobsStatePath,
      dataTailPaths: options.dataTailPaths,
      launchAgentPath: options.launchAgentPath,
      backupDir: options.backupDir,
      receiptDir: options.receiptDir,
      capturedAt: now(),
    })
    if (preflight.status !== 'pass') throw new Error('switch_preflight_blocked')
    await waitForCronQuiescence({
      lockDir: options.lockDir,
      timeoutMs: options.lockTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
    })
    await options.adapter.stopOldPrimary(preflight)
    stoppedOldPrimary = true
    activation = await activateRelease({
      releaseRoot: options.releaseRoot,
      releaseId: options.targetReleaseId,
      credentialRotationReceiptPath: options.credentialRotationReceiptPath,
      credentialRotationReceiptScope: options.action === 'rollback_drill'
        ? 'isolated_test'
        : 'production',
      receiptDir: options.receiptDir,
      now: now(),
    })
    if (activation.status !== 'pass') throw new Error('release_activation_blocked')
    await options.adapter.startTarget(options.targetReleaseId)
    const observed = await options.adapter.verifyTarget()
    const manifestVerified = await verifyActiveManifest(
      options.releaseRoot,
      options.targetReleaseId,
      canary.manifestHash,
    )
    postSwitchChecks = {
      readiness: observed.readiness,
      portOwnership: observed.portOwnership,
      uniqueSchedulerOwner: observed.uniqueSchedulerOwner,
      dataContinuity: observed.dataContinuity,
      launchAgentVerified: observed.launchAgentVerified,
      manifestVerified,
    }
    evidenceRefs.push(...observed.evidenceRefs)
    reasonCodes.push(...observed.reasonCodes)
    for (const [name, passed] of Object.entries(postSwitchChecks)) {
      if (!passed) reasonCodes.push(`post_switch_${name}_failed`)
    }
    if (reasonCodes.length > 0) throw new Error('post_switch_verification_failed')
  } catch (error) {
    reasonCodes.push(errorMessage(error))
    if (stoppedOldPrimary && preflight) {
      const pointerChanged = await safeReadPointer(options.releaseRoot, 'current')
        === options.targetReleaseId
      if (activation?.status === 'pass' || pointerChanged) {
        rollback = await rollbackRelease({
          releaseRoot: options.releaseRoot,
          receiptDir: options.receiptDir,
          now: now(),
          drill: options.action === 'rollback_drill',
        })
        if (rollback.status !== 'pass') reasonCodes.push('automatic_rollback_failed')
      }
      try {
        await options.adapter.restorePrevious(preflight)
      } catch (restoreError) {
        reasonCodes.push(`runtime_restore_failed:${errorMessage(restoreError)}`)
      }
    }
  }

  const finalCommit = await safeReadPointer(options.releaseRoot, 'current')
  const rolledBack = Boolean(
    rollback?.status === 'pass'
    && preflight?.currentCommit
    && finalCommit === preflight.currentCommit,
  )
  const success = activation?.status === 'pass' && reasonCodes.length === 0
  const status = success ? 'pass' as const : rolledBack ? 'rolled_back' as const : 'blocked' as const
  return persistControlledSwitchReceipt(options.receiptDir, {
    schemaVersion: 'controlled_switch_receipt.v1',
    receiptId: '',
    action: options.action,
    scope,
    startedAt,
    completedAt: now().toISOString(),
    status,
    fromCommit: preflight?.currentCommit ?? null,
    targetCommit: options.targetReleaseId,
    finalCommit,
    canaryReceiptId: canary.receiptId,
    preflightSnapshotId: preflight?.snapshotId ?? null,
    activationReceiptId: activation?.receiptId ?? null,
    rollbackReceiptId: rollback?.receiptId ?? null,
    postSwitchChecks,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    evidenceRefs: [...new Set(evidenceRefs)].sort(),
  })
}

export async function sha256PathTree(root: string): Promise<string> {
  const absoluteRoot = resolve(root)
  const files: string[] = []
  await collectTreeFiles(absoluteRoot, absoluteRoot, files)
  const evidence = createHash('sha256')
  for (const path of files.sort()) {
    evidence.update(relative(absoluteRoot, path).replaceAll('\\', '/'))
    evidence.update('\0')
    evidence.update(await hashRegularFile(path))
    evidence.update('\0')
  }
  return evidence.digest('hex')
}

async function captureLockState(lockDir: string): Promise<{
  observed: boolean
  locks: SwitchPreflightSnapshotV1['cronLocks']
}> {
  try {
    const root = resolve(lockDir)
    const entries = await readdir(root, { withFileTypes: true })
    const locks: SwitchPreflightSnapshotV1['cronLocks'] = []
    for (const entry of entries.sort((a, b) => compareUnicodeCodePoints(a.name, b.name))) {
      const path = resolve(root, entry.name)
      if (entry.isSymbolicLink()) throw new Error('cron_lock_symlink_forbidden')
      if (!entry.isFile()) continue
      const stat = await lstat(path)
      locks.push({
        nameFingerprint: sha256Text(entry.name),
        contentHash: await hashRegularFile(path),
        mtimeMs: stat.mtimeMs,
      })
    }
    return { observed: true, locks }
  } catch (error) {
    if (isEnoent(error)) return { observed: false, locks: [] }
    throw error
  }
}

async function captureAndBackupFile(
  sourcePath: string,
  backupDir: string,
  label: string,
): Promise<z.infer<typeof fileEvidenceSchema> | null> {
  try {
    const bytes = await readRegularFileNoFollow(sourcePath)
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const backupPath = resolve(backupDir, `${label}.${contentHash}.${basename(sourcePath)}`)
    await persistImmutableBytes(backupPath, bytes)
    return {
      sourceFingerprint: sha256Text(resolve(sourcePath)),
      contentHash,
      backupPath,
      backupHash: await hashRegularFile(backupPath),
    }
  } catch (error) {
    if (isEnoent(error)) return null
    throw error
  }
}

async function captureDataTail(path: string): Promise<SwitchPreflightSnapshotV1['dataTails'][number]> {
  const resolvedPath = resolve(path)
  const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('data_tail_not_regular_file')
    const length = Math.min(4096, stat.size)
    const buffer = Buffer.alloc(length)
    const bytesRead = length > 0
      ? (await handle.read(buffer, 0, length, stat.size - length)).bytesRead
      : 0
    return {
      sourceFingerprint: sha256Text(resolvedPath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      tailHash: createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex'),
    }
  } finally {
    await handle.close()
  }
}

async function verifyActiveManifest(
  releaseRoot: string,
  expectedCommit: string,
  expectedManifestHash: string,
): Promise<boolean> {
  try {
    if (await readReleasePointer(releaseRoot, 'current') !== expectedCommit) return false
    return (await verifyReleaseDirectory(releaseRoot, expectedCommit)).manifestHash
      === expectedManifestHash
  } catch {
    return false
  }
}

async function persistControlledSwitchReceipt(
  receiptDir: string,
  value: Omit<ControlledSwitchReceiptV1, 'receiptId'> & { receiptId: string },
): Promise<ControlledSwitchReceiptV1> {
  const { receiptId: _receiptId, schemaVersion, ...core } = value
  const receipt = controlledSwitchReceiptV1Schema.parse({
    schemaVersion,
    receiptId: sha256Canonical(core),
    ...core,
  })
  await persistImmutableJson(
    join(resolve(receiptDir), `${receipt.completedAt.replaceAll(':', '-')}.${receipt.receiptId}.controlled-switch.json`),
    receipt,
  )
  return receipt
}

async function persistImmutableJson(path: string, value: unknown): Promise<void> {
  await persistImmutableBytes(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`))
}

async function persistImmutableBytes(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o400 })
  } catch (error) {
    if (!isExist(error)) throw error
    const existing = await readRegularFileNoFollow(path)
    if (!existing.equals(bytes)) throw new Error('immutable_backup_conflict')
  }
}

async function readRegularFileNoFollow(path: string): Promise<Buffer> {
  const resolvedPath = resolve(path)
  const initial = await lstat(resolvedPath)
  if (initial.isSymbolicLink()) throw new Error('evidence_symlink_forbidden')
  if (!initial.isFile()) throw new Error('evidence_not_regular_file')
  const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('evidence_not_regular_file')
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function hashRegularFile(path: string): Promise<string> {
  return createHash('sha256').update(await readRegularFileNoFollow(path)).digest('hex')
}

async function collectTreeFiles(root: string, path: string, files: string[]): Promise<void> {
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) throw new Error('canary_tree_symlink_forbidden')
  if (stat.isFile()) {
    files.push(path)
    return
  }
  if (!stat.isDirectory()) throw new Error('canary_tree_type_forbidden')
  for (const name of await readdir(path)) {
    const child = resolve(path, name)
    if (!isWithin(root, child)) throw new Error('canary_tree_path_escape')
    await collectTreeFiles(root, child, files)
  }
}

function rootsAreDisjoint(paths: string[]): boolean {
  const resolved = paths.map((path) => resolve(path))
  for (let left = 0; left < resolved.length; left += 1) {
    for (let right = left + 1; right < resolved.length; right += 1) {
      if (isWithin(resolved[left]!, resolved[right]!) || isWithin(resolved[right]!, resolved[left]!)) {
        return false
      }
    }
  }
  return true
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

async function safeReadPointer(
  releaseRoot: string,
  name: 'current' | 'previous',
): Promise<string | null> {
  try {
    return await readReleasePointer(releaseRoot, name)
  } catch {
    return null
  }
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0)
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!
  }
  return leftPoints.length - rightPoints.length
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isExist(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST'
}
