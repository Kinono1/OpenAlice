#!/usr/bin/env tsx
/** Strictly non-executable D1 PAPER_LOCAL two-identity deployment plan. */

import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { sha256Canonical, stableStringify } from '../src/sidecar/contracts.js'
import { assertSidecarRuntimeContractReceiptBinding, sha256File, verifyReleaseDirectory } from '../src/runtime/release_manager.js'
import { RELEASE_MANIFEST_V2, SIDECAR_RUNTIME_CONTRACT_PATH, validateReleaseManifestV2, type ReleaseManifestV2 } from '../src/runtime/release_manifest.js'

export const PAPER_LOCAL_DEPLOYMENT_PLAN_V1 = 'paper_local_deployment_plan.v1' as const
export const PLAN_STATUS = 'plan_only' as const
const SHA256_RE = /^[a-f0-9]{64}$/
const COMMIT_RE = /^[a-f0-9]{40}$/
const SHELL_ENTRY = 'ops/release/launch_nautilus_paper.sh'
const MJS_ENTRY = 'ops/release/launch_nautilus_paper.mjs'
const SUPERVISOR_SCHEMA = 'sidecars/nautilus_paper/supervisor_config.v1.schema.json'
const EMPTY_DIRTY_STATE_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const ENV_KEYS = [
  'OPENALICE_RELEASE_DIR', 'OPENALICE_PAPER_LOCAL_SUPERVISOR_CONFIG',
  'OPENALICE_NODE', 'OPENALICE_NODE_SHA256', 'OPENALICE_PAPER_LOCAL_MJS_SHA256',
  'OPENALICE_NAUTILUS_PYTHON', 'OPENALICE_RELEASE_PUBLISHER_UID',
] as const
export const FUTURE_ATTESTATION_TYPES = [
  'paper_local_operator_authorization_attestation.v1',
  'paper_local_release_materialization_attestation.v1',
  'paper_local_launcher_pair_attestation.v1',
  'paper_local_runtime_environment_attestation.v1',
  'paper_local_supervisor_config_attestation.v1',
  'paper_local_launchd_installation_attestation.v1',
  'paper_local_service_execution_control_attestation.v1',
  'paper_local_post_start_attestation.v1',
] as const

export interface PaperLocalDeploymentInputs {
  releaseRoot: string; releaseId: string; materializedDirectory: string
  nodePath: string; nodeSha256: string; pythonPath: string
  publisherUid: number; serviceUid: number; supervisorConfigPath: string
  label: string; plistPath: string; logPath: string; errorLogPath: string
  outputRoot: string; createdAt: string; expiresAt: string
}

export interface VerifiedPlanObservations {
  nodeSha256: string; pythonInterpreterHash: string; pythonResolvedPath: string
  supervisorCanonicalSha256: string
}

export interface PlanValidationOptions {
  freshAt?: Date
}

export interface PaperLocalDeploymentPlanV1 {
  schemaVersion: typeof PAPER_LOCAL_DEPLOYMENT_PLAN_V1; status: typeof PLAN_STATUS; planId: string
  createdAt: string; expiresAt: string
  release: { releaseRoot: string; releaseId: string; materializedDirectory: string; manifestHash: string; sourceCommit: string; runtimeEntry: typeof SHELL_ENTRY; shellLauncherPath: string; shellLauncherSha256: string; mjsLauncherPath: string; mjsLauncherSha256: string }
  runtime: { node: { path: string; sha256: string }; python: { path: string; resolvedPath: string; interpreterHash: string; pyvenvCfgHash: string; baseRuntimeAggregate: string; sitePackagesAggregate: string; installedAggregate: string; target: { implementation: 'CPython'; python: '3.13.5'; cacheTag: 'cpython-313'; system: 'Darwin'; macosMajor: 26; machine: 'arm64' } } }
  identities: { publisherUid: number; serviceUid: number }
  supervisor: { configPath: string; canonicalSha256: string; schemaPath: typeof SUPERVISOR_SCHEMA; schemaSha256: string; mode: 'PAPER_LOCAL'; releaseManifestHash: string }
  launchd: { label: string; plistPath: string; serviceDomain: string; programArguments: ['/bin/sh', string, '--release-root', string, '--release-id', string, '--config', string]; workingDirectory: string; runAtLoad: true; keepAlive: true; standardOutPath: string; standardErrorPath: string; environmentVariables: Record<(typeof ENV_KEYS)[number], string>; payloadSha256: string }
  attestations: readonly (typeof FUTURE_ATTESTATION_TYPES)[number][]
  capabilities: { install: false; start: false; launchctl: false; pointerMutation: false; broker: false; network: false; liveExecution: false; mutation: false; deploymentAuthorized: false; deploymentPerformed: false }
}

/** Pure: callers provide a V2 manifest already verified by the release verifier. */
export function buildPaperLocalDeploymentPlan(
  manifest: ReleaseManifestV2, input: PaperLocalDeploymentInputs, observed: VerifiedPlanObservations,
): PaperLocalDeploymentPlanV1 {
  assertInputs(input); assertVerifiedV2(manifest, input)
  const shellPath = join(input.materializedDirectory, 'launch_nautilus_paper.sh')
  const mjsPath = join(input.materializedDirectory, 'launch_nautilus_paper.mjs')
  const environmentVariables = {
    OPENALICE_RELEASE_DIR: input.releaseRoot,
    OPENALICE_PAPER_LOCAL_SUPERVISOR_CONFIG: input.supervisorConfigPath,
    OPENALICE_NODE: input.nodePath,
    OPENALICE_NODE_SHA256: input.nodeSha256,
    OPENALICE_PAPER_LOCAL_MJS_SHA256: manifest.artifactHashes[MJS_ENTRY]!,
    OPENALICE_NAUTILUS_PYTHON: input.pythonPath,
    OPENALICE_RELEASE_PUBLISHER_UID: String(input.publisherUid),
  }
  assertExactKeys(environmentVariables, ENV_KEYS, 'launchd_environment_whitelist_mismatch')
  if (observed.nodeSha256 !== input.nodeSha256
    || observed.pythonInterpreterHash !== manifest.sidecarEnvironment.receipt.interpreterHash) {
    throw new Error('deployment_plan_runtime_hash_binding_mismatch')
  }
  const schemaSha256 = manifest.artifactHashes[SUPERVISOR_SCHEMA]
  if (!SHA256_RE.test(schemaSha256 ?? '')) throw new Error('deployment_plan_supervisor_schema_unbound')
  const launchdCore = {
    label: input.label, plistPath: input.plistPath, serviceDomain: `gui/${input.serviceUid}`, programArguments: ['/bin/sh', shellPath, '--release-root', input.releaseRoot, '--release-id', input.releaseId, '--config', input.supervisorConfigPath] as ['/bin/sh', string, '--release-root', string, '--release-id', string, '--config', string],
    workingDirectory: join(input.releaseRoot, input.releaseId), runAtLoad: true as const, keepAlive: true as const,
    standardOutPath: input.logPath, standardErrorPath: input.errorLogPath, environmentVariables,
  }
  const core = {
    schemaVersion: PAPER_LOCAL_DEPLOYMENT_PLAN_V1, status: PLAN_STATUS, expiresAt: input.expiresAt,
    release: { releaseRoot: input.releaseRoot, releaseId: input.releaseId, materializedDirectory: input.materializedDirectory, manifestHash: manifest.manifestHash, sourceCommit: manifest.sourceCommit, runtimeEntry: SHELL_ENTRY, shellLauncherPath: shellPath, shellLauncherSha256: manifest.artifactHashes[SHELL_ENTRY]!, mjsLauncherPath: mjsPath, mjsLauncherSha256: manifest.artifactHashes[MJS_ENTRY]! },
    runtime: { node: { path: input.nodePath, sha256: input.nodeSha256 }, python: { path: input.pythonPath, resolvedPath: observed.pythonResolvedPath, interpreterHash: manifest.sidecarEnvironment.receipt.interpreterHash, pyvenvCfgHash: manifest.sidecarEnvironment.receipt.pyvenvCfgHash, baseRuntimeAggregate: manifest.sidecarEnvironment.receipt.baseRuntimeAggregate, sitePackagesAggregate: manifest.sidecarEnvironment.receipt.sitePackagesAggregate, installedAggregate: manifest.sidecarEnvironment.receipt.installedAggregate, target: manifest.sidecarEnvironment.receipt.target } },
    identities: { publisherUid: input.publisherUid, serviceUid: input.serviceUid },
    supervisor: { configPath: input.supervisorConfigPath, canonicalSha256: observed.supervisorCanonicalSha256, schemaPath: SUPERVISOR_SCHEMA, schemaSha256, mode: 'PAPER_LOCAL' as const, releaseManifestHash: manifest.manifestHash },
    launchd: { ...launchdCore, payloadSha256: sha256Canonical(launchdCore) },
    attestations: FUTURE_ATTESTATION_TYPES,
    capabilities: { install: false as const, start: false as const, launchctl: false as const, pointerMutation: false as const, broker: false as const, network: false as const, liveExecution: false as const, mutation: false as const, deploymentAuthorized: false as const, deploymentPerformed: false as const },
  }
  return validatePaperLocalDeploymentPlan({ ...core, planId: sha256Canonical(core), createdAt: input.createdAt })
}

/** Read-only verification of paths and bindings; it never invokes a runtime. */
export async function verifyPaperLocalDeploymentInputs(
  manifest: ReleaseManifestV2, input: PaperLocalDeploymentInputs,
): Promise<VerifiedPlanObservations> {
  assertInputs(input); assertVerifiedV2(manifest, input)
  await assertSidecarRuntimeContractReceiptBinding(
    join(input.releaseRoot, input.releaseId, SIDECAR_RUNTIME_CONTRACT_PATH),
    manifest.sidecarEnvironment.receipt,
  )
  const releaseSchemaPath = join(input.releaseRoot, input.releaseId, SUPERVISOR_SCHEMA)
  await assertSafeRegular(releaseSchemaPath, 'deployment_plan_supervisor_schema_unsafe')
  if (await sha256File(releaseSchemaPath) !== manifest.artifactHashes[SUPERVISOR_SCHEMA]) throw new Error('deployment_plan_supervisor_schema_hash_mismatch')
  await assertSafeRegular(input.nodePath, 'deployment_plan_node_unsafe', true)
  const pythonResolvedPath = await realpath(input.pythonPath).catch(() => null)
  if (!pythonResolvedPath) throw new Error('deployment_plan_python_unsafe')
  await assertSafeRegular(pythonResolvedPath, 'deployment_plan_python_unsafe', true)
  await assertSafeRegular(input.supervisorConfigPath, 'deployment_plan_supervisor_config_unsafe')
  const nodeSha256 = await sha256File(input.nodePath); const pythonInterpreterHash = await sha256File(pythonResolvedPath)
  if (nodeSha256 !== input.nodeSha256 || pythonInterpreterHash !== manifest.sidecarEnvironment.receipt.interpreterHash) throw new Error('deployment_plan_runtime_hash_binding_mismatch')
  const raw = await readFile(input.supervisorConfigPath, 'utf8')
  let config: Record<string, unknown>
  try { config = JSON.parse(raw) as Record<string, unknown> } catch { throw new Error('deployment_plan_supervisor_config_invalid') }
  const canonicalConfig = stableStringify(config)
  if (raw !== canonicalConfig && raw !== `${canonicalConfig}\n`) throw new Error('deployment_plan_supervisor_config_not_canonical')
  let schema: object
  try { schema = JSON.parse(await readFile(releaseSchemaPath, 'utf8')) as object } catch { throw new Error('deployment_plan_supervisor_schema_invalid') }
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema)
  if (!validate(config)) throw new Error('deployment_plan_supervisor_config_schema_invalid')
  const schemaHash = manifest.artifactHashes[SUPERVISOR_SCHEMA]
  if (config.schemaVersion !== 'openalice_paper_supervisor_config.v1' || config.mode !== 'PAPER_LOCAL' || config.releaseManifestHash !== manifest.manifestHash || config.schemaHash !== schemaHash) throw new Error('deployment_plan_supervisor_config_binding_mismatch')
  return { nodeSha256, pythonInterpreterHash, pythonResolvedPath, supervisorCanonicalSha256: sha256Canonical(config) }
}

/** Writes a sealed plan directory only; a plan is not an installation or authorization. */
export async function writePaperLocalDeploymentPlan(plan: PaperLocalDeploymentPlanV1, outputRoot: string, freshAt = new Date()): Promise<string> {
  validatePaperLocalDeploymentPlan(plan, { freshAt })
  await assertOwnerPrivateDirectory(outputRoot, plan.identities.publisherUid)
  const root = await realpath(outputRoot)
  if (root !== resolve(outputRoot)) throw new Error('deployment_plan_output_root_unsafe')
  const target = join(root, `${plan.planId}.plan`)
  try {
    await mkdir(target, { mode: 0o700 })
    const canonical = Buffer.from(`${stableStringify(plan)}\n`, 'utf8')
    await writeNewSynced(join(target, 'plan.json'), canonical)
    await writeNewSynced(join(target, 'SEALED'), Buffer.from(`${plan.planId}\n`, 'utf8'))
    await syncDirectory(target); await syncDirectory(root)
    return target
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('deployment_plan_already_exists')
    throw error
  }
}

async function writeNewSynced(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, constants.O_RDONLY); try { await handle.sync() } finally { await handle.close() } }
async function assertOwnerPrivateDirectory(path: string, uid: number): Promise<void> {
  const status = await lstat(path).catch(() => null)
  if (!status || status.isSymbolicLink() || !status.isDirectory() || status.uid !== uid || (status.mode & 0o077) !== 0) throw new Error('deployment_plan_output_root_unsafe')
}
async function assertSafeRegular(path: string, code: string, executable = false): Promise<void> {
  const status = await lstat(path).catch(() => null)
  if (!status || status.isSymbolicLink() || !status.isFile() || (status.mode & 0o022) !== 0 || executable && (status.mode & 0o111) === 0) throw new Error(code)
}
function assertVerifiedV2(manifest: ReleaseManifestV2, input: PaperLocalDeploymentInputs): void {
  if (manifest.schemaVersion !== RELEASE_MANIFEST_V2) throw new Error('deployment_plan_requires_release_manifest_v2')
  validateReleaseManifestV2(manifest)
  if (manifest.releaseId !== input.releaseId || manifest.sourceCommit !== input.releaseId || !COMMIT_RE.test(input.releaseId)) throw new Error('deployment_plan_release_identity_mismatch')
  if (manifest.runtimeEntry !== SHELL_ENTRY || manifest.admissionDecisionId !== null || manifest.liveExecutionArmed !== false || manifest.dirtyStateHash !== EMPTY_DIRTY_STATE_HASH) throw new Error('deployment_plan_unfrozen_or_live_manifest')
  if (manifest.sidecarEnvironment.receipt.status !== 'pass' || manifest.sidecarEnvironment.receipt.flags.paperOnly !== true || manifest.sidecarEnvironment.receipt.flags.liveTradingAllowed !== false || manifest.sidecarEnvironment.receipt.flags.liveExecutionArmed !== false) throw new Error('deployment_plan_environment_provenance_invalid')
  const now = Date.parse(input.createdAt)
  if (now < Date.parse(manifest.builtAt)) throw new Error('deployment_plan_created_before_release')
  for (const receipt of manifest.validationReceipts) if (receipt.status !== 'pass' || Date.parse(receipt.expiresAt) <= now || Date.parse(input.expiresAt) > Date.parse(receipt.expiresAt)) throw new Error('deployment_plan_evidence_expired')
}
function assertInputs(input: PaperLocalDeploymentInputs): void {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'string' && (value.length === 0 || value.includes('\0'))) throw new Error(`deployment_plan_invalid_${name}`)
  }
  for (const path of [input.releaseRoot, input.materializedDirectory, input.nodePath, input.pythonPath, input.supervisorConfigPath, input.plistPath, input.logPath, input.errorLogPath, input.outputRoot]) if (!isAbsoluteNormalized(path)) throw new Error('deployment_plan_absolute_path_required')
  if (!SHA256_RE.test(input.nodeSha256)) throw new Error('deployment_plan_node_hash_invalid')
  if (!Number.isSafeInteger(input.publisherUid) || input.publisherUid < 0 || !Number.isSafeInteger(input.serviceUid) || input.serviceUid <= 0 || input.publisherUid === input.serviceUid) throw new Error('deployment_plan_two_identity_uid_invalid')
  if (Date.parse(input.createdAt) !== Date.parse(input.createdAt) || Date.parse(input.expiresAt) !== Date.parse(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(input.createdAt) || Date.parse(input.expiresAt) - Date.parse(input.createdAt) > 3_600_000) throw new Error('deployment_plan_expiry_invalid')
}
function isAbsoluteNormalized(path: string): boolean { return path.startsWith('/') && resolve(path) === path }
function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(code)
}

/** Rejects unknown fields and rechecks all derived, closed plan bindings before consumption. */
export function validatePaperLocalDeploymentPlan(value: unknown, options: PlanValidationOptions = {}): PaperLocalDeploymentPlanV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('deployment_plan_invalid')
  const plan = value as PaperLocalDeploymentPlanV1
  assertExactKeys(plan as unknown as Record<string, unknown>, ['schemaVersion', 'status', 'planId', 'createdAt', 'expiresAt', 'release', 'runtime', 'identities', 'supervisor', 'launchd', 'attestations', 'capabilities'], 'deployment_plan_unknown_field')
  if (plan.schemaVersion !== PAPER_LOCAL_DEPLOYMENT_PLAN_V1 || plan.status !== PLAN_STATUS || !SHA256_RE.test(plan.planId)) throw new Error('deployment_plan_invalid')
  assertPlanScalars(plan)
  assertExactKeys(plan.release as unknown as Record<string, unknown>, ['releaseRoot', 'releaseId', 'materializedDirectory', 'manifestHash', 'sourceCommit', 'runtimeEntry', 'shellLauncherPath', 'shellLauncherSha256', 'mjsLauncherPath', 'mjsLauncherSha256'], 'deployment_plan_release_unknown_field')
  assertExactKeys(plan.runtime as unknown as Record<string, unknown>, ['node', 'python'], 'deployment_plan_runtime_unknown_field')
  assertExactKeys(plan.runtime.node as unknown as Record<string, unknown>, ['path', 'sha256'], 'deployment_plan_node_unknown_field')
  assertExactKeys(plan.runtime.python as unknown as Record<string, unknown>, ['path', 'resolvedPath', 'interpreterHash', 'pyvenvCfgHash', 'baseRuntimeAggregate', 'sitePackagesAggregate', 'installedAggregate', 'target'], 'deployment_plan_python_unknown_field')
  assertExactKeys(plan.runtime.python.target as unknown as Record<string, unknown>, ['implementation', 'python', 'cacheTag', 'system', 'macosMajor', 'machine'], 'deployment_plan_python_target_unknown_field')
  assertExactKeys(plan.identities as unknown as Record<string, unknown>, ['publisherUid', 'serviceUid'], 'deployment_plan_identity_unknown_field')
  assertExactKeys(plan.supervisor as unknown as Record<string, unknown>, ['configPath', 'canonicalSha256', 'schemaPath', 'schemaSha256', 'mode', 'releaseManifestHash'], 'deployment_plan_supervisor_unknown_field')
  assertExactKeys(plan.launchd as unknown as Record<string, unknown>, ['label', 'plistPath', 'serviceDomain', 'programArguments', 'workingDirectory', 'runAtLoad', 'keepAlive', 'standardOutPath', 'standardErrorPath', 'environmentVariables', 'payloadSha256'], 'deployment_plan_launchd_unknown_field')
  assertExactKeys(plan.launchd.environmentVariables as Record<string, unknown>, ENV_KEYS, 'launchd_environment_whitelist_mismatch')
  assertExactKeys(plan.capabilities as unknown as Record<string, unknown>, ['install', 'start', 'launchctl', 'pointerMutation', 'broker', 'network', 'liveExecution', 'mutation', 'deploymentAuthorized', 'deploymentPerformed'], 'deployment_plan_capabilities_unknown_field')
  if (plan.release.runtimeEntry !== SHELL_ENTRY || plan.release.shellLauncherPath !== join(plan.release.materializedDirectory, 'launch_nautilus_paper.sh') || plan.release.mjsLauncherPath !== join(plan.release.materializedDirectory, 'launch_nautilus_paper.mjs') || !isAbsoluteNormalized(plan.runtime.python.path) || !isAbsoluteNormalized(plan.runtime.python.resolvedPath) || stableStringify(plan.runtime.python.target) !== stableStringify({ implementation: 'CPython', python: '3.13.5', cacheTag: 'cpython-313', system: 'Darwin', macosMajor: 26, machine: 'arm64' })) throw new Error('deployment_plan_cross_binding_invalid')
  if (!Array.isArray(plan.launchd.programArguments) || stableStringify(plan.launchd.programArguments) !== stableStringify(['/bin/sh', plan.release.shellLauncherPath, '--release-root', plan.release.releaseRoot, '--release-id', plan.release.releaseId, '--config', plan.supervisor.configPath])) throw new Error('deployment_plan_launchd_payload_invalid')
  if (plan.launchd.serviceDomain !== `gui/${plan.identities.serviceUid}` || plan.launchd.workingDirectory !== join(plan.release.releaseRoot, plan.release.releaseId) || plan.launchd.runAtLoad !== true || plan.launchd.keepAlive !== true || stableStringify(plan.launchd.environmentVariables) !== stableStringify({ OPENALICE_RELEASE_DIR: plan.release.releaseRoot, OPENALICE_PAPER_LOCAL_SUPERVISOR_CONFIG: plan.supervisor.configPath, OPENALICE_NODE: plan.runtime.node.path, OPENALICE_NODE_SHA256: plan.runtime.node.sha256, OPENALICE_PAPER_LOCAL_MJS_SHA256: plan.release.mjsLauncherSha256, OPENALICE_NAUTILUS_PYTHON: plan.runtime.python.path, OPENALICE_RELEASE_PUBLISHER_UID: String(plan.identities.publisherUid) })) throw new Error('deployment_plan_launchd_payload_invalid')
  const { payloadSha256, ...launchdCore } = plan.launchd
  if (payloadSha256 !== sha256Canonical(launchdCore)) throw new Error('deployment_plan_launchd_hash_invalid')
  if (plan.supervisor.mode !== 'PAPER_LOCAL' || plan.supervisor.releaseManifestHash !== plan.release.manifestHash || plan.supervisor.schemaPath !== SUPERVISOR_SCHEMA || plan.runtime.python.interpreterHash === null || plan.capabilities.install !== false || plan.capabilities.start !== false || plan.capabilities.launchctl !== false || plan.capabilities.pointerMutation !== false || plan.capabilities.broker !== false || plan.capabilities.network !== false || plan.capabilities.liveExecution !== false || plan.capabilities.mutation !== false || plan.capabilities.deploymentAuthorized !== false || plan.capabilities.deploymentPerformed !== false || stableStringify(plan.attestations) !== stableStringify(FUTURE_ATTESTATION_TYPES)) throw new Error('deployment_plan_capability_or_binding_invalid')
  const { planId: computedPlanId, createdAt: _createdAt, ...core } = plan
  if (computedPlanId !== sha256Canonical(core)) throw new Error('deployment_plan_id_mismatch')
  assertInputs({ releaseRoot: plan.release.releaseRoot, releaseId: plan.release.releaseId, materializedDirectory: plan.release.materializedDirectory, nodePath: plan.runtime.node.path, nodeSha256: plan.runtime.node.sha256, pythonPath: plan.runtime.python.path, publisherUid: plan.identities.publisherUid, serviceUid: plan.identities.serviceUid, supervisorConfigPath: plan.supervisor.configPath, label: plan.launchd.label, plistPath: plan.launchd.plistPath, logPath: plan.launchd.standardOutPath, errorLogPath: plan.launchd.standardErrorPath, outputRoot: '/validated-output-root', createdAt: plan.createdAt, expiresAt: plan.expiresAt })
  if (options.freshAt !== undefined) {
    const freshTimestamp = options.freshAt instanceof Date ? options.freshAt.getTime() : Number.NaN
    if (!Number.isFinite(freshTimestamp) || Date.parse(plan.createdAt) > freshTimestamp || Date.parse(plan.expiresAt) <= freshTimestamp) throw new Error('deployment_plan_not_fresh')
  }
  return plan
}
function assertPlanScalars(plan: PaperLocalDeploymentPlanV1): void {
  if (!COMMIT_RE.test(plan.release.releaseId) || plan.release.sourceCommit !== plan.release.releaseId || !SHA256_RE.test(plan.release.manifestHash) || ![plan.release.shellLauncherSha256, plan.release.mjsLauncherSha256, plan.runtime.node.sha256, plan.runtime.python.interpreterHash, plan.runtime.python.pyvenvCfgHash, plan.runtime.python.baseRuntimeAggregate, plan.runtime.python.sitePackagesAggregate, plan.runtime.python.installedAggregate, plan.supervisor.canonicalSha256, plan.supervisor.schemaSha256].every(value => SHA256_RE.test(value)) || ![plan.release.releaseRoot, plan.release.materializedDirectory, plan.release.shellLauncherPath, plan.release.mjsLauncherPath, plan.runtime.node.path, plan.runtime.python.path, plan.runtime.python.resolvedPath, plan.supervisor.configPath, plan.launchd.plistPath, plan.launchd.workingDirectory, plan.launchd.standardOutPath, plan.launchd.standardErrorPath].every(isAbsoluteNormalized) || !Number.isSafeInteger(plan.identities.publisherUid) || plan.identities.publisherUid < 0 || !Number.isSafeInteger(plan.identities.serviceUid) || plan.identities.serviceUid <= 0 || plan.identities.publisherUid === plan.identities.serviceUid || !/^\S(?:[^\r\n\t]*\S)?$/.test(plan.launchd.label) || !isExactIsoMs(plan.createdAt) || !isExactIsoMs(plan.expiresAt)) throw new Error('deployment_plan_scalar_invalid')
}
function isExactIsoMs(value: string): boolean { const timestamp = Date.parse(value); return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value }

function parseCli(argv: string[]): PaperLocalDeploymentInputs {
  const expected = ['releaseRoot', 'releaseId', 'materializedDirectory', 'nodePath', 'nodeSha256', 'pythonPath', 'publisherUid', 'serviceUid', 'supervisorConfigPath', 'label', 'plistPath', 'logPath', 'errorLogPath', 'outputRoot', 'createdAt', 'expiresAt'] as const
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) { const key = argv[i]; const value = argv[i + 1]; if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error('deployment_plan_cli_arguments_invalid'); const name = key.slice(2); if (!expected.includes(name as typeof expected[number]) || values.has(name)) throw new Error('deployment_plan_cli_arguments_invalid'); values.set(name, value); i += 1 }
  if (values.size !== expected.length) throw new Error('deployment_plan_cli_arguments_incomplete')
  return { releaseRoot: values.get('releaseRoot')!, releaseId: values.get('releaseId')!, materializedDirectory: values.get('materializedDirectory')!, nodePath: values.get('nodePath')!, nodeSha256: values.get('nodeSha256')!, pythonPath: values.get('pythonPath')!, publisherUid: Number(values.get('publisherUid')), serviceUid: Number(values.get('serviceUid')), supervisorConfigPath: values.get('supervisorConfigPath')!, label: values.get('label')!, plistPath: values.get('plistPath')!, logPath: values.get('logPath')!, errorLogPath: values.get('errorLogPath')!, outputRoot: values.get('outputRoot')!, createdAt: values.get('createdAt')!, expiresAt: values.get('expiresAt')! }
}
async function main(): Promise<void> {
  const input = parseCli(process.argv.slice(2))
  const manifest = await verifyReleaseDirectory(input.releaseRoot, input.releaseId)
  if (manifest.schemaVersion !== RELEASE_MANIFEST_V2) throw new Error('deployment_plan_requires_release_manifest_v2')
  const observed = await verifyPaperLocalDeploymentInputs(manifest, input)
  const plan = buildPaperLocalDeploymentPlan(manifest, input, observed)
  console.log(await writePaperLocalDeploymentPlan(plan, input.outputRoot))
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
