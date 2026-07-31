import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

type ReadinessStatus =
  | 'blocked_missing_inputs'
  | 'blocked_no_candidates'
  | 'blocked_openalice_validation_missing'

type GateReadinessStatus =
  | 'ready_for_reproduction'
  | 'candidate_supplied_unverified'
  | 'missing_openalice_evidence'
  | 'blocked'

interface CliArgs {
  queuePath: string
  sourceManifestPath: string
  outputPath: string | null
  json: boolean
}

export interface AiScientistSecondValidationGateReadiness {
  id: string
  title: string
  status: GateReadinessStatus
  required: true
  evidencePaths: string[]
  blockers: string[]
  nextAction: string
}

export interface AiScientistSecondValidationCandidateReadiness {
  queueRank: number | null
  runId: string
  family: string
  candidateId: string
  researchOnly: true
  executionAllowed: false
  sourceManifestStatus: string | null
  sourceFilesPresent: number
  sourceFilesMissing: number
  gates: AiScientistSecondValidationGateReadiness[]
  readyForOpenAliceReproduction: boolean
  openAliceValidationComplete: false
  missingOpenAliceGateCount: number
  nextGateId: string | null
  blockers: string[]
}

export interface AiScientistSecondValidationReadinessReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: ReadinessStatus
  sourceArtifacts: {
    queue: string
    sourceManifest: string
  }
  counts: {
    queuedCandidates: number
    candidatesReadyForOpenAliceReproduction: number
    totalGates: number
    candidateSuppliedUnverifiedGates: number
    readyForReproductionGates: number
    missingOpenAliceEvidenceGates: number
    blockedGates: number
  }
  candidates: AiScientistSecondValidationCandidateReadiness[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_QUEUE_PATH = 'data/research/ai_scientist_openalice_second_validation_queue.latest.json'
const DEFAULT_SOURCE_MANIFEST_PATH = 'data/research/ai_scientist_openalice_candidate_source_manifest.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/ai_scientist_openalice_second_validation_readiness.latest.json'

async function main(): Promise<void> {
  const args = parseAiScientistSecondValidationReadinessArgs(process.argv.slice(2))
  const report = await runAiScientistSecondValidationReadiness(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseAiScientistSecondValidationReadinessArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    queuePath: raw.get('queuePath') ?? DEFAULT_QUEUE_PATH,
    sourceManifestPath: raw.get('sourceManifestPath') ?? DEFAULT_SOURCE_MANIFEST_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAiScientistSecondValidationReadiness(
  args: CliArgs,
): Promise<AiScientistSecondValidationReadinessReport> {
  const startedAt = new Date()
  const queuePath = resolve(args.queuePath)
  const sourceManifestPath = resolve(args.sourceManifestPath)
  const report = buildAiScientistSecondValidationReadinessReport({
    queuePath,
    sourceManifestPath,
    queue: await readJsonIfExists(queuePath),
    sourceManifest: await readJsonIfExists(sourceManifestPath),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'ai_scientist_openalice_second_validation_readiness',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: 'fail',
      recordsIn: report.counts.queuedCandidates,
      recordsOut: report.counts.totalGates,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildAiScientistSecondValidationReadinessReport(input: {
  queuePath: string
  sourceManifestPath: string
  queue: unknown
  sourceManifest: unknown
  generatedAt?: string
}): AiScientistSecondValidationReadinessReport {
  const queue = asRecord(input.queue)
  const sourceManifest = asRecord(input.sourceManifest)
  const rows = Array.isArray(queue?.queue)
    ? queue.queue.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const sourceCandidates = Array.isArray(sourceManifest?.candidates)
    ? sourceManifest.candidates.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const sourceByRunId = new Map(sourceCandidates.map(candidate => [readString(candidate.runId) ?? '', candidate]))
  const candidates = rows.map(row => buildCandidateReadiness(row, sourceByRunId.get(readString(row.runId) ?? '') ?? null))
  const allGates = candidates.flatMap(candidate => candidate.gates)
  const counts = {
    queuedCandidates: rows.length,
    candidatesReadyForOpenAliceReproduction: candidates.filter(candidate => candidate.readyForOpenAliceReproduction).length,
    totalGates: allGates.length,
    candidateSuppliedUnverifiedGates: allGates.filter(gate => gate.status === 'candidate_supplied_unverified').length,
    readyForReproductionGates: allGates.filter(gate => gate.status === 'ready_for_reproduction').length,
    missingOpenAliceEvidenceGates: allGates.filter(gate => gate.status === 'missing_openalice_evidence').length,
    blockedGates: allGates.filter(gate => gate.status === 'blocked').length,
  }
  const status: ReadinessStatus = !queue || !sourceManifest
    ? 'blocked_missing_inputs'
    : rows.length === 0
      ? 'blocked_no_candidates'
      : 'blocked_openalice_validation_missing'
  const blockers = uniqueStrings([
    ...(queue ? [] : ['ai_scientist_second_validation_queue_missing']),
    ...(sourceManifest ? [] : ['ai_scientist_candidate_source_manifest_missing']),
    ...(rows.length > 0 ? [] : ['ai_scientist_second_validation_queue_empty']),
    ...candidates.flatMap(candidate => candidate.blockers.slice(0, 16).map(blocker => `${candidate.runId}:${blocker}`)),
    'openalice_second_validation_readiness_research_only',
    'openalice_validation_gates_not_complete',
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
      sourceManifest: resolve(input.sourceManifestPath),
    },
    counts,
    candidates,
    blockers,
    nextActions: [
      'Start with the top ready-for-reproduction candidate and build OpenAlice-native PIT/WFO evidence from the locked source manifest.',
      'Do not promote any AI-Scientist candidate until every missing OpenAlice gate has current artifacts and release gates pass.',
      'Use candidate-supplied metrics only to prioritize reproduction, not as trading evidence.',
    ],
    safetyNotes: [
      'This readiness matrix is diagnostic-only and cannot authorize paper or live execution.',
      'readyForOpenAliceReproduction means provenance is locked enough to start research reproduction; it is not profitability proof.',
      'No API key, secret, or passphrase values are read or emitted by this script.',
    ],
  }
}

function buildCandidateReadiness(
  row: UnknownRecord,
  sourceCandidate: UnknownRecord | null,
): AiScientistSecondValidationCandidateReadiness {
  const runId = readString(row.runId) ?? 'unknown_run'
  const sourceStatus = readString(sourceCandidate?.status)
  const sourceFilesMissing = readNumber(sourceCandidate?.missingFileCount) ?? 0
  const sourceFilesPresent = readNumber(sourceCandidate?.presentFileCount) ?? 0
  const sourceLocked = sourceStatus === 'locked' && sourceFilesPresent > 0 && sourceFilesMissing === 0
  const gates = readGateRecords(row.requiredValidationGates).map(gateRecord =>
    buildGateReadiness(gateRecord, sourceLocked),
  )
  const missingOpenAliceGateCount = gates.filter(gate =>
    gate.status === 'missing_openalice_evidence' ||
    gate.status === 'candidate_supplied_unverified' ||
    gate.status === 'blocked').length
  const nextGate = gates.find(gate => gate.status !== 'ready_for_reproduction') ?? null
  const blockers = uniqueStrings([
    ...(sourceLocked ? [] : ['locked_source_manifest_not_ready']),
    ...gates.flatMap(gate => gate.blockers),
    'openalice_second_validation_not_complete',
  ])

  return {
    queueRank: readNumber(row.queueRank),
    runId,
    family: readString(row.family) ?? 'unknown',
    candidateId: readString(row.candidateId) ?? runId,
    researchOnly: true,
    executionAllowed: false,
    sourceManifestStatus: sourceStatus,
    sourceFilesPresent,
    sourceFilesMissing,
    gates,
    readyForOpenAliceReproduction: sourceLocked,
    openAliceValidationComplete: false,
    missingOpenAliceGateCount,
    nextGateId: nextGate?.id ?? null,
    blockers,
  }
}

function buildGateReadiness(
  gateRecord: UnknownRecord,
  sourceLocked: boolean,
): AiScientistSecondValidationGateReadiness {
  const id = readString(gateRecord.id) ?? 'unknown_gate'
  const queueStatus = readString(gateRecord.currentStatus)
  const queueBlockers = readStringArray(gateRecord.blockers)
  const evidencePaths = readStringArray(gateRecord.evidencePaths)
  if (id === 'locked_source_manifest') {
    return {
      id,
      title: readString(gateRecord.title) ?? id,
      status: sourceLocked ? 'ready_for_reproduction' : 'blocked',
      required: true,
      evidencePaths,
      blockers: sourceLocked ? [] : ['locked_source_manifest_not_ready'],
      nextAction: sourceLocked
        ? 'Use the locked source manifest as the reproduction input for OpenAlice-native validation.'
        : 'Generate a locked source manifest with all queued source files present and hashed.',
    }
  }
  const status: GateReadinessStatus = queueStatus === 'candidate_supplied_unverified'
    ? 'candidate_supplied_unverified'
    : 'missing_openalice_evidence'
  return {
    id,
    title: readString(gateRecord.title) ?? id,
    status,
    required: true,
    evidencePaths,
    blockers: queueBlockers.length > 0 ? queueBlockers : [`${id}_missing`],
    nextAction: nextActionForGate(id, status),
  }
}

function nextActionForGate(id: string, status: GateReadinessStatus): string {
  if (status === 'candidate_supplied_unverified') {
    return `Reproduce candidate-supplied ${id} evidence inside OpenAlice before using it.`
  }
  const byGate: Record<string, string> = {
    pit_audit: 'Build OpenAlice PIT audit with observedAt/availableAt for every feature.',
    wfo: 'Run OpenAlice walk-forward validation with locked manifests and route-cost adjusted labels.',
    fdr_by: 'Register trials and compute BY/FDR inputs across selected and rejected candidates.',
    route_cost: 'Attach runtime fee and route-cost validation to the reproduced candidate.',
    slippage_stress: 'Run spread, liquidity, slippage, and stressed unwind checks.',
    risk_simulation: 'Run portfolio/risk simulation including concentration and drawdown limits.',
    trial_ledger: 'Write a complete trial ledger with failed, rejected, and selected trials.',
    prospective_evidence: 'Capture future-only prospective observations and settle closed outcomes.',
    paper_telemetry: 'Collect post-release-gate paper execution telemetry only after gates permit it.',
    final_holdout: 'Run OpenAlice final holdout or embargoed OOS validation.',
  }
  return byGate[id] ?? `Create OpenAlice-native evidence for ${id}.`
}

function readGateRecords(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null
  }
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

function renderConsoleSummary(report: AiScientistSecondValidationReadinessReport): string {
  return [
    `AI-Scientist second-validation readiness: ${report.status}`,
    `ready=${report.counts.candidatesReadyForOpenAliceReproduction}/${report.counts.queuedCandidates} gates=${report.counts.totalGates} missing=${report.counts.missingOpenAliceEvidenceGates}`,
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
