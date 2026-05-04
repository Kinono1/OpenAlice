export const FAILURE_CODES = [
  'ACCOUNTING_BUG',
  'BENCHMARK_UNDERPERFORM',
  'COST_FRAGILE',
  'CORRUPT_TRIAL_REGISTRY',
  'DUPLICATE_OF_FAILED_CANDIDATE',
  'EXECUTION_INFEASIBLE',
  'FDR_INPUTS_INCOMPLETE',
  'FDR_FAILED',
  'FEATURE_AVAILABILITY_MISSING',
  'FORECAST_NO_INCREMENTAL_EDGE',
  'MISSING_FDR_REPORT',
  'MISSING_LIVE_ONLY_EVIDENCE',
  'PAPER_LIVE_DIVERGENCE',
  'PIT_AUDIT_NOT_IMPLEMENTED',
  'PIT_PROXY_ONLY',
  'PIT_VIOLATION',
  'REGIME_ONLY',
  'STALE_SOURCE',
  'TRIAL_NOT_REGISTERED',
  'UNIVERSE_LEAKAGE',
  'WFO_DEGRADED',
] as const

export type FailureCode = (typeof FAILURE_CODES)[number]

export type FailureSeverity = 'hard_block' | 'research_block' | 'warning'

export type NextMutation =
  | 'retry_with_wider_universe'
  | 'retry_with_lower_turnover'
  | 'retry_after_data_fix'
  | 'retry_after_pit_fix'
  | 'retry_after_cost_model_fix'
  | 'retry_after_execution_fix'
  | 'retry_with_new_model_or_feature_set'
  | 'retry_after_live_only_evidence'
  | 'retry_after_new_hypothesis'
  | 'retire_no_retry'
  | 'requires_human_review'

export interface FailureTaxonomyEntry {
  code: FailureCode
  severity: FailureSeverity
  category:
    | 'accounting'
    | 'benchmark'
    | 'cost_model'
    | 'data_quality'
    | 'execution'
    | 'lineage'
    | 'model_incrementality'
    | 'paper_evidence'
    | 'registry_integrity'
    | 'statistical_validity'
  promotionRelevance: boolean
  retryPolicy: string
  defaultNextMutation: NextMutation
}

export const FAILURE_TAXONOMY: Record<FailureCode, FailureTaxonomyEntry> = {
  ACCOUNTING_BUG: {
    code: 'ACCOUNTING_BUG',
    severity: 'hard_block',
    category: 'accounting',
    promotionRelevance: true,
    retryPolicy: 'fix accounting semantics before any rerun can count as promotion evidence',
    defaultNextMutation: 'retry_after_cost_model_fix',
  },
  BENCHMARK_UNDERPERFORM: {
    code: 'BENCHMARK_UNDERPERFORM',
    severity: 'hard_block',
    category: 'benchmark',
    promotionRelevance: true,
    retryPolicy: 'new hypothesis or materially better execution/cost profile required',
    defaultNextMutation: 'retry_after_new_hypothesis',
  },
  COST_FRAGILE: {
    code: 'COST_FRAGILE',
    severity: 'hard_block',
    category: 'cost_model',
    promotionRelevance: true,
    retryPolicy: 'rerun after fee, slippage, spread, and funding assumptions are locked',
    defaultNextMutation: 'retry_after_cost_model_fix',
  },
  CORRUPT_TRIAL_REGISTRY: {
    code: 'CORRUPT_TRIAL_REGISTRY',
    severity: 'hard_block',
    category: 'registry_integrity',
    promotionRelevance: true,
    retryPolicy: 'repair append-only registry before consuming any trial evidence',
    defaultNextMutation: 'requires_human_review',
  },
  DUPLICATE_OF_FAILED_CANDIDATE: {
    code: 'DUPLICATE_OF_FAILED_CANDIDATE',
    severity: 'research_block',
    category: 'statistical_validity',
    promotionRelevance: true,
    retryPolicy: 'only retry with a new hypothesis, new data, or materially different feature set',
    defaultNextMutation: 'retry_after_new_hypothesis',
  },
  EXECUTION_INFEASIBLE: {
    code: 'EXECUTION_INFEASIBLE',
    severity: 'hard_block',
    category: 'execution',
    promotionRelevance: true,
    retryPolicy: 'rerun only after fill, slippage, capacity, and idempotency constraints are fixed',
    defaultNextMutation: 'retry_after_execution_fix',
  },
  FDR_INPUTS_INCOMPLETE: {
    code: 'FDR_INPUTS_INCOMPLETE',
    severity: 'hard_block',
    category: 'statistical_validity',
    promotionRelevance: true,
    retryPolicy: 'complete trial universe and finite p-values are required before FDR can be promotion evidence',
    defaultNextMutation: 'retry_after_new_hypothesis',
  },
  FDR_FAILED: {
    code: 'FDR_FAILED',
    severity: 'hard_block',
    category: 'statistical_validity',
    promotionRelevance: true,
    retryPolicy: 'new hypothesis required; parameter retuning inside the same family is not enough',
    defaultNextMutation: 'retry_after_new_hypothesis',
  },
  FEATURE_AVAILABILITY_MISSING: {
    code: 'FEATURE_AVAILABILITY_MISSING',
    severity: 'hard_block',
    category: 'lineage',
    promotionRelevance: true,
    retryPolicy: 'define feature schema and available_time policy before validation can count',
    defaultNextMutation: 'retry_after_data_fix',
  },
  FORECAST_NO_INCREMENTAL_EDGE: {
    code: 'FORECAST_NO_INCREMENTAL_EDGE',
    severity: 'research_block',
    category: 'model_incrementality',
    promotionRelevance: true,
    retryPolicy: 'retry only with new model provenance, feature set, or comparison profile',
    defaultNextMutation: 'retry_with_new_model_or_feature_set',
  },
  MISSING_FDR_REPORT: {
    code: 'MISSING_FDR_REPORT',
    severity: 'hard_block',
    category: 'statistical_validity',
    promotionRelevance: true,
    retryPolicy: 'generate full-family FDR report including failed and aborted trials',
    defaultNextMutation: 'retry_after_new_hypothesis',
  },
  MISSING_LIVE_ONLY_EVIDENCE: {
    code: 'MISSING_LIVE_ONLY_EVIDENCE',
    severity: 'hard_block',
    category: 'paper_evidence',
    promotionRelevance: true,
    retryPolicy: 'collect configured live_only paper evidence with immutable reports',
    defaultNextMutation: 'retry_after_live_only_evidence',
  },
  PAPER_LIVE_DIVERGENCE: {
    code: 'PAPER_LIVE_DIVERGENCE',
    severity: 'hard_block',
    category: 'paper_evidence',
    promotionRelevance: true,
    retryPolicy: 'diagnose paper/live-only divergence before promotion evidence can be reused',
    defaultNextMutation: 'retry_after_execution_fix',
  },
  PIT_AUDIT_NOT_IMPLEMENTED: {
    code: 'PIT_AUDIT_NOT_IMPLEMENTED',
    severity: 'hard_block',
    category: 'lineage',
    promotionRelevance: true,
    retryPolicy: 'implement PIT audit before allowing pass verdicts',
    defaultNextMutation: 'retry_after_pit_fix',
  },
  PIT_PROXY_ONLY: {
    code: 'PIT_PROXY_ONLY',
    severity: 'hard_block',
    category: 'lineage',
    promotionRelevance: true,
    retryPolicy: 'replace proxy event-time ordering with promotion-grade system arrival_time evidence',
    defaultNextMutation: 'retry_after_pit_fix',
  },
  PIT_VIOLATION: {
    code: 'PIT_VIOLATION',
    severity: 'hard_block',
    category: 'lineage',
    promotionRelevance: true,
    retryPolicy: 'fix available_time policy and rerun from raw inputs',
    defaultNextMutation: 'retry_after_pit_fix',
  },
  REGIME_ONLY: {
    code: 'REGIME_ONLY',
    severity: 'research_block',
    category: 'statistical_validity',
    promotionRelevance: true,
    retryPolicy: 'requires explicit regime contract or wider sample before retry',
    defaultNextMutation: 'retry_with_wider_universe',
  },
  STALE_SOURCE: {
    code: 'STALE_SOURCE',
    severity: 'hard_block',
    category: 'data_quality',
    promotionRelevance: true,
    retryPolicy: 'refresh or replace stale source before evidence can be consumed',
    defaultNextMutation: 'retry_after_data_fix',
  },
  TRIAL_NOT_REGISTERED: {
    code: 'TRIAL_NOT_REGISTERED',
    severity: 'hard_block',
    category: 'registry_integrity',
    promotionRelevance: true,
    retryPolicy: 'append trial record before promotion artifact can cite the evidence',
    defaultNextMutation: 'requires_human_review',
  },
  UNIVERSE_LEAKAGE: {
    code: 'UNIVERSE_LEAKAGE',
    severity: 'hard_block',
    category: 'statistical_validity',
    promotionRelevance: true,
    retryPolicy: 'rerun with execution-eligible universe attribution locked',
    defaultNextMutation: 'retry_with_wider_universe',
  },
  WFO_DEGRADED: {
    code: 'WFO_DEGRADED',
    severity: 'hard_block',
    category: 'statistical_validity',
    promotionRelevance: true,
    retryPolicy: 'retry only after new hypothesis, lower turnover, or more stable universe',
    defaultNextMutation: 'retry_with_lower_turnover',
  },
}

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === 'string' && value in FAILURE_TAXONOMY
}

export function assertFailureCode(value: unknown): asserts value is FailureCode {
  if (!isFailureCode(value)) {
    throw new Error(`Unsupported failure_code: ${String(value)}`)
  }
}

export function deriveNextMutation(failureCodes: readonly FailureCode[]): NextMutation {
  if (failureCodes.length === 0) return 'requires_human_review'
  if (failureCodes.includes('FDR_FAILED') || failureCodes.includes('FDR_INPUTS_INCOMPLETE')) {
    return 'retry_after_new_hypothesis'
  }
  if (
    failureCodes.includes('PIT_VIOLATION') ||
    failureCodes.includes('PIT_AUDIT_NOT_IMPLEMENTED') ||
    failureCodes.includes('PIT_PROXY_ONLY')
  ) {
    return 'retry_after_pit_fix'
  }
  if (
    failureCodes.includes('COST_FRAGILE') ||
    failureCodes.includes('ACCOUNTING_BUG')
  ) {
    return 'retry_after_cost_model_fix'
  }
  if (
    failureCodes.includes('FEATURE_AVAILABILITY_MISSING') ||
    failureCodes.includes('STALE_SOURCE')
  ) {
    return 'retry_after_data_fix'
  }
  if (
    failureCodes.includes('EXECUTION_INFEASIBLE') ||
    failureCodes.includes('PAPER_LIVE_DIVERGENCE')
  ) {
    return 'retry_after_execution_fix'
  }
  if (failureCodes.includes('FORECAST_NO_INCREMENTAL_EDGE')) {
    return 'retry_with_new_model_or_feature_set'
  }
  if (failureCodes.includes('UNIVERSE_LEAKAGE') || failureCodes.includes('REGIME_ONLY')) {
    return 'retry_with_wider_universe'
  }
  if (failureCodes.includes('WFO_DEGRADED')) return 'retry_with_lower_turnover'
  if (failureCodes.includes('MISSING_LIVE_ONLY_EVIDENCE')) return 'retry_after_live_only_evidence'
  if (
    failureCodes.includes('CORRUPT_TRIAL_REGISTRY') ||
    failureCodes.includes('TRIAL_NOT_REGISTERED')
  ) {
    return 'requires_human_review'
  }
  return FAILURE_TAXONOMY[failureCodes[0]].defaultNextMutation
}
