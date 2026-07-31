import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

const OKX_ENV_KEYS = ['EXCHANGE_API_KEY', 'EXCHANGE_API_SECRET', 'EXCHANGE_PASSWORD'] as const

type OkxEnvKey = typeof OKX_ENV_KEYS[number]

interface CliArgs {
  sourcePath: string
  targetPath: string
  dryRun: boolean
  backup: boolean
  json: boolean
}

interface EnvFileInfo {
  path: string
  exists: boolean
  restricted: boolean | null
  ownerCurrentUser: boolean | null
  mode: string | null
  credentialPresence: Record<OkxEnvKey, boolean>
  credentialFingerprints: Record<OkxEnvKey, string | null>
  blockers: string[]
}

interface SyncReport {
  schemaVersion: 1
  generatedAt: string
  dryRun: boolean
  backup: boolean
  source: EnvFileInfo
  target: EnvFileInfo
  status: 'ready_to_sync' | 'synced' | 'blocked' | 'already_in_sync'
  mismatchedKeys: OkxEnvKey[]
  targetWritten: boolean
  backupPath: string | null
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const report = await runSyncOkxLaunchdEnv(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(renderSummary(report))
}

export async function runSyncOkxLaunchdEnv(args: CliArgs): Promise<SyncReport> {
  const source = await inspectEnvFile(args.sourcePath)
  const target = await inspectEnvFile(args.targetPath)
  const blockers = buildBlockers(source, target)
  const mismatchedKeys = OKX_ENV_KEYS.filter(key =>
    source.credentialFingerprints[key] !== target.credentialFingerprints[key],
  )
  let status: SyncReport['status'] =
    blockers.length > 0
      ? 'blocked'
      : mismatchedKeys.length > 0
        ? 'ready_to_sync'
        : 'already_in_sync'
  let targetWritten = false
  let backupPath: string | null = null

  if (!args.dryRun && status === 'ready_to_sync') {
    const sourceRaw = await readRawEnvFile(args.sourcePath)
    const targetRaw = target.exists ? await readFile(args.targetPath, 'utf-8') : ''
    const targetLines = mergeOkxEnvLines(targetRaw, sourceRaw)
    await mkdir(dirname(resolve(args.targetPath)), { recursive: true })
    if (args.backup && target.exists) {
      backupPath = `${resolve(args.targetPath)}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`
      await copyFile(args.targetPath, backupPath)
      await chmod(backupPath, 0o600)
    }
    await writeFile(args.targetPath, `${targetLines.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 })
    await chmod(args.targetPath, 0o600)
    targetWritten = true
    status = 'synced'
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    backup: args.backup,
    source,
    target,
    status,
    mismatchedKeys,
    targetWritten,
    backupPath,
    blockers,
    nextActions: buildNextActions(args, status, blockers),
    notes: [
      'This tool reports only credential presence and salted fingerprints; it never prints raw API key, secret, or passphrase values.',
      'Default mode is dry-run. Use --dryRun false only after confirming the source env contains the intended fresh OKX tuple.',
      'This sync only aligns env files. It does not prove OKX accepts the key and does not authorize paper/live trading.',
    ],
  }
}

function buildBlockers(source: EnvFileInfo, target: EnvFileInfo): string[] {
  const blockers: string[] = []
  if (!source.exists) blockers.push('source_env_missing')
  if (source.exists && !source.restricted) blockers.push('source_env_not_restricted')
  if (target.exists && !target.restricted) blockers.push('target_env_not_restricted')
  for (const key of OKX_ENV_KEYS) {
    if (!source.credentialPresence[key]) blockers.push(`source_missing:${key}`)
  }
  return blockers
}

function buildNextActions(args: CliArgs, status: SyncReport['status'], blockers: string[]): string[] {
  if (status === 'already_in_sync') {
    return [
      'Run fees:okx:auth-diagnose to verify OKX recognizes the synced credential tuple.',
    ]
  }
  if (status === 'synced') {
    return [
      'Run fees:okx:auth-diagnose from both interactive and launchd paths before rerunning fees:runtime:snapshot.',
      'Keep paper/live disabled until auth, runtime fees, and promotion gates pass.',
    ]
  }
  if (status === 'ready_to_sync') {
    return [
      `Review the redacted fingerprints, then run with --dryRun false to merge OKX credentials from ${args.sourcePath} into ${args.targetPath}.`,
      'After sync, rerun fees:okx:auth-diagnose; do not assume sync means OKX auth success.',
    ]
  }
  return [
    `Fix blockers first: ${blockers.join(',')}`,
    'Use chmod 600 on env files and ensure the source env contains EXCHANGE_API_KEY, EXCHANGE_API_SECRET, and EXCHANGE_PASSWORD.',
  ]
}

function mergeOkxEnvLines(targetRaw: string, sourceEnv: Record<string, string>): string[] {
  const seen = new Set<OkxEnvKey>()
  const lines = targetRaw.split('\n')
  const out = lines
    .filter((line, index) => index < lines.length - 1 || line.trim().length > 0)
    .map(line => {
      const parsed = parseEnvLine(line)
      if (!parsed || !OKX_ENV_KEYS.includes(parsed.key as OkxEnvKey)) return line
      const key = parsed.key as OkxEnvKey
      seen.add(key)
      return `${key}=${quoteEnvValue(sourceEnv[key] ?? '')}`
    })
  for (const key of OKX_ENV_KEYS) {
    if (!seen.has(key)) out.push(`${key}=${quoteEnvValue(sourceEnv[key] ?? '')}`)
  }
  return out
}

async function inspectEnvFile(path: string): Promise<EnvFileInfo> {
  const resolved = resolve(path)
  const base = {
    path: resolved,
    credentialPresence: emptyPresence(),
    credentialFingerprints: emptyFingerprints(),
  }
  if (!existsSync(resolved)) {
    return {
      ...base,
      exists: false,
      restricted: null,
      ownerCurrentUser: null,
      mode: null,
      blockers: ['env_file_missing'],
    }
  }
  const fileStat = await stat(resolved)
  const modeNumber = fileStat.mode & 0o777
  const mode = `0o${modeNumber.toString(8).padStart(3, '0')}`
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : fileStat.uid
  const ownerCurrentUser = fileStat.uid === currentUid
  const restricted = ownerCurrentUser && (modeNumber & 0o077) === 0
  const blockers: string[] = []
  if (!ownerCurrentUser) blockers.push('env_file_not_owned_by_current_user')
  if ((modeNumber & 0o077) !== 0) blockers.push('env_file_group_or_other_accessible')
  if (!restricted) {
    return {
      ...base,
      exists: true,
      restricted,
      ownerCurrentUser,
      mode,
      blockers,
    }
  }
  const raw = await readRawEnvFile(resolved)
  const credentialPresence = emptyPresence()
  const credentialFingerprints = emptyFingerprints()
  for (const key of OKX_ENV_KEYS) {
    const value = readCredential(raw, key)
    credentialPresence[key] = value != null
    credentialFingerprints[key] = credentialFingerprint(value)
    if (!value) blockers.push(`credential_missing:${key}`)
  }
  return {
    ...base,
    exists: true,
    restricted,
    ownerCurrentUser,
    mode,
    credentialPresence,
    credentialFingerprints,
    blockers,
  }
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

function readCredential(env: Record<string, string>, key: string): string | null {
  const value = env[key]?.trim()
  return value ? value : null
}

function credentialFingerprint(value: string | null): string | null {
  if (!value) return null
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}:len${value.length}`
}

function emptyPresence(): Record<OkxEnvKey, boolean> {
  return {
    EXCHANGE_API_KEY: false,
    EXCHANGE_API_SECRET: false,
    EXCHANGE_PASSWORD: false,
  }
}

function emptyFingerprints(): Record<OkxEnvKey, string | null> {
  return {
    EXCHANGE_API_KEY: null,
    EXCHANGE_API_SECRET: null,
    EXCHANGE_PASSWORD: null,
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    sourcePath: raw.get('sourcePath') ?? raw.get('source') ?? '.env',
    targetPath: raw.get('targetPath') ?? raw.get('target') ?? resolve(homedir(), '.config/openalice/openalice.env'),
    dryRun: parseBool(raw.get('dryRun'), true),
    backup: parseBool(raw.get('backup'), true),
    json: parseBool(raw.get('json'), false),
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

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function unquoteEnvValue(raw: string): string {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1)
  }
  return raw
}

function renderSummary(report: SyncReport): string {
  return [
    `okx launchd env sync: status=${report.status} dryRun=${report.dryRun} targetWritten=${report.targetWritten}`,
    `source=${report.source.path}`,
    `target=${report.target.path}`,
    `mismatchedKeys=${report.mismatchedKeys.length > 0 ? report.mismatchedKeys.join(',') : 'none'}`,
    `blockers=${report.blockers.length > 0 ? report.blockers.join('|') : 'none'}`,
    ...report.nextActions.map(action => `next: ${action}`),
  ].join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('sync_okx_launchd_env failed:', error)
    process.exitCode = 1
  })
}
