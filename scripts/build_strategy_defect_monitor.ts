import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type Severity = 'P0' | 'P1' | 'P2'
type FindingStatus = 'pass' | 'blocked' | 'watch'

interface CliArgs {
  outputPath: string | null
  strategyDefectRegistryPath: string
  researchLineRetirementPath: string
  strategyReportPath: string
  crossSectionalPath: string
  crossSectionalPaperPath: string
  volumeBreakoutPath: string
  microstructurePath: string
  actionGatePath: string
  scoringPath: string
  staleDataNoOpenGateStatusPath: string
  panicRegimeNoOpenGateStatusPath: string
  strategyRiskCapStatusPath: string
  partialTakeProfitStatusPath: string
  mfeMaeStoplossReportPath: string
  okxOrderbookSpreadSnapshotPath: string
  okxRouteCostSlippageReadinessPath: string
  paperExecutionProducerContractStatusPath: string
  paperExecutionFutureTelemetryWatchdogPath: string
  ethCarryEvidencePath: string
  ethCarryDataGapStatusPath: string
  ethCarryProspectiveEvidencePath: string
  aiScientistIntakePath: string
  aiScientistSecondValidationQueuePath: string
  aiScientistSourceManifestPath: string
  aiScientistReadinessPath: string
  aiScientistPitReproductionPlanPath: string
  aiScientistPitInputDatasetPath: string
  aiScientistPitContractStatusPath: string
  dynamicLeverageVolatilityGateStatusPath: string
  decisionContextCoverageGateStatusPath: string
  pitAuditGlobalGateStatusPath: string
  routeCostModelCompletenessGateStatusPath: string
  marketIntelNoOpenGateStatusPath: string
  noTradeRiskFilterPath: string
  crossSectionalConfigGateStatusPath: string
  volumeBreakoutConfigGateStatusPath: string
  wfoStabilityGateStatusPath: string
  portfolioRiskManagementGateStatusPath: string
  killSwitchGateStatusPath: string
  accountCorruptionGateStatusPath: string
  json: boolean
}

interface SourceSnapshot {
  path: string
  exists: boolean
  text: string
}

export interface StrategyDefectFinding {
  id: string
  title: string
  severity: Severity
  status: FindingStatus
  evidencePaths: string[]
  observed: Record<string, unknown>
  required: Record<string, unknown>
  blockers: string[]
  nextActions: string[]
  benchmarkLessons: string[]
}

export interface StrategyDefectMonitorReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: 'blocked' | 'watch_only'
  sourceArtifacts: Record<string, string>
  summary: {
    findings: number
    pass: number
    blocked: number
    watch: number
    p0Blocked: number
    p1Blocked: number
    p2Blocked: number
  }
  findings: StrategyDefectFinding[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/research/strategy_defect_monitor.latest.json'

async function main(): Promise<void> {
  const args = parseStrategyDefectMonitorArgs(process.argv.slice(2))
  const report = await runStrategyDefectMonitor(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseStrategyDefectMonitorArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    strategyDefectRegistryPath: raw.get('strategyDefectRegistryPath') ?? 'data/research/strategy_defect_registry.latest.json',
    researchLineRetirementPath: raw.get('researchLineRetirementPath') ?? 'data/research/research_line_retirement.latest.json',
    strategyReportPath: raw.get('strategyReportPath') ?? '/Users/kino/Downloads/openalice_strategy_improvement.md',
    crossSectionalPath: raw.get('crossSectionalPath') ?? 'src/domain/strategy/cross-sectional-momentum.ts',
    crossSectionalPaperPath: raw.get('crossSectionalPaperPath') ?? 'scripts/paper_trade_cross_sectional.ts',
    volumeBreakoutPath: raw.get('volumeBreakoutPath') ?? 'src/domain/strategy/volume-breakout.ts',
    microstructurePath: raw.get('microstructurePath') ?? 'scripts/paper_trade_microstructure_stress.ts',
    actionGatePath: raw.get('actionGatePath') ?? 'src/domain/strategy/governance/action-gate.ts',
    scoringPath: raw.get('scoringPath') ?? 'src/domain/strategy/governance/scoring.ts',
    staleDataNoOpenGateStatusPath: raw.get('staleDataNoOpenGateStatusPath') ?? 'data/runtime/stale_data_no_open_gate_status.latest.json',
    panicRegimeNoOpenGateStatusPath: raw.get('panicRegimeNoOpenGateStatusPath') ?? 'data/runtime/panic_regime_no_open_gate_status.latest.json',
    strategyRiskCapStatusPath: raw.get('strategyRiskCapStatusPath') ?? 'data/runtime/strategy_risk_cap_status.latest.json',
    partialTakeProfitStatusPath: raw.get('partialTakeProfitStatusPath') ?? 'data/runtime/partial_take_profit_status.latest.json',
    mfeMaeStoplossReportPath: raw.get('mfeMaeStoplossReportPath') ?? 'data/runtime/p1_trading_evidence/mfe_mae_stoploss_report.latest.json',
    okxOrderbookSpreadSnapshotPath: raw.get('okxOrderbookSpreadSnapshotPath') ?? 'data/runtime/okx_orderbook_spread_snapshot.latest.json',
    okxRouteCostSlippageReadinessPath: raw.get('okxRouteCostSlippageReadinessPath') ?? 'data/runtime/okx_route_cost_slippage_readiness.latest.json',
    paperExecutionProducerContractStatusPath: raw.get('paperExecutionProducerContractStatusPath') ?? 'data/runtime/paper_execution_producer_contract_status.latest.json',
    paperExecutionFutureTelemetryWatchdogPath: raw.get('paperExecutionFutureTelemetryWatchdogPath') ?? 'data/runtime/paper_execution_future_telemetry_watchdog.latest.json',
    ethCarryEvidencePath: raw.get('ethCarryEvidencePath') ?? 'data/research/eth_carry_research_evidence_status.latest.json',
    ethCarryDataGapStatusPath: raw.get('ethCarryDataGapStatusPath') ?? 'data/research/eth_carry_data_gap_status.latest.json',
    ethCarryProspectiveEvidencePath: raw.get('ethCarryProspectiveEvidencePath') ?? 'data/research/eth_carry_prospective_evidence_status.latest.json',
    aiScientistIntakePath: raw.get('aiScientistIntakePath') ?? 'data/research/ai_scientist_crypto_candidate_intake.latest.json',
    aiScientistSecondValidationQueuePath: raw.get('aiScientistSecondValidationQueuePath') ?? 'data/research/ai_scientist_openalice_second_validation_queue.latest.json',
    aiScientistSourceManifestPath: raw.get('aiScientistSourceManifestPath') ?? 'data/research/ai_scientist_openalice_candidate_source_manifest.latest.json',
    aiScientistReadinessPath: raw.get('aiScientistReadinessPath') ?? 'data/research/ai_scientist_openalice_second_validation_readiness.latest.json',
    aiScientistPitReproductionPlanPath: raw.get('aiScientistPitReproductionPlanPath') ?? 'data/research/ai_scientist_openalice_pit_reproduction_plan.latest.json',
    aiScientistPitInputDatasetPath: raw.get('aiScientistPitInputDatasetPath') ?? 'data/research/ai_scientist_openalice_pit_input_dataset.latest.json',
    aiScientistPitContractStatusPath: raw.get('aiScientistPitContractStatusPath') ?? 'data/research/ai_scientist_openalice_pit_contract_status.latest.json',
    dynamicLeverageVolatilityGateStatusPath: raw.get('dynamicLeverageVolatilityGateStatusPath') ?? 'data/runtime/dynamic_leverage_volatility_gate_status.latest.json',
    decisionContextCoverageGateStatusPath: raw.get('decisionContextCoverageGateStatusPath') ?? 'data/runtime/decision_context_coverage_gate_status.latest.json',
    pitAuditGlobalGateStatusPath: raw.get('pitAuditGlobalGateStatusPath') ?? 'data/runtime/pit_audit_global_gate_status.latest.json',
    routeCostModelCompletenessGateStatusPath: raw.get('routeCostModelCompletenessGateStatusPath') ?? 'data/runtime/route_cost_model_completeness_gate_status.latest.json',
    marketIntelNoOpenGateStatusPath: raw.get('marketIntelNoOpenGateStatusPath') ?? 'data/runtime/market_intel_no_open_gate_status.latest.json',
    noTradeRiskFilterPath: raw.get('noTradeRiskFilterPath') ?? 'data/runtime/no_trade_risk_filter.latest.json',
    crossSectionalConfigGateStatusPath: raw.get('crossSectionalConfigGateStatusPath') ?? 'data/runtime/cross_sectional_config_gate_status.latest.json',
    volumeBreakoutConfigGateStatusPath: raw.get('volumeBreakoutConfigGateStatusPath') ?? 'data/runtime/volume_breakout_config_gate_status.latest.json',
    wfoStabilityGateStatusPath: raw.get('wfoStabilityGateStatusPath') ?? 'data/runtime/wfo_stability_gate_status.latest.json',
    portfolioRiskManagementGateStatusPath: raw.get('portfolioRiskManagementGateStatusPath') ?? 'data/runtime/portfolio_risk_management_gate_status.latest.json',
    killSwitchGateStatusPath: raw.get('killSwitchGateStatusPath') ?? 'data/runtime/kill_switch_gate_status.latest.json',
    accountCorruptionGateStatusPath: raw.get('accountCorruptionGateStatusPath') ?? 'data/runtime/account_corruption_gate_status.latest.json',
    json: parseBool(raw.get('json'), false),
  }
}

export async function runStrategyDefectMonitor(inputArgs: Partial<CliArgs>): Promise<StrategyDefectMonitorReport> {
  const args: CliArgs = {
    ...parseStrategyDefectMonitorArgs([]),
    ...inputArgs,
  }
  const startedAt = new Date()
  const sourcePaths = {
    strategyDefectRegistry: resolve(args.strategyDefectRegistryPath),
    researchLineRetirement: resolve(args.researchLineRetirementPath),
    strategyReport: resolve(args.strategyReportPath),
    crossSectional: resolve(args.crossSectionalPath),
    crossSectionalPaper: resolve(args.crossSectionalPaperPath),
    volumeBreakout: resolve(args.volumeBreakoutPath),
    microstructure: resolve(args.microstructurePath),
    actionGate: resolve(args.actionGatePath),
    scoring: resolve(args.scoringPath),
    staleDataNoOpenGateStatus: resolve(args.staleDataNoOpenGateStatusPath),
    panicRegimeNoOpenGateStatus: resolve(args.panicRegimeNoOpenGateStatusPath),
    strategyRiskCapStatus: resolve(args.strategyRiskCapStatusPath),
    partialTakeProfitStatus: resolve(args.partialTakeProfitStatusPath),
    mfeMaeStoplossReport: resolve(args.mfeMaeStoplossReportPath),
    okxOrderbookSpreadSnapshot: resolve(args.okxOrderbookSpreadSnapshotPath),
    okxRouteCostSlippageReadiness: resolve(args.okxRouteCostSlippageReadinessPath),
    paperExecutionProducerContractStatus: resolve(args.paperExecutionProducerContractStatusPath),
    paperExecutionFutureTelemetryWatchdog: resolve(args.paperExecutionFutureTelemetryWatchdogPath),
    ethCarryEvidence: resolve(args.ethCarryEvidencePath),
    ethCarryDataGapStatus: resolve(args.ethCarryDataGapStatusPath),
    ethCarryProspectiveEvidence: resolve(args.ethCarryProspectiveEvidencePath),
    aiScientistIntake: resolve(args.aiScientistIntakePath),
    aiScientistSecondValidationQueue: resolve(args.aiScientistSecondValidationQueuePath),
    aiScientistSourceManifest: resolve(args.aiScientistSourceManifestPath),
    aiScientistReadiness: resolve(args.aiScientistReadinessPath),
    aiScientistPitReproductionPlan: resolve(args.aiScientistPitReproductionPlanPath),
    aiScientistPitInputDataset: resolve(args.aiScientistPitInputDatasetPath),
    aiScientistPitContractStatus: resolve(args.aiScientistPitContractStatusPath),
    dynamicLeverageVolatilityGateStatus: resolve(args.dynamicLeverageVolatilityGateStatusPath),
    decisionContextCoverageGateStatus: resolve(args.decisionContextCoverageGateStatusPath),
    pitAuditGlobalGateStatus: resolve(args.pitAuditGlobalGateStatusPath),
    routeCostModelCompletenessGateStatus: resolve(args.routeCostModelCompletenessGateStatusPath),
    marketIntelNoOpenGateStatus: resolve(args.marketIntelNoOpenGateStatusPath),
    noTradeRiskFilter: resolve(args.noTradeRiskFilterPath),
    crossSectionalConfigGateStatus: resolve(args.crossSectionalConfigGateStatusPath),
    volumeBreakoutConfigGateStatus: resolve(args.volumeBreakoutConfigGateStatusPath),
    wfoStabilityGateStatus: resolve(args.wfoStabilityGateStatusPath),
    portfolioRiskManagementGateStatus: resolve(args.portfolioRiskManagementGateStatusPath),
    killSwitchGateStatus: resolve(args.killSwitchGateStatusPath),
    accountCorruptionGateStatus: resolve(args.accountCorruptionGateStatusPath),
  }
  const report = buildStrategyDefectMonitorReport({
    generatedAt: new Date().toISOString(),
    sourceArtifacts: sourcePaths,
    sources: {
      strategyReport: await readSource(sourcePaths.strategyReport),
      crossSectional: await readSource(sourcePaths.crossSectional),
      crossSectionalPaper: await readSource(sourcePaths.crossSectionalPaper),
      volumeBreakout: await readSource(sourcePaths.volumeBreakout),
      microstructure: await readSource(sourcePaths.microstructure),
      actionGate: await readSource(sourcePaths.actionGate),
      scoring: await readSource(sourcePaths.scoring),
    },
    strategyDefectRegistry: asRecord(await readJsonIfExists(sourcePaths.strategyDefectRegistry)),
    researchLineRetirement: asRecord(await readJsonIfExists(sourcePaths.researchLineRetirement)),
    staleDataNoOpenGateStatus: asRecord(await readJsonIfExists(sourcePaths.staleDataNoOpenGateStatus)),
    panicRegimeNoOpenGateStatus: asRecord(await readJsonIfExists(sourcePaths.panicRegimeNoOpenGateStatus)),
    strategyRiskCapStatus: asRecord(await readJsonIfExists(sourcePaths.strategyRiskCapStatus)),
    partialTakeProfitStatus: asRecord(await readJsonIfExists(sourcePaths.partialTakeProfitStatus)),
    mfeMaeStoplossReport: asRecord(await readJsonIfExists(sourcePaths.mfeMaeStoplossReport)),
    okxOrderbookSpreadSnapshot: asRecord(await readJsonIfExists(sourcePaths.okxOrderbookSpreadSnapshot)),
    okxRouteCostSlippageReadiness: asRecord(await readJsonIfExists(sourcePaths.okxRouteCostSlippageReadiness)),
    paperExecutionProducerContractStatus: asRecord(await readJsonIfExists(sourcePaths.paperExecutionProducerContractStatus)),
    paperExecutionFutureTelemetryWatchdog: asRecord(await readJsonIfExists(sourcePaths.paperExecutionFutureTelemetryWatchdog)),
    ethCarryEvidence: asRecord(await readJsonIfExists(sourcePaths.ethCarryEvidence)),
    ethCarryDataGapStatus: asRecord(await readJsonIfExists(sourcePaths.ethCarryDataGapStatus)),
    ethCarryProspectiveEvidence: asRecord(await readJsonIfExists(sourcePaths.ethCarryProspectiveEvidence)),
    aiScientistIntake: asRecord(await readJsonIfExists(sourcePaths.aiScientistIntake)),
    aiScientistSecondValidationQueue: asRecord(await readJsonIfExists(sourcePaths.aiScientistSecondValidationQueue)),
    aiScientistSourceManifest: asRecord(await readJsonIfExists(sourcePaths.aiScientistSourceManifest)),
    aiScientistReadiness: asRecord(await readJsonIfExists(sourcePaths.aiScientistReadiness)),
    aiScientistPitReproductionPlan: asRecord(await readJsonIfExists(sourcePaths.aiScientistPitReproductionPlan)),
    aiScientistPitInputDataset: asRecord(await readJsonIfExists(sourcePaths.aiScientistPitInputDataset)),
    aiScientistPitContractStatus: asRecord(await readJsonIfExists(sourcePaths.aiScientistPitContractStatus)),
    dynamicLeverageVolatilityGateStatus: asRecord(await readJsonIfExists(sourcePaths.dynamicLeverageVolatilityGateStatus)),
    decisionContextCoverageGateStatus: asRecord(await readJsonIfExists(sourcePaths.decisionContextCoverageGateStatus)),
    pitAuditGlobalGateStatus: asRecord(await readJsonIfExists(sourcePaths.pitAuditGlobalGateStatus)),
    routeCostModelCompletenessGateStatus: asRecord(await readJsonIfExists(sourcePaths.routeCostModelCompletenessGateStatus)),
    marketIntelNoOpenGateStatus: asRecord(await readJsonIfExists(sourcePaths.marketIntelNoOpenGateStatus)),
    noTradeRiskFilter: asRecord(await readJsonIfExists(sourcePaths.noTradeRiskFilter)),
    crossSectionalConfigGateStatus: asRecord(await readJsonIfExists(sourcePaths.crossSectionalConfigGateStatus)),
    volumeBreakoutConfigGateStatus: asRecord(await readJsonIfExists(sourcePaths.volumeBreakoutConfigGateStatus)),
    wfoStabilityGateStatus: asRecord(await readJsonIfExists(sourcePaths.wfoStabilityGateStatus)),
    portfolioRiskManagementGateStatus: asRecord(await readJsonIfExists(sourcePaths.portfolioRiskManagementGateStatus)),
    killSwitchGateStatus: asRecord(await readJsonIfExists(sourcePaths.killSwitchGateStatus)),
    accountCorruptionGateStatus: asRecord(await readJsonIfExists(sourcePaths.accountCorruptionGateStatus)),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'strategy_defect_monitor',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'watch_only' ? 'warn' : 'fail',
      recordsIn: Object.keys(sourcePaths).length,
      recordsOut: report.findings.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildStrategyDefectMonitorReport(input: {
  generatedAt?: string
  sourceArtifacts: Record<string, string>
  sources: {
    strategyReport: SourceSnapshot
    crossSectional: SourceSnapshot
    crossSectionalPaper: SourceSnapshot
    volumeBreakout: SourceSnapshot
    microstructure: SourceSnapshot
    actionGate: SourceSnapshot
    scoring: SourceSnapshot
  }
  strategyDefectRegistry: UnknownRecord | null
  researchLineRetirement: UnknownRecord | null
  staleDataNoOpenGateStatus: UnknownRecord | null
  panicRegimeNoOpenGateStatus: UnknownRecord | null
  strategyRiskCapStatus: UnknownRecord | null
  partialTakeProfitStatus: UnknownRecord | null
  mfeMaeStoplossReport: UnknownRecord | null
  okxOrderbookSpreadSnapshot: UnknownRecord | null
  okxRouteCostSlippageReadiness: UnknownRecord | null
  paperExecutionProducerContractStatus: UnknownRecord | null
  paperExecutionFutureTelemetryWatchdog: UnknownRecord | null
  ethCarryEvidence: UnknownRecord | null
  ethCarryDataGapStatus: UnknownRecord | null
  ethCarryProspectiveEvidence: UnknownRecord | null
  aiScientistIntake: UnknownRecord | null
  aiScientistSecondValidationQueue: UnknownRecord | null
  aiScientistSourceManifest: UnknownRecord | null
  aiScientistReadiness: UnknownRecord | null
  aiScientistPitReproductionPlan: UnknownRecord | null
  aiScientistPitInputDataset: UnknownRecord | null
  aiScientistPitContractStatus: UnknownRecord | null
  dynamicLeverageVolatilityGateStatus: UnknownRecord | null
  decisionContextCoverageGateStatus: UnknownRecord | null
  pitAuditGlobalGateStatus: UnknownRecord | null
  routeCostModelCompletenessGateStatus: UnknownRecord | null
  marketIntelNoOpenGateStatus: UnknownRecord | null
  noTradeRiskFilter: UnknownRecord | null
  crossSectionalConfigGateStatus: UnknownRecord | null
  volumeBreakoutConfigGateStatus: UnknownRecord | null
  wfoStabilityGateStatus: UnknownRecord | null
  portfolioRiskManagementGateStatus: UnknownRecord | null
  killSwitchGateStatus: UnknownRecord | null
  accountCorruptionGateStatus: UnknownRecord | null
}): StrategyDefectMonitorReport {
  const findings = [
    checkOldStrategyReport(
      input.sources.strategyReport,
      input.sourceArtifacts.strategyReport,
      input.strategyDefectRegistry,
      input.sourceArtifacts.strategyDefectRegistry,
    ),
    checkRetiredLineGuard(input.researchLineRetirement, input.sourceArtifacts.researchLineRetirement),
    checkCrossSectionalHolding(input.sources.crossSectionalPaper),
    checkCrossSectionalSpreadFilter(
      input.sources.crossSectional,
      input.okxOrderbookSpreadSnapshot,
      input.sourceArtifacts.okxOrderbookSpreadSnapshot,
    ),
    checkRouteCostSlippageReadiness(
      input.okxRouteCostSlippageReadiness,
      input.paperExecutionProducerContractStatus,
      input.paperExecutionFutureTelemetryWatchdog,
      input.sourceArtifacts.okxRouteCostSlippageReadiness,
      input.sourceArtifacts.paperExecutionProducerContractStatus,
      input.sourceArtifacts.paperExecutionFutureTelemetryWatchdog,
    ),
    checkVolumeBreakoutStop(input.sources.volumeBreakout),
    checkVolumeBreakoutHoldAndLiquidity(input.sources.volumeBreakout),
    checkMicrostructureProfiles(input.sources.microstructure),
    checkAtrTrailingIntegration(
      input.sources.crossSectionalPaper,
      input.partialTakeProfitStatus,
      input.sourceArtifacts.partialTakeProfitStatus,
    ),
    checkEntryTimingQuality(
      input.mfeMaeStoplossReport,
      input.paperExecutionProducerContractStatus,
      input.paperExecutionFutureTelemetryWatchdog,
      input.sourceArtifacts.mfeMaeStoplossReport,
      input.sourceArtifacts.paperExecutionProducerContractStatus,
      input.sourceArtifacts.paperExecutionFutureTelemetryWatchdog,
    ),
    checkStaleDataOpenGate(input.sources.actionGate, input.sources.scoring, input.staleDataNoOpenGateStatus, input.sourceArtifacts.staleDataNoOpenGateStatus),
    checkNoTradeRiskFilter(input.noTradeRiskFilter, input.sourceArtifacts.noTradeRiskFilter),
    checkPanicRegimeOpenGate(input.panicRegimeNoOpenGateStatus, input.sourceArtifacts.panicRegimeNoOpenGateStatus),
    checkStrategyRiskCaps(input.strategyRiskCapStatus, input.sourceArtifacts.strategyRiskCapStatus),
    checkCarryPitAndBasis(input.ethCarryEvidence, input.ethCarryDataGapStatus, input.sourceArtifacts.ethCarryEvidence, input.sourceArtifacts.ethCarryDataGapStatus),
    checkCarryProspectiveEvidence(input.ethCarryProspectiveEvidence, input.ethCarryDataGapStatus, input.sourceArtifacts.ethCarryProspectiveEvidence, input.sourceArtifacts.ethCarryDataGapStatus),
    checkDynamicLeverageVolatilityGate(
      input.dynamicLeverageVolatilityGateStatus,
      input.sourceArtifacts.dynamicLeverageVolatilityGateStatus,
    ),
    checkDecisionContextCoverageGate(
      input.decisionContextCoverageGateStatus,
      input.sourceArtifacts.decisionContextCoverageGateStatus,
    ),
    checkPitAuditGlobalGate(
      input.pitAuditGlobalGateStatus,
      input.sourceArtifacts.pitAuditGlobalGateStatus,
    ),
    checkRouteCostModelCompletenessGate(
      input.routeCostModelCompletenessGateStatus,
      input.sourceArtifacts.routeCostModelCompletenessGateStatus,
    ),
    checkMarketIntelNoOpenGate(
      input.marketIntelNoOpenGateStatus,
      input.sourceArtifacts.marketIntelNoOpenGateStatus,
    ),
    checkCrossSectionalConfigGate(
      input.crossSectionalConfigGateStatus,
      input.sourceArtifacts.crossSectionalConfigGateStatus,
    ),
    checkVolumeBreakoutConfigGate(
      input.volumeBreakoutConfigGateStatus,
      input.sourceArtifacts.volumeBreakoutConfigGateStatus,
    ),
    checkWfoStabilityGate(
      input.wfoStabilityGateStatus,
      input.sourceArtifacts.wfoStabilityGateStatus,
    ),
    checkPortfolioRiskManagementGate(
      input.portfolioRiskManagementGateStatus,
      input.sourceArtifacts.portfolioRiskManagementGateStatus,
    ),
    checkKillSwitchGate(
      input.killSwitchGateStatus,
      input.sourceArtifacts.killSwitchGateStatus,
    ),
    checkAccountCorruptionGate(
      input.accountCorruptionGateStatus,
      input.sourceArtifacts.accountCorruptionGateStatus,
    ),
    checkAiScientistSecondValidation(
      input.aiScientistIntake,
      input.aiScientistSecondValidationQueue,
      input.aiScientistSourceManifest,
      input.aiScientistReadiness,
      input.aiScientistPitReproductionPlan,
      input.aiScientistPitInputDataset,
      input.aiScientistPitContractStatus,
      input.sourceArtifacts.aiScientistIntake,
      input.sourceArtifacts.aiScientistSecondValidationQueue,
      input.sourceArtifacts.aiScientistSourceManifest,
      input.sourceArtifacts.aiScientistReadiness,
      input.sourceArtifacts.aiScientistPitReproductionPlan,
      input.sourceArtifacts.aiScientistPitInputDataset,
      input.sourceArtifacts.aiScientistPitContractStatus,
    ),
  ]
  const summary = {
    findings: findings.length,
    pass: findings.filter(item => item.status === 'pass').length,
    blocked: findings.filter(item => item.status === 'blocked').length,
    watch: findings.filter(item => item.status === 'watch').length,
    p0Blocked: findings.filter(item => item.status === 'blocked' && item.severity === 'P0').length,
    p1Blocked: findings.filter(item => item.status === 'blocked' && item.severity === 'P1').length,
    p2Blocked: findings.filter(item => item.status === 'blocked' && item.severity === 'P2').length,
  }
  const blockers = uniqueStrings(findings
    .filter(item => item.status === 'blocked')
    .flatMap(item => item.blockers.map(blocker => `${item.id}:${blocker}`)))
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: blockers.length > 0 ? 'blocked' : 'watch_only',
    sourceArtifacts: input.sourceArtifacts,
    summary,
    findings,
    blockers,
    nextActions: [
      'Fix P0/P1 strategy defects in smallest testable slices; do not enable paper/live while any release gate remains blocked.',
      'Prioritize strategy economics in this order: PIT-safe carry/basis data, real route cost/slippage, WFO/FDR robustness, then exit and sizing improvements.',
      'Refresh this monitor after every strategy change so remaining blockers are visible in artifacts instead of memory.',
    ],
    safetyNotes: [
      'This monitor diagnoses strategy defects only; it cannot authorize paper orders, live orders, promotion, leverage changes, or best_config mutations.',
      'Passing a finding here is not profitability proof. Trading still requires OpenAlice release gates, prospective evidence, paper telemetry, and risk approval.',
    ],
  }
}

function checkOldStrategyReport(
  source: SourceSnapshot,
  path: string,
  strategyDefectRegistry: UnknownRecord | null,
  registryPath: string | undefined,
): StrategyDefectFinding {
  const registrySummary = asRecord(strategyDefectRegistry?.summary)
  const registryDefects = readRecordArray(strategyDefectRegistry?.defects)
  const registryLoaded = strategyDefectRegistry != null &&
    readString(strategyDefectRegistry.status) != null &&
    (readNumber(registrySummary?.defects) ?? registryDefects.length) > 0
  return finding({
    id: 'strategy_report_loaded',
    title: 'Strategy defect diagnosis is available for monitoring',
    severity: 'P2',
    status: registryLoaded ? 'watch' : source.exists ? 'watch' : 'blocked',
    evidencePaths: [registryPath, path].filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      legacyReportExists: source.exists,
      registryExists: strategyDefectRegistry != null,
      registryStatus: readString(strategyDefectRegistry?.status),
      registryDefects: readNumber(registrySummary?.defects) ?? registryDefects.length,
      registryP0OpenOrPartial: readNumber(registrySummary?.p0OpenOrPartial),
      registryP1OpenOrPartial: readNumber(registrySummary?.p1OpenOrPartial),
      mentionsRouteCost: source.text.includes('成本证据') || source.text.includes('routeCostBps'),
      mentionsMicrostructureNoise: source.text.includes('microstructure'),
      mentionsAtrTrailing: source.text.includes('ATR trailing'),
    },
    required: { structuredRegistryPresent: true, legacyReportOptional: true },
    blockers: registryLoaded || source.exists ? [] : ['strategy_defect_registry_and_legacy_report_missing'],
    nextActions: [
      'Use the structured strategy defect registry as the canonical checklist; the legacy Downloads report is optional context only.',
      'Current runtime artifacts remain the source of trading truth.',
    ],
    benchmarkLessons: ['evidence_reporting'],
  })
}

function checkRetiredLineGuard(
  researchLineRetirement: UnknownRecord | null,
  path: string | undefined,
): StrategyDefectFinding {
  const requiredBeforeReactivation = readStringArray(researchLineRetirement?.requiredBeforeReactivation)
  const verdict = readString(researchLineRetirement?.verdict)
  const lineHealth = readString(researchLineRetirement?.lineHealth)
  const artifactAllowsExecution =
    readBoolean(researchLineRetirement?.promotionAllowed) === true ||
    readBoolean(researchLineRetirement?.promotionEligible) === true ||
    readBoolean(researchLineRetirement?.paperTradingAllowed) === true ||
    readBoolean(researchLineRetirement?.liveTradingAllowed) === true ||
    readBoolean(researchLineRetirement?.executionAllowed) === true ||
    readBoolean(researchLineRetirement?.policyMutationAllowed) === true
  const retired = verdict === 'retire_current_line' && lineHealth === 'retired'
  const hasReactivationChecklist = [
    'new_alpha_hypothesis_or_materially_different_feature_set',
    'wfo_failed_window_ratio_lte_threshold_and_direction_stable',
    'complete_trial_ledger_with_by_fdr',
    'pit_audit_pass',
    'prospective_closed_outcomes_gte_100_across_3_non_overlapping_windows',
    'paper_execution_evidence_after_release_gate',
  ].every(item => requiredBeforeReactivation.includes(item))
  const pass = researchLineRetirement != null && retired && hasReactivationChecklist && !artifactAllowsExecution
  return finding({
    id: 'retired_line_guard',
    title: 'Retired RankIC/reversal line cannot be revived by parameter tuning',
    severity: 'P0',
    status: pass ? 'pass' : 'blocked',
    evidencePaths: [path, 'scripts/build_research_line_retirement.ts']
      .filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactPresent: researchLineRetirement != null,
      verdict,
      lineHealth,
      retired,
      requiredBeforeReactivation,
      hasReactivationChecklist,
      artifactAllowsExecution,
    },
    required: {
      verdict: 'retire_current_line',
      lineHealth: 'retired',
      reactivationRequiresNewAlphaAndFullEvidence: true,
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(researchLineRetirement ? [] : ['research_line_retirement_missing']),
      ...(retired ? [] : [`research_line_not_retired:${verdict ?? 'missing'}/${lineHealth ?? 'missing'}`]),
      ...(hasReactivationChecklist ? [] : ['retired_line_reactivation_checklist_incomplete']),
      ...(artifactAllowsExecution ? ['research_line_retirement_must_not_authorize_execution'] : []),
    ],
    nextActions: [
      'Do not continue parameter search on the retired RankIC/reversal family.',
      'Only admit a materially different alpha after PIT, WFO, BY-FDR, prospective, route-cost, risk, and paper telemetry evidence are available.',
    ],
    benchmarkLessons: ['research workflow', 'evidence reporting', 'protections'],
  })
}

function checkCrossSectionalHolding(source: SourceSnapshot): StrategyDefectFinding {
  const expectedHoldingHours = extractNumberAfterKey(source.text, 'expectedHoldingHours')
  const pass = expectedHoldingHours != null && expectedHoldingHours <= 24
  return finding({
    id: 'cross_sectional_holding_window',
    title: 'Cross-sectional holding window stays inside the short reversal decay window',
    severity: 'P1',
    status: pass ? 'pass' : 'blocked',
    evidencePaths: [source.path],
    observed: { expectedHoldingHours },
    required: { expectedHoldingHoursLte: 24 },
    blockers: pass ? [] : [`expected_holding_hours_not_lte_24:${expectedHoldingHours ?? 'missing'}`],
    nextActions: pass
      ? ['Keep the 24h horizon locked until WFO/prospective evidence says otherwise.']
      : ['Reduce cross-sectional default holding horizon to <=24h before another strategy promotion review.'],
    benchmarkLessons: ['backtest/live parity', 'research workflow'],
  })
}

function checkCrossSectionalSpreadFilter(
  source: SourceSnapshot,
  okxOrderbookSpreadSnapshot: UnknownRecord | null,
  okxOrderbookSpreadSnapshotPath: string | undefined,
): StrategyDefectFinding {
  const hasSpreadConfig = source.text.includes('maxSpreadBps')
  const orderbookStatus = readString(okxOrderbookSpreadSnapshot?.status)
  const orderbookCounts = asRecord(okxOrderbookSpreadSnapshot?.counts)
  const spreadSummary = asRecord(okxOrderbookSpreadSnapshot?.spreadSummary)
  const orderbookBlockers = readStringArray(okxOrderbookSpreadSnapshot?.blockers)
  const artifactAllowsExecution =
    readBoolean(okxOrderbookSpreadSnapshot?.promotionEligible) === true ||
    readBoolean(okxOrderbookSpreadSnapshot?.paperTradingAllowed) === true ||
    readBoolean(okxOrderbookSpreadSnapshot?.liveTradingAllowed) === true ||
    readBoolean(okxOrderbookSpreadSnapshot?.executionAllowed) === true
  const rowsBuilt = readNumber(orderbookCounts?.rowsBuilt) ?? 0
  const blockedRows = readNumber(orderbookCounts?.blockedRows) ?? 0
  const maxSpreadBps = readNumber(spreadSummary?.maxSpreadBps)
  const minDepth5Usd = readNumber(spreadSummary?.minDepth5Usd)
  const hasRuntimeOrderbookEvidence = orderbookStatus === 'complete' &&
    rowsBuilt > 0 &&
    blockedRows === 0 &&
    !artifactAllowsExecution &&
    orderbookBlockers.length === 0
  return finding({
    id: 'cross_sectional_spread_filter',
    title: 'Cross-sectional strategy has explicit spread/liquidity filtering',
    severity: 'P0',
    status: hasSpreadConfig ? 'watch' : 'blocked',
    evidencePaths: [source.path, okxOrderbookSpreadSnapshotPath].filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      hasMaxSpreadBpsConfig: hasSpreadConfig,
      orderbookStatus,
      orderbookRowsBuilt: rowsBuilt,
      orderbookBlockedRows: blockedRows,
      orderbookMaxSpreadBps: maxSpreadBps,
      orderbookMinDepth5Usd: minDepth5Usd,
      orderbookArtifactAllowsExecution: artifactAllowsExecution,
    },
    required: {
      maxSpreadBpsConfig: true,
      defaultMaxSpreadBpsLte: 20,
      runtimeOrderbookSpreadEvidencePresent: true,
      orderbookBlockedRowsEq: 0,
      orderbookArtifactMustNotAuthorizeExecution: true,
    },
    blockers: [
      ...(hasSpreadConfig ? [] : ['maxSpreadBps_config_missing']),
      ...(hasRuntimeOrderbookEvidence ? [] : ['runtime_orderbook_spread_evidence_missing_or_blocked']),
      ...(artifactAllowsExecution ? ['orderbook_spread_artifact_must_not_authorize_execution'] : []),
      ...orderbookBlockers.slice(0, 8).map(blocker => `orderbook_spread:${blocker}`),
    ],
    nextActions: hasRuntimeOrderbookEvidence
      ? [
          'Use OKX public order-book spread/depth snapshots as research-only route-cost/slippage inputs.',
          'Still require per-trade spread/slippage telemetry before promotion.',
        ]
      : [
          'Add explicit spread and route-cost filters to cross-sectional candidate generation before any candidate can be promoted.',
          'Validate the filter against real bid/ask and route-cost telemetry, not only quote volume.',
        ],
    benchmarkLessons: ['protections', 'order book matching', 'execution cost model'],
  })
}

function checkRouteCostSlippageReadiness(
  okxRouteCostSlippageReadiness: UnknownRecord | null,
  paperExecutionProducerContractStatus: UnknownRecord | null,
  paperExecutionFutureTelemetryWatchdog: UnknownRecord | null,
  path: string | undefined,
  producerContractPath?: string,
  futureTelemetryWatchdogPath?: string,
): StrategyDefectFinding {
  const readiness = asRecord(okxRouteCostSlippageReadiness?.readiness)
  const orderbook = asRecord(okxRouteCostSlippageReadiness?.orderbook)
  const feeSnapshot = asRecord(okxRouteCostSlippageReadiness?.feeSnapshot)
  const routeCostBudget = asRecord(okxRouteCostSlippageReadiness?.routeCostBudget)
  const executionQuality = asRecord(okxRouteCostSlippageReadiness?.executionQuality)
  const paperCostEvidence = asRecord(okxRouteCostSlippageReadiness?.paperCostEvidence)
  const futureWatchdogCounts = asRecord(paperExecutionFutureTelemetryWatchdog?.counts)
  const futureWatchdogCoverage = asRecord(paperExecutionFutureTelemetryWatchdog?.coverage)
  const futureWatchdogReadiness = asRecord(paperExecutionFutureTelemetryWatchdog?.readiness)
  const futureWatchdogTelemetryGap = asRecord(paperExecutionFutureTelemetryWatchdog?.telemetryGap)
  const producerContract = asRecord(paperExecutionProducerContractStatus?.producerContract)
  const historicalProducerQuality = asRecord(paperExecutionProducerContractStatus?.historicalExecutionQuality)
  const artifactBlockers = readStringArray(okxRouteCostSlippageReadiness?.blockers)
  const producerContractBlockers = readStringArray(paperExecutionProducerContractStatus?.blockers)
  const futureWatchdogBlockers = readStringArray(paperExecutionFutureTelemetryWatchdog?.blockers)
  const futureWatchdogEvidenceBlockers = readStringArray(paperExecutionFutureTelemetryWatchdog?.evidenceBlockers)
  const artifactAllowsExecution =
    readBoolean(okxRouteCostSlippageReadiness?.promotionEligible) === true ||
    readBoolean(okxRouteCostSlippageReadiness?.paperTradingAllowed) === true ||
    readBoolean(okxRouteCostSlippageReadiness?.liveTradingAllowed) === true ||
    readBoolean(okxRouteCostSlippageReadiness?.executionAllowed) === true ||
    readBoolean(paperExecutionFutureTelemetryWatchdog?.promotionEligible) === true ||
    readBoolean(paperExecutionFutureTelemetryWatchdog?.paperTradingAllowed) === true ||
    readBoolean(paperExecutionFutureTelemetryWatchdog?.liveTradingAllowed) === true ||
    readBoolean(paperExecutionFutureTelemetryWatchdog?.executionAllowed) === true
  const publicOrderbookUsableForResearch = readBoolean(readiness?.publicOrderbookUsableForResearch) === true
  const runtimeFeeSnapshotUsableForResearch = readBoolean(readiness?.runtimeFeeSnapshotUsableForResearch) === true
  const routeCostBudgetRuntimeVerified = readBoolean(readiness?.routeCostBudgetRuntimeVerified) === true
  const routeCostBudgetFresh = readBoolean(readiness?.routeCostBudgetFresh) === true
  const paperExecutionTelemetryAvailable = readBoolean(readiness?.paperExecutionTelemetryAvailable) === true
  const futurePaperProducerReady = readBoolean(producerContract?.futurePaperCloseRowsReady) === true
  const futurePaperFillTelemetrySufficient = readBoolean(futureWatchdogReadiness?.futurePaperFillTelemetrySufficient) === true
  const futurePredictedOpenEvidenceSufficient = readBoolean(futureWatchdogReadiness?.futurePredictedOpenEvidenceSufficient) === true
  const futureExchangeReconciledCostEvidenceAvailable =
    readBoolean(futureWatchdogReadiness?.exchangeReconciledCostEvidenceAvailable) === true
  const futureObservedSlippageAvailable = readBoolean(futureWatchdogReadiness?.observedSlippageAvailable) === true
  const pass = okxRouteCostSlippageReadiness != null &&
    publicOrderbookUsableForResearch &&
    runtimeFeeSnapshotUsableForResearch &&
    routeCostBudgetRuntimeVerified &&
    routeCostBudgetFresh &&
    paperExecutionTelemetryAvailable &&
    !artifactAllowsExecution
  return finding({
    id: 'route_cost_slippage_readiness',
    title: 'Route-cost and slippage evidence separates quote inputs from execution telemetry',
    severity: 'P0',
    status: pass ? 'watch' : 'blocked',
    evidencePaths: [path, producerContractPath, futureTelemetryWatchdogPath]
      .filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      status: readString(okxRouteCostSlippageReadiness?.status),
      producerContractStatus: readString(paperExecutionProducerContractStatus?.status),
      futureTelemetryWatchdogStatus: readString(paperExecutionFutureTelemetryWatchdog?.status),
      publicOrderbookUsableForResearch,
      runtimeFeeSnapshotUsableForResearch,
      routeCostBudgetRuntimeVerified,
      routeCostBudgetFresh,
      paperExecutionTelemetryAvailable,
      futurePaperProducerReady,
      futureClosedRows: readNumber(futureWatchdogCounts?.futureClosedRows),
      futureClosedRowsWithOpenAfterStart: readNumber(futureWatchdogCounts?.futureClosedRowsWithOpenAfterStart),
      futureRowsWithPaperFillTelemetry: readNumber(futureWatchdogCounts?.futureRowsWithPaperFillTelemetry),
      futureRowsWithCompletePredictedOpenEvidence: readNumber(futureWatchdogCounts?.futureRowsWithCompletePredictedOpenEvidence),
      futureRowsWithExchangeReconciledCostEvidence: readNumber(futureWatchdogCounts?.futureRowsWithExchangeReconciledCostEvidence),
      futureRowsWithObservedSlippage: readNumber(futureWatchdogCounts?.futureRowsWithObservedSlippage),
      futurePaperFillTelemetryCoveragePct: readNumber(futureWatchdogCoverage?.futurePaperFillTelemetryCoveragePct),
      futureNewOpenPredictedOpenEvidenceCoveragePct: readNumber(futureWatchdogCoverage?.futureNewOpenPredictedOpenEvidenceCoveragePct),
      futureExchangeReconciledCostCoveragePct: readNumber(futureWatchdogCoverage?.futureExchangeReconciledCostCoveragePct),
      futureObservedSlippageCoveragePct: readNumber(futureWatchdogCoverage?.futureObservedSlippageCoveragePct),
      futurePaperFillTelemetrySufficient,
      futurePredictedOpenEvidenceSufficient,
      futureExchangeReconciledCostEvidenceAvailable,
      futureObservedSlippageAvailable,
      futureTelemetryGapStatus: readString(futureWatchdogTelemetryGap?.status),
      futureTelemetryGapMonitoringAgeMinutes: readNumber(futureWatchdogTelemetryGap?.monitoringAgeMinutes),
      latestClosedBeforeMonitoringStart: readBoolean(futureWatchdogTelemetryGap?.latestClosedBeforeMonitoringStart),
      latestClosedAt: readString(futureWatchdogTelemetryGap?.latestClosedAt),
      futureClosedRowsAfterMonitoringStart: readNumber(futureWatchdogTelemetryGap?.futureClosedRowsAfterMonitoringStart),
      futureRowsMissingPaperFillTelemetry: readNumber(futureWatchdogTelemetryGap?.futureRowsMissingPaperFillTelemetry),
      futureNewOpenRowsMissingPredictedOpenEvidence: readNumber(futureWatchdogTelemetryGap?.futureNewOpenRowsMissingPredictedOpenEvidence),
      orderbookRowsBuilt: readNumber(orderbook?.rowsBuilt),
      orderbookMaxSpreadBps: readNumber(orderbook?.maxSpreadBps),
      orderbookMinDepth5Usd: readNumber(orderbook?.minDepth5Usd),
      requiredOrderbookSymbols: readStringArray(orderbook?.requiredOrderbookSymbols),
      requiredOrderbookPassedSymbols: readStringArray(orderbook?.requiredOrderbookPassedSymbols),
      requiredOrderbookBlockedSymbols: readStringArray(orderbook?.requiredOrderbookBlockedSymbols),
      requiredOrderbookMissingSymbols: readStringArray(orderbook?.requiredOrderbookMissingSymbols),
      requiredOrderbookAllPass: readBoolean(orderbook?.requiredOrderbookAllPass),
      feeSnapshotSource: readString(feeSnapshot?.source),
      feeSnapshotVerifiedByRuntime: readBoolean(feeSnapshot?.verifiedByRuntime),
      routeBudgetFeeSnapshotSource: readString(routeCostBudget?.feeSnapshotSource),
      routeBudgetFeeSnapshotVerifiedByRuntime: readBoolean(routeCostBudget?.feeSnapshotVerifiedByRuntime),
      routeBudgetMatchesRuntimeFeeSnapshot: readBoolean(routeCostBudget?.feeSnapshotMatchesRuntimeFeeSnapshot),
      routesOverBudget: readStringArray(routeCostBudget?.routesOverBudget),
      recentOrderCount: readNumber(executionQuality?.recentOrderCount),
      completePredictedOpenEvidenceCoveragePct: readNumber(paperCostEvidence?.completePredictedOpenEvidenceCoveragePct),
      tradesWithExchangeReconciledCostEvidence: readNumber(paperCostEvidence?.tradesWithExchangeReconciledCostEvidence),
      tradesWithPaperFillTelemetry: readNumber(paperCostEvidence?.tradesWithPaperFillTelemetry),
      paperFillTelemetryCoveragePct: readNumber(paperCostEvidence?.paperFillTelemetryCoveragePct),
      producerHistoricalPaperFillTelemetryCoveragePct: readNumber(historicalProducerQuality?.paperFillTelemetryCoveragePct),
      artifactAllowsExecution,
    },
    required: {
      okxRouteCostSlippageReadinessArtifactPresent: true,
      publicOrderbookUsableForResearch: true,
      runtimeFeeSnapshotUsableForResearch: true,
      routeCostBudgetRuntimeVerified: true,
      routeCostBudgetFresh: true,
      futurePaperProducerReady: true,
      futurePaperFillTelemetrySufficient: true,
      futurePredictedOpenEvidenceSufficient: true,
      paperExecutionTelemetryAvailable: true,
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(okxRouteCostSlippageReadiness ? [] : ['okx_route_cost_slippage_readiness_missing']),
      ...(publicOrderbookUsableForResearch ? [] : ['okx_orderbook_spread_depth_not_research_usable']),
      ...(runtimeFeeSnapshotUsableForResearch ? [] : ['runtime_fee_snapshot_not_research_usable']),
      ...(routeCostBudgetRuntimeVerified ? [] : ['route_cost_budget_not_runtime_fee_verified']),
      ...(routeCostBudgetFresh ? [] : ['route_cost_budget_not_fresh']),
      ...(futurePaperProducerReady ? [] : ['paper_execution_future_producer_contract_not_ready']),
      ...(paperExecutionTelemetryAvailable ? [] : ['paper_execution_slippage_telemetry_unavailable']),
      ...(artifactAllowsExecution ? ['route_cost_slippage_artifact_must_not_authorize_execution'] : []),
      ...artifactBlockers.slice(0, 16),
      ...producerContractBlockers
        .filter(blocker => blocker !== 'exchange_reconciled_cost_evidence_missing' && blocker !== 'observed_slippage_unavailable')
        .slice(0, 8)
        .map(blocker => `producer_contract:${blocker}`),
      ...futureWatchdogBlockers
        .slice(0, 8)
        .map(blocker => `future_telemetry_watchdog:${blocker}`),
      ...futureWatchdogEvidenceBlockers
        .filter(blocker => blocker !== 'paper_execution_future_watchdog_diagnostic_only')
        .slice(0, 8)
        .map(blocker => `future_telemetry_watchdog:${blocker}`),
    ],
    nextActions: [
      'Keep OKX order-book spread/depth snapshots research-only for route-cost stress inputs.',
      'Refresh route-cost budgets through research:okx:runtime-route-cost-budget after runtime fee snapshots are current; do not republish a promotion bundle for this diagnostic update.',
      futurePaperProducerReady
        ? 'Let future gated paper/shadow close rows accumulate paper fill telemetry; do not backfill old rows as promotion evidence.'
        : 'Fix paper close producers until future rows emit paper fill telemetry through the shared cost builder.',
      'Add exchange-reconciled cost and observed slippage telemetry before any promotion claim.',
    ],
    benchmarkLessons: ['execution cost model', 'order book matching', 'backtest/live parity', 'evidence reporting'],
  })
}

function checkVolumeBreakoutStop(source: SourceSnapshot): StrategyDefectFinding {
  const stopLossPct = extractNumberAfterKey(source.text, 'stopLossPct')
  const atrBased = source.text.includes('ATR') || source.text.includes('computeAtr')
  const pass = atrBased || (stopLossPct != null && stopLossPct >= 0.015)
  return finding({
    id: 'volume_breakout_stop_loss',
    title: 'Volume breakout stop-loss is not a noise-level fixed 0.5%',
    severity: 'P1',
    status: pass ? 'watch' : 'blocked',
    evidencePaths: [source.path],
    observed: { stopLossPct, atrBased },
    required: { atrBasedOrStopLossPctGte: 0.015 },
    blockers: pass ? [] : [`stop_loss_too_tight:${stopLossPct ?? 'missing'}<0.015`],
    nextActions: ['Move volume breakout stops to ATR-based logic or a wider validated fixed floor before further promotion work.'],
    benchmarkLessons: ['protections', 'risk management'],
  })
}

function checkVolumeBreakoutHoldAndLiquidity(source: SourceSnapshot): StrategyDefectFinding {
  const holdBars = extractNumberAfterKey(source.text, 'holdBars')
  const minVolumeUsd = extractNumberAfterKey(source.text, 'minVolumeUsd')
  const pass = holdBars != null && holdBars >= 6 && minVolumeUsd != null && minVolumeUsd >= 500_000
  return finding({
    id: 'volume_breakout_hold_liquidity',
    title: 'Volume breakout hold/liquidity parameters avoid ultra-thin noise trades',
    severity: 'P1',
    status: pass ? 'watch' : 'blocked',
    evidencePaths: [source.path],
    observed: { holdBars, minVolumeUsd },
    required: { holdBarsGte: 6, minVolumeUsdGte: 500_000 },
    blockers: [
      ...(holdBars != null && holdBars >= 6 ? [] : [`hold_bars_too_short:${holdBars ?? 'missing'}<6`]),
      ...(minVolumeUsd != null && minVolumeUsd >= 500_000 ? [] : [`min_volume_usd_too_low:${minVolumeUsd ?? 'missing'}<500000`]),
    ],
    nextActions: ['Retest volume breakout with wider hold/liquidity guards and route-cost-adjusted labels.'],
    benchmarkLessons: ['protections', 'hyperopt'],
  })
}

function checkMicrostructureProfiles(source: SourceSnapshot): StrategyDefectFinding {
  const active100x = source.text.includes("id: 'liquidation_probe_100x'") || source.text.includes('id: "liquidation_probe_100x"')
  const active10x = source.text.includes("id: 'stress_10x'") || source.text.includes('id: "stress_10x"')
  const stressOnly100x = /id:\s*['"]liquidation_probe_100x['"][\s\S]{0,200}mode:\s*['"]stress_only['"]/.test(source.text)
  const pass = !active100x || stressOnly100x
  return finding({
    id: 'microstructure_noise_channels',
    title: '100x microstructure liquidation probe is kept out of promotion-critical strategy evidence',
    severity: 'P1',
    status: pass ? 'watch' : 'blocked',
    evidencePaths: [source.path],
    observed: { active100x, active10x, stressOnly100x },
    required: { active100xFalseOrStressOnly: true, active10xMayRemainDiagnosticOnly: true },
    blockers: [
      ...(!active100x || stressOnly100x ? [] : ['liquidation_probe_100x_profile_present']),
    ],
    nextActions: ['Keep 100x probe strictly stress-only and out of promotion-critical evidence until order-book/slippage evidence proves a 1s alpha exists.'],
    benchmarkLessons: ['order book matching', 'event-driven execution'],
  })
}

function checkAtrTrailingIntegration(
  source: SourceSnapshot,
  partialTakeProfitStatus: UnknownRecord | null,
  partialTakeProfitStatusPath?: string,
): StrategyDefectFinding {
  const integrated = source.text.includes('computeAtrTrailingStop')
  const partialChecks = asRecord(partialTakeProfitStatus?.checks)
  const artifactPass = readString(partialTakeProfitStatus?.status) === 'pass'
  const artifactAllowsExecution =
    readBoolean(partialTakeProfitStatus?.promotionEligible) === true ||
    readBoolean(partialTakeProfitStatus?.paperTradingAllowed) === true ||
    readBoolean(partialTakeProfitStatus?.liveTradingAllowed) === true ||
    readBoolean(partialTakeProfitStatus?.executionAllowed) === true
  const partialTakeProfitValidated = partialTakeProfitStatus != null &&
    artifactPass &&
    !artifactAllowsExecution &&
    readNumber(partialChecks?.longFirstTrancheCloseFraction) === 0.5 &&
    readNumber(partialChecks?.longIncrementalCloseFraction) === 0.25 &&
    readNumber(partialChecks?.shortFirstTrancheCloseFraction) === 0.5 &&
    readNumber(partialChecks?.notTriggeredCloseFraction) === 0 &&
    (readNumber(partialChecks?.totalConfiguredCloseFraction) ?? 2) <= 1
  const pass = integrated && partialTakeProfitValidated
  return finding({
    id: 'atr_trailing_exit_integration',
    title: 'Cross-sectional paper path has ATR trailing and partial take-profit exit primitives',
    severity: 'P1',
    status: pass ? 'watch' : 'blocked',
    evidencePaths: [
      source.path,
      'src/domain/strategy/risk/atr-trailing-stop.ts',
      'src/domain/strategy/risk/partial-take-profit.ts',
      partialTakeProfitStatusPath,
    ].filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      computeAtrTrailingStopReferenced: integrated,
      partialTakeProfitStatus: readString(partialTakeProfitStatus?.status),
      partialTakeProfitArtifactAllowsExecution: artifactAllowsExecution,
      partialTakeProfitValidated,
      longFirstTrancheCloseFraction: readNumber(partialChecks?.longFirstTrancheCloseFraction),
      longIncrementalCloseFraction: readNumber(partialChecks?.longIncrementalCloseFraction),
      shortFirstTrancheCloseFraction: readNumber(partialChecks?.shortFirstTrancheCloseFraction),
      notTriggeredCloseFraction: readNumber(partialChecks?.notTriggeredCloseFraction),
      totalConfiguredCloseFraction: readNumber(partialChecks?.totalConfiguredCloseFraction),
    },
    required: { atrTrailingStopIntegrated: true, partialTakeProfitValidated: true },
    blockers: pass
      ? ['exit_primitives_runtime_validated_need_outcome_validation']
      : [
          ...(integrated ? [] : ['atr_trailing_stop_not_integrated']),
          ...(partialTakeProfitStatus ? [] : ['partial_take_profit_status_missing']),
          ...(artifactPass ? [] : ['partial_take_profit_status_not_pass']),
          ...(artifactAllowsExecution ? ['partial_take_profit_artifact_must_not_authorize_execution'] : []),
          ...(partialTakeProfitValidated ? [] : ['partial_take_profit_primitive_not_runtime_validated']),
          ...readStringArray(partialTakeProfitStatus?.blockers).slice(0, 8).map(blocker => `partial_take_profit_status:${blocker}`),
        ],
    nextActions: pass
      ? ['Keep ATR trailing and partial take-profit exit primitives research-only until prospective and paper outcome telemetry proves improvement.']
      : ['Integrate ATR trailing stop and partial take-profit as research-only exit diagnostics before paper promotion.'],
    benchmarkLessons: ['portfolio/risk management', 'protections'],
  })
}

function checkEntryTimingQuality(
  mfeMaeStoplossReport: UnknownRecord | null,
  paperExecutionProducerContractStatus: UnknownRecord | null,
  paperExecutionFutureTelemetryWatchdog: UnknownRecord | null,
  mfeMaeStoplossReportPath?: string,
  producerContractPath?: string,
  futureTelemetryWatchdogPath?: string,
): StrategyDefectFinding {
  const coverage = asRecord(mfeMaeStoplossReport?.coverage)
  const stopLossSummary = asRecord(mfeMaeStoplossReport?.stopLossSummary)
  const stopLossAttribution = asRecord(mfeMaeStoplossReport?.stopLossAttribution)
  const attributionBlockerSummary = asRecord(stopLossAttribution?.blockerSummary)
  const futureWatchdogCounts = asRecord(paperExecutionFutureTelemetryWatchdog?.counts)
  const futureWatchdogReadiness = asRecord(paperExecutionFutureTelemetryWatchdog?.readiness)
  const producerContract = asRecord(paperExecutionProducerContractStatus?.producerContract)
  const historicalProducerQuality = asRecord(paperExecutionProducerContractStatus?.historicalExecutionQuality)
  const reportAllowsClaims =
    readBoolean(mfeMaeStoplossReport?.promotionClaimAllowed) === true ||
    readBoolean(mfeMaeStoplossReport?.profitabilityClaimAllowed) === true ||
    readBoolean(mfeMaeStoplossReport?.executionReplayClaimAllowed) === true ||
    readBoolean(stopLossAttribution?.promotionEligible) === true ||
    readBoolean(stopLossAttribution?.policyMutationAllowed) === true ||
    readBoolean(stopLossAttribution?.profitabilityClaimAllowed) === true
  const artifactAllowsExecution =
    reportAllowsClaims ||
    readBoolean(paperExecutionProducerContractStatus?.promotionEligible) === true ||
    readBoolean(paperExecutionProducerContractStatus?.paperTradingAllowed) === true ||
    readBoolean(paperExecutionProducerContractStatus?.liveTradingAllowed) === true ||
    readBoolean(paperExecutionProducerContractStatus?.executionAllowed) === true ||
    readBoolean(paperExecutionFutureTelemetryWatchdog?.promotionEligible) === true ||
    readBoolean(paperExecutionFutureTelemetryWatchdog?.paperTradingAllowed) === true ||
    readBoolean(paperExecutionFutureTelemetryWatchdog?.liveTradingAllowed) === true ||
    readBoolean(paperExecutionFutureTelemetryWatchdog?.executionAllowed) === true
  const closedTrades = readNumber(coverage?.closedTrades) ?? 0
  const closedDiagnosticsOk = readNumber(coverage?.closedDiagnosticsOk) ?? 0
  const stopLossTrades = readNumber(coverage?.stopLossTrades) ?? 0
  const stopLossDiagnosticsOk = readNumber(coverage?.stopLossDiagnosticsOk) ?? 0
  const stopLossDiagnosticsOkPct = readNumber(coverage?.stopLossDiagnosticsOkPct)
  const stopLossKnownOrdering = readNumber(coverage?.stopLossKnownOrdering) ?? 0
  const stopLossCoarseOrdering = readNumber(coverage?.stopLossCoarseOrdering) ?? 0
  const missingRoundTripCostAtOpenCount = readNumber(attributionBlockerSummary?.missingRoundTripCostAtOpenCount) ?? 0
  const missingMarkMatchStatusAtOpenCount = readNumber(attributionBlockerSummary?.missingMarkMatchStatusAtOpenCount) ?? 0
  const legacyOrMissingContextCount = readNumber(attributionBlockerSummary?.legacyOrMissingContextCount) ?? 0
  const futurePaperProducerReady = readBoolean(producerContract?.futurePaperCloseRowsReady) === true
  const futureClosedRows = readNumber(futureWatchdogCounts?.futureClosedRows) ?? 0
  const futureClosedRowsWithOpenAfterStart = readNumber(futureWatchdogCounts?.futureClosedRowsWithOpenAfterStart) ?? 0
  const futureRowsWithPaperFillTelemetry = readNumber(futureWatchdogCounts?.futureRowsWithPaperFillTelemetry) ?? 0
  const futureRowsWithObservedSlippage = readNumber(futureWatchdogCounts?.futureRowsWithObservedSlippage) ?? 0
  const futurePaperFillTelemetrySufficient = readBoolean(futureWatchdogReadiness?.futurePaperFillTelemetrySufficient) === true
  const futureObservedSlippageAvailable = readBoolean(futureWatchdogReadiness?.observedSlippageAvailable) === true
  const hasPathTimingDiagnostics = mfeMaeStoplossReport != null &&
    readString(mfeMaeStoplossReport?.metricBasis) === 'price_path_bps' &&
    closedTrades > 0 &&
    closedDiagnosticsOk === closedTrades &&
    stopLossTrades > 0 &&
    stopLossDiagnosticsOk === stopLossTrades &&
    stopLossDiagnosticsOkPct === 100 &&
    !reportAllowsClaims
  const hasExecutionGradeEntryTelemetry = futureClosedRows > 0 &&
    futureClosedRowsWithOpenAfterStart > 0 &&
    futureRowsWithPaperFillTelemetry >= futureClosedRows &&
    futureRowsWithObservedSlippage >= futureClosedRows &&
    futurePaperFillTelemetrySufficient &&
    futureObservedSlippageAvailable
  const pass = hasPathTimingDiagnostics &&
    hasExecutionGradeEntryTelemetry &&
    missingRoundTripCostAtOpenCount === 0 &&
    missingMarkMatchStatusAtOpenCount === 0 &&
    legacyOrMissingContextCount === 0 &&
    !artifactAllowsExecution
  return finding({
    id: 'entry_timing_quality',
    title: 'Entry timing quality is monitored with path diagnostics and future fill telemetry gates',
    severity: 'P1',
    status: pass ? 'watch' : hasPathTimingDiagnostics ? 'blocked' : 'blocked',
    evidencePaths: [mfeMaeStoplossReportPath, producerContractPath, futureTelemetryWatchdogPath]
      .filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      metricBasis: readString(mfeMaeStoplossReport?.metricBasis),
      closedTrades,
      closedDiagnosticsOk,
      stopLossTrades,
      stopLossDiagnosticsOk,
      stopLossDiagnosticsOkPct,
      stopLossKnownOrdering,
      stopLossCoarseOrdering,
      avgStopLossMfeBps: readNumber(stopLossSummary?.avgMfeBps),
      avgStopLossMaeBps: readNumber(stopLossSummary?.avgMaeBps),
      medianStopLossMfeBps: readNumber(stopLossSummary?.medianMfeBps),
      medianStopLossMaeBps: readNumber(stopLossSummary?.medianMaeBps),
      mfeBeforeStopSharePct: readNumber(stopLossSummary?.mfeBeforeStopSharePct),
      stopLossAttributionStatus: readString(stopLossAttribution?.status),
      missingRoundTripCostAtOpenCount,
      missingMarkMatchStatusAtOpenCount,
      legacyOrMissingContextCount,
      coarseOrderingAmbiguousCount: readNumber(attributionBlockerSummary?.coarseOrderingAmbiguousCount),
      producerContractStatus: readString(paperExecutionProducerContractStatus?.status),
      futureTelemetryWatchdogStatus: readString(paperExecutionFutureTelemetryWatchdog?.status),
      futurePaperProducerReady,
      futureClosedRows,
      futureClosedRowsWithOpenAfterStart,
      futureRowsWithPaperFillTelemetry,
      futureRowsWithObservedSlippage,
      futurePaperFillTelemetrySufficient,
      futureObservedSlippageAvailable,
      historicalPaperFillTelemetryCoveragePct: readNumber(historicalProducerQuality?.paperFillTelemetryCoveragePct),
      hasPathTimingDiagnostics,
      hasExecutionGradeEntryTelemetry,
      artifactAllowsExecution,
    },
    required: {
      pathTimingDiagnosticsPresent: true,
      closedDiagnosticsCoveragePct: 100,
      stopLossDiagnosticsCoveragePct: 100,
      futureFillTelemetryRowsPresent: true,
      futureObservedSlippagePresent: true,
      openContextRoundTripCostPresent: true,
      openContextMarkMatchStatusPresent: true,
      legacyOrMissingContextEq: 0,
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(mfeMaeStoplossReport ? [] : ['mfe_mae_stoploss_report_missing']),
      ...(hasPathTimingDiagnostics ? [] : ['entry_path_timing_diagnostics_missing_or_low_coverage']),
      ...(futurePaperProducerReady ? [] : ['paper_execution_future_producer_contract_not_ready']),
      ...(futureClosedRows > 0 ? [] : ['future_closed_paper_rows_missing']),
      ...(futureClosedRowsWithOpenAfterStart > 0 ? [] : ['future_new_open_closed_rows_missing']),
      ...(futurePaperFillTelemetrySufficient ? [] : ['future_paper_fill_telemetry_not_sufficient']),
      ...(futureObservedSlippageAvailable ? [] : ['future_observed_slippage_unavailable']),
      ...(missingRoundTripCostAtOpenCount === 0 ? [] : [`open_round_trip_cost_missing:${missingRoundTripCostAtOpenCount}`]),
      ...(missingMarkMatchStatusAtOpenCount === 0 ? [] : [`open_mark_match_status_missing:${missingMarkMatchStatusAtOpenCount}`]),
      ...(legacyOrMissingContextCount === 0 ? [] : [`legacy_or_missing_open_context:${legacyOrMissingContextCount}`]),
      ...(artifactAllowsExecution ? ['entry_timing_artifacts_must_not_authorize_execution'] : []),
      ...readStringArray(paperExecutionFutureTelemetryWatchdog?.evidenceBlockers)
        .filter(blocker =>
          blocker.includes('future_closed') ||
          blocker.includes('future_new_open') ||
          blocker.includes('observed_slippage') ||
          blocker.includes('telemetry'),
        )
        .slice(0, 8)
        .map(blocker => `future_telemetry_watchdog:${blocker}`),
    ],
    nextActions: [
      'Use the current MFE/MAE stop-loss path diagnostics to locate immediate-adverse-excursion clusters, but do not treat them as execution replay or profitability evidence.',
      'Let future gated paper/shadow rows accumulate fill telemetry, observed slippage, and complete open-context cost snapshots before changing entry policy.',
      'After enough future rows exist, split entry timing by lane, symbol, side, spread bucket, liquidity bucket, route-cost bucket, and regime before strategy retuning.',
    ],
    benchmarkLessons: ['event-driven execution', 'order book matching', 'backtest/live parity', 'evidence reporting'],
  })
}

function checkStaleDataOpenGate(
  actionGate: SourceSnapshot,
  scoring: SourceSnapshot,
  staleDataNoOpenGateStatus: UnknownRecord | null,
  staleDataNoOpenGateStatusPath?: string,
): StrategyDefectFinding {
  const mentionsStale = actionGate.text.includes('staleDataApplied') || scoring.text.includes('staleDataApplied')
  const explicitNoOpen = /staleDataApplied[\s\S]{0,300}(allowOpen|allowNew|allowEntry)[\s\S]{0,80}false/.test(actionGate.text) ||
    /staleData[\s\S]{0,300}(allowOpen|allowNew|allowEntry)[\s\S]{0,80}false/.test(actionGate.text) ||
    /staleDataApplied[\s\S]{0,240}\?[\s\S]{0,80}['"]no-trade['"]/.test(actionGate.text) ||
    /const staleDataApplied = context\.staleData === true[\s\S]{0,240}actionStatus = staleDataApplied[\s\S]{0,80}['"]no-trade['"]/.test(actionGate.text)
  const statusChecks = asRecord(staleDataNoOpenGateStatus?.checks)
  const artifactPass = readString(staleDataNoOpenGateStatus?.status) === 'pass'
  const artifactAllowsExecution =
    readBoolean(staleDataNoOpenGateStatus?.promotionEligible) === true ||
    readBoolean(staleDataNoOpenGateStatus?.paperTradingAllowed) === true ||
    readBoolean(staleDataNoOpenGateStatus?.liveTradingAllowed) === true ||
    readBoolean(staleDataNoOpenGateStatus?.executionAllowed) === true
  const staleActionNoTrade = readString(statusChecks?.staleHighConfidenceActionStatus) === 'no-trade'
  const staleOpenBlocked = readString(statusChecks?.staleOpenDecisionMode) === 'blocked'
  const staleReducePassThrough = readBoolean(statusChecks?.staleReducePassThrough) === true
  const pass = explicitNoOpen &&
    artifactPass &&
    !artifactAllowsExecution &&
    staleActionNoTrade &&
    staleOpenBlocked &&
    staleReducePassThrough
  return finding({
    id: 'stale_data_no_open_gate',
    title: 'Stale data blocks new opens instead of only reducing score',
    severity: 'P0',
    status: pass ? 'pass' : explicitNoOpen ? 'watch' : 'blocked',
    evidencePaths: [actionGate.path, scoring.path, staleDataNoOpenGateStatusPath]
      .filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      mentionsStale,
      explicitNoOpen,
      artifactStatus: readString(staleDataNoOpenGateStatus?.status),
      artifactAllowsExecution,
      staleHighConfidenceActionStatus: readString(statusChecks?.staleHighConfidenceActionStatus),
      freshHighConfidenceActionStatus: readString(statusChecks?.freshHighConfidenceActionStatus),
      staleOpenDecisionMode: readString(statusChecks?.staleOpenDecisionMode),
      staleOpenBlockReason: readString(statusChecks?.staleOpenBlockReason),
      staleReduceDecisionMode: readString(statusChecks?.staleReduceDecisionMode),
      staleReducePassThrough,
    },
    required: {
      staleDataMustBlockNewOpen: true,
      staleDataStatusArtifactPass: true,
      staleReduceMustRemainPassThrough: true,
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(explicitNoOpen ? [] : ['stale_data_no_explicit_open_block']),
      ...(staleDataNoOpenGateStatus ? [] : ['stale_data_no_open_gate_status_missing']),
      ...(artifactPass ? [] : ['stale_data_no_open_gate_status_not_pass']),
      ...(artifactAllowsExecution ? ['stale_data_no_open_gate_artifact_must_not_authorize_execution'] : []),
      ...(staleActionNoTrade ? [] : [`stale_governance_not_no_trade:${readString(statusChecks?.staleHighConfidenceActionStatus) ?? 'missing'}`]),
      ...(staleOpenBlocked ? [] : [`stale_new_open_not_blocked:${readString(statusChecks?.staleOpenDecisionMode) ?? 'missing'}`]),
      ...(staleReducePassThrough ? [] : [`stale_reduce_not_pass_through:${readString(statusChecks?.staleReduceDecisionMode) ?? 'missing'}`]),
      ...readStringArray(staleDataNoOpenGateStatus?.blockers).slice(0, 8).map(blocker => `stale_data_status:${blocker}`),
    ],
    nextActions: pass
      ? ['Keep stale-data no-open status in the research-evidence refresh chain; this is protection evidence, not trading authorization.']
      : ['Add or verify a fail-closed new-open gate for stale data while still allowing risk-reducing closes.'],
    benchmarkLessons: ['protections', 'live trading safety'],
  })
}

function checkPanicRegimeOpenGate(
  panicRegimeNoOpenGateStatus: UnknownRecord | null,
  panicRegimeNoOpenGateStatusPath?: string,
): StrategyDefectFinding {
  const checks = asRecord(panicRegimeNoOpenGateStatus?.checks)
  const artifactPass = readString(panicRegimeNoOpenGateStatus?.status) === 'pass'
  const artifactAllowsExecution =
    readBoolean(panicRegimeNoOpenGateStatus?.promotionEligible) === true ||
    readBoolean(panicRegimeNoOpenGateStatus?.paperTradingAllowed) === true ||
    readBoolean(panicRegimeNoOpenGateStatus?.liveTradingAllowed) === true ||
    readBoolean(panicRegimeNoOpenGateStatus?.executionAllowed) === true
  const eventFreezeDetected = readString(checks?.eventFreezeRegime) === 'event-risk-freeze'
  const eventFreezeActionReduce = readString(checks?.eventFreezeActionStatus) === 'reduce'
  const eventFreezeCapped = readBoolean(checks?.eventFreezeCappedByEventWindow) === true
  const eventFreezeOpenBlocked = readString(checks?.eventFreezeOpenDecisionMode) === 'blocked'
  const eventFreezeReducePassThrough = readBoolean(checks?.eventFreezeReducePassThrough) === true
  const volStressDetected = readString(checks?.volStressRegime) === 'vol-stress'
  const volStressOpenBlocked = readString(checks?.volStressOpenDecisionMode) === 'blocked'
  const volStressReducePassThrough = readBoolean(checks?.volStressReducePassThrough) === true
  const pass = panicRegimeNoOpenGateStatus != null &&
    artifactPass &&
    !artifactAllowsExecution &&
    eventFreezeDetected &&
    eventFreezeActionReduce &&
    eventFreezeCapped &&
    eventFreezeOpenBlocked &&
    eventFreezeReducePassThrough &&
    volStressDetected &&
    volStressOpenBlocked &&
    volStressReducePassThrough
  return finding({
    id: 'panic_regime_no_open_gate',
    title: 'Panic/regime stress blocks new opens while reduce-only remains available',
    severity: 'P1',
    status: pass ? 'pass' : 'blocked',
    evidencePaths: [
      panicRegimeNoOpenGateStatusPath,
      'src/domain/strategy/governance/action-gate.ts',
      'src/domain/strategy/regime/classifier.ts',
      'src/domain/strategy/execution.ts',
    ].filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus: readString(panicRegimeNoOpenGateStatus?.status),
      artifactAllowsExecution,
      eventFreezeRegime: readString(checks?.eventFreezeRegime),
      eventFreezeActionStatus: readString(checks?.eventFreezeActionStatus),
      eventFreezeBaseActionStatus: readString(checks?.eventFreezeBaseActionStatus),
      eventFreezeCappedByEventWindow: readBoolean(checks?.eventFreezeCappedByEventWindow),
      eventFreezeOpenDecisionMode: readString(checks?.eventFreezeOpenDecisionMode),
      eventFreezeOpenBlockReason: readString(checks?.eventFreezeOpenBlockReason),
      eventFreezeReduceDecisionMode: readString(checks?.eventFreezeReduceDecisionMode),
      eventFreezeReducePassThrough,
      volStressRegime: readString(checks?.volStressRegime),
      volStressConfidence: readNumber(checks?.volStressConfidence),
      volStressOpenDecisionMode: readString(checks?.volStressOpenDecisionMode),
      volStressOpenBlockReason: readString(checks?.volStressOpenBlockReason),
      volStressReduceDecisionMode: readString(checks?.volStressReduceDecisionMode),
      volStressReducePassThrough,
    },
    required: {
      panicRegimeStatusArtifactPresent: true,
      eventFreezeRegimeDetected: true,
      eventFreezeGovernanceCappedToReduce: true,
      eventFreezeNewOpenBlocked: true,
      eventFreezeReducePassThrough: true,
      volStressRegimeDetected: true,
      volStressNewOpenBlocked: true,
      volStressReducePassThrough: true,
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(panicRegimeNoOpenGateStatus ? [] : ['panic_regime_no_open_gate_status_missing']),
      ...(artifactPass ? [] : ['panic_regime_no_open_gate_status_not_pass']),
      ...(artifactAllowsExecution ? ['panic_regime_no_open_gate_artifact_must_not_authorize_execution'] : []),
      ...(eventFreezeDetected ? [] : [`event_freeze_regime_not_detected:${readString(checks?.eventFreezeRegime) ?? 'missing'}`]),
      ...(eventFreezeActionReduce ? [] : [`event_freeze_action_not_reduce:${readString(checks?.eventFreezeActionStatus) ?? 'missing'}`]),
      ...(eventFreezeCapped ? [] : ['event_freeze_not_capped_by_event_window']),
      ...(eventFreezeOpenBlocked ? [] : [`event_freeze_new_open_not_blocked:${readString(checks?.eventFreezeOpenDecisionMode) ?? 'missing'}`]),
      ...(eventFreezeReducePassThrough ? [] : [`event_freeze_reduce_not_pass_through:${readString(checks?.eventFreezeReduceDecisionMode) ?? 'missing'}`]),
      ...(volStressDetected ? [] : [`vol_stress_regime_not_detected:${readString(checks?.volStressRegime) ?? 'missing'}`]),
      ...(volStressOpenBlocked ? [] : [`vol_stress_new_open_not_blocked:${readString(checks?.volStressOpenDecisionMode) ?? 'missing'}`]),
      ...(volStressReducePassThrough ? [] : [`vol_stress_reduce_not_pass_through:${readString(checks?.volStressReduceDecisionMode) ?? 'missing'}`]),
      ...readStringArray(panicRegimeNoOpenGateStatus?.blockers)
        .slice(0, 8)
        .map(blocker => `panic_regime_status:${blocker}`),
    ],
    nextActions: pass
      ? ['Keep panic/regime no-open status in the research-evidence refresh chain; this is protection evidence, not trading authorization.']
      : ['Wire event-risk-freeze and vol-stress handling so new opens are blocked while genuine reduce/close actions remain available.'],
    benchmarkLessons: ['protections', 'portfolio/risk management', 'event-driven execution'],
  })
}

function checkNoTradeRiskFilter(
  noTradeRiskFilter: UnknownRecord | null,
  noTradeRiskFilterPath?: string,
): StrategyDefectFinding {
  const summary = asRecord(noTradeRiskFilter?.summary)
  const artifactPass = readString(noTradeRiskFilter?.status) === 'pass'
  const artifactAllowsExecution =
    readBoolean(noTradeRiskFilter?.promotionEligible) === true ||
    readBoolean(noTradeRiskFilter?.paperTradingAllowed) === true ||
    readBoolean(noTradeRiskFilter?.liveTradingAllowed) === true ||
    readBoolean(noTradeRiskFilter?.executionAllowed) === true
  const pass = noTradeRiskFilter != null &&
    artifactPass &&
    !artifactAllowsExecution
  return finding({
    id: 'no_trade_risk_filter',
    title: 'No-trade risk filter protects against crash/high-vol/spread/stale-data/macro events',
    severity: 'P0',
    status: pass ? 'pass' : 'blocked',
    evidencePaths: [noTradeRiskFilterPath]
      .filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus: readString(noTradeRiskFilter?.status),
      artifactAllowsExecution,
      blocked: readBoolean(summary?.blocked),
      blockCount: readNumber(summary?.blockCount),
      totalChecks: readNumber(summary?.totalChecks),
      primaryReason: readString(summary?.primaryReason),
    },
    required: {
      noTradeRiskFilterArtifactPresent: true,
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(noTradeRiskFilter ? [] : ['no_trade_risk_filter_missing']),
      ...(artifactPass ? [] : ['no_trade_risk_filter_status_not_pass']),
      ...(artifactAllowsExecution ? ['no_trade_risk_filter_must_not_authorize_execution'] : []),
      ...readStringArray(noTradeRiskFilter?.blockers)
        .slice(0, 8)
        .map(blocker => `no_trade_risk_filter_blocker:${blocker}`),
    ],
    nextActions: pass
      ? ['Keep no-trade risk filter in the research-evidence refresh chain; this is crash protection evidence, not trading authorization.']
      : ['Ensure no-trade risk filter artifact exists with status=pass and all execution flags false.'],
    benchmarkLessons: ['protections', 'live trading safety'],
  })
}

function checkStrategyRiskCaps(
  strategyRiskCapStatus: UnknownRecord | null,
  strategyRiskCapStatusPath?: string,
): StrategyDefectFinding {
  const checks = asRecord(strategyRiskCapStatus?.checks)
  const singleTradeLossProbe = asRecord(checks?.singleTradeLossProbe)
  const totalExposureProbe = asRecord(checks?.totalExposureProbe)
  const reduceOnlyPassThroughProbe = asRecord(checks?.reduceOnlyPassThroughProbe)
  const symbolConcentrationProbe = asRecord(checks?.symbolConcentrationProbe)
  const netDirectionalExposureProbe = asRecord(checks?.netDirectionalExposureProbe)
  const correlatedGroupExposureProbe = asRecord(checks?.correlatedGroupExposureProbe)
  const artifactPass = readString(strategyRiskCapStatus?.status) === 'pass'
  const artifactAllowsExecution =
    readBoolean(strategyRiskCapStatus?.promotionEligible) === true ||
    readBoolean(strategyRiskCapStatus?.paperTradingAllowed) === true ||
    readBoolean(strategyRiskCapStatus?.liveTradingAllowed) === true ||
    readBoolean(strategyRiskCapStatus?.executionAllowed) === true
  const singleTradeLossBlocks =
    readBoolean(singleTradeLossProbe?.approved) === false &&
    (readString(singleTradeLossProbe?.reason)?.includes('maxSingleTradeLossUsd') ?? false)
  const totalExposureBlocks =
    readBoolean(totalExposureProbe?.approved) === false &&
    (readString(totalExposureProbe?.reason)?.includes('maxTotalExposurePctOfEquity') ?? false)
  const reduceOnlyPassThrough = readBoolean(reduceOnlyPassThroughProbe?.approved) === true
  const symbolConcentrationBlocks =
    readBoolean(symbolConcentrationProbe?.approved) === false &&
    (readString(symbolConcentrationProbe?.reason)?.includes('maxSymbolExposurePctOfEquity') ?? false)
  const netDirectionalExposureBlocks =
    readBoolean(netDirectionalExposureProbe?.approved) === false &&
    (readString(netDirectionalExposureProbe?.reason)?.includes('maxNetDirectionalExposurePctOfEquity') ?? false)
  const correlatedGroupExposureBlocks =
    readBoolean(correlatedGroupExposureProbe?.approved) === false &&
    (readString(correlatedGroupExposureProbe?.reason)?.includes('maxCorrelatedGroupExposurePctOfEquity') ?? false)
  const pass = strategyRiskCapStatus != null &&
    artifactPass &&
    !artifactAllowsExecution &&
    singleTradeLossBlocks &&
    totalExposureBlocks &&
    symbolConcentrationBlocks &&
    netDirectionalExposureBlocks &&
    correlatedGroupExposureBlocks &&
    reduceOnlyPassThrough
  return finding({
    id: 'strategy_risk_caps',
    title: 'Single-trade loss and total-exposure caps block new risk while reduce-only passes',
    severity: 'P0',
    status: pass ? 'pass' : 'blocked',
    evidencePaths: [
      strategyRiskCapStatusPath,
      'src/domain/trading/risk.ts',
      'src/domain/trading/risk.spec.ts',
    ].filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus: readString(strategyRiskCapStatus?.status),
      artifactAllowsExecution,
      singleTradeLossBlocks,
      singleTradeLossReason: readString(singleTradeLossProbe?.reason),
      totalExposureBlocks,
      totalExposureReason: readString(totalExposureProbe?.reason),
      symbolConcentrationBlocks,
      symbolConcentrationReason: readString(symbolConcentrationProbe?.reason),
      netDirectionalExposureBlocks,
      netDirectionalExposureReason: readString(netDirectionalExposureProbe?.reason),
      correlatedGroupExposureBlocks,
      correlatedGroupExposureReason: readString(correlatedGroupExposureProbe?.reason),
      reduceOnlyPassThrough,
      maxSingleTradeLossUsdConfigured: readNumber(checks?.maxSingleTradeLossUsdConfigured),
      maxTotalExposurePctOfEquityConfigured: readNumber(checks?.maxTotalExposurePctOfEquityConfigured),
      maxSymbolExposurePctOfEquityConfigured: readNumber(checks?.maxSymbolExposurePctOfEquityConfigured),
      maxNetDirectionalExposurePctOfEquityConfigured: readNumber(checks?.maxNetDirectionalExposurePctOfEquityConfigured),
      maxCorrelatedGroupExposurePctOfEquityConfigured: readNumber(checks?.maxCorrelatedGroupExposurePctOfEquityConfigured),
      maxOrderUsdConfigured: readNumber(checks?.maxOrderUsdConfigured),
      maxPositionPctOfEquityConfigured: readNumber(checks?.maxPositionPctOfEquityConfigured),
    },
    required: {
      strategyRiskCapStatusArtifactPresent: true,
      singleTradeLossCapBlocksNewOpen: true,
      totalExposureCapBlocksNewOpen: true,
      symbolConcentrationCapBlocksNewOpen: true,
      netDirectionalExposureCapBlocksNewOpen: true,
      correlatedGroupExposureCapBlocksNewOpen: true,
      reduceOnlyMustRemainPassThrough: true,
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(strategyRiskCapStatus ? [] : ['strategy_risk_cap_status_missing']),
      ...(artifactPass ? [] : ['strategy_risk_cap_status_not_pass']),
      ...(artifactAllowsExecution ? ['strategy_risk_cap_artifact_must_not_authorize_execution'] : []),
      ...(singleTradeLossBlocks ? [] : ['single_trade_loss_cap_not_blocking_new_open']),
      ...(totalExposureBlocks ? [] : ['total_exposure_cap_not_blocking_new_open']),
      ...(symbolConcentrationBlocks ? [] : ['symbol_concentration_cap_not_blocking_new_open']),
      ...(netDirectionalExposureBlocks ? [] : ['net_directional_exposure_cap_not_blocking_new_open']),
      ...(correlatedGroupExposureBlocks ? [] : ['correlated_group_exposure_cap_not_blocking_new_open']),
      ...(reduceOnlyPassThrough ? [] : ['risk_reducing_reduce_only_not_pass_through']),
      ...readStringArray(strategyRiskCapStatus?.blockers).slice(0, 8).map(blocker => `risk_cap_status:${blocker}`),
    ],
    nextActions: pass
      ? [
          'Keep risk-cap status in the research-evidence refresh chain; this closes only the cap-evidence part of the P0 risk checklist.',
          'Add concentration, correlation, and long/short net-exposure diagnostics before claiming portfolio risk completeness.',
        ]
      : [
          'Wire pre-trade risk checks so over-limit single-trade loss and portfolio exposure block new opens while reduce-only remains available.',
        ],
    benchmarkLessons: ['protections', 'portfolio/risk management', 'live trading safety'],
  })
}

function checkCarryPitAndBasis(
  ethCarryEvidence: UnknownRecord | null,
  ethCarryDataGapStatus: UnknownRecord | null,
  path: string,
  dataGapPath?: string,
): StrategyDefectFinding {
  const blockers = readStringArray(ethCarryEvidence?.blockers)
  const dataGapBlockers = readStringArray(ethCarryDataGapStatus?.blockers)
  const dataGapCounts = asRecord(ethCarryDataGapStatus?.counts)
  const dataGapThresholds = asRecord(ethCarryDataGapStatus?.thresholds)
  const fundingMissing = blockers.some(blocker => blocker.includes('funding_available_time_missing'))
  const basisMissing = blockers.includes('basis_spread_feature_missing')
  const netNonPositive = blockers.some(blocker => blocker.includes('net_expectancy_non_positive'))
  const carryFeatureRows = readNumber(dataGapCounts?.carryFeatureRows)
  const minCarryFeatureRows = readNumber(dataGapThresholds?.minCarryFeatureRows) ?? 100
  const collectorErrorCount = readNumber(dataGapCounts?.collectorErrorCount) ?? 0
  const sampleLow = carryFeatureRows != null && carryFeatureRows < minCarryFeatureRows
  const coreArchiveBlockers = dataGapBlockers.filter(blocker => blocker.startsWith('data_vision_core_archive_'))
  const coreArchiveMissing = coreArchiveBlockers.some(blocker => blocker.startsWith('data_vision_core_archive_missing:'))
  const archiveSummary = asRecord(ethCarryDataGapStatus?.dataVisionArchiveSummary)
  const coreSmokeComplete = readBoolean(archiveSummary?.coreSmokeComplete)
  const pass = ethCarryEvidence != null &&
    !fundingMissing &&
    !basisMissing &&
    !netNonPositive &&
    !sampleLow &&
    collectorErrorCount === 0 &&
    coreArchiveBlockers.length === 0
  return finding({
    id: 'carry_pit_basis_economics',
    title: 'Funding/carry line has PIT availableAt, basis feature, and positive net economics',
    severity: 'P0',
    status: pass ? 'watch' : 'blocked',
    evidencePaths: [path, dataGapPath].filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      status: readString(ethCarryEvidence?.status),
      fundingMissing,
      basisMissing,
      netNonPositive,
      profitabilityVerdict: readString(ethCarryEvidence?.profitabilityVerdict),
      dataGapStatus: readString(ethCarryDataGapStatus?.status),
      carryFeatureRows,
      minCarryFeatureRows,
      collectorErrorCount,
      coreArchiveMissing,
      coreSmokeComplete,
    },
    required: {
      fundingAvailableAtComplete: true,
      basisSpreadFeaturePresent: true,
      carryFeatureRowsGte: minCarryFeatureRows,
      collectorErrorsEq: 0,
      coreDataVisionArchivesPresent: true,
      netExpectancyPositive: true,
    },
    blockers: pass ? [] : [
      ...(ethCarryEvidence ? [] : ['eth_carry_evidence_missing']),
      ...(fundingMissing ? ['funding_available_time_missing'] : []),
      ...(basisMissing ? ['basis_spread_feature_missing'] : []),
      ...(sampleLow ? [`carry_feature_rows_low:${carryFeatureRows}<${minCarryFeatureRows}`] : []),
      ...(collectorErrorCount > 0 ? [`external_derivatives_collect_errors:${collectorErrorCount}`] : []),
      ...coreArchiveBlockers.slice(0, 8),
      ...(netNonPositive ? ['net_expectancy_non_positive'] : []),
    ],
    nextActions: ['Prioritize PIT funding availableAt and mark/index/spot basis feature work before another carry strategy claim.'],
    benchmarkLessons: ['research workflow', 'evidence reporting', 'backtest/live parity'],
  })
}

function checkCarryProspectiveEvidence(
  ethCarryProspectiveEvidence: UnknownRecord | null,
  ethCarryDataGapStatus: UnknownRecord | null,
  path: string,
  dataGapPath?: string,
): StrategyDefectFinding {
  const counts = asRecord(ethCarryProspectiveEvidence?.counts)
  const metrics = asRecord(ethCarryProspectiveEvidence?.metrics)
  const thresholds = asRecord(ethCarryProspectiveEvidence?.thresholds)
  const blockers = readStringArray(ethCarryProspectiveEvidence?.blockers)
  const dataGapBlockers = readStringArray(ethCarryDataGapStatus?.blockers)
  const dataGapCounts = asRecord(ethCarryDataGapStatus?.counts)
  const closedOutcomes = readNumber(metrics?.closedOutcomes) ?? readNumber(dataGapCounts?.prospectiveClosedOutcomes) ?? readNumber(counts?.closedEvents) ?? 0
  const closedDecisionWindows = readNumber(counts?.closedDecisionWindows) ?? readNumber(dataGapCounts?.prospectiveClosedDecisionWindows) ?? 0
  const minClosedOutcomes = readNumber(thresholds?.minClosedOutcomes) ?? 100
  const minNonOverlappingWindows = readNumber(thresholds?.minNonOverlappingWindows) ?? 3
  const meanGrossCarryPairReturnPct = readNumber(metrics?.meanGrossCarryPairReturnPct)
  const winRatePct = readNumber(metrics?.winRatePct)
  const routeCostAdjustedClosedOutcomes = readNumber(metrics?.routeCostAdjustedClosedOutcomes) ?? 0
  const fundingCashflowAccountedClosedOutcomes = readNumber(metrics?.fundingCashflowAccountedClosedOutcomes) ?? 0
  const routeCostComplete = closedOutcomes > 0 && routeCostAdjustedClosedOutcomes >= closedOutcomes
  const fundingCashflowComplete = closedOutcomes > 0 && fundingCashflowAccountedClosedOutcomes >= closedOutcomes
  const sampleComplete = closedOutcomes >= minClosedOutcomes && closedDecisionWindows >= minNonOverlappingWindows
  const meanPositive = meanGrossCarryPairReturnPct != null && meanGrossCarryPairReturnPct > 0
  const pass = ethCarryProspectiveEvidence != null &&
    sampleComplete &&
    routeCostComplete &&
    fundingCashflowComplete &&
    meanPositive &&
    blockers.length === 0
  return finding({
    id: 'carry_prospective_evidence',
    title: 'Funding/carry prospective labels are PIT-safe, cost-adjusted, and positive enough for continued research',
    severity: 'P0',
    status: pass ? 'watch' : 'blocked',
    evidencePaths: [path, dataGapPath].filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      status: readString(ethCarryProspectiveEvidence?.status),
      closedOutcomes,
      closedDecisionWindows,
      minClosedOutcomes,
      minNonOverlappingWindows,
      meanGrossCarryPairReturnPct,
      winRatePct,
      routeCostAdjustedClosedOutcomes,
      fundingCashflowAccountedClosedOutcomes,
      dataGapStatus: readString(ethCarryDataGapStatus?.status),
      prospectiveClosedOutcomeShortfall: readNumber(dataGapCounts?.prospectiveClosedOutcomeShortfall),
      latestOpen: asRecord(ethCarryProspectiveEvidence?.latestOpen),
      latestClosed: asRecord(ethCarryProspectiveEvidence?.latestClosed),
    },
    required: {
      prospectiveArtifactPresent: true,
      closedOutcomesGte: minClosedOutcomes,
      closedDecisionWindowsGte: minNonOverlappingWindows,
      routeCostAdjustedLabelsComplete: true,
      fundingCashflowLabelsComplete: true,
      meanGrossCarryPairReturnPctGt: 0,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
    },
    blockers: pass ? [] : [
      ...(ethCarryProspectiveEvidence ? [] : ['eth_carry_prospective_evidence_missing']),
      ...(closedOutcomes >= minClosedOutcomes ? [] : [`prospective_closed_outcomes_low:${closedOutcomes}<${minClosedOutcomes}`]),
      ...(closedDecisionWindows >= minNonOverlappingWindows ? [] : [`prospective_closed_windows_low:${closedDecisionWindows}<${minNonOverlappingWindows}`]),
      ...(routeCostComplete ? [] : ['prospective_route_cost_adjusted_labels_missing']),
      ...(fundingCashflowComplete ? [] : ['prospective_funding_cashflow_labels_missing']),
      ...(closedOutcomes > 0 && !meanPositive
        ? [`prospective_mean_gross_non_positive:${meanGrossCarryPairReturnPct ?? 'missing'}`]
        : []),
      ...dataGapBlockers
        .filter(blocker => blocker.startsWith('prospective_'))
        .slice(0, 8),
      ...blockers
        .filter(blocker =>
          blocker.includes('research_only') ||
          blocker.includes('paper_live') ||
          blocker.includes('not_promotion') ||
          blocker.includes('not_trial') ||
          blocker.includes('not_paper') ||
          blocker.includes('closed_outcomes') ||
          blocker.includes('closed_windows'),
        )
        .slice(0, 12),
    ],
    nextActions: [
      'Continue scheduled ETH carry prospective capture/settle until at least 100 closed outcomes across 3 non-overlapping decision windows are available.',
      'Do not tune or promote from these labels while the mean closed prospective return is non-positive or while research-only blockers remain.',
    ],
    benchmarkLessons: ['research workflow', 'backtest/live parity', 'evidence reporting'],
  })
}

function checkDynamicLeverageVolatilityGate(
  dynamicLeverageVolatilityGateStatus: UnknownRecord | null,
  dynamicLeverageVolatilityGateStatusPath?: string,
): StrategyDefectFinding {
  const checks = asRecord(dynamicLeverageVolatilityGateStatus?.checks)
  const artifactPass = readString(dynamicLeverageVolatilityGateStatus?.status) === 'pass'
  const artifactAllowsExecution =
    readBoolean(dynamicLeverageVolatilityGateStatus?.promotionEligible) === true ||
    readBoolean(dynamicLeverageVolatilityGateStatus?.paperTradingAllowed) === true ||
    readBoolean(dynamicLeverageVolatilityGateStatus?.liveTradingAllowed) === true ||
    readBoolean(dynamicLeverageVolatilityGateStatus?.executionAllowed) === true
  const volatilityPercentileValid = readNumber(checks?.volatilityPercentile) != null
  const recommendedMaxLeverage = readNumber(checks?.recommendedMaxLeverage)
  const leverageBlocked = readBoolean(checks?.leverageBlocked)
  const tier = readString(checks?.tier)
  const lowTierProbe = asRecord(checks?.lowTierProbe)
  const normalTierProbe = asRecord(checks?.normalTierProbe)
  const highTierProbe = asRecord(checks?.highTierProbe)
  const extremeTierProbe = asRecord(checks?.extremeTierProbe)
  const lowTierCorrect = readNumber(lowTierProbe?.maxLeverage) === 3 && readBoolean(lowTierProbe?.blocked) === false
  const normalTierCorrect = readNumber(normalTierProbe?.maxLeverage) === 1 && readBoolean(normalTierProbe?.blocked) === false
  const highTierCorrect = readNumber(highTierProbe?.maxLeverage) === 1 && readBoolean(highTierProbe?.blocked) === false
  const extremeTierCorrect = readNumber(extremeTierProbe?.maxLeverage) === 0 && readBoolean(extremeTierProbe?.blocked) === true
  const pass = dynamicLeverageVolatilityGateStatus != null &&
    artifactPass &&
    !artifactAllowsExecution &&
    volatilityPercentileValid &&
    recommendedMaxLeverage != null &&
    leverageBlocked != null &&
    tier != null &&
    lowTierCorrect &&
    normalTierCorrect &&
    highTierCorrect &&
    extremeTierCorrect
  return finding({
    id: 'dynamic_leverage_volatility_gate',
    title: 'Leverage is capped based on realized volatility tiers',
    severity: 'P1',
    status: pass ? 'pass' : 'blocked',
    evidencePaths: [
      dynamicLeverageVolatilityGateStatusPath,
      'src/domain/trading/production-leverage-guard.ts',
    ].filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus: readString(dynamicLeverageVolatilityGateStatus?.status),
      artifactAllowsExecution,
      volatilityPercentile: readNumber(checks?.volatilityPercentile),
      realizedVolPct: readNumber(checks?.realizedVolPct),
      recommendedMaxLeverage,
      currentMaxLeverage: readNumber(checks?.currentMaxLeverage),
      leverageBlocked,
      tier,
      tierDescription: readString(checks?.tierDescription),
      lowTierProbe,
      normalTierProbe,
      highTierProbe,
      extremeTierProbe,
      lowTierCorrect,
      normalTierCorrect,
      highTierCorrect,
      extremeTierCorrect,
    },
    required: {
      dynamicLeverageVolatilityGateStatusPresent: true,
      artifactPass: true,
      volatilityPercentileValid: true,
      recommendedMaxLeveragePresent: true,
      lowTierMaxLeverageEq: 3,
      normalTierMaxLeverageEq: 1,
      highTierMaxLeverageEq: 1,
      extremeTierMaxLeverageEq: 0,
      extremeTierBlocked: true,
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(dynamicLeverageVolatilityGateStatus ? [] : ['dynamic_leverage_volatility_gate_status_missing']),
      ...(artifactPass ? [] : ['dynamic_leverage_volatility_gate_status_not_pass']),
      ...(artifactAllowsExecution ? ['dynamic_leverage_volatility_gate_artifact_must_not_authorize_execution'] : []),
      ...(volatilityPercentileValid ? [] : ['volatility_percentile_not_valid']),
      ...(recommendedMaxLeverage != null ? [] : ['recommended_max_leverage_missing']),
      ...(lowTierCorrect ? [] : [`low_tier_probe_incorrect:${readNumber(lowTierProbe?.maxLeverage)}/${readBoolean(lowTierProbe?.blocked)}`]),
      ...(normalTierCorrect ? [] : [`normal_tier_probe_incorrect:${readNumber(normalTierProbe?.maxLeverage)}/${readBoolean(normalTierProbe?.blocked)}`]),
      ...(highTierCorrect ? [] : [`high_tier_probe_incorrect:${readNumber(highTierProbe?.maxLeverage)}/${readBoolean(highTierProbe?.blocked)}`]),
      ...(extremeTierCorrect ? [] : [`extreme_tier_probe_incorrect:${readNumber(extremeTierProbe?.maxLeverage)}/${readBoolean(extremeTierProbe?.blocked)}`]),
      ...readStringArray(dynamicLeverageVolatilityGateStatus?.blockers).slice(0, 8).map(blocker => `dynamic_leverage_status:${blocker}`),
    ],
    nextActions: pass
      ? ['Keep dynamic-leverage-by-volatility gate in the research-evidence refresh chain; this is protection evidence, not trading authorization.']
      : ['Wire volatility-adaptive leverage caps into the production leverage guard before enabling any execution.'],
    benchmarkLessons: ['protections', 'portfolio/risk management', 'live trading safety'],
  })
}

function checkDecisionContextCoverageGate(
  decisionContextCoverageGateStatus: UnknownRecord | null,
  decisionContextCoverageGateStatusPath?: string,
): StrategyDefectFinding {
  const checks = asRecord(decisionContextCoverageGateStatus?.checks)
  const artifactStatus = readString(decisionContextCoverageGateStatus?.status)
  const artifactAllowsExecution =
    readBoolean(decisionContextCoverageGateStatus?.promotionEligible) === true ||
    readBoolean(decisionContextCoverageGateStatus?.paperTradingAllowed) === true ||
    readBoolean(decisionContextCoverageGateStatus?.liveTradingAllowed) === true ||
    readBoolean(decisionContextCoverageGateStatus?.executionAllowed) === true
  const coveragePct = readNumber(checks?.coveragePct) ?? 0
  const contextOKCount = readNumber(checks?.contextOKCount) ?? 0
  const contextTotalCount = readNumber(checks?.contextTotalCount) ?? 0
  const enforcementWindowStatus = readString(checks?.enforcementWindowStatus)
  const enforcementWindowNewMissingCount = readNumber(checks?.enforcementWindowNewMissingCount) ?? 0
  const coverageBelowThreshold = readBoolean(checks?.coverageBelowThreshold) ?? false
  const diagnosticsMissing = decisionContextCoverageGateStatus == null
  const pass = !diagnosticsMissing && artifactStatus === 'pass' && !coverageBelowThreshold && enforcementWindowNewMissingCount === 0 && !artifactAllowsExecution
  return finding({
    id: 'decision_context_coverage_gate',
    title: 'Decision context snapshot coverage meets threshold for all lanes',
    severity: 'P1',
    status: pass ? 'pass' : diagnosticsMissing ? 'blocked' : coverageBelowThreshold ? 'watch' : 'blocked',
    evidencePaths: [
      decisionContextCoverageGateStatusPath,
      'data/research/paper_pnl_diagnostics.latest.json',
    ].filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus,
      artifactAllowsExecution,
      coveragePct,
      contextOKCount,
      contextTotalCount,
      coverageBelowThreshold,
      enforcementWindowStatus,
      enforcementWindowNewMissingCount,
      diagnosticsMissing,
    },
    required: {
      decisionContextCoverageGateArtifactPresent: true,
      contextCoveragePctGte: 95,
      enforcementWindowNewMissingCountEq: 0,
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(diagnosticsMissing ? ['decision_context_coverage_gate_missing'] : []),
      ...(coverageBelowThreshold ? [`context_coverage_pct_below_threshold:${coveragePct}<95`] : []),
      ...(enforcementWindowNewMissingCount > 0 ? [`enforcement_window_new_missing_context:${enforcementWindowNewMissingCount}`] : []),
      ...(artifactAllowsExecution ? ['decision_context_coverage_gate_must_not_authorize_execution'] : []),
      ...readStringArray(decisionContextCoverageGateStatus?.blockers).slice(0, 8).map(blocker => `context_coverage:${blocker}`),
    ],
    nextActions: pass
      ? ['Keep decision-context coverage gate in the research-evidence refresh chain; this is coverage evidence, not trading authorization.']
      : ['Improve decision context snapshot capture rate until all lanes exceed 95% coverage threshold.'],
    benchmarkLessons: ['evidence reporting', 'data quality'],
  })
}

function checkPitAuditGlobalGate(
  pitAuditGlobalGateStatus: UnknownRecord | null,
  pitAuditGlobalGateStatusPath?: string,
): StrategyDefectFinding {
  const checks = asRecord(pitAuditGlobalGateStatus?.checks)
  const artifactStatus = readString(pitAuditGlobalGateStatus?.status)
  const artifactAllowsExecution =
    readBoolean(pitAuditGlobalGateStatus?.promotionEligible) === true ||
    readBoolean(pitAuditGlobalGateStatus?.paperTradingAllowed) === true ||
    readBoolean(pitAuditGlobalGateStatus?.liveTradingAllowed) === true ||
    readBoolean(pitAuditGlobalGateStatus?.executionAllowed) === true
  const carryPitAuditStatus = readString(checks?.carryPitAuditStatus)
  const carryPitAuditPassingRows = readNumber(checks?.carryPitAuditPassingRows) ?? 0
  const carryPitAuditTotalRows = readNumber(checks?.carryPitAuditTotalRows) ?? 0
  const carryPitAuditPassRatePct = readNumber(checks?.carryPitAuditPassRatePct) ?? 0
  const globalPitAuditImplemented = readBoolean(checks?.globalPitAuditImplemented) ?? false
  const nonCarryStrategiesHavePitAudit = readBoolean(checks?.nonCarryStrategiesHavePitAudit) ?? false
  const artifactMissing = pitAuditGlobalGateStatus == null
  const carryPassing = carryPitAuditStatus != null && carryPitAuditTotalRows > 0 && carryPitAuditPassRatePct === 100
  const pass = !artifactMissing && artifactStatus === 'pass' && carryPassing && globalPitAuditImplemented && !artifactAllowsExecution
  return finding({
    id: 'pit_audit_global_gate',
    title: 'PIT availableAt audit is global across all strategy lanes',
    severity: 'P1',
    status: pass ? 'pass' : artifactMissing ? 'blocked' : 'watch',
    evidencePaths: [
      pitAuditGlobalGateStatusPath,
      'data/research/eth_carry_pit_audit.latest.json',
      'data/research/eth_carry_research_evidence_status.latest.json',
    ].filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus,
      artifactAllowsExecution,
      carryPitAuditStatus,
      carryPitAuditPassingRows,
      carryPitAuditTotalRows,
      carryPitAuditPassRatePct,
      globalPitAuditImplemented,
      nonCarryStrategiesHavePitAudit,
      artifactMissing,
    },
    required: {
      pitAuditGlobalGateArtifactPresent: true,
      carryPitAuditPassing: true,
      globalPitAuditImplemented: true,
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(artifactMissing ? ['pit_audit_global_gate_missing'] : []),
      ...(carryPassing ? [] : [`carry_pit_audit_not_passing:${carryPitAuditStatus ?? 'missing'}:${carryPitAuditPassingRows}/${carryPitAuditTotalRows}`]),
      ...(globalPitAuditImplemented ? [] : ['pit_audit_not_global']),
      ...(artifactAllowsExecution ? ['pit_audit_global_gate_must_not_authorize_execution'] : []),
      ...readStringArray(pitAuditGlobalGateStatus?.blockers).slice(0, 8).map(blocker => `pit_audit:${blocker}`),
    ],
    nextActions: pass
      ? ['Keep PIT audit global gate in the research-evidence refresh chain; this is PIT evidence, not trading authorization.']
      : ['Extend PIT availableAt audit beyond carry to cross-sectional, volume breakout, and microstructure lanes.'],
    benchmarkLessons: ['evidence reporting', 'data quality', 'research workflow'],
  })
}

function checkRouteCostModelCompletenessGate(
  routeCostModelCompletenessGateStatus: UnknownRecord | null,
  routeCostModelCompletenessGateStatusPath?: string,
): StrategyDefectFinding {
  const checks = asRecord(routeCostModelCompletenessGateStatus?.checks)
  const artifactStatus = readString(routeCostModelCompletenessGateStatus?.status)
  const artifactAllowsExecution =
    readBoolean(routeCostModelCompletenessGateStatus?.promotionEligible) === true ||
    readBoolean(routeCostModelCompletenessGateStatus?.paperTradingAllowed) === true ||
    readBoolean(routeCostModelCompletenessGateStatus?.liveTradingAllowed) === true ||
    readBoolean(routeCostModelCompletenessGateStatus?.executionAllowed) === true
  const routesModeled = readNumber(checks?.routesModeled) ?? 0
  const slippageTracked = readBoolean(checks?.slippageTracked) ?? false
  const adverseSelectionTracked = readBoolean(checks?.adverseSelectionTracked) ?? false
  const allRoutesModeled = readBoolean(checks?.allRoutesModeled) ?? false
  const feeSnapshotVerifiedByRuntime = readBoolean(checks?.feeSnapshotVerifiedByRuntime) ?? false
  const artifactMissing = routeCostModelCompletenessGateStatus == null
  const pass = !artifactMissing && artifactStatus === 'pass' && routesModeled > 0 && slippageTracked && adverseSelectionTracked && allRoutesModeled && !artifactAllowsExecution
  return finding({
    id: 'route_cost_model_completeness_gate',
    title: 'Route cost model is complete for all execution routes',
    severity: 'P0',
    status: pass ? 'pass' : artifactMissing ? 'blocked' : routesModeled > 0 ? 'watch' : 'blocked',
    evidencePaths: [
      routeCostModelCompletenessGateStatusPath,
      'data/runtime/route_cost_budget.latest.json',
    ].filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus,
      artifactAllowsExecution,
      routesModeled,
      slippageTracked,
      adverseSelectionTracked,
      allRoutesModeled,
      feeSnapshotVerifiedByRuntime,
      artifactMissing,
    },
    required: {
      routeCostModelCompletenessGateArtifactPresent: true,
      routesModeledGtZero: true,
      slippageTrackedAllRoutes: true,
      adverseSelectionTrackedAllRoutes: true,
      totalCostModelComplete: true,
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(artifactMissing ? ['route_cost_model_completeness_gate_missing'] : []),
      ...(routesModeled > 0 ? [] : ['route_cost_model_no_routes']),
      ...(slippageTracked ? [] : ['route_cost_model_slippage_not_tracked']),
      ...(adverseSelectionTracked ? [] : ['route_cost_model_adverse_selection_not_tracked']),
      ...(allRoutesModeled ? [] : ['route_cost_model_incomplete']),
      ...(artifactAllowsExecution ? ['route_cost_model_completeness_gate_must_not_authorize_execution'] : []),
      ...readStringArray(routeCostModelCompletenessGateStatus?.blockers).slice(0, 8).map(blocker => `route_cost_model:${blocker}`),
    ],
    nextActions: pass
      ? ['Keep route-cost model completeness gate in the research-evidence refresh chain; this is cost evidence, not trading authorization.']
      : ['Complete route cost model with slippage, adverse selection, and total cost for all execution routes.'],
    benchmarkLessons: ['execution cost model', 'evidence reporting'],
  })
}

function checkMarketIntelNoOpenGate(
  marketIntelNoOpenGateStatus: UnknownRecord | null,
  marketIntelNoOpenGateStatusPath?: string,
): StrategyDefectFinding {
  const checks = asRecord(marketIntelNoOpenGateStatus?.checks)
  const artifactPass = readString(marketIntelNoOpenGateStatus?.status) === 'pass'
  const artifactAllowsExecution =
    readBoolean(marketIntelNoOpenGateStatus?.promotionEligible) === true ||
    readBoolean(marketIntelNoOpenGateStatus?.paperTradingAllowed) === true ||
    readBoolean(marketIntelNoOpenGateStatus?.liveTradingAllowed) === true ||
    readBoolean(marketIntelNoOpenGateStatus?.executionAllowed) === true
  const riskOffCheck = readString(checks?.riskOffOpenContextStatus) === 'risk_off'
  const severeNewsCheck = readString(checks?.severeNewsOpenContextStatus) === 'severe_news'
  const laneBlockedCheck = readString(checks?.laneBlockedOpenContextStatus) === 'lane_blocked'
  const symbolBlockedCheck = readString(checks?.symbolBlockedOpenContextStatus) === 'symbol_blocked'
  const allowedCheck = readString(checks?.allowedOpenContextStatus) === 'ok'
  const allowedRejectReasonsEmpty = readStringArray(checks?.allowedRejectReasons).length === 0
  const pass = marketIntelNoOpenGateStatus != null &&
    artifactPass &&
    !artifactAllowsExecution &&
    riskOffCheck &&
    severeNewsCheck &&
    laneBlockedCheck &&
    symbolBlockedCheck &&
    allowedCheck &&
    allowedRejectReasonsEmpty
  return finding({
    id: 'market_intel_no_open_gate',
    title: 'MarketIntel risk-off, severe-news, lane-block, banned-symbol reject new opens',
    severity: 'P1',
    status: pass ? 'pass' : 'blocked',
    evidencePaths: [
      marketIntelNoOpenGateStatusPath,
      'src/runtime/paper_open_context.ts',
      'src/runtime/market_intel_context.ts',
    ].filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus: readString(marketIntelNoOpenGateStatus?.status),
      artifactAllowsExecution,
      riskOffOpenContextStatus: readString(checks?.riskOffOpenContextStatus),
      riskOffRejectReasons: readStringArray(checks?.riskOffRejectReasons),
      severeNewsOpenContextStatus: readString(checks?.severeNewsOpenContextStatus),
      severeNewsRejectReasons: readStringArray(checks?.severeNewsRejectReasons),
      laneBlockedOpenContextStatus: readString(checks?.laneBlockedOpenContextStatus),
      laneBlockedRejectReasons: readStringArray(checks?.laneBlockedRejectReasons),
      symbolBlockedOpenContextStatus: readString(checks?.symbolBlockedOpenContextStatus),
      symbolBlockedRejectReasons: readStringArray(checks?.symbolBlockedRejectReasons),
      allowedOpenContextStatus: readString(checks?.allowedOpenContextStatus),
      allowedRejectReasons: readStringArray(checks?.allowedRejectReasons),
    },
    required: {
      marketIntelNoOpenGateStatusArtifactPresent: true,
      riskOffContextStatusBlocks: true,
      severeNewsContextStatusBlocks: true,
      laneBlockedContextStatusBlocks: true,
      symbolBlockedContextStatusBlocks: true,
      allowedContextStatusOk: true,
      allowedRejectReasonsEmpty: true,
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(marketIntelNoOpenGateStatus ? [] : ['market_intel_no_open_gate_status_missing']),
      ...(artifactPass ? [] : ['market_intel_no_open_gate_status_not_pass']),
      ...(artifactAllowsExecution ? ['market_intel_no_open_gate_artifact_must_not_authorize_execution'] : []),
      ...(riskOffCheck ? [] : [`risk_off_context_not_blocked:${readString(checks?.riskOffOpenContextStatus) ?? 'missing'}`]),
      ...(severeNewsCheck ? [] : [`severe_news_context_not_blocked:${readString(checks?.severeNewsOpenContextStatus) ?? 'missing'}`]),
      ...(laneBlockedCheck ? [] : [`lane_blocked_context_not_blocked:${readString(checks?.laneBlockedOpenContextStatus) ?? 'missing'}`]),
      ...(symbolBlockedCheck ? [] : [`symbol_blocked_context_not_blocked:${readString(checks?.symbolBlockedOpenContextStatus) ?? 'missing'}`]),
      ...(allowedCheck ? [] : [`allowed_context_not_ok:${readString(checks?.allowedOpenContextStatus) ?? 'missing'}`]),
      ...(allowedRejectReasonsEmpty ? [] : [`allowed_context_has_reject_reasons:${readStringArray(checks?.allowedRejectReasons).join('|')}`]),
      ...readStringArray(marketIntelNoOpenGateStatus?.blockers)
        .slice(0, 8)
        .map(blocker => `market_intel_no_open_gate_status:${blocker}`),
    ],
    nextActions: pass
      ? ['Keep MarketIntel no-open gate in the research-evidence refresh chain; this is pre-trade protection evidence, not trading authorization.']
      : ['Fix MarketIntel open-context handling so risk-off, severe news, lane blocks, and banned symbols reject new opens before execution.'],
    benchmarkLessons: ['protections', 'live trading safety'],
  })
}

function checkCrossSectionalConfigGate(
  gateStatus: UnknownRecord | null,
  path?: string,
): StrategyDefectFinding {
  const status = readString(gateStatus?.status)
  const checks = asRecord(gateStatus?.checks)
  const artifactAllowsExecution =
    readBoolean(gateStatus?.promotionEligible) === true ||
    readBoolean(gateStatus?.paperTradingAllowed) === true ||
    readBoolean(gateStatus?.liveTradingAllowed) === true ||
    readBoolean(gateStatus?.executionAllowed) === true
  const pass = gateStatus != null && status === 'pass' && !artifactAllowsExecution
  return finding({
    id: 'cross_sectional_config_gate',
    title: 'Cross-sectional strategy configuration gate passes (diagnostic checks may flag known risk areas)',
    severity: 'P1',
    status: pass ? 'pass' : 'blocked',
    evidencePaths: [path, 'src/domain/strategy/cross-sectional-momentum.ts']
      .filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus: status,
      artifactAllowsExecution,
      mtfWeightVerdict: readString(checks?.mtfWeight?.verdict),
      fundingVerdict: readString(checks?.funding?.verdict),
      spreadVerdict: readString(checks?.spread?.verdict),
      regimeVerdict: readString(checks?.regime?.verdict),
      confidenceVerdict: readString(checks?.confidence?.verdict),
      volCeilingVerdict: readString(checks?.volCeiling?.verdict),
    },
    required: {
      artifactStatus: 'pass',
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(gateStatus ? [] : ['cross_sectional_config_gate_missing']),
      ...(status === 'pass' ? [] : [`cross_sectional_config_gate_not_pass:${status ?? 'missing'}`]),
      ...(artifactAllowsExecution ? ['cross_sectional_config_gate_must_not_authorize_execution'] : []),
    ],
    nextActions: pass
      ? ['Keep cross-sectional config gate in the research-evidence refresh chain; this is diagnostic evidence, not trading authorization.']
      : ['Ensure cross-sectional config gate artifact exists with status=pass and all execution flags false.'],
    benchmarkLessons: ['research workflow', 'evidence reporting'],
  })
}

function checkVolumeBreakoutConfigGate(
  gateStatus: UnknownRecord | null,
  path?: string,
): StrategyDefectFinding {
  const status = readString(gateStatus?.status)
  const checks = asRecord(gateStatus?.checks)
  const artifactAllowsExecution =
    readBoolean(gateStatus?.promotionEligible) === true ||
    readBoolean(gateStatus?.paperTradingAllowed) === true ||
    readBoolean(gateStatus?.liveTradingAllowed) === true ||
    readBoolean(gateStatus?.executionAllowed) === true
  const pass = gateStatus != null && status === 'pass' && !artifactAllowsExecution
  return finding({
    id: 'volume_breakout_config_gate',
    title: 'Volume breakout configuration gate passes (diagnostic checks may flag known risk areas)',
    severity: 'P1',
    status: pass ? 'pass' : 'blocked',
    evidencePaths: [path, 'src/domain/strategy/volume-breakout.ts']
      .filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus: status,
      artifactAllowsExecution,
      volumeMultiplierVerdict: readString(checks?.volumeMultiplier?.verdict),
      confidenceLogicVerdict: readString(checks?.confidenceLogic?.verdict),
      stopLossPctVerdict: readString(checks?.stopLossPct?.verdict),
      minBreakQualityVerdict: readString(checks?.minBreakQuality?.verdict),
    },
    required: {
      artifactStatus: 'pass',
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(gateStatus ? [] : ['volume_breakout_config_gate_missing']),
      ...(status === 'pass' ? [] : [`volume_breakout_config_gate_not_pass:${status ?? 'missing'}`]),
      ...(artifactAllowsExecution ? ['volume_breakout_config_gate_must_not_authorize_execution'] : []),
    ],
    nextActions: pass
      ? ['Keep volume breakout config gate in the research-evidence refresh chain; this is diagnostic evidence, not trading authorization.']
      : ['Ensure volume breakout config gate artifact exists with status=pass and all execution flags false.'],
    benchmarkLessons: ['research workflow', 'evidence reporting'],
  })
}

function checkWfoStabilityGate(
  gateStatus: UnknownRecord | null,
  path?: string,
): StrategyDefectFinding {
  const status = readString(gateStatus?.status)
  const checks = asRecord(gateStatus?.checks)
  const artifactAllowsExecution =
    readBoolean(gateStatus?.promotionEligible) === true ||
    readBoolean(gateStatus?.paperTradingAllowed) === true ||
    readBoolean(gateStatus?.liveTradingAllowed) === true ||
    readBoolean(gateStatus?.executionAllowed) === true
  const pass = gateStatus != null && status === 'pass' && !artifactAllowsExecution
  return finding({
    id: 'wfo_stability_gate',
    title: 'WFO stability gate passes (WFO, parameter stability, and reporting checks)',
    severity: 'P1',
    status: pass ? 'pass' : 'blocked',
    evidencePaths: [path, 'data/runtime/strategy_promotion.latest.json']
      .filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus: status,
      artifactAllowsExecution,
      wfoStabilityVerdict: readString(checks?.wfoStability?.verdict),
      paramStabilityVerdict: readString(checks?.paramStability?.verdict),
      stabilityReportingVerdict: readString(checks?.stabilityReporting?.verdict),
    },
    required: {
      artifactStatus: 'pass',
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(gateStatus ? [] : ['wfo_stability_gate_missing']),
      ...(status === 'pass' ? [] : [`wfo_stability_gate_not_pass:${status ?? 'missing'}`]),
      ...(artifactAllowsExecution ? ['wfo_stability_gate_must_not_authorize_execution'] : []),
    ],
    nextActions: pass
      ? ['Keep WFO stability gate in the research-evidence refresh chain; this is diagnostic evidence, not trading authorization.']
      : ['Ensure WFO stability gate artifact exists with status=pass and all execution flags false.'],
    benchmarkLessons: ['research workflow', 'evidence reporting'],
  })
}

function checkPortfolioRiskManagementGate(
  gateStatus: UnknownRecord | null,
  path?: string,
): StrategyDefectFinding {
  const status = readString(gateStatus?.status)
  const checks = asRecord(gateStatus?.checks)
  const artifactAllowsExecution =
    readBoolean(gateStatus?.promotionEligible) === true ||
    readBoolean(gateStatus?.paperTradingAllowed) === true ||
    readBoolean(gateStatus?.liveTradingAllowed) === true ||
    readBoolean(gateStatus?.executionAllowed) === true
  const pass = gateStatus != null && status === 'pass' && !artifactAllowsExecution
  return finding({
    id: 'portfolio_risk_management_gate',
    title: 'Portfolio risk management gate passes (risk management, sizing, drawdown, correlation checks)',
    severity: 'P1',
    status: pass ? 'pass' : 'blocked',
    evidencePaths: [path, 'data/config/risk.json', 'data/config/strategy.json']
      .filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus: status,
      artifactAllowsExecution,
      portfolioRiskMgmtVerdict: readString(checks?.portfolioRiskMgmt?.verdict),
      positionSizingVerdict: readString(checks?.positionSizing?.verdict),
      maxDrawdownVerdict: readString(checks?.maxDrawdown?.verdict),
      correlationAwareVerdict: readString(checks?.correlationAware?.verdict),
    },
    required: {
      artifactStatus: 'pass',
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(gateStatus ? [] : ['portfolio_risk_management_gate_missing']),
      ...(status === 'pass' ? [] : [`portfolio_risk_management_gate_not_pass:${status ?? 'missing'}`]),
      ...(artifactAllowsExecution ? ['portfolio_risk_management_gate_must_not_authorize_execution'] : []),
    ],
    nextActions: pass
      ? ['Keep portfolio risk management gate in the research-evidence refresh chain; this is diagnostic evidence, not trading authorization.']
      : ['Ensure portfolio risk management gate artifact exists with status=pass and all execution flags false.'],
    benchmarkLessons: ['research workflow', 'evidence reporting'],
  })
}

function checkKillSwitchGate(
  gateStatus: UnknownRecord | null,
  path?: string,
): StrategyDefectFinding {
  const status = readString(gateStatus?.status)
  const checks = asRecord(gateStatus?.checks)
  const artifactAllowsExecution =
    readBoolean(gateStatus?.promotionEligible) === true ||
    readBoolean(gateStatus?.paperTradingAllowed) === true ||
    readBoolean(gateStatus?.liveTradingAllowed) === true ||
    readBoolean(gateStatus?.executionAllowed) === true
  const pass = gateStatus != null && status === 'pass' && !artifactAllowsExecution
  return finding({
    id: 'kill_switch_gate',
    title: 'Kill-switch gate passes (kill-switch configuration is consistent)',
    severity: 'P0',
    status: pass ? 'pass' : 'blocked',
    evidencePaths: [path, 'data/config/kill-switch.json', 'data/config/risk.json']
      .filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus: status,
      artifactAllowsExecution,
      killSwitchEnabled: readBoolean(gateStatus?.killSwitchEnabled),
      defaultPolicy: readString(gateStatus?.defaultPolicy),
      researchOnlyBlockedConsistent: readBoolean(gateStatus?.researchOnlyBlockedConsistent),
      killSwitchCheckVerdict: readString(checks?.killSwitchEnabled?.verdict),
      defaultPolicyCheckVerdict: readString(checks?.defaultPolicy?.verdict),
      consistentWithStateCheckVerdict: readString(checks?.consistentWithState?.verdict),
    },
    required: {
      artifactStatus: 'pass',
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(gateStatus ? [] : ['kill_switch_gate_missing']),
      ...(status === 'pass' ? [] : [`kill_switch_gate_not_pass:${status ?? 'missing'}`]),
      ...(artifactAllowsExecution ? ['kill_switch_gate_must_not_authorize_execution'] : []),
    ],
    nextActions: pass
      ? ['Keep kill-switch gate in the research-evidence refresh chain; this is diagnostic evidence, not trading authorization.']
      : ['Ensure kill-switch gate artifact exists with status=pass and all execution flags false.'],
    benchmarkLessons: ['research workflow', 'evidence reporting'],
  })
}

function checkAccountCorruptionGate(
  gateStatus: UnknownRecord | null,
  path?: string,
): StrategyDefectFinding {
  const status = readString(gateStatus?.status)
  const checks = asRecord(gateStatus?.checks)
  const artifactAllowsExecution =
    readBoolean(gateStatus?.promotionEligible) === true ||
    readBoolean(gateStatus?.paperTradingAllowed) === true ||
    readBoolean(gateStatus?.liveTradingAllowed) === true ||
    readBoolean(gateStatus?.executionAllowed) === true
  const pass = gateStatus != null && status === 'pass' && !artifactAllowsExecution
  return finding({
    id: 'account_corruption_gate',
    title: 'Account corruption gate passes (account state file integrity checks)',
    severity: 'P1',
    status: pass ? 'pass' : 'blocked',
    evidencePaths: [path, 'data/paper_trading']
      .filter((item): item is string => typeof item === 'string' && item.length > 0),
    observed: {
      artifactStatus: status,
      artifactAllowsExecution,
      accountFilesExistVerdict: readString(checks?.accountFilesExist?.verdict),
      corruptFilesVerdict: readString(checks?.corruptFiles?.verdict),
      failClosedMechanismVerdict: readString(checks?.failClosedMechanism?.verdict),
    },
    required: {
      artifactStatus: 'pass',
      artifactMustNotAuthorizeExecution: true,
    },
    blockers: pass ? [] : [
      ...(gateStatus ? [] : ['account_corruption_gate_missing']),
      ...(status === 'pass' ? [] : [`account_corruption_gate_not_pass:${status ?? 'missing'}`]),
      ...(artifactAllowsExecution ? ['account_corruption_gate_must_not_authorize_execution'] : []),
    ],
    nextActions: pass
      ? ['Keep account corruption gate in the research-evidence refresh chain; this is diagnostic evidence, not trading authorization.']
      : ['Ensure account corruption gate artifact exists with status=pass and all execution flags false.'],
    benchmarkLessons: ['research workflow', 'evidence reporting'],
  })
}

function checkAiScientistSecondValidation(
  aiScientistIntake: UnknownRecord | null,
  aiScientistSecondValidationQueue: UnknownRecord | null,
  aiScientistSourceManifest: UnknownRecord | null,
  aiScientistReadiness: UnknownRecord | null,
  aiScientistPitReproductionPlan: UnknownRecord | null,
  aiScientistPitInputDataset: UnknownRecord | null,
  aiScientistPitContractStatus: UnknownRecord | null,
  intakePath: string,
  queuePath: string,
  sourceManifestPath: string,
  readinessPath: string,
  pitReproductionPlanPath: string,
  pitInputDatasetPath: string,
  pitContractStatusPath: string,
): StrategyDefectFinding {
  const counts = asRecord(aiScientistIntake?.counts)
  const queueCounts = asRecord(aiScientistSecondValidationQueue?.counts)
  const sourceManifestCounts = asRecord(aiScientistSourceManifest?.counts)
  const readinessCounts = asRecord(aiScientistReadiness?.counts)
  const pitPlanCounts = asRecord(aiScientistPitReproductionPlan?.counts)
  const pitInputDatasetCounts = asRecord(aiScientistPitInputDataset?.counts)
  const pitContractCounts = asRecord(aiScientistPitContractStatus?.counts)
  const candidatesFound = readNumber(counts?.candidatesFound) ?? 0
  const runsWithWalkForward = readNumber(counts?.runsWithWalkForward) ?? 0
  const targetReached = readNumber(counts?.targetReached) ?? 0
  const queuedCandidates = readNumber(queueCounts?.queuedCandidates) ?? 0
  const requiredGateCount = readNumber(queueCounts?.requiredGateCount) ?? 0
  const missingGateCount = readNumber(queueCounts?.missingGateCount) ?? 0
  const sourceFilesExpected = readNumber(sourceManifestCounts?.sourceFilesExpected) ?? 0
  const sourceFilesPresent = readNumber(sourceManifestCounts?.sourceFilesPresent) ?? 0
  const sourceFilesMissing = readNumber(sourceManifestCounts?.sourceFilesMissing) ?? 0
  const candidatesLocked = readNumber(sourceManifestCounts?.candidatesLocked) ?? 0
  const sourceManifestLocked = readString(aiScientistSourceManifest?.status) === 'locked_research_only' &&
    sourceFilesExpected > 0 &&
    sourceFilesMissing === 0
  const candidatesReadyForReproduction = readNumber(readinessCounts?.candidatesReadyForOpenAliceReproduction) ?? 0
  const missingOpenAliceEvidenceGates = readNumber(readinessCounts?.missingOpenAliceEvidenceGates) ?? 0
  const candidatesReadyForOpenAlicePitReproduction = readNumber(pitPlanCounts?.candidatesReadyForOpenAlicePitReproduction) ?? 0
  const csvInputFiles = readNumber(pitPlanCounts?.csvInputFiles) ?? 0
  const csvFilesWithExplicitAvailableAt = readNumber(pitPlanCounts?.csvFilesWithExplicitAvailableAt) ?? 0
  const csvFilesWithObservedOrFetchedAt = readNumber(pitPlanCounts?.csvFilesWithObservedOrFetchedAt) ?? 0
  const openAliceWarehouseLinkedInputs = readNumber(pitPlanCounts?.openAliceWarehouseLinkedInputs) ?? 0
  const rowsNormalized = readNumber(pitInputDatasetCounts?.rowsNormalized) ?? 0
  const promotionGradeRows = readNumber(pitInputDatasetCounts?.promotionGradeRows) ?? 0
  const rowExplicitAvailableAt = readNumber(pitContractCounts?.rowsWithRowExplicitAvailableAt) ?? 0
  const rowExplicitObservedOrFetchedAt = readNumber(pitContractCounts?.rowsWithRowExplicitObservedOrFetchedAt) ?? 0
  const contractRowsScanned = readNumber(pitContractCounts?.rowsScanned) ?? 0
  const pitInputDatasetAllowsExecution =
    readBoolean(aiScientistPitInputDataset?.promotionEligible) === true ||
    readBoolean(aiScientistPitInputDataset?.paperTradingAllowed) === true ||
    readBoolean(aiScientistPitInputDataset?.liveTradingAllowed) === true ||
    readBoolean(aiScientistPitInputDataset?.executionAllowed) === true
  const pass = false
  return finding({
    id: 'ai_scientist_second_validation',
    title: 'AI-Scientist candidates are monitored but require OpenAlice second validation',
    severity: 'P1',
    status: pass ? 'watch' : 'blocked',
    evidencePaths: [intakePath, queuePath, sourceManifestPath, readinessPath, pitReproductionPlanPath, pitInputDatasetPath, pitContractStatusPath],
    observed: {
      status: readString(aiScientistIntake?.status),
      queueStatus: readString(aiScientistSecondValidationQueue?.status),
      sourceManifestStatus: readString(aiScientistSourceManifest?.status),
      readinessStatus: readString(aiScientistReadiness?.status),
      pitReproductionPlanStatus: readString(aiScientistPitReproductionPlan?.status),
      pitInputDatasetStatus: readString(aiScientistPitInputDataset?.status),
      pitContractStatus: readString(aiScientistPitContractStatus?.status),
      candidatesFound,
      queuedCandidates,
      requiredGateCount,
      missingGateCount,
      sourceManifestLocked,
      candidatesLocked,
      candidatesReadyForReproduction,
      missingOpenAliceEvidenceGates,
      candidatesReadyForOpenAlicePitReproduction,
      csvInputFiles,
      csvFilesWithExplicitAvailableAt,
      csvFilesWithObservedOrFetchedAt,
      openAliceWarehouseLinkedInputs,
      pitInputRowsNormalized: rowsNormalized,
      pitInputPromotionGradeRows: promotionGradeRows,
      pitInputObservedAtBasis: aiScientistPitInputDataset ? 'source_file_mtime_recovered' : null,
      pitInputAvailableAtBasis: aiScientistPitInputDataset ? 'derived_bar_close_time' : null,
      pitContractRowsScanned: contractRowsScanned,
      pitContractRowExplicitAvailableAt: rowExplicitAvailableAt,
      pitContractRowExplicitObservedOrFetchedAt: rowExplicitObservedOrFetchedAt,
      sourceFilesExpected,
      sourceFilesPresent,
      sourceFilesMissing,
      runsWithWalkForward,
      targetReached,
      promotionEligible: readBoolean(aiScientistIntake?.promotionEligible),
      paperTradingAllowed: readBoolean(aiScientistIntake?.paperTradingAllowed),
      liveTradingAllowed: readBoolean(aiScientistIntake?.liveTradingAllowed),
      queueExecutionAllowed: readBoolean(aiScientistSecondValidationQueue?.executionAllowed),
      pitInputExecutionAllowed: readBoolean(aiScientistPitInputDataset?.executionAllowed),
    },
    required: {
      openAliceSecondValidationComplete: true,
      openAliceSecondValidationQueuePresent: true,
      lockedSourceManifestPresent: true,
      readinessMatrixPresent: true,
      pitReproductionPlanPresent: true,
      csvInputsHaveAvailableAt: true,
      csvInputsHaveObservedOrFetchedAt: true,
      openAliceWarehouseLineagePresent: true,
      pitInputDatasetPresent: true,
      pitContractStatusPresent: true,
      pitInputRowsNormalizedGtZero: true,
      pitInputPromotionGradeRows: 0,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    },
    blockers: [
      ...(aiScientistIntake ? [] : ['ai_scientist_intake_missing']),
      ...(aiScientistSecondValidationQueue ? [] : ['openalice_second_validation_queue_missing']),
      ...(aiScientistSourceManifest ? [] : ['openalice_candidate_source_manifest_missing']),
      ...(aiScientistReadiness ? [] : ['openalice_second_validation_readiness_missing']),
      ...(aiScientistPitReproductionPlan ? [] : ['openalice_pit_reproduction_plan_missing']),
      ...(aiScientistPitInputDataset ? [] : ['openalice_pit_input_dataset_missing']),
      ...(aiScientistPitContractStatus ? [] : ['openalice_pit_contract_status_missing']),
      ...(aiScientistSourceManifest && !sourceManifestLocked ? ['openalice_candidate_source_manifest_not_locked'] : []),
      ...(aiScientistReadiness && missingOpenAliceEvidenceGates > 0 ? [`openalice_second_validation_missing_gates:${missingOpenAliceEvidenceGates}`] : []),
      ...(aiScientistPitReproductionPlan && candidatesReadyForOpenAlicePitReproduction === 0 ? ['openalice_pit_reproduction_not_ready'] : []),
      ...(aiScientistPitReproductionPlan && csvInputFiles > csvFilesWithExplicitAvailableAt ? [`ai_scientist_csv_available_time_missing:${csvFilesWithExplicitAvailableAt}/${csvInputFiles}`] : []),
      ...(aiScientistPitReproductionPlan && csvInputFiles > csvFilesWithObservedOrFetchedAt ? [`ai_scientist_csv_observed_or_fetched_time_missing:${csvFilesWithObservedOrFetchedAt}/${csvInputFiles}`] : []),
      ...(aiScientistPitReproductionPlan && csvInputFiles > openAliceWarehouseLinkedInputs ? [`ai_scientist_openalice_warehouse_lineage_missing:${openAliceWarehouseLinkedInputs}/${csvInputFiles}`] : []),
      ...(aiScientistPitInputDataset && rowsNormalized === 0 ? ['ai_scientist_pit_input_rows_missing'] : []),
      ...(aiScientistPitInputDataset && promotionGradeRows > 0 ? [`ai_scientist_pit_input_promotion_grade_rows_present:${promotionGradeRows}`] : []),
      ...(pitInputDatasetAllowsExecution ? ['ai_scientist_pit_input_dataset_must_not_authorize_execution'] : []),
      ...(aiScientistPitContractStatus && contractRowsScanned > rowExplicitAvailableAt ? [`ai_scientist_row_explicit_available_at_missing:${rowExplicitAvailableAt}/${contractRowsScanned}`] : []),
      ...(aiScientistPitContractStatus && contractRowsScanned > rowExplicitObservedOrFetchedAt ? [`ai_scientist_row_explicit_observed_or_fetched_at_missing:${rowExplicitObservedOrFetchedAt}/${contractRowsScanned}`] : []),
      ...(queuedCandidates > 0 ? ['openalice_second_validation_queued_not_completed'] : ['openalice_second_validation_required']),
      'trial_ledger_prospective_paper_telemetry_missing',
      ...readStringArray(aiScientistSecondValidationQueue?.blockers)
        .filter(blocker => blocker.includes('paper_execution_telemetry') || blocker.includes('openalice_second_validation'))
        .slice(0, 8),
      ...readStringArray(aiScientistSourceManifest?.blockers)
        .filter(blocker => blocker.includes('source_file_missing'))
        .slice(0, 8),
      ...readStringArray(aiScientistReadiness?.blockers)
        .filter(blocker => blocker.includes('openalice_validation') || blocker.includes('second_validation'))
        .slice(0, 8),
      ...readStringArray(aiScientistPitReproductionPlan?.blockers)
        .filter(blocker => blocker.includes('available_time') || blocker.includes('warehouse') || blocker.includes('pit'))
        .slice(0, 8),
      ...readStringArray(aiScientistPitInputDataset?.blockers)
        .filter(blocker => blocker.includes('pit_input') || blocker.includes('promotion') || blocker.includes('available_at') || blocker.includes('observed_at'))
        .slice(0, 8),
      ...readStringArray(aiScientistPitContractStatus?.blockers)
        .filter(blocker => blocker.includes('row_explicit') || blocker.includes('promotion_grade') || blocker.includes('quality_blockers') || blocker.includes('pit_contract'))
        .slice(0, 8),
    ],
    nextActions: ['Pick the top AI-Scientist candidate only as a hypothesis, then reproduce it in OpenAlice with locked PIT features and gates.'],
    benchmarkLessons: ['fast parameter sweep', 'research workflow', 'evidence reporting'],
  })
}

function finding(input: StrategyDefectFinding): StrategyDefectFinding {
  return input
}

async function readSource(path: string): Promise<SourceSnapshot> {
  const resolved = resolve(path)
  try {
    return { path: resolved, exists: true, text: await readFile(resolved, 'utf-8') }
  } catch {
    return { path: resolved, exists: false, text: '' }
  }
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null
  }
}

function extractNumberAfterKey(text: string, key: string): number | null {
  const pattern = new RegExp(`${key}\\s*[:=]\\s*([0-9][0-9_]*(?:\\.[0-9]+)?)`)
  const match = pattern.exec(text)
  if (!match) return null
  const parsed = Number(match[1].replaceAll('_', ''))
  return Number.isFinite(parsed) ? parsed : null
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    i++
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function renderConsoleSummary(report: StrategyDefectMonitorReport): string {
  return [
    `Strategy defect monitor: ${report.status}`,
    `findings=${report.summary.findings} blocked=${report.summary.blocked} p0=${report.summary.p0Blocked} p1=${report.summary.p1Blocked}`,
    `paper=false live=false promotion=false`,
    report.blockers.length > 0 ? `topBlockers=${report.blockers.slice(0, 10).join(',')}` : 'topBlockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
