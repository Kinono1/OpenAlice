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
import { randomUUID } from 'node:crypto'
import type { EventLog, EventLogEntry } from '../../core/event-log.js'

// ==================== Types ====================

export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; every: string }
  | { kind: 'cron'; cron: string; timezone?: 'local' | 'UTC' }

export interface CronJobState {
  nextRunAtMs: number | null
  lastRunAtMs: number | null
  lastStatus: 'fired' | 'ok' | 'error' | null
  consecutiveErrors: number
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
  state: CronJobState
  createdAt: number
}

export interface CronFirePayload {
  jobId: string
  jobName: string
  kind?: CronJobKind
  payload: string
  script?: CronScriptSpec
}

// ==================== CRUD Types ====================

export interface CronJobCreate {
  name: string
  schedule: CronSchedule
  payload: string
  kind?: CronJobKind
  script?: CronScriptSpec
  enabled?: boolean
}

export interface CronJobPatch {
  name?: string
  schedule?: CronSchedule
  payload?: string
  kind?: CronJobKind
  script?: CronScriptSpec
  enabled?: boolean
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
  /** Inject clock for testing. */
  now?: () => number
}

// ==================== Factory ====================

export function createCronEngine(opts: CronEngineOpts): CronEngine {
  const { eventLog } = opts
  const storePath = opts.storePath ?? 'data/cron/jobs.json'
  const now = opts.now ?? Date.now

  let jobs: CronJob[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let completionUnsubscribers: Array<() => void> = []
  let saveChain: Promise<void> = Promise.resolve()
  const removedJobIds = new Set<string>()
  const removedJobNames = new Set<string>()

  // ---------- persistence ----------

  async function load(): Promise<void> {
    try {
      const raw = await readFile(storePath, 'utf-8')
      const data = JSON.parse(raw)
      jobs = Array.isArray(data.jobs) ? data.jobs : []
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        jobs = []
        return
      }
      throw err
    }
  }

  async function save(): Promise<void> {
    jobs = await mergeExternallyInstalledJobs(jobs)
    await mkdir(dirname(storePath), { recursive: true })
    const tmp = `${storePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ jobs }, null, 2), 'utf-8')
    await rename(tmp, storePath)
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
      .filter((j) => j.enabled && j.state.nextRunAtMs !== null)
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
      (j) => j.enabled && j.state.nextRunAtMs !== null && j.state.nextRunAtMs <= currentMs,
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
      job.state.nextRunAtMs = currentMs + errorBackoffMs(job.state.consecutiveErrors)
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
    const payload = entry.payload as { jobId?: unknown }
    const jobId = typeof payload?.jobId === 'string' ? payload.jobId : null
    if (!jobId) return

    const job = jobs.find((j) => j.id === jobId)
    if (!job) return
    if (job.state.lastRunAtMs !== null && entry.ts < job.state.lastRunAtMs) return

    if (status === 'ok') {
      job.state.lastStatus = 'ok'
      job.state.consecutiveErrors = 0
    } else {
      job.state.lastStatus = 'error'
      job.state.consecutiveErrors += 1
      if (job.enabled && job.schedule.kind !== 'at') {
        job.state.nextRunAtMs = entry.ts + errorBackoffMs(job.state.consecutiveErrors)
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
        state: {
          nextRunAtMs: computeNextRun(params.schedule, currentMs),
          lastRunAtMs: null,
          lastStatus: null,
          consecutiveErrors: 0,
        },
        createdAt: currentMs,
      }

      jobs.push(job)
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

      if (patch.name !== undefined) job.name = patch.name
      if (patch.payload !== undefined) job.payload = patch.payload
      if (patch.kind !== undefined) job.kind = patch.kind
      if (patch.script !== undefined) job.script = patch.script
      if (patch.enabled !== undefined) job.enabled = patch.enabled

      if (patch.schedule !== undefined) {
        job.schedule = patch.schedule
        job.state.nextRunAtMs = computeNextRun(patch.schedule, now())
        job.state.consecutiveErrors = 0
      }

      await saveQueued()
      if (timer) { clearTimeout(timer); timer = null }
      armTimer()
    },

    async remove(id) {
      const idx = jobs.findIndex((j) => j.id === id)
      if (idx === -1) throw new Error(`cron job not found: ${id}`)
      removedJobIds.add(jobs[idx].id)
      removedJobNames.add(jobs[idx].name)
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
