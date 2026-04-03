import type { CryptoPlaceOrderRequest } from '../trading/operation-dispatcher.types.js'
import type { RuntimeFactorSnapshot } from './runtime-evaluator.js'
import {
  buildStrategyExecutionDecision,
} from './execution.js'
import type {
  StrategyDataProvenance,
  StrategyExecutionDecision,
  StrategyExecutionSummary,
  StrategyFreezeSummary,
} from './runtime-types.js'

export type {
  StrategyDataProvenance,
  StrategyExecutionDecision,
  StrategyExecutionSummary,
  StrategyFreezeSummary,
} from './runtime-types.js'

export type StrategyExecutionPreview = StrategyExecutionDecision

export interface StrategyPreparedOrder {
  request: CryptoPlaceOrderRequest
  strategy: StrategyExecutionPreview
}

export function prepareStrategyManagedOrder(input: {
  snapshot: RuntimeFactorSnapshot
  request: CryptoPlaceOrderRequest
  isNewOpen: boolean
  referencePrice?: number
}): StrategyPreparedOrder {
  const strategy = buildStrategyExecutionDecision({
    snapshot: input.snapshot,
    request: input.request,
    isNewOpen: input.isNewOpen,
    referencePrice: input.referencePrice,
  })

  if (strategy.mode !== 'applied') {
    return {
      request: { ...input.request },
      strategy,
    }
  }

  return {
    request: {
      ...input.request,
      size:
        typeof strategy.effectiveSize === 'number' && Number.isFinite(strategy.effectiveSize)
          ? strategy.effectiveSize
          : input.request.size,
      usd_size:
        typeof strategy.effectiveUsdSize === 'number' && Number.isFinite(strategy.effectiveUsdSize)
          ? strategy.effectiveUsdSize
          : input.request.usd_size,
    },
    strategy,
  }
}
