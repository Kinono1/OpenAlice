/**
 * Unified types for the PaperPositionExecutor.
 *
 * These are the minimal shared types between volume-breakout
 * and microstructure strategies. Cross-sectional has its own
 * richer types and interfaces with this layer via callbacks.
 */

// ==================== Strategy → Executor ====================

/**
 * Normalized signal emitted by a strategy's signal evaluation.
 * Strategy-specific metadata flows through strategyData (opaque).
 */
export interface UnifiedSignal {
  symbol: string
  direction: 'long' | 'short'
  entryPrice: number
  confidence: number
  barTime: number
  reason: string
  stopLossPrice: number | null
  takeProfitPrice: number | null
  /** Strategy-specific metadata, passed through to serializePositionFields(). */
  strategyData: Record<string, unknown>
}

// ==================== Profile ====================

/**
 * Minimal trade profile for a paper trading lane.
 * Each strategy defines its own profiles; these are the fields
 * the executor needs to manage position lifecycle.
 */
export interface TradeProfile {
  id: string
  label: string
  leverage: number
  maxPositionFraction: number
  maxPositions: number
  stopLossPct: number
  takeProfitPct: number | null
  /** Holding expiry in bars (e.g., 5m bars for VB). */
  maxHoldingBars?: number
  /** Holding expiry in seconds (e.g., for microstructure 1s). */
  maxHoldingSeconds?: number
  /** Holding expiry in hours (e.g., for cross-sectional). */
  maxHoldingHours?: number
}

// ==================== Position (managed by executor) ====================

/**
 * An open position managed by the PaperPositionExecutor.
 * The executor fills contextSnapshotId, cost fields, and strategyData;
 * the owning script reads this from the account for reporting.
 */
export interface ExecutorPosition {
  symbol: string
  direction: 'long' | 'short'
  entryPrice: number
  quantity: number
  entryTime: string
  entryBarTime: number
  stopLossPrice: number | null
  takeProfitPrice: number | null
  confidence: number
  profileId: string
  accountId: string
  leverage: number
  marginUsd: number
  notionalUsd: number

  // Context snapshot (filled by executor)
  contextSnapshotId: string | null
  decisionTime: string | null
  marketDataWatermarkAtDecisionTime: string | null
  watermark: string | null
  featuresAvailableAtDecisionTime: boolean | null
  featureSchemaVersion: string | null
  contextGenerationAtOpen: number | null
  contextStatus: string | null
  flashContextStatus: string | null
  contextReason: string | null
  flashEpochAtOpen: number | null
  flashConfidenceLowAtOpen: number | null
  proEpochAtOpen: number | null
  marketIntelTriggerAtOpen: string | null

  // Cost snapshot (filled by executor)
  estimatedRoundTripCostPctAtOpen: number | null
  estimatedRoundTripCostPctOfMarginAtOpen: number | null
  expectedGrossEdgePctAtOpen: number | null
  expectedNetEdgePctAtOpen: number | null
  expectedEdgeSourceAtOpen: string | null
  routeCostBpsAtOpen: number | null
  roundTripCostBpsAtOpen: number | null
  markPriceAtOpen: number | null
  markPriceTimestampAtOpen: string | null
  matchPriceAtOpen: number | null
  matchPriceSourceAtOpen: string | null
  markMatchPenaltyBpsAtOpen: number | null
  markMatchStatusAtOpen: string | null

  // Signal quality snapshot (opaque, family-specific)
  volumeRatioAtOpen: number | null
  rangeBreakoutPctAtOpen: number | null
  breakQualityAtOpen: number | null
  liquidityUsdAtOpen: number | null
  liquidityStatusAtOpen: string | null
  spreadBpsAtOpen: number | null
  spreadStatusAtOpen: string | null
  return30sPctAtOpen: number | null
  return60sPctAtOpen: number | null
  microstructureConfidenceAtOpen: number | null

  // Strategy-specific opaque metadata
  strategyData: Record<string, unknown>
}

// ==================== Executor Callbacks ====================

/**
 * A closed trade record produced by the executor.
 */
export interface ExecutorClosedTrade {
  id: string
  symbol: string
  direction: 'long' | 'short'
  entryPrice: number
  exitPrice: number
  entryTime: string
  exitTime: string
  quantity: number
  pnl: number
  pnlPct: number
  reason: string
  closeReason: string
}

/**
 * Callbacks the strategy provides to inject family-specific logic.
 */
export interface ExecutorCallbacks {
  /** Build and append a PaperTradeResult for a closed trade. */
  buildTradeResult(
    position: ExecutorPosition,
    trade: ExecutorClosedTrade,
    candles: ExecutorCandle[],
  ): void

  /** Record a shadow ledger entry for a rejected signal. */
  recordShadowOpen(
    signal: UnifiedSignal,
    reason: string,
    gate: GateSnapshot,
  ): void
}

// ==================== Gate ====================

export type ExecutionMode = 'blocked' | 'close_only' | 'allow_new' | 'hard_close'

export interface GateSnapshot {
  mode: ExecutionMode
  reasons: string[]
  closeReason?: string
}

// ==================== Market Data ====================

export interface ExecutorCandle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// ==================== Executor Options ====================

export interface ExecutorOptions {
  gate: GateSnapshot
  marketData: Map<string, ExecutorCandle[]>
  now: Date
  nowIso: string
  nowMs: number
}

// ==================== Executor Result ====================

export interface ExecutorCycleResult {
  closedTrades: ExecutorClosedTrade[]
  openedPositionCount: number
}

// ==================== Clock / ID Factory ====================

export interface ExecutorClock {
  now(): Date
  nowMs(): number
}

export interface ExecutorIdFactory {
  closeTradeId(profileId: string, symbol: string, nowMs: number): string
}
