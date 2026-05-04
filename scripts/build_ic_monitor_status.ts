import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_IC_MONITOR_CONFIG,
  FactorIcMonitor,
  type FactorIcMonitorConfig,
  type IcDecayMetrics,
  type IcMonitorSnapshot,
} from '../src/domain/strategy/factors/index.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

const DEFAULT_OUTPUT_PATH = 'data/runtime/ic_monitor_status.latest.json'
const DEFAULT_SNAPSHOT_PATH = 'data/runtime/ic_monitor_snapshot.latest.json'

export interface IcMonitorStatusArgs {
  snapshotPath: string
  outputPath: string | null
  asOfMs: number | null
  json: boolean
}

export type IcMonitorPromotionStatus =
  | 'ready'
  | 'warmup'
  | 'no_data'
  | 'missing_snapshot'
  | 'decayed'
  | 'disabled'

export interface IcMonitorStatusReport {
  schemaVersion: 1
  generatedAt: string
  snapshotPath: string
  snapshotPresent: boolean
  config: FactorIcMonitorConfig
  status: IcMonitorPromotionStatus
  promotionEligible: boolean
  usableForPaperExecution: boolean
  sampleCountTotal: number
  returnCount: number
  symbolCount: number
  symbols: string[]
  factorCount: number
  minimumSampleCount: number
  warmupWindowsRequired: number
  warmupWindowsObserved: number
  factors: Array<IcDecayMetrics & {
    promotionStatus: 'ready' | 'warmup' | 'decayed'
    blockedReasons: string[]
  }>
  blockingReasons: string[]
  nextActions: string[]
  governance: {
    promotionAllowedByThisArtifact: false
    liveTradingAllowedByThisArtifact: false
    paperExecutionAllowedByThisArtifact: false
    notes: string[]
  }
}

export function parseIcMonitorStatusArgs(argv: string[]): IcMonitorStatusArgs {
  const raw = parseRawArgs(argv)
  return {
    snapshotPath: raw.get('snapshotPath') ?? DEFAULT_SNAPSHOT_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    asOfMs: parseNullableNumber(raw.get('asOfMs')),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runIcMonitorStatus(args: IcMonitorStatusArgs): Promise<IcMonitorStatusReport> {
  const startedAt = new Date()
  const snapshotPath = resolve(args.snapshotPath)
  const snapshot = await readSnapshotIfExists(snapshotPath)
  const report = buildIcMonitorStatusReport({
    snapshot,
    snapshotPath,
    snapshotPresent: existsSync(snapshotPath),
    asOfMs: args.asOfMs ?? undefined,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'ic_monitor_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.promotionEligible ? 'pass' : 'warn',
      recordsIn: report.sampleCountTotal,
      recordsOut: report.factors.length,
      errorClass: report.promotionEligible ? null : report.status,
    })
  }

  return report
}

export function buildIcMonitorStatusReport(input: {
  snapshot?: IcMonitorSnapshot | null
  snapshotPath: string
  snapshotPresent?: boolean
  config?: FactorIcMonitorConfig
  generatedAt?: string
  asOfMs?: number
}): IcMonitorStatusReport {
  const config = input.config ?? DEFAULT_IC_MONITOR_CONFIG
  const snapshot = input.snapshot ?? null
  const snapshotPresent = input.snapshotPresent ?? snapshot != null
  const sampleCountTotal = snapshot?.signals.length ?? 0
  const returnCount = snapshot?.returns.length ?? 0
  const symbols = extractSymbols(snapshot)
  const factorNames = [...new Set((snapshot?.signals ?? []).map(signal => signal.factor))].sort()
  const warmupWindowsObserved = countWarmupWindows(snapshot)
  const monitor = new FactorIcMonitor(config)
  if (snapshot) {
    monitor.importSnapshot(snapshot)
  }
  const asOfMs = input.asOfMs ?? latestTimestamp(snapshot)
  const factorMetrics = symbols.flatMap(symbol =>
    factorNames
      .filter(factor => snapshotHasFactorForSymbol(snapshot, factor, symbol))
      .map(factor => {
        const metrics = monitor.detectDecay(factor, asOfMs, symbol)
        const symbolWarmupWindowsObserved = countWarmupWindows(snapshot, symbol)
        const blockedReasons = buildFactorBlockedReasons(
          metrics,
          config,
          symbolWarmupWindowsObserved,
        )
        return {
          ...metrics,
          promotionStatus: blockedReasons.length === 0
            ? 'ready' as const
            : metrics.decayStatus === 'decayed' && metrics.sampleCount >= config.minSampleCount
              ? 'decayed' as const
              : 'warmup' as const,
          blockedReasons,
        }
      }),
  )
  const blockingReasons = buildBlockingReasons({
    snapshotPresent,
    config,
    sampleCountTotal,
    returnCount,
    factorCount: factorNames.length,
    warmupWindowsObserved,
    factorMetrics,
  })
  const status = classifyIcStatus({
    snapshotPresent,
    config,
    sampleCountTotal,
    returnCount,
    factorCount: factorNames.length,
    warmupWindowsObserved,
    factorMetrics,
    blockingReasons,
  })
  const promotionEligible = status === 'ready'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    snapshotPath: resolve(input.snapshotPath),
    snapshotPresent,
    config,
    status,
    promotionEligible,
    usableForPaperExecution: promotionEligible,
    sampleCountTotal,
    returnCount,
    symbolCount: symbols.length,
    symbols,
    factorCount: factorNames.length,
    minimumSampleCount: config.minSampleCount,
    warmupWindowsRequired: config.warmupWindows,
    warmupWindowsObserved,
    factors: factorMetrics,
    blockingReasons,
    nextActions: nextActionsForStatus(status),
    governance: {
      promotionAllowedByThisArtifact: false,
      liveTradingAllowedByThisArtifact: false,
      paperExecutionAllowedByThisArtifact: false,
      notes: [
        'This artifact reports IC monitor readiness only; it does not authorize trading or promotion by itself.',
        'IC readiness requires PIT-safe signal/return pairs, minimum samples, and completed warmup windows.',
        'Shadow mode IC can support diagnostics; promotion still requires release gate and P1/P2 evidence.',
      ],
    },
  }
}

function buildBlockingReasons(input: {
  snapshotPresent: boolean
  config: FactorIcMonitorConfig
  sampleCountTotal: number
  returnCount: number
  factorCount: number
  warmupWindowsObserved: number
  factorMetrics: IcMonitorStatusReport['factors']
}): string[] {
  const reasons: string[] = []
  if (!input.config.enabled) reasons.push('ic_monitor_disabled')
  if (!input.snapshotPresent) reasons.push('ic_monitor_snapshot_missing')
  if (input.factorCount === 0) reasons.push('ic_factor_signals_missing')
  if (input.returnCount === 0) reasons.push('ic_realized_returns_missing')
  if (input.sampleCountTotal < input.config.minSampleCount) {
    reasons.push(`ic_sample_count_below_minimum:${input.sampleCountTotal}<${input.config.minSampleCount}`)
  }
  if (input.warmupWindowsObserved < input.config.warmupWindows) {
    reasons.push(`ic_warmup_windows_below_minimum:${input.warmupWindowsObserved}<${input.config.warmupWindows}`)
  }
  for (const factor of input.factorMetrics) {
    const symbolPrefix = factor.symbol ? `symbol:${factor.symbol}:` : ''
    reasons.push(...factor.blockedReasons.map(reason => `${symbolPrefix}factor:${factor.factorName}:${reason}`))
  }
  return [...new Set(reasons)]
}

function buildFactorBlockedReasons(
  metrics: IcDecayMetrics,
  config: FactorIcMonitorConfig,
  warmupWindowsObserved: number,
): string[] {
  const reasons: string[] = []
  if (metrics.sampleCount < config.minSampleCount) {
    reasons.push(`sample_count_below_minimum:${metrics.sampleCount}<${config.minSampleCount}`)
  }
  if (warmupWindowsObserved < config.warmupWindows) {
    reasons.push(`warmup_windows_below_minimum:${warmupWindowsObserved}<${config.warmupWindows}`)
  }
  if (metrics.decayStatus === 'decayed') {
    reasons.push('ic_decay_status:decayed')
  }
  if (metrics.decayStatus === 'warning') {
    reasons.push('ic_decay_status:warning')
  }
  return reasons
}

function classifyIcStatus(input: {
  snapshotPresent: boolean
  config: FactorIcMonitorConfig
  sampleCountTotal: number
  returnCount: number
  factorCount: number
  warmupWindowsObserved: number
  factorMetrics: IcMonitorStatusReport['factors']
  blockingReasons: string[]
}): IcMonitorPromotionStatus {
  if (!input.config.enabled) return 'disabled'
  if (!input.snapshotPresent) return 'missing_snapshot'
  if (input.factorCount === 0 || input.returnCount === 0) return 'no_data'
  if (
    input.sampleCountTotal < input.config.minSampleCount ||
    input.warmupWindowsObserved < input.config.warmupWindows
  ) {
    return 'warmup'
  }
  if (input.factorMetrics.some(factor => factor.promotionStatus === 'decayed')) return 'decayed'
  return input.blockingReasons.length === 0 ? 'ready' : 'warmup'
}

function countWarmupWindows(snapshot: IcMonitorSnapshot | null, symbol?: string): number {
  if (!snapshot) return 0
  const windows = new Set<string>()
  const normalizedFilter = symbol ? normalizeSnapshotSymbol(symbol) : null
  for (const signal of snapshot.signals) {
    const normalizedSymbol = normalizeSnapshotSymbol(signal.symbol)
    if (normalizedFilter && normalizedSymbol !== normalizedFilter) continue
    windows.add(`${normalizedSymbol}|${signal.timestamp}`)
  }
  return windows.size
}

function latestTimestamp(snapshot: IcMonitorSnapshot | null): number | undefined {
  if (!snapshot) return undefined
  const timestamps = [
    ...snapshot.signals.map(signal => signal.timestamp),
    ...snapshot.returns.map(item => item.timestamp),
  ].filter(Number.isFinite)
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined
}

function extractSymbols(snapshot: IcMonitorSnapshot | null): string[] {
  if (!snapshot) return []
  const symbols = new Set<string>()
  for (const signal of snapshot.signals) symbols.add(normalizeSnapshotSymbol(signal.symbol))
  for (const record of snapshot.returns) symbols.add(normalizeSnapshotSymbol(record.symbol))
  return [...symbols].sort()
}

function snapshotHasFactorForSymbol(
  snapshot: IcMonitorSnapshot | null,
  factor: string,
  symbol: string,
): boolean {
  return (snapshot?.signals ?? []).some(
    signal => signal.factor === factor && normalizeSnapshotSymbol(signal.symbol) === symbol,
  )
}

function normalizeSnapshotSymbol(symbol: string | undefined): string {
  const normalized = symbol?.trim()
  return normalized ? normalized : '__legacy__'
}

function nextActionsForStatus(status: IcMonitorPromotionStatus): string[] {
  if (status === 'ready') {
    return ['Keep writing PIT-safe IC snapshots and monitor for decay before promotion review.']
  }
  if (status === 'missing_snapshot') {
    return ['Persist runtime icMonitorSnapshot from evaluateRuntimeFactorSnapshot into data/runtime/ic_monitor_snapshot.latest.json.']
  }
  if (status === 'no_data') {
    return ['Record both factor signals and realized future returns before interpreting IC.']
  }
  if (status === 'warmup') {
    return ['Continue shadow collection until sampleCount and warmup windows meet minimum thresholds.']
  }
  if (status === 'decayed') {
    return ['Keep decayed factors out of promotion and review factor hypothesis or regime conditioning.']
  }
  return ['Enable IC monitor only in shadow mode until sufficient evidence exists.']
}

async function readSnapshotIfExists(path: string): Promise<IcMonitorSnapshot | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    return normalizeSnapshot(raw)
  } catch {
    return null
  }
}

function normalizeSnapshot(raw: unknown): IcMonitorSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<IcMonitorSnapshot>
  if (!Array.isArray(value.signals) || !Array.isArray(value.returns)) return null
  return {
    version: typeof value.version === 'number' ? value.version : 0,
    signals: value.signals.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const record = item as {
        factor?: unknown
        value?: unknown
        timestamp?: unknown
        symbol?: unknown
      }
      return typeof record.factor === 'string' &&
        typeof record.value === 'number' &&
        Number.isFinite(record.value) &&
        typeof record.timestamp === 'number' &&
        Number.isFinite(record.timestamp)
        ? [{
            factor: record.factor,
            value: record.value,
            timestamp: record.timestamp,
            symbol: typeof record.symbol === 'string' ? record.symbol : undefined,
          }]
        : []
    }),
    returns: value.returns.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const record = item as { value?: unknown; timestamp?: unknown; symbol?: unknown }
      return typeof record.value === 'number' &&
        Number.isFinite(record.value) &&
        typeof record.timestamp === 'number' &&
        Number.isFinite(record.timestamp)
        ? [{
            value: record.value,
            timestamp: record.timestamp,
            symbol: typeof record.symbol === 'string' ? record.symbol : undefined,
          }]
        : []
    }),
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    i++
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : value
}

function parseNullableNumber(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

export function renderIcMonitorStatusMarkdown(report: IcMonitorStatusReport): string {
  const lines: string[] = []
  lines.push('# IC Monitor Status')
  lines.push('')
  lines.push(`Generated: \`${report.generatedAt}\``)
  lines.push(`Status: \`${report.status}\``)
  lines.push(`Promotion eligible: \`${report.promotionEligible}\``)
  lines.push(`Samples: ${report.sampleCountTotal}`)
  lines.push(`Returns: ${report.returnCount}`)
  lines.push(`Factors: ${report.factorCount}`)
  lines.push('')
  if (report.blockingReasons.length > 0) {
    lines.push('## Blocking Reasons')
    lines.push('')
    for (const reason of report.blockingReasons) lines.push(`- \`${reason}\``)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseIcMonitorStatusArgs(argv)
  const report = await runIcMonitorStatus(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderIcMonitorStatusMarkdown(report))
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
