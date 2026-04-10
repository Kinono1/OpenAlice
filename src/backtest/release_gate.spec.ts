import { describe, expect, it } from 'vitest'
import { evaluateReleaseGate, type RampUpEvaluation } from './release_gate.js'

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
      significance: {
        passed: true,
        pboResult: {
          pbo: 0.1,
          logits: [1, 2, 3],
          splitsEvaluated: 3,
          partitions: 8,
        },
        dsrResult: {
          observedSharpe: 1.4,
          benchmarkSharpe: 0.7,
          dsrValue: 0.7,
          dsrProbability: 0.88,
          skewness: 0.1,
          kurtosis: 3.1,
          trialCount: 5,
        },
        pboThreshold: 0.2,
        dsrMin: 0,
      },
      executionQuality: {
        action: 'monitor',
        consecutiveBreaches: 0,
        requiredConsecutiveDays: 3,
        breachedDates: [],
        latestDriftMultiplier: 1.1,
      },
      rampUp: ramp,
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
      },
    })

    expect(result.allowPaperTrading).toBe(false)
    expect(result.allowLiveTrading).toBe(false)
    expect(result.failedChecks).toContain('significance')
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
    })

    expect(result.failedChecks).not.toContain('economics')
    expect(result.warningChecks).toContain('economics')
    expect(result.allowPaperTrading).toBe(true)
    expect(result.allowLiveTrading).toBe(true)
  })

  it('allows paper but blocks live when execution quality trips', () => {
    const result = evaluateReleaseGate({
      wfo: {
        overallPassed: true,
        failedWindows: 0,
        windows: [],
      },
      significance: {
        passed: true,
        pboResult: {
          pbo: 0.05,
          logits: [1, 1],
          splitsEvaluated: 2,
          partitions: 8,
        },
        dsrResult: {
          observedSharpe: 1.0,
          benchmarkSharpe: 0.2,
          dsrValue: 0.8,
          dsrProbability: 0.9,
          skewness: 0,
          kurtosis: 3,
          trialCount: 2,
        },
        pboThreshold: 0.2,
        dsrMin: 0,
      },
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

  it('marks insufficient ramp sample as warning rather than failure', () => {
    const ramp: RampUpEvaluation = {
      decision: 'stay',
      reason: 'insufficient_sample',
      currentStage: { allocationPct: 5 },
      targetStage: { allocationPct: 5 },
      drawdownBreached: false,
    }

    const result = evaluateReleaseGate({ rampUp: ramp })
    const rampCheck = result.checks.find((check) => check.name === 'ramp_up')

    expect(rampCheck?.status).toBe('warn')
    expect(result.hardFail).toBe(false)
    expect(result.warningChecks).toContain('ramp_up')
  })
})
