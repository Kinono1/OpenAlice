import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

type RebuildQueueStatus =
  | 'blocked_missing_pit_plan'
  | 'blocked_no_pit_candidates'
  | 'blocked_waiting_for_openalice_native_rebuild'
  | 'ready_for_research_reproduction_inputs'

type RebuildTaskStatus = 'open' | 'not_required'
type RebuildPriority = 'P0' | 'P1'

interface CliArgs {
  pitPlanPath: string
  outputPath: string | null
  maxTasks: number
  json: boolean
}

export interface AiScientistPitRebuildTask {
  taskId: string
  status: RebuildTaskStatus
  priority: RebuildPriority
  runId: string
  candidateId: string
  family: string
  queueRank: number | null
  symbol: string | null
  rawSymbol: string | null
  timeframe: string | null
  sourceFilePath: string
  sourceRelativePath: string
  sourceKind: string | null
  sourceExists: boolean | null
  sourceSizeBytes: number | null
  warehouseLinkStatus: string | null
  matchingCatalogDatasetIds: string[]
  missingFields: string[]
  requiredOutputContract: {
    schema: 'openalice.ai_scientist.pit_input.native_rebuild.v1'
    requiredRowFields: string[]
    availableAtRule: string
    observedOrFetchedAtRule: string
    eventTimeRule: string
    lineageRule: string
    forbiddenShortcuts: string[]
  }
  blockers: string[]
  nextActions: string[]
}

export interface AiScientistPitRebuildQueueReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: RebuildQueueStatus
  sourceArtifacts: {
    pitPlan: string
  }
  counts: {
    pitCandidatesRead: number
    inputFilesRead: number
    csvInputFilesRead: number
    rebuildTasks: number
    openTasks: number
    missingEventTimeTasks: number
    missingAvailableAtTasks: number
    missingObservedOrFetchedAtTasks: number
    incompleteWarehouseLineageTasks: number
    completeWarehouseLineageInputs: number
    uniqueSymbols: number
    uniqueTimeframes: number
  }
  tasks: AiScientistPitRebuildTask[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_PIT_PLAN_PATH = 'data/research/ai_scientist_openalice_pit_reproduction_plan.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/ai_scientist_openalice_pit_rebuild_queue.latest.json'
const DEFAULT_MAX_TASKS = 500

async function main(): Promise<void> {
  const args = parseAiScientistPitRebuildQueueArgs(process.argv.slice(2))
  const report = await runAiScientistPitRebuildQueue(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseAiScientistPitRebuildQueueArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    pitPlanPath: raw.get('pitPlanPath') ?? raw.get('planPath') ?? DEFAULT_PIT_PLAN_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxTasks: parseNonNegativeInteger(raw.get('maxTasks'), DEFAULT_MAX_TASKS),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAiScientistPitRebuildQueue(
  args: CliArgs,
): Promise<AiScientistPitRebuildQueueReport> {
  const startedAt = new Date()
  const pitPlanPath = resolve(args.pitPlanPath)
  const report = buildAiScientistPitRebuildQueueReport({
    generatedAt: new Date().toISOString(),
    pitPlanPath,
    pitPlan: asRecord(await readJsonIfExists(pitPlanPath)),
    maxTasks: args.maxTasks,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'ai_scientist_openalice_pit_rebuild_queue',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'blocked_missing_pit_plan' ? 1 : 0,
      businessStatus: report.status === 'ready_for_research_reproduction_inputs' ? 'warn' : 'fail',
      recordsIn: report.counts.inputFilesRead,
      recordsOut: report.counts.rebuildTasks,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildAiScientistPitRebuildQueueReport(input: {
  generatedAt: string
  pitPlanPath: string
  pitPlan: UnknownRecord | null
  maxTasks: number
}): AiScientistPitRebuildQueueReport {
  const candidates = Array.isArray(input.pitPlan?.candidates)
    ? input.pitPlan.candidates.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const inputFiles = candidates.flatMap(candidate => readInputFiles(candidate).map(file => ({ candidate, file })))
  const csvInputFiles = inputFiles.filter(({ file }) => readString(file.kind) === 'csv')
  const tasks = csvInputFiles
    .map(({ candidate, file }) => buildRebuildTask(candidate, file))
    .filter((task): task is AiScientistPitRebuildTask => task != null)
    .slice(0, input.maxTasks > 0 ? input.maxTasks : undefined)

  const symbols = uniqueStrings(tasks.map(task => task.symbol).filter((item): item is string => item != null))
  const timeframes = uniqueStrings(tasks.map(task => task.timeframe).filter((item): item is string => item != null))
  const openTasks = tasks.filter(task => task.status === 'open')
  const counts = {
    pitCandidatesRead: candidates.length,
    inputFilesRead: inputFiles.length,
    csvInputFilesRead: csvInputFiles.length,
    rebuildTasks: tasks.length,
    openTasks: openTasks.length,
    missingEventTimeTasks: tasks.filter(task => task.missingFields.includes('eventTime')).length,
    missingAvailableAtTasks: tasks.filter(task => task.missingFields.includes('availableAt')).length,
    missingObservedOrFetchedAtTasks: tasks.filter(task => task.missingFields.includes('observedAt_or_fetchedAt')).length,
    incompleteWarehouseLineageTasks: tasks.filter(task => task.missingFields.includes('completeOpenAliceWarehouseLineage')).length,
    completeWarehouseLineageInputs: csvInputFiles.filter(({ file }) =>
      readString(file.warehouseLinkStatus) === 'linked_to_complete_openalice_warehouse_dataset').length,
    uniqueSymbols: symbols.length,
    uniqueTimeframes: timeframes.length,
  }
  const blockers = uniqueStrings([
    ...(input.pitPlan ? [] : ['ai_scientist_pit_reproduction_plan_missing']),
    ...(input.pitPlan && candidates.length === 0 ? ['ai_scientist_pit_reproduction_plan_has_no_candidates'] : []),
    ...(openTasks.length > 0 ? [`ai_scientist_pit_rebuild_tasks_open:${openTasks.length}`] : []),
    ...(counts.missingEventTimeTasks > 0 ? [`ai_scientist_pit_event_time_rebuild_required:${counts.missingEventTimeTasks}`] : []),
    ...(counts.missingAvailableAtTasks > 0 ? [`ai_scientist_pit_available_at_rebuild_required:${counts.missingAvailableAtTasks}`] : []),
    ...(counts.missingObservedOrFetchedAtTasks > 0 ? [`ai_scientist_pit_observed_or_fetched_at_rebuild_required:${counts.missingObservedOrFetchedAtTasks}`] : []),
    ...(counts.incompleteWarehouseLineageTasks > 0 ? [`ai_scientist_pit_complete_warehouse_lineage_required:${counts.incompleteWarehouseLineageTasks}`] : []),
    'ai_scientist_pit_rebuild_queue_research_only',
  ])
  const status: RebuildQueueStatus = !input.pitPlan
    ? 'blocked_missing_pit_plan'
    : candidates.length === 0
      ? 'blocked_no_pit_candidates'
      : openTasks.length > 0
        ? 'blocked_waiting_for_openalice_native_rebuild'
        : 'ready_for_research_reproduction_inputs'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status,
    sourceArtifacts: {
      pitPlan: resolve(input.pitPlanPath),
    },
    counts,
    tasks,
    blockers,
    nextActions: [
      'Rebuild open tasks from OpenAlice-native collectors or warehouse manifests, not from AI-Scientist CSV file mtimes.',
      'Every rebuilt row must carry eventTime, row-explicit observedAt or fetchedAt, row-explicit availableAt, exchange, symbol, source endpoint, capture job id, and source lineage.',
      'Rerun PIT input dataset, PIT contract status, OpenAlice goal audit, and system reason-chain after rebuild output exists.',
      'Treat the queue as research plumbing only; it is not WFO, FDR, route-cost, prospective, paper, or live evidence.',
    ],
    safetyNotes: [
      'This queue cannot authorize paper orders, live orders, promotion, leverage changes, best_config edits, or non-flat target publication.',
      'Derived bar-close availableAt and source-file mtime observedAt/fetchedAt remain PIT blockers until replaced with row-explicit collector timestamps.',
      'No API key, secret, or passphrase values are read or emitted by this script.',
    ],
  }
}

function buildRebuildTask(candidate: UnknownRecord, file: UnknownRecord): AiScientistPitRebuildTask | null {
  const missingFields = uniqueStrings([
    ...(readBoolean(file.hasEventTime) === true ? [] : ['eventTime']),
    ...(readBoolean(file.hasAvailableAt) === true ? [] : ['availableAt']),
    ...(readBoolean(file.hasObservedAt) === true || readBoolean(file.hasFetchedAt) === true ? [] : ['observedAt_or_fetchedAt']),
    ...(readString(file.warehouseLinkStatus) === 'linked_to_complete_openalice_warehouse_dataset'
      ? []
      : ['completeOpenAliceWarehouseLineage']),
  ])
  if (missingFields.length === 0) return null

  const sourceFilePath = readString(file.path) ?? ''
  const sourceRelativePath = readString(file.relativePath) ?? sourceFilePath
  const parsed = parseSymbolAndTimeframe(sourceRelativePath || sourceFilePath)
  const runId = readString(candidate.runId) ?? 'unknown_run'
  const candidateId = readString(candidate.candidateId) ?? 'unknown_candidate'
  const family = readString(candidate.family) ?? 'unknown'
  const priority: RebuildPriority = missingFields.some(field =>
    field === 'availableAt' || field === 'observedAt_or_fetchedAt' || field === 'eventTime')
    ? 'P0'
    : 'P1'
  const blockers = uniqueStrings([
    ...missingFields.map(field => `missing_${field}`),
    ...(readBoolean(file.exists) === false ? [`source_file_missing:${sourceRelativePath}`] : []),
    ...(readString(file.warehouseLinkStatus) === 'linked_to_partial_openalice_warehouse_dataset'
      ? [`warehouse_lineage_partial:${sourceRelativePath}`]
      : []),
    ...(readString(file.warehouseLinkStatus) && readString(file.warehouseLinkStatus) !== 'linked_to_complete_openalice_warehouse_dataset'
      ? [`warehouse_lineage_not_complete:${readString(file.warehouseLinkStatus)}`]
      : []),
  ])
  return {
    taskId: stableTaskId(runId, candidateId, sourceRelativePath),
    status: 'open',
    priority,
    runId,
    candidateId,
    family,
    queueRank: readNumber(candidate.queueRank),
    symbol: parsed.symbol,
    rawSymbol: parsed.rawSymbol,
    timeframe: parsed.timeframe,
    sourceFilePath,
    sourceRelativePath,
    sourceKind: readString(file.kind),
    sourceExists: readBoolean(file.exists),
    sourceSizeBytes: readNumber(file.sizeBytes),
    warehouseLinkStatus: readString(file.warehouseLinkStatus),
    matchingCatalogDatasetIds: readStringArray(file.matchingCatalogDatasetIds),
    missingFields,
    requiredOutputContract: {
      schema: 'openalice.ai_scientist.pit_input.native_rebuild.v1',
      requiredRowFields: [
        'eventTime',
        'observedAt_or_fetchedAt',
        'availableAt',
        'exchange',
        'symbol',
        'timeframe',
        'sourceEndpoint',
        'captureJobId',
        'generatedAt',
        'sourceManifestId',
        'sourceRowHash',
      ],
      availableAtRule: 'decision time must be strictly greater than row-explicit availableAt; eventTime cannot be reused as availability proof',
      observedOrFetchedAtRule: 'observedAt or fetchedAt must come from the collector row or manifest event, not filesystem mtime',
      eventTimeRule: 'eventTime must represent the market/funding event timestamp without future labels',
      lineageRule: 'row must link to a complete OpenAlice warehouse dataset or collector manifest',
      forbiddenShortcuts: [
        'source_file_mtime_recovered',
        'derived_bar_close_time_as_promotion_grade_availableAt',
        'candidate_supplied_metric_as_openalice_gate',
      ],
    },
    blockers,
    nextActions: [
      `Create OpenAlice-native PIT rows for ${parsed.symbol ?? sourceRelativePath} with row-explicit availability and observation timestamps.`,
      'Write rebuilt rows to a manifest-backed warehouse path, then rerun research:ai-scientist:pit-input-dataset and research:ai-scientist:pit-contract-status.',
    ],
  }
}

function readInputFiles(candidate: UnknownRecord): UnknownRecord[] {
  return Array.isArray(candidate.inputFiles)
    ? candidate.inputFiles.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
}

function parseSymbolAndTimeframe(path: string): { rawSymbol: string | null; symbol: string | null; timeframe: string | null } {
  const fileName = path.split('/').at(-1)?.replace(/\.csv$/i, '') ?? path
  const match = /^([A-Z0-9]+)_([A-Z0-9]+)_([A-Z0-9]+)_([0-9]+[a-z]+)$/i.exec(fileName)
  if (!match) return { rawSymbol: null, symbol: null, timeframe: null }
  const [, base, quote, settle, timeframe] = match
  return {
    rawSymbol: `${base}_${quote}_${settle}`,
    symbol: `${base}/${quote}:${settle}`,
    timeframe,
  }
}

function stableTaskId(runId: string, candidateId: string, sourceRelativePath: string): string {
  const hash = createHash('sha256').update(`${runId}\n${candidateId}\n${sourceRelativePath}`).digest('hex').slice(0, 12)
  return `pit_rebuild.${sanitizeId(runId)}.${sanitizeId(candidateId)}.${hash}`
}

function sanitizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'unknown'
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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) out.set(key, 'true')
    else {
      out.set(key, next)
      index += 1
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : value
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
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

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function renderConsoleSummary(report: AiScientistPitRebuildQueueReport): string {
  return [
    `AI-Scientist OpenAlice PIT rebuild queue: ${report.status}`,
    `tasks=${report.counts.openTasks}/${report.counts.rebuildTasks} csv=${report.counts.csvInputFilesRead} availableAtMissing=${report.counts.missingAvailableAtTasks} observedOrFetchedMissing=${report.counts.missingObservedOrFetchedAtTasks}`,
    'paper=false live=false promotion=false execution=false',
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
