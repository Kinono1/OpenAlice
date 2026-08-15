/**
 * Trading-as-Git type definitions
 *
 * Operation is a discriminated union — each variant carries typed IBKR objects.
 * No more Record<string, unknown> type erasure.
 */

import type { Contract, Order, OrderCancel, Execution, OrderState } from '@traderalice/ibkr'
import type Decimal from 'decimal.js'
import type { Position, OpenOrder, TpSlParams } from '../brokers/types.js'
import '../contract-ext.js'

// ==================== Governance Metadata ====================

/**
 * Lightweight governance decision snapshot attached to an Operation.
 * Carried through the Trading-as-Git lifecycle so guards can inspect it.
 */
export interface OperationGovernance {
  /**
   * Action status from the strategy governance layer.
   * An operation with no governance data is treated as ungoverned (allow fallback).
   */
  actionStatus?: string
  /** Decision strength tier (D1–D5), if available from the evaluation. */
  decisionStrength?: string
  /** Snapshot ID for traceability back to the strategy evaluation. */
  snapshotId?: string
  /** ISO 8601 timestamp of when governance was evaluated. */
  evaluatedAt?: string
}

// ==================== Commit Hash ====================

/** 8-character short SHA-256 hash. */
export type CommitHash = string

// ==================== Operation ====================

export type OperationAction = Operation['action']

export type Operation =
  | { action: 'placeOrder'; contract: Contract; order: Order; tpsl?: TpSlParams; ticketId?: string; governance?: OperationGovernance }
  | { action: 'modifyOrder'; orderId: string; changes: Partial<Order>; governance?: OperationGovernance }
  | { action: 'closePosition'; contract: Contract; quantity?: Decimal; ticketId?: string; governance?: OperationGovernance }
  | { action: 'cancelOrder'; orderId: string; orderCancel?: OrderCancel; governance?: OperationGovernance }
  | { action: 'syncOrders' }

// ==================== Operation Result ====================

export type OperationStatus = 'submitted' | 'filled' | 'rejected' | 'cancelled' | 'user-rejected'

export interface OperationResult {
  action: OperationAction
  success: boolean
  orderId?: string
  status: OperationStatus
  execution?: Execution
  orderState?: OrderState
  filledQty?: number
  filledPrice?: number
  error?: string
  raw?: unknown
}

// ==================== Wallet State ====================

/** State snapshot taken after each commit. */
export interface GitState {
  netLiquidation: number
  totalCashValue: number
  unrealizedPnL: number
  realizedPnL: number
  positions: Position[]
  pendingOrders: OpenOrder[]
}

// ==================== Commit ====================

export interface GitCommit {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  operations: Operation[]
  results: OperationResult[]
  stateAfter: GitState
  timestamp: string
  round?: number
}

// ==================== API Results ====================

export interface AddResult {
  staged: true
  index: number
  operation: Operation
}

export interface CommitPrepareResult {
  prepared: true
  hash: CommitHash
  message: string
  operationCount: number
}

export interface PushResult {
  hash: CommitHash
  message: string
  operationCount: number
  submitted: OperationResult[]
  rejected: OperationResult[]
}

export interface RejectResult {
  hash: CommitHash
  message: string
  operationCount: number
}

export interface GitStatus {
  staged: Operation[]
  pendingMessage: string | null
  pendingHash: CommitHash | null
  head: CommitHash | null
  commitCount: number
}

export interface OperationSummary {
  symbol: string
  action: OperationAction
  change: string
  status: OperationStatus
}

export interface CommitLogEntry {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  timestamp: string
  round?: number
  operations: OperationSummary[]
}

// ==================== Export State ====================

export interface GitExportState {
  commits: GitCommit[]
  head: CommitHash | null
}

// ==================== Sync ====================

export interface OrderStatusUpdate {
  orderId: string
  symbol: string
  previousStatus: OperationStatus
  currentStatus: OperationStatus
  filledPrice?: number
  filledQty?: number
}

export interface SyncResult {
  hash: CommitHash
  updatedCount: number
  updates: OrderStatusUpdate[]
}

// ==================== Simulate Price Change ====================

export interface PriceChangeInput {
  /** Contract aliceId or symbol, or "all". */
  symbol: string
  /** "@88000" (absolute) or "+10%" / "-5%" (relative). */
  change: string
}

export interface SimulationPositionCurrent {
  symbol: string
  side: 'long' | 'short'
  qty: number
  avgCost: number
  marketPrice: number
  unrealizedPnL: number
  marketValue: number
}

export interface SimulationPositionAfter {
  symbol: string
  side: 'long' | 'short'
  qty: number
  avgCost: number
  simulatedPrice: number
  unrealizedPnL: number
  marketValue: number
  pnlChange: number
  priceChangePercent: string
}

export interface SimulatePriceChangeResult {
  success: boolean
  error?: string
  currentState: {
    equity: number
    unrealizedPnL: number
    totalPnL: number
    positions: SimulationPositionCurrent[]
  }
  simulatedState: {
    equity: number
    unrealizedPnL: number
    totalPnL: number
    positions: SimulationPositionAfter[]
  }
  summary: {
    totalPnLChange: number
    equityChange: number
    equityChangePercent: string
    worstCase: string
  }
}

// ==================== Operation Helpers ====================

/** Extract the symbol from any Operation variant. */
export function getOperationSymbol(op: Operation): string {
  switch (op.action) {
    case 'placeOrder': return op.contract?.symbol || op.contract?.aliceId || 'unknown'
    case 'modifyOrder': return 'unknown' // modifyOrder doesn't carry contract
    case 'closePosition': return op.contract?.symbol || op.contract?.aliceId || 'unknown'
    case 'cancelOrder': return 'unknown'
    case 'syncOrders': return 'unknown'
  }
}
