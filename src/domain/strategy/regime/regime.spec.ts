import { describe, expect, it } from 'vitest'
import { evaluateRegime, evaluateRegimeTransition } from './index.js'

describe('strategy regime', () => {
  it('classifies event freeze as highest priority regime', () => {
    const result = evaluateRegime({
      trendStrength: 0.9,
      realizedVolPct: 8,
      rangeCompressionScore: 0.2,
      eventWindowFrozen: true,
    })

    expect(result.regime).toBe('event-risk-freeze')
  })

  it('classifies high-trend / low-vol environments as trend-follow', () => {
    const result = evaluateRegime({
      trendStrength: 0.8,
      realizedVolPct: 9,
      rangeCompressionScore: 0.2,
    })

    expect(result.regime).toBe('trend-follow')
  })

  it('classifies compressed low-vol markets as range-rotation', () => {
    const result = evaluateRegime({
      trendStrength: 0.3,
      realizedVolPct: 8,
      rangeCompressionScore: 0.8,
    })

    expect(result.regime).toBe('range-rotation')
  })

  it('downgrades trend tickets when moving into defensive regime', () => {
    const decision = evaluateRegimeTransition('trend-follow', 'spot-defensive')
    expect(decision.action).toBe('downgrade')
  })
})
