import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type CollectStatus = 'complete' | 'partial' | 'failed'

interface CliArgs {
  warehouseRoot: string
  outputPath: string
  reportPath: string | null
  baseUrl: string
  assets: string[]
  metrics: string[]
  frequency: string
  startTime: string
  endTime: string | null
  pageSize: number
  maxPages: number
  maxRetries: number
  json: boolean
}

interface CoinMetricsResponse {
  data?: Array<Record<string, unknown>>
  next_page_url?: string | null
}

interface FetchLikeResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

type FetchLike = (url: string) => Promise<FetchLikeResponse>

export interface CoinMetricsOnchainReport {
  schemaVersion: 1
  generatedAt: string
  status: CollectStatus
  source: 'coinmetrics_community'
  baseUrl: string
  endpoint: string
  outputPath: string
  assets: string[]
  metrics: string[]
  frequency: string
  startTime: string
  endTime: string | null
  pageSize: number
  pagesFetched: number
  rowsFetched: number
  rowsWritten: number
  duplicateRows: number
  observedStartTime: string | null
  observedEndTime: string | null
  outputHash: string | null
  errors: Array<{ url: string; error: string }>
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_REPORT_PATH = 'data/runtime/openalice_coinmetrics_onchain_collect.latest.json'
const DEFAULT_BASE_URL = 'https://community-api.coinmetrics.io/v4'
const DEFAULT_ASSETS = ['btc', 'eth']
const DEFAULT_METRICS = ['PriceUSD', 'CapMrktCurUSD', 'TxCnt', 'AdrActCnt', 'FeeTotNtv', 'SplyCur']
const DEFAULT_START_TIME = '2010-01-01T00:00:00Z'

export function parseCoinMetricsOnchainArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const warehouseRoot = resolve(
    raw.get('warehouseRoot') ??
    raw.get('dataRoot') ??
    process.env.OPENALICE_DATA_ROOT ??
    'data',
  )
  return {
    warehouseRoot,
    outputPath: resolve(
      raw.get('outputPath') ??
      raw.get('output') ??
      resolve(warehouseRoot, 'onchain/coinmetrics/asset_metrics_1d.jsonl'),
    ),
    reportPath: parseNullablePath(raw.get('reportPath') ?? raw.get('report') ?? DEFAULT_REPORT_PATH),
    baseUrl: normalizeBaseUrl(raw.get('baseUrl') ?? DEFAULT_BASE_URL),
    assets: parseList(raw.get('assets'), DEFAULT_ASSETS).map(value => value.toLowerCase()),
    metrics: parseList(raw.get('metrics'), DEFAULT_METRICS),
    frequency: raw.get('frequency') ?? '1d',
    startTime: raw.get('startTime') ?? raw.get('start') ?? DEFAULT_START_TIME,
    endTime: parseNullablePath(raw.get('endTime') ?? raw.get('end')),
    pageSize: parsePositiveInteger(raw.get('pageSize'), 10_000, 'pageSize'),
    maxPages: parsePositiveInteger(raw.get('maxPages'), 100, 'maxPages'),
    maxRetries: parseNonNegativeInteger(raw.get('maxRetries'), 2, 'maxRetries'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function collectCoinMetricsCommunityOnchain(
  args: CliArgs,
  fetchImpl: FetchLike = defaultFetch,
): Promise<CoinMetricsOnchainReport> {
  const startedAt = new Date()
  const endpoint = '/timeseries/asset-metrics'
  const firstUrl = buildCoinMetricsUrl(args)
  const rows: Array<Record<string, unknown>> = []
  const errors: Array<{ url: string; error: string }> = []
  let nextUrl: string | null = firstUrl
  let pagesFetched = 0

  while (nextUrl && pagesFetched < args.maxPages) {
    const currentUrl = nextUrl
    const fetched = await fetchJsonWithRetry(currentUrl, args.maxRetries, fetchImpl)
    if (fetched.error) {
      errors.push({ url: currentUrl, error: fetched.error })
      break
    }
    pagesFetched += 1
    const payload = fetched.payload
    rows.push(...(payload.data ?? []))
    nextUrl = payload.next_page_url ?? null
  }
  if (nextUrl && pagesFetched >= args.maxPages) {
    errors.push({ url: nextUrl, error: `maxPages exceeded: ${args.maxPages}` })
  }

  const deduped = dedupeRows(rows)
  const observedTimes = deduped
    .map(row => typeof row.time === 'string' ? row.time : null)
    .filter((value): value is string => value != null)
    .sort()
  const raw = deduped.map(row => JSON.stringify({
    schemaVersion: 'coinmetrics_community_asset_metric.v1',
    source: 'coinmetrics_community',
    ingestedAt: startedAt.toISOString(),
    frequency: args.frequency,
    payload: row,
  })).join('\n')
  const outputHash = raw.length > 0 ? sha256Hex(`${raw}\n`) : null
  await atomicWrite(args.outputPath, raw.length > 0 ? `${raw}\n` : '')
  const outputManifest = await writeEvidenceManifestForArtifact({
    job: 'coinmetrics_community_onchain_raw',
    artifactPath: args.outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: errors.length === 0 ? 0 : 1,
    businessStatus: errors.length === 0 && deduped.length > 0 ? 'pass' : deduped.length > 0 ? 'warn' : 'fail',
    recordsIn: rows.length,
    recordsOut: deduped.length,
    errorClass: errors[0]?.error ?? null,
  })

  const status: CollectStatus = errors.length === 0 && deduped.length > 0
    ? 'complete'
    : deduped.length > 0
      ? 'partial'
      : 'failed'
  const blockers = [
    ...(deduped.length === 0 ? ['coinmetrics_rows_missing'] : []),
    ...errors.map(error => `coinmetrics_fetch_error:${error.error}`),
  ]
  const report: CoinMetricsOnchainReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    source: 'coinmetrics_community',
    baseUrl: args.baseUrl,
    endpoint,
    outputPath: resolve(args.outputPath),
    assets: args.assets,
    metrics: args.metrics,
    frequency: args.frequency,
    startTime: args.startTime,
    endTime: args.endTime,
    pageSize: args.pageSize,
    pagesFetched,
    rowsFetched: rows.length,
    rowsWritten: deduped.length,
    duplicateRows: rows.length - deduped.length,
    observedStartTime: observedTimes[0] ?? null,
    observedEndTime: observedTimes.at(-1) ?? null,
    outputHash,
    errors,
    blockers,
    nextActions: blockers.length === 0
      ? ['Normalize Coin Metrics JSONL into canonical on-chain parquet partitions.']
      : ['Retry Coin Metrics collection with a smaller asset/metric set or inspect API coverage for unavailable metrics.'],
    notes: [
      'Community API rows are stored as raw JSONL payloads first; normalized on-chain parquet is a separate warehouse layer.',
      'This collector is idempotent for the requested window because it rewrites the output file atomically.',
      `Raw output manifest: ${outputManifest.manifestPath}`,
    ],
  }

  if (args.reportPath) {
    const reportPath = resolve(args.reportPath)
    await atomicWrite(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    await writeEvidenceManifestForArtifact({
      job: 'coinmetrics_community_onchain_report',
      artifactPath: reportPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: status === 'failed' ? 1 : 0,
      businessStatus: status === 'complete' ? 'pass' : status === 'partial' ? 'warn' : 'fail',
      recordsIn: rows.length,
      recordsOut: deduped.length,
      errorClass: blockers[0] ?? null,
    })
  }

  return report
}

function buildCoinMetricsUrl(args: CliArgs): string {
  const url = new URL(`${args.baseUrl}/timeseries/asset-metrics`)
  url.searchParams.set('assets', args.assets.join(','))
  url.searchParams.set('metrics', args.metrics.join(','))
  url.searchParams.set('frequency', args.frequency)
  url.searchParams.set('start_time', args.startTime)
  if (args.endTime) url.searchParams.set('end_time', args.endTime)
  url.searchParams.set('page_size', String(args.pageSize))
  return url.toString()
}

async function fetchJsonWithRetry(
  url: string,
  maxRetries: number,
  fetchImpl: FetchLike,
): Promise<{ payload: CoinMetricsResponse; error: null } | { payload: null; error: string }> {
  let lastError: string | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(url)
      const body = await response.text()
      if (!response.ok) {
        lastError = `http_${response.status}:${body.slice(0, 240)}`
        continue
      }
      return { payload: JSON.parse(body) as CoinMetricsResponse, error: null }
    } catch (error) {
      lastError = (error as Error).message
    }
  }
  return { payload: null, error: lastError ?? 'unknown_fetch_error' }
}

function dedupeRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>()
  const out: Array<Record<string, unknown>> = []
  for (const row of rows) {
    const asset = typeof row.asset === 'string' ? row.asset : ''
    const time = typeof row.time === 'string' ? row.time : ''
    const key = `${asset}\u0000${time}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const outputPath = resolve(path)
  await mkdir(dirname(outputPath), { recursive: true })
  const tmpPath = `${outputPath}.${process.pid}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, outputPath)
}

async function defaultFetch(url: string): Promise<FetchLikeResponse> {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available in this Node runtime')
  }
  return fetch(url)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback
  return raw.split(',').map(value => value.trim()).filter(Boolean)
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid --${name}: ${raw}`)
  return value
}

function parseNonNegativeInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid --${name}: ${raw}`)
  return value
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

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase())
}

export function renderCoinMetricsOnchainMarkdown(report: CoinMetricsOnchainReport): string {
  const lines: string[] = []
  lines.push('# Coin Metrics Community On-Chain Collect')
  lines.push('')
  lines.push(`Generated: \`${report.generatedAt}\``)
  lines.push(`Status: \`${report.status}\``)
  lines.push(`Output: \`${report.outputPath}\``)
  lines.push(`Rows: fetched=${report.rowsFetched} written=${report.rowsWritten} duplicate=${report.duplicateRows}`)
  lines.push(`Observed: ${report.observedStartTime ?? 'unknown'} -> ${report.observedEndTime ?? 'unknown'}`)
  lines.push('')
  if (report.blockers.length > 0) {
    lines.push('## Blockers')
    lines.push('')
    for (const blocker of report.blockers) lines.push(`- \`${blocker}\``)
    lines.push('')
  }
  lines.push('## Next Actions')
  lines.push('')
  for (const action of report.nextActions) lines.push(`- ${action}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseCoinMetricsOnchainArgs(argv)
  const report = await collectCoinMetricsCommunityOnchain(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderCoinMetricsOnchainMarkdown(report))
  if (report.status === 'failed') process.exitCode = 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('collect_coinmetrics_community_onchain failed:', error)
    process.exit(1)
  })
}
