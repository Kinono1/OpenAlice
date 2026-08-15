import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildResearchCandidateSummaryReport,
  parseResearchCandidateSummaryArgs,
  runResearchCandidateSummary,
} from './summarize_research_candidates.js'

describe('summarize_research_candidates', () => {
  it('parses safe research-only defaults', () => {
    expect(parseResearchCandidateSummaryArgs([])).toEqual({
      researchRoot: 'data/research',
      outputPath: 'data/research/candidate_ranking.latest.json',
      maxCandidates: 40,
      json: false,
    })
    expect(parseResearchCandidateSummaryArgs([
      '--root',
      'tmp/research',
      '--output',
      'null',
      '--maxCandidates',
      '3',
      '--json',
      'true',
    ])).toEqual({
      researchRoot: 'tmp/research',
      outputPath: null,
      maxCandidates: 3,
      json: true,
    })
  })

  it('ranks candidates without authorizing paper or live execution', () => {
    const report = buildResearchCandidateSummaryReport({
      sourceRoot: '/repo/data/research',
      generatedAt: '2026-05-04T00:00:00.000Z',
      maxCandidates: 5,
      files: [
        {
          path: '/repo/data/research/standalone_eth_carry/run/eth_carry.validation.json',
          value: {
            generatedAt: '2026-05-03T00:00:00.000Z',
            input: {
              family: 'eth_carry',
              strategy: 'enhancedCarry',
              symbol: 'ETH-USDT',
            },
            selectedParams: { id: 'carry_24h_z13' },
            selectedMetrics: {
              totalReturnPct: -0.0959,
              grossExpectancyPct: -0.0008,
              netExpectancyPct: -0.008,
              tradeCount: 12,
              sharpe: -4.4,
              maxDrawdownPct: 0.12,
            },
            wfo: { overallPassed: false },
            significance: {
              passed: false,
              pboResult: { pbo: 0.6 },
              dsrResult: { dsrProbability: 0.0037 },
              fdrQ: null,
            },
            riskSimulation: { profitProbability: 0.035, riskOfRuin: 0, gatePassed: false },
            releaseGate: {
              allowPaperTrading: false,
              allowLiveTrading: false,
              failedChecks: ['wfo', 'significance', 'economics'],
              checks: [
                { name: 'wfo', status: 'fail', metrics: { overallPassed: false } },
                { name: 'significance', status: 'fail', metrics: {} },
                { name: 'risk_simulation', status: 'fail', metrics: {} },
              ],
            },
          },
        },
        {
          path: '/repo/data/research/optimization/sweep_1.json',
          value: {
            generatedAt: '2026-05-04T00:00:00.000Z',
            topConfigs: [{
              lookbackHours: 120,
              forwardHours: 12,
              mtfWeight: 0.25,
              signals: 3225,
              winRate: 50.88,
              spreadCum: 406.24,
              avgSpread: 0.126,
              sharpeApprox: 56.78,
            }],
          },
        },
      ],
    })

    expect(report).toMatchObject({
      generatedAt: '2026-05-04T00:00:00.000Z',
      researchOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      sourceFilesScanned: 2,
      counts: {
        blockedTradableRows: 2,
        positiveNetExpectancyRows: 1,
      },
    })
    expect(report.topCandidates[0]).toMatchObject({
      evidenceTier: 'optimization_prevalidation',
      status: 'prevalidation_only',
      family: 'cross_sectional_optimization',
      whyNotTradable: expect.arrayContaining([
        'not_release_validated',
        'release_gate_missing',
      ]),
    })
    expect(report.topCandidates.find(row => row.family === 'eth_carry')).toMatchObject({
      status: 'research_only_blocked',
      whyNotTradable: expect.arrayContaining([
        'release_gate_blocks_paper',
        'failed_check:wfo',
        'wfo_failed',
        'net_expectancy_non_positive',
      ]),
    })
  })

  it('pulls RankIC money-smell reports into the research funnel without making them tradable', () => {
    const report = buildResearchCandidateSummaryReport({
      sourceRoot: '/repo/data/research',
      generatedAt: '2026-05-04T00:00:00.000Z',
      maxCandidates: 5,
      files: [{
        path: '/repo/data/research/cross_sectional_rank_ic.latest.json',
        value: {
          schemaVersion: 1,
          generatedAt: '2026-05-04T00:00:00.000Z',
          researchOnly: true,
          promotionEligible: false,
          dataDir: '/repo/data/market/live_accumulated',
          commonPeriods: 396,
          blockers: [
            'common_periods_low:396<1000',
            'not_promotion_grade_wfo_validated',
            'not_route_cost_validated',
          ],
          wfo: {
            status: 'insufficient_data',
            windowCount: 2,
            passedWindows: 1,
            failedWindows: 1,
            failedWindowRatio: 0.5,
            failWindowRatioThreshold: 0.3,
            minWindows: 3,
            minTotalPeriods: 30,
            minTotalSignalPeriods: 30,
            blockers: [
              'wfo_windows_low:2<3',
              'wfo_failed_window_ratio:0.5>0.3',
              'wfo_total_signal_periods_low:10<30',
            ],
          },
          best: {
            periods: 10,
            signalPeriods: 10,
          },
          topConfigs: [{
            lookbackHours: 336,
            secondaryLookbackHours: 336,
            forwardHours: 48,
            mtfWeight: 0,
            factor: 'raw_reversal',
            observations: 340,
            periods: 10,
            meanIc: 0.295126,
            icIr: 2.460112,
            winRate: 1,
            passed: true,
            averageLongShortSpreadPct: 4.766253,
            longShortWinRate: 0.4,
            signalPeriods: 10,
          }],
        },
      }],
    })

    expect(report).toMatchObject({
      researchOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      candidateRowsFound: 1,
    })
    expect(report.topCandidates[0]).toMatchObject({
      sourceKind: 'cross_sectional_rank_ic',
      evidenceTier: 'diagnostic_validation',
      status: 'diagnostic_only',
      family: 'cross_sectional_rank_ic',
      strategy: 'raw_reversal',
      metrics: {
        meanIc: 0.295126,
        icIr: 2.460112,
        commonPeriods: 396,
        signalPeriods: 10,
        longShortWinRatePct: 40,
        rankIcWfoStatus: 'insufficient_data',
        rankIcWfoFailedWindowRatio: 0.5,
        rankIcWfoWindowCount: 2,
        rankIcWfoPassedWindows: 1,
      },
      whyNotTradable: expect.arrayContaining([
        'not_promotion_grade_wfo_validated',
        'not_release_validated',
        'release_gate_missing',
        'rank_ic_common_periods_low:396<1000',
        'rank_ic_signal_periods_low:10<30',
        'rank_ic_long_short_win_rate_low:40<50',
        'rank_ic_wfo_status:insufficient_data',
        'rank_ic_wfo_windows_low:2<3',
        'rank_ic_wfo_failed_window_ratio:0.5>0.3',
        'rank_ic_wfo_total_signal_periods_low:10<30',
      ]),
      nextAction: expect.stringContaining('money-smell'),
    })
    expect(report.focusRecommendations[0]).toContain('First money-focused experiment: validate current RankIC money-smell')
  })

  it('pulls RankIC route-cost diagnostics into the funnel without treating net-positive diagnostics as executable', () => {
    const report = buildResearchCandidateSummaryReport({
      sourceRoot: '/repo/data/research',
      generatedAt: '2026-05-04T00:00:00.000Z',
      maxCandidates: 5,
      files: [{
        path: '/repo/data/research/rank_ic_route_cost_validation.latest.json',
        value: {
          schemaVersion: 1,
          generatedAt: '2026-05-04T12:58:22.831Z',
          researchOnly: true,
          promotionEligible: false,
          paperTradingAllowed: false,
          liveTradingAllowed: false,
          routeCostValidationStatus: 'insufficient_data',
          candidate: {
            candidateId: 'rank_ic_raw_reversal_best_lb336_sec336_fwd48_mtf0',
            factor: 'raw_reversal',
            observations: 176,
            periods: 10,
            signalPeriods: 10,
            commonPeriods: 396,
            meanIc: 0.504167,
            icIr: 2.11975,
            wfoStatus: 'insufficient_data',
            averageLongShortSpreadPct: 5.68661,
          },
          feeSnapshot: {
            source: 'manual_override',
            verifiedByRuntime: false,
            stale: true,
          },
          bestDiagnosticRoute: {
            route: 'passive_passive',
            grossLongShortSpreadPct: 5.68661,
            pairRoundTripCostPct: 0.36,
            netAfterRouteCostPct: 5.32661,
            grossToPairCostRatio: 15.796139,
          },
          blockers: [
            'rank_ic_common_periods_low:396<1000',
            'rank_ic_signal_periods_low:10<30',
            'rank_ic_wfo_status:insufficient_data',
            'fee_snapshot_stale',
            'fee_snapshot_manual_override',
            'fee_snapshot_not_runtime_verified',
            'not_promotion_grade_route_cost_validated',
            'not_trial_ledger_fdr_validated',
            'not_paper_execution_evidence',
          ],
        },
      }],
    })

    expect(report).toMatchObject({
      researchOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      candidateRowsFound: 1,
    })
    expect(report.topCandidates[0]).toMatchObject({
      sourceKind: 'cross_sectional_rank_ic_route_cost',
      evidenceTier: 'diagnostic_validation',
      status: 'diagnostic_only',
      family: 'cross_sectional_rank_ic_route_cost',
      metrics: {
        netExpectancyPct: 5.32661,
        grossExpectancyPct: 5.68661,
        netAfterRouteCostPct: 5.32661,
        grossToPairCostRatio: 15.796139,
        pairRoundTripCostPct: 0.36,
        bestRoute: 'passive_passive',
        feeSnapshotSource: 'manual_override',
        feeSnapshotStale: true,
        feeSnapshotVerifiedByRuntime: false,
      },
      whyNotTradable: expect.arrayContaining([
        'not_release_validated',
        'release_gate_missing',
        'rank_ic_common_periods_low:396<1000',
        'rank_ic_signal_periods_low:10<30',
        'rank_ic_wfo_status:insufficient_data',
        'fee_snapshot_stale',
        'fee_snapshot_manual_override',
        'fee_snapshot_not_runtime_verified',
        'not_promotion_grade_route_cost_validated',
        'not_trial_ledger_fdr_validated',
        'not_paper_execution_evidence',
      ]),
      nextAction: expect.stringContaining('route-cost diagnostic only'),
    })
    expect(report.focusRecommendations.some(item => item.includes('Route-cost diagnostic'))).toBe(true)
  })

  it('pulls liquidity-conditioned factor pivots into the funnel without treating them as executable', () => {
    const report = buildResearchCandidateSummaryReport({
      sourceRoot: '/repo/data/research',
      generatedAt: '2026-05-05T06:20:00.000Z',
      maxCandidates: 5,
      files: [{
        path: '/repo/data/research/liquidity_conditioned_factor_report.live_accumulated.latest.json',
        value: {
          schemaVersion: 1,
          generatedAt: '2026-05-05T06:16:30.263Z',
          researchOnly: true,
          promotionEligible: false,
          paperTradingAllowed: false,
          liveTradingAllowed: false,
          dataDir: '/repo/data/market/live_accumulated',
          commonPeriods: 1200,
          hypothesis: {
            id: 'liquidity_conditioned_momentum_reversal_v1',
          },
          routeCost: {
            source: 'manual_diagnostic_override',
            runtimeVerified: false,
            pairRoundTripCostPct: 0.36,
          },
          blockers: [
            'best_candidate_not_promising:incubate_observation',
            'best_wfo_fail',
            'runtime_fee_not_verified',
          ],
          topConfigs: [{
            configId: 'liq_high_reversal_lb168_fwd72',
            liquidityBucket: 'high',
            factor: 'reversal',
            lookbackHours: 168,
            forwardHours: 72,
            observations: 11508,
            periods: 959,
            signalPeriods: 959,
            meanIc: 0.04925,
            icIr: 0.144898,
            winRate: 0.552659,
            averageLongShortSpreadPct: 2.95443,
            longShortWinRate: 0.596455,
            routeCostPct: 0.36,
            netAfterRouteCostPct: 2.59443,
            positiveAfterCost: true,
            candidateVerdict: 'incubate_observation',
            wfo: {
              status: 'fail',
              windowCount: 5,
              passedWindows: 2,
              failedWindows: 3,
              failedWindowRatio: 0.6,
            },
            blockers: [
              'ic_thresholds_not_passed',
              'wfo_fail',
              'wfo_failed_window_ratio:0.6>0.3',
              'route_cost_manual_not_runtime_verified',
            ],
          }],
        },
      }],
    })

    expect(report).toMatchObject({
      researchOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      candidateRowsFound: 1,
    })
    expect(report.topCandidates[0]).toMatchObject({
      sourceKind: 'liquidity_conditioned_factor',
      evidenceTier: 'diagnostic_validation',
      status: 'diagnostic_only',
      family: 'liquidity_conditioned_factor',
      strategy: 'high_reversal',
      candidateId: 'liq_high_reversal_lb168_fwd72',
      metrics: {
        netExpectancyPct: 2.59443,
        grossExpectancyPct: 2.95443,
        meanIc: 0.04925,
        icIr: 0.144898,
        signalPeriods: 959,
        commonPeriods: 1200,
        netAfterRouteCostPct: 2.59443,
        pairRoundTripCostPct: 0.36,
        feeSnapshotSource: 'manual_diagnostic_override',
        feeSnapshotVerifiedByRuntime: false,
        rankIcWfoStatus: 'fail',
        rankIcWfoFailedWindowRatio: 0.6,
      },
      whyNotTradable: expect.arrayContaining([
        'not_release_validated',
        'release_gate_missing',
        'rank_ic_ir_low:0.144898<1',
        'rank_ic_wfo_status:fail',
        'rank_ic_wfo_failed_window_ratio:0.6>0.3',
        'route_cost_manual_not_runtime_verified',
        'fee_snapshot_not_runtime_verified',
        'liquidity_conditioned_verdict:incubate_observation',
      ]),
      nextAction: expect.stringContaining('route-cost diagnostic only'),
    })
    expect(report.focusRecommendations.some(item => item.includes('Liquidity-conditioned pivot candidate'))).toBe(true)
  })

  it('pulls base crypto factor-family diagnostics into the funnel without treating them as executable', () => {
    const report = buildResearchCandidateSummaryReport({
      sourceRoot: '/repo/data/research',
      generatedAt: '2026-05-05T08:25:00.000Z',
      maxCandidates: 5,
      files: [{
        path: '/repo/data/research/crypto_factor_family.live_accumulated.latest.json',
        value: {
          schemaVersion: 1,
          generatedAt: '2026-05-05T08:24:00.000Z',
          researchOnly: true,
          promotionEligible: false,
          paperTradingAllowed: false,
          liveTradingAllowed: false,
          dataDir: '/repo/data/market/live_accumulated',
          commonPeriods: 1200,
          hypothesis: {
            id: 'crypto_base_factor_family_v1',
          },
          routeCost: {
            source: 'manual_diagnostic_override',
            runtimeVerified: false,
            pairRoundTripCostPct: 0.36,
          },
          blockers: [
            'best_candidate_not_promising:incubate_observation',
            'best_wfo_fail',
            'runtime_fee_not_verified',
          ],
          topConfigs: [{
            candidateId: 'factor_reversal_lb168_fwd72',
            factor: 'reversal',
            lookbackHours: 168,
            forwardHours: 72,
            observations: 11508,
            periods: 959,
            signalPeriods: 959,
            meanIc: 0.021854,
            icIr: 0.090211,
            winRate: 0.517205,
            passedIc: false,
            averageLongShortSpreadPct: 0.597095,
            longShortWinRate: 0.562044,
            routeCostPct: 0.36,
            netAfterRouteCostPct: 0.237095,
            candidateVerdict: 'incubate_observation',
            wfo: {
              status: 'fail',
              windowCount: 5,
              passedWindows: 2,
              failedWindows: 3,
              failedWindowRatio: 0.6,
            },
            blockers: [
              'ic_thresholds_not_passed',
              'wfo_fail',
              'wfo_failed_window_ratio:0.6>0.3',
              'route_cost_manual_not_runtime_verified',
            ],
          }],
        },
      }],
    })

    expect(report).toMatchObject({
      researchOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      candidateRowsFound: 1,
    })
    expect(report.topCandidates[0]).toMatchObject({
      sourceKind: 'crypto_factor_family',
      evidenceTier: 'diagnostic_validation',
      status: 'diagnostic_only',
      family: 'crypto_factor_family',
      strategy: 'reversal',
      candidateId: 'factor_reversal_lb168_fwd72',
      metrics: {
        netExpectancyPct: 0.237095,
        grossExpectancyPct: 0.597095,
        meanIc: 0.021854,
        icIr: 0.090211,
        signalPeriods: 959,
        commonPeriods: 1200,
        netAfterRouteCostPct: 0.237095,
        pairRoundTripCostPct: 0.36,
        feeSnapshotSource: 'manual_diagnostic_override',
        feeSnapshotVerifiedByRuntime: false,
        rankIcWfoStatus: 'fail',
        rankIcWfoFailedWindowRatio: 0.6,
      },
      whyNotTradable: expect.arrayContaining([
        'not_release_validated',
        'release_gate_missing',
        'rank_ic_ir_low:0.090211<1',
        'rank_ic_wfo_status:fail',
        'rank_ic_wfo_failed_window_ratio:0.6>0.3',
        'route_cost_validation_status:base_factor_not_promotion_grade',
        'route_cost_manual_not_runtime_verified',
        'fee_snapshot_not_runtime_verified',
        'crypto_factor_verdict:incubate_observation',
      ]),
      nextAction: expect.stringContaining('route-cost diagnostic only'),
    })
    expect(report.focusRecommendations.some(item => item.includes('Base crypto factor-family diagnostic'))).toBe(true)
  })

  it('discovers scoped live RankIC diagnostic filenames when scanning a research directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-research-candidates-'))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'cross_sectional_rank_ic.live_accumulated_fwd48.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-04T22:00:57.170Z',
      researchOnly: true,
      promotionEligible: false,
      dataDir: '/repo/data/market/live_accumulated',
      commonPeriods: 411,
      blockers: [
        'common_periods_low:411<1000',
        'not_promotion_grade_wfo_validated',
      ],
      wfo: {
        status: 'insufficient_data',
        windowCount: 5,
        passedWindows: 3,
        failedWindows: 2,
        failedWindowRatio: 0.4,
        blockers: [
          'wfo_total_periods_low:25<30',
          'wfo_direction_not_stable',
        ],
      },
      topConfigs: [{
        lookbackHours: 336,
        secondaryLookbackHours: 336,
        forwardHours: 48,
        mtfWeight: 0,
        factor: 'raw_reversal',
        observations: 841,
        periods: 25,
        meanIc: 0.15349,
        icIr: 0.90652,
        winRate: 0.68,
        passed: true,
        averageLongShortSpreadPct: 0.578821,
        longShortWinRate: 0.16,
        signalPeriods: 25,
      }, {
        lookbackHours: 336,
        secondaryLookbackHours: 336,
        forwardHours: 48,
        mtfWeight: 0,
        factor: 'risk_adjusted_reversal',
        observations: 841,
        periods: 25,
        meanIc: 0.2,
        icIr: 1.5,
        winRate: 1,
        passed: true,
        averageLongShortSpreadPct: 1.25,
        longShortWinRate: 0.75,
        signalPeriods: 25,
      }],
    }), 'utf-8')
    await writeFile(join(root, 'rank_ic_route_cost_validation.live_accumulated_fwd48.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-04T22:01:07.331Z',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      routeCostValidationStatus: 'insufficient_data',
      candidate: {
        candidateId: 'rank_ic_raw_reversal_best_lb336_sec336_fwd48_mtf0',
        factor: 'raw_reversal',
        observations: 841,
        periods: 25,
        signalPeriods: 25,
        commonPeriods: 411,
        meanIc: 0.15349,
        icIr: 0.90652,
        wfoStatus: 'insufficient_data',
        averageLongShortSpreadPct: 0.578821,
      },
      feeSnapshot: {
        source: 'manual_override',
        verifiedByRuntime: false,
        stale: false,
      },
      bestDiagnosticRoute: {
        route: 'passive_passive',
        grossLongShortSpreadPct: 0.578821,
        pairRoundTripCostPct: 0.36,
        netAfterRouteCostPct: 0.218821,
        grossToPairCostRatio: 1.607836,
      },
      blockers: [
        'rank_ic_common_periods_low:411<1000',
        'rank_ic_periods_low:25<30',
        'rank_ic_signal_periods_low:25<30',
        'rank_ic_wfo_status:insufficient_data',
        'fee_snapshot_manual_override',
        'fee_snapshot_not_runtime_verified',
      ],
    }), 'utf-8')

    const report = await runResearchCandidateSummary({
      researchRoot: root,
      outputPath: null,
      maxCandidates: 10,
      json: true,
    })

    expect(report.sourceFilesScanned).toBe(2)
    expect(report.topCandidates.map(candidate => candidate.sourceKind)).toEqual(expect.arrayContaining([
      'cross_sectional_rank_ic',
      'cross_sectional_rank_ic_route_cost',
    ]))
    expect(report.topCandidates.find(candidate => candidate.sourceKind === 'cross_sectional_rank_ic_route_cost')).toMatchObject({
      metrics: {
        netAfterRouteCostPct: 0.218821,
        feeSnapshotVerifiedByRuntime: false,
      },
      whyNotTradable: expect.arrayContaining([
        'rank_ic_periods_low:25<30',
        'fee_snapshot_manual_override',
        'not_release_validated',
      ]),
    })
    expect(report.focusRecommendations[0]).toContain('Latest live RankIC diagnostic')
    expect(report.focusRecommendations[0]).toContain('rank_ic_raw_reversal_0_lb336_sec336_fwd48_mtf0')
    expect(report.focusRecommendations[1]).toContain('Latest live route-cost diagnostic')
  })

  it('surfaces the newest live route-cost diagnostic even when the current paper horizon is net-negative', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-research-candidates-'))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'cross_sectional_rank_ic.live_accumulated_fwd48.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-04T22:01:00.000Z',
      researchOnly: true,
      promotionEligible: false,
      dataDir: '/repo/data/market/live_accumulated',
      commonPeriods: 411,
      blockers: ['common_periods_low:411<1000'],
      wfo: { status: 'insufficient_data', windowCount: 5, passedWindows: 3, failedWindowRatio: 0.4 },
      topConfigs: [{
        lookbackHours: 336,
        secondaryLookbackHours: 336,
        forwardHours: 48,
        mtfWeight: 0,
        factor: 'raw_reversal',
        observations: 841,
        periods: 25,
        meanIc: 0.15349,
        icIr: 0.90652,
        winRate: 0.68,
        passed: true,
        averageLongShortSpreadPct: 0.578821,
        longShortWinRate: 0.16,
        signalPeriods: 25,
      }],
    }), 'utf-8')
    await writeFile(join(root, 'rank_ic_route_cost_validation.live_accumulated_fwd48.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-04T22:01:30.000Z',
      researchOnly: true,
      promotionEligible: false,
      routeCostValidationStatus: 'insufficient_data',
      candidate: {
        candidateId: 'rank_ic_raw_reversal_best_lb336_sec336_fwd48_mtf0',
        factor: 'raw_reversal',
        observations: 841,
        periods: 25,
        signalPeriods: 25,
        commonPeriods: 411,
        meanIc: 0.15349,
        icIr: 0.90652,
        wfoStatus: 'insufficient_data',
        averageLongShortSpreadPct: 0.578821,
      },
      feeSnapshot: { source: 'manual_override', verifiedByRuntime: false, stale: false },
      bestDiagnosticRoute: {
        route: 'passive_passive',
        grossLongShortSpreadPct: 0.578821,
        pairRoundTripCostPct: 0.36,
        netAfterRouteCostPct: 0.218821,
        grossToPairCostRatio: 1.607836,
      },
      blockers: ['fee_snapshot_manual_override'],
    }), 'utf-8')
    await writeFile(join(root, 'cross_sectional_rank_ic.live_accumulated_fwd24.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-04T22:50:00.000Z',
      researchOnly: true,
      promotionEligible: false,
      dataDir: '/repo/data/market/live_accumulated',
      commonPeriods: 412,
      blockers: ['common_periods_low:412<1000', 'rank_ic_best_config_failed_thresholds'],
      wfo: { status: 'fail', windowCount: 5, passedWindows: 2, failedWindowRatio: 0.6 },
      topConfigs: [{
        lookbackHours: 336,
        secondaryLookbackHours: 336,
        forwardHours: 24,
        mtfWeight: 0,
        factor: 'raw_reversal',
        observations: 1666,
        periods: 50,
        meanIc: 0.063917,
        icIr: 0.310493,
        winRate: 0.54,
        passed: false,
        averageLongShortSpreadPct: 0.234009,
        longShortWinRate: 0.48,
        signalPeriods: 50,
      }],
    }), 'utf-8')
    await writeFile(join(root, 'rank_ic_route_cost_validation.live_accumulated_fwd24.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-04T22:50:30.000Z',
      researchOnly: true,
      promotionEligible: false,
      routeCostValidationStatus: 'insufficient_data',
      candidate: {
        candidateId: 'rank_ic_raw_reversal_best_lb336_sec336_fwd24_mtf0',
        factor: 'raw_reversal',
        observations: 1666,
        periods: 50,
        signalPeriods: 50,
        commonPeriods: 412,
        meanIc: 0.063917,
        icIr: 0.310493,
        wfoStatus: 'fail',
        averageLongShortSpreadPct: 0.234009,
      },
      feeSnapshot: { source: 'manual_override', verifiedByRuntime: false, stale: false },
      bestDiagnosticRoute: {
        route: 'passive_passive',
        grossLongShortSpreadPct: 0.234009,
        pairRoundTripCostPct: 0.36,
        netAfterRouteCostPct: -0.125991,
        grossToPairCostRatio: 0.650025,
      },
      blockers: ['route_net_edge_non_positive:passive_passive', 'fee_snapshot_manual_override'],
    }), 'utf-8')

    const report = await runResearchCandidateSummary({
      researchRoot: root,
      outputPath: null,
      maxCandidates: 10,
      json: true,
    })

    expect(report.focusRecommendations[0]).toContain('rank_ic_raw_reversal_0_lb336_sec336_fwd24_mtf0')
    expect(report.focusRecommendations[1]).toContain('rank_ic_raw_reversal_best_lb336_sec336_fwd24_mtf0')
    expect(report.focusRecommendations[1]).toContain('netAfterRouteCostPct=-0.126')
  })

  it('surfaces 5m acceleration diagnostics separately without making them tradable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-research-candidates-'))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'rank_ic_route_cost_validation.live_5m_fwd6h.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-05T03:08:29.135Z',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      routeCostValidationStatus: 'insufficient_data',
      candidate: {
        candidateId: 'rank_ic_signal_confidence_best_lb12_sec72_fwd6_mtf0.15',
        factor: 'signal_confidence',
        barMinutes: 5,
        nonHourlyDiagnosticOnly: true,
        lookbackHours: 12,
        secondaryLookbackHours: 72,
        forwardHours: 6,
        mtfWeight: 0.15,
        observations: 4449,
        periods: 137,
        signalPeriods: 137,
        commonPeriods: 1075,
        meanIc: 0.131998,
        icIr: 0.719352,
        wfoStatus: 'fail',
        averageLongShortSpreadPct: 0.674551,
      },
      feeSnapshot: { source: 'manual_override', verifiedByRuntime: false, stale: false },
      bestDiagnosticRoute: {
        route: 'passive_passive',
        grossLongShortSpreadPct: 0.674551,
        pairRoundTripCostPct: 0.36,
        netAfterRouteCostPct: 0.314551,
        grossToPairCostRatio: 1.873753,
      },
      blockers: [
        'non_hourly_rank_ic_cadence_research_only',
        'rank_ic_wfo_status:fail',
        'fee_snapshot_manual_override',
        'not_paper_execution_evidence',
      ],
    }), 'utf-8')

    const report = await runResearchCandidateSummary({
      researchRoot: root,
      outputPath: null,
      maxCandidates: 10,
      json: true,
    })

    expect(report.topCandidates[0]).toMatchObject({
      sourceKind: 'cross_sectional_rank_ic_route_cost',
      status: 'diagnostic_only',
      whyNotTradable: expect.arrayContaining([
        'non_hourly_rank_ic_cadence_research_only',
        'rank_ic_wfo_status:fail',
        'fee_snapshot_manual_override',
        'not_paper_execution_evidence',
      ]),
    })
    expect(report.focusRecommendations.some(item =>
      item.includes('Latest 5m acceleration diagnostic') &&
      item.includes('research-only blockers=non_hourly_rank_ic_cadence_research_only'),
    )).toBe(true)
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
  })

  it('surfaces walk-forward regime filter diagnostics without treating them as promotion evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-research-candidates-'))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'rank_ic_walkforward_filter_validation.live_accumulated_fwd72.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-05T04:40:00.000Z',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      rankIcReportPath: '/repo/data/research/cross_sectional_rank_ic.live_accumulated_fwd72.latest.json',
      dataDir: '/repo/data/market/live_accumulated',
      barMinutes: 60,
      symbolsLoaded: ['BTC-USDT', 'ETH-USDT'],
      config: {
        lookbackHours: 120,
        secondaryLookbackHours: 336,
        forwardHours: 72,
        lookbackBars: 120,
        secondaryLookbackBars: 336,
        forwardBars: 72,
        mtfWeight: 0.5,
        factor: 'signal_confidence',
      },
      dataAlignment: {
        loadedCommonPeriods: 1200,
      },
      trainingPolicy: {
        thresholdSource: 'previous_wfo_windows_only',
      },
      baseline: {
        filterId: 'no_filter',
        diagnosticVerdict: 'baseline',
        aggregate: {
          observations: 20000,
          periods: 600,
          signalPeriods: 590,
          meanIc: 0.046712,
          icIr: 0.232755,
          winRate: 0.55,
          averageLongShortSpreadPct: 2.304259,
          longShortWinRate: 0.56,
        },
        wfo: {
          status: 'fail',
          windowCount: 4,
          passedWindows: 1,
          failedWindowRatio: 0.75,
        },
        warnings: ['walk_forward_wfo_fail'],
      },
      bestWalkForwardCandidate: {
        filterId: 'median_return_gte_p33',
        diagnosticVerdict: 'walk_forward_improved_candidate',
        aggregate: {
          observations: 15000,
          periods: 432,
          signalPeriods: 420,
          meanIc: 0.055734,
          icIr: 0.277431,
          winRate: 0.57,
          averageLongShortSpreadPct: 1.88475,
          longShortWinRate: 0.58,
        },
        wfo: {
          status: 'fail',
          windowCount: 4,
          passedWindows: 2,
          failedWindowRatio: 0.5,
        },
        warnings: ['thresholds_fit_only_on_prior_wfo_windows', 'walk_forward_wfo_fail'],
      },
      candidates: [],
      blockers: [
        'walk_forward_filter_diagnostic_only',
        'not_trial_ledger_fdr_validated',
        'not_runtime_fee_verified',
        'not_paper_execution_evidence',
        'best_walk_forward_candidate_wfo_fail',
      ],
    }), 'utf-8')

    const report = await runResearchCandidateSummary({
      researchRoot: root,
      outputPath: null,
      maxCandidates: 10,
      json: true,
    })

    expect(report.topCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKind: 'cross_sectional_rank_ic_walkforward_filter',
        family: 'cross_sectional_rank_ic_walkforward_filter',
        candidateId: 'rank_ic_wf_filter_median_return_gte_p33_signal_confidence_lb120_sec336_fwd72_mtf0.5',
        status: 'diagnostic_only',
        metrics: expect.objectContaining({
          meanIc: 0.055734,
          icIr: 0.277431,
          commonPeriods: 1200,
          signalPeriods: 420,
          rankIcWfoStatus: 'fail',
          rankIcWfoPassedWindows: 2,
          rankIcWfoWindowCount: 4,
        }),
        whyNotTradable: expect.arrayContaining([
          'walk_forward_filter_diagnostic_only',
          'walk_forward_warning:thresholds_fit_only_on_prior_wfo_windows',
          'rank_ic_wfo_status:fail',
          'rank_ic_wfo_failed_window_ratio:0.5>0.3',
          'not_release_validated',
          'release_gate_missing',
        ]),
      }),
    ]))
    expect(report.focusRecommendations.some(item =>
      item.includes('Latest live walk-forward filter diagnostic') &&
      item.includes('median_return_gte_p33') &&
      item.includes('WFO=fail'),
    )).toBe(true)
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
  })

  it('surfaces prospective trial lanes without treating them as execution evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-research-candidates-'))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'rank_ic_prospective_trial_lane.live_accumulated_fwd72_median_filter.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-05T05:08:16.956Z',
      researchOnly: true,
      promotionEligible: false,
      prospectiveOnly: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      laneStatus: 'ready_for_future_collection',
      candidate: {
        laneId: 'prospective_efbd8a1531fef680',
        candidateId: 'rank_ic_wf_filter_median_return_gte_p33_signal_confidence_lb120_sec336_fwd72_mtf0.5',
        strategyFamily: 'cross_sectional_rank_ic_walkforward_filter',
        filterId: 'median_return_gte_p33',
        factor: 'signal_confidence',
        lookbackHours: 120,
        secondaryLookbackHours: 336,
        forwardHours: 72,
        mtfWeight: 0.5,
      },
      currentEvidence: {
        walkForwardVerdict: 'walk_forward_improved_candidate',
        walkForwardWfoStatus: 'fail',
        walkForwardPassedWindows: 2,
        walkForwardWindowCount: 4,
        walkForwardFailedWindowRatio: 0.5,
        meanIc: 0.055734,
        icIr: 0.277431,
        averageLongShortSpreadPct: 1.88475,
        route: 'passive_passive',
        netAfterRouteCostPct: 1.349672,
        grossToPairCostRatio: 4.749089,
        feeSnapshotSource: 'manual_override',
        feeSnapshotVerifiedByRuntime: false,
      },
      prospectiveProtocol: {
        unit: 'future_1h_decision_period',
        labelDelayHours: 72,
        minimumFutureSignalPeriods: 100,
        minimumFutureValidationWindows: 3,
        requiresRuntimeVerifiedFees: true,
        requiresCompleteTrialUniverseBeforePromotion: true,
        requiresPitAuditBeforePromotion: true,
        orderExecutionAllowed: false,
      },
      blockers: [
        'prospective_lane_not_execution_evidence',
        'paper_live_execution_disabled',
        'future_live_only_trial_outcomes_missing',
        'complete_trial_universe_missing',
      ],
    }), 'utf-8')

    const report = await runResearchCandidateSummary({
      researchRoot: root,
      outputPath: null,
      maxCandidates: 10,
      json: true,
    })

    expect(report).toMatchObject({
      researchOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      candidateRowsFound: 1,
    })
    expect(report.topCandidates[0]).toMatchObject({
      sourceKind: 'cross_sectional_rank_ic_prospective_lane',
      family: 'cross_sectional_rank_ic_prospective_lane',
      candidateId: 'rank_ic_wf_filter_median_return_gte_p33_signal_confidence_lb120_sec336_fwd72_mtf0.5',
      status: 'diagnostic_only',
      metrics: expect.objectContaining({
        netExpectancyPct: 1.349672,
        netAfterRouteCostPct: 1.349672,
        meanIc: 0.055734,
        icIr: 0.277431,
        signalPeriods: 100,
        rankIcWfoStatus: 'fail',
        rankIcWfoPassedWindows: 2,
        rankIcWfoWindowCount: 4,
        feeSnapshotSource: 'manual_override',
        feeSnapshotVerifiedByRuntime: false,
      }),
      whyNotTradable: expect.arrayContaining([
        'prospective_lane_not_execution_evidence',
        'prospective_lane_future_outcomes_required',
        'future_live_only_trial_outcomes_missing',
        'not_release_validated',
        'release_gate_missing',
        'rank_ic_wfo_status:fail',
        'route_cost_validation_status:prospective_lane',
        'fee_snapshot_manual_override',
        'fee_snapshot_not_runtime_verified',
      ]),
    })
    expect(report.focusRecommendations.some(item =>
      item.includes('Prospective trial lane ready for future collection') &&
      item.includes('median_return_gte_p33') &&
      item.includes('netAfterRouteCostPct=1.3497'),
    )).toBe(true)
  })
})
