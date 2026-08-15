#!/usr/bin/env tsx

import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { validateAdmissionDecision } from '../src/runtime/admission.js'
import {
  D1_RELEASE_BUNDLE_METADATA_PATH,
  D1_RELEASE_CHECK_IDS,
  SIDECAR_ENVIRONMENT_RECEIPT_PATH,
  SIDECAR_RUNTIME_CONTRACT_PATH,
  d1ForbiddenReleasePath,
  buildReleaseManifestV2,
} from '../src/runtime/release_manifest.js'
import {
  EXECUTION_SIDECAR_RUNTIME_COPY_FILES,
  REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES_V2,
  activateRelease,
  activateResearchRelease,
  assertSidecarRuntimeContractReceiptBinding,
  loadD1ReleaseGateBundle,
  readReleasePointer,
  rollbackRelease,
  rollbackResearchRelease,
  sha256File,
  verifyReleaseDirectory,
  writeImmutableReleaseManifest,
} from '../src/runtime/release_manager.js'

const execFileAsync = promisify(execFile)
const COMMIT_RE = /^[a-f0-9]{40}$/
const REGENERABLE_RELEASE_CACHE_NAMES = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.DS_Store',
])

type Command = 'build' | 'verify' | 'activate' | 'rollback' | 'activate-research' | 'rollback-research' | 'status'

export interface LocalReleaseCliArgs {
  command: Command
  releaseRoot: string
  releaseId?: string
  credentialRotationReceiptPath?: string
  receiptPaths: string[]
  requiredChecks: string[]
  admissionDecisionPath: string
  pipelineRegistryPath: string
  dependencyLockPath: string
  strategyConfigPath: string
  runtimeEntry: string
  sidecarEnvironmentReceiptPath?: string
  d1BundlePath?: string
  legacyWipRoot?: string
  freezeReceiptPath?: string
  skipBuild: boolean
  drill: boolean
}

export function parseArgs(argv: string[]): LocalReleaseCliArgs {
  const command = argv[0] as Command | undefined
  if (!command || !['build', 'verify', 'activate', 'rollback', 'activate-research', 'rollback-research', 'status'].includes(command)) {
    throw new Error('command must be build, verify, activate, rollback, activate-research, rollback-research, or status')
  }
  const values = new Map<string, string[]>()
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    const value = !next || next.startsWith('--') ? 'true' : next
    values.set(key, [...(values.get(key) ?? []), value])
    if (next && !next.startsWith('--')) index += 1
  }
  const get = (key: string) => values.get(key)?.at(-1)
  const list = (key: string) => (values.get(key) ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  return {
    command,
    releaseRoot: resolve(get('releaseRoot') ?? 'runtime/releases'),
    releaseId: get('releaseId'),
    credentialRotationReceiptPath: get('credentialRotationReceiptPath')
      ? resolve(get('credentialRotationReceiptPath')!)
      : undefined,
    receiptPaths: list('receipt').map((path) => resolve(path)),
    requiredChecks: list('requiredChecks'),
    admissionDecisionPath: resolve(
      get('admissionDecisionPath') ?? 'data/runtime/admission_decision.v1.json',
    ),
    pipelineRegistryPath: resolve(
      get('pipelineRegistryPath') ?? 'ops/pipeline/pipeline_registry.v1.json',
    ),
    dependencyLockPath: resolve(get('dependencyLockPath') ?? 'pnpm-lock.yaml'),
    strategyConfigPath: resolve(
      get('strategyConfigPath') ?? 'ops/release/strategy_release_config.v1.json',
    ),
    runtimeEntry: get('runtimeEntry') ?? 'ops/release/launch_nautilus_paper.sh',
    sidecarEnvironmentReceiptPath: get('sidecarEnvironmentReceiptPath')
      ? resolve(get('sidecarEnvironmentReceiptPath')!)
      : undefined,
    d1BundlePath: get('d1Bundle')
      ? resolve(get('d1Bundle')!)
      : undefined,
    legacyWipRoot: get('legacyWipRoot')
      ? resolve(get('legacyWipRoot')!)
      : process.env.OPENALICE_LEGACY_WIP_ROOT
        ? resolve(process.env.OPENALICE_LEGACY_WIP_ROOT)
        : undefined,
    freezeReceiptPath: get('freezeReceipt')
      ? resolve(get('freezeReceipt')!)
      : process.env.OPENALICE_LEGACY_WIP_FREEZE_RECEIPT
        ? resolve(process.env.OPENALICE_LEGACY_WIP_FREEZE_RECEIPT)
        : undefined,
    skipBuild: parseBoolean(get('skipBuild'), false),
    drill: parseBoolean(get('drill'), false),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'status') {
    console.log(JSON.stringify({
      current: await readReleasePointer(args.releaseRoot, 'current'),
      previous: await readReleasePointer(args.releaseRoot, 'previous'),
      researchCurrent: await readReleasePointer(args.releaseRoot, 'research-current'),
      researchPrevious: await readReleasePointer(args.releaseRoot, 'research-previous'),
    }, null, 2))
    return
  }
  if (args.command === 'rollback-research') {
    const receipt = await rollbackResearchRelease({
      releaseRoot: args.releaseRoot,
      drill: args.drill,
    })
    console.log(JSON.stringify(receipt, null, 2))
    if (receipt.status !== 'pass') process.exitCode = 1
    return
  }
  if (args.command === 'rollback') {
    const receipt = await rollbackRelease({
      releaseRoot: args.releaseRoot,
      drill: args.drill,
    })
    console.log(JSON.stringify(receipt, null, 2))
    if (receipt.status !== 'pass') process.exitCode = 1
    return
  }
  const releaseId = requiredReleaseId(args.releaseId)
  if (args.command === 'verify') {
    console.log(JSON.stringify(
      await verifyReleaseDirectory(args.releaseRoot, releaseId),
      null,
      2,
    ))
    return
  }
  if (args.command === 'activate') {
    const receipt = await activateRelease({
      releaseRoot: args.releaseRoot,
      releaseId,
      credentialRotationReceiptPath: args.credentialRotationReceiptPath,
    })
    console.log(JSON.stringify(receipt, null, 2))
    if (receipt.status !== 'pass') process.exitCode = 1
    return
  }
  if (args.command === 'activate-research') {
    const receipt = await activateResearchRelease({
      releaseRoot: args.releaseRoot,
      releaseId,
    })
    console.log(JSON.stringify(receipt, null, 2))
    if (receipt.status !== 'pass') process.exitCode = 1
    return
  }
  const manifest = await buildLocalRelease(args)
  console.log(JSON.stringify(manifest, null, 2))
}

export async function buildLocalRelease(
  args: LocalReleaseCliArgs,
) {
  const repoRoot = resolve(process.cwd())
  await verifyFrozenLegacyWip(repoRoot, args)
  const { stdout: commitStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
  })
  const sourceCommit = commitStdout.trim()
  requiredReleaseId(sourceCommit)
  if (args.releaseId && args.releaseId !== sourceCommit) {
    throw new Error('release_id_must_match_head')
  }
  const { stdout: status } = await execFileAsync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: repoRoot, encoding: 'buffer' },
  )
  const dirtyBytes = Buffer.isBuffer(status) ? status : Buffer.from(status)
  if (dirtyBytes.length > 0) throw new Error('engineering_release_requires_clean_source')
  const dirtyStateHash = createHash('sha256').update(dirtyBytes).digest('hex')

  // D1 contains no compiled Node application.  Building/deploying the general
  // application here would reintroduce its broker-capable dist closure.  The
  // retained `--skipBuild` argument is a no-op for this V2-only builder.
  if (args.runtimeEntry !== 'ops/release/launch_nautilus_paper.sh') {
    throw new Error('d1_runtime_entry_mismatch')
  }

  const receiptValidationAt = new Date()
  if (!args.d1BundlePath) {
    throw new Error('d1_release_bundle_path_required')
  }
  if (args.receiptPaths.length > 0 || args.sidecarEnvironmentReceiptPath) {
    throw new Error('d1_release_requires_atomic_bundle_only')
  }
  const d1Bundle = await loadD1ReleaseGateBundle({
    bundleDir: args.d1BundlePath,
    sourceCommit,
    dirtyStateHash,
    now: receiptValidationAt,
  })
  const sidecarEnvironment = d1Bundle.environment
  await assertSidecarRuntimeContractReceiptBinding(
    join(repoRoot, SIDECAR_RUNTIME_CONTRACT_PATH),
    sidecarEnvironment.receipt,
  )
  const validationReceipts = [...d1Bundle.validationReceipts]
  if (validationReceipts.length === 0) {
    throw new Error('engineering_release_receipts_missing')
  }
  const checkIds = new Set(validationReceipts.map((receipt) => receipt.checkId))
  if (checkIds.size !== validationReceipts.length) {
    throw new Error('duplicate_release_receipt_check_id')
  }
  for (const checkId of D1_RELEASE_CHECK_IDS) {
    if (!checkIds.has(checkId)) throw new Error(`required_release_receipt_missing:${checkId}`)
  }
  if (checkIds.size !== D1_RELEASE_CHECK_IDS.length) {
    throw new Error('unexpected_release_receipt_check_id')
  }
  if (
    args.requiredChecks.length > 0
    && !hasExactD1CheckIds(args.requiredChecks)
  ) {
    throw new Error('required_checks_must_equal_d1_gate')
  }

  const admissionDecisionId = await loadSafeAdmissionDecisionId(
    args.admissionDecisionPath,
  )
  if (admissionDecisionId !== null) {
    throw new Error('d1_release_admission_decision_must_be_null')
  }
  const tempRelease = resolve(
    args.releaseRoot,
    `.${sourceCommit}.${randomUUID()}.tmp`,
  )
  const finalRelease = resolve(args.releaseRoot, sourceCommit)
  await mkdir(args.releaseRoot, { recursive: true })
  try {
    // Do not seed D1 from `pnpm deploy`: that package image contains the
    // general Node application and can carry dist/main.js, broker clients, or
    // test helpers.  Materialize only the explicit PAPER_LOCAL source closure.
    for (const relativePath of REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES_V2) {
      if (relativePath.startsWith('sidecars/nautilus_paper/')) continue
      const sourceRelativePath = relativePath === 'dist/proto/openalice_execution_v1.proto'
        ? 'src/sidecar/proto/openalice_execution_v1.proto'
        : relativePath
      await copyReleaseTree(
        resolve(repoRoot, sourceRelativePath),
        resolve(tempRelease, relativePath),
      )
    }
    await copyExecutionSidecarRuntimeTree(repoRoot, tempRelease)
    await copyFile(resolve(repoRoot, 'package.json'), join(tempRelease, 'package.json'))
    await copyFile(resolve(repoRoot, 'pnpm-lock.yaml'), join(tempRelease, 'pnpm-lock.yaml'))
    await mkdir(join(tempRelease, 'release-metadata'), { recursive: true })
    await copyFile(args.pipelineRegistryPath, join(tempRelease, 'release-metadata/pipeline_registry.v1.json'))
    await copyFile(args.dependencyLockPath, join(tempRelease, 'release-metadata/pnpm-lock.yaml'))
    await copyFile(args.strategyConfigPath, join(tempRelease, 'release-metadata/strategy_release_config.v1.json'))
    await copyHashBoundD1Evidence(
      d1Bundle.environmentReceiptPath,
      join(tempRelease, SIDECAR_ENVIRONMENT_RECEIPT_PATH),
      sidecarEnvironment.receiptHash,
      'environment',
    )
    await copyHashBoundD1Evidence(
      d1Bundle.bundlePath,
      join(tempRelease, D1_RELEASE_BUNDLE_METADATA_PATH),
      d1Bundle.bundleHash,
      'bundle',
    )
    const releaseValidationReceipts = []
    for (const receipt of validationReceipts) {
      const receiptPath = `release-metadata/validation-receipts/${receipt.checkId}.validation_receipt.v1.json`
      await copyHashBoundD1Evidence(
        receipt.path,
        join(tempRelease, receiptPath),
        receipt.receiptHash,
        receipt.checkId,
      )
      releaseValidationReceipts.push({ ...receipt, path: receiptPath })
    }

    await assertNoForbiddenD1ReleaseTree(tempRelease)
    const artifactHashes = await collectArtifactHashes(tempRelease, [
      ...REQUIRED_EXECUTION_SIDECAR_RELEASE_FILES_V2,
      'package.json',
      'pnpm-lock.yaml',
      'release-metadata',
    ])
    await assertSourceStillClean(repoRoot, sourceCommit)
    const builtAt = new Date()
    const manifest = buildReleaseManifestV2({
      releaseId: sourceCommit,
      sourceCommit,
      dirtyStateHash,
      builtAt: builtAt.toISOString(),
      runtimeEntry: args.runtimeEntry,
      artifactHashes,
      pipelineRegistryHash: await sha256File(args.pipelineRegistryPath),
      dependencyLockHash: await sha256File(args.dependencyLockPath),
      strategyConfigHash: await sha256File(args.strategyConfigPath),
      validationReceipts: releaseValidationReceipts,
      sidecarEnvironment: {
        receiptPath: SIDECAR_ENVIRONMENT_RECEIPT_PATH,
        receiptHash: sidecarEnvironment.receiptHash,
        contractPath: SIDECAR_RUNTIME_CONTRACT_PATH,
        receipt: sidecarEnvironment.receipt,
      },
      admissionDecisionId: null,
      engineeringChecks: [...D1_RELEASE_CHECK_IDS],
      liveExecutionArmed: false,
    })
    await writeImmutableReleaseManifest(tempRelease, manifest)
    await assertExactD1MaterializedReleaseTree(tempRelease, [
      ...Object.keys(artifactHashes),
      'release_manifest.v2.json',
    ])
    // D1's launcher requires the selected release tree to be non-writable by
    // a distinct service identity. The builder runs as the trusted publisher,
    // so remove group/world write permissions before the atomic publication.
    // Ownership separation and protection of ancestors remain service-manager
    // deployment prerequisites and are checked by the formal launcher.
    await hardenD1ReleaseTree(tempRelease)
    const releaseRootStatus = await lstat(args.releaseRoot)
    if (releaseRootStatus.isSymbolicLink() || !releaseRootStatus.isDirectory()) {
      throw new Error('release_root_type_forbidden')
    }
    await chmod(args.releaseRoot, releaseRootStatus.mode & ~0o022)
    try {
      await rename(tempRelease, finalRelease)
    } catch (error) {
      if (!isExist(error)) throw error
      const existing = await verifyReleaseDirectory(args.releaseRoot, sourceCommit)
      if (existing.manifestHash !== manifest.manifestHash) {
        throw new Error('immutable_release_directory_conflict')
      }
      await rm(tempRelease, { recursive: true, force: true })
      return existing
    }
    return manifest
  } catch (error) {
    await rm(tempRelease, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function assertSourceStillClean(
  repoRoot: string,
  expectedCommit: string,
): Promise<void> {
  const { stdout: commitStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
  })
  if (commitStdout.trim() !== expectedCommit) {
    throw new Error('release_source_changed_during_build')
  }
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: repoRoot, encoding: 'buffer' },
  )
  const dirtyBytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
  if (dirtyBytes.length !== 0) throw new Error('release_source_changed_during_build')
}

export async function verifyExecutionSidecarProtoFreshness(
  repoRoot: string,
  pythonOverride?: string,
): Promise<void> {
  const configuredPython = pythonOverride?.trim()
    || process.env.OPENALICE_NAUTILUS_PYTHON?.trim()
  const python = configuredPython || 'python3'
  try {
    await execFileAsync(
      python,
      [
        '-B',
        join(repoRoot, 'sidecars/nautilus_paper/generate_proto.py'),
        '--check',
      ],
      { cwd: repoRoot },
    )
  } catch {
    throw new Error('execution_sidecar_proto_freshness_check_failed')
  }
}

async function verifyFrozenLegacyWip(
  repoRoot: string,
  args: LocalReleaseCliArgs,
): Promise<void> {
  if (!args.legacyWipRoot && !args.freezeReceiptPath) return
  if (!args.legacyWipRoot || !args.freezeReceiptPath) {
    throw new Error('legacy_wip_freeze_inputs_required')
  }
  const { stdout } = await execFileAsync('python3', [
    join(repoRoot, 'scripts/verify_wip_freeze.py'),
    '--repo-root',
    resolve(args.legacyWipRoot),
    '--receipt',
    resolve(args.freezeReceiptPath),
  ], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  let verification: Record<string, unknown>
  try {
    verification = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw new Error('legacy_wip_freeze_verification_invalid')
  }
  if (verification.status !== 'pass' || verification.driftDetected === true) {
    throw new Error('legacy_wip_drift_detected')
  }
}

export async function copyReleaseTree(source: string, destination: string): Promise<void> {
  const stat = await lstat(source)
  if (stat.isSymbolicLink()) throw new Error(`release_artifact_symlink_forbidden:${source}`)
  if (stat.isFile()) {
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    return
  }
  if (!stat.isDirectory()) throw new Error(`release_artifact_type_forbidden:${source}`)
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source)) {
    if (REGENERABLE_RELEASE_CACHE_NAMES.has(entry)) continue
    await copyReleaseTree(join(source, entry), join(destination, entry))
  }
}

export async function copyHashBoundD1Evidence(
  source: string,
  destination: string,
  expectedSha256: string,
  label: string,
): Promise<void> {
  await copyReleaseTree(source, destination)
  if (await sha256File(destination) !== expectedSha256) {
    throw new Error(`d1_release_evidence_changed_during_copy:${label}`)
  }
}

export async function copyExecutionSidecarRuntimeTree(
  repoRoot: string,
  releaseRoot: string,
): Promise<void> {
  const sourceRoot = resolve(repoRoot)
  const destinationRoot = resolve(releaseRoot)
  for (const relativePath of EXECUTION_SIDECAR_RUNTIME_COPY_FILES) {
    const source = resolve(sourceRoot, relativePath)
    const destination = resolve(destinationRoot, relativePath)
    assertWithin(sourceRoot, source)
    assertWithin(destinationRoot, destination)
    await copyReleaseTree(source, destination)
  }
}

/** Remove group/world write permission without changing executable bits. */
export async function hardenD1ReleaseTree(path: string): Promise<void> {
  const status = await lstat(path)
  if (status.isSymbolicLink()) throw new Error(`release_artifact_symlink_forbidden:${path}`)
  if (status.isDirectory()) {
    for (const entry of await readdir(path)) {
      await hardenD1ReleaseTree(join(path, entry))
    }
  } else if (!status.isFile()) {
    throw new Error(`release_artifact_type_forbidden:${path}`)
  }
  await chmod(path, status.mode & ~0o022)
}

/**
 * pnpm's generated .bin wrappers embed the temporary deploy directory. That
 * path disappears when the release is atomically renamed, so materialize a
 * release-relative tsx launcher for Cron shell entrypoints. The target must
 * resolve inside the same immutable release tree.
 */
export async function prepareStableTsxLauncher(releaseRoot: string): Promise<string> {
  const root = await realpath(resolve(releaseRoot))
  const pnpmRoot = join(root, 'node_modules/.pnpm')
  const candidates: string[] = []
  for (const name of await readdir(pnpmRoot)) {
    if (!name.startsWith('tsx@')) continue
    const cli = join(pnpmRoot, name, 'node_modules/tsx/dist/cli.mjs')
    try {
      const resolvedCli = await realpath(cli)
      assertWithin(root, resolvedCli)
      candidates.push(name)
    } catch (error) {
      if (!isEnoent(error)) throw error
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`release_tsx_runtime_invalid:${candidates.sort().join('|') || 'missing'}`)
  }
  const binPath = join(root, 'node_modules/.bin/tsx')
  await mkdir(dirname(binPath), { recursive: true })
  const cliPath = join(pnpmRoot, candidates[0]!, 'node_modules/tsx/dist/cli.mjs')
  const relativeCli = relative(dirname(binPath), cliPath).replaceAll('\\', '/')
  const wrapper = `#!/bin/sh\nset -eu\nbasedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec /usr/bin/env node "$basedir/${relativeCli}" "$@"\n`
  await writeFile(binPath, wrapper, { encoding: 'utf8', mode: 0o755 })
  await chmod(binPath, 0o755)
  return relative(root, binPath).replaceAll('\\', '/')
}

export async function collectArtifactHashes(
  root: string,
  entries: string[],
): Promise<Record<string, string>> {
  const files = new Set<string>()
  for (const entry of entries) {
    const path = resolve(root, entry)
    assertWithin(root, path)
    await collectFiles(root, path, files)
  }
  const out: Record<string, string> = {}
  for (const path of [...files].sort()) {
    out[relative(root, path).replaceAll('\\', '/')] = await sha256File(path)
  }
  return out
}

/**
 * Inspect the actual temporary release tree before its hashes or manifest are
 * created.  This deliberately does not use the hash collector because that
 * collector skips regenerable caches; a cache injected by a deploy tool must
 * fail the D1 build rather than silently disappear from the attestation.
 */
export async function assertNoForbiddenD1ReleaseTree(root: string): Promise<void> {
  const resolvedRoot = await realpath(resolve(root))
  await walk(resolvedRoot)

  async function walk(current: string): Promise<void> {
    const status = await lstat(current)
    if (status.isSymbolicLink()) {
      throw new Error(`release_artifact_symlink_forbidden:${current}`)
    }
    if (!status.isDirectory()) {
      if (!status.isFile()) throw new Error(`release_artifact_type_forbidden:${current}`)
      assertAllowed(current)
      return
    }
    for (const entry of await readdir(current)) {
      await walk(resolve(current, entry))
    }
  }

  function assertAllowed(path: string): void {
    const relativePath = relative(resolvedRoot, path).replaceAll('\\', '/')
    const reason = d1ForbiddenReleasePath(relativePath)
    if (reason) throw new Error(`d1_release_forbidden_artifact:${relativePath}:${reason}`)
  }
}

/** Seal only the exact hash-bound closure plus the V2 manifest itself. */
export async function assertExactD1MaterializedReleaseTree(
  root: string,
  declaredPaths: Iterable<string>,
): Promise<void> {
  const resolvedRoot = await realpath(resolve(root))
  const declared = new Set(declaredPaths)
  await walk(resolvedRoot)

  async function walk(directory: string): Promise<boolean> {
    let hasDeclaredDescendant = false
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = resolve(directory, entry.name)
      const childRelative = relative(resolvedRoot, child).replaceAll('\\', '/')
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
    if (directory !== resolvedRoot && !hasDeclaredDescendant) {
      throw new Error(`d1_release_materialized_directory_not_declared:${relative(resolvedRoot, directory)}`)
    }
    return hasDeclaredDescendant
  }
}

async function collectFiles(root: string, path: string, files: Set<string>): Promise<void> {
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) throw new Error(`release_artifact_symlink_forbidden:${path}`)
  if (stat.isFile()) {
    files.add(path)
    return
  }
  if (!stat.isDirectory()) throw new Error(`release_artifact_type_forbidden:${path}`)
  for (const entry of await readdir(path)) {
    if (REGENERABLE_RELEASE_CACHE_NAMES.has(entry)) continue
    const child = resolve(path, entry)
    assertWithin(root, child)
    await collectFiles(root, child, files)
  }
}

async function loadSafeAdmissionDecisionId(path: string): Promise<string | null> {
  try {
    const decision = validateAdmissionDecision(JSON.parse(await readFile(path, 'utf8')))
    if (decision.liveExecutionArmed) {
      throw new Error('engineering_release_requires_live_execution_arm_false')
    }
    return decision.decisionId
  } catch (error) {
    if (isEnoent(error)) return null
    throw error
  }
}

function requiredReleaseId(value: string | undefined): string {
  if (!value || !COMMIT_RE.test(value)) throw new Error('valid --releaseId commit SHA required')
  return value
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false
  throw new Error(`invalid boolean: ${value}`)
}

function hasExactD1CheckIds(values: readonly string[]): boolean {
  if (values.length !== D1_RELEASE_CHECK_IDS.length) return false
  const actual = new Set(values)
  return actual.size === D1_RELEASE_CHECK_IDS.length
    && D1_RELEASE_CHECK_IDS.every((checkId) => actual.has(checkId))
}

function assertWithin(parent: string, child: string): void {
  const rel = relative(resolve(parent), resolve(child))
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) return
  throw new Error(`release_path_escape:${child}`)
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
