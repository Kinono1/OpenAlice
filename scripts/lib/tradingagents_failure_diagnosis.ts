import {
  buildTradingAgentsStageSnapshot,
  deriveDonorAggregateMetrics,
  deriveValidationQuestions,
  type TradingAgentsStageSnapshot,
} from './tradingagents_stage_assessment.js'

export type TradingAgentsFailureRootCause =
  | 'selection_path_misalignment'
  | 'state_conditional_concentration'
  | 'candidate_source_concentration'
  | 'sample_sparsity'
  | 'horizon_mismatch'
  | 'structural_instability'
  | 'measurement_variance_reduction_only'

export type DecisionConfidence = 'high' | 'medium' | 'low'
export type EvidenceCompleteness = 'sufficient' | 'partial' | 'weak'
export type StructuralFixDecision =
  | 'continue_structural_fix'
  | 'component_salvage_only'
  | 'archive_negative_result'
export type SalvageTaxonomy =
  | 'signal_component'
  | 'state_filter_component'
  | 'ranking_component'
  | 'risk_overlay_component'
  | 'evaluation_pattern_only'

export interface FailureDiagnosisRuleResult {
  id: string
  description: string
  passed: boolean
  confidence: DecisionConfidence
  evidence: string
  threshold?: number | string | null
  falsificationCondition: string
}

export interface FailureDiagnosisConfig {
  schemaVersion: 'tradingagents_failure_diagnosis_config.v1'
  primaryMetrics: string[]
  supportingMetrics: string[]
  thresholds: {
    significantFailedWindowRatioImprovement: number
    significantAverageDegradationImprovement: number
    usableMedianTradesPerWindow: number
    acceptableFailedWindowRatio: number
    highFailedWindowRatio: number
    acceptableAverageDegradation: number
    failureClusterRatioThreshold: number
    minimumProfileCountForSufficientEvidence: number
  }
  decisionPolicy: {
    structuralFixAllowedPrimaryCauses: TradingAgentsFailureRootCause[]
    structuralFixBlockingSecondaryCauses: TradingAgentsFailureRootCause[]
    minDecisionConfidenceForStructuralFix: DecisionConfidence
    requiredEvidenceCompletenessForStructuralFix: EvidenceCompleteness
  }
  structuralFixWhitelist: string[]
  structuralFixBlockedChanges: string[]
  salvageTaxonomy: SalvageTaxonomy[]
  stopConditions: string[]
  continueConditions: string[]
}

export interface FailureDiagnosisPayload {
  schemaVersion: 'tradingagents_failure_diagnosis.v1'
  generatedAt: string
  paradigmId: string
  poolProfile: string | null
  sourceValidationRuns: string | null
  sourceRouteMatrix: string | null
  sourceWfoSensitivity: string | null
  sourcePreRegisteredConfig: string | null
  stageSnapshot: TradingAgentsStageSnapshot
  evidenceCompleteness: EvidenceCompleteness
  decisionConfidence: DecisionConfidence
  primaryRootCause: TradingAgentsFailureRootCause
  secondaryContributors: TradingAgentsFailureRootCause[]
  falsificationConditions: string[]
  preRegisteredEvaluation: {
    primaryMetrics: string[]
    supportingMetrics: string[]
    stopConditions: string[]
    continueConditions: string[]
  }
  selectionPathSanity: {
    status: 'aligned' | 'misaligned' | 'partial'
    evidence: string[]
  }
  stateConditionalConcentration: {
    status: 'high' | 'moderate' | 'low' | 'unknown'
    longestFailureCluster: number | null
    clusterRatio: number | null
    evidence: string[]
  }
  candidateSourceConcentration: {
    status: 'high' | 'moderate' | 'low' | 'unknown'
    donorFamilyCount: number
    donorCorrelationBucketCount: number
    donorCandidateCount: number
    evidence: string[]
  }
  measurementVsEconomics: {
    status:
      | 'economic_robustness_improvement'
      | 'measurement_variance_reduction_only'
      | 'no_material_improvement'
      | 'unknown'
    evidence: string[]
  }
  ruleResults: FailureDiagnosisRuleResult[]
  structuralFixEligibility: {
    eligible: boolean
    whitelist: string[]
    blockedChanges: string[]
    reasons: string[]
  }
  salvageAssessment: {
    recommended: SalvageTaxonomy[]
    rationale: string[]
  }
  decision: StructuralFixDecision
}

interface DonorProfilePoint {
  profile: string
  failedWindowRatio: number | null
  averageDegradation: number | null
  medianTradesPerWindow: number | null
  diagnosisHints: string[]
}

export const DEFAULT_FAILURE_DIAGNOSIS_CONFIG: FailureDiagnosisConfig = {
  schemaVersion: 'tradingagents_failure_diagnosis_config.v1',
  primaryMetrics: [
    'failedWindowRatio',
    'averageDegradation',
    'medianTradesPerWindow',
    'portfolio.aggregateMetrics.meanPbo',
    'portfolio.aggregateMetrics.meanDsrProbability',
  ],
  supportingMetrics: [
    'diagnostics.donorOnlyAggregateMetrics',
    'candidatePoolDiagnostics.averageAbsoluteCorrelation',
    'releaseGate.failedChecks',
  ],
  thresholds: {
    significantFailedWindowRatioImprovement: 0.1,
    significantAverageDegradationImprovement: 0.2,
    usableMedianTradesPerWindow: 4,
    acceptableFailedWindowRatio: 0.5,
    highFailedWindowRatio: 0.6,
    acceptableAverageDegradation: 0.4,
    failureClusterRatioThreshold: 0.5,
    minimumProfileCountForSufficientEvidence: 3,
  },
  decisionPolicy: {
    structuralFixAllowedPrimaryCauses: ['horizon_mismatch'],
    structuralFixBlockingSecondaryCauses: [
      'structural_instability',
      'selection_path_misalignment',
    ],
    minDecisionConfidenceForStructuralFix: 'medium',
    requiredEvidenceCompletenessForStructuralFix: 'sufficient',
  },
  structuralFixWhitelist: ['oos horizon', 'train/oos ratio', 'min trades per window'],
  structuralFixBlockedChanges: [
    'signal construction',
    'feature set',
    'ranking logic',
    'threshold family',
    'rebalance rules',
    'exposure constraints',
    'candidate family definition',
  ],
  salvageTaxonomy: [
    'signal_component',
    'state_filter_component',
    'ranking_component',
    'risk_overlay_component',
    'evaluation_pattern_only',
  ],
  stopConditions: [
    'primaryRootCause is structural_instability with medium/high confidence',
    'best donor profile still exceeds acceptableFailedWindowRatio',
    'formal stage snapshot remains below Stage C',
  ],
  continueConditions: [
    'primaryRootCause is horizon_mismatch',
    'evidenceCompleteness is sufficient',
    'decisionConfidence is medium or high',
    'secondaryContributors do not include structural_instability',
  ],
}

export function diagnoseTradingAgentsFailureMechanism(params: {
  paradigmId: string
  poolProfile?: string | null
  validationRuns: Record<string, unknown> | null
  routeMatrix: Record<string, unknown> | null
  wfoSensitivity: Record<string, unknown> | null
  preRegisteredConfig?: FailureDiagnosisConfig
  sourceValidationRuns?: string | null
  sourceRouteMatrix?: string | null
  sourceWfoSensitivity?: string | null
  sourcePreRegisteredConfig?: string | null
  generatedAt?: string
}): FailureDiagnosisPayload {
  const config = params.preRegisteredConfig ?? DEFAULT_FAILURE_DIAGNOSIS_CONFIG
  const stageSnapshot = buildTradingAgentsStageSnapshot({
    validationRuns: params.validationRuns,
    routeMatrix: params.routeMatrix,
    wfoSensitivity: params.wfoSensitivity,
  })
  const evidenceCompleteness = deriveEvidenceCompleteness(
    params.validationRuns,
    params.routeMatrix,
    params.wfoSensitivity,
    config,
  )
  const decisionConfidence = deriveDecisionConfidence(
    evidenceCompleteness,
    params.validationRuns,
    params.wfoSensitivity,
  )
  const donorMetrics = params.validationRuns
    ? deriveDonorAggregateMetrics(params.validationRuns)
    : null
  const validationQuestions = params.validationRuns
    ? deriveValidationQuestions(params.validationRuns)
    : {
        donorLeadsNonControls: null,
        controlsAreStrongerThanDonor: null,
        donorSelfPassesThresholds: null,
      }
  const donorProfiles = extractDonorProfiles(params.wfoSensitivity)
  const selectionPathSanity = buildSelectionPathSanity(
    params.routeMatrix,
    validationQuestions,
  )
  const stateConditionalConcentration = buildStateConditionalConcentration(
    donorProfiles,
    config,
  )
  const candidateSourceConcentration = buildCandidateSourceConcentration(
    params.validationRuns,
  )
  const measurementVsEconomics = buildMeasurementVsEconomics(
    donorMetrics,
    validationQuestions,
  )

  const primaryRootCause = determinePrimaryRootCause({
    donorMetrics,
    donorProfiles,
    selectionPathSanity,
    stateConditionalConcentration,
    candidateSourceConcentration,
    measurementVsEconomics,
    config,
  })
  const secondaryContributors = determineSecondaryContributors({
    primaryRootCause,
    donorProfiles,
    selectionPathSanity,
    stateConditionalConcentration,
    candidateSourceConcentration,
    config,
  })
  const ruleResults = buildRuleResults({
    primaryRootCause,
    donorMetrics,
    donorProfiles,
    stateConditionalConcentration,
    selectionPathSanity,
    evidenceCompleteness,
    decisionConfidence,
    config,
  })
  const structuralFixEligibility = buildStructuralFixEligibility({
    primaryRootCause,
    secondaryContributors,
    evidenceCompleteness,
    decisionConfidence,
    config,
  })
  const salvageAssessment = buildSalvageAssessment({
    primaryRootCause,
    secondaryContributors,
    structuralFixEligibility: structuralFixEligibility.eligible,
  })
  const decision: StructuralFixDecision = structuralFixEligibility.eligible
    ? 'continue_structural_fix'
    : salvageAssessment.recommended.length > 0
      ? 'component_salvage_only'
      : 'archive_negative_result'

  return {
    schemaVersion: 'tradingagents_failure_diagnosis.v1',
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    paradigmId: params.paradigmId,
    poolProfile: params.poolProfile ?? null,
    sourceValidationRuns: params.sourceValidationRuns ?? null,
    sourceRouteMatrix: params.sourceRouteMatrix ?? null,
    sourceWfoSensitivity: params.sourceWfoSensitivity ?? null,
    sourcePreRegisteredConfig: params.sourcePreRegisteredConfig ?? null,
    stageSnapshot,
    evidenceCompleteness,
    decisionConfidence,
    primaryRootCause,
    secondaryContributors,
    falsificationConditions: ruleResults.filter((rule) => !rule.passed).map((rule) => rule.falsificationCondition),
    preRegisteredEvaluation: {
      primaryMetrics: config.primaryMetrics,
      supportingMetrics: config.supportingMetrics,
      stopConditions: config.stopConditions,
      continueConditions: config.continueConditions,
    },
    selectionPathSanity,
    stateConditionalConcentration,
    candidateSourceConcentration,
    measurementVsEconomics,
    ruleResults,
    structuralFixEligibility,
    salvageAssessment,
    decision,
  }
}

function deriveEvidenceCompleteness(
  validationRuns: Record<string, unknown> | null,
  routeMatrix: Record<string, unknown> | null,
  wfoSensitivity: Record<string, unknown> | null,
  config: FailureDiagnosisConfig,
): EvidenceCompleteness {
  let score = 0
  if (validationRuns) score += 1
  if (routeMatrix) score += 1
  const profileCount = extractDonorProfiles(wfoSensitivity).length
  if (profileCount > 0) score += 1
  if (profileCount >= config.thresholds.minimumProfileCountForSufficientEvidence) score += 0.25
  return score >= 3 ? 'sufficient' : score >= 1.5 ? 'partial' : 'weak'
}

function deriveDecisionConfidence(
  completeness: EvidenceCompleteness,
  validationRuns: Record<string, unknown> | null,
  wfoSensitivity: Record<string, unknown> | null,
): DecisionConfidence {
  const donorProfiles = extractDonorProfiles(wfoSensitivity)
  const hasValidation = Boolean(validationRuns)
  if (completeness === 'sufficient' && donorProfiles.length >= 3 && hasValidation) {
    return 'high'
  }
  if (completeness === 'partial' || (donorProfiles.length >= 1 && hasValidation)) {
    return 'medium'
  }
  return 'low'
}

function buildSelectionPathSanity(
  routeMatrix: Record<string, unknown> | null,
  validationQuestions: { donorLeadsNonControls: boolean | null; controlsAreStrongerThanDonor: boolean | null },
): FailureDiagnosisPayload['selectionPathSanity'] {
  const recommendedProfile = asString(routeMatrix?.recommendedProfile)
  const evidence: string[] = []
  if (recommendedProfile) {
    evidence.push(`recommendedProfile=${recommendedProfile}`)
  }
  if (validationQuestions.controlsAreStrongerThanDonor === true) {
    evidence.push('controls are stronger than donor')
    return { status: 'misaligned', evidence }
  }
  if (recommendedProfile && validationQuestions.donorLeadsNonControls === true) {
    evidence.push('route recommendation exists and donor leadership remains positive')
    return { status: 'aligned', evidence }
  }
  if (recommendedProfile || validationQuestions.donorLeadsNonControls !== null) {
    evidence.push('only partial route-vs-leadership evidence is available')
    return { status: 'partial', evidence }
  }
  return { status: 'partial', evidence: ['selection path evidence unavailable'] }
}

function buildStateConditionalConcentration(
  donorProfiles: DonorProfilePoint[],
  config: FailureDiagnosisConfig,
): FailureDiagnosisPayload['stateConditionalConcentration'] {
  if (donorProfiles.length < 1) {
    return {
      status: 'unknown',
      longestFailureCluster: null,
      clusterRatio: null,
      evidence: ['no donor sensitivity profiles available'],
    }
  }
  const bad = donorProfiles.map((profile) =>
    (profile.failedWindowRatio ?? 1) > config.thresholds.acceptableFailedWindowRatio,
  )
  let longest = 0
  let current = 0
  for (const flag of bad) {
    current = flag ? current + 1 : 0
    longest = Math.max(longest, current)
  }
  const clusterRatio = bad.filter(Boolean).length / bad.length
  const status =
    clusterRatio > config.thresholds.failureClusterRatioThreshold
      ? 'high'
      : clusterRatio >= 0.25
        ? 'moderate'
        : 'low'
  return {
    status,
    longestFailureCluster: longest,
    clusterRatio,
    evidence: donorProfiles.map((profile) => {
      const failedWindowRatio =
        profile.failedWindowRatio === null ? 'n/a' : profile.failedWindowRatio.toFixed(4)
      return `${profile.profile}: failedWindowRatio=${failedWindowRatio}`
    }),
  }
}

function buildCandidateSourceConcentration(
  validationRuns: Record<string, unknown> | null,
): FailureDiagnosisPayload['candidateSourceConcentration'] {
  const donors = validationRuns ? extractDonorCandidates(validationRuns) : []
  const familyCount = new Set(
    donors.map((donor) => asString(donor.familyKey)).filter((value): value is string => Boolean(value)),
  ).size
  const bucketCount = new Set(
    donors
      .map((donor) => asString(donor.correlationBucket))
      .filter((value): value is string => Boolean(value)),
  ).size
  const donorCandidateCount = donors.length
  let status: FailureDiagnosisPayload['candidateSourceConcentration']['status'] = 'unknown'
  if (donorCandidateCount > 0) {
    status =
      familyCount <= 1 || bucketCount <= 1
        ? 'high'
        : familyCount <= 2 || bucketCount <= 2
          ? 'moderate'
          : 'low'
  }
  return {
    status,
    donorFamilyCount: familyCount,
    donorCorrelationBucketCount: bucketCount,
    donorCandidateCount,
    evidence:
      donorCandidateCount > 0
        ? [
            `donorFamilyCount=${familyCount}`,
            `donorCorrelationBucketCount=${bucketCount}`,
            `donorCandidateCount=${donorCandidateCount}`,
          ]
        : ['no donor candidates available'],
  }
}

function buildMeasurementVsEconomics(
  donorMetrics: ReturnType<typeof deriveDonorAggregateMetrics>,
  validationQuestions: { donorLeadsNonControls: boolean | null; controlsAreStrongerThanDonor: boolean | null },
): FailureDiagnosisPayload['measurementVsEconomics'] {
  if (!donorMetrics) {
    return { status: 'unknown', evidence: ['donor aggregate metrics unavailable'] }
  }
  const evidence = [
    `meanPbo=${donorMetrics.meanPbo.toFixed(4)}`,
    `meanDsrProbability=${donorMetrics.meanDsrProbability.toFixed(4)}`,
    `fdrQ=${donorMetrics.fdrQ.toFixed(4)}`,
  ]
  if (
    donorMetrics.meanDsrProbability >= 0.5 &&
    donorMetrics.fdrQ <= 0.1 &&
    donorMetrics.meanPbo > 0.2
  ) {
    evidence.push('risk-adjusted signal exists but overfitting / instability remains high')
    return { status: 'measurement_variance_reduction_only', evidence }
  }
  if (
    validationQuestions.donorLeadsNonControls === true &&
    validationQuestions.controlsAreStrongerThanDonor === false &&
    donorMetrics.meanPbo <= 0.2
  ) {
    evidence.push('donor improves economics, not only measurement')
    return { status: 'economic_robustness_improvement', evidence }
  }
  evidence.push('donor does not demonstrate material economic robustness improvement')
  return { status: 'no_material_improvement', evidence }
}

function determinePrimaryRootCause(input: {
  donorMetrics: ReturnType<typeof deriveDonorAggregateMetrics>
  donorProfiles: DonorProfilePoint[]
  selectionPathSanity: FailureDiagnosisPayload['selectionPathSanity']
  stateConditionalConcentration: FailureDiagnosisPayload['stateConditionalConcentration']
  candidateSourceConcentration: FailureDiagnosisPayload['candidateSourceConcentration']
  measurementVsEconomics: FailureDiagnosisPayload['measurementVsEconomics']
  config: FailureDiagnosisConfig
}): TradingAgentsFailureRootCause {
  const shortProfile = input.donorProfiles[0] ?? null
  const longProfile = input.donorProfiles[input.donorProfiles.length - 1] ?? null
  const horizonImproves =
    shortProfile &&
    longProfile &&
    shortProfile.failedWindowRatio !== null &&
    longProfile.failedWindowRatio !== null &&
    shortProfile.failedWindowRatio - longProfile.failedWindowRatio >=
      input.config.thresholds.significantFailedWindowRatioImprovement &&
    (longProfile.medianTradesPerWindow ?? 0) >= input.config.thresholds.usableMedianTradesPerWindow &&
    (longProfile.failedWindowRatio ?? 1) <= input.config.thresholds.acceptableFailedWindowRatio

  if (horizonImproves) {
    return 'horizon_mismatch'
  }
  if (input.measurementVsEconomics.status === 'measurement_variance_reduction_only') {
    return 'measurement_variance_reduction_only'
  }
  if (input.selectionPathSanity.status === 'misaligned') {
    return 'selection_path_misalignment'
  }
  if (input.candidateSourceConcentration.status === 'high') {
    return 'candidate_source_concentration'
  }
  if (input.stateConditionalConcentration.status === 'high') {
    return 'structural_instability'
  }
  if (
    longProfile &&
    ((longProfile.medianTradesPerWindow ?? 0) < input.config.thresholds.usableMedianTradesPerWindow ||
      longProfile.diagnosisHints.some((hint) => hint.includes('sparse')))
  ) {
    return 'sample_sparsity'
  }
  return 'structural_instability'
}

function determineSecondaryContributors(input: {
  primaryRootCause: TradingAgentsFailureRootCause
  donorProfiles: DonorProfilePoint[]
  selectionPathSanity: FailureDiagnosisPayload['selectionPathSanity']
  stateConditionalConcentration: FailureDiagnosisPayload['stateConditionalConcentration']
  candidateSourceConcentration: FailureDiagnosisPayload['candidateSourceConcentration']
  config: FailureDiagnosisConfig
}): TradingAgentsFailureRootCause[] {
  const contributors = new Set<TradingAgentsFailureRootCause>()
  if (
    input.donorProfiles.some(
      (profile) =>
        (profile.medianTradesPerWindow ?? 0) < input.config.thresholds.usableMedianTradesPerWindow ||
        profile.diagnosisHints.some((hint) => hint.includes('sparse')),
    )
  ) {
    contributors.add('sample_sparsity')
  }
  if (input.selectionPathSanity.status === 'misaligned') {
    contributors.add('selection_path_misalignment')
  }
  if (input.stateConditionalConcentration.status === 'high') {
    contributors.add('structural_instability')
  }
  if (input.candidateSourceConcentration.status === 'high') {
    contributors.add('candidate_source_concentration')
  }
  contributors.delete(input.primaryRootCause)
  return Array.from(contributors)
}

function buildRuleResults(input: {
  primaryRootCause: TradingAgentsFailureRootCause
  donorMetrics: ReturnType<typeof deriveDonorAggregateMetrics>
  donorProfiles: DonorProfilePoint[]
  stateConditionalConcentration: FailureDiagnosisPayload['stateConditionalConcentration']
  selectionPathSanity: FailureDiagnosisPayload['selectionPathSanity']
  evidenceCompleteness: EvidenceCompleteness
  decisionConfidence: DecisionConfidence
  config: FailureDiagnosisConfig
}): FailureDiagnosisRuleResult[] {
  const longProfile = input.donorProfiles[input.donorProfiles.length - 1] ?? null
  return [
    {
      id: 'primary_root_cause_is_horizon_mismatch',
      description: 'Primary root cause is horizon mismatch',
      passed: input.primaryRootCause === 'horizon_mismatch',
      confidence: input.decisionConfidence,
      evidence: `primaryRootCause=${input.primaryRootCause}`,
      falsificationCondition: 'Primary root cause changes away from horizon_mismatch',
    },
    {
      id: 'long_profile_within_failed_window_threshold',
      description: 'Best long-OOS donor profile is within failed-window threshold',
      passed:
        (longProfile?.failedWindowRatio ?? 1) <=
        input.config.thresholds.acceptableFailedWindowRatio,
      confidence: input.decisionConfidence,
      evidence:
        longProfile?.failedWindowRatio === null || longProfile === null
          ? 'No long-OOS donor profile available'
          : `failedWindowRatio=${longProfile.failedWindowRatio.toFixed(4)}`,
      threshold: input.config.thresholds.acceptableFailedWindowRatio,
      falsificationCondition: 'Long-OOS failedWindowRatio exceeds acceptable threshold',
    },
    {
      id: 'structural_instability_not_dominant',
      description: 'Structural instability is not dominant',
      passed: input.stateConditionalConcentration.status !== 'high',
      confidence: input.decisionConfidence,
      evidence: `stateConditionalConcentration=${input.stateConditionalConcentration.status}`,
      falsificationCondition: 'State-conditional concentration becomes high',
    },
    {
      id: 'selection_path_not_misaligned',
      description: 'Selection path is not misaligned',
      passed: input.selectionPathSanity.status !== 'misaligned',
      confidence: input.decisionConfidence,
      evidence: `selectionPathSanity=${input.selectionPathSanity.status}`,
      falsificationCondition: 'Selection path becomes misaligned',
    },
    {
      id: 'evidence_is_sufficient',
      description: 'Evidence completeness is sufficient',
      passed: input.evidenceCompleteness === 'sufficient',
      confidence: input.decisionConfidence,
      evidence: `evidenceCompleteness=${input.evidenceCompleteness}`,
      falsificationCondition: 'Evidence completeness degrades below sufficient',
    },
    {
      id: 'donor_metrics_present',
      description: 'Donor aggregate metrics are present',
      passed: input.donorMetrics !== null,
      confidence: input.decisionConfidence,
      evidence:
        input.donorMetrics === null
          ? 'Donor aggregate metrics unavailable'
          : `fdrQ=${input.donorMetrics.fdrQ.toFixed(4)}`,
      falsificationCondition: 'Donor aggregate metrics disappear or become unusable',
    },
  ]
}

function buildStructuralFixEligibility(input: {
  primaryRootCause: TradingAgentsFailureRootCause
  secondaryContributors: TradingAgentsFailureRootCause[]
  evidenceCompleteness: EvidenceCompleteness
  decisionConfidence: DecisionConfidence
  config: FailureDiagnosisConfig
}): FailureDiagnosisPayload['structuralFixEligibility'] {
  const allowedPrimary =
    input.config.decisionPolicy.structuralFixAllowedPrimaryCauses.includes(
      input.primaryRootCause,
    )
  const blockedSecondaries = input.secondaryContributors.filter((cause) =>
    input.config.decisionPolicy.structuralFixBlockingSecondaryCauses.includes(cause),
  )
  const confidenceOk =
    rankConfidence(input.decisionConfidence) >=
    rankConfidence(input.config.decisionPolicy.minDecisionConfidenceForStructuralFix)
  const completenessOk =
    rankEvidence(input.evidenceCompleteness) >=
    rankEvidence(input.config.decisionPolicy.requiredEvidenceCompletenessForStructuralFix)

  const reasons: string[] = []
  if (!allowedPrimary) {
    reasons.push(`primary root cause ${input.primaryRootCause} is not structural-fix eligible`)
  }
  if (blockedSecondaries.length > 0) {
    reasons.push(`blocking secondary contributors: ${blockedSecondaries.join(', ')}`)
  }
  if (!confidenceOk) {
    reasons.push(`decision confidence ${input.decisionConfidence} below required threshold`)
  }
  if (!completenessOk) {
    reasons.push(`evidence completeness ${input.evidenceCompleteness} below required threshold`)
  }

  return {
    eligible: reasons.length === 0,
    whitelist: input.config.structuralFixWhitelist,
    blockedChanges: input.config.structuralFixBlockedChanges,
    reasons,
  }
}

function buildSalvageAssessment(input: {
  primaryRootCause: TradingAgentsFailureRootCause
  secondaryContributors: TradingAgentsFailureRootCause[]
  structuralFixEligibility: boolean
}): FailureDiagnosisPayload['salvageAssessment'] {
  if (input.structuralFixEligibility) {
    return {
      recommended: ['evaluation_pattern_only'],
      rationale: ['A clean horizon-mismatch case only needs governance/evaluation carry-over.'],
    }
  }

  const recommended = new Set<SalvageTaxonomy>(['evaluation_pattern_only'])
  const rationale = ['Preserve the governance/evaluation pattern even when the donor remains blocked.']

  if (
    input.primaryRootCause === 'measurement_variance_reduction_only' ||
    input.secondaryContributors.includes('candidate_source_concentration')
  ) {
    recommended.add('signal_component')
    recommended.add('ranking_component')
    rationale.push('Signal and ranking fragments may still be reusable even though the donor lane is blocked.')
  }
  if (
    input.primaryRootCause === 'state_conditional_concentration' ||
    input.secondaryContributors.includes('structural_instability')
  ) {
    recommended.add('state_filter_component')
    rationale.push('State filters remain a plausible salvage surface.')
  }
  return {
    recommended: Array.from(recommended),
    rationale,
  }
}

function extractDonorCandidates(validationRuns: Record<string, unknown>): Record<string, unknown>[] {
  return asArray(validationRuns.symbols).flatMap((symbol) =>
    asArray(asRecord(symbol)?.candidates)
      .map((candidate) => asRecord(candidate))
      .filter((candidate): candidate is Record<string, unknown> => candidate?.role === 'donor'),
  )
}

function extractDonorProfiles(wfoSensitivity: Record<string, unknown> | null): DonorProfilePoint[] {
  return asArray(wfoSensitivity?.profiles).flatMap((profile) => {
    const profileName = asString(asRecord(profile)?.profile) ?? 'unknown'
    return asArray(asRecord(profile)?.candidates)
      .map((candidate) => asRecord(candidate))
      .filter((candidate): candidate is Record<string, unknown> => candidate?.role === 'donor')
      .map((candidate) => ({
        profile: profileName,
        failedWindowRatio: asNumber(candidate.failedWindowRatio),
        averageDegradation: asNumber(candidate.averageDegradation),
        medianTradesPerWindow: asNumber(candidate.medianTradesPerWindow),
        diagnosisHints: asArray(candidate.diagnosisHints).filter(
          (hint): hint is string => typeof hint === 'string',
        ),
      }))
  })
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function rankConfidence(value: DecisionConfidence): number {
  return value === 'high' ? 2 : value === 'medium' ? 1 : 0
}

function rankEvidence(value: EvidenceCompleteness): number {
  return value === 'sufficient' ? 2 : value === 'partial' ? 1 : 0
}
