import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { appendJsonlSync } from '../src/runtime/runtime_events.js'
import { paperSymbolToCsvFile, type PaperUniverseTimeframe } from './lib/paper_universe.js'
import type { EthCarryProspectiveObservationEvent } from './capture_eth_carry_prospective_observation.js'

interface CliArgs {
  ledgerPath: string
  dataDir: string
  feeSnapshotRefreshPath: string
  feeSnapshotPath: string
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

interface RouteCostEvidence {
  runtimeFeeStatus: string | null
  evidenceSource: 'refresh' | 'snapshot_fallback' | null
  makerFeeBps: number | null
  takerFeeBps: number | null
  sourceFetchedAt: string | null
  expiresAt: string | null
  routeCostAdjusted: boolean
  routeCostPct: number | null
}

export type EthCarryProspectiveLedgerEvent =
  | EthCarryProspectiveObservationEvent
  | EthCarryProspectiveObservationOutcome

export interface EthCarryProspectiveObservationOutcome {
  schemaVersion: 1
  eventType: 'eth_carry_prospective_decision_closed'
  researchOnly: true
  prospectiveOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  observationId: string
  outcomeId: string
  candidateId: 'eth_btc_pit_basis_funding_carry'
  strategyFamily: 'funding_carry_rebuild'
  decisionTime: string
  decisionBarTime: number
  labelDueTime: string
  labelDueBarTime: number
  closeTime: string
  closeBarTime: number
  labelDelayHours: number
  long: {
    symbol: 'ETH-USDT' | 'BTC-USDT'
    entryPrice: number
    closePrice: number
    returnPct: number
  }
  short: {
    symbol: 'ETH-USDT' | 'BTC-USDT'
    entryPrice: number
    closePrice: number
    spotReturnPct: number
    shortReturnPct: number
  }
  label: {
    grossCarryPairReturnPct: number
    carrySignalProfitableGross: boolean
    fundingCashflowAccounted: boolean
    fundingCashflowPct: number | null
    fundingCashflowEvents: number
    fundingCashflowStatus:
      | 'accounted_from_pit_next_funding_time'
      | 'accounted_no_funding_event_in_label_window'
      | 'blocked_requires_pit_funding_cashflow_reconciliation'
    routeCostAdjusted: boolean
    routeCostPct: number | null
    routeCostAdjustedNetPct: number | null
    routeCostAdjustmentStatus:
      | 'adjusted_with_runtime_verified_fee_snapshot'
      | 'blocked_runtime_fee_not_verified'
  }
  blockers: string[]
  restatement?: {
    restatedAt: string
    originalOutcomeId: string
    reason: 'route_cost_adjustment_restatement'
    feeSnapshotSourceFetchedAt: string | null
    feeSnapshotExpiresAt: string | null
    routeCostPct: number
  }
  sourceOpenEvent: {
    featureId: string
    featureAvailableAt: string
    decisionAfterFeatureAvailableAt: boolean
    direction: 'short_eth_long_btc' | 'long_eth_short_btc'
  }
}

export interface EthCarryProspectiveObservationSettleReport {
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
    feeSnapshotRefreshPath: string
    feeSnapshotPath: string
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
    missingSignal: number
    missingCloseCandles: number
    outcomesBuilt: number
    appendedOutcomes: number
    skippedByMaxOutcomes: number
  }
  outcomes: EthCarryProspectiveObservationOutcome[]
  appendResults: Array<{
    observationId: string
    outcomeId: string | null
    appended: boolean
    reason: 'dry_run' | 'duplicate_outcome' | 'missing_close_candle' | 'missing_signal' | 'appended' | 'blocked'
  }>
  blockers: string[]
  notes: string[]
}

const DEFAULT_LEDGER_PATH = 'data/research/eth_carry_prospective_observations.jsonl'
const DEFAULT_DATA_DIR = 'data/market/live_accumulated'
const DEFAULT_FEE_SNAPSHOT_REFRESH_PATH = 'data/runtime/fee_snapshot_refresh.latest.json'
const DEFAULT_FEE_SNAPSHOT_PATH = 'data/runtime/fee_snapshot.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_prospective_observation_settle.latest.json'

async function main(): Promise<void> {
  const args = parseEthCarryProspectiveObservationSettleArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runEthCarryProspectiveObservationSettle(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_prospective_observation_settle',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked' ? 'fail' : 'warn',
      recordsIn: report.counts.openEventsLoaded,
      recordsOut: report.counts.appendedOutcomes,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseEthCarryProspectiveObservationSettleArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    ledgerPath: raw.get('ledgerPath') ?? raw.get('ledger') ?? DEFAULT_LEDGER_PATH,
    dataDir: raw.get('dataDir') ?? DEFAULT_DATA_DIR,
    feeSnapshotRefreshPath: raw.get('feeSnapshotRefreshPath') ?? raw.get('feePath') ?? DEFAULT_FEE_SNAPSHOT_REFRESH_PATH,
    feeSnapshotPath: raw.get('feeSnapshotPath') ?? DEFAULT_FEE_SNAPSHOT_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    barMinutes: parsePositiveInteger(raw.get('barMinutes'), 60, 'barMinutes'),
    asOfMs: parseNullableTimestamp(raw.get('asOf')),
    maxOutcomes: parseNullablePositiveInteger(raw.get('maxOutcomes'), null, 'maxOutcomes'),
    dryRun: parseBool(raw.get('dryRun'), true),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryProspectiveObservationSettle(
  args: CliArgs,
): Promise<EthCarryProspectiveObservationSettleReport> {
  const ledgerPath = resolve(args.ledgerPath)
  const dataDir = resolve(args.dataDir)
  const events = readLedgerEvents(ledgerPath)
  const asOfMs = args.asOfMs ?? Date.now()
  const feeEvidence = readFeeEvidence(resolve(args.feeSnapshotRefreshPath), resolve(args.feeSnapshotPath), asOfMs)
  const report = await buildEthCarryProspectiveObservationSettleReport({
    ledgerPath,
    dataDir,
    feeSnapshotRefreshPath: resolve(args.feeSnapshotRefreshPath),
    feeSnapshotPath: resolve(args.feeSnapshotPath),
    feeEvidence,
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
        result.outcomeId && (result.reason === 'dry_run' || result.reason === 'appended')
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

export async function buildEthCarryProspectiveObservationSettleReport(input: {
  ledgerPath: string
  dataDir: string
  feeSnapshotRefreshPath: string
  feeSnapshotPath: string
  feeEvidence: RouteCostEvidence
  outputPath: string | null
  openEvents: EthCarryProspectiveObservationEvent[]
  closedEvents: EthCarryProspectiveObservationOutcome[]
  args: Pick<CliArgs, 'barMinutes' | 'asOfMs' | 'maxOutcomes' | 'dryRun'>
  generatedAt?: string
}): Promise<EthCarryProspectiveObservationSettleReport> {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const asOfMs = input.args.asOfMs ?? Date.now()
  const closedIds = new Set(input.closedEvents.map(event => event.observationId))
  const openEvents = input.openEvents.filter(event => !closedIds.has(event.observationId))
  const outcomes: EthCarryProspectiveObservationOutcome[] = []
  const appendResults: EthCarryProspectiveObservationSettleReport['appendResults'] = []
  let notDueOpenEvents = 0
  let missingSignal = 0
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
    if (!event.signal) {
      missingSignal += 1
      appendResults.push({
        observationId: event.observationId,
        outcomeId: null,
        appended: false,
        reason: 'missing_signal',
      })
      continue
    }
    const longClose = loadCloseAtOrAfter(input.dataDir, event.signal.long.symbol, input.args.barMinutes, event.labelDueBarTime)
    const shortClose = loadCloseAtOrAfter(input.dataDir, event.signal.short.symbol, input.args.barMinutes, event.labelDueBarTime)
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
    const outcome = buildOutcome(event, longClose, shortClose, closeBarTime, input.feeEvidence)
    outcomes.push(outcome)
    appendResults.push({
      observationId: event.observationId,
      outcomeId: outcome.outcomeId,
      appended: false,
      reason: input.args.dryRun ? 'dry_run' : 'appended',
    })
  }

  const dueOpenEvents = openEvents.filter(event => event.labelDueBarTime <= asOfMs).length
  if (missingSignal > 0) blockers.push(`due_open_events_missing_signal:${missingSignal}`)
  if (missingCloseCandles > 0) blockers.push(`due_open_events_missing_close_candles:${missingCloseCandles}`)
  const status: EthCarryProspectiveObservationSettleReport['status'] = blockers.length > 0
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
      ledgerPath: input.ledgerPath,
      dataDir: input.dataDir,
      feeSnapshotRefreshPath: input.feeSnapshotRefreshPath,
      feeSnapshotPath: input.feeSnapshotPath,
      outputPath: input.outputPath,
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
      missingSignal,
      missingCloseCandles,
      outcomesBuilt: outcomes.length,
      appendedOutcomes: 0,
      skippedByMaxOutcomes,
    },
    outcomes,
    appendResults,
    blockers: uniqueStrings(blockers),
    notes: [
      'Settled ETH carry labels are research-only outcomes for previously captured prospective observations.',
      'When runtime fee and PIT funding schedule evidence are available, labels include conservative route cost and funding cashflow fields.',
      'Closed labels cannot authorize paper or live orders.',
    ],
  }
}

function buildOutcome(
  event: EthCarryProspectiveObservationEvent,
  longClose: Candle,
  shortClose: Candle,
  closeBarTime: number,
  feeEvidence: RouteCostEvidence,
): EthCarryProspectiveObservationOutcome {
  if (!event.signal) throw new Error('cannot build outcome without signal')
  const longReturnPct = priceReturnPct(event.signal.long.entryPrice, longClose.close)
  const shortSpotReturnPct = priceReturnPct(event.signal.short.entryPrice, shortClose.close)
  const shortReturnPct = -shortSpotReturnPct
  const grossCarryPairReturnPct = round(longReturnPct + shortReturnPct, 10)
  const fundingCashflow = computeFundingCashflow(event, closeBarTime)
  const routeCost = computeRouteCost(feeEvidence)
  const routeCostAdjustedNetPct = routeCost.routeCostAdjusted
    ? round(grossCarryPairReturnPct + (fundingCashflow.fundingCashflowPct ?? 0) - (routeCost.routeCostPct ?? 0), 10)
    : null
  const labelBlockers = [
    ...(fundingCashflow.fundingCashflowAccounted ? [] : ['funding_cashflow_reconciliation_missing']),
    ...(routeCost.routeCostAdjusted ? [] : ['route_cost_adjusted_label_missing']),
  ]
  return {
    schemaVersion: 1,
    eventType: 'eth_carry_prospective_decision_closed',
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    observationId: event.observationId,
    outcomeId: hashId(['eth_carry_prospective_outcome', event.observationId, String(closeBarTime)]),
    candidateId: event.candidateId,
    strategyFamily: event.strategyFamily,
    decisionTime: event.decisionTime,
    decisionBarTime: event.decisionBarTime,
    labelDueTime: event.labelDueTime,
    labelDueBarTime: event.labelDueBarTime,
    closeTime: new Date(closeBarTime).toISOString(),
    closeBarTime,
    labelDelayHours: event.labelDelayHours,
    long: {
      symbol: event.signal.long.symbol,
      entryPrice: event.signal.long.entryPrice,
      closePrice: longClose.close,
      returnPct: round(longReturnPct, 10),
    },
    short: {
      symbol: event.signal.short.symbol,
      entryPrice: event.signal.short.entryPrice,
      closePrice: shortClose.close,
      spotReturnPct: round(shortSpotReturnPct, 10),
      shortReturnPct: round(shortReturnPct, 10),
    },
    label: {
      grossCarryPairReturnPct,
      carrySignalProfitableGross: grossCarryPairReturnPct > 0,
      fundingCashflowAccounted: fundingCashflow.fundingCashflowAccounted,
      fundingCashflowPct: fundingCashflow.fundingCashflowPct,
      fundingCashflowEvents: fundingCashflow.fundingCashflowEvents,
      fundingCashflowStatus: fundingCashflow.fundingCashflowStatus,
      routeCostAdjusted: routeCost.routeCostAdjusted,
      routeCostPct: routeCost.routeCostPct,
      routeCostAdjustedNetPct,
      routeCostAdjustmentStatus: routeCost.routeCostAdjustmentStatus,
    },
    blockers: [
      'prospective_outcome_not_execution_evidence',
      ...labelBlockers,
      'paper_live_execution_disabled',
    ],
    sourceOpenEvent: {
      featureId: event.sourceFeature.featureId,
      featureAvailableAt: event.sourceFeature.decisionAvailableAt,
      decisionAfterFeatureAvailableAt: event.decisionBarTime > event.sourceFeature.decisionAvailableAtMs,
      direction: event.signal.direction,
    },
  }
}

export function readEthCarryProspectiveLedgerEvents(path: string): {
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
      // Ignore malformed historical lines; status scripts report counts from parseable research events only.
    }
  }
  return { open, closed: latestEthCarryClosedOutcomesByObservationId(closed) }
}

function readLedgerEvents(path: string): {
  open: EthCarryProspectiveObservationEvent[]
  closed: EthCarryProspectiveObservationOutcome[]
} {
  return readEthCarryProspectiveLedgerEvents(path)
}

export function latestEthCarryClosedOutcomesByObservationId(
  closed: EthCarryProspectiveObservationOutcome[],
): EthCarryProspectiveObservationOutcome[] {
  const latest = new Map<string, EthCarryProspectiveObservationOutcome>()
  for (const event of closed) {
    latest.set(event.observationId, event)
  }
  return [...latest.values()]
}

function loadCloseAtOrAfter(
  dataDir: string,
  symbol: 'ETH-USDT' | 'BTC-USDT',
  barMinutes: number,
  targetTime: number,
): Candle | null {
  const timeframe = `${barMinutes === 60 ? '1h' : `${barMinutes}m`}` as PaperUniverseTimeframe
  const path = join(dataDir, paperSymbolToCsvFile(symbol, timeframe))
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8')
    .split('\n')
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseCandleCsvLine)
    .filter((item): item is Candle => item != null)
    .sort((left, right) => left.time - right.time)
    .find(candle => candle.time >= targetTime) ?? null
}

function readFeeEvidence(refreshPath: string, snapshotPath: string, asOfMs: number): RouteCostEvidence {
  const fallback: RouteCostEvidence = {
    runtimeFeeStatus: null,
    evidenceSource: null,
    makerFeeBps: null,
    takerFeeBps: null,
    sourceFetchedAt: null,
    expiresAt: null,
    routeCostAdjusted: false,
    routeCostPct: null,
  }
  const refreshEvidence = readRefreshFeeEvidence(refreshPath)
  if (refreshEvidence.routeCostAdjusted) return refreshEvidence
  const snapshotEvidence = readRuntimeFeeSnapshotEvidence(snapshotPath, asOfMs)
  return snapshotEvidence.routeCostAdjusted ? snapshotEvidence : refreshEvidence.runtimeFeeStatus != null ? refreshEvidence : fallback
}

function readRefreshFeeEvidence(path: string): RouteCostEvidence {
  const fallback: RouteCostEvidence = {
    runtimeFeeStatus: null,
    evidenceSource: null,
    makerFeeBps: null,
    takerFeeBps: null,
    sourceFetchedAt: null,
    expiresAt: null,
    routeCostAdjusted: false,
    routeCostPct: null,
  }
  if (!existsSync(path)) return fallback
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    const status = typeof parsed.status === 'string' ? parsed.status : null
    const feeSnapshot = asRecord(parsed.feeSnapshot)
    const perSymbolFees = Array.isArray(parsed.perSymbolFees)
      ? parsed.perSymbolFees.map(asRecord).filter((item): item is Record<string, unknown> => item != null)
      : []
    const makerValues = [
      readFiniteNumber(feeSnapshot?.makerFeeBps),
      ...perSymbolFees.map(fee => readFiniteNumber(fee.makerFeeBps)),
    ].filter(isFiniteNumber)
    const takerValues = [
      readFiniteNumber(feeSnapshot?.takerFeeBps),
      ...perSymbolFees.map(fee => readFiniteNumber(fee.takerFeeBps)),
    ].filter(isFiniteNumber)
    const makerFeeBps = makerValues.length > 0 ? Math.max(...makerValues) : null
    const takerFeeBps = takerValues.length > 0 ? Math.max(...takerValues) : null
    const conservativeLegFeeBps = Math.max(makerFeeBps ?? 0, takerFeeBps ?? 0)
    const routeCostPct = status === 'runtime_verified' && conservativeLegFeeBps > 0
      ? round((conservativeLegFeeBps * 4) / 100, 10)
      : null
    return {
      runtimeFeeStatus: status,
      evidenceSource: 'refresh',
      makerFeeBps,
      takerFeeBps,
      sourceFetchedAt: readString(feeSnapshot?.sourceFetchedAt),
      expiresAt: readString(feeSnapshot?.expiresAt),
      routeCostAdjusted: status === 'runtime_verified' && routeCostPct != null,
      routeCostPct,
    }
  } catch {
    return fallback
  }
}

function readRuntimeFeeSnapshotEvidence(path: string, asOfMs: number): RouteCostEvidence {
  const fallback: RouteCostEvidence = {
    runtimeFeeStatus: null,
    evidenceSource: null,
    makerFeeBps: null,
    takerFeeBps: null,
    sourceFetchedAt: null,
    expiresAt: null,
    routeCostAdjusted: false,
    routeCostPct: null,
  }
  if (!existsSync(path)) return fallback
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    const source = readString(parsed.source)
    const verifiedByRuntime = parsed.verifiedByRuntime === true
    const expiresAt = readString(parsed.expiresAt)
    const expiresAtMs = expiresAt == null ? null : Date.parse(expiresAt)
    const makerFeeBps = readFiniteNumber(parsed.makerFeeBps)
    const takerFeeBps = readFiniteNumber(parsed.takerFeeBps)
    const conservativeLegFeeBps = Math.max(makerFeeBps ?? 0, takerFeeBps ?? 0)
    const usable = source === 'api'
      && verifiedByRuntime
      && expiresAtMs != null
      && Number.isFinite(expiresAtMs)
      && expiresAtMs > asOfMs
      && conservativeLegFeeBps > 0
    const routeCostPct = usable ? round((conservativeLegFeeBps * 4) / 100, 10) : null
    return {
      runtimeFeeStatus: usable ? 'runtime_verified_snapshot_fallback' : 'snapshot_not_runtime_verified',
      evidenceSource: 'snapshot_fallback',
      makerFeeBps,
      takerFeeBps,
      sourceFetchedAt: readString(parsed.sourceFetchedAt),
      expiresAt,
      routeCostAdjusted: usable && routeCostPct != null,
      routeCostPct,
    }
  } catch {
    return fallback
  }
}

function computeRouteCost(feeEvidence: RouteCostEvidence): {
  routeCostAdjusted: boolean
  routeCostPct: number | null
  routeCostAdjustmentStatus: EthCarryProspectiveObservationOutcome['label']['routeCostAdjustmentStatus']
} {
  return feeEvidence.routeCostAdjusted && feeEvidence.routeCostPct != null
    ? {
        routeCostAdjusted: true,
        routeCostPct: feeEvidence.routeCostPct,
        routeCostAdjustmentStatus: 'adjusted_with_runtime_verified_fee_snapshot',
      }
    : {
        routeCostAdjusted: false,
        routeCostPct: null,
        routeCostAdjustmentStatus: 'blocked_runtime_fee_not_verified',
      }
}

function computeFundingCashflow(
  event: EthCarryProspectiveObservationEvent,
  closeBarTime: number,
): {
  fundingCashflowAccounted: boolean
  fundingCashflowPct: number | null
  fundingCashflowEvents: number
  fundingCashflowStatus: EthCarryProspectiveObservationOutcome['label']['fundingCashflowStatus']
} {
  if (!event.signal) {
    return {
      fundingCashflowAccounted: false,
      fundingCashflowPct: null,
      fundingCashflowEvents: 0,
      fundingCashflowStatus: 'blocked_requires_pit_funding_cashflow_reconciliation',
    }
  }
  const ethNextFundingTimeMs = parseNullableTime(event.pitFeatures.ethNextFundingTime)
  const btcNextFundingTimeMs = parseNullableTime(event.pitFeatures.btcNextFundingTime)
  const ethFundingRatePct = fundingRateToPct(event.pitFeatures.ethFundingRate)
  const btcFundingRatePct = fundingRateToPct(event.pitFeatures.btcFundingRate)
  if (ethFundingRatePct == null || btcFundingRatePct == null) {
    return {
      fundingCashflowAccounted: false,
      fundingCashflowPct: null,
      fundingCashflowEvents: 0,
      fundingCashflowStatus: 'blocked_requires_pit_funding_cashflow_reconciliation',
    }
  }

  let fundingCashflowPct = 0
  let fundingCashflowEvents = 0
  if (ethNextFundingTimeMs != null && ethNextFundingTimeMs > event.decisionBarTime && ethNextFundingTimeMs <= closeBarTime) {
    fundingCashflowPct += event.signal.short.symbol === 'ETH-USDT' ? ethFundingRatePct : -ethFundingRatePct
    fundingCashflowEvents += 1
  }
  if (btcNextFundingTimeMs != null && btcNextFundingTimeMs > event.decisionBarTime && btcNextFundingTimeMs <= closeBarTime) {
    fundingCashflowPct += event.signal.long.symbol === 'BTC-USDT' ? -btcFundingRatePct : btcFundingRatePct
    fundingCashflowEvents += 1
  }

  return {
    fundingCashflowAccounted: true,
    fundingCashflowPct: round(fundingCashflowPct, 10),
    fundingCashflowEvents,
    fundingCashflowStatus: fundingCashflowEvents > 0
      ? 'accounted_from_pit_next_funding_time'
      : 'accounted_no_funding_event_in_label_window',
  }
}

function parseCandleCsvLine(line: string): Candle | null {
  const [timestamp, , , , , close] = line.split(',')
  const time = Number(timestamp)
  const closeNumber = Number(close)
  if (!Number.isFinite(time) || !Number.isFinite(closeNumber)) return null
  return { time, close: closeNumber }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function parseNullableTime(value: string | null): number | null {
  if (value == null) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function fundingRateToPct(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value * 100 : null
}

function renderConsoleSummary(report: EthCarryProspectiveObservationSettleReport): string {
  return [
    `eth carry prospective settle: status=${report.status}, dryRun=${report.dryRun}`,
    `due=${report.counts.dueOpenEvents}, outcomes=${report.counts.outcomesBuilt}, appended=${report.counts.appendedOutcomes}`,
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

function parseNullablePositiveInteger(value: string | undefined, fallback: number | null, label: string): number | null {
  if (value == null || value === 'null') return fallback
  return parsePositiveInteger(value, fallback ?? 1, label)
}

function parseNullableTimestamp(value: string | undefined): number | null {
  if (value == null || value === 'null') return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid timestamp: ${value}`)
  return parsed
}

function priceReturnPct(entry: number, close: number): number {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(close)) return 0
  return ((close - entry) / entry) * 100
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function hashId(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('settle_eth_carry_prospective_observations failed:', error)
    process.exitCode = 1
  })
}
