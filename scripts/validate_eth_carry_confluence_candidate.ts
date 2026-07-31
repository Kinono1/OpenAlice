import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { paperSymbolToCsvFile, type PaperUniverseTimeframe } from './lib/paper_universe.js'
import type { EthCarryPitFeatureRow } from './build_eth_carry_pit_feature_dataset.js'

type UnknownRecord = Record<string, unknown>
type Direction = 'short_eth_long_btc' | 'long_eth_short_btc'
type Sign = 'positive' | 'negative' | 'zero' | 'missing'

interface CliArgs {
  confluenceCandidatePath: string
  featurePath: string
  dataDir: string
  outputPath: string | null
  barMinutes: number
  labelDelayHours: number
  maxFeatureRows: number | null
  minTrades: number
  minWindows: number
  minWinRatePct: number
  minMeanNetPct: number
  routeCostPct: number
  json: boolean
}

interface Candle {
  timeMs: number
  close: number
}

interface ValidationTrade {
  featureId: string
  decisionTime: string
  closeTime: string
  direction: Direction
  fundingSpread: number | null
  basisSpreadDiffPct: number
  grossPct: number
  fundingCashflowPct: number
  routeCostPct: number
  netPct: number
  profitableNet: boolean
}

interface ValidationWindow {
  windowIndex: number
  startTime: string | null
  endTime: string | null
  tradeCount: number
  meanNetPct: number | null
  winRatePct: number | null
  gatePassed: boolean
  blockers: string[]
}

export interface EthCarryConfluenceValidationReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: 'blocked_missing_inputs' | 'blocked_insufficient_evidence' | 'research_validation_passed_observation_only'
  sourceArtifacts: {
    confluenceCandidatePath: string
    featurePath: string
    dataDir: string
  }
  thresholds: {
    barMinutes: number
    labelDelayHours: number
    maxFeatureRows: number | null
    minTrades: number
    minWindows: number
    minWinRatePct: number
    minMeanNetPct: number
    routeCostPct: number
  }
  candidate: {
    candidateId: string | null
    sourceBucketId: string | null
    fundingSpreadSign: Sign | null
    basisSpreadDiffPctSign: Sign | null
    direction: Direction | null
  }
  counts: {
    featureRowsLoaded: number
    featureRowsAfterRule: number
    tradesBuilt: number
    skippedNoDecisionCandle: number
    skippedNoCloseCandle: number
    skippedFundingCashflowUnavailable: number
  }
  summary: {
    meanGrossPct: number | null
    meanFundingCashflowPct: number | null
    meanNetPct: number | null
    winRatePct: number | null
    tradeCount: number
    passedWindows: number
    failedWindows: number
  }
  windows: ValidationWindow[]
  sampleTrades: ValidationTrade[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_CONFLUENCE_CANDIDATE_PATH = 'data/research/eth_carry_confluence_candidate_status.latest.json'
const DEFAULT_FEATURE_PATH = 'data/research/eth_carry_pit_features.latest.json'
const DEFAULT_DATA_DIR = 'data/market/live_5m'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_confluence_validation.latest.json'
const DEFAULT_BAR_MINUTES = 5
const DEFAULT_LABEL_DELAY_HOURS = 8
const DEFAULT_MIN_TRADES = 100
const DEFAULT_MIN_WINDOWS = 3
const DEFAULT_MIN_WIN_RATE_PCT = 55
const DEFAULT_MIN_MEAN_NET_PCT = 0
const DEFAULT_ROUTE_COST_PCT = 0.2

async function main(): Promise<void> {
  const args = parseEthCarryConfluenceValidationArgs(process.argv.slice(2))
  const report = await runEthCarryConfluenceValidation(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseEthCarryConfluenceValidationArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    confluenceCandidatePath: raw.get('confluenceCandidatePath') ?? raw.get('candidatePath') ?? DEFAULT_CONFLUENCE_CANDIDATE_PATH,
    featurePath: raw.get('featurePath') ?? raw.get('features') ?? DEFAULT_FEATURE_PATH,
    dataDir: raw.get('dataDir') ?? DEFAULT_DATA_DIR,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    barMinutes: parsePositiveInteger(raw.get('barMinutes'), DEFAULT_BAR_MINUTES, 'barMinutes'),
    labelDelayHours: parsePositiveInteger(raw.get('labelDelayHours'), DEFAULT_LABEL_DELAY_HOURS, 'labelDelayHours'),
    maxFeatureRows: parseNullablePositiveInteger(raw.get('maxFeatureRows'), null, 'maxFeatureRows'),
    minTrades: parsePositiveInteger(raw.get('minTrades'), DEFAULT_MIN_TRADES, 'minTrades'),
    minWindows: parsePositiveInteger(raw.get('minWindows'), DEFAULT_MIN_WINDOWS, 'minWindows'),
    minWinRatePct: parseFiniteNumber(raw.get('minWinRatePct'), DEFAULT_MIN_WIN_RATE_PCT, 'minWinRatePct'),
    minMeanNetPct: parseFiniteNumber(raw.get('minMeanNetPct'), DEFAULT_MIN_MEAN_NET_PCT, 'minMeanNetPct'),
    routeCostPct: parseFiniteNumber(raw.get('routeCostPct'), DEFAULT_ROUTE_COST_PCT, 'routeCostPct'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryConfluenceValidation(
  args: CliArgs,
): Promise<EthCarryConfluenceValidationReport> {
  const startedAt = new Date()
  const confluenceCandidatePath = resolve(args.confluenceCandidatePath)
  const featurePath = resolve(args.featurePath)
  const dataDir = resolve(args.dataDir)
  const report = buildEthCarryConfluenceValidationReport({
    generatedAt: new Date().toISOString(),
    confluenceCandidatePath,
    featurePath,
    dataDir,
    candidateArtifact: readJsonIfExists(confluenceCandidatePath),
    featureRows: readCarryFeatureRows(featurePath, args.maxFeatureRows),
    ethCandles: readCandles(dataDir, 'ETH-USDT', args.barMinutes),
    btcCandles: readCandles(dataDir, 'BTC-USDT', args.barMinutes),
    args,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_confluence_validation',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked_missing_inputs' ? 'fail' : 'warn',
      recordsIn: report.counts.featureRowsLoaded,
      recordsOut: report.counts.tradesBuilt,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildEthCarryConfluenceValidationReport(input: {
  generatedAt?: string
  confluenceCandidatePath: string
  featurePath: string
  dataDir: string
  candidateArtifact?: unknown
  featureRows: EthCarryPitFeatureRow[]
  ethCandles: Candle[]
  btcCandles: Candle[]
  args: Pick<CliArgs, 'barMinutes' | 'labelDelayHours' | 'maxFeatureRows' | 'minTrades' | 'minWindows' | 'minWinRatePct' | 'minMeanNetPct' | 'routeCostPct'>
}): EthCarryConfluenceValidationReport {
  const candidate = parseCandidateRule(input.candidateArtifact)
  const missingInputBlockers = uniqueStrings([
    ...(existsSync(input.confluenceCandidatePath) ? [] : ['confluence_candidate_status_missing']),
    ...(existsSync(input.featurePath) ? [] : ['eth_carry_pit_feature_dataset_missing']),
    ...(candidate.candidateId ? [] : ['recommended_confluence_candidate_missing']),
    ...(candidate.direction ? [] : ['recommended_confluence_direction_missing']),
    ...(input.ethCandles.length > 0 ? [] : ['decision_candles_missing:ETH-USDT']),
    ...(input.btcCandles.length > 0 ? [] : ['decision_candles_missing:BTC-USDT']),
  ])
  const filteredRows = candidate.direction
    ? input.featureRows.filter(row => rowMatchesRule(row, candidate))
    : []
  const tradeBuild = buildValidationTrades({
    rows: filteredRows,
    ethCandles: input.ethCandles,
    btcCandles: input.btcCandles,
    labelDelayHours: input.args.labelDelayHours,
    routeCostPct: input.args.routeCostPct,
    direction: candidate.direction,
  })
  const windows = buildWindows({
    trades: tradeBuild.trades,
    minWindows: input.args.minWindows,
    minWinRatePct: input.args.minWinRatePct,
    minMeanNetPct: input.args.minMeanNetPct,
  })
  const passedWindows = windows.filter(window => window.gatePassed).length
  const failedWindows = windows.filter(window => !window.gatePassed).length
  const summary = {
    meanGrossPct: meanNullable(tradeBuild.trades.map(trade => trade.grossPct)),
    meanFundingCashflowPct: meanNullable(tradeBuild.trades.map(trade => trade.fundingCashflowPct)),
    meanNetPct: meanNullable(tradeBuild.trades.map(trade => trade.netPct)),
    winRatePct: winRate(tradeBuild.trades.map(trade => trade.profitableNet)),
    tradeCount: tradeBuild.trades.length,
    passedWindows,
    failedWindows,
  }
  const blockers = uniqueStrings([
    ...missingInputBlockers,
    ...(filteredRows.length > 0 ? [] : ['confluence_rule_feature_rows_missing']),
    ...(tradeBuild.trades.length >= input.args.minTrades
      ? []
      : [`confluence_validation_trades_low:${tradeBuild.trades.length}<${input.args.minTrades}`]),
    ...(windows.length >= input.args.minWindows
      ? []
      : [`confluence_validation_windows_low:${windows.length}<${input.args.minWindows}`]),
    ...(summary.meanNetPct != null && summary.meanNetPct > input.args.minMeanNetPct
      ? []
      : [`confluence_validation_mean_net_not_positive:${summary.meanNetPct ?? 'missing'}<=${input.args.minMeanNetPct}`]),
    ...(summary.winRatePct != null && summary.winRatePct >= input.args.minWinRatePct
      ? []
      : [`confluence_validation_win_rate_low:${summary.winRatePct ?? 'missing'}<${input.args.minWinRatePct}`]),
    ...(failedWindows === 0 && windows.length >= input.args.minWindows
      ? []
      : [`confluence_validation_failed_windows:${failedWindows}`]),
    'research_only_not_execution_evidence',
    'paper_live_execution_disabled',
    'requires_independent_wfo_by_fdr_route_cost_risk_and_paper_telemetry',
  ])
  const status = missingInputBlockers.length > 0
    ? 'blocked_missing_inputs'
    : blockers.every(blocker =>
        blocker === 'research_only_not_execution_evidence' ||
        blocker === 'paper_live_execution_disabled' ||
        blocker === 'requires_independent_wfo_by_fdr_route_cost_risk_and_paper_telemetry')
      ? 'research_validation_passed_observation_only'
      : 'blocked_insufficient_evidence'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status,
    sourceArtifacts: {
      confluenceCandidatePath: resolve(input.confluenceCandidatePath),
      featurePath: resolve(input.featurePath),
      dataDir: resolve(input.dataDir),
    },
    thresholds: {
      barMinutes: input.args.barMinutes,
      labelDelayHours: input.args.labelDelayHours,
      maxFeatureRows: input.args.maxFeatureRows,
      minTrades: input.args.minTrades,
      minWindows: input.args.minWindows,
      minWinRatePct: input.args.minWinRatePct,
      minMeanNetPct: input.args.minMeanNetPct,
      routeCostPct: input.args.routeCostPct,
    },
    candidate,
    counts: {
      featureRowsLoaded: input.featureRows.length,
      featureRowsAfterRule: filteredRows.length,
      tradesBuilt: tradeBuild.trades.length,
      skippedNoDecisionCandle: tradeBuild.skippedNoDecisionCandle,
      skippedNoCloseCandle: tradeBuild.skippedNoCloseCandle,
      skippedFundingCashflowUnavailable: tradeBuild.skippedFundingCashflowUnavailable,
    },
    summary,
    windows,
    sampleTrades: tradeBuild.trades.slice(-20),
    blockers,
    nextActions: buildNextActions(status, candidate.candidateId),
    safetyNotes: [
      'This validation is research-only and does not update release gates, paper targets, live orders, or best_config.json.',
      'The decision bar is strictly after feature decisionAvailableAt; close labels are strictly after decisionTime plus labelDelayHours.',
      'This artifact is an offline filter diagnostic, not BY/FDR-complete promotion evidence.',
      'Paper and live remain disabled until the full release gate stack passes with real telemetry.',
    ],
  }
}

function parseCandidateRule(candidateArtifact: unknown): EthCarryConfluenceValidationReport['candidate'] {
  const artifact = asRecord(candidateArtifact)
  const candidate = asRecord(artifact?.recommendedCandidate)
  const rule = asRecord(candidate?.rule)
  return {
    candidateId: readString(candidate?.candidateId),
    sourceBucketId: readString(candidate?.sourceBucketId),
    fundingSpreadSign: readSign(rule?.fundingSpreadSign),
    basisSpreadDiffPctSign: readSign(rule?.basisSpreadDiffPctSign),
    direction: readDirection(rule?.direction),
  }
}

function rowMatchesRule(
  row: EthCarryPitFeatureRow,
  candidate: EthCarryConfluenceValidationReport['candidate'],
): boolean {
  if (row.blockers.length > 0) return false
  if (!row.requiredFields.explicitAvailableAt || !row.requiredFields.basisSpread || !row.requiredFields.fundingRateCashflow) return false
  if (candidate.direction && resolveDirection(row) !== candidate.direction) return false
  if (candidate.fundingSpreadSign && signOf(row.fundingSpread) !== candidate.fundingSpreadSign) return false
  if (candidate.basisSpreadDiffPctSign && signOf(row.basisSpreadDiffPct) !== candidate.basisSpreadDiffPctSign) return false
  return true
}

function buildValidationTrades(input: {
  rows: EthCarryPitFeatureRow[]
  ethCandles: Candle[]
  btcCandles: Candle[]
  labelDelayHours: number
  routeCostPct: number
  direction: Direction | null
}): {
  trades: ValidationTrade[]
  skippedNoDecisionCandle: number
  skippedNoCloseCandle: number
  skippedFundingCashflowUnavailable: number
} {
  const ethByTime = new Map(input.ethCandles.map(candle => [candle.timeMs, candle]))
  const btcByTime = new Map(input.btcCandles.map(candle => [candle.timeMs, candle]))
  const pairTimes = input.ethCandles
    .map(candle => candle.timeMs)
    .filter(timeMs => btcByTime.has(timeMs))
    .sort((left, right) => left - right)
  const trades: ValidationTrade[] = []
  let skippedNoDecisionCandle = 0
  let skippedNoCloseCandle = 0
  let skippedFundingCashflowUnavailable = 0

  for (const row of input.rows) {
    const decisionTime = pairTimes.find(timeMs => timeMs > row.decisionAvailableAtMs)
    if (decisionTime == null) {
      skippedNoDecisionCandle += 1
      continue
    }
    const closeTime = decisionTime + input.labelDelayHours * 3_600_000
    if (!ethByTime.has(closeTime) || !btcByTime.has(closeTime)) {
      skippedNoCloseCandle += 1
      continue
    }
    const direction = input.direction ?? resolveDirection(row)
    const ethEntry = ethByTime.get(decisionTime)!
    const btcEntry = btcByTime.get(decisionTime)!
    const ethClose = ethByTime.get(closeTime)!
    const btcClose = btcByTime.get(closeTime)!
    const fundingCashflowPct = computeFundingCashflowPct(row, direction, decisionTime, closeTime)
    if (fundingCashflowPct == null) {
      skippedFundingCashflowUnavailable += 1
      continue
    }
    const grossPct = direction === 'short_eth_long_btc'
      ? pctReturn(btcEntry.close, btcClose.close) - pctReturn(ethEntry.close, ethClose.close)
      : pctReturn(ethEntry.close, ethClose.close) - pctReturn(btcEntry.close, btcClose.close)
    const netPct = grossPct + fundingCashflowPct - input.routeCostPct
    trades.push({
      featureId: row.featureId,
      decisionTime: new Date(decisionTime).toISOString(),
      closeTime: new Date(closeTime).toISOString(),
      direction,
      fundingSpread: row.fundingSpread,
      basisSpreadDiffPct: row.basisSpreadDiffPct,
      grossPct: round(grossPct, 10),
      fundingCashflowPct: round(fundingCashflowPct, 10),
      routeCostPct: input.routeCostPct,
      netPct: round(netPct, 10),
      profitableNet: netPct > 0,
    })
  }
  return {
    trades,
    skippedNoDecisionCandle,
    skippedNoCloseCandle,
    skippedFundingCashflowUnavailable,
  }
}

function computeFundingCashflowPct(
  row: EthCarryPitFeatureRow,
  direction: Direction,
  decisionTime: number,
  closeTime: number,
): number | null {
  if (row.ethFundingRate == null || row.btcFundingRate == null) return null
  let cashflow = 0
  const ethNext = parseNullableTime(row.ethNextFundingTime)
  const btcNext = parseNullableTime(row.btcNextFundingTime)
  if (ethNext != null && ethNext > decisionTime && ethNext <= closeTime) {
    cashflow += direction === 'short_eth_long_btc' ? row.ethFundingRate * 100 : -row.ethFundingRate * 100
  }
  if (btcNext != null && btcNext > decisionTime && btcNext <= closeTime) {
    cashflow += direction === 'short_eth_long_btc' ? -row.btcFundingRate * 100 : row.btcFundingRate * 100
  }
  return cashflow
}

function buildWindows(input: {
  trades: ValidationTrade[]
  minWindows: number
  minWinRatePct: number
  minMeanNetPct: number
}): ValidationWindow[] {
  if (input.trades.length === 0) return []
  const windowCount = Math.max(input.minWindows, 1)
  const sorted = [...input.trades].sort((left, right) => Date.parse(left.decisionTime) - Date.parse(right.decisionTime))
  const chunkSize = Math.ceil(sorted.length / windowCount)
  const windows: ValidationWindow[] = []
  for (let index = 0; index < windowCount; index += 1) {
    const trades = sorted.slice(index * chunkSize, (index + 1) * chunkSize)
    if (trades.length === 0) continue
    const meanNetPct = meanNullable(trades.map(trade => trade.netPct))
    const winRatePct = winRate(trades.map(trade => trade.profitableNet))
    const blockers = uniqueStrings([
      ...(meanNetPct != null && meanNetPct > input.minMeanNetPct
        ? []
        : [`window_mean_net_not_positive:${meanNetPct ?? 'missing'}<=${input.minMeanNetPct}`]),
      ...(winRatePct != null && winRatePct >= input.minWinRatePct
        ? []
        : [`window_win_rate_low:${winRatePct ?? 'missing'}<${input.minWinRatePct}`]),
    ])
    windows.push({
      windowIndex: index,
      startTime: trades[0]?.decisionTime ?? null,
      endTime: trades.at(-1)?.decisionTime ?? null,
      tradeCount: trades.length,
      meanNetPct,
      winRatePct,
      gatePassed: blockers.length === 0,
      blockers,
    })
  }
  return windows
}

function readCarryFeatureRows(path: string, maxRows: number | null): EthCarryPitFeatureRow[] {
  const resolvedPath = resolve(path)
  if (!existsSync(resolvedPath)) return []
  const parsed = asRecord(JSON.parse(readFileSync(resolvedPath, 'utf-8')))
  const rows = readRecordArray(parsed?.carryFeatureRows)
    .map(asCarryFeatureRow)
    .filter((row): row is EthCarryPitFeatureRow => row != null)
  return maxRows != null ? rows.slice(-maxRows) : rows
}

function asCarryFeatureRow(value: unknown): EthCarryPitFeatureRow | null {
  const row = asRecord(value)
  const requiredFields = asRecord(row?.requiredFields)
  const sourceFeatures = asRecord(row?.sourceFeatures)
  const featureId = readString(row?.featureId)
  const decisionAvailableAt = readString(row?.decisionAvailableAt)
  const decisionAvailableAtMs = readNumber(row?.decisionAvailableAtMs)
  if (!row || !requiredFields || !sourceFeatures || !featureId || !decisionAvailableAt || decisionAvailableAtMs == null) return null
  return {
    featureId,
    exchange: readString(row.exchange) ?? 'unknown',
    market: readString(row.market) ?? 'unknown',
    strategyFamily: 'funding_carry_rebuild',
    symbols: {
      leader: 'ETHUSDT',
      hedge: 'BTCUSDT',
    },
    decisionAvailableAt,
    decisionAvailableAtMs,
    pairSkewMs: readNumber(row.pairSkewMs) ?? 0,
    fundingSpread: readNumber(row.fundingSpread),
    basisSpreadDiffPct: readNumber(row.basisSpreadDiffPct) ?? 0,
    ethFundingRate: readNumber(row.ethFundingRate),
    btcFundingRate: readNumber(row.btcFundingRate),
    ethBasisSpreadPct: readNumber(row.ethBasisSpreadPct) ?? 0,
    btcBasisSpreadPct: readNumber(row.btcBasisSpreadPct) ?? 0,
    ethNextFundingTime: readString(row.ethNextFundingTime),
    btcNextFundingTime: readString(row.btcNextFundingTime),
    requiredFields: {
      fundingRateCashflow: readBoolean(requiredFields.fundingRateCashflow) === true,
      basisSpread: readBoolean(requiredFields.basisSpread) === true,
      explicitAvailableAt: readBoolean(requiredFields.explicitAvailableAt) === true,
    },
    sourceFeatures: {
      ethBasisFeatureId: readString(sourceFeatures.ethBasisFeatureId) ?? '',
      btcBasisFeatureId: readString(sourceFeatures.btcBasisFeatureId) ?? '',
    },
    blockers: readStringArray(row.blockers),
  }
}

function readCandles(dataDir: string, symbol: 'ETH-USDT' | 'BTC-USDT', barMinutes: number): Candle[] {
  const timeframe = `${barMinutes === 60 ? '1h' : `${barMinutes}m`}` as PaperUniverseTimeframe
  const path = join(dataDir, paperSymbolToCsvFile(symbol, timeframe))
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseCandle)
    .filter((candle): candle is Candle => candle != null)
    .sort((left, right) => left.timeMs - right.timeMs)
}

function parseCandle(line: string): Candle | null {
  const [timestamp, , , , , close] = line.split(',')
  const timeMs = Number(timestamp)
  const closeNumber = Number(close)
  if (!Number.isFinite(timeMs) || !Number.isFinite(closeNumber) || closeNumber <= 0) return null
  return { timeMs, close: closeNumber }
}

function resolveDirection(row: EthCarryPitFeatureRow): Direction {
  if (row.fundingSpread != null && row.fundingSpread !== 0) {
    return row.fundingSpread > 0 ? 'short_eth_long_btc' : 'long_eth_short_btc'
  }
  return row.basisSpreadDiffPct > 0 ? 'short_eth_long_btc' : 'long_eth_short_btc'
}

function signOf(value: number | null): Sign {
  if (value == null) return 'missing'
  if (value > 0) return 'positive'
  if (value < 0) return 'negative'
  return 'zero'
}

function pctReturn(entry: number, exit: number): number {
  return entry > 0 ? ((exit / entry) - 1) * 100 : 0
}

function parseNullableTime(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function buildNextActions(status: EthCarryConfluenceValidationReport['status'], candidateId: string | null): string[] {
  const actions = [
    'Keep the confluence validator research-only; do not mutate paper/live/release artifacts.',
  ]
  if (status !== 'research_validation_passed_observation_only') {
    actions.push('Do not expand this candidate until trade count, mean net, win-rate, and window stability blockers are cleared.')
  }
  if (candidateId) {
    actions.push(`If blockers improve, register ${candidateId} as a research-only trial with complete BY/FDR accounting before any prospective expansion.`)
  }
  actions.push('Continue prospective labels; this offline diagnostic is not a substitute for future-only evidence.')
  return actions
}

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
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
  return normalized === '' || normalized === 'null' || normalized === 'none' || normalized === 'false' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function parseNullablePositiveInteger(value: string | undefined, fallback: number | null, label: string): number | null {
  if (value == null || ['null', 'none', 'false', ''].includes(value.trim().toLowerCase())) return fallback
  return parsePositiveInteger(value, fallback ?? 1, label)
}

function parseFiniteNumber(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`)
  return parsed
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []
}

function readSign(value: unknown): Sign | null {
  return value === 'positive' || value === 'negative' || value === 'zero' || value === 'missing' ? value : null
}

function readDirection(value: unknown): Direction | null {
  return value === 'short_eth_long_btc' || value === 'long_eth_short_btc' ? value : null
}

function meanNullable(values: number[]): number | null {
  return values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 10) : null
}

function winRate(values: boolean[]): number | null {
  return values.length > 0 ? round(values.filter(Boolean).length / values.length * 100, 10) : null
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function renderConsoleSummary(report: EthCarryConfluenceValidationReport): string {
  return [
    `eth carry confluence validation: status=${report.status}`,
    `candidate=${report.candidate.candidateId ?? 'none'} trades=${report.counts.tradesBuilt}/${report.thresholds.minTrades}`,
    `meanNet=${report.summary.meanNetPct ?? 'null'} win=${report.summary.winRatePct ?? 'null'} windows=${report.summary.passedWindows}/${report.windows.length}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('validate_eth_carry_confluence_candidate failed:', error)
    process.exitCode = 1
  })
}
