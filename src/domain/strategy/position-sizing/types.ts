import type { ActionStatus } from '../governance/types.js'

export type AssetLayer = 'core' | 'extended' | 'watch-only'
export type PositionSizingMethod = 'fixed' | 'kelly' | 'volTarget'

export interface LayerConfig {
  layer: AssetLayer
  maxPositions: number
  maxPositionPctOfEquity: number
  minActionStatusToTrade: ActionStatus
  requiresCoreNotRiskOff: boolean
}

export interface PositionSizingContext {
  actionStatus: ActionStatus
  assetLayer: AssetLayer
  currentOpenPositions: number
  currentLayerOpenPositions: number
  equity: number
  coreRiskOff?: boolean
}

export interface PositionSizingDecision {
  allowed: boolean
  maxPositionPctOfEquity: number
  recommendedPctOfEquity: number
  method: PositionSizingMethod
  reasons: string[]
  /** Portfolio-level risk overlay result, if applied. */
  portfolioRiskOverlay?: OverlayResult
}

// ── Portfolio Risk Overlay ─────────────────────────────────────────────

export interface PortfolioRiskOverlayConfig {
  enabled: boolean
  maxGrossExposurePctOfEquity: number
  maxNetExposurePctOfEquity: number
  maxSingleAssetPctOfEquity: number
}

export interface PortfolioPositionSummary {
  symbol: string
  side: 'long' | 'short'
  notional: number
}

export interface OverlayResult {
  cappedPct: number
  originalPct: number
  capped: boolean
  reasons: string[]
}
