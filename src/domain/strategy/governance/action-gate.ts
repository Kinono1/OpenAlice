import { computeConfidenceBreakdown } from './scoring.js'
import type {
  ActionStatus,
  GovernanceContext,
  GovernanceEvaluation,
  SignalScore,
} from './types.js'

const ACTION_RISK_ORDER: ActionStatus[] = [
  'attack',
  'attack-lite',
  'probe',
  'hold',
  'reduce',
  'exit',
  'no-trade',
]

function clampActionToMaxRisk(
  action: ActionStatus,
  maxAction: ActionStatus,
): ActionStatus {
  const currentIndex = ACTION_RISK_ORDER.indexOf(action)
  const maxIndex = ACTION_RISK_ORDER.indexOf(maxAction)
  if (currentIndex === -1 || maxIndex === -1) {
    return action
  }
  return currentIndex > maxIndex ? action : maxAction
}

function scoreToBaseAction(
  totalScore: number,
  preferReduceOnWeakSignal = false,
): ActionStatus {
  if (totalScore >= 85) return 'attack'
  if (totalScore >= 70) return 'attack-lite'
  if (totalScore >= 65) return 'probe'
  if (totalScore >= 40) return preferReduceOnWeakSignal ? 'reduce' : 'hold'
  return 'no-trade'
}

export function evaluateSignalGovernance(
  signalScore: SignalScore,
  context: GovernanceContext = {},
): GovernanceEvaluation {
  const breakdown = computeConfidenceBreakdown(signalScore, context)
  const baseActionStatus = scoreToBaseAction(
    breakdown.totalScore,
    context.preferReduceOnWeakSignal,
  ) as GovernanceEvaluation['baseActionStatus']

  const maxActionDuringFreeze = context.maxActionDuringFreeze ?? 'reduce'
  const eventWindowFrozen = context.eventWindowFrozen === true
  const staleDataApplied = context.staleData === true
  const actionStatus = staleDataApplied
    ? 'no-trade'
    : eventWindowFrozen
      ? clampActionToMaxRisk(baseActionStatus, maxActionDuringFreeze)
      : baseActionStatus

  return {
    breakdown,
    baseActionStatus,
    actionStatus,
    cappedByEventWindow: !staleDataApplied && eventWindowFrozen && actionStatus !== baseActionStatus,
    staleDataApplied,
    context: {
      eventWindowFrozen,
      eventSeverity: context.eventSeverity ?? 'none',
    },
  }
}
