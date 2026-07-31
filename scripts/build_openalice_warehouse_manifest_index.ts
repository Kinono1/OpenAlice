import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type ManifestParseStatus = 'ok' | 'jsonl' | 'empty' | 'unreadable' | 'not_json'
type ManifestKind = 'evidence_manifest_json' | 'manifest_jsonl'

interface CliArgs {
  warehouseRoot: string
  outputPath: string | null
  json: boolean
}

export interface WarehouseManifestIndexEntry {
  path: string
  relativePath: string
  kind: ManifestKind
  bytes: number
  modifiedAt: string
  lineCount: number | null
  parseStatus: ManifestParseStatus
  parseError: string | null
  job: string | null
  artifactPath: string | null
  manifestPath: string | null
  businessStatus: string | null
  evidenceTrust: string | null
  dqStatus: string | null
  artifactHash: string | null
}

export interface WarehouseManifestIndexReport {
  schemaVersion: 1
  generatedAt: string
  warehouseRoot: string
  manifestRoot: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: 'complete' | 'blocked'
  summary: {
    manifestFiles: number
    evidenceManifestJsonFiles: number
    manifestJsonlFiles: number
    bytes: number
    readableFiles: number
    emptyFiles: number
    unreadableFiles: number
    notJsonFiles: number
    passEvidenceTrustFiles: number
    quarantineEvidenceTrustFiles: number
    failEvidenceTrustFiles: number
  }
  entries: WarehouseManifestIndexEntry[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  outputHash: string | null
}

const DEFAULT_WAREHOUSE_ROOT = 'data'

async function main(): Promise<void> {
  const args = parseWarehouseManifestIndexArgs(process.argv.slice(2))
  const report = await runWarehouseManifestIndex(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseWarehouseManifestIndexArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const warehouseRoot = resolve(raw.get('warehouseRoot') ?? raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT ?? DEFAULT_WAREHOUSE_ROOT)
  return {
    warehouseRoot,
    outputPath: parseNullablePath(
      raw.get('outputPath') ??
      raw.get('output') ??
      resolve(warehouseRoot, 'manifests/openalice_warehouse_manifest_index.latest.json'),
    ),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runWarehouseManifestIndex(args: CliArgs): Promise<WarehouseManifestIndexReport> {
  const startedAt = new Date()
  const outputPath = args.outputPath == null ? null : resolve(args.outputPath)
  const report = await buildWarehouseManifestIndexReport({
    generatedAt: new Date().toISOString(),
    warehouseRoot: args.warehouseRoot,
    excludePaths: outputPath == null ? [] : [outputPath, `${outputPath}.manifest.json`],
  })

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true })
    const withoutHash = `${JSON.stringify({ ...report, outputHash: null }, null, 2)}\n`
    const outputHash = sha256Hex(withoutHash)
    const finalPayload = `${JSON.stringify({ ...report, outputHash }, null, 2)}\n`
    await writeFile(outputPath, finalPayload, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'openalice_warehouse_manifest_index',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'complete' ? 'pass' : 'fail',
      recordsIn: report.summary.manifestFiles,
      recordsOut: report.entries.length,
      errorClass: report.blockers[0] ?? null,
      artifactHash: sha256Hex(finalPayload),
    })
    return { ...report, outputHash }
  }

  return report
}

export async function buildWarehouseManifestIndexReport(input: {
  warehouseRoot: string
  generatedAt?: string
  excludePaths?: string[]
}): Promise<WarehouseManifestIndexReport> {
  const warehouseRoot = resolve(input.warehouseRoot)
  const manifestRoot = resolve(warehouseRoot, 'manifests')
  const excludePaths = new Set((input.excludePaths ?? []).map(path => resolve(path)))
  const manifestPaths = (await discoverManifestFiles(warehouseRoot))
    .map(path => resolve(path))
    .filter(path => !excludePaths.has(path))
    .sort()
  const entries = await Promise.all(manifestPaths.map(path => readManifestEntry(path, warehouseRoot)))
  const summary = {
    manifestFiles: entries.length,
    evidenceManifestJsonFiles: entries.filter(entry => entry.kind === 'evidence_manifest_json').length,
    manifestJsonlFiles: entries.filter(entry => entry.kind === 'manifest_jsonl').length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    readableFiles: entries.filter(entry => entry.parseStatus === 'ok' || entry.parseStatus === 'jsonl').length,
    emptyFiles: entries.filter(entry => entry.parseStatus === 'empty').length,
    unreadableFiles: entries.filter(entry => entry.parseStatus === 'unreadable').length,
    notJsonFiles: entries.filter(entry => entry.parseStatus === 'not_json').length,
    passEvidenceTrustFiles: entries.filter(entry => entry.evidenceTrust === 'pass').length,
    quarantineEvidenceTrustFiles: entries.filter(entry => entry.evidenceTrust === 'quarantine').length,
    failEvidenceTrustFiles: entries.filter(entry => entry.evidenceTrust === 'fail').length,
  }
  const blockers = [
    ...(summary.manifestFiles > 0 ? [] : ['warehouse_manifest_files_missing']),
    ...(summary.emptyFiles === 0 ? [] : [`warehouse_manifest_empty_files:${summary.emptyFiles}`]),
    ...(summary.unreadableFiles === 0 ? [] : [`warehouse_manifest_unreadable_files:${summary.unreadableFiles}`]),
    ...(summary.notJsonFiles === 0 ? [] : [`warehouse_manifest_not_json_files:${summary.notJsonFiles}`]),
  ]

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    warehouseRoot,
    manifestRoot,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: blockers.length === 0 ? 'complete' : 'blocked',
    summary,
    entries,
    blockers,
    nextActions: blockers.length === 0
      ? ['Keep this warehouse manifest index refreshed after collector, normalizer, or audit jobs write new manifests.']
      : ['Write or repair warehouse manifest files before treating warehouse datasets as reproducible inputs.'],
    safetyNotes: [
      'This index is a data-lineage inventory only; it does not authorize paper trading, live trading, promotion, leverage changes, or best_config mutations.',
      'Manifest presence is not profitability evidence. Strategy promotion still requires PIT, WFO, FDR, route-cost, slippage, risk, prospective, and paper telemetry gates.',
    ],
    outputHash: null,
  }
}

async function discoverManifestFiles(root: string): Promise<string[]> {
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
      } else if (entry.isFile() && isManifestFileName(entry.name)) {
        out.push(path)
      }
    }
  }
  return out
}

function isManifestFileName(name: string): boolean {
  return name.endsWith('.manifest.json') ||
    name.endsWith('.manifest.jsonl') ||
    /^manifest\..+\.jsonl$/.test(name)
}

async function readManifestEntry(path: string, warehouseRoot: string): Promise<WarehouseManifestIndexEntry> {
  const fileStat = await stat(path)
  const raw = await readText(path)
  const kind: ManifestKind = path.endsWith('.manifest.json') ? 'evidence_manifest_json' : 'manifest_jsonl'
  const base = {
    path,
    relativePath: relative(warehouseRoot, path),
    kind,
    bytes: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
  }
  if (raw == null) {
    return entryFromParsed(base, null, null, 'unreadable', 'failed_to_read_manifest_file')
  }
  const lines = raw.split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) {
    return entryFromParsed(base, null, 0, 'empty', 'manifest_file_empty')
  }
  const payload = kind === 'evidence_manifest_json' ? raw : lines[0]
  try {
    const parsed = JSON.parse(payload) as unknown
    return entryFromParsed(base, asRecord(parsed), kind === 'manifest_jsonl' ? lines.length : null, kind === 'manifest_jsonl' ? 'jsonl' : 'ok', null)
  } catch (error) {
    return entryFromParsed(base, null, kind === 'manifest_jsonl' ? lines.length : null, 'not_json', error instanceof Error ? error.message : String(error))
  }
}

function entryFromParsed(
  base: Omit<WarehouseManifestIndexEntry, 'lineCount' | 'parseStatus' | 'parseError' | 'job' | 'artifactPath' | 'manifestPath' | 'businessStatus' | 'evidenceTrust' | 'dqStatus' | 'artifactHash'>,
  parsed: Record<string, unknown> | null,
  lineCount: number | null,
  parseStatus: ManifestParseStatus,
  parseError: string | null,
): WarehouseManifestIndexEntry {
  return {
    ...base,
    lineCount,
    parseStatus,
    parseError,
    job: stringOrNull(parsed?.job),
    artifactPath: stringOrNull(parsed?.artifactPath),
    manifestPath: stringOrNull(parsed?.manifestPath),
    businessStatus: stringOrNull(parsed?.businessStatus),
    evidenceTrust: stringOrNull(parsed?.evidenceTrust),
    dqStatus: stringOrNull(parsed?.dqStatus),
    artifactHash: stringOrNull(parsed?.artifactHash),
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
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

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: WarehouseManifestIndexReport): string {
  return [
    `OpenAlice warehouse manifest index: ${report.status}`,
    `manifests=${report.summary.manifestFiles} json=${report.summary.evidenceManifestJsonFiles} jsonl=${report.summary.manifestJsonlFiles}`,
    `readable=${report.summary.readableFiles} empty=${report.summary.emptyFiles} unreadable=${report.summary.unreadableFiles} notJson=${report.summary.notJsonFiles}`,
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
