import type {
  DecisionConfidence,
  EvidenceCompleteness,
  FailureDiagnosisPayload,
  SalvageTaxonomy,
  StructuralFixDecision,
} from './tradingagents_failure_diagnosis.js'

export interface TerminalDecisionPayload {
  schemaVersion: 'tradingagents_terminal_decision.v1'
  generatedAt: string
  paradigmId: string
  diagnosisInputs: string[]
  pooledSummary: {
    diagnosisCount: number
    structuralFixEligibleCount: number
    horizonMismatchCount: number
    structuralInstabilitySecondaryCount: number
    componentSalvageCount: number
    archiveCount: number
  }
  terminalDecision: StructuralFixDecision
  terminalDecisionConfidence: DecisionConfidence
  terminalEvidenceCompleteness: EvidenceCompleteness
  rationale: string[]
  pooledSalvageTaxonomy: SalvageTaxonomy[]
  diagnoses: Array<{
    poolProfile: string | null
    primaryRootCause: string
    secondaryContributors: string[]
    decisionConfidence: DecisionConfidence
    evidenceCompleteness: EvidenceCompleteness
    decision: StructuralFixDecision
    structuralFixEligible: boolean
  }>
}

export function summarizeTradingAgentsTerminalDecision(params: {
  paradigmId: string
  diagnoses: FailureDiagnosisPayload[]
  diagnosisInputs?: string[]
  generatedAt?: string
}): TerminalDecisionPayload {
  if (params.diagnoses.length < 1) {
    throw new Error('At least one diagnosis is required.')
  }
  const structuralFixEligibleCount = params.diagnoses.filter(
    (diagnosis) => diagnosis.structuralFixEligibility.eligible,
  ).length
  const horizonMismatchCount = params.diagnoses.filter(
    (diagnosis) => diagnosis.primaryRootCause === 'horizon_mismatch',
  ).length
  const structuralInstabilitySecondaryCount = params.diagnoses.filter((diagnosis) =>
    diagnosis.secondaryContributors.includes('structural_instability'),
  ).length
  const componentSalvageCount = params.diagnoses.filter(
    (diagnosis) => diagnosis.decision === 'component_salvage_only',
  ).length
  const archiveCount = params.diagnoses.filter(
    (diagnosis) => diagnosis.decision === 'archive_negative_result',
  ).length
  const pooledSalvageTaxonomy = Array.from(
    new Set(params.diagnoses.flatMap((diagnosis) => diagnosis.salvageAssessment.recommended)),
  )

  let terminalDecision: StructuralFixDecision
  const rationale: string[] = []
  if (
    structuralFixEligibleCount >= 2 &&
    horizonMismatchCount >= 2 &&
    structuralInstabilitySecondaryCount === 0
  ) {
    terminalDecision = 'continue_structural_fix'
    rationale.push('At least two pools independently support a single structural-fix lane.')
  } else if (
    componentSalvageCount > 0 ||
    pooledSalvageTaxonomy.some((item) => item !== 'evaluation_pattern_only')
  ) {
    terminalDecision = 'component_salvage_only'
    rationale.push('Structural fix is not justified across pools, but salvageable components remain.')
  } else {
    terminalDecision = 'archive_negative_result'
    rationale.push('No structural-fix path or salvage surface remains.')
  }

  const terminalDecisionConfidence = params.diagnoses.reduce<DecisionConfidence>(
    (lowest, diagnosis) =>
      rankConfidence(diagnosis.decisionConfidence) < rankConfidence(lowest)
        ? diagnosis.decisionConfidence
        : lowest,
    params.diagnoses[0].decisionConfidence,
  )
  const terminalEvidenceCompleteness = params.diagnoses.reduce<EvidenceCompleteness>(
    (lowest, diagnosis) =>
      rankEvidence(diagnosis.evidenceCompleteness) < rankEvidence(lowest)
        ? diagnosis.evidenceCompleteness
        : lowest,
    params.diagnoses[0].evidenceCompleteness,
  )

  return {
    schemaVersion: 'tradingagents_terminal_decision.v1',
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    paradigmId: params.paradigmId,
    diagnosisInputs: params.diagnosisInputs ?? [],
    pooledSummary: {
      diagnosisCount: params.diagnoses.length,
      structuralFixEligibleCount,
      horizonMismatchCount,
      structuralInstabilitySecondaryCount,
      componentSalvageCount,
      archiveCount,
    },
    terminalDecision,
    terminalDecisionConfidence,
    terminalEvidenceCompleteness,
    rationale,
    pooledSalvageTaxonomy,
    diagnoses: params.diagnoses.map((diagnosis) => ({
      poolProfile: diagnosis.poolProfile,
      primaryRootCause: diagnosis.primaryRootCause,
      secondaryContributors: diagnosis.secondaryContributors,
      decisionConfidence: diagnosis.decisionConfidence,
      evidenceCompleteness: diagnosis.evidenceCompleteness,
      decision: diagnosis.decision,
      structuralFixEligible: diagnosis.structuralFixEligibility.eligible,
    })),
  }
}

function rankConfidence(value: DecisionConfidence): number {
  return value === 'high' ? 2 : value === 'medium' ? 1 : 0
}

function rankEvidence(value: EvidenceCompleteness): number {
  return value === 'sufficient' ? 2 : value === 'partial' ? 1 : 0
}
