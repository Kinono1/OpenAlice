import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'unassigned'
type DefectStatus = 'open' | 'partial' | 'watch' | 'pass' | 'unknown'
type ReportStatus = 'blocked' | 'watch_only'

interface CliArgs {
  outputPath: string | null
  strategyDefectRegistryPath: string
  strategyDefectMonitorPath: string
  quantFrameworkBenchmarkPath: string
  json: boolean
}

export interface StrategyQualityGateCoverageDefect {
  id: string
  title: string
  layer: string
  priority: Priority
  status: DefectStatus
  openOrPartial: boolean
  monitorCovered: boolean
  monitorFindingIds: string[]
  blockers: string[]
  benchmarkLessons: string[]
  repairQueueId: string
  evidencePaths: string[]
}

export interface StrategyQualityGateCoverageReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: ReportStatus
  sourceArtifacts: Record<string, string>
  summary: {
    defects: number
    monitorFindings: number
    openOrPartial: number
    p0OpenOrPartial: number
    p1OpenOrPartial: number
    p0p1OpenOrPartial: number
    monitorCovered: number
    monitorUncovered: number
    p0p1OpenOrPartialCovered: number
    p0p1OpenOrPartialUncovered: number
    p0OpenOrPartialUncovered: number
    p1OpenOrPartialUncovered: number
    coveragePct: number
    p0p1OpenOrPartialCoveragePct: number
    repairQueues: number
    blockedRepairQueues: number
    quantBenchmarkStatus: string | null
  }
  coverageByLayer: Array<{
    layer: string
    defects: number
    openOrPartial: number
    monitorCovered: number
    openOrPartialUncovered: number
    p0p1OpenOrPartialUncovered: number
  }>
  repairQueues: Array<{
    queueId: string
    title: string
    priority: Priority
    status: 'blocked' | 'watch'
    defectIds: string[]
    p0p1OpenOrPartialUncovered: string[]
    blockers: string[]
    nextActions: string[]
  }>
  uncoveredDefects: StrategyQualityGateCoverageDefect[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/research/strategy_quality_gate_coverage.latest.json'

async function main(): Promise<void> {
  const args = parseStrategyQualityGateCoverageArgs(process.argv.slice(2))
  const report = await runStrategyQualityGateCoverage(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseStrategyQualityGateCoverageArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    strategyDefectRegistryPath: raw.get('strategyDefectRegistryPath') ?? 'data/research/strategy_defect_registry.latest.json',
    strategyDefectMonitorPath: raw.get('strategyDefectMonitorPath') ?? 'data/research/strategy_defect_monitor.latest.json',
    quantFrameworkBenchmarkPath: raw.get('quantFrameworkBenchmarkPath') ?? 'data/research/quant_framework_benchmark_report.latest.json',
    json: parseBool(raw.get('json'), false),
  }
}

export async function runStrategyQualityGateCoverage(
  args: CliArgs,
): Promise<StrategyQualityGateCoverageReport> {
  const startedAt = new Date()
  const sourceArtifacts = {
    strategyDefectRegistry: resolve(args.strategyDefectRegistryPath),
    strategyDefectMonitor: resolve(args.strategyDefectMonitorPath),
    quantFrameworkBenchmark: resolve(args.quantFrameworkBenchmarkPath),
  }
  const report = buildStrategyQualityGateCoverageReport({
    generatedAt: new Date().toISOString(),
    sourceArtifacts,
    strategyDefectRegistry: asRecord(await readJsonIfExists(sourceArtifacts.strategyDefectRegistry)),
    strategyDefectMonitor: asRecord(await readJsonIfExists(sourceArtifacts.strategyDefectMonitor)),
    quantFrameworkBenchmark: asRecord(await readJsonIfExists(sourceArtifacts.quantFrameworkBenchmark)),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'strategy_quality_gate_coverage',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'watch_only' ? 'warn' : 'fail',
      recordsIn: report.summary.defects,
      recordsOut: report.uncoveredDefects.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildStrategyQualityGateCoverageReport(input: {
  generatedAt?: string
  sourceArtifacts: Record<string, string>
  strategyDefectRegistry: UnknownRecord | null
  strategyDefectMonitor: UnknownRecord | null
  quantFrameworkBenchmark: UnknownRecord | null
}): StrategyQualityGateCoverageReport {
  const registryDefects = readRecordArray(input.strategyDefectRegistry?.defects)
  const monitorFindings = readRecordArray(input.strategyDefectMonitor?.findings)
  const normalizedDefects = registryDefects.map(defect =>
    normalizeDefect(defect, monitorFindings),
  )
  const openOrPartial = normalizedDefects.filter(defect => defect.openOrPartial)
  const p0OpenOrPartial = openOrPartial.filter(defect => defect.priority === 'P0')
  const p1OpenOrPartial = openOrPartial.filter(defect => defect.priority === 'P1')
  const p0p1OpenOrPartial = openOrPartial.filter(defect => defect.priority === 'P0' || defect.priority === 'P1')
  const monitorCovered = normalizedDefects.filter(defect => defect.monitorCovered)
  const uncovered = normalizedDefects.filter(defect => !defect.monitorCovered)
  const p0p1OpenOrPartialUncovered = p0p1OpenOrPartial.filter(defect => !defect.monitorCovered)
  const p0OpenOrPartialUncovered = p0OpenOrPartial.filter(defect => !defect.monitorCovered)
  const p1OpenOrPartialUncovered = p1OpenOrPartial.filter(defect => !defect.monitorCovered)
  const coverageByLayer = buildCoverageByLayer(normalizedDefects)
  const repairQueues = buildRepairQueues(normalizedDefects)

  const artifactAllowsExecution = [
    input.strategyDefectRegistry,
    input.strategyDefectMonitor,
    input.quantFrameworkBenchmark,
  ].some(sourceAuthorizesExecution)
  const blockers = uniqueStrings([
    ...(input.strategyDefectRegistry ? [] : ['strategy_defect_registry_missing']),
    ...(input.strategyDefectMonitor ? [] : ['strategy_defect_monitor_missing']),
    ...(artifactAllowsExecution ? ['strategy_quality_gate_source_must_not_authorize_execution'] : []),
    ...(p0OpenOrPartialUncovered.length > 0
      ? [`p0_open_or_partial_defects_without_monitor:${p0OpenOrPartialUncovered.length}`]
      : []),
    ...(p1OpenOrPartialUncovered.length > 0
      ? [`p1_open_or_partial_defects_without_monitor:${p1OpenOrPartialUncovered.length}`]
      : []),
    ...p0p1OpenOrPartialUncovered
      .slice(0, 24)
      .flatMap(defect => defect.blockers.map(blocker => `${defect.id}:${blocker}`)),
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
    status: blockers.length > 0 ? 'blocked' : 'watch_only',
    sourceArtifacts: input.sourceArtifacts,
    summary: {
      defects: normalizedDefects.length,
      monitorFindings: monitorFindings.length,
      openOrPartial: openOrPartial.length,
      p0OpenOrPartial: p0OpenOrPartial.length,
      p1OpenOrPartial: p1OpenOrPartial.length,
      p0p1OpenOrPartial: p0p1OpenOrPartial.length,
      monitorCovered: monitorCovered.length,
      monitorUncovered: uncovered.length,
      p0p1OpenOrPartialCovered: p0p1OpenOrPartial.length - p0p1OpenOrPartialUncovered.length,
      p0p1OpenOrPartialUncovered: p0p1OpenOrPartialUncovered.length,
      p0OpenOrPartialUncovered: p0OpenOrPartialUncovered.length,
      p1OpenOrPartialUncovered: p1OpenOrPartialUncovered.length,
      coveragePct: pct(monitorCovered.length, normalizedDefects.length),
      p0p1OpenOrPartialCoveragePct: pct(
        p0p1OpenOrPartial.length - p0p1OpenOrPartialUncovered.length,
        p0p1OpenOrPartial.length,
      ),
      repairQueues: repairQueues.length,
      blockedRepairQueues: repairQueues.filter(queue => queue.status === 'blocked').length,
      quantBenchmarkStatus: readString(input.quantFrameworkBenchmark?.status),
    },
    coverageByLayer,
    repairQueues,
    uncoveredDefects: p0p1OpenOrPartialUncovered.slice(0, 50),
    blockers,
    nextActions: [
      'Turn every uncovered P0/P1 strategy defect into a small monitor with a runtime artifact and focused test before claiming the defect is controlled.',
      'Prioritize uncovered execution, risk, data/PIT, and portfolio defects before more parameter search.',
      'Keep this artifact in the research-evidence refresh chain; it is coverage evidence only, not profitability or trading authorization.',
    ],
    safetyNotes: [
      'This artifact is diagnostic-only and cannot authorize paper orders, live orders, promotion, leverage changes, or best_config mutation.',
      'Monitor coverage only means a defect is machine-tracked; the strategy still needs PIT, WFO, FDR, route-cost, slippage, risk, prospective, paper telemetry, and release gates before trading.',
    ],
  }
}

function normalizeDefect(
  defect: UnknownRecord,
  monitorFindings: UnknownRecord[],
): StrategyQualityGateCoverageDefect {
  const id = readString(defect.id) ?? 'unknown'
  const title = readString(defect.title) ?? id
  const layer = readString(defect.layer) ?? 'unknown'
  const priority = readPriority(defect.priority)
  const status = readDefectStatus(defect.status)
  const openOrPartial = ['open', 'partial', 'unknown'].includes(status)
  const monitorCoverage = asRecord(defect.monitorCoverage)
  const explicitMonitorFindingIds = readStringArray(monitorCoverage?.matchingFindingIds)
  const relatedMonitorFindingIds = readStringArray(defect.relatedMonitorFindingIds)
  const inferredMonitorFindingIds = monitorFindings
    .map(finding => readString(finding.id))
    .filter((findingId): findingId is string =>
      findingId != null && relatedMonitorFindingIds.includes(findingId),
    )
  const monitorFindingIds = uniqueStrings([...explicitMonitorFindingIds, ...inferredMonitorFindingIds])
  const monitorCovered = readBoolean(monitorCoverage?.covered) === true || monitorFindingIds.length > 0
  return {
    id,
    title,
    layer,
    priority,
    status,
    openOrPartial,
    monitorCovered,
    monitorFindingIds,
    blockers: readStringArray(defect.blockers),
    benchmarkLessons: readStringArray(defect.benchmarkLessons),
    repairQueueId: repairQueueIdForDefect(id, layer),
    evidencePaths: readStringArray(defect.evidencePaths),
  }
}

function buildCoverageByLayer(defects: StrategyQualityGateCoverageDefect[]) {
  const byLayer = new Map<string, StrategyQualityGateCoverageDefect[]>()
  for (const defect of defects) {
    byLayer.set(defect.layer, [...(byLayer.get(defect.layer) ?? []), defect])
  }
  return [...byLayer.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([layer, items]) => {
      const openOrPartial = items.filter(item => item.openOrPartial)
      return {
        layer,
        defects: items.length,
        openOrPartial: openOrPartial.length,
        monitorCovered: items.filter(item => item.monitorCovered).length,
        openOrPartialUncovered: openOrPartial.filter(item => !item.monitorCovered).length,
        p0p1OpenOrPartialUncovered: openOrPartial.filter(item =>
          !item.monitorCovered && (item.priority === 'P0' || item.priority === 'P1'),
        ).length,
      }
    })
}

function buildRepairQueues(defects: StrategyQualityGateCoverageDefect[]) {
  const byQueue = new Map<string, StrategyQualityGateCoverageDefect[]>()
  for (const defect of defects) {
    byQueue.set(defect.repairQueueId, [...(byQueue.get(defect.repairQueueId) ?? []), defect])
  }
  return [...byQueue.entries()]
    .map(([queueId, items]) => {
      const p0p1OpenOrPartialUncovered = items.filter(item =>
        item.openOrPartial &&
        !item.monitorCovered &&
        (item.priority === 'P0' || item.priority === 'P1'),
      )
      const priority = highestPriority(items.map(item => item.priority))
      return {
        queueId,
        title: repairQueueTitle(queueId),
        priority,
        status: p0p1OpenOrPartialUncovered.length > 0 ? 'blocked' as const : 'watch' as const,
        defectIds: items.map(item => item.id),
        p0p1OpenOrPartialUncovered: p0p1OpenOrPartialUncovered.map(item => item.id),
        blockers: p0p1OpenOrPartialUncovered.map(item => `${item.id}:monitor_missing`),
        nextActions: repairQueueNextActions(queueId),
      }
    })
    .sort((a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      Number(b.status === 'blocked') - Number(a.status === 'blocked') ||
      a.queueId.localeCompare(b.queueId),
    )
}

function repairQueueIdForDefect(id: string, layer: string): string {
  if (layer.startsWith('signal_generation')) return 'signal_generation'
  if (layer === 'execution') return 'execution_quality'
  if (layer === 'risk') return 'risk_controls'
  if (layer === 'data') return 'data_pit'
  if (layer === 'backtest') return 'backtest_validation'
  if (layer === 'strategy_learning') return 'research_workflow'
  if (layer === 'portfolio') return 'portfolio_risk'
  if (id.startsWith('5.')) return 'backtest_validation'
  if (id.startsWith('7.')) return 'portfolio_risk'
  return 'other'
}

function repairQueueTitle(queueId: string): string {
  const titles: Record<string, string> = {
    signal_generation: 'Signal generation and regime quality',
    execution_quality: 'Execution cost, slippage, exits, and entry timing',
    risk_controls: 'Runtime protections and risk hard blocks',
    data_pit: 'PIT data availability and stale-data controls',
    backtest_validation: 'Backtest, OOS, WFO, FDR, and overfit controls',
    research_workflow: 'Research workflow, parameter stability, and promotion discipline',
    portfolio_risk: 'Portfolio exposure, concentration, and balance controls',
    other: 'Other strategy quality coverage',
  }
  return titles[queueId] ?? queueId
}

function repairQueueNextActions(queueId: string): string[] {
  const actions: Record<string, string[]> = {
    signal_generation: ['Add regime/filter diagnostics and confidence calibration artifacts before reusing signal families.'],
    execution_quality: ['Add per-decision spread, slippage, entry-timing, MFE/MAE, and exit outcome monitors.'],
    risk_controls: ['Promote protections into hard no-open probes with reduce-only pass-through tests.'],
    data_pit: ['Require row-explicit observedAt/fetchedAt/availableAt and stale-data fail-closed checks.'],
    backtest_validation: ['Add universe-size, OOS, CPCV/PBO, route-cost, and unrealistic-metric guards.'],
    research_workflow: ['Keep search loops research-only and add parameter stability plus immutable trial ledgers.'],
    portfolio_risk: ['Add account-level exposure, symbol concentration, correlation, and long/short balance monitors.'],
    other: ['Convert remaining uncovered defects into focused diagnostic artifacts.'],
  }
  return actions[queueId] ?? actions.other
}

function highestPriority(priorities: Priority[]): Priority {
  return priorities.sort((a, b) => priorityRank(a) - priorityRank(b))[0] ?? 'unassigned'
}

function priorityRank(priority: Priority): number {
  const ranks: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3, unassigned: 4 }
  return ranks[priority]
}

function sourceAuthorizesExecution(source: UnknownRecord | null): boolean {
  return readBoolean(source?.promotionEligible) === true ||
    readBoolean(source?.promotionAllowed) === true ||
    readBoolean(source?.paperTradingAllowed) === true ||
    readBoolean(source?.liveTradingAllowed) === true ||
    readBoolean(source?.executionAllowed) === true ||
    readBoolean(source?.policyMutationAllowed) === true
}

function renderConsoleSummary(report: StrategyQualityGateCoverageReport): string {
  return [
    `Strategy quality gate coverage: ${report.status}`,
    `defects=${report.summary.defects} covered=${report.summary.monitorCovered}/${report.summary.defects} coveragePct=${report.summary.coveragePct}`,
    `p0p1OpenOrPartial=${report.summary.p0p1OpenOrPartial} uncovered=${report.summary.p0p1OpenOrPartialUncovered}`,
    `repairQueues=${report.summary.repairQueues} blockedQueues=${report.summary.blockedRepairQueues}`,
    `paper=false live=false promotion=false`,
    `topBlockers=${report.blockers.slice(0, 8).join(',') || 'none'}`,
  ].join('\n')
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf-8'))
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
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readPriority(value: unknown): Priority {
  return value === 'P0' || value === 'P1' || value === 'P2' || value === 'P3'
    ? value
    : 'unassigned'
}

function readDefectStatus(value: unknown): DefectStatus {
  return value === 'open' || value === 'partial' || value === 'watch' || value === 'pass' || value === 'unknown'
    ? value
    : 'unknown'
}

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_strategy_quality_gate_coverage failed:', error)
    process.exit(1)
  })
}
