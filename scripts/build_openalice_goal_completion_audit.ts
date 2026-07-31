import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { DEFAULT_COLLECTOR_PIT_ROWS_PATH } from './lib/ohlcv_collector_pit.js'

type UnknownRecord = Record<string, unknown>
type GoalItemStatus = 'pass' | 'blocked' | 'missing' | 'watch'

interface CliArgs {
  outputPath: string | null
  reasonChainPath: string
  dataCatalogPath: string
  liveDataFreshnessPath: string
  okxPrivateAuthPath: string
  feeSnapshotRefreshPath: string
  schedulerSecurityAuditPath: string
  releaseGateStatusPath: string
  paperGateStatusPath: string
  strategyDefectMonitorPath: string
  strategyDefectRegistryPath: string
  strategyQualityGateCoveragePath: string
  quantFrameworkBenchmarkPath: string
  ethCarryResearchEvidencePath: string
  ethCarryDataGapStatusPath: string
  ethCarryPitFeaturesPath: string
  ethCarryPitAuditPath: string
  ethCarryProspectiveEvidencePath: string
  aiScientistIntakePath: string
  aiScientistSourceManifestPath: string
  aiScientistSecondValidationQueuePath: string
  aiScientistSecondValidationReadinessPath: string
  aiScientistPitRebuildQueuePath: string
  aiScientistOhlcvNativeRebuildPlanPath: string
  aiScientistOhlcvDailySupplementPlanPath: string
  aiScientistOhlcvNativeRowsPath: string
  aiScientistPitNativeRebuildStatusPath: string
  aiScientistPitInputDatasetPath: string
  aiScientistPitContractStatusPath: string
  ohlcvCollectorPitContractStatusPath: string
  externalWarehouseRoot: string
  aiScientistRoot: string
  json: boolean
}

export interface OpenAliceGoalCompletionItem {
  id: string
  title: string
  required: boolean
  status: GoalItemStatus
  completionPct: number
  evidencePaths: string[]
  blockers: string[]
  metrics: Record<string, unknown>
  nextActions: string[]
}

export interface OpenAliceGoalCompletionAuditReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  status: 'blocked' | 'watch_only' | 'complete'
  goalComplete: boolean
  objective: string
  effectiveActionability: string
  overallPlanCompletionPct: number | null
  goalChecklistCompletionPct: number
  observedGateState: {
    reasonChainPaperTradingAllowed: boolean | null
    reasonChainLiveTradingAllowed: boolean | null
    reasonChainCanPromote: boolean | null
    releaseGateAllowPaperTrading: boolean | null
    releaseGateAllowLiveTrading: boolean | null
    paperGateFinalAllowPaperTrading: boolean | null
  }
  sourceArtifacts: Record<string, string>
  summary: {
    items: number
    requiredItems: number
    pass: number
    blocked: number
    missing: number
    watch: number
    requiredPass: number
    requiredBlocked: number
    requiredMissing: number
    dataCatalogStatus: string | null
    dataCatalogComplete: number | null
    dataCatalogDatasets: number | null
    strategyDefectStatus: string | null
    strategyQualityGateCoverageStatus: string | null
    quantFrameworkStatus: string | null
    ethCarryProspectiveStatus: string | null
    aiScientistReadinessStatus: string | null
    aiScientistPitNativeRebuildStatus: string | null
    ohlcvCollectorPitStatus: string | null
    schedulerSecurityStatus: string | null
  }
  items: OpenAliceGoalCompletionItem[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/openalice_goal_completion_audit.latest.json'
const DEFAULT_OBJECTIVE = '恢复OKX的数据获取能力并存储；把多源数据、AI-Scientist候选、优秀量化框架经验和策略缺陷转成OpenAlice的研究证据；最终只在PIT/WFO/FDR/route-cost/prospective/paper/live gates真实通过后才允许交易。'

async function main(): Promise<void> {
  const args = parseOpenAliceGoalCompletionAuditArgs(process.argv.slice(2))
  const report = await runOpenAliceGoalCompletionAudit(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseOpenAliceGoalCompletionAuditArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    reasonChainPath: raw.get('reasonChainPath') ?? 'data/runtime/system_status_reason_chain.latest.json',
    dataCatalogPath: raw.get('dataCatalogPath') ?? 'data/runtime/openalice_data_catalog.latest.json',
    liveDataFreshnessPath: raw.get('liveDataFreshnessPath') ?? 'data/runtime/live_data_freshness.latest.json',
    okxPrivateAuthPath: raw.get('okxPrivateAuthPath') ?? 'data/runtime/okx_private_auth_diagnosis.latest.json',
    feeSnapshotRefreshPath: raw.get('feeSnapshotRefreshPath') ?? 'data/runtime/fee_snapshot_refresh.latest.json',
    schedulerSecurityAuditPath: raw.get('schedulerSecurityAuditPath') ?? 'data/runtime/scheduler_security_audit.latest.json',
    releaseGateStatusPath: raw.get('releaseGateStatusPath') ?? 'data/runtime/release_gate_status.json',
    paperGateStatusPath: raw.get('paperGateStatusPath') ?? 'data/runtime/paper_gate_status.json',
    strategyDefectMonitorPath: raw.get('strategyDefectMonitorPath') ?? 'data/research/strategy_defect_monitor.latest.json',
    strategyDefectRegistryPath: raw.get('strategyDefectRegistryPath') ?? 'data/research/strategy_defect_registry.latest.json',
    strategyQualityGateCoveragePath: raw.get('strategyQualityGateCoveragePath') ?? 'data/research/strategy_quality_gate_coverage.latest.json',
    quantFrameworkBenchmarkPath: raw.get('quantFrameworkBenchmarkPath') ?? 'data/research/quant_framework_benchmark_report.latest.json',
    ethCarryResearchEvidencePath: raw.get('ethCarryResearchEvidencePath') ?? 'data/research/eth_carry_research_evidence_status.latest.json',
    ethCarryDataGapStatusPath: raw.get('ethCarryDataGapStatusPath') ?? 'data/research/eth_carry_data_gap_status.latest.json',
    ethCarryPitFeaturesPath: raw.get('ethCarryPitFeaturesPath') ?? 'data/research/eth_carry_pit_features.latest.json',
    ethCarryPitAuditPath: raw.get('ethCarryPitAuditPath') ?? 'data/research/eth_carry_pit_audit.latest.json',
    ethCarryProspectiveEvidencePath: raw.get('ethCarryProspectiveEvidencePath') ?? 'data/research/eth_carry_prospective_evidence_status.latest.json',
    aiScientistIntakePath: raw.get('aiScientistIntakePath') ?? 'data/research/ai_scientist_crypto_candidate_intake.latest.json',
    aiScientistSourceManifestPath: raw.get('aiScientistSourceManifestPath') ?? 'data/research/ai_scientist_openalice_candidate_source_manifest.latest.json',
    aiScientistSecondValidationQueuePath: raw.get('aiScientistSecondValidationQueuePath') ?? 'data/research/ai_scientist_openalice_second_validation_queue.latest.json',
    aiScientistSecondValidationReadinessPath: raw.get('aiScientistSecondValidationReadinessPath') ?? 'data/research/ai_scientist_openalice_second_validation_readiness.latest.json',
    aiScientistPitRebuildQueuePath: raw.get('aiScientistPitRebuildQueuePath') ?? 'data/research/ai_scientist_openalice_pit_rebuild_queue.latest.json',
    aiScientistOhlcvNativeRebuildPlanPath: raw.get('aiScientistOhlcvNativeRebuildPlanPath') ?? 'data/research/ai_scientist_openalice_ohlcv_native_rebuild_plan.latest.json',
    aiScientistOhlcvDailySupplementPlanPath: raw.get('aiScientistOhlcvDailySupplementPlanPath') ?? 'data/research/ai_scientist_openalice_ohlcv_daily_supplement_plan.latest.json',
    aiScientistOhlcvNativeRowsPath: raw.get('aiScientistOhlcvNativeRowsPath') ?? 'data/research/ai_scientist_openalice_ohlcv_native_rows.latest.json',
    aiScientistPitNativeRebuildStatusPath: raw.get('aiScientistPitNativeRebuildStatusPath') ?? 'data/research/ai_scientist_openalice_pit_native_rebuild_status.latest.json',
    aiScientistPitInputDatasetPath: raw.get('aiScientistPitInputDatasetPath') ?? 'data/research/ai_scientist_openalice_pit_input_dataset.latest.json',
    aiScientistPitContractStatusPath: raw.get('aiScientistPitContractStatusPath') ?? 'data/research/ai_scientist_openalice_pit_contract_status.latest.json',
    ohlcvCollectorPitContractStatusPath: raw.get('ohlcvCollectorPitContractStatusPath') ?? 'data/research/openalice_ohlcv_collector_pit_contract_status.latest.json',
    externalWarehouseRoot: resolve(raw.get('externalWarehouseRoot') ?? process.env.OPENALICE_DATA_ROOT ?? 'data'),
    aiScientistRoot: raw.get('aiScientistRoot') ?? '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl',
    json: parseBool(raw.get('json'), false),
  }
}

export async function runOpenAliceGoalCompletionAudit(args: CliArgs): Promise<OpenAliceGoalCompletionAuditReport> {
  const startedAt = new Date()
  const sourceArtifacts = {
    reasonChain: resolve(args.reasonChainPath),
    dataCatalog: resolve(args.dataCatalogPath),
    liveDataFreshness: resolve(args.liveDataFreshnessPath),
    okxPrivateAuth: resolve(args.okxPrivateAuthPath),
    feeSnapshotRefresh: resolve(args.feeSnapshotRefreshPath),
    schedulerSecurityAudit: resolve(args.schedulerSecurityAuditPath),
    releaseGateStatus: resolve(args.releaseGateStatusPath),
    paperGateStatus: resolve(args.paperGateStatusPath),
    strategyDefectMonitor: resolve(args.strategyDefectMonitorPath),
    strategyDefectRegistry: resolve(args.strategyDefectRegistryPath),
    strategyQualityGateCoverage: resolve(args.strategyQualityGateCoveragePath),
    quantFrameworkBenchmark: resolve(args.quantFrameworkBenchmarkPath),
    ethCarryResearchEvidence: resolve(args.ethCarryResearchEvidencePath),
    ethCarryDataGapStatus: resolve(args.ethCarryDataGapStatusPath),
    ethCarryPitFeatures: resolve(args.ethCarryPitFeaturesPath),
    ethCarryPitAudit: resolve(args.ethCarryPitAuditPath),
    ethCarryProspectiveEvidence: resolve(args.ethCarryProspectiveEvidencePath),
    aiScientistIntake: resolve(args.aiScientistIntakePath),
    aiScientistSourceManifest: resolve(args.aiScientistSourceManifestPath),
    aiScientistSecondValidationQueue: resolve(args.aiScientistSecondValidationQueuePath),
    aiScientistSecondValidationReadiness: resolve(args.aiScientistSecondValidationReadinessPath),
    aiScientistPitRebuildQueue: resolve(args.aiScientistPitRebuildQueuePath),
    aiScientistOhlcvNativeRebuildPlan: resolve(args.aiScientistOhlcvNativeRebuildPlanPath),
    aiScientistOhlcvDailySupplementPlan: resolve(args.aiScientistOhlcvDailySupplementPlanPath),
    aiScientistOhlcvNativeRows: resolve(args.aiScientistOhlcvNativeRowsPath),
    aiScientistPitNativeRebuildStatus: resolve(args.aiScientistPitNativeRebuildStatusPath),
    aiScientistPitInputDataset: resolve(args.aiScientistPitInputDatasetPath),
    aiScientistPitContractStatus: resolve(args.aiScientistPitContractStatusPath),
    ohlcvCollectorPitContractStatus: resolve(args.ohlcvCollectorPitContractStatusPath),
    externalWarehouseRoot: resolve(args.externalWarehouseRoot),
    aiScientistRoot: resolve(args.aiScientistRoot),
  }
  const report = buildOpenAliceGoalCompletionAuditReport({
    generatedAt: new Date().toISOString(),
    sourceArtifacts,
    reasonChain: asRecord(await readJsonIfExists(sourceArtifacts.reasonChain)),
    dataCatalog: asRecord(await readJsonIfExists(sourceArtifacts.dataCatalog)),
    liveDataFreshness: asRecord(await readJsonIfExists(sourceArtifacts.liveDataFreshness)),
    okxPrivateAuth: asRecord(await readJsonIfExists(sourceArtifacts.okxPrivateAuth)),
    feeSnapshotRefresh: asRecord(await readJsonIfExists(sourceArtifacts.feeSnapshotRefresh)),
    schedulerSecurityAudit: asRecord(await readJsonIfExists(sourceArtifacts.schedulerSecurityAudit)),
    releaseGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.releaseGateStatus)),
    paperGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.paperGateStatus)),
    strategyDefectMonitor: asRecord(await readJsonIfExists(sourceArtifacts.strategyDefectMonitor)),
    strategyDefectRegistry: asRecord(await readJsonIfExists(sourceArtifacts.strategyDefectRegistry)),
    strategyQualityGateCoverage: asRecord(await readJsonIfExists(sourceArtifacts.strategyQualityGateCoverage)),
    quantFrameworkBenchmark: asRecord(await readJsonIfExists(sourceArtifacts.quantFrameworkBenchmark)),
    ethCarryResearchEvidence: asRecord(await readJsonIfExists(sourceArtifacts.ethCarryResearchEvidence)),
    ethCarryDataGapStatus: asRecord(await readJsonIfExists(sourceArtifacts.ethCarryDataGapStatus)),
    ethCarryPitFeatures: asRecord(await readJsonIfExists(sourceArtifacts.ethCarryPitFeatures)),
    ethCarryPitAudit: asRecord(await readJsonIfExists(sourceArtifacts.ethCarryPitAudit)),
    ethCarryProspectiveEvidence: asRecord(await readJsonIfExists(sourceArtifacts.ethCarryProspectiveEvidence)),
    aiScientistIntake: asRecord(await readJsonIfExists(sourceArtifacts.aiScientistIntake)),
    aiScientistSourceManifest: asRecord(await readJsonIfExists(sourceArtifacts.aiScientistSourceManifest)),
    aiScientistSecondValidationQueue: asRecord(await readJsonIfExists(sourceArtifacts.aiScientistSecondValidationQueue)),
    aiScientistSecondValidationReadiness: asRecord(await readJsonIfExists(sourceArtifacts.aiScientistSecondValidationReadiness)),
    aiScientistPitRebuildQueue: asRecord(await readJsonIfExists(sourceArtifacts.aiScientistPitRebuildQueue)),
    aiScientistOhlcvNativeRebuildPlan: asRecord(await readJsonIfExists(sourceArtifacts.aiScientistOhlcvNativeRebuildPlan)),
    aiScientistOhlcvDailySupplementPlan: asRecord(await readJsonIfExists(sourceArtifacts.aiScientistOhlcvDailySupplementPlan)),
    aiScientistOhlcvNativeRows: asRecord(await readJsonIfExists(sourceArtifacts.aiScientistOhlcvNativeRows)),
    aiScientistPitNativeRebuildStatus: asRecord(await readJsonIfExists(sourceArtifacts.aiScientistPitNativeRebuildStatus)),
    aiScientistPitInputDataset: asRecord(await readJsonIfExists(sourceArtifacts.aiScientistPitInputDataset)),
    aiScientistPitContractStatus: asRecord(await readJsonIfExists(sourceArtifacts.aiScientistPitContractStatus)),
    ohlcvCollectorPitContractStatus: asRecord(await readJsonIfExists(sourceArtifacts.ohlcvCollectorPitContractStatus)),
    externalWarehouseRootExists: existsSync(sourceArtifacts.externalWarehouseRoot),
    aiScientistRootExists: existsSync(sourceArtifacts.aiScientistRoot),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'openalice_goal_completion_audit',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.goalComplete ? 'pass' : 'fail',
      recordsIn: Object.keys(sourceArtifacts).length,
      recordsOut: report.items.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildOpenAliceGoalCompletionAuditReport(input: {
  generatedAt?: string
  sourceArtifacts: Record<string, string>
  reasonChain: UnknownRecord | null
  dataCatalog: UnknownRecord | null
  liveDataFreshness: UnknownRecord | null
  okxPrivateAuth: UnknownRecord | null
  feeSnapshotRefresh: UnknownRecord | null
  schedulerSecurityAudit: UnknownRecord | null
  releaseGateStatus: UnknownRecord | null
  paperGateStatus: UnknownRecord | null
  strategyDefectMonitor: UnknownRecord | null
  strategyDefectRegistry: UnknownRecord | null
  strategyQualityGateCoverage: UnknownRecord | null
  quantFrameworkBenchmark: UnknownRecord | null
  ethCarryResearchEvidence: UnknownRecord | null
  ethCarryDataGapStatus: UnknownRecord | null
  ethCarryPitFeatures: UnknownRecord | null
  ethCarryPitAudit: UnknownRecord | null
  ethCarryProspectiveEvidence: UnknownRecord | null
  aiScientistIntake: UnknownRecord | null
  aiScientistSourceManifest: UnknownRecord | null
  aiScientistSecondValidationQueue: UnknownRecord | null
  aiScientistSecondValidationReadiness: UnknownRecord | null
  aiScientistPitRebuildQueue: UnknownRecord | null
  aiScientistOhlcvNativeRebuildPlan: UnknownRecord | null
  aiScientistOhlcvDailySupplementPlan: UnknownRecord | null
  aiScientistOhlcvNativeRows: UnknownRecord | null
  aiScientistPitNativeRebuildStatus: UnknownRecord | null
  aiScientistPitInputDataset: UnknownRecord | null
  aiScientistPitContractStatus: UnknownRecord | null
  ohlcvCollectorPitContractStatus: UnknownRecord | null
  externalWarehouseRootExists: boolean
  aiScientistRootExists: boolean
}): OpenAliceGoalCompletionAuditReport {
  const reasonChainPaperTradingAllowed = readBoolean(input.reasonChain?.paperTradingAllowed)
  const reasonChainLiveTradingAllowed = readBoolean(input.reasonChain?.liveTradingAllowed)
  const reasonChainCanPromote = readBoolean(input.reasonChain?.canPromote)
  const releaseGateAllowPaperTrading = readBoolean(input.releaseGateStatus?.allowPaperTrading)
  const releaseGateAllowLiveTrading = readBoolean(input.releaseGateStatus?.allowLiveTrading)
  const paperGateFinalAllowPaperTrading = readBoolean(input.paperGateStatus?.finalAllowPaperTrading)

  const items = [
    buildOkxDataItem(input),
    buildExternalWarehouseItem(input),
    buildMultiSourceCatalogItem(input),
    buildAiScientistSourceItem(input),
    buildAiScientistSecondValidationItem(input),
    buildQuantBenchmarkItem(input),
    buildStrategyDefectItem(input),
    buildStrategyQualityGateCoverageItem(input),
    buildEthCarryPitItem(input),
    buildEthCarryProspectiveItem(input),
    buildPaperLiveGateItem(input),
    buildSchedulerSecurityItem(input),
    buildSafetyInvariantItem(input),
  ]
  const requiredItems = items.filter(item => item.required)
  const requiredBlocking = requiredItems.filter(item => item.status === 'blocked' || item.status === 'missing')
  const sourceAuthorizationAttempts = [
    input.strategyDefectMonitor,
    input.strategyDefectRegistry,
    input.strategyQualityGateCoverage,
    input.quantFrameworkBenchmark,
    input.ethCarryResearchEvidence,
    input.ethCarryDataGapStatus,
    input.ethCarryProspectiveEvidence,
    input.aiScientistIntake,
    input.aiScientistSourceManifest,
    input.aiScientistSecondValidationQueue,
    input.aiScientistSecondValidationReadiness,
    input.aiScientistPitRebuildQueue,
    input.aiScientistOhlcvNativeRebuildPlan,
    input.aiScientistOhlcvDailySupplementPlan,
    input.aiScientistOhlcvNativeRows,
    input.aiScientistPitNativeRebuildStatus,
    input.aiScientistPitInputDataset,
    input.aiScientistPitContractStatus,
    input.ohlcvCollectorPitContractStatus,
  ].some(source => sourceAuthorizesExecution(source))
  const blockers = uniqueStrings([
    ...requiredBlocking.flatMap(item => item.blockers.map(blocker => `${item.id}:${blocker}`)),
    ...(sourceAuthorizationAttempts ? ['diagnostic_source_artifact_attempts_to_authorize_execution'] : []),
  ])
  const goalComplete = requiredBlocking.length === 0 &&
    reasonChainCanPromote === true &&
    releaseGateAllowPaperTrading === true &&
    sourceAuthorizationAttempts === false
  const summary = {
    items: items.length,
    requiredItems: requiredItems.length,
    pass: items.filter(item => item.status === 'pass').length,
    blocked: items.filter(item => item.status === 'blocked').length,
    missing: items.filter(item => item.status === 'missing').length,
    watch: items.filter(item => item.status === 'watch').length,
    requiredPass: requiredItems.filter(item => item.status === 'pass').length,
    requiredBlocked: requiredItems.filter(item => item.status === 'blocked').length,
    requiredMissing: requiredItems.filter(item => item.status === 'missing').length,
    dataCatalogStatus: readString(input.dataCatalog?.status),
    dataCatalogComplete: readNumber(asRecord(input.dataCatalog?.summary)?.complete),
    dataCatalogDatasets: readNumber(asRecord(input.dataCatalog?.summary)?.datasets),
    strategyDefectStatus: readString(input.strategyDefectRegistry?.status) ?? readString(input.strategyDefectMonitor?.status),
    strategyQualityGateCoverageStatus: readString(input.strategyQualityGateCoverage?.status),
    quantFrameworkStatus: readString(input.quantFrameworkBenchmark?.status),
    ethCarryProspectiveStatus: readString(input.ethCarryProspectiveEvidence?.status),
    aiScientistReadinessStatus: readString(input.aiScientistSecondValidationReadiness?.status),
    aiScientistPitNativeRebuildStatus: readString(input.aiScientistPitNativeRebuildStatus?.status),
    ohlcvCollectorPitStatus: readString(input.ohlcvCollectorPitContractStatus?.status),
    schedulerSecurityStatus: readString(input.schedulerSecurityAudit?.status),
  }

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status: goalComplete ? 'complete' : blockers.length > 0 ? 'blocked' : 'watch_only',
    goalComplete,
    objective: DEFAULT_OBJECTIVE,
    effectiveActionability: readString(input.reasonChain?.effectiveActionability) ?? 'research_only_blocked',
    overallPlanCompletionPct: readNumber(input.reasonChain?.overallPlanCompletionPct),
    goalChecklistCompletionPct: round(
      requiredItems.reduce((sum, item) => sum + item.completionPct, 0) / Math.max(1, requiredItems.length),
      0,
    ),
    observedGateState: {
      reasonChainPaperTradingAllowed,
      reasonChainLiveTradingAllowed,
      reasonChainCanPromote,
      releaseGateAllowPaperTrading,
      releaseGateAllowLiveTrading,
      paperGateFinalAllowPaperTrading,
    },
    sourceArtifacts: input.sourceArtifacts,
    summary,
    items,
    blockers,
    nextActions: [
      'Do not reopen retired RankIC/liquidity-reversal parameter tuning; keep strategy work on new PIT-safe funding/carry and independently validated candidates.',
      'Finish multi-source data catalog gaps, especially normalized/PIT feature snapshots and derivatives coverage, before treating backtests as promotion evidence.',
      'Use AI-Scientist outputs only as candidate ideas until OpenAlice second validation has PIT, WFO, FDR, route-cost, slippage, risk, trial-ledger, prospective, and paper-telemetry evidence.',
      'Prioritize P0 strategy defects: route cost/slippage/depth evidence, PIT availability, protective exits, portfolio exposure caps, and positive prospective outcomes.',
      'Refresh this audit and system_status_reason_chain after every strategy or data-pipeline repair.',
    ],
    safetyNotes: [
      'This audit is diagnostic only. It cannot authorize paper orders, live orders, leverage changes, promotion, best_config mutation, or non-flat target publication.',
      'paperTradingAllowed, liveTradingAllowed, and promotionEligible are intentionally false on this artifact even if another runtime artifact later reports readiness.',
      'A complete OKX data path is not a profitability claim. Profitability still requires positive net evidence after fees, slippage, WFO, FDR, PIT, prospective labels, and paper telemetry.',
    ],
  }
}

function buildOkxDataItem(input: Parameters<typeof buildOpenAliceGoalCompletionAuditReport>[0]): OpenAliceGoalCompletionItem {
  const liveStatus = readString(input.liveDataFreshness?.status)
  const liveSummary = asRecord(input.liveDataFreshness?.summary)
  const privateAuthStatus = readString(input.okxPrivateAuth?.status)
  const feeStatus = readString(input.feeSnapshotRefresh?.status)
  const liveFresh = liveStatus === 'fresh'
  const privateAuthReady = privateAuthStatus === 'auth_available'
  const feeReady = feeStatus === 'runtime_verified'
  const blockers = [
    ...(input.liveDataFreshness ? [] : ['live_data_freshness_missing']),
    ...(input.okxPrivateAuth ? [] : ['okx_private_auth_diagnosis_missing']),
    ...(input.feeSnapshotRefresh ? [] : ['fee_snapshot_refresh_missing']),
    ...(liveFresh ? [] : [`live_data_not_fresh:${liveStatus ?? 'missing'}`]),
    ...(privateAuthReady ? [] : [`okx_private_auth_not_available:${privateAuthStatus ?? 'missing'}`]),
    ...(feeReady ? [] : [`runtime_fee_snapshot_not_verified:${feeStatus ?? 'missing'}`]),
    ...readStringArray(input.liveDataFreshness?.blockers).map(blocker => `live_data:${blocker}`),
    ...readStringArray(input.okxPrivateAuth?.blockers).map(blocker => `okx_private_auth:${blocker}`),
    ...readStringArray(input.feeSnapshotRefresh?.blockers).map(blocker => `runtime_fee:${blocker}`),
  ]
  return {
    id: 'okx_public_private_fee_storage',
    title: 'OKX public data, private auth, and runtime fee snapshot are restored for research storage',
    required: true,
    status: blockers.length === 0 ? 'pass' : input.liveDataFreshness || input.okxPrivateAuth || input.feeSnapshotRefresh ? 'blocked' : 'missing',
    completionPct: Math.round(([liveFresh, privateAuthReady, feeReady].filter(Boolean).length / 3) * 100),
    evidencePaths: [
      input.sourceArtifacts.liveDataFreshness,
      input.sourceArtifacts.okxPrivateAuth,
      input.sourceArtifacts.feeSnapshotRefresh,
    ],
    blockers,
    metrics: {
      liveDataStatus: liveStatus,
      publicDataUsableForLiveOnlyResearch: readBoolean(liveSummary?.publicDataUsableForLiveOnlyResearch),
      presentAssets: readNumber(liveSummary?.presentAssets),
      freshAssets: readNumber(liveSummary?.freshAssets),
      okxPrivateAuthStatus: privateAuthStatus,
      okxPrivateAuthBestMode: readString(input.okxPrivateAuth?.bestMode),
      runtimeFeeStatus: feeStatus,
      runtimeFeeSnapshotWritten: readBoolean(input.feeSnapshotRefresh?.snapshotWritten),
      runtimeFeePerSymbolFeesCount: readNumber(input.feeSnapshotRefresh?.perSymbolFeesCount) ??
        (Array.isArray(input.feeSnapshotRefresh?.perSymbolFees) ? input.feeSnapshotRefresh.perSymbolFees.length : null),
    },
    nextActions: blockers.length === 0
      ? ['Keep OKX public/private/fee refresh scheduled; this is data readiness only, not a trading permission.']
      : ['Refresh OKX public data, private-auth diagnosis, and runtime fee snapshot until all three are ready.'],
  }
}

function buildExternalWarehouseItem(input: Parameters<typeof buildOpenAliceGoalCompletionAuditReport>[0]): OpenAliceGoalCompletionItem {
  const warehouseRoot = readString(input.dataCatalog?.warehouseRoot) ?? input.sourceArtifacts.externalWarehouseRoot
  const blockers = [
    ...(input.externalWarehouseRootExists ? [] : [`external_warehouse_root_missing:${input.sourceArtifacts.externalWarehouseRoot}`]),
  ]
  return {
    id: 'external_warehouse_root',
    title: 'External data warehouse is visible for OpenAlice supplemental data',
    required: true,
    status: blockers.length === 0 ? 'pass' : 'missing',
    completionPct: blockers.length === 0 ? 100 : 0,
    evidencePaths: [
      input.sourceArtifacts.externalWarehouseRoot,
      input.sourceArtifacts.dataCatalog,
    ],
    blockers,
    metrics: {
      expectedRoot: input.sourceArtifacts.externalWarehouseRoot,
      catalogWarehouseRoot: warehouseRoot,
      exists: input.externalWarehouseRootExists,
    },
    nextActions: blockers.length === 0
      ? ['Continue cataloging warehouse downloads and normalize only manifest-backed datasets.']
      : [`Create or explicitly configure the research data root at ${input.sourceArtifacts.externalWarehouseRoot} before depending on supplemental data.`],
  }
}

function buildMultiSourceCatalogItem(input: Parameters<typeof buildOpenAliceGoalCompletionAuditReport>[0]): OpenAliceGoalCompletionItem {
  const status = readString(input.dataCatalog?.status)
  const summary = asRecord(input.dataCatalog?.summary)
  const blockerActionability = asRecord(input.dataCatalog?.blockerActionability)
  const blockerCategories = readRecordArray(blockerActionability?.categories)
  const datasets = readNumber(summary?.datasets) ?? 0
  const complete = readNumber(summary?.complete) ?? 0
  const completionPct = datasets > 0 ? round((complete / datasets) * 100, 0) : 0
  const blockers = [
    ...(input.dataCatalog ? [] : ['openalice_data_catalog_missing']),
    ...(status === 'complete' ? [] : [`openalice_data_catalog_status:${status ?? 'missing'}`]),
    ...readStringArray(input.dataCatalog?.blockers).slice(0, 32).map(blocker => `openalice_data_catalog:${blocker}`),
  ]
  return {
    id: 'multi_source_data_catalog',
    title: 'Multi-source crypto data catalog covers raw, normalized, audit, runtime, and PIT inputs',
    required: true,
    status: !input.dataCatalog ? 'missing' : blockers.length === 0 ? 'pass' : 'blocked',
    completionPct,
    evidencePaths: [
      input.sourceArtifacts.dataCatalog,
      input.sourceArtifacts.externalWarehouseRoot,
      input.sourceArtifacts.aiScientistRoot,
    ],
    blockers,
    metrics: {
      status,
      datasets,
      complete,
      partial: readNumber(summary?.partial),
      missing: readNumber(summary?.missing),
      verifiedBinancePublicDatasets: readNumber(summary?.verifiedBinancePublicDatasets),
      plannedBinancePublicDatasets: readNumber(summary?.plannedBinancePublicDatasets),
      dataCatalogTotalBlockers: readNumber(blockerActionability?.totalBlockers),
      dataCatalogPrimaryBlockerCategory: readString(blockerActionability?.primaryCategory),
      dataCatalogDownloadGapBlockers: blockerCategoryCount(blockerCategories, 'download_gap'),
      dataCatalogPitOrNormalizedGapBlockers: blockerCategoryCount(blockerCategories, 'pit_or_normalized_gap'),
      dataCatalogAiScientistValidationGateBlockers: blockerCategoryCount(blockerCategories, 'ai_scientist_validation_gate'),
      dataCatalogDerivativesAuditGapBlockers: blockerCategoryCount(blockerCategories, 'derivatives_audit_gap'),
      dataCatalogAssetMetadataGapBlockers: blockerCategoryCount(blockerCategories, 'asset_metadata_gap'),
      dataCatalogManifestOrTrustGapBlockers: blockerCategoryCount(blockerCategories, 'manifest_or_trust_gap'),
      dataCatalogResumeContractGapBlockers: blockerCategoryCount(blockerCategories, 'resume_contract_gap'),
      observedFamilies: readStringArray(asRecord(input.dataCatalog?.objectiveCoverage)?.observedFamilies),
      observedLayers: readStringArray(asRecord(input.dataCatalog?.objectiveCoverage)?.observedLayers),
    },
    nextActions: readStringArray(input.dataCatalog?.nextActions).length > 0
      ? readStringArray(input.dataCatalog?.nextActions)
      : ['Finish missing derivatives, normalized parquet, asset metadata, and PIT feature snapshot coverage.'],
  }
}

function blockerCategoryCount(categories: UnknownRecord[], category: string): number | null {
  const match = categories.find(item => readString(item.category) === category)
  return readNumber(match?.count)
}

function buildAiScientistSourceItem(input: Parameters<typeof buildOpenAliceGoalCompletionAuditReport>[0]): OpenAliceGoalCompletionItem {
  const intakeCounts = asRecord(input.aiScientistIntake?.counts)
  const sourceManifestCounts = asRecord(input.aiScientistSourceManifest?.counts)
  const candidatesFound = readNumber(intakeCounts?.candidatesFound) ?? 0
  const candidatesLocked = readNumber(sourceManifestCounts?.candidatesLocked) ?? 0
  const sourceFilesMissing = readNumber(sourceManifestCounts?.sourceFilesMissing) ?? 0
  const blockers = [
    ...(input.aiScientistRootExists ? [] : [`ai_scientist_root_missing:${input.sourceArtifacts.aiScientistRoot}`]),
    ...(input.aiScientistIntake ? [] : ['ai_scientist_intake_missing']),
    ...(input.aiScientistSourceManifest ? [] : ['ai_scientist_source_manifest_missing']),
    ...(candidatesFound > 0 ? [] : ['ai_scientist_candidates_missing']),
    ...(candidatesLocked > 0 ? [] : ['ai_scientist_locked_source_manifest_missing']),
    ...(sourceFilesMissing === 0 ? [] : [`ai_scientist_source_files_missing:${sourceFilesMissing}`]),
  ]
  return {
    id: 'ai_scientist_candidate_source',
    title: 'AI-Scientist crypto_dl candidates are visible and source-locked for research intake',
    required: true,
    status: blockers.length === 0 ? 'pass' : input.aiScientistRootExists ? 'blocked' : 'missing',
    completionPct: Math.round(([input.aiScientistRootExists, input.aiScientistIntake != null, input.aiScientistSourceManifest != null, candidatesFound > 0, candidatesLocked > 0, sourceFilesMissing === 0].filter(Boolean).length / 6) * 100),
    evidencePaths: [
      input.sourceArtifacts.aiScientistRoot,
      input.sourceArtifacts.aiScientistIntake,
      input.sourceArtifacts.aiScientistSourceManifest,
    ],
    blockers,
    metrics: {
      rootExists: input.aiScientistRootExists,
      intakeStatus: readString(input.aiScientistIntake?.status),
      candidatesFound,
      sourceManifestStatus: readString(input.aiScientistSourceManifest?.status),
      candidatesLocked,
      sourceFilesMissing,
    },
    nextActions: blockers.length === 0
      ? ['Keep AI-Scientist outputs as candidate ideas; use OpenAlice second validation before incubation.']
      : ['Refresh AI-Scientist intake and locked source manifest from crypto_dl.'],
  }
}

function buildAiScientistSecondValidationItem(input: Parameters<typeof buildOpenAliceGoalCompletionAuditReport>[0]): OpenAliceGoalCompletionItem {
  const queueCounts = asRecord(input.aiScientistSecondValidationQueue?.counts)
  const readinessCounts = asRecord(input.aiScientistSecondValidationReadiness?.counts)
  const pitInputCounts = asRecord(input.aiScientistPitInputDataset?.counts)
  const pitContractCounts = asRecord(input.aiScientistPitContractStatus?.counts)
  const pitRebuildCounts = asRecord(input.aiScientistPitRebuildQueue?.counts)
  const ohlcvRebuildPlanCounts = asRecord(input.aiScientistOhlcvNativeRebuildPlan?.counts)
  const ohlcvDailySupplementCounts = asRecord(input.aiScientistOhlcvDailySupplementPlan?.counts)
  const ohlcvNativeRowsCounts = asRecord(input.aiScientistOhlcvNativeRows?.counts)
  const pitNativeCounts = asRecord(input.aiScientistPitNativeRebuildStatus?.counts)
  const collectorPitCounts = asRecord(input.ohlcvCollectorPitContractStatus?.counts)
  const requiredGateCount = readNumber(queueCounts?.requiredGateCount) ?? readNumber(readinessCounts?.totalGates) ?? 0
  const missingGateCount = readNumber(queueCounts?.missingGateCount) ?? readNumber(readinessCounts?.missingOpenAliceEvidenceGates) ?? 0
  const rowsPromotionGrade = readNumber(pitContractCounts?.rowsPromotionGrade) ?? readNumber(pitInputCounts?.promotionGradeRows) ?? 0
  const pitRebuildOpenTasks = readNumber(pitRebuildCounts?.openTasks) ?? 0
  const pitNativeAutoEligibleTasks = readNumber(pitNativeCounts?.autoRebuildEligibleTasks) ?? 0
  const blockers = [
    ...(input.aiScientistSecondValidationQueue ? [] : ['ai_scientist_second_validation_queue_missing']),
    ...(input.aiScientistSecondValidationReadiness ? [] : ['ai_scientist_second_validation_readiness_missing']),
    ...(input.aiScientistPitRebuildQueue ? [] : ['ai_scientist_pit_rebuild_queue_missing']),
    ...(input.aiScientistOhlcvNativeRebuildPlan ? [] : ['ai_scientist_ohlcv_native_rebuild_plan_missing']),
    ...(input.aiScientistOhlcvDailySupplementPlan ? [] : ['ai_scientist_ohlcv_daily_supplement_plan_missing']),
    ...(input.aiScientistOhlcvNativeRows ? [] : ['ai_scientist_ohlcv_native_rows_missing']),
    ...(input.aiScientistPitNativeRebuildStatus ? [] : ['ai_scientist_pit_native_rebuild_status_missing']),
    ...(input.aiScientistPitInputDataset ? [] : ['ai_scientist_pit_input_dataset_missing']),
    ...(input.aiScientistPitContractStatus ? [] : ['ai_scientist_pit_contract_status_missing']),
    ...(input.ohlcvCollectorPitContractStatus ? [] : ['ohlcv_collector_pit_contract_status_missing']),
    ...(readString(input.aiScientistSecondValidationReadiness?.status)?.startsWith('blocked') === true
      ? [`ai_scientist_readiness_status:${readString(input.aiScientistSecondValidationReadiness?.status)}`]
      : []),
    ...(readString(input.aiScientistPitContractStatus?.status)?.startsWith('blocked') === true
      ? [`ai_scientist_pit_contract_status:${readString(input.aiScientistPitContractStatus?.status)}`]
      : []),
    ...(readString(input.aiScientistPitRebuildQueue?.status)?.startsWith('blocked') === true
      ? [`ai_scientist_pit_rebuild_queue_status:${readString(input.aiScientistPitRebuildQueue?.status)}`]
      : []),
    ...(readString(input.aiScientistOhlcvNativeRebuildPlan?.status)?.startsWith('blocked') === true
      ? [`ai_scientist_ohlcv_native_rebuild_plan_status:${readString(input.aiScientistOhlcvNativeRebuildPlan?.status)}`]
      : []),
    ...(readString(input.aiScientistOhlcvDailySupplementPlan?.status) != null &&
      readString(input.aiScientistOhlcvDailySupplementPlan?.status) !== 'ready_daily_supplement_research_only'
      ? [`ai_scientist_ohlcv_daily_supplement_plan_status:${readString(input.aiScientistOhlcvDailySupplementPlan?.status)}`]
      : []),
    ...(readString(input.aiScientistOhlcvNativeRows?.status)?.startsWith('blocked') === true
      ? [`ai_scientist_ohlcv_native_rows_status:${readString(input.aiScientistOhlcvNativeRows?.status)}`]
      : []),
    ...(readString(input.aiScientistPitNativeRebuildStatus?.status)?.startsWith('blocked') === true
      ? [`ai_scientist_pit_native_rebuild_status:${readString(input.aiScientistPitNativeRebuildStatus?.status)}`]
      : []),
    ...(readString(input.ohlcvCollectorPitContractStatus?.status)?.startsWith('blocked') === true
      ? [`ohlcv_collector_pit_status:${readString(input.ohlcvCollectorPitContractStatus?.status)}`]
      : []),
    ...(missingGateCount === 0 ? [] : [`ai_scientist_missing_openalice_gates:${missingGateCount}`]),
    ...(rowsPromotionGrade > 0 ? [] : [`ai_scientist_promotion_grade_rows_missing:${rowsPromotionGrade}`]),
    ...(pitRebuildOpenTasks === 0 ? [] : [`ai_scientist_pit_rebuild_tasks_open:${pitRebuildOpenTasks}`]),
    ...(pitNativeAutoEligibleTasks > 0 ? [] : [`ai_scientist_pit_native_auto_rebuild_eligible_missing:${pitNativeAutoEligibleTasks}`]),
    ...readStringArray(input.aiScientistSecondValidationQueue?.blockers).slice(0, 12).map(blocker => `queue:${blocker}`),
    ...readStringArray(input.aiScientistSecondValidationReadiness?.blockers).slice(0, 12).map(blocker => `readiness:${blocker}`),
    ...readStringArray(input.aiScientistPitRebuildQueue?.blockers).slice(0, 12).map(blocker => `pit_rebuild_queue:${blocker}`),
    ...readStringArray(input.aiScientistOhlcvNativeRebuildPlan?.blockers).slice(0, 12).map(blocker => `ohlcv_native_rebuild_plan:${blocker}`),
    ...readStringArray(input.aiScientistOhlcvDailySupplementPlan?.blockers).slice(0, 12).map(blocker => `ohlcv_daily_supplement_plan:${blocker}`),
    ...readStringArray(input.aiScientistOhlcvNativeRows?.blockers).slice(0, 12).map(blocker => `ohlcv_native_rows:${blocker}`),
    ...readStringArray(input.aiScientistPitNativeRebuildStatus?.blockers).slice(0, 12).map(blocker => `pit_native_rebuild:${blocker}`),
    ...readStringArray(input.aiScientistPitContractStatus?.blockers).slice(0, 12).map(blocker => `pit_contract:${blocker}`),
    ...readStringArray(input.ohlcvCollectorPitContractStatus?.blockers).slice(0, 12).map(blocker => `ohlcv_collector_pit:${blocker}`),
  ]
  return {
    id: 'ai_scientist_openalice_second_validation',
    title: 'AI-Scientist candidates have OpenAlice-native second validation before any incubation',
    required: true,
    status: !input.aiScientistSecondValidationQueue && !input.aiScientistSecondValidationReadiness ? 'missing' : blockers.length === 0 ? 'pass' : 'blocked',
    completionPct: requiredGateCount > 0 ? round(((requiredGateCount - missingGateCount) / requiredGateCount) * 100, 0) : 0,
    evidencePaths: [
      input.sourceArtifacts.aiScientistSecondValidationQueue,
      input.sourceArtifacts.aiScientistSecondValidationReadiness,
      input.sourceArtifacts.aiScientistPitRebuildQueue,
      input.sourceArtifacts.aiScientistOhlcvNativeRebuildPlan,
      input.sourceArtifacts.aiScientistOhlcvDailySupplementPlan,
      input.sourceArtifacts.aiScientistOhlcvNativeRows,
      input.sourceArtifacts.aiScientistPitNativeRebuildStatus,
      input.sourceArtifacts.aiScientistPitInputDataset,
      input.sourceArtifacts.aiScientistPitContractStatus,
      input.sourceArtifacts.ohlcvCollectorPitContractStatus,
      readString(asRecord(input.ohlcvCollectorPitContractStatus?.sourceArtifacts)?.collectorPitRows) ?? DEFAULT_COLLECTOR_PIT_ROWS_PATH,
    ],
    blockers,
    metrics: {
      queueStatus: readString(input.aiScientistSecondValidationQueue?.status),
      readinessStatus: readString(input.aiScientistSecondValidationReadiness?.status),
      requiredGateCount,
      missingGateCount,
      pitInputStatus: readString(input.aiScientistPitInputDataset?.status),
      pitRebuildQueueStatus: readString(input.aiScientistPitRebuildQueue?.status),
      pitRebuildTasks: readNumber(pitRebuildCounts?.rebuildTasks),
      pitRebuildOpenTasks,
      pitRebuildMissingAvailableAtTasks: readNumber(pitRebuildCounts?.missingAvailableAtTasks),
      pitRebuildMissingObservedOrFetchedAtTasks: readNumber(pitRebuildCounts?.missingObservedOrFetchedAtTasks),
      pitRebuildIncompleteWarehouseLineageTasks: readNumber(pitRebuildCounts?.incompleteWarehouseLineageTasks),
      ohlcvNativeRebuildPlanStatus: readString(input.aiScientistOhlcvNativeRebuildPlan?.status),
      ohlcvNativeRebuildMaterializationCandidateTasks: readNumber(ohlcvRebuildPlanCounts?.materializationCandidateTasks),
      ohlcvNativeRebuildOhlcvTasksAssessed: readNumber(ohlcvRebuildPlanCounts?.ohlcvTasksAssessed),
      ohlcvNativeRebuildMissingArchiveMonths: readNumber(ohlcvRebuildPlanCounts?.missingArchiveMonths),
      ohlcvNativeRebuildMatchedZipFiles: readNumber(ohlcvRebuildPlanCounts?.matchedZipFiles),
      ohlcvDailySupplementStatus: readString(input.aiScientistOhlcvDailySupplementPlan?.status),
      ohlcvDailySupplementEntries: readNumber(ohlcvDailySupplementCounts?.uniqueSupplementEntries),
      ohlcvDailySupplementLocal: (readNumber(ohlcvDailySupplementCounts?.localExists) ?? 0) + (readNumber(ohlcvDailySupplementCounts?.downloaded) ?? 0),
      ohlcvDailySupplementRemoteAvailable: readNumber(ohlcvDailySupplementCounts?.remoteAvailable),
      ohlcvDailySupplementRemoteMissing: readNumber(ohlcvDailySupplementCounts?.remoteMissing),
      ohlcvDailySupplementFailed: readNumber(ohlcvDailySupplementCounts?.failed),
      ohlcvDailySupplementNotChecked: readNumber(ohlcvDailySupplementCounts?.notChecked),
      ohlcvNativeRowsStatus: readString(input.aiScientistOhlcvNativeRows?.status),
      ohlcvNativeRowsWritten: readNumber(ohlcvNativeRowsCounts?.rowsWritten),
      ohlcvNativeRowsTasksMaterialized: readNumber(ohlcvNativeRowsCounts?.tasksMaterialized),
      ohlcvNativeRowsPromotionGradeRows: readNumber(ohlcvNativeRowsCounts?.promotionGradeRows),
      ohlcvNativeRowsDistinctSymbols: readNumber(ohlcvNativeRowsCounts?.distinctSymbols),
      pitNativeRebuildStatus: readString(input.aiScientistPitNativeRebuildStatus?.status),
      pitNativeAssessedTasks: readNumber(pitNativeCounts?.assessedTasks),
      pitNativeAutoRebuildEligibleTasks: pitNativeAutoEligibleTasks,
      pitNativeRequiredCollectorUpgradeTasks: readNumber(pitNativeCounts?.requiredCollectorUpgradeTasks),
      pitNativeRawKlineManifestWithPromotionGradeTimeFieldsTasks: readNumber(pitNativeCounts?.rawKlineManifestWithPromotionGradeTimeFieldsTasks),
      pitNativeDerivativesPitUsableTasks: readNumber(pitNativeCounts?.derivativesPitUsableTasks),
      ohlcvCollectorPitStatus: readString(input.ohlcvCollectorPitContractStatus?.status),
      ohlcvCollectorPitRows: readNumber(collectorPitCounts?.rowsScanned),
      ohlcvCollectorRowExplicitAvailableAt: readNumber(collectorPitCounts?.rowsWithRowExplicitAvailableAt),
      ohlcvCollectorRowExplicitObservedOrFetchedAt: readNumber(collectorPitCounts?.rowsWithRowExplicitObservedOrFetchedAt),
      ohlcvCollectorPromotionGradeRows: readNumber(collectorPitCounts?.rowsPromotionGrade),
      pitContractStatus: readString(input.aiScientistPitContractStatus?.status),
      rowsPromotionGrade,
      rowExplicitAvailableAt: readNumber(pitContractCounts?.rowsWithRowExplicitAvailableAt),
      rowExplicitObservedOrFetchedAt: readNumber(pitContractCounts?.rowsWithRowExplicitObservedOrFetchedAt),
    },
    nextActions: [
      'Rebuild selected AI-Scientist features inside OpenAlice with row-explicit observedAt/fetchedAt/availableAt.',
      'Run OpenAlice-native PIT, WFO, FDR, route-cost, slippage, risk, trial-ledger, prospective, and paper-telemetry validation before using any candidate.',
    ],
  }
}

function buildQuantBenchmarkItem(input: Parameters<typeof buildOpenAliceGoalCompletionAuditReport>[0]): OpenAliceGoalCompletionItem {
  const summary = asRecord(input.quantFrameworkBenchmark?.summary)
  const capabilities = readNumber(summary?.capabilities) ?? 0
  const blockedCapabilities = readNumber(summary?.blockedCapabilities) ?? capabilities
  const blockers = [
    ...(input.quantFrameworkBenchmark ? [] : ['quant_framework_benchmark_missing']),
    ...(readString(input.quantFrameworkBenchmark?.status) === 'watch_only' ? [] : [`quant_framework_benchmark_status:${readString(input.quantFrameworkBenchmark?.status) ?? 'missing'}`]),
    ...(blockedCapabilities === 0 ? [] : [`quant_framework_blocked_capabilities:${blockedCapabilities}`]),
    ...readStringArray(input.quantFrameworkBenchmark?.blockers).slice(0, 24).map(blocker => `benchmark:${blocker}`),
  ]
  return {
    id: 'quant_framework_benchmark',
    title: 'Lessons from strong quant frameworks are mapped into OpenAlice capability gaps',
    required: true,
    status: !input.quantFrameworkBenchmark ? 'missing' : blockers.length === 0 ? 'pass' : 'blocked',
    completionPct: capabilities > 0 ? round(((capabilities - blockedCapabilities) / capabilities) * 100, 0) : 0,
    evidencePaths: [
      input.sourceArtifacts.quantFrameworkBenchmark,
      input.sourceArtifacts.strategyDefectRegistry,
    ],
    blockers,
    metrics: {
      status: readString(input.quantFrameworkBenchmark?.status),
      frameworks: readNumber(summary?.frameworks),
      capabilities,
      blockedCapabilities,
      p0RelatedOpenOrPartialDefects: readNumber(summary?.p0RelatedOpenOrPartialDefects),
      dataCatalogStatus: readString(summary?.dataCatalogStatus),
      reasonChainActionability: readString(summary?.reasonChainActionability),
    },
    nextActions: readStringArray(input.quantFrameworkBenchmark?.nextActions).length > 0
      ? readStringArray(input.quantFrameworkBenchmark?.nextActions)
      : ['Convert framework capability gaps into concrete OpenAlice evidence and guardrail repairs.'],
  }
}

function buildStrategyDefectItem(input: Parameters<typeof buildOpenAliceGoalCompletionAuditReport>[0]): OpenAliceGoalCompletionItem {
  const monitorSummary = asRecord(input.strategyDefectMonitor?.summary)
  const registrySummary = asRecord(input.strategyDefectRegistry?.summary)
  const defects = readNumber(registrySummary?.defects) ?? 0
  const open = readNumber(registrySummary?.open) ?? 0
  const partial = readNumber(registrySummary?.partial) ?? 0
  const unknown = readNumber(registrySummary?.unknown) ?? 0
  const openOrPartial = open + partial + unknown
  const blockers = [
    ...(input.strategyDefectMonitor ? [] : ['strategy_defect_monitor_missing']),
    ...(input.strategyDefectRegistry ? [] : ['strategy_defect_registry_missing']),
    ...(readString(input.strategyDefectMonitor?.status) === 'watch_only' ? [] : [`strategy_defect_monitor_status:${readString(input.strategyDefectMonitor?.status) ?? 'missing'}`]),
    ...(readString(input.strategyDefectRegistry?.status) === 'watch_only' ? [] : [`strategy_defect_registry_status:${readString(input.strategyDefectRegistry?.status) ?? 'missing'}`]),
    ...(openOrPartial === 0 ? [] : [`strategy_defects_open_or_partial:${openOrPartial}`]),
    ...readStringArray(input.strategyDefectMonitor?.blockers).slice(0, 20).map(blocker => `monitor:${blocker}`),
    ...readStringArray(input.strategyDefectRegistry?.blockers).slice(0, 20).map(blocker => `registry:${blocker}`),
  ]
  return {
    id: 'strategy_defect_registry_monitor',
    title: 'Known strategy defects are machine-monitored and high-priority gaps are closed',
    required: true,
    status: !input.strategyDefectMonitor && !input.strategyDefectRegistry ? 'missing' : blockers.length === 0 ? 'pass' : 'blocked',
    completionPct: defects > 0 ? round(((defects - openOrPartial) / defects) * 100, 0) : 0,
    evidencePaths: [
      input.sourceArtifacts.strategyDefectMonitor,
      input.sourceArtifacts.strategyDefectRegistry,
      '/Users/kino/Downloads/openalice_strategy_improvement.md',
    ],
    blockers,
    metrics: {
      monitorStatus: readString(input.strategyDefectMonitor?.status),
      monitorFindings: readNumber(monitorSummary?.findings),
      monitorBlocked: readNumber(monitorSummary?.blocked),
      monitorP0Blocked: readNumber(monitorSummary?.p0Blocked),
      registryStatus: readString(input.strategyDefectRegistry?.status),
      defects,
      open,
      partial,
      watch: readNumber(registrySummary?.watch),
      p0OpenOrPartial: readNumber(registrySummary?.p0OpenOrPartial),
      p1OpenOrPartial: readNumber(registrySummary?.p1OpenOrPartial),
    },
    nextActions: readStringArray(input.strategyDefectRegistry?.nextActions).length > 0
      ? readStringArray(input.strategyDefectRegistry?.nextActions)
      : ['Close P0/P1 strategy defects with code evidence and refreshed runtime artifact evidence.'],
  }
}

function buildStrategyQualityGateCoverageItem(input: Parameters<typeof buildOpenAliceGoalCompletionAuditReport>[0]): OpenAliceGoalCompletionItem {
  const summary = asRecord(input.strategyQualityGateCoverage?.summary)
  const defects = readNumber(summary?.defects) ?? 0
  const p0p1OpenOrPartial = readNumber(summary?.p0p1OpenOrPartial) ?? 0
  const p0p1OpenOrPartialUncovered = readNumber(summary?.p0p1OpenOrPartialUncovered) ?? p0p1OpenOrPartial
  const coveragePct = readNumber(summary?.p0p1OpenOrPartialCoveragePct) ?? 0
  const blockers = [
    ...(input.strategyQualityGateCoverage ? [] : ['strategy_quality_gate_coverage_missing']),
    ...(readString(input.strategyQualityGateCoverage?.status) === 'watch_only' ? [] : [`strategy_quality_gate_coverage_status:${readString(input.strategyQualityGateCoverage?.status) ?? 'missing'}`]),
    ...(p0p1OpenOrPartialUncovered === 0 ? [] : [`p0p1_open_or_partial_defects_without_monitor:${p0p1OpenOrPartialUncovered}`]),
    ...readStringArray(input.strategyQualityGateCoverage?.blockers).slice(0, 20).map(blocker => `coverage:${blocker}`),
  ]
  return {
    id: 'strategy_quality_gate_coverage',
    title: 'P0/P1 strategy defects have explicit machine monitors before repair claims',
    required: true,
    status: !input.strategyQualityGateCoverage ? 'missing' : blockers.length === 0 ? 'pass' : 'blocked',
    completionPct: p0p1OpenOrPartial > 0 ? coveragePct : defects > 0 ? 100 : 0,
    evidencePaths: [
      input.sourceArtifacts.strategyQualityGateCoverage,
      input.sourceArtifacts.strategyDefectRegistry,
      input.sourceArtifacts.strategyDefectMonitor,
    ],
    blockers,
    metrics: {
      status: readString(input.strategyQualityGateCoverage?.status),
      defects,
      monitorFindings: readNumber(summary?.monitorFindings),
      p0OpenOrPartial: readNumber(summary?.p0OpenOrPartial),
      p1OpenOrPartial: readNumber(summary?.p1OpenOrPartial),
      p0p1OpenOrPartial,
      p0p1OpenOrPartialCovered: readNumber(summary?.p0p1OpenOrPartialCovered),
      p0p1OpenOrPartialUncovered,
      p0OpenOrPartialUncovered: readNumber(summary?.p0OpenOrPartialUncovered),
      p1OpenOrPartialUncovered: readNumber(summary?.p1OpenOrPartialUncovered),
      p0p1OpenOrPartialCoveragePct: coveragePct,
      blockedRepairQueues: readNumber(summary?.blockedRepairQueues),
    },
    nextActions: readStringArray(input.strategyQualityGateCoverage?.nextActions).length > 0
      ? readStringArray(input.strategyQualityGateCoverage?.nextActions)
      : ['Add focused monitors for uncovered P0/P1 strategy defects before claiming strategy quality progress.'],
  }
}

function buildEthCarryPitItem(input: Parameters<typeof buildOpenAliceGoalCompletionAuditReport>[0]): OpenAliceGoalCompletionItem {
  const pitEvidence = asRecord(input.ethCarryResearchEvidence?.pitEvidence)
  const basisEvidence = asRecord(input.ethCarryResearchEvidence?.basisEvidence)
  const dataGapCounts = asRecord(input.ethCarryDataGapStatus?.counts)
  const featureStatus = readString(input.ethCarryPitFeatures?.status)
  const auditStatus = readString(input.ethCarryPitAudit?.status)
  const basisStatus = readString(pitEvidence?.basisAvailableTimeStatus)
  const fundingStatus = readString(pitEvidence?.fundingAvailableTimeStatus)
  const carryFeatureRows = readNumber(input.ethCarryPitFeatures?.carryFeatureRows) ??
    readNumber(asRecord(input.ethCarryPitFeatures?.summary)?.carryFeatureRows) ??
    readNumber(dataGapCounts?.carryFeatureRows)
  const minCarryFeatureRows = readNumber(asRecord(input.ethCarryDataGapStatus?.thresholds)?.minCarryFeatureRows)
  const collectorErrorCount = readNumber(dataGapCounts?.collectorErrorCount) ?? 0
  const dataGapBlockers = readStringArray(input.ethCarryDataGapStatus?.blockers)
  const dataGapCatalogBlockers = readStringArray(input.ethCarryDataGapStatus?.catalogBlockers)
  const archiveSummary = asRecord(input.ethCarryDataGapStatus?.dataVisionArchiveSummary)
  const basisPresent = basisStatus === 'present' || readBoolean(basisEvidence?.available) === true
  const fundingComplete = fundingStatus === 'complete' || readNumber(pitEvidence?.fundingExplicitAvailableTimeCoveragePct) === 100
  const blockers = [
    ...(input.ethCarryPitFeatures ? [] : ['eth_carry_pit_features_missing']),
    ...(input.ethCarryPitAudit ? [] : ['eth_carry_pit_audit_missing']),
    ...(featureStatus === 'ready_for_research' || featureStatus === 'ready' ? [] : [`eth_carry_pit_features_status:${featureStatus ?? 'missing'}`]),
    ...(auditStatus === 'pass' ? [] : [`eth_carry_pit_audit_status:${auditStatus ?? 'missing'}`]),
    ...(fundingComplete ? [] : [`eth_carry_funding_available_time_status:${fundingStatus ?? 'missing'}`]),
    ...(basisPresent ? [] : [`eth_carry_basis_available_time_status:${basisStatus ?? 'missing'}`]),
    ...(minCarryFeatureRows == null || carryFeatureRows == null || carryFeatureRows >= minCarryFeatureRows
      ? []
      : [`eth_carry_data_gap_carry_feature_rows_low:${carryFeatureRows}<${minCarryFeatureRows}`]),
    ...(collectorErrorCount === 0 ? [] : [`eth_carry_data_gap_collector_errors:${collectorErrorCount}`]),
    ...dataGapBlockers
      .filter(blocker => blocker.startsWith('data_vision_core_archive_'))
      .slice(0, 8)
      .map(blocker => `eth_carry_data_gap:${blocker}`),
  ]
  return {
    id: 'eth_carry_pit_basis_data',
    title: 'Funding/carry PIT feature data includes availableAt and basis evidence',
    required: true,
    status: !input.ethCarryPitFeatures && !input.ethCarryPitAudit ? 'missing' : blockers.length === 0 ? 'pass' : 'blocked',
    completionPct: Math.round(([input.ethCarryPitFeatures != null, input.ethCarryPitAudit != null, featureStatus === 'ready_for_research' || featureStatus === 'ready', auditStatus === 'pass', fundingComplete, basisPresent].filter(Boolean).length / 6) * 100),
    evidencePaths: [
      input.sourceArtifacts.ethCarryPitFeatures,
      input.sourceArtifacts.ethCarryPitAudit,
      input.sourceArtifacts.ethCarryResearchEvidence,
      input.sourceArtifacts.ethCarryDataGapStatus,
    ],
    blockers,
    metrics: {
      pitFeaturesStatus: featureStatus,
      pitAuditStatus: auditStatus,
      sourceEvents: readNumber(input.ethCarryPitFeatures?.sourceEvents) ?? readNumber(asRecord(input.ethCarryPitFeatures?.summary)?.sourceEvents) ?? readNumber(dataGapCounts?.sourceEvents),
      fundingEvents: readNumber(input.ethCarryPitFeatures?.fundingEvents) ?? readNumber(asRecord(input.ethCarryPitFeatures?.summary)?.fundingEvents) ?? readNumber(dataGapCounts?.fundingEvents),
      basisSnapshots: readNumber(input.ethCarryPitFeatures?.basisSnapshots) ?? readNumber(asRecord(input.ethCarryPitFeatures?.summary)?.basisSnapshots) ?? readNumber(dataGapCounts?.basisSnapshots),
      carryFeatureRows,
      minCarryFeatureRows,
      dataGapStatus: readString(input.ethCarryDataGapStatus?.status),
      dataGapCollectorErrorCount: collectorErrorCount,
      dataGapCoreSmokeComplete: readBoolean(archiveSummary?.coreSmokeComplete),
      dataGapCoreSmokeArchivesComplete: readNumber(archiveSummary?.coreSmokeArchivesComplete),
      dataGapCoreSmokeArchives: readNumber(archiveSummary?.coreSmokeArchives),
      dataGapFullCatalogComplete: readBoolean(archiveSummary?.fullCatalogComplete),
      dataGapFullCatalogArchivesComplete: readNumber(archiveSummary?.fullCatalogArchivesComplete),
      dataGapFullCatalogArchives: readNumber(archiveSummary?.fullCatalogArchives),
      dataGapCatalogBlockers: dataGapCatalogBlockers.slice(0, 8),
      fundingExplicitAvailableTimeCoveragePct: readNumber(pitEvidence?.fundingExplicitAvailableTimeCoveragePct),
      fundingAvailableTimeStatus: fundingStatus,
      basisAvailableTimeStatus: basisStatus,
      pointInTimeUsableForPromotion: readBoolean(pitEvidence?.pointInTimeUsableForPromotion),
    },
    nextActions: blockers.length === 0
      ? ['Use the PIT carry dataset for research-only prospective evidence; it is not promotion-grade by itself.']
      : ['Fix funding availableAt coverage and basis spread feature generation before carry economics can be trusted.'],
  }
}

function buildEthCarryProspectiveItem(input: Parameters<typeof buildOpenAliceGoalCompletionAuditReport>[0]): OpenAliceGoalCompletionItem {
  const counts = asRecord(input.ethCarryProspectiveEvidence?.counts)
  const metrics = asRecord(input.ethCarryProspectiveEvidence?.metrics)
  const thresholds = asRecord(input.ethCarryProspectiveEvidence?.thresholds)
  const dataGapCounts = asRecord(input.ethCarryDataGapStatus?.counts)
  const closedOutcomes = readNumber(metrics?.closedOutcomes) ?? readNumber(dataGapCounts?.prospectiveClosedOutcomes) ?? 0
  const closedDecisionWindows = readNumber(counts?.closedDecisionWindows) ?? readNumber(dataGapCounts?.prospectiveClosedDecisionWindows) ?? 0
  const minClosedOutcomes = readNumber(thresholds?.minClosedOutcomes) ?? 100
  const minWindows = readNumber(thresholds?.minNonOverlappingWindows) ?? 3
  const meanGross = readNumber(metrics?.meanGrossCarryPairReturnPct)
  const blockers = [
    ...(input.ethCarryProspectiveEvidence ? [] : ['eth_carry_prospective_evidence_missing']),
    ...(closedOutcomes >= minClosedOutcomes ? [] : [`eth_carry_prospective_closed_outcomes_low:${closedOutcomes}<${minClosedOutcomes}`]),
    ...(closedDecisionWindows >= minWindows ? [] : [`eth_carry_prospective_closed_windows_low:${closedDecisionWindows}<${minWindows}`]),
    ...(meanGross != null && meanGross > 0 ? [] : [`eth_carry_prospective_mean_gross_non_positive:${meanGross ?? 'missing'}`]),
    ...readStringArray(input.ethCarryProspectiveEvidence?.blockers).slice(0, 16).map(blocker => `prospective:${blocker}`),
    ...readStringArray(input.ethCarryDataGapStatus?.blockers)
      .filter(blocker => blocker.startsWith('prospective_'))
      .slice(0, 8)
      .map(blocker => `eth_carry_data_gap:${blocker}`),
  ]
  return {
    id: 'eth_carry_prospective_evidence',
    title: 'Funding/carry prospective labels are sufficiently closed and positive after realistic evidence',
    required: true,
    status: !input.ethCarryProspectiveEvidence ? 'missing' : blockers.length === 0 ? 'pass' : 'blocked',
    completionPct: round(Math.min(100, (closedOutcomes / Math.max(1, minClosedOutcomes)) * 70 + (closedDecisionWindows / Math.max(1, minWindows)) * 30), 0),
    evidencePaths: [
      input.sourceArtifacts.ethCarryProspectiveEvidence,
      input.sourceArtifacts.ethCarryResearchEvidence,
      input.sourceArtifacts.ethCarryDataGapStatus,
    ],
    blockers,
    metrics: {
      status: readString(input.ethCarryProspectiveEvidence?.status),
      openEvents: readNumber(counts?.openEvents),
      closedEvents: readNumber(counts?.closedEvents),
      closedOutcomes,
      closedDecisionWindows,
      minClosedOutcomes,
      minNonOverlappingWindows: minWindows,
      meanGrossCarryPairReturnPct: meanGross,
      winRatePct: readNumber(metrics?.winRatePct),
      routeCostAdjustedClosedOutcomes: readNumber(metrics?.routeCostAdjustedClosedOutcomes),
      fundingCashflowAccountedClosedOutcomes: readNumber(metrics?.fundingCashflowAccountedClosedOutcomes),
      dataGapStatus: readString(input.ethCarryDataGapStatus?.status),
      dataGapProspectiveClosedOutcomeShortfall: readNumber(dataGapCounts?.prospectiveClosedOutcomeShortfall),
    },
    nextActions: [
      'Keep capturing and settling carry observations after labelDueTime until at least 100 closed outcomes across 3 non-overlapping windows exist.',
      'Kill or redesign the carry line if prospective gross/net outcomes remain non-positive after enough labels.',
    ],
  }
}

function buildPaperLiveGateItem(input: Parameters<typeof buildOpenAliceGoalCompletionAuditReport>[0]): OpenAliceGoalCompletionItem {
  const reasonCanPromote = readBoolean(input.reasonChain?.canPromote) === true
  const reasonPaperAllowed = readBoolean(input.reasonChain?.paperTradingAllowed) === true
  const reasonLiveAllowed = readBoolean(input.reasonChain?.liveTradingAllowed) === true
  const releasePaperAllowed = readBoolean(input.releaseGateStatus?.allowPaperTrading) === true
  const releaseLiveAllowed = readBoolean(input.releaseGateStatus?.allowLiveTrading) === true
  const paperGateAllowed = readBoolean(input.paperGateStatus?.finalAllowPaperTrading) === true
  const blockers = [
    ...(reasonCanPromote ? [] : ['reason_chain_can_promote_false']),
    ...(releasePaperAllowed ? [] : ['release_gate_paper_trading_not_allowed']),
    ...(paperGateAllowed ? [] : ['paper_gate_final_allow_paper_false']),
    ...(reasonPaperAllowed ? [] : ['reason_chain_paper_trading_not_allowed']),
    ...(reasonLiveAllowed || releaseLiveAllowed ? [] : ['live_trading_not_allowed']),
    ...readStringArray(input.releaseGateStatus?.failedChecks).map(check => `release_gate_failed:${check}`),
    ...readStringArray(input.paperGateStatus?.blockingReasons).slice(0, 16).map(blocker => `paper_gate:${blocker}`),
  ]
  return {
    id: 'paper_live_release_gate_profitability',
    title: 'Strategy profitability and release gates permit paper/live progression',
    required: true,
    status: blockers.length === 0 ? 'pass' : input.reasonChain || input.releaseGateStatus || input.paperGateStatus ? 'blocked' : 'missing',
    completionPct: Math.round(([reasonCanPromote, releasePaperAllowed, paperGateAllowed, reasonPaperAllowed, reasonLiveAllowed || releaseLiveAllowed].filter(Boolean).length / 5) * 100),
    evidencePaths: [
      input.sourceArtifacts.reasonChain,
      input.sourceArtifacts.releaseGateStatus,
      input.sourceArtifacts.paperGateStatus,
    ],
    blockers,
    metrics: {
      effectiveActionability: readString(input.reasonChain?.effectiveActionability),
      overallPlanCompletionPct: readNumber(input.reasonChain?.overallPlanCompletionPct),
      reasonCanPromote,
      reasonPaperAllowed,
      reasonLiveAllowed,
      releasePaperAllowed,
      releaseLiveAllowed,
      paperGateAllowed,
      releaseFailedChecks: readStringArray(input.releaseGateStatus?.failedChecks),
    },
    nextActions: [
      'Do not enable paper/live manually. Earn permission through positive strategy evidence and gate-passing runtime artifacts.',
      'Refresh release gates only after strategy evidence has PIT, WFO, FDR, route-cost/slippage, prospective outcomes, paper telemetry, and risk validation.',
    ],
  }
}

function buildSchedulerSecurityItem(input: Parameters<typeof buildOpenAliceGoalCompletionAuditReport>[0]): OpenAliceGoalCompletionItem {
  const status = readString(input.schedulerSecurityAudit?.status)
  const blockers = [
    ...(input.schedulerSecurityAudit ? [] : ['scheduler_security_audit_missing']),
    ...(status === 'pass' ? [] : [`scheduler_security_status:${status ?? 'missing'}`]),
    ...readRecordArray(input.schedulerSecurityAudit?.findings)
      .filter(finding => readString(finding.severity) === 'fail')
      .map(finding => readString(finding.check) ?? 'unknown_fail_finding')
      .map(check => `scheduler_security:${check}`),
  ]
  return {
    id: 'scheduler_security',
    title: 'Scheduler and diagnostic refresh jobs remain secret-safe and execution-safe',
    required: true,
    status: !input.schedulerSecurityAudit ? 'missing' : blockers.length === 0 ? 'pass' : 'blocked',
    completionPct: blockers.length === 0 ? 100 : 0,
    evidencePaths: [
      input.sourceArtifacts.schedulerSecurityAudit,
    ],
    blockers,
    metrics: {
      status,
      failFindingCount: readRecordArray(input.schedulerSecurityAudit?.findings).filter(finding => readString(finding.severity) === 'fail').length,
    },
    nextActions: blockers.length === 0
      ? ['Keep scheduler audit in the refresh chain; passing scheduler security does not authorize trading.']
      : ['Fix scheduler security findings before relying on automated refresh jobs.'],
  }
}

function buildSafetyInvariantItem(input: Parameters<typeof buildOpenAliceGoalCompletionAuditReport>[0]): OpenAliceGoalCompletionItem {
  const sourceAuthorizationAttempts = [
    input.strategyDefectMonitor,
    input.strategyDefectRegistry,
    input.strategyQualityGateCoverage,
    input.quantFrameworkBenchmark,
    input.ethCarryResearchEvidence,
    input.ethCarryDataGapStatus,
    input.ethCarryProspectiveEvidence,
    input.aiScientistIntake,
    input.aiScientistSourceManifest,
    input.aiScientistSecondValidationQueue,
    input.aiScientistSecondValidationReadiness,
    input.aiScientistPitRebuildQueue,
    input.aiScientistOhlcvNativeRebuildPlan,
    input.aiScientistOhlcvDailySupplementPlan,
    input.aiScientistOhlcvNativeRows,
    input.aiScientistPitNativeRebuildStatus,
    input.aiScientistPitInputDataset,
    input.aiScientistPitContractStatus,
    input.ohlcvCollectorPitContractStatus,
  ].some(source => sourceAuthorizesExecution(source))
  const blockers = [
    ...(sourceAuthorizationAttempts ? ['research_or_diagnostic_artifact_attempts_to_authorize_execution'] : []),
  ]
  return {
    id: 'safety_invariants',
    title: 'Research artifacts cannot bypass paper/live/promotion gates',
    required: true,
    status: blockers.length === 0 ? 'pass' : 'blocked',
    completionPct: blockers.length === 0 ? 100 : 0,
    evidencePaths: [
      input.sourceArtifacts.reasonChain,
      input.sourceArtifacts.strategyDefectMonitor,
      input.sourceArtifacts.strategyDefectRegistry,
      input.sourceArtifacts.strategyQualityGateCoverage,
      input.sourceArtifacts.quantFrameworkBenchmark,
      input.sourceArtifacts.ethCarryResearchEvidence,
      input.sourceArtifacts.aiScientistSecondValidationReadiness,
      input.sourceArtifacts.aiScientistPitNativeRebuildStatus,
      input.sourceArtifacts.ohlcvCollectorPitContractStatus,
      readString(asRecord(input.ohlcvCollectorPitContractStatus?.sourceArtifacts)?.collectorPitRows) ?? DEFAULT_COLLECTOR_PIT_ROWS_PATH,
    ],
    blockers,
    metrics: {
      thisArtifactPromotionEligible: false,
      thisArtifactPaperTradingAllowed: false,
      thisArtifactLiveTradingAllowed: false,
      sourceAuthorizationAttempts,
      reasonChainPaperTradingAllowed: readBoolean(input.reasonChain?.paperTradingAllowed),
      reasonChainLiveTradingAllowed: readBoolean(input.reasonChain?.liveTradingAllowed),
      reasonChainCanPromote: readBoolean(input.reasonChain?.canPromote),
    },
    nextActions: [
      'Keep all research-only and diagnostic artifacts non-authorizing; only release/execution gates may permit paper/live after evidence passes.',
    ],
  }
}

function sourceAuthorizesExecution(source: UnknownRecord | null): boolean {
  if (!source) return false
  return readBoolean(source.promotionEligible) === true ||
    readBoolean(source.promotionAllowed) === true ||
    readBoolean(source.canPromote) === true ||
    readBoolean(source.paperTradingAllowed) === true ||
    readBoolean(source.liveTradingAllowed) === true ||
    readBoolean(source.executionAllowed) === true ||
    readBoolean(source.paperExecutionAllowed) === true ||
    readBoolean(source.liveExecutionAllowed) === true
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next == null || next.startsWith('--')) {
      out.set(key, 'true')
    } else {
      out.set(key, next)
      index += 1
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  return value === 'null' || value === 'none' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase())
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    const text = await readFile(path, 'utf-8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function readRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function renderConsoleSummary(report: OpenAliceGoalCompletionAuditReport): string {
  return [
    `OpenAlice goal completion audit: ${report.status}`,
    `Goal complete: ${report.goalComplete}`,
    `Effective actionability: ${report.effectiveActionability}`,
    `Overall plan completion: ${report.overallPlanCompletionPct ?? 'unknown'}%`,
    `Checklist completion: ${report.goalChecklistCompletionPct}%`,
    `Required blocked/missing: ${report.summary.requiredBlocked}/${report.summary.requiredMissing}`,
    `Paper/live/promote allowed by this artifact: ${report.paperTradingAllowed}/${report.liveTradingAllowed}/${report.promotionEligible}`,
    report.blockers.length > 0 ? `Top blockers:\n${report.blockers.slice(0, 12).map(item => `- ${item}`).join('\n')}` : 'Top blockers: none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
