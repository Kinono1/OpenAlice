import { constants } from 'node:fs'
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { getAuthTokens } from '../src/core/auth.js'

const execFileAsync = promisify(execFile)

interface CliArgs {
  dataRoot: string
  jobsPath: string
  connectorsPath: string
  accountsPath: string
  agentPath: string
  telegramProbePath: string
  okxHealthPath: string
  okxArchivePath: string
  outputPath: string
  json: boolean
}

interface HealthJob {
  id: string
  name: string
  owner: 'CronEngine'
  enabled: boolean
  schedule: unknown
  lastRunAt: string | null
  lastSuccessAt: string | null
  nextRunAt: string | null
  lastStatus: string | null
  consecutiveErrors: number
  circuitOpen: boolean
  lastErrorClass: string | null
  duplicateInstances: number
}

interface ConnectorHealth {
  channel: string
  enabled: boolean
  state: 'ready' | 'degraded_missing_secret' | 'degraded' | 'stopped'
  detail: string
}

export interface SchedulerHealthReport {
  schemaVersion: 1
  generatedAt: string
  status: 'pass' | 'degraded' | 'fail'
  process: {
    label: 'ai.openalice.main'
    loaded: boolean
    running: boolean
    pid: number | null
    runs: number | null
    restartCountApprox: number | null
    lastExitCode: number | null
    state: string | null
    startedAt: string | null
  }
  connectors: ConnectorHealth[]
  jobs: HealthJob[]
  osScheduling: {
    crontabOpenAliceEntries: string[]
    residentOpenAliceLabels: string[]
    duplicateResidentServices: string[]
    retiredLaunchAgentPlistsPresent: string[]
  }
  dataRoot: { path: string; exists: boolean; writable: boolean; externalVolume: boolean }
  telegramProbe: { available: boolean; delivered: boolean | null; reason: string | null; generatedAt: string | null }
  okxMarketData: {
    available: boolean
    status: string | null
    localWarehouseBytes: number | null
    localFreeBytes: number | null
    archiveStatus: string | null
    archivePendingBytes: number | null
    privateApiCallCount: number
  }
  safety: {
    activePrivateAccounts: number
    evolutionMode: boolean
    authTokenConfigured: boolean
    tradeTokenConfigured: boolean
    tradingAuthorization: 'disabled' | 'configured_but_no_active_account'
  }
  blockers: string[]
  warnings: string[]
}

const RETIRED_LABELS = [
  'ai.openalice.okx-market-data',
  'ai.openalice.low-vol-observer',
  'ai.openalice.microstructure-stress',
  'ai.openalice.paper-monitor',
  'com.openalice.crypto.fast-binance-spot-klines',
] as const

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const report = await buildSchedulerHealth(args)
  await atomicWriteJson(args.outputPath, report)
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.status === 'fail') process.exitCode = 1
}

export function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = resolve(raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT ?? 'data')
  return {
    dataRoot,
    jobsPath: resolve(raw.get('jobsPath') ?? join(dataRoot, 'cron', 'jobs.json')),
    connectorsPath: resolve(raw.get('connectorsPath') ?? join(dataRoot, 'config', 'connectors.json')),
    accountsPath: resolve(raw.get('accountsPath') ?? join(dataRoot, 'config', 'accounts.json')),
    agentPath: resolve(raw.get('agentPath') ?? join(dataRoot, 'config', 'agent.json')),
    telegramProbePath: resolve(raw.get('telegramProbePath') ?? join(dataRoot, 'runtime', 'telegram_push_probe.latest.json')),
    okxHealthPath: resolve(raw.get('okxHealthPath') ?? join(dataRoot, 'runtime', 'okx_market_data_health.latest.json')),
    okxArchivePath: resolve(raw.get('okxArchivePath') ?? join(dataRoot, 'runtime', 'storage', 'ssd_archive_state.json')),
    outputPath: resolve(raw.get('outputPath') ?? join(dataRoot, 'runtime', 'scheduler_health.latest.json')),
    json: parseBool(raw.get('json'), false),
  }
}

export async function buildSchedulerHealth(args: CliArgs, generatedAt = new Date().toISOString()): Promise<SchedulerHealthReport> {
  const [launchctl, crontab, launchAgentNames, store, connectorsConfig, accounts, agent, telegramProbe, okxHealth, okxArchive, dataRoot] = await Promise.all([
    readLaunchctlMain(), readCrontab(), listOpenAliceLaunchAgentNames(), readJson(args.jobsPath), readJson(args.connectorsPath),
    readJson(args.accountsPath), readJson(args.agentPath), readJson(args.telegramProbePath), readJson(args.okxHealthPath), readJson(args.okxArchivePath), inspectDataRoot(args.dataRoot),
  ])
  const jobs = buildJobHealth(store)
  const counts = new Map<string, number>()
  for (const job of jobs) counts.set(job.name, (counts.get(job.name) ?? 0) + 1)
  for (const job of jobs) job.duplicateInstances = counts.get(job.name) ?? 1
  const telegram = isRecord(connectorsConfig) && isRecord(connectorsConfig.telegram) ? connectorsConfig.telegram : null
  const telegramEnabled = telegram?.enabled === true
  const tokenEnv = typeof telegram?.botTokenEnv === 'string' ? telegram.botTokenEnv : 'TELEGRAM_BOT_TOKEN'
  const hasLegacyToken = typeof telegram?.botToken === 'string' && telegram.botToken.length > 0
  const envSnapshot = await readRestrictedEnvPresence()
  const telegramSecretPresent = Boolean(process.env[tokenEnv]) || envSnapshot.names.has(tokenEnv)
  const configuredConnectors: ConnectorHealth[] = [{
    channel: 'telegram',
    enabled: telegramEnabled,
    state: !telegramEnabled ? 'stopped' as const : telegramSecretPresent ? 'ready' as const : 'degraded_missing_secret' as const,
    detail: !telegramEnabled ? 'disabled_by_config' : telegramSecretPresent ? `secret_env_present:${tokenEnv}` : `secret_env_missing:${tokenEnv}`,
  }]
  const runtimeConnectors = await readRuntimeConnectors(connectorsConfig, envSnapshot)
  const connectors = mergeConnectorHealth(configuredConnectors, runtimeConnectors)
  const crontabEntries = activeLines(crontab).filter(line => /openalice|OpenAlice|cron_openalice|OPENALICE/i.test(line))
  const residentLabels = extractLaunchctlLabels(launchctl.all)
  const duplicateResidentServices = residentLabels.filter(label => label !== 'ai.openalice.main')
  const retiredPresent = launchAgentNames.filter(name => RETIRED_LABELS.some(label => name === `${label}.plist`))
  const activePrivateAccounts = Array.isArray(accounts) ? accounts.filter(isActivePrivateAccount).length : accounts == null ? 0 : 1
  const evolutionMode = isRecord(agent) && agent.evolutionMode === true
  const auth = getAuthTokens()
  const authTokenConfigured = auth.authConfigured || envSnapshot.names.has('AUTH_TOKEN')
  const tradeTokenConfigured = auth.tradeConfigured || envSnapshot.names.has('TRADE_TOKEN')
  const blockers: string[] = []
  const warnings: string[] = []
  if (!launchctl.main.loaded || !launchctl.main.running) blockers.push('main_launchagent_not_running')
  if (duplicateResidentServices.length > 0) blockers.push(`duplicate_resident_openalice_services:${duplicateResidentServices.join(',')}`)
  if (crontabEntries.length > 0) blockers.push(`openalice_crontab_entries:${crontabEntries.length}`)
  if (retiredPresent.length > 0) blockers.push(`retired_launchagents_present:${retiredPresent.join(',')}`)
  if (jobs.some(job => job.duplicateInstances !== 1)) blockers.push('duplicate_internal_job_names')
  if (jobs.some(job => job.circuitOpen)) blockers.push(`circuit_open_jobs:${jobs.filter(job => job.circuitOpen).map(job => job.name).join(',')}`)
  if (!dataRoot.writable) blockers.push('data_root_not_writable')
  if (dataRoot.externalVolume) blockers.push('runtime_data_root_on_external_volume')
  if (hasLegacyToken) blockers.push('telegram_plaintext_token_present')
  if (activePrivateAccounts > 0) blockers.push(`active_private_accounts:${activePrivateAccounts}`)
  if (evolutionMode) blockers.push('global_evolution_mode_enabled')
  if (tradeTokenConfigured && activePrivateAccounts === 0) warnings.push('trade_token_configured_but_no_active_private_account')
  if (telegramEnabled && !telegramSecretPresent) warnings.push(`telegram_degraded_missing_secret:${tokenEnv}`)
  const probeResult = readTelegramProbe(telegramProbe)
  if (probeResult.available && probeResult.delivered !== true) warnings.push(`telegram_probe_failed:${probeResult.reason ?? 'unknown'}`)
  const okxMarketData = {
    available: isRecord(okxHealth),
    status: isRecord(okxHealth) ? stringValue(okxHealth.status) : null,
    localWarehouseBytes: isRecord(okxHealth) && isRecord(okxHealth.storage) ? numberValue(okxHealth.storage.warehouseBytes) : null,
    localFreeBytes: isRecord(okxHealth) && isRecord(okxHealth.storage) ? numberValue(okxHealth.storage.filesystemFreeBytes) : null,
    archiveStatus: isRecord(okxArchive) ? stringValue(okxArchive.status) : null,
    archivePendingBytes: isRecord(okxArchive) ? numberValue(okxArchive.pendingBytes) : null,
    privateApiCallCount: isRecord(okxHealth) ? numberValue(okxHealth.privateApiCallCount) ?? 0 : 0,
  }
  if (okxMarketData.privateApiCallCount > 0) blockers.push(`okx_private_api_calls:${okxMarketData.privateApiCallCount}`)
  const status = deriveSchedulerHealthStatus(blockers, warnings)

  return {
    schemaVersion: 1,
    generatedAt,
    status,
    process: launchctl.main,
    connectors,
    jobs,
    osScheduling: {
      crontabOpenAliceEntries: crontabEntries,
      residentOpenAliceLabels: residentLabels,
      duplicateResidentServices,
      retiredLaunchAgentPlistsPresent: retiredPresent,
    },
    dataRoot,
    telegramProbe: probeResult,
    okxMarketData,
    safety: {
      activePrivateAccounts,
      evolutionMode,
      authTokenConfigured,
      tradeTokenConfigured,
      tradingAuthorization: tradeTokenConfigured ? 'configured_but_no_active_account' : 'disabled',
    },
    blockers,
    warnings,
  }
}

export function deriveSchedulerHealthStatus(blockers: string[], warnings: string[]): SchedulerHealthReport['status'] {
  return blockers.length > 0 ? 'fail' : warnings.length > 0 ? 'degraded' : 'pass'
}

interface RestrictedEnvPresence { names: Set<string>; authToken: string | null }

async function readRuntimeConnectors(connectorsConfig: unknown, envSnapshot: RestrictedEnvPresence): Promise<ConnectorHealth[]> {
  const web = isRecord(connectorsConfig) && isRecord(connectorsConfig.web) ? connectorsConfig.web : null
  const port = numberValue(web?.port) ?? 3002
  const auth = getAuthTokens()
  const headers: Record<string, string> = {}
  const authToken = auth.authConfigured ? auth.auth : envSnapshot.authToken
  if (authToken) headers.authorization = `Bearer ${authToken}`
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/dev/registry`, {
      headers,
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return []
    const body = await response.json() as unknown
    if (!isRecord(body)) return []
    const statuses = isRecord(body.statuses) ? body.statuses : {}
    const registered = Array.isArray(body.connectors) ? body.connectors.filter(isRecord) : []
    const channels = new Set<string>([
      ...Object.keys(statuses),
      ...registered.map(item => stringValue(item.channel)).filter((value): value is string => value != null),
    ])
    return [...channels].sort().map(channel => {
      const status = isRecord(statuses[channel]) ? statuses[channel] : null
      const raw = stringValue(status?.status)
      const detail = stringValue(status?.detail) ?? (registered.some(item => item.channel === channel) ? 'registered_runtime_connector' : 'runtime_status_only')
      const missingSecret = channel === 'telegram' && detail.includes('missing_secret')
      return {
        channel,
        enabled: raw !== 'stopped',
        state: missingSecret ? 'degraded_missing_secret' : raw === 'ready' || raw === 'degraded' || raw === 'stopped' ? raw : 'degraded',
        detail,
      }
    })
  } catch { return [] }
}

async function readRestrictedEnvPresence(): Promise<RestrictedEnvPresence> {
  const path = process.env.OPENALICE_ENV_FILE ?? join(homedir(), '.config', 'openalice', 'openalice.env')
  try {
    const st = await stat(path)
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : st.uid
    if (!st.isFile() || st.uid !== currentUid || (st.mode & 0o077) !== 0) return { names: new Set(), authToken: null }
    const raw = await readFile(path, 'utf-8')
    const names = new Set<string>()
    let authToken: string | null = null
    for (const line of raw.split('\n')) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (!match) continue
      const name = match[1]
      const value = parseEnvValue(match[2])
      if (!value) continue
      names.add(name)
      if (name === 'AUTH_TOKEN') authToken = value
    }
    return { names, authToken }
  } catch { return { names: new Set(), authToken: null } }
}

function parseEnvValue(raw: string): string {
  const value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1)
  return value.split(/\s+#/, 1)[0]?.trim() ?? ''
}

function mergeConnectorHealth(configured: ConnectorHealth[], runtime: ConnectorHealth[]): ConnectorHealth[] {
  const merged = new Map<string, ConnectorHealth>()
  for (const connector of configured) merged.set(connector.channel, connector)
  for (const connector of runtime) {
    const prior = merged.get(connector.channel)
    if (prior?.state === 'degraded_missing_secret' && connector.state === 'degraded') {
      merged.set(connector.channel, { ...connector, state: 'degraded_missing_secret' })
    } else merged.set(connector.channel, connector)
  }
  return [...merged.values()].sort((left, right) => left.channel.localeCompare(right.channel))
}

function buildJobHealth(store: unknown): HealthJob[] {
  const jobs = isRecord(store) && Array.isArray(store.jobs) ? store.jobs.filter(isRecord) : []
  return jobs.map(job => {
    const state = isRecord(job.state) ? job.state : {}
    return {
      id: stringValue(job.id) ?? 'unknown',
      name: stringValue(job.name) ?? 'unnamed',
      owner: 'CronEngine' as const,
      enabled: job.enabled !== false,
      schedule: job.schedule ?? null,
      lastRunAt: isoOrNull(numberValue(state.lastRunAtMs)),
      lastSuccessAt: isoOrNull(numberValue(state.lastSuccessAtMs)),
      nextRunAt: isoOrNull(numberValue(state.nextRunAtMs)),
      lastStatus: stringValue(state.lastStatus),
      consecutiveErrors: numberValue(state.consecutiveErrors) ?? 0,
      circuitOpen: numberValue(state.circuitOpenedAtMs) != null,
      lastErrorClass: stringValue(state.lastErrorClass),
      duplicateInstances: 1,
    }
  })
}

async function readLaunchctlMain(): Promise<{ main: SchedulerHealthReport['process']; all: string }> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501
  let all = ''
  try { all = (await execFileAsync('/bin/launchctl', ['list'])).stdout } catch {}
  try {
    const { stdout } = await execFileAsync('/bin/launchctl', ['print', `gui/${uid}/ai.openalice.main`])
    const pid = captureNumber(stdout, /^\s*pid = (\d+)$/m)
    const runs = captureNumber(stdout, /^\s*runs = (\d+)$/m)
    const lastExitCode = captureNumber(stdout, /^\s*last exit code = (-?\d+)$/m)
    const state = /^\s*state = (.+)$/m.exec(stdout)?.[1]?.trim() ?? null
    const startedAt = pid ? await processStartedAt(pid) : null
    return { main: { label: 'ai.openalice.main', loaded: true, running: state === 'running' && pid != null, pid, runs, restartCountApprox: runs == null ? null : Math.max(0, runs - 1), lastExitCode, state, startedAt }, all }
  } catch {
    return { main: { label: 'ai.openalice.main', loaded: false, running: false, pid: null, runs: null, restartCountApprox: null, lastExitCode: null, state: null, startedAt: null }, all }
  }
}

async function processStartedAt(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='])
    const parsed = Date.parse(stdout.trim())
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  } catch { return null }
}

async function readCrontab(): Promise<string> { try { return (await execFileAsync('crontab', ['-l'])).stdout } catch { return '' } }
async function listOpenAliceLaunchAgentNames(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('/bin/ls', [join(homedir(), 'Library', 'LaunchAgents')])
    return stdout.split('\n').filter(name => /openalice/i.test(name))
  } catch { return [] }
}

async function inspectDataRoot(path: string): Promise<SchedulerHealthReport['dataRoot']> {
  let exists = true
  try { await stat(path) } catch { exists = false }
  if (!exists) await mkdir(path, { recursive: true })
  let writable = true
  try { await access(path, constants.W_OK) } catch { writable = false }
  return { path, exists, writable, externalVolume: resolve(path).startsWith('/Volumes/') }
}

function readTelegramProbe(value: unknown): SchedulerHealthReport['telegramProbe'] {
  if (!isRecord(value)) return { available: false, delivered: null, reason: null, generatedAt: null }
  return {
    available: true,
    delivered: typeof value.delivered === 'boolean' ? value.delivered : null,
    reason: stringValue(value.reason),
    generatedAt: stringValue(value.generatedAt),
  }
}

function extractLaunchctlLabels(raw: string): string[] {
  const labels = new Set<string>()
  for (const line of raw.split('\n')) {
    const match = /\b((?:ai|com)\.openalice[\w.-]*)\b/i.exec(line)
    if (match?.[1]) labels.add(match[1])
  }
  return [...labels].sort()
}

function activeLines(raw: string): string[] { return raw.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')) }
function isActivePrivateAccount(value: unknown): boolean {
  if (!isRecord(value)) return true
  const enabled = value.enabled !== false && value.active !== false && value.disabled !== true
  const kind = String(value.type ?? value.kind ?? value.mode ?? '').toLowerCase()
  return enabled && !kind.includes('paper') && !kind.includes('shadow') && value.paper !== true
}

async function readJson(path: string): Promise<unknown> { try { return JSON.parse(await readFile(path, 'utf-8')) } catch { return null } }
async function atomicWriteJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const tmp = `${path}.${process.pid}.tmp`; await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`); await rename(tmp, path) }
function parseRawArgs(argv: string[]): Map<string, string> { const out = new Map<string, string>(); for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token?.startsWith('--')) continue; const next = argv[i + 1]; if (!next || next.startsWith('--')) out.set(token.slice(2), 'true'); else { out.set(token.slice(2), next); i += 1 } } return out }
function parseBool(raw: string | undefined, fallback: boolean): boolean { return raw == null ? fallback : ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase()) }
function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function stringValue(value: unknown): string | null { return typeof value === 'string' ? value : null }
function numberValue(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }
function isoOrNull(value: number | null): string | null { return value == null ? null : new Date(value).toISOString() }
function captureNumber(raw: string, pattern: RegExp): number | null { const value = Number(pattern.exec(raw)?.[1]); return Number.isFinite(value) ? value : null }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
