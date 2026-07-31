import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

type DailySupplementStatus =
  | 'blocked_missing_ohlcv_rebuild_plan'
  | 'blocked_no_missing_month_tasks'
  | 'planned_research_only_daily_supplement'
  | 'partial_daily_supplement_research_only'
  | 'ready_daily_supplement_research_only'

type DailyLocalStatus = 'exists' | 'downloaded' | 'missing' | 'not_checked' | 'failed'

interface CliArgs {
  planPath: string
  outputPath: string | null
  manifestPath: string | null
  warehouseRoot: string
  probe: boolean
  download: boolean
  maxTasks: number
  maxEntries: number
  concurrency: number
  connectTimeoutSec: number
  probeMaxTimeSec: number
  downloadMaxTimeSec: number
  proxy?: string
  networkInterface?: string
  json: boolean
}

export interface DailySupplementManifestRecord {
  schemaVersion: 'openalice.ai_scientist.ohlcv_daily_supplement_manifest.v1'
  generatedAt: string
  jobId: string
  collectionRunId: string
  researchOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  exchange: 'binance'
  market: 'usdm'
  dataType: 'klines'
  cadence: 'daily'
  symbol: string
  timeframe: string
  day: string
  month: string
  key: string
  url: string
  zipPath: string
  localStatus: DailyLocalStatus
  httpStatus: number | null
  error: string | null
  observedAt: string
  fetchedAt: string | null
  availableAt: string | null
  sourceEndpoint: 'https://data.binance.vision'
  sourcePath: string
  sourceManifestId: string
  sourceRowHash: string
  sourceRowHashScope: 'archive_manifest_record'
  lineageScope: 'archive_file'
  pitSuitability: 'daily_archive_download_lineage_only_not_row_pit'
  rowPITUsableForPromotion: false
  quality: {
    promotionGrade: false
    blockers: string[]
  }
}

export interface AiScientistOhlcvDailySupplementPlanReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: DailySupplementStatus
  sourceArtifacts: {
    ohlcvNativeRebuildPlan: string
    warehouseRoot: string
    manifest: string | null
  }
  mode: {
    probe: boolean
    download: boolean
    maxTasks: number
    maxEntries: number
    concurrency: number
  }
  counts: {
    taskPlansRead: number
    tasksWithMissingMonthlyArchive: number
    uniqueSupplementEntries: number
    localExists: number
    downloaded: number
    remoteAvailable: number
    remoteMissing: number
    failed: number
    notChecked: number
    manifestRowsWritten: number
    distinctSymbols: number
    distinctDays: number
  }
  taskPlans: Array<{
    taskId: string
    rawSymbol: string | null
    binanceSymbol: string | null
    symbol: string | null
    timeframe: string | null
    missingArchiveMonths: string[]
    supplementDays: string[]
    supplementZipPaths: string[]
    supplementComplete: boolean
    blockers: string[]
  }>
  manifestRows: DailySupplementManifestRecord[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_PLAN_PATH = 'data/research/ai_scientist_openalice_ohlcv_native_rebuild_plan.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/ai_scientist_openalice_ohlcv_daily_supplement_plan.latest.json'
const DEFAULT_WAREHOUSE_ROOT = 'data'
const DEFAULT_JOB_ID = 'ai_scientist_openalice_ohlcv_daily_supplement_plan'

async function main(): Promise<void> {
  const args = parseAiScientistOhlcvDailySupplementPlanArgs(process.argv.slice(2))
  const report = await runAiScientistOhlcvDailySupplementPlan(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseAiScientistOhlcvDailySupplementPlanArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const warehouseRoot = raw.get('warehouseRoot') ?? raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT ?? DEFAULT_WAREHOUSE_ROOT
  const timeframe = raw.get('timeframe') ?? '1h'
  const defaultManifestPath = resolve(
    warehouseRoot,
    'market/binance-public',
    `um-daily-usdt-klines-${timeframe}`,
    'manifest.ai-scientist-daily-supplement.jsonl',
  )
  return {
    planPath: raw.get('planPath') ?? raw.get('ohlcvPlanPath') ?? DEFAULT_PLAN_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    manifestPath: parseNullablePath(raw.get('manifestPath') ?? raw.get('manifest') ?? defaultManifestPath),
    warehouseRoot,
    probe: parseBool(raw.get('probe'), false),
    download: parseBool(raw.get('download'), false),
    maxTasks: parseNonNegativeInteger(raw.get('maxTasks'), 500),
    maxEntries: parseNonNegativeInteger(raw.get('maxEntries'), 0),
    concurrency: parsePositiveInteger(raw.get('concurrency'), 4),
    connectTimeoutSec: parsePositiveInteger(raw.get('connectTimeoutSec'), 10),
    probeMaxTimeSec: parsePositiveInteger(raw.get('probeMaxTimeSec'), 20),
    downloadMaxTimeSec: parsePositiveInteger(raw.get('downloadMaxTimeSec'), 60),
    proxy: parseProxy(raw.get('proxy')),
    networkInterface: parseInterface(raw.get('interface') ?? process.env.BINANCE_BACKFILL_INTERFACE ?? 'en0'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAiScientistOhlcvDailySupplementPlan(
  args: CliArgs,
): Promise<AiScientistOhlcvDailySupplementPlanReport> {
  const startedAt = new Date()
  const generatedAt = new Date().toISOString()
  const planPath = resolve(args.planPath)
  const warehouseRoot = resolve(args.warehouseRoot)
  const plan = asRecord(await readJsonIfExists(planPath))
  const report = await buildAiScientistOhlcvDailySupplementPlanReport({
    generatedAt,
    planPath,
    warehouseRoot,
    manifestPath: args.manifestPath ? resolve(args.manifestPath) : null,
    plan,
    args,
  })

  if (args.manifestPath) {
    const manifestPath = resolve(args.manifestPath)
    await atomicWrite(
      manifestPath,
      report.manifestRows.map(row => JSON.stringify(row)).join('\n') + (report.manifestRows.length > 0 ? '\n' : ''),
    )
    await writeEvidenceManifestForArtifact({
      job: DEFAULT_JOB_ID,
      artifactPath: manifestPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'blocked_missing_ohlcv_rebuild_plan' ? 1 : 0,
      businessStatus: report.status === 'ready_daily_supplement_research_only' ? 'warn' : 'fail',
      recordsIn: report.counts.uniqueSupplementEntries,
      recordsOut: report.counts.manifestRowsWritten,
      errorClass: report.blockers[0] ?? null,
    })
  }

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await atomicWrite(outputPath, `${JSON.stringify(report, null, 2)}\n`)
    await writeEvidenceManifestForArtifact({
      job: `${DEFAULT_JOB_ID}_report`,
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'blocked_missing_ohlcv_rebuild_plan' ? 1 : 0,
      businessStatus: report.status === 'ready_daily_supplement_research_only' ? 'warn' : 'fail',
      recordsIn: report.counts.taskPlansRead,
      recordsOut: report.counts.uniqueSupplementEntries,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export async function buildAiScientistOhlcvDailySupplementPlanReport(input: {
  generatedAt: string
  planPath: string
  warehouseRoot: string
  manifestPath: string | null
  plan: UnknownRecord | null
  args: Pick<CliArgs, 'probe' | 'download' | 'maxTasks' | 'maxEntries' | 'concurrency' | 'connectTimeoutSec' | 'probeMaxTimeSec' | 'downloadMaxTimeSec' | 'proxy' | 'networkInterface'>
}): Promise<AiScientistOhlcvDailySupplementPlanReport> {
  const taskPlans = readRecordArray(input.plan?.taskPlans)
    .filter(task => readStringArray(task.missingArchiveMonths).length > 0)
    .slice(0, input.args.maxTasks > 0 ? input.args.maxTasks : undefined)
  const generatedAt = input.generatedAt
  const collectionRunId = `${DEFAULT_JOB_ID}:${sha256Hex(`${input.planPath}\n${generatedAt}`).slice(0, 20)}`
  const taskReports = taskPlans.map(task => buildTaskDailySupplementPlan({
    task,
    warehouseRoot: input.warehouseRoot,
  }))
  const uniqueEntries = uniqueBy(
    taskReports.flatMap(task => task.entries),
    entry => `${entry.symbol}\n${entry.timeframe}\n${entry.day}`,
  ).slice(0, input.args.maxEntries > 0 ? input.args.maxEntries : undefined)
  const manifestRows = await withConcurrency(uniqueEntries, input.args.concurrency, entry => buildManifestRow({
    entry,
    generatedAt,
    collectionRunId,
    args: input.args,
  }))
  const manifestByPath = new Map(manifestRows.map(row => [row.zipPath, row]))
  const enrichedTasks = taskReports.map(task => {
    const rowStatuses = task.entries.map(entry => manifestByPath.get(entry.zipPath)).filter((row): row is DailySupplementManifestRecord => row != null)
    const supplementComplete = rowStatuses.length === task.entries.length &&
      rowStatuses.length > 0 &&
      rowStatuses.every(row => row.localStatus === 'exists' || row.localStatus === 'downloaded')
    return {
      taskId: task.taskId,
      rawSymbol: task.rawSymbol,
      binanceSymbol: task.binanceSymbol,
      symbol: task.symbol,
      timeframe: task.timeframe,
      missingArchiveMonths: task.missingArchiveMonths,
      supplementDays: task.entries.map(entry => entry.day),
      supplementZipPaths: task.entries.map(entry => entry.zipPath),
      supplementComplete,
      blockers: uniqueStrings([
        ...task.blockers,
        ...(supplementComplete ? [] : ['daily_supplement_not_fully_local']),
        'daily_supplement_research_only',
        'daily_supplement_not_promotion_grade',
      ]),
    }
  })
  const localExists = manifestRows.filter(row => row.localStatus === 'exists').length
  const downloaded = manifestRows.filter(row => row.localStatus === 'downloaded').length
  const remoteAvailable = manifestRows.filter(row => row.httpStatus != null && row.httpStatus >= 200 && row.httpStatus < 300).length
  const remoteMissing = manifestRows.filter(row => row.httpStatus === 404).length
  const failed = manifestRows.filter(row => row.localStatus === 'failed').length
  const notChecked = manifestRows.filter(row => row.localStatus === 'not_checked').length
  const allLocal = uniqueEntries.length > 0 && manifestRows.every(row => row.localStatus === 'exists' || row.localStatus === 'downloaded')
  const blockers = uniqueStrings([
    ...(input.plan ? [] : ['ai_scientist_ohlcv_native_rebuild_plan_missing']),
    ...(input.plan && taskPlans.length === 0 ? ['ai_scientist_ohlcv_missing_archive_tasks_absent'] : []),
    ...(uniqueEntries.length > 0 ? [] : ['daily_supplement_entries_missing']),
    ...(input.args.probe || input.args.download ? [] : ['daily_supplement_probe_not_run']),
    ...(notChecked === 0 ? [] : [`daily_supplement_not_checked:${notChecked}`]),
    ...(remoteMissing === 0 ? [] : [`daily_supplement_remote_missing:${remoteMissing}`]),
    ...(failed === 0 ? [] : [`daily_supplement_failed:${failed}`]),
    ...(allLocal || uniqueEntries.length === 0 ? [] : [`daily_supplement_local_incomplete:${localExists + downloaded}/${uniqueEntries.length}`]),
    'daily_supplement_research_only',
    'daily_supplement_not_promotion_grade',
  ])
  const status: DailySupplementStatus = !input.plan
    ? 'blocked_missing_ohlcv_rebuild_plan'
    : taskPlans.length === 0
      ? 'blocked_no_missing_month_tasks'
      : allLocal
        ? 'ready_daily_supplement_research_only'
        : input.args.probe || input.args.download
          ? 'partial_daily_supplement_research_only'
          : 'planned_research_only_daily_supplement'

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
      ohlcvNativeRebuildPlan: resolve(input.planPath),
      warehouseRoot: resolve(input.warehouseRoot),
      manifest: input.manifestPath,
    },
    mode: {
      probe: input.args.probe,
      download: input.args.download,
      maxTasks: input.args.maxTasks,
      maxEntries: input.args.maxEntries,
      concurrency: input.args.concurrency,
    },
    counts: {
      taskPlansRead: readRecordArray(input.plan?.taskPlans).length,
      tasksWithMissingMonthlyArchive: taskPlans.length,
      uniqueSupplementEntries: uniqueEntries.length,
      localExists,
      downloaded,
      remoteAvailable,
      remoteMissing,
      failed,
      notChecked,
      manifestRowsWritten: manifestRows.length,
      distinctSymbols: uniqueStrings(uniqueEntries.map(entry => entry.symbol)).length,
      distinctDays: uniqueStrings(uniqueEntries.map(entry => entry.day)).length,
    },
    taskPlans: enrichedTasks,
    manifestRows,
    blockers,
    nextActions: [
      'Run with --probe true to verify Binance Data Vision daily zip availability for current-month gaps.',
      'Run with --download true only for public daily zip files needed to reproduce AI-Scientist OHLCV inputs.',
      'Keep daily supplement rows research-only; do not treat daily archive download time as historical decision-time availability.',
      'After local daily zips exist, materialize research-only rows and rerun PIT contract, goal audit, and reason-chain.',
    ],
    safetyNotes: [
      'This daily supplement cannot authorize paper orders, live orders, promotion, leverage changes, best_config mutation, or non-flat target publication.',
      'Daily Data Vision archives are archive-file lineage only, not row-level promotion-grade PIT evidence.',
      'No API key, secret, passphrase, account endpoint, or order target is read or emitted.',
    ],
  }
}

function buildTaskDailySupplementPlan(input: { task: UnknownRecord; warehouseRoot: string }): {
  taskId: string
  rawSymbol: string | null
  binanceSymbol: string | null
  symbol: string | null
  timeframe: string | null
  missingArchiveMonths: string[]
  entries: Array<{
    symbol: string
    timeframe: string
    day: string
    month: string
    key: string
    url: string
    zipPath: string
  }>
  blockers: string[]
} {
  const taskId = readString(input.task.taskId) ?? `daily_supplement.${sha256Hex(JSON.stringify(input.task)).slice(0, 16)}`
  const rawSymbol = readString(input.task.rawSymbol)
  const binanceSymbol = readString(input.task.binanceSymbol) ?? rawSymbolToBinanceSymbol(rawSymbol)
  const timeframe = readString(input.task.timeframe) ?? '1h'
  const sourceStartMs = parseIsoMs(readString(input.task.sourceStartTime))
  const sourceEndMs = parseIsoMs(readString(input.task.sourceEndTime))
  const missingArchiveMonths = readStringArray(input.task.missingArchiveMonths)
  const entries = binanceSymbol && sourceStartMs != null && sourceEndMs != null
    ? missingArchiveMonths.flatMap(month => buildDailyEntriesForMonth({
        warehouseRoot: input.warehouseRoot,
        symbol: binanceSymbol,
        timeframe,
        month,
        sourceStartMs,
        sourceEndMs,
      }))
    : []
  return {
    taskId,
    rawSymbol,
    binanceSymbol,
    symbol: readString(input.task.symbol),
    timeframe,
    missingArchiveMonths,
    entries,
    blockers: uniqueStrings([
      ...(binanceSymbol ? [] : [`binance_symbol_unresolved:${rawSymbol ?? 'missing'}`]),
      ...(sourceStartMs != null ? [] : ['source_start_time_missing']),
      ...(sourceEndMs != null ? [] : ['source_end_time_missing']),
      ...(entries.length > 0 ? [] : ['daily_supplement_days_missing']),
    ]),
  }
}

function buildDailyEntriesForMonth(input: {
  warehouseRoot: string
  symbol: string
  timeframe: string
  month: string
  sourceStartMs: number
  sourceEndMs: number
}): Array<{ symbol: string; timeframe: string; day: string; month: string; key: string; url: string; zipPath: string }> {
  const monthStart = Date.parse(`${input.month}-01T00:00:00.000Z`)
  if (!Number.isFinite(monthStart)) return []
  const monthEnd = Date.UTC(Number(input.month.slice(0, 4)), Number(input.month.slice(5, 7)), 0, 23, 59, 59, 999)
  const start = floorUtcDay(Math.max(monthStart, input.sourceStartMs))
  const end = floorUtcDay(Math.min(monthEnd, input.sourceEndMs))
  const out: Array<{ symbol: string; timeframe: string; day: string; month: string; key: string; url: string; zipPath: string }> = []
  for (let value = start; value <= end; value += 24 * 60 * 60 * 1000) {
    const day = new Date(value).toISOString().slice(0, 10)
    const key = `data/futures/um/daily/klines/${input.symbol}/${input.timeframe}/${input.symbol}-${input.timeframe}-${day}.zip`
    out.push({
      symbol: input.symbol,
      timeframe: input.timeframe,
      day,
      month: input.month,
      key,
      url: `https://data.binance.vision/${key.split('/').map(encodeURIComponent).join('/')}`,
      zipPath: resolve(
        input.warehouseRoot,
        'market/binance-public',
        `um-daily-usdt-klines-${input.timeframe}`,
        'um',
        input.symbol,
        input.timeframe,
        `${input.symbol}-${input.timeframe}-${day}.zip`,
      ),
    })
  }
  return out
}

async function buildManifestRow(input: {
  entry: {
    symbol: string
    timeframe: string
    day: string
    month: string
    key: string
    url: string
    zipPath: string
  }
  generatedAt: string
  collectionRunId: string
  args: Pick<CliArgs, 'probe' | 'download' | 'connectTimeoutSec' | 'probeMaxTimeSec' | 'downloadMaxTimeSec' | 'proxy' | 'networkInterface'>
}): Promise<DailySupplementManifestRecord> {
  const localExistsBefore = await nonEmptyFileExists(input.entry.zipPath)
  let localStatus: DailyLocalStatus = localExistsBefore ? 'exists' : 'not_checked'
  let httpStatus: number | null = null
  let error: string | null = null
  let fetchedAt: string | null = localExistsBefore ? input.generatedAt : null

  if (!localExistsBefore && (input.args.probe || input.args.download)) {
    try {
      httpStatus = await curlHeadStatus(input.args, input.entry.url)
      if (httpStatus === 404) localStatus = 'missing'
      else if (httpStatus < 200 || httpStatus >= 300) localStatus = 'failed'
    } catch (err) {
      localStatus = 'failed'
      error = err instanceof Error ? err.message : String(err)
    }
  }

  if (!localExistsBefore && input.args.download && httpStatus != null && httpStatus >= 200 && httpStatus < 300) {
    try {
      await downloadUrl(input.args, input.entry.url, input.entry.zipPath)
      localStatus = 'downloaded'
      fetchedAt = input.generatedAt
    } catch (err) {
      localStatus = 'failed'
      error = err instanceof Error ? err.message : String(err)
    }
  }

  const availableAt = localStatus === 'exists' || localStatus === 'downloaded' ? input.generatedAt : null
  const sourceManifestId = [
    'binance_data_vision_daily_supplement',
    'um',
    'klines',
    input.entry.symbol,
    input.entry.timeframe,
    input.entry.day,
    sha256Hex(input.entry.key).slice(0, 16),
  ].join(':')
  const qualityBlockers = uniqueStrings([
    'daily_archive_lineage_only_not_row_pit',
    'daily_supplement_research_only',
    'row_pit_usable_for_promotion_false',
    ...(availableAt ? ['archive_available_at_not_historical_decision_available_at'] : ['daily_archive_not_local']),
  ])
  const rowWithoutHash = {
    schemaVersion: 'openalice.ai_scientist.ohlcv_daily_supplement_manifest.v1' as const,
    generatedAt: input.generatedAt,
    jobId: DEFAULT_JOB_ID,
    collectionRunId: input.collectionRunId,
    researchOnly: true as const,
    promotionEligible: false as const,
    paperTradingAllowed: false as const,
    liveTradingAllowed: false as const,
    executionAllowed: false as const,
    exchange: 'binance' as const,
    market: 'usdm' as const,
    dataType: 'klines' as const,
    cadence: 'daily' as const,
    symbol: input.entry.symbol,
    timeframe: input.entry.timeframe,
    day: input.entry.day,
    month: input.entry.month,
    key: input.entry.key,
    url: input.entry.url,
    zipPath: input.entry.zipPath,
    localStatus,
    httpStatus,
    error,
    observedAt: input.generatedAt,
    fetchedAt,
    availableAt,
    sourceEndpoint: 'https://data.binance.vision' as const,
    sourcePath: input.entry.key,
    sourceManifestId,
    sourceRowHash: '',
    sourceRowHashScope: 'archive_manifest_record' as const,
    lineageScope: 'archive_file' as const,
    pitSuitability: 'daily_archive_download_lineage_only_not_row_pit' as const,
    rowPITUsableForPromotion: false as const,
    quality: {
      promotionGrade: false as const,
      blockers: qualityBlockers,
    },
  }
  return {
    ...rowWithoutHash,
    sourceRowHash: stableHash({
      ...rowWithoutHash,
      sourceRowHash: undefined,
    }),
  }
}

async function curlHeadStatus(
  args: Pick<CliArgs, 'connectTimeoutSec' | 'probeMaxTimeSec' | 'proxy' | 'networkInterface'>,
  url: string,
): Promise<number> {
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const proc = spawn('curl', [
      '-L',
      '--head',
      '--silent',
      '--show-error',
      '--connect-timeout',
      String(args.connectTimeoutSec),
      '--max-time',
      String(args.probeMaxTimeSec),
      ...(args.proxy ? ['--proxy', args.proxy] : ['--noproxy', '*']),
      ...(args.networkInterface ? ['--interface', args.networkInterface] : []),
      '--output',
      '/dev/null',
      '--write-out',
      '%{http_code}',
      url,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: scrubProxyEnv(process.env),
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', chunk => { stdout += String(chunk) })
    proc.stderr.on('data', chunk => { stderr += String(chunk) })
    proc.on('error', rejectPromise)
    proc.on('close', code => {
      const status = Number(stdout.trim())
      if (code === 0 && Number.isInteger(status)) resolvePromise(status)
      else rejectPromise(new Error(`curl head failed code=${code} http=${stdout.trim() || 'unknown'} ${stderr.trim()}`))
    })
  })
}

async function downloadUrl(
  args: Pick<CliArgs, 'connectTimeoutSec' | 'downloadMaxTimeSec' | 'proxy' | 'networkInterface'>,
  url: string,
  outputPath: string,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true })
  const tmpPath = `${outputPath}.${process.pid}.part`
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const proc = spawn('curl', [
      '-L',
      '--silent',
      '--show-error',
      '--connect-timeout',
      String(args.connectTimeoutSec),
      '--max-time',
      String(args.downloadMaxTimeSec),
      ...(args.proxy ? ['--proxy', args.proxy] : ['--noproxy', '*']),
      ...(args.networkInterface ? ['--interface', args.networkInterface] : []),
      '--output',
      tmpPath,
      '--write-out',
      '%{http_code}',
      url,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: scrubProxyEnv(process.env),
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', chunk => { stdout += String(chunk) })
    proc.stderr.on('data', chunk => { stderr += String(chunk) })
    proc.on('error', rejectPromise)
    proc.on('close', code => {
      const status = Number(stdout.trim())
      if (code === 0 && status >= 200 && status < 300) resolvePromise()
      else rejectPromise(new Error(`curl download failed code=${code} http=${stdout.trim() || 'unknown'} ${stderr.trim()}`))
    })
  }).catch(async error => {
    await unlink(tmpPath).catch(() => {})
    throw error
  })
  await rename(tmpPath, outputPath)
}

async function nonEmptyFileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const outputPath = resolve(path)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, content, 'utf-8')
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null
  }
}

async function withConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  async function run(): Promise<void> {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      out[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, run))
  return out
}

function scrubProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next == null || next.startsWith('--')) {
      out.set(key, 'true')
    } else {
      out.set(key, next)
      index += 1
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : resolve(value)
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value == null ? fallback : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = value == null ? fallback : Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function parseProxy(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  if (!normalized || ['0', 'false', 'no', 'none', 'direct', 'off', 'true'].includes(normalized)) return undefined
  return raw.trim()
}

function parseInterface(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  if (!normalized || ['0', 'false', 'no', 'none', 'direct', 'off'].includes(normalized)) return undefined
  return raw.trim()
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is UnknownRecord => item != null) : []
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
}

function parseIsoMs(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function rawSymbolToBinanceSymbol(rawSymbol: string | null): string | null {
  if (!rawSymbol) return null
  const parts = rawSymbol.split('_')
  if (parts.length < 2) return rawSymbol.replace(/_/g, '')
  return `${parts[0]}${parts[1]}`
}

function floorUtcDay(value: number): number {
  const date = new Date(value)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function uniqueBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))].sort()
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function stableHash(value: unknown): string {
  return sha256Hex(stableJson(value))
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: AiScientistOhlcvDailySupplementPlanReport): string {
  return [
    `AI-Scientist OHLCV daily supplement: ${report.status}`,
    `entries=${report.counts.uniqueSupplementEntries} local=${report.counts.localExists + report.counts.downloaded}/${report.counts.uniqueSupplementEntries} downloaded=${report.counts.downloaded} remoteAvailable=${report.counts.remoteAvailable} missing=${report.counts.remoteMissing} failed=${report.counts.failed}`,
    `tasks=${report.counts.tasksWithMissingMonthlyArchive}/${report.counts.taskPlansRead} symbols=${report.counts.distinctSymbols} days=${report.counts.distinctDays}`,
    'paper=false live=false promotion=false execution=false',
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
