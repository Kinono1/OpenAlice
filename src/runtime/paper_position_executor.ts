/**
 * PaperPositionExecutor — shared position management core for
 * volume-breakout and microstructure paper trading strategies.
 *
 * Lifecycle: closePositions() → openPositions()
 * Each strategy injects family-specific logic via ExecutorCallbacks.
 *
 * Design principles:
 * - Handles ALL generic close/open logic (stop loss, hold expiry, liquidation, etc.)
 * - Delegates family-specific artifact writes (trade result, shadow) to callbacks
 * - stress_only mode stays in wrapper scripts, NOT in this core
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { buildOpenCostSnapshot } from './paper_open_cost_builder.js'
import { roundSignalQualityNumber, estimatePaperRoundTripCostPct, PAPER_STALE_MARK_MATCH_PENALTY_BPS } from './paper_cost_helpers.js'
import { buildPaperOpenContextSnapshot } from './paper_open_context.js'
import type { MarketIntelContext } from './market_intel_context.js'
import type { MarketIntelLane } from './market_intel_constants.js'
import type { SystemFuseState } from './system_fuse.js'
import type {
  UnifiedSignal,
  TradeProfile,
  ExecutorPosition,
  ExecutorClosedTrade,
  ExecutorCallbacks,
  ExecutorOptions,
  ExecutorCycleResult,
  ExecutorCandle,
  ExecutionMode,
} from '../domain/strategy/paper_executor_types.js'

export { type ExecutorPosition, type ExecutorClosedTrade, type ExecutorCallbacks }

// ==================== Gate Helpers ====================

export interface FullGateVerdict {
  mode: ExecutionMode
  reasons: string[]
  closeReason?: string
  allowNew: boolean
}

export function buildGateVerdict(
  profile: { id: string; leverage: number },
  context: MarketIntelContext,
  fuse: SystemFuseState,
  dataFreshness: { stale: boolean; ageMs: number | null } | null,
  options: {
    lane: MarketIntelLane
    flashConfidenceThreshold?: number
  },
): FullGateVerdict {
  const reasons: string[] = []
  let mode: ExecutionMode = 'allow_new'
  let closeReason: string | undefined

  if (fuse.status === 'risk_off') {
    mode = 'hard_close'
    closeReason = 'fuse'
    reasons.push(`system_fuse:${fuse.reason ?? 'risk_off'}`)
  }
  if (context.newsRiskRegime === 'severe') {
    if (mode !== 'hard_close') mode = 'hard_close'
    closeReason = closeReason ?? 'severe_news'
    reasons.push('severe_news')
  }
  if (!context.semanticValidation.passed) {
    if (mode !== 'hard_close') mode = 'hard_close'
    closeReason = closeReason ?? 'stale_context'
    reasons.push('semantic_validation_block')
  }
  const validUntilMs = Date.parse(context.validUntil)
  const contextStale = !Number.isFinite(validUntilMs) || validUntilMs <= Date.now()
  if (contextStale) {
    if (mode !== 'hard_close') mode = 'close_only'
    closeReason = closeReason ?? 'stale_context'
    reasons.push('context_stale')
  }
  if (context.coldStartRoundsRemaining > 0) {
    reasons.push(`cold_start:${context.coldStartRoundsRemaining}`)
    if (mode === 'allow_new') mode = 'close_only'
  }
  if (dataFreshness?.stale) {
    reasons.push(`stale_data:${dataFreshness.ageMs ?? 'unknown'}ms`)
    if (mode === 'allow_new') mode = 'close_only'
  }
  if (context.riskMode === 'risk_off') {
    reasons.push('risk_off')
    if (mode === 'allow_new') mode = 'close_only'
  }
  if (context.allowNewPositionsByLane?.[options.lane] !== true) {
    reasons.push(`lane_not_allowed:${options.lane}`)
    if (mode === 'allow_new') mode = 'close_only'
  }
  if (typeof options.flashConfidenceThreshold === 'number') {
    const confidence = context.flashConfidenceByLane?.[options.lane]?.confidenceLow
    if (typeof confidence !== 'number' || confidence <= options.flashConfidenceThreshold) {
      reasons.push(`confidence_low:${confidence ?? 'missing'}<=${options.flashConfidenceThreshold}`)
      if (mode === 'allow_new') mode = 'close_only'
    }
  }

  return { mode, reasons, closeReason, allowNew: mode === 'allow_new' }
}

// ==================== Position Helpers ====================

function liquidationMovePctApprox(leverage: number): number {
  return leverage > 0 ? 100 / leverage : 100
}

function copyPositionContextSnapshot(pos: ExecutorPosition): Record<string, unknown> {
  return {
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
    proEpochAtOpen: pos.proEpochAtOpen ?? null,
    marketIntelTriggerAtOpen: pos.marketIntelTriggerAtOpen ?? null,
  }
}

function copyPositionCostSnapshot(pos: ExecutorPosition): Record<string, unknown> {
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

// ==================== Executor ====================

export class PaperPositionExecutor {
  dataDir: string
  outputDir: string
  callbacks: ExecutorCallbacks

  constructor(dataDir: string, outputDir: string, callbacks: ExecutorCallbacks) {
    this.dataDir = dataDir
    this.outputDir = outputDir
    this.callbacks = callbacks
  }

  /**
   * Run a full close + open cycle for one profile.
   */
  executeCycle(
    account: { equity: number; initialEquity: number; positions: ExecutorPosition[]; tradeHistory: unknown[] },
    profile: TradeProfile,
    signals: UnifiedSignal[],
    options: ExecutorOptions,
  ): ExecutorCycleResult {
    const closedTrades = this.closePositions(account, profile, options)
    if (options.gate.mode === 'hard_close') {
      // All positions already closed above; no new opens
      return { closedTrades, openedPositionCount: 0 }
    }
    const openedCount = this.openPositions(account, profile, signals, options)
    return { closedTrades, openedPositionCount: openedCount }
  }

  /**
   * Close positions that have expired, hit stop/tp, or are forced by the gate.
   */
  closePositions(
    account: { equity: number; positions: ExecutorPosition[] },
    profile: TradeProfile,
    options: ExecutorOptions,
  ): ExecutorClosedTrade[] {
    const closedTrades: ExecutorClosedTrade[] = []
    const { marketData, gate, nowIso, nowMs } = options

    for (const pos of [...account.positions]) {
      const candles = marketData.get(pos.symbol)
      const currentBar = candles?.[candles.length - 1]

      let shouldClose = false
      let closeReason = ''

      // 1. Hard close — override regardless of data
      if (gate.mode === 'hard_close') {
        shouldClose = true
        closeReason = gate.closeReason ?? 'hard_close'
      }

      // If not hard-close and no market data, skip
      if (!shouldClose && (!currentBar || !candles)) continue

      const closePrice = (gate.mode === 'hard_close' && (!currentBar || !currentBar.close || currentBar.close <= 0))
        ? pos.entryPrice
        : (currentBar?.close ?? pos.entryPrice)

      const pnlPct = pos.direction === 'long'
        ? (closePrice / pos.entryPrice - 1) * 100
        : (pos.entryPrice / closePrice - 1) * 100
      const pnl = (pnlPct / 100) * pos.notionalUsd

      // 2. Holding expiry
      if (!shouldClose) {
        const holdingSeconds = currentBar!.timestamp > pos.entryBarTime
          ? (currentBar!.timestamp - pos.entryBarTime) / 1000
          : 999999
        if (profile.maxHoldingBars != null) {
          const entryIdx = candles!.findIndex(c => c.timestamp === pos.entryBarTime)
          const barsHeld = entryIdx >= 0 ? candles!.length - 1 - entryIdx : 999
          if (barsHeld >= profile.maxHoldingBars) {
            shouldClose = true
            closeReason = 'holding_expired'
          }
        } else if (profile.maxHoldingSeconds != null && holdingSeconds >= profile.maxHoldingSeconds) {
          shouldClose = true
          closeReason = 'holding_expired'
        } else if (profile.maxHoldingHours != null) {
          const holdingHours = holdingSeconds / 3600
          if (holdingHours >= profile.maxHoldingHours) {
            shouldClose = true
            closeReason = 'holding_expired'
          }
        }
      }

      // 3. Stop loss
      if (!shouldClose && pos.stopLossPrice != null && pos.stopLossPrice > 0) {
        const hitStop = pos.direction === 'long'
          ? closePrice <= pos.stopLossPrice
          : closePrice >= pos.stopLossPrice
        if (hitStop) {
          shouldClose = true
          closeReason = 'stop_loss'
        }
      }

      // 4. Take profit
      if (!shouldClose && pos.takeProfitPrice != null && pos.takeProfitPrice > 0) {
        const hitTp = pos.direction === 'long'
          ? closePrice >= pos.takeProfitPrice
          : closePrice <= pos.takeProfitPrice
        if (hitTp) {
          shouldClose = true
          closeReason = 'take_profit'
        }
      }

      // 5. Liquidation guard
      if (!shouldClose) {
        const notional = pos.notionalUsd ?? pos.quantity * pos.entryPrice
        const margin = pos.marginUsd ?? notional / Math.max(pos.leverage ?? profile.leverage, 1)
        const marginAfterPnl = margin + pnl
        const marginRatio = margin > 0 ? marginAfterPnl / margin : 1
        if (marginRatio <= 0.2) {
          shouldClose = true
          closeReason = 'virtual_liquidation_guard'
        }
      }

      if (!shouldClose) continue

      // Execute close
      account.equity += pnl
      account.positions = account.positions.filter(p => p !== pos)

      const trade: ExecutorClosedTrade = {
        id: `close_${profile.id}_${pos.symbol}_${nowMs}`,
        symbol: pos.symbol,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        exitPrice: closePrice,
        entryTime: pos.entryTime,
        exitTime: nowIso,
        quantity: pos.quantity,
        pnl,
        pnlPct,
        reason: closeReason,
        closeReason,
      }
      closedTrades.push(trade)

      // Delegate family-specific trade result writing to callback
      this.callbacks.buildTradeResult(pos, trade, candles ?? [])
    }

    return closedTrades
  }

  /**
   * Open new positions from executable signals.
   */
  openPositions(
    account: { equity: number; initialEquity: number; positions: ExecutorPosition[] },
    profile: TradeProfile,
    signals: UnifiedSignal[],
    options: ExecutorOptions,
  ): number {
    if (options.gate.mode !== 'allow_new') return 0

    let openedCount = 0
    const { nowIso, nowMs } = options

    for (const signal of signals) {
      if (account.positions.length >= profile.maxPositions) break
      if (account.positions.some(p => p.symbol === signal.symbol)) continue

      const marginUsd = account.equity * profile.maxPositionFraction
      const notionalUsd = marginUsd * profile.leverage
      const quantity = notionalUsd / signal.entryPrice
      const stopLossPrice = signal.stopLossPrice ?? (
        signal.direction === 'long'
          ? signal.entryPrice * (1 - profile.stopLossPct)
          : signal.entryPrice * (1 + profile.stopLossPct)
      )
      const takeProfitPrice = signal.takeProfitPrice ?? (
        profile.takeProfitPct != null
          ? (signal.direction === 'long'
              ? signal.entryPrice * (1 + profile.takeProfitPct)
              : signal.entryPrice * (1 - profile.takeProfitPct))
          : 0
      )

      const costSnapshot = buildOpenCostSnapshot(profile.leverage, signal.entryPrice, signal.symbol, nowIso)

      const pos: ExecutorPosition = {
        symbol: signal.symbol,
        direction: signal.direction,
        entryPrice: signal.entryPrice,
        quantity,
        entryTime: nowIso,
        entryBarTime: signal.barTime,
        stopLossPrice,
        takeProfitPrice: takeProfitPrice || null,
        confidence: signal.confidence,
        profileId: profile.id,
        accountId: profile.id,
        leverage: profile.leverage,
        marginUsd,
        notionalUsd,

        contextSnapshotId: null,
        decisionTime: nowIso,
        marketDataWatermarkAtDecisionTime: nowIso,
        watermark: nowIso,
        featuresAvailableAtDecisionTime: null,
        featureSchemaVersion: null,
        contextGenerationAtOpen: null,
        contextStatus: null,
        flashContextStatus: null,
        contextReason: null,
        flashEpochAtOpen: null,
        flashConfidenceLowAtOpen: null,
        proEpochAtOpen: null,
        marketIntelTriggerAtOpen: null,

        ...costSnapshot,
        expectedGrossEdgePctAtOpen: null,
        expectedNetEdgePctAtOpen: null,
        expectedEdgeSourceAtOpen: null,

        volumeRatioAtOpen: null,
        rangeBreakoutPctAtOpen: null,
        breakQualityAtOpen: null,
        liquidityUsdAtOpen: null,
        liquidityStatusAtOpen: null,
        spreadBpsAtOpen: null,
        spreadStatusAtOpen: null,
        return30sPctAtOpen: null,
        return60sPctAtOpen: null,
        microstructureConfidenceAtOpen: null,

        strategyData: signal.strategyData,
      }

      account.positions.push(pos)
      openedCount++
    }

    return openedCount
  }
}
