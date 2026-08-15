import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open as openFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type NormalizedFileKind = 'jsonl' | 'json' | 'csv' | 'parquet' | 'other'
type SampleStatus = 'ok' | 'empty' | 'unreadable' | 'not_json' | 'binary_not_sampled' | 'csv_header'
type CoverageStatus = 'complete' | 'blocked'
type PitReadinessStatus = 'pass' | 'blocked'
type ArtifactLifecycle = 'active_data' | 'candidate_placeholder'

interface CliArgs {
  warehouseRoot: string
  normalizedRoot: string
  outputPath: string | null
  json: boolean
}

export interface NormalizedWarehouseIndexEntry {
  path: string
  relativePath: string
  kind: NormalizedFileKind
  bytes: number
  modifiedAt: string
  manifestPath: string | null
  manifestPresent: boolean
  evidenceTrust: string | null
  businessStatus: string | null
  dqStatus: string | null
  artifactLifecycle: ArtifactLifecycle
  runtimeBlocking: boolean
  sampleStatus: SampleStatus
  sampleError: string | null
  sampledFieldNames: string[]
  pitFields: {
    schemaVersion: boolean
    sourceTrace: boolean
    exchange: boolean
    symbolOrAsset: boolean
    eventTime: boolean
    observedOrFetchedAt: boolean
    availableAt: boolean
    generatedOrIngestedAt: boolean
    jobOrRunId: boolean
    qualityOrBlockerTrace: boolean
  }
  pitContractComplete: boolean
  researchOnly: boolean | null
  promotionEligible: boolean | null
  paperTradingAllowed: boolean | null
  liveTradingAllowed: boolean | null
  executionAllowed: boolean | null
}

export interface NormalizedWarehouseIndexReport {
  schemaVersion: 1
  generatedAt: string
  warehouseRoot: string
  normalizedRoot: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: 'complete' | 'blocked'
  coverageStatus: CoverageStatus
  pitReadinessStatus: PitReadinessStatus
  summary: {
    normalizedFiles: number
    jsonlFiles: number
    jsonFiles: number
    csvFiles: number
    parquetFiles: number
    bytes: number
    sampledFiles: number
    sampleReadableFiles: number
    emptyFiles: number
    unreadableFiles: number
    notJsonFiles: number
    filesWithSidecarManifest: number
    passEvidenceTrustFiles: number
    quarantineEvidenceTrustFiles: number
    failEvidenceTrustFiles: number
    candidatePlaceholderFiles: number
    pitContractCompleteFiles: number
    pitContractCoveragePct: number
    schemaVersionCoveragePct: number
    sourceTraceCoveragePct: number
    exchangeCoveragePct: number
    symbolOrAssetCoveragePct: number
    eventTimeCoveragePct: number
    observedOrFetchedAtCoveragePct: number
    availableAtCoveragePct: number
    generatedOrIngestedAtCoveragePct: number
    jobOrRunIdCoveragePct: number
    qualityOrBlockerTraceCoveragePct: number
  }
  entries: NormalizedWarehouseIndexEntry[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  outputHash: string | null
}

const DEFAULT_WAREHOUSE_ROOT = 'data'
const SAMPLE_BYTES = 256 * 1024

async function main(): Promise<void> {
  const args = parseNormalizedWarehouseIndexArgs(process.argv.slice(2))
  const report = await runNormalizedWarehouseIndex(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseNormalizedWarehouseIndexArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const warehouseRoot = resolve(raw.get('warehouseRoot') ?? raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT ?? DEFAULT_WAREHOUSE_ROOT)
  const normalizedRoot = resolve(raw.get('normalizedRoot') ?? raw.get('parquetRoot') ?? resolve(warehouseRoot, 'normalized'))
  return {
    warehouseRoot,
    normalizedRoot,
    outputPath: parseNullablePath(
      raw.get('outputPath') ??
      raw.get('output') ??
      resolve(warehouseRoot, 'manifests/openalice_normalized_warehouse_index.latest.json'),
    ),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runNormalizedWarehouseIndex(args: CliArgs): Promise<NormalizedWarehouseIndexReport> {
  const startedAt = new Date()
  const outputPath = args.outputPath == null ? null : resolve(args.outputPath)
  const report = await buildNormalizedWarehouseIndexReport({
    generatedAt: new Date().toISOString(),
    warehouseRoot: args.warehouseRoot,
    normalizedRoot: args.normalizedRoot,
    excludePaths: outputPath == null ? [] : [outputPath, `${outputPath}.manifest.json`],
  })

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true })
    const withoutHash = `${JSON.stringify({ ...report, outputHash: null }, null, 2)}\n`
    const outputHash = sha256Hex(withoutHash)
    const finalPayload = `${JSON.stringify({ ...report, outputHash }, null, 2)}\n`
    await writeFile(outputPath, finalPayload, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'openalice_normalized_warehouse_index',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'complete' ? 'pass' : 'warn',
      recordsIn: report.summary.normalizedFiles,
      recordsOut: report.entries.length,
      errorClass: report.blockers[0] ?? null,
      artifactHash: sha256Hex(finalPayload),
    })
    return { ...report, outputHash }
  }

  return report
}

export async function buildNormalizedWarehouseIndexReport(input: {
  warehouseRoot: string
  normalizedRoot?: string
  generatedAt?: string
  excludePaths?: string[]
}): Promise<NormalizedWarehouseIndexReport> {
  const warehouseRoot = resolve(input.warehouseRoot)
  const normalizedRoot = resolve(input.normalizedRoot ?? resolve(warehouseRoot, 'parquet'))
  const excludePaths = new Set((input.excludePaths ?? []).map(path => resolve(path)))
  const paths = (await discoverNormalizedFiles(normalizedRoot))
    .map(path => resolve(path))
    .filter(path => !excludePaths.has(path))
    .sort()
  const entries = await Promise.all(paths.map(path => readNormalizedEntry(path, warehouseRoot)))
  const summary = summarize(entries)
  const blockers = buildBlockers(summary, entries)
  const coverageStatus: CoverageStatus = summary.normalizedFiles > 0 &&
    summary.emptyFiles === 0 &&
    summary.unreadableFiles === 0 &&
    summary.notJsonFiles === 0
    ? 'complete'
    : 'blocked'
  const pitReadinessStatus: PitReadinessStatus = blockers.length === 0 ? 'pass' : 'blocked'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    warehouseRoot,
    normalizedRoot,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: blockers.length === 0 ? 'complete' : 'blocked',
    coverageStatus,
    pitReadinessStatus,
    summary,
    entries,
    blockers,
    nextActions: buildNextActions(blockers),
    safetyNotes: [
      'This index is a normalized data warehouse inventory only; it does not authorize paper trading, live trading, promotion, leverage changes, or best_config mutations.',
      'Coverage-complete means local normalized files can be inventoried. PIT/trust blockers still prevent using those files as promotion evidence.',
      'Strategy promotion still requires PIT audit, WFO, FDR, route-cost, slippage, risk simulation, prospective outcomes, trial ledger, and paper execution telemetry gates.',
    ],
    outputHash: null,
  }
}

async function discoverNormalizedFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
      } else if (entry.isFile() && isNormalizedDataFile(entry.name)) {
        out.push(path)
      }
    }
  }
  return out
}

function isNormalizedDataFile(name: string): boolean {
  if (name.endsWith('.manifest.json')) return false
  return name.endsWith('.jsonl') ||
    name.endsWith('.json') ||
    name.endsWith('.csv') ||
    name.endsWith('.parquet')
}

async function readNormalizedEntry(path: string, warehouseRoot: string): Promise<NormalizedWarehouseIndexEntry> {
  const fileStat = await stat(path)
  const manifestPath = `${path}.manifest.json`
  const manifest = await readManifestSummary(manifestPath)
  const sample = await sampleFile(path)
  const fieldNames = Object.keys(sample.record ?? {}).sort()
  const pitFields = inferPitFields(sample.record, fieldNames)
  const gateFlags = inferGateFlags(sample.record)
  const artifactLifecycle = inferArtifactLifecycle(sample.status, manifest)
  return {
    path,
    relativePath: relative(warehouseRoot, path),
    kind: kindForPath(path),
    bytes: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    manifestPath: manifest.exists ? manifestPath : null,
    manifestPresent: manifest.exists,
    evidenceTrust: manifest.evidenceTrust,
    businessStatus: manifest.businessStatus,
    dqStatus: manifest.dqStatus,
    artifactLifecycle,
    runtimeBlocking: artifactLifecycle === 'active_data',
    sampleStatus: sample.status,
    sampleError: sample.error,
    sampledFieldNames: fieldNames,
    pitFields,
    pitContractComplete: Object.values(pitFields).every(Boolean),
    researchOnly: gateFlags.researchOnly,
    promotionEligible: gateFlags.promotionEligible,
    paperTradingAllowed: gateFlags.paperTradingAllowed,
    liveTradingAllowed: gateFlags.liveTradingAllowed,
    executionAllowed: gateFlags.executionAllowed,
  }
}

async function readManifestSummary(path: string): Promise<{
  exists: boolean
  evidenceTrust: string | null
  businessStatus: string | null
  dqStatus: string | null
  job: string | null
  recordsOut: number | null
  errorClass: string | null
}> {
  try {
    const raw = await readFirstBytes(path, SAMPLE_BYTES)
    const parsed = JSON.parse(raw) as unknown
    const record = asRecord(parsed)
    return {
      exists: true,
      evidenceTrust: stringOrNull(record?.evidenceTrust),
      businessStatus: stringOrNull(record?.businessStatus),
      dqStatus: stringOrNull(record?.dqStatus),
      job: stringOrNull(record?.job),
      recordsOut: numberOrNull(record?.recordsOut),
      errorClass: stringOrNull(record?.errorClass),
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      exists: code !== 'ENOENT',
      evidenceTrust: null,
      businessStatus: null,
      dqStatus: null,
      job: null,
      recordsOut: null,
      errorClass: null,
    }
  }
}

function inferArtifactLifecycle(
  sampleStatus: SampleStatus,
  manifest: {
    job: string | null
    recordsOut: number | null
    errorClass: string | null
  },
): ArtifactLifecycle {
  if (
    sampleStatus === 'empty' &&
    manifest.job === 'ai_scientist_openalice_pit_input_rows' &&
    manifest.recordsOut === 0 &&
    (manifest.errorClass === 'ai_scientist_pit_input_rows_missing' ||
      manifest.errorClass === 'ai_scientist_pit_reproduction_plan_missing')
  ) {
    return 'candidate_placeholder'
  }
  return 'active_data'
}

async function sampleFile(path: string): Promise<{
  status: SampleStatus
  error: string | null
  record: Record<string, unknown> | null
}> {
  const kind = kindForPath(path)
  if (kind === 'parquet') return { status: 'binary_not_sampled', error: null, record: null }
  let raw: string
  try {
    raw = await readFirstBytes(path, SAMPLE_BYTES)
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error), record: null }
  }
  const firstLine = raw.split('\n').find(line => line.trim() !== '')
  if (!firstLine) return { status: 'empty', error: 'normalized_file_empty', record: null }
  if (kind === 'csv') {
    const fields = firstLine.split(',').map(field => field.trim()).filter(Boolean)
    return { status: 'csv_header', error: null, record: Object.fromEntries(fields.map(field => [field, true])) }
  }
  try {
    const parsed = JSON.parse(kind === 'jsonl' ? firstLine : raw) as unknown
    return { status: 'ok', error: null, record: asRecord(parsed) }
  } catch (error) {
    return { status: 'not_json', error: error instanceof Error ? error.message : String(error), record: null }
  }
}

function inferPitFields(record: Record<string, unknown> | null, fieldNames: string[]): NormalizedWarehouseIndexEntry['pitFields'] {
  const fields = new Set(fieldNames)
  const has = (names: string[]) => names.some(name => fields.has(name) && record?.[name] != null)
  return {
    schemaVersion: has(['schemaVersion']),
    sourceTrace: has(['source', 'sourceEndpoint', 'sourceType', 'exchange']),
    exchange: has(['exchange']),
    symbolOrAsset: has(['symbol', 'asset', 'rawSymbol', 'binanceSymbol', 'instId']),
    eventTime: has(['eventTime', 'time', 'sourceTimestamp', 'timestamp', 'openTime']),
    observedOrFetchedAt: has(['observedAt', 'fetchedAt']),
    availableAt: has(['availableAt']),
    generatedOrIngestedAt: has(['generatedAt', 'ingestedAt']),
    jobOrRunId: has(['jobId', 'runId', 'collectionRunId', 'taskId']),
    qualityOrBlockerTrace: has(['coverage', 'quality', 'blockers', 'lineageStatus', 'dqStatus', 'researchOnly', 'promotionEligible']),
  }
}

function inferGateFlags(record: Record<string, unknown> | null): {
  researchOnly: boolean | null
  promotionEligible: boolean | null
  paperTradingAllowed: boolean | null
  liveTradingAllowed: boolean | null
  executionAllowed: boolean | null
} {
  return {
    researchOnly: booleanOrNull(record?.researchOnly),
    promotionEligible: booleanOrNull(record?.promotionEligible),
    paperTradingAllowed: booleanOrNull(record?.paperTradingAllowed),
    liveTradingAllowed: booleanOrNull(record?.liveTradingAllowed),
    executionAllowed: booleanOrNull(record?.executionAllowed),
  }
}

function summarize(entries: NormalizedWarehouseIndexEntry[]): NormalizedWarehouseIndexReport['summary'] {
  const activeEntries = entries.filter(entry => entry.runtimeBlocking)
  const jsonOrCsvEntries = activeEntries.filter(entry => entry.sampleStatus !== 'binary_not_sampled')
  const denominator = jsonOrCsvEntries.length
  const coverage = (count: number) => denominator === 0 ? 0 : roundPct((count / denominator) * 100)
  return {
    normalizedFiles: entries.length,
    jsonlFiles: entries.filter(entry => entry.kind === 'jsonl').length,
    jsonFiles: entries.filter(entry => entry.kind === 'json').length,
    csvFiles: entries.filter(entry => entry.kind === 'csv').length,
    parquetFiles: entries.filter(entry => entry.kind === 'parquet').length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    sampledFiles: denominator,
    sampleReadableFiles: entries.filter(entry => entry.sampleStatus === 'ok' || entry.sampleStatus === 'csv_header').length,
    emptyFiles: activeEntries.filter(entry => entry.sampleStatus === 'empty').length,
    unreadableFiles: activeEntries.filter(entry => entry.sampleStatus === 'unreadable').length,
    notJsonFiles: activeEntries.filter(entry => entry.sampleStatus === 'not_json').length,
    filesWithSidecarManifest: entries.filter(entry => entry.manifestPresent).length,
    passEvidenceTrustFiles: activeEntries.filter(entry => entry.evidenceTrust === 'pass').length,
    quarantineEvidenceTrustFiles: activeEntries.filter(entry => entry.evidenceTrust === 'quarantine').length,
    failEvidenceTrustFiles: activeEntries.filter(entry => entry.evidenceTrust === 'fail').length,
    candidatePlaceholderFiles: entries.filter(entry => entry.artifactLifecycle === 'candidate_placeholder').length,
    pitContractCompleteFiles: jsonOrCsvEntries.filter(entry => entry.pitContractComplete).length,
    pitContractCoveragePct: coverage(jsonOrCsvEntries.filter(entry => entry.pitContractComplete).length),
    schemaVersionCoveragePct: coverage(jsonOrCsvEntries.filter(entry => entry.pitFields.schemaVersion).length),
    sourceTraceCoveragePct: coverage(jsonOrCsvEntries.filter(entry => entry.pitFields.sourceTrace).length),
    exchangeCoveragePct: coverage(jsonOrCsvEntries.filter(entry => entry.pitFields.exchange).length),
    symbolOrAssetCoveragePct: coverage(jsonOrCsvEntries.filter(entry => entry.pitFields.symbolOrAsset).length),
    eventTimeCoveragePct: coverage(jsonOrCsvEntries.filter(entry => entry.pitFields.eventTime).length),
    observedOrFetchedAtCoveragePct: coverage(jsonOrCsvEntries.filter(entry => entry.pitFields.observedOrFetchedAt).length),
    availableAtCoveragePct: coverage(jsonOrCsvEntries.filter(entry => entry.pitFields.availableAt).length),
    generatedOrIngestedAtCoveragePct: coverage(jsonOrCsvEntries.filter(entry => entry.pitFields.generatedOrIngestedAt).length),
    jobOrRunIdCoveragePct: coverage(jsonOrCsvEntries.filter(entry => entry.pitFields.jobOrRunId).length),
    qualityOrBlockerTraceCoveragePct: coverage(jsonOrCsvEntries.filter(entry => entry.pitFields.qualityOrBlockerTrace).length),
  }
}

function buildBlockers(
  summary: NormalizedWarehouseIndexReport['summary'],
  entries: NormalizedWarehouseIndexEntry[],
): string[] {
  const blockers = [
    ...(summary.normalizedFiles > 0 ? [] : ['normalized_warehouse_files_missing']),
    ...(summary.emptyFiles === 0 ? [] : [`normalized_warehouse_empty_files:${summary.emptyFiles}`]),
    ...(summary.unreadableFiles === 0 ? [] : [`normalized_warehouse_unreadable_files:${summary.unreadableFiles}`]),
    ...(summary.notJsonFiles === 0 ? [] : [`normalized_warehouse_not_json_files:${summary.notJsonFiles}`]),
    ...(summary.filesWithSidecarManifest === summary.normalizedFiles ? [] : [
      `normalized_warehouse_manifest_coverage_low:${summary.filesWithSidecarManifest}/${summary.normalizedFiles}`,
    ]),
    ...(summary.failEvidenceTrustFiles === 0 ? [] : [`normalized_warehouse_evidence_trust_fail:${summary.failEvidenceTrustFiles}`]),
    ...(summary.quarantineEvidenceTrustFiles === 0 ? [] : [`normalized_warehouse_evidence_trust_quarantine:${summary.quarantineEvidenceTrustFiles}`]),
    ...(summary.candidatePlaceholderFiles === 0 ? [] : [
      `ai_scientist_normalized_candidate_placeholder_missing_rows:${summary.candidatePlaceholderFiles}`,
    ]),
    ...fieldCoverageBlockers(summary),
  ]
  const unsafeExecutionRows = entries.filter(entry =>
    entry.promotionEligible === true ||
    entry.paperTradingAllowed === true ||
    entry.liveTradingAllowed === true ||
    entry.executionAllowed === true)
  if (unsafeExecutionRows.length > 0) blockers.push(`normalized_warehouse_execution_flags_true:${unsafeExecutionRows.length}`)
  return [...new Set(blockers)].sort()
}

function fieldCoverageBlockers(summary: NormalizedWarehouseIndexReport['summary']): string[] {
  if (summary.sampledFiles === 0) return []
  const expected = [
    ['pit_contract', summary.pitContractCoveragePct],
    ['schemaVersion', summary.schemaVersionCoveragePct],
    ['sourceTrace', summary.sourceTraceCoveragePct],
    ['exchange', summary.exchangeCoveragePct],
    ['symbolOrAsset', summary.symbolOrAssetCoveragePct],
    ['eventTime', summary.eventTimeCoveragePct],
    ['observedOrFetchedAt', summary.observedOrFetchedAtCoveragePct],
    ['availableAt', summary.availableAtCoveragePct],
    ['generatedOrIngestedAt', summary.generatedOrIngestedAtCoveragePct],
    ['jobOrRunId', summary.jobOrRunIdCoveragePct],
    ['qualityOrBlockerTrace', summary.qualityOrBlockerTraceCoveragePct],
  ] as const
  return expected
    .filter(([, pct]) => pct < 100)
    .map(([name, pct]) => `normalized_warehouse_field_coverage_low:${name}:${pct}<100`)
}

function buildNextActions(blockers: string[]): string[] {
  const actions = new Set<string>()
  if (blockers.some(blocker => blocker.includes('manifest_coverage_low'))) {
    actions.add('Write sidecar evidence manifests for every normalized warehouse file before using it as reproducible strategy input.')
  }
  if (blockers.some(blocker => blocker.includes('field_coverage_low'))) {
    actions.add('Normalize warehouse rows to carry PIT-safe source, exchange/entity, eventTime, observed/fetchedAt, availableAt, generatedAt/ingestedAt, job/run id, and quality/blocker lineage fields.')
  }
  if (blockers.some(blocker => blocker.includes('evidence_trust'))) {
    actions.add('Resolve evidence trust quarantine/fail states before treating normalized warehouse rows as promotion-grade inputs.')
  }
  if (blockers.length === 0) actions.add('Keep normalized warehouse index refreshed after every materializer or normalizer run.')
  return [...actions]
}

function kindForPath(path: string): NormalizedFileKind {
  if (path.endsWith('.jsonl')) return 'jsonl'
  if (path.endsWith('.json')) return 'json'
  if (path.endsWith('.csv')) return 'csv'
  if (path.endsWith('.parquet')) return 'parquet'
  const ext = extname(path).replace(/^\./, '')
  return ext === '' ? 'other' : 'other'
}

async function readFirstBytes(path: string, limit: number): Promise<string> {
  const handle = await openFile(path, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const result = await handle.read(buffer, 0, limit, 0)
    return buffer.subarray(0, result.bytesRead).toString('utf-8')
  } finally {
    await handle.close()
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

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase())
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function roundPct(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: NormalizedWarehouseIndexReport): string {
  return [
    `OpenAlice normalized warehouse index: ${report.status}`,
    `coverage=${report.coverageStatus} pit=${report.pitReadinessStatus}`,
    `files=${report.summary.normalizedFiles} jsonl=${report.summary.jsonlFiles} parquet=${report.summary.parquetFiles} manifests=${report.summary.filesWithSidecarManifest}/${report.summary.normalizedFiles}`,
    `pitContract=${report.summary.pitContractCompleteFiles}/${report.summary.sampledFiles} (${report.summary.pitContractCoveragePct}%)`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `topBlockers=${report.blockers.slice(0, 8).join(',')}` : 'topBlockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
