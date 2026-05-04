import { describe, expect, it } from 'vitest'
import { evaluateReleaseGate, type RampUpEvaluation } from './release_gate.js'
import type { SignificanceGateResult } from './statistical_significance.js'

function healthySignificance(overrides?: Partial<SignificanceGateResult>): SignificanceGateResult {
  return {
    passed: true,
    pboResult: {
      pbo: 0.05,
      logits: Array.from({ length: 20 }, (_, index) => index + 1),
      splitsEvaluated: 20,
      partitions: 8,
    },
    dsrResult: {
      observedSharpe: 1.4,
      benchmarkSharpe: 0.4,
      dsrValue: 1.0,
      dsrProbability: 0.96,
      skewness: 0.1,
      kurtosis: 3.1,
      trialCount: 20,
      independentBets: 120,
      minimumIndependentBets: 100,
      diagnosticQuality: 'ok',
      promotionEligible: true,
      blockedReason: null,
    },
    pboThreshold: 0.1,
    dsrMin: 0.95,
    candidateTrialCount: 20,
    fdrQ: 0.01,
    trialLedger: {
      rawM: 20,
      effectiveM: 12,
      rawMComplete: true,
      includesFailedTrials: true,
      failedTrialCount: 8,
      survivingTrialCount: 12,
      fdrMethodPrimary: 'BY_raw_m',
    },
    ...overrides,
  }
}

describe('release_gate', () => {
  it('passes paper and live gates when all checks are healthy', () => {
    const ramp: RampUpEvaluation = {
      decision: 'promote',
      reason: 'promotion_ready',
      currentStage: { allocationPct: 10 },
      targetStage: { allocationPct: 25 },
      drawdownBreached: false,
    }

    const result = evaluateReleaseGate({
      wfo: {
        overallPassed: true,
        failedWindows: 0,
        windows: [
          {
            degradationRate: 0.2,
          },
        ],
      },
      significance: healthySignificance(),
      executionQuality: {
        action: 'monitor',
        consecutiveBreaches: 0,
        requiredConsecutiveDays: 3,
        breachedDates: [],
        latestDriftMultiplier: 1.1,
      },
      rampUp: ramp,
      regimeShift: {
        triggered: false,
        severity: 'none',
      },
    })

    expect(result.allowPaperTrading).toBe(true)
    expect(result.allowLiveTrading).toBe(true)
    expect(result.hardFail).toBe(false)
    expect(result.failedChecks).toEqual([])
  })

  it('blocks paper/live when significance fails', () => {
    const result = evaluateReleaseGate({
      significance: {
        passed: false,
        pboResult: {
          pbo: 0.42,
          logits: [-1, -2, -3],
          splitsEvaluated: 3,
          partitions: 8,
        },
        dsrResult: {
          observedSharpe: 0.2,
          benchmarkSharpe: 0.4,
          dsrValue: -0.2,
          dsrProbability: 0.2,
          skewness: 0,
          kurtosis: 3,
          trialCount: 5,
        },
        pboThreshold: 0.2,
        dsrMin: 0,
        candidateTrialCount: 20,
        fdrQ: 0.01,
        trialLedger: {
          rawM: 20,
          rawMComplete: true,
          includesFailedTrials: true,
          failedTrialCount: 10,
          survivingTrialCount: 10,
          fdrMethodPrimary: 'BY_raw_m',
        },
      },
    })

    expect(result.allowPaperTrading).toBe(false)
    expect(result.allowLiveTrading).toBe(false)
    expect(result.failedChecks).toContain('significance')
  })

  it('fails closed when significance evidence is missing', () => {
    const result = evaluateReleaseGate({})

    const check = result.checks.find((item) => item.name === 'significance')
    expect(check?.status).toBe('fail')
    expect(check?.summary).toBe('Significance stats not provided; failing gate.')
    expect(check?.metrics.fdrStatus).toBe('missing')
    expect(check?.metrics.trialLedgerBlocks).toBe('trial_ledger_missing')
    expect(result.failedChecks).toContain('significance')
    expect(result.allowPaperTrading).toBe(false)
    expect(result.allowLiveTrading).toBe(false)
  })

  it('uses DSR probability, not raw DSR value, for the release significance gate', () => {
    const result = evaluateReleaseGate({
      significance: {
        passed: true,
        pboResult: {
          pbo: 0.05,
          logits: [1, 2],
          splitsEvaluated: 2,
          partitions: 8,
        },
        dsrResult: {
          observedSharpe: 1.2,
          benchmarkSharpe: 0.2,
          dsrValue: 1.0,
          dsrProbability: 0.49,
          skewness: 0,
          kurtosis: 3,
          trialCount: 2,
        },
        pboThreshold: 0.2,
        dsrMin: 0,
        candidateTrialCount: 20,
        fdrQ: 0.01,
        trialLedger: {
          rawM: 20,
          rawMComplete: true,
          includesFailedTrials: true,
          failedTrialCount: 10,
          survivingTrialCount: 10,
          fdrMethodPrimary: 'BY_raw_m',
        },
      },
    })

    const check = result.checks.find((item) => item.name === 'significance')
    expect(check?.status).toBe('fail')
    expect(check?.metrics.dsrValue).toBe(1)
    expect(check?.metrics.dsrProbability).toBe(0.49)
    expect(check?.metrics.dsrProbabilityMin).toBe(0.95)
    expect(result.failedChecks).toContain('significance')
  })

  it('allows a low raw DSR value when DSR probability clears the strict default threshold', () => {
    const result = evaluateReleaseGate({
      significance: {
        passed: true,
        pboResult: {
          pbo: 0.05,
          logits: [1, 2],
          splitsEvaluated: 2,
          partitions: 8,
        },
        dsrResult: {
          observedSharpe: 0.7,
          benchmarkSharpe: 0.3,
          dsrValue: 0.01,
          dsrProbability: 0.96,
          skewness: 0,
          kurtosis: 3,
          trialCount: 20,
        },
        pboThreshold: 0.2,
        dsrMin: 0,
        candidateTrialCount: 20,
        fdrQ: 0.01,
        trialLedger: {
          rawM: 20,
          rawMComplete: true,
          includesFailedTrials: true,
          failedTrialCount: 10,
          survivingTrialCount: 10,
          fdrMethodPrimary: 'BY_raw_m',
        },
      },
    })

    const check = result.checks.find((item) => item.name === 'significance')
    expect(check?.status).toBe('pass')
    expect(result.failedChecks).not.toContain('significance')
  })

  it('hard-fails significance when DSR is low-sample null', () => {
    const result = evaluateReleaseGate({
      significance: healthySignificance({
        dsrResult: {
          observedSharpe: 1.1,
          benchmarkSharpe: 0.2,
          dsrValue: 0.9,
          dsrProbability: null,
          skewness: 0,
          kurtosis: 4,
          trialCount: 20,
          independentBets: 50,
          minimumIndependentBets: 100,
          diagnosticQuality: 'low_sample',
          promotionEligible: false,
          blockedReason: 'independent_bets_below_100',
        },
      }),
    })

    const check = result.checks.find((item) => item.name === 'significance')
    expect(check?.status).toBe('fail')
    expect(check?.summary).toBe('Statistical significance gate failed due to low DSR sample.')
    expect(check?.metrics.dsrStatus).toBe('low_sample')
    expect(check?.metrics.dsrProbability).toBeNull()
    expect(check?.metrics.dsrDiagnosticQuality).toBe('low_sample')
    expect(check?.metrics.dsrIndependentBets).toBe(50)
    expect(result.failedChecks).toContain('significance')
    expect(result.allowPaperTrading).toBe(false)
    expect(result.allowLiveTrading).toBe(false)
  })

  it('treats low-trial PBO as indeterminate: paper allowed, live blocked', () => {
    const result = evaluateReleaseGate({
      significance: healthySignificance({
        pboResult: {
          pbo: 1,
          logits: [1, 2, 3],
          splitsEvaluated: 3,
          partitions: 8,
        },
        candidateTrialCount: 3,
      }),
      executionQuality: {
        action: 'monitor',
        consecutiveBreaches: 0,
        requiredConsecutiveDays: 3,
        breachedDates: [],
        latestDriftMultiplier: 1,
      },
      rampUp: {
        decision: 'promote',
        reason: 'promotion_ready',
        currentStage: { allocationPct: 5 },
        targetStage: { allocationPct: 10 },
        drawdownBreached: false,
      },
      regimeShift: {
        triggered: false,
        severity: 'none',
      },
    })

    const check = result.checks.find((item) => item.name === 'significance')
    expect(check?.status).toBe('warn')
    expect(check?.metrics.pboStatus).toBe('indeterminate')
    expect(result.allowPaperTrading).toBe(true)
    expect(result.allowLiveTrading).toBe(false)
  })

  it('fails significance when FDR q is missing or above threshold', () => {
    const missing = evaluateReleaseGate({
      significance: healthySignificance({ fdrQ: null }),
    })
    const high = evaluateReleaseGate({
      significance: healthySignificance({ fdrQ: 0.06 }),
    })

    expect(missing.failedChecks).toContain('significance')
    expect(missing.checks.find((item) => item.name === 'significance')?.metrics.fdrStatus).toBe('missing')
    expect(high.failedChecks).toContain('significance')
    expect(high.checks.find((item) => item.name === 'significance')?.metrics.fdrStatus).toBe('fail')
  })

  it('hard-fails significance when SPA bootstrap sensitivity is unstable or missing', () => {
    const unstable = evaluateReleaseGate({
      significance: healthySignificance({
        fdrDiagnostics: {
          method: 'spa',
          bootstrapDirectionStable: false,
          unstableBootstrapCandidateIndexes: [2],
          blockSizeSet: [4, 8, 16],
        },
      }),
    })
    const missing = evaluateReleaseGate({
      significance: healthySignificance({
        fdrDiagnostics: {
          method: 'spa',
          bootstrapDirectionStable: null,
          unstableBootstrapCandidateIndexes: null,
          blockSizeSet: [4, 8, 16],
        },
      }),
    })

    const unstableCheck = unstable.checks.find((item) => item.name === 'significance')
    expect(unstable.failedChecks).toContain('significance')
    expect(unstableCheck?.metrics.spaBootstrapStatus).toBe('fail')
    expect(unstableCheck?.metrics.spaUnstableBootstrapCandidateIndexes).toBe('2')
    expect(unstableCheck?.metrics.spaBlockSizeSet).toBe('4,8,16')
    expect(missing.failedChecks).toContain('significance')
    expect(missing.checks.find((item) => item.name === 'significance')?.metrics.spaBootstrapStatus).toBe('missing')
  })

  it('hard-fails significance when FDR is present without a complete raw trial ledger', () => {
    const missingLedger = evaluateReleaseGate({
      significance: healthySignificance({ trialLedger: null }),
    })
    const incompleteRawM = evaluateReleaseGate({
      significance: healthySignificance({
        trialLedger: {
          rawM: 20,
          effectiveM: 12,
          rawMComplete: false,
          includesFailedTrials: true,
          failedTrialCount: 8,
          survivingTrialCount: 12,
          fdrMethodPrimary: 'BY_raw_m',
        },
      }),
    })
    const missingFailedTrials = evaluateReleaseGate({
      significance: healthySignificance({
        trialLedger: {
          rawM: 20,
          effectiveM: 12,
          rawMComplete: true,
          includesFailedTrials: false,
          failedTrialCount: 0,
          survivingTrialCount: 12,
          fdrMethodPrimary: 'BY_raw_m',
        },
      }),
    })
    const bhPrimary = evaluateReleaseGate({
      significance: healthySignificance({
        trialLedger: {
          rawM: 20,
          effectiveM: 12,
          rawMComplete: true,
          includesFailedTrials: true,
          failedTrialCount: 8,
          survivingTrialCount: 12,
          fdrMethodPrimary: 'BH_secondary',
        },
      }),
    })

    expect(missingLedger.failedChecks).toContain('significance')
    expect(missingLedger.checks.find((item) => item.name === 'significance')?.metrics.trialLedgerBlocks).toBe('trial_ledger_missing')
    expect(incompleteRawM.failedChecks).toContain('significance')
    expect(incompleteRawM.checks.find((item) => item.name === 'significance')?.metrics.trialLedgerBlocks).toContain('trial_ledger_raw_m_incomplete')
    expect(missingFailedTrials.failedChecks).toContain('significance')
    expect(missingFailedTrials.checks.find((item) => item.name === 'significance')?.metrics.trialLedgerBlocks).toContain('trial_ledger_missing_failed_trials')
    expect(bhPrimary.failedChecks).toContain('significance')
    expect(bhPrimary.checks.find((item) => item.name === 'significance')?.metrics.trialLedgerBlocks).toContain('trial_ledger_primary_fdr_not_by_raw_m')
  })

  it('blocks paper/live when risk simulation gate fails', () => {
    const result = evaluateReleaseGate({
      riskSimulation: {
        method: 'moving_block_bootstrap',
        simulations: 1000,
        horizonBars: 240,
        ruinDrawdownPct: 30,
        maxRuinProbability: 0.02,
        minProfitProbability: 0.7,
        confidenceLevel: 0.95,
        profitProbability: 0.55,
        riskOfRuin: 0.12,
        expectedFinalReturnPct: 3,
        medianFinalReturnPct: 2.5,
        confidenceInterval: {
          finalReturnPct: [-20, 25],
          maxDrawdownPct: [10, 40],
        },
        gatePassed: false,
      },
    })

    expect(result.allowPaperTrading).toBe(false)
    expect(result.allowLiveTrading).toBe(false)
    expect(result.failedChecks).toContain('risk_simulation')
  })

  it('blocks paper/live when economics gate shows no net edge after cost', () => {
    const result = evaluateReleaseGate({
      economics: {
        grossExpectancyPct: 0.12,
        netExpectancyPct: -0.03,
        feeExpectancyDragPct: 0.04,
        slippageExpectancyDragPct: 0.05,
        fundingExpectancyDragPct: 0.06,
        totalCostsPaid: 1200,
        costDragPctOfInitialCapital: 18,
        averageHoldingHours: 2,
        medianHoldingHours: 1.5,
        tradeCount: 42,
      },
    })

    expect(result.allowPaperTrading).toBe(false)
    expect(result.allowLiveTrading).toBe(false)
    expect(result.failedChecks).toContain('economics')
  })

  it('warns when economics pass but average holding time is below threshold', () => {
    const result = evaluateReleaseGate({
      significance: healthySignificance(),
      economics: {
        grossExpectancyPct: 0.4,
        netExpectancyPct: 0.18,
        feeExpectancyDragPct: 0.08,
        slippageExpectancyDragPct: 0.07,
        fundingExpectancyDragPct: 0.04,
        totalCostsPaid: 250,
        costDragPctOfInitialCapital: 4,
        averageHoldingHours: 2,
        medianHoldingHours: 1.5,
        tradeCount: 18,
      },
      executionQuality: {
        action: 'monitor',
        consecutiveBreaches: 0,
        requiredConsecutiveDays: 3,
        breachedDates: [],
        latestDriftMultiplier: 1.05,
      },
      rampUp: {
        decision: 'promote',
        reason: 'promotion_ready',
        currentStage: { allocationPct: 5 },
        targetStage: { allocationPct: 10 },
        drawdownBreached: false,
      },
      regimeShift: {
        triggered: false,
        severity: 'none',
      },
    })

    expect(result.failedChecks).not.toContain('economics')
    expect(result.warningChecks).toContain('economics')
    expect(result.allowPaperTrading).toBe(true)
    expect(result.allowLiveTrading).toBe(true)
  })

  it('blocks live when a required live-only check is skipped', () => {
    const result = evaluateReleaseGate({
      wfo: {
        overallPassed: true,
        failedWindows: 0,
        windows: [],
      },
      significance: healthySignificance(),
      economics: {
        grossExpectancyPct: 0.4,
        netExpectancyPct: 0.18,
        feeExpectancyDragPct: 0.08,
        slippageExpectancyDragPct: 0.07,
        fundingExpectancyDragPct: 0.04,
        totalCostsPaid: 250,
        costDragPctOfInitialCapital: 4,
        averageHoldingHours: 8,
        medianHoldingHours: 6,
        tradeCount: 18,
      },
    })

    expect(result.allowPaperTrading).toBe(true)
    expect(result.allowLiveTrading).toBe(false)
    expect(result.failedChecks).toEqual([])
    expect(result.checks.find(check => check.name === 'execution_quality')?.status).toBe('skipped')
    expect(result.checks.find(check => check.name === 'ramp_up')?.status).toBe('skipped')
    expect(result.checks.find(check => check.name === 'regime_shift')?.status).toBe('skipped')
  })

  it('allows paper but blocks live when execution quality trips', () => {
    const result = evaluateReleaseGate({
      wfo: {
        overallPassed: true,
        failedWindows: 0,
        windows: [],
      },
      significance: healthySignificance(),
      executionQuality: {
        action: 'reduce_or_pause',
        consecutiveBreaches: 3,
        requiredConsecutiveDays: 3,
        breachedDates: ['2026-02-01', '2026-02-02', '2026-02-03'],
        latestDriftMultiplier: 2.5,
      },
    })

    expect(result.allowPaperTrading).toBe(true)
    expect(result.allowLiveTrading).toBe(false)
    expect(result.failedChecks).toContain('execution_quality')
  })

  it('blocks live on high regime-shift signal', () => {
    const result = evaluateReleaseGate({
      regimeShift: {
        triggered: true,
        severity: 'high',
        reason: 'volatility regime break',
      },
    })

    expect(result.allowLiveTrading).toBe(false)
    expect(result.failedChecks).toContain('regime_shift')
  })

  it('blocks paper/live when cross-asset strategy evidence is inconsistent', () => {
    const result = evaluateReleaseGate({
      strategyPlanEvidence: {
        crossAssetRegimeConsistency: {
          available: true,
          result: {
            consistent: false,
            highConfidenceCount: 2,
            disagreementCount: 1,
            anchorDisagreement: true,
            reasons: ['BTC and ETH regimes disagree'],
          },
        },
      },
    })

    const check = result.checks.find((item) => item.name === 'strategy_plan_evidence')
    expect(check?.status).toBe('fail')
    expect(check?.metrics.failures).toContain('cross_asset_regime_inconsistent')
    expect(result.allowPaperTrading).toBe(false)
    expect(result.allowLiveTrading).toBe(false)
    expect(result.failedChecks).toContain('strategy_plan_evidence')
  })

  it('blocks paper/live when a runtime-accepted alpha fails admission', () => {
    const result = evaluateReleaseGate({
      strategyPlanEvidence: {
        alphaFactorAdmission: {
          available: true,
          totalCandidates: 3,
          acceptedCount: 1,
          admissionGatePassedCount: 2,
          admissionGateFailedCount: 1,
          runtimeAcceptedAdmissionGateFailedCount: 1,
        },
      },
    })

    const check = result.checks.find((item) => item.name === 'strategy_plan_evidence')
    expect(check?.status).toBe('fail')
    expect(check?.metrics.failures).toContain('runtime_accepted_alpha_failed_admission')
    expect(result.failedChecks).toContain('strategy_plan_evidence')
    expect(result.allowPaperTrading).toBe(false)
  })

  it('warns without hard-failing when optional strategy-plan evidence is unavailable', () => {
    const result = evaluateReleaseGate({
      significance: healthySignificance(),
      strategyPlanEvidence: {
        alphaFactorAdmission: {
          available: false,
          totalCandidates: 0,
          acceptedCount: 0,
          admissionGatePassedCount: 0,
          admissionGateFailedCount: 0,
          runtimeAcceptedAdmissionGateFailedCount: 0,
          reason: 'alpha pool artifact missing',
        },
        stableCorrelationClustering: {
          available: false,
          clusters: [],
          reason: 'single-symbol validation',
        },
      },
    })

    const check = result.checks.find((item) => item.name === 'strategy_plan_evidence')
    expect(check?.status).toBe('warn')
    expect(check?.metrics.advisories).toContain('alpha_factor_admission_unavailable')
    expect(check?.metrics.advisories).toContain('stable_correlation_clustering_unavailable')
    expect(result.hardFail).toBe(false)
    expect(result.allowPaperTrading).toBe(true)
    expect(result.warningChecks).toContain('strategy_plan_evidence')
  })

  it('blocks paper/live when a required rolling-Sharpe universe is empty', () => {
    const result = evaluateReleaseGate({
      strategyPlanEvidence: {
        rollingSharpeUniverseSelection: {
          available: true,
          required: true,
          selection: {
            longSymbols: [],
            shortSymbols: [],
            scores: [{ symbol: 'BTC/USD' }],
          },
        },
      },
    })

    const check = result.checks.find((item) => item.name === 'strategy_plan_evidence')
    expect(check?.status).toBe('fail')
    expect(check?.metrics.failures).toContain('required_rolling_sharpe_universe_empty')
    expect(result.failedChecks).toContain('strategy_plan_evidence')
    expect(result.allowPaperTrading).toBe(false)
  })

  it('marks insufficient ramp sample as warning rather than failure', () => {
    const ramp: RampUpEvaluation = {
      decision: 'stay',
      reason: 'insufficient_sample',
      currentStage: { allocationPct: 5 },
      targetStage: { allocationPct: 5 },
      drawdownBreached: false,
    }

    const result = evaluateReleaseGate({
      significance: healthySignificance(),
      rampUp: ramp,
    })
    const rampCheck = result.checks.find((check) => check.name === 'ramp_up')

    expect(rampCheck?.status).toBe('warn')
    expect(result.hardFail).toBe(false)
    expect(result.warningChecks).toContain('ramp_up')
  })
})
