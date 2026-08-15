import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateCrossSectionalMomentum, type CrossSectionalAsset } from '../src/domain/strategy/cross-sectional-momentum.js'
import { analyzeInformationCoefficient, type IcSample } from '../src/domain/strategy/research/ic-analyzer.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import {
  parseCrossSectionalExecutionMode,
  resolveCrossSectionalExecutionShape,
  type CrossSectionalExecutionMode,
} from './lib/cross_sectional_execution_shape.js'
import { defaultPaperUniverseSymbols, paperSymbolToCsvFile, type PaperUniverseTimeframe } from './lib/paper_universe.js'

interface CliArgs {
  rankIcReportPath: string
  dataDir: string
  outputPath: string | null
  symbols: string[]
  barMinutes: number | null
  maxRows: number | null
  maxVolPct: number
  minSpreadPct: number
  minUniverseSize: number
  executionMode: CrossSectionalExecutionMode
  minTrainWindows: number
  json: boolean
}

interface Candle {
  time: number
  close: number
  volume: number
}

interface AssetSeries {
  symbol: string
  candles: Candle[]
}

interface AssetRuntimeStats {
  realizedVolPct: number
  avgVolume24h: number
  dailyVolumeUsd: number
}

type FactorName =
  | 'raw_reversal'
  | 'risk_adjusted_reversal'
  | 'rank_reversal'
  | 'signal_confidence'

interface RankIcConfig {
  lookbackHours: number
  secondaryLookbackHours: number
  forwardHours: number
  lookbackBars: number
  secondaryLookbackBars: number
  forwardBars: number
  mtfWeight: number
  factor: FactorName
}

interface WfoWindow {
  windowIndex: number
  startTime: string
  endTime: string
  startIndex: number
  endIndexExclusive: number
}

interface RegimeObservation {
  index: number
  time: string
  medianReturnPct: number
  breadthPositivePct: number
  dispersionPct: number
  averageVolPct: number
}

interface WalkForwardFilter {
  id: string
  description: string
  thresholds: {
    minMedianReturnPct?: number
    maxMedianReturnPct?: number
    minBreadthPositivePct?: number
    maxDispersionPct?: number
    maxAverageVolPct?: number
  }
  generatedFrom: 'baseline' | 'walk_forward_training_quantile'
}

interface RankIcWindowSummary {
  observations: number
  periods: number
  signalPeriods: number
  regimePeriodsEvaluated: number
  retainedRegimePeriods: number
  retainedPct: number | null
  meanIc: number
  icIr: number
  winRate: number
  passed: boolean
  averageLongShortSpreadPct: number | null
  longShortWinRate: number | null
}

interface EvaluationResult {
  summary: RankIcWindowSummary
  samples: IcSample[]
  signalSpreads: number[]
}

export interface WalkForwardFilterWindow {
  validationOrdinal: number
  windowIndex: number
  startTime: string
  endTime: string
  startIndex: number
  endIndexExclusive: number
  trainWindowIndexes: number[]
  trainRegimePeriods: number
  filter: WalkForwardFilter
  summary: RankIcWindowSummary
  baselineSummary: RankIcWindowSummary
  deltaVsBaseline: {
    meanIc: number | null
    icIr: number | null
    winRate: number | null
    averageLongShortSpreadPct: number | null
    retainedPct: number | null
  }
  passed: boolean
  blockers: string[]
}

export interface WalkForwardFilterCandidate {
  filterId: string
  description: string
  trainPolicy: 'previous_wfo_windows_only'
  validationWindowsEvaluated: number
  aggregate: RankIcWindowSummary
  baselineAggregate: RankIcWindowSummary
  deltaVsBaseline: {
    meanIc: number | null
    icIr: number | null
    winRate: number | null
    averageLongShortSpreadPct: number | null
    failedWindowRatio: number | null
    retainedPct: number | null
  }
  wfo: {
    status: 'pass' | 'fail' | 'insufficient_data'
    windowCount: number
    passedWindows: number
    failedWindows: number
    failedWindowRatio: number | null
    failWindowRatioThreshold: number
    directionStable: boolean
    blockers: string[]
  }
  diagnosticVerdict:
    | 'baseline'
    | 'walk_forward_improved_candidate'
    | 'no_walk_forward_improvement'
    | 'weaker_than_baseline'
    | 'insufficient_retention'
    | 'insufficient_data'
  windows: WalkForwardFilterWindow[]
  warnings: string[]
}

export interface RankIcWalkForwardFilterValidationReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  rankIcReportPath: string
  dataDir: string
  barMinutes: number
  symbolsLoaded: string[]
  config: RankIcConfig | null
  dataAlignment: {
    rankIcCommonPeriods: number | null
    loadedCommonPeriods: number
    alignmentStatus: 'aligned' | 'mismatch' | 'missing_rank_ic_common_periods' | 'no_assets'
    blockers: string[]
  }
  trainingPolicy: {
    minTrainWindows: number
    validationStartsAfterWindowOrdinal: number
    thresholdSource: 'previous_wfo_windows_only'
    usesFutureRegimeDataForThresholds: false
  }
  validationWindowCount: number
  baseline: WalkForwardFilterCandidate | null
  bestWalkForwardCandidate: WalkForwardFilterCandidate | null
  candidates: WalkForwardFilterCandidate[]
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_RANK_IC_REPORT_PATH = 'data/research/cross_sectional_rank_ic.live_accumulated_fwd72.latest.json'
const DEFAULT_DATA_DIR = 'data/market/live_accumulated'
const DEFAULT_OUTPUT_PATH = 'data/research/rank_ic_walkforward_filter_validation.latest.json'
const WFO_FAIL_WINDOW_RATIO_THRESHOLD = 0.3
const WFO_MIN_WINDOWS = 3
const WFO_MIN_TOTAL_PERIODS = 30
const WFO_MIN_TOTAL_SIGNAL_PERIODS = 30
const WFO_MIN_PERIODS_PER_WINDOW = 3
const WFO_MIN_SIGNAL_PERIODS_PER_WINDOW = 3
const MIN_RETAINED_PCT = 0.5

type FilterTemplateId =
  | 'no_filter'
  | 'median_return_gte_p25'
  | 'median_return_gte_p33'
  | 'median_return_between_p25_p85'
  | 'breadth_gte_p25'
  | 'dispersion_lte_p75'
  | 'vol_lte_p75'
  | 'median_gte_p25_dispersion_lte_p75'
  | 'breadth_gte_p25_dispersion_lte_p75'

const FILTER_TEMPLATES: Array<{ id: FilterTemplateId; description: string }> = [
  { id: 'no_filter', description: 'Baseline: keep every decision-time regime.' },
  { id: 'median_return_gte_p25', description: 'Keep regimes with median lookback return above the prior-window 25th percentile.' },
  { id: 'median_return_gte_p33', description: 'Keep regimes with median lookback return above the prior-window 33rd percentile.' },
  { id: 'median_return_between_p25_p85', description: 'Keep regimes outside the weakest and strongest prior-window median-return tails.' },
  { id: 'breadth_gte_p25', description: 'Keep regimes with positive-return breadth above the prior-window 25th percentile.' },
  { id: 'dispersion_lte_p75', description: 'Skip regimes above the prior-window 75th percentile of cross-sectional dispersion.' },
  { id: 'vol_lte_p75', description: 'Skip regimes above the prior-window 75th percentile of average realized volatility.' },
  { id: 'median_gte_p25_dispersion_lte_p75', description: 'Keep non-crash median-return regimes while skipping prior-window extreme dispersion.' },
  { id: 'breadth_gte_p25_dispersion_lte_p75', description: 'Keep broad enough markets while skipping prior-window extreme dispersion.' },
]

async function main(): Promise<void> {
  const args = parseRankIcWalkForwardFilterValidationArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runRankIcWalkForwardFilterValidation(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'rank_ic_walkforward_filter_validation',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.bestWalkForwardCandidate ? 'warn' : 'fail',
      recordsIn: report.symbolsLoaded.length,
      recordsOut: report.candidates.length,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseRankIcWalkForwardFilterValidationArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    rankIcReportPath: raw.get('rankIcReportPath') ?? raw.get('rankIc') ?? DEFAULT_RANK_IC_REPORT_PATH,
    dataDir: raw.get('dataDir') ?? DEFAULT_DATA_DIR,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    symbols: parseSymbols(raw.get('symbols')),
    barMinutes: parseNullablePositiveInteger(raw.get('barMinutes'), null, 'barMinutes'),
    maxRows: parseNullablePositiveInteger(raw.get('maxRows'), null, 'maxRows'),
    maxVolPct: parseFiniteNumber(raw.get('maxVolPct'), 99, 'maxVolPct'),
    minSpreadPct: parseFiniteNumber(raw.get('minSpreadPct'), 0, 'minSpreadPct'),
    minUniverseSize: parseNullablePositiveInteger(raw.get('minUniverseSize'), 20, 'minUniverseSize') ?? 20,
    executionMode: parseCrossSectionalExecutionMode(raw.get('executionMode'), 'paper'),
    minTrainWindows: parsePositiveInteger(raw.get('minTrainWindows'), 1, 'minTrainWindows'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runRankIcWalkForwardFilterValidation(
  args: CliArgs,
): Promise<RankIcWalkForwardFilterValidationReport> {
  const rankIcReportPath = resolve(args.rankIcReportPath)
  const rankIcReport = asRecord(await readJsonIfExists(rankIcReportPath))
  const barMinutes = args.barMinutes ?? readPositiveInteger(asRecord(rankIcReport?.dataCadence)?.barMinutes) ?? 60
  const symbols = args.symbols.length > 0
    ? args.symbols
    : readStringArray(rankIcReport?.symbolsLoaded).length > 0
      ? readStringArray(rankIcReport?.symbolsLoaded)
      : defaultPaperUniverseSymbols()
  const dataDir = resolve(args.dataDir)
  const assets = await loadAssets(dataDir, symbols, args.maxRows, timeframeForBarMinutes(barMinutes))
  const report = buildRankIcWalkForwardFilterValidationReport({
    rankIcReportPath,
    rankIcReport,
    dataDir,
    barMinutes,
    assets,
    args,
    generatedAt: new Date().toISOString(),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildRankIcWalkForwardFilterValidationReport(input: {
  rankIcReportPath: string
  rankIcReport: Record<string, unknown> | null
  dataDir: string
  barMinutes: number
  assets: AssetSeries[]
  args: Pick<CliArgs, 'maxVolPct' | 'minSpreadPct' | 'minUniverseSize' | 'executionMode' | 'minTrainWindows'>
  generatedAt?: string
}): RankIcWalkForwardFilterValidationReport {
  const root = asRecord(input.rankIcReport)
  const config = extractRankIcConfig(root)
  const loadedCommonPeriods = input.assets.length > 0
    ? Math.min(...input.assets.map(asset => asset.candles.length))
    : 0
  const rankIcCommonPeriods = readNumber(root?.commonPeriods)
  const dataAlignment = buildDataAlignment(rankIcCommonPeriods, loadedCommonPeriods)
  const runtimeStatsBySymbol = buildRuntimeStatsBySymbol(input.assets, input.barMinutes)
  const rawWindows = readWfoWindows(asRecord(root?.wfo))
  const windows = rawWindows.filter(window =>
    window.startIndex >= 0 &&
    window.endIndexExclusive > window.startIndex &&
    window.endIndexExclusive <= loadedCommonPeriods
  )
  const validationWindows = windows.slice(input.args.minTrainWindows)
  const candidates = config
    ? buildWalkForwardCandidates({
        assets: input.assets,
        config,
        windows,
        runtimeStatsBySymbol,
        args: input.args,
      })
    : []
  const baseline = candidates.find(candidate => candidate.filterId === 'no_filter') ?? null
  const classified = baseline
    ? candidates.map(candidate => candidate.filterId === 'no_filter'
      ? candidate
      : classifyCandidate(candidate, baseline))
    : candidates
  const sorted = classified.sort(compareCandidates)
  const bestWalkForwardCandidate = sorted.find(candidate =>
    candidate.filterId !== 'no_filter' &&
    candidate.diagnosticVerdict === 'walk_forward_improved_candidate'
  ) ?? null
  const blockers = buildReportBlockers({
    rankIcReport: root,
    config,
    dataAlignmentBlockers: dataAlignment.blockers,
    rawWindowCount: rawWindows.length,
    boundedWindowCount: windows.length,
    validationWindowCount: validationWindows.length,
    bestWalkForwardCandidate,
  })

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    rankIcReportPath: resolve(input.rankIcReportPath),
    dataDir: resolve(input.dataDir),
    barMinutes: input.barMinutes,
    symbolsLoaded: input.assets.map(asset => asset.symbol),
    config,
    dataAlignment,
    trainingPolicy: {
      minTrainWindows: input.args.minTrainWindows,
      validationStartsAfterWindowOrdinal: input.args.minTrainWindows,
      thresholdSource: 'previous_wfo_windows_only',
      usesFutureRegimeDataForThresholds: false,
    },
    validationWindowCount: validationWindows.length,
    baseline,
    bestWalkForwardCandidate,
    candidates: sorted,
    blockers,
    nextActions: buildNextActions(bestWalkForwardCandidate),
    notes: [
      'This artifact is research-only. It does not authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
      'Unlike the in-sample regime sweep, each validation window fits filter thresholds only on earlier WFO windows.',
      'A positive walk-forward filter diagnostic is still not promotion evidence without complete trial ledger, BY FDR, PIT audit, runtime fee verification, route-cost validation, and paper execution evidence.',
      'This validator checks simple decision-time observable filters only: cross-sectional lookback return, breadth, dispersion, and realized volatility.',
    ],
  }
}

function buildWalkForwardCandidates(input: {
  assets: AssetSeries[]
  config: RankIcConfig
  windows: WfoWindow[]
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  args: Pick<CliArgs, 'maxVolPct' | 'minSpreadPct' | 'minUniverseSize' | 'executionMode' | 'minTrainWindows'>
}): WalkForwardFilterCandidate[] {
  return FILTER_TEMPLATES.map(template => buildWalkForwardCandidate({
    ...input,
    template,
  }))
}

function buildWalkForwardCandidate(input: {
  assets: AssetSeries[]
  config: RankIcConfig
  windows: WfoWindow[]
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  args: Pick<CliArgs, 'maxVolPct' | 'minSpreadPct' | 'minUniverseSize' | 'executionMode' | 'minTrainWindows'>
  template: typeof FILTER_TEMPLATES[number]
}): WalkForwardFilterCandidate {
  const windowReports: WalkForwardFilterWindow[] = []
  const aggregateParts: EvaluationResult[] = []
  const baselineParts: EvaluationResult[] = []

  for (let ordinal = input.args.minTrainWindows; ordinal < input.windows.length; ordinal += 1) {
    const validationWindow = input.windows[ordinal]
    const trainWindows = input.windows.slice(0, ordinal)
    const trainObservations = buildRegimeObservationsForWindows({
      assets: input.assets,
      config: input.config,
      windows: trainWindows,
      runtimeStatsBySymbol: input.runtimeStatsBySymbol,
      args: input.args,
    })
    const filter = buildWalkForwardFilter(input.template, trainObservations)
    if (!filter) continue
    const result = evaluateFilteredRankIc({
      assets: input.assets,
      config: input.config,
      filter,
      runtimeStatsBySymbol: input.runtimeStatsBySymbol,
      args: input.args,
      startIndex: validationWindow.startIndex,
      endIndexExclusive: validationWindow.endIndexExclusive,
    })
    const baselineFilter = buildWalkForwardFilter(FILTER_TEMPLATES[0], trainObservations)!
    const baselineResult = input.template.id === 'no_filter'
      ? result
      : evaluateFilteredRankIc({
          assets: input.assets,
          config: input.config,
          filter: baselineFilter,
          runtimeStatsBySymbol: input.runtimeStatsBySymbol,
          args: input.args,
          startIndex: validationWindow.startIndex,
          endIndexExclusive: validationWindow.endIndexExclusive,
        })
    aggregateParts.push(result)
    baselineParts.push(baselineResult)

    const blockers = buildWindowBlockers(result.summary)
    windowReports.push({
      validationOrdinal: ordinal,
      windowIndex: validationWindow.windowIndex,
      startTime: validationWindow.startTime,
      endTime: validationWindow.endTime,
      startIndex: validationWindow.startIndex,
      endIndexExclusive: validationWindow.endIndexExclusive,
      trainWindowIndexes: trainWindows.map(window => window.windowIndex),
      trainRegimePeriods: trainObservations.length,
      filter,
      summary: result.summary,
      baselineSummary: baselineResult.summary,
      deltaVsBaseline: {
        meanIc: nullableDelta(result.summary.meanIc, baselineResult.summary.meanIc),
        icIr: nullableDelta(result.summary.icIr, baselineResult.summary.icIr),
        winRate: nullableDelta(result.summary.winRate, baselineResult.summary.winRate),
        averageLongShortSpreadPct: nullableDelta(result.summary.averageLongShortSpreadPct, baselineResult.summary.averageLongShortSpreadPct),
        retainedPct: nullableDelta(result.summary.retainedPct, baselineResult.summary.retainedPct),
      },
      passed: blockers.length === 0,
      blockers,
    })
  }

  const aggregate = combineEvaluationResults(aggregateParts)
  const baselineAggregate = input.template.id === 'no_filter'
    ? aggregate
    : combineEvaluationResults(baselineParts)
  const wfo = buildCandidateWfo(windowReports, aggregate)
  const candidate: WalkForwardFilterCandidate = {
    filterId: input.template.id,
    description: input.template.description,
    trainPolicy: 'previous_wfo_windows_only',
    validationWindowsEvaluated: windowReports.length,
    aggregate,
    baselineAggregate,
    deltaVsBaseline: {
      meanIc: nullableDelta(aggregate.meanIc, baselineAggregate.meanIc),
      icIr: nullableDelta(aggregate.icIr, baselineAggregate.icIr),
      winRate: nullableDelta(aggregate.winRate, baselineAggregate.winRate),
      averageLongShortSpreadPct: nullableDelta(aggregate.averageLongShortSpreadPct, baselineAggregate.averageLongShortSpreadPct),
      failedWindowRatio: null,
      retainedPct: nullableDelta(aggregate.retainedPct, baselineAggregate.retainedPct),
    },
    wfo,
    diagnosticVerdict: input.template.id === 'no_filter' ? 'baseline' : 'no_walk_forward_improvement',
    windows: windowReports,
    warnings: buildCandidateWarnings(input.template.id, aggregate, wfo),
  }
  candidate.deltaVsBaseline.failedWindowRatio = null
  return candidate
}

function classifyCandidate(
  candidate: WalkForwardFilterCandidate,
  baseline: WalkForwardFilterCandidate,
): WalkForwardFilterCandidate {
  const delta = {
    ...candidate.deltaVsBaseline,
    failedWindowRatio: nullableDelta(candidate.wfo.failedWindowRatio, baseline.wfo.failedWindowRatio),
  }
  let diagnosticVerdict: WalkForwardFilterCandidate['diagnosticVerdict'] = 'no_walk_forward_improvement'
  const retainedOk = (candidate.aggregate.retainedPct ?? 0) >= MIN_RETAINED_PCT
  const enoughWindows = candidate.validationWindowsEvaluated >= WFO_MIN_WINDOWS
  const improvedWfo = candidate.wfo.status === 'pass' ||
    (candidate.wfo.status !== 'insufficient_data' &&
      (candidate.wfo.failedWindowRatio ?? 1) < (baseline.wfo.failedWindowRatio ?? 1) &&
      candidate.wfo.passedWindows >= baseline.wfo.passedWindows)
  const noMajorIcDamage = candidate.aggregate.icIr >= Math.max(0, baseline.aggregate.icIr * 0.8) &&
    candidate.aggregate.meanIc >= Math.max(0, baseline.aggregate.meanIc * 0.8)
  if (!enoughWindows || candidate.wfo.status === 'insufficient_data') diagnosticVerdict = 'insufficient_data'
  else if (!retainedOk) diagnosticVerdict = 'insufficient_retention'
  else if (improvedWfo && noMajorIcDamage) diagnosticVerdict = 'walk_forward_improved_candidate'
  else if (
    candidate.aggregate.icIr < baseline.aggregate.icIr ||
    (candidate.wfo.failedWindowRatio ?? 1) > (baseline.wfo.failedWindowRatio ?? 1)
  ) {
    diagnosticVerdict = 'weaker_than_baseline'
  }
  return {
    ...candidate,
    deltaVsBaseline: delta,
    diagnosticVerdict,
    warnings: buildCandidateWarnings(candidate.filterId, candidate.aggregate, candidate.wfo),
  }
}

function buildWalkForwardFilter(
  template: typeof FILTER_TEMPLATES[number],
  trainObservations: RegimeObservation[],
): WalkForwardFilter | null {
  if (template.id === 'no_filter') {
    return {
      id: template.id,
      description: template.description,
      thresholds: {},
      generatedFrom: 'baseline',
    }
  }
  if (trainObservations.length === 0) return null
  const medianReturns = trainObservations.map(observation => observation.medianReturnPct)
  const breadth = trainObservations.map(observation => observation.breadthPositivePct)
  const dispersion = trainObservations.map(observation => observation.dispersionPct)
  const vol = trainObservations.map(observation => observation.averageVolPct)
  const p25Median = percentile(medianReturns, 0.25)
  const p33Median = percentile(medianReturns, 0.33)
  const p85Median = percentile(medianReturns, 0.85)
  const p25Breadth = percentile(breadth, 0.25)
  const p75Dispersion = percentile(dispersion, 0.75)
  const p75Vol = percentile(vol, 0.75)
  const thresholds: WalkForwardFilter['thresholds'] = {}

  if (template.id === 'median_return_gte_p25') thresholds.minMedianReturnPct = p25Median
  if (template.id === 'median_return_gte_p33') thresholds.minMedianReturnPct = p33Median
  if (template.id === 'median_return_between_p25_p85') {
    thresholds.minMedianReturnPct = p25Median
    thresholds.maxMedianReturnPct = p85Median
  }
  if (template.id === 'breadth_gte_p25') thresholds.minBreadthPositivePct = p25Breadth
  if (template.id === 'dispersion_lte_p75') thresholds.maxDispersionPct = p75Dispersion
  if (template.id === 'vol_lte_p75') thresholds.maxAverageVolPct = p75Vol
  if (template.id === 'median_gte_p25_dispersion_lte_p75') {
    thresholds.minMedianReturnPct = p25Median
    thresholds.maxDispersionPct = p75Dispersion
  }
  if (template.id === 'breadth_gte_p25_dispersion_lte_p75') {
    thresholds.minBreadthPositivePct = p25Breadth
    thresholds.maxDispersionPct = p75Dispersion
  }
  if (!Object.values(thresholds).every(value => value != null && Number.isFinite(value))) return null
  return {
    id: template.id,
    description: template.description,
    thresholds: Object.fromEntries(
      Object.entries(thresholds).map(([key, value]) => [key, round(Number(value), 6)]),
    ),
    generatedFrom: 'walk_forward_training_quantile',
  }
}

function evaluateFilteredRankIc(input: {
  assets: AssetSeries[]
  config: RankIcConfig
  filter: WalkForwardFilter
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  args: Pick<CliArgs, 'maxVolPct' | 'minSpreadPct' | 'minUniverseSize' | 'executionMode'>
  startIndex: number
  endIndexExclusive: number
}): EvaluationResult {
  const samples: IcSample[] = []
  const signalSpreads: number[] = []
  let signalPeriods = 0
  let regimePeriodsEvaluated = 0
  let retainedRegimePeriods = 0

  for (let index = input.startIndex; index < input.endIndexExclusive; index += 1) {
    const assetsAtTime = buildAssetsAtTime({
      assets: input.assets,
      index,
      runtimeStatsBySymbol: input.runtimeStatsBySymbol,
      config: input.config,
    })
    const shape = resolveCrossSectionalExecutionShape(assetsAtTime.length, {
      mode: input.args.executionMode,
      minUniverseSizeOverride: input.args.minUniverseSize,
    })
    if (assetsAtTime.length < shape.minUniverseSize) continue
    const regime = buildRegimeObservation(index, input.assets[0]?.candles[index]?.time, assetsAtTime)
    if (!regime) continue
    regimePeriodsEvaluated += 1
    if (!filterAllows(input.filter, regime)) continue
    retainedRegimePeriods += 1

    const ranks = evaluateCrossSectionalMomentum(assetsAtTime, {
      lookbackHours: input.config.lookbackHours,
      secondaryLookbackHours: input.config.secondaryLookbackHours,
      topN: shape.topN,
      bottomN: shape.bottomN,
      minUniverseSize: shape.minUniverseSize,
      maxVolPercentile: input.args.maxVolPct / 100,
      minSpreadPct: input.args.minSpreadPct,
      requireVolumeConfirmation: assetsAtTime.length >= 4,
      mtfWeight: input.config.mtfWeight,
      fundingWeight: 0,
    })
    const rankBySymbol = new Map(ranks.map(rank => [rank.symbol, rank]))
    const assetBySymbol = new Map(assetsAtTime.map(asset => [asset.symbol, asset]))
    const bucketKey = String(input.assets[0]?.candles[index]?.time ?? index)
    for (const asset of assetsAtTime) {
      const rank = rankBySymbol.get(asset.symbol)
      if (!rank || rank.rank <= 0) continue
      const forwardReturn = asset.returns[`${input.config.forwardHours}h`]
      const factorValue = factorValueFor(input.config.factor, asset, rank, assetsAtTime.length)
      if (!Number.isFinite(forwardReturn) || !Number.isFinite(factorValue)) continue
      samples.push({ factorValue, forwardReturn, bucketKey })
    }

    let long = null as (typeof ranks[number] | null)
    let short = null as (typeof ranks[number] | null)
    for (const rank of ranks) {
      if (rank.signal === 1 && (!long || rank.confidence > long.confidence)) long = rank
      if (rank.signal === -1 && (!short || rank.confidence > short.confidence)) short = rank
    }
    if (long && short && long.symbol !== short.symbol) {
      const longAsset = assetBySymbol.get(long.symbol)
      const shortAsset = assetBySymbol.get(short.symbol)
      if (longAsset && shortAsset) {
        signalSpreads.push(longAsset.returns[`${input.config.forwardHours}h`] - shortAsset.returns[`${input.config.forwardHours}h`])
        signalPeriods += 1
      }
    }
  }

  return {
    summary: summarizeSamples(samples, signalSpreads, signalPeriods, regimePeriodsEvaluated, retainedRegimePeriods),
    samples,
    signalSpreads,
  }
}

function summarizeSamples(
  samples: IcSample[],
  signalSpreads: number[],
  signalPeriods: number,
  regimePeriodsEvaluated: number,
  retainedRegimePeriods: number,
): RankIcWindowSummary {
  const summary = analyzeInformationCoefficient(samples)
  return {
    observations: summary.observations,
    periods: summary.periods,
    signalPeriods,
    regimePeriodsEvaluated,
    retainedRegimePeriods,
    retainedPct: regimePeriodsEvaluated > 0 ? round(retainedRegimePeriods / regimePeriodsEvaluated, 6) : null,
    meanIc: round(summary.meanIc, 6),
    icIr: roundFinite(summary.icIr, 6),
    winRate: round(summary.winRate, 6),
    passed: summary.passed,
    averageLongShortSpreadPct: signalSpreads.length > 0 ? round(mean(signalSpreads), 6) : null,
    longShortWinRate: signalSpreads.length > 0
      ? round(signalSpreads.filter(value => value > 0).length / signalSpreads.length, 6)
      : null,
  }
}

function combineEvaluationResults(results: EvaluationResult[]): RankIcWindowSummary {
  const samples = results.flatMap(result => result.samples)
  const spreads = results.flatMap(result => result.signalSpreads)
  const signalPeriods = results.reduce((sum, result) => sum + result.summary.signalPeriods, 0)
  const regimePeriodsEvaluated = results.reduce((sum, result) => sum + result.summary.regimePeriodsEvaluated, 0)
  const retainedRegimePeriods = results.reduce((sum, result) => sum + result.summary.retainedRegimePeriods, 0)
  return summarizeSamples(samples, spreads, signalPeriods, regimePeriodsEvaluated, retainedRegimePeriods)
}

function buildCandidateWfo(
  windows: WalkForwardFilterWindow[],
  aggregate: RankIcWindowSummary,
): WalkForwardFilterCandidate['wfo'] {
  const blockers: string[] = []
  if (windows.length < WFO_MIN_WINDOWS) blockers.push(`wfo_windows_low:${windows.length}<${WFO_MIN_WINDOWS}`)
  if (aggregate.periods < WFO_MIN_TOTAL_PERIODS) blockers.push(`wfo_total_periods_low:${aggregate.periods}<${WFO_MIN_TOTAL_PERIODS}`)
  if (aggregate.signalPeriods < WFO_MIN_TOTAL_SIGNAL_PERIODS) blockers.push(`wfo_total_signal_periods_low:${aggregate.signalPeriods}<${WFO_MIN_TOTAL_SIGNAL_PERIODS}`)
  for (const window of windows) blockers.push(...window.blockers.map(blocker => `wfo_window_${window.windowIndex}_${blocker}`))
  const failedWindows = windows.filter(window => !window.passed).length
  const passedWindows = windows.length - failedWindows
  const failedWindowRatio = windows.length > 0 ? round(failedWindows / windows.length, 6) : null
  if (failedWindowRatio != null && failedWindowRatio > WFO_FAIL_WINDOW_RATIO_THRESHOLD) {
    blockers.push(`wfo_failed_window_ratio:${failedWindowRatio}>${WFO_FAIL_WINDOW_RATIO_THRESHOLD}`)
  }
  const directionStable = windows.length >= WFO_MIN_WINDOWS && windows.every(window => window.summary.meanIc > 0)
  if (!directionStable) blockers.push('wfo_direction_not_stable')
  const insufficientData = blockers.some(blocker => blocker.includes('_low:')) || windows.length < WFO_MIN_WINDOWS
  return {
    status: blockers.length === 0 ? 'pass' : insufficientData ? 'insufficient_data' : 'fail',
    windowCount: windows.length,
    passedWindows,
    failedWindows,
    failedWindowRatio,
    failWindowRatioThreshold: WFO_FAIL_WINDOW_RATIO_THRESHOLD,
    directionStable,
    blockers: uniqueStrings(blockers),
  }
}

function buildWindowBlockers(summary: RankIcWindowSummary): string[] {
  const blockers: string[] = []
  if (summary.periods < WFO_MIN_PERIODS_PER_WINDOW) blockers.push(`periods_low:${summary.periods}<${WFO_MIN_PERIODS_PER_WINDOW}`)
  if (summary.signalPeriods < WFO_MIN_SIGNAL_PERIODS_PER_WINDOW) blockers.push(`signal_periods_low:${summary.signalPeriods}<${WFO_MIN_SIGNAL_PERIODS_PER_WINDOW}`)
  if (!summary.passed) blockers.push('rank_ic_thresholds_not_passed')
  return blockers
}

function buildCandidateWarnings(
  filterId: string,
  aggregate: RankIcWindowSummary,
  wfo: WalkForwardFilterCandidate['wfo'],
): string[] {
  const warnings: string[] = []
  if (filterId !== 'no_filter') warnings.push('thresholds_fit_only_on_prior_wfo_windows')
  if ((aggregate.retainedPct ?? 0) < MIN_RETAINED_PCT) warnings.push(`retention_below_${MIN_RETAINED_PCT}`)
  if (wfo.status !== 'pass') warnings.push(`walk_forward_wfo_${wfo.status}`)
  return warnings
}

function buildRegimeObservationsForWindows(input: {
  assets: AssetSeries[]
  config: RankIcConfig
  windows: WfoWindow[]
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  args: Pick<CliArgs, 'minUniverseSize' | 'executionMode'>
}): RegimeObservation[] {
  const out: RegimeObservation[] = []
  for (const window of input.windows) {
    for (let index = window.startIndex; index < window.endIndexExclusive; index += 1) {
      const assetsAtTime = buildAssetsAtTime({
        assets: input.assets,
        index,
        runtimeStatsBySymbol: input.runtimeStatsBySymbol,
        config: input.config,
      })
      const shape = resolveCrossSectionalExecutionShape(assetsAtTime.length, {
        mode: input.args.executionMode,
        minUniverseSizeOverride: input.args.minUniverseSize,
      })
      if (assetsAtTime.length < shape.minUniverseSize) continue
      const observation = buildRegimeObservation(index, input.assets[0]?.candles[index]?.time, assetsAtTime)
      if (observation) out.push(observation)
    }
  }
  return out
}

function buildRegimeObservation(index: number, time: number | undefined, assetsAtTime: CrossSectionalAsset[]): RegimeObservation | null {
  const primaryKey = Object.keys(assetsAtTime[0]?.returns ?? {})[0]
  if (!primaryKey) return null
  const returns = assetsAtTime.map(asset => asset.returns[primaryKey]).filter(isFiniteNumber)
  const vols = assetsAtTime.map(asset => asset.realizedVolPct).filter(isFiniteNumber)
  if (returns.length < 2 || vols.length === 0) return null
  return {
    index,
    time: typeof time === 'number' ? new Date(time).toISOString() : '',
    medianReturnPct: round(median(returns), 6),
    breadthPositivePct: round(returns.filter(value => value > 0).length / returns.length, 6),
    dispersionPct: round(standardDeviation(returns), 6),
    averageVolPct: round(mean(vols), 6),
  }
}

function filterAllows(filter: WalkForwardFilter, observation: RegimeObservation): boolean {
  const t = filter.thresholds
  if (t.minMedianReturnPct != null && observation.medianReturnPct < t.minMedianReturnPct) return false
  if (t.maxMedianReturnPct != null && observation.medianReturnPct > t.maxMedianReturnPct) return false
  if (t.minBreadthPositivePct != null && observation.breadthPositivePct < t.minBreadthPositivePct) return false
  if (t.maxDispersionPct != null && observation.dispersionPct > t.maxDispersionPct) return false
  if (t.maxAverageVolPct != null && observation.averageVolPct > t.maxAverageVolPct) return false
  return true
}

function buildAssetsAtTime(input: {
  assets: AssetSeries[]
  index: number
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  config: RankIcConfig
}): CrossSectionalAsset[] {
  const out: CrossSectionalAsset[] = []
  for (const asset of input.assets) {
    const current = asset.candles[input.index]
    const primary = asset.candles[input.index - input.config.lookbackBars]
    const secondary = asset.candles[input.index - input.config.secondaryLookbackBars]
    const forward = asset.candles[input.index + input.config.forwardBars]
    if (!current || !primary || !secondary || !forward) continue
    if (current.close <= 0 || primary.close <= 0 || secondary.close <= 0 || forward.close <= 0) continue
    const runtimeStats = input.runtimeStatsBySymbol.get(asset.symbol)?.[input.index]
    out.push({
      symbol: asset.symbol,
      currentPrice: current.close,
      returns: {
        [`${input.config.lookbackHours}h`]: (current.close / primary.close - 1) * 100,
        [`${input.config.secondaryLookbackHours}h`]: (current.close / secondary.close - 1) * 100,
        [`${input.config.forwardHours}h`]: (forward.close / current.close - 1) * 100,
      },
      realizedVolPct: runtimeStats?.realizedVolPct ?? 50,
      avgVolume24h: runtimeStats?.avgVolume24h ?? current.volume,
      dailyVolumeUsd: runtimeStats?.dailyVolumeUsd ?? current.close * current.volume,
    })
  }
  return out
}

function factorValueFor(
  factor: FactorName,
  asset: CrossSectionalAsset,
  rank: ReturnType<typeof evaluateCrossSectionalMomentum>[number],
  universeSize: number,
): number {
  const firstReturnKey = Object.keys(asset.returns)[0]
  const rawReturn = asset.returns[firstReturnKey]
  if (factor === 'raw_reversal') return -rawReturn
  if (factor === 'risk_adjusted_reversal') return -rank.riskAdjustedScore
  if (factor === 'rank_reversal') return universeSize + 1 - rank.rank
  return rank.signal * rank.confidence
}

function compareCandidates(left: WalkForwardFilterCandidate, right: WalkForwardFilterCandidate): number {
  return verdictRank(right.diagnosticVerdict) - verdictRank(left.diagnosticVerdict) ||
    Number(right.wfo.status === 'pass') - Number(left.wfo.status === 'pass') ||
    (left.wfo.failedWindowRatio ?? 1) - (right.wfo.failedWindowRatio ?? 1) ||
    right.aggregate.icIr - left.aggregate.icIr ||
    right.aggregate.meanIc - left.aggregate.meanIc ||
    (right.aggregate.averageLongShortSpreadPct ?? Number.NEGATIVE_INFINITY) -
      (left.aggregate.averageLongShortSpreadPct ?? Number.NEGATIVE_INFINITY) ||
    right.aggregate.retainedRegimePeriods - left.aggregate.retainedRegimePeriods
}

function verdictRank(verdict: WalkForwardFilterCandidate['diagnosticVerdict']): number {
  if (verdict === 'walk_forward_improved_candidate') return 5
  if (verdict === 'baseline') return 4
  if (verdict === 'no_walk_forward_improvement') return 3
  if (verdict === 'weaker_than_baseline') return 2
  if (verdict === 'insufficient_retention') return 1
  return 0
}

function buildReportBlockers(input: {
  rankIcReport: Record<string, unknown> | null
  config: RankIcConfig | null
  dataAlignmentBlockers: string[]
  rawWindowCount: number
  boundedWindowCount: number
  validationWindowCount: number
  bestWalkForwardCandidate: WalkForwardFilterCandidate | null
}): string[] {
  const blockers = [
    'research_only_not_promotion_evidence',
    'walk_forward_filter_diagnostic_only',
    'not_trial_ledger_fdr_validated',
    'not_pit_audit_validated',
    'not_runtime_fee_verified',
    'not_paper_execution_evidence',
  ]
  if (!input.rankIcReport) blockers.push('rank_ic_report_missing_or_invalid')
  if (!input.config) blockers.push('rank_ic_config_missing')
  blockers.push(...input.dataAlignmentBlockers)
  if (input.rawWindowCount === 0) blockers.push('rank_ic_wfo_windows_missing')
  if (input.boundedWindowCount < input.rawWindowCount) blockers.push(`rank_ic_wfo_windows_out_of_bounds:${input.boundedWindowCount}/${input.rawWindowCount}`)
  if (input.validationWindowCount < WFO_MIN_WINDOWS) blockers.push(`walk_forward_validation_windows_low:${input.validationWindowCount}<${WFO_MIN_WINDOWS}`)
  if (!input.bestWalkForwardCandidate) blockers.push('no_walk_forward_improved_filter_candidate')
  if (input.bestWalkForwardCandidate && input.bestWalkForwardCandidate.wfo.status !== 'pass') {
    blockers.push(`best_walk_forward_candidate_wfo_${input.bestWalkForwardCandidate.wfo.status}`)
  }
  return uniqueStrings(blockers)
}

function buildNextActions(best: WalkForwardFilterCandidate | null): string[] {
  const actions = [
    'Do not enable paper/live from this artifact; it is stricter than the in-sample sweep but still diagnostic only.',
  ]
  if (best) {
    actions.push(`Investigate ${best.filterId}: it improved walk-forward WFO diagnostics versus baseline, but still needs complete promotion evidence.`)
    actions.push('Export the filter into a prospective trial-ledger lane and validate it on future live-only periods before considering promotion.')
  } else {
    actions.push('The simple regime filters did not survive prior-window-only walk-forward validation; prioritize signal design or complete evidence plumbing over more threshold sweeps.')
  }
  actions.push('Fix runtime OKX fee authentication, then rerun route-cost validation with verified fees.')
  actions.push('Complete trial ledger, BY FDR, PIT audit, WFO/release gates, and paper execution evidence before any order gate can open.')
  return actions
}

function renderConsoleSummary(report: RankIcWalkForwardFilterValidationReport): string {
  const lines = [
    `rank ic walk-forward filter validation: candidates=${report.candidates.length}, validationWindows=${report.validationWindowCount}, best=${report.bestWalkForwardCandidate?.filterId ?? 'none'}`,
    `config=${report.config ? `${report.config.factor}_lb${report.config.lookbackHours}_sec${report.config.secondaryLookbackHours}_fwd${report.config.forwardHours}_mtf${report.config.mtfWeight}` : 'missing'}`,
    `blockers=${report.blockers.join('|')}`,
  ]
  for (const row of report.candidates.slice(0, 8)) {
    lines.push([
      row.filterId,
      row.diagnosticVerdict,
      `wfo=${row.wfo.status}`,
      `pass=${row.wfo.passedWindows}/${row.wfo.windowCount}`,
      `failRatio=${row.wfo.failedWindowRatio}`,
      `ic=${row.aggregate.meanIc}`,
      `ir=${row.aggregate.icIr}`,
      `spread=${row.aggregate.averageLongShortSpreadPct}`,
      `retain=${row.aggregate.retainedPct}`,
      `warnings=${row.warnings.join(',') || 'none'}`,
    ].join(' | '))
  }
  return lines.join('\n')
}

function extractRankIcConfig(root: Record<string, unknown> | null): RankIcConfig | null {
  const best = asRecord(root?.best) ?? asRecord(asRecord(root?.wfo)?.testedConfig)
  if (!best) return null
  const lookbackHours = readNumber(best.lookbackHours)
  const secondaryLookbackHours = readNumber(best.secondaryLookbackHours)
  const forwardHours = readNumber(best.forwardHours)
  const lookbackBars = readNumber(best.lookbackBars)
  const secondaryLookbackBars = readNumber(best.secondaryLookbackBars)
  const forwardBars = readNumber(best.forwardBars)
  const mtfWeight = readNumber(best.mtfWeight)
  const factor = readFactorName(best.factor)
  if (
    lookbackHours == null ||
    secondaryLookbackHours == null ||
    forwardHours == null ||
    lookbackBars == null ||
    secondaryLookbackBars == null ||
    forwardBars == null ||
    mtfWeight == null ||
    factor == null
  ) return null
  return {
    lookbackHours,
    secondaryLookbackHours,
    forwardHours,
    lookbackBars,
    secondaryLookbackBars,
    forwardBars,
    mtfWeight,
    factor,
  }
}

function readWfoWindows(wfo: Record<string, unknown> | null): WfoWindow[] {
  const raw = Array.isArray(wfo?.windows) ? wfo.windows : []
  return raw
    .map(asRecord)
    .filter(isRecordValue)
    .map((window, index) => ({
      windowIndex: readFiniteNumber(window.windowIndex, index),
      startTime: readString(window.startTime) ?? '',
      endTime: readString(window.endTime) ?? '',
      startIndex: readFiniteNumber(window.startIndex, 0),
      endIndexExclusive: readFiniteNumber(window.endIndexExclusive, 0),
    }))
}

function buildDataAlignment(
  rankIcCommonPeriods: number | null,
  loadedCommonPeriods: number,
): RankIcWalkForwardFilterValidationReport['dataAlignment'] {
  const blockers: string[] = []
  let alignmentStatus: RankIcWalkForwardFilterValidationReport['dataAlignment']['alignmentStatus'] = 'aligned'
  if (loadedCommonPeriods <= 0) {
    alignmentStatus = 'no_assets'
    blockers.push('walk_forward_filter_no_assets_loaded')
  } else if (rankIcCommonPeriods == null) {
    alignmentStatus = 'missing_rank_ic_common_periods'
    blockers.push('rank_ic_common_periods_missing')
  } else if (rankIcCommonPeriods !== loadedCommonPeriods) {
    alignmentStatus = 'mismatch'
    blockers.push(`rank_ic_common_periods_mismatch:${loadedCommonPeriods}!=${rankIcCommonPeriods}`)
  }
  return {
    rankIcCommonPeriods,
    loadedCommonPeriods,
    alignmentStatus,
    blockers,
  }
}

async function loadAssets(
  dataDir: string,
  symbols: string[],
  maxRows: number | null,
  timeframe: PaperUniverseTimeframe,
): Promise<AssetSeries[]> {
  const assets: AssetSeries[] = []
  for (const symbol of symbols) {
    const path = join(dataDir, paperSymbolToCsvFile(symbol, timeframe))
    if (!existsSync(path)) continue
    const candles = await loadCandles(path, maxRows)
    if (candles.length > 0) assets.push({ symbol, candles })
  }
  return alignByTailLength(assets)
}

function timeframeForBarMinutes(barMinutes: number): PaperUniverseTimeframe {
  if (barMinutes === 60) return '1h'
  if (barMinutes === 5) return '5m'
  if (barMinutes * 60 === 1) return '1s'
  throw new Error(`Unsupported barMinutes for paper universe files: ${barMinutes}`)
}

async function loadCandles(path: string, maxRows: number | null): Promise<Candle[]> {
  const raw = await readFile(path, 'utf-8')
  const lines = raw.trim().split('\n').filter(Boolean)
  if (lines.length <= 1) return []
  const header = lines[0].split(',')
  const timeIndex = header.indexOf('timestamp')
  const closeIndex = header.indexOf('close')
  const volumeIndex = header.indexOf('volume')
  const dataLines = maxRows == null ? lines.slice(1) : lines.slice(Math.max(1, lines.length - maxRows))
  return dataLines.map(line => {
    const cols = line.split(',')
    return {
      time: Number(cols[timeIndex]),
      close: Number(cols[closeIndex]),
      volume: Number(cols[volumeIndex]),
    }
  })
    .filter(candle => candle.time > 0 && [candle.close, candle.volume].every(Number.isFinite))
    .sort((a, b) => a.time - b.time)
}

function alignByTailLength(assets: AssetSeries[]): AssetSeries[] {
  if (assets.length === 0) return []
  const minLength = Math.min(...assets.map(asset => asset.candles.length))
  return assets.map(asset => ({
    symbol: asset.symbol,
    candles: asset.candles.slice(asset.candles.length - minLength),
  }))
}

function buildRuntimeStatsBySymbol(assets: AssetSeries[], barMinutes: number): Map<string, AssetRuntimeStats[]> {
  const dailyBars = hoursToBars(24, barMinutes)
  return new Map(assets.map(asset => [asset.symbol, buildRuntimeStats(asset.candles, dailyBars, barMinutes)]))
}

function buildRuntimeStats(candles: Candle[], lookbackBars: number, barMinutes: number): AssetRuntimeStats[] {
  const volumePrefix = [0]
  const volumeCountPrefix = [0]
  const volumeUsdPrefix = [0]
  const returnPrefix = [0]
  const returnSqPrefix = [0]

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    const validVolume = Number.isFinite(candle.volume) && candle.volume > 0
    const validVolumeUsd = validVolume && Number.isFinite(candle.close) && candle.close > 0
    volumePrefix.push(volumePrefix[index] + (validVolume ? candle.volume : 0))
    volumeCountPrefix.push(volumeCountPrefix[index] + (validVolume ? 1 : 0))
    volumeUsdPrefix.push(volumeUsdPrefix[index] + (validVolumeUsd ? candle.close * candle.volume : 0))

    const previous = candles[index - 1]
    const ret = previous && previous.close > 0 && candle.close > 0
      ? candle.close / previous.close - 1
      : 0
    returnPrefix.push(returnPrefix[index] + ret)
    returnSqPrefix.push(returnSqPrefix[index] + ret ** 2)
  }

  return candles.map((candle, index) => {
    const volumeStart = Math.max(0, index - lookbackBars + 1)
    const volumeEnd = index + 1
    const volumeSum = volumePrefix[volumeEnd] - volumePrefix[volumeStart]
    const volumeCount = volumeCountPrefix[volumeEnd] - volumeCountPrefix[volumeStart]
    const volumeUsd = volumeUsdPrefix[volumeEnd] - volumeUsdPrefix[volumeStart]

    const returnStart = Math.max(1, index - lookbackBars + 1)
    const returnEnd = index + 1
    const returnCount = Math.max(0, returnEnd - returnStart)
    const returnSum = returnPrefix[returnEnd] - returnPrefix[returnStart]
    const returnSqSum = returnSqPrefix[returnEnd] - returnSqPrefix[returnStart]
    const returnMean = returnCount > 0 ? returnSum / returnCount : 0
    const variance = returnCount > 1
      ? Math.max(0, returnSqSum / returnCount - returnMean ** 2)
      : null

    return {
      realizedVolPct: variance == null ? 50 : Math.sqrt(variance * 365 * 24 * 60 / barMinutes) * 100,
      avgVolume24h: volumeCount > 0 ? volumeSum / volumeCount : candle.volume,
      dailyVolumeUsd: volumeUsd,
    }
  })
}

function hoursToBars(hours: number, barMinutes: number): number {
  return Math.max(1, Math.round(hours * 60 / barMinutes))
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
    } else {
      out.set(key, next)
      index += 1
    }
  }
  return out
}

function parseSymbols(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map(value => value.trim()).filter(Boolean)
}

function parseNullablePath(raw: string | undefined): string | null {
  if (!raw) return null
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'null' || normalized === 'none' || normalized === 'false') return null
  return raw
}

function parseNullablePositiveInteger(raw: string | undefined, fallback: number | null, name: string): number | null {
  if (raw == null || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'null' || normalized === 'none' || normalized === 'false') return null
  return parsePositiveInteger(raw, fallback ?? 1, name)
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
  return parsed
}

function parseFiniteNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be finite.`)
  return parsed
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase())
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  if (!existsSync(path)) return null
  return JSON.parse(await readFile(path, 'utf-8'))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isRecordValue(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value !== null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readFactorName(value: unknown): FactorName | null {
  return value === 'raw_reversal' ||
    value === 'risk_adjusted_reversal' ||
    value === 'rank_reversal' ||
    value === 'signal_confidence'
    ? value
    : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0
  const avg = mean(values)
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length)
}

function percentile(values: number[], pct: number): number | undefined {
  const finite = values.filter(isFiniteNumber)
  if (finite.length === 0) return undefined
  const sorted = [...finite].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * pct)))
  return round(sorted[index], 6)
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function roundFinite(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return value
  return round(value, digits)
}

function nullableDelta(left: number | null, right: number | null): number | null {
  return left == null || right == null ? null : round(left - right, 6)
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_rank_ic_walkforward_filter_validation failed:', error)
    process.exitCode = 1
  })
}
