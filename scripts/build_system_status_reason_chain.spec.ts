import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildSystemStatusReasonChainReport,
  parseSystemStatusReasonChainArgs,
  runSystemStatusReasonChain,
} from './build_system_status_reason_chain.js'

describe('build_system_status_reason_chain', () => {
  it('parses runtime defaults', () => {
    expect(parseSystemStatusReasonChainArgs([])).toMatchObject({
      runtimeDir: 'data/runtime',
      outputPath: 'data/runtime/system_status_reason_chain.latest.json',
      json: false,
    })
    expect(parseSystemStatusReasonChainArgs([
      '--runtimeDir',
      'tmp/runtime',
      '--outputPath',
      'null',
      '--json',
      'true',
    ])).toMatchObject({
      runtimeDir: 'tmp/runtime',
      outputPath: null,
      json: true,
    })
  })

  it('explains PAPER_ONLY blockers without authorizing execution', () => {
    const report = buildSystemStatusReasonChainReport({
      generatedAt: '2026-05-03T00:00:00.000Z',
      strategyPromotion: {
        researchGate: {
          hardBlocks: ['wfo_missing', 'fdr_missing'],
        },
        paperGate: {
          hardBlocks: [
            'p1_trial_ledger_not_valid:skeleton',
            'p1_gate_not_useful:insufficient_data',
            'p1_cost_model_quarantine',
            'p1_stop_loss_cluster:42',
            'p1_stop_loss_attribution_incomplete:0/42',
          ],
        },
      },
      releaseGateStatus: {
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ['wfo', 'significance'],
        checks: [{
          name: 'wfo',
          status: 'fail',
          summary: 'WFO gate failed.',
          metrics: {
            overallPassed: false,
            failedWindows: 3,
            windowCount: 3,
            failedWindowRatio: 1,
            failWindowRatioThreshold: 0.3,
          },
        }],
      },
      phaseReadiness: {
        paper: {
          blockingReasons: ['paper_research_not_approved'],
        },
      },
      paperGateStatus: {
        finalAllowPaperTrading: false,
        championLoaded: false,
        policyVersionMatch: false,
        paperExecutorEnabled: false,
        blockingReasons: ['paper_research_not_approved'],
      },
      paperExecutorStatus: {
        executionPlanKind: 'blocked',
        blockingReasons: ['release_gate_not_approved'],
        portfolioPlan: {
          targetSymbolCount: 0,
          rebalanceEntryCount: 0,
          walletOperationCount: 0,
        },
      },
      p1CostModelDiagnostics: {
        quarantine: true,
        quarantineReasons: ['low_cost_prediction_sample'],
        newWindow: {
          status: 'insufficient_data',
          reason: 'awaiting_post_enforcement_closed_trades',
          closedTrades: 0,
        },
        openPositionReadiness: {
          status: 'blocked_new_missing_evidence',
          totalOpenPositions: 4,
          newOpenPositions: 1,
          producerGuardOpenPositions: 1,
          missingPredictedOpenEvidence: 4,
          legacyMissingPredictedOpenEvidence: 3,
          newMissingPredictedOpenEvidence: 1,
          transitionalDirtyMissingPredictedOpenEvidence: 0,
          producerGuardMissingPredictedOpenEvidence: 1,
          newMissingPredictedOpenEvidenceByField: [
            { field: 'expected_gross_edge_pct', missingPositions: 1 },
            { field: 'mark_match_penalty_bps', missingPositions: 1 },
          ],
          legacyOpenPositions: 3,
        },
        routeCostShadowEligibility: {
          diagnosticOnly: true,
          promotionEligible: false,
          paperExecutionAllowed: false,
          routeBudgetStatus: 'exceeded',
          selectedRoute: 'taker_taker',
          blockers: [
            'route_cost_shadow_eligibility_diagnostic_only',
            'route_cost_budget_exceeded:taker_taker',
          ],
        },
      },
      p1GateEffectiveness: {
        gateStatus: 'insufficient_data',
        costCoverageAttribution: {
          topPatchTargets: [
            {
              producerGuardStatus: 'producer_guard_enforced',
              missingPredictedCost: 1,
            },
            {
              producerGuardStatus: 'transitional_dirty_open',
              missingPredictedCost: 1,
            },
          ],
          cohorts: [
            {
              producerGuardMissingCompletePredictedOpenEvidence: 2,
            },
          ],
        },
      },
      p1TrialLedger: {
        status: 'skeleton',
        readinessGaps: {
          blockerSummary: ['pit_proxy_only_trials:9'],
        },
      },
      metaLabelingShadowReadiness: {
        status: 'blocked',
        trainingAllowed: false,
        blockers: [
          'gate_status_not_useful:insufficient_data',
          'accepted_cost_coverage_below_minimum:0<95',
        ],
      },
      liveDataFreshness: makeLiveDataFreshness(),
      okxPublicConnectivityDiagnosis: makeOkxPublicConnectivityDiagnosis(),
      okxPrivateAuthDiagnosis: makeOkxPrivateAuthDiagnosis(),
      runtimeFeeSnapshotRefresh: makeRuntimeFeeSnapshotRefresh(),
      openAliceDataCatalog: makeOpenAliceDataCatalog(),
      openAliceDownloadMonitor: makeOpenAliceDownloadMonitor(),
      researchIncubationPlan: makeResearchIncubationPlan(),
      researchLineRetirement: makeResearchLineRetirement(),
      nextResearchHypothesisPlan: makeNextResearchHypothesisPlan(),
      ethCarryResearchEvidenceStatus: makeEthCarryResearchEvidenceStatus(),
      ethCarryConfluenceCandidateStatus: makeEthCarryConfluenceCandidateStatus(),
      ethCarryConfluenceValidation: makeEthCarryConfluenceValidation(),
      ethCarryConfluenceTrialStatus: makeEthCarryConfluenceTrialStatus(),
      ethCarryConfluenceRefinementSweep: makeEthCarryConfluenceRefinementSweep(),
      ethCarryDataGapStatus: makeEthCarryDataGapStatus(),
      ethCarryProspectiveWatchdog: makeEthCarryProspectiveWatchdog(),
      okxRouteCostSlippageReadiness: makeOkxRouteCostSlippageReadiness(),
      aiScientistCryptoCandidateIntake: makeAiScientistCryptoCandidateIntake(),
      aiScientistSecondValidationQueue: makeAiScientistSecondValidationQueue(),
      aiScientistCandidateSourceManifest: makeAiScientistCandidateSourceManifest(),
      aiScientistSecondValidationReadiness: makeAiScientistSecondValidationReadiness(),
      aiScientistPitReproductionPlan: makeAiScientistPitReproductionPlan(),
      aiScientistPitRebuildQueue: makeAiScientistPitRebuildQueue(),
      aiScientistOhlcvDailySupplementPlan: makeAiScientistOhlcvDailySupplementPlan(),
      aiScientistOhlcvNativeRows: makeAiScientistOhlcvNativeRows(),
      aiScientistPitNativeRebuildStatus: makeAiScientistPitNativeRebuildStatus(),
      aiScientistPitInputDataset: makeAiScientistPitInputDataset(),
      aiScientistPitContractStatus: makeAiScientistPitContractStatus(),
      ohlcvCollectorPitContractStatus: makeOhlcvCollectorPitContractStatus(),
      strategyDefectMonitor: makeStrategyDefectMonitor(),
      strategyDefectRegistry: makeStrategyDefectRegistry(),
      strategyQualityGateCoverage: makeStrategyQualityGateCoverage(),
      quantFrameworkBenchmarkReport: makeQuantFrameworkBenchmarkReport(),
      researchCandidateSummary: makeResearchCandidateSummary(),
      cryptoFactorFamilyReport: makeCryptoFactorFamilyReport(),
      prospectiveEvidenceStatus: makeProspectiveEvidenceStatus(),
      liquidityConditionedProspectiveEvidenceStatus: makeLiquidityConditionedProspectiveEvidenceStatus(),
      icMonitorStatus: {
        status: 'warmup',
        promotionEligible: false,
        sampleCountTotal: 12,
        returnCount: 12,
        factorCount: 2,
        minimumSampleCount: 50,
        warmupWindowsRequired: 3,
        warmupWindowsObserved: 2,
        blockingReasons: ['ic_sample_count_below_minimum:12<50', 'ic_warmup_windows_below_minimum:2<3'],
        nextActions: ['Continue shadow collection until sampleCount and warmup windows meet minimum thresholds.'],
      },
      dirtyWorktreeAudit: {
        counts: {
          total: 594,
        },
      },
      runtimeManifestCoverage: {
        status: 'blocked',
        blockingReasons: [
          'manifest_missing:paperExecutorStatus',
          'manifest_hash_mismatch:phaseReadiness',
        ],
      },
      externalDerivativesCollect: {
        dryRun: false,
        appendedRows: 16,
      },
      paperPolicyShadowSettle: {
        counts: {
          appendedOutcomes: 0,
        },
      },
      schedulerSecurityAudit: makeSchedulerSecurityAudit({
        status: 'fail',
        okxCredentialPresence: {
          apiKey: false,
          secret: false,
          password: false,
        },
      }),
      goalCompletionAudit: makeGoalCompletionAudit(),
      cpBridge: {
        generated_at: '2026-05-02T23:59:00.000Z',
        cp_cycle_id: '20260503-000000',
        cp_truth_status: 'unknown',
        source: 'currencypurchases',
        mode: 'observation',
        signals: [
          { signal_id: 'CP-1', target_position_pct: 0, as_of: '2026-05-02T23:59:30.000Z', ttl_ms: 120000 },
          { signal_id: 'CP-2', target_position_pct: 0, as_of: '2026-05-02T23:59:20.000Z', ttl_ms: 120000 },
          { signal_id: 'CP-3', target_position_pct: 0, as_of: '2026-05-02T23:00:00.000Z', ttl_ms: 120000 },
          { signal_id: 'CP-4', target_position_pct: 0, as_of: 'not-a-date', ttl_ms: 120000 },
          { signal_id: 'CP-5', target_position_pct: 0, as_of: '2026-05-02T23:59:00.000Z', ttl_ms: 0 },
        ],
      },
      cpTraceLines: [
        JSON.stringify({ step: 'stale', status: 'alert', meta: { ageMs: 3600001 } }),
        JSON.stringify({ step: 'local_gate', status: 'reject', meta: { reason: 'ttl_expired' } }),
      ],
      sourceArtifacts: {
        strategyPromotion: 'data/runtime/strategy_promotion.latest.json',
        releaseGateStatus: 'data/runtime/release_gate_status.json',
        phaseReadiness: 'data/runtime/phase_readiness.latest.json',
        paperGateStatus: 'data/runtime/paper_gate_status.json',
        paperExecutorStatus: 'data/runtime/paper_executor_status.latest.json',
        p1CostModelDiagnostics: 'data/runtime/p1_trading_evidence/cost_model_diagnostics.latest.json',
        p1GateEffectiveness: 'data/runtime/p1_trading_evidence/gate_effectiveness_report.latest.json',
        p1TrialLedger: 'data/runtime/p1_trading_evidence/trial_ledger.latest.json',
        p1TrialSourceCoverage: 'data/runtime/p1_trading_evidence/trial_source_coverage.latest.json',
        routeCostBudget: 'data/runtime/route_cost_budget.latest.json',
        feeSnapshot: 'data/runtime/fee_snapshot.latest.json',
        feeSnapshotRefresh: 'data/runtime/fee_snapshot_refresh.latest.json',
        openAliceDataCatalog: 'data/runtime/openalice_data_catalog.latest.json',
        openAliceDownloadMonitor: 'data/runtime/openalice_download_monitor.latest.json',
        liveDataFreshness: 'data/runtime/live_data_freshness.latest.json',
        okxPublicConnectivityDiagnosis: 'data/runtime/okx_public_connectivity_diagnosis.latest.json',
        okxPrivateAuthDiagnosis: 'data/runtime/okx_private_auth_diagnosis.latest.json',
        metaLabelingShadowReadiness: 'data/runtime/meta_labeling_shadow_readiness.latest.json',
        dirtyWorktreeAudit: 'data/runtime/dirty_worktree_audit.latest.json',
        runtimeManifestCoverage: 'data/runtime/runtime_manifest_coverage.latest.json',
        externalDerivativesCollect: 'data/runtime/external_derivatives_data_collect.latest.json',
        paperPolicyShadowSettle: 'data/runtime/paper_policy_shadow_settle.latest.json',
        schedulerSecurityAudit: 'data/runtime/scheduler_security_audit.latest.json',
        goalCompletionAudit: 'data/runtime/openalice_goal_completion_audit.latest.json',
        cpTrace: 'data/runtime/cp_signal_trace.ndjson',
        cpBridge: '/tmp/openalice_signals.json',
        icRuntimeStatus: 'data/runtime/ic_monitor_status.latest.json',
        researchIncubationPlan: 'data/research/research_incubation_plan.latest.json',
        researchLineRetirement: 'data/research/research_line_retirement.latest.json',
        nextResearchHypothesisPlan: 'data/research/next_research_hypothesis_plan.latest.json',
        ethCarryResearchEvidenceStatus: 'data/research/eth_carry_research_evidence_status.latest.json',
        ethCarryConfluenceCandidateStatus: 'data/research/eth_carry_confluence_candidate_status.latest.json',
        ethCarryConfluenceValidation: 'data/research/eth_carry_confluence_validation.latest.json',
        ethCarryConfluenceTrialStatus: 'data/research/eth_carry_confluence_trial_status.latest.json',
        ethCarryDataGapStatus: 'data/research/eth_carry_data_gap_status.latest.json',
        ethCarryProspectiveEvidenceStatus: 'data/research/eth_carry_prospective_evidence_status.latest.json',
        ethCarryProspectiveWatchdog: 'data/runtime/eth_carry_prospective_watchdog.latest.json',
        okxRouteCostSlippageReadiness: 'data/runtime/okx_route_cost_slippage_readiness.latest.json',
      aiScientistCryptoCandidateIntake: 'data/research/ai_scientist_crypto_candidate_intake.latest.json',
      aiScientistSecondValidationQueue: 'data/research/ai_scientist_openalice_second_validation_queue.latest.json',
      aiScientistCandidateSourceManifest: 'data/research/ai_scientist_openalice_candidate_source_manifest.latest.json',
      aiScientistSecondValidationReadiness: 'data/research/ai_scientist_openalice_second_validation_readiness.latest.json',
      aiScientistPitReproductionPlan: 'data/research/ai_scientist_openalice_pit_reproduction_plan.latest.json',
      aiScientistPitRebuildQueue: 'data/research/ai_scientist_openalice_pit_rebuild_queue.latest.json',
      aiScientistPitNativeRebuildStatus: 'data/research/ai_scientist_openalice_pit_native_rebuild_status.latest.json',
      aiScientistPitInputDataset: 'data/research/ai_scientist_openalice_pit_input_dataset.latest.json',
      aiScientistPitContractStatus: 'data/research/ai_scientist_openalice_pit_contract_status.latest.json',
      ohlcvCollectorPitContractStatus: 'data/research/openalice_ohlcv_collector_pit_contract_status.latest.json',
      strategyDefectMonitor: 'data/research/strategy_defect_monitor.latest.json',
        strategyDefectRegistry: 'data/research/strategy_defect_registry.latest.json',
        strategyQualityGateCoverage: 'data/research/strategy_quality_gate_coverage.latest.json',
        quantFrameworkBenchmarkReport: 'data/research/quant_framework_benchmark_report.latest.json',
        researchCandidateSummary: 'data/research/candidate_ranking.latest.json',
        cryptoFactorFamilyReport: 'data/research/crypto_factor_family.live_accumulated.latest.json',
        liquidityConditionedFactorReport: 'data/research/liquidity_conditioned_factor_report.live_accumulated.latest.json',
        prospectiveEvidenceStatus: 'data/research/rank_ic_prospective_evidence_status.live_accumulated_fwd72_median_filter.latest.json',
        liquidityConditionedProspectiveEvidenceStatus: 'data/research/liquidity_conditioned_prospective_evidence_status.live_accumulated.latest.json',
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-03T00:00:00.000Z',
      declaredStatus: 'PAPER_ONLY',
      effectiveActionability: 'research_only_blocked',
      liveTradingAllowed: false,
      paperTradingAllowed: false,
      canPromote: false,
    })
    expect(report.overallPlanCompletionPct).toBeGreaterThanOrEqual(40)
    expect(report.overallPlanCompletionPct).toBeLessThan(60)
    expect(report.planCompletion.find(phase => phase.phase === 'P0')?.items.find(item => item.id === 'P0-A')).toMatchObject({
      blockers: expect.arrayContaining([
        'dirty_worktree_entries:594',
        'runtime_manifest_coverage_status:blocked',
        'runtime_manifest:manifest_missing:paperExecutorStatus',
        'runtime_manifest:manifest_hash_mismatch:phaseReadiness',
      ]),
      evidencePaths: expect.arrayContaining([
        'data/runtime/dirty_worktree_audit.latest.json',
        'data/runtime/runtime_manifest_coverage.latest.json',
      ]),
    })
    expect(report.governance).toMatchObject({
      promotionAllowedByThisArtifact: false,
      liveTradingAllowedByThisArtifact: false,
      paperExecutionAllowedByThisArtifact: false,
    })
    expect(report.reasonChain.map(reason => [reason.component, reason.status])).toEqual([
      ['Live data', 'available'],
      ['OKX public connectivity', 'blocked'],
      ['OpenAlice data catalog', 'blocked'],
      ['WFO', 'not_available'],
      ['IC', 'not_available_warmup'],
      ['Research incubation', 'observation_only'],
      ['Research line retirement', 'observation_only'],
      ['Research next hypothesis', 'observation_only'],
      ['ETH carry research', 'blocked'],
      ['ETH carry confluence candidate', 'blocked'],
      ['ETH carry data gaps', 'blocked'],
      ['ETH carry prospective watchdog', 'observation_only'],
      ['OKX route-cost/slippage readiness', 'blocked'],
      ['AI-Scientist crypto intake', 'observation_only'],
      ['AI-Scientist second-validation queue', 'observation_only'],
      ['OHLCV collector PIT contract', 'observation_only'],
      ['Strategy defect monitor', 'blocked'],
      ['Strategy quality gate coverage', 'blocked'],
      ['Quant framework benchmark', 'blocked'],
      ['Crypto factor family', 'not_available'],
      ['Liquidity-conditioned prospective', 'observation_only'],
      ['Scheduler security', 'blocked'],
      ['Goal completion audit', 'blocked'],
      ['Allocator', 'blocked'],
      ['CP bridge', 'observation_only'],
    ])
    expect(report.reasonChain.find(reason => reason.component === 'Live data')).toMatchObject({
      status: 'available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'live_data_fresh_but_execution_still_requires_strategy_gates',
      ]),
      metrics: {
        status: 'fresh',
        publicDataUsableForLiveOnlyResearch: true,
        expectedAssets: 78,
        presentAssets: 78,
        freshAssets: 78,
        enoughRowsAssets: 78,
        oneHourCommonPeriods: 1001,
        oneHourCommonLatestDatetime: '2026-05-05T01:00:00.000Z',
        oneHourIncubationCommonPeriodsReady: true,
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'OKX public connectivity')).toMatchObject({
      status: 'blocked',
      usableForPromotion: false,
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'okx_public_connectivity_status:blocked',
        'okx_public_connectivity:okx_public_connectivity_all_hosts_failed',
        'okx_public_connectivity:okx_public_host_failed:www.okx.com:tls',
      ]),
      metrics: {
        status: 'blocked',
        researchOnly: true,
        diagnosticOnly: true,
        publicDataFetchable: false,
        proxyConfigured: true,
        proxyHostname: '127.0.0.1',
        proxyPort: '7890',
        attempts: 2,
        failedHosts: ['www.okx.com', 'aws.okx.com'],
        failedErrorClasses: ['tls'],
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'OpenAlice data catalog')).toMatchObject({
      status: 'blocked',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'OpenAlice data catalog is blocked: 30/97 dataset(s) complete; primary blocker=download_gap (51).',
      blockingReasons: expect.arrayContaining([
        'openalice_data_catalog_status:blocked',
        'openalice_download_monitor_status:watching',
        'openalice_download_monitor:openalice_data_catalog_download_gap:51',
        'openalice_data_catalog:binance_public_incomplete:30/81',
        'openalice_data_catalog:point_in_time_feature_snapshot_missing',
        'openalice_data_catalog_ai_scientist:ai_scientist_candidates_require_openalice_second_validation',
        'openalice_data_catalog_does_not_authorize_execution',
      ]),
      metrics: {
        status: 'blocked',
        datasets: 97,
        complete: 30,
        verifiedBinancePublicDatasets: 30,
        plannedBinancePublicDatasets: 81,
        dataCatalogTotalBlockers: 82,
        dataCatalogPrimaryBlockerCategory: 'download_gap',
        dataCatalogDownloadGapBlockers: 51,
        dataCatalogPitOrNormalizedGapBlockers: 8,
        dataCatalogAiScientistValidationGateBlockers: 15,
        dataCatalogDerivativesAuditGapBlockers: 2,
        dataCatalogAssetMetadataGapBlockers: 2,
        dataCatalogManifestOrTrustGapBlockers: 3,
        dataCatalogResumeContractGapBlockers: 1,
        downloadMonitorStatus: 'watching',
        downloadMonitorTrackedDatasets: 8,
        downloadMonitorCompleteDatasets: 2,
        downloadMonitorIncompleteDatasets: 6,
        downloadMonitorZipFiles: 11564,
        downloadMonitorPartFiles: 20,
        downloadMonitorCatalogDownloadGapBlockers: 51,
        downloadMonitorCatalogPitOrNormalizedGapBlockers: 8,
        downloadMonitorBinanceCompleteDatasets: 31,
        downloadMonitorBinanceIncompleteDatasets: 50,
        downloadMonitorBinanceZipFiles: 641987,
        downloadMonitorBinancePartFiles: 20,
        downloadMonitorActiveProcessCount: 1,
        downloadMonitorActiveDatasetIds: ['um-all-usdt-aggTrades'],
        downloadMonitorNextIncompleteDatasetIds: expect.arrayContaining([
          'spot-all-usdt-trades',
          'um-all-usdt-fundingRate',
        ]),
        observedFamilies: expect.arrayContaining(['market', 'derivatives', 'research_candidates']),
        observedLayers: expect.arrayContaining(['raw', 'runtime', 'derived']),
        aiScientistCandidateDatasetPresent: true,
        aiScientistCandidateDatasetStatus: 'partial',
        aiScientistCandidateCount: 1,
        aiScientistCandidateSummaryPresent: true,
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'WFO')?.blockingReasons).toEqual(
      expect.arrayContaining(['release_gate_wfo_status:fail', 'research:wfo_missing']),
    )
    expect(report.reasonChain.find(reason => reason.component === 'WFO')?.metrics).toMatchObject({
      failureMode: 'failed_by_window_ratio',
      passedWindows: 0,
      failedWindows: 3,
      windowCount: 3,
      failedWindowRatio: 1,
      failWindowRatioThreshold: 0.3,
      failedWindowRatioOverThreshold: true,
    })
    expect(report.reasonChain.find(reason => reason.component === 'IC')?.metrics).toMatchObject({
      status: 'warmup',
      promotionEligible: false,
      sampleCountTotal: 12,
      returnCount: 12,
      factorCount: 2,
      minimumSampleCount: 50,
      sampleThresholdPassed: false,
      warmupWindowsRequired: 3,
      warmupWindowsObserved: 2,
      warmupThresholdPassed: false,
      decayedFactorCount: 0,
      decayedSymbolCount: 0,
      decayedPairCount: 0,
    })
    expect(report.reasonChain.find(reason => reason.component === 'OKX route-cost/slippage readiness')).toMatchObject({
      status: 'blocked',
      usableForPromotion: false,
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'okx_route_cost_slippage_readiness_status:blocked',
        'okx_route_cost_slippage:route_cost_budget_fee_snapshot_mismatch',
        'okx_route_cost_slippage:paper_execution_slippage_telemetry_unavailable',
      ]),
      metrics: {
        publicOrderbookUsableForResearch: true,
        runtimeFeeSnapshotUsableForResearch: true,
        routeCostBudgetRuntimeVerified: false,
        paperExecutionTelemetryAvailable: false,
        orderbookRowsBuilt: 3,
        requiredOrderbookSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        requiredOrderbookPassedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        requiredOrderbookBlockedSymbols: [],
        requiredOrderbookMissingSymbols: [],
        requiredOrderbookAllPass: true,
        feeSnapshotSource: 'api',
        feeSnapshotVerifiedByRuntime: true,
        routeBudgetFeeSnapshotSource: 'manual_override',
        routeBudgetFeeSnapshotMatchesRuntimeFeeSnapshot: false,
        recentOrderCount: 11,
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'Research incubation')).toMatchObject({
      status: 'observation_only',
      usableForPromotion: false,
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'incubation_requirement_blocked:live_only_signal_periods',
        'incubation_requirement_blocked:runtime_fee_snapshot',
        'incubation:rank_ic_signal_periods_low:3<30',
        'incubation:fee_snapshot_not_runtime_verified',
        'runtime_fee_snapshot_blocked',
        'runtime_fee:fee_snapshot_fetch_failed:auth',
        'okx_private_auth_blocked',
        'okx_auth:okx_auth_not_recognized_any_mode',
        'prospective_evidence:research_only_not_execution_evidence',
        'prospective_evidence:prospective_closed_outcomes_low:0<100',
      ]),
      metrics: {
        planStatus: 'active_incubation',
        incubationCandidatesFound: 1,
        primaryCandidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
        primaryRoute: 'passive_passive',
        primaryNetAfterRouteCostPct: 11.376377,
        primarySignalPeriods: 3,
        primaryCommonPeriods: 413,
        primaryWfoStatus: 'insufficient_data',
        lineHealth: 'incubate',
        killTriggers: [],
        primaryFeeSource: 'manual_override',
        primaryFeeVerifiedByRuntime: false,
        candidateSummaryRowsFound: 400,
        liquidityConditionedPivotPresent: true,
        liquidityConditionedPivotCandidateId: 'liq_high_reversal_lb168_fwd72',
        liquidityConditionedPivotStrategy: 'high_reversal',
        liquidityConditionedPivotNetAfterRouteCostPct: 2.59443,
        liquidityConditionedPivotWfoStatus: 'fail',
        liquidityConditionedPivotFailedWindowRatio: 0.6,
        liquidityConditionedPivotSignalPeriods: 959,
        liquidityConditionedPivotCommonPeriods: 1200,
        runtimeFeeSnapshotRefreshStatus: 'blocked',
        runtimeFeeSnapshotWritten: false,
        runtimeFeeStatusWritten: true,
        runtimeFeeExchange: 'okx',
        runtimeFeeMarketType: 'swap',
        runtimeFeeSymbolCount: 3,
        runtimeFeePerSymbolFees: 0,
        runtimeFeeErrorClasses: ['api_not_supported', 'auth'],
        prospectiveEvidenceStatus: 'collecting',
        prospectiveOpenEvents: 1,
        prospectiveClosedEvents: 0,
        prospectivePendingOpenEvents: 1,
        prospectiveDueOpenEventsWithoutClose: 0,
        prospectiveClosedOutcomes: 0,
        prospectiveMeanGrossLongShortSpreadPct: null,
        prospectiveWinRatePct: null,
        prospectiveMinClosedOutcomes: 100,
        prospectiveMinNonOverlappingWindows: 3,
        prospectiveLatestOpenSignalPair: 'WLD-USDT/DOGE-USDT',
        prospectiveLatestOpenDecisionTime: '2026-05-05T03:00:00.000Z',
        prospectiveLatestOpenLabelDueTime: '2026-05-08T03:00:00.000Z',
        liquidityConditionedProspectiveStatus: 'collecting',
        liquidityConditionedProspectiveOpenEvents: 1,
        liquidityConditionedProspectiveClosedEvents: 0,
        liquidityConditionedProspectivePendingOpenEvents: 1,
        liquidityConditionedProspectiveDueOpenEventsWithoutClose: 0,
        liquidityConditionedProspectiveOpenDecisionWindows: 1,
        liquidityConditionedProspectiveClosedDecisionWindows: 0,
        liquidityConditionedProspectiveClosedOutcomes: 0,
        liquidityConditionedProspectiveMeanOpenEventsPerDecisionWindow: 1,
        liquidityConditionedProspectiveLatestOpenDecisionTime: '2026-05-05T03:00:00.000Z',
        liquidityConditionedProspectiveLatestOpenLabelDueTime: '2026-05-08T03:00:00.000Z',
        okxPrivateAuthStatus: 'blocked',
        okxPrivateAuthBestMode: null,
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'Research incubation')?.blockingReasons).toEqual(
      expect.arrayContaining([
        'liquidity_conditioned_pivot:liq_high_reversal_lb168_fwd72',
        'liquidity_conditioned_wfo_status:fail',
        'liquidity_conditioned_wfo_failed_window_ratio:0.6>0.3',
        'liquidity_conditioned:route_cost_manual_not_runtime_verified',
      ]),
    )
    expect(report.reasonChain.find(reason => reason.component === 'Research line retirement')).toMatchObject({
      status: 'observation_only',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'Research line remains in live-only incubation; primary=rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5.',
      evidencePaths: expect.arrayContaining([
        'data/research/research_line_retirement.latest.json',
        'data/research/research_incubation_plan.latest.json',
        'data/research/liquidity_conditioned_factor_report.live_accumulated.latest.json',
      ]),
      blockingReasons: expect.arrayContaining([
        'research_line_retirement_verdict:keep_incubating',
        'research_line_health:incubating',
        'research_line_retirement:no_retirement_recommendation',
        'reactivation_required:wfo_failed_window_ratio_lte_threshold_and_direction_stable',
      ]),
      metrics: {
        verdict: 'keep_incubating',
        lineHealth: 'incubating',
        researchOnly: true,
        diagnosticOnly: true,
        promotionAllowed: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        policyMutationAllowed: false,
        activeIncubationCandidates: 1,
        retirementRecommendedLines: 0,
        primaryCandidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
        primaryNetAfterRouteCostPct: 11.376377,
        primaryWfoStatus: 'insufficient_data',
        primaryRuntimeFeeVerified: false,
        primaryKillTriggers: [],
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'Research next hypothesis')).toMatchObject({
      status: 'observation_only',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'Next research plan has 1 admitted research-only experiment(s); retired-line parameter search remains forbidden.',
      evidencePaths: expect.arrayContaining([
        'data/research/next_research_hypothesis_plan.latest.json',
        'data/research/research_line_retirement.latest.json',
        'src/strategy/contracts/strategy_family_contract.ts',
      ]),
      blockingReasons: expect.arrayContaining([
        'next_research_hypothesis_plan_status:ready_for_research_only_experiments',
        'next_research_hypothesis:retired_line_parameter_search_forbidden',
        'forbidden_continuation:rank_ic_signal_confidence_best_lb120_sec336_fwd72_mtf0_5',
      ]),
      metrics: {
        planStatus: 'ready_for_research_only_experiments',
        researchOnly: true,
        diagnosticOnly: true,
        promotionAllowed: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        policyMutationAllowed: false,
        experimentCards: 3,
        admittedResearchOnlyExperiments: 1,
        watchOnlyExperiments: 2,
        blockedExperiments: 0,
        highPriorityExperiments: 2,
        forbiddenContinuationCount: 1,
        admittedFamilies: ['funding_carry_rebuild'],
        experimentFamilies: [
          'funding_carry_rebuild',
          'liquidation_aftermath_oi_confirmation',
          'kronos_forecast_shadow',
        ],
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'ETH carry research')).toMatchObject({
      status: 'blocked',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'ETH carry research is blocked: status=research_only_blocked, profitability=cannot_claim_profitable.',
      evidencePaths: expect.arrayContaining([
        'data/research/eth_carry_research_evidence_status.latest.json',
        'data/research/eth_carry_data_gap_status.latest.json',
        'data/research/eth_carry_prospective_evidence_status.latest.json',
        'data/research/next_research_hypothesis_plan.latest.json',
        'scripts/build_eth_carry_research_evidence_status.ts',
      ]),
      blockingReasons: expect.arrayContaining([
        'eth_carry_research_status:research_only_blocked',
        'eth_carry_profitability_verdict:cannot_claim_profitable',
        'eth_carry:release_gate_failed:wfo',
        'eth_carry:net_expectancy_non_positive:-0.008',
        'eth_carry:funding_available_time_missing:ETH:0/200',
        'eth_carry:basis_spread_feature_missing',
        'eth_carry_data_gap:carry_feature_rows_low:14<100',
        'eth_carry_data_gap:external_derivatives_collect_errors:tls:10',
        'eth_carry_kill:net_carry_after_stressed_unwind_cost<=0',
        'eth_carry_kill:funding_or_basis_available_time_missing',
      ]),
      metrics: {
        status: 'research_only_blocked',
        profitabilityVerdict: 'cannot_claim_profitable',
        selectedRole: 'control',
        selectedCandidateId: 'carry_24h_z13',
        selectedNetExpectancyPct: -0.008,
        selectedTradeCount: 12,
        selectedWfoPassed: false,
        selectedWfoFailedWindowRatio: 1,
        selectedPbo: 0.6,
        selectedRiskProfitProbability: 0.035,
        bestObservedCandidateId: 'carry_short_bias_core',
        bestObservedNetExpectancyPct: -0.00058,
        fundingExplicitAvailableTimeCoveragePct: 0,
        fundingAvailableTimeStatus: 'missing_explicit_available_time',
        basisAvailableTimeStatus: 'missing_basis_feature',
        prospectiveStatus: 'collecting',
        prospectiveOpenEvents: 1,
        prospectiveClosedOutcomes: 0,
        prospectiveClosedDecisionWindows: 0,
        prospectiveMinClosedOutcomes: 100,
        prospectiveLatestOpenObservationId: 'obs-1',
        runtimeFeeStatus: 'runtime_verified',
        okxPrivateAuthStatus: 'auth_available',
        paperExecutionSlippageAvailable: false,
        trialLedgerStatus: 'fail',
        dataGapStatus: 'blocked_insufficient_research_data',
        dataGapCarryFeatureRows: 14,
        dataGapProspectiveClosedOutcomes: 3,
        dataGapCollectorErrorCount: 10,
        nextResearchAdmittedFundingCarry: true,
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'ETH carry data gaps')).toMatchObject({
      status: 'blocked',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'ETH carry data gap status=blocked_insufficient_research_data: featureRows=14, prospectiveClosed=3.',
      evidencePaths: expect.arrayContaining([
        'data/research/eth_carry_data_gap_status.latest.json',
        'data/runtime/external_derivatives_data_collect.latest.json',
        'scripts/build_eth_carry_data_gap_status.ts',
      ]),
      blockingReasons: expect.arrayContaining([
        'eth_carry_data_gap_status:blocked_insufficient_research_data',
        'eth_carry_data_gap:carry_feature_rows_low:14<100',
        'eth_carry_data_gap:prospective_closed_outcomes_low:3<100',
        'eth_carry_data_gap:external_derivatives_collect_errors:tls:10',
      ]),
      metrics: {
        status: 'blocked_insufficient_research_data',
        researchOnly: true,
        diagnosticOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        executionAllowed: false,
        carryFeatureRows: 14,
        minCarryFeatureRows: 100,
        prospectiveClosedOutcomes: 3,
        minProspectiveClosedOutcomes: 100,
        collectorErrorCount: 10,
        dataVisionArchives: 4,
        dataVisionArchivesComplete: 0,
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'ETH carry prospective watchdog')).toMatchObject({
      status: 'observation_only',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'ETH carry prospective watchdog status=watch_waiting_for_label: pending=1, due=0, closed=3.',
      evidencePaths: expect.arrayContaining([
        'data/runtime/eth_carry_prospective_watchdog.latest.json',
        'data/research/eth_carry_prospective_evidence_status.latest.json',
        'scripts/build_eth_carry_prospective_watchdog.ts',
      ]),
      blockingReasons: expect.arrayContaining([
        'eth_carry_prospective_watchdog_status:watch_waiting_for_label',
        'eth_carry_prospective_evidence:prospective_closed_outcomes_low:3<100',
      ]),
      metrics: {
        status: 'watch_waiting_for_label',
        researchOnly: true,
        diagnosticOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        executionAllowed: false,
        pendingOpenEvents: 1,
        dueOpenEventsWithoutClose: 0,
        closedOutcomes: 3,
        okxFresh: true,
        pitReady: true,
        pitAuditPass: true,
        candleDataCanSettleNextDue: false,
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'ETH carry confluence candidate')).toMatchObject({
      status: 'blocked',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'ETH carry confluence candidate eth_carry_confluence_filter_funding_positive_basis_positive_short_eth_long_btc is research_candidate_insufficient_evidence; it is research-only and cannot trade.',
      blockingReasons: expect.arrayContaining([
        'eth_carry_confluence_candidate_status:research_candidate_insufficient_evidence',
        'eth_carry_confluence_trial_status:research_trial_insufficient_evidence',
        'eth_carry_confluence_refinement_status:research_refinement_insufficient_evidence',
        'eth_carry_confluence:prospective_closed_outcomes_low:26<100',
        'eth_carry_confluence:confluence_bucket_closed_outcomes_low:4<30',
        'eth_carry_confluence:research_only_not_execution_evidence',
        'eth_carry_confluence:paper_live_execution_disabled',
        'eth_carry_confluence_trial:trial_total_closed_outcomes_low:26<100',
        'eth_carry_confluence_trial:selected_bucket_closed_outcomes_low:4<30',
        'eth_carry_confluence_refinement:prospective_closed_outcomes_low:26<100',
      ]),
      metrics: {
        status: 'research_candidate_insufficient_evidence',
        researchOnly: true,
        diagnosticOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        executionAllowed: false,
        signalDiagnosticsClosedRows: 26,
        recommendedCandidateId: 'eth_carry_confluence_filter_funding_positive_basis_positive_short_eth_long_btc',
        recommendedSourceBucketId: 'confluence:funding_positive:basis_positive:direction_short_eth_long_btc',
        recommendedFundingSpreadSign: 'positive',
        recommendedBasisSpreadDiffPctSign: 'positive',
        recommendedDirection: 'short_eth_long_btc',
        recommendedClosedOutcomes: 4,
        recommendedWinRatePct: 75,
        recommendedMeanNetPct: 0.145,
        validationStatus: 'research_validation_passed_observation_only',
        validationTradesBuilt: 150,
        validationMeanNetPct: 0.038,
        validationWinRatePct: 65,
        validationPassedWindows: 3,
        validationFailedWindows: 0,
        trialStatus: 'research_trial_insufficient_evidence',
        trialRawM: 4,
        trialRawMComplete: true,
        trialIncludesFailedTrials: true,
        trialPValuePromotionGrade: false,
        trialSelectedClosedOutcomes: 4,
        trialTotalClosedOutcomes: 26,
        trialValidationTrades: 150,
        trialSelectedPValue: 0.3125,
        trialSelectedQValue: 1,
        trialSelectedFdrPassed: false,
        trialWfoStatus: 'pass_research_only',
        trialRiskStatus: 'pass_research_only',
        refinementStatus: 'research_refinement_insufficient_evidence',
        refinementVariantsTested: 4,
        refinementMatchedClosedRows: 26,
        refinementRawM: 4,
        refinementRawMComplete: true,
        refinementPValuePromotionGrade: false,
        refinementBestVariantId: 'eth_carry_confluence_refine_funding_abs_gte_0_00005_basis_abs_gte_0_02',
        refinementBestClosedOutcomes: 4,
        refinementBestMeanNetPct: 0.145,
        refinementBestWinRatePct: 75,
        refinementBestFdrPassed: false,
        refinementBestQValue: 1,
        refinementBestFundingAbsThreshold: 0.00005,
        refinementBestBasisAbsThresholdPct: 0.02,
        refinementBestWfoStatus: 'pass_research_only',
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'AI-Scientist crypto intake')).toMatchObject({
      status: 'observation_only',
      usableForPromotion: false,
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'ai_scientist_intake_status:research_only_blocked',
        'ai_scientist_intake:ai_scientist_intake_research_only',
        'ai_scientist_outputs_require_openalice_second_validation',
      ]),
      metrics: {
        status: 'research_only_blocked',
        candidatesFound: 1,
        runsWithWalkForward: 1,
        runsWithFundingFeatures: 1,
        topCandidateId: 'ridge_multi_assets_h24_lb64',
        topProofStatus: 'not_proven',
        topOpenAlicePitAuditPassed: false,
        topOpenAliceIntakeDecision: 'research_only_second_validation_required',
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'AI-Scientist second-validation queue')).toMatchObject({
      status: 'observation_only',
      usableForPromotion: false,
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'ai_scientist_second_validation_queue_status:queued_research_only',
        'ai_scientist_source_manifest_status:locked_research_only',
        'ai_scientist_second_validation_readiness_status:blocked_openalice_validation_missing',
        'ai_scientist_pit_reproduction_plan_status:blocked_pit_contract_missing',
        'ai_scientist_pit_rebuild_queue_status:blocked_waiting_for_openalice_native_rebuild',
        'ai_scientist_ohlcv_daily_supplement_plan_status:planned_research_only_daily_supplement',
        'ai_scientist_ohlcv_native_rows_status:research_rows_materialized_pit_blocked',
        'ai_scientist_pit_native_rebuild_status:blocked_native_lineage_not_ready',
        'ai_scientist_pit_input_dataset_status:research_dataset_ready_pit_blocked',
        'ai_scientist_pit_contract_status:blocked_pit_contract_missing',
        'ai_scientist_second_validation_queue:openalice_second_validation_queued_not_completed',
        'ai_scientist_pit_reproduction_plan:ai_scientist_pit_plan_research_only',
        'ai_scientist_pit_rebuild_queue:ai_scientist_pit_available_at_rebuild_required:6',
        'ai_scientist_ohlcv_daily_supplement_plan:daily_supplement_probe_not_run',
        'ai_scientist_ohlcv_native_rows:row_pit_usable_for_promotion_false',
        'ai_scientist_pit_native_rebuild:ai_scientist_pit_ohlcv_collector_upgrade_required:6',
        'ai_scientist_pit_input_dataset:pit_input_dataset_research_only',
        'ai_scientist_pit_contract_status:row_explicit_available_at_missing:0/500',
        'ai_scientist_openalice_second_validation_not_completed',
      ]),
      metrics: {
        status: 'queued_research_only',
        queuedCandidates: 1,
        requiredGateCount: 11,
        missingGateCount: 8,
        topCandidateId: 'ridge_multi_assets_h24_lb64',
        topExecutionAllowed: false,
        sourceManifestStatus: 'locked_research_only',
        sourceManifestCandidatesLocked: 1,
        sourceManifestSourceFilesMissing: 0,
        readinessStatus: 'blocked_openalice_validation_missing',
        readinessCandidatesReadyForReproduction: 1,
        readinessMissingOpenAliceEvidenceGates: 8,
        pitReproductionPlanStatus: 'blocked_pit_contract_missing',
        pitReproductionCandidatesPlanned: 1,
        pitReproductionCandidatesReady: 0,
        pitReproductionCsvInputFiles: 6,
        pitReproductionCsvFilesWithAvailableAt: 0,
        pitReproductionCsvFilesWithObservedOrFetchedAt: 0,
        pitReproductionWarehouseLinkedInputs: 0,
        pitRebuildQueueStatus: 'blocked_waiting_for_openalice_native_rebuild',
        pitRebuildTasks: 6,
        pitRebuildOpenTasks: 6,
        pitRebuildMissingAvailableAtTasks: 6,
        pitRebuildMissingObservedOrFetchedAtTasks: 6,
        pitRebuildIncompleteWarehouseLineageTasks: 6,
        ohlcvDailySupplementStatus: 'planned_research_only_daily_supplement',
        ohlcvDailySupplementEntries: 6,
        ohlcvDailySupplementLocal: 0,
        ohlcvDailySupplementNotChecked: 6,
        ohlcvNativeRowsStatus: 'research_rows_materialized_pit_blocked',
        ohlcvNativeRowsWritten: 1500,
        ohlcvNativeRowsPromotionGradeRows: 0,
        pitNativeRebuildStatus: 'blocked_native_lineage_not_ready',
        pitNativeRebuildAssessedTasks: 6,
        pitNativeRebuildAutoEligibleTasks: 0,
        pitNativeRebuildCollectorUpgradeTasks: 6,
        pitNativeRebuildRawKlineManifestWithPromotionGradeTimeFieldsTasks: 0,
        pitNativeRebuildDerivativesPitUsableTasks: 0,
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'Strategy defect monitor')).toMatchObject({
      status: 'blocked',
      usableForPromotion: false,
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'strategy_defect_monitor_status:blocked',
        'strategy_defect_registry_status:blocked',
        'strategy_defect:carry_pit_basis_economics:basis_spread_feature_missing',
        'strategy_defect_registry:2.2:partial_take_profit_missing',
      ]),
      metrics: {
        status: 'blocked',
        findings: 10,
        blocked: 7,
        p0Blocked: 3,
        registryStatus: 'blocked',
        registryDefects: 47,
        registryP0OpenOrPartial: 13,
        registryP1OpenOrPartial: 23,
        topBlockedId: 'carry_pit_basis_economics',
        topBlockedSeverity: 'P0',
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'Strategy quality gate coverage')).toMatchObject({
      status: 'blocked',
      usableForPromotion: false,
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'strategy_quality_gate_coverage_status:blocked',
        'strategy_quality_gate_coverage:p0_open_or_partial_defects_without_monitor:4',
        'strategy_quality_gate_coverage:p1_open_or_partial_defects_without_monitor:15',
      ]),
      metrics: {
        status: 'blocked',
        p0p1OpenOrPartial: 28,
        p0p1OpenOrPartialUncovered: 19,
        p0OpenOrPartialUncovered: 4,
        p1OpenOrPartialUncovered: 15,
        p0p1OpenOrPartialCoveragePct: 32,
        blockedRepairQueues: 6,
        topUncoveredDefectId: '2.8',
        topUncoveredRepairQueueId: 'execution_quality',
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'Quant framework benchmark')).toMatchObject({
      status: 'blocked',
      usableForPromotion: false,
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'quant_framework_benchmark_status:blocked',
        'quant_framework_benchmark:order_book_matching:related_defect_open_or_partial:2.5',
        'quant_framework_benchmark:portfolio_risk_management:related_defect_open_or_partial:7.2',
      ]),
      metrics: {
        status: 'blocked',
        researchOnly: true,
        diagnosticOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        frameworks: 6,
        capabilities: 10,
        blockedCapabilities: 2,
        missingEvidenceCapabilities: 0,
        relatedOpenOrPartialDefects: 2,
        p0RelatedOpenOrPartialDefects: 2,
        dataCatalogStatus: 'blocked',
        reasonChainActionability: 'research_only_blocked',
        blockedCapabilityIds: expect.arrayContaining(['order_book_matching', 'portfolio_risk_management']),
        topBlockedCapabilityId: 'order_book_matching',
        topBlockedPriority: 'P0',
        topBlockedOpenOrPartialDefectIds: ['2.5'],
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'Crypto factor family')).toMatchObject({
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'crypto_factor_family_verdict:incubate_observation',
        'crypto_factor_family_wfo_status:fail',
        'crypto_factor_family_wfo_failed_window_ratio:0.6>0.3',
        'crypto_factor_family:route_cost_manual_not_runtime_verified',
        'runtime_fee_snapshot_blocked',
      ]),
      metrics: {
        researchOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        configsEvaluated: 96,
        bestCandidateId: 'factor_reversal_lb168_fwd72',
        bestFactor: 'reversal',
        bestVerdict: 'incubate_observation',
        bestNetAfterRouteCostPct: 0.237095,
        bestWfoStatus: 'fail',
        bestWfoPassedWindows: 2,
        bestWfoFailedWindows: 3,
        bestWfoFailedWindowRatio: 0.6,
        routeCostSource: 'manual_diagnostic_override',
        routeCostRuntimeVerified: false,
        runtimeFeeSnapshotRefreshStatus: 'blocked',
        runtimeFeeSnapshotWritten: false,
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'Liquidity-conditioned prospective')).toMatchObject({
      status: 'observation_only',
      usableForPromotion: false,
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'liquidity_conditioned_prospective:research_only_not_execution_evidence',
        'liquidity_conditioned_prospective:prospective_closed_outcomes_low:0<100',
        'runtime_fee_snapshot_blocked',
      ]),
      metrics: {
        status: 'collecting',
        researchOnly: true,
        prospectiveOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        openEvents: 1,
        closedEvents: 0,
        openDecisionWindows: 1,
        closedDecisionWindows: 0,
        meanOpenEventsPerDecisionWindow: 1,
        closedOutcomes: 0,
        minClosedOutcomes: 100,
        minNonOverlappingWindows: 3,
        requireRuntimeVerifiedFees: true,
        requireRouteCostAdjustedLabels: true,
        latestOpenDecisionTime: '2026-05-05T03:00:00.000Z',
        latestOpenLabelDueTime: '2026-05-08T03:00:00.000Z',
        latestOpenSignalPair: 'AAA-USDT/BBB-USDT',
        runtimeFeeSnapshotRefreshStatus: 'blocked',
        runtimeFeeSnapshotWritten: false,
        notesContainCorrelationWarning: true,
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'Scheduler security')).toMatchObject({
      status: 'blocked',
      usableForPromotion: false,
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'scheduler_security_status:fail',
        'scheduler_security:runtime_fee_auth_tick_okx_credentials',
      ]),
      metrics: {
        status: 'fail',
        failFindingCount: 1,
        runtimeFeeAuthJobEnabledHits: 1,
        envFileRestricted: true,
        runtimeFeeAuthOkxCredentialPresence: {
          apiKey: false,
          secret: false,
          password: false,
        },
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'Goal completion audit')).toMatchObject({
      status: 'blocked',
      usableForPromotion: false,
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'goal_completion_audit_status:blocked',
        'openalice_user_goal_not_complete',
        'goal_completion:multi_source_data_catalog:openalice_data_catalog_status:blocked',
        'goal_completion:paper_live_release_gate_profitability:reason_chain_can_promote_false',
      ]),
      metrics: {
        status: 'blocked',
        goalComplete: false,
        effectiveActionability: 'research_only_blocked',
        overallPlanCompletionPct: 49,
        goalChecklistCompletionPct: 55,
        requiredItems: 12,
        requiredBlocked: 7,
        requiredMissing: 0,
        dataCatalogStatus: 'blocked',
        dataCatalogComplete: 35,
        dataCatalogDatasets: 99,
        strategyDefectStatus: 'blocked',
        quantFrameworkStatus: 'blocked',
        ethCarryProspectiveStatus: 'has_closed_labels',
        aiScientistReadinessStatus: 'blocked_openalice_validation_missing',
        topBlockedItemId: 'multi_source_data_catalog',
        reasonChainPaperTradingAllowed: false,
        reasonChainLiveTradingAllowed: false,
        reasonChainCanPromote: false,
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'Allocator')?.metrics).toMatchObject({
      blockingReasonBuckets: {
        paper_gate: 1,
        promotion_release: 1,
        paper_quality: 0,
        p1_evidence_trust: 1,
        allocator_state: 3,
        config_disabled: 1,
        other: 0,
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'CP bridge')?.metrics).toMatchObject({
      mode: 'observation',
      signalCount: 5,
      positiveTargets: 0,
      zeroTargetSignalCount: 5,
      ticketIntentSignalCount: 0,
      modeTargetConsistency: 'consistent',
      ticketExecutionCapability: 'not_wired',
      paperExecutionAllowedByCpBridge: false,
      bridgeGeneratedAt: '2026-05-02T23:59:00.000Z',
      cpCycleId: '20260503-000000',
      cpTruthStatus: 'unknown',
      bridgeSource: 'currencypurchases',
      maxSignalAgeMs: 3600001,
      currentPayloadMaxAgeMs: 3600000,
      currentPayloadFreshSignalCount: 2,
      currentPayloadTtlExpiredSignalCount: 1,
      currentPayloadInvalidTimestampCount: 1,
      currentPayloadInvalidTtlCount: 1,
      ttlExpiredSignalCount: 1,
      latestTraceAgeMs: null,
      recentStaleAlerts: 1,
      latestRejectReasons: ['ttl_expired'],
    })
    expect(report.planCompletion.find(phase => phase.phase === 'P0')?.status).toBe('blocked')
    expect(report.planCompletion.find(phase => phase.phase === 'P0')?.items.find(item => item.id === 'P0-E')?.blockers).toEqual(
      expect.arrayContaining([
        'p1_cost_new_window_reason:awaiting_post_enforcement_closed_trades',
        'p1_open_position_readiness:blocked_new_missing_evidence',
        'p1_open_positions_missing_predicted_open_evidence:4',
        'p1_open_positions_legacy_missing_predicted_open_evidence:3',
        'p1_open_positions_new_missing_predicted_open_evidence:1',
        'p1_open_positions_producer_guard_missing_predicted_open_evidence:1',
        'p1_open_positions_new_missing_field:expected_gross_edge_pct:1',
        'p1_open_positions_new_missing_field:mark_match_penalty_bps:1',
      ]),
    )
    expect(report.planCompletion.find(phase => phase.phase === 'P1')?.items.find(item => item.id === 'P1-D')?.blockers).toEqual(
      expect.arrayContaining(['p1_stop_loss_cluster:42', 'p1_stop_loss_attribution_incomplete:0/42']),
    )
    expect(report.planCompletion.find(phase => phase.phase === 'P1')?.items.find(item => item.id === 'P1-A')?.blockers).toEqual(
      expect.arrayContaining(['trial_ledger_readiness:pit_proxy_only_trials:9']),
    )
    expect(report.planCompletion.find(phase => phase.phase === 'P1')?.items.find(item => item.id === 'P1-A')?.evidencePaths).toEqual(
      expect.arrayContaining(['data/runtime/p1_trading_evidence/trial_source_coverage.latest.json']),
    )
    expect(report.planCompletion.find(phase => phase.phase === 'P1')?.items.find(item => item.id === 'P1-A')?.nextActions[0]).toContain(
      'trial_source_coverage.latest.json',
    )
    expect(report.planCompletion.find(phase => phase.phase === 'P1')?.items.find(item => item.id === 'P1-B')).toMatchObject({
      status: 'blocked',
      blockers: expect.arrayContaining([
        'p1_gate_status:insufficient_data',
        'p1_gate_cost_coverage_patch_targets:2',
        'p1_gate_producer_guard_missing_cost_targets:1',
        'p1_gate_producer_guard_missing_complete_predicted_open_evidence:2',
      ]),
    })
    expect(report.planCompletion.find(phase => phase.phase === 'P1')?.items.find(item => item.id === 'P1-C')).toMatchObject({
      status: 'blocked',
      evidencePaths: expect.arrayContaining([
        'data/runtime/p1_trading_evidence/cost_model_diagnostics.latest.json',
        'data/runtime/route_cost_budget.latest.json',
      ]),
      blockers: expect.arrayContaining([
        'low_cost_prediction_sample',
        'route_cost_shadow_budget_status:exceeded',
        'route_cost_shadow_eligibility_diagnostic_only',
        'route_cost_budget_exceeded:taker_taker',
      ]),
    })
    expect(report.planCompletion.find(phase => phase.phase === 'P1.5')?.status).toBe('blocked')
    expect(report.planCompletion.find(phase => phase.phase === 'P1.5')?.items.find(item => item.id === 'P1.5-A')?.blockers).toEqual(
      expect.arrayContaining([
        'meta_labeling_status:blocked',
        'gate_status_not_useful:insufficient_data',
        'accepted_cost_coverage_below_minimum:0<95',
      ]),
    )
    expect(report.planCompletion.find(phase => phase.phase === 'P2')?.status).toBe('blocked')
    expect(report.planCompletion.find(phase => phase.phase === 'P2')?.items.find(item => item.id === 'P2-A')).toMatchObject({
      status: 'blocked',
      evidencePaths: expect.arrayContaining([
        'data/research/rank_ic_prospective_evidence_status.live_accumulated_fwd72_median_filter.latest.json',
      ]),
      blockers: expect.arrayContaining([
        'prospective_evidence_status:collecting',
        'prospective_evidence:research_only_not_execution_evidence',
        'prospective_evidence:prospective_closed_outcomes_low:0<100',
      ]),
    })
  })

  it('labels pre-producer-guard open evidence gaps as transitional dirty blockers', () => {
    const report = buildSystemStatusReasonChainReport({
      p1CostModelDiagnostics: {
        newWindow: {
          status: 'insufficient_data',
          reason: 'awaiting_post_enforcement_closed_trades',
          closedTrades: 0,
        },
        openPositionReadiness: {
          status: 'blocked_legacy_dirty_opens',
          totalOpenPositions: 3,
          legacyOpenPositions: 0,
          newOpenPositions: 3,
          producerGuardOpenPositions: 0,
          missingPredictedOpenEvidence: 3,
          legacyMissingPredictedOpenEvidence: 0,
          newMissingPredictedOpenEvidence: 3,
          transitionalDirtyMissingPredictedOpenEvidence: 3,
          producerGuardMissingPredictedOpenEvidence: 0,
          newMissingPredictedOpenEvidenceByField: [
            { field: 'expected_gross_edge_pct', missingPositions: 3 },
          ],
        },
      },
      generatedAt: '2026-05-04T00:00:00.000Z',
    })

    const p0e = report.planCompletion
      .find(phase => phase.phase === 'P0')
      ?.items.find(item => item.id === 'P0-E')
    expect(p0e?.blockers).toEqual(expect.arrayContaining([
      'p1_open_position_readiness:blocked_legacy_dirty_opens',
      'p1_open_positions_new_missing_predicted_open_evidence:3',
      'p1_open_positions_transitional_dirty_missing_predicted_open_evidence:3',
      'p1_open_positions_transitional_dirty_missing_field:expected_gross_edge_pct:3',
    ]))
    expect(p0e?.blockers).not.toContain('p1_open_positions_producer_guard_missing_predicted_open_evidence:3')
    expect(p0e?.nextActions.join('\n')).toContain('transitional dirty opens')
  })

  it('keeps allocator blocked unless production risk policy is a deny-only ready brake', () => {
    const cases = [
      {
        name: 'missing policy',
        productionRiskPolicy: undefined,
        expectedBlocker: 'production_risk_policy_missing',
      },
      {
        name: 'blocked policy',
        productionRiskPolicy: {
          status: 'blocked',
          mode: 'fail_closed_deny_only',
          paperExecutionAllowedByThisArtifact: false,
          liveExecutionAllowedByThisArtifact: false,
          blockers: ['source_evidence_not_trusted:quarantine'],
        },
        expectedBlocker: 'production_risk_policy_not_ready:blocked',
      },
      {
        name: 'quarantined source blocker',
        productionRiskPolicy: {
          status: 'ready_deny_only',
          mode: 'fail_closed_deny_only',
          paperExecutionAllowedByThisArtifact: false,
          liveExecutionAllowedByThisArtifact: false,
          blockers: ['source_evidence_not_trusted:quarantine'],
        },
        expectedBlocker: 'production_risk_policy:source_evidence_not_trusted:quarantine',
      },
      {
        name: 'invalid mode',
        productionRiskPolicy: {
          status: 'ready_deny_only',
          mode: 'authorize_and_trade',
          paperExecutionAllowedByThisArtifact: false,
          liveExecutionAllowedByThisArtifact: false,
          blockers: [],
        },
        expectedBlocker: 'production_risk_policy_mode_invalid:authorize_and_trade',
      },
      {
        name: 'paper authorization attempt',
        productionRiskPolicy: {
          status: 'ready_deny_only',
          mode: 'fail_closed_deny_only',
          paperExecutionAllowedByThisArtifact: true,
          liveExecutionAllowedByThisArtifact: false,
          blockers: [],
        },
        expectedBlocker: 'production_risk_policy_must_not_authorize_execution',
      },
      {
        name: 'live authorization attempt',
        productionRiskPolicy: {
          status: 'ready_deny_only',
          mode: 'fail_closed_deny_only',
          paperExecutionAllowedByThisArtifact: false,
          liveExecutionAllowedByThisArtifact: true,
          blockers: [],
        },
        expectedBlocker: 'production_risk_policy_must_not_authorize_execution',
      },
    ]

    for (const testCase of cases) {
      const report = buildSystemStatusReasonChainReport(buildAllocatorReadyFixture({
        productionRiskPolicy: testCase.productionRiskPolicy,
      }))
      const allocator = getAllocatorReason(report)

      expect(allocator, testCase.name).toMatchObject({
        status: 'blocked',
        usableForPromotion: false,
        usableForPaperExecution: false,
        blockingReasons: expect.arrayContaining([testCase.expectedBlocker]),
        metrics: {
          finalAllowPaperTrading: true,
          championLoaded: true,
          policyVersionMatch: true,
          paperExecutorEnabled: true,
          targetSymbolCount: 2,
          productionRiskPolicyReady: false,
        },
      })
    }
  })

  it('allows allocator availability only when the deny-only production risk brake is ready', () => {
    const report = buildSystemStatusReasonChainReport(buildAllocatorReadyFixture({
      productionRiskPolicy: {
        status: 'ready_deny_only',
        mode: 'fail_closed_deny_only',
        paperExecutionAllowedByThisArtifact: false,
        liveExecutionAllowedByThisArtifact: false,
        blockers: [],
        denyRuleCount: 1,
        cooldownRuleCount: 0,
        downweightRuleCount: 0,
        shadowOnlyRuleCount: 0,
      },
    }))
    const allocator = getAllocatorReason(report)

    expect(allocator).toMatchObject({
      status: 'available',
      usableForPromotion: true,
      usableForPaperExecution: true,
      blockingReasons: [],
      metrics: {
        finalAllowPaperTrading: true,
        championLoaded: true,
        policyVersionMatch: true,
        paperExecutorEnabled: true,
        targetSymbolCount: 2,
        productionRiskPolicyStatus: 'ready_deny_only',
        productionRiskPolicyMode: 'fail_closed_deny_only',
        productionRiskPolicyReady: true,
        paperExecutionAllowedByRiskPolicy: false,
        liveExecutionAllowedByRiskPolicy: false,
      },
    })
  })

  it('keeps CP bridge ticket intent blocked and reports mode/target mismatch diagnostics', () => {
    const sourceArtifacts = {
      strategyPromotion: 'strategy.json',
      releaseGateStatus: 'release.json',
      phaseReadiness: 'phase.json',
      paperGateStatus: 'paper_gate.json',
      paperExecutorStatus: 'executor.json',
      p1CostModelDiagnostics: 'cost.json',
      p1GateEffectiveness: 'gate.json',
      p1TrialLedger: 'ledger.json',
      p1TrialSourceCoverage: 'trial_source.json',
      routeCostBudget: 'route.json',
      feeSnapshot: 'fee.json',
      feeSnapshotRefresh: 'fee_refresh.json',
      liveDataFreshness: 'live_data.json',
      okxPublicConnectivityDiagnosis: 'okx_public_connectivity.json',
      okxPrivateAuthDiagnosis: 'okx_auth.json',
      productionRiskPolicy: 'production_risk_policy.json',
      researchIncubationPlan: 'research_incubation.json',
      researchLineRetirement: 'research_line_retirement.json',
      nextResearchHypothesisPlan: 'next_research.json',
      ethCarryResearchEvidenceStatus: 'eth_carry_research.json',
      ethCarryDataGapStatus: 'eth_carry_data_gap.json',
      ethCarryProspectiveEvidenceStatus: 'eth_carry_prospective.json',
      aiScientistCryptoCandidateIntake: 'ai_scientist_intake.json',
      aiScientistSecondValidationQueue: 'ai_scientist_queue.json',
      aiScientistCandidateSourceManifest: 'ai_scientist_source_manifest.json',
      aiScientistSecondValidationReadiness: 'ai_scientist_readiness.json',
      openAliceDataCatalog: 'openalice_data_catalog.json',
      openAliceDownloadMonitor: 'openalice_download_monitor.json',
      strategyDefectMonitor: 'strategy_defect_monitor.json',
      strategyDefectRegistry: 'strategy_defect_registry.json',
      quantFrameworkBenchmarkReport: 'quant_framework_benchmark.json',
      researchCandidateSummary: 'candidate_summary.json',
      cryptoFactorFamilyReport: 'crypto_factor.json',
      liquidityConditionedFactorReport: 'liquidity_factor.json',
      prospectiveEvidenceStatus: 'rank_ic_prospective.json',
      liquidityConditionedProspectiveEvidenceStatus: 'liquidity_prospective.json',
      metaLabelingShadowReadiness: 'meta.json',
      dirtyWorktreeAudit: 'dirty.json',
      runtimeManifestCoverage: 'manifest.json',
      externalDerivativesCollect: 'external.json',
      paperPolicyShadowSettle: 'settle.json',
      schedulerSecurityAudit: 'scheduler_security.json',
      goalCompletionAudit: 'goal_completion.json',
      cpTrace: 'trace.ndjson',
      cpBridge: 'cp.json',
      icRuntimeStatus: 'ic.json',
    }

    const ticket = buildSystemStatusReasonChainReport({
      generatedAt: '2026-05-04T00:00:00.000Z',
      cpBridge: {
        generated_at: '2026-05-04T00:00:00.000Z',
        mode: 'ticket',
        signals: [{
          signal_id: 'CP-TICKET',
          target_position_pct: 0.1,
          as_of: '2026-05-03T23:59:00.000Z',
          ttl_ms: 120000,
        }],
      },
      cpTraceLines: [],
      sourceArtifacts,
    })
    const ticketReason = ticket.reasonChain.find(reason => reason.component === 'CP bridge')
    expect(ticketReason).toMatchObject({
      status: 'blocked',
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'cp_bridge_mode:ticket',
        'cp_ticket_mode_execution_pipeline_pending',
      ]),
      metrics: {
        positiveTargets: 1,
        ticketIntentSignalCount: 1,
        modeTargetConsistency: 'consistent',
        ticketExecutionCapability: 'not_wired',
        paperExecutionAllowedByCpBridge: false,
        currentPayloadFreshSignalCount: 1,
      },
    })

    const mismatch = buildSystemStatusReasonChainReport({
      generatedAt: '2026-05-04T00:00:00.000Z',
      cpBridge: {
        generated_at: '2026-05-04T00:00:00.000Z',
        mode: 'observation',
        signals: [{
          signal_id: 'CP-MISMATCH',
          target_position_pct: 0.1,
          as_of: '2026-05-03T23:59:00.000Z',
          ttl_ms: 120000,
        }],
      },
      cpTraceLines: [],
      sourceArtifacts,
    })
    const mismatchReason = mismatch.reasonChain.find(reason => reason.component === 'CP bridge')
    expect(mismatchReason).toMatchObject({
      status: 'observation_only',
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'cp_bridge_mode:observation',
        'cp_bridge_mode_target_mismatch:observation_nonzero_target',
        'cp_ticket_mode_execution_pipeline_pending',
      ]),
      metrics: {
        positiveTargets: 1,
        ticketIntentSignalCount: 0,
        modeTargetConsistency: 'observation_nonzero_target',
        paperExecutionAllowedByCpBridge: false,
      },
    })
  })

  it('writes a status artifact and manifest', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'system-status-reason-chain-'))
    const p1Dir = join(runtimeDir, 'p1_trading_evidence')
    await mkdir(p1Dir, { recursive: true })
    await writeJson(join(runtimeDir, 'strategy_promotion.latest.json'), {
      researchGate: { hardBlocks: ['wfo_missing'] },
      paperGate: { hardBlocks: ['p1_gate_not_useful:insufficient_data'] },
    })
    await writeJson(join(runtimeDir, 'release_gate_status.json'), {
      allowPaperTrading: false,
      allowLiveTrading: false,
      failedChecks: ['wfo'],
      checks: [{ name: 'wfo', status: 'fail', summary: 'WFO failed', metrics: {} }],
    })
    await writeJson(join(runtimeDir, 'phase_readiness.latest.json'), {
      paper: { blockingReasons: ['paper_research_not_approved'] },
    })
    await writeJson(join(runtimeDir, 'paper_gate_status.json'), {
      finalAllowPaperTrading: false,
      championLoaded: false,
      policyVersionMatch: false,
      paperExecutorEnabled: false,
      blockingReasons: ['paper_research_not_approved'],
    })
    await writeJson(join(runtimeDir, 'paper_executor_status.latest.json'), {
      executionPlanKind: 'blocked',
      blockingReasons: ['release_gate_not_approved'],
      portfolioPlan: { targetSymbolCount: 0 },
    })
    await writeJson(join(runtimeDir, 'dirty_worktree_audit.latest.json'), { counts: { total: 1 } })
    await writeJson(join(runtimeDir, 'runtime_manifest_coverage.latest.json'), {
      status: 'blocked',
      blockingReasons: ['manifest_missing:paperExecutorStatus'],
    })
    await writeJson(join(runtimeDir, 'live_data_freshness.latest.json'), makeLiveDataFreshness())
    await writeJson(join(runtimeDir, 'okx_public_connectivity_diagnosis.latest.json'), makeOkxPublicConnectivityDiagnosis())
    await writeJson(join(runtimeDir, 'external_derivatives_data_collect.latest.json'), { dryRun: false, appendedRows: 1 })
    await writeJson(join(runtimeDir, 'paper_policy_shadow_settle.latest.json'), { counts: { appendedOutcomes: 0 } })
    await writeJson(join(runtimeDir, 'scheduler_security_audit.latest.json'), makeSchedulerSecurityAudit({
      status: 'fail',
      okxCredentialPresence: {
        apiKey: false,
        secret: false,
        password: false,
      },
    }))
    await writeJson(join(runtimeDir, 'openalice_goal_completion_audit.latest.json'), makeGoalCompletionAudit())
    await writeJson(join(p1Dir, 'cost_model_diagnostics.latest.json'), {
      quarantine: true,
      quarantineReasons: ['low_cost_prediction_sample'],
      newWindow: { status: 'insufficient_data', closedTrades: 0 },
    })
    await writeJson(join(p1Dir, 'gate_effectiveness_report.latest.json'), { gateStatus: 'insufficient_data' })
    await writeJson(join(p1Dir, 'trial_ledger.latest.json'), { status: 'skeleton' })
    await writeJson(join(runtimeDir, 'ic_monitor_status.latest.json'), {
      status: 'missing_snapshot',
      promotionEligible: false,
      sampleCountTotal: 0,
      returnCount: 0,
      factorCount: 0,
      minimumSampleCount: 50,
      warmupWindowsRequired: 3,
      warmupWindowsObserved: 0,
      blockingReasons: ['ic_monitor_snapshot_missing'],
      nextActions: ['Persist runtime icMonitorSnapshot from evaluateRuntimeFactorSnapshot into data/runtime/ic_monitor_snapshot.latest.json.'],
    })
    await writeJson(join(runtimeDir, 'okx_private_auth_diagnosis.latest.json'), makeOkxPrivateAuthDiagnosis())
    await writeJson(join(runtimeDir, 'fee_snapshot_refresh.latest.json'), makeRuntimeFeeSnapshotRefresh())
    await writeJson(join(runtimeDir, 'openalice_data_catalog.latest.json'), makeOpenAliceDataCatalog())
    await writeJson(join(runtimeDir, 'openalice_download_monitor.latest.json'), makeOpenAliceDownloadMonitor())
    await writeJson(join(runtimeDir, 'okx_route_cost_slippage_readiness.latest.json'), makeOkxRouteCostSlippageReadiness())
    const researchDir = join(runtimeDir, '..', 'research')
    await mkdir(researchDir, { recursive: true })
    await writeJson(join(researchDir, 'research_incubation_plan.latest.json'), makeResearchIncubationPlan())
    await writeJson(join(researchDir, 'research_line_retirement.latest.json'), makeResearchLineRetirement())
    await writeJson(join(researchDir, 'next_research_hypothesis_plan.latest.json'), makeNextResearchHypothesisPlan())
    await writeJson(join(researchDir, 'eth_carry_research_evidence_status.latest.json'), makeEthCarryResearchEvidenceStatus())
    await writeJson(join(researchDir, 'eth_carry_confluence_candidate_status.latest.json'), makeEthCarryConfluenceCandidateStatus())
    await writeJson(join(researchDir, 'eth_carry_confluence_validation.latest.json'), makeEthCarryConfluenceValidation())
    await writeJson(join(researchDir, 'eth_carry_confluence_trial_status.latest.json'), makeEthCarryConfluenceTrialStatus())
    await writeJson(join(researchDir, 'eth_carry_confluence_refinement_sweep.latest.json'), makeEthCarryConfluenceRefinementSweep())
    await writeJson(join(researchDir, 'eth_carry_data_gap_status.latest.json'), makeEthCarryDataGapStatus())
    await writeJson(join(runtimeDir, 'eth_carry_prospective_watchdog.latest.json'), makeEthCarryProspectiveWatchdog())
    await writeJson(join(researchDir, 'ai_scientist_crypto_candidate_intake.latest.json'), makeAiScientistCryptoCandidateIntake())
    await writeJson(join(researchDir, 'ai_scientist_openalice_second_validation_queue.latest.json'), makeAiScientistSecondValidationQueue())
    await writeJson(join(researchDir, 'ai_scientist_openalice_candidate_source_manifest.latest.json'), makeAiScientistCandidateSourceManifest())
    await writeJson(join(researchDir, 'ai_scientist_openalice_second_validation_readiness.latest.json'), makeAiScientistSecondValidationReadiness())
    await writeJson(join(researchDir, 'ai_scientist_openalice_pit_reproduction_plan.latest.json'), makeAiScientistPitReproductionPlan())
    await writeJson(join(researchDir, 'ai_scientist_openalice_pit_rebuild_queue.latest.json'), makeAiScientistPitRebuildQueue())
    await writeJson(join(researchDir, 'ai_scientist_openalice_ohlcv_daily_supplement_plan.latest.json'), makeAiScientistOhlcvDailySupplementPlan())
    await writeJson(join(researchDir, 'ai_scientist_openalice_ohlcv_native_rows.latest.json'), makeAiScientistOhlcvNativeRows())
    await writeJson(join(researchDir, 'ai_scientist_openalice_pit_native_rebuild_status.latest.json'), makeAiScientistPitNativeRebuildStatus())
    await writeJson(join(researchDir, 'ai_scientist_openalice_pit_input_dataset.latest.json'), makeAiScientistPitInputDataset())
    await writeJson(join(researchDir, 'ai_scientist_openalice_pit_contract_status.latest.json'), makeAiScientistPitContractStatus())
    await writeJson(join(researchDir, 'openalice_ohlcv_collector_pit_contract_status.latest.json'), makeOhlcvCollectorPitContractStatus())
    await writeJson(join(researchDir, 'strategy_defect_monitor.latest.json'), makeStrategyDefectMonitor())
    await writeJson(join(researchDir, 'strategy_defect_registry.latest.json'), makeStrategyDefectRegistry())
    await writeJson(join(researchDir, 'strategy_quality_gate_coverage.latest.json'), makeStrategyQualityGateCoverage())
    await writeJson(join(researchDir, 'quant_framework_benchmark_report.latest.json'), makeQuantFrameworkBenchmarkReport())
    await writeJson(join(researchDir, 'candidate_ranking.latest.json'), makeResearchCandidateSummary())
    await writeJson(join(researchDir, 'crypto_factor_family.live_accumulated.latest.json'), makeCryptoFactorFamilyReport())
    await writeJson(
      join(researchDir, 'rank_ic_prospective_evidence_status.live_accumulated_fwd72_median_filter.latest.json'),
      makeProspectiveEvidenceStatus(),
    )
    await writeJson(
      join(researchDir, 'liquidity_conditioned_prospective_evidence_status.live_accumulated.latest.json'),
      makeLiquidityConditionedProspectiveEvidenceStatus(),
    )
    const cpBridgePath = join(runtimeDir, 'openalice_signals.json')
    await writeJson(cpBridgePath, {
      mode: 'observation',
      signals: [{ target_position_pct: 0 }],
    })
    await writeFile(join(runtimeDir, 'cp_signal_trace.ndjson'), `${JSON.stringify({
      step: 'local_gate',
      status: 'reject',
      meta: { reason: 'ttl_expired' },
    })}\n`, 'utf-8')
    const outputPath = join(runtimeDir, 'system_status_reason_chain.latest.json')

    const report = await runSystemStatusReasonChain({
      runtimeDir,
      outputPath,
      cpBridgePath,
      json: true,
    })

    expect(report.declaredStatus).toBe('PAPER_ONLY')
    const persisted = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(persisted.reasonChain).toHaveLength(25)
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'Live data')).toMatchObject({
      status: 'available',
      usableForPaperExecution: false,
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'OKX public connectivity')).toMatchObject({
      status: 'blocked',
      usableForPaperExecution: false,
      metrics: {
        publicDataFetchable: false,
        failedErrorClasses: ['tls'],
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'OpenAlice data catalog')).toMatchObject({
      status: 'blocked',
      usableForPaperExecution: false,
      summary: 'OpenAlice data catalog is blocked: 30/97 dataset(s) complete; primary blocker=download_gap (51).',
      metrics: {
        datasets: 97,
        complete: 30,
        dataCatalogPrimaryBlockerCategory: 'download_gap',
        dataCatalogDownloadGapBlockers: 51,
        dataCatalogAiScientistValidationGateBlockers: 15,
        aiScientistCandidateDatasetStatus: 'partial',
        aiScientistCandidateCount: 1,
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'Research incubation')).toMatchObject({
      status: 'observation_only',
      usableForPaperExecution: false,
      metrics: {
        runtimeFeeSnapshotRefreshStatus: 'blocked',
        runtimeFeePerSymbolFees: 0,
        liquidityConditionedPivotCandidateId: 'liq_high_reversal_lb168_fwd72',
        prospectiveEvidenceStatus: 'collecting',
        prospectiveOpenEvents: 1,
        prospectiveClosedOutcomes: 0,
        liquidityConditionedProspectiveStatus: 'collecting',
        liquidityConditionedProspectiveOpenEvents: 1,
        liquidityConditionedProspectiveOpenDecisionWindows: 1,
        liquidityConditionedProspectiveClosedOutcomes: 0,
        liquidityConditionedProspectiveMeanOpenEventsPerDecisionWindow: 1,
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'Research line retirement')).toMatchObject({
      status: 'observation_only',
      usableForPaperExecution: false,
      metrics: {
        verdict: 'keep_incubating',
        lineHealth: 'incubating',
        primaryCandidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'Research next hypothesis')).toMatchObject({
      status: 'observation_only',
      usableForPaperExecution: false,
      metrics: {
        planStatus: 'ready_for_research_only_experiments',
        admittedFamilies: ['funding_carry_rebuild'],
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'ETH carry research')).toMatchObject({
      status: 'blocked',
      usableForPaperExecution: false,
      metrics: {
        profitabilityVerdict: 'cannot_claim_profitable',
        selectedCandidateId: 'carry_24h_z13',
        selectedNetExpectancyPct: -0.008,
        fundingAvailableTimeStatus: 'missing_explicit_available_time',
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'ETH carry confluence candidate')).toMatchObject({
      status: 'blocked',
      usableForPaperExecution: false,
      metrics: {
        recommendedCandidateId: 'eth_carry_confluence_filter_funding_positive_basis_positive_short_eth_long_btc',
        recommendedMeanNetPct: 0.145,
        validationStatus: 'research_validation_passed_observation_only',
        validationTradesBuilt: 150,
        trialStatus: 'research_trial_insufficient_evidence',
        trialSelectedQValue: 1,
        refinementStatus: 'research_refinement_insufficient_evidence',
        refinementBestQValue: 1,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'ETH carry prospective watchdog')).toMatchObject({
      status: 'observation_only',
      usableForPaperExecution: false,
      metrics: {
        status: 'watch_waiting_for_label',
        pendingOpenEvents: 1,
        dueOpenEventsWithoutClose: 0,
        closedOutcomes: 3,
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'AI-Scientist crypto intake')).toMatchObject({
      status: 'observation_only',
      usableForPaperExecution: false,
      metrics: {
        candidatesFound: 1,
        topCandidateId: 'ridge_multi_assets_h24_lb64',
        topOpenAlicePitAuditPassed: false,
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'AI-Scientist second-validation queue')).toMatchObject({
      status: 'observation_only',
      usableForPaperExecution: false,
      metrics: {
        pitReproductionPlanStatus: 'blocked_pit_contract_missing',
        pitReproductionCsvInputFiles: 6,
        pitReproductionCsvFilesWithAvailableAt: 0,
        ohlcvDailySupplementStatus: 'planned_research_only_daily_supplement',
        ohlcvDailySupplementEntries: 6,
        ohlcvDailySupplementLocal: 0,
        ohlcvDailySupplementNotChecked: 6,
        ohlcvNativeRowsStatus: 'research_rows_materialized_pit_blocked',
        ohlcvNativeRowsWritten: 1500,
        ohlcvNativeRowsPromotionGradeRows: 0,
        pitNativeRebuildStatus: 'blocked_native_lineage_not_ready',
        pitNativeRebuildAutoEligibleTasks: 0,
        pitNativeRebuildCollectorUpgradeTasks: 6,
        pitInputDatasetStatus: 'research_dataset_ready_pit_blocked',
        pitInputRowsNormalized: 500,
        pitInputPromotionGradeRows: 0,
        pitContractStatus: 'blocked_pit_contract_missing',
        pitContractRowsScanned: 500,
        pitContractRowExplicitAvailableAt: 0,
        pitContractRowExplicitObservedOrFetchedAt: 0,
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'OHLCV collector PIT contract')).toMatchObject({
      status: 'observation_only',
      usableForPaperExecution: false,
      usableForPromotion: false,
      metrics: {
        status: 'ready_for_pit_audit_research_only',
        rowsScanned: 300,
        rowExplicitAvailableAt: 300,
        rowExplicitObservedOrFetchedAt: 300,
        rowsPromotionGrade: 0,
      },
      blockingReasons: expect.arrayContaining([
        'ohlcv_collector_pit:collector_rows_not_promotion_grade',
        'ohlcv_collector_pit_research_only_not_trading_authority',
      ]),
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'Strategy defect monitor')).toMatchObject({
      status: 'blocked',
      usableForPaperExecution: false,
      metrics: {
        blocked: 7,
        p0Blocked: 3,
        registryDefects: 47,
        registryP0OpenOrPartial: 13,
        topBlockedId: 'carry_pit_basis_economics',
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'Strategy quality gate coverage')).toMatchObject({
      status: 'blocked',
      usableForPaperExecution: false,
      metrics: {
        p0p1OpenOrPartial: 28,
        p0p1OpenOrPartialUncovered: 19,
        blockedRepairQueues: 6,
        topUncoveredDefectId: '2.8',
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'Quant framework benchmark')).toMatchObject({
      status: 'blocked',
      usableForPaperExecution: false,
      metrics: {
        frameworks: 6,
        capabilities: 10,
        blockedCapabilities: 2,
        p0RelatedOpenOrPartialDefects: 2,
        topBlockedCapabilityId: 'order_book_matching',
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'Liquidity-conditioned prospective')).toMatchObject({
      status: 'observation_only',
      usableForPaperExecution: false,
      metrics: {
        openEvents: 1,
        openDecisionWindows: 1,
        meanOpenEventsPerDecisionWindow: 1,
        notesContainCorrelationWarning: true,
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'Crypto factor family')).toMatchObject({
      status: 'not_available',
      usableForPaperExecution: false,
      metrics: {
        bestCandidateId: 'factor_reversal_lb168_fwd72',
        bestWfoStatus: 'fail',
        bestWfoFailedWindowRatio: 0.6,
        runtimeFeeSnapshotRefreshStatus: 'blocked',
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'Scheduler security')).toMatchObject({
      status: 'blocked',
      blockingReasons: expect.arrayContaining([
        'scheduler_security:runtime_fee_auth_tick_okx_credentials',
      ]),
      metrics: {
        runtimeFeeAuthOkxCredentialPresence: {
          apiKey: false,
          secret: false,
          password: false,
        },
      },
    })
    expect(persisted.reasonChain.find((reason: { component: string }) => reason.component === 'Goal completion audit')).toMatchObject({
      status: 'blocked',
      usableForPaperExecution: false,
      metrics: {
        goalComplete: false,
        goalChecklistCompletionPct: 55,
        requiredBlocked: 7,
        dataCatalogStatus: 'blocked',
        strategyDefectStatus: 'blocked',
        quantFrameworkStatus: 'blocked',
        reasonChainCanPromote: false,
      },
    })
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'system_status_reason_chain',
      exitCode: 0,
      businessStatus: 'warn',
      recordsIn: 25,
    })
  })

  it('surfaces decayed IC factor/symbol counts without changing fail-closed status', () => {
    const report = buildSystemStatusReasonChainReport({
      generatedAt: '2026-05-03T00:00:00.000Z',
      releaseGateStatus: {
        checks: [{ name: 'wfo', status: 'pass', metrics: { overallPassed: true, failedWindows: 0, windowCount: 3 } }],
      },
      paperGateStatus: {
        finalAllowPaperTrading: false,
        championLoaded: false,
        policyVersionMatch: false,
        paperExecutorEnabled: false,
      },
      paperExecutorStatus: {
        executionPlanKind: 'blocked',
        portfolioPlan: { targetSymbolCount: 0 },
      },
      icMonitorStatus: {
        status: 'decayed',
        promotionEligible: false,
        sampleCountTotal: 2895,
        returnCount: 579,
        factorCount: 5,
        minimumSampleCount: 50,
        warmupWindowsRequired: 3,
        warmupWindowsObserved: 579,
        blockingReasons: [
          'symbol:BTC-USDT:factor:momentum-composite:ic_decay_status:decayed',
          'symbol:ETH-USDT:factor:momentum-composite:ic_decay_status:decayed',
          'symbol:ETH-USDT:factor:mean-reversion:ic_decay_status:decayed',
        ],
      },
      okxPrivateAuthDiagnosis: makeOkxPrivateAuthDiagnosis(),
      researchIncubationPlan: makeResearchIncubationPlan(),
      liquidityConditionedProspectiveEvidenceStatus: makeLiquidityConditionedProspectiveEvidenceStatus(),
      cpBridge: {
        mode: 'observation',
        signals: [],
      },
      cpTraceLines: [],
    })

    expect(report.reasonChain.find(reason => reason.component === 'IC')).toMatchObject({
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      metrics: {
        sampleThresholdPassed: true,
        warmupThresholdPassed: true,
        decayedFactorCount: 2,
        decayedSymbolCount: 2,
        decayedPairCount: 3,
        decayedSymbols: ['BTC-USDT', 'ETH-USDT'],
        decayedFactors: ['mean-reversion', 'momentum-composite'],
      },
    })
  })

  it('keeps external derivatives collection partial when the latest collector has network errors', () => {
    const report = buildSystemStatusReasonChainReport({
      generatedAt: '2026-05-06T20:10:00.000Z',
      externalDerivativesCollect: {
        dryRun: false,
        appendedRows: 12,
        errorSummary: {
          tls: 10,
        },
      },
      sourceArtifacts: {
        externalDerivativesCollect: 'data/runtime/external_derivatives_data_collect.latest.json',
      },
    })

    const item = report.planCompletion
      .find(phase => phase.phase === 'P0')
      ?.items.find(candidate => candidate.id === 'P0-C')

    expect(item).toMatchObject({
      status: 'partial',
      completionPct: 70,
      blockers: [
        'external_derivatives_collect_error:tls:10',
      ],
      nextActions: [
        'Fix external derivatives collector network/proxy errors before treating funding/carry data refresh as healthy.',
      ],
    })
  })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function buildAllocatorReadyFixture(overrides: { productionRiskPolicy?: unknown }) {
  return {
    generatedAt: '2026-05-04T00:00:00.000Z',
    releaseGateStatus: {
      checks: [{ name: 'wfo', status: 'pass', metrics: { overallPassed: true, failedWindows: 0, windowCount: 3 } }],
    },
    paperGateStatus: {
      finalAllowPaperTrading: true,
      championLoaded: true,
      policyVersionMatch: true,
      paperExecutorEnabled: true,
      blockingReasons: [],
    },
    phaseReadiness: {
      paper: {
        blockingReasons: [],
      },
    },
    paperExecutorStatus: {
      executionPlanKind: 'rebalance',
      blockingReasons: [],
      portfolioPlan: {
        targetSymbolCount: 2,
        rebalanceEntryCount: 2,
        walletOperationCount: 0,
      },
    },
    productionRiskPolicy: overrides.productionRiskPolicy,
    icMonitorStatus: {
      status: 'ready',
      promotionEligible: true,
      sampleCountTotal: 120,
      returnCount: 120,
      factorCount: 2,
      minimumSampleCount: 50,
      warmupWindowsRequired: 3,
      warmupWindowsObserved: 3,
      blockingReasons: [],
    },
    cpBridge: {
      mode: 'observation',
      signals: [],
    },
    cpTraceLines: [],
  }
}

function getAllocatorReason(report: ReturnType<typeof buildSystemStatusReasonChainReport>) {
  const allocator = report.reasonChain.find(reason => reason.component === 'Allocator')
  expect(allocator).toBeDefined()
  return allocator!
}

function makeLiveDataFreshness() {
  return {
    status: 'fresh',
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    summary: {
      expectedAssets: 78,
      presentAssets: 78,
      freshAssets: 78,
      enoughRowsAssets: 78,
      oneHourCommonPeriods: 1001,
      oneHourCommonLatestDatetime: '2026-05-05T01:00:00.000Z',
      oneHourIncubationCommonPeriodsReady: true,
      publicDataUsableForLiveOnlyResearch: true,
    },
    directories: [
      {
        timeframe: '1h',
        status: 'fresh',
        presentAssets: 34,
        expectedAssets: 34,
        freshAssets: 34,
        commonPeriods: 1001,
        commonLatestDatetime: '2026-05-05T01:00:00.000Z',
        incubationCommonPeriodsReady: true,
      },
      {
        timeframe: '5m',
        status: 'fresh',
        presentAssets: 34,
        expectedAssets: 34,
        freshAssets: 34,
        commonPeriods: 1001,
        commonLatestDatetime: '2026-05-05T01:55:00.000Z',
      },
      {
        timeframe: '1s',
        status: 'fresh',
        presentAssets: 10,
        expectedAssets: 10,
        freshAssets: 10,
        commonPeriods: 300,
        commonLatestDatetime: '2026-05-05T01:59:59.000Z',
      },
    ],
    blockers: [],
    globalNextActions: [
      'Keep OKX public market-data accumulation running; this path does not depend on private account credentials.',
    ],
  }
}

function makeOkxPublicConnectivityDiagnosis() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-06T09:30:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status: 'blocked',
    publicDataFetchable: false,
    timeoutMs: 8000,
    proxy: {
      configured: true,
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: '7890',
      hasUsername: false,
      hasPassword: false,
    },
    hosts: [
      'https://www.okx.com',
      'https://aws.okx.com',
    ],
    attempts: [
      {
        baseUrl: 'https://www.okx.com',
        hostname: 'www.okx.com',
        ok: false,
        httpStatus: null,
        okxCode: null,
        latencyMs: 120,
        serverTime: null,
        errorClass: 'tls',
        errorMessage: 'Client network socket disconnected before secure TLS connection was established',
      },
      {
        baseUrl: 'https://aws.okx.com',
        hostname: 'aws.okx.com',
        ok: false,
        httpStatus: null,
        okxCode: null,
        latencyMs: 130,
        serverTime: null,
        errorClass: 'tls',
        errorMessage: 'Client network socket disconnected before secure TLS connection was established',
      },
    ],
    blockers: [
      'okx_public_connectivity_all_hosts_failed',
      'okx_public_host_failed:www.okx.com:tls',
      'okx_public_host_failed:aws.okx.com:tls',
    ],
    nextActions: [
      'Check local proxy reachability and OKX domain access, then rerun data:okx-public:diagnose.',
    ],
    safetyNotes: [
      'This artifact probes public OKX endpoints only; it does not use or print API keys, secrets, or passphrases.',
    ],
  }
}

function makeResearchIncubationPlan() {
  return {
    planStatus: 'active_incubation',
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    lineDecision: {
      lineHealth: 'incubate',
      killTriggers: [],
    },
    routeCostDiagnosticsFound: 5,
    incubationCandidatesFound: 1,
    candidates: [{
      candidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
      route: 'passive_passive',
      metrics: {
        netAfterRouteCostPct: 11.376377,
        grossToPairCostRatio: 32.601047,
        signalPeriods: 3,
        commonPeriods: 413,
        wfoStatus: 'insufficient_data',
      },
      feeSnapshot: {
        source: 'manual_override',
        verifiedByRuntime: false,
      },
      promotionRequirements: [
        {
          code: 'live_only_signal_periods',
          status: 'blocked',
          blocker: 'rank_ic_signal_periods_low:3<30',
        },
        {
          code: 'runtime_fee_snapshot',
          status: 'blocked',
          blocker: 'fee_snapshot_not_runtime_verified',
        },
        {
          code: 'route_cost_adjusted_net',
          status: 'pass',
          blocker: null,
        },
      ],
    }],
    globalNextActions: [
      'Continue live-only data accumulation without placing paper or live orders from this artifact.',
      'Fix OKX/runtime fee snapshot credentials, then rerun route-cost validation.',
    ],
  }
}

function makeResearchLineRetirement() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:01:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    policyMutationAllowed: false,
    verdict: 'keep_incubating',
    lineHealth: 'incubating',
    summary: {
      activeIncubationCandidates: 1,
      rejectedDiagnostics: 0,
      wfoKilledDiagnostics: 0,
      diagnosticLinesReviewed: 1,
      retirementRecommendedLines: 0,
      openProspectiveEvents: 2,
      closedProspectiveEvents: 0,
      earliestNextLabelDueTime: '2026-05-08T03:00:00.000Z',
    },
    primaryLine: {
      lineId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0_5',
      sourcePath: 'data/research/research_incubation_plan.latest.json',
      candidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
      family: 'reversal',
      strategy: 'passive_passive',
      status: 'active',
      netAfterRouteCostPct: 11.376377,
      wfoStatus: 'insufficient_data',
      wfoWindowCount: null,
      wfoFailedWindowRatio: null,
      wfoFailWindowRatioThreshold: null,
      wfoDirectionStable: null,
      runtimeFeeVerified: false,
      killTriggers: [],
      blockers: [],
    },
    retiredLines: [],
    watchLines: [],
    blockers: ['no_retirement_recommendation'],
    requiredBeforeReactivation: [
      'new_alpha_hypothesis_or_materially_different_feature_set',
      'wfo_failed_window_ratio_lte_threshold_and_direction_stable',
    ],
    nextActions: [
      'Keep incubating rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5 in live-only observation mode.',
    ],
  }
}

function makeNextResearchHypothesisPlan() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:02:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    policyMutationAllowed: false,
    planStatus: 'ready_for_research_only_experiments',
    forbiddenContinuations: [
      {
        lineId: 'rank_ic_signal_confidence_best_lb120_sec336_fwd72_mtf0_5',
        reason: 'primary:wfo_failed_window_ratio:0.8>0.3|primary:wfo_direction_not_stable',
        allowedOnlyIf: ['new_alpha_hypothesis_or_materially_different_feature_set'],
      },
    ],
    experimentCards: [
      {
        experimentId: 'funding_carry_rebuild_next_research',
        familyId: 'funding_carry_rebuild',
        priority: 'high',
        decision: 'admit_research_only',
        paperTradingAllowed: false,
        liveTradingAllowed: false,
      },
      {
        experimentId: 'liquidation_aftermath_oi_confirmation_next_research',
        familyId: 'liquidation_aftermath_oi_confirmation',
        priority: 'high',
        decision: 'watch_only',
        paperTradingAllowed: false,
        liveTradingAllowed: false,
      },
      {
        experimentId: 'kronos_forecast_shadow_next_research',
        familyId: 'kronos_forecast_shadow',
        priority: 'medium',
        decision: 'watch_only',
        paperTradingAllowed: false,
        liveTradingAllowed: false,
      },
    ],
    blockers: ['retired_line_parameter_search_forbidden'],
    nextActions: [
      'Use this plan to choose the next research-only experiment; do not run broad random search on retired RankIC/liquidity reversal diagnostics.',
    ],
  }
}

function makeEthCarryResearchEvidenceStatus() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:03:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status: 'research_only_blocked',
    profitabilityVerdict: 'cannot_claim_profitable',
    selectedCandidate: {
      role: 'control',
      candidateId: 'carry_24h_z13',
      metrics: {
        totalReturnPct: -0.0959,
        netExpectancyPct: -0.008,
        tradeCount: 12,
        sharpe: -4.4,
      },
      wfo: {
        overallPassed: false,
        failedWindows: 3,
        windowCount: 3,
        failedWindowRatio: 1,
      },
      significance: {
        passed: false,
        pbo: 0.6,
        dsrProbability: 0.0037,
      },
      riskSimulation: {
        gatePassed: false,
        profitProbability: 0.035,
      },
      releaseGate: {
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ['wfo', 'significance', 'risk_simulation', 'economics'],
      },
    },
    bestObservedCandidate: {
      role: 'short_bias_shadow',
      candidateId: 'carry_short_bias_core',
      metrics: {
        netExpectancyPct: -0.00058,
      },
    },
    pitEvidence: {
      fundingExplicitAvailableTimeCoveragePct: 0,
      fundingAvailableTimeStatus: 'missing_explicit_available_time',
      basisAvailableTimeStatus: 'missing_basis_feature',
      pointInTimeUsableForPromotion: false,
    },
    costEvidence: {
      runtimeFeeStatus: 'runtime_verified',
      runtimeFeePerSymbolFees: 3,
      okxPrivateAuthStatus: 'auth_available',
    },
    basisEvidence: {
      available: false,
    },
    validationSummary: {
      paperExecutionSlippageAvailable: false,
      trialLedgerStatus: 'fail',
      fdrQ: null,
    },
    prospectiveEvidence: {
      status: 'collecting',
      openEvents: 1,
      closedOutcomes: 0,
      closedDecisionWindows: 0,
      minClosedOutcomes: 100,
      minNonOverlappingWindows: 3,
      latestOpenObservationId: 'obs-1',
      latestOpenDecisionTime: '2026-05-06T01:00:00.000Z',
      latestOpenLabelDueTime: '2026-05-06T09:00:00.000Z',
      blockers: [
        'research_only_not_execution_evidence',
        'paper_live_execution_disabled',
        'prospective_closed_outcomes_low:0<100',
      ],
    },
    nextResearchAlignment: {
      planStatus: 'ready_for_research_only_experiments',
      admittedFundingCarry: true,
      admittedExperimentId: 'funding_carry_rebuild_next_research',
    },
    blockers: [
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'release_gate_failed:wfo',
      'release_gate_failed:significance',
      'release_gate_failed:risk_simulation',
      'release_gate_failed:economics',
      'net_expectancy_non_positive:-0.008',
      'best_observed_net_expectancy_non_positive:-0.00058',
      'wfo_not_passed',
      'wfo_failed_window_ratio:1>0.3',
      'significance_not_passed:pbo=0.6',
      'risk_simulation_not_passed:profitProbability=0.035<0.55',
      'funding_available_time_missing:ETH:0/200',
      'funding_available_time_missing:BTC:0/200',
      'basis_spread_feature_missing',
      'paper_execution_slippage_telemetry_unavailable',
      'trial_ledger_not_pass:fail',
      'by_fdr_missing',
    ],
    killCriteriaTriggered: [
      'net_carry_after_stressed_unwind_cost<=0',
      'funding_or_basis_available_time_missing',
    ],
    nextActions: [
      'Keep ETH carry in research-only mode; do not publish non-flat paper targets from this evidence.',
    ],
  }
}

function makeEthCarryConfluenceCandidateStatus() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-08T03:00:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'research_candidate_insufficient_evidence',
    signalDiagnostics: {
      status: 'insufficient_closed_outcomes',
      closedDiagnosticRows: 26,
      meanNetPct: -0.401,
      winRateNetPct: 15,
      strongestPositiveBucket: 'confluence:funding_positive:basis_positive:direction_short_eth_long_btc',
      strongestNegativeBucket: 'confluence:funding_negative:basis_negative:direction_long_eth_short_btc',
    },
    recommendedCandidate: {
      candidateId: 'eth_carry_confluence_filter_funding_positive_basis_positive_short_eth_long_btc',
      familyId: 'funding_carry_rebuild',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      sourceBucketId: 'confluence:funding_positive:basis_positive:direction_short_eth_long_btc',
      rule: {
        fundingSpreadSign: 'positive',
        basisSpreadDiffPctSign: 'positive',
        direction: 'short_eth_long_btc',
      },
      evidence: {
        closedOutcomes: 4,
        winRatePct: 75,
        meanNetPct: 0.145,
      },
    },
    avoidListCandidate: {
      candidateId: 'eth_carry_confluence_avoid_funding_negative_basis_negative_long_eth_short_btc',
      sourceBucketId: 'confluence:funding_negative:basis_negative:direction_long_eth_short_btc',
      evidence: {
        closedOutcomes: 8,
        meanNetPct: -0.622,
      },
    },
    blockers: [
      'prospective_closed_outcomes_low:26<100',
      'confluence_bucket_closed_outcomes_low:4<30',
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'wfo_fdr_pit_route_cost_prospective_paper_gates_required',
    ],
    nextActions: [
      'Keep this confluence candidate research-only and do not publish paper/live targets from it.',
    ],
  }
}

function makeEthCarryConfluenceValidation() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-08T03:06:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'research_validation_passed_observation_only',
    counts: {
      featureRowsLoaded: 500,
      featureRowsAfterRule: 160,
      tradesBuilt: 150,
      skippedNoDecisionCandle: 0,
      skippedNoCloseCandle: 10,
      skippedFundingCashflowUnavailable: 0,
    },
    summary: {
      meanGrossPct: 0.238,
      meanFundingCashflowPct: 0,
      meanNetPct: 0.038,
      winRatePct: 65,
      tradeCount: 150,
      passedWindows: 3,
      failedWindows: 0,
    },
    blockers: [
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'requires_independent_wfo_by_fdr_route_cost_risk_and_paper_telemetry',
    ],
  }
}

function makeEthCarryConfluenceTrialStatus() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-08T03:35:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'research_trial_insufficient_evidence',
    selectedCandidate: {
      candidateId: 'eth_carry_confluence_filter_funding_positive_basis_positive_short_eth_long_btc',
      sourceBucketId: 'confluence:funding_positive:basis_positive:direction_short_eth_long_btc',
    },
    trialLedger: {
      rawM: 4,
      rawMComplete: true,
      includesFailedTrials: true,
      fdrMethodPrimary: 'BY_raw_m',
      pValuePromotionGrade: false,
      entries: [
        {
          trialId: 'eth_carry_confluence_trial_confluence_funding_positive_basis_positive_direction_short_eth_long_btc',
          sourceBucketId: 'confluence:funding_positive:basis_positive:direction_short_eth_long_btc',
          role: 'selected',
          closedOutcomes: 4,
          wins: 3,
          winRatePct: 75,
          meanNetPct: 0.145,
          pValue: 0.3125,
          pAdjustedBYRawM: 1,
          fdrPassed: false,
          pValuePromotionGrade: false,
          blockers: ['p_value_not_promotion_grade'],
        },
        {
          trialId: 'eth_carry_confluence_trial_confluence_funding_negative_basis_negative_direction_long_eth_short_btc',
          sourceBucketId: 'confluence:funding_negative:basis_negative:direction_long_eth_short_btc',
          role: 'avoid',
          closedOutcomes: 8,
          wins: 0,
          winRatePct: 0,
          meanNetPct: -0.622,
          pValue: 1,
          pAdjustedBYRawM: 1,
          fdrPassed: false,
          pValuePromotionGrade: false,
          blockers: ['mean_net_not_positive:-0.622', 'win_rate_not_above_half:0', 'p_value_not_promotion_grade'],
        },
        {
          trialId: 'eth_carry_confluence_trial_confluence_funding_positive_basis_negative_direction_short_eth_long_btc',
          sourceBucketId: 'confluence:funding_positive:basis_negative:direction_short_eth_long_btc',
          role: 'avoid',
          closedOutcomes: 7,
          wins: 0,
          winRatePct: 0,
          meanNetPct: -0.522,
          pValue: 1,
          pAdjustedBYRawM: 1,
          fdrPassed: false,
          pValuePromotionGrade: false,
          blockers: ['mean_net_not_positive:-0.522', 'win_rate_not_above_half:0', 'p_value_not_promotion_grade'],
        },
        {
          trialId: 'eth_carry_confluence_trial_confluence_funding_negative_basis_positive_direction_long_eth_short_btc',
          sourceBucketId: 'confluence:funding_negative:basis_positive:direction_long_eth_short_btc',
          role: 'avoid',
          closedOutcomes: 7,
          wins: 1,
          winRatePct: 14.2857142857,
          meanNetPct: -0.341,
          pValue: 1,
          pAdjustedBYRawM: 1,
          fdrPassed: false,
          pValuePromotionGrade: false,
          blockers: ['mean_net_not_positive:-0.341', 'win_rate_not_above_half:14.2857142857', 'p_value_not_promotion_grade'],
        },
      ],
    },
    fdr: {
      status: 'computed_research_only',
      method: 'BY_raw_m',
      alpha: 0.1,
      selectedPValue: 0.3125,
      selectedQValue: 1,
      selectedPassed: false,
      harmonicFactorCm: 2.0833333333,
      blocker: null,
    },
    wfo: {
      status: 'pass_research_only',
      passedWindows: 3,
      failedWindows: 0,
      windowCount: 3,
      failedWindowRatio: 0,
    },
    riskSimulation: {
      status: 'pass_research_only',
      profitProbability: 0.65,
      lossTailProbability: 0.35,
    },
    evidenceCounts: {
      totalClosedOutcomes: 26,
      selectedBucketClosedOutcomes: 4,
      validationTrades: 150,
      validationWindows: 3,
    },
    blockers: [
      'trial_total_closed_outcomes_low:26<100',
      'selected_bucket_closed_outcomes_low:4<30',
      'by_fdr_q_not_passed:1>0.1',
      'p_values_research_only_not_promotion_grade',
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
    ],
  }
}

function makeEthCarryConfluenceRefinementSweep() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-08T04:00:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'research_refinement_insufficient_evidence',
    evidenceCounts: {
      openEvents: 42,
      closedOutcomes: 26,
      matchedClosedRows: 26,
      variantsTested: 4,
    },
    trialLedger: {
      rawM: 4,
      rawMComplete: true,
      includesFailedTrials: true,
      fdrMethodPrimary: 'BY_raw_m',
      pValuePromotionGrade: false,
    },
    bestVariant: {
      variantId: 'eth_carry_confluence_refine_funding_abs_gte_0_00005_basis_abs_gte_0_02',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      rule: {
        fundingSpreadSign: 'positive',
        basisSpreadDiffPctSign: 'positive',
        direction: 'short_eth_long_btc',
        minAbsFundingSpread: 0.00005,
        minAbsBasisSpreadDiffPct: 0.02,
      },
      closedOutcomes: 4,
      wins: 3,
      losses: 1,
      winRatePct: 75,
      meanNetPct: 0.145,
      pValue: 0.3125,
      pAdjustedBYRawM: 1,
      fdrPassed: false,
      wfo: {
        status: 'pass_research_only',
        passedWindows: 3,
        failedWindows: 0,
        windowCount: 3,
        failedWindowRatio: 0,
      },
      blockers: ['p_value_not_promotion_grade'],
    },
    fdr: {
      status: 'computed_research_only',
      method: 'BY_raw_m',
      alpha: 0.1,
      bestVariantQValue: 1,
      bestVariantFdrPassed: false,
      harmonicFactorCm: 2.0833333333,
      blocker: null,
    },
    blockers: [
      'prospective_closed_outcomes_low:26<100',
      'best_variant_closed_outcomes_low:4<30',
      'by_fdr_q_not_passed:1>0.1',
      'p_values_research_only_not_promotion_grade',
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
    ],
  }
}

function makeEthCarryDataGapStatus() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-06T20:20:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'blocked_insufficient_research_data',
    thresholds: {
      minCarryFeatureRows: 100,
      minProspectiveClosedOutcomes: 100,
      minClosedDecisionWindows: 3,
      maxCollectorErrorCount: 0,
    },
    counts: {
      sourceEvents: 259,
      fundingEvents: 22,
      basisSnapshots: 29,
      carryFeatureRows: 14,
      sourceLineageIncompleteRows: 25,
      prospectiveOpenEvents: 3,
      prospectiveClosedEvents: 3,
      prospectiveClosedOutcomes: 3,
      prospectiveClosedDecisionWindows: 3,
      collectorErrorCount: 10,
    },
    collectorStatus: {
      stale: false,
      dryRun: false,
      proxyConfigured: true,
      errorSummary: {
        tls: 10,
      },
    },
    dataVisionArchives: [
      { datasetId: 'binance-public:um:fundingRate:usdt', status: 'missing', zipFiles: 0, partFiles: 0 },
      { datasetId: 'binance-public:um:markPriceKlines:1h:usdt', status: 'missing', zipFiles: 0, partFiles: 0 },
      { datasetId: 'binance-public:um:indexPriceKlines:1h:usdt', status: 'missing', zipFiles: 0, partFiles: 0 },
      { datasetId: 'binance-public:um:premiumIndexKlines:1h:usdt', status: 'missing', zipFiles: 0, partFiles: 0 },
    ],
    blockers: [
      'carry_feature_rows_low:14<100',
      'source_lineage_incomplete_rows:25',
      'prospective_closed_outcomes_low:3<100',
      'external_derivatives_collect_errors:tls:10',
      'data_vision_archive_missing:binance-public:um:fundingRate:usdt',
    ],
    nextActions: [
      'Download or rebuild fundingRate plus 1h mark/index/premium Data Vision archives as research-only inputs before WFO or promotion claims.',
    ],
  }
}

function makeEthCarryProspectiveWatchdog() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-07T01:10:39.122Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'watch_waiting_for_label',
    artifacts: {
      prospectiveEvidence: {
        closedOutcomes: 3,
        pendingOpenEvents: 1,
        dueOpenEventsWithoutClose: 0,
        latestOpenLabelDueTime: '2026-05-07T08:45:00.000Z',
      },
    },
    ledger: {
      openEvents: 4,
      closedEvents: 3,
      pendingOpenEvents: 1,
      dueOpenEventsWithoutClose: 0,
      duplicateOpenObservationIds: 0,
      latestOpenObservationId: '62d257507c189cd4d70b2eee',
      latestOpenDecisionTime: '2026-05-07T00:45:00.000Z',
      latestOpenLabelDueTime: '2026-05-07T08:45:00.000Z',
      nextLabelDueTime: '2026-05-07T08:45:00.000Z',
    },
    readiness: {
      okxFresh: true,
      pitReady: true,
      pitAuditPass: true,
      captureHealthy: true,
      settleHealthy: true,
      hasPendingOpen: true,
      hasDueUnsettled: false,
      candleDataCanSettleNextDue: false,
    },
    candleWatermark: {
      ethLatest: '2026-05-07T01:10:00.000Z',
      btcLatest: '2026-05-07T01:05:00.000Z',
      minLatest: '2026-05-07T01:05:00.000Z',
    },
    blockers: [],
    evidenceBlockers: [
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'not_promotion_grade_wfo_validated',
      'not_trial_ledger_fdr_validated',
      'not_paper_execution_evidence',
      'prospective_closed_outcomes_low:3<100',
    ],
    nextActions: [
      'Continue future-only capture/settle until closed outcomes reach 3/100.',
      'Keep all ETH carry prospective artifacts research-only until release gates pass.',
    ],
  }
}

function makeOkxRouteCostSlippageReadiness() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-07T01:35:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'blocked',
    orderbook: {
      exists: true,
      status: 'complete',
      generatedAt: '2026-05-07T01:29:45.125Z',
      stale: false,
      rowsBuilt: 3,
      blockedRows: 0,
      maxSpreadBps: 1.13218228,
      medianSpreadBps: 0.04291265,
      minDepth5Usd: 726318.2985,
      requiredOrderbookSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      requiredOrderbookPassedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      requiredOrderbookBlockedSymbols: [],
      requiredOrderbookMissingSymbols: [],
      requiredOrderbookAllPass: true,
      blockers: [],
    },
    feeSnapshot: {
      exists: true,
      source: 'api',
      verifiedByRuntime: true,
      sourceFetchedAt: '2026-05-07T00:11:17.396Z',
      expiresAt: '2026-05-08T00:11:17.396Z',
      stale: false,
      makerFeeBps: 2,
      takerFeeBps: 5,
    },
    routeCostBudget: {
      exists: true,
      generatedAt: '2026-05-05T04:33:45.490Z',
      stale: true,
      feeSnapshotSource: 'manual_override',
      feeSnapshotVerifiedByRuntime: false,
      feeSnapshotExpiresAt: '2026-05-06T04:33:45.490Z',
      feeSnapshotMatchesRuntimeFeeSnapshot: false,
      routeCount: 4,
      routesOverBudget: ['passive_taker', 'taker_taker', 'twap'],
      selectedSafeResearchRoute: 'passive_passive',
    },
    executionQuality: {
      exists: true,
      generatedAt: '2026-05-05T04:33:45.490Z',
      recentOrderCount: 11,
      slippageViolationCount: 0,
      actualToSimulatedCostRatio: 1,
      missedFillRate: 0,
      telemetrySufficient: false,
    },
    paperCostEvidence: {
      exists: true,
      closedTrades: 947,
      tradesWithAnyPredictedCost: 2,
      tradesWithCompletePredictedOpenEvidence: 0,
      completePredictedOpenEvidenceCoveragePct: 0,
      tradesWithAnyRealizedCost: 0,
      tradesWithFillAdjustedCost: 0,
      tradesWithExchangeReconciledCostEvidence: 0,
      status: 'partial',
    },
    readiness: {
      publicOrderbookUsableForResearch: true,
      runtimeFeeSnapshotUsableForResearch: true,
      routeCostBudgetRuntimeVerified: false,
      routeCostBudgetFresh: false,
      paperExecutionTelemetryAvailable: false,
      promotionGradeRouteCostEvidence: false,
    },
    blockers: [
      'route_cost_budget_stale',
      'route_cost_budget_fee_snapshot_source_not_api:manual_override',
      'route_cost_budget_fee_snapshot_mismatch',
      'paper_execution_quality_orders_low:11<20',
      'paper_execution_slippage_telemetry_unavailable',
      'paper_predicted_cost_coverage_low:0<95',
      'paper_exchange_reconciled_cost_evidence_missing',
      'route_cost_slippage_readiness_diagnostic_only',
    ],
    nextActions: [
      'Run research:okx:runtime-route-cost-budget so route_cost_budget embeds the latest runtime-verified fee snapshot without publishing a promotion bundle.',
      'Add per-decision/per-paper-trade spread, slippage, fill-adjusted cost, and exchange-reconciled cost telemetry before any promotion claim.',
    ],
  }
}

function makeResearchCandidateSummary() {
  const liquidityCandidate = {
    sourceKind: 'liquidity_conditioned_factor',
    candidateId: 'liq_high_reversal_lb168_fwd72',
    strategy: 'high_reversal',
    whyNotTradable: [
      'best_candidate_not_promising:incubate_observation',
      'best_wfo_fail',
      'research_only_not_execution_evidence',
      'route_cost_manual_not_runtime_verified',
      'runtime_fee_not_verified',
    ],
    metrics: {
      netAfterRouteCostPct: 2.59443,
      rankIcWfoStatus: 'fail',
      rankIcWfoFailedWindowRatio: 0.6,
      signalPeriods: 959,
      commonPeriods: 1200,
    },
  }
  return {
    candidateRowsFound: 400,
    topCandidates: [],
    bestByTier: [{
      evidenceTier: 'diagnostic_validation',
      candidate: liquidityCandidate,
    }],
    focusRecommendations: [
      'Liquidity-conditioned pivot candidate: liq_high_reversal_lb168_fwd72; netAfterRouteCostPct=2.5944, WFO=fail, failedWindowRatio=0.6.',
    ],
  }
}

function makeCryptoFactorFamilyReport() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T08:25:12.413Z',
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    dataDir: 'data/market/live_accumulated',
    symbolsRequested: ['BTC-USDT', 'ETH-USDT'],
    symbolsLoaded: ['BTC-USDT', 'ETH-USDT'],
    commonPeriods: 1200,
    dataCadence: {
      barMinutes: 60,
      promotionTimeframe: '1h_required',
      nonHourlyDiagnosticOnly: false,
      lookbackUnit: 'hours',
    },
    hypothesis: {
      id: 'crypto_base_factor_family_v1',
      literatureAnchors: [
        'Liu, Tsyvinski, Wu: Common Risk Factors in Cryptocurrency',
      ],
    },
    routeCost: {
      source: 'manual_diagnostic_override',
      runtimeVerified: false,
      pairRoundTripCostPct: 0.36,
    },
    configsEvaluated: 96,
    best: {
      candidateId: 'factor_reversal_lb168_fwd72',
      factor: 'reversal',
      lookbackHours: 168,
      forwardHours: 72,
      lookbackBars: 168,
      forwardBars: 72,
      observations: 32606,
      periods: 959,
      signalPeriods: 959,
      meanIc: 0.021854,
      icIr: 0.090211,
      winRate: 0.517205,
      passedIc: false,
      averageLongShortSpreadPct: 0.597095,
      longShortWinRate: 0.535975,
      routeCostPct: 0.36,
      netAfterRouteCostPct: 0.237095,
      wfo: {
        status: 'fail',
        windowCount: 5,
        passedWindows: 2,
        failedWindows: 3,
        failedWindowRatio: 0.6,
        failWindowRatioThreshold: 0.3,
        directionStable: false,
        windows: [],
        blockers: [
          'wfo_failed_window_ratio:0.6>0.3',
          'wfo_direction_or_net_not_stable',
        ],
      },
      candidateVerdict: 'incubate_observation',
      blockers: [
        'ic_thresholds_not_passed',
        'wfo_fail',
        'wfo_failed_window_ratio:0.6>0.3',
        'wfo_direction_or_net_not_stable',
        'route_cost_manual_not_runtime_verified',
        'not_trial_ledger_fdr_validated',
        'not_paper_execution_evidence',
      ],
    },
    bestByFactor: [],
    topConfigs: [],
    blockers: [
      'best_candidate_not_promising:incubate_observation',
      'best_wfo_fail',
      'runtime_fee_not_verified',
    ],
    nextActions: [
      'Keep this as a research-only base factor diagnostic until WFO and prospective gates pass.',
    ],
    notes: [
      'This artifact cannot authorize paper or live orders.',
    ],
  }
}

function makeProspectiveEvidenceStatus() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:00:00.000Z',
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status: 'collecting',
    counts: {
      openEvents: 1,
      closedEvents: 0,
      uniqueOpenObservationIds: 1,
      duplicateOpenObservationIds: 0,
      pendingOpenEvents: 1,
      dueOpenEventsWithoutClose: 0,
      closedMatchedToOpen: 0,
      closedWithoutOpen: 0,
      openDecisionWindows: 1,
      closedDecisionWindows: 0,
    },
    metrics: {
      closedOutcomes: 0,
      meanGrossLongShortSpreadPct: null,
      medianGrossLongShortSpreadPct: null,
      winRatePct: null,
      positiveGrossOutcomes: 0,
      negativeGrossOutcomes: 0,
      bestGrossLongShortSpreadPct: null,
      worstGrossLongShortSpreadPct: null,
      meanOpenEventsPerDecisionWindow: 1,
    },
    thresholds: {
      minClosedOutcomes: 100,
      minNonOverlappingWindows: 3,
      requireRuntimeVerifiedFees: true,
      requireRouteCostAdjustedLabels: true,
      requirePromotionGradeWfo: true,
      requireCompleteTrialLedger: true,
      requireByFdr: true,
      requirePitAudit: true,
    },
    latestOpen: {
      observationId: '7d00b1ad75af618bc172fd47',
      decisionTime: '2026-05-05T03:00:00.000Z',
      labelDueTime: '2026-05-08T03:00:00.000Z',
      signalPair: 'WLD-USDT/DOGE-USDT',
    },
    blockers: [
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'not_promotion_grade_wfo_validated',
      'not_trial_ledger_fdr_validated',
      'not_pit_audit_validated',
      'not_paper_execution_evidence',
      'prospective_closed_outcomes_low:0<100',
      'prospective_closed_windows_low:0<3',
      'prospective_route_cost_adjusted_labels_missing',
      'runtime_fee_not_verified',
    ],
    notes: [
      'This status summarizes prospective research labels only; it cannot authorize paper or live orders.',
      'Multiple observations with the same decisionBarTime are correlated and count as one decision window for promotion-style evidence.',
    ],
  }
}

function makeLiquidityConditionedProspectiveEvidenceStatus() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:00:00.000Z',
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status: 'collecting',
    counts: {
      openEvents: 1,
      closedEvents: 0,
      uniqueOpenObservationIds: 1,
      duplicateOpenObservationIds: 0,
      pendingOpenEvents: 1,
      dueOpenEventsWithoutClose: 0,
      closedMatchedToOpen: 0,
      closedWithoutOpen: 0,
      openDecisionWindows: 1,
      closedDecisionWindows: 0,
    },
    metrics: {
      closedOutcomes: 0,
      meanGrossLongShortSpreadPct: null,
      medianGrossLongShortSpreadPct: null,
      winRatePct: null,
      positiveGrossOutcomes: 0,
      negativeGrossOutcomes: 0,
      bestGrossLongShortSpreadPct: null,
      worstGrossLongShortSpreadPct: null,
      meanOpenEventsPerDecisionWindow: 1,
    },
    thresholds: {
      minClosedOutcomes: 100,
      minNonOverlappingWindows: 3,
      requireRuntimeVerifiedFees: true,
      requireRouteCostAdjustedLabels: true,
      requirePromotionGradeWfo: true,
      requireCompleteTrialLedger: true,
      requireByFdr: true,
      requirePitAudit: true,
    },
    latestOpen: {
      observationId: 'liq-obs-1',
      decisionTime: '2026-05-05T03:00:00.000Z',
      labelDueTime: '2026-05-08T03:00:00.000Z',
      signalPair: 'AAA-USDT/BBB-USDT',
    },
    blockers: [
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'not_promotion_grade_wfo_validated',
      'not_trial_ledger_fdr_validated',
      'not_pit_audit_validated',
      'not_paper_execution_evidence',
      'prospective_closed_outcomes_low:0<100',
      'prospective_closed_windows_low:0<3',
      'prospective_route_cost_adjusted_labels_missing',
      'runtime_fee_not_verified',
    ],
    notes: [
      'This status summarizes prospective research labels only; it cannot authorize paper or live orders.',
      'Multiple observations with the same decisionBarTime are correlated and count as one decision window for promotion-style evidence.',
    ],
  }
}

function makeAiScientistCryptoCandidateIntake() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:30:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status: 'research_only_blocked',
    aiScientistRoot: '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl',
    warehouseRoot: '/Volumes/shield/cryptoData/openalice-data',
    externalDataWarehouse: {
      status: 'present_with_required_dirs',
      rootExists: true,
      requiredDirs: [],
      recentLogFiles: [],
      blockers: [],
      nextActions: [],
    },
    counts: {
      runDirsScanned: 12,
      sourceFilesScanned: 38,
      candidatesFound: 1,
      runsWithTargetProof: 8,
      runsWithFinalHoldout: 2,
      runsWithWalkForward: 1,
      runsWithFundingFeatures: 1,
      safetyViolations: 0,
      targetReached: 0,
    },
    candidates: [{
      rank: 1,
      runId: 'run_auto_improve_funding_regime_real',
      runDir: '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl/run_auto_improve_funding_regime_real',
      family: 'funding_regime',
      candidateId: 'ridge_multi_assets_h24_lb64',
      sourceFiles: ['target_proof.json', 'improvement_summary.json', 'walk_forward_evaluation.json', 'data_manifest.json'],
      evidence: {
        targetProofStatus: 'not_proven',
        improvementStatus: 'not_reached',
        proofStatus: 'not_proven',
        targetReached: false,
        finalHoldoutPresent: false,
        walkForwardPresent: true,
        dataManifestPresent: true,
        riskReportPresent: true,
      },
      metrics: {
        validationDirectionalAccuracy: 0.5222465353756383,
        validationHighConfidencePrecision: 0.6545454545454545,
        validationHighConfidenceCoverage: 0.05032822757111598,
        meanFinalHoldoutDirectionalAccuracy: 0.6493679308050565,
        foldPassRate: 0,
        foldsCompleted: 3,
        foldsRequested: 3,
        netTotalReturn: 0.33839985582484045,
        sharpeProxy: 1.1618273294621428,
      },
      pitAndData: {
        holdoutNotUsedForSelection: true,
        chronologicalOrEmbargoSplit: true,
        leakageControlsPresent: true,
        fundingFeatureActive: true,
        fundingAvailableTimePolicy: 'raw funding timestamp is treated as available only after that timestamp',
        fundingJoinPolicy: 'merge_asof_backward_allow_exact_matches_false',
        selectedFileCount: 2,
        symbolCount: 2,
        syntheticSource: false,
        openAlicePitAuditPassed: false,
      },
      safety: {
        researchOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        safetyViolation: false,
      },
      openAliceIntakeDecision: 'research_only_second_validation_required',
      blockers: [
        'ai_scientist_candidate_not_execution_authority',
        'openalice_second_validation_required',
        'openalice_pit_audit_missing',
      ],
      nextActions: [],
    }],
    blockers: [
      'ai_scientist_intake_research_only',
      'openalice_second_validation_required_before_incubation',
    ],
    nextActions: [
      'Keep AI-Scientist runs as research candidates only.',
    ],
    safetyNotes: [
      'This artifact cannot authorize paper or live orders.',
    ],
  }
}

function makeAiScientistSecondValidationQueue() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:35:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'queued_research_only',
    sourceArtifacts: {
      intake: 'data/research/ai_scientist_crypto_candidate_intake.latest.json',
    },
    counts: {
      intakeCandidates: 1,
      queuedCandidates: 1,
      blockedSafetyViolations: 0,
      requiredGateCount: 11,
      candidateSuppliedUnverifiedGateCount: 3,
      missingGateCount: 8,
    },
    queue: [{
      queueRank: 1,
      queueStatus: 'queued_research_only',
      executionAllowed: false,
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      runId: 'run_auto_improve_funding_regime_real',
      runDir: '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl/run_auto_improve_funding_regime_real',
      family: 'funding_regime',
      candidateId: 'ridge_multi_assets_h24_lb64',
      intakeRank: 1,
      sourceFiles: ['walk_forward_evaluation.json', 'data_manifest.json'],
      sourceArtifactPaths: [
        '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl/run_auto_improve_funding_regime_real/walk_forward_evaluation.json',
        '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl/run_auto_improve_funding_regime_real/data_manifest.json',
      ],
      inheritedMetrics: {
        foldPassRate: 0,
      },
      inheritedBlockers: [
        'openalice_second_validation_required',
        'openalice_pit_audit_missing',
      ],
      requiredValidationGates: [
        { id: 'locked_source_manifest', required: true, currentStatus: 'candidate_supplied_unverified', blockers: ['openalice_locked_source_manifest_missing'], evidencePaths: [] },
        { id: 'pit_audit', required: true, currentStatus: 'candidate_supplied_unverified', blockers: ['openalice_pit_audit_missing'], evidencePaths: [] },
        { id: 'wfo', required: true, currentStatus: 'candidate_supplied_unverified', blockers: ['openalice_wfo_missing'], evidencePaths: [] },
        { id: 'fdr_by', required: true, currentStatus: 'missing', blockers: ['openalice_by_fdr_missing'], evidencePaths: [] },
        { id: 'route_cost', required: true, currentStatus: 'missing', blockers: ['openalice_route_cost_validation_missing'], evidencePaths: [] },
        { id: 'slippage_stress', required: true, currentStatus: 'missing', blockers: ['openalice_slippage_stress_missing'], evidencePaths: [] },
        { id: 'risk_simulation', required: true, currentStatus: 'missing', blockers: ['openalice_risk_simulation_missing'], evidencePaths: [] },
        { id: 'trial_ledger', required: true, currentStatus: 'missing', blockers: ['openalice_trial_ledger_missing'], evidencePaths: [] },
        { id: 'prospective_evidence', required: true, currentStatus: 'missing', blockers: ['openalice_prospective_evidence_missing'], evidencePaths: [] },
        { id: 'paper_telemetry', required: true, currentStatus: 'missing', blockers: ['paper_execution_telemetry_missing'], evidencePaths: [] },
        { id: 'final_holdout', required: true, currentStatus: 'missing', blockers: ['openalice_final_holdout_missing'], evidencePaths: [] },
      ],
      blockers: [
        'openalice_second_validation_required',
        'openalice_pit_audit_missing',
        'openalice_second_validation_queued_not_completed',
        'candidate_not_execution_authority',
      ],
      nextActions: [],
    }],
    blockers: [
      'openalice_second_validation_queued_not_completed',
      'ai_scientist_queue_research_only',
      'paper_execution_telemetry_missing',
    ],
    nextActions: [
      'Reproduce queued AI-Scientist candidates inside OpenAlice.',
    ],
    safetyNotes: [
      'This queue cannot authorize paper or live orders.',
    ],
  }
}

function makeAiScientistCandidateSourceManifest() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:36:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'locked_research_only',
    sourceArtifacts: {
      queue: 'data/research/ai_scientist_openalice_second_validation_queue.latest.json',
    },
    queueGeneratedAt: '2026-05-05T06:35:00.000Z',
    counts: {
      queuedCandidates: 1,
      candidatesLocked: 1,
      candidatesWithMissingFiles: 0,
      sourceFilesExpected: 2,
      sourceFilesPresent: 2,
      sourceFilesMissing: 0,
      totalBytes: 1234,
    },
    candidates: [{
      queueRank: 1,
      runId: 'run_auto_improve_funding_regime_real',
      runDir: '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl/run_auto_improve_funding_regime_real',
      family: 'funding_regime',
      candidateId: 'ridge_multi_assets_h24_lb64',
      status: 'locked',
      files: [{
        relativePath: 'walk_forward_evaluation.json',
        path: '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl/run_auto_improve_funding_regime_real/walk_forward_evaluation.json',
        exists: true,
        sizeBytes: 1000,
        mtimeMs: 1770000000000,
        sha256: 'a'.repeat(64),
        blocker: null,
      }],
      fileCount: 1,
      presentFileCount: 1,
      missingFileCount: 0,
      totalBytes: 1000,
      candidateManifestHash: 'b'.repeat(64),
      blockers: [],
    }],
    blockers: [
      'source_manifest_research_only',
      'openalice_second_validation_still_required',
    ],
    nextActions: [
      'Use this manifest as the locked source input.',
    ],
    safetyNotes: [
      'This manifest cannot authorize paper or live orders.',
    ],
  }
}

function makeAiScientistSecondValidationReadiness() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:37:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'blocked_openalice_validation_missing',
    sourceArtifacts: {
      queue: 'data/research/ai_scientist_openalice_second_validation_queue.latest.json',
      sourceManifest: 'data/research/ai_scientist_openalice_candidate_source_manifest.latest.json',
    },
    counts: {
      queuedCandidates: 1,
      candidatesReadyForOpenAliceReproduction: 1,
      totalGates: 11,
      candidateSuppliedUnverifiedGates: 2,
      readyForReproductionGates: 1,
      missingOpenAliceEvidenceGates: 8,
      blockedGates: 0,
    },
    candidates: [{
      queueRank: 1,
      runId: 'run_auto_improve_funding_regime_real',
      family: 'funding_regime',
      candidateId: 'ridge_multi_assets_h24_lb64',
      researchOnly: true,
      executionAllowed: false,
      sourceManifestStatus: 'locked',
      sourceFilesPresent: 2,
      sourceFilesMissing: 0,
      gates: [
        { id: 'locked_source_manifest', status: 'ready_for_reproduction', required: true, blockers: [], evidencePaths: [], nextAction: 'Use locked source manifest.' },
        { id: 'wfo', status: 'candidate_supplied_unverified', required: true, blockers: ['openalice_wfo_missing'], evidencePaths: [], nextAction: 'Reproduce WFO.' },
      ],
      readyForOpenAliceReproduction: true,
      openAliceValidationComplete: false,
      missingOpenAliceGateCount: 8,
      nextGateId: 'wfo',
      blockers: [
        'openalice_wfo_missing',
        'openalice_second_validation_not_complete',
      ],
    }],
    blockers: [
      'openalice_second_validation_readiness_research_only',
      'openalice_validation_gates_not_complete',
    ],
    nextActions: [
      'Start OpenAlice-native reproduction.',
    ],
    safetyNotes: [
      'This readiness matrix cannot authorize paper or live orders.',
    ],
  }
}

function makeAiScientistPitReproductionPlan() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:38:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'blocked_pit_contract_missing',
    sourceArtifacts: {
      queue: 'data/research/ai_scientist_openalice_second_validation_queue.latest.json',
      sourceManifest: 'data/research/ai_scientist_openalice_candidate_source_manifest.latest.json',
      readiness: 'data/research/ai_scientist_openalice_second_validation_readiness.latest.json',
      dataCatalog: 'data/runtime/openalice_data_catalog.latest.json',
    },
    counts: {
      queuedCandidates: 1,
      candidatesPlanned: 1,
      candidatesReadyForOpenAlicePitReproduction: 0,
      inputFiles: 6,
      csvInputFiles: 6,
      csvFilesWithExplicitAvailableAt: 0,
      csvFilesWithObservedOrFetchedAt: 0,
      missingInputFiles: 0,
      foldManifestsFound: 1,
      foldManifestsWithAvailableTimePolicy: 1,
      openAliceWarehouseLinkedInputs: 0,
    },
    candidates: [{
      queueRank: 1,
      runId: 'run_auto_improve_funding_regime_real',
      runDir: '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl/run_auto_improve_funding_regime_real',
      family: 'funding_regime',
      candidateId: 'ridge_multi_assets_h24_lb64',
      pitAuditStatus: 'blocked',
      openAlicePitAuditPassed: false,
      proofStatus: 'not_proven',
      inputFiles: [{
        relativePath: 'data/BTC_USDT_USDT_1h.csv',
        path: '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl/data/BTC_USDT_USDT_1h.csv',
        kind: 'csv',
        exists: true,
        sizeBytes: 1000,
        columns: ['timestamp', 'datetime', 'open', 'high', 'low', 'close', 'volume', 'symbol'],
        hasEventTime: true,
        hasObservedAt: false,
        hasFetchedAt: false,
        hasAvailableAt: false,
        explicitAvailableAt: false,
        eventTimePolicy: 'source timestamp/datetime is treated as eventTime only',
        availableTimePolicy: 'blocked: no explicit availableAt column',
        warehouseLinkStatus: 'not_openalice_warehouse_path',
        matchingCatalogDatasetIds: [],
        blockers: [
          'csv_available_time_missing:data/BTC_USDT_USDT_1h.csv',
          'openalice_warehouse_link_missing:data/BTC_USDT_USDT_1h.csv:not_openalice_warehouse_path',
        ],
      }],
      blockers: [
        'csv_available_time_missing:data/BTC_USDT_USDT_1h.csv',
        'openalice_warehouse_link_missing:data/BTC_USDT_USDT_1h.csv:not_openalice_warehouse_path',
      ],
      nextActions: [
        'Rebuild selected feature files inside OpenAlice.',
      ],
    }],
    blockers: [
      'run_auto_improve_funding_regime_real:csv_available_time_missing:data/BTC_USDT_USDT_1h.csv',
      'run_auto_improve_funding_regime_real:openalice_warehouse_link_missing:data/BTC_USDT_USDT_1h.csv:not_openalice_warehouse_path',
      'ai_scientist_pit_plan_research_only',
      'openalice_pit_audit_still_required',
    ],
    nextActions: [
      'Materialize OpenAlice-native PIT feature inputs.',
    ],
    safetyNotes: [
      'This plan cannot authorize paper or live orders.',
    ],
  }
}

function makeAiScientistPitRebuildQueue() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:38:30.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'blocked_waiting_for_openalice_native_rebuild',
    sourceArtifacts: {
      pitPlan: 'data/research/ai_scientist_openalice_pit_reproduction_plan.latest.json',
    },
    counts: {
      pitCandidatesRead: 1,
      inputFilesRead: 6,
      csvInputFilesRead: 6,
      rebuildTasks: 6,
      openTasks: 6,
      missingEventTimeTasks: 0,
      missingAvailableAtTasks: 6,
      missingObservedOrFetchedAtTasks: 6,
      incompleteWarehouseLineageTasks: 6,
      completeWarehouseLineageInputs: 0,
      uniqueSymbols: 6,
      uniqueTimeframes: 1,
    },
    tasks: [{
      taskId: 'pit_rebuild.run_auto_improve_funding_regime_real.ridge_multi_assets_h24_lb64.abcdef123456',
      status: 'open',
      priority: 'P0',
      runId: 'run_auto_improve_funding_regime_real',
      candidateId: 'ridge_multi_assets_h24_lb64',
      family: 'funding_regime',
      symbol: 'BTC/USDT:USDT',
      timeframe: '1h',
      sourceRelativePath: 'data/BTC_USDT_USDT_1h.csv',
      missingFields: ['availableAt', 'observedAt_or_fetchedAt', 'completeOpenAliceWarehouseLineage'],
      requiredOutputContract: {
        requiredRowFields: ['eventTime', 'observedAt_or_fetchedAt', 'availableAt'],
        forbiddenShortcuts: ['source_file_mtime_recovered', 'derived_bar_close_time_as_promotion_grade_availableAt'],
      },
      blockers: ['missing_availableAt'],
      nextActions: ['Create OpenAlice-native PIT rows.'],
    }],
    blockers: [
      'ai_scientist_pit_rebuild_tasks_open:6',
      'ai_scientist_pit_available_at_rebuild_required:6',
      'ai_scientist_pit_observed_or_fetched_at_rebuild_required:6',
      'ai_scientist_pit_complete_warehouse_lineage_required:6',
      'ai_scientist_pit_rebuild_queue_research_only',
    ],
    nextActions: [
      'Rebuild open tasks from OpenAlice-native collectors or warehouse manifests.',
    ],
    safetyNotes: [
      'This queue cannot authorize paper or live orders.',
    ],
  }
}

function makeAiScientistPitNativeRebuildStatus() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-06T15:40:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'blocked_native_lineage_not_ready',
    counts: {
      rebuildTasksRead: 6,
      assessedTasks: 6,
      ohlcvKlineTasks: 6,
      derivativesFeatureTasks: 0,
      autoRebuildEligibleTasks: 0,
      requiredCollectorUpgradeTasks: 6,
      rawKlineManifestTasks: 6,
      rawKlineManifestPresentTasks: 6,
      rawKlineManifestWithCollectorTimesTasks: 0,
      rawKlineManifestWithPromotionGradeTimeFieldsTasks: 0,
      rawKlineSummaryWithBatchWindowTasks: 6,
      derivativesPitRowsAvailableTasks: 0,
      derivativesPitUsableTasks: 0,
    },
    blockers: [
      'ai_scientist_pit_native_rebuild_tasks_not_auto_eligible:0/6',
      'ai_scientist_pit_ohlcv_collector_upgrade_required:6',
      'ai_scientist_pit_raw_kline_manifest_lacks_promotion_grade_times:0/6',
      'ai_scientist_pit_native_rebuild_status_research_only',
    ],
    nextActions: [
      'Upgrade OHLCV collectors or normalization jobs to emit row-explicit PIT lineage.',
    ],
    safetyNotes: [
      'This status cannot authorize paper or live orders.',
    ],
  }
}

function makeAiScientistOhlcvDailySupplementPlan() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-06T18:55:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'planned_research_only_daily_supplement',
    counts: {
      taskPlansRead: 6,
      tasksWithMissingMonthlyArchive: 6,
      uniqueSupplementEntries: 6,
      localExists: 0,
      downloaded: 0,
      remoteAvailable: 0,
      remoteMissing: 0,
      failed: 0,
      notChecked: 6,
      manifestRowsWritten: 6,
      distinctSymbols: 6,
      distinctDays: 1,
    },
    blockers: [
      'daily_supplement_probe_not_run',
      'daily_supplement_not_checked:6',
      'daily_supplement_local_incomplete:0/6',
      'daily_supplement_research_only',
      'daily_supplement_not_promotion_grade',
    ],
    nextActions: [
      'Run with --probe true to verify Binance Data Vision daily zip availability for current-month gaps.',
    ],
    safetyNotes: [
      'This daily supplement cannot authorize paper or live orders.',
    ],
  }
}

function makeAiScientistOhlcvNativeRows() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-06T17:05:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'research_rows_materialized_pit_blocked',
    counts: {
      planTasksRead: 6,
      materializationCandidateTasks: 3,
      tasksMaterialized: 3,
      tasksSkipped: 3,
      zipFilesRead: 6,
      rowsRead: 2000,
      rowsWritten: 1500,
      promotionGradeRows: 0,
      distinctSymbols: 3,
    },
    blockers: [
      'ohlcv_native_rows_not_promotion_grade',
      'ohlcv_native_rows_research_only',
      'row_pit_usable_for_promotion_false',
    ],
    nextActions: [
      'Use these rows only for research reproduction and contract plumbing.',
    ],
    safetyNotes: [
      'This materializer report cannot authorize paper or live orders.',
    ],
  }
}

function makeAiScientistPitInputDataset() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:39:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'research_dataset_ready_pit_blocked',
    sourceArtifacts: {
      pitPlan: 'data/research/ai_scientist_openalice_pit_reproduction_plan.latest.json',
    },
    outputPath: '/Volumes/shield/cryptoData/openalice-data/parquet/research/ai_scientist/openalice_pit_inputs.sample.normalized.jsonl',
    jobId: 'ai_scientist_pit_input.20260505T063900',
    sampling: {
      maxCandidates: 1,
      maxRowsPerFile: 500,
      sampled: true,
    },
    counts: {
      candidatesRead: 1,
      inputFilesRead: 1,
      csvFilesRead: 1,
      rowsRead: 500,
      rowsNormalized: 500,
      rowsDropped: 0,
      promotionGradeRows: 0,
      distinctSymbols: 1,
    },
    candidates: [{
      runId: 'run_auto_improve_funding_regime_real',
      candidateId: 'ridge_multi_assets_h24_lb64',
      family: 'funding_regime',
      files: 1,
      rowsNormalized: 500,
    }],
    symbols: ['BTC/USDT:USDT'],
    observedStartTime: '2024-01-01T00:00:00.000Z',
    observedEndTime: '2024-01-21T19:00:00.000Z',
    blockers: [
      'pit_input_dataset_research_only',
      'pit_input_observed_at_recovered_from_file_mtime_not_row_explicit',
      'pit_input_available_at_derived_from_bar_close_not_exchange_observed',
      'pit_input_not_promotion_grade',
    ],
    nextActions: [
      'Use this dataset only for OpenAlice reproduction plumbing and feature-contract tests, not promotion.',
    ],
    safetyNotes: [
      'This dataset cannot authorize paper orders, live orders, promotion, leverage changes, or best_config mutations.',
    ],
    outputHash: 'c'.repeat(64),
  }
}

function makeAiScientistPitContractStatus() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:40:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'blocked_pit_contract_missing',
    sourceArtifacts: {
      datasetReport: 'data/research/ai_scientist_openalice_pit_input_dataset.latest.json',
      inputDataset: '/Volumes/shield/cryptoData/openalice-data/parquet/research/ai_scientist/openalice_pit_inputs.sample.normalized.jsonl',
    },
    counts: {
      datasetRowsReported: 500,
      rowsScanned: 500,
      rowParseErrors: 0,
      rowsWithEventTime: 500,
      rowsWithAvailableAt: 500,
      rowsWithRowExplicitAvailableAt: 0,
      rowsWithObservedAt: 500,
      rowsWithFetchedAt: 500,
      rowsWithRowExplicitObservedOrFetchedAt: 0,
      rowsPromotionGrade: 0,
      rowsWithQualityBlockers: 500,
      distinctSymbols: 1,
    },
    coverage: {
      eventTimePct: 100,
      availableAtPct: 100,
      rowExplicitAvailableAtPct: 0,
      observedOrFetchedAtPct: 100,
      rowExplicitObservedOrFetchedAtPct: 0,
      promotionGradePct: 0,
    },
    symbols: ['BTC/USDT:USDT'],
    blockers: [
      'ai_scientist_pit_contract_research_only',
      'promotion_grade_rows_missing:0/500',
      'quality_blockers_present:500/500',
      'row_explicit_available_at_missing:0/500',
      'row_explicit_observed_or_fetched_at_missing:0/500',
    ],
    nextActions: [
      'Replace file-mtime observedAt/fetchedAt with row-explicit collector observedAt/fetchedAt before PIT audit can pass.',
    ],
    safetyNotes: [
      'This contract status cannot authorize paper orders, live orders, promotion, leverage changes, or best_config mutations.',
    ],
    sampleRows: [],
  }
}

function makeOhlcvCollectorPitContractStatus() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-07T01:05:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'ready_for_pit_audit_research_only',
    sourceArtifacts: {
      collectorPitRows: '/Volumes/shield/cryptoData/openalice-data/parquet/research/openalice_okx_public_ohlcv_pit_rows.research_only.jsonl',
    },
    counts: {
      rowsScanned: 300,
      rowParseErrors: 0,
      rowsWithEventTime: 300,
      rowsWithAvailableAt: 300,
      rowsWithObservedAt: 300,
      rowsWithFetchedAt: 300,
      rowsWithRowExplicitAvailableAt: 300,
      rowsWithRowExplicitObservedOrFetchedAt: 300,
      rowsWithRowLineageScope: 300,
      rowsWithRowPITUsableForPromotionFalse: 300,
      rowsPromotionGrade: 0,
      rowsWithQualityBlockers: 300,
      distinctSymbols: 1,
      distinctInstIds: 1,
      distinctTimeframes: 1,
      distinctCollectionRuns: 1,
    },
    coverage: {
      eventTimePct: 100,
      availableAtPct: 100,
      observedAtPct: 100,
      fetchedAtPct: 100,
      rowExplicitAvailableAtPct: 100,
      rowExplicitObservedOrFetchedAtPct: 100,
      promotionGradePct: 0,
    },
    blockers: [
      'row_pit_usable_for_promotion_false',
      'collector_rows_not_promotion_grade',
      'quality_blockers_present:300/300',
      'collector_pit_contract_research_only',
    ],
    nextActions: [
      'Add a separate PIT audit before promotion-grade labeling.',
    ],
    safetyNotes: [
      'This status cannot authorize paper or live orders.',
    ],
  }
}

function makeOpenAliceDataCatalog() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-06T01:00:00.000Z',
    warehouseRoot: '/Volumes/shield/cryptoData/openalice-data',
    repoDataRoot: '/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice/data',
    aiScientistRoot: '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl',
    status: 'blocked',
    objectiveCoverage: {
      timeGranularitiesRequired: ['second', 'minute', 'hour', 'day'],
      timeGranularitiesObserved: ['second', 'minute', 'hour', 'day'],
      requiredFamilies: [
        'market',
        'derivatives',
        'onchain',
        'asset_metadata',
        'quality_audit',
        'resume',
        'normalized',
        'feature_backtest_input',
        'research_candidates',
      ],
      observedFamilies: [
        'market',
        'derivatives',
        'onchain',
        'quality_audit',
        'resume',
        'normalized',
        'research_candidates',
      ],
      requiredLayers: ['raw', 'normalized/parquet', 'audit', 'runtime', 'derived'],
      observedLayers: ['raw', 'normalized/parquet', 'audit', 'runtime', 'derived'],
      binanceSpotStartPolicy: '2017-08_to_latest_available',
      binanceUsdmStartPolicy: '2019-09_to_latest_available',
    },
    summary: {
      datasets: 97,
      complete: 30,
      partial: 14,
      missing: 52,
      inProgress: 1,
      needsRetry: 0,
      failed: 0,
      rawDatasets: 88,
      normalizedDatasets: 2,
      auditDatasets: 2,
      runtimeDatasets: 2,
      verifiedBinancePublicDatasets: 30,
      plannedBinancePublicDatasets: 81,
    },
    blockerActionability: {
      totalBlockers: 82,
      primaryCategory: 'download_gap',
      categories: [
        { category: 'download_gap', count: 51 },
        { category: 'ai_scientist_validation_gate', count: 15 },
        { category: 'pit_or_normalized_gap', count: 8 },
        { category: 'derivatives_audit_gap', count: 2 },
        { category: 'asset_metadata_gap', count: 2 },
        { category: 'manifest_or_trust_gap', count: 3 },
        { category: 'resume_contract_gap', count: 1 },
      ],
    },
    datasets: [{
      datasetId: 'ai-scientist:crypto-dl:candidate-runs',
      source: 'ai_scientist_crypto_dl',
      family: 'research_candidates',
      layer: 'derived',
      storagePath: '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl',
      present: true,
      status: 'partial',
      reason: 'AI-Scientist crypto_dl candidate runs are visible for research intake; OpenAlice second validation remains required',
      format: 'json/python/research-artifacts',
      cadence: {
        granularity: 'event',
        timeframe: null,
      },
      timeSpan: {
        start: null,
        end: null,
        policy: 'per AI-Scientist run timestamp and OpenAlice intake artifact generatedAt',
      },
      provenance: {
        sourceUrl: null,
        license: 'local research artifact',
        downloadScript: null,
        auditScript: 'scripts/build_ai_scientist_crypto_candidate_intake.ts',
        resumeScript: null,
        summaryPath: 'data/research/ai_scientist_crypto_candidate_intake.latest.json',
        retrySummaryPath: null,
        manifestPath: 'data/research/ai_scientist_crypto_candidate_intake.latest.json.manifest.json',
      },
      quality: {
        summaryPresent: true,
        retrySummaryPresent: false,
        auditPresent: true,
        manifestPresent: true,
        files: 38,
        bytes: 1000,
        zipFiles: 0,
        partFiles: 0,
        expectedFiles: null,
        failedFiles: null,
        missingFiles: null,
        targetSymbols: 1,
        complete: false,
      },
      blockers: [
        'ai_scientist_candidates_require_openalice_second_validation',
        'ai_scientist_candidates_require_pit_wfo_fdr_route_cost_prospective_gates',
        'ai_scientist_candidates_are_not_trading_authority',
      ],
      nextActions: [],
    }],
    blockers: [
      'binance_public_incomplete:30/81',
      'point_in_time_feature_snapshot_missing',
      'required_family_missing:asset_metadata',
      'ai_scientist_candidates_require_openalice_second_validation',
    ],
    nextActions: [
      'Continue the managed Binance Data Vision queue until all planned public market and derivatives datasets are complete.',
      'Build point-in-time feature and backtest input snapshots from normalized data only.',
    ],
    notes: [
      'This catalog is an inventory and quality gate input. It does not authorize paper trading, live trading, or profitability claims.',
    ],
  }
}

function makeOpenAliceDownloadMonitor() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-07T12:06:45.503Z',
    status: 'watching',
    totals: {
      trackedDatasets: 8,
      completeDatasets: 2,
      incompleteDatasets: 6,
      zipFiles: 11564,
      partFiles: 20,
    },
    binanceAudit: {
      exists: true,
      completeDatasets: 31,
      incompleteDatasets: 50,
      zipFiles: 641987,
      partFiles: 20,
      activeDatasets: [{
        id: 'um-all-usdt-aggTrades',
        status: 'in_progress',
      }],
      nextIncompleteDatasets: [
        { id: 'spot-all-usdt-trades', status: 'missing_dir' },
        { id: 'um-all-usdt-fundingRate', status: 'missing_dir' },
      ],
    },
    dataCatalog: {
      status: 'blocked',
      downloadGapBlockers: 51,
      pitOrNormalizedGapBlockers: 8,
    },
    activeProcesses: [{
      id: 'um-all-usdt-aggTrades',
      pid: 123,
      command: 'scripts/fast_binance_data_vision_backfill.ts --outDir /tmp/um-all-usdt-aggTrades',
    }],
    blockers: [
      'openalice_data_catalog_download_gap:51',
      'openalice_data_catalog_pit_or_normalized_gap:8',
      'external_derivatives_collect_errors:tls:10',
    ],
    nextActions: [
      'Keep the active Binance downloader running; refresh audit and monitor after the current dataset finishes or reports failures.',
    ],
  }
}

function makeStrategyDefectMonitor() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T06:45:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status: 'blocked',
    sourceArtifacts: {
      strategyReport: '/Users/kino/Downloads/openalice_strategy_improvement.md',
    },
    summary: {
      findings: 10,
      pass: 1,
      blocked: 7,
      watch: 2,
      p0Blocked: 3,
      p1Blocked: 4,
      p2Blocked: 0,
    },
    findings: [{
      id: 'carry_pit_basis_economics',
      title: 'Funding/carry line has PIT availableAt, basis feature, and positive net economics',
      severity: 'P0',
      status: 'blocked',
      evidencePaths: ['data/research/eth_carry_research_evidence_status.latest.json'],
      observed: {
        fundingMissing: true,
        basisMissing: true,
        netNonPositive: true,
      },
      required: {
        fundingAvailableAtComplete: true,
        basisSpreadFeaturePresent: true,
        netExpectancyPositive: true,
      },
      blockers: [
        'funding_available_time_missing',
        'basis_spread_feature_missing',
        'net_expectancy_non_positive',
      ],
      nextActions: [],
      benchmarkLessons: ['research workflow', 'evidence reporting', 'backtest/live parity'],
    }],
    blockers: [
      'carry_pit_basis_economics:funding_available_time_missing',
      'carry_pit_basis_economics:basis_spread_feature_missing',
      'carry_pit_basis_economics:net_expectancy_non_positive',
    ],
    nextActions: [
      'Fix P0/P1 strategy defects in smallest testable slices.',
    ],
    safetyNotes: [
      'This monitor cannot authorize paper or live orders.',
    ],
  }
}

function makeStrategyDefectRegistry() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-06T00:00:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status: 'blocked',
    sourceArtifacts: {
      strategyDefectMonitor: 'data/research/strategy_defect_monitor.latest.json',
      strategyReport: '/Users/kino/Downloads/openalice_strategy_improvement.md',
    },
    summary: {
      defects: 47,
      open: 25,
      partial: 18,
      watch: 4,
      pass: 0,
      unknown: 0,
      p0OpenOrPartial: 13,
      p1OpenOrPartial: 23,
      monitorCovered: 11,
      monitorUncovered: 36,
    },
    defects: [{
      id: '2.2',
      section: '2',
      layer: 'execution',
      title: 'Partial take-profit missing',
      priority: 'P0',
      evidencePaths: ['scripts/paper_trade_cross_sectional.ts'],
      impacts: [],
      relatedMonitorFindingIds: ['atr_trailing_exit_integration'],
      benchmarkLessons: ['research workflow', 'evidence reporting'],
      nextActions: ['Convert this defect into code evidence plus refreshed runtime artifact evidence before marking it fixed.'],
      status: 'open',
      observed: { partialTakeProfit: false },
      blockers: ['partial_take_profit_missing'],
      monitorCoverage: {
        covered: true,
        matchingFindingIds: ['atr_trailing_exit_integration'],
        matchingBlockers: [],
      },
    }],
    blockers: [
      '2.2:partial_take_profit_missing',
      '4.3:pit_available_at_fixed_for_carry_not_global',
    ],
    nextActions: [
      'Use this registry as the checklist for strategy repair.',
    ],
    safetyNotes: [
      'This registry cannot authorize paper or live orders.',
    ],
  }
}

function makeStrategyQualityGateCoverage() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-08T05:00:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'blocked',
    sourceArtifacts: {
      strategyDefectRegistry: 'data/research/strategy_defect_registry.latest.json',
      strategyDefectMonitor: 'data/research/strategy_defect_monitor.latest.json',
      quantFrameworkBenchmark: 'data/research/quant_framework_benchmark_report.latest.json',
    },
    summary: {
      defects: 48,
      monitorFindings: 14,
      openOrPartial: 34,
      p0OpenOrPartial: 10,
      p1OpenOrPartial: 18,
      p0p1OpenOrPartial: 28,
      monitorCovered: 15,
      monitorUncovered: 33,
      p0p1OpenOrPartialCovered: 9,
      p0p1OpenOrPartialUncovered: 19,
      p0OpenOrPartialUncovered: 4,
      p1OpenOrPartialUncovered: 15,
      coveragePct: 31,
      p0p1OpenOrPartialCoveragePct: 32,
      repairQueues: 7,
      blockedRepairQueues: 6,
      quantBenchmarkStatus: 'blocked',
    },
    repairQueues: [
      {
        queueId: 'execution_quality',
        title: 'Execution cost, slippage, exits, and entry timing',
        priority: 'P0',
        status: 'blocked',
        defectIds: ['2.4', '2.5', '2.8'],
        p0p1OpenOrPartialUncovered: ['2.8'],
        blockers: ['2.8:monitor_missing'],
      },
    ],
    uncoveredDefects: [
      {
        id: '2.8',
        title: 'Entry timing quality missing',
        layer: 'execution',
        priority: 'P1',
        status: 'open',
        openOrPartial: true,
        monitorCovered: false,
        repairQueueId: 'execution_quality',
        blockers: ['entry_timing_quality_missing'],
      },
    ],
    blockers: [
      'p0_open_or_partial_defects_without_monitor:4',
      'p1_open_or_partial_defects_without_monitor:15',
      '2.8:entry_timing_quality_missing',
    ],
    nextActions: [
      'Turn every uncovered P0/P1 strategy defect into a small monitor with a runtime artifact and focused test before claiming the defect is controlled.',
    ],
  }
}

function makeQuantFrameworkBenchmarkReport() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-06T06:35:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status: 'blocked',
    sourceArtifacts: {
      strategyDefectRegistry: 'data/research/strategy_defect_registry.latest.json',
      dataCatalog: 'data/runtime/openalice_data_catalog.latest.json',
      reasonChain: 'data/runtime/system_status_reason_chain.latest.json',
    },
    frameworkSources: [
      { frameworkId: 'quantconnect_lean', name: 'QuantConnect LEAN' },
      { frameworkId: 'nautilus_trader', name: 'NautilusTrader' },
      { frameworkId: 'freqtrade', name: 'Freqtrade' },
      { frameworkId: 'vectorbt', name: 'vectorbt' },
      { frameworkId: 'qlib', name: 'Microsoft Qlib' },
      { frameworkId: 'hummingbot', name: 'Hummingbot' },
    ],
    capabilities: [
      {
        capabilityId: 'order_book_matching',
        title: 'Order book and liquidity-aware matching',
        priority: 'P0',
        modelFrameworks: ['nautilus_trader', 'hummingbot'],
        sourceLessons: ['order book matching', 'execution cost model'],
        currentEvidence: {
          relatedDefectIds: ['2.5'],
          openOrPartialDefectIds: ['2.5'],
          dataCatalogStatus: 'blocked',
          reasonChainActionability: 'research_only_blocked',
        },
        status: 'blocked',
        blockers: [
          'related_defect_open_or_partial:2.5',
          'global_actionability_research_only_blocked',
        ],
        nextActions: [
          'Require spread, depth, route-cost, and slippage-stress fields before strategy economics can count.',
        ],
      },
      {
        capabilityId: 'portfolio_risk_management',
        title: 'Portfolio and account-level risk management',
        priority: 'P0',
        modelFrameworks: ['freqtrade', 'hummingbot'],
        sourceLessons: ['portfolio/risk management', 'money management'],
        currentEvidence: {
          relatedDefectIds: ['7.2'],
          openOrPartialDefectIds: ['7.2'],
          dataCatalogStatus: 'blocked',
          reasonChainActionability: 'research_only_blocked',
        },
        status: 'blocked',
        blockers: [
          'related_defect_open_or_partial:7.2',
          'global_actionability_research_only_blocked',
        ],
        nextActions: [
          'Add total exposure, symbol concentration, correlation, and long/short balance gates.',
        ],
      },
      ...[
        'backtest_live_parity',
        'event_driven_execution',
        'protections',
        'hyperopt',
        'connector_abstraction',
        'fast_parameter_sweep',
        'research_workflow',
        'evidence_reporting',
      ].map(capabilityId => ({
        capabilityId,
        title: capabilityId,
        priority: capabilityId === 'hyperopt' ? 'P1' : 'P0',
        modelFrameworks: [],
        sourceLessons: [],
        currentEvidence: {
          relatedDefectIds: [],
          openOrPartialDefectIds: [],
          dataCatalogStatus: 'blocked',
          reasonChainActionability: 'research_only_blocked',
        },
        status: 'watch',
        blockers: [],
        nextActions: [],
      })),
    ],
    summary: {
      frameworks: 6,
      capabilities: 10,
      blockedCapabilities: 2,
      watchCapabilities: 8,
      missingEvidenceCapabilities: 0,
      relatedOpenOrPartialDefects: 2,
      p0RelatedOpenOrPartialDefects: 2,
      dataCatalogStatus: 'blocked',
      reasonChainActionability: 'research_only_blocked',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      canPromote: false,
    },
    blockers: [
      'order_book_matching:related_defect_open_or_partial:2.5',
      'portfolio_risk_management:related_defect_open_or_partial:7.2',
    ],
    nextActions: [
      'Use this report as the benchmark-to-defect map for OpenAlice strategy repairs.',
      'Keep all framework lessons research-only until OpenAlice artifacts pass PIT, WFO, FDR, route cost, prospective, paper telemetry, and release gates.',
    ],
    safetyNotes: [
      'This report compares engineering patterns only; it does not authorize trading.',
    ],
  }
}

function makeRuntimeFeeSnapshotRefresh() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T05:54:23.119Z',
    status: 'blocked',
    dryRun: false,
    exchange: 'okx',
    marketType: 'swap',
    symbols: [
      'BTC/USDT:USDT',
      'ETH/USDT:USDT',
      'SOL/USDT:USDT',
    ],
    snapshotWritten: false,
    statusWritten: true,
    promotionAllowedByThisArtifact: false,
    paperTradingAllowedByThisArtifact: false,
    liveTradingAllowedByThisArtifact: false,
    feeSnapshot: null,
    perSymbolFees: [],
    errors: [
      {
        symbol: '*',
        errorClass: 'api_not_supported',
        message: 'okx fetchTradingFees() is not supported yet',
      },
      {
        symbol: 'BTC/USDT:USDT',
        errorClass: 'auth',
        message: 'okx {"msg":"API key:[redacted] doesn\'t exist","code":"50119"}',
      },
    ],
    blockers: [
      'fee_snapshot_no_valid_fee_rows',
      'fee_snapshot_fetch_failed:api_not_supported',
      'fee_snapshot_fetch_failed:auth',
      'fee_snapshot_missing_symbol_rows:BTC/USDT:USDT,ETH/USDT:USDT,SOL/USDT:USDT',
    ],
  }
}

function makeGoalCompletionAudit() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-06T14:45:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status: 'blocked',
    goalComplete: false,
    objective: '恢复OKX的数据获取能力并存储；提升策略能力；只在 gates 通过后才允许交易。',
    effectiveActionability: 'research_only_blocked',
    overallPlanCompletionPct: 49,
    goalChecklistCompletionPct: 55,
    observedGateState: {
      reasonChainPaperTradingAllowed: false,
      reasonChainLiveTradingAllowed: false,
      reasonChainCanPromote: false,
      releaseGateAllowPaperTrading: false,
      releaseGateAllowLiveTrading: false,
      paperGateFinalAllowPaperTrading: false,
    },
    summary: {
      items: 12,
      requiredItems: 12,
      pass: 5,
      blocked: 7,
      missing: 0,
      watch: 0,
      requiredPass: 5,
      requiredBlocked: 7,
      requiredMissing: 0,
      dataCatalogStatus: 'blocked',
      dataCatalogComplete: 35,
      dataCatalogDatasets: 99,
      strategyDefectStatus: 'blocked',
      quantFrameworkStatus: 'blocked',
      ethCarryProspectiveStatus: 'has_closed_labels',
      aiScientistReadinessStatus: 'blocked_openalice_validation_missing',
      schedulerSecurityStatus: 'pass',
    },
    items: [{
      id: 'multi_source_data_catalog',
      title: 'Multi-source crypto data catalog covers raw, normalized, audit, runtime, and PIT inputs',
      required: true,
      status: 'blocked',
      completionPct: 35,
      evidencePaths: ['data/runtime/openalice_data_catalog.latest.json'],
      blockers: [
        'openalice_data_catalog_status:blocked',
        'openalice_data_catalog:binance_public_incomplete:30/81',
      ],
      metrics: {},
      nextActions: [],
    }],
    blockers: [
      'multi_source_data_catalog:openalice_data_catalog_status:blocked',
      'ai_scientist_openalice_second_validation:ai_scientist_missing_openalice_gates:8',
      'quant_framework_benchmark:quant_framework_blocked_capabilities:10',
      'strategy_defect_registry_monitor:strategy_defects_open_or_partial:43',
      'eth_carry_prospective_evidence:eth_carry_prospective_mean_gross_non_positive:-0.600451856',
      'paper_live_release_gate_profitability:reason_chain_can_promote_false',
    ],
    nextActions: [
      'Do not reopen retired RankIC/liquidity-reversal parameter tuning.',
      'Refresh this audit and system_status_reason_chain after every strategy or data-pipeline repair.',
    ],
    safetyNotes: [
      'This audit is diagnostic only.',
    ],
  }
}

function makeSchedulerSecurityAudit(input: {
  status: 'pass' | 'fail'
  okxCredentialPresence: { apiKey: boolean; secret: boolean; password: boolean }
}) {
  const findings = input.status === 'pass'
    ? []
    : [{
        severity: 'fail',
        check: 'runtime_fee_auth_tick_okx_credentials',
        path: '/Users/kino/.config/openalice/openalice.env',
        detail: 'runtime_fee_auth_tick_4h requires OKX private-auth credentials in the default OpenAlice env file; missing EXCHANGE_API_KEY, EXCHANGE_API_SECRET, EXCHANGE_PASSWORD',
      }]
  return {
    generatedAt: '2026-05-05T11:27:38.465Z',
    status: input.status,
    findings,
    checks: {
      internalCronJobs: {
        requiredJobs: {
          runtime_fee_auth_tick_4h: {
            enabledHits: 1,
          },
        },
      },
      envFile: {
        path: '/Users/kino/.config/openalice/openalice.env',
        exists: true,
        mode: '600',
        ownedByCurrentUser: true,
        restricted: true,
        okxCredentialPresence: input.okxCredentialPresence,
      },
    },
  }
}

function makeOkxPrivateAuthDiagnosis() {
  return {
    status: 'blocked',
    bestMode: null,
    credentialPresence: {
      apiKey: true,
      secret: true,
      password: true,
    },
    blockers: [
      'okx_auth_not_recognized_any_mode',
      'production:fee_snapshot_fetch_failed:auth',
      'demoTrading:fee_snapshot_fetch_failed:auth',
      'sandbox:fee_snapshot_fetch_failed:auth',
    ],
  }
}
