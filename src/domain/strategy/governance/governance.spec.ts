import { describe, expect, it } from 'vitest'
import {
  computeConfidenceBreakdown,
  evaluateSignalGovernance,
} from './index.js'

describe('strategy governance', () => {
  it('computes a full breakdown for a high-quality signal', () => {
    const breakdown = computeConfidenceBreakdown({
      sourceTier: 'L1',
      useType: 'U1',
      decisionStrength: 'D1',
      sentiment: 'S0',
    })

    expect(breakdown.totalScore).toBe(100)
    expect(breakdown.sourceQualityScore).toBe(25)
    expect(breakdown.executionClarityScore).toBe(20)
  })

  it('caps execution clarity when data is stale', () => {
    const breakdown = computeConfidenceBreakdown(
      {
        sourceTier: 'L1',
        useType: 'U1',
        decisionStrength: 'D1',
        sentiment: 'S0',
      },
      { staleData: true },
    )

    expect(breakdown.executionClarityScore).toBe(4)
    expect(breakdown.totalScore).toBe(84)
  })

  it('maps high-confidence signals to attack by default', () => {
    const result = evaluateSignalGovernance({
      sourceTier: 'L1',
      useType: 'U1',
      decisionStrength: 'D1',
      sentiment: 'S0',
    })

    expect(result.baseActionStatus).toBe('attack')
    expect(result.actionStatus).toBe('attack')
  })

  it('caps risk-taking to reduce inside an event freeze window', () => {
    const result = evaluateSignalGovernance(
      {
        sourceTier: 'L1',
        useType: 'U1',
        decisionStrength: 'D1',
        sentiment: 'S0',
      },
      {
        eventWindowFrozen: true,
        eventSeverity: 'high',
        maxActionDuringFreeze: 'reduce',
      },
    )

    expect(result.baseActionStatus).toBe('attack-lite')
    expect(result.actionStatus).toBe('reduce')
    expect(result.cappedByEventWindow).toBe(true)
  })

  it('drops weak signals to no-trade', () => {
    const result = evaluateSignalGovernance({
      sourceTier: 'L5',
      useType: 'U4',
      decisionStrength: 'D5',
      sentiment: 'S+2',
    })

    expect(result.breakdown.totalScore).toBeLessThan(40)
    expect(result.actionStatus).toBe('no-trade')
  })
})
