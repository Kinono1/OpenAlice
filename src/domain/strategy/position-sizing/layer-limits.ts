import type { ActionStatus } from '../governance/types.js'
import type {
  LayerConfig,
  PositionSizingContext,
  PositionSizingDecision,
  PositionSizingMethod,
} from './types.js'

const ACTION_ORDER: ActionStatus[] = [
  'no-trade',
  'exit',
  'reduce',
  'hold',
  'probe',
  'attack-lite',
  'attack',
]

function actionRank(action: ActionStatus): number {
  return ACTION_ORDER.indexOf(action)
}

export function evaluateLayerLimits(
  config: LayerConfig,
  context: PositionSizingContext,
  requestedPctOfEquity: number,
  method: PositionSizingMethod,
): PositionSizingDecision {
  const reasons: string[] = []
  let allowed = true

  if (actionRank(context.actionStatus) < actionRank(config.minActionStatusToTrade)) {
    allowed = false
    reasons.push(
      `actionStatus ${context.actionStatus} is below minimum ${config.minActionStatusToTrade}`,
    )
  }

  if (context.currentLayerOpenPositions >= config.maxPositions) {
    allowed = false
    reasons.push(
      `layer ${config.layer} already has ${context.currentLayerOpenPositions} open positions (max ${config.maxPositions})`,
    )
  }

  if (config.requiresCoreNotRiskOff && context.coreRiskOff) {
    allowed = false
    reasons.push(`layer ${config.layer} is blocked while core is risk-off`)
  }

  const maxPositionPctOfEquity = config.maxPositionPctOfEquity
  const recommendedPctOfEquity = allowed
    ? Math.min(requestedPctOfEquity, maxPositionPctOfEquity)
    : 0

  return {
    allowed,
    maxPositionPctOfEquity,
    recommendedPctOfEquity,
    method,
    reasons,
  }
}
