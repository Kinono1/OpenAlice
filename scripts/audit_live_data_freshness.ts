import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import {
  defaultMarketDataUniverseAssets,
  defaultSecondLevelMarketDataUniverseAssets,
  paperSymbolToCsvFile,
  type PaperUniverseAsset,
  type PaperUniverseTimeframe,
} from './lib/paper_universe.js'

type LiveDataStatus = 'fresh' | 'degraded' | 'blocked'
type LiveDataTimeframe = PaperUniverseTimeframe

interface CliArgs {
  oneHourDir: string
  fiveMinuteDir: string
  oneSecondDir: string
  outputPath: string | null
  maxAge1hMs: number
  maxAge5mMs: number
  maxAge1sMs: number
  minRows1h: number
  minRows5m: number
  minRows1s: number
  minCommonPeriods1h: number
  json: boolean
}

export interface LiveDataFreshnessThresholds {
  maxAgeMsByTimeframe: Record<LiveDataTimeframe, number>
  minRowsByTimeframe: Record<LiveDataTimeframe, number>
  minCommonPeriods1h: number
}

export interface LiveDataFreshnessAsset {
  paperSymbol: string
  storageSymbol: string
  timeframe: LiveDataTimeframe
  filePath: string
  present: boolean
  rawRows: number
  rowCount: number
  duplicateTimestampCount: number
  invalidTimestampRows: number
  monotonic: boolean
  gapCount: number
  maxGapMs: number | null
  firstTimestamp: number | null
  firstDatetime: string | null
  lastTimestamp: number | null
  lastDatetime: string | null
  ageMs: number | null
  fresh: boolean
  enoughRows: boolean
  blockers: string[]
}

export interface LiveDataFreshnessDirectory {
  timeframe: LiveDataTimeframe
  dataDir: string
  expectedAssets: number
  presentAssets: number
  freshAssets: number
  enoughRowsAssets: number
  status: LiveDataStatus
  minRowsRequired: number
  maxAgeMsAllowed: number
  commonPeriods: number
  commonLatestTimestamp: number | null
  commonLatestDatetime: string | null
  commonLatestAgeMs: number | null
  incubationCommonPeriodsRequired: number | null
  incubationCommonPeriodsReady: boolean | null
  assets: LiveDataFreshnessAsset[]
  blockers: string[]
  nextActions: string[]
}

export interface LiveDataFreshnessReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionAllowed: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  status: LiveDataStatus
  thresholds: LiveDataFreshnessThresholds
  summary: {
    directoryCount: number
    expectedAssets: number
    presentAssets: number
    freshAssets: number
    enoughRowsAssets: number
    oneHourCommonPeriods: number | null
    oneHourCommonLatestDatetime: string | null
    oneHourIncubationCommonPeriodsReady: boolean
    publicDataUsableForLiveOnlyResearch: boolean
  }
  directories: LiveDataFreshnessDirectory[]
  blockers: string[]
  globalNextActions: string[]
  safetyNotes: string[]
}

interface AuditAssetInput {
  paperSymbol: string
  storageSymbol: string
  file: string
}

interface CsvTimestampStats {
  rawRows: number
  timestamps: number[]
  duplicateTimestampCount: number
  invalidTimestampRows: number
  monotonic: boolean
}

type LiveDataFreshnessAssetWithTimestamps = LiveDataFreshnessAsset & { timestamps: number[] }

const DEFAULT_ONE_HOUR_DIR = 'data/market/live_accumulated'
const DEFAULT_FIVE_MINUTE_DIR = 'data/market/live_5m'
const DEFAULT_ONE_SECOND_DIR = 'data/market/live_1s'
export const DEFAULT_LIVE_DATA_FRESHNESS_PATH = 'data/runtime/live_data_freshness.latest.json'
const DEFAULT_OUTPUT_PATH = DEFAULT_LIVE_DATA_FRESHNESS_PATH
const DEFAULT_MAX_AGE_1H_MS = 2 * 60 * 60 * 1000
const DEFAULT_MAX_AGE_5M_MS = 15 * 60 * 1000
const DEFAULT_MAX_AGE_1S_MS = 5 * 60 * 1000
const DEFAULT_MIN_ROWS_1H = 336 + 72
const DEFAULT_MIN_ROWS_5M = 1_000
const DEFAULT_MIN_ROWS_1S = 300
const DEFAULT_MIN_COMMON_PERIODS_1H = 1_000
const STEP_MS_BY_TIMEFRAME: Record<LiveDataTimeframe, number> = {
  '1h': 60 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '1s': 1000,
}

async function main(): Promise<void> {
  const args = parseLiveDataFreshnessArgs(process.argv.slice(2))
  const report = await runLiveDataFreshnessAudit(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseLiveDataFreshnessArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    oneHourDir: raw.get('oneHourDir') ?? raw.get('oneHour') ?? DEFAULT_ONE_HOUR_DIR,
    fiveMinuteDir: raw.get('fiveMinuteDir') ?? raw.get('fiveMinute') ?? DEFAULT_FIVE_MINUTE_DIR,
    oneSecondDir: raw.get('oneSecondDir') ?? raw.get('oneSecond') ?? DEFAULT_ONE_SECOND_DIR,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxAge1hMs: parsePositiveInteger(raw.get('maxAge1hMs'), DEFAULT_MAX_AGE_1H_MS, 'maxAge1hMs'),
    maxAge5mMs: parsePositiveInteger(raw.get('maxAge5mMs'), DEFAULT_MAX_AGE_5M_MS, 'maxAge5mMs'),
    maxAge1sMs: parsePositiveInteger(raw.get('maxAge1sMs'), DEFAULT_MAX_AGE_1S_MS, 'maxAge1sMs'),
    minRows1h: parsePositiveInteger(raw.get('minRows1h'), DEFAULT_MIN_ROWS_1H, 'minRows1h'),
    minRows5m: parsePositiveInteger(raw.get('minRows5m'), DEFAULT_MIN_ROWS_5M, 'minRows5m'),
    minRows1s: parsePositiveInteger(raw.get('minRows1s'), DEFAULT_MIN_ROWS_1S, 'minRows1s'),
    minCommonPeriods1h: parsePositiveInteger(
      raw.get('minCommonPeriods1h'),
      DEFAULT_MIN_COMMON_PERIODS_1H,
      'minCommonPeriods1h',
    ),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runLiveDataFreshnessAudit(args: CliArgs): Promise<LiveDataFreshnessReport> {
  const startedAt = new Date()
  const thresholds = buildThresholds(args)
  const generatedAt = new Date().toISOString()
  const directories = await Promise.all([
    auditLiveDataDirectory({
      timeframe: '1h',
      dataDir: args.oneHourDir,
      assets: defaultMarketDataUniverseAssets(),
      generatedAt,
      thresholds,
    }),
    auditLiveDataDirectory({
      timeframe: '5m',
      dataDir: args.fiveMinuteDir,
      assets: defaultMarketDataUniverseAssets('5m').map(asset => ({
        ...asset,
        file: paperSymbolToCsvFile(asset.paperSymbol, '5m'),
      })),
      generatedAt,
      thresholds,
    }),
    auditLiveDataDirectory({
      timeframe: '1s',
      dataDir: args.oneSecondDir,
      assets: defaultSecondLevelMarketDataUniverseAssets().map(asset => ({
        ...asset,
        file: paperSymbolToCsvFile(asset.paperSymbol, '1s'),
      })),
      generatedAt,
      thresholds,
    }),
  ])
  const report = buildLiveDataFreshnessReport({
    generatedAt,
    thresholds,
    directories,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'live_data_freshness_audit',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'fresh' ? 'pass' : 'warn',
      recordsIn: directories.reduce((sum, directory) => sum + directory.expectedAssets, 0),
      recordsOut: directories.reduce((sum, directory) => sum + directory.presentAssets, 0),
      errorClass: report.status === 'fresh' ? null : `live_data_${report.status}`,
    })
  }

  return report
}

export async function auditLiveDataDirectory(input: {
  timeframe: LiveDataTimeframe
  dataDir: string
  assets: AuditAssetInput[]
  generatedAt: string
  thresholds: LiveDataFreshnessThresholds
}): Promise<LiveDataFreshnessDirectory> {
  const generatedAtMs = Date.parse(input.generatedAt)
  const dataDir = resolve(input.dataDir)
  const assetsWithTimestamps = await Promise.all(input.assets.map(asset =>
    auditLiveDataAsset({
      ...asset,
      timeframe: input.timeframe,
      dataDir,
      generatedAtMs,
      minRows: input.thresholds.minRowsByTimeframe[input.timeframe],
      maxAgeMs: input.thresholds.maxAgeMsByTimeframe[input.timeframe],
    }),
  ))
  const commonTimestamps = intersectTimestampSets(assetsWithTimestamps.map(asset => asset.present ? asset : null))
  const assets = assetsWithTimestamps.map(stripInternalTimestamps)
  const commonLatestTimestamp = commonTimestamps.length > 0 ? commonTimestamps[commonTimestamps.length - 1] : null
  const commonLatestAgeMs = commonLatestTimestamp != null && Number.isFinite(generatedAtMs)
    ? Math.max(0, generatedAtMs - commonLatestTimestamp)
    : null
  const presentAssets = assets.filter(asset => asset.present).length
  const freshAssets = assets.filter(asset => asset.fresh).length
  const enoughRowsAssets = assets.filter(asset => asset.enoughRows).length
  const missingAssets = assets.filter(asset => !asset.present)
  const staleAssets = assets.filter(asset => asset.present && !asset.fresh)
  const insufficientRowsAssets = assets.filter(asset => asset.present && !asset.enoughRows)
  const nonMonotonicAssets = assets.filter(asset => asset.present && !asset.monotonic)
  const incubationCommonPeriodsRequired = input.timeframe === '1h'
    ? input.thresholds.minCommonPeriods1h
    : null
  const incubationCommonPeriodsReady = incubationCommonPeriodsRequired == null
    ? null
    : commonTimestamps.length >= incubationCommonPeriodsRequired
  const blockers = [
    ...missingAssets.map(asset => `missing_asset:${asset.paperSymbol}`),
    ...staleAssets.map(asset => `stale_asset:${asset.paperSymbol}:${asset.ageMs ?? 'unknown'}>${input.thresholds.maxAgeMsByTimeframe[input.timeframe]}`),
    ...insufficientRowsAssets.map(asset => `insufficient_rows:${asset.paperSymbol}:${asset.rowCount}<${input.thresholds.minRowsByTimeframe[input.timeframe]}`),
    ...nonMonotonicAssets.map(asset => `non_monotonic_timestamps:${asset.paperSymbol}`),
    ...(commonTimestamps.length === 0 ? ['common_periods_missing'] : []),
    ...(incubationCommonPeriodsReady === false
      ? [`common_periods_low:${commonTimestamps.length}<${incubationCommonPeriodsRequired}`]
      : []),
  ]
  const hardBlocked = missingAssets.length > 0 ||
    staleAssets.length > 0 ||
    insufficientRowsAssets.length > 0 ||
    nonMonotonicAssets.length > 0 ||
    commonTimestamps.length === 0
  const status: LiveDataStatus = hardBlocked
    ? 'blocked'
    : incubationCommonPeriodsReady === false
      ? 'degraded'
      : 'fresh'

  return {
    timeframe: input.timeframe,
    dataDir,
    expectedAssets: input.assets.length,
    presentAssets,
    freshAssets,
    enoughRowsAssets,
    status,
    minRowsRequired: input.thresholds.minRowsByTimeframe[input.timeframe],
    maxAgeMsAllowed: input.thresholds.maxAgeMsByTimeframe[input.timeframe],
    commonPeriods: commonTimestamps.length,
    commonLatestTimestamp,
    commonLatestDatetime: timestampToIso(commonLatestTimestamp),
    commonLatestAgeMs,
    incubationCommonPeriodsRequired,
    incubationCommonPeriodsReady,
    assets,
    blockers,
    nextActions: buildDirectoryNextActions(input.timeframe, blockers, commonTimestamps.length, incubationCommonPeriodsRequired),
  }
}

export function buildLiveDataFreshnessReport(input: {
  generatedAt: string
  thresholds: LiveDataFreshnessThresholds
  directories: LiveDataFreshnessDirectory[]
}): LiveDataFreshnessReport {
  const oneHour = input.directories.find(directory => directory.timeframe === '1h') ?? null
  const blockers = input.directories.flatMap(directory =>
    directory.blockers.map(blocker => `${directory.timeframe}:${blocker}`),
  )
  const status: LiveDataStatus = input.directories.some(directory => directory.status === 'blocked')
    ? 'blocked'
    : input.directories.some(directory => directory.status === 'degraded')
      ? 'degraded'
      : 'fresh'
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status,
    thresholds: input.thresholds,
    summary: {
      directoryCount: input.directories.length,
      expectedAssets: input.directories.reduce((sum, directory) => sum + directory.expectedAssets, 0),
      presentAssets: input.directories.reduce((sum, directory) => sum + directory.presentAssets, 0),
      freshAssets: input.directories.reduce((sum, directory) => sum + directory.freshAssets, 0),
      enoughRowsAssets: input.directories.reduce((sum, directory) => sum + directory.enoughRowsAssets, 0),
      oneHourCommonPeriods: oneHour?.commonPeriods ?? null,
      oneHourCommonLatestDatetime: oneHour?.commonLatestDatetime ?? null,
      oneHourIncubationCommonPeriodsReady: oneHour?.incubationCommonPeriodsReady === true,
      publicDataUsableForLiveOnlyResearch: oneHour != null && oneHour.status !== 'blocked',
    },
    directories: input.directories,
    blockers,
    globalNextActions: buildGlobalNextActions(status, oneHour),
    safetyNotes: [
      'This artifact audits public OKX market-data storage only; it cannot authorize paper or live orders.',
      'Fresh public data does not imply profitability. Strategy promotion still requires runtime fees, WFO, FDR, PIT, and paper evidence gates.',
      'Manual fee snapshots and private-auth failures remain outside this public-data audit.',
    ],
  }
}

function buildThresholds(args: CliArgs): LiveDataFreshnessThresholds {
  return {
    maxAgeMsByTimeframe: {
      '1h': args.maxAge1hMs,
      '5m': args.maxAge5mMs,
      '1s': args.maxAge1sMs,
    },
    minRowsByTimeframe: {
      '1h': args.minRows1h,
      '5m': args.minRows5m,
      '1s': args.minRows1s,
    },
    minCommonPeriods1h: args.minCommonPeriods1h,
  }
}

async function auditLiveDataAsset(input: AuditAssetInput & {
  timeframe: LiveDataTimeframe
  dataDir: string
  generatedAtMs: number
  minRows: number
  maxAgeMs: number
}): Promise<LiveDataFreshnessAssetWithTimestamps> {
  const filePath = join(input.dataDir, input.file)
  if (!existsSync(filePath)) {
    return {
      paperSymbol: input.paperSymbol,
      storageSymbol: input.storageSymbol,
      timeframe: input.timeframe,
      filePath,
      present: false,
      rawRows: 0,
      rowCount: 0,
      duplicateTimestampCount: 0,
      invalidTimestampRows: 0,
      monotonic: true,
      gapCount: 0,
      maxGapMs: null,
      firstTimestamp: null,
      firstDatetime: null,
      lastTimestamp: null,
      lastDatetime: null,
      ageMs: null,
      fresh: false,
      enoughRows: false,
      blockers: ['missing_file'],
      timestamps: [],
    }
  }
  const stats = parseCsvTimestampStats(await readFile(filePath, 'utf-8'))
  const firstTimestamp = stats.timestamps[0] ?? null
  const lastTimestamp = stats.timestamps[stats.timestamps.length - 1] ?? null
  const ageMs = lastTimestamp != null && Number.isFinite(input.generatedAtMs)
    ? Math.max(0, input.generatedAtMs - lastTimestamp)
    : null
  const fresh = ageMs != null && ageMs <= input.maxAgeMs
  const enoughRows = stats.timestamps.length >= input.minRows
  const gapStats = summarizeGaps(stats.timestamps, STEP_MS_BY_TIMEFRAME[input.timeframe])
  const blockers = [
    ...(stats.timestamps.length === 0 ? ['no_valid_rows'] : []),
    ...(fresh ? [] : [`stale:${ageMs ?? 'unknown'}>${input.maxAgeMs}`]),
    ...(enoughRows ? [] : [`insufficient_rows:${stats.timestamps.length}<${input.minRows}`]),
    ...(stats.monotonic ? [] : ['non_monotonic_timestamps']),
  ]

  return {
    paperSymbol: input.paperSymbol,
    storageSymbol: input.storageSymbol,
    timeframe: input.timeframe,
    filePath,
    present: true,
    rawRows: stats.rawRows,
    rowCount: stats.timestamps.length,
    duplicateTimestampCount: stats.duplicateTimestampCount,
    invalidTimestampRows: stats.invalidTimestampRows,
    monotonic: stats.monotonic,
    gapCount: gapStats.gapCount,
    maxGapMs: gapStats.maxGapMs,
    firstTimestamp,
    firstDatetime: timestampToIso(firstTimestamp),
    lastTimestamp,
    lastDatetime: timestampToIso(lastTimestamp),
    ageMs,
    fresh,
    enoughRows,
    blockers,
    timestamps: stats.timestamps,
  }
}

function parseCsvTimestampStats(csv: string): CsvTimestampStats {
  const lines = csv.trim().split('\n').filter(Boolean)
  const header = lines[0] ?? ''
  const timestampIndex = header.split(',').indexOf('timestamp')
  if (timestampIndex < 0) {
    return {
      rawRows: Math.max(0, lines.length - 1),
      timestamps: [],
      duplicateTimestampCount: 0,
      invalidTimestampRows: Math.max(0, lines.length - 1),
      monotonic: true,
    }
  }
  const seen = new Set<number>()
  let duplicateTimestampCount = 0
  let invalidTimestampRows = 0
  let previousRawTimestamp: number | null = null
  let monotonic = true

  for (const line of lines.slice(1)) {
    const columns = line.split(',')
    const timestamp = Number(columns[timestampIndex])
    if (!Number.isFinite(timestamp)) {
      invalidTimestampRows += 1
      continue
    }
    if (previousRawTimestamp != null && timestamp < previousRawTimestamp) {
      monotonic = false
    }
    previousRawTimestamp = timestamp
    if (seen.has(timestamp)) {
      duplicateTimestampCount += 1
      continue
    }
    seen.add(timestamp)
  }

  return {
    rawRows: Math.max(0, lines.length - 1),
    timestamps: [...seen].sort((left, right) => left - right),
    duplicateTimestampCount,
    invalidTimestampRows,
    monotonic,
  }
}

function summarizeGaps(timestamps: number[], expectedStepMs: number): { gapCount: number; maxGapMs: number | null } {
  let gapCount = 0
  let maxGapMs: number | null = null
  for (let index = 1; index < timestamps.length; index += 1) {
    const gap = timestamps[index] - timestamps[index - 1]
    if (gap > expectedStepMs * 1.5) {
      gapCount += 1
      maxGapMs = Math.max(maxGapMs ?? gap, gap)
    }
  }
  return { gapCount, maxGapMs }
}

function intersectTimestampSets(
  assets: Array<LiveDataFreshnessAssetWithTimestamps | null>,
): number[] {
  if (assets.some(asset => asset == null)) return []
  const timestampSets = assets
    .map(asset => asset?.timestamps ?? [])
    .filter(timestamps => timestamps.length > 0)
  if (timestampSets.length !== assets.length || timestampSets.length === 0) return []
  const sortedBySize = [...timestampSets].sort((left, right) => left.length - right.length)
  const rest = sortedBySize.slice(1).map(timestamps => new Set(timestamps))
  return sortedBySize[0].filter(timestamp => rest.every(set => set.has(timestamp)))
}

function stripInternalTimestamps(asset: LiveDataFreshnessAssetWithTimestamps): LiveDataFreshnessAsset {
  const { timestamps: _timestamps, ...publicAsset } = asset
  return publicAsset
}

function buildDirectoryNextActions(
  timeframe: LiveDataTimeframe,
  blockers: string[],
  commonPeriods: number,
  commonPeriodsRequired: number | null,
): string[] {
  if (blockers.length === 0) {
    return [`Keep scheduled ${timeframe} public-data accumulation running.`]
  }
  const actions = [
    timeframe === '1h'
      ? 'Run corepack pnpm data:accumulate hourly until the live-only 1h common window is promotion-grade.'
      : timeframe === '5m'
        ? 'Run corepack pnpm data:accumulate-5m on the scheduled 5-minute cadence.'
        : 'Run corepack pnpm data:accumulate-1s on the bounded second-level universe cadence.',
  ]
  if (commonPeriodsRequired != null && commonPeriods < commonPeriodsRequired) {
    actions.push(`Need ${commonPeriodsRequired - commonPeriods} more common 1h periods before the incubation common-period threshold passes.`)
  }
  return actions
}

function buildGlobalNextActions(status: LiveDataStatus, oneHour: LiveDataFreshnessDirectory | null): string[] {
  const actions = [
    'Keep OKX public market-data accumulation running; this path does not depend on private account credentials.',
    'Rerun rank-IC and route-cost diagnostics after fresh 1h accumulation so strategy evidence uses the latest stored public data.',
  ]
  if (status !== 'fresh') {
    actions.push('Do not promote or paper-trade from this artifact; it only identifies data readiness and warmup gaps.')
  }
  if (oneHour?.incubationCommonPeriodsReady === false && oneHour.incubationCommonPeriodsRequired != null) {
    actions.push(`Collect at least ${oneHour.incubationCommonPeriodsRequired - oneHour.commonPeriods} more common 1h periods for incubation readiness.`)
  }
  return actions
}

function timestampToIso(timestamp: number | null): string | null {
  return timestamp == null ? null : new Date(timestamp).toISOString()
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      out.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = argv[index + 1]
    if (next != null && !next.startsWith('--')) {
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
  if (raw == null) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`)
  }
  return parsed
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function renderConsoleSummary(report: LiveDataFreshnessReport): string {
  return [
    `live data freshness: status=${report.status}, publicResearchUsable=${report.summary.publicDataUsableForLiveOnlyResearch}`,
    `assets=${report.summary.presentAssets}/${report.summary.expectedAssets}, fresh=${report.summary.freshAssets}, rowsOk=${report.summary.enoughRowsAssets}`,
    `1h common=${report.summary.oneHourCommonPeriods ?? 'null'}, incubationReady=${report.summary.oneHourIncubationCommonPeriodsReady}`,
    ...report.directories.map(directory =>
      `${directory.timeframe}: status=${directory.status}, present=${directory.presentAssets}/${directory.expectedAssets}, fresh=${directory.freshAssets}, common=${directory.commonPeriods}, latest=${directory.commonLatestDatetime ?? 'null'}, blockers=${directory.blockers.slice(0, 5).join('|') || 'none'}`,
    ),
    ...report.globalNextActions.map(action => `next: ${action}`),
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('audit_live_data_freshness failed:', error)
    process.exit(1)
  })
}
