import {
  deriveNextMutation,
  isFailureCode,
  type FailureCode,
  type NextMutation,
} from '../../research/failure_taxonomy.js'

export type StrategyFamilyRole =
  | 'alpha'
  | 'diagnostic'
  | 'conditioning_filter'
  | 'execution_cost'
  | 'research'

export type PromotionEligibility =
  | 'research_only'
  | 'paper_candidate'
  | 'live_candidate_blocked'

export interface FeatureRequirement {
  featureId: string
  required: boolean
  availableTimePolicy: 'available_time <= decision_time'
  qualityStatusesAllowed: ['ok'] | ['ok', 'degraded']
}

export interface PaperEvidenceRequirement {
  minLiveOnlyDays: number
  minDecisionCount: number
  minExecutedTradeCount: number
  minEventCount: number
  maxReportAgeSeconds: number
}

export interface StrategyFamilyContract {
  familyId: string
  role: StrategyFamilyRole
  requiredFeatures: FeatureRequirement[]
  decisionHorizon: string
  labelHorizon: string
  allowedUniverse: string[]
  maxTurnover: number
  maxLeverage: number
  promotionEligibility: PromotionEligibility
  failureModes: FailureCode[]
  nextMutationAllowed: NextMutation
  paperEvidenceRequirement: PaperEvidenceRequirement
}

export interface StrategyFamilyContractValidation {
  passed: boolean
  blockingReasons: string[]
}

export function validateStrategyFamilyContract(
  contract: StrategyFamilyContract,
): StrategyFamilyContractValidation {
  const blockingReasons: string[] = []
  if (!contract.familyId.trim()) blockingReasons.push('strategy_family_contract_family_id_missing')
  if (contract.requiredFeatures.length === 0) {
    blockingReasons.push('strategy_family_contract_required_features_missing')
  }
  for (const feature of contract.requiredFeatures) {
    if (!feature.featureId.trim()) blockingReasons.push('strategy_family_contract_feature_id_missing')
    if (feature.availableTimePolicy !== 'available_time <= decision_time') {
      blockingReasons.push(`strategy_family_contract_non_pit_feature:${feature.featureId}`)
    }
    if (!feature.qualityStatusesAllowed.includes('ok')) {
      blockingReasons.push(`strategy_family_contract_feature_quality_ok_missing:${feature.featureId}`)
    }
  }
  if (!contract.decisionHorizon.trim()) blockingReasons.push('strategy_family_contract_decision_horizon_missing')
  if (!contract.labelHorizon.trim()) blockingReasons.push('strategy_family_contract_label_horizon_missing')
  if (contract.allowedUniverse.length === 0) blockingReasons.push('strategy_family_contract_universe_missing')
  if (!Number.isFinite(contract.maxTurnover) || contract.maxTurnover < 0) {
    blockingReasons.push('strategy_family_contract_max_turnover_invalid')
  }
  if (!Number.isFinite(contract.maxLeverage) || contract.maxLeverage <= 0) {
    blockingReasons.push('strategy_family_contract_max_leverage_invalid')
  }
  if (contract.role === 'diagnostic' && contract.promotionEligibility !== 'research_only') {
    blockingReasons.push('strategy_family_contract_diagnostic_promotion_ineligible_required')
  }
  if (contract.role === 'research' && contract.promotionEligibility !== 'research_only') {
    blockingReasons.push('strategy_family_contract_research_promotion_ineligible_required')
  }
  if (contract.maxLeverage > 1 && contract.promotionEligibility !== 'research_only') {
    blockingReasons.push('strategy_family_contract_leverage_above_one_not_promotion_eligible')
  }
  if (contract.failureModes.length === 0) {
    blockingReasons.push('strategy_family_contract_failure_modes_missing')
  }
  for (const code of contract.failureModes) {
    if (!isFailureCode(code)) blockingReasons.push(`strategy_family_contract_unknown_failure_code:${code}`)
  }
  if (deriveNextMutation(contract.failureModes) !== contract.nextMutationAllowed) {
    blockingReasons.push('strategy_family_contract_next_mutation_not_derived_from_failures')
  }
  if (contract.paperEvidenceRequirement.maxReportAgeSeconds <= 0) {
    blockingReasons.push('strategy_family_contract_paper_max_age_invalid')
  }
  if (
    contract.paperEvidenceRequirement.minLiveOnlyDays < 0 ||
    contract.paperEvidenceRequirement.minDecisionCount < 0 ||
    contract.paperEvidenceRequirement.minExecutedTradeCount < 0 ||
    contract.paperEvidenceRequirement.minEventCount < 0
  ) {
    blockingReasons.push('strategy_family_contract_paper_requirement_negative')
  }

  return {
    passed: blockingReasons.length === 0,
    blockingReasons,
  }
}

export const OPENALICE_STRATEGY_FAMILY_CONTRACTS: Record<string, StrategyFamilyContract> = {
  low_turnover_cross_sectional_reversal: {
    familyId: 'low_turnover_cross_sectional_reversal',
    role: 'alpha',
    requiredFeatures: [
      pitFeature('cross_sectional_return_rank'),
      pitFeature('cost_adjusted_turnover'),
      pitFeature('execution_eligible_universe'),
    ],
    decisionHorizon: '1d',
    labelHorizon: '1d',
    allowedUniverse: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'],
    maxTurnover: 0.35,
    maxLeverage: 1,
    promotionEligibility: 'paper_candidate',
    failureModes: ['FDR_INPUTS_INCOMPLETE', 'WFO_DEGRADED', 'BENCHMARK_UNDERPERFORM'],
    nextMutationAllowed: 'retry_after_new_hypothesis',
    paperEvidenceRequirement: defaultPaperEvidenceRequirement({ minDecisionCount: 30, minExecutedTradeCount: 10 }),
  },
  funding_carry_rebuild: {
    familyId: 'funding_carry_rebuild',
    role: 'research',
    requiredFeatures: [
      pitFeature('funding_rate_cashflow'),
      pitFeature('basis_spread'),
      pitFeature('borrow_fee_and_commission'),
    ],
    decisionHorizon: '8h',
    labelHorizon: '24h',
    allowedUniverse: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'],
    maxTurnover: 0.25,
    maxLeverage: 1,
    promotionEligibility: 'research_only',
    failureModes: ['ACCOUNTING_BUG', 'COST_FRAGILE', 'WFO_DEGRADED'],
    nextMutationAllowed: 'retry_after_cost_model_fix',
    paperEvidenceRequirement: defaultPaperEvidenceRequirement({ minLiveOnlyDays: 28, minDecisionCount: 21 }),
  },
  liquidation_aftermath_oi_confirmation: {
    familyId: 'liquidation_aftermath_oi_confirmation',
    role: 'alpha',
    requiredFeatures: [
      pitFeature('liquidation_event_quality'),
      pitFeature('open_interest_confirmation_lag'),
      pitFeature('post_event_liquidity'),
    ],
    decisionHorizon: '4h',
    labelHorizon: '4h',
    allowedUniverse: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'],
    maxTurnover: 0.6,
    maxLeverage: 1,
    promotionEligibility: 'paper_candidate',
    failureModes: ['PIT_VIOLATION', 'STALE_SOURCE', 'EXECUTION_INFEASIBLE'],
    nextMutationAllowed: 'retry_after_pit_fix',
    paperEvidenceRequirement: defaultPaperEvidenceRequirement({ minDecisionCount: 20, minExecutedTradeCount: 8, minEventCount: 12 }),
  },
  kronos_forecast_shadow: {
    familyId: 'kronos_forecast_shadow',
    role: 'diagnostic',
    requiredFeatures: [
      pitFeature('ohlcv_context_window'),
      pitFeature('model_provenance_hash'),
      pitFeature('linear_baseline_comparison'),
    ],
    decisionHorizon: '4h',
    labelHorizon: '4h',
    allowedUniverse: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'],
    maxTurnover: 0,
    maxLeverage: 1,
    promotionEligibility: 'research_only',
    failureModes: ['FORECAST_NO_INCREMENTAL_EDGE', 'FEATURE_AVAILABILITY_MISSING'],
    nextMutationAllowed: 'retry_after_data_fix',
    paperEvidenceRequirement: defaultPaperEvidenceRequirement({ minDecisionCount: 50, minExecutedTradeCount: 0 }),
  },
}

export function getStrategyFamilyContract(familyId: string): StrategyFamilyContract | null {
  return OPENALICE_STRATEGY_FAMILY_CONTRACTS[familyId] ?? null
}

export function assertKnownStrategyFamilyContract(familyId: string): StrategyFamilyContract {
  const contract = getStrategyFamilyContract(familyId)
  if (!contract) throw new Error(`Unknown strategy family contract: ${familyId}`)
  return contract
}

function pitFeature(featureId: string): FeatureRequirement {
  return {
    featureId,
    required: true,
    availableTimePolicy: 'available_time <= decision_time',
    qualityStatusesAllowed: ['ok'],
  }
}

function defaultPaperEvidenceRequirement(
  overrides: Partial<PaperEvidenceRequirement> = {},
): PaperEvidenceRequirement {
  return {
    minLiveOnlyDays: 14,
    minDecisionCount: 30,
    minExecutedTradeCount: 10,
    minEventCount: 0,
    maxReportAgeSeconds: 900,
    ...overrides,
  }
}
