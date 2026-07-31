import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProxyAgent, request } from 'undici'
import { resolveProxyUrl } from '../src/domain/market-data/live-fetcher.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type BookLevel = [string, string, string, string]

interface CliArgs {
  symbols: string[]
  outputPath: string
  reportPath: string | null
  host: string
  depth: number
  timeoutMs: number
  retryAttempts: number
  retryDelayMs: number
  dryRun: boolean
  json: boolean
}

interface SnapshotInput {
  symbol: string
  instId: string
  fetchedAt: string
  observedAt: string
  availableAt: string
  jobId: string
  reportPath: string
  manifestPath: string
  book: UnknownRecord
  depth: number
}

export interface OkxOrderbookSpreadRow {
  schemaVersion: 'openalice.orderbook_spread_snapshot.v1'
  eventTime: string
  eventTimeMs: number
  exchange: 'okx'
  market: 'swap'
  symbol: string
  endpointId: 'okxOrderbookSpreadSnapshot'
  sourceEndpoint: '/api/v5/market/books'
  sourceTimestamp: string
  sourceTimestampMs: number
  sourceTimestampBasis: 'exchange_book_ts'
  fetchedAt: string
  observedAt: string
  availableAt: string
  ingestedAt: string
  jobId: string
  generatedAt: string
  lineageStatus: 'explicit_row_lineage'
  dedupKey: string
  rawPayloadHash: string
  collectionRunId: string
  reportPath: string
  manifestPath: string
  normalizedPayloadHash: string
  quality: {
    status: 'pass' | 'blocked'
    blockers: string[]
  }
  fields: {
    symbol: string
    instId: string
    bestBid: number
    bestAsk: number
    midPrice: number
    spreadAbs: number
    spreadBps: number
    bidSizeTop: number
    askSizeTop: number
    bidNotionalTop: number
    askNotionalTop: number
    bidNotionalDepth1: number
    askNotionalDepth1: number
    bidNotionalDepth5: number
    askNotionalDepth5: number
    bidNotionalDepth10: number
    askNotionalDepth10: number
    imbalanceTop: number
    imbalanceDepth5: number
    depthLevelsReturned: number
    requestedDepth: number
    sourceBookTs: number
  }
}

export interface OkxOrderbookSpreadQualityBySymbol {
  symbol: string
  status: 'pass' | 'blocked'
  blockers: string[]
  spreadBps: number
  depth5Usd: number
  bidNotionalDepth5: number
  askNotionalDepth5: number
  availableAt: string
  eventTime: string
}

export interface OkxOrderbookSpreadSnapshotReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  dryRun: boolean
  status: 'complete' | 'partial' | 'failed'
  source: {
    exchange: 'okx'
    host: string
    endpoints: string[]
  }
  outputPath: string
  reportPath: string | null
  jobId: string
  counts: {
    requestedSymbols: number
    rowsBuilt: number
    existingRows: number
    duplicateRows: number
    rowsAppended: number
    errors: number
    blockedRows: number
  }
  symbols: string[]
  passedSymbols: string[]
  blockedSymbols: string[]
  qualityBySymbol: OkxOrderbookSpreadQualityBySymbol[]
  observedStartTime: string | null
  observedEndTime: string | null
  spreadSummary: {
    maxSpreadBps: number | null
    medianSpreadBps: number | null
    minDepth5Usd: number | null
  }
  blockers: string[]
  errors: Array<{ symbol: string; errorClass: string; message: string }>
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/normalized/orderbook/okx_swap_orderbook_spread_live.normalized.jsonl'
const DEFAULT_REPORT_PATH = 'data/runtime/okx_orderbook_spread_snapshot.latest.json'
const SOURCE_ENDPOINT = '/api/v5/market/books'
const proxyDispatchers = new Map<string, ProxyAgent>()

async function main(): Promise<void> {
  const args = parseOkxOrderbookSpreadSnapshotArgs(process.argv.slice(2))
  const report = await runOkxOrderbookSpreadSnapshot(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseOkxOrderbookSpreadSnapshotArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT
  const defaultOutputPath = dataRoot
    ? join(dataRoot, 'normalized/orderbook/okx_swap_orderbook_spread_live.normalized.jsonl')
    : DEFAULT_OUTPUT_PATH
  return {
    symbols: parseSymbols(raw.get('symbols') ?? 'BTCUSDT,ETHUSDT,SOLUSDT'),
    outputPath: resolve(raw.get('outputPath') ?? raw.get('output') ?? defaultOutputPath),
    reportPath: parseNullablePath(raw.get('reportPath') ?? raw.get('report') ?? DEFAULT_REPORT_PATH),
    host: normalizeHost(raw.get('host') ?? 'https://www.okx.com'),
    depth: parsePositiveInteger(raw.get('depth'), 20, 'depth'),
    timeoutMs: parsePositiveInteger(raw.get('timeoutMs'), 10_000, 'timeoutMs'),
    retryAttempts: parseNonNegativeInteger(raw.get('retryAttempts'), 2, 'retryAttempts'),
    retryDelayMs: parseNonNegativeInteger(raw.get('retryDelayMs'), 500, 'retryDelayMs'),
    dryRun: parseBool(raw.get('dryRun'), false),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runOkxOrderbookSpreadSnapshot(
  args: CliArgs,
): Promise<OkxOrderbookSpreadSnapshotReport> {
  const startedAt = new Date()
  const generatedAt = new Date().toISOString()
  const jobId = `okx_orderbook_spread_snapshot_${compactUtc(generatedAt)}_${randomUUID()}`
  const outputPath = resolve(args.outputPath)
  const reportPath = args.reportPath ? resolve(args.reportPath) : null
  const outputManifestPath = `${outputPath}.manifest.json`
  const existingKeys = readExistingDedupKeys(outputPath)
  const rows: OkxOrderbookSpreadRow[] = []
  const errors: OkxOrderbookSpreadSnapshotReport['errors'] = []

  for (const symbol of args.symbols) {
    try {
      const snapshot = await fetchOkxOrderbookSpreadSnapshot({
        host: args.host,
        symbol,
        depth: args.depth,
        timeoutMs: args.timeoutMs,
        retryAttempts: args.retryAttempts,
        retryDelayMs: args.retryDelayMs,
        jobId,
        reportPath: reportPath ?? outputPath,
        manifestPath: outputManifestPath,
      })
      rows.push(buildOkxOrderbookSpreadRow(snapshot))
    } catch (error) {
      errors.push({
        symbol,
        errorClass: classifyError(error),
        message: redactErrorMessage(error instanceof Error ? formatErrorWithCause(error) : String(error)),
      })
    }
  }

  const duplicateRows = rows.filter(row => existingKeys.has(row.dedupKey)).length
  const rowsToAppend = rows.filter(row => !existingKeys.has(row.dedupKey))
  if (!args.dryRun && rowsToAppend.length > 0) {
    await mkdir(dirname(outputPath), { recursive: true })
    await appendFile(outputPath, `${rowsToAppend.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf-8')
  }

  await writeEvidenceManifestForArtifact({
    job: 'okx_orderbook_spread_snapshot_rows',
    artifactPath: outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: rows.length === 0 ? 1 : 0,
    businessStatus: rows.length > 0 ? 'warn' : 'fail',
    recordsIn: args.symbols.length,
    recordsOut: args.dryRun ? 0 : rowsToAppend.length,
    errorClass: errors[0]?.errorClass ?? null,
  })

  const observedTimes = rows.map(row => row.sourceTimestamp).sort()
  const spreadBpsValues = rows.map(row => row.fields.spreadBps).filter(Number.isFinite).sort((left, right) => left - right)
  const depth5Values = rows
    .map(row => Math.min(row.fields.bidNotionalDepth5, row.fields.askNotionalDepth5))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  const qualitySummary = summarizeOkxOrderbookSpreadQuality(rows)
  const blockedRows = rows.filter(row => row.quality.status === 'blocked').length
  const blockers = uniqueStrings([
    ...(rows.length === args.symbols.length ? [] : [`okx_orderbook_spread_rows_missing:${rows.length}<${args.symbols.length}`]),
    ...(errors.length > 0 ? [`okx_orderbook_spread_errors:${errors.length}`] : []),
    ...(blockedRows > 0 ? [`okx_orderbook_spread_quality_blocked_rows:${blockedRows}`] : []),
  ])
  const report: OkxOrderbookSpreadSnapshotReport = {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    dryRun: args.dryRun,
    status: rows.length === args.symbols.length ? 'complete' : rows.length > 0 ? 'partial' : 'failed',
    source: {
      exchange: 'okx',
      host: args.host,
      endpoints: [SOURCE_ENDPOINT],
    },
    outputPath,
    reportPath,
    jobId,
    counts: {
      requestedSymbols: args.symbols.length,
      rowsBuilt: rows.length,
      existingRows: existingKeys.size,
      duplicateRows,
      rowsAppended: args.dryRun ? 0 : rowsToAppend.length,
      errors: errors.length,
      blockedRows,
    },
    symbols: rows.map(row => row.symbol).sort(),
    passedSymbols: qualitySummary.passedSymbols,
    blockedSymbols: qualitySummary.blockedSymbols,
    qualityBySymbol: qualitySummary.qualityBySymbol,
    observedStartTime: observedTimes[0] ?? null,
    observedEndTime: observedTimes.at(-1) ?? null,
    spreadSummary: {
      maxSpreadBps: spreadBpsValues.length > 0 ? roundNumber(Math.max(...spreadBpsValues), 8) : null,
      medianSpreadBps: median(spreadBpsValues),
      minDepth5Usd: depth5Values.length > 0 ? roundNumber(Math.min(...depth5Values), 8) : null,
    },
    blockers,
    errors,
    safetyNotes: [
      'This collector uses OKX public order-book endpoints only; it does not read API secrets and cannot submit orders.',
      'Rows are research-only spread/depth inputs for route-cost and slippage diagnostics, not promotion-grade execution evidence.',
      'Paper/live/promotion flags remain false even when fresh order-book rows are collected.',
    ],
  }

  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'okx_orderbook_spread_snapshot_report',
      artifactPath: reportPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'failed' ? 1 : 0,
      businessStatus: report.status === 'failed' ? 'fail' : 'warn',
      recordsIn: args.symbols.length,
      recordsOut: rows.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function summarizeOkxOrderbookSpreadQuality(rows: OkxOrderbookSpreadRow[]): {
  qualityBySymbol: OkxOrderbookSpreadQualityBySymbol[]
  passedSymbols: string[]
  blockedSymbols: string[]
} {
  const qualityBySymbol = rows
    .map(row => {
      const depth5Usd = roundNumber(Math.min(row.fields.bidNotionalDepth5, row.fields.askNotionalDepth5), 8)
      return {
        symbol: row.symbol,
        status: row.quality.status,
        blockers: row.quality.blockers,
        spreadBps: row.fields.spreadBps,
        depth5Usd,
        bidNotionalDepth5: row.fields.bidNotionalDepth5,
        askNotionalDepth5: row.fields.askNotionalDepth5,
        availableAt: row.availableAt,
        eventTime: row.eventTime,
      }
    })
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
  return {
    qualityBySymbol,
    passedSymbols: qualityBySymbol.filter(row => row.status === 'pass').map(row => row.symbol),
    blockedSymbols: qualityBySymbol.filter(row => row.status === 'blocked').map(row => row.symbol),
  }
}

async function fetchOkxOrderbookSpreadSnapshot(input: {
  host: string
  symbol: string
  depth: number
  timeoutMs: number
  retryAttempts: number
  retryDelayMs: number
  jobId: string
  reportPath: string
  manifestPath: string
}): Promise<SnapshotInput> {
  const instId = normalizedSymbolToOkxSwap(input.symbol)
  const fetchedAt = new Date().toISOString()
  const book = await fetchOkxFirstDataWithRetry({
    host: input.host,
    path: `${SOURCE_ENDPOINT}?instId=${encodeURIComponent(instId)}&sz=${encodeURIComponent(String(input.depth))}`,
    timeoutMs: input.timeoutMs,
    retryAttempts: input.retryAttempts,
    retryDelayMs: input.retryDelayMs,
  })
  const availableAt = new Date().toISOString()
  return {
    symbol: input.symbol,
    instId,
    fetchedAt,
    observedAt: availableAt,
    availableAt,
    jobId: input.jobId,
    reportPath: input.reportPath,
    manifestPath: input.manifestPath,
    book,
    depth: input.depth,
  }
}

export function buildOkxOrderbookSpreadRow(input: SnapshotInput): OkxOrderbookSpreadRow {
  const bids = readBookLevels(input.book.bids, 'bids')
  const asks = readBookLevels(input.book.asks, 'asks')
  const sourceTimestampMs = requireNumber(input.book.ts, 'book.ts')
  const bestBid = requireNumber(bids[0]?.[0], 'bids.0.price')
  const bestAsk = requireNumber(asks[0]?.[0], 'asks.0.price')
  const bidSizeTop = requireNumber(bids[0]?.[1], 'bids.0.size')
  const askSizeTop = requireNumber(asks[0]?.[1], 'asks.0.size')
  const midPrice = (bestBid + bestAsk) / 2
  if (midPrice <= 0 || bestAsk < bestBid) throw new Error(`invalid_book_crossed:${input.instId}`)
  const spreadAbs = bestAsk - bestBid
  const spreadBps = (spreadAbs / midPrice) * 10_000
  const bidNotionalDepth1 = notionalDepth(bids, 1)
  const askNotionalDepth1 = notionalDepth(asks, 1)
  const bidNotionalDepth5 = notionalDepth(bids, 5)
  const askNotionalDepth5 = notionalDepth(asks, 5)
  const bidNotionalDepth10 = notionalDepth(bids, 10)
  const askNotionalDepth10 = notionalDepth(asks, 10)
  const fields = {
    symbol: input.symbol,
    instId: input.instId,
    bestBid: roundNumber(bestBid, 12),
    bestAsk: roundNumber(bestAsk, 12),
    midPrice: roundNumber(midPrice, 12),
    spreadAbs: roundNumber(spreadAbs, 12),
    spreadBps: roundNumber(spreadBps, 8),
    bidSizeTop: roundNumber(bidSizeTop, 12),
    askSizeTop: roundNumber(askSizeTop, 12),
    bidNotionalTop: roundNumber(bestBid * bidSizeTop, 8),
    askNotionalTop: roundNumber(bestAsk * askSizeTop, 8),
    bidNotionalDepth1: roundNumber(bidNotionalDepth1, 8),
    askNotionalDepth1: roundNumber(askNotionalDepth1, 8),
    bidNotionalDepth5: roundNumber(bidNotionalDepth5, 8),
    askNotionalDepth5: roundNumber(askNotionalDepth5, 8),
    bidNotionalDepth10: roundNumber(bidNotionalDepth10, 8),
    askNotionalDepth10: roundNumber(askNotionalDepth10, 8),
    imbalanceTop: roundNumber(imbalance(bidNotionalDepth1, askNotionalDepth1), 8),
    imbalanceDepth5: roundNumber(imbalance(bidNotionalDepth5, askNotionalDepth5), 8),
    depthLevelsReturned: Math.min(bids.length, asks.length),
    requestedDepth: input.depth,
    sourceBookTs: sourceTimestampMs,
  }
  const qualityBlockers = uniqueStrings([
    ...(fields.spreadBps > 20 ? [`spread_bps_high:${fields.spreadBps}>20`] : []),
    ...(Math.min(fields.bidNotionalDepth5, fields.askNotionalDepth5) < 100_000
      ? [`depth5_usd_low:${roundNumber(Math.min(fields.bidNotionalDepth5, fields.askNotionalDepth5), 2)}<100000`]
      : []),
    ...(fields.depthLevelsReturned < Math.min(5, input.depth) ? [`book_depth_levels_low:${fields.depthLevelsReturned}`] : []),
  ])
  const rawPayloadHash = sha256Hex(JSON.stringify(input.book))
  const normalizedPayloadHash = sha256Hex(JSON.stringify(fields))
  return {
    schemaVersion: 'openalice.orderbook_spread_snapshot.v1',
    eventTime: new Date(sourceTimestampMs).toISOString(),
    eventTimeMs: sourceTimestampMs,
    exchange: 'okx',
    market: 'swap',
    symbol: input.symbol,
    endpointId: 'okxOrderbookSpreadSnapshot',
    sourceEndpoint: SOURCE_ENDPOINT,
    sourceTimestamp: new Date(sourceTimestampMs).toISOString(),
    sourceTimestampMs,
    sourceTimestampBasis: 'exchange_book_ts',
    fetchedAt: input.fetchedAt,
    observedAt: input.observedAt,
    availableAt: input.availableAt,
    ingestedAt: input.availableAt,
    jobId: input.jobId,
    generatedAt: input.availableAt,
    lineageStatus: 'explicit_row_lineage',
    dedupKey: `okx|swap|okxOrderbookSpreadSnapshot|${input.symbol}|${sourceTimestampMs}`,
    rawPayloadHash,
    collectionRunId: input.jobId,
    reportPath: input.reportPath,
    manifestPath: input.manifestPath,
    normalizedPayloadHash,
    quality: {
      status: qualityBlockers.length > 0 ? 'blocked' : 'pass',
      blockers: qualityBlockers,
    },
    fields,
  }
}

async function fetchOkxFirstData(host: string, path: string, timeoutMs: number): Promise<UnknownRecord> {
  const proxyUrl = resolveProxyUrl()
  const dispatcher = proxyUrl ? proxyDispatcher(proxyUrl) : undefined
  const { statusCode, body } = await request(`${host}${path}`, {
    ...(dispatcher ? { dispatcher } : {}),
    headers: {
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (statusCode < 200 || statusCode >= 300) throw new Error(`http_${statusCode}:${path}`)
  const raw = asRecord(await body.json())
  const code = readString(raw?.code)
  if (code !== '0') throw new Error(`okx_code_${code ?? 'missing'}:${readString(raw?.msg) ?? 'no_msg'}`)
  const data = Array.isArray(raw?.data) ? raw.data.map(asRecord).filter((item): item is UnknownRecord => item != null) : []
  if (!data[0]) throw new Error(`okx_empty_data:${path}`)
  return data[0]
}

async function fetchOkxFirstDataWithRetry(input: {
  host: string
  path: string
  timeoutMs: number
  retryAttempts: number
  retryDelayMs: number
}): Promise<UnknownRecord> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= input.retryAttempts; attempt += 1) {
    try {
      return await fetchOkxFirstData(input.host, input.path, input.timeoutMs)
    } catch (error) {
      lastError = error
      if (attempt >= input.retryAttempts || !isRetryableFetchError(error)) break
      await sleep(input.retryDelayMs * (attempt + 1))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'okx_orderbook_fetch_failed'))
}

function proxyDispatcher(proxyUrl: string): ProxyAgent {
  const existing = proxyDispatchers.get(proxyUrl)
  if (existing) return existing
  const dispatcher = new ProxyAgent(proxyUrl)
  proxyDispatchers.set(proxyUrl, dispatcher)
  return dispatcher
}

function readBookLevels(value: unknown, label: string): BookLevel[] {
  if (!Array.isArray(value)) throw new Error(`missing_book_levels:${label}`)
  return value.map((item, index) => {
    if (!Array.isArray(item) || item.length < 2) throw new Error(`invalid_book_level:${label}.${index}`)
    return [
      String(item[0]),
      String(item[1]),
      String(item[2] ?? ''),
      String(item[3] ?? ''),
    ]
  })
}

function notionalDepth(levels: BookLevel[], depth: number): number {
  return levels.slice(0, depth).reduce((sum, [price, size]) => {
    const px = requireNumber(price, 'book.price')
    const sz = requireNumber(size, 'book.size')
    return sum + px * sz
  }, 0)
}

function imbalance(bidNotional: number, askNotional: number): number {
  const denom = bidNotional + askNotional
  return denom > 0 ? (bidNotional - askNotional) / denom : 0
}

function readExistingDedupKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set()
  const keys = readFileSync(path, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return readString(asRecord(JSON.parse(line))?.dedupKey)
      } catch {
        return null
      }
    })
    .filter((key): key is string => key != null)
  return new Set(keys)
}

function normalizedSymbolToOkxSwap(symbol: string): string {
  const normalized = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const match = normalized.match(/^([A-Z0-9]+)USDT$/)
  if (!match) throw new Error(`unsupported_okx_orderbook_symbol:${symbol}`)
  return `${match[1]}-USDT-SWAP`
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg?.startsWith('--')) continue
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

function parseSymbols(value: string): string[] {
  const symbols = value
    .split(',')
    .map(item => item.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean)
  return [...new Set(symbols)]
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  const normalized = value.trim().toLowerCase()
  return normalized === '' || normalized === 'null' || normalized === 'none' ? null : resolve(value)
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

function parseNonNegativeInteger(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`)
  return parsed
}

function normalizeHost(value: string): string {
  return value.replace(/\/+$/, '')
}

function compactUtc(value: string): string {
  return value.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? formatErrorWithCause(error) : String(error)
  if (/aborted|AbortError|timeout|UND_ERR_CONNECT_TIMEOUT|Connect Timeout/i.test(message)) return 'timeout'
  if (message.startsWith('http_')) return 'http'
  if (message.startsWith('okx_code_')) return 'okx_api'
  if (message.startsWith('unsupported_okx_orderbook_symbol')) return 'unsupported_symbol'
  if (/SSL|TLS|secure TLS|socket disconnected/i.test(message)) return 'tls'
  if (/ENOTFOUND|Could not resolve|resolve host/i.test(message)) return 'dns'
  if (/ECONNREFUSED|ECONNRESET|Failed to connect/i.test(message)) return 'network'
  if (/proxy|Proxy/i.test(message)) return 'proxy'
  return 'unknown'
}

function isRetryableFetchError(error: unknown): boolean {
  return ['timeout', 'tls', 'dns', 'network', 'proxy', 'unknown'].includes(classifyError(error))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatErrorWithCause(error: Error): string {
  const parts = [error.message]
  let cause: unknown = error.cause
  while (cause instanceof Error) {
    const code = readString((cause as Error & { code?: unknown }).code)
    parts.push(code ? `${cause.message} (${code})` : cause.message)
    cause = cause.cause
  }
  return parts.join(': ')
}

function redactErrorMessage(message: string): string {
  return message
    .replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/g, '$1***:***@')
    .replace(/([?&](?:apiKey|signature|secret|passphrase|password|token)=)[^&\s]+/gi, '$1***')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .slice(0, 240)
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
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

function requireNumber(value: unknown, label: string): number {
  const parsed = readNumber(value)
  if (parsed == null) throw new Error(`missing_number:${label}`)
  return parsed
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim() !== ''))]
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const mid = Math.floor(values.length / 2)
  const value = values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid]
  return roundNumber(value, 8)
}

function roundNumber(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: OkxOrderbookSpreadSnapshotReport): string {
  return [
    `okx orderbook spread snapshot: status=${report.status} dryRun=${report.dryRun}`,
    `rowsBuilt=${report.counts.rowsBuilt}/${report.counts.requestedSymbols} appended=${report.counts.rowsAppended} duplicates=${report.counts.duplicateRows}`,
    `maxSpreadBps=${report.spreadSummary.maxSpreadBps ?? 'n/a'} minDepth5Usd=${report.spreadSummary.minDepth5Usd ?? 'n/a'}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.join(',')}` : 'blockers=none',
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('collect_okx_orderbook_spread_snapshot failed:', error)
    process.exitCode = 1
  })
}
