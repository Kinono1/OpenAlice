import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { CronJob } from '../task/cron/engine.js'
import {
  SIDECAR_ASSETS,
  SIDECAR_SOURCES,
  openAliceSidecarRequestV1Schema,
  openAliceSidecarResultV1Schema,
  sha256Canonical,
  stableStringify,
  validateSidecarExchangeV1,
} from '../sidecar/contracts.js'
import {
  admissionDecisionV1Schema,
  reduceAdmissionDecision,
  tryLoadAdmissionDecision,
  type AdmissionDecisionLoadResult,
  type AdmissionDecisionV1,
} from './admission.js'
import { readReleasePointer, verifyReleaseDirectory } from './release_manager.js'
import type { ReleaseManifestV1 } from './release_manifest.js'
import type { RuntimePaths } from './runtime-paths.js'

const SHA256_RE = /^[a-f0-9]{64}$/
const COMMIT_RE = /^[a-f0-9]{40}$/
const EMPTY_DIRTY_STATE_HASH = createHash('sha256').update('').digest('hex')
const ZERO_COMMIT = '0'.repeat(40)
const ZERO_HASH = '0'.repeat(64)

const dataFreshnessItemV1Schema = z.object({
  status: z.enum(['fresh', 'stale', 'missing']),
  ageMs: z.number().int().nonnegative().nullable(),
  evidenceRef: z.string().regex(SHA256_RE).nullable(),
}).strict()

const sidecarSystemStatusV1Schema = z.object({
  source: z.enum(SIDECAR_SOURCES),
  commit: z.string().regex(COMMIT_RE).nullable(),
  status: z.enum(['healthy', 'degraded', 'blocked', 'unknown']),
  lastReceiptAt: z.string().datetime().nullable(),
  reason: z.string().trim().min(1).max(200),
}).strict()

export const systemStatusV1Schema = z.object({
  schemaVersion: z.literal('system_status.v1'),
  generatedAt: z.string().datetime(),
  statusSource: z.enum(['executed_receipt', 'stale', 'missing']),
  release: z.object({
    currentCommit: z.string().regex(COMMIT_RE).nullable(),
    previousCommit: z.string().regex(COMMIT_RE).nullable(),
    manifestHash: z.string().regex(SHA256_RE).nullable(),
    runtimeRole: z.enum(['primary', 'research', 'canary', 'test']),
    dirtyState: z.enum(['clean', 'dirty', 'unknown']),
    evidenceTrust: z.enum(['trusted', 'stale', 'blocked']),
  }).strict(),
  scheduler: z.object({
    owner: z.literal('openalice_cron_engine').nullable(),
    success: z.number().int().nonnegative(),
    failure: z.number().int().nonnegative(),
    circuitOpen: z.number().int().nonnegative(),
    pausedExternalDependency: z.number().int().nonnegative(),
  }).strict(),
  dataFreshness: z.record(z.string(), dataFreshnessItemV1Schema),
  pipelineRegistry: z.object({
    registered: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    coveragePct: z.number().min(0).max(100),
    registryHash: z.string().regex(SHA256_RE).nullable(),
  }).strict(),
  sidecars: z.array(sidecarSystemStatusV1Schema),
  admission: admissionDecisionV1Schema,
  nextAction: z.string().trim().min(1).max(300),
  evidenceRefs: z.array(z.string().regex(SHA256_RE)),
}).strict()

export type SystemStatusV1 = z.infer<typeof systemStatusV1Schema>

export interface LoadSystemStatusOptions {
  runtime: RuntimePaths
  cronJobs?: readonly CronJob[]
  now?: Date
  releaseDir?: string
  admissionPath?: string
  freshnessPath?: string
  pipelineRegistryPath?: string
  sidecarPaths?: Partial<Record<(typeof SIDECAR_SOURCES)[number], string>>
}

interface ReleaseSnapshot {
  currentCommit: string | null
  previousCommit: string | null
  manifest: ReleaseManifestV1 | null
  manifestValid: boolean
}

interface HashedJson {
  value: unknown
  hash: string
}

export async function loadSystemStatus(
  options: LoadSystemStatusOptions,
): Promise<SystemStatusV1> {
  const now = options.now ?? new Date()
  const runtime = options.runtime
  const releaseDir = resolve(options.releaseDir ?? runtime.releaseDir)
  const release = await loadReleaseSnapshot(releaseDir, runtime.role)
  const dirtyState = release.manifest
    ? release.manifest.dirtyStateHash === EMPTY_DIRTY_STATE_HASH ? 'clean' : 'dirty'
    : 'unknown'
  const admissionPath = resolve(
    options.admissionPath
      ?? join(runtime.sharedDataInputDir, 'runtime', 'admission_decision.v1.json'),
  )
  const admissionLoad = await tryLoadAdmissionDecision(admissionPath, { now })
  const admission = runtime.role === 'research'
    ? await buildBlockedAdmission({
        now,
        currentCommit: release.currentCommit,
        dirtyStateHash: release.manifest?.dirtyStateHash ?? EMPTY_DIRTY_STATE_HASH,
        releaseManifestHash: release.manifest?.manifestHash ?? ZERO_HASH,
      })
    : admissionLoad.decision ?? await buildBlockedAdmission({
        now,
        currentCommit: release.currentCommit,
        dirtyStateHash: release.manifest?.dirtyStateHash ?? EMPTY_DIRTY_STATE_HASH,
        releaseManifestHash: release.manifest?.manifestHash ?? ZERO_HASH,
      })
  const admissionBound = admissionLoad.kind === 'loaded'
    && runtime.role === 'primary'
    && release.manifestValid
    && release.currentCommit !== null
    && dirtyState === 'clean'
    && admission.sourceCommit === release.currentCommit
    && admission.dirtyStateHash === release.manifest?.dirtyStateHash
    && admission.releaseManifestHash === release.manifest?.manifestHash
  const statusSource: SystemStatusV1['statusSource'] = runtime.role === 'research'
    ? 'missing'
    : admissionBound
    ? 'executed_receipt'
    : admissionLoad.kind === 'stale' || admissionLoad.kind === 'loaded'
      ? 'stale'
      : 'missing'
  const evidenceTrust: SystemStatusV1['release']['evidenceTrust'] = admissionBound
    ? 'trusted'
    : statusSource === 'stale'
      ? 'stale'
      : 'blocked'

  const freshnessPath = resolve(
    options.freshnessPath
      ?? join(runtime.sharedDataInputDir, 'runtime', 'live_data_freshness.latest.json'),
  )
  const freshness = await loadDataFreshness(freshnessPath, now)
  freshness.values.admission_decision = admissionFreshness(admissionLoad, admission, now)

  const pipelineRegistryPath = resolve(
    options.pipelineRegistryPath
      ?? join(runtime.repoRoot, 'ops', 'pipeline', 'pipeline_registry.v1.json'),
  )
  const pipelineRegistry = await loadPipelineRegistry(pipelineRegistryPath)
  const sidecars = await Promise.all(SIDECAR_SOURCES.map((source) => loadSidecarStatus({
    source,
    path: resolve(
      options.sidecarPaths?.[source]
        ?? join(runtime.sharedDataInputDir, 'runtime', 'sidecars', `${source}.latest.json`),
    ),
    currentCommit: release.currentCommit,
    now,
  })))

  const evidenceRefs = sortedUnique([
    release.manifest?.manifestHash,
    admissionLoad.decision?.decisionId,
    freshness.reportHash,
    pipelineRegistry.registryHash,
    ...sidecars.map((sidecar) => sidecar.evidenceRef),
  ])

  return systemStatusV1Schema.parse({
    schemaVersion: 'system_status.v1',
    generatedAt: now.toISOString(),
    statusSource,
    release: {
      currentCommit: release.currentCommit,
      previousCommit: release.previousCommit,
      manifestHash: release.manifest?.manifestHash ?? null,
      runtimeRole: runtime.role,
      dirtyState,
      evidenceTrust,
    },
    scheduler: summarizeScheduler(runtime, options.cronJobs ?? []),
    dataFreshness: freshness.values,
    pipelineRegistry,
    sidecars: sidecars.map(({ evidenceRef: _evidenceRef, ...sidecar }) => sidecar),
    admission,
    nextAction: nextAction(statusSource, admission),
    evidenceRefs,
  })
}

/** The API and CLI both emit these exact canonical bytes. */
export function serializeSystemStatus(status: SystemStatusV1): string {
  return stableStringify(systemStatusV1Schema.parse(status))
}

function summarizeScheduler(
  runtime: RuntimePaths,
  jobs: readonly CronJob[],
): SystemStatusV1['scheduler'] {
  return {
    owner: runtime.capabilities.ownsCron ? 'openalice_cron_engine' : null,
    success: jobs.filter((job) => job.state.lastStatus === 'ok').length,
    failure: jobs.filter((job) => ['error', 'blocked'].includes(job.state.lastStatus ?? '')).length,
    circuitOpen: jobs.filter((job) => job.state.circuitOpenedAtMs != null).length,
    pausedExternalDependency: jobs.filter(
      (job) => job.state.pauseReason === 'paused_external_dependency',
    ).length,
  }
}

async function loadReleaseSnapshot(
  releaseDir: string,
  runtimeRole: RuntimePaths['role'],
): Promise<ReleaseSnapshot> {
  const currentPointer = runtimeRole === 'research' ? 'research-current' : 'current'
  const previousPointer = runtimeRole === 'research' ? 'research-previous' : 'previous'
  let currentCommit: string | null = null
  let previousCommit: string | null = null
  try {
    currentCommit = await readReleasePointer(releaseDir, currentPointer)
  } catch {
    currentCommit = null
  }
  try {
    previousCommit = await readReleasePointer(releaseDir, previousPointer)
  } catch {
    previousCommit = null
  }
  if (!currentCommit) {
    return { currentCommit, previousCommit, manifest: null, manifestValid: false }
  }
  try {
    const manifest = await verifyReleaseDirectory(releaseDir, currentCommit)
    return { currentCommit, previousCommit, manifest, manifestValid: true }
  } catch {
    return { currentCommit, previousCommit, manifest: null, manifestValid: false }
  }
}

async function buildBlockedAdmission(input: {
  now: Date
  currentCommit: string | null
  dirtyStateHash: string
  releaseManifestHash: string
}): Promise<AdmissionDecisionV1> {
  return reduceAdmissionDecision({
    candidateId: null,
    sourceCommit: input.currentCommit ?? ZERO_COMMIT,
    dirtyStateHash: input.dirtyStateHash,
    releaseManifestHash: input.releaseManifestHash,
    gates: [],
    now: input.now,
  })
}

function admissionFreshness(
  load: AdmissionDecisionLoadResult,
  decision: AdmissionDecisionV1,
  now: Date,
): SystemStatusV1['dataFreshness'][string] {
  const evaluatedAt = Date.parse(decision.evaluatedAt)
  const ageMs = Number.isFinite(evaluatedAt)
    ? Math.max(0, now.getTime() - evaluatedAt)
    : null
  return {
    status: load.kind === 'loaded' ? 'fresh' : load.kind === 'stale' ? 'stale' : 'missing',
    ageMs,
    evidenceRef: load.decision?.decisionId ?? null,
  }
}

async function loadDataFreshness(
  path: string,
  now: Date,
): Promise<{
  values: SystemStatusV1['dataFreshness']
  reportHash: string | null
}> {
  const missing = () => ({ status: 'missing', ageMs: null, evidenceRef: null } as const)
  const values: SystemStatusV1['dataFreshness'] = {
    market_1h: missing(),
    market_5m: missing(),
    market_1s: missing(),
  }
  const report = await tryReadHashedJson(path)
  if (!report || !isRecord(report.value) || !Array.isArray(report.value.directories)) {
    return { values, reportHash: null }
  }
  for (const timeframe of ['1h', '5m', '1s'] as const) {
    const item = report.value.directories.find(
      (candidate) => isRecord(candidate) && candidate.timeframe === timeframe,
    )
    if (!isRecord(item)) continue
    const timestamp = finiteNumber(item.commonLatestTimestamp)
      ?? parseDate(item.commonLatestDatetime)
    const maxAgeMs = finiteNumber(item.maxAgeMsAllowed)
    if (timestamp === null || maxAgeMs === null || maxAgeMs < 0) continue
    const ageMs = Math.max(0, now.getTime() - timestamp)
    const notFuture = timestamp <= now.getTime() + 60_000
    values[`market_${timeframe}`] = {
      status: item.status === 'fresh' && notFuture && ageMs <= maxAgeMs ? 'fresh' : 'stale',
      ageMs,
      evidenceRef: report.hash,
    }
  }
  return { values, reportHash: report.hash }
}

async function loadPipelineRegistry(
  path: string,
): Promise<SystemStatusV1['pipelineRegistry']> {
  const registry = await tryReadHashedJson(path)
  if (!registry || !isRecord(registry.value) || registry.value.schemaVersion !== 'pipeline_registry.v1') {
    return { registered: 0, total: 0, coveragePct: 0, registryHash: null }
  }
  const entries = Array.isArray(registry.value.entries) ? registry.value.entries : []
  const total = finiteInteger(registry.value.entryCount) ?? entries.length
  const entrypoints = new Set(entries.flatMap((entry) =>
    isRecord(entry) && typeof entry.entrypoint === 'string' && entry.entrypoint.startsWith('scripts/')
      ? [entry.entrypoint]
      : [],
  ))
  const registered = Math.min(total, entrypoints.size)
  const coveragePct = total > 0
    ? Number(((registered / total) * 100).toFixed(2))
    : 0
  return { registered, total, coveragePct, registryHash: registry.hash }
}

async function loadSidecarStatus(input: {
  source: (typeof SIDECAR_SOURCES)[number]
  path: string
  currentCommit: string | null
  now: Date
}): Promise<z.infer<typeof sidecarSystemStatusV1Schema> & { evidenceRef: string | null }> {
  const bundle = await tryReadHashedJson(input.path)
  if (!bundle) {
    return {
      source: input.source,
      commit: null,
      status: 'unknown',
      lastReceiptAt: null,
      reason: 'receipt_missing',
      evidenceRef: null,
    }
  }
  if (!isRecord(bundle.value)) {
    return blockedSidecar(input.source, bundle.hash, 'invalid_receipt')
  }
  const request = openAliceSidecarRequestV1Schema.safeParse(bundle.value.request)
  const result = openAliceSidecarResultV1Schema.safeParse(bundle.value.result)
  if (!request.success || !result.success || request.data.source !== input.source) {
    return blockedSidecar(input.source, bundle.hash, 'invalid_receipt')
  }
  if (!input.currentCommit) {
    return {
      source: input.source,
      commit: request.data.sidecarCommit,
      status: 'unknown',
      lastReceiptAt: result.data.generatedAt,
      reason: 'current_release_missing',
      evidenceRef: bundle.hash,
    }
  }
  const decision = validateSidecarExchangeV1({
    request: bundle.value.request,
    result: bundle.value.result,
    manifest: bundle.value.manifest,
    options: {
      now: input.now,
      allowedAssets: SIDECAR_ASSETS,
      allowedOpenAliceCommits: [input.currentCommit],
      allowedSidecarCommits: { [input.source]: [request.data.sidecarCommit] },
    },
  })
  const status = decision.accepted
    ? 'healthy'
    : decision.disposition === 'degraded_research_only'
      ? 'degraded'
      : 'blocked'
  return {
    source: input.source,
    commit: request.data.sidecarCommit,
    status,
    lastReceiptAt: result.data.generatedAt,
    reason: decision.reason,
    evidenceRef: bundle.hash,
  }
}

function blockedSidecar(
  source: (typeof SIDECAR_SOURCES)[number],
  evidenceRef: string,
  reason: string,
) {
  return {
    source,
    commit: null,
    status: 'blocked' as const,
    lastReceiptAt: null,
    reason,
    evidenceRef,
  }
}

function nextAction(
  statusSource: SystemStatusV1['statusSource'],
  admission: AdmissionDecisionV1,
): string {
  if (statusSource === 'missing') return 'generate_current_release_and_admission_receipts'
  if (statusSource === 'stale') return 'refresh_bound_release_and_admission_receipts'
  if (admission.liveExecutionArmed) return 'continue_evidence_monitoring'
  if (admission.blockingReasons.length > 0) return 'resolve_admission_blockers'
  return 'continue_evidence_monitoring'
}

async function tryReadHashedJson(path: string): Promise<HashedJson | null> {
  try {
    const raw = await readFile(path)
    return {
      value: JSON.parse(raw.toString('utf8')),
      hash: createHash('sha256').update(raw).digest('hex'),
    }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function parseDate(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sortedUnique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort()
}

export function systemStatusFingerprint(status: SystemStatusV1): string {
  return sha256Canonical(systemStatusV1Schema.parse(status))
}
