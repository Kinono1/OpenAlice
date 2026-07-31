import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type WatchdogStatus =
  | 'watch_waiting_for_future_rows'
  | 'watch_future_paper_model_telemetry_ready'
  | 'blocked_future_rows_missing_telemetry'
  | 'blocked'
type TelemetryGapStatus =
  | 'input_or_contract_blocked'
  | 'waiting_for_future_close_rows'
  | 'future_close_rows_missing_paper_model_telemetry'
  | 'paper_model_ready_missing_exchange_reconciled_or_observed_slippage'
  | 'future_execution_evidence_observed_but_diagnostic_only'

interface CliArgs {
  outputPath: string | null
  previousPath: string | null
  paperTradeResultPath: string
  producerContractStatusPath: string
  executionQualityPath: string
  minFuturePaperFillTelemetryCoveragePct: number
  minFuturePredictedOpenEvidenceCoveragePct: number
  json: boolean
}

interface PaperTradeRow {
  tradeId: string
  lane: string | null
  symbol: string | null
  openTs: string | null
  closeTs: string | null
  closeMs: number
  openMs: number | null
  predictedOpenEvidenceStatus: string | null
  paperFillTelemetryStatus: string | null
  paperFillExpectedCostBps: number | null
  paperFillSimulatedSlippageBps: number | null
  paperFillRouteCostBps: number | null
  paperFillIsExchangeReconciled: boolean | null
  costEvidenceSource: string | null
  realizedRoundTripCostBps: number | null
  realizedCostBps: number | null
  fillAdjustedCostBps: number | null
  fillAdjustedCostPct: number | null
}

interface PaperTradeLoadResult {
  rows: PaperTradeRow[]
  totalLines: number
  parsedRows: number
  closedRows: number
  malformedRows: number
}

export interface PaperExecutionFutureTelemetryWatchdogReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  futureOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: WatchdogStatus
  monitoringStartedAt: string
  sourceArtifacts: {
    paperTradeResultPath: string
    producerContractStatusPath: string
    executionQualityPath: string
    previousPath: string | null
  }
  thresholds: {
    minFuturePaperFillTelemetryCoveragePct: number
    minFuturePredictedOpenEvidenceCoveragePct: number
  }
  producerContract: {
    exists: boolean
    generatedAt: string | null
    status: string | null
    futurePaperCloseRowsReady: boolean
  }
  executionQuality: {
    exists: boolean
    generatedAt: string | null
    closedTrades: number
    tradesWithPaperFillTelemetry: number
    tradesWithExchangeReconciledCostEvidence: number
    observedSlippageAvailable: boolean
  }
  counts: {
    totalLines: number
    parsedRows: number
    malformedRows: number
    closedRows: number
    futureClosedRows: number
    futureClosedRowsWithOpenAfterStart: number
    futureRowsWithPaperFillTelemetry: number
    futureRowsWithPaperFillExpectedCost: number
    futureRowsWithPaperFillSimulatedSlippage: number
    futureRowsWithPaperFillRouteCost: number
    futureRowsWithCompletePredictedOpenEvidence: number
    futureNewOpenRowsWithCompletePredictedOpenEvidence: number
    futureRowsWithExchangeReconciledCostEvidence: number
    futureRowsWithFillAdjustedCostEvidence: number
    futureRowsWithObservedSlippage: number
  }
  coverage: {
    futurePaperFillTelemetryCoveragePct: number | null
    futurePaperFillExpectedCostCoveragePct: number | null
    futurePredictedOpenEvidenceCoveragePct: number | null
    futureNewOpenPredictedOpenEvidenceCoveragePct: number | null
    futureExchangeReconciledCostCoveragePct: number | null
    futureObservedSlippageCoveragePct: number | null
  }
  readiness: {
    producerReadyForFutureRows: boolean
    hasFutureClosedRows: boolean
    futurePaperFillTelemetrySufficient: boolean
    futurePredictedOpenEvidenceSufficient: boolean
    exchangeReconciledCostEvidenceAvailable: boolean
    observedSlippageAvailable: boolean
    promotionGradePaperExecutionEvidence: false
  }
  telemetryGap: {
    status: TelemetryGapStatus
    monitoringAgeMinutes: number | null
    latestClosedAt: string | null
    latestClosedAgeMinutes: number | null
    latestClosedBeforeMonitoringStart: boolean | null
    latestFutureClosedAt: string | null
    latestFutureNewOpenClosedAt: string | null
    closedRowsBeforeMonitoringStart: number
    futureClosedRowsAfterMonitoringStart: number
    futureRowsMissingPaperFillTelemetry: number
    futureNewOpenRowsMissingPredictedOpenEvidence: number
    sampleFutureRowsMissingPaperFillTelemetry: string[]
    sampleFutureNewOpenRowsMissingPredictedOpenEvidence: string[]
  }
  sampleProblemTradeIds: string[]
  blockers: string[]
  evidenceBlockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  outputHash: string | null
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/paper_execution_future_telemetry_watchdog.latest.json'
const DEFAULT_PAPER_TRADE_RESULT_PATH = 'data/paper_trading/paper_trade_result.jsonl'
const DEFAULT_PRODUCER_CONTRACT_STATUS_PATH = 'data/runtime/paper_execution_producer_contract_status.latest.json'
const DEFAULT_EXECUTION_QUALITY_PATH = 'data/runtime/execution_quality.latest.json'
const DEFAULT_MIN_FUTURE_PAPER_FILL_TELEMETRY_COVERAGE_PCT = 95
const DEFAULT_MIN_FUTURE_PREDICTED_OPEN_EVIDENCE_COVERAGE_PCT = 95

async function main(): Promise<void> {
  const args = parsePaperExecutionFutureTelemetryWatchdogArgs(process.argv.slice(2))
  const report = await runPaperExecutionFutureTelemetryWatchdog(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parsePaperExecutionFutureTelemetryWatchdogArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const outputPath = parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH)
  return {
    outputPath,
    previousPath: parseNullablePath(raw.get('previousPath') ?? outputPath ?? DEFAULT_OUTPUT_PATH),
    paperTradeResultPath: raw.get('paperTradeResultPath') ?? DEFAULT_PAPER_TRADE_RESULT_PATH,
    producerContractStatusPath: raw.get('producerContractStatusPath') ?? DEFAULT_PRODUCER_CONTRACT_STATUS_PATH,
    executionQualityPath: raw.get('executionQualityPath') ?? DEFAULT_EXECUTION_QUALITY_PATH,
    minFuturePaperFillTelemetryCoveragePct: parsePercent(
      raw.get('minFuturePaperFillTelemetryCoveragePct'),
      DEFAULT_MIN_FUTURE_PAPER_FILL_TELEMETRY_COVERAGE_PCT,
      'minFuturePaperFillTelemetryCoveragePct',
    ),
    minFuturePredictedOpenEvidenceCoveragePct: parsePercent(
      raw.get('minFuturePredictedOpenEvidenceCoveragePct'),
      DEFAULT_MIN_FUTURE_PREDICTED_OPEN_EVIDENCE_COVERAGE_PCT,
      'minFuturePredictedOpenEvidenceCoveragePct',
    ),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runPaperExecutionFutureTelemetryWatchdog(
  args: CliArgs,
): Promise<PaperExecutionFutureTelemetryWatchdogReport> {
  const startedAt = new Date()
  const producerContractStatus = asRecord(await readJsonIfExists(args.producerContractStatusPath))
  const executionQuality = asRecord(await readJsonIfExists(args.executionQualityPath))
  const previous = args.previousPath ? asRecord(await readJsonIfExists(args.previousPath)) : null
  const paperRows = await loadPaperTradeRows(args.paperTradeResultPath)
  const report = buildPaperExecutionFutureTelemetryWatchdogReport({
    generatedAt: new Date().toISOString(),
    args,
    producerContractStatus,
    executionQuality,
    previous,
    paperRows,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    const withoutHash = `${JSON.stringify({ ...report, outputHash: null }, null, 2)}\n`
    const outputHash = sha256Hex(withoutHash)
    const finalPayload = `${JSON.stringify({ ...report, outputHash }, null, 2)}\n`
    await writeFile(outputPath, finalPayload, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'paper_execution_future_telemetry_watchdog',
      artifactPath: outputPath,
      manifestPath: `${outputPath}.manifest.json`,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status.startsWith('blocked') ? 'fail' : 'warn',
      recordsIn: report.counts.closedRows,
      recordsOut: report.counts.futureClosedRows,
      errorClass: report.blockers[0] ?? report.evidenceBlockers[0] ?? null,
      artifactHash: sha256Hex(finalPayload),
    })
    return { ...report, outputHash }
  }

  return report
}

export function buildPaperExecutionFutureTelemetryWatchdogReport(input: {
  generatedAt: string
  args: CliArgs
  producerContractStatus: UnknownRecord | null
  executionQuality: UnknownRecord | null
  previous: UnknownRecord | null
  paperRows: PaperTradeLoadResult
}): PaperExecutionFutureTelemetryWatchdogReport {
  const producerContract = asRecord(input.producerContractStatus?.producerContract)
  const executionEvidence = asRecord(input.executionQuality?.evidence)
  const executionQuality = asRecord(input.executionQuality?.quality)
  const monitoringStartedAt = selectMonitoringStart(input)
  const monitoringStartMs = Date.parse(monitoringStartedAt)
  const generatedAtMs = Date.parse(input.generatedAt)
  const futureClosedRows = input.paperRows.rows.filter(row => row.closeMs >= monitoringStartMs)
  const futureClosedRowsWithOpenAfterStart = futureClosedRows.filter(row => row.openMs != null && row.openMs >= monitoringStartMs)
  const futureRowsWithPaperFillTelemetry = futureClosedRows.filter(hasPaperFillTelemetry)
  const futureRowsMissingPaperFillTelemetry = futureClosedRows.filter(row => !hasPaperFillTelemetry(row))
  const futureRowsWithPaperFillExpectedCost = futureClosedRows.filter(row => row.paperFillExpectedCostBps != null)
  const futureRowsWithPaperFillSimulatedSlippage = futureClosedRows.filter(row => row.paperFillSimulatedSlippageBps != null)
  const futureRowsWithPaperFillRouteCost = futureClosedRows.filter(row => row.paperFillRouteCostBps != null)
  const futureRowsWithCompletePredictedOpenEvidence = futureClosedRows.filter(hasCompletePredictedOpenEvidence)
  const futureNewOpenRowsWithCompletePredictedOpenEvidence = futureClosedRowsWithOpenAfterStart.filter(hasCompletePredictedOpenEvidence)
  const futureNewOpenRowsMissingPredictedOpenEvidence = futureClosedRowsWithOpenAfterStart.filter(row => !hasCompletePredictedOpenEvidence(row))
  const futureRowsWithExchangeReconciledCostEvidence = futureClosedRows.filter(hasExchangeReconciledCostEvidence)
  const futureRowsWithFillAdjustedCostEvidence = futureClosedRows.filter(hasFillAdjustedCostEvidence)
  const futureRowsWithObservedSlippage = futureClosedRows.filter(hasObservedSlippage)
  const futurePaperFillTelemetryCoveragePct = coveragePct(futureRowsWithPaperFillTelemetry.length, futureClosedRows.length)
  const futurePredictedOpenEvidenceCoveragePct = coveragePct(futureRowsWithCompletePredictedOpenEvidence.length, futureClosedRows.length)
  const futureNewOpenPredictedOpenEvidenceCoveragePct = coveragePct(
    futureNewOpenRowsWithCompletePredictedOpenEvidence.length,
    futureClosedRowsWithOpenAfterStart.length,
  )
  const producerReadyForFutureRows = readBoolean(producerContract?.futurePaperCloseRowsReady) === true
  const hasFutureClosedRows = futureClosedRows.length > 0
  const futurePaperFillTelemetrySufficient =
    hasFutureClosedRows &&
    futurePaperFillTelemetryCoveragePct != null &&
    futurePaperFillTelemetryCoveragePct >= input.args.minFuturePaperFillTelemetryCoveragePct
  const futurePredictedOpenEvidenceSufficient =
    futureClosedRowsWithOpenAfterStart.length === 0 ||
    (
      futureNewOpenPredictedOpenEvidenceCoveragePct != null &&
      futureNewOpenPredictedOpenEvidenceCoveragePct >= input.args.minFuturePredictedOpenEvidenceCoveragePct
    )
  const exchangeReconciledCostEvidenceAvailable = futureRowsWithExchangeReconciledCostEvidence.length > 0
  const observedSlippageAvailable = futureRowsWithObservedSlippage.length > 0
  const artifactAllowsExecution = artifactAuthorizesExecution(input.producerContractStatus) ||
    artifactAuthorizesExecution(input.executionQuality) ||
    artifactAuthorizesExecution(input.previous)
  const sampleProblemTradeIds = futureClosedRows
    .filter(row => !hasPaperFillTelemetry(row) || (row.openMs != null && row.openMs >= monitoringStartMs && !hasCompletePredictedOpenEvidence(row)))
    .map(row => row.tradeId)
    .slice(0, 12)
  const latestClosedRow = latestByCloseMs(input.paperRows.rows)
  const latestFutureClosedRow = latestByCloseMs(futureClosedRows)
  const latestFutureNewOpenClosedRow = latestByCloseMs(futureClosedRowsWithOpenAfterStart)
  const closedRowsBeforeMonitoringStart = input.paperRows.rows.filter(row => row.closeMs < monitoringStartMs).length
  const blockers = uniqueStrings([
    ...(artifactAllowsExecution ? ['input_artifact_must_not_authorize_execution'] : []),
    ...(input.producerContractStatus ? [] : ['paper_execution_producer_contract_status_missing']),
    ...(producerReadyForFutureRows ? [] : ['paper_execution_future_producer_contract_not_ready']),
    ...(input.paperRows.malformedRows === 0 ? [] : [`paper_trade_result_malformed_rows:${input.paperRows.malformedRows}`]),
    ...(hasFutureClosedRows && !futurePaperFillTelemetrySufficient
      ? [`future_paper_fill_telemetry_coverage_low:${futurePaperFillTelemetryCoveragePct ?? 'missing'}<${input.args.minFuturePaperFillTelemetryCoveragePct}`]
      : []),
    ...(hasFutureClosedRows && !futurePredictedOpenEvidenceSufficient
      ? [`future_predicted_open_evidence_coverage_low:${futureNewOpenPredictedOpenEvidenceCoveragePct ?? 'missing'}<${input.args.minFuturePredictedOpenEvidenceCoveragePct}`]
      : []),
  ])
  const evidenceBlockers = uniqueStrings([
    ...(hasFutureClosedRows ? [] : ['future_closed_paper_rows_missing']),
    ...(futureClosedRowsWithOpenAfterStart.length > 0 ? [] : ['future_new_open_closed_rows_missing']),
    ...(exchangeReconciledCostEvidenceAvailable ? [] : ['exchange_reconciled_cost_evidence_missing']),
    ...(observedSlippageAvailable ? [] : ['observed_slippage_unavailable']),
    'paper_execution_future_watchdog_diagnostic_only',
  ])
  const status = buildStatus({
    blockers,
    hasFutureClosedRows,
    futurePaperFillTelemetrySufficient,
    futurePredictedOpenEvidenceSufficient,
  })
  const telemetryGapStatus = buildTelemetryGapStatus({
    status,
    hasFutureClosedRows,
    futurePaperFillTelemetrySufficient,
    futurePredictedOpenEvidenceSufficient,
    exchangeReconciledCostEvidenceAvailable,
    observedSlippageAvailable,
  })

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    futureOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status,
    monitoringStartedAt,
    sourceArtifacts: {
      paperTradeResultPath: resolve(input.args.paperTradeResultPath),
      producerContractStatusPath: resolve(input.args.producerContractStatusPath),
      executionQualityPath: resolve(input.args.executionQualityPath),
      previousPath: input.args.previousPath ? resolve(input.args.previousPath) : null,
    },
    thresholds: {
      minFuturePaperFillTelemetryCoveragePct: input.args.minFuturePaperFillTelemetryCoveragePct,
      minFuturePredictedOpenEvidenceCoveragePct: input.args.minFuturePredictedOpenEvidenceCoveragePct,
    },
    producerContract: {
      exists: input.producerContractStatus != null,
      generatedAt: readString(input.producerContractStatus?.generatedAt),
      status: readString(input.producerContractStatus?.status),
      futurePaperCloseRowsReady: producerReadyForFutureRows,
    },
    executionQuality: {
      exists: input.executionQuality != null,
      generatedAt: readString(input.executionQuality?.generatedAt),
      closedTrades: readNumber(executionEvidence?.closedTrades) ?? 0,
      tradesWithPaperFillTelemetry: readNumber(executionEvidence?.tradesWithPaperFillTelemetry) ?? 0,
      tradesWithExchangeReconciledCostEvidence: readNumber(executionEvidence?.tradesWithExchangeReconciledCostEvidence) ?? 0,
      observedSlippageAvailable:
        readNumber(executionQuality?.volumeWeightedSlippageBps) != null ||
        readNumber(executionQuality?.maxObservedSlippageBps) != null,
    },
    counts: {
      totalLines: input.paperRows.totalLines,
      parsedRows: input.paperRows.parsedRows,
      malformedRows: input.paperRows.malformedRows,
      closedRows: input.paperRows.closedRows,
      futureClosedRows: futureClosedRows.length,
      futureClosedRowsWithOpenAfterStart: futureClosedRowsWithOpenAfterStart.length,
      futureRowsWithPaperFillTelemetry: futureRowsWithPaperFillTelemetry.length,
      futureRowsWithPaperFillExpectedCost: futureRowsWithPaperFillExpectedCost.length,
      futureRowsWithPaperFillSimulatedSlippage: futureRowsWithPaperFillSimulatedSlippage.length,
      futureRowsWithPaperFillRouteCost: futureRowsWithPaperFillRouteCost.length,
      futureRowsWithCompletePredictedOpenEvidence: futureRowsWithCompletePredictedOpenEvidence.length,
      futureNewOpenRowsWithCompletePredictedOpenEvidence: futureNewOpenRowsWithCompletePredictedOpenEvidence.length,
      futureRowsWithExchangeReconciledCostEvidence: futureRowsWithExchangeReconciledCostEvidence.length,
      futureRowsWithFillAdjustedCostEvidence: futureRowsWithFillAdjustedCostEvidence.length,
      futureRowsWithObservedSlippage: futureRowsWithObservedSlippage.length,
    },
    coverage: {
      futurePaperFillTelemetryCoveragePct,
      futurePaperFillExpectedCostCoveragePct: coveragePct(futureRowsWithPaperFillExpectedCost.length, futureClosedRows.length),
      futurePredictedOpenEvidenceCoveragePct,
      futureNewOpenPredictedOpenEvidenceCoveragePct,
      futureExchangeReconciledCostCoveragePct: coveragePct(futureRowsWithExchangeReconciledCostEvidence.length, futureClosedRows.length),
      futureObservedSlippageCoveragePct: coveragePct(futureRowsWithObservedSlippage.length, futureClosedRows.length),
    },
    readiness: {
      producerReadyForFutureRows,
      hasFutureClosedRows,
      futurePaperFillTelemetrySufficient,
      futurePredictedOpenEvidenceSufficient,
      exchangeReconciledCostEvidenceAvailable,
      observedSlippageAvailable,
      promotionGradePaperExecutionEvidence: false,
    },
    telemetryGap: {
      status: telemetryGapStatus,
      monitoringAgeMinutes: minutesBetween(monitoringStartMs, generatedAtMs),
      latestClosedAt: latestClosedRow?.closeTs ?? null,
      latestClosedAgeMinutes: latestClosedRow ? minutesBetween(latestClosedRow.closeMs, generatedAtMs) : null,
      latestClosedBeforeMonitoringStart: latestClosedRow ? latestClosedRow.closeMs < monitoringStartMs : null,
      latestFutureClosedAt: latestFutureClosedRow?.closeTs ?? null,
      latestFutureNewOpenClosedAt: latestFutureNewOpenClosedRow?.closeTs ?? null,
      closedRowsBeforeMonitoringStart,
      futureClosedRowsAfterMonitoringStart: futureClosedRows.length,
      futureRowsMissingPaperFillTelemetry: futureRowsMissingPaperFillTelemetry.length,
      futureNewOpenRowsMissingPredictedOpenEvidence: futureNewOpenRowsMissingPredictedOpenEvidence.length,
      sampleFutureRowsMissingPaperFillTelemetry: futureRowsMissingPaperFillTelemetry.map(row => row.tradeId).slice(0, 12),
      sampleFutureNewOpenRowsMissingPredictedOpenEvidence: futureNewOpenRowsMissingPredictedOpenEvidence.map(row => row.tradeId).slice(0, 12),
    },
    sampleProblemTradeIds,
    blockers,
    evidenceBlockers,
    nextActions: buildNextActions(status),
    safetyNotes: [
      'This watchdog is future-only. It preserves monitoringStartedAt and does not backfill historical paper rows as promotion evidence.',
      'paperFillTelemetryStatus=paper_model_not_exchange_reconciled is useful paper-model telemetry, but it does not satisfy exchange-reconciled cost or observed slippage gates.',
      'This artifact never authorizes paper, live, promotion, leverage changes, orders, or best_config mutations.',
    ],
    outputHash: null,
  }
}

async function loadPaperTradeRows(path: string): Promise<PaperTradeLoadResult> {
  if (!existsSync(path)) {
    return { rows: [], totalLines: 0, parsedRows: 0, closedRows: 0, malformedRows: 0 }
  }
  const raw = await readFile(path, 'utf-8')
  const rows: PaperTradeRow[] = []
  let totalLines = 0
  let parsedRows = 0
  let malformedRows = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    totalLines += 1
    try {
      const parsed = JSON.parse(line) as unknown
      if (!isRecord(parsed)) {
        malformedRows += 1
        continue
      }
      parsedRows += 1
      const row = normalizePaperTradeRow(parsed)
      if (row) rows.push(row)
    } catch {
      malformedRows += 1
    }
  }
  return { rows, totalLines, parsedRows, closedRows: rows.length, malformedRows }
}

function normalizePaperTradeRow(record: UnknownRecord): PaperTradeRow | null {
  const closeTs = readString(record.closeTs ?? record.exitTime)
  const closeMs = closeTs ? Date.parse(closeTs) : Number.NaN
  if (!closeTs || !Number.isFinite(closeMs)) return null
  const openTs = readString(record.openTs ?? record.entryTime)
  const openMs = openTs ? Date.parse(openTs) : Number.NaN
  return {
    tradeId: readString(record.tradeId ?? record.id) ?? `unknown:${closeTs}`,
    lane: readString(record.lane),
    symbol: readString(record.symbol),
    openTs,
    closeTs,
    closeMs,
    openMs: Number.isFinite(openMs) ? openMs : null,
    predictedOpenEvidenceStatus: readString(record.predictedOpenEvidenceStatus),
    paperFillTelemetryStatus: readString(record.paperFillTelemetryStatus),
    paperFillExpectedCostBps: readNumber(record.paperFillExpectedCostBps),
    paperFillSimulatedSlippageBps: readNumber(record.paperFillSimulatedSlippageBps),
    paperFillRouteCostBps: readNumber(record.paperFillRouteCostBps),
    paperFillIsExchangeReconciled: readBoolean(record.paperFillIsExchangeReconciled),
    costEvidenceSource: readString(record.costEvidenceSource),
    realizedRoundTripCostBps: readNumber(record.realizedRoundTripCostBps),
    realizedCostBps: readNumber(record.realizedCostBps),
    fillAdjustedCostBps: readNumber(record.fillAdjustedCostBps),
    fillAdjustedCostPct: readNumber(record.fillAdjustedCostPct),
  }
}

function selectMonitoringStart(input: {
  generatedAt: string
  producerContractStatus: UnknownRecord | null
  previous: UnknownRecord | null
}): string {
  const previous = readString(input.previous?.monitoringStartedAt)
  if (previous && Number.isFinite(Date.parse(previous))) return previous
  const producerGeneratedAt = readString(input.producerContractStatus?.generatedAt)
  if (producerGeneratedAt && Number.isFinite(Date.parse(producerGeneratedAt))) return producerGeneratedAt
  return input.generatedAt
}

function hasPaperFillTelemetry(row: PaperTradeRow): boolean {
  return row.paperFillTelemetryStatus === 'paper_model_not_exchange_reconciled' &&
    row.paperFillIsExchangeReconciled === false &&
    row.paperFillExpectedCostBps != null
}

function hasCompletePredictedOpenEvidence(row: PaperTradeRow): boolean {
  return row.predictedOpenEvidenceStatus === 'ok'
}

function hasExchangeReconciledCostEvidence(row: PaperTradeRow): boolean {
  return row.costEvidenceSource === 'exchange_reconciled_fill'
}

function hasFillAdjustedCostEvidence(row: PaperTradeRow): boolean {
  if (row.costEvidenceSource === 'paper_cost_model_at_open') return false
  return row.fillAdjustedCostBps != null || row.fillAdjustedCostPct != null
}

function hasObservedSlippage(row: PaperTradeRow): boolean {
  if (!hasExchangeReconciledCostEvidence(row)) return false
  return row.realizedCostBps != null ||
    row.realizedRoundTripCostBps != null ||
    row.fillAdjustedCostBps != null ||
    row.fillAdjustedCostPct != null
}

function latestByCloseMs(rows: PaperTradeRow[]): PaperTradeRow | null {
  return rows
    .filter(row => Number.isFinite(row.closeMs))
    .sort((left, right) => right.closeMs - left.closeMs)[0] ?? null
}

function minutesBetween(startMs: number, endMs: number): number | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return Math.round(Math.max(0, endMs - startMs) / 60000)
}

function buildTelemetryGapStatus(input: {
  status: WatchdogStatus
  hasFutureClosedRows: boolean
  futurePaperFillTelemetrySufficient: boolean
  futurePredictedOpenEvidenceSufficient: boolean
  exchangeReconciledCostEvidenceAvailable: boolean
  observedSlippageAvailable: boolean
}): TelemetryGapStatus {
  if (input.status === 'blocked') return 'input_or_contract_blocked'
  if (!input.hasFutureClosedRows) return 'waiting_for_future_close_rows'
  if (!input.futurePaperFillTelemetrySufficient || !input.futurePredictedOpenEvidenceSufficient) {
    return 'future_close_rows_missing_paper_model_telemetry'
  }
  if (!input.exchangeReconciledCostEvidenceAvailable || !input.observedSlippageAvailable) {
    return 'paper_model_ready_missing_exchange_reconciled_or_observed_slippage'
  }
  return 'future_execution_evidence_observed_but_diagnostic_only'
}

function buildStatus(input: {
  blockers: string[]
  hasFutureClosedRows: boolean
  futurePaperFillTelemetrySufficient: boolean
  futurePredictedOpenEvidenceSufficient: boolean
}): WatchdogStatus {
  if (input.blockers.some(blocker =>
    blocker === 'input_artifact_must_not_authorize_execution' ||
    blocker === 'paper_execution_producer_contract_status_missing' ||
    blocker === 'paper_execution_future_producer_contract_not_ready' ||
    blocker.startsWith('paper_trade_result_malformed_rows:')
  )) {
    return 'blocked'
  }
  if (!input.hasFutureClosedRows) return 'watch_waiting_for_future_rows'
  if (!input.futurePaperFillTelemetrySufficient || !input.futurePredictedOpenEvidenceSufficient) {
    return 'blocked_future_rows_missing_telemetry'
  }
  return 'watch_future_paper_model_telemetry_ready'
}

function buildNextActions(status: WatchdogStatus): string[] {
  if (status === 'watch_waiting_for_future_rows') {
    return [
      'Wait for future gated paper/shadow close rows after monitoringStartedAt; do not backfill old rows as promotion evidence.',
      'Refresh paper:execution-quality, paper:execution-producer-contract, and this watchdog after future rows close.',
    ]
  }
  if (status === 'watch_future_paper_model_telemetry_ready') {
    return [
      'Paper-model telemetry is appearing on future rows; keep it diagnostic until exchange-reconciled fill evidence and observed slippage exist.',
      'Continue keeping paper/live disabled until release gates pass independently.',
    ]
  }
  return [
    'Fix future paper close producers so every future close row emits paperFillTelemetry and complete predicted-open evidence.',
    'Do not use historical or manually backfilled rows as promotion evidence.',
  ]
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as unknown
  } catch {
    return null
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg?.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq >= 0) {
      out.set(arg.slice(2, eq), arg.slice(eq + 1))
      continue
    }
    const key = arg.slice(2)
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

function parseNullablePath(value: string | null | undefined): string | null {
  if (value == null) return null
  const normalized = value.trim().toLowerCase()
  return normalized === '' || normalized === 'null' || normalized === 'none' ? null : value
}

function parsePercent(value: string | undefined, fallback: number, name: string): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${name}_must_be_between_0_and_100`)
  }
  return parsed
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase())
}

function isRecord(value: unknown): value is UnknownRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function coveragePct(count: number, total: number): number | null {
  return total <= 0 ? null : Math.round(count / total * 100_000_000) / 1_000_000
}

function artifactAuthorizesExecution(value: UnknownRecord | null): boolean {
  return readBoolean(value?.promotionEligible) === true ||
    readBoolean(value?.paperTradingAllowed) === true ||
    readBoolean(value?.liveTradingAllowed) === true ||
    readBoolean(value?.executionAllowed) === true ||
    readBoolean(value?.promotionAllowedByThisArtifact) === true ||
    readBoolean(value?.paperTradingAllowedByThisArtifact) === true ||
    readBoolean(value?.liveTradingAllowedByThisArtifact) === true
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim() !== ''))]
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: PaperExecutionFutureTelemetryWatchdogReport): string {
  return [
    `Paper execution future telemetry watchdog: ${report.status}`,
    `monitoringStartedAt=${report.monitoringStartedAt}`,
    `futureClosed=${report.counts.futureClosedRows} paperFill=${report.counts.futureRowsWithPaperFillTelemetry}/${report.counts.futureClosedRows} predictedNewOpen=${report.counts.futureNewOpenRowsWithCompletePredictedOpenEvidence}/${report.counts.futureClosedRowsWithOpenAfterStart}`,
    `exchangeReconciled=${report.counts.futureRowsWithExchangeReconciledCostEvidence} observedSlippage=${report.counts.futureRowsWithObservedSlippage}`,
    `paper=false live=false promotion=false execution=false`,
    `topBlockers=${report.blockers.slice(0, 8).join(',') || report.evidenceBlockers.slice(0, 8).join(',') || 'none'}`,
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
