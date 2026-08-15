import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildNextResearchHypothesisPlanReport,
  parseNextResearchHypothesisPlanArgs,
  runNextResearchHypothesisPlan,
} from './build_next_research_hypothesis_plan.js'

describe('build_next_research_hypothesis_plan', () => {
  it('parses conservative default inputs', () => {
    expect(parseNextResearchHypothesisPlanArgs([])).toEqual({
      retirementPath: 'data/research/research_line_retirement.latest.json',
      alphaPoolPath: 'data/research/alpha_pool/latest.json',
      systemStatusPath: 'data/runtime/system_status_reason_chain.latest.json',
      outputPath: 'data/research/next_research_hypothesis_plan.latest.json',
      json: false,
    })
    expect(parseNextResearchHypothesisPlanArgs([
      '--retirement',
      'retirement.json',
      '--alphaPool',
      'alpha.json',
      '--systemStatus',
      'status.json',
      '--output',
      'null',
      '--json',
      'true',
    ])).toEqual({
      retirementPath: 'retirement.json',
      alphaPoolPath: 'alpha.json',
      systemStatusPath: 'status.json',
      outputPath: null,
      json: true,
    })
  })

  it('builds research-only next hypotheses after a WFO-killed line is retired', () => {
    const report = buildNextResearchHypothesisPlanReport({
      inputs: inputPaths(),
      retirement: makeRetirement(),
      alphaPool: makeAlphaPool(),
      systemStatus: makeSystemStatus(),
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
      planStatus: 'ready_for_research_only_experiments',
      retirementContext: {
        verdict: 'retire_current_line',
        lineHealth: 'retired',
        primaryCandidateId: 'rank_ic_signal_confidence_best_lb120_sec336_fwd72_mtf0.5',
        activeIncubationCandidates: 0,
        retirementRecommendedLines: 3,
      },
      alphaPoolSummary: {
        present: true,
        entries: 3,
        acceptedForRuntime: 3,
      },
      systemContext: {
        effectiveActionability: 'research_only_blocked',
        overallPlanCompletionPct: 49,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        canPromote: false,
      },
      blockers: expect.arrayContaining([
        'retired_line_parameter_search_forbidden',
      ]),
    })
    expect(report.forbiddenContinuations).toHaveLength(2)
    expect(report.forbiddenContinuations[0]).toMatchObject({
      lineId: 'rank_ic_signal_confidence_best_lb120_sec336_fwd72_mtf0_5',
      allowedOnlyIf: expect.arrayContaining([
        'new_alpha_hypothesis_or_materially_different_feature_set',
        'wfo_failed_window_ratio_lte_threshold_and_direction_stable',
      ]),
    })
    expect(report.experimentCards.map(card => card.familyId)).toEqual([
      'funding_carry_rebuild',
      'liquidation_aftermath_oi_confirmation',
      'kronos_forecast_shadow',
    ])
    expect(report.experimentCards.every(card =>
      card.paperTradingAllowed === false &&
      card.liveTradingAllowed === false &&
      card.killCriteria.length > 0 &&
      card.promotionPrerequisites.includes('by_fdr_pass') &&
      card.promotionPrerequisites.includes('pit_audit_pass'),
    )).toBe(true)
    expect(card(report, 'funding_carry_rebuild')).toMatchObject({
      priority: 'high',
      decision: 'admit_research_only',
      commands: expect.arrayContaining([
        './node_modules/.bin/tsx scripts/refresh_eth_carry_pipeline.ts',
      ]),
      killCriteria: expect.arrayContaining([
        'net_carry_after_stressed_unwind_cost<=0 for two non-overlapping 8h windows',
      ]),
    })
    expect(card(report, 'liquidation_aftermath_oi_confirmation')).toMatchObject({
      priority: 'high',
      decision: 'watch_only',
      requiredFeatures: expect.arrayContaining([
        'liquidation_event_quality',
        'open_interest_confirmation_lag',
      ]),
    })
    expect(card(report, 'kronos_forecast_shadow')).toMatchObject({
      priority: 'medium',
      decision: 'watch_only',
      rationale: expect.arrayContaining([
        'promotion_eligibility:research_only',
      ]),
    })
  })

  it('blocks the plan when core runtime inputs are missing', () => {
    const report = buildNextResearchHypothesisPlanReport({
      inputs: inputPaths(),
      retirement: null,
      alphaPool: null,
      systemStatus: null,
    })

    expect(report).toMatchObject({
      planStatus: 'blocked_missing_inputs',
      blockers: expect.arrayContaining([
        'research_line_retirement_missing',
        'alpha_pool_missing',
        'system_status_reason_chain_missing',
        'retirement_verdict_not_ready:missing',
      ]),
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      policyMutationAllowed: false,
    })
  })

  it('writes the plan artifact and sidecar manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-next-research-plan-'))
    const retirementPath = join(root, 'retirement.json')
    const alphaPoolPath = join(root, 'alpha.json')
    const systemStatusPath = join(root, 'status.json')
    const outputPath = join(root, 'plan.json')
    await writeFile(retirementPath, `${JSON.stringify(makeRetirement())}\n`, 'utf-8')
    await writeFile(alphaPoolPath, `${JSON.stringify(makeAlphaPool())}\n`, 'utf-8')
    await writeFile(systemStatusPath, `${JSON.stringify(makeSystemStatus())}\n`, 'utf-8')

    const report = await runNextResearchHypothesisPlan({
      retirementPath,
      alphaPoolPath,
      systemStatusPath,
      outputPath,
      json: false,
    })

    expect(report.planStatus).toBe('ready_for_research_only_experiments')
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written).toMatchObject({
      researchOnly: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      experimentCards: expect.arrayContaining([
        expect.objectContaining({ familyId: 'funding_carry_rebuild' }),
      ]),
    })
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'next_research_hypothesis_plan',
      businessStatus: 'warn',
      recordsIn: 3,
      recordsOut: 3,
      errorClass: 'retired_line_parameter_search_forbidden',
    })
  })
})

function inputPaths() {
  return {
    retirementPath: '/repo/data/research/research_line_retirement.latest.json',
    alphaPoolPath: '/repo/data/research/alpha_pool/latest.json',
    systemStatusPath: '/repo/data/runtime/system_status_reason_chain.latest.json',
  }
}

function card(report: ReturnType<typeof buildNextResearchHypothesisPlanReport>, familyId: string) {
  const item = report.experimentCards.find(candidate => candidate.familyId === familyId)
  expect(item).toBeDefined()
  return item!
}

function makeRetirement() {
  return {
    verdict: 'retire_current_line',
    lineHealth: 'retired',
    summary: {
      activeIncubationCandidates: 0,
      retirementRecommendedLines: 3,
    },
    primaryLine: {
      candidateId: 'rank_ic_signal_confidence_best_lb120_sec336_fwd72_mtf0.5',
    },
    requiredBeforeReactivation: [
      'new_alpha_hypothesis_or_materially_different_feature_set',
      'wfo_failed_window_ratio_lte_threshold_and_direction_stable',
    ],
    retiredLines: [
      {
        lineId: 'rank_ic_signal_confidence_best_lb120_sec336_fwd72_mtf0_5',
        killTriggers: [
          'primary:wfo_failed_window_ratio:0.8>0.3',
          'primary:wfo_direction_not_stable',
        ],
      },
      {
        lineId: 'liq_high_reversal_lb168_fwd72',
        killTriggers: [
          'wfo_failed_window_ratio:0.8>0.3',
          'wfo_direction_not_stable',
        ],
      },
    ],
  }
}

function makeAlphaPool() {
  return {
    artifactVersion: 'v1',
    generatedAt: '2026-05-05T00:00:00.000Z',
    symbol: 'runtime-multi-asset',
    entries: [
      alphaEntry('runtime_factor_funding_rate_v2', ['funding_rate_8h', 'funding_percentile_rank']),
      alphaEntry('runtime_factor_basis_v2', ['basis_pct', 'basis_percentile_rank']),
      alphaEntry('runtime_factor_liquidation_pressure_v2', ['funding_pressure', 'cascade_pressure', 'open_interest_pressure']),
    ],
  }
}

function alphaEntry(alphaId: string, featureNames: string[]) {
  return {
    alphaId,
    expression: alphaId,
    source: 'handcrafted',
    hypothesis: `${alphaId} hypothesis`,
    featureNames,
    trainWindow: { start: '1970-01-01T00:00:00.000Z', end: '2026-05-05T00:00:00.000Z' },
    testWindow: { start: '1970-01-01T00:00:00.000Z', end: '2026-05-05T00:00:00.000Z' },
    oosIc: 0,
    costAdjustedSharpe: 0,
    turnover: 0,
    acceptedForRuntime: true,
    regimeSummary: {},
  }
}

function makeSystemStatus() {
  return {
    generatedAt: '2026-05-05T00:00:00.000Z',
    effectiveActionability: 'research_only_blocked',
    overallPlanCompletionPct: 49,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    canPromote: false,
  }
}
