import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

type PitPlanStatus =
  | 'blocked_missing_inputs'
  | 'blocked_no_candidates'
  | 'blocked_pit_contract_missing'
  | 'ready_for_openalice_pit_reproduction'

type PitAuditStatus = 'blocked' | 'ready_for_reproduction'

type WarehouseLinkStatus =
  | 'linked_to_complete_openalice_warehouse_dataset'
  | 'linked_to_partial_openalice_warehouse_dataset'
  | 'not_openalice_warehouse_path'
  | 'no_catalog_match'
  | 'missing_file'

interface CliArgs {
  queuePath: string
  sourceManifestPath: string
  readinessPath: string
  dataCatalogPath: string
  aiScientistRoot: string
  maxCandidates: number
  outputPath: string | null
  json: boolean
}

interface CatalogDataset {
  datasetId: string
  status: string | null
  storagePath: string
}

export interface AiScientistPitInputFilePlan {
  relativePath: string
  path: string
  kind: 'csv' | 'json' | 'other'
  exists: boolean
  sizeBytes: number | null
  columns: string[]
  hasEventTime: boolean
  hasObservedAt: boolean
  hasFetchedAt: boolean
  hasAvailableAt: boolean
  explicitAvailableAt: boolean
  eventTimePolicy: string
  availableTimePolicy: string
  warehouseLinkStatus: WarehouseLinkStatus
  matchingCatalogDatasetIds: string[]
  blockers: string[]
}

export interface AiScientistPitFoldPlan {
  fold: number | null
  dataDir: string | null
  runDir: string | null
  dataManifestPath: string | null
  dataManifestExists: boolean
  selectedStrategy: string | null
  status: string | null
  researchOnly: boolean | null
  promotionEligible: boolean | null
  paperTradingAllowed: boolean | null
  liveTradingAllowed: boolean | null
  labelWindowSeparationAsserted: boolean | null
  selectedFiles: string[]
  availableTimePolicies: Record<string, string>
  blockers: string[]
}

export interface AiScientistPitCandidatePlan {
  queueRank: number | null
  runId: string
  runDir: string
  family: string
  candidateId: string
  evaluationPath: string | null
  evaluationExists: boolean
  readinessNextGateId: string | null
  sourceManifestStatus: string | null
  pitAuditStatus: PitAuditStatus
  openAlicePitAuditPassed: false
  proofStatus: string | null
  foldPassRate: number | null
  selectedSource: string | null
  selectedSourcePath: string | null
  selectedSynthetic: boolean | null
  model: string | null
  featureSet: string | null
  targetMode: string | null
  horizon: number | null
  lookback: number | null
  inputFiles: AiScientistPitInputFilePlan[]
  folds: AiScientistPitFoldPlan[]
  blockers: string[]
  nextActions: string[]
}

export interface AiScientistPitReproductionPlanReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: PitPlanStatus
  sourceArtifacts: {
    queue: string
    sourceManifest: string
    readiness: string
    dataCatalog: string
  }
  counts: {
    queuedCandidates: number
    candidatesPlanned: number
    candidatesReadyForOpenAlicePitReproduction: number
    inputFiles: number
    csvInputFiles: number
    csvFilesWithExplicitAvailableAt: number
    csvFilesWithObservedOrFetchedAt: number
    missingInputFiles: number
    foldManifestsFound: number
    foldManifestsWithAvailableTimePolicy: number
    openAliceWarehouseLinkedInputs: number
  }
  candidates: AiScientistPitCandidatePlan[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_QUEUE_PATH = 'data/research/ai_scientist_openalice_second_validation_queue.latest.json'
const DEFAULT_SOURCE_MANIFEST_PATH = 'data/research/ai_scientist_openalice_candidate_source_manifest.latest.json'
const DEFAULT_READINESS_PATH = 'data/research/ai_scientist_openalice_second_validation_readiness.latest.json'
const DEFAULT_DATA_CATALOG_PATH = 'data/runtime/openalice_data_catalog.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/ai_scientist_openalice_pit_reproduction_plan.latest.json'
const DEFAULT_AI_SCIENTIST_ROOT = '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl'

async function main(): Promise<void> {
  const args = parseAiScientistPitReproductionPlanArgs(process.argv.slice(2))
  const report = await runAiScientistPitReproductionPlan(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseAiScientistPitReproductionPlanArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    queuePath: raw.get('queuePath') ?? DEFAULT_QUEUE_PATH,
    sourceManifestPath: raw.get('sourceManifestPath') ?? DEFAULT_SOURCE_MANIFEST_PATH,
    readinessPath: raw.get('readinessPath') ?? DEFAULT_READINESS_PATH,
    dataCatalogPath: raw.get('dataCatalogPath') ?? DEFAULT_DATA_CATALOG_PATH,
    aiScientistRoot: raw.get('aiScientistRoot') ?? DEFAULT_AI_SCIENTIST_ROOT,
    maxCandidates: parsePositiveInteger(raw.get('maxCandidates'), 3),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAiScientistPitReproductionPlan(
  args: CliArgs,
): Promise<AiScientistPitReproductionPlanReport> {
  const startedAt = new Date()
  const queuePath = resolve(args.queuePath)
  const sourceManifestPath = resolve(args.sourceManifestPath)
  const readinessPath = resolve(args.readinessPath)
  const dataCatalogPath = resolve(args.dataCatalogPath)
  const report = await buildAiScientistPitReproductionPlanReport({
    queuePath,
    sourceManifestPath,
    readinessPath,
    dataCatalogPath,
    aiScientistRoot: resolve(args.aiScientistRoot),
    maxCandidates: args.maxCandidates,
    queue: await readJsonIfExists(queuePath),
    sourceManifest: await readJsonIfExists(sourceManifestPath),
    readiness: await readJsonIfExists(readinessPath),
    dataCatalog: await readJsonIfExists(dataCatalogPath),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'ai_scientist_openalice_pit_reproduction_plan',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'ready_for_openalice_pit_reproduction' ? 'warn' : 'fail',
      recordsIn: report.counts.queuedCandidates,
      recordsOut: report.counts.inputFiles,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export async function buildAiScientistPitReproductionPlanReport(input: {
  queuePath: string
  sourceManifestPath: string
  readinessPath: string
  dataCatalogPath: string
  aiScientistRoot: string
  maxCandidates: number
  queue: unknown
  sourceManifest: unknown
  readiness: unknown
  dataCatalog: unknown
  generatedAt?: string
}): Promise<AiScientistPitReproductionPlanReport> {
  const queue = asRecord(input.queue)
  const sourceManifest = asRecord(input.sourceManifest)
  const readiness = asRecord(input.readiness)
  const warehouseRoot = resolve(
    readString(asRecord(input.dataCatalog)?.warehouseRoot) ??
    process.env.OPENALICE_DATA_ROOT ??
    'data',
  )
  const catalogDatasets = readCatalogDatasets(input.dataCatalog)
  const queueRows = Array.isArray(queue?.queue)
    ? queue.queue.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const sourceCandidates = Array.isArray(sourceManifest?.candidates)
    ? sourceManifest.candidates.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const readinessCandidates = Array.isArray(readiness?.candidates)
    ? readiness.candidates.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const sourceByRunId = new Map(sourceCandidates.map(candidate => [readString(candidate.runId) ?? '', candidate]))
  const readinessByRunId = new Map(readinessCandidates.map(candidate => [readString(candidate.runId) ?? '', candidate]))
  const candidates = await Promise.all(queueRows
    .slice(0, Math.max(0, input.maxCandidates))
    .map(row => buildCandidatePlan({
      row,
      sourceCandidate: sourceByRunId.get(readString(row.runId) ?? '') ?? null,
      readinessCandidate: readinessByRunId.get(readString(row.runId) ?? '') ?? null,
      aiScientistRoot: input.aiScientistRoot,
      catalogDatasets,
      warehouseRoot,
    })))
  const inputFiles = candidates.flatMap(candidate => candidate.inputFiles)
  const csvInputFiles = inputFiles.filter(file => file.kind === 'csv')
  const folds = candidates.flatMap(candidate => candidate.folds)
  const counts = {
    queuedCandidates: queueRows.length,
    candidatesPlanned: candidates.length,
    candidatesReadyForOpenAlicePitReproduction: candidates.filter(candidate => candidate.pitAuditStatus === 'ready_for_reproduction').length,
    inputFiles: inputFiles.length,
    csvInputFiles: csvInputFiles.length,
    csvFilesWithExplicitAvailableAt: csvInputFiles.filter(file => file.explicitAvailableAt).length,
    csvFilesWithObservedOrFetchedAt: csvInputFiles.filter(file => file.hasObservedAt || file.hasFetchedAt).length,
    missingInputFiles: inputFiles.filter(file => !file.exists).length,
    foldManifestsFound: folds.filter(fold => fold.dataManifestExists).length,
    foldManifestsWithAvailableTimePolicy: folds.filter(fold => Object.keys(fold.availableTimePolicies).length > 0).length,
    openAliceWarehouseLinkedInputs: inputFiles.filter(file => file.warehouseLinkStatus === 'linked_to_complete_openalice_warehouse_dataset').length,
  }
  const blockers = uniqueStrings([
    ...(queue ? [] : ['ai_scientist_second_validation_queue_missing']),
    ...(sourceManifest ? [] : ['ai_scientist_candidate_source_manifest_missing']),
    ...(readiness ? [] : ['ai_scientist_second_validation_readiness_missing']),
    ...(queueRows.length > 0 ? [] : ['ai_scientist_second_validation_queue_empty']),
    ...candidates.flatMap(candidate => candidate.blockers.map(blocker => `${candidate.runId}:${blocker}`)),
    'ai_scientist_pit_plan_research_only',
    'openalice_pit_audit_still_required',
  ])
  const status: PitPlanStatus = !queue || !sourceManifest || !readiness
    ? 'blocked_missing_inputs'
    : queueRows.length === 0
      ? 'blocked_no_candidates'
      : blockers.some(blocker =>
        blocker.includes('available_time') ||
        blocker.includes('observed_or_fetched') ||
        blocker.includes('warehouse') ||
        blocker.includes('missing') ||
        blocker.includes('not_proven'))
        ? 'blocked_pit_contract_missing'
        : 'ready_for_openalice_pit_reproduction'

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
      readiness: resolve(input.readinessPath),
      dataCatalog: resolve(input.dataCatalogPath),
    },
    counts,
    candidates,
    blockers,
    nextActions: [
      'Materialize OpenAlice-native PIT feature inputs with explicit eventTime, observedAt or fetchedAt, and availableAt before reproducing model metrics.',
      'Tie every selected AI-Scientist input to an OpenAlice warehouse manifest or normalized PIT dataset before WFO/FDR validation.',
      'Keep candidate-supplied accuracy and WFO outputs as prioritization signals only until OpenAlice PIT, WFO, route-cost, slippage, risk, trial-ledger, and prospective gates pass.',
    ],
    safetyNotes: [
      'This plan is diagnostic-only and cannot authorize paper or live execution.',
      'A ready_for_openalice_pit_reproduction status would only mean PIT reproduction can start; it is not profitability proof.',
      'No API key, secret, or passphrase values are read or emitted by this script.',
    ],
  }
}

async function buildCandidatePlan(input: {
  row: UnknownRecord
  sourceCandidate: UnknownRecord | null
  readinessCandidate: UnknownRecord | null
  aiScientistRoot: string
  catalogDatasets: CatalogDataset[]
  warehouseRoot: string
}): Promise<AiScientistPitCandidatePlan> {
  const runId = readString(input.row.runId) ?? 'unknown_run'
  const runDir = readString(input.row.runDir) ?? ''
  const candidateId = readString(input.row.candidateId) ?? runId
  const evaluationPath = firstExistingPath(readStringArray(input.row.sourceArtifactPaths), path =>
    path.endsWith('walk_forward_evaluation.json'))
    ?? firstExistingPath(readSourceFilePaths(input.sourceCandidate), path => path.endsWith('walk_forward_evaluation.json'))
  const evaluation = evaluationPath ? asRecord(await readJsonIfExists(evaluationPath)) : null
  const candidate = asRecord(evaluation?.candidate)
  const evalSourceManifest = asRecord(evaluation?.source_manifest)
  const selectedFiles = readStringArray(evalSourceManifest?.selected_files)
  const folds = await buildFoldPlans({
    evaluation,
    aiScientistRoot: input.aiScientistRoot,
    catalogDatasets: input.catalogDatasets,
  })
  const selectedInputFiles = await Promise.all(uniqueStrings([
    ...selectedFiles,
    ...folds.flatMap(fold => fold.selectedFiles),
  ]).map(relativePath => buildInputFilePlan({
    relativePath,
    runDir,
    evaluationPath,
    aiScientistRoot: input.aiScientistRoot,
    catalogDatasets: input.catalogDatasets,
    warehouseRoot: input.warehouseRoot,
  })))
  const sourceStatus = readString(input.sourceCandidate?.status)
  const readinessNextGateId = readString(input.readinessCandidate?.nextGateId)
  const proofStatus = readString(evaluation?.proof_status)
  const candidateBlockers = uniqueStrings([
    ...(evaluationPath ? [] : ['walk_forward_evaluation_missing']),
    ...(proofStatus && proofStatus !== 'proven' ? [`walk_forward_proof_status:${proofStatus}`] : []),
    ...(sourceStatus === 'locked' ? [] : ['locked_source_manifest_not_ready']),
    ...(readinessNextGateId === 'pit_audit' || readinessNextGateId == null ? [] : [`next_gate_not_pit_audit:${readinessNextGateId}`]),
    ...selectedInputFiles.flatMap(file => file.blockers),
    ...folds.flatMap(fold => fold.blockers),
  ])
  const pitAuditStatus: PitAuditStatus = candidateBlockers.some(blocker =>
    blocker.includes('available_time') ||
    blocker.includes('observed_or_fetched') ||
    blocker.includes('warehouse') ||
    blocker.includes('missing') ||
    blocker.includes('not_proven'))
    ? 'blocked'
    : 'ready_for_reproduction'

  return {
    queueRank: readNumber(input.row.queueRank),
    runId,
    runDir,
    family: readString(input.row.family) ?? 'unknown',
    candidateId,
    evaluationPath,
    evaluationExists: evaluation != null,
    readinessNextGateId,
    sourceManifestStatus: sourceStatus,
    pitAuditStatus,
    openAlicePitAuditPassed: false,
    proofStatus,
    foldPassRate: readNumber(evaluation?.fold_pass_rate),
    selectedSource: readString(evalSourceManifest?.source),
    selectedSourcePath: readString(evalSourceManifest?.source_path),
    selectedSynthetic: readBoolean(evalSourceManifest?.synthetic),
    model: readString(candidate?.model),
    featureSet: readString(candidate?.feature_set),
    targetMode: readString(candidate?.target_mode),
    horizon: readNumber(candidate?.horizon),
    lookback: readNumber(candidate?.lookback),
    inputFiles: selectedInputFiles,
    folds,
    blockers: candidateBlockers,
    nextActions: [
      'Rebuild the selected feature files inside OpenAlice with explicit availability timestamps before WFO reproduction.',
      'Do not use this candidate for paper/live until this PIT plan is unblocked and every downstream OpenAlice gate passes.',
    ],
  }
}

async function buildFoldPlans(input: {
  evaluation: UnknownRecord | null
  aiScientistRoot: string
  catalogDatasets: CatalogDataset[]
}): Promise<AiScientistPitFoldPlan[]> {
  const folds = Array.isArray(input.evaluation?.folds)
    ? input.evaluation.folds.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  return Promise.all(folds.map(async fold => {
    const runDir = readString(fold.run_dir)
    const manifestPath = runDir ? resolve(input.aiScientistRoot, runDir, 'data_manifest.json') : null
    const dataManifest = manifestPath ? asRecord(await readJsonIfExists(manifestPath)) : null
    const selectedFiles = readStringArray(dataManifest?.selected_files)
    const availableTimePolicies = readAvailableTimePolicies(dataManifest)
    const labelWindowSeparation = asRecord(fold.label_window_separation)
    const blockers = uniqueStrings([
      ...(manifestPath && dataManifest ? [] : ['fold_data_manifest_missing']),
      ...(Object.keys(availableTimePolicies).length > 0 ? [] : ['fold_available_time_policy_missing']),
      ...(readBoolean(labelWindowSeparation?.asserted) === true ? [] : ['fold_label_window_separation_not_asserted']),
      ...(readBoolean(fold.paper_trading_allowed) === false ? [] : ['fold_paper_flag_not_false']),
      ...(readBoolean(fold.live_trading_allowed) === false ? [] : ['fold_live_flag_not_false']),
      ...(readBoolean(fold.promotion_eligible) === false ? [] : ['fold_promotion_flag_not_false']),
    ])
    return {
      fold: readNumber(fold.fold),
      dataDir: readString(fold.data_dir),
      runDir,
      dataManifestPath: manifestPath,
      dataManifestExists: dataManifest != null,
      selectedStrategy: readString(fold.selected_strategy),
      status: readString(fold.status),
      researchOnly: readBoolean(fold.research_only),
      promotionEligible: readBoolean(fold.promotion_eligible),
      paperTradingAllowed: readBoolean(fold.paper_trading_allowed),
      liveTradingAllowed: readBoolean(fold.live_trading_allowed),
      labelWindowSeparationAsserted: readBoolean(labelWindowSeparation?.asserted),
      selectedFiles,
      availableTimePolicies,
      blockers,
    }
  }))
}

async function buildInputFilePlan(input: {
  relativePath: string
  runDir: string
  evaluationPath: string | null
  aiScientistRoot: string
  catalogDatasets: CatalogDataset[]
  warehouseRoot: string
}): Promise<AiScientistPitInputFilePlan> {
  const path = await resolveCandidateInputPath(input)
  const kind = classifyFileKind(path)
  const exists = await fileExists(path)
  const sizeBytes = exists ? (await stat(path)).size : null
  const columns = exists && kind === 'csv' ? await readCsvHeader(path) : []
  const hasEventTime = columns.some(column => ['eventtime', 'event_time', 'timestamp', 'datetime', 'open_time', 'closetime', 'close_time'].includes(normalizeColumn(column)))
  const hasObservedAt = columns.some(column => ['observedat', 'observed_at'].includes(normalizeColumn(column)))
  const hasFetchedAt = columns.some(column => ['fetchedat', 'fetched_at'].includes(normalizeColumn(column)))
  const hasAvailableAt = columns.some(column => ['availableat', 'available_at'].includes(normalizeColumn(column)))
  const matchingDatasets = input.catalogDatasets.filter(dataset => path.startsWith(`${dataset.storagePath}/`) || path === dataset.storagePath)
  const warehouseLinkStatus = classifyWarehouseLink(path, exists, matchingDatasets, input.warehouseRoot)
  const blockers = uniqueStrings([
    ...(exists ? [] : [`input_file_missing:${input.relativePath}`]),
    ...(kind === 'csv' && !hasEventTime ? [`csv_event_time_missing:${input.relativePath}`] : []),
    ...(kind === 'csv' && !hasAvailableAt ? [`csv_available_time_missing:${input.relativePath}`] : []),
    ...(kind === 'csv' && !hasObservedAt && !hasFetchedAt ? [`csv_observed_or_fetched_time_missing:${input.relativePath}`] : []),
    ...(warehouseLinkStatus === 'linked_to_complete_openalice_warehouse_dataset' ? [] : [`openalice_warehouse_link_missing:${input.relativePath}:${warehouseLinkStatus}`]),
  ])
  return {
    relativePath: input.relativePath,
    path,
    kind,
    exists,
    sizeBytes,
    columns,
    hasEventTime,
    hasObservedAt,
    hasFetchedAt,
    hasAvailableAt,
    explicitAvailableAt: hasAvailableAt,
    eventTimePolicy: hasEventTime
      ? 'source timestamp/datetime is treated as eventTime only'
      : 'missing eventTime column',
    availableTimePolicy: hasAvailableAt
      ? 'explicit availableAt column is present'
      : 'blocked: no explicit availableAt column; eventTime cannot be reused as promotion-grade availability proof',
    warehouseLinkStatus,
    matchingCatalogDatasetIds: matchingDatasets.map(dataset => dataset.datasetId),
    blockers,
  }
}

async function resolveCandidateInputPath(input: {
  relativePath: string
  runDir: string
  evaluationPath: string | null
  aiScientistRoot: string
}): Promise<string> {
  if (input.relativePath.startsWith('/')) return resolve(input.relativePath)
  const candidates = uniqueStrings([
    resolve(input.aiScientistRoot, input.relativePath),
    input.runDir ? resolve(input.runDir, input.relativePath) : '',
    input.evaluationPath ? resolve(dirname(input.evaluationPath), input.relativePath) : '',
  ].filter(Boolean))
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate
  }
  return candidates[0] ?? resolve(input.relativePath)
}

function readSourceFilePaths(sourceCandidate: UnknownRecord | null): string[] {
  const files = Array.isArray(sourceCandidate?.files)
    ? sourceCandidate.files.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  return files.map(file => readString(file.path)).filter((item): item is string => item != null)
}

function firstExistingPath(paths: string[], predicate: (path: string) => boolean): string | null {
  return paths.find(predicate) ?? null
}

function readCatalogDatasets(dataCatalog: unknown): CatalogDataset[] {
  const catalog = asRecord(dataCatalog)
  const datasets = Array.isArray(catalog?.datasets)
    ? catalog.datasets.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  return datasets.map(dataset => ({
    datasetId: readString(dataset.datasetId) ?? 'unknown_dataset',
    status: readString(dataset.status),
    storagePath: readString(dataset.storagePath) ? resolve(readString(dataset.storagePath) as string) : '',
  })).filter(dataset => dataset.storagePath.length > 0)
}

function readAvailableTimePolicies(dataManifest: UnknownRecord | null): Record<string, string> {
  if (!dataManifest) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(dataManifest)) {
    if (key.endsWith('_available_time_policy') && typeof value === 'string' && value.trim().length > 0) {
      out[key] = value
    }
  }
  return out
}

async function readCsvHeader(path: string): Promise<string[]> {
  try {
    const text = await readFile(path, 'utf-8')
    const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
    return firstLine.split(',').map(column => column.trim()).filter(Boolean)
  } catch {
    return []
  }
}

function classifyWarehouseLink(
  path: string,
  exists: boolean,
  matchingDatasets: CatalogDataset[],
  warehouseRoot: string,
): WarehouseLinkStatus {
  if (!exists) return 'missing_file'
  if (matchingDatasets.length > 0) {
    return matchingDatasets.some(dataset => dataset.status === 'complete')
      ? 'linked_to_complete_openalice_warehouse_dataset'
      : 'linked_to_partial_openalice_warehouse_dataset'
  }
  const resolvedWarehouseRoot = resolve(warehouseRoot)
  return path === resolvedWarehouseRoot || path.startsWith(`${resolvedWarehouseRoot}/`)
    ? 'no_catalog_match'
    : 'not_openalice_warehouse_path'
}

function classifyFileKind(path: string): 'csv' | 'json' | 'other' {
  const ext = extname(path).toLowerCase()
  if (ext === '.csv') return 'csv'
  if (ext === '.json') return 'json'
  return 'other'
}

function normalizeColumn(column: string): string {
  return column.trim().toLowerCase().replace(/[^a-z0-9_]/g, '')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
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

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function renderConsoleSummary(report: AiScientistPitReproductionPlanReport): string {
  return [
    `AI-Scientist OpenAlice PIT reproduction plan: ${report.status}`,
    `planned=${report.counts.candidatesPlanned}/${report.counts.queuedCandidates} csv=${report.counts.csvInputFiles} availableAt=${report.counts.csvFilesWithExplicitAvailableAt} warehouseLinked=${report.counts.openAliceWarehouseLinkedInputs}`,
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
