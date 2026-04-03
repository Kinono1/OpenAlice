import { resolve } from 'node:path'
import Decimal from 'decimal.js'
import {
  Contract,
  Order,
  UNSET_DOUBLE,
  UNSET_DECIMAL,
} from '@traderalice/ibkr'
import type { EventLog } from '../../../../core/event-log.js'
import { createCryptoOperationDispatcher } from '../../operation-dispatcher.core.js'
import { evaluateFreezeWindows } from '../../../strategy/event-calendar/index.js'
import { evaluateRuntimeStrategySnapshotFromSources } from '../../../strategy/runtime-service.js'
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
import type { CryptoClientLike } from '../../../market-data/client/types.js'
import { DecisionTicketStore } from '../../decision-ticket.js'
import { TradeIdempotencyStore } from '../../idempotency-store.js'
import { IntentLedger } from '../../intent-ledger.js'
import { KillSwitch } from '../../kill-switch.js'
import type { Operation as GitOperation } from '../../git/types.js'
import type { Order as GitOrder } from '@traderalice/ibkr'
import type { PlaceOrderResult, Position, Quote } from '../types.js'
import { CcxtBroker } from './CcxtBroker.js'
import type { StrategyConfig } from '../../../../core/config.js'
import type { AccountManager } from '../../account-manager.js'

export type CryptoExecutionMode = 'paper_only'
export type KillSwitchDefaultPolicy = 'block_new_only' | 'block_all'

export interface CryptoExecutionConfig {
  mode: CryptoExecutionMode
  enableCryptoDispatcher: boolean
  requireDecisionTicket: boolean
  ticketTtlMs: number
  idempotencyTtlMs: number
  killSwitchDefaultPolicy: KillSwitchDefaultPolicy
}

export interface CcxtExecutionRuntime {
  enabled: boolean
  mode: CryptoExecutionMode
  requireDecisionTicket: boolean
  ticketTtlMs: number
  idempotencyTtlMs: number
  killSwitchDefaultPolicy: KillSwitchDefaultPolicy
  exchangeId: string
  bridgeActive: boolean
  intentLedgerPath: string
  idempotencyStorePath: string
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
}

export function resolveCryptoExecutionConfig(
  input?: Partial<CryptoExecutionConfig>,
): CryptoExecutionConfig {
  return {
    ...DEFAULT_CRYPTO_EXECUTION_CONFIG,
    ...input,
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
          size: op.quantity ? op.quantity.toNumber() : undefined,
        },
      }
    }

    case 'cancelOrder':
      return {
        action: 'cancelOrder',
        params: { orderId: op.orderId },
      }

    default:
      return null
  }
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

export class CcxtTradingEngineAdapter implements ICryptoTradingEngine {
  constructor(private readonly broker: CcxtBroker) {}

  async placeOrder(
    req: CryptoPlaceOrderRequest,
  ): Promise<CryptoOrderResult> {
    const contract = this.broker.resolveNativeKey(req.symbol)
    contract.localSymbol = contract.localSymbol || req.symbol
    contract.symbol = contract.symbol || req.symbol

    const result = await this.broker.placeOrder(
      contract,
      toGitOrder(contract, req),
      undefined,
      req.reduceOnly ? { reduceOnly: true } : undefined,
    )

    return {
      success: result.success,
      orderId: result.orderId,
      error: result.error,
      message: result.message,
      orderStatus: toCryptoOrderStatus(result),
      idempotencyKey: req.idempotencyKey,
      requestedSize: req.size,
      remainingSize: undefined,
      filledPrice: result.execution?.price,
      filledSize:
        typeof result.execution?.shares === 'number'
          ? result.execution.shares
          : undefined,
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
    const account = await this.broker.getAccount()
    return {
      balance: account.totalCashValue,
      totalMargin: account.initMarginReq ?? 0,
      unrealizedPnL: account.unrealizedPnL,
      equity: account.netLiquidation,
      realizedPnL: account.realizedPnL ?? 0,
      totalPnL: (account.realizedPnL ?? 0) + account.unrealizedPnL,
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const result = await this.broker.cancelOrder(orderId)
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
    requireDecisionTicket: config.requireDecisionTicket,
    ticketTtlMs: config.ticketTtlMs,
    idempotencyTtlMs: config.idempotencyTtlMs,
    killSwitchDefaultPolicy: config.killSwitchDefaultPolicy,
    exchangeId: input.broker.meta.exchange,
    bridgeActive: config.enableCryptoDispatcher,
    intentLedgerPath,
    idempotencyStorePath,
    strategyRuntimeIntegrationEnabled,
    strategyFreezeActive: evaluateStrategyFreeze()?.active ?? false,
    strategyMaxActionDuringFreeze: evaluateStrategyFreeze()?.maxActionDuringFreeze,
  }

  if (!config.enableCryptoDispatcher) {
    return {
      wrapExecuteOperation(fallback) {
        return fallback
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
  const ticketStore = new DecisionTicketStore({
    required: config.requireDecisionTicket,
    ttlMs: config.ticketTtlMs,
  })
  const killSwitch = new KillSwitch({
    defaultPolicy: config.killSwitchDefaultPolicy,
  })
  const engine = new CcxtTradingEngineAdapter(input.broker)
  const dispatcher = createCryptoOperationDispatcher(engine, {
    ticketStore,
    intentLedger,
    idempotencyStore,
    killSwitch,
    exchangeId: input.broker.meta.exchange,
    eventLog: input.eventLog,
    preparePlaceOrder: async ({ request, expectedPrice }) => {
      if (!strategyRuntimeIntegrationEnabled || request.reduceOnly) {
        return { approved: true }
      }
      const freeze = evaluateStrategyFreeze()

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
        return {
          approved: true,
          strategy: buildFallbackStrategySummary({
            request,
            strategyConfig: input.strategyConfig,
            freeze,
            expectedPrice,
            reason: 'missing_strategy_runtime_dependencies',
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
          return { approved: true }
        }
        if (strategy.mode === 'blocked') {
          return {
            approved: false,
            reason: `strategy action ${strategy.actionStatus} blocked new open`,
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
        return {
          approved: true,
          strategy: buildFallbackStrategySummary({
            request,
            strategyConfig: input.strategyConfig,
            freeze,
            expectedPrice,
            reason: `runtime-evaluation-failed:${message}`,
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
          return fallback(operation)
        }
        return dispatcher.dispatch(mapped)
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
    },
  }
}
