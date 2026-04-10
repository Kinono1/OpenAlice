import type { ActionStatus } from './governance/index.js'
import type { AssetLayer } from './position-sizing/index.js'

export type StrategyDataSourceKind =
  | 'input'
  | 'market-data'
  | 'account-broker'
  | 'public-ccxt'
  | 'derived'
  | 'unavailable'

export interface StrategyDataSourceStatus {
  source: StrategyDataSourceKind
  status: 'resolved' | 'fallback' | 'missing'
  detail?: string
  accountId?: string
  exchangeId?: string
}

export type StrategyDataPointProvenance = StrategyDataSourceStatus

export interface StrategyDataProvenance {
  candles: StrategyDataPointProvenance
  fundingRate: StrategyDataPointProvenance
  basis: StrategyDataPointProvenance
  openInterest: StrategyDataPointProvenance
  liquidation: StrategyDataPointProvenance
  equity: StrategyDataPointProvenance
  referencePrice: StrategyDataPointProvenance
  completeness: 'full' | 'partial' | 'minimal'
}

export interface StrategyFreezeSummary {
  active: boolean
  maxActionDuringFreeze?: 'reduce' | 'exit' | 'no-trade' | 'hold'
  activeEvents: string[]
}

export interface MetaLabelAdmissionSummary {
  enabled: boolean
  score: number
  threshold: number
  admitted: boolean
  reasons: string[]
}

export interface StrategyExecutionDecision {
  mode: 'applied' | 'pass-through' | 'blocked' | 'fallback'
  actionStatus: ActionStatus
  requestedNotionalUsd: number | null
  recommendedNotionalUsd: number | null
  effectiveNotionalUsd: number | null
  effectiveSize?: number | null
  effectiveUsdSize?: number | null
  assetLayer: AssetLayer
  fallbackReason?: string
  blockReason?: string
  reasons: string[]
  dataProvenance: StrategyDataProvenance
  freeze: StrategyFreezeSummary
  metaLabeling?: MetaLabelAdmissionSummary
}

export type StrategyExecutionSummary = StrategyExecutionDecision

export function createUnavailableStrategyDataProvenance(): StrategyDataProvenance {
  return {
    candles: { source: 'unavailable', status: 'missing' },
    fundingRate: { source: 'unavailable', status: 'missing' },
    basis: { source: 'unavailable', status: 'missing' },
    openInterest: { source: 'unavailable', status: 'missing' },
    liquidation: { source: 'unavailable', status: 'missing' },
    equity: { source: 'unavailable', status: 'missing' },
    referencePrice: { source: 'unavailable', status: 'missing' },
    completeness: 'minimal',
  }
}
