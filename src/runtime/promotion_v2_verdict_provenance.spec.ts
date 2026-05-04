import { describe, expect, it } from 'vitest'
import {
  PROMOTION_INELIGIBLE_QUALITY_STATUSES,
  buildBlockedPromotionVerdictProvenance,
  excludePromotionIneligibleEvidence,
  missingRequiredEvidenceArtifactReason,
  promotionVerdictProvenanceToJson,
} from './promotion_v2_verdict_provenance.js'

describe('promotion_v2_verdict_provenance', () => {
  it('only emits blocked verdicts in v4.0', () => {
    const provenance = buildBlockedPromotionVerdictProvenance({
      blockingReasons: [missingRequiredEvidenceArtifactReason('trial_record.json')],
    })

    expect(provenance.verdict).toBe('blocked')
    expect(provenance.supportingEvidenceIds).toEqual([])
  })

  it('rejects blocked provenance without a hard-blocking reason', () => {
    expect(() => buildBlockedPromotionVerdictProvenance()).toThrow(
      'blocked promotion provenance requires at least one hard_block reason',
    )
    expect(() =>
      buildBlockedPromotionVerdictProvenance({
        blockingReasons: [{
          code: 'ADVISORY_ONLY',
          source: 'test',
          severity: 'warning',
        }],
      }),
    ).toThrow('blocked promotion provenance requires at least one hard_block reason')
  })

  it('builds a hard block for missing required evidence artifacts', () => {
    expect(missingRequiredEvidenceArtifactReason('fdr_report.json')).toEqual({
      code: 'MISSING_REQUIRED_EVIDENCE_ARTIFACT',
      source: 'validation_artifact_loader',
      severity: 'hard_block',
      required: 'fdr_report.json',
      observed: 'missing',
    })
  })

  it('excludes observation_only evidence from promotion support', () => {
    const excluded = excludePromotionIneligibleEvidence(
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'observation_only',
    )

    expect(PROMOTION_INELIGIBLE_QUALITY_STATUSES).toContain('observation_only')
    expect(excluded).toEqual({
      evidenceId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reason: 'source_quality_status_observation_only',
      source: 'source_quality_status',
    })
    expect(excludePromotionIneligibleEvidence('sha256:ok', 'ok')).toBeNull()
  })

  it('serializes persisted JSON as snake_case', () => {
    const json = promotionVerdictProvenanceToJson(
      buildBlockedPromotionVerdictProvenance({
        blockingReasons: [missingRequiredEvidenceArtifactReason('trial_record.json')],
        excludedEvidenceIds: [
          {
            evidenceId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            reason: 'source_quality_status_observation_only',
          },
        ],
        missingEvidence: ['trial_record.json'],
        nextRequiredEvidence: ['run research:strategy:validate'],
        generatedAt: '2026-05-02T00:00:00.000Z',
      }),
    )

    expect(json).toMatchObject({
      schema_version: 'promotion_v2_verdict_provenance.v4_0',
      verdict: 'blocked',
      blocking_reasons: [
        {
          code: 'MISSING_REQUIRED_EVIDENCE_ARTIFACT',
          source: 'validation_artifact_loader',
          severity: 'hard_block',
          required: 'trial_record.json',
        },
      ],
      excluded_evidence_ids: [
        {
          evidence_id: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          reason: 'source_quality_status_observation_only',
        },
      ],
      missing_evidence: ['trial_record.json'],
      next_required_evidence: ['run research:strategy:validate'],
      generated_at: '2026-05-02T00:00:00.000Z',
    })
    expect(json).not.toHaveProperty('blockingReasons')
    expect(json).not.toHaveProperty('supportingEvidenceIds')
  })
})
