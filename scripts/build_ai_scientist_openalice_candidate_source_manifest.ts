import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

type SourceManifestStatus =
  | 'blocked_missing_queue'
  | 'blocked_no_queued_candidates'
  | 'blocked_missing_source_files'
  | 'locked_research_only'

type CandidateManifestStatus =
  | 'blocked_no_source_files'
  | 'blocked_missing_source_files'
  | 'locked'

interface CliArgs {
  queuePath: string
  outputPath: string | null
  json: boolean
}

export interface AiScientistOpenAliceSourceFileManifest {
  relativePath: string
  path: string
  exists: boolean
  sizeBytes: number | null
  mtimeMs: number | null
  sha256: string | null
  blocker: string | null
}

export interface AiScientistOpenAliceCandidateSourceManifest {
  queueRank: number | null
  runId: string
  runDir: string
  family: string
  candidateId: string
  status: CandidateManifestStatus
  files: AiScientistOpenAliceSourceFileManifest[]
  fileCount: number
  presentFileCount: number
  missingFileCount: number
  totalBytes: number
  candidateManifestHash: string | null
  blockers: string[]
}

export interface AiScientistOpenAliceSourceManifestReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: SourceManifestStatus
  sourceArtifacts: {
    queue: string
  }
  queueGeneratedAt: string | null
  counts: {
    queuedCandidates: number
    candidatesLocked: number
    candidatesWithMissingFiles: number
    sourceFilesExpected: number
    sourceFilesPresent: number
    sourceFilesMissing: number
    totalBytes: number
  }
  candidates: AiScientistOpenAliceCandidateSourceManifest[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_QUEUE_PATH = 'data/research/ai_scientist_openalice_second_validation_queue.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/ai_scientist_openalice_candidate_source_manifest.latest.json'

async function main(): Promise<void> {
  const args = parseAiScientistSourceManifestArgs(process.argv.slice(2))
  const report = await runAiScientistSourceManifest(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseAiScientistSourceManifestArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    queuePath: raw.get('queuePath') ?? DEFAULT_QUEUE_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAiScientistSourceManifest(
  args: CliArgs,
): Promise<AiScientistOpenAliceSourceManifestReport> {
  const startedAt = new Date()
  const queuePath = resolve(args.queuePath)
  const report = await buildAiScientistSourceManifestReport({
    queuePath,
    queue: await readJsonIfExists(queuePath),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'ai_scientist_openalice_candidate_source_manifest',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'locked_research_only' ? 'warn' : 'fail',
      recordsIn: report.counts.sourceFilesExpected,
      recordsOut: report.counts.sourceFilesPresent,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export async function buildAiScientistSourceManifestReport(input: {
  queuePath: string
  queue: unknown
  generatedAt?: string
}): Promise<AiScientistOpenAliceSourceManifestReport> {
  const queue = asRecord(input.queue)
  const rows = Array.isArray(queue?.queue)
    ? queue.queue.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const candidates = await Promise.all(rows.map(buildCandidateManifest))
  const counts = {
    queuedCandidates: rows.length,
    candidatesLocked: candidates.filter(candidate => candidate.status === 'locked').length,
    candidatesWithMissingFiles: candidates.filter(candidate => candidate.missingFileCount > 0).length,
    sourceFilesExpected: candidates.reduce((sum, candidate) => sum + candidate.fileCount, 0),
    sourceFilesPresent: candidates.reduce((sum, candidate) => sum + candidate.presentFileCount, 0),
    sourceFilesMissing: candidates.reduce((sum, candidate) => sum + candidate.missingFileCount, 0),
    totalBytes: candidates.reduce((sum, candidate) => sum + candidate.totalBytes, 0),
  }
  const status: SourceManifestStatus = queue == null
    ? 'blocked_missing_queue'
    : rows.length === 0
      ? 'blocked_no_queued_candidates'
      : counts.sourceFilesMissing > 0 || candidates.some(candidate => candidate.status !== 'locked')
        ? 'blocked_missing_source_files'
        : 'locked_research_only'
  const blockers = uniqueStrings([
    ...(queue == null ? ['ai_scientist_second_validation_queue_missing'] : []),
    ...(rows.length === 0 ? ['ai_scientist_second_validation_queue_empty'] : []),
    ...candidates.flatMap(candidate => candidate.blockers.map(blocker => `${candidate.runId}:${blocker}`)),
    'source_manifest_research_only',
    'openalice_second_validation_still_required',
  ])

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status,
    sourceArtifacts: {
      queue: resolve(input.queuePath),
    },
    queueGeneratedAt: readString(queue?.generatedAt),
    counts,
    candidates,
    blockers,
    nextActions: [
      'Use this manifest as the locked source input for OpenAlice PIT/WFO/FDR reproduction work.',
      'Do not use candidate source hashes as profitability evidence; they prove only provenance and file stability.',
      'Regenerate this manifest after AI-Scientist intake or second-validation queue changes.',
    ],
    safetyNotes: [
      'This manifest stores file metadata and hashes only; it does not output AI-Scientist source file contents.',
      'This artifact cannot authorize paper orders, live orders, promotion, leverage changes, or best_config mutations.',
      'No API key, secret, or passphrase values are read or emitted by this script.',
    ],
  }
}

async function buildCandidateManifest(row: UnknownRecord): Promise<AiScientistOpenAliceCandidateSourceManifest> {
  const runId = readString(row.runId) ?? 'unknown_run'
  const runDir = readString(row.runDir) ?? ''
  const family = readString(row.family) ?? 'unknown'
  const candidateId = readString(row.candidateId) ?? runId
  const sourceFiles = readStringArray(row.sourceFiles)
  const sourceArtifactPaths = readStringArray(row.sourceArtifactPaths)
  const fileInputs = sourceArtifactPaths.length > 0
    ? sourceArtifactPaths.map((path, index) => ({
        relativePath: sourceFiles[index] ?? path,
        path,
      }))
    : sourceFiles.map(file => ({
        relativePath: file,
        path: runDir ? resolve(runDir, file) : file,
      }))
  const files = await Promise.all(fileInputs.map(readSourceFileManifest))
  const presentFiles = files.filter(file => file.exists)
  const missingFiles = files.filter(file => !file.exists)
  const candidateManifestHash = presentFiles.length > 0 && missingFiles.length === 0
    ? sha256Hex(JSON.stringify(presentFiles.map(file => ({
        path: file.path,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      }))))
    : null
  const status: CandidateManifestStatus = fileInputs.length === 0
    ? 'blocked_no_source_files'
    : missingFiles.length > 0
      ? 'blocked_missing_source_files'
      : 'locked'
  const blockers = uniqueStrings([
    ...(fileInputs.length === 0 ? ['candidate_source_files_missing'] : []),
    ...missingFiles.map(file => `source_file_missing:${file.relativePath}`),
  ])

  return {
    queueRank: readNumber(row.queueRank),
    runId,
    runDir,
    family,
    candidateId,
    status,
    files,
    fileCount: files.length,
    presentFileCount: presentFiles.length,
    missingFileCount: missingFiles.length,
    totalBytes: presentFiles.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
    candidateManifestHash,
    blockers,
  }
}

async function readSourceFileManifest(input: {
  relativePath: string
  path: string
}): Promise<AiScientistOpenAliceSourceFileManifest> {
  const path = resolve(input.path)
  try {
    const [info, bytes] = await Promise.all([
      stat(path),
      readFile(path),
    ])
    return {
      relativePath: input.relativePath,
      path,
      exists: true,
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
      sha256: sha256Hex(bytes),
      blocker: null,
    }
  } catch {
    return {
      relativePath: input.relativePath,
      path,
      exists: false,
      sizeBytes: null,
      mtimeMs: null,
      sha256: null,
      blocker: `source_file_missing:${input.relativePath}`,
    }
  }
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null
  }
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    i++
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function renderConsoleSummary(report: AiScientistOpenAliceSourceManifestReport): string {
  return [
    `AI-Scientist OpenAlice source manifest: ${report.status}`,
    `locked=${report.counts.candidatesLocked}/${report.counts.queuedCandidates} files=${report.counts.sourceFilesPresent}/${report.counts.sourceFilesExpected} missing=${report.counts.sourceFilesMissing}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
