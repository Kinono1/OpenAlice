export const PROMOTION_V2_VERDICT_PROVENANCE_SCHEMA_VERSION =
  'promotion_v2_verdict_provenance.v4_0'

export const PROMOTION_INELIGIBLE_QUALITY_STATUSES = [
  'observation_only',
  'unknown_lineage',
  'proxy_only',
] as const

export type PromotionIneligibleQualityStatus =
  (typeof PROMOTION_INELIGIBLE_QUALITY_STATUSES)[number]

export interface PromotionBlockingReason {
  code: string
  source: string
  severity: 'hard_block' | 'warning'
  required?: string
  observed?: string
  method?: string
  details?: Record<string, unknown>
}

export interface ExcludedEvidenceId {
  evidenceId: string
  reason: string
  source?: string
}

export interface PromotionVerdictProvenance {
  schemaVersion: typeof PROMOTION_V2_VERDICT_PROVENANCE_SCHEMA_VERSION
  verdict: 'blocked'
  blockingReasons: PromotionBlockingReason[]
  supportingEvidenceIds: string[]
  excludedEvidenceIds: ExcludedEvidenceId[]
  missingEvidence: string[]
  nextRequiredEvidence: string[]
  generatedAt?: string
}

export interface BuildBlockedPromotionVerdictProvenanceInput {
  blockingReasons?: PromotionBlockingReason[]
  supportingEvidenceIds?: string[]
  excludedEvidenceIds?: ExcludedEvidenceId[]
  missingEvidence?: string[]
  nextRequiredEvidence?: string[]
  generatedAt?: string
}

export function buildBlockedPromotionVerdictProvenance(
  input: BuildBlockedPromotionVerdictProvenanceInput = {},
): PromotionVerdictProvenance {
  const blockingReasons = input.blockingReasons ?? []
  if (!blockingReasons.some((reason) => reason.severity === 'hard_block')) {
    throw new Error('blocked promotion provenance requires at least one hard_block reason')
  }
  return {
    schemaVersion: PROMOTION_V2_VERDICT_PROVENANCE_SCHEMA_VERSION,
    verdict: 'blocked',
    blockingReasons,
    supportingEvidenceIds: input.supportingEvidenceIds ?? [],
    excludedEvidenceIds: input.excludedEvidenceIds ?? [],
    missingEvidence: input.missingEvidence ?? [],
    nextRequiredEvidence: input.nextRequiredEvidence ?? [],
    generatedAt: input.generatedAt,
  }
}

export function missingRequiredEvidenceArtifactReason(
  artifact: string,
  source = 'validation_artifact_loader',
): PromotionBlockingReason {
  return {
    code: 'MISSING_REQUIRED_EVIDENCE_ARTIFACT',
    source,
    severity: 'hard_block',
    required: artifact,
    observed: 'missing',
  }
}

export function excludePromotionIneligibleEvidence(
  evidenceId: string,
  qualityStatus: string,
  source = 'source_quality_status',
): ExcludedEvidenceId | null {
  if (!isPromotionIneligibleQualityStatus(qualityStatus)) return null
  return {
    evidenceId,
    reason: `source_quality_status_${qualityStatus}`,
    source,
  }
}

export function isPromotionIneligibleQualityStatus(
  value: string,
): value is PromotionIneligibleQualityStatus {
  return PROMOTION_INELIGIBLE_QUALITY_STATUSES.includes(
    value as PromotionIneligibleQualityStatus,
  )
}

export function promotionVerdictProvenanceToJson(
  provenance: PromotionVerdictProvenance,
): Record<string, unknown> {
  return {
    schema_version: provenance.schemaVersion,
    verdict: provenance.verdict,
    blocking_reasons: provenance.blockingReasons.map((reason) => ({
      code: reason.code,
      source: reason.source,
      severity: reason.severity,
      required: reason.required ?? null,
      observed: reason.observed ?? null,
      method: reason.method ?? null,
      details: reason.details ?? {},
    })),
    supporting_evidence_ids: provenance.supportingEvidenceIds,
    excluded_evidence_ids: provenance.excludedEvidenceIds.map((excluded) => ({
      evidence_id: excluded.evidenceId,
      reason: excluded.reason,
      source: excluded.source ?? null,
    })),
    missing_evidence: provenance.missingEvidence,
    next_required_evidence: provenance.nextRequiredEvidence,
    generated_at: provenance.generatedAt ?? null,
  }
}
