#!/usr/bin/env tsx

/** Guarded research-role cutover.
 *
 * The default command is a read-only preflight. `--execute true` is required
 * before launchd, jobs.json, or research pointers are changed, and execution
 * is refused unless a fresh 24-hour isolated canary receipt is supplied.
 */

import { chmod, copyFile, lstat, mkdir, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { activateResearchRelease, readReleasePointer, verifyReleaseDirectory } from '../src/runtime/release_manager.js'
import { sha256Canonical } from '../src/sidecar/contracts.js'

const execFileAsync = promisify(execFile)
const EMPTY_DIRTY_STATE_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

interface Args {
  releaseRoot: string
  releaseId: string
  legacyRepoRoot: string
  freezeReceipt: string
  canaryReceipt: string
  jobsPath: string
  registryPath: string
  launchdLabel: string
  launchdPlist: string
  launchWrapper: string
  backupDir: string
  receiptDir: string
  maxDowntimeSeconds: number
  execute: boolean
}

interface BackupEntry {
  source: string
  backup: string
  existed: boolean
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const preflight = await runPreflight(args)
  if (!args.execute) {
    console.log(JSON.stringify({ ...preflight, executionRequested: false }, null, 2))
    return
  }
  if (preflight.status !== 'pass') throw new Error('research_cutover_preflight_blocked')
  const startedAt = Date.now()
  const backups = await backupTargets(args)
  let researchActivated = false
  try {
    await assertWithinDowntime(startedAt, args.maxDowntimeSeconds)
    await bootoutLaunchd(args.launchdLabel)
    await waitForNoWriters([args.jobsPath, join(args.legacyRepoRoot, 'data/event-log/events.sqlite')])
    await normalizeCron(args)
    const activation = await activateResearchRelease({
      releaseRoot: args.releaseRoot,
      releaseId: args.releaseId,
      receiptDir: args.receiptDir,
    })
    if (activation.status !== 'pass') throw new Error(`research_activation_blocked:${activation.reasonCodes.join('|')}`)
    researchActivated = true
    await installResearchLaunchd(args)
    await assertWithinDowntime(startedAt, args.maxDowntimeSeconds)
    await verifyResearchLaunchd(args)
    const receipt = await writeReceipt(args, {
      status: 'pass',
      action: 'activate_research',
      releaseId: args.releaseId,
      backups,
      downtimeSeconds: (Date.now() - startedAt) / 1000,
      researchActivated,
    })
    console.log(JSON.stringify(receipt, null, 2))
  } catch (error) {
    const rollback = await rollbackCutover(args, backups).catch((rollbackError) => ({
      status: 'blocked',
      error: String(rollbackError),
    }))
    const receipt = await writeReceipt(args, {
      status: 'blocked',
      action: 'rollback_research',
      releaseId: args.releaseId,
      backups,
      downtimeSeconds: (Date.now() - startedAt) / 1000,
      researchActivated,
      error: error instanceof Error ? error.message : String(error),
      rollback,
    })
    console.error(JSON.stringify(receipt, null, 2))
    process.exitCode = 1
  }
}

async function runPreflight(args: Args): Promise<Record<string, unknown>> {
  const blockers: string[] = []
  const launchWrapper = resolve(args.launchWrapper)
  if (basename(launchWrapper) !== 'launch_openalice_current.sh') {
    blockers.push('launch_wrapper_must_be_stable_immutable_wrapper')
  }
  if (isWithin(resolve(args.legacyRepoRoot), launchWrapper)) {
    blockers.push('launch_wrapper_must_not_be_created_inside_legacy_wip')
  }
  let manifest: Awaited<ReturnType<typeof verifyReleaseDirectory>> | null = null
  try {
    manifest = await verifyReleaseDirectory(args.releaseRoot, args.releaseId)
    if (manifest.dirtyStateHash !== EMPTY_DIRTY_STATE_HASH) blockers.push('release_dirty_state_not_empty')
    if (manifest.liveExecutionArmed !== false) blockers.push('live_execution_armed')
    if (manifest.admissionDecisionId !== null) blockers.push('admission_decision_id_must_be_null')
    assertFullClosure(manifest.artifactHashes)
  } catch (error) {
    blockers.push(`release_invalid:${error instanceof Error ? error.message : String(error)}`)
  }
  const freeze = readJson(args.freezeReceipt)
  if (!freeze || freeze.schemaVersion !== 'dirty_wip_freeze.v1') blockers.push('freeze_receipt_missing_or_invalid')
  const canary = readJson(args.canaryReceipt)
  if (!canary || canary.schemaVersion !== 'canary_readiness_receipt.v1') {
    blockers.push('canary_receipt_missing_or_invalid')
  } else {
    if (canary.status !== 'pass' || canary.observations?.readiness !== 'pass') blockers.push('canary_not_pass')
    if (canary.releaseId !== args.releaseId) blockers.push('canary_release_mismatch')
    if (canary.runtimeRole !== 'canary') blockers.push('canary_runtime_role_mismatch')
    const duration = Number(canary.observationDurationSeconds ?? canary.durationSeconds ?? 0)
    if (!Number.isFinite(duration) || duration < 86_400) blockers.push('canary_observation_less_than_24h')
    const capabilities = canary.capabilities as Record<string, unknown> | undefined
    const observations = canary.observations as Record<string, unknown> | undefined
    if (!capabilities || Object.values(capabilities).some((value) => value !== false)
      || !observations
      || Number(observations.accountsInitialized ?? 0) !== 0
      || Number(observations.orderSubmissions ?? 0) !== 0
      || Number(observations.promotionWrites ?? 0) !== 0
      || Number(observations.sharedWrites ?? 0) !== 0
      || (Array.isArray(observations.cronOwners) && observations.cronOwners.length > 0)) {
      blockers.push('canary_capability_boundary_invalid')
    }
  }
  if (!await isRegularFile(args.jobsPath)) blockers.push('cron_jobs_missing_or_not_regular')
  const currentResearch = await readReleasePointer(args.releaseRoot, 'research-current').catch(() => null)
  const currentProduction = await readReleasePointer(args.releaseRoot, 'current').catch(() => null)
  return {
    schemaVersion: 'research_cutover_preflight.v1',
    generatedAt: new Date().toISOString(),
    status: blockers.length === 0 ? 'pass' : 'blocked',
    blockers,
    releaseId: args.releaseId,
    releaseManifestHash: manifest?.manifestHash ?? null,
    researchCurrent: currentResearch,
    productionCurrent: currentProduction,
    productionPointerWillRemainUntouched: true,
    stableLaunchWrapper: launchWrapper,
    credentialRotationRequired: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    liveExecutionArmed: false,
    executionRequested: args.execute,
  }
}

async function backupTargets(args: Args): Promise<BackupEntry[]> {
  const targets = [args.launchdPlist, args.launchWrapper, args.jobsPath]
  const entries: BackupEntry[] = []
  for (const source of targets) {
    const backup = join(resolve(args.backupDir), `${source.replaceAll('/', '_')}.bak`)
    let existed = false
    try {
      const info = await lstat(source)
      if (info.isSymbolicLink()) throw new Error(`backup_symlink_forbidden:${source}`)
      if (!info.isFile()) throw new Error(`backup_not_regular:${source}`)
      existed = true
      await mkdir(dirname(backup), { recursive: true })
      await copyFile(source, backup)
      await chmod0600(backup)
    } catch (error) {
      if (!isEnoent(error)) throw error
    }
    entries.push({ source, backup, existed })
  }
  return entries
}

async function normalizeCron(args: Args): Promise<void> {
  await execFileAsync('python3', [
    join(resolve(process.cwd()), 'scripts/normalize_cron_jobs.py'),
    '--jobs', args.jobsPath,
    '--source-root', args.legacyRepoRoot,
    '--release-root', join(resolve(args.releaseRoot), args.releaseId),
    '--registry', args.registryPath,
    '--backup', join(resolve(args.backupDir), 'jobs.json.pre-research.bak'),
    '--receipt', join(resolve(args.receiptDir), 'cron_jobs_normalization.receipt.json'),
  ], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 })
}

async function installResearchLaunchd(args: Args): Promise<void> {
  const env = {
    ...process.env,
    OPENALICE_RUNTIME_ROLE: 'research',
    OPENALICE_RELEASE_DIR: resolve(args.releaseRoot),
    OPENALICE_DATA_DIR: join(resolve(args.legacyRepoRoot), 'data'),
    OPENALICE_SHARED_DATA_INPUT_DIR: join(resolve(args.legacyRepoRoot), 'data'),
    OPENALICE_CONFIG_DIR: join(resolve(args.legacyRepoRoot), 'data/config'),
    OPENALICE_MARKET_INPUT_DIR: join(resolve(args.legacyRepoRoot), 'data/market'),
    OPENALICE_STATE_DIR: join(resolve(args.legacyRepoRoot), 'data'),
    OPENALICE_ARTIFACT_DIR: join(resolve(args.legacyRepoRoot), 'data/runtime'),
    OPENALICE_LOG_DIR: join(resolve(args.legacyRepoRoot), 'logs'),
    OPENALICE_LEGACY_WIP_ROOT: resolve(args.legacyRepoRoot),
  }
  await execFileAsync('./node_modules/.bin/tsx', [
    'scripts/install_openalice_launchd.ts',
    '--dryRun', 'false',
    '--launch', 'true',
    '--label', args.launchdLabel,
    '--plistPath', args.launchdPlist,
    '--scriptPath', args.launchWrapper,
    '--logPath', join(resolve(args.legacyRepoRoot), 'logs/openalice_main.launchd.log'),
    '--errorLogPath', join(resolve(args.legacyRepoRoot), 'logs/openalice_main.launchd.err.log'),
  ], { cwd: process.cwd(), env, maxBuffer: 4 * 1024 * 1024 })
}

async function verifyResearchLaunchd(args: Args): Promise<void> {
  const output = await execFileAsync('/bin/launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${args.launchdLabel}`], { maxBuffer: 2 * 1024 * 1024 })
  if (!/state\s*=\s*running|pid\s*=\s*\d+/i.test(output.stdout)) throw new Error('research_launchd_not_running')
  const pointer = await readReleasePointer(args.releaseRoot, 'research-current')
  if (pointer !== args.releaseId) throw new Error('research_pointer_verification_failed')
}

async function rollbackCutover(args: Args, backups: BackupEntry[]): Promise<Record<string, unknown>> {
  await bootoutLaunchd(args.launchdLabel).catch(() => undefined)
  for (const entry of backups) {
    if (!entry.existed) continue
    await copyFile(entry.backup, entry.source)
  }
  const oldPlist = backups.find((entry) => entry.source === args.launchdPlist && entry.existed)
  if (oldPlist) {
    await execFileAsync('/bin/launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, oldPlist.source]).catch(() => undefined)
    await execFileAsync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${args.launchdLabel}`]).catch(() => undefined)
  }
  return { status: 'pass', productionPointerUntouched: true }
}

async function bootoutLaunchd(label: string): Promise<void> {
  await execFileAsync('/bin/launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${label}`])
}

async function waitForNoWriters(paths: string[]): Promise<void> {
  for (const path of paths) {
    if (!await isRegularFile(path)) continue
    try {
      const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-t', '--', path], { maxBuffer: 100_000 })
      if (stdout.trim()) throw new Error(`active_writer:${path}:${stdout.trim().replaceAll('\n', ',')}`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('active_writer:')) throw error
      if (!isCommandExitOne(error)) throw error
    }
  }
}

async function assertWithinDowntime(startedAt: number, maxSeconds: number): Promise<void> {
  if ((Date.now() - startedAt) / 1000 > maxSeconds) throw new Error('research_cutover_downtime_budget_exceeded')
}

async function writeReceipt(args: Args, value: Record<string, unknown>): Promise<Record<string, unknown>> {
  const receipt = {
    schemaVersion: 'research_cutover_receipt.v1',
    receiptId: sha256Canonical(value),
    generatedAt: new Date().toISOString(),
    ...value,
  }
  const path = join(resolve(args.receiptDir), `${receipt.generatedAt.replaceAll(':', '-')}.${receipt.receiptId}.json`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  return { ...receipt, receiptPath: path }
}

function assertFullClosure(hashes: Record<string, string>): void {
  for (const prefix of ['dist/', 'scripts/', 'src/', 'ops/', 'default/', 'package.json', 'release-metadata/']) {
    if (!Object.keys(hashes).some((path) => path === prefix || path.startsWith(prefix))) {
      throw new Error(`research_release_closure_missing:${prefix}`)
    }
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(resolve(path), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function chmod0600(path: string): Promise<void> {
  await chmod(path, 0o600)
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isCommandExitOne(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 1)
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing_value:${token}`)
    values.set(token.slice(2), value)
    index += 1
  }
  const required = (key: string): string => {
    const value = values.get(key)
    if (!value) throw new Error(`missing --${key}`)
    return value
  }
  return {
    releaseRoot: required('releaseRoot'),
    releaseId: required('releaseId'),
    legacyRepoRoot: required('legacyRepoRoot'),
    freezeReceipt: required('freezeReceipt'),
    canaryReceipt: required('canaryReceipt'),
    jobsPath: required('jobsPath'),
    registryPath: required('registryPath'),
    launchdLabel: required('launchdLabel'),
    launchdPlist: required('launchdPlist'),
    launchWrapper: required('launchWrapper'),
    backupDir: required('backupDir'),
    receiptDir: required('receiptDir'),
    maxDowntimeSeconds: Number(values.get('maxDowntimeSeconds') ?? '300'),
    execute: ['1', 'true', 'yes'].includes((values.get('execute') ?? 'false').toLowerCase()),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
