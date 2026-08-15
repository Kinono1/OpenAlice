import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type MonitorStatus = 'complete' | 'watching' | 'blocked'

interface CliArgs {
  warehouseRoot: string
  repoDataRoot: string
  runtimeDir: string
  dataCatalogPath?: string
  outputPath: string | null
  json: boolean
  checkMacosSystemProxy: boolean
  macosSystemProxyOutput?: string
  proxyEnv?: NodeJS.ProcessEnv
  checkDownloadDirectRouting?: boolean
  monitorOfflineBackfills?: boolean
  downloadDirectRoutingConfigPaths?: string[]
  processListOutput?: string
}

interface DatasetSnapshot {
  datasetId: string
  path: string
  family: 'binance' | 'coinmetrics'
  zipFiles: number
  partFiles: number
  dataFiles: number
  summaryPresent: boolean
  summaryCoverage: string | null
  summaryComplete: boolean | null
  auditPresent: boolean
  manifestPresent: boolean
  reportPath: string | null
  reportStatus: string | null
  reportBlockers: string[]
  activeProcessPids: number[]
  complete: boolean
}

interface BinanceAuditDataset {
  id: string
  path: string
  zipFiles: number
  partFiles: number
  complete: boolean
  status: string
  reason: string
}

interface ActiveProcessDataset {
  id: string
  path: string
  pid: number
  command: string
}

interface DuplicateActiveDownloaderGroup {
  datasetId: string
  path: string
  activeProcessCount: number
  keepPid: number
  suggestedStopPids: number[]
  manualStopCommand: string | null
  manualOnly: true
  processes: ActiveProcessDataset[]
}

type BinanceRuntimeState = 'complete' | 'active' | 'paused_part_files' | 'incomplete'

interface RuntimeStatusSnapshot {
  exists: boolean
  path: string
  status: string | null
  blockers: string[]
}

interface OkxPublicConnectivitySnapshot {
  exists: boolean
  path: string
  status: string | null
  publicDataFetchable: boolean | null
  failedHosts: string[]
  failedErrorClasses: string[]
}

interface ExternalDerivativesCollectSnapshot {
  exists: boolean
  path: string
  generatedAt: string | null
  ageMs: number | null
  stale: boolean
  staleAfterMs: number
  dryRun: boolean | null
  proxyConfigured: boolean | null
  proxySource: string | null
  fetchedRows: number | null
  appendedRows: number | null
  wouldAppendRows: number | null
  skippedDuplicateRows: number | null
  errorCount: number
  errorSummary: Record<string, number>
  latestErrors: Array<{
    symbol: string | null
    endpoint: string | null
    errorClass: string | null
    error: string | null
  }>
}

interface DataCatalogSnapshot {
  exists: boolean
  path: string
  status: string | null
  datasets: number | null
  complete: number | null
  partial: number | null
  missing: number | null
  inProgress: number | null
  completePct: number | null
  totalBlockers: number | null
  primaryBlockerCategory: string | null
  categories: Array<{
    category: string
    count: number
  }>
  downloadGapBlockers: number | null
  pitOrNormalizedGapBlockers: number | null
  aiScientistValidationGateBlockers: number | null
  sampleDownloadGapBlockers: string[]
  nextDownloadGapAction: string | null
}

export interface MacosSystemProxySnapshot {
  checked: boolean
  enabled: boolean | null
  httpProxy: string | null
  httpPort: number | null
  httpsProxy: string | null
  httpsPort: number | null
  socksProxy: string | null
  socksPort: number | null
  error: string | null
}

export interface ProxyEnvironmentSnapshot {
  checked: boolean
  enabled: boolean
  variables: Record<string, string>
}

interface DownloadDirectRoutingConfigSnapshot {
  path: string
  exists: boolean
  directTargets: string[]
  matchedDomains: Record<string, { rule: string; target: string; ruleIndex: number }>
  missingDomains: string[]
  complete: boolean
  error: string | null
}

export interface DownloadDirectRoutingSnapshot {
  checked: boolean
  requiredDomains: string[]
  configPaths: string[]
  configs: DownloadDirectRoutingConfigSnapshot[]
  complete: boolean
  missingDomains: string[]
  error: string | null
}

export interface OpenAliceDownloadMonitorReport {
  schemaVersion: 1
  generatedAt: string
  status: MonitorStatus
  warehouseRoot: string
  repoDataRoot: string
  runtimeDir: string
  totals: {
    trackedDatasets: number
    completeDatasets: number
    incompleteDatasets: number
    zipFiles: number
    partFiles: number
  }
  binanceAudit: {
    exists: boolean
    path: string
    completeDatasets: number | null
    incompleteDatasets: number | null
    zipFiles: number | null
    partFiles: number | null
    verifiedZipFiles: number | null
    activeDatasets: BinanceAuditDataset[]
    nextIncompleteDatasets: BinanceAuditDataset[]
  }
  coinmetricsRuntime: {
    collect: RuntimeStatusSnapshot
    normalize: RuntimeStatusSnapshot
    audit: RuntimeStatusSnapshot
  }
  dataCatalog: DataCatalogSnapshot
  okxPublicConnectivity: OkxPublicConnectivitySnapshot
  externalDerivativesCollect: ExternalDerivativesCollectSnapshot
  macosSystemProxy: MacosSystemProxySnapshot
  proxyEnvironment: ProxyEnvironmentSnapshot
  downloadDirectRouting: DownloadDirectRoutingSnapshot
  activeProcesses: ActiveProcessDataset[]
  duplicateActiveDownloaders: DuplicateActiveDownloaderGroup[]
  datasets: DatasetSnapshot[]
  blockers: string[]
  nextActions: string[]
  outputHash: string | null
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/openalice_download_monitor.latest.json'
const EXTERNAL_DERIVATIVES_STALE_REPORT_MS = 10 * 60 * 60 * 1000

const DOWNLOAD_DIRECT_ROUTING_DOMAINS = [
  'data.binance.vision',
  's3-ap-northeast-1.amazonaws.com',
  's3.ap-northeast-1.amazonaws.com',
  's3.dualstack.ap-northeast-1.amazonaws.com',
  'community-api.coinmetrics.io',
]
const DOWNLOAD_DIRECT_ROUTING_TARGETS = ['DIRECT', '🎯 本地直连']

const COINMETRICS_DATASETS = [
  {
    datasetId: 'coinmetrics-community:onchain:raw',
    family: 'coinmetrics',
    relativePath: 'onchain/coinmetrics',
    reportName: 'openalice_coinmetrics_onchain_collect.latest.json',
  },
  {
    datasetId: 'coinmetrics-community:onchain:normalized',
    family: 'coinmetrics',
    relativePath: 'normalized/onchain/coinmetrics',
    reportName: 'openalice_coinmetrics_onchain_normalize.latest.json',
  },
] as const

export function parseMonitorArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const runtimeDir = resolve(raw.get('runtimeDir') ?? raw.get('runtime') ?? 'data/runtime')
  return {
    warehouseRoot: resolve(
      raw.get('warehouseRoot') ??
      raw.get('dataRoot') ??
      process.env.OPENALICE_DATA_ROOT ??
      'data',
    ),
    repoDataRoot: resolve(raw.get('repoDataRoot') ?? raw.get('repoData') ?? 'data'),
    runtimeDir,
    dataCatalogPath: resolve(raw.get('dataCatalogPath') ?? raw.get('catalogPath') ?? resolve(runtimeDir, 'openalice_data_catalog.latest.json')),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
    checkMacosSystemProxy: parseBool(raw.get('checkMacosSystemProxy'), false),
    checkDownloadDirectRouting: parseBool(raw.get('checkDownloadDirectRouting'), false),
    monitorOfflineBackfills: parseBool(raw.get('monitorOfflineBackfills'), false),
    downloadDirectRoutingConfigPaths: parsePathList(
      raw.get('downloadDirectRoutingConfigPaths') ??
      raw.get('directRoutingConfigPaths') ??
      process.env.OPENALICE_DOWNLOAD_DIRECT_ROUTING_CONFIG_PATHS,
      defaultDownloadDirectRoutingConfigPaths(),
    ),
  }
}

export async function runOpenAliceDownloadMonitor(args: CliArgs): Promise<OpenAliceDownloadMonitorReport> {
  const monitorOfflineBackfills = args.monitorOfflineBackfills === true
  const auditPath = resolve(args.runtimeDir, 'binance_public_download_audit.latest.json')
  const audit = readBinanceAudit(auditPath)
  const coinmetricsRuntime = {
    collect: readRuntimeStatusSnapshot(resolve(args.runtimeDir, 'openalice_coinmetrics_onchain_collect.latest.json')),
    normalize: readRuntimeStatusSnapshot(resolve(args.runtimeDir, 'openalice_coinmetrics_onchain_normalize.latest.json')),
    audit: readRuntimeStatusSnapshot(resolve(args.runtimeDir, 'openalice_coinmetrics_onchain_audit.latest.json')),
  }
  const dataCatalog = readDataCatalogSnapshot(args.dataCatalogPath ?? resolve(args.runtimeDir, 'openalice_data_catalog.latest.json'))
  const okxPublicConnectivity = readOkxPublicConnectivitySnapshot(
    resolve(args.runtimeDir, 'okx_public_connectivity_diagnosis.latest.json'),
  )
  const externalDerivativesCollect = readExternalDerivativesCollectSnapshot(
    resolve(args.runtimeDir, 'external_derivatives_data_collect.latest.json'),
    Date.now(),
  )
  const macosSystemProxy = monitorOfflineBackfills && args.checkMacosSystemProxy
    ? readMacosSystemProxySnapshot(args.macosSystemProxyOutput)
    : emptyMacosSystemProxySnapshot(false)
  const proxyEnvironment = readProxyEnvironmentSnapshot(args.proxyEnv ?? process.env)
  const downloadDirectRouting = !monitorOfflineBackfills || args.checkDownloadDirectRouting === false
    ? emptyDownloadDirectRoutingSnapshot(false, args.downloadDirectRoutingConfigPaths ?? [])
    : readDownloadDirectRoutingSnapshot(args.downloadDirectRoutingConfigPaths ?? defaultDownloadDirectRoutingConfigPaths())
  const activeProcesses = monitorOfflineBackfills ? readActiveBinanceProcesses(args.processListOutput) : []
  const processDatasets = activeProcesses
    .filter(processDataset => !audit.activeDatasets.some(dataset => dataset.id === processDataset.id))
    .map(processDataset => fromActiveProcessDataset(processDataset))
  const activeProcessIds = new Set(activeProcesses.map(processDataset => processDataset.id))
  const normalizedActiveAuditDatasets = audit.activeDatasets.map(dataset =>
    activeProcessIds.has(dataset.id)
      ? dataset
      : {
          ...dataset,
          status: 'paused_part_files',
          reason: `${dataset.reason}; no active downloader process found`,
        },
  )
  const dynamicBinanceDatasets = monitorOfflineBackfills ? [
    ...normalizedActiveAuditDatasets,
    ...processDatasets,
    ...audit.nextIncompleteDatasets,
  ].filter((dataset, index, values) => values.findIndex(value => value.id === dataset.id) === index) : []
  const binanceDatasets = dynamicBinanceDatasets.map(dataset => fromBinanceAuditDataset(dataset, activeProcesses))
  const duplicateActiveDownloaders = buildDuplicateActiveDownloaders(activeProcesses)
  const coinmetricsDatasets = await Promise.all(
    COINMETRICS_DATASETS.map(async item =>
      inspectDataset(
        item.datasetId,
        item.family,
        resolve(args.warehouseRoot, item.relativePath),
        resolve(args.runtimeDir, item.reportName),
      ),
    ),
  )
  const datasets = [...binanceDatasets, ...coinmetricsDatasets]
  const completeDatasets = datasets.filter(dataset => dataset.complete).length
  const incompleteDatasets = datasets.length - completeDatasets
  const zipFiles = datasets.reduce((sum, dataset) => sum + dataset.zipFiles, 0)
  const partFiles = datasets.reduce((sum, dataset) => sum + dataset.partFiles, 0)
  const blockers = buildBlockers(
    datasets,
    audit,
    coinmetricsRuntime,
    dataCatalog,
    okxPublicConnectivity,
    externalDerivativesCollect,
    macosSystemProxy,
    proxyEnvironment,
    downloadDirectRouting,
    duplicateActiveDownloaders,
    monitorOfflineBackfills,
  )
  const hasActiveDownload = datasets.some(dataset => dataset.family === 'binance' && datasetRuntimeState(dataset) === 'active')
  const status: MonitorStatus = blockers.length === 0
    ? 'complete'
    : hasActiveDownload || completeDatasets > 0
      ? 'watching'
      : 'blocked'
  const report: OpenAliceDownloadMonitorReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    warehouseRoot: args.warehouseRoot,
    repoDataRoot: args.repoDataRoot,
    runtimeDir: args.runtimeDir,
    totals: {
      trackedDatasets: datasets.length,
      completeDatasets,
      incompleteDatasets,
      zipFiles,
      partFiles,
    },
    binanceAudit: audit,
    coinmetricsRuntime,
    dataCatalog,
    okxPublicConnectivity,
    externalDerivativesCollect,
    macosSystemProxy,
    proxyEnvironment,
    downloadDirectRouting,
    activeProcesses,
    duplicateActiveDownloaders,
    datasets,
    blockers,
    nextActions: buildNextActions(status, blockers, datasets),
    outputHash: null,
  }

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    const payload = `${JSON.stringify(report, null, 2)}\n`
    report.outputHash = sha256Hex(payload)
    await writeFile(outputPath, payload, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'openalice_download_monitor',
      artifactPath: outputPath,
      startedAt: report.generatedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'complete' ? 'pass' : report.status === 'watching' ? 'warn' : 'fail',
      recordsIn: report.totals.trackedDatasets,
      recordsOut: report.totals.completeDatasets,
      errorClass: blockers[0] ?? null,
      artifactHash: report.outputHash,
    })
  }

  return report
}

function readActiveBinanceProcesses(outputOverride?: string): ActiveProcessDataset[] {
  let output = ''
  if (outputOverride != null) {
    output = outputOverride
  } else {
    try {
      output = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf-8' })
    } catch {
      return []
    }
  }
  return output
    .split('\n')
    .map(line => line.trim())
    .map(line => {
      const match = line.match(/^(\d+)\s+(.+)$/)
      if (!match) return null
      const pid = Number(match[1])
      const command = match[2]
      if (!isBinanceDownloaderProcessCommand(command)) return null
      const outDir = extractArgValue(command, '--outDir')
      if (!outDir) return null
      return {
        id: datasetIdFromOutDir(outDir),
        path: outDir,
        pid,
        command: sanitizeProcessCommand(command),
      }
    })
    .filter((value): value is ActiveProcessDataset => value != null)
}

function isBinanceDownloaderProcessCommand(command: string): boolean {
  if (
    !command.includes('scripts/run_fast_binance_data_vision_dataset.ts') &&
    !command.includes('scripts/fast_binance_data_vision_backfill.ts')
  ) {
    return false
  }
  return !/^(?:tmux|zsh|\/bin\/zsh)\b/.test(command)
}

function datasetIdFromOutDir(outDir: string): string {
  const base = outDir.split('/').filter(Boolean).at(-1) ?? outDir
  return base.startsWith('binance-public:') ? base.slice('binance-public:'.length) : base
}

function sanitizeProcessCommand(command: string): string {
  const parts = command
    .split(/\s+/)
    .filter(part => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(part))
  const scriptIndex = parts.findIndex(part =>
    part.endsWith('scripts/run_fast_binance_data_vision_dataset.ts') ||
    part.endsWith('scripts/fast_binance_data_vision_backfill.ts') ||
    part === 'scripts/run_fast_binance_data_vision_dataset.ts' ||
    part === 'scripts/fast_binance_data_vision_backfill.ts'
  )
  const commandParts = scriptIndex >= 0 ? parts.slice(scriptIndex) : parts
  return commandParts
    .join(' ')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '<redacted>')
}


function extractArgValue(command: string, flag: string): string | null {
  const parts = command.split(/\s+/)
  const index = parts.indexOf(flag)
  if (index < 0) return null
  return parts[index + 1] ?? null
}

function fromActiveProcessDataset(input: ActiveProcessDataset): BinanceAuditDataset {
  return {
    id: input.id,
    path: input.path,
    zipFiles: countFilesSync(input.path, '.zip'),
    partFiles: countFilesSync(input.path, '.part'),
    complete: false,
    status: 'process_active',
    reason: `active downloader pid=${input.pid}`,
  }
}

function buildDuplicateActiveDownloaders(activeProcesses: ActiveProcessDataset[]): DuplicateActiveDownloaderGroup[] {
  const grouped = new Map<string, ActiveProcessDataset[]>()
  for (const process of activeProcesses) {
    const key = `${process.id}\n${process.path}`
    grouped.set(key, [...grouped.get(key) ?? [], process])
  }
  return [...grouped.values()]
    .map(processes => processes.slice().sort((left, right) => left.pid - right.pid))
    .filter(processes => processes.length > 1)
    .map(processes => {
      const keepPid = processes[0].pid
      const suggestedStopPids = processes.slice(1).map(process => process.pid)
      return {
        datasetId: `binance-public:${processes[0].id}`,
        path: processes[0].path,
        activeProcessCount: processes.length,
        keepPid,
        suggestedStopPids,
        manualStopCommand: suggestedStopPids.length > 0
          ? `kill -TERM ${suggestedStopPids.join(' ')}`
          : null,
        manualOnly: true as const,
        processes,
      }
    })
}

async function inspectDataset(
  datasetId: string,
  family: DatasetSnapshot['family'],
  path: string,
  reportPath?: string,
): Promise<DatasetSnapshot> {
  const zipFiles = await countFiles(path, '.zip')
  const partFiles = await countFiles(path, '.part')
  const jsonlFiles = await countFiles(path, '.jsonl')
  const summaryPath = resolve(path, 'summary.fast-binance-download.json')
  const manifestPath = resolve(path, 'manifest.fast-binance-download.jsonl')
  const summary = readJsonIfExists<{ coverage?: unknown }>(summaryPath)
  const runtimeReport = reportPath ? readJsonIfExists<Record<string, unknown>>(reportPath) : { exists: false, value: null }
  const dataFiles = family === 'binance' ? zipFiles : jsonlFiles
  const summaryCoverage = typeof summary.value?.coverage === 'string' ? summary.value.coverage : null
  const complete = family === 'binance'
    ? zipFiles > 0 && partFiles === 0 && summaryCoverage === 'complete'
    : dataFiles > 0 && partFiles === 0 && runtimeReport.value?.status === 'complete'
  return {
    datasetId,
    path,
    family,
    zipFiles,
    partFiles,
    dataFiles,
    summaryPresent: summary.exists,
    summaryCoverage,
    summaryComplete: summaryCoverage == null ? null : summaryCoverage === 'complete',
    auditPresent: existsSync(manifestPath),
    manifestPresent: existsSync(manifestPath),
    reportPath: reportPath ?? null,
    reportStatus: typeof runtimeReport.value?.status === 'string' ? runtimeReport.value.status : null,
    reportBlockers: Array.isArray(runtimeReport.value?.blockers)
      ? runtimeReport.value.blockers.filter((item): item is string => typeof item === 'string')
      : [],
    activeProcessPids: [],
    complete,
  }
}

function readBinanceAudit(path: string): OpenAliceDownloadMonitorReport['binanceAudit'] {
  if (!existsSync(path)) {
    return {
      exists: false,
      path,
      completeDatasets: null,
      incompleteDatasets: null,
      zipFiles: null,
      partFiles: null,
      verifiedZipFiles: null,
      activeDatasets: [],
      nextIncompleteDatasets: [],
    }
  }
  try {
    const payload = JSON.parse(readFileSync(path, 'utf-8')) as {
      totals?: {
        completeDatasets?: number
        incompleteDatasets?: number
        zipFiles?: number
        partFiles?: number
        verifiedZipFiles?: number
      }
      audits?: Array<{
        id?: string
        path?: string
        zipFiles?: number
        partFiles?: number
        complete?: boolean
        status?: string
        reason?: string
      }>
    }
    const audits = (payload.audits ?? []).map(toBinanceAuditDataset).filter((dataset): dataset is BinanceAuditDataset => dataset != null)
    const activeDatasets = audits.filter(dataset => dataset.status === 'in_progress')
    const nextIncompleteDatasets = audits.filter(dataset => !dataset.complete && dataset.status !== 'in_progress').slice(0, 5)
    return {
      exists: true,
      path,
      completeDatasets: payload.totals?.completeDatasets ?? null,
      incompleteDatasets: payload.totals?.incompleteDatasets ?? null,
      zipFiles: payload.totals?.zipFiles ?? null,
      partFiles: payload.totals?.partFiles ?? null,
      verifiedZipFiles: payload.totals?.verifiedZipFiles ?? null,
      activeDatasets,
      nextIncompleteDatasets,
    }
  } catch {
    return {
      exists: true,
      path,
      completeDatasets: null,
      incompleteDatasets: null,
      zipFiles: null,
      partFiles: null,
      verifiedZipFiles: null,
      activeDatasets: [],
      nextIncompleteDatasets: [],
    }
  }
}

function toBinanceAuditDataset(input: {
  id?: string
  path?: string
  zipFiles?: number
  partFiles?: number
  complete?: boolean
  status?: string
  reason?: string
}): BinanceAuditDataset | null {
  if (!input.id || !input.path) return null
  return {
    id: input.id,
    path: input.path,
    zipFiles: input.zipFiles ?? 0,
    partFiles: input.partFiles ?? 0,
    complete: input.complete === true,
    status: input.status ?? 'unknown',
    reason: input.reason ?? 'unknown',
  }
}

function fromBinanceAuditDataset(input: BinanceAuditDataset, activeProcesses: ActiveProcessDataset[]): DatasetSnapshot {
  const activeProcessPids = activeProcesses
    .filter(processDataset => processDataset.id === input.id)
    .map(processDataset => processDataset.pid)
  const summaryPath = resolve(input.path, 'summary.fast-binance-download.json')
  const manifestPath = resolve(input.path, 'manifest.fast-binance-download.jsonl')
  const summary = readJsonIfExists<{ coverage?: unknown }>(summaryPath)
  const summaryCoverage = typeof summary.value?.coverage === 'string' ? summary.value.coverage : null
  return {
    datasetId: `binance-public:${input.id}`,
    path: input.path,
    family: 'binance',
    zipFiles: input.zipFiles,
    partFiles: input.partFiles,
    dataFiles: input.zipFiles,
    summaryPresent: summary.exists,
    summaryCoverage,
    summaryComplete: summaryCoverage == null ? null : summaryCoverage === 'complete',
    auditPresent: true,
    manifestPresent: existsSync(manifestPath),
    reportPath: null,
    reportStatus: input.status,
    reportBlockers: input.complete ? [] : [input.reason],
    activeProcessPids,
    complete: input.complete,
  }
}

function datasetRuntimeState(dataset: DatasetSnapshot): BinanceRuntimeState {
  if (dataset.complete) return 'complete'
  if (dataset.family === 'binance' && dataset.activeProcessPids.length > 0) return 'active'
  if (dataset.family === 'binance' && dataset.partFiles > 0) return 'paused_part_files'
  return 'incomplete'
}

function buildBlockers(
  datasets: DatasetSnapshot[],
  audit: OpenAliceDownloadMonitorReport['binanceAudit'],
  coinmetricsRuntime: OpenAliceDownloadMonitorReport['coinmetricsRuntime'],
  dataCatalog: OpenAliceDownloadMonitorReport['dataCatalog'],
  okxPublicConnectivity: OpenAliceDownloadMonitorReport['okxPublicConnectivity'],
  externalDerivativesCollect: OpenAliceDownloadMonitorReport['externalDerivativesCollect'],
  macosSystemProxy: MacosSystemProxySnapshot,
  proxyEnvironment: ProxyEnvironmentSnapshot,
  downloadDirectRouting: DownloadDirectRoutingSnapshot,
  duplicateActiveDownloaders: DuplicateActiveDownloaderGroup[],
  monitorOfflineBackfills = false,
): string[] {
  const blockers: string[] = []
  if (monitorOfflineBackfills && !audit.exists) blockers.push('binance_audit_missing')
  if (monitorOfflineBackfills && audit.exists && (audit.incompleteDatasets ?? 0) > 0) blockers.push(`binance_incomplete:${audit.incompleteDatasets}`)
  if (!dataCatalog.exists) blockers.push('openalice_data_catalog_missing')
  const nonOfflineCatalogBlockers = dataCatalog.categories.filter(category => category.category !== 'download_gap')
  if (
    dataCatalog.exists &&
    dataCatalog.status !== 'complete' &&
    (monitorOfflineBackfills || nonOfflineCatalogBlockers.length > 0)
  ) {
    blockers.push(`openalice_data_catalog_status:${dataCatalog.status ?? 'missing'}`)
  }
  if (monitorOfflineBackfills && (dataCatalog.downloadGapBlockers ?? 0) > 0) {
    blockers.push(`openalice_data_catalog_download_gap:${dataCatalog.downloadGapBlockers}`)
  }
  if ((dataCatalog.pitOrNormalizedGapBlockers ?? 0) > 0) {
    blockers.push(`openalice_data_catalog_pit_or_normalized_gap:${dataCatalog.pitOrNormalizedGapBlockers}`)
  }
  const incomplete = datasets.filter(dataset => !dataset.complete).map(dataset => dataset.datasetId)
  if (incomplete.length > 0) blockers.push(`tracked_datasets_incomplete:${incomplete.join(',')}`)
  if (duplicateActiveDownloaders.length > 0) {
    blockers.push(`duplicate_active_downloader_processes:${duplicateActiveDownloaders
      .map(group => `${group.datasetId}:${group.activeProcessCount}`)
      .join(',')}`)
  }
  if (coinmetricsRuntime.collect.exists && coinmetricsRuntime.collect.status !== 'complete') {
    blockers.push(`coinmetrics_collect_status:${coinmetricsRuntime.collect.status ?? 'missing'}`)
  }
  if (coinmetricsRuntime.normalize.exists && coinmetricsRuntime.normalize.status !== 'complete') {
    blockers.push(`coinmetrics_normalize_status:${coinmetricsRuntime.normalize.status ?? 'missing'}`)
  }
  if (coinmetricsRuntime.audit.exists && coinmetricsRuntime.audit.status !== 'complete') {
    blockers.push(`coinmetrics_audit_status:${coinmetricsRuntime.audit.status ?? 'missing'}`)
  }
  if (okxPublicConnectivity.exists && okxPublicConnectivity.publicDataFetchable === false) {
    blockers.push(`okx_public_connectivity_status:${okxPublicConnectivity.status ?? 'missing'}`)
  }
  if (externalDerivativesCollect.exists && externalDerivativesCollect.stale) {
    blockers.push('external_derivatives_collect_stale')
  }
  if (externalDerivativesCollect.exists && externalDerivativesCollect.errorCount > 0) {
    const prefix = externalDerivativesCollect.dryRun === true
      ? 'external_derivatives_collect_dry_run_errors'
      : 'external_derivatives_collect_errors'
    blockers.push(`${prefix}:${formatErrorSummaryBlocker(externalDerivativesCollect.errorSummary)}`)
  }
  if (monitorOfflineBackfills && downloadDirectRouting.checked && !downloadDirectRouting.complete) {
    blockers.push(`download_direct_routing_incomplete:${downloadDirectRouting.missingDomains.join(',')}`)
  }
  const directRoutingVerified = downloadDirectRouting.checked && downloadDirectRouting.complete
  if (monitorOfflineBackfills && macosSystemProxy.enabled === true && !directRoutingVerified) {
    blockers.push('macos_system_proxy_enabled')
  }
  if (monitorOfflineBackfills && proxyEnvironment.enabled && !directRoutingVerified) {
    blockers.push('proxy_environment_variables_present')
  }
  return blockers
}

function buildNextActions(status: MonitorStatus, blockers: string[], datasets: DatasetSnapshot[]): string[] {
  if (status === 'complete') return ['Keep the monitor on a lower cadence only if new data sources are added.']
  if (blockers.some(blocker => blocker.startsWith('duplicate_active_downloader_processes:'))) {
    return ['Collapse each Binance Data Vision dataset to a single active downloader, then rerun this monitor before launching more downloads.']
  }
  if (datasets.some(dataset => datasetRuntimeState(dataset) === 'active')) {
    return ['Keep the active Binance downloader running; refresh audit and monitor after the current dataset finishes or reports failures.']
  }
  if (blockers.some(blocker => blocker.startsWith('download_direct_routing_incomplete:'))) {
    return ['Add the Binance and Coin Metrics download domains to Mihomo/Clash DIRECT rules, reload the profile, then rerun this monitor before resuming downloads.']
  }
  if (blockers.includes('macos_system_proxy_enabled')) {
    return ['Disable the macOS system proxy/VPN proxy before resuming Binance downloads, then rerun this monitor.']
  }
  if (blockers.includes('proxy_environment_variables_present')) {
    return ['Clear HTTP_PROXY/HTTPS_PROXY/ALL_PROXY and lowercase proxy variables before resuming Binance downloads, then rerun this monitor.']
  }
  if (datasets.some(dataset => datasetRuntimeState(dataset) === 'paused_part_files')) {
    return ['Clear stale .part files or resume the paused Binance dataset only after network/proxy routing has been verified.']
  }
  if (blockers.some(blocker => blocker.startsWith('okx_public_connectivity_status:'))) {
    return ['Restore OKX public endpoint reachability or proxy health, then rerun data:okx-public:diagnose and public accumulation jobs.']
  }
  if (blockers.includes('external_derivatives_collect_stale')) {
    return ['Rerun external derivatives collection in research-only mode; keep funding/carry promotion blocked until the collector report is fresh.']
  }
  if (blockers.some(blocker => blocker.startsWith('external_derivatives_collect'))) {
    return ['Diagnose the OKX public derivatives collector with one-symbol dry-run probes; keep funding/carry evidence research-only until collection errors clear.']
  }
  if (blockers.some(blocker => blocker.startsWith('tracked_datasets_incomplete'))) {
    return ['Refresh the local research datasets; keep retired Binance backfills manual and offline-only.']
  }
  return ['Refresh the local OKX and research-data monitor after the next scheduled collection run.']
}

function readDataCatalogSnapshot(path: string): DataCatalogSnapshot {
  const report = readJsonIfExists<Record<string, unknown>>(path)
  if (!report.exists || !report.value) {
    return {
      exists: report.exists,
      path,
      status: null,
      datasets: null,
      complete: null,
      partial: null,
      missing: null,
      inProgress: null,
      completePct: null,
      totalBlockers: null,
      primaryBlockerCategory: null,
      categories: [],
      downloadGapBlockers: null,
      pitOrNormalizedGapBlockers: null,
      aiScientistValidationGateBlockers: null,
      sampleDownloadGapBlockers: [],
      nextDownloadGapAction: null,
    }
  }
  const summary = asRecord(report.value.summary)
  const blockerActionability = asRecord(report.value.blockerActionability)
  const categories = Array.isArray(blockerActionability?.categories)
    ? blockerActionability.categories
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => item != null)
        .map(category => ({
          category: typeof category.category === 'string' ? category.category : 'unknown',
          count: readNullableNumber(category.count) ?? 0,
        }))
        .filter(category => category.count > 0)
    : []
  const downloadGap = readCatalogActionCategory(blockerActionability, 'download_gap')
  const datasets = readNullableNumber(summary?.datasets)
  const complete = readNullableNumber(summary?.complete)
  const completePct = datasets != null && complete != null && datasets > 0
    ? Math.round((complete / datasets) * 100)
    : null
  return {
    exists: true,
    path,
    status: typeof report.value.status === 'string' ? report.value.status : null,
    datasets,
    complete,
    partial: readNullableNumber(summary?.partial),
    missing: readNullableNumber(summary?.missing),
    inProgress: readNullableNumber(summary?.inProgress),
    completePct,
    totalBlockers: readNullableNumber(blockerActionability?.totalBlockers),
    primaryBlockerCategory: typeof blockerActionability?.primaryCategory === 'string'
      ? blockerActionability.primaryCategory
      : null,
    categories,
    downloadGapBlockers: readCatalogActionCategoryCount(blockerActionability, 'download_gap'),
    pitOrNormalizedGapBlockers: readCatalogActionCategoryCount(blockerActionability, 'pit_or_normalized_gap'),
    aiScientistValidationGateBlockers: readCatalogActionCategoryCount(blockerActionability, 'ai_scientist_validation_gate'),
    sampleDownloadGapBlockers: readStringArray(downloadGap?.sampleBlockers).slice(0, 12),
    nextDownloadGapAction: typeof downloadGap?.nextAction === 'string' ? downloadGap.nextAction : null,
  }
}

function readCatalogActionCategory(value: Record<string, unknown> | null, category: string): Record<string, unknown> | null {
  const categories = Array.isArray(value?.categories) ? value.categories : []
  return categories
    .map(asRecord)
    .find((item): item is Record<string, unknown> => item != null && item.category === category) ?? null
}

function readCatalogActionCategoryCount(value: Record<string, unknown> | null, category: string): number | null {
  return readNullableNumber(readCatalogActionCategory(value, category)?.count)
}

function readRuntimeStatusSnapshot(path: string): RuntimeStatusSnapshot {
  const report = readJsonIfExists<Record<string, unknown>>(path)
  return {
    exists: report.exists,
    path,
    status: typeof report.value?.status === 'string' ? report.value.status : null,
    blockers: Array.isArray(report.value?.blockers)
      ? report.value.blockers.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

function readOkxPublicConnectivitySnapshot(path: string): OkxPublicConnectivitySnapshot {
  const report = readJsonIfExists<Record<string, unknown>>(path)
  const attempts = Array.isArray(report.value?.attempts)
    ? report.value.attempts.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
  return {
    exists: report.exists,
    path,
    status: typeof report.value?.status === 'string' ? report.value.status : null,
    publicDataFetchable: typeof report.value?.publicDataFetchable === 'boolean' ? report.value.publicDataFetchable : null,
    failedHosts: attempts
      .filter(item => item.ok !== true)
      .map(item => typeof item.hostname === 'string' ? item.hostname : null)
      .filter((item): item is string => item != null),
    failedErrorClasses: [
      ...new Set(
        attempts
          .filter(item => item.ok !== true)
          .map(item => typeof item.errorClass === 'string' ? item.errorClass : null)
          .filter((item): item is string => item != null),
      ),
    ],
  }
}

function readExternalDerivativesCollectSnapshot(path: string, nowMs: number): ExternalDerivativesCollectSnapshot {
  const report = readJsonIfExists<Record<string, unknown>>(path)
  if (!report.exists || !report.value) {
    return {
      exists: report.exists,
      path,
      generatedAt: null,
      ageMs: null,
      stale: false,
      staleAfterMs: EXTERNAL_DERIVATIVES_STALE_REPORT_MS,
      dryRun: null,
      proxyConfigured: null,
      proxySource: null,
      fetchedRows: null,
      appendedRows: null,
      wouldAppendRows: null,
      skippedDuplicateRows: null,
      errorCount: 0,
      errorSummary: {},
      latestErrors: [],
    }
  }
  const generatedAt = typeof report.value.generatedAt === 'string' ? report.value.generatedAt : null
  const generatedAtMs = generatedAt ? Date.parse(generatedAt) : NaN
  const ageMs = Number.isFinite(generatedAtMs) ? Math.max(0, nowMs - generatedAtMs) : null
  const errorSummary = normalizeErrorSummary(report.value.errorSummary)
  const errors = Array.isArray(report.value.errors)
    ? report.value.errors.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
  const errorCount = errors.length > 0
    ? errors.length
    : Object.values(errorSummary).reduce((sum, value) => sum + value, 0)
  const latestErrors = errors
        .slice(0, 5)
        .map(error => ({
          symbol: typeof error.symbol === 'string' ? error.symbol : null,
          endpoint: typeof error.endpoint === 'string' ? error.endpoint : null,
          errorClass: typeof error.errorClass === 'string' ? error.errorClass : null,
          error: typeof error.error === 'string' ? redactMonitorDiagnosticText(error.error) : null,
        }))
  return {
    exists: true,
    path,
    generatedAt,
    ageMs,
    stale: ageMs == null ? true : ageMs > EXTERNAL_DERIVATIVES_STALE_REPORT_MS,
    staleAfterMs: EXTERNAL_DERIVATIVES_STALE_REPORT_MS,
    dryRun: typeof report.value.dryRun === 'boolean' ? report.value.dryRun : null,
    proxyConfigured: typeof report.value.proxyConfigured === 'boolean' ? report.value.proxyConfigured : null,
    proxySource: typeof report.value.proxySource === 'string' ? report.value.proxySource : null,
    fetchedRows: readNullableNumber(report.value.fetchedRows),
    appendedRows: readNullableNumber(report.value.appendedRows),
    wouldAppendRows: readNullableNumber(report.value.wouldAppendRows),
    skippedDuplicateRows: readNullableNumber(report.value.skippedDuplicateRows),
    errorCount,
    errorSummary,
    latestErrors,
  }
}

function normalizeErrorSummary(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) out[key] = raw
  }
  return out
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function formatErrorSummaryBlocker(summary: Record<string, number>): string {
  const entries = Object.entries(summary).sort(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0) return 'unknown'
  return entries.map(([key, value]) => `${key}:${value}`).join(',')
}

export function parseMacosSystemProxyOutput(output: string): MacosSystemProxySnapshot {
  const valueByKey = new Map<string, string>()
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/)
    if (!match) continue
    valueByKey.set(match[1], match[2])
  }
  const httpEnabled = valueByKey.get('HTTPEnable') === '1'
  const httpsEnabled = valueByKey.get('HTTPSEnable') === '1'
  const socksEnabled = valueByKey.get('SOCKSEnable') === '1'
  return {
    checked: true,
    enabled: httpEnabled || httpsEnabled || socksEnabled,
    httpProxy: httpEnabled ? valueByKey.get('HTTPProxy') ?? null : null,
    httpPort: httpEnabled ? parseProxyPort(valueByKey.get('HTTPPort')) : null,
    httpsProxy: httpsEnabled ? valueByKey.get('HTTPSProxy') ?? null : null,
    httpsPort: httpsEnabled ? parseProxyPort(valueByKey.get('HTTPSPort')) : null,
    socksProxy: socksEnabled ? valueByKey.get('SOCKSProxy') ?? null : null,
    socksPort: socksEnabled ? parseProxyPort(valueByKey.get('SOCKSPort')) : null,
    error: null,
  }
}

function readMacosSystemProxySnapshot(outputOverride?: string): MacosSystemProxySnapshot {
  if (outputOverride != null) return parseMacosSystemProxyOutput(outputOverride)
  if (process.platform !== 'darwin') return emptyMacosSystemProxySnapshot(false)
  try {
    return parseMacosSystemProxyOutput(execFileSync('scutil', ['--proxy'], { encoding: 'utf-8' }))
  } catch (error) {
    return {
      ...emptyMacosSystemProxySnapshot(true),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function emptyMacosSystemProxySnapshot(checked: boolean): MacosSystemProxySnapshot {
  return {
    checked,
    enabled: checked ? false : null,
    httpProxy: null,
    httpPort: null,
    httpsProxy: null,
    httpsPort: null,
    socksProxy: null,
    socksPort: null,
    error: null,
  }
}

function parseProxyPort(value: string | undefined): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function readProxyEnvironmentSnapshot(env: NodeJS.ProcessEnv): ProxyEnvironmentSnapshot {
  const variableNames = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ]
  const variables: Record<string, string> = {}
  for (const name of variableNames) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') variables[name] = redactMonitorDiagnosticText(value)
  }
  return {
    checked: true,
    enabled: ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some(name =>
      variables[name] != null,
    ),
    variables,
  }
}

function redactMonitorDiagnosticText(value: string): string {
  let redacted = value
  redacted = redacted.replace(/\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi, match => {
    const protocol = match.match(/^https?:\/\//i)?.[0] ?? ''
    return `${protocol}***:***@`
  })
  redacted = redacted.replace(
    /([?&](?:api[_-]?key|apikey|signature|token|secret|key|password|pass)=)[^&\s]+/gi,
    '$1***',
  )
  return redacted
}

function defaultDownloadDirectRoutingConfigPaths(): string[] {
  const home = process.env.HOME
  if (!home) return []
  const appRoot = resolve(home, 'Library/Application Support/mihomo-party')
  const currentProfileId = readCurrentMihomoProfileId(resolve(appRoot, 'profile.yaml'))
  return [
    resolve(appRoot, 'work/config.yaml'),
    ...(currentProfileId ? [resolve(appRoot, `rules/${currentProfileId}.yaml`)] : []),
  ]
}

export function readDownloadDirectRoutingSnapshot(configPaths: string[]): DownloadDirectRoutingSnapshot {
  const normalizedPaths = configPaths.map(path => resolve(path))
  const configs = normalizedPaths.map(readDownloadDirectRoutingConfigSnapshot)
  const completeConfig = configs.find(config => config.complete)
  const missingDomains = completeConfig
    ? []
    : [
        ...new Set(
          configs.length > 0
            ? configs.flatMap(config => config.missingDomains)
            : DOWNLOAD_DIRECT_ROUTING_DOMAINS,
        ),
      ].filter(domain => DOWNLOAD_DIRECT_ROUTING_DOMAINS.includes(domain))
  return {
    checked: true,
    requiredDomains: DOWNLOAD_DIRECT_ROUTING_DOMAINS,
    configPaths: normalizedPaths,
    configs,
    complete: completeConfig != null,
    missingDomains,
    error: configs.find(config => config.error != null)?.error ?? null,
  }
}

function readDownloadDirectRoutingConfigSnapshot(path: string): DownloadDirectRoutingConfigSnapshot {
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      directTargets: ['DIRECT', '🎯 本地直连'],
      matchedDomains: {},
      missingDomains: DOWNLOAD_DIRECT_ROUTING_DOMAINS,
      complete: false,
      error: null,
    }
  }
  try {
    const content = readFileSync(path, 'utf-8')
    const directTargets = detectMihomoDirectTargets(content)
    const rules = extractMihomoRules(content)
    const matchedDomains: Record<string, { rule: string; target: string; ruleIndex: number }> = {}
    for (const domain of DOWNLOAD_DIRECT_ROUTING_DOMAINS) {
      const match = findMatchingDirectRule(domain, rules, directTargets)
      if (match) matchedDomains[domain] = match
    }
    const missingDomains = DOWNLOAD_DIRECT_ROUTING_DOMAINS.filter(domain => matchedDomains[domain] == null)
    return {
      path,
      exists: true,
      directTargets,
      matchedDomains,
      missingDomains,
      complete: missingDomains.length === 0,
      error: null,
    }
  } catch (error) {
    return {
      path,
      exists: true,
      directTargets: ['DIRECT', '🎯 本地直连'],
      matchedDomains: {},
      missingDomains: DOWNLOAD_DIRECT_ROUTING_DOMAINS,
      complete: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function detectMihomoDirectTargets(content: string): string[] {
  const targets = new Set(DOWNLOAD_DIRECT_ROUTING_TARGETS)
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^\s*-\s*name:\s*(.+?)\s*$/)
    if (!match) continue
    const name = match[1]
    const window = lines.slice(index + 1, index + 12).join('\n')
    if (window.includes('- DIRECT')) targets.add(name)
  }
  return [...targets]
}

function extractMihomoRules(content: string): string[] {
  const lines = content.split('\n')
  const topLevelRulesIndex = lines.findIndex(line => line.trim() === 'rules:' && !line.startsWith(' '))
  if (topLevelRulesIndex >= 0) return extractYamlListAfterKey(lines, topLevelRulesIndex)
  const prependIndex = lines.findIndex(line => line.trim() === 'prepend:' && !line.startsWith(' '))
  if (prependIndex >= 0) return extractYamlListAfterKey(lines, prependIndex)
  return []
}

function extractYamlListAfterKey(lines: string[], keyIndex: number): string[] {
  const rules: string[] = []
  for (const line of lines.slice(keyIndex + 1)) {
    if (/^\S/.test(line) && line.trim() !== '') break
    const match = line.match(/^\s*-\s*(.+?)\s*$/)
    if (match) rules.push(match[1])
  }
  return rules
}

function readCurrentMihomoProfileId(path: string): string | null {
  if (!existsSync(path)) return null
  const match = readFileSync(path, 'utf-8').match(/^current:\s*(\S+)\s*$/m)
  return match?.[1] ?? null
}

function findMatchingDirectRule(
  domain: string,
  rules: string[],
  directTargets: string[],
): { rule: string; target: string; ruleIndex: number } | null {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]
    const parts = rule.split(',').map(part => part.trim())
    const ruleType = parts[0]
    const ruleValue = parts[1]
    const target = parts[2]
    if (!ruleType || !ruleValue || !target || !directTargets.includes(target)) continue
    if (ruleType === 'DOMAIN' && ruleValue === domain) return { rule, target, ruleIndex: index }
    if (ruleType === 'DOMAIN-SUFFIX' && (domain === ruleValue || domain.endsWith(`.${ruleValue}`))) {
      return { rule, target, ruleIndex: index }
    }
  }
  return null
}

function emptyDownloadDirectRoutingSnapshot(
  checked: boolean,
  configPaths: string[],
): DownloadDirectRoutingSnapshot {
  return {
    checked,
    requiredDomains: DOWNLOAD_DIRECT_ROUTING_DOMAINS,
    configPaths: configPaths.map(path => resolve(path)),
    configs: [],
    complete: false,
    missingDomains: checked ? DOWNLOAD_DIRECT_ROUTING_DOMAINS : [],
    error: null,
  }
}

async function countFiles(root: string, suffix: string): Promise<number> {
  try {
    const entries = await import('node:fs/promises').then(module => module.readdir(root, { recursive: true, withFileTypes: true }))
    return entries.filter(entry => entry.isFile() && entry.name.endsWith(suffix)).length
  } catch {
    return 0
  }
}

function countFilesSync(root: string, suffix: string): number {
  if (!existsSync(root)) return 0
  let count = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = resolve(current, entry.name)
      if (entry.isDirectory()) stack.push(child)
      else if (entry.isFile() && entry.name.endsWith(suffix)) count += 1
    }
  }
  return count
}

function readJsonIfExists<T>(path: string): { exists: boolean; value: T | null } {
  if (!existsSync(path)) return { exists: false, value: null }
  try {
    return { exists: true, value: JSON.parse(readFileSync(path, 'utf-8')) as T }
  } catch {
    return { exists: true, value: null }
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [key, inlineValue] = token.slice(2).split('=', 2)
    if (inlineValue !== undefined) {
      out.set(key, inlineValue)
      continue
    }
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
  return normalized === 'null' || normalized === 'none' || normalized === 'false' ? null : value
}

function parsePathList(value: string | undefined, fallback: string[]): string[] {
  if (value == null || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (['null', 'none', 'false'].includes(normalized)) return []
  return value
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '')
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase())
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseMonitorArgs(argv)
  const report = await runOpenAliceDownloadMonitor(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(JSON.stringify(report, null, 2))
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('monitor_openalice_data_downloads failed:', error)
    process.exit(1)
  })
}
