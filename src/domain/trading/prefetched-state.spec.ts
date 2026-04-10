import { describe, expect, it } from 'vitest'
import { cloneOperationWithPrefetchedRiskState, getPrefetchedRiskState } from './prefetched-state.js'
import type { Operation } from './operation-dispatcher.types.js'

describe('prefetched-state', () => {
  it('clones operations while preserving prefetched risk state', () => {
    const op: Operation = {
      action: 'placeOrder',
      params: { symbol: 'BTC/USD' },
    }
    const cloned = cloneOperationWithPrefetchedRiskState(
      op,
      { symbol: 'BTC/USD', side: 'buy', type: 'market' },
      { positions: [], account: { balance: 1, totalMargin: 0, unrealizedPnL: 0, equity: 1, realizedPnL: 0, totalPnL: 0 } },
    )

    expect(cloned).not.toBe(op)
    expect(getPrefetchedRiskState(cloned)?.account?.equity).toBe(1)
  })
})

