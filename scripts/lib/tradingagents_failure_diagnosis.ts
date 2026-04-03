import {
  buildTradingAgentsStageSnapshot,
  deriveDonorAggregateMetrics,
  deriveValidationQuestions,
  type TradingAgentsStageSnapshot,
} from "./tradingagents_stage_assessment.js";

export type TradingAgentsFailureRootCause =
  | "selection_path_misalignment"
  | "state_conditional_concentration"
  | "candidate_source_concentration"
  | "sample_sparsity"
  | "horizon_mismatch"
  | "structural_instability"
  | "measurement_variance_reduction_only";

export type DecisionConfidence = "high" | "medium" | "low";
export type EvidenceCompleteness = "sufficient" | "partial" | "weak";
export type StructuralFixDecision =
  | "continue_structural_fix"
  | "component_salvage_only"
  | "archive_negative_result";
export type SalvageTaxonomy =
  | "signal_component"
  | "state_filter_component"
  | "ranking_component"
  | "risk_overlay_component"
  | "evaluation_pattern_only";

export interface FailureDiagnosisRuleResult {
  id: string;
  description: string;
  passed: boolean;
  confidence: DecisionConfidence;
  evidence: string;
  threshold?: number | string | null;
  falsificationCondition: string;
}

export interface FailureDiagnosisConfig {
  schemaVersion: "tradingagents_failure_diagnosis_config.v1";
  primaryMetrics: string[];
  supportingMetrics: string[];
  thresholds: {
    significantFailedWindowRatioImprovement: number;
    significantAverageDegradationImprovement: number;
    usableMedianTradesPerWindow: number;
    acceptableFailedWindowRatio: number;
    highFailedWindowRatio: number;
    acceptableAverageDegradation: number;
    failureClusterRatioThreshold: number;
    minimumProfileCountForSufficientEvidence: number;
  };
  decisionPolicy: {
    structuralFixAllowedPrimaryCauses: TradingAgentsFailureRootCause[];
    structuralFixBlockingSecondaryCauses: TradingAgentsFailureRootCause[];
    minDecisionConfidenceForStructuralFix: DecisionConfidence;
    requiredEvidenceCompletenessForStructuralFix: EvidenceCompleteness;
  };
  structuralFixWhitelist: string[];
  structuralFixBlockedChanges: string[];
  salvageTaxonomy: SalvageTaxonomy[];
  stopConditions: string[];
  continueConditions: string[];
}

export interface FailureDiagnosisPayload {
  schemaVersion: "tradingagents_failure_diagnosis.v1";
  generatedAt: string;
  paradigmId: string;
  poolProfile: string | null;
  sourceValidationRuns: string | null;
  sourceRouteMatrix: string | null;
  sourceWfoSensitivity: string | null;
  sourcePreRegisteredConfig: string | null;
  stageSnapshot: TradingAgentsStageSnapshot;
  evidenceCompleteness: EvidenceCompleteness;
  decisionConfidence: DecisionConfidence;
  primaryRootCause: TradingAgentsFailureRootCause;
  secondaryContributors: TradingAgentsFailureRootCause[];
  falsificationConditions: string[];
  preRegisteredEvaluation: {
    primaryMetrics: string[];
    supportingMetrics: string[];
    stopConditions: string[];
    continueConditions: string[];
  };
  selectionPathSanity: {
    status: "aligned" | "misaligned" | "partial";
    evidence: string[];
  };
  stateConditionalConcentration: {
    status: "high" | "moderate" | "low" | "unknown";
    longestFailureCluster: number | null;
    clusterRatio: number | null;
    evidence: string[];
  };
  candidateSourceConcentration: {
    status: "high" | "moderate" | "low" | "unknown";
    donorFamilyCount: number;
    donorCorrelationBucketCount: number;
    donorCandidateCount: number;
    evidence: string[];
  };
  measurementVsEconomics: {
    status:
      | "economic_robustness_improvement"
      | "measurement_variance_reduction_only"
      | "no_material_improvement"
      | "unknown";
    evidence: string[];
  };
  ruleResults: FailureDiagnosisRuleResult[];
  structuralFixEligibility: {
    eligible: boolean;
    whitelist: string[];
    blockedChanges: string[];
    reasons: string[];
  };
  salvageAssessment: {
    recommended: SalvageTaxonomy[];
    rationale: string[];
  };
  decision: StructuralFixDecision;
}

interface DonorProfilePoint {
  profile: string;
  failedWindowRatio: number | null;
  averageDegradation: number | null;
  medianTradesPerWindow: number | null;
  diagnosisHints: string[];
}

interface RuleContext {
  config: FailureDiagnosisConfig;
  stageSnapshot: TradingAgentsStageSnapshot;
  validationRuns: Record<string, unknown> | null;
  routeMatrix: Record<string, unknown> | null;
  wfoSensitivity: Record<string, unknown> | null;
  donorSeries: DonorProfilePoint[];
  bestDonorPoint: DonorProfilePoint | null;
  shortDonorPoint: DonorProfilePoint | null;
  selectionPathSanity: FailureDiagnosisPayload["selectionPathSanity"];
  stateConditionalConcentration: FailureDiagnosisPayload["stateConditionalConcentration"];
  candidateSourceConcentration: FailureDiagnosisPayload["candidateSourceConcentration"];
  measurementVsEconomics: FailureDiagnosisPayload["measurementVsEconomics"];
}

export const DEFAULT_FAILURE_DIAGNOSIS_CONFIG: FailureDiagnosisConfig = {
  schemaVersion: "tradingagents_failure_diagnosis_config.v1",
  primaryMetrics: [
    "failedWindowRatio",
    "averageDegradation",
    "medianTradesPerWindow",
    "portfolio.aggregateMetrics.meanPbo",
    "portfolio.aggregateMetrics.meanDsrProbability",
  ],
  supportingMetrics: [
    "diagnostics.donorOnlyAggregateMetrics",
    "candidatePoolDiagnostics.averageAbsoluteCorrelation",
    "candidatePoolDiagnostics.topCorrelatedPairs",
    "releaseGate.failedChecks",
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
    structuralFixAllowedPrimaryCauses: ["horizon_mismatch"],
    structuralFixBlockingSecondaryCauses: [
      "structural_instability",
      "selection_path_misalignment",
    ],
    minDecisionConfidenceForStructuralFix: "medium",
    requiredEvidenceCompletenessForStructuralFix: "sufficient",
  },
  structuralFixWhitelist: [
    "oos horizon",
    "train/oos ratio",
    "min trades per window",
  ],
  structuralFixBlockedChanges: [
    "signal construction",
    "feature set",
    "ranking logic",
    "threshold family",
    "rebalance rules",
    "exposure constraints",
    "candidate family definition",
  ],
  salvageTaxonomy: [
    "signal_component",
    "state_filter_component",
    "ranking_component",
    "risk_overlay_component",
    "evaluation_pattern_only",
  ],
  stopConditions: [
    "primaryRootCause is structural_instability with medium/high confidence",
    "best donor profile still exceeds acceptableFailedWindowRatio",
    "formal stage snapshot remains below Stage C",
  ],
  continueConditions: [
    "primaryRootCause is horizon_mismatch",
    "evidenceCompleteness is sufficient",
    "decisionConfidence is medium or high",
    "secondaryContributors do not include structural_instability",
  ],
};

export function diagnoseTradingAgentsFailureMechanism(params: {
  paradigmId: string;
  poolProfile?: string | null;
  validationRuns: Record<string, unknown> | null;
  routeMatrix: Record<string, unknown> | null;
  wfoSensitivity: Record<string, unknown> | null;
  preRegisteredConfig?: FailureDiagnosisConfig;
  sourceValidationRuns?: string | null;
  sourceRouteMatrix?: string | null;
  sourceWfoSensitivity?: string | null;
  sourcePreRegisteredConfig?: string | null;
}): FailureDiagnosisPayload {
  const config = params.preRegisteredConfig ?? DEFAULT_FAILURE_DIAGNOSIS_CONFIG;
  const stageSnapshot = buildTradingAgentsStageSnapshot({
    validationRuns: params.validationRuns,
    routeMatrix: params.routeMatrix,
    wfoSensitivity: params.wfoSensitivity,
  });

  const donorSeries = extractDonorSeries(params.wfoSensitivity);
  const bestDonorPoint = selectBestDonorPoint(donorSeries);
  const shortDonorPoint =
    donorSeries.find((point) => point.profile === "native_short_test") ?? null;
  const evidenceCompleteness = evaluateEvidenceCompleteness(
    params.validationRuns,
    params.routeMatrix,
    donorSeries.length,
    config,
  );
  const selectionPathSanity = evaluateSelectionPathSanity(
    params.validationRuns,
    params.routeMatrix,
  );
  const stateConditionalConcentration = evaluateStateConditionalConcentration(
    params.validationRuns,
    config,
  );
  const candidateSourceConcentration = evaluateCandidateSourceConcentration(
    params.validationRuns,
  );
  const measurementVsEconomics = evaluateMeasurementVsEconomics(
    donorSeries,
    config,
  );

  const context: RuleContext = {
    config,
    stageSnapshot,
    validationRuns: params.validationRuns,
    routeMatrix: params.routeMatrix,
    wfoSensitivity: params.wfoSensitivity,
    donorSeries,
    bestDonorPoint,
    shortDonorPoint,
    selectionPathSanity,
    stateConditionalConcentration,
    candidateSourceConcentration,
    measurementVsEconomics,
  };

  const ruleResults = [
    evaluateSelectionPathMisalignment(context),
    evaluateStateConditionalConcentrationRule(context),
    evaluateCandidateSourceConcentrationRule(context),
    evaluateSampleSparsityRule(context),
    evaluateHorizonMismatchRule(context),
    evaluateStructuralInstabilityRule(context),
    evaluateMeasurementVarianceRule(context),
  ];

  const orderedPassingCauses = ruleResults.filter((rule) => rule.passed);
  const primaryRootCause = choosePrimaryRootCause(orderedPassingCauses);
  const secondaryContributors = orderedPassingCauses
    .map((rule) => mapRuleToCause(rule.id))
    .filter((cause): cause is TradingAgentsFailureRootCause => cause !== null)
    .filter((cause) => cause !== primaryRootCause);
  const decisionConfidence = evaluateDecisionConfidence(
    evidenceCompleteness,
    orderedPassingCauses,
  );
  const falsificationConditions = orderedPassingCauses.map(
    (rule) => rule.falsificationCondition,
  );
  const structuralFixEligibility = evaluateStructuralFixEligibility(
    primaryRootCause,
    secondaryContributors,
    decisionConfidence,
    evidenceCompleteness,
    config,
  );
  const salvageAssessment = evaluateSalvageAssessment(
    params.validationRuns,
    primaryRootCause,
    decisionConfidence,
  );
  const decision = evaluateDecision(
    structuralFixEligibility.eligible,
    params.validationRuns,
    decisionConfidence,
    salvageAssessment.recommended,
  );

  return {
    schemaVersion: "tradingagents_failure_diagnosis.v1",
    generatedAt: new Date().toISOString(),
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
    falsificationConditions,
    preRegisteredEvaluation: {
      primaryMetrics: [...config.primaryMetrics],
      supportingMetrics: [...config.supportingMetrics],
      stopConditions: [...config.stopConditions],
      continueConditions: [...config.continueConditions],
    },
    selectionPathSanity,
    stateConditionalConcentration,
    candidateSourceConcentration,
    measurementVsEconomics,
    ruleResults,
    structuralFixEligibility,
    salvageAssessment,
    decision,
  };
}

function extractDonorSeries(
  wfoSensitivity: Record<string, unknown> | null,
): DonorProfilePoint[] {
  if (!wfoSensitivity || !Array.isArray(wfoSensitivity.profiles)) {
    return [];
  }
  return wfoSensitivity.profiles
    .map((profile) => {
      if (!isPlainObject(profile)) {
        return null;
      }
      const donor = Array.isArray(profile.candidates)
        ? profile.candidates.find((candidate) => isDonorRecord(candidate))
        : null;
      if (!isPlainObject(donor)) {
        return null;
      }
      return {
        profile: typeof profile.profile === "string" ? profile.profile : "unknown",
        failedWindowRatio: toFiniteNumber(donor.failedWindowRatio),
        averageDegradation: toFiniteNumber(donor.averageDegradation),
        medianTradesPerWindow: toFiniteNumber(donor.medianTradesPerWindow),
        diagnosisHints: Array.isArray(donor.diagnosisHints)
          ? donor.diagnosisHints.filter(
              (hint): hint is string => typeof hint === "string",
            )
          : [],
      } satisfies DonorProfilePoint;
    })
    .filter((point): point is DonorProfilePoint => point !== null);
}

function selectBestDonorPoint(points: DonorProfilePoint[]): DonorProfilePoint | null {
  if (points.length < 1) {
    return null;
  }
  const sorted = [...points].sort((left, right) => {
    const leftFailure = left.failedWindowRatio ?? Number.POSITIVE_INFINITY;
    const rightFailure = right.failedWindowRatio ?? Number.POSITIVE_INFINITY;
    if (leftFailure !== rightFailure) {
      return leftFailure - rightFailure;
    }
    const leftDegradation = left.averageDegradation ?? Number.POSITIVE_INFINITY;
    const rightDegradation = right.averageDegradation ?? Number.POSITIVE_INFINITY;
    if (leftDegradation !== rightDegradation) {
      return leftDegradation - rightDegradation;
    }
    return (right.medianTradesPerWindow ?? 0) - (left.medianTradesPerWindow ?? 0);
  });
  return sorted[0] ?? null;
}

function evaluateEvidenceCompleteness(
  validationRuns: Record<string, unknown> | null,
  routeMatrix: Record<string, unknown> | null,
  donorProfileCount: number,
  config: FailureDiagnosisConfig,
): EvidenceCompleteness {
  const hasValidationRuns = validationRuns !== null;
  const hasRouteMatrix = routeMatrix !== null;
  const enoughProfiles =
    donorProfileCount >= config.thresholds.minimumProfileCountForSufficientEvidence;
  if (hasValidationRuns && hasRouteMatrix && enoughProfiles) {
    return "sufficient";
  }
  if ((hasValidationRuns && hasRouteMatrix) || (hasValidationRuns && enoughProfiles)) {
    return "partial";
  }
  return "weak";
}

function evaluateSelectionPathSanity(
  validationRuns: Record<string, unknown> | null,
  routeMatrix: Record<string, unknown> | null,
): FailureDiagnosisPayload["selectionPathSanity"] {
  const evidence: string[] = [];
  const diagnostics = validationRuns?.diagnostics as Record<string, unknown> | undefined;
  const directQuestions = diagnostics?.questions as Record<string, unknown> | undefined;
  const questions = validationRuns ? deriveValidationQuestions(validationRuns) : null;
  const controlsAreStronger = questions?.controlsAreStrongerThanDonor === true;
  const donorLeadsNonControls = questions?.donorLeadsNonControls === true;
  const hasDirectQuestions = !!directQuestions;
  const recommendedProfile =
    typeof routeMatrix?.recommendedProfile === "string"
      ? routeMatrix.recommendedProfile
      : null;
  const benchmarkAware = routeMatrixHasBenchmarkAwareProfile(routeMatrix);

  if (benchmarkAware) {
    evidence.push("Route matrix includes benchmark-aware profile wiring.");
  } else {
    evidence.push("Route matrix does not expose benchmark-aware profile wiring.");
  }
  if (donorLeadsNonControls) {
    evidence.push("Donor still leads non-control candidates.");
  }
  if (controlsAreStronger) {
    evidence.push("A stronger control still outperforms the donor.");
  }
  if (recommendedProfile) {
    evidence.push(`Recommended profile remains ${recommendedProfile}.`);
  }

  if (!validationRuns || !routeMatrix) {
    return { status: "partial", evidence };
  }
  if (controlsAreStronger || !benchmarkAware) {
    return { status: "misaligned", evidence };
  }
  if (!hasDirectQuestions) {
    evidence.push("Selection-path status uses derived fallback because diagnostics.questions is missing.");
    return { status: "partial", evidence };
  }
  return { status: "aligned", evidence };
}

function evaluateStateConditionalConcentration(
  validationRuns: Record<string, unknown> | null,
  config: FailureDiagnosisConfig,
): FailureDiagnosisPayload["stateConditionalConcentration"] {
  const donorWindows = extractDonorWindows(validationRuns);
  if (donorWindows.length < 1) {
    return {
      status: "unknown",
      longestFailureCluster: null,
      clusterRatio: null,
      evidence: ["Donor WFO windows unavailable."],
    };
  }
  const gatePassSequence = donorWindows.map((window) => window.gatePassed);
  const longestFailureCluster = longestFalseRun(gatePassSequence);
  const clusterRatio = longestFailureCluster / donorWindows.length;
  const evidence = [
    `Longest consecutive donor failure cluster = ${longestFailureCluster}/${donorWindows.length}.`,
  ];
  if (clusterRatio >= config.thresholds.failureClusterRatioThreshold) {
    evidence.push("Failure clustering exceeds the pre-registered concentration threshold.");
    return {
      status: "high",
      longestFailureCluster,
      clusterRatio,
      evidence,
    };
  }
  if (clusterRatio >= config.thresholds.failureClusterRatioThreshold / 2) {
    evidence.push("Failure clustering is present but below the high-concentration threshold.");
    return {
      status: "moderate",
      longestFailureCluster,
      clusterRatio,
      evidence,
    };
  }
  evidence.push("Failure clustering is limited.");
  return {
    status: "low",
    longestFailureCluster,
    clusterRatio,
    evidence,
  };
}

function evaluateCandidateSourceConcentration(
  validationRuns: Record<string, unknown> | null,
): FailureDiagnosisPayload["candidateSourceConcentration"] {
  const donorCandidates = extractDonorCandidates(validationRuns);
  const donorFamilyCount = new Set(
    donorCandidates
      .map((candidate) =>
        typeof candidate.familyKey === "string" ? candidate.familyKey : null,
      )
      .filter((value): value is string => value !== null),
  ).size;
  const donorCorrelationBucketCount = new Set(
    donorCandidates
      .map((candidate) =>
        typeof candidate.correlationBucket === "string"
          ? candidate.correlationBucket
          : null,
      )
      .filter((value): value is string => value !== null),
  ).size;
  const donorCandidateCount = donorCandidates.length;
  const evidence = [
    `Donor candidate count = ${donorCandidateCount}.`,
    `Donor family count = ${donorFamilyCount}.`,
    `Donor correlation bucket count = ${donorCorrelationBucketCount}.`,
  ];
  if (donorCandidateCount <= 1 && donorFamilyCount <= 1 && donorCorrelationBucketCount <= 1) {
    evidence.push("Donor evidence is concentrated into a single candidate/family/bucket path.");
    return {
      status: "high",
      donorFamilyCount,
      donorCorrelationBucketCount,
      donorCandidateCount,
      evidence,
    };
  }
  if (donorCandidateCount <= 2) {
    evidence.push("Donor evidence is still fairly concentrated.");
    return {
      status: "moderate",
      donorFamilyCount,
      donorCorrelationBucketCount,
      donorCandidateCount,
      evidence,
    };
  }
  evidence.push("Donor evidence is spread across multiple candidate paths.");
  return {
    status: "low",
    donorFamilyCount,
    donorCorrelationBucketCount,
    donorCandidateCount,
    evidence,
  };
}

function evaluateMeasurementVsEconomics(
  donorSeries: DonorProfilePoint[],
  config: FailureDiagnosisConfig,
): FailureDiagnosisPayload["measurementVsEconomics"] {
  const shortPoint =
    donorSeries.find((point) => point.profile === "native_short_test") ?? null;
  const bestPoint = selectBestDonorPoint(donorSeries);
  if (!shortPoint || !bestPoint) {
    return {
      status: "unknown",
      evidence: ["Insufficient donor WFO profile coverage to separate measurement vs economics."],
    };
  }
  const failedRatioImprovement =
    (shortPoint.failedWindowRatio ?? Number.NaN) -
    (bestPoint.failedWindowRatio ?? Number.NaN);
  const degradationImprovement =
    (shortPoint.averageDegradation ?? Number.NaN) -
    (bestPoint.averageDegradation ?? Number.NaN);
  const tradesImprovement =
    (bestPoint.medianTradesPerWindow ?? Number.NaN) -
    (shortPoint.medianTradesPerWindow ?? Number.NaN);
  const evidence = [
    `Best donor profile=${bestPoint.profile}. failedWindowRatio improvement=${formatNumber(
      failedRatioImprovement,
    )}, averageDegradation improvement=${formatNumber(
      degradationImprovement,
    )}, medianTrades improvement=${formatNumber(tradesImprovement)}.`,
  ];
  const enoughTradeDensity =
    (bestPoint.medianTradesPerWindow ?? 0) >=
    config.thresholds.usableMedianTradesPerWindow;
  const stillFailsHard =
    (bestPoint.failedWindowRatio ?? 1) >=
    config.thresholds.acceptableFailedWindowRatio;
  if (
    failedRatioImprovement >= config.thresholds.significantFailedWindowRatioImprovement &&
    degradationImprovement >= config.thresholds.significantAverageDegradationImprovement &&
    enoughTradeDensity &&
    !stillFailsHard
  ) {
    evidence.push("Best profile clears both improvement thresholds and usable trade density.");
    return { status: "economic_robustness_improvement", evidence };
  }
  if (tradesImprovement > 0 && enoughTradeDensity && stillFailsHard) {
    evidence.push(
      "Longer OOS increases usable trade density, but tail failure persists above acceptable bandwidth.",
    );
    return { status: "measurement_variance_reduction_only", evidence };
  }
  evidence.push("No material improvement in either economic robustness or measurement stability.");
  return { status: "no_material_improvement", evidence };
}

function evaluateSelectionPathMisalignment(
  context: RuleContext,
): FailureDiagnosisRuleResult {
  const passed = context.selectionPathSanity.status === "misaligned";
  return {
    id: "selection_path_misalignment",
    description: "Selection path or comparison surface is misaligned with the donor's intended validation target.",
    passed,
    confidence: passed ? "medium" : "low",
    evidence: context.selectionPathSanity.evidence.join(" "),
    threshold: "benchmark-aware route matrix + no stronger control",
    falsificationCondition:
      "If benchmark-aware route selection is present and no stronger control outperforms the donor, selection path misalignment should not remain primary.",
  };
}

function evaluateStateConditionalConcentrationRule(
  context: RuleContext,
): FailureDiagnosisRuleResult {
  const passed = context.stateConditionalConcentration.status === "high";
  return {
    id: "state_conditional_concentration",
    description: "Donor failures cluster into a narrow subset of WFO windows, suggesting state-conditional dependence.",
    passed,
    confidence: passed ? "medium" : "low",
    evidence: context.stateConditionalConcentration.evidence.join(" "),
    threshold: context.config.thresholds.failureClusterRatioThreshold,
    falsificationCondition:
      "If donor failure clusters stay below the registered cluster-ratio threshold, this rule should not pass.",
  };
}

function evaluateCandidateSourceConcentrationRule(
  context: RuleContext,
): FailureDiagnosisRuleResult {
  const passed = context.candidateSourceConcentration.status === "high";
  return {
    id: "candidate_source_concentration",
    description: "Donor evidence is concentrated into a single candidate/family/bucket path.",
    passed,
    confidence: passed ? "medium" : "low",
    evidence: context.candidateSourceConcentration.evidence.join(" "),
    threshold: "candidateCount<=1 && familyCount<=1 && bucketCount<=1",
    falsificationCondition:
      "If donor evidence spans multiple candidate/family/bucket paths, source concentration should not remain primary.",
  };
}

function evaluateSampleSparsityRule(
  context: RuleContext,
): FailureDiagnosisRuleResult {
  const shortTrades = context.shortDonorPoint?.medianTradesPerWindow ?? 0;
  const bestTrades = context.bestDonorPoint?.medianTradesPerWindow ?? 0;
  const passed =
    shortTrades < context.config.thresholds.usableMedianTradesPerWindow &&
    bestTrades >= context.config.thresholds.usableMedianTradesPerWindow;
  return {
    id: "sample_sparsity",
    description: "Shorter OOS windows under-sample donor behavior relative to the usable trades-per-window threshold.",
    passed,
    confidence: passed ? "medium" : "low",
    evidence: `Short profile median trades=${formatNumber(shortTrades)}; best profile median trades=${formatNumber(bestTrades)}; usable threshold=${context.config.thresholds.usableMedianTradesPerWindow}.`,
    threshold: context.config.thresholds.usableMedianTradesPerWindow,
    falsificationCondition:
      "If median trades do not move from below to above the usable threshold across profiles, sample sparsity should not pass.",
  };
}

function evaluateHorizonMismatchRule(
  context: RuleContext,
): FailureDiagnosisRuleResult {
  const shortPoint = context.shortDonorPoint;
  const bestPoint = context.bestDonorPoint;
  const failedImprovement =
    (shortPoint?.failedWindowRatio ?? Number.NaN) -
    (bestPoint?.failedWindowRatio ?? Number.NaN);
  const degradationImprovement =
    (shortPoint?.averageDegradation ?? Number.NaN) -
    (bestPoint?.averageDegradation ?? Number.NaN);
  const enoughTradeDensity =
    (bestPoint?.medianTradesPerWindow ?? 0) >=
    context.config.thresholds.usableMedianTradesPerWindow;
  const stillFailsHard =
    (bestPoint?.failedWindowRatio ?? 1) >=
    context.config.thresholds.acceptableFailedWindowRatio;
  const passed =
    failedImprovement >=
      context.config.thresholds.significantFailedWindowRatioImprovement &&
    degradationImprovement >=
      context.config.thresholds.significantAverageDegradationImprovement &&
    enoughTradeDensity &&
    !stillFailsHard;
  return {
    id: "horizon_mismatch",
    description: "Longer OOS windows materially improve donor behavior enough to treat the current validation horizon as misaligned.",
    passed,
    confidence: passed ? "medium" : "low",
    evidence: `Failed-window improvement=${formatNumber(
      failedImprovement,
    )}; degradation improvement=${formatNumber(
      degradationImprovement,
    )}; best donor profile=${bestPoint?.profile ?? "n/a"}; acceptable failed-window ratio=${context.config.thresholds.acceptableFailedWindowRatio}.`,
    threshold: `failedWindowRatio>=${context.config.thresholds.significantFailedWindowRatioImprovement} and averageDegradation>=${context.config.thresholds.significantAverageDegradationImprovement}`,
    falsificationCondition:
      "If longer OOS windows improve trades but still leave donor failure ratio above the acceptable threshold, horizon mismatch should not be primary.",
  };
}

function evaluateStructuralInstabilityRule(
  context: RuleContext,
): FailureDiagnosisRuleResult {
  const donorAggregate = context.validationRuns
    ? deriveDonorAggregateMetrics(context.validationRuns)
    : null;
  const maxFailedWindowRatio = donorAggregate?.maxFailedWindowRatio ?? null;
  const bestFailedRatio = context.bestDonorPoint?.failedWindowRatio ?? null;
  const stageBlockedBeforeD = context.stageSnapshot.currentStage !== "D";
  const passed =
    stageBlockedBeforeD &&
    ((bestFailedRatio ?? 1) >= context.config.thresholds.acceptableFailedWindowRatio ||
      (maxFailedWindowRatio ?? 1) >= context.config.thresholds.highFailedWindowRatio);
  return {
    id: "structural_instability",
    description: "Best donor profile still fails robustness bandwidth after profile exploration.",
    passed,
    confidence: passed ? "high" : "low",
    evidence: `Best donor failedWindowRatio=${formatNumber(
      bestFailedRatio,
    )}; donor-only maxFailedWindowRatio=${formatNumber(
      maxFailedWindowRatio,
    )}; currentStage=${context.stageSnapshot.currentStage}.`,
    threshold: context.config.thresholds.acceptableFailedWindowRatio,
    falsificationCondition:
      "If the best donor profile moves below the acceptable failed-window ratio and stage snapshot advances, structural instability should not pass.",
  };
}

function evaluateMeasurementVarianceRule(
  context: RuleContext,
): FailureDiagnosisRuleResult {
  const passed =
    context.measurementVsEconomics.status ===
    "measurement_variance_reduction_only";
  return {
    id: "measurement_variance_reduction_only",
    description: "Longer OOS windows mostly reduce measurement noise rather than improving economic robustness.",
    passed,
    confidence: passed ? "medium" : "low",
    evidence: context.measurementVsEconomics.evidence.join(" "),
    threshold: "usable trade density improves while acceptable failure bandwidth remains unmet",
    falsificationCondition:
      "If tail failure persistence disappears together with better trade density, this rule should not pass.",
  };
}

function choosePrimaryRootCause(
  passingRules: FailureDiagnosisRuleResult[],
): TradingAgentsFailureRootCause {
  const priority: TradingAgentsFailureRootCause[] = [
    "selection_path_misalignment",
    "measurement_variance_reduction_only",
    "horizon_mismatch",
    "state_conditional_concentration",
    "sample_sparsity",
    "candidate_source_concentration",
    "structural_instability",
  ];
  for (const cause of priority) {
    if (passingRules.some((rule) => mapRuleToCause(rule.id) === cause)) {
      return cause;
    }
  }
  return "structural_instability";
}

function evaluateDecisionConfidence(
  evidenceCompleteness: EvidenceCompleteness,
  passingRules: FailureDiagnosisRuleResult[],
): DecisionConfidence {
  if (evidenceCompleteness === "sufficient") {
    const mediumOrHighCount = passingRules.filter(
      (rule) => rule.confidence === "medium" || rule.confidence === "high",
    ).length;
    if (mediumOrHighCount >= 2) {
      return "high";
    }
    if (mediumOrHighCount >= 1) {
      return "medium";
    }
  }
  if (evidenceCompleteness === "partial" && passingRules.length >= 1) {
    return "medium";
  }
  return "low";
}

function evaluateStructuralFixEligibility(
  primaryRootCause: TradingAgentsFailureRootCause,
  secondaryContributors: TradingAgentsFailureRootCause[],
  decisionConfidence: DecisionConfidence,
  evidenceCompleteness: EvidenceCompleteness,
  config: FailureDiagnosisConfig,
): FailureDiagnosisPayload["structuralFixEligibility"] {
  const reasons: string[] = [];
  const primaryAllowed = config.decisionPolicy.structuralFixAllowedPrimaryCauses.includes(
    primaryRootCause,
  );
  if (!primaryAllowed) {
    reasons.push(`Primary root cause ${primaryRootCause} is not on the structural-fix allowlist.`);
  }
  const hasBlockingSecondary = secondaryContributors.some((cause) =>
    config.decisionPolicy.structuralFixBlockingSecondaryCauses.includes(cause),
  );
  if (hasBlockingSecondary) {
    reasons.push("Secondary contributors include a structural-fix blocker.");
  }
  if (!meetsConfidenceFloor(decisionConfidence, config.decisionPolicy.minDecisionConfidenceForStructuralFix)) {
    reasons.push(`Decision confidence ${decisionConfidence} is below the structural-fix floor.`);
  }
  if (!meetsEvidenceFloor(evidenceCompleteness, config.decisionPolicy.requiredEvidenceCompletenessForStructuralFix)) {
    reasons.push(`Evidence completeness ${evidenceCompleteness} is below the structural-fix floor.`);
  }
  return {
    eligible: reasons.length < 1,
    whitelist: [...config.structuralFixWhitelist],
    blockedChanges: [...config.structuralFixBlockedChanges],
    reasons,
  };
}

function evaluateSalvageAssessment(
  validationRuns: Record<string, unknown> | null,
  primaryRootCause: TradingAgentsFailureRootCause,
  decisionConfidence: DecisionConfidence,
): FailureDiagnosisPayload["salvageAssessment"] {
  const questions = validationRuns ? deriveValidationQuestions(validationRuns) : null;
  const donorMetrics = validationRuns ? deriveDonorAggregateMetrics(validationRuns) : null;
  const donorFdr = donorMetrics?.fdrQ ?? null;
  const donorDsr = donorMetrics?.meanDsrProbability ?? null;
  const donorLeadsNonControls = questions?.donorLeadsNonControls === true;
  const recommended = new Set<SalvageTaxonomy>(["evaluation_pattern_only"]);
  const rationale = ["Always retain evaluation_pattern_only for future negative-result reuse."];
  if (donorLeadsNonControls && donorFdr !== null && donorFdr <= 0.1) {
    recommended.add("signal_component");
    rationale.push("Donor still leads non-control candidates with passing donor-only FDR.");
  }
  if (
    primaryRootCause === "state_conditional_concentration" ||
    primaryRootCause === "measurement_variance_reduction_only"
  ) {
    recommended.add("state_filter_component");
    rationale.push("Failure shape suggests conditional concentration worth isolating as a state filter.");
  }
  if (decisionConfidence !== "low" && donorDsr !== null && donorDsr >= 0.5) {
    recommended.add("ranking_component");
    rationale.push("Donor-only DSR remains non-trivial, so ranking heuristics may still be reusable.");
  }
  return {
    recommended: [...recommended],
    rationale,
  };
}

function evaluateDecision(
  structuralFixEligible: boolean,
  validationRuns: Record<string, unknown> | null,
  decisionConfidence: DecisionConfidence,
  salvageRecommendations: SalvageTaxonomy[],
): StructuralFixDecision {
  if (structuralFixEligible) {
    return "continue_structural_fix";
  }
  const diagnostics = validationRuns?.diagnostics as Record<string, unknown> | undefined;
  const questions = diagnostics?.questions as Record<string, unknown> | undefined;
  const donorLeadsNonControls = questions?.donorLeadsNonControls === true;
  if (
    donorLeadsNonControls ||
    salvageRecommendations.some((item) => item !== "evaluation_pattern_only") ||
    decisionConfidence !== "low"
  ) {
    return "component_salvage_only";
  }
  return "archive_negative_result";
}

function extractDonorWindows(
  validationRuns: Record<string, unknown> | null,
): Array<{ gatePassed: boolean }> {
  const symbols = Array.isArray(validationRuns?.symbols) ? validationRuns.symbols : [];
  for (const symbol of symbols) {
    if (!isPlainObject(symbol) || !Array.isArray(symbol.candidates)) {
      continue;
    }
    const donor = symbol.candidates.find((candidate) => isDonorRecord(candidate));
    if (!isPlainObject(donor)) {
      continue;
    }
    const wfo = donor.wfo as Record<string, unknown> | undefined;
    const windows = Array.isArray(wfo?.windows) ? wfo.windows : [];
    return windows
      .map((window) => {
        if (!isPlainObject(window)) {
          return null;
        }
        return { gatePassed: window.gatePassed === true };
      })
      .filter((value): value is { gatePassed: boolean } => value !== null);
  }
  return [];
}

function extractDonorCandidates(
  validationRuns: Record<string, unknown> | null,
): Array<Record<string, unknown>> {
  const symbols = Array.isArray(validationRuns?.symbols) ? validationRuns.symbols : [];
  return symbols.flatMap((symbol) => {
    if (!isPlainObject(symbol) || !Array.isArray(symbol.candidates)) {
      return [];
    }
    return symbol.candidates.filter((candidate) => isDonorRecord(candidate)) as Array<
      Record<string, unknown>
    >;
  });
}

function routeMatrixHasBenchmarkAwareProfile(
  routeMatrix: Record<string, unknown> | null,
): boolean {
  const profiles = Array.isArray(routeMatrix?.profiles) ? routeMatrix?.profiles : [];
  return profiles.some((profile) => {
    if (!isPlainObject(profile)) {
      return false;
    }
    const aggregate = profile.baseAggregateMetrics as Record<string, unknown> | undefined;
    const diagnostics = aggregate?.fdrDiagnostics as Record<string, unknown> | undefined;
    const symbolDiagnostics = diagnostics?.symbolDiagnostics as
      | Record<string, unknown>
      | undefined;
    const btc = symbolDiagnostics?.["BTC/USD"] as Record<string, unknown> | undefined;
    return typeof btc?.benchmarkStrategyId === "string" && btc.benchmarkStrategyId.length > 0;
  });
}

function longestFalseRun(values: boolean[]): number {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    if (value) {
      current = 0;
      continue;
    }
    current += 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

function mapRuleToCause(
  ruleId: string,
): TradingAgentsFailureRootCause | null {
  switch (ruleId) {
    case "selection_path_misalignment":
      return "selection_path_misalignment";
    case "state_conditional_concentration":
      return "state_conditional_concentration";
    case "candidate_source_concentration":
      return "candidate_source_concentration";
    case "sample_sparsity":
      return "sample_sparsity";
    case "horizon_mismatch":
      return "horizon_mismatch";
    case "structural_instability":
      return "structural_instability";
    case "measurement_variance_reduction_only":
      return "measurement_variance_reduction_only";
    default:
      return null;
  }
}

function meetsConfidenceFloor(
  actual: DecisionConfidence,
  expected: DecisionConfidence,
): boolean {
  const rank: Record<DecisionConfidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[actual] >= rank[expected];
}

function meetsEvidenceFloor(
  actual: EvidenceCompleteness,
  expected: EvidenceCompleteness,
): boolean {
  const rank: Record<EvidenceCompleteness, number> = {
    weak: 0,
    partial: 1,
    sufficient: 2,
  };
  return rank[actual] >= rank[expected];
}

function isDonorRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.role === "donor") {
    return true;
  }
  const strategyId = typeof value.strategyId === "string" ? value.strategyId : "";
  const familyKey = typeof value.familyKey === "string" ? value.familyKey : "";
  return (
    strategyId.includes("TA_DONOR") ||
    familyKey.includes("tradingagents_donor")
  );
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatNumber(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "n/a";
  }
  return value.toFixed(4);
}
