import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyzeInformationCoefficient, type IcSample } from '../src/domain/strategy/research/ic-analyzer.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
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
type CandidateVerdict = 'promising_diagnostic' | 'incubate_observation' | 'reject'

interface CliArgs {
  dataDir: string
  outputPath: string | null
  feeSnapshotPath: string
  symbols: string[]
  lookbackHours: number[]
  forwardHours: number[]
  liquidityBuckets: LiquidityBucket[]
  routeCostPct: number
  minUniverseSize: number
  minBucketAssets: number
  topBottomFraction: number
  barMinutes: number
  maxRows: number | null
  json: boolean
}

interface LiquidityConditionedWindow {
  windowIndex: number
  startTime: string
  endTime: string
  startIndex: number
  endIndexExclusive: number
  observations: number
  periods: number
  signalPeriods: number
  meanIc: number
  icIr: number
  winRate: number
  averageLongShortSpreadPct: number | null
  netAfterRouteCostPct: number | null
  passed: boolean
}

interface LiquidityConditionedWfo {
  status: 'pass' | 'fail' | 'insufficient_data'
  windowCount: number
  passedWindows: number
  failedWindows: number
  failedWindowRatio: number | null
  failWindowRatioThreshold: number
  minWindows: number
  minPeriodsPerWindow: number
  minSignalPeriodsPerWindow: number
  directionStable: boolean
  windows: LiquidityConditionedWindow[]
  blockers: string[]
}

interface LiquidityConditionedConfigResult {
  configId: string
  liquidityBucket: LiquidityBucket
  factor: FactorDirection
  lookbackHours: number
  forwardHours: number
  lookbackBars: number
  forwardBars: number
  observations: number
  periods: number
  signalPeriods: number
  meanIc: number
  icIr: number
  winRate: number
  passedIc: boolean
  averageLongShortSpreadPct: number | null
  longShortWinRate: number | null
  routeCostPct: number
  netAfterRouteCostPct: number | null
  positiveAfterCost: boolean
  wfo: LiquidityConditionedWfo
  candidateVerdict: CandidateVerdict
  blockers: string[]
}

interface LiquidityBucketSummary {
  bucket: LiquidityBucket
  bestMomentum: LiquidityConditionedConfigResult | null
  bestReversal: LiquidityConditionedConfigResult | null
  preferredDirection: FactorDirection | null
  verdict: 'momentum_preferred' | 'reversal_preferred' | 'mixed_or_unproven'
}

export interface LiquidityConditionedFactorReport {
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
  dataCadence: {
    barMinutes: number
    lookbackUnit: 'hours'
    promotionTimeframe: '1h_required'
    nonHourlyDiagnosticOnly: boolean
  }
  hypothesis: {
    id: 'liquidity_conditioned_momentum_reversal_v1'
    summary: string
    literatureAnchors: string[]
  }
  liquidityPolicy: {
    metric: 'trailing_24h_daily_volume_usd'
    buckets: Array<{
      bucket: LiquidityBucket
      definition: string
      minAssets: number
    }>
  }
  routeCost: {
    source: 'manual_diagnostic_override' | 'runtime_verified_route_budget'
    runtimeVerified: boolean
    pairRoundTripCostPct: number
    feeSnapshotPath: string | null
    feeSnapshotSource: string | null
    feeSnapshotFetchedAt: string | null
    feeSnapshotExpiresAt: string | null
    feeSnapshotStale: boolean | null
    makerFeeBps: number | null
    takerFeeBps: number | null
  }
  configsEvaluated: number
  best: LiquidityConditionedConfigResult | null
  bucketSummaries: LiquidityBucketSummary[]
  topConfigs: LiquidityConditionedConfigResult[]
  blockers: string[]
  nextActions: string[]
  killCriteria: string[]
  notes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/research/liquidity_conditioned_factor_report.latest.json'
const DEFAULT_FEE_SNAPSHOT_PATH = 'data/runtime/fee_snapshot.latest.json'
const WFO_FAIL_WINDOW_RATIO_THRESHOLD = 0.3
const WFO_MIN_WINDOWS = 3
const WFO_MIN_PERIODS_PER_WINDOW = 3
const WFO_MIN_SIGNAL_PERIODS_PER_WINDOW = 3
const MIN_TOTAL_SIGNAL_PERIODS = 30

async function main(): Promise<void> {
  const args = parseLiquidityConditionedFactorArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runLiquidityConditionedFactorReport(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'liquidity_conditioned_factor_report',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.best?.candidateVerdict === 'promising_diagnostic' ? 'warn' : 'fail',
      recordsIn: report.symbolsLoaded.length,
      recordsOut: report.configsEvaluated,
      errorClass: report.best ? null : 'liquidity_conditioned_factor_candidate_missing',
    })
  }
}

export function parseLiquidityConditionedFactorArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    dataDir: raw.get('dataDir') ?? join(import.meta.dirname, '..', 'data', 'market', 'live_accumulated'),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    feeSnapshotPath: raw.get('feeSnapshotPath') ?? raw.get('feeSnapshot') ?? DEFAULT_FEE_SNAPSHOT_PATH,
    symbols: parseSymbols(raw.get('symbols')),
    lookbackHours: parseNumberList(raw.get('lookbackHours') ?? raw.get('lookbacks'), [24, 72, 168, 336]),
    forwardHours: parseNumberList(raw.get('forwardHours') ?? raw.get('forwards'), [24, 48, 72]),
    liquidityBuckets: parseLiquidityBuckets(raw.get('liquidityBuckets') ?? raw.get('buckets')),
    routeCostPct: parseFiniteNumber(raw.get('routeCostPct'), 0.36, 'routeCostPct'),
    minUniverseSize: parsePositiveInteger(raw.get('minUniverseSize'), 20, 'minUniverseSize'),
    minBucketAssets: parsePositiveInteger(raw.get('minBucketAssets'), 5, 'minBucketAssets'),
    topBottomFraction: parseFraction(raw.get('topBottomFraction'), 0.2, 'topBottomFraction'),
    barMinutes: parsePositiveInteger(raw.get('barMinutes'), 60, 'barMinutes'),
    maxRows: parseNullablePositiveInteger(raw.get('maxRows'), null, 'maxRows'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runLiquidityConditionedFactorReport(
  args: CliArgs,
): Promise<LiquidityConditionedFactorReport> {
  const normalizedArgs = normalizeArgs(args)
  const feeSnapshotPath = resolve(normalizedArgs.feeSnapshotPath)
  const assets = await loadAssets(
    resolve(normalizedArgs.dataDir),
    normalizedArgs.symbols,
    normalizedArgs.maxRows,
    timeframeForBarMinutes(normalizedArgs.barMinutes),
  )
  const report = buildLiquidityConditionedFactorReport({
    args: normalizedArgs,
    assets,
    feeSnapshotPath,
    feeSnapshot: await readJsonIfExists(feeSnapshotPath),
    generatedAt: new Date().toISOString(),
  })

  if (normalizedArgs.outputPath) {
    const outputPath = resolve(normalizedArgs.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildLiquidityConditionedFactorReport(input: {
  args: CliArgs
  assets: AssetSeries[]
  feeSnapshotPath?: string
  feeSnapshot?: unknown
  generatedAt?: string
}): LiquidityConditionedFactorReport {
  const args = normalizeArgs(input.args)
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const routeCost = buildRouteCost(args.routeCostPct, input.feeSnapshot, input.feeSnapshotPath, generatedAt)
  const commonPeriods = input.assets.length > 0
    ? Math.min(...input.assets.map(asset => asset.candles.length))
    : 0
  const runtimeStatsBySymbol = buildRuntimeStatsBySymbol(input.assets, args.barMinutes)
  const results: LiquidityConditionedConfigResult[] = []

  for (const lookbackHours of args.lookbackHours) {
    for (const forwardHours of args.forwardHours) {
      for (const liquidityBucket of args.liquidityBuckets) {
        for (const factor of ['momentum', 'reversal'] as FactorDirection[]) {
          results.push(evaluateLiquidityConditionedConfig({
            assets: input.assets,
            runtimeStatsBySymbol,
            lookbackHours,
            forwardHours,
            liquidityBucket,
            factor,
            routeCostPct: routeCost.pairRoundTripCostPct,
            routeCostRuntimeVerified: routeCost.runtimeVerified,
            minUniverseSize: args.minUniverseSize,
            minBucketAssets: args.minBucketAssets,
            topBottomFraction: args.topBottomFraction,
            barMinutes: args.barMinutes,
            commonPeriods,
            includeWfo: true,
          }))
        }
      }
    }
  }

  const sorted = [...results].sort(compareCandidates)
  const best = sorted[0] ?? null
  const bucketSummaries = buildBucketSummaries(args.liquidityBuckets, sorted)
  const blockers = buildReportBlockers(input.assets, commonPeriods, best, args, routeCost.runtimeVerified)

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    dataDir: resolve(args.dataDir),
    symbolsRequested: args.symbols,
    symbolsLoaded: input.assets.map(asset => asset.symbol),
    commonPeriods,
    dataCadence: {
      barMinutes: args.barMinutes,
      lookbackUnit: 'hours',
      promotionTimeframe: '1h_required',
      nonHourlyDiagnosticOnly: args.barMinutes !== 60,
    },
    hypothesis: {
      id: 'liquidity_conditioned_momentum_reversal_v1',
      summary: 'Crypto cross-sectional direction should be conditioned on decision-time liquidity: high-liquidity assets may favor momentum while low-liquidity effects must clear stricter cost and stability gates before reversal is considered tradable.',
      literatureAnchors: [
        'Common risk factors in cryptocurrency: market, size, and momentum effects need cross-sectional testing.',
        'Short-term reversal in crypto can be liquidity-dependent and may not survive executable high-liquidity filters.',
        'Backtest-overfitting controls require WFO, trial ledger, FDR, PIT, and prospective evidence before promotion.',
      ],
    },
    liquidityPolicy: {
      metric: 'trailing_24h_daily_volume_usd',
      buckets: [
        { bucket: 'all', definition: 'Full eligible cross-section at each decision time.', minAssets: args.minUniverseSize },
        { bucket: 'low', definition: 'Bottom third by trailing 24h dollar volume at each decision time.', minAssets: args.minBucketAssets },
        { bucket: 'mid', definition: 'Middle third by trailing 24h dollar volume at each decision time.', minAssets: args.minBucketAssets },
        { bucket: 'high', definition: 'Top third by trailing 24h dollar volume at each decision time.', minAssets: args.minBucketAssets },
      ].filter(item => args.liquidityBuckets.includes(item.bucket)),
    },
    routeCost: {
      ...routeCost,
    },
    configsEvaluated: results.length,
    best,
    bucketSummaries,
    topConfigs: sorted.slice(0, 30),
    blockers,
    nextActions: buildNextActions(best, blockers),
    killCriteria: [
      `Kill a bucket/factor if WFO failedWindowRatio remains above ${WFO_FAIL_WINDOW_RATIO_THRESHOLD} after at least ${WFO_MIN_WINDOWS} windows.`,
      'Kill any candidate whose runtime-verified route cost turns netAfterRouteCostPct <= 0.',
      'Kill low-liquidity-only effects unless spread/depth/fill evidence proves executability.',
      `Keep observation-only until prospective closed outcomes reach at least 100 and at least 3 non-overlapping windows.`,
      'Do not promote from this artifact without complete trial ledger, BY FDR, PIT audit, and paper execution evidence.',
    ],
    notes: [
      'This artifact is research-only and cannot authorize paper or live orders.',
      'Liquidity buckets are assigned with decision-time trailing 24h dollar volume only.',
      routeCost.runtimeVerified
        ? 'Route cost uses a fixed route budget whose fee component is backed by a runtime-verified OKX fee snapshot.'
        : 'Route cost is a diagnostic manual override until OKX private auth can verify maker/taker fees at runtime.',
      'A promising_diagnostic verdict is a hypothesis-prioritization signal, not a promotion or execution signal.',
    ],
  }
}

function normalizeArgs(args: CliArgs): CliArgs {
  return {
    ...args,
    barMinutes: normalizeBarMinutes(args.barMinutes),
    lookbackHours: uniqueSortedPositive(args.lookbackHours, 'lookbackHours'),
    forwardHours: uniqueSortedPositive(args.forwardHours, 'forwardHours'),
    liquidityBuckets: args.liquidityBuckets.length > 0 ? args.liquidityBuckets : ['all', 'low', 'mid', 'high'],
  }
}

function evaluateLiquidityConditionedConfig(input: {
  assets: AssetSeries[]
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  lookbackHours: number
  forwardHours: number
  liquidityBucket: LiquidityBucket
  factor: FactorDirection
  routeCostPct: number
  routeCostRuntimeVerified: boolean
  minUniverseSize: number
  minBucketAssets: number
  topBottomFraction: number
  barMinutes: number
  commonPeriods: number
  startIndex?: number
  endIndexExclusive?: number
  includeWfo: boolean
}): LiquidityConditionedConfigResult {
  const lookbackBars = hoursToBars(input.lookbackHours, input.barMinutes)
  const forwardBars = hoursToBars(input.forwardHours, input.barMinutes)
  const dailyBars = hoursToBars(24, input.barMinutes)
  const naturalStart = Math.max(lookbackBars, dailyBars) + 1
  const naturalEnd = input.commonPeriods - forwardBars
  const startIndex = Math.max(naturalStart, input.startIndex ?? naturalStart)
  const endIndexExclusive = Math.min(naturalEnd, input.endIndexExclusive ?? naturalEnd)
  const samples: IcSample[] = []
  const signalSpreads: number[] = []

  for (let index = startIndex; index < endIndexExclusive; index += 1) {
    const rows = buildAssetsAtTime({
      assets: input.assets,
      runtimeStatsBySymbol: input.runtimeStatsBySymbol,
      index,
      lookbackBars,
      forwardBars,
    })
    if (rows.length < input.minUniverseSize) continue
    const bucketRows = selectLiquidityBucket(rows, input.liquidityBucket)
    const minAssets = input.liquidityBucket === 'all' ? input.minUniverseSize : input.minBucketAssets
    if (bucketRows.length < minAssets) continue
    const bucketKey = rows[0]?.time ?? index
    for (const row of bucketRows) {
      samples.push({
        factorValue: factorValue(row.lookbackReturnPct, input.factor),
        forwardReturn: row.forwardReturnPct,
        bucketKey,
      })
    }
    const spread = longShortSpread(bucketRows, input.factor, input.topBottomFraction)
    if (spread != null) signalSpreads.push(spread)
  }

  const ic = analyzeInformationCoefficient(samples)
  const averageLongShortSpreadPct = signalSpreads.length > 0 ? round(mean(signalSpreads), 6) : null
  const longShortWinRate = signalSpreads.length > 0
    ? round(signalSpreads.filter(value => value > 0).length / signalSpreads.length, 6)
    : null
  const netAfterRouteCostPct = averageLongShortSpreadPct == null
    ? null
    : round(averageLongShortSpreadPct - input.routeCostPct, 6)
  const wfo = input.includeWfo
    ? buildLiquidityConditionedWfo({
      ...input,
      lookbackBars,
      forwardBars,
      naturalStart,
      naturalEnd,
    })
    : emptyWfo()
  const blockers = buildCandidateBlockers({
    periods: ic.periods,
    signalPeriods: signalSpreads.length,
    passedIc: ic.passed,
    netAfterRouteCostPct,
    wfo,
    routeCostRuntimeVerified: input.routeCostRuntimeVerified,
  })
  const candidateVerdict = classifyCandidate({
    signalPeriods: signalSpreads.length,
    netAfterRouteCostPct,
    wfo,
    blockers,
  })

  return {
    configId: `liq_${input.liquidityBucket}_${input.factor}_lb${input.lookbackHours}_fwd${input.forwardHours}`,
    liquidityBucket: input.liquidityBucket,
    factor: input.factor,
    lookbackHours: input.lookbackHours,
    forwardHours: input.forwardHours,
    lookbackBars,
    forwardBars,
    observations: ic.observations,
    periods: ic.periods,
    signalPeriods: signalSpreads.length,
    meanIc: round(ic.meanIc, 6),
    icIr: roundFinite(ic.icIr, 6),
    winRate: round(ic.winRate, 6),
    passedIc: ic.passed,
    averageLongShortSpreadPct,
    longShortWinRate,
    routeCostPct: input.routeCostPct,
    netAfterRouteCostPct,
    positiveAfterCost: netAfterRouteCostPct != null && netAfterRouteCostPct > 0,
    wfo,
    candidateVerdict,
    blockers,
  }
}

function buildLiquidityConditionedWfo(input: {
  assets: AssetSeries[]
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  lookbackHours: number
  forwardHours: number
  liquidityBucket: LiquidityBucket
  factor: FactorDirection
  routeCostPct: number
  routeCostRuntimeVerified: boolean
  minUniverseSize: number
  minBucketAssets: number
  topBottomFraction: number
  barMinutes: number
  commonPeriods: number
  lookbackBars: number
  forwardBars: number
  naturalStart: number
  naturalEnd: number
}): LiquidityConditionedWfo {
  const blockers: string[] = []
  const testable = Math.max(0, input.naturalEnd - input.naturalStart)
  if (testable <= 0) blockers.push(`wfo_no_testable_periods:${testable}`)
  const desiredWindows = Math.min(5, Math.max(WFO_MIN_WINDOWS, Math.floor(testable / WFO_MIN_PERIODS_PER_WINDOW)))
  const windows = testable > 0
    ? buildContiguousWindows(input.naturalStart, input.naturalEnd, desiredWindows)
      .map((window, windowIndex) => summarizeWindow({
        ...input,
        windowIndex,
        startIndex: window.startIndex,
        endIndexExclusive: window.endIndexExclusive,
      }))
    : []

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
    failedWindowRatio,
    failWindowRatioThreshold: WFO_FAIL_WINDOW_RATIO_THRESHOLD,
    minWindows: WFO_MIN_WINDOWS,
    minPeriodsPerWindow: WFO_MIN_PERIODS_PER_WINDOW,
    minSignalPeriodsPerWindow: WFO_MIN_SIGNAL_PERIODS_PER_WINDOW,
    directionStable,
    windows,
    blockers: uniqueStrings(blockers),
  }
}

function summarizeWindow(input: {
  assets: AssetSeries[]
  runtimeStatsBySymbol: Map<string, AssetRuntimeStats[]>
  lookbackHours: number
  forwardHours: number
  liquidityBucket: LiquidityBucket
  factor: FactorDirection
  routeCostPct: number
  minUniverseSize: number
  minBucketAssets: number
  topBottomFraction: number
  barMinutes: number
  commonPeriods: number
  windowIndex: number
  startIndex: number
  endIndexExclusive: number
}): LiquidityConditionedWindow {
  const result = evaluateLiquidityConditionedConfig({
    ...input,
    routeCostRuntimeVerified: input.routeCostRuntimeVerified,
    includeWfo: false,
  })
  const start = input.assets[0]?.candles[input.startIndex]?.time
  const end = input.assets[0]?.candles[Math.max(input.startIndex, input.endIndexExclusive - 1)]?.time
  const passed = result.passedIc &&
    result.periods >= WFO_MIN_PERIODS_PER_WINDOW &&
    result.signalPeriods >= WFO_MIN_SIGNAL_PERIODS_PER_WINDOW &&
    (result.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) > 0
  return {
    windowIndex: input.windowIndex,
    startTime: typeof start === 'number' ? new Date(start).toISOString() : '',
    endTime: typeof end === 'number' ? new Date(end).toISOString() : '',
    startIndex: input.startIndex,
    endIndexExclusive: input.endIndexExclusive,
    observations: result.observations,
    periods: result.periods,
    signalPeriods: result.signalPeriods,
    meanIc: result.meanIc,
    icIr: result.icIr,
    winRate: result.winRate,
    averageLongShortSpreadPct: result.averageLongShortSpreadPct,
    netAfterRouteCostPct: result.netAfterRouteCostPct,
    passed,
  }
}

function emptyWfo(): LiquidityConditionedWfo {
  return {
    status: 'insufficient_data',
    windowCount: 0,
    passedWindows: 0,
    failedWindows: 0,
    failedWindowRatio: null,
    failWindowRatioThreshold: WFO_FAIL_WINDOW_RATIO_THRESHOLD,
    minWindows: WFO_MIN_WINDOWS,
    minPeriodsPerWindow: WFO_MIN_PERIODS_PER_WINDOW,
    minSignalPeriodsPerWindow: WFO_MIN_SIGNAL_PERIODS_PER_WINDOW,
    directionStable: false,
    windows: [],
    blockers: ['wfo_not_run_for_nested_summary'],
  }
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

function longShortSpread(
  rows: AssetAtTime[],
  factor: FactorDirection,
  topBottomFraction: number,
): number | null {
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

function buildCandidateBlockers(input: {
  periods: number
  signalPeriods: number
  passedIc: boolean
  netAfterRouteCostPct: number | null
  wfo: LiquidityConditionedWfo
  routeCostRuntimeVerified: boolean
}): string[] {
  const blockers: string[] = []
  if (!input.passedIc) blockers.push('ic_thresholds_not_passed')
  if (input.signalPeriods < MIN_TOTAL_SIGNAL_PERIODS) {
    blockers.push(`signal_periods_low:${input.signalPeriods}<${MIN_TOTAL_SIGNAL_PERIODS}`)
  }
  if ((input.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) <= 0) {
    blockers.push('net_after_manual_route_cost_not_positive')
  }
  if (input.wfo.status !== 'pass') blockers.push(`wfo_${input.wfo.status}`)
  blockers.push(...input.wfo.blockers)
  if (!input.routeCostRuntimeVerified) blockers.push('route_cost_manual_not_runtime_verified')
  blockers.push('not_trial_ledger_fdr_validated')
  blockers.push('not_paper_execution_evidence')
  return uniqueStrings(blockers)
}

function classifyCandidate(input: {
  signalPeriods: number
  netAfterRouteCostPct: number | null
  wfo: LiquidityConditionedWfo
  blockers: string[]
}): CandidateVerdict {
  const positiveNet = (input.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) > 0
  const enoughSignals = input.signalPeriods >= MIN_TOTAL_SIGNAL_PERIODS
  if (input.wfo.status === 'pass' && positiveNet && enoughSignals) return 'promising_diagnostic'
  if (positiveNet && enoughSignals) return 'incubate_observation'
  return 'reject'
}

function compareCandidates(left: LiquidityConditionedConfigResult, right: LiquidityConditionedConfigResult): number {
  return verdictScore(right.candidateVerdict) - verdictScore(left.candidateVerdict) ||
    Number(right.wfo.status === 'pass') - Number(left.wfo.status === 'pass') ||
    (right.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) - (left.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) ||
    right.meanIc - left.meanIc ||
    right.icIr - left.icIr ||
    right.signalPeriods - left.signalPeriods
}

function verdictScore(verdict: CandidateVerdict): number {
  if (verdict === 'promising_diagnostic') return 2
  if (verdict === 'incubate_observation') return 1
  return 0
}

function buildBucketSummaries(
  buckets: LiquidityBucket[],
  sorted: LiquidityConditionedConfigResult[],
): LiquidityBucketSummary[] {
  return buckets.map(bucket => {
    const bestMomentum = sorted.find(item => item.liquidityBucket === bucket && item.factor === 'momentum') ?? null
    const bestReversal = sorted.find(item => item.liquidityBucket === bucket && item.factor === 'reversal') ?? null
    const momentumScore = directionalScore(bestMomentum)
    const reversalScore = directionalScore(bestReversal)
    const preferredDirection = momentumScore > reversalScore
      ? 'momentum'
      : reversalScore > momentumScore
        ? 'reversal'
        : null
    return {
      bucket,
      bestMomentum,
      bestReversal,
      preferredDirection,
      verdict: preferredDirection === 'momentum'
        ? 'momentum_preferred'
        : preferredDirection === 'reversal'
          ? 'reversal_preferred'
          : 'mixed_or_unproven',
    }
  })
}

function directionalScore(result: LiquidityConditionedConfigResult | null): number {
  if (!result) return Number.NEGATIVE_INFINITY
  return verdictScore(result.candidateVerdict) * 1_000 +
    (result.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) +
    result.meanIc
}

function buildReportBlockers(
  assets: AssetSeries[],
  commonPeriods: number,
  best: LiquidityConditionedConfigResult | null,
  args: CliArgs,
  routeCostRuntimeVerified: boolean,
): string[] {
  const blockers: string[] = []
  if (assets.length < args.minUniverseSize) blockers.push(`loaded_universe_too_small:${assets.length}<${args.minUniverseSize}`)
  if (commonPeriods < 1_000) blockers.push(`common_periods_low:${commonPeriods}<1000`)
  if (args.barMinutes !== 60) blockers.push('non_hourly_liquidity_conditioned_research_only')
  if (!best) blockers.push('liquidity_conditioned_candidate_missing')
  if (best && best.candidateVerdict !== 'promising_diagnostic') {
    blockers.push(`best_candidate_not_promising:${best.candidateVerdict}`)
  }
  if (best && best.wfo.status !== 'pass') blockers.push(`best_wfo_${best.wfo.status}`)
  blockers.push('research_only_not_execution_evidence')
  if (!routeCostRuntimeVerified) {
    blockers.push('route_cost_manual_not_runtime_verified')
    blockers.push('runtime_fee_not_verified')
  }
  blockers.push('not_trial_ledger_fdr_validated')
  blockers.push('not_pit_audit_validated')
  blockers.push('not_paper_execution_evidence')
  blockers.push('paper_live_execution_disabled')
  return uniqueStrings(blockers)
}

function buildNextActions(best: LiquidityConditionedConfigResult | null, blockers: string[]): string[] {
  if (!best) return [
    'Load enough 1h live_accumulated assets, then rerun liquidity-conditioned factor diagnostics.',
  ]
  const actions = [
    `Prioritize ${best.configId} for observation only; do not promote it from this artifact.`,
    'Fix OKX private auth and replace manual route-cost override with runtime-verified maker/taker fees.',
    'Convert the best bucket/factor into a prospective observation lane before any paper execution.',
    'Complete trial ledger, BY FDR, PIT audit, and paper execution evidence before promotion.',
  ]
  if (blockers.some(blocker => blocker.includes('wfo'))) {
    actions.push('If WFO remains failed after new live windows, retire this bucket/factor and test the next ranked candidate.')
  }
  return actions
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

async function readJsonIfExists(path: string): Promise<unknown | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as unknown
  } catch {
    return null
  }
}

function buildRouteCost(
  fallbackRouteCostPct: number,
  feeSnapshot: unknown,
  feeSnapshotPath: string | undefined,
  asOf: string,
): LiquidityConditionedFactorReport['routeCost'] {
  const root = asRecord(feeSnapshot)
  const feeSource = readString(root?.source)
  const verifiedByRuntime = readBool(root?.verifiedByRuntime) === true
  const expiresAt = readString(root?.expiresAt)
  const stale = expiresAt != null ? Date.parse(expiresAt) <= Date.parse(asOf) : null
  const makerFeeBps = readNumber(root?.makerFeeBps)
  const takerFeeBps = readNumber(root?.takerFeeBps)
  const runtimeVerified = verifiedByRuntime &&
    feeSource !== 'manual_override' &&
    stale !== true &&
    makerFeeBps != null &&
    takerFeeBps != null
  return {
    source: runtimeVerified ? 'runtime_verified_route_budget' : 'manual_diagnostic_override',
    runtimeVerified,
    pairRoundTripCostPct: fallbackRouteCostPct,
    feeSnapshotPath: feeSnapshotPath ? resolve(feeSnapshotPath) : null,
    feeSnapshotSource: feeSource,
    feeSnapshotFetchedAt: readString(root?.sourceFetchedAt),
    feeSnapshotExpiresAt: expiresAt,
    feeSnapshotStale: stale,
    makerFeeBps,
    takerFeeBps,
  }
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

function buildRuntimeStatsBySymbol(
  assets: AssetSeries[],
  barMinutes: number,
): Map<string, AssetRuntimeStats[]> {
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

function normalizeBarMinutes(raw: number | undefined): number {
  if (raw == null) return 60
  if (!Number.isInteger(raw) || raw <= 0) throw new Error('barMinutes must be a positive integer.')
  return raw
}

function hoursToBars(hours: number, barMinutes: number): number {
  const bars = Math.round(hours * 60 / barMinutes)
  if (!Number.isFinite(bars) || bars <= 0) {
    throw new Error(`Invalid bar conversion: hours=${hours}, barMinutes=${barMinutes}`)
  }
  return bars
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const withoutPrefix = token.slice(2)
    const equalsIndex = withoutPrefix.indexOf('=')
    if (equalsIndex >= 0) {
      out.set(withoutPrefix.slice(0, equalsIndex), withoutPrefix.slice(equalsIndex + 1))
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(withoutPrefix, next)
      index += 1
    } else {
      out.set(withoutPrefix, 'true')
    }
  }
  return out
}

function parseNullablePath(raw: string | undefined): string | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'none') return null
  return trimmed
}

function parseSymbols(raw: string | undefined): string[] {
  if (!raw || raw.trim().toLowerCase() === 'default') return defaultPaperUniverseSymbols()
  return raw.split(',')
    .map(symbol => symbol.trim().toUpperCase())
    .filter(Boolean)
}

function parseLiquidityBuckets(raw: string | undefined): LiquidityBucket[] {
  if (!raw || raw.trim().toLowerCase() === 'default') return ['all', 'low', 'mid', 'high']
  const allowed = new Set<LiquidityBucket>(['all', 'low', 'mid', 'high'])
  const buckets = raw.split(',')
    .map(bucket => bucket.trim().toLowerCase())
    .filter(Boolean)
  for (const bucket of buckets) {
    if (!allowed.has(bucket as LiquidityBucket)) {
      throw new Error(`Unsupported liquidity bucket: ${bucket}`)
    }
  }
  return uniqueStrings(buckets) as LiquidityBucket[]
}

function parseNumberList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw || !raw.trim()) return fallback
  return raw.split(',')
    .map(part => Number(part.trim()))
    .filter(Number.isFinite)
}

function parseFiniteNumber(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite.`)
  return parsed
}

function parsePositiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`)
  return parsed
}

function parseNullablePositiveInteger(raw: string | undefined, fallback: number | null, label: string): number | null {
  if (raw == null || raw.trim() === '' || raw.trim().toLowerCase() === 'null') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer or null.`)
  return parsed
}

function parseFraction(raw: string | undefined, fallback: number, label: string): number {
  const parsed = parseFiniteNumber(raw, fallback, label)
  if (parsed <= 0 || parsed > 0.5) throw new Error(`${label} must be in (0, 0.5].`)
  return parsed
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function readBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function uniqueSortedPositive(values: number[], label: string): number[] {
  const unique = Array.from(new Set(values))
  for (const value of unique) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} values must be positive finite numbers.`)
  }
  return unique.sort((left, right) => left - right)
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function roundFinite(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value
  return round(value, digits)
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  return Array.from(new Set(values))
}

function renderConsoleSummary(report: LiquidityConditionedFactorReport): string {
  const best = report.best
  const lines = [
    'Liquidity-conditioned factor report',
    `status=${best?.candidateVerdict ?? 'missing'}`,
    `symbols=${report.symbolsLoaded.length}/${report.symbolsRequested.length}`,
    `commonPeriods=${report.commonPeriods}`,
    `configsEvaluated=${report.configsEvaluated}`,
  ]
  if (best) {
    lines.push(
      `best=${best.configId}`,
      `wfo=${best.wfo.status}`,
      `meanIc=${best.meanIc}`,
      `netAfterRouteCostPct=${best.netAfterRouteCostPct ?? 'null'}`,
    )
  }
  if (report.blockers.length > 0) lines.push(`blockers=${report.blockers.slice(0, 8).join(';')}`)
  return lines.join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
