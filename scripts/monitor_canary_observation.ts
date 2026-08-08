#!/usr/bin/env tsx

/**
 * Fail-closed isolated Canary monitor.
 *
 * The monitor intentionally observes only a process that was started from a
 * verified immutable release.  It never owns Cron, sends Telegram, writes
 * shared data, or runs an arbitrary task command.  A representative research
 * task is admitted only through a separately produced, hash-bound receipt.
 */

import { appendFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { sha256Canonical } from '../src/sidecar/contracts.js'
import { verifyReleaseDirectory } from '../src/runtime/release_manager.js'

const execFileAsync = promisify(execFile)
const SHA256_RE = /^[a-f0-9]{64}$/
const COMMIT_RE = /^[a-f0-9]{40}$/
const MAX_LOG_BYTES = 256 * 1024
const DEFAULT_DURATION_SECONDS = 86_400
const DEFAULT_INTERVAL_SECONDS = 60
const MAX_OBSERVATION_GAP_SECONDS = 180
const EMPTY_DIRTY_STATE_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export interface CanaryObservationStart {
  schemaVersion: 'canary_observation_start.v1'
  status: 'observing'
  observedAt: string
  releaseId: string
  sourceCommit: string
  sourceKind: 'verified_release'
  dirtyStateHash: string
  manifestHash: string
  runtimeRole: 'canary'
  process: { pid: number; entry: string }
  release: { releaseRoot: string; releasePath: string; canaryReleaseRoot: string }
  paths: {
    state: string
    artifact: string
    log: string
    sharedDataInput: string
  }
  ports: { web: number; mcp: number; primaryWeb: number; primaryMcp: number }
  capabilities: {
    ownsCron: false
    initializesAccounts: false
    orderSubmissionPathEnabled: false
    writesPromotion: false
    writesSharedData: false
  }
  isolation: {
    configReadOnly: true
    telegramEnabled: false
    cronOwner: false
    executionAllowed: false
    productionPointersTouched: false
  }
  evidenceRefs: string[]
}

export interface CanaryObservationRecord {
  schemaVersion: 'canary_observation.v1'
  observedAt: string
  pid: number | null
  expectedPid: number
  listenerCount: number
  webHealthHttp: number
  mcpUnauthHttp: number
  cwd: string
  processCommand: string
  releasePath: string
  releaseManifestHash: string
  releaseManifestVerified: boolean
  inputTreeHash: string
  inputTreeUnchanged: boolean
  rssBytes: number
  resourceAnomaly: boolean
  writableOpenPaths: string[]
  unexpectedWritePaths: string[]
  logIdentityValid: boolean
  representativeTaskStatus: 'pass' | 'not_configured' | 'invalid'
  pidStable: boolean
  crashDetected: boolean
}

export interface CanaryMonitorCompletion {
  schemaVersion: 'canary_monitor_completion.v1'
  status: 'observation_window_elapsed'
  completedAt: string
  durationSeconds: number
  releasePath: string
  pid: number
}

export interface MonitorCanaryObservationOptions {
  startPath: string
  releaseRoot: string
  releaseId: string
  outputPath: string
  failurePath: string
  logPath: string
  representativeTaskReceiptPath?: string
  durationSeconds?: number
  intervalSeconds?: number
  now?: () => Date
  sleep?: (milliseconds: number) => Promise<void>
}

interface RepresentativeTaskReceipt {
  schemaVersion?: string
  status?: string
  releaseId?: string
  manifestHash?: string
  taskId?: string
}

export async function monitorCanaryObservation(
  options: MonitorCanaryObservationOptions,
): Promise<CanaryMonitorCompletion> {
  const start = parseStart(JSON.parse(await readFile(resolve(options.startPath), 'utf8')))
  if (start.releaseId !== options.releaseId || start.sourceCommit !== options.releaseId) {
    throw new Error('canary_monitor_release_id_mismatch')
  }
  const releaseRoot = resolve(options.releaseRoot)
  const releasePath = resolve(releaseRoot, options.releaseId)
  if (resolve(start.release.releaseRoot) !== releaseRoot || resolve(start.release.releasePath) !== releasePath) {
    throw new Error('canary_monitor_release_path_mismatch')
  }
  if (start.process.pid <= 0 || !Number.isInteger(start.process.pid)) {
    throw new Error('canary_monitor_pid_invalid')
  }
  if (start.dirtyStateHash !== EMPTY_DIRTY_STATE_HASH) {
    throw new Error('canary_monitor_release_dirty_state_not_empty')
  }
  if (!Object.values(start.capabilities).every((value) => value === false)
    || start.isolation.configReadOnly !== true
    || start.isolation.telegramEnabled !== false
    || start.isolation.cronOwner !== false
    || start.isolation.executionAllowed !== false
    || start.isolation.productionPointersTouched !== false) {
    throw new Error('canary_monitor_isolation_contract_invalid')
  }

  const manifest = await verifyReleaseDirectory(releaseRoot, options.releaseId)
  if (manifest.manifestHash !== start.manifestHash || manifest.sourceCommit !== options.releaseId) {
    throw new Error('canary_monitor_manifest_identity_mismatch')
  }
  const durationSeconds = Math.max(1, Math.floor(options.durationSeconds ?? DEFAULT_DURATION_SECONDS))
  const intervalSeconds = Math.max(1, Math.floor(options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS))
  const now = options.now ?? (() => new Date())
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)))
  const startedAtMs = Date.parse(start.observedAt)
  if (!Number.isFinite(startedAtMs)) throw new Error('canary_monitor_start_timestamp_invalid')
  const endAtMs = startedAtMs + durationSeconds * 1000
  const observations: CanaryObservationRecord[] = []
  let previousObservedAtMs = startedAtMs
  let baselineRss: number | null = null
  let baselineInputHash: string | null = null
  let failed = false
  await mkdir(dirname(resolve(options.outputPath)), { recursive: true })
  await writeFile(resolve(options.outputPath), '', { encoding: 'utf8', mode: 0o600 })
  await chmod(resolve(options.outputPath), 0o600)
  await stat(resolve(options.releaseRoot))

  while (true) {
    const current = now()
    const observedAtMs = current.getTime()
    if (observedAtMs < previousObservedAtMs) throw new Error('canary_monitor_clock_regressed')
    const observation = await collectCanaryObservation({
      start,
      releaseRoot,
      releasePath,
      logPath: options.logPath,
      representativeTaskReceiptPath: options.representativeTaskReceiptPath,
      baselineRss,
      baselineInputHash,
      now: current,
    })
    baselineRss ??= observation.rssBytes
    baselineInputHash ??= observation.inputTreeHash
    observations.push(observation)
    await appendJsonLine(options.outputPath, observation)
    const gapSeconds = (observedAtMs - previousObservedAtMs) / 1000
    const boundaryReasons = evaluateCanaryObservation(
      observation,
      start.process.pid,
      releasePath,
      start.manifestHash,
    )
    if (gapSeconds > MAX_OBSERVATION_GAP_SECONDS) {
      await recordFailure(options.failurePath, 'canary_observation_gap_too_large', current)
      failed = true
    } else if (boundaryReasons.length > 0) {
      await recordFailure(options.failurePath, `canary_observation_boundary_failed:${boundaryReasons.join('|')}`, current)
      failed = true
    }
    if (failed) throw new Error('canary_observation_failed')
    previousObservedAtMs = observedAtMs
    if (observedAtMs >= endAtMs) break
    const remainingMs = endAtMs - observedAtMs
    await sleep(Math.min(intervalSeconds * 1000, remainingMs))
  }

  const completedAt = now()
  const completion: CanaryMonitorCompletion = {
    schemaVersion: 'canary_monitor_completion.v1',
    status: 'observation_window_elapsed',
    completedAt: completedAt.toISOString(),
    durationSeconds: Math.floor((completedAt.getTime() - startedAtMs) / 1000),
    releasePath,
    pid: start.process.pid,
  }
  await appendJsonLine(options.outputPath, completion)
  return completion
}

export function evaluateCanaryObservation(
  observation: CanaryObservationRecord,
  expectedPid: number,
  expectedReleasePath: string,
  expectedManifestHash: string,
): string[] {
  const reasons: string[] = []
  if (observation.pid !== expectedPid || observation.expectedPid !== expectedPid) reasons.push('pid_changed')
  if (observation.listenerCount !== 1) reasons.push('listener_count_invalid')
  if (observation.webHealthHttp !== 200) reasons.push('health_not_200')
  if (observation.mcpUnauthHttp !== 401) reasons.push('mcp_auth_boundary_invalid')
  if (observation.cwd !== expectedReleasePath) reasons.push('working_directory_escape')
  if (observation.releasePath !== expectedReleasePath) reasons.push('release_path_mismatch')
  if (!observation.processCommand.includes(`${expectedReleasePath}/dist/main.js`)) reasons.push('immutable_entry_not_running')
  if (observation.releaseManifestHash !== expectedManifestHash || !observation.releaseManifestVerified) reasons.push('release_manifest_unverified')
  if (!observation.inputTreeUnchanged) reasons.push('shared_input_changed')
  if (!Number.isInteger(observation.rssBytes) || observation.rssBytes <= 0) reasons.push('rss_invalid')
  if (observation.resourceAnomaly) reasons.push('resource_growth_anomaly')
  if (observation.unexpectedWritePaths.length > 0) reasons.push('unexpected_write_path')
  if (!observation.logIdentityValid) reasons.push('startup_log_identity_invalid')
  if (observation.representativeTaskStatus !== 'pass') reasons.push('representative_task_not_pass')
  if (!observation.pidStable) reasons.push('pid_not_stable')
  if (observation.crashDetected) reasons.push('crash_detected')
  return [...new Set(reasons)].sort()
}

async function collectCanaryObservation(input: {
  start: CanaryObservationStart
  releaseRoot: string
  releasePath: string
  logPath: string
  representativeTaskReceiptPath?: string
  baselineRss: number | null
  baselineInputHash: string | null
  now: Date
}): Promise<CanaryObservationRecord> {
  const manifest = await verifyReleaseDirectory(input.releaseRoot, input.start.releaseId)
  const pids = await listListeningPids(input.start.ports.web)
  const pid = pids.length === 1 ? pids[0]! : null
  const cwd = pid === null ? '' : await readProcessCwd(pid).catch(() => '')
  const command = pid === null ? '' : await readProcessCommand(pid).catch(() => '')
  const rssBytes = pid === null ? 0 : await readProcessRss(pid).catch(() => 0)
  const writableOpenPaths = pid === null ? [] : await listWritableOpenPaths(pid)
  const allowedWriteRoots = [
    resolve(input.start.release.releaseRoot, '..', 'canary'),
    resolve(input.start.paths.state),
    resolve(input.start.paths.artifact),
    resolve(input.start.paths.log),
    resolve(tmpdir()),
  ]
  const unexpectedWritePaths = writableOpenPaths.filter((path) => !allowedWriteRoots.some((root) => isWithin(root, path)))
  const inputTreeHash = await treeHash(input.start.paths.sharedDataInput)
  const expectedInputHash = input.baselineInputHash ?? inputTreeHash
  const logText = await readTail(input.logPath)
  const logIdentityValid = logText.includes(input.start.releaseId)
    && logText.includes(input.start.sourceCommit)
    && logText.includes(manifest.manifestHash)
  const representativeTaskStatus = await readRepresentativeTaskStatus(
    input.representativeTaskReceiptPath,
    input.start.releaseId,
    manifest.manifestHash,
  )
  const resourceAnomaly = input.baselineRss !== null
    && rssBytes > Math.max(input.baselineRss * 2, 512 * 1024 * 1024)
  const webHealthHttp = await probeHttp(input.start.ports.web, '/api/health')
  const mcpUnauthHttp = await probeHttp(input.start.ports.mcp, '/mcp')
  return {
    schemaVersion: 'canary_observation.v1',
    observedAt: input.now.toISOString(),
    pid,
    expectedPid: input.start.process.pid,
    listenerCount: pids.length,
    webHealthHttp,
    mcpUnauthHttp,
    cwd,
    processCommand: command,
    releasePath: input.releasePath,
    releaseManifestHash: manifest.manifestHash,
    releaseManifestVerified: manifest.manifestHash === input.start.manifestHash,
    inputTreeHash,
    inputTreeUnchanged: inputTreeHash === expectedInputHash,
    rssBytes,
    resourceAnomaly,
    writableOpenPaths,
    unexpectedWritePaths,
    logIdentityValid,
    representativeTaskStatus,
    pidStable: pid === input.start.process.pid,
    crashDetected: pid === null || !command.includes(`${input.releasePath}/dist/main.js`),
  }
}

async function readRepresentativeTaskStatus(
  path: string | undefined,
  releaseId: string,
  manifestHash: string,
): Promise<'pass' | 'not_configured' | 'invalid'> {
  if (!path) return 'not_configured'
  try {
    const value = JSON.parse(await readFile(resolve(path), 'utf8')) as RepresentativeTaskReceipt
    return value.status === 'pass'
      && value.releaseId === releaseId
      && value.manifestHash === manifestHash
      && typeof value.taskId === 'string'
      ? 'pass'
      : 'invalid'
  } catch {
    return 'invalid'
  }
}

async function listListeningPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
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
  return String(stdout).split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1) ?? ''
}

async function readProcessCommand(pid: number): Promise<string> {
  const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    maxBuffer: 100_000,
  })
  return String(stdout).trim()
}

async function readProcessRss(pid: number): Promise<number> {
  const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'rss='], {
    encoding: 'utf8',
    maxBuffer: 10_000,
  })
  const kilobytes = Number(String(stdout).trim())
  if (!Number.isFinite(kilobytes) || kilobytes < 0) throw new Error('canary_rss_invalid')
  return Math.floor(kilobytes * 1024)
}

async function listWritableOpenPaths(pid: number): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-nP', '-p', String(pid), '-F', 'an'], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    })
    let access = ''
    const paths: string[] = []
    for (const line of String(stdout).split(/\r?\n/)) {
      if (line.startsWith('a')) access = line.slice(1)
      if (line.startsWith('n')) {
        const path = line.slice(1)
        if (access.includes('w') || access.includes('u')) paths.push(path)
      }
    }
    return [...new Set(paths)].sort()
  } catch (error) {
    if (isCommandExitOne(error)) return []
    throw error
  }
}

async function probeHttp(port: number, path: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/curl', [
      '--noproxy', '*', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5',
      `http://127.0.0.1:${port}${path}`,
    ], { encoding: 'utf8', maxBuffer: 10_000 })
    return Number(String(stdout).trim())
  } catch {
    return 0
  }
}

async function treeHash(root: string): Promise<string> {
  const script = [
    'set -eu',
    'cd "$1"',
    'find . -type f -print | LC_ALL=C sort | while IFS= read -r path; do',
    '  shasum -a 256 "$path" | awk -v p="${path#./}" \'{print p "\\t" $1}\'',
    'done',
  ].join('\n')
  const { stdout } = await execFileAsync(
    '/bin/sh',
    ['-c', script, 'openalice-tree-hash', resolve(root)],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  return sha256Canonical(String(stdout))
}

async function readTail(path: string): Promise<string> {
  try {
    const raw = await readFile(resolve(path))
    return raw.subarray(Math.max(0, raw.length - MAX_LOG_BYTES)).toString('utf8')
  } catch {
    return ''
  }
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(resolve(path), `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function recordFailure(path: string, reason: string, now: Date): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(resolve(path), `${JSON.stringify({
    schemaVersion: 'canary_monitor_failure.v1',
    status: 'blocked',
    reason,
    observedAt: now.toISOString(),
  })}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(resolve(path), 0o600)
}

function parseStart(value: unknown): CanaryObservationStart {
  const start = value as Partial<CanaryObservationStart>
  if (start.schemaVersion !== 'canary_observation_start.v1' || start.status !== 'observing') {
    throw new Error('canary_monitor_start_invalid')
  }
  if (start.runtimeRole !== 'canary' || start.sourceKind !== 'verified_release') {
    throw new Error('canary_monitor_start_identity_invalid')
  }
  if (!COMMIT_RE.test(start.releaseId ?? '') || !SHA256_RE.test(start.manifestHash ?? '')) {
    throw new Error('canary_monitor_start_hash_invalid')
  }
  return value as CanaryObservationStart
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

function isCommandExitOne(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 1)
}

function parseArgs(argv: string[]): MonitorCanaryObservationOptions {
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
    startPath: required('start'),
    releaseRoot: required('releaseRoot'),
    releaseId: required('releaseId'),
    outputPath: required('output'),
    failurePath: required('failure'),
    logPath: required('log'),
    representativeTaskReceiptPath: values.get('taskReceipt'),
    durationSeconds: values.has('durationSeconds') ? Number(values.get('durationSeconds')) : undefined,
    intervalSeconds: values.has('intervalSeconds') ? Number(values.get('intervalSeconds')) : undefined,
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  monitorCanaryObservation(parseArgs(process.argv.slice(2)))
    .then((completion) => console.log(JSON.stringify(completion, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
