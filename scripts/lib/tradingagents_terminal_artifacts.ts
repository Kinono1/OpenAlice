import type {
  DecisionConfidence,
  EvidenceCompleteness,
  FailureDiagnosisPayload,
  SalvageTaxonomy,
  StructuralFixDecision,
  TradingAgentsFailureRootCause,
} from "./tradingagents_failure_diagnosis.js";
import {
  summarizeTradingAgentsTerminalDecision,
  type TerminalDecisionPayload,
} from "./tradingagents_terminal_decision.js";
import type {
  TradingAgentsStage,
  TradingAgentsStageStatus,
} from "./tradingagents_stage_assessment.js";

export interface TradingAgentsTerminalArtifactPaths {
  diagnosisInputs: string[];
  analysisTerminalDecisionJson?: string | null;
  analysisTerminalDecisionMarkdown?: string | null;
  analysisSalvageRegistryJson?: string | null;
  analysisSalvageRegistryMarkdown?: string | null;
  analysisTerminalPostmortemJson?: string | null;
  analysisTerminalPostmortemMarkdown?: string | null;
  latestTerminalDecisionJson?: string | null;
  latestTerminalDecisionMarkdown?: string | null;
  latestSalvageRegistryJson?: string | null;
  latestSalvageRegistryMarkdown?: string | null;
  latestTerminalPostmortemJson?: string | null;
  latestTerminalPostmortemMarkdown?: string | null;
  latestTerminalStatusJson?: string | null;
}

export interface TradingAgentsSalvageRegistryItem {
  taxonomy: SalvageTaxonomy;
  status: "candidate_for_reuse" | "analysis_only";
  sourcePoolProfiles: string[];
  sourceRootCauses: TradingAgentsFailureRootCause[];
  sourceDecisionConfidences: DecisionConfidence[];
  rationale: string[];
  extractionScope: string;
  allowedUses: string[];
  blockedUses: string[];
  isAdmissionEvidence: false;
}

export interface TradingAgentsSalvageRegistryPayload {
  schemaVersion: "tradingagents_salvage_registry.v1";
  generatedAt: string;
  paradigmId: string;
  terminalDecision: StructuralFixDecision;
  decisionConfidence: DecisionConfidence;
  evidenceCompleteness: EvidenceCompleteness;
  governanceNotes: string[];
  items: TradingAgentsSalvageRegistryItem[];
}

export interface TradingAgentsTerminalStatusPayload {
  schemaVersion: "tradingagents_terminal_status.v1";
  generatedAt: string;
  paradigmId: string;
  terminalDecision: StructuralFixDecision;
  decisionConfidence: DecisionConfidence;
  evidenceCompleteness: EvidenceCompleteness;
  currentStage: TradingAgentsStage;
  currentStageStatus: TradingAgentsStageStatus;
  structuralFixLaneClosed: boolean;
  pooledSalvageTaxonomy: SalvageTaxonomy[];
  allowedActions: string[];
  blockedActions: string[];
  diagnosisInputs: string[];
  artifactPaths: TradingAgentsTerminalArtifactPaths;
}

export interface TradingAgentsTerminalPostmortemRootCause {
  cause: TradingAgentsFailureRootCause;
  score: number;
  poolProfiles: string[];
  evidence: string[];
}

export interface TradingAgentsTerminalPostmortemPayload {
  schemaVersion: "tradingagents_terminal_postmortem.v1";
  generatedAt: string;
  paradigmId: string;
  terminalDecision: StructuralFixDecision;
  decisionConfidence: DecisionConfidence;
  evidenceCompleteness: EvidenceCompleteness;
  currentStage: TradingAgentsStage;
  currentStageStatus: TradingAgentsStageStatus;
  failureModeTag: string;
  goal: string;
  changeSummary: string[];
  controls: string[];
  observations: string[];
  rootCauseSynthesis: {
    mixedState: boolean;
    primaryThemes: TradingAgentsFailureRootCause[];
    notes: string[];
  };
  topRootCauseCandidates: TradingAgentsTerminalPostmortemRootCause[];
  nextAction: string;
  blockedActions: string[];
  salvageTaxonomy: SalvageTaxonomy[];
  artifacts: string[];
}

export interface TradingAgentsTerminalArtifacts {
  terminalDecision: TerminalDecisionPayload;
  salvageRegistry: TradingAgentsSalvageRegistryPayload;
  terminalStatus: TradingAgentsTerminalStatusPayload;
  terminalPostmortem: TradingAgentsTerminalPostmortemPayload;
}

const SALVAGE_ORDER: SalvageTaxonomy[] = [
  "signal_component",
  "state_filter_component",
  "ranking_component",
  "risk_overlay_component",
  "evaluation_pattern_only",
];

const STAGE_RANK: Record<TradingAgentsStage, number> = {
  A: 0,
  B: 1,
  C: 2,
  D: 3,
};

const STAGE_STATUS_RANK: Record<TradingAgentsStageStatus, number> = {
  fail: 0,
  inconclusive: 1,
  pass: 2,
};

export function buildTradingAgentsTerminalArtifacts(params: {
  paradigmId: string;
  diagnoses: FailureDiagnosisPayload[];
  diagnosisInputs?: string[];
  generatedAt?: string;
  artifactPaths?: Partial<TradingAgentsTerminalArtifactPaths>;
  terminalDecision?: TerminalDecisionPayload;
}): TradingAgentsTerminalArtifacts {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const terminalDecision = params.terminalDecision ?? summarizeTradingAgentsTerminalDecision({
    paradigmId: params.paradigmId,
    diagnoses: params.diagnoses,
    diagnosisInputs: params.diagnosisInputs,
    generatedAt,
  });
  const artifactPaths = normalizeArtifactPaths(
    params.artifactPaths,
    terminalDecision.diagnosisInputs,
  );

  const salvageRegistry = buildTradingAgentsSalvageRegistry({
    paradigmId: params.paradigmId,
    diagnoses: params.diagnoses,
    terminalDecision,
    generatedAt,
  });
  const terminalStatus = buildTradingAgentsTerminalStatus({
    paradigmId: params.paradigmId,
    diagnoses: params.diagnoses,
    terminalDecision,
    artifactPaths,
    generatedAt,
  });
  const terminalPostmortem = buildTradingAgentsTerminalPostmortem({
    paradigmId: params.paradigmId,
    diagnoses: params.diagnoses,
    terminalDecision,
    artifactPaths,
    blockedActions: terminalStatus.blockedActions,
    generatedAt,
  });

  return {
    terminalDecision,
    salvageRegistry,
    terminalStatus,
    terminalPostmortem,
  };
}

export function renderTradingAgentsTerminalDecisionMarkdown(
  payload: TerminalDecisionPayload,
): string {
  const summaryRows = [
    ["diagnosisCount", String(payload.pooledSummary.diagnosisCount)],
    ["structuralFixEligibleCount", String(payload.pooledSummary.structuralFixEligibleCount)],
    ["horizonMismatchCount", String(payload.pooledSummary.horizonMismatchCount)],
    [
      "structuralInstabilitySecondaryCount",
      String(payload.pooledSummary.structuralInstabilitySecondaryCount),
    ],
    ["componentSalvageCount", String(payload.pooledSummary.componentSalvageCount)],
    ["archiveCount", String(payload.pooledSummary.archiveCount)],
  ];
  const diagnosisRows = payload.diagnoses
    .map((diagnosis) => [
      formatPoolProfile(diagnosis.poolProfile),
      diagnosis.decision,
      diagnosis.primaryRootCause,
      diagnosis.secondaryContributors.join(", ") || "none",
      diagnosis.decisionConfidence,
      diagnosis.evidenceCompleteness,
      diagnosis.structuralFixEligible ? "yes" : "no",
    ])
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");

  return [
    "# TradingAgents BTC Terminal Decision",
    "",
    `- terminalDecision: ${payload.terminalDecision}`,
    `- decisionConfidence: ${payload.terminalDecisionConfidence}`,
    `- evidenceCompleteness: ${payload.terminalEvidenceCompleteness}`,
    "",
    "## Pooled Summary",
    "",
    "| metric | value |",
    "| --- | --- |",
    ...summaryRows.map(([metric, value]) => `| ${metric} | ${value} |`),
    "",
    "## Pool Diagnoses",
    "",
    "| poolProfile | decision | primaryRootCause | secondaryContributors | confidence | evidence | structuralFixEligible |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    diagnosisRows,
    "",
    "## Rationale",
    "",
    ...payload.rationale.map((line) => `- ${line}`),
    "",
    "## Salvage Taxonomy",
    "",
    ...payload.pooledSalvageTaxonomy.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

export function renderTradingAgentsSalvageRegistryMarkdown(
  payload: TradingAgentsSalvageRegistryPayload,
): string {
  const rows = payload.items
    .map((item) => [
      item.taxonomy,
      item.status,
      item.sourcePoolProfiles.join(", ") || "none",
      item.extractionScope,
    ])
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");

  const details = payload.items.flatMap((item) => [
    `### ${item.taxonomy}`,
    ...item.rationale.map((line) => `- rationale: ${line}`),
    ...item.allowedUses.map((line) => `- allowedUse: ${line}`),
    ...item.blockedUses.map((line) => `- blockedUse: ${line}`),
    "",
  ]);

  return [
    "# TradingAgents BTC Component Salvage Registry",
    "",
    `- terminalDecision: ${payload.terminalDecision}`,
    `- decisionConfidence: ${payload.decisionConfidence}`,
    `- evidenceCompleteness: ${payload.evidenceCompleteness}`,
    "",
    "## Governance Notes",
    "",
    ...payload.governanceNotes.map((line) => `- ${line}`),
    "",
    "## Items",
    "",
    "| taxonomy | status | sourcePools | extractionScope |",
    "| --- | --- | --- | --- |",
    rows,
    "",
    ...details,
  ].join("\n");
}

export function renderTradingAgentsTerminalPostmortemMarkdown(
  payload: TradingAgentsTerminalPostmortemPayload,
): string {
  return [
    "# TradingAgents BTC Terminal Postmortem",
    "",
    "## Goal",
    payload.goal,
    "",
    "## Change",
    ...payload.changeSummary.map((line) => `- ${line}`),
    "",
    "## Controls",
    ...payload.controls.map((line) => `- ${line}`),
    "",
    "## Observations",
    ...payload.observations.map((line) => `- ${line}`),
    "",
    "## Failure Mode",
    `- tag: ${payload.failureModeTag}`,
    "",
    "## Root Cause Candidates",
    ...payload.topRootCauseCandidates.map((candidate, index) => (
      `${index + 1}. ${candidate.cause} | score=${candidate.score} | pools=${candidate.poolProfiles.join(", ") || "none"} | evidence=${candidate.evidence.join(" ; ")}`
    )),
    "",
    "## Next Action",
    payload.nextAction,
    "",
    "## Artifacts",
    ...payload.artifacts.map((artifact) => `- ${artifact}`),
    "",
  ].join("\n");
}

function buildTradingAgentsSalvageRegistry(params: {
  paradigmId: string;
  diagnoses: FailureDiagnosisPayload[];
  terminalDecision: TerminalDecisionPayload;
  generatedAt: string;
}): TradingAgentsSalvageRegistryPayload {
  const items = sortSalvageTaxonomy(params.terminalDecision.pooledSalvageTaxonomy).map(
    (taxonomy) => {
      const sourceDiagnoses = params.diagnoses.filter((diagnosis) =>
        diagnosis.salvageAssessment.recommended.includes(taxonomy),
      );
      const sourcePoolProfiles = uniqueStrings(
        sourceDiagnoses.map((diagnosis) => formatPoolProfile(diagnosis.poolProfile)),
      );
      const sourceRootCauses = uniqueRootCauses(
        sourceDiagnoses.map((diagnosis) => diagnosis.primaryRootCause),
      );
      const sourceDecisionConfidences = uniqueDecisionConfidences(
        sourceDiagnoses.map((diagnosis) => diagnosis.decisionConfidence),
      );
      const rationale = uniqueStrings(
        sourceDiagnoses.flatMap((diagnosis) => [
          `${formatPoolProfile(diagnosis.poolProfile)}: primaryRootCause=${diagnosis.primaryRootCause}`,
          ...diagnosis.salvageAssessment.rationale.map(
            (line) => `${formatPoolProfile(diagnosis.poolProfile)}: ${line}`,
          ),
        ]),
      );

      return {
        taxonomy,
        status:
          taxonomy === "evaluation_pattern_only"
            ? "analysis_only"
            : "candidate_for_reuse",
        sourcePoolProfiles,
        sourceRootCauses,
        sourceDecisionConfidences,
        rationale,
        extractionScope: describeExtractionScope(taxonomy),
        allowedUses: describeAllowedUses(taxonomy),
        blockedUses: describeBlockedUses(taxonomy),
        isAdmissionEvidence: false as const,
      } satisfies TradingAgentsSalvageRegistryItem;
    },
  );

  return {
    schemaVersion: "tradingagents_salvage_registry.v1",
    generatedAt: params.generatedAt,
    paradigmId: params.paradigmId,
    terminalDecision: params.terminalDecision.terminalDecision,
    decisionConfidence: params.terminalDecision.terminalDecisionConfidence,
    evidenceCompleteness: params.terminalDecision.terminalEvidenceCompleteness,
    governanceNotes: [
      "Diagnostic metrics may explain how the donor failed, but they cannot reopen admission by themselves.",
      "Salvage entries are reusable only as components or evaluation patterns outside the original donor mainline unless new admission evidence is generated.",
    ],
    items,
  };
}

function buildTradingAgentsTerminalStatus(params: {
  paradigmId: string;
  diagnoses: FailureDiagnosisPayload[];
  terminalDecision: TerminalDecisionPayload;
  artifactPaths: TradingAgentsTerminalArtifactPaths;
  generatedAt: string;
}): TradingAgentsTerminalStatusPayload {
  const pooledStage = derivePooledStage(params.diagnoses);
  const representativeDiagnosis = params.diagnoses[0];
  const blockedActions = uniqueStrings([
    "another donor structural-fix round",
    "using donor-only diagnostic metrics as admission evidence",
    ...representativeDiagnosis.structuralFixEligibility.blockedChanges,
  ]);
  const allowedActions = deriveAllowedActions(
    params.terminalDecision.terminalDecision,
    params.terminalDecision.pooledSalvageTaxonomy,
    representativeDiagnosis.structuralFixEligibility.whitelist,
  );

  return {
    schemaVersion: "tradingagents_terminal_status.v1",
    generatedAt: params.generatedAt,
    paradigmId: params.paradigmId,
    terminalDecision: params.terminalDecision.terminalDecision,
    decisionConfidence: params.terminalDecision.terminalDecisionConfidence,
    evidenceCompleteness: params.terminalDecision.terminalEvidenceCompleteness,
    currentStage: pooledStage.currentStage,
    currentStageStatus: pooledStage.currentStageStatus,
    structuralFixLaneClosed:
      params.terminalDecision.terminalDecision !== "continue_structural_fix",
    pooledSalvageTaxonomy: params.terminalDecision.pooledSalvageTaxonomy,
    allowedActions,
    blockedActions,
    diagnosisInputs: params.terminalDecision.diagnosisInputs,
    artifactPaths: params.artifactPaths,
  };
}

function buildTradingAgentsTerminalPostmortem(params: {
  paradigmId: string;
  diagnoses: FailureDiagnosisPayload[];
  terminalDecision: TerminalDecisionPayload;
  artifactPaths: TradingAgentsTerminalArtifactPaths;
  blockedActions: string[];
  generatedAt: string;
}): TradingAgentsTerminalPostmortemPayload {
  const pooledStage = derivePooledStage(params.diagnoses);
  const topRootCauseCandidates = rankRootCauseCandidates(params.diagnoses).slice(0, 3);
  const primaryThemes = topRootCauseCandidates.map((candidate) => candidate.cause);
  const mixedState =
    uniqueRootCauses(params.diagnoses.map((diagnosis) => diagnosis.primaryRootCause)).length > 1 ||
    params.diagnoses.some((diagnosis) => diagnosis.secondaryContributors.length > 0);
  const failureModeTag = mixedState
    ? `mixed_failure_chain.${params.terminalDecision.terminalDecision}`
    : `${topRootCauseCandidates[0]?.cause ?? "terminal"}.${params.terminalDecision.terminalDecision}`;

  return {
    schemaVersion: "tradingagents_terminal_postmortem.v1",
    generatedAt: params.generatedAt,
    paradigmId: params.paradigmId,
    terminalDecision: params.terminalDecision.terminalDecision,
    decisionConfidence: params.terminalDecision.terminalDecisionConfidence,
    evidenceCompleteness: params.terminalDecision.terminalEvidenceCompleteness,
    currentStage: pooledStage.currentStage,
    currentStageStatus: pooledStage.currentStageStatus,
    failureModeTag,
    goal: "Determine whether the TradingAgents BTC donor lane should continue as a mainline structural-fix candidate or be closed as salvage/archive only.",
    changeSummary: [
      "Collapsed pool-level diagnoses into one terminal governance decision instead of extending donor search.",
      "Held structural-fix continuation to the pre-registered whitelist and confidence/evidence floors.",
      "Converted residual value into a salvage registry so failure analysis cannot be misread as admission evidence.",
    ],
    controls: buildControlSummary(params.diagnoses),
    observations: [
      `terminalDecision=${params.terminalDecision.terminalDecision} | confidence=${params.terminalDecision.terminalDecisionConfidence} | evidence=${params.terminalDecision.terminalEvidenceCompleteness}`,
      `${params.terminalDecision.pooledSummary.structuralFixEligibleCount}/${params.terminalDecision.pooledSummary.diagnosisCount} pools clear structural-fix eligibility.`,
      `pooled stage floor=${pooledStage.currentStage} (${pooledStage.currentStageStatus}).`,
      ...params.diagnoses.map((diagnosis) => (
        `${formatPoolProfile(diagnosis.poolProfile)} -> primary=${diagnosis.primaryRootCause} | secondary=${diagnosis.secondaryContributors.join(", ") || "none"} | decision=${diagnosis.decision}`
      )),
    ],
    rootCauseSynthesis: {
      mixedState,
      primaryThemes,
      notes: mixedState
        ? [
            "The donor failure should be treated as a mixed-state chain, not a mutually exclusive single-label diagnosis.",
            "Sample sparsity, selection path, and instability evidence can coexist and should constrain follow-up scope together.",
          ]
        : ["The dominant failure mechanism is concentrated enough to support a single primary theme."],
    },
    topRootCauseCandidates,
    nextAction: describeNextAction(params.terminalDecision.terminalDecision),
    blockedActions: params.blockedActions,
    salvageTaxonomy: params.terminalDecision.pooledSalvageTaxonomy,
    artifacts: uniqueStrings([
      ...params.terminalDecision.diagnosisInputs,
      ...collectArtifactPaths(params.artifactPaths),
    ]),
  };
}

function normalizeArtifactPaths(
  artifactPaths: Partial<TradingAgentsTerminalArtifactPaths> | undefined,
  diagnosisInputs: string[],
): TradingAgentsTerminalArtifactPaths {
  return {
    diagnosisInputs,
    analysisTerminalDecisionJson: artifactPaths?.analysisTerminalDecisionJson ?? null,
    analysisTerminalDecisionMarkdown:
      artifactPaths?.analysisTerminalDecisionMarkdown ?? null,
    analysisSalvageRegistryJson: artifactPaths?.analysisSalvageRegistryJson ?? null,
    analysisSalvageRegistryMarkdown:
      artifactPaths?.analysisSalvageRegistryMarkdown ?? null,
    analysisTerminalPostmortemJson:
      artifactPaths?.analysisTerminalPostmortemJson ?? null,
    analysisTerminalPostmortemMarkdown:
      artifactPaths?.analysisTerminalPostmortemMarkdown ?? null,
    latestTerminalDecisionJson: artifactPaths?.latestTerminalDecisionJson ?? null,
    latestTerminalDecisionMarkdown:
      artifactPaths?.latestTerminalDecisionMarkdown ?? null,
    latestSalvageRegistryJson: artifactPaths?.latestSalvageRegistryJson ?? null,
    latestSalvageRegistryMarkdown:
      artifactPaths?.latestSalvageRegistryMarkdown ?? null,
    latestTerminalPostmortemJson:
      artifactPaths?.latestTerminalPostmortemJson ?? null,
    latestTerminalPostmortemMarkdown:
      artifactPaths?.latestTerminalPostmortemMarkdown ?? null,
    latestTerminalStatusJson: artifactPaths?.latestTerminalStatusJson ?? null,
  };
}

function derivePooledStage(diagnoses: FailureDiagnosisPayload[]): {
  currentStage: TradingAgentsStage;
  currentStageStatus: TradingAgentsStageStatus;
} {
  const stageFloor = diagnoses.reduce<TradingAgentsStage>((lowest, diagnosis) => (
    STAGE_RANK[diagnosis.stageSnapshot.currentStage] < STAGE_RANK[lowest]
      ? diagnosis.stageSnapshot.currentStage
      : lowest
  ), diagnoses[0]?.stageSnapshot.currentStage ?? "A");
  const relevantStatuses = diagnoses
    .filter((diagnosis) => diagnosis.stageSnapshot.currentStage === stageFloor)
    .map((diagnosis) => diagnosis.stageSnapshot.currentStageStatus);
  const currentStageStatus = relevantStatuses.reduce<TradingAgentsStageStatus>((worst, status) => (
    STAGE_STATUS_RANK[status] < STAGE_STATUS_RANK[worst]
      ? status
      : worst
  ), relevantStatuses[0] ?? "inconclusive");
  return {
    currentStage: stageFloor,
    currentStageStatus,
  };
}

function deriveAllowedActions(
  terminalDecision: StructuralFixDecision,
  salvageTaxonomy: SalvageTaxonomy[],
  whitelist: string[],
): string[] {
  if (terminalDecision === "continue_structural_fix") {
    return uniqueStrings(whitelist.map((item) => `structural-fix only: ${item}`));
  }
  if (terminalDecision === "component_salvage_only") {
    return uniqueStrings([
      ...salvageTaxonomy.map((item) => `salvage only: ${item}`),
      "freeze donor mainline and extract only component-level follow-up cards",
    ]);
  }
  return ["archive evidence and retain evaluation-pattern lessons only"];
}

function buildControlSummary(diagnoses: FailureDiagnosisPayload[]): string[] {
  const poolControls = uniqueStrings(diagnoses.map((diagnosis) => describePoolControl(
    diagnosis.poolProfile,
  )));
  const hasWfoProfiles = diagnoses.some((diagnosis) => diagnosis.sourceWfoSensitivity !== null);
  return uniqueStrings([
    ...poolControls,
    "benchmark-aware comparison against BASELINE_CONTROL",
    hasWfoProfiles
      ? "WFO sensitivity evaluated with native_short_test, medium_oos, and long_oos where available"
      : "No pooled WFO sensitivity artifact exists for every pool; missing profiles remain explicit",
  ]);
}

function rankRootCauseCandidates(
  diagnoses: FailureDiagnosisPayload[],
): TradingAgentsTerminalPostmortemRootCause[] {
  const scoreByCause = new Map<
    TradingAgentsFailureRootCause,
    { score: number; poolProfiles: Set<string>; evidence: string[] }
  >();
  for (const diagnosis of diagnoses) {
    addRootCauseScore(
      scoreByCause,
      diagnosis.primaryRootCause,
      2,
      diagnosis.poolProfile,
      `${formatPoolProfile(diagnosis.poolProfile)}: primaryRootCause=${diagnosis.primaryRootCause}`,
    );
    for (const contributor of diagnosis.secondaryContributors) {
      addRootCauseScore(
        scoreByCause,
        contributor,
        1,
        diagnosis.poolProfile,
        `${formatPoolProfile(diagnosis.poolProfile)}: secondaryContributor=${contributor}`,
      );
    }
  }

  return [...scoreByCause.entries()]
    .map(([cause, details]) => ({
      cause,
      score: details.score,
      poolProfiles: [...details.poolProfiles],
      evidence: uniqueStrings(details.evidence),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.cause.localeCompare(right.cause);
    });
}

function addRootCauseScore(
  scoreByCause: Map<
    TradingAgentsFailureRootCause,
    { score: number; poolProfiles: Set<string>; evidence: string[] }
  >,
  cause: TradingAgentsFailureRootCause,
  increment: number,
  poolProfile: string | null,
  evidence: string,
): void {
  const current = scoreByCause.get(cause) ?? {
    score: 0,
    poolProfiles: new Set<string>(),
    evidence: [],
  };
  current.score += increment;
  current.poolProfiles.add(formatPoolProfile(poolProfile));
  current.evidence.push(evidence);
  scoreByCause.set(cause, current);
}

function describeExtractionScope(taxonomy: SalvageTaxonomy): string {
  switch (taxonomy) {
    case "signal_component":
      return "donor alpha fragment or signal transform only";
    case "state_filter_component":
      return "state/regime gating logic only";
    case "ranking_component":
      return "candidate ordering or ranking heuristic only";
    case "risk_overlay_component":
      return "risk overlay or exposure control only";
    case "evaluation_pattern_only":
      return "evaluation design, diagnosis, and negative-result governance only";
    default:
      return "component-level extraction only";
  }
}

function describeAllowedUses(taxonomy: SalvageTaxonomy): string[] {
  switch (taxonomy) {
    case "signal_component":
      return [
        "reuse as an input feature or signal fragment inside a fresh candidate family",
        "retest only under a new admission path with independent controls",
      ];
    case "state_filter_component":
      return [
        "reuse as a standalone state detector or gating module",
        "evaluate separately from the original donor ranking stack",
      ];
    case "ranking_component":
      return [
        "reuse as an ordering heuristic for future candidate pools",
        "keep admission evidence separate from the ranking heuristic itself",
      ];
    case "risk_overlay_component":
      return [
        "reuse only as an overlay on top of independently validated alpha",
        "treat as a guardrail, not as alpha evidence",
      ];
    case "evaluation_pattern_only":
      return [
        "reuse the diagnosis and terminal-governance pattern for future negative results",
      ];
    default:
      return ["component-level reuse only"];
  }
}

function describeBlockedUses(taxonomy: SalvageTaxonomy): string[] {
  switch (taxonomy) {
    case "signal_component":
    case "state_filter_component":
    case "ranking_component":
    case "risk_overlay_component":
      return [
        "do not use as sufficient evidence to reopen the original donor mainline",
        "do not treat diagnostic donor-only strength as formal admission evidence",
      ];
    case "evaluation_pattern_only":
      return [
        "do not reinterpret evaluation-pattern lessons as strategy alpha",
      ];
    default:
      return ["do not use to reopen donor admission on narrative grounds"];
  }
}

function describeNextAction(decision: StructuralFixDecision): string {
  switch (decision) {
    case "continue_structural_fix":
      return "Run exactly one whitelist-only structural validation round, and terminate the lane immediately if the pooled stop conditions still hold.";
    case "component_salvage_only":
      return "Freeze the donor lane as non-promotable and open only component-level salvage cards that must prove value outside the donor family under fresh admission evidence.";
    case "archive_negative_result":
      return "Archive the donor lane and retain only evaluation-pattern lessons; no further donor or component follow-up is justified without new external evidence.";
    default:
      return "Freeze the donor lane until new external evidence exists.";
  }
}

function describePoolControl(poolProfile: string | null): string {
  switch (poolProfile) {
    case "baseline_guard_v1":
      return "baseline guard pool";
    case "baseline_robust_anchor_v1":
      return "fixed robust anchor pool";
    case "baseline_independent_guard_v1":
      return "fixed independent guard pool";
    default:
      return formatPoolProfile(poolProfile);
  }
}

function formatPoolProfile(poolProfile: string | null): string {
  return poolProfile && poolProfile.trim().length > 0 ? poolProfile : "unknown_pool";
}

function collectArtifactPaths(paths: TradingAgentsTerminalArtifactPaths): string[] {
  return uniqueStrings([
    ...(paths.analysisTerminalDecisionJson ? [paths.analysisTerminalDecisionJson] : []),
    ...(paths.analysisTerminalDecisionMarkdown
      ? [paths.analysisTerminalDecisionMarkdown]
      : []),
    ...(paths.analysisSalvageRegistryJson ? [paths.analysisSalvageRegistryJson] : []),
    ...(paths.analysisSalvageRegistryMarkdown
      ? [paths.analysisSalvageRegistryMarkdown]
      : []),
    ...(paths.analysisTerminalPostmortemJson
      ? [paths.analysisTerminalPostmortemJson]
      : []),
    ...(paths.analysisTerminalPostmortemMarkdown
      ? [paths.analysisTerminalPostmortemMarkdown]
      : []),
    ...(paths.latestTerminalDecisionJson ? [paths.latestTerminalDecisionJson] : []),
    ...(paths.latestTerminalDecisionMarkdown
      ? [paths.latestTerminalDecisionMarkdown]
      : []),
    ...(paths.latestSalvageRegistryJson ? [paths.latestSalvageRegistryJson] : []),
    ...(paths.latestSalvageRegistryMarkdown
      ? [paths.latestSalvageRegistryMarkdown]
      : []),
    ...(paths.latestTerminalPostmortemJson
      ? [paths.latestTerminalPostmortemJson]
      : []),
    ...(paths.latestTerminalPostmortemMarkdown
      ? [paths.latestTerminalPostmortemMarkdown]
      : []),
    ...(paths.latestTerminalStatusJson ? [paths.latestTerminalStatusJson] : []),
  ]);
}

function sortSalvageTaxonomy(values: SalvageTaxonomy[]): SalvageTaxonomy[] {
  return [...values].sort(
    (left, right) => SALVAGE_ORDER.indexOf(left) - SALVAGE_ORDER.indexOf(right),
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function uniqueRootCauses(
  values: TradingAgentsFailureRootCause[],
): TradingAgentsFailureRootCause[] {
  return [...new Set(values)];
}

function uniqueDecisionConfidences(
  values: DecisionConfidence[],
): DecisionConfidence[] {
  return [...new Set(values)];
}
