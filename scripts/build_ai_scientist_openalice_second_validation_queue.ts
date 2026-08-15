import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

type QueueStatus =
  | 'blocked_missing_intake'
  | 'blocked_no_candidates'
  | 'queued_research_only'

type QueueRowStatus =
  | 'queued_research_only'
  | 'blocked_safety_violation'

interface CliArgs {
  intakePath: string
  outputPath: string | null
  maxCandidates: number
  json: boolean
}

export interface AiScientistSecondValidationGate {
  id: string
  title: string
  required: true
  currentStatus: 'missing' | 'candidate_supplied_unverified' | 'blocked'
  blockers: string[]
  evidencePaths: string[]
}

export interface AiScientistSecondValidationQueueRow {
  queueRank: number
  queueStatus: QueueRowStatus
  executionAllowed: false
  researchOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  runId: string
  runDir: string
  family: string
  candidateId: string
  intakeRank: number | null
  sourceFiles: string[]
  sourceArtifactPaths: string[]
  inheritedMetrics: Record<string, unknown>
  inheritedBlockers: string[]
  requiredValidationGates: AiScientistSecondValidationGate[]
  blockers: string[]
  nextActions: string[]
}

export interface AiScientistSecondValidationQueueReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: QueueStatus
  sourceArtifacts: {
    intake: string
  }
  counts: {
    intakeCandidates: number
    queuedCandidates: number
    blockedSafetyViolations: number
    requiredGateCount: number
    candidateSuppliedUnverifiedGateCount: number
    missingGateCount: number
  }
  queue: AiScientistSecondValidationQueueRow[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_INTAKE_PATH = 'data/research/ai_scientist_crypto_candidate_intake.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/ai_scientist_openalice_second_validation_queue.latest.json'
const DEFAULT_MAX_CANDIDATES = 8

async function main(): Promise<void> {
  const args = parseAiScientistSecondValidationQueueArgs(process.argv.slice(2))
  const report = await runAiScientistSecondValidationQueue(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseAiScientistSecondValidationQueueArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    intakePath: raw.get('intakePath') ?? DEFAULT_INTAKE_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxCandidates: parsePositiveInteger(raw.get('maxCandidates'), DEFAULT_MAX_CANDIDATES, 'maxCandidates'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAiScientistSecondValidationQueue(
  args: CliArgs,
): Promise<AiScientistSecondValidationQueueReport> {
  const startedAt = new Date()
  const intakePath = resolve(args.intakePath)
  const report = buildAiScientistSecondValidationQueueReport({
    intakePath,
    intake: await readJsonIfExists(intakePath),
    maxCandidates: args.maxCandidates,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'ai_scientist_openalice_second_validation_queue',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'queued_research_only' ? 'warn' : 'fail',
      recordsIn: report.counts.intakeCandidates,
      recordsOut: report.counts.queuedCandidates,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildAiScientistSecondValidationQueueReport(input: {
  intakePath: string
  intake: unknown
  maxCandidates?: number
  generatedAt?: string
}): AiScientistSecondValidationQueueReport {
  const intake = asRecord(input.intake)
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  const candidates = Array.isArray(intake?.candidates)
    ? intake.candidates.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const queue = candidates
    .slice(0, maxCandidates)
    .map((candidate, index) => buildQueueRow(candidate, index + 1))
  const requiredGateCount = queue.reduce((sum, row) => sum + row.requiredValidationGates.length, 0)
  const candidateSuppliedUnverifiedGateCount = queue.reduce(
    (sum, row) => sum + row.requiredValidationGates.filter(gate => gate.currentStatus === 'candidate_supplied_unverified').length,
    0,
  )
  const missingGateCount = queue.reduce(
    (sum, row) => sum + row.requiredValidationGates.filter(gate => gate.currentStatus === 'missing').length,
    0,
  )
  const status: QueueStatus = intake == null
    ? 'blocked_missing_intake'
    : candidates.length === 0
      ? 'blocked_no_candidates'
      : 'queued_research_only'
  const blockers = uniqueStrings([
    ...(intake == null ? ['ai_scientist_crypto_candidate_intake_missing'] : []),
    ...(candidates.length === 0 ? ['ai_scientist_candidates_missing'] : []),
    ...queue.flatMap(row => row.blockers.slice(0, 12).map(blocker => `${row.runId}:${blocker}`)),
    'openalice_second_validation_queued_not_completed',
    'ai_scientist_queue_research_only',
    'paper_execution_telemetry_missing',
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
      intake: resolve(input.intakePath),
    },
    counts: {
      intakeCandidates: candidates.length,
      queuedCandidates: queue.length,
      blockedSafetyViolations: queue.filter(row => row.queueStatus === 'blocked_safety_violation').length,
      requiredGateCount,
      candidateSuppliedUnverifiedGateCount,
      missingGateCount,
    },
    queue,
    blockers,
    nextActions: [
      'Reproduce queued AI-Scientist candidates inside OpenAlice with locked source manifests and PIT-safe data before any strategy claim.',
      'Run PIT audit, WFO, FDR/BY, route-cost, slippage stress, risk simulation, trial-ledger, prospective evidence, and paper telemetry checks in OpenAlice.',
      'Keep all queued rows research-only until release-gate artifacts independently prove profitability and risk control.',
    ],
    safetyNotes: [
      'This queue is diagnostic-only. It cannot authorize paper orders, live orders, promotion, leverage changes, or best_config mutations.',
      'AI-Scientist artifacts are candidate hypotheses, not OpenAlice trading evidence.',
      'No API key, secret, or passphrase values are read or emitted by this script.',
    ],
  }
}

function buildQueueRow(candidate: UnknownRecord, queueRank: number): AiScientistSecondValidationQueueRow {
  const runId = readString(candidate.runId) ?? `unknown_run_${queueRank}`
  const runDir = readString(candidate.runDir) ?? ''
  const family = readString(candidate.family) ?? 'unknown'
  const candidateId = readString(candidate.candidateId) ?? runId
  const sourceFiles = readStringArray(candidate.sourceFiles)
  const metrics = asRecord(candidate.metrics) ?? {}
  const evidence = asRecord(candidate.evidence)
  const pitAndData = asRecord(candidate.pitAndData)
  const safety = asRecord(candidate.safety)
  const inheritedBlockers = readStringArray(candidate.blockers)
  const safetyViolation =
    readBoolean(safety?.safetyViolation) === true ||
    readBoolean(safety?.promotionEligible) === true ||
    readBoolean(safety?.paperTradingAllowed) === true ||
    readBoolean(safety?.liveTradingAllowed) === true
  const requiredValidationGates = buildRequiredValidationGates({
    runDir,
    sourceFiles,
    evidence,
    pitAndData,
    inheritedBlockers,
  })
  const gateBlockers = requiredValidationGates.flatMap(gate => gate.blockers)
  const blockers = uniqueStrings([
    ...(safetyViolation ? ['safety_violation:paper_live_or_promotion_true'] : []),
    ...inheritedBlockers,
    ...gateBlockers,
    'openalice_second_validation_queued_not_completed',
    'candidate_not_execution_authority',
  ])

  return {
    queueRank,
    queueStatus: safetyViolation ? 'blocked_safety_violation' : 'queued_research_only',
    executionAllowed: false,
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    runId,
    runDir,
    family,
    candidateId,
    intakeRank: readNumber(candidate.rank),
    sourceFiles,
    sourceArtifactPaths: runDir
      ? sourceFiles.map(file => resolve(runDir, file))
      : sourceFiles,
    inheritedMetrics: {
      validationDirectionalAccuracy: readNumber(metrics.validationDirectionalAccuracy),
      validationHighConfidencePrecision: readNumber(metrics.validationHighConfidencePrecision),
      validationHighConfidenceCoverage: readNumber(metrics.validationHighConfidenceCoverage),
      meanFinalHoldoutDirectionalAccuracy: readNumber(metrics.meanFinalHoldoutDirectionalAccuracy),
      foldPassRate: readNumber(metrics.foldPassRate),
      netTotalReturn: readNumber(metrics.netTotalReturn),
      sharpeProxy: readNumber(metrics.sharpeProxy),
    },
    inheritedBlockers,
    requiredValidationGates,
    blockers,
    nextActions: [
      'Create an OpenAlice reproduction plan with frozen source files and normalized PIT-safe data inputs.',
      'Do not attach this candidate to paper/live targets until all required gates have current OpenAlice artifacts.',
    ],
  }
}

function buildRequiredValidationGates(input: {
  runDir: string
  sourceFiles: string[]
  evidence: UnknownRecord | null
  pitAndData: UnknownRecord | null
  inheritedBlockers: string[]
}): AiScientistSecondValidationGate[] {
  const hasWalkForward = readBoolean(input.evidence?.walkForwardPresent) === true
  const hasFinalHoldout = readBoolean(input.evidence?.finalHoldoutPresent) === true
  const hasFundingPolicy = readString(input.pitAndData?.fundingAvailableTimePolicy) != null
  const hasChronologicalSplit = readBoolean(input.pitAndData?.chronologicalOrEmbargoSplit) === true
  const hasLeakageControls = readBoolean(input.pitAndData?.leakageControlsPresent) === true
  const sourcePaths = input.runDir
    ? input.sourceFiles.map(file => resolve(input.runDir, file))
    : input.sourceFiles

  return [
    gate({
      id: 'locked_source_manifest',
      title: 'Locked source manifest and candidate provenance',
      currentStatus: input.sourceFiles.length > 0 ? 'candidate_supplied_unverified' : 'missing',
      blockers: input.sourceFiles.length > 0 ? ['openalice_locked_source_manifest_missing'] : ['candidate_source_files_missing'],
      evidencePaths: sourcePaths,
    }),
    gate({
      id: 'pit_audit',
      title: 'OpenAlice PIT audit with feature availability times',
      currentStatus: hasFundingPolicy && hasChronologicalSplit && hasLeakageControls
        ? 'candidate_supplied_unverified'
        : 'missing',
      blockers: ['openalice_pit_audit_missing'],
      evidencePaths: sourcePaths,
    }),
    gate({
      id: 'wfo',
      title: 'OpenAlice walk-forward optimization validation',
      currentStatus: hasWalkForward ? 'candidate_supplied_unverified' : 'missing',
      blockers: ['openalice_wfo_missing'],
      evidencePaths: sourcePaths,
    }),
    gate({
      id: 'fdr_by',
      title: 'FDR/BY multiple-testing control',
      currentStatus: 'missing',
      blockers: ['openalice_by_fdr_missing'],
      evidencePaths: [],
    }),
    gate({
      id: 'route_cost',
      title: 'Runtime route-cost and fee validation',
      currentStatus: 'missing',
      blockers: ['openalice_route_cost_validation_missing'],
      evidencePaths: [],
    }),
    gate({
      id: 'slippage_stress',
      title: 'Spread, slippage, liquidity, and stressed unwind validation',
      currentStatus: 'missing',
      blockers: ['openalice_slippage_stress_missing'],
      evidencePaths: [],
    }),
    gate({
      id: 'risk_simulation',
      title: 'OpenAlice risk simulation and concentration limits',
      currentStatus: 'missing',
      blockers: ['openalice_risk_simulation_missing'],
      evidencePaths: [],
    }),
    gate({
      id: 'trial_ledger',
      title: 'Complete trial ledger with selected and rejected trials',
      currentStatus: 'missing',
      blockers: ['openalice_trial_ledger_missing'],
      evidencePaths: [],
    }),
    gate({
      id: 'prospective_evidence',
      title: 'Prospective observation ledger with closed outcomes',
      currentStatus: 'missing',
      blockers: ['openalice_prospective_evidence_missing'],
      evidencePaths: [],
    }),
    gate({
      id: 'paper_telemetry',
      title: 'Post-gate paper execution telemetry',
      currentStatus: 'missing',
      blockers: ['paper_execution_telemetry_missing'],
      evidencePaths: [],
    }),
    gate({
      id: 'final_holdout',
      title: 'OpenAlice final holdout or embargoed OOS validation',
      currentStatus: hasFinalHoldout ? 'candidate_supplied_unverified' : 'missing',
      blockers: ['openalice_final_holdout_missing'],
      evidencePaths: sourcePaths,
    }),
  ]
}

function gate(input: Omit<AiScientistSecondValidationGate, 'required'>): AiScientistSecondValidationGate {
  return {
    ...input,
    required: true,
  }
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

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
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

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function renderConsoleSummary(report: AiScientistSecondValidationQueueReport): string {
  return [
    `AI-Scientist OpenAlice second-validation queue: ${report.status}`,
    `queued=${report.counts.queuedCandidates}/${report.counts.intakeCandidates} gates=${report.counts.requiredGateCount} missing=${report.counts.missingGateCount}`,
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
