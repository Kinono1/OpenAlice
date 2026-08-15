import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildResearchLineRetirementReport,
  parseResearchLineRetirementArgs,
  runResearchLineRetirement,
} from './build_research_line_retirement.js'

describe('build_research_line_retirement', () => {
  it('parses conservative default inputs', () => {
    expect(parseResearchLineRetirementArgs([])).toMatchObject({
      incubationPlanPath: 'data/research/research_incubation_plan.latest.json',
      candidateSummaryPath: 'data/research/candidate_ranking.latest.json',
      cryptoFactorFamilyPath: 'data/research/crypto_factor_family.live_accumulated.latest.json',
      liquidityConditionedFactorPath: 'data/research/liquidity_conditioned_factor_report.live_accumulated.latest.json',
      rankIcProspectiveStatusPath: 'data/research/rank_ic_prospective_evidence_status.live_accumulated_fwd72_median_filter.latest.json',
      liquidityProspectiveStatusPath: 'data/research/liquidity_conditioned_prospective_evidence_status.live_accumulated.latest.json',
      outputPath: 'data/research/research_line_retirement.latest.json',
      json: false,
    })
    expect(parseResearchLineRetirementArgs([
      '--incubationPlan',
      'incubation.json',
      '--candidateSummary',
      'summary.json',
      '--cryptoFactorFamily',
      'crypto.json',
      '--liquidityConditionedFactor',
      'liq.json',
      '--rankIcProspectiveStatusPath',
      'rank.json',
      '--liquidityProspectiveStatusPath',
      'liq-prospective.json',
      '--output',
      'null',
      '--json',
      'true',
    ])).toMatchObject({
      incubationPlanPath: 'incubation.json',
      candidateSummaryPath: 'summary.json',
      cryptoFactorFamilyPath: 'crypto.json',
      liquidityConditionedFactorPath: 'liq.json',
      rankIcProspectiveStatusPath: 'rank.json',
      liquidityProspectiveStatusPath: 'liq-prospective.json',
      outputPath: null,
      json: true,
    })
  })

  it('recommends retiring the current line when all active incubation is gone and WFO-killed diagnostics dominate', () => {
    const report = buildResearchLineRetirementReport({
      inputs: inputPaths(),
      incubationPlan: makeNoViableIncubationPlan(),
      candidateSummary: makeCandidateSummary(),
      cryptoFactorFamily: makeCryptoFactorReport(),
      liquidityConditionedFactor: makeLiquidityFactorReport(),
      rankIcProspectiveStatus: makeProspectiveStatus('2026-05-08T03:00:00.000Z', 6),
      liquidityProspectiveStatus: makeProspectiveStatus('2026-05-08T02:00:00.000Z', 36),
      generatedAt: '2026-05-05T00:00:00.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-05T00:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      policyMutationAllowed: false,
      verdict: 'retire_current_line',
      lineHealth: 'retired',
      summary: {
        activeIncubationCandidates: 0,
        rejectedDiagnostics: 2,
        wfoKilledDiagnostics: 2,
        retirementRecommendedLines: 5,
        openProspectiveEvents: 42,
        closedProspectiveEvents: 0,
        earliestNextLabelDueTime: '2026-05-08T02:00:00.000Z',
      },
      primaryLine: {
        candidateId: 'rank_ic_signal_confidence_best_lb120_sec336_fwd72_mtf0.5',
        status: 'rejected',
        netAfterRouteCostPct: 1.7717,
        killTriggers: expect.arrayContaining([
          'primary:wfo_failed_window_ratio:0.8>0.3',
          'primary:wfo_direction_not_stable',
        ]),
      },
      blockers: expect.arrayContaining([
        'no_active_incubation_candidate',
        'line_decision:no_active_incubation_candidate',
        'line_decision:rejected_diagnostic:wfo_kill_condition_met',
      ]),
      requiredBeforeReactivation: expect.arrayContaining([
        'new_alpha_hypothesis_or_materially_different_feature_set',
        'wfo_failed_window_ratio_lte_threshold_and_direction_stable',
        'prospective_closed_outcomes_gte_100_across_3_non_overlapping_windows',
      ]),
    })
    expect(report.retiredLines.map(line => line.candidateId)).toEqual(expect.arrayContaining([
      'rank_ic_signal_confidence_best_lb120_sec336_fwd72_mtf0.5',
      'liq_high_reversal_lb168_fwd72',
      'factor_reversal_lb168_fwd72',
    ]))
    expect(report.nextActions.join('\n')).toContain('Stop broad parameter expansion')
    expect(report.safetyNotes.join('\n')).toContain('cannot mutate candidate registries')
  })

  it('keeps a live active line in incubation without authorizing paper or live execution', () => {
    const report = buildResearchLineRetirementReport({
      inputs: inputPaths(),
      incubationPlan: makeActiveIncubationPlan(),
      candidateSummary: null,
      cryptoFactorFamily: null,
      liquidityConditionedFactor: null,
      rankIcProspectiveStatus: makeProspectiveStatus('2026-05-08T03:00:00.000Z', 1),
      liquidityProspectiveStatus: null,
    })

    expect(report).toMatchObject({
      verdict: 'keep_incubating',
      lineHealth: 'incubating',
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      policyMutationAllowed: false,
      summary: {
        activeIncubationCandidates: 1,
        retirementRecommendedLines: 0,
      },
      primaryLine: {
        candidateId: 'rank_ic_candidate_keep',
        status: 'active',
        killTriggers: [],
      },
      blockers: expect.arrayContaining([
        'candidate_summary_missing',
        'crypto_factor_family_report_missing',
        'liquidity_conditioned_factor_report_missing',
        'liquidity_conditioned_prospective_status_missing',
        'no_retirement_recommendation',
      ]),
    })
    expect(report.nextActions.join('\n')).toContain('Keep incubating')
  })

  it('writes a diagnostic artifact and manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-research-line-retirement-'))
    const incubationPlanPath = join(root, 'incubation.json')
    const candidateSummaryPath = join(root, 'summary.json')
    const cryptoFactorFamilyPath = join(root, 'crypto.json')
    const liquidityConditionedFactorPath = join(root, 'liq.json')
    const rankIcProspectiveStatusPath = join(root, 'rank-prospective.json')
    const liquidityProspectiveStatusPath = join(root, 'liq-prospective.json')
    const outputPath = join(root, 'retirement.json')
    await writeFile(incubationPlanPath, `${JSON.stringify(makeNoViableIncubationPlan())}\n`, 'utf-8')
    await writeFile(candidateSummaryPath, `${JSON.stringify(makeCandidateSummary())}\n`, 'utf-8')
    await writeFile(cryptoFactorFamilyPath, `${JSON.stringify(makeCryptoFactorReport())}\n`, 'utf-8')
    await writeFile(liquidityConditionedFactorPath, `${JSON.stringify(makeLiquidityFactorReport())}\n`, 'utf-8')
    await writeFile(rankIcProspectiveStatusPath, `${JSON.stringify(makeProspectiveStatus('2026-05-08T03:00:00.000Z', 6))}\n`, 'utf-8')
    await writeFile(liquidityProspectiveStatusPath, `${JSON.stringify(makeProspectiveStatus('2026-05-08T02:00:00.000Z', 36))}\n`, 'utf-8')

    const report = await runResearchLineRetirement({
      incubationPlanPath,
      candidateSummaryPath,
      cryptoFactorFamilyPath,
      liquidityConditionedFactorPath,
      rankIcProspectiveStatusPath,
      liquidityProspectiveStatusPath,
      outputPath,
      json: false,
    })

    expect(report.verdict).toBe('retire_current_line')
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written).toMatchObject({
      verdict: 'retire_current_line',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      policyMutationAllowed: false,
    })
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'research_line_retirement',
      businessStatus: 'fail',
      errorClass: 'retire_current_line',
      recordsOut: written.summary.retirementRecommendedLines,
    })
  })
})

function inputPaths() {
  return {
    incubationPlanPath: '/repo/data/research/research_incubation_plan.latest.json',
    candidateSummaryPath: '/repo/data/research/candidate_ranking.latest.json',
    cryptoFactorFamilyPath: '/repo/data/research/crypto_factor_family.live_accumulated.latest.json',
    liquidityConditionedFactorPath: '/repo/data/research/liquidity_conditioned_factor_report.live_accumulated.latest.json',
    rankIcProspectiveStatusPath: '/repo/data/research/rank_ic_prospective_evidence_status.live_accumulated_fwd72_median_filter.latest.json',
    liquidityProspectiveStatusPath: '/repo/data/research/liquidity_conditioned_prospective_evidence_status.live_accumulated.latest.json',
  }
}

function makeNoViableIncubationPlan() {
  return {
    planStatus: 'no_incubation_candidates',
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    incubationCandidatesFound: 0,
    candidates: [],
    lineDecision: {
      lineHealth: 'no_viable_line',
      hardBlockers: [
        'no_active_incubation_candidate',
        'rejected_diagnostic:wfo_kill_condition_met',
      ],
    },
    rejectedDiagnostics: [
      {
        sourcePath: '/repo/data/research/rank_ic_route_cost_validation.live_accumulated_fwd72.latest.json',
        candidateId: 'rank_ic_signal_confidence_best_lb120_sec336_fwd72_mtf0.5',
        reason: 'wfo_kill_condition_met',
        netAfterRouteCostPct: 1.7717,
        routeCostValidationStatus: 'insufficient_data',
        killTriggers: [
          'primary:wfo_failed_window_ratio:0.8>0.3',
          'primary:wfo_direction_not_stable',
        ],
      },
      {
        sourcePath: '/repo/data/research/rank_ic_route_cost_validation.live_accumulated_fwd24.latest.json',
        candidateId: 'rank_ic_signal_confidence_best_lb72_sec336_fwd24_mtf0.5',
        reason: 'wfo_kill_condition_met',
        netAfterRouteCostPct: 0.961508,
        routeCostValidationStatus: 'insufficient_data',
        killTriggers: [
          'primary:wfo_failed_window_ratio:0.6>0.3',
        ],
      },
    ],
  }
}

function makeActiveIncubationPlan() {
  return {
    planStatus: 'active_incubation',
    incubationCandidatesFound: 1,
    lineDecision: {
      lineHealth: 'incubate',
      killTriggers: [],
    },
    candidates: [
      {
        candidateId: 'rank_ic_candidate_keep',
        factor: 'reversal',
        route: 'passive_passive',
        metrics: {
          netAfterRouteCostPct: 1.2,
          wfoStatus: 'pass',
          wfoWindowCount: 4,
          wfoFailedWindowRatio: 0.25,
          wfoFailWindowRatioThreshold: 0.3,
          wfoDirectionStable: true,
        },
        feeSnapshot: {
          verifiedByRuntime: true,
        },
        blockers: [],
      },
    ],
  }
}

function makeCandidateSummary() {
  return {
    bestByTier: [
      {
        evidenceTier: 'diagnostic_validation',
        candidate: {
          sourcePath: '/repo/data/research/liquidity_conditioned_factor_report.live_accumulated.latest.json',
          sourceKind: 'liquidity_conditioned_factor',
          family: 'liquidity_conditioned_factor',
          strategy: 'high_reversal',
          candidateId: 'liq_high_reversal_lb168_fwd72',
          metrics: {
            netAfterRouteCostPct: 2.598547,
            rankIcWfoStatus: 'fail',
            rankIcWfoFailedWindowRatio: 0.8,
            rankIcWfoWindowCount: 5,
            feeSnapshotVerifiedByRuntime: true,
          },
          whyNotTradable: [
            'best_wfo_fail',
            'wfo_failed_window_ratio:0.8>0.3',
            'wfo_direction_or_net_not_stable',
          ],
        },
      },
    ],
  }
}

function makeCryptoFactorReport() {
  return makeFactorReport({
    candidateId: 'factor_reversal_lb168_fwd72',
    family: 'crypto_factor_family',
    netAfterRouteCostPct: 0.234634,
    failedWindowRatio: 0.6,
    passedWindows: 2,
    failedWindows: 3,
  })
}

function makeLiquidityFactorReport() {
  return makeFactorReport({
    candidateId: 'liq_high_reversal_lb168_fwd72',
    family: 'liquidity_conditioned_factor',
    netAfterRouteCostPct: 2.598547,
    failedWindowRatio: 0.8,
    passedWindows: 1,
    failedWindows: 4,
  })
}

function makeFactorReport(input: {
  candidateId: string
  family: string
  netAfterRouteCostPct: number
  failedWindowRatio: number
  passedWindows: number
  failedWindows: number
}) {
  return {
    researchOnly: true,
    promotionEligible: false,
    routeCost: {
      runtimeVerified: true,
    },
    best: {
      candidateId: input.candidateId,
      factor: input.family,
      netAfterRouteCostPct: input.netAfterRouteCostPct,
      wfo: {
        status: 'fail',
        windowCount: input.passedWindows + input.failedWindows,
        passedWindows: input.passedWindows,
        failedWindows: input.failedWindows,
        failedWindowRatio: input.failedWindowRatio,
        failWindowRatioThreshold: 0.3,
        directionStable: false,
        blockers: [
          `wfo_failed_window_ratio:${input.failedWindowRatio}>0.3`,
          'wfo_direction_or_net_not_stable',
        ],
      },
      blockers: ['wfo_fail'],
    },
    blockers: ['best_wfo_fail'],
  }
}

function makeProspectiveStatus(labelDueTime: string, openEvents: number) {
  return {
    status: 'collecting',
    counts: {
      openEvents,
      closedEvents: 0,
    },
    latestOpen: {
      labelDueTime,
    },
  }
}
