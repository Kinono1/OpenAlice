import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  computeNextRun,
  type CronJob,
  type CronSchedule,
} from '../src/task/cron/engine.js'

interface CliArgs {
  jobsPath: string
  jobName: string
  cronExpr: string
  timezone?: 'local' | 'UTC'
  enabled: boolean
  repoRoot: string
  approvedScript: string
  notificationPath: string
  dryRun: boolean
}

export interface OpenAliceScriptCronSpec {
  jobName: string
  cronExpr: string
  approvedScript: string
  notificationPath: string
  timezone?: 'local' | 'UTC'
  enabled?: boolean
}

export const OPENALICE_SCRIPT_CRON_SPECS: Record<string, OpenAliceScriptCronSpec> = {
  eth_carry_refresh_pipeline_daily: {
    jobName: 'eth_carry_refresh_pipeline_daily',
    cronExpr: '5 7 * * *',
    approvedScript: 'scripts/cron_eth_carry_refresh_pipeline.sh',
    notificationPath: 'data/runtime/eth_carry_status/eth_carry_actionability_notification.json',
  },
  paper_policy_shadow_settle_5m: {
    jobName: 'paper_policy_shadow_settle_5m',
    cronExpr: '2-59/5 * * * *',
    approvedScript: 'scripts/cron_paper_policy_shadow_settle.sh',
    notificationPath: 'data/runtime/paper_policy_shadow_settle_notification.json',
  },
  paper_policy_shadow_capture_5m: {
    jobName: 'paper_policy_shadow_capture_5m',
    cronExpr: '1-59/5 * * * *',
    approvedScript: 'scripts/cron_paper_policy_shadow_capture.sh',
    notificationPath: 'data/runtime/paper_policy_shadow_capture_notification.json',
  },
  paper_pnl_diagnostics_30m: {
    jobName: 'paper_pnl_diagnostics_30m',
    cronExpr: '4,34 * * * *',
    approvedScript: 'scripts/cron_paper_pnl_diagnostics.sh',
    notificationPath: 'data/runtime/paper_pnl_diagnostics_notification.json',
  },
  pro_policy_window_hourly: {
    jobName: 'pro_policy_window_hourly',
    cronExpr: '8 * * * *',
    approvedScript: 'scripts/cron_pro_policy_window.sh',
    notificationPath: 'data/runtime/pro_policy_window_notification.json',
  },
  microstructure_stoploss_replay_hourly: {
    jobName: 'microstructure_stoploss_replay_hourly',
    cronExpr: '12 * * * *',
    approvedScript: 'scripts/cron_microstructure_stoploss_replay.sh',
    notificationPath: 'data/runtime/microstructure_stoploss_replay_notification.json',
  },
  dirty_worktree_audit_daily: {
    jobName: 'dirty_worktree_audit_daily',
    cronExpr: '17 9 * * *',
    approvedScript: 'scripts/cron_dirty_worktree_audit.sh',
    notificationPath: 'data/runtime/dirty_worktree_audit_notification.json',
  },
  scheduler_security_audit_hourly: {
    jobName: 'scheduler_security_audit_hourly',
    cronExpr: '23 * * * *',
    approvedScript: 'scripts/cron_scheduler_security_audit.sh',
    notificationPath: 'data/runtime/scheduler_security_audit_notification.json',
  },
  external_derivatives_data_collect_8h: {
    jobName: 'external_derivatives_data_collect_8h',
    cronExpr: '7 */8 * * *',
    approvedScript: 'scripts/cron_external_derivatives_data_collect.sh',
    notificationPath: 'data/runtime/external_derivatives_data_collect_notification.json',
    timezone: 'UTC',
  },
  p1_trading_evidence_hourly: {
    jobName: 'p1_trading_evidence_hourly',
    cronExpr: '18 * * * *',
    approvedScript: 'scripts/cron_p1_trading_evidence.sh',
    notificationPath: 'data/runtime/p1_trading_evidence_notification.json',
  },
}

interface CronStore {
  jobs: CronJob[]
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const script = buildEthCarryCronScript({
    repoRoot: args.repoRoot,
    approvedScript: args.approvedScript,
    notificationPath: args.notificationPath,
  })
  const timezone = args.timezone ?? 'local'
  const schedule: CronSchedule = timezone === 'UTC'
    ? { kind: 'cron', cron: args.cronExpr, timezone }
    : { kind: 'cron', cron: args.cronExpr }
  const store = await loadCronStore(args.jobsPath)
  const updated = upsertCronJobStore(store, {
    name: args.jobName,
    schedule,
    payload: '',
    kind: 'script',
    script,
    enabled: args.enabled,
    nowMs: Date.now(),
  })

  if (args.dryRun) {
    console.log(JSON.stringify({
      jobsPath: resolve(args.jobsPath),
      updatedJob: updated.jobs.find((job) => job.name === args.jobName) ?? null,
      jobCount: updated.jobs.length,
    }, null, 2))
    return
  }

  await saveCronStore(args.jobsPath, updated)
  console.log(resolve(args.jobsPath))
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const presetName = raw.get('preset') ?? raw.get('jobName') ?? 'eth_carry_refresh_pipeline_daily'
  const preset = OPENALICE_SCRIPT_CRON_SPECS[presetName]
  return {
    jobsPath: raw.get('jobsPath') ?? 'data/cron/jobs.json',
    jobName: raw.get('jobName') ?? preset?.jobName ?? presetName,
    cronExpr: raw.get('cron') ?? preset?.cronExpr ?? '5 7 * * *',
    timezone: parseTimezoneArg(raw.get('timezone'), preset?.timezone),
    enabled: parseBoolArg(raw.get('enabled'), preset?.enabled ?? true),
    repoRoot: raw.get('repoRoot') ?? resolve('.'),
    approvedScript:
      raw.get('approvedScript') ??
      resolve(preset?.approvedScript ?? 'scripts/cron_eth_carry_refresh_pipeline.sh'),
    notificationPath:
      raw.get('notificationPath') ??
      resolve(preset?.notificationPath ?? 'data/runtime/eth_carry_status/eth_carry_actionability_notification.json'),
    dryRun: parseBoolArg(raw.get('dryRun'), false),
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    index += 1
  }
  return out
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function parseTimezoneArg(raw: string | undefined, fallback: 'local' | 'UTC' | undefined): 'local' | 'UTC' | undefined {
  const value = raw ?? fallback
  if (value === 'UTC' || value === 'local') return value
  return fallback
}

async function loadCronStore(path: string): Promise<CronStore> {
  try {
    const raw = JSON.parse(await readFile(resolve(path), 'utf-8')) as Partial<CronStore>
    return {
      jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
    }
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return { jobs: [] }
    }
    throw error
  }
}

async function saveCronStore(path: string, store: CronStore): Promise<void> {
  const filePath = resolve(path)
  const tempPath = `${filePath}.${process.pid}.tmp`
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8')
  await rename(tempPath, filePath)
}

function buildEthCarryCronScript(input: {
  repoRoot: string
  approvedScript: string
  notificationPath: string
}): NonNullable<CronJob['script']> {
  return {
    path: resolve(input.approvedScript),
    args: [],
    cwd: resolve(input.repoRoot),
    notificationPath: resolve(input.notificationPath),
  }
}

function upsertCronJobStore(
  store: CronStore,
  input: {
    name: string
    schedule: CronSchedule
    payload: string
    kind?: CronJob['kind']
    script?: CronJob['script']
    enabled: boolean
    nowMs: number
  },
): CronStore {
  const jobs = [...store.jobs]
  const existingIndex = jobs.findIndex((job) => job.name === input.name)
  const nextRunAtMs = input.enabled ? computeNextRun(input.schedule, input.nowMs) : null

  if (existingIndex >= 0) {
    const existing = jobs[existingIndex]
    jobs[existingIndex] = {
      ...existing,
      enabled: input.enabled,
      kind: input.kind,
      schedule: input.schedule,
      payload: input.payload,
      script: input.script,
      state: {
        ...existing.state,
        nextRunAtMs,
        consecutiveErrors: 0,
      },
    }
    return { jobs }
  }

  jobs.push({
    id: randomUUID().slice(0, 8),
    name: input.name,
    enabled: input.enabled,
    kind: input.kind,
    schedule: input.schedule,
    payload: input.payload,
    script: input.script,
    state: {
      nextRunAtMs,
      lastRunAtMs: null,
      lastStatus: null,
      consecutiveErrors: 0,
    },
    createdAt: input.nowMs,
  })
  return { jobs }
}

export {
  buildEthCarryCronScript,
  loadCronStore,
  saveCronStore,
  upsertCronJobStore,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
