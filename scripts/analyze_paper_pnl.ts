/**
 * Paper PnL diagnostics for OpenAlice paper-only strategy lanes.
 *
 * Reads paper trade results and account trade histories, then writes a
 * structured loss-attribution report for Pro review and local debugging.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

export interface AnalyzePaperPnlArgs {
  paperDir: string
  runtimeDir: string
  outputPath: string
  lookbackHours: number | null
  topN: number
}

export type ContextCoverageBucket =
  | 'ok'
  | 'stale'
  | 'timeout'
  | 'legacy_missing'
  | 'new_missing'

export interface NormalizedPaperTrade {
  tradeId: string
  source: string
  lane: string
  accountId: string | null
  accountLabel: string | null
  symbol: string
  side: 'long' | 'short' | 'unknown'
  leverage: number | null
  openTs: string
  closeTs: string
  openPrice: number | null
  closePrice: number | null
  pnlPct: number
  pnlUsd: number | null
  closeReason: string
  rawReason: string | null
  holdingSeconds: number | null
  closeHourUtc: number | null
  priceSource: string | null
  priceStale: boolean | null
  volumeRatioAtOpen: number | null
  breakQualityAtOpen: number | string | null
  liquidityUsdAtOpen: number | null
  liquidityStatusAtOpen: string | null
  spreadStatusAtOpen: string | null
  spreadBpsAtOpen: number | null
  rankAtOpen: number | null
  rankSpreadPctAtOpen: number | null
  estimatedRoundTripCostPctAtOpen: number | null
  estimatedRoundTripCostPctOfMarginAtOpen: number | null
  expectedGrossEdgePctAtOpen?: number | null
  expectedNetEdgePctAtOpen?: number | null
  expectedEdgeSourceAtOpen?: string | null
  routeCostBpsAtOpen: number | null
  roundTripCostBpsAtOpen: number | null
  markPriceAtOpen: number | null
  markPriceTimestampAtOpen: string | null
  matchPriceAtOpen: number | null
  matchPriceSourceAtOpen: string | null
  markMatchPenaltyBpsAtOpen: number | null
  markMatchStatusAtOpen: string | null
  realizedRoundTripCostBps: number | null
  realizedCostBps: number | null
  fillAdjustedCostBps: number | null
  fillAdjustedCostPct: number | null
  costEvidenceSource: string | null
  costEvidenceStatus: string | null
  predictedOpenEvidenceStatus: string | null
  predictedOpenEvidenceReason: string | null
  mfeBps: number | null
  maeBps: number | null
  timeToMfeSec: number | null
  timeToMaeSec: number | null
  timeToStopSec: number | null
  mfeBeforeStop: boolean | null
  signalConfidenceAtOpen: number | null
  contextSnapshotId: string | null
  decisionTime: string | null
  marketDataWatermarkAtDecisionTime: string | null
  watermark: string | null
  featuresAvailableAtDecisionTime: boolean | null
  featureSchemaVersion: string | null
  flashContextStatus: string | null
  contextStatus: string | null
  contextReason: string | null
  contextCoverageStatus: string | null
  contextCoverageReason: string | null
  contextGenerationAtOpen: number | null
  flashConfidenceLowAtOpen: number | null
  ruleScoreAtOpen: number | null
  proEpochAtOpen: number | null
  marketIntelTriggerAtOpen: string | null
  regimeAtOpen: string | null
  contextCoverageBucket: ContextCoverageBucket
  liquidated: boolean
}

export interface AccountSnapshotSummary {
  path: string
  accountId: string
  equity: number | null
  initialEquity: number | null
  returnPct: number | null
  openPositions: number
  openPositionEvidence: {
    completeV3Context: number
    completeCost: number
    legacyMissingContext: number
    newMissingContext: number
    missingCost: number
    risk: 'none' | 'legacy_will_close_dirty' | 'new_missing_context_or_cost'
  }
}

export interface GroupStats {
  key: string
  count: number
  wins: number
  losses: number
  flats: number
  winRate: number
  totalPnlPct: number
  avgPnlPct: number
  medianPnlPct: number
  totalPnlUsd: number | null
  avgPnlUsd: number | null
  avgHoldingSeconds: number | null
  profitFactor: number | null
  maxConsecutiveLosses: number
  worstTrade: Pick<NormalizedPaperTrade, 'tradeId' | 'lane' | 'symbol' | 'side' | 'pnlPct' | 'pnlUsd' | 'closeReason' | 'closeTs'> | null
  bestTrade: Pick<NormalizedPaperTrade, 'tradeId' | 'lane' | 'symbol' | 'side' | 'pnlPct' | 'pnlUsd' | 'closeReason' | 'closeTs'> | null
}

export interface ContextCoverageBucketSummary {
  bucket: ContextCoverageBucket
  count: number
  sharePct: number
}

export interface LaneCoverageSummary {
  lane: string
  closedTrades: number
  coveredTrades: number
  missingTrades: number
  coveragePct: number
}

export interface ContextEnforcementWindowSummary {
  cutoverTs: string
  enforcementTs: string
  status: 'ok' | 'new_missing' | 'insufficient_data'
  closedTrades: number
  okContextTrades: number
  newMissingContextTrades: number
  legacyMissingContextTrades: number
  staleContextTrades: number
  timeoutContextTrades: number
  dirtyHistoricalNewMissingTrades: number
  contextCoveragePct: number
}

export interface CostEvidenceCoverageSummary {
  status: 'ok' | 'partial' | 'missing' | 'insufficient_data'
  closedTrades: number
  tradesWithAnyPredictedCost: number
  tradesMissingAnyPredictedCost: number
  anyPredictedCostCoveragePct: number
  tradesWithRouteCostBps: number
  tradesWithRoundTripCostBps: number
  tradesWithEstimatedRoundTripCostPct: number
  tradesWithEstimatedRoundTripCostPctOfMargin: number
  tradesWithExpectedGrossEdge: number
  tradesWithExpectedNetEdge: number
  tradesWithExpectedEdgeSource: number
  tradesWithOpenTimeMarkMatchEvidence: number
  tradesWithCompletePredictedOpenEvidence: number
  completePredictedOpenEvidenceCoveragePct: number
  tradesWithAnyRealizedCost: number
  tradesWithFillAdjustedCost: number
  tradesWithPaperModelCostEvidence: number
  tradesWithExchangeReconciledCostEvidence: number
  markMatchStatusCounts: Record<string, number>
  markMatchPenaltyTrades: number
  staleOrMissingMarkMatchTrades: number
  invalidMarkMatchTrades: number
  newWindow: {
    cutoverTs: string
    enforcementTs: string
    producerGuardEnforcementTs: string
    status: 'ok' | 'missing' | 'insufficient_data'
    closedTrades: number
    tradesWithCompletePredictedOpenEvidence: number
    tradesMissingCompletePredictedOpenEvidence: number
    transitionalDirtyMissingPredictedOpenEvidence: number
    producerGuardMissingPredictedOpenEvidence: number
    completePredictedOpenEvidenceCoveragePct: number
  }
  byLane: LaneCoverageSummary[]
}

export interface MfeMaeCoverageSummary {
  status: 'ok' | 'partial' | 'missing' | 'insufficient_data'
  ledgerStatus: 'ok' | 'partial' | 'missing' | 'insufficient_data'
  closedTrades: number
  tradesWithMfeBps: number
  tradesWithMaeBps: number
  tradesWithBothMfeMaeBps: number
  tradesMissingBothMfeMaeBps: number
  bothMfeMaeCoveragePct: number
  tradesWithTimeToMfeSec: number
  tradesWithTimeToMaeSec: number
  stopLossTrades: number
  stopLossTradesWithTimeToStopSec: number
  stopLossTimeCoveragePct: number
  byLane: LaneCoverageSummary[]
  pathDiagnostics: {
    status: 'ok' | 'partial' | 'missing' | 'insufficient_data' | 'stale_mismatch'
    sourcePath: string | null
    matchedTrades: number
    missingTradeDiagnostics: number
    unmatchedDiagnostics: number
    diagnosticsOk: number
    missingPricePath: number
    pricePathMismatch: number
    invalidTradePrices: number
    stopLossTrades: number
    stopLossDiagnosticsOk: number
    notes: string[]
  }
}

export interface StopLossRollingDiagnostic {
  scopeType: 'overall' | 'lane' | 'symbol' | 'side' | 'lane_symbol' | 'lane_symbol_side'
  scopeKey: string
  triggered: boolean
  windowStartTs: string | null
  windowEndTs: string | null
  closedTrades: number
  stopLossCount: number
  stopLossLossSharePct: number
  stopLossLossPct: number
  totalLossPct: number
}

export interface StopLossClusterOffender {
  dimension:
    | 'lane'
    | 'symbol'
    | 'side'
    | 'lane_symbol_side'
    | 'regime'
    | 'context_bucket'
    | 'volume_ratio_bucket'
    | 'break_quality_bucket'
    | 'liquidity_usd_bucket'
    | 'liquidity_status'
    | 'spread_status'
    | 'spread_bps_bucket'
    | 'route_cost_bps_bucket'
    | 'round_trip_cost_bps_bucket'
    | 'mark_match_status'
    | 'mark_match_penalty_bps_bucket'
    | 'mfe_bps_bucket'
    | 'mae_bps_bucket'
    | 'mfe_before_stop'
    | 'time_to_stop_bucket'
    | 'holding_bucket'
  key: string
  closedTrades: number
  stopLossCount: number
  stopLossLossSharePct: number
  stopLossLossPct: number
  totalLossPct: number
  avgHoldingSeconds: number | null
  blockedBy: string[]
  nextAction: string
}

export interface StopLossClusterAttribution {
  status: 'triggered' | 'not_triggered' | 'insufficient_data'
  blockedBy: string[]
  nextAction: string
  evaluatedTrades: number
  stopLossTrades: number
  topOffenders: {
    lanes: StopLossClusterOffender[]
    symbols: StopLossClusterOffender[]
    sides: StopLossClusterOffender[]
    laneSymbolSides: StopLossClusterOffender[]
    regimes: StopLossClusterOffender[]
    contextBuckets: StopLossClusterOffender[]
    volumeRatioBuckets: StopLossClusterOffender[]
    breakQualityBuckets: StopLossClusterOffender[]
    liquidityUsdBuckets: StopLossClusterOffender[]
    liquidityStatuses: StopLossClusterOffender[]
    spreadStatuses: StopLossClusterOffender[]
    spreadBpsBuckets: StopLossClusterOffender[]
    routeCostBpsBuckets: StopLossClusterOffender[]
    roundTripCostBpsBuckets: StopLossClusterOffender[]
    markMatchStatuses: StopLossClusterOffender[]
    markMatchPenaltyBpsBuckets: StopLossClusterOffender[]
    mfeBpsBuckets: StopLossClusterOffender[]
    maeBpsBuckets: StopLossClusterOffender[]
    mfeBeforeStopBuckets: StopLossClusterOffender[]
    timeToStopBuckets: StopLossClusterOffender[]
    holdingBuckets: StopLossClusterOffender[]
  }
}

export interface PaperPnlDiagnosticsReport {
  schemaVersion: 1
  generatedAt: string
  inputs: {
    paperDir: string
    runtimeDir: string
    outputPath: string
    lookbackHours: number | null
  }
  coverage: {
    closedTrades: number
    skippedOpenTrades: number
    duplicateTradesSkipped: number
    earliestCloseTs: string | null
    latestCloseTs: string | null
    missingRuleScoreTrades: number
    missingFlashConfidenceTrades: number
    contextBuckets: ContextCoverageBucketSummary[]
    legacyMissingContextTrades: number
    newMissingContextTrades: number
    staleContextTrades: number
    timeoutContextTrades: number
    okContextTrades: number
    contextEnforcementWindow: ContextEnforcementWindowSummary
    costEvidence: CostEvidenceCoverageSummary
    mfeMaeEvidence: MfeMaeCoverageSummary
  }
  overall: GroupStats
  accounts: AccountSnapshotSummary[]
  byLane: GroupStats[]
  bySymbol: GroupStats[]
  bySide: GroupStats[]
  byCloseReason: GroupStats[]
  byLeverage: GroupStats[]
  byCloseHourUtc: GroupStats[]
  byRuleScoreBucket: GroupStats[]
  byFlashConfidenceLowBucket: GroupStats[]
  byContextCoverageBucket: GroupStats[]
  byVolumeRatioBucket: GroupStats[]
  byBreakQualityBucket: GroupStats[]
  byLiquidityStatus: GroupStats[]
  bySpreadStatus: GroupStats[]
  bySpreadBpsBucket: GroupStats[]
  byRankBucket: GroupStats[]
  byRankSpreadBucket: GroupStats[]
  byEstimatedRoundTripCostBucket: GroupStats[]
  byEstimatedRoundTripCostOfMarginBucket: GroupStats[]
  bySignalConfidenceBucket: GroupStats[]
  byHoldingBucket: GroupStats[]
  stopLossRollingDiagnostics: {
    diagnosticUse: 'descriptive_worst_window_scan'
    promotionEligible: false
    maxSelectionBias: true
    windowDays: number
    thresholds: {
      stopLossCount: number
      stopLossLossSharePct: number
      closedTrades: number
    }
    windowsSearched: number
    scopesSearched: number
    triggered: boolean
    triggers: StopLossRollingDiagnostic[]
    scopes: StopLossRollingDiagnostic[]
    clusterAttribution: StopLossClusterAttribution
  }
  topLossContributors: {
    lanes: GroupStats[]
    symbols: GroupStats[]
    closeReasons: GroupStats[]
    hours: GroupStats[]
  }
  openRisk: {
    totalOpenPositions: number
    accountsWithOpenPositions: AccountSnapshotSummary[]
    evidence: {
      completeV3Context: number
      completeCost: number
      legacyMissingContext: number
      newMissingContext: number
      missingCost: number
      risk: 'none' | 'legacy_will_close_dirty' | 'new_missing_context_or_cost'
    }
  }
  runtimeContext: Record<string, unknown>
  recommendations: string[]
}

interface LoadState {
  closedTrades: NormalizedPaperTrade[]
  skippedOpenTrades: number
  duplicateTradesSkipped: number
}

interface RawRecord {
  [key: string]: unknown
}

const DEFAULT_ARGS: AnalyzePaperPnlArgs = {
  paperDir: 'data/paper_trading',
  runtimeDir: 'data/runtime',
  outputPath: 'data/research/paper_pnl_diagnostics.latest.json',
  lookbackHours: null,
  topN: 10,
}

const STOP_LOSS_DIAGNOSTIC_WINDOW_DAYS = 7
const STOP_LOSS_DIAGNOSTIC_THRESHOLDS = {
  stopLossCount: 20,
  stopLossLossSharePct: 40,
  closedTrades: 50,
} as const
const DEFAULT_CONTEXT_CUTOVER_TS = '2026-05-02T00:00:00.000Z'
const DEFAULT_CONTEXT_ENFORCEMENT_TS = '2026-05-02T06:30:00.000Z'
const DEFAULT_PREDICTED_OPEN_EVIDENCE_ENFORCEMENT_TS = '2026-05-04T00:44:00.000Z'

export function parseAnalyzePaperPnlArgs(argv: string[]): AnalyzePaperPnlArgs {
  const raw = parseRawArgs(argv)
  return {
    paperDir: raw.get('paperDir') ?? DEFAULT_ARGS.paperDir,
    runtimeDir: raw.get('runtimeDir') ?? DEFAULT_ARGS.runtimeDir,
    outputPath: raw.get('output') ?? raw.get('outputPath') ?? DEFAULT_ARGS.outputPath,
    lookbackHours: parseNullablePositiveNumber(raw.get('lookbackHours')),
    topN: parsePositiveInt(raw.get('topN'), DEFAULT_ARGS.topN),
  }
}

export async function analyzePaperPnl(args: AnalyzePaperPnlArgs): Promise<PaperPnlDiagnosticsReport> {
  const startedAt = new Date()
  const paperDir = resolve(args.paperDir)
  const runtimeDir = resolve(args.runtimeDir)
  const outputPath = resolve(args.outputPath)
  const loadState = await loadClosedTrades(paperDir, args.lookbackHours)
  const accounts = await loadAccountSnapshots(paperDir)
  const runtimeContext = await loadRuntimeContext(runtimeDir)
  const trades = loadState.closedTrades.sort((a, b) => Date.parse(a.closeTs) - Date.parse(b.closeTs))
  const topN = Math.max(1, args.topN)
  const contextBuckets = summarizeContextCoverage(trades)
  const contextEnforcementWindow = summarizeContextEnforcementWindow(trades)
  const costEvidence = summarizeCostEvidenceCoverage(trades)
  const mfeMaeEvidence = await summarizeMfeMaeCoverage(trades, runtimeDir)
  const stopLossRollingDiagnostics = buildStopLossRollingDiagnostics(trades)

  const report: PaperPnlDiagnosticsReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    inputs: {
      paperDir,
      runtimeDir,
      outputPath,
      lookbackHours: args.lookbackHours,
    },
    coverage: {
      closedTrades: trades.length,
      skippedOpenTrades: loadState.skippedOpenTrades,
      duplicateTradesSkipped: loadState.duplicateTradesSkipped,
      earliestCloseTs: trades[0]?.closeTs ?? null,
      latestCloseTs: trades.at(-1)?.closeTs ?? null,
      missingRuleScoreTrades: trades.filter(trade => trade.ruleScoreAtOpen == null).length,
      missingFlashConfidenceTrades: trades.filter(trade => trade.flashConfidenceLowAtOpen == null).length,
      contextBuckets,
      legacyMissingContextTrades: countContextBucket(contextBuckets, 'legacy_missing'),
      newMissingContextTrades: countContextBucket(contextBuckets, 'new_missing'),
      staleContextTrades: countContextBucket(contextBuckets, 'stale'),
      timeoutContextTrades: countContextBucket(contextBuckets, 'timeout'),
      okContextTrades: countContextBucket(contextBuckets, 'ok'),
      contextEnforcementWindow,
      costEvidence,
      mfeMaeEvidence,
    },
    overall: computeStats('all', trades),
    accounts,
    byLane: groupStats(trades, trade => trade.lane),
    bySymbol: groupStats(trades, trade => trade.symbol),
    bySide: groupStats(trades, trade => trade.side),
    byCloseReason: groupStats(trades, trade => trade.closeReason),
    byLeverage: groupStats(trades, trade => trade.leverage == null ? 'unknown' : `${trade.leverage}x`),
    byCloseHourUtc: groupStats(trades, trade => trade.closeHourUtc == null ? 'unknown' : String(trade.closeHourUtc).padStart(2, '0')),
    byRuleScoreBucket: groupStats(trades, trade => bucketScore(trade.ruleScoreAtOpen)),
    byFlashConfidenceLowBucket: groupStats(trades, trade => bucketScore(trade.flashConfidenceLowAtOpen)),
    byContextCoverageBucket: groupStats(trades, trade => trade.contextCoverageBucket),
    byVolumeRatioBucket: groupStats(trades, trade => bucketVolumeRatio(trade.volumeRatioAtOpen)),
    byBreakQualityBucket: groupStats(trades, trade => bucketBreakQuality(trade.breakQualityAtOpen)),
    byLiquidityStatus: groupStats(trades, trade => trade.liquidityStatusAtOpen ?? 'missing'),
    bySpreadStatus: groupStats(trades, trade => trade.spreadStatusAtOpen ?? 'missing'),
    bySpreadBpsBucket: groupStats(trades, trade => bucketSpreadBps(trade.spreadBpsAtOpen)),
    byRankBucket: groupStats(trades, trade => bucketRank(trade.rankAtOpen)),
    byRankSpreadBucket: groupStats(trades, trade => bucketRankSpreadPct(trade.rankSpreadPctAtOpen)),
    byEstimatedRoundTripCostBucket: groupStats(trades, trade => bucketCostPct(trade.estimatedRoundTripCostPctAtOpen)),
    byEstimatedRoundTripCostOfMarginBucket: groupStats(trades, trade => bucketCostOfMarginPct(trade.estimatedRoundTripCostPctOfMarginAtOpen)),
    bySignalConfidenceBucket: groupStats(trades, trade => bucketScore(trade.signalConfidenceAtOpen)),
    byHoldingBucket: groupStats(trades, trade => bucketHoldingSeconds(trade.holdingSeconds)),
    stopLossRollingDiagnostics,
    topLossContributors: {
      lanes: negativeTop(groupStats(trades, trade => trade.lane), topN),
      symbols: negativeTop(groupStats(trades, trade => trade.symbol), topN),
      closeReasons: negativeTop(groupStats(trades, trade => trade.closeReason), topN),
      hours: negativeTop(groupStats(trades, trade => trade.closeHourUtc == null ? 'unknown' : String(trade.closeHourUtc).padStart(2, '0')), topN),
    },
    openRisk: {
      totalOpenPositions: accounts.reduce((sum, account) => sum + account.openPositions, 0),
      accountsWithOpenPositions: accounts.filter(account => account.openPositions > 0),
      evidence: summarizeOpenPositionEvidence(accounts),
    },
    runtimeContext,
    recommendations: [],
  }
  report.recommendations = buildRecommendations(report)

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  await writeEvidenceManifestForArtifact({
    job: 'paper_pnl_diagnostics',
    artifactPath: outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: 0,
    businessStatus: report.coverage.contextEnforcementWindow.newMissingContextTrades > 0 || report.stopLossRollingDiagnostics.triggered ? 'warn' : 'pass',
    recordsIn: trades.length + loadState.skippedOpenTrades + loadState.duplicateTradesSkipped,
    recordsOut: trades.length,
    errorClass: report.coverage.contextEnforcementWindow.newMissingContextTrades > 0
      ? 'new_trade_context_missing'
      : report.stopLossRollingDiagnostics.triggered
        ? 'stop_loss_cluster_triggered'
        : null,
  })
  return report
}

export async function loadClosedTrades(paperDir: string, lookbackHours: number | null): Promise<LoadState> {
  const cutoffMs = lookbackHours ? Date.now() - lookbackHours * 60 * 60 * 1000 : null
  const closedTrades: NormalizedPaperTrade[] = []
  const seen = new Set<string>()
  let skippedOpenTrades = 0
  let duplicateTradesSkipped = 0

  function addTrade(trade: NormalizedPaperTrade | null): void {
    if (!trade) {
      skippedOpenTrades += 1
      return
    }
    if (cutoffMs != null && Date.parse(trade.closeTs) < cutoffMs) return
    if (seen.has(trade.tradeId)) {
      duplicateTradesSkipped += 1
      return
    }
    seen.add(trade.tradeId)
    closedTrades.push(trade)
  }

  for (const record of await readJsonl(join(paperDir, 'paper_trade_result.jsonl'))) {
    addTrade(normalizePaperTradeResult(record, 'paper_trade_result.jsonl'))
  }

  for (const path of await discoverAccountJsonFiles(paperDir)) {
    const json = await readJson(path)
    const history = Array.isArray(json?.tradeHistory) ? json.tradeHistory : []
    for (const record of history) addTrade(normalizeAccountTrade(record as RawRecord, path))
  }

  for (const path of await discoverTradeLogFiles(paperDir)) {
    for (const record of await readJsonl(path)) addTrade(normalizeAccountTrade(record, path))
  }

  return { closedTrades, skippedOpenTrades, duplicateTradesSkipped }
}

export async function loadAccountSnapshots(paperDir: string): Promise<AccountSnapshotSummary[]> {
  const snapshots: AccountSnapshotSummary[] = []
  for (const path of await discoverAccountJsonFiles(paperDir)) {
    const json = await readJson(path)
    if (!json) continue
    const equity = numberOrNull(json.equity)
    const initialEquity = numberOrNull(json.initialEquity)
    const positions = Array.isArray(json.positions) ? json.positions : []
    const openPositionEvidence = summarizeAccountOpenPositionEvidence(positions)
    const accountId = inferAccountIdFromPath(path)
    snapshots.push({
      path,
      accountId,
      equity,
      initialEquity,
      returnPct: equity != null && initialEquity != null && initialEquity !== 0
        ? (equity / initialEquity - 1) * 100
        : null,
      openPositions: positions.length,
      openPositionEvidence,
    })
  }
  return snapshots.sort((a, b) => a.accountId.localeCompare(b.accountId))
}

function summarizeAccountOpenPositionEvidence(positions: unknown[]): AccountSnapshotSummary['openPositionEvidence'] {
  let completeV3Context = 0
  let completeCost = 0
  let legacyMissingContext = 0
  let newMissingContext = 0
  let missingCost = 0
  for (const position of positions) {
    const record = isRawRecord(position) ? position : {}
    if (hasOpenPositionV3Context(record)) completeV3Context += 1
    else if (isAfterContextCutover(stringOrNull(record.entryTime ?? record.openTs))) newMissingContext += 1
    else legacyMissingContext += 1

    if (hasOpenPositionCostEvidence(record)) completeCost += 1
    else missingCost += 1
  }
  return {
    completeV3Context,
    completeCost,
    legacyMissingContext,
    newMissingContext,
    missingCost,
    risk: newMissingContext > 0 || missingCost > legacyMissingContext
      ? 'new_missing_context_or_cost'
      : legacyMissingContext > 0 || missingCost > 0
        ? 'legacy_will_close_dirty'
        : 'none',
  }
}

function summarizeOpenPositionEvidence(accounts: AccountSnapshotSummary[]): PaperPnlDiagnosticsReport['openRisk']['evidence'] {
  const summary = accounts.reduce(
    (acc, account) => {
      acc.completeV3Context += account.openPositionEvidence.completeV3Context
      acc.completeCost += account.openPositionEvidence.completeCost
      acc.legacyMissingContext += account.openPositionEvidence.legacyMissingContext
      acc.newMissingContext += account.openPositionEvidence.newMissingContext
      acc.missingCost += account.openPositionEvidence.missingCost
      return acc
    },
    {
      completeV3Context: 0,
      completeCost: 0,
      legacyMissingContext: 0,
      newMissingContext: 0,
      missingCost: 0,
    },
  )
  return {
    ...summary,
    risk: summary.newMissingContext > 0 || summary.missingCost > summary.legacyMissingContext
      ? 'new_missing_context_or_cost'
      : summary.legacyMissingContext > 0 || summary.missingCost > 0
        ? 'legacy_will_close_dirty'
        : 'none',
  }
}

function hasOpenPositionV3Context(position: RawRecord): boolean {
  const decisionTime = stringOrNull(position.decisionTime)
  const watermark = stringOrNull(position.marketDataWatermarkAtDecisionTime) ?? stringOrNull(position.watermark)
  const contextStatus = stringOrNull(position.contextStatus)
  const flashContextStatus = stringOrNull(position.flashContextStatus)
  return Boolean(
    stringOrNull(position.contextSnapshotId) &&
    decisionTime &&
    watermark &&
    isPITSafeWatermark(decisionTime, watermark) &&
    booleanOrNull(position.featuresAvailableAtDecisionTime) === true &&
    stringOrNull(position.featureSchemaVersion) === 'paper_open_context.v3' &&
    contextStatus === 'ok' &&
    flashContextStatus === 'ok' &&
    numberOrNull(position.contextGenerationAtOpen) != null &&
    numberOrNull(position.flashConfidenceLowAtOpen) != null,
  )
}

function hasOpenPositionCostEvidence(position: RawRecord): boolean {
  return [
    position.estimatedRoundTripCostPctAtOpen,
    position.routeCostBpsAtOpen,
    position.roundTripCostBpsAtOpen,
  ].some(value => numberOrNull(value) != null)
}

export function computeStats(key: string, trades: NormalizedPaperTrade[]): GroupStats {
  const sorted = trades.slice().sort((a, b) => Date.parse(a.closeTs) - Date.parse(b.closeTs))
  const pnlPctValues = sorted.map(trade => trade.pnlPct)
  const pnlUsdValues = sorted.map(trade => trade.pnlUsd).filter((value): value is number => value != null)
  const holdingValues = sorted.map(trade => trade.holdingSeconds).filter((value): value is number => value != null)
  const wins = sorted.filter(trade => trade.pnlPct > 0).length
  const losses = sorted.filter(trade => trade.pnlPct < 0).length
  const flats = sorted.length - wins - losses
  const winPnl = sorted.filter(trade => trade.pnlPct > 0).reduce((sum, trade) => sum + trade.pnlPct, 0)
  const lossPnl = sorted.filter(trade => trade.pnlPct < 0).reduce((sum, trade) => sum + Math.abs(trade.pnlPct), 0)

  return {
    key,
    count: sorted.length,
    wins,
    losses,
    flats,
    winRate: sorted.length > 0 ? wins / sorted.length * 100 : 0,
    totalPnlPct: sum(pnlPctValues),
    avgPnlPct: mean(pnlPctValues),
    medianPnlPct: median(pnlPctValues),
    totalPnlUsd: pnlUsdValues.length > 0 ? sum(pnlUsdValues) : null,
    avgPnlUsd: pnlUsdValues.length > 0 ? mean(pnlUsdValues) : null,
    avgHoldingSeconds: holdingValues.length > 0 ? mean(holdingValues) : null,
    profitFactor: lossPnl > 0 ? winPnl / lossPnl : (winPnl > 0 ? null : 0),
    maxConsecutiveLosses: maxConsecutiveLosses(sorted),
    worstTrade: pickTrade(sorted.reduce<NormalizedPaperTrade | null>(
      (worst, trade) => !worst || trade.pnlPct < worst.pnlPct ? trade : worst,
      null,
    )),
    bestTrade: pickTrade(sorted.reduce<NormalizedPaperTrade | null>(
      (best, trade) => !best || trade.pnlPct > best.pnlPct ? trade : best,
      null,
    )),
  }
}

export function isAfterPredictedOpenEvidenceEnforcement(openTs: string | null): boolean {
  const enforcementMs = Date.parse(normalizedPredictedOpenEvidenceEnforcementTs())
  const openMs = typeof openTs === 'string' ? Date.parse(openTs) : Number.NaN
  if (!Number.isFinite(enforcementMs) || !Number.isFinite(openMs)) return true
  return openMs >= enforcementMs
}

export function normalizedPredictedOpenEvidenceEnforcementTs(): string {
  return normalizedIsoTimestamp(
    process.env.OPENALICE_PREDICTED_OPEN_EVIDENCE_ENFORCEMENT_TS,
    DEFAULT_PREDICTED_OPEN_EVIDENCE_ENFORCEMENT_TS,
  )
}

export function groupStats(
  trades: NormalizedPaperTrade[],
  keyFn: (trade: NormalizedPaperTrade) => string,
): GroupStats[] {
  const groups = new Map<string, NormalizedPaperTrade[]>()
  for (const trade of trades) {
    const key = keyFn(trade)
    groups.set(key, [...(groups.get(key) ?? []), trade])
  }
  return [...groups.entries()]
    .map(([key, groupTrades]) => computeStats(key, groupTrades))
    .sort((a, b) => a.totalPnlPct - b.totalPnlPct || b.count - a.count)
}

function normalizePaperTradeResult(record: RawRecord, source: string): NormalizedPaperTrade | null {
  const closeTs = stringOrNull(record.closeTs)
  const pnlPct = numberOrNull(record.pnlPct)
  if (!closeTs || pnlPct == null) return null
  const openTs = stringOrNull(record.openTs) ?? closeTs
  const openMs = Date.parse(openTs)
  const closeMs = Date.parse(closeTs)
  const closeReason = stringOrNull(record.closeReason) ?? 'unknown'
  const rawReason = closeReason
  const normalizedCloseReason = normalizeCloseReason(closeReason)
  const contextGenerationAtOpen = numberOrNull(record.contextGenerationAtOpen)
  const flashConfidenceLowAtOpen = numberOrNull(record.flashConfidenceLowAtOpen)
  const ruleScoreAtOpen = numberOrNull(record.ruleScoreAtOpen)
  const priceStale = booleanOrNull(record.priceStale)
  const volumeRatioAtOpen = numberOrNull(record.volumeRatioAtOpen ?? record.volumeRatio)
  const breakQualityAtOpen = breakQualityOrNull(record.breakQualityAtOpen ?? record.breakQuality)
  const liquidityUsdAtOpen = numberOrNull(record.liquidityUsdAtOpen ?? record.liquidityUsd)
  const liquidityStatusAtOpen = normalizeStatus(record.liquidityStatusAtOpen ?? record.liquidityStatus)
  const spreadStatusAtOpen = normalizeStatus(record.spreadStatusAtOpen ?? record.spreadStatus)
  const spreadBpsAtOpen = numberOrNull(record.spreadBpsAtOpen ?? record.spreadBps)
  const rankAtOpen = numberOrNull(record.rankAtOpen)
  const rankSpreadPctAtOpen = numberOrNull(record.rankSpreadPctAtOpen)
  const estimatedRoundTripCostPctAtOpen = numberOrNull(record.estimatedRoundTripCostPctAtOpen)
  const estimatedRoundTripCostPctOfMarginAtOpen = numberOrNull(record.estimatedRoundTripCostPctOfMarginAtOpen)
  const expectedGrossEdgePctAtOpen = numberOrNull(record.expectedGrossEdgePctAtOpen)
  const expectedNetEdgePctAtOpen = numberOrNull(record.expectedNetEdgePctAtOpen)
  const expectedEdgeSourceAtOpen = stringOrNull(record.expectedEdgeSourceAtOpen)
  const routeCostBpsAtOpen = numberOrNull(record.routeCostBpsAtOpen ?? record.routeCostBps)
  const roundTripCostBpsAtOpen = numberOrNull(record.roundTripCostBpsAtOpen ?? record.roundTripCostBps)
  const markPriceAtOpen = numberOrNull(record.markPriceAtOpen ?? record.markPrice)
  const markPriceTimestampAtOpen = stringOrNull(record.markPriceTimestampAtOpen ?? record.markPriceTimestamp)
  const matchPriceAtOpen = numberOrNull(record.matchPriceAtOpen ?? record.matchPrice)
  const matchPriceSourceAtOpen = stringOrNull(record.matchPriceSourceAtOpen ?? record.matchPriceSource)
  const markMatchPenaltyBpsAtOpen = numberOrNull(record.markMatchPenaltyBpsAtOpen ?? record.markMatchPenaltyBps)
  const markMatchStatusAtOpen = stringOrNull(record.markMatchStatusAtOpen ?? record.markMatchStatus)
  const realizedRoundTripCostBps = numberOrNull(record.realizedRoundTripCostBps)
  const realizedCostBps = numberOrNull(record.realizedCostBps)
  const fillAdjustedCostBps = numberOrNull(record.fillAdjustedCostBps)
  const fillAdjustedCostPct = numberOrNull(record.fillAdjustedCostPct)
  const costEvidenceSource = stringOrNull(record.costEvidenceSource)
  const costEvidenceStatus = stringOrNull(record.costEvidenceStatus)
  const predictedOpenEvidenceStatus = stringOrNull(record.predictedOpenEvidenceStatus)
  const predictedOpenEvidenceReason = stringOrNull(record.predictedOpenEvidenceReason)
  const mfeBps = numberOrNull(record.mfeBps)
  const maeBps = numberOrNull(record.maeBps)
  const signalConfidenceAtOpen = numberOrNull(record.signalConfidenceAtOpen)
  const contextSnapshotId = stringOrNull(record.contextSnapshotId)
  const decisionTime = stringOrNull(record.decisionTime)
  const marketDataWatermarkAtDecisionTime = stringOrNull(record.marketDataWatermarkAtDecisionTime)
  const watermark = stringOrNull(record.watermark)
  const featuresAvailableAtDecisionTime = booleanOrNull(record.featuresAvailableAtDecisionTime)
  const featureSchemaVersion = stringOrNull(record.featureSchemaVersion)
  const flashContextStatus = stringOrNull(record.flashContextStatus)
  const contextStatus = stringOrNull(record.contextStatus)
  const contextReason = stringOrNull(record.contextReason)
  const contextCoverageStatus = stringOrNull(record.contextCoverageStatus)
  const contextCoverageReason = stringOrNull(record.contextCoverageReason)
  const regimeAtOpen = stringOrNull(
    record.regimeAtOpen ??
    record.marketRegimeAtOpen ??
    record.regime ??
    record.marketRegime,
  )

  return {
    tradeId: stringOrNull(record.tradeId) ?? stringOrNull(record.id) ?? `${source}:${stringOrNull(record.symbol) ?? 'unknown'}:${closeTs}`,
    source,
    lane: stringOrNull(record.lane) ?? inferLane(record, source),
    accountId: stringOrNull(record.accountId),
    accountLabel: stringOrNull(record.accountLabel),
    symbol: stringOrNull(record.symbol) ?? 'unknown',
    side: parseSide(record.side ?? record.direction),
    leverage: numberOrNull(record.leverage),
    openTs,
    closeTs,
    openPrice: numberOrNull(record.openPrice ?? record.entryPrice),
    closePrice: numberOrNull(record.closePrice ?? record.exitPrice),
    pnlPct,
    pnlUsd: numberOrNull(record.pnlUsd ?? record.pnl),
    closeReason: normalizedCloseReason,
    rawReason,
    holdingSeconds: Number.isFinite(openMs) && Number.isFinite(closeMs) ? Math.max(0, (closeMs - openMs) / 1000) : null,
    closeHourUtc: Number.isFinite(closeMs) ? new Date(closeMs).getUTCHours() : null,
    priceSource: stringOrNull(record.priceSource),
    priceStale,
    volumeRatioAtOpen,
    breakQualityAtOpen,
    liquidityUsdAtOpen,
    liquidityStatusAtOpen,
    spreadStatusAtOpen,
    spreadBpsAtOpen,
    rankAtOpen,
    rankSpreadPctAtOpen,
    estimatedRoundTripCostPctAtOpen,
    estimatedRoundTripCostPctOfMarginAtOpen,
    expectedGrossEdgePctAtOpen,
    expectedNetEdgePctAtOpen,
    expectedEdgeSourceAtOpen,
    routeCostBpsAtOpen,
    roundTripCostBpsAtOpen,
    markPriceAtOpen,
    markPriceTimestampAtOpen,
    matchPriceAtOpen,
    matchPriceSourceAtOpen,
    markMatchPenaltyBpsAtOpen,
    markMatchStatusAtOpen,
    realizedRoundTripCostBps,
    realizedCostBps,
    fillAdjustedCostBps,
    fillAdjustedCostPct,
    costEvidenceSource,
    costEvidenceStatus,
    predictedOpenEvidenceStatus,
    predictedOpenEvidenceReason,
    mfeBps,
    maeBps,
    timeToMfeSec: numberOrNull(record.timeToMfeSec),
    timeToMaeSec: numberOrNull(record.timeToMaeSec),
    timeToStopSec: numberOrNull(record.timeToStopSec),
    mfeBeforeStop: booleanOrNull(record.mfeBeforeStop),
    signalConfidenceAtOpen,
    contextSnapshotId,
    decisionTime,
    marketDataWatermarkAtDecisionTime,
    watermark,
    featuresAvailableAtDecisionTime,
    featureSchemaVersion,
    flashContextStatus,
    contextStatus,
    contextReason,
    contextCoverageStatus,
    contextCoverageReason,
    contextGenerationAtOpen,
    flashConfidenceLowAtOpen,
    ruleScoreAtOpen,
    proEpochAtOpen: numberOrNull(record.proEpochAtOpen),
    marketIntelTriggerAtOpen: stringOrNull(record.marketIntelTriggerAtOpen),
    regimeAtOpen,
    contextCoverageBucket: classifyContextCoverage({
      sourceKind: 'paper_result',
      contextCoverageStatus,
      openTs,
      normalizedCloseReason,
      rawReason,
      priceStale,
      contextSnapshotId,
      decisionTime,
      marketDataWatermarkAtDecisionTime,
      watermark,
      featuresAvailableAtDecisionTime,
      featureSchemaVersion,
      flashContextStatus,
      contextStatus,
      contextGenerationAtOpen,
      flashConfidenceLowAtOpen,
      ruleScoreAtOpen,
    }),
    liquidated: Boolean(record.liquidated),
  }
}

function normalizeAccountTrade(record: RawRecord, source: string): NormalizedPaperTrade | null {
  const closeTs = stringOrNull(record.exitTime ?? record.closeTs)
  const pnlPct = numberOrNull(record.pnlPct)
  if (!closeTs || pnlPct == null) return null
  const openTs = stringOrNull(record.entryTime ?? record.openTs) ?? closeTs
  const openMs = Date.parse(openTs)
  const closeMs = Date.parse(closeTs)
  const rawReason = stringOrNull(record.reason ?? record.closeReason)
  const normalizedCloseReason = normalizeCloseReason(rawReason)
  const contextGenerationAtOpen = numberOrNull(record.contextGenerationAtOpen)
  const flashConfidenceLowAtOpen = numberOrNull(record.flashConfidenceLowAtOpen)
  const ruleScoreAtOpen = numberOrNull(record.ruleScoreAtOpen ?? record.signalConfidenceAtOpen ?? record.signalConfidence ?? record.confidence)
  const proEpochAtOpen = numberOrNull(record.proEpochAtOpen)
  const marketIntelTriggerAtOpen = stringOrNull(record.marketIntelTriggerAtOpen)
  const regimeAtOpen = stringOrNull(
    record.regimeAtOpen ??
    record.marketRegimeAtOpen ??
    record.regime ??
    record.marketRegime,
  )
  const priceSource = stringOrNull(record.priceSource)
  const priceStale = booleanOrNull(record.priceStale)
  const contextSnapshotId = stringOrNull(record.contextSnapshotId)
  const decisionTime = stringOrNull(record.decisionTime)
  const marketDataWatermarkAtDecisionTime = stringOrNull(record.marketDataWatermarkAtDecisionTime)
  const watermark = stringOrNull(record.watermark)
  const featuresAvailableAtDecisionTime = booleanOrNull(record.featuresAvailableAtDecisionTime)
  const featureSchemaVersion = stringOrNull(record.featureSchemaVersion)
  const flashContextStatus = stringOrNull(record.flashContextStatus)
  const contextStatus = stringOrNull(record.contextStatus)
  const contextReason = stringOrNull(record.contextReason)
  const contextCoverageStatus = stringOrNull(record.contextCoverageStatus)
  const contextCoverageReason = stringOrNull(record.contextCoverageReason)

  return {
    tradeId: stringOrNull(record.id) ?? stringOrNull(record.tradeId) ?? `${source}:${stringOrNull(record.symbol) ?? 'unknown'}:${closeTs}`,
    source,
    lane: inferLane(record, source),
    accountId: stringOrNull(record.accountId),
    accountLabel: stringOrNull(record.accountLabel),
    symbol: stringOrNull(record.symbol) ?? 'unknown',
    side: parseSide(record.direction ?? record.side),
    leverage: numberOrNull(record.leverage),
    openTs,
    closeTs,
    openPrice: numberOrNull(record.entryPrice ?? record.openPrice),
    closePrice: numberOrNull(record.exitPrice ?? record.closePrice),
    pnlPct,
    pnlUsd: numberOrNull(record.pnl ?? record.pnlUsd),
    closeReason: normalizedCloseReason,
    rawReason,
    holdingSeconds: Number.isFinite(openMs) && Number.isFinite(closeMs) ? Math.max(0, (closeMs - openMs) / 1000) : null,
    closeHourUtc: Number.isFinite(closeMs) ? new Date(closeMs).getUTCHours() : null,
    priceSource,
    priceStale,
    volumeRatioAtOpen: numberOrNull(record.volumeRatioAtOpen ?? record.volumeRatio),
    breakQualityAtOpen: breakQualityOrNull(record.breakQualityAtOpen ?? record.breakQuality),
    liquidityUsdAtOpen: numberOrNull(record.liquidityUsdAtOpen ?? record.liquidityUsd),
    liquidityStatusAtOpen: normalizeStatus(record.liquidityStatusAtOpen ?? record.liquidityStatus),
    spreadStatusAtOpen: normalizeStatus(record.spreadStatusAtOpen ?? record.spreadStatus),
    spreadBpsAtOpen: numberOrNull(record.spreadBpsAtOpen ?? record.spreadBps),
    rankAtOpen: numberOrNull(record.rankAtOpen),
    rankSpreadPctAtOpen: numberOrNull(record.rankSpreadPctAtOpen),
    estimatedRoundTripCostPctAtOpen: numberOrNull(record.estimatedRoundTripCostPctAtOpen),
    estimatedRoundTripCostPctOfMarginAtOpen: numberOrNull(record.estimatedRoundTripCostPctOfMarginAtOpen),
    expectedGrossEdgePctAtOpen: numberOrNull(record.expectedGrossEdgePctAtOpen),
    expectedNetEdgePctAtOpen: numberOrNull(record.expectedNetEdgePctAtOpen),
    expectedEdgeSourceAtOpen: stringOrNull(record.expectedEdgeSourceAtOpen),
    routeCostBpsAtOpen: numberOrNull(record.routeCostBpsAtOpen ?? record.routeCostBps),
    roundTripCostBpsAtOpen: numberOrNull(record.roundTripCostBpsAtOpen ?? record.roundTripCostBps),
    markPriceAtOpen: numberOrNull(record.markPriceAtOpen ?? record.markPrice),
    markPriceTimestampAtOpen: stringOrNull(record.markPriceTimestampAtOpen ?? record.markPriceTimestamp),
    matchPriceAtOpen: numberOrNull(record.matchPriceAtOpen ?? record.matchPrice),
    matchPriceSourceAtOpen: stringOrNull(record.matchPriceSourceAtOpen ?? record.matchPriceSource),
    markMatchPenaltyBpsAtOpen: numberOrNull(record.markMatchPenaltyBpsAtOpen ?? record.markMatchPenaltyBps),
    markMatchStatusAtOpen: stringOrNull(record.markMatchStatusAtOpen ?? record.markMatchStatus),
    realizedRoundTripCostBps: numberOrNull(record.realizedRoundTripCostBps),
    realizedCostBps: numberOrNull(record.realizedCostBps),
    fillAdjustedCostBps: numberOrNull(record.fillAdjustedCostBps),
    fillAdjustedCostPct: numberOrNull(record.fillAdjustedCostPct),
    costEvidenceSource: stringOrNull(record.costEvidenceSource),
    costEvidenceStatus: stringOrNull(record.costEvidenceStatus),
    predictedOpenEvidenceStatus: stringOrNull(record.predictedOpenEvidenceStatus),
    predictedOpenEvidenceReason: stringOrNull(record.predictedOpenEvidenceReason),
    mfeBps: numberOrNull(record.mfeBps),
    maeBps: numberOrNull(record.maeBps),
    timeToMfeSec: numberOrNull(record.timeToMfeSec),
    timeToMaeSec: numberOrNull(record.timeToMaeSec),
    timeToStopSec: numberOrNull(record.timeToStopSec),
    mfeBeforeStop: booleanOrNull(record.mfeBeforeStop),
    signalConfidenceAtOpen: numberOrNull(record.signalConfidenceAtOpen ?? record.signalConfidence),
    contextSnapshotId,
    decisionTime,
    marketDataWatermarkAtDecisionTime,
    watermark,
    featuresAvailableAtDecisionTime,
    featureSchemaVersion,
    flashContextStatus,
    contextStatus,
    contextReason,
    contextCoverageStatus,
    contextCoverageReason,
    contextGenerationAtOpen,
    flashConfidenceLowAtOpen,
    ruleScoreAtOpen,
    proEpochAtOpen,
    marketIntelTriggerAtOpen,
    regimeAtOpen,
    contextCoverageBucket: classifyContextCoverage({
      sourceKind: 'account_history',
      contextCoverageStatus,
      openTs,
      normalizedCloseReason,
      rawReason,
      priceStale,
      contextSnapshotId,
      decisionTime,
      marketDataWatermarkAtDecisionTime,
      watermark,
      featuresAvailableAtDecisionTime,
      featureSchemaVersion,
      flashContextStatus,
      contextStatus,
      contextGenerationAtOpen,
      flashConfidenceLowAtOpen,
      ruleScoreAtOpen,
    }),
    liquidated: Boolean(record.liquidated) || normalizedCloseReason === 'liquidation',
  }
}

function inferLane(record: RawRecord, source: string): string {
  const explicit = stringOrNull(record.lane)
  if (explicit) return explicit
  const accountId = stringOrNull(record.accountId) ?? inferAccountIdFromPath(source)
  const leverage = numberOrNull(record.leverage)
  const reason = `${stringOrNull(record.reason) ?? ''} ${stringOrNull(record.closeReason) ?? ''}`.toLowerCase()
  const path = source.toLowerCase()
  if (path.includes('account_ms') || reason.includes('1s impulse')) {
    if ((leverage ?? 0) >= 100) return 'microstructure_100x'
    return 'microstructure_10x'
  }
  if (path.includes('account_vb') || reason.includes('breakout') || reason.includes('hold expired')) {
    if ((leverage ?? 0) >= 100) return 'volume_breakout_100x'
    if ((leverage ?? 0) >= 10) return 'volume_breakout_10x'
    if ((leverage ?? 0) >= 3) return 'volume_breakout_3x'
    return 'volume_breakout_1x'
  }
  if (accountId.includes('liquidation_probe_100x')) return 'cross_sectional_100x'
  if (accountId.includes('stress_10x')) return 'cross_sectional_10x'
  return 'cross_sectional'
}

function normalizeCloseReason(value: string | null): string {
  const text = (value ?? '').toLowerCase()
  if (!text) return 'unknown'
  if (
    text.includes('holding_expired') ||
    text.includes('holding_period_expired') ||
    text.includes('holding period expired') ||
    text.includes('hold expired')
  ) return 'holding_expired'
  if (text.includes('take_profit') || text.includes('take profit')) return 'take_profit'
  if (text.includes('stop_loss') || text.includes('stop loss')) return 'stop_loss'
  if (text.includes('liquidat')) return 'liquidation'
  if (text.includes('stale_context')) return 'stale_context'
  if (text.includes('severe_news')) return 'severe_news'
  if (text.includes('system_fuse') || text.includes('fuse')) return 'system_fuse'
  if (text.includes('forced_exit_timeout')) return 'forced_exit_timeout'
  if (text.includes('signal')) return 'signal'
  return text.replace(/[^a-z0-9_ -]+/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'unknown'
}

async function discoverAccountJsonFiles(paperDir: string): Promise<string[]> {
  const files: string[] = []
  for (const name of await safeReaddir(paperDir)) {
    if (/^account.*\.json$/.test(name)) files.push(join(paperDir, name))
  }
  const accountsDir = join(paperDir, 'accounts')
  for (const account of await safeReaddir(accountsDir)) {
    const path = join(accountsDir, account, 'account.json')
    if (existsSync(path)) files.push(path)
  }
  return files.sort()
}

async function discoverTradeLogFiles(paperDir: string): Promise<string[]> {
  const files: string[] = []
  const rootLog = join(paperDir, 'trade_log.jsonl')
  if (existsSync(rootLog)) files.push(rootLog)
  const accountsDir = join(paperDir, 'accounts')
  for (const account of await safeReaddir(accountsDir)) {
    const path = join(accountsDir, account, 'trade_log.jsonl')
    if (existsSync(path)) files.push(path)
  }
  return files.sort()
}

async function loadRuntimeContext(runtimeDir: string): Promise<Record<string, unknown>> {
  return {
    marketIntelContext: summarizeRuntimeJson(await readJson(join(runtimeDir, 'market_intel_context.latest.json')), [
      'contextGeneration',
      'riskMode',
      'newsRiskRegime',
      'trigger',
      'modelLane',
      'model',
      'allowNewPositionsByLane',
      'flashConfidenceByLane',
      'validUntil',
    ]),
    microstructure: summarizeRuntimeJson(await readJson(join(runtimeDir, 'paper_microstructure_stress.latest.json')), [
      'generatedAt',
      'status',
      'dataFreshness',
    ]),
    volumeBreakout: summarizeRuntimeJson(await readJson(join(runtimeDir, 'paper_volume_breakout.latest.json')), [
      'generatedAt',
      'marketIntelContext',
      'systemFuse',
    ]),
    crossSectional: summarizeRuntimeJson(await readJson(join(runtimeDir, 'paper_decision.latest.json')), [
      'generatedAt',
      'marketIntelContext',
      'systemFuse',
    ]),
  }
}

function summarizeRuntimeJson(value: RawRecord | null, keys: string[]): Record<string, unknown> | null {
  if (!value) return null
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = value[key]
  return out
}

function classifyContextCoverage(input: {
  sourceKind: 'paper_result' | 'account_history'
  contextCoverageStatus: string | null
  openTs: string | null
  normalizedCloseReason: string
  rawReason: string | null
  priceStale: boolean | null
  contextSnapshotId: string | null
  decisionTime: string | null
  marketDataWatermarkAtDecisionTime: string | null
  watermark: string | null
  featuresAvailableAtDecisionTime: boolean | null
  featureSchemaVersion: string | null
  flashContextStatus: string | null
  contextStatus: string | null
  contextGenerationAtOpen: number | null
  flashConfidenceLowAtOpen: number | null
  ruleScoreAtOpen: number | null
}): ContextCoverageBucket {
  const explicit = normalizeExplicitContextCoverageStatus(input.contextCoverageStatus)
  if (explicit && explicit !== 'ok') return explicit
  const reason = `${input.normalizedCloseReason} ${input.rawReason ?? ''}`.toLowerCase()
  if (
    input.normalizedCloseReason === 'stale_context' ||
    input.priceStale === true ||
    reason.includes('stale_context') ||
    reason.includes('price_stale') ||
    reason.includes('data_stale')
  ) {
    return 'stale'
  }
  if (
    input.normalizedCloseReason === 'forced_exit_timeout' ||
    reason.includes('timeout')
  ) {
    return 'timeout'
  }
  if (hasCompleteDecisionTimeContext(input)) {
    return 'ok'
  }
  if (input.sourceKind === 'account_history') return 'legacy_missing'
  return isAfterContextCutover(input.openTs) ? 'new_missing' : 'legacy_missing'
}

function normalizeExplicitContextCoverageStatus(status: string | null): ContextCoverageBucket | null {
  switch (status) {
    case 'ok':
      return 'ok'
    case 'stale':
      return 'stale'
    case 'timeout':
      return 'timeout'
    case 'legacy_missing':
      return 'legacy_missing'
    case 'partial_missing':
      return 'new_missing'
    default:
      return null
  }
}

function isAfterContextCutover(openTs: string | null): boolean {
  const cutoverMs = Date.parse(normalizedContextCutoverTs())
  const openMs = openTs ? Date.parse(openTs) : Number.NaN
  if (!Number.isFinite(cutoverMs) || !Number.isFinite(openMs)) return true
  return openMs >= cutoverMs
}

function normalizedContextCutoverTs(): string {
  return normalizedIsoTimestamp(process.env.OPENALICE_CONTEXT_CUTOVER_TS, DEFAULT_CONTEXT_CUTOVER_TS)
}

function normalizedContextEnforcementTs(cutoverTs = normalizedContextCutoverTs()): string {
  return normalizedIsoTimestamp(process.env.OPENALICE_CONTEXT_ENFORCEMENT_TS, DEFAULT_CONTEXT_ENFORCEMENT_TS, cutoverTs)
}

function normalizedIsoTimestamp(value: string | undefined, fallback: string, floor?: string): string {
  const parsed = value ? Date.parse(value) : Number.NaN
  const fallbackParsed = Date.parse(fallback)
  const floorParsed = floor ? Date.parse(floor) : Number.NaN
  const selected = Number.isFinite(parsed)
    ? parsed
    : Number.isFinite(fallbackParsed)
      ? fallbackParsed
      : Date.parse(DEFAULT_CONTEXT_CUTOVER_TS)
  const floored = Number.isFinite(floorParsed) ? Math.max(selected, floorParsed) : selected
  return new Date(floored).toISOString()
}

function hasCompleteDecisionTimeContext(input: {
  contextSnapshotId: string | null
  decisionTime: string | null
  marketDataWatermarkAtDecisionTime: string | null
  watermark: string | null
  featuresAvailableAtDecisionTime: boolean | null
  featureSchemaVersion: string | null
  flashContextStatus: string | null
  contextStatus: string | null
  contextGenerationAtOpen: number | null
  flashConfidenceLowAtOpen: number | null
}): boolean {
  const watermark = input.marketDataWatermarkAtDecisionTime ?? input.watermark
  const schemaIsV3 = input.featureSchemaVersion === 'paper_open_context.v3'
  const flashStatusOk = input.flashContextStatus === 'ok'
  const contextStatusOk = input.contextStatus === 'ok'
  return Boolean(
    input.contextSnapshotId &&
    input.decisionTime &&
    watermark &&
    isPITSafeWatermark(input.decisionTime, watermark) &&
    input.featuresAvailableAtDecisionTime === true &&
    schemaIsV3 &&
    contextStatusOk &&
    flashStatusOk &&
    input.contextGenerationAtOpen != null &&
    input.flashConfidenceLowAtOpen != null,
  )
}

function isPITSafeWatermark(decisionTime: string, watermark: string): boolean {
  const decisionMs = Date.parse(decisionTime)
  const watermarkMs = Date.parse(watermark)
  if (!Number.isFinite(decisionMs) || !Number.isFinite(watermarkMs)) return false
  return watermarkMs <= decisionMs
}

function summarizeContextCoverage(trades: NormalizedPaperTrade[]): ContextCoverageBucketSummary[] {
  const buckets: ContextCoverageBucket[] = [
    'ok',
    'stale',
    'timeout',
    'legacy_missing',
    'new_missing',
  ]
  return buckets.map(bucket => {
    const count = trades.filter(trade => trade.contextCoverageBucket === bucket).length
    return {
      bucket,
      count,
      sharePct: trades.length > 0 ? count / trades.length * 100 : 0,
    }
  })
}

function summarizeContextEnforcementWindow(trades: NormalizedPaperTrade[]): ContextEnforcementWindowSummary {
  const cutoverTs = normalizedContextCutoverTs()
  const enforcementTs = normalizedContextEnforcementTs(cutoverTs)
  const cutoverMs = Date.parse(cutoverTs)
  const enforcementMs = Date.parse(enforcementTs)
  const inWindow = trades.filter(trade => {
    const openMs = Date.parse(trade.openTs)
    return Number.isFinite(openMs) && openMs >= enforcementMs
  })
  const afterCutoverBeforeEnforcement = trades.filter(trade => {
    const openMs = Date.parse(trade.openTs)
    return Number.isFinite(openMs) && openMs >= cutoverMs && openMs < enforcementMs
  })
  const okContextTrades = inWindow.filter(trade => trade.contextCoverageBucket === 'ok').length
  const newMissingContextTrades = inWindow.filter(trade => trade.contextCoverageBucket === 'new_missing').length
  return {
    cutoverTs,
    enforcementTs,
    status: inWindow.length === 0 ? 'insufficient_data' : newMissingContextTrades > 0 ? 'new_missing' : 'ok',
    closedTrades: inWindow.length,
    okContextTrades,
    newMissingContextTrades,
    legacyMissingContextTrades: inWindow.filter(trade => trade.contextCoverageBucket === 'legacy_missing').length,
    staleContextTrades: inWindow.filter(trade => trade.contextCoverageBucket === 'stale').length,
    timeoutContextTrades: inWindow.filter(trade => trade.contextCoverageBucket === 'timeout').length,
    dirtyHistoricalNewMissingTrades: afterCutoverBeforeEnforcement
      .filter(trade => trade.contextCoverageBucket === 'new_missing')
      .length,
    contextCoveragePct: coveragePct(okContextTrades, inWindow.length),
  }
}

function summarizeCostEvidenceCoverage(trades: NormalizedPaperTrade[]): CostEvidenceCoverageSummary {
  const tradesWithAnyPredictedCost = trades.filter(hasAnyPredictedCost).length
  const tradesWithAnyRealizedCost = trades.filter(hasAnyRealizedCost).length
  const tradesWithFillAdjustedCost = trades.filter(hasFillAdjustedCost).length
  const tradesWithExpectedGrossEdge = trades.filter(trade => trade.expectedGrossEdgePctAtOpen != null).length
  const tradesWithExpectedNetEdge = trades.filter(trade => trade.expectedNetEdgePctAtOpen != null).length
  const tradesWithExpectedEdgeSource = trades.filter(trade => trade.expectedEdgeSourceAtOpen != null).length
  const tradesWithOpenTimeMarkMatchEvidence = trades.filter(hasOpenTimeMarkMatchEvidence).length
  const tradesWithCompletePredictedOpenEvidence = trades.filter(hasCompletePredictedOpenEvidence).length
  const newWindow = summarizeCostEvidenceNewWindow(trades)
  const markMatchStatusCounts = trades.reduce<Record<string, number>>((acc, trade) => {
    const status = trade.markMatchStatusAtOpen ?? 'missing'
    acc[status] = (acc[status] ?? 0) + 1
    return acc
  }, {})
  return {
    status: coverageStatus(trades.length, tradesWithAnyPredictedCost),
    closedTrades: trades.length,
    tradesWithAnyPredictedCost,
    tradesMissingAnyPredictedCost: trades.length - tradesWithAnyPredictedCost,
    anyPredictedCostCoveragePct: coveragePct(tradesWithAnyPredictedCost, trades.length),
    tradesWithRouteCostBps: trades.filter(trade => trade.routeCostBpsAtOpen != null).length,
    tradesWithRoundTripCostBps: trades.filter(trade => trade.roundTripCostBpsAtOpen != null).length,
    tradesWithEstimatedRoundTripCostPct: trades.filter(trade => trade.estimatedRoundTripCostPctAtOpen != null).length,
    tradesWithEstimatedRoundTripCostPctOfMargin: trades.filter(trade => trade.estimatedRoundTripCostPctOfMarginAtOpen != null).length,
    tradesWithExpectedGrossEdge,
    tradesWithExpectedNetEdge,
    tradesWithExpectedEdgeSource,
    tradesWithOpenTimeMarkMatchEvidence,
    tradesWithCompletePredictedOpenEvidence,
    completePredictedOpenEvidenceCoveragePct: coveragePct(tradesWithCompletePredictedOpenEvidence, trades.length),
    tradesWithAnyRealizedCost,
    tradesWithFillAdjustedCost,
    tradesWithPaperModelCostEvidence: trades.filter(trade => trade.costEvidenceSource === 'paper_cost_model_at_open').length,
    tradesWithExchangeReconciledCostEvidence: trades.filter(trade => trade.costEvidenceSource === 'exchange_reconciled_fill').length,
    markMatchStatusCounts,
    markMatchPenaltyTrades: trades.filter(trade => trade.markMatchPenaltyBpsAtOpen != null).length,
    staleOrMissingMarkMatchTrades: trades.filter(trade => (trade.markMatchStatusAtOpen ?? 'missing') === 'stale_or_missing').length,
    invalidMarkMatchTrades: trades.filter(trade => (trade.markMatchStatusAtOpen ?? 'missing') === 'invalid').length,
    newWindow,
    byLane: laneCoverage(trades, hasAnyPredictedCost),
  }
}

function summarizeCostEvidenceNewWindow(trades: NormalizedPaperTrade[]): CostEvidenceCoverageSummary['newWindow'] {
  const cutoverTs = normalizedContextCutoverTs()
  const enforcementTs = normalizedContextEnforcementTs(cutoverTs)
  const enforcementMs = Date.parse(enforcementTs)
  const producerGuardEnforcementTs = normalizedPredictedOpenEvidenceEnforcementTs()
  const inWindow = trades.filter(trade => {
    const openMs = Date.parse(trade.openTs)
    return Number.isFinite(openMs) && openMs >= enforcementMs
  })
  const complete = inWindow.filter(hasCompletePredictedOpenEvidence).length
  const missing = inWindow.filter(trade => !hasCompletePredictedOpenEvidence(trade))
  const producerGuardMissing = missing.filter(trade => isAfterPredictedOpenEvidenceEnforcement(trade.openTs)).length
  const transitionalDirtyMissing = missing.length - producerGuardMissing
  return {
    cutoverTs,
    enforcementTs,
    producerGuardEnforcementTs,
    status: inWindow.length === 0 ? 'insufficient_data' : producerGuardMissing === 0 ? 'ok' : 'missing',
    closedTrades: inWindow.length,
    tradesWithCompletePredictedOpenEvidence: complete,
    tradesMissingCompletePredictedOpenEvidence: missing.length,
    transitionalDirtyMissingPredictedOpenEvidence: transitionalDirtyMissing,
    producerGuardMissingPredictedOpenEvidence: producerGuardMissing,
    completePredictedOpenEvidenceCoveragePct: coveragePct(complete, inWindow.length),
  }
}

async function summarizeMfeMaeCoverage(
  trades: NormalizedPaperTrade[],
  runtimeDir: string,
): Promise<MfeMaeCoverageSummary> {
  const tradesWithBothMfeMaeBps = trades.filter(hasBothMfeMae).length
  const stopLossTrades = trades.filter(trade => trade.closeReason === 'stop_loss')
  const stopLossTradesWithTimeToStopSec = stopLossTrades.filter(trade => trade.timeToStopSec != null).length
  const ledgerStatus = coverageStatus(trades.length, tradesWithBothMfeMaeBps)
  return {
    status: ledgerStatus,
    ledgerStatus,
    closedTrades: trades.length,
    tradesWithMfeBps: trades.filter(trade => trade.mfeBps != null).length,
    tradesWithMaeBps: trades.filter(trade => trade.maeBps != null).length,
    tradesWithBothMfeMaeBps,
    tradesMissingBothMfeMaeBps: trades.length - tradesWithBothMfeMaeBps,
    bothMfeMaeCoveragePct: coveragePct(tradesWithBothMfeMaeBps, trades.length),
    tradesWithTimeToMfeSec: trades.filter(trade => trade.timeToMfeSec != null).length,
    tradesWithTimeToMaeSec: trades.filter(trade => trade.timeToMaeSec != null).length,
    stopLossTrades: stopLossTrades.length,
    stopLossTradesWithTimeToStopSec,
    stopLossTimeCoveragePct: coveragePct(stopLossTradesWithTimeToStopSec, stopLossTrades.length),
    byLane: laneCoverage(trades, hasBothMfeMae),
    pathDiagnostics: await summarizeMfeMaePathDiagnostics(trades, runtimeDir),
  }
}

async function summarizeMfeMaePathDiagnostics(
  trades: NormalizedPaperTrade[],
  runtimeDir: string,
): Promise<MfeMaeCoverageSummary['pathDiagnostics']> {
  const sourcePath = join(runtimeDir, 'p1_trading_evidence', 'mfe_mae_stoploss_report.latest.json')
  const raw = await readJson(sourcePath)
  const diagnostics = Array.isArray(raw?.diagnostics)
    ? raw.diagnostics.filter(isRawRecord)
    : []
  if (diagnostics.length === 0) {
    return {
      status: trades.length === 0 ? 'insufficient_data' : 'missing',
      sourcePath: null,
      matchedTrades: 0,
      missingTradeDiagnostics: trades.length,
      unmatchedDiagnostics: 0,
      diagnosticsOk: 0,
      missingPricePath: 0,
      pricePathMismatch: 0,
      invalidTradePrices: 0,
      stopLossTrades: trades.filter(trade => trade.closeReason === 'stop_loss').length,
      stopLossDiagnosticsOk: 0,
      notes: ['No P1 MFE/MAE path diagnostic artifact was available; ledger field coverage is reported separately.'],
    }
  }

  const tradeIds = new Set(trades.map(trade => trade.tradeId))
  const diagnosticsByTradeId = new Map<string, RawRecord>()
  for (const diagnostic of diagnostics) {
    const tradeId = stringOrNull(diagnostic.tradeId)
    if (tradeId) diagnosticsByTradeId.set(tradeId, diagnostic)
  }
  const matchedDiagnostics = [...diagnosticsByTradeId.entries()]
    .filter(([tradeId]) => tradeIds.has(tradeId))
    .map(([, diagnostic]) => diagnostic)
  const diagnosticsOk = matchedDiagnostics.filter(diagnostic => diagnostic.diagnosticStatus === 'ok').length
  const missingTradeDiagnostics = Math.max(0, trades.length - matchedDiagnostics.length)
  const unmatchedDiagnostics = Math.max(0, diagnosticsByTradeId.size - matchedDiagnostics.length)
  const stopLossTradeIds = new Set(trades.filter(trade => trade.closeReason === 'stop_loss').map(trade => trade.tradeId))
  const stopLossDiagnosticsOk = matchedDiagnostics.filter(diagnostic =>
    diagnostic.diagnosticStatus === 'ok' &&
    typeof diagnostic.tradeId === 'string' &&
    stopLossTradeIds.has(diagnostic.tradeId),
  ).length
  const status = trades.length === 0
    ? 'insufficient_data'
    : missingTradeDiagnostics > 0 || unmatchedDiagnostics > 0
      ? 'stale_mismatch'
      : coverageStatus(trades.length, diagnosticsOk)

  return {
    status,
    sourcePath,
    matchedTrades: matchedDiagnostics.length,
    missingTradeDiagnostics,
    unmatchedDiagnostics,
    diagnosticsOk,
    missingPricePath: matchedDiagnostics.filter(diagnostic => diagnostic.diagnosticStatus === 'missing_price_path').length,
    pricePathMismatch: matchedDiagnostics.filter(diagnostic => diagnostic.diagnosticStatus === 'price_path_mismatch').length,
    invalidTradePrices: matchedDiagnostics.filter(diagnostic => diagnostic.diagnosticStatus === 'invalid_trade_prices').length,
    stopLossTrades: stopLossTradeIds.size,
    stopLossDiagnosticsOk,
    notes: [
      'Path diagnostics are read-only OHLC reconstruction from P1 evidence, not decision-time ledger fields.',
      'ledgerStatus remains the promotion-relevant coverage for fields persisted on paper_trade_result rows.',
    ],
  }
}

function isRawRecord(value: unknown): value is RawRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function laneCoverage(
  trades: NormalizedPaperTrade[],
  predicate: (trade: NormalizedPaperTrade) => boolean,
): LaneCoverageSummary[] {
  const groups = new Map<string, NormalizedPaperTrade[]>()
  for (const trade of trades) groups.set(trade.lane, [...(groups.get(trade.lane) ?? []), trade])
  return [...groups.entries()]
    .map(([lane, laneTrades]) => {
      const coveredTrades = laneTrades.filter(predicate).length
      return {
        lane,
        closedTrades: laneTrades.length,
        coveredTrades,
        missingTrades: laneTrades.length - coveredTrades,
        coveragePct: coveragePct(coveredTrades, laneTrades.length),
      }
    })
    .sort((a, b) => a.coveragePct - b.coveragePct || b.closedTrades - a.closedTrades || a.lane.localeCompare(b.lane))
}

function hasAnyPredictedCost(trade: NormalizedPaperTrade): boolean {
  return (
    trade.routeCostBpsAtOpen != null ||
    trade.roundTripCostBpsAtOpen != null ||
    trade.estimatedRoundTripCostPctAtOpen != null ||
    trade.estimatedRoundTripCostPctOfMarginAtOpen != null
  )
}

function hasOpenTimeMarkMatchEvidence(trade: NormalizedPaperTrade): boolean {
  return (
    trade.matchPriceAtOpen != null &&
    trade.matchPriceSourceAtOpen != null &&
    trade.markMatchPenaltyBpsAtOpen != null &&
    trade.markMatchStatusAtOpen != null
  )
}

function hasCompletePredictedOpenEvidence(trade: NormalizedPaperTrade): boolean {
  if (trade.predictedOpenEvidenceStatus === 'ok') return true
  return hasAnyPredictedCost(trade) &&
    trade.expectedGrossEdgePctAtOpen != null &&
    trade.expectedNetEdgePctAtOpen != null &&
    trade.expectedEdgeSourceAtOpen != null &&
    hasOpenTimeMarkMatchEvidence(trade)
}

function hasAnyRealizedCost(trade: NormalizedPaperTrade): boolean {
  if (isPaperModelOnlyCostEvidence(trade)) return false
  return (
    trade.realizedRoundTripCostBps != null ||
    trade.realizedCostBps != null ||
    trade.fillAdjustedCostBps != null ||
    trade.fillAdjustedCostPct != null
  )
}

function hasFillAdjustedCost(trade: NormalizedPaperTrade): boolean {
  if (isPaperModelOnlyCostEvidence(trade)) return false
  return trade.fillAdjustedCostBps != null || trade.fillAdjustedCostPct != null
}

function isPaperModelOnlyCostEvidence(trade: NormalizedPaperTrade): boolean {
  return trade.costEvidenceSource === 'paper_cost_model_at_open' ||
    trade.costEvidenceStatus === 'paper_model_not_exchange_reconciled'
}

function hasBothMfeMae(trade: NormalizedPaperTrade): boolean {
  return trade.mfeBps != null && trade.maeBps != null
}

function coveragePct(covered: number, total: number): number {
  return total > 0 ? covered / total * 100 : 0
}

function coverageStatus(
  total: number,
  covered: number,
): 'ok' | 'partial' | 'missing' | 'insufficient_data' {
  if (total === 0) return 'insufficient_data'
  const pct = coveragePct(covered, total)
  if (pct >= 95) return 'ok'
  if (covered > 0) return 'partial'
  return 'missing'
}

function countContextBucket(
  buckets: ContextCoverageBucketSummary[],
  bucket: ContextCoverageBucket,
): number {
  return buckets.find(item => item.bucket === bucket)?.count ?? 0
}

function buildStopLossRollingDiagnostics(
  trades: NormalizedPaperTrade[],
): PaperPnlDiagnosticsReport['stopLossRollingDiagnostics'] {
  const windowMs = STOP_LOSS_DIAGNOSTIC_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const scopeMap = new Map<string, {
    scopeType: StopLossRollingDiagnostic['scopeType']
    scopeKey: string
    trades: NormalizedPaperTrade[]
  }>()

  function addScope(
    scopeType: StopLossRollingDiagnostic['scopeType'],
    scopeKey: string,
    trade: NormalizedPaperTrade,
  ): void {
    const key = `${scopeType}:${scopeKey}`
    const scope = scopeMap.get(key)
    if (scope) {
      scope.trades.push(trade)
    } else {
      scopeMap.set(key, { scopeType, scopeKey, trades: [trade] })
    }
  }

  for (const trade of trades) {
    addScope('overall', 'all', trade)
    addScope('lane', trade.lane, trade)
    addScope('symbol', trade.symbol, trade)
    addScope('side', trade.side, trade)
    addScope('lane_symbol', `${trade.lane}|${trade.symbol}`, trade)
    addScope('lane_symbol_side', `${trade.lane}|${trade.symbol}|${trade.side}`, trade)
  }

  const scopes = [...scopeMap.values()]
    .map(scope => bestStopLossWindow(scope.scopeType, scope.scopeKey, scope.trades, windowMs))
    .filter((scope): scope is StopLossRollingDiagnostic => scope != null)
    .sort((a, b) =>
      Number(b.triggered) - Number(a.triggered) ||
      b.stopLossLossSharePct - a.stopLossLossSharePct ||
      b.stopLossCount - a.stopLossCount ||
      b.closedTrades - a.closedTrades ||
      a.scopeType.localeCompare(b.scopeType) ||
      a.scopeKey.localeCompare(b.scopeKey),
    )
  const triggers = scopes.filter(scope => scope.triggered)
  const clusterAttribution = buildStopLossClusterAttribution(trades, triggers)

  return {
    diagnosticUse: 'descriptive_worst_window_scan',
    promotionEligible: false,
    maxSelectionBias: true,
    windowDays: STOP_LOSS_DIAGNOSTIC_WINDOW_DAYS,
    thresholds: {
      stopLossCount: STOP_LOSS_DIAGNOSTIC_THRESHOLDS.stopLossCount,
      stopLossLossSharePct: STOP_LOSS_DIAGNOSTIC_THRESHOLDS.stopLossLossSharePct,
      closedTrades: STOP_LOSS_DIAGNOSTIC_THRESHOLDS.closedTrades,
    },
    windowsSearched: [...scopeMap.values()].reduce((sum, scope) => sum + countValidCloseTimestamps(scope.trades), 0),
    scopesSearched: scopeMap.size,
    triggered: triggers.length > 0,
    triggers,
    scopes,
    clusterAttribution,
  }
}

function countValidCloseTimestamps(trades: NormalizedPaperTrade[]): number {
  return trades.filter(trade => Number.isFinite(Date.parse(trade.closeTs))).length
}

function bestStopLossWindow(
  scopeType: StopLossRollingDiagnostic['scopeType'],
  scopeKey: string,
  trades: NormalizedPaperTrade[],
  windowMs: number,
): StopLossRollingDiagnostic | null {
  const sorted = trades
    .map(trade => ({ trade, closeMs: Date.parse(trade.closeTs) }))
    .filter((item): item is { trade: NormalizedPaperTrade; closeMs: number } => Number.isFinite(item.closeMs))
    .sort((a, b) => a.closeMs - b.closeMs)
  if (sorted.length === 0) return null

  let best: StopLossRollingDiagnostic | null = null
  for (let endIndex = 0; endIndex < sorted.length; endIndex++) {
    const endMs = sorted[endIndex].closeMs
    const startMs = endMs - windowMs
    const windowTrades = sorted
      .filter(item => item.closeMs >= startMs && item.closeMs <= endMs)
      .map(item => item.trade)
    const candidate = summarizeStopLossWindow(
      scopeType,
      scopeKey,
      windowTrades,
      new Date(startMs).toISOString(),
      sorted[endIndex].trade.closeTs,
    )
    if (!best || compareStopLossWindow(candidate, best) > 0) {
      best = candidate
    }
  }
  return best
}

function summarizeStopLossWindow(
  scopeType: StopLossRollingDiagnostic['scopeType'],
  scopeKey: string,
  trades: NormalizedPaperTrade[],
  windowStartTs: string,
  windowEndTs: string,
): StopLossRollingDiagnostic {
  const stopLossTrades = trades.filter(trade => trade.closeReason === 'stop_loss')
  const totalLossPct = trades
    .filter(trade => trade.pnlPct < 0)
    .reduce((acc, trade) => acc + Math.abs(trade.pnlPct), 0)
  const stopLossLossPct = stopLossTrades
    .filter(trade => trade.pnlPct < 0)
    .reduce((acc, trade) => acc + Math.abs(trade.pnlPct), 0)
  const stopLossLossSharePct = totalLossPct > 0 ? stopLossLossPct / totalLossPct * 100 : 0
  const triggered =
    trades.length >= STOP_LOSS_DIAGNOSTIC_THRESHOLDS.closedTrades &&
    stopLossTrades.length >= STOP_LOSS_DIAGNOSTIC_THRESHOLDS.stopLossCount &&
    stopLossLossSharePct >= STOP_LOSS_DIAGNOSTIC_THRESHOLDS.stopLossLossSharePct

  return {
    scopeType,
    scopeKey,
    triggered,
    windowStartTs,
    windowEndTs,
    closedTrades: trades.length,
    stopLossCount: stopLossTrades.length,
    stopLossLossSharePct,
    stopLossLossPct,
    totalLossPct,
  }
}

function compareStopLossWindow(
  a: StopLossRollingDiagnostic,
  b: StopLossRollingDiagnostic,
): number {
  return (
    Number(a.triggered) - Number(b.triggered) ||
    a.stopLossLossSharePct - b.stopLossLossSharePct ||
    a.stopLossCount - b.stopLossCount ||
    a.closedTrades - b.closedTrades ||
    a.totalLossPct - b.totalLossPct
  )
}

function buildStopLossClusterAttribution(
  trades: NormalizedPaperTrade[],
  triggers: StopLossRollingDiagnostic[],
): StopLossClusterAttribution {
  if (trades.length < STOP_LOSS_DIAGNOSTIC_THRESHOLDS.closedTrades) {
    return {
      status: 'insufficient_data',
      blockedBy: ['closed_trades_below_threshold'],
      nextAction: 'Continue collecting paper-only closed trades before assigning stop-loss cluster ownership.',
      evaluatedTrades: trades.length,
      stopLossTrades: trades.filter(trade => trade.closeReason === 'stop_loss').length,
      topOffenders: emptyStopLossTopOffenders(),
    }
  }

  if (triggers.length === 0) {
    return {
      status: 'not_triggered',
      blockedBy: ['rolling_stop_loss_thresholds_not_met'],
      nextAction: 'Keep monitoring stop-loss attribution; do not change stop parameters from this report alone.',
      evaluatedTrades: trades.length,
      stopLossTrades: trades.filter(trade => trade.closeReason === 'stop_loss').length,
      topOffenders: emptyStopLossTopOffenders(),
    }
  }

  const clusterTrades = collectTriggeredStopLossClusterTrades(trades, triggers)
  const stopLossTrades = clusterTrades.filter(trade => trade.closeReason === 'stop_loss')
  if (clusterTrades.length === 0 || stopLossTrades.length === 0) {
    return {
      status: 'triggered',
      blockedBy: ['triggered_cluster_trade_rows_unavailable'],
      nextAction: 'Re-run diagnostics with full trade logs so the triggered stop-loss window can be attributed.',
      evaluatedTrades: clusterTrades.length,
      stopLossTrades: stopLossTrades.length,
      topOffenders: emptyStopLossTopOffenders(),
    }
  }

  return {
    status: 'triggered',
    blockedBy: [
      'diagnostic_only_not_trading_gate',
      'requires_pro_review_before_policy_change',
    ],
    nextAction: 'Open a Pro review item for the top stop-loss clusters and test parameter changes in paper-only replay before any execution policy change.',
    evaluatedTrades: clusterTrades.length,
    stopLossTrades: stopLossTrades.length,
    topOffenders: {
      lanes: stopLossOffenders(clusterTrades, 'lane', trade => trade.lane),
      symbols: stopLossOffenders(clusterTrades, 'symbol', trade => trade.symbol),
      sides: stopLossOffenders(clusterTrades, 'side', trade => trade.side),
      laneSymbolSides: stopLossOffenders(clusterTrades, 'lane_symbol_side', trade => `${trade.lane}|${trade.symbol}|${trade.side}`),
      regimes: stopLossOffenders(clusterTrades, 'regime', trade => trade.regimeAtOpen ?? 'missing'),
      contextBuckets: stopLossOffenders(clusterTrades, 'context_bucket', trade => trade.contextCoverageBucket),
      volumeRatioBuckets: stopLossOffenders(clusterTrades, 'volume_ratio_bucket', trade => bucketVolumeRatio(trade.volumeRatioAtOpen)),
      breakQualityBuckets: stopLossOffenders(clusterTrades, 'break_quality_bucket', trade => bucketBreakQuality(trade.breakQualityAtOpen)),
      liquidityUsdBuckets: stopLossOffenders(clusterTrades, 'liquidity_usd_bucket', trade => bucketLiquidityUsd(trade.liquidityUsdAtOpen)),
      liquidityStatuses: stopLossOffenders(clusterTrades, 'liquidity_status', trade => trade.liquidityStatusAtOpen ?? 'missing'),
      spreadStatuses: stopLossOffenders(clusterTrades, 'spread_status', trade => trade.spreadStatusAtOpen ?? 'missing'),
      spreadBpsBuckets: stopLossOffenders(clusterTrades, 'spread_bps_bucket', trade => bucketSpreadBps(trade.spreadBpsAtOpen)),
      routeCostBpsBuckets: stopLossOffenders(clusterTrades, 'route_cost_bps_bucket', trade => bucketCostBps(trade.routeCostBpsAtOpen)),
      roundTripCostBpsBuckets: stopLossOffenders(clusterTrades, 'round_trip_cost_bps_bucket', trade => bucketCostBps(trade.roundTripCostBpsAtOpen)),
      markMatchStatuses: stopLossOffenders(clusterTrades, 'mark_match_status', trade => trade.markMatchStatusAtOpen ?? 'missing'),
      markMatchPenaltyBpsBuckets: stopLossOffenders(clusterTrades, 'mark_match_penalty_bps_bucket', trade => bucketCostBps(trade.markMatchPenaltyBpsAtOpen)),
      mfeBpsBuckets: stopLossOffenders(clusterTrades, 'mfe_bps_bucket', trade => bucketExcursionBps(trade.mfeBps)),
      maeBpsBuckets: stopLossOffenders(clusterTrades, 'mae_bps_bucket', trade => bucketExcursionBps(trade.maeBps)),
      mfeBeforeStopBuckets: stopLossOffenders(clusterTrades, 'mfe_before_stop', trade => trade.mfeBeforeStop == null ? 'missing' : String(trade.mfeBeforeStop)),
      timeToStopBuckets: stopLossOffenders(clusterTrades, 'time_to_stop_bucket', trade => bucketHoldingSeconds(trade.timeToStopSec)),
      holdingBuckets: stopLossOffenders(clusterTrades, 'holding_bucket', trade => bucketHoldingSeconds(trade.holdingSeconds)),
    },
  }
}

function emptyStopLossTopOffenders(): StopLossClusterAttribution['topOffenders'] {
  return {
    lanes: [],
    symbols: [],
    sides: [],
    laneSymbolSides: [],
    regimes: [],
    contextBuckets: [],
    volumeRatioBuckets: [],
    breakQualityBuckets: [],
    liquidityUsdBuckets: [],
    liquidityStatuses: [],
    spreadStatuses: [],
    spreadBpsBuckets: [],
    routeCostBpsBuckets: [],
    roundTripCostBpsBuckets: [],
    markMatchStatuses: [],
    markMatchPenaltyBpsBuckets: [],
    mfeBpsBuckets: [],
    maeBpsBuckets: [],
    mfeBeforeStopBuckets: [],
    timeToStopBuckets: [],
    holdingBuckets: [],
  }
}

function collectTriggeredStopLossClusterTrades(
  trades: NormalizedPaperTrade[],
  triggers: StopLossRollingDiagnostic[],
): NormalizedPaperTrade[] {
  const byId = new Map<string, NormalizedPaperTrade>()
  for (const trigger of triggers) {
    const startMs = trigger.windowStartTs ? Date.parse(trigger.windowStartTs) : NaN
    const endMs = trigger.windowEndTs ? Date.parse(trigger.windowEndTs) : NaN
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue
    for (const trade of trades) {
      const closeMs = Date.parse(trade.closeTs)
      if (!Number.isFinite(closeMs) || closeMs < startMs || closeMs > endMs) continue
      if (!tradeMatchesStopLossScope(trade, trigger)) continue
      byId.set(trade.tradeId, trade)
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.closeTs) - Date.parse(b.closeTs))
}

function tradeMatchesStopLossScope(
  trade: NormalizedPaperTrade,
  trigger: StopLossRollingDiagnostic,
): boolean {
  switch (trigger.scopeType) {
    case 'overall':
      return true
    case 'lane':
      return trade.lane === trigger.scopeKey
    case 'symbol':
      return trade.symbol === trigger.scopeKey
    case 'side':
      return trade.side === trigger.scopeKey
    case 'lane_symbol':
      return `${trade.lane}|${trade.symbol}` === trigger.scopeKey
    case 'lane_symbol_side':
      return `${trade.lane}|${trade.symbol}|${trade.side}` === trigger.scopeKey
    default:
      return false
  }
}

function stopLossOffenders(
  trades: NormalizedPaperTrade[],
  dimension: StopLossClusterOffender['dimension'],
  keyFn: (trade: NormalizedPaperTrade) => string,
): StopLossClusterOffender[] {
  const groups = new Map<string, NormalizedPaperTrade[]>()
  for (const trade of trades) {
    const key = keyFn(trade)
    groups.set(key, [...(groups.get(key) ?? []), trade])
  }

  return [...groups.entries()]
    .map(([key, groupTrades]) => summarizeStopLossOffender(dimension, key, groupTrades))
    .filter(offender => offender.stopLossCount > 0)
    .sort((a, b) =>
      b.stopLossLossPct - a.stopLossLossPct ||
      b.stopLossLossSharePct - a.stopLossLossSharePct ||
      b.stopLossCount - a.stopLossCount ||
      b.closedTrades - a.closedTrades ||
      a.key.localeCompare(b.key),
    )
    .slice(0, 10)
}

function summarizeStopLossOffender(
  dimension: StopLossClusterOffender['dimension'],
  key: string,
  trades: NormalizedPaperTrade[],
): StopLossClusterOffender {
  const stopLossTrades = trades.filter(trade => trade.closeReason === 'stop_loss')
  const totalLossPct = trades
    .filter(trade => trade.pnlPct < 0)
    .reduce((acc, trade) => acc + Math.abs(trade.pnlPct), 0)
  const stopLossLossPct = stopLossTrades
    .filter(trade => trade.pnlPct < 0)
    .reduce((acc, trade) => acc + Math.abs(trade.pnlPct), 0)
  const holdingValues = stopLossTrades
    .map(trade => trade.holdingSeconds)
    .filter((value): value is number => value != null)
  return {
    dimension,
    key,
    closedTrades: trades.length,
    stopLossCount: stopLossTrades.length,
    stopLossLossSharePct: totalLossPct > 0 ? stopLossLossPct / totalLossPct * 100 : 0,
    stopLossLossPct,
    totalLossPct,
    avgHoldingSeconds: holdingValues.length > 0 ? mean(holdingValues) : null,
    blockedBy: [
      'diagnostic_only_not_trading_gate',
      'needs_counterfactual_replay_or_pro_review',
    ],
    nextAction: stopLossNextAction(dimension, key),
  }
}

function stopLossNextAction(
  dimension: StopLossClusterOffender['dimension'],
  key: string,
): string {
  switch (dimension) {
    case 'lane':
      return `Review lane=${key} stop-loss calibration, entry timing, and exit reason traces in paper-only replay.`
    case 'symbol':
      return `Inspect symbol=${key} liquidity, spread, volatility, and stop placement in paper-only replay.`
    case 'side':
      return `Compare side=${key} stop-loss hits against directional regime and entry timing before changing stop parameters.`
    case 'lane_symbol_side':
      return `Replay lane|symbol|side=${key} as the primary cluster slice; separate entry timing, liquidity, and stop placement effects.`
    case 'regime':
      return `Check regime=${key} against registered failure regimes before allowing this lane to keep trading that environment.`
    case 'context_bucket':
      return `Audit context bucket=${key} capture quality before interpreting stop-loss performance.`
    case 'volume_ratio_bucket':
      return `Compare stop-loss hits in volumeRatio bucket=${key} against signal quality and slippage diagnostics.`
    case 'break_quality_bucket':
      return `Review breakQuality bucket=${key} for false breakouts and failed continuation patterns in paper-only replay.`
    case 'liquidity_usd_bucket':
      return `Inspect liquidityUsd bucket=${key}; require depth-aware replay before allowing similar stop-loss-prone entries.`
    case 'liquidity_status':
      return `Audit liquidityStatus=${key} against order book depth, fill quality, and stop placement before policy changes.`
    case 'spread_status':
      return `Audit spreadStatus=${key} for spread-driven stop-loss hits and execution-cost attribution.`
    case 'spread_bps_bucket':
      return `Compare spreadBps bucket=${key} stop-loss hits against adverse selection and slippage diagnostics.`
    case 'route_cost_bps_bucket':
      return `Compare routeCostBps bucket=${key} stop-loss hits against cost model and execution route selection.`
    case 'round_trip_cost_bps_bucket':
      return `Compare roundTripCostBps bucket=${key} against net edge lower bound before admitting similar trades.`
    case 'mark_match_status':
      return `Audit markMatchStatus=${key}; stale or invalid mark/match evidence should stay diagnostic-only.`
    case 'mark_match_penalty_bps_bucket':
      return `Review mark-match penalty bucket=${key} for stale mark, depleted liquidity, and adverse selection.`
    case 'mfe_bps_bucket':
      return `Use MFE bucket=${key} to separate bad entries from exits that failed to harvest favorable excursion.`
    case 'mae_bps_bucket':
      return `Use MAE bucket=${key} to quantify immediate adverse selection versus normal volatility noise.`
    case 'mfe_before_stop':
      return `Check mfeBeforeStop=${key}; if true dominates, focus on take-profit/trailing exits before widening stops.`
    case 'time_to_stop_bucket':
      return `Review timeToStop bucket=${key}; immediate stops imply entry/adverse-selection problems.`
    case 'holding_bucket':
      return `Review stop-loss timing for holding bucket=${key}; separate immediate adverse selection from late exits.`
    default:
      return 'Review stop-loss cluster details in paper-only replay before changing policy.'
  }
}

function buildRecommendations(report: PaperPnlDiagnosticsReport): string[] {
  const out: string[] = []
  if (report.stopLossRollingDiagnostics.triggered) {
    const primary = report.stopLossRollingDiagnostics.triggers[0]
    const primaryLane = report.stopLossRollingDiagnostics.clusterAttribution.topOffenders.lanes[0]
    const primarySymbol = report.stopLossRollingDiagnostics.clusterAttribution.topOffenders.symbols[0]
    if (primary) {
      out.push(
        `Stop-loss rolling diagnostic triggered for ${primary.scopeType}=${primary.scopeKey}: ` +
        `${primary.stopLossCount}/${primary.closedTrades} closed trades hit stop_loss over ` +
        `${report.stopLossRollingDiagnostics.windowDays}d, contributing ` +
        `${primary.stopLossLossSharePct.toFixed(1)}% of realized losses; nextAction=${report.stopLossRollingDiagnostics.clusterAttribution.nextAction}`,
      )
    }
    if (primaryLane || primarySymbol) {
      out.push(
        `Stop-loss top offenders: ` +
        `${primaryLane ? `lane=${primaryLane.key} (${primaryLane.stopLossCount} stop_loss, ${primaryLane.stopLossLossPct.toFixed(4)} loss pct)` : 'lane=none'}, ` +
        `${primarySymbol ? `symbol=${primarySymbol.key} (${primarySymbol.stopLossCount} stop_loss, ${primarySymbol.stopLossLossPct.toFixed(4)} loss pct)` : 'symbol=none'}; ` +
        `blockedBy=${report.stopLossRollingDiagnostics.clusterAttribution.blockedBy.join(',')}.`,
      )
    }
  }
  const badLanes = report.byLane.filter(group => group.count >= 3 && group.totalPnlPct < 0).slice(0, 3)
  for (const lane of badLanes) {
    out.push(`Lane ${lane.key} is negative over ${lane.count} closed trades (${formatPct(lane.totalPnlPct)} total, ${formatPct(lane.avgPnlPct)} avg); tighten entry thresholds or pause until Pro review.`)
  }
  const worstSymbol = report.bySymbol.find(group => group.count >= 2 && group.totalPnlPct < 0)
  if (worstSymbol) {
    out.push(`Worst repeated symbol is ${worstSymbol.key} (${formatPct(worstSymbol.totalPnlPct)} over ${worstSymbol.count} trades); consider temporary symbol block or stricter liquidity filter.`)
  }
  const worstReason = report.byCloseReason.find(group => group.count >= 3 && group.totalPnlPct < 0)
  if (worstReason) {
    out.push(`Losses cluster in closeReason=${worstReason.key} (${formatPct(worstReason.totalPnlPct)}); review hold duration, stop/target, and exit logic for this reason.`)
  }
  const lowRuleBucket = report.byRuleScoreBucket.find(group => group.key.startsWith('<0.2') || group.key.startsWith('0.2-0.4'))
  if (lowRuleBucket && lowRuleBucket.count >= 3 && lowRuleBucket.totalPnlPct < 0) {
    out.push(`Low rule-score trades are losing (${lowRuleBucket.key}: ${formatPct(lowRuleBucket.totalPnlPct)}); raise minimum ruleScore before allowing new paper entries.`)
  }
  const missingFlashShare = report.coverage.closedTrades > 0
    ? report.coverage.missingFlashConfidenceTrades / report.coverage.closedTrades
    : 0
  if (missingFlashShare > 0.5) {
    out.push(`${Math.round(missingFlashShare * 100)}% of closed trades lack flashConfidenceLowAtOpen; use post-upgrade trades for LLM-confidence conclusions.`)
  }
  const newMissingShare = report.coverage.closedTrades > 0
    ? report.coverage.newMissingContextTrades / report.coverage.closedTrades
    : 0
  if (newMissingShare > 0.1) {
    out.push(`${Math.round(newMissingShare * 100)}% of closed trades are new-format rows missing market-intel context; fix diagnostics capture before drawing context-quality conclusions.`)
  }
  if (report.coverage.contextEnforcementWindow.newMissingContextTrades > 0) {
    out.push(
      `Context enforcement window still has ${report.coverage.contextEnforcementWindow.newMissingContextTrades} new_missing closed trades since ` +
      `${report.coverage.contextEnforcementWindow.enforcementTs}; keep P0-E open until new_missing=0 in this window.`,
    )
  } else if (report.coverage.contextEnforcementWindow.dirtyHistoricalNewMissingTrades > 0) {
    out.push(
      `${report.coverage.contextEnforcementWindow.dirtyHistoricalNewMissingTrades} post-cutover context-missing closed trades occurred before enforcement ` +
      `${report.coverage.contextEnforcementWindow.enforcementTs}; treat them as historical dirty evidence, not clean-window failures.`,
    )
  }
  if (report.coverage.costEvidence.status !== 'ok') {
    out.push(
      `Cost evidence coverage is ${report.coverage.costEvidence.status}: ` +
      `${report.coverage.costEvidence.tradesWithAnyPredictedCost}/${report.coverage.costEvidence.closedTrades} closed trades carry open-time cost fields; keep promotion blocked until cost-after scoring has >=95% decision-time coverage.`,
    )
  }
  if (report.coverage.mfeMaeEvidence.status !== 'ok') {
    out.push(
      `MFE/MAE ledger coverage is ${report.coverage.mfeMaeEvidence.ledgerStatus}: ` +
      `${report.coverage.mfeMaeEvidence.tradesWithBothMfeMaeBps}/${report.coverage.mfeMaeEvidence.closedTrades} closed trades carry both MFE and MAE; stop-loss attribution remains incomplete without path evidence.`,
    )
  }
  if (report.coverage.mfeMaeEvidence.pathDiagnostics.status !== 'ok') {
    out.push(
      `MFE/MAE path diagnostics are ${report.coverage.mfeMaeEvidence.pathDiagnostics.status}: ` +
      `${report.coverage.mfeMaeEvidence.pathDiagnostics.diagnosticsOk}/${report.coverage.mfeMaeEvidence.pathDiagnostics.matchedTrades} matched trades have usable OHLC path diagnostics; ` +
      `this is read-only attribution and does not replace ledger coverage.`,
    )
  }
  if (report.openRisk.totalOpenPositions > 0) {
    out.push(`${report.openRisk.totalOpenPositions} paper positions are still open; diagnose realized PnL separately from current open risk.`)
    if (report.openRisk.evidence.risk !== 'none') {
      out.push(
        `Open-position evidence risk=${report.openRisk.evidence.risk}: ` +
        `${report.openRisk.evidence.completeV3Context}/${report.openRisk.totalOpenPositions} open positions have complete v3 context and ` +
        `${report.openRisk.evidence.completeCost}/${report.openRisk.totalOpenPositions} have cost evidence; ` +
        `${report.openRisk.evidence.legacyMissingContext} legacy opens may close dirty and should be separated from new_missing.`,
      )
    }
  }
  if (out.length === 0) out.push('No dominant loss cluster found; continue accumulating paper-only data before changing thresholds.')
  return out
}

function negativeTop(groups: GroupStats[], topN: number): GroupStats[] {
  return groups.filter(group => group.totalPnlPct < 0).slice(0, topN)
}

function bucketScore(value: number | null): string {
  if (value == null) return 'missing'
  if (value < 0.2) return '<0.2'
  if (value < 0.4) return '0.2-0.4'
  if (value < 0.6) return '0.4-0.6'
  if (value < 0.8) return '0.6-0.8'
  return '>=0.8'
}

function bucketRank(value: number | null): string {
  if (value == null) return 'missing'
  if (value <= 1) return '1'
  if (value <= 3) return '2-3'
  if (value <= 5) return '4-5'
  if (value <= 10) return '6-10'
  return '>10'
}

function bucketRankSpreadPct(value: number | null): string {
  if (value == null) return 'missing'
  const abs = Math.abs(value)
  if (abs < 2) return '<2'
  if (abs < 5) return '2-5'
  if (abs < 10) return '5-10'
  return '>=10'
}

function bucketCostPct(value: number | null): string {
  if (value == null) return 'missing'
  if (value < 0.1) return '<0.1'
  if (value < 0.25) return '0.1-0.25'
  if (value < 0.5) return '0.25-0.5'
  if (value < 1) return '0.5-1'
  return '>=1'
}

function bucketCostOfMarginPct(value: number | null): string {
  if (value == null) return 'missing'
  if (value < 0.5) return '<0.5'
  if (value < 1) return '0.5-1'
  if (value < 3) return '1-3'
  if (value < 10) return '3-10'
  return '>=10'
}

function bucketCostBps(value: number | null): string {
  if (value == null) return 'missing'
  if (value < 5) return '<5'
  if (value < 15) return '5-15'
  if (value < 30) return '15-30'
  if (value < 50) return '30-50'
  return '>=50'
}

function bucketLiquidityUsd(value: number | null): string {
  if (value == null) return 'missing'
  if (value < 10_000) return '<10k'
  if (value < 50_000) return '10k-50k'
  if (value < 250_000) return '50k-250k'
  if (value < 1_000_000) return '250k-1m'
  return '>=1m'
}

function bucketHoldingSeconds(value: number | null): string {
  if (value == null) return 'missing'
  if (value < 30) return '<30s'
  if (value < 120) return '30-120s'
  if (value < 600) return '2-10m'
  if (value < 1_800) return '10-30m'
  if (value < 3_600) return '30-60m'
  return '>=60m'
}

function bucketVolumeRatio(value: number | null): string {
  if (value == null) return 'missing'
  if (value < 1) return '<1'
  if (value < 2) return '1-2'
  if (value < 5) return '2-5'
  return '>=5'
}

function bucketBreakQuality(value: number | string | null): string {
  if (value == null) return 'missing'
  if (typeof value === 'number') {
    if (value < 0.35) return 'failed'
    if (value < 0.55) return 'weak'
    if (value < 0.75) return 'medium'
    return 'strong'
  }
  const normalized = value.toLowerCase()
  if (
    normalized === 'strong' ||
    normalized === 'medium' ||
    normalized === 'weak' ||
    normalized === 'failed'
  ) {
    return normalized
  }
  return normalized
}

function bucketSpreadBps(value: number | null): string {
  if (value == null) return 'missing'
  if (value < 5) return '<5'
  if (value < 10) return '5-10'
  if (value < 25) return '10-25'
  if (value < 50) return '25-50'
  return '>=50'
}

function bucketExcursionBps(value: number | null): string {
  if (value == null) return 'missing'
  const abs = Math.abs(value)
  if (abs < 25) return '<25'
  if (abs < 50) return '25-50'
  if (abs < 100) return '50-100'
  if (abs < 250) return '100-250'
  return '>=250'
}

function maxConsecutiveLosses(trades: NormalizedPaperTrade[]): number {
  let current = 0
  let max = 0
  for (const trade of trades) {
    if (trade.pnlPct < 0) {
      current += 1
      max = Math.max(max, current)
    } else {
      current = 0
    }
  }
  return max
}

function pickTrade(
  trade: NormalizedPaperTrade | null,
): GroupStats['worstTrade'] {
  if (!trade) return null
  return {
    tradeId: trade.tradeId,
    lane: trade.lane,
    symbol: trade.symbol,
    side: trade.side,
    pnlPct: trade.pnlPct,
    pnlUsd: trade.pnlUsd,
    closeReason: trade.closeReason,
    closeTs: trade.closeTs,
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
    } else {
      out.set(key, next)
      i += 1
    }
  }
  return out
}

function parseNullablePositiveNumber(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function readJsonl(path: string): Promise<RawRecord[]> {
  if (!existsSync(path)) return []
  const raw = await readFile(path, 'utf-8')
  const rows: RawRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed as RawRecord)
    } catch {
      // Ignore malformed JSONL rows so diagnostics can run on partially written logs.
    }
  }
  return rows
}

async function readJson(path: string): Promise<RawRecord | null> {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RawRecord : null
  } catch {
    return null
  }
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

function inferAccountIdFromPath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const accountMatch = normalized.match(/accounts\/([^/]+)\/account\.json$/)
  if (accountMatch) return accountMatch[1]
  const fileMatch = normalized.match(/([^/]+)\.json$/)
  return fileMatch?.[1]?.replace(/^account_?/, '') || 'unknown'
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function breakQualityOrNull(value: unknown): number | string | null {
  const numeric = numberOrNull(value)
  if (numeric != null) return numeric
  return normalizeStatus(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizeStatus(value: unknown): string | null {
  const text = stringOrNull(value)
  return text ? text.trim().toLowerCase().replace(/\s+/g, '_') : null
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function parseSide(value: unknown): 'long' | 'short' | 'unknown' {
  if (value === 'long' || value === 'short') return value
  return 'unknown'
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0)
}

function mean(values: number[]): number {
  return values.length > 0 ? sum(values) / values.length : 0
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}%`
}

function printSummary(report: PaperPnlDiagnosticsReport): void {
  console.log(JSON.stringify({
    generatedAt: report.generatedAt,
    closedTrades: report.coverage.closedTrades,
    overall: {
      totalPnlPct: report.overall.totalPnlPct,
      avgPnlPct: report.overall.avgPnlPct,
      winRate: report.overall.winRate,
      profitFactor: report.overall.profitFactor,
    },
    topLossLanes: report.topLossContributors.lanes.slice(0, 5).map(group => ({
      lane: group.key,
      count: group.count,
      totalPnlPct: group.totalPnlPct,
      avgPnlPct: group.avgPnlPct,
      winRate: group.winRate,
    })),
    topLossSymbols: report.topLossContributors.symbols.slice(0, 5).map(group => ({
      symbol: group.key,
      count: group.count,
      totalPnlPct: group.totalPnlPct,
    })),
    contextBuckets: report.coverage.contextBuckets,
    contextEnforcementWindow: report.coverage.contextEnforcementWindow,
    stopLossRollingTriggered: report.stopLossRollingDiagnostics.triggered,
    stopLossRollingTriggers: report.stopLossRollingDiagnostics.triggers.slice(0, 5),
    stopLossClusterAttribution: report.stopLossRollingDiagnostics.clusterAttribution,
    recommendations: report.recommendations,
    outputPath: report.inputs.outputPath,
  }, null, 2))
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  analyzePaperPnl(parseAnalyzePaperPnlArgs(process.argv.slice(2)))
    .then(printSummary)
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
