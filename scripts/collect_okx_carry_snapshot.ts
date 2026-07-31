import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProxyAgent, request } from 'undici'
import { resolveProxyUrl } from '../src/domain/market-data/live-fetcher.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

interface CliArgs {
  symbols: string[]
  outputPath: string
  reportPath: string | null
  host: string
  timeoutMs: number
  retryAttempts: number
  retryDelayMs: number
  dryRun: boolean
  json: boolean
}

interface OkxCarrySnapshotRow {
  schemaVersion: 'openalice.external_derivatives.normalized.v1'
  eventTime: string
  eventTimeMs: number
  exchange: 'okx'
  market: 'swap'
  symbol: string
  endpointId: 'okxCarrySnapshot'
  sourceEndpoint: '/api/v5/public/okx-carry-snapshot'
  sourceTimestamp: string
  sourceTimestampMs: number
  sourceTimestampBasis: 'exchange_snapshot_max_ts'
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
  fields: Record<string, number | string | null>
}

interface SnapshotInput {
  symbol: string
  instId: string
  indexInstId: string
  mark: UnknownRecord
  index: UnknownRecord
  funding: UnknownRecord
  fetchedAt: string
  observedAt: string
  availableAt: string
  jobId: string
  reportPath: string
  manifestPath: string
}

export interface OkxCarrySnapshotReport {
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
  }
  symbols: string[]
  observedStartTime: string | null
  observedEndTime: string | null
  blockers: string[]
  errors: Array<{ symbol: string; errorClass: string; message: string }>
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/normalized/derivatives/okx_swap_eth_carry_live.normalized.jsonl'
const DEFAULT_REPORT_PATH = 'data/runtime/okx_carry_snapshot_collect.latest.json'
const SNAPSHOT_ENDPOINT = '/api/v5/public/okx-carry-snapshot'
const proxyDispatchers = new Map<string, ProxyAgent>()

async function main(): Promise<void> {
  const args = parseOkxCarrySnapshotArgs(process.argv.slice(2))
  const report = await runOkxCarrySnapshot(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseOkxCarrySnapshotArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT
  const defaultOutputPath = dataRoot
    ? join(dataRoot, 'normalized/derivatives/okx_swap_eth_carry_live.normalized.jsonl')
    : DEFAULT_OUTPUT_PATH
  return {
    symbols: parseSymbols(raw.get('symbols') ?? 'BTCUSDT,ETHUSDT'),
    outputPath: resolve(raw.get('outputPath') ?? raw.get('output') ?? defaultOutputPath),
    reportPath: parseNullablePath(raw.get('reportPath') ?? raw.get('report') ?? DEFAULT_REPORT_PATH),
    host: normalizeHost(raw.get('host') ?? 'https://www.okx.com'),
    timeoutMs: parsePositiveInteger(raw.get('timeoutMs'), 10_000, 'timeoutMs'),
    retryAttempts: parseNonNegativeInteger(raw.get('retryAttempts'), 2, 'retryAttempts'),
    retryDelayMs: parseNonNegativeInteger(raw.get('retryDelayMs'), 500, 'retryDelayMs'),
    dryRun: parseBool(raw.get('dryRun'), false),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runOkxCarrySnapshot(args: CliArgs): Promise<OkxCarrySnapshotReport> {
  const startedAt = new Date()
  const generatedAt = new Date().toISOString()
  const jobId = `okx_carry_snapshot_collect_${compactUtc(generatedAt)}_${randomUUID()}`
  const outputPath = resolve(args.outputPath)
  const reportPath = args.reportPath ? resolve(args.reportPath) : null
  const outputManifestPath = `${outputPath}.manifest.json`
  const existingKeys = readExistingDedupKeys(outputPath)
  const rows: OkxCarrySnapshotRow[] = []
  const errors: OkxCarrySnapshotReport['errors'] = []

  for (const symbol of args.symbols) {
    try {
      const snapshot = await fetchOkxCarrySnapshot({
        host: args.host,
        symbol,
        timeoutMs: args.timeoutMs,
        retryAttempts: args.retryAttempts,
        retryDelayMs: args.retryDelayMs,
        generatedAt,
        jobId,
        reportPath: reportPath ?? outputPath,
        manifestPath: outputManifestPath,
      })
      rows.push(buildOkxCarrySnapshotRow(snapshot))
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
    job: 'okx_carry_snapshot_collect_rows',
    artifactPath: outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: rows.length === 0 ? 1 : 0,
    businessStatus: rows.length === args.symbols.length ? 'warn' : rows.length > 0 ? 'warn' : 'fail',
    recordsIn: args.symbols.length,
    recordsOut: args.dryRun ? 0 : rowsToAppend.length,
    errorClass: errors[0]?.errorClass ?? null,
  })

  const observedTimes = rows.map(row => row.sourceTimestamp).sort()
  const blockers = [
    ...(rows.length === args.symbols.length ? [] : [`okx_carry_snapshot_rows_missing:${rows.length}<${args.symbols.length}`]),
    ...(errors.length > 0 ? [`okx_carry_snapshot_errors:${errors.length}`] : []),
  ]
  const report: OkxCarrySnapshotReport = {
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
      endpoints: [
        '/api/v5/public/mark-price',
        '/api/v5/market/index-tickers',
        '/api/v5/public/funding-rate',
      ],
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
    },
    symbols: rows.map(row => row.symbol).sort(),
    observedStartTime: observedTimes[0] ?? null,
    observedEndTime: observedTimes.at(-1) ?? null,
    blockers,
    errors,
    safetyNotes: [
      'This collector uses OKX public endpoints only; it does not read API secrets and cannot submit orders.',
      'Rows are research-only PIT inputs for funding/carry prospective observation, not promotion-grade execution evidence.',
      'Paper/live/promotion flags remain false even when fresh rows are collected.',
    ],
  }

  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'okx_carry_snapshot_collect_report',
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

async function fetchOkxCarrySnapshot(input: {
  host: string
  symbol: string
  timeoutMs: number
  retryAttempts: number
  retryDelayMs: number
  generatedAt: string
  jobId: string
  reportPath: string
  manifestPath: string
}): Promise<SnapshotInput> {
  const instId = normalizedSymbolToOkxSwap(input.symbol)
  const indexInstId = instId.replace('-SWAP', '')
  const fetchedAt = new Date().toISOString()
  const [mark, index, funding] = await Promise.all([
    fetchOkxFirstDataWithRetry({
      host: input.host,
      path: `/api/v5/public/mark-price?instType=SWAP&instId=${encodeURIComponent(instId)}`,
      timeoutMs: input.timeoutMs,
      retryAttempts: input.retryAttempts,
      retryDelayMs: input.retryDelayMs,
    }),
    fetchOkxFirstDataWithRetry({
      host: input.host,
      path: `/api/v5/market/index-tickers?instId=${encodeURIComponent(indexInstId)}`,
      timeoutMs: input.timeoutMs,
      retryAttempts: input.retryAttempts,
      retryDelayMs: input.retryDelayMs,
    }),
    fetchOkxFirstDataWithRetry({
      host: input.host,
      path: `/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`,
      timeoutMs: input.timeoutMs,
      retryAttempts: input.retryAttempts,
      retryDelayMs: input.retryDelayMs,
    }),
  ])
  const availableAt = new Date().toISOString()
  return {
    symbol: input.symbol,
    instId,
    indexInstId,
    mark,
    index,
    funding,
    fetchedAt,
    observedAt: availableAt,
    availableAt,
    jobId: input.jobId,
    reportPath: input.reportPath,
    manifestPath: input.manifestPath,
  }
}

export function buildOkxCarrySnapshotRow(input: SnapshotInput): OkxCarrySnapshotRow {
  const markPrice = requireNumber(input.mark.markPx, 'mark.markPx')
  const indexPrice = requireNumber(input.index.idxPx, 'index.idxPx')
  const fundingRate = requireNumber(input.funding.fundingRate, 'funding.fundingRate')
  const fundingTime = requireNumber(input.funding.fundingTime, 'funding.fundingTime')
  const nextFundingTime = readNumber(input.funding.nextFundingTime)
  const sourceTimestampMs = Math.max(
    requireNumber(input.mark.ts, 'mark.ts'),
    requireNumber(input.index.ts, 'index.ts'),
    requireNumber(input.funding.ts, 'funding.ts'),
  )
  const fields: Record<string, number | string | null> = {
    symbol: input.symbol,
    instId: input.instId,
    indexInstId: input.indexInstId,
    markPrice,
    indexPrice,
    lastFundingRate: fundingRate,
    fundingRate,
    fundingTime,
    nextFundingTime,
    prevFundingTime: readNumber(input.funding.prevFundingTime),
    sourceMarkTs: readNumber(input.mark.ts),
    sourceIndexTs: readNumber(input.index.ts),
    sourceFundingTs: readNumber(input.funding.ts),
  }
  const normalizedPayloadHash = sha256Hex(JSON.stringify(fields))
  const rawPayloadHash = sha256Hex(JSON.stringify({
    mark: input.mark,
    index: input.index,
    funding: input.funding,
  }))
  return {
    schemaVersion: 'openalice.external_derivatives.normalized.v1',
    eventTime: new Date(sourceTimestampMs).toISOString(),
    eventTimeMs: sourceTimestampMs,
    exchange: 'okx',
    market: 'swap',
    symbol: input.symbol,
    endpointId: 'okxCarrySnapshot',
    sourceEndpoint: SNAPSHOT_ENDPOINT,
    sourceTimestamp: new Date(sourceTimestampMs).toISOString(),
    sourceTimestampMs,
    sourceTimestampBasis: 'exchange_snapshot_max_ts',
    fetchedAt: input.fetchedAt,
    observedAt: input.observedAt,
    availableAt: input.availableAt,
    ingestedAt: input.availableAt,
    jobId: input.jobId,
    generatedAt: input.availableAt,
    lineageStatus: 'explicit_row_lineage',
    dedupKey: `okx|swap|okxCarrySnapshot|${input.symbol}|${sourceTimestampMs}`,
    rawPayloadHash,
    collectionRunId: input.jobId,
    reportPath: input.reportPath,
    manifestPath: input.manifestPath,
    normalizedPayloadHash,
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
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'okx_carry_snapshot_fetch_failed'))
}

function proxyDispatcher(proxyUrl: string): ProxyAgent {
  const existing = proxyDispatchers.get(proxyUrl)
  if (existing) return existing
  const dispatcher = new ProxyAgent(proxyUrl)
  proxyDispatchers.set(proxyUrl, dispatcher)
  return dispatcher
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
  if (normalized === 'BTCUSDT') return 'BTC-USDT-SWAP'
  if (normalized === 'ETHUSDT') return 'ETH-USDT-SWAP'
  throw new Error(`unsupported_okx_carry_symbol:${symbol}`)
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
  if (message.startsWith('unsupported_okx_carry_symbol')) return 'unsupported_symbol'
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

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: OkxCarrySnapshotReport): string {
  return [
    `okx carry snapshot collect: status=${report.status} dryRun=${report.dryRun}`,
    `rowsBuilt=${report.counts.rowsBuilt}/${report.counts.requestedSymbols} appended=${report.counts.rowsAppended} duplicates=${report.counts.duplicateRows}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.join(',')}` : 'blockers=none',
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('collect_okx_carry_snapshot failed:', error)
    process.exitCode = 1
  })
}
