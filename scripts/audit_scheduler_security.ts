import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
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
  }
}

interface SchedulerSurfaceCheck {
  checked: boolean
  secretValueHits: number
  plaintextKeyAssignmentHits: number
  openaliceEnvFileHits: number
  openaliceSchedulerEntryHits: number
  externalDerivativesCollectorHits: number
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
}

interface EnvFileCheck {
  path: string
  exists: boolean
  mode: string | null
  ownedByCurrentUser: boolean | null
  restricted: boolean | null
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

  return buildSchedulerSecurityAuditReport({
    crontabRaw,
    internalCronJobs,
    plistTexts,
    launchctlRaw,
    wrapperText,
    envFile,
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
  }

  addSurfaceFindings(findings, 'crontab', checks.crontab)
  addInternalCronFindings(findings, checks.internalCronJobs)
  addSurfaceFindings(findings, 'launchd_plists', checks.launchdPlists)
  addSurfaceFindings(findings, 'launchctl_runtime', checks.launchctlRuntime)
  addSurfaceFindings(findings, 'wrapper_defaults', checks.wrapperDefaults)

  if (checks.crontab.externalDerivativesCollectorHits > 0) {
    findings.push({
      severity: 'fail',
      check: 'crontab_external_derivatives_duplicate',
      detail: `${EXTERNAL_DERIVATIVES_JOB_NAME} must run from the internal scheduler only; remove OS crontab duplicate(s) for ${EXTERNAL_DERIVATIVES_SCRIPT}`,
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
    names = stdout.split('\n').filter(name => /^ai\.openalice.*\.plist$/.test(name))
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
  const labels = ['ai.openalice.main', 'ai.openalice.microstructure-stress', 'ai.openalice.paper-monitor']
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '501'
  const texts = await Promise.all(labels.map(async (label) => {
    try {
      const { stdout, stderr } = await execFileAsync('/bin/launchctl', ['print', `gui/${uid}/${label}`])
      return `${stdout}\n${stderr}`
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string }
      return `${err.stdout ?? ''}\n${err.stderr ?? ''}`
    }
  }))
  return texts.join('\n')
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
    }
  }

  const st = await stat(path)
  const modeNumber = st.mode & 0o777
  const mode = modeNumber.toString(8).padStart(3, '0')
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : st.uid
  const ownedByCurrentUser = st.uid === currentUid
  return {
    path,
    exists: true,
    mode,
    ownedByCurrentUser,
    restricted: ownedByCurrentUser && (modeNumber & 0o077) === 0,
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

  const matchingJobs = parsed.jobs
    .filter(isRecord)
    .filter(job => stringValue(job.name) === EXTERNAL_DERIVATIVES_JOB_NAME)
  const enabledJobs = matchingJobs.filter(job => job.enabled !== false)
  const selectedJob = enabledJobs[0] ?? matchingJobs[0]
  const schedule = selectedJob && isRecord(selectedJob.schedule) ? selectedJob.schedule : null
  const script = selectedJob && isRecord(selectedJob.script) ? selectedJob.script : null

  return {
    checked: true,
    path,
    exists: true,
    parseError: null,
    externalDerivativesJobHits: matchingJobs.length,
    enabledExternalDerivativesJobHits: enabledJobs.length,
    scheduleKind: stringValue(schedule?.kind),
    cron: stringValue(schedule?.cron),
    timezone: stringValue(schedule?.timezone),
    scriptPath: stringValue(script?.path),
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
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
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
      detail: `Internal scheduler store is missing; expected ${EXTERNAL_DERIVATIVES_JOB_NAME}`,
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
  if (result.externalDerivativesJobHits !== 1) {
    findings.push({
      severity: 'fail',
      check: 'internal_external_derivatives_job_count',
      path: result.path,
      detail: `Expected exactly one ${EXTERNAL_DERIVATIVES_JOB_NAME} internal scheduler job, found ${result.externalDerivativesJobHits}`,
    })
    return
  }
  if (result.enabledExternalDerivativesJobHits !== 1) {
    findings.push({
      severity: 'fail',
      check: 'internal_external_derivatives_job_enabled',
      path: result.path,
      detail: `${EXTERNAL_DERIVATIVES_JOB_NAME} must be enabled in the internal scheduler`,
    })
  }
  if (result.scheduleKind !== 'cron' || result.cron !== EXTERNAL_DERIVATIVES_CRON_EXPR) {
    findings.push({
      severity: 'fail',
      check: 'internal_external_derivatives_schedule',
      path: result.path,
      detail: `${EXTERNAL_DERIVATIVES_JOB_NAME} must use cron ${EXTERNAL_DERIVATIVES_CRON_EXPR}; found kind=${result.scheduleKind ?? 'missing'} cron=${result.cron ?? 'missing'}`,
    })
  }
  if (result.timezone !== 'UTC') {
    findings.push({
      severity: 'fail',
      check: 'internal_external_derivatives_timezone',
      path: result.path,
      detail: `${EXTERNAL_DERIVATIVES_JOB_NAME} must set schedule.timezone=UTC; found ${result.timezone ?? 'missing'}`,
    })
  }
  if (!result.scriptPath?.endsWith(EXTERNAL_DERIVATIVES_SCRIPT)) {
    findings.push({
      severity: 'fail',
      check: 'internal_external_derivatives_script',
      path: result.path,
      detail: `${EXTERNAL_DERIVATIVES_JOB_NAME} must run ${EXTERNAL_DERIVATIVES_SCRIPT}; found ${result.scriptPath ?? 'missing'}`,
    })
  }
}

export {
  auditSchedulerSecurity,
  buildSchedulerSecurityAuditReport,
  checkSurface,
  inspectInternalCronJobsStore,
  inspectEnvFile,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
