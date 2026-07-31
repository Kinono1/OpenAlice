import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  computeNextRun,
  type CronJob,
  type CronRetryPolicy,
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
  scriptArgs: string[]
  notificationPath: string
  retryPolicy?: CronRetryPolicy
  dryRun: boolean
}

export interface OpenAliceScriptCronSpec {
  jobName: string
  cronExpr: string
  approvedScript: string
  args?: string[]
  notificationPath: string
  timezone?: 'local' | 'UTC'
  enabled?: boolean
  retryPolicy?: CronRetryPolicy
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
    retryPolicy: { mode: 'bounded-backoff', maxAttempts: 2, circuitOpenAfter: 3 },
  },
  p1_trading_evidence_hourly: {
    jobName: 'p1_trading_evidence_hourly',
    cronExpr: '18 * * * *',
    approvedScript: 'scripts/cron_p1_trading_evidence.sh',
    notificationPath: 'data/runtime/p1_trading_evidence_notification.json',
  },
  okx_public_1h_accumulate_hourly: {
    jobName: 'okx_public_1h_accumulate_hourly',
    cronExpr: '3 * * * *',
    approvedScript: 'scripts/cron_openalice_task.sh',
    args: ['accumulate_live_data'],
    notificationPath: 'data/runtime/cron_openalice_task/accumulate_live_data_notification.json',
  },
  okx_public_5m_accumulate_5m: {
    jobName: 'okx_public_5m_accumulate_5m',
    cronExpr: '0-59/5 * * * *',
    approvedScript: 'scripts/cron_openalice_task.sh',
    args: ['accumulate_5m_data'],
    notificationPath: 'data/runtime/cron_openalice_task/accumulate_5m_data_notification.json',
  },
  okx_public_1s_accumulate_5m: {
    jobName: 'okx_public_1s_accumulate_5m',
    cronExpr: '1-59/5 * * * *',
    approvedScript: 'scripts/cron_openalice_task.sh',
    args: ['accumulate_1s_data'],
    notificationPath: 'data/runtime/cron_openalice_task/accumulate_1s_data_notification.json',
  },
  okx_public_freshness_audit_5m: {
    jobName: 'okx_public_freshness_audit_5m',
    cronExpr: '2-59/5 * * * *',
    approvedScript: 'scripts/cron_openalice_task.sh',
    args: ['live_data_freshness_audit'],
    notificationPath: 'data/runtime/cron_openalice_task/live_data_freshness_audit_notification.json',
  },
  runtime_fee_auth_tick_4h: {
    jobName: 'runtime_fee_auth_tick_4h',
    cronExpr: '11 */4 * * *',
    approvedScript: 'scripts/cron_openalice_task.sh',
    args: ['runtime_fee_auth_tick'],
    notificationPath: 'data/runtime/cron_openalice_task/runtime_fee_auth_tick_notification.json',
  },
  prospective_evidence_tick_hourly: {
    jobName: 'prospective_evidence_tick_hourly',
    cronExpr: '9 * * * *',
    approvedScript: 'scripts/cron_openalice_task.sh',
    args: ['prospective_evidence_tick'],
    notificationPath: 'data/runtime/cron_openalice_task/prospective_evidence_tick_notification.json',
  },
  market_intel_refresh_15m: {
    jobName: 'market_intel_refresh_15m',
    cronExpr: '*/15 * * * *',
    approvedScript: 'scripts/cron_openalice_task.sh',
    args: ['refresh_market_intel_context'],
    notificationPath: 'data/runtime/cron_openalice_task/refresh_market_intel_context_notification.json',
  },
  low_vol_research_daily: {
    jobName: 'low_vol_research_daily',
    cronExpr: '0 2 * * *',
    approvedScript: 'scripts/cron_low_vol_research.sh',
    notificationPath: 'data/runtime/low_vol_research_daily_notification.json',
  },
  gated_improvement_candidate_daily: {
    jobName: 'gated_improvement_candidate_daily',
    cronExpr: '30 3 * * *',
    approvedScript: 'scripts/cron_gated_improvement_candidate.sh',
    notificationPath: 'data/runtime/gated_improvement_notification.json',
    enabled: false,
  },
  okx_instrument_master_refresh_15m: {
    jobName: 'okx_instrument_master_refresh_15m', cronExpr: '4,19,34,49 * * * *',
    approvedScript: 'scripts/cron_okx_warehouse_task.sh', args: ['instrument'],
    notificationPath: 'data/runtime/okx_warehouse/okx_instrument_master_refresh_notification.json',
    enabled: true, retryPolicy: { mode: 'bounded-backoff', maxAttempts: 2, circuitOpenAfter: 3 },
  },
  okx_public_fast_refresh_1m: {
    jobName: 'okx_public_fast_refresh_1m', cronExpr: '* * * * *',
    approvedScript: 'scripts/cron_okx_warehouse_task.sh', args: ['fast'],
    notificationPath: 'data/runtime/okx_warehouse/okx_public_fast_refresh_notification.json',
    enabled: true, retryPolicy: { mode: 'bounded-backoff', maxAttempts: 2, circuitOpenAfter: 3 },
  },
  okx_public_broad_refresh_5m: {
    jobName: 'okx_public_broad_refresh_5m', cronExpr: '1-59/5 * * * *',
    approvedScript: 'scripts/cron_okx_warehouse_task.sh', args: ['broad'],
    notificationPath: 'data/runtime/okx_warehouse/okx_public_broad_refresh_notification.json',
    enabled: true, retryPolicy: { mode: 'bounded-backoff', maxAttempts: 2, circuitOpenAfter: 3 },
  },
  okx_market_data_health_5m: {
    jobName: 'okx_market_data_health_5m', cronExpr: '3-59/5 * * * *',
    approvedScript: 'scripts/cron_okx_warehouse_task.sh', args: ['health'],
    notificationPath: 'data/runtime/okx_warehouse/okx_market_data_health_notification.json',
  },
  okx_warehouse_compact_hourly: {
    jobName: 'okx_warehouse_compact_hourly', cronExpr: '17 * * * *',
    approvedScript: 'scripts/cron_okx_warehouse_task.sh', args: ['compact'],
    notificationPath: 'data/runtime/okx_warehouse/okx_warehouse_compact_notification.json',
    enabled: true,
  },
  okx_depth_universe_daily: {
    jobName: 'okx_depth_universe_daily', cronExpr: '15 0 * * *', timezone: 'UTC',
    approvedScript: 'scripts/cron_okx_warehouse_task.sh', args: ['universe'],
    notificationPath: 'data/runtime/okx_warehouse/universe_notification.json',
    enabled: true,
  },
  okx_ssd_presence_archive_probe_15m: {
    jobName: 'okx_ssd_presence_archive_probe_15m', cronExpr: '7,22,37,52 * * * *',
    approvedScript: 'scripts/cron_okx_warehouse_task.sh', args: ['ssd_probe'],
    notificationPath: 'data/runtime/storage/ssd_archive_notification.json',
  },
  okx_ssd_weekly_reminder_sunday: {
    jobName: 'okx_ssd_weekly_reminder_sunday', cronExpr: '0 20 * * 0',
    approvedScript: 'scripts/cron_okx_warehouse_task.sh', args: ['ssd_reminder_weekly'],
    notificationPath: 'data/runtime/storage/ssd_reminder_notification.json',
  },
  okx_ssd_followup_reminder_mon_wed: {
    jobName: 'okx_ssd_followup_reminder_mon_wed', cronExpr: '0 20 * * 1-3',
    approvedScript: 'scripts/cron_okx_warehouse_task.sh', args: ['ssd_reminder_followup'],
    notificationPath: 'data/runtime/storage/ssd_reminder_notification.json',
  },
  okx_ssd_integrity_audit_weekly: {
    jobName: 'okx_ssd_integrity_audit_weekly', cronExpr: '30 22 * * 0',
    approvedScript: 'scripts/cron_okx_warehouse_task.sh', args: ['ssd_integrity'],
    notificationPath: 'data/runtime/okx_warehouse/ssd_integrity_notification.json',
  },
  okx_warehouse_retention_daily: {
    jobName: 'okx_warehouse_retention_daily', cronExpr: '35 4 * * *',
    approvedScript: 'scripts/cron_okx_warehouse_task.sh', args: ['retention'],
    notificationPath: 'data/runtime/storage/okx_warehouse_retention_notification.json',
  },
}

interface CronStore {
  jobs: CronJob[]
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.jobName === '__all__') {
    let updated = await loadCronStore(args.jobsPath)
    for (const preset of Object.values(OPENALICE_SCRIPT_CRON_SPECS)) {
      const timezone = preset.timezone ?? 'local'
      const schedule: CronSchedule = timezone === 'UTC'
        ? { kind: 'cron', cron: preset.cronExpr, timezone }
        : { kind: 'cron', cron: preset.cronExpr }
      updated = upsertCronJobStore(updated, {
        name: preset.jobName,
        schedule,
        payload: '',
        kind: 'script',
        script: buildEthCarryCronScript({
          repoRoot: args.repoRoot,
          approvedScript: resolve(preset.approvedScript),
          args: preset.args ?? [],
          notificationPath: resolve(preset.notificationPath),
        }),
        enabled: preset.enabled ?? true,
        retryPolicy: preset.retryPolicy,
        nowMs: Date.now(),
      })
    }
    if (args.dryRun) {
      console.log(JSON.stringify({ jobsPath: resolve(args.jobsPath), installedPresets: Object.keys(OPENALICE_SCRIPT_CRON_SPECS), jobCount: updated.jobs.length }, null, 2))
      return
    }
    await saveCronStore(args.jobsPath, updated)
    console.log(resolve(args.jobsPath))
    return
  }
  const script = buildEthCarryCronScript({
    repoRoot: args.repoRoot,
    approvedScript: args.approvedScript,
    args: args.scriptArgs,
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
    retryPolicy: args.retryPolicy,
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
    scriptArgs: parseStringListArg(raw.get('scriptArgs'), preset?.args ?? []),
    notificationPath:
      raw.get('notificationPath') ??
      resolve(preset?.notificationPath ?? 'data/runtime/eth_carry_status/eth_carry_actionability_notification.json'),
    retryPolicy: preset?.retryPolicy,
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

function parseStringListArg(raw: string | undefined, fallback: string[]): string[] {
  if (raw == null) return [...fallback]
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed) && parsed.every(value => typeof value === 'string')) {
      return parsed
    }
  } catch {
    // Fall back to comma-delimited script args for shell-friendly overrides.
  }
  return trimmed
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
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
  args?: string[]
  notificationPath: string
}): NonNullable<CronJob['script']> {
  return {
    path: resolve(input.approvedScript),
    args: input.args ?? [],
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
    retryPolicy?: CronRetryPolicy
    nowMs: number
  },
): CronStore {
  const matching = store.jobs.filter((job) => job.name === input.name)
  const existing = matching[0]
  const jobs = store.jobs.filter((job) => job.name !== input.name)
  const nextRunAtMs = input.enabled ? computeNextRun(input.schedule, input.nowMs) : null

  if (existing) {
    jobs.push({
      ...existing,
      enabled: input.enabled,
      kind: input.kind,
      schedule: input.schedule,
      payload: input.payload,
      script: input.script,
      retryPolicy: input.retryPolicy,
      state: {
        ...existing.state,
        nextRunAtMs,
        consecutiveErrors: 0,
        circuitOpenedAtMs: null,
        lastErrorClass: null,
      },
    })
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
    retryPolicy: input.retryPolicy,
    state: {
      nextRunAtMs,
      lastRunAtMs: null,
      lastStatus: null,
      consecutiveErrors: 0,
      lastSuccessAtMs: null,
      circuitOpenedAtMs: null,
      lastErrorClass: null,
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
