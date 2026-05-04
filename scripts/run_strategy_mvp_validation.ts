import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  runFdrCorrection,
  type FdrDiagnostics,
  type FdrItem,
  type FdrMethod,
} from '../src/backtest/fdr.js'
import {
  evaluateReleaseGate,
  type ReleaseGateCheck,
  type ReleaseGateResult,
  type ReleaseGateStatus,
} from '../src/backtest/release_gate.js'
import { evaluateRiskSimulation } from '../src/backtest/risk_simulation.js'
import {
  buildTrialLedgerSummary,
  computeSpaLikePValues,
  computeDeflatedSharpe,
  evaluateSignificanceGate,
} from '../src/backtest/statistical_significance.js'
import { runStrategyWalkForward } from '../src/backtest/wfo.js'
import { runStrategyBacktest } from '../src/backtest/strategy-validation/backtest.js'
import type { StrategyBacktestInput } from '../src/backtest/strategy-validation/backtest.js'
import { getStrategyMinimumBars } from '../src/backtest/strategy-validation/strategies.js'
import type {
  MarketData,
  StrategyRegimeLabel,
  StrategyName,
  StrategyParams,
} from '../src/backtest/strategy-validation/types.js'
import {
  isStrategyName,
  resolveStrategyParams,
} from '../src/backtest/strategy-validation/types.js'
import { writeReleaseGateStatus } from '../src/runtime/release_gate_status.js'
import {
  deriveManifestSourceDefaults,
  resolveSourceEligibility,
  type AdmissionIntent,
  type SourceEligibility,
  type SourceLineage,
  type SourceValidity,
} from '../src/runtime/source_eligibility.js'

type BootstrapMethod = 'iid_bootstrap' | 'moving_block_bootstrap'
type MultipleTestingUnit = 'candidate' | 'family'
type WfoProfile = 'stable' | 'shift' | 'stress'

interface CandidateConfig {
  strategyId: string
  strategyName: string
  strategy: StrategyName
  params: StrategyParams
  applicableSymbols?: string[]
  symbols?: string[]
  hypothesisFamily?: string
  correlationBucket?: string
  role?: 'donor' | 'benchmark_control' | 'robustness_anchor' | 'independent_guard'
  sourceValidity?: Partial<SourceValidity>
  runtimeMode?: SourceValidity['runtimeMode']
  sourceLineage?: SourceLineage
  evidenceStrength?: string
  fallbackReason?: string | null
  donorNative?: boolean
  promotionEligible?: boolean
  admissionIntent?: AdmissionIntent
  eligibilityBlockers?: string[]
  regimeGate?: StrategyBacktestInput['regimeGate']
  volatilityGate?: StrategyBacktestInput['volatilityGate']
}

interface DatasetSymbolConfig {
  inputCsv?: string
  symbol?: string
  lookbackBars?: number
}

interface CandidatesFile {
  schemaVersion?: string
  notes?: string[]
  dataset?: {
    inputCsv?: string
    symbol?: string
    lookbackBars?: number
    symbols?: DatasetSymbolConfig[]
  }
  thresholds?: {
    meanPboMax?: number
    meanDsrProbabilityMin?: number
    fdrQMax?: number
  }
  wfo?: {
    trainBars?: number
    testBars?: number
    stepBars?: number
    degradationThreshold?: number
    profile?: WfoProfile
  }
  significance?: {
    partitions?: number
    pboThreshold?: number
    dsrMin?: number
    multipleTestingUnit?: MultipleTestingUnit
    fdrMethod?: FdrMethod
    storeyLambda?: number
    cvAggQuantile?: number
    spaBootstrapSamples?: number
    spaBlockSize?: number
    spaBlockSizeSet?: number[]
    benchmarkStrategyIdBySymbol?: Record<string, string>
  }
  riskSimulation?: {
    method?: BootstrapMethod
    simulations?: number
    horizonBars?: number
    blockSize?: number
    ruinDrawdownPct?: number
    maxRuinProbability?: number
    minProfitProbability?: number
  }
  costModel?: {
    feeRate?: number
    slippageBps?: number
    latencyBars?: number
    fundingRatePer8h?: number
  }
  candidates?: CandidateConfig[]
}

interface CliArgs {
  candidatesFile: string
  output: string
  verdictOutput: string
  releaseGateStatusPath: string
  multipleTestingUnit?: MultipleTestingUnit
  fdrMethod?: FdrMethod
  wfoProfile?: WfoProfile
  storeyLambda?: number
  cvAggQuantile?: number
  selfCheck: boolean
  dryRun: boolean
}

interface DatasetSymbolTarget {
  inputCsv: string
  symbol: string
  lookbackBars: number
}

interface NormalizedCandidateConfig {
  strategyId: string
  strategyName: string
  strategy: StrategyName
  params: StrategyParams
  applicableSymbols: string[]
  hypothesisFamily?: string
  correlationBucket?: string
  role?: 'donor' | 'benchmark_control' | 'robustness_anchor' | 'independent_guard'
  sourceEligibility: SourceEligibility
  regimeGate?: StrategyBacktestInput['regimeGate']
  volatilityGate?: StrategyBacktestInput['volatilityGate']
}

interface ThresholdConfig {
  meanPboMax: number
  meanDsrProbabilityMin: number
  fdrQMax: number
}

interface WfoConfig {
  trainBars: number
  testBars: number
  stepBars: number
  degradationThreshold: number
  profile: WfoProfile
}

interface SignificanceConfig {
  partitions: number
  pboThreshold: number
  dsrMin: number
  multipleTestingUnit: MultipleTestingUnit
  fdrMethod: FdrMethod
  storeyLambda: number
  cvAggQuantile: number
  spaBootstrapSamples: number
  spaBlockSize: number
  spaBlockSizeSet: number[]
  benchmarkStrategyIdBySymbol: Record<string, string>
}

interface RiskConfig {
  method: BootstrapMethod
  simulations: number
  horizonBars: number
  blockSize: number
  ruinDrawdownPct: number
  maxRuinProbability: number
  minProfitProbability: number
}

interface CostModelConfig {
  feeRate: number
  slippageBps: number
  latencyBars: number
  fundingRatePer8h: number
}

type BacktestReport = ReturnType<typeof runStrategyBacktest>
type WfoResult = ReturnType<typeof runStrategyWalkForward>
type SignificanceResult = ReturnType<typeof evaluateSignificanceGate>
type RiskSimulationResult = ReturnType<typeof evaluateRiskSimulation>

interface RawRun {
  candidate: NormalizedCandidateConfig
  backtest: BacktestReport
  sampleSplit: SampleSplitAssessment
  significance: SignificanceResult
  riskSimulation: RiskSimulationResult
  wfo: WfoResult
  releaseGate: ReleaseGateResult
  pValue: number
}

interface EnrichedRun extends RawRun {
  familyKey: string
  correlationBucket: string
  familyRepresentative: boolean
  familyRepresentativeStrategyId: string
  candidateLevelFdr: FdrItem
  admissionSignificance: SignificanceResult
  fdr: FdrItem
  candidatePass: boolean
  failureReasons: string[]
}

interface SymbolSummary {
  symbol: string
  inputCsv: string
  lookbackBars: number
  applicableCandidateCount: number
  aggregateMetrics: {
    meanPbo: number
    meanDsrProbability: number
    fdrQ: number
    fdrMethod: FdrMethod
    fdrDiagnostics: FdrDiagnostics
    wfoProfile: WfoProfile
  }
  result: 'GO' | 'NO_GO'
  reasonCodes: string[]
  leader: EnrichedRun
  champion: EnrichedRun | null
  candidates: EnrichedRun[]
}

interface SampleSplitMetrics {
  totalReturnPct: number
  annualizedReturnPct: number
  maxDrawdownPct: number
  sharpe: number
  sortino: number
  calmar: number
  tradeCount: number
  winRatePct: number
  profitFactor: number
  payoffRatio: number
  expectancyPct: number
  grossExpectancyPct: number
  netExpectancyPct: number
  averageHoldingHours: number
  medianHoldingHours: number
  totalCostsPaid: number
  costDragPctOfInitialCapital: number
}

interface SampleSplitAssessment {
  available: boolean
  splitRatio: number
  splitIndex: number | null
  splitTime: number | null
  reason?: string
  inSample?: SampleSplitMetrics
  outOfSample?: SampleSplitMetrics
  returnDeltaPct?: number | null
  sharpeDelta?: number | null
  maxDrawdownDeltaPct?: number | null
  outOfSamplePositive?: boolean | null
}

interface AdmissionView {
  candidateLevelFdrItems: FdrItem[]
  admissionSignificanceByIndex: SignificanceResult[]
  admissionFdrByIndex: FdrItem[]
  admissionFdrDiagnostics: FdrDiagnostics
  familyKeyByIndex: string[]
  correlationBucketByIndex: string[]
  familyRepresentativeIndexByFamily: Map<string, number>
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.selfCheck) {
    runSelfCheck()
    console.log('run_strategy_mvp_validation self-check: ok')
    return
  }
  if (args.dryRun) {
    console.log(JSON.stringify({
      command: 'run_strategy_mvp_validation',
      executionMode: {
        dryRun: true,
        writesValidationRuns: false,
        writesVerdict: false,
        writesReleaseGateStatus: false,
        promotionEligible: false,
      },
      inputPaths: {
        candidatesFile: resolve(args.candidatesFile),
        output: resolve(args.output),
        verdictOutput: resolve(args.verdictOutput),
        releaseGateStatusPath: resolve(args.releaseGateStatusPath),
      },
      optIn: {
        runValidation: '--dryRun false',
      },
    }, null, 2))
    return
  }

  const config = await readCandidatesConfig(args.candidatesFile)
  const datasetSymbols = normalizeDatasetSymbols(config.dataset)
  const candidates = normalizeCandidates(
    config.candidates,
    datasetSymbols.map((item) => item.symbol),
    config.notes,
  )
  const thresholds = resolveThresholds(config.thresholds)
  const wfoConfig = resolveWfoProfile({
    ...resolveWfoConfig(config.wfo),
    profile: args.wfoProfile ?? config.wfo?.profile ?? 'stable',
  })
  const significanceConfig = resolveSignificanceConfig(
    config.significance,
    datasetSymbols.map((item) => item.symbol),
    args,
  )
  const riskConfig = resolveRiskConfig(config.riskSimulation)
  const costModel = resolveCostModel(config.costModel)

  const symbolSummaries: SymbolSummary[] = []
  for (const dataset of datasetSymbols) {
    symbolSummaries.push(
      await evaluateSymbolSummary({
        dataset,
        candidates,
        thresholds,
        wfoConfig,
        significanceConfig,
        riskConfig,
        costModel,
      }),
    )
  }

  const championSet = symbolSummaries
    .filter((summary) => summary.champion !== null)
    .map((summary) => buildChampionPayload(summary.symbol, summary.champion as EnrichedRun))
  const portfolioReleaseGate = aggregateReleaseGate(symbolSummaries)
  const aggregateMetrics = {
    meanPbo: mean(symbolSummaries.map((summary) => summary.aggregateMetrics.meanPbo)),
    meanDsrProbability: mean(
      symbolSummaries.map((summary) => summary.aggregateMetrics.meanDsrProbability),
    ),
    fdrQ: Math.max(0, ...symbolSummaries.map((summary) => summary.aggregateMetrics.fdrQ)),
  }
  const aggregatePass =
    aggregateMetrics.meanPbo <= thresholds.meanPboMax &&
    aggregateMetrics.meanDsrProbability >= thresholds.meanDsrProbabilityMin &&
    aggregateMetrics.fdrQ <= thresholds.fdrQMax &&
    championSet.length === datasetSymbols.length &&
    portfolioReleaseGate.allowPaperTrading
  const reasonCodes = buildPortfolioReasonCodes({
    symbolSummaries,
    thresholds,
    aggregateMetrics,
    championSetCount: championSet.length,
    requiredChampionCount: datasetSymbols.length,
    portfolioReleaseGate,
    aggregatePass,
  })

  const runPayload = {
    schemaVersion: 'strategy_validation_runs.v1',
    generatedAt: new Date().toISOString(),
    config: {
      dataset: buildDatasetConfigPayload(datasetSymbols),
      thresholds,
      wfo: wfoConfig,
      significance: significanceConfig,
      riskSimulation: riskConfig,
      costModel,
    },
    portfolio: {
      championSet,
      releaseGate: portfolioReleaseGate,
      result: aggregatePass ? 'GO' : 'NO_GO',
      reasonCodes,
      aggregateMetrics,
    },
    symbols: symbolSummaries.map((summary) => ({
      symbol: summary.symbol,
      inputCsv: summary.inputCsv,
      lookbackBars: summary.lookbackBars,
      applicableCandidateCount: summary.applicableCandidateCount,
      aggregateMetrics: summary.aggregateMetrics,
      leader: buildDetailedCandidatePayload(summary.symbol, summary.leader),
      champion:
        summary.champion === null
          ? null
          : buildDetailedCandidatePayload(summary.symbol, summary.champion),
      result: summary.result,
      reasonCodes: summary.reasonCodes,
      candidates: summary.candidates.map((run) =>
        buildDetailedCandidatePayload(summary.symbol, run),
      ),
    })),
  }

  await mkdir(dirname(resolve(args.output)), { recursive: true })
  await writeFile(resolve(args.output), `${JSON.stringify(runPayload, null, 2)}\n`, 'utf-8')

  await writeReleaseGateStatus(portfolioReleaseGate, {
    filePath: args.releaseGateStatusPath,
    sourceReportPath: resolve(args.output),
    result: aggregatePass ? 'GO' : 'NO_GO',
    reasonCodes,
  })

  const verdictPayload = {
    schemaVersion: 'experiment_verdict.v2',
    generatedAt: new Date().toISOString(),
    result: aggregatePass ? 'GO' : 'NO_GO',
    reasonCodes,
    thresholds,
    aggregateMetrics,
    championSet,
    portfolio: {
      requiredSymbols: datasetSymbols.map((item) => item.symbol),
      championSet,
      releaseGate: {
        allowPaperTrading: portfolioReleaseGate.allowPaperTrading,
        allowLiveTrading: portfolioReleaseGate.allowLiveTrading,
        failedChecks: portfolioReleaseGate.failedChecks,
      },
      result: aggregatePass ? 'GO' : 'NO_GO',
      reasonCodes,
    },
    symbols: symbolSummaries.map((summary) => ({
      symbol: summary.symbol,
      result: summary.result,
      reasonCodes: summary.reasonCodes,
      aggregateMetrics: summary.aggregateMetrics,
      champion:
        summary.champion === null
          ? null
          : buildChampionPayload(summary.symbol, summary.champion),
      leader: buildChampionPayload(summary.symbol, summary.leader),
      candidates: summary.candidates.map((run) => ({
        strategyId: run.candidate.strategyId,
        strategyName: run.candidate.strategyName,
        strategy: run.candidate.strategy,
        role: run.candidate.role ?? null,
        familyKey: run.familyKey,
        correlationBucket: run.correlationBucket,
        familyRepresentative: run.familyRepresentative,
        regimeGate: run.candidate.regimeGate ?? null,
        volatilityGate: run.candidate.volatilityGate ?? null,
        sourceEligibility: run.candidate.sourceEligibility,
        status: run.candidatePass ? 'pass' : 'fail',
        metrics: {
          pbo: run.admissionSignificance.pboResult.pbo,
          dsrProbability: run.admissionSignificance.dsrResult.dsrProbability,
          fdrQ: run.fdr.qValue,
        },
        failureReasons: run.failureReasons,
      })),
    })),
    outputPaths: {
      validationRuns: resolve(args.output),
      releaseGateStatus: resolve(args.releaseGateStatusPath),
    },
  }

  await mkdir(dirname(resolve(args.verdictOutput)), { recursive: true })
  await writeFile(
    resolve(args.verdictOutput),
    `${JSON.stringify(verdictPayload, null, 2)}\n`,
    'utf-8',
  )

  console.log(
    [
      `runs=${resolve(args.output)}`,
      `verdict=${resolve(args.verdictOutput)}`,
      `releaseGateStatus=${resolve(args.releaseGateStatusPath)}`,
      `result=${verdictPayload.result}`,
      `reasonCodes=${reasonCodes.join(',')}`,
    ].join(' | '),
  )

  if (!aggregatePass) {
    process.exitCode = 2
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    candidatesFile:
      raw.get('candidates') ?? 'docs/research/strategy_candidates.v1.json',
    output:
      raw.get('output') ?? 'data/research/strategy/strategy_validation_runs.json',
    verdictOutput:
      raw.get('verdict-output') ??
      'data/research/strategy/experiment_verdict.v2.json',
    releaseGateStatusPath:
      raw.get('release-gate-status-path') ??
      'data/runtime/release_gate_status.json',
    multipleTestingUnit:
      raw.get('multiple-testing-unit') === 'family' ? 'family' : undefined,
    fdrMethod: resolveOptionalFdrMethod(raw.get('fdr-method')),
    wfoProfile: resolveOptionalWfoProfile(raw.get('wfo-profile')),
    storeyLambda: toOptionalNumber(raw.get('storey-lambda')),
    cvAggQuantile: toOptionalNumber(raw.get('cv-agg-quantile')),
    selfCheck: raw.get('self-check') === 'true',
    dryRun: parseBoolArg(raw.get('dryRun'), true),
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) {
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    index += 1
  }
  return out
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${raw}`)
}

async function readCandidatesConfig(path: string): Promise<CandidatesFile> {
  const raw = await readFile(resolve(path), 'utf-8')
  return JSON.parse(raw) as CandidatesFile
}

function normalizeDatasetSymbols(dataset: CandidatesFile['dataset']): DatasetSymbolTarget[] {
  const fallbackLookbackBars = toPositiveInt(dataset?.lookbackBars, 3000, 'lookbackBars')
  const explicitSymbols = dataset?.symbols
  if (Array.isArray(explicitSymbols) && explicitSymbols.length > 0) {
    const seen = new Set<string>()
    return explicitSymbols.map((item, index) => {
      const symbol = normalizeString(item.symbol, '')
      const inputCsv = normalizeString(item.inputCsv, '')
      if (!symbol || !inputCsv) {
        throw new Error(`dataset.symbols[${index}] requires symbol and inputCsv.`)
      }
      if (seen.has(symbol)) {
        throw new Error(`dataset.symbols contains duplicate symbol "${symbol}".`)
      }
      seen.add(symbol)
      return {
        symbol,
        inputCsv,
        lookbackBars: toPositiveInt(
          item.lookbackBars,
          fallbackLookbackBars,
          `dataset.symbols[${index}].lookbackBars`,
        ),
      }
    })
  }
  return [
    {
      inputCsv: dataset?.inputCsv ?? 'data/market/okx/BTC_USDT_USDT_1h.csv',
      symbol: normalizeString(dataset?.symbol, 'BTC/USD'),
      lookbackBars: fallbackLookbackBars,
    },
  ]
}

function normalizeCandidates(
  raw: CandidatesFile['candidates'],
  datasetSymbols: string[],
  manifestNotes?: string[],
): NormalizedCandidateConfig[] {
  if (!Array.isArray(raw) || raw.length < 1) {
    throw new Error('candidates field must be a non-empty array.')
  }
  const allowedSymbols = new Set(datasetSymbols)
  const sourceDefaults = deriveManifestSourceDefaults(manifestNotes)
  return raw.map((item, index) => {
    if (!isStrategyName(item?.strategy)) {
      throw new Error(`candidates[${index}].strategy is invalid.`)
    }
    const applicableSymbols = normalizeSymbolList(
      item.applicableSymbols ?? item.symbols,
      datasetSymbols,
    )
    for (const symbol of applicableSymbols) {
      if (!allowedSymbols.has(symbol)) {
        throw new Error(`candidates[${index}] declares unsupported symbol "${symbol}".`)
      }
    }
    const role = normalizeCandidateRole(item.role)
    return {
      strategyId: normalizeString(item.strategyId, `S${index + 1}`),
      strategyName: normalizeString(item.strategyName, item.strategyId ?? `S${index + 1}`),
      strategy: item.strategy,
      params: (item.params ?? {}) as StrategyParams,
      applicableSymbols,
      hypothesisFamily: normalizeOptionalString(item.hypothesisFamily),
      correlationBucket: normalizeOptionalString(item.correlationBucket),
      role,
      sourceEligibility: resolveSourceEligibility(
        {
          sourceValidity: item.sourceValidity,
          runtimeMode: item.runtimeMode,
          sourceLineage: item.sourceLineage,
          evidenceStrength: item.evidenceStrength,
          fallbackReason: item.fallbackReason,
          donorNative: item.donorNative,
          promotionEligible: item.promotionEligible,
          admissionIntent: item.admissionIntent,
          eligibilityBlockers: item.eligibilityBlockers,
          role,
        },
        sourceDefaults,
      ),
      regimeGate: normalizeRegimeGate(item.regimeGate),
      volatilityGate: normalizeVolatilityGate(item.volatilityGate),
    }
  })
}

function normalizeCandidateRole(
  value: unknown,
): NormalizedCandidateConfig['role'] {
  return value === 'donor' ||
    value === 'benchmark_control' ||
    value === 'robustness_anchor' ||
    value === 'independent_guard'
    ? value
    : undefined
}

function normalizeRegimeGate(value: unknown): StrategyBacktestInput['regimeGate'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as {
    allowedEntryRegimes?: unknown
    exitOnMismatch?: unknown
  }
  const allowedEntryRegimes = Array.isArray(record.allowedEntryRegimes)
    ? record.allowedEntryRegimes.filter(isStrategyRegimeLabel)
    : []
  if (allowedEntryRegimes.length < 1) {
    return undefined
  }
  return {
    allowedEntryRegimes: Array.from(new Set(allowedEntryRegimes)),
    exitOnMismatch:
      typeof record.exitOnMismatch === 'boolean'
        ? record.exitOnMismatch
        : undefined,
  }
}

function normalizeVolatilityGate(value: unknown): StrategyBacktestInput['volatilityGate'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const out: NonNullable<StrategyBacktestInput['volatilityGate']> = {}
  const minVolatilityPct = optionalFiniteNumber(record.minVolatilityPct)
  const maxVolatilityPct = optionalFiniteNumber(record.maxVolatilityPct)
  const minTrendStrengthPct = optionalFiniteNumber(record.minTrendStrengthPct)
  const maxTrendStrengthPct = optionalFiniteNumber(record.maxTrendStrengthPct)
  if (minVolatilityPct !== undefined) out.minVolatilityPct = minVolatilityPct
  if (maxVolatilityPct !== undefined) out.maxVolatilityPct = maxVolatilityPct
  if (minTrendStrengthPct !== undefined) out.minTrendStrengthPct = minTrendStrengthPct
  if (maxTrendStrengthPct !== undefined) out.maxTrendStrengthPct = maxTrendStrengthPct
  if (typeof record.exitOnMismatch === 'boolean') {
    out.exitOnMismatch = record.exitOnMismatch
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function isStrategyRegimeLabel(value: unknown): value is StrategyRegimeLabel {
  return (
    value === 'HighVolTrend' ||
    value === 'HighVolMeanRevert' ||
    value === 'LowVolTrend' ||
    value === 'LowVolCarry'
  )
}

function optionalFiniteNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeSymbolList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || value.length < 1) {
    return [...fallback]
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      continue
    }
    const normalized = item.trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    out.push(normalized)
  }
  return out.length > 0 ? out : [...fallback]
}

function resolveThresholds(config: CandidatesFile['thresholds']): ThresholdConfig {
  return {
    meanPboMax: toFiniteNumber(config?.meanPboMax, 0.2, 'meanPboMax'),
    meanDsrProbabilityMin: toFiniteNumber(
      config?.meanDsrProbabilityMin,
      0.5,
      'meanDsrProbabilityMin',
    ),
    fdrQMax: toFiniteNumber(config?.fdrQMax, 0.1, 'fdrQMax'),
  }
}

function resolveWfoConfig(config: CandidatesFile['wfo']): WfoConfig {
  return {
    trainBars: toPositiveInt(config?.trainBars, 24 * 180, 'trainBars'),
    testBars: toPositiveInt(config?.testBars, 24 * 45, 'testBars'),
    stepBars: toPositiveInt(config?.stepBars, config?.testBars ?? 24 * 45, 'stepBars'),
    degradationThreshold: toFiniteNumber(
      config?.degradationThreshold,
      0.4,
      'degradationThreshold',
    ),
    profile: config?.profile ?? 'stable',
  }
}

function resolveSignificanceConfig(
  config: CandidatesFile['significance'],
  allowedSymbols: string[],
  args: CliArgs,
): SignificanceConfig {
  return {
    partitions: toPositiveInt(config?.partitions, 8, 'partitions'),
    pboThreshold: toFiniteNumber(config?.pboThreshold, 0.2, 'pboThreshold'),
    dsrMin: toFiniteNumber(config?.dsrMin, 0, 'dsrMin'),
    multipleTestingUnit:
      args.multipleTestingUnit ?? config?.multipleTestingUnit ?? 'candidate',
    fdrMethod: args.fdrMethod ?? config?.fdrMethod ?? 'bh',
    storeyLambda: args.storeyLambda ?? toFiniteNumber(config?.storeyLambda, 0.5, 'storeyLambda'),
    cvAggQuantile:
      args.cvAggQuantile ??
      toFiniteNumber(config?.cvAggQuantile, 0.9, 'cvAggQuantile'),
    spaBootstrapSamples: toPositiveInt(
      config?.spaBootstrapSamples,
      400,
      'spaBootstrapSamples',
    ),
    spaBlockSize: toPositiveInt(config?.spaBlockSize, 24, 'spaBlockSize'),
    spaBlockSizeSet: normalizePositiveIntArray(config?.spaBlockSizeSet, 'spaBlockSizeSet'),
    benchmarkStrategyIdBySymbol: normalizeBenchmarkStrategyIdBySymbol(
      config?.benchmarkStrategyIdBySymbol,
      allowedSymbols,
    ),
  }
}

function resolveRiskConfig(config: CandidatesFile['riskSimulation']): RiskConfig {
  return {
    method: config?.method ?? 'moving_block_bootstrap',
    simulations: toPositiveInt(config?.simulations, 1000, 'simulations'),
    horizonBars: toPositiveInt(config?.horizonBars, 24 * 30, 'horizonBars'),
    blockSize: toPositiveInt(config?.blockSize, 24, 'blockSize'),
    ruinDrawdownPct: toFiniteNumber(config?.ruinDrawdownPct, 30, 'ruinDrawdownPct'),
    maxRuinProbability: toFiniteNumber(
      config?.maxRuinProbability,
      0.02,
      'maxRuinProbability',
    ),
    minProfitProbability: toFiniteNumber(
      config?.minProfitProbability,
      0.55,
      'minProfitProbability',
    ),
  }
}

function resolveCostModel(config: CandidatesFile['costModel']): CostModelConfig {
  return {
    feeRate: toFiniteNumber(config?.feeRate, 0.0005, 'feeRate'),
    slippageBps: toFiniteNumber(config?.slippageBps, 3, 'slippageBps'),
    latencyBars: toPositiveInt(config?.latencyBars, 1, 'latencyBars'),
    fundingRatePer8h: toFiniteNumber(
      config?.fundingRatePer8h,
      0,
      'fundingRatePer8h',
    ),
  }
}

async function evaluateSymbolSummary(input: {
  dataset: DatasetSymbolTarget
  candidates: NormalizedCandidateConfig[]
  thresholds: ThresholdConfig
  wfoConfig: WfoConfig
  significanceConfig: SignificanceConfig
  riskConfig: RiskConfig
  costModel: CostModelConfig
}): Promise<SymbolSummary> {
  const applicableCandidates = input.candidates.filter((candidate) =>
    candidate.applicableSymbols.includes(input.dataset.symbol),
  )
  if (applicableCandidates.length < 1) {
    throw new Error(`No applicable candidates resolved for ${input.dataset.symbol}.`)
  }

  const candles = (await loadCsvCandles(input.dataset.inputCsv, input.dataset.symbol)).slice(
    -input.dataset.lookbackBars,
  )
  const adjustedWfoConfig = resolveWfoProfile(input.wfoConfig)
  if (candles.length < adjustedWfoConfig.trainBars + adjustedWfoConfig.testBars) {
    throw new Error(
      `Not enough candles for ${input.dataset.symbol} WFO. Need >= ${
        adjustedWfoConfig.trainBars + adjustedWfoConfig.testBars
      }, got ${candles.length}.`,
    )
  }

  const backtests = applicableCandidates.map((candidate) =>
    runStrategyBacktest({
      strategy: candidate.strategy,
      candles,
      params: candidate.params,
      costModel: input.costModel,
      regimeGate: candidate.regimeGate,
      volatilityGate: candidate.volatilityGate,
    }),
  )
  const returnsByCandidate = backtests.map((report) =>
    equityCurveToReturns(report.equityCurve),
  )
  const candidatePValues = buildCandidatePValues({
    rawCandidates: applicableCandidates,
    returnsByCandidate,
    significanceConfig: input.significanceConfig,
    symbol: input.dataset.symbol,
  })

  const rawRuns: RawRun[] = applicableCandidates.map((candidate, index) => {
    const trialLedger = buildTrialLedgerSummary({
      rawM: applicableCandidates.length,
      effectiveM: applicableCandidates.length,
      survivingTrialCount: 1,
      rawMComplete: true,
      includesFailedTrials: true,
    })
    const significance = evaluateSignificanceGate({
      candidateReturns: returnsByCandidate,
      selectedReturns: returnsByCandidate[index],
      partitions: input.significanceConfig.partitions,
      pboThreshold: input.significanceConfig.pboThreshold,
      dsrMin: input.significanceConfig.dsrMin,
      trialCount: applicableCandidates.length,
      trialLedger,
    })
    const riskSimulation = evaluateRiskSimulation(returnsByCandidate[index], {
      method: input.riskConfig.method,
      simulations: input.riskConfig.simulations,
      horizonBars: input.riskConfig.horizonBars,
      blockSize: input.riskConfig.blockSize,
      ruinDrawdownPct: input.riskConfig.ruinDrawdownPct,
      maxRuinProbability: input.riskConfig.maxRuinProbability,
      minProfitProbability: input.riskConfig.minProfitProbability,
    })
    const wfo = runStrategyWalkForward({
      strategy: candidate.strategy,
      candles,
      candidates: [candidate.params],
      costModel: input.costModel,
      regimeGate: candidate.regimeGate,
      volatilityGate: candidate.volatilityGate,
      config: {
        trainBars: adjustedWfoConfig.trainBars,
        testBars: adjustedWfoConfig.testBars,
        stepBars: adjustedWfoConfig.stepBars,
        degradationThreshold: adjustedWfoConfig.degradationThreshold,
        minTradesPerWindow: 1,
      },
    })
    const releaseGate = evaluateReleaseGate({
      wfo,
      significance,
      riskSimulation,
      economics: {
        grossExpectancyPct: backtests[index].metrics.grossExpectancyPct,
        netExpectancyPct: backtests[index].metrics.netExpectancyPct,
        feeExpectancyDragPct: backtests[index].metrics.feeExpectancyDragPct,
        slippageExpectancyDragPct: backtests[index].metrics.slippageExpectancyDragPct,
        fundingExpectancyDragPct: backtests[index].metrics.fundingExpectancyDragPct,
        totalCostsPaid: backtests[index].metrics.totalCostsPaid,
        costDragPctOfInitialCapital: backtests[index].metrics.costDragPctOfInitialCapital,
        averageHoldingHours: backtests[index].metrics.averageHoldingHours,
        medianHoldingHours: backtests[index].metrics.medianHoldingHours,
        tradeCount: backtests[index].metrics.tradeCount,
      },
    })

    return {
      candidate,
      backtest: backtests[index],
      sampleSplit: buildSampleSplitAssessment({
        strategy: candidate.strategy,
        candles,
        params: candidate.params,
        costModel: input.costModel,
        regimeGate: candidate.regimeGate,
        volatilityGate: candidate.volatilityGate,
      }),
      significance,
      riskSimulation,
      wfo,
      releaseGate,
      pValue: candidatePValues[index],
    }
  })

  const admissionView = buildAdmissionView({
    rawRuns,
    rawCandidates: applicableCandidates,
    returnsByCandidate,
    symbol: input.dataset.symbol,
    significanceConfig: input.significanceConfig,
    fdrQMax: input.thresholds.fdrQMax,
  })

  const enrichedRuns: EnrichedRun[] = rawRuns.map((run, index) => {
    const familyKey = admissionView.familyKeyByIndex[index]
    const familyRepresentativeIndex =
      admissionView.familyRepresentativeIndexByFamily.get(familyKey) ?? index
    const admissionSignificance = admissionView.admissionSignificanceByIndex[index]
    const fdr = admissionView.admissionFdrByIndex[index]
    const familyRepresentative = familyRepresentativeIndex === index
    const spaBootstrapBlockReason = resolveSpaBootstrapBlockReason({
      diagnostics: admissionView.admissionFdrDiagnostics,
      candidateIndex: fdr.index,
    })
    const releaseGate = evaluateReleaseGate({
      wfo: run.wfo,
      significance: {
        ...admissionSignificance,
        fdrDiagnostics: admissionView.admissionFdrDiagnostics,
      },
      riskSimulation: run.riskSimulation,
      economics: {
        grossExpectancyPct: run.backtest.metrics.grossExpectancyPct,
        netExpectancyPct: run.backtest.metrics.netExpectancyPct,
        feeExpectancyDragPct: run.backtest.metrics.feeExpectancyDragPct,
        slippageExpectancyDragPct: run.backtest.metrics.slippageExpectancyDragPct,
        fundingExpectancyDragPct: run.backtest.metrics.fundingExpectancyDragPct,
        totalCostsPaid: run.backtest.metrics.totalCostsPaid,
        costDragPctOfInitialCapital: run.backtest.metrics.costDragPctOfInitialCapital,
        averageHoldingHours: run.backtest.metrics.averageHoldingHours,
        medianHoldingHours: run.backtest.metrics.medianHoldingHours,
        tradeCount: run.backtest.metrics.tradeCount,
      },
    })
    const candidatePass =
      admissionSignificance.pboResult.pbo <= input.thresholds.meanPboMax &&
      dsrProbabilityPasses(
        admissionSignificance.dsrResult.dsrProbability,
        input.thresholds.meanDsrProbabilityMin,
      ) &&
      fdr.qValue <= input.thresholds.fdrQMax &&
      spaBootstrapBlockReason === null &&
      releaseGate.allowPaperTrading &&
      run.candidate.sourceEligibility.promotionEligible &&
      (input.significanceConfig.multipleTestingUnit !== 'family' ||
        familyRepresentative)
    const failureReasons: string[] = []
    if (admissionSignificance.pboResult.pbo > input.thresholds.meanPboMax) {
      failureReasons.push('HARD_PBO_THRESHOLD_FAIL')
    }
    if (
      !dsrProbabilityPasses(
        admissionSignificance.dsrResult.dsrProbability,
        input.thresholds.meanDsrProbabilityMin,
      )
    ) {
      failureReasons.push(admissionSignificance.dsrResult.dsrProbability == null
        ? 'HARD_DSR_LOW_SAMPLE'
        : 'HARD_DSR_PROBABILITY_THRESHOLD_FAIL')
    }
    if (fdr.qValue > input.thresholds.fdrQMax) {
      failureReasons.push('HARD_FDR_THRESHOLD_FAIL')
    }
    if (spaBootstrapBlockReason) {
      failureReasons.push(spaBootstrapBlockReason)
    }
    if (!releaseGate.allowPaperTrading) {
      failureReasons.push('HARD_RELEASE_GATE_BLOCKED')
    }
    if (!run.candidate.sourceEligibility.promotionEligible) {
      failureReasons.push('HARD_SOURCE_ELIGIBILITY_BLOCKED')
      failureReasons.push(...run.candidate.sourceEligibility.eligibilityBlockers)
    }
    if (
      input.significanceConfig.multipleTestingUnit === 'family' &&
      !familyRepresentative
    ) {
      failureReasons.push('FAMILY_REPRESENTATIVE_NOT_SELECTED')
    }
    return {
      ...run,
      releaseGate,
      familyKey,
      correlationBucket: admissionView.correlationBucketByIndex[index],
      familyRepresentative,
      familyRepresentativeStrategyId:
        rawRuns[familyRepresentativeIndex]?.candidate.strategyId ??
        run.candidate.strategyId,
      candidateLevelFdr: admissionView.candidateLevelFdrItems[index],
      admissionSignificance,
      fdr,
      candidatePass,
      failureReasons,
    }
  })

  const leader = selectHighestSharpeRun(enrichedRuns)
  if (!leader) {
    throw new Error(`No leader candidate resolved for ${input.dataset.symbol}.`)
  }
  const champion = selectHighestSharpeRun(enrichedRuns.filter((run) => run.candidatePass))
  const aggregateRuns =
    input.significanceConfig.multipleTestingUnit === 'family'
      ? enrichedRuns.filter((run) => run.familyRepresentative)
      : enrichedRuns
  const aggregateMetrics = {
    meanPbo: mean(aggregateRuns.map((run) => run.admissionSignificance.pboResult.pbo)),
    meanDsrProbability: mean(
      aggregateRuns.map(
        (run) => dsrProbabilityForAggregate(run.admissionSignificance.dsrResult.dsrProbability),
      ),
    ),
    fdrQ: champion ? champion.fdr.qValue : 1,
    fdrMethod: input.significanceConfig.fdrMethod,
    fdrDiagnostics: admissionView.admissionFdrDiagnostics,
    wfoProfile: adjustedWfoConfig.profile,
  }
  const aggregatePass =
    aggregateMetrics.meanPbo <= input.thresholds.meanPboMax &&
    aggregateMetrics.meanDsrProbability >=
      input.thresholds.meanDsrProbabilityMin &&
    aggregateMetrics.fdrQ <= input.thresholds.fdrQMax &&
    champion !== null &&
    champion.releaseGate.allowPaperTrading
  const reasonCodes = buildSymbolReasonCodes({
    thresholds: input.thresholds,
    aggregateMetrics,
    fdrDiagnostics: admissionView.admissionFdrDiagnostics,
    champion,
    sourceEligibilityBlocked: enrichedRuns.some(
      (run) => !run.candidate.sourceEligibility.promotionEligible,
    ),
    aggregatePass,
  })

  return {
    symbol: input.dataset.symbol,
    inputCsv: input.dataset.inputCsv,
    lookbackBars: input.dataset.lookbackBars,
    applicableCandidateCount: applicableCandidates.length,
    aggregateMetrics,
    result: aggregatePass ? 'GO' : 'NO_GO',
    reasonCodes,
    leader,
    champion,
    candidates: enrichedRuns,
  }
}

function buildAdmissionView(input: {
  rawRuns: RawRun[]
  rawCandidates: NormalizedCandidateConfig[]
  returnsByCandidate: number[][]
  symbol: string
  significanceConfig: SignificanceConfig
  fdrQMax: number
}): AdmissionView {
  const familyKeyByIndex = input.rawRuns.map((run) =>
    deriveCandidateFamilyKey(run.candidate),
  )
  const correlationBucketByIndex = input.rawRuns.map((run) =>
    deriveCandidateCorrelationBucket(run.candidate),
  )
  const candidateWindowPValues =
    input.significanceConfig.fdrMethod === 'cv_storey_bh'
      ? buildWindowPValuesByCandidate({
          returnsByCandidate: input.returnsByCandidate,
          trialCount: input.rawRuns.length,
          partitions: input.significanceConfig.partitions,
        })
      : undefined
  const candidateSpaDiagnostics =
    input.significanceConfig.fdrMethod === 'spa'
      ? buildSpaBootstrapDiagnostics({
          rawCandidates: input.rawCandidates,
          returnsByCandidate: input.returnsByCandidate,
          significanceConfig: input.significanceConfig,
          fdrQMax: input.fdrQMax,
          symbol: input.symbol,
        })
      : undefined
  const candidateLevelFdr = runFdrCorrection({
    pValues: input.rawRuns.map((run) => run.pValue),
    alpha: input.fdrQMax,
    method: input.significanceConfig.fdrMethod,
    storeyLambda: input.significanceConfig.storeyLambda,
    cvAggQuantile: input.significanceConfig.cvAggQuantile,
    windowPValuesByCandidate: candidateWindowPValues,
    benchmarkStrategyId:
      input.significanceConfig.benchmarkStrategyIdBySymbol[input.symbol] ??
      input.rawCandidates[0]?.strategyId ??
      null,
    benchmarkStrategyIndex: resolveSymbolBenchmarkIndex({
      candidates: input.rawCandidates,
      significanceConfig: input.significanceConfig,
      symbol: input.symbol,
    }),
    spaBootstrapDiagnostics: candidateSpaDiagnostics,
  })
  const familyRepresentativeIndexByFamily =
    resolveFamilyRepresentativeIndexByFamily(input.rawRuns, familyKeyByIndex)

  if (input.significanceConfig.multipleTestingUnit !== 'family') {
    return {
      candidateLevelFdrItems: candidateLevelFdr.items,
      admissionSignificanceByIndex: input.rawRuns.map((run) => run.significance),
      admissionFdrByIndex: candidateLevelFdr.items,
      admissionFdrDiagnostics: candidateLevelFdr.diagnostics,
      familyKeyByIndex,
      correlationBucketByIndex,
      familyRepresentativeIndexByFamily,
    }
  }

  const representativeIndices = Array.from(
    familyRepresentativeIndexByFamily.values(),
  ).sort((left, right) => left - right)
  const representativeRuns = representativeIndices.map((index) => input.rawRuns[index])
  const representativeReturns = representativeIndices.map(
    (index) => input.returnsByCandidate[index],
  )
  const representativePValues = representativeRuns.map((run) => run.pValue)
  const representativeWindowPValues =
    input.significanceConfig.fdrMethod === 'cv_storey_bh'
      ? representativeIndices.map((index) => candidateWindowPValues?.[index] ?? [input.rawRuns[index].pValue])
      : undefined
  const representativeSpaDiagnostics =
    input.significanceConfig.fdrMethod === 'spa'
      ? buildSpaBootstrapDiagnostics({
          rawCandidates: representativeRuns.map((run) => run.candidate),
          returnsByCandidate: representativeReturns,
          significanceConfig: input.significanceConfig,
          fdrQMax: input.fdrQMax,
          symbol: input.symbol,
        })
      : undefined
  const representativeFdr = runFdrCorrection({
    pValues: representativePValues,
    alpha: input.fdrQMax,
    method: input.significanceConfig.fdrMethod,
    storeyLambda: input.significanceConfig.storeyLambda,
    cvAggQuantile: input.significanceConfig.cvAggQuantile,
    windowPValuesByCandidate: representativeWindowPValues,
    benchmarkStrategyId:
      input.significanceConfig.benchmarkStrategyIdBySymbol[input.symbol] ??
      representativeRuns[0]?.candidate.strategyId ??
      null,
    benchmarkStrategyIndex: resolveSymbolBenchmarkIndex({
      candidates: representativeRuns.map((run) => run.candidate),
      significanceConfig: input.significanceConfig,
      symbol: input.symbol,
    }),
    spaBootstrapDiagnostics: representativeSpaDiagnostics,
  })
  const representativeSignificance = representativeIndices.map((_, index) =>
    evaluateSignificanceGate({
      candidateReturns: representativeReturns,
      selectedReturns: representativeReturns[index],
      partitions: input.significanceConfig.partitions,
      pboThreshold: input.significanceConfig.pboThreshold,
      dsrMin: input.significanceConfig.dsrMin,
      trialCount: representativeIndices.length,
      trialLedger: buildTrialLedgerSummary({
        rawM: representativeIndices.length,
        effectiveM: representativeIndices.length,
        survivingTrialCount: 1,
        rawMComplete: true,
        includesFailedTrials: true,
      }),
    }),
  )
  const familyRank = new Map<string, number>()
  representativeIndices.forEach((candidateIndex, rank) => {
    familyRank.set(familyKeyByIndex[candidateIndex], rank)
  })

  return {
    candidateLevelFdrItems: candidateLevelFdr.items,
    admissionSignificanceByIndex: input.rawRuns.map((_, index) => {
      const rank = familyRank.get(familyKeyByIndex[index]) ?? 0
      return representativeSignificance[rank]
    }),
    admissionFdrByIndex: input.rawRuns.map((_, index) => {
      const rank = familyRank.get(familyKeyByIndex[index]) ?? 0
      return representativeFdr.items[rank]
    }),
    admissionFdrDiagnostics: representativeFdr.diagnostics,
    familyKeyByIndex,
    correlationBucketByIndex,
    familyRepresentativeIndexByFamily,
  }
}

function buildCandidatePValues(input: {
  rawCandidates: NormalizedCandidateConfig[]
  returnsByCandidate: number[][]
  significanceConfig: SignificanceConfig
  symbol: string
}): number[] {
  if (input.significanceConfig.fdrMethod !== 'spa') {
    return input.returnsByCandidate.map((returns) =>
      clamp01(
        dsrProbabilityToPValue(computeDeflatedSharpe({
          returns,
          trialCount: input.rawCandidates.length,
        }).dsrProbability),
      ),
    )
  }

  const benchmarkIndex = resolveSymbolBenchmarkIndex({
    candidates: input.rawCandidates,
    significanceConfig: input.significanceConfig,
    symbol: input.symbol,
  })
  return computeSpaLikePValues({
    candidateReturns: input.returnsByCandidate,
    benchmarkIndex,
    bootstrapSamples: input.significanceConfig.spaBootstrapSamples,
    blockSize: input.significanceConfig.spaBlockSize,
    blockSizeSet: input.significanceConfig.spaBlockSizeSet,
  }).items.map((item) => clamp01(item.pValue))
}

function buildSpaBootstrapDiagnostics(input: {
  rawCandidates: NormalizedCandidateConfig[]
  returnsByCandidate: number[][]
  significanceConfig: SignificanceConfig
  fdrQMax: number
  symbol: string
}): NonNullable<Parameters<typeof runFdrCorrection>[0]['spaBootstrapDiagnostics']> {
  const benchmarkIndex = resolveSymbolBenchmarkIndex({
    candidates: input.rawCandidates,
    significanceConfig: input.significanceConfig,
    symbol: input.symbol,
  })
  const spa = computeSpaLikePValues({
    candidateReturns: input.returnsByCandidate,
    benchmarkIndex,
    bootstrapSamples: input.significanceConfig.spaBootstrapSamples,
    blockSize: input.significanceConfig.spaBlockSize,
    blockSizeSet: input.significanceConfig.spaBlockSizeSet,
    alpha: input.fdrQMax,
  })
  return {
    bootstrapDirectionStable: spa.bootstrapDirectionStable,
    unstableBootstrapCandidateIndexes: spa.unstableBootstrapCandidateIndexes,
    blockSizeSet: spa.blockSizeSet,
    blockSensitivityByCandidate: spa.items.map(item => ({
      candidateIndex: item.candidateIndex,
      blockSensitivity: item.blockSensitivity,
      bootstrapDirectionStable: item.bootstrapDirectionStable,
      unstableBootstrap: item.unstableBootstrap,
    })),
  }
}

function buildWindowPValuesByCandidate(input: {
  returnsByCandidate: number[][]
  trialCount: number
  partitions: number
}): number[][] {
  return input.returnsByCandidate.map((returns) => {
    const windows = splitReturnsIntoCvWindows(returns, input.partitions)
    return windows.map((windowReturns) =>
      clamp01(
        dsrProbabilityToPValue(computeDeflatedSharpe({
          returns: windowReturns,
          trialCount: input.trialCount,
        }).dsrProbability),
      ),
    )
  })
}

function splitReturnsIntoCvWindows(returns: number[], partitions: number): number[][] {
  const targetWindowCount = Math.max(3, partitions * 2)
  const maxWindowCount = Math.max(1, Math.floor(returns.length / 8))
  const windowCount = Math.max(1, Math.min(targetWindowCount, maxWindowCount))
  const blockSize = Math.max(8, Math.floor(returns.length / windowCount))
  const windows: number[][] = []
  for (let index = 0; index < windowCount; index += 1) {
    const start = index * blockSize
    const end =
      index === windowCount - 1 ? returns.length : Math.min(returns.length, start + blockSize)
    const slice = returns.slice(start, end)
    if (slice.length >= 8) {
      windows.push(slice)
    }
  }
  return windows.length > 0 ? windows : [returns]
}

function resolveFamilyRepresentativeIndexByFamily(
  runs: RawRun[],
  familyKeyByIndex: string[],
): Map<string, number> {
  const out = new Map<string, number>()
  familyKeyByIndex.forEach((familyKey, index) => {
    const existingIndex = out.get(familyKey)
    if (existingIndex === undefined) {
      out.set(familyKey, index)
      return
    }
    if (isPreferredFamilyRepresentative(runs[index], runs[existingIndex])) {
      out.set(familyKey, index)
    }
  })
  return out
}

function isPreferredFamilyRepresentative(candidate: RawRun, existing: RawRun): boolean {
  const sharpeDelta = candidate.backtest.metrics.sharpe - existing.backtest.metrics.sharpe
  if (Math.abs(sharpeDelta) > 1e-9) {
    return sharpeDelta > 0
  }
  return candidate.pValue < existing.pValue
}

function resolveSymbolBenchmarkIndex(input: {
  candidates: NormalizedCandidateConfig[]
  significanceConfig: SignificanceConfig
  symbol: string
}): number {
  const configured =
    input.significanceConfig.benchmarkStrategyIdBySymbol[input.symbol]
  if (!configured) {
    return 0
  }
  const found = input.candidates.findIndex((candidate) => candidate.strategyId === configured)
  return found >= 0 ? found : 0
}

function deriveCandidateFamilyKey(candidate: NormalizedCandidateConfig): string {
  if (candidate.hypothesisFamily) {
    return candidate.hypothesisFamily
  }
  const semanticTokens = `${candidate.strategyName} ${candidate.strategyId}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token))
    .slice(0, 3)
  return semanticTokens.length > 0
    ? [candidate.strategy, ...semanticTokens].join(':')
    : candidate.strategy
}

function deriveCandidateCorrelationBucket(candidate: NormalizedCandidateConfig): string {
  return candidate.correlationBucket ?? deriveCandidateFamilyKey(candidate)
}

function selectHighestSharpeRun(runs: EnrichedRun[]): EnrichedRun | null {
  if (runs.length < 1) {
    return null
  }
  return [...runs].sort((left, right) => right.backtest.metrics.sharpe - left.backtest.metrics.sharpe)[0]
}

function buildChampionPayload(symbol: string, run: EnrichedRun) {
  return {
    symbol,
    strategyId: run.candidate.strategyId,
    strategyName: run.candidate.strategyName,
    strategy: run.candidate.strategy,
    role: run.candidate.role ?? null,
    sharpe: run.backtest.metrics.sharpe,
    releaseGateAllowPaper: run.releaseGate.allowPaperTrading,
    releaseGateAllowLive: run.releaseGate.allowLiveTrading,
    fdrQ: run.fdr.qValue,
    familyKey: run.familyKey,
    correlationBucket: run.correlationBucket,
    applicableSymbols: run.candidate.applicableSymbols,
    regimeGate: run.candidate.regimeGate ?? null,
    volatilityGate: run.candidate.volatilityGate ?? null,
    sourceEligibility: run.candidate.sourceEligibility,
  }
}

function buildDetailedCandidatePayload(symbol: string, run: EnrichedRun) {
  const failedWindowRatio =
    run.wfo.windows.length > 0 ? run.wfo.failedWindows / run.wfo.windows.length : 0
  return {
    symbol,
    strategyId: run.candidate.strategyId,
    strategyName: run.candidate.strategyName,
    strategy: run.candidate.strategy,
    role: run.candidate.role ?? null,
    familyKey: run.familyKey,
    correlationBucket: run.correlationBucket,
    familyRepresentative: run.familyRepresentative,
    familyRepresentativeStrategyId: run.familyRepresentativeStrategyId,
    params: run.candidate.params,
    applicableSymbols: run.candidate.applicableSymbols,
    regimeGate: run.candidate.regimeGate ?? null,
    volatilityGate: run.candidate.volatilityGate ?? null,
    sourceEligibility: run.candidate.sourceEligibility,
    status: run.candidatePass ? 'pass' : 'fail',
    failureReasons: run.failureReasons,
    blockerSummary: buildCandidateBlockerSummary(run, failedWindowRatio),
    backtestMetrics: run.backtest.metrics,
    significance: {
      pbo: run.admissionSignificance.pboResult.pbo,
      dsrValue: run.admissionSignificance.dsrResult.dsrValue,
      dsrProbability: run.admissionSignificance.dsrResult.dsrProbability,
    },
    candidateLevelSignificance: {
      pbo: run.significance.pboResult.pbo,
      dsrValue: run.significance.dsrResult.dsrValue,
      dsrProbability: run.significance.dsrResult.dsrProbability,
    },
    fdr: run.fdr,
    candidateLevelFdr: run.candidateLevelFdr,
    releaseGate: run.releaseGate,
    wfo: {
      overallPassed: run.wfo.overallPassed,
      failedWindows: run.wfo.failedWindows,
      windowCount: run.wfo.windows.length,
      failedWindowRatio,
    },
    sampleSplit: run.sampleSplit,
  }
}

function buildCandidateBlockerSummary(run: EnrichedRun, failedWindowRatio: number) {
  const releaseGateFailedChecks = [...run.releaseGate.failedChecks]
  return {
    primaryBlocker: resolvePrimaryBlocker(run, releaseGateFailedChecks),
    admission: {
      passed: run.candidatePass,
      failureReasons: [...run.failureReasons],
    },
    fdr: {
      passed: run.fdr.passed,
      qValue: run.fdr.qValue,
      threshold: run.fdr.threshold,
    },
    candidateLevelFdr: {
      passed: run.candidateLevelFdr.passed,
      qValue: run.candidateLevelFdr.qValue,
      threshold: run.candidateLevelFdr.threshold,
    },
    releaseGate: {
      allowPaperTrading: run.releaseGate.allowPaperTrading,
      allowLiveTrading: run.releaseGate.allowLiveTrading,
      failedChecks: releaseGateFailedChecks,
    },
    sourceEligibility: {
      passed: run.candidate.sourceEligibility.promotionEligible,
      runtimeMode: run.candidate.sourceEligibility.sourceValidity.runtimeMode,
      sourceLineage: run.candidate.sourceEligibility.sourceValidity.sourceLineage,
      donorNative: run.candidate.sourceEligibility.donorNative,
      admissionIntent: run.candidate.sourceEligibility.admissionIntent,
      eligibilityBlockers: [...run.candidate.sourceEligibility.eligibilityBlockers],
    },
    wfo: {
      passed: run.wfo.overallPassed,
      failedWindows: run.wfo.failedWindows,
      windowCount: run.wfo.windows.length,
      failedWindowRatio,
    },
  }
}

function resolvePrimaryBlocker(
  run: EnrichedRun,
  releaseGateFailedChecks: ReleaseGateCheck['name'][],
): 'source_eligibility' | 'fdr' | 'release_gate' | 'wfo' | 'economics' | 'candidate_pass' {
  if (!run.candidate.sourceEligibility.promotionEligible) {
    return 'source_eligibility'
  }
  if (!run.fdr.passed) {
    return 'fdr'
  }
  if (releaseGateFailedChecks.includes('wfo')) {
    return 'wfo'
  }
  if (releaseGateFailedChecks.includes('economics')) {
    return 'economics'
  }
  if (!run.releaseGate.allowPaperTrading) {
    return 'release_gate'
  }
  return 'candidate_pass'
}

function buildDatasetConfigPayload(datasetSymbols: DatasetSymbolTarget[]) {
  const primary = datasetSymbols[0]
  return {
    inputCsv: primary.inputCsv,
    symbol: primary.symbol,
    lookbackBars: primary.lookbackBars,
    symbols: datasetSymbols,
  }
}

function summarizeSampleSplitMetrics(metrics: BacktestReport['metrics']): SampleSplitMetrics {
  return {
    totalReturnPct: metrics.totalReturnPct,
    annualizedReturnPct: metrics.annualizedReturnPct,
    maxDrawdownPct: metrics.maxDrawdownPct,
    sharpe: metrics.sharpe,
    sortino: metrics.sortino,
    calmar: metrics.calmar,
    tradeCount: metrics.tradeCount,
    winRatePct: metrics.winRatePct,
    profitFactor: metrics.profitFactor,
    payoffRatio: metrics.payoffRatio,
    expectancyPct: metrics.expectancyPct,
    grossExpectancyPct: metrics.grossExpectancyPct,
    netExpectancyPct: metrics.netExpectancyPct,
    averageHoldingHours: metrics.averageHoldingHours,
    medianHoldingHours: metrics.medianHoldingHours,
    totalCostsPaid: metrics.totalCostsPaid,
    costDragPctOfInitialCapital: metrics.costDragPctOfInitialCapital,
  }
}

function buildSampleSplitAssessment(input: {
  strategy: StrategyName
  candles: MarketData[]
  params: StrategyParams
  costModel: CostModelConfig
  regimeGate?: StrategyBacktestInput['regimeGate']
  volatilityGate?: StrategyBacktestInput['volatilityGate']
}): SampleSplitAssessment {
  const splitRatio = 0.7
  const minBars = getStrategyMinimumBars(
    input.strategy,
    resolveStrategyParams(input.params),
  )
  const minSegmentBars = minBars + 2
  const tentativeSplitIndex = Math.floor(input.candles.length * splitRatio)
  const splitIndex = Math.max(
    minSegmentBars,
    Math.min(input.candles.length - minSegmentBars, tentativeSplitIndex),
  )
  if (
    input.candles.length < minSegmentBars * 2 ||
    splitIndex <= 0 ||
    splitIndex >= input.candles.length
  ) {
    return {
      available: false,
      splitRatio,
      splitIndex: null,
      splitTime: null,
      reason: 'not_enough_candles_for_split',
    }
  }

  const inSampleCandles = input.candles.slice(0, splitIndex)
  const outOfSampleCandles = input.candles.slice(splitIndex)
  try {
    const inSample = runStrategyBacktest({
      strategy: input.strategy,
      candles: inSampleCandles,
      params: input.params,
      costModel: input.costModel,
      regimeGate: input.regimeGate,
      volatilityGate: input.volatilityGate,
    })
    const outOfSample = runStrategyBacktest({
      strategy: input.strategy,
      candles: outOfSampleCandles,
      params: input.params,
      costModel: input.costModel,
      regimeGate: input.regimeGate,
      volatilityGate: input.volatilityGate,
    })
    return {
      available: true,
      splitRatio,
      splitIndex,
      splitTime: input.candles[splitIndex]?.time ?? null,
      inSample: summarizeSampleSplitMetrics(inSample.metrics),
      outOfSample: summarizeSampleSplitMetrics(outOfSample.metrics),
      returnDeltaPct:
        outOfSample.metrics.totalReturnPct - inSample.metrics.totalReturnPct,
      sharpeDelta: outOfSample.metrics.sharpe - inSample.metrics.sharpe,
      maxDrawdownDeltaPct:
        outOfSample.metrics.maxDrawdownPct - inSample.metrics.maxDrawdownPct,
      outOfSamplePositive: outOfSample.metrics.totalReturnPct > 0,
    }
  } catch (error) {
    return {
      available: false,
      splitRatio,
      splitIndex,
      splitTime: input.candles[splitIndex]?.time ?? null,
      reason:
        error instanceof Error ? error.message : 'sample_split_backtest_failed',
    }
  }
}

function buildSymbolReasonCodes(input: {
  thresholds: ThresholdConfig
  aggregateMetrics: {
    meanPbo: number
    meanDsrProbability: number
    fdrQ: number
  }
  fdrDiagnostics: FdrDiagnostics
  champion: EnrichedRun | null
  sourceEligibilityBlocked: boolean
  aggregatePass: boolean
}): string[] {
  const reasonCodes: string[] = []
  if (input.aggregateMetrics.meanPbo > input.thresholds.meanPboMax) {
    reasonCodes.push('HARD_MEAN_PBO_THRESHOLD_FAIL')
  }
  if (input.aggregateMetrics.meanDsrProbability < input.thresholds.meanDsrProbabilityMin) {
    reasonCodes.push('HARD_MEAN_DSR_PROBABILITY_THRESHOLD_FAIL')
  }
  if (input.aggregateMetrics.fdrQ > input.thresholds.fdrQMax) {
    reasonCodes.push('HARD_FDR_THRESHOLD_FAIL')
  }
  const spaAggregateBlockReason = resolveSpaBootstrapAggregateBlockReason(input.fdrDiagnostics)
  if (spaAggregateBlockReason) {
    reasonCodes.push(spaAggregateBlockReason)
  }
  if (input.champion === null) {
    reasonCodes.push('HARD_NO_CANDIDATE_PASS')
  } else if (!input.champion.releaseGate.allowPaperTrading) {
    reasonCodes.push('HARD_RELEASE_GATE_BLOCKED')
  }
  if (input.sourceEligibilityBlocked) {
    reasonCodes.push('HARD_SOURCE_ELIGIBILITY_BLOCKED')
  }
  if (reasonCodes.length === 0 && input.aggregatePass) {
    reasonCodes.push('INFO_MVP_THRESHOLDS_PASS')
  }
  return reasonCodes
}

function resolveSpaBootstrapBlockReason(input: {
  diagnostics: FdrDiagnostics
  candidateIndex: number
}): 'HARD_SPA_BOOTSTRAP_UNSTABLE' | 'HARD_SPA_BOOTSTRAP_MISSING' | null {
  if (input.diagnostics.method !== 'spa') return null
  if (input.diagnostics.bootstrapDirectionStable == null) {
    return 'HARD_SPA_BOOTSTRAP_MISSING'
  }
  const unstable = input.diagnostics.unstableBootstrapCandidateIndexes ?? []
  return unstable.includes(input.candidateIndex)
    ? 'HARD_SPA_BOOTSTRAP_UNSTABLE'
    : null
}

function resolveSpaBootstrapAggregateBlockReason(
  diagnostics: FdrDiagnostics,
): 'HARD_SPA_BOOTSTRAP_UNSTABLE' | 'HARD_SPA_BOOTSTRAP_MISSING' | null {
  if (diagnostics.method !== 'spa') return null
  if (diagnostics.bootstrapDirectionStable == null) {
    return 'HARD_SPA_BOOTSTRAP_MISSING'
  }
  return diagnostics.unstableBootstrapCandidateIndexes?.length
    ? 'HARD_SPA_BOOTSTRAP_UNSTABLE'
    : null
}

function buildPortfolioReasonCodes(input: {
  symbolSummaries: SymbolSummary[]
  thresholds: ThresholdConfig
  aggregateMetrics: {
    meanPbo: number
    meanDsrProbability: number
    fdrQ: number
  }
  championSetCount: number
  requiredChampionCount: number
  portfolioReleaseGate: ReleaseGateResult
  aggregatePass: boolean
}): string[] {
  const reasonCodes: string[] = []
  if (input.aggregateMetrics.meanPbo > input.thresholds.meanPboMax) {
    reasonCodes.push('HARD_MEAN_PBO_THRESHOLD_FAIL')
  }
  if (input.aggregateMetrics.meanDsrProbability < input.thresholds.meanDsrProbabilityMin) {
    reasonCodes.push('HARD_MEAN_DSR_PROBABILITY_THRESHOLD_FAIL')
  }
  if (input.aggregateMetrics.fdrQ > input.thresholds.fdrQMax) {
    reasonCodes.push('HARD_FDR_THRESHOLD_FAIL')
  }
  if (input.championSetCount === 0) {
    reasonCodes.push('HARD_NO_CANDIDATE_PASS')
  }
  if (input.championSetCount < input.requiredChampionCount) {
    reasonCodes.push('HARD_PORTFOLIO_CHAMPION_SET_INCOMPLETE')
  }
  if (!input.portfolioReleaseGate.allowPaperTrading) {
    reasonCodes.push('HARD_RELEASE_GATE_BLOCKED')
  }
  if (
    input.symbolSummaries.some((summary) =>
      summary.reasonCodes.includes('HARD_SOURCE_ELIGIBILITY_BLOCKED'),
    )
  ) {
    reasonCodes.push('HARD_SOURCE_ELIGIBILITY_BLOCKED')
  }
  for (const spaReason of ['HARD_SPA_BOOTSTRAP_UNSTABLE', 'HARD_SPA_BOOTSTRAP_MISSING']) {
    if (input.symbolSummaries.some((summary) => summary.reasonCodes.includes(spaReason))) {
      reasonCodes.push(spaReason)
    }
  }
  for (const summary of input.symbolSummaries) {
    if (summary.result !== 'GO') {
      reasonCodes.push(`HARD_SYMBOL_NO_GO:${summary.symbol}`)
    }
  }
  if (reasonCodes.length === 0 && input.aggregatePass) {
    reasonCodes.push('INFO_MVP_THRESHOLDS_PASS')
  }
  return Array.from(new Set(reasonCodes))
}

function aggregateReleaseGate(summaries: SymbolSummary[]): ReleaseGateResult {
  const selectedChampions = summaries
    .filter((summary) => summary.champion !== null)
    .map((summary) => ({
      symbol: summary.symbol,
      releaseGate: (summary.champion as EnrichedRun).releaseGate,
    }))
  const requiredSymbols = summaries.map((summary) => summary.symbol)
  const coverageComplete = selectedChampions.length === requiredSymbols.length
  const missingSymbols = requiredSymbols.filter(
    (symbol) => !selectedChampions.some((entry) => entry.symbol === symbol),
  )

  const checkNames: ReleaseGateCheck['name'][] = [
    'wfo',
    'significance',
    'risk_simulation',
    'strategy_plan_evidence',
    'execution_quality',
    'ramp_up',
    'regime_shift',
  ]
  const checks = checkNames.map((name) => {
    const sourceChecks = selectedChampions
      .map((entry) => entry.releaseGate.checks.find((check) => check.name === name))
      .filter((check): check is ReleaseGateCheck => Boolean(check))
    return {
      name,
      status: mergeCheckStatus(sourceChecks.map((check) => check.status)),
      summary: coverageComplete
        ? `sources=${sourceChecks.length}`
        : `missing=${missingSymbols.join(',')} | sources=${sourceChecks.length}`,
      metrics: {
        requiredCount: requiredSymbols.length,
        selectedCount: selectedChampions.length,
        coverageComplete,
        missingSymbols: missingSymbols.join(',') || null,
      },
    }
  })

  const failedChecks = checks.filter((check) => check.status === 'fail').map((check) => check.name)
  const warningChecks = checks.filter((check) => check.status === 'warn').map((check) => check.name)
  const paperBlockingNames: ReleaseGateCheck['name'][] = [
    'wfo',
    'significance',
    'risk_simulation',
    'strategy_plan_evidence',
  ]
  const liveBlockingNames: ReleaseGateCheck['name'][] = [
    'wfo',
    'significance',
    'risk_simulation',
    'strategy_plan_evidence',
    'execution_quality',
    'ramp_up',
    'regime_shift',
  ]

  return {
    checks,
    failedChecks,
    warningChecks,
    hardFail: !coverageComplete || failedChecks.length > 0,
    allowPaperTrading:
      coverageComplete &&
      !checks.some((check) => paperBlockingNames.includes(check.name) && check.status === 'fail'),
    allowLiveTrading:
      coverageComplete &&
      !checks.some((check) => liveBlockingNames.includes(check.name) && check.status === 'fail'),
  }
}

function mergeCheckStatus(statuses: ReleaseGateStatus[]): ReleaseGateStatus {
  if (statuses.length < 1) return 'skipped'
  if (statuses.includes('fail')) return 'fail'
  if (statuses.includes('warn')) return 'warn'
  if (statuses.every((status) => status === 'skipped')) return 'skipped'
  return 'pass'
}

function resolveWfoProfile(config: WfoConfig): WfoConfig {
  if (config.profile === 'shift') {
    return {
      ...config,
      trainBars: roundBars(Math.max(config.testBars * 3, Math.round(config.trainBars * 0.875))),
      testBars: roundBars(config.testBars),
      stepBars: roundBars(Math.max(1, Math.round(config.testBars * 0.75))),
    }
  }
  if (config.profile === 'stress') {
    return {
      ...config,
      trainBars: roundBars(Math.round(config.trainBars * 1.1)),
      testBars: roundBars(Math.max(config.testBars, Math.round(config.testBars * 1.5))),
      stepBars: roundBars(Math.max(config.stepBars, config.testBars)),
      degradationThreshold: Number(Math.max(0.2, config.degradationThreshold * 0.875).toFixed(6)),
    }
  }
  return config
}

function roundBars(value: number): number {
  return Math.max(1, Math.round(value))
}

async function loadCsvCandles(path: string, symbol: string): Promise<MarketData[]> {
  const raw = await readFile(resolve(path), 'utf-8')
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length < 2) {
    throw new Error(`CSV has no rows: ${path}`)
  }

  const header = lines[0].split(',')
  const idx = {
    timestamp: header.indexOf('timestamp'),
    open: header.indexOf('open'),
    high: header.indexOf('high'),
    low: header.indexOf('low'),
    close: header.indexOf('close'),
    volume: header.indexOf('volume'),
  }
  for (const [name, value] of Object.entries(idx)) {
    if (value < 0) {
      throw new Error(`CSV missing required column "${name}": ${path}`)
    }
  }

  const out: MarketData[] = []
  for (const row of lines.slice(1)) {
    const cols = row.split(',')
    const rawTs = Number(cols[idx.timestamp])
    const open = Number(cols[idx.open])
    const high = Number(cols[idx.high])
    const low = Number(cols[idx.low])
    const close = Number(cols[idx.close])
    const volume = Number(cols[idx.volume])
    if ([rawTs, open, high, low, close, volume].every((value) => Number.isFinite(value))) {
      const time = rawTs > 1e11 ? Math.floor(rawTs / 1000) : Math.floor(rawTs)
      out.push({ symbol, time, open, high, low, close, volume })
    }
  }
  if (out.length < 20) {
    throw new Error(`CSV did not produce enough valid candles: ${path}`)
  }
  return out.sort((left, right) => left.time - right.time)
}

function equityCurveToReturns(curve: Array<{ time: number; equity: number }>): number[] {
  const returns: number[] = []
  for (let index = 1; index < curve.length; index += 1) {
    const previous = curve[index - 1].equity
    const next = curve[index].equity
    if (previous > 0 && Number.isFinite(previous) && Number.isFinite(next)) {
      returns.push(next / previous - 1)
    }
  }
  return returns
}

function normalizeBenchmarkStrategyIdBySymbol(
  value: unknown,
  allowedSymbols: string[],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const allowed = new Set(allowedSymbols)
  const out: Record<string, string> = {}
  for (const [symbol, strategyId] of Object.entries(value as Record<string, unknown>)) {
    if (allowed.has(symbol) && typeof strategyId === 'string' && strategyId.trim()) {
      out[symbol] = strategyId.trim()
    }
  }
  return out
}

function normalizePositiveIntArray(value: unknown, label: string): number[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of positive integers.`)
  return [...new Set(value.map((item) => toPositiveInt(item, 1, label)))]
    .sort((left, right) => left - right)
}

function resolveOptionalFdrMethod(value: unknown): FdrMethod | undefined {
  return value === 'bh' ||
    value === 'by' ||
    value === 'cv_storey_bh' ||
    value === 'stepc' ||
    value === 'spa'
    ? value
    : undefined
}

function resolveOptionalWfoProfile(value: unknown): WfoProfile | undefined {
  return value === 'stable' || value === 'shift' || value === 'stress' ? value : undefined
}

function normalizeString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback
  }
  const trimmed = value.trim()
  return trimmed || fallback
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

function toPositiveInt(value: unknown, fallback: number, label: string): number {
  if (value == null) return fallback
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return numeric
}

function toFiniteNumber(value: unknown, fallback: number, label: string): number {
  if (value == null) return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} must be finite.`)
  }
  return numeric
}

function toOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function dsrProbabilityPasses(value: number | null, threshold: number): boolean {
  return value != null && value >= threshold
}

function dsrProbabilityForAggregate(value: number | null): number {
  return value ?? 0
}

function dsrProbabilityToPValue(value: number | null): number {
  return value == null ? 1 : clamp01(1 - value)
}

function mean(values: number[]): number {
  if (values.length < 1) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function runSelfCheck(): void {
  const candles = buildSyntheticCandles('BTC/USD', 480)
  const candidates: NormalizedCandidateConfig[] = [
    {
      strategyId: 'trend_a',
      strategyName: 'Trend A',
      strategy: 'trend',
      params: { trendFastPeriod: 8, trendSlowPeriod: 24, allowShort: false },
      applicableSymbols: ['BTC/USD'],
      hypothesisFamily: 'trend_family',
      correlationBucket: 'trend_family',
      role: 'benchmark_control',
      sourceEligibility: resolveSourceEligibility({ sourceLineage: 'control' }),
    },
    {
      strategyId: 'breakout_a',
      strategyName: 'Breakout A',
      strategy: 'breakout',
      params: { breakoutPeriod: 16, breakoutExitPeriod: 8, allowShort: false },
      applicableSymbols: ['BTC/USD'],
      hypothesisFamily: 'breakout_family',
      correlationBucket: 'breakout_family',
      role: 'donor',
      sourceEligibility: resolveSourceEligibility({
        sourceLineage: 'openalice_native',
        donorNative: true,
      }),
    },
    {
      strategyId: 'ensemble_a',
      strategyName: 'Ensemble A',
      strategy: 'ensemble',
      params: { allowShort: false, ensembleThreshold: 0.2 },
      applicableSymbols: ['BTC/USD'],
      hypothesisFamily: 'ensemble_family',
      correlationBucket: 'ensemble_family',
      role: 'robustness_anchor',
      sourceEligibility: resolveSourceEligibility({ sourceLineage: 'control' }),
    },
  ]
  const thresholds: ThresholdConfig = {
    meanPboMax: 1,
    meanDsrProbabilityMin: 0,
    fdrQMax: 1,
  }
  const summary = evaluateLoadedSymbolSummary({
    symbol: 'BTC/USD',
    inputCsv: 'self-check',
    lookbackBars: candles.length,
    candles,
    candidates,
    thresholds,
    wfoConfig: {
      trainBars: 180,
      testBars: 60,
      stepBars: 60,
      degradationThreshold: 1,
      profile: 'stable',
    },
    significanceConfig: {
      partitions: 4,
      pboThreshold: 1,
      dsrMin: -1,
      multipleTestingUnit: 'candidate',
      fdrMethod: 'bh',
      storeyLambda: 0.5,
      cvAggQuantile: 0.9,
      spaBootstrapSamples: 32,
      spaBlockSize: 8,
      benchmarkStrategyIdBySymbol: {},
    },
    riskConfig: {
      method: 'moving_block_bootstrap',
      simulations: 100,
      horizonBars: 64,
      blockSize: 8,
      ruinDrawdownPct: 50,
      maxRuinProbability: 1,
      minProfitProbability: 0,
    },
    costModel: {
      feeRate: 0.0001,
      slippageBps: 1,
      latencyBars: 1,
      fundingRatePer8h: 0,
    },
  })
  if (!summary.leader || summary.candidates.length !== 3) {
    throw new Error('self-check failed to produce candidate summary')
  }
}

function evaluateLoadedSymbolSummary(input: {
  symbol: string
  inputCsv: string
  lookbackBars: number
  candles: MarketData[]
  candidates: NormalizedCandidateConfig[]
  thresholds: ThresholdConfig
  wfoConfig: WfoConfig
  significanceConfig: SignificanceConfig
  riskConfig: RiskConfig
  costModel: CostModelConfig
}): SymbolSummary {
  const applicableCandidates = input.candidates.filter((candidate) =>
    candidate.applicableSymbols.includes(input.symbol),
  )
  const adjustedWfoConfig = resolveWfoProfile(input.wfoConfig)
  const candles = input.candles.slice(-input.lookbackBars)
  const backtests = applicableCandidates.map((candidate) =>
    runStrategyBacktest({
      strategy: candidate.strategy,
      candles,
      params: candidate.params,
      costModel: input.costModel,
      regimeGate: candidate.regimeGate,
      volatilityGate: candidate.volatilityGate,
    }),
  )
  const returnsByCandidate = backtests.map((report) =>
    equityCurveToReturns(report.equityCurve),
  )
  const rawRuns: RawRun[] = applicableCandidates.map((candidate, index) => {
    const trialLedger = buildTrialLedgerSummary({
      rawM: applicableCandidates.length,
      effectiveM: applicableCandidates.length,
      survivingTrialCount: 1,
      rawMComplete: true,
      includesFailedTrials: true,
    })
    const significance = evaluateSignificanceGate({
      candidateReturns: returnsByCandidate,
      selectedReturns: returnsByCandidate[index],
      partitions: input.significanceConfig.partitions,
      pboThreshold: input.significanceConfig.pboThreshold,
      dsrMin: input.significanceConfig.dsrMin,
      trialCount: applicableCandidates.length,
      trialLedger,
    })
    const riskSimulation = evaluateRiskSimulation(returnsByCandidate[index], {
      method: input.riskConfig.method,
      simulations: input.riskConfig.simulations,
      horizonBars: input.riskConfig.horizonBars,
      blockSize: input.riskConfig.blockSize,
      ruinDrawdownPct: input.riskConfig.ruinDrawdownPct,
      maxRuinProbability: input.riskConfig.maxRuinProbability,
      minProfitProbability: input.riskConfig.minProfitProbability,
    })
    const wfo = runStrategyWalkForward({
      strategy: candidate.strategy,
      candles,
      candidates: [candidate.params],
      costModel: input.costModel,
      regimeGate: candidate.regimeGate,
      volatilityGate: candidate.volatilityGate,
      config: {
        trainBars: adjustedWfoConfig.trainBars,
        testBars: adjustedWfoConfig.testBars,
        stepBars: adjustedWfoConfig.stepBars,
        degradationThreshold: adjustedWfoConfig.degradationThreshold,
        minTradesPerWindow: 1,
      },
    })
    return {
      candidate,
      backtest: backtests[index],
      significance,
      riskSimulation,
      wfo,
      releaseGate: evaluateReleaseGate({
        wfo,
        significance,
        riskSimulation,
      }),
      pValue: dsrProbabilityToPValue(computeDeflatedSharpe({
        returns: returnsByCandidate[index],
        trialCount: applicableCandidates.length,
      }).dsrProbability),
    }
  })
  const admissionView = buildAdmissionView({
    rawRuns,
    rawCandidates: applicableCandidates,
    returnsByCandidate,
    symbol: input.symbol,
    significanceConfig: input.significanceConfig,
    fdrQMax: input.thresholds.fdrQMax,
  })
  const enrichedRuns = rawRuns.map((run, index) => ({
    ...run,
    familyKey: admissionView.familyKeyByIndex[index],
    correlationBucket: admissionView.correlationBucketByIndex[index],
    familyRepresentative: true,
    familyRepresentativeStrategyId: run.candidate.strategyId,
    candidateLevelFdr: admissionView.candidateLevelFdrItems[index],
    admissionSignificance: admissionView.admissionSignificanceByIndex[index],
    fdr: admissionView.admissionFdrByIndex[index],
    candidatePass: true,
    failureReasons: [] as string[],
  }))
  const leader = selectHighestSharpeRun(enrichedRuns)
  if (!leader) {
    throw new Error('self-check failed to select leader')
  }
  return {
    symbol: input.symbol,
    inputCsv: input.inputCsv,
    lookbackBars: input.lookbackBars,
    applicableCandidateCount: enrichedRuns.length,
    aggregateMetrics: {
      meanPbo: mean(enrichedRuns.map((run) => run.admissionSignificance.pboResult.pbo)),
      meanDsrProbability: mean(
        enrichedRuns.map((run) => dsrProbabilityForAggregate(run.admissionSignificance.dsrResult.dsrProbability)),
      ),
      fdrQ: Math.max(...enrichedRuns.map((run) => run.fdr.qValue)),
      fdrMethod: input.significanceConfig.fdrMethod,
      fdrDiagnostics: admissionView.admissionFdrDiagnostics,
      wfoProfile: adjustedWfoConfig.profile,
    },
    result: 'GO',
    reasonCodes: ['INFO_MVP_THRESHOLDS_PASS'],
    leader,
    champion: leader,
    candidates: enrichedRuns,
  }
}

function buildSyntheticCandles(symbol: string, count: number): MarketData[] {
  const out: MarketData[] = []
  let price = 100
  for (let index = 0; index < count; index += 1) {
    const drift = 0.12 + Math.sin(index / 18) * 0.35
    const open = price
    const close = Math.max(1, open + drift)
    const high = Math.max(open, close) + 0.6
    const low = Math.min(open, close) - 0.6
    const volume = 1000 + index * 2
    out.push({
      symbol,
      time: 1_700_000_000 + index * 3600,
      open,
      high,
      low,
      close,
      volume,
    })
    price = close
  }
  return out
}

export {
  parseArgs,
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
