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

interface RegimeObservation {
  index: number
  time: string
  medianReturnPct: number
  breadthPositivePct: number
  dispersionPct: number
  averageVolPct: number
  btcReturnPct: number | null
  ethReturnPct: number | null
}

interface RegimeFilterCandidate {
  id: string
  description: string
  thresholds: {
    minMedianReturnPct?: number
    maxMedianReturnPct?: number
    minBreadthPositivePct?: number
    maxDispersionPct?: number
    maxAverageVolPct?: number
  }
  generatedFrom: 'baseline' | 'in_sample_regime_quantile'
}

interface FilteredRankIcSummary {
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

interface FilteredWfoWindow extends FilteredRankIcSummary {
  windowIndex: number
  startTime: string
  endTime: string
  startIndex: number
  endIndexExclusive: number
}

interface FilteredWfoReport {
  status: 'pass' | 'fail' | 'insufficient_data'
  windowCount: number
  passedWindows: number
  failedWindows: number
  failedWindowRatio: number | null
  failWindowRatioThreshold: number
  directionStable: boolean
  windows: FilteredWfoWindow[]
  blockers: string[]
}

export interface RegimeFilterSweepCandidate {
  filter: RegimeFilterCandidate
  summary: FilteredRankIcSummary
  wfo: FilteredWfoReport
  deltaVsBaseline: {
    meanIc: number | null
    icIr: number | null
    winRate: number | null
    averageLongShortSpreadPct: number | null
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

export interface RankIcRegimeFilterSweepReport {
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
  regimeDistribution: {
    observations: number
    quantiles: {
      medianReturnPct: Record<string, number | null>
      breadthPositivePct: Record<string, number | null>
      dispersionPct: Record<string, number | null>
      averageVolPct: Record<string, number | null>
    }
  }
  baseline: RegimeFilterSweepCandidate | null
  bestDiagnosticCandidate: RegimeFilterSweepCandidate | null
  candidates: RegimeFilterSweepCandidate[]
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_RANK_IC_REPORT_PATH = 'data/research/cross_sectional_rank_ic.live_accumulated_fwd72.latest.json'
const DEFAULT_DATA_DIR = 'data/market/live_accumulated'
const DEFAULT_OUTPUT_PATH = 'data/research/rank_ic_regime_filter_sweep.latest.json'
const WFO_FAIL_WINDOW_RATIO_THRESHOLD = 0.3
const WFO_MIN_WINDOWS = 3
const WFO_MIN_TOTAL_PERIODS = 30
const WFO_MIN_TOTAL_SIGNAL_PERIODS = 30
const WFO_MIN_PERIODS_PER_WINDOW = 3
const WFO_MIN_SIGNAL_PERIODS_PER_WINDOW = 3
const MIN_RETAINED_PCT = 0.5

async function main(): Promise<void> {
  const args = parseRankIcRegimeFilterSweepArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runRankIcRegimeFilterSweep(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'rank_ic_regime_filter_sweep',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.bestDiagnosticCandidate?.diagnosticVerdict === 'improved_wfo_candidate' ? 'warn' : 'fail',
      recordsIn: report.symbolsLoaded.length,
      recordsOut: report.candidates.length,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseRankIcRegimeFilterSweepArgs(argv: string[]): CliArgs {
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
    json: parseBool(raw.get('json'), false),
  }
}

export async function runRankIcRegimeFilterSweep(
  args: CliArgs,
): Promise<RankIcRegimeFilterSweepReport> {
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
  const report = buildRankIcRegimeFilterSweepReport({
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

export function buildRankIcRegimeFilterSweepReport(input: {
  rankIcReportPath: string
  rankIcReport: Record<string, unknown> | null
  dataDir: string
  barMinutes: number
  assets: AssetSeries[]
  args: Pick<CliArgs, 'maxVolPct' | 'minSpreadPct' | 'minUniverseSize' | 'executionMode'>
  generatedAt?: string
}): RankIcRegimeFilterSweepReport {
  const root = asRecord(input.rankIcReport)
  const config = extractRankIcConfig(root)
  const loadedCommonPeriods = input.assets.length > 0
    ? Math.min(...input.assets.map(asset => asset.candles.length))
    : 0
  const rankIcCommonPeriods = readNumber(root?.commonPeriods)
  const dataAlignment = buildDataAlignment(rankIcCommonPeriods, loadedCommonPeriods)
  const runtimeStatsBySymbol = buildRuntimeStatsBySymbol(input.assets, input.barMinutes)
  const regimeObservations = config
    ? buildRegimeObservations({
        assets: input.assets,
        config,
        runtimeStatsBySymbol,
        minUniverseSize: input.args.minUniverseSize,
        executionMode: input.args.executionMode,
      })
    : []
  const filters = buildFilterCandidates(regimeObservations)
  const candidates = config
    ? filters.map(filter => evaluateFilterCandidate({
        filter,
        assets: input.assets,
        config,
        rankIcReport: root,
        runtimeStatsBySymbol,
        args: input.args,
        barMinutes: input.barMinutes,
        baseline: null,
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
  const blockers = buildBlockers(root, config, dataAlignment.blockers, bestDiagnosticCandidate)

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    rankIcReportPath: input.rankIcReportPath,
    dataDir: resolve(input.dataDir),
    barMinutes: input.barMinutes,
    symbolsLoaded: input.assets.map(asset => asset.symbol),
    config,
    dataAlignment,
    regimeDistribution: summarizeRegimeDistribution(regimeObservations),
    baseline,
    bestDiagnosticCandidate,
    candidates: sorted,
    blockers,
    nextActions: buildNextActions(bestDiagnosticCandidate),
    notes: [
      'This artifact is a research-only in-sample regime-filter sweep; it cannot authorize paper orders, live orders, promotion, or leverage changes.',
      'Filter thresholds are generated from the current sample distribution and are therefore overfit-risk diagnostics until validated out-of-sample.',
      'Every filter uses only decision-time observable inputs: current cross-sectional lookback returns, realized volatility, and breadth.',
      'Any promising filter must be implemented in the main RankIC/trial pipeline and rerun through WFO, route cost, complete trial ledger, BY FDR, PIT, and paper evidence gates.',
    ],
  }
}

function evaluateFilterCandidate(input: {
  filter: RegimeFilterCandidate
  assets: AssetSeries[]
  config: RankIcConfig
  rankIcReport: Record<string, unknown> | null
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  args: Pick<CliArgs, 'maxVolPct' | 'minSpreadPct' | 'minUniverseSize' | 'executionMode'>
  barMinutes: number
  baseline: RegimeFilterSweepCandidate | null
}): RegimeFilterSweepCandidate {
  const summary = evaluateFilteredRankIc({
    assets: input.assets,
    config: input.config,
    filter: input.filter,
    runtimeStatsBySymbol: input.runtimeStatsBySymbol,
    args: input.args,
  })
  const wfo = buildFilteredWfoReport({
    rankIcReport: input.rankIcReport,
    assets: input.assets,
    config: input.config,
    filter: input.filter,
    runtimeStatsBySymbol: input.runtimeStatsBySymbol,
    args: input.args,
  })
  return {
    filter: input.filter,
    summary,
    wfo,
    deltaVsBaseline: {
      meanIc: null,
      icIr: null,
      winRate: null,
      averageLongShortSpreadPct: null,
      failedWindowRatio: null,
      retainedPct: null,
    },
    diagnosticVerdict: input.filter.id === 'no_filter' ? 'baseline' : 'no_internal_wfo_improvement',
    warnings: buildWarnings(input.filter, summary, wfo),
  }
}

function classifyCandidate(
  candidate: RegimeFilterSweepCandidate,
  baseline: RegimeFilterSweepCandidate,
): RegimeFilterSweepCandidate {
  const delta = {
    meanIc: roundNullable(candidate.summary.meanIc - baseline.summary.meanIc, 6),
    icIr: roundNullable(candidate.summary.icIr - baseline.summary.icIr, 6),
    winRate: roundNullable(candidate.summary.winRate - baseline.summary.winRate, 6),
    averageLongShortSpreadPct: nullableDelta(candidate.summary.averageLongShortSpreadPct, baseline.summary.averageLongShortSpreadPct),
    failedWindowRatio: nullableDelta(candidate.wfo.failedWindowRatio, baseline.wfo.failedWindowRatio),
    retainedPct: nullableDelta(candidate.summary.retainedPct, baseline.summary.retainedPct),
  }
  let diagnosticVerdict: RegimeFilterSweepCandidate['diagnosticVerdict'] = 'no_internal_wfo_improvement'
  const retainedOk = (candidate.summary.retainedPct ?? 0) >= MIN_RETAINED_PCT
  const improvedWfo = candidate.wfo.status === 'pass' ||
    (candidate.wfo.status !== 'insufficient_data' &&
      (candidate.wfo.failedWindowRatio ?? 1) < (baseline.wfo.failedWindowRatio ?? 1) &&
      candidate.wfo.passedWindows >= baseline.wfo.passedWindows)
  const noMajorIcDamage = candidate.summary.icIr >= Math.max(0, baseline.summary.icIr * 0.8) &&
    candidate.summary.meanIc >= Math.max(0, baseline.summary.meanIc * 0.8)
  if (!retainedOk) diagnosticVerdict = 'insufficient_retention'
  else if (improvedWfo && noMajorIcDamage) diagnosticVerdict = 'improved_wfo_candidate'
  else if (
    candidate.summary.icIr < baseline.summary.icIr ||
    (candidate.wfo.failedWindowRatio ?? 1) > (baseline.wfo.failedWindowRatio ?? 1)
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

function evaluateFilteredRankIc(input: {
  assets: AssetSeries[]
  config: RankIcConfig
  filter: RegimeFilterCandidate
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  args: Pick<CliArgs, 'maxVolPct' | 'minSpreadPct' | 'minUniverseSize' | 'executionMode'>
  startIndex?: number
  endIndexExclusive?: number
}): FilteredRankIcSummary {
  const samples: IcSample[] = []
  const signalSpreads: number[] = []
  let signalPeriods = 0
  let regimePeriodsEvaluated = 0
  let retainedRegimePeriods = 0
  const commonLength = input.assets.length > 0
    ? Math.min(...input.assets.map(asset => asset.candles.length))
    : 0
  const minBars = Math.max(input.config.lookbackBars, input.config.secondaryLookbackBars, input.config.forwardBars) + 2
  const naturalEnd = commonLength - input.config.forwardBars
  const startIndex = Math.max(minBars, input.startIndex ?? minBars)
  const endIndexExclusive = Math.min(naturalEnd, input.endIndexExclusive ?? naturalEnd)

  for (let index = startIndex; index < endIndexExclusive; index += 1) {
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

function buildFilteredWfoReport(input: {
  rankIcReport: Record<string, unknown> | null
  assets: AssetSeries[]
  config: RankIcConfig
  filter: RegimeFilterCandidate
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  args: Pick<CliArgs, 'maxVolPct' | 'minSpreadPct' | 'minUniverseSize' | 'executionMode'>
}): FilteredWfoReport {
  const rawWindows = readWfoWindows(asRecord(asRecord(input.rankIcReport)?.wfo))
  const windows = rawWindows.map(window => {
    const summary = evaluateFilteredRankIc({
      assets: input.assets,
      config: input.config,
      filter: input.filter,
      runtimeStatsBySymbol: input.runtimeStatsBySymbol,
      args: input.args,
      startIndex: window.startIndex,
      endIndexExclusive: window.endIndexExclusive,
    })
    return {
      ...summary,
      windowIndex: window.windowIndex,
      startTime: window.startTime,
      endTime: window.endTime,
      startIndex: window.startIndex,
      endIndexExclusive: window.endIndexExclusive,
    }
  })
  const blockers: string[] = []
  if (windows.length < WFO_MIN_WINDOWS) blockers.push(`wfo_windows_low:${windows.length}<${WFO_MIN_WINDOWS}`)
  const totalPeriods = windows.reduce((sum, window) => sum + window.periods, 0)
  const totalSignalPeriods = windows.reduce((sum, window) => sum + window.signalPeriods, 0)
  if (totalPeriods < WFO_MIN_TOTAL_PERIODS) blockers.push(`wfo_total_periods_low:${totalPeriods}<${WFO_MIN_TOTAL_PERIODS}`)
  if (totalSignalPeriods < WFO_MIN_TOTAL_SIGNAL_PERIODS) blockers.push(`wfo_total_signal_periods_low:${totalSignalPeriods}<${WFO_MIN_TOTAL_SIGNAL_PERIODS}`)
  for (const window of windows) {
    if (window.periods < WFO_MIN_PERIODS_PER_WINDOW) blockers.push(`wfo_window_${window.windowIndex}_periods_low:${window.periods}<${WFO_MIN_PERIODS_PER_WINDOW}`)
    if (window.signalPeriods < WFO_MIN_SIGNAL_PERIODS_PER_WINDOW) blockers.push(`wfo_window_${window.windowIndex}_signal_periods_low:${window.signalPeriods}<${WFO_MIN_SIGNAL_PERIODS_PER_WINDOW}`)
  }
  const failedWindows = windows.filter(window => !window.passed).length
  const passedWindows = windows.length - failedWindows
  const failedWindowRatio = windows.length > 0 ? failedWindows / windows.length : null
  if (failedWindowRatio != null && failedWindowRatio > WFO_FAIL_WINDOW_RATIO_THRESHOLD) {
    blockers.push(`wfo_failed_window_ratio:${round(failedWindowRatio, 6)}>${WFO_FAIL_WINDOW_RATIO_THRESHOLD}`)
  }
  const directionStable = windows.length >= WFO_MIN_WINDOWS && windows.every(window => window.meanIc > 0)
  if (!directionStable) blockers.push('wfo_direction_not_stable')
  const insufficientData = blockers.some(blocker =>
    blocker.includes('_low:') || blocker === 'wfo_direction_not_stable' && windows.length < WFO_MIN_WINDOWS,
  )
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
  config: RankIcConfig
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  minUniverseSize: number
  executionMode: CrossSectionalExecutionMode
}): RegimeObservation[] {
  const out: RegimeObservation[] = []
  const commonLength = input.assets.length > 0
    ? Math.min(...input.assets.map(asset => asset.candles.length))
    : 0
  const minBars = Math.max(input.config.lookbackBars, input.config.secondaryLookbackBars, input.config.forwardBars) + 2
  const naturalEnd = commonLength - input.config.forwardBars
  for (let index = minBars; index < naturalEnd; index += 1) {
    const assetsAtTime = buildAssetsAtTime({
      assets: input.assets,
      index,
      runtimeStatsBySymbol: input.runtimeStatsBySymbol,
      config: input.config,
    })
    const shape = resolveCrossSectionalExecutionShape(assetsAtTime.length, {
      mode: input.executionMode,
      minUniverseSizeOverride: input.minUniverseSize,
    })
    if (assetsAtTime.length < shape.minUniverseSize) continue
    const observation = buildRegimeObservation(index, input.assets[0]?.candles[index]?.time, assetsAtTime)
    if (observation) out.push(observation)
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
    btcReturnPct: assetsAtTime.find(asset => asset.symbol === 'BTC-USDT')?.returns[primaryKey] ?? null,
    ethReturnPct: assetsAtTime.find(asset => asset.symbol === 'ETH-USDT')?.returns[primaryKey] ?? null,
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
  const medianReturns = observations.map(obs => obs.medianReturnPct)
  const breadth = observations.map(obs => obs.breadthPositivePct)
  const dispersion = observations.map(obs => obs.dispersionPct)
  const vol = observations.map(obs => obs.averageVolPct)
  const p25Median = percentile(medianReturns, 0.25)
  const p33Median = percentile(medianReturns, 0.33)
  const p85Median = percentile(medianReturns, 0.85)
  const p25Breadth = percentile(breadth, 0.25)
  const p67Dispersion = percentile(dispersion, 0.67)
  const p75Dispersion = percentile(dispersion, 0.75)
  const p67Vol = percentile(vol, 0.67)
  const p75Vol = percentile(vol, 0.75)

  pushFilter(filters, 'median_return_gte_p25', 'Keep regimes with median lookback return above the in-sample 25th percentile.', {
    minMedianReturnPct: p25Median,
  })
  pushFilter(filters, 'median_return_gte_p33', 'Keep regimes with median lookback return above the in-sample 33rd percentile.', {
    minMedianReturnPct: p33Median,
  })
  pushFilter(filters, 'median_return_between_p25_p85', 'Keep regimes that are not the weakest or strongest median-return tails.', {
    minMedianReturnPct: p25Median,
    maxMedianReturnPct: p85Median,
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
  pushFilter(filters, 'vol_lte_p67', 'Skip the highest average realized volatility regimes.', {
    maxAverageVolPct: p67Vol,
  })
  pushFilter(filters, 'vol_lte_p75', 'Skip only the highest quartile of average realized volatility regimes.', {
    maxAverageVolPct: p75Vol,
  })
  pushFilter(filters, 'median_gte_p25_dispersion_lte_p75', 'Keep non-crash median-return regimes while skipping only extreme dispersion.', {
    minMedianReturnPct: p25Median,
    maxDispersionPct: p75Dispersion,
  })
  pushFilter(filters, 'breadth_gte_p25_dispersion_lte_p75', 'Keep broad enough markets while skipping only extreme dispersion.', {
    minBreadthPositivePct: p25Breadth,
    maxDispersionPct: p75Dispersion,
  })
  pushFilter(filters, 'dispersion_lte_p75_vol_lte_p75', 'Skip the noisiest dispersion and volatility quartiles.', {
    maxDispersionPct: p75Dispersion,
    maxAverageVolPct: p75Vol,
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
  const t = filter.thresholds
  if (t.minMedianReturnPct != null && observation.medianReturnPct < t.minMedianReturnPct) return false
  if (t.maxMedianReturnPct != null && observation.medianReturnPct > t.maxMedianReturnPct) return false
  if (t.minBreadthPositivePct != null && observation.breadthPositivePct < t.minBreadthPositivePct) return false
  if (t.maxDispersionPct != null && observation.dispersionPct > t.maxDispersionPct) return false
  if (t.maxAverageVolPct != null && observation.averageVolPct > t.maxAverageVolPct) return false
  return true
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

function buildWarnings(
  filter: RegimeFilterCandidate,
  summary: FilteredRankIcSummary,
  wfo: FilteredWfoReport,
): string[] {
  const warnings: string[] = []
  if (filter.generatedFrom === 'in_sample_regime_quantile') warnings.push('filter_thresholds_fit_in_sample')
  if ((summary.retainedPct ?? 0) < MIN_RETAINED_PCT) warnings.push(`retention_below_${MIN_RETAINED_PCT}`)
  if (wfo.status !== 'pass') warnings.push(`internal_wfo_${wfo.status}`)
  return warnings
}

function compareCandidates(left: RegimeFilterSweepCandidate, right: RegimeFilterSweepCandidate): number {
  return verdictRank(right.diagnosticVerdict) - verdictRank(left.diagnosticVerdict) ||
    Number(right.wfo.status === 'pass') - Number(left.wfo.status === 'pass') ||
    (left.wfo.failedWindowRatio ?? 1) - (right.wfo.failedWindowRatio ?? 1) ||
    right.summary.icIr - left.summary.icIr ||
    right.summary.meanIc - left.summary.meanIc ||
    (right.summary.averageLongShortSpreadPct ?? Number.NEGATIVE_INFINITY) -
      (left.summary.averageLongShortSpreadPct ?? Number.NEGATIVE_INFINITY) ||
    right.summary.retainedRegimePeriods - left.summary.retainedRegimePeriods
}

function verdictRank(verdict: RegimeFilterSweepCandidate['diagnosticVerdict']): number {
  if (verdict === 'improved_wfo_candidate') return 4
  if (verdict === 'baseline') return 3
  if (verdict === 'no_internal_wfo_improvement') return 2
  if (verdict === 'weaker_than_baseline') return 1
  return 0
}

function summarizeRegimeDistribution(observations: RegimeObservation[]): RankIcRegimeFilterSweepReport['regimeDistribution'] {
  return {
    observations: observations.length,
    quantiles: {
      medianReturnPct: quantileMap(observations.map(obs => obs.medianReturnPct)),
      breadthPositivePct: quantileMap(observations.map(obs => obs.breadthPositivePct)),
      dispersionPct: quantileMap(observations.map(obs => obs.dispersionPct)),
      averageVolPct: quantileMap(observations.map(obs => obs.averageVolPct)),
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
    p85: percentile(values, 0.85),
    p90: percentile(values, 0.9),
  }
}

function readWfoWindows(wfo: Record<string, unknown> | null): Array<{
  windowIndex: number
  startTime: string
  endTime: string
  startIndex: number
  endIndexExclusive: number
}> {
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

function buildDataAlignment(
  rankIcCommonPeriods: number | null,
  loadedCommonPeriods: number,
): RankIcRegimeFilterSweepReport['dataAlignment'] {
  const blockers: string[] = []
  let alignmentStatus: RankIcRegimeFilterSweepReport['dataAlignment']['alignmentStatus'] = 'aligned'
  if (loadedCommonPeriods <= 0) {
    alignmentStatus = 'no_assets'
    blockers.push('regime_filter_no_assets_loaded')
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

function buildBlockers(
  rankIcReport: Record<string, unknown> | null,
  config: RankIcConfig | null,
  dataAlignmentBlockers: string[],
  bestDiagnosticCandidate: RegimeFilterSweepCandidate | null,
): string[] {
  const blockers = [
    'research_only_not_promotion_evidence',
    'filter_thresholds_in_sample_overfit_risk',
  ]
  if (!rankIcReport) blockers.push('rank_ic_report_missing_or_invalid')
  if (!config) blockers.push('rank_ic_config_missing')
  blockers.push(...dataAlignmentBlockers)
  if (!bestDiagnosticCandidate) blockers.push('no_improved_wfo_filter_candidate')
  return uniqueStrings(blockers)
}

function buildNextActions(best: RegimeFilterSweepCandidate | null): string[] {
  const actions = [
    'Do not enable paper/live from this artifact; it is an in-sample research sweep only.',
  ]
  if (best) {
    actions.push(`Promising diagnostic filter: ${best.filter.id}; implement only as a research candidate and rerun full fwd24/fwd48/fwd72 RankIC/WFO.`)
    actions.push('Validate the filter on future live-only windows or a complete trial ledger before using it as promotion evidence.')
  } else {
    actions.push('Current simple regime filters did not produce a clean internal WFO improvement; prioritize signal stability or trial-ledger evidence work.')
  }
  actions.push('After any change, rerun route-cost, P1 trial ledger, BY FDR, PIT audit, release gate, and paper execution evidence.')
  return actions
}

function renderConsoleSummary(report: RankIcRegimeFilterSweepReport): string {
  const top = report.candidates.slice(0, 8)
  const lines = [
    `rank ic regime filter sweep: candidates=${report.candidates.length}, best=${report.bestDiagnosticCandidate?.filter.id ?? 'none'}`,
    `config=${report.config ? `${report.config.factor}_lb${report.config.lookbackHours}_sec${report.config.secondaryLookbackHours}_fwd${report.config.forwardHours}_mtf${report.config.mtfWeight}` : 'missing'}`,
    `regimeObs=${report.regimeDistribution.observations}, blockers=${report.blockers.join('|')}`,
  ]
  for (const row of top) {
    lines.push([
      row.filter.id,
      row.diagnosticVerdict,
      `wfo=${row.wfo.status}`,
      `pass=${row.wfo.passedWindows}/${row.wfo.windowCount}`,
      `failRatio=${row.wfo.failedWindowRatio}`,
      `ic=${row.summary.meanIc}`,
      `ir=${row.summary.icIr}`,
      `spread=${row.summary.averageLongShortSpreadPct}`,
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

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function roundFinite(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return value
  return round(value, digits)
}

function roundNullable(value: number | null, digits: number): number | null {
  return value == null ? null : round(value, digits)
}

function nullableDelta(left: number | null, right: number | null): number | null {
  return left == null || right == null ? null : round(left - right, 6)
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
