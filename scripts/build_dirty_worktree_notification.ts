import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface DirtyNotificationState {
  schemaVersion: 'dirty_worktree_notification_state.v2'
  lastFingerprint: string | null
  lastStatus: 'blocked' | 'clean' | 'invalid' | null
  lastNotifiedAt: string | null
  lastRecoveryFingerprint: string | null
}

export interface DirtyNotificationResult {
  schemaVersion: 'dirty_worktree_notification.v2'
  generatedAt: string
  purpose: 'canonical_release' | 'legacy_wip' | 'unknown'
  sourceMode: string
  status: 'blocked' | 'clean' | 'invalid'
  shouldNotify: boolean
  deliveryDecision: 'notify' | 'suppress'
  notificationReason: 'invalid_audit' | 'state_changed' | 'weekly_reminder' | 'recovered' | 'unchanged_clean' | 'unchanged_blocked'
  fingerprint: string
  headline: string
  fullText: string
  blockingReasons: string[]
  trustBlockingReasons: string[]
  planBlockingReasons: string[]
  statePath: string
  legacyWipSummary: { total: number; statusHash: string | null } | null
}

export interface BuildNotificationOptions {
  reportPath: string
  planPath: string
  manifestCoveragePath: string
  notificationPath: string
  statePath?: string
  now?: Date
  previousState?: Partial<DirtyNotificationState>
  legacyReportPath?: string
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(String(value))
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function loadState(path: string, previous?: Partial<DirtyNotificationState>): DirtyNotificationState {
  const existing = readJson(path) ?? {}
  return {
    schemaVersion: 'dirty_worktree_notification_state.v2',
    lastFingerprint: typeof (previous?.lastFingerprint ?? existing.lastFingerprint) === 'string'
      ? (previous?.lastFingerprint ?? existing.lastFingerprint) as string
      : null,
    lastStatus: (previous?.lastStatus ?? existing.lastStatus) === 'blocked'
      || (previous?.lastStatus ?? existing.lastStatus) === 'clean'
      || (previous?.lastStatus ?? existing.lastStatus) === 'invalid'
      ? (previous?.lastStatus ?? existing.lastStatus) as DirtyNotificationState['lastStatus']
      : null,
    lastNotifiedAt: typeof (previous?.lastNotifiedAt ?? existing.lastNotifiedAt) === 'string'
      ? (previous?.lastNotifiedAt ?? existing.lastNotifiedAt) as string
      : null,
    lastRecoveryFingerprint: typeof (previous?.lastRecoveryFingerprint ?? existing.lastRecoveryFingerprint) === 'string'
      ? (previous?.lastRecoveryFingerprint ?? existing.lastRecoveryFingerprint) as string
      : null,
  }
}

export function buildDirtyWorktreeNotification(options: BuildNotificationOptions): DirtyNotificationResult {
  const now = options.now ?? new Date()
  const generatedAt = now.toISOString()
  const report = readJson(resolve(options.reportPath))
  const plan = readJson(resolve(options.planPath))
  const coverage = readJson(resolve(options.manifestCoveragePath))
  const legacyReport = options.legacyReportPath ? readJson(resolve(options.legacyReportPath)) : null
  const statePath = resolve(options.statePath ?? `${options.notificationPath}.state.json`)
  const state = loadState(statePath, options.previousState)
  const reportCounts = asRecord(report?.counts)
  const byProtocol = asRecord(reportCounts.byProtocolClass)
  const scopeCounts = asRecord(reportCounts.scopeCounts)
  const governance = asRecord(report?.governance)
  const total = num(reportCounts.total)
  const a = num(byProtocol.A)
  const b = num(byProtocol.B)
  const c = num(byProtocol.C)
  const d = num(byProtocol.D)
  const deletedTracked = num(scopeCounts.deletedTrackedTotal)
  const promotionRelevant = num(scopeCounts.promotionRelevantTotal)
  const ordinary = [
    ...stringArray(governance.blockingReasons),
    ...stringArray(coverage?.blockingReasons),
  ]
  const trust = stringArray(coverage?.trustBlockingReasons)
  const planBlockers = stringArray(plan?.blockingReasons)
  const blockingReasons = [...new Set([...ordinary, ...trust, ...planBlockers])].sort()
  const coverageStatus = typeof coverage?.status === 'string' ? coverage.status : 'missing'
  const evidenceUsability = typeof coverage?.evidenceUsabilityStatus === 'string'
    ? coverage.evidenceUsabilityStatus
    : 'missing'
  const reportValid = isAuditReport(report)
  const planValid = isPlanReport(plan)
  const coverageValid = isCoverageReport(coverage)
  const status: DirtyNotificationResult['status'] = !reportValid || !coverageValid || !planValid
    ? 'invalid'
    : blockingReasons.length > 0
      || total > 0
      || coverageStatus !== 'complete'
      || evidenceUsability !== 'pass'
      ? 'blocked'
      : 'clean'
  const purpose = report?.purpose === 'canonical_release' || report?.purpose === 'legacy_wip'
    ? report.purpose
    : 'unknown'
  const sourceMode = typeof report?.sourceMode === 'string' ? report.sourceMode : 'git_worktree'
  const branch = typeof report?.branch === 'string' ? report.branch : null
  const commit = typeof report?.commit === 'string' ? report.commit : null
  const statusHash = typeof report?.statusHash === 'string' ? report.statusHash : null
  const identity = {
    purpose,
    sourceMode,
    branch,
    commit,
    statusHash,
    total,
    a,
    b,
    c,
    d,
    deletedTracked,
    promotionRelevant,
    coverageStatus,
    evidenceUsability,
    blockingReasons,
    legacyWip: legacyReport ? {
      total: num(asRecord(legacyReport.counts).total),
      statusHash: typeof legacyReport.statusHash === 'string' ? legacyReport.statusHash : null,
    } : null,
  }
  const currentFingerprint = fingerprint(identity)
  const previousFingerprint = state.lastFingerprint
  const materialStateChange = previousFingerprint !== currentFingerprint
  const lastNotifiedMs = state.lastNotifiedAt ? Date.parse(state.lastNotifiedAt) : NaN
  const weeklyDue = status === 'blocked'
    && Number.isFinite(lastNotifiedMs)
    && now.getTime() - lastNotifiedMs >= WEEK_MS
  const recovered = status === 'clean' && state.lastStatus === 'blocked'
  const invalid = status === 'invalid'
  const shouldNotify = invalid || materialStateChange || weeklyDue || recovered
  const notificationReason: DirtyNotificationResult['notificationReason'] = invalid
    ? 'invalid_audit'
    : recovered
      ? 'recovered'
      : materialStateChange
        ? 'state_changed'
        : weeklyDue
          ? 'weekly_reminder'
          : status === 'clean'
            ? 'unchanged_clean'
            : 'unchanged_blocked'
  const trustText = trust.length > 0 ? trust.slice(0, 12).join('|') : 'none'
  const ordinaryText = ordinary.length > 0 ? [...new Set(ordinary)].slice(0, 12).join('|') : 'none'
  const planText = planBlockers.length > 0 ? planBlockers.slice(0, 12).join('|') : 'none'
  const effectiveText = blockingReasons.length > 0 ? blockingReasons.slice(0, 20).join('|') : 'none'
  const coverageTrustWarning = coverageStatus === 'complete' && evidenceUsability !== 'pass'
    ? ' Manifest coverage complete, but evidence trust blocked.'
    : ''
  const legacyText = legacyReport
    ? ` Legacy WIP audit: total=${num(asRecord(legacyReport.counts).total)}, statusHash=${typeof legacyReport.statusHash === 'string' ? legacyReport.statusHash : 'unknown'}; legacy_wip is preserved and excluded from canonical trust.`
    : ''
  const fullText = status === 'invalid'
    ? `OpenAlice audit invalid or missing. purpose=${purpose}, sourceMode=${sourceMode}. Fail-closed; inspect audit, coverage, and quarantine plan artifacts.`
    : `OpenAlice audit completed. purpose=${purpose}, sourceMode=${sourceMode}, branch=${branch ?? 'unknown'}, commit=${commit ?? 'unknown'}, statusHash=${statusHash ?? 'unknown'}, total=${total}, A=${a}, B=${b}, C=${c}, D=${d}, deletedTracked=${deletedTracked}, promotionRelevant=${promotionRelevant}. manifestCoverage=${coverageStatus}, evidenceUsability=${evidenceUsability}.${coverageTrustWarning} blockingReasons=${ordinaryText}. trustBlockingReasons=${trustText}. planBlockingReasons=${planText}. effectiveBlockingReasons=${effectiveText}. promotionAllowed=false, paperTradingAllowed=false, liveTradingAllowed=false. Do not use git add .${legacyText}`
  return {
    schemaVersion: 'dirty_worktree_notification.v2',
    generatedAt,
    purpose,
    sourceMode,
    status,
    shouldNotify,
    deliveryDecision: shouldNotify ? 'notify' : 'suppress',
    notificationReason,
    fingerprint: currentFingerprint,
    headline: `OpenAlice ${purpose} audit: status=${status}, total=${total}, A=${a}, B=${b}, C=${c}, D=${d}, coverage=${coverageStatus}, trust=${evidenceUsability}`,
    fullText,
    blockingReasons,
    trustBlockingReasons: trust,
    planBlockingReasons: planBlockers,
    statePath,
    legacyWipSummary: legacyReport ? {
      total: num(asRecord(legacyReport.counts).total),
      statusHash: typeof legacyReport.statusHash === 'string' ? legacyReport.statusHash : null,
    } : null,
  }
}

function isAuditReport(value: Record<string, unknown> | null): boolean {
  if (!value) return false
  const purpose = value.purpose
  const sourceMode = value.sourceMode
  const counts = asRecord(value.counts)
  const governance = asRecord(value.governance)
  return (purpose === 'canonical_release' || purpose === 'legacy_wip')
    && (sourceMode === 'git_worktree'
      || sourceMode === 'clean_worktree'
      || sourceMode === 'verified_release')
    && typeof value.statusHash === 'string'
    && typeof counts.total === 'number'
    && Array.isArray(governance.blockingReasons)
}

function isPlanReport(value: Record<string, unknown> | null): boolean {
  return Boolean(value && Array.isArray(value.blockingReasons))
}

function isCoverageReport(value: Record<string, unknown> | null): boolean {
  if (!value) return false
  const coverageStatus = value.status
  const evidenceUsability = value.evidenceUsabilityStatus
  return (coverageStatus === 'complete' || coverageStatus === 'blocked')
    && (evidenceUsability === 'pass'
      || evidenceUsability === 'quarantine_blocked'
      || evidenceUsability === 'fail_blocked'
      || evidenceUsability === 'missing_or_invalid_blocked')
    && Array.isArray(value.blockingReasons)
    && Array.isArray(value.trustBlockingReasons)
}

export async function writeDirtyWorktreeNotification(
  options: BuildNotificationOptions,
): Promise<DirtyNotificationResult> {
  const result = buildDirtyWorktreeNotification(options)
  const statePath = resolve(result.statePath)
  const previous = loadState(statePath)
  const next: DirtyNotificationState = {
    schemaVersion: 'dirty_worktree_notification_state.v2',
    lastFingerprint: result.fingerprint,
    lastStatus: result.status,
    lastNotifiedAt: result.shouldNotify ? result.generatedAt : previous.lastNotifiedAt,
    lastRecoveryFingerprint: result.status === 'clean' && result.shouldNotify
      ? result.fingerprint
      : previous.lastRecoveryFingerprint,
  }
  await mkdir(dirname(resolve(options.notificationPath)), { recursive: true })
  await mkdir(dirname(statePath), { recursive: true })
  const notificationBytes = `${JSON.stringify(result, null, 2)}\n`
  const stateBytes = `${JSON.stringify(next, null, 2)}\n`
  const notificationTmp = `${resolve(options.notificationPath)}.${process.pid}.tmp`
  const stateTmp = `${statePath}.${process.pid}.tmp`
  await writeFile(notificationTmp, notificationBytes, { encoding: 'utf8', mode: 0o600 })
  await writeFile(stateTmp, stateBytes, { encoding: 'utf8', mode: 0o600 })
  await rename(notificationTmp, resolve(options.notificationPath))
  await rename(stateTmp, statePath)
  return result
}

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i]?.startsWith('--')) continue
    const key = argv[i]!.slice(2)
    const value = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true'
    out.set(key, value)
  }
  return out
}

if (process.argv[1]?.endsWith('build_dirty_worktree_notification.ts')) {
  const args = parseArgs(process.argv.slice(2))
  const required = (key: string): string => {
    const value = args.get(key)
    if (!value) throw new Error(`missing --${key}`)
    return value
  }
  writeDirtyWorktreeNotification({
    reportPath: required('report'),
    planPath: required('plan'),
    manifestCoveragePath: required('coverage'),
    notificationPath: required('notification'),
    statePath: args.get('state'),
    legacyReportPath: args.get('legacy-report'),
  }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
