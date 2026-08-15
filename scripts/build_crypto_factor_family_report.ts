import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyzeInformationCoefficient, type IcSample } from '../src/domain/strategy/research/ic-analyzer.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { defaultPaperUniverseSymbols, paperSymbolToCsvFile, type PaperUniverseTimeframe } from './lib/paper_universe.js'

interface CliArgs {
  dataDir: string
  outputPath: string | null
  feeSnapshotPath: string
  symbols: string[]
  lookbackHours: number[]
  forwardHours: number[]
  barMinutes: number
  maxRows: number | null
  routeCostPct: number
  minUniverseSize: number
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

interface AssetStats {
  dailyVolumeUsd: number
  realizedVolPct: number
}

interface AssetAtTime {
  symbol: string
  time: number
  lookbackReturnPct: number
  forwardReturnPct: number
  dailyVolumeUsd: number
  realizedVolPct: number
}

type FactorFamily = 'momentum' | 'reversal' | 'size_small' | 'size_large' | 'liquidity_high' | 'liquidity_low' | 'low_vol' | 'high_vol'
type CandidateVerdict = 'promising_diagnostic' | 'incubate_observation' | 'reject'

interface FactorFamilyWfoWindow {
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
  passedIc: boolean
  averageLongShortSpreadPct: number | null
  longShortWinRate: number | null
  netAfterRouteCostPct: number | null
  passed: boolean
}

interface FactorFamilyWfo {
  status: 'pass' | 'fail' | 'insufficient_data'
  windowCount: number
  passedWindows: number
  failedWindows: number
  failedWindowRatio: number | null
  failWindowRatioThreshold: number
  directionStable: boolean
  windows: FactorFamilyWfoWindow[]
  blockers: string[]
}

interface FactorFamilyCandidate {
  candidateId: string
  factor: FactorFamily
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
  wfo: FactorFamilyWfo
  candidateVerdict: CandidateVerdict
  blockers: string[]
}

export interface CryptoFactorFamilyReport {
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
    promotionTimeframe: '1h_required'
    nonHourlyDiagnosticOnly: boolean
    lookbackUnit: 'hours'
  }
  hypothesis: {
    id: 'crypto_base_factor_family_v1'
    literatureAnchors: string[]
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
  best: FactorFamilyCandidate | null
  bestByFactor: Array<{ factor: FactorFamily; best: FactorFamilyCandidate | null }>
  topConfigs: FactorFamilyCandidate[]
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_DATA_DIR = 'data/market/live_accumulated'
const DEFAULT_OUTPUT_PATH = 'data/research/crypto_factor_family.live_accumulated.latest.json'
const DEFAULT_FEE_SNAPSHOT_PATH = 'data/runtime/fee_snapshot.latest.json'
const FACTORS: FactorFamily[] = [
  'momentum',
  'reversal',
  'size_small',
  'size_large',
  'liquidity_high',
  'liquidity_low',
  'low_vol',
  'high_vol',
]
const WFO_FAIL_WINDOW_RATIO_THRESHOLD = 0.3
const WFO_MIN_WINDOWS = 3
const WFO_MIN_PERIODS_PER_WINDOW = 3
const WFO_MIN_SIGNAL_PERIODS_PER_WINDOW = 3
const MIN_TOTAL_SIGNAL_PERIODS = 30

async function main(): Promise<void> {
  const args = parseCryptoFactorFamilyArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runCryptoFactorFamilyReport(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'crypto_factor_family_report',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.best?.candidateVerdict === 'promising_diagnostic' ? 'warn' : 'fail',
      recordsIn: report.symbolsLoaded.length,
      recordsOut: report.configsEvaluated,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseCryptoFactorFamilyArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    dataDir: raw.get('dataDir') ?? DEFAULT_DATA_DIR,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    feeSnapshotPath: raw.get('feeSnapshotPath') ?? raw.get('feeSnapshot') ?? DEFAULT_FEE_SNAPSHOT_PATH,
    symbols: parseSymbols(raw.get('symbols')),
    lookbackHours: parseNumberList(raw.get('lookbackHours') ?? raw.get('lookbacks'), [24, 72, 168, 336]),
    forwardHours: parseNumberList(raw.get('forwardHours') ?? raw.get('forwards'), [24, 48, 72]),
    barMinutes: parsePositiveInteger(raw.get('barMinutes'), 60, 'barMinutes'),
    maxRows: parseNullablePositiveInteger(raw.get('maxRows'), null, 'maxRows'),
    routeCostPct: parseFiniteNumber(raw.get('routeCostPct'), 0.36, 'routeCostPct'),
    minUniverseSize: parsePositiveInteger(raw.get('minUniverseSize'), 20, 'minUniverseSize'),
    topBottomFraction: parseFiniteNumber(raw.get('topBottomFraction'), 0.25, 'topBottomFraction'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runCryptoFactorFamilyReport(args: CliArgs): Promise<CryptoFactorFamilyReport> {
  const symbols = args.symbols.length > 0 ? args.symbols : defaultPaperUniverseSymbols()
  const feeSnapshotPath = resolve(args.feeSnapshotPath)
  const assets = await loadAssets(resolve(args.dataDir), symbols, args.maxRows, timeframeForBarMinutes(args.barMinutes))
  const report = buildCryptoFactorFamilyReport({
    args,
    assets,
    feeSnapshotPath,
    feeSnapshot: await readJsonIfExists(feeSnapshotPath),
    generatedAt: new Date().toISOString(),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildCryptoFactorFamilyReport(input: {
  args: CliArgs
  assets: AssetSeries[]
  feeSnapshotPath?: string
  feeSnapshot?: unknown
  generatedAt?: string
}): CryptoFactorFamilyReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const routeCost = buildRouteCost(input.args.routeCostPct, input.feeSnapshot, input.feeSnapshotPath, generatedAt)
  const commonPeriods = input.assets.length > 0
    ? Math.min(...input.assets.map(asset => asset.candles.length))
    : 0
  const statsBySymbol = buildStatsBySymbol(input.assets, input.args.barMinutes)
  const candidates: FactorFamilyCandidate[] = []
  for (const lookbackHours of input.args.lookbackHours) {
    for (const forwardHours of input.args.forwardHours) {
      for (const factor of FACTORS) {
        candidates.push(evaluateCandidate({
          assets: input.assets,
          statsBySymbol,
          factor,
          lookbackHours,
          forwardHours,
          routeCostPct: routeCost.pairRoundTripCostPct,
          routeCostRuntimeVerified: routeCost.runtimeVerified,
          minUniverseSize: input.args.minUniverseSize,
          topBottomFraction: input.args.topBottomFraction,
          barMinutes: input.args.barMinutes,
          commonPeriods,
          includeWfo: true,
        }))
      }
    }
  }
  const sorted = [...candidates].sort(compareCandidates)
  const best = sorted[0] ?? null
  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    dataDir: resolve(input.args.dataDir),
    symbolsRequested: input.args.symbols,
    symbolsLoaded: input.assets.map(asset => asset.symbol),
    commonPeriods,
    dataCadence: {
      barMinutes: input.args.barMinutes,
      promotionTimeframe: '1h_required',
      nonHourlyDiagnosticOnly: input.args.barMinutes !== 60,
      lookbackUnit: 'hours',
    },
    hypothesis: {
      id: 'crypto_base_factor_family_v1',
      literatureAnchors: [
        'Crypto cross-sections should test market-related momentum, size, and liquidity/volume effects before adding model complexity.',
        'Momentum/reversal direction is horizon- and regime-dependent; WFO stability is required before prospective promotion.',
        'Any factor edge must survive route-cost, trial-ledger, BY FDR, PIT, prospective, and paper-execution gates.',
      ],
    },
    routeCost,
    configsEvaluated: candidates.length,
    best,
    bestByFactor: FACTORS.map(factor => ({
      factor,
      best: sorted.find(candidate => candidate.factor === factor) ?? null,
    })),
    topConfigs: sorted.slice(0, 30),
    blockers: buildReportBlockers(input.assets.length, commonPeriods, best, input.args, routeCost.runtimeVerified),
    nextActions: buildNextActions(best),
    notes: [
      'This artifact is research-only and cannot authorize paper or live orders.',
      routeCost.runtimeVerified
        ? 'Route cost uses a fixed route budget whose fee component is backed by a runtime-verified OKX fee snapshot.'
        : 'Route cost is a manual diagnostic override until OKX private auth verifies maker/taker fees at runtime.',
      'A promising_diagnostic verdict is hypothesis prioritization only, not promotion evidence.',
      'Top/bottom long-short spreads are gross label diagnostics minus the pair route-cost estimate; no fills are executed here.',
    ],
  }
}

function evaluateCandidate(input: {
  assets: AssetSeries[]
  statsBySymbol: Map<string, AssetStats[]>
  factor: FactorFamily
  lookbackHours: number
  forwardHours: number
  routeCostPct: number
  routeCostRuntimeVerified: boolean
  minUniverseSize: number
  topBottomFraction: number
  barMinutes: number
  commonPeriods: number
  startIndex?: number
  endIndexExclusive?: number
  includeWfo: boolean
}): FactorFamilyCandidate {
  const lookbackBars = hoursToBars(input.lookbackHours, input.barMinutes)
  const forwardBars = hoursToBars(input.forwardHours, input.barMinutes)
  const dailyBars = hoursToBars(24, input.barMinutes)
  const naturalStart = Math.max(lookbackBars, dailyBars) + 1
  const naturalEnd = input.commonPeriods - forwardBars
  const startIndex = Math.max(naturalStart, input.startIndex ?? naturalStart)
  const endIndexExclusive = Math.min(naturalEnd, input.endIndexExclusive ?? naturalEnd)
  const samples: IcSample[] = []
  const spreads: number[] = []

  for (let index = startIndex; index < endIndexExclusive; index += 1) {
    const rows = buildAssetsAtTime({
      assets: input.assets,
      statsBySymbol: input.statsBySymbol,
      index,
      lookbackBars,
      forwardBars,
    })
    if (rows.length < input.minUniverseSize) continue
    const bucketKey = rows[0]?.time ?? index
    for (const row of rows) {
      samples.push({
        factorValue: factorValue(input.factor, row),
        forwardReturn: row.forwardReturnPct,
        bucketKey,
      })
    }
    const spread = longShortSpread(rows, input.factor, input.topBottomFraction)
    if (spread != null) spreads.push(spread)
  }

  const ic = analyzeInformationCoefficient(samples)
  const averageLongShortSpreadPct = spreads.length > 0 ? round(mean(spreads), 6) : null
  const netAfterRouteCostPct = averageLongShortSpreadPct == null
    ? null
    : round(averageLongShortSpreadPct - input.routeCostPct, 6)
  const wfo = input.includeWfo
    ? buildWfo({
      ...input,
      lookbackBars,
      forwardBars,
      naturalStart,
      naturalEnd,
    })
    : emptyWfo()
  const candidate = {
    candidateId: `factor_${input.factor}_lb${input.lookbackHours}_fwd${input.forwardHours}`,
    factor: input.factor,
    lookbackHours: input.lookbackHours,
    forwardHours: input.forwardHours,
    lookbackBars,
    forwardBars,
    observations: ic.observations,
    periods: ic.periods,
    signalPeriods: spreads.length,
    meanIc: round(ic.meanIc, 6),
    icIr: roundFinite(ic.icIr, 6),
    winRate: round(ic.winRate, 6),
    passedIc: ic.passed,
    averageLongShortSpreadPct,
    longShortWinRate: spreads.length > 0 ? round(spreads.filter(value => value > 0).length / spreads.length, 6) : null,
    routeCostPct: input.routeCostPct,
    netAfterRouteCostPct,
    wfo,
  }
  const blockers = buildCandidateBlockers(candidate, input.routeCostRuntimeVerified)
  return {
    ...candidate,
    candidateVerdict: classifyCandidate(candidate, blockers),
    blockers,
  }
}

function buildWfo(input: {
  assets: AssetSeries[]
  statsBySymbol: Map<string, AssetStats[]>
  factor: FactorFamily
  lookbackHours: number
  forwardHours: number
  routeCostPct: number
  minUniverseSize: number
  topBottomFraction: number
  barMinutes: number
  commonPeriods: number
  lookbackBars: number
  forwardBars: number
  naturalStart: number
  naturalEnd: number
}): FactorFamilyWfo {
  const blockers: string[] = []
  const testable = Math.max(0, input.naturalEnd - input.naturalStart)
  const desiredWindows = Math.min(5, Math.max(WFO_MIN_WINDOWS, Math.floor(testable / WFO_MIN_PERIODS_PER_WINDOW)))
  const windows = testable > 0
    ? buildContiguousWindows(input.naturalStart, input.naturalEnd, desiredWindows).map((window, windowIndex) => {
      const summary = summarizeWindow({
        ...input,
        startIndex: window.startIndex,
        endIndexExclusive: window.endIndexExclusive,
        windowIndex,
      })
      return summary
    })
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
    failedWindowRatio: failedWindowRatio == null ? null : round(failedWindowRatio, 6),
    failWindowRatioThreshold: WFO_FAIL_WINDOW_RATIO_THRESHOLD,
    directionStable,
    windows,
    blockers: uniqueStrings(blockers),
  }
}

function summarizeWindow(input: {
  assets: AssetSeries[]
  statsBySymbol: Map<string, AssetStats[]>
  factor: FactorFamily
  lookbackHours: number
  forwardHours: number
  routeCostPct: number
  minUniverseSize: number
  topBottomFraction: number
  barMinutes: number
  commonPeriods: number
  windowIndex: number
  startIndex: number
  endIndexExclusive: number
}): FactorFamilyWfoWindow {
  const result = evaluateCandidate({
    ...input,
    routeCostRuntimeVerified: true,
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
    passedIc: result.passedIc,
    averageLongShortSpreadPct: result.averageLongShortSpreadPct,
    longShortWinRate: result.longShortWinRate,
    netAfterRouteCostPct: result.netAfterRouteCostPct,
    passed,
  }
}

function emptyWfo(): FactorFamilyWfo {
  return {
    status: 'insufficient_data',
    windowCount: 0,
    passedWindows: 0,
    failedWindows: 0,
    failedWindowRatio: null,
    failWindowRatioThreshold: WFO_FAIL_WINDOW_RATIO_THRESHOLD,
    directionStable: false,
    windows: [],
    blockers: ['wfo_not_run_for_nested_summary'],
  }
}

function buildCandidateBlockers(
  candidate: Omit<FactorFamilyCandidate, 'candidateVerdict' | 'blockers'>,
  routeCostRuntimeVerified: boolean,
): string[] {
  const blockers: string[] = []
  if (!candidate.passedIc) blockers.push('ic_thresholds_not_passed')
  if (candidate.signalPeriods < MIN_TOTAL_SIGNAL_PERIODS) {
    blockers.push(`signal_periods_low:${candidate.signalPeriods}<${MIN_TOTAL_SIGNAL_PERIODS}`)
  }
  if ((candidate.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) <= 0) {
    blockers.push('net_after_manual_route_cost_not_positive')
  }
  if (candidate.wfo.status !== 'pass') blockers.push(`wfo_${candidate.wfo.status}`)
  blockers.push(...candidate.wfo.blockers)
  if (!routeCostRuntimeVerified) blockers.push('route_cost_manual_not_runtime_verified')
  blockers.push('not_trial_ledger_fdr_validated')
  blockers.push('not_paper_execution_evidence')
  return uniqueStrings(blockers)
}

function classifyCandidate(
  candidate: Omit<FactorFamilyCandidate, 'candidateVerdict' | 'blockers'>,
  blockers: string[],
): CandidateVerdict {
  const positiveNet = (candidate.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) > 0
  if (candidate.wfo.status === 'pass' && candidate.passedIc && positiveNet && candidate.signalPeriods >= MIN_TOTAL_SIGNAL_PERIODS) {
    return 'promising_diagnostic'
  }
  if (positiveNet && candidate.signalPeriods >= MIN_TOTAL_SIGNAL_PERIODS && blockers.includes('wfo_fail')) {
    return 'incubate_observation'
  }
  return 'reject'
}

function buildAssetsAtTime(input: {
  assets: AssetSeries[]
  statsBySymbol: Map<string, AssetStats[]>
  index: number
  lookbackBars: number
  forwardBars: number
}): AssetAtTime[] {
  const rows: AssetAtTime[] = []
  for (const asset of input.assets) {
    const current = asset.candles[input.index]
    const lookback = asset.candles[input.index - input.lookbackBars]
    const forward = asset.candles[input.index + input.forwardBars]
    const stats = input.statsBySymbol.get(asset.symbol)?.[input.index]
    if (!current || !lookback || !forward || !stats) continue
    if (current.close <= 0 || lookback.close <= 0 || forward.close <= 0) continue
    rows.push({
      symbol: asset.symbol,
      time: current.time,
      lookbackReturnPct: (current.close / lookback.close - 1) * 100,
      forwardReturnPct: (forward.close / current.close - 1) * 100,
      dailyVolumeUsd: stats.dailyVolumeUsd,
      realizedVolPct: stats.realizedVolPct,
    })
  }
  return rows.filter(row => row.dailyVolumeUsd > 0 && Number.isFinite(row.realizedVolPct))
}

function factorValue(factor: FactorFamily, row: AssetAtTime): number {
  switch (factor) {
    case 'momentum':
      return row.lookbackReturnPct
    case 'reversal':
      return -row.lookbackReturnPct
    case 'size_small':
      return -Math.log(row.dailyVolumeUsd)
    case 'size_large':
      return Math.log(row.dailyVolumeUsd)
    case 'liquidity_high':
      return Math.log(row.dailyVolumeUsd)
    case 'liquidity_low':
      return -Math.log(row.dailyVolumeUsd)
    case 'low_vol':
      return -row.realizedVolPct
    case 'high_vol':
      return row.realizedVolPct
  }
}

function longShortSpread(rows: AssetAtTime[], factor: FactorFamily, topBottomFraction: number): number | null {
  if (rows.length < 2) return null
  const sorted = [...rows].sort((left, right) => factorValue(factor, left) - factorValue(factor, right))
  const count = Math.max(1, Math.min(Math.floor(rows.length / 2), Math.floor(rows.length * topBottomFraction)))
  const shorts = sorted.slice(0, count)
  const longs = sorted.slice(sorted.length - count)
  if (longs.length === 0 || shorts.length === 0) return null
  return mean(longs.map(row => row.forwardReturnPct)) - mean(shorts.map(row => row.forwardReturnPct))
}

function compareCandidates(left: FactorFamilyCandidate, right: FactorFamilyCandidate): number {
  return verdictScore(right.candidateVerdict) - verdictScore(left.candidateVerdict) ||
    Number(right.wfo.status === 'pass') - Number(left.wfo.status === 'pass') ||
    (left.wfo.failedWindowRatio ?? 1) - (right.wfo.failedWindowRatio ?? 1) ||
    (right.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) - (left.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) ||
    right.icIr - left.icIr ||
    right.meanIc - left.meanIc ||
    right.signalPeriods - left.signalPeriods
}

function verdictScore(verdict: CandidateVerdict): number {
  if (verdict === 'promising_diagnostic') return 2
  if (verdict === 'incubate_observation') return 1
  return 0
}

function buildReportBlockers(
  assetsLoaded: number,
  commonPeriods: number,
  best: FactorFamilyCandidate | null,
  args: CliArgs,
  routeCostRuntimeVerified: boolean,
): string[] {
  const blockers: string[] = []
  if (assetsLoaded < args.minUniverseSize) blockers.push(`loaded_universe_too_small:${assetsLoaded}<${args.minUniverseSize}`)
  if (commonPeriods < 1_000) blockers.push(`common_periods_low:${commonPeriods}<1000`)
  if (args.barMinutes !== 60) blockers.push('non_hourly_factor_family_research_only')
  if (!best) blockers.push('factor_family_candidate_missing')
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

function buildNextActions(best: FactorFamilyCandidate | null): string[] {
  if (!best) return [
    'Load enough fresh 1h live_accumulated assets, then rerun base factor-family diagnostics.',
    'Do not enable paper/live from this artifact.',
  ]
  const actions = [
    `Best base factor diagnostic: ${best.candidateId}; verdict=${best.candidateVerdict}, wfo=${best.wfo.status}, failRatio=${best.wfo.failedWindowRatio}.`,
    'Do not enable paper/live from this artifact; promote only after route cost, WFO, trial ledger, BY FDR, PIT, prospective labels, and paper evidence gates pass.',
  ]
  if (best.candidateVerdict !== 'promising_diagnostic') {
    actions.push('If base factors remain WFO-failed after future windows, prioritize data/execution evidence and stop adding model complexity.')
  } else {
    actions.push('Convert this factor into a locked prospective research lane before any execution discussion.')
  }
  return actions
}

function renderConsoleSummary(report: CryptoFactorFamilyReport): string {
  const lines = [
    `crypto factor family: configs=${report.configsEvaluated}, best=${report.best?.candidateId ?? 'none'}`,
    `status=${report.best?.candidateVerdict ?? 'missing'}, wfo=${report.best?.wfo.status ?? 'missing'}, failRatio=${report.best?.wfo.failedWindowRatio ?? 'missing'}`,
    `blockers=${report.blockers.join('|')}`,
  ]
  for (const row of report.topConfigs.slice(0, 8)) {
    lines.push([
      row.candidateId,
      row.candidateVerdict,
      `wfo=${row.wfo.status}`,
      `pass=${row.wfo.passedWindows}/${row.wfo.windowCount}`,
      `failRatio=${row.wfo.failedWindowRatio}`,
      `net=${row.netAfterRouteCostPct}`,
      `ic=${row.meanIc}`,
      `ir=${row.icIr}`,
      `win=${row.winRate}`,
    ].join(' | '))
  }
  return lines.join('\n')
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
): CryptoFactorFamilyReport['routeCost'] {
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

function buildStatsBySymbol(assets: AssetSeries[], barMinutes: number): Map<string, AssetStats[]> {
  const dailyBars = hoursToBars(24, barMinutes)
  return new Map(assets.map(asset => [asset.symbol, buildStats(asset.candles, dailyBars, barMinutes)]))
}

function buildStats(candles: Candle[], lookbackBars: number, barMinutes: number): AssetStats[] {
  const volumeUsdPrefix = [0]
  const returnPrefix = [0]
  const returnSqPrefix = [0]
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    const volumeUsd = candle.close > 0 && candle.volume > 0 ? candle.close * candle.volume : 0
    volumeUsdPrefix.push(volumeUsdPrefix[index] + volumeUsd)
    const previous = candles[index - 1]
    const ret = previous && previous.close > 0 && candle.close > 0 ? candle.close / previous.close - 1 : 0
    returnPrefix.push(returnPrefix[index] + ret)
    returnSqPrefix.push(returnSqPrefix[index] + ret ** 2)
  }
  return candles.map((_candle, index) => {
    const start = Math.max(0, index - lookbackBars + 1)
    const end = index + 1
    const dailyVolumeUsd = volumeUsdPrefix[end] - volumeUsdPrefix[start]
    const returnStart = Math.max(1, index - lookbackBars + 1)
    const returnEnd = index + 1
    const returnCount = Math.max(0, returnEnd - returnStart)
    const returnSum = returnPrefix[returnEnd] - returnPrefix[returnStart]
    const returnSqSum = returnSqPrefix[returnEnd] - returnSqPrefix[returnStart]
    const returnMean = returnCount > 0 ? returnSum / returnCount : 0
    const variance = returnCount > 1
      ? Math.max(0, returnSqSum / returnCount - returnMean ** 2)
      : 0
    return {
      dailyVolumeUsd,
      realizedVolPct: Math.sqrt(variance * 365 * 24 * 60 / barMinutes) * 100,
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

function parseNullablePath(raw: string | undefined): string | null {
  if (!raw) return null
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'null' || normalized === 'none' || normalized === 'false') return null
  return raw
}

function parseNumberList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback
  const values = raw.split(',').map(value => Number(value.trim())).filter(value => Number.isFinite(value) && value > 0)
  return values.length > 0 ? Array.from(new Set(values)).sort((left, right) => left - right) : fallback
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

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase())
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
