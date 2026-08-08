#!/usr/bin/env tsx

/**
 * Convert a completed isolated-canary observation log into a signed-by-hash
 * canary_readiness_receipt.v1.  This is deliberately fail-closed: a 24-hour
 * wall-clock span alone is insufficient unless every observation retains the
 * same process, immutable release cwd, health boundary, and isolated input
 * tree, and the release manifest still verifies at finalization time.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  buildCanaryReadinessReceipt,
  type CanaryReadinessReceiptV1,
} from '../src/runtime/canary_governance.js'
import { verifyReleaseDirectory } from '../src/runtime/release_manager.js'
import { resolveRuntimePaths } from '../src/runtime/runtime-paths.js'

const MIN_OBSERVATION_SECONDS = 86_400
const MAX_OBSERVATION_GAP_SECONDS = 180
const execFileAsync = promisify(execFile)

interface ObservationStart {
  schemaVersion: 'canary_observation_start.v1'
  status: 'observing'
  observedAt: string
  releaseId: string
  sourceCommit: string
  sourceKind: 'verified_release'
  dirtyStateHash: string
  manifestHash: string
  runtimeRole: 'canary'
  process: {
    pid: number
    entry: string
  }
  release: {
    releaseRoot: string
    releasePath: string
    canaryReleaseRoot: string
  }
  paths: {
    state: string
    artifact: string
    log: string
    sharedDataInput: string
  }
  ports: {
    web: number
    mcp: number
    primaryWeb: number
    primaryMcp: number
  }
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

interface ObservationRecord {
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

interface ObservationCompletion {
  schemaVersion: 'canary_monitor_completion.v1'
  status: 'observation_window_elapsed'
  completedAt: string
  durationSeconds: number
  releasePath: string
  pid: number
}

export interface FinalizeCanaryObservationOptions {
  startPath: string
  monitorPath: string
  releaseRoot: string
  releaseId: string
  outputPath: string
  failurePath?: string
  legacyWipRoot?: string
  freezeReceiptPath?: string
  expiresInSeconds?: number
  now?: Date
}

export async function finalizeCanaryObservation(
  options: FinalizeCanaryObservationOptions,
): Promise<CanaryReadinessReceiptV1> {
  const legacyWipVerification = await verifyFrozenLegacyWip(options)
  const start = parseStart(JSON.parse(await readFile(resolve(options.startPath), 'utf8')))
  if (start.releaseId !== options.releaseId || start.sourceCommit !== options.releaseId) {
    throw new Error('canary_observation_release_id_mismatch')
  }
  if (start.dirtyStateHash !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') {
    throw new Error('canary_observation_release_dirty_state_not_empty')
  }
  if (!Object.values(start.capabilities).every((value) => value === false)
    || start.isolation.configReadOnly !== true
    || start.isolation.telegramEnabled !== false
    || start.isolation.cronOwner !== false
    || start.isolation.executionAllowed !== false
    || start.isolation.productionPointersTouched !== false) {
    throw new Error('canary_observation_isolation_contract_invalid')
  }
  if (start.release.releaseRoot !== resolve(options.releaseRoot)) {
    throw new Error('canary_observation_release_root_mismatch')
  }
  if (start.release.releasePath !== resolve(options.releaseRoot, options.releaseId)) {
    throw new Error('canary_observation_release_path_mismatch')
  }

  const failurePath = resolve(options.failurePath ?? `${options.monitorPath}.failure.json`)
  if (await exists(failurePath)) throw new Error('canary_observation_failure_record_present')

  const lines = (await readFile(resolve(options.monitorPath), 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const observations: ObservationRecord[] = []
  let completion: ObservationCompletion | null = null
  for (const line of lines) {
    const value = JSON.parse(line) as Record<string, unknown>
    if (value.schemaVersion === 'canary_observation.v1') {
      observations.push(parseObservation(value))
    } else if (value.schemaVersion === 'canary_monitor_completion.v1') {
      if (completion) throw new Error('canary_observation_duplicate_completion')
      completion = parseCompletion(value)
    } else {
      throw new Error('canary_observation_unknown_record')
    }
  }
  if (!completion) throw new Error('canary_observation_window_not_complete')
  if (observations.length < 2) throw new Error('canary_observation_records_missing')
  validateObservationSeries(start, observations, completion)

  const manifest = await verifyReleaseDirectory(options.releaseRoot, options.releaseId)
  if (manifest.manifestHash !== start.manifestHash) {
    throw new Error('canary_observation_manifest_hash_mismatch')
  }
  if (manifest.sourceCommit !== options.releaseId || manifest.dirtyStateHash !== start.dirtyStateHash) {
    throw new Error('canary_observation_manifest_identity_mismatch')
  }
  if (manifest.liveExecutionArmed !== false) throw new Error('canary_observation_live_execution_armed')

  const firstAt = Date.parse(start.observedAt)
  const lastAt = Date.parse(observations[observations.length - 1]!.observedAt)
  const durationSeconds = Math.floor((lastAt - firstAt) / 1000)
  const now = options.now ?? new Date()
  const expiresInSeconds = Math.max(
    MIN_OBSERVATION_SECONDS,
    Math.floor(options.expiresInSeconds ?? MIN_OBSERVATION_SECONDS),
  )
  const sharedInput = start.paths.sharedDataInput
  const runtime = resolveRuntimePaths({
    repoRoot: dirname(resolve(options.releaseRoot)),
    env: {
      OPENALICE_RUNTIME_ROLE: 'canary',
      OPENALICE_DATA_DIR: sharedInput,
      OPENALICE_SHARED_DATA_INPUT_DIR: sharedInput,
      OPENALICE_CANARY_ROOT: dirname(resolve(start.paths.state)),
      OPENALICE_CANARY_WEB_PORT: String(start.ports.web),
      OPENALICE_CANARY_MCP_PORT: String(start.ports.mcp),
    },
  })
  const evidenceRefs = [...new Set([
    ...start.evidenceRefs,
    resolve(options.startPath),
    resolve(options.monitorPath),
    resolve(failurePath),
    `release_manifest:sha256:${manifest.manifestHash}`,
    ...(options.freezeReceiptPath && legacyWipVerification
      ? [`legacy_wip_freeze_receipt:${resolve(options.freezeReceiptPath)}`]
      : []),
  ])].sort()
  const receipt = buildCanaryReadinessReceipt({
    scope: 'production_canary',
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
    releaseId: options.releaseId,
    manifestHash: manifest.manifestHash,
    observationDurationSeconds: durationSeconds,
    runtime,
    primaryPorts: {
      web: start.ports.primaryWeb,
      mcp: start.ports.primaryMcp,
    },
    observations: {
      readiness: 'pass',
      cronOwners: [],
      accountsInitialized: 0,
      orderSubmissions: 0,
      promotionWrites: 0,
      sharedWrites: 0,
    },
    sharedDataBeforeHash: observations[0]!.inputTreeHash,
    sharedDataAfterHash: observations[observations.length - 1]!.inputTreeHash,
    evidenceRefs,
  })
  await mkdir(dirname(resolve(options.outputPath)), { recursive: true })
  await writeFile(resolve(options.outputPath), `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return receipt
}

async function verifyFrozenLegacyWip(
  options: FinalizeCanaryObservationOptions,
): Promise<Record<string, unknown> | null> {
  if (!options.legacyWipRoot && !options.freezeReceiptPath) return null
  if (!options.legacyWipRoot || !options.freezeReceiptPath) {
    throw new Error('legacy_wip_freeze_inputs_required')
  }
  const { stdout } = await execFileAsync('python3', [
    resolve('scripts/verify_wip_freeze.py'),
    '--repo-root',
    resolve(options.legacyWipRoot),
    '--receipt',
    resolve(options.freezeReceiptPath),
  ], { cwd: resolve('.'), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  let verification: Record<string, unknown>
  try {
    verification = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw new Error('legacy_wip_freeze_verification_invalid')
  }
  if (verification.status !== 'pass' || verification.driftDetected === true) {
    throw new Error('legacy_wip_drift_detected')
  }
  return verification
}

function validateObservationSeries(
  start: ObservationStart,
  observations: ObservationRecord[],
  completion: ObservationCompletion,
): void {
  const startMs = Date.parse(start.observedAt)
  let previousMs = startMs
  const expectedInputHash = observations[0]!.inputTreeHash
  for (const observation of observations) {
    const observedMs = Date.parse(observation.observedAt)
    if (!Number.isFinite(observedMs) || observedMs <= previousMs) {
      throw new Error('canary_observation_timestamp_not_monotonic')
    }
    if ((observedMs - previousMs) / 1000 > MAX_OBSERVATION_GAP_SECONDS) {
      throw new Error('canary_observation_gap_too_large')
    }
    if (observation.pid !== start.process.pid
      || observation.expectedPid !== start.process.pid
      || observation.listenerCount !== 1
      || observation.webHealthHttp !== 200
      || observation.mcpUnauthHttp !== 401
      || observation.cwd !== start.release.releasePath
      || !observation.processCommand.includes(`${start.release.releasePath}/dist/main.js`)
      || observation.releasePath !== start.release.releasePath
      || observation.releaseManifestHash !== start.manifestHash
      || observation.releaseManifestVerified !== true
      || observation.inputTreeHash !== expectedInputHash
      || observation.inputTreeUnchanged !== true) {
      throw new Error('canary_observation_boundary_failed')
    }
    if (!Number.isInteger(observation.rssBytes)
      || observation.rssBytes <= 0
      || observation.resourceAnomaly
      || observation.unexpectedWritePaths.length > 0
      || observation.logIdentityValid !== true
      || observation.representativeTaskStatus !== 'pass'
      || observation.pidStable !== true
      || observation.crashDetected !== false) {
      throw new Error('canary_observation_safety_boundary_failed')
    }
    previousMs = observedMs
  }
  const lastMs = Date.parse(observations[observations.length - 1]!.observedAt)
  const durationSeconds = Math.floor((lastMs - startMs) / 1000)
  if (!Number.isInteger(completion.durationSeconds) || completion.durationSeconds < MIN_OBSERVATION_SECONDS) {
    throw new Error('canary_observation_completion_less_than_24h')
  }
  if (completion.pid !== start.process.pid || completion.releasePath !== start.release.releasePath) {
    throw new Error('canary_observation_completion_identity_mismatch')
  }
  if (Date.parse(completion.completedAt) < lastMs) throw new Error('canary_observation_completion_timestamp_invalid')
  if (durationSeconds < MIN_OBSERVATION_SECONDS) throw new Error('canary_observation_less_than_24h')
}

function parseStart(value: unknown): ObservationStart {
  const start = value as Partial<ObservationStart>
  if (start.schemaVersion !== 'canary_observation_start.v1' || start.status !== 'observing') {
    throw new Error('canary_observation_start_invalid')
  }
  if (start.runtimeRole !== 'canary' || start.sourceKind !== 'verified_release') {
    throw new Error('canary_observation_start_identity_invalid')
  }
  return value as ObservationStart
}

function parseObservation(value: Record<string, unknown>): ObservationRecord {
  if (value.schemaVersion !== 'canary_observation.v1') throw new Error('canary_observation_record_invalid')
  return value as unknown as ObservationRecord
}

function parseCompletion(value: Record<string, unknown>): ObservationCompletion {
  if (value.schemaVersion !== 'canary_monitor_completion.v1' || value.status !== 'observation_window_elapsed') {
    throw new Error('canary_observation_completion_invalid')
  }
  return value as unknown as ObservationCompletion
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function parseArgs(argv: string[]): FinalizeCanaryObservationOptions {
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
    monitorPath: required('monitor'),
    releaseRoot: required('releaseRoot'),
    releaseId: required('releaseId'),
    outputPath: required('output'),
    failurePath: values.get('failure'),
    legacyWipRoot: values.get('legacyRepoRoot')
      ? resolve(values.get('legacyRepoRoot')!)
      : process.env.OPENALICE_LEGACY_WIP_ROOT
        ? resolve(process.env.OPENALICE_LEGACY_WIP_ROOT)
        : undefined,
    freezeReceiptPath: values.get('freezeReceipt')
      ? resolve(values.get('freezeReceipt')!)
      : process.env.OPENALICE_LEGACY_WIP_FREEZE_RECEIPT
        ? resolve(process.env.OPENALICE_LEGACY_WIP_FREEZE_RECEIPT)
        : undefined,
    expiresInSeconds: values.has('expiresInSeconds')
      ? Number(values.get('expiresInSeconds'))
      : undefined,
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  finalizeCanaryObservation(parseArgs(process.argv.slice(2)))
    .then((receipt) => console.log(JSON.stringify(receipt, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
