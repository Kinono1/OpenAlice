import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type PlanStatus =
  | 'blocked_no_data_gap'
  | 'ready_core_smoke_backfill'
  | 'waiting_active_downloads'
  | 'full_archives_complete'
type ArchiveStatus = 'complete' | 'partial' | 'missing' | 'in_progress'

interface CliArgs {
  dataGapPath: string
  downloadMonitorPath: string
  dataCatalogPath: string
  warehouseRoot: string
  outputPath: string | null
  startMonth: string
  endMonth: string
  symbols: string[]
  quote: string
  timeframe: string
  listConcurrency: number
  concurrency: number
  retryConcurrency: number
  maxRetries: number
  retryMaxRetries: number
  connectTimeoutSec: number
  listMaxTimeSec: number
  downloadMaxTimeSec: number
  retryRounds: number
  proxy: string
  networkInterface: string
  discovery: string
  json: boolean
}

interface DatasetSpec {
  datasetId: string
  dataType: 'fundingRate' | 'markPriceKlines' | 'indexPriceKlines' | 'premiumIndexKlines'
  timeframe: string | null
  fullDirectory: string
  coreDirectory: string
}

interface ArchiveSnapshot {
  path: string
  exists: boolean
  zipFiles: number
  partFiles: number
  summaryPresent: boolean
  manifestPresent: boolean
  summaryCoverage: string | null
  summaryComplete: boolean | null
  status: ArchiveStatus
}

export interface EthCarryBackfillPlanEntry {
  datasetId: string
  dataType: string
  timeframe: string | null
  symbols: string[]
  priority: 'P0'
  fullArchive: ArchiveSnapshot
  coreArchive: ArchiveSnapshot
  activeProcessPids: number[]
  activeProcessCommands: string[]
  recommendedPhase: 'skip_complete' | 'core_smoke_backfill' | 'wait_active_download' | 'full_catalog_backfill'
  coreSmokeCommand: string[]
  fullCatalogCommand: string[]
  copyPasteCoreSmokeCommand: string
  copyPasteFullCatalogCommand: string
  blockers: string[]
  notes: string[]
}

export interface EthCarryDerivativesBackfillPlanReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  startsDownload: false
  status: PlanStatus
  sourceArtifacts: {
    dataGapPath: string
    downloadMonitorPath: string
    dataCatalogPath: string
    warehouseRoot: string
  }
  parameters: {
    market: 'um'
    quote: string
    symbols: string[]
    startMonth: string
    endMonth: string
    timeframe: string
    proxy: string
    networkInterface: string
    discovery: string
    symbolSourceDir: string
  }
  counts: {
    datasets: number
    fullArchivesComplete: number
    fullArchivesMissingOrPartial: number
    coreArchivesComplete: number
    coreArchivesMissingOrPartial: number
    activeConflicts: number
    commandsPlanned: number
  }
  dataGapSummary: {
    status: string | null
    carryFeatureRows: number | null
    minCarryFeatureRows: number | null
    prospectiveClosedOutcomes: number | null
    minProspectiveClosedOutcomes: number | null
    collectorErrorCount: number | null
    dataVisionArchivesComplete: number | null
    dataVisionArchives: number | null
    dataVisionCoreSmokeArchivesComplete: number | null
    dataVisionCoreSmokeArchives: number | null
    dataVisionFullCatalogArchivesComplete: number | null
    dataVisionFullCatalogArchives: number | null
  }
  networkWarnings: string[]
  entries: EthCarryBackfillPlanEntry[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  outputHash: string | null
}

const DEFAULT_DATA_GAP_PATH = 'data/research/eth_carry_data_gap_status.latest.json'
const DEFAULT_DOWNLOAD_MONITOR_PATH = 'data/runtime/openalice_download_monitor.latest.json'
const DEFAULT_DATA_CATALOG_PATH = 'data/runtime/openalice_data_catalog.latest.json'
const DEFAULT_WAREHOUSE_ROOT = 'data'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_derivatives_backfill_plan.latest.json'

const DATASET_SPECS: DatasetSpec[] = [
  {
    datasetId: 'binance-public:um:fundingRate:usdt',
    dataType: 'fundingRate',
    timeframe: null,
    fullDirectory: 'market/binance-public/um-all-usdt-fundingRate',
    coreDirectory: 'market/binance-public/eth-carry-core-fundingRate',
  },
  {
    datasetId: 'binance-public:um:markPriceKlines:1h:usdt',
    dataType: 'markPriceKlines',
    timeframe: '1h',
    fullDirectory: 'market/binance-public/um-all-usdt-markPriceKlines-1h',
    coreDirectory: 'market/binance-public/eth-carry-core-markPriceKlines-1h',
  },
  {
    datasetId: 'binance-public:um:indexPriceKlines:1h:usdt',
    dataType: 'indexPriceKlines',
    timeframe: '1h',
    fullDirectory: 'market/binance-public/um-all-usdt-indexPriceKlines-1h',
    coreDirectory: 'market/binance-public/eth-carry-core-indexPriceKlines-1h',
  },
  {
    datasetId: 'binance-public:um:premiumIndexKlines:1h:usdt',
    dataType: 'premiumIndexKlines',
    timeframe: '1h',
    fullDirectory: 'market/binance-public/um-all-usdt-premiumIndexKlines-1h',
    coreDirectory: 'market/binance-public/eth-carry-core-premiumIndexKlines-1h',
  },
]

async function main(): Promise<void> {
  const args = parseEthCarryDerivativesBackfillPlanArgs(process.argv.slice(2))
  const report = await runEthCarryDerivativesBackfillPlan(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseEthCarryDerivativesBackfillPlanArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    dataGapPath: raw.get('dataGapPath') ?? raw.get('dataGap') ?? DEFAULT_DATA_GAP_PATH,
    downloadMonitorPath: raw.get('downloadMonitorPath') ?? raw.get('downloadMonitor') ?? DEFAULT_DOWNLOAD_MONITOR_PATH,
    dataCatalogPath: raw.get('dataCatalogPath') ?? raw.get('dataCatalog') ?? DEFAULT_DATA_CATALOG_PATH,
    warehouseRoot: resolve(raw.get('warehouseRoot') ?? raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT ?? DEFAULT_WAREHOUSE_ROOT),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    startMonth: normalizeMonth(raw.get('startMonth') ?? '2019-09', 'startMonth'),
    endMonth: normalizeMonth(raw.get('endMonth') ?? nowMonthUtc(), 'endMonth'),
    symbols: parseSymbolList(raw.get('symbols') ?? 'BTCUSDT,ETHUSDT'),
    quote: (raw.get('quote') ?? 'USDT').toUpperCase(),
    timeframe: raw.get('timeframe') ?? '1h',
    listConcurrency: parsePositiveInteger(raw.get('listConcurrency'), 8, 'listConcurrency'),
    concurrency: parsePositiveInteger(raw.get('concurrency'), 4, 'concurrency'),
    retryConcurrency: parsePositiveInteger(raw.get('retryConcurrency'), 4, 'retryConcurrency'),
    maxRetries: parsePositiveInteger(raw.get('maxRetries'), 3, 'maxRetries'),
    retryMaxRetries: parsePositiveInteger(raw.get('retryMaxRetries'), 3, 'retryMaxRetries'),
    connectTimeoutSec: parsePositiveInteger(raw.get('connectTimeoutSec'), 10, 'connectTimeoutSec'),
    listMaxTimeSec: parsePositiveInteger(raw.get('listMaxTimeSec'), 30, 'listMaxTimeSec'),
    downloadMaxTimeSec: parsePositiveInteger(raw.get('downloadMaxTimeSec'), 300, 'downloadMaxTimeSec'),
    retryRounds: parsePositiveInteger(raw.get('retryRounds'), 1, 'retryRounds'),
    proxy: normalizeProxy(raw.get('proxy') ?? 'none'),
    networkInterface: normalizeInterface(raw.get('interface') ?? raw.get('networkInterface') ?? process.env.BINANCE_BACKFILL_INTERFACE ?? 'en0'),
    discovery: raw.get('discovery') ?? process.env.BINANCE_BACKFILL_DISCOVERY ?? 'probe',
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryDerivativesBackfillPlan(
  args: CliArgs,
): Promise<EthCarryDerivativesBackfillPlanReport> {
  const startedAt = new Date()
  const dataGapPath = resolve(args.dataGapPath)
  const downloadMonitorPath = resolve(args.downloadMonitorPath)
  const dataCatalogPath = resolve(args.dataCatalogPath)
  const warehouseRoot = resolve(args.warehouseRoot)
  const report = buildEthCarryDerivativesBackfillPlanReport({
    generatedAt: new Date().toISOString(),
    dataGapPath,
    downloadMonitorPath,
    dataCatalogPath,
    warehouseRoot,
    dataGapExists: existsSync(dataGapPath),
    dataGap: await readJsonIfExists(dataGapPath),
    downloadMonitor: await readJsonIfExists(downloadMonitorPath),
    dataCatalog: await readJsonIfExists(dataCatalogPath),
    args,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    const payloadWithoutHash = `${JSON.stringify({ ...report, outputHash: null }, null, 2)}\n`
    const outputHash = sha256Hex(payloadWithoutHash)
    const finalPayload = `${JSON.stringify({ ...report, outputHash }, null, 2)}\n`
    await writeFile(outputPath, finalPayload, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_derivatives_backfill_plan',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked_no_data_gap' ? 'fail' : 'warn',
      recordsIn: report.counts.datasets,
      recordsOut: report.counts.commandsPlanned,
      errorClass: report.blockers[0] ?? null,
      artifactHash: sha256Hex(finalPayload),
    })
    return { ...report, outputHash }
  }

  return report
}

export function buildEthCarryDerivativesBackfillPlanReport(input: {
  generatedAt?: string
  dataGapPath: string
  downloadMonitorPath: string
  dataCatalogPath: string
  warehouseRoot: string
  dataGapExists: boolean
  dataGap: unknown
  downloadMonitor: unknown
  dataCatalog: unknown
  args: Pick<CliArgs,
    | 'quote'
    | 'symbols'
    | 'startMonth'
    | 'endMonth'
    | 'timeframe'
    | 'listConcurrency'
    | 'concurrency'
    | 'retryConcurrency'
    | 'maxRetries'
    | 'retryMaxRetries'
    | 'connectTimeoutSec'
    | 'listMaxTimeSec'
    | 'downloadMaxTimeSec'
    | 'retryRounds'
    | 'proxy'
    | 'networkInterface'
    | 'discovery'
  >
}): EthCarryDerivativesBackfillPlanReport {
  const dataGap = asRecord(input.dataGap)
  const downloadMonitor = asRecord(input.downloadMonitor)
  const dataCatalog = asRecord(input.dataCatalog)
  const activeProcesses = readActiveProcesses(downloadMonitor)
  const symbolSourceDir = resolve(input.warehouseRoot, 'market/binance-public/um-all-usdt-klines-1d')
  const entries = DATASET_SPECS.map(spec => buildEntry({
    spec,
    warehouseRoot: input.warehouseRoot,
    symbolSourceDir,
    activeProcesses,
    args: input.args,
  }))
  const activeConflicts = entries.filter(entry => entry.activeProcessPids.length > 0).length
  const fullArchivesComplete = entries.filter(entry => entry.fullArchive.status === 'complete').length
  const coreArchivesComplete = entries.filter(entry => entry.coreArchive.status === 'complete').length
  const commandsPlanned = entries.filter(entry => entry.recommendedPhase !== 'skip_complete' && entry.recommendedPhase !== 'wait_active_download').length
  const dataGapCounts = asRecord(dataGap?.counts)
  const dataGapThresholds = asRecord(dataGap?.thresholds)
  const dataGapArchiveSummary = asRecord(dataGap?.dataVisionArchiveSummary)
  const dataGapArchives = Array.isArray(dataGap?.dataVisionArchives) ? dataGap.dataVisionArchives : []
  const dataGapCoreArchives = Array.isArray(dataGap?.dataVisionCoreSmokeArchives)
    ? dataGap.dataVisionCoreSmokeArchives
    : []
  const networkWarnings = uniqueStrings([
    ...readStringArray(downloadMonitor?.blockers)
      .filter(blocker =>
        blocker.startsWith('external_derivatives_collect') ||
        blocker.startsWith('download_direct_routing') ||
        blocker.startsWith('macos_system_proxy') ||
        blocker.startsWith('proxy_environment'),
      ),
    ...readStringArray(dataCatalog?.blockers)
      .filter(blocker =>
        blocker.includes('um-all-usdt-fundingRate') ||
        blocker.includes('markPriceKlines') ||
        blocker.includes('indexPriceKlines') ||
        blocker.includes('premiumIndexKlines'),
      )
      .slice(0, 12),
  ])
  const blockers = uniqueStrings([
    ...(input.dataGapExists || dataGap ? [] : ['eth_carry_data_gap_status_missing']),
    ...(activeConflicts > 0 ? [`active_download_conflicts:${activeConflicts}`] : []),
    ...entries.flatMap(entry => entry.blockers),
  ])
  const status: PlanStatus = !input.dataGapExists && !dataGap
    ? 'blocked_no_data_gap'
    : activeConflicts > 0
      ? 'waiting_active_downloads'
      : fullArchivesComplete === entries.length
        ? 'full_archives_complete'
        : 'ready_core_smoke_backfill'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    startsDownload: false,
    status,
    sourceArtifacts: {
      dataGapPath: resolve(input.dataGapPath),
      downloadMonitorPath: resolve(input.downloadMonitorPath),
      dataCatalogPath: resolve(input.dataCatalogPath),
      warehouseRoot: resolve(input.warehouseRoot),
    },
    parameters: {
      market: 'um',
      quote: input.args.quote,
      symbols: input.args.symbols,
      startMonth: input.args.startMonth,
      endMonth: input.args.endMonth,
      timeframe: input.args.timeframe,
      proxy: input.args.proxy,
      networkInterface: input.args.networkInterface,
      discovery: input.args.discovery,
      symbolSourceDir,
    },
    counts: {
      datasets: entries.length,
      fullArchivesComplete,
      fullArchivesMissingOrPartial: entries.length - fullArchivesComplete,
      coreArchivesComplete,
      coreArchivesMissingOrPartial: entries.length - coreArchivesComplete,
      activeConflicts,
      commandsPlanned,
    },
    dataGapSummary: {
      status: readString(dataGap?.status),
      carryFeatureRows: readNumber(dataGapCounts?.carryFeatureRows),
      minCarryFeatureRows: readNumber(dataGapThresholds?.minCarryFeatureRows),
      prospectiveClosedOutcomes: readNumber(dataGapCounts?.prospectiveClosedOutcomes),
      minProspectiveClosedOutcomes: readNumber(dataGapThresholds?.minProspectiveClosedOutcomes),
      collectorErrorCount: readNumber(dataGapCounts?.collectorErrorCount),
      dataVisionArchivesComplete: dataGapArchives
        .map(asRecord)
        .filter((archive): archive is UnknownRecord => archive != null)
        .filter(archive => readString(archive.status) === 'complete').length,
      dataVisionArchives: dataGapArchives.length,
      dataVisionCoreSmokeArchivesComplete: readNumber(dataGapArchiveSummary?.coreSmokeArchivesComplete) ??
        dataGapCoreArchives
          .map(asRecord)
          .filter((archive): archive is UnknownRecord => archive != null)
          .filter(archive => readString(archive.status) === 'complete').length,
      dataVisionCoreSmokeArchives: readNumber(dataGapArchiveSummary?.coreSmokeArchives) ?? dataGapCoreArchives.length,
      dataVisionFullCatalogArchivesComplete: readNumber(dataGapArchiveSummary?.fullCatalogArchivesComplete) ??
        dataGapArchives
          .map(asRecord)
          .filter((archive): archive is UnknownRecord => archive != null)
          .filter(archive => readString(archive.status) === 'complete').length,
      dataVisionFullCatalogArchives: readNumber(dataGapArchiveSummary?.fullCatalogArchives) ?? dataGapArchives.length,
    },
    networkWarnings,
    entries,
    blockers,
    nextActions: buildNextActions(status, entries, networkWarnings),
    safetyNotes: [
      'This artifact only plans research data downloads; it does not start a downloader.',
      'Core smoke backfill uses BTCUSDT and ETHUSDT into eth-carry-core directories so it cannot masquerade as all-USDT catalog completion.',
      'Full catalog backfill commands remain separate and should be run only when bandwidth and active downloader state are acceptable.',
      'No paper/live/promotion permission can be inferred from this plan.',
    ],
    outputHash: null,
  }
}

function buildEntry(input: {
  spec: DatasetSpec
  warehouseRoot: string
  symbolSourceDir: string
  activeProcesses: ActiveProcessSnapshot[]
  args: Pick<CliArgs,
    | 'quote'
    | 'symbols'
    | 'startMonth'
    | 'endMonth'
    | 'listConcurrency'
    | 'concurrency'
    | 'retryConcurrency'
    | 'maxRetries'
    | 'retryMaxRetries'
    | 'connectTimeoutSec'
    | 'listMaxTimeSec'
    | 'downloadMaxTimeSec'
    | 'retryRounds'
    | 'proxy'
    | 'networkInterface'
    | 'discovery'
  >
}): EthCarryBackfillPlanEntry {
  const fullPath = resolve(input.warehouseRoot, input.spec.fullDirectory)
  const corePath = resolve(input.warehouseRoot, input.spec.coreDirectory)
  const fullArchive = inspectArchive(fullPath)
  const coreArchive = inspectArchive(corePath)
  const active = input.activeProcesses.filter(process =>
    process.path === fullPath ||
    process.path === corePath ||
    process.datasetId === directoryDatasetId(input.spec.fullDirectory) ||
    process.datasetId === directoryDatasetId(input.spec.coreDirectory),
  )
  const coreSmokeCommand = buildCommand(input.spec, corePath, input.symbolSourceDir, input.args, true)
  const fullCatalogCommand = buildCommand(input.spec, fullPath, input.symbolSourceDir, input.args, false)
  const recommendedPhase: EthCarryBackfillPlanEntry['recommendedPhase'] = active.length > 0
    ? 'wait_active_download'
    : fullArchive.status === 'complete'
      ? 'skip_complete'
      : coreArchive.status === 'complete'
        ? 'full_catalog_backfill'
        : 'core_smoke_backfill'
  const blockers = uniqueStrings([
    ...(active.length > 0 ? [`active_download_conflict:${input.spec.datasetId}`] : []),
    ...(fullArchive.status === 'complete' ? [] : [`full_archive_not_complete:${input.spec.datasetId}:${fullArchive.status}`]),
    ...(coreArchive.status === 'complete' || recommendedPhase === 'skip_complete' ? [] : [`core_archive_not_complete:${input.spec.datasetId}:${coreArchive.status}`]),
  ])
  return {
    datasetId: input.spec.datasetId,
    dataType: input.spec.dataType,
    timeframe: input.spec.timeframe,
    symbols: input.args.symbols,
    priority: 'P0',
    fullArchive,
    coreArchive,
    activeProcessPids: active.map(process => process.pid),
    activeProcessCommands: active.map(process => process.command),
    recommendedPhase,
    coreSmokeCommand,
    fullCatalogCommand,
    copyPasteCoreSmokeCommand: shellQuoteCommand(coreSmokeCommand),
    copyPasteFullCatalogCommand: shellQuoteCommand(fullCatalogCommand),
    blockers,
    notes: [
      recommendedPhase === 'core_smoke_backfill'
        ? 'Run the core smoke command first to create BTC/ETH-only research archives without claiming all-USDT coverage.'
        : recommendedPhase === 'full_catalog_backfill'
          ? 'Core BTC/ETH archive exists; run full catalog command only when ready to complete the all-USDT data catalog.'
          : recommendedPhase === 'wait_active_download'
            ? 'A downloader already targets this dataset path; wait and refresh monitor before starting another process.'
            : 'Full archive is complete; no backfill command is needed for this dataset.',
    ],
  }
}

interface ActiveProcessSnapshot {
  datasetId: string | null
  path: string | null
  pid: number
  command: string
}

function readActiveProcesses(downloadMonitor: UnknownRecord | null): ActiveProcessSnapshot[] {
  const rows = Array.isArray(downloadMonitor?.activeProcesses)
    ? downloadMonitor.activeProcesses.map(asRecord).filter((row): row is UnknownRecord => row != null)
    : []
  return rows.map(row => ({
    datasetId: readString(row.id) ?? readString(row.datasetId),
    path: readString(row.path),
    pid: readNumber(row.pid) ?? 0,
    command: readString(row.command) ?? '',
  }))
}

function inspectArchive(path: string): ArchiveSnapshot {
  const exists = existsSync(path)
  const zipFiles = countFilesWithSuffix(path, '.zip')
  const partFiles = countFilesWithSuffix(path, '.part')
  const summaryPath = join(path, 'summary.fast-binance-download.json')
  const manifestPath = join(path, 'manifest.fast-binance-download.jsonl')
  const summary = asRecord(readJsonSync(summaryPath))
  const summaryCoverage = readString(summary?.coverage)
  const summaryComplete = summaryCoverage == null ? null : summaryCoverage === 'complete'
  const summaryPresent = existsSync(summaryPath)
  const manifestPresent = existsSync(manifestPath)
  return {
    path,
    exists,
    zipFiles,
    partFiles,
    summaryPresent,
    manifestPresent,
    summaryCoverage,
    summaryComplete,
    status: !exists || zipFiles === 0
      ? 'missing'
      : partFiles > 0
        ? 'in_progress'
        : summaryComplete === true && manifestPresent
          ? 'complete'
          : 'partial',
  }
}

function buildCommand(
  spec: DatasetSpec,
  outDir: string,
  symbolSourceDir: string,
  args: Pick<CliArgs,
    | 'quote'
    | 'symbols'
    | 'startMonth'
    | 'endMonth'
    | 'listConcurrency'
    | 'concurrency'
    | 'retryConcurrency'
    | 'maxRetries'
    | 'retryMaxRetries'
    | 'connectTimeoutSec'
    | 'listMaxTimeSec'
    | 'downloadMaxTimeSec'
    | 'retryRounds'
    | 'proxy'
    | 'networkInterface'
    | 'discovery'
  >,
  coreOnly: boolean,
): string[] {
  const command = [
    './node_modules/.bin/tsx',
    'scripts/run_fast_binance_data_vision_dataset.ts',
    '--market',
    'um',
    '--dataType',
    spec.dataType,
    '--quote',
    args.quote,
    '--startMonth',
    args.startMonth,
    '--endMonth',
    args.endMonth,
    '--outDir',
    outDir,
    '--symbolSourceDir',
    symbolSourceDir,
    '--listConcurrency',
    String(args.listConcurrency),
    '--concurrency',
    String(args.concurrency),
    '--retryConcurrency',
    String(args.retryConcurrency),
    '--maxRetries',
    String(args.maxRetries),
    '--retryMaxRetries',
    String(args.retryMaxRetries),
    '--connectTimeoutSec',
    String(args.connectTimeoutSec),
    '--listMaxTimeSec',
    String(args.listMaxTimeSec),
    '--downloadMaxTimeSec',
    String(args.downloadMaxTimeSec),
    '--retryRounds',
    String(args.retryRounds),
    '--proxy',
    args.proxy,
    '--interface',
    args.networkInterface,
    '--discovery',
    args.discovery,
  ]
  if (spec.timeframe) command.push('--timeframe', spec.timeframe)
  if (coreOnly) command.push('--symbols', args.symbols.join(','))
  return command
}

function buildNextActions(
  status: PlanStatus,
  entries: EthCarryBackfillPlanEntry[],
  networkWarnings: string[],
): string[] {
  if (status === 'blocked_no_data_gap') {
    return ['Run research:eth-carry:data-gap-status first so backfill planning is tied to current data gaps.']
  }
  if (status === 'waiting_active_downloads') {
    return ['Wait for active downloader conflicts to clear, rerun data:monitor, then regenerate this plan before launching a new process.']
  }
  if (status === 'full_archives_complete') {
    return ['Rebuild normalized derivatives events and ETH carry PIT features from the completed archives; keep promotion blocked until PIT/WFO/FDR/prospective/paper gates pass.']
  }
  return uniqueStrings([
    ...(networkWarnings.length > 0
      ? ['Review network/proxy warnings before running download commands; prefer DIRECT/proxy none for Binance Data Vision if monitor says routing is clean.']
      : []),
    ...entries
      .filter(entry => entry.recommendedPhase === 'core_smoke_backfill')
      .map(entry => `Run core smoke backfill for ${entry.datasetId} into ${entry.coreArchive.path}.`),
    'After core smoke archives exist, normalize them into PIT-safe derivatives rows before using them for carry features.',
    'Run full catalog backfill separately only when bandwidth is acceptable and no matching downloader is active.',
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

function directoryDatasetId(directory: string): string {
  return directory.split('/').filter(Boolean).at(-1) ?? directory
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

function parseSymbolList(value: string): string[] {
  const symbols = value.split(',').map(symbol => symbol.trim().toUpperCase()).filter(Boolean)
  if (symbols.length === 0) throw new Error('symbols must not be empty')
  return [...new Set(symbols)]
}

function normalizeProxy(value: string): string {
  const normalized = value.trim()
  if (!normalized) return 'none'
  if (['0', 'false', 'no', 'off', 'direct'].includes(normalized.toLowerCase())) return 'none'
  return normalized
}

function normalizeInterface(value: string): string {
  const normalized = value.trim()
  if (!normalized || ['0', 'false', 'no', 'off', 'none'].includes(normalized.toLowerCase())) return 'none'
  return normalized
}

function normalizeMonth(value: string, label: string): string {
  const match = value.match(/^(\d{4})-(\d{1,2})$/)
  if (!match) throw new Error(`${label} must be YYYY-MM`)
  const year = Number(match[1])
  const month = Number(match[2])
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`${label} must be YYYY-MM`)
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
}

function nowMonthUtc(): string {
  const now = new Date()
  return `${String(now.getUTCFullYear()).padStart(4, '0')}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim() !== ''))]
}

function shellQuoteCommand(command: string[]): string {
  return command.map(part => /^[A-Za-z0-9_./:=,@+-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`).join(' ')
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: EthCarryDerivativesBackfillPlanReport): string {
  return [
    `eth carry derivatives backfill plan: status=${report.status}`,
    `full=${report.counts.fullArchivesComplete}/${report.counts.datasets} core=${report.counts.coreArchivesComplete}/${report.counts.datasets} planned=${report.counts.commandsPlanned}`,
    `startsDownload=${report.startsDownload} paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 10).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_eth_carry_derivatives_backfill_plan failed:', error)
    process.exitCode = 1
  })
}
