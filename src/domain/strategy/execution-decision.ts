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
import type { StrategyDecision } from './decision-types.js'

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

/**
 * Converts a RuntimeFactorSnapshot into a StrategyDecision — the ONLY interface
 * the execution layer may consume. This封装ates all factor/regime/HMM complexity.
 */
export function snapshotToStrategyDecision(
  snapshot: RuntimeFactorSnapshot,
  source: StrategyDecision['source'] = 'runtime-evaluator',
  reason?: string,
): StrategyDecision {
  const dominantFactors = snapshot.factorSignals
    .slice()
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 3)
    .map((f) => ({ name: f.name, value: f.value }))

  let action: StrategyDecision['action'] = 'hold'
  if (snapshot.governance.actionStatus === 'no-trade' || snapshot.governance.actionStatus === 'exit') {
    action = snapshot.governance.actionStatus === 'exit' ? 'exit' : 'no-trade'
  } else if (snapshot.governance.actionStatus === 'reduce') {
    action = 'reduce'
  } else if (
    snapshot.governance.actionStatus === 'attack'
    || snapshot.governance.actionStatus === 'attack-lite'
    || snapshot.governance.actionStatus === 'probe'
  ) {
    action = 'enter'
  }

  return {
    action,
    confidence: snapshot.ensemble.aggregateConfidence,
    regime: snapshot.hmmRegime?.stateName ?? snapshot.regimeEvaluation?.regime ?? 'unknown',
    dominantFactors,
    ensembleValue: snapshot.ensemble.aggregateValue,
    positionSizing: {
      assetLayer: snapshot.positionSizing.assetLayer,
      recommendedPctOfEquity: snapshot.positionSizing.recommendedPctOfEquity,
      requestedPctOfEquity: snapshot.positionSizing.requestedPctOfEquity,
      maxPositionPctOfEquity: snapshot.positionSizing.maxPositionPctOfEquity,
      method: snapshot.positionSizing.method,
    },
    freezeActive: snapshot.freeze.active,
    maxActionDuringFreeze: snapshot.freeze.maxActionDuringFreeze,
    source,
    reason,
  }
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
