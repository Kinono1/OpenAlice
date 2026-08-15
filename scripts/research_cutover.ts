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
import {
  assertNoForbiddenD1ReleaseArtifactPaths,
  D1_RELEASE_REQUIRED_ARTIFACT_PATHS,
  type ReleaseManifest,
} from '../src/runtime/release_manifest.js'
import { sha256Canonical } from '../src/sidecar/contracts.js'

const execFileAsync = promisify(execFile)
const EMPTY_DIRTY_STATE_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
export const PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_BLOCKER =
  'paper_local_two_identity_deployment_required' as const

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
  paperLocalSupervisorConfig?: string
  paperLocalNode?: string
  paperLocalNodeSha256?: string
  paperLocalMjsSha256?: string
  paperLocalPython?: string
  paperLocalPublisherUid?: string
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

interface CutoverBudget {
  startedAt: number
  maxDowntimeSeconds: number
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
  const budget: CutoverBudget = { startedAt, maxDowntimeSeconds: args.maxDowntimeSeconds }
  const backups = await backupTargets(args)
  let researchActivated = false
  let postSwitchVerification: Record<string, unknown> | null = null
  try {
    await assertWithinDowntime(startedAt, args.maxDowntimeSeconds)
    await bootoutLaunchd(args.launchdLabel, budget)
    const eventDbPath = join(args.legacyRepoRoot, 'data/event-log/events.sqlite')
    await waitForNoWriters([
      args.jobsPath,
      eventDbPath,
      `${eventDbPath}-wal`,
      `${eventDbPath}-shm`,
    ], budget)
    await assertNoCronLocks(join(args.legacyRepoRoot, 'data/runtime/locks'), budget)
    await normalizeCron(args, budget)
    await assertWithinDowntime(startedAt, args.maxDowntimeSeconds)
    const activation = await activateResearchRelease({
      releaseRoot: args.releaseRoot,
      releaseId: args.releaseId,
      receiptDir: args.receiptDir,
    })
    if (activation.status !== 'pass') throw new Error(`research_activation_blocked:${activation.reasonCodes.join('|')}`)
    researchActivated = true
    await assertWithinDowntime(startedAt, args.maxDowntimeSeconds)
    await installResearchLaunchd(args, budget)
    await assertWithinDowntime(startedAt, args.maxDowntimeSeconds)
    postSwitchVerification = await verifyResearchLaunchd(args, budget)
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
  if (isWithin(resolve(args.legacyRepoRoot), launchWrapper)) {
    blockers.push('launch_wrapper_must_not_be_created_inside_legacy_wip')
  }
  let manifest: Awaited<ReturnType<typeof verifyReleaseDirectory>> | null = null
  try {
    manifest = await verifyReleaseDirectory(args.releaseRoot, args.releaseId)
    if (manifest.dirtyStateHash !== EMPTY_DIRTY_STATE_HASH) blockers.push('release_dirty_state_not_empty')
    if (manifest.liveExecutionArmed !== false) blockers.push('live_execution_armed')
    if (manifest.admissionDecisionId !== null) blockers.push('admission_decision_id_must_be_null')
    const expectedWrapper = manifest.schemaVersion === 'release_manifest.v2'
      ? 'launch_nautilus_paper.sh'
      : 'launch_openalice_current.sh'
    if (basename(launchWrapper) !== expectedWrapper) {
      blockers.push(`launch_wrapper_must_be_${expectedWrapper}`)
    }
    if (
      manifest.schemaVersion === 'release_manifest.v2'
      && (!args.paperLocalSupervisorConfig || !args.paperLocalSupervisorConfig.startsWith('/'))
    ) {
      blockers.push('paper_local_supervisor_config_missing_or_not_absolute')
    }
    if (manifest.schemaVersion === 'release_manifest.v2') {
      blockers.push(...validatePaperLocalLaunchInputs(args))
      blockers.push(...paperLocalTwoIdentityDeploymentBlockers(manifest))
    }
    assertCutoverReleaseClosure(manifest)
    // The first cutover may not have a stable wrapper yet; the installer
    // materializes it from this same release before launch.  If a wrapper is
    // already present, validate it during preflight; the post-materialization
    // verification below is mandatory for both first install and reuse.
    if (await pathExists(launchWrapper)) {
      blockers.push(...await verifyStableLaunchWrapper(launchWrapper, manifest))
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
  manifest: Awaited<ReturnType<typeof verifyReleaseDirectory>>,
): Promise<string[]> {
  const targets = manifest.schemaVersion === 'release_manifest.v2'
    ? [
      { path: launchWrapper, artifact: 'ops/release/launch_nautilus_paper.sh', label: 'paper_local_launch_wrapper' },
      { path: join(dirname(launchWrapper), 'launch_nautilus_paper.mjs'), artifact: 'ops/release/launch_nautilus_paper.mjs', label: 'paper_local_launch_module' },
    ]
    : [
      { path: launchWrapper, artifact: 'ops/release/launch_current.sh', label: 'launch_wrapper' },
      { path: join(dirname(launchWrapper), 'launch_current.mjs'), artifact: 'ops/release/launch_current.mjs', label: 'launch_module' },
      { path: join(dirname(launchWrapper), 'openalice_env.sh'), artifact: 'scripts/openalice_env.sh', label: 'launch_env' },
    ]
  const blockers: string[] = []
  for (const target of targets) {
    const expectedHash = manifest.artifactHashes[target.artifact]
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
  const wrapperSiblings = basename(args.launchWrapper) === 'launch_nautilus_paper.sh'
    ? [join(dirname(resolve(args.launchWrapper)), 'launch_nautilus_paper.mjs')]
    : [
      join(dirname(resolve(args.launchWrapper)), 'launch_current.mjs'),
      join(dirname(resolve(args.launchWrapper)), 'openalice_env.sh'),
    ]
  const targets = [
    args.launchdPlist,
    args.launchWrapper,
    ...wrapperSiblings,
    args.jobsPath,
  ]
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

async function normalizeCron(args: Args, budget: CutoverBudget): Promise<void> {
  await runCutoverCommand(budget, 'python3', [
    join(resolve(process.cwd()), 'scripts/normalize_cron_jobs.py'),
    '--jobs', args.jobsPath,
    '--source-root', args.legacyRepoRoot,
    '--release-root', join(resolve(args.releaseRoot), args.releaseId),
    '--registry', args.registryPath,
    '--backup', join(resolve(args.backupDir), 'jobs.json.pre-research.bak'),
    '--receipt', join(resolve(args.receiptDir), 'cron_jobs_normalization.receipt.json'),
  ], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 })
}

async function installResearchLaunchd(args: Args, budget: CutoverBudget): Promise<void> {
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
    ...(args.paperLocalSupervisorConfig
      ? { OPENALICE_PAPER_LOCAL_SUPERVISOR_CONFIG: args.paperLocalSupervisorConfig }
      : {}),
    ...(args.paperLocalNode ? { OPENALICE_NODE: args.paperLocalNode } : {}),
    ...(args.paperLocalNodeSha256 ? { OPENALICE_NODE_SHA256: args.paperLocalNodeSha256 } : {}),
    ...(args.paperLocalMjsSha256
      ? { OPENALICE_PAPER_LOCAL_MJS_SHA256: args.paperLocalMjsSha256 }
      : {}),
    ...(args.paperLocalPython ? { OPENALICE_NAUTILUS_PYTHON: args.paperLocalPython } : {}),
    ...(args.paperLocalPublisherUid
      ? { OPENALICE_RELEASE_PUBLISHER_UID: args.paperLocalPublisherUid }
      : {}),
  }
  await runCutoverCommand(budget, './node_modules/.bin/tsx', [
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
  const wrapperBlockers = await verifyStableLaunchWrapper(args.launchWrapper, manifest)
  if (wrapperBlockers.length > 0) {
    throw new Error(`research_launch_wrapper_invalid:${wrapperBlockers.join('|')}`)
  }
  const uid = String(process.getuid?.() ?? 501)
  await runCutoverCommand(budget, '/bin/launchctl', ['bootstrap', `gui/${uid}`, resolve(args.launchdPlist)])
  await runCutoverCommand(budget, '/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${args.launchdLabel}`])
}

async function verifyResearchLaunchd(args: Args, budget: CutoverBudget): Promise<Record<string, unknown>> {
  const output = await runCutoverCommand(budget, '/bin/launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${args.launchdLabel}`], { maxBuffer: 2 * 1024 * 1024 })
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
  const wrapperBlockers = await verifyStableLaunchWrapper(args.launchWrapper, manifest)
  if (wrapperBlockers.length > 0) {
    throw new Error(`research_launch_wrapper_invalid:${wrapperBlockers.join('|')}`)
  }

  const webPort = Number(process.env.OPENALICE_RESEARCH_WEB_PORT ?? '3002')
  if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) {
    throw new Error('research_web_port_invalid')
  }
  const webPids = await listListeningPids(webPort, budget)
  if (webPids.length !== 1) throw new Error(`research_web_listener_count_invalid:${webPids.length}`)
  const mainPid = webPids[0]
  const mainCwd = await readProcessCwd(mainPid, budget)
  if (mainCwd !== expectedReleasePath) throw new Error(`research_process_cwd_invalid:${mainCwd}`)
  const mainCommand = await readProcessCommand(mainPid, budget)
  if (!mainCommand.includes(`${expectedReleasePath}/dist/main.js`)) {
    throw new Error('research_process_not_immutable_release')
  }
  const healthHttp = await probeHealth(webPort, budget)
  if (healthHttp !== 200) throw new Error(`research_health_not_ready:${healthHttp}`)

  const mcpPort = Number(process.env.OPENALICE_RESEARCH_MCP_PORT ?? '3001')
  const mcpPids = Number.isInteger(mcpPort) && mcpPort >= 1024 && mcpPort <= 65535
    ? await listListeningPids(mcpPort, budget)
    : []
  if (mcpPids.length > 0) throw new Error(`research_mcp_listener_present:${mcpPids.join(',')}`)

  const jobsWriterPids = await listFileWriters(args.jobsPath, budget)
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

async function listListeningPids(port: number, budget?: CutoverBudget): Promise<number[]> {
  try {
    const { stdout } = await runCommand(budget, '/usr/sbin/lsof', [
      '-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN',
    ], { encoding: 'utf8', maxBuffer: 100_000 })
    return [...new Set(String(stdout).split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger))].sort((a, b) => a - b)
  } catch (error) {
    if (isCommandExitOne(error)) return []
    throw error
  }
}

async function listFileWriters(path: string, budget?: CutoverBudget): Promise<number[]> {
  try {
    const { stdout } = await runCommand(budget, '/usr/sbin/lsof', ['-nP', '-t', '--', resolve(path)], {
      encoding: 'utf8',
      maxBuffer: 100_000,
    })
    return [...new Set(String(stdout).split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger))].sort((a, b) => a - b)
  } catch (error) {
    if (isCommandExitOne(error)) return []
    throw error
  }
}

async function readProcessCwd(pid: number, budget?: CutoverBudget): Promise<string> {
  const { stdout } = await runCommand(budget, '/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
    maxBuffer: 100_000,
  })
  const cwd = String(stdout).split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1)
  if (!cwd) throw new Error(`research_process_cwd_missing:${pid}`)
  return cwd
}

async function readProcessCommand(pid: number, budget?: CutoverBudget): Promise<string> {
  const { stdout } = await runCommand(budget, '/bin/ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    maxBuffer: 100_000,
  })
  const command = String(stdout).trim()
  if (!command) throw new Error(`research_process_command_missing:${pid}`)
  return command
}

async function probeHealth(port: number, budget?: CutoverBudget): Promise<number> {
  try {
    const { stdout } = await runCommand(budget, '/usr/bin/curl', [
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

async function bootoutLaunchd(label: string, budget?: CutoverBudget): Promise<void> {
  await runCommand(budget, '/bin/launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${label}`])
}

async function waitForNoWriters(paths: string[], budget?: CutoverBudget): Promise<void> {
  const existingPaths = []
  for (const path of paths) {
    if (await isRegularFile(path)) existingPaths.push(path)
  }
  while (true) {
    if (budget) await assertWithinDowntime(budget.startedAt, budget.maxDowntimeSeconds)
    const active: string[] = []
    for (const path of existingPaths) {
      try {
        const { stdout } = await runCommand(budget, '/usr/sbin/lsof', ['-t', '--', path], { maxBuffer: 100_000 })
        if (stdout.trim()) active.push(`${path}:${stdout.trim().replaceAll('\n', ',')}`)
      } catch (error) {
        if (!isCommandExitOne(error)) throw error
      }
    }
    if (active.length === 0) return
    if (!budget) throw new Error(`active_writer:${active.join('|')}`)
    await sleepWithinDowntime(budget, 1000)
  }
}

async function assertNoCronLocks(lockRoot: string, budget?: CutoverBudget): Promise<void> {
  while (true) {
    if (budget) await assertWithinDowntime(budget.startedAt, budget.maxDowntimeSeconds)
    try {
      const entries = await readdir(resolve(lockRoot), { withFileTypes: true })
      const active = entries.filter((entry) => entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())
      const symlink = active.find((entry) => entry.isSymbolicLink())
      if (symlink) throw new Error(`cron_lock_symlink_forbidden:${symlink.name}`)
      if (active.length === 0) return
      if (!budget) throw new Error(`active_cron_lock:${join(resolve(lockRoot), active[0]!.name)}`)
    } catch (error) {
      if (isEnoent(error)) return
      if (error instanceof Error && error.message.startsWith('cron_lock_symlink_forbidden:')) throw error
      if (error instanceof Error && error.message.startsWith('active_cron_lock:')) throw error
      throw error
    }
    await sleepWithinDowntime(budget!, 1000)
  }
}

export async function assertWithinDowntime(startedAt: number, maxSeconds: number): Promise<void> {
  if ((Date.now() - startedAt) / 1000 > maxSeconds) throw new Error('research_cutover_downtime_budget_exceeded')
}

export function remainingDowntimeMilliseconds(startedAt: number, maxSeconds: number): number {
  const remaining = maxSeconds * 1000 - (Date.now() - startedAt)
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('research_cutover_downtime_budget_exceeded')
  return Math.max(1, Math.ceil(remaining))
}

/**
 * V2's shell entrypoint has no PATH or interpreter fallback.  These values
 * are non-secret but must be explicit, pinned launchd inputs.  Keep this
 * independent of the host process so preflight cannot accidentally attest to
 * whatever happens to be installed on the machine running the cutover tool.
 */
export function validatePaperLocalLaunchInputs(input: Pick<Args,
  'paperLocalNode' | 'paperLocalNodeSha256' | 'paperLocalMjsSha256' | 'paperLocalPython' | 'paperLocalPublisherUid'
>): string[] {
  const blockers: string[] = []
  if (!input.paperLocalNode?.startsWith('/')) {
    blockers.push('paper_local_node_missing_or_not_absolute')
  }
  if (!/^[a-f0-9]{64}$/.test(input.paperLocalNodeSha256 ?? '')) {
    blockers.push('paper_local_node_sha256_missing_or_invalid')
  }
  if (!/^[a-f0-9]{64}$/.test(input.paperLocalMjsSha256 ?? '')) {
    blockers.push('paper_local_mjs_sha256_missing_or_invalid')
  }
  if (!input.paperLocalPython?.startsWith('/')) {
    blockers.push('paper_local_python_missing_or_not_absolute')
  }
  if (!/^\d+$/.test(input.paperLocalPublisherUid ?? '')) {
    blockers.push('paper_local_publisher_uid_missing_or_invalid')
  }
  return blockers
}

/**
 * This one-shot cutover process mutates the release pointer, materializes the
 * stable wrapper, and writes the GUI launchd job itself.  Environment UID
 * strings cannot establish that a separate publisher identity performed the
 * immutable deployment.  V2 therefore remains blocked until an external,
 * two-identity deployment protocol is introduced and independently attested.
 */
export function paperLocalTwoIdentityDeploymentBlockers(
  manifest: Pick<ReleaseManifest, 'schemaVersion'>,
): readonly string[] {
  return manifest.schemaVersion === 'release_manifest.v2'
    ? [PAPER_LOCAL_TWO_IDENTITY_DEPLOYMENT_BLOCKER]
    : []
}

async function sleepWithinDowntime(budget: CutoverBudget, requestedMilliseconds: number): Promise<void> {
  const delay = Math.min(requestedMilliseconds, remainingDowntimeMilliseconds(budget.startedAt, budget.maxDowntimeSeconds))
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delay))
}

async function runCommand(
  budget: CutoverBudget | undefined,
  file: string,
  args: string[],
  options: Record<string, unknown> = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeout = budget ? remainingDowntimeMilliseconds(budget.startedAt, budget.maxDowntimeSeconds) : undefined
  try {
    return await execFileAsync(file, args, {
      ...options,
      ...(timeout === undefined ? {} : { timeout, killSignal: 'SIGTERM' }),
    }) as { stdout: string; stderr: string }
  } catch (error) {
    if (budget && (isExecTimeout(error) || Date.now() - budget.startedAt >= budget.maxDowntimeSeconds * 1000)) {
      throw new Error('research_cutover_downtime_budget_exceeded')
    }
    throw error
  }
}

async function runCutoverCommand(
  budget: CutoverBudget,
  file: string,
  args: string[],
  options: Record<string, unknown> = {},
): Promise<{ stdout: string; stderr: string }> {
  return runCommand(budget, file, args, options)
}

function isExecTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; killed?: unknown; signal?: unknown }
  return value.code === 'ETIMEDOUT' || (value.killed === true && value.signal === 'SIGTERM')
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

/**
 * `verifyReleaseDirectory` has already checked the materialized tree.  This
 * second preflight assertion makes the cutover's own closure contract explicit
 * without smuggling V1's app deploy image into a D1 PAPER_LOCAL release.
 */
export function assertCutoverReleaseClosure(
  manifest: Pick<ReleaseManifest, 'schemaVersion' | 'artifactHashes'>,
): void {
  const paths = Object.keys(manifest.artifactHashes)
  if (manifest.schemaVersion === 'release_manifest.v2') {
    assertNoForbiddenD1ReleaseArtifactPaths(paths)
    for (const requiredPath of D1_RELEASE_REQUIRED_ARTIFACT_PATHS) {
      if (!paths.includes(requiredPath)) {
        throw new Error(`execution_sidecar_release_artifact_missing:${requiredPath}`)
      }
    }
    return
  }
  for (const prefix of ['dist/', 'scripts/', 'src/', 'sidecars/', 'ops/', 'default/', 'node_modules/.bin/tsx', 'package.json', 'pnpm-lock.yaml', 'release-metadata/']) {
    if (!paths.some((path) => path === prefix || path.startsWith(prefix))) {
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
    paperLocalSupervisorConfig: values.get('paperLocalSupervisorConfig'),
    paperLocalNode: values.get('paperLocalNode'),
    paperLocalNodeSha256: values.get('paperLocalNodeSha256'),
    paperLocalMjsSha256: values.get('paperLocalMjsSha256'),
    paperLocalPython: values.get('paperLocalPython'),
    paperLocalPublisherUid: values.get('paperLocalPublisherUid'),
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
