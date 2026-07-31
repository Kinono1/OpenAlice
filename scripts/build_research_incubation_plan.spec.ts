import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildResearchIncubationPlanReport,
  parseResearchIncubationPlanArgs,
  runResearchIncubationPlan,
} from './build_research_incubation_plan.js'

describe('build_research_incubation_plan', () => {
  it('parses conservative diagnostic-only defaults', () => {
    expect(parseResearchIncubationPlanArgs([
      '--researchRoot',
      'research',
      '--candidateSummary',
      'summary.json',
      '--output',
      'null',
      '--maxCandidates',
      '3',
      '--minSignalPeriods',
      '40',
      '--minPeriods',
      '35',
      '--minCommonPeriods',
      '1200',
      '--json',
      'true',
    ])).toEqual({
      researchRoot: 'research',
      candidateSummaryPath: 'summary.json',
      systemStatusPath: 'data/runtime/system_status_reason_chain.latest.json',
      okxAuthPath: 'data/runtime/okx_private_auth_diagnosis.latest.json',
      feeSnapshotStatusPath: 'data/runtime/fee_snapshot_refresh.latest.json',
      liquidityProspectiveStatusPath: 'data/research/liquidity_conditioned_prospective_evidence_status.live_accumulated.latest.json',
      rankIcProspectiveStatusPath: 'data/research/rank_ic_prospective_evidence_status.live_accumulated_fwd72_median_filter.latest.json',
      outputPath: null,
      maxCandidates: 3,
      minSignalPeriods: 40,
      minPeriods: 35,
      minCommonPeriods: 1200,
      minWfoWindowCount: 3,
      json: true,
    })
  })

  it('keeps generated next-check commands backed by package scripts', () => {
    const scripts = packageJson.scripts as Record<string, string>

    expect(scripts['research:cross-sectional:rank-ic:live-fwd72']).toContain('--forwardHours 72')
    expect(scripts['research:cross-sectional:route-cost:live-fwd72']).toContain('live_accumulated_fwd72')
    expect(scripts['research:cross-sectional:rank-ic:live-5m-fwd6h']).toContain('--barMinutes 5')
    expect(scripts['research:cross-sectional:route-cost:live-5m-fwd6h']).toContain('live_5m_fwd6h')
    expect(scripts['research:incubation-plan']).toBe('tsx scripts/build_research_incubation_plan.ts')
  })

  it('promotes a positive live route-cost diagnostic into incubation without authorizing execution', () => {
    const rankIcPath = '/repo/data/research/cross_sectional_rank_ic.live_accumulated_fwd72.latest.json'
    const routeCostPath = '/repo/data/research/rank_ic_route_cost_validation.live_accumulated_fwd72.latest.json'
    const report = buildResearchIncubationPlanReport({
      generatedAt: '2026-05-05T01:30:00.000Z',
      researchRoot: '/repo/data/research',
      candidateSummaryPath: '/repo/data/research/candidate_ranking.latest.json',
      candidateSummary: {
        candidateRowsFound: 307,
        focusRecommendations: ['Latest live route-cost diagnostic is positive but blocked.'],
      },
      files: [
        {
          path: rankIcPath,
          value: {
            wfo: {
              status: 'insufficient_data',
              windowCount: 3,
            },
          },
        },
        {
          path: routeCostPath,
          value: makeRuntimeFeeVerifiedPositiveRouteCostDiagnostic(rankIcPath),
        },
      ],
    })

    expect(report).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      planStatus: 'active_incubation',
      routeCostDiagnosticsFound: 1,
      incubationCandidatesFound: 1,
      candidateSummary: {
        present: true,
        candidateRowsFound: 307,
      },
    })
    expect(report.executionPolicy).toMatchObject({
      paperOrdersAllowed: false,
      liveOrdersAllowed: false,
      policyMutationAllowed: false,
    })
    expect(report.lineDecision).toMatchObject({
      verdict: 'continue_incubation_no_execution',
      randomSearchAllowed: false,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      primaryCandidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
      primaryRoute: 'passive_passive',
    })
    expect(report.lineDecision.hardBlockers).toEqual(expect.arrayContaining([
      'primary:live_only_signal_periods',
      'primary:wfo_status',
      'primary:paper_execution_evidence',
    ]))
    expect(report.lineDecision.continueConditions.join('\n')).toContain('Do not run broad random grid expansion')

    const candidate = report.candidates[0]
    expect(candidate).toMatchObject({
      rank: 1,
      candidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
      status: 'incubating_diagnostic_only',
      factor: 'raw_reversal',
      forwardHours: 72,
      mtfWeight: 0.5,
      route: 'passive_passive',
      metrics: {
        signalPeriods: 3,
        commonPeriods: 413,
        wfoStatus: 'insufficient_data',
        wfoWindowCount: 3,
        netAfterRouteCostPct: 11.376377,
        positiveAfterCost: true,
      },
      feeSnapshot: {
        source: 'api',
        verifiedByRuntime: true,
        stale: false,
      },
    })
    expect(candidate.priorityScore).toBeGreaterThan(50)
    expect(candidate.promotionRequirements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'live_only_signal_periods',
        status: 'blocked',
        current: 3,
        required: 30,
      }),
      expect.objectContaining({
        code: 'runtime_fee_snapshot',
        status: 'pass',
        blocker: null,
      }),
      expect.objectContaining({
        code: 'route_cost_adjusted_net',
        status: 'pass',
      }),
      expect.objectContaining({
        code: 'trial_ledger_complete',
        status: 'blocked',
      }),
      expect.objectContaining({
        code: 'paper_execution_evidence',
        status: 'blocked',
      }),
    ]))
    expect(candidate.nextCheckCommands).toContain('corepack pnpm research:cross-sectional:rank-ic:live-fwd72')
  })

  it('rejects diagnostics whose WFO kill conditions are already met', () => {
    const rankIcPath = '/repo/data/research/cross_sectional_rank_ic.live_accumulated_fwd72.latest.json'
    const routeCostPath = '/repo/data/research/rank_ic_route_cost_validation.live_accumulated_fwd72.latest.json'
    const diagnostic = makePositiveRouteCostDiagnostic(rankIcPath)
    const report = buildResearchIncubationPlanReport({
      generatedAt: '2026-05-05T01:30:00.000Z',
      researchRoot: '/repo/data/research',
      candidateSummaryPath: '/repo/data/research/candidate_ranking.latest.json',
      files: [
        {
          path: rankIcPath,
          value: {
            wfo: {
              status: 'fail',
              windowCount: 5,
              passedWindows: 2,
              failedWindows: 3,
              failedWindowRatio: 0.6,
              failWindowRatioThreshold: 0.3,
              directionStable: false,
            },
          },
        },
        {
          path: routeCostPath,
          value: {
            ...diagnostic,
            candidate: {
              ...diagnostic.candidate,
              periods: 790,
              signalPeriods: 755,
              commonPeriods: 1200,
              wfoStatus: 'fail',
            },
            feeSnapshot: {
              source: 'api',
              verifiedByRuntime: true,
              sourceFetchedAt: '2026-05-05T00:36:01.625Z',
              expiresAt: '2026-05-06T00:36:01.625Z',
              stale: false,
            },
            blockers: [
              'rank_ic_wfo_status:fail',
              'not_trial_ledger_fdr_validated',
              'not_paper_execution_evidence',
            ],
          },
        },
      ],
    })

    expect(report).toMatchObject({
      planStatus: 'no_incubation_candidates',
      incubationCandidatesFound: 0,
      rejectedDiagnostics: [
        {
          candidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
          reason: 'wfo_kill_condition_met',
          netAfterRouteCostPct: 11.376377,
          killTriggers: [
            'primary:wfo_failed_window_ratio:0.6>0.3',
            'primary:wfo_direction_not_stable',
          ],
        },
      ],
    })
    expect(report.lineDecision).toMatchObject({
      verdict: 'no_viable_line',
      lineHealth: 'no_viable_line',
      killTriggers: [],
      randomSearchAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      primaryCandidateId: null,
    })
    expect(report.lineDecision.hardBlockers).toEqual(expect.arrayContaining([
      'no_active_incubation_candidate',
      'rejected_diagnostic:wfo_kill_condition_met',
    ]))
  })

  it('rejects diagnostics that are not positive after route cost', () => {
    const report = buildResearchIncubationPlanReport({
      generatedAt: '2026-05-05T01:30:00.000Z',
      researchRoot: '/repo/data/research',
      candidateSummaryPath: '/repo/data/research/candidate_ranking.latest.json',
      files: [
        {
          path: '/repo/data/research/rank_ic_route_cost_validation.live_accumulated_fwd48.latest.json',
          value: {
            researchOnly: true,
            promotionEligible: false,
            routeCostValidationStatus: 'negative_after_cost',
            candidate: {
              candidateId: 'rank_ic_raw_reversal_best_lb336_sec336_fwd48_mtf0',
            },
            bestDiagnosticRoute: {
              route: 'passive_passive',
              positiveAfterCost: false,
              netAfterRouteCostPct: -0.06201,
            },
          },
        },
      ],
    })

    expect(report.planStatus).toBe('no_incubation_candidates')
    expect(report.incubationCandidatesFound).toBe(0)
    expect(report.rejectedDiagnostics).toEqual([
      expect.objectContaining({
        candidateId: 'rank_ic_raw_reversal_best_lb336_sec336_fwd48_mtf0',
        reason: 'route_cost_adjusted_net_not_positive',
        netAfterRouteCostPct: -0.06201,
      }),
    ])
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.lineDecision).toMatchObject({
      verdict: 'no_viable_line',
      randomSearchAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      primaryCandidateId: null,
    })
    expect(report.lineDecision.hardBlockers).toContain('no_active_incubation_candidate')
  })

  it('rejects non-hourly route-cost diagnostics from incubation even when positive', () => {
    const report = buildResearchIncubationPlanReport({
      generatedAt: '2026-05-05T01:30:00.000Z',
      researchRoot: '/repo/data/research',
      candidateSummaryPath: '/repo/data/research/candidate_ranking.latest.json',
      files: [
        {
          path: '/repo/data/research/rank_ic_route_cost_validation.live_5m_fwd6h.latest.json',
          value: {
            researchOnly: true,
            promotionEligible: false,
            routeCostValidationStatus: 'positive_after_cost_diagnostic',
            candidate: {
              candidateId: 'rank_ic_raw_reversal_best_lb12_sec24_fwd6_mtf0',
              forwardHours: 6,
            },
            bestDiagnosticRoute: {
              route: 'passive_passive',
              positiveAfterCost: true,
              netAfterRouteCostPct: 0.84,
            },
            blockers: [
              'non_hourly_rank_ic_cadence_research_only',
              'not_promotion_grade_route_cost_validated',
              'not_trial_ledger_fdr_validated',
              'not_paper_execution_evidence',
            ],
          },
        },
      ],
    })

    expect(report.planStatus).toBe('no_incubation_candidates')
    expect(report.incubationCandidatesFound).toBe(0)
    expect(report.rejectedDiagnostics).toEqual([
      expect.objectContaining({
        candidateId: 'rank_ic_raw_reversal_best_lb12_sec24_fwd6_mtf0',
        reason: 'non_hourly_rank_ic_cadence_research_only',
        netAfterRouteCostPct: 0.84,
      }),
    ])
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
  })

  it('rejects stale default route-cost diagnostics outside live-accumulated artifacts', () => {
    const rankIcPath = '/repo/data/research/cross_sectional_rank_ic.latest.json'
    const report = buildResearchIncubationPlanReport({
      generatedAt: '2026-05-05T01:30:00.000Z',
      researchRoot: '/repo/data/research',
      candidateSummaryPath: '/repo/data/research/candidate_ranking.latest.json',
      files: [
        {
          path: rankIcPath,
          value: {
            wfo: {
              status: 'insufficient_data',
              windowCount: 3,
            },
          },
        },
        {
          path: '/repo/data/research/rank_ic_route_cost_validation.latest.json',
          value: {
            ...makePositiveRouteCostDiagnostic(rankIcPath),
            feeSnapshot: {
              source: 'api',
              verifiedByRuntime: true,
              sourceFetchedAt: '2026-05-05T00:36:01.625Z',
              expiresAt: '2026-05-06T00:36:01.625Z',
              stale: false,
            },
          },
        },
      ],
    })

    expect(report.planStatus).toBe('no_incubation_candidates')
    expect(report.rejectedDiagnostics).toEqual([
      expect.objectContaining({
        candidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
        reason: 'not_live_accumulated_route_cost_diagnostic',
      }),
    ])
    expect(report.lineDecision.hardBlockers).toEqual(expect.arrayContaining([
      'no_active_incubation_candidate',
      'rejected_diagnostic:not_live_accumulated_route_cost_diagnostic',
    ]))
  })

  it('rejects live-accumulated diagnostics that still use manual or stale fees', () => {
    const rankIcPath = '/repo/data/research/cross_sectional_rank_ic.live_accumulated_fwd72.latest.json'
    const report = buildResearchIncubationPlanReport({
      generatedAt: '2026-05-05T01:30:00.000Z',
      researchRoot: '/repo/data/research',
      candidateSummaryPath: '/repo/data/research/candidate_ranking.latest.json',
      files: [
        {
          path: rankIcPath,
          value: {
            wfo: {
              status: 'insufficient_data',
              windowCount: 3,
            },
          },
        },
        {
          path: '/repo/data/research/rank_ic_route_cost_validation.live_accumulated_fwd72.latest.json',
          value: makePositiveRouteCostDiagnostic(rankIcPath),
        },
      ],
    })

    expect(report.planStatus).toBe('no_incubation_candidates')
    expect(report.rejectedDiagnostics).toEqual([
      expect.objectContaining({
        candidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
        reason: 'fee_snapshot_not_runtime_verified',
      }),
    ])
    expect(report.lineDecision.hardBlockers).toContain('rejected_diagnostic:fee_snapshot_not_runtime_verified')
  })

  it('prioritizes WFO-killed live diagnostics over stale high-net default diagnostics in rejection summaries', () => {
    const defaultRankIcPath = '/repo/data/research/cross_sectional_rank_ic.latest.json'
    const liveRankIcPath = '/repo/data/research/cross_sectional_rank_ic.live_accumulated_fwd72.latest.json'
    const defaultDiagnostic = makeRuntimeFeeVerifiedPositiveRouteCostDiagnostic(defaultRankIcPath)
    const liveDiagnostic = makeRuntimeFeeVerifiedPositiveRouteCostDiagnostic(liveRankIcPath)
    const report = buildResearchIncubationPlanReport({
      generatedAt: '2026-05-05T01:30:00.000Z',
      researchRoot: '/repo/data/research',
      candidateSummaryPath: '/repo/data/research/candidate_ranking.latest.json',
      files: [
        {
          path: defaultRankIcPath,
          value: {
            wfo: {
              status: 'insufficient_data',
              windowCount: 3,
            },
          },
        },
        {
          path: '/repo/data/research/rank_ic_route_cost_validation.latest.json',
          value: {
            ...defaultDiagnostic,
            bestDiagnosticRoute: {
              ...defaultDiagnostic.bestDiagnosticRoute,
              netAfterRouteCostPct: 5.32661,
            },
          },
        },
        {
          path: liveRankIcPath,
          value: {
            wfo: {
              status: 'fail',
              windowCount: 5,
              passedWindows: 1,
              failedWindows: 4,
              failedWindowRatio: 0.8,
              failWindowRatioThreshold: 0.3,
              directionStable: false,
            },
          },
        },
        {
          path: '/repo/data/research/rank_ic_route_cost_validation.live_accumulated_fwd72.latest.json',
          value: {
            ...liveDiagnostic,
            candidate: {
              ...liveDiagnostic.candidate,
              periods: 790,
              signalPeriods: 755,
              commonPeriods: 1200,
              wfoStatus: 'fail',
            },
            bestDiagnosticRoute: {
              ...liveDiagnostic.bestDiagnosticRoute,
              netAfterRouteCostPct: 1.7717,
            },
            blockers: [
              'rank_ic_wfo_status:fail',
              'not_trial_ledger_fdr_validated',
              'not_paper_execution_evidence',
            ],
          },
        },
      ],
    })

    expect(report.rejectedDiagnostics[0]).toMatchObject({
      reason: 'wfo_kill_condition_met',
      candidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
      netAfterRouteCostPct: 1.7717,
      killTriggers: [
        'primary:wfo_failed_window_ratio:0.8>0.3',
        'primary:wfo_direction_not_stable',
      ],
    })
    expect(report.lineDecision.rationale[0]).toContain('reason=wfo_kill_condition_met')
  })

  it('writes the incubation artifact and manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-research-incubation-'))
    const researchRoot = join(root, 'research')
    const rankIcPath = join(researchRoot, 'cross_sectional_rank_ic.live_accumulated_fwd72.latest.json')
    const routeCostPath = join(researchRoot, 'rank_ic_route_cost_validation.live_accumulated_fwd72.latest.json')
    const candidateSummaryPath = join(researchRoot, 'candidate_ranking.latest.json')
    const outputPath = join(researchRoot, 'research_incubation_plan.latest.json')
    const systemStatusPath = join(root, 'runtime', 'system_status_reason_chain.latest.json')
    const okxAuthPath = join(root, 'runtime', 'okx_private_auth_diagnosis.latest.json')
    const feeSnapshotStatusPath = join(root, 'runtime', 'fee_snapshot_refresh.latest.json')
    const liquidityProspectiveStatusPath = join(researchRoot, 'liquidity_conditioned_prospective_evidence_status.live_accumulated.latest.json')
    const rankIcProspectiveStatusPath = join(researchRoot, 'rank_ic_prospective_evidence_status.live_accumulated_fwd72_median_filter.latest.json')

    await mkdir(researchRoot, { recursive: true })
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(rankIcPath, `${JSON.stringify({ wfo: { status: 'insufficient_data', windowCount: 3 } })}\n`, 'utf-8')
    await writeFile(routeCostPath, `${JSON.stringify(makeRuntimeFeeVerifiedPositiveRouteCostDiagnostic(rankIcPath))}\n`, 'utf-8')
    await writeFile(candidateSummaryPath, `${JSON.stringify({ candidateRowsFound: 1, focusRecommendations: ['focus'] })}\n`, 'utf-8')
    await writeFile(systemStatusPath, `${JSON.stringify({ effectiveActionability: 'research_only_blocked' })}\n`, 'utf-8')
    await writeFile(okxAuthPath, `${JSON.stringify({ status: 'blocked', blockers: ['direct_rest:production:50119'] })}\n`, 'utf-8')
    await writeFile(feeSnapshotStatusPath, `${JSON.stringify({ status: 'blocked', perSymbolFees: [], blockers: ['fee_snapshot_fetch_failed:auth'] })}\n`, 'utf-8')
    await writeFile(liquidityProspectiveStatusPath, `${JSON.stringify(makeProspectiveStatus('2026-05-08T09:00:00.000Z', 12, 0))}\n`, 'utf-8')
    await writeFile(rankIcProspectiveStatusPath, `${JSON.stringify(makeProspectiveStatus('2026-05-08T03:00:00.000Z', 2, 0))}\n`, 'utf-8')

    const report = await runResearchIncubationPlan({
      researchRoot,
      candidateSummaryPath,
      systemStatusPath,
      okxAuthPath,
      feeSnapshotStatusPath,
      liquidityProspectiveStatusPath,
      rankIcProspectiveStatusPath,
      outputPath,
      maxCandidates: 5,
      minSignalPeriods: 30,
      minPeriods: 30,
      minCommonPeriods: 1000,
      minWfoWindowCount: 3,
      json: false,
    })

    expect(report.incubationCandidatesFound).toBe(1)
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written).toMatchObject({
      diagnosticOnly: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      lineDecision: {
        verdict: 'continue_incubation_no_execution',
        randomSearchAllowed: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        evidenceSnapshot: {
          effectiveActionability: 'research_only_blocked',
          okxAuthStatus: 'blocked',
          runtimeFeeStatus: 'blocked',
          runtimeFeeRows: 0,
          liquidityOpenEvents: 12,
          liquidityClosedEvents: 0,
          rankIcOpenEvents: 2,
          rankIcClosedEvents: 0,
          earliestNextLabelDueTime: '2026-05-08T03:00:00.000Z',
        },
      },
      candidates: [
        {
          candidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
        },
      ],
    })
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'research_incubation_plan',
      businessStatus: 'warn',
      errorClass: 'incubation_candidates_require_more_evidence',
      recordsIn: 1,
      recordsOut: 1,
    })
  })
})

function makePositiveRouteCostDiagnostic(rankIcReportPath: string) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T01:03:10.868Z',
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    rankIcReportPath,
    candidate: {
      candidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
      factor: 'raw_reversal',
      lookbackHours: 240,
      secondaryLookbackHours: 336,
      forwardHours: 72,
      mtfWeight: 0.5,
      observations: 102,
      periods: 3,
      signalPeriods: 3,
      commonPeriods: 413,
      meanIc: 0.304304,
      icIr: 3.992814,
      wfoStatus: 'insufficient_data',
      averageLongShortSpreadPct: 11.736377,
      selectionSource: 'rank_ic_economic_best',
    },
    feeSnapshot: {
      source: 'manual_override',
      verifiedByRuntime: false,
      sourceFetchedAt: '2026-05-05T00:36:01.625Z',
      expiresAt: '2026-05-06T00:36:01.625Z',
      stale: false,
    },
    routeCostValidationStatus: 'insufficient_data',
    bestDiagnosticRoute: {
      route: 'passive_passive',
      pairRoundTripCostPct: 0.36,
      grossLongShortSpreadPct: 11.736377,
      netAfterRouteCostPct: 11.376377,
      grossToPairCostRatio: 32.601047,
      routeBudgetExceeded: false,
      positiveAfterCost: true,
      diagnosticEligible: true,
      blockers: [],
    },
    blockers: [
      'rank_ic_common_periods_low:413<1000',
      'rank_ic_periods_low:3<30',
      'rank_ic_signal_periods_low:3<30',
      'rank_ic_wfo_status:insufficient_data',
      'fee_snapshot_manual_override',
      'fee_snapshot_not_runtime_verified',
      'not_promotion_grade_route_cost_validated',
      'not_trial_ledger_fdr_validated',
      'not_paper_execution_evidence',
    ],
  }
}

function makeRuntimeFeeVerifiedPositiveRouteCostDiagnostic(rankIcReportPath: string) {
  const diagnostic = makePositiveRouteCostDiagnostic(rankIcReportPath)
  return {
    ...diagnostic,
    feeSnapshot: {
      source: 'api',
      verifiedByRuntime: true,
      sourceFetchedAt: '2026-05-05T00:36:01.625Z',
      expiresAt: '2026-05-06T00:36:01.625Z',
      stale: false,
    },
    blockers: diagnostic.blockers.filter(blocker =>
      blocker !== 'fee_snapshot_manual_override' && blocker !== 'fee_snapshot_not_runtime_verified',
    ),
  }
}

function makeProspectiveStatus(labelDueTime: string, openEvents: number, closedEvents: number) {
  return {
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status: 'collecting',
    counts: {
      openEvents,
      closedEvents,
    },
    thresholds: {
      minClosedOutcomes: 100,
      minNonOverlappingWindows: 3,
    },
    latestOpen: {
      labelDueTime,
    },
    blockers: [
      'research_only_not_execution_evidence',
      'runtime_fee_not_verified',
    ],
  }
}
