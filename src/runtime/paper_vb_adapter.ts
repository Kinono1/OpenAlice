/**
 * Volume Breakout adapter for PaperPositionExecutor.
 *
 * Maps VolumeBreakoutSignal to UnifiedSignal and provides
 * VB-specific callbacks for trade result and shadow ledger writing.
 */

import { evaluateVolumeBreakout, DEFAULT_VB_CONFIG } from '../domain/strategy/volume-breakout.js'
import {
  appendPaperTradeResult,
  buildPaperTradeCostEvidence,
  buildPaperTradeMfeMaeEvidence,
  buildPaperTradePredictedOpenEvidence,
  withPaperTradeContextCoverage,
  type PaperTradeCloseReason,
} from './paper_trade_result.js'
import {
  appendPaperPolicyShadowOpen,
  buildPaperPolicyShadowId,
} from './paper_policy_shadow_ledger.js'
import { buildPaperOpenContextSnapshot, paperOpenContextAcceptRejectReasons } from './paper_open_context.js'
import { buildOpenCostSnapshot } from './paper_open_cost_builder.js'
import { roundSignalQualityNumber } from './paper_cost_helpers.js'
import { buildGateVerdict, type FullGateVerdict } from './paper_position_executor.js'
import type {
  ExecutorPosition,
  ExecutorClosedTrade,
  ExecutorCandle,
  UnifiedSignal,
  TradeProfile,
  ExecutorCallbacks,
} from '../domain/strategy/paper_executor_types.js'
import type { MarketIntelContext } from './market_intel_context.js'
import type { SystemFuseState } from './system_fuse.js'

// ==================== Lane ====================

export type VBLane = 'volume_breakout_1x' | 'volume_breakout_3x'

export function vbProfileLane(profileId: string): VBLane {
  return profileId === 'spot_1x' ? 'volume_breakout_1x' : 'volume_breakout_3x'
}

// ==================== Profiles ====================

export const VB_PROFILES: TradeProfile[] = [
  {
    id: 'spot_1x',
    label: 'Spot 1x baseline',
    leverage: 1,
    maxPositionFraction: 0.1,
    maxPositions: 3,
    stopLossPct: DEFAULT_VB_CONFIG.stopLossPct,
    takeProfitPct: null,
    maxHoldingBars: DEFAULT_VB_CONFIG.holdBars,
  },
  {
    id: 'conservative_3x',
    label: 'Conservative 3x',
    leverage: 3,
    maxPositionFraction: 0.05,
    maxPositions: 3,
    stopLossPct: DEFAULT_VB_CONFIG.stopLossPct,
    takeProfitPct: null,
    maxHoldingBars: DEFAULT_VB_CONFIG.holdBars,
  },
]

// ==================== Gate ====================

export function buildVBGateVerdict(
  profile: { id: string; leverage: number },
  context: MarketIntelContext,
  fuse: SystemFuseState,
): FullGateVerdict {
  return buildGateVerdict(profile, context, fuse, null, {
    lane: vbProfileLane(profile.id),
  })
}

// ==================== Signal Mapping ====================

export function vbSignalToUnified(
  signal: ReturnType<typeof evaluateVolumeBreakout>,
): UnifiedSignal | null {
  if (signal.signal === 0 || signal.entryPrice <= 0) return null

  return {
    symbol: signal.symbol,
    direction: signal.signal === 1 ? 'long' : 'short',
    entryPrice: signal.entryPrice,
    confidence: signal.confidence,
    barTime: signal.barTime,
    reason: signal.reason,
    stopLossPrice: signal.stopLossPrice,
    takeProfitPrice: null,
    strategyData: {
      volumeRatio: signal.volumeRatio,
      rangeBreakoutPct: signal.rangeBreakoutPct,
      breakQuality: signal.breakQuality,
      liquidityUsd: signal.liquidityUsd,
      liquidityStatus: signal.liquidityStatus,
      spreadBps: signal.spreadBps,
      spreadStatus: signal.spreadStatus,
    },
  }
}

// ==================== Callbacks ====================

export function createVBCallbacks(): ExecutorCallbacks {
  return {
    buildTradeResult(
      position: ExecutorPosition,
      trade: ExecutorClosedTrade,
      candles: ExecutorCandle[],
    ): void {
      const lane = vbProfileLane(position.profileId)
      const costAtOpen = {
        estimatedRoundTripCostPctAtOpen: position.estimatedRoundTripCostPctAtOpen,
        estimatedRoundTripCostPctOfMarginAtOpen: position.estimatedRoundTripCostPctOfMarginAtOpen,
        expectedGrossEdgePctAtOpen: position.expectedGrossEdgePctAtOpen,
        expectedNetEdgePctAtOpen: position.expectedNetEdgePctAtOpen,
        expectedEdgeSourceAtOpen: position.expectedEdgeSourceAtOpen,
        routeCostBpsAtOpen: position.routeCostBpsAtOpen,
        roundTripCostBpsAtOpen: position.roundTripCostBpsAtOpen,
        markPriceAtOpen: position.markPriceAtOpen,
        markPriceTimestampAtOpen: position.markPriceTimestampAtOpen,
        matchPriceAtOpen: position.matchPriceAtOpen,
        matchPriceSourceAtOpen: position.matchPriceSourceAtOpen,
        markMatchPenaltyBpsAtOpen: position.markMatchPenaltyBpsAtOpen,
        markMatchStatusAtOpen: position.markMatchStatusAtOpen,
      }
      const signalQualityAtOpen = {
        volumeRatioAtOpen: position.volumeRatioAtOpen,
        rangeBreakoutPctAtOpen: position.rangeBreakoutPctAtOpen,
        breakQualityAtOpen: position.breakQualityAtOpen,
        liquidityUsdAtOpen: position.liquidityUsdAtOpen,
        liquidityStatusAtOpen: position.liquidityStatusAtOpen,
        spreadBpsAtOpen: position.spreadBpsAtOpen,
        spreadStatusAtOpen: position.spreadStatusAtOpen,
      }
      const predictedOpenEvidenceInput: Record<string, unknown> = {
        openTs: position.entryTime,
        ...costAtOpen,
      }
      const closeReason = mapVBCloseReason(trade.closeReason)
      appendPaperTradeResult(withPaperTradeContextCoverage({
        tradeId: trade.id,
        lane,
        symbol: trade.symbol,
        leverage: position.leverage,
        side: trade.direction,
        openTs: trade.entryTime,
        closeTs: trade.exitTime,
        openPrice: trade.entryPrice,
        closePrice: trade.exitPrice,
        pnlPct: trade.pnlPct,
        pnlUsd: trade.pnl,
        closeReason,
        priceSource: '5m',
        priceStale: false,
        contextSnapshotId: position.contextSnapshotId ?? null,
        decisionTime: position.decisionTime ?? null,
        marketDataWatermarkAtDecisionTime: position.marketDataWatermarkAtDecisionTime ?? null,
        watermark: position.watermark ?? position.marketDataWatermarkAtDecisionTime ?? null,
        featuresAvailableAtDecisionTime: position.featuresAvailableAtDecisionTime ?? null,
        featureSchemaVersion: position.featureSchemaVersion ?? null,
        contextGenerationAtOpen: position.contextGenerationAtOpen ?? null,
        contextStatus: position.contextStatus ?? null,
        flashContextStatus: position.flashContextStatus ?? position.contextStatus ?? null,
        contextReason: position.contextReason ?? null,
        flashEpochAtOpen: position.flashEpochAtOpen ?? null,
        flashConfidenceLowAtOpen: position.flashConfidenceLowAtOpen ?? null,
        ruleScoreAtOpen: position.flashConfidenceLowAtOpen ?? position.confidence ?? null,
        proEpochAtOpen: position.proEpochAtOpen ?? null,
        marketIntelTriggerAtOpen: position.marketIntelTriggerAtOpen ?? null,
        ...signalQualityAtOpen,
        ...costAtOpen,
        ...buildPaperTradePredictedOpenEvidence(predictedOpenEvidenceInput),
        ...buildPaperTradeCostEvidence(costAtOpen),
        ...buildPaperTradeMfeMaeEvidence({
          side: trade.direction,
          openTs: trade.entryTime,
          closeTs: trade.exitTime,
          openPrice: trade.entryPrice,
          closeReason,
          priceSource: '5m',
          candles,
        }),
      }))
    },

    recordShadowOpen(signal: UnifiedSignal, reason: string, gate: { mode: string; reasons: string[] }): void {
      if (signal.entryPrice <= 0) return
      const lane = vbProfileLane(signal.strategyData.profileId as string ?? 'spot_1x')
      const shadowTradeId = `volume_breakout:${lane}:${signal.symbol}:${signal.barTime}:${signal.direction}`
      appendPaperPolicyShadowOpen({
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
        side: signal.direction,
        entryPrice: signal.entryPrice,
        openTs: new Date(signal.barTime).toISOString(),
        openBarTime: signal.barTime,
        horizonMs: DEFAULT_VB_CONFIG.holdBars * 5 * 60 * 1000,
        notionalUsd: null,
        stopLossPrice: signal.stopLossPrice && signal.stopLossPrice > 0 ? signal.stopLossPrice : null,
        blockReasons: reason.split(';').map((part: string) => part.trim()).filter(Boolean),
        context: {
          contextSnapshotId: null,
          decisionTime: null,
          marketDataWatermarkAtDecisionTime: null,
          watermark: null,
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
        },
        quality: {
          volumeRatioAtOpen: (signal.strategyData.volumeRatio as number) ?? null,
          rangeBreakoutPctAtOpen: (signal.strategyData.rangeBreakoutPct as number) ?? null,
          breakQualityAtOpen: (signal.strategyData.breakQuality as number) ?? null,
          liquidityUsdAtOpen: (signal.strategyData.liquidityUsd as number) ?? null,
          liquidityStatusAtOpen: (signal.strategyData.liquidityStatus as string) ?? null,
          spreadBpsAtOpen: (signal.strategyData.spreadBps as number) ?? null,
          spreadStatusAtOpen: (signal.strategyData.spreadStatus as string) ?? null,
        },
        cost: {
          estimatedRoundTripCostPctAtOpen: null,
          estimatedRoundTripCostPctOfMarginAtOpen: null,
          expectedGrossEdgePctAtOpen: null,
          expectedNetEdgePctAtOpen: null,
          expectedEdgeSourceAtOpen: null,
          routeCostBpsAtOpen: null,
          roundTripCostBpsAtOpen: null,
          matchPriceAtOpen: null,
          matchPriceSourceAtOpen: null,
          markMatchPenaltyBpsAtOpen: null,
          markMatchStatusAtOpen: null,
        },
      })
    },
  }
}

// ==================== Helpers ====================

function mapVBCloseReason(reason: string): PaperTradeCloseReason {
  if (reason === 'stop_loss') return 'stop_loss'
  if (reason === 'holding_expired') return 'holding_expired'
  if (reason === 'virtual_liquidation_guard') return 'virtual_liquidation_guard'
  if (reason === 'take_profit') return 'take_profit'
  if (reason === 'hard_close' || reason === 'fuse' || reason === 'severe_news' || reason === 'stale_context') return 'stale_context'
  return 'signal'
}
