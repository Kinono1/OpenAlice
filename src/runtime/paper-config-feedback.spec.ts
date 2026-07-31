import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  analyzePaperResultsForConfigProposals,
  writeConfigProposals,
  readConfigProposals,
  FACTOR_SIGNAL_TO_CONFIG,
  applyConfigProposal,
} from './paper-config-feedback.js'

describe('paper-config-feedback', () => {
  describe('FACTOR_SIGNAL_TO_CONFIG', () => {
    it('maps hyphen-case factor names to camelCase config keys', () => {
      expect(FACTOR_SIGNAL_TO_CONFIG['momentum-composite']).toBe('momentumComposite')
      expect(FACTOR_SIGNAL_TO_CONFIG['funding-rate']).toBe('fundingRate')
      expect(FACTOR_SIGNAL_TO_CONFIG['carry-spread']).toBe('carrySpread')
      expect(FACTOR_SIGNAL_TO_CONFIG['liquidation-aftermath']).toBe('liquidationAftermath')
      expect(FACTOR_SIGNAL_TO_CONFIG['cross-timeframe-divergence']).toBe('crossTimeframeDivergence')
      expect(FACTOR_SIGNAL_TO_CONFIG['order-book-imbalance']).toBe('orderBookImbalance')
      expect(FACTOR_SIGNAL_TO_CONFIG['stablecoin-flow']).toBe('stablecoinFlow')
    })
  })

  describe('analyzePaperResultsForConfigProposals', () => {
    it('generates a reduce-weight proposal when IC is decayed and negative', () => {
      const result = analyzePaperResultsForConfigProposals({
        factorMetrics: [
          {
            factorName: 'momentum-composite',
            currentWeight: 0.3,
            icSharpe: -0.5,
            icDecayed: true,
          },
        ],
      })

      expect(result.proposals).toHaveLength(1)
      expect(result.proposals[0].proposalType).toBe('factor_weight_adjust')
      expect(result.proposals[0].signalName).toBe('momentum-composite')
      expect(result.proposals[0].configPath).toBe('factors.momentumComposite.weight')
      expect(result.proposals[0].currentValue).toBe(0.3)
      expect(result.proposals[0].proposedValue).toBe(0.24) // 0.3 * 0.8
      expect(result.proposals[0].status).toBe('pending')
    })

    it('skips unknown factor names with a skipped reason', () => {
      const result = analyzePaperResultsForConfigProposals({
        factorMetrics: [
          { factorName: 'unknown-factor', currentWeight: 0.5, icSharpe: null, icDecayed: false },
        ],
      })

      expect(result.proposals).toHaveLength(0)
      expect(result.skipped.length).toBeGreaterThanOrEqual(1)
      expect(result.skipped[0].reason).toContain('unknown factor')
    })

    it('skips factor with no IC decay (healthy)', () => {
      const result = analyzePaperResultsForConfigProposals({
        factorMetrics: [
          { factorName: 'momentum-composite', currentWeight: 0.3, icSharpe: 0.5, icDecayed: false },
        ],
      })

      expect(result.proposals).toHaveLength(0)
    })

    it('skips factor with decayed IC but positive IC Sharpe', () => {
      const result = analyzePaperResultsForConfigProposals({
        factorMetrics: [
          { factorName: 'momentum-composite', currentWeight: 0.3, icSharpe: 0.2, icDecayed: true },
        ],
      })

      // icDecayed is true but icSharpe is positive — signal might still work
      expect(result.proposals).toHaveLength(0)
    })

    it('records insufficient_factor_attribution when no proposals generated', () => {
      const result = analyzePaperResultsForConfigProposals({
        factorMetrics: [
          { factorName: 'momentum-composite', currentWeight: 0.3, icSharpe: null, icDecayed: false },
        ],
      })

      expect(result.proposals).toHaveLength(0)
      expect(result.skipped.some((s) => s.reason.includes('insufficient_factor_attribution'))).toBe(true)
    })
  })

  describe('persistence', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-test-'))
      process.env.OPENALICE_DATA_DIR = tmpDir
    })

    afterEach(() => {
      process.env.OPENALICE_DATA_DIR = undefined
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('writes and reads proposals from disk', () => {
      const proposals = [
        {
          id: 'test-1',
          proposalType: 'factor_weight_adjust' as const,
          description: 'Test proposal',
          configPath: 'factors.momentumComposite.weight',
          signalName: 'momentum-composite',
          currentValue: 0.3,
          proposedValue: 0.24,
          evidence: ['ic-monitor'],
          confidence: 0.5,
          status: 'pending' as const,
          createdAt: new Date().toISOString(),
        },
      ]

      writeConfigProposals(proposals)
      const loaded = readConfigProposals()

      expect(loaded).toHaveLength(1)
      expect(loaded[0].id).toBe('test-1')
      expect(loaded[0].proposedValue).toBe(0.24)
    })

    it('returns empty array when no file exists', () => {
      const loaded = readConfigProposals()
      expect(loaded).toEqual([])
    })
  })

  describe('applyConfigProposal', () => {
    it('throws in v1 (not implemented)', () => {
      expect(() => applyConfigProposal('any-id')).toThrow('not implemented')
    })
  })
})
