import { describe, expect, it } from 'vitest'
import type { FailureDiagnosisPayload } from './tradingagents_failure_diagnosis.js'
import { summarizeTradingAgentsTerminalDecision } from './tradingagents_terminal_decision.js'

function buildPayload(
  overrides: Partial<FailureDiagnosisPayload>,
): FailureDiagnosisPayload {
  return {
    schemaVersion: 'tradingagents_failure_diagnosis.v1',
    generatedAt: '2026-04-02T00:00:00.000Z',
    paradigmId: 'tradingagents_research_sidecar_v2',
    poolProfile: 'baseline_guard_v1',
    sourceValidationRuns: '/tmp/validation.json',
    sourceRouteMatrix: '/tmp/route.json',
    sourceWfoSensitivity: '/tmp/wfo.json',
    sourcePreRegisteredConfig: '/tmp/config.json',
    stageSnapshot: {
      currentStage: 'A',
      currentStageStatus: 'pass',
      stages: [],
      recommendation: 'hold',
    },
    evidenceCompleteness: 'sufficient',
    decisionConfidence: 'high',
    primaryRootCause: 'horizon_mismatch',
    secondaryContributors: [],
    falsificationConditions: [],
    preRegisteredEvaluation: {
      primaryMetrics: ['failedWindowRatio'],
      supportingMetrics: ['diagnostics.donorOnlyAggregateMetrics'],
      stopConditions: ['structural instability persists'],
      continueConditions: ['horizon mismatch remains primary'],
    },
    selectionPathSanity: { status: 'aligned', evidence: [] },
    stateConditionalConcentration: {
      status: 'low',
      longestFailureCluster: 1,
      clusterRatio: 0.1,
      evidence: [],
    },
    candidateSourceConcentration: {
      status: 'low',
      donorFamilyCount: 2,
      donorCorrelationBucketCount: 2,
      donorCandidateCount: 2,
      evidence: [],
    },
    measurementVsEconomics: {
      status: 'economic_robustness_improvement',
      evidence: [],
    },
    ruleResults: [],
    structuralFixEligibility: {
      eligible: true,
      whitelist: ['oos horizon', 'train/oos ratio'],
      blockedChanges: ['signal construction'],
      reasons: [],
    },
    salvageAssessment: {
      recommended: ['evaluation_pattern_only'],
      rationale: ['Preserve the evaluation pattern.'],
    },
    decision: 'continue_structural_fix',
    ...overrides,
  }
}

describe('summarizeTradingAgentsTerminalDecision', () => {
  it('continues structural fix only when two clean horizon-mismatch pools qualify', () => {
    const summary = summarizeTradingAgentsTerminalDecision({
      paradigmId: 'tradingagents_research_sidecar_v2',
      diagnoses: [
        buildPayload({ poolProfile: 'pool_a', decisionConfidence: 'medium' }),
        buildPayload({ poolProfile: 'pool_b' }),
      ],
      diagnosisInputs: ['/tmp/pool_a.json', '/tmp/pool_b.json'],
    })

    expect(summary.terminalDecision).toBe('continue_structural_fix')
    expect(summary.terminalDecisionConfidence).toBe('medium')
    expect(summary.pooledSummary.structuralFixEligibleCount).toBe(2)
  })

  it('keeps component salvage when structural fix is closed but salvage remains', () => {
    const summary = summarizeTradingAgentsTerminalDecision({
      paradigmId: 'tradingagents_research_sidecar_v2',
      diagnoses: [
        buildPayload({
          poolProfile: 'pool_a',
          evidenceCompleteness: 'partial',
          decisionConfidence: 'medium',
          primaryRootCause: 'measurement_variance_reduction_only',
          secondaryContributors: ['structural_instability'],
          structuralFixEligibility: {
            eligible: false,
            whitelist: ['oos horizon'],
            blockedChanges: ['signal construction'],
            reasons: ['structural instability remains'],
          },
          salvageAssessment: {
            recommended: ['evaluation_pattern_only', 'signal_component', 'ranking_component'],
            rationale: ['Signal and ranking residue remain reusable.'],
          },
          decision: 'component_salvage_only',
        }),
        buildPayload({
          poolProfile: 'pool_b',
          primaryRootCause: 'selection_path_misalignment',
          secondaryContributors: ['structural_instability'],
          structuralFixEligibility: {
            eligible: false,
            whitelist: ['oos horizon'],
            blockedChanges: ['signal construction'],
            reasons: ['selection path is misaligned'],
          },
          salvageAssessment: {
            recommended: ['evaluation_pattern_only'],
            rationale: ['Only governance lessons remain.'],
          },
          decision: 'component_salvage_only',
        }),
      ],
    })

    expect(summary.terminalDecision).toBe('component_salvage_only')
    expect(summary.pooledSalvageTaxonomy).toEqual(
      expect.arrayContaining(['evaluation_pattern_only', 'signal_component', 'ranking_component']),
    )
  })
})
