import type {
  DecisionConfidence,
  EvidenceCompleteness,
  FailureDiagnosisPayload,
  SalvageTaxonomy,
  StructuralFixDecision,
  TradingAgentsFailureRootCause,
} from './tradingagents_failure_diagnosis.js'
import {
  summarizeTradingAgentsTerminalDecision,
  type TerminalDecisionPayload,
} from './tradingagents_terminal_decision.js'
import type {
  TradingAgentsStage,
  TradingAgentsStageStatus,
} from './tradingagents_stage_assessment.js'

export interface TradingAgentsTerminalArtifactPaths {
  diagnosisInputs: string[]
  analysisTerminalDecisionJson?: string | null
  analysisTerminalDecisionMarkdown?: string | null
  analysisSalvageRegistryJson?: string | null
  analysisSalvageRegistryMarkdown?: string | null
  analysisTerminalPostmortemJson?: string | null
  analysisTerminalPostmortemMarkdown?: string | null
  latestTerminalDecisionJson?: string | null
  latestSalvageRegistryJson?: string | null
  latestTerminalPostmortemJson?: string | null
  latestTerminalStatusJson?: string | null
}

export interface TradingAgentsSalvageRegistryItem {
  taxonomy: SalvageTaxonomy
  status: 'candidate_for_reuse' | 'analysis_only'
  sourcePoolProfiles: string[]
  sourceRootCauses: TradingAgentsFailureRootCause[]
  sourceDecisionConfidences: DecisionConfidence[]
  rationale: string[]
  extractionScope: string
  allowedUses: string[]
  blockedUses: string[]
  isAdmissionEvidence: false
}

export interface TradingAgentsSalvageRegistryPayload {
  schemaVersion: 'tradingagents_salvage_registry.v1'
  generatedAt: string
  paradigmId: string
  terminalDecision: StructuralFixDecision
  decisionConfidence: DecisionConfidence
  evidenceCompleteness: EvidenceCompleteness
  governanceNotes: string[]
  items: TradingAgentsSalvageRegistryItem[]
}

export interface TradingAgentsTerminalStatusPayload {
  schemaVersion: 'tradingagents_terminal_status.v1'
  generatedAt: string
  paradigmId: string
  terminalDecision: StructuralFixDecision
  decisionConfidence: DecisionConfidence
  evidenceCompleteness: EvidenceCompleteness
  currentStage: TradingAgentsStage
  currentStageStatus: TradingAgentsStageStatus
  structuralFixLaneClosed: boolean
  pooledSalvageTaxonomy: SalvageTaxonomy[]
  allowedActions: string[]
  blockedActions: string[]
  diagnosisInputs: string[]
  artifactPaths: TradingAgentsTerminalArtifactPaths
}

export interface TradingAgentsTerminalPostmortemPayload {
  schemaVersion: 'tradingagents_terminal_postmortem.v1'
  generatedAt: string
  paradigmId: string
  terminalDecision: StructuralFixDecision
  decisionConfidence: DecisionConfidence
  evidenceCompleteness: EvidenceCompleteness
  currentStage: TradingAgentsStage
  currentStageStatus: TradingAgentsStageStatus
  failureModeTag: string
  goal: string
  changeSummary: string[]
  controls: string[]
  observations: string[]
  rootCauseSynthesis: {
    mixedState: boolean
    primaryThemes: TradingAgentsFailureRootCause[]
    notes: string[]
  }
  topRootCauseCandidates: Array<{
    cause: TradingAgentsFailureRootCause
    score: number
    poolProfiles: string[]
    evidence: string[]
  }>
  nextAction: string
  blockedActions: string[]
  salvageTaxonomy: SalvageTaxonomy[]
  artifacts: string[]
}

export interface TradingAgentsTerminalArtifacts {
  terminalDecision: TerminalDecisionPayload
  salvageRegistry: TradingAgentsSalvageRegistryPayload
  terminalStatus: TradingAgentsTerminalStatusPayload
  terminalPostmortem: TradingAgentsTerminalPostmortemPayload
}

const SALVAGE_ORDER: SalvageTaxonomy[] = [
  'evaluation_pattern_only',
  'state_filter_component',
  'ranking_component',
  'signal_component',
  'risk_overlay_component',
]

export function buildTradingAgentsTerminalArtifacts(params: {
  paradigmId: string
  diagnoses: FailureDiagnosisPayload[]
  diagnosisInputs?: string[]
  generatedAt?: string
  artifactPaths?: Partial<TradingAgentsTerminalArtifactPaths>
  terminalDecision?: TerminalDecisionPayload
}): TradingAgentsTerminalArtifacts {
  const generatedAt = params.generatedAt ?? new Date().toISOString()
  const terminalDecision =
    params.terminalDecision ??
    summarizeTradingAgentsTerminalDecision({
      paradigmId: params.paradigmId,
      diagnoses: params.diagnoses,
      diagnosisInputs: params.diagnosisInputs,
      generatedAt,
    })
  const artifactPaths = normalizeArtifactPaths(
    params.artifactPaths,
    terminalDecision.diagnosisInputs,
  )
  const salvageRegistry = buildTradingAgentsSalvageRegistry({
    paradigmId: params.paradigmId,
    diagnoses: params.diagnoses,
    terminalDecision,
    generatedAt,
  })
  const terminalStatus = buildTradingAgentsTerminalStatus({
    paradigmId: params.paradigmId,
    diagnoses: params.diagnoses,
    terminalDecision,
    artifactPaths,
    generatedAt,
  })
  const terminalPostmortem = buildTradingAgentsTerminalPostmortem({
    paradigmId: params.paradigmId,
    diagnoses: params.diagnoses,
    terminalDecision,
    artifactPaths,
    generatedAt,
    blockedActions: terminalStatus.blockedActions,
  })
  return { terminalDecision, salvageRegistry, terminalStatus, terminalPostmortem }
}

export function renderTradingAgentsTerminalDecisionMarkdown(
  payload: TerminalDecisionPayload,
): string {
  return [
    '# TradingAgents Terminal Decision',
    '',
    `- terminalDecision: ${payload.terminalDecision}`,
    `- decisionConfidence: ${payload.terminalDecisionConfidence}`,
    `- evidenceCompleteness: ${payload.terminalEvidenceCompleteness}`,
    '',
    '## Pooled Summary',
    '',
    '| metric | value |',
    '| --- | --- |',
    `| diagnosisCount | ${payload.pooledSummary.diagnosisCount} |`,
    `| structuralFixEligibleCount | ${payload.pooledSummary.structuralFixEligibleCount} |`,
    `| horizonMismatchCount | ${payload.pooledSummary.horizonMismatchCount} |`,
    `| structuralInstabilitySecondaryCount | ${payload.pooledSummary.structuralInstabilitySecondaryCount} |`,
    `| componentSalvageCount | ${payload.pooledSummary.componentSalvageCount} |`,
    `| archiveCount | ${payload.pooledSummary.archiveCount} |`,
    '',
    '## Rationale',
    '',
    ...payload.rationale.map((line) => `- ${line}`),
    '',
  ].join('\n')
}

export function renderTradingAgentsSalvageRegistryMarkdown(
  payload: TradingAgentsSalvageRegistryPayload,
): string {
  return [
    '# TradingAgents Salvage Registry',
    '',
    `- terminalDecision: ${payload.terminalDecision}`,
    `- decisionConfidence: ${payload.decisionConfidence}`,
    `- evidenceCompleteness: ${payload.evidenceCompleteness}`,
    '',
    '## Items',
    '',
    '| taxonomy | status | sourcePools | allowedUses | blockedUses |',
    '| --- | --- | --- | --- | --- |',
    ...payload.items.map(
      (item) =>
        `| ${item.taxonomy} | ${item.status} | ${item.sourcePoolProfiles.join(', ') || 'none'} | ${item.allowedUses.join(', ')} | ${item.blockedUses.join(', ')} |`,
    ),
    '',
  ].join('\n')
}

export function renderTradingAgentsTerminalPostmortemMarkdown(
  payload: TradingAgentsTerminalPostmortemPayload,
): string {
  return [
    '# TradingAgents Terminal Postmortem',
    '',
    `- terminalDecision: ${payload.terminalDecision}`,
    `- currentStage: ${payload.currentStage}`,
    `- currentStageStatus: ${payload.currentStageStatus}`,
    `- failureModeTag: ${payload.failureModeTag}`,
    '',
    '## Observations',
    '',
    ...payload.observations.map((line) => `- ${line}`),
    '',
    '## Blocked Actions',
    '',
    ...payload.blockedActions.map((line) => `- ${line}`),
    '',
  ].join('\n')
}

function buildTradingAgentsSalvageRegistry(params: {
  paradigmId: string
  diagnoses: FailureDiagnosisPayload[]
  terminalDecision: TerminalDecisionPayload
  generatedAt: string
}): TradingAgentsSalvageRegistryPayload {
  const items = SALVAGE_ORDER.filter((taxonomy) =>
    params.terminalDecision.pooledSalvageTaxonomy.includes(taxonomy),
  ).map((taxonomy) => {
    const matching = params.diagnoses.filter((diagnosis) =>
      diagnosis.salvageAssessment.recommended.includes(taxonomy),
    )
    return {
      taxonomy,
      status:
        taxonomy === 'evaluation_pattern_only'
          ? 'analysis_only'
          : 'candidate_for_reuse',
      sourcePoolProfiles: matching
        .map((diagnosis) => diagnosis.poolProfile)
        .filter((value): value is string => Boolean(value)),
      sourceRootCauses: Array.from(
        new Set(matching.map((diagnosis) => diagnosis.primaryRootCause)),
      ),
      sourceDecisionConfidences: Array.from(
        new Set(matching.map((diagnosis) => diagnosis.decisionConfidence)),
      ),
      rationale: Array.from(
        new Set(matching.flatMap((diagnosis) => diagnosis.salvageAssessment.rationale)),
      ),
      extractionScope:
        taxonomy === 'evaluation_pattern_only'
          ? 'evaluation and governance logic only'
          : 'component-level extraction only',
      allowedUses:
        taxonomy === 'evaluation_pattern_only'
          ? ['salvage only: evaluation_pattern_only']
          : [`salvage only: ${taxonomy}`],
      blockedUses: ['use as direct admission evidence', 'use as donor promotion evidence'],
      isAdmissionEvidence: false,
    }
  })

  return {
    schemaVersion: 'tradingagents_salvage_registry.v1',
    generatedAt: params.generatedAt,
    paradigmId: params.paradigmId,
    terminalDecision: params.terminalDecision.terminalDecision,
    decisionConfidence: params.terminalDecision.terminalDecisionConfidence,
    evidenceCompleteness: params.terminalDecision.terminalEvidenceCompleteness,
    governanceNotes: params.terminalDecision.rationale,
    items,
  }
}

function buildTradingAgentsTerminalStatus(params: {
  paradigmId: string
  diagnoses: FailureDiagnosisPayload[]
  terminalDecision: TerminalDecisionPayload
  artifactPaths: TradingAgentsTerminalArtifactPaths
  generatedAt: string
}): TradingAgentsTerminalStatusPayload {
  const currentStage = params.diagnoses.reduce<TradingAgentsStage>(
    (lowest, diagnosis) =>
      rankStage(diagnosis.stageSnapshot.currentStage) < rankStage(lowest)
        ? diagnosis.stageSnapshot.currentStage
        : lowest,
    params.diagnoses[0]?.stageSnapshot.currentStage ?? 'A',
  )
  const currentStageStatus = params.diagnoses.reduce<TradingAgentsStageStatus>(
    (lowest, diagnosis) =>
      rankStageStatus(diagnosis.stageSnapshot.currentStageStatus) <
      rankStageStatus(lowest)
        ? diagnosis.stageSnapshot.currentStageStatus
        : lowest,
    params.diagnoses[0]?.stageSnapshot.currentStageStatus ?? 'inconclusive',
  )
  const structuralFixLaneClosed =
    params.terminalDecision.terminalDecision !== 'continue_structural_fix'
  const blockedActions =
    params.terminalDecision.terminalDecision === 'continue_structural_fix'
      ? []
      : [
          'another donor structural-fix round',
          'using donor-only diagnostic metrics as admission evidence',
          ...params.diagnoses.flatMap((diagnosis) =>
            diagnosis.structuralFixEligibility.blockedChanges,
          ),
        ]
  const allowedActions =
    params.terminalDecision.terminalDecision === 'continue_structural_fix'
      ? ['one bounded structural-fix round', 'preserve component-level salvage analysis']
      : [
          ...params.terminalDecision.pooledSalvageTaxonomy.map(
            (taxonomy) => `salvage only: ${taxonomy}`,
          ),
          'freeze donor mainline and extract only component-level follow-up cards',
        ]

  return {
    schemaVersion: 'tradingagents_terminal_status.v1',
    generatedAt: params.generatedAt,
    paradigmId: params.paradigmId,
    terminalDecision: params.terminalDecision.terminalDecision,
    decisionConfidence: params.terminalDecision.terminalDecisionConfidence,
    evidenceCompleteness: params.terminalDecision.terminalEvidenceCompleteness,
    currentStage,
    currentStageStatus,
    structuralFixLaneClosed,
    pooledSalvageTaxonomy: params.terminalDecision.pooledSalvageTaxonomy,
    allowedActions: Array.from(new Set(allowedActions)),
    blockedActions: Array.from(new Set(blockedActions)),
    diagnosisInputs: params.terminalDecision.diagnosisInputs,
    artifactPaths: params.artifactPaths,
  }
}

function buildTradingAgentsTerminalPostmortem(params: {
  paradigmId: string
  diagnoses: FailureDiagnosisPayload[]
  terminalDecision: TerminalDecisionPayload
  artifactPaths: TradingAgentsTerminalArtifactPaths
  blockedActions: string[]
  generatedAt: string
}): TradingAgentsTerminalPostmortemPayload {
  const causes = new Map<
    TradingAgentsFailureRootCause,
    { count: number; pools: string[]; evidence: string[] }
  >()
  for (const diagnosis of params.diagnoses) {
    const existing = causes.get(diagnosis.primaryRootCause) ?? {
      count: 0,
      pools: [],
      evidence: [],
    }
    existing.count += 1
    if (diagnosis.poolProfile) existing.pools.push(diagnosis.poolProfile)
    existing.evidence.push(...diagnosis.ruleResults.filter((rule) => !rule.passed).map((rule) => rule.evidence))
    causes.set(diagnosis.primaryRootCause, existing)
  }
  const topRootCauseCandidates = Array.from(causes.entries())
    .map(([cause, value]) => ({
      cause,
      score: value.count / params.diagnoses.length,
      poolProfiles: Array.from(new Set(value.pools)),
      evidence: Array.from(new Set(value.evidence)).slice(0, 4),
    }))
    .sort((left, right) => right.score - left.score)

  const currentStage = params.diagnoses[0]?.stageSnapshot.currentStage ?? 'A'
  const currentStageStatus = params.diagnoses[0]?.stageSnapshot.currentStageStatus ?? 'inconclusive'

  return {
    schemaVersion: 'tradingagents_terminal_postmortem.v1',
    generatedAt: params.generatedAt,
    paradigmId: params.paradigmId,
    terminalDecision: params.terminalDecision.terminalDecision,
    decisionConfidence: params.terminalDecision.terminalDecisionConfidence,
    evidenceCompleteness: params.terminalDecision.terminalEvidenceCompleteness,
    currentStage,
    currentStageStatus,
    failureModeTag: params.terminalDecision.terminalDecision,
    goal: 'Explain why the TradingAgents donor lane is blocked and what salvage remains.',
    changeSummary: params.terminalDecision.rationale,
    controls: ['freeze donor mainline', 'preserve artifact-driven governance'],
    observations: params.diagnoses.flatMap((diagnosis) => [
      `pool=${diagnosis.poolProfile ?? 'unknown'} primaryRootCause=${diagnosis.primaryRootCause}`,
      ...diagnosis.secondaryContributors.map(
        (contributor) => `pool=${diagnosis.poolProfile ?? 'unknown'} secondary=${contributor}`,
      ),
    ]),
    rootCauseSynthesis: {
      mixedState: topRootCauseCandidates.length > 1,
      primaryThemes: topRootCauseCandidates.slice(0, 3).map((item) => item.cause),
      notes: params.terminalDecision.rationale,
    },
    topRootCauseCandidates,
    nextAction:
      params.terminalDecision.terminalDecision === 'continue_structural_fix'
        ? 'Run one bounded structural-fix round under the whitelist.'
        : 'Keep donor blocked and extract only explicitly allowed salvage components.',
    blockedActions: params.blockedActions,
    salvageTaxonomy: params.terminalDecision.pooledSalvageTaxonomy,
    artifacts: compactArtifactPaths(params.artifactPaths),
  }
}

function normalizeArtifactPaths(
  artifactPaths: Partial<TradingAgentsTerminalArtifactPaths> | undefined,
  diagnosisInputs: string[],
): TradingAgentsTerminalArtifactPaths {
  return {
    diagnosisInputs,
    analysisTerminalDecisionJson: artifactPaths?.analysisTerminalDecisionJson ?? null,
    analysisTerminalDecisionMarkdown: artifactPaths?.analysisTerminalDecisionMarkdown ?? null,
    analysisSalvageRegistryJson: artifactPaths?.analysisSalvageRegistryJson ?? null,
    analysisSalvageRegistryMarkdown: artifactPaths?.analysisSalvageRegistryMarkdown ?? null,
    analysisTerminalPostmortemJson: artifactPaths?.analysisTerminalPostmortemJson ?? null,
    analysisTerminalPostmortemMarkdown: artifactPaths?.analysisTerminalPostmortemMarkdown ?? null,
    latestTerminalDecisionJson: artifactPaths?.latestTerminalDecisionJson ?? null,
    latestSalvageRegistryJson: artifactPaths?.latestSalvageRegistryJson ?? null,
    latestTerminalPostmortemJson: artifactPaths?.latestTerminalPostmortemJson ?? null,
    latestTerminalStatusJson: artifactPaths?.latestTerminalStatusJson ?? null,
  }
}

function compactArtifactPaths(paths: TradingAgentsTerminalArtifactPaths): string[] {
  return Object.values(paths).flatMap((value) =>
    typeof value === 'string' && value.length > 0 ? [value] : [],
  )
}

function rankStage(stage: TradingAgentsStage): number {
  return stage === 'A' ? 0 : stage === 'B' ? 1 : stage === 'C' ? 2 : 3
}

function rankStageStatus(status: TradingAgentsStageStatus): number {
  return status === 'fail' ? 0 : status === 'inconclusive' ? 1 : 2
}
