import { describe, expect, it } from 'vitest'
import {
  buildCrossSectionalReleaseGateStatus,
  parseCrossSectionalReleaseGateArgs,
} from './publish_cross_sectional_release_gate_status.js'

describe('publish_cross_sectional_release_gate_status', () => {
  it('parses live-fwd24 defaults for the current cross-sectional strategy lane', () => {
    expect(parseCrossSectionalReleaseGateArgs([
      '--rankIc',
      'rank_ic.json',
      '--routeCost',
      'route_cost.json',
      '--bestConfig',
      'best_config.json',
      '--output',
      'null',
      '--route',
      'passive_passive',
      '--expiresInHours',
      '6',
      '--json',
      'true',
    ])).toEqual({
      rankIcReportPath: 'rank_ic.json',
      routeCostValidationPath: 'route_cost.json',
      bestConfigPath: 'best_config.json',
      outputPath: null,
      selectedRoute: 'passive_passive',
      expiresInHours: 6,
      json: true,
    })
  })

  it('fails closed for current-style live RankIC WFO failure and negative route-cost economics', () => {
    const result = buildCrossSectionalReleaseGateStatus({
      generatedAt: '2026-05-04T22:00:00.000Z',
      expiresInHours: 24,
      selectedRoute: 'passive_passive',
      rankIcReportPath: '/repo/data/research/cross_sectional_rank_ic.live_accumulated_fwd24.latest.json',
      routeCostValidationPath: '/repo/data/research/rank_ic_route_cost_validation.live_accumulated_fwd24.latest.json',
      bestConfigPath: '/repo/data/research/best_config.json',
      rankIcReport: {
        generatedAt: '2026-05-04T22:52:30.665Z',
        dataDir: '/repo/data/market/live_accumulated',
        commonPeriods: 389,
        configsEvaluated: 80,
        best: {
          factor: 'raw_reversal',
          lookbackHours: 336,
          secondaryLookbackHours: 336,
          forwardHours: 24,
          mtfWeight: 0,
          observations: 1666,
          periods: 50,
          meanIc: 0.063917,
          icIr: 0.310493,
          signalPeriods: 50,
          averageLongShortSpreadPct: 0.234009,
        },
        topConfigs: [{}, {}, {}],
        wfo: {
          status: 'fail',
          selectionSource: 'best_config_match',
          testedConfig: {
            factor: 'raw_reversal',
            lookbackHours: 336,
            secondaryLookbackHours: 336,
            forwardHours: 24,
            mtfWeight: 0.5,
          },
          windowCount: 5,
          passedWindows: 2,
          failedWindows: 3,
          failedWindowRatio: 0.6,
          failWindowRatioThreshold: 0.3,
          directionStable: false,
          blockers: [
            'wfo_failed_window_ratio:0.6>0.3',
            'wfo_direction_not_stable',
          ],
        },
      },
      routeCostValidation: {
        generatedAt: '2026-05-04T22:52:39.536Z',
        routeCostValidationStatus: 'negative_after_cost',
        feeSnapshot: {
          source: 'manual_override',
          verifiedByRuntime: false,
          stale: false,
          expiresAt: '2026-05-05T22:47:04.216Z',
        },
        candidate: {
          lookbackHours: 336,
          secondaryLookbackHours: 336,
          forwardHours: 24,
          mtfWeight: 0.5,
        },
        routes: [{
          route: 'passive_passive',
          grossLongShortSpreadPct: 0.234009,
          netAfterRouteCostPct: -0.125991,
          pairRoundTripCostPct: 0.36,
          pairRoundTripCostBps: 36,
          totalExpectedCostBpsPerLegRoundTrip: 18,
          maxAllowedCostBpsPerLeg: 20,
          grossToPairCostRatio: 0.650025,
          routeBudgetExceeded: false,
          positiveAfterCost: false,
          blockers: ['route_net_edge_non_positive:passive_passive'],
        }],
      },
      bestConfig: {
        config: {
          lookbackHours: 336,
          secondaryLookback: 336,
          forwardHours: 24,
          mtfWeight: 0.5,
        },
      },
    })

    expect(result.expiresAt).toBe('2026-05-05T22:00:00.000Z')
    expect(result.releaseGate).toMatchObject({
      allowPaperTrading: false,
      allowLiveTrading: false,
      failedChecks: expect.arrayContaining([
        'wfo',
        'significance',
        'risk_simulation',
        'economics',
      ]),
      warningChecks: ['strategy_plan_evidence'],
    })
    expect(result.releaseGate.checks.find(check => check.name === 'wfo')).toMatchObject({
      status: 'fail',
      metrics: {
        status: 'fail',
        failedWindowRatio: 0.6,
        directionStable: false,
      },
    })
    expect(result.releaseGate.checks.find(check => check.name === 'economics')).toMatchObject({
      status: 'fail',
      metrics: {
        selectedRoute: 'passive_passive',
        netExpectancyPct: -0.125991,
        positiveAfterCost: false,
        feeSnapshotSource: 'manual_override',
        feeSnapshotVerifiedByRuntime: false,
      },
    })
    expect(result.releaseGate.checks.find(check => check.name === 'strategy_plan_evidence')).toMatchObject({
      status: 'warn',
      metrics: {
        rankIcWfoSelectionSource: 'best_config_match',
        failures: null,
      },
    })
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'release_gate_wfo_failed',
      'release_gate_significance_failed',
      'release_gate_risk_simulation_failed',
      'release_gate_economics_failed',
    ]))
  })

  it('keeps paper blocked even when diagnostic route economics are positive without promotion-grade FDR and risk simulation', () => {
    const result = buildCrossSectionalReleaseGateStatus({
      generatedAt: '2026-05-04T22:00:00.000Z',
      rankIcReportPath: '/repo/rank_ic.json',
      routeCostValidationPath: '/repo/route_cost.json',
      bestConfigPath: '/repo/best_config.json',
      rankIcReport: {
        generatedAt: '2026-05-04T22:00:00.000Z',
        dataDir: '/repo/data/market/live_accumulated',
        commonPeriods: 1200,
        configsEvaluated: 12,
        best: {
          factor: 'raw_reversal',
          lookbackHours: 336,
          secondaryLookbackHours: 336,
          forwardHours: 24,
          mtfWeight: 0.5,
          meanIc: 0.12,
          icIr: 1.5,
          periods: 60,
          signalPeriods: 60,
          averageLongShortSpreadPct: 0.9,
        },
        topConfigs: new Array(20).fill({}),
        wfo: {
          status: 'pass',
          windowCount: 5,
          passedWindows: 5,
          failedWindows: 0,
          failedWindowRatio: 0,
          failWindowRatioThreshold: 0.3,
          directionStable: true,
          blockers: [],
        },
      },
      routeCostValidation: {
        routeCostValidationStatus: 'positive_after_cost_diagnostic',
        feeSnapshot: {
          source: 'runtime',
          verifiedByRuntime: true,
          stale: false,
        },
        candidate: {
          lookbackHours: 336,
          secondaryLookbackHours: 336,
          forwardHours: 24,
          mtfWeight: 0.5,
        },
        routes: [{
          route: 'passive_passive',
          grossLongShortSpreadPct: 0.9,
          netAfterRouteCostPct: 0.54,
          pairRoundTripCostPct: 0.36,
          pairRoundTripCostBps: 36,
          totalExpectedCostBpsPerLegRoundTrip: 18,
          maxAllowedCostBpsPerLeg: 20,
          grossToPairCostRatio: 2.5,
          routeBudgetExceeded: false,
          positiveAfterCost: true,
          blockers: [],
        }],
      },
      bestConfig: {
        config: {
          lookbackHours: 336,
          secondaryLookback: 336,
          forwardHours: 24,
          mtfWeight: 0.5,
        },
      },
    })

    expect(result.releaseGate.checks.find(check => check.name === 'wfo')?.status).toBe('pass')
    expect(result.releaseGate.checks.find(check => check.name === 'economics')?.status).toBe('pass')
    expect(result.releaseGate.checks.find(check => check.name === 'strategy_plan_evidence')?.status).toBe('warn')
    expect(result.releaseGate).toMatchObject({
      allowPaperTrading: false,
      allowLiveTrading: false,
      failedChecks: ['significance', 'risk_simulation'],
      warningChecks: ['strategy_plan_evidence'],
    })
  })

  it('fails closed when all evidence inputs are missing', () => {
    const result = buildCrossSectionalReleaseGateStatus({
      generatedAt: '2026-05-04T22:00:00.000Z',
      rankIcReportPath: '/repo/missing-rank.json',
      routeCostValidationPath: '/repo/missing-route.json',
      bestConfigPath: '/repo/missing-best.json',
      rankIcReport: null,
      routeCostValidation: null,
      bestConfig: null,
    })

    expect(result.releaseGate.allowPaperTrading).toBe(false)
    expect(result.releaseGate.failedChecks).toEqual([
      'wfo',
      'significance',
      'risk_simulation',
      'economics',
      'strategy_plan_evidence',
    ])
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'rank_ic_report_missing',
      'route_cost_validation_missing',
      'best_config_missing',
      'route_missing:passive_passive',
    ]))
  })

  it('fails closed when optimizer produced no passing best_config', () => {
    const result = buildCrossSectionalReleaseGateStatus({
      generatedAt: '2026-05-05T00:00:00.000Z',
      rankIcReportPath: '/repo/rank_ic.json',
      routeCostValidationPath: '/repo/route_cost.json',
      bestConfigPath: '/repo/best_config.json',
      rankIcReport: {
        generatedAt: '2026-05-05T00:00:00.000Z',
        dataDir: '/repo/data/market/live_accumulated',
        commonPeriods: 413,
        configsEvaluated: 80,
        best: null,
        topConfigs: [],
        wfo: {
          status: 'insufficient_data',
          blockers: ['wfo_config_missing'],
        },
      },
      routeCostValidation: {
        routeCostValidationStatus: 'insufficient_data',
        routes: [],
      },
      bestConfig: {
        status: 'no_passing_config',
        selectedConfig: false,
        config: null,
        hardGatePassedCount: 0,
        noPassingConfigReason: 'optimizer_hard_gate_passed_count_zero',
      },
    })

    expect(result.releaseGate.allowPaperTrading).toBe(false)
    expect(result.releaseGate.failedChecks).toEqual(expect.arrayContaining([
      'wfo',
      'significance',
      'risk_simulation',
      'economics',
      'strategy_plan_evidence',
    ]))
    expect(result.releaseGate.checks.find(check => check.name === 'strategy_plan_evidence')).toMatchObject({
      status: 'fail',
      metrics: {
        failures: 'best_config_missing_or_no_passing_config',
        bestConfigStatus: 'no_passing_config',
        bestConfigSelected: false,
        bestConfigHardGatePassedCount: 0,
      },
    })
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'best_config_no_passing_config',
    ]))
  })
})
