import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { appendJsonlSync } from '../src/runtime/runtime_events.js'
import { paperSymbolToCsvFile, type PaperUniverseTimeframe } from './lib/paper_universe.js'
import type { RankIcProspectiveObservationEvent } from './capture_rank_ic_prospective_observation.js'

interface CliArgs {
  ledgerPath: string
  dataDir: string
  outputPath: string | null
  barMinutes: number
  asOfMs: number | null
  maxOutcomes: number | null
  dryRun: boolean
  json: boolean
}

interface Candle {
  time: number
  close: number
}

export interface RankIcProspectiveObservationOutcome {
  schemaVersion: 1
  eventType: 'prospective_decision_closed'
  researchOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  observationId: string
  outcomeId: string
  laneId: string
  candidateId: string
  strategyFamily: string
  filterId: string
  decisionTime: string
  decisionBarTime: number
  labelDueTime: string
  labelDueBarTime: number
  closeTime: string
  closeBarTime: number
  labelDelayHours: number
  long: {
    symbol: string
    entryPrice: number
    closePrice: number
    returnPct: number
  }
  short: {
    symbol: string
    entryPrice: number
    closePrice: number
    spotReturnPct: number
    shortReturnPct: number
  }
  label: {
    grossLongShortSpreadPct: number
    longOutperformedShort: boolean
    routeCostAdjusted: false
    routeCostAdjustedNetPct: null
    routeCostAdjustmentStatus: 'blocked_runtime_fee_not_verified'
  }
  blockers: string[]
  sourceOpenEvent: {
    dataWatermark: string
    filterAllowed: boolean
    signalPairPending: boolean
  }
}

export interface RankIcProspectiveObservationSettleReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  prospectiveOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  dryRun: boolean
  inputs: {
    ledgerPath: string
    dataDir: string
    outputPath: string | null
    barMinutes: number
    asOfMs: number | null
    maxOutcomes: number | null
  }
  status: 'settled' | 'nothing_due' | 'blocked'
  counts: {
    openEventsLoaded: number
    closedEventsLoaded: number
    openEventsConsidered: number
    dueOpenEvents: number
    notDueOpenEvents: number
    missingSignalPair: number
    missingCloseCandles: number
    outcomesBuilt: number
    appendedOutcomes: number
    skippedByMaxOutcomes: number
  }
  outcomes: RankIcProspectiveObservationOutcome[]
  appendResults: Array<{
    observationId: string
    outcomeId: string | null
    appended: boolean
    reason: 'dry_run' | 'duplicate_outcome' | 'missing_close_candle' | 'missing_signal_pair' | 'appended' | 'blocked'
  }>
  blockers: string[]
  notes: string[]
}

const DEFAULT_LEDGER_PATH = 'data/research/rank_ic_prospective_observations.live_accumulated_fwd72_median_filter.jsonl'
const DEFAULT_DATA_DIR = 'data/market/live_accumulated'
const DEFAULT_OUTPUT_PATH = 'data/research/rank_ic_prospective_observation_settle.live_accumulated_fwd72_median_filter.latest.json'

async function main(): Promise<void> {
  const args = parseRankIcProspectiveObservationSettleArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runRankIcProspectiveObservationSettle(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'rank_ic_prospective_observation_settle',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked' ? 'fail' : report.counts.outcomesBuilt > 0 ? 'warn' : 'warn',
      recordsIn: report.counts.openEventsLoaded,
      recordsOut: report.counts.appendedOutcomes,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseRankIcProspectiveObservationSettleArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    ledgerPath: raw.get('ledgerPath') ?? raw.get('ledger') ?? DEFAULT_LEDGER_PATH,
    dataDir: raw.get('dataDir') ?? DEFAULT_DATA_DIR,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    barMinutes: parsePositiveInteger(raw.get('barMinutes'), 60, 'barMinutes'),
    asOfMs: parseNullableTimestamp(raw.get('asOf')),
    maxOutcomes: parseNullablePositiveInteger(raw.get('maxOutcomes'), null, 'maxOutcomes'),
    dryRun: parseBool(raw.get('dryRun'), true),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runRankIcProspectiveObservationSettle(
  args: CliArgs,
): Promise<RankIcProspectiveObservationSettleReport> {
  const ledgerPath = resolve(args.ledgerPath)
  const dataDir = resolve(args.dataDir)
  const events = readProspectiveLedgerEvents(ledgerPath)
  const report = await buildRankIcProspectiveObservationSettleReport({
    ledgerPath,
    dataDir,
    outputPath: args.outputPath ? resolve(args.outputPath) : null,
    openEvents: events.open,
    closedEvents: events.closed,
    args,
    generatedAt: new Date().toISOString(),
  })

  if (!args.dryRun && report.status !== 'blocked') {
    for (const outcome of report.outcomes) {
      appendJsonlSync(ledgerPath, outcome)
    }
    if (report.outcomes.length > 0) {
      report.counts.appendedOutcomes = report.outcomes.length
      report.appendResults = report.appendResults.map(result =>
        result.outcomeId && result.reason === 'dry_run'
          ? { ...result, appended: true, reason: 'appended' }
          : result,
      )
    }
  }

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export async function buildRankIcProspectiveObservationSettleReport(input: {
  ledgerPath: string
  dataDir: string
  outputPath: string | null
  openEvents: RankIcProspectiveObservationEvent[]
  closedEvents: RankIcProspectiveObservationOutcome[]
  args: Pick<CliArgs, 'barMinutes' | 'asOfMs' | 'maxOutcomes' | 'dryRun'>
  generatedAt?: string
}): Promise<RankIcProspectiveObservationSettleReport> {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const asOfMs = input.args.asOfMs ?? Date.now()
  const closedIds = new Set(input.closedEvents.map(event => event.observationId))
  const openEvents = input.openEvents.filter(event => !closedIds.has(event.observationId))
  const outcomes: RankIcProspectiveObservationOutcome[] = []
  const appendResults: RankIcProspectiveObservationSettleReport['appendResults'] = []
  let notDueOpenEvents = 0
  let missingSignalPair = 0
  let missingCloseCandles = 0
  let skippedByMaxOutcomes = 0
  const blockers: string[] = []

  if (!existsSync(input.ledgerPath)) blockers.push('prospective_observation_ledger_missing')

  for (const event of openEvents) {
    if (input.args.maxOutcomes != null && outcomes.length >= input.args.maxOutcomes) {
      skippedByMaxOutcomes += 1
      continue
    }
    if (event.labelDueBarTime > asOfMs) {
      notDueOpenEvents += 1
      continue
    }
    if (!event.signalPair) {
      missingSignalPair += 1
      appendResults.push({
        observationId: event.observationId,
        outcomeId: null,
        appended: false,
        reason: 'missing_signal_pair',
      })
      continue
    }
    const longClose = await loadCloseAtOrAfter(input.dataDir, event.signalPair.long.symbol, input.args.barMinutes, event.labelDueBarTime)
    const shortClose = await loadCloseAtOrAfter(input.dataDir, event.signalPair.short.symbol, input.args.barMinutes, event.labelDueBarTime)
    if (!longClose || !shortClose) {
      missingCloseCandles += 1
      appendResults.push({
        observationId: event.observationId,
        outcomeId: null,
        appended: false,
        reason: 'missing_close_candle',
      })
      continue
    }
    const closeBarTime = Math.max(longClose.time, shortClose.time)
    const outcome = buildOutcome(event, longClose, shortClose, closeBarTime)
    outcomes.push(outcome)
    appendResults.push({
      observationId: event.observationId,
      outcomeId: outcome.outcomeId,
      appended: false,
      reason: input.args.dryRun ? 'dry_run' : 'appended',
    })
  }

  const dueOpenEvents = openEvents.filter(event => event.labelDueBarTime <= asOfMs).length
  const status: RankIcProspectiveObservationSettleReport['status'] = blockers.length > 0
    ? 'blocked'
    : outcomes.length > 0
      ? 'settled'
      : 'nothing_due'

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    dryRun: input.args.dryRun,
    inputs: {
      ledgerPath: resolve(input.ledgerPath),
      dataDir: resolve(input.dataDir),
      outputPath: input.outputPath ? resolve(input.outputPath) : null,
      barMinutes: input.args.barMinutes,
      asOfMs: input.args.asOfMs,
      maxOutcomes: input.args.maxOutcomes,
    },
    status,
    counts: {
      openEventsLoaded: input.openEvents.length,
      closedEventsLoaded: input.closedEvents.length,
      openEventsConsidered: openEvents.length,
      dueOpenEvents,
      notDueOpenEvents,
      missingSignalPair,
      missingCloseCandles,
      outcomesBuilt: outcomes.length,
      appendedOutcomes: 0,
      skippedByMaxOutcomes,
    },
    outcomes,
    appendResults,
    blockers: uniqueStrings(blockers),
    notes: [
      'Settled outcomes are research-only labels for previously captured prospective observations.',
      'The gross long-short spread is not route-cost adjusted because runtime-verified fee evidence is still required.',
      'This artifact cannot authorize paper or live orders.',
    ],
  }
}

function buildOutcome(
  event: RankIcProspectiveObservationEvent,
  longClose: Candle,
  shortClose: Candle,
  closeBarTime: number,
): RankIcProspectiveObservationOutcome {
  const pair = event.signalPair!
  const longReturnPct = (longClose.close / pair.long.currentPrice - 1) * 100
  const shortSpotReturnPct = (shortClose.close / pair.short.currentPrice - 1) * 100
  const shortReturnPct = -shortSpotReturnPct
  const grossLongShortSpreadPct = longReturnPct - shortSpotReturnPct
  const outcomeId = createHash('sha256')
    .update(`${event.observationId}|${closeBarTime}|${longClose.close}|${shortClose.close}`)
    .digest('hex')
    .slice(0, 24)
  return {
    schemaVersion: 1,
    eventType: 'prospective_decision_closed',
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    observationId: event.observationId,
    outcomeId,
    laneId: event.laneId,
    candidateId: event.candidateId,
    strategyFamily: event.strategyFamily,
    filterId: event.filterId,
    decisionTime: event.decisionTime,
    decisionBarTime: event.decisionBarTime,
    labelDueTime: event.labelDueTime,
    labelDueBarTime: event.labelDueBarTime,
    closeTime: new Date(closeBarTime).toISOString(),
    closeBarTime,
    labelDelayHours: event.labelDelayHours,
    long: {
      symbol: pair.long.symbol,
      entryPrice: pair.long.currentPrice,
      closePrice: longClose.close,
      returnPct: round(longReturnPct, 10),
    },
    short: {
      symbol: pair.short.symbol,
      entryPrice: pair.short.currentPrice,
      closePrice: shortClose.close,
      spotReturnPct: round(shortSpotReturnPct, 10),
      shortReturnPct: round(shortReturnPct, 10),
    },
    label: {
      grossLongShortSpreadPct: round(grossLongShortSpreadPct, 10),
      longOutperformedShort: grossLongShortSpreadPct > 0,
      routeCostAdjusted: false,
      routeCostAdjustedNetPct: null,
      routeCostAdjustmentStatus: 'blocked_runtime_fee_not_verified',
    },
    blockers: [
      'prospective_outcome_not_execution_evidence',
      'paper_live_execution_disabled',
      'runtime_fee_not_verified',
      'route_cost_adjusted_label_missing',
    ],
    sourceOpenEvent: {
      dataWatermark: event.dataWatermark,
      filterAllowed: event.filter.allowed,
      signalPairPending: event.signalPair?.labelStatus === 'pending_future_close',
    },
  }
}

async function loadCloseAtOrAfter(
  dataDir: string,
  symbol: string,
  barMinutes: number,
  targetTime: number,
): Promise<Candle | null> {
  const path = join(dataDir, paperSymbolToCsvFile(symbol, timeframeForBarMinutes(barMinutes)))
  if (!existsSync(path)) return null
  const raw = await readFile(path, 'utf-8')
  const lines = raw.trim().split('\n').filter(Boolean)
  if (lines.length <= 1) return null
  const header = lines[0].split(',')
  const timeIndex = header.indexOf('timestamp')
  const closeIndex = header.indexOf('close')
  return lines.slice(1)
    .map(line => {
      const cols = line.split(',')
      return {
        time: Number(cols[timeIndex]),
        close: Number(cols[closeIndex]),
      }
    })
    .filter(candle => candle.time >= targetTime && candle.close > 0 && [candle.time, candle.close].every(Number.isFinite))
    .sort((left, right) => left.time - right.time)[0] ?? null
}

function readProspectiveLedgerEvents(path: string): {
  open: RankIcProspectiveObservationEvent[]
  closed: RankIcProspectiveObservationOutcome[]
} {
  if (!existsSync(path)) return { open: [], closed: [] }
  const open: RankIcProspectiveObservationEvent[] = []
  const closed: RankIcProspectiveObservationOutcome[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed?.eventType === 'prospective_decision_open') open.push(parsed)
      if (parsed?.eventType === 'prospective_decision_closed') closed.push(parsed)
    } catch {
      // Ignore malformed ledger rows; append-only research ledgers must stay readable.
    }
  }
  return { open, closed }
}

function timeframeForBarMinutes(barMinutes: number): PaperUniverseTimeframe {
  if (barMinutes === 60) return '1h'
  if (barMinutes === 5) return '5m'
  if (barMinutes * 60 === 1) return '1s'
  throw new Error(`Unsupported barMinutes for paper universe files: ${barMinutes}`)
}

function renderConsoleSummary(report: RankIcProspectiveObservationSettleReport): string {
  return [
    `rank ic prospective observation settle: status=${report.status}, dryRun=${report.dryRun}, outcomes=${report.counts.outcomesBuilt}, appended=${report.counts.appendedOutcomes}`,
    `open=${report.counts.openEventsLoaded}, closed=${report.counts.closedEventsLoaded}, due=${report.counts.dueOpenEvents}, notDue=${report.counts.notDueOpenEvents}`,
    `paper=false, live=false, promotion=false`,
    ...report.outcomes.slice(0, 5).map(outcome =>
      `${outcome.observationId} ${outcome.long.symbol}/${outcome.short.symbol} grossSpread=${outcome.label.grossLongShortSpreadPct} close=${outcome.closeTime}`,
    ),
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

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
  return parsed
}

function parseNullablePositiveInteger(raw: string | undefined, fallback: number | null, name: string): number | null {
  if (raw == null || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'null' || normalized === 'none' || normalized === 'false') return null
  return parsePositiveInteger(raw, fallback ?? 1, name)
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

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('settle_rank_ic_prospective_observations failed:', error)
    process.exit(1)
  })
}
