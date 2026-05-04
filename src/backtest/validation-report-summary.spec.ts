import { describe, expect, it } from 'vitest'
import { buildValidationDecisionSummary } from './validation-report-summary.js'

describe('validation-report-summary', () => {
  it('normalizes generic runtime validation evidence into a paper-promotion summary', () => {
    const summary = buildValidationDecisionSummary({
      generatedAt: '2026-04-28T00:00:00.000Z',
      input: { symbol: 'BTC/USD', strategy: 'trend' },
      selectedMetrics: {
        sharpe: 1.2,
        sortino: 1.5,
        totalReturnPct: -0.5,
        netExpectancyPct: -0.01,
        maxDrawdownPct: 8,
        tradeCount: 12,
      },
      validationEvidence: {
        turnover: {
          available: true,
          turnoverPctOfInitialCapital: 120,
          averageTurnoverPctPerTrade: 10,
          totalTurnoverUsd: 12_000,
        },
        costAdjustedReturn: {
          available: true,
          totalReturnPct: -0.5,
          grossExpectancyPct: 0.03,
          netExpectancyPct: -0.01,
          costDragPctOfInitialCapital: 2.1,
        },
        factorIcByHorizon: {
          available: false,
          reason: 'runtime factor snapshot history missing',
        },
        strategySignalIcByHorizon: [
          {
            horizonBars: 1,
            observations: 100,
            activeSignalObservations: 20,
            pearsonIc: 0.04,
            meanForwardReturnWhenLongPct: 0.1,
            meanForwardReturnWhenShortPct: -0.08,
          },
        ],
        regimeSplitPerformance: { LowVolTrend: { tradeCount: 3 } },
        longShortSideAsymmetry: {
          long: { tradeCount: 7, netExpectancyPct: 0.02 },
          short: { tradeCount: 5, netExpectancyPct: -0.04 },
        },
        paperExecutionSlippage: {
          available: false,
          gateStatus: 'skipped',
          reason: 'paper telemetry missing',
        },
        strategyPlanEvidence: {
          crossAssetRegimeConsistency: {
            available: true,
            result: { consistent: false },
          },
          alphaFactorAdmission: {
            available: true,
            totalCandidates: 8,
            acceptedCount: 6,
            runtimeAcceptedAdmissionGateFailedCount: 0,
          },
          sessionAwareSlippageEstimate: {
            available: true,
            tradeCount: 12,
            averageEstimatedSlippageBps: 8,
            maxEstimatedSlippageBps: 10,
            dominantSession: 'us',
          },
        },
      },
      wfo: {
        overallPassed: false,
        failedWindows: 1,
        windows: [
          { gatePassed: true },
          { gatePassed: false },
        ],
      },
      significance: {
        passed: false,
        pbo: 0.97,
        dsrProbability: 0.2,
        fdrQ: null,
        candidateTrialCount: 3,
        trialLedger: {
          rawM: 12,
          effectiveM: 5,
          rawMComplete: false,
          includesFailedTrials: true,
          fdrMethodPrimary: 'BY_raw_m',
        },
      },
      riskSimulation: {
        gatePassed: false,
        profitProbability: 0.4,
        riskOfRuin: 0.1,
        expectedFinalReturnPct: -2,
      },
      releaseGate: {
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ['wfo', 'strategy_plan_evidence'],
        warningChecks: [],
        checks: [
          {
            name: 'significance',
            status: 'fail',
            summary: 'Statistical significance gate failed.',
            metrics: {
              trialLedgerStatus: 'fail',
              trialLedgerBlocks: 'trial_ledger_raw_m_incomplete,trial_ledger_raw_m_below_candidate_trial_count',
              trialLedgerRawM: 12,
              trialLedgerEffectiveM: 5,
              trialLedgerRawMComplete: false,
              trialLedgerIncludesFailedTrials: true,
              trialLedgerFdrMethodPrimary: 'BY_raw_m',
            },
          },
        ],
      },
    })

    expect(summary.schemaVersion).toBe('validation_decision_summary.v1')
    expect(summary.oosPerformance.sharpe).toBe(1.2)
    expect(summary.sampleReliability.status).toBe('unknown')
    expect(summary.performanceDisplayPolicy).toMatchObject({
      showPnlCurve: true,
      showEquityCurve: true,
      severity: 'normal',
    })
    expect(summary.wfo.passRate).toBe(0.5)
    expect(summary.strategySignalIcByHorizon.available).toBe(true)
    expect(summary.factorIcByHorizon.available).toBe(false)
    expect(summary.strategyPlanEvidence.alphaFactorAdmission.acceptedCount).toBe(6)
    expect(summary.statistics.trialLedgerStatus).toBe('fail')
    expect(summary.statistics.trialLedgerBlocks).toEqual([
      'trial_ledger_raw_m_incomplete',
      'trial_ledger_raw_m_below_candidate_trial_count',
    ])
    expect(summary.statistics.trialLedgerRawM).toBe(12)
    expect(summary.statistics.trialLedgerEffectiveM).toBe(5)
    expect(summary.statistics.trialLedgerRawMComplete).toBe(false)
    expect(summary.statistics.trialLedgerIncludesFailedTrials).toBe(true)
    expect(summary.statistics.trialLedgerFdrMethodPrimary).toBe('BY_raw_m')
    expect(summary.evidenceVerdict.standsUpForPaperPromotion).toBe(false)
    expect(summary.evidenceVerdict.missingCriticalEvidence).toContain(
      'paper_execution_slippage_telemetry_unavailable',
    )
  })

  it('normalizes carry-style factor IC objects with horizons', () => {
    const summary = buildValidationDecisionSummary({
      input: { family: 'eth_carry', syntheticSymbol: 'ETH/BTC_CARRY' },
      selectedMetrics: { sharpe: -0.5, tradeCount: 3 },
      validationEvidence: {
        factorIcByHorizon: {
          available: true,
          factorName: 'eth_btc_funding_spread_direction',
          horizons: [
            {
              horizonBars: 6,
              observations: 30,
              activeSignalObservations: 30,
              pearsonIc: -0.12,
            },
          ],
        },
        paperExecutionSlippage: {
          available: false,
          substitute: 'strategyPlanEvidence.sessionAwareSlippageEstimate',
        },
        strategyPlanEvidence: {},
      },
      wfo: { windows: [] },
      significance: {
        passed: false,
        pboResult: { pbo: 1 },
        dsrResult: { dsrProbability: 0.001 },
        candidateTrialCount: 336,
        trialLedger: {
          rawM: 336,
          effectiveM: 20,
          rawMComplete: true,
          includesFailedTrials: true,
          fdrMethodPrimary: 'BY_raw_m',
        },
      },
      releaseGate: { allowPaperTrading: false, failedChecks: ['economics'], warningChecks: [] },
    })

    expect(summary.input.family).toBe('eth_carry')
    expect(summary.input.symbol).toBe('ETH/BTC_CARRY')
    expect(summary.statistics.pbo).toBe(1)
    expect(summary.statistics.dsrProbability).toBe(0.001)
    expect(summary.statistics.trialLedgerRawM).toBe(336)
    expect(summary.statistics.trialLedgerEffectiveM).toBe(20)
    expect(summary.statistics.trialLedgerRawMComplete).toBe(true)
    expect(summary.statistics.trialLedgerIncludesFailedTrials).toBe(true)
    expect(summary.statistics.trialLedgerFdrMethodPrimary).toBe('BY_raw_m')
    expect(summary.factorIcByHorizon.available).toBe(true)
    expect(summary.factorIcByHorizon.horizons[0]?.horizonBars).toBe(6)
    expect(summary.paperExecutionSlippage.substitute).toBe(
      'strategyPlanEvidence.sessionAwareSlippageEstimate',
    )
  })

  it('redacts performance curves when DSR sample reliability is low', () => {
    const summary = buildValidationDecisionSummary({
      input: { symbol: 'ETH/USD', strategy: 'breakout' },
      selectedMetrics: {
        sharpe: 2.1,
        totalReturnPct: 12,
        tradeCount: 50,
      },
      validationEvidence: {
        strategyPlanEvidence: {},
      },
      significance: {
        passed: false,
        dsrResult: {
          dsrProbability: null,
          independentBets: 50,
          minimumIndependentBets: 100,
          diagnosticQuality: 'low_sample',
          blockedReason: 'independent_bets_below_100',
        },
      },
      releaseGate: {
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ['significance'],
        warningChecks: [],
        checks: [
          {
            name: 'significance',
            status: 'fail',
            summary: 'Statistical significance gate failed.',
            metrics: {
              dsrStatus: 'low_sample',
              dsrDiagnosticQuality: 'low_sample',
              dsrIndependentBets: 50,
              dsrMinimumIndependentBets: 100,
              dsrBlockedReason: 'independent_bets_below_100',
            },
          },
        ],
      },
    })

    expect(summary.sampleReliability).toEqual({
      status: 'low_sample',
      independentBets: 50,
      minimumIndependentBets: 100,
      reason: 'independent_bets_below_100',
    })
    expect(summary.performanceDisplayPolicy).toEqual({
      showPnlCurve: false,
      showEquityCurve: false,
      severity: 'redacted_low_sample',
      reason: 'independent_bets_below_100',
    })
    expect(summary.evidenceVerdict.blockers).toContain('significance')
  })

  it('can derive low-sample display policy from release-gate metrics when dsrResult omits diagnostics', () => {
    const summary = buildValidationDecisionSummary({
      validationEvidence: { strategyPlanEvidence: {} },
      significance: {
        passed: false,
        dsrResult: {
          dsrProbability: null,
        },
      },
      releaseGate: {
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ['significance'],
        warningChecks: [],
        checks: [
          {
            name: 'significance',
            status: 'fail',
            summary: 'Statistical significance gate failed.',
            metrics: {
              dsrStatus: 'low_sample',
              dsrIndependentBets: 24,
              dsrMinimumIndependentBets: 100,
            },
          },
        ],
      },
    })

    expect(summary.sampleReliability.status).toBe('low_sample')
    expect(summary.sampleReliability.independentBets).toBe(24)
    expect(summary.sampleReliability.minimumIndependentBets).toBe(100)
    expect(summary.performanceDisplayPolicy.showPnlCurve).toBe(false)
    expect(summary.performanceDisplayPolicy.showEquityCurve).toBe(false)
  })
})
