import type { CryptoPlaceOrderRequest } from '../trading/operation-dispatcher.types.js'
import type { RuntimeFactorSnapshot } from './runtime-evaluator.js'
import type { StrategyDataProvenance, StrategyExecutionDecision } from './runtime-types.js'

function estimateRequestedNotionalUsd(
  request: Pick<CryptoPlaceOrderRequest, 'size' | 'usd_size' | 'price'>,
  referencePrice?: number,
): number | null {
  if (typeof request.usd_size === 'number' && Number.isFinite(request.usd_size) && request.usd_size > 0) {
    return request.usd_size
  }

  if (typeof request.size === 'number' && Number.isFinite(request.size) && request.size > 0) {
    const price =
      typeof request.price === 'number' && Number.isFinite(request.price) && request.price > 0
        ? request.price
        : referencePrice
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
      return request.size * price
    }
  }

  return null
}

function withReason(
  decision: Omit<StrategyExecutionDecision, 'reasons'>,
  ...reasons: Array<string | undefined>
): StrategyExecutionDecision {
  return {
    ...decision,
    reasons: reasons.filter((reason): reason is string => !!reason),
  }
}

function withReferencePrice(
  provenance: StrategyDataProvenance,
  referencePrice?: number,
): StrategyDataProvenance {
  if (!(typeof referencePrice === 'number' && Number.isFinite(referencePrice) && referencePrice > 0)) {
    return provenance
  }
  return {
    ...provenance,
    referencePrice: {
      source: 'derived',
      status: 'resolved',
      detail: 'resolved from request price or expected execution price',
    },
  }
}

export function buildStrategyExecutionDecision(input: {
  snapshot: RuntimeFactorSnapshot
  request: CryptoPlaceOrderRequest
  isNewOpen: boolean
  referencePrice?: number
}): StrategyExecutionDecision {
  const { snapshot, request, isNewOpen, referencePrice } = input
  const actionStatus = snapshot.governance.actionStatus
  const requestedNotionalUsd = estimateRequestedNotionalUsd(request, referencePrice)
  const recommendedNotionalUsd = snapshot.positionSizing.recommendedNotionalUsd
  const dataProvenance = withReferencePrice(snapshot.dataProvenance, referencePrice)
  const freeze = {
    active: snapshot.freeze.active,
    maxActionDuringFreeze: snapshot.freeze.maxActionDuringFreeze,
    activeEvents: snapshot.freeze.activeWindows.map((window) => window.event.name),
  } as const

  if (!isNewOpen || request.reduceOnly) {
    return withReason(
      {
        mode: 'pass-through',
        actionStatus,
        requestedNotionalUsd,
        recommendedNotionalUsd,
        effectiveNotionalUsd: requestedNotionalUsd,
        effectiveSize: request.size ?? null,
        effectiveUsdSize: request.usd_size ?? null,
        assetLayer: snapshot.positionSizing.assetLayer,
        dataProvenance,
        freeze,
      },
      request.reduceOnly ? 'reduce-only order bypasses strategy sizing' : 'existing position path bypasses new-open sizing gate',
    )
  }

  if (actionStatus === 'no-trade' || actionStatus === 'exit') {
    const blockReason = `strategy action status ${actionStatus} blocks new opens`
    return withReason(
      {
        mode: 'blocked',
        actionStatus,
        requestedNotionalUsd,
        recommendedNotionalUsd,
        effectiveNotionalUsd: 0,
        effectiveSize: null,
        effectiveUsdSize: null,
        assetLayer: snapshot.positionSizing.assetLayer,
        blockReason,
        dataProvenance,
        freeze,
      },
      blockReason,
    )
  }

  if (!snapshot.positionSizing.allowed) {
    const blockReason = snapshot.positionSizing.reasons[0] ?? 'strategy position sizing rejected order'
    return withReason(
      {
        mode: 'blocked',
        actionStatus,
        requestedNotionalUsd,
        recommendedNotionalUsd,
        effectiveNotionalUsd: 0,
        effectiveSize: null,
        effectiveUsdSize: null,
        assetLayer: snapshot.positionSizing.assetLayer,
        blockReason,
        dataProvenance,
        freeze,
      },
      ...snapshot.positionSizing.reasons,
    )
  }

  if (!(typeof recommendedNotionalUsd === 'number' && Number.isFinite(recommendedNotionalUsd) && recommendedNotionalUsd > 0)) {
    const blockReason = 'strategy recommended notional is unavailable or non-positive'
    return withReason(
      {
        mode: 'blocked',
        actionStatus,
        requestedNotionalUsd,
        recommendedNotionalUsd,
        effectiveNotionalUsd: 0,
        effectiveSize: null,
        effectiveUsdSize: null,
        assetLayer: snapshot.positionSizing.assetLayer,
        blockReason,
        dataProvenance,
        freeze,
      },
      blockReason,
    )
  }

  if (!(typeof requestedNotionalUsd === 'number' && Number.isFinite(requestedNotionalUsd) && requestedNotionalUsd > 0)) {
    const fallbackReason = 'requested order notional could not be resolved'
    return withReason(
      {
        mode: 'fallback',
        actionStatus,
        requestedNotionalUsd,
        recommendedNotionalUsd,
        effectiveNotionalUsd: requestedNotionalUsd,
        effectiveSize: request.size ?? null,
        effectiveUsdSize: request.usd_size ?? null,
        assetLayer: snapshot.positionSizing.assetLayer,
        fallbackReason,
        dataProvenance,
        freeze,
      },
      fallbackReason,
    )
  }

  const effectiveNotionalUsd = Math.min(requestedNotionalUsd, recommendedNotionalUsd)
  if (!(effectiveNotionalUsd > 0)) {
    const blockReason = 'strategy effective notional is non-positive'
    return withReason(
      {
        mode: 'blocked',
        actionStatus,
        requestedNotionalUsd,
        recommendedNotionalUsd,
        effectiveNotionalUsd,
        effectiveSize: null,
        effectiveUsdSize: null,
        assetLayer: snapshot.positionSizing.assetLayer,
        blockReason,
        dataProvenance,
        freeze,
      },
      blockReason,
    )
  }

  if (typeof request.usd_size === 'number' && request.usd_size > 0) {
    return withReason(
      {
        mode: effectiveNotionalUsd < requestedNotionalUsd ? 'applied' : 'pass-through',
        actionStatus,
        requestedNotionalUsd,
        recommendedNotionalUsd,
        effectiveNotionalUsd,
        effectiveSize: request.size ?? null,
        effectiveUsdSize: effectiveNotionalUsd,
        assetLayer: snapshot.positionSizing.assetLayer,
        dataProvenance,
        freeze,
      },
      effectiveNotionalUsd < requestedNotionalUsd ? 'strategy capped notional to recommended upper bound' : 'requested notional already within strategy cap',
    )
  }

  const price =
    typeof request.price === 'number' && request.price > 0
      ? request.price
      : referencePrice
  if (!(typeof price === 'number' && Number.isFinite(price) && price > 0)) {
    const fallbackReason = 'missing reference price for size conversion'
    return withReason(
      {
        mode: 'fallback',
        actionStatus,
        requestedNotionalUsd,
        recommendedNotionalUsd,
        effectiveNotionalUsd: requestedNotionalUsd,
        effectiveSize: request.size ?? null,
        effectiveUsdSize: request.usd_size ?? null,
        assetLayer: snapshot.positionSizing.assetLayer,
        fallbackReason,
        dataProvenance,
        freeze,
      },
      fallbackReason,
    )
  }

  const effectiveSize = effectiveNotionalUsd / price
  return withReason(
    {
      mode: effectiveNotionalUsd < requestedNotionalUsd ? 'applied' : 'pass-through',
      actionStatus,
      requestedNotionalUsd,
      recommendedNotionalUsd,
      effectiveNotionalUsd,
      effectiveSize,
      effectiveUsdSize: null,
      assetLayer: snapshot.positionSizing.assetLayer,
      dataProvenance,
      freeze,
    },
    effectiveNotionalUsd < requestedNotionalUsd ? 'strategy capped notional to recommended upper bound' : 'requested notional already within strategy cap',
  )
}
