import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { latestEthCarryClosedOutcomesByObservationId } from './settle_eth_carry_prospective_observations.js'
import type { EthCarryProspectiveObservationOutcome } from './settle_eth_carry_prospective_observations.js'

type UnknownRecord = Record<string, unknown>

interface CliArgs {
  featurePath: string
  ledgerPath: string
  outputPath: string | null
  minClosedOutcomes: number
  json: boolean
}

interface SignalBucketDiagnostics {
  bucketId: string
  count: number
  closedOutcomes: number
  winRatePct: number | null
  meanGrossPct: number | null
  meanFundingCashflowPct: number | null
  meanRouteCostPct: number | null
  meanNetPct: number | null
}

interface ClosedDiagnosticRow {
  observationId: string
  direction: string
  decisionTime: string
  closeTime: string
  fundingSpread: number | null
  basisSpreadDiffPct: number | null
  absFundingSpread: number | null
  absBasisSpreadDiffPct: number | null
  grossPct: number
  fundingCashflowPct: number | null
  routeCostPct: number | null
  netPct: number | null
  profitableGross: boolean
  profitableNet: boolean | null
}

export interface EthCarrySignalDiagnosticsReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: 'insufficient_closed_outcomes' | 'diagnostic_ready' | 'blocked_no_inputs'
  sourceArtifacts: {
    featurePath: string
    ledgerPath: string
  }
  thresholds: {
    minClosedOutcomes: number
    requireNetPositiveBeforeResearchClaim: true
  }
  counts: {
    featureRows: number
    openEvents: number
    closedEvents: number
    closedMatchedToOpen: number
    closedDiagnosticRows: number
    routeCostAdjustedRows: number
    fundingCashflowAccountedRows: number
  }
  summary: {
    meanGrossPct: number | null
    meanNetPct: number | null
    winRateGrossPct: number | null
    winRateNetPct: number | null
    bestDirectionByMeanNet: string | null
    worstDirectionByMeanNet: string | null
    strongestPositiveBucket: string | null
    strongestNegativeBucket: string | null
  }
  byDirection: SignalBucketDiagnostics[]
  byFundingSpreadSign: SignalBucketDiagnostics[]
  byBasisSpreadSign: SignalBucketDiagnostics[]
  byConfluence: SignalBucketDiagnostics[]
  blockerAttribution: string[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_FEATURE_PATH = 'data/research/eth_carry_pit_features.latest.json'
const DEFAULT_LEDGER_PATH = 'data/research/eth_carry_prospective_observations.jsonl'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_signal_diagnostics.latest.json'
const DEFAULT_MIN_CLOSED_OUTCOMES = 30

async function main(): Promise<void> {
  const args = parseEthCarrySignalDiagnosticsArgs(process.argv.slice(2))
  const report = await runEthCarrySignalDiagnostics(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseEthCarrySignalDiagnosticsArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    featurePath: raw.get('featurePath') ?? raw.get('features') ?? DEFAULT_FEATURE_PATH,
    ledgerPath: raw.get('ledgerPath') ?? raw.get('ledger') ?? DEFAULT_LEDGER_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    minClosedOutcomes: parsePositiveInteger(raw.get('minClosedOutcomes'), DEFAULT_MIN_CLOSED_OUTCOMES, 'minClosedOutcomes'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarrySignalDiagnostics(args: CliArgs): Promise<EthCarrySignalDiagnosticsReport> {
  const startedAt = new Date()
  const featurePath = resolve(args.featurePath)
  const ledgerPath = resolve(args.ledgerPath)
  const report = buildEthCarrySignalDiagnosticsReport({
    generatedAt: new Date().toISOString(),
    featurePath,
    ledgerPath,
    featureRows: readFeatureRows(featurePath),
    ledgerExists: existsSync(ledgerPath),
    ledgerEvents: readLedgerEvents(ledgerPath),
    minClosedOutcomes: args.minClosedOutcomes,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_signal_diagnostics',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked_no_inputs' ? 'fail' : 'warn',
      recordsIn: report.counts.openEvents + report.counts.closedEvents,
      recordsOut: report.counts.closedDiagnosticRows,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildEthCarrySignalDiagnosticsReport(input: {
  generatedAt?: string
  featurePath: string
  ledgerPath: string
  featureRows: UnknownRecord[]
  ledgerExists: boolean
  ledgerEvents: UnknownRecord[]
  minClosedOutcomes: number
}): EthCarrySignalDiagnosticsReport {
  const openEvents = input.ledgerEvents.filter(event => readString(event.eventType) === 'eth_carry_prospective_decision_open')
  const closedEvents = latestEthCarryClosedOutcomesByObservationId(
    input.ledgerEvents.filter(event => readString(event.eventType) === 'eth_carry_prospective_decision_closed') as EthCarryProspectiveObservationOutcome[],
  )
  const openById = new Map(openEvents.map(event => [readString(event.observationId) ?? '', event]))
  const rows = closedEvents
    .map(closed => buildClosedDiagnosticRow(openById.get(readString(closed.observationId) ?? ''), closed))
    .filter((row): row is ClosedDiagnosticRow => row != null)
  const routeCostAdjustedRows = rows.filter(row => row.routeCostPct != null && row.netPct != null).length
  const fundingCashflowAccountedRows = rows.filter(row => row.fundingCashflowPct != null).length
  const byDirection = bucketRows(rows, row => row.direction)
  const byFundingSpreadSign = bucketRows(rows, row => signBucket(row.fundingSpread, 'funding_spread'))
  const byBasisSpreadSign = bucketRows(rows, row => signBucket(row.basisSpreadDiffPct, 'basis_spread_diff'))
  const byConfluence = bucketRows(rows, row => confluenceBucket(row))
  const allBucketRows = [...byDirection, ...byFundingSpreadSign, ...byBasisSpreadSign, ...byConfluence]
  const strongestPositiveBucket = bestBucket(allBucketRows, 'max')
  const strongestNegativeBucket = bestBucket(allBucketRows, 'min')
  const blockers = uniqueStrings([
    ...(input.featureRows.length > 0 || existsSync(input.featurePath) ? [] : ['eth_carry_pit_features_missing']),
    ...(input.ledgerExists ? [] : ['eth_carry_prospective_ledger_missing']),
    ...(openEvents.length > 0 ? [] : ['eth_carry_open_events_missing']),
    ...(closedEvents.length > 0 ? [] : ['eth_carry_closed_events_missing']),
    ...(rows.length >= input.minClosedOutcomes ? [] : [`closed_outcomes_insufficient:${rows.length}<${input.minClosedOutcomes}`]),
    ...(routeCostAdjustedRows === rows.length && rows.length > 0 ? [] : [`route_cost_adjusted_rows_incomplete:${routeCostAdjustedRows}/${rows.length}`]),
    ...(fundingCashflowAccountedRows === rows.length && rows.length > 0 ? [] : [`funding_cashflow_rows_incomplete:${fundingCashflowAccountedRows}/${rows.length}`]),
    'research_only_not_execution_evidence',
    'paper_live_execution_disabled',
  ])
  const meanNetPct = meanNullable(rows.map(row => row.netPct).filter((value): value is number => value != null))
  const status: EthCarrySignalDiagnosticsReport['status'] =
    (!input.ledgerExists && input.featureRows.length === 0)
      ? 'blocked_no_inputs'
      : rows.length >= input.minClosedOutcomes
        ? 'diagnostic_ready'
        : 'insufficient_closed_outcomes'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status,
    sourceArtifacts: {
      featurePath: resolve(input.featurePath),
      ledgerPath: resolve(input.ledgerPath),
    },
    thresholds: {
      minClosedOutcomes: input.minClosedOutcomes,
      requireNetPositiveBeforeResearchClaim: true,
    },
    counts: {
      featureRows: input.featureRows.length,
      openEvents: openEvents.length,
      closedEvents: closedEvents.length,
      closedMatchedToOpen: rows.length,
      closedDiagnosticRows: rows.length,
      routeCostAdjustedRows,
      fundingCashflowAccountedRows,
    },
    summary: {
      meanGrossPct: meanNullable(rows.map(row => row.grossPct)),
      meanNetPct,
      winRateGrossPct: winRate(rows.map(row => row.profitableGross)),
      winRateNetPct: winRate(rows.map(row => row.profitableNet).filter((value): value is boolean => value != null)),
      bestDirectionByMeanNet: bestDirection(byDirection, 'max'),
      worstDirectionByMeanNet: bestDirection(byDirection, 'min'),
      strongestPositiveBucket: strongestPositiveBucket?.bucketId ?? null,
      strongestNegativeBucket: strongestNegativeBucket?.bucketId ?? null,
    },
    byDirection,
    byFundingSpreadSign,
    byBasisSpreadSign,
    byConfluence,
    blockerAttribution: buildBlockerAttribution(rows, meanNetPct, routeCostAdjustedRows, fundingCashflowAccountedRows),
    blockers,
    nextActions: buildNextActions(rows, strongestPositiveBucket, strongestNegativeBucket),
    safetyNotes: [
      'This diagnostic is research-only and cannot authorize paper or live execution.',
      'A positive bucket here is only a debugging hint; it still requires PIT WFO, BY FDR, prospective sample size, route-cost, slippage, and paper evidence.',
      'Closed outcomes are prospective labels, not account PnL and not a profitability guarantee.',
    ],
  }
}

function buildClosedDiagnosticRow(open: UnknownRecord | undefined, closed: UnknownRecord): ClosedDiagnosticRow | null {
  if (!open) return null
  const label = asRecord(closed.label)
  const signal = asRecord(open.signal)
  const pitFeatures = asRecord(open.pitFeatures)
  const direction = readString(signal?.direction)
  const grossPct = readNumber(label?.grossCarryPairReturnPct)
  if (!direction || grossPct == null) return null
  const fundingCashflowPct = readNumber(label?.fundingCashflowPct)
  const routeCostPct = readNumber(label?.routeCostPct)
  const netPct = readNumber(label?.routeCostAdjustedNetPct)
  const fundingSpread = readNumber(pitFeatures?.fundingSpread)
  const basisSpreadDiffPct = readNumber(pitFeatures?.basisSpreadDiffPct)
  return {
    observationId: readString(closed.observationId) ?? 'unknown',
    direction,
    decisionTime: readString(closed.decisionTime) ?? readString(open.decisionTime) ?? '',
    closeTime: readString(closed.closeTime) ?? '',
    fundingSpread,
    basisSpreadDiffPct,
    absFundingSpread: fundingSpread == null ? null : Math.abs(fundingSpread),
    absBasisSpreadDiffPct: basisSpreadDiffPct == null ? null : Math.abs(basisSpreadDiffPct),
    grossPct,
    fundingCashflowPct,
    routeCostPct,
    netPct,
    profitableGross: readBoolean(label?.carrySignalProfitableGross) ?? grossPct > 0,
    profitableNet: netPct == null ? null : netPct > 0,
  }
}

function bucketRows(rows: ClosedDiagnosticRow[], bucketer: (row: ClosedDiagnosticRow) => string): SignalBucketDiagnostics[] {
  const groups = new Map<string, ClosedDiagnosticRow[]>()
  for (const row of rows) {
    const bucket = bucketer(row)
    groups.set(bucket, [...(groups.get(bucket) ?? []), row])
  }
  return [...groups.entries()]
    .map(([bucketId, bucketRows]) => {
      const netValues = bucketRows.map(row => row.netPct).filter((value): value is number => value != null)
      return {
        bucketId,
        count: bucketRows.length,
        closedOutcomes: bucketRows.length,
        winRatePct: winRate(bucketRows.map(row => row.profitableNet).filter((value): value is boolean => value != null)),
        meanGrossPct: meanNullable(bucketRows.map(row => row.grossPct)),
        meanFundingCashflowPct: meanNullable(bucketRows.map(row => row.fundingCashflowPct).filter((value): value is number => value != null)),
        meanRouteCostPct: meanNullable(bucketRows.map(row => row.routeCostPct).filter((value): value is number => value != null)),
        meanNetPct: meanNullable(netValues),
      }
    })
    .sort((left, right) => left.bucketId.localeCompare(right.bucketId))
}

function signBucket(value: number | null, label: string): string {
  if (value == null) return `${label}:missing`
  if (value > 0) return `${label}:positive`
  if (value < 0) return `${label}:negative`
  return `${label}:zero`
}

function confluenceBucket(row: ClosedDiagnosticRow): string {
  const funding = signBucket(row.fundingSpread, 'funding').split(':')[1]
  const basis = signBucket(row.basisSpreadDiffPct, 'basis').split(':')[1]
  return `confluence:funding_${funding}:basis_${basis}:direction_${row.direction}`
}

function bestBucket(rows: SignalBucketDiagnostics[], mode: 'max' | 'min'): SignalBucketDiagnostics | null {
  const finite = rows.filter(row => row.meanNetPct != null)
  if (finite.length === 0) return null
  return [...finite].sort((left, right) =>
    mode === 'max'
      ? (right.meanNetPct ?? -Infinity) - (left.meanNetPct ?? -Infinity)
      : (left.meanNetPct ?? Infinity) - (right.meanNetPct ?? Infinity),
  )[0]
}

function bestDirection(rows: SignalBucketDiagnostics[], mode: 'max' | 'min'): string | null {
  return bestBucket(rows, mode)?.bucketId ?? null
}

function buildBlockerAttribution(
  rows: ClosedDiagnosticRow[],
  meanNetPct: number | null,
  routeCostAdjustedRows: number,
  fundingCashflowAccountedRows: number,
): string[] {
  const out: string[] = []
  if (rows.length === 0) out.push('no_closed_diagnostic_rows')
  if (meanNetPct != null && meanNetPct <= 0) out.push(`mean_net_non_positive:${round(meanNetPct, 10)}`)
  const meanGrossPct = meanNullable(rows.map(row => row.grossPct))
  if (meanGrossPct != null && meanGrossPct <= 0) out.push(`mean_gross_non_positive:${round(meanGrossPct, 10)}`)
  const meanRouteCostPct = meanNullable(rows.map(row => row.routeCostPct).filter((value): value is number => value != null))
  if (meanRouteCostPct != null && meanGrossPct != null && meanRouteCostPct >= Math.abs(meanGrossPct)) {
    out.push(`route_cost_drag_gte_abs_gross:${round(meanRouteCostPct, 10)}>=${round(Math.abs(meanGrossPct), 10)}`)
  }
  if (routeCostAdjustedRows < rows.length) out.push(`route_cost_missing:${routeCostAdjustedRows}/${rows.length}`)
  if (fundingCashflowAccountedRows < rows.length) out.push(`funding_cashflow_missing:${fundingCashflowAccountedRows}/${rows.length}`)
  return uniqueStrings(out)
}

function buildNextActions(
  rows: ClosedDiagnosticRow[],
  strongestPositiveBucket: SignalBucketDiagnostics | null,
  strongestNegativeBucket: SignalBucketDiagnostics | null,
): string[] {
  const actions = [
    'Keep ETH carry research-only; use this artifact to decide what to test next, not to trade.',
    'Increase prospective closed labels before trusting direction or confluence buckets.',
  ]
  if (rows.length > 0) {
    actions.push('Compare funding-spread sign, basis-spread sign, and direction buckets before changing the carry signal rule.')
  }
  if (strongestPositiveBucket?.meanNetPct != null && strongestPositiveBucket.meanNetPct > 0) {
    actions.push(`Prototype a stricter research-only filter around ${strongestPositiveBucket.bucketId}, then rerun PIT WFO/FDR instead of promoting directly.`)
  }
  if (strongestNegativeBucket?.meanNetPct != null && strongestNegativeBucket.meanNetPct < 0) {
    actions.push(`Add a research-only avoid-list candidate for ${strongestNegativeBucket.bucketId} and verify it out-of-sample.`)
  }
  actions.push('Do not publish non-flat paper targets until release, prospective, paper telemetry, and risk gates pass.')
  return actions
}

function readFeatureRows(path: string): UnknownRecord[] {
  if (!existsSync(path)) return []
  try {
    const parsed = asRecord(JSON.parse(readFileSync(path, 'utf-8')))
    return readRecordArray(parsed?.carryFeatureRows)
  } catch {
    return []
  }
}

function readLedgerEvents(path: string): UnknownRecord[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return asRecord(JSON.parse(line))
      } catch {
        return null
      }
    })
    .filter((item): item is UnknownRecord => item != null)
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(key, next)
      index += 1
    } else {
      out.set(key, 'true')
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  const normalized = value.trim().toLowerCase()
  return normalized === '' || normalized === 'null' || normalized === 'none' || normalized === 'false' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
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
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function meanNullable(values: number[]): number | null {
  return values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 10) : null
}

function winRate(values: boolean[]): number | null {
  return values.length > 0 ? round(values.filter(Boolean).length / values.length * 100, 10) : null
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function renderConsoleSummary(report: EthCarrySignalDiagnosticsReport): string {
  return [
    `eth carry signal diagnostics: status=${report.status}`,
    `closed=${report.counts.closedDiagnosticRows}/${report.thresholds.minClosedOutcomes} meanNet=${report.summary.meanNetPct ?? 'null'} winNet=${report.summary.winRateNetPct ?? 'null'}`,
    `best=${report.summary.strongestPositiveBucket ?? 'none'} worst=${report.summary.strongestNegativeBucket ?? 'none'}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_eth_carry_signal_diagnostics failed:', error)
    process.exitCode = 1
  })
}
