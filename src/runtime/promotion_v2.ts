import { createHash } from 'node:crypto';

export const PROMOTION_V2_SCHEMA_VERSION = 'promotion-v2.6.0';
export const PROMOTION_V2_JSON_SCHEMA_URI = 'https://traderalice.com/schemas/openalice/promotion-v2.6.json';

export type MetricSnapshot = Record<string, number | string | boolean>;

export type JsonSchemaDefinition = Record<string, unknown>;

const metricSnapshotJsonSchema = {
  type: 'object',
  additionalProperties: {
    anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'boolean' }],
  },
} as const;

const schemaMetaJsonSchema = {
  type: 'object',
  required: ['schemaName', 'schemaVersion', 'createdBy', 'createdAt', 'codeCommit'],
  additionalProperties: false,
  properties: {
    schemaName: { type: 'string', minLength: 1 },
    schemaVersion: { type: 'string', minLength: 1 },
    createdBy: { type: 'string', minLength: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    codeCommit: { type: 'string', minLength: 1 },
  },
} as const;

const gateResultJsonSchema = {
  type: 'object',
  required: [
    'gateName',
    'status',
    'hardBlocks',
    'advisoryWarnings',
    'requiredArtifacts',
    'metricSnapshot',
    'expiresAt',
  ],
  additionalProperties: false,
  properties: {
    gateName: { enum: ['global_release', 'research', 'monetization', 'paper', 'live'] },
    status: { enum: ['pass', 'fail', 'advisory', 'skipped'] },
    hardBlocks: { type: 'array', items: { type: 'string' } },
    advisoryWarnings: { type: 'array', items: { type: 'string' } },
    requiredArtifacts: { type: 'array', items: { type: 'string' } },
    metricSnapshot: metricSnapshotJsonSchema,
    expiresAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const promotionV2JsonSchemas = {
  schemaMeta: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/schemaMeta`,
    ...schemaMetaJsonSchema,
  },
  evidenceItem: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/evidenceItem`,
    type: 'object',
    required: [
      'id',
      'experimentId',
      'claim',
      'evidenceType',
      'dataOrigin',
      'artifactPath',
      'artifactSha256',
      'inputArtifactHashes',
      'metricSnapshot',
      'validFrom',
      'invalidationRule',
      'createdAt',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string', minLength: 1 },
      experimentId: { type: 'string', minLength: 1 },
      claim: { type: 'string', minLength: 1 },
      evidenceType: { type: 'string', minLength: 1 },
      dataOrigin: { enum: ['backtest', 'paper_live_sync', 'live_capture'] },
      artifactPath: { type: 'string', minLength: 1 },
      artifactSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      inputArtifactHashes: { type: 'array', items: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      metricSnapshot: metricSnapshotJsonSchema,
      validFrom: { type: 'string', format: 'date-time' },
      validUntil: { type: 'string', format: 'date-time' },
      invalidationRule: { type: 'string', minLength: 1 },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  feeSnapshot: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/feeSnapshot`,
    type: 'object',
    required: [
      'venue',
      'symbol',
      'instrumentType',
      'accountTier',
      'makerFeeBps',
      'takerFeeBps',
      'source',
      'sourceFetchedAt',
      'expiresAt',
      'verifiedByRuntime',
    ],
    additionalProperties: false,
    properties: {
      venue: { type: 'string', minLength: 1 },
      symbol: { type: 'string', minLength: 1 },
      instrumentType: { type: 'string', minLength: 1 },
      accountTier: { type: 'string', minLength: 1 },
      makerFeeBps: { type: 'number', minimum: 0 },
      takerFeeBps: { type: 'number', minimum: 0 },
      source: { enum: ['api', 'account_page', 'official_page', 'manual_override'] },
      sourceFetchedAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: 'string', format: 'date-time' },
      manualOverrideReason: { type: 'string' },
      verifiedByRuntime: { type: 'boolean' },
      fundingIntervalHours: { type: 'number', exclusiveMinimum: 0 },
      fundingCapBps: { type: 'number' },
      fundingFloorBps: { type: 'number' },
      nextFundingAt: { type: 'string', format: 'date-time' },
    },
  },
  routeBudget: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/routeBudget`,
    type: 'object',
    required: [
      'route',
      'feeBps',
      'spreadBps',
      'slippageBps',
      'adverseSelectionBufferBps',
      'queueMissBufferBps',
      'fundingBps',
      'totalExpectedCostBps',
      'maxAllowedCostBps',
      'breakEvenEdgeBps',
    ],
    additionalProperties: false,
    properties: {
      route: { enum: ['passive_passive', 'passive_taker', 'taker_taker', 'twap'] },
      feeBps: { type: 'number', minimum: 0 },
      spreadBps: { type: 'number', minimum: 0 },
      slippageBps: { type: 'number', minimum: 0 },
      adverseSelectionBufferBps: { type: 'number', minimum: 0 },
      queueMissBufferBps: { type: 'number', minimum: 0 },
      fundingBps: { type: 'number' },
      totalExpectedCostBps: { type: 'number', minimum: 0 },
      maxAllowedCostBps: { type: 'number', minimum: 0 },
      breakEvenEdgeBps: { type: 'number', minimum: 0 },
    },
  },
  monetizationMetrics: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/monetizationMetrics`,
    type: 'object',
    required: [
      'netExpectancyBpsPerTrade',
      'netExpectancyUsdPerTrade',
      'netExpectancyUsdPerDay',
      'netExpectancyUsdPerMonth',
      'validSignalsPerMonth',
      'executableCapacityUsd',
      'turnoverPerDay',
      'routeAdjustedBreakEvenBps',
      'benchmarkExcessReturnBps',
    ],
    additionalProperties: false,
    properties: {
      netExpectancyBpsPerTrade: { type: 'number' },
      netExpectancyUsdPerTrade: { type: 'number' },
      netExpectancyUsdPerDay: { type: 'number' },
      netExpectancyUsdPerMonth: { type: 'number' },
      validSignalsPerMonth: { type: 'number', minimum: 0 },
      executableCapacityUsd: { type: 'number', minimum: 0 },
      turnoverPerDay: { type: 'number', minimum: 0 },
      routeAdjustedBreakEvenBps: { type: 'number', minimum: 0 },
      benchmarkExcessReturnBps: { type: 'number' },
    },
  },
  capitalGate: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/capitalGate`,
    type: 'object',
    required: [
      'accountEquityUsd',
      'maxCapitalAllocatedUsd',
      'minOrderNotionalUsd',
      'minUsefulDailyNetProfitUsd',
      'minUsefulMonthlyNetProfitUsd',
      'infraCostUsd',
      'riskBufferUsd',
      'expectedDailyNetProfitUsd',
      'expectedMonthlyNetProfitUsd',
      'capacityAtCurrentCostUsd',
      'capitalEfficiency',
      'status',
      'hardBlocks',
    ],
    additionalProperties: false,
    properties: {
      accountEquityUsd: { type: 'number', minimum: 0 },
      maxCapitalAllocatedUsd: { type: 'number', minimum: 0 },
      minOrderNotionalUsd: { type: 'number', minimum: 0 },
      minUsefulDailyNetProfitUsd: { type: 'number', minimum: 0 },
      minUsefulMonthlyNetProfitUsd: { type: 'number', minimum: 0 },
      infraCostUsd: { type: 'number', minimum: 0 },
      riskBufferUsd: { type: 'number', minimum: 0 },
      expectedDailyNetProfitUsd: { type: 'number' },
      expectedMonthlyNetProfitUsd: { type: 'number' },
      capacityAtCurrentCostUsd: { type: 'number', minimum: 0 },
      capitalEfficiency: { type: 'number' },
      status: { enum: ['pass', 'fail'] },
      hardBlocks: { type: 'array', items: { type: 'string' } },
    },
  },
  benchmarkComparison: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/benchmarkComparison`,
    type: 'object',
    required: [
      'benchmarkName',
      'sameWindow',
      'sameCostModel',
      'sameExecutionEligibility',
      'sameDataOriginPolicy',
      'strategyNetReturnBps',
      'benchmarkNetReturnBps',
      'excessReturnBps',
      'excessMaxDrawdownAdjusted',
      'pass',
    ],
    additionalProperties: false,
    properties: {
      benchmarkName: {
        enum: ['no_trade', 'equal_weight_universe', 'btc_eth_50_50', 'low_turnover_momentum'],
      },
      sameWindow: { type: 'boolean' },
      sameCostModel: { type: 'boolean' },
      sameExecutionEligibility: { type: 'boolean' },
      sameDataOriginPolicy: { type: 'boolean' },
      strategyNetReturnBps: { type: 'number' },
      benchmarkNetReturnBps: { type: 'number' },
      excessReturnBps: { type: 'number' },
      excessMaxDrawdownAdjusted: { type: 'number' },
      pass: { type: 'boolean' },
    },
  },
  universeAttribution: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/universeAttribution`,
    type: 'object',
    required: [
      'researchUniverseSize',
      'executionUniverseSize',
      'pnlFromExecutionEligiblePct',
      'signalsFromExecutionEligiblePct',
      'topContributors',
    ],
    additionalProperties: false,
    properties: {
      researchUniverseSize: { type: 'integer', minimum: 0 },
      executionUniverseSize: { type: 'integer', minimum: 0 },
      pnlFromExecutionEligiblePct: { type: 'number', minimum: 0, maximum: 100 },
      signalsFromExecutionEligiblePct: { type: 'number', minimum: 0, maximum: 100 },
      topContributors: {
        type: 'array',
        items: {
          type: 'object',
          required: ['symbol', 'universeRole', 'pnlContributionPct', 'tradeCount'],
          additionalProperties: false,
          properties: {
            symbol: { type: 'string', minLength: 1 },
            universeRole: { enum: ['research_only', 'execution_eligible'] },
            pnlContributionPct: { type: 'number' },
            tradeCount: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
  },
  rebalanceDecision: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/rebalanceDecision`,
    type: 'object',
    required: [
      'symbol',
      'currentWeight',
      'targetWeight',
      'proposedDeltaWeight',
      'incrementalExpectedEdgeBps',
      'routeRebalanceCostBps',
      'safetyMarginBps',
      'rebalanceNetBenefitBps',
      'action',
    ],
    additionalProperties: false,
    properties: {
      symbol: { type: 'string', minLength: 1 },
      currentWeight: { type: 'number' },
      targetWeight: { type: 'number' },
      proposedDeltaWeight: { type: 'number' },
      incrementalExpectedEdgeBps: { type: 'number' },
      routeRebalanceCostBps: { type: 'number', minimum: 0 },
      safetyMarginBps: { type: 'number', minimum: 0 },
      rebalanceNetBenefitBps: { type: 'number' },
      action: { enum: ['hold', 'partial_rebalance', 'full_rebalance', 'block'] },
    },
  },
  missedFillOpportunityCost: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/missedFillOpportunityCost`,
    type: 'object',
    required: [
      'orderId',
      'missedFillReason',
      'postDecisionMoveBps',
      'wouldHaveProfitedBps',
      'opportunityCostBps',
      'evaluationWindowMinutes',
    ],
    additionalProperties: false,
    properties: {
      orderId: { type: 'string', minLength: 1 },
      missedFillReason: { type: 'string', minLength: 1 },
      postDecisionMoveBps: { type: 'number' },
      wouldHaveProfitedBps: { type: 'number' },
      opportunityCostBps: { type: 'number', minimum: 0 },
      evaluationWindowMinutes: { type: 'number', exclusiveMinimum: 0 },
    },
  },
  executionCounterfactual: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/executionCounterfactual`,
    type: 'object',
    required: [
      'orderId',
      'chosenPlanCostBps',
      'takerNowCostBps',
      'makerPassiveCostBps',
      'twapCostBps',
      'bestAlternative',
      'chosenVsBestDeltaBps',
      'evaluationWindowMinutes',
    ],
    additionalProperties: false,
    properties: {
      orderId: { type: 'string', minLength: 1 },
      chosenPlanCostBps: { type: 'number', minimum: 0 },
      takerNowCostBps: { type: 'number', minimum: 0 },
      makerPassiveCostBps: { type: 'number', minimum: 0 },
      twapCostBps: { type: 'number', minimum: 0 },
      bestAlternative: { enum: ['taker_now', 'maker_passive', 'twap'] },
      chosenVsBestDeltaBps: { type: 'number' },
      evaluationWindowMinutes: { type: 'number', exclusiveMinimum: 0 },
    },
  },
  failureAttribution: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/failureAttribution`,
    type: 'object',
    required: ['candidateId', 'primaryFailure', 'secondaryFailures', 'suggestedNextMutation', 'reusableEvidenceIds'],
    additionalProperties: false,
    properties: {
      candidateId: { type: 'string', minLength: 1 },
      primaryFailure: {
        enum: [
          'no_signal',
          'cost_too_high',
          'turnover_too_high',
          'recent_oos_fail',
          'route_unexecutable',
          'benchmark_underperform',
          'execution_drift',
          'data_quality_fail',
          'overfit',
        ],
      },
      secondaryFailures: { type: 'array', items: { type: 'string' } },
      suggestedNextMutation: {
        enum: [
          'increase_horizon',
          'reduce_turnover',
          'change_universe',
          'tighten_route_filter',
          'drop_factor',
          'freeze_line',
        ],
      },
      reusableEvidenceIds: { type: 'array', items: { type: 'string' } },
    },
  },
  gateResult: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/gateResult`,
    ...gateResultJsonSchema,
  },
  promotionReadinessV2: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROMOTION_V2_JSON_SCHEMA_URI}#/promotionReadinessV2`,
    type: 'object',
    required: [
      'schemaMeta',
      'strategyId',
      'experimentId',
      'generatedAt',
      'globalReleaseGate',
      'researchGate',
      'monetizationGate',
      'paperGate',
      'liveGate',
      'monetization',
      'execution',
      'dataFreshness',
      'evidence',
      'finalVerdict',
      'humanReadableReason',
    ],
    additionalProperties: false,
    properties: {
      schemaMeta: schemaMetaJsonSchema,
      strategyId: { type: 'string', minLength: 1 },
      experimentId: { type: 'string', minLength: 1 },
      generatedAt: { type: 'string', format: 'date-time' },
      globalReleaseGate: gateResultJsonSchema,
      researchGate: gateResultJsonSchema,
      monetizationGate: gateResultJsonSchema,
      paperGate: gateResultJsonSchema,
      liveGate: gateResultJsonSchema,
      monetization: { $ref: `${PROMOTION_V2_JSON_SCHEMA_URI}#/monetizationMetrics` },
      execution: {
        type: 'object',
        required: [
          'recentOrderCount',
          'slippageViolationCount',
          'actualToSimulatedCostRatio',
          'missedFillRate',
          'decayCircuitBreakerTriggered',
        ],
        additionalProperties: false,
        properties: {
          recentOrderCount: { type: 'integer', minimum: 0 },
          slippageViolationCount: { type: 'integer', minimum: 0 },
          actualToSimulatedCostRatio: { type: 'number', minimum: 0 },
          missedFillRate: { type: 'number', minimum: 0, maximum: 1 },
          decayCircuitBreakerTriggered: { type: 'boolean' },
        },
      },
      dataFreshness: {
        type: 'object',
        required: ['latestDecisionStatus', 'staleBlockCount', 'maxDataLatencyMinutes'],
        additionalProperties: false,
        properties: {
          latestDecisionStatus: { type: 'string' },
          staleBlockCount: { type: 'integer', minimum: 0 },
          maxDataLatencyMinutes: { type: 'number', minimum: 0 },
        },
      },
      evidence: {
        type: 'object',
        required: ['supportingEvidenceIds', 'blockingEvidenceIds', 'missingRequiredEvidence'],
        additionalProperties: false,
        properties: {
          supportingEvidenceIds: { type: 'array', items: { type: 'string' } },
          blockingEvidenceIds: { type: 'array', items: { type: 'string' } },
          missingRequiredEvidence: { type: 'array', items: { type: 'string' } },
        },
      },
      finalVerdict: {
        enum: [
          'research_only',
          'paper_blocked',
          'paper_allowed',
          'tiny_cap_candidate',
          'live_blocked',
          'quarantined',
        ],
      },
      humanReadableReason: { type: 'string' },
    },
  },
} as const satisfies Record<string, JsonSchemaDefinition>;

export interface SchemaMeta {
  schemaName: string;
  schemaVersion: string;
  createdBy: string;
  createdAt: string;
  codeCommit: string;
}

export type DataOrigin = 'backtest' | 'paper_live_sync' | 'live_capture';

export interface EvidenceItem {
  id: string;
  experimentId: string;
  claim: string;
  evidenceType: string;
  dataOrigin: DataOrigin;
  artifactPath: string;
  artifactSha256: string;
  inputArtifactHashes: string[];
  metricSnapshot: MetricSnapshot;
  validFrom: string;
  validUntil?: string;
  invalidationRule: string;
  createdAt: string;
}

export type GateName = 'global_release' | 'research' | 'monetization' | 'paper' | 'live';
export type GateStatus = 'pass' | 'fail' | 'advisory' | 'skipped';

export interface GateResult {
  gateName: GateName;
  status: GateStatus;
  hardBlocks: string[];
  advisoryWarnings: string[];
  requiredArtifacts: string[];
  metricSnapshot: MetricSnapshot;
  expiresAt: string;
}

export type PromotionMode = 'research' | 'paper' | 'live';

export type FeeSnapshotSource = 'api' | 'account_page' | 'official_page' | 'manual_override';

export interface FeeSnapshot {
  venue: string;
  symbol: string;
  instrumentType: string;
  accountTier: string;
  makerFeeBps: number;
  takerFeeBps: number;
  source: FeeSnapshotSource;
  sourceFetchedAt: string;
  expiresAt: string;
  manualOverrideReason?: string;
  verifiedByRuntime: boolean;
  fundingIntervalHours?: number;
  fundingCapBps?: number;
  fundingFloorBps?: number;
  nextFundingAt?: string;
}

export type RouteName = 'passive_passive' | 'passive_taker' | 'taker_taker' | 'twap';

export interface RouteBudget {
  route: RouteName;
  feeBps: number;
  spreadBps: number;
  slippageBps: number;
  adverseSelectionBufferBps: number;
  queueMissBufferBps: number;
  fundingBps: number;
  totalExpectedCostBps: number;
  maxAllowedCostBps: number;
  breakEvenEdgeBps: number;
}

export interface RouteCostBudget {
  schemaMeta: SchemaMeta;
  generatedAt: string;
  feeSnapshot: FeeSnapshot;
  routes: Record<RouteName, RouteBudget>;
}

export interface MonetizationMetrics {
  netExpectancyBpsPerTrade: number;
  netExpectancyUsdPerTrade: number;
  netExpectancyUsdPerDay: number;
  netExpectancyUsdPerMonth: number;
  validSignalsPerMonth: number;
  executableCapacityUsd: number;
  turnoverPerDay: number;
  routeAdjustedBreakEvenBps: number;
  benchmarkExcessReturnBps: number;
}

export interface CapitalGate {
  accountEquityUsd: number;
  maxCapitalAllocatedUsd: number;
  minOrderNotionalUsd: number;
  minUsefulDailyNetProfitUsd: number;
  minUsefulMonthlyNetProfitUsd: number;
  infraCostUsd: number;
  riskBufferUsd: number;
  expectedDailyNetProfitUsd: number;
  expectedMonthlyNetProfitUsd: number;
  capacityAtCurrentCostUsd: number;
  capitalEfficiency: number;
  status: 'pass' | 'fail';
  hardBlocks: string[];
}

export type BenchmarkName =
  | 'no_trade'
  | 'equal_weight_universe'
  | 'btc_eth_50_50'
  | 'low_turnover_momentum';

export interface BenchmarkComparison {
  benchmarkName: BenchmarkName;
  sameWindow: boolean;
  sameCostModel: boolean;
  sameExecutionEligibility: boolean;
  sameDataOriginPolicy: boolean;
  strategyNetReturnBps: number;
  benchmarkNetReturnBps: number;
  excessReturnBps: number;
  excessMaxDrawdownAdjusted: number;
  pass: boolean;
}

export interface UniverseContributor {
  symbol: string;
  universeRole: 'research_only' | 'execution_eligible';
  pnlContributionPct: number;
  tradeCount: number;
}

export interface UniverseAttribution {
  researchUniverseSize: number;
  executionUniverseSize: number;
  pnlFromExecutionEligiblePct: number;
  signalsFromExecutionEligiblePct: number;
  topContributors: UniverseContributor[];
}

export type RebalanceAction = 'hold' | 'partial_rebalance' | 'full_rebalance' | 'block';

export interface RebalanceDecision {
  symbol: string;
  currentWeight: number;
  targetWeight: number;
  proposedDeltaWeight: number;
  incrementalExpectedEdgeBps: number;
  routeRebalanceCostBps: number;
  safetyMarginBps: number;
  rebalanceNetBenefitBps: number;
  action: RebalanceAction;
}

export interface MissedFillOpportunityCost {
  orderId: string;
  missedFillReason: string;
  postDecisionMoveBps: number;
  wouldHaveProfitedBps: number;
  opportunityCostBps: number;
  evaluationWindowMinutes: number;
}

export interface ExecutionCounterfactual {
  orderId: string;
  chosenPlanCostBps: number;
  takerNowCostBps: number;
  makerPassiveCostBps: number;
  twapCostBps: number;
  bestAlternative: 'taker_now' | 'maker_passive' | 'twap';
  chosenVsBestDeltaBps: number;
  evaluationWindowMinutes: number;
}

export interface ExecutionCounterfactualEvaluation {
  pass: boolean;
  bestAlternative: ExecutionCounterfactual['bestAlternative'];
  bestAlternativeCostBps: number;
  chosenVsBestDeltaBps: number;
  hardBlocks: string[];
}

export interface AdverseSelectionSignal {
  side: 'buy' | 'sell';
  route: RouteName;
  orderFlowImbalance: number;
  toxicityScore: number;
  maxToxicityScore: number;
  adverseOfiThreshold: number;
  volatilitySpike?: boolean;
  spreadWidening?: boolean;
}

export interface AdverseSelectionEvaluation {
  pass: boolean;
  hardBlocks: string[];
}

export interface ExecutionSlippageObservation {
  orderId: string;
  expectedSlippageBps: number;
  realizedSlippageBps: number;
}

export interface ExecutionDecayBreakerEvaluation {
  status: 'pass' | 'fail';
  averageExcessSlippageBps: number;
  observationCount: number;
  hardBlocks: string[];
}

export type FailureAttributionPrimaryFailure =
  | 'no_signal'
  | 'cost_too_high'
  | 'turnover_too_high'
  | 'recent_oos_fail'
  | 'route_unexecutable'
  | 'benchmark_underperform'
  | 'execution_drift'
  | 'data_quality_fail'
  | 'overfit';

export type FailureAttributionNextMutation =
  | 'increase_horizon'
  | 'reduce_turnover'
  | 'change_universe'
  | 'tighten_route_filter'
  | 'drop_factor'
  | 'freeze_line';

export interface FailureAttribution {
  candidateId: string;
  primaryFailure: FailureAttributionPrimaryFailure;
  secondaryFailures: string[];
  suggestedNextMutation: FailureAttributionNextMutation;
  reusableEvidenceIds: string[];
}

export interface CandidateRegistryEntry {
  candidateId: string;
  experimentId: string;
  strategyId: string;
  generatedAt: string;
  scriptName: string;
  parameterHash: string;
  status: 'active' | 'promoted' | 'rejected' | 'graveyard';
}

export interface CandidateRegistry {
  schemaMeta: SchemaMeta;
  registryId: string;
  candidateCount: number;
  entries: CandidateRegistryEntry[];
  graveyardCandidateCount: number;
  registrySha256?: string;
}

export interface StatisticalTestPolicy {
  policyVersion: string;
  candidateUniverseId: string;
  candidateCount: number;
  includesGraveyard: boolean;
  pboMethod: string;
  dsrMethod: string;
  fdrMethod: 'BH' | 'BY' | 'Storey' | 'custom';
  alpha: number;
  minTradeCount: number;
  minOosWindows: number;
}

export interface RuntimePathAudit {
  mode: 'paper' | 'tiny_cap' | 'live';
  signalCodePathHash: string;
  gateCodePathHash: string;
  executionCodePathHash: string;
  configHash: string;
  differsFromPaper: boolean;
  differences: string[];
}

export interface QuarantineRecord {
  strategyId: string;
  enteredAt: string;
  triggerReason: string;
  frozenExperimentId: string;
  allowedActions: ('diagnostic' | 'research_backtest')[];
  exitRequiredArtifacts: string[];
  exitStatus: 'blocked' | 'under_review' | 'released_to_research_only';
}

export type PromotionFinalVerdict =
  | 'research_only'
  | 'paper_blocked'
  | 'paper_allowed'
  | 'tiny_cap_candidate'
  | 'live_blocked'
  | 'quarantined';

export interface PromotionReadinessV2 {
  schemaMeta: SchemaMeta;
  strategyId: string;
  experimentId: string;
  generatedAt: string;
  globalReleaseGate: GateResult;
  researchGate: GateResult;
  monetizationGate: GateResult;
  paperGate: GateResult;
  liveGate: GateResult;
  monetization: MonetizationMetrics;
  execution: {
    recentOrderCount: number;
    slippageViolationCount: number;
    actualToSimulatedCostRatio: number;
    missedFillRate: number;
    decayCircuitBreakerTriggered: boolean;
  };
  dataFreshness: {
    latestDecisionStatus: string;
    staleBlockCount: number;
    maxDataLatencyMinutes: number;
  };
  evidence: {
    supportingEvidenceIds: string[];
    blockingEvidenceIds: string[];
    missingRequiredEvidence: string[];
  };
  finalVerdict: PromotionFinalVerdict;
  humanReadableReason: string;
}

export interface EvidenceHashValidation {
  valid: boolean;
  invalidEvidenceIds: string[];
  reasons: string[];
}

export interface EvidenceHashValidationOptions {
  requireArtifacts?: boolean;
}

export interface FeeSnapshotValidation {
  valid: boolean;
  hardBlocks: string[];
}

export interface BenchmarkGateEvaluation {
  status: 'pass' | 'fail';
  hardBlocks: string[];
  simpleBenchmarkPassCount: number;
}

export interface UniverseAttributionGateEvaluation {
  status: 'pass' | 'fail';
  hardBlocks: string[];
}

export interface CandidateRegistryEvaluation {
  status: 'pass' | 'fail';
  hardBlocks: string[];
}

export interface FreshnessDecision {
  status: 'fresh' | 'stale_bar_hard_block';
  latencyMinutes: number;
  hardBlocks: string[];
}

export type MakerFillEvidenceType = 'trade_through' | 'queue_volume' | 'missed_touch' | 'unfilled';

export interface MakerTradePrint {
  price: number;
  quantity: number;
}

export interface ConservativeMakerFillInput {
  side: 'buy' | 'sell';
  limitPrice: number;
  orderQuantity: number;
  queueMultiplier: number;
  candleHigh?: number;
  candleLow?: number;
  samePriceVolume?: number;
  tradePrints?: MakerTradePrint[];
}

export interface ConservativeMakerFillResult {
  filled: boolean;
  fillEvidenceType: MakerFillEvidenceType;
  requiredQueueVolume: number;
  observedSamePriceVolume: number;
  hardBlocks: string[];
}

export interface MissedFillOpportunityEvaluation {
  pass: boolean;
  netMakerBenefitBps: number;
  hardBlocks: string[];
}

export interface EvaluateMonetizationGateInput {
  mode: PromotionMode;
  now?: Date;
  metrics: MonetizationMetrics;
  grossToCostRatio?: number;
  minGrossToCostRatio?: number;
  feeSnapshot: FeeSnapshot;
  routeCostBudget: RouteCostBudget;
  selectedRoute: RouteName;
  benchmarkComparisons: BenchmarkComparison[];
  capitalGate: CapitalGate;
  universeAttribution: UniverseAttribution;
  evidence?: EvidenceItem[];
  supportingEvidenceIds?: string[];
  minValidSignalsPerMonth?: number;
  minExpectedNetDollarsPerMonth?: number;
  minExecutableCapacityUsd?: number;
}

export interface BuildPromotionReadinessInput {
  schemaMeta: SchemaMeta;
  strategyId: string;
  experimentId: string;
  generatedAt: string;
  globalReleaseGate: GateResult;
  researchGate: GateResult;
  monetizationGate: GateResult;
  paperGate: GateResult;
  liveGate: GateResult;
  monetization: MonetizationMetrics;
  execution: PromotionReadinessV2['execution'];
  dataFreshness: PromotionReadinessV2['dataFreshness'];
  evidence: PromotionReadinessV2['evidence'];
  quarantine?: QuarantineRecord;
  now?: Date;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalizeJson(value));
}

export function validateSchemaMeta(meta: SchemaMeta): string[] {
  const hardBlocks: string[] = [];

  if (!meta.schemaName.trim()) hardBlocks.push('schema_name_missing');
  if (!meta.schemaVersion.trim()) hardBlocks.push('schema_version_missing');
  if (!meta.createdBy.trim()) hardBlocks.push('schema_created_by_missing');
  if (!meta.createdAt.trim()) hardBlocks.push('schema_created_at_missing');
  if (!meta.codeCommit.trim()) hardBlocks.push('schema_code_commit_missing');

  return hardBlocks;
}

export function validateEvidenceHashes(
  evidence: EvidenceItem[],
  artifactsByPath: Readonly<Record<string, string | Buffer>> = {},
  options: EvidenceHashValidationOptions = {},
): EvidenceHashValidation {
  const requireArtifacts = options.requireArtifacts ?? true;
  const invalidEvidenceIds: string[] = [];
  const reasons: string[] = [];

  for (const item of evidence) {
    if (!item.artifactSha256.trim()) {
      invalidEvidenceIds.push(item.id);
      reasons.push(`artifact_hash_missing:${item.id}`);
      continue;
    }

    const artifact = artifactsByPath[item.artifactPath];
    if (artifact === undefined) {
      if (requireArtifacts) {
        invalidEvidenceIds.push(item.id);
        reasons.push(`artifact_missing:${item.id}`);
      }
      continue;
    }

    const actualHash = sha256Hex(artifact);
    if (actualHash !== item.artifactSha256) {
      invalidEvidenceIds.push(item.id);
      reasons.push(`artifact_hash_mismatch:${item.id}`);
    }
  }

  return {
    valid: invalidEvidenceIds.length === 0,
    invalidEvidenceIds,
    reasons,
  };
}

export function findBacktestEvidenceForPromotion(
  evidence: EvidenceItem[],
  supportingEvidenceIds: readonly string[],
): EvidenceItem[] {
  const supportingIds = new Set(supportingEvidenceIds);
  return evidence.filter((item) => supportingIds.has(item.id) && item.dataOrigin === 'backtest');
}

export function evaluatePaperEvidenceDataOrigins(
  evidence: EvidenceItem[],
  supportingEvidenceIds: readonly string[],
): string[] {
  return findBacktestEvidenceForPromotion(evidence, supportingEvidenceIds).map(
    (item) => `backtest_data_origin_not_allowed:${item.id}`,
  );
}

export function evaluateFeeSnapshot(
  snapshot: FeeSnapshot,
  mode: PromotionMode,
  now: Date = new Date(),
): FeeSnapshotValidation {
  const hardBlocks: string[] = [];
  const expiresAtMs = Date.parse(snapshot.expiresAt);

  if (!Number.isFinite(snapshot.makerFeeBps) || snapshot.makerFeeBps < 0) {
    hardBlocks.push('maker_fee_bps_invalid');
  }
  if (!Number.isFinite(snapshot.takerFeeBps) || snapshot.takerFeeBps < 0) {
    hardBlocks.push('taker_fee_bps_invalid');
  }
  if (!Number.isFinite(expiresAtMs)) {
    hardBlocks.push('fee_snapshot_expires_at_invalid');
  } else if (expiresAtMs <= now.getTime()) {
    hardBlocks.push('fee_snapshot_expired');
  }
  if (snapshot.source === 'manual_override' && mode !== 'research') {
    hardBlocks.push('manual_fee_override_not_allowed_for_paper_or_live');
  }
  if (!snapshot.verifiedByRuntime && mode !== 'research') {
    hardBlocks.push('fee_snapshot_not_runtime_verified');
  }

  return { valid: hardBlocks.length === 0, hardBlocks };
}

export function evaluateBenchmarkGate(comparisons: BenchmarkComparison[]): BenchmarkGateEvaluation {
  const hardBlocks: string[] = [];
  const requiredBenchmarks: BenchmarkName[] = [
    'no_trade',
    'equal_weight_universe',
    'btc_eth_50_50',
    'low_turnover_momentum',
  ];
  const noTrade = comparisons.find((comparison) => comparison.benchmarkName === 'no_trade');
  const simpleBenchmarks = comparisons.filter(
    (comparison) => comparison.benchmarkName !== 'no_trade',
  );
  const countsByName = new Map<BenchmarkName, number>();

  for (const benchmarkName of requiredBenchmarks) {
    countsByName.set(benchmarkName, 0);
  }

  for (const comparison of comparisons) {
    countsByName.set(comparison.benchmarkName, (countsByName.get(comparison.benchmarkName) ?? 0) + 1);
    if (!comparison.sameWindow) hardBlocks.push(`benchmark_window_mismatch:${comparison.benchmarkName}`);
    if (!comparison.sameCostModel) {
      hardBlocks.push(`benchmark_cost_model_mismatch:${comparison.benchmarkName}`);
    }
    if (!comparison.sameExecutionEligibility) {
      hardBlocks.push(`benchmark_execution_eligibility_mismatch:${comparison.benchmarkName}`);
    }
    if (!comparison.sameDataOriginPolicy) {
      hardBlocks.push(`benchmark_data_origin_policy_mismatch:${comparison.benchmarkName}`);
    }

    const computedPass = computeBenchmarkPass(comparison);
    if (comparison.pass !== computedPass) {
      hardBlocks.push(`benchmark_pass_flag_inconsistent:${comparison.benchmarkName}`);
    }
  }

  for (const [benchmarkName, count] of countsByName.entries()) {
    if (count === 0) {
      hardBlocks.push(`benchmark_missing:${benchmarkName}`);
    } else if (count > 1) {
      hardBlocks.push(`benchmark_duplicate:${benchmarkName}`);
    }
  }

  if (!noTrade || !computeBenchmarkPass(noTrade)) {
    hardBlocks.push('no_trade_benchmark_failed');
  }

  const simpleBenchmarkPassCount = simpleBenchmarks.filter(computeBenchmarkPass).length;
  if (simpleBenchmarkPassCount < 2) {
    hardBlocks.push('simple_benchmark_pass_count_below_2');
  }

  return {
    status: hardBlocks.length === 0 ? 'pass' : 'fail',
    hardBlocks,
    simpleBenchmarkPassCount,
  };
}

export function evaluateCapitalGate(
  input: Omit<CapitalGate, 'capitalEfficiency' | 'status' | 'hardBlocks'>,
): CapitalGate {
  const hardBlocks: string[] = [];

  if (input.maxCapitalAllocatedUsd < input.minOrderNotionalUsd) {
    hardBlocks.push('capital_allocated_below_min_order_notional');
  }
  if (input.expectedDailyNetProfitUsd < input.minUsefulDailyNetProfitUsd) {
    hardBlocks.push('daily_net_profit_below_minimum_useful_threshold');
  }
  if (input.expectedMonthlyNetProfitUsd < input.minUsefulMonthlyNetProfitUsd) {
    hardBlocks.push('monthly_net_profit_below_minimum_useful_threshold');
  }
  if (input.expectedMonthlyNetProfitUsd < input.infraCostUsd + input.riskBufferUsd) {
    hardBlocks.push('monthly_net_profit_below_infra_cost_plus_risk_buffer');
  }
  if (input.capacityAtCurrentCostUsd < input.minOrderNotionalUsd) {
    hardBlocks.push('capacity_below_min_order_notional');
  }

  const capitalEfficiency =
    input.maxCapitalAllocatedUsd > 0 ? input.expectedMonthlyNetProfitUsd / input.maxCapitalAllocatedUsd : 0;

  return {
    ...input,
    capitalEfficiency,
    status: hardBlocks.length === 0 ? 'pass' : 'fail',
    hardBlocks,
  };
}

export function evaluateUniverseAttributionGate(
  attribution: UniverseAttribution,
  minPnlFromExecutionEligiblePct = 80,
): UniverseAttributionGateEvaluation {
  const hardBlocks: string[] = [];

  if (attribution.pnlFromExecutionEligiblePct < minPnlFromExecutionEligiblePct) {
    hardBlocks.push('execution_eligible_pnl_below_80_pct');
  }
  if (attribution.executionUniverseSize <= 0) {
    hardBlocks.push('execution_universe_empty');
  }
  if (attribution.researchUniverseSize < attribution.executionUniverseSize) {
    hardBlocks.push('research_universe_smaller_than_execution_universe');
  }

  return {
    status: hardBlocks.length === 0 ? 'pass' : 'fail',
    hardBlocks,
  };
}

export function evaluateCandidateRegistryPolicy(
  registry: CandidateRegistry,
  policy: StatisticalTestPolicy,
): CandidateRegistryEvaluation {
  const hardBlocks: string[] = [];
  const actualCandidateCount = registry.entries.length;
  const graveyardCount = registry.entries.filter((entry) => entry.status === 'graveyard').length;

  if (registry.candidateCount !== actualCandidateCount) {
    hardBlocks.push('candidate_registry_count_mismatch');
  }
  if (policy.candidateCount !== actualCandidateCount) {
    hardBlocks.push('statistical_policy_candidate_count_mismatch');
  }
  if (!policy.includesGraveyard) {
    hardBlocks.push('statistical_policy_excludes_graveyard');
  }
  if (registry.graveyardCandidateCount !== graveyardCount) {
    hardBlocks.push('graveyard_count_mismatch');
  }

  return {
    status: hardBlocks.length === 0 ? 'pass' : 'fail',
    hardBlocks,
  };
}

export function computeRebalanceDecision(
  input: Omit<RebalanceDecision, 'rebalanceNetBenefitBps' | 'action'>,
): RebalanceDecision {
  const rebalanceNetBenefitBps =
    input.incrementalExpectedEdgeBps - input.routeRebalanceCostBps - input.safetyMarginBps;
  const desiredDeltaWeight = input.targetWeight - input.currentWeight;
  const directionallyValid =
    input.proposedDeltaWeight === 0 ||
    desiredDeltaWeight !== 0 &&
      Math.sign(input.proposedDeltaWeight) === Math.sign(desiredDeltaWeight);
  const clampedDeltaWeight = directionallyValid && desiredDeltaWeight !== 0
    ? Math.sign(desiredDeltaWeight) *
      Math.min(Math.abs(input.proposedDeltaWeight), Math.abs(desiredDeltaWeight))
    : input.proposedDeltaWeight;

  let action: RebalanceAction;
  if (!Number.isFinite(rebalanceNetBenefitBps) || !Number.isFinite(input.proposedDeltaWeight)) {
    action = 'block';
  } else if (!directionallyValid) {
    action = 'block';
  } else if (Math.abs(clampedDeltaWeight) <= 0 || rebalanceNetBenefitBps <= 0) {
    action = 'hold';
  } else if (Math.abs(clampedDeltaWeight) >= Math.abs(desiredDeltaWeight)) {
    action = 'full_rebalance';
  } else {
    action = 'partial_rebalance';
  }

  return {
    ...input,
    proposedDeltaWeight: clampedDeltaWeight,
    rebalanceNetBenefitBps,
    action,
  };
}

export function resolveQueueEvidenceMultiplier(input: {
  volatilitySpike?: boolean;
  spreadWidening?: boolean;
  severeVolatilitySpike?: boolean;
  severeSpreadWidening?: boolean;
}): number {
  if (input.severeVolatilitySpike && input.severeSpreadWidening) return 20;
  if (
    input.volatilitySpike ||
    input.spreadWidening ||
    input.severeVolatilitySpike ||
    input.severeSpreadWidening
  ) {
    return 10;
  }
  return 5;
}

export function evaluateConservativeMakerFill(input: ConservativeMakerFillInput): ConservativeMakerFillResult {
  const tradePrints = input.tradePrints ?? [];
  const strictTradeThrough = hasStrictTradeThrough(input, tradePrints);
  const samePriceTradeVolume = tradePrints
    .filter((print) => print.price === input.limitPrice)
    .reduce((sum, print) => sum + print.quantity, 0);
  const observedSamePriceVolume = Math.max(input.samePriceVolume ?? 0, samePriceTradeVolume);
  const requiredQueueVolume = input.queueMultiplier * input.orderQuantity;
  const touched = hasSamePriceTouch(input, tradePrints);

  if (strictTradeThrough) {
    return {
      filled: true,
      fillEvidenceType: 'trade_through',
      requiredQueueVolume,
      observedSamePriceVolume,
      hardBlocks: [],
    };
  }

  if (observedSamePriceVolume >= requiredQueueVolume) {
    return {
      filled: true,
      fillEvidenceType: 'queue_volume',
      requiredQueueVolume,
      observedSamePriceVolume,
      hardBlocks: [],
    };
  }

  return {
    filled: false,
    fillEvidenceType: touched ? 'missed_touch' : 'unfilled',
    requiredQueueVolume,
    observedSamePriceVolume,
    hardBlocks: touched ? ['same_price_touch_without_trade_through_or_queue_evidence'] : [],
  };
}

export function evaluateMissedFillOpportunityCost(
  missedFill: MissedFillOpportunityCost,
  expectedMakerCostSavingBps: number,
): MissedFillOpportunityEvaluation {
  const netMakerBenefitBps = expectedMakerCostSavingBps - missedFill.opportunityCostBps;
  const hardBlocks =
    netMakerBenefitBps > 0 ? [] : [`maker_opportunity_cost_exceeds_expected_saving:${missedFill.orderId}`];

  return {
    pass: hardBlocks.length === 0,
    netMakerBenefitBps,
    hardBlocks,
  };
}

export function evaluateExecutionCounterfactual(
  counterfactual: ExecutionCounterfactual,
  maxChosenVsBestDeltaBps = 0,
): ExecutionCounterfactualEvaluation {
  const alternatives = [
    { route: 'taker_now' as const, costBps: counterfactual.takerNowCostBps },
    { route: 'maker_passive' as const, costBps: counterfactual.makerPassiveCostBps },
    { route: 'twap' as const, costBps: counterfactual.twapCostBps },
  ].sort((left, right) => left.costBps - right.costBps);
  const best = alternatives[0];
  const chosenVsBestDeltaBps = counterfactual.chosenPlanCostBps - best.costBps;
  const hardBlocks: string[] = [];

  if (counterfactual.bestAlternative !== best.route) {
    hardBlocks.push(`counterfactual_best_alternative_mismatch:${counterfactual.orderId}`);
  }
  if (Math.abs(counterfactual.chosenVsBestDeltaBps - chosenVsBestDeltaBps) > 1e-9) {
    hardBlocks.push(`counterfactual_delta_mismatch:${counterfactual.orderId}`);
  }
  if (chosenVsBestDeltaBps > maxChosenVsBestDeltaBps) {
    hardBlocks.push(`chosen_route_worse_than_best_counterfactual:${counterfactual.orderId}`);
  }

  return {
    pass: hardBlocks.length === 0,
    bestAlternative: best.route,
    bestAlternativeCostBps: best.costBps,
    chosenVsBestDeltaBps,
    hardBlocks,
  };
}

export function evaluateAdverseSelectionGate(signal: AdverseSelectionSignal): AdverseSelectionEvaluation {
  const hardBlocks: string[] = [];
  const passiveRoute = signal.route === 'passive_passive' || signal.route === 'passive_taker';
  const adverseOfi =
    signal.side === 'buy'
      ? signal.orderFlowImbalance <= -Math.abs(signal.adverseOfiThreshold)
      : signal.orderFlowImbalance >= Math.abs(signal.adverseOfiThreshold);

  if (passiveRoute && signal.toxicityScore > signal.maxToxicityScore) {
    hardBlocks.push('maker_toxicity_score_above_threshold');
  }
  if (passiveRoute && adverseOfi) {
    hardBlocks.push('maker_order_flow_imbalance_adverse');
  }
  if (passiveRoute && signal.volatilitySpike && signal.spreadWidening) {
    hardBlocks.push('maker_route_blocked_under_combined_stress');
  }

  return {
    pass: hardBlocks.length === 0,
    hardBlocks,
  };
}

export function evaluateExecutionDecayBreaker(
  observations: ExecutionSlippageObservation[],
  windowSize = 10,
  maxAverageExcessBps = 5,
): ExecutionDecayBreakerEvaluation {
  const recent = observations.slice(-windowSize);
  const observationCount = recent.length;
  const averageExcessSlippageBps = observationCount === 0
    ? 0
    : recent.reduce(
      (sum, observation) => sum + (observation.realizedSlippageBps - observation.expectedSlippageBps),
      0,
    ) / observationCount;
  const hardBlocks = observationCount >= windowSize && averageExcessSlippageBps > maxAverageExcessBps
    ? ['execution_decay_breaker_triggered']
    : [];

  return {
    status: hardBlocks.length === 0 ? 'pass' : 'fail',
    averageExcessSlippageBps,
    observationCount,
    hardBlocks,
  };
}

export function evaluateFreshnessDecision(input: {
  expectedBarCloseAt: string;
  latestCompleteBarAt: string;
  decisionGeneratedAt: string;
  graceMinutes?: number;
}): FreshnessDecision {
  const graceMinutes = input.graceMinutes ?? 10;
  const expectedBarCloseAtMs = Date.parse(input.expectedBarCloseAt);
  const latestCompleteBarAtMs = Date.parse(input.latestCompleteBarAt);
  const decisionGeneratedAtMs = Date.parse(input.decisionGeneratedAt);
  const latencyMinutes = (decisionGeneratedAtMs - expectedBarCloseAtMs) / 60_000;
  const completeBarAvailable = latestCompleteBarAtMs >= expectedBarCloseAtMs;

  if (completeBarAvailable && latencyMinutes <= graceMinutes) {
    return {
      status: 'fresh',
      latencyMinutes,
      hardBlocks: [],
    };
  }

  return {
    status: 'stale_bar_hard_block',
    latencyMinutes,
    hardBlocks: ['stale_1h_bar_after_grace_window'],
  };
}

export function evaluateRuntimePathAuditForTinyCap(audit: RuntimePathAudit): string[] {
  if (audit.mode !== 'tiny_cap' && audit.mode !== 'live') return [];
  if (!audit.differsFromPaper) return [];
  return [`runtime_path_differs_from_paper:${audit.differences.join(',')}`];
}

export function evaluateQuarantineForOrders(quarantine?: QuarantineRecord): string[] {
  if (!quarantine) return [];
  if (quarantine.exitStatus === 'released_to_research_only') {
    return ['quarantine_released_to_research_only_blocks_orders'];
  }
  return [`quarantine_blocks_orders:${quarantine.triggerReason}`];
}

export function makeGateResult(input: {
  gateName: GateName;
  hardBlocks?: string[];
  advisoryWarnings?: string[];
  requiredArtifacts?: string[];
  metricSnapshot?: MetricSnapshot;
  expiresAt: string;
}): GateResult {
  const hardBlocks = input.hardBlocks ?? [];
  return {
    gateName: input.gateName,
    status: hardBlocks.length === 0 ? 'pass' : 'fail',
    hardBlocks,
    advisoryWarnings: input.advisoryWarnings ?? [],
    requiredArtifacts: input.requiredArtifacts ?? [],
    metricSnapshot: input.metricSnapshot ?? {},
    expiresAt: input.expiresAt,
  };
}

export function evaluateMonetizationGate(input: EvaluateMonetizationGateInput): GateResult {
  const now = input.now ?? new Date();
  const hardBlocks: string[] = [];
  const feeValidation = evaluateFeeSnapshot(input.feeSnapshot, input.mode, now);
  const routeBudget = input.routeCostBudget.routes[input.selectedRoute];
  const benchmarkEvaluation = evaluateBenchmarkGate(input.benchmarkComparisons);
  const universeEvaluation = evaluateUniverseAttributionGate(input.universeAttribution);
  const minGrossToCostRatio = input.minGrossToCostRatio ?? 2;
  const minRouteEdgeSafetyMarginBps = 0;
  const minValidSignalsPerMonth = input.minValidSignalsPerMonth ?? 1;
  const minExpectedNetDollarsPerMonth = input.minExpectedNetDollarsPerMonth ?? 0;
  const minExecutableCapacityUsd = input.minExecutableCapacityUsd ?? input.capitalGate.minOrderNotionalUsd;

  hardBlocks.push(...feeValidation.hardBlocks);
  hardBlocks.push(...benchmarkEvaluation.hardBlocks);
  hardBlocks.push(...universeEvaluation.hardBlocks);
  hardBlocks.push(...input.capitalGate.hardBlocks.map((block) => `capital_gate:${block}`));

  if (input.grossToCostRatio === undefined) {
    hardBlocks.push('gross_to_cost_ratio_missing');
  } else if (input.grossToCostRatio < minGrossToCostRatio) {
    hardBlocks.push('gross_to_cost_ratio_below_threshold');
  }
  if (input.metrics.netExpectancyBpsPerTrade <= routeBudget.breakEvenEdgeBps + minRouteEdgeSafetyMarginBps) {
    hardBlocks.push(`net_expectancy_bps_below_route_break_even:${input.selectedRoute}`);
  }
  if (input.metrics.routeAdjustedBreakEvenBps < routeBudget.breakEvenEdgeBps) {
    hardBlocks.push(`route_adjusted_break_even_below_budget:${input.selectedRoute}`);
  }
  if (routeBudget.totalExpectedCostBps > routeBudget.maxAllowedCostBps) {
    hardBlocks.push(`route_cost_budget_exceeded:${input.selectedRoute}`);
  }
  if (input.metrics.netExpectancyUsdPerDay <= 0) {
    hardBlocks.push('net_expectancy_usd_per_day_not_positive');
  }
  if (input.metrics.netExpectancyUsdPerMonth < minExpectedNetDollarsPerMonth) {
    hardBlocks.push('net_expectancy_usd_per_month_below_minimum');
  }
  if (input.metrics.validSignalsPerMonth < minValidSignalsPerMonth) {
    hardBlocks.push('valid_signals_per_month_below_minimum');
  }
  if (input.metrics.executableCapacityUsd < minExecutableCapacityUsd) {
    hardBlocks.push('executable_capacity_below_minimum');
  }

  if (input.evidence && input.supportingEvidenceIds && input.mode !== 'research') {
    hardBlocks.push(
      ...evaluatePaperEvidenceDataOrigins(input.evidence, input.supportingEvidenceIds).map(
        (block) => `monetization_${block}`,
      ),
    );
  }

  return makeGateResult({
    gateName: 'monetization',
    hardBlocks,
    requiredArtifacts: [
      'fee_snapshot.latest.json',
      'route_cost_budget.latest.json',
      'benchmark_comparison.latest.json',
      'universe_attribution.latest.json',
    ],
    metricSnapshot: {
      selectedRoute: input.selectedRoute,
      netExpectancyUsdPerDay: input.metrics.netExpectancyUsdPerDay,
      netExpectancyUsdPerMonth: input.metrics.netExpectancyUsdPerMonth,
      validSignalsPerMonth: input.metrics.validSignalsPerMonth,
      executableCapacityUsd: input.metrics.executableCapacityUsd,
      grossToCostRatio: input.grossToCostRatio ?? 'not_reported',
      routeTotalExpectedCostBps: routeBudget.totalExpectedCostBps,
      routeMaxAllowedCostBps: routeBudget.maxAllowedCostBps,
      simpleBenchmarkPassCount: benchmarkEvaluation.simpleBenchmarkPassCount,
      pnlFromExecutionEligiblePct: input.universeAttribution.pnlFromExecutionEligiblePct,
    },
    expiresAt: input.feeSnapshot.expiresAt,
  });
}

export function buildPromotionReadinessV2(input: BuildPromotionReadinessInput): PromotionReadinessV2 {
  const now = input.now ?? new Date(input.generatedAt);
  const gateExpiryBlocks = [
    input.globalReleaseGate,
    input.researchGate,
    input.monetizationGate,
    input.paperGate,
    input.liveGate,
  ].flatMap(gate => evaluateGateExpiry(gate, now));
  const gateBlocks = [
    ...input.globalReleaseGate.hardBlocks.map((block) => `global_release:${block}`),
    ...input.researchGate.hardBlocks.map((block) => `research:${block}`),
    ...input.monetizationGate.hardBlocks.map((block) => `monetization:${block}`),
    ...input.paperGate.hardBlocks.map((block) => `paper:${block}`),
    ...input.liveGate.hardBlocks.map((block) => `live:${block}`),
    ...gateExpiryBlocks,
    ...evaluateQuarantineForOrders(input.quarantine),
  ];
  const globalReleasePass = isGateEffectivelyPass(input.globalReleaseGate, now);
  const researchPass = isGateEffectivelyPass(input.researchGate, now);
  const monetizationPass = isGateEffectivelyPass(input.monetizationGate, now);
  const paperPass = isGateEffectivelyPass(input.paperGate, now);
  const livePass = isGateEffectivelyPass(input.liveGate, now);

  let finalVerdict: PromotionFinalVerdict;
  if (input.quarantine) {
    finalVerdict = 'quarantined';
  } else if (!globalReleasePass) {
    finalVerdict = 'paper_blocked';
  } else if (!researchPass || !monetizationPass) {
    finalVerdict = 'research_only';
  } else if (!paperPass) {
    finalVerdict = 'paper_blocked';
  } else if (livePass) {
    finalVerdict = 'tiny_cap_candidate';
  } else {
    finalVerdict = 'paper_allowed';
  }

  return {
    schemaMeta: input.schemaMeta,
    strategyId: input.strategyId,
    experimentId: input.experimentId,
    generatedAt: input.generatedAt,
    globalReleaseGate: input.globalReleaseGate,
    researchGate: input.researchGate,
    monetizationGate: input.monetizationGate,
    paperGate: input.paperGate,
    liveGate: input.liveGate,
    monetization: input.monetization,
    execution: input.execution,
    dataFreshness: input.dataFreshness,
    evidence: input.evidence,
    finalVerdict,
    humanReadableReason: gateBlocks.length > 0 ? gateBlocks.join('; ') : 'all promotion gates passed',
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, canonicalize(entryValue)]));
  }
  return value;
}

export function evaluateGateExpiry(gate: GateResult, now: Date = new Date()): string[] {
  const expiresAtMs = Date.parse(gate.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return [`gate_expiry_invalid:${gate.gateName}`];
  }
  if (expiresAtMs <= now.getTime()) {
    return [`gate_expired:${gate.gateName}`];
  }
  return [];
}

export function isGateEffectivelyPass(gate: GateResult, now: Date = new Date()): boolean {
  if (gate.status === 'fail') {
    return false
  }
  return gate.status === 'pass' && evaluateGateExpiry(gate, now).length === 0;
}

export function evaluatePromotionReadinessForPaperOrders(
  readiness: PromotionReadinessV2 | null | undefined,
  options: { required?: boolean; now?: Date } = {},
): string[] {
  const hardBlocks = evaluatePromotionReadinessBase(readiness, options);
  if (!readiness || hardBlocks.includes('promotion_v2_readiness_missing')) {
    return hardBlocks;
  }

  if (readiness.finalVerdict !== 'paper_allowed' && readiness.finalVerdict !== 'tiny_cap_candidate') {
    hardBlocks.push(`promotion_v2_blocks_paper_orders:${readiness.finalVerdict}`);
  }

  return hardBlocks;
}

export function evaluatePromotionReadinessForLiveOrders(
  readiness: PromotionReadinessV2 | null | undefined,
  options: { required?: boolean; now?: Date } = {},
): string[] {
  const hardBlocks = evaluatePromotionReadinessBase(readiness, options);
  if (!readiness || hardBlocks.includes('promotion_v2_readiness_missing')) {
    return hardBlocks;
  }

  const now = options.now ?? new Date(readiness.generatedAt);
  hardBlocks.push(...readiness.liveGate.hardBlocks.map((block) => `promotion_v2_live:${block}`));
  hardBlocks.push(...evaluateGateExpiry(readiness.liveGate, now));

  if (readiness.finalVerdict !== 'tiny_cap_candidate') {
    hardBlocks.push(`promotion_v2_blocks_live_orders:${readiness.finalVerdict}`);
  }

  return hardBlocks;
}

function evaluatePromotionReadinessBase(
  readiness: PromotionReadinessV2 | null | undefined,
  options: { required?: boolean; now?: Date } = {},
): string[] {
  if (!readiness) {
    return options.required ? ['promotion_v2_readiness_missing'] : [];
  }

  const now = options.now ?? new Date(readiness.generatedAt);
  const hardBlocks = [
    ...validateSchemaMeta(readiness.schemaMeta),
    ...readiness.globalReleaseGate.hardBlocks.map((block) => `promotion_v2_global_release:${block}`),
    ...readiness.researchGate.hardBlocks.map((block) => `promotion_v2_research:${block}`),
    ...readiness.monetizationGate.hardBlocks.map((block) => `promotion_v2_monetization:${block}`),
    ...readiness.paperGate.hardBlocks.map((block) => `promotion_v2_paper:${block}`),
    ...evaluateGateExpiry(readiness.globalReleaseGate, now),
    ...evaluateGateExpiry(readiness.researchGate, now),
    ...evaluateGateExpiry(readiness.monetizationGate, now),
    ...evaluateGateExpiry(readiness.paperGate, now),
  ];

  if (readiness.evidence.missingRequiredEvidence.length > 0) {
    hardBlocks.push(
      ...readiness.evidence.missingRequiredEvidence.map((id) => `promotion_v2_missing_required_evidence:${id}`),
    );
  }
  if (readiness.evidence.blockingEvidenceIds.length > 0) {
    hardBlocks.push(
      ...readiness.evidence.blockingEvidenceIds.map((id) => `promotion_v2_blocking_evidence:${id}`),
    );
  }

  return hardBlocks;
}

function hasStrictTradeThrough(input: ConservativeMakerFillInput, tradePrints: MakerTradePrint[]): boolean {
  if (input.side === 'buy') {
    if (input.candleLow !== undefined && input.candleLow < input.limitPrice) return true;
    return tradePrints.some((print) => print.price < input.limitPrice);
  }

  if (input.candleHigh !== undefined && input.candleHigh > input.limitPrice) return true;
  return tradePrints.some((print) => print.price > input.limitPrice);
}

function hasSamePriceTouch(input: ConservativeMakerFillInput, tradePrints: MakerTradePrint[]): boolean {
  if (tradePrints.some((print) => print.price === input.limitPrice)) return true;
  if (input.side === 'buy') {
    return input.candleLow !== undefined && input.candleLow <= input.limitPrice;
  }
  return input.candleHigh !== undefined && input.candleHigh >= input.limitPrice;
}

function computeBenchmarkPass(comparison: BenchmarkComparison): boolean {
  return comparison.sameWindow &&
    comparison.sameCostModel &&
    comparison.sameExecutionEligibility &&
    comparison.sameDataOriginPolicy &&
    comparison.excessReturnBps > 0 &&
    comparison.excessMaxDrawdownAdjusted > 0;
}
