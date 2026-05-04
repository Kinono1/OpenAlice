import type { Contract, Order, OrderCancel, Execution, OrderState } from '@traderalice/ibkr'
import type Decimal from 'decimal.js'
import type { StrategyExecutionSummary } from '../strategy/execution-decision.js'
import type { ProductionRiskPreflightPolicyLike } from './production-risk-preflight.js'

export type OperationAction =
  | 'placeOrder'
  | 'closePosition'
  | 'cancelOrder'
  | 'adjustLeverage'
  | 'syncOrders'

export interface Operation {
  action: OperationAction
  params: Record<string, unknown>
}

export type CommitHash = string

export interface CryptoPlaceOrderRequest {
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  lane?: string
  size?: number
  usd_size?: number
  price?: number
  leverage?: number
  reduceOnly?: boolean
  idempotencyKey?: string
}

export type CryptoOrderStatus =
  | 'pending'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'rejected'

export interface CryptoOrderResult {
  success: boolean
  orderId?: string
  error?: string
  message?: string
  orderStatus?: CryptoOrderStatus
  requestedSize?: number
  remainingSize?: number
  filledPrice?: number
  filledSize?: number
  averageFillPrice?: number
  firstFillAtMs?: number
  completedAtMs?: number
  exchangeUpdateTs?: number
  idempotencyKey?: string
  retryOfOrderId?: string
  strategy?: StrategyExecutionSummary
  executionTelemetry?: ExecutionTelemetry
}

export interface CryptoOrder {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  size: number
  price?: number
  leverage?: number
  reduceOnly?: boolean
  status: CryptoOrderStatus
  filledPrice?: number
  filledSize?: number
  requestedSize?: number
  remainingSize?: number
  averageFillPrice?: number
  firstFillAtMs?: number
  completedAtMs?: number
  exchangeUpdateTs?: number
  filledAt?: Date
  createdAt: Date
  rejectReason?: string
}

export interface CryptoPosition {
  symbol: string
  side: 'long' | 'short'
  size: number
  entryPrice: number
  leverage: number
  margin: number
  liquidationPrice: number
  markPrice: number
  unrealizedPnL: number
  positionValue: number
}

export interface CryptoAccountInfo {
  balance: number
  totalMargin: number
  unrealizedPnL: number
  equity: number
  realizedPnL: number
  totalPnL: number
  dailyPnL?: number
  dailyPnl?: number
  dailyRealizedPnl?: number
  dailyRealizedPnL?: number
  todayRealizedPnl?: number
  todayRealizedPnL?: number
  realizedPnlSource?: 'balance_payload' | 'closed_trades_ledger' | 'derived_fallback'
  realizedPnlConfidence?: number
}

export interface CryptoTicker {
  symbol: string
  last: number
  bid: number
  ask: number
  high: number
  low: number
  volume: number
  timestamp: Date
}

export interface CryptoFundingRate {
  symbol: string
  fundingRate: number
  nextFundingTime?: Date
  previousFundingRate?: number
  timestamp: Date
}

export type CryptoOrderBookLevel = [price: number, amount: number]

export interface CryptoOrderBook {
  symbol: string
  bids: CryptoOrderBookLevel[]
  asks: CryptoOrderBookLevel[]
  timestamp: Date
}

export interface SymbolPrecision {
  price: number
  size: number
}

export interface ICryptoTradingEngine {
  placeOrder(order: CryptoPlaceOrderRequest, currentTime?: Date): Promise<CryptoOrderResult>
  getPositions(): Promise<CryptoPosition[]>
  getOrders(): Promise<CryptoOrder[]>
  getAccount(): Promise<CryptoAccountInfo>
  cancelOrder(orderId: string): Promise<boolean>
  adjustLeverage(symbol: string, newLeverage: number): Promise<{ success: boolean; error?: string }>
  getTicker(symbol: string): Promise<CryptoTicker>
  getFundingRate(symbol: string): Promise<CryptoFundingRate>
  getOrderBook(symbol: string, limit?: number): Promise<CryptoOrderBook>
}

export interface CapitalScaleRule {
  stage: string
  maxOpenPositions?: number
  maxLeverage?: number
  maxOrderUsd?: number
  maxPositionPctOfEquity?: number
  highVolatilityMaxLeverage?: number
}

export interface RiskConfig {
  enabled: boolean
  killSwitch: boolean
  maxOpenPositions: number
  maxLeverage: number
  maxOrderUsd: number
  maxPositionPctOfEquity: number
  maxDailyLossUsd: number
  enforceRealizedPnlConfidence?: boolean
  minRealizedPnlConfidence?: number
  trustedRealizedPnlSources?: Array<'balance_payload' | 'closed_trades_ledger'>
  dailyLossPctSoftCap?: number
  cvarLossPctSoftCap?: number
  cvarLookbackDays?: number
  cvarTailAlpha?: number
  consecutiveLossDaysLimit?: number
  consecutiveLossPctThreshold?: number
  highVolatilityQuantileCut?: number
  capitalScaleRules?: CapitalScaleRule[]
}

export interface RiskCheckContext {
  dailyPnL?: number
  dailyPnl?: number
  dailyRealizedPnl?: number
  dailyRealizedPnL?: number
  todayRealizedPnl?: number
  todayRealizedPnL?: number
  dailyLossPct?: number
  cvarDailyLossPct?: number
  consecutiveLossDays?: number
  consecutiveLossPct?: number
  volatilityQuantile?: number
  capitalRampStage?: string
  positions?: CryptoPosition[]
  account?: CryptoAccountInfo
}

export interface RiskCheckResult {
  approved: boolean
  reason?: string
  details?: Record<string, unknown>
}

export interface PlaceOrderHookInput {
  operation: Operation
  request: CryptoPlaceOrderRequest
  expectedPrice?: number
  riskContext?: RiskCheckContext
  strategy?: StrategyExecutionSummary
}

export interface PlaceOrderPreparationResult {
  approved: boolean
  request?: CryptoPlaceOrderRequest
  reason?: string
  details?: Record<string, unknown>
  strategy?: StrategyExecutionSummary
}

export interface PlaceOrderResultHookInput extends PlaceOrderHookInput {
  result: CryptoOrderResult
}

export interface ExecutionTelemetry {
  signalTimestampMs?: number
  dispatcherStartedAtMs: number
  riskCheckedAtMs?: number
  brokerSubmittedAtMs?: number
  expectedPrice?: number
  slippagePct?: number
  slippageBps?: number
  slippageLimitPct?: number
  signalToDispatchMs?: number | null
  signalToFirstFillMs?: number | null
  signalToCompletedMs?: number | null
  dispatchToFirstFillMs?: number | null
  dispatchToCompletedMs?: number | null
  partialFillRatio?: number | null
  riskDecision: 'approved' | 'rejected'
  riskReason?: string | null
  forcedRetryIdempotency?: boolean
  timeoutMs?: number
  timeoutPhase?: 'risk_check' | 'broker_submit' | 'simple_action' | 'close_position_resolution'
}

export interface OperationOutcome {
  opIndex: number
  ticketId: string
  intentId: string
  status: 'success' | 'failed' | 'skipped'
  result?: CryptoOrderResult
  error?: string
}

export interface PushResult {
  commitId: string
  operations: OperationOutcome[]
  summary: { succeeded: number; failed: number; skipped: number }
}

export interface CryptoOperationDispatcher {
  (op: Operation): Promise<unknown>
  dispatch: (op: Operation) => Promise<unknown>
  push: (commitId: string, operations: Operation[]) => Promise<PushResult>
}

export interface SimpleActionResult {
  success: boolean
  error?: string
  [key: string]: unknown
}

export type OperationEntry = OperationOutcome

export interface SlippageConfig {
  maxSlippagePct: number
  reduceOnlyMultiplier: number
}

export interface CryptoOperationDispatcherOptions {
  riskConfig?: RiskConfig
  operationTimeoutMs?: number
  getRiskContext?: () => Promise<RiskCheckContext | undefined>
  estimateExpectedPrice?: (
    input: Omit<PlaceOrderHookInput, 'riskContext'>
  ) => Promise<number | undefined>
  preparePlaceOrder?: (
    input: Omit<PlaceOrderHookInput, 'riskContext'>
  ) => Promise<PlaceOrderPreparationResult | undefined>
  beforePlaceOrderGate?: (
    input: Omit<PlaceOrderHookInput, 'riskContext'>
  ) => Promise<RiskCheckResult | undefined>
  afterPlaceOrder?: (input: PlaceOrderResultHookInput) => Promise<void>
  onRiskRejected?: (input: {
    operation: Operation
    request: CryptoPlaceOrderRequest
    reason: string
    details?: Record<string, unknown>
  }) => Promise<void>
  ticketStore?: import('./decision-ticket.js').DecisionTicketStore
  intentLedger?: import('./intent-ledger.js').IntentLedger
  idempotencyStore?: import('./idempotency-store.js').TradeIdempotencyStore
  killSwitch?: import('./kill-switch.js').KillSwitch
  exchangeId?: string
  slippageConfig?: SlippageConfig
  eventLog?: { append: (type: string, payload: unknown) => Promise<unknown> }
  productionRiskPreflightPolicy?: ProductionRiskPreflightPolicyLike | null
}

export interface CommitOperation {
  action: string
  params: Record<string, unknown>
  ticketId: string
}

export interface CommitExecutorDeps {
  engine: ICryptoTradingEngine
  ticketStore?: import('./decision-ticket.js').DecisionTicketStore
  intentLedger?: import('./intent-ledger.js').IntentLedger
  idempotencyStore?: import('./idempotency-store.js').TradeIdempotencyStore
  killSwitch?: import('./kill-switch.js').KillSwitch
  exchangeId?: string
  slippageConfig?: SlippageConfig
  riskConfig?: RiskConfig
  operationTimeoutMs?: number
  getRiskContext?: () => Promise<RiskCheckContext | undefined>
  estimateExpectedPrice?: (
    req: CryptoPlaceOrderRequest
  ) => Promise<number | undefined>
  preparePlaceOrder?: (
    input: Omit<PlaceOrderHookInput, 'riskContext'>
  ) => Promise<PlaceOrderPreparationResult | undefined>
  onEvent?: (type: string, payload: unknown) => Promise<void>
  productionRiskPreflightPolicy?: ProductionRiskPreflightPolicyLike | null
}
