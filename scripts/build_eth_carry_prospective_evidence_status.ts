import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import type { EthCarryProspectiveObservationEvent } from './capture_eth_carry_prospective_observation.js'
import {
  latestEthCarryClosedOutcomesByObservationId,
  type EthCarryProspectiveObservationOutcome,
} from './settle_eth_carry_prospective_observations.js'

interface CliArgs {
  ledgerPath: string
  outputPath: string | null
  pitAuditPath: string
  asOfMs: number | null
  minClosedOutcomes: number
  minNonOverlappingWindows: number
  requireRuntimeVerifiedFees: boolean
  json: boolean
}

interface ProspectiveEvidenceWindow {
  windowIndex: number
  startTime: string
  endTime: string
  closedOutcomes: number
  openPending: number
  meanGrossCarryPairReturnPct: number | null
  winRatePct: number | null
}

export interface EthCarryProspectiveEvidenceStatusReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  prospectiveOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  ledgerPath: string
  pitAuditPath: string
  status: 'collecting' | 'has_closed_labels' | 'blocked_no_ledger'
  asOfTime: string
  counts: {
    openEvents: number
    closedEvents: number
    uniqueOpenObservationIds: number
    duplicateOpenObservationIds: number
    pendingOpenEvents: number
    dueOpenEventsWithoutClose: number
    closedMatchedToOpen: number
    closedWithoutOpen: number
    openDecisionWindows: number
    closedDecisionWindows: number
  }
  metrics: {
    closedOutcomes: number
    meanGrossCarryPairReturnPct: number | null
    medianGrossCarryPairReturnPct: number | null
    winRatePct: number | null
    positiveGrossOutcomes: number
    negativeGrossOutcomes: number
    bestGrossCarryPairReturnPct: number | null
    worstGrossCarryPairReturnPct: number | null
    meanOpenEventsPerDecisionWindow: number | null
    routeCostAdjustedClosedOutcomes: number
    fundingCashflowAccountedClosedOutcomes: number
  }
  thresholds: {
    minClosedOutcomes: number
    minNonOverlappingWindows: number
    requireRuntimeVerifiedFees: boolean
    requireRouteCostAdjustedLabels: true
    requireFundingCashflowLabels: true
    requireBasisSpreadFeature: true
    requirePromotionGradeWfo: true
    requireCompleteTrialLedger: true
    requireByFdr: true
    requirePitAudit: true
  }
  windows: ProspectiveEvidenceWindow[]
  latestOpen: {
    observationId: string
    decisionTime: string
    labelDueTime: string
    direction: string | null
  } | null
  latestClosed: {
    observationId: string
    closeTime: string
    grossCarryPairReturnPct: number
    carrySignalProfitableGross: boolean
  } | null
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_LEDGER_PATH = 'data/research/eth_carry_prospective_observations.jsonl'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_prospective_evidence_status.latest.json'
const DEFAULT_PIT_AUDIT_PATH = 'data/research/eth_carry_pit_audit.latest.json'
const DEFAULT_MIN_CLOSED_OUTCOMES = 100
const DEFAULT_MIN_NON_OVERLAPPING_WINDOWS = 3

async function main(): Promise<void> {
  const args = parseEthCarryProspectiveEvidenceStatusArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runEthCarryProspectiveEvidenceStatus(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_prospective_evidence_status',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked_no_ledger' ? 'fail' : 'warn',
      recordsIn: report.counts.openEvents + report.counts.closedEvents,
      recordsOut: report.metrics.closedOutcomes,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseEthCarryProspectiveEvidenceStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    ledgerPath: raw.get('ledgerPath') ?? raw.get('ledger') ?? DEFAULT_LEDGER_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    pitAuditPath: raw.get('pitAuditPath') ?? DEFAULT_PIT_AUDIT_PATH,
    asOfMs: parseNullableTimestamp(raw.get('asOf')),
    minClosedOutcomes: parsePositiveInteger(raw.get('minClosedOutcomes'), DEFAULT_MIN_CLOSED_OUTCOMES, 'minClosedOutcomes'),
    minNonOverlappingWindows: parsePositiveInteger(
      raw.get('minNonOverlappingWindows'),
      DEFAULT_MIN_NON_OVERLAPPING_WINDOWS,
      'minNonOverlappingWindows',
    ),
    requireRuntimeVerifiedFees: parseBool(raw.get('requireRuntimeVerifiedFees'), true),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryProspectiveEvidenceStatus(
  args: CliArgs,
): Promise<EthCarryProspectiveEvidenceStatusReport> {
  const ledgerPath = resolve(args.ledgerPath)
  const events = readLedgerEvents(ledgerPath)
  const pitAudit = readJsonIfExists(resolve(args.pitAuditPath))
  const report = buildEthCarryProspectiveEvidenceStatusReport({
    ledgerPath,
    pitAuditPath: resolve(args.pitAuditPath),
    pitAudit,
    ledgerExists: existsSync(ledgerPath),
    openEvents: events.open,
    closedEvents: events.closed,
    asOfMs: args.asOfMs ?? Date.now(),
    thresholds: {
      minClosedOutcomes: args.minClosedOutcomes,
      minNonOverlappingWindows: args.minNonOverlappingWindows,
      requireRuntimeVerifiedFees: args.requireRuntimeVerifiedFees,
    },
    generatedAt: new Date().toISOString(),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildEthCarryProspectiveEvidenceStatusReport(input: {
  ledgerPath: string
  pitAuditPath: string
  pitAudit: unknown
  ledgerExists: boolean
  openEvents: EthCarryProspectiveObservationEvent[]
  closedEvents: EthCarryProspectiveObservationOutcome[]
  asOfMs: number
  thresholds: {
    minClosedOutcomes: number
    minNonOverlappingWindows: number
    requireRuntimeVerifiedFees: boolean
  }
  generatedAt?: string
}): EthCarryProspectiveEvidenceStatusReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const openById = new Map<string, EthCarryProspectiveObservationEvent>()
  let duplicateOpenObservationIds = 0
  for (const event of input.openEvents) {
    if (openById.has(event.observationId)) duplicateOpenObservationIds += 1
    else openById.set(event.observationId, event)
  }
  const closedByObservationId = new Map(input.closedEvents.map(event => [event.observationId, event]))
  const pendingOpen = [...openById.values()].filter(event => !closedByObservationId.has(event.observationId))
  const pendingOpenEvents = pendingOpen.filter(event => event.labelDueBarTime > input.asOfMs).length
  const dueOpenEventsWithoutClose = pendingOpen.filter(event => event.labelDueBarTime <= input.asOfMs).length
  const closedMatchedToOpen = input.closedEvents.filter(event => openById.has(event.observationId)).length
  const closedWithoutOpen = input.closedEvents.length - closedMatchedToOpen
  const openDecisionWindows = new Set([...openById.values()].map(event => event.decisionBarTime)).size
  const closedDecisionWindows = new Set(input.closedEvents.map(event => event.decisionBarTime)).size
  const grossReturns = input.closedEvents
    .map(event => event.label.grossCarryPairReturnPct)
    .filter(isFiniteNumber)
  const positiveGrossOutcomes = grossReturns.filter(value => value > 0).length
  const negativeGrossOutcomes = grossReturns.filter(value => value <= 0).length
  const routeCostAdjustedClosedOutcomes = input.closedEvents.filter(event => event.label.routeCostAdjusted === true).length
  const fundingCashflowAccountedClosedOutcomes = input.closedEvents.filter(event => event.label.fundingCashflowAccounted === true).length
  const windows = buildWindows([...openById.values()], input.closedEvents)
  const latestOpen = [...openById.values()].sort((left, right) => right.decisionBarTime - left.decisionBarTime)[0] ?? null
  const latestClosed = [...input.closedEvents].sort((left, right) => right.closeBarTime - left.closeBarTime)[0] ?? null
  const blockers = buildBlockers({
    pitAudit: asRecord(input.pitAudit),
    ledgerExists: input.ledgerExists,
    openEvents: input.openEvents.length,
    closedOutcomes: input.closedEvents.length,
    nonOverlappingWindows: windows.filter(window => window.closedOutcomes > 0).length,
    thresholds: input.thresholds,
    dueOpenEventsWithoutClose,
    duplicateOpenObservationIds,
    closedWithoutOpen,
    routeCostAdjustedClosedOutcomes,
    fundingCashflowAccountedClosedOutcomes,
  })
  const status: EthCarryProspectiveEvidenceStatusReport['status'] = !input.ledgerExists
    ? 'blocked_no_ledger'
    : input.closedEvents.length > 0
      ? 'has_closed_labels'
      : 'collecting'

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    ledgerPath: resolve(input.ledgerPath),
    pitAuditPath: resolve(input.pitAuditPath),
    status,
    asOfTime: new Date(input.asOfMs).toISOString(),
    counts: {
      openEvents: input.openEvents.length,
      closedEvents: input.closedEvents.length,
      uniqueOpenObservationIds: openById.size,
      duplicateOpenObservationIds,
      pendingOpenEvents,
      dueOpenEventsWithoutClose,
      closedMatchedToOpen,
      closedWithoutOpen,
      openDecisionWindows,
      closedDecisionWindows,
    },
    metrics: {
      closedOutcomes: input.closedEvents.length,
      meanGrossCarryPairReturnPct: grossReturns.length > 0 ? round(mean(grossReturns), 10) : null,
      medianGrossCarryPairReturnPct: grossReturns.length > 0 ? round(median(grossReturns), 10) : null,
      winRatePct: grossReturns.length > 0 ? round(positiveGrossOutcomes / grossReturns.length * 100, 10) : null,
      positiveGrossOutcomes,
      negativeGrossOutcomes,
      bestGrossCarryPairReturnPct: grossReturns.length > 0 ? Math.max(...grossReturns) : null,
      worstGrossCarryPairReturnPct: grossReturns.length > 0 ? Math.min(...grossReturns) : null,
      meanOpenEventsPerDecisionWindow: openDecisionWindows > 0
        ? round(openById.size / openDecisionWindows, 10)
        : null,
      routeCostAdjustedClosedOutcomes,
      fundingCashflowAccountedClosedOutcomes,
    },
    thresholds: {
      minClosedOutcomes: input.thresholds.minClosedOutcomes,
      minNonOverlappingWindows: input.thresholds.minNonOverlappingWindows,
      requireRuntimeVerifiedFees: input.thresholds.requireRuntimeVerifiedFees,
      requireRouteCostAdjustedLabels: true,
      requireFundingCashflowLabels: true,
      requireBasisSpreadFeature: true,
      requirePromotionGradeWfo: true,
      requireCompleteTrialLedger: true,
      requireByFdr: true,
      requirePitAudit: true,
    },
    windows,
    latestOpen: latestOpen
      ? {
          observationId: latestOpen.observationId,
          decisionTime: latestOpen.decisionTime,
          labelDueTime: latestOpen.labelDueTime,
          direction: latestOpen.signal?.direction ?? null,
        }
      : null,
    latestClosed: latestClosed
      ? {
          observationId: latestClosed.observationId,
          closeTime: latestClosed.closeTime,
          grossCarryPairReturnPct: latestClosed.label.grossCarryPairReturnPct,
          carrySignalProfitableGross: latestClosed.label.carrySignalProfitableGross,
        }
      : null,
    blockers,
    nextActions: [
      'Keep capturing ETH carry prospective observations only from PIT feature rows with decisionTime > availableAt.',
      'Settle observations only after labelDueTime and add funding-cashflow plus route-cost reconciliation before any promotion review.',
      'Do not use open observations or this status artifact to authorize paper/live execution.',
    ],
    notes: [
      'This status summarizes ETH carry prospective research labels only; it cannot authorize paper or live orders.',
      'Closed decision windows, not raw open events, are the relevant count for promotion-style prospective evidence.',
      'Funding cashflow and route costs remain explicit blockers until reconciled from PIT data.',
    ],
  }
}

function buildBlockers(input: {
  pitAudit: UnknownRecord | null
  ledgerExists: boolean
  openEvents: number
  closedOutcomes: number
  nonOverlappingWindows: number
  thresholds: {
    minClosedOutcomes: number
    minNonOverlappingWindows: number
    requireRuntimeVerifiedFees: boolean
  }
  dueOpenEventsWithoutClose: number
  duplicateOpenObservationIds: number
  closedWithoutOpen: number
  routeCostAdjustedClosedOutcomes: number
  fundingCashflowAccountedClosedOutcomes: number
}): string[] {
  const pitAuditStatus = readString(input.pitAudit?.status)
  return uniqueStrings([
    ...(input.ledgerExists ? [] : ['prospective_observation_ledger_missing']),
    ...(input.openEvents > 0 ? [] : ['prospective_open_observations_missing']),
    'research_only_not_execution_evidence',
    'paper_live_execution_disabled',
    'not_promotion_grade_wfo_validated',
    'not_trial_ledger_fdr_validated',
    ...(pitAuditStatus === 'pass' ? [] : ['not_pit_audit_validated']),
    'not_paper_execution_evidence',
    ...(input.closedOutcomes >= input.thresholds.minClosedOutcomes
      ? []
      : [`prospective_closed_outcomes_low:${input.closedOutcomes}<${input.thresholds.minClosedOutcomes}`]),
    ...(input.nonOverlappingWindows >= input.thresholds.minNonOverlappingWindows
      ? []
      : [`prospective_closed_windows_low:${input.nonOverlappingWindows}<${input.thresholds.minNonOverlappingWindows}`]),
    ...(input.routeCostAdjustedClosedOutcomes === input.closedOutcomes && input.closedOutcomes > 0
      ? []
      : ['prospective_route_cost_adjusted_labels_missing']),
    ...(input.fundingCashflowAccountedClosedOutcomes === input.closedOutcomes && input.closedOutcomes > 0
      ? []
      : ['prospective_funding_cashflow_labels_missing']),
    ...(input.thresholds.requireRuntimeVerifiedFees &&
      (input.routeCostAdjustedClosedOutcomes === 0 || input.closedOutcomes === 0)
      ? ['runtime_fee_not_verified']
      : []),
    ...(input.dueOpenEventsWithoutClose > 0 ? [`due_open_events_without_close:${input.dueOpenEventsWithoutClose}`] : []),
    ...(input.duplicateOpenObservationIds > 0 ? [`duplicate_open_observation_ids:${input.duplicateOpenObservationIds}`] : []),
    ...(input.closedWithoutOpen > 0 ? [`closed_without_open:${input.closedWithoutOpen}`] : []),
  ])
}

function buildWindows(
  openEvents: EthCarryProspectiveObservationEvent[],
  closedEvents: EthCarryProspectiveObservationOutcome[],
): ProspectiveEvidenceWindow[] {
  const decisionTimes = [...new Set([
    ...openEvents.map(event => event.decisionBarTime),
    ...closedEvents.map(event => event.decisionBarTime),
  ])].sort((left, right) => left - right)
  return decisionTimes.map((decisionTime, index) => {
    const closed = closedEvents.filter(event => event.decisionBarTime === decisionTime)
    const openPending = openEvents.filter(event => event.decisionBarTime === decisionTime).length - closed.length
    const grossReturns = closed
      .map(event => event.label.grossCarryPairReturnPct)
      .filter(isFiniteNumber)
    return {
      windowIndex: index,
      startTime: new Date(decisionTime).toISOString(),
      endTime: new Date(decisionTime).toISOString(),
      closedOutcomes: closed.length,
      openPending: Math.max(0, openPending),
      meanGrossCarryPairReturnPct: grossReturns.length > 0 ? round(mean(grossReturns), 10) : null,
      winRatePct: grossReturns.length > 0
        ? round(grossReturns.filter(value => value > 0).length / grossReturns.length * 100, 10)
        : null,
    }
  })
}

function readJsonIfExists(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf-8'))
  } catch {
    return null
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function readLedgerEvents(path: string): {
  open: EthCarryProspectiveObservationEvent[]
  closed: EthCarryProspectiveObservationOutcome[]
} {
  const resolvedPath = resolve(path)
  if (!existsSync(resolvedPath)) return { open: [], closed: [] }
  const open: EthCarryProspectiveObservationEvent[] = []
  const closed: EthCarryProspectiveObservationOutcome[] = []
  for (const line of readFileSync(resolvedPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as {
        eventType?: string
      }
      if (parsed.eventType === 'eth_carry_prospective_decision_open') open.push(parsed as EthCarryProspectiveObservationEvent)
      if (parsed.eventType === 'eth_carry_prospective_decision_closed') closed.push(parsed as EthCarryProspectiveObservationOutcome)
    } catch {
      // Ignore malformed historical lines; this status summarizes parseable research observations.
    }
  }
  return { open, closed: latestEthCarryClosedOutcomesByObservationId(closed) }
}

function renderConsoleSummary(report: EthCarryProspectiveEvidenceStatusReport): string {
  return [
    `eth carry prospective evidence: status=${report.status}`,
    `open=${report.counts.openEvents}, closed=${report.counts.closedEvents}, closedOutcomes=${report.metrics.closedOutcomes}`,
    `paper=${report.paperTradingAllowed}, live=${report.liveTradingAllowed}, promotion=${report.promotionEligible}`,
    report.blockers.length > 0 ? `blockers=${report.blockers.join(',')}` : 'blockers=[]',
  ].join('\n')
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      parsed.set(key, next)
      index += 1
    } else {
      parsed.set(key, 'true')
    }
  }
  return parsed
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  if (value === 'null' || value === 'none' || value === '') return null
  return value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  if (['1', 'true', 'yes'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no'].includes(value.toLowerCase())) return false
  return fallback
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function parseNullableTimestamp(value: string | undefined): number | null {
  if (value == null || value === 'null') return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid timestamp: ${value}`)
  return parsed
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint]
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('build_eth_carry_prospective_evidence_status failed:', error)
    process.exitCode = 1
  })
}
