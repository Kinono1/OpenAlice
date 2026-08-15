export type PartialTakeProfitSide = 'long' | 'short'

export interface PartialTakeProfitLevel {
  id: string
  rewardMultiple: number
  closeFraction: number
}

export interface PartialTakeProfitInput {
  side: PartialTakeProfitSide
  entryPrice: number
  currentPrice: number
  stopLossPrice: number
  originalQuantity: number
  alreadyClosedFraction?: number
  levels: PartialTakeProfitLevel[]
}

export interface PartialTakeProfitDecision {
  side: PartialTakeProfitSide
  rewardMultiple: number
  triggeredLevels: PartialTakeProfitLevel[]
  closeFraction: number
  closeQuantity: number
  remainingFractionAfterClose: number
  reason: string
}

export function computePartialTakeProfit(
  input: PartialTakeProfitInput,
): PartialTakeProfitDecision {
  validateInput(input)
  const riskPerUnit = Math.abs(input.entryPrice - input.stopLossPrice)
  const signedGainPerUnit = input.side === 'long'
    ? input.currentPrice - input.entryPrice
    : input.entryPrice - input.currentPrice
  const rewardMultiple = signedGainPerUnit / riskPerUnit
  const alreadyClosedFraction = input.alreadyClosedFraction ?? 0
  const sortedLevels = [...input.levels].sort(
    (left, right) => left.rewardMultiple - right.rewardMultiple,
  )
  const cumulativeTriggeredFraction = clampFraction(sortedLevels
    .filter(level => rewardMultiple >= level.rewardMultiple)
    .reduce((sum, level) => sum + level.closeFraction, 0))
  const closeFraction = clampFraction(cumulativeTriggeredFraction - alreadyClosedFraction)
  const closeQuantity = input.originalQuantity * closeFraction
  const remainingFractionAfterClose =
    clampFraction(1 - alreadyClosedFraction - closeFraction)

  return {
    side: input.side,
    rewardMultiple,
    triggeredLevels: sortedLevels.filter(level => rewardMultiple >= level.rewardMultiple),
    closeFraction,
    closeQuantity,
    remainingFractionAfterClose,
    reason: closeFraction > 0
      ? `partial_take_profit:${closeFraction.toFixed(4)}`
      : 'partial_take_profit:not_triggered',
  }
}

function validateInput(input: PartialTakeProfitInput): void {
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
    throw new Error('entryPrice must be a finite number > 0')
  }
  if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) {
    throw new Error('currentPrice must be a finite number > 0')
  }
  if (!Number.isFinite(input.stopLossPrice) || input.stopLossPrice <= 0) {
    throw new Error('stopLossPrice must be a finite number > 0')
  }
  if (input.stopLossPrice === input.entryPrice) {
    throw new Error('stopLossPrice must differ from entryPrice')
  }
  if (!Number.isFinite(input.originalQuantity) || input.originalQuantity <= 0) {
    throw new Error('originalQuantity must be a finite number > 0')
  }
  if (
    input.alreadyClosedFraction != null &&
    (!Number.isFinite(input.alreadyClosedFraction) ||
      input.alreadyClosedFraction < 0 ||
      input.alreadyClosedFraction > 1)
  ) {
    throw new Error('alreadyClosedFraction must be in [0, 1]')
  }
  if (input.levels.length === 0) {
    throw new Error('levels must not be empty')
  }
  const totalCloseFraction = input.levels.reduce((sum, level) => {
    if (!level.id.trim()) {
      throw new Error('level id must be non-empty')
    }
    if (!Number.isFinite(level.rewardMultiple) || level.rewardMultiple <= 0) {
      throw new Error('level rewardMultiple must be a finite number > 0')
    }
    if (!Number.isFinite(level.closeFraction) || level.closeFraction <= 0) {
      throw new Error('level closeFraction must be a finite number > 0')
    }
    return sum + level.closeFraction
  }, 0)
  if (totalCloseFraction > 1) {
    throw new Error('sum(level.closeFraction) must be <= 1')
  }
}

function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value))
}
