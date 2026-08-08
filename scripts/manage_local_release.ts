#!/usr/bin/env tsx

import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { validateAdmissionDecision } from '../src/runtime/admission.js'
import { buildReleaseManifest } from '../src/runtime/release_manifest.js'
import {
  activateRelease,
  activateResearchRelease,
  loadValidationReceiptBinding,
  readReleasePointer,
  rollbackRelease,
  rollbackResearchRelease,
  sha256File,
  verifyReleaseDirectory,
  writeImmutableReleaseManifest,
} from '../src/runtime/release_manager.js'

const execFileAsync = promisify(execFile)
const COMMIT_RE = /^[a-f0-9]{40}$/

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
    runtimeEntry: get('runtimeEntry') ?? 'dist/main.js',
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

  if (!args.skipBuild) {
    await execFileAsync('pnpm', ['build'], { cwd: repoRoot })
  }
  const runtimeEntryPath = resolve(repoRoot, args.runtimeEntry)
  assertWithin(repoRoot, runtimeEntryPath)
  await lstat(runtimeEntryPath)
  const runtimeEntryRelative = relative(repoRoot, runtimeEntryPath)
  const runtimeArtifactRoot = runtimeEntryRelative.split(/[\\/]/)[0]
  if (!runtimeArtifactRoot) throw new Error('runtime_entry_root_missing')

  const builtAt = new Date()
  const receiptPaths = args.receiptPaths.length > 0
    ? args.receiptPaths
    : await discoverReceiptPaths(resolve(repoRoot, 'runtime/control-plane/receipts'))
  const validationReceipts = await Promise.all(receiptPaths.map((path) => (
    loadValidationReceiptBinding({
      path,
      sourceCommit,
      dirtyStateHash,
      now: builtAt,
    })
  )))
  if (validationReceipts.length === 0) {
    throw new Error('engineering_release_receipts_missing')
  }
  const checkIds = new Set(validationReceipts.map((receipt) => receipt.checkId))
  for (const checkId of args.requiredChecks) {
    if (!checkIds.has(checkId)) throw new Error(`required_release_receipt_missing:${checkId}`)
  }

  const admissionDecisionId = await loadSafeAdmissionDecisionId(
    args.admissionDecisionPath,
  )
  const tempRelease = resolve(
    args.releaseRoot,
    `.${sourceCommit}.${randomUUID()}.tmp`,
  )
  const finalRelease = resolve(args.releaseRoot, sourceCommit)
  await mkdir(args.releaseRoot, { recursive: true })
  try {
    await execFileAsync(
      'pnpm',
      ['--filter', 'open-alice', 'deploy', '--prod', '--legacy', tempRelease],
      { cwd: repoRoot },
    )
    await copyReleaseTree(
      resolve(repoRoot, runtimeArtifactRoot),
      resolve(tempRelease, runtimeArtifactRoot),
    )
    // The launcher executes scripts and resolves evidence/runtime contracts
    // from the immutable release.  Copy and hash the complete executable
    // closure instead of relying on the deploy bundle's dist-only payload.
    for (const entry of ['scripts', 'src', 'ops', 'default']) {
      await copyReleaseTree(resolve(repoRoot, entry), resolve(tempRelease, entry))
    }
    await copyFile(resolve(repoRoot, 'package.json'), join(tempRelease, 'package.json'))
    await copyFile(resolve(repoRoot, 'pnpm-lock.yaml'), join(tempRelease, 'pnpm-lock.yaml'))
    await mkdir(join(tempRelease, 'release-metadata'), { recursive: true })
    await copyFile(args.pipelineRegistryPath, join(tempRelease, 'release-metadata/pipeline_registry.v1.json'))
    await copyFile(args.dependencyLockPath, join(tempRelease, 'release-metadata/pnpm-lock.yaml'))
    await copyFile(args.strategyConfigPath, join(tempRelease, 'release-metadata/strategy_release_config.v1.json'))

    const artifactHashes = await collectArtifactHashes(tempRelease, [
      args.runtimeEntry,
      runtimeArtifactRoot,
      'scripts',
      'src',
      'ops',
      'default',
      'package.json',
      'pnpm-lock.yaml',
      'release-metadata',
    ])
    const manifest = buildReleaseManifest({
      releaseId: sourceCommit,
      sourceCommit,
      dirtyStateHash,
      builtAt: builtAt.toISOString(),
      runtimeEntry: args.runtimeEntry,
      artifactHashes,
      pipelineRegistryHash: await sha256File(args.pipelineRegistryPath),
      dependencyLockHash: await sha256File(args.dependencyLockPath),
      strategyConfigHash: await sha256File(args.strategyConfigPath),
      validationReceipts,
      admissionDecisionId,
      engineeringChecks: [...checkIds].sort(),
      liveExecutionArmed: false,
    })
    await writeImmutableReleaseManifest(tempRelease, manifest)
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
    await copyReleaseTree(join(source, entry), join(destination, entry))
  }
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

async function collectFiles(root: string, path: string, files: Set<string>): Promise<void> {
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) throw new Error(`release_artifact_symlink_forbidden:${path}`)
  if (stat.isFile()) {
    files.add(path)
    return
  }
  if (!stat.isDirectory()) throw new Error(`release_artifact_type_forbidden:${path}`)
  for (const entry of await readdir(path)) {
    const child = resolve(path, entry)
    assertWithin(root, child)
    await collectFiles(root, child, files)
  }
}

async function discoverReceiptPaths(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((name) => name.endsWith('.validation_receipt.v1.json'))
      .map((name) => join(dir, name))
      .sort()
  } catch (error) {
    if (isEnoent(error)) return []
    throw error
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
