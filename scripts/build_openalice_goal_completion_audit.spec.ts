import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildOpenAliceGoalCompletionAuditReport,
  parseOpenAliceGoalCompletionAuditArgs,
  runOpenAliceGoalCompletionAudit,
} from './build_openalice_goal_completion_audit.js'

describe('build_openalice_goal_completion_audit', () => {
  it('parses defaults and keeps the package script wired', () => {
    expect(parseOpenAliceGoalCompletionAuditArgs(['--output', 'null', '--json'])).toMatchObject({
      outputPath: null,
      reasonChainPath: 'data/runtime/system_status_reason_chain.latest.json',
      dataCatalogPath: 'data/runtime/openalice_data_catalog.latest.json',
      ethCarryDataGapStatusPath: 'data/research/eth_carry_data_gap_status.latest.json',
      ethCarryProspectiveEvidencePath: 'data/research/eth_carry_prospective_evidence_status.latest.json',
      aiScientistPitRebuildQueuePath: 'data/research/ai_scientist_openalice_pit_rebuild_queue.latest.json',
      aiScientistOhlcvDailySupplementPlanPath: 'data/research/ai_scientist_openalice_ohlcv_daily_supplement_plan.latest.json',
      aiScientistPitNativeRebuildStatusPath: 'data/research/ai_scientist_openalice_pit_native_rebuild_status.latest.json',
      aiScientistOhlcvNativeRowsPath: 'data/research/ai_scientist_openalice_ohlcv_native_rows.latest.json',
      ohlcvCollectorPitContractStatusPath: 'data/research/openalice_ohlcv_collector_pit_contract_status.latest.json',
      strategyQualityGateCoveragePath: 'data/research/strategy_quality_gate_coverage.latest.json',
      externalWarehouseRoot: join(process.cwd(), 'data'),
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['status:goal-completion']).toContain('build_openalice_goal_completion_audit.ts')
    expect(scripts['status:research-evidence']).toContain('build_openalice_goal_completion_audit.ts')
    expect(scripts['status:research-evidence']).toContain('build_openalice_ohlcv_collector_pit_contract_status.ts')
  })

  it('summarizes the active goal as blocked without authorizing execution', () => {
    const report = buildOpenAliceGoalCompletionAuditReport(blockedFixture({
      externalWarehouseRootExists: true,
      aiScientistRootExists: true,
    }))

    expect(report).toMatchObject({
      schemaVersion: 1,
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'blocked',
      goalComplete: false,
      effectiveActionability: 'research_only_blocked',
      overallPlanCompletionPct: 49,
      observedGateState: {
        reasonChainPaperTradingAllowed: false,
        reasonChainLiveTradingAllowed: false,
        reasonChainCanPromote: false,
        releaseGateAllowPaperTrading: false,
        releaseGateAllowLiveTrading: false,
        paperGateFinalAllowPaperTrading: false,
      },
      summary: {
        requiredItems: 13,
        dataCatalogStatus: 'blocked',
        dataCatalogComplete: 35,
        dataCatalogDatasets: 99,
        strategyDefectStatus: 'blocked',
        strategyQualityGateCoverageStatus: 'blocked',
        quantFrameworkStatus: 'blocked',
        ethCarryProspectiveStatus: 'has_closed_labels',
        aiScientistReadinessStatus: 'blocked_openalice_validation_missing',
        aiScientistPitNativeRebuildStatus: 'blocked_native_lineage_not_ready',
        ohlcvCollectorPitStatus: 'ready_for_pit_audit_research_only',
        schedulerSecurityStatus: 'pass',
      },
    })
    expect(report.goalChecklistCompletionPct).toBeGreaterThan(30)
    expect(report.goalChecklistCompletionPct).toBeLessThan(80)
    expect(report.items.find(item => item.id === 'okx_public_private_fee_storage')).toMatchObject({
      status: 'pass',
      completionPct: 100,
      metrics: {
        liveDataStatus: 'fresh',
        okxPrivateAuthStatus: 'auth_available',
        runtimeFeeStatus: 'runtime_verified',
      },
    })
    expect(report.items.find(item => item.id === 'external_warehouse_root')).toMatchObject({
      status: 'pass',
      completionPct: 100,
    })
    expect(report.items.find(item => item.id === 'multi_source_data_catalog')).toMatchObject({
      status: 'blocked',
      metrics: {
        status: 'blocked',
        datasets: 99,
        complete: 35,
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
      },
      blockers: expect.arrayContaining([
        'openalice_data_catalog_status:blocked',
        'openalice_data_catalog:binance_public_incomplete:30/81',
        'openalice_data_catalog:point_in_time_feature_snapshot_missing',
      ]),
    })
    expect(report.items.find(item => item.id === 'ai_scientist_openalice_second_validation')).toMatchObject({
      status: 'blocked',
      metrics: {
        requiredGateCount: 11,
        missingGateCount: 8,
        pitRebuildQueueStatus: 'blocked_waiting_for_openalice_native_rebuild',
        pitRebuildOpenTasks: 6,
        pitRebuildMissingAvailableAtTasks: 6,
        pitRebuildMissingObservedOrFetchedAtTasks: 6,
        pitNativeRebuildStatus: 'blocked_native_lineage_not_ready',
        pitNativeAutoRebuildEligibleTasks: 0,
        pitNativeRequiredCollectorUpgradeTasks: 6,
        pitNativeRawKlineManifestWithPromotionGradeTimeFieldsTasks: 0,
        pitNativeDerivativesPitUsableTasks: 0,
        ohlcvCollectorPitStatus: 'ready_for_pit_audit_research_only',
        ohlcvCollectorPitRows: 300,
        ohlcvCollectorRowExplicitAvailableAt: 300,
        ohlcvCollectorRowExplicitObservedOrFetchedAt: 300,
        ohlcvCollectorPromotionGradeRows: 0,
        ohlcvNativeRowsStatus: 'research_rows_materialized_pit_blocked',
        ohlcvDailySupplementStatus: 'planned_research_only_daily_supplement',
        ohlcvDailySupplementEntries: 6,
        ohlcvDailySupplementLocal: 0,
        ohlcvDailySupplementNotChecked: 6,
        ohlcvNativeRowsWritten: 1500,
        ohlcvNativeRowsPromotionGradeRows: 0,
        rowsPromotionGrade: 0,
      },
      blockers: expect.arrayContaining([
        'ai_scientist_missing_openalice_gates:8',
        'ai_scientist_pit_rebuild_tasks_open:6',
        'ai_scientist_pit_native_auto_rebuild_eligible_missing:0',
        'ai_scientist_promotion_grade_rows_missing:0',
        'ohlcv_daily_supplement_plan:daily_supplement_probe_not_run',
        'ohlcv_native_rows:row_pit_usable_for_promotion_false',
        'pit_rebuild_queue:ai_scientist_pit_available_at_rebuild_required:6',
        'pit_native_rebuild:ai_scientist_pit_ohlcv_collector_upgrade_required:6',
        'pit_contract:row_explicit_available_at_missing:0/500',
      ]),
    })
    expect(report.items.find(item => item.id === 'eth_carry_pit_basis_data')).toMatchObject({
      status: 'blocked',
      metrics: {
        pitFeaturesStatus: 'ready_for_research',
        pitAuditStatus: 'pass',
        carryFeatureRows: 14,
        minCarryFeatureRows: 100,
        dataGapStatus: 'blocked_insufficient_research_data',
        dataGapCollectorErrorCount: 10,
        fundingAvailableTimeStatus: 'complete',
        basisAvailableTimeStatus: 'present',
      },
      blockers: expect.arrayContaining([
        'eth_carry_data_gap_carry_feature_rows_low:14<100',
        'eth_carry_data_gap_collector_errors:10',
      ]),
    })
    expect(report.items.find(item => item.id === 'eth_carry_prospective_evidence')).toMatchObject({
      status: 'blocked',
      metrics: {
        closedOutcomes: 2,
        closedDecisionWindows: 2,
        meanGrossCarryPairReturnPct: -0.600451856,
        dataGapStatus: 'blocked_insufficient_research_data',
        dataGapProspectiveClosedOutcomeShortfall: 98,
      },
      blockers: expect.arrayContaining([
        'eth_carry_prospective_closed_outcomes_low:2<100',
        'eth_carry_prospective_closed_windows_low:2<3',
        'eth_carry_prospective_mean_gross_non_positive:-0.600451856',
        'eth_carry_data_gap:prospective_closed_outcomes_low:2<100',
      ]),
    })
    expect(report.items.find(item => item.id === 'paper_live_release_gate_profitability')).toMatchObject({
      status: 'blocked',
      completionPct: 0,
      blockers: expect.arrayContaining([
        'reason_chain_can_promote_false',
        'release_gate_paper_trading_not_allowed',
        'paper_gate_final_allow_paper_false',
        'reason_chain_paper_trading_not_allowed',
        'live_trading_not_allowed',
      ]),
    })
    expect(report.items.find(item => item.id === 'safety_invariants')).toMatchObject({
      status: 'pass',
      completionPct: 100,
      metrics: {
        thisArtifactPromotionEligible: false,
        thisArtifactPaperTradingAllowed: false,
        thisArtifactLiveTradingAllowed: false,
        sourceAuthorizationAttempts: false,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'multi_source_data_catalog:openalice_data_catalog_status:blocked',
      'ai_scientist_openalice_second_validation:ai_scientist_missing_openalice_gates:8',
      'quant_framework_benchmark:quant_framework_blocked_capabilities:10',
      'strategy_defect_registry_monitor:strategy_defects_open_or_partial:43',
      'strategy_quality_gate_coverage:p0p1_open_or_partial_defects_without_monitor:19',
      'eth_carry_pit_basis_data:eth_carry_data_gap_carry_feature_rows_low:14<100',
      'eth_carry_prospective_evidence:eth_carry_prospective_mean_gross_non_positive:-0.600451856',
      'paper_live_release_gate_profitability:reason_chain_can_promote_false',
    ]))
  })

  it('detects diagnostic artifacts that try to authorize execution', () => {
    const fixture = blockedFixture({
      externalWarehouseRootExists: true,
      aiScientistRootExists: true,
    })
    fixture.ethCarryResearchEvidence = {
      ...fixture.ethCarryResearchEvidence,
      paperTradingAllowed: true,
    }

    const report = buildOpenAliceGoalCompletionAuditReport(fixture)

    expect(report.goalComplete).toBe(false)
    expect(report.blockers).toContain('diagnostic_source_artifact_attempts_to_authorize_execution')
    expect(report.items.find(item => item.id === 'safety_invariants')).toMatchObject({
      status: 'blocked',
      blockers: ['research_or_diagnostic_artifact_attempts_to_authorize_execution'],
      metrics: {
        sourceAuthorizationAttempts: true,
      },
    })
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-goal-audit-'))
    const runtimeDir = join(root, 'data', 'runtime')
    const researchDir = join(root, 'data', 'research')
    const warehouseRoot = join(root, 'warehouse')
    const aiScientistRoot = join(root, 'ai_scientist')
    await mkdir(runtimeDir, { recursive: true })
    await mkdir(researchDir, { recursive: true })
    await mkdir(warehouseRoot, { recursive: true })
    await mkdir(aiScientistRoot, { recursive: true })

    const fixture = blockedFixture({
      sourceArtifacts: sourceArtifactsForRoot(root, warehouseRoot, aiScientistRoot),
      externalWarehouseRootExists: true,
      aiScientistRootExists: true,
    })
    await writeJson(fixture.sourceArtifacts.reasonChain, fixture.reasonChain)
    await writeJson(fixture.sourceArtifacts.dataCatalog, fixture.dataCatalog)
    await writeJson(fixture.sourceArtifacts.liveDataFreshness, fixture.liveDataFreshness)
    await writeJson(fixture.sourceArtifacts.okxPrivateAuth, fixture.okxPrivateAuth)
    await writeJson(fixture.sourceArtifacts.feeSnapshotRefresh, fixture.feeSnapshotRefresh)
    await writeJson(fixture.sourceArtifacts.schedulerSecurityAudit, fixture.schedulerSecurityAudit)
    await writeJson(fixture.sourceArtifacts.releaseGateStatus, fixture.releaseGateStatus)
    await writeJson(fixture.sourceArtifacts.paperGateStatus, fixture.paperGateStatus)
    await writeJson(fixture.sourceArtifacts.strategyDefectMonitor, fixture.strategyDefectMonitor)
    await writeJson(fixture.sourceArtifacts.strategyDefectRegistry, fixture.strategyDefectRegistry)
    await writeJson(fixture.sourceArtifacts.strategyQualityGateCoverage, fixture.strategyQualityGateCoverage)
    await writeJson(fixture.sourceArtifacts.quantFrameworkBenchmark, fixture.quantFrameworkBenchmark)
    await writeJson(fixture.sourceArtifacts.ethCarryResearchEvidence, fixture.ethCarryResearchEvidence)
    await writeJson(fixture.sourceArtifacts.ethCarryDataGapStatus, fixture.ethCarryDataGapStatus)
    await writeJson(fixture.sourceArtifacts.ethCarryPitFeatures, fixture.ethCarryPitFeatures)
    await writeJson(fixture.sourceArtifacts.ethCarryPitAudit, fixture.ethCarryPitAudit)
    await writeJson(fixture.sourceArtifacts.ethCarryProspectiveEvidence, fixture.ethCarryProspectiveEvidence)
    await writeJson(fixture.sourceArtifacts.aiScientistIntake, fixture.aiScientistIntake)
    await writeJson(fixture.sourceArtifacts.aiScientistSourceManifest, fixture.aiScientistSourceManifest)
    await writeJson(fixture.sourceArtifacts.aiScientistSecondValidationQueue, fixture.aiScientistSecondValidationQueue)
    await writeJson(fixture.sourceArtifacts.aiScientistSecondValidationReadiness, fixture.aiScientistSecondValidationReadiness)
    await writeJson(fixture.sourceArtifacts.aiScientistPitRebuildQueue, fixture.aiScientistPitRebuildQueue)
    await writeJson(fixture.sourceArtifacts.aiScientistOhlcvNativeRebuildPlan, fixture.aiScientistOhlcvNativeRebuildPlan)
    await writeJson(fixture.sourceArtifacts.aiScientistOhlcvDailySupplementPlan, fixture.aiScientistOhlcvDailySupplementPlan)
    await writeJson(fixture.sourceArtifacts.aiScientistOhlcvNativeRows, fixture.aiScientistOhlcvNativeRows)
    await writeJson(fixture.sourceArtifacts.aiScientistPitNativeRebuildStatus, fixture.aiScientistPitNativeRebuildStatus)
    await writeJson(fixture.sourceArtifacts.aiScientistPitInputDataset, fixture.aiScientistPitInputDataset)
    await writeJson(fixture.sourceArtifacts.aiScientistPitContractStatus, fixture.aiScientistPitContractStatus)
    await writeJson(fixture.sourceArtifacts.ohlcvCollectorPitContractStatus, fixture.ohlcvCollectorPitContractStatus)

    const outputPath = join(runtimeDir, 'openalice_goal_completion_audit.latest.json')
    const report = await runOpenAliceGoalCompletionAudit({
      outputPath,
      reasonChainPath: fixture.sourceArtifacts.reasonChain,
      dataCatalogPath: fixture.sourceArtifacts.dataCatalog,
      liveDataFreshnessPath: fixture.sourceArtifacts.liveDataFreshness,
      okxPrivateAuthPath: fixture.sourceArtifacts.okxPrivateAuth,
      feeSnapshotRefreshPath: fixture.sourceArtifacts.feeSnapshotRefresh,
      schedulerSecurityAuditPath: fixture.sourceArtifacts.schedulerSecurityAudit,
      releaseGateStatusPath: fixture.sourceArtifacts.releaseGateStatus,
      paperGateStatusPath: fixture.sourceArtifacts.paperGateStatus,
      strategyDefectMonitorPath: fixture.sourceArtifacts.strategyDefectMonitor,
      strategyDefectRegistryPath: fixture.sourceArtifacts.strategyDefectRegistry,
      strategyQualityGateCoveragePath: fixture.sourceArtifacts.strategyQualityGateCoverage,
      quantFrameworkBenchmarkPath: fixture.sourceArtifacts.quantFrameworkBenchmark,
      ethCarryResearchEvidencePath: fixture.sourceArtifacts.ethCarryResearchEvidence,
      ethCarryDataGapStatusPath: fixture.sourceArtifacts.ethCarryDataGapStatus,
      ethCarryPitFeaturesPath: fixture.sourceArtifacts.ethCarryPitFeatures,
      ethCarryPitAuditPath: fixture.sourceArtifacts.ethCarryPitAudit,
      ethCarryProspectiveEvidencePath: fixture.sourceArtifacts.ethCarryProspectiveEvidence,
      aiScientistIntakePath: fixture.sourceArtifacts.aiScientistIntake,
      aiScientistSourceManifestPath: fixture.sourceArtifacts.aiScientistSourceManifest,
      aiScientistSecondValidationQueuePath: fixture.sourceArtifacts.aiScientistSecondValidationQueue,
      aiScientistSecondValidationReadinessPath: fixture.sourceArtifacts.aiScientistSecondValidationReadiness,
      aiScientistPitRebuildQueuePath: fixture.sourceArtifacts.aiScientistPitRebuildQueue,
      aiScientistOhlcvNativeRebuildPlanPath: fixture.sourceArtifacts.aiScientistOhlcvNativeRebuildPlan,
      aiScientistOhlcvDailySupplementPlanPath: fixture.sourceArtifacts.aiScientistOhlcvDailySupplementPlan,
      aiScientistOhlcvNativeRowsPath: fixture.sourceArtifacts.aiScientistOhlcvNativeRows,
      aiScientistPitNativeRebuildStatusPath: fixture.sourceArtifacts.aiScientistPitNativeRebuildStatus,
      aiScientistPitInputDatasetPath: fixture.sourceArtifacts.aiScientistPitInputDataset,
      aiScientistPitContractStatusPath: fixture.sourceArtifacts.aiScientistPitContractStatus,
      ohlcvCollectorPitContractStatusPath: fixture.sourceArtifacts.ohlcvCollectorPitContractStatus,
      externalWarehouseRoot: warehouseRoot,
      aiScientistRoot,
      json: false,
    })

    expect(report.status).toBe('blocked')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      goalComplete: false,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'openalice_goal_completion_audit',
      businessStatus: 'fail',
      recordsOut: 13,
    })
  })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function sourceArtifactsForRoot(root: string, warehouseRoot: string, aiScientistRoot: string) {
  return {
    reasonChain: join(root, 'data/runtime/system_status_reason_chain.latest.json'),
    dataCatalog: join(root, 'data/runtime/openalice_data_catalog.latest.json'),
    liveDataFreshness: join(root, 'data/runtime/live_data_freshness.latest.json'),
    okxPrivateAuth: join(root, 'data/runtime/okx_private_auth_diagnosis.latest.json'),
    feeSnapshotRefresh: join(root, 'data/runtime/fee_snapshot_refresh.latest.json'),
    schedulerSecurityAudit: join(root, 'data/runtime/scheduler_security_audit.latest.json'),
    releaseGateStatus: join(root, 'data/runtime/release_gate_status.json'),
    paperGateStatus: join(root, 'data/runtime/paper_gate_status.json'),
    strategyDefectMonitor: join(root, 'data/research/strategy_defect_monitor.latest.json'),
    strategyDefectRegistry: join(root, 'data/research/strategy_defect_registry.latest.json'),
    strategyQualityGateCoverage: join(root, 'data/research/strategy_quality_gate_coverage.latest.json'),
    quantFrameworkBenchmark: join(root, 'data/research/quant_framework_benchmark_report.latest.json'),
    ethCarryResearchEvidence: join(root, 'data/research/eth_carry_research_evidence_status.latest.json'),
    ethCarryDataGapStatus: join(root, 'data/research/eth_carry_data_gap_status.latest.json'),
    ethCarryPitFeatures: join(root, 'data/research/eth_carry_pit_features.latest.json'),
    ethCarryPitAudit: join(root, 'data/research/eth_carry_pit_audit.latest.json'),
    ethCarryProspectiveEvidence: join(root, 'data/research/eth_carry_prospective_evidence_status.latest.json'),
    aiScientistIntake: join(root, 'data/research/ai_scientist_crypto_candidate_intake.latest.json'),
    aiScientistSourceManifest: join(root, 'data/research/ai_scientist_openalice_candidate_source_manifest.latest.json'),
    aiScientistSecondValidationQueue: join(root, 'data/research/ai_scientist_openalice_second_validation_queue.latest.json'),
    aiScientistSecondValidationReadiness: join(root, 'data/research/ai_scientist_openalice_second_validation_readiness.latest.json'),
    aiScientistPitRebuildQueue: join(root, 'data/research/ai_scientist_openalice_pit_rebuild_queue.latest.json'),
    aiScientistOhlcvNativeRebuildPlan: join(root, 'data/research/ai_scientist_openalice_ohlcv_native_rebuild_plan.latest.json'),
    aiScientistOhlcvDailySupplementPlan: join(root, 'data/research/ai_scientist_openalice_ohlcv_daily_supplement_plan.latest.json'),
    aiScientistOhlcvNativeRows: join(root, 'data/research/ai_scientist_openalice_ohlcv_native_rows.latest.json'),
    aiScientistPitNativeRebuildStatus: join(root, 'data/research/ai_scientist_openalice_pit_native_rebuild_status.latest.json'),
    aiScientistPitInputDataset: join(root, 'data/research/ai_scientist_openalice_pit_input_dataset.latest.json'),
    aiScientistPitContractStatus: join(root, 'data/research/ai_scientist_openalice_pit_contract_status.latest.json'),
    ohlcvCollectorPitContractStatus: join(root, 'data/research/openalice_ohlcv_collector_pit_contract_status.latest.json'),
    externalWarehouseRoot: warehouseRoot,
    aiScientistRoot,
  }
}

function blockedFixture(overrides: {
  sourceArtifacts?: ReturnType<typeof sourceArtifactsForRoot>
  externalWarehouseRootExists: boolean
  aiScientistRootExists: boolean
}) {
  const sourceArtifacts = overrides.sourceArtifacts ?? sourceArtifactsForRoot(
    '/tmp/openalice',
    '/Volumes/shield/cryptoData/openalice-data',
    '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl',
  )
  return {
    generatedAt: '2026-05-06T14:45:00.000Z',
    sourceArtifacts,
    reasonChain: {
      generatedAt: '2026-05-06T14:27:11.410Z',
      overallPlanCompletionPct: 49,
      effectiveActionability: 'research_only_blocked',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      canPromote: false,
    },
    dataCatalog: {
      status: 'blocked',
      warehouseRoot: sourceArtifacts.externalWarehouseRoot,
      aiScientistRoot: sourceArtifacts.aiScientistRoot,
      summary: {
        datasets: 99,
        complete: 35,
        partial: 12,
        missing: 52,
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
      objectiveCoverage: {
        observedFamilies: ['market', 'derivatives', 'onchain', 'asset_metadata', 'normalized', 'research_candidates'],
        observedLayers: ['raw', 'normalized/parquet', 'audit', 'runtime', 'derived'],
      },
      blockers: [
        'binance_public_incomplete:30/81',
        'point_in_time_feature_snapshot_missing',
        'ai_scientist_candidates_require_openalice_second_validation',
      ],
      nextActions: ['Continue warehouse backfills.'],
    },
    liveDataFreshness: {
      status: 'fresh',
      summary: {
        publicDataUsableForLiveOnlyResearch: true,
        presentAssets: 78,
        freshAssets: 78,
      },
      blockers: [],
    },
    okxPrivateAuth: {
      status: 'auth_available',
      bestMode: 'production',
      credentialPresence: {
        apiKey: true,
        secret: true,
        password: true,
      },
      blockers: [],
    },
    feeSnapshotRefresh: {
      status: 'runtime_verified',
      snapshotWritten: true,
      perSymbolFeesCount: 3,
      blockers: [],
    },
    schedulerSecurityAudit: {
      status: 'pass',
      findings: [],
    },
    releaseGateStatus: {
      allowPaperTrading: false,
      allowLiveTrading: false,
      failedChecks: ['wfo', 'significance', 'risk_simulation', 'economics'],
    },
    paperGateStatus: {
      finalAllowPaperTrading: false,
      blockingReasons: ['release_gate_not_approved'],
    },
    strategyDefectMonitor: {
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'blocked',
      summary: {
        findings: 11,
        blocked: 3,
        p0Blocked: 2,
      },
      blockers: [
        'carry_prospective_evidence:prospective_closed_outcomes_low:2<100',
        'carry_prospective_evidence:prospective_mean_gross_non_positive:-0.600451856',
      ],
    },
    strategyDefectRegistry: {
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'blocked',
      summary: {
        defects: 48,
        open: 24,
        partial: 19,
        watch: 5,
        p0OpenOrPartial: 14,
        p1OpenOrPartial: 23,
      },
      blockers: [
        '5.6:carry_prospective_samples_or_return_not_sufficient',
        '2.5:slippage_estimation_or_telemetry_missing',
      ],
    },
    strategyQualityGateCoverage: {
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked',
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
      blockers: [
        'p0_open_or_partial_defects_without_monitor:4',
        'p1_open_or_partial_defects_without_monitor:15',
      ],
      nextActions: [
        'Turn every uncovered P0/P1 strategy defect into a small monitor.',
      ],
    },
    quantFrameworkBenchmark: {
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'blocked',
      summary: {
        frameworks: 6,
        capabilities: 10,
        blockedCapabilities: 10,
        p0RelatedOpenOrPartialDefects: 14,
        dataCatalogStatus: 'blocked',
        reasonChainActionability: 'research_only_blocked',
      },
      blockers: [
        'backtest_live_parity:related_defect_open_or_partial:5.6',
        'order_book_matching:related_defect_open_or_partial:2.5',
      ],
    },
    ethCarryResearchEvidence: {
      researchOnly: true,
      diagnosticOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'research_only_blocked',
      pitEvidence: {
        fundingExplicitAvailableTimeCoveragePct: 100,
        fundingAvailableTimeStatus: 'complete',
        basisAvailableTimeStatus: 'present',
        pointInTimeUsableForPromotion: false,
      },
      basisEvidence: {
        available: true,
      },
    },
    ethCarryDataGapStatus: {
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
      },
      counts: {
        sourceEvents: 259,
        fundingEvents: 22,
        basisSnapshots: 29,
        carryFeatureRows: 14,
        sourceLineageIncompleteRows: 25,
        prospectiveClosedOutcomes: 2,
        prospectiveClosedDecisionWindows: 2,
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
    ethCarryPitFeatures: {
      status: 'ready_for_research',
      sourceEvents: 259,
      fundingEvents: 22,
      basisSnapshots: 29,
      carryFeatureRows: 14,
      blockers: [],
    },
    ethCarryPitAudit: {
      status: 'pass',
      passingRows: 14,
      totalRows: 14,
      blockers: [],
    },
    ethCarryProspectiveEvidence: {
      researchOnly: true,
      prospectiveOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'has_closed_labels',
      counts: {
        openEvents: 3,
        closedEvents: 2,
        closedDecisionWindows: 2,
      },
      metrics: {
        closedOutcomes: 2,
        meanGrossCarryPairReturnPct: -0.600451856,
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
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'research_only_blocked',
      counts: {
        candidatesFound: 3,
      },
    },
    aiScientistSourceManifest: {
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'locked_research_only',
      counts: {
        candidatesLocked: 3,
        sourceFilesMissing: 0,
      },
    },
    aiScientistSecondValidationQueue: {
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'queued_research_only',
      counts: {
        requiredGateCount: 11,
        missingGateCount: 8,
      },
      blockers: [
        'openalice_second_validation_queued_not_completed',
        'paper_execution_telemetry_missing',
      ],
    },
    aiScientistSecondValidationReadiness: {
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_openalice_validation_missing',
      counts: {
        totalGates: 11,
        missingOpenAliceEvidenceGates: 8,
      },
      blockers: [
        'openalice_second_validation_readiness_research_only',
        'openalice_validation_gates_not_complete',
      ],
    },
    aiScientistPitRebuildQueue: {
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_waiting_for_openalice_native_rebuild',
      counts: {
        rebuildTasks: 6,
        openTasks: 6,
        missingAvailableAtTasks: 6,
        missingObservedOrFetchedAtTasks: 6,
        incompleteWarehouseLineageTasks: 6,
      },
      blockers: [
        'ai_scientist_pit_rebuild_tasks_open:6',
        'ai_scientist_pit_available_at_rebuild_required:6',
        'ai_scientist_pit_observed_or_fetched_at_rebuild_required:6',
        'ai_scientist_pit_complete_warehouse_lineage_required:6',
        'ai_scientist_pit_rebuild_queue_research_only',
      ],
    },
    aiScientistOhlcvNativeRebuildPlan: {
      schemaVersion: 1,
      generatedAt: '2026-05-06T16:50:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_missing_data_vision_archives',
      counts: {
        rebuildTasksRead: 6,
        ohlcvTasksAssessed: 6,
        uniqueTaskKeys: 6,
        materializationCandidateTasks: 3,
        tasksMissingArchiveMonths: 3,
        requiredMonths: 18,
        matchedArchiveMonths: 17,
        missingArchiveMonths: 1,
        matchedZipFiles: 17,
        archiveLineageRows: 0,
        rowPitPromotionZipRows: 0,
      },
      blockers: [
        'ai_scientist_ohlcv_archive_months_missing:1/18',
        'ai_scientist_ohlcv_materialization_candidates_incomplete:3/6',
        'ai_scientist_ohlcv_native_rebuild_plan_research_only',
        'ohlcv_materialization_required_before_pit_contract',
      ],
    },
    aiScientistOhlcvDailySupplementPlan: {
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
    },
    aiScientistOhlcvNativeRows: {
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
    },
    aiScientistPitNativeRebuildStatus: {
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
    },
    aiScientistPitInputDataset: {
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'research_dataset_ready_pit_blocked',
      counts: {
        promotionGradeRows: 0,
      },
      blockers: [
        'pit_input_dataset_research_only',
      ],
    },
    aiScientistPitContractStatus: {
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_pit_contract_missing',
      counts: {
        rowsPromotionGrade: 0,
        rowsWithRowExplicitAvailableAt: 0,
        rowsWithRowExplicitObservedOrFetchedAt: 0,
      },
      blockers: [
        'row_explicit_available_at_missing:0/500',
        'row_explicit_observed_or_fetched_at_missing:0/500',
        'promotion_grade_rows_missing:0/500',
      ],
    },
    ohlcvCollectorPitContractStatus: {
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
        rowsWithRowExplicitAvailableAt: 300,
        rowsWithRowExplicitObservedOrFetchedAt: 300,
        rowsPromotionGrade: 0,
      },
      blockers: [
        'row_pit_usable_for_promotion_false',
        'collector_rows_not_promotion_grade',
        'collector_pit_contract_research_only',
      ],
    },
    externalWarehouseRootExists: overrides.externalWarehouseRootExists,
    aiScientistRootExists: overrides.aiScientistRootExists,
  }
}
