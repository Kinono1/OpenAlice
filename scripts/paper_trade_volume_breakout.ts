/**
 * Volume Breakout — Paper Trading Engine (5-minute bars).
 *
 * Flow:
 *   1. Load latest 5m candles from live_5m/
 *   2. Evaluate volume breakout for each asset
 *   3. Open positions on breakouts, close on hold expiry / stop-loss / reverse signal
 *
 * Usage: npx tsx scripts/paper_trade_volume_breakout.ts
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateVolumeBreakout, DEFAULT_VB_CONFIG } from '../src/domain/strategy/volume-breakout.js'
import { defaultPaperUniverseSymbols, paperSymbolToCsvFile } from './lib/paper_universe.js'
import {
  isMarketIntelSymbolBanned,
  readMarketIntelContext,
  type MarketIntelContext,
} from '../src/runtime/market_intel_context.js'
import { readSystemFuse, type SystemFuseState } from '../src/runtime/system_fuse.js'
import {
  appendPaperTradeResult,
  assertCompletePredictedOpenEvidenceRecord,
  buildPaperTradeMfeMaeEvidence,
  buildPaperTradeCostEvidence,
  withPaperTradeContextCoverage,
  type PaperTradeCloseReason,
} from '../src/runtime/paper_trade_result.js'
import {
  appendPaperPolicyShadowOpen,
  buildPaperPolicyShadowId,
  type AppendPaperPolicyShadowResult,
} from '../src/runtime/paper_policy_shadow_ledger.js'
import {
  buildPaperOpenContextSnapshot,
  paperOpenContextAcceptRejectReasons,
  type PaperOpenContextStatus,
} from '../src/runtime/paper_open_context.js'
import {
  DEFAULT_PAPER_MARK_MATCH_FALLBACK_PENALTY_BPS,
  resolvePaperMarkMatchOpenFields,
} from './lib/paper_mark_match.js'

// ==================== Data ====================

interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

async function loadCandles(path: string): Promise<Candle[]> {
  const raw = await readFile(path, 'utf-8')
  const lines = raw.trim().split('\n')
  const h = lines[0].split(',')
  const ti = h.indexOf('timestamp'), oi = h.indexOf('open'), hi = h.indexOf('high'), li = h.indexOf('low'), ci = h.indexOf('close'), vi = h.indexOf('volume')
  return lines.slice(1).map(l => { const c = l.split(','); return { timestamp: Number(c[ti]), open: Number(c[oi]), high: Number(c[hi]), low: Number(c[li]), close: Number(c[ci]), volume: Number(c[vi]) } }).filter(c => c.timestamp > 0).sort((a, b) => a.timestamp - b.timestamp)
}

// ==================== Account ====================

interface VBPosition {
  symbol: string; direction: 'long' | 'short'; entryPrice: number; stopLossPrice: number
  quantity: number; entryTime: string; entryBarTime: number; holdBars: number; confidence: number
  accountId?: string; accountLabel?: string; leverage?: number; marginUsd?: number; notionalUsd?: number
  contextSnapshotId?: string; decisionTime?: string; marketDataWatermarkAtDecisionTime?: string; watermark?: string
  featuresAvailableAtDecisionTime?: boolean; featureSchemaVersion?: string
  contextGenerationAtOpen?: number; flashConfidenceLowAtOpen?: number | null; ruleScoreAtOpen?: number
  contextStatus?: PaperOpenContextStatus | string | null; flashContextStatus?: PaperOpenContextStatus | string | null; contextReason?: string | null
  flashEpochAtOpen?: number | null; proEpochAtOpen?: number | null; marketIntelTriggerAtOpen?: string | null
  volumeRatioAtOpen?: number | null; rangeBreakoutPctAtOpen?: number | null; breakQualityAtOpen?: number | null
  liquidityUsdAtOpen?: number | null; liquidityStatusAtOpen?: string | null
	  spreadBpsAtOpen?: number | null; spreadStatusAtOpen?: string | null
	  estimatedRoundTripCostPctAtOpen?: number | null; estimatedRoundTripCostPctOfMarginAtOpen?: number | null
	  expectedGrossEdgePctAtOpen?: number | null; expectedNetEdgePctAtOpen?: number | null; expectedEdgeSourceAtOpen?: string | null
	  routeCostBpsAtOpen?: number | null; roundTripCostBpsAtOpen?: number | null
  markPriceAtOpen?: number | null; markPriceTimestampAtOpen?: string | null
  matchPriceAtOpen?: number | null; matchPriceSourceAtOpen?: string | null
  markMatchPenaltyBpsAtOpen?: number | null; markMatchStatusAtOpen?: string | null
}
interface VBSignalQualitySnapshot {
  volumeRatioAtOpen: number | null
  rangeBreakoutPctAtOpen: number | null
  breakQualityAtOpen: number | null
  liquidityUsdAtOpen: number | null
  liquidityStatusAtOpen: string | null
  spreadBpsAtOpen: number | null
  spreadStatusAtOpen: string | null
}
interface VBTrade extends Partial<VBSignalQualitySnapshot> {
  id: string; symbol: string; direction: 'long' | 'short'; entryPrice: number; exitPrice: number | null
  entryTime: string; exitTime: string | null; quantity: number; pnl: number | null; pnlPct: number | null
  reason: string; accountId?: string; accountLabel?: string; leverage?: number; marginUsd?: number; notionalUsd?: number
  contextSnapshotId?: string | null; decisionTime?: string | null; marketDataWatermarkAtDecisionTime?: string | null; watermark?: string | null
  featuresAvailableAtDecisionTime?: boolean | null; featureSchemaVersion?: string | null
  contextGenerationAtOpen?: number | null; contextStatus?: string | null; flashContextStatus?: string | null; contextReason?: string | null
  flashEpochAtOpen?: number | null; flashConfidenceLowAtOpen?: number | null; ruleScoreAtOpen?: number | null
	  proEpochAtOpen?: number | null; marketIntelTriggerAtOpen?: string | null
	  estimatedRoundTripCostPctAtOpen?: number | null; estimatedRoundTripCostPctOfMarginAtOpen?: number | null
	  expectedGrossEdgePctAtOpen?: number | null; expectedNetEdgePctAtOpen?: number | null; expectedEdgeSourceAtOpen?: string | null
	  routeCostBpsAtOpen?: number | null; roundTripCostBpsAtOpen?: number | null
  markPriceAtOpen?: number | null; markPriceTimestampAtOpen?: string | null
  matchPriceAtOpen?: number | null; matchPriceSourceAtOpen?: string | null
  markMatchPenaltyBpsAtOpen?: number | null; markMatchStatusAtOpen?: string | null
}
interface VBAccount { equity: number; initialEquity: number; positions: VBPosition[]; tradeHistory: VBTrade[] }
interface VBProfile { id: string; label: string; leverage: number; positionFraction: number; maxPositions: number }
interface VBExecutionGate {
  minConfidence: number
  minRangeBreakoutPct: number
  maxVolumeRatio: number
  minBreakQuality: number
  minLiquidityUsd: number
  maxSpreadBps: number
}
interface RejectedVBSignal {
  symbol: string
  reason: string
  confidence: number
  rangeBreakoutPct: number
  volumeRatio: number
  breakQuality?: number
  liquidityUsd?: number | null
  liquidityStatus?: 'pass' | 'fail' | 'unknown'
  spreadBps?: number | null
  spreadStatus?: 'pass' | 'fail' | 'unknown'
}
interface VBProfileReport {
  id: string
  label: string
  mode: 'paper_trade'
  cadence: 'minute'
  timeframe: '5m'
  strategyLane: 'volume_breakout'
  leverage: number
  equity: number
  initialEquity: number
  openPositions: number
  totalTrades: number
  returnPct: number
  gate?: VBGate
}
interface VBGate {
  allowNew: boolean
  reasons: string[]
  context: MarketIntelContext
  fuse: SystemFuseState
}

const SYMBOLS = defaultPaperUniverseSymbols()
const MINUTE_PROFILES: VBProfile[] = [
  { id: 'spot_1x', label: 'Spot 1x baseline', leverage: 1, positionFraction: 0.1, maxPositions: 3 },
  { id: 'conservative_3x', label: 'Conservative 3x', leverage: 3, positionFraction: 0.05, maxPositions: 3 },
]
const DEFAULT_VB_EXECUTION_GATE: VBExecutionGate = {
  minConfidence: 0.2,
  minRangeBreakoutPct: 1,
  maxVolumeRatio: 1_000,
  minBreakQuality: DEFAULT_VB_CONFIG.minBreakQuality,
  minLiquidityUsd: DEFAULT_VB_CONFIG.minVolumeUsd,
  maxSpreadBps: DEFAULT_VB_CONFIG.maxSpreadBps,
}
const PAPER_FEE_RATE = 0.0006
const PAPER_SLIPPAGE_BPS = 8
const PAPER_STALE_MARK_MATCH_PENALTY_BPS = DEFAULT_PAPER_MARK_MATCH_FALLBACK_PENALTY_BPS

function accountPath(profile: VBProfile): string {
  return join(import.meta.dirname ?? '.', '..', 'data', 'paper_trading', `account_vb_${profile.id}.json`)
}

function legacyAccountPath(): string {
  return join(import.meta.dirname ?? '.', '..', 'data', 'paper_trading', 'account_vb.json')
}

function profileLane(profile: VBProfile): 'volume_breakout_1x' | 'volume_breakout_3x' {
  return profile.id === 'spot_1x' ? 'volume_breakout_1x' : 'volume_breakout_3x'
}

function effectiveVBMinConfidence(profile: VBProfile, context: MarketIntelContext): number {
  const lane = profileLane(profile)
  return Math.max(
    DEFAULT_VB_EXECUTION_GATE.minConfidence,
    context.suggestedRuleThresholdByLane[lane] ?? 0,
  )
}

function nullableFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function buildVBSignalQualitySnapshot(
  signal: ReturnType<typeof evaluateVolumeBreakout>,
): VBSignalQualitySnapshot {
  return {
    volumeRatioAtOpen: nullableFinite(signal.volumeRatio),
    rangeBreakoutPctAtOpen: nullableFinite(signal.rangeBreakoutPct),
    breakQualityAtOpen: nullableFinite(signal.breakQuality),
    liquidityUsdAtOpen: nullableFinite(signal.liquidityUsd),
    liquidityStatusAtOpen: signal.liquidityStatus ?? null,
    spreadBpsAtOpen: nullableFinite(signal.spreadBps),
    spreadStatusAtOpen: signal.spreadStatus ?? null,
  }
}

function copyVBSignalQualityFromPosition(pos: VBPosition): VBSignalQualitySnapshot {
  return {
    volumeRatioAtOpen: nullableFinite(pos.volumeRatioAtOpen),
    rangeBreakoutPctAtOpen: nullableFinite(pos.rangeBreakoutPctAtOpen),
    breakQualityAtOpen: nullableFinite(pos.breakQualityAtOpen),
    liquidityUsdAtOpen: nullableFinite(pos.liquidityUsdAtOpen),
    liquidityStatusAtOpen: pos.liquidityStatusAtOpen ?? null,
    spreadBpsAtOpen: nullableFinite(pos.spreadBpsAtOpen),
    spreadStatusAtOpen: pos.spreadStatusAtOpen ?? null,
  }
}

function estimatePaperRoundTripCostPct(markMatchPenaltyBps = PAPER_STALE_MARK_MATCH_PENALTY_BPS): number {
  const feeCost = PAPER_FEE_RATE * 2
  const slippageCost = (PAPER_SLIPPAGE_BPS / 10_000) * 2
  const markMatchPenalty = Math.max(0, markMatchPenaltyBps) / 10_000
  return roundSignalQualityNumber((feeCost + slippageCost + markMatchPenalty) * 100)
}

function buildVBCostSnapshot(
  leverage: number,
  matchPrice: number,
  symbol?: string,
  decisionTime?: string | Date | number | null,
): Pick<
  VBPosition,
  | 'estimatedRoundTripCostPctAtOpen'
  | 'estimatedRoundTripCostPctOfMarginAtOpen'
  | 'routeCostBpsAtOpen'
  | 'roundTripCostBpsAtOpen'
  | 'markPriceAtOpen'
  | 'markPriceTimestampAtOpen'
  | 'matchPriceAtOpen'
  | 'matchPriceSourceAtOpen'
  | 'markMatchPenaltyBpsAtOpen'
  | 'markMatchStatusAtOpen'
> {
  const markMatch = symbol
    ? resolvePaperMarkMatchOpenFields({
        symbol,
        decisionTime,
        matchPrice,
        fallbackPenaltyBps: PAPER_STALE_MARK_MATCH_PENALTY_BPS,
      })
    : resolvePaperMarkMatchOpenFields({
        symbol: '',
        decisionTime: null,
        matchPrice,
        fallbackPenaltyBps: PAPER_STALE_MARK_MATCH_PENALTY_BPS,
      })
  const estimatedRoundTripCostPctAtOpen = estimatePaperRoundTripCostPct(markMatch.markMatchPenaltyBpsAtOpen)
  const roundTripCostBpsAtOpen = roundSignalQualityNumber(estimatedRoundTripCostPctAtOpen * 100)
  return {
    estimatedRoundTripCostPctAtOpen,
    estimatedRoundTripCostPctOfMarginAtOpen: roundSignalQualityNumber(estimatedRoundTripCostPctAtOpen * Math.max(leverage, 1)),
    routeCostBpsAtOpen: roundTripCostBpsAtOpen,
    roundTripCostBpsAtOpen,
    ...markMatch,
  }
}

function buildVBExpectedEdgeSnapshot(
  signal: ReturnType<typeof evaluateVolumeBreakout>,
  estimatedRoundTripCostPctAtOpen: number | null,
): Pick<
  VBPosition,
  | 'expectedGrossEdgePctAtOpen'
  | 'expectedNetEdgePctAtOpen'
  | 'expectedEdgeSourceAtOpen'
> {
  const grossEdge = nullableFinite(signal.rangeBreakoutPct) == null ||
    nullableFinite(signal.breakQuality) == null ||
    signal.rangeBreakoutPct <= 0 ||
    signal.breakQuality <= 0
    ? null
    : roundSignalQualityNumber(signal.rangeBreakoutPct * signal.breakQuality)
  return {
    expectedGrossEdgePctAtOpen: grossEdge,
    expectedNetEdgePctAtOpen: grossEdge == null || estimatedRoundTripCostPctAtOpen == null
      ? null
      : roundSignalQualityNumber(grossEdge - estimatedRoundTripCostPctAtOpen),
    expectedEdgeSourceAtOpen: grossEdge == null ? null : 'volume_breakout_range_break_pct_x_quality_minus_paper_route_cost',
  }
}

function roundSignalQualityNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function copyVBCostSnapshotFromPosition(pos: VBPosition): Pick<
  VBPosition,
  | 'estimatedRoundTripCostPctAtOpen'
  | 'estimatedRoundTripCostPctOfMarginAtOpen'
  | 'expectedGrossEdgePctAtOpen'
  | 'expectedNetEdgePctAtOpen'
  | 'expectedEdgeSourceAtOpen'
  | 'routeCostBpsAtOpen'
  | 'roundTripCostBpsAtOpen'
  | 'markPriceAtOpen'
  | 'markPriceTimestampAtOpen'
  | 'matchPriceAtOpen'
  | 'matchPriceSourceAtOpen'
  | 'markMatchPenaltyBpsAtOpen'
  | 'markMatchStatusAtOpen'
> {
  return {
    estimatedRoundTripCostPctAtOpen: pos.estimatedRoundTripCostPctAtOpen ?? null,
    estimatedRoundTripCostPctOfMarginAtOpen: pos.estimatedRoundTripCostPctOfMarginAtOpen ?? null,
    expectedGrossEdgePctAtOpen: pos.expectedGrossEdgePctAtOpen ?? null,
    expectedNetEdgePctAtOpen: pos.expectedNetEdgePctAtOpen ?? null,
    expectedEdgeSourceAtOpen: pos.expectedEdgeSourceAtOpen ?? null,
    routeCostBpsAtOpen: pos.routeCostBpsAtOpen ?? null,
    roundTripCostBpsAtOpen: pos.roundTripCostBpsAtOpen ?? null,
    markPriceAtOpen: pos.markPriceAtOpen ?? null,
    markPriceTimestampAtOpen: pos.markPriceTimestampAtOpen ?? null,
    matchPriceAtOpen: pos.matchPriceAtOpen ?? null,
    matchPriceSourceAtOpen: pos.matchPriceSourceAtOpen ?? null,
    markMatchPenaltyBpsAtOpen: pos.markMatchPenaltyBpsAtOpen ?? null,
    markMatchStatusAtOpen: pos.markMatchStatusAtOpen ?? null,
  }
}

function copyVBOpenContextFromPosition(pos: VBPosition): Pick<
  VBTrade,
  | 'contextSnapshotId'
  | 'decisionTime'
  | 'marketDataWatermarkAtDecisionTime'
  | 'watermark'
  | 'featuresAvailableAtDecisionTime'
  | 'featureSchemaVersion'
  | 'contextGenerationAtOpen'
  | 'contextStatus'
  | 'flashContextStatus'
  | 'contextReason'
  | 'flashEpochAtOpen'
  | 'flashConfidenceLowAtOpen'
  | 'ruleScoreAtOpen'
  | 'proEpochAtOpen'
  | 'marketIntelTriggerAtOpen'
> {
  const watermark = pos.watermark ?? pos.marketDataWatermarkAtDecisionTime ?? null
  const flashContextStatus = pos.flashContextStatus ?? pos.contextStatus ?? null
  return {
    contextSnapshotId: pos.contextSnapshotId ?? null,
    decisionTime: pos.decisionTime ?? null,
    marketDataWatermarkAtDecisionTime: pos.marketDataWatermarkAtDecisionTime ?? watermark,
    watermark,
    featuresAvailableAtDecisionTime: pos.featuresAvailableAtDecisionTime ?? null,
    featureSchemaVersion: pos.featureSchemaVersion ?? null,
    contextGenerationAtOpen: pos.contextGenerationAtOpen ?? null,
    contextStatus: pos.contextStatus ?? null,
    flashContextStatus,
    contextReason: pos.contextReason ?? null,
    flashEpochAtOpen: pos.flashEpochAtOpen ?? null,
    flashConfidenceLowAtOpen: pos.flashConfidenceLowAtOpen ?? null,
    ruleScoreAtOpen: pos.ruleScoreAtOpen ?? pos.confidence ?? null,
    proEpochAtOpen: pos.proEpochAtOpen ?? null,
    marketIntelTriggerAtOpen: pos.marketIntelTriggerAtOpen ?? null,
  }
}

export function assertCompleteVolumeBreakoutPredictedOpenEvidenceForTest(
  kind: 'position' | 'trade' | 'shadow_open',
  value: Partial<VBPosition>,
): void {
  assertCompleteVolumeBreakoutPredictedOpenEvidence(kind, value)
}

function assertCompleteVolumeBreakoutPredictedOpenEvidence(
  kind: 'position' | 'trade' | 'shadow_open',
  value: Partial<VBPosition>,
): void {
  assertCompletePredictedOpenEvidenceRecord({
    errorPrefix: 'volume_breakout',
    kind,
    value,
  })
}

function loadAccount(profile: VBProfile): VBAccount {
  try {
    return JSON.parse(readFileSync(accountPath(profile), 'utf-8'))
  } catch {
    if (profile.id === 'spot_1x') {
      try {
        return JSON.parse(readFileSync(legacyAccountPath(), 'utf-8'))
      } catch {
        // New account.
      }
    }
    return { equity: 100_000, initialEquity: 100_000, positions: [], tradeHistory: [] }
  }
}

async function saveAccount(profile: VBProfile, acc: VBAccount) {
  const dir = join(import.meta.dirname ?? '.', '..', 'data', 'paper_trading')
  await mkdir(dir, { recursive: true })
  await writeFile(accountPath(profile), JSON.stringify(acc, null, 2))
  if (profile.id === 'spot_1x') {
    await writeFile(legacyAccountPath(), JSON.stringify(acc, null, 2))
  }
}

async function saveRuntimeReport(report: unknown) {
  const dir = join(import.meta.dirname ?? '.', '..', 'data', 'runtime')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'paper_volume_breakout.latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
}

export function shouldAllowUngatedPaperLane(argv: string[]): boolean {
  const raw = parseRawArgs(argv)
  return parseBool(raw.get('allowUngatedPaperLane'), false)
}

export function shouldDryRun(argv: string[]): boolean {
  const raw = parseRawArgs(argv)
  return parseBool(raw.get('dryRun'), true)
}

export function filterExecutableVolumeBreakoutSignals(
  signals: ReturnType<typeof evaluateVolumeBreakout>[],
  gate: VBExecutionGate = DEFAULT_VB_EXECUTION_GATE,
): {
  executableSignals: ReturnType<typeof evaluateVolumeBreakout>[]
  rejectedSignals: RejectedVBSignal[]
} {
  const executableSignals: ReturnType<typeof evaluateVolumeBreakout>[] = []
  const rejectedSignals: RejectedVBSignal[] = []

  for (const signal of signals) {
    const reasons: string[] = []
    if (signal.confidence < gate.minConfidence) {
      reasons.push(`confidence ${signal.confidence.toFixed(3)} < ${gate.minConfidence}`)
    }
    if (signal.rangeBreakoutPct < gate.minRangeBreakoutPct) {
      reasons.push(`break ${signal.rangeBreakoutPct.toFixed(3)}% < ${gate.minRangeBreakoutPct}%`)
    }
    if (signal.volumeRatio > gate.maxVolumeRatio) {
      reasons.push(`volume ratio ${signal.volumeRatio.toFixed(1)}x > ${gate.maxVolumeRatio}x`)
    }
    if (!Number.isFinite(signal.breakQuality) || signal.breakQuality == null || signal.breakQuality <= 0) {
      reasons.push('break quality missing or invalid')
    } else if (signal.breakQuality < gate.minBreakQuality) {
      reasons.push(`break quality ${signal.breakQuality.toFixed(2)} < ${gate.minBreakQuality}`)
    }
    if (signal.liquidityStatus === 'fail') {
      reasons.push(`liquidity ${(signal.liquidityUsd ?? 0).toFixed(0)} USD < ${gate.minLiquidityUsd}`)
    }
    if (signal.spreadStatus === 'fail') {
      reasons.push(`spread ${(signal.spreadBps ?? 0).toFixed(1)} bps > ${gate.maxSpreadBps}`)
    }

    if (reasons.length > 0) {
      rejectedSignals.push({
        symbol: signal.symbol,
        reason: reasons.join('; '),
        confidence: signal.confidence,
        rangeBreakoutPct: signal.rangeBreakoutPct,
        volumeRatio: signal.volumeRatio,
        breakQuality: signal.breakQuality,
        liquidityUsd: signal.liquidityUsd,
        liquidityStatus: signal.liquidityStatus,
        spreadBps: signal.spreadBps,
        spreadStatus: signal.spreadStatus,
      })
    } else {
      executableSignals.push(signal)
    }
  }

  return { executableSignals, rejectedSignals }
}

// ==================== Main ====================

export function closeExpiredPositions(
  profile: VBProfile,
  account: VBAccount,
  assets: Array<{ symbol: string; candles: Candle[] }>,
  gate: VBGate,
) {
  for (const pos of [...account.positions]) {
    const asset = assets.find(a => a.symbol === pos.symbol)
    if (!asset) continue
    const currentBar = asset.candles[asset.candles.length - 1]
    const currentPrice = currentBar.close
    const entryIdx = asset.candles.findIndex(c => c.timestamp === pos.entryBarTime)
    const barsHeld = entryIdx >= 0 ? asset.candles.length - 1 - entryIdx : 999
    const bannedSymbol = isMarketIntelSymbolBanned(gate.context, pos.symbol)
    let shouldClose = false
    let closeReason = ''

    // Check for liquidation (high leverage positions)
    const priceReturnForLiq = pos.direction === 'long'
      ? (currentPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - currentPrice) / pos.entryPrice
    const notionalUsdForLiq = pos.notionalUsd ?? pos.quantity * pos.entryPrice
    const marginUsdForLiq = pos.marginUsd ?? notionalUsdForLiq / Math.max(pos.leverage ?? profile.leverage, 1)
    const unrealizedPnl = priceReturnForLiq * notionalUsdForLiq
    const marginRemaining = marginUsdForLiq + unrealizedPnl
    const marginRatio = marginUsdForLiq > 0 ? marginRemaining / marginUsdForLiq : 1

    if (bannedSymbol) {
      shouldClose = true; closeReason = 'MarketIntel banned symbol'
    } else if (barsHeld >= pos.holdBars) {
      shouldClose = true; closeReason = `Hold expired (${barsHeld}/${pos.holdBars} bars)`
    } else if (marginRatio <= 0.2) {
      shouldClose = true; closeReason = `LIQUIDATED (margin ratio ${(marginRatio*100).toFixed(0)}%)`
    } else if (pos.direction === 'long' && currentPrice <= pos.stopLossPrice) {
      shouldClose = true; closeReason = `Stop loss hit (${currentPrice} <= ${pos.stopLossPrice})`
    } else if (pos.direction === 'short' && currentPrice >= pos.stopLossPrice) {
      shouldClose = true; closeReason = `Stop loss hit (${currentPrice} >= ${pos.stopLossPrice})`
    }

    if (!shouldClose) continue

    const notionalUsd = pos.notionalUsd ?? pos.quantity * pos.entryPrice
    const marginUsd = pos.marginUsd ?? notionalUsd / Math.max(pos.leverage ?? profile.leverage, 1)
    const priceReturn = pos.direction === 'long'
      ? (currentPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - currentPrice) / pos.entryPrice
    const pnl = priceReturn * notionalUsd
    const pnlPct = priceReturn * 100
    const signalQualityAtOpen = copyVBSignalQualityFromPosition(pos)
    const costAtOpen = copyVBCostSnapshotFromPosition(pos)
    const contextAtOpen = copyVBOpenContextFromPosition(pos)
    const trade: VBTrade = {
      id: `close_${profile.id}_${pos.symbol}_${Date.now()}`,
      symbol: pos.symbol,
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      exitPrice: currentPrice,
      entryTime: pos.entryTime,
      exitTime: new Date().toISOString(),
      quantity: pos.quantity,
      pnl,
      pnlPct,
      reason: closeReason,
      accountId: profile.id,
      accountLabel: profile.label,
      leverage: pos.leverage ?? profile.leverage,
      marginUsd,
      notionalUsd,
      ...contextAtOpen,
      ...signalQualityAtOpen,
      ...costAtOpen,
    }
    account.equity += pnl
    account.tradeHistory.push(trade)
    account.positions = account.positions.filter(p => p !== pos)
    appendPaperTradeResult(withPaperTradeContextCoverage({
      tradeId: trade.id,
      lane: profileLane(profile),
      symbol: trade.symbol,
      leverage: profile.leverage,
      side: trade.direction,
      openTs: trade.entryTime,
      closeTs: trade.exitTime,
      openPrice: trade.entryPrice,
      closePrice: trade.exitPrice,
      pnlPct: trade.pnlPct,
      pnlUsd: trade.pnl,
      closeReason: mapVBCloseReason(closeReason),
      priceSource: '5m',
      priceStale: false,
      contextSnapshotId: pos.contextSnapshotId ?? null,
      decisionTime: pos.decisionTime ?? null,
      marketDataWatermarkAtDecisionTime: pos.marketDataWatermarkAtDecisionTime ?? null,
      watermark: pos.watermark ?? pos.marketDataWatermarkAtDecisionTime ?? null,
      featuresAvailableAtDecisionTime: pos.featuresAvailableAtDecisionTime ?? null,
      featureSchemaVersion: pos.featureSchemaVersion ?? null,
      contextGenerationAtOpen: pos.contextGenerationAtOpen ?? null,
      contextStatus: pos.contextStatus ?? null,
      flashContextStatus: pos.flashContextStatus ?? pos.contextStatus ?? null,
      contextReason: pos.contextReason ?? null,
      flashEpochAtOpen: pos.flashEpochAtOpen ?? null,
      flashConfidenceLowAtOpen: pos.flashConfidenceLowAtOpen ?? null,
      ruleScoreAtOpen: pos.ruleScoreAtOpen ?? pos.confidence ?? null,
      proEpochAtOpen: pos.proEpochAtOpen ?? null,
      marketIntelTriggerAtOpen: pos.marketIntelTriggerAtOpen ?? null,
      ...signalQualityAtOpen,
      ...costAtOpen,
      ...buildPaperTradeCostEvidence(costAtOpen),
      ...buildPaperTradeMfeMaeEvidence({
        side: trade.direction,
        openTs: trade.entryTime,
        closeTs: trade.exitTime,
        openPrice: trade.entryPrice,
        closeReason: mapVBCloseReason(closeReason),
        priceSource: '5m',
        candles: asset.candles,
      }),
    }))
    const emoji = pnl > 0 ? '🟢' : '🔴'
    console.log(`${emoji} ${profile.id} CLOSED ${pos.symbol} ${pos.direction}: ${pnlPct.toFixed(2)}% ($${pnl.toFixed(2)}) — ${closeReason}`)
  }
}

export function openNewPositions(
  profile: VBProfile,
  account: VBAccount,
  executableSignals: ReturnType<typeof evaluateVolumeBreakout>[],
  gate: VBGate,
) {
  if (!gate.allowNew) return
  const capacity = profile.maxPositions - account.positions.length
  if (capacity <= 0) return
  const minConfidence = effectiveVBMinConfidence(profile, gate.context)

  for (const signal of executableSignals) {
    if (account.positions.length >= profile.maxPositions) break
    if (account.positions.some(p => p.symbol === signal.symbol)) continue
    if (signal.confidence < minConfidence) {
      recordRejectedSignalShadowOpen(
        profile,
        signal,
        `profile_min_confidence ${signal.confidence.toFixed(3)} < ${minConfidence}`,
        gate.context,
      )
      continue
    }
    const price = signal.entryPrice
    const marginUsd = account.equity * profile.positionFraction
    const notionalUsd = marginUsd * profile.leverage
    const quantity = notionalUsd / price
    const lane = profileLane(profile)
    const openContext = buildPaperOpenContextSnapshot(gate.context, lane)
    const contextRejectReasons = paperOpenContextAcceptRejectReasons(openContext)
    if (contextRejectReasons.length > 0) {
      recordRejectedSignalShadowOpen(
        profile,
        signal,
        contextRejectReasons.join('; '),
        gate.context,
      )
      continue
    }
    const signalQualityAtOpen = buildVBSignalQualitySnapshot(signal)
    const costAtOpen = buildVBCostSnapshot(profile.leverage, price, signal.symbol, openContext.decisionTime)
    const edgeAtOpen = buildVBExpectedEdgeSnapshot(signal, costAtOpen.estimatedRoundTripCostPctAtOpen)

    const pos: VBPosition = {
      symbol: signal.symbol,
      direction: signal.signal === 1 ? 'long' : 'short',
      entryPrice: price,
      stopLossPrice: signal.stopLossPrice,
      quantity,
      entryTime: new Date().toISOString(),
      entryBarTime: signal.barTime,
      holdBars: DEFAULT_VB_CONFIG.holdBars,
      confidence: signal.confidence,
      accountId: profile.id,
      accountLabel: profile.label,
      leverage: profile.leverage,
      marginUsd,
      notionalUsd,
      contextSnapshotId: openContext.contextSnapshotId,
      decisionTime: openContext.decisionTime,
      marketDataWatermarkAtDecisionTime: openContext.marketDataWatermarkAtDecisionTime,
      watermark: openContext.watermark,
      featuresAvailableAtDecisionTime: openContext.featuresAvailableAtDecisionTime,
      featureSchemaVersion: openContext.featureSchemaVersion,
      contextGenerationAtOpen: openContext.contextGenerationAtOpen,
      contextStatus: openContext.contextStatus,
      flashContextStatus: openContext.flashContextStatus,
      contextReason: openContext.contextReason,
      flashEpochAtOpen: openContext.flashEpochAtOpen,
      flashConfidenceLowAtOpen: openContext.flashConfidenceLowAtOpen,
      ruleScoreAtOpen: signal.confidence,
      proEpochAtOpen: openContext.proEpochAtOpen,
      marketIntelTriggerAtOpen: openContext.marketIntelTriggerAtOpen,
      ...signalQualityAtOpen,
      ...edgeAtOpen,
      ...costAtOpen,
    }
    assertCompleteVolumeBreakoutPredictedOpenEvidence('position', pos)
    account.positions.push(pos)

    const trade: VBTrade = {
      id: `open_${profile.id}_${signal.symbol}_${Date.now()}`,
      symbol: signal.symbol,
      direction: pos.direction,
      entryPrice: price,
      exitPrice: null,
      entryTime: new Date().toISOString(),
      exitTime: null,
      quantity,
      pnl: null,
      pnlPct: null,
      reason: signal.reason,
      accountId: profile.id,
      accountLabel: profile.label,
      leverage: profile.leverage,
      marginUsd,
      notionalUsd,
      ...copyVBOpenContextFromPosition(pos),
      ...signalQualityAtOpen,
      ...edgeAtOpen,
      ...costAtOpen,
    }
    assertCompleteVolumeBreakoutPredictedOpenEvidence('trade', trade)
    account.tradeHistory.push(trade)

    console.log(`${signal.signal === 1 ? '📈' : '📉'} ${profile.id} OPENED ${pos.direction.toUpperCase()} ${signal.symbol} @ $${price.toFixed(2)} x ${quantity.toFixed(4)} (margin=$${marginUsd.toFixed(0)}, notional=$${notionalUsd.toFixed(0)}, ${profile.leverage}x)`)
  }
}

export function recordRejectedVolumeBreakoutSignalShadowOpenForTest(
  profile: VBProfile,
  signal: ReturnType<typeof evaluateVolumeBreakout>,
  reason: string,
  context: MarketIntelContext,
): AppendPaperPolicyShadowResult | null {
  return recordRejectedSignalShadowOpen(profile, signal, reason, context)
}

function recordRejectedSignalShadowOpen(
  profile: VBProfile,
  signal: ReturnType<typeof evaluateVolumeBreakout>,
  reason: string,
  context: MarketIntelContext,
): AppendPaperPolicyShadowResult | null {
  if (signal.signal === 0 || signal.entryPrice <= 0) return null
  const lane = profileLane(profile)
  const side = signal.signal === 1 ? 'long' : 'short'
  const horizonMs = DEFAULT_VB_CONFIG.holdBars * 5 * 60 * 1000
  const openContext = buildPaperOpenContextSnapshot(context, lane)
  const quality = buildVBSignalQualitySnapshot(signal)
  const cost = buildVBCostSnapshot(profile.leverage, signal.entryPrice, signal.symbol, openContext.decisionTime)
  const edge = buildVBExpectedEdgeSnapshot(signal, cost.estimatedRoundTripCostPctAtOpen)
  assertCompleteVolumeBreakoutPredictedOpenEvidence('shadow_open', {
    ...cost,
    ...edge,
  })
  const shadowTradeId = [
    'volume_breakout',
    lane,
    signal.symbol,
    signal.barTime,
    side,
  ].join(':')
  return appendPaperPolicyShadowOpen({
    counterfactualType: 'trade_level_shadow',
    eventType: 'open',
    shadowId: buildPaperPolicyShadowId({
      tradeId: shadowTradeId,
      shadowPolicyVersion: 'volume_breakout_shadow_v1',
      entryTs: signal.barTime,
      policyId: lane,
    }),
    lane,
    symbol: signal.symbol,
    side,
    entryPrice: signal.entryPrice,
    openTs: new Date(signal.barTime).toISOString(),
    openBarTime: signal.barTime,
    horizonMs,
    notionalUsd: null,
    stopLossPrice: signal.stopLossPrice > 0 ? signal.stopLossPrice : null,
    blockReasons: reason.split(';').map(part => part.trim()).filter(Boolean),
    context: {
      contextSnapshotId: openContext.contextSnapshotId,
      decisionTime: openContext.decisionTime,
      marketDataWatermarkAtDecisionTime: openContext.marketDataWatermarkAtDecisionTime,
      watermark: openContext.watermark,
      featuresAvailableAtDecisionTime: openContext.featuresAvailableAtDecisionTime,
      featureSchemaVersion: openContext.featureSchemaVersion,
      contextGenerationAtOpen: openContext.contextGenerationAtOpen,
      contextStatus: openContext.contextStatus,
      flashContextStatus: openContext.flashContextStatus,
      contextReason: openContext.contextReason,
      flashEpochAtOpen: openContext.flashEpochAtOpen,
      flashConfidenceLowAtOpen: openContext.flashConfidenceLowAtOpen,
      proEpochAtOpen: openContext.proEpochAtOpen,
      marketIntelTriggerAtOpen: openContext.marketIntelTriggerAtOpen,
    },
    quality,
    cost: {
      ...cost,
      ...edge,
    },
  })
}

function buildVBGate(profile: VBProfile, context: MarketIntelContext, fuse: SystemFuseState): VBGate {
  const lane = profileLane(profile)
  const reasons: string[] = []
  const validUntil = Date.parse(context.validUntil)
  let allowNew = true
  if (fuse.status === 'risk_off') {
    allowNew = false
    reasons.push(`system_fuse:${fuse.reason ?? 'risk_off'}`)
  }
  if (context.riskMode === 'risk_off') {
    allowNew = false
    reasons.push('risk_off')
  }
  if (context.newsRiskRegime === 'severe') {
    allowNew = false
    reasons.push('severe_news')
  }
  if (!context.semanticValidation.passed) {
    allowNew = false
    reasons.push('semantic_validation_block')
  }
  if (!Number.isFinite(validUntil) || validUntil <= Date.now()) {
    allowNew = false
    reasons.push('context_stale')
  }
  if (context.allowNewPositionsByLane[lane] !== true) {
    allowNew = false
    reasons.push(`lane_not_allowed:${lane}`)
  }
  return { allowNew, reasons, context, fuse }
}

function mapVBCloseReason(reason: string): PaperTradeCloseReason {
  if (reason.startsWith('MarketIntel banned symbol')) return 'banned_symbol'
  if (reason.startsWith('Hold expired')) return 'holding_expired'
  if (reason.startsWith('Stop loss')) return 'stop_loss'
  if (reason.startsWith('LIQUIDATED')) return 'virtual_liquidation_guard'
  return 'signal'
}

async function main() {
  const now = new Date()
  console.log(`=== Volume Breakout Paper Trader — ${now.toISOString().slice(0, 19)} ===\n`)

  if (shouldDryRun(process.argv.slice(2))) {
    console.log(JSON.stringify({
      family: 'volume_breakout',
      command: 'paper_trade_volume_breakout',
      executionMode: {
        dryRun: true,
        writesPaperAccounts: false,
        writesPaperTradeResults: false,
        writesShadowLedger: false,
        writesRuntimeReport: false,
        placesOrders: false,
      },
      optIn: {
        runPaperMutation: '--dryRun false',
        allowUngatedPaperLane: '--allowUngatedPaperLane true',
      },
    }, null, 2))
    return
  }

  if (!shouldAllowUngatedPaperLane(process.argv.slice(2))) {
    const blockReason = 'promotion_v2_required_for_paper_lane'
    console.log(`Blocked: ${blockReason}`)
    await saveRuntimeReport({
      generatedAt: now.toISOString(),
      status: 'blocked',
      blockReason,
      universeSize: 0,
      signalCount: 0,
      signals: [],
      profiles: [],
      notes: [
        'paper:volume-breakout is not promotion-v2 gated',
        'run with --allowUngatedPaperLane true only for research diagnostics',
      ],
    })
    return
  }

  const dataDir = join(import.meta.dirname ?? '.', '..', 'data', 'market', 'live_5m')
  const assets: Array<{ symbol: string; candles: Candle[] }> = []

  for (const symbol of SYMBOLS) {
    const fileName = paperSymbolToCsvFile(symbol, '5m')
    try {
      const candles = await loadCandles(join(dataDir, fileName))
      if (candles.length >= DEFAULT_VB_CONFIG.volumeLookbackBars + 2) {
        assets.push({ symbol, candles })
        console.log(`Loaded ${symbol}: ${candles.length} 5m bars`)
      }
    } catch { console.log(`Missing: ${fileName}`) }
  }

  if (assets.length === 0) { console.log('No data. Run accumulate_5m_data first.'); return }
  const context = readMarketIntelContext()
  const fuse = readSystemFuse()

  // Evaluate signals
  const allSignals = assets.map(a => evaluateVolumeBreakout(a.symbol, a.candles))
  const activeSignals = allSignals.filter(s => s.signal !== 0).sort((a, b) => b.confidence - a.confidence)
  const symbolBlockedSignals = activeSignals.filter(signal => isMarketIntelSymbolBanned(context, signal.symbol))
  const activeSignalsAfterSymbolPolicy = activeSignals.filter(signal => !isMarketIntelSymbolBanned(context, signal.symbol))
  const { executableSignals, rejectedSignals } = filterExecutableVolumeBreakoutSignals(activeSignalsAfterSymbolPolicy)
  rejectedSignals.push(...symbolBlockedSignals.map(signal => ({
    symbol: signal.symbol,
    reason: 'market_intel_symbol_blocked',
    confidence: signal.confidence,
    rangeBreakoutPct: signal.rangeBreakoutPct,
    volumeRatio: signal.volumeRatio,
    breakQuality: signal.breakQuality,
    liquidityUsd: signal.liquidityUsd,
    liquidityStatus: signal.liquidityStatus,
    spreadBps: signal.spreadBps,
    spreadStatus: signal.spreadStatus,
  })))

  console.log(`\nSignals (${activeSignals.length}):`)
  for (const s of activeSignals) {
    const emoji = s.signal === 1 ? '📈' : '📉'
    console.log(`  ${emoji} ${s.symbol}: vol=${s.volumeRatio.toFixed(1)}x break=${s.rangeBreakoutPct.toFixed(3)}% conf=${s.confidence.toFixed(3)} | ${s.reason}`)
  }
  if (activeSignals.length === 0) console.log('  No breakout signals')

  console.log(`\nExecutable signals (${executableSignals.length}/${activeSignals.length}) after paper risk gate:`)
  if (executableSignals.length === 0) console.log('  No executable breakout signals')
  for (const rejected of rejectedSignals) {
    console.log(`  BLOCK ${rejected.symbol}: ${rejected.reason}`)
  }

  const profileReports: VBProfileReport[] = []
  for (const profile of MINUTE_PROFILES) {
    const account = loadAccount(profile)
    const gate = buildVBGate(profile, context, fuse)
    console.log(`\n--- ${profile.label} (${profile.leverage}x, 5m) ---`)
    closeExpiredPositions(profile, account, assets, gate)
    for (const rejected of rejectedSignals) {
      const signal = activeSignals.find(candidate => candidate.symbol === rejected.symbol)
      if (signal) recordRejectedSignalShadowOpen(profile, signal, rejected.reason, context)
    }
    if (!gate.allowNew) {
      for (const signal of executableSignals) {
        recordRejectedSignalShadowOpen(
          profile,
          signal,
          gate.reasons.length > 0 ? gate.reasons.join('; ') : 'profile_gate_blocked',
          context,
        )
      }
    }
    openNewPositions(profile, account, executableSignals, gate)
    await saveAccount(profile, account)

    const totalReturn = ((account.equity / account.initialEquity - 1) * 100).toFixed(2)
    console.log(`Equity: $${account.equity.toFixed(2)} | Return: ${totalReturn}% | Positions: ${account.positions.length} | Trades: ${account.tradeHistory.length}`)
    profileReports.push({
      id: profile.id,
      label: profile.label,
      mode: 'paper_trade',
      cadence: 'minute',
      timeframe: '5m',
      strategyLane: 'volume_breakout',
      leverage: profile.leverage,
      equity: account.equity,
      initialEquity: account.initialEquity,
      openPositions: account.positions.length,
      totalTrades: account.tradeHistory.length,
      returnPct: Number(totalReturn),
      gate,
    })
  }

  await saveRuntimeReport({
    generatedAt: new Date().toISOString(),
    status: executableSignals.length > 0 ? 'signals' : activeSignals.length > 0 ? 'blocked_by_execution_gate' : 'no_signal',
    universeSize: assets.length,
    signalCount: activeSignals.length,
    executableSignalCount: executableSignals.length,
    signals: activeSignals.map(signal => ({
      symbol: signal.symbol,
      signal: signal.signal,
      confidence: signal.confidence,
      volumeRatio: signal.volumeRatio,
      rangeBreakoutPct: signal.rangeBreakoutPct,
      breakQuality: signal.breakQuality,
      liquidityUsd: signal.liquidityUsd,
      liquidityStatus: signal.liquidityStatus,
      spreadBps: signal.spreadBps,
      spreadStatus: signal.spreadStatus,
      entryPrice: signal.entryPrice,
      reason: signal.reason,
    })),
    rejectedSignals,
    executionGate: DEFAULT_VB_EXECUTION_GATE,
    marketIntelContext: {
      contextGeneration: context.contextGeneration,
      riskMode: context.riskMode,
      newsRiskRegime: context.newsRiskRegime,
      validUntil: context.validUntil,
      bannedSymbols: context.bannedSymbols,
    },
    systemFuse: fuse,
    profiles: profileReports,
    notes: [
      'paper-only 5m volume breakout lane',
      'spot_1x and conservative_3x are local virtual accounts',
      'no exchange leverage or live-money execution is changed',
    ],
  })
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const withoutPrefix = arg.slice(2)
    const eq = withoutPrefix.indexOf('=')
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out.set(withoutPrefix, next)
      i++
    } else {
      out.set(withoutPrefix, 'true')
    }
  }
  return out
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
