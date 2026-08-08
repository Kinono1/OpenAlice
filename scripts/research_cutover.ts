#!/usr/bin/env tsx

/** Guarded research-role cutover.
 *
 * The default command is a read-only preflight. `--execute true` is required
 * before launchd, jobs.json, or research pointers are changed, and execution
 * is refused unless a fresh 24-hour isolated canary receipt is supplied.
 */

import { chmod, copyFile, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { assertCanaryReady, type CanaryReadinessReceiptV1 } from '../src/runtime/canary_governance.js'
import { activateResearchRelease, readReleasePointer, sha256File, verifyReleaseDirectory } from '../src/runtime/release_manager.js'
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
  let postSwitchVerification: Record<string, unknown> | null = null
  try {
    await assertWithinDowntime(startedAt, args.maxDowntimeSeconds)
    await bootoutLaunchd(args.launchdLabel)
    const eventDbPath = join(args.legacyRepoRoot, 'data/event-log/events.sqlite')
    await waitForNoWriters([
      args.jobsPath,
      eventDbPath,
      `${eventDbPath}-wal`,
      `${eventDbPath}-shm`,
    ])
    await assertNoCronLocks(join(args.legacyRepoRoot, 'data/runtime/locks'))
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
    postSwitchVerification = await verifyResearchLaunchd(args)
    const receipt = await writeReceipt(args, {
      status: 'pass',
      action: 'activate_research',
      releaseId: args.releaseId,
      backups,
      downtimeSeconds: (Date.now() - startedAt) / 1000,
      researchActivated,
      postSwitchVerification,
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
      postSwitchVerification,
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
    // The first cutover may not have a stable wrapper yet; the installer
    // materializes it from this same release before launch.  If a wrapper is
    // already present, validate it during preflight; the post-materialization
    // verification below is mandatory for both first install and reuse.
    if (await pathExists(launchWrapper)) {
      blockers.push(...await verifyStableLaunchWrapper(launchWrapper, manifest.artifactHashes))
    }
  } catch (error) {
    blockers.push(`release_invalid:${error instanceof Error ? error.message : String(error)}`)
  }
  const freeze = readJson(args.freezeReceipt)
  let legacyWipVerification: Record<string, unknown> | null = null
  if (!freeze || freeze.schemaVersion !== 'dirty_wip_freeze.v1') {
    blockers.push('freeze_receipt_missing_or_invalid')
  } else {
    legacyWipVerification = await verifyFrozenWip(args.legacyRepoRoot, args.freezeReceipt)
    if (legacyWipVerification.status !== 'pass' || legacyWipVerification.driftDetected === true) {
      blockers.push('legacy_wip_drift_detected')
    }
  }
  let canary: CanaryReadinessReceiptV1 | null = null
  const canaryRaw = readJson(args.canaryReceipt)
  if (!canaryRaw || canaryRaw.schemaVersion !== 'canary_readiness_receipt.v1') {
    blockers.push('canary_receipt_missing_or_invalid')
  } else {
    try {
      // Production cutover accepts only a hash-validated, unexpired production
      // canary receipt.  A preparation receipt or an isolated-test receipt is
      // deliberately insufficient, even when it names the same release.
      canary = assertCanaryReady(canaryRaw, 'production_canary')
      if (canary.releaseId !== args.releaseId) blockers.push('canary_release_mismatch')
      if (manifest && canary.manifestHash !== manifest.manifestHash) {
        blockers.push('canary_manifest_hash_mismatch')
      }
      if (canary.runtimeRole !== 'canary') blockers.push('canary_runtime_role_mismatch')
      const duration = canary.observationDurationSeconds ?? 0
      if (!Number.isInteger(duration) || duration < 86_400) blockers.push('canary_observation_less_than_24h')
      const capabilities = canary.capabilities
      const observations = canary.observations
      if (canary.pathIsolation !== 'pass'
        || Object.values(capabilities).some((value) => value !== false)
        || observations.readiness !== 'pass'
        || observations.accountsInitialized !== 0
        || observations.orderSubmissions !== 0
        || observations.promotionWrites !== 0
        || observations.sharedWrites !== 0
        || observations.cronOwners.length > 0) {
        blockers.push('canary_capability_boundary_invalid')
      }
    } catch (error) {
      blockers.push(`canary_not_pass:${error instanceof Error ? error.message : String(error)}`)
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
    canaryReceiptId: canary?.receiptId ?? null,
    canaryManifestHash: canary?.manifestHash ?? null,
    canaryExpiresAt: canary?.expiresAt ?? null,
    canaryObservationDurationSeconds: canary?.observationDurationSeconds ?? null,
    legacyWipVerification,
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

async function verifyStableLaunchWrapper(
  launchWrapper: string,
  artifactHashes: Record<string, string>,
): Promise<string[]> {
  const targets = [
    { path: launchWrapper, artifact: 'ops/release/launch_current.sh', label: 'launch_wrapper' },
    { path: join(dirname(launchWrapper), 'launch_current.mjs'), artifact: 'ops/release/launch_current.mjs', label: 'launch_module' },
    { path: join(dirname(launchWrapper), 'openalice_env.sh'), artifact: 'scripts/openalice_env.sh', label: 'launch_env' },
  ]
  const blockers: string[] = []
  for (const target of targets) {
    const expectedHash = artifactHashes[target.artifact]
    if (!expectedHash) {
      blockers.push(`${target.label}_hash_missing_from_release`)
      continue
    }
    try {
      const info = await lstat(resolve(target.path))
      if (info.isSymbolicLink()) {
        blockers.push(`${target.label}_symlink_forbidden`)
        continue
      }
      if (!info.isFile()) {
        blockers.push(`${target.label}_not_regular_file`)
        continue
      }
      const actualHash = await sha256File(resolve(target.path))
      if (actualHash !== expectedHash) blockers.push(`${target.label}_hash_mismatch`)
    } catch (error) {
      if (isEnoent(error)) blockers.push(`${target.label}_missing`)
      else blockers.push(`${target.label}_unreadable`)
    }
  }
  return blockers
}

async function verifyFrozenWip(
  legacyRepoRoot: string,
  freezeReceipt: string,
): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await execFileAsync('python3', [
      join(resolve(process.cwd()), 'scripts/verify_wip_freeze.py'),
      '--repo-root',
      resolve(legacyRepoRoot),
      '--receipt',
      resolve(freezeReceipt),
    ], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    return JSON.parse(stdout) as Record<string, unknown>
  } catch (error) {
    const stdout = typeof error === 'object' && error !== null && 'stdout' in error
      ? (error as { stdout?: unknown }).stdout
      : null
    if (typeof stdout === 'string' && stdout.trim()) {
      try {
        return JSON.parse(stdout) as Record<string, unknown>
      } catch {
        // Fall through to an explicit blocked verification record.
      }
    }
    return {
      schemaVersion: 'dirty_wip_freeze_verification.v1',
      status: 'blocked',
      repoRoot: resolve(legacyRepoRoot),
      receipt: resolve(freezeReceipt),
      mismatches: [error instanceof Error ? error.message : String(error)],
      driftDetected: true,
    }
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
    OPENALICE_RESEARCH_WEB_PORT: process.env.OPENALICE_RESEARCH_WEB_PORT ?? '3002',
    OPENALICE_RESEARCH_MCP_PORT: process.env.OPENALICE_RESEARCH_MCP_PORT ?? '3001',
  }
  await execFileAsync('./node_modules/.bin/tsx', [
    'scripts/install_openalice_launchd.ts',
    '--dryRun', 'false',
    '--launch', 'false',
    '--label', args.launchdLabel,
    '--plistPath', args.launchdPlist,
    '--scriptPath', args.launchWrapper,
    '--workingDirectory', join(resolve(args.releaseRoot), args.releaseId),
    '--sourceReleasePath', join(resolve(args.releaseRoot), args.releaseId),
    '--logPath', join(resolve(args.legacyRepoRoot), 'logs/openalice_main.launchd.log'),
    '--errorLogPath', join(resolve(args.legacyRepoRoot), 'logs/openalice_main.launchd.err.log'),
  ], { cwd: process.cwd(), env, maxBuffer: 4 * 1024 * 1024 })
  const manifest = await verifyReleaseDirectory(args.releaseRoot, args.releaseId)
  const wrapperBlockers = await verifyStableLaunchWrapper(args.launchWrapper, manifest.artifactHashes)
  if (wrapperBlockers.length > 0) {
    throw new Error(`research_launch_wrapper_invalid:${wrapperBlockers.join('|')}`)
  }
  const uid = String(process.getuid?.() ?? 501)
  await execFileAsync('/bin/launchctl', ['bootstrap', `gui/${uid}`, resolve(args.launchdPlist)])
  await execFileAsync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${args.launchdLabel}`])
}

async function verifyResearchLaunchd(args: Args): Promise<Record<string, unknown>> {
  const output = await execFileAsync('/bin/launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${args.launchdLabel}`], { maxBuffer: 2 * 1024 * 1024 })
  const launchdText = String(output.stdout)
  if (!/state\s*=\s*running|pid\s*=\s*\d+/i.test(launchdText)) throw new Error('research_launchd_not_running')
  if (!/OPENALICE_RUNTIME_ROLE\s*=>\s*research\b/.test(launchdText)) {
    throw new Error('research_launchd_role_not_research')
  }
  if (!/OPENALICE_RELEASE_DIR\s*=>\s*\S+/.test(launchdText)) {
    throw new Error('research_launchd_release_dir_missing')
  }
  const pointer = await readReleasePointer(args.releaseRoot, 'research-current')
  if (pointer !== args.releaseId) throw new Error('research_pointer_verification_failed')
  const expectedReleasePath = resolve(args.releaseRoot, args.releaseId)
  const workingDirectoryLine = launchdText
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith('working directory ='))
  if (workingDirectoryLine?.trim() !== `working directory = ${expectedReleasePath}`) {
    throw new Error('research_launchd_working_directory_invalid')
  }
  const manifest = await verifyReleaseDirectory(args.releaseRoot, args.releaseId)
  const wrapperBlockers = await verifyStableLaunchWrapper(args.launchWrapper, manifest.artifactHashes)
  if (wrapperBlockers.length > 0) {
    throw new Error(`research_launch_wrapper_invalid:${wrapperBlockers.join('|')}`)
  }

  const webPort = Number(process.env.OPENALICE_RESEARCH_WEB_PORT ?? '3002')
  if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) {
    throw new Error('research_web_port_invalid')
  }
  const webPids = await listListeningPids(webPort)
  if (webPids.length !== 1) throw new Error(`research_web_listener_count_invalid:${webPids.length}`)
  const mainPid = webPids[0]
  const mainCwd = await readProcessCwd(mainPid)
  if (mainCwd !== expectedReleasePath) throw new Error(`research_process_cwd_invalid:${mainCwd}`)
  const mainCommand = await readProcessCommand(mainPid)
  if (!mainCommand.includes(`${expectedReleasePath}/dist/main.js`)) {
    throw new Error('research_process_not_immutable_release')
  }
  const healthHttp = await probeHealth(webPort)
  if (healthHttp !== 200) throw new Error(`research_health_not_ready:${healthHttp}`)

  const mcpPort = Number(process.env.OPENALICE_RESEARCH_MCP_PORT ?? '3001')
  const mcpPids = Number.isInteger(mcpPort) && mcpPort >= 1024 && mcpPort <= 65535
    ? await listListeningPids(mcpPort)
    : []
  if (mcpPids.length > 0) throw new Error(`research_mcp_listener_present:${mcpPids.join(',')}`)

  const jobsWriterPids = await listFileWriters(args.jobsPath)
  if (jobsWriterPids.length > 1) throw new Error(`research_cron_writer_count_invalid:${jobsWriterPids.length}`)
  return {
    launchdState: 'running',
    launchdRole: 'research',
    launchdReleaseDirPresent: true,
    researchPointer: pointer,
    mainPid,
    mainCwd,
    mainCommand,
    webPort,
    webListenerPids: webPids,
    healthHttp,
    mcpPort,
    mcpListenerPids: mcpPids,
    cronJobsPath: args.jobsPath,
    cronWriterPids: jobsWriterPids,
    uniqueCronOwner: jobsWriterPids.length <= 1,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    liveExecutionArmed: false,
    productionPointerUntouched: true,
  }
}

async function listListeningPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', [
      '-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN',
    ], { encoding: 'utf8', maxBuffer: 100_000 })
    return [...new Set(String(stdout).split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger))].sort((a, b) => a - b)
  } catch (error) {
    if (isCommandExitOne(error)) return []
    throw error
  }
}

async function listFileWriters(path: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-nP', '-t', '--', resolve(path)], {
      encoding: 'utf8',
      maxBuffer: 100_000,
    })
    return [...new Set(String(stdout).split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger))].sort((a, b) => a - b)
  } catch (error) {
    if (isCommandExitOne(error)) return []
    throw error
  }
}

async function readProcessCwd(pid: number): Promise<string> {
  const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
    maxBuffer: 100_000,
  })
  const cwd = String(stdout).split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1)
  if (!cwd) throw new Error(`research_process_cwd_missing:${pid}`)
  return cwd
}

async function readProcessCommand(pid: number): Promise<string> {
  const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    maxBuffer: 100_000,
  })
  const command = String(stdout).trim()
  if (!command) throw new Error(`research_process_command_missing:${pid}`)
  return command
}

async function probeHealth(port: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/curl', [
      '--noproxy', '*', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5',
      `http://127.0.0.1:${port}/api/health`,
    ], { encoding: 'utf8', maxBuffer: 10_000 })
    return Number(String(stdout).trim())
  } catch {
    return 0
  }
}

async function rollbackCutover(args: Args, backups: BackupEntry[]): Promise<Record<string, unknown>> {
  await bootoutLaunchd(args.launchdLabel).catch(() => undefined)
  for (const entry of backups) {
    if (entry.existed) {
      await copyFile(entry.backup, entry.source)
    } else {
      await rm(entry.source, { force: true })
    }
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

async function assertNoCronLocks(lockRoot: string): Promise<void> {
  try {
    const entries = await readdir(resolve(lockRoot), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`cron_lock_symlink_forbidden:${entry.name}`)
      if (entry.isDirectory() || entry.isFile()) {
        throw new Error(`active_cron_lock:${join(resolve(lockRoot), entry.name)}`)
      }
    }
  } catch (error) {
    if (isEnoent(error)) return
    throw error
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
  for (const prefix of ['dist/', 'scripts/', 'src/', 'ops/', 'default/', 'package.json', 'pnpm-lock.yaml', 'release-metadata/']) {
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(resolve(path))
    return true
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
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
