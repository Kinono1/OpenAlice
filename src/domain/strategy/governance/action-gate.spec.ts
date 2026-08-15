import { describe, it, expect } from 'vitest'
import { evaluateSignalGovernance } from './action-gate.js'
import type { SignalScore, GovernanceContext } from './types.js'

describe('evaluateSignalGovernance', () => {
  const baseSignal: SignalScore = {
    sourceTier: 'L1',
    useType: 'U1',
    decisionStrength: 'D1',
    sentiment: 'S0',
  }

  describe('action status mapping', () => {
    it('maps strong signal to aggressive action', () => {
      const result = evaluateSignalGovernance({
        ...baseSignal,
        decisionStrength: 'D1',
        sourceTier: 'L1',
      })
      expect(result.baseActionStatus).toBeDefined()
      expect(result.actionStatus).toBeDefined()
    })

    it('maps weak signal to conservative action', () => {
      const result = evaluateSignalGovernance({
        ...baseSignal,
        decisionStrength: 'D5',
        sourceTier: 'L5',
      })
      expect(result.baseActionStatus).toBeDefined()
      expect(result.actionStatus).toBeDefined()
    })
  })

  describe('stale data fail-closed enforcement', () => {
    it('forces no-trade when staleData is true', () => {
      const context: GovernanceContext = { staleData: true }
      const result = evaluateSignalGovernance(baseSignal, context)
      expect(result.actionStatus).toBe('no-trade')
      expect(result.staleDataApplied).toBe(true)
    })

    it('allows trading when staleData is false', () => {
      const context: GovernanceContext = { staleData: false }
      const result = evaluateSignalGovernance(baseSignal, context)
      expect(result.actionStatus).not.toBe('no-trade')
      expect(result.staleDataApplied).toBe(false)
    })

    it('allows trading when staleData is undefined', () => {
      const result = evaluateSignalGovernance(baseSignal)
      expect(result.staleDataApplied).toBe(false)
    })
  })

  describe('event window risk capping', () => {
    it('caps action during event window freeze', () => {
      const context: GovernanceContext = {
        eventWindowFrozen: true,
        maxActionDuringFreeze: 'reduce',
      }
      const result = evaluateSignalGovernance(baseSignal, context)
      expect(result.cappedByEventWindow).toBeDefined()
    })

    it('allows full action when event window is not frozen', () => {
      const context: GovernanceContext = {
        eventWindowFrozen: false,
      }
      const result = evaluateSignalGovernance(baseSignal, context)
      expect(result.cappedByEventWindow).toBe(false)
    })
  })

  describe('stale data overrides event window', () => {
    it('forces no-trade even during event window freeze', () => {
      const context: GovernanceContext = {
        staleData: true,
        eventWindowFrozen: true,
        maxActionDuringFreeze: 'reduce',
      }
      const result = evaluateSignalGovernance(baseSignal, context)
      expect(result.actionStatus).toBe('no-trade')
      expect(result.staleDataApplied).toBe(true)
      expect(result.cappedByEventWindow).toBe(false)
    })
  })

  describe('context preservation', () => {
    it('preserves event severity in context', () => {
      const context: GovernanceContext = {
        eventSeverity: 'high',
        eventWindowFrozen: true,
      }
      const result = evaluateSignalGovernance(baseSignal, context)
      expect(result.context.eventSeverity).toBe('high')
      expect(result.context.eventWindowFrozen).toBe(true)
    })

    it('defaults event severity to none', () => {
      const result = evaluateSignalGovernance(baseSignal)
      expect(result.context.eventSeverity).toBe('none')
      expect(result.context.eventWindowFrozen).toBe(false)
    })
  })
})
