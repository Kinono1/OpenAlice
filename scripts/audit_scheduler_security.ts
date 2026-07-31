import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SECRET_VALUE_RE = /(?:sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^/\s:@]+:[^/\s@]+@|socks5?:\/\/[^/\s:@]+:[^/\s@]+@)/g
const ENV_ASSIGNMENT_RE = /(?:^|\n)\s*(?:export\s+)?([A-Z0-9_]+)\s*=/g
const LAUNCHD_ENV_KEY_RE = /<key>([A-Z0-9_]+)<\/key>/g
const INTERNAL_CRON_JOBS_PATH = 'data/cron/jobs.json'
const EXTERNAL_DERIVATIVES_JOB_NAME = 'external_derivatives_data_collect_8h'
const EXTERNAL_DERIVATIVES_CRON_EXPR = '7 */8 * * *'
const EXTERNAL_DERIVATIVES_SCRIPT = 'scripts/cron_external_derivatives_data_collect.sh'
const OPENALICE_TASK_SCRIPT = 'scripts/cron_openalice_task.sh'
const OKX_WAREHOUSE_TASK_SCRIPT = 'scripts/cron_okx_warehouse_task.sh'
const RUNTIME_FEE_AUTH_JOB_NAME = 'runtime_fee_auth_tick_4h'
const OKX_ENV_KEYS = {
  apiKey: 'EXCHANGE_API_KEY',
  secret: 'EXCHANGE_API_SECRET',
  password: 'EXCHANGE_PASSWORD',
} as const
const CONNECTORS_CONFIG_PATH = 'data/config/connectors.json'
const OKX_MARKET_DATA_CONFIG_PATH = 'data/config/okx-market-data.json'
const DATA_ROOT = process.env.OPENALICE_DATA_ROOT ?? 'data'
const MAIN_LAUNCHD_LABEL = 'ai.openalice.main'
const RETIRED_LAUNCHD_LABELS = [
  'ai.openalice.okx-market-data',
  'ai.openalice.low-vol-observer',
  'ai.openalice.microstructure-stress',
  'ai.openalice.paper-monitor',
  'com.openalice.crypto.fast-binance-spot-klines',
] as const

interface RequiredInternalCronJobSpec {
  jobName: string
  cronExpr: string
  scriptPathSuffix: string
  args?: string[]
  timezone?: 'local' | 'UTC'
  checkPrefix: string
  enabled?: boolean
}

const REQUIRED_INTERNAL_CRON_JOBS: RequiredInternalCronJobSpec[] = [
  {
    jobName: 'eth_carry_refresh_pipeline_daily', cronExpr: '5 7 * * *',
    scriptPathSuffix: 'scripts/cron_eth_carry_refresh_pipeline.sh', checkPrefix: 'internal_eth_carry_refresh',
  },
  {
    jobName: 'paper_policy_shadow_settle_5m', cronExpr: '2-59/5 * * * *',
    scriptPathSuffix: 'scripts/cron_paper_policy_shadow_settle.sh', checkPrefix: 'internal_paper_policy_settle',
  },
  {
    jobName: 'paper_policy_shadow_capture_5m', cronExpr: '1-59/5 * * * *',
    scriptPathSuffix: 'scripts/cron_paper_policy_shadow_capture.sh', checkPrefix: 'internal_paper_policy_capture',
  },
  {
    jobName: 'paper_pnl_diagnostics_30m', cronExpr: '4,34 * * * *',
    scriptPathSuffix: 'scripts/cron_paper_pnl_diagnostics.sh', checkPrefix: 'internal_paper_pnl_diagnostics',
  },
  {
    jobName: 'pro_policy_window_hourly', cronExpr: '8 * * * *',
    scriptPathSuffix: 'scripts/cron_pro_policy_window.sh', checkPrefix: 'internal_pro_policy_window',
  },
  {
    jobName: 'microstructure_stoploss_replay_hourly', cronExpr: '12 * * * *',
    scriptPathSuffix: 'scripts/cron_microstructure_stoploss_replay.sh', checkPrefix: 'internal_stoploss_replay',
  },
  {
    jobName: 'dirty_worktree_audit_daily', cronExpr: '17 9 * * *',
    scriptPathSuffix: 'scripts/cron_dirty_worktree_audit.sh', checkPrefix: 'internal_dirty_worktree_audit',
  },
  {
    jobName: 'scheduler_security_audit_hourly', cronExpr: '23 * * * *',
    scriptPathSuffix: 'scripts/cron_scheduler_security_audit.sh', checkPrefix: 'internal_scheduler_security_audit',
  },
  {
    jobName: EXTERNAL_DERIVATIVES_JOB_NAME,
    cronExpr: EXTERNAL_DERIVATIVES_CRON_EXPR,
    scriptPathSuffix: EXTERNAL_DERIVATIVES_SCRIPT,
    args: [],
    timezone: 'UTC',
    checkPrefix: 'internal_external_derivatives',
  },
  {
    jobName: 'okx_public_1h_accumulate_hourly',
    cronExpr: '3 * * * *',
    scriptPathSuffix: OPENALICE_TASK_SCRIPT,
    args: ['accumulate_live_data'],
    checkPrefix: 'internal_okx_public_1h_accumulate',
  },
  {
    jobName: 'okx_public_5m_accumulate_5m',
    cronExpr: '0-59/5 * * * *',
    scriptPathSuffix: OPENALICE_TASK_SCRIPT,
    args: ['accumulate_5m_data'],
    checkPrefix: 'internal_okx_public_5m_accumulate',
  },
  {
    jobName: 'okx_public_1s_accumulate_5m',
    cronExpr: '1-59/5 * * * *',
    scriptPathSuffix: OPENALICE_TASK_SCRIPT,
    args: ['accumulate_1s_data'],
    checkPrefix: 'internal_okx_public_1s_accumulate',
  },
  {
    jobName: 'okx_public_freshness_audit_5m',
    cronExpr: '2-59/5 * * * *',
    scriptPathSuffix: OPENALICE_TASK_SCRIPT,
    args: ['live_data_freshness_audit'],
    checkPrefix: 'internal_okx_public_freshness_audit',
  },
  {
    jobName: RUNTIME_FEE_AUTH_JOB_NAME,
    cronExpr: '11 */4 * * *',
    scriptPathSuffix: OPENALICE_TASK_SCRIPT,
    args: ['runtime_fee_auth_tick'],
    checkPrefix: 'internal_runtime_fee_auth_tick',
  },
  {
    jobName: 'prospective_evidence_tick_hourly',
    cronExpr: '9 * * * *',
    scriptPathSuffix: OPENALICE_TASK_SCRIPT,
    args: ['prospective_evidence_tick'],
    checkPrefix: 'internal_prospective_evidence_tick',
  },
  {
    jobName: 'p1_trading_evidence_hourly', cronExpr: '18 * * * *',
    scriptPathSuffix: 'scripts/cron_p1_trading_evidence.sh', checkPrefix: 'internal_p1_trading_evidence',
  },
  {
    jobName: 'market_intel_refresh_15m', cronExpr: '*/15 * * * *',
    scriptPathSuffix: OPENALICE_TASK_SCRIPT, args: ['refresh_market_intel_context'], checkPrefix: 'internal_market_intel_refresh',
  },
  {
    jobName: 'low_vol_research_daily', cronExpr: '0 2 * * *',
    scriptPathSuffix: 'scripts/cron_low_vol_research.sh', checkPrefix: 'internal_low_vol_research',
  },
  {
    jobName: 'gated_improvement_candidate_daily', cronExpr: '30 3 * * *',
    scriptPathSuffix: 'scripts/cron_gated_improvement_candidate.sh', checkPrefix: 'internal_gated_improvement_candidate', enabled: false,
  },
  { jobName: 'okx_instrument_master_refresh_15m', cronExpr: '4,19,34,49 * * * *', scriptPathSuffix: OKX_WAREHOUSE_TASK_SCRIPT, args: ['instrument'], checkPrefix: 'internal_okx_instruments' },
  { jobName: 'okx_public_fast_refresh_1m', cronExpr: '* * * * *', scriptPathSuffix: OKX_WAREHOUSE_TASK_SCRIPT, args: ['fast'], checkPrefix: 'internal_okx_fast' },
  { jobName: 'okx_public_broad_refresh_5m', cronExpr: '1-59/5 * * * *', scriptPathSuffix: OKX_WAREHOUSE_TASK_SCRIPT, args: ['broad'], checkPrefix: 'internal_okx_broad' },
  { jobName: 'okx_market_data_health_5m', cronExpr: '3-59/5 * * * *', scriptPathSuffix: OKX_WAREHOUSE_TASK_SCRIPT, args: ['health'], checkPrefix: 'internal_okx_health' },
  { jobName: 'okx_warehouse_compact_hourly', cronExpr: '17 * * * *', scriptPathSuffix: OKX_WAREHOUSE_TASK_SCRIPT, args: ['compact'], checkPrefix: 'internal_okx_compact' },
  { jobName: 'okx_depth_universe_daily', cronExpr: '15 0 * * *', scriptPathSuffix: OKX_WAREHOUSE_TASK_SCRIPT, args: ['universe'], checkPrefix: 'internal_okx_universe' },
  { jobName: 'okx_ssd_presence_archive_probe_15m', cronExpr: '7,22,37,52 * * * *', scriptPathSuffix: OKX_WAREHOUSE_TASK_SCRIPT, args: ['ssd_probe'], checkPrefix: 'internal_okx_ssd_probe' },
  { jobName: 'okx_ssd_weekly_reminder_sunday', cronExpr: '0 20 * * 0', scriptPathSuffix: OKX_WAREHOUSE_TASK_SCRIPT, args: ['ssd_reminder_weekly'], checkPrefix: 'internal_okx_ssd_weekly_reminder' },
  { jobName: 'okx_ssd_followup_reminder_mon_wed', cronExpr: '0 20 * * 1-3', scriptPathSuffix: OKX_WAREHOUSE_TASK_SCRIPT, args: ['ssd_reminder_followup'], checkPrefix: 'internal_okx_ssd_followup_reminder' },
  { jobName: 'okx_ssd_integrity_audit_weekly', cronExpr: '30 22 * * 0', scriptPathSuffix: OKX_WAREHOUSE_TASK_SCRIPT, args: ['ssd_integrity'], checkPrefix: 'internal_okx_ssd_integrity' },
  { jobName: 'okx_warehouse_retention_daily', cronExpr: '35 4 * * *', scriptPathSuffix: OKX_WAREHOUSE_TASK_SCRIPT, args: ['retention'], checkPrefix: 'internal_okx_retention' },
]

interface Finding {
  severity: 'info' | 'warn' | 'fail'
  check: string
  path?: string
  detail: string
}

interface AuditReport {
  generatedAt: string
  status: 'pass' | 'fail'
  findings: Finding[]
  checks: {
    crontab: SchedulerSurfaceCheck
    internalCronJobs: InternalCronJobsCheck
    launchdPlists: SchedulerSurfaceCheck
    launchctlRuntime: SchedulerSurfaceCheck
    envFile: EnvFileCheck
    wrapperDefaults: SchedulerSurfaceCheck
    runtimeSafety: RuntimeSafetyCheck
  }
}

interface RuntimeSafetyCheck {
  connectorConfigPath: string
  plaintextTelegramToken: boolean
  duplicateJobNames: string[]
  circuitOpenJobs: string[]
  dataRoot: string
  dataRootWritable: boolean
  residentOpenAliceLabels: string[]
  retiredLaunchAgentPlistsPresent: string[]
  okxMarketDataConfigPath?: string
  okxPrivateDataEnabled?: boolean
  okxMarginDataEnabled?: boolean
  okxOptionChainEnabled?: boolean
  okxWarehouseDataRoot?: string
  okxWarehouseDataRootExternal?: boolean
  okxPrivateWebsocketConfigured?: boolean
  okxPrivateLoginSourceHits?: string[]
  okxStreamWorkerProcesses?: number
  ordinaryShieldDirectoryPresent?: boolean
}

interface SchedulerSurfaceCheck {
  checked: boolean
  secretValueHits: number
  plaintextKeyAssignmentHits: number
  openaliceEnvFileHits: number
  openaliceSchedulerEntryHits: number
  externalDerivativesCollectorHits: number
  okxPublicDataTaskHits: number
}

interface InternalCronJobsCheck {
  checked: boolean
  path: string
  exists: boolean
  parseError: string | null
  externalDerivativesJobHits: number
  enabledExternalDerivativesJobHits: number
  scheduleKind: string | null
  cron: string | null
  timezone: string | null
  scriptPath: string | null
  args: string[]
  requiredJobs: Record<string, InternalCronRequiredJobCheck>
}

interface InternalCronRequiredJobCheck {
  jobName: string
  expectedCron: string
  expectedTimezone: string | null
  expectedScriptPathSuffix: string
  expectedArgs: string[]
  hits: number
  enabledHits: number
  scheduleKind: string | null
  cron: string | null
  timezone: string | null
  scriptPath: string | null
  args: string[]
  checkPrefix: string
  expectedEnabled: boolean
}

interface EnvFileCheck {
  path: string
  exists: boolean
  mode: string | null
  ownedByCurrentUser: boolean | null
  restricted: boolean | null
  okxCredentialPresence?: OkxCredentialPresence | null
}

interface OkxCredentialPresence {
  apiKey: boolean
  secret: boolean
  password: boolean
}

interface CliArgs {
  outputPath?: string
  json: boolean
}

interface SchedulerSecurityAuditInputs {
  crontabRaw: string
  internalCronJobs: InternalCronJobsCheck
  plistTexts: string
  launchctlRaw: string
  wrapperText: string
  envFile: EnvFileCheck
  runtimeSafety?: RuntimeSafetyCheck
  generatedAt?: string
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const report = await auditSchedulerSecurity()
  const text = `${JSON.stringify(report, null, 2)}\n`
  if (args.outputPath) {
    await writeFile(resolve(args.outputPath), text, 'utf-8')
  }
  if (args.json || !args.outputPath) {
    process.stdout.write(text)
  }
  if (report.status !== 'pass') {
    process.exitCode = 1
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: raw.get('outputPath') ?? raw.get('output'),
    json: parseBoolArg(raw.get('json'), false),
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

async function auditSchedulerSecurity(): Promise<AuditReport> {
  const crontabRaw = await readCrontab()
  const internalCronJobs = await inspectInternalCronJobs(INTERNAL_CRON_JOBS_PATH)
  const plistTexts = await readOpenAliceLaunchdPlists()
  const launchctlRaw = await readOpenAliceLaunchctlRuntime()
  const wrapperText = await readWrapperDefaults()
  const envFile = await inspectEnvFile(`${homedir()}/.config/openalice/openalice.env`)
  const runtimeSafety = await inspectRuntimeSafety({
    jobsPath: INTERNAL_CRON_JOBS_PATH,
    connectorsPath: CONNECTORS_CONFIG_PATH,
    okxConfigPath: OKX_MARKET_DATA_CONFIG_PATH,
    dataRoot: DATA_ROOT,
    launchctlRaw,
  })

  return buildSchedulerSecurityAuditReport({
    crontabRaw,
    internalCronJobs,
    plistTexts,
    launchctlRaw,
    wrapperText,
    envFile,
    runtimeSafety,
  })
}

function buildSchedulerSecurityAuditReport(input: SchedulerSecurityAuditInputs): AuditReport {
  const findings: Finding[] = []

  const checks = {
    crontab: checkSurface(input.crontabRaw),
    internalCronJobs: input.internalCronJobs,
    launchdPlists: checkSurface(input.plistTexts),
    launchctlRuntime: checkSurface(input.launchctlRaw),
    envFile: input.envFile,
    wrapperDefaults: checkSurface(input.wrapperText),
    runtimeSafety: input.runtimeSafety ?? emptyRuntimeSafetyCheck(),
  }

  addSurfaceFindings(findings, 'crontab', checks.crontab)
  addInternalCronFindings(findings, checks.internalCronJobs)
  addSurfaceFindings(findings, 'launchd_plists', checks.launchdPlists)
  addSurfaceFindings(findings, 'launchctl_runtime', checks.launchctlRuntime)
  addSurfaceFindings(findings, 'wrapper_defaults', checks.wrapperDefaults)
  addRuntimeSafetyFindings(findings, checks.runtimeSafety)

  if (checks.crontab.externalDerivativesCollectorHits > 0) {
    findings.push({
      severity: 'fail',
      check: 'crontab_external_derivatives_duplicate',
      detail: `${EXTERNAL_DERIVATIVES_JOB_NAME} must run from the internal scheduler only; remove OS crontab duplicate(s) for ${EXTERNAL_DERIVATIVES_SCRIPT}`,
    })
  }
  if (checks.crontab.okxPublicDataTaskHits > 0) {
    findings.push({
      severity: 'fail',
      check: 'crontab_okx_public_data_duplicate',
      detail: `OKX public data accumulation and freshness audit must run from the internal scheduler only; remove OS crontab duplicate(s) for ${OPENALICE_TASK_SCRIPT} data tasks`,
    })
  }
  if (checks.crontab.openaliceSchedulerEntryHits > 0 && !checks.crontab.openaliceEnvFileHits) {
    findings.push({
      severity: 'warn',
      check: 'crontab_env_file',
      detail: 'OpenAlice crontab does not reference OPENALICE_ENV_FILE',
    })
  }
  if (!checks.launchdPlists.openaliceEnvFileHits) {
    findings.push({
      severity: 'fail',
      check: 'launchd_env_file',
      detail: 'OpenAlice LaunchAgents do not reference OPENALICE_ENV_FILE',
    })
  }
  if (!checks.launchctlRuntime.openaliceEnvFileHits) {
    findings.push({
      severity: 'fail',
      check: 'launchctl_runtime_env_file',
      detail: 'Loaded OpenAlice LaunchAgents do not expose OPENALICE_ENV_FILE',
    })
  }
  if (!checks.envFile.exists) {
    findings.push({
      severity: 'warn',
      check: 'env_file_exists',
      path: checks.envFile.path,
      detail: 'Default OpenAlice env file is missing; wrappers will continue without local secrets unless OPENALICE_ENV_FILE is explicit',
    })
  } else if (!checks.envFile.restricted) {
    findings.push({
      severity: 'fail',
      check: 'env_file_permissions',
      path: checks.envFile.path,
      detail: `OpenAlice env file must be owned by the current user and chmod 600; current mode=${checks.envFile.mode ?? 'unknown'}`,
    })
  }
  addRuntimeFeeAuthEnvFileFindings(findings, checks.internalCronJobs, checks.envFile)
  if (input.wrapperText.includes('${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-true}')) {
    findings.push({
      severity: 'fail',
      check: 'ungated_paper_default',
      detail: 'Ungated paper lanes must default to false in scheduler wrappers',
    })
  }

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status: findings.some(finding => finding.severity === 'fail') ? 'fail' : 'pass',
    findings,
    checks,
  }
}

async function inspectInternalCronJobs(path: string): Promise<InternalCronJobsCheck> {
  try {
    const resolvedPath = resolve(path)
    const raw = await readFile(resolvedPath, 'utf-8')
    return inspectInternalCronJobsStore(raw, resolvedPath)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return emptyInternalCronJobsCheck(resolve(path), false, null)
    }
    return emptyInternalCronJobsCheck(resolve(path), true, error instanceof Error ? error.message : String(error))
  }
}

async function readCrontab(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('crontab', ['-l'])
    return stdout
  } catch {
    return ''
  }
}

async function readOpenAliceLaunchdPlists(): Promise<string> {
  const launchAgentsDir = `${homedir()}/Library/LaunchAgents`
  let names: string[] = []
  try {
    const { stdout } = await execFileAsync('/bin/ls', [launchAgentsDir])
    names = stdout.split('\n').filter(name => /^(?:ai|com)\.openalice.*\.plist$/.test(name))
  } catch {
    return ''
  }
  const texts = await Promise.all(names.map(async (name) => {
    const path = `${launchAgentsDir}/${name}`
    try {
      return await readFile(path, 'utf-8')
    } catch {
      return ''
    }
  }))
  return texts.join('\n')
}

async function readOpenAliceLaunchctlRuntime(): Promise<string> {
  const labels = [MAIN_LAUNCHD_LABEL, ...RETIRED_LAUNCHD_LABELS]
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '501'
  const texts = await Promise.all(labels.map(async (label) => {
    try {
      const { stdout, stderr } = await execFileAsync('/bin/launchctl', ['print', `gui/${uid}/${label}`])
      return `${stdout}\n${stderr}`
    } catch { return '' }
  }))
  return texts.join('\n')
}

async function inspectRuntimeSafety(input: {
  jobsPath: string
  connectorsPath: string
  okxConfigPath?: string
  dataRoot: string
  launchctlRaw: string
}): Promise<RuntimeSafetyCheck> {
  const store = await readJsonIfExists(resolve(input.jobsPath))
  const jobs = isRecord(store) && Array.isArray(store.jobs) ? store.jobs.filter(isRecord) : []
  const counts = new Map<string, number>()
  const circuitOpenJobs: string[] = []
  for (const job of jobs) {
    const name = stringValue(job.name)
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
    const state = isRecord(job.state) ? job.state : null
    if (name && typeof state?.circuitOpenedAtMs === 'number') circuitOpenJobs.push(name)
  }
  const connectors = await readJsonIfExists(resolve(input.connectorsPath))
  const telegram = isRecord(connectors) && isRecord(connectors.telegram) ? connectors.telegram : null
  const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents')
  let names: string[] = []
  try { names = (await execFileAsync('/bin/ls', [launchAgentsDir])).stdout.split('\n').filter(Boolean) } catch {}
  let dataRootWritable = true
  try { await access(resolve(input.dataRoot), constants.W_OK) } catch { dataRootWritable = false }
  const okxConfigPath = resolve(input.okxConfigPath ?? OKX_MARKET_DATA_CONFIG_PATH)
  const okxConfig = await readJsonIfExists(okxConfigPath)
  const okxDataRoot = isRecord(okxConfig) && typeof okxConfig.dataRoot === 'string' ? resolve(okxConfig.dataRoot) : resolve(input.dataRoot)
  const stream = isRecord(okxConfig) && isRecord(okxConfig.stream) ? okxConfig.stream : null
  const websocketUrls = [stream?.publicUrl, stream?.businessUrl].filter((value): value is string => typeof value === 'string')
  const sourcePaths = ['scripts/run_okx_stream_worker.ts', 'src/domain/market-data/okx-stream-supervisor.ts']
  const sourceTexts = await Promise.all(sourcePaths.map(async path => ({ path, text: await readFile(resolve(path), 'utf-8').catch(() => '') })))
  const okxPrivateLoginSourceHits = sourceTexts.filter(item => /ws\/v5\/private|op\s*:\s*['"]login['"]/i.test(item.text)).map(item => item.path)
  let okxStreamWorkerProcesses = 0
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-ax', '-o', 'command='])
    okxStreamWorkerProcesses = stdout.split('\n').filter(line => /run_okx_stream_worker|okx-stream-worker/i.test(line) && !/rg |grep /i.test(line)).length
  } catch {}
  const ordinaryShieldDirectoryPresent = await detectOrdinaryShieldDirectory()
  return {
    connectorConfigPath: resolve(input.connectorsPath),
    plaintextTelegramToken: typeof telegram?.botToken === 'string' && telegram.botToken.length > 0,
    duplicateJobNames: [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name).sort(),
    circuitOpenJobs: [...new Set(circuitOpenJobs)].sort(),
    dataRoot: resolve(input.dataRoot),
    dataRootWritable,
    residentOpenAliceLabels: extractResidentOpenAliceLabels(input.launchctlRaw),
    retiredLaunchAgentPlistsPresent: RETIRED_LAUNCHD_LABELS.filter(label => names.includes(`${label}.plist`)),
    okxMarketDataConfigPath: okxConfigPath,
    okxPrivateDataEnabled: isRecord(okxConfig) && okxConfig.privateDataEnabled === true,
    okxMarginDataEnabled: isRecord(okxConfig) && okxConfig.marginDataEnabled === true,
    okxOptionChainEnabled: isRecord(okxConfig) && okxConfig.optionChainEnabled === true,
    okxWarehouseDataRoot: okxDataRoot,
    okxWarehouseDataRootExternal: okxDataRoot.startsWith('/Volumes/'),
    okxPrivateWebsocketConfigured: websocketUrls.some(url => /\/private(?:$|[/?])/i.test(url)),
    okxPrivateLoginSourceHits,
    okxStreamWorkerProcesses,
    ordinaryShieldDirectoryPresent,
  }
}

function emptyRuntimeSafetyCheck(): RuntimeSafetyCheck {
  return {
    connectorConfigPath: resolve(CONNECTORS_CONFIG_PATH),
    plaintextTelegramToken: false,
    duplicateJobNames: [],
    circuitOpenJobs: [],
    dataRoot: resolve(DATA_ROOT),
    dataRootWritable: true,
    residentOpenAliceLabels: [MAIN_LAUNCHD_LABEL],
    retiredLaunchAgentPlistsPresent: [],
    okxMarketDataConfigPath: resolve(OKX_MARKET_DATA_CONFIG_PATH),
    okxPrivateDataEnabled: false,
    okxMarginDataEnabled: false,
    okxOptionChainEnabled: false,
    okxWarehouseDataRoot: resolve(DATA_ROOT),
    okxWarehouseDataRootExternal: false,
    okxPrivateWebsocketConfigured: false,
    okxPrivateLoginSourceHits: [],
    okxStreamWorkerProcesses: 0,
    ordinaryShieldDirectoryPresent: false,
  }
}

function extractResidentOpenAliceLabels(raw: string): string[] {
  const labels = new Set<string>()
  for (const line of raw.split('\n')) {
    const printed = /^gui\/\d+\/((?:ai|com)\.openalice[\w.-]*)\s*=\s*\{$/i.exec(line.trim())
    if (printed?.[1]) {
      labels.add(printed[1])
      continue
    }
    const listed = /^(?:\d+|-)\s+-?\d+\s+((?:ai|com)\.openalice[\w.-]*)$/i.exec(line.trim())
    if (listed?.[1]) labels.add(listed[1])
  }
  return [...labels].sort()
}

function addRuntimeSafetyFindings(findings: Finding[], check: RuntimeSafetyCheck): void {
  if (check.plaintextTelegramToken) findings.push({
    severity: 'fail', check: 'telegram_plaintext_token', path: check.connectorConfigPath,
    detail: 'Telegram botToken plaintext is forbidden; configure botTokenEnv only',
  })
  if (check.duplicateJobNames.length > 0) findings.push({
    severity: 'fail', check: 'internal_cron_duplicate_names',
    detail: `Internal CronEngine job names must be unique; duplicates=${check.duplicateJobNames.join(',')}`,
  })
  if (check.circuitOpenJobs.length > 0) findings.push({
    severity: 'fail', check: 'internal_cron_circuit_open',
    detail: `Circuit-open tasks require operator review: ${check.circuitOpenJobs.join(',')}`,
  })
  if (!check.dataRootWritable) findings.push({
    severity: 'fail', check: 'runtime_data_root_writable', path: check.dataRoot,
    detail: 'Runtime data root is not writable',
  })
  const residentExtra = check.residentOpenAliceLabels.filter(label => label !== MAIN_LAUNCHD_LABEL)
  if (residentExtra.length > 0) findings.push({
    severity: 'fail', check: 'resident_openalice_service_count',
    detail: `Only ${MAIN_LAUNCHD_LABEL} may remain resident; found ${residentExtra.join(',')}`,
  })
  if (check.retiredLaunchAgentPlistsPresent.length > 0) findings.push({
    severity: 'fail', check: 'retired_launchagent_plists_present',
    detail: `Retired LaunchAgent plist(s) still present: ${check.retiredLaunchAgentPlistsPresent.join(',')}`,
  })
  if (check.okxPrivateDataEnabled || check.okxMarginDataEnabled || check.okxOptionChainEnabled) findings.push({
    severity: 'fail', check: 'okx_public_only_config', path: check.okxMarketDataConfigPath,
    detail: `OKX warehouse v1 must remain public-only; private=${Boolean(check.okxPrivateDataEnabled)} margin=${Boolean(check.okxMarginDataEnabled)} options=${Boolean(check.okxOptionChainEnabled)}`,
  })
  if (check.okxWarehouseDataRootExternal) findings.push({
    severity: 'fail', check: 'okx_active_warehouse_local_root', path: check.okxWarehouseDataRoot,
    detail: 'Active OKX warehouse dataRoot must remain local; external volumes are sealed cold-storage targets only',
  })
  if (check.okxPrivateWebsocketConfigured || (check.okxPrivateLoginSourceHits?.length ?? 0) > 0) findings.push({
    severity: 'fail', check: 'okx_private_websocket_forbidden', path: check.okxMarketDataConfigPath,
    detail: `Private OKX WebSocket/login is forbidden; configured=${Boolean(check.okxPrivateWebsocketConfigured)} sourceHits=${(check.okxPrivateLoginSourceHits ?? []).join(',') || 'none'}`,
  })
  if ((check.okxStreamWorkerProcesses ?? 0) > 1) findings.push({
    severity: 'fail', check: 'okx_stream_worker_singleton',
    detail: `Only one main-supervised OKX stream worker is allowed; found ${check.okxStreamWorkerProcesses}`,
  })
  if (check.ordinaryShieldDirectoryPresent) findings.push({
    severity: 'fail', check: 'ordinary_shield_directory_forbidden', path: '/Volumes/shield',
    detail: '/Volumes/shield exists but is not a mounted filesystem; automation must never create this fallback directory',
  })
}

async function detectOrdinaryShieldDirectory(): Promise<boolean> {
  try {
    const shield = await stat('/Volumes/shield')
    if (!shield.isDirectory()) return false
    const { stdout } = await execFileAsync('/sbin/mount', [])
    return !stdout.split('\n').some(line => / on \/Volumes\/shield \(/.test(line))
  } catch { return false }
}

async function readJsonIfExists(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf-8')) }
  catch { return null }
}

async function readWrapperDefaults(): Promise<string> {
  const paths = [
    'scripts/cron_openalice_task.sh',
    'scripts/launch_microstructure_stress_monitor.sh',
    'scripts/install_openalice_launchd.ts',
  ]
  const texts = await Promise.all(paths.map(async path => readFile(resolve(path), 'utf-8').catch(() => '')))
  return texts.join('\n')
}

async function inspectEnvFile(path: string): Promise<EnvFileCheck> {
  try {
    await access(path, constants.F_OK)
  } catch {
    return {
      path,
      exists: false,
      mode: null,
      ownedByCurrentUser: null,
      restricted: null,
      okxCredentialPresence: null,
    }
  }

  const st = await stat(path)
  const modeNumber = st.mode & 0o777
  const mode = modeNumber.toString(8).padStart(3, '0')
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : st.uid
  const ownedByCurrentUser = st.uid === currentUid
  const base = {
    path,
    exists: true,
    mode,
    ownedByCurrentUser,
    restricted: ownedByCurrentUser && (modeNumber & 0o077) === 0,
  }
  if (!base.restricted) {
    return {
      ...base,
      okxCredentialPresence: null,
    }
  }

  const rawEnv = await readRawEnvFile(path)
  return {
    ...base,
    okxCredentialPresence: inspectOkxCredentialPresence(rawEnv),
  }
}

function checkSurface(raw: string): SchedulerSurfaceCheck {
  return {
    checked: true,
    secretValueHits: countMatches(raw, SECRET_VALUE_RE),
    plaintextKeyAssignmentHits: countSecretAssignments(raw) + countLaunchdSecretKeys(raw),
    openaliceEnvFileHits: countLiteral(raw, 'OPENALICE_ENV_FILE'),
    openaliceSchedulerEntryHits: countOpenAliceSchedulerEntries(raw),
    externalDerivativesCollectorHits: countExternalDerivativesCrontabDuplicates(raw),
    okxPublicDataTaskHits: countOkxPublicDataCrontabDuplicates(raw),
  }
}

function countSecretAssignments(raw: string): number {
  ENV_ASSIGNMENT_RE.lastIndex = 0
  return [...raw.matchAll(ENV_ASSIGNMENT_RE)]
    .filter(match => isPlaintextSecretEnvName(match[1]))
    .length
}

function isPlaintextSecretEnvName(name: string | undefined): boolean {
  if (!name || name.endsWith('_ENV')) return false
  const parts = name.split('_').filter(Boolean)
  return parts.some(part =>
    part === 'KEY' ||
    part === 'TOKEN' ||
    part === 'SECRET' ||
    part === 'PASSWORD',
  )
}

function countLaunchdSecretKeys(raw: string): number {
  LAUNCHD_ENV_KEY_RE.lastIndex = 0
  return [...raw.matchAll(LAUNCHD_ENV_KEY_RE)]
    .filter(match => isPlaintextSecretEnvName(match[1]))
    .length
}

function countMatches(raw: string, pattern: RegExp): number {
  pattern.lastIndex = 0
  return [...raw.matchAll(pattern)].length
}

function countLiteral(raw: string, literal: string): number {
  if (!raw) return 0
  return raw.split(literal).length - 1
}

function activeSchedulerLines(raw: string): string[] {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
}

function countOpenAliceSchedulerEntries(raw: string): number {
  return activeSchedulerLines(raw)
    .filter(line =>
      line.includes('OpenAlice') ||
      line.includes('openalice') ||
      line.includes('scripts/cron_') ||
      line.includes('OPENALICE_ENV_FILE'),
    )
    .length
}

function countExternalDerivativesCrontabDuplicates(raw: string): number {
  return activeSchedulerLines(raw)
    .filter(line =>
      line.includes(EXTERNAL_DERIVATIVES_JOB_NAME) ||
      line.includes(EXTERNAL_DERIVATIVES_SCRIPT) ||
      line.includes('external:derivatives:collect'),
    )
    .length
}

function countOkxPublicDataCrontabDuplicates(raw: string): number {
  return activeSchedulerLines(raw)
    .filter(line =>
      (
        line.includes(OPENALICE_TASK_SCRIPT) &&
        (
          line.includes('accumulate_live_data') ||
          line.includes('accumulate_5m_data') ||
          line.includes('accumulate_1s_data') ||
          line.includes('live_data_freshness_audit')
        )
      ) ||
      line.includes('data:accumulate') ||
      line.includes('data:freshness:audit'),
    )
    .length
}

function inspectInternalCronJobsStore(raw: string, path = INTERNAL_CRON_JOBS_PATH): InternalCronJobsCheck {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return emptyInternalCronJobsCheck(path, true, error instanceof Error ? error.message : String(error))
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.jobs)) {
    return emptyInternalCronJobsCheck(path, true, 'jobs array missing')
  }

  const jobs = parsed.jobs.filter(isRecord)
  const requiredJobs = Object.fromEntries(
    REQUIRED_INTERNAL_CRON_JOBS.map(spec => [
      spec.jobName,
      inspectRequiredInternalCronJob(jobs, spec),
    ]),
  )
  const externalDerivativesJob = requiredJobs[EXTERNAL_DERIVATIVES_JOB_NAME] ?? emptyRequiredJobCheck(REQUIRED_INTERNAL_CRON_JOBS[0])

  return {
    checked: true,
    path,
    exists: true,
    parseError: null,
    externalDerivativesJobHits: externalDerivativesJob.hits,
    enabledExternalDerivativesJobHits: externalDerivativesJob.enabledHits,
    scheduleKind: externalDerivativesJob.scheduleKind,
    cron: externalDerivativesJob.cron,
    timezone: externalDerivativesJob.timezone,
    scriptPath: externalDerivativesJob.scriptPath,
    args: externalDerivativesJob.args,
    requiredJobs,
  }
}

function inspectRequiredInternalCronJob(
  jobs: Record<string, unknown>[],
  spec: RequiredInternalCronJobSpec,
): InternalCronRequiredJobCheck {
  const matchingJobs = jobs.filter(job => stringValue(job.name) === spec.jobName)
  const enabledJobs = matchingJobs.filter(job => job.enabled !== false)
  const selectedJob = enabledJobs[0] ?? matchingJobs[0]
  const schedule = selectedJob && isRecord(selectedJob.schedule) ? selectedJob.schedule : null
  const script = selectedJob && isRecord(selectedJob.script) ? selectedJob.script : null
  return {
    ...emptyRequiredJobCheck(spec),
    hits: matchingJobs.length,
    enabledHits: enabledJobs.length,
    scheduleKind: stringValue(schedule?.kind),
    cron: stringValue(schedule?.cron),
    timezone: stringValue(schedule?.timezone),
    scriptPath: stringValue(script?.path),
    args: stringArrayValue(script?.args),
  }
}

function emptyRequiredJobCheck(spec: RequiredInternalCronJobSpec): InternalCronRequiredJobCheck {
  return {
    jobName: spec.jobName,
    expectedCron: spec.cronExpr,
    expectedTimezone: spec.timezone ?? null,
    expectedScriptPathSuffix: spec.scriptPathSuffix,
    expectedArgs: spec.args ?? [],
    hits: 0,
    enabledHits: 0,
    scheduleKind: null,
    cron: null,
    timezone: null,
    scriptPath: null,
    args: [],
    checkPrefix: spec.checkPrefix,
    expectedEnabled: spec.enabled ?? true,
  }
}

function emptyInternalCronJobsCheck(path: string, exists: boolean, parseError: string | null): InternalCronJobsCheck {
  return {
    checked: true,
    path,
    exists,
    parseError,
    externalDerivativesJobHits: 0,
    enabledExternalDerivativesJobHits: 0,
    scheduleKind: null,
    cron: null,
    timezone: null,
    scriptPath: null,
    args: [],
    requiredJobs: Object.fromEntries(
      REQUIRED_INTERNAL_CRON_JOBS.map(spec => [spec.jobName, emptyRequiredJobCheck(spec)]),
    ),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : []
}

async function readRawEnvFile(path: string): Promise<Record<string, string>> {
  const raw = await readFile(path, 'utf-8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const parsed = parseEnvLine(line)
    if (!parsed) continue
    out[parsed.key] = unquoteEnvValue(parsed.value)
  }
  return out
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const eq = trimmed.indexOf('=')
  if (eq <= 0) return null
  return {
    key: trimmed.slice(0, eq).trim(),
    value: trimmed.slice(eq + 1).trim(),
  }
}

function unquoteEnvValue(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function inspectOkxCredentialPresence(env: Record<string, string>): OkxCredentialPresence {
  return {
    apiKey: hasNonEmptyEnvValue(env, OKX_ENV_KEYS.apiKey),
    secret: hasNonEmptyEnvValue(env, OKX_ENV_KEYS.secret),
    password: hasNonEmptyEnvValue(env, OKX_ENV_KEYS.password),
  }
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  return typeof env[key] === 'string' && env[key].trim().length > 0
}

function addSurfaceFindings(findings: Finding[], check: string, result: SchedulerSurfaceCheck): void {
  if (result.secretValueHits > 0) {
    findings.push({
      severity: 'fail',
      check,
      detail: `found ${result.secretValueHits} plaintext secret-like value(s)`,
    })
  }
  if (result.plaintextKeyAssignmentHits > 0) {
    findings.push({
      severity: 'fail',
      check,
      detail: `found ${result.plaintextKeyAssignmentHits} plaintext API-key assignment(s)`,
    })
  }
}

function addInternalCronFindings(findings: Finding[], result: InternalCronJobsCheck): void {
  if (!result.exists) {
    findings.push({
      severity: 'fail',
      check: 'internal_cron_jobs_store',
      path: result.path,
      detail: `Internal scheduler store is missing; expected ${REQUIRED_INTERNAL_CRON_JOBS.length} required OpenAlice script job(s)`,
    })
    return
  }
  if (result.parseError) {
    findings.push({
      severity: 'fail',
      check: 'internal_cron_jobs_parse',
      path: result.path,
      detail: `Internal scheduler store is unreadable: ${result.parseError}`,
    })
    return
  }
  for (const requiredJob of Object.values(result.requiredJobs)) {
    addRequiredInternalCronJobFindings(findings, result.path, requiredJob)
  }
}

function addRuntimeFeeAuthEnvFileFindings(
  findings: Finding[],
  internalCronJobs: InternalCronJobsCheck,
  envFile: EnvFileCheck,
): void {
  const runtimeFeeAuthJob = internalCronJobs.requiredJobs[RUNTIME_FEE_AUTH_JOB_NAME]
  if (!runtimeFeeAuthJob || runtimeFeeAuthJob.enabledHits <= 0) return

  if (!envFile.exists) {
    findings.push({
      severity: 'fail',
      check: 'runtime_fee_auth_tick_okx_credentials',
      path: envFile.path,
      detail: `${RUNTIME_FEE_AUTH_JOB_NAME} is enabled but the default OpenAlice env file is missing; OKX private-auth fee refresh cannot run from launchd/internal cron without ${Object.values(OKX_ENV_KEYS).join(', ')}`,
    })
    return
  }
  if (!envFile.restricted) {
    findings.push({
      severity: 'fail',
      check: 'runtime_fee_auth_tick_okx_credentials',
      path: envFile.path,
      detail: `${RUNTIME_FEE_AUTH_JOB_NAME} is enabled but OKX credential presence was not inspected because the env file is not restricted to the current user`,
    })
    return
  }
  if (!envFile.okxCredentialPresence) {
    findings.push({
      severity: 'fail',
      check: 'runtime_fee_auth_tick_okx_credentials',
      path: envFile.path,
      detail: `${RUNTIME_FEE_AUTH_JOB_NAME} is enabled but OKX credential presence is unavailable for ${envFile.path}`,
    })
    return
  }

  const missing = Object.entries(OKX_ENV_KEYS)
    .filter(([field]) => !envFile.okxCredentialPresence?.[field as keyof OkxCredentialPresence])
    .map(([, envKey]) => envKey)
  if (missing.length > 0) {
    findings.push({
      severity: 'fail',
      check: 'runtime_fee_auth_tick_okx_credentials',
      path: envFile.path,
      detail: `${RUNTIME_FEE_AUTH_JOB_NAME} requires OKX private-auth credentials in the default OpenAlice env file; missing ${missing.join(', ')}`,
    })
  }
}

function addRequiredInternalCronJobFindings(
  findings: Finding[],
  path: string,
  result: InternalCronRequiredJobCheck,
): void {
  if (result.hits !== 1) {
    findings.push({
      severity: 'fail',
      check: `${result.checkPrefix}_job_count`,
      path,
      detail: `Expected exactly one ${result.jobName} internal scheduler job, found ${result.hits}`,
    })
    return
  }
  if (result.expectedEnabled && result.enabledHits !== 1) {
    findings.push({
      severity: 'fail',
      check: `${result.checkPrefix}_job_enabled`,
      path,
      detail: `${result.jobName} must be enabled in the internal scheduler`,
    })
  } else if (!result.expectedEnabled && result.enabledHits !== 0) {
    findings.push({
      severity: 'fail',
      check: `${result.checkPrefix}_job_enabled`,
      path,
      detail: `${result.jobName} must remain disabled until the 24-hour infrastructure stability gate passes`,
    })
  }
  if (result.scheduleKind !== 'cron' || result.cron !== result.expectedCron) {
    findings.push({
      severity: 'fail',
      check: `${result.checkPrefix}_schedule`,
      path,
      detail: `${result.jobName} must use cron ${result.expectedCron}; found kind=${result.scheduleKind ?? 'missing'} cron=${result.cron ?? 'missing'}`,
    })
  }
  if (result.expectedTimezone !== null && result.timezone !== result.expectedTimezone) {
    findings.push({
      severity: 'fail',
      check: `${result.checkPrefix}_timezone`,
      path,
      detail: `${result.jobName} must set schedule.timezone=${result.expectedTimezone}; found ${result.timezone ?? 'missing'}`,
    })
  }
  if (!result.scriptPath?.endsWith(result.expectedScriptPathSuffix)) {
    findings.push({
      severity: 'fail',
      check: `${result.checkPrefix}_script`,
      path,
      detail: `${result.jobName} must run ${result.expectedScriptPathSuffix}; found ${result.scriptPath ?? 'missing'}`,
    })
  }
  if (!sameStringArray(result.args, result.expectedArgs)) {
    findings.push({
      severity: 'fail',
      check: `${result.checkPrefix}_args`,
      path,
      detail: `${result.jobName} must use args ${JSON.stringify(result.expectedArgs)}; found ${JSON.stringify(result.args)}`,
    })
  }
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export {
  auditSchedulerSecurity,
  buildSchedulerSecurityAuditReport,
  checkSurface,
  inspectInternalCronJobsStore,
  inspectEnvFile,
  inspectRuntimeSafety,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
