import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { paperSymbolToCsvFile, type PaperUniverseTimeframe } from './lib/paper_universe.js'
import { latestEthCarryClosedOutcomesByObservationId } from './settle_eth_carry_prospective_observations.js'
import type { EthCarryProspectiveObservationOutcome } from './settle_eth_carry_prospective_observations.js'

type UnknownRecord = Record<string, unknown>
type WatchdogStatus = 'watch_waiting_for_label' | 'action_required' | 'blocked'

interface CliArgs {
  outputPath: string | null
  okxSnapshotPath: string
  okxSnapshotRowsPath: string
  pitFeaturePath: string
  pitAuditPath: string
  capturePath: string
  settlePath: string
  prospectivePath: string
  dataGapPath: string
  ledgerPath: string
  dataDir: string
  barMinutes: number
  staleAfterMs: number
  minClosedOutcomes: number
  asOfMs: number | null
  json: boolean
}

interface TimedArtifactStatus {
  path: string
  exists: boolean
  generatedAt: string | null
  ageMs: number | null
  stale: boolean
  status: string | null
  blockers: string[]
}

interface LedgerEventSummary {
  openEvents: number
  closedEvents: number
  pendingOpenEvents: number
  dueOpenEventsWithoutClose: number
  duplicateOpenObservationIds: number
  latestOpenObservationId: string | null
  latestOpenDecisionTime: string | null
  latestOpenLabelDueTime: string | null
  nextLabelDueTime: string | null
  nextLabelDueMs: number | null
}

export interface EthCarryProspectiveWatchdogReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: WatchdogStatus
  inputs: {
    okxSnapshotPath: string
    okxSnapshotRowsPath: string
    pitFeaturePath: string
    pitAuditPath: string
    capturePath: string
    settlePath: string
    prospectivePath: string
    dataGapPath: string
    ledgerPath: string
    dataDir: string
    barMinutes: number
    staleAfterMs: number
    minClosedOutcomes: number
    asOfMs: number | null
  }
  artifacts: {
    okxSnapshot: TimedArtifactStatus & {
      rowsBuilt: number
      rowsAppended: number
      duplicateRows: number
      errorCount: number
      reportRowsBuilt: number
      reportErrorCount: number
      reportBlockers: string[]
      cacheRows: number
      cacheSymbols: string[]
      cacheLatestAvailableAt: string | null
      cacheFallbackUsed: boolean
    }
    pitFeatures: TimedArtifactStatus & {
      carryFeatureRows: number
      latestDecisionAvailableAt: string | null
      latestDecisionAvailableAgeMs: number | null
    }
    pitAudit: TimedArtifactStatus & {
      passingRows: number
      failingRows: number
    }
    capture: TimedArtifactStatus & {
      observationsBuilt: number
      appendedObservations: number
      skippedAlreadyDueObservations: number
    }
    settle: TimedArtifactStatus & {
      dueOpenEvents: number
      outcomesBuilt: number
      appendedOutcomes: number
      missingCloseCandles: number
    }
    prospectiveEvidence: TimedArtifactStatus & {
      closedOutcomes: number
      pendingOpenEvents: number
      dueOpenEventsWithoutClose: number
      latestOpenLabelDueTime: string | null
    }
    dataGap: TimedArtifactStatus & {
      carryFeatureRows: number
      prospectiveClosedOutcomes: number
      prospectiveClosedOutcomeShortfall: number
      collectorErrorCount: number
      okxCarrySnapshotRowsBuilt: number
    }
  }
  ledger: LedgerEventSummary
  candleWatermark: {
    dataDir: string
    ethLatest: string | null
    btcLatest: string | null
    minLatest: string | null
    minLatestMs: number | null
  }
  readiness: {
    okxFresh: boolean
    pitReady: boolean
    pitAuditPass: boolean
    captureHealthy: boolean
    settleHealthy: boolean
    hasPendingOpen: boolean
    hasDueUnsettled: boolean
    candleDataCanSettleNextDue: boolean
  }
  recommendedCommands: string[]
  blockers: string[]
  evidenceBlockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  outputHash: string | null
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/eth_carry_prospective_watchdog.latest.json'
const DEFAULT_OKX_SNAPSHOT_PATH = 'data/runtime/okx_carry_snapshot_collect.latest.json'
const DEFAULT_OKX_SNAPSHOT_ROWS_PATH = 'data/normalized/derivatives/okx_swap_eth_carry_live.normalized.jsonl'
const DEFAULT_PIT_FEATURE_PATH = 'data/research/eth_carry_pit_features.latest.json'
const DEFAULT_PIT_AUDIT_PATH = 'data/research/eth_carry_pit_audit.latest.json'
const DEFAULT_CAPTURE_PATH = 'data/research/eth_carry_prospective_observation_capture.latest.json'
const DEFAULT_SETTLE_PATH = 'data/research/eth_carry_prospective_observation_settle.latest.json'
const DEFAULT_PROSPECTIVE_PATH = 'data/research/eth_carry_prospective_evidence_status.latest.json'
const DEFAULT_DATA_GAP_PATH = 'data/research/eth_carry_data_gap_status.latest.json'
const DEFAULT_LEDGER_PATH = 'data/research/eth_carry_prospective_observations.jsonl'
const DEFAULT_DATA_DIR = 'data/market/live_5m'
const DEFAULT_BAR_MINUTES = 5
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000
const DEFAULT_MIN_CLOSED_OUTCOMES = 100

async function main(): Promise<void> {
  const args = parseEthCarryProspectiveWatchdogArgs(process.argv.slice(2))
  const report = await runEthCarryProspectiveWatchdog(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseEthCarryProspectiveWatchdogArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT
  const defaultSnapshotRowsPath = dataRoot
    ? resolve(dataRoot, 'normalized/derivatives/okx_swap_eth_carry_live.normalized.jsonl')
    : DEFAULT_OKX_SNAPSHOT_ROWS_PATH
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    okxSnapshotPath: raw.get('okxSnapshotPath') ?? raw.get('okxSnapshot') ?? DEFAULT_OKX_SNAPSHOT_PATH,
    okxSnapshotRowsPath: raw.get('okxSnapshotRowsPath') ?? defaultSnapshotRowsPath,
    pitFeaturePath: raw.get('pitFeaturePath') ?? raw.get('featurePath') ?? DEFAULT_PIT_FEATURE_PATH,
    pitAuditPath: raw.get('pitAuditPath') ?? raw.get('pitAudit') ?? DEFAULT_PIT_AUDIT_PATH,
    capturePath: raw.get('capturePath') ?? raw.get('capture') ?? DEFAULT_CAPTURE_PATH,
    settlePath: raw.get('settlePath') ?? raw.get('settle') ?? DEFAULT_SETTLE_PATH,
    prospectivePath: raw.get('prospectivePath') ?? raw.get('prospective') ?? DEFAULT_PROSPECTIVE_PATH,
    dataGapPath: raw.get('dataGapPath') ?? raw.get('dataGap') ?? DEFAULT_DATA_GAP_PATH,
    ledgerPath: raw.get('ledgerPath') ?? raw.get('ledger') ?? DEFAULT_LEDGER_PATH,
    dataDir: raw.get('dataDir') ?? DEFAULT_DATA_DIR,
    barMinutes: parsePositiveInteger(raw.get('barMinutes'), DEFAULT_BAR_MINUTES, 'barMinutes'),
    staleAfterMs: parsePositiveInteger(raw.get('staleAfterMs'), DEFAULT_STALE_AFTER_MS, 'staleAfterMs'),
    minClosedOutcomes: parsePositiveInteger(raw.get('minClosedOutcomes'), DEFAULT_MIN_CLOSED_OUTCOMES, 'minClosedOutcomes'),
    asOfMs: parseNullableTimestamp(raw.get('asOf')),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryProspectiveWatchdog(
  args: CliArgs,
): Promise<EthCarryProspectiveWatchdogReport> {
  const startedAt = new Date()
  const report = buildEthCarryProspectiveWatchdogReport({
    generatedAt: new Date().toISOString(),
    asOfMs: args.asOfMs ?? Date.now(),
    args,
    okxSnapshot: readJsonIfExists(args.okxSnapshotPath),
    okxSnapshotRows: readJsonlIfExists(args.okxSnapshotRowsPath),
    pitFeatures: readJsonIfExists(args.pitFeaturePath),
    pitAudit: readJsonIfExists(args.pitAuditPath),
    capture: readJsonIfExists(args.capturePath),
    settle: readJsonIfExists(args.settlePath),
    prospective: readJsonIfExists(args.prospectivePath),
    dataGap: readJsonIfExists(args.dataGapPath),
    ledgerEvents: readLedgerEvents(args.ledgerPath),
    candleWatermark: readCandleWatermark(args.dataDir, args.barMinutes),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    const withoutHash = `${JSON.stringify({ ...report, outputHash: null }, null, 2)}\n`
    const outputHash = sha256Hex(withoutHash)
    const finalPayload = `${JSON.stringify({ ...report, outputHash }, null, 2)}\n`
    await writeFile(outputPath, finalPayload, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_prospective_watchdog',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked' ? 'fail' : 'warn',
      recordsIn: report.ledger.openEvents + report.ledger.closedEvents,
      recordsOut: report.ledger.pendingOpenEvents,
      errorClass: report.blockers[0] ?? null,
      artifactHash: sha256Hex(finalPayload),
    })
    return { ...report, outputHash }
  }

  return report
}

export function buildEthCarryProspectiveWatchdogReport(input: {
  generatedAt: string
  asOfMs: number
  args: CliArgs
  okxSnapshot: UnknownRecord | null
  okxSnapshotRows?: UnknownRecord[]
  pitFeatures: UnknownRecord | null
  pitAudit: UnknownRecord | null
  capture: UnknownRecord | null
  settle: UnknownRecord | null
  prospective: UnknownRecord | null
  dataGap: UnknownRecord | null
  ledgerEvents: Array<UnknownRecord>
  candleWatermark: EthCarryProspectiveWatchdogReport['candleWatermark']
}): EthCarryProspectiveWatchdogReport {
  const args = input.args
  const paths = {
    okxSnapshotPath: resolve(args.okxSnapshotPath),
    okxSnapshotRowsPath: resolve(args.okxSnapshotRowsPath),
    pitFeaturePath: resolve(args.pitFeaturePath),
    pitAuditPath: resolve(args.pitAuditPath),
    capturePath: resolve(args.capturePath),
    settlePath: resolve(args.settlePath),
    prospectivePath: resolve(args.prospectivePath),
    dataGapPath: resolve(args.dataGapPath),
    ledgerPath: resolve(args.ledgerPath),
    dataDir: resolve(args.dataDir),
  }
  const okxSnapshot = summarizeOkxSnapshot(paths.okxSnapshotPath, input.okxSnapshot, input.okxSnapshotRows ?? [], input.asOfMs, args.staleAfterMs)
  const pitFeatures = summarizePitFeatures(paths.pitFeaturePath, input.pitFeatures, input.asOfMs, args.staleAfterMs)
  const pitAudit = summarizePitAudit(paths.pitAuditPath, input.pitAudit, input.asOfMs, args.staleAfterMs)
  const capture = summarizeCapture(paths.capturePath, input.capture, input.asOfMs, args.staleAfterMs)
  const settle = summarizeSettle(paths.settlePath, input.settle, input.asOfMs, args.staleAfterMs)
  const prospectiveEvidence = summarizeProspective(paths.prospectivePath, input.prospective, input.asOfMs, args.staleAfterMs)
  const dataGap = summarizeDataGap(paths.dataGapPath, input.dataGap, input.asOfMs, args.staleAfterMs)
  const ledger = summarizeLedger(input.ledgerEvents, input.asOfMs)
  const evidenceBlockers = uniqueStrings([
    ...prospectiveEvidence.blockers,
    ...dataGap.blockers,
  ])
  const okxFresh = okxSnapshot.exists && !okxSnapshot.stale && okxSnapshot.status === 'complete' &&
    okxSnapshot.rowsBuilt >= 2 && okxSnapshot.errorCount === 0 && okxSnapshot.blockers.length === 0
  const pitReady = pitFeatures.exists && pitFeatures.status === 'ready_for_research' &&
    pitFeatures.carryFeatureRows > 0 && !pitFeatures.stale && pitFeatures.blockers.length === 0
  const pitAuditPass = pitAudit.exists && pitAudit.status === 'pass' && pitAudit.failingRows === 0 && pitAudit.blockers.length === 0
  const captureHealthy = capture.exists && !capture.stale && capture.status !== 'blocked' && capture.blockers.length === 0
  const settleHealthy = !settle.exists || settle.status !== 'blocked'
  const candleDataCanSettleNextDue = ledger.nextLabelDueMs == null
    ? true
    : input.candleWatermark.minLatestMs != null && input.candleWatermark.minLatestMs >= ledger.nextLabelDueMs
  const blockers = uniqueStrings([
    ...(artifactAllowsExecution(input.okxSnapshot) ? ['okx_snapshot_must_not_authorize_execution'] : []),
    ...(artifactAllowsExecution(input.pitFeatures) ? ['pit_features_must_not_authorize_execution'] : []),
    ...(artifactAllowsExecution(input.pitAudit) ? ['pit_audit_must_not_authorize_execution'] : []),
    ...(artifactAllowsExecution(input.capture) ? ['capture_must_not_authorize_execution'] : []),
    ...(artifactAllowsExecution(input.settle) ? ['settle_must_not_authorize_execution'] : []),
    ...(artifactAllowsExecution(input.prospective) ? ['prospective_evidence_must_not_authorize_execution'] : []),
    ...(okxFresh ? [] : ['okx_carry_snapshot_not_fresh']),
    ...(pitReady ? [] : ['eth_carry_pit_features_not_ready_or_stale']),
    ...(pitAuditPass ? [] : ['eth_carry_pit_audit_not_pass']),
    ...(capture.status === 'blocked' ? capture.blockers.map(reason => `capture:${reason}`) : []),
    ...(settle.status === 'blocked' ? settle.blockers.map(reason => `settle:${reason}`) : []),
    ...(ledger.duplicateOpenObservationIds === 0 ? [] : [`duplicate_open_observation_ids:${ledger.duplicateOpenObservationIds}`]),
  ])
  const actionRequiredReasons = uniqueStrings([
    ...(ledger.dueOpenEventsWithoutClose > 0 ? [`settle_due_open_events:${ledger.dueOpenEventsWithoutClose}`] : []),
    ...(okxFresh ? [] : ['refresh_okx_carry_snapshot']),
    ...(pitReady && pitAuditPass ? [] : ['rebuild_pit_features_and_audit']),
    ...(ledger.pendingOpenEvents > 0 ? [] : ['capture_next_future_observation']),
    ...(ledger.dueOpenEventsWithoutClose > 0 && !candleDataCanSettleNextDue ? ['wait_for_5m_close_candles'] : []),
  ])
  const status: WatchdogStatus = blockers.length > 0
    ? 'blocked'
    : actionRequiredReasons.length > 0
      ? 'action_required'
      : 'watch_waiting_for_label'
  const recommendedCommands = buildRecommendedCommands({
    okxFresh,
    pitReady,
    pitAuditPass,
    dueOpenEventsWithoutClose: ledger.dueOpenEventsWithoutClose,
    pendingOpenEvents: ledger.pendingOpenEvents,
    candleDataCanSettleNextDue,
  })

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status,
    inputs: {
      ...paths,
      barMinutes: args.barMinutes,
      staleAfterMs: args.staleAfterMs,
      minClosedOutcomes: args.minClosedOutcomes,
      asOfMs: args.asOfMs,
    },
    artifacts: {
      okxSnapshot,
      pitFeatures,
      pitAudit,
      capture,
      settle,
      prospectiveEvidence,
      dataGap,
    },
    ledger,
    candleWatermark: {
      ...input.candleWatermark,
      dataDir: paths.dataDir,
    },
    readiness: {
      okxFresh,
      pitReady,
      pitAuditPass,
      captureHealthy,
      settleHealthy,
      hasPendingOpen: ledger.pendingOpenEvents > 0,
      hasDueUnsettled: ledger.dueOpenEventsWithoutClose > 0,
      candleDataCanSettleNextDue,
    },
    recommendedCommands,
    blockers,
    evidenceBlockers,
    nextActions: buildNextActions(status, actionRequiredReasons, args.minClosedOutcomes, prospectiveEvidence.closedOutcomes),
    safetyNotes: [
      'This watchdog is research-only diagnostics; it never places paper or live orders.',
      'Open observations are not profitability evidence until settled into closed, route-cost-adjusted labels.',
      'Do not promote ETH carry until PIT, WFO, BY-FDR, route-cost, slippage, risk, prospective, and paper-execution gates pass.',
    ],
    outputHash: null,
  }
}

function summarizeTimedArtifact(
  path: string,
  artifact: UnknownRecord | null,
  asOfMs: number,
  staleAfterMs: number,
): TimedArtifactStatus {
  const generatedAt = readString(artifact?.generatedAt)
  const generatedAtMs = generatedAt ? Date.parse(generatedAt) : Number.NaN
  const ageMs = Number.isFinite(generatedAtMs) ? Math.max(0, asOfMs - generatedAtMs) : null
  return {
    path,
    exists: artifact != null || existsSync(path),
    generatedAt,
    ageMs,
    stale: artifact != null && (ageMs == null || ageMs > staleAfterMs),
    status: readString(artifact?.status),
    blockers: readStringArray(artifact?.blockers),
  }
}

function summarizeOkxSnapshot(
  path: string,
  artifact: UnknownRecord | null,
  cacheRows: UnknownRecord[],
  asOfMs: number,
  staleAfterMs: number,
): EthCarryProspectiveWatchdogReport['artifacts']['okxSnapshot'] {
  const base = summarizeTimedArtifact(path, artifact, asOfMs, staleAfterMs)
  const counts = asRecord(artifact?.counts)
  const reportRowsBuilt = readNumber(counts?.rowsBuilt) ?? 0
  const reportErrorCount = Math.max(readNumber(counts?.errors) ?? 0, Array.isArray(artifact?.errors) ? artifact!.errors.length : 0)
  const reportBlockers = base.blockers
  const reportComplete = base.exists &&
    !base.stale &&
    readBoolean(artifact?.dryRun) !== true &&
    base.status === 'complete' &&
    reportRowsBuilt >= 2 &&
    reportErrorCount === 0 &&
    reportBlockers.length === 0
  const cache = buildRecentOkxCarrySnapshotCache(cacheRows, asOfMs, staleAfterMs)
  const cacheFallbackUsed = !reportComplete && cache.complete
  return {
    ...base,
    exists: base.exists || cache.cacheRows > 0,
    generatedAt: cacheFallbackUsed ? cache.latestAvailableAt : base.generatedAt,
    ageMs: cacheFallbackUsed && cache.latestAvailableAtMs != null ? Math.max(0, asOfMs - cache.latestAvailableAtMs) : base.ageMs,
    stale: cacheFallbackUsed ? false : base.stale,
    status: cacheFallbackUsed ? 'complete' : base.status,
    blockers: cacheFallbackUsed ? [] : reportBlockers,
    rowsBuilt: cacheFallbackUsed ? 2 : reportRowsBuilt,
    rowsAppended: readNumber(counts?.rowsAppended) ?? 0,
    duplicateRows: readNumber(counts?.duplicateRows) ?? 0,
    errorCount: cacheFallbackUsed ? 0 : reportErrorCount,
    reportRowsBuilt,
    reportErrorCount,
    reportBlockers,
    cacheRows: cache.cacheRows,
    cacheSymbols: cache.cacheSymbols,
    cacheLatestAvailableAt: cache.latestAvailableAt,
    cacheFallbackUsed,
  }
}

function buildRecentOkxCarrySnapshotCache(rows: UnknownRecord[], asOfMs: number, maxAgeMs: number): {
  complete: boolean
  cacheRows: number
  cacheSymbols: string[]
  latestAvailableAt: string | null
  latestAvailableAtMs: number | null
} {
  const latestBySymbol = new Map<string, { availableAtMs: number }>()
  for (const row of rows) {
    if (readString(row.exchange) !== 'okx') continue
    if (readString(row.market) !== 'swap') continue
    if (readString(row.endpointId) !== 'okxCarrySnapshot') continue
    const symbol = readString(row.symbol)
    if (symbol !== 'BTCUSDT' && symbol !== 'ETHUSDT') continue
    const availableAt = readString(row.availableAt) ?? readString(row.observedAt) ?? readString(row.generatedAt)
    const availableAtMs = availableAt ? Date.parse(availableAt) : Number.NaN
    if (!Number.isFinite(availableAtMs)) continue
    if (Math.max(0, asOfMs - availableAtMs) > maxAgeMs) continue
    const fields = asRecord(row.fields)
    if (!fields) continue
    if (!Number.isFinite(readNumber(fields.markPrice) ?? Number.NaN)) continue
    if (!Number.isFinite(readNumber(fields.indexPrice) ?? Number.NaN)) continue
    if (!Number.isFinite(readNumber(fields.fundingRate) ?? Number.NaN)) continue
    if (!Number.isFinite(readNumber(fields.nextFundingTime) ?? Number.NaN)) continue
    const previous = latestBySymbol.get(symbol)
    if (!previous || availableAtMs > previous.availableAtMs) latestBySymbol.set(symbol, { availableAtMs })
  }
  const cacheSymbols = [...latestBySymbol.keys()].sort()
  const latestAvailableAtMs = [...latestBySymbol.values()]
    .map(item => item.availableAtMs)
    .sort((left, right) => right - left)[0] ?? null
  return {
    complete: cacheSymbols.includes('BTCUSDT') && cacheSymbols.includes('ETHUSDT'),
    cacheRows: cacheSymbols.length,
    cacheSymbols,
    latestAvailableAt: latestAvailableAtMs != null ? new Date(latestAvailableAtMs).toISOString() : null,
    latestAvailableAtMs,
  }
}

function summarizePitFeatures(path: string, artifact: UnknownRecord | null, asOfMs: number, staleAfterMs: number): EthCarryProspectiveWatchdogReport['artifacts']['pitFeatures'] {
  const base = summarizeTimedArtifact(path, artifact, asOfMs, staleAfterMs)
  const counts = asRecord(artifact?.counts)
  const rows = readRecordArray(artifact?.carryFeatureRows)
  const latestDecisionMs = rows
    .map(row => readNumber(row.decisionAvailableAtMs))
    .filter((value): value is number => value != null)
    .sort((left, right) => right - left)[0] ?? null
  const latestDecisionAvailableAt = latestDecisionMs != null ? new Date(latestDecisionMs).toISOString() : null
  return {
    ...base,
    carryFeatureRows: readNumber(counts?.carryFeatureRows) ?? rows.length,
    latestDecisionAvailableAt,
    latestDecisionAvailableAgeMs: latestDecisionMs != null ? Math.max(0, asOfMs - latestDecisionMs) : null,
  }
}

function summarizePitAudit(path: string, artifact: UnknownRecord | null, asOfMs: number, staleAfterMs: number): EthCarryProspectiveWatchdogReport['artifacts']['pitAudit'] {
  const base = summarizeTimedArtifact(path, artifact, asOfMs, staleAfterMs)
  const counts = asRecord(artifact?.counts)
  return {
    ...base,
    passingRows: readNumber(counts?.passingRows) ?? 0,
    failingRows: readNumber(counts?.failingRows) ?? 0,
  }
}

function summarizeCapture(path: string, artifact: UnknownRecord | null, asOfMs: number, staleAfterMs: number): EthCarryProspectiveWatchdogReport['artifacts']['capture'] {
  const base = summarizeTimedArtifact(path, artifact, asOfMs, staleAfterMs)
  const counts = asRecord(artifact?.counts)
  return {
    ...base,
    observationsBuilt: readNumber(counts?.observationsBuilt) ?? 0,
    appendedObservations: readNumber(counts?.appendedObservations) ?? 0,
    skippedAlreadyDueObservations: readNumber(counts?.skippedAlreadyDueObservations) ?? 0,
  }
}

function summarizeSettle(path: string, artifact: UnknownRecord | null, asOfMs: number, staleAfterMs: number): EthCarryProspectiveWatchdogReport['artifacts']['settle'] {
  const base = summarizeTimedArtifact(path, artifact, asOfMs, staleAfterMs)
  const counts = asRecord(artifact?.counts)
  return {
    ...base,
    dueOpenEvents: readNumber(counts?.dueOpenEvents) ?? 0,
    outcomesBuilt: readNumber(counts?.outcomesBuilt) ?? 0,
    appendedOutcomes: readNumber(counts?.appendedOutcomes) ?? 0,
    missingCloseCandles: readNumber(counts?.missingCloseCandles) ?? 0,
  }
}

function summarizeProspective(path: string, artifact: UnknownRecord | null, asOfMs: number, staleAfterMs: number): EthCarryProspectiveWatchdogReport['artifacts']['prospectiveEvidence'] {
  const base = summarizeTimedArtifact(path, artifact, asOfMs, staleAfterMs)
  const counts = asRecord(artifact?.counts)
  const metrics = asRecord(artifact?.metrics)
  const latestOpen = asRecord(artifact?.latestOpen)
  return {
    ...base,
    closedOutcomes: readNumber(metrics?.closedOutcomes) ?? 0,
    pendingOpenEvents: readNumber(counts?.pendingOpenEvents) ?? 0,
    dueOpenEventsWithoutClose: readNumber(counts?.dueOpenEventsWithoutClose) ?? 0,
    latestOpenLabelDueTime: readString(latestOpen?.labelDueTime),
  }
}

function summarizeDataGap(path: string, artifact: UnknownRecord | null, asOfMs: number, staleAfterMs: number): EthCarryProspectiveWatchdogReport['artifacts']['dataGap'] {
  const base = summarizeTimedArtifact(path, artifact, asOfMs, staleAfterMs)
  const counts = asRecord(artifact?.counts)
  return {
    ...base,
    carryFeatureRows: readNumber(counts?.carryFeatureRows) ?? 0,
    prospectiveClosedOutcomes: readNumber(counts?.prospectiveClosedOutcomes) ?? 0,
    prospectiveClosedOutcomeShortfall: readNumber(counts?.prospectiveClosedOutcomeShortfall) ?? 0,
    collectorErrorCount: readNumber(counts?.collectorErrorCount) ?? 0,
    okxCarrySnapshotRowsBuilt: readNumber(counts?.okxCarrySnapshotRowsBuilt) ?? 0,
  }
}

function summarizeLedger(events: UnknownRecord[], asOfMs: number): LedgerEventSummary {
  const openEvents = events.filter(event => readString(event.eventType) === 'eth_carry_prospective_decision_open')
  const closedEvents = latestEthCarryClosedOutcomesByObservationId(
    events.filter(event => readString(event.eventType) === 'eth_carry_prospective_decision_closed') as EthCarryProspectiveObservationOutcome[],
  )
  const closedIds = new Set(closedEvents.map(event => readString(event.observationId)).filter((item): item is string => item != null))
  const openIds = openEvents.map(event => readString(event.observationId)).filter((item): item is string => item != null)
  const duplicateOpenObservationIds = openIds.length - new Set(openIds).size
  const unresolved = openEvents.filter(event => {
    const id = readString(event.observationId)
    return id != null && !closedIds.has(id)
  })
  const pending = unresolved.filter(event => (readNumber(event.labelDueBarTime) ?? 0) > asOfMs)
  const due = unresolved.filter(event => (readNumber(event.labelDueBarTime) ?? 0) <= asOfMs)
  const latestOpen = [...openEvents].sort((left, right) => (readNumber(right.decisionBarTime) ?? 0) - (readNumber(left.decisionBarTime) ?? 0))[0]
  const nextDueMs = pending
    .map(event => readNumber(event.labelDueBarTime))
    .filter((value): value is number => value != null)
    .sort((left, right) => left - right)[0] ?? null
  return {
    openEvents: openEvents.length,
    closedEvents: closedEvents.length,
    pendingOpenEvents: pending.length,
    dueOpenEventsWithoutClose: due.length,
    duplicateOpenObservationIds,
    latestOpenObservationId: readString(latestOpen?.observationId),
    latestOpenDecisionTime: readString(latestOpen?.decisionTime),
    latestOpenLabelDueTime: readString(latestOpen?.labelDueTime),
    nextLabelDueTime: nextDueMs != null ? new Date(nextDueMs).toISOString() : null,
    nextLabelDueMs: nextDueMs,
  }
}

function readCandleWatermark(dataDir: string, barMinutes: number): EthCarryProspectiveWatchdogReport['candleWatermark'] {
  const eth = latestCandleTime(dataDir, 'ETH-USDT', barMinutes)
  const btc = latestCandleTime(dataDir, 'BTC-USDT', barMinutes)
  const minLatestMs = eth != null && btc != null ? Math.min(eth, btc) : null
  return {
    dataDir: resolve(dataDir),
    ethLatest: eth != null ? new Date(eth).toISOString() : null,
    btcLatest: btc != null ? new Date(btc).toISOString() : null,
    minLatest: minLatestMs != null ? new Date(minLatestMs).toISOString() : null,
    minLatestMs,
  }
}

function latestCandleTime(dataDir: string, symbol: 'ETH-USDT' | 'BTC-USDT', barMinutes: number): number | null {
  const timeframe = `${barMinutes === 60 ? '1h' : `${barMinutes}m`}` as PaperUniverseTimeframe
  const path = join(dataDir, paperSymbolToCsvFile(symbol, timeframe))
  if (!existsSync(path)) return null
  const rows = readFileSync(path, 'utf-8')
    .split('\n')
    .slice(1)
    .map(line => Number(line.split(',')[0]))
    .filter(Number.isFinite)
  return rows.length > 0 ? Math.max(...rows) : null
}

function buildRecommendedCommands(input: {
  okxFresh: boolean
  pitReady: boolean
  pitAuditPass: boolean
  dueOpenEventsWithoutClose: number
  pendingOpenEvents: number
  candleDataCanSettleNextDue: boolean
}): string[] {
  return [
    ...(input.okxFresh ? [] : ['corepack pnpm research:eth-carry:okx-snapshot']),
    ...(input.pitReady ? [] : ['corepack pnpm research:eth-carry:pit-features']),
    ...(input.pitAuditPass ? [] : ['corepack pnpm research:eth-carry:pit-audit']),
    ...(input.dueOpenEventsWithoutClose > 0 && input.candleDataCanSettleNextDue
      ? ['corepack pnpm research:eth-carry:prospective-observation:settle']
      : []),
    ...(input.pendingOpenEvents === 0
      ? ['corepack pnpm research:eth-carry:prospective-observation:capture']
      : []),
    'corepack pnpm research:eth-carry:prospective-evidence:status',
    'corepack pnpm research:eth-carry:prospective-watchdog',
  ]
}

function buildNextActions(
  status: WatchdogStatus,
  actionRequiredReasons: string[],
  minClosedOutcomes: number,
  closedOutcomes: number,
): string[] {
  return uniqueStrings([
    ...(status === 'blocked' ? ['Fix watchdog blockers before relying on ETH carry prospective cadence.'] : []),
    ...actionRequiredReasons.map(reason => `Handle ${reason}.`),
    ...(closedOutcomes < minClosedOutcomes
      ? [`Continue future-only capture/settle until closed outcomes reach ${minClosedOutcomes}; current=${closedOutcomes}/${minClosedOutcomes}.`]
      : []),
    'Keep all ETH carry prospective artifacts research-only until release gates pass.',
  ])
}

function readJsonIfExists(path: string): UnknownRecord | null {
  try {
    return asRecord(JSON.parse(readFileSync(resolve(path), 'utf-8')))
  } catch {
    return null
  }
}

function readLedgerEvents(path: string): UnknownRecord[] {
  const resolvedPath = resolve(path)
  if (!existsSync(resolvedPath)) return []
  return readFileSync(resolvedPath, 'utf-8')
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

function readJsonlIfExists(path: string): UnknownRecord[] {
  try {
    return readFileSync(resolve(path), 'utf-8')
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
  } catch {
    return []
  }
}

function artifactAllowsExecution(value: UnknownRecord | null): boolean {
  return readBoolean(value?.promotionEligible) === true ||
    readBoolean(value?.paperTradingAllowed) === true ||
    readBoolean(value?.liveTradingAllowed) === true ||
    readBoolean(value?.executionAllowed) === true
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
  return normalized === '' || normalized === 'null' || normalized === 'none' ? null : value
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

function parseNullableTimestamp(value: string | undefined): number | null {
  if (value == null || value === 'null' || value === 'none') return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid timestamp: ${value}`)
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

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim() !== ''))]
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: EthCarryProspectiveWatchdogReport): string {
  return [
    `eth carry prospective watchdog: status=${report.status}`,
    `pending=${report.ledger.pendingOpenEvents} due=${report.ledger.dueOpenEventsWithoutClose} closed=${report.artifacts.prospectiveEvidence.closedOutcomes}/${report.inputs.minClosedOutcomes}`,
    `okxFresh=${report.readiness.okxFresh} pitReady=${report.readiness.pitReady} pitAuditPass=${report.readiness.pitAuditPass}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 10).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('build_eth_carry_prospective_watchdog failed:', error)
    process.exitCode = 1
  })
}
