import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type Status = 'pass' | 'watch' | 'blocked'

interface CliArgs {
  outputPath: string | null
  paperPnlDiagnosticsPath: string
  json: boolean
}

export interface DecisionContextCoverageGateStatus {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: Status
  checks: {
    contextOKCount: number
    contextStaleCount: number
    contextTimeoutCount: number
    contextLegacyMissingCount: number
    contextNewMissingCount: number
    contextTotalCount: number
    coveragePct: number
    enforcementWindowStatus: string | null
    enforcementWindowContextCoveragePct: number | null
    enforcementWindowNewMissingCount: number | null
    coverageBelowThreshold: boolean
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/decision_context_coverage_gate_status.latest.json'
const COVERAGE_THRESHOLD_PCT = 95

async function main(): Promise<void> {
  const args = parseDecisionContextCoverageGateStatusArgs(process.argv.slice(2))
  const report = await runDecisionContextCoverageGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseDecisionContextCoverageGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    paperPnlDiagnosticsPath: raw.get('paperPnlDiagnosticsPath') ?? 'data/research/paper_pnl_diagnostics.latest.json',
    json: parseBool(raw.get('json'), false),
  }
}

export async function runDecisionContextCoverageGateStatus(args: CliArgs): Promise<DecisionContextCoverageGateStatus> {
  const startedAt = new Date()
  const sourcePaths = {
    paperPnlDiagnostics: resolve(args.paperPnlDiagnosticsPath),
  }
  const paperPnlDiagnostics = asRecord(await readJsonIfExists(sourcePaths.paperPnlDiagnostics))
  const report = buildDecisionContextCoverageGateStatus({
    generatedAt: new Date().toISOString(),
    paperPnlDiagnostics,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'decision_context_coverage_gate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'pass' ? 'pass' : report.status === 'watch' ? 'warn' : 'fail',
      recordsIn: 1,
      recordsOut: 1,
      errorClass: report.blockers[0] ?? null,
    })
  }
  return report
}

export function buildDecisionContextCoverageGateStatus(input: {
  generatedAt?: string
  paperPnlDiagnostics: UnknownRecord | null
}): DecisionContextCoverageGateStatus {
  const coverage = asRecord(input.paperPnlDiagnostics?.coverage)
  const contextBuckets = readRecordArray(coverage?.contextBuckets)
  const enforcementWindow = asRecord(coverage?.contextEnforcementWindow)

  const okBucket = contextBuckets.find(b => readString(b.bucket) === 'ok')
  const staleBucket = contextBuckets.find(b => readString(b.bucket) === 'stale')
  const timeoutBucket = contextBuckets.find(b => readString(b.bucket) === 'timeout')
  const legacyMissingBucket = contextBuckets.find(b => readString(b.bucket) === 'legacy_missing')
  const newMissingBucket = contextBuckets.find(b => readString(b.bucket) === 'new_missing')

  const contextOKCount = readNumber(okBucket?.count) ?? readNumber(coverage?.okContextTrades) ?? 0
  const contextStaleCount = readNumber(staleBucket?.count) ?? readNumber(coverage?.staleContextTrades) ?? 0
  const contextTimeoutCount = readNumber(timeoutBucket?.count) ?? readNumber(coverage?.timeoutContextTrades) ?? 0
  const contextLegacyMissingCount = readNumber(legacyMissingBucket?.count) ?? readNumber(coverage?.legacyMissingContextTrades) ?? 0
  const contextNewMissingCount = readNumber(newMissingBucket?.count) ?? readNumber(coverage?.newMissingContextTrades) ?? 0
  const closedTrades = readNumber(coverage?.closedTrades) ?? 0
  const contextTotalCount = contextOKCount + contextStaleCount + contextTimeoutCount + contextLegacyMissingCount + contextNewMissingCount
  const totalCount = contextTotalCount > 0 ? contextTotalCount : closedTrades
  const coveragePct = totalCount > 0
    ? Math.round((contextOKCount + contextStaleCount) / totalCount * 10000) / 100
    : 0
  const enforcementWindowStatus = readString(enforcementWindow?.status)
  const enforcementWindowContextCoveragePct = readNumber(enforcementWindow?.contextCoveragePct)
  const enforcementWindowNewMissingCount = readNumber(enforcementWindow?.newMissingContextTrades)
  const coverageBelowThreshold = coveragePct < COVERAGE_THRESHOLD_PCT

  const diagnosticsMissing = input.paperPnlDiagnostics == null
  const blockers = [
    ...(diagnosticsMissing ? ['paper_pnl_diagnostics_missing'] : []),
    ...(coverageBelowThreshold ? [`context_coverage_below_threshold:${coveragePct}<${COVERAGE_THRESHOLD_PCT}`] : []),
    ...(enforcementWindowNewMissingCount != null && enforcementWindowNewMissingCount > 0
      ? [`enforcement_window_new_missing_context:${enforcementWindowNewMissingCount}`]
      : []),
  ]

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: diagnosticsMissing ? 'blocked' : blockers.length === 0 ? 'pass' : coverageBelowThreshold ? 'watch' : 'blocked',
    checks: {
      contextOKCount,
      contextStaleCount,
      contextTimeoutCount,
      contextLegacyMissingCount,
      contextNewMissingCount,
      contextTotalCount: totalCount,
      coveragePct,
      enforcementWindowStatus,
      enforcementWindowContextCoveragePct,
      enforcementWindowNewMissingCount,
      coverageBelowThreshold,
    },
    blockers,
    nextActions: blockers.length === 0
      ? ['Keep decision-context coverage gate in the research-evidence refresh chain; this is coverage evidence only, not trading authorization.']
      : [
          `Decision context snapshot coverage is ${coveragePct}%; block new positions until coverage reaches ${COVERAGE_THRESHOLD_PCT}%.`,
          'Ensure all new paper trades emit a decision context snapshot at open time so context coverage improves over time.',
        ],
    safetyNotes: [
      'This artifact validates decision context snapshot coverage only; it cannot authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
      'All new positions should be blocked when context coverage is below 95% to prevent trading without context evidence.',
    ],
  }
}

function renderConsoleSummary(report: DecisionContextCoverageGateStatus): string {
  return [
    `Decision context coverage gate: ${report.status}`,
    `contextOK=${report.checks.contextOKCount} total=${report.checks.contextTotalCount} coverage=${report.checks.coveragePct}%`,
    `enforcementWindow=${report.checks.enforcementWindowStatus ?? 'n/a'} enforcementCoverage=${report.checks.enforcementWindowContextCoveragePct ?? 'n/a'}%`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf-8'))
  } catch {
    return null
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    i += 1
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_decision_context_coverage_gate_status failed:', error)
    process.exit(1)
  })
}
