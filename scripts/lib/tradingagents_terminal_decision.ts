import type {
  DecisionConfidence,
  EvidenceCompleteness,
  FailureDiagnosisPayload,
  SalvageTaxonomy,
  StructuralFixDecision,
} from "./tradingagents_failure_diagnosis.js";

export interface TerminalDecisionPayload {
  schemaVersion: "tradingagents_terminal_decision.v1";
  generatedAt: string;
  paradigmId: string;
  diagnosisInputs: string[];
  pooledSummary: {
    diagnosisCount: number;
    structuralFixEligibleCount: number;
    horizonMismatchCount: number;
    structuralInstabilitySecondaryCount: number;
    componentSalvageCount: number;
    archiveCount: number;
  };
  terminalDecision: StructuralFixDecision;
  terminalDecisionConfidence: DecisionConfidence;
  terminalEvidenceCompleteness: EvidenceCompleteness;
  rationale: string[];
  pooledSalvageTaxonomy: SalvageTaxonomy[];
  diagnoses: Array<{
    poolProfile: string | null;
    primaryRootCause: string;
    secondaryContributors: string[];
    decisionConfidence: DecisionConfidence;
    evidenceCompleteness: EvidenceCompleteness;
    decision: StructuralFixDecision;
    structuralFixEligible: boolean;
  }>;
}

export function summarizeTradingAgentsTerminalDecision(params: {
  paradigmId: string;
  diagnoses: FailureDiagnosisPayload[];
  diagnosisInputs?: string[];
  generatedAt?: string;
}): TerminalDecisionPayload {
  if (params.diagnoses.length < 1) {
    throw new Error("At least one diagnosis is required.");
  }

  const structuralFixEligibleCount = params.diagnoses.filter(
    (diagnosis) => diagnosis.structuralFixEligibility.eligible,
  ).length;
  const horizonMismatchCount = params.diagnoses.filter(
    (diagnosis) => diagnosis.primaryRootCause === "horizon_mismatch",
  ).length;
  const structuralInstabilitySecondaryCount = params.diagnoses.filter((diagnosis) =>
    diagnosis.secondaryContributors.includes("structural_instability"),
  ).length;
  const componentSalvageCount = params.diagnoses.filter(
    (diagnosis) => diagnosis.decision === "component_salvage_only",
  ).length;
  const archiveCount = params.diagnoses.filter(
    (diagnosis) => diagnosis.decision === "archive_negative_result",
  ).length;

  const pooledSalvageTaxonomy = [...new Set(
    params.diagnoses.flatMap((diagnosis) => diagnosis.salvageAssessment.recommended),
  )];

  let terminalDecision: StructuralFixDecision;
  const rationale: string[] = [];
  if (
    structuralFixEligibleCount >= 2 &&
    horizonMismatchCount >= 2 &&
    structuralInstabilitySecondaryCount === 0
  ) {
    terminalDecision = "continue_structural_fix";
    rationale.push("At least two pools independently qualify for the single structural-fix lane.");
    rationale.push("No diagnosis retains structural_instability as a secondary blocker.");
  } else if (
    componentSalvageCount > 0 ||
    pooledSalvageTaxonomy.some((item) => item !== "evaluation_pattern_only")
  ) {
    terminalDecision = "component_salvage_only";
    rationale.push("The donor does not clear a terminal structural-fix gate across pools.");
    rationale.push("At least one pool still exposes reusable components worth salvaging.");
  } else {
    terminalDecision = "archive_negative_result";
    rationale.push("The donor does not clear structural-fix eligibility and exposes no meaningful salvage surface.");
  }

  const terminalDecisionConfidence = aggregateDecisionConfidence(params.diagnoses);
  const terminalEvidenceCompleteness = aggregateEvidenceCompleteness(
    params.diagnoses,
  );
  if (terminalDecisionConfidence !== "high") {
    rationale.push(
      `Terminal decision confidence is ${terminalDecisionConfidence}, so follow-up must remain conservative.`,
    );
  }
  if (terminalEvidenceCompleteness !== "sufficient") {
    rationale.push(
      `Terminal evidence completeness is ${terminalEvidenceCompleteness}; missing evidence should not be backfilled by narrative inference.`,
    );
  }

  return {
    schemaVersion: "tradingagents_terminal_decision.v1",
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
  };
}

function aggregateDecisionConfidence(
  diagnoses: FailureDiagnosisPayload[],
): DecisionConfidence {
  const rank: Record<DecisionConfidence, number> = { low: 0, medium: 1, high: 2 };
  return diagnoses.reduce<DecisionConfidence>((lowest, diagnosis) => (
    rank[diagnosis.decisionConfidence] < rank[lowest]
      ? diagnosis.decisionConfidence
      : lowest
  ), diagnoses[0]?.decisionConfidence ?? "low");
}

function aggregateEvidenceCompleteness(
  diagnoses: FailureDiagnosisPayload[],
): EvidenceCompleteness {
  const rank: Record<EvidenceCompleteness, number> = {
    weak: 0,
    partial: 1,
    sufficient: 2,
  };
  return diagnoses.reduce<EvidenceCompleteness>((lowest, diagnosis) => (
    rank[diagnosis.evidenceCompleteness] < rank[lowest]
      ? diagnosis.evidenceCompleteness
      : lowest
  ), diagnoses[0]?.evidenceCompleteness ?? "weak");
}
