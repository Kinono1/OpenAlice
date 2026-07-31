import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireRuntimeLock } from '../src/runtime/runtime_lock.js'

type Timeframe = '1h' | '5m'
type Status = 'complete' | 'blocked_insufficient_data'

interface CliArgs {
  dataRoot: string
  outputPath: string
  rankPath: string
  paperDecisionPath: string
  gatePath: string
  notificationPath: string
  lockDir: string
  minSymbols1h: number
  minBars1h: number
  minSymbols5m: number
  minBars5m: number
  maxAgeMinutes1h: number
  maxAgeMinutes5m: number
  json: boolean
}

interface MarketCoverageFile {
  path: string
  symbol: string
  timeframe: Timeframe
  exchange: string | null
  bars: number
  firstEventTime: string | null
  lastEventTime: string | null
  ageMinutes: number | null
  sha256: string
}

export interface LowVolResearchReport {
  schemaVersion: 1
  generatedAt: string
  status: Status
  researchOnly: true
  paperShadowOnly: true
  liveTradingAllowed: false
  executionAllowed: false
  productionConfigMutationAllowed: false
  dataRoot: string
  externalDiskUsed: false
  coverage: {
    oneHour: CoverageSummary
    fiveMinute: CoverageSummary
    blockers: string[]
  }
  ranking: Array<{
    rank: number
    symbol: string
    annualizedVolatility: number
    lastPrice: number
    observations: number
    lastEventTime: string
  }>
  paperDecision: {
    status: Status
    action: 'paper_watch' | 'blocked'
    candidates: string[]
    executionRequested: false
  }
  promotionV2Gate: {
    status: 'research_only' | 'blocked'
    finalVerdict: string | null
    sourcePath: string
    promotionRequested: false
  }
  blockers: string[]
}

interface CoverageSummary {
  directory: string
  timeframe: Timeframe
  files: number
  symbolsWithMinimumBars: number
  requiredSymbols: number
  requiredBars: number
  newestEventTime: string | null
  newestAgeMinutes: number | null
  maxAgeMinutes: number
  filesDetail: MarketCoverageFile[]
}

interface ParsedCsv {
  symbol: string
  exchange: string | null
  rows: Array<{ timestamp: number; close: number }>
}

const DEFAULT_DATA_ROOT = 'data'

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const report = await runLowVolResearchDaily(args)
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.status === 'blocked_insufficient_data') process.exitCode = 2
}

export function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = resolve(raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT ?? DEFAULT_DATA_ROOT)
  return {
    dataRoot,
    outputPath: resolve(raw.get('outputPath') ?? join(dataRoot, 'research', 'low_vol_research_daily.latest.json')),
    rankPath: resolve(raw.get('rankPath') ?? join(dataRoot, 'research', 'daily_low_vol_rank_report.json')),
    paperDecisionPath: resolve(raw.get('paperDecisionPath') ?? join(dataRoot, 'runtime', 'low_vol_paper_decision.latest.json')),
    gatePath: resolve(raw.get('gatePath') ?? join(dataRoot, 'runtime', 'low_vol_strategy_gate_status.latest.json')),
    notificationPath: resolve(raw.get('notificationPath') ?? join(dataRoot, 'runtime', 'low_vol_research_daily_notification.json')),
    lockDir: resolve(raw.get('lockDir') ?? join(dataRoot, 'runtime', 'locks', 'low_vol_research_daily.lock')),
    minSymbols1h: positiveInt(raw.get('minSymbols1h'), 20),
    minBars1h: positiveInt(raw.get('minBars1h'), 24 * 21),
    minSymbols5m: positiveInt(raw.get('minSymbols5m'), 20),
    minBars5m: positiveInt(raw.get('minBars5m'), 12 * 24),
    maxAgeMinutes1h: positiveInt(raw.get('maxAgeMinutes1h'), 180),
    maxAgeMinutes5m: positiveInt(raw.get('maxAgeMinutes5m'), 30),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runLowVolResearchDaily(args: CliArgs, now = new Date()): Promise<LowVolResearchReport> {
  rejectExternalDiskDataRoot(args.dataRoot)
  const lock = acquireRuntimeLock(args.lockDir, {
    purpose: 'low_vol_research_daily',
    staleMs: 6 * 60 * 60 * 1000,
  })
  if (!lock) throw new Error(`low_vol_research_daily lock held: ${args.lockDir}`)

  try {
    const oneHourDir = join(args.dataRoot, 'market', 'live_accumulated')
    const fiveMinuteDir = join(args.dataRoot, 'market', 'live_5m')
    const oneHourFiles = await loadMarketCoverage(oneHourDir, '1h', now)
    const fiveMinuteFiles = await loadMarketCoverage(fiveMinuteDir, '5m', now)
    const oneHour = summarizeCoverage(oneHourDir, '1h', oneHourFiles, args.minSymbols1h, args.minBars1h, args.maxAgeMinutes1h)
    const fiveMinute = summarizeCoverage(fiveMinuteDir, '5m', fiveMinuteFiles, args.minSymbols5m, args.minBars5m, args.maxAgeMinutes5m)
    const blockers = coverageBlockers(oneHour, fiveMinute)
    const ranking = blockers.length === 0
      ? await buildLowVolRanking(oneHour.filesDetail.filter(file => file.bars >= args.minBars1h))
      : []
    const promotionSourcePath = join(args.dataRoot, 'runtime', 'strategy_promotion.latest.json')
    const promotion = await readJsonIfExists(promotionSourcePath)
    const finalVerdict = readString(promotion?.finalVerdict)
    const status: Status = blockers.length === 0 && ranking.length > 0
      ? 'complete'
      : 'blocked_insufficient_data'
    if (ranking.length === 0 && blockers.length === 0) blockers.push('low_vol_ranking_missing')

    const report: LowVolResearchReport = {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      status,
      researchOnly: true,
      paperShadowOnly: true,
      liveTradingAllowed: false,
      executionAllowed: false,
      productionConfigMutationAllowed: false,
      dataRoot: args.dataRoot,
      externalDiskUsed: false,
      coverage: { oneHour, fiveMinute, blockers: [...blockers] },
      ranking,
      paperDecision: {
        status,
        action: status === 'complete' ? 'paper_watch' : 'blocked',
        candidates: status === 'complete' ? ranking.slice(0, 10).map(item => item.symbol) : [],
        executionRequested: false,
      },
      promotionV2Gate: {
        status: status === 'complete' ? 'research_only' : 'blocked',
        finalVerdict,
        sourcePath: promotionSourcePath,
        promotionRequested: false,
      },
      blockers,
    }

    await Promise.all([
      atomicWriteJson(args.outputPath, report),
      atomicWriteJson(args.rankPath, buildRankArtifact(report)),
      atomicWriteJson(args.paperDecisionPath, buildPaperDecisionArtifact(report)),
      atomicWriteJson(args.gatePath, buildGateArtifact(report)),
      atomicWriteJson(args.notificationPath, buildNotification(report)),
    ])
    return report
  } finally {
    lock.release()
  }
}

function rejectExternalDiskDataRoot(dataRoot: string): void {
  if (resolve(dataRoot).startsWith('/Volumes/')) {
    throw new Error('runtime low-vol data root must be local; /Volumes is offline-only')
  }
}

async function loadMarketCoverage(directory: string, timeframe: Timeframe, now: Date): Promise<MarketCoverageFile[]> {
  const names = await readdir(directory).catch(() => [])
  const suffix = timeframe === '1h' ? '_1h.csv' : '_5m.csv'
  const files = names.filter(name => name.endsWith(suffix)).sort()
  return Promise.all(files.map(async name => {
    const path = join(directory, name)
    const raw = await readFile(path, 'utf-8')
    const parsed = parseMarketCsv(raw, name)
    const first = parsed.rows[0]?.timestamp ?? null
    const last = parsed.rows.at(-1)?.timestamp ?? null
    return {
      path,
      symbol: parsed.symbol,
      timeframe,
      exchange: parsed.exchange,
      bars: parsed.rows.length,
      firstEventTime: first == null ? null : new Date(first).toISOString(),
      lastEventTime: last == null ? null : new Date(last).toISOString(),
      ageMinutes: last == null ? null : Math.max(0, (now.getTime() - last) / 60_000),
      sha256: sha256(raw),
    }
  }))
}

function parseMarketCsv(raw: string, fileName: string): ParsedCsv {
  const rows: ParsedCsv['rows'] = []
  let symbol = canonicalSymbolFromFile(fileName)
  let exchange: string | null = null
  for (const line of raw.split('\n').slice(1)) {
    if (!line.trim()) continue
    const columns = line.split(',')
    const timestamp = Number(columns[0])
    const close = Number(columns[5])
    if (!Number.isFinite(timestamp) || !Number.isFinite(close) || close <= 0) continue
    symbol = canonicalSymbol(columns[7] ?? symbol)
    exchange = columns[9]?.trim() || exchange
    rows.push({ timestamp, close })
  }
  rows.sort((left, right) => left.timestamp - right.timestamp)
  return { symbol, exchange, rows }
}

function summarizeCoverage(
  directory: string,
  timeframe: Timeframe,
  filesDetail: MarketCoverageFile[],
  requiredSymbols: number,
  requiredBars: number,
  maxAgeMinutes: number,
): CoverageSummary {
  const newest = filesDetail
    .filter(file => file.lastEventTime)
    .sort((left, right) => String(right.lastEventTime).localeCompare(String(left.lastEventTime)))[0]
  return {
    directory,
    timeframe,
    files: filesDetail.length,
    symbolsWithMinimumBars: filesDetail.filter(file => file.bars >= requiredBars).length,
    requiredSymbols,
    requiredBars,
    newestEventTime: newest?.lastEventTime ?? null,
    newestAgeMinutes: newest?.ageMinutes ?? null,
    maxAgeMinutes,
    filesDetail,
  }
}

function coverageBlockers(oneHour: CoverageSummary, fiveMinute: CoverageSummary): string[] {
  const blockers: string[] = []
  if (oneHour.symbolsWithMinimumBars < oneHour.requiredSymbols) {
    blockers.push(`one_hour_coverage_insufficient:${oneHour.symbolsWithMinimumBars}/${oneHour.requiredSymbols}`)
  }
  if (fiveMinute.symbolsWithMinimumBars < fiveMinute.requiredSymbols) {
    blockers.push(`five_minute_coverage_insufficient:${fiveMinute.symbolsWithMinimumBars}/${fiveMinute.requiredSymbols}`)
  }
  if (oneHour.newestAgeMinutes == null || oneHour.newestAgeMinutes > oneHour.maxAgeMinutes) {
    blockers.push(`one_hour_data_stale:${oneHour.newestAgeMinutes ?? 'missing'}`)
  }
  if (fiveMinute.newestAgeMinutes == null || fiveMinute.newestAgeMinutes > fiveMinute.maxAgeMinutes) {
    blockers.push(`five_minute_data_stale:${fiveMinute.newestAgeMinutes ?? 'missing'}`)
  }
  return blockers
}

async function buildLowVolRanking(files: MarketCoverageFile[]) {
  const rows = await Promise.all(files.map(async file => {
    const parsed = parseMarketCsv(await readFile(file.path, 'utf-8'), basename(file.path))
    const closes = parsed.rows.map(row => row.close)
    const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index]!))
    return {
      symbol: parsed.symbol,
      annualizedVolatility: standardDeviation(returns) * Math.sqrt(24 * 365),
      lastPrice: closes.at(-1) ?? 0,
      observations: returns.length,
      lastEventTime: file.lastEventTime ?? '',
    }
  }))
  return rows
    .filter(row => Number.isFinite(row.annualizedVolatility) && row.observations > 0)
    .sort((left, right) => left.annualizedVolatility - right.annualizedVolatility)
    .map((row, index) => ({ rank: index + 1, ...row }))
}

function buildRankArtifact(report: LowVolResearchReport) {
  return {
    schemaVersion: 2,
    status: report.status,
    generated_at: report.generatedAt,
    date: report.generatedAt.slice(0, 10),
    source: 'canonical_okx_local_1h_5m',
    researchOnly: true,
    executionAllowed: false,
    n_mainstream_symbols: report.coverage.oneHour.files,
    n_symbols_with_data: report.coverage.oneHour.symbolsWithMinimumBars,
    buy_candidates: report.status === 'complete'
      ? report.ranking.slice(0, 10).map(item => ({ symbol: item.symbol, vol_21d: item.annualizedVolatility, price: item.lastPrice }))
      : [],
    avoid: report.status === 'complete'
      ? report.ranking.slice(-10).reverse().map(item => ({ symbol: item.symbol, vol_21d: item.annualizedVolatility, price: item.lastPrice }))
      : [],
    blockers: report.blockers,
  }
}

function buildPaperDecisionArtifact(report: LowVolResearchReport) {
  return {
    schemaVersion: 3,
    generatedAt: report.generatedAt,
    status: report.status,
    researchOnly: true,
    paperShadowOnly: true,
    executionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    signals: report.status === 'complete'
      ? report.ranking.slice(0, 10).map(item => ({ symbol: item.symbol, direction: 'long', confidence: 0.5, reason: 'low_vol_research_rank' }))
      : [],
    executionRequested: false,
    blockers: report.blockers,
    sourceReportPath: report.dataRoot,
  }
}

function buildGateArtifact(report: LowVolResearchReport) {
  return {
    schemaVersion: 2,
    generatedAt: report.generatedAt,
    status: report.status === 'complete' ? 'research_only' : 'blocked_insufficient_data',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    productionConfigMutationAllowed: false,
    promotionV2: report.promotionV2Gate,
    blockers: report.blockers,
  }
}

function buildNotification(report: LowVolResearchReport) {
  const blocked = report.status !== 'complete'
  return {
    shouldNotify: blocked,
    deliveryDecision: blocked ? 'notify' : 'skip',
    headline: blocked ? 'low-vol research blocked by data coverage' : 'low-vol research daily completed',
    content: blocked
      ? `status=${report.status} blockers=${report.blockers.join('|') || 'none'} oneHour=${report.coverage.oneHour.symbolsWithMinimumBars}/${report.coverage.oneHour.requiredSymbols} fiveMinute=${report.coverage.fiveMinute.symbolsWithMinimumBars}/${report.coverage.fiveMinute.requiredSymbols}`
      : `status=complete candidates=${report.paperDecision.candidates.join(',')} source=canonical_okx_local promotionRequested=false executionRequested=false`,
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  await rename(tempPath, path)
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(await readFile(path, 'utf-8')) as unknown
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return Number.NaN
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function canonicalSymbol(raw: string): string {
  const value = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (value.endsWith('USDTUSDT')) return value.slice(0, -4)
  return value
}

function canonicalSymbolFromFile(fileName: string): string {
  return canonicalSymbol(fileName.replace(/_(?:1h|5m)\.csv$/i, ''))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) out.set(key, 'true')
    else {
      out.set(key, next)
      index += 1
    }
  }
  return out
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw.trim().toLowerCase())
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
