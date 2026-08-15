import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import type { NormalizedCoinMetricsRow } from './normalize_coinmetrics_community_onchain.js'

type AuditStatus = 'complete' | 'partial' | 'failed'

interface CliArgs {
  inputPath: string
  outputPath: string
  json: boolean
}

export interface CoinMetricsOnchainAuditReport {
  schemaVersion: 1
  generatedAt: string
  status: AuditStatus
  inputPath: string
  rowCount: number
  assetCount: number
  metricCount: number
  duplicateRows: number
  outOfOrderRows: number
  nullValueRows: number
  maxTimeGapMs: number | null
  observedStartTime: string | null
  observedEndTime: string | null
  coverageByAsset: Record<string, { rows: number; metrics: string[]; start: string | null; end: string | null }>
  blockers: string[]
  nextActions: string[]
  outputHash: string | null
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/openalice_coinmetrics_onchain_audit.latest.json'

export function parseAuditCoinMetricsArgs(argv: string[]): CliArgs {
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
      resolve(dataRoot, 'normalized/onchain/coinmetrics/asset_metrics_1d.normalized.jsonl'),
    ),
    outputPath: resolve(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAuditCoinMetricsOnchain(args: CliArgs): Promise<CoinMetricsOnchainAuditReport> {
  const startedAt = new Date()
  const lines = (await readFile(args.inputPath, 'utf-8')).split('\n').map(line => line.trim()).filter(Boolean)
  const rows = lines.map(line => JSON.parse(line) as NormalizedCoinMetricsRow)
  const seen = new Set<string>()
  let duplicateRows = 0
  let outOfOrderRows = 0
  let nullValueRows = 0
  let maxTimeGapMs: number | null = null
  const coverageByAsset = new Map<string, { rows: number; metrics: Set<string>; start: string | null; end: string | null; lastTimeMs: number | null }>()

  for (const row of rows) {
    const dedupKey = `${row.asset}|${row.metric}|${row.frequency}|${row.time}`
    if (seen.has(dedupKey)) duplicateRows += 1
    else seen.add(dedupKey)
    if (row.value == null) nullValueRows += 1
    const bucket = coverageByAsset.get(row.asset) ?? { rows: 0, metrics: new Set<string>(), start: null, end: null, lastTimeMs: null }
    bucket.rows += 1
    bucket.metrics.add(row.metric)
    bucket.start = bucket.start == null || row.time < bucket.start ? row.time : bucket.start
    bucket.end = bucket.end == null || row.time > bucket.end ? row.time : bucket.end
    if (bucket.lastTimeMs != null) {
      if (row.timeMs < bucket.lastTimeMs) outOfOrderRows += 1
      const gap = row.timeMs - bucket.lastTimeMs
      if (gap > 0) maxTimeGapMs = maxTimeGapMs == null ? gap : Math.max(maxTimeGapMs, gap)
    }
    bucket.lastTimeMs = row.timeMs
    coverageByAsset.set(row.asset, bucket)
  }

  const blockers: string[] = []
  if (rows.length === 0) blockers.push('coinmetrics_normalized_rows_missing')
  if (duplicateRows > 0) blockers.push(`coinmetrics_duplicate_rows:${duplicateRows}`)
  if (outOfOrderRows > 0) blockers.push(`coinmetrics_out_of_order_rows:${outOfOrderRows}`)
  const status: AuditStatus = rows.length === 0 ? 'failed' : blockers.length === 0 ? 'complete' : 'partial'
  const coverage = Object.fromEntries([...coverageByAsset.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([asset, value]) => [asset, {
    rows: value.rows,
    metrics: [...value.metrics].sort(),
    start: value.start,
    end: value.end,
  }]))

  const report: CoinMetricsOnchainAuditReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    inputPath: args.inputPath,
    rowCount: rows.length,
    assetCount: coverageByAsset.size,
    metricCount: unique(rows.map(row => row.metric)).length,
    duplicateRows,
    outOfOrderRows,
    nullValueRows,
    maxTimeGapMs,
    observedStartTime: rows[0]?.time ?? null,
    observedEndTime: rows.at(-1)?.time ?? null,
    coverageByAsset: coverage,
    blockers,
    nextActions: blockers.length === 0
      ? ['Refresh the audit after the next Coin Metrics ingestion to keep warehouse acceptance current.']
      : ['Rebuild normalized Coin Metrics rows, then re-run this audit until duplicates and ordering issues are cleared.'],
    outputHash: null,
  }

  report.outputHash = sha256Hex(JSON.stringify({ ...report, outputHash: null }))
  const persisted = `${JSON.stringify(report, null, 2)}\n`
  await atomicWrite(args.outputPath, persisted)
  await writeEvidenceManifestForArtifact({
    job: 'coinmetrics_community_onchain_audit',
    artifactPath: args.outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: status === 'failed' ? 1 : 0,
    businessStatus: status === 'complete' ? 'pass' : status === 'partial' ? 'warn' : 'fail',
    recordsIn: report.rowCount,
    recordsOut: report.rowCount,
    errorClass: report.blockers[0] ?? null,
  })
  return report
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
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

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase())
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseAuditCoinMetricsArgs(argv)
  const report = await runAuditCoinMetricsOnchain(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(JSON.stringify(report, null, 2))
  if (report.status === 'failed') process.exitCode = 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('audit_coinmetrics_community_onchain failed:', error)
    process.exit(1)
  })
}
