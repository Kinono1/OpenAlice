import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { defaultCollectorPitRowsPath } from './lib/ohlcv_collector_pit.js'

type UnknownRecord = Record<string, unknown>
type Status = 'pass' | 'watch' | 'blocked'

interface CliArgs {
  outputPath: string | null
  ethCarryPitAuditPath: string
  ethCarryEvidencePath: string
  collectorPitRowsPath: string
  json: boolean
}

export interface PitAuditGlobalGateStatus {
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
    carryPitAuditStatus: string | null
    carryPitAuditPassingRows: number
    carryPitAuditTotalRows: number
    carryPitAuditPassRatePct: number
    carryFundingAvailableTimeStatus: string | null
    carryBasisAvailableTimeStatus: string | null
    globalPitAuditImplemented: boolean
    nonCarryStrategiesHavePitAudit: boolean
    collectorPitRowsStatus: string
    collectorPitRowsSampled: number
    collectorPitRowsPromotionUsable: number
    collectorPitRowsViolations: number
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/pit_audit_global_gate_status.latest.json'

async function main(): Promise<void> {
  const args = parsePitAuditGlobalGateStatusArgs(process.argv.slice(2))
  const report = await runPitAuditGlobalGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parsePitAuditGlobalGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    ethCarryPitAuditPath: raw.get('ethCarryPitAuditPath') ?? 'data/research/eth_carry_pit_audit.latest.json',
    ethCarryEvidencePath: raw.get('ethCarryEvidencePath') ?? 'data/research/eth_carry_research_evidence_status.latest.json',
    collectorPitRowsPath: raw.get('collectorPitRowsPath') ?? defaultCollectorPitRowsPath(),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runPitAuditGlobalGateStatus(args: CliArgs): Promise<PitAuditGlobalGateStatus> {
  const startedAt = new Date()
  const sourcePaths = {
    ethCarryPitAudit: resolve(args.ethCarryPitAuditPath),
    ethCarryEvidence: resolve(args.ethCarryEvidencePath),
    collectorPitRows: resolve(args.collectorPitRowsPath),
  }
  const ethCarryPitAudit = asRecord(await readJsonIfExists(sourcePaths.ethCarryPitAudit))
  const ethCarryEvidence = asRecord(await readJsonIfExists(sourcePaths.ethCarryEvidence))
  const collectorPitRowsAudit = await auditCollectorPitRows(sourcePaths.collectorPitRows)
  const report = buildPitAuditGlobalGateStatus({
    generatedAt: new Date().toISOString(),
    ethCarryPitAudit,
    ethCarryEvidence,
    collectorPitRowsAudit,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'pit_audit_global_gate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'pass' ? 'pass' : report.status === 'watch' ? 'warn' : 'fail',
      recordsIn: 2,
      recordsOut: 1,
      errorClass: report.blockers[0] ?? null,
    })
  }
  return report
}

export function buildPitAuditGlobalGateStatus(input: {
  generatedAt?: string
  ethCarryPitAudit: UnknownRecord | null
  ethCarryEvidence: UnknownRecord | null
  collectorPitRowsAudit?: CollectorPitRowsAudit
}): PitAuditGlobalGateStatus {
  const pitAuditStatus = readString(input.ethCarryPitAudit?.status)
  const pitAuditCounts = asRecord(input.ethCarryPitAudit?.counts)
  const carryPitAuditPassingRows = readNumber(pitAuditCounts?.passingRows) ?? 0
  const carryPitAuditTotalRows = readNumber(pitAuditCounts?.auditedRows) ?? readNumber(pitAuditCounts?.carryFeatureRows) ?? 0
  const carryPitAuditFailRows = readNumber(pitAuditCounts?.failingRows) ?? 0
  const carryPitAuditPassRatePct = carryPitAuditTotalRows > 0
    ? Math.round(carryPitAuditPassingRows / carryPitAuditTotalRows * 10000) / 100
    : 0

  const pitEvidence = asRecord(input.ethCarryEvidence?.pitEvidence)
  const carryFundingAvailableTimeStatus = readString(pitEvidence?.fundingAvailableTimeStatus)
  const carryBasisAvailableTimeStatus = readString(pitEvidence?.basisAvailableTimeStatus)

  const carryPitAuditImplemented = pitAuditStatus != null && carryPitAuditTotalRows > 0 && carryPitAuditFailRows === 0
  const collectorPitRowsAudit = input.collectorPitRowsAudit ?? {
    status: 'missing',
    sampledRows: 0,
    promotionUsableRows: 0,
    violations: ['collector_pit_rows_not_audited'],
  }
  const nonCarryStrategiesHavePitAudit = collectorPitRowsAudit.status === 'research_only_rows_present'

  const blockers = [
    ...(carryPitAuditImplemented ? [] : [
      ...(pitAuditStatus == null ? ['carry_pit_audit_artifact_missing'] : []),
      ...(carryPitAuditTotalRows === 0 ? ['carry_pit_audit_no_rows_audited'] : []),
      ...(carryPitAuditFailRows > 0 ? [`carry_pit_audit_failing_rows:${carryPitAuditFailRows}`] : []),
    ]),
    ...(carryFundingAvailableTimeStatus === 'complete' ? [] : [`carry_funding_available_time_not_complete:${carryFundingAvailableTimeStatus ?? 'missing'}`]),
    ...(carryBasisAvailableTimeStatus === 'present' ? [] : [`carry_basis_available_time_not_present:${carryBasisAvailableTimeStatus ?? 'missing'}`]),
    ...(collectorPitRowsAudit.status === 'missing' ? ['collector_pit_rows_missing_for_non_carry'] : []),
    ...(collectorPitRowsAudit.violations.length > 0
      ? collectorPitRowsAudit.violations.map(item => `collector_pit_rows:${item}`)
      : []),
    ...(!nonCarryStrategiesHavePitAudit ? ['pit_audit_not_global_only_carry_has_audit'] : []),
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
    status: blockers.length === 0 ? 'pass' : 'blocked',
    checks: {
      carryPitAuditStatus: pitAuditStatus,
      carryPitAuditPassingRows,
      carryPitAuditTotalRows,
      carryPitAuditPassRatePct,
      carryFundingAvailableTimeStatus,
      carryBasisAvailableTimeStatus,
      globalPitAuditImplemented: nonCarryStrategiesHavePitAudit,
      nonCarryStrategiesHavePitAudit,
      collectorPitRowsStatus: collectorPitRowsAudit.status,
      collectorPitRowsSampled: collectorPitRowsAudit.sampledRows,
      collectorPitRowsPromotionUsable: collectorPitRowsAudit.promotionUsableRows,
      collectorPitRowsViolations: collectorPitRowsAudit.violations.length,
    },
    blockers,
    nextActions: blockers.length === 0
      ? ['Keep PIT audit gate in the research-evidence refresh chain; this is PIT evidence only, not trading authorization.']
      : [
          'Extend PIT availableAt audit beyond carry to all strategy lanes (cross-sectional, volume breakout, microstructure).',
          'Collector row-explicit PIT sidecars are research-only; add promotion-grade source-arrival validation before paper/live.',
        ],
    safetyNotes: [
      'This artifact validates PIT audit completeness only; it cannot authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
      'PIT audit being limited to carry is a diagnostic finding; non-carry strategies still need independent PIT validation before promotion.',
    ],
  }
}

interface CollectorPitRowsAudit {
  status: 'missing' | 'research_only_rows_present' | 'invalid'
  sampledRows: number
  promotionUsableRows: number
  violations: string[]
}

async function auditCollectorPitRows(path: string): Promise<CollectorPitRowsAudit> {
  let raw: string
  try {
    raw = await readFile(resolve(path), 'utf-8')
  } catch {
    return { status: 'missing', sampledRows: 0, promotionUsableRows: 0, violations: [] }
  }
  const lines = raw.trim().split('\n').filter(Boolean).slice(-500)
  const violations: string[] = []
  let promotionUsableRows = 0
  for (const line of lines) {
    const row = asRecord(safeJsonParse(line))
    if (!row) {
      violations.push('invalid_json_row')
      continue
    }
    const eventTime = readString(row.eventTime)
    const observedAt = readString(row.observedAt)
    const availableAt = readString(row.availableAt)
    if (!eventTime || !observedAt || !availableAt) {
      violations.push('missing_row_explicit_times')
      continue
    }
    if (!timeLeq(eventTime, availableAt) || !timeLeq(eventTime, observedAt)) {
      violations.push('available_or_observed_before_event_time')
    }
    if (row.rowPITUsableForPromotion === true) promotionUsableRows += 1
  }
  return {
    status: violations.length > 0 ? 'invalid' : 'research_only_rows_present',
    sampledRows: lines.length,
    promotionUsableRows,
    violations: uniqueStrings(violations),
  }
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function timeLeq(left: string, right: string): boolean {
  const l = Date.parse(left)
  const r = Date.parse(right)
  return Number.isFinite(l) && Number.isFinite(r) && l <= r
}

function renderConsoleSummary(report: PitAuditGlobalGateStatus): string {
  return [
    `PIT audit global gate: ${report.status}`,
    `carryPitAudit=${report.checks.carryPitAuditStatus} passRows=${report.checks.carryPitAuditPassingRows}/${report.checks.carryPitAuditTotalRows} (${report.checks.carryPitAuditPassRatePct}%)`,
    `carryFunding=${report.checks.carryFundingAvailableTimeStatus} carryBasis=${report.checks.carryBasisAvailableTimeStatus}`,
    `globalAudit=${report.checks.globalPitAuditImplemented} nonCarry=${report.checks.nonCarryStrategiesHavePitAudit}`,
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

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_pit_audit_global_gate_status failed:', error)
    process.exit(1)
  })
}
