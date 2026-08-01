/**
 * Cron Engine — job scheduler that fires events into the EventLog.
 *
 * Three schedule types:
 *   - at:    one-shot, ISO timestamp ("2025-03-01T09:00:00Z")
 *   - every: interval ("2h", "30m", "5m30s")
 *   - cron:  5-field expression ("0 9 * * 1-5")
 *
 * On fire: appends a `cron.fire` event to the EventLog. Does NOT call
 * the AI engine directly — that's the listener's job.
 *
 * Jobs are stored as a single JSON file on disk (atomic write).
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { EventLog, EventLogEntry } from '../../core/event-log.js'
import {
  pipelineRunContextV1Schema,
  type PipelineRunContextV1,
} from './pipeline-receipt.js'

// ==================== Types ====================

export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; every: string }
  | { kind: 'cron'; cron: string; timezone?: 'local' | 'UTC' }

export interface CronRetryPolicy {
  mode: 'next-schedule' | 'bounded-backoff'
  /** Number of retry attempts between regular scheduled runs. */
  maxAttempts: number
  /** Open the circuit after this many consecutive failed executions. Zero disables the circuit. */
  circuitOpenAfter: number
}

export interface CronJobState {
  nextRunAtMs: number | null
  lastRunAtMs: number | null
  lastSuccessAtMs?: number | null
  lastStatus: 'fired' | 'ok' | 'error' | 'blocked' | null
  consecutiveErrors: number
  circuitOpenedAtMs?: number | null
  lastErrorClass?: string | null
  lastErrorFingerprint?: string | null
  pauseReason?: 'paused_external_dependency' | 'disabled_pending_independent_evidence' | null
}

export type CronJobKind = 'agent' | 'script'

export interface CronScriptSpec {
  path: string
  args?: string[]
  cwd?: string
  notificationPath?: string
}

export interface CronJob {
  id: string
  name: string
  enabled: boolean
  kind?: CronJobKind
  schedule: CronSchedule
  payload: string
  script?: CronScriptSpec
  retryPolicy?: CronRetryPolicy
  state: CronJobState
  createdAt: number
}

const CRON_DEFINITION_REGISTRY_SCHEMA = 'cron_definition_registry.v1'
const CRON_DYNAMIC_DEFINITION_SCHEMA = 'cron_dynamic_definitions.v1'
const CRON_RUNTIME_STATE_SCHEMA = 'cron_runtime_state.v1'

interface CronJobDefinition {
  id: string
  name: string
  enabled: boolean
  kind: CronJobKind
  schedule: CronSchedule
  payload: string
  script?: CronScriptSpec
  retryPolicy?: CronRetryPolicy
  forcedDisabled?: boolean
  forcedDisabledReason?:
    | 'paused_external_dependency'
    | 'disabled_pending_independent_evidence'
}

interface CronRuntimeRecord {
  id: string
  enabled: boolean
  state: CronJobState
  createdAt: number
}

export interface CronFirePayload {
  jobId: string
  jobName: string
  kind?: CronJobKind
  payload: string
  script?: CronScriptSpec
  notificationState?: {
    previousConsecutiveErrors: number
    previousErrorFingerprint?: string | null
    circuitOpenAfter: number
  }
  pipelineContext?: PipelineRunContextV1
}

// ==================== CRUD Types ====================

export interface CronJobCreate {
  name: string
  schedule: CronSchedule
  payload: string
  kind?: CronJobKind
  script?: CronScriptSpec
  enabled?: boolean
  retryPolicy?: CronRetryPolicy
}

export interface CronJobPatch {
  name?: string
  schedule?: CronSchedule
  payload?: string
  kind?: CronJobKind
  script?: CronScriptSpec
  enabled?: boolean
  retryPolicy?: CronRetryPolicy
}

// ==================== Engine Interface ====================

export interface CronEngine {
  start(): Promise<void>
  stop(): void
  add(params: CronJobCreate): Promise<string>
  update(id: string, patch: CronJobPatch): Promise<void>
  remove(id: string): Promise<void>
  list(): CronJob[]
  runNow(id: string): Promise<void>
  get(id: string): CronJob | undefined
}

export interface CronEngineOpts {
  eventLog: EventLog
  storePath?: string
  /**
   * Optional authoritative declarative registry. When present, jobs.json is
   * persisted as runtime state only and definitions are reconciled by stable ID.
   */
  definitionPath?: string
  /** Pipeline registry used to bind every managed script run to policy and lineage metadata. */
  pipelineRegistryPath?: string
  /** Mutable definitions for user-created agent reminders, separate from state. */
  dynamicDefinitionPath?: string
  /** Inject clock for testing. */
  now?: () => number
}

// ==================== Factory ====================

export function createCronEngine(opts: CronEngineOpts): CronEngine {
  const { eventLog } = opts
  const storePath = opts.storePath ?? 'data/cron/jobs.json'
  const definitionPath = opts.definitionPath
  const pipelineRegistryPath = opts.pipelineRegistryPath
  const dynamicDefinitionPath = opts.dynamicDefinitionPath ?? `${storePath}.definitions.local.v1.json`
  const now = opts.now ?? Date.now
  const managedDefinitions = definitionPath !== undefined

  let jobs: CronJob[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let completionUnsubscribers: Array<() => void> = []
  let saveChain: Promise<void> = Promise.resolve()
  const removedJobIds = new Set<string>()
  const removedJobNames = new Set<string>()
  const staticDefinitionIds = new Set<string>()
  const forcedDisabledIds = new Set<string>()
  const dynamicDefinitions = new Map<string, CronJobDefinition>()
  const pipelineContextsByJobId = new Map<string, PipelineRunContextV1>()
  let orphanedRuntimeRecords: CronRuntimeRecord[] = []

  // ---------- persistence ----------

  async function load(): Promise<void> {
    if (managedDefinitions) {
      await loadManaged()
      return
    }
    try {
      const raw = await readFile(storePath, 'utf-8')
      const data = JSON.parse(raw)
      jobs = Array.isArray(data.jobs) ? data.jobs.map(normalizeLoadedJob) : []
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        jobs = []
        return
      }
      throw err
    }
  }

  async function save(): Promise<void> {
    if (managedDefinitions) {
      await saveManaged()
      return
    }
    jobs = await mergeExternallyInstalledJobs(jobs)
    await mkdir(dirname(storePath), { recursive: true })
    const tmp = `${storePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ jobs }, null, 2), 'utf-8')
    await rename(tmp, storePath)
  }

  async function loadManaged(): Promise<void> {
    const staticDefinitions = await readDefinitionRegistry(definitionPath!)
    pipelineContextsByJobId.clear()
    if (pipelineRegistryPath) {
      const contexts = await readPipelineRegistry(pipelineRegistryPath)
      for (const definition of staticDefinitions) {
        if (!definition.script?.path) continue
        const context = contexts.get(definition.script.path)
        if (!context) {
          throw new Error(
            `cron_pipeline_registry_entry_missing:${definition.id}:${definition.script.path}`,
          )
        }
        pipelineContextsByJobId.set(definition.id, context)
      }
    }
    for (const definition of staticDefinitions) {
      staticDefinitionIds.add(definition.id)
      if (definition.forcedDisabled) forcedDisabledIds.add(definition.id)
    }

    const persistedDynamic = await readDynamicDefinitions(dynamicDefinitionPath)
    for (const definition of persistedDynamic) {
      if (!staticDefinitionIds.has(definition.id)) {
        dynamicDefinitions.set(definition.id, definition)
      }
    }

    const runtimeRecords = new Map<string, CronRuntimeRecord>()
    try {
      const raw = await readFile(storePath, 'utf-8')
      const data = JSON.parse(raw) as {
        schemaVersion?: unknown
        jobs?: unknown
      }
      if (Array.isArray(data.jobs)) {
        if (data.schemaVersion === CRON_RUNTIME_STATE_SCHEMA) {
          for (const item of data.jobs) {
            const record = parseRuntimeRecord(item)
            if (record) runtimeRecords.set(record.id, record)
          }
        } else {
          // Additive compatibility: import the legacy full-job store once.
          for (const item of data.jobs) {
            const legacy = parseLegacyJob(item)
            if (!legacy) continue
            runtimeRecords.set(legacy.id, runtimeRecordFromJob(legacy))
            if (!staticDefinitionIds.has(legacy.id)) {
              dynamicDefinitions.set(legacy.id, definitionFromJob(legacy))
            }
          }
        }
      }
    } catch (err: unknown) {
      if (!(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
        throw err
      }
    }

    const allDefinitions = [
      ...staticDefinitions,
      ...[...dynamicDefinitions.values()].filter(
        (definition) => !staticDefinitionIds.has(definition.id),
      ),
    ]
    const knownIds = new Set(allDefinitions.map((definition) => definition.id))
    orphanedRuntimeRecords = [...runtimeRecords.values()].filter(
      (record) => !knownIds.has(record.id),
    )
    jobs = allDefinitions.map((definition) => {
      const runtime = runtimeRecords.get(definition.id)
      const enabled = definition.forcedDisabled
        ? false
        : runtime?.enabled ?? definition.enabled
      const state = runtime?.state ?? initialRuntimeState(
        definition.schedule,
        enabled,
        now(),
      )
      if (definition.forcedDisabled) {
        state.nextRunAtMs = null
        state.pauseReason = definition.forcedDisabledReason ?? null
      }
      return normalizeLoadedJob({
        id: definition.id,
        name: definition.name,
        enabled,
        kind: definition.kind,
        schedule: definition.schedule,
        payload: definition.payload,
        script: definition.script,
        retryPolicy: definition.retryPolicy,
        state,
        createdAt: runtime?.createdAt ?? now(),
      })
    })
  }

  async function saveManaged(): Promise<void> {
    await mkdir(dirname(storePath), { recursive: true })
    const records = [
      ...jobs.map(runtimeRecordFromJob),
      ...orphanedRuntimeRecords.filter(
        (record) => !jobs.some((job) => job.id === record.id),
      ),
    ]
    const document = {
      schemaVersion: CRON_RUNTIME_STATE_SCHEMA,
      schedulerOwner: 'openalice_cron_engine',
      jobs: records,
    }
    const tmp = `${storePath}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf-8')
    await rename(tmp, storePath)

    await mkdir(dirname(dynamicDefinitionPath), { recursive: true })
    const dynamicDocument = {
      schemaVersion: CRON_DYNAMIC_DEFINITION_SCHEMA,
      definitions: [...dynamicDefinitions.values()]
        .filter((definition) => !staticDefinitionIds.has(definition.id))
        .map(serializeDefinition),
    }
    const dynamicTmp = `${dynamicDefinitionPath}.${process.pid}.tmp`
    await writeFile(
      dynamicTmp,
      `${JSON.stringify(dynamicDocument, null, 2)}\n`,
      'utf-8',
    )
    await rename(dynamicTmp, dynamicDefinitionPath)
  }

  async function saveQueued(): Promise<void> {
    const run = saveChain.then(() => save())
    saveChain = run.catch(() => undefined)
    return run
  }

  async function mergeExternallyInstalledJobs(currentJobs: CronJob[]): Promise<CronJob[]> {
    let persistedJobs: CronJob[]
    try {
      const raw = await readFile(storePath, 'utf-8')
      const data = JSON.parse(raw) as { jobs?: unknown }
      persistedJobs = Array.isArray(data.jobs) ? data.jobs as CronJob[] : []
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return currentJobs
      }
      throw err
    }

    const currentIds = new Set(currentJobs.map(job => job.id))
    const currentNames = new Set(currentJobs.map(job => job.name))
    const merged = [...currentJobs]
    for (const persisted of persistedJobs) {
      if (!persisted || typeof persisted.id !== 'string' || typeof persisted.name !== 'string') continue
      if (removedJobIds.has(persisted.id) || removedJobNames.has(persisted.name)) continue
      if (currentIds.has(persisted.id) || currentNames.has(persisted.name)) continue
      merged.push(persisted)
      currentIds.add(persisted.id)
      currentNames.add(persisted.name)
    }
    return merged
  }

  // ---------- timer ----------

  function armTimer(): void {
    if (stopped) return

    const nextMs = jobs
      .filter((j) => j.enabled && j.state.circuitOpenedAtMs == null && j.state.nextRunAtMs !== null)
      .reduce<number | null>((min, j) => {
        const n = j.state.nextRunAtMs!
        return min === null ? n : Math.min(min, n)
      }, null)

    if (nextMs === null) return

    // Clamp to 60s to prevent long setTimeout drift
    const delayMs = Math.max(0, Math.min(nextMs - now(), 60_000))
    timer = setTimeout(onTick, delayMs)
  }

  async function onTick(): Promise<void> {
    timer = null
    if (stopped) return

    const currentMs = now()
    const dueJobs = jobs.filter(
      (j) => j.enabled && j.state.circuitOpenedAtMs == null && j.state.nextRunAtMs !== null && j.state.nextRunAtMs <= currentMs,
    )

    for (const job of dueJobs) {
      await fireJob(job, currentMs)
    }

    if (!stopped) {
      await saveQueued()
      armTimer()
    }
  }

  async function fireJob(job: CronJob, currentMs: number): Promise<void> {
    const retryPolicy = normalizeRetryPolicy(job.retryPolicy)
    const notificationState: NonNullable<CronFirePayload['notificationState']> = {
      previousConsecutiveErrors: job.state.consecutiveErrors,
      previousErrorFingerprint: job.state.lastErrorFingerprint ?? null,
      circuitOpenAfter: retryPolicy.circuitOpenAfter,
    }
    job.state.lastRunAtMs = currentMs
    job.state.lastStatus = 'fired'
    let fireAppendFailed = false

    try {
      await eventLog.append('cron.fire', {
        jobId: job.id,
        jobName: job.name,
        kind: job.kind ?? 'agent',
        payload: job.payload,
        script: job.script,
        notificationState,
        pipelineContext: pipelineContextsByJobId.get(job.id),
      } satisfies CronFirePayload)
    } catch (err) {
      job.state.lastStatus = 'error'
      job.state.consecutiveErrors += 1
      fireAppendFailed = true
    }

    // Compute next run
    if (job.schedule.kind === 'at') {
      // One-shot — disable after execution
      job.enabled = false
      job.state.nextRunAtMs = null
    } else if (fireAppendFailed || job.state.lastStatus === 'error') {
      scheduleAfterFailure(job, currentMs, { permanent: false })
    } else {
      job.state.nextRunAtMs = computeNextRun(job.schedule, currentMs)
    }
  }

  function subscribeCompletionEvents(): void {
    if (completionUnsubscribers.length > 0) return
    const onDone = eventLog.subscribeType('cron.done', (entry) => {
      void handleCompletionEvent(entry, 'ok')
    })
    const onError = eventLog.subscribeType('cron.error', (entry) => {
      void handleCompletionEvent(entry, 'error')
    })
    const onDropped = eventLog.subscribeType('cron.dropped', (entry) => {
      void handleCompletionEvent(entry, 'error')
    })
    completionUnsubscribers = [onDone, onError, onDropped]
  }

  async function handleCompletionEvent(entry: EventLogEntry, status: 'ok' | 'error'): Promise<void> {
    const payload = entry.payload as {
      jobId?: unknown
      errorClass?: unknown
      permanent?: unknown
      errorFingerprint?: unknown
    }
    const jobId = typeof payload?.jobId === 'string' ? payload.jobId : null
    if (!jobId) return

    const job = jobs.find((j) => j.id === jobId)
    if (!job) return
    if (job.state.lastRunAtMs !== null && entry.ts < job.state.lastRunAtMs) return

    if (status === 'ok') {
      job.state.lastStatus = 'ok'
      job.state.consecutiveErrors = 0
      job.state.lastSuccessAtMs = entry.ts
      job.state.circuitOpenedAtMs = null
      job.state.lastErrorClass = null
      job.state.lastErrorFingerprint = null
      if (job.enabled && job.schedule.kind !== 'at') {
        job.state.nextRunAtMs = computeNextRun(job.schedule, entry.ts)
      }
    } else {
      job.state.lastStatus = 'error'
      job.state.consecutiveErrors += 1
      job.state.lastErrorClass = typeof payload.errorClass === 'string' ? payload.errorClass : 'execution_error'
      job.state.lastErrorFingerprint = typeof payload.errorFingerprint === 'string' ? payload.errorFingerprint : null
      if (job.enabled && job.schedule.kind !== 'at') {
        scheduleAfterFailure(job, entry.ts, { permanent: payload.permanent === true })
        if (timer) { clearTimeout(timer); timer = null }
        armTimer()
      }
    }

    try {
      await saveQueued()
    } catch {
      // Completion state is still updated in memory; the next explicit save will retry persistence.
    }
  }

  subscribeCompletionEvents()

  // ---------- public ----------

  return {
    async start() {
      await load()

      const currentMs = now()
      for (const job of jobs) {
        if (!job.enabled) continue
        if (job.state.circuitOpenedAtMs != null) {
          job.state.lastStatus = 'blocked'
          job.state.nextRunAtMs = null
          continue
        }
        if (job.state.lastStatus === 'fired') {
          // Any in-flight attempt was interrupted by the process restart.
          // Script jobs resume on their next normal schedule; recoverable agent
          // jobs may subsequently replace this state when the listener replays
          // only their latest fire. Preserve the prior success timestamp while
          // making the interrupted attempt explicit to health consumers.
          job.state.lastStatus = 'blocked'
          job.state.lastErrorClass = 'interrupted_restart'
        }
        if (job.state.nextRunAtMs === null || job.state.nextRunAtMs < currentMs) {
          job.state.nextRunAtMs = computeNextRun(job.schedule, currentMs)
          if (job.schedule.kind === 'at' && job.state.nextRunAtMs === null) {
            job.enabled = false
          }
        }
      }

      await saveQueued()
      armTimer()
    },

    stop() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
      for (const unsubscribe of completionUnsubscribers) unsubscribe()
      completionUnsubscribers = []
    },

    async add(params) {
      if (managedDefinitions && (params.kind === 'script' || params.script)) {
        throw new Error(
          'managed Cron engine accepts new agent jobs only; script definitions require registry review',
        )
      }
      const id = randomUUID().slice(0, 8)
      const currentMs = now()

      const job: CronJob = {
        id,
        name: params.name,
        enabled: params.enabled ?? true,
        kind: params.kind ?? 'agent',
        schedule: params.schedule,
        payload: params.payload,
        script: params.script,
        retryPolicy: normalizeRetryPolicy(params.retryPolicy),
        state: {
          nextRunAtMs: params.enabled === false ? null : computeNextRun(params.schedule, currentMs),
          lastRunAtMs: null,
          lastStatus: null,
          consecutiveErrors: 0,
          lastSuccessAtMs: null,
          circuitOpenedAtMs: null,
          lastErrorClass: null,
          lastErrorFingerprint: null,
        },
        createdAt: currentMs,
      }

      jobs.push(job)
      if (managedDefinitions) {
        dynamicDefinitions.set(job.id, definitionFromJob(job))
      }
      removedJobIds.delete(job.id)
      removedJobNames.delete(job.name)
      await saveQueued()

      // Re-arm in case this job is sooner
      if (timer) { clearTimeout(timer); timer = null }
      armTimer()

      return id
    },

    async update(id, patch) {
      const job = jobs.find((j) => j.id === id)
      if (!job) throw new Error(`cron job not found: ${id}`)
      if (
        managedDefinitions
        && staticDefinitionIds.has(id)
        && (
          patch.name !== undefined
          || patch.payload !== undefined
          || patch.kind !== undefined
          || patch.script !== undefined
          || patch.schedule !== undefined
          || patch.retryPolicy !== undefined
        )
      ) {
        throw new Error(`managed Cron definition is immutable: ${id}`)
      }
      if (
        job.state.circuitOpenedAtMs != null
        && (patch.enabled === true || patch.schedule !== undefined)
      ) {
        throw new Error(
          `cron circuit for ${id} requires a commit-bound operator receipt`,
        )
      }
      if (forcedDisabledIds.has(id) && patch.enabled === true) {
        throw new Error(`cron job ${id} is declaratively blocked and cannot be enabled`)
      }
      const wasEnabled = job.enabled

      if (patch.name !== undefined) job.name = patch.name
      if (patch.payload !== undefined) job.payload = patch.payload
      if (patch.kind !== undefined) job.kind = patch.kind
      if (patch.script !== undefined) job.script = patch.script
      if (patch.enabled !== undefined) job.enabled = patch.enabled
      if (patch.retryPolicy !== undefined) job.retryPolicy = normalizeRetryPolicy(patch.retryPolicy)

      if (patch.schedule !== undefined) {
        job.schedule = patch.schedule
        job.state.nextRunAtMs = computeNextRun(patch.schedule, now())
      } else if (patch.enabled === true && !wasEnabled) {
        job.state.nextRunAtMs = computeNextRun(job.schedule, now())
      } else if (patch.enabled === false) {
        job.state.nextRunAtMs = null
      }

      if (managedDefinitions && dynamicDefinitions.has(id)) {
        dynamicDefinitions.set(id, definitionFromJob(job))
      }
      await saveQueued()
      if (timer) { clearTimeout(timer); timer = null }
      armTimer()
    },

    async remove(id) {
      const idx = jobs.findIndex((j) => j.id === id)
      if (idx === -1) throw new Error(`cron job not found: ${id}`)
      if (managedDefinitions && staticDefinitionIds.has(id)) {
        throw new Error(`managed Cron definition cannot be removed: ${id}`)
      }
      removedJobIds.add(jobs[idx].id)
      removedJobNames.add(jobs[idx].name)
      dynamicDefinitions.delete(jobs[idx].id)
      jobs.splice(idx, 1)
      await saveQueued()
    },

    list() {
      return [...jobs]
    },

    async runNow(id) {
      const job = jobs.find((j) => j.id === id)
      if (!job) throw new Error(`cron job not found: ${id}`)
      await fireJob(job, now())
      await saveQueued()
    },

    get(id) {
      return jobs.find((j) => j.id === id)
    },
  }
}

// ==================== Schedule Helpers ====================

export function computeNextRun(schedule: CronSchedule, afterMs: number): number | null {
  switch (schedule.kind) {
    case 'at': {
      const t = new Date(schedule.at).getTime()
      return Number.isNaN(t) ? null : (t > afterMs ? t : null)
    }
    case 'every': {
      const ms = parseDuration(schedule.every)
      return ms ? afterMs + ms : null
    }
    case 'cron':
      return nextCronFire(schedule.cron, afterMs, schedule.timezone)
  }
}

export function parseDuration(s: string): number | null {
  const re = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/
  const m = re.exec(s.trim())
  if (!m) return null
  const h = Number(m[1] ?? 0)
  const min = Number(m[2] ?? 0)
  const sec = Number(m[3] ?? 0)
  if (h === 0 && min === 0 && sec === 0) return null
  return (h * 3600 + min * 60 + sec) * 1000
}

/**
 * Minimal cron expression parser (minute hour dom month dow).
 * Returns the next fire time after `afterMs`, or null if unparseable.
 */
export function nextCronFire(expr: string, afterMs: number, timezone: 'local' | 'UTC' = 'local'): number | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const fields = [
    parseFieldValues(parts[0], 0, 59),
    parseFieldValues(parts[1], 0, 23),
    parseFieldValues(parts[2], 1, 31),
    parseFieldValues(parts[3], 1, 12),
    parseFieldValues(parts[4], 0, 6),
  ]
  if (fields.some((f) => f === null)) return null

  const [minutes, hours, doms, months, dows] = fields as number[][]

  const start = new Date(afterMs)
  if (timezone === 'UTC') {
    start.setUTCSeconds(0, 0)
    start.setUTCMinutes(start.getUTCMinutes() + 1)
  } else {
    start.setSeconds(0, 0)
    start.setMinutes(start.getMinutes() + 1)
  }

  const limit = afterMs + 366 * 24 * 60 * 60 * 1000
  const cursor = new Date(start)

  while (cursor.getTime() < limit) {
    const parts = cronDateParts(cursor, timezone)
    if (
      months.includes(parts.month) &&
      doms.includes(parts.dayOfMonth) &&
      dows.includes(parts.dayOfWeek) &&
      hours.includes(parts.hour) &&
      minutes.includes(parts.minute)
    ) {
      return cursor.getTime()
    }
    if (timezone === 'UTC') {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
    } else {
      cursor.setMinutes(cursor.getMinutes() + 1)
    }
  }

  return null
}

function cronDateParts(date: Date, timezone: 'local' | 'UTC'): {
  month: number
  dayOfMonth: number
  dayOfWeek: number
  hour: number
  minute: number
} {
  if (timezone === 'UTC') {
    return {
      month: date.getUTCMonth() + 1,
      dayOfMonth: date.getUTCDate(),
      dayOfWeek: date.getUTCDay(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    }
  }
  return {
    month: date.getMonth() + 1,
    dayOfMonth: date.getDate(),
    dayOfWeek: date.getDay(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  }
}

function parseFieldValues(field: string, min: number, max: number): number[] | null {
  const result: number[] = []

  for (const part of field.split(',')) {
    const stepMatch = /^(\*|\d+-\d+)\/(\d+)$/.exec(part)
    if (stepMatch) {
      const step = parseBoundedInteger(stepMatch[2], 1, max - min + 1)
      if (step === null) return null
      let start: number
      let end: number
      if (stepMatch[1] === '*') {
        start = min
        end = max
      } else {
        const [aRaw, bRaw] = stepMatch[1].split('-')
        const a = parseBoundedInteger(aRaw, min, max)
        const b = parseBoundedInteger(bRaw, min, max)
        if (a === null || b === null || a > b) return null
        start = a; end = b
      }
      for (let i = start; i <= end; i += step) result.push(i)
      continue
    }

    const rangeMatch = /^(\d+)-(\d+)$/.exec(part)
    if (rangeMatch) {
      const a = parseBoundedInteger(rangeMatch[1], min, max)
      const b = parseBoundedInteger(rangeMatch[2], min, max)
      if (a === null || b === null || a > b) return null
      for (let i = a; i <= b; i++) result.push(i)
      continue
    }

    if (part === '*') {
      for (let i = min; i <= max; i++) result.push(i)
      continue
    }

    const n = parseBoundedInteger(part, min, max)
    if (n === null) return null
    result.push(n)
  }

  return result.length > 0 ? result : null
}

function parseBoundedInteger(value: string | undefined, min: number, max: number): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) return null
  return n
}

// ==================== Error Backoff ====================

const ERROR_BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const

function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1)
  return ERROR_BACKOFF_MS[Math.max(0, idx)]
}

const DEFAULT_RETRY_POLICY: CronRetryPolicy = {
  mode: 'next-schedule',
  maxAttempts: 0,
  circuitOpenAfter: 0,
}

function normalizeRetryPolicy(policy: CronRetryPolicy | undefined): CronRetryPolicy {
  if (!policy) return { ...DEFAULT_RETRY_POLICY }
  return {
    mode: policy.mode === 'bounded-backoff' ? 'bounded-backoff' : 'next-schedule',
    maxAttempts: Math.max(0, Math.floor(policy.maxAttempts ?? 0)),
    circuitOpenAfter: Math.max(0, Math.floor(policy.circuitOpenAfter ?? 0)),
  }
}

function normalizeLoadedJob(job: CronJob): CronJob {
  return {
    ...job,
    retryPolicy: normalizeRetryPolicy(job.retryPolicy),
    state: {
      ...job.state,
      lastSuccessAtMs: job.state.lastSuccessAtMs ?? (job.state.lastStatus === 'ok' ? job.state.lastRunAtMs : null),
      circuitOpenedAtMs: job.state.circuitOpenedAtMs ?? null,
      lastErrorClass: job.state.lastErrorClass ?? null,
      lastErrorFingerprint: job.state.lastErrorFingerprint ?? null,
      pauseReason: job.state.pauseReason ?? null,
    },
  }
}

function initialRuntimeState(
  schedule: CronSchedule,
  enabled: boolean,
  currentMs: number,
): CronJobState {
  return {
    nextRunAtMs: enabled ? computeNextRun(schedule, currentMs) : null,
    lastRunAtMs: null,
    lastStatus: null,
    consecutiveErrors: 0,
    lastSuccessAtMs: null,
    circuitOpenedAtMs: null,
    lastErrorClass: null,
    lastErrorFingerprint: null,
    pauseReason: null,
  }
}

function runtimeRecordFromJob(job: CronJob): CronRuntimeRecord {
  return {
    id: job.id,
    enabled: job.enabled,
    state: { ...job.state },
    createdAt: job.createdAt,
  }
}

function definitionFromJob(job: CronJob): CronJobDefinition {
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled,
    kind: job.kind ?? 'agent',
    schedule: job.schedule,
    payload: job.payload,
    script: job.script,
    retryPolicy: normalizeRetryPolicy(job.retryPolicy),
  }
}

function serializeDefinition(definition: CronJobDefinition): Record<string, unknown> {
  return {
    id: definition.id,
    name: definition.name,
    enabled: definition.enabled,
    kind: definition.kind,
    schedule: definition.schedule,
    payload: definition.payload,
    script: definition.script,
    retryPolicy: normalizeRetryPolicy(definition.retryPolicy),
  }
}

function parseRuntimeRecord(value: unknown): CronRuntimeRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (
    typeof raw.id !== 'string'
    || typeof raw.enabled !== 'boolean'
    || typeof raw.createdAt !== 'number'
    || !raw.state
    || typeof raw.state !== 'object'
  ) {
    return null
  }
  const state = raw.state as Partial<CronJobState>
  if (
    !('nextRunAtMs' in state)
    || !('lastRunAtMs' in state)
    || !('lastStatus' in state)
    || typeof state.consecutiveErrors !== 'number'
  ) {
    return null
  }
  return {
    id: raw.id,
    enabled: raw.enabled,
    createdAt: raw.createdAt,
    state: state as CronJobState,
  }
}

function parseLegacyJob(value: unknown): CronJob | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<CronJob>
  if (
    typeof raw.id !== 'string'
    || typeof raw.name !== 'string'
    || typeof raw.enabled !== 'boolean'
    || !isCronSchedule(raw.schedule)
    || typeof raw.payload !== 'string'
    || !raw.state
    || typeof raw.createdAt !== 'number'
  ) {
    return null
  }
  return normalizeLoadedJob(raw as CronJob)
}

async function readDefinitionRegistry(path: string): Promise<CronJobDefinition[]> {
  const raw = JSON.parse(await readFile(path, 'utf-8')) as {
    schemaVersion?: unknown
    jobs?: unknown
  }
  if (
    raw.schemaVersion !== CRON_DEFINITION_REGISTRY_SCHEMA
    || !Array.isArray(raw.jobs)
  ) {
    throw new Error(`invalid Cron definition registry: ${path}`)
  }
  const definitions: CronJobDefinition[] = []
  const ids = new Set<string>()
  for (const value of raw.jobs) {
    if (!value || typeof value !== 'object') {
      throw new Error(`invalid Cron definition in ${path}`)
    }
    const item = value as Record<string, unknown>
    const id = item.id
    const name = item.name
    const schedule = item.schedule
    const kind: CronJobKind = item.kind === 'script' ? 'script' : 'agent'
    if (
      typeof id !== 'string'
      || !id
      || ids.has(id)
      || typeof name !== 'string'
      || !name
      || !isCronSchedule(schedule)
    ) {
      throw new Error(`invalid or duplicate Cron definition in ${path}: ${String(id)}`)
    }
    ids.add(id)
    const entrypoint = typeof item.entrypoint === 'string' ? item.entrypoint : undefined
    const args = Array.isArray(item.args)
      ? item.args.filter((arg): arg is string => typeof arg === 'string')
      : undefined
    const initialState = typeof item.initialState === 'string'
      ? item.initialState
      : 'scheduled'
    definitions.push({
      id,
      name,
      enabled: item.enabled === true,
      kind,
      schedule,
      payload: typeof item.payload === 'string' ? item.payload : '',
      script: entrypoint
        ? {
            path: entrypoint,
            args,
            cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
            notificationPath: typeof item.notificationArtifact === 'string'
              ? item.notificationArtifact
              : undefined,
          }
        : undefined,
      retryPolicy: parseRetryPolicy(item.retryPolicy),
      forcedDisabled:
        initialState === 'paused_external_dependency'
        || initialState === 'disabled_pending_independent_evidence',
      forcedDisabledReason:
        initialState === 'paused_external_dependency'
        || initialState === 'disabled_pending_independent_evidence'
          ? initialState
          : undefined,
    })
  }
  return definitions
}

async function readPipelineRegistry(path: string): Promise<Map<string, PipelineRunContextV1>> {
  const rawBytes = await readFile(path)
  const raw = JSON.parse(rawBytes.toString('utf8')) as {
    schemaVersion?: unknown
    entries?: unknown
  }
  if (raw.schemaVersion !== 'pipeline_registry.v1' || !Array.isArray(raw.entries)) {
    throw new Error(`invalid pipeline registry: ${path}`)
  }
  const registryHash = createHash('sha256').update(rawBytes).digest('hex')
  const contexts = new Map<string, PipelineRunContextV1>()
  const ids = new Set<string>()
  for (const value of raw.entries) {
    if (!value || typeof value !== 'object') {
      throw new Error(`invalid pipeline registry entry: ${path}`)
    }
    const item = value as Record<string, unknown>
    const entrypoint = item.entrypoint
    const registryEntryId = item.id
    if (
      typeof entrypoint !== 'string'
      || typeof registryEntryId !== 'string'
      || contexts.has(entrypoint)
      || ids.has(registryEntryId)
    ) {
      throw new Error(`invalid or duplicate pipeline registry entry: ${String(entrypoint)}`)
    }
    ids.add(registryEntryId)
    contexts.set(entrypoint, pipelineRunContextV1Schema.parse({
      schemaVersion: 'pipeline_run_context.v1',
      registryHash,
      registryEntryId,
      entrypoint,
      owner: item.owner,
      safetyLevel: item.safetyLevel,
      networkPolicy: item.networkPolicy,
      timeoutSeconds: item.timeoutSeconds,
      lock: item.lock,
      inputs: item.inputs,
      outputs: item.outputs,
    }))
  }
  return contexts
}

async function readDynamicDefinitions(path: string): Promise<CronJobDefinition[]> {
  let raw: { schemaVersion?: unknown; definitions?: unknown }
  try {
    raw = JSON.parse(await readFile(path, 'utf-8')) as typeof raw
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
  if (
    raw.schemaVersion !== CRON_DYNAMIC_DEFINITION_SCHEMA
    || !Array.isArray(raw.definitions)
  ) {
    throw new Error(`invalid dynamic Cron definition registry: ${path}`)
  }
  return raw.definitions.map((value) => {
    if (!value || typeof value !== 'object') {
      throw new Error(`invalid dynamic Cron definition in ${path}`)
    }
    const item = value as Record<string, unknown>
    if (
      typeof item.id !== 'string'
      || typeof item.name !== 'string'
      || typeof item.enabled !== 'boolean'
      || !isCronSchedule(item.schedule)
      || typeof item.payload !== 'string'
    ) {
      throw new Error(`invalid dynamic Cron definition in ${path}`)
    }
    return {
      id: item.id,
      name: item.name,
      enabled: item.enabled,
      kind: item.kind === 'script' ? 'script' : 'agent',
      schedule: item.schedule,
      payload: item.payload,
      script: parseScriptSpec(item.script),
      retryPolicy: parseRetryPolicy(item.retryPolicy),
    }
  })
}

function isCronSchedule(value: unknown): value is CronSchedule {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  if (raw.kind === 'at') return typeof raw.at === 'string'
  if (raw.kind === 'every') return typeof raw.every === 'string'
  if (raw.kind === 'cron') {
    return (
      typeof raw.cron === 'string'
      && (
        raw.timezone === undefined
        || raw.timezone === 'local'
        || raw.timezone === 'UTC'
      )
    )
  }
  return false
}

function parseRetryPolicy(value: unknown): CronRetryPolicy {
  if (!value || typeof value !== 'object') return { ...DEFAULT_RETRY_POLICY }
  return normalizeRetryPolicy(value as CronRetryPolicy)
}

function parseScriptSpec(value: unknown): CronScriptSpec | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.path !== 'string') return undefined
  return {
    path: raw.path,
    args: Array.isArray(raw.args)
      ? raw.args.filter((arg): arg is string => typeof arg === 'string')
      : undefined,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    notificationPath: typeof raw.notificationPath === 'string'
      ? raw.notificationPath
      : undefined,
  }
}

function scheduleAfterFailure(
  job: CronJob,
  failedAtMs: number,
  options: { permanent: boolean },
): void {
  const policy = normalizeRetryPolicy(job.retryPolicy)
  if (policy.circuitOpenAfter > 0 && job.state.consecutiveErrors >= policy.circuitOpenAfter) {
    job.state.lastStatus = 'blocked'
    job.state.circuitOpenedAtMs = failedAtMs
    job.state.nextRunAtMs = null
    return
  }

  const mayRetry =
    !options.permanent &&
    policy.mode === 'bounded-backoff' &&
    job.state.consecutiveErrors <= policy.maxAttempts

  job.state.nextRunAtMs = mayRetry
    ? failedAtMs + errorBackoffMs(job.state.consecutiveErrors)
    : computeNextRun(job.schedule, failedAtMs)
}
