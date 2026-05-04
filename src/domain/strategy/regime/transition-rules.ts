import type { MarketRegime, RegimeTransitionDecision } from './types.js'

export function evaluateRegimeTransition(
  previous: MarketRegime,
  next: MarketRegime,
): RegimeTransitionDecision {
  if (previous === next) {
    return {
      previous,
      next,
      action: 'keep',
      reason: 'regime unchanged',
    }
  }

  if (next === 'event-risk-freeze' || next === 'vol-stress') {
    return {
      previous,
      next,
      action: 'cancel',
      reason:
        next === 'event-risk-freeze'
          ? 'event-risk-freeze requires cancelling stale directional tickets'
          : 'vol-stress requires cancelling stale directional tickets',
    }
  }

  if (previous === 'trend-follow' && next === 'spot-defensive') {
    return {
      previous,
      next,
      action: 'downgrade',
      reason: 'trend-follow tickets should be downgraded in defensive regime',
    }
  }

  return {
    previous,
    next,
    action: 'keep',
    reason: 'transition does not force ticket disposal',
  }
}
