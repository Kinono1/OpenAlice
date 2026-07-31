import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateCrossSectionalMomentum } from '../src/domain/strategy/cross-sectional-momentum.js'
import type { CrossSectionalAsset } from '../src/domain/strategy/cross-sectional-momentum.js'
import { analyzeInformationCoefficient, type IcSample } from '../src/domain/strategy/research/ic-analyzer.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import {
  parseCrossSectionalExecutionMode,
  resolveCrossSectionalExecutionShape,
  type CrossSectionalExecutionMode,
} from './lib/cross_sectional_execution_shape.js'
import { defaultPaperUniverseSymbols, paperSymbolToCsvFile, type PaperUniverseTimeframe } from './lib/paper_universe.js'

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

interface CliArgs {
  dataDir: string
  outputPath: string | null
  bestConfigPath: string | null
  symbols: string[]
  lookbackHours: number[]
  secondaryLookbackHours: number[]
  forwardHours: number[]
  mtfWeights: number[]
  maxVolPct: number
  minSpreadPct: number
  minUniverseSize: number
  executionMode: CrossSectionalExecutionMode
  barMinutes: number
  maxRows: number | null
  regimeFilter: RegimeFilterSpec | null
  json: boolean
}

interface RankIcConfigSummary {
  lookbackHours: number
  secondaryLookbackHours: number
  forwardHours: number
  lookbackBars: number
  secondaryLookbackBars: number
  forwardBars: number
  mtfWeight: number
  factor: FactorName
  observations: number
  periods: number
  meanIc: number
  icIr: number
  winRate: number
  passed: boolean
  averageLongShortSpreadPct: number | null
  longShortWinRate: number | null
  signalPeriods: number
  regimePeriodsEvaluated: number
  retainedRegimePeriods: number
  retainedRegimePct: number | null
}

interface RegimeFilterSpec {
  id: string
  minMedianReturnPct: number | null
  maxMedianReturnPct: number | null
  minBreadthPositivePct: number | null
  maxDispersionPct: number | null
  maxAverageVolPct: number | null
  source: 'cli_thresholds'
}

interface RankIcWfoWindow {
  windowIndex: number
  startTime: string
  endTime: string
  startIndex: number
  endIndexExclusive: number
  observations: number
  periods: number
  meanIc: number
  icIr: number
  winRate: number
  averageLongShortSpreadPct: number | null
  longShortWinRate: number | null
  signalPeriods: number
  passed: boolean
}

interface RankIcWfoReport {
  status: 'pass' | 'fail' | 'insufficient_data'
  testedConfig: RankIcConfigSummary | null
  selectionSource: 'best_config_match' | 'rank_ic_best' | 'missing'
  windowCount: number
  passedWindows: number
  failedWindows: number
  failedWindowRatio: number | null
  failWindowRatioThreshold: number
  minWindows: number
  minTotalPeriods: number
  minTotalSignalPeriods: number
  minPeriodsPerWindow: number
  minSignalPeriodsPerWindow: number
  directionStable: boolean
  windows: RankIcWfoWindow[]
  blockers: string[]
}

export interface CrossSectionalRankIcReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  dataDir: string
  symbolsRequested: string[]
  symbolsLoaded: string[]
  commonPeriods: number
  executionShape: {
    mode: CrossSectionalExecutionMode
    topN: number
    bottomN: number
    minUniverseSizePolicy: 'paper_half_universe_min_2' | 'legacy_thirds_cli_min'
    effectiveMinUniverseSizeAtFullUniverse: number
  }
  dataCadence: {
    barMinutes: number
    promotionTimeframe: '1h_required'
    nonHourlyDiagnosticOnly: boolean
    lookbackUnit: 'hours'
    barConversion: Array<{ hours: number; bars: number }>
  }
  regimeFilter: {
    enabled: boolean
    diagnosticOnly: boolean
    spec: RegimeFilterSpec | null
    policy: 'decision_time_observables_only'
    retainedRegimePeriods: number | null
    regimePeriodsEvaluated: number | null
    retainedRegimePct: number | null
  }
  configsEvaluated: number
  best: RankIcConfigSummary | null
  wfo: RankIcWfoReport
  bestByFactor: Array<{ factor: FactorName; best: RankIcConfigSummary | null }>
  topConfigs: RankIcConfigSummary[]
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/research/cross_sectional_rank_ic.latest.json'
const WFO_FAIL_WINDOW_RATIO_THRESHOLD = 0.3
const WFO_MIN_WINDOWS = 3
const WFO_MIN_TOTAL_PERIODS = 30
const WFO_MIN_TOTAL_SIGNAL_PERIODS = 30
const WFO_MIN_PERIODS_PER_WINDOW = 3
const WFO_MIN_SIGNAL_PERIODS_PER_WINDOW = 3
const FACTORS: FactorName[] = [
  'raw_reversal',
  'risk_adjusted_reversal',
  'rank_reversal',
  'signal_confidence',
]

async function main(): Promise<void> {
  const args = parseCrossSectionalRankIcArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runCrossSectionalRankIcReport(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'cross_sectional_rank_ic_report',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.best?.passed === true ? 'warn' : 'fail',
      recordsIn: report.symbolsLoaded.length,
      recordsOut: report.configsEvaluated,
      errorClass: report.best?.passed === true ? null : 'cross_sectional_rank_ic_not_passed',
    })
  }
}

export function parseCrossSectionalRankIcArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    dataDir: raw.get('dataDir') ?? join(import.meta.dirname, '..', 'data', 'market', 'multi_assets'),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    bestConfigPath: parseNullablePath(raw.get('bestConfigPath') ?? raw.get('bestConfig')),
    symbols: parseSymbols(raw.get('symbols')),
    lookbackHours: parseNumberList(raw.get('lookbackHours') ?? raw.get('lookbacks'), [120, 168, 240, 336]),
    secondaryLookbackHours: parseNumberList(raw.get('secondaryLookbackHours') ?? raw.get('secondaryLookbacks'), [336, 504, 720]),
    forwardHours: parseNumberList(raw.get('forwardHours') ?? raw.get('forwards'), [12, 24, 48]),
    mtfWeights: parseNumberList(raw.get('mtfWeights') ?? raw.get('mtfWeight'), [0, 0.15, 0.25, 0.5]),
    maxVolPct: parseFiniteNumber(raw.get('maxVolPct'), 90, 'maxVolPct'),
    minSpreadPct: parseFiniteNumber(raw.get('minSpreadPct'), 0, 'minSpreadPct'),
    minUniverseSize: parsePositiveInteger(raw.get('minUniverseSize'), 6, 'minUniverseSize'),
    executionMode: parseCrossSectionalExecutionMode(raw.get('executionMode'), 'paper'),
    barMinutes: parsePositiveInteger(raw.get('barMinutes'), 60, 'barMinutes'),
    maxRows: parseNullablePositiveInteger(raw.get('maxRows'), null, 'maxRows'),
    regimeFilter: parseRegimeFilterSpec(raw),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runCrossSectionalRankIcReport(
  args: CliArgs,
): Promise<CrossSectionalRankIcReport> {
  const normalizedArgs = normalizeRankIcArgs(args)
  const assets = await loadAssets(
    resolve(normalizedArgs.dataDir),
    normalizedArgs.symbols,
    normalizedArgs.maxRows,
    timeframeForBarMinutes(normalizedArgs.barMinutes),
  )
  const report = buildCrossSectionalRankIcReport({
    args: normalizedArgs,
    assets,
    preferredConfig: await loadPreferredConfig(normalizedArgs.bestConfigPath),
    generatedAt: new Date().toISOString(),
  })

  if (normalizedArgs.outputPath) {
    const outputPath = resolve(normalizedArgs.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildCrossSectionalRankIcReport(input: {
  args: CliArgs
  assets: AssetSeries[]
  preferredConfig?: PreferredRankIcConfig | null
  generatedAt?: string
}): CrossSectionalRankIcReport {
  const preferredConfig = input.preferredConfig ?? null
  const effectiveArgs = applyPreferredFilterOverrides(normalizeRankIcArgs(input.args), preferredConfig)
  const commonPeriods = input.assets.length > 0
    ? Math.min(...input.assets.map(asset => asset.candles.length))
    : 0
  const fullUniverseShape = resolveCrossSectionalExecutionShape(input.assets.length, {
    mode: effectiveArgs.executionMode,
    minUniverseSizeOverride: effectiveArgs.minUniverseSize,
  })
  const runtimeStatsBySymbol = buildRuntimeStatsBySymbol(input.assets, effectiveArgs.barMinutes)
  const barConversion = buildBarConversion(effectiveArgs)
  const rows: RankIcConfigSummary[] = []

  for (const lookbackHours of effectiveArgs.lookbackHours) {
    for (const secondaryLookbackHours of effectiveArgs.secondaryLookbackHours) {
      if (secondaryLookbackHours < lookbackHours) continue
      for (const forwardHours of effectiveArgs.forwardHours) {
        for (const mtfWeight of effectiveArgs.mtfWeights) {
          const summaries = evaluateRankIcConfig({
            assets: input.assets,
            lookbackHours,
            secondaryLookbackHours,
            forwardHours,
            mtfWeight,
            maxVolPct: effectiveArgs.maxVolPct,
            minSpreadPct: effectiveArgs.minSpreadPct,
            minUniverseSize: effectiveArgs.minUniverseSize,
            executionMode: effectiveArgs.executionMode,
            barMinutes: effectiveArgs.barMinutes,
            runtimeStatsBySymbol,
            regimeFilter: effectiveArgs.regimeFilter,
          })
          rows.push(...summaries)
        }
      }
    }
  }

  const sorted = rows.sort((left, right) =>
    Number(right.passed) - Number(left.passed) ||
    right.meanIc - left.meanIc ||
    right.icIr - left.icIr ||
    right.observations - left.observations,
  )
  const best = sorted[0] ?? null
  const preferredWfoConfig = findPreferredRankIcConfig(sorted, preferredConfig)
  const wfoConfig = preferredWfoConfig ?? best
  const wfo = buildRankIcWfoReport({
    assets: input.assets,
    commonPeriods,
    config: wfoConfig,
    selectionSource: preferredWfoConfig ? 'best_config_match' : best ? 'rank_ic_best' : 'missing',
    maxVolPct: effectiveArgs.maxVolPct,
    minSpreadPct: effectiveArgs.minSpreadPct,
    minUniverseSize: effectiveArgs.minUniverseSize,
    executionMode: effectiveArgs.executionMode,
    barMinutes: effectiveArgs.barMinutes,
    runtimeStatsBySymbol,
    regimeFilter: effectiveArgs.regimeFilter,
  })
  const blockers = buildBlockers(input.assets, commonPeriods, best, wfo, effectiveArgs.barMinutes, effectiveArgs.regimeFilter)

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    dataDir: resolve(effectiveArgs.dataDir),
    symbolsRequested: effectiveArgs.symbols,
    symbolsLoaded: input.assets.map(asset => asset.symbol),
    commonPeriods,
    executionShape: {
      mode: effectiveArgs.executionMode,
      topN: fullUniverseShape.topN,
      bottomN: fullUniverseShape.bottomN,
      minUniverseSizePolicy: effectiveArgs.executionMode === 'paper'
        ? 'paper_half_universe_min_2'
        : 'legacy_thirds_cli_min',
      effectiveMinUniverseSizeAtFullUniverse: fullUniverseShape.minUniverseSize,
    },
    dataCadence: {
      barMinutes: effectiveArgs.barMinutes,
      promotionTimeframe: '1h_required',
      nonHourlyDiagnosticOnly: effectiveArgs.barMinutes !== 60,
      lookbackUnit: 'hours',
      barConversion,
    },
    regimeFilter: {
      enabled: effectiveArgs.regimeFilter !== null,
      diagnosticOnly: true,
      spec: effectiveArgs.regimeFilter,
      policy: 'decision_time_observables_only',
      retainedRegimePeriods: best?.retainedRegimePeriods ?? null,
      regimePeriodsEvaluated: best?.regimePeriodsEvaluated ?? null,
      retainedRegimePct: best?.retainedRegimePct ?? null,
    },
    configsEvaluated: rows.length,
    best,
    wfo,
    bestByFactor: FACTORS.map(factor => ({
      factor,
      best: sorted.find(row => row.factor === factor) ?? null,
    })),
    topConfigs: sorted.slice(0, 20),
    blockers,
    nextActions: buildNextActions(best, blockers),
    notes: [
      'This is a research-only cross-sectional RankIC report; it cannot authorize paper or live execution.',
      'Positive RankIC only means the score has cross-asset predictive ordering in this sample. It still needs WFO, complete trial ledger, BY FDR, PIT rows, and route-cost economics.',
      'The WFO section is an internal stability diagnostic, not promotion-grade WFO evidence.',
      'The report intentionally measures cross-sectional IC across symbols at each timestamp, not per-symbol time-series IC.',
      ...(effectiveArgs.barMinutes === 60
        ? []
        : ['Non-1h cadence is an acceleration diagnostic only and cannot satisfy 1h promotion requirements.']),
    ],
  }
}

function normalizeRankIcArgs(args: CliArgs): CliArgs {
  return {
    ...args,
    barMinutes: normalizeBarMinutes(args.barMinutes),
  }
}

function normalizeBarMinutes(raw: number | undefined): number {
  if (raw == null) return 60
  if (!Number.isInteger(raw) || raw <= 0) throw new Error('barMinutes must be a positive integer.')
  return raw
}

function evaluateRankIcConfig(input: {
  assets: AssetSeries[]
  lookbackHours: number
  secondaryLookbackHours: number
  forwardHours: number
  mtfWeight: number
  maxVolPct: number
  minSpreadPct: number
  minUniverseSize: number
  executionMode: CrossSectionalExecutionMode
  barMinutes: number
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  regimeFilter: RegimeFilterSpec | null
  startIndex?: number
  endIndexExclusive?: number
}): RankIcConfigSummary[] {
  const sampleMap = new Map<FactorName, IcSample[]>()
  for (const factor of FACTORS) sampleMap.set(factor, [])
  const signalSpreads: number[] = []
  let signalPeriods = 0
  let regimePeriodsEvaluated = 0
  let retainedRegimePeriods = 0
  const lookbackBars = hoursToBars(input.lookbackHours, input.barMinutes)
  const secondaryLookbackBars = hoursToBars(input.secondaryLookbackHours, input.barMinutes)
  const forwardBars = hoursToBars(input.forwardHours, input.barMinutes)
  const minBars = Math.max(lookbackBars, secondaryLookbackBars, forwardBars) + 2
  const naturalStart = minBars
  const commonLength = input.assets.length > 0
    ? Math.min(...input.assets.map(asset => asset.candles.length))
    : 0
  const naturalEnd = commonLength - forwardBars
  const startIndex = Math.max(naturalStart, input.startIndex ?? naturalStart)
  const maxI = Math.min(naturalEnd, input.endIndexExclusive ?? naturalEnd)

  for (let index = startIndex; index < maxI; index++) {
    const assetsAtTime = buildAssetsAtTime({
      assets: input.assets,
      index,
      runtimeStatsBySymbol: input.runtimeStatsBySymbol,
      lookbackHours: input.lookbackHours,
      secondaryLookbackHours: input.secondaryLookbackHours,
      forwardHours: input.forwardHours,
      lookbackBars,
      secondaryLookbackBars,
      forwardBars,
    })
    const shape = resolveCrossSectionalExecutionShape(assetsAtTime.length, {
      mode: input.executionMode,
      minUniverseSizeOverride: input.minUniverseSize,
    })
    if (assetsAtTime.length < shape.minUniverseSize) continue
    const regime = buildDecisionTimeRegimeStats(assetsAtTime, input.lookbackHours)
    if (regime) {
      regimePeriodsEvaluated += 1
      if (input.regimeFilter && !regimeFilterAllows(input.regimeFilter, regime)) continue
      retainedRegimePeriods += 1
    } else if (input.regimeFilter) {
      continue
    }
    const ranks = evaluateCrossSectionalMomentum(assetsAtTime, {
      lookbackHours: input.lookbackHours,
      secondaryLookbackHours: input.secondaryLookbackHours,
      topN: shape.topN,
      bottomN: shape.bottomN,
      minUniverseSize: shape.minUniverseSize,
      maxVolPercentile: input.maxVolPct / 100,
      minSpreadPct: input.minSpreadPct,
      requireVolumeConfirmation: assetsAtTime.length >= 4,
      mtfWeight: input.mtfWeight,
      fundingWeight: 0,
    })
    const rankBySymbol = new Map(ranks.map(rank => [rank.symbol, rank]))
    const assetBySymbol = new Map(assetsAtTime.map(asset => [asset.symbol, asset]))
    const bucketKey = String(assetsAtTime[0]?.currentPrice ? input.assets[0].candles[index].time : index)
    for (const asset of assetsAtTime) {
      const rank = rankBySymbol.get(asset.symbol)
      if (!rank || rank.rank <= 0) continue
      const forwardReturn = asset.returns[`${input.forwardHours}h`]
      if (!Number.isFinite(forwardReturn)) continue
      const rawReturn = asset.returns[`${input.lookbackHours}h`]
      appendSample(sampleMap, 'raw_reversal', -rawReturn, forwardReturn, bucketKey)
      appendSample(sampleMap, 'risk_adjusted_reversal', -rank.riskAdjustedScore, forwardReturn, bucketKey)
      appendSample(sampleMap, 'rank_reversal', assetsAtTime.length + 1 - rank.rank, forwardReturn, bucketKey)
      appendSample(sampleMap, 'signal_confidence', rank.signal * rank.confidence, forwardReturn, bucketKey)
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
        signalSpreads.push(longAsset.returns[`${input.forwardHours}h`] - shortAsset.returns[`${input.forwardHours}h`])
        signalPeriods++
      }
    }
  }

  return FACTORS.map(factor => {
    const summary = analyzeInformationCoefficient(sampleMap.get(factor) ?? [])
    return {
      lookbackHours: input.lookbackHours,
      secondaryLookbackHours: input.secondaryLookbackHours,
      forwardHours: input.forwardHours,
      lookbackBars,
      secondaryLookbackBars,
      forwardBars,
      mtfWeight: input.mtfWeight,
      factor,
      observations: summary.observations,
      periods: summary.periods,
      meanIc: round(summary.meanIc, 6),
      icIr: roundFinite(summary.icIr, 6),
      winRate: round(summary.winRate, 6),
      passed: summary.passed,
      averageLongShortSpreadPct: signalSpreads.length > 0 ? round(mean(signalSpreads), 6) : null,
      longShortWinRate: signalSpreads.length > 0
        ? round(signalSpreads.filter(value => value > 0).length / signalSpreads.length, 6)
        : null,
      signalPeriods,
      regimePeriodsEvaluated,
      retainedRegimePeriods,
      retainedRegimePct: regimePeriodsEvaluated > 0 ? round(retainedRegimePeriods / regimePeriodsEvaluated, 6) : null,
    }
  })
}

function buildRankIcWfoReport(input: {
  assets: AssetSeries[]
  commonPeriods: number
  config: RankIcConfigSummary | null
  selectionSource: RankIcWfoReport['selectionSource']
  maxVolPct: number
  minSpreadPct: number
  minUniverseSize: number
  executionMode: CrossSectionalExecutionMode
  barMinutes: number
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  regimeFilter: RegimeFilterSpec | null
}): RankIcWfoReport {
  const failWindowRatioThreshold = WFO_FAIL_WINDOW_RATIO_THRESHOLD
  const minWindows = WFO_MIN_WINDOWS
  const minTotalPeriods = WFO_MIN_TOTAL_PERIODS
  const minTotalSignalPeriods = WFO_MIN_TOTAL_SIGNAL_PERIODS
  const minPeriodsPerWindow = WFO_MIN_PERIODS_PER_WINDOW
  const minSignalPeriodsPerWindow = WFO_MIN_SIGNAL_PERIODS_PER_WINDOW
  const blockers: string[] = []
  if (!input.config) {
    blockers.push('wfo_config_missing')
    return {
      status: 'insufficient_data',
      testedConfig: null,
      selectionSource: 'missing',
      windowCount: 0,
      passedWindows: 0,
      failedWindows: 0,
      failedWindowRatio: null,
      failWindowRatioThreshold,
      minWindows,
      minTotalPeriods,
      minTotalSignalPeriods,
      minPeriodsPerWindow,
      minSignalPeriodsPerWindow,
      directionStable: false,
      windows: [],
      blockers,
    }
  }

  const minBars = Math.max(
    input.config.lookbackBars,
    input.config.secondaryLookbackBars,
    input.config.forwardBars,
  ) + 2
  const endExclusive = input.commonPeriods - input.config.forwardBars
  const testable = Math.max(0, endExclusive - minBars)
  if (testable <= 0) blockers.push(`wfo_no_testable_periods:${testable}`)
  if (input.config.periods < minTotalPeriods) {
    blockers.push(`wfo_total_periods_low:${input.config.periods}<${minTotalPeriods}`)
  }
  if (input.config.signalPeriods < minTotalSignalPeriods) {
    blockers.push(`wfo_total_signal_periods_low:${input.config.signalPeriods}<${minTotalSignalPeriods}`)
  }

  const desiredWindows = Math.min(5, Math.max(minWindows, Math.floor(testable / Math.max(1, minPeriodsPerWindow))))
  const windows = testable > 0
    ? buildContiguousWindows(minBars, endExclusive, desiredWindows)
      .map((window, windowIndex) => summarizeRankIcWindow({
        assets: input.assets,
        config: input.config!,
        windowIndex,
        startIndex: window.startIndex,
        endIndexExclusive: window.endIndexExclusive,
        maxVolPct: input.maxVolPct,
        minSpreadPct: input.minSpreadPct,
        minUniverseSize: input.minUniverseSize,
        executionMode: input.executionMode,
        barMinutes: input.barMinutes,
        runtimeStatsBySymbol: input.runtimeStatsBySymbol,
        regimeFilter: input.regimeFilter,
      }))
    : []

  if (windows.length < minWindows) blockers.push(`wfo_windows_low:${windows.length}<${minWindows}`)
  for (const window of windows) {
    if (window.periods < minPeriodsPerWindow) {
      blockers.push(`wfo_window_${window.windowIndex}_periods_low:${window.periods}<${minPeriodsPerWindow}`)
    }
    if (window.signalPeriods < minSignalPeriodsPerWindow) {
      blockers.push(`wfo_window_${window.windowIndex}_signal_periods_low:${window.signalPeriods}<${minSignalPeriodsPerWindow}`)
    }
  }
  const failedWindows = windows.filter(window => !window.passed).length
  const passedWindows = windows.length - failedWindows
  const failedWindowRatio = windows.length > 0 ? failedWindows / windows.length : null
  if (failedWindowRatio != null && failedWindowRatio > failWindowRatioThreshold) {
    blockers.push(`wfo_failed_window_ratio:${round(failedWindowRatio, 6)}>${failWindowRatioThreshold}`)
  }
  const directionStable = windows.length >= minWindows && windows.every(window => window.meanIc > 0)
  if (!directionStable) blockers.push('wfo_direction_not_stable')

  const hasInsufficientData = windows.length < minWindows ||
    input.config.periods < minTotalPeriods ||
    input.config.signalPeriods < minTotalSignalPeriods ||
    windows.some(window => window.periods < minPeriodsPerWindow || window.signalPeriods < minSignalPeriodsPerWindow)
  const status = blockers.length > 0
    ? hasInsufficientData
      ? 'insufficient_data'
      : 'fail'
    : 'pass'
  return {
    status,
    testedConfig: input.config,
    selectionSource: input.selectionSource,
    windowCount: windows.length,
    passedWindows,
    failedWindows,
    failedWindowRatio,
    failWindowRatioThreshold,
    minWindows,
    minTotalPeriods,
    minTotalSignalPeriods,
    minPeriodsPerWindow,
    minSignalPeriodsPerWindow,
    directionStable,
    windows,
    blockers: uniqueStrings(blockers),
  }
}

interface PreferredRankIcConfig {
  lookbackHours: number | null
  secondaryLookbackHours: number | null
  forwardHours: number | null
  mtfWeight: number | null
  minSpreadPct: number | null
  maxVolPct: number | null
}

async function loadPreferredConfig(path: string | null): Promise<PreferredRankIcConfig | null> {
  if (!path) return null
  const resolved = resolve(path)
  if (!existsSync(resolved)) return null
  return extractPreferredConfig(asRecord(JSON.parse(await readFile(resolved, 'utf-8'))))
}

export function extractPreferredConfig(root: Record<string, unknown> | null): PreferredRankIcConfig | null {
  if (
    readString(root?.status) === 'no_passing_config' ||
    root?.selectedConfig === false ||
    root?.config === null
  ) {
    return null
  }
  const config = asRecord(root?.config) ?? asRecord(root?.bestConfig)
  if (!config) return null
  return {
    lookbackHours: readNumber(config.lookbackHours),
    secondaryLookbackHours: readNumber(config.secondaryLookbackHours ?? config.secondaryLookback),
    forwardHours: readNumber(config.forwardHours),
    mtfWeight: readNumber(config.mtfWeight),
    minSpreadPct: readNumber(config.minSpreadPct),
    maxVolPct: readNumber(config.maxVolPct),
  }
}

function applyPreferredFilterOverrides(args: CliArgs, preferred: PreferredRankIcConfig | null): CliArgs {
  return {
    ...args,
    minSpreadPct: preferred?.minSpreadPct ?? args.minSpreadPct,
    maxVolPct: preferred?.maxVolPct ?? args.maxVolPct,
  }
}

function findPreferredRankIcConfig(
  rows: RankIcConfigSummary[],
  preferred: PreferredRankIcConfig | null,
): RankIcConfigSummary | null {
  if (!preferred) return null
  return rows.find(row =>
    numbersMatch(row.lookbackHours, preferred.lookbackHours) &&
    numbersMatch(row.secondaryLookbackHours, preferred.secondaryLookbackHours) &&
    numbersMatch(row.forwardHours, preferred.forwardHours) &&
    numbersMatch(row.mtfWeight, preferred.mtfWeight),
  ) ?? null
}

function numbersMatch(left: number | null, right: number | null): boolean {
  return left != null && right != null && Math.abs(left - right) <= 1e-9
}

function buildContiguousWindows(
  startIndex: number,
  endIndexExclusive: number,
  windowCount: number,
): Array<{ startIndex: number; endIndexExclusive: number }> {
  const total = Math.max(0, endIndexExclusive - startIndex)
  if (total <= 0 || windowCount <= 0) return []
  const actualCount = Math.min(windowCount, total)
  return Array.from({ length: actualCount }, (_, index) => {
    const start = startIndex + Math.floor(index * total / actualCount)
    const end = startIndex + Math.floor((index + 1) * total / actualCount)
    return {
      startIndex: start,
      endIndexExclusive: Math.max(start + 1, end),
    }
  })
}

function summarizeRankIcWindow(input: {
  assets: AssetSeries[]
  config: RankIcConfigSummary
  windowIndex: number
  startIndex: number
  endIndexExclusive: number
  maxVolPct: number
  minSpreadPct: number
  minUniverseSize: number
  executionMode: CrossSectionalExecutionMode
  barMinutes: number
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  regimeFilter: RegimeFilterSpec | null
}): RankIcWfoWindow {
  const summaries = evaluateRankIcConfig({
    assets: input.assets,
    lookbackHours: input.config.lookbackHours,
    secondaryLookbackHours: input.config.secondaryLookbackHours,
    forwardHours: input.config.forwardHours,
    mtfWeight: input.config.mtfWeight,
    maxVolPct: input.maxVolPct,
    minSpreadPct: input.minSpreadPct,
    minUniverseSize: input.minUniverseSize,
    executionMode: input.executionMode,
    barMinutes: input.barMinutes,
    runtimeStatsBySymbol: input.runtimeStatsBySymbol,
    regimeFilter: input.regimeFilter,
    startIndex: input.startIndex,
    endIndexExclusive: input.endIndexExclusive,
  })
  const summary = summaries.find(item => item.factor === input.config.factor) ?? null
  const start = input.assets[0]?.candles[input.startIndex]?.time
  const end = input.assets[0]?.candles[Math.max(input.startIndex, input.endIndexExclusive - 1)]?.time
  const periods = summary?.periods ?? 0
  const signalPeriods = summary?.signalPeriods ?? 0
  const meanIc = summary?.meanIc ?? 0
  const icIr = summary?.icIr ?? 0
  const winRate = summary?.winRate ?? 0
  const passed = Boolean(summary?.passed) &&
    periods >= WFO_MIN_PERIODS_PER_WINDOW &&
    signalPeriods >= WFO_MIN_SIGNAL_PERIODS_PER_WINDOW
  return {
    windowIndex: input.windowIndex,
    startTime: typeof start === 'number' ? new Date(start).toISOString() : '',
    endTime: typeof end === 'number' ? new Date(end).toISOString() : '',
    startIndex: input.startIndex,
    endIndexExclusive: input.endIndexExclusive,
    observations: summary?.observations ?? 0,
    periods,
    meanIc,
    icIr,
    winRate,
    averageLongShortSpreadPct: summary?.averageLongShortSpreadPct ?? null,
    longShortWinRate: summary?.longShortWinRate ?? null,
    signalPeriods,
    passed,
  }
}

function buildAssetsAtTime(input: {
  assets: AssetSeries[]
  index: number
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  lookbackHours: number
  secondaryLookbackHours: number
  forwardHours: number
  lookbackBars: number
  secondaryLookbackBars: number
  forwardBars: number
}): CrossSectionalAsset[] {
  const out: CrossSectionalAsset[] = []
  for (const asset of input.assets) {
    const current = asset.candles[input.index]
    const primary = asset.candles[input.index - input.lookbackBars]
    const secondary = asset.candles[input.index - input.secondaryLookbackBars]
    const forward = asset.candles[input.index + input.forwardBars]
    if (!current || !primary || !secondary || !forward) continue
    if (current.close <= 0 || primary.close <= 0 || secondary.close <= 0 || forward.close <= 0) continue
    const runtimeStats = input.runtimeStatsBySymbol.get(asset.symbol)?.[input.index]
    out.push({
      symbol: asset.symbol,
      currentPrice: current.close,
      returns: {
        [`${input.lookbackHours}h`]: (current.close / primary.close - 1) * 100,
        [`${input.secondaryLookbackHours}h`]: (current.close / secondary.close - 1) * 100,
        [`${input.forwardHours}h`]: (forward.close / current.close - 1) * 100,
      },
      realizedVolPct: runtimeStats?.realizedVolPct ?? 50,
      avgVolume24h: runtimeStats?.avgVolume24h ?? current.volume,
      dailyVolumeUsd: runtimeStats?.dailyVolumeUsd ?? current.close * current.volume,
    })
  }
  return out
}

function buildDecisionTimeRegimeStats(
  assetsAtTime: CrossSectionalAsset[],
  lookbackHours: number,
): {
  medianReturnPct: number
  breadthPositivePct: number
  dispersionPct: number
  averageVolPct: number
} | null {
  const returnKey = `${lookbackHours}h`
  const returns = assetsAtTime.map(asset => asset.returns[returnKey]).filter(isFiniteNumber)
  const vols = assetsAtTime.map(asset => asset.realizedVolPct).filter(isFiniteNumber)
  if (returns.length < 2 || vols.length === 0) return null
  return {
    medianReturnPct: median(returns),
    breadthPositivePct: returns.filter(value => value > 0).length / returns.length,
    dispersionPct: standardDeviation(returns),
    averageVolPct: mean(vols),
  }
}

function regimeFilterAllows(
  filter: RegimeFilterSpec,
  regime: {
    medianReturnPct: number
    breadthPositivePct: number
    dispersionPct: number
    averageVolPct: number
  },
): boolean {
  if (filter.minMedianReturnPct != null && regime.medianReturnPct < filter.minMedianReturnPct) return false
  if (filter.maxMedianReturnPct != null && regime.medianReturnPct > filter.maxMedianReturnPct) return false
  if (filter.minBreadthPositivePct != null && regime.breadthPositivePct < filter.minBreadthPositivePct) return false
  if (filter.maxDispersionPct != null && regime.dispersionPct > filter.maxDispersionPct) return false
  if (filter.maxAverageVolPct != null && regime.averageVolPct > filter.maxAverageVolPct) return false
  return true
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function appendSample(
  sampleMap: Map<FactorName, IcSample[]>,
  factor: FactorName,
  factorValue: number,
  forwardReturn: number,
  bucketKey: string,
): void {
  if (!Number.isFinite(factorValue) || !Number.isFinite(forwardReturn)) return
  sampleMap.get(factor)?.push({ factorValue, forwardReturn, bucketKey })
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
  return assets
    .filter(asset => asset.candles.length >= minLength && minLength > 0)
    .map(asset => ({
      symbol: asset.symbol,
      candles: asset.candles.slice(asset.candles.length - minLength),
    }))
}

function buildRuntimeStatsBySymbol(
  assets: AssetSeries[],
  barMinutes: number,
): Map<string, AssetRuntimeStats[]> {
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
    const validVolumeUsd = validVolume &&
      Number.isFinite(candle.close) &&
      candle.close > 0
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

function buildBlockers(
  assets: AssetSeries[],
  commonPeriods: number,
  best: RankIcConfigSummary | null,
  wfo: RankIcWfoReport,
  barMinutes: number,
  regimeFilter: RegimeFilterSpec | null,
): string[] {
  const blockers: string[] = []
  if (assets.length < 6) blockers.push(`loaded_universe_too_small:${assets.length}<6`)
  if (commonPeriods < 1_000) blockers.push(`common_periods_low:${commonPeriods}<1000`)
  if (barMinutes !== 60) blockers.push('non_hourly_rank_ic_cadence_research_only')
  if (regimeFilter) blockers.push('regime_filter_in_sample_research_only')
  if (!best) blockers.push('rank_ic_missing')
  if (best && !best.passed) blockers.push('rank_ic_best_config_failed_thresholds')
  blockers.push('not_promotion_grade_wfo_validated')
  if (wfo.status !== 'pass') blockers.push(`rank_ic_wfo_${wfo.status}`)
  blockers.push(...wfo.blockers)
  blockers.push('not_trial_ledger_fdr_validated')
  blockers.push('not_route_cost_validated')
  blockers.push('not_paper_execution_evidence')
  return uniqueStrings(blockers)
}

function buildBarConversion(args: CliArgs): Array<{ hours: number; bars: number }> {
  return Array.from(new Set([
    ...args.lookbackHours,
    ...args.secondaryLookbackHours,
    ...args.forwardHours,
  ]))
    .sort((left, right) => left - right)
    .map(hours => ({
      hours,
      bars: hoursToBars(hours, args.barMinutes),
    }))
}

function hoursToBars(hours: number, barMinutes: number): number {
  const bars = Math.round(hours * 60 / barMinutes)
  if (!Number.isFinite(bars) || bars <= 0) {
    throw new Error(`Invalid bar conversion: hours=${hours}, barMinutes=${barMinutes}`)
  }
  return bars
}

function buildNextActions(best: RankIcConfigSummary | null, blockers: string[]): string[] {
  if (!best) return ['Load more cross-sectional assets, then rerun RankIC.']
  const actions = best.passed
    ? [
        `Promote only to research validation: review RankIC WFO for ${best.factor} with lookback=${best.lookbackHours}h, secondary=${best.secondaryLookbackHours}h, forward=${best.forwardHours}h, mtf=${best.mtfWeight}.`,
        'Add full trial universe and BY FDR before considering paper.',
        'Apply route-cost and turnover constraints before judging monetization.',
      ]
    : [
        'Do not tune execution yet; first mutate cross-sectional score/regime buckets because RankIC did not pass.',
        'Try volatility/dispersion buckets and live-window-sized lookbacks before adding model complexity.',
        'Retire or quarantine cross-sectional if RankIC remains non-positive across two non-overlapping windows.',
      ]
  if (blockers.includes('not_route_cost_validated')) {
    actions.push('Keep paper/live blocked until prospective trades have complete cost and expected-net-edge fields.')
  }
  return actions
}

function renderConsoleSummary(report: CrossSectionalRankIcReport): string {
  const lines = [
    `cross-sectional RankIC: symbols=${report.symbolsLoaded.length}/${report.symbolsRequested.length}, periods=${report.commonPeriods}, configs=${report.configsEvaluated}`,
    `best=${report.best ? `${report.best.factor} meanIc=${report.best.meanIc} icIr=${report.best.icIr} winRate=${report.best.winRate} passed=${report.best.passed}` : 'none'}`,
    `blockers=${report.blockers.join('|')}`,
    'top:',
  ]
  for (const row of report.topConfigs.slice(0, 8)) {
    lines.push([
      row.factor,
      `lb=${row.lookbackHours}`,
      `sec=${row.secondaryLookbackHours}`,
      `fwd=${row.forwardHours}`,
      `mtf=${row.mtfWeight}`,
      `ic=${row.meanIc}`,
      `ir=${row.icIr}`,
      `wr=${row.winRate}`,
      `spread=${row.averageLongShortSpreadPct}`,
      `retain=${row.retainedRegimePct}`,
      `pass=${row.passed}`,
    ].join(' | '))
  }
  return lines.join('\n')
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const tokens = argv.filter(token => token !== '--')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token?.startsWith('--')) continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      out.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = tokens[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(body, next)
      index += 1
    } else {
      out.set(body, 'true')
    }
  }
  return out
}

function parseSymbols(raw: string | undefined): string[] {
  const symbols = (raw ?? defaultPaperUniverseSymbols().join(','))
    .split(',')
    .map(symbol => symbol.trim())
    .filter(Boolean)
  return Array.from(new Set(symbols))
}

function parseNumberList(raw: string | undefined, fallback: number[]): number[] {
  if (raw == null) return fallback
  const values = raw.split(',').map(value => Number(value.trim())).filter(Number.isFinite)
  return values.length > 0 ? Array.from(new Set(values)) : fallback
}

function parseRegimeFilterSpec(raw: Map<string, string>): RegimeFilterSpec | null {
  const id = raw.get('regimeFilterId') ?? raw.get('filterId') ?? null
  const minMedianReturnPct = parseNullableFiniteNumber(raw.get('regimeMinMedianReturnPct'), null, 'regimeMinMedianReturnPct')
  const maxMedianReturnPct = parseNullableFiniteNumber(raw.get('regimeMaxMedianReturnPct'), null, 'regimeMaxMedianReturnPct')
  const minBreadthPositivePct = parseNullableFiniteNumber(raw.get('regimeMinBreadthPositivePct'), null, 'regimeMinBreadthPositivePct')
  const maxDispersionPct = parseNullableFiniteNumber(raw.get('regimeMaxDispersionPct'), null, 'regimeMaxDispersionPct')
  const maxAverageVolPct = parseNullableFiniteNumber(raw.get('regimeMaxAverageVolPct'), null, 'regimeMaxAverageVolPct')
  const hasThreshold = [
    minMedianReturnPct,
    maxMedianReturnPct,
    minBreadthPositivePct,
    maxDispersionPct,
    maxAverageVolPct,
  ].some(value => value != null)
  if (!id && !hasThreshold) return null
  if (!hasThreshold) throw new Error('regime filter requires at least one threshold.')
  return {
    id: id ?? 'cli_regime_filter',
    minMedianReturnPct,
    maxMedianReturnPct,
    minBreadthPositivePct,
    maxDispersionPct,
    maxAverageVolPct,
    source: 'cli_thresholds',
  }
}

function parseNullablePath(raw: string | undefined): string | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  return !normalized || normalized === 'null' || normalized === 'false' || normalized === 'none'
    ? null
    : raw
}

function parseNullablePositiveInteger(raw: string | undefined, fallback: number | null, field: string): number | null {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (!normalized || normalized === 'null' || normalized === 'none') return null
  return parsePositiveInteger(raw, fallback ?? 1, field)
}

function parsePositiveInteger(raw: string | undefined, fallback: number, field: string): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer.`)
  return value
}

function parseFiniteNumber(raw: string | undefined, fallback: number, field: string): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite.`)
  return value
}

function parseNullableFiniteNumber(raw: string | undefined, fallback: number | null, field: string): number | null {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (!normalized || normalized === 'null' || normalized === 'none' || normalized === 'false') return null
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite.`)
  return value
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function standardDeviation(values: number[]): number {
  if (values.length <= 1) return 0
  const average = mean(values)
  const variance = mean(values.map(value => (value - average) ** 2))
  return Math.sqrt(variance)
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function roundFinite(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value
  return round(value, digits)
}

export function hashRankIcConfig(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_cross_sectional_rank_ic_report failed:', error)
    process.exit(1)
  })
}
