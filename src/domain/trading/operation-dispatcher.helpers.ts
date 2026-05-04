import type {
  CryptoPlaceOrderRequest,
  CryptoOrderResult,
  Operation,
  RiskConfig,
  CryptoOperationDispatcherOptions,
  PlaceOrderResultHookInput,
  SlippageConfig,
} from './operation-dispatcher.types.js'
import type { TradeIdempotencyRecord } from './idempotency-store.js'

export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000

export const DEFAULT_SLIPPAGE: SlippageConfig = {
  maxSlippagePct: 0.005,
  reduceOnlyMultiplier: 2,
}

export function checkSlippage(
  expectedPrice: number | undefined,
  filledPrice: number | undefined,
  side: 'buy' | 'sell',
  reduceOnly: boolean,
  config: SlippageConfig,
): { ok: boolean; slippagePct?: number; limit?: number } {
  if (!expectedPrice || !filledPrice || expectedPrice <= 0) {
    return { ok: true }
  }
  const slippagePct =
    side === 'buy'
      ? (filledPrice - expectedPrice) / expectedPrice
      : (expectedPrice - filledPrice) / expectedPrice
  const limit = reduceOnly
    ? config.maxSlippagePct * config.reduceOnlyMultiplier
    : config.maxSlippagePct
  return { ok: slippagePct <= limit, slippagePct, limit }
}

export function toWalletOrderStatus(
  result: CryptoOrderResult,
): 'filled' | 'partially_filled' | 'pending' | 'cancelled' | 'rejected' {
  if (
    result.orderStatus === 'filled' ||
    result.orderStatus === 'partially_filled' ||
    result.orderStatus === 'pending' ||
    result.orderStatus === 'cancelled' ||
    result.orderStatus === 'rejected'
  ) {
    return result.orderStatus
  }
  if (typeof result.filledSize === 'number' && result.filledSize > 0) {
    if (
      typeof result.remainingSize === 'number' &&
      result.remainingSize > 0
    ) {
      return 'partially_filled'
    }
    return 'filled'
  }
  return 'pending'
}

export function resolveIdempotencyKey(
  op: Operation,
  req: CryptoPlaceOrderRequest,
  ticketId: string,
): string | undefined {
  const explicit = op.params.idempotencyKey
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim()
  }
  if (typeof req.idempotencyKey === 'string' && req.idempotencyKey.trim()) {
    return req.idempotencyKey.trim()
  }
  if (ticketId.trim()) {
    return `ticket:${ticketId.trim()}`
  }
  return undefined
}

export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function normalizeDispatcherOptions(
  optionsOrRiskConfig: CryptoOperationDispatcherOptions | RiskConfig | undefined,
): CryptoOperationDispatcherOptions {
  if (!optionsOrRiskConfig) {
    return {}
  }
  if (isRiskConfig(optionsOrRiskConfig)) {
    return { riskConfig: optionsOrRiskConfig }
  }
  return optionsOrRiskConfig
}

export async function estimateExpectedPrice(
  req: CryptoPlaceOrderRequest,
  op: Operation,
  options: CryptoOperationDispatcherOptions,
): Promise<number | undefined> {
  if (typeof req.price === 'number' && req.price > 0) {
    return req.price
  }
  const estimated = await options.estimateExpectedPrice?.({
    operation: op,
    request: req,
  })
  return typeof estimated === 'number' &&
    Number.isFinite(estimated) &&
    estimated > 0
    ? estimated
    : undefined
}

export async function safeRunAfterHook(
  options: CryptoOperationDispatcherOptions,
  input: PlaceOrderResultHookInput,
): Promise<void> {
  if (!options.afterPlaceOrder) {
    return
  }
  try {
    await options.afterPlaceOrder(input)
  } catch {
    // Do not fail the order flow if telemetry hook fails.
  }
}

export function sanitizeIdempotencyRecord(
  record: TradeIdempotencyRecord,
): Record<string, unknown> {
  return {
    key: record.key,
    status: record.status,
    symbol: record.symbol,
    ticketId: record.ticketId,
    orderId: record.orderId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function isRiskConfig(value: unknown): value is RiskConfig {
  if (!value || typeof value !== 'object') {
    return false
  }
  const v = value as Partial<RiskConfig>
  return (
    typeof v.enabled === 'boolean' &&
    typeof v.killSwitch === 'boolean' &&
    typeof v.maxOpenPositions === 'number' &&
    typeof v.maxLeverage === 'number'
  )
}
