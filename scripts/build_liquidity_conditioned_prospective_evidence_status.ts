import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import type {
  LiquidityConditionedProspectiveObservationEvent,
} from './capture_liquidity_conditioned_prospective_observation.js'
import type {
  LiquidityConditionedProspectiveObservationOutcome,
} from './settle_liquidity_conditioned_prospective_observations.js'

interface CliArgs {
  ledgerPath: string
  outputPath: string | null
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
  meanGrossLongShortSpreadPct: number | null
  winRatePct: number | null
}

export interface LiquidityConditionedProspectiveEvidenceStatusReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  prospectiveOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  ledgerPath: string
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
    meanGrossLongShortSpreadPct: number | null
    medianGrossLongShortSpreadPct: number | null
    winRatePct: number | null
    positiveGrossOutcomes: number
    negativeGrossOutcomes: number
    bestGrossLongShortSpreadPct: number | null
    worstGrossLongShortSpreadPct: number | null
    meanOpenEventsPerDecisionWindow: number | null
  }
  thresholds: {
    minClosedOutcomes: number
    minNonOverlappingWindows: number
    requireRuntimeVerifiedFees: boolean
    requireRouteCostAdjustedLabels: true
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
    signalPair: string | null
  } | null
  latestClosed: {
    observationId: string
    closeTime: string
    grossLongShortSpreadPct: number
    longOutperformedShort: boolean
  } | null
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_LEDGER_PATH = 'data/research/liquidity_conditioned_prospective_observations.live_accumulated.jsonl'
const DEFAULT_OUTPUT_PATH = 'data/research/liquidity_conditioned_prospective_evidence_status.live_accumulated.latest.json'
const DEFAULT_MIN_CLOSED_OUTCOMES = 100
const DEFAULT_MIN_NON_OVERLAPPING_WINDOWS = 3

async function main(): Promise<void> {
  const args = parseLiquidityConditionedProspectiveEvidenceStatusArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runLiquidityConditionedProspectiveEvidenceStatus(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'liquidity_conditioned_prospective_evidence_status',
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

export function parseLiquidityConditionedProspectiveEvidenceStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    ledgerPath: raw.get('ledgerPath') ?? raw.get('ledger') ?? DEFAULT_LEDGER_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
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

export async function runLiquidityConditionedProspectiveEvidenceStatus(
  args: CliArgs,
): Promise<LiquidityConditionedProspectiveEvidenceStatusReport> {
  const ledgerPath = resolve(args.ledgerPath)
  const events = readLedgerEvents(ledgerPath)
  const report = buildLiquidityConditionedProspectiveEvidenceStatusReport({
    ledgerPath,
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

export function buildLiquidityConditionedProspectiveEvidenceStatusReport(input: {
  ledgerPath: string
  ledgerExists: boolean
  openEvents: LiquidityConditionedProspectiveObservationEvent[]
  closedEvents: LiquidityConditionedProspectiveObservationOutcome[]
  asOfMs: number
  thresholds: {
    minClosedOutcomes: number
    minNonOverlappingWindows: number
    requireRuntimeVerifiedFees: boolean
  }
  generatedAt?: string
}): LiquidityConditionedProspectiveEvidenceStatusReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const openById = new Map<string, LiquidityConditionedProspectiveObservationEvent>()
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
  const grossSpreads = input.closedEvents
    .map(event => event.label.grossLongShortSpreadPct)
    .filter(isFiniteNumber)
  const positiveGrossOutcomes = grossSpreads.filter(value => value > 0).length
  const negativeGrossOutcomes = grossSpreads.filter(value => value <= 0).length
  const windows = buildWindows([...openById.values()], input.closedEvents)
  const latestOpen = [...openById.values()].sort((left, right) => right.decisionBarTime - left.decisionBarTime)[0] ?? null
  const latestClosed = [...input.closedEvents].sort((left, right) => right.closeBarTime - left.closeBarTime)[0] ?? null
  const blockers = buildBlockers({
    ledgerExists: input.ledgerExists,
    closedOutcomes: input.closedEvents.length,
    nonOverlappingWindows: windows.filter(window => window.closedOutcomes > 0).length,
    thresholds: input.thresholds,
    dueOpenEventsWithoutClose,
    duplicateOpenObservationIds,
    closedWithoutOpen,
    hasRouteCostAdjustedLabels: input.closedEvents.some(event => event.label.routeCostAdjusted === true),
    runtimeFeesVerified: input.closedEvents.some(event =>
      !event.blockers.includes('runtime_fee_not_verified') &&
      event.label.routeCostAdjustmentStatus !== 'blocked_runtime_fee_not_verified',
    ),
  })
  const status: LiquidityConditionedProspectiveEvidenceStatusReport['status'] = !input.ledgerExists
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
      meanGrossLongShortSpreadPct: grossSpreads.length > 0 ? round(mean(grossSpreads), 10) : null,
      medianGrossLongShortSpreadPct: grossSpreads.length > 0 ? round(median(grossSpreads), 10) : null,
      winRatePct: grossSpreads.length > 0 ? round(positiveGrossOutcomes / grossSpreads.length * 100, 10) : null,
      positiveGrossOutcomes,
      negativeGrossOutcomes,
      bestGrossLongShortSpreadPct: grossSpreads.length > 0 ? Math.max(...grossSpreads) : null,
      worstGrossLongShortSpreadPct: grossSpreads.length > 0 ? Math.min(...grossSpreads) : null,
      meanOpenEventsPerDecisionWindow: openDecisionWindows > 0
        ? round(openById.size / openDecisionWindows, 10)
        : null,
    },
    thresholds: {
      minClosedOutcomes: input.thresholds.minClosedOutcomes,
      minNonOverlappingWindows: input.thresholds.minNonOverlappingWindows,
      requireRuntimeVerifiedFees: input.thresholds.requireRuntimeVerifiedFees,
      requireRouteCostAdjustedLabels: true,
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
          signalPair: latestOpen.signalPair
            ? `${latestOpen.signalPair.long.symbol}/${latestOpen.signalPair.short.symbol}`
            : null,
        }
      : null,
    latestClosed: latestClosed
      ? {
          observationId: latestClosed.observationId,
          closeTime: latestClosed.closeTime,
          grossLongShortSpreadPct: latestClosed.label.grossLongShortSpreadPct,
          longOutperformedShort: latestClosed.label.longOutperformedShort,
        }
      : null,
    blockers,
    nextActions: buildNextActions(input.closedEvents.length, dueOpenEventsWithoutClose),
    notes: [
      'This status summarizes prospective research labels only; it cannot authorize paper or live orders.',
      'Gross labels are not enough for promotion; runtime-verified route-cost-adjusted labels are required.',
      'Multiple observations with the same decisionBarTime are correlated and count as one decision window for promotion-style evidence.',
      'Promotion also still requires WFO/release gates, complete trial ledger, BY FDR, PIT audit, and paper execution evidence.',
    ],
  }
}

function buildWindows(
  openEvents: LiquidityConditionedProspectiveObservationEvent[],
  closedEvents: LiquidityConditionedProspectiveObservationOutcome[],
): ProspectiveEvidenceWindow[] {
  const closedByObservationId = new Map(closedEvents.map(event => [event.observationId, event]))
  const sorted = [...openEvents].sort((left, right) => left.decisionBarTime - right.decisionBarTime)
  if (sorted.length === 0) return []
  const windowCount = Math.min(3, Math.max(1, sorted.length))
  return Array.from({ length: windowCount }, (_, index) => {
    const start = Math.floor(index * sorted.length / windowCount)
    const end = Math.floor((index + 1) * sorted.length / windowCount)
    const opens = sorted.slice(start, Math.max(start + 1, end))
    const closed = opens.flatMap(event => {
      const outcome = closedByObservationId.get(event.observationId)
      return outcome ? [outcome] : []
    })
    const spreads = closed.map(event => event.label.grossLongShortSpreadPct).filter(isFiniteNumber)
    return {
      windowIndex: index,
      startTime: opens[0]?.decisionTime ?? '',
      endTime: opens[opens.length - 1]?.decisionTime ?? '',
      closedOutcomes: closed.length,
      openPending: opens.length - closed.length,
      meanGrossLongShortSpreadPct: spreads.length > 0 ? round(mean(spreads), 10) : null,
      winRatePct: spreads.length > 0 ? round(spreads.filter(value => value > 0).length / spreads.length * 100, 10) : null,
    }
  })
}

function buildBlockers(input: {
  ledgerExists: boolean
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
  hasRouteCostAdjustedLabels: boolean
  runtimeFeesVerified: boolean
}): string[] {
  const blockers: string[] = [
    'research_only_not_execution_evidence',
    'paper_live_execution_disabled',
    'not_promotion_grade_wfo_validated',
    'not_trial_ledger_fdr_validated',
    'not_pit_audit_validated',
    'not_paper_execution_evidence',
  ]
  if (!input.ledgerExists) blockers.push('prospective_observation_ledger_missing')
  if (input.closedOutcomes < input.thresholds.minClosedOutcomes) {
    blockers.push(`prospective_closed_outcomes_low:${input.closedOutcomes}<${input.thresholds.minClosedOutcomes}`)
  }
  if (input.nonOverlappingWindows < input.thresholds.minNonOverlappingWindows) {
    blockers.push(`prospective_closed_windows_low:${input.nonOverlappingWindows}<${input.thresholds.minNonOverlappingWindows}`)
  }
  if (input.dueOpenEventsWithoutClose > 0) {
    blockers.push(`prospective_due_open_events_unsettled:${input.dueOpenEventsWithoutClose}`)
  }
  if (input.duplicateOpenObservationIds > 0) {
    blockers.push(`prospective_duplicate_open_ids:${input.duplicateOpenObservationIds}`)
  }
  if (input.closedWithoutOpen > 0) {
    blockers.push(`prospective_closed_without_open:${input.closedWithoutOpen}`)
  }
  if (!input.hasRouteCostAdjustedLabels) blockers.push('prospective_route_cost_adjusted_labels_missing')
  if (input.thresholds.requireRuntimeVerifiedFees && !input.runtimeFeesVerified) {
    blockers.push('runtime_fee_not_verified')
  }
  return uniqueStrings(blockers)
}

function buildNextActions(closedOutcomes: number, dueOpenEventsWithoutClose: number): string[] {
  const actions = [
    'Run prospective observation capture after each fresh 1h live-data accumulation.',
    'Run prospective observation settle after labelDueTime to append closed research labels.',
  ]
  if (dueOpenEventsWithoutClose > 0) {
    actions.push('Settle overdue prospective observations before interpreting closed-label statistics.')
  }
  if (closedOutcomes === 0) {
    actions.push('Wait for future live-only labels; current open observations are not profitability evidence.')
  } else {
    actions.push('Review gross spread distribution, then add runtime-verified fees before using net labels.')
  }
  actions.push('Keep paper/live blocked until WFO, runtime fee, complete trial ledger, BY FDR, PIT, and paper evidence all pass.')
  return actions
}

function readLedgerEvents(path: string): {
  open: LiquidityConditionedProspectiveObservationEvent[]
  closed: LiquidityConditionedProspectiveObservationOutcome[]
} {
  if (!existsSync(path)) return { open: [], closed: [] }
  const open: LiquidityConditionedProspectiveObservationEvent[] = []
  const closed: LiquidityConditionedProspectiveObservationOutcome[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed?.eventType === 'liquidity_conditioned_prospective_decision_open') open.push(parsed)
      if (parsed?.eventType === 'liquidity_conditioned_prospective_decision_closed') closed.push(parsed)
    } catch {
      // Keep status robust to partial append or manual inspection artifacts.
    }
  }
  return { open, closed }
}

function renderConsoleSummary(report: LiquidityConditionedProspectiveEvidenceStatusReport): string {
  return [
    `liquidity prospective evidence status: status=${report.status}, open=${report.counts.openEvents}, closed=${report.counts.closedEvents}`,
    `pending=${report.counts.pendingOpenEvents}, dueUnsettled=${report.counts.dueOpenEventsWithoutClose}, winRate=${formatMaybe(report.metrics.winRatePct)}, meanGross=${formatMaybe(report.metrics.meanGrossLongShortSpreadPct)}`,
    `paper=false, live=false, promotion=false`,
    `latestOpen=${report.latestOpen ? `${report.latestOpen.signalPair ?? 'no_pair'} due=${report.latestOpen.labelDueTime}` : 'none'}`,
    `blockers=${report.blockers.slice(0, 10).join('|') || 'none'}`,
  ].join('\n')
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const tokens = argv.filter(token => token !== '--')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token?.startsWith('--')) continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      out.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = tokens[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(body, next)
      index += 1
    } else {
      out.set(body, 'true')
    }
  }
  return out
}

function parseNullablePath(raw: string | undefined): string | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  return !normalized || normalized === 'null' || normalized === 'false' || normalized === 'none'
    ? null
    : raw
}

function parseNullableTimestamp(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'null' || normalized === 'none' || normalized === 'false') return null
  const numeric = Number(raw)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
  return parsed
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function formatMaybe(value: number | null): string {
  return value == null ? 'null' : String(round(value, 4))
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_liquidity_conditioned_prospective_evidence_status failed:', error)
    process.exit(1)
  })
}
