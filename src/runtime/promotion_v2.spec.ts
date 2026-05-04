import { describe, expect, it } from 'vitest';
import {
  PROMOTION_V2_SCHEMA_VERSION,
  buildPromotionReadinessV2,
  computeRebalanceDecision,
  evaluateBenchmarkGate,
  evaluateCandidateRegistryPolicy,
  evaluateCapitalGate,
  evaluateConservativeMakerFill,
  evaluateAdverseSelectionGate,
  evaluateExecutionCounterfactual,
  evaluateExecutionDecayBreaker,
  evaluateFeeSnapshot,
  evaluateFreshnessDecision,
  evaluateMissedFillOpportunityCost,
  evaluateMonetizationGate,
  evaluatePaperEvidenceDataOrigins,
  evaluatePromotionReadinessForLiveOrders,
  evaluatePromotionReadinessForPaperOrders,
  evaluateQuarantineForOrders,
  evaluateRuntimePathAuditForTinyCap,
  evaluateUniverseAttributionGate,
  makeGateResult,
  promotionV2JsonSchemas,
  resolveQueueEvidenceMultiplier,
  sha256Hex,
  validateEvidenceHashes,
  validateSchemaMeta,
  type BenchmarkComparison,
  type CandidateRegistry,
  type EvidenceItem,
  type FeeSnapshot,
  type MonetizationMetrics,
  type QuarantineRecord,
  type RouteBudget,
  type RouteCostBudget,
  type RuntimePathAudit,
  type SchemaMeta,
  type StatisticalTestPolicy,
  type UniverseAttribution,
} from './promotion_v2.js';

const now = new Date('2026-04-30T12:00:00.000Z');
const future = '2026-04-30T13:00:00.000Z';

const schemaMeta: SchemaMeta = {
  schemaName: 'strategy_promotion',
  schemaVersion: PROMOTION_V2_SCHEMA_VERSION,
  createdBy: 'vitest',
  createdAt: '2026-04-30T12:00:00.000Z',
  codeCommit: 'test-commit',
};

function routeBudget(route: RouteBudget['route'], overrides: Partial<RouteBudget> = {}): RouteBudget {
  return {
    route,
    feeBps: 4,
    spreadBps: 2,
    slippageBps: 3,
    adverseSelectionBufferBps: 3,
    queueMissBufferBps: 2,
    fundingBps: 0,
    totalExpectedCostBps: 14,
    maxAllowedCostBps: 20,
    breakEvenEdgeBps: 14,
    ...overrides,
  };
}

function feeSnapshot(overrides: Partial<FeeSnapshot> = {}): FeeSnapshot {
  return {
    venue: 'binance',
    symbol: 'BTC/USDT:USDT',
    instrumentType: 'perpetual',
    accountTier: 'regular',
    makerFeeBps: 2,
    takerFeeBps: 5,
    source: 'api',
    sourceFetchedAt: '2026-04-30T11:55:00.000Z',
    expiresAt: future,
    verifiedByRuntime: true,
    fundingIntervalHours: 8,
    nextFundingAt: '2026-04-30T16:00:00.000Z',
    ...overrides,
  };
}

function routeCostBudget(overrides: Partial<RouteCostBudget> = {}): RouteCostBudget {
  const snapshot = feeSnapshot();
  return {
    schemaMeta,
    generatedAt: '2026-04-30T12:00:00.000Z',
    feeSnapshot: snapshot,
    routes: {
      passive_passive: routeBudget('passive_passive'),
      passive_taker: routeBudget('passive_taker', { totalExpectedCostBps: 16, breakEvenEdgeBps: 16 }),
      taker_taker: routeBudget('taker_taker', { totalExpectedCostBps: 22, maxAllowedCostBps: 28, breakEvenEdgeBps: 22 }),
      twap: routeBudget('twap', { totalExpectedCostBps: 18, breakEvenEdgeBps: 18 }),
    },
    ...overrides,
  };
}

function monetizationMetrics(overrides: Partial<MonetizationMetrics> = {}): MonetizationMetrics {
  return {
    netExpectancyBpsPerTrade: 32,
    netExpectancyUsdPerTrade: 3,
    netExpectancyUsdPerDay: 6,
    netExpectancyUsdPerMonth: 180,
    validSignalsPerMonth: 30,
    executableCapacityUsd: 5_000,
    turnoverPerDay: 0.2,
    routeAdjustedBreakEvenBps: 14,
    benchmarkExcessReturnBps: 18,
    ...overrides,
  };
}

function benchmark(
  benchmarkName: BenchmarkComparison['benchmarkName'],
  overrides: Partial<BenchmarkComparison> = {},
): BenchmarkComparison {
  return {
    benchmarkName,
    sameWindow: true,
    sameCostModel: true,
    sameExecutionEligibility: true,
    sameDataOriginPolicy: true,
    strategyNetReturnBps: 35,
    benchmarkNetReturnBps: 10,
    excessReturnBps: 25,
    excessMaxDrawdownAdjusted: 18,
    pass: true,
    ...overrides,
  };
}

function passingBenchmarks(): BenchmarkComparison[] {
  return [
    benchmark('no_trade'),
    benchmark('equal_weight_universe'),
    benchmark('btc_eth_50_50'),
    benchmark('low_turnover_momentum', { pass: false, excessReturnBps: -2 }),
  ];
}

function universe(overrides: Partial<UniverseAttribution> = {}): UniverseAttribution {
  return {
    researchUniverseSize: 16,
    executionUniverseSize: 8,
    pnlFromExecutionEligiblePct: 92,
    signalsFromExecutionEligiblePct: 88,
    topContributors: [
      {
        symbol: 'BTC',
        universeRole: 'execution_eligible',
        pnlContributionPct: 40,
        tradeCount: 12,
      },
    ],
    ...overrides,
  };
}

function evidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  const artifactPath = '/tmp/openalice/evidence.json';
  return {
    id: 'evidence-1',
    experimentId: 'experiment-1',
    claim: 'live-collected paper PnL is positive after route costs',
    evidenceType: 'paper',
    dataOrigin: 'paper_live_sync',
    artifactPath,
    artifactSha256: sha256Hex('artifact-body'),
    inputArtifactHashes: [sha256Hex('input')],
    metricSnapshot: { netExpectancyUsdPerDay: 6 },
    validFrom: '2026-04-30T12:00:00.000Z',
    invalidationRule: 'expires_on_gate_expiry',
    createdAt: '2026-04-30T12:00:00.000Z',
    ...overrides,
  };
}

describe('promotion_v2 schema and evidence hygiene', () => {
  it('requires schema version metadata', () => {
    const blocks = validateSchemaMeta({ ...schemaMeta, schemaVersion: '' });

    expect(blocks).toContain('schema_version_missing');
  });

  it('exports JSON Schemas with required v2.6 anti-cheat fields', () => {
    expect(promotionV2JsonSchemas.evidenceItem.required).toContain('dataOrigin');
    expect(promotionV2JsonSchemas.feeSnapshot.required).toContain('verifiedByRuntime');
    expect(promotionV2JsonSchemas.promotionReadinessV2.required).toContain('monetizationGate');
  });

  it('invalidates evidence when artifact hashes mismatch', () => {
    const item = evidence({ artifactSha256: sha256Hex('original-body') });
    const validation = validateEvidenceHashes([item], {
      [item.artifactPath]: 'mutated-body',
    });

    expect(validation.valid).toBe(false);
    expect(validation.invalidEvidenceIds).toEqual([item.id]);
    expect(validation.reasons).toContain(`artifact_hash_mismatch:${item.id}`);
  });

  it('invalidates evidence when a required artifact is missing', () => {
    const item = evidence();
    const strictValidation = validateEvidenceHashes([item]);
    const schemaOnlyValidation = validateEvidenceHashes([item], {}, { requireArtifacts: false });

    expect(strictValidation.valid).toBe(false);
    expect(strictValidation.reasons).toContain(`artifact_missing:${item.id}`);
    expect(schemaOnlyValidation.valid).toBe(true);
  });

  it('rejects backtest-origin evidence for paper promotion', () => {
    const item = evidence({ id: 'backtest-evidence', dataOrigin: 'backtest' });

    expect(evaluatePaperEvidenceDataOrigins([item], [item.id])).toContain(
      'backtest_data_origin_not_allowed:backtest-evidence',
    );
  });

  it('blocks stale or manual fee snapshots from paper/live promotion', () => {
    const manual = evaluateFeeSnapshot(
      feeSnapshot({ source: 'manual_override', manualOverrideReason: 'test', verifiedByRuntime: true }),
      'paper',
      now,
    );
    const stale = evaluateFeeSnapshot(feeSnapshot({ expiresAt: '2026-04-30T11:59:00.000Z' }), 'paper', now);

    expect(manual.hardBlocks).toContain('manual_fee_override_not_allowed_for_paper_or_live');
    expect(stale.hardBlocks).toContain('fee_snapshot_expired');
  });

  it('detects candidate registry count mismatches against statistical policy', () => {
    const registry: CandidateRegistry = {
      schemaMeta,
      registryId: 'registry-1',
      candidateCount: 1,
      graveyardCandidateCount: 0,
      entries: [
        {
          candidateId: 'candidate-1',
          experimentId: 'experiment-1',
          strategyId: 'cross-sectional-v2',
          generatedAt: '2026-04-30T12:00:00.000Z',
          scriptName: 'optimize:cross-sectional',
          parameterHash: sha256Hex('params'),
          status: 'graveyard',
        },
      ],
    };
    const policy: StatisticalTestPolicy = {
      policyVersion: 'stat-policy-v1',
      candidateUniverseId: 'cross-sectional-v2',
      candidateCount: 2,
      includesGraveyard: false,
      pboMethod: 'cscv',
      dsrMethod: 'deflated_sharpe',
      fdrMethod: 'BH',
      alpha: 0.05,
      minTradeCount: 50,
      minOosWindows: 6,
    };

    const evaluation = evaluateCandidateRegistryPolicy(registry, policy);

    expect(evaluation.status).toBe('fail');
    expect(evaluation.hardBlocks).toContain('statistical_policy_candidate_count_mismatch');
    expect(evaluation.hardBlocks).toContain('statistical_policy_excludes_graveyard');
    expect(evaluation.hardBlocks).toContain('graveyard_count_mismatch');
  });
});

describe('promotion_v2 monetization filter', () => {
  it('fails fake gross-to-cost ratio and carries blocking evidence into readiness', () => {
    const capital = evaluateCapitalGate({
      accountEquityUsd: 10_000,
      maxCapitalAllocatedUsd: 3_000,
      minOrderNotionalUsd: 20,
      minUsefulDailyNetProfitUsd: 1,
      minUsefulMonthlyNetProfitUsd: 30,
      infraCostUsd: 10,
      riskBufferUsd: 10,
      expectedDailyNetProfitUsd: 6,
      expectedMonthlyNetProfitUsd: 180,
      capacityAtCurrentCostUsd: 5_000,
    });
    const monetizationGate = evaluateMonetizationGate({
      mode: 'paper',
      now,
      metrics: monetizationMetrics(),
      grossToCostRatio: 1.5,
      minGrossToCostRatio: 2,
      feeSnapshot: feeSnapshot(),
      routeCostBudget: routeCostBudget(),
      selectedRoute: 'passive_passive',
      benchmarkComparisons: passingBenchmarks(),
      capitalGate: capital,
      universeAttribution: universe(),
      evidence: [evidence()],
      supportingEvidenceIds: ['evidence-1'],
      minValidSignalsPerMonth: 10,
      minExpectedNetDollarsPerMonth: 30,
      minExecutableCapacityUsd: 100,
    });

    expect(monetizationGate.status).toBe('fail');
    expect(monetizationGate.hardBlocks).toContain('gross_to_cost_ratio_below_threshold');

    const readiness = buildPromotionReadinessV2({
      schemaMeta,
      strategyId: 'cross-sectional-v2',
      experimentId: 'experiment-1',
      generatedAt: '2026-04-30T12:00:00.000Z',
      globalReleaseGate: makeGateResult({ gateName: 'global_release', expiresAt: future }),
      researchGate: makeGateResult({ gateName: 'research', expiresAt: future }),
      monetizationGate,
      paperGate: makeGateResult({ gateName: 'paper', expiresAt: future }),
      liveGate: makeGateResult({ gateName: 'live', hardBlocks: ['tiny_cap_not_reviewed'], expiresAt: future }),
      monetization: monetizationMetrics(),
      execution: {
        recentOrderCount: 20,
        slippageViolationCount: 0,
        actualToSimulatedCostRatio: 1.1,
        missedFillRate: 0.2,
        decayCircuitBreakerTriggered: false,
      },
      dataFreshness: {
        latestDecisionStatus: 'fresh',
        staleBlockCount: 0,
        maxDataLatencyMinutes: 3,
      },
      evidence: {
        supportingEvidenceIds: ['evidence-1'],
        blockingEvidenceIds: ['gross-cost-evidence'],
        missingRequiredEvidence: [],
      },
    });

    expect(readiness.finalVerdict).toBe('research_only');
    expect(readiness.evidence.blockingEvidenceIds).toContain('gross-cost-evidence');
    expect(readiness.humanReadableReason).toContain('monetization:gross_to_cost_ratio_below_threshold');
  });

  it('requires no-trade and at least two simple benchmarks', () => {
    const missingNoTrade = evaluateBenchmarkGate([
      benchmark('no_trade', { pass: false, excessReturnBps: -1, excessMaxDrawdownAdjusted: -1 }),
      benchmark('equal_weight_universe'),
      benchmark('btc_eth_50_50'),
      benchmark('low_turnover_momentum'),
    ]);
    const onlyOneSimple = evaluateBenchmarkGate([
      benchmark('no_trade'),
      benchmark('equal_weight_universe'),
      benchmark('btc_eth_50_50', { pass: false, excessReturnBps: -1, excessMaxDrawdownAdjusted: -1 }),
      benchmark('low_turnover_momentum', { pass: false, excessReturnBps: -2, excessMaxDrawdownAdjusted: -1 }),
    ]);

    expect(missingNoTrade.hardBlocks).toContain('no_trade_benchmark_failed');
    expect(onlyOneSimple.hardBlocks).toContain('simple_benchmark_pass_count_below_2');
  });

  it('rejects duplicate benchmarks and stale positive pass flags', () => {
    const evaluation = evaluateBenchmarkGate([
      benchmark('no_trade'),
      benchmark('equal_weight_universe'),
      benchmark('equal_weight_universe'),
      benchmark('btc_eth_50_50', { pass: true, excessReturnBps: -3, excessMaxDrawdownAdjusted: -1 }),
      benchmark('low_turnover_momentum', { pass: false, excessReturnBps: -2, excessMaxDrawdownAdjusted: -1 }),
    ]);

    expect(evaluation.status).toBe('fail');
    expect(evaluation.hardBlocks).toContain('benchmark_duplicate:equal_weight_universe');
    expect(evaluation.hardBlocks).toContain('benchmark_pass_flag_inconsistent:btc_eth_50_50');
  });

  it('fails MonetizationGate when route break-even economics are missing or not cleared', () => {
    const capital = evaluateCapitalGate({
      accountEquityUsd: 10_000,
      maxCapitalAllocatedUsd: 3_000,
      minOrderNotionalUsd: 20,
      minUsefulDailyNetProfitUsd: 1,
      minUsefulMonthlyNetProfitUsd: 30,
      infraCostUsd: 10,
      riskBufferUsd: 10,
      expectedDailyNetProfitUsd: 6,
      expectedMonthlyNetProfitUsd: 180,
      capacityAtCurrentCostUsd: 5_000,
    });
    const gate = evaluateMonetizationGate({
      mode: 'paper',
      now,
      metrics: monetizationMetrics({
        netExpectancyBpsPerTrade: 12,
        routeAdjustedBreakEvenBps: 12,
      }),
      feeSnapshot: feeSnapshot(),
      routeCostBudget: routeCostBudget(),
      selectedRoute: 'passive_passive',
      benchmarkComparisons: passingBenchmarks(),
      capitalGate: capital,
      universeAttribution: universe(),
      minValidSignalsPerMonth: 10,
      minExpectedNetDollarsPerMonth: 30,
      minExecutableCapacityUsd: 100,
    });

    expect(gate.status).toBe('fail');
    expect(gate.hardBlocks).toContain('gross_to_cost_ratio_missing');
    expect(gate.hardBlocks).toContain('net_expectancy_bps_below_route_break_even:passive_passive');
    expect(gate.hardBlocks).toContain('route_adjusted_break_even_below_budget:passive_passive');
  });

  it('fails CapitalGate below useful net-dollar thresholds', () => {
    const capital = evaluateCapitalGate({
      accountEquityUsd: 1_000,
      maxCapitalAllocatedUsd: 200,
      minOrderNotionalUsd: 50,
      minUsefulDailyNetProfitUsd: 1,
      minUsefulMonthlyNetProfitUsd: 50,
      infraCostUsd: 25,
      riskBufferUsd: 25,
      expectedDailyNetProfitUsd: 0.2,
      expectedMonthlyNetProfitUsd: 8,
      capacityAtCurrentCostUsd: 40,
    });

    expect(capital.status).toBe('fail');
    expect(capital.hardBlocks).toContain('daily_net_profit_below_minimum_useful_threshold');
    expect(capital.hardBlocks).toContain('monthly_net_profit_below_minimum_useful_threshold');
    expect(capital.hardBlocks).toContain('monthly_net_profit_below_infra_cost_plus_risk_buffer');
    expect(capital.hardBlocks).toContain('capacity_below_min_order_notional');
  });

  it('fails UniverseAttributionGate when execution-eligible PnL is below 80 percent', () => {
    const evaluation = evaluateUniverseAttributionGate(universe({ pnlFromExecutionEligiblePct: 79.9 }));

    expect(evaluation.status).toBe('fail');
    expect(evaluation.hardBlocks).toContain('execution_eligible_pnl_below_80_pct');
  });

  it('holds rebalance when incremental edge does not clear route cost plus safety margin', () => {
    const decision = computeRebalanceDecision({
      symbol: 'SOL',
      currentWeight: 0.1,
      targetWeight: 0.2,
      proposedDeltaWeight: 0.05,
      incrementalExpectedEdgeBps: 10,
      routeRebalanceCostBps: 8,
      safetyMarginBps: 3,
    });

    expect(decision.rebalanceNetBenefitBps).toBe(-1);
    expect(decision.action).toBe('hold');
  });

  it('blocks rebalance deltas that move away from target and clamps same-direction overshoots', () => {
    const wrongWay = computeRebalanceDecision({
      symbol: 'SOL',
      currentWeight: 0.1,
      targetWeight: 0.2,
      proposedDeltaWeight: -0.2,
      incrementalExpectedEdgeBps: 25,
      routeRebalanceCostBps: 8,
      safetyMarginBps: 3,
    });
    const clamped = computeRebalanceDecision({
      symbol: 'SOL',
      currentWeight: 0.1,
      targetWeight: 0.2,
      proposedDeltaWeight: 0.5,
      incrementalExpectedEdgeBps: 25,
      routeRebalanceCostBps: 8,
      safetyMarginBps: 3,
    });

    expect(wrongWay.action).toBe('block');
    expect(clamped.action).toBe('full_rebalance');
    expect(clamped.proposedDeltaWeight).toBeCloseTo(0.1, 8);
  });
});

describe('promotion_v2 execution realism', () => {
  it('treats same-price maker touch as missed without trade-through or enough queue volume', () => {
    const result = evaluateConservativeMakerFill({
      side: 'buy',
      limitPrice: 100,
      orderQuantity: 10,
      queueMultiplier: 5,
      candleLow: 100,
      candleHigh: 101,
      samePriceVolume: 49,
    });

    expect(result.filled).toBe(false);
    expect(result.fillEvidenceType).toBe('missed_touch');
    expect(result.requiredQueueVolume).toBe(50);
    expect(result.hardBlocks).toContain('same_price_touch_without_trade_through_or_queue_evidence');
  });

  it('raises queue evidence multiplier under stress', () => {
    expect(resolveQueueEvidenceMultiplier({})).toBe(5);
    expect(resolveQueueEvidenceMultiplier({ volatilitySpike: true })).toBe(10);
    expect(
      resolveQueueEvidenceMultiplier({
        severeVolatilitySpike: true,
        severeSpreadWidening: true,
      }),
    ).toBe(20);
  });

  it('lets missed-fill opportunity cost fail maker routing', () => {
    const evaluation = evaluateMissedFillOpportunityCost(
      {
        orderId: 'order-1',
        missedFillReason: 'missed_touch',
        postDecisionMoveBps: 18,
        wouldHaveProfitedBps: 9,
        opportunityCostBps: 7,
        evaluationWindowMinutes: 30,
      },
      4,
    );

    expect(evaluation.pass).toBe(false);
    expect(evaluation.hardBlocks).toContain('maker_opportunity_cost_exceeds_expected_saving:order-1');
  });

  it('fails execution counterfactuals when the chosen route is worse than best alternative', () => {
    const evaluation = evaluateExecutionCounterfactual({
      orderId: 'order-1',
      chosenPlanCostBps: 14,
      takerNowCostBps: 18,
      makerPassiveCostBps: 9,
      twapCostBps: 12,
      bestAlternative: 'maker_passive',
      chosenVsBestDeltaBps: 5,
      evaluationWindowMinutes: 30,
    });

    expect(evaluation.pass).toBe(false);
    expect(evaluation.bestAlternative).toBe('maker_passive');
    expect(evaluation.hardBlocks).toContain('chosen_route_worse_than_best_counterfactual:order-1');
  });

  it('blocks passive maker routes when toxicity or OFI is adverse', () => {
    const evaluation = evaluateAdverseSelectionGate({
      side: 'buy',
      route: 'passive_passive',
      orderFlowImbalance: -0.35,
      adverseOfiThreshold: 0.2,
      toxicityScore: 0.8,
      maxToxicityScore: 0.5,
      volatilitySpike: true,
      spreadWidening: true,
    });

    expect(evaluation.pass).toBe(false);
    expect(evaluation.hardBlocks).toContain('maker_toxicity_score_above_threshold');
    expect(evaluation.hardBlocks).toContain('maker_order_flow_imbalance_adverse');
    expect(evaluation.hardBlocks).toContain('maker_route_blocked_under_combined_stress');
  });

  it('triggers execution decay breaker on recent 10-order slippage drift', () => {
    const observations = Array.from({ length: 10 }, (_, index) => ({
      orderId: `order-${index}`,
      expectedSlippageBps: 3,
      realizedSlippageBps: 9,
    }));
    const evaluation = evaluateExecutionDecayBreaker(observations);

    expect(evaluation.status).toBe('fail');
    expect(evaluation.averageExcessSlippageBps).toBe(6);
    expect(evaluation.hardBlocks).toContain('execution_decay_breaker_triggered');
  });

  it('hard blocks a stale 1h bar after the 10 minute grace window', () => {
    const decision = evaluateFreshnessDecision({
      expectedBarCloseAt: '2026-04-30T01:00:00.000Z',
      latestCompleteBarAt: '2026-04-30T00:00:00.000Z',
      decisionGeneratedAt: '2026-04-30T01:11:00.000Z',
    });

    expect(decision.status).toBe('stale_bar_hard_block');
    expect(decision.hardBlocks).toContain('stale_1h_bar_after_grace_window');
  });

  it('fails tiny-cap when runtime path differs from paper', () => {
    const audit: RuntimePathAudit = {
      mode: 'tiny_cap',
      signalCodePathHash: 'signal',
      gateCodePathHash: 'gate',
      executionCodePathHash: 'exec',
      configHash: 'config',
      differsFromPaper: true,
      differences: ['signalCodePathHash'],
    };

    expect(evaluateRuntimePathAuditForTinyCap(audit)).toEqual([
      'runtime_path_differs_from_paper:signalCodePathHash',
    ]);
  });

  it('blocks paper/live order generation while quarantined', () => {
    const quarantine: QuarantineRecord = {
      strategyId: 'cross-sectional-v2',
      enteredAt: '2026-04-30T12:00:00.000Z',
      triggerReason: 'execution_drift',
      frozenExperimentId: 'experiment-1',
      allowedActions: ['diagnostic', 'research_backtest'],
      exitRequiredArtifacts: ['root_cause_report.json'],
      exitStatus: 'blocked',
    };

    expect(evaluateQuarantineForOrders(quarantine)).toEqual(['quarantine_blocks_orders:execution_drift']);
  });

  it('invalidates expired PromotionReadinessV2 gates before allowing paper orders', () => {
    const expired = '2026-04-30T11:59:00.000Z';
    const readiness = buildPromotionReadinessV2({
      schemaMeta,
      strategyId: 'cross-sectional-v2',
      experimentId: 'experiment-1',
      generatedAt: '2026-04-30T12:00:00.000Z',
      globalReleaseGate: makeGateResult({ gateName: 'global_release', expiresAt: future }),
      researchGate: makeGateResult({ gateName: 'research', expiresAt: future }),
      monetizationGate: makeGateResult({ gateName: 'monetization', expiresAt: expired }),
      paperGate: makeGateResult({ gateName: 'paper', expiresAt: future }),
      liveGate: makeGateResult({ gateName: 'live', hardBlocks: ['tiny_cap_not_reviewed'], expiresAt: future }),
      monetization: monetizationMetrics(),
      execution: {
        recentOrderCount: 20,
        slippageViolationCount: 0,
        actualToSimulatedCostRatio: 1.1,
        missedFillRate: 0.2,
        decayCircuitBreakerTriggered: false,
      },
      dataFreshness: {
        latestDecisionStatus: 'fresh',
        staleBlockCount: 0,
        maxDataLatencyMinutes: 3,
      },
      evidence: {
        supportingEvidenceIds: ['evidence-1'],
        blockingEvidenceIds: [],
        missingRequiredEvidence: [],
      },
      now,
    });

    expect(readiness.finalVerdict).toBe('research_only');
    expect(readiness.humanReadableReason).toContain('gate_expired:monetization');
    expect(evaluatePromotionReadinessForPaperOrders(readiness, { now })).toContain('gate_expired:monetization');
  });

  it('requires tiny-cap readiness before allowing live orders', () => {
    const paperOnly = buildPromotionReadinessV2({
      schemaMeta,
      strategyId: 'cross-sectional-v2',
      experimentId: 'experiment-1',
      generatedAt: '2026-04-30T12:00:00.000Z',
      globalReleaseGate: makeGateResult({ gateName: 'global_release', expiresAt: future }),
      researchGate: makeGateResult({ gateName: 'research', expiresAt: future }),
      monetizationGate: makeGateResult({ gateName: 'monetization', expiresAt: future }),
      paperGate: makeGateResult({ gateName: 'paper', expiresAt: future }),
      liveGate: makeGateResult({ gateName: 'live', hardBlocks: ['tiny_cap_not_reviewed'], expiresAt: future }),
      monetization: monetizationMetrics(),
      execution: {
        recentOrderCount: 20,
        slippageViolationCount: 0,
        actualToSimulatedCostRatio: 1.1,
        missedFillRate: 0.2,
        decayCircuitBreakerTriggered: false,
      },
      dataFreshness: {
        latestDecisionStatus: 'fresh',
        staleBlockCount: 0,
        maxDataLatencyMinutes: 3,
      },
      evidence: {
        supportingEvidenceIds: ['evidence-1'],
        blockingEvidenceIds: [],
        missingRequiredEvidence: [],
      },
      now,
    });
    const tinyCap = buildPromotionReadinessV2({
      ...paperOnly,
      liveGate: makeGateResult({ gateName: 'live', expiresAt: future }),
      now,
    });

    expect(evaluatePromotionReadinessForLiveOrders(paperOnly, { now })).toContain(
      'promotion_v2_blocks_live_orders:paper_allowed',
    );
    expect(evaluatePromotionReadinessForLiveOrders(tinyCap, { now })).toEqual([]);
  });
});
