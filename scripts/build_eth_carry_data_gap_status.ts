import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type DataGapStatus = 'blocked_no_inputs' | 'blocked_insufficient_research_data' | 'watch_ready_for_more_capture'
type ArchiveStatus = 'complete' | 'partial' | 'missing' | 'in_progress'
type ArchiveScope = 'core_smoke' | 'full_catalog'

interface CliArgs {
  featurePath: string
  pitAuditPath: string
  prospectivePath: string
  capturePath: string
  collectorPath: string
  okxCarrySnapshotPath?: string
  okxCarrySnapshotRowsPath?: string
  downloadMonitorPath: string
  warehouseRoot: string
  outputPath: string | null
  minCarryFeatureRows: number
  minProspectiveClosedOutcomes: number
  minClosedDecisionWindows: number
  maxCollectorErrorCount: number
  asOfMs: number | null
  json: boolean
}

interface DataVisionArchiveSpec {
  datasetId: string
  directory: string
  scope: ArchiveScope
}

export interface EthCarryDataVisionArchiveStatus {
  datasetId: string
  scope: ArchiveScope
  path: string
  exists: boolean
  zipFiles: number
  partFiles: number
  dataFiles: number
  summaryPresent: boolean
  manifestPresent: boolean
  summaryCoverage: string | null
  summaryComplete: boolean | null
  status: ArchiveStatus
  blockers: string[]
}

export interface EthCarryDataVisionArchiveSummary {
  coreSmokeArchives: number
  coreSmokeArchivesComplete: number
  coreSmokeComplete: boolean
  fullCatalogArchives: number
  fullCatalogArchivesComplete: number
  fullCatalogComplete: boolean
  coreSmokeBlockers: string[]
  fullCatalogBlockers: string[]
}

export interface EthCarryDataGapStatusReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: DataGapStatus
  sourceArtifacts: {
    featurePath: string
    pitAuditPath: string
    prospectivePath: string
    capturePath: string
    collectorPath: string
    okxCarrySnapshotPath?: string
    okxCarrySnapshotRowsPath: string
    downloadMonitorPath: string
    warehouseRoot: string
  }
  thresholds: {
    minCarryFeatureRows: number
    minProspectiveClosedOutcomes: number
    minClosedDecisionWindows: number
    maxCollectorErrorCount: number
    collectorStaleAfterMs: number
  }
  counts: {
    sourceEvents: number
    fundingEvents: number
    basisSnapshots: number
    carryFeatureRows: number
    rowsMissingAvailableAt: number
    sourceLineageIncompleteRows: number
    pitAuditedRows: number
    pitPassingRows: number
    pitFailingRows: number
    prospectiveOpenEvents: number
    prospectiveClosedEvents: number
    prospectivePendingOpenEvents: number
    prospectiveDueOpenEventsWithoutClose: number
    prospectiveClosedOutcomes: number
    prospectiveClosedDecisionWindows: number
    prospectiveClosedOutcomeShortfall: number
    prospectiveClosedWindowShortfall: number
    captureFeatureRowsLoaded: number
    captureObservationsBuilt: number
    captureSkippedAlreadyDueObservations: number
    collectorFetchedRows: number
    collectorAppendedRows: number
    collectorWouldAppendRows: number
    collectorSkippedDuplicateRows: number
    collectorErrorCount: number
    externalCollectorErrorCount: number
    okxCarrySnapshotRowsBuilt: number
    okxCarrySnapshotRowsAppended: number
    okxCarrySnapshotDuplicateRows: number
    okxCarrySnapshotErrorCount: number
    okxCarrySnapshotCacheRows: number
  }
  pitStatus: {
    featureStatus: string | null
    auditStatus: string | null
    fundingSymbols: string[]
    basisSymbols: string[]
  }
  prospectiveStatus: {
    status: string | null
    latestOpenObservationId: string | null
    latestOpenDecisionTime: string | null
    latestOpenLabelDueTime: string | null
  }
  captureStatus: {
    status: string | null
    dryRun: boolean | null
    blockers: string[]
  }
  collectorStatus: {
    exists: boolean
    generatedAt: string | null
    ageMs: number | null
    stale: boolean
    dryRun: boolean | null
    proxyConfigured: boolean | null
    proxySource: string | null
    errorSummary: Record<string, number>
  }
  okxCarrySnapshotStatus: {
    exists: boolean
    generatedAt: string | null
    ageMs: number | null
    stale: boolean
    dryRun: boolean | null
    status: string | null
    rowsBuilt: number
    rowsAppended: number
    duplicateRows: number
    errorCount: number
    reportRowsBuilt: number
    reportErrorCount: number
    blockers: string[]
    reportBlockers: string[]
    cacheRows: number
    cacheSymbols: string[]
    cacheLatestAvailableAt: string | null
    cacheFallbackUsed: boolean
  }
  downloadMonitorStatus: {
    exists: boolean
    generatedAt: string | null
    status: string | null
    blockers: string[]
  }
  dataVisionCoreSmokeArchives: EthCarryDataVisionArchiveStatus[]
  dataVisionArchives: EthCarryDataVisionArchiveStatus[]
  dataVisionArchiveSummary: EthCarryDataVisionArchiveSummary
  catalogBlockers: string[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  outputHash: string | null
}

const DEFAULT_FEATURE_PATH = 'data/research/eth_carry_pit_features.latest.json'
const DEFAULT_PIT_AUDIT_PATH = 'data/research/eth_carry_pit_audit.latest.json'
const DEFAULT_PROSPECTIVE_PATH = 'data/research/eth_carry_prospective_evidence_status.latest.json'
const DEFAULT_CAPTURE_PATH = 'data/research/eth_carry_prospective_observation_capture.latest.json'
const DEFAULT_COLLECTOR_PATH = 'data/runtime/external_derivatives_data_collect.latest.json'
const DEFAULT_OKX_CARRY_SNAPSHOT_PATH = 'data/runtime/okx_carry_snapshot_collect.latest.json'
const DEFAULT_OKX_CARRY_SNAPSHOT_ROWS_PATH = 'data/normalized/derivatives/okx_swap_eth_carry_live.normalized.jsonl'
const DEFAULT_DOWNLOAD_MONITOR_PATH = 'data/runtime/openalice_download_monitor.latest.json'
const DEFAULT_WAREHOUSE_ROOT = 'data'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_data_gap_status.latest.json'
const DEFAULT_MIN_CARRY_FEATURE_ROWS = 100
const DEFAULT_MIN_PROSPECTIVE_CLOSED_OUTCOMES = 100
const DEFAULT_MIN_CLOSED_DECISION_WINDOWS = 3
const DEFAULT_MAX_COLLECTOR_ERROR_COUNT = 0
const COLLECTOR_STALE_AFTER_MS = 10 * 60 * 60 * 1000

const CORE_DATA_VISION_ARCHIVE_SPECS: DataVisionArchiveSpec[] = [
  {
    datasetId: 'binance-public:um:fundingRate:usdt',
    directory: 'market/binance-public/eth-carry-core-fundingRate',
    scope: 'core_smoke',
  },
  {
    datasetId: 'binance-public:um:markPriceKlines:1h:usdt',
    directory: 'market/binance-public/eth-carry-core-markPriceKlines-1h',
    scope: 'core_smoke',
  },
  {
    datasetId: 'binance-public:um:indexPriceKlines:1h:usdt',
    directory: 'market/binance-public/eth-carry-core-indexPriceKlines-1h',
    scope: 'core_smoke',
  },
  {
    datasetId: 'binance-public:um:premiumIndexKlines:1h:usdt',
    directory: 'market/binance-public/eth-carry-core-premiumIndexKlines-1h',
    scope: 'core_smoke',
  },
]

const FULL_CATALOG_DATA_VISION_ARCHIVE_SPECS: DataVisionArchiveSpec[] = [
  {
    datasetId: 'binance-public:um:fundingRate:usdt',
    directory: 'market/binance-public/um-all-usdt-fundingRate',
    scope: 'full_catalog',
  },
  {
    datasetId: 'binance-public:um:markPriceKlines:1h:usdt',
    directory: 'market/binance-public/um-all-usdt-markPriceKlines-1h',
    scope: 'full_catalog',
  },
  {
    datasetId: 'binance-public:um:indexPriceKlines:1h:usdt',
    directory: 'market/binance-public/um-all-usdt-indexPriceKlines-1h',
    scope: 'full_catalog',
  },
  {
    datasetId: 'binance-public:um:premiumIndexKlines:1h:usdt',
    directory: 'market/binance-public/um-all-usdt-premiumIndexKlines-1h',
    scope: 'full_catalog',
  },
]

async function main(): Promise<void> {
  const args = parseEthCarryDataGapStatusArgs(process.argv.slice(2))
  const report = await runEthCarryDataGapStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseEthCarryDataGapStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT ?? DEFAULT_WAREHOUSE_ROOT
  return {
    featurePath: raw.get('featurePath') ?? raw.get('features') ?? DEFAULT_FEATURE_PATH,
    pitAuditPath: raw.get('pitAuditPath') ?? raw.get('pitAudit') ?? DEFAULT_PIT_AUDIT_PATH,
    prospectivePath: raw.get('prospectivePath') ?? raw.get('prospective') ?? DEFAULT_PROSPECTIVE_PATH,
    capturePath: raw.get('capturePath') ?? raw.get('capture') ?? DEFAULT_CAPTURE_PATH,
    collectorPath: raw.get('collectorPath') ?? raw.get('collector') ?? DEFAULT_COLLECTOR_PATH,
    okxCarrySnapshotPath: raw.get('okxCarrySnapshotPath') ?? raw.get('okxSnapshot') ?? DEFAULT_OKX_CARRY_SNAPSHOT_PATH,
    okxCarrySnapshotRowsPath: raw.get('okxCarrySnapshotRowsPath') ?? resolve(dataRoot, 'normalized/derivatives/okx_swap_eth_carry_live.normalized.jsonl'),
    downloadMonitorPath: raw.get('downloadMonitorPath') ?? raw.get('downloadMonitor') ?? DEFAULT_DOWNLOAD_MONITOR_PATH,
    warehouseRoot: resolve(raw.get('warehouseRoot') ?? dataRoot),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    minCarryFeatureRows: parsePositiveInteger(raw.get('minCarryFeatureRows'), DEFAULT_MIN_CARRY_FEATURE_ROWS, 'minCarryFeatureRows'),
    minProspectiveClosedOutcomes: parsePositiveInteger(
      raw.get('minProspectiveClosedOutcomes'),
      DEFAULT_MIN_PROSPECTIVE_CLOSED_OUTCOMES,
      'minProspectiveClosedOutcomes',
    ),
    minClosedDecisionWindows: parsePositiveInteger(
      raw.get('minClosedDecisionWindows'),
      DEFAULT_MIN_CLOSED_DECISION_WINDOWS,
      'minClosedDecisionWindows',
    ),
    maxCollectorErrorCount: parseNonNegativeInteger(
      raw.get('maxCollectorErrorCount'),
      DEFAULT_MAX_COLLECTOR_ERROR_COUNT,
      'maxCollectorErrorCount',
    ),
    asOfMs: parseNullableTimestamp(raw.get('asOf')),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryDataGapStatus(args: CliArgs): Promise<EthCarryDataGapStatusReport> {
  const startedAt = new Date()
  const featurePath = resolve(args.featurePath)
  const pitAuditPath = resolve(args.pitAuditPath)
  const prospectivePath = resolve(args.prospectivePath)
  const capturePath = resolve(args.capturePath)
  const collectorPath = resolve(args.collectorPath)
  const okxCarrySnapshotPath = resolve(args.okxCarrySnapshotPath ?? DEFAULT_OKX_CARRY_SNAPSHOT_PATH)
  const okxCarrySnapshotRowsPath = resolve(args.okxCarrySnapshotRowsPath ?? DEFAULT_OKX_CARRY_SNAPSHOT_ROWS_PATH)
  const downloadMonitorPath = resolve(args.downloadMonitorPath)
  const warehouseRoot = resolve(args.warehouseRoot)
  const report = buildEthCarryDataGapStatusReport({
    generatedAt: new Date().toISOString(),
    asOfMs: args.asOfMs ?? Date.now(),
    featurePath,
    pitAuditPath,
    prospectivePath,
    capturePath,
    collectorPath,
    okxCarrySnapshotPath,
    okxCarrySnapshotRowsPath,
    downloadMonitorPath,
    warehouseRoot,
    featureExists: existsSync(featurePath),
    pitAuditExists: existsSync(pitAuditPath),
    prospectiveExists: existsSync(prospectivePath),
    captureExists: existsSync(capturePath),
    collectorExists: existsSync(collectorPath),
    okxCarrySnapshotExists: existsSync(okxCarrySnapshotPath),
    downloadMonitorExists: existsSync(downloadMonitorPath),
    pitFeatureDataset: await readJsonIfExists(featurePath),
    pitAudit: await readJsonIfExists(pitAuditPath),
    prospectiveEvidence: await readJsonIfExists(prospectivePath),
    capture: await readJsonIfExists(capturePath),
    collector: await readJsonIfExists(collectorPath),
    okxCarrySnapshot: await readJsonIfExists(okxCarrySnapshotPath),
    okxCarrySnapshotRows: readJsonlIfExists(okxCarrySnapshotRowsPath),
    downloadMonitor: await readJsonIfExists(downloadMonitorPath),
    thresholds: {
      minCarryFeatureRows: args.minCarryFeatureRows,
      minProspectiveClosedOutcomes: args.minProspectiveClosedOutcomes,
      minClosedDecisionWindows: args.minClosedDecisionWindows,
      maxCollectorErrorCount: args.maxCollectorErrorCount,
    },
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    const payloadWithoutHash = `${JSON.stringify({ ...report, outputHash: null }, null, 2)}\n`
    const outputHash = sha256Hex(payloadWithoutHash)
    const finalPayload = `${JSON.stringify({ ...report, outputHash }, null, 2)}\n`
    const artifactHash = sha256Hex(finalPayload)
    await writeFile(outputPath, finalPayload, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_data_gap_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked_no_inputs' ? 'fail' : 'warn',
      recordsIn: report.counts.sourceEvents + report.counts.prospectiveOpenEvents + report.counts.prospectiveClosedEvents,
      recordsOut: report.counts.carryFeatureRows,
      errorClass: report.blockers[0] ?? null,
      artifactHash,
    })
    return { ...report, outputHash }
  }

  return report
}

export function buildEthCarryDataGapStatusReport(input: {
  generatedAt?: string
  asOfMs?: number
  featurePath: string
  pitAuditPath: string
  prospectivePath: string
  capturePath: string
  collectorPath: string
  okxCarrySnapshotPath?: string
  okxCarrySnapshotRowsPath: string
  downloadMonitorPath: string
  warehouseRoot: string
  featureExists: boolean
  pitAuditExists: boolean
  prospectiveExists: boolean
  captureExists: boolean
  collectorExists: boolean
  okxCarrySnapshotExists?: boolean
  downloadMonitorExists: boolean
  pitFeatureDataset: unknown
  pitAudit: unknown
  prospectiveEvidence: unknown
  capture: unknown
  collector: unknown
  okxCarrySnapshot?: unknown
  okxCarrySnapshotRows?: UnknownRecord[]
  downloadMonitor: unknown
  thresholds: {
    minCarryFeatureRows: number
    minProspectiveClosedOutcomes: number
    minClosedDecisionWindows: number
    maxCollectorErrorCount: number
  }
}): EthCarryDataGapStatusReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const asOfMs = input.asOfMs ?? Date.now()
  const pitFeatureDataset = asRecord(input.pitFeatureDataset)
  const pitAudit = asRecord(input.pitAudit)
  const prospectiveEvidence = asRecord(input.prospectiveEvidence)
  const capture = asRecord(input.capture)
  const collector = asRecord(input.collector)
  const okxCarrySnapshot = asRecord(input.okxCarrySnapshot)
  const downloadMonitor = asRecord(input.downloadMonitor)
  const featureCounts = asRecord(pitFeatureDataset?.counts)
  const auditCounts = asRecord(pitAudit?.counts)
  const prospectiveCounts = asRecord(prospectiveEvidence?.counts)
  const prospectiveMetrics = asRecord(prospectiveEvidence?.metrics)
  const captureCounts = asRecord(capture?.counts)
  const collectorSnapshot = readCollectorSnapshot(input.collectorExists, collector, asOfMs)
  const okxCarrySnapshotStatus = readOkxCarrySnapshotStatus(
    input.okxCarrySnapshotExists ?? false,
    okxCarrySnapshot,
    input.okxCarrySnapshotRows ?? [],
    asOfMs,
  )
  const externalCollectorHealthy = isExternalCollectorHealthy(collectorSnapshot, input.thresholds.maxCollectorErrorCount)
  const okxCarrySnapshotHealthy = isOkxCarrySnapshotHealthy(okxCarrySnapshotStatus, input.thresholds.maxCollectorErrorCount)
  const freshCarryCollectorHealthy = okxCarrySnapshotHealthy || externalCollectorHealthy
  const effectiveCollector = okxCarrySnapshotHealthy
    ? {
        fetchedRows: okxCarrySnapshotStatus.rowsBuilt,
        appendedRows: okxCarrySnapshotStatus.rowsAppended,
        wouldAppendRows: 0,
        skippedDuplicateRows: okxCarrySnapshotStatus.duplicateRows,
        errorCount: okxCarrySnapshotStatus.errorCount,
      }
    : collectorSnapshot
  const downloadMonitorBlockers = readStringArray(downloadMonitor?.blockers)
  const coreSmokeArchives = CORE_DATA_VISION_ARCHIVE_SPECS.map(spec => inspectDataVisionArchive(input.warehouseRoot, spec))
  const fullCatalogArchives = FULL_CATALOG_DATA_VISION_ARCHIVE_SPECS.map(spec => inspectDataVisionArchive(input.warehouseRoot, spec))
  const coreSmokeArchiveBlockers = coreSmokeArchives.flatMap(archive => archive.blockers)
  const fullCatalogArchiveBlockers = fullCatalogArchives.flatMap(archive => archive.blockers)
  const archiveSummary: EthCarryDataVisionArchiveSummary = {
    coreSmokeArchives: coreSmokeArchives.length,
    coreSmokeArchivesComplete: coreSmokeArchives.filter(archive => archive.status === 'complete').length,
    coreSmokeComplete: coreSmokeArchives.every(archive => archive.status === 'complete'),
    fullCatalogArchives: fullCatalogArchives.length,
    fullCatalogArchivesComplete: fullCatalogArchives.filter(archive => archive.status === 'complete').length,
    fullCatalogComplete: fullCatalogArchives.every(archive => archive.status === 'complete'),
    coreSmokeBlockers: coreSmokeArchiveBlockers,
    fullCatalogBlockers: fullCatalogArchiveBlockers,
  }

  const sourceEvents = readNumber(featureCounts?.sourceEvents) ?? 0
  const fundingEvents = readNumber(featureCounts?.fundingEvents) ?? 0
  const basisSnapshots = readNumber(featureCounts?.basisSnapshots) ?? 0
  const carryFeatureRows = readNumber(featureCounts?.carryFeatureRows) ?? readRecordArray(pitFeatureDataset?.carryFeatureRows).length
  const rowsMissingAvailableAt = readNumber(featureCounts?.rowsMissingAvailableAt) ?? 0
  const sourceLineageIncompleteRows = readNumber(featureCounts?.sourceLineageIncompleteRows) ?? 0
  const pitAuditedRows = readNumber(auditCounts?.auditedRows) ?? 0
  const pitPassingRows = readNumber(auditCounts?.passingRows) ?? 0
  const pitFailingRows = readNumber(auditCounts?.failingRows) ?? 0
  const prospectiveOpenEvents = readNumber(prospectiveCounts?.openEvents) ?? 0
  const prospectiveClosedEvents = readNumber(prospectiveCounts?.closedEvents) ?? 0
  const prospectivePendingOpenEvents = readNumber(prospectiveCounts?.pendingOpenEvents) ?? 0
  const prospectiveDueOpenEventsWithoutClose = readNumber(prospectiveCounts?.dueOpenEventsWithoutClose) ?? 0
  const prospectiveClosedOutcomes =
    readNumber(prospectiveMetrics?.closedOutcomes) ?? prospectiveClosedEvents
  const prospectiveClosedDecisionWindows = readNumber(prospectiveCounts?.closedDecisionWindows) ?? 0
  const captureFeatureRowsLoaded = readNumber(captureCounts?.featureRowsLoaded) ?? 0
  const captureObservationsBuilt = readNumber(captureCounts?.observationsBuilt) ?? 0
  const captureSkippedAlreadyDueObservations = readNumber(captureCounts?.skippedAlreadyDueObservations) ?? 0
  const prospectiveClosedOutcomeShortfall = Math.max(
    0,
    input.thresholds.minProspectiveClosedOutcomes - prospectiveClosedOutcomes,
  )
  const prospectiveClosedWindowShortfall = Math.max(
    0,
    input.thresholds.minClosedDecisionWindows - prospectiveClosedDecisionWindows,
  )
  const captureBlockers = readStringArray(capture?.blockers)

  const blockers = uniqueStrings([
    ...(input.featureExists || pitFeatureDataset ? [] : ['eth_carry_pit_features_missing']),
    ...(input.pitAuditExists || pitAudit ? [] : ['eth_carry_pit_audit_missing']),
    ...(input.prospectiveExists || prospectiveEvidence ? [] : ['eth_carry_prospective_evidence_missing']),
    ...(carryFeatureRows >= input.thresholds.minCarryFeatureRows
      ? []
      : [`carry_feature_rows_low:${carryFeatureRows}<${input.thresholds.minCarryFeatureRows}`]),
    ...(rowsMissingAvailableAt > 0 ? [`carry_feature_rows_missing_available_at:${rowsMissingAvailableAt}`] : []),
    ...(sourceLineageIncompleteRows > 0 ? [`source_lineage_incomplete_rows:${sourceLineageIncompleteRows}`] : []),
    ...(readString(pitAudit?.status) === 'pass' ? [] : [`pit_audit_not_pass:${readString(pitAudit?.status) ?? 'missing'}`]),
    ...(pitFailingRows > 0 ? [`pit_audit_failing_rows:${pitFailingRows}`] : []),
    ...(prospectiveClosedOutcomes >= input.thresholds.minProspectiveClosedOutcomes
      ? []
      : [`prospective_closed_outcomes_low:${prospectiveClosedOutcomes}<${input.thresholds.minProspectiveClosedOutcomes}`]),
    ...(prospectiveClosedDecisionWindows >= input.thresholds.minClosedDecisionWindows
      ? []
      : [`prospective_closed_windows_low:${prospectiveClosedDecisionWindows}<${input.thresholds.minClosedDecisionWindows}`]),
    ...(captureBlockers.length > 0 ? captureBlockers.map(blocker => `prospective_capture:${blocker}`) : []),
    ...(captureObservationsBuilt === 0 && captureSkippedAlreadyDueObservations > 0 && prospectivePendingOpenEvents === 0
      ? [`prospective_capture_no_future_rows:skipped_already_due=${captureSkippedAlreadyDueObservations}`]
      : []),
    ...(prospectiveDueOpenEventsWithoutClose > 0
      ? [`prospective_due_open_events_without_close:${prospectiveDueOpenEventsWithoutClose}`]
      : []),
    ...(freshCarryCollectorHealthy ? [] : buildOkxCarrySnapshotBlockers(okxCarrySnapshotStatus, input.thresholds.maxCollectorErrorCount)),
    ...(freshCarryCollectorHealthy || collectorSnapshot.exists ? [] : ['external_derivatives_collect_missing']),
    ...(freshCarryCollectorHealthy || !collectorSnapshot.stale ? [] : ['external_derivatives_collect_stale']),
    ...(freshCarryCollectorHealthy || collectorSnapshot.dryRun !== true ? [] : ['external_derivatives_collect_last_run_dry_run']),
    ...(freshCarryCollectorHealthy || collectorSnapshot.errorCount <= input.thresholds.maxCollectorErrorCount
      ? []
      : [`external_derivatives_collect_errors:${formatErrorSummaryBlocker(collectorSnapshot.errorSummary)}`]),
    ...(freshCarryCollectorHealthy ||
      !(collectorSnapshot.exists &&
        collectorSnapshot.dryRun !== true &&
        collectorSnapshot.appendedRows === 0 &&
        collectorSnapshot.fetchedRows === 0)
      ? []
      : ['external_derivatives_rows_not_appended']),
    ...coreSmokeArchiveBlockers,
  ])

  const noCoreInputs = !input.featureExists && !input.pitAuditExists && !input.prospectiveExists &&
    !pitFeatureDataset && !pitAudit && !prospectiveEvidence
  const status: DataGapStatus = noCoreInputs
    ? 'blocked_no_inputs'
    : blockers.length === 0
      ? 'watch_ready_for_more_capture'
      : 'blocked_insufficient_research_data'

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status,
    sourceArtifacts: {
      featurePath: resolve(input.featurePath),
      pitAuditPath: resolve(input.pitAuditPath),
      prospectivePath: resolve(input.prospectivePath),
      capturePath: resolve(input.capturePath),
      collectorPath: resolve(input.collectorPath),
      okxCarrySnapshotPath: resolve(input.okxCarrySnapshotPath ?? DEFAULT_OKX_CARRY_SNAPSHOT_PATH),
      okxCarrySnapshotRowsPath: resolve(input.okxCarrySnapshotRowsPath ?? DEFAULT_OKX_CARRY_SNAPSHOT_ROWS_PATH),
      downloadMonitorPath: resolve(input.downloadMonitorPath),
      warehouseRoot: resolve(input.warehouseRoot),
    },
    thresholds: {
      minCarryFeatureRows: input.thresholds.minCarryFeatureRows,
      minProspectiveClosedOutcomes: input.thresholds.minProspectiveClosedOutcomes,
      minClosedDecisionWindows: input.thresholds.minClosedDecisionWindows,
      maxCollectorErrorCount: input.thresholds.maxCollectorErrorCount,
      collectorStaleAfterMs: COLLECTOR_STALE_AFTER_MS,
    },
    counts: {
      sourceEvents,
      fundingEvents,
      basisSnapshots,
      carryFeatureRows,
      rowsMissingAvailableAt,
      sourceLineageIncompleteRows,
      pitAuditedRows,
      pitPassingRows,
      pitFailingRows,
      prospectiveOpenEvents,
      prospectiveClosedEvents,
      prospectivePendingOpenEvents,
      prospectiveDueOpenEventsWithoutClose,
      prospectiveClosedOutcomes,
      prospectiveClosedDecisionWindows,
      prospectiveClosedOutcomeShortfall,
      prospectiveClosedWindowShortfall,
      captureFeatureRowsLoaded,
      captureObservationsBuilt,
      captureSkippedAlreadyDueObservations,
      collectorFetchedRows: effectiveCollector.fetchedRows,
      collectorAppendedRows: effectiveCollector.appendedRows,
      collectorWouldAppendRows: effectiveCollector.wouldAppendRows,
      collectorSkippedDuplicateRows: effectiveCollector.skippedDuplicateRows,
      collectorErrorCount: effectiveCollector.errorCount,
      externalCollectorErrorCount: collectorSnapshot.errorCount,
      okxCarrySnapshotRowsBuilt: okxCarrySnapshotStatus.rowsBuilt,
      okxCarrySnapshotRowsAppended: okxCarrySnapshotStatus.rowsAppended,
      okxCarrySnapshotDuplicateRows: okxCarrySnapshotStatus.duplicateRows,
      okxCarrySnapshotErrorCount: okxCarrySnapshotStatus.errorCount,
      okxCarrySnapshotCacheRows: okxCarrySnapshotStatus.cacheRows,
    },
    pitStatus: {
      featureStatus: readString(pitFeatureDataset?.status),
      auditStatus: readString(pitAudit?.status),
      fundingSymbols: readStringArray(featureCounts?.symbolsWithFunding),
      basisSymbols: readStringArray(featureCounts?.symbolsWithBasis),
    },
    prospectiveStatus: {
      status: readString(prospectiveEvidence?.status),
      latestOpenObservationId: readString(asRecord(prospectiveEvidence?.latestOpen)?.observationId),
      latestOpenDecisionTime: readString(asRecord(prospectiveEvidence?.latestOpen)?.decisionTime),
      latestOpenLabelDueTime: readString(asRecord(prospectiveEvidence?.latestOpen)?.labelDueTime),
    },
    captureStatus: {
      status: readString(capture?.status),
      dryRun: readBoolean(capture?.dryRun),
      blockers: captureBlockers,
    },
    collectorStatus: {
      exists: collectorSnapshot.exists,
      generatedAt: collectorSnapshot.generatedAt,
      ageMs: collectorSnapshot.ageMs,
      stale: collectorSnapshot.stale,
      dryRun: collectorSnapshot.dryRun,
      proxyConfigured: collectorSnapshot.proxyConfigured,
      proxySource: collectorSnapshot.proxySource,
      errorSummary: collectorSnapshot.errorSummary,
    },
    okxCarrySnapshotStatus,
    downloadMonitorStatus: {
      exists: input.downloadMonitorExists,
      generatedAt: readString(downloadMonitor?.generatedAt),
      status: readString(downloadMonitor?.status),
      blockers: downloadMonitorBlockers.slice(0, 12),
    },
    dataVisionCoreSmokeArchives: coreSmokeArchives,
    dataVisionArchives: fullCatalogArchives,
    dataVisionArchiveSummary: archiveSummary,
    catalogBlockers: fullCatalogArchiveBlockers,
    blockers,
    nextActions: buildNextActions({
      blockers,
      carryFeatureRows,
      prospectiveClosedOutcomes,
      prospectivePendingOpenEvents,
      collectorErrorCount: effectiveCollector.errorCount,
      externalCollectorErrorCount: collectorSnapshot.errorCount,
      okxCarrySnapshotHealthy,
      coreSmokeArchives,
      fullCatalogArchives,
      captureSkippedAlreadyDueObservations,
    }),
    safetyNotes: [
      'This artifact is research-only diagnostics and cannot authorize paper or live execution.',
      'Archive-derived rows still require explicit point-in-time availableAt/observedAt lineage before promotion use.',
      'Do not promote funding/carry until PIT, WFO, BY-FDR, route-cost, slippage, risk, prospective, and paper-execution gates all pass.',
    ],
    outputHash: null,
  }
}

function readCollectorSnapshot(exists: boolean, collector: UnknownRecord | null, asOfMs: number): {
  exists: boolean
  generatedAt: string | null
  ageMs: number | null
  stale: boolean
  dryRun: boolean | null
  proxyConfigured: boolean | null
  proxySource: string | null
  fetchedRows: number
  appendedRows: number
  wouldAppendRows: number
  skippedDuplicateRows: number
  errorCount: number
  errorSummary: Record<string, number>
} {
  const generatedAt = readString(collector?.generatedAt)
  const generatedAtMs = generatedAt ? Date.parse(generatedAt) : Number.NaN
  const ageMs = Number.isFinite(generatedAtMs) ? Math.max(0, asOfMs - generatedAtMs) : null
  const errorSummary = normalizeErrorSummary(collector?.errorSummary)
  const errorsLength = Array.isArray(collector?.errors) ? collector!.errors.length : 0
  const summaryErrors = Object.values(errorSummary).reduce((sum, value) => sum + value, 0)
  return {
    exists,
    generatedAt,
    ageMs,
    stale: exists && (ageMs == null || ageMs > COLLECTOR_STALE_AFTER_MS),
    dryRun: readBoolean(collector?.dryRun),
    proxyConfigured: readBoolean(collector?.proxyConfigured),
    proxySource: readString(collector?.proxySource),
    fetchedRows: readNumber(collector?.fetchedRows) ?? 0,
    appendedRows: readNumber(collector?.appendedRows) ?? 0,
    wouldAppendRows: readNumber(collector?.wouldAppendRows) ?? 0,
    skippedDuplicateRows: readNumber(collector?.skippedDuplicateRows) ?? 0,
    errorCount: Math.max(errorsLength, summaryErrors),
    errorSummary,
  }
}

function isExternalCollectorHealthy(
  status: ReturnType<typeof readCollectorSnapshot>,
  maxErrorCount: number,
): boolean {
  return Boolean(
    status.exists &&
    !status.stale &&
    status.dryRun !== true &&
    status.errorCount <= maxErrorCount &&
    (status.fetchedRows > 0 || status.appendedRows > 0 || status.skippedDuplicateRows > 0),
  )
}

function readOkxCarrySnapshotStatus(
  exists: boolean,
  report: UnknownRecord | null,
  cacheRows: UnknownRecord[],
  asOfMs: number,
): EthCarryDataGapStatusReport['okxCarrySnapshotStatus'] {
  const generatedAt = readString(report?.generatedAt)
  const generatedAtMs = generatedAt ? Date.parse(generatedAt) : Number.NaN
  const ageMs = Number.isFinite(generatedAtMs) ? Math.max(0, asOfMs - generatedAtMs) : null
  const counts = asRecord(report?.counts)
  const reportBlockers = readStringArray(report?.blockers)
  const errorsLength = Array.isArray(report?.errors) ? report!.errors.length : 0
  const reportRowsBuilt = readNumber(counts?.rowsBuilt) ?? 0
  const reportErrorCount = Math.max(readNumber(counts?.errors) ?? 0, errorsLength)
  const cache = buildRecentOkxCarrySnapshotCache(cacheRows, asOfMs, COLLECTOR_STALE_AFTER_MS)
  const reportComplete = exists &&
    ageMs != null &&
    ageMs <= COLLECTOR_STALE_AFTER_MS &&
    readBoolean(report?.dryRun) !== true &&
    readString(report?.status) === 'complete' &&
    reportRowsBuilt >= 2 &&
    reportErrorCount === 0 &&
    reportBlockers.length === 0
  const cacheFallbackUsed = !reportComplete && cache.complete
  return {
    exists: exists || cache.cacheRows > 0,
    generatedAt: cacheFallbackUsed ? cache.latestAvailableAt : generatedAt,
    ageMs: cacheFallbackUsed && cache.latestAvailableAtMs != null ? Math.max(0, asOfMs - cache.latestAvailableAtMs) : ageMs,
    stale: cacheFallbackUsed ? false : exists && (ageMs == null || ageMs > COLLECTOR_STALE_AFTER_MS),
    dryRun: readBoolean(report?.dryRun),
    status: cacheFallbackUsed ? 'complete' : readString(report?.status),
    rowsBuilt: cacheFallbackUsed ? 2 : reportRowsBuilt,
    rowsAppended: readNumber(counts?.rowsAppended) ?? 0,
    duplicateRows: readNumber(counts?.duplicateRows) ?? 0,
    errorCount: cacheFallbackUsed ? 0 : reportErrorCount,
    reportRowsBuilt,
    reportErrorCount,
    blockers: cacheFallbackUsed ? [] : reportBlockers,
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
  const latestBySymbol = new Map<string, { row: UnknownRecord; availableAtMs: number }>()
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
    if (!previous || availableAtMs > previous.availableAtMs) latestBySymbol.set(symbol, { row, availableAtMs })
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

function isOkxCarrySnapshotHealthy(
  status: EthCarryDataGapStatusReport['okxCarrySnapshotStatus'],
  maxErrorCount: number,
): boolean {
  return Boolean(
    status.exists &&
    !status.stale &&
    status.dryRun !== true &&
    status.status === 'complete' &&
    status.rowsBuilt >= 2 &&
    status.errorCount <= maxErrorCount &&
    status.blockers.length === 0,
  )
}

function buildOkxCarrySnapshotBlockers(
  status: EthCarryDataGapStatusReport['okxCarrySnapshotStatus'],
  maxErrorCount: number,
): string[] {
  return uniqueStrings([
    ...(status.exists ? [] : ['okx_carry_snapshot_collect_missing']),
    ...(status.stale ? ['okx_carry_snapshot_collect_stale'] : []),
    ...(status.dryRun === true ? ['okx_carry_snapshot_collect_last_run_dry_run'] : []),
    ...(status.status === 'complete' ? [] : [`okx_carry_snapshot_collect_not_complete:${status.status ?? 'missing'}`]),
    ...(status.rowsBuilt >= 2 ? [] : [`okx_carry_snapshot_rows_missing:${status.rowsBuilt}<2`]),
    ...(status.errorCount > maxErrorCount ? [`okx_carry_snapshot_errors:${status.errorCount}`] : []),
    ...status.blockers.map(blocker => `okx_carry_snapshot:${blocker}`),
  ])
}

function inspectDataVisionArchive(warehouseRoot: string, spec: DataVisionArchiveSpec): EthCarryDataVisionArchiveStatus {
  const path = resolve(warehouseRoot, spec.directory)
  const exists = existsSync(path)
  const zipFiles = countFilesWithSuffix(path, '.zip')
  const partFiles = countFilesWithSuffix(path, '.part')
  const summaryPath = join(path, 'summary.fast-binance-download.json')
  const manifestPath = join(path, 'manifest.fast-binance-download.jsonl')
  const summary = readJsonSync(summaryPath)
  const summaryCoverage = readString(asRecord(summary)?.coverage)
  const summaryComplete = summaryCoverage == null ? null : summaryCoverage === 'complete'
  const summaryPresent = existsSync(summaryPath)
  const manifestPresent = existsSync(manifestPath)
  const status: ArchiveStatus = !exists || zipFiles === 0
    ? 'missing'
    : partFiles > 0
      ? 'in_progress'
      : summaryComplete === true && manifestPresent
        ? 'complete'
        : 'partial'
  const blockerPrefix = archiveBlockerPrefix(spec.scope)
  const blockers = uniqueStrings([
    ...(!exists || zipFiles === 0 ? [`${blockerPrefix}_missing:${spec.datasetId}`] : []),
    ...(partFiles > 0 ? [`${blockerPrefix}_part_files:${spec.datasetId}:${partFiles}`] : []),
    ...(zipFiles > 0 && !summaryPresent ? [`${blockerPrefix}_summary_missing:${spec.datasetId}`] : []),
    ...(zipFiles > 0 && !manifestPresent ? [`${blockerPrefix}_manifest_missing:${spec.datasetId}`] : []),
    ...(zipFiles > 0 && summaryComplete !== true
      ? [`${blockerPrefix}_not_complete:${spec.datasetId}:coverage=${summaryCoverage ?? 'missing'}`]
      : []),
  ])
  return {
    datasetId: spec.datasetId,
    scope: spec.scope,
    path,
    exists,
    zipFiles,
    partFiles,
    dataFiles: zipFiles,
    summaryPresent,
    manifestPresent,
    summaryCoverage,
    summaryComplete,
    status,
    blockers,
  }
}

function archiveBlockerPrefix(scope: ArchiveScope): string {
  return scope === 'core_smoke' ? 'data_vision_core_archive' : 'data_vision_full_catalog_archive'
}

function buildNextActions(input: {
  blockers: string[]
  carryFeatureRows: number
  prospectiveClosedOutcomes: number
  prospectivePendingOpenEvents: number
  collectorErrorCount: number
  externalCollectorErrorCount: number
  okxCarrySnapshotHealthy: boolean
  coreSmokeArchives: EthCarryDataVisionArchiveStatus[]
  fullCatalogArchives: EthCarryDataVisionArchiveStatus[]
  captureSkippedAlreadyDueObservations: number
}): string[] {
  const coreSmokeBlocked = input.coreSmokeArchives.some(archive => archive.status !== 'complete')
  const fullCatalogBlocked = input.fullCatalogArchives.some(archive => archive.status !== 'complete')
  return uniqueStrings([
    ...(coreSmokeBlocked
      ? ['Download or rebuild BTC/ETH fundingRate plus 1h mark/index/premium Data Vision core smoke archives before rebuilding carry PIT research features.']
      : ['Core BTC/ETH Data Vision derivative archives are present for research feature reconstruction; archive presence is still not promotion-grade lineage by itself.']),
    ...(fullCatalogBlocked
      ? ['Keep full all-USDT derivatives catalog backfill separate from ETH/BTC core research readiness and run it only when bandwidth permits.']
      : ['Full all-USDT derivatives catalog archives are complete; continue treating them as research inputs until PIT lineage is independently promotion-grade.']),
    ...(input.collectorErrorCount > 0 || input.blockers.some(blocker => blocker.startsWith('external_derivatives_collect'))
      ? ['Fix external derivatives collector network/proxy errors before treating funding/carry refresh as healthy.']
      : []),
    ...(input.okxCarrySnapshotHealthy && input.externalCollectorErrorCount > 0
      ? ['OKX live carry snapshot is healthy for fresh ETH/BTC prospective capture; keep Binance external collector TLS repair as a separate catalog-hardening task.']
      : []),
    ...(input.carryFeatureRows < DEFAULT_MIN_CARRY_FEATURE_ROWS
      ? ['Rebuild ETH carry PIT features from explicit availableAt funding and basis rows until sample size is sufficient.']
      : []),
    ...(input.prospectiveClosedOutcomes < DEFAULT_MIN_PROSPECTIVE_CLOSED_OUTCOMES
      ? ['Keep prospective capture scheduled only for future decision rows; do not backfill already-due rows as prospective evidence.']
      : []),
    ...(input.captureSkippedAlreadyDueObservations > 0 && input.prospectivePendingOpenEvents === 0
      ? ['Generate fresh future PIT rows before capture; current rows are already label-due and correctly refused as prospective opens.']
      : []),
    ...(input.prospectivePendingOpenEvents > 0
      ? ['Wait for pending ETH carry prospective observations to reach labelDueTime, then settle; do not count pending rows as closed evidence.']
      : []),
    'Do not promote or enable paper/live until PIT/WFO/FDR/route-cost/slippage/risk/prospective/paper gates all pass.',
  ])
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null
  }
}

function readJsonSync(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
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

function countFilesWithSuffix(root: string, suffix: string): number {
  if (!existsSync(root)) return 0
  let count = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) stack.push(child)
      else if (entry.isFile() && entry.name.endsWith(suffix)) count += 1
    }
  }
  return count
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg?.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    index += 1
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

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`)
  return parsed
}

function parseNullableTimestamp(value: string | undefined): number | null {
  if (value == null || value === 'null' || value === 'none') return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid timestamp: ${value}`)
  return parsed
}

function normalizeErrorSummary(value: unknown): Record<string, number> {
  const record = asRecord(value)
  if (!record) return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(record)) {
    const parsed = readNumber(raw)
    if (parsed != null && parsed > 0) out[key] = parsed
  }
  return out
}

function formatErrorSummaryBlocker(summary: Record<string, number>): string {
  const entries = Object.entries(summary).sort(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0) return 'unknown'
  return entries.map(([key, value]) => `${key}:${value}`).join(',')
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

function renderConsoleSummary(report: EthCarryDataGapStatusReport): string {
  return [
    `eth carry data gap: status=${report.status}`,
    `features=${report.counts.carryFeatureRows}/${report.thresholds.minCarryFeatureRows} prospective=${report.counts.prospectiveClosedOutcomes}/${report.thresholds.minProspectiveClosedOutcomes}`,
    `collectorErrors=${report.counts.collectorErrorCount} coreArchivesComplete=${report.dataVisionArchiveSummary.coreSmokeArchivesComplete}/${report.dataVisionArchiveSummary.coreSmokeArchives} fullCatalogComplete=${report.dataVisionArchiveSummary.fullCatalogArchivesComplete}/${report.dataVisionArchiveSummary.fullCatalogArchives}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 10).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_eth_carry_data_gap_status failed:', error)
    process.exitCode = 1
  })
}
