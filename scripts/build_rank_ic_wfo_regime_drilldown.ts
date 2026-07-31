import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { defaultPaperUniverseSymbols, paperSymbolToCsvFile, type PaperUniverseTimeframe } from './lib/paper_universe.js'

interface CliArgs {
  rankIcReportPath: string
  dataDir: string
  outputPath: string | null
  symbols: string[]
  barMinutes: number | null
  maxRows: number | null
  json: boolean
}

interface Candle {
  time: number
  close: number
  volume: number
}

export interface WfoDrilldownAssetSeries {
  symbol: string
  candles: Candle[]
}

interface RankIcWfoWindowInput {
  windowIndex: number
  startTime?: string
  endTime?: string
  startIndex: number
  endIndexExclusive: number
  observations?: number
  periods?: number
  meanIc?: number
  icIr?: number
  winRate?: number
  averageLongShortSpreadPct?: number | null
  longShortWinRate?: number | null
  signalPeriods?: number
  passed?: boolean
}

interface RankIcReportInput {
  schemaVersion?: unknown
  generatedAt?: unknown
  dataDir?: unknown
  symbolsLoaded?: unknown
  commonPeriods?: unknown
  dataCadence?: unknown
  best?: unknown
  wfo?: unknown
  blockers?: unknown
}

export interface WfoRegimeWindowDrilldown {
  windowIndex: number
  startTime: string
  endTime: string
  startIndex: number
  endIndexExclusive: number
  passed: boolean
  rankIc: {
    observations: number
    periods: number
    signalPeriods: number
    signalDensity: number | null
    meanIc: number
    icIr: number
    winRate: number
    averageLongShortSpreadPct: number | null
    longShortWinRate: number | null
  }
  regime: {
    assetCount: number
    btcReturnPct: number | null
    ethReturnPct: number | null
    meanReturnPct: number | null
    medianReturnPct: number | null
    breadthPositivePct: number | null
    crossSectionalDispersionPct: number | null
    averageAnnualizedVolPct: number | null
    averageHourlyAbsReturnPct: number | null
    averageDailyDollarVolume: number | null
    volumeRatioVsPriorWindow: number | null
    returnBucket: 'up' | 'down' | 'flat' | 'unknown'
    dispersionBucket: 'high' | 'normal' | 'low' | 'unknown'
    volatilityBucket: 'high' | 'normal' | 'low' | 'unknown'
  }
  failureTags: string[]
  interpretation: string
}

export interface RankIcWfoRegimeDrilldownReport {
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
  rankIcCandidate: {
    factor: string | null
    lookbackHours: number | null
    secondaryLookbackHours: number | null
    forwardHours: number | null
    mtfWeight: number | null
    wfoStatus: string | null
    wfoBlockers: string[]
  }
  dataAlignment: {
    rankIcCommonPeriods: number | null
    loadedCommonPeriods: number
    alignmentStatus: 'aligned' | 'mismatch' | 'missing_rank_ic_common_periods' | 'no_assets'
    blockers: string[]
  }
  windows: WfoRegimeWindowDrilldown[]
  summary: {
    windowCount: number
    passedWindows: number
    failedWindows: number
    negativeDirectionWindows: number
    weakMeanIcWindows: number
    weakIcIrWindows: number
    weakWinRateWindows: number
    negativeSpreadWindows: number
    positiveSpreadButFailedWindows: number
    highDispersionFailedWindows: number
    highVolFailedWindows: number
    latestWindow: Pick<WfoRegimeWindowDrilldown, 'windowIndex' | 'passed' | 'failureTags'> | null
    worstBySpread: Pick<WfoRegimeWindowDrilldown, 'windowIndex' | 'passed' | 'failureTags'> & { averageLongShortSpreadPct: number | null } | null
    worstByIcIr: Pick<WfoRegimeWindowDrilldown, 'windowIndex' | 'passed' | 'failureTags'> & { icIr: number } | null
    dominantFailureTags: Array<{ tag: string; count: number }>
  }
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_RANK_IC_REPORT_PATH = 'data/research/cross_sectional_rank_ic.live_accumulated_fwd72.latest.json'
const DEFAULT_DATA_DIR = 'data/market/live_accumulated'
const DEFAULT_OUTPUT_PATH = 'data/research/rank_ic_wfo_regime_drilldown.latest.json'

const MIN_MEAN_IC = 0.03
const MIN_IC_IR = 0.5
const MIN_WIN_RATE = 0.55
const MIN_LONG_SHORT_WIN_RATE = 0.5

async function main(): Promise<void> {
  const args = parseRankIcWfoRegimeDrilldownArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runRankIcWfoRegimeDrilldown(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'rank_ic_wfo_regime_drilldown',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.summary.failedWindows > 0 ? 'warn' : 'pass',
      recordsIn: report.symbolsLoaded.length,
      recordsOut: report.windows.length,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseRankIcWfoRegimeDrilldownArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    rankIcReportPath: raw.get('rankIcReportPath') ?? raw.get('rankIc') ?? DEFAULT_RANK_IC_REPORT_PATH,
    dataDir: raw.get('dataDir') ?? DEFAULT_DATA_DIR,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    symbols: parseSymbols(raw.get('symbols')),
    barMinutes: parseNullablePositiveInteger(raw.get('barMinutes'), null, 'barMinutes'),
    maxRows: parseNullablePositiveInteger(raw.get('maxRows'), null, 'maxRows'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runRankIcWfoRegimeDrilldown(
  args: CliArgs,
): Promise<RankIcWfoRegimeDrilldownReport> {
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
  const report = buildRankIcWfoRegimeDrilldownReport({
    rankIcReportPath,
    rankIcReport,
    dataDir,
    barMinutes,
    assets,
    generatedAt: new Date().toISOString(),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildRankIcWfoRegimeDrilldownReport(input: {
  rankIcReportPath: string
  rankIcReport: RankIcReportInput | Record<string, unknown> | null
  dataDir: string
  barMinutes: number
  assets: WfoDrilldownAssetSeries[]
  generatedAt?: string
}): RankIcWfoRegimeDrilldownReport {
  const root = asRecord(input.rankIcReport)
  const wfo = asRecord(root?.wfo)
  const best = asRecord(root?.best)
  const windowsInput = readWfoWindows(wfo)
  const loadedCommonPeriods = input.assets.length > 0
    ? Math.min(...input.assets.map(asset => asset.candles.length))
    : 0
  const rankIcCommonPeriods = readNumber(root?.commonPeriods)
  const dataAlignment = buildDataAlignment(rankIcCommonPeriods, loadedCommonPeriods)
  const boundedWindows = windowsInput.filter(window =>
    window.startIndex >= 0 &&
    window.endIndexExclusive > window.startIndex &&
    window.endIndexExclusive <= loadedCommonPeriods
  )
  const windowDrilldowns = boundedWindows.map(window => buildWindowDrilldown({
    window,
    assets: input.assets,
    barMinutes: input.barMinutes,
  }))
  applyRelativeRegimeBuckets(windowDrilldowns)
  const summary = buildSummary(windowDrilldowns)
  const blockers = buildBlockers(root, dataAlignment.blockers, windowsInput.length, boundedWindows.length, summary.failedWindows)

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
    rankIcCandidate: {
      factor: readString(best?.factor),
      lookbackHours: readNumber(best?.lookbackHours),
      secondaryLookbackHours: readNumber(best?.secondaryLookbackHours),
      forwardHours: readNumber(best?.forwardHours),
      mtfWeight: readNumber(best?.mtfWeight),
      wfoStatus: readString(wfo?.status),
      wfoBlockers: readStringArray(wfo?.blockers),
    },
    dataAlignment,
    windows: windowDrilldowns,
    summary,
    blockers,
    nextActions: buildNextActions(windowDrilldowns, summary),
    notes: [
      'This artifact is a research-only WFO failure drilldown; it cannot authorize paper orders, live orders, promotion, or leverage changes.',
      'Regime metrics describe the contemporaneous market window, while RankIC spread uses the RankIC report forward-return evaluation.',
      'Use this artifact to design the next validation experiment, then rerun RankIC, route-cost, trial ledger, BY FDR, PIT, and release gates.',
    ],
  }
}

function buildWindowDrilldown(input: {
  window: RankIcWfoWindowInput
  assets: WfoDrilldownAssetSeries[]
  barMinutes: number
}): WfoRegimeWindowDrilldown {
  const rankIc = {
    observations: readFiniteNumber(input.window.observations, 0),
    periods: readFiniteNumber(input.window.periods, 0),
    signalPeriods: readFiniteNumber(input.window.signalPeriods, 0),
    signalDensity: null as number | null,
    meanIc: readFiniteNumber(input.window.meanIc, 0),
    icIr: readFiniteNumber(input.window.icIr, 0),
    winRate: readFiniteNumber(input.window.winRate, 0),
    averageLongShortSpreadPct: readNullableNumber(input.window.averageLongShortSpreadPct),
    longShortWinRate: readNullableNumber(input.window.longShortWinRate),
  }
  rankIc.signalDensity = rankIc.periods > 0 ? round(rankIc.signalPeriods / rankIc.periods, 6) : null
  const regime = buildRegimeStats(input.assets, input.window, input.barMinutes)
  const passed = input.window.passed === true
  const failureTags = passed ? [] : buildFailureTags(rankIc)
  return {
    windowIndex: input.window.windowIndex,
    startTime: input.window.startTime || inferTime(input.assets, input.window.startIndex),
    endTime: input.window.endTime || inferTime(input.assets, input.window.endIndexExclusive - 1),
    startIndex: input.window.startIndex,
    endIndexExclusive: input.window.endIndexExclusive,
    passed,
    rankIc,
    regime: {
      ...regime,
      dispersionBucket: 'unknown',
      volatilityBucket: 'unknown',
    },
    failureTags,
    interpretation: interpretWindow(passed, failureTags, regime, rankIc),
  }
}

function buildRegimeStats(
  assets: WfoDrilldownAssetSeries[],
  window: RankIcWfoWindowInput,
  barMinutes: number,
): Omit<WfoRegimeWindowDrilldown['regime'], 'dispersionBucket' | 'volatilityBucket'> {
  const returns: Array<{ symbol: string; value: number }> = []
  const vols: number[] = []
  const hourlyAbsReturns: number[] = []
  const dailyDollarVolumes: number[] = []
  const priorDailyDollarVolumes: number[] = []
  const barsPerDay = 24 * 60 / barMinutes
  const windowLength = window.endIndexExclusive - window.startIndex
  const priorStart = Math.max(0, window.startIndex - windowLength)
  const priorEnd = window.startIndex

  for (const asset of assets) {
    const first = asset.candles[window.startIndex]
    const last = asset.candles[window.endIndexExclusive - 1]
    if (first?.close && last?.close && first.close > 0 && last.close > 0) {
      returns.push({ symbol: asset.symbol, value: (last.close / first.close - 1) * 100 })
    }
    const currentSlice = asset.candles.slice(window.startIndex, window.endIndexExclusive)
    const priorSlice = asset.candles.slice(priorStart, priorEnd)
    const perBarReturns = buildPerBarReturns(currentSlice)
    if (perBarReturns.length > 1) {
      vols.push(standardDeviation(perBarReturns) * Math.sqrt(365 * barsPerDay) * 100)
      hourlyAbsReturns.push(...perBarReturns.map(value => Math.abs(value) * 100))
    }
    const currentDollarVolume = averageDollarVolume(currentSlice, barsPerDay)
    const priorDollarVolume = averageDollarVolume(priorSlice, barsPerDay)
    if (currentDollarVolume != null) dailyDollarVolumes.push(currentDollarVolume)
    if (priorDollarVolume != null) priorDailyDollarVolumes.push(priorDollarVolume)
  }

  const returnValues = returns.map(row => row.value)
  const meanReturnPct = returnValues.length > 0 ? mean(returnValues) : null
  const medianReturnPct = returnValues.length > 0 ? median(returnValues) : null
  const averageDailyDollarVolume = dailyDollarVolumes.length > 0 ? mean(dailyDollarVolumes) : null
  const priorAverageDailyDollarVolume = priorDailyDollarVolumes.length > 0 ? mean(priorDailyDollarVolumes) : null

  return {
    assetCount: returns.length,
    btcReturnPct: returns.find(row => row.symbol === 'BTC-USDT')?.value ?? null,
    ethReturnPct: returns.find(row => row.symbol === 'ETH-USDT')?.value ?? null,
    meanReturnPct: roundNullable(meanReturnPct, 6),
    medianReturnPct: roundNullable(medianReturnPct, 6),
    breadthPositivePct: returnValues.length > 0
      ? round(returnValues.filter(value => value > 0).length / returnValues.length, 6)
      : null,
    crossSectionalDispersionPct: returnValues.length > 1 ? round(standardDeviation(returnValues), 6) : null,
    averageAnnualizedVolPct: vols.length > 0 ? round(mean(vols), 6) : null,
    averageHourlyAbsReturnPct: hourlyAbsReturns.length > 0 ? round(mean(hourlyAbsReturns), 6) : null,
    averageDailyDollarVolume: averageDailyDollarVolume == null ? null : round(averageDailyDollarVolume, 6),
    volumeRatioVsPriorWindow: averageDailyDollarVolume != null && priorAverageDailyDollarVolume != null && priorAverageDailyDollarVolume > 0
      ? round(averageDailyDollarVolume / priorAverageDailyDollarVolume, 6)
      : null,
    returnBucket: bucketReturn(medianReturnPct),
  }
}

function buildFailureTags(rankIc: WfoRegimeWindowDrilldown['rankIc']): string[] {
  const tags: string[] = []
  if (rankIc.meanIc <= 0) tags.push('negative_direction')
  else if (rankIc.meanIc < MIN_MEAN_IC) tags.push('weak_mean_ic')
  if (rankIc.icIr < MIN_IC_IR) tags.push('weak_ic_ir')
  if (rankIc.winRate < MIN_WIN_RATE) tags.push('weak_win_rate')
  if (rankIc.averageLongShortSpreadPct != null && rankIc.averageLongShortSpreadPct < 0) tags.push('negative_long_short_spread')
  if (rankIc.longShortWinRate != null && rankIc.longShortWinRate < MIN_LONG_SHORT_WIN_RATE) tags.push('weak_long_short_win_rate')
  return uniqueStrings(tags)
}

function interpretWindow(
  passed: boolean,
  failureTags: string[],
  regime: Omit<WfoRegimeWindowDrilldown['regime'], 'dispersionBucket' | 'volatilityBucket'>,
  rankIc: WfoRegimeWindowDrilldown['rankIc'],
): string {
  if (passed) return 'WFO window passed the internal RankIC diagnostic thresholds.'
  if (failureTags.includes('negative_long_short_spread') || failureTags.includes('negative_direction')) {
    return `Direction failed in this regime; median market return=${formatNullable(regime.medianReturnPct)}%, spread=${formatNullable(rankIc.averageLongShortSpreadPct)}%.`
  }
  if (failureTags.includes('weak_ic_ir')) {
    return `Economic spread stayed non-negative but RankIC stability was weak; icIr=${rankIc.icIr}.`
  }
  if (failureTags.includes('weak_win_rate')) {
    return `Signal direction was positive on average but not frequent enough; winRate=${rankIc.winRate}.`
  }
  return 'Window failed internal RankIC diagnostics; inspect regime metrics before adding complexity.'
}

function applyRelativeRegimeBuckets(windows: WfoRegimeWindowDrilldown[]): void {
  const dispersions = windows.map(window => window.regime.crossSectionalDispersionPct).filter(isFiniteNumber)
  const vols = windows.map(window => window.regime.averageAnnualizedVolPct).filter(isFiniteNumber)
  const dispersionHigh = percentile(dispersions, 0.67)
  const dispersionLow = percentile(dispersions, 0.33)
  const volHigh = percentile(vols, 0.67)
  const volLow = percentile(vols, 0.33)

  for (const window of windows) {
    window.regime.dispersionBucket = bucketRelative(window.regime.crossSectionalDispersionPct, dispersionLow, dispersionHigh)
    window.regime.volatilityBucket = bucketRelative(window.regime.averageAnnualizedVolPct, volLow, volHigh)
    if (!window.passed && window.regime.dispersionBucket === 'high') window.failureTags = uniqueStrings([...window.failureTags, 'high_dispersion_regime'])
    if (!window.passed && window.regime.volatilityBucket === 'high') window.failureTags = uniqueStrings([...window.failureTags, 'high_volatility_regime'])
    window.interpretation = interpretWindow(window.passed, window.failureTags, window.regime, window.rankIc)
  }
}

function buildSummary(windows: WfoRegimeWindowDrilldown[]): RankIcWfoRegimeDrilldownReport['summary'] {
  const failed = windows.filter(window => !window.passed)
  const worstBySpread = windows
    .filter(window => window.rankIc.averageLongShortSpreadPct != null)
    .sort((left, right) => (left.rankIc.averageLongShortSpreadPct ?? Infinity) - (right.rankIc.averageLongShortSpreadPct ?? Infinity))[0] ?? null
  const worstByIcIr = [...windows]
    .sort((left, right) => left.rankIc.icIr - right.rankIc.icIr)[0] ?? null
  return {
    windowCount: windows.length,
    passedWindows: windows.filter(window => window.passed).length,
    failedWindows: failed.length,
    negativeDirectionWindows: countTag(failed, 'negative_direction'),
    weakMeanIcWindows: countTag(failed, 'weak_mean_ic'),
    weakIcIrWindows: countTag(failed, 'weak_ic_ir'),
    weakWinRateWindows: countTag(failed, 'weak_win_rate'),
    negativeSpreadWindows: countTag(failed, 'negative_long_short_spread'),
    positiveSpreadButFailedWindows: failed.filter(window =>
      (window.rankIc.averageLongShortSpreadPct ?? Number.NEGATIVE_INFINITY) >= 0
    ).length,
    highDispersionFailedWindows: countTag(failed, 'high_dispersion_regime'),
    highVolFailedWindows: countTag(failed, 'high_volatility_regime'),
    latestWindow: windows.length > 0 ? summarizeWindowRef(windows[windows.length - 1]) : null,
    worstBySpread: worstBySpread
      ? {
          ...summarizeWindowRef(worstBySpread),
          averageLongShortSpreadPct: worstBySpread.rankIc.averageLongShortSpreadPct,
        }
      : null,
    worstByIcIr: worstByIcIr
      ? {
          ...summarizeWindowRef(worstByIcIr),
          icIr: worstByIcIr.rankIc.icIr,
        }
      : null,
    dominantFailureTags: dominantTags(failed),
  }
}

function summarizeWindowRef(window: WfoRegimeWindowDrilldown): Pick<WfoRegimeWindowDrilldown, 'windowIndex' | 'passed' | 'failureTags'> {
  return {
    windowIndex: window.windowIndex,
    passed: window.passed,
    failureTags: window.failureTags,
  }
}

function buildDataAlignment(
  rankIcCommonPeriods: number | null,
  loadedCommonPeriods: number,
): RankIcWfoRegimeDrilldownReport['dataAlignment'] {
  const blockers: string[] = []
  let alignmentStatus: RankIcWfoRegimeDrilldownReport['dataAlignment']['alignmentStatus'] = 'aligned'
  if (loadedCommonPeriods <= 0) {
    alignmentStatus = 'no_assets'
    blockers.push('wfo_drilldown_no_assets_loaded')
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
  alignmentBlockers: string[],
  rawWindowCount: number,
  boundedWindowCount: number,
  failedWindows: number,
): string[] {
  const blockers = ['research_only_not_promotion_evidence']
  if (!rankIcReport) blockers.push('rank_ic_report_missing_or_invalid')
  blockers.push(...alignmentBlockers)
  if (rawWindowCount === 0) blockers.push('rank_ic_wfo_windows_missing')
  if (boundedWindowCount < rawWindowCount) blockers.push(`wfo_windows_outside_loaded_data:${boundedWindowCount}<${rawWindowCount}`)
  if (failedWindows > 0) blockers.push(`rank_ic_wfo_failed_windows:${failedWindows}`)
  return uniqueStrings(blockers)
}

function buildNextActions(
  windows: WfoRegimeWindowDrilldown[],
  summary: RankIcWfoRegimeDrilldownReport['summary'],
): string[] {
  const actions = [
    'Keep paper/live blocked; use this drilldown only to choose the next research validation run.',
  ]
  if (summary.negativeSpreadWindows > 0 || summary.negativeDirectionWindows > 0) {
    actions.push('Test a regime filter or kill-switch against the negative-direction WFO windows, then rerun RankIC and route-cost validation.')
  }
  if (summary.positiveSpreadButFailedWindows > 0) {
    actions.push('For positive-spread-but-failed windows, test rank confidence thresholds and stability filters before adding new factors.')
  }
  if (summary.highDispersionFailedWindows > 0 || summary.highVolFailedWindows > 0) {
    actions.push('Bucket the candidate by dispersion/volatility regime and validate whether exposure should be reduced or skipped in high-noise windows.')
  }
  if (windows.length > 0) {
    actions.push('After any candidate filter is added, rebuild fwd24/fwd48/fwd72 RankIC, route-cost, incubation, trial ledger, and BY FDR artifacts.')
  }
  return actions
}

async function loadAssets(
  dataDir: string,
  symbols: string[],
  maxRows: number | null,
  timeframe: PaperUniverseTimeframe,
): Promise<WfoDrilldownAssetSeries[]> {
  const assets: WfoDrilldownAssetSeries[] = []
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

function alignByTailLength(assets: WfoDrilldownAssetSeries[]): WfoDrilldownAssetSeries[] {
  if (assets.length === 0) return []
  const minLength = Math.min(...assets.map(asset => asset.candles.length))
  return assets.map(asset => ({
    symbol: asset.symbol,
    candles: asset.candles.slice(asset.candles.length - minLength),
  }))
}

function readWfoWindows(wfo: Record<string, unknown> | null): RankIcWfoWindowInput[] {
  const raw = Array.isArray(wfo?.windows) ? wfo.windows : []
  return raw
    .map(asRecord)
    .filter(isRecordValue)
    .map((window, index) => ({
      windowIndex: readFiniteNumber(window.windowIndex, index),
      startTime: readString(window.startTime) ?? undefined,
      endTime: readString(window.endTime) ?? undefined,
      startIndex: readFiniteNumber(window.startIndex, 0),
      endIndexExclusive: readFiniteNumber(window.endIndexExclusive, 0),
      observations: readNumber(window.observations) ?? undefined,
      periods: readNumber(window.periods) ?? undefined,
      meanIc: readNumber(window.meanIc) ?? undefined,
      icIr: readNumber(window.icIr) ?? undefined,
      winRate: readNumber(window.winRate) ?? undefined,
      averageLongShortSpreadPct: readNumber(window.averageLongShortSpreadPct),
      longShortWinRate: readNumber(window.longShortWinRate),
      signalPeriods: readNumber(window.signalPeriods) ?? undefined,
      passed: readBool(window.passed),
    }))
}

function buildPerBarReturns(candles: Candle[]): number[] {
  const out: number[] = []
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1]
    const current = candles[index]
    if (previous.close > 0 && current.close > 0) out.push(current.close / previous.close - 1)
  }
  return out
}

function averageDollarVolume(candles: Candle[], barsPerDay: number): number | null {
  const values = candles
    .map(candle => candle.close * candle.volume)
    .filter(isFiniteNumber)
  return values.length > 0 ? mean(values) * barsPerDay : null
}

function bucketReturn(value: number | null): WfoRegimeWindowDrilldown['regime']['returnBucket'] {
  if (value == null) return 'unknown'
  if (value > 1) return 'up'
  if (value < -1) return 'down'
  return 'flat'
}

function bucketRelative(value: number | null, low: number | null, high: number | null): 'high' | 'normal' | 'low' | 'unknown' {
  if (value == null || low == null || high == null) return 'unknown'
  if (value >= high) return 'high'
  if (value <= low) return 'low'
  return 'normal'
}

function countTag(windows: WfoRegimeWindowDrilldown[], tag: string): number {
  return windows.filter(window => window.failureTags.includes(tag)).length
}

function dominantTags(windows: WfoRegimeWindowDrilldown[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const window of windows) {
    for (const tag of window.failureTags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
}

function inferTime(assets: WfoDrilldownAssetSeries[], index: number): string {
  const time = assets[0]?.candles[index]?.time
  return typeof time === 'number' ? new Date(time).toISOString() : ''
}

function renderConsoleSummary(report: RankIcWfoRegimeDrilldownReport): string {
  const lines = [
    `rank ic wfo regime drilldown: windows=${report.summary.windowCount}, failed=${report.summary.failedWindows}, status=${report.rankIcCandidate.wfoStatus ?? 'missing'}`,
    `candidate=${report.rankIcCandidate.factor ?? 'missing'} lb=${report.rankIcCandidate.lookbackHours ?? 'na'} sec=${report.rankIcCandidate.secondaryLookbackHours ?? 'na'} fwd=${report.rankIcCandidate.forwardHours ?? 'na'} mtf=${report.rankIcCandidate.mtfWeight ?? 'na'}`,
    `dominantFailures=${report.summary.dominantFailureTags.map(row => `${row.tag}:${row.count}`).join('|') || 'none'}`,
  ]
  for (const window of report.windows) {
    lines.push([
      `w${window.windowIndex}`,
      window.passed ? 'pass' : 'fail',
      `ic=${window.rankIc.meanIc}`,
      `ir=${window.rankIc.icIr}`,
      `spread=${window.rankIc.averageLongShortSpreadPct}`,
      `mkt=${window.regime.medianReturnPct}`,
      `disp=${window.regime.crossSectionalDispersionPct}`,
      `tags=${window.failureTags.join(',') || 'none'}`,
    ].join(' | '))
  }
  lines.push(`blockers=${report.blockers.join('|')}`)
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

function readBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
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

function readNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0
  const avg = mean(values)
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length)
}

function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * pct)))
  return sorted[index]
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function roundNullable(value: number | null, digits: number): number | null {
  return value == null ? null : round(value, digits)
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function formatNullable(value: number | null): string {
  return value == null ? 'na' : String(value)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
