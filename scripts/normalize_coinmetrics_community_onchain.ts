import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type NormalizeStatus = 'complete' | 'partial' | 'failed'

interface CliArgs {
  inputPath: string
  outputPath: string
  reportPath: string | null
  json: boolean
}

interface RawCoinMetricsEnvelope {
  schemaVersion?: string
  source?: string
  ingestedAt?: string
  frequency?: string
  payload?: Record<string, unknown>
}

export interface NormalizedCoinMetricsRow {
  schemaVersion: 'openalice.coinmetrics.asset_metric.normalized.v1'
  source: 'coinmetrics_community'
  sourceEndpoint: '/timeseries/asset-metrics'
  exchange: 'coinmetrics'
  asset: string
  symbol: string
  metric: string
  frequency: string
  eventTime: string
  eventTimeMs: number
  time: string
  timeMs: number
  value: number | null
  valueText: string | null
  unit: string | null
  fetchedAt: string
  observedAt: string
  availableAt: string
  availableAtMs: number
  ingestedAt: string
  generatedAt: string
  jobId: 'coinmetrics_community_onchain_normalize'
  lineageStatus: 'explicit_raw_envelope_lineage' | 'raw_envelope_ingested_at_missing'
  quality: {
    promotionGrade: false
    blockers: string[]
  }
  rawPayloadHash: string
}

export interface NormalizeCoinMetricsOnchainReport {
  schemaVersion: 1
  generatedAt: string
  status: NormalizeStatus
  source: 'coinmetrics_community'
  inputPath: string
  outputPath: string
  rowsRead: number
  rowsNormalized: number
  rowsDropped: number
  assets: string[]
  metrics: string[]
  frequencies: string[]
  observedStartTime: string | null
  observedEndTime: string | null
  outputHash: string | null
  blockers: string[]
  nextActions: string[]
}

const DEFAULT_REPORT_PATH = 'data/runtime/openalice_coinmetrics_onchain_normalize.latest.json'

export function parseNormalizeCoinMetricsArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = resolve(
    raw.get('dataRoot') ??
    raw.get('warehouseRoot') ??
    process.env.OPENALICE_DATA_ROOT ??
    'data',
  )
  return {
    inputPath: resolve(
      raw.get('inputPath') ??
      raw.get('input') ??
      resolve(dataRoot, 'onchain/coinmetrics/asset_metrics_1d.jsonl'),
    ),
    outputPath: resolve(
      raw.get('outputPath') ??
      raw.get('output') ??
      resolve(dataRoot, 'normalized/onchain/coinmetrics/asset_metrics_1d.normalized.jsonl'),
    ),
    reportPath: parseNullablePath(raw.get('reportPath') ?? raw.get('report') ?? DEFAULT_REPORT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runNormalizeCoinMetricsOnchain(args: CliArgs): Promise<NormalizeCoinMetricsOnchainReport> {
  const startedAt = new Date()
  const rawText = await readFile(args.inputPath, 'utf-8')
  const rawLines = rawText.split('\n').map(line => line.trim()).filter(Boolean)
  const normalizedRows: NormalizedCoinMetricsRow[] = []
  let rowsDropped = 0

  for (const line of rawLines) {
    const envelope = JSON.parse(line) as RawCoinMetricsEnvelope
    const rows = normalizeEnvelope(envelope, startedAt)
    if (rows.length > 0) normalizedRows.push(...rows)
    else rowsDropped += 1
  }

  normalizedRows.sort((left, right) => {
    if (left.timeMs !== right.timeMs) return left.timeMs - right.timeMs
    if (left.asset !== right.asset) return left.asset.localeCompare(right.asset)
    return left.metric.localeCompare(right.metric)
  })

  const output = normalizedRows.map(row => JSON.stringify(row)).join('\n')
  await atomicWrite(args.outputPath, output ? `${output}\n` : '')
  const outputHash = output ? sha256Hex(`${output}\n`) : null

  const assets = unique(normalizedRows.map(row => row.asset))
  const metrics = unique(normalizedRows.map(row => row.metric))
  const frequencies = unique(normalizedRows.map(row => row.frequency))
  const observedTimes = normalizedRows.map(row => row.time).sort()
  const blockers = normalizedRows.length > 0 ? [] : ['coinmetrics_normalized_rows_missing']
  const report: NormalizeCoinMetricsOnchainReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: normalizedRows.length > 0 ? (rowsDropped > 0 ? 'partial' : 'complete') : 'failed',
    source: 'coinmetrics_community',
    inputPath: args.inputPath,
    outputPath: args.outputPath,
    rowsRead: rawLines.length,
    rowsNormalized: normalizedRows.length,
    rowsDropped,
    assets,
    metrics,
    frequencies,
    observedStartTime: observedTimes[0] ?? null,
    observedEndTime: observedTimes.at(-1) ?? null,
    outputHash,
    blockers,
    nextActions: normalizedRows.length > 0
      ? ['Run the on-chain audit to validate duplicates, ordering, null coverage, and point-in-time availability.']
      : ['Collect Coin Metrics raw rows before attempting normalization.'],
  }

  if (args.reportPath) {
    await writeJsonArtifact(args.reportPath, report)
    await writeEvidenceManifestForArtifact({
      job: 'coinmetrics_community_onchain_normalize',
      artifactPath: args.reportPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'failed' ? 1 : 0,
      businessStatus: report.status === 'complete' ? 'pass' : report.status === 'partial' ? 'warn' : 'fail',
      recordsIn: report.rowsRead,
      recordsOut: report.rowsNormalized,
      errorClass: report.blockers[0] ?? null,
    })
  }

  await writeEvidenceManifestForArtifact({
    job: 'coinmetrics_community_onchain_normalized_rows',
    artifactPath: args.outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: report.status === 'failed' ? 1 : 0,
    businessStatus: report.status === 'complete' ? 'pass' : report.status === 'partial' ? 'warn' : 'fail',
    recordsIn: report.rowsRead,
    recordsOut: report.rowsNormalized,
    errorClass: report.blockers[0] ?? null,
    artifactHash: outputHash,
  })

  return report
}

function normalizeEnvelope(envelope: RawCoinMetricsEnvelope, startedAt: Date): NormalizedCoinMetricsRow[] {
  const payload = envelope.payload
  if (!payload) return []
  const asset = asString(payload.asset)?.toLowerCase() ?? null
  const time = asString(payload.time) ?? null
  if (!asset || !time) return []
  const timeMs = Date.parse(time)
  if (!Number.isFinite(timeMs)) return []
  const entries = Object.entries(payload).filter(([key]) => !['asset', 'time'].includes(key))
  const envelopeIngestedAt = asString(envelope.ingestedAt)
  const observedAt = envelopeIngestedAt ?? startedAt.toISOString()
  return entries.map(([metric, rawValue]) => {
    const numeric = typeof rawValue === 'number' ? rawValue : rawValue == null ? null : Number(rawValue)
    const value = Number.isFinite(numeric) ? numeric : null
    return {
    schemaVersion: 'openalice.coinmetrics.asset_metric.normalized.v1',
    source: 'coinmetrics_community',
    sourceEndpoint: '/timeseries/asset-metrics',
    exchange: 'coinmetrics',
    asset,
    symbol: asset,
    metric,
    frequency: envelope.frequency ?? 'unknown',
    eventTime: time,
    eventTimeMs: timeMs,
    time,
    timeMs,
    value,
    valueText: rawValue == null ? null : String(rawValue),
    unit: inferUnit(metric),
    fetchedAt: observedAt,
    observedAt,
    availableAt: observedAt,
    availableAtMs: Date.parse(observedAt),
    ingestedAt: observedAt,
    generatedAt: startedAt.toISOString(),
    jobId: 'coinmetrics_community_onchain_normalize',
    lineageStatus: envelopeIngestedAt == null ? 'raw_envelope_ingested_at_missing' : 'explicit_raw_envelope_lineage',
    quality: {
      promotionGrade: false,
      blockers: [
        'coinmetrics_community_research_only_not_execution_evidence',
        'onchain_rows_require_strategy_specific_pit_join_audit',
      ],
    },
    rawPayloadHash: sha256Hex(JSON.stringify(payload)),
    }
  })
}

function inferUnit(metric: string): string | null {
  if (metric.endsWith('USD')) return 'USD'
  if (metric.endsWith('Cnt')) return 'count'
  if (metric.endsWith('Ntv')) return 'native'
  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await atomicWrite(resolve(path), `${JSON.stringify(value, null, 2)}\n`)
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const outputPath = resolve(path)
  await mkdir(dirname(outputPath), { recursive: true })
  const tmpPath = `${outputPath}.${process.pid}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, outputPath)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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
  return normalized === 'null' || normalized === 'none' || normalized === 'false' ? null : resolve(value)
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase())
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseNormalizeCoinMetricsArgs(argv)
  const report = await runNormalizeCoinMetricsOnchain(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(JSON.stringify(report, null, 2))
  if (report.status === 'failed') process.exitCode = 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('normalize_coinmetrics_community_onchain failed:', error)
    process.exit(1)
  })
}
