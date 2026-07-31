import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type CapabilityStatus = 'blocked' | 'watch' | 'missing_evidence'
type CapabilityPriority = 'P0' | 'P1' | 'P2'

interface CliArgs {
  outputPath: string | null
  strategyDefectRegistryPath: string
  dataCatalogPath: string
  reasonChainPath: string
  json: boolean
}

interface FrameworkBenchmark {
  frameworkId: string
  name: string
  roleModel: string
  officialSources: string[]
  strongestLessons: string[]
  openAliceTransferTarget: string
}

interface CapabilityBenchmark {
  capabilityId: string
  title: string
  priority: CapabilityPriority
  modelFrameworks: string[]
  sourceLessons: string[]
  openAliceRequirement: string
  currentEvidence: {
    relatedDefectIds: string[]
    openOrPartialDefectIds: string[]
    dataCatalogStatus: string | null
    reasonChainActionability: string | null
  }
  status: CapabilityStatus
  blockers: string[]
  nextActions: string[]
}

export interface QuantFrameworkBenchmarkReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  status: 'blocked' | 'watch_only'
  sourceArtifacts: Record<string, string>
  frameworkSources: FrameworkBenchmark[]
  capabilities: CapabilityBenchmark[]
  summary: {
    frameworks: number
    capabilities: number
    blockedCapabilities: number
    watchCapabilities: number
    missingEvidenceCapabilities: number
    relatedOpenOrPartialDefects: number
    p0RelatedOpenOrPartialDefects: number
    dataCatalogStatus: string | null
    reasonChainActionability: string | null
    paperTradingAllowed: boolean | null
    liveTradingAllowed: boolean | null
    canPromote: boolean | null
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/research/quant_framework_benchmark_report.latest.json'

const FRAMEWORKS: FrameworkBenchmark[] = [
  {
    frameworkId: 'quantconnect_lean',
    name: 'QuantConnect LEAN',
    roleModel: 'research/backtest/live engine with pluggable fill, fee, slippage, and margin models',
    officialSources: [
      'https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/algorithm-engine',
      'https://www.quantconnect.com/docs/v2/writing-algorithms/live-trading/trading-and-orders',
    ],
    strongestLessons: ['backtest/live parity', 'event-driven execution', 'execution cost model', 'evidence reporting'],
    openAliceTransferTarget: 'Keep strategy logic, fill/fee/slippage assumptions, and live gate evidence in one comparable contract.',
  },
  {
    frameworkId: 'nautilus_trader',
    name: 'NautilusTrader',
    roleModel: 'event-driven trading platform with common backtest/sandbox/live core and order-book-aware matching',
    officialSources: [
      'https://nautilustrader.io/docs/latest/concepts/overview',
      'https://nautilustrader.io/docs/latest/concepts/backtesting',
      'https://nautilustrader.io/docs/latest/concepts/live/',
      'https://nautilustrader.io/docs/latest/concepts/data',
    ],
    strongestLessons: ['backtest/live parity', 'event-driven execution', 'order book matching', 'connector abstraction'],
    openAliceTransferTarget: 'Move execution labels toward event sequencing, book-depth realism, and explicit reconciliation evidence.',
  },
  {
    frameworkId: 'freqtrade',
    name: 'Freqtrade',
    roleModel: 'crypto bot with dry-run, backtesting, protections, hyperopt, pairlists, and operational monitoring',
    officialSources: [
      'https://www.freqtrade.io/en/stable/',
      'https://docs.freqtrade.io/en/stable/hyperopt/',
      'https://www.freqtrade.io/en/stable/developer/',
    ],
    strongestLessons: ['protections', 'hyperopt', 'money management', 'dry-run first', 'monitoring'],
    openAliceTransferTarget: 'Convert stoploss, stale-data, pair filtering, protection, and parameter-search gaps into hard-blocked evidence.',
  },
  {
    frameworkId: 'vectorbt',
    name: 'vectorbt',
    roleModel: 'vectorized research engine for fast parameter sweeps and portfolio comparisons',
    officialSources: [
      'https://vectorbt.dev/',
    ],
    strongestLessons: ['fast parameter sweep', 'research workflow', 'portfolio comparison', 'evidence reporting'],
    openAliceTransferTarget: 'Use fast sweeps only for research triage; require locked OOS, FDR, and prospective evidence before promotion.',
  },
  {
    frameworkId: 'qlib',
    name: 'Microsoft Qlib',
    roleModel: 'AI-oriented quantitative research platform with workflow management',
    officialSources: [
      'https://qlib.readthedocs.io/en/stable/introduction/introduction.html',
      'https://qlib.readthedocs.io/en/stable/component/workflow.html',
    ],
    strongestLessons: ['research workflow', 'experiment management', 'AI model validation', 'evidence reporting'],
    openAliceTransferTarget: 'Treat AI-Scientist outputs as managed experiments with immutable artifacts, not trading instructions.',
  },
  {
    frameworkId: 'hummingbot',
    name: 'Hummingbot',
    roleModel: 'modular crypto trading framework with standardized exchange and DeFi connectors',
    officialSources: [
      'https://hummingbot.org/docs/',
      'https://hummingbot.org/connectors/',
      'https://hummingbot.org/connectors/connectors/architecture/',
      'https://hummingbot.org/connectors/connectors/test/',
    ],
    strongestLessons: ['connector abstraction', 'order book data', 'market making controls', 'connector QA'],
    openAliceTransferTarget: 'Make connector coverage, order-book queries, and exchange-specific QA explicit prerequisites for live readiness.',
  },
]

const CAPABILITY_TEMPLATES = [
  capability('backtest_live_parity', 'Backtest/live parity and reconciliation', 'P0', ['quantconnect_lean', 'nautilus_trader'], ['backtest/live parity', 'event-driven execution'], 'Backtest labels, paper telemetry, route costs, and live-only observations must share one comparable evidence schema.'),
  capability('event_driven_execution', 'Event-driven execution sequencing', 'P0', ['quantconnect_lean', 'nautilus_trader'], ['event-driven execution'], 'OpenAlice must record decision time, market-data event time, availableAt, order event time, fill event time, and label settlement ordering.'),
  capability('order_book_matching', 'Order book and liquidity-aware matching', 'P0', ['nautilus_trader', 'hummingbot'], ['order book matching', 'execution cost model'], 'Execution evidence must include book depth, spread, route cost, slippage stress, and liquidity-consumption assumptions.'),
  capability('protections', 'Runtime protections and stale-data hard blocks', 'P0', ['freqtrade'], ['protections', 'risk management'], 'Stale data, repeated stoplosses, low liquidity, high spread, and loss limits must block new risk instead of only lowering scores.'),
  capability('hyperopt', 'Constrained parameter search and protections optimization', 'P1', ['freqtrade'], ['hyperopt'], 'Parameter search must be bounded, logged, and revalidated with WFO/FDR/PIT before any config mutation.'),
  capability('portfolio_risk_management', 'Portfolio and account-level risk management', 'P0', ['freqtrade', 'hummingbot'], ['portfolio/risk management', 'money management'], 'Multiple accounts and symbols need total exposure, concentration, correlation, long/short balance, and drawdown controls.'),
  capability('connector_abstraction', 'Connector abstraction and QA', 'P1', ['hummingbot', 'nautilus_trader'], ['connector abstraction'], 'Exchange connectors need explicit capability, credential-presence, market-data, order-book, and fee-model QA artifacts without exposing secrets.'),
  capability('fast_parameter_sweep', 'Fast research sweeps without promotion leakage', 'P1', ['vectorbt'], ['fast parameter sweep'], 'Fast sweeps should accelerate hypothesis triage, but cannot bypass locked OOS, FDR, prospective labels, or paper telemetry.'),
  capability('research_workflow', 'Managed research workflow and experiment evidence', 'P1', ['qlib', 'vectorbt'], ['research workflow', 'evidence reporting'], 'Every candidate, including AI-Scientist output, needs immutable source artifacts, reproducible inputs, selection rationale, and second validation.'),
  capability('evidence_reporting', 'Evidence reporting and gate explainability', 'P0', ['quantconnect_lean', 'qlib'], ['evidence reporting'], 'Release artifacts must explain why a strategy is blocked or allowed, with direct links to data, costs, WFO, FDR, PIT, prospective, and paper evidence.'),
] as const

async function main(): Promise<void> {
  const args = parseQuantFrameworkBenchmarkArgs(process.argv.slice(2))
  const report = await runQuantFrameworkBenchmark(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseQuantFrameworkBenchmarkArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    strategyDefectRegistryPath: raw.get('strategyDefectRegistryPath') ?? 'data/research/strategy_defect_registry.latest.json',
    dataCatalogPath: raw.get('dataCatalogPath') ?? 'data/runtime/openalice_data_catalog.latest.json',
    reasonChainPath: raw.get('reasonChainPath') ?? 'data/runtime/system_status_reason_chain.latest.json',
    json: parseBool(raw.get('json'), false),
  }
}

export async function runQuantFrameworkBenchmark(args: CliArgs): Promise<QuantFrameworkBenchmarkReport> {
  const startedAt = new Date()
  const sourceArtifacts = {
    strategyDefectRegistry: resolve(args.strategyDefectRegistryPath),
    dataCatalog: resolve(args.dataCatalogPath),
    reasonChain: resolve(args.reasonChainPath),
  }
  const report = buildQuantFrameworkBenchmarkReport({
    generatedAt: new Date().toISOString(),
    sourceArtifacts,
    strategyDefectRegistry: asRecord(await readJsonIfExists(sourceArtifacts.strategyDefectRegistry)),
    dataCatalog: asRecord(await readJsonIfExists(sourceArtifacts.dataCatalog)),
    reasonChain: asRecord(await readJsonIfExists(sourceArtifacts.reasonChain)),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'quant_framework_benchmark_report',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'watch_only' ? 'warn' : 'fail',
      recordsIn: report.frameworkSources.length,
      recordsOut: report.capabilities.length,
      errorClass: report.blockers[0] ?? null,
    })
  }
  return report
}

export function buildQuantFrameworkBenchmarkReport(input: {
  generatedAt?: string
  sourceArtifacts: Record<string, string>
  strategyDefectRegistry: UnknownRecord | null
  dataCatalog: UnknownRecord | null
  reasonChain: UnknownRecord | null
}): QuantFrameworkBenchmarkReport {
  const defects = readRecordArray(input.strategyDefectRegistry?.defects)
  const dataCatalogStatus = readString(input.dataCatalog?.status)
  const reasonChainActionability = readString(input.reasonChain?.effectiveActionability)
  const paperTradingAllowed = readBoolean(input.reasonChain?.paperTradingAllowed)
  const liveTradingAllowed = readBoolean(input.reasonChain?.liveTradingAllowed)
  const canPromote = readBoolean(input.reasonChain?.canPromote)
  const capabilities = CAPABILITY_TEMPLATES.map(template =>
    assessCapability(template, defects, dataCatalogStatus, reasonChainActionability),
  )
  const relatedOpenOrPartial = uniqueStrings(capabilities.flatMap(item => item.currentEvidence.openOrPartialDefectIds))
  const p0RelatedOpenOrPartial = uniqueStrings(capabilities.flatMap(item =>
    defects
      .filter(defect => item.currentEvidence.openOrPartialDefectIds.includes(readString(defect.id) ?? '') &&
        readString(defect.priority) === 'P0')
      .map(defect => readString(defect.id))
      .filter((value): value is string => value != null),
  ))
  const blockers = uniqueStrings([
    ...(input.strategyDefectRegistry ? [] : ['strategy_defect_registry_missing']),
    ...(input.dataCatalog ? [] : ['openalice_data_catalog_missing']),
    ...(input.reasonChain ? [] : ['system_status_reason_chain_missing']),
    ...(paperTradingAllowed === true || liveTradingAllowed === true || canPromote === true
      ? ['quant_framework_benchmark_artifact_must_not_authorize_execution']
      : []),
    ...capabilities
      .filter(item => item.status !== 'watch')
      .flatMap(item => item.blockers.map(blocker => `${item.capabilityId}:${blocker}`)),
  ])
  const status = blockers.length > 0 ? 'blocked' : 'watch_only'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status,
    sourceArtifacts: input.sourceArtifacts,
    frameworkSources: FRAMEWORKS,
    capabilities,
    summary: {
      frameworks: FRAMEWORKS.length,
      capabilities: capabilities.length,
      blockedCapabilities: capabilities.filter(item => item.status === 'blocked').length,
      watchCapabilities: capabilities.filter(item => item.status === 'watch').length,
      missingEvidenceCapabilities: capabilities.filter(item => item.status === 'missing_evidence').length,
      relatedOpenOrPartialDefects: relatedOpenOrPartial.length,
      p0RelatedOpenOrPartialDefects: p0RelatedOpenOrPartial.length,
      dataCatalogStatus,
      reasonChainActionability,
      paperTradingAllowed,
      liveTradingAllowed,
      canPromote,
    },
    blockers,
    nextActions: [
      'Use this report as the benchmark-to-defect map for OpenAlice strategy repairs.',
      'Start with P0 capabilities: backtest/live parity, event sequencing, order-book/slippage realism, protections, portfolio risk, and evidence reporting.',
      'Keep all framework lessons research-only until OpenAlice artifacts pass PIT, WFO, FDR, route cost, prospective, paper telemetry, and release gates.',
    ],
    safetyNotes: [
      'This report compares engineering patterns only; it does not import third-party strategy claims or authorize trading.',
      'Framework strengths are requirements for OpenAlice evidence, not shortcuts around release gates.',
    ],
  }
}

function capability(
  capabilityId: string,
  title: string,
  priority: CapabilityPriority,
  modelFrameworks: string[],
  sourceLessons: string[],
  openAliceRequirement: string,
) {
  return { capabilityId, title, priority, modelFrameworks, sourceLessons, openAliceRequirement }
}

function assessCapability(
  template: ReturnType<typeof capability>,
  defects: UnknownRecord[],
  dataCatalogStatus: string | null,
  reasonChainActionability: string | null,
): CapabilityBenchmark {
  const related = defects.filter(defect => defectMatchesCapability(defect, template))
  const openOrPartial = related.filter(defect => ['open', 'partial', 'unknown'].includes(readString(defect.status) ?? 'unknown'))
  const openOrPartialIds = openOrPartial
    .map(defect => readString(defect.id))
    .filter((value): value is string => value != null)
  const relatedIds = related
    .map(defect => readString(defect.id))
    .filter((value): value is string => value != null)
  const missingEvidence = defects.length === 0 || related.length === 0
  const status: CapabilityStatus = missingEvidence
    ? 'missing_evidence'
    : openOrPartial.length > 0
      ? 'blocked'
      : 'watch'

  return {
    capabilityId: template.capabilityId,
    title: template.title,
    priority: template.priority,
    modelFrameworks: template.modelFrameworks,
    sourceLessons: template.sourceLessons,
    openAliceRequirement: template.openAliceRequirement,
    currentEvidence: {
      relatedDefectIds: relatedIds,
      openOrPartialDefectIds: openOrPartialIds,
      dataCatalogStatus,
      reasonChainActionability,
    },
    status,
    blockers: uniqueStrings([
      ...(missingEvidence ? ['related_defect_evidence_missing'] : []),
      ...openOrPartialIds.map(id => `related_defect_open_or_partial:${id}`),
      ...(template.capabilityId.includes('data') && dataCatalogStatus !== 'complete' ? [`data_catalog_status:${dataCatalogStatus ?? 'missing'}`] : []),
      ...(reasonChainActionability === 'research_only_blocked' ? ['global_actionability_research_only_blocked'] : []),
    ]),
    nextActions: nextActionsForCapability(template.capabilityId),
  }
}

function defectMatchesCapability(defect: UnknownRecord, template: ReturnType<typeof capability>): boolean {
  const id = readString(defect.id) ?? ''
  const layer = readString(defect.layer) ?? ''
  const title = readString(defect.title) ?? ''
  const benchmarkLessons = readStringArray(defect.benchmarkLessons)
  return template.sourceLessons.some(lesson => benchmarkLessons.includes(lesson)) ||
    template.sourceLessons.some(lesson => title.toLowerCase().includes(lesson.toLowerCase())) ||
    capabilityDefectIds(template.capabilityId).includes(id) ||
    capabilityLayers(template.capabilityId).some(fragment => layer.includes(fragment))
}

function capabilityDefectIds(capabilityId: string): string[] {
  const map: Record<string, string[]> = {
    backtest_live_parity: ['5.3', '5.5', '6.5'],
    event_driven_execution: ['2.8', '4.3'],
    order_book_matching: ['1.3.2', '2.5', '2.6', '3.1', '5.3'],
    protections: ['3.3', '3.5', '4.4'],
    hyperopt: ['6.2', '6.3', '6.4'],
    portfolio_risk_management: ['3.7', '7.1', '7.2', '7.3', '7.4'],
    connector_abstraction: ['2.4', '5.3'],
    fast_parameter_sweep: ['6.2', '6.4'],
    research_workflow: ['5.2', '5.5', '6.1', '6.2', '6.3', '6.4'],
    evidence_reporting: ['2.4', '4.2', '4.3', '6.5'],
  }
  return map[capabilityId] ?? []
}

function capabilityLayers(capabilityId: string): string[] {
  const map: Record<string, string[]> = {
    backtest_live_parity: ['backtest'],
    event_driven_execution: ['execution', 'data'],
    order_book_matching: ['microstructure', 'execution'],
    protections: ['risk', 'data'],
    hyperopt: ['strategy_learning'],
    portfolio_risk_management: ['portfolio', 'risk'],
    connector_abstraction: ['execution'],
    fast_parameter_sweep: ['strategy_learning'],
    research_workflow: ['backtest', 'strategy_learning'],
    evidence_reporting: ['data', 'execution'],
  }
  return map[capabilityId] ?? []
}

function nextActionsForCapability(capabilityId: string): string[] {
  const map: Record<string, string[]> = {
    backtest_live_parity: ['Define one execution-label schema shared by backtest, prospective labels, paper telemetry, and release-gate checks.'],
    event_driven_execution: ['Add event-time ordering checks for decision, availableAt, order, fill, and label settlement artifacts.'],
    order_book_matching: ['Require spread, depth, route-cost, and slippage-stress fields before strategy economics can count.'],
    protections: ['Promote stale-data, repeated stoploss, high spread, and daily loss rules into hard no-open blockers.'],
    hyperopt: ['Restrict parameter search to research-only sweeps with locked validation and parameter-stability reports.'],
    portfolio_risk_management: ['Add total exposure, symbol concentration, correlation, and long/short balance gates.'],
    connector_abstraction: ['Publish connector capability and QA artifacts for each exchange/data source without printing secrets.'],
    fast_parameter_sweep: ['Use fast sweeps to generate candidate hypotheses, then require independent OpenAlice validation.'],
    research_workflow: ['Treat AI-Scientist and native experiments as candidates with immutable source, data, and selection ledgers.'],
    evidence_reporting: ['Keep reason-chain and defect registry as the user-facing explanation of blocked versus allowed states.'],
  }
  return map[capabilityId] ?? ['Convert this framework lesson into a concrete OpenAlice artifact and test.']
}

function renderConsoleSummary(report: QuantFrameworkBenchmarkReport): string {
  return [
    `Quant framework benchmark: ${report.status}`,
    `frameworks=${report.summary.frameworks} capabilities=${report.summary.capabilities} blocked=${report.summary.blockedCapabilities} watch=${report.summary.watchCapabilities} missingEvidence=${report.summary.missingEvidenceCapabilities}`,
    `relatedOpenOrPartialDefects=${report.summary.relatedOpenOrPartialDefects} p0Related=${report.summary.p0RelatedOpenOrPartialDefects}`,
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

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_quant_framework_benchmark_report failed:', error)
    process.exit(1)
  })
}
