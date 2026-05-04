import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CORRUPT_TRIAL_REGISTRY,
  DUPLICATE_TRIAL_ID,
  MISSING_EVIDENCE_ID,
  MISSING_FDR_PROVENANCE,
  MISSING_PIT_AUDIT_PROVENANCE,
  appendTrialRecord,
  buildCompleteTrialUniverseMarkerRecord,
  readTrialRegistry,
  trialRecordFromJson,
  trialRecordToJson,
  validateTrialRecordConsistency,
  type TrialRecord,
} from './trial_registry.js'

function makeTrialRecord(overrides: Partial<TrialRecord> = {}): TrialRecord {
  return {
    trialId: 'trial-1',
    evidenceId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    trialType: 'alpha_candidate',
    strategyFamily: 'low_turnover_cross_sectional_reversal',
    candidateId: 'candidate-1',
    hypothesis: 'low turnover reversal retains edge after costs',
    primaryMetric: 'cost_adjusted_net_expectancy_bps',
    secondaryMetrics: ['ic_mean', 'ic_ir'],
    pValue: null,
    includedInFdr: true,
    fdrFamily: '2026Q2_crypto_evidence_os_v4',
    promotionEligible: false,
    status: 'blocked_missing_fdr',
    failureCodes: ['MISSING_FDR_REPORT'],
    batchId: null,
    createdAt: '2026-05-02T00:00:00.000Z',
    metadata: {
      fdr_report_path: '/tmp/fdr_report.json',
      fdr_report_path_source: 'generated_artifact',
      fdr_report_status: 'blocked_inputs_incomplete',
      raw_m_complete: false,
      includes_failed_trials: false,
      p_value_source: 'missing',
      fdr_p_values_available: false,
      fdr_missing_p_value_count: 1,
      fdr_p_value_blocked_reason: 'p_value=null',
      pit_audit_path: '/tmp/feature_availability_audit.json',
      pit_audit_source: 'feature_availability_audit',
      pit_audit_status: 'blocked',
      pit_audit_blocking_codes: ['PIT_PROXY_ONLY'],
      pit_audit_promotion_grade: false,
      pit_audit_promotion_grade_source: 'feature_availability_audit',
      promotion_decision_source: 'fail_closed_validation_pipeline',
    },
    ...overrides,
  }
}

describe('trial_registry', () => {
  it('writes and reads JSONL trial records using snake_case artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-trial-registry-'))
    const path = join(root, 'trial_registry.jsonl')

    await appendTrialRecord(makeTrialRecord(), path)

    const raw = await readFile(path, 'utf-8')
    expect(JSON.parse(raw.trim())).toMatchObject({
      trial_id: 'trial-1',
      evidence_id: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      promotion_eligible: false,
    })

    const registry = await readTrialRegistry(path)
    expect(registry.hardBlockCodes).toEqual([])
    expect(registry.records).toHaveLength(1)
    expect(registry.records[0].trialId).toBe('trial-1')
  })

  it('rejects duplicate trial_id entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-trial-registry-'))
    const path = join(root, 'trial_registry.jsonl')

    await appendTrialRecord(makeTrialRecord(), path)

    await expect(appendTrialRecord(makeTrialRecord(), path)).rejects.toMatchObject({
      code: DUPLICATE_TRIAL_ID,
    })
  })

  it('requires FDR provenance before appending included alpha trials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-trial-registry-'))
    const path = join(root, 'trial_registry.jsonl')

    await expect(appendTrialRecord(makeTrialRecord({
      metadata: {
        pit_audit_path: '/tmp/feature_availability_audit.json',
        pit_audit_status: 'blocked',
        pit_audit_blocking_codes: ['PIT_PROXY_ONLY'],
        pit_audit_promotion_grade: false,
      },
    }), path)).rejects.toMatchObject({
      code: MISSING_FDR_PROVENANCE,
    })
  })

  it('requires PIT audit provenance before appending included alpha trials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-trial-registry-'))
    const path = join(root, 'trial_registry.jsonl')

    await expect(appendTrialRecord(makeTrialRecord({
      metadata: {
        fdr_report_path: '/tmp/fdr_report.json',
        fdr_report_status: 'blocked_inputs_incomplete',
        raw_m_complete: false,
        includes_failed_trials: false,
        fdr_p_values_available: false,
        fdr_missing_p_value_count: 1,
        fdr_p_value_blocked_reason: 'p_value=null',
      },
    }), path)).rejects.toMatchObject({
      code: MISSING_PIT_AUDIT_PROVENANCE,
    })
  })

  it('round-trips explicit provenance metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-trial-registry-'))
    const path = join(root, 'trial_registry.jsonl')

    await appendTrialRecord(makeTrialRecord(), path)

    const registry = await readTrialRegistry(path)
    expect(registry.records[0].metadata).toMatchObject({
      p_value_source: 'missing',
      fdr_report_path_source: 'generated_artifact',
      pit_audit_source: 'feature_availability_audit',
      pit_audit_promotion_grade_source: 'feature_availability_audit',
      promotion_decision_source: 'fail_closed_validation_pipeline',
    })
  })

  it('accepts promotion-grade row-level PIT audit provenance source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-trial-registry-'))
    const path = join(root, 'trial_registry.jsonl')

    await appendTrialRecord(makeTrialRecord({
      metadata: {
        ...(makeTrialRecord().metadata ?? {}),
        pit_audit_status: 'pass',
        pit_audit_blocking_codes: [],
        pit_audit_promotion_grade: true,
        pit_audit_promotion_grade_source: 'promotion_grade_row_level_audit',
      },
    }), path)

    const registry = await readTrialRegistry(path)
    expect(registry.hardBlockCodes).toEqual([])
    expect(registry.records[0].metadata).toMatchObject({
      pit_audit_promotion_grade: true,
      pit_audit_promotion_grade_source: 'promotion_grade_row_level_audit',
    })
  })

  it('accepts legacy rows with absent explicit provenance source fields', () => {
    expect(() =>
      trialRecordFromJson(trialRecordToJson(makeTrialRecord({
        metadata: {
          fdr_report_path: '/tmp/fdr_report.json',
          fdr_report_status: 'blocked_inputs_incomplete',
          raw_m_complete: false,
          includes_failed_trials: false,
          fdr_p_values_available: false,
          fdr_missing_p_value_count: 1,
          fdr_p_value_blocked_reason: 'p_value=null',
          pit_audit_path: '/tmp/feature_availability_audit.json',
          pit_audit_status: 'blocked',
          pit_audit_blocking_codes: ['PIT_PROXY_ONLY'],
          pit_audit_promotion_grade: false,
        },
      }))),
    ).not.toThrow()
  })

  it('rejects invalid explicit provenance enum values', () => {
    expect(() =>
      trialRecordToJson(makeTrialRecord({
        metadata: {
          ...(makeTrialRecord().metadata ?? {}),
          p_value_source: 'spreadsheet_guess',
        },
      })),
    ).toThrow(/trial provenance has unsupported values/)
  })

  it('rejects promotion eligible alpha rows without promotion-grade FDR and PIT provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-trial-registry-'))
    const path = join(root, 'trial_registry.jsonl')

    await expect(appendTrialRecord(makeTrialRecord({
      promotionEligible: true,
      pValue: 0.01,
      metadata: {
        ...(makeTrialRecord().metadata ?? {}),
        fdr_p_values_available: true,
        fdr_missing_p_value_count: 0,
        fdr_p_value_method: 'bootstrap',
        fdr_p_value_scope: 'promotion_raw_m',
        fdr_p_value_is_promotion_grade: false,
      },
    }), path)).rejects.toMatchObject({
      code: 'INCONSISTENT_TRIAL_PROVENANCE',
    })
  })

  it('allows duplicate evidence_id with a different trial_id as a rerun', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-trial-registry-'))
    const path = join(root, 'trial_registry.jsonl')

    await appendTrialRecord(makeTrialRecord({ trialId: 'trial-1' }), path)
    await appendTrialRecord(makeTrialRecord({ trialId: 'trial-2' }), path)

    const registry = await readTrialRegistry(path)
    expect(registry.records.map((record) => record.trialId)).toEqual(['trial-1', 'trial-2'])
    expect(new Set(registry.records.map((record) => record.evidenceId)).size).toBe(1)
  })

  it('builds an appendable complete trial universe marker row without FDR inclusion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-trial-registry-'))
    const path = join(root, 'trial_registry.jsonl')

    const marker = buildCompleteTrialUniverseMarkerRecord({
      trialId: 'trial-universe-marker-2026q2',
      evidenceId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fdrFamily: '2026Q2_crypto_evidence_os_v4',
      rawM: 5,
      effectiveM: 3,
      includedTrialCount: 5,
      failedTrialCount: 4,
      survivingTrialCount: 1,
      createdAt: '2026-05-04T00:00:00.000Z',
    })

    await appendTrialRecord(marker, path)
    const registry = await readTrialRegistry(path)

    expect(registry.hardBlockCodes).toEqual([])
    expect(registry.records[0]).toMatchObject({
      trialId: 'trial-universe-marker-2026q2',
      trialType: 'diagnostic_factor',
      strategyFamily: 'trial_universe',
      candidateId: 'complete_trial_universe',
      includedInFdr: false,
      promotionEligible: false,
      status: 'registered',
      metadata: {
        trial_universe_marker: true,
        trial_universe_marker_type: 'complete_trial_universe',
        raw_m_complete: true,
        includes_failed_trials: true,
        raw_m: 5,
        effective_m: 3,
        included_trial_count: 5,
        failed_trial_count: 4,
        surviving_trial_count: 1,
      },
    })
  })

  it('rejects inconsistent complete trial universe marker counts', () => {
    expect(() =>
      buildCompleteTrialUniverseMarkerRecord({
        trialId: 'bad-marker',
        evidenceId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        fdrFamily: '2026Q2_crypto_evidence_os_v4',
        rawM: 5,
        effectiveM: 3,
        includedTrialCount: 4,
        failedTrialCount: 3,
        survivingTrialCount: 1,
      }),
    ).toThrow(/includedTrialCount must equal rawM/)
  })

  it('marks malformed JSONL lines as corrupt registry hard blocks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-trial-registry-'))
    const path = join(root, 'trial_registry.jsonl')

    await writeFile(
      path,
      `${JSON.stringify(trialRecordToJson(makeTrialRecord()))}\n{"trial_id":\n`,
      'utf-8',
    )

    const registry = await readTrialRegistry(path)
    expect(registry.records).toHaveLength(1)
    expect(registry.corruptLines).toHaveLength(1)
    expect(registry.hardBlockCodes).toContain(CORRUPT_TRIAL_REGISTRY)
  })

  it('rejects missing evidence_id', () => {
    expect(() =>
      trialRecordFromJson({
        ...trialRecordToJson(makeTrialRecord()),
        evidence_id: '',
      }),
    ).toThrow(MISSING_EVIDENCE_ID)
  })

  it('rejects free-form failure codes', () => {
    expect(() =>
      trialRecordFromJson({
        ...trialRecordToJson(makeTrialRecord()),
        failure_codes: ['engineer_wrote_a_note'],
      }),
    ).toThrow(/unsupported codes/)

    expect(() =>
      trialRecordToJson({
        ...makeTrialRecord(),
        failureCodes: ['engineer_wrote_a_note' as never],
      }),
    ).toThrow(/Unsupported failure_code/)
  })

  it('allows diagnostic trials only when promotion_eligible is false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-trial-registry-'))
    const path = join(root, 'trial_registry.jsonl')

    await appendTrialRecord(
      makeTrialRecord({
        trialId: 'diagnostic-1',
        trialType: 'diagnostic_factor',
        strategyFamily: 'kronos_forecast_shadow',
        promotionEligible: false,
        status: 'registered',
        failureCodes: [],
      }),
      path,
    )

    await expect(
      appendTrialRecord(
        makeTrialRecord({
          trialId: 'diagnostic-2',
          trialType: 'diagnostic_factor',
          strategyFamily: 'kronos_forecast_shadow',
          promotionEligible: true,
        }),
        path,
      ),
    ).rejects.toMatchObject({
      code: 'DIAGNOSTIC_TRIAL_PROMOTION_ELIGIBLE',
    })
  })

  it('hard-blocks semantic inconsistency in strict trial_record core fields', () => {
    const artifact = makeTrialRecord({ status: 'blocked_missing_fdr', promotionEligible: false })
    const registry = makeTrialRecord({ status: 'failed_fdr', promotionEligible: false })

    const result = validateTrialRecordConsistency(artifact, registry)

    expect(result.passed).toBe(false)
    expect(result.blockingReasons).toEqual([
      {
        code: 'TRIAL_RECORD_CORE_FIELD_MISMATCH',
        field: 'status',
        artifactValue: 'blocked_missing_fdr',
        registryValue: 'failed_fdr',
      },
    ])
  })
})
