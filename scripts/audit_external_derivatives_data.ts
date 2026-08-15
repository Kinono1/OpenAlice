import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

interface CliArgs {
  inputPath: string
  outputPath: string | null
  json: boolean
}

export interface ExternalDerivativesAuditReport {
  schemaVersion: 1
  generatedAt: string
  status: 'complete' | 'partial' | 'failed'
  inputPath: string
  rowCount: number
  symbols: string[]
  endpointCoverage: Record<string, string[]>
  eventTimeCoveragePct: number
  availableAtCoveragePct: number
  jobIdCoveragePct: number
  generatedAtCoveragePct: number
  dedupKeyCoveragePct: number
  reportPathCoveragePct: number
  manifestPathCoveragePct: number
  lineageStatusCounts: Record<string, number>
  blockers: string[]
  nextActions: string[]
}

const DEFAULT_INPUT_PATH = 'data/normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl'
const DEFAULT_OUTPUT_PATH = 'data/runtime/external_derivatives_data_audit.latest.json'
const REQUIRED_ENDPOINTS = [
  'fundingRate',
  'premiumIndex',
  'openInterest',
  'openInterestHist',
  'globalLongShortAccountRatio',
] as const

async function main(): Promise<void> {
  const args = parseAuditExternalDerivativesArgs(process.argv.slice(2))
  const report = await runAuditExternalDerivatives(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseAuditExternalDerivativesArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT
  const defaultInput = dataRoot
    ? resolve(dataRoot, 'normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl')
    : DEFAULT_INPUT_PATH
  const defaultOutput = dataRoot
    ? resolve(dataRoot, 'runtime/external_derivatives_data_audit.latest.json')
    : DEFAULT_OUTPUT_PATH
  return {
    inputPath: resolve(raw.get('inputPath') ?? raw.get('input') ?? defaultInput),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? defaultOutput),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAuditExternalDerivatives(args: CliArgs): Promise<ExternalDerivativesAuditReport> {
  const startedAt = new Date()
  let rowCount = 0
  const coverageCounts = { eventTime: 0, availableAt: 0, jobId: 0, generatedAt: 0, dedupKey: 0, reportPath: 0, manifestPath: 0 }
  const endpointSets = new Map<string, Set<string>>()
  const lineageStatusCounts: Record<string, number> = {}
  const lines = createInterface({ input: createReadStream(args.inputPath, 'utf-8'), crlfDelay: Infinity })
  for await (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const row = JSON.parse(line) as UnknownRecord
    rowCount += 1
    const symbol = readString(row.symbol)
    const endpoint = readString(row.endpointId)
    if (symbol) {
      const set = endpointSets.get(symbol) ?? new Set<string>()
      if (endpoint) set.add(endpoint)
      endpointSets.set(symbol, set)
    }
    if (readString(row.eventTime) != null && readNumber(row.eventTimeMs) != null) coverageCounts.eventTime += 1
    if (readString(row.availableAt) != null) coverageCounts.availableAt += 1
    if (readString(row.jobId) != null || readString(row.collectionRunId) != null) coverageCounts.jobId += 1
    if (readString(row.generatedAt) != null) coverageCounts.generatedAt += 1
    if (readString(row.dedupKey) != null) coverageCounts.dedupKey += 1
    if (readString(row.reportPath) != null) coverageCounts.reportPath += 1
    if (readString(row.manifestPath) != null) coverageCounts.manifestPath += 1
    const lineage = readString(row.lineageStatus) ?? 'missing'
    lineageStatusCounts[lineage] = (lineageStatusCounts[lineage] ?? 0) + 1
  }
  const symbols = [...endpointSets.keys()].sort()
  const endpointCoverage = Object.fromEntries(symbols.map(symbol => [symbol, [...(endpointSets.get(symbol) ?? [])].sort()]))
  const pct = (value: number) => rowCount === 0 ? 0 : Math.round((value / rowCount) * 1000000) / 10000
  const eventTimeCoveragePct = pct(coverageCounts.eventTime)
  const availableAtCoveragePct = pct(coverageCounts.availableAt)
  const jobIdCoveragePct = pct(coverageCounts.jobId)
  const generatedAtCoveragePct = pct(coverageCounts.generatedAt)
  const dedupKeyCoveragePct = pct(coverageCounts.dedupKey)
  const reportPathCoveragePct = pct(coverageCounts.reportPath)
  const manifestPathCoveragePct = pct(coverageCounts.manifestPath)
  const blockers = [
    ...(rowCount > 0 ? [] : ['external_derivatives_normalized_rows_missing']),
    ...symbols.flatMap(symbol => {
      const covered = new Set(endpointCoverage[symbol] ?? [])
      return REQUIRED_ENDPOINTS
        .filter(endpoint => !covered.has(endpoint))
        .map(endpoint => `external_derivatives_endpoint_missing:${symbol}:${endpoint}`)
    }),
    ...(eventTimeCoveragePct === 100 ? [] : [`external_derivatives_event_time_incomplete:${eventTimeCoveragePct}`]),
    ...(availableAtCoveragePct === 100 ? [] : [`external_derivatives_available_at_incomplete:${availableAtCoveragePct}`]),
    ...(jobIdCoveragePct === 100 ? [] : [`external_derivatives_job_id_incomplete:${jobIdCoveragePct}`]),
    ...(generatedAtCoveragePct === 100 ? [] : [`external_derivatives_generated_at_incomplete:${generatedAtCoveragePct}`]),
    ...(dedupKeyCoveragePct === 100 ? [] : [`external_derivatives_dedup_key_incomplete:${dedupKeyCoveragePct}`]),
    ...(reportPathCoveragePct === 100 ? [] : [`external_derivatives_report_path_incomplete:${reportPathCoveragePct}`]),
    ...(manifestPathCoveragePct === 100 ? [] : [`external_derivatives_manifest_path_incomplete:${manifestPathCoveragePct}`]),
  ]
  const report: ExternalDerivativesAuditReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: rowCount === 0 ? 'failed' : blockers.length === 0 ? 'complete' : 'partial',
    inputPath: args.inputPath,
    rowCount,
    symbols,
    endpointCoverage,
    eventTimeCoveragePct,
    availableAtCoveragePct,
    jobIdCoveragePct,
    generatedAtCoveragePct,
    dedupKeyCoveragePct,
    reportPathCoveragePct,
    manifestPathCoveragePct,
    lineageStatusCounts,
    blockers,
    nextActions: blockers.length === 0
      ? ['Keep derivatives normalization and audit refreshed after each raw append-only collect run.']
      : ['Fill missing endpoint coverage or missing metadata fields before using derivatives data as promotion-grade PIT input.'],
  }

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'external_derivatives_data_audit',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'failed' ? 1 : 0,
      businessStatus: report.status === 'complete' ? 'pass' : report.status === 'partial' ? 'warn' : 'fail',
      recordsIn: rowCount,
      recordsOut: rowCount,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

function renderConsoleSummary(report: ExternalDerivativesAuditReport): string {
  return [
    `external derivatives audit: ${report.status}`,
    `rows=${report.rowCount} symbols=${report.symbols.join(',') || 'none'}`,
    `eventTime=${report.eventTimeCoveragePct}% availableAt=${report.availableAtCoveragePct}% jobId=${report.jobIdCoveragePct}% generatedAt=${report.generatedAtCoveragePct}%`,
    `dedupKey=${report.dedupKeyCoveragePct}% reportPath=${report.reportPathCoveragePct}% manifestPath=${report.manifestPathCoveragePct}%`,
    `blockers=${report.blockers.slice(0, 8).join(',') || 'none'}`,
  ].join('\n')
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

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('audit_external_derivatives_data failed:', error)
    process.exit(1)
  })
}
