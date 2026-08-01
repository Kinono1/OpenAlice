import { resolve } from 'node:path'
import Decimal from 'decimal.js'
import {
  Contract,
  Order,
  UNSET_DOUBLE,
  UNSET_DECIMAL,
} from '@traderalice/ibkr'
import type { EventLog } from '../../../../core/event-log.js'
import { SqliteDurableStateStore } from '../../../../core/durable-state-store.js'
import { createCryptoOperationDispatcher } from '../../operation-dispatcher.core.js'
import { evaluateFreezeWindows } from '../../../strategy/event-calendar/index.js'
import { evaluateRuntimeStrategySnapshotFromSources } from '../../../strategy/runtime-service.js'
import { snapshotToStrategyDecision } from '../../../strategy/execution-decision.js'
import type { StrategyDecision } from '../../../strategy/decision-types.js'
import {
  createUnavailableStrategyDataProvenance,
  type StrategyExecutionSummary,
} from '../../../strategy/runtime-types.js'
import type {
  CryptoAccountInfo,
  CryptoFundingRate,
  CryptoOperationDispatcher,
  CryptoOrder,
  CryptoOrderBook,
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
  CryptoPosition,
  CryptoTicker,
  ICryptoTradingEngine,
  Operation as CryptoOperation,
} from '../../operation-dispatcher.types.js'
import type { ProductionRiskPreflightPolicyLike } from '../../production-risk-preflight.js'
import type { CryptoClientLike } from '../../../market-data/client/types.js'
import { DecisionTicketStore } from '../../decision-ticket.js'
import { getExchangeCapability } from '../../exchange-capabilities.js'
import { TradeIdempotencyStore } from '../../idempotency-store.js'
import { IntentLedger } from '../../intent-ledger.js'
import type { TradeIntent } from '../../intent-ledger.js'
import { KillSwitch } from '../../kill-switch.js'
import type { Operation as GitOperation } from '../../git/types.js'
import type { Order as GitOrder } from '@traderalice/ibkr'
import type { PlaceOrderResult, Position, Quote } from '../types.js'
import { CcxtBroker } from './CcxtBroker.js'
import type { StrategyConfig } from '../../../../core/config.js'
import type { AccountManager } from '../../account-manager.js'
import {
  DEFAULT_SLIPPAGE,
  checkSlippage,
} from '../../operation-dispatcher.helpers.js'
import {
  isReleaseGateStatusBlocking,
  loadReleaseGateStatus,
} from '../../../../runtime/release_gate_status.js'
import {
  extractRealizedPnlDetailsFromBalancePayload,
  extractRealizedPnlDetailsFromClosedTradesLedger,
} from './ccxt-pnl.js'
import {
  evaluateProductionRiskPreflight,
  productionRiskPreflightOrderResult,
} from '../../production-risk-preflight.js'
import {
  createEnvironmentExecutionAuthorityProvider,
  type CryptoExecutionMode,
} from '../../execution-permit.js'

export type { CryptoExecutionMode } from '../../execution-permit.js'
export type KillSwitchDefaultPolicy = 'block_new_only' | 'block_all'
const SLIPPAGE_BREACH_ACTIVATION_THRESHOLD = 2

type CcxtExchangeLike = {
  fetchBalance?: () => Promise<unknown>
  fetchMyTrades?: (
    symbol?: string,
    since?: number,
    limit?: number,
  ) => Promise<unknown>
  has?: Record<string, unknown>
}

export interface SlippageProtectionObservation {
  breached: boolean
  activated: boolean
  breachCount: number
  limit?: number
  reason?: string
}

export interface CryptoExecutionConfig {
  mode: CryptoExecutionMode
  enableCryptoDispatcher: boolean
  requireDecisionTicket: boolean
  ticketTtlMs: number
  idempotencyTtlMs: number
  killSwitchDefaultPolicy: KillSwitchDefaultPolicy
  killSwitchStatePath: string
  operationTimeoutMs: number
  admissionDecisionPath: string
  productionRiskPreflightPolicy?: ProductionRiskPreflightPolicyLike | null
}

export interface CcxtExecutionRuntime {
  enabled: boolean
  mode: CryptoExecutionMode
  requireDecisionTicket: boolean
  configuredRequireDecisionTicket: boolean
  authorityEnforced: boolean
  admissionDecisionPath: string
  ticketTtlMs: number
  idempotencyTtlMs: number
  killSwitchDefaultPolicy: KillSwitchDefaultPolicy
  exchangeId: string
  operationTimeoutMs: number
  bridgeActive: boolean
  intentLedgerPath: string
  idempotencyStorePath: string
  killSwitchStatePath: string
  strategyRuntimeIntegrationEnabled: boolean
  strategyFreezeActive: boolean
  strategyMaxActionDuringFreeze?: 'reduce' | 'exit' | 'no-trade' | 'hold'
}

export const DEFAULT_CRYPTO_EXECUTION_CONFIG: CryptoExecutionConfig = {
  mode: 'paper_only',
  enableCryptoDispatcher: true,
  requireDecisionTicket: false,
  ticketTtlMs: 600_000,
  idempotencyTtlMs: 1_800_000,
  killSwitchDefaultPolicy: 'block_new_only',
  killSwitchStatePath: 'data/runtime/kill-switch.sqlite',
  operationTimeoutMs: 30_000,
  admissionDecisionPath: 'data/runtime/admission_decision.v1.json',
}

export function resolveCryptoExecutionConfig(
  input?: Partial<CryptoExecutionConfig>,
): CryptoExecutionConfig {
  return {
    ...DEFAULT_CRYPTO_EXECUTION_CONFIG,
    ...input,
  }
}

function withDefaultCcxtPreflightContext(
  op: CryptoOperation,
  policy: ProductionRiskPreflightPolicyLike | null | undefined,
): CryptoOperation {
  if (op.action !== 'placeOrder' || policy == null) {
    return op
  }
  return {
    ...op,
    params: {
      lane: 'ccxt_execution_bridge',
      leverage: 1,
      ...op.params,
    },
  }
}

function toCryptoOrderStatus(result: PlaceOrderResult): CryptoOrderResult['orderStatus'] {
  switch (result.orderState?.status) {
    case 'Filled':
      return 'filled'
    case 'Cancelled':
      return 'cancelled'
    case 'Inactive':
      return 'rejected'
    default:
      return 'pending'
  }
}

function toCryptoSymbol(contract: Contract): string | undefined {
  return contract.localSymbol || contract.symbol || contract.aliceId || undefined
}

function isSupportedCcxtOrderType(order: GitOrder): boolean {
  return order.orderType === 'MKT' || order.orderType === 'LMT'
}

function toDispatcherOrderType(order: GitOrder): 'market' | 'limit' {
  return order.orderType === 'LMT' ? 'limit' : 'market'
}

function toDispatcherSide(order: GitOrder): 'buy' | 'sell' {
  return order.action === 'SELL' ? 'sell' : 'buy'
}

function toGitOrder(contract: Contract, req: CryptoPlaceOrderRequest): Order {
  const order = new Order()
  order.action = req.side === 'sell' ? 'SELL' : 'BUY'
  order.orderType = req.type === 'limit' ? 'LMT' : 'MKT'

  if (typeof req.size === 'number' && req.size > 0) {
    order.totalQuantity = new Decimal(String(req.size))
  }
  if (typeof req.usd_size === 'number' && req.usd_size > 0) {
    order.cashQty = req.usd_size
  }
  if (req.type === 'limit' && typeof req.price === 'number' && req.price > 0) {
    order.lmtPrice = req.price
  }

  return order
}

function toCryptoPosition(position: Position): CryptoPosition {
  return {
    symbol: toCryptoSymbol(position.contract) ?? 'unknown',
    side: position.side,
    size: position.quantity.toNumber(),
    entryPrice: position.avgCost,
    leverage: 1,
    margin: 0,
    liquidationPrice: 0,
    markPrice: position.marketPrice,
    unrealizedPnL: position.unrealizedPnL,
    positionValue: position.marketValue,
  }
}

function toCryptoTicker(symbol: string, quote: Quote): CryptoTicker {
  return {
    symbol,
    last: quote.last,
    bid: quote.bid,
    ask: quote.ask,
    high: quote.high ?? quote.last,
    low: quote.low ?? quote.last,
    volume: quote.volume,
    timestamp: quote.timestamp,
  }
}

function mapGitOperationToCrypto(op: GitOperation): CryptoOperation | null {
  switch (op.action) {
    case 'placeOrder': {
      if (!isSupportedCcxtOrderType(op.order)) {
        return null
      }
      const symbol = toCryptoSymbol(op.contract)
      if (!symbol) {
        return null
      }

      const size =
        op.order.totalQuantity && !op.order.totalQuantity.equals(UNSET_DECIMAL)
          ? op.order.totalQuantity.toNumber()
          : undefined
      const usd_size =
        op.order.cashQty !== UNSET_DOUBLE && op.order.cashQty > 0
          ? op.order.cashQty
          : undefined
      const price =
        op.order.lmtPrice !== UNSET_DOUBLE ? op.order.lmtPrice : undefined

      return {
        action: 'placeOrder',
        params: {
          symbol,
          ticketId: op.ticketId,
          side: toDispatcherSide(op.order),
          type: toDispatcherOrderType(op.order),
          size,
          usd_size,
          price,
          reduceOnly: false,
        },
      }
    }

    case 'closePosition': {
      const symbol = toCryptoSymbol(op.contract)
      if (!symbol) {
        return null
      }
      return {
        action: 'closePosition',
        params: {
          symbol,
          ticketId: op.ticketId,
          size: op.quantity ? op.quantity.toNumber() : undefined,
        },
      }
    }

    case 'cancelOrder':
      return {
        action: 'cancelOrder',
        params: {
          orderId: op.orderId,
          ticketId: op.governance?.snapshotId,
          idempotencyKey: op.governance?.snapshotId
            ? `cancel:${op.orderId}:${op.governance.snapshotId}`
            : undefined,
        },
      }

    default:
      return null
  }
}

function canBypassDisabledDispatcher(op: GitOperation): boolean {
  return op.action === 'syncOrders'
}

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test'
}

function estimateRequestedNotionalUsd(
  request: CryptoPlaceOrderRequest,
  expectedPrice?: number,
): number | null {
  if (typeof request.usd_size === 'number' && Number.isFinite(request.usd_size) && request.usd_size > 0) {
    return request.usd_size
  }
  const price = request.price ?? expectedPrice
  if (
    typeof request.size === 'number' &&
    Number.isFinite(request.size) &&
    request.size > 0 &&
    typeof price === 'number' &&
    Number.isFinite(price) &&
    price > 0
  ) {
    return request.size * price
  }
  return null
}

async function resolveCcxtRealizedPnlProvenance(
  broker: CcxtBroker,
): Promise<Pick<CryptoAccountInfo, 'realizedPnlSource' | 'realizedPnlConfidence'>> {
  const exchange = (broker as unknown as { exchange?: CcxtExchangeLike }).exchange
  if (!exchange?.fetchBalance) {
    return {
      realizedPnlSource: 'derived_fallback',
      realizedPnlConfidence: 0.25,
    }
  }

  try {
    const balance = await exchange.fetchBalance()
    const balanceDetails = extractRealizedPnlDetailsFromBalancePayload(balance)
    if (balanceDetails.found) {
      return {
        realizedPnlSource: 'balance_payload',
        realizedPnlConfidence: 0.95,
      }
    }
  } catch {
    // Keep trying the ledger fallback below.
  }

  if (exchange.has?.fetchMyTrades && exchange.fetchMyTrades) {
    try {
      const utcStart = new Date()
      utcStart.setUTCHours(0, 0, 0, 0)
      let sinceMs = utcStart.getTime()
      const pageLimit = 500
      const maxPages = 3
      const aggregatedTrades: unknown[] = []

      for (let page = 0; page < maxPages; page += 1) {
        const trades = await exchange.fetchMyTrades(undefined, sinceMs, pageLimit)
        if (!Array.isArray(trades) || trades.length === 0) {
          break
        }
        aggregatedTrades.push(...trades)
        if (trades.length < pageLimit) {
          break
        }

        let maxTradeTs = Number.NEGATIVE_INFINITY
        for (const trade of trades) {
          if (!trade || typeof trade !== 'object') {
            continue
          }
          const ts = (trade as Record<string, unknown>).timestamp
          const parsedTs =
            typeof ts === 'number' && Number.isFinite(ts)
              ? ts
              : typeof ts === 'string' && Number.isFinite(Number(ts.trim()))
                ? Number(ts.trim())
                : undefined
          if (typeof parsedTs === 'number' && parsedTs > maxTradeTs) {
            maxTradeTs = parsedTs
          }
        }

        if (!Number.isFinite(maxTradeTs)) {
          break
        }
        const nextSince = maxTradeTs + 1
        if (!Number.isFinite(nextSince) || nextSince <= sinceMs) {
          break
        }
        sinceMs = nextSince
      }

      const ledgerDetails = extractRealizedPnlDetailsFromClosedTradesLedger(aggregatedTrades)
      if (ledgerDetails.found) {
        return {
          realizedPnlSource: 'closed_trades_ledger',
          realizedPnlConfidence: 0.75,
        }
      }
    } catch {
      // Fall through to the conservative fallback below.
    }
  }

  return {
    realizedPnlSource: 'derived_fallback',
    realizedPnlConfidence: 0.25,
  }
}

export function createCcxtSlippageProtectionTracker(
  killSwitch: KillSwitch,
  breachThreshold: number = SLIPPAGE_BREACH_ACTIVATION_THRESHOLD,
): {
  observe: (input: {
    symbol: string
    side: 'buy' | 'sell'
    reduceOnly?: boolean
    expectedPrice?: number
    filledPrice?: number
  }) => SlippageProtectionObservation
} {
  const consecutiveBreachCounts = new Map<string, number>()

  return {
    observe(input) {
      if (input.reduceOnly) {
        consecutiveBreachCounts.delete(input.symbol)
        return {
          breached: false,
          activated: false,
          breachCount: 0,
        }
      }

      if (
        typeof input.filledPrice !== 'number' ||
        !Number.isFinite(input.filledPrice) ||
        input.filledPrice <= 0
      ) {
        const breachCount = (consecutiveBreachCounts.get(input.symbol) ?? 0) + 1
        consecutiveBreachCounts.set(input.symbol, breachCount)
        const activated = breachCount >= breachThreshold
        if (activated) {
          killSwitch.activate(
            input.symbol,
            `MISSING_FILL_PRICE: ${breachCount} consecutive fills lacked an auditable fill price`,
            'block_new_only',
          )
        }
        return {
          breached: true,
          activated,
          breachCount,
          reason: 'MISSING_FILL_PRICE: filled order did not include an auditable fill price',
        }
      }

      const slipCheck = checkSlippage(
        input.expectedPrice,
        input.filledPrice,
        input.side,
        false,
        DEFAULT_SLIPPAGE,
      )

      if (slipCheck.ok) {
        consecutiveBreachCounts.delete(input.symbol)
        return {
          breached: false,
          activated: false,
          breachCount: 0,
          limit: slipCheck.limit,
        }
      }

      const breachCount = (consecutiveBreachCounts.get(input.symbol) ?? 0) + 1
      consecutiveBreachCounts.set(input.symbol, breachCount)
      const activated = breachCount >= breachThreshold
      if (activated) {
        killSwitch.activate(
          input.symbol,
          `Repeated excessive slippage (${breachCount} consecutive fills above ${(typeof slipCheck.limit === 'number' ? slipCheck.limit : DEFAULT_SLIPPAGE.maxSlippagePct) * 100}%)`,
          'block_new_only',
        )
      }
      return {
        breached: true,
        activated,
        breachCount,
        limit: slipCheck.limit,
        reason: slipCheck.limit != null
          ? `slippage ${(slipCheck.slippagePct ?? 0) * 100}% exceeded ${(slipCheck.limit * 100).toFixed(2)}%`
          : 'slippage threshold exceeded',
      }
    },
  }
}

function buildFallbackStrategySummary(input: {
  request: CryptoPlaceOrderRequest
  strategyConfig?: StrategyConfig
  freeze: ReturnType<typeof evaluateFreezeWindows> | null
  expectedPrice?: number
  reason: string
}): StrategyExecutionSummary {
  const requestedNotionalUsd = estimateRequestedNotionalUsd(
    input.request,
    input.expectedPrice,
  )
  return {
    mode: 'fallback',
    actionStatus: 'hold',
    requestedNotionalUsd,
    recommendedNotionalUsd: null,
    effectiveNotionalUsd: requestedNotionalUsd,
    effectiveSize: input.request.size ?? null,
    effectiveUsdSize: input.request.usd_size ?? null,
    assetLayer: input.strategyConfig?.positionSizing.defaultAssetLayer ?? 'core',
    fallbackReason: input.reason,
    reasons: [input.reason],
    dataProvenance: createUnavailableStrategyDataProvenance(),
    freeze: {
      active: input.freeze?.active ?? false,
      maxActionDuringFreeze: input.freeze?.maxActionDuringFreeze,
      activeEvents: input.freeze?.activeWindows.map((window) => window.event.name) ?? [],
    },
  }
}

function buildFreezeBlockedStrategySummary(input: {
  request: CryptoPlaceOrderRequest
  strategyConfig?: StrategyConfig
  freeze: {
    active: boolean
    maxActionDuringFreeze?: 'reduce' | 'exit' | 'no-trade' | 'hold'
    activeWindows: Array<{ event: { name: string } }>
  }
  expectedPrice?: number
  reason: string
}): StrategyExecutionSummary {
  const requestedNotionalUsd = estimateRequestedNotionalUsd(
    input.request,
    input.expectedPrice,
  )
  return {
    mode: 'blocked',
    actionStatus: 'reduce',
    requestedNotionalUsd,
    recommendedNotionalUsd: 0,
    effectiveNotionalUsd: 0,
    effectiveSize: null,
    effectiveUsdSize: null,
    assetLayer: input.strategyConfig?.positionSizing.defaultAssetLayer ?? 'core',
    blockReason: input.reason,
    reasons: [input.reason],
    dataProvenance: createUnavailableStrategyDataProvenance(),
    freeze: {
      active: input.freeze.active,
      maxActionDuringFreeze: input.freeze.maxActionDuringFreeze,
      activeEvents: input.freeze.activeWindows.map((window) => window.event.name),
    },
  }
}

function buildRuntimeBlockedStrategySummary(input: {
  request: CryptoPlaceOrderRequest
  strategyConfig?: StrategyConfig
  freeze: ReturnType<typeof evaluateFreezeWindows> | null
  expectedPrice?: number
  reason: string
}): StrategyExecutionSummary {
  const requestedNotionalUsd = estimateRequestedNotionalUsd(
    input.request,
    input.expectedPrice,
  )
  return {
    mode: 'blocked',
    actionStatus: 'no-trade',
    requestedNotionalUsd,
    recommendedNotionalUsd: 0,
    effectiveNotionalUsd: 0,
    effectiveSize: null,
    effectiveUsdSize: null,
    assetLayer: input.strategyConfig?.positionSizing.defaultAssetLayer ?? 'core',
    blockReason: input.reason,
    reasons: [input.reason],
    dataProvenance: createUnavailableStrategyDataProvenance(),
    freeze: {
      active: input.freeze?.active ?? false,
      maxActionDuringFreeze: input.freeze?.maxActionDuringFreeze,
      activeEvents: input.freeze?.activeWindows.map((window) => window.event.name) ?? [],
    },
  }
}

async function reconcilePendingTradingState(input: {
  broker: CcxtBroker
  intentLedger: IntentLedger
  idempotencyStore: TradeIdempotencyStore
  eventLog?: EventLog
}): Promise<void> {
  const entries = await input.intentLedger.readAll()
  const intents = new Map<string, TradeIntent>()
  const resolvedIntentIds = new Set<string>()
  for (const entry of entries) {
    if (entry.type === 'intent') {
      const intent = entry.data as TradeIntent
      intents.set(intent.intentId, intent)
    } else if (entry.type === 'result') {
      resolvedIntentIds.add(entry.data.intentId)
    }
  }

  for (const intent of intents.values()) {
    if (resolvedIntentIds.has(intent.intentId)) {
      continue
    }
    let foundOrderId: string | null = null
    if (intent.clientOrderId && intent.symbol) {
      foundOrderId = await input.broker.findOrderIdByClientOrderId(intent.symbol, intent.clientOrderId)
    }
    await input.intentLedger.recordResult({
      intentId: intent.intentId,
      status: foundOrderId ? 'success' : 'failed',
      orderId: foundOrderId ?? undefined,
      error: foundOrderId ? undefined : 'startup_reconcile_unresolved',
      completedAt: Date.now(),
      strategy: intent.strategy,
    })
  }

  const records = await input.idempotencyStore.listRecords()
  for (const record of records) {
    if (record.status !== 'in_progress') {
      continue
    }
    let foundOrderId: string | null = null
    if (record.ticketId && record.symbol) {
      foundOrderId = await input.broker.findOrderIdByClientOrderId(record.symbol, `ticket:${record.ticketId}`)
    }
    await input.idempotencyStore.finalize({
      key: record.key,
      status: foundOrderId ? 'succeeded' : 'failed',
      orderId: foundOrderId ?? undefined,
      error: foundOrderId ? undefined : 'startup_reconcile_unresolved',
    })
  }
}

export class CcxtTradingEngineAdapter implements ICryptoTradingEngine {
  private readonly writeScope: ReturnType<CcxtBroker['createControlledWriteScope']>

  constructor(
    private readonly broker: CcxtBroker,
    private readonly productionRiskPreflightPolicy?: ProductionRiskPreflightPolicyLike | null,
  ) {
    this.writeScope = broker.createControlledWriteScope('ccxt_trading_engine_adapter')
  }

  async placeOrder(
    req: CryptoPlaceOrderRequest,
  ): Promise<CryptoOrderResult> {
    const preflight = evaluateProductionRiskPreflight(
      {
        lane: typeof req.lane === 'string' ? req.lane : null,
        symbol: typeof req.symbol === 'string' ? req.symbol : null,
        side: typeof req.side === 'string' ? req.side : null,
        leverage: typeof req.leverage === 'number' && Number.isFinite(req.leverage)
          ? req.leverage
          : null,
        requestedAction: req.reduceOnly ? 'position_mutation' : 'paper_order',
        decisionTime: new Date().toISOString(),
        sourcePath: 'CcxtTradingEngineAdapter.placeOrder',
        riskReducing: req.reduceOnly === true,
      },
      this.productionRiskPreflightPolicy,
    )
    if (!preflight.allowed) {
      return productionRiskPreflightOrderResult(preflight)
    }

    const contract = this.broker.resolveNativeKey(req.symbol)
    contract.localSymbol = contract.localSymbol || req.symbol
    contract.symbol = contract.symbol || req.symbol

    const extraParams: Record<string, unknown> = {}
    if (req.reduceOnly) {
      extraParams.reduceOnly = true
    }
    if (req.idempotencyKey) {
      const cap = getExchangeCapability(this.broker.meta.exchange)
      if (cap.clientOrderIdField) {
        extraParams[cap.clientOrderIdField] = req.idempotencyKey
      }
    }

    const result = await this.broker.withControlledWriteScope(
      this.writeScope,
      () => this.broker.placeOrder(
        contract,
        toGitOrder(contract, req),
        undefined,
        Object.keys(extraParams).length > 0 ? extraParams : undefined,
      ),
    )

    const orderStatus = toCryptoOrderStatus(result)
    const filledPrice = result.execution?.price
    const filledSize = result.execution?.shares?.toNumber()
    const filledOrderMissingPrice =
      result.success &&
      orderStatus === 'filled' &&
      (typeof filledPrice !== 'number' || !Number.isFinite(filledPrice) || filledPrice <= 0)

    if (filledOrderMissingPrice) {
      return {
        success: false,
        orderId: result.orderId,
        error: 'MISSING_FILL_PRICE: filled CCXT order did not include an auditable fill price',
        message: result.message,
        orderStatus,
        idempotencyKey: req.idempotencyKey,
        requestedSize: req.size,
        remainingSize: undefined,
      }
    }

    return {
      success: result.success,
      orderId: result.orderId,
      error: result.error,
      message: result.message,
      orderStatus,
      idempotencyKey: req.idempotencyKey,
      requestedSize: req.size,
      remainingSize: undefined,
      filledPrice,
      filledSize,
    }
  }

  async getPositions(): Promise<CryptoPosition[]> {
    const positions = await this.broker.getPositions()
    return positions.map(toCryptoPosition)
  }

  async getOrders(): Promise<CryptoOrder[]> {
    return []
  }

  async getAccount(): Promise<CryptoAccountInfo> {
    const [account, realizedPnlProvenance] = await Promise.all([
      this.broker.getAccount(),
      resolveCcxtRealizedPnlProvenance(this.broker),
    ])
    const accountWithProvenance = account as typeof account & {
      realizedPnlSource?: CryptoAccountInfo['realizedPnlSource']
      realizedPnlConfidence?: CryptoAccountInfo['realizedPnlConfidence']
    }
    return {
      balance: account.totalCashValue,
      totalMargin: account.initMarginReq ?? 0,
      unrealizedPnL: account.unrealizedPnL,
      equity: account.netLiquidation,
      realizedPnL: account.realizedPnL ?? 0,
      totalPnL: (account.realizedPnL ?? 0) + account.unrealizedPnL,
      realizedPnlSource:
        accountWithProvenance.realizedPnlSource ??
        realizedPnlProvenance.realizedPnlSource,
      realizedPnlConfidence:
        typeof accountWithProvenance.realizedPnlConfidence === 'number'
          ? accountWithProvenance.realizedPnlConfidence
          : realizedPnlProvenance.realizedPnlConfidence,
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const result = await this.broker.withControlledWriteScope(
      this.writeScope,
      () => this.broker.cancelOrder(orderId),
    )
    return result.success
  }

  async adjustLeverage(): Promise<{ success: boolean; error?: string }> {
    return {
      success: false,
      error: 'adjustLeverage is not supported through the CCXT crypto execution bridge yet',
    }
  }

  async getTicker(symbol: string): Promise<CryptoTicker> {
    const contract = this.broker.resolveNativeKey(symbol)
    const quote = await this.broker.getQuote(contract)
    return toCryptoTicker(symbol, quote)
  }

  async getFundingRate(symbol: string): Promise<CryptoFundingRate> {
    const contract = this.broker.resolveNativeKey(symbol)
    const funding = await this.broker.getFundingRate(contract)
    return {
      symbol,
      fundingRate: funding.fundingRate,
      nextFundingTime: funding.nextFundingTime,
      previousFundingRate: funding.previousFundingRate,
      timestamp: funding.timestamp,
    }
  }

  async getOrderBook(symbol: string, limit?: number): Promise<CryptoOrderBook> {
    const contract = this.broker.resolveNativeKey(symbol)
    const book = await this.broker.getOrderBook(contract, limit)
    return {
      symbol,
      bids: book.bids,
      asks: book.asks,
      timestamp: book.timestamp,
    }
  }
}

export interface CcxtExecutionBridge {
  dispatcher?: CryptoOperationDispatcher
  wrapExecuteOperation: (
    fallback: (operation: GitOperation) => Promise<unknown>,
  ) => (operation: GitOperation) => Promise<unknown>
  runtime: () => CcxtExecutionRuntime
  close: () => Promise<void>
}

export async function createCcxtExecutionBridge(input: {
  accountId: string
  broker: CcxtBroker
  accountManager?: AccountManager
  cryptoClient?: CryptoClientLike
  eventLog?: EventLog
  cryptoExecution?: Partial<CryptoExecutionConfig>
  strategyConfig?: StrategyConfig
}): Promise<CcxtExecutionBridge> {
  const config = resolveCryptoExecutionConfig(input.cryptoExecution)
  const executionPermitTestBypass = isTestRuntime()
  const effectiveRequireDecisionTicket = executionPermitTestBypass
    ? config.requireDecisionTicket
    : true
  const baseDir = resolve('data/trading', input.accountId)
  const intentLedgerPath = resolve(baseDir, 'intent-ledger.jsonl')
  const idempotencyStorePath = resolve(baseDir, 'idempotency-store.json')
  const evaluateStrategyFreeze = () => {
    if (!input.strategyConfig?.enabled) {
      return null
    }
    return evaluateFreezeWindows(
      Date.now(),
      input.strategyConfig.runtime.marketScope,
      input.strategyConfig.eventCalendar.events,
    )
  }

  const strategyRuntimeIntegrationEnabled =
    !!input.strategyConfig?.enabled &&
    !!input.strategyConfig?.runtime.runtimeIntegrationEnabled

  const runtimeBase: CcxtExecutionRuntime = {
    enabled: config.enableCryptoDispatcher,
    mode: config.mode,
    requireDecisionTicket: effectiveRequireDecisionTicket,
    configuredRequireDecisionTicket: config.requireDecisionTicket,
    authorityEnforced: !executionPermitTestBypass,
    admissionDecisionPath: config.admissionDecisionPath,
    ticketTtlMs: config.ticketTtlMs,
    idempotencyTtlMs: config.idempotencyTtlMs,
    killSwitchDefaultPolicy: config.killSwitchDefaultPolicy,
    exchangeId: input.broker.meta.exchange,
    operationTimeoutMs: config.operationTimeoutMs,
    bridgeActive: config.enableCryptoDispatcher,
    intentLedgerPath,
    idempotencyStorePath,
    killSwitchStatePath: resolve(config.killSwitchStatePath),
    strategyRuntimeIntegrationEnabled,
    strategyFreezeActive: evaluateStrategyFreeze()?.active ?? false,
    strategyMaxActionDuringFreeze: evaluateStrategyFreeze()?.maxActionDuringFreeze,
  }

  if (!config.enableCryptoDispatcher) {
    return {
      wrapExecuteOperation(fallback) {
        if (isTestRuntime()) {
          return fallback
        }
        return async (operation: GitOperation) => {
          if (canBypassDisabledDispatcher(operation)) {
            return fallback(operation)
          }
          return {
            success: false,
            error: `SECURITY: crypto dispatcher is disabled; ${operation.action} is forbidden outside test runtime`,
          }
        }
      },
      runtime() {
        return runtimeBase
      },
      async close() {},
    }
  }

  const intentLedger = new IntentLedger(intentLedgerPath)
  await intentLedger.init()
  const idempotencyStore = new TradeIdempotencyStore(
    idempotencyStorePath,
    config.idempotencyTtlMs,
  )
  await reconcilePendingTradingState({
    broker: input.broker,
    intentLedger,
    idempotencyStore,
    eventLog: input.eventLog,
  })
  const ticketStore = new DecisionTicketStore({
    required: effectiveRequireDecisionTicket,
    ttlMs: config.ticketTtlMs,
  })
  const killSwitchStore = new SqliteDurableStateStore(resolve(config.killSwitchStatePath))
  const killSwitch = new KillSwitch({
    defaultPolicy: config.killSwitchDefaultPolicy,
    stateStore: killSwitchStore,
  })
  const slippageProtection = createCcxtSlippageProtectionTracker(killSwitch)
  const engine = new CcxtTradingEngineAdapter(input.broker, config.productionRiskPreflightPolicy)
  const dispatcher = createCryptoOperationDispatcher(engine, {
    ticketStore,
    intentLedger,
    idempotencyStore,
    killSwitch,
    exchangeId: input.broker.meta.exchange,
    operationTimeoutMs: config.operationTimeoutMs,
    eventLog: input.eventLog,
    productionRiskPreflightPolicy: config.productionRiskPreflightPolicy,
    executionAuthorityProvider: executionPermitTestBypass
      ? undefined
      : createEnvironmentExecutionAuthorityProvider({
          admissionDecisionPath: config.admissionDecisionPath,
        }),
    accountId: input.accountId,
    accountMode: config.mode,
    allowTestExecutionPermitBypass: executionPermitTestBypass,
    afterPlaceOrder: async ({ request, expectedPrice, result }) => {
      const observation = slippageProtection.observe({
        symbol: request.symbol,
        side: request.side,
        reduceOnly: request.reduceOnly,
        expectedPrice,
        filledPrice: result.filledPrice,
      })
      if (observation.activated) {
        if (input.eventLog) {
          await input.eventLog.append('slippage.protective_state_activated', {
            symbol: request.symbol,
            breachCount: observation.breachCount,
            limit: observation.limit,
            policy: 'block_new_only',
            reason: observation.reason,
          }).catch(() => {})
        }
      }
    },
    preparePlaceOrder: async ({ request, expectedPrice }) => {
      const freeze = evaluateStrategyFreeze()
      if (request.reduceOnly) {
        return { approved: true }
      }

      if (config.mode === 'paper_only' && !input.broker.isPaperEnvironment()) {
        const reason = 'paper_only requires sandbox/demo broker target'
        return {
          approved: false,
          reason,
          strategy: buildRuntimeBlockedStrategySummary({
            request,
            strategyConfig: input.strategyConfig,
            freeze,
            expectedPrice,
            reason,
          }),
        }
      }

      const releaseGateBlocking = isReleaseGateStatusBlocking(
        await loadReleaseGateStatus(),
        'paper',
      )
      if (releaseGateBlocking.blocking) {
        const reason = releaseGateBlocking.reason ?? 'paper_release_gate_failed'
        return {
          approved: false,
          reason,
          strategy: buildRuntimeBlockedStrategySummary({
            request,
            strategyConfig: input.strategyConfig,
            freeze,
            expectedPrice,
            reason,
          }),
        }
      }

      if (!strategyRuntimeIntegrationEnabled) {
        const reason = 'strategy_runtime_integration_disabled'
        return {
          approved: false,
          reason,
          strategy: buildRuntimeBlockedStrategySummary({
            request,
            strategyConfig: input.strategyConfig,
            freeze,
            expectedPrice,
            reason,
          }),
        }
      }

      if (!input.accountManager || !input.cryptoClient) {
        if (freeze?.active) {
          const reason = `strategy event freeze active (${freeze.activeWindows.map((window) => window.event.name).join(', ')})`
          return {
            approved: false,
            reason,
            details: {
              marketScope: freeze.marketScope,
              maxActionDuringFreeze: freeze.maxActionDuringFreeze,
              activeEvents: freeze.activeWindows.map((window) => window.event.name),
            },
            strategy: buildFreezeBlockedStrategySummary({
              request,
              strategyConfig: input.strategyConfig,
              freeze,
              expectedPrice,
              reason,
            }),
          }
        }
        const reason = 'missing_strategy_runtime_dependencies'
        return {
          approved: false,
          reason,
          strategy: buildRuntimeBlockedStrategySummary({
            request,
            strategyConfig: input.strategyConfig,
            freeze,
            expectedPrice,
            reason,
          }),
        }
      }

      try {
        const snapshot = await evaluateRuntimeStrategySnapshotFromSources({
          accountManager: input.accountManager,
          cryptoClient: input.cryptoClient,
          request: {
            symbol: request.symbol,
            source: input.accountId,
            exchangeId: input.broker.meta.exchange,
            assetLayer:
              input.strategyConfig?.positionSizing.defaultAssetLayer
              ?? 'core',
            side: request.side,
            requestedSize: request.size,
            requestedUsdSize: request.usd_size,
            price: request.price ?? expectedPrice,
            reduceOnly: request.reduceOnly,
          },
        })
        const strategy = snapshot.executionPreview
        if (!strategy) {
          const reason = 'strategy_execution_preview_missing'
          return {
            approved: false,
            reason,
            strategy: buildRuntimeBlockedStrategySummary({
              request,
              strategyConfig: input.strategyConfig,
              freeze,
              expectedPrice,
              reason,
            }),
          }
        }
        if (strategy.mode === 'blocked' || strategy.mode === 'fallback') {
          return {
            approved: false,
            reason: strategy.mode === 'fallback'
              ? `strategy sizing unavailable for ${strategy.actionStatus} new open`
              : `strategy action ${strategy.actionStatus} blocked new open`,
            details: {
              actionStatus: strategy.actionStatus,
              mode: strategy.mode,
              freeze: strategy.freeze,
            },
            strategy,
          }
        }
        return {
          approved: true,
          request: {
            ...request,
            ...(typeof strategy.effectiveSize === 'number'
              ? { size: strategy.effectiveSize, usd_size: undefined }
              : {}),
            ...(typeof strategy.effectiveUsdSize === 'number'
              ? { usd_size: strategy.effectiveUsdSize, size: undefined }
              : {}),
          },
          strategy,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (freeze?.active) {
          const reason = `strategy event freeze active (${freeze.activeWindows.map((window) => window.event.name).join(', ')})`
          return {
            approved: false,
            reason,
            details: {
              marketScope: freeze.marketScope,
              maxActionDuringFreeze: freeze.maxActionDuringFreeze,
              activeEvents: freeze.activeWindows.map((window) => window.event.name),
              runtimeError: message,
            },
            strategy: buildFreezeBlockedStrategySummary({
              request,
              strategyConfig: input.strategyConfig,
              freeze,
              expectedPrice,
              reason,
            }),
          }
        }
        const reason = `runtime-evaluation-failed:${message}`
        return {
          approved: false,
          reason,
          strategy: buildRuntimeBlockedStrategySummary({
            request,
            strategyConfig: input.strategyConfig,
            freeze,
            expectedPrice,
            reason,
          }),
        }
      }
    },
  })

  return {
    dispatcher,
    wrapExecuteOperation(fallback) {
      return async (operation: GitOperation) => {
        const mapped = mapGitOperationToCrypto(operation)
        if (!mapped) {
          if (!canBypassDisabledDispatcher(operation)) {
            return {
              success: false,
              error: `SECURITY: unsupported CCXT write operation ${operation.action} cannot bypass crypto dispatcher`,
            }
          }
          return fallback(operation)
        }
        return dispatcher.dispatch(
          withDefaultCcxtPreflightContext(mapped, config.productionRiskPreflightPolicy),
        )
      }
    },
    runtime() {
      const freeze = evaluateStrategyFreeze()
      return {
        ...runtimeBase,
        strategyFreezeActive: freeze?.active ?? false,
        strategyMaxActionDuringFreeze: freeze?.maxActionDuringFreeze,
      }
    },
    async close() {
      ticketStore.destroy()
      await intentLedger.close()
      killSwitchStore.close()
    },
  }
}
