import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  isFailureCode,
  type FailureCode,
} from '../research/failure_taxonomy.js'

export const DEFAULT_TRIAL_REGISTRY_PATH = 'runtime/research/trial_registry.jsonl'
export const CORRUPT_TRIAL_REGISTRY = 'CORRUPT_TRIAL_REGISTRY'
export const DUPLICATE_TRIAL_ID = 'DUPLICATE_TRIAL_ID'
export const MISSING_EVIDENCE_ID = 'MISSING_EVIDENCE_ID'
export const MISSING_FDR_PROVENANCE = 'MISSING_FDR_PROVENANCE'
export const MISSING_PIT_AUDIT_PROVENANCE = 'MISSING_PIT_AUDIT_PROVENANCE'
export const INCONSISTENT_TRIAL_PROVENANCE = 'INCONSISTENT_TRIAL_PROVENANCE'

const TRIAL_PROVENANCE_VALUES = {
  pValueSource: ['missing', 'fdr_report', 'registry_row', 'manual_import'] as const,
  fdrReportPathSource: ['generated_artifact', 'registry_metadata', 'artifact_link', 'manual_import'] as const,
  fdrPValuePromotionGradeSource: ['fdr_report', 'registry_metadata', 'manual_import'] as const,
  pitAuditSource: ['feature_availability_audit', 'registry_metadata', 'artifact_link', 'manual_import'] as const,
  pitAuditPromotionGradeSource: ['feature_availability_audit', 'promotion_grade_row_level_audit', 'registry_metadata', 'artifact_link', 'manual_import', 'default_fail_closed'] as const,
  promotionDecisionSource: ['fail_closed_validation_pipeline', 'manual_review', 'promotion_v2'] as const,
}

export type TrialType = 'alpha_candidate' | 'diagnostic_factor'

export type TrialStatus =
  | 'aborted'
  | 'blocked_missing_fdr'
  | 'failed_fdr'
  | 'failed_validation'
  | 'invalid_params'
  | 'passed_research'
  | 'registered'

export interface TrialRecord {
  trialId: string
  evidenceId: string
  trialType: TrialType
  strategyFamily: string
  candidateId: string
  hypothesis: string
  primaryMetric: string
  secondaryMetrics: string[]
  pValue: number | null
  includedInFdr: boolean
  fdrFamily: string
  promotionEligible: boolean
  status: TrialStatus
  failureCodes: FailureCode[]
  batchId?: string | null
  createdAt?: string
  metadata?: Record<string, unknown>
}

export interface TrialRegistryCorruptLine {
  lineNumber: number
  raw: string
  error: string
}

export interface TrialRegistryReadResult {
  records: TrialRecord[]
  corruptLines: TrialRegistryCorruptLine[]
  hardBlockCodes: string[]
}

export interface TrialRecordConsistencyResult {
  passed: boolean
  blockingReasons: Array<{
    code: string
    field: 'trial_id' | 'evidence_id' | 'status' | 'promotion_eligible'
    artifactValue: unknown
    registryValue: unknown
  }>
}

export interface CompleteTrialUniverseMarkerInput {
  trialId: string
  evidenceId: string
  fdrFamily: string
  rawM: number
  effectiveM: number
  includedTrialCount: number
  failedTrialCount: number
  survivingTrialCount: number
  batchId?: string | null
  createdAt?: string
}

export class TrialRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'TrialRegistryError'
  }
}

export function buildCompleteTrialUniverseMarkerRecord(
  input: CompleteTrialUniverseMarkerInput,
): TrialRecord {
  const rawM = nonNegativeInteger(input.rawM, 'rawM')
  const effectiveM = nonNegativeInteger(input.effectiveM, 'effectiveM')
  const includedTrialCount = nonNegativeInteger(input.includedTrialCount, 'includedTrialCount')
  const failedTrialCount = nonNegativeInteger(input.failedTrialCount, 'failedTrialCount')
  const survivingTrialCount = nonNegativeInteger(input.survivingTrialCount, 'survivingTrialCount')
  if (includedTrialCount !== rawM) {
    throw new TrialRegistryError('includedTrialCount must equal rawM for complete trial universe marker', 'INVALID_TRIAL_UNIVERSE_MARKER')
  }
  if (failedTrialCount + survivingTrialCount !== includedTrialCount) {
    throw new TrialRegistryError('failedTrialCount + survivingTrialCount must equal includedTrialCount', 'INVALID_TRIAL_UNIVERSE_MARKER')
  }
  return {
    trialId: input.trialId,
    evidenceId: input.evidenceId,
    trialType: 'diagnostic_factor',
    strategyFamily: 'trial_universe',
    candidateId: 'complete_trial_universe',
    hypothesis: 'Complete trial universe marker for BY raw_m and failed-trial coverage.',
    primaryMetric: 'trial_universe_completeness',
    secondaryMetrics: ['raw_m', 'effective_m', 'failed_trial_count', 'surviving_trial_count'],
    pValue: null,
    includedInFdr: false,
    fdrFamily: input.fdrFamily,
    promotionEligible: false,
    status: 'registered',
    failureCodes: [],
    batchId: input.batchId ?? null,
    createdAt: input.createdAt,
    metadata: {
      trial_universe_marker: true,
      trial_universe_marker_type: 'complete_trial_universe',
      raw_m_complete: true,
      includes_failed_trials: true,
      raw_m: rawM,
      effective_m: effectiveM,
      included_trial_count: includedTrialCount,
      failed_trial_count: failedTrialCount,
      surviving_trial_count: survivingTrialCount,
      p_value_source: 'missing',
      promotion_decision_source: 'fail_closed_validation_pipeline',
    },
  }
}

export async function appendTrialRecord(
  record: TrialRecord,
  path = DEFAULT_TRIAL_REGISTRY_PATH,
): Promise<void> {
  assertValidTrialRecord(record)
  assertAppendableTrialRecord(record)
  const resolvedPath = resolve(path)
  const existing = await readTrialRegistry(resolvedPath)
  if (existing.hardBlockCodes.length > 0) {
    throw new TrialRegistryError(
      `Trial registry is corrupt: ${existing.hardBlockCodes.join(',')}`,
      CORRUPT_TRIAL_REGISTRY,
    )
  }
  if (existing.records.some((existingRecord) => existingRecord.trialId === record.trialId)) {
    throw new TrialRegistryError(`Duplicate trial_id: ${record.trialId}`, DUPLICATE_TRIAL_ID)
  }

  await mkdir(dirname(resolvedPath), { recursive: true })
  await appendFile(resolvedPath, `${JSON.stringify(trialRecordToJson(record))}\n`, 'utf-8')
}

export async function readTrialRegistry(
  path = DEFAULT_TRIAL_REGISTRY_PATH,
): Promise<TrialRegistryReadResult> {
  const resolvedPath = resolve(path)
  let text = ''
  try {
    text = await readFile(resolvedPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], corruptLines: [], hardBlockCodes: [] }
    }
    throw err
  }

  const records: TrialRecord[] = []
  const corruptLines: TrialRegistryCorruptLine[] = []
  const seenTrialIds = new Set<string>()
  const duplicateTrialIds = new Set<string>()
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    if (!raw.trim()) continue
    try {
      const record = trialRecordFromJson(JSON.parse(raw) as unknown)
      records.push(record)
      if (seenTrialIds.has(record.trialId)) {
        duplicateTrialIds.add(record.trialId)
      }
      seenTrialIds.add(record.trialId)
    } catch (err) {
      corruptLines.push({
        lineNumber: index + 1,
        raw,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    records,
    corruptLines,
    hardBlockCodes: [
      ...(corruptLines.length > 0 ? [CORRUPT_TRIAL_REGISTRY] : []),
      ...(duplicateTrialIds.size > 0 ? [DUPLICATE_TRIAL_ID] : []),
    ],
  }
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TrialRegistryError(`${field} must be a non-negative integer`, 'INVALID_TRIAL_UNIVERSE_MARKER')
  }
  return value
}

export function assertValidTrialRecord(record: TrialRecord): void {
  if (!record.trialId.trim()) {
    throw new TrialRegistryError('trial_id is required', 'MISSING_TRIAL_ID')
  }
  if (!record.evidenceId.trim()) {
    throw new TrialRegistryError('evidence_id is required', MISSING_EVIDENCE_ID)
  }
  if (!record.strategyFamily.trim()) {
    throw new TrialRegistryError('strategy_family is required', 'MISSING_STRATEGY_FAMILY')
  }
  if (!record.candidateId.trim()) {
    throw new TrialRegistryError('candidate_id is required', 'MISSING_CANDIDATE_ID')
  }
  if (!record.fdrFamily.trim()) {
    throw new TrialRegistryError('fdr_family is required', 'MISSING_FDR_FAMILY')
  }
  if (record.trialType === 'diagnostic_factor' && record.promotionEligible) {
    throw new TrialRegistryError(
      'diagnostic_factor trials must be promotion ineligible',
      'DIAGNOSTIC_TRIAL_PROMOTION_ELIGIBLE',
    )
  }
  for (const code of record.failureCodes) {
    if (!isFailureCode(code)) {
      throw new TrialRegistryError(`Unsupported failure_code: ${String(code)}`, CORRUPT_TRIAL_REGISTRY)
    }
  }
  const invalidProvenance = invalidTrialProvenanceEnumFields(record.metadata ?? {})
  if (invalidProvenance.length > 0) {
    throw new TrialRegistryError(
      `trial provenance has unsupported values: ${invalidProvenance.join(',')}`,
      CORRUPT_TRIAL_REGISTRY,
    )
  }
}

export function assertAppendableTrialRecord(record: TrialRecord): void {
  if (record.trialType !== 'alpha_candidate' || record.includedInFdr !== true) return

  const metadata = record.metadata ?? {}
  const missingFdr = missingFdrProvenanceFields(record, metadata)
  if (missingFdr.length > 0) {
    throw new TrialRegistryError(
      `included FDR alpha trials require FDR provenance: ${missingFdr.join(',')}`,
      MISSING_FDR_PROVENANCE,
    )
  }

  const missingPit = missingPitAuditProvenanceFields(metadata)
  if (missingPit.length > 0) {
    throw new TrialRegistryError(
      `included FDR alpha trials require PIT audit provenance: ${missingPit.join(',')}`,
      MISSING_PIT_AUDIT_PROVENANCE,
    )
  }

  const inconsistent = inconsistentTrialProvenanceFields(record, metadata)
  if (inconsistent.length > 0) {
    throw new TrialRegistryError(
      `trial provenance is inconsistent: ${inconsistent.join(',')}`,
      INCONSISTENT_TRIAL_PROVENANCE,
    )
  }
}

function missingFdrProvenanceFields(
  record: TrialRecord,
  metadata: Record<string, unknown>,
): string[] {
  const missing: string[] = []
  if (!nonEmptyString(metadata.fdr_report_path) && !nonEmptyString(metadata.fdrReportPath)) {
    missing.push('metadata.fdr_report_path')
  }
  if (!nonEmptyString(metadata.fdr_report_status) && !nonEmptyString(metadata.fdrReportStatus)) {
    missing.push('metadata.fdr_report_status')
  }
  if (typeof (metadata.raw_m_complete ?? metadata.rawMComplete) !== 'boolean') {
    missing.push('metadata.raw_m_complete')
  }
  if (typeof (metadata.includes_failed_trials ?? metadata.includesFailedTrials) !== 'boolean') {
    missing.push('metadata.includes_failed_trials')
  }
  if (typeof (metadata.fdr_p_values_available ?? metadata.fdrPValuesAvailable) !== 'boolean') {
    missing.push('metadata.fdr_p_values_available')
  }
  if (nullableFiniteNumber(metadata.fdr_missing_p_value_count ?? metadata.fdrMissingPValueCount) == null) {
    missing.push('metadata.fdr_missing_p_value_count')
  }
  if (record.pValue == null) {
    if (!nonEmptyString(metadata.fdr_p_value_blocked_reason) && !nonEmptyString(metadata.fdrPValueBlockedReason)) {
      missing.push('metadata.fdr_p_value_blocked_reason')
    }
  } else {
    if (!nonEmptyString(metadata.fdr_p_value_method) && !nonEmptyString(metadata.fdrPValueMethod)) {
      missing.push('metadata.fdr_p_value_method')
    }
    if (!nonEmptyString(metadata.fdr_p_value_scope) && !nonEmptyString(metadata.fdrPValueScope)) {
      missing.push('metadata.fdr_p_value_scope')
    }
    if (typeof (metadata.fdr_p_value_is_promotion_grade ?? metadata.fdrPValueIsPromotionGrade) !== 'boolean') {
      missing.push('metadata.fdr_p_value_is_promotion_grade')
    }
  }
  return missing
}

function missingPitAuditProvenanceFields(metadata: Record<string, unknown>): string[] {
  const missing: string[] = []
  if (
    !nonEmptyString(metadata.pit_audit_path) &&
    !nonEmptyString(metadata.pitAuditPath) &&
    !nonEmptyString(metadata.feature_availability_audit_path) &&
    !nonEmptyString(metadata.featureAvailabilityAuditPath)
  ) {
    missing.push('metadata.pit_audit_path')
  }
  if (!nonEmptyString(metadata.pit_audit_status) && !nonEmptyString(metadata.pitAuditStatus)) {
    missing.push('metadata.pit_audit_status')
  }
  if (typeof (metadata.pit_audit_promotion_grade ?? metadata.pitAuditPromotionGrade) !== 'boolean') {
    missing.push('metadata.pit_audit_promotion_grade')
  }
  const pitStatus = stringValue(metadata.pit_audit_status ?? metadata.pitAuditStatus)
  const blockingCodes = stringArrayValue(metadata.pit_audit_blocking_codes ?? metadata.pitAuditBlockingCodes)
  if (pitStatus !== 'pass' && blockingCodes.length === 0) {
    missing.push('metadata.pit_audit_blocking_codes')
  }
  return missing
}

function inconsistentTrialProvenanceFields(
  record: TrialRecord,
  metadata: Record<string, unknown>,
): string[] {
  const inconsistent: string[] = []
  const fdrPValuesAvailable = booleanValue(metadata.fdr_p_values_available ?? metadata.fdrPValuesAvailable)
  const missingPValueCount = nullableFiniteNumber(metadata.fdr_missing_p_value_count ?? metadata.fdrMissingPValueCount)
  const pValuePromotionGrade = booleanValue(metadata.fdr_p_value_is_promotion_grade ?? metadata.fdrPValueIsPromotionGrade)
  const pitStatus = stringValue(metadata.pit_audit_status ?? metadata.pitAuditStatus)
  const pitPromotionGrade = booleanValue(metadata.pit_audit_promotion_grade ?? metadata.pitAuditPromotionGrade)

  if (record.pValue == null && fdrPValuesAvailable === true) {
    inconsistent.push('p_value_null_but_fdr_p_values_available=true')
  }
  if (record.pValue != null && fdrPValuesAvailable === false) {
    inconsistent.push('p_value_present_but_fdr_p_values_available=false')
  }
  if (record.pValue != null && missingPValueCount != null && missingPValueCount !== 0) {
    inconsistent.push('p_value_present_but_missing_p_value_count_nonzero')
  }
  if (pValuePromotionGrade === true) {
    const rawMComplete = booleanValue(metadata.raw_m_complete ?? metadata.rawMComplete)
    const includesFailedTrials = booleanValue(metadata.includes_failed_trials ?? metadata.includesFailedTrials)
    if (rawMComplete !== true || includesFailedTrials !== true) {
      inconsistent.push('promotion_grade_p_value_without_complete_trial_universe')
    }
  }
  if (pitPromotionGrade === true && pitStatus !== 'pass') {
    inconsistent.push('promotion_grade_pit_audit_without_pass_status')
  }
  if (record.promotionEligible) {
    const rawMComplete = booleanValue(metadata.raw_m_complete ?? metadata.rawMComplete)
    const includesFailedTrials = booleanValue(metadata.includes_failed_trials ?? metadata.includesFailedTrials)
    if (rawMComplete !== true) inconsistent.push('promotion_eligible_without_raw_m_complete')
    if (includesFailedTrials !== true) inconsistent.push('promotion_eligible_without_failed_trials')
    if (pValuePromotionGrade !== true) inconsistent.push('promotion_eligible_without_promotion_grade_p_value')
    if (pitPromotionGrade !== true) inconsistent.push('promotion_eligible_without_promotion_grade_pit_audit')
    if (pitStatus !== 'pass') inconsistent.push('promotion_eligible_without_pit_audit_pass')
  }
  return inconsistent
}

function invalidTrialProvenanceEnumFields(metadata: Record<string, unknown>): string[] {
  return [
    validateOptionalEnum(
      metadata.p_value_source ?? metadata.pValueSource,
      'metadata.p_value_source',
      TRIAL_PROVENANCE_VALUES.pValueSource,
    ),
    validateOptionalEnum(
      metadata.fdr_report_path_source ?? metadata.fdrReportPathSource,
      'metadata.fdr_report_path_source',
      TRIAL_PROVENANCE_VALUES.fdrReportPathSource,
    ),
    validateOptionalEnum(
      metadata.fdr_p_value_promotion_grade_source ?? metadata.fdrPValuePromotionGradeSource,
      'metadata.fdr_p_value_promotion_grade_source',
      TRIAL_PROVENANCE_VALUES.fdrPValuePromotionGradeSource,
    ),
    validateOptionalEnum(
      metadata.pit_audit_source ?? metadata.pitAuditSource,
      'metadata.pit_audit_source',
      TRIAL_PROVENANCE_VALUES.pitAuditSource,
    ),
    validateOptionalEnum(
      metadata.pit_audit_promotion_grade_source ?? metadata.pitAuditPromotionGradeSource,
      'metadata.pit_audit_promotion_grade_source',
      TRIAL_PROVENANCE_VALUES.pitAuditPromotionGradeSource,
    ),
    validateOptionalEnum(
      metadata.promotion_decision_source ?? metadata.promotionDecisionSource,
      'metadata.promotion_decision_source',
      TRIAL_PROVENANCE_VALUES.promotionDecisionSource,
    ),
  ].filter((item): item is string => item != null)
}

function validateOptionalEnum<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
): string | null {
  if (value == null) return null
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    return `${field}:${String(value)}`
  }
  return null
}

export function trialRecordToJson(record: TrialRecord): Record<string, unknown> {
  assertValidTrialRecord(record)
  return {
    trial_id: record.trialId,
    evidence_id: record.evidenceId,
    trial_type: record.trialType,
    strategy_family: record.strategyFamily,
    candidate_id: record.candidateId,
    hypothesis: record.hypothesis,
    primary_metric: record.primaryMetric,
    secondary_metrics: record.secondaryMetrics,
    p_value: record.pValue,
    included_in_fdr: record.includedInFdr,
    fdr_family: record.fdrFamily,
    promotion_eligible: record.promotionEligible,
    status: record.status,
    failure_codes: record.failureCodes,
    batch_id: record.batchId ?? null,
    created_at: record.createdAt ?? null,
    metadata: record.metadata ?? {},
  }
}

export function trialRecordFromJson(value: unknown): TrialRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TrialRegistryError('trial record must be an object', CORRUPT_TRIAL_REGISTRY)
  }
  const raw = value as Record<string, unknown>
  const record: TrialRecord = {
    trialId: requireString(raw.trial_id, 'trial_id'),
    evidenceId: requireEvidenceId(raw.evidence_id),
    trialType: parseTrialType(raw.trial_type),
    strategyFamily: requireString(raw.strategy_family, 'strategy_family'),
    candidateId: requireString(raw.candidate_id, 'candidate_id'),
    hypothesis: requireString(raw.hypothesis, 'hypothesis'),
    primaryMetric: requireString(raw.primary_metric, 'primary_metric'),
    secondaryMetrics: parseStringArray(raw.secondary_metrics, 'secondary_metrics'),
    pValue: parseNullableNumber(raw.p_value, 'p_value'),
    includedInFdr: requireBoolean(raw.included_in_fdr, 'included_in_fdr'),
    fdrFamily: requireString(raw.fdr_family, 'fdr_family'),
    promotionEligible: requireBoolean(raw.promotion_eligible, 'promotion_eligible'),
    status: parseTrialStatus(raw.status),
    failureCodes: parseFailureCodes(raw.failure_codes),
    batchId: raw.batch_id === null || raw.batch_id === undefined ? null : requireString(raw.batch_id, 'batch_id'),
    createdAt:
      raw.created_at === null || raw.created_at === undefined
        ? undefined
        : requireString(raw.created_at, 'created_at'),
    metadata: parseMetadata(raw.metadata),
  }
  assertValidTrialRecord(record)
  return record
}

export function validateTrialRecordConsistency(
  artifactRecord: TrialRecord,
  registryRecord: TrialRecord,
): TrialRecordConsistencyResult {
  const pairs: Array<{
    field: 'trial_id' | 'evidence_id' | 'status' | 'promotion_eligible'
    artifactValue: unknown
    registryValue: unknown
  }> = [
    {
      field: 'trial_id',
      artifactValue: artifactRecord.trialId,
      registryValue: registryRecord.trialId,
    },
    {
      field: 'evidence_id',
      artifactValue: artifactRecord.evidenceId,
      registryValue: registryRecord.evidenceId,
    },
    {
      field: 'status',
      artifactValue: artifactRecord.status,
      registryValue: registryRecord.status,
    },
    {
      field: 'promotion_eligible',
      artifactValue: artifactRecord.promotionEligible,
      registryValue: registryRecord.promotionEligible,
    },
  ]

  const blockingReasons = pairs
    .filter((pair) => pair.artifactValue !== pair.registryValue)
    .map((pair) => ({
      code: 'TRIAL_RECORD_CORE_FIELD_MISMATCH',
      ...pair,
    }))

  return {
    passed: blockingReasons.length === 0,
    blockingReasons,
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TrialRegistryError(`${field} must be a non-empty string`, CORRUPT_TRIAL_REGISTRY)
  }
  return value
}

function requireEvidenceId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TrialRegistryError(MISSING_EVIDENCE_ID, MISSING_EVIDENCE_ID)
  }
  return value
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TrialRegistryError(`${field} must be a boolean`, CORRUPT_TRIAL_REGISTRY)
  }
  return value
}

function parseNullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TrialRegistryError(`${field} must be a finite number or null`, CORRUPT_TRIAL_REGISTRY)
  }
  return value
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TrialRegistryError(`${field} must be a string array`, CORRUPT_TRIAL_REGISTRY)
  }
  return value
}

function parseFailureCodes(value: unknown): FailureCode[] {
  const codes = parseStringArray(value, 'failure_codes')
  const unsupported = codes.filter((code) => !isFailureCode(code))
  if (unsupported.length > 0) {
    throw new TrialRegistryError(
      `failure_codes contains unsupported codes: ${unsupported.join(',')}`,
      CORRUPT_TRIAL_REGISTRY,
    )
  }
  return codes as FailureCode[]
}

function parseTrialType(value: unknown): TrialType {
  if (value === 'alpha_candidate' || value === 'diagnostic_factor') return value
  throw new TrialRegistryError('trial_type is invalid', CORRUPT_TRIAL_REGISTRY)
}

function parseTrialStatus(value: unknown): TrialStatus {
  if (
    value === 'aborted' ||
    value === 'blocked_missing_fdr' ||
    value === 'failed_fdr' ||
    value === 'failed_validation' ||
    value === 'invalid_params' ||
    value === 'passed_research' ||
    value === 'registered'
  ) {
    return value
  }
  throw new TrialRegistryError('status is invalid', CORRUPT_TRIAL_REGISTRY)
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TrialRegistryError('metadata must be an object', CORRUPT_TRIAL_REGISTRY)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function stringValue(value: unknown): string | null {
  return nonEmptyString(value) ? (value as string).trim() : null
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}
