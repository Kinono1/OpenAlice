import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyzeInformationCoefficient, type IcSample } from '../src/domain/strategy/research/ic-analyzer.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { defaultPaperUniverseSymbols, paperSymbolToCsvFile, type PaperUniverseTimeframe } from './lib/paper_universe.js'

interface CliArgs {
  factorReportPath: string
  dataDir: string
  outputPath: string | null
  candidateId: string | null
  symbols: string[]
  barMinutes: number
  maxRows: number | null
  routeCostPct: number | null
  minUniverseSize: number
  minBucketAssets: number
  topBottomFraction: number
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
  dailyVolumeUsd: number
}

interface AssetAtTime {
  symbol: string
  time: number
  lookbackReturnPct: number
  forwardReturnPct: number
  dailyVolumeUsd: number
}

type LiquidityBucket = 'all' | 'low' | 'mid' | 'high'
type FactorDirection = 'momentum' | 'reversal'

interface LiquidityRegimeConfig {
  configId: string
  liquidityBucket: LiquidityBucket
  factor: FactorDirection
  lookbackHours: number
  forwardHours: number
  lookbackBars: number
  forwardBars: number
  routeCostPct: number
  sourceWfoStatus: string | null
  sourceFailedWindowRatio: number | null
  sourceWindows: Array<{
    windowIndex: number
    startTime: string
    endTime: string
    startIndex: number
    endIndexExclusive: number
  }>
}

interface RegimeObservation {
  index: number
  time: string
  medianLookbackReturnPct: number
  breadthPositivePct: number
  dispersionPct: number
  averageAbsLookbackReturnPct: number
  highLiquidityMedianReturnPct: number | null
  highLiquidityBreadthPositivePct: number | null
  btcLookbackReturnPct: number | null
  ethLookbackReturnPct: number | null
}

interface RegimeFilterCandidate {
  id: string
  description: string
  thresholds: {
    minMedianLookbackReturnPct?: number
    minBreadthPositivePct?: number
    maxDispersionPct?: number
    maxAverageAbsLookbackReturnPct?: number
    minHighLiquidityMedianReturnPct?: number
    minHighLiquidityBreadthPositivePct?: number
  }
  generatedFrom: 'baseline' | 'in_sample_regime_quantile'
}

interface LiquidityRegimeSummary {
  observations: number
  periods: number
  signalPeriods: number
  regimePeriodsEvaluated: number
  retainedRegimePeriods: number
  retainedPct: number | null
  meanIc: number
  icIr: number
  winRate: number
  passedIc: boolean
  averageLongShortSpreadPct: number | null
  longShortWinRate: number | null
  netAfterRouteCostPct: number | null
}

interface LiquidityRegimeWfoWindow extends LiquidityRegimeSummary {
  windowIndex: number
  startTime: string
  endTime: string
  startIndex: number
  endIndexExclusive: number
  passed: boolean
}

interface LiquidityRegimeWfo {
  status: 'pass' | 'fail' | 'insufficient_data'
  windowCount: number
  passedWindows: number
  failedWindows: number
  failedWindowRatio: number | null
  failWindowRatioThreshold: number
  directionStable: boolean
  windows: LiquidityRegimeWfoWindow[]
  blockers: string[]
}

export interface LiquidityConditionedRegimeFilterCandidate {
  filter: RegimeFilterCandidate
  summary: LiquidityRegimeSummary
  wfo: LiquidityRegimeWfo
  deltaVsBaseline: {
    meanIc: number | null
    icIr: number | null
    winRate: number | null
    averageLongShortSpreadPct: number | null
    netAfterRouteCostPct: number | null
    failedWindowRatio: number | null
    retainedPct: number | null
  }
  diagnosticVerdict:
    | 'baseline'
    | 'improved_wfo_candidate'
    | 'weaker_than_baseline'
    | 'insufficient_retention'
    | 'no_internal_wfo_improvement'
  warnings: string[]
}

export interface LiquidityConditionedRegimeFilterSweepReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  factorReportPath: string
  dataDir: string
  symbolsLoaded: string[]
  commonPeriods: number
  config: LiquidityRegimeConfig | null
  regimeDistribution: {
    observations: number
    quantiles: {
      medianLookbackReturnPct: Record<string, number | null>
      breadthPositivePct: Record<string, number | null>
      dispersionPct: Record<string, number | null>
      averageAbsLookbackReturnPct: Record<string, number | null>
      highLiquidityMedianReturnPct: Record<string, number | null>
    }
  }
  baseline: LiquidityConditionedRegimeFilterCandidate | null
  bestDiagnosticCandidate: LiquidityConditionedRegimeFilterCandidate | null
  candidates: LiquidityConditionedRegimeFilterCandidate[]
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_FACTOR_REPORT_PATH = 'data/research/liquidity_conditioned_factor_report.live_accumulated.latest.json'
const DEFAULT_DATA_DIR = 'data/market/live_accumulated'
const DEFAULT_OUTPUT_PATH = 'data/research/liquidity_conditioned_regime_filter_sweep.live_accumulated.latest.json'
const DEFAULT_ROUTE_COST_PCT = 0.36
const WFO_FAIL_WINDOW_RATIO_THRESHOLD = 0.3
const WFO_MIN_WINDOWS = 3
const WFO_MIN_PERIODS_PER_WINDOW = 3
const WFO_MIN_SIGNAL_PERIODS_PER_WINDOW = 3
const MIN_RETAINED_PCT = 0.5

async function main(): Promise<void> {
  const args = parseLiquidityConditionedRegimeFilterSweepArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runLiquidityConditionedRegimeFilterSweep(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'liquidity_conditioned_regime_filter_sweep',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.bestDiagnosticCandidate ? 'warn' : 'fail',
      recordsIn: report.symbolsLoaded.length,
      recordsOut: report.candidates.length,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseLiquidityConditionedRegimeFilterSweepArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    factorReportPath: raw.get('factorReportPath') ?? raw.get('factorReport') ?? DEFAULT_FACTOR_REPORT_PATH,
    dataDir: raw.get('dataDir') ?? DEFAULT_DATA_DIR,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    candidateId: raw.get('candidateId') ?? raw.get('configId') ?? null,
    symbols: parseSymbols(raw.get('symbols')),
    barMinutes: parsePositiveInteger(raw.get('barMinutes'), 60, 'barMinutes'),
    maxRows: parseNullablePositiveInteger(raw.get('maxRows'), null, 'maxRows'),
    routeCostPct: parseNullableFiniteNumber(raw.get('routeCostPct'), null, 'routeCostPct'),
    minUniverseSize: parsePositiveInteger(raw.get('minUniverseSize'), 20, 'minUniverseSize'),
    minBucketAssets: parsePositiveInteger(raw.get('minBucketAssets'), 5, 'minBucketAssets'),
    topBottomFraction: parseFiniteNumber(raw.get('topBottomFraction'), 0.25, 'topBottomFraction'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runLiquidityConditionedRegimeFilterSweep(
  args: CliArgs,
): Promise<LiquidityConditionedRegimeFilterSweepReport> {
  const factorReportPath = resolve(args.factorReportPath)
  const factorReport = asRecord(await readJsonIfExists(factorReportPath))
  const symbols = args.symbols.length > 0
    ? args.symbols
    : readStringArray(factorReport?.symbolsLoaded).length > 0
      ? readStringArray(factorReport?.symbolsLoaded)
      : defaultPaperUniverseSymbols()
  const assets = await loadAssets(resolve(args.dataDir), symbols, args.maxRows, timeframeForBarMinutes(args.barMinutes))
  const report = buildLiquidityConditionedRegimeFilterSweepReport({
    factorReportPath,
    factorReport,
    dataDir: resolve(args.dataDir),
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

export function buildLiquidityConditionedRegimeFilterSweepReport(input: {
  factorReportPath: string
  factorReport: Record<string, unknown> | null
  dataDir: string
  assets: AssetSeries[]
  args: Pick<CliArgs, 'candidateId' | 'barMinutes' | 'routeCostPct' | 'minUniverseSize' | 'minBucketAssets' | 'topBottomFraction'>
  generatedAt?: string
}): LiquidityConditionedRegimeFilterSweepReport {
  const commonPeriods = input.assets.length > 0
    ? Math.min(...input.assets.map(asset => asset.candles.length))
    : 0
  const runtimeStatsBySymbol = buildRuntimeStatsBySymbol(input.assets, input.args.barMinutes)
  const config = extractConfig(input.factorReport, input.args, commonPeriods)
  const regimeObservations = config
    ? buildRegimeObservations({
      assets: input.assets,
      runtimeStatsBySymbol,
      config,
      minUniverseSize: input.args.minUniverseSize,
      barMinutes: input.args.barMinutes,
    })
    : []
  const filters = buildFilterCandidates(regimeObservations)
  const candidates = config
    ? filters.map(filter => evaluateFilterCandidate({
      filter,
      assets: input.assets,
      runtimeStatsBySymbol,
      config,
      args: input.args,
    }))
    : []
  const baseline = candidates.find(candidate => candidate.filter.id === 'no_filter') ?? null
  const candidatesWithDeltas = baseline
    ? candidates.map(candidate => candidate.filter.id === 'no_filter'
      ? candidate
      : classifyCandidate(candidate, baseline))
    : candidates
  const sorted = [...candidatesWithDeltas].sort(compareCandidates)
  const bestDiagnosticCandidate = sorted.find(candidate =>
    candidate.filter.id !== 'no_filter' &&
    candidate.diagnosticVerdict === 'improved_wfo_candidate'
  ) ?? null
  const blockers = buildBlockers({
    factorReport: input.factorReport,
    config,
    commonPeriods,
    assetsLoaded: input.assets.length,
    minUniverseSize: input.args.minUniverseSize,
    bestDiagnosticCandidate,
  })

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    factorReportPath: input.factorReportPath,
    dataDir: resolve(input.dataDir),
    symbolsLoaded: input.assets.map(asset => asset.symbol),
    commonPeriods,
    config,
    regimeDistribution: summarizeRegimeDistribution(regimeObservations),
    baseline,
    bestDiagnosticCandidate,
    candidates: sorted,
    blockers,
    nextActions: buildNextActions(bestDiagnosticCandidate),
    notes: [
      'This artifact is a research-only in-sample regime-filter sweep; it cannot authorize paper orders, live orders, promotion, or leverage changes.',
      'Filter thresholds are generated from the current sample distribution and are therefore overfit-risk diagnostics until validated on future decision windows.',
      'Every filter uses only decision-time observable inputs: cross-sectional lookback returns, breadth, dispersion, and trailing liquidity buckets.',
      'A promising diagnostic filter must be moved into the normal trial pipeline and rerun through WFO, route cost, complete trial ledger, BY FDR, PIT, prospective labels, and paper evidence gates.',
    ],
  }
}

function evaluateFilterCandidate(input: {
  filter: RegimeFilterCandidate
  assets: AssetSeries[]
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  config: LiquidityRegimeConfig
  args: Pick<CliArgs, 'barMinutes' | 'minUniverseSize' | 'minBucketAssets' | 'topBottomFraction'>
}): LiquidityConditionedRegimeFilterCandidate {
  const summary = evaluateFilteredLiquidityConfig(input)
  const wfo = buildFilteredWfo(input)
  return {
    filter: input.filter,
    summary,
    wfo,
    deltaVsBaseline: {
      meanIc: null,
      icIr: null,
      winRate: null,
      averageLongShortSpreadPct: null,
      netAfterRouteCostPct: null,
      failedWindowRatio: null,
      retainedPct: null,
    },
    diagnosticVerdict: input.filter.id === 'no_filter' ? 'baseline' : 'no_internal_wfo_improvement',
    warnings: buildWarnings(input.filter, summary, wfo),
  }
}

function classifyCandidate(
  candidate: LiquidityConditionedRegimeFilterCandidate,
  baseline: LiquidityConditionedRegimeFilterCandidate,
): LiquidityConditionedRegimeFilterCandidate {
  const delta = {
    meanIc: nullableDelta(candidate.summary.meanIc, baseline.summary.meanIc),
    icIr: nullableDelta(candidate.summary.icIr, baseline.summary.icIr),
    winRate: nullableDelta(candidate.summary.winRate, baseline.summary.winRate),
    averageLongShortSpreadPct: nullableDelta(candidate.summary.averageLongShortSpreadPct, baseline.summary.averageLongShortSpreadPct),
    netAfterRouteCostPct: nullableDelta(candidate.summary.netAfterRouteCostPct, baseline.summary.netAfterRouteCostPct),
    failedWindowRatio: nullableDelta(candidate.wfo.failedWindowRatio, baseline.wfo.failedWindowRatio),
    retainedPct: nullableDelta(candidate.summary.retainedPct, baseline.summary.retainedPct),
  }
  const retainedOk = (candidate.summary.retainedPct ?? 0) >= MIN_RETAINED_PCT
  const improvedWfo = candidate.wfo.status === 'pass' ||
    (candidate.wfo.status !== 'insufficient_data' &&
      (candidate.wfo.failedWindowRatio ?? 1) < (baseline.wfo.failedWindowRatio ?? 1) &&
      candidate.wfo.passedWindows >= baseline.wfo.passedWindows)
  const positiveNet = (candidate.summary.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) > 0
  const noMajorIcDamage = candidate.summary.meanIc >= Math.min(0, baseline.summary.meanIc) &&
    candidate.summary.icIr >= Math.min(0, baseline.summary.icIr)
  let diagnosticVerdict: LiquidityConditionedRegimeFilterCandidate['diagnosticVerdict'] = 'no_internal_wfo_improvement'
  if (!retainedOk) diagnosticVerdict = 'insufficient_retention'
  else if (improvedWfo && positiveNet && noMajorIcDamage) diagnosticVerdict = 'improved_wfo_candidate'
  else if (
    (candidate.wfo.failedWindowRatio ?? 1) > (baseline.wfo.failedWindowRatio ?? 1) ||
    (candidate.summary.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) < 0
  ) {
    diagnosticVerdict = 'weaker_than_baseline'
  }
  return {
    ...candidate,
    deltaVsBaseline: delta,
    diagnosticVerdict,
    warnings: buildWarnings(candidate.filter, candidate.summary, candidate.wfo),
  }
}

function evaluateFilteredLiquidityConfig(input: {
  filter: RegimeFilterCandidate
  assets: AssetSeries[]
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  config: LiquidityRegimeConfig
  args: Pick<CliArgs, 'barMinutes' | 'minUniverseSize' | 'minBucketAssets' | 'topBottomFraction'>
  startIndex?: number
  endIndexExclusive?: number
}): LiquidityRegimeSummary {
  const commonPeriods = input.assets.length > 0
    ? Math.min(...input.assets.map(asset => asset.candles.length))
    : 0
  const dailyBars = hoursToBars(24, input.args.barMinutes)
  const naturalStart = Math.max(input.config.lookbackBars, dailyBars) + 1
  const naturalEnd = commonPeriods - input.config.forwardBars
  const startIndex = Math.max(naturalStart, input.startIndex ?? naturalStart)
  const endIndexExclusive = Math.min(naturalEnd, input.endIndexExclusive ?? naturalEnd)
  const samples: IcSample[] = []
  const signalSpreads: number[] = []
  let regimePeriodsEvaluated = 0
  let retainedRegimePeriods = 0

  for (let index = startIndex; index < endIndexExclusive; index += 1) {
    const rows = buildAssetsAtTime({
      assets: input.assets,
      runtimeStatsBySymbol: input.runtimeStatsBySymbol,
      index,
      lookbackBars: input.config.lookbackBars,
      forwardBars: input.config.forwardBars,
    })
    if (rows.length < input.args.minUniverseSize) continue
    const regime = buildRegimeObservation(index, rows)
    if (!regime) continue
    regimePeriodsEvaluated += 1
    if (!filterAllows(input.filter, regime)) continue
    retainedRegimePeriods += 1
    const bucketRows = selectLiquidityBucket(rows, input.config.liquidityBucket)
    const minAssets = input.config.liquidityBucket === 'all' ? input.args.minUniverseSize : input.args.minBucketAssets
    if (bucketRows.length < minAssets) continue
    const bucketKey = rows[0]?.time ?? index
    for (const row of bucketRows) {
      samples.push({
        factorValue: factorValue(row.lookbackReturnPct, input.config.factor),
        forwardReturn: row.forwardReturnPct,
        bucketKey,
      })
    }
    const spread = longShortSpread(bucketRows, input.config.factor, input.args.topBottomFraction)
    if (spread != null) signalSpreads.push(spread)
  }

  const ic = analyzeInformationCoefficient(samples)
  const averageLongShortSpreadPct = signalSpreads.length > 0 ? round(mean(signalSpreads), 6) : null
  const netAfterRouteCostPct = averageLongShortSpreadPct == null
    ? null
    : round(averageLongShortSpreadPct - input.config.routeCostPct, 6)
  return {
    observations: ic.observations,
    periods: ic.periods,
    signalPeriods: signalSpreads.length,
    regimePeriodsEvaluated,
    retainedRegimePeriods,
    retainedPct: regimePeriodsEvaluated > 0 ? round(retainedRegimePeriods / regimePeriodsEvaluated, 6) : null,
    meanIc: round(ic.meanIc, 6),
    icIr: roundFinite(ic.icIr, 6),
    winRate: round(ic.winRate, 6),
    passedIc: ic.passed,
    averageLongShortSpreadPct,
    longShortWinRate: signalSpreads.length > 0
      ? round(signalSpreads.filter(value => value > 0).length / signalSpreads.length, 6)
      : null,
    netAfterRouteCostPct,
  }
}

function buildFilteredWfo(input: {
  filter: RegimeFilterCandidate
  assets: AssetSeries[]
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  config: LiquidityRegimeConfig
  args: Pick<CliArgs, 'barMinutes' | 'minUniverseSize' | 'minBucketAssets' | 'topBottomFraction'>
}): LiquidityRegimeWfo {
  const windows = sourceOrSyntheticWindows(input.config, input.assets, input.args.barMinutes).map((window, index) => {
    const summary = evaluateFilteredLiquidityConfig({
      ...input,
      startIndex: window.startIndex,
      endIndexExclusive: window.endIndexExclusive,
    })
    const passed = summary.passedIc &&
      summary.periods >= WFO_MIN_PERIODS_PER_WINDOW &&
      summary.signalPeriods >= WFO_MIN_SIGNAL_PERIODS_PER_WINDOW &&
      (summary.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) > 0
    return {
      ...summary,
      windowIndex: window.windowIndex ?? index,
      startTime: window.startTime,
      endTime: window.endTime,
      startIndex: window.startIndex,
      endIndexExclusive: window.endIndexExclusive,
      passed,
    }
  })
  const blockers: string[] = []
  if (windows.length < WFO_MIN_WINDOWS) blockers.push(`wfo_windows_low:${windows.length}<${WFO_MIN_WINDOWS}`)
  for (const window of windows) {
    if (window.periods < WFO_MIN_PERIODS_PER_WINDOW) {
      blockers.push(`wfo_window_${window.windowIndex}_periods_low:${window.periods}<${WFO_MIN_PERIODS_PER_WINDOW}`)
    }
    if (window.signalPeriods < WFO_MIN_SIGNAL_PERIODS_PER_WINDOW) {
      blockers.push(`wfo_window_${window.windowIndex}_signal_periods_low:${window.signalPeriods}<${WFO_MIN_SIGNAL_PERIODS_PER_WINDOW}`)
    }
  }
  const failedWindows = windows.filter(window => !window.passed).length
  const passedWindows = windows.length - failedWindows
  const failedWindowRatio = windows.length > 0 ? failedWindows / windows.length : null
  if (failedWindowRatio != null && failedWindowRatio > WFO_FAIL_WINDOW_RATIO_THRESHOLD) {
    blockers.push(`wfo_failed_window_ratio:${round(failedWindowRatio, 6)}>${WFO_FAIL_WINDOW_RATIO_THRESHOLD}`)
  }
  const directionStable = windows.length >= WFO_MIN_WINDOWS &&
    windows.every(window => window.meanIc > 0 && (window.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) > 0)
  if (!directionStable) blockers.push('wfo_direction_or_net_not_stable')
  const insufficientData = windows.length < WFO_MIN_WINDOWS ||
    windows.some(window => window.periods < WFO_MIN_PERIODS_PER_WINDOW || window.signalPeriods < WFO_MIN_SIGNAL_PERIODS_PER_WINDOW)
  return {
    status: blockers.length === 0 ? 'pass' : insufficientData ? 'insufficient_data' : 'fail',
    windowCount: windows.length,
    passedWindows,
    failedWindows,
    failedWindowRatio: failedWindowRatio == null ? null : round(failedWindowRatio, 6),
    failWindowRatioThreshold: WFO_FAIL_WINDOW_RATIO_THRESHOLD,
    directionStable,
    windows,
    blockers: uniqueStrings(blockers),
  }
}

function buildRegimeObservations(input: {
  assets: AssetSeries[]
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  config: LiquidityRegimeConfig
  minUniverseSize: number
  barMinutes: number
}): RegimeObservation[] {
  const commonPeriods = input.assets.length > 0
    ? Math.min(...input.assets.map(asset => asset.candles.length))
    : 0
  const naturalStart = Math.max(input.config.lookbackBars, hoursToBars(24, input.barMinutes)) + 1
  const naturalEnd = commonPeriods - input.config.forwardBars
  const out: RegimeObservation[] = []
  for (let index = naturalStart; index < naturalEnd; index += 1) {
    const rows = buildAssetsAtTime({
      assets: input.assets,
      runtimeStatsBySymbol: input.runtimeStatsBySymbol,
      index,
      lookbackBars: input.config.lookbackBars,
      forwardBars: input.config.forwardBars,
    })
    if (rows.length < input.minUniverseSize) continue
    const observation = buildRegimeObservation(index, rows)
    if (observation) out.push(observation)
  }
  return out
}

function buildRegimeObservation(index: number, rows: AssetAtTime[]): RegimeObservation | null {
  if (rows.length < 2) return null
  const returns = rows.map(row => row.lookbackReturnPct).filter(isFiniteNumber)
  if (returns.length < 2) return null
  const highRows = selectLiquidityBucket(rows, 'high')
  const highReturns = highRows.map(row => row.lookbackReturnPct).filter(isFiniteNumber)
  return {
    index,
    time: new Date(rows[0]?.time ?? index).toISOString(),
    medianLookbackReturnPct: round(median(returns), 6),
    breadthPositivePct: round(returns.filter(value => value > 0).length / returns.length, 6),
    dispersionPct: round(standardDeviation(returns), 6),
    averageAbsLookbackReturnPct: round(mean(returns.map(value => Math.abs(value))), 6),
    highLiquidityMedianReturnPct: highReturns.length > 0 ? round(median(highReturns), 6) : null,
    highLiquidityBreadthPositivePct: highReturns.length > 0
      ? round(highReturns.filter(value => value > 0).length / highReturns.length, 6)
      : null,
    btcLookbackReturnPct: rows.find(row => row.symbol === 'BTC-USDT')?.lookbackReturnPct ?? null,
    ethLookbackReturnPct: rows.find(row => row.symbol === 'ETH-USDT')?.lookbackReturnPct ?? null,
  }
}

function buildFilterCandidates(observations: RegimeObservation[]): RegimeFilterCandidate[] {
  const filters: RegimeFilterCandidate[] = [{
    id: 'no_filter',
    description: 'Baseline: keep every decision-time regime.',
    thresholds: {},
    generatedFrom: 'baseline',
  }]
  if (observations.length === 0) return filters
  const medianReturns = observations.map(obs => obs.medianLookbackReturnPct)
  const breadth = observations.map(obs => obs.breadthPositivePct)
  const dispersion = observations.map(obs => obs.dispersionPct)
  const absReturns = observations.map(obs => obs.averageAbsLookbackReturnPct)
  const highMedian = observations.map(obs => obs.highLiquidityMedianReturnPct).filter(isFiniteNumber)
  const highBreadth = observations.map(obs => obs.highLiquidityBreadthPositivePct).filter(isFiniteNumber)
  const p25Median = percentile(medianReturns, 0.25)
  const p33Median = percentile(medianReturns, 0.33)
  const p25Breadth = percentile(breadth, 0.25)
  const p67Dispersion = percentile(dispersion, 0.67)
  const p75Dispersion = percentile(dispersion, 0.75)
  const p75AbsReturn = percentile(absReturns, 0.75)
  const p25HighMedian = percentile(highMedian, 0.25)
  const p25HighBreadth = percentile(highBreadth, 0.25)

  pushFilter(filters, 'median_return_gte_p25', 'Keep regimes with median lookback return above the in-sample 25th percentile.', {
    minMedianLookbackReturnPct: p25Median,
  })
  pushFilter(filters, 'median_return_gte_p33', 'Keep regimes with median lookback return above the in-sample 33rd percentile.', {
    minMedianLookbackReturnPct: p33Median,
  })
  pushFilter(filters, 'breadth_gte_p25', 'Keep regimes with positive-return breadth above the in-sample 25th percentile.', {
    minBreadthPositivePct: p25Breadth,
  })
  pushFilter(filters, 'dispersion_lte_p67', 'Skip the highest cross-sectional dispersion regimes.', {
    maxDispersionPct: p67Dispersion,
  })
  pushFilter(filters, 'dispersion_lte_p75', 'Skip only the highest quartile of cross-sectional dispersion regimes.', {
    maxDispersionPct: p75Dispersion,
  })
  pushFilter(filters, 'abs_return_lte_p75', 'Skip only the highest quartile of absolute market move regimes.', {
    maxAverageAbsLookbackReturnPct: p75AbsReturn,
  })
  pushFilter(filters, 'high_liq_median_gte_p25', 'Keep regimes where high-liquidity coins are not in the weakest median-return quartile.', {
    minHighLiquidityMedianReturnPct: p25HighMedian,
  })
  pushFilter(filters, 'high_liq_breadth_gte_p25', 'Keep regimes where high-liquidity positive-return breadth is not in the weakest quartile.', {
    minHighLiquidityBreadthPositivePct: p25HighBreadth,
  })
  pushFilter(filters, 'median_gte_p25_dispersion_lte_p75', 'Keep non-crash median-return regimes while skipping only extreme dispersion.', {
    minMedianLookbackReturnPct: p25Median,
    maxDispersionPct: p75Dispersion,
  })
  pushFilter(filters, 'breadth_gte_p25_abs_return_lte_p75', 'Keep broad enough markets while skipping only extreme absolute-move regimes.', {
    minBreadthPositivePct: p25Breadth,
    maxAverageAbsLookbackReturnPct: p75AbsReturn,
  })
  pushFilter(filters, 'high_liq_breadth_gte_p25_dispersion_lte_p75', 'Keep high-liquidity breadth regimes while skipping only extreme dispersion.', {
    minHighLiquidityBreadthPositivePct: p25HighBreadth,
    maxDispersionPct: p75Dispersion,
  })
  return filters
}

function pushFilter(
  filters: RegimeFilterCandidate[],
  id: string,
  description: string,
  thresholds: RegimeFilterCandidate['thresholds'],
): void {
  if (Object.values(thresholds).some(value => value == null || !Number.isFinite(value))) return
  filters.push({
    id,
    description,
    thresholds: Object.fromEntries(
      Object.entries(thresholds).map(([key, value]) => [key, round(Number(value), 6)]),
    ),
    generatedFrom: 'in_sample_regime_quantile',
  })
}

function filterAllows(filter: RegimeFilterCandidate, observation: RegimeObservation): boolean {
  const thresholds = filter.thresholds
  if (
    thresholds.minMedianLookbackReturnPct != null &&
    observation.medianLookbackReturnPct < thresholds.minMedianLookbackReturnPct
  ) return false
  if (
    thresholds.minBreadthPositivePct != null &&
    observation.breadthPositivePct < thresholds.minBreadthPositivePct
  ) return false
  if (thresholds.maxDispersionPct != null && observation.dispersionPct > thresholds.maxDispersionPct) return false
  if (
    thresholds.maxAverageAbsLookbackReturnPct != null &&
    observation.averageAbsLookbackReturnPct > thresholds.maxAverageAbsLookbackReturnPct
  ) return false
  if (
    thresholds.minHighLiquidityMedianReturnPct != null &&
    (observation.highLiquidityMedianReturnPct == null ||
      observation.highLiquidityMedianReturnPct < thresholds.minHighLiquidityMedianReturnPct)
  ) return false
  if (
    thresholds.minHighLiquidityBreadthPositivePct != null &&
    (observation.highLiquidityBreadthPositivePct == null ||
      observation.highLiquidityBreadthPositivePct < thresholds.minHighLiquidityBreadthPositivePct)
  ) return false
  return true
}

function extractConfig(
  factorReport: Record<string, unknown> | null,
  args: Pick<CliArgs, 'candidateId' | 'barMinutes' | 'routeCostPct'>,
  commonPeriods: number,
): LiquidityRegimeConfig | null {
  const source = findConfigSource(factorReport, args.candidateId)
  if (!source) return null
  const configId = readString(source.configId)
  const liquidityBucket = readLiquidityBucket(source.liquidityBucket)
  const factor = readFactorDirection(source.factor)
  const lookbackHours = readNumber(source.lookbackHours)
  const forwardHours = readNumber(source.forwardHours)
  if (!configId || !liquidityBucket || !factor || lookbackHours == null || forwardHours == null) return null
  const lookbackBars = readNumber(source.lookbackBars) ?? hoursToBars(lookbackHours, args.barMinutes)
  const forwardBars = readNumber(source.forwardBars) ?? hoursToBars(forwardHours, args.barMinutes)
  const reportRouteCost = readNumber(asRecord(factorReport?.routeCost)?.pairRoundTripCostPct)
  const wfo = asRecord(source.wfo)
  return {
    configId,
    liquidityBucket,
    factor,
    lookbackHours,
    forwardHours,
    lookbackBars,
    forwardBars,
    routeCostPct: args.routeCostPct ?? reportRouteCost ?? DEFAULT_ROUTE_COST_PCT,
    sourceWfoStatus: readString(wfo?.status),
    sourceFailedWindowRatio: readNumber(wfo?.failedWindowRatio),
    sourceWindows: readWfoWindows(wfo, commonPeriods, forwardBars),
  }
}

function findConfigSource(factorReport: Record<string, unknown> | null, candidateId: string | null): Record<string, unknown> | null {
  const all: Record<string, unknown>[] = []
  const best = asRecord(factorReport?.best)
  if (best) all.push(best)
  if (Array.isArray(factorReport?.topConfigs)) {
    all.push(...factorReport.topConfigs.map(asRecord).filter(isRecordValue))
  }
  if (Array.isArray(factorReport?.bucketSummaries)) {
    for (const summary of factorReport.bucketSummaries.map(asRecord).filter(isRecordValue)) {
      const momentum = asRecord(summary.bestMomentum)
      const reversal = asRecord(summary.bestReversal)
      if (momentum) all.push(momentum)
      if (reversal) all.push(reversal)
    }
  }
  if (!candidateId) return best ?? all[0] ?? null
  return all.find(item => readString(item.configId) === candidateId) ?? null
}

function readWfoWindows(
  wfo: Record<string, unknown> | null,
  commonPeriods: number,
  forwardBars: number,
): LiquidityRegimeConfig['sourceWindows'] {
  const raw = Array.isArray(wfo?.windows) ? wfo.windows : []
  const windows = raw
    .map(asRecord)
    .filter(isRecordValue)
    .map((window, index) => ({
      windowIndex: readFiniteNumber(window.windowIndex, index),
      startTime: readString(window.startTime) ?? '',
      endTime: readString(window.endTime) ?? '',
      startIndex: readFiniteNumber(window.startIndex, 0),
      endIndexExclusive: readFiniteNumber(window.endIndexExclusive, 0),
    }))
    .filter(window => window.endIndexExclusive > window.startIndex)
  if (windows.length > 0) return windows
  return buildContiguousWindows(25, Math.max(25, commonPeriods - forwardBars), 5).map((window, index) => ({
    windowIndex: index,
    startTime: '',
    endTime: '',
    ...window,
  }))
}

function sourceOrSyntheticWindows(
  config: LiquidityRegimeConfig,
  assets: AssetSeries[],
  barMinutes: number,
): LiquidityRegimeConfig['sourceWindows'] {
  if (config.sourceWindows.length > 0) return config.sourceWindows
  const commonPeriods = assets.length > 0 ? Math.min(...assets.map(asset => asset.candles.length)) : 0
  const naturalStart = Math.max(config.lookbackBars, hoursToBars(24, barMinutes)) + 1
  const naturalEnd = commonPeriods - config.forwardBars
  return buildContiguousWindows(naturalStart, naturalEnd, 5).map((window, index) => ({
    windowIndex: index,
    startTime: '',
    endTime: '',
    ...window,
  }))
}

function buildAssetsAtTime(input: {
  assets: AssetSeries[]
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  index: number
  lookbackBars: number
  forwardBars: number
}): AssetAtTime[] {
  const rows: AssetAtTime[] = []
  for (const asset of input.assets) {
    const current = asset.candles[input.index]
    const lookback = asset.candles[input.index - input.lookbackBars]
    const forward = asset.candles[input.index + input.forwardBars]
    const runtimeStats = input.runtimeStatsBySymbol.get(asset.symbol)?.[input.index]
    if (!current || !lookback || !forward || !runtimeStats) continue
    if (current.close <= 0 || lookback.close <= 0 || forward.close <= 0) continue
    if (!Number.isFinite(runtimeStats.dailyVolumeUsd) || runtimeStats.dailyVolumeUsd <= 0) continue
    rows.push({
      symbol: asset.symbol,
      time: current.time,
      lookbackReturnPct: (current.close / lookback.close - 1) * 100,
      forwardReturnPct: (forward.close / current.close - 1) * 100,
      dailyVolumeUsd: runtimeStats.dailyVolumeUsd,
    })
  }
  return rows
}

function selectLiquidityBucket(rows: AssetAtTime[], bucket: LiquidityBucket): AssetAtTime[] {
  if (bucket === 'all') return rows
  const sorted = [...rows].sort((left, right) => left.dailyVolumeUsd - right.dailyVolumeUsd)
  const lowEnd = Math.ceil(sorted.length / 3)
  const highStart = Math.floor(sorted.length * 2 / 3)
  if (bucket === 'low') return sorted.slice(0, lowEnd)
  if (bucket === 'mid') return sorted.slice(lowEnd, highStart)
  return sorted.slice(highStart)
}

function longShortSpread(rows: AssetAtTime[], factor: FactorDirection, topBottomFraction: number): number | null {
  if (rows.length < 2) return null
  const sorted = [...rows].sort((left, right) =>
    factorValue(left.lookbackReturnPct, factor) - factorValue(right.lookbackReturnPct, factor),
  )
  const count = Math.max(1, Math.min(Math.floor(rows.length / 2), Math.floor(rows.length * topBottomFraction)))
  const shorts = sorted.slice(0, count)
  const longs = sorted.slice(sorted.length - count)
  if (longs.length === 0 || shorts.length === 0) return null
  return mean(longs.map(row => row.forwardReturnPct)) - mean(shorts.map(row => row.forwardReturnPct))
}

function factorValue(lookbackReturnPct: number, factor: FactorDirection): number {
  return factor === 'momentum' ? lookbackReturnPct : -lookbackReturnPct
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
    .sort((left, right) => left.time - right.time)
}

function alignByTailLength(assets: AssetSeries[]): AssetSeries[] {
  if (assets.length === 0) return []
  const minLength = Math.min(...assets.map(asset => asset.candles.length))
  return assets
    .filter(asset => asset.candles.length >= minLength && minLength > 0)
    .map(asset => ({
      symbol: asset.symbol,
      candles: asset.candles.slice(asset.candles.length - minLength),
    }))
}

function buildRuntimeStatsBySymbol(assets: AssetSeries[], barMinutes: number): Map<string, AssetRuntimeStats[]> {
  const dailyBars = hoursToBars(24, barMinutes)
  return new Map(assets.map(asset => [asset.symbol, buildRuntimeStats(asset.candles, dailyBars)]))
}

function buildRuntimeStats(candles: Candle[], dailyBars: number): AssetRuntimeStats[] {
  const volumeUsdPrefix = [0]
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    const volumeUsd = candle.close > 0 && candle.volume > 0 ? candle.close * candle.volume : 0
    volumeUsdPrefix.push(volumeUsdPrefix[index] + volumeUsd)
  }
  return candles.map((_candle, index) => {
    const start = Math.max(0, index - dailyBars + 1)
    const end = index + 1
    return {
      dailyVolumeUsd: volumeUsdPrefix[end] - volumeUsdPrefix[start],
    }
  })
}

function buildContiguousWindows(
  startIndex: number,
  endIndexExclusive: number,
  windowCount: number,
): Array<{ startIndex: number; endIndexExclusive: number }> {
  const total = Math.max(0, endIndexExclusive - startIndex)
  if (total <= 0 || windowCount <= 0) return []
  const windows: Array<{ startIndex: number; endIndexExclusive: number }> = []
  for (let index = 0; index < windowCount; index += 1) {
    const start = startIndex + Math.floor(total * index / windowCount)
    const end = startIndex + Math.floor(total * (index + 1) / windowCount)
    if (end > start) windows.push({ startIndex: start, endIndexExclusive: end })
  }
  return windows
}

function buildWarnings(
  filter: RegimeFilterCandidate,
  summary: LiquidityRegimeSummary,
  wfo: LiquidityRegimeWfo,
): string[] {
  const warnings: string[] = []
  if (filter.generatedFrom === 'in_sample_regime_quantile') warnings.push('filter_thresholds_fit_in_sample')
  if ((summary.retainedPct ?? 0) < MIN_RETAINED_PCT) warnings.push(`retention_below_${MIN_RETAINED_PCT}`)
  if (wfo.status !== 'pass') warnings.push(`internal_wfo_${wfo.status}`)
  return warnings
}

function compareCandidates(left: LiquidityConditionedRegimeFilterCandidate, right: LiquidityConditionedRegimeFilterCandidate): number {
  return verdictRank(right.diagnosticVerdict) - verdictRank(left.diagnosticVerdict) ||
    Number(right.wfo.status === 'pass') - Number(left.wfo.status === 'pass') ||
    (left.wfo.failedWindowRatio ?? 1) - (right.wfo.failedWindowRatio ?? 1) ||
    (right.summary.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) -
      (left.summary.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) ||
    right.summary.icIr - left.summary.icIr ||
    right.summary.meanIc - left.summary.meanIc ||
    right.summary.retainedRegimePeriods - left.summary.retainedRegimePeriods
}

function verdictRank(verdict: LiquidityConditionedRegimeFilterCandidate['diagnosticVerdict']): number {
  if (verdict === 'improved_wfo_candidate') return 4
  if (verdict === 'baseline') return 3
  if (verdict === 'no_internal_wfo_improvement') return 2
  if (verdict === 'weaker_than_baseline') return 1
  return 0
}

function summarizeRegimeDistribution(observations: RegimeObservation[]): LiquidityConditionedRegimeFilterSweepReport['regimeDistribution'] {
  return {
    observations: observations.length,
    quantiles: {
      medianLookbackReturnPct: quantileMap(observations.map(obs => obs.medianLookbackReturnPct)),
      breadthPositivePct: quantileMap(observations.map(obs => obs.breadthPositivePct)),
      dispersionPct: quantileMap(observations.map(obs => obs.dispersionPct)),
      averageAbsLookbackReturnPct: quantileMap(observations.map(obs => obs.averageAbsLookbackReturnPct)),
      highLiquidityMedianReturnPct: quantileMap(observations.map(obs => obs.highLiquidityMedianReturnPct).filter(isFiniteNumber)),
    },
  }
}

function quantileMap(values: number[]): Record<string, number | null> {
  return {
    p10: percentile(values, 0.1),
    p25: percentile(values, 0.25),
    p33: percentile(values, 0.33),
    p50: percentile(values, 0.5),
    p67: percentile(values, 0.67),
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.9),
  }
}

function buildBlockers(input: {
  factorReport: Record<string, unknown> | null
  config: LiquidityRegimeConfig | null
  commonPeriods: number
  assetsLoaded: number
  minUniverseSize: number
  bestDiagnosticCandidate: LiquidityConditionedRegimeFilterCandidate | null
}): string[] {
  const blockers = [
    'research_only_not_execution_evidence',
    'filter_thresholds_in_sample_overfit_risk',
    'route_cost_manual_not_runtime_verified',
    'runtime_fee_not_verified',
    'not_trial_ledger_fdr_validated',
    'not_pit_audit_validated',
    'not_paper_execution_evidence',
    'paper_live_execution_disabled',
  ]
  if (!input.factorReport) blockers.push('liquidity_conditioned_factor_report_missing')
  if (!input.config) blockers.push('liquidity_conditioned_config_missing')
  if (input.assetsLoaded < input.minUniverseSize) blockers.push(`loaded_universe_too_small:${input.assetsLoaded}<${input.minUniverseSize}`)
  if (input.commonPeriods < 1_000) blockers.push(`common_periods_low:${input.commonPeriods}<1000`)
  if (!input.bestDiagnosticCandidate) blockers.push('no_improved_wfo_regime_filter_candidate')
  return uniqueStrings(blockers)
}

function buildNextActions(best: LiquidityConditionedRegimeFilterCandidate | null): string[] {
  const actions = [
    'Do not enable paper/live from this artifact; it is an in-sample research sweep only.',
  ]
  if (best) {
    actions.push(`Promising diagnostic liquidity-regime filter: ${best.filter.id}; convert it into a locked research lane only, not execution.`)
    actions.push('Validate the filter on future closed prospective windows before counting it as promotion evidence.')
  } else {
    actions.push('Current simple regime filters did not produce a clean internal WFO improvement; keep collecting prospective labels and consider retiring this fixed liquidity factor if future windows fail.')
  }
  actions.push('After any candidate change, rerun route cost, complete trial ledger, BY FDR, PIT audit, release gate, and paper execution evidence.')
  return actions
}

function renderConsoleSummary(report: LiquidityConditionedRegimeFilterSweepReport): string {
  const lines = [
    `liquidity regime filter sweep: candidates=${report.candidates.length}, best=${report.bestDiagnosticCandidate?.filter.id ?? 'none'}`,
    `config=${report.config?.configId ?? 'missing'}, sourceWfo=${report.config?.sourceWfoStatus ?? 'missing'}, sourceFailRatio=${report.config?.sourceFailedWindowRatio ?? 'missing'}`,
    `regimeObs=${report.regimeDistribution.observations}, blockers=${report.blockers.join('|')}`,
  ]
  for (const row of report.candidates.slice(0, 8)) {
    lines.push([
      row.filter.id,
      row.diagnosticVerdict,
      `wfo=${row.wfo.status}`,
      `pass=${row.wfo.passedWindows}/${row.wfo.windowCount}`,
      `failRatio=${row.wfo.failedWindowRatio}`,
      `net=${row.summary.netAfterRouteCostPct}`,
      `ic=${row.summary.meanIc}`,
      `ir=${row.summary.icIr}`,
      `retain=${row.summary.retainedPct}`,
      `warnings=${row.warnings.join(',') || 'none'}`,
    ].join(' | '))
  }
  return lines.join('\n')
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

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
  return parsed
}

function parseNullablePositiveInteger(raw: string | undefined, fallback: number | null, name: string): number | null {
  if (raw == null || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'null' || normalized === 'none' || normalized === 'false') return null
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

function parseNullableFiniteNumber(raw: string | undefined, fallback: number | null, name: string): number | null {
  if (raw == null || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'null' || normalized === 'none' || normalized === 'false') return null
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

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readLiquidityBucket(value: unknown): LiquidityBucket | null {
  return value === 'all' || value === 'low' || value === 'mid' || value === 'high' ? value : null
}

function readFactorDirection(value: unknown): FactorDirection | null {
  return value === 'momentum' || value === 'reversal' ? value : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function hoursToBars(hours: number, barMinutes: number): number {
  return Math.max(1, Math.round(hours * 60 / barMinutes))
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0
  const avg = mean(values)
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length)
}

function percentile(values: number[], pct: number): number | null {
  const finite = values.filter(isFiniteNumber)
  if (finite.length === 0) return null
  const sorted = [...finite].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * pct)))
  return round(sorted[index], 6)
}

function nullableDelta(left: number | null, right: number | null): number | null {
  return left == null || right == null ? null : round(left - right, 6)
}

function roundFinite(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return value
  return round(value, digits)
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
