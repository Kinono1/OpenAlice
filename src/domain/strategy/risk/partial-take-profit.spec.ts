import { describe, expect, it } from 'vitest'
import { computePartialTakeProfit } from './partial-take-profit.js'

const levels = [
  { id: 'tp_1r', rewardMultiple: 1, closeFraction: 0.5 },
  { id: 'tp_2r', rewardMultiple: 2, closeFraction: 0.25 },
]

describe('partial take profit', () => {
  it('closes the first tranche for a long when price reaches 1R', () => {
    const decision = computePartialTakeProfit({
      side: 'long',
      entryPrice: 100,
      currentPrice: 112,
      stopLossPrice: 90,
      originalQuantity: 10,
      levels,
    })

    expect(decision.triggeredLevels.map(level => level.id)).toEqual(['tp_1r'])
    expect(decision.closeFraction).toBe(0.5)
    expect(decision.closeQuantity).toBe(5)
    expect(decision.remainingFractionAfterClose).toBe(0.5)
  })

  it('only closes the incremental tranche when one level was already taken', () => {
    const decision = computePartialTakeProfit({
      side: 'long',
      entryPrice: 100,
      currentPrice: 125,
      stopLossPrice: 90,
      originalQuantity: 10,
      alreadyClosedFraction: 0.5,
      levels,
    })

    expect(decision.triggeredLevels.map(level => level.id)).toEqual(['tp_1r', 'tp_2r'])
    expect(decision.closeFraction).toBe(0.25)
    expect(decision.closeQuantity).toBe(2.5)
    expect(decision.remainingFractionAfterClose).toBe(0.25)
  })

  it('supports short positions', () => {
    const decision = computePartialTakeProfit({
      side: 'short',
      entryPrice: 100,
      currentPrice: 88,
      stopLossPrice: 110,
      originalQuantity: 20,
      levels,
    })

    expect(decision.rewardMultiple).toBe(1.2)
    expect(decision.closeFraction).toBe(0.5)
    expect(decision.closeQuantity).toBe(10)
  })

  it('does nothing before the first configured level', () => {
    const decision = computePartialTakeProfit({
      side: 'long',
      entryPrice: 100,
      currentPrice: 104,
      stopLossPrice: 90,
      originalQuantity: 10,
      levels,
    })

    expect(decision.triggeredLevels).toEqual([])
    expect(decision.closeFraction).toBe(0)
    expect(decision.reason).toBe('partial_take_profit:not_triggered')
  })

  it('rejects invalid level sizing', () => {
    expect(() => computePartialTakeProfit({
      side: 'long',
      entryPrice: 100,
      currentPrice: 120,
      stopLossPrice: 90,
      originalQuantity: 10,
      levels: [
        { id: 'too_much_1', rewardMultiple: 1, closeFraction: 0.8 },
        { id: 'too_much_2', rewardMultiple: 2, closeFraction: 0.3 },
      ],
    })).toThrow('sum(level.closeFraction) must be <= 1')
  })
})
