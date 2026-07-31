import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

type IntakeStatus =
  | 'blocked_missing_inputs'
  | 'blocked_no_candidates'
  | 'research_only_blocked'

type WarehouseStatus = 'missing' | 'present_partial' | 'present_with_required_dirs'

interface CliArgs {
  aiScientistRoot: string
  warehouseRoot: string
  outputPath: string | null
  maxRuns: number
  json: boolean
}

interface FileStats {
  files: number
  dirs: number
  bytes: number
  capped: boolean
}

interface RunArtifacts {
  runId: string
  runDir: string
  mtimeMs: number
  targetProof: UnknownRecord | null
  improvementSummary: UnknownRecord | null
  finalHoldoutEvaluation: UnknownRecord | UnknownRecord[] | null
  walkForwardEvaluation: UnknownRecord | null
  dataManifest: UnknownRecord | null
  riskReport: UnknownRecord | null
  frozenCandidate: UnknownRecord | null
  metrics: UnknownRecord | null
}

export interface AiScientistCryptoCandidateRow {
  rank: number
  runId: string
  runDir: string
  family: string
  candidateId: string
  sourceFiles: string[]
  evidence: {
    targetProofStatus: string | null
    improvementStatus: string | null
    proofStatus: string | null
    targetReached: boolean | null
    finalHoldoutPresent: boolean
    walkForwardPresent: boolean
    dataManifestPresent: boolean
    riskReportPresent: boolean
  }
  metrics: {
    validationDirectionalAccuracy: number | null
    validationHighConfidencePrecision: number | null
    validationHighConfidenceCoverage: number | null
    meanFinalHoldoutDirectionalAccuracy: number | null
    foldPassRate: number | null
    foldsCompleted: number | null
    foldsRequested: number | null
    netTotalReturn: number | null
    sharpeProxy: number | null
  }
  pitAndData: {
    holdoutNotUsedForSelection: boolean | null
    chronologicalOrEmbargoSplit: boolean
    leakageControlsPresent: boolean
    fundingFeatureActive: boolean | null
    fundingAvailableTimePolicy: string | null
    fundingJoinPolicy: string | null
    selectedFileCount: number | null
    symbolCount: number | null
    syntheticSource: boolean | null
    openAlicePitAuditPassed: false
  }
  safety: {
    researchOnly: boolean | null
    promotionEligible: boolean | null
    paperTradingAllowed: boolean | null
    liveTradingAllowed: boolean | null
    safetyViolation: boolean
  }
  openAliceIntakeDecision:
    | 'reject_safety_violation'
    | 'research_only_second_validation_required'
  blockers: string[]
  nextActions: string[]
}

export interface AiScientistCryptoCandidateIntakeReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  status: IntakeStatus
  aiScientistRoot: string
  warehouseRoot: string
  externalDataWarehouse: {
    status: WarehouseStatus
    rootExists: boolean
    requiredDirs: Array<{
      name: string
      path: string
      exists: boolean
      stats: FileStats
    }>
    optionalDirs: Array<{
      name: string
      path: string
      exists: boolean
      lifecycle: 'candidate_dependent' | 'operational_optional' | 'offline_manual'
      stats: FileStats
    }>
    recentLogFiles: string[]
    blockers: string[]
    nextActions: string[]
  }
  counts: {
    runDirsScanned: number
    sourceFilesScanned: number
    candidatesFound: number
    runsWithTargetProof: number
    runsWithFinalHoldout: number
    runsWithWalkForward: number
    runsWithFundingFeatures: number
    safetyViolations: number
    targetReached: number
  }
  candidates: AiScientistCryptoCandidateRow[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_AI_SCIENTIST_ROOT =
  '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl'
const DEFAULT_WAREHOUSE_ROOT = 'data'
const DEFAULT_OUTPUT_PATH = 'data/research/ai_scientist_crypto_candidate_intake.latest.json'
const DEFAULT_MAX_RUNS = 120
const MAX_STATS_FILES = 5_000
const REQUIRED_WAREHOUSE_DIRS = [
  { name: 'market', relativePath: 'market' },
  { name: 'external_derivatives', relativePath: 'external/derivatives' },
  { name: 'normalized', relativePath: 'normalized' },
  { name: 'manifests', relativePath: 'manifests' },
  { name: 'derived', relativePath: 'derived' },
  { name: 'runtime', relativePath: 'runtime' },
  { name: 'research', relativePath: 'research' },
] as const
const OPTIONAL_WAREHOUSE_DIRS = [
  { name: 'onchain', relativePath: 'onchain', lifecycle: 'candidate_dependent' },
  { name: 'metadata', relativePath: 'metadata', lifecycle: 'candidate_dependent' },
  { name: 'logs', relativePath: 'logs', lifecycle: 'operational_optional' },
  { name: 'offline_binance_data_vision', relativePath: 'market/binance-public', lifecycle: 'offline_manual' },
] as const

async function main(): Promise<void> {
  const args = parseAiScientistCryptoCandidateIntakeArgs(process.argv.slice(2))
  const report = await runAiScientistCryptoCandidateIntake(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseAiScientistCryptoCandidateIntakeArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    aiScientistRoot: resolve(raw.get('aiScientistRoot') ?? raw.get('root') ?? DEFAULT_AI_SCIENTIST_ROOT),
    warehouseRoot: resolve(raw.get('warehouseRoot') ?? raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT ?? DEFAULT_WAREHOUSE_ROOT),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxRuns: parsePositiveInteger(raw.get('maxRuns'), DEFAULT_MAX_RUNS, 'maxRuns'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAiScientistCryptoCandidateIntake(
  args: CliArgs,
): Promise<AiScientistCryptoCandidateIntakeReport> {
  const startedAt = new Date()
  const report = await buildAiScientistCryptoCandidateIntakeReport({
    aiScientistRoot: args.aiScientistRoot,
    warehouseRoot: args.warehouseRoot,
    maxRuns: args.maxRuns,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'ai_scientist_crypto_candidate_intake',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.candidates.length > 0 ? 'warn' : 'fail',
      recordsIn: report.counts.sourceFilesScanned,
      recordsOut: report.candidates.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export async function buildAiScientistCryptoCandidateIntakeReport(input: {
  aiScientistRoot: string
  warehouseRoot: string
  maxRuns?: number
  generatedAt?: string
}): Promise<AiScientistCryptoCandidateIntakeReport> {
  const aiScientistRoot = resolve(input.aiScientistRoot)
  const warehouseRoot = resolve(input.warehouseRoot)
  const maxRuns = input.maxRuns ?? DEFAULT_MAX_RUNS
  const warehouse = await summarizeWarehouse(warehouseRoot)
  const runArtifacts = existsSync(aiScientistRoot)
    ? await loadRunArtifacts(aiScientistRoot, maxRuns)
    : []
  const candidates = runArtifacts
    .map(summarizeRun)
    .filter((candidate): candidate is AiScientistCryptoCandidateRow => candidate != null)
    .sort(compareCandidates)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
  const counts = {
    runDirsScanned: runArtifacts.length,
    sourceFilesScanned: runArtifacts.reduce((sum, run) => sum + presentSourceFiles(run).length, 0),
    candidatesFound: candidates.length,
    runsWithTargetProof: runArtifacts.filter(run => run.targetProof).length,
    runsWithFinalHoldout: runArtifacts.filter(run => run.finalHoldoutEvaluation).length,
    runsWithWalkForward: runArtifacts.filter(run => run.walkForwardEvaluation).length,
    runsWithFundingFeatures: candidates.filter(candidate => candidate.pitAndData.fundingFeatureActive === true).length,
    safetyViolations: candidates.filter(candidate => candidate.safety.safetyViolation).length,
    targetReached: candidates.filter(candidate => candidate.evidence.targetReached === true).length,
  }
  const blockers = uniqueStrings([
    ...(existsSync(aiScientistRoot) ? [] : ['ai_scientist_crypto_root_missing']),
    ...(candidates.length > 0 ? [] : ['ai_scientist_crypto_candidates_missing']),
    ...warehouse.blockers.map(blocker => `warehouse:${blocker}`),
    ...candidates.slice(0, 12).flatMap(candidate =>
      candidate.blockers
        .filter(blocker => blocker.includes('openalice') || blocker.includes('execution') || blocker.includes('safety'))
        .slice(0, 8)
        .map(blocker => `${candidate.runId}:${blocker}`),
    ),
    'ai_scientist_intake_research_only',
    'openalice_second_validation_required_before_incubation',
  ])
  const status: IntakeStatus = !existsSync(aiScientistRoot) || !existsSync(warehouseRoot)
    ? 'blocked_missing_inputs'
    : candidates.length === 0
      ? 'blocked_no_candidates'
      : 'research_only_blocked'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status,
    aiScientistRoot,
    warehouseRoot,
    externalDataWarehouse: warehouse,
    counts,
    candidates,
    blockers,
    nextActions: [
      'Keep AI-Scientist runs as research candidates only; do not route them to paper/live targets.',
      'Import only candidates with locked source manifests into OpenAlice research incubation, then rerun PIT, WFO, FDR, route-cost, slippage, risk, trial-ledger, and prospective checks.',
      'Run data:warehouse:catalog to keep the configured OPENALICE_DATA_ROOT coverage visible beside this candidate intake artifact.',
    ],
    safetyNotes: [
      'This artifact monitors external research and data inputs; it cannot authorize paper orders, live orders, promotion, or policy mutation.',
      'AI-Scientist validation, holdout, or walk-forward outputs are hypotheses until OpenAlice reproduces them with PIT-safe features and release-gate evidence.',
      'No API key, secret, or passphrase values are read or emitted by this script.',
    ],
  }
}

async function loadRunArtifacts(root: string, maxRuns: number): Promise<RunArtifacts[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const dirs = await Promise.all(entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith('run_'))
    .map(async entry => {
      const runDir = join(root, entry.name)
      const info = await stat(runDir)
      return { runId: entry.name, runDir, mtimeMs: info.mtimeMs }
    }))
  const selected = dirs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxRuns)
  return Promise.all(selected.map(async run => ({
    ...run,
    targetProof: asRecord(await readJsonIfExists(join(run.runDir, 'target_proof.json'))),
    improvementSummary: asRecord(await readJsonIfExists(join(run.runDir, 'improvement_summary.json'))),
    finalHoldoutEvaluation: asRecordOrArray(await readJsonIfExists(join(run.runDir, 'final_holdout_evaluation.json'))),
    walkForwardEvaluation: asRecord(await readJsonIfExists(join(run.runDir, 'walk_forward_evaluation.json'))),
    dataManifest: asRecord(await readJsonIfExists(join(run.runDir, 'data_manifest.json'))),
    riskReport: asRecord(await readJsonIfExists(join(run.runDir, 'risk_report.json'))),
    frozenCandidate: asRecord(await readJsonIfExists(join(run.runDir, 'frozen_candidate.json'))),
    metrics: asRecord(await readJsonIfExists(join(run.runDir, 'metrics.json'))),
  })))
}

function summarizeRun(run: RunArtifacts): AiScientistCryptoCandidateRow | null {
  if (presentSourceFiles(run).length === 0) return null
  const bestCandidate = asRecord(run.improvementSummary?.best_candidate)
  const bestNestedCandidate = asRecord(bestCandidate?.candidate)
  const selectedHighConfidence = asRecord(bestCandidate?.selected_validation_high_confidence) ??
    asRecord(bestCandidate?.validation_high_confidence) ??
    asRecord(run.targetProof?.observed_validation_high_confidence)
  const walkRequirements = asRecord(run.walkForwardEvaluation?.requirements)
  const targetRequirements = asRecord(run.targetProof?.requirements)
  const summarySafety = asRecord(run.improvementSummary?.safety)
  const walkSafety = asRecord(run.walkForwardEvaluation?.safety)
  const riskSafety = run.riskReport
  const riskLeakageControls = asRecord(run.riskReport?.leakage_controls)
  const riskAssumptions = asRecord(run.riskReport?.backtest_assumptions)
  const stdoutMetrics = parseJsonObject(readString(bestCandidate?.stdout_tail))
  const sourceManifest = asRecord(run.walkForwardEvaluation?.source_manifest)
  const finalHoldout = normalizeFinalHoldout(run.finalHoldoutEvaluation)
  const improvementHoldoutUsed = readBoolean(run.improvementSummary?.holdout_used_for_selection)
  const holdoutNotUsed =
    readBoolean(targetRequirements?.holdout_not_used_for_selection) ??
    readBoolean(walkRequirements?.holdout_not_used_for_selection) ??
    (improvementHoldoutUsed == null ? null : !improvementHoldoutUsed)
  const promotionEligible = coalesceBoolean([
    readBoolean(bestCandidate?.promotion_eligible),
    readBoolean(summarySafety?.promotion_eligible),
    readBoolean(walkSafety?.promotion_eligible),
    readBoolean(riskSafety?.promotion_eligible),
  ])
  const paperTradingAllowed = coalesceBoolean([
    readBoolean(bestCandidate?.paper_trading_allowed),
    readBoolean(summarySafety?.paper_trading_allowed),
    readBoolean(walkSafety?.paper_trading_allowed),
    readBoolean(riskSafety?.paper_trading_allowed),
  ])
  const liveTradingAllowed = coalesceBoolean([
    readBoolean(bestCandidate?.live_trading_allowed),
    readBoolean(summarySafety?.live_trading_allowed),
    readBoolean(walkSafety?.live_trading_allowed),
    readBoolean(riskSafety?.live_trading_allowed),
  ])
  const researchOnly = coalesceBoolean([
    readBoolean(summarySafety?.research_only),
    readBoolean(walkSafety?.research_only),
    readBoolean(riskSafety?.research_only),
    readBoolean(bestCandidate?.live_trading_allowed) === false ? true : null,
  ])
  const fundingAvailableTimePolicy = readString(run.dataManifest?.funding_available_time_policy)
  const leakageControlsPresent = riskLeakageControls != null ||
    asRecord(run.walkForwardEvaluation?.folds) != null ||
    Array.isArray(run.walkForwardEvaluation?.folds)
  const chronologicalOrEmbargoSplit = [
    readString(bestCandidate?.split_policy),
    readString(riskLeakageControls?.split),
    readString(riskLeakageControls?.model_selection),
  ].some(value => value != null && (value.includes('chronological') || value.includes('embargo')))
  const safetyViolation = promotionEligible === true || paperTradingAllowed === true || liveTradingAllowed === true
  const targetProofStatus = readString(run.targetProof?.status)
  const proofStatus = readString(run.walkForwardEvaluation?.proof_status)
  const targetReached = readBoolean(run.improvementSummary?.target_reached) ??
    readBoolean(targetRequirements?.target_metric_meets_target)
  const blockers = buildCandidateBlockers({
    targetProofStatus,
    proofStatus,
    targetReached,
    finalHoldoutPresent: run.finalHoldoutEvaluation != null,
    walkForwardPresent: run.walkForwardEvaluation != null,
    holdoutNotUsed,
    leakageControlsPresent,
    chronologicalOrEmbargoSplit,
    fundingAvailableTimePolicy,
    safetyViolation,
    foldPassRate: readNumber(run.walkForwardEvaluation?.fold_pass_rate),
    minFoldPassRate: readNumber(run.walkForwardEvaluation?.min_fold_pass_rate),
  })

  return {
    rank: 0,
    runId: run.runId,
    runDir: run.runDir,
    family: inferFamily(run.runId),
    candidateId: readString(bestCandidate?.name) ??
      readString(bestNestedCandidate?.name) ??
      readString(run.frozenCandidate?.name) ??
      readString(asRecord(run.walkForwardEvaluation?.candidate)?.model) ??
      run.runId,
    sourceFiles: presentSourceFiles(run).map(path => relative(run.runDir, path)),
    evidence: {
      targetProofStatus,
      improvementStatus: readString(run.improvementSummary?.status),
      proofStatus,
      targetReached,
      finalHoldoutPresent: run.finalHoldoutEvaluation != null,
      walkForwardPresent: run.walkForwardEvaluation != null,
      dataManifestPresent: run.dataManifest != null,
      riskReportPresent: run.riskReport != null,
    },
    metrics: {
      validationDirectionalAccuracy: readNumber(run.targetProof?.observed_validation_directional_accuracy) ??
        readNumber(bestCandidate?.validation_directional_accuracy),
      validationHighConfidencePrecision: readNumber(run.targetProof?.observed_validation_high_confidence_precision) ??
        readNumber(selectedHighConfidence?.precision),
      validationHighConfidenceCoverage: readNumber(selectedHighConfidence?.coverage),
      meanFinalHoldoutDirectionalAccuracy: readNumber(run.walkForwardEvaluation?.mean_final_holdout_directional_accuracy) ??
        readNumber(finalHoldout?.final_holdout_directional_accuracy) ??
        readNumber(finalHoldout?.directional_accuracy),
      foldPassRate: readNumber(run.walkForwardEvaluation?.fold_pass_rate),
      foldsCompleted: readNumber(run.walkForwardEvaluation?.folds_completed),
      foldsRequested: readNumber(run.walkForwardEvaluation?.folds_requested),
      netTotalReturn: readNumber(stdoutMetrics?.net_total_return) ?? readNumber(run.metrics?.net_total_return),
      sharpeProxy: readNumber(stdoutMetrics?.sharpe_proxy) ?? readNumber(run.metrics?.sharpe_proxy),
    },
    pitAndData: {
      holdoutNotUsedForSelection: holdoutNotUsed,
      chronologicalOrEmbargoSplit,
      leakageControlsPresent,
      fundingFeatureActive: readBoolean(run.dataManifest?.funding_feature_active),
      fundingAvailableTimePolicy,
      fundingJoinPolicy: readString(run.dataManifest?.funding_join_policy),
      selectedFileCount: Array.isArray(run.dataManifest?.selected_files)
        ? run.dataManifest.selected_files.length
        : Array.isArray(sourceManifest?.selected_files)
          ? sourceManifest.selected_files.length
          : null,
      symbolCount: readNumber(run.dataManifest?.symbol_count),
      syntheticSource: readBoolean(run.dataManifest?.synthetic) ?? readBoolean(sourceManifest?.synthetic),
      openAlicePitAuditPassed: false,
    },
    safety: {
      researchOnly,
      promotionEligible,
      paperTradingAllowed,
      liveTradingAllowed,
      safetyViolation,
    },
    openAliceIntakeDecision: safetyViolation
      ? 'reject_safety_violation'
      : 'research_only_second_validation_required',
    blockers,
    nextActions: [
      'Reproduce this candidate inside OpenAlice with locked source manifests and PIT-safe features.',
      'Reject for trading until OpenAlice WFO, FDR, route-cost, slippage, risk, trial-ledger, prospective, and paper telemetry gates pass.',
    ],
  }
}

function buildCandidateBlockers(input: {
  targetProofStatus: string | null
  proofStatus: string | null
  targetReached: boolean | null
  finalHoldoutPresent: boolean
  walkForwardPresent: boolean
  holdoutNotUsed: boolean | null
  leakageControlsPresent: boolean
  chronologicalOrEmbargoSplit: boolean
  fundingAvailableTimePolicy: string | null
  safetyViolation: boolean
  foldPassRate: number | null
  minFoldPassRate: number | null
}): string[] {
  return uniqueStrings([
    'ai_scientist_candidate_not_execution_authority',
    'openalice_second_validation_required',
    'openalice_pit_audit_missing',
    'openalice_wfo_fdr_route_cost_slippage_risk_trial_prospective_missing',
    'paper_execution_telemetry_missing',
    ...(input.safetyViolation ? ['safety_violation:paper_live_or_promotion_true'] : []),
    ...(input.targetProofStatus && input.targetProofStatus !== 'proven'
      ? [`target_proof_status:${input.targetProofStatus}`]
      : []),
    ...(input.proofStatus && input.proofStatus !== 'proven'
      ? [`walk_forward_proof_status:${input.proofStatus}`]
      : []),
    ...(input.targetReached === false ? ['target_not_reached'] : []),
    ...(input.finalHoldoutPresent ? [] : ['final_holdout_evaluation_missing']),
    ...(input.walkForwardPresent ? [] : ['walk_forward_evaluation_missing']),
    ...(input.holdoutNotUsed === true ? [] : ['holdout_not_used_for_selection_not_proven']),
    ...(input.leakageControlsPresent ? [] : ['leakage_controls_missing']),
    ...(input.chronologicalOrEmbargoSplit ? [] : ['chronological_or_embargo_split_missing']),
    ...(input.fundingAvailableTimePolicy ? [] : ['funding_available_time_policy_missing']),
    ...(input.fundingAvailableTimePolicy && !input.fundingAvailableTimePolicy.includes('available')
      ? ['funding_available_time_policy_not_explicit']
      : []),
    ...(input.foldPassRate != null && input.minFoldPassRate != null && input.foldPassRate < input.minFoldPassRate
      ? [`fold_pass_rate_below_minimum:${round(input.foldPassRate)}<${round(input.minFoldPassRate)}`]
      : []),
  ])
}

async function summarizeWarehouse(root: string): Promise<AiScientistCryptoCandidateIntakeReport['externalDataWarehouse']> {
  const rootExists = existsSync(root)
  const requiredDirs = await Promise.all(REQUIRED_WAREHOUSE_DIRS.map(async requirement => {
    const path = join(root, requirement.relativePath)
    const exists = existsSync(path)
    return {
      name: requirement.name,
      path,
      exists,
      stats: exists ? await summarizePath(path, MAX_STATS_FILES) : emptyStats(),
    }
  }))
  const optionalDirs = await Promise.all(OPTIONAL_WAREHOUSE_DIRS.map(async requirement => {
    const path = join(root, requirement.relativePath)
    const exists = existsSync(path)
    return {
      name: requirement.name,
      path,
      exists,
      lifecycle: requirement.lifecycle,
      stats: exists ? await summarizePath(path, MAX_STATS_FILES) : emptyStats(),
    }
  }))
  const missing = requiredDirs.filter(item => !item.exists).map(item => item.name)
  const recentLogFiles = optionalDirs.find(item => item.name === 'logs')?.exists
    ? await listRecentFiles(join(root, 'logs'), 12)
    : []
  return {
    status: !rootExists
      ? 'missing'
      : missing.length === 0
        ? 'present_with_required_dirs'
        : 'present_partial',
    rootExists,
    requiredDirs,
    optionalDirs,
    recentLogFiles,
    blockers: uniqueStrings([
      ...(rootExists ? [] : ['warehouse_root_missing']),
      ...missing.map(name => `required_dir_missing:${name}`),
      ...([...requiredDirs, ...optionalDirs].some(item => item.exists && item.stats.capped)
        ? ['warehouse_stats_capped_use_catalog_for_full_audit']
        : []),
    ]),
    nextActions: [
      'Keep external downloads writing to append-only source directories under the explicitly configured OPENALICE_DATA_ROOT.',
      'Generate or refresh OpenAlice data catalog so coverage, manifests, retries, and normalized layers are tracked explicitly.',
      'Treat on-chain and metadata directories as candidate-dependent inputs, and offline Binance Data Vision inventory as manual historical evidence rather than a runtime requirement.',
    ],
  }
}

async function summarizePath(root: string, maxFiles: number): Promise<FileStats> {
  const stack = [root]
  let files = 0
  let dirs = 0
  let bytes = 0
  let capped = false
  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir) continue
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        dirs++
        stack.push(path)
      } else if (entry.isFile()) {
        files++
        try {
          bytes += (await stat(path)).size
        } catch {
          // Ignore disappearing files while downloads are active.
        }
        if (files >= maxFiles) {
          capped = true
          return { files, dirs, bytes, capped }
        }
      }
    }
  }
  return { files, dirs, bytes, capped }
}

async function listRecentFiles(root: string, limit: number): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files = await Promise.all(entries
    .filter(entry => entry.isFile())
    .map(async entry => {
      const path = join(root, entry.name)
      const info = await stat(path)
      return { path, mtimeMs: info.mtimeMs }
    }))
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map(file => file.path)
}

function presentSourceFiles(run: RunArtifacts): string[] {
  return [
    ['target_proof.json', run.targetProof],
    ['improvement_summary.json', run.improvementSummary],
    ['final_holdout_evaluation.json', run.finalHoldoutEvaluation],
    ['walk_forward_evaluation.json', run.walkForwardEvaluation],
    ['data_manifest.json', run.dataManifest],
    ['risk_report.json', run.riskReport],
    ['frozen_candidate.json', run.frozenCandidate],
    ['metrics.json', run.metrics],
  ]
    .filter(([, value]) => value != null)
    .map(([name]) => join(run.runDir, String(name)))
}

function compareCandidates(left: AiScientistCryptoCandidateRow, right: AiScientistCryptoCandidateRow): number {
  return candidateScore(right) - candidateScore(left)
}

function candidateScore(candidate: AiScientistCryptoCandidateRow): number {
  return [
    candidate.evidence.walkForwardPresent ? 20 : 0,
    candidate.evidence.finalHoldoutPresent ? 15 : 0,
    candidate.pitAndData.holdoutNotUsedForSelection ? 10 : 0,
    candidate.pitAndData.leakageControlsPresent ? 8 : 0,
    candidate.metrics.validationHighConfidencePrecision != null ? candidate.metrics.validationHighConfidencePrecision * 10 : 0,
    candidate.metrics.meanFinalHoldoutDirectionalAccuracy != null ? candidate.metrics.meanFinalHoldoutDirectionalAccuracy * 5 : 0,
    candidate.safety.safetyViolation ? -100 : 0,
  ].reduce((sum, value) => sum + value, 0)
}

function inferFamily(runId: string): string {
  if (runId.includes('funding')) return 'funding_regime'
  if (runId.includes('event')) return 'event_reversal'
  if (runId.includes('xsec')) return 'cross_sectional'
  if (runId.includes('long_history')) return 'long_history'
  if (runId.includes('regime')) return 'regime_filter'
  if (runId.includes('sentiment')) return 'sentiment'
  if (runId.includes('binance')) return 'binance_market'
  return 'crypto_dl'
}

function normalizeFinalHoldout(value: UnknownRecord | UnknownRecord[] | null): UnknownRecord | null {
  if (Array.isArray(value)) return value.map(asRecord).find((item): item is UnknownRecord => item != null) ?? null
  return asRecord(value)
}

function parseJsonObject(value: string | null): UnknownRecord | null {
  if (!value) return null
  try {
    return asRecord(JSON.parse(value.trim()))
  } catch {
    return null
  }
}

function coalesceBoolean(values: Array<boolean | null>): boolean | null {
  return values.find(value => value != null) ?? null
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null
  }
}

function asRecordOrArray(value: unknown): UnknownRecord | UnknownRecord[] | null {
  const record = asRecord(value)
  if (record) return record
  if (Array.isArray(value)) return value.map(asRecord).filter((item): item is UnknownRecord => item != null)
  return null
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

function emptyStats(): FileStats {
  return { files: 0, dirs: 0, bytes: 0, capped: false }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function renderConsoleSummary(report: AiScientistCryptoCandidateIntakeReport): string {
  return [
    `AI-Scientist crypto intake: ${report.status}`,
    `runs=${report.counts.runDirsScanned} candidates=${report.counts.candidatesFound} wfo=${report.counts.runsWithWalkForward} holdout=${report.counts.runsWithFinalHoldout}`,
    `warehouse=${report.externalDataWarehouse.status}`,
    `paper=false live=false promotion=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
