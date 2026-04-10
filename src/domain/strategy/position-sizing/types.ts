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
}
