import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildStrategyDefectMonitorReport,
  parseStrategyDefectMonitorArgs,
  runStrategyDefectMonitor,
} from './build_strategy_defect_monitor.js'

describe('build_strategy_defect_monitor', () => {
  it('parses defaults and keeps package script wired', () => {
    expect(parseStrategyDefectMonitorArgs(['--output', 'null', '--json'])).toMatchObject({
      outputPath: null,
      strategyDefectRegistryPath: 'data/research/strategy_defect_registry.latest.json',
      researchLineRetirementPath: 'data/research/research_line_retirement.latest.json',
      panicRegimeNoOpenGateStatusPath: 'data/runtime/panic_regime_no_open_gate_status.latest.json',
      strategyRiskCapStatusPath: 'data/runtime/strategy_risk_cap_status.latest.json',
      partialTakeProfitStatusPath: 'data/runtime/partial_take_profit_status.latest.json',
      mfeMaeStoplossReportPath: 'data/runtime/p1_trading_evidence/mfe_mae_stoploss_report.latest.json',
      paperExecutionFutureTelemetryWatchdogPath: 'data/runtime/paper_execution_future_telemetry_watchdog.latest.json',
      ethCarryDataGapStatusPath: 'data/research/eth_carry_data_gap_status.latest.json',
      ethCarryProspectiveEvidencePath: 'data/research/eth_carry_prospective_evidence_status.latest.json',
      marketIntelNoOpenGateStatusPath: 'data/runtime/market_intel_no_open_gate_status.latest.json',
      crossSectionalConfigGateStatusPath: 'data/runtime/cross_sectional_config_gate_status.latest.json',
      volumeBreakoutConfigGateStatusPath: 'data/runtime/volume_breakout_config_gate_status.latest.json',
      wfoStabilityGateStatusPath: 'data/runtime/wfo_stability_gate_status.latest.json',
      portfolioRiskManagementGateStatusPath: 'data/runtime/portfolio_risk_management_gate_status.latest.json',
      killSwitchGateStatusPath: 'data/runtime/kill_switch_gate_status.latest.json',
      accountCorruptionGateStatusPath: 'data/runtime/account_corruption_gate_status.latest.json',
      json: true,
    })
    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:defect-monitor']).toContain('build_strategy_defect_monitor.ts')
  })

  it('flags known strategy blockers without authorizing execution', () => {
    const report = buildStrategyDefectMonitorReport({
      generatedAt: '2026-05-06T00:00:00.000Z',
      sourceArtifacts: {
        strategyDefectRegistry: '/tmp/strategy_defect_registry.json',
        researchLineRetirement: '/tmp/research_line_retirement.json',
        strategyReport: '/tmp/openalice_strategy_improvement.md',
        staleDataNoOpenGateStatus: '/tmp/stale_data_no_open_gate_status.json',
        panicRegimeNoOpenGateStatus: '/tmp/panic_regime_no_open_gate_status.json',
        strategyRiskCapStatus: '/tmp/strategy_risk_cap_status.json',
        partialTakeProfitStatus: '/tmp/partial_take_profit_status.json',
        mfeMaeStoplossReport: '/tmp/mfe_mae_stoploss_report.json',
        okxOrderbookSpreadSnapshot: '/tmp/okx_orderbook.json',
        okxRouteCostSlippageReadiness: '/tmp/okx_route_cost_slippage.json',
        paperExecutionProducerContractStatus: '/tmp/paper_execution_producer_contract.json',
        paperExecutionFutureTelemetryWatchdog: '/tmp/paper_execution_future_telemetry_watchdog.json',
        ethCarryEvidence: '/tmp/eth.json',
        ethCarryDataGapStatus: '/tmp/eth_data_gap.json',
        ethCarryProspectiveEvidence: '/tmp/eth_prospective.json',
        aiScientistIntake: '/tmp/ai.json',
        aiScientistSecondValidationQueue: '/tmp/ai_queue.json',
        aiScientistSourceManifest: '/tmp/ai_source_manifest.json',
        aiScientistReadiness: '/tmp/ai_readiness.json',
        aiScientistPitReproductionPlan: '/tmp/ai_pit_plan.json',
        aiScientistPitInputDataset: '/tmp/ai_pit_input_dataset.json',
        aiScientistPitContractStatus: '/tmp/ai_pit_contract_status.json',
        dynamicLeverageVolatilityGateStatus: '/tmp/dynamic_leverage_volatility_gate_status.json',
        decisionContextCoverageGateStatus: '/tmp/decision_context_coverage_gate_status.json',
        pitAuditGlobalGateStatus: '/tmp/pit_audit_global_gate_status.json',
        routeCostModelCompletenessGateStatus: '/tmp/route_cost_model_completeness_gate_status.json',
        marketIntelNoOpenGateStatus: '/tmp/market_intel_no_open_gate_status.json',
        crossSectionalConfigGateStatus: '/tmp/cross_sectional_config_gate_status.json',
        volumeBreakoutConfigGateStatus: '/tmp/volume_breakout_config_gate_status.json',
        wfoStabilityGateStatus: '/tmp/wfo_stability_gate_status.json',
        portfolioRiskManagementGateStatus: '/tmp/portfolio_risk_management_gate_status.json',
        killSwitchGateStatus: '/tmp/kill_switch_gate_status.json',
        accountCorruptionGateStatus: '/tmp/account_corruption_gate_status.json',
      },
      sources: {
        strategyReport: source('/tmp/openalice_strategy_improvement.md', '成本证据 microstructure ATR trailing'),
        crossSectional: source('/tmp/cs.ts', 'const DEFAULT_CONFIG = { minUniverseSize: 6 }'),
        crossSectionalPaper: source('/tmp/paper_cs.ts', 'expectedHoldingHours: 24'),
        volumeBreakout: source('/tmp/vb.ts', 'holdBars: 4,\nstopLossPct: 0.005,\nminVolumeUsd: 100_000,'),
        microstructure: source('/tmp/micro.ts', "id: 'liquidation_probe_100x'\nid: 'liquidation_probe_10x'"),
        actionGate: source('/tmp/action.ts', 'staleDataApplied: context.staleData === true'),
        scoring: source('/tmp/scoring.ts', 'const staleDataApplied = context.staleData === true'),
      },
      strategyDefectRegistry: {
        status: 'blocked',
        summary: {
          defects: 48,
          p0OpenOrPartial: 14,
          p1OpenOrPartial: 23,
        },
        defects: [{ id: '2.4' }],
      },
      researchLineRetirement: researchLineRetirement(),
      staleDataNoOpenGateStatus: null,
      panicRegimeNoOpenGateStatus: null,
      dynamicLeverageVolatilityGateStatus: null,
      decisionContextCoverageGateStatus: null,
      pitAuditGlobalGateStatus: null,
      routeCostModelCompletenessGateStatus: null,
      marketIntelNoOpenGateStatus: null,
      crossSectionalConfigGateStatus: null,
      volumeBreakoutConfigGateStatus: null,
      wfoStabilityGateStatus: null,
      portfolioRiskManagementGateStatus: null,
      killSwitchGateStatus: null,
      accountCorruptionGateStatus: null,
      strategyRiskCapStatus: null,
      partialTakeProfitStatus: partialTakeProfitStatus(),
      mfeMaeStoplossReport: mfeMaeStoplossReport(),
      okxOrderbookSpreadSnapshot: null,
      okxRouteCostSlippageReadiness: {
        status: 'blocked',
        researchOnly: true,
        diagnosticOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        executionAllowed: false,
        readiness: {
          publicOrderbookUsableForResearch: true,
          runtimeFeeSnapshotUsableForResearch: true,
          routeCostBudgetRuntimeVerified: false,
          routeCostBudgetFresh: false,
          paperExecutionTelemetryAvailable: false,
          promotionGradeRouteCostEvidence: false,
        },
        orderbook: {
          rowsBuilt: 3,
          maxSpreadBps: 1.2,
          minDepth5Usd: 700000,
        },
        feeSnapshot: {
          source: 'api',
          verifiedByRuntime: true,
        },
        routeCostBudget: {
          feeSnapshotSource: 'manual_override',
          feeSnapshotVerifiedByRuntime: false,
          feeSnapshotMatchesRuntimeFeeSnapshot: false,
          routesOverBudget: ['taker_taker'],
        },
        executionQuality: {
          recentOrderCount: 11,
        },
        paperCostEvidence: {
          completePredictedOpenEvidenceCoveragePct: 0,
          tradesWithExchangeReconciledCostEvidence: 0,
        },
        blockers: [
          'route_cost_budget_fee_snapshot_source_not_api:manual_override',
          'route_cost_budget_fee_snapshot_mismatch',
          'paper_execution_slippage_telemetry_unavailable',
          'route_cost_slippage_readiness_diagnostic_only',
        ],
      },
      paperExecutionProducerContractStatus: makeReadyFutureProducerContractStatus({
        closedTrades: 947,
        tradesWithPaperFillTelemetry: 0,
      }),
      paperExecutionFutureTelemetryWatchdog: {
        status: 'watch_waiting_for_future_rows',
        researchOnly: true,
        diagnosticOnly: true,
        futureOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        executionAllowed: false,
        counts: {
          futureClosedRows: 0,
          futureClosedRowsWithOpenAfterStart: 0,
          futureRowsWithPaperFillTelemetry: 0,
          futureRowsWithCompletePredictedOpenEvidence: 0,
          futureRowsWithExchangeReconciledCostEvidence: 0,
          futureRowsWithObservedSlippage: 0,
        },
        coverage: {
          futurePaperFillTelemetryCoveragePct: null,
          futureNewOpenPredictedOpenEvidenceCoveragePct: null,
          futureExchangeReconciledCostCoveragePct: null,
          futureObservedSlippageCoveragePct: null,
        },
        readiness: {
          futurePaperFillTelemetrySufficient: false,
          futurePredictedOpenEvidenceSufficient: true,
          exchangeReconciledCostEvidenceAvailable: false,
          observedSlippageAvailable: false,
        },
        blockers: [],
        evidenceBlockers: [
          'future_closed_paper_rows_missing',
          'future_new_open_closed_rows_missing',
          'exchange_reconciled_cost_evidence_missing',
          'observed_slippage_unavailable',
          'paper_execution_future_watchdog_diagnostic_only',
        ],
      },
      ethCarryEvidence: {
        status: 'research_only_blocked',
        profitabilityVerdict: 'cannot_claim_profitable',
        blockers: [
          'funding_available_time_missing:ETH:0/200',
          'basis_spread_feature_missing',
          'net_expectancy_non_positive:-0.01',
        ],
      },
      ethCarryDataGapStatus: {
        status: 'blocked_insufficient_research_data',
        thresholds: {
          minCarryFeatureRows: 100,
          minProspectiveClosedOutcomes: 100,
        },
        counts: {
          carryFeatureRows: 14,
          prospectiveClosedOutcomes: 2,
          prospectiveClosedOutcomeShortfall: 98,
          collectorErrorCount: 10,
        },
        blockers: [
          'carry_feature_rows_low:14<100',
          'source_lineage_incomplete_rows:25',
          'prospective_closed_outcomes_low:2<100',
          'external_derivatives_collect_errors:tls:10',
          'data_vision_archive_missing:binance-public:um:fundingRate:usdt',
        ],
      },
      ethCarryProspectiveEvidence: {
        status: 'has_closed_labels',
        counts: {
          openEvents: 3,
          closedEvents: 2,
          closedDecisionWindows: 2,
        },
        metrics: {
          closedOutcomes: 2,
          meanGrossCarryPairReturnPct: -0.6,
          winRatePct: 0,
          routeCostAdjustedClosedOutcomes: 2,
          fundingCashflowAccountedClosedOutcomes: 2,
        },
        thresholds: {
          minClosedOutcomes: 100,
          minNonOverlappingWindows: 3,
        },
        blockers: [
          'research_only_not_execution_evidence',
          'paper_live_execution_disabled',
          'prospective_closed_outcomes_low:2<100',
          'prospective_closed_windows_low:2<3',
        ],
      },
      aiScientistIntake: {
        status: 'research_only_blocked',
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        counts: {
          candidatesFound: 35,
          runsWithWalkForward: 5,
          targetReached: 2,
        },
      },
      aiScientistSecondValidationQueue: {
        status: 'queued_research_only',
        executionAllowed: false,
        counts: {
          queuedCandidates: 3,
          requiredGateCount: 33,
          missingGateCount: 24,
        },
        blockers: [
          'openalice_second_validation_queued_not_completed',
          'paper_execution_telemetry_missing',
        ],
      },
      aiScientistSourceManifest: {
        status: 'locked_research_only',
        executionAllowed: false,
        counts: {
          candidatesLocked: 3,
          sourceFilesExpected: 7,
          sourceFilesPresent: 7,
          sourceFilesMissing: 0,
        },
        blockers: [
          'source_manifest_research_only',
          'openalice_second_validation_still_required',
        ],
      },
      aiScientistReadiness: {
        status: 'blocked_openalice_validation_missing',
        executionAllowed: false,
        counts: {
          candidatesReadyForOpenAliceReproduction: 3,
          missingOpenAliceEvidenceGates: 24,
        },
        blockers: [
          'openalice_second_validation_readiness_research_only',
          'openalice_validation_gates_not_complete',
        ],
      },
      aiScientistPitReproductionPlan: {
        status: 'blocked_pit_contract_missing',
        executionAllowed: false,
        counts: {
          candidatesReadyForOpenAlicePitReproduction: 0,
          csvInputFiles: 6,
          csvFilesWithExplicitAvailableAt: 0,
          csvFilesWithObservedOrFetchedAt: 0,
          openAliceWarehouseLinkedInputs: 0,
        },
        blockers: [
          'run_candidate:csv_available_time_missing:data/BTC.csv',
          'run_candidate:openalice_warehouse_link_missing:data/BTC.csv:not_openalice_warehouse_path',
          'ai_scientist_pit_plan_research_only',
        ],
      },
      aiScientistPitInputDataset: {
        status: 'research_dataset_ready_pit_blocked',
        executionAllowed: false,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        counts: {
          rowsRead: 500,
          rowsNormalized: 500,
          promotionGradeRows: 0,
          distinctSymbols: 1,
        },
        blockers: [
          'pit_input_dataset_research_only',
          'pit_input_observed_at_recovered_from_file_mtime_not_row_explicit',
          'pit_input_available_at_derived_from_bar_close_not_exchange_observed',
          'pit_input_not_promotion_grade',
        ],
      },
      aiScientistPitContractStatus: {
        status: 'blocked_pit_contract_missing',
        counts: {
          rowsScanned: 500,
          rowsWithRowExplicitAvailableAt: 0,
          rowsWithRowExplicitObservedOrFetchedAt: 0,
          rowsPromotionGrade: 0,
        },
        blockers: [
          'row_explicit_available_at_missing:0/500',
          'row_explicit_observed_or_fetched_at_missing:0/500',
          'promotion_grade_rows_missing:0/500',
          'quality_blockers_present:500/500',
          'ai_scientist_pit_contract_research_only',
        ],
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T00:00:00.000Z',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked',
      summary: {
        findings: 28,
        p0Blocked: 9,
        p1Blocked: 16,
      },
    })
    expect(report.findings.find(item => item.id === 'cross_sectional_holding_window')).toMatchObject({
      status: 'pass',
      observed: { expectedHoldingHours: 24 },
    })
    expect(report.findings.find(item => item.id === 'strategy_report_loaded')).toMatchObject({
      status: 'watch',
      observed: {
        registryExists: true,
        registryDefects: 48,
        legacyReportExists: true,
      },
    })
    expect(report.findings.find(item => item.id === 'retired_line_guard')).toMatchObject({
      status: 'pass',
      observed: {
        verdict: 'retire_current_line',
        lineHealth: 'retired',
        retired: true,
        hasReactivationChecklist: true,
        artifactAllowsExecution: false,
      },
    })
    expect(report.findings.find(item => item.id === 'volume_breakout_stop_loss')).toMatchObject({
      status: 'blocked',
      blockers: ['stop_loss_too_tight:0.005<0.015'],
    })
    expect(report.findings.find(item => item.id === 'atr_trailing_exit_integration')).toMatchObject({
      status: 'blocked',
      observed: {
        computeAtrTrailingStopReferenced: false,
        partialTakeProfitStatus: 'pass',
        partialTakeProfitValidated: true,
      },
      blockers: ['atr_trailing_stop_not_integrated'],
    })
    expect(report.findings.find(item => item.id === 'entry_timing_quality')).toMatchObject({
      status: 'blocked',
      observed: {
        metricBasis: 'price_path_bps',
        closedTrades: 947,
        closedDiagnosticsOk: 947,
        stopLossTrades: 42,
        stopLossDiagnosticsOk: 42,
        stopLossDiagnosticsOkPct: 100,
        hasPathTimingDiagnostics: true,
        hasExecutionGradeEntryTelemetry: false,
        futurePaperProducerReady: true,
        futureClosedRows: 0,
        futureObservedSlippageAvailable: false,
        artifactAllowsExecution: false,
      },
      blockers: expect.arrayContaining([
        'future_closed_paper_rows_missing',
        'future_observed_slippage_unavailable',
        'open_round_trip_cost_missing:42',
        'legacy_or_missing_open_context:42',
      ]),
    })
    expect(report.findings.find(item => item.id === 'carry_pit_basis_economics')).toMatchObject({
      status: 'blocked',
      observed: {
        dataGapStatus: 'blocked_insufficient_research_data',
        carryFeatureRows: 14,
        minCarryFeatureRows: 100,
        collectorErrorCount: 10,
        coreArchiveMissing: false,
      },
      blockers: expect.arrayContaining([
        'carry_feature_rows_low:14<100',
        'external_derivatives_collect_errors:10',
        'funding_available_time_missing',
        'basis_spread_feature_missing',
        'net_expectancy_non_positive',
      ]),
    })
    expect(report.findings.find(item => item.id === 'carry_prospective_evidence')).toMatchObject({
      observed: {
        dataGapStatus: 'blocked_insufficient_research_data',
        prospectiveClosedOutcomeShortfall: 98,
      },
      blockers: expect.arrayContaining([
        'prospective_closed_outcomes_low:2<100',
      ]),
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'cross_sectional_spread_filter:maxSpreadBps_config_missing',
      'cross_sectional_spread_filter:runtime_orderbook_spread_evidence_missing_or_blocked',
      'strategy_risk_caps:strategy_risk_cap_status_missing',
      'route_cost_slippage_readiness:route_cost_budget_not_runtime_fee_verified',
      'route_cost_slippage_readiness:paper_execution_slippage_telemetry_unavailable',
      'route_cost_slippage_readiness:producer_contract:historical_paper_fill_telemetry_coverage_low:0/947',
      'route_cost_slippage_readiness:future_telemetry_watchdog:future_closed_paper_rows_missing',
      'entry_timing_quality:future_closed_paper_rows_missing',
      'entry_timing_quality:future_observed_slippage_unavailable',
      'entry_timing_quality:open_round_trip_cost_missing:42',
      'carry_pit_basis_economics:funding_available_time_missing',
      'carry_pit_basis_economics:carry_feature_rows_low:14<100',
      'carry_pit_basis_economics:net_expectancy_non_positive',
      'carry_prospective_evidence:prospective_closed_outcomes_low:2<100',
      'carry_prospective_evidence:prospective_mean_gross_non_positive:-0.6',
      'ai_scientist_second_validation:openalice_pit_reproduction_not_ready',
      'ai_scientist_second_validation:pit_input_dataset_research_only',
      'ai_scientist_second_validation:ai_scientist_row_explicit_available_at_missing:0/500',
      'ai_scientist_second_validation:openalice_second_validation_queued_not_completed',
    ]))
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-strategy-defect-'))
    const outputPath = join(root, 'strategy_defect_monitor.latest.json')
    const strategyDefectRegistryPath = join(root, 'strategy_defect_registry.json')
    const researchLineRetirementPath = join(root, 'research_line_retirement.json')
    const reportPath = join(root, 'report.md')
    const csPath = join(root, 'cs.ts')
    const paperCsPath = join(root, 'paper_cs.ts')
    const vbPath = join(root, 'vb.ts')
    const microPath = join(root, 'micro.ts')
    const actionPath = join(root, 'action.ts')
    const scoringPath = join(root, 'scoring.ts')
    const staleDataNoOpenGateStatusPath = join(root, 'stale_data_no_open_gate_status.json')
    const panicRegimeNoOpenGateStatusPath = join(root, 'panic_regime_no_open_gate_status.json')
    const strategyRiskCapStatusPath = join(root, 'strategy_risk_cap_status.json')
    const partialTakeProfitStatusPath = join(root, 'partial_take_profit_status.json')
    const mfeMaeStoplossReportPath = join(root, 'mfe_mae_stoploss_report.json')
    const okxOrderbookSpreadSnapshotPath = join(root, 'okx_orderbook.json')
    const okxRouteCostSlippageReadinessPath = join(root, 'okx_route_cost_slippage.json')
    const paperExecutionProducerContractStatusPath = join(root, 'paper_execution_producer_contract.json')
    const paperExecutionFutureTelemetryWatchdogPath = join(root, 'paper_execution_future_telemetry_watchdog.json')
    const ethPath = join(root, 'eth.json')
    const ethDataGapPath = join(root, 'eth_data_gap.json')
    const ethProspectivePath = join(root, 'eth_prospective.json')
    const aiPath = join(root, 'ai.json')
    const aiQueuePath = join(root, 'ai_queue.json')
    const aiSourceManifestPath = join(root, 'ai_source_manifest.json')
    const aiReadinessPath = join(root, 'ai_readiness.json')
    const aiPitReproductionPlanPath = join(root, 'ai_pit_plan.json')
    const aiPitInputDatasetPath = join(root, 'ai_pit_input_dataset.json')
    const aiPitContractStatusPath = join(root, 'ai_pit_contract_status.json')
    const dynamicLeverageVolatilityGateStatusPath = join(root, 'dynamic_leverage_volatility_gate_status.json')
    const marketIntelNoOpenGateStatusPath = join(root, 'market_intel_no_open_gate_status.json')
    const crossSectionalConfigGateStatusPath = join(root, 'cross_sectional_config_gate_status.json')
    const volumeBreakoutConfigGateStatusPath = join(root, 'volume_breakout_config_gate_status.json')
    const wfoStabilityGateStatusPath = join(root, 'wfo_stability_gate_status.json')
    const portfolioRiskManagementGateStatusPath = join(root, 'portfolio_risk_management_gate_status.json')
    const killSwitchGateStatusPath = join(root, 'kill_switch_gate_status.json')
    const accountCorruptionGateStatusPath = join(root, 'account_corruption_gate_status.json')
    await mkdir(root, { recursive: true })
    await writeFile(strategyDefectRegistryPath, JSON.stringify({
      status: 'blocked',
      summary: {
        defects: 48,
        p0OpenOrPartial: 14,
        p1OpenOrPartial: 23,
      },
      defects: [{ id: '2.4' }],
    }), 'utf-8')
    await writeFile(researchLineRetirementPath, JSON.stringify(researchLineRetirement()), 'utf-8')
    await writeFile(reportPath, '成本证据 microstructure ATR trailing', 'utf-8')
    await writeFile(csPath, 'const DEFAULT_CONFIG = { minUniverseSize: 6 }', 'utf-8')
    await writeFile(paperCsPath, 'expectedHoldingHours: 24', 'utf-8')
    await writeFile(vbPath, 'holdBars: 4,\nstopLossPct: 0.005,\nminVolumeUsd: 100_000,', 'utf-8')
    await writeFile(microPath, "id: 'liquidation_probe_100x'", 'utf-8')
    await writeFile(actionPath, 'staleDataApplied: true', 'utf-8')
    await writeFile(scoringPath, 'staleDataApplied', 'utf-8')
    await writeFile(staleDataNoOpenGateStatusPath, JSON.stringify({
      status: 'blocked',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      checks: {
        staleHighConfidenceActionStatus: 'no-trade',
        staleOpenDecisionMode: 'blocked',
        staleReducePassThrough: true,
      },
      blockers: ['fixture_keeps_watch_path'],
    }), 'utf-8')
    await writeFile(panicRegimeNoOpenGateStatusPath, JSON.stringify(panicRegimeNoOpenGateStatus()), 'utf-8')
    await writeFile(strategyRiskCapStatusPath, JSON.stringify(strategyRiskCapStatus()), 'utf-8')
    await writeFile(partialTakeProfitStatusPath, JSON.stringify(partialTakeProfitStatus()), 'utf-8')
    await writeFile(mfeMaeStoplossReportPath, JSON.stringify(mfeMaeStoplossReport()), 'utf-8')
    await writeFile(okxOrderbookSpreadSnapshotPath, JSON.stringify({
      status: 'complete',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      counts: {
        rowsBuilt: 3,
        blockedRows: 0,
      },
      spreadSummary: {
        maxSpreadBps: 1.2,
        minDepth5Usd: 700000,
      },
      blockers: [],
    }), 'utf-8')
    await writeFile(okxRouteCostSlippageReadinessPath, JSON.stringify({
      status: 'blocked',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      readiness: {
        publicOrderbookUsableForResearch: true,
        runtimeFeeSnapshotUsableForResearch: true,
        routeCostBudgetRuntimeVerified: false,
        routeCostBudgetFresh: false,
        paperExecutionTelemetryAvailable: false,
      },
      orderbook: {
        requiredOrderbookSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        requiredOrderbookPassedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        requiredOrderbookBlockedSymbols: [],
        requiredOrderbookMissingSymbols: [],
        requiredOrderbookAllPass: true,
      },
      blockers: [
        'route_cost_budget_fee_snapshot_mismatch',
        'paper_execution_slippage_telemetry_unavailable',
      ],
    }), 'utf-8')
    await writeFile(paperExecutionProducerContractStatusPath, JSON.stringify(makeReadyFutureProducerContractStatus({
      closedTrades: 2,
      tradesWithPaperFillTelemetry: 0,
    })), 'utf-8')
    await writeFile(paperExecutionFutureTelemetryWatchdogPath, JSON.stringify(makeFutureTelemetryWatchdog()), 'utf-8')
    await writeFile(ethPath, JSON.stringify({ blockers: ['basis_spread_feature_missing'] }), 'utf-8')
    await writeFile(ethDataGapPath, JSON.stringify({
      status: 'blocked_insufficient_research_data',
      counts: {
        carryFeatureRows: 0,
        prospectiveClosedOutcomes: 0,
        collectorErrorCount: 1,
      },
      thresholds: {
        minCarryFeatureRows: 100,
      },
      blockers: [
        'carry_feature_rows_low:0<100',
        'external_derivatives_collect_errors:tls:1',
      ],
    }), 'utf-8')
    await writeFile(ethProspectivePath, JSON.stringify({
      status: 'collecting',
      counts: {
        openEvents: 1,
        closedEvents: 0,
        closedDecisionWindows: 0,
      },
      metrics: {
        closedOutcomes: 0,
        routeCostAdjustedClosedOutcomes: 0,
        fundingCashflowAccountedClosedOutcomes: 0,
      },
      thresholds: {
        minClosedOutcomes: 100,
        minNonOverlappingWindows: 3,
      },
      blockers: [
        'research_only_not_execution_evidence',
        'paper_live_execution_disabled',
        'prospective_closed_outcomes_low:0<100',
      ],
    }), 'utf-8')
    await writeFile(aiPath, JSON.stringify({ counts: { candidatesFound: 1 } }), 'utf-8')
    await writeFile(aiQueuePath, JSON.stringify({ counts: { queuedCandidates: 1 } }), 'utf-8')
    await writeFile(aiSourceManifestPath, JSON.stringify({
      status: 'locked_research_only',
      counts: {
        candidatesLocked: 1,
        sourceFilesExpected: 1,
        sourceFilesPresent: 1,
        sourceFilesMissing: 0,
      },
    }), 'utf-8')
    await writeFile(aiReadinessPath, JSON.stringify({
      status: 'blocked_openalice_validation_missing',
      counts: {
        candidatesReadyForOpenAliceReproduction: 1,
        missingOpenAliceEvidenceGates: 8,
      },
    }), 'utf-8')
    await writeFile(aiPitReproductionPlanPath, JSON.stringify({
      status: 'blocked_pit_contract_missing',
      counts: {
        candidatesReadyForOpenAlicePitReproduction: 0,
        csvInputFiles: 1,
        csvFilesWithExplicitAvailableAt: 0,
        csvFilesWithObservedOrFetchedAt: 0,
        openAliceWarehouseLinkedInputs: 0,
      },
    }), 'utf-8')
    await writeFile(aiPitInputDatasetPath, JSON.stringify({
      status: 'research_dataset_ready_pit_blocked',
      executionAllowed: false,
      counts: {
        rowsRead: 1,
        rowsNormalized: 1,
        promotionGradeRows: 0,
        distinctSymbols: 1,
      },
      blockers: [
        'pit_input_dataset_research_only',
        'pit_input_not_promotion_grade',
      ],
    }), 'utf-8')
    await writeFile(aiPitContractStatusPath, JSON.stringify({
      status: 'blocked_pit_contract_missing',
      counts: {
        rowsScanned: 1,
        rowsWithRowExplicitAvailableAt: 0,
        rowsWithRowExplicitObservedOrFetchedAt: 0,
        rowsPromotionGrade: 0,
      },
      blockers: [
        'row_explicit_available_at_missing:0/1',
        'row_explicit_observed_or_fetched_at_missing:0/1',
        'promotion_grade_rows_missing:0/1',
      ],
    }), 'utf-8')
    await writeFile(dynamicLeverageVolatilityGateStatusPath, JSON.stringify({
      status: 'pass',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      checks: {
        volatilityPercentile: 0.85,
        realizedVolPct: 65,
        recommendedMaxLeverage: 1,
        currentMaxLeverage: 100,
        leverageBlocked: false,
        tier: 'high',
        tierDescription: 'High volatility regime; leverage capped at 1x with warning',
        lowTierProbe: { percentile: 0.10, maxLeverage: 3, blocked: false },
        normalTierProbe: { percentile: 0.50, maxLeverage: 1, blocked: false },
        highTierProbe: { percentile: 0.90, maxLeverage: 1, blocked: false },
        extremeTierProbe: { percentile: 0.99, maxLeverage: 0, blocked: true },
      },
      blockers: [],
    }), 'utf-8')

    await writeFile(marketIntelNoOpenGateStatusPath, JSON.stringify(marketIntelNoOpenGateStatus()), 'utf-8')

    await writeFile(crossSectionalConfigGateStatusPath, JSON.stringify({
      status: 'pass',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      checks: {
        mtfWeight: { found: true, value: '0.35', verdict: 'needs_work' },
        funding: { found: true, value: '0.25', verdict: 'needs_work' },
        spread: { found: true, value: '5', verdict: 'needs_work' },
        regime: { found: false, value: 'no regime filter', verdict: 'needs_work' },
        confidence: { found: true, value: 'heuristic', verdict: 'needs_work' },
        volCeiling: { found: true, value: '0.90', verdict: 'needs_work' },
      },
      blockers: [],
    }), 'utf-8')

    await writeFile(volumeBreakoutConfigGateStatusPath, JSON.stringify({
      status: 'pass',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      checks: {
        volumeMultiplier: { found: true, value: 2.5, verdict: 'ok', reason: 'adequate' },
        confidenceLogic: { found: true, verdict: 'needs_work', reason: 'shallow gradient', minConfidenceAtThreshold: 0.333, volumeComponentDynamicRange: 3.0 },
        stopLossPct: { found: true, value: 0.03, verdict: 'ok', reason: 'adequate' },
        minBreakQuality: { found: true, value: 0.35, verdict: 'ok', reason: 'adequate' },
      },
      blockers: [],
    }), 'utf-8')

    await writeFile(wfoStabilityGateStatusPath, JSON.stringify({
      status: 'pass',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      checks: {
        wfoStability: { found: true, available: true, verdict: 'pass' },
        paramStability: { found: true, available: true, verdict: 'pass' },
        stabilityReporting: { found: true, available: true, verdict: 'pass' },
      },
      blockers: [],
    }), 'utf-8')

    await writeFile(portfolioRiskManagementGateStatusPath, JSON.stringify({
      status: 'pass',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      checks: {
        portfolioRiskMgmt: { found: true, available: true, verdict: 'pass', details: ['Portfolio directory found'] },
        positionSizing: { found: true, available: true, verdict: 'pass', method: 'volTarget', targetVolPct: 15, maxPctOfEquity: 40, kellyFraction: null, layers: 3 },
        maxDrawdown: { found: true, available: true, verdict: 'pass', consecutiveLossDaysLimit: 5, dailyLossPctSoftCap: 3, maxDailyLossUsd: 1000 },
        correlationAware: { found: true, available: true, verdict: 'pass', methods: ['HCA'], details: ['HCA available'] },
      },
      blockers: [],
    }), 'utf-8')

    await writeFile(killSwitchGateStatusPath, JSON.stringify({
      status: 'pass',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      killSwitchEnabled: false,
      defaultPolicy: null,
      researchOnlyBlockedConsistent: true,
      checks: {
        killSwitchEnabled: { found: true, value: false, verdict: 'pass' },
        defaultPolicy: { found: true, value: null, verdict: 'pass' },
        consistentWithState: { found: true, value: true, verdict: 'pass' },
      },
      blockers: [],
      nextActions: [],
      safetyNotes: [],
    }), 'utf-8')

    await writeFile(accountCorruptionGateStatusPath, JSON.stringify({
      status: 'pass',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      checks: {
        accountFilesExist: { found: true, count: 3, verdict: '3 account state file(s) found' },
        corruptFiles: { found: false, corruptCount: 0, verdict: 'All files parsed successfully' },
        failClosedMechanism: { found: false, verdict: 'No corruption detected' },
      },
      blockers: [],
    }), 'utf-8')

    const report = await runStrategyDefectMonitor({
      outputPath,
      strategyDefectRegistryPath,
      researchLineRetirementPath,
      strategyReportPath: reportPath,
      crossSectionalPath: csPath,
      crossSectionalPaperPath: paperCsPath,
      volumeBreakoutPath: vbPath,
      microstructurePath: microPath,
      actionGatePath: actionPath,
      scoringPath,
      staleDataNoOpenGateStatusPath,
      panicRegimeNoOpenGateStatusPath,
      strategyRiskCapStatusPath,
      partialTakeProfitStatusPath,
      mfeMaeStoplossReportPath,
      okxOrderbookSpreadSnapshotPath,
      okxRouteCostSlippageReadinessPath,
      paperExecutionProducerContractStatusPath,
      paperExecutionFutureTelemetryWatchdogPath,
      ethCarryEvidencePath: ethPath,
      ethCarryDataGapStatusPath: ethDataGapPath,
      ethCarryProspectiveEvidencePath: ethProspectivePath,
      aiScientistIntakePath: aiPath,
      aiScientistSecondValidationQueuePath: aiQueuePath,
      aiScientistSourceManifestPath: aiSourceManifestPath,
      aiScientistReadinessPath: aiReadinessPath,
      aiScientistPitReproductionPlanPath: aiPitReproductionPlanPath,
      aiScientistPitInputDatasetPath: aiPitInputDatasetPath,
      aiScientistPitContractStatusPath: aiPitContractStatusPath,
      dynamicLeverageVolatilityGateStatusPath: dynamicLeverageVolatilityGateStatusPath,
      marketIntelNoOpenGateStatusPath,
      crossSectionalConfigGateStatusPath,
      volumeBreakoutConfigGateStatusPath,
      wfoStabilityGateStatusPath,
      portfolioRiskManagementGateStatusPath,
      killSwitchGateStatusPath,
      accountCorruptionGateStatusPath,
      json: false,
    })

    expect(report.status).toBe('blocked')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'strategy_defect_monitor',
      businessStatus: 'fail',
      recordsOut: 28,
    })
  })

  it('uses the structured defect registry when the legacy Downloads report is absent', () => {
    const report = buildStrategyDefectMonitorReport({
      generatedAt: '2026-05-06T00:00:00.000Z',
      sourceArtifacts: {
        strategyDefectRegistry: '/repo/data/research/strategy_defect_registry.latest.json',
        researchLineRetirement: '/repo/data/research/research_line_retirement.latest.json',
        strategyReport: '/Users/kino/Downloads/openalice_strategy_improvement.md',
        staleDataNoOpenGateStatus: '/tmp/stale_data_no_open_gate_status.json',
        panicRegimeNoOpenGateStatus: '/tmp/panic_regime_no_open_gate_status.json',
        strategyRiskCapStatus: '/tmp/strategy_risk_cap_status.json',
        partialTakeProfitStatus: '/tmp/partial_take_profit_status.json',
        mfeMaeStoplossReport: '/tmp/mfe_mae_stoploss_report.json',
        okxOrderbookSpreadSnapshot: '/tmp/okx_orderbook.json',
        okxRouteCostSlippageReadiness: '/tmp/okx_route_cost_slippage.json',
        paperExecutionProducerContractStatus: '/tmp/paper_execution_producer_contract.json',
        paperExecutionFutureTelemetryWatchdog: '/tmp/paper_execution_future_telemetry_watchdog.json',
        ethCarryEvidence: '/tmp/eth.json',
        ethCarryDataGapStatus: '/tmp/eth_data_gap.json',
        ethCarryProspectiveEvidence: '/tmp/eth_prospective.json',
        aiScientistIntake: '/tmp/ai.json',
        aiScientistSecondValidationQueue: '/tmp/ai_queue.json',
        aiScientistSourceManifest: '/tmp/ai_source_manifest.json',
        aiScientistReadiness: '/tmp/ai_readiness.json',
        aiScientistPitReproductionPlan: '/tmp/ai_pit_plan.json',
        aiScientistPitInputDataset: '/tmp/ai_pit_input_dataset.json',
        aiScientistPitContractStatus: '/tmp/ai_pit_contract_status.json',
        dynamicLeverageVolatilityGateStatus: '/tmp/dynamic_leverage_volatility_gate_status.json',
        decisionContextCoverageGateStatus: '/tmp/decision_context_coverage_gate_status.json',
        pitAuditGlobalGateStatus: '/tmp/pit_audit_global_gate_status.json',
        routeCostModelCompletenessGateStatus: '/tmp/route_cost_model_completeness_gate_status.json',
        marketIntelNoOpenGateStatus: '/tmp/market_intel_no_open_gate_status.json',
        crossSectionalConfigGateStatus: '/tmp/cross_sectional_config_gate_status.json',
        volumeBreakoutConfigGateStatus: '/tmp/volume_breakout_config_gate_status.json',
        wfoStabilityGateStatus: '/tmp/wfo_stability_gate_status.json',
        portfolioRiskManagementGateStatus: '/tmp/portfolio_risk_management_gate_status.json',
        killSwitchGateStatus: '/tmp/kill_switch_gate_status.json',
        accountCorruptionGateStatus: '/tmp/account_corruption_gate_status.json',
      },
      sources: {
        strategyReport: { path: '/Users/kino/Downloads/openalice_strategy_improvement.md', exists: false, text: '' },
        crossSectional: source('/tmp/cs.ts', 'maxSpreadBps: 10'),
        crossSectionalPaper: source('/tmp/paper_cs.ts', 'expectedHoldingHours: 24\ncomputeAtrTrailingStop'),
        volumeBreakout: source('/tmp/vb.ts', 'holdBars: 6,\nstopLossPct: 0.02,\nminVolumeUsd: 500_000,'),
        microstructure: source('/tmp/micro.ts', "id: 'liquidation_probe_100x', mode: 'stress_only'"),
        actionGate: source('/tmp/action.ts', 'const staleDataApplied = context.staleData === true; actionStatus = staleDataApplied ? "no-trade" : "ok"'),
        scoring: source('/tmp/scoring.ts', 'staleDataApplied'),
      },
      strategyDefectRegistry: {
        status: 'blocked',
        summary: {
          defects: 48,
          p0OpenOrPartial: 14,
          p1OpenOrPartial: 23,
        },
      },
      researchLineRetirement: researchLineRetirement(),
      staleDataNoOpenGateStatus: {
        status: 'pass',
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        executionAllowed: false,
        checks: {
          staleHighConfidenceActionStatus: 'no-trade',
          freshHighConfidenceActionStatus: 'attack',
          staleOpenDecisionMode: 'blocked',
          staleOpenBlockReason: 'strategy action status no-trade blocks new opens',
          staleReduceDecisionMode: 'pass-through',
          staleReducePassThrough: true,
        },
        blockers: [],
      },
      panicRegimeNoOpenGateStatus: panicRegimeNoOpenGateStatus(),
      strategyRiskCapStatus: strategyRiskCapStatus(),
      partialTakeProfitStatus: partialTakeProfitStatus(),
      mfeMaeStoplossReport: mfeMaeStoplossReport(),
      okxOrderbookSpreadSnapshot: null,
      okxRouteCostSlippageReadiness: null,
      paperExecutionProducerContractStatus: null,
      paperExecutionFutureTelemetryWatchdog: null,
      ethCarryEvidence: null,
      ethCarryDataGapStatus: null,
      ethCarryProspectiveEvidence: null,
      aiScientistIntake: null,
      aiScientistSecondValidationQueue: null,
      aiScientistSourceManifest: null,
      aiScientistReadiness: null,
      aiScientistPitReproductionPlan: null,
      aiScientistPitInputDataset: null,
      aiScientistPitContractStatus: null,
      dynamicLeverageVolatilityGateStatus: null,
      decisionContextCoverageGateStatus: null,
      pitAuditGlobalGateStatus: null,
      routeCostModelCompletenessGateStatus: null,
      marketIntelNoOpenGateStatus: null,
      crossSectionalConfigGateStatus: null,
      volumeBreakoutConfigGateStatus: null,
      wfoStabilityGateStatus: null,
      portfolioRiskManagementGateStatus: null,
      killSwitchGateStatus: null,
      accountCorruptionGateStatus: null,
    })

    const finding = report.findings.find(item => item.id === 'strategy_report_loaded')
    expect(finding).toMatchObject({
      status: 'watch',
      observed: {
        legacyReportExists: false,
        registryExists: true,
        registryDefects: 48,
      },
      blockers: [],
    })
    expect(report.blockers).not.toContain('strategy_report_loaded:strategy_improvement_report_missing')
  })
})

function source(path: string, text: string) {
  return { path, exists: true, text }
}

function researchLineRetirement() {
  return {
    generatedAt: '2026-05-05T15:28:55.461Z',
    verdict: 'retire_current_line',
    lineHealth: 'retired',
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    policyMutationAllowed: false,
    requiredBeforeReactivation: [
      'new_alpha_hypothesis_or_materially_different_feature_set',
      'runtime_verified_non_stale_route_costs',
      'wfo_failed_window_ratio_lte_threshold_and_direction_stable',
      'complete_trial_ledger_with_by_fdr',
      'pit_audit_pass',
      'prospective_closed_outcomes_gte_100_across_3_non_overlapping_windows',
      'paper_execution_evidence_after_release_gate',
    ],
  }
}

function panicRegimeNoOpenGateStatus() {
  return {
    status: 'pass',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      eventFreezeRegime: 'event-risk-freeze',
      eventFreezeActionStatus: 'reduce',
      eventFreezeBaseActionStatus: 'attack-lite',
      eventFreezeCappedByEventWindow: true,
      eventFreezeOpenDecisionMode: 'blocked',
      eventFreezeOpenBlockReason: 'strategy action status reduce blocks new opens',
      eventFreezeReduceDecisionMode: 'pass-through',
      eventFreezeReducePassThrough: true,
      volStressRegime: 'vol-stress',
      volStressConfidence: 0.94,
      volStressOpenDecisionMode: 'blocked',
      volStressOpenBlockReason: 'strategy action status reduce blocks new opens',
      volStressReduceDecisionMode: 'pass-through',
      volStressReducePassThrough: true,
    },
    blockers: [],
  }
}

function strategyRiskCapStatus() {
  return {
    status: 'pass',
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      singleTradeLossProbe: {
        approved: false,
        reason: 'Risk if filled $200.00 exceeds maxSingleTradeLossUsd $150.',
      },
      totalExposureProbe: {
        approved: false,
        reason: 'Projected total exposure 65.0% exceeds maxTotalExposurePctOfEquity 60%.',
      },
      symbolConcentrationProbe: {
        approved: false,
        reason: 'Projected symbol exposure 45.0% exceeds maxSymbolExposurePctOfEquity 40%.',
      },
      netDirectionalExposureProbe: {
        approved: false,
        reason: 'Projected net directional exposure 45.0% exceeds maxNetDirectionalExposurePctOfEquity 40%.',
      },
      correlatedGroupExposureProbe: {
        approved: false,
        reason: 'Projected correlated group exposure 65.0% exceeds maxCorrelatedGroupExposurePctOfEquity 60%.',
      },
      reduceOnlyPassThroughProbe: {
        approved: true,
        reason: null,
      },
      maxSingleTradeLossUsdConfigured: 150,
      maxTotalExposurePctOfEquityConfigured: 60,
      maxSymbolExposurePctOfEquityConfigured: 40,
      maxNetDirectionalExposurePctOfEquityConfigured: 40,
      maxCorrelatedGroupExposurePctOfEquityConfigured: 60,
      maxOrderUsdConfigured: 5000,
      maxPositionPctOfEquityConfigured: 50,
    },
    blockers: [],
  }
}

function partialTakeProfitStatus() {
  return {
    status: 'pass',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      longFirstTrancheCloseFraction: 0.5,
      longFirstTrancheCloseQuantity: 5,
      longIncrementalCloseFraction: 0.25,
      shortFirstTrancheCloseFraction: 0.5,
      notTriggeredCloseFraction: 0,
      levelCount: 2,
      totalConfiguredCloseFraction: 0.75,
    },
    blockers: [],
  }
}

function mfeMaeStoplossReport() {
  return {
    schemaVersion: 1,
    metricBasis: 'price_path_bps',
    profitabilityClaimAllowed: false,
    promotionClaimAllowed: false,
    executionReplayClaimAllowed: false,
    coverage: {
      closedTrades: 947,
      closedDiagnosticsOk: 947,
      stopLossTrades: 42,
      stopLossDiagnosticsOk: 42,
      stopLossDiagnosticsOkPct: 100,
      stopLossKnownOrdering: 38,
      stopLossCoarseOrdering: 4,
    },
    stopLossSummary: {
      avgMfeBps: 2.74,
      avgMaeBps: -27.34,
      medianMfeBps: 0.45,
      medianMaeBps: -16.09,
      mfeBeforeStopSharePct: 100,
    },
    stopLossAttribution: {
      status: 'blocked_diagnostic_only',
      promotionEligible: false,
      policyMutationAllowed: false,
      profitabilityClaimAllowed: false,
      blockerSummary: {
        missingRoundTripCostAtOpenCount: 42,
        missingMarkMatchStatusAtOpenCount: 42,
        legacyOrMissingContextCount: 42,
        coarseOrderingAmbiguousCount: 4,
      },
    },
  }
}

function makeFutureTelemetryWatchdog() {
  return {
    status: 'watch_waiting_for_future_rows',
    researchOnly: true,
    diagnosticOnly: true,
    futureOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    counts: {
      futureClosedRows: 0,
      futureClosedRowsWithOpenAfterStart: 0,
      futureRowsWithPaperFillTelemetry: 0,
      futureRowsWithCompletePredictedOpenEvidence: 0,
      futureRowsWithExchangeReconciledCostEvidence: 0,
      futureRowsWithObservedSlippage: 0,
    },
    coverage: {
      futurePaperFillTelemetryCoveragePct: null,
      futureNewOpenPredictedOpenEvidenceCoveragePct: null,
      futureExchangeReconciledCostCoveragePct: null,
      futureObservedSlippageCoveragePct: null,
    },
    readiness: {
      futurePaperFillTelemetrySufficient: false,
      futurePredictedOpenEvidenceSufficient: true,
      exchangeReconciledCostEvidenceAvailable: false,
      observedSlippageAvailable: false,
    },
    blockers: [],
    evidenceBlockers: [
      'future_closed_paper_rows_missing',
      'future_new_open_closed_rows_missing',
      'exchange_reconciled_cost_evidence_missing',
      'observed_slippage_unavailable',
      'paper_execution_future_watchdog_diagnostic_only',
    ],
  }
}

function makeReadyFutureProducerContractStatus(input: {
  closedTrades: number
  tradesWithPaperFillTelemetry: number
}) {
  return {
    status: 'ready_future_only',
    researchOnly: true,
    diagnosticOnly: true,
    futureProducerOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    producerContract: {
      futurePaperCloseRowsReady: true,
    },
    historicalExecutionQuality: {
      closedTrades: input.closedTrades,
      tradesWithPaperFillTelemetry: input.tradesWithPaperFillTelemetry,
      paperFillTelemetryCoveragePct: input.closedTrades > 0
        ? input.tradesWithPaperFillTelemetry / input.closedTrades * 100
        : 0,
      tradesWithExchangeReconciledCostEvidence: 0,
      observedSlippageAvailable: false,
    },
    blockers: [
      `historical_paper_fill_telemetry_coverage_low:${input.tradesWithPaperFillTelemetry}/${input.closedTrades}`,
      'exchange_reconciled_cost_evidence_missing',
      'observed_slippage_unavailable',
    ],
  }
}

function marketIntelNoOpenGateStatus() {
  return {
    status: 'pass',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      riskOffOpenContextStatus: 'risk_off',
      riskOffRejectReasons: ['context_status:risk_off'],
      severeNewsOpenContextStatus: 'severe_news',
      severeNewsRejectReasons: ['context_status:severe_news'],
      laneBlockedOpenContextStatus: 'lane_blocked',
      laneBlockedRejectReasons: ['context_status:lane_blocked'],
      symbolBlockedOpenContextStatus: 'symbol_blocked',
      symbolBlockedRejectReasons: ['context_status:symbol_blocked'],
      allowedOpenContextStatus: 'ok',
      allowedRejectReasons: [],
    },
    blockers: [],
  }
}
