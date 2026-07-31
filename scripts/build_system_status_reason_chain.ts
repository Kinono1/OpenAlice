import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import type { EvidenceManifest } from '../src/runtime/evidence_manifest.js'
import { readKillSwitch } from '../src/risk/kill-switch.js'
import { computeCurrentSlotId } from '../src/runtime/sidecar_signal.js'
import { DEFAULT_COLLECTOR_PIT_ROWS_PATH } from './lib/ohlcv_collector_pit.js'

const DEFAULT_RUNTIME_DIR = 'data/runtime'
const DEFAULT_OUTPUT_PATH = 'data/runtime/system_status_reason_chain.latest.json'
const DEFAULT_CP_BRIDGE_PATH = '/Users/kino/Files/HFish/CurrencyPurchases/runtime/bridge/openalice_signals.json'
const DEFAULT_CP_TRACE_TAIL_LINES = 200

export interface SystemStatusReasonChainArgs {
  runtimeDir: string
  outputPath: string | null
  cpBridgePath: string
  json: boolean
}

export type ReasonChainStatus =
  | 'available'
  | 'not_available'
  | 'not_available_warmup'
  | 'blocked'
  | 'observation_only'

export interface SystemStatusReason {
  component:
    | 'Live data'
    | 'OKX public connectivity'
    | 'OpenAlice data catalog'
    | 'WFO'
    | 'IC'
    | 'Research incubation'
    | 'Research line retirement'
    | 'Research next hypothesis'
    | 'ETH carry research'
    | 'ETH carry confluence candidate'
    | 'ETH carry data gaps'
    | 'ETH carry prospective watchdog'
    | 'OKX route-cost/slippage readiness'
    | 'AI-Scientist crypto intake'
    | 'AI-Scientist second-validation queue'
    | 'OHLCV collector PIT contract'
    | 'Strategy defect monitor'
    | 'Strategy quality gate coverage'
    | 'Quant framework benchmark'
    | 'Crypto factor family'
    | 'Liquidity-conditioned prospective'
    | 'Scheduler security'
    | 'Goal completion audit'
    | 'Allocator'
    | 'CP bridge'
  status: ReasonChainStatus
  usableForPromotion: boolean
  usableForPaperExecution: boolean
  summary: string
  evidencePaths: string[]
  blockingReasons: string[]
  metrics: Record<string, unknown>
  nextActions: string[]
}

export interface PlanCompletionItem {
  id: string
  title: string
  status: 'done' | 'partial' | 'blocked' | 'not_started'
  completionPct: number
  evidencePaths: string[]
  blockers: string[]
  nextActions: string[]
}

export interface PlanCompletionPhase {
  phase: 'P0' | 'P1' | 'P1.5' | 'P2' | 'P3'
  completionPct: number
  status: 'partial' | 'blocked' | 'not_started'
  items: PlanCompletionItem[]
}

export interface SystemStatusReasonChainReport {
  schemaVersion: 1
  generatedAt: string
  declaredStatus: 'PAPER_ONLY'
  effectiveActionability: 'paper_execution_allowed' | 'paper_execution_blocked' | 'research_only_blocked'
  liveTradingAllowed: false
  paperTradingAllowed: boolean
  canPromote: boolean
  overallPlanCompletionPct: number
  reasonChain: SystemStatusReason[]
  planCompletion: PlanCompletionPhase[]
  sourceArtifacts: Record<string, string>
  governance: {
    promotionAllowedByThisArtifact: false
    liveTradingAllowedByThisArtifact: false
    paperExecutionAllowedByThisArtifact: false
    notes: string[]
  }
  crypto_dl_sidecar: CryptoDlSidecarStatus
  global_exposure: GlobalExposureStatus
  reservation_reconciliation: ReservationReconciliationStatus
  kill_switch: KillSwitchStatus
  drift: DriftStatus
  replay_gate: ReplayGateStatus
  implementation_shortfall: ImplementationShortfallStatus
}

export interface CryptoDlSidecarStatus {
  status: 'present' | 'absent' | 'stale'
  slot_id: string | null
  signals_count: number
  notes?: string[]
}

export interface GlobalExposureStatus {
  lock_held: boolean
  lock_owner: string | null
  gross_exposure_bps: number | null
}

export interface ReservationReconciliationStatus {
  active_reservations: number
  orphan_reservations: number
  last_reconciled_at: string | null
}

export interface KillSwitchStatus {
  state: string
  enabled: boolean
}

export interface DriftStatus {
  monitored_signals: number
  healthy: number
  decayed: number
  blocked: number
}

export interface ReplayGateStatus {
  passed: boolean
  blockers: string[]
}

export interface ImplementationShortfallStatus {
  evidence_count: number
  avg_shortfall_bps: number | null
}

export interface SystemHealthGate {
  name: string
  component: string
  status: 'pass' | 'warning' | 'fail' | 'missing'
  checkedAt: string | null
  detail: string
  evidencePath: string
}

export interface SystemHealthDashboard {
  schemaVersion: number
  generatedAt: string
  overallStatus: 'healthy' | 'degraded' | 'unhealthy'
  gates: SystemHealthGate[]
  summary: { totalGates: number; passed: number; warning: number; blocked: number; missing: number }
}

export function buildSystemHealthDashboard(report: SystemStatusReasonChainReport): SystemHealthDashboard {
  const gates: SystemHealthGate[] = [
    {
      name: 'Kill Switch',
      component: 'risk_management',
      status: report.kill_switch.enabled ? 'fail' : 'pass',
      checkedAt: report.generatedAt,
      detail: report.kill_switch.enabled ? `Active: ${report.kill_switch.state}` : 'Inactive',
      evidencePath: 'data/runtime/KILL_SWITCH.json',
    },
    {
      name: 'Crypto DL Sidecar',
      component: 'signal_production',
      status: report.crypto_dl_sidecar.status === 'present' ? 'pass'
        : report.crypto_dl_sidecar.status === 'stale' ? 'warning' : 'missing',
      checkedAt: report.generatedAt,
      detail: report.crypto_dl_sidecar.status === 'present'
        ? `${report.crypto_dl_sidecar.signals_count} signals`
        : `Status: ${report.crypto_dl_sidecar.status}`,
      evidencePath: 'data/runtime/crypto_dl_sidecar_status.latest.json',
    },
    {
      name: 'Signal Health',
      component: 'model_health',
      status: report.drift.monitored_signals === 0 ? 'missing'
        : report.drift.decayed > report.drift.healthy ? 'fail' : 'pass',
      checkedAt: report.generatedAt,
      detail: `${report.drift.healthy} healthy, ${report.drift.decayed} decayed of ${report.drift.monitored_signals}`,
      evidencePath: 'data/runtime/signal_health.latest.json',
    },
    {
      name: 'Replay Gate',
      component: 'evidence',
      status: report.replay_gate.passed ? 'pass' : 'fail',
      checkedAt: report.generatedAt,
      detail: report.replay_gate.blockers.length > 0
        ? report.replay_gate.blockers.join('; ') : 'All evidence present',
      evidencePath: 'data/runtime/replay_gate.latest.json',
    },
    {
      name: 'Global Exposure',
      component: 'exposure',
      status: report.global_exposure.lock_held ? 'pass' : 'warning',
      checkedAt: report.generatedAt,
      detail: report.global_exposure.lock_held
        ? `Owner: ${report.global_exposure.lock_owner}, gross: ${report.global_exposure.gross_exposure_bps}bps`
        : 'No active lock',
      evidencePath: 'data/runtime/global_exposure_lock/info.json',
    },
    {
      name: 'Implementation Shortfall',
      component: 'execution_quality',
      status: report.implementation_shortfall.evidence_count > 0 ? 'pass' : 'missing',
      checkedAt: report.generatedAt,
      detail: report.implementation_shortfall.evidence_count > 0
        ? `${report.implementation_shortfall.evidence_count} fills, avg=${report.implementation_shortfall.avg_shortfall_bps ?? 'N/A'}bps`
        : 'No evidence',
      evidencePath: 'data/runtime/implementation_shortfall.latest.json',
    },
  ]
  const passed = gates.filter(g => g.status === 'pass').length
  const warning = gates.filter(g => g.status === 'warning').length
  const blocked = gates.filter(g => g.status === 'fail').length
  const missing = gates.filter(g => g.status === 'missing').length
  const overallStatus = blocked > 0 ? 'unhealthy' : (warning + missing > 2 ? 'degraded' : 'healthy')
  return {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    overallStatus,
    gates,
    summary: { totalGates: gates.length, passed, warning, blocked: blocked + missing, missing },
  }
}

type UnknownRecord = Record<string, unknown>
type AllocatorBlockerBucket =
  | 'paper_gate'
  | 'promotion_release'
  | 'paper_quality'
  | 'p1_evidence_trust'
  | 'allocator_state'
  | 'config_disabled'
  | 'other'

export function parseSystemStatusReasonChainArgs(argv: string[]): SystemStatusReasonChainArgs {
  const raw = parseRawArgs(argv)
  return {
    runtimeDir: raw.get('runtimeDir') ?? DEFAULT_RUNTIME_DIR,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    cpBridgePath: raw.get('cpBridgePath') ?? DEFAULT_CP_BRIDGE_PATH,
    json: parseBool(raw.get('json'), false),
  }
}

export async function runSystemStatusReasonChain(
  args: SystemStatusReasonChainArgs,
): Promise<SystemStatusReasonChainReport> {
  const startedAt = new Date()
  const runtimeDir = resolve(args.runtimeDir)
  const sourceArtifacts = buildSourceArtifactPaths(runtimeDir)
  const report = buildSystemStatusReasonChainReport({
    strategyPromotion: await readJsonIfExists(sourceArtifacts.strategyPromotion),
    releaseGateStatus: await readJsonIfExists(sourceArtifacts.releaseGateStatus),
    phaseReadiness: await readJsonIfExists(sourceArtifacts.phaseReadiness),
    paperGateStatus: await readJsonIfExists(sourceArtifacts.paperGateStatus),
    paperExecutorStatus: await readJsonIfExists(sourceArtifacts.paperExecutorStatus),
    p1CostModelDiagnostics: await readJsonIfExists(sourceArtifacts.p1CostModelDiagnostics),
    p1GateEffectiveness: await readJsonIfExists(sourceArtifacts.p1GateEffectiveness),
    p1TrialLedger: await readJsonIfExists(sourceArtifacts.p1TrialLedger),
    p1StoplossRiskPolicy: await readJsonIfExists(sourceArtifacts.p1StoplossRiskPolicy),
    productionRiskPolicy: await readJsonIfExists(sourceArtifacts.productionRiskPolicy),
    liveDataFreshness: await readJsonIfExists(sourceArtifacts.liveDataFreshness),
    okxPublicConnectivityDiagnosis: await readJsonIfExists(sourceArtifacts.okxPublicConnectivityDiagnosis),
    okxPrivateAuthDiagnosis: await readJsonIfExists(sourceArtifacts.okxPrivateAuthDiagnosis),
    runtimeFeeSnapshotRefresh: await readJsonIfExists(sourceArtifacts.feeSnapshotRefresh),
    openAliceDataCatalog: await readJsonIfExists(sourceArtifacts.openAliceDataCatalog),
    openAliceDownloadMonitor: await readJsonIfExists(sourceArtifacts.openAliceDownloadMonitor),
    metaLabelingShadowReadiness: await readJsonIfExists(sourceArtifacts.metaLabelingShadowReadiness),
    researchIncubationPlan: await readJsonIfExists(sourceArtifacts.researchIncubationPlan),
    researchLineRetirement: await readJsonIfExists(sourceArtifacts.researchLineRetirement),
    nextResearchHypothesisPlan: await readJsonIfExists(sourceArtifacts.nextResearchHypothesisPlan),
    ethCarryResearchEvidenceStatus: await readJsonIfExists(sourceArtifacts.ethCarryResearchEvidenceStatus),
    ethCarrySignalDiagnostics: await readJsonIfExists(sourceArtifacts.ethCarrySignalDiagnostics),
    ethCarryConfluenceCandidateStatus: await readJsonIfExists(sourceArtifacts.ethCarryConfluenceCandidateStatus),
    ethCarryConfluenceValidation: await readJsonIfExists(sourceArtifacts.ethCarryConfluenceValidation),
    ethCarryConfluenceTrialStatus: await readJsonIfExists(sourceArtifacts.ethCarryConfluenceTrialStatus),
    ethCarryConfluenceRefinementSweep: await readJsonIfExists(sourceArtifacts.ethCarryConfluenceRefinementSweep),
    ethCarryDataGapStatus: await readJsonIfExists(sourceArtifacts.ethCarryDataGapStatus),
    ethCarryProspectiveWatchdog: await readJsonIfExists(sourceArtifacts.ethCarryProspectiveWatchdog),
    okxRouteCostSlippageReadiness: await readJsonIfExists(sourceArtifacts.okxRouteCostSlippageReadiness),
    aiScientistCryptoCandidateIntake: await readJsonIfExists(sourceArtifacts.aiScientistCryptoCandidateIntake),
    aiScientistSecondValidationQueue: await readJsonIfExists(sourceArtifacts.aiScientistSecondValidationQueue),
    aiScientistCandidateSourceManifest: await readJsonIfExists(sourceArtifacts.aiScientistCandidateSourceManifest),
    aiScientistSecondValidationReadiness: await readJsonIfExists(sourceArtifacts.aiScientistSecondValidationReadiness),
    aiScientistPitReproductionPlan: await readJsonIfExists(sourceArtifacts.aiScientistPitReproductionPlan),
    aiScientistPitRebuildQueue: await readJsonIfExists(sourceArtifacts.aiScientistPitRebuildQueue),
    aiScientistOhlcvNativeRebuildPlan: await readJsonIfExists(sourceArtifacts.aiScientistOhlcvNativeRebuildPlan),
    aiScientistOhlcvDailySupplementPlan: await readJsonIfExists(sourceArtifacts.aiScientistOhlcvDailySupplementPlan),
    aiScientistOhlcvNativeRows: await readJsonIfExists(sourceArtifacts.aiScientistOhlcvNativeRows),
    aiScientistPitNativeRebuildStatus: await readJsonIfExists(sourceArtifacts.aiScientistPitNativeRebuildStatus),
    aiScientistPitInputDataset: await readJsonIfExists(sourceArtifacts.aiScientistPitInputDataset),
    aiScientistPitContractStatus: await readJsonIfExists(sourceArtifacts.aiScientistPitContractStatus),
    ohlcvCollectorPitContractStatus: await readJsonIfExists(sourceArtifacts.ohlcvCollectorPitContractStatus),
    strategyDefectMonitor: await readJsonIfExists(sourceArtifacts.strategyDefectMonitor),
    strategyDefectRegistry: await readJsonIfExists(sourceArtifacts.strategyDefectRegistry),
    strategyQualityGateCoverage: await readJsonIfExists(sourceArtifacts.strategyQualityGateCoverage),
    quantFrameworkBenchmarkReport: await readJsonIfExists(sourceArtifacts.quantFrameworkBenchmarkReport),
    researchCandidateSummary: await readJsonIfExists(sourceArtifacts.researchCandidateSummary),
    cryptoFactorFamilyReport: await readJsonIfExists(sourceArtifacts.cryptoFactorFamilyReport),
    prospectiveEvidenceStatus: await readJsonIfExists(sourceArtifacts.prospectiveEvidenceStatus),
    liquidityConditionedProspectiveEvidenceStatus: await readJsonIfExists(sourceArtifacts.liquidityConditionedProspectiveEvidenceStatus),
    icMonitorStatus: await readJsonIfExists(sourceArtifacts.icRuntimeStatus),
    dirtyWorktreeAudit: await readJsonIfExists(sourceArtifacts.dirtyWorktreeAudit),
    runtimeManifestCoverage: await readJsonIfExists(sourceArtifacts.runtimeManifestCoverage),
    externalDerivativesCollect: await readJsonIfExists(sourceArtifacts.externalDerivativesCollect),
    paperPolicyShadowSettle: await readJsonIfExists(sourceArtifacts.paperPolicyShadowSettle),
    schedulerSecurityAudit: await readJsonIfExists(sourceArtifacts.schedulerSecurityAudit),
    goalCompletionAudit: await readJsonIfExists(sourceArtifacts.goalCompletionAudit),
    cpBridge: await readJsonIfExists(resolve(args.cpBridgePath)),
    cpTraceLines: readTailLinesIfExists(sourceArtifacts.cpTrace, DEFAULT_CP_TRACE_TAIL_LINES),
    cryptoDlSidecarRaw: await readJsonIfExists(sourceArtifacts.cryptoDlSidecarStatus),
    globalExposureDirPath: resolve(runtimeDir, 'global_exposure.lock'),
    signalHealthRaw: await readJsonIfExists(sourceArtifacts.signalHealthStatus),
    replayGateRaw: await readJsonIfExists(sourceArtifacts.replayGateStatus),
    implementationShortfallRaw: await readJsonIfExists(sourceArtifacts.implementationShortfallStatus),
    sourceArtifacts: {
      ...sourceArtifacts,
      cpBridge: resolve(args.cpBridgePath),
    },
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'system_status_reason_chain',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.canPromote ? 'pass' : 'warn',
      recordsIn: report.reasonChain.length,
      recordsOut: report.planCompletion.reduce((sum, phase) => sum + phase.items.length, 0),
      errorClass: report.canPromote ? null : 'system_status_blocked',
    })
  }

  // Write health dashboard
  const dashboard = buildSystemHealthDashboard(report)
  const dashboardPath = resolve(args.runtimeDir, 'system_health_dashboard.latest.json')
  await mkdir(dirname(dashboardPath), { recursive: true })
  await writeFile(dashboardPath, `${JSON.stringify(dashboard, null, 2)}\n`, 'utf-8')

  return report
}

export function buildSystemStatusReasonChainReport(input: {
  strategyPromotion?: unknown
  releaseGateStatus?: unknown
  phaseReadiness?: unknown
  paperGateStatus?: unknown
  paperExecutorStatus?: unknown
  p1CostModelDiagnostics?: unknown
  p1GateEffectiveness?: unknown
  p1TrialLedger?: unknown
  p1StoplossRiskPolicy?: unknown
  productionRiskPolicy?: unknown
  liveDataFreshness?: unknown
  okxPublicConnectivityDiagnosis?: unknown
  okxPrivateAuthDiagnosis?: unknown
  runtimeFeeSnapshotRefresh?: unknown
  openAliceDataCatalog?: unknown
  openAliceDownloadMonitor?: unknown
  metaLabelingShadowReadiness?: unknown
  researchIncubationPlan?: unknown
  researchLineRetirement?: unknown
  nextResearchHypothesisPlan?: unknown
  ethCarryResearchEvidenceStatus?: unknown
  ethCarrySignalDiagnostics?: unknown
  ethCarryConfluenceCandidateStatus?: unknown
  ethCarryConfluenceValidation?: unknown
  ethCarryConfluenceTrialStatus?: unknown
  ethCarryConfluenceRefinementSweep?: unknown
  ethCarryDataGapStatus?: unknown
  ethCarryProspectiveWatchdog?: unknown
  okxRouteCostSlippageReadiness?: unknown
  aiScientistCryptoCandidateIntake?: unknown
  aiScientistSecondValidationQueue?: unknown
  aiScientistCandidateSourceManifest?: unknown
  aiScientistSecondValidationReadiness?: unknown
  aiScientistPitReproductionPlan?: unknown
  aiScientistPitRebuildQueue?: unknown
  aiScientistOhlcvNativeRebuildPlan?: unknown
  aiScientistOhlcvDailySupplementPlan?: unknown
  aiScientistOhlcvNativeRows?: unknown
  aiScientistPitNativeRebuildStatus?: unknown
  aiScientistPitInputDataset?: unknown
  aiScientistPitContractStatus?: unknown
  ohlcvCollectorPitContractStatus?: unknown
  strategyDefectMonitor?: unknown
  strategyDefectRegistry?: unknown
  strategyQualityGateCoverage?: unknown
  quantFrameworkBenchmarkReport?: unknown
  researchCandidateSummary?: unknown
  cryptoFactorFamilyReport?: unknown
  prospectiveEvidenceStatus?: unknown
  liquidityConditionedProspectiveEvidenceStatus?: unknown
  icMonitorStatus?: unknown
  dirtyWorktreeAudit?: unknown
  runtimeManifestCoverage?: unknown
  externalDerivativesCollect?: unknown
  paperPolicyShadowSettle?: unknown
  schedulerSecurityAudit?: unknown
  goalCompletionAudit?: unknown
  cpBridge?: unknown
  cpTraceLines?: string[]
  cryptoDlSidecarRaw?: unknown
  globalExposureDirPath?: string
  signalHealthRaw?: unknown
  replayGateRaw?: unknown
  implementationShortfallRaw?: unknown
  sourceArtifacts?: Record<string, string>
  generatedAt?: string
}): SystemStatusReasonChainReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const strategyPromotion = asRecord(input.strategyPromotion)
  const releaseGateStatus = asRecord(input.releaseGateStatus)
  const phaseReadiness = asRecord(input.phaseReadiness)
  const paperGateStatus = asRecord(input.paperGateStatus)
  const paperExecutorStatus = asRecord(input.paperExecutorStatus)
  const p1CostModelDiagnostics = asRecord(input.p1CostModelDiagnostics)
  const p1GateEffectiveness = asRecord(input.p1GateEffectiveness)
  const p1TrialLedger = asRecord(input.p1TrialLedger)
  const p1StoplossRiskPolicy = asRecord(input.p1StoplossRiskPolicy)
  const productionRiskPolicy = asRecord(input.productionRiskPolicy)
  const liveDataFreshness = asRecord(input.liveDataFreshness)
  const okxPublicConnectivityDiagnosis = asRecord(input.okxPublicConnectivityDiagnosis)
  const okxPrivateAuthDiagnosis = asRecord(input.okxPrivateAuthDiagnosis)
  const runtimeFeeSnapshotRefresh = asRecord(input.runtimeFeeSnapshotRefresh)
  const openAliceDataCatalog = asRecord(input.openAliceDataCatalog)
  const openAliceDownloadMonitor = asRecord(input.openAliceDownloadMonitor)
  const metaLabelingShadowReadiness = asRecord(input.metaLabelingShadowReadiness)
  const researchIncubationPlan = asRecord(input.researchIncubationPlan)
  const researchLineRetirement = asRecord(input.researchLineRetirement)
  const nextResearchHypothesisPlan = asRecord(input.nextResearchHypothesisPlan)
  const ethCarryResearchEvidenceStatus = asRecord(input.ethCarryResearchEvidenceStatus)
  const ethCarrySignalDiagnostics = asRecord(input.ethCarrySignalDiagnostics)
  const ethCarryConfluenceCandidateStatus = asRecord(input.ethCarryConfluenceCandidateStatus)
  const ethCarryConfluenceValidation = asRecord(input.ethCarryConfluenceValidation)
  const ethCarryConfluenceTrialStatus = asRecord(input.ethCarryConfluenceTrialStatus)
  const ethCarryConfluenceRefinementSweep = asRecord(input.ethCarryConfluenceRefinementSweep)
  const ethCarryDataGapStatus = asRecord(input.ethCarryDataGapStatus)
  const ethCarryProspectiveWatchdog = asRecord(input.ethCarryProspectiveWatchdog)
  const okxRouteCostSlippageReadiness = asRecord(input.okxRouteCostSlippageReadiness)
  const aiScientistCryptoCandidateIntake = asRecord(input.aiScientistCryptoCandidateIntake)
  const aiScientistSecondValidationQueue = asRecord(input.aiScientistSecondValidationQueue)
  const aiScientistCandidateSourceManifest = asRecord(input.aiScientistCandidateSourceManifest)
  const aiScientistSecondValidationReadiness = asRecord(input.aiScientistSecondValidationReadiness)
  const aiScientistPitReproductionPlan = asRecord(input.aiScientistPitReproductionPlan)
  const aiScientistPitRebuildQueue = asRecord(input.aiScientistPitRebuildQueue)
  const aiScientistOhlcvNativeRebuildPlan = asRecord(input.aiScientistOhlcvNativeRebuildPlan)
  const aiScientistOhlcvDailySupplementPlan = asRecord(input.aiScientistOhlcvDailySupplementPlan)
  const aiScientistOhlcvNativeRows = asRecord(input.aiScientistOhlcvNativeRows)
  const aiScientistPitNativeRebuildStatus = asRecord(input.aiScientistPitNativeRebuildStatus)
  const aiScientistPitInputDataset = asRecord(input.aiScientistPitInputDataset)
  const aiScientistPitContractStatus = asRecord(input.aiScientistPitContractStatus)
  const ohlcvCollectorPitContractStatus = asRecord(input.ohlcvCollectorPitContractStatus)
  const strategyDefectMonitor = asRecord(input.strategyDefectMonitor)
  const strategyDefectRegistry = asRecord(input.strategyDefectRegistry)
  const strategyQualityGateCoverage = asRecord(input.strategyQualityGateCoverage)
  const quantFrameworkBenchmarkReport = asRecord(input.quantFrameworkBenchmarkReport)
  const researchCandidateSummary = asRecord(input.researchCandidateSummary)
  const cryptoFactorFamilyReport = asRecord(input.cryptoFactorFamilyReport)
  const prospectiveEvidenceStatus = asRecord(input.prospectiveEvidenceStatus)
  const liquidityConditionedProspectiveEvidenceStatus = asRecord(input.liquidityConditionedProspectiveEvidenceStatus)
  const dirtyWorktreeAudit = asRecord(input.dirtyWorktreeAudit)
  const runtimeManifestCoverage = asRecord(input.runtimeManifestCoverage)
  const externalDerivativesCollect = asRecord(input.externalDerivativesCollect)
  const paperPolicyShadowSettle = asRecord(input.paperPolicyShadowSettle)
  const schedulerSecurityAudit = asRecord(input.schedulerSecurityAudit)
  const goalCompletionAudit = asRecord(input.goalCompletionAudit)
  const cpBridge = asRecord(input.cpBridge)
  const sourceArtifacts = input.sourceArtifacts ?? buildSourceArtifactPaths(DEFAULT_RUNTIME_DIR)

  // --- v5 plan aggregation states ---
  const cryptoDlSidecarRaw = asRecord(input.cryptoDlSidecarRaw)
  const crypto_dl_sidecar: CryptoDlSidecarStatus = (() => {
    if (!cryptoDlSidecarRaw) return { status: 'absent', slot_id: null, signals_count: 0, notes: [] }
    const ready = readBoolean(cryptoDlSidecarRaw.ready)
    const rawSlotId = readString(cryptoDlSidecarRaw.slot_id) ?? null
    const currentSlot = computeCurrentSlotId(new Date())
    const notes: string[] = []
    if (rawSlotId && rawSlotId !== currentSlot) {
      notes.push(`slot_id ${rawSlotId} does not match current slot ${currentSlot}`)
    }
    if (ready === true) {
      return { status: 'present', slot_id: rawSlotId, signals_count: readNumber(cryptoDlSidecarRaw.signals_count) ?? 0, notes }
    }
    return { status: 'stale', slot_id: rawSlotId, signals_count: readNumber(cryptoDlSidecarRaw.signals_count) ?? 0, notes }
  })()

  const globalExposureInfo: GlobalExposureStatus = (() => {
    const dirPath = input.globalExposureDirPath
    if (!dirPath || !existsSync(dirPath)) return { lock_held: false, lock_owner: null, gross_exposure_bps: null }
    try {
      const info = JSON.parse(readFileSync(resolve(dirPath, 'info.json'), 'utf-8'))
      const record = asRecord(info)
      return {
        lock_held: true,
        lock_owner: readString(record?.lock_owner) ?? null,
        gross_exposure_bps: readNumber(record?.gross_exposure_bps) ?? null,
      }
    } catch {
      return { lock_held: false, lock_owner: null, gross_exposure_bps: null }
    }
  })()

  const ks = readKillSwitch()
  const kill_switch: KillSwitchStatus = {
    state: ks?.state ?? 'normal',
    enabled: ks?.enabled ?? false,
  }

  const signalHealthRaw = asRecord(input.signalHealthRaw)
  const drift: DriftStatus = {
    monitored_signals: readNumber(signalHealthRaw?.monitored_signals) ?? 0,
    healthy: readNumber(signalHealthRaw?.healthy) ?? 0,
    decayed: readNumber(signalHealthRaw?.decayed) ?? 0,
    blocked: readNumber(signalHealthRaw?.blocked) ?? 0,
  }

  const replayGateRaw = asRecord(input.replayGateRaw)
  const replay_gate: ReplayGateStatus = {
    passed: readBoolean(replayGateRaw?.passed) === true,
    blockers: readStringArray(replayGateRaw?.blockers),
  }

  const implShortfallRaw = asRecord(input.implementationShortfallRaw)
  const implementation_shortfall: ImplementationShortfallStatus = {
    evidence_count: readNumber(implShortfallRaw?.evidence_count) ?? 0,
    avg_shortfall_bps: readNumber(implShortfallRaw?.avg_shortfall_bps) ?? null,
  }

  const reasonChain = [
    buildLiveDataReason(liveDataFreshness, sourceArtifacts),
    buildOkxPublicConnectivityReason(okxPublicConnectivityDiagnosis, sourceArtifacts),
    buildOpenAliceDataCatalogReason(openAliceDataCatalog, openAliceDownloadMonitor, sourceArtifacts),
    buildWfoReason(releaseGateStatus, strategyPromotion, sourceArtifacts),
    buildIcReason(asRecord(input.icMonitorStatus), sourceArtifacts),
    buildResearchIncubationReason(
      researchIncubationPlan,
      researchCandidateSummary,
      prospectiveEvidenceStatus,
      liquidityConditionedProspectiveEvidenceStatus,
      okxPrivateAuthDiagnosis,
      runtimeFeeSnapshotRefresh,
      sourceArtifacts,
    ),
    buildResearchLineRetirementReason(researchLineRetirement, sourceArtifacts),
    buildNextResearchHypothesisReason(nextResearchHypothesisPlan, sourceArtifacts),
    buildEthCarryResearchReason(
      ethCarryResearchEvidenceStatus,
      ethCarrySignalDiagnostics,
      ethCarryDataGapStatus,
      runtimeFeeSnapshotRefresh,
      okxPrivateAuthDiagnosis,
      sourceArtifacts,
    ),
    buildEthCarryConfluenceCandidateReason(
      ethCarryConfluenceCandidateStatus,
      ethCarryConfluenceValidation,
      ethCarryConfluenceTrialStatus,
      ethCarryConfluenceRefinementSweep,
      sourceArtifacts,
    ),
    buildEthCarryDataGapReason(ethCarryDataGapStatus, sourceArtifacts),
    buildEthCarryProspectiveWatchdogReason(ethCarryProspectiveWatchdog, sourceArtifacts),
    buildOkxRouteCostSlippageReadinessReason(okxRouteCostSlippageReadiness, sourceArtifacts),
    buildAiScientistCryptoIntakeReason(aiScientistCryptoCandidateIntake, sourceArtifacts),
    buildAiScientistSecondValidationQueueReason(
      aiScientistSecondValidationQueue,
      aiScientistCandidateSourceManifest,
      aiScientistSecondValidationReadiness,
      aiScientistPitReproductionPlan,
      aiScientistPitRebuildQueue,
      aiScientistOhlcvNativeRebuildPlan,
      aiScientistOhlcvDailySupplementPlan,
      aiScientistOhlcvNativeRows,
      aiScientistPitNativeRebuildStatus,
      aiScientistPitInputDataset,
      aiScientistPitContractStatus,
      sourceArtifacts,
    ),
    buildOhlcvCollectorPitContractReason(ohlcvCollectorPitContractStatus, sourceArtifacts),
    buildStrategyDefectMonitorReason(strategyDefectMonitor, strategyDefectRegistry, sourceArtifacts),
    buildStrategyQualityGateCoverageReason(strategyQualityGateCoverage, sourceArtifacts),
    buildQuantFrameworkBenchmarkReason(quantFrameworkBenchmarkReport, sourceArtifacts),
    buildCryptoFactorFamilyReason(
      cryptoFactorFamilyReport,
      runtimeFeeSnapshotRefresh,
      sourceArtifacts,
    ),
    buildLiquidityConditionedProspectiveReason(
      liquidityConditionedProspectiveEvidenceStatus,
      runtimeFeeSnapshotRefresh,
      sourceArtifacts,
    ),
    buildSchedulerSecurityReason(schedulerSecurityAudit, sourceArtifacts),
    buildGoalCompletionAuditReason(goalCompletionAudit, sourceArtifacts),
    buildAllocatorReason(paperGateStatus, paperExecutorStatus, phaseReadiness, productionRiskPolicy, sourceArtifacts),
    buildCpBridgeReason(cpBridge, input.cpTraceLines ?? [], sourceArtifacts, generatedAt),
  ]
  const planCompletion = buildPlanCompletion({
    strategyPromotion,
    releaseGateStatus,
    paperGateStatus,
    paperExecutorStatus,
    p1CostModelDiagnostics,
    p1GateEffectiveness,
    p1TrialLedger,
    p1StoplossRiskPolicy,
    metaLabelingShadowReadiness,
    prospectiveEvidenceStatus,
    dirtyWorktreeAudit,
    runtimeManifestCoverage,
    externalDerivativesCollect,
    paperPolicyShadowSettle,
    sourceArtifacts,
  })
  const paperTradingAllowed = readBoolean(paperGateStatus?.finalAllowPaperTrading) === true
  const canPromote = readBoolean(strategyPromotion?.canPromote) === true ||
    readString(strategyPromotion?.finalVerdict) === 'promoted'

  return {
    schemaVersion: 1,
    generatedAt,
    declaredStatus: 'PAPER_ONLY',
    effectiveActionability: paperTradingAllowed
      ? 'paper_execution_allowed'
      : reasonChain.some(reason => reason.status === 'blocked' || reason.status === 'not_available')
        ? 'research_only_blocked'
        : 'paper_execution_blocked',
    liveTradingAllowed: false,
    paperTradingAllowed,
    canPromote,
    overallPlanCompletionPct: weightedPlanCompletion(planCompletion),
    reasonChain,
    planCompletion,
    sourceArtifacts,
    governance: {
      promotionAllowedByThisArtifact: false,
      liveTradingAllowedByThisArtifact: false,
      paperExecutionAllowedByThisArtifact: false,
      notes: [
        'This artifact explains status only; it cannot authorize paper orders, live orders, leverage changes, or promotion.',
        'A pass here is not a profitability claim. Promotion still requires release gate, P1 evidence, dirty-worktree trust, and prospective validation artifacts.',
        'PAPER_ONLY means live trading remains forbidden. In the current blocked state, paper execution can also be disabled by release and evidence gates.',
      ],
    },
    crypto_dl_sidecar,
    global_exposure: globalExposureInfo,
    reservation_reconciliation: {
      active_reservations: 0,
      orphan_reservations: 0,
      last_reconciled_at: null,
    },
    kill_switch,
    drift,
    replay_gate,
    implementation_shortfall,
  }
}

function buildLiveDataReason(
  liveDataFreshness: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!liveDataFreshness) {
    return {
      component: 'Live data',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No live public market-data freshness audit artifact is present.',
      evidencePaths: [
        sourceArtifacts.liveDataFreshness,
        'data/market/live_accumulated',
        'data/market/live_5m',
        'data/market/live_1s',
      ],
      blockingReasons: ['live_data_freshness_audit_missing'],
      metrics: {
        status: null,
        publicDataUsableForLiveOnlyResearch: false,
      },
      nextActions: [
        'Run corepack pnpm data:freshness:audit after public OKX data accumulation.',
        'Continue public OKX data accumulation before relying on live-only research diagnostics.',
      ],
    }
  }

  const status = readString(liveDataFreshness.status)
  const summary = asRecord(liveDataFreshness.summary)
  const directories = Array.isArray(liveDataFreshness.directories)
    ? liveDataFreshness.directories.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const blockers = readStringArray(liveDataFreshness.blockers)
  const publicDataUsable = readBoolean(summary?.publicDataUsableForLiveOnlyResearch) === true
  const allFresh = status === 'fresh'
  const reasonStatus: ReasonChainStatus = allFresh
    ? 'available'
    : publicDataUsable
      ? 'observation_only'
      : 'blocked'

  return {
    component: 'Live data',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: allFresh
      ? 'Public OKX market-data storage is fresh for live-only research, but it does not authorize execution.'
      : publicDataUsable
        ? `Public OKX market-data storage is usable for research with gaps: status=${status ?? 'missing'}.`
        : `Public OKX market-data storage is not ready for live-only research: status=${status ?? 'missing'}.`,
    evidencePaths: [
      sourceArtifacts.liveDataFreshness,
      'data/market/live_accumulated',
      'data/market/live_5m',
      'data/market/live_1s',
    ],
    blockingReasons: uniqueStrings([
      ...(readBoolean(liveDataFreshness.promotionAllowed) === true ||
        readBoolean(liveDataFreshness.paperTradingAllowed) === true ||
        readBoolean(liveDataFreshness.liveTradingAllowed) === true
        ? ['live_data_freshness_artifact_must_not_authorize_execution']
        : []),
      ...blockers.slice(0, 20).map(reason => `live_data:${reason}`),
      ...(status === 'fresh' ? ['live_data_fresh_but_execution_still_requires_strategy_gates'] : []),
    ]),
    metrics: {
      status,
      publicDataUsableForLiveOnlyResearch: publicDataUsable,
      expectedAssets: readNumber(summary?.expectedAssets),
      presentAssets: readNumber(summary?.presentAssets),
      freshAssets: readNumber(summary?.freshAssets),
      enoughRowsAssets: readNumber(summary?.enoughRowsAssets),
      oneHourCommonPeriods: readNumber(summary?.oneHourCommonPeriods),
      oneHourCommonLatestDatetime: readString(summary?.oneHourCommonLatestDatetime),
      oneHourIncubationCommonPeriodsReady: readBoolean(summary?.oneHourIncubationCommonPeriodsReady),
      directoryStatuses: directories.map(directory => ({
        timeframe: readString(directory.timeframe),
        status: readString(directory.status),
        presentAssets: readNumber(directory.presentAssets),
        expectedAssets: readNumber(directory.expectedAssets),
        freshAssets: readNumber(directory.freshAssets),
        commonPeriods: readNumber(directory.commonPeriods),
        commonLatestDatetime: readString(directory.commonLatestDatetime),
        incubationCommonPeriodsReady: readBoolean(directory.incubationCommonPeriodsReady),
      })),
    },
    nextActions: readStringArray(liveDataFreshness.globalNextActions).length > 0
      ? readStringArray(liveDataFreshness.globalNextActions)
      : [
          'Keep OKX public data accumulation scheduled.',
          'Rerun strategy diagnostics after 1h live data refreshes.',
        ],
  }
}

function buildOkxPublicConnectivityReason(
  okxPublicConnectivityDiagnosis: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!okxPublicConnectivityDiagnosis) {
    return {
      component: 'OKX public connectivity',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No OKX public connectivity diagnosis artifact is present.',
      evidencePaths: [
        sourceArtifacts.okxPublicConnectivityDiagnosis,
        'scripts/diagnose_okx_public_connectivity.ts',
        'src/domain/market-data/live-fetcher.ts',
      ],
      blockingReasons: [
        'okx_public_connectivity_diagnosis_missing',
        'okx_public_endpoint_reachability_not_audited',
      ],
      metrics: {
        status: null,
        publicDataFetchable: null,
      },
      nextActions: [
        'Run npm run data:okx-public:diagnose to separate stale local files from OKX endpoint/proxy reachability failures.',
        'Keep data refresh blocked until at least one OKX public host is reachable.',
      ],
    }
  }

  const status = readString(okxPublicConnectivityDiagnosis.status)
  const publicDataFetchable = readBoolean(okxPublicConnectivityDiagnosis.publicDataFetchable) === true
  const blockers = readStringArray(okxPublicConnectivityDiagnosis.blockers)
  const proxy = asRecord(okxPublicConnectivityDiagnosis.proxy)
  const attempts = Array.isArray(okxPublicConnectivityDiagnosis.attempts)
    ? okxPublicConnectivityDiagnosis.attempts.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const failedAttempts = attempts.filter(attempt => readBoolean(attempt.ok) !== true)
  const artifactAllowsExecution =
    readBoolean(okxPublicConnectivityDiagnosis.promotionAllowed) === true ||
    readBoolean(okxPublicConnectivityDiagnosis.paperTradingAllowed) === true ||
    readBoolean(okxPublicConnectivityDiagnosis.liveTradingAllowed) === true
  const reasonStatus: ReasonChainStatus = publicDataFetchable
    ? 'available'
    : status === 'blocked'
      ? 'blocked'
      : 'not_available'

  return {
    component: 'OKX public connectivity',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: publicDataFetchable
      ? 'At least one OKX public endpoint is reachable for data collection; this does not authorize execution.'
      : `OKX public endpoint connectivity is blocked across ${attempts.length} configured host(s).`,
    evidencePaths: [
      sourceArtifacts.okxPublicConnectivityDiagnosis,
      'scripts/diagnose_okx_public_connectivity.ts',
      'src/domain/market-data/live-fetcher.ts',
    ],
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['okx_public_connectivity_artifact_must_not_authorize_execution'] : []),
      ...(status ? [`okx_public_connectivity_status:${status}`] : ['okx_public_connectivity_status_missing']),
      ...blockers.slice(0, 16).map(blocker => `okx_public_connectivity:${blocker}`),
    ]),
    metrics: {
      status,
      researchOnly: readBoolean(okxPublicConnectivityDiagnosis.researchOnly),
      diagnosticOnly: readBoolean(okxPublicConnectivityDiagnosis.diagnosticOnly),
      publicDataFetchable,
      proxyConfigured: readBoolean(proxy?.configured),
      proxyProtocol: readString(proxy?.protocol),
      proxyHostname: readString(proxy?.hostname),
      proxyPort: readString(proxy?.port),
      proxyHasUsername: readBoolean(proxy?.hasUsername),
      proxyHasPassword: readBoolean(proxy?.hasPassword),
      hosts: readStringArray(okxPublicConnectivityDiagnosis.hosts),
      attempts: attempts.length,
      successfulHosts: attempts
        .filter(attempt => readBoolean(attempt.ok) === true)
        .map(attempt => readString(attempt.hostname))
        .filter((item): item is string => item != null),
      failedHosts: failedAttempts
        .map(attempt => readString(attempt.hostname))
        .filter((item): item is string => item != null),
      failedErrorClasses: uniqueStrings(
        failedAttempts
          .map(attempt => readString(attempt.errorClass))
          .filter((item): item is string => item != null),
      ),
    },
    nextActions: readStringArray(okxPublicConnectivityDiagnosis.nextActions).length > 0
      ? readStringArray(okxPublicConnectivityDiagnosis.nextActions)
      : [
          'Check local proxy reachability and OKX domain access, then rerun data:okx-public:diagnose.',
          'Refresh public data only after a public endpoint is reachable.',
        ],
  }
}

function buildOpenAliceDataCatalogReason(
  openAliceDataCatalog: UnknownRecord | null,
  openAliceDownloadMonitor: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!openAliceDataCatalog) {
    return {
      component: 'OpenAlice data catalog',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No OpenAlice multi-source data catalog artifact is present.',
      evidencePaths: [
        sourceArtifacts.openAliceDataCatalog,
        resolve(process.env.OPENALICE_DATA_ROOT ?? 'data'),
        '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl',
        'scripts/build_openalice_data_catalog.ts',
      ],
      blockingReasons: [
        'openalice_data_catalog_missing',
        'multi_source_data_acceptance_not_visible_in_reason_chain',
      ],
      metrics: {
        status: null,
        datasets: null,
        complete: null,
      },
      nextActions: [
        'Run npm run data:warehouse:catalog to refresh the multi-source data inventory.',
        'Keep the catalog blocked until raw, normalized, audit, runtime, and derived PIT feature inputs are all covered.',
      ],
    }
  }

  const status = readString(openAliceDataCatalog.status)
  const summary = asRecord(openAliceDataCatalog.summary)
  const coverage = asRecord(openAliceDataCatalog.objectiveCoverage)
  const blockerActionability = asRecord(openAliceDataCatalog.blockerActionability)
  const blockerCategories = Array.isArray(blockerActionability?.categories)
    ? blockerActionability.categories.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const primaryBlockerCategory = readString(blockerActionability?.primaryCategory)
  const primaryBlockerCount = primaryBlockerCategory
    ? blockerCategoryCount(blockerCategories, primaryBlockerCategory)
    : null
  const downloadMonitorStatus = readString(openAliceDownloadMonitor?.status)
  const downloadMonitorTotals = asRecord(openAliceDownloadMonitor?.totals)
  const downloadMonitorCatalog = asRecord(openAliceDownloadMonitor?.dataCatalog)
  const downloadMonitorBinanceAudit = asRecord(openAliceDownloadMonitor?.binanceAudit)
  const downloadMonitorActiveProcesses = Array.isArray(openAliceDownloadMonitor?.activeProcesses)
    ? openAliceDownloadMonitor.activeProcesses.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const downloadMonitorActiveDatasets = Array.isArray(downloadMonitorBinanceAudit?.activeDatasets)
    ? downloadMonitorBinanceAudit.activeDatasets.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const downloadMonitorNextIncompleteDatasets = Array.isArray(downloadMonitorBinanceAudit?.nextIncompleteDatasets)
    ? downloadMonitorBinanceAudit.nextIncompleteDatasets.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const downloadMonitorBlockers = readStringArray(openAliceDownloadMonitor?.blockers)
  const activeDownloadDatasetIds = uniqueStrings([
    ...downloadMonitorActiveDatasets.map(dataset => readString(dataset.id)).filter((item): item is string => item != null),
    ...downloadMonitorActiveProcesses.map(process => readString(process.id)).filter((item): item is string => item != null),
  ])
  const nextIncompleteDownloadDatasetIds = downloadMonitorNextIncompleteDatasets
    .map(dataset => readString(dataset.id))
    .filter((item): item is string => item != null)
  const blockers = readStringArray(openAliceDataCatalog.blockers)
  const datasets = Array.isArray(openAliceDataCatalog.datasets)
    ? openAliceDataCatalog.datasets.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const aiScientistDataset = datasets.find(dataset => readString(dataset.datasetId) === 'ai-scientist:crypto-dl:candidate-runs') ?? null
  const aiScientistQuality = asRecord(aiScientistDataset?.quality)
  const aiScientistBlockers = readStringArray(aiScientistDataset?.blockers)
  const reasonStatus: ReasonChainStatus = status === 'complete'
    ? 'available'
    : status === 'blocked'
      ? 'blocked'
      : 'not_available'

  return {
    component: 'OpenAlice data catalog',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: status === 'complete'
      ? 'OpenAlice data catalog is complete, but trading still requires strategy release gates.'
      : `OpenAlice data catalog is blocked: ${readNumber(summary?.complete) ?? 0}/${readNumber(summary?.datasets) ?? 0} dataset(s) complete${primaryBlockerCategory ? `; primary blocker=${primaryBlockerCategory}${primaryBlockerCount != null ? ` (${primaryBlockerCount})` : ''}` : ''}.`,
    evidencePaths: [
      sourceArtifacts.openAliceDataCatalog,
      sourceArtifacts.openAliceDownloadMonitor,
      sourceArtifacts.aiScientistCryptoCandidateIntake,
      readString(openAliceDataCatalog.warehouseRoot) ?? resolve(process.env.OPENALICE_DATA_ROOT ?? 'data'),
      '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl',
      'scripts/build_openalice_data_catalog.ts',
    ],
    blockingReasons: uniqueStrings([
      ...(status ? [`openalice_data_catalog_status:${status}`] : ['openalice_data_catalog_status_missing']),
      ...(openAliceDownloadMonitor ? [] : ['openalice_download_monitor_missing']),
      ...(downloadMonitorStatus && downloadMonitorStatus !== 'complete' ? [`openalice_download_monitor_status:${downloadMonitorStatus}`] : []),
      ...downloadMonitorBlockers.slice(0, 8).map(blocker => `openalice_download_monitor:${blocker}`),
      ...blockers.slice(0, 32).map(blocker => `openalice_data_catalog:${blocker}`),
      ...aiScientistBlockers.slice(0, 12).map(blocker => `openalice_data_catalog_ai_scientist:${blocker}`),
      'openalice_data_catalog_does_not_authorize_execution',
    ]),
    metrics: {
      status,
      warehouseRoot: readString(openAliceDataCatalog.warehouseRoot),
      repoDataRoot: readString(openAliceDataCatalog.repoDataRoot),
      aiScientistRoot: readString(openAliceDataCatalog.aiScientistRoot),
      datasets: readNumber(summary?.datasets),
      complete: readNumber(summary?.complete),
      partial: readNumber(summary?.partial),
      missing: readNumber(summary?.missing),
      inProgress: readNumber(summary?.inProgress),
      needsRetry: readNumber(summary?.needsRetry),
      failed: readNumber(summary?.failed),
      rawDatasets: readNumber(summary?.rawDatasets),
      normalizedDatasets: readNumber(summary?.normalizedDatasets),
      auditDatasets: readNumber(summary?.auditDatasets),
      runtimeDatasets: readNumber(summary?.runtimeDatasets),
      verifiedBinancePublicDatasets: readNumber(summary?.verifiedBinancePublicDatasets),
      plannedBinancePublicDatasets: readNumber(summary?.plannedBinancePublicDatasets),
      dataCatalogTotalBlockers: readNumber(blockerActionability?.totalBlockers),
      dataCatalogPrimaryBlockerCategory: primaryBlockerCategory,
      dataCatalogDownloadGapBlockers: blockerCategoryCount(blockerCategories, 'download_gap'),
      dataCatalogPitOrNormalizedGapBlockers: blockerCategoryCount(blockerCategories, 'pit_or_normalized_gap'),
      dataCatalogAiScientistValidationGateBlockers: blockerCategoryCount(blockerCategories, 'ai_scientist_validation_gate'),
      dataCatalogDerivativesAuditGapBlockers: blockerCategoryCount(blockerCategories, 'derivatives_audit_gap'),
      dataCatalogAssetMetadataGapBlockers: blockerCategoryCount(blockerCategories, 'asset_metadata_gap'),
      dataCatalogManifestOrTrustGapBlockers: blockerCategoryCount(blockerCategories, 'manifest_or_trust_gap'),
      dataCatalogResumeContractGapBlockers: blockerCategoryCount(blockerCategories, 'resume_contract_gap'),
      downloadMonitorStatus,
      downloadMonitorTrackedDatasets: readNumber(downloadMonitorTotals?.trackedDatasets),
      downloadMonitorCompleteDatasets: readNumber(downloadMonitorTotals?.completeDatasets),
      downloadMonitorIncompleteDatasets: readNumber(downloadMonitorTotals?.incompleteDatasets),
      downloadMonitorZipFiles: readNumber(downloadMonitorTotals?.zipFiles),
      downloadMonitorPartFiles: readNumber(downloadMonitorTotals?.partFiles),
      downloadMonitorCatalogDownloadGapBlockers: readNumber(downloadMonitorCatalog?.downloadGapBlockers),
      downloadMonitorCatalogPitOrNormalizedGapBlockers: readNumber(downloadMonitorCatalog?.pitOrNormalizedGapBlockers),
      downloadMonitorBinanceCompleteDatasets: readNumber(downloadMonitorBinanceAudit?.completeDatasets),
      downloadMonitorBinanceIncompleteDatasets: readNumber(downloadMonitorBinanceAudit?.incompleteDatasets),
      downloadMonitorBinanceZipFiles: readNumber(downloadMonitorBinanceAudit?.zipFiles),
      downloadMonitorBinancePartFiles: readNumber(downloadMonitorBinanceAudit?.partFiles),
      downloadMonitorActiveProcessCount: downloadMonitorActiveProcesses.length,
      downloadMonitorActiveDatasetIds: activeDownloadDatasetIds,
      downloadMonitorNextIncompleteDatasetIds: nextIncompleteDownloadDatasetIds,
      observedFamilies: readStringArray(coverage?.observedFamilies),
      observedLayers: readStringArray(coverage?.observedLayers),
      observedGranularities: readStringArray(coverage?.timeGranularitiesObserved),
      aiScientistCandidateDatasetPresent: readBoolean(aiScientistDataset?.present),
      aiScientistCandidateDatasetStatus: readString(aiScientistDataset?.status),
      aiScientistCandidateCount: readNumber(aiScientistQuality?.targetSymbols),
      aiScientistCandidateSummaryPresent: readBoolean(aiScientistQuality?.summaryPresent),
    },
    nextActions: readStringArray(openAliceDownloadMonitor?.nextActions).length > 0
      ? readStringArray(openAliceDownloadMonitor?.nextActions)
      : readStringArray(openAliceDataCatalog.nextActions).length > 0
        ? readStringArray(openAliceDataCatalog.nextActions)
      : [
          'Continue warehouse backfills, normalization, manifests, and PIT feature snapshots.',
          'Keep AI-Scientist outputs research-only until OpenAlice independently validates them.',
        ],
  }
}

function blockerCategoryCount(categories: UnknownRecord[], category: string): number | null {
  const match = categories.find(item => readString(item.category) === category)
  return readNumber(match?.count)
}

function buildWfoReason(
  releaseGateStatus: UnknownRecord | null,
  strategyPromotion: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  const wfoCheck = findCheck(releaseGateStatus, 'wfo')
  const researchGate = asRecord(strategyPromotion?.researchGate)
  const researchBlocks = readStringArray(researchGate?.hardBlocks)
  const status = readString(wfoCheck?.status)
  const metrics = asRecord(wfoCheck?.metrics)
  const failedWindows = readNumber(metrics?.failedWindows)
  const windowCount = readNumber(metrics?.windowCount)
  const failedWindowRatio = readNumber(metrics?.failedWindowRatio)
  const failWindowRatioThreshold = readNumber(metrics?.failWindowRatioThreshold)
  const failedWindowRatioOverThreshold =
    failedWindowRatio != null && failWindowRatioThreshold != null
      ? failedWindowRatio > failWindowRatioThreshold
      : null
  const blocked = status !== 'pass'
  return {
    component: 'WFO',
    status: blocked ? 'not_available' : 'available',
    usableForPromotion: !blocked,
    usableForPaperExecution: !blocked,
    summary: blocked
      ? 'WFO is not usable: current release/research evidence is missing or failed.'
      : 'WFO passed the current release gate.',
    evidencePaths: [sourceArtifacts.releaseGateStatus, sourceArtifacts.strategyPromotion],
    blockingReasons: [
      ...(status ? [`release_gate_wfo_status:${status}`] : ['release_gate_wfo_check_missing']),
      ...researchBlocks.filter(reason => reason.includes('wfo')).map(reason => `research:${reason}`),
    ],
    metrics: {
      summary: readString(wfoCheck?.summary),
      overallPassed: readBoolean(metrics?.overallPassed),
      failureMode: !wfoCheck
        ? 'missing_check'
        : status === 'pass'
          ? 'pass'
          : failedWindowRatioOverThreshold
            ? 'failed_by_window_ratio'
            : 'failed_or_incomplete',
      passedWindows: failedWindows != null && windowCount != null
        ? Math.max(0, windowCount - failedWindows)
        : null,
      failedWindows,
      windowCount,
      failedWindowRatio,
      failWindowRatioThreshold,
      failedWindowRatioOverThreshold,
      averageDegradation: readNumber(metrics?.averageDegradation),
      failAverageDegradationThreshold: readNumber(metrics?.failAverageDegradationThreshold),
    },
    nextActions: blocked
      ? [
          'Generate a clean manifest-backed WFO report for the active candidate.',
          'Require failedWindowRatio <= configured threshold and non-degraded out-of-sample windows before promotion.',
          'Refresh release_gate_status.json and promotion:v2 after WFO is regenerated.',
        ]
      : ['Keep WFO window definitions locked before any prospective comparison.'],
  }
}

function buildIcReason(icMonitorStatus: UnknownRecord | null, sourceArtifacts: Record<string, string>): SystemStatusReason {
  const status = readString(icMonitorStatus?.status)
  const promotionEligible = readBoolean(icMonitorStatus?.promotionEligible) === true
  const blockingReasons = readStringArray(icMonitorStatus?.blockingReasons)
  const sampleCountTotal = readNumber(icMonitorStatus?.sampleCountTotal)
  const minimumSampleCount = readNumber(icMonitorStatus?.minimumSampleCount)
  const warmupWindowsObserved = readNumber(icMonitorStatus?.warmupWindowsObserved)
  const warmupWindowsRequired = readNumber(icMonitorStatus?.warmupWindowsRequired)
  const decaySummary = summarizeIcDecay(blockingReasons)
  if (icMonitorStatus) {
    return {
      component: 'IC',
      status: promotionEligible ? 'available' : status === 'warmup' ? 'not_available_warmup' : 'not_available',
      usableForPromotion: promotionEligible,
      usableForPaperExecution: promotionEligible,
      summary: promotionEligible
        ? 'IC runtime artifact is ready, but promotion still depends on the global release and P1/P2 gates.'
        : `IC runtime artifact is not promotion-grade: status=${status ?? 'missing'}.`,
      evidencePaths: [
        sourceArtifacts.icRuntimeStatus,
        'src/domain/strategy/factors/ic-monitor.ts',
      ],
      blockingReasons,
      metrics: {
        status,
        promotionEligible,
        sampleCountTotal,
        returnCount: readNumber(icMonitorStatus.returnCount),
        factorCount: readNumber(icMonitorStatus.factorCount),
        minimumSampleCount,
        sampleThresholdPassed: sampleCountTotal != null && minimumSampleCount != null
          ? sampleCountTotal >= minimumSampleCount
          : null,
        warmupWindowsRequired,
        warmupWindowsObserved,
        warmupThresholdPassed: warmupWindowsObserved != null && warmupWindowsRequired != null
          ? warmupWindowsObserved >= warmupWindowsRequired
          : null,
        decayedFactorCount: decaySummary.decayedFactorCount,
        decayedSymbolCount: decaySummary.decayedSymbolCount,
        decayedPairCount: decaySummary.decayedPairCount,
        decayedSymbols: decaySummary.decayedSymbols,
        decayedFactors: decaySummary.decayedFactors,
      },
      nextActions: readStringArray(icMonitorStatus.nextActions).length > 0
        ? readStringArray(icMonitorStatus.nextActions)
        : [
            'Persist IC monitor snapshots and refresh ic_monitor_status.latest.json.',
            'Keep IC in shadow until sample and warmup thresholds are met.',
          ],
    }
  }
  return {
    component: 'IC',
    status: 'not_available_warmup',
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: 'IC evidence is not promotion-grade yet: no runtime IC status artifact is present.',
    evidencePaths: [
      'src/domain/strategy/factors/ic-monitor.ts',
      sourceArtifacts.icRuntimeStatus,
    ],
    blockingReasons: [
      'ic_monitor_status_artifact_missing',
      'ic_monitor_default_mode:shadow',
      'ic_requires_minSampleCount:50',
      'ic_requires_warmupWindows:3',
    ],
    metrics: {
      mode: 'shadow',
      minSamples: 20,
      minSampleCount: 50,
      warmupWindows: 3,
      autoDisable: false,
    },
    nextActions: [
      'Persist an IC runtime snapshot with factor/signal pairs, realized returns, sampleCount, horizon count, IC, ICIR, and sign stability.',
      'Keep IC in shadow until sampleCount >= 50 and at least 3 warmup windows are populated.',
      'Block promotion if IC artifact is missing, stale, or dirty-quarantined.',
    ],
  }
}

function buildResearchIncubationReason(
  researchIncubationPlan: UnknownRecord | null,
  researchCandidateSummary: UnknownRecord | null,
  prospectiveEvidenceStatus: UnknownRecord | null,
  liquidityConditionedProspectiveEvidenceStatus: UnknownRecord | null,
  okxPrivateAuthDiagnosis: UnknownRecord | null,
  runtimeFeeSnapshotRefresh: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  const planStatus = readString(researchIncubationPlan?.planStatus)
  const promotionAllowed = readBoolean(researchIncubationPlan?.promotionAllowed) === true
  const paperTradingAllowed = readBoolean(researchIncubationPlan?.paperTradingAllowed) === true
  const liveTradingAllowed = readBoolean(researchIncubationPlan?.liveTradingAllowed) === true
  const candidates = Array.isArray(researchIncubationPlan?.candidates)
    ? researchIncubationPlan.candidates.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const primary = candidates[0] ?? null
  const primaryMetrics = asRecord(primary?.metrics)
  const primaryFee = asRecord(primary?.feeSnapshot)
  const requirements = Array.isArray(primary?.promotionRequirements)
    ? primary.promotionRequirements.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const blockedRequirements = requirements
    .filter(requirement => readString(requirement.status) === 'blocked')
    .map(requirement => readString(requirement.code))
    .filter((item): item is string => item != null)
  const blockerReasons = requirements
    .map(requirement => readString(requirement.blocker))
    .filter((item): item is string => item != null)
  const okxAuthStatus = readString(okxPrivateAuthDiagnosis?.status)
  const okxAuthBlockers = readStringArray(okxPrivateAuthDiagnosis?.blockers)
  const runtimeFeeStatus = readString(runtimeFeeSnapshotRefresh?.status)
  const runtimeFeeBlockers = readStringArray(runtimeFeeSnapshotRefresh?.blockers)
  const runtimeFeeErrors = Array.isArray(runtimeFeeSnapshotRefresh?.errors)
    ? runtimeFeeSnapshotRefresh.errors.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const prospectiveStatus = readString(prospectiveEvidenceStatus?.status)
  const prospectiveCounts = asRecord(prospectiveEvidenceStatus?.counts)
  const prospectiveMetrics = asRecord(prospectiveEvidenceStatus?.metrics)
  const prospectiveLatestOpen = asRecord(prospectiveEvidenceStatus?.latestOpen)
  const prospectiveThresholds = asRecord(prospectiveEvidenceStatus?.thresholds)
  const prospectiveBlockers = readStringArray(prospectiveEvidenceStatus?.blockers)
  const liquidityConditionedProspective = asRecord(liquidityConditionedProspectiveEvidenceStatus)
  const liquidityConditionedProspectiveCounts = asRecord(liquidityConditionedProspective?.counts)
  const liquidityConditionedProspectiveMetrics = asRecord(liquidityConditionedProspective?.metrics)
  const liquidityConditionedProspectiveLatestOpen = asRecord(liquidityConditionedProspective?.latestOpen)
  const liquidityConditionedProspectiveBlockers = readStringArray(liquidityConditionedProspectiveEvidenceStatus?.blockers)
  const liquidityPivot = readLiquidityConditionedPivot(researchCandidateSummary)
  const lineDecision = asRecord(researchIncubationPlan?.lineDecision)
  const lineDecisionHardBlockers = readStringArray(lineDecision?.hardBlockers)
  const rejectedDiagnostics = Array.isArray(researchIncubationPlan?.rejectedDiagnostics)
    ? researchIncubationPlan.rejectedDiagnostics.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const topRejectedDiagnostic = rejectedDiagnostics[0] ?? null
  const hasCandidate = primary != null

  if (!researchIncubationPlan) {
    return {
      component: 'Research incubation',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No research incubation plan artifact is present.',
      evidencePaths: [
        sourceArtifacts.researchIncubationPlan,
        sourceArtifacts.researchCandidateSummary,
        sourceArtifacts.prospectiveEvidenceStatus,
        sourceArtifacts.liquidityConditionedProspectiveEvidenceStatus,
        sourceArtifacts.okxPrivateAuthDiagnosis,
        sourceArtifacts.feeSnapshotRefresh,
      ],
      blockingReasons: uniqueStrings([
        'research_incubation_plan_missing',
        ...prospectiveBlockers.slice(0, 12).map(reason => `prospective_evidence:${reason}`),
        ...runtimeFeeBlockers.slice(0, 8).map(reason => `runtime_fee:${reason}`),
      ]),
      metrics: {
        planStatus: null,
        incubationCandidatesFound: 0,
        runtimeFeeSnapshotRefreshStatus: runtimeFeeStatus,
        runtimeFeeSnapshotWritten: readBoolean(runtimeFeeSnapshotRefresh?.snapshotWritten),
        runtimeFeeStatusWritten: readBoolean(runtimeFeeSnapshotRefresh?.statusWritten),
        runtimeFeePerSymbolFees: Array.isArray(runtimeFeeSnapshotRefresh?.perSymbolFees)
          ? runtimeFeeSnapshotRefresh.perSymbolFees.length
          : null,
        prospectiveEvidenceStatus: prospectiveStatus,
        prospectiveOpenEvents: readNumber(prospectiveCounts?.openEvents),
        prospectiveClosedEvents: readNumber(prospectiveCounts?.closedEvents),
        prospectiveClosedOutcomes: readNumber(prospectiveMetrics?.closedOutcomes),
        liquidityConditionedProspectiveStatus: readString(liquidityConditionedProspective?.status),
        liquidityConditionedProspectiveOpenEvents: readNumber(liquidityConditionedProspectiveCounts?.openEvents),
        liquidityConditionedProspectiveClosedEvents: readNumber(liquidityConditionedProspectiveCounts?.closedEvents),
        liquidityConditionedProspectiveOpenDecisionWindows: readNumber(liquidityConditionedProspectiveCounts?.openDecisionWindows),
        liquidityConditionedProspectiveClosedDecisionWindows: readNumber(liquidityConditionedProspectiveCounts?.closedDecisionWindows),
        liquidityConditionedProspectiveClosedOutcomes: readNumber(liquidityConditionedProspectiveMetrics?.closedOutcomes),
        liquidityConditionedProspectiveMeanOpenEventsPerDecisionWindow: readNumber(
          liquidityConditionedProspectiveMetrics?.meanOpenEventsPerDecisionWindow,
        ),
        liquidityConditionedPivotPresent: liquidityPivot != null,
        liquidityConditionedPivotCandidateId: liquidityPivot?.candidateId ?? null,
        liquidityConditionedPivotNetAfterRouteCostPct: liquidityPivot?.netAfterRouteCostPct ?? null,
        liquidityConditionedPivotWfoStatus: liquidityPivot?.wfoStatus ?? null,
        liquidityConditionedPivotFailedWindowRatio: liquidityPivot?.failedWindowRatio ?? null,
      },
      nextActions: [
        'Run research:incubation-plan after route-cost diagnostics so positive money-smells are tracked without enabling execution.',
        'Run research:cross-sectional:prospective-evidence:status so future-only research observations remain visible.',
      ],
    }
  }

  return {
    component: 'Research incubation',
    status: hasCandidate ? 'observation_only' : 'not_available',
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: hasCandidate
      ? `Research incubation target is ${readString(primary.candidateId) ?? 'unknown'}; it is diagnostic-only and blocked from execution.`
      : topRejectedDiagnostic
        ? `Research incubation has no active line; top rejected diagnostic is ${readString(topRejectedDiagnostic.candidateId) ?? 'unknown'} reason=${readString(topRejectedDiagnostic.reason) ?? 'unknown'}.`
        : `Research incubation has no active positive route-cost candidate: status=${planStatus ?? 'missing'}.`,
    evidencePaths: [
      sourceArtifacts.researchIncubationPlan,
      sourceArtifacts.researchCandidateSummary,
      sourceArtifacts.prospectiveEvidenceStatus,
      sourceArtifacts.liquidityConditionedProspectiveEvidenceStatus,
      sourceArtifacts.okxPrivateAuthDiagnosis,
      sourceArtifacts.feeSnapshotRefresh,
    ],
    blockingReasons: uniqueStrings([
      ...(promotionAllowed || paperTradingAllowed || liveTradingAllowed
        ? ['research_incubation_artifact_must_not_authorize_execution']
        : []),
      ...(prospectiveEvidenceStatus && (
        readBoolean(prospectiveEvidenceStatus.promotionEligible) === true ||
        readBoolean(prospectiveEvidenceStatus.paperTradingAllowed) === true ||
        readBoolean(prospectiveEvidenceStatus.liveTradingAllowed) === true
      )
        ? ['prospective_evidence_artifact_must_not_authorize_execution']
        : []),
      ...blockedRequirements.map(code => `incubation_requirement_blocked:${code}`),
      ...blockerReasons.map(reason => `incubation:${reason}`),
      ...lineDecisionHardBlockers.map(reason => `line_decision:${reason}`),
      ...(liquidityPivot ? [
        `liquidity_conditioned_pivot:${liquidityPivot.candidateId}`,
        ...(liquidityPivot.wfoStatus && liquidityPivot.wfoStatus !== 'pass'
          ? [`liquidity_conditioned_wfo_status:${liquidityPivot.wfoStatus}`]
          : []),
        ...(liquidityPivot.failedWindowRatio != null && liquidityPivot.failedWindowRatio > 0.3
          ? [`liquidity_conditioned_wfo_failed_window_ratio:${round(liquidityPivot.failedWindowRatio, 6)}>0.3`]
          : []),
        ...liquidityPivot.blockers.slice(0, 8).map(reason => `liquidity_conditioned:${reason}`),
      ] : ['liquidity_conditioned_pivot_missing']),
      ...(prospectiveEvidenceStatus ? [] : ['prospective_evidence_status_missing']),
      ...(liquidityConditionedProspectiveEvidenceStatus ? [] : ['liquidity_conditioned_prospective_evidence_status_missing']),
      ...prospectiveBlockers.slice(0, 12).map(reason => `prospective_evidence:${reason}`),
      ...liquidityConditionedProspectiveBlockers.slice(0, 12).map(reason => `liquidity_conditioned_prospective:${reason}`),
      ...(runtimeFeeSnapshotRefresh ? [] : ['runtime_fee_snapshot_refresh_missing']),
      ...(runtimeFeeStatus === 'blocked' ? ['runtime_fee_snapshot_blocked'] : []),
      ...runtimeFeeBlockers.slice(0, 8).map(reason => `runtime_fee:${reason}`),
      ...(okxAuthStatus === 'blocked' ? ['okx_private_auth_blocked'] : []),
      ...okxAuthBlockers.slice(0, 8).map(reason => `okx_auth:${reason}`),
    ]),
    metrics: {
      planStatus,
      incubationCandidatesFound: readNumber(researchIncubationPlan.incubationCandidatesFound) ?? candidates.length,
      rejectedDiagnosticsFound: rejectedDiagnostics.length,
      topRejectedCandidateId: readString(topRejectedDiagnostic?.candidateId),
      topRejectedReason: readString(topRejectedDiagnostic?.reason),
      topRejectedNetAfterRouteCostPct: readNumber(topRejectedDiagnostic?.netAfterRouteCostPct),
      topRejectedKillTriggers: readStringArray(topRejectedDiagnostic?.killTriggers),
      routeCostDiagnosticsFound: readNumber(researchIncubationPlan.routeCostDiagnosticsFound),
      promotionAllowed,
      paperTradingAllowed,
      liveTradingAllowed,
      primaryCandidateId: readString(primary?.candidateId),
      primaryRoute: readString(primary?.route),
      primaryNetAfterRouteCostPct: readNumber(primaryMetrics?.netAfterRouteCostPct),
      primaryGrossToPairCostRatio: readNumber(primaryMetrics?.grossToPairCostRatio),
      primarySignalPeriods: readNumber(primaryMetrics?.signalPeriods),
      primaryCommonPeriods: readNumber(primaryMetrics?.commonPeriods),
      primaryWfoStatus: readString(primaryMetrics?.wfoStatus),
      primaryWfoPassedWindows: readNumber(primaryMetrics?.wfoPassedWindows),
      primaryWfoFailedWindows: readNumber(primaryMetrics?.wfoFailedWindows),
      primaryWfoFailedWindowRatio: readNumber(primaryMetrics?.wfoFailedWindowRatio),
      primaryWfoFailWindowRatioThreshold: readNumber(primaryMetrics?.wfoFailWindowRatioThreshold),
      primaryWfoDirectionStable: readBoolean(primaryMetrics?.wfoDirectionStable),
      lineHealth: readString(lineDecision?.lineHealth),
      killTriggers: readStringArray(lineDecision?.killTriggers),
      primaryFeeSource: readString(primaryFee?.source),
      primaryFeeVerifiedByRuntime: readBoolean(primaryFee?.verifiedByRuntime),
      candidateSummaryRowsFound: readNumber(researchCandidateSummary?.candidateRowsFound),
      liquidityConditionedPivotPresent: liquidityPivot != null,
      liquidityConditionedPivotCandidateId: liquidityPivot?.candidateId ?? null,
      liquidityConditionedPivotStrategy: liquidityPivot?.strategy ?? null,
      liquidityConditionedPivotNetAfterRouteCostPct: liquidityPivot?.netAfterRouteCostPct ?? null,
      liquidityConditionedPivotWfoStatus: liquidityPivot?.wfoStatus ?? null,
      liquidityConditionedPivotFailedWindowRatio: liquidityPivot?.failedWindowRatio ?? null,
      liquidityConditionedPivotSignalPeriods: liquidityPivot?.signalPeriods ?? null,
      liquidityConditionedPivotCommonPeriods: liquidityPivot?.commonPeriods ?? null,
      runtimeFeeSnapshotRefreshStatus: runtimeFeeStatus,
      runtimeFeeSnapshotWritten: readBoolean(runtimeFeeSnapshotRefresh?.snapshotWritten),
      runtimeFeeStatusWritten: readBoolean(runtimeFeeSnapshotRefresh?.statusWritten),
      runtimeFeeExchange: readString(runtimeFeeSnapshotRefresh?.exchange),
      runtimeFeeMarketType: readString(runtimeFeeSnapshotRefresh?.marketType),
      runtimeFeeSymbolCount: Array.isArray(runtimeFeeSnapshotRefresh?.symbols)
        ? runtimeFeeSnapshotRefresh.symbols.length
        : null,
      runtimeFeePerSymbolFees: Array.isArray(runtimeFeeSnapshotRefresh?.perSymbolFees)
        ? runtimeFeeSnapshotRefresh.perSymbolFees.length
        : null,
      runtimeFeeErrorClasses: uniqueStrings(
        runtimeFeeErrors
          .map(error => readString(error.errorClass))
          .filter((item): item is string => item != null),
      ),
      prospectiveEvidenceStatus: prospectiveStatus,
      prospectiveOpenEvents: readNumber(prospectiveCounts?.openEvents),
      prospectiveClosedEvents: readNumber(prospectiveCounts?.closedEvents),
      prospectivePendingOpenEvents: readNumber(prospectiveCounts?.pendingOpenEvents),
      prospectiveDueOpenEventsWithoutClose: readNumber(prospectiveCounts?.dueOpenEventsWithoutClose),
      prospectiveClosedOutcomes: readNumber(prospectiveMetrics?.closedOutcomes),
      prospectiveMeanGrossLongShortSpreadPct: readNumber(prospectiveMetrics?.meanGrossLongShortSpreadPct),
      prospectiveWinRatePct: readNumber(prospectiveMetrics?.winRatePct),
      prospectiveMinClosedOutcomes: readNumber(prospectiveThresholds?.minClosedOutcomes),
      prospectiveMinNonOverlappingWindows: readNumber(prospectiveThresholds?.minNonOverlappingWindows),
      prospectiveLatestOpenSignalPair: readString(prospectiveLatestOpen?.signalPair),
      prospectiveLatestOpenDecisionTime: readString(prospectiveLatestOpen?.decisionTime),
      prospectiveLatestOpenLabelDueTime: readString(prospectiveLatestOpen?.labelDueTime),
      liquidityConditionedProspectiveStatus: readString(liquidityConditionedProspective?.status),
      liquidityConditionedProspectiveOpenEvents: readNumber(liquidityConditionedProspectiveCounts?.openEvents),
      liquidityConditionedProspectiveClosedEvents: readNumber(liquidityConditionedProspectiveCounts?.closedEvents),
      liquidityConditionedProspectivePendingOpenEvents: readNumber(liquidityConditionedProspectiveCounts?.pendingOpenEvents),
      liquidityConditionedProspectiveDueOpenEventsWithoutClose: readNumber(
        liquidityConditionedProspectiveCounts?.dueOpenEventsWithoutClose,
      ),
      liquidityConditionedProspectiveOpenDecisionWindows: readNumber(liquidityConditionedProspectiveCounts?.openDecisionWindows),
      liquidityConditionedProspectiveClosedDecisionWindows: readNumber(liquidityConditionedProspectiveCounts?.closedDecisionWindows),
      liquidityConditionedProspectiveClosedOutcomes: readNumber(liquidityConditionedProspectiveMetrics?.closedOutcomes),
      liquidityConditionedProspectiveMeanOpenEventsPerDecisionWindow: readNumber(
        liquidityConditionedProspectiveMetrics?.meanOpenEventsPerDecisionWindow,
      ),
      liquidityConditionedProspectiveLatestOpenDecisionTime: readString(liquidityConditionedProspectiveLatestOpen?.decisionTime),
      liquidityConditionedProspectiveLatestOpenLabelDueTime: readString(liquidityConditionedProspectiveLatestOpen?.labelDueTime),
      okxPrivateAuthStatus: okxAuthStatus,
      okxPrivateAuthBestMode: readString(okxPrivateAuthDiagnosis?.bestMode),
      okxPrivateAuthCredentialPresence: asRecord(okxPrivateAuthDiagnosis?.credentialPresence),
      blockedRequirementCodes: blockedRequirements,
    },
    nextActions: readStringArray(researchIncubationPlan.globalNextActions).length > 0
      ? readStringArray(researchIncubationPlan.globalNextActions)
      : [
          'Keep collecting live-only data for the selected diagnostic candidate.',
          'Fix runtime fee evidence before using route-cost economics for promotion.',
        ],
  }
}

function buildLiquidityConditionedProspectiveReason(
  liquidityConditionedProspectiveEvidenceStatus: UnknownRecord | null,
  runtimeFeeSnapshotRefresh: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  const status = readString(liquidityConditionedProspectiveEvidenceStatus?.status)
  const counts = asRecord(liquidityConditionedProspectiveEvidenceStatus?.counts)
  const metrics = asRecord(liquidityConditionedProspectiveEvidenceStatus?.metrics)
  const thresholds = asRecord(liquidityConditionedProspectiveEvidenceStatus?.thresholds)
  const latestOpen = asRecord(liquidityConditionedProspectiveEvidenceStatus?.latestOpen)
  const latestClosed = asRecord(liquidityConditionedProspectiveEvidenceStatus?.latestClosed)
  const blockers = readStringArray(liquidityConditionedProspectiveEvidenceStatus?.blockers)
  const notes = readStringArray(liquidityConditionedProspectiveEvidenceStatus?.notes)
  const runtimeFeeStatus = readString(runtimeFeeSnapshotRefresh?.status)
  const runtimeFeeBlockers = readStringArray(runtimeFeeSnapshotRefresh?.blockers)
  const openEvents = readNumber(counts?.openEvents) ?? 0
  const closedEvents = readNumber(counts?.closedEvents) ?? 0
  const openDecisionWindows = readNumber(counts?.openDecisionWindows) ?? 0
  const closedDecisionWindows = readNumber(counts?.closedDecisionWindows) ?? 0
  const meanOpenEventsPerDecisionWindow = readNumber(metrics?.meanOpenEventsPerDecisionWindow)
  const artifactAllowsExecution =
    readBoolean(liquidityConditionedProspectiveEvidenceStatus?.paperTradingAllowed) === true ||
    readBoolean(liquidityConditionedProspectiveEvidenceStatus?.liveTradingAllowed) === true ||
    readBoolean(liquidityConditionedProspectiveEvidenceStatus?.promotionEligible) === true

  if (!liquidityConditionedProspectiveEvidenceStatus) {
    return {
      component: 'Liquidity-conditioned prospective',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No liquidity-conditioned prospective evidence artifact is present.',
      evidencePaths: [
        sourceArtifacts.liquidityConditionedProspectiveEvidenceStatus,
        sourceArtifacts.feeSnapshotRefresh,
      ],
      blockingReasons: uniqueStrings([
        'liquidity_conditioned_prospective_evidence_status_missing',
        ...(runtimeFeeSnapshotRefresh ? [] : ['runtime_fee_snapshot_refresh_missing']),
        ...(runtimeFeeStatus === 'blocked' ? ['runtime_fee_snapshot_blocked'] : []),
        ...runtimeFeeBlockers.slice(0, 8).map(reason => `runtime_fee:${reason}`),
      ]),
      metrics: {
        status: null,
        openEvents: 0,
        closedEvents: 0,
        openDecisionWindows: 0,
        closedDecisionWindows: 0,
        meanOpenEventsPerDecisionWindow: null,
        runtimeFeeSnapshotRefreshStatus: runtimeFeeStatus,
        runtimeFeeSnapshotWritten: readBoolean(runtimeFeeSnapshotRefresh?.snapshotWritten),
      },
      nextActions: [
        'Run research:liquidity-conditioned:prospective-observation:capture to start observation-only evidence collection.',
        'Keep the artifact research-only until route-cost-adjusted labels and promotion gates are available.',
      ],
    }
  }

  return {
    component: 'Liquidity-conditioned prospective',
    status: status === 'blocked_no_ledger' ? 'not_available' : 'observation_only',
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: `Liquidity-conditioned prospective is ${status ?? 'missing'}: ${openEvents} open events across ${openDecisionWindows} decision windows; ${closedEvents} closed labels.`,
    evidencePaths: [
      sourceArtifacts.liquidityConditionedProspectiveEvidenceStatus,
      sourceArtifacts.feeSnapshotRefresh,
    ],
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['liquidity_conditioned_prospective_artifact_must_not_authorize_execution'] : []),
      ...blockers.slice(0, 12).map(reason => `liquidity_conditioned_prospective:${reason}`),
      ...(runtimeFeeSnapshotRefresh ? [] : ['runtime_fee_snapshot_refresh_missing']),
      ...(runtimeFeeStatus === 'blocked' ? ['runtime_fee_snapshot_blocked'] : []),
      ...runtimeFeeBlockers.slice(0, 8).map(reason => `runtime_fee:${reason}`),
    ]),
    metrics: {
      status,
      researchOnly: readBoolean(liquidityConditionedProspectiveEvidenceStatus.researchOnly),
      prospectiveOnly: readBoolean(liquidityConditionedProspectiveEvidenceStatus.prospectiveOnly),
      promotionEligible: readBoolean(liquidityConditionedProspectiveEvidenceStatus.promotionEligible),
      paperTradingAllowed: readBoolean(liquidityConditionedProspectiveEvidenceStatus.paperTradingAllowed),
      liveTradingAllowed: readBoolean(liquidityConditionedProspectiveEvidenceStatus.liveTradingAllowed),
      openEvents,
      closedEvents,
      uniqueOpenObservationIds: readNumber(counts?.uniqueOpenObservationIds),
      duplicateOpenObservationIds: readNumber(counts?.duplicateOpenObservationIds),
      pendingOpenEvents: readNumber(counts?.pendingOpenEvents),
      dueOpenEventsWithoutClose: readNumber(counts?.dueOpenEventsWithoutClose),
      closedMatchedToOpen: readNumber(counts?.closedMatchedToOpen),
      closedWithoutOpen: readNumber(counts?.closedWithoutOpen),
      openDecisionWindows,
      closedDecisionWindows,
      meanOpenEventsPerDecisionWindow,
      closedOutcomes: readNumber(metrics?.closedOutcomes),
      meanGrossLongShortSpreadPct: readNumber(metrics?.meanGrossLongShortSpreadPct),
      medianGrossLongShortSpreadPct: readNumber(metrics?.medianGrossLongShortSpreadPct),
      winRatePct: readNumber(metrics?.winRatePct),
      positiveGrossOutcomes: readNumber(metrics?.positiveGrossOutcomes),
      negativeGrossOutcomes: readNumber(metrics?.negativeGrossOutcomes),
      minClosedOutcomes: readNumber(thresholds?.minClosedOutcomes),
      minNonOverlappingWindows: readNumber(thresholds?.minNonOverlappingWindows),
      requireRuntimeVerifiedFees: readBoolean(thresholds?.requireRuntimeVerifiedFees),
      requireRouteCostAdjustedLabels: readBoolean(thresholds?.requireRouteCostAdjustedLabels),
      latestOpenDecisionTime: readString(latestOpen?.decisionTime),
      latestOpenLabelDueTime: readString(latestOpen?.labelDueTime),
      latestOpenSignalPair: readString(latestOpen?.signalPair),
      latestClosedCloseTime: readString(latestClosed?.closeTime),
      latestClosedGrossLongShortSpreadPct: readNumber(latestClosed?.grossLongShortSpreadPct),
      runtimeFeeSnapshotRefreshStatus: runtimeFeeStatus,
      runtimeFeeSnapshotWritten: readBoolean(runtimeFeeSnapshotRefresh?.snapshotWritten),
      notesContainCorrelationWarning: notes.some(note => note.includes('same decisionBarTime')),
    },
    nextActions: [
      'Settle due liquidity-conditioned observations only after labelDueTime; keep open events out of promotion evidence.',
      'Use closedDecisionWindows, not raw openEvents, when judging promotion-style prospective evidence.',
      'Refresh runtime fee snapshot after OKX private auth is fixed so route-cost-adjusted labels can be computed.',
    ],
  }
}

function buildResearchLineRetirementReason(
  researchLineRetirement: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!researchLineRetirement) {
    return {
      component: 'Research line retirement',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No research line retirement artifact is present, so killed research lines are not separately audited.',
      evidencePaths: [
        sourceArtifacts.researchLineRetirement,
        sourceArtifacts.researchIncubationPlan,
        sourceArtifacts.researchCandidateSummary,
      ],
      blockingReasons: ['research_line_retirement_artifact_missing'],
      metrics: {
        verdict: null,
        lineHealth: null,
        retirementRecommendedLines: null,
        activeIncubationCandidates: null,
      },
      nextActions: [
        'Run corepack pnpm research:line-retirement after incubation and candidate summary refresh.',
        'Use the retirement artifact to stop broad parameter search on WFO-killed research lines.',
      ],
    }
  }

  const verdict = readString(researchLineRetirement.verdict)
  const lineHealth = readString(researchLineRetirement.lineHealth)
  const summary = asRecord(researchLineRetirement.summary)
  const primaryLine = asRecord(researchLineRetirement.primaryLine)
  const retiredLines = Array.isArray(researchLineRetirement.retiredLines)
    ? researchLineRetirement.retiredLines.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const blockers = readStringArray(researchLineRetirement.blockers)
  const requiredBeforeReactivation = readStringArray(researchLineRetirement.requiredBeforeReactivation)
  const artifactAllowsExecution =
    readBoolean(researchLineRetirement.promotionAllowed) === true ||
    readBoolean(researchLineRetirement.paperTradingAllowed) === true ||
    readBoolean(researchLineRetirement.liveTradingAllowed) === true ||
    readBoolean(researchLineRetirement.policyMutationAllowed) === true
  const status: ReasonChainStatus = verdict === 'keep_incubating'
    ? 'observation_only'
    : verdict === 'retire_current_line' || verdict === 'no_active_line'
      ? 'blocked'
      : 'not_available'

  return {
    component: 'Research line retirement',
    status,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: verdict === 'retire_current_line'
      ? `Current research line is retired from active incubation; primary=${readString(primaryLine?.candidateId) ?? 'unknown'}.`
      : verdict === 'no_active_line'
        ? 'No active research line is available for incubation or execution.'
        : verdict === 'keep_incubating'
          ? `Research line remains in live-only incubation; primary=${readString(primaryLine?.candidateId) ?? 'unknown'}.`
          : `Research line retirement decision is not ready: verdict=${verdict ?? 'missing'}.`,
    evidencePaths: [
      sourceArtifacts.researchLineRetirement,
      sourceArtifacts.researchIncubationPlan,
      sourceArtifacts.researchCandidateSummary,
      sourceArtifacts.cryptoFactorFamilyReport,
      sourceArtifacts.liquidityConditionedFactorReport,
      sourceArtifacts.prospectiveEvidenceStatus,
      sourceArtifacts.liquidityConditionedProspectiveEvidenceStatus,
    ],
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['research_line_retirement_artifact_must_not_authorize_execution'] : []),
      ...(verdict ? [`research_line_retirement_verdict:${verdict}`] : ['research_line_retirement_verdict_missing']),
      ...(lineHealth ? [`research_line_health:${lineHealth}`] : []),
      ...blockers.slice(0, 20).map(reason => `research_line_retirement:${reason}`),
      ...requiredBeforeReactivation.slice(0, 12).map(reason => `reactivation_required:${reason}`),
    ]),
    metrics: {
      verdict,
      lineHealth,
      researchOnly: readBoolean(researchLineRetirement.researchOnly),
      diagnosticOnly: readBoolean(researchLineRetirement.diagnosticOnly),
      promotionAllowed: readBoolean(researchLineRetirement.promotionAllowed),
      paperTradingAllowed: readBoolean(researchLineRetirement.paperTradingAllowed),
      liveTradingAllowed: readBoolean(researchLineRetirement.liveTradingAllowed),
      policyMutationAllowed: readBoolean(researchLineRetirement.policyMutationAllowed),
      activeIncubationCandidates: readNumber(summary?.activeIncubationCandidates),
      rejectedDiagnostics: readNumber(summary?.rejectedDiagnostics),
      wfoKilledDiagnostics: readNumber(summary?.wfoKilledDiagnostics),
      diagnosticLinesReviewed: readNumber(summary?.diagnosticLinesReviewed),
      retirementRecommendedLines: readNumber(summary?.retirementRecommendedLines),
      openProspectiveEvents: readNumber(summary?.openProspectiveEvents),
      closedProspectiveEvents: readNumber(summary?.closedProspectiveEvents),
      earliestNextLabelDueTime: readString(summary?.earliestNextLabelDueTime),
      primaryCandidateId: readString(primaryLine?.candidateId),
      primaryLineId: readString(primaryLine?.lineId),
      primaryFamily: readString(primaryLine?.family),
      primaryStrategy: readString(primaryLine?.strategy),
      primaryNetAfterRouteCostPct: readNumber(primaryLine?.netAfterRouteCostPct),
      primaryWfoStatus: readString(primaryLine?.wfoStatus),
      primaryWfoFailedWindowRatio: readNumber(primaryLine?.wfoFailedWindowRatio),
      primaryWfoFailWindowRatioThreshold: readNumber(primaryLine?.wfoFailWindowRatioThreshold),
      primaryWfoDirectionStable: readBoolean(primaryLine?.wfoDirectionStable),
      primaryRuntimeFeeVerified: readBoolean(primaryLine?.runtimeFeeVerified),
      primaryKillTriggers: readStringArray(primaryLine?.killTriggers),
      retiredLineIds: retiredLines
        .map(line => readString(line.lineId))
        .filter((item): item is string => item != null)
        .slice(0, 12),
    },
    nextActions: readStringArray(researchLineRetirement.nextActions).length > 0
      ? readStringArray(researchLineRetirement.nextActions)
      : [
          'Stop broad parameter expansion on retired lines.',
          'Reactivate only after a new hypothesis, runtime fee, WFO, FDR, PIT, prospective, and paper evidence requirements pass.',
        ],
  }
}

function buildNextResearchHypothesisReason(
  nextResearchHypothesisPlan: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!nextResearchHypothesisPlan) {
    return {
      component: 'Research next hypothesis',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No next research hypothesis plan artifact is present after the current line retirement decision.',
      evidencePaths: [
        sourceArtifacts.nextResearchHypothesisPlan,
        sourceArtifacts.researchLineRetirement,
      ],
      blockingReasons: ['next_research_hypothesis_plan_missing'],
      metrics: {
        planStatus: null,
        experimentCards: 0,
      },
      nextActions: [
        'Run corepack pnpm research:next-hypothesis-plan to pre-register research-only alternatives before any new search.',
      ],
    }
  }

  const planStatus = readString(nextResearchHypothesisPlan.planStatus)
  const experimentCards = Array.isArray(nextResearchHypothesisPlan.experimentCards)
    ? nextResearchHypothesisPlan.experimentCards.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const forbiddenContinuations = Array.isArray(nextResearchHypothesisPlan.forbiddenContinuations)
    ? nextResearchHypothesisPlan.forbiddenContinuations.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const blockers = readStringArray(nextResearchHypothesisPlan.blockers)
  const admitted = experimentCards.filter(card => readString(card.decision) === 'admit_research_only')
  const artifactAllowsExecution =
    readBoolean(nextResearchHypothesisPlan.promotionAllowed) === true ||
    readBoolean(nextResearchHypothesisPlan.paperTradingAllowed) === true ||
    readBoolean(nextResearchHypothesisPlan.liveTradingAllowed) === true ||
    readBoolean(nextResearchHypothesisPlan.policyMutationAllowed) === true
  const status: ReasonChainStatus = planStatus === 'ready_for_research_only_experiments'
    ? 'observation_only'
    : planStatus === 'blocked_missing_inputs'
      ? 'blocked'
      : 'not_available'

  return {
    component: 'Research next hypothesis',
    status,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: planStatus === 'ready_for_research_only_experiments'
      ? `Next research plan has ${admitted.length} admitted research-only experiment(s); retired-line parameter search remains forbidden.`
      : `Next research plan is not ready: status=${planStatus ?? 'missing'}.`,
    evidencePaths: [
      sourceArtifacts.nextResearchHypothesisPlan,
      sourceArtifacts.researchLineRetirement,
      'src/strategy/contracts/strategy_family_contract.ts',
      'data/research/alpha_pool/latest.json',
    ],
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['next_research_hypothesis_artifact_must_not_authorize_execution'] : []),
      ...(planStatus ? [`next_research_hypothesis_plan_status:${planStatus}`] : ['next_research_hypothesis_plan_status_missing']),
      ...blockers.slice(0, 16).map(blocker => `next_research_hypothesis:${blocker}`),
      ...forbiddenContinuations.slice(0, 12).map(item =>
        `forbidden_continuation:${readString(item.lineId) ?? 'retired_line'}`),
    ]),
    metrics: {
      planStatus,
      researchOnly: readBoolean(nextResearchHypothesisPlan.researchOnly),
      diagnosticOnly: readBoolean(nextResearchHypothesisPlan.diagnosticOnly),
      promotionAllowed: readBoolean(nextResearchHypothesisPlan.promotionAllowed),
      paperTradingAllowed: readBoolean(nextResearchHypothesisPlan.paperTradingAllowed),
      liveTradingAllowed: readBoolean(nextResearchHypothesisPlan.liveTradingAllowed),
      policyMutationAllowed: readBoolean(nextResearchHypothesisPlan.policyMutationAllowed),
      experimentCards: experimentCards.length,
      admittedResearchOnlyExperiments: admitted.length,
      watchOnlyExperiments: experimentCards.filter(card => readString(card.decision) === 'watch_only').length,
      blockedExperiments: experimentCards.filter(card => readString(card.decision) === 'blocked').length,
      highPriorityExperiments: experimentCards.filter(card => readString(card.priority) === 'high').length,
      forbiddenContinuationCount: forbiddenContinuations.length,
      admittedFamilies: admitted
        .map(card => readString(card.familyId))
        .filter((item): item is string => item != null),
      experimentFamilies: experimentCards
        .map(card => readString(card.familyId))
        .filter((item): item is string => item != null),
    },
    nextActions: readStringArray(nextResearchHypothesisPlan.nextActions).length > 0
      ? readStringArray(nextResearchHypothesisPlan.nextActions)
      : [
          'Choose one admitted research-only experiment and register it with PIT/FDR kill criteria before running.',
          'Keep paper/live disabled until all promotion gates pass.',
        ],
  }
}

function buildEthCarryResearchReason(
  ethCarryResearchEvidenceStatus: UnknownRecord | null,
  ethCarrySignalDiagnostics: UnknownRecord | null,
  ethCarryDataGapStatus: UnknownRecord | null,
  runtimeFeeSnapshotRefresh: UnknownRecord | null,
  okxPrivateAuthDiagnosis: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  const runtimeFeeStatus = readString(runtimeFeeSnapshotRefresh?.status)
  const runtimeFeeBlockers = readStringArray(runtimeFeeSnapshotRefresh?.blockers)
  const okxAuthStatus = readString(okxPrivateAuthDiagnosis?.status)
  const okxAuthBlockers = readStringArray(okxPrivateAuthDiagnosis?.blockers)

  if (!ethCarryResearchEvidenceStatus) {
    return {
      component: 'ETH carry research',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No ETH carry research evidence status artifact is present.',
      evidencePaths: [
        sourceArtifacts.ethCarryResearchEvidenceStatus,
        sourceArtifacts.ethCarrySignalDiagnostics,
        sourceArtifacts.ethCarryDataGapStatus,
        sourceArtifacts.ethCarryProspectiveEvidenceStatus,
        sourceArtifacts.nextResearchHypothesisPlan,
        sourceArtifacts.feeSnapshotRefresh,
        sourceArtifacts.okxPrivateAuthDiagnosis,
      ],
      blockingReasons: uniqueStrings([
        'eth_carry_research_evidence_status_missing',
        ...(runtimeFeeSnapshotRefresh ? [] : ['runtime_fee_snapshot_refresh_missing']),
        ...(runtimeFeeStatus === 'blocked' ? ['runtime_fee_snapshot_blocked'] : []),
        ...runtimeFeeBlockers.slice(0, 8).map(reason => `runtime_fee:${reason}`),
        ...(okxPrivateAuthDiagnosis ? [] : ['okx_private_auth_diagnosis_missing']),
        ...(okxAuthStatus === 'blocked' ? ['okx_private_auth_blocked'] : []),
        ...okxAuthBlockers.slice(0, 8).map(reason => `okx_auth:${reason}`),
      ]),
      metrics: {
        status: null,
        profitabilityVerdict: null,
        runtimeFeeStatus,
        okxAuthStatus,
      },
      nextActions: [
        'Run corepack pnpm research:eth-carry:evidence-status to summarize the funding/carry lane separately from old runtime bundles.',
        'Keep ETH carry research-only until funding available-time, basis, WFO, FDR, PIT, prospective, and paper evidence pass.',
      ],
    }
  }

  const status = readString(ethCarryResearchEvidenceStatus.status)
  const profitabilityVerdict = readString(ethCarryResearchEvidenceStatus.profitabilityVerdict)
  const selectedCandidate = asRecord(ethCarryResearchEvidenceStatus.selectedCandidate)
  const bestObservedCandidate = asRecord(ethCarryResearchEvidenceStatus.bestObservedCandidate)
  const selectedMetrics = asRecord(selectedCandidate?.metrics)
  const selectedWfo = asRecord(selectedCandidate?.wfo)
  const selectedSignificance = asRecord(selectedCandidate?.significance)
  const selectedRisk = asRecord(selectedCandidate?.riskSimulation)
  const selectedReleaseGate = asRecord(selectedCandidate?.releaseGate)
  const pitEvidence = asRecord(ethCarryResearchEvidenceStatus.pitEvidence)
  const costEvidence = asRecord(ethCarryResearchEvidenceStatus.costEvidence)
  const validationSummary = asRecord(ethCarryResearchEvidenceStatus.validationSummary)
  const prospectiveEvidence = asRecord(ethCarryResearchEvidenceStatus.prospectiveEvidence)
  const nextResearchAlignment = asRecord(ethCarryResearchEvidenceStatus.nextResearchAlignment)
  const basisEvidence = asRecord(ethCarryResearchEvidenceStatus.basisEvidence)
  const signalDiagnosticsSummary = asRecord(ethCarrySignalDiagnostics?.summary)
  const signalDiagnosticsCounts = asRecord(ethCarrySignalDiagnostics?.counts)
  const dataGapCounts = asRecord(ethCarryDataGapStatus?.counts)
  const blockers = readStringArray(ethCarryResearchEvidenceStatus.blockers)
  const dataGapBlockers = readStringArray(ethCarryDataGapStatus?.blockers)
  const killCriteriaTriggered = readStringArray(ethCarryResearchEvidenceStatus.killCriteriaTriggered)
  const artifactAllowsExecution =
    readBoolean(ethCarryResearchEvidenceStatus.promotionAllowed) === true ||
    readBoolean(ethCarryResearchEvidenceStatus.paperTradingAllowed) === true ||
    readBoolean(ethCarryResearchEvidenceStatus.liveTradingAllowed) === true
  const reasonStatus: ReasonChainStatus = status === 'watch_only_ready'
    ? 'observation_only'
    : status === 'blocked_missing_inputs' || status === 'research_only_blocked'
      ? 'blocked'
      : 'not_available'

  return {
    component: 'ETH carry research',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: status === 'watch_only_ready'
      ? 'ETH carry research is watch-only ready, but it is still not execution or profitability proof.'
      : `ETH carry research is blocked: status=${status ?? 'missing'}, profitability=${profitabilityVerdict ?? 'missing'}.`,
    evidencePaths: [
      sourceArtifacts.ethCarryResearchEvidenceStatus,
      sourceArtifacts.ethCarrySignalDiagnostics,
      sourceArtifacts.ethCarryDataGapStatus,
      sourceArtifacts.ethCarryProspectiveEvidenceStatus,
      sourceArtifacts.nextResearchHypothesisPlan,
      sourceArtifacts.feeSnapshotRefresh,
      sourceArtifacts.okxPrivateAuthDiagnosis,
      'scripts/build_eth_carry_research_evidence_status.ts',
    ],
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['eth_carry_research_artifact_must_not_authorize_execution'] : []),
      ...(status ? [`eth_carry_research_status:${status}`] : ['eth_carry_research_status_missing']),
      ...(profitabilityVerdict ? [`eth_carry_profitability_verdict:${profitabilityVerdict}`] : []),
      ...blockers.slice(0, 24).map(reason => `eth_carry:${reason}`),
      ...dataGapBlockers.slice(0, 12).map(reason => `eth_carry_data_gap:${reason}`),
      ...killCriteriaTriggered.slice(0, 12).map(reason => `eth_carry_kill:${reason}`),
      ...(runtimeFeeSnapshotRefresh ? [] : ['runtime_fee_snapshot_refresh_missing']),
      ...(runtimeFeeStatus === 'blocked' ? ['runtime_fee_snapshot_blocked'] : []),
      ...runtimeFeeBlockers.slice(0, 8).map(reason => `runtime_fee:${reason}`),
      ...(okxPrivateAuthDiagnosis ? [] : ['okx_private_auth_diagnosis_missing']),
      ...(okxAuthStatus === 'blocked' ? ['okx_private_auth_blocked'] : []),
      ...okxAuthBlockers.slice(0, 8).map(reason => `okx_auth:${reason}`),
    ]),
    metrics: {
      status,
      profitabilityVerdict,
      researchOnly: readBoolean(ethCarryResearchEvidenceStatus.researchOnly),
      diagnosticOnly: readBoolean(ethCarryResearchEvidenceStatus.diagnosticOnly),
      promotionAllowed: readBoolean(ethCarryResearchEvidenceStatus.promotionAllowed),
      paperTradingAllowed: readBoolean(ethCarryResearchEvidenceStatus.paperTradingAllowed),
      liveTradingAllowed: readBoolean(ethCarryResearchEvidenceStatus.liveTradingAllowed),
      selectedRole: readString(selectedCandidate?.role),
      selectedCandidateId: readString(selectedCandidate?.candidateId),
      selectedNetExpectancyPct: readNumber(selectedMetrics?.netExpectancyPct),
      selectedTotalReturnPct: readNumber(selectedMetrics?.totalReturnPct),
      selectedTradeCount: readNumber(selectedMetrics?.tradeCount),
      selectedSharpe: readNumber(selectedMetrics?.sharpe),
      selectedWfoPassed: readBoolean(selectedWfo?.overallPassed),
      selectedWfoFailedWindows: readNumber(selectedWfo?.failedWindows),
      selectedWfoWindowCount: readNumber(selectedWfo?.windowCount),
      selectedWfoFailedWindowRatio: readNumber(selectedWfo?.failedWindowRatio),
      selectedPbo: readNumber(selectedSignificance?.pbo),
      selectedDsrProbability: readNumber(selectedSignificance?.dsrProbability),
      selectedRiskProfitProbability: readNumber(selectedRisk?.profitProbability),
      selectedReleaseGateFailedChecks: readStringArray(selectedReleaseGate?.failedChecks),
      bestObservedRole: readString(bestObservedCandidate?.role),
      bestObservedCandidateId: readString(bestObservedCandidate?.candidateId),
      bestObservedNetExpectancyPct: readNumber(asRecord(bestObservedCandidate?.metrics)?.netExpectancyPct),
      fundingExplicitAvailableTimeCoveragePct: readNumber(pitEvidence?.fundingExplicitAvailableTimeCoveragePct),
      fundingAvailableTimeStatus: readString(pitEvidence?.fundingAvailableTimeStatus),
      basisAvailableTimeStatus: readString(pitEvidence?.basisAvailableTimeStatus),
      basisAvailable: readBoolean(basisEvidence?.available),
      runtimeFeeStatus: readString(costEvidence?.runtimeFeeStatus) ?? runtimeFeeStatus,
      runtimeFeePerSymbolFees: readNumber(costEvidence?.runtimeFeePerSymbolFees),
      okxPrivateAuthStatus: readString(costEvidence?.okxPrivateAuthStatus) ?? okxAuthStatus,
      paperExecutionSlippageAvailable: readBoolean(validationSummary?.paperExecutionSlippageAvailable),
      trialLedgerStatus: readString(validationSummary?.trialLedgerStatus),
      fdrQ: readNumber(validationSummary?.fdrQ),
      prospectiveStatus: readString(prospectiveEvidence?.status),
      prospectiveOpenEvents: readNumber(prospectiveEvidence?.openEvents),
      prospectiveClosedOutcomes: readNumber(prospectiveEvidence?.closedOutcomes),
      prospectiveClosedDecisionWindows: readNumber(prospectiveEvidence?.closedDecisionWindows),
      prospectiveMinClosedOutcomes: readNumber(prospectiveEvidence?.minClosedOutcomes),
      prospectiveMinNonOverlappingWindows: readNumber(prospectiveEvidence?.minNonOverlappingWindows),
      prospectiveLatestOpenObservationId: readString(prospectiveEvidence?.latestOpenObservationId),
      prospectiveLatestOpenDecisionTime: readString(prospectiveEvidence?.latestOpenDecisionTime),
      prospectiveLatestOpenLabelDueTime: readString(prospectiveEvidence?.latestOpenLabelDueTime),
      signalDiagnosticsStatus: readString(ethCarrySignalDiagnostics?.status),
      signalDiagnosticsClosedRows: readNumber(signalDiagnosticsCounts?.closedDiagnosticRows),
      signalDiagnosticsMeanNetPct: readNumber(signalDiagnosticsSummary?.meanNetPct),
      signalDiagnosticsWinRateNetPct: readNumber(signalDiagnosticsSummary?.winRateNetPct),
      signalDiagnosticsBestDirectionByMeanNet: readString(signalDiagnosticsSummary?.bestDirectionByMeanNet),
      signalDiagnosticsWorstDirectionByMeanNet: readString(signalDiagnosticsSummary?.worstDirectionByMeanNet),
      signalDiagnosticsStrongestPositiveBucket: readString(signalDiagnosticsSummary?.strongestPositiveBucket),
      signalDiagnosticsStrongestNegativeBucket: readString(signalDiagnosticsSummary?.strongestNegativeBucket),
      dataGapStatus: readString(ethCarryDataGapStatus?.status),
      dataGapCarryFeatureRows: readNumber(dataGapCounts?.carryFeatureRows),
      dataGapProspectiveClosedOutcomes: readNumber(dataGapCounts?.prospectiveClosedOutcomes),
      dataGapCollectorErrorCount: readNumber(dataGapCounts?.collectorErrorCount),
      nextResearchPlanStatus: readString(nextResearchAlignment?.planStatus),
      nextResearchAdmittedFundingCarry: readBoolean(nextResearchAlignment?.admittedFundingCarry),
      killCriteriaTriggered,
    },
    nextActions: readStringArray(ethCarryResearchEvidenceStatus.nextActions).length > 0
      ? readStringArray(ethCarryResearchEvidenceStatus.nextActions)
      : [
          'Keep ETH carry research-only; do not publish non-flat paper targets from this evidence.',
          'Rebuild the carry lane with explicit funding available-time, basis spread, and stressed unwind costs before another promotion review.',
      ],
  }
}

function buildEthCarryConfluenceCandidateReason(
  ethCarryConfluenceCandidateStatus: UnknownRecord | null,
  ethCarryConfluenceValidation: UnknownRecord | null,
  ethCarryConfluenceTrialStatus: UnknownRecord | null,
  ethCarryConfluenceRefinementSweep: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!ethCarryConfluenceCandidateStatus) {
    return {
      component: 'ETH carry confluence candidate',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No ETH carry confluence candidate status artifact is present.',
      evidencePaths: [
        sourceArtifacts.ethCarryConfluenceCandidateStatus,
        sourceArtifacts.ethCarryConfluenceValidation,
        sourceArtifacts.ethCarryConfluenceTrialStatus,
        sourceArtifacts.ethCarryConfluenceRefinementSweep,
        sourceArtifacts.ethCarrySignalDiagnostics,
        'scripts/build_eth_carry_confluence_candidate_status.ts',
        'scripts/validate_eth_carry_confluence_candidate.ts',
        'scripts/build_eth_carry_confluence_trial_status.ts',
        'scripts/build_eth_carry_confluence_refinement_sweep.ts',
      ].filter(Boolean),
      blockingReasons: ['eth_carry_confluence_candidate_status_missing'],
      metrics: {
        status: null,
        validationStatus: null,
      },
      nextActions: [
        'Run corepack pnpm research:eth-carry:confluence-candidate-status after signal diagnostics refresh.',
        'Keep any confluence rule research-only until PIT WFO, BY/FDR, route-cost, slippage, prospective, and paper telemetry evidence pass.',
      ],
    }
  }

  const status = readString(ethCarryConfluenceCandidateStatus.status)
  const signalDiagnostics = asRecord(ethCarryConfluenceCandidateStatus.signalDiagnostics)
  const recommendedCandidate = asRecord(ethCarryConfluenceCandidateStatus.recommendedCandidate)
  const recommendedEvidence = asRecord(recommendedCandidate?.evidence)
  const recommendedRule = asRecord(recommendedCandidate?.rule)
  const avoidListCandidate = asRecord(ethCarryConfluenceCandidateStatus.avoidListCandidate)
  const avoidEvidence = asRecord(avoidListCandidate?.evidence)
  const validationStatus = readString(ethCarryConfluenceValidation?.status)
  const validationSummary = asRecord(ethCarryConfluenceValidation?.summary)
  const validationCounts = asRecord(ethCarryConfluenceValidation?.counts)
  const trialStatus = readString(ethCarryConfluenceTrialStatus?.status)
  const trialLedger = asRecord(ethCarryConfluenceTrialStatus?.trialLedger)
  const trialFdr = asRecord(ethCarryConfluenceTrialStatus?.fdr)
  const trialWfo = asRecord(ethCarryConfluenceTrialStatus?.wfo)
  const trialRiskSimulation = asRecord(ethCarryConfluenceTrialStatus?.riskSimulation)
  const trialEvidenceCounts = asRecord(ethCarryConfluenceTrialStatus?.evidenceCounts)
  const refinementStatus = readString(ethCarryConfluenceRefinementSweep?.status)
  const refinementBestVariant = asRecord(ethCarryConfluenceRefinementSweep?.bestVariant)
  const refinementFdr = asRecord(ethCarryConfluenceRefinementSweep?.fdr)
  const refinementTrialLedger = asRecord(ethCarryConfluenceRefinementSweep?.trialLedger)
  const refinementEvidenceCounts = asRecord(ethCarryConfluenceRefinementSweep?.evidenceCounts)
  const refinementBestRule = asRecord(refinementBestVariant?.rule)
  const refinementBestWfo = asRecord(refinementBestVariant?.wfo)
  const blockers = readStringArray(ethCarryConfluenceCandidateStatus.blockers)
  const validationBlockers = readStringArray(ethCarryConfluenceValidation?.blockers)
  const trialBlockers = readStringArray(ethCarryConfluenceTrialStatus?.blockers)
  const refinementBlockers = readStringArray(ethCarryConfluenceRefinementSweep?.blockers)
  const artifactAllowsExecution =
    readBoolean(ethCarryConfluenceCandidateStatus.promotionEligible) === true ||
    readBoolean(ethCarryConfluenceCandidateStatus.paperTradingAllowed) === true ||
    readBoolean(ethCarryConfluenceCandidateStatus.liveTradingAllowed) === true ||
    readBoolean(ethCarryConfluenceCandidateStatus.executionAllowed) === true ||
    readBoolean(ethCarryConfluenceValidation?.promotionEligible) === true ||
    readBoolean(ethCarryConfluenceValidation?.paperTradingAllowed) === true ||
    readBoolean(ethCarryConfluenceValidation?.liveTradingAllowed) === true ||
    readBoolean(ethCarryConfluenceValidation?.executionAllowed) === true ||
    readBoolean(ethCarryConfluenceTrialStatus?.promotionEligible) === true ||
    readBoolean(ethCarryConfluenceTrialStatus?.paperTradingAllowed) === true ||
    readBoolean(ethCarryConfluenceTrialStatus?.liveTradingAllowed) === true ||
    readBoolean(ethCarryConfluenceTrialStatus?.executionAllowed) === true ||
    readBoolean(ethCarryConfluenceRefinementSweep?.promotionEligible) === true ||
    readBoolean(ethCarryConfluenceRefinementSweep?.paperTradingAllowed) === true ||
    readBoolean(ethCarryConfluenceRefinementSweep?.liveTradingAllowed) === true ||
    readBoolean(ethCarryConfluenceRefinementSweep?.executionAllowed) === true
  const reasonStatus: ReasonChainStatus =
    status === 'research_candidate_ready_for_offline_validation'
      ? 'observation_only'
      : status === 'blocked_missing_inputs' ||
          status === 'no_positive_confluence_candidate' ||
          status === 'research_candidate_insufficient_evidence'
        ? 'blocked'
        : 'not_available'

  return {
    component: 'ETH carry confluence candidate',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: recommendedCandidate
      ? `ETH carry confluence candidate ${readString(recommendedCandidate.candidateId) ?? 'unknown'} is ${status ?? 'missing'}; it is research-only and cannot trade.`
      : `ETH carry confluence candidate status=${status ?? 'missing'}; no tradable candidate exists.`,
    evidencePaths: [
      sourceArtifacts.ethCarryConfluenceCandidateStatus,
      sourceArtifacts.ethCarryConfluenceValidation,
      sourceArtifacts.ethCarryConfluenceTrialStatus,
      sourceArtifacts.ethCarryConfluenceRefinementSweep,
      sourceArtifacts.ethCarrySignalDiagnostics,
      'scripts/build_eth_carry_confluence_candidate_status.ts',
      'scripts/validate_eth_carry_confluence_candidate.ts',
      'scripts/build_eth_carry_confluence_trial_status.ts',
      'scripts/build_eth_carry_confluence_refinement_sweep.ts',
    ].filter(Boolean),
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['eth_carry_confluence_candidate_must_not_authorize_execution'] : []),
      ...(status ? [`eth_carry_confluence_candidate_status:${status}`] : ['eth_carry_confluence_candidate_status_missing']),
      ...(validationStatus ? [`eth_carry_confluence_validation_status:${validationStatus}`] : ['eth_carry_confluence_validation_missing']),
      ...(trialStatus ? [`eth_carry_confluence_trial_status:${trialStatus}`] : ['eth_carry_confluence_trial_status_missing']),
      ...(refinementStatus ? [`eth_carry_confluence_refinement_status:${refinementStatus}`] : ['eth_carry_confluence_refinement_missing']),
      ...blockers.slice(0, 24).map(reason => `eth_carry_confluence:${reason}`),
      ...validationBlockers.slice(0, 16).map(reason => `eth_carry_confluence_validation:${reason}`),
      ...trialBlockers.slice(0, 20).map(reason => `eth_carry_confluence_trial:${reason}`),
      ...refinementBlockers.slice(0, 20).map(reason => `eth_carry_confluence_refinement:${reason}`),
    ]),
    metrics: {
      status,
      researchOnly: readBoolean(ethCarryConfluenceCandidateStatus.researchOnly),
      diagnosticOnly: readBoolean(ethCarryConfluenceCandidateStatus.diagnosticOnly),
      promotionEligible: readBoolean(ethCarryConfluenceCandidateStatus.promotionEligible),
      paperTradingAllowed: readBoolean(ethCarryConfluenceCandidateStatus.paperTradingAllowed),
      liveTradingAllowed: readBoolean(ethCarryConfluenceCandidateStatus.liveTradingAllowed),
      executionAllowed: readBoolean(ethCarryConfluenceCandidateStatus.executionAllowed),
      signalDiagnosticsClosedRows: readNumber(signalDiagnostics?.closedDiagnosticRows),
      signalDiagnosticsMeanNetPct: readNumber(signalDiagnostics?.meanNetPct),
      signalDiagnosticsWinRateNetPct: readNumber(signalDiagnostics?.winRateNetPct),
      recommendedCandidateId: readString(recommendedCandidate?.candidateId),
      recommendedSourceBucketId: readString(recommendedCandidate?.sourceBucketId),
      recommendedFundingSpreadSign: readString(recommendedRule?.fundingSpreadSign),
      recommendedBasisSpreadDiffPctSign: readString(recommendedRule?.basisSpreadDiffPctSign),
      recommendedDirection: readString(recommendedRule?.direction),
      recommendedClosedOutcomes: readNumber(recommendedEvidence?.closedOutcomes),
      recommendedWinRatePct: readNumber(recommendedEvidence?.winRatePct),
      recommendedMeanNetPct: readNumber(recommendedEvidence?.meanNetPct),
      avoidCandidateId: readString(avoidListCandidate?.candidateId),
      avoidSourceBucketId: readString(avoidListCandidate?.sourceBucketId),
      avoidClosedOutcomes: readNumber(avoidEvidence?.closedOutcomes),
      avoidMeanNetPct: readNumber(avoidEvidence?.meanNetPct),
      validationStatus,
      validationFeatureRowsAfterRule: readNumber(validationCounts?.featureRowsAfterRule),
      validationTradesBuilt: readNumber(validationCounts?.tradesBuilt),
      validationMeanGrossPct: readNumber(validationSummary?.meanGrossPct),
      validationMeanFundingCashflowPct: readNumber(validationSummary?.meanFundingCashflowPct),
      validationMeanNetPct: readNumber(validationSummary?.meanNetPct),
      validationWinRatePct: readNumber(validationSummary?.winRatePct),
      validationPassedWindows: readNumber(validationSummary?.passedWindows),
      validationFailedWindows: readNumber(validationSummary?.failedWindows),
      trialStatus,
      trialRawM: readNumber(trialLedger?.rawM),
      trialRawMComplete: readBoolean(trialLedger?.rawMComplete),
      trialIncludesFailedTrials: readBoolean(trialLedger?.includesFailedTrials),
      trialPValuePromotionGrade: readBoolean(trialLedger?.pValuePromotionGrade),
      trialSelectedClosedOutcomes: readNumber(trialEvidenceCounts?.selectedBucketClosedOutcomes),
      trialTotalClosedOutcomes: readNumber(trialEvidenceCounts?.totalClosedOutcomes),
      trialValidationTrades: readNumber(trialEvidenceCounts?.validationTrades),
      trialSelectedPValue: readNumber(trialFdr?.selectedPValue),
      trialSelectedQValue: readNumber(trialFdr?.selectedQValue),
      trialSelectedFdrPassed: readBoolean(trialFdr?.selectedPassed),
      trialWfoStatus: readString(trialWfo?.status),
      trialRiskStatus: readString(trialRiskSimulation?.status),
      trialProfitProbability: readNumber(trialRiskSimulation?.profitProbability),
      refinementStatus,
      refinementVariantsTested: readNumber(refinementEvidenceCounts?.variantsTested),
      refinementMatchedClosedRows: readNumber(refinementEvidenceCounts?.matchedClosedRows),
      refinementRawM: readNumber(refinementTrialLedger?.rawM),
      refinementRawMComplete: readBoolean(refinementTrialLedger?.rawMComplete),
      refinementPValuePromotionGrade: readBoolean(refinementTrialLedger?.pValuePromotionGrade),
      refinementBestVariantId: readString(refinementBestVariant?.variantId),
      refinementBestClosedOutcomes: readNumber(refinementBestVariant?.closedOutcomes),
      refinementBestMeanNetPct: readNumber(refinementBestVariant?.meanNetPct),
      refinementBestWinRatePct: readNumber(refinementBestVariant?.winRatePct),
      refinementBestFdrPassed: readBoolean(refinementBestVariant?.fdrPassed),
      refinementBestQValue: readNumber(refinementFdr?.bestVariantQValue) ?? readNumber(refinementBestVariant?.pAdjustedBYRawM),
      refinementBestFundingAbsThreshold: readNumber(refinementBestRule?.minAbsFundingSpread),
      refinementBestBasisAbsThresholdPct: readNumber(refinementBestRule?.minAbsBasisSpreadDiffPct),
      refinementBestWfoStatus: readString(refinementBestWfo?.status),
    },
    nextActions: readStringArray(ethCarryConfluenceCandidateStatus.nextActions).length > 0
      ? readStringArray(ethCarryConfluenceCandidateStatus.nextActions)
      : [
          'Keep the confluence candidate research-only.',
          'Build a dedicated offline validator before expanding prospective capture around this rule.',
        ],
  }
}

function buildEthCarryDataGapReason(
  ethCarryDataGapStatus: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!ethCarryDataGapStatus) {
    return {
      component: 'ETH carry data gaps',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No ETH carry data gap status artifact is present.',
      evidencePaths: [
        sourceArtifacts.ethCarryDataGapStatus,
        sourceArtifacts.ethCarryProspectiveEvidenceStatus,
        sourceArtifacts.externalDerivativesCollect,
        sourceArtifacts.openAliceDataCatalog,
      ].filter(Boolean),
      blockingReasons: ['eth_carry_data_gap_status_missing'],
      metrics: {
        status: null,
      },
      nextActions: [
        'Run research:eth-carry:data-gap-status after PIT feature, prospective, collector, and data monitor artifacts are refreshed.',
      ],
    }
  }

  const status = readString(ethCarryDataGapStatus.status)
  const counts = asRecord(ethCarryDataGapStatus.counts)
  const thresholds = asRecord(ethCarryDataGapStatus.thresholds)
  const collectorStatus = asRecord(ethCarryDataGapStatus.collectorStatus)
  const blockers = readStringArray(ethCarryDataGapStatus.blockers)
  const archiveSummary = asRecord(ethCarryDataGapStatus.dataVisionArchiveSummary)
  const archiveRows = Array.isArray(ethCarryDataGapStatus.dataVisionArchives)
    ? ethCarryDataGapStatus.dataVisionArchives.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const coreArchiveRows = Array.isArray(ethCarryDataGapStatus.dataVisionCoreSmokeArchives)
    ? ethCarryDataGapStatus.dataVisionCoreSmokeArchives.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const archiveComplete = archiveRows.filter(row => readString(row.status) === 'complete').length
  const coreArchiveComplete = coreArchiveRows.filter(row => readString(row.status) === 'complete').length
  const artifactAllowsExecution =
    readBoolean(ethCarryDataGapStatus.promotionEligible) === true ||
    readBoolean(ethCarryDataGapStatus.paperTradingAllowed) === true ||
    readBoolean(ethCarryDataGapStatus.liveTradingAllowed) === true ||
    readBoolean(ethCarryDataGapStatus.executionAllowed) === true

  return {
    component: 'ETH carry data gaps',
    status: status === 'watch_ready_for_more_capture' ? 'observation_only' : 'blocked',
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: `ETH carry data gap status=${status ?? 'missing'}: featureRows=${readNumber(counts?.carryFeatureRows) ?? 0}, prospectiveClosed=${readNumber(counts?.prospectiveClosedOutcomes) ?? 0}.`,
    evidencePaths: [
      sourceArtifacts.ethCarryDataGapStatus,
      sourceArtifacts.ethCarryProspectiveEvidenceStatus,
      sourceArtifacts.externalDerivativesCollect,
      sourceArtifacts.openAliceDataCatalog,
      'scripts/build_eth_carry_data_gap_status.ts',
    ].filter(Boolean),
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['eth_carry_data_gap_artifact_must_not_authorize_execution'] : []),
      ...(status ? [`eth_carry_data_gap_status:${status}`] : ['eth_carry_data_gap_status_missing']),
      ...blockers.slice(0, 24).map(reason => `eth_carry_data_gap:${reason}`),
    ]),
    metrics: {
      status,
      researchOnly: readBoolean(ethCarryDataGapStatus.researchOnly),
      diagnosticOnly: readBoolean(ethCarryDataGapStatus.diagnosticOnly),
      promotionEligible: readBoolean(ethCarryDataGapStatus.promotionEligible),
      paperTradingAllowed: readBoolean(ethCarryDataGapStatus.paperTradingAllowed),
      liveTradingAllowed: readBoolean(ethCarryDataGapStatus.liveTradingAllowed),
      executionAllowed: readBoolean(ethCarryDataGapStatus.executionAllowed),
      carryFeatureRows: readNumber(counts?.carryFeatureRows),
      minCarryFeatureRows: readNumber(thresholds?.minCarryFeatureRows),
      fundingEvents: readNumber(counts?.fundingEvents),
      basisSnapshots: readNumber(counts?.basisSnapshots),
      sourceLineageIncompleteRows: readNumber(counts?.sourceLineageIncompleteRows),
      prospectiveClosedOutcomes: readNumber(counts?.prospectiveClosedOutcomes),
      minProspectiveClosedOutcomes: readNumber(thresholds?.minProspectiveClosedOutcomes),
      prospectiveClosedDecisionWindows: readNumber(counts?.prospectiveClosedDecisionWindows),
      minClosedDecisionWindows: readNumber(thresholds?.minClosedDecisionWindows),
      collectorErrorCount: readNumber(counts?.collectorErrorCount),
      collectorDryRun: readBoolean(collectorStatus?.dryRun),
      collectorStale: readBoolean(collectorStatus?.stale),
      collectorProxyConfigured: readBoolean(collectorStatus?.proxyConfigured),
      dataVisionCoreSmokeArchives: coreArchiveRows.length,
      dataVisionCoreSmokeArchivesComplete: readNumber(archiveSummary?.coreSmokeArchivesComplete) ?? coreArchiveComplete,
      dataVisionCoreSmokeComplete: readBoolean(archiveSummary?.coreSmokeComplete),
      dataVisionFullCatalogArchives: readNumber(archiveSummary?.fullCatalogArchives) ?? archiveRows.length,
      dataVisionFullCatalogArchivesComplete: readNumber(archiveSummary?.fullCatalogArchivesComplete) ?? archiveComplete,
      dataVisionFullCatalogComplete: readBoolean(archiveSummary?.fullCatalogComplete),
      dataVisionArchives: archiveRows.length,
      dataVisionArchivesComplete: archiveComplete,
      dataVisionCoreSmokeArchiveStatuses: coreArchiveRows.map(row => ({
        datasetId: readString(row.datasetId),
        status: readString(row.status),
        zipFiles: readNumber(row.zipFiles),
        partFiles: readNumber(row.partFiles),
      })),
      dataVisionArchiveStatuses: archiveRows.map(row => ({
        datasetId: readString(row.datasetId),
        status: readString(row.status),
        zipFiles: readNumber(row.zipFiles),
        partFiles: readNumber(row.partFiles),
      })),
    },
    nextActions: readStringArray(ethCarryDataGapStatus.nextActions).length > 0
      ? readStringArray(ethCarryDataGapStatus.nextActions)
      : [
          'Refresh carry data gap status after the next derivatives archive or collector update.',
          'Keep funding/carry research-only until all sample, PIT, prospective, and execution-evidence gates pass.',
        ],
  }
}

function buildEthCarryProspectiveWatchdogReason(
  ethCarryProspectiveWatchdog: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!ethCarryProspectiveWatchdog) {
    return {
      component: 'ETH carry prospective watchdog',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No ETH carry prospective watchdog artifact is present.',
      evidencePaths: [
        sourceArtifacts.ethCarryProspectiveWatchdog,
        sourceArtifacts.ethCarryProspectiveEvidenceStatus,
        sourceArtifacts.ethCarryDataGapStatus,
        'scripts/build_eth_carry_prospective_watchdog.ts',
      ].filter(Boolean),
      blockingReasons: ['eth_carry_prospective_watchdog_missing'],
      metrics: {
        status: null,
        pendingOpenEvents: 0,
        dueOpenEventsWithoutClose: 0,
        closedOutcomes: 0,
      },
      nextActions: [
        'Run corepack pnpm research:eth-carry:prospective-watchdog after PIT, capture, settle, and prospective status refresh.',
      ],
    }
  }

  const status = readString(ethCarryProspectiveWatchdog.status)
  const ledger = asRecord(ethCarryProspectiveWatchdog.ledger)
  const readiness = asRecord(ethCarryProspectiveWatchdog.readiness)
  const artifacts = asRecord(ethCarryProspectiveWatchdog.artifacts)
  const prospectiveEvidence = asRecord(artifacts?.prospectiveEvidence)
  const candleWatermark = asRecord(ethCarryProspectiveWatchdog.candleWatermark)
  const blockers = readStringArray(ethCarryProspectiveWatchdog.blockers)
  const evidenceBlockers = readStringArray(ethCarryProspectiveWatchdog.evidenceBlockers)
  const artifactAllowsExecution =
    readBoolean(ethCarryProspectiveWatchdog.promotionEligible) === true ||
    readBoolean(ethCarryProspectiveWatchdog.paperTradingAllowed) === true ||
    readBoolean(ethCarryProspectiveWatchdog.liveTradingAllowed) === true ||
    readBoolean(ethCarryProspectiveWatchdog.executionAllowed) === true
  const reasonStatus: ReasonChainStatus = status === 'blocked'
    ? 'blocked'
    : status === 'watch_waiting_for_label' || status === 'action_required'
      ? 'observation_only'
      : 'not_available'

  return {
    component: 'ETH carry prospective watchdog',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: `ETH carry prospective watchdog status=${status ?? 'missing'}: pending=${readNumber(ledger?.pendingOpenEvents) ?? 0}, due=${readNumber(ledger?.dueOpenEventsWithoutClose) ?? 0}, closed=${readNumber(prospectiveEvidence?.closedOutcomes) ?? 0}.`,
    evidencePaths: [
      sourceArtifacts.ethCarryProspectiveWatchdog,
      sourceArtifacts.ethCarryProspectiveEvidenceStatus,
      sourceArtifacts.ethCarryDataGapStatus,
      'scripts/build_eth_carry_prospective_watchdog.ts',
    ].filter(Boolean),
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['eth_carry_prospective_watchdog_must_not_authorize_execution'] : []),
      ...(status ? [`eth_carry_prospective_watchdog_status:${status}`] : ['eth_carry_prospective_watchdog_status_missing']),
      ...blockers.slice(0, 20).map(reason => `eth_carry_prospective_watchdog:${reason}`),
      ...evidenceBlockers.slice(0, 20).map(reason => `eth_carry_prospective_evidence:${reason}`),
    ]),
    metrics: {
      status,
      researchOnly: readBoolean(ethCarryProspectiveWatchdog.researchOnly),
      diagnosticOnly: readBoolean(ethCarryProspectiveWatchdog.diagnosticOnly),
      promotionEligible: readBoolean(ethCarryProspectiveWatchdog.promotionEligible),
      paperTradingAllowed: readBoolean(ethCarryProspectiveWatchdog.paperTradingAllowed),
      liveTradingAllowed: readBoolean(ethCarryProspectiveWatchdog.liveTradingAllowed),
      executionAllowed: readBoolean(ethCarryProspectiveWatchdog.executionAllowed),
      openEvents: readNumber(ledger?.openEvents),
      closedEvents: readNumber(ledger?.closedEvents),
      pendingOpenEvents: readNumber(ledger?.pendingOpenEvents),
      dueOpenEventsWithoutClose: readNumber(ledger?.dueOpenEventsWithoutClose),
      duplicateOpenObservationIds: readNumber(ledger?.duplicateOpenObservationIds),
      latestOpenObservationId: readString(ledger?.latestOpenObservationId),
      latestOpenDecisionTime: readString(ledger?.latestOpenDecisionTime),
      latestOpenLabelDueTime: readString(ledger?.latestOpenLabelDueTime),
      nextLabelDueTime: readString(ledger?.nextLabelDueTime),
      closedOutcomes: readNumber(prospectiveEvidence?.closedOutcomes),
      okxFresh: readBoolean(readiness?.okxFresh),
      pitReady: readBoolean(readiness?.pitReady),
      pitAuditPass: readBoolean(readiness?.pitAuditPass),
      captureHealthy: readBoolean(readiness?.captureHealthy),
      settleHealthy: readBoolean(readiness?.settleHealthy),
      hasPendingOpen: readBoolean(readiness?.hasPendingOpen),
      hasDueUnsettled: readBoolean(readiness?.hasDueUnsettled),
      candleDataCanSettleNextDue: readBoolean(readiness?.candleDataCanSettleNextDue),
      candleWatermarkMinLatest: readString(candleWatermark?.minLatest),
    },
    nextActions: readStringArray(ethCarryProspectiveWatchdog.nextActions).length > 0
      ? readStringArray(ethCarryProspectiveWatchdog.nextActions)
      : [
          'Keep the ETH carry prospective cadence running in research-only mode.',
          'Settle only after labelDueTime and matching 5m close candles exist.',
        ],
  }
}

function buildOkxRouteCostSlippageReadinessReason(
  okxRouteCostSlippageReadiness: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!okxRouteCostSlippageReadiness) {
    return {
      component: 'OKX route-cost/slippage readiness',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No OKX route-cost/slippage readiness artifact is present.',
      evidencePaths: [
        sourceArtifacts.okxRouteCostSlippageReadiness,
        sourceArtifacts.routeCostBudget,
        sourceArtifacts.feeSnapshot,
        'scripts/build_okx_route_cost_slippage_readiness.ts',
      ],
      blockingReasons: [
        'okx_route_cost_slippage_readiness_missing',
        'route_cost_and_slippage_not_machine_monitored',
      ],
      metrics: {
        status: null,
        publicOrderbookUsableForResearch: false,
        routeCostBudgetRuntimeVerified: false,
        paperExecutionTelemetryAvailable: false,
      },
      nextActions: [
        'Run corepack pnpm research:okx:route-cost-slippage-readiness after OKX order-book, fee, route budget, and paper diagnostics refresh.',
      ],
    }
  }

  const status = readString(okxRouteCostSlippageReadiness.status)
  const readiness = asRecord(okxRouteCostSlippageReadiness.readiness)
  const orderbook = asRecord(okxRouteCostSlippageReadiness.orderbook)
  const feeSnapshot = asRecord(okxRouteCostSlippageReadiness.feeSnapshot)
  const routeCostBudget = asRecord(okxRouteCostSlippageReadiness.routeCostBudget)
  const executionQuality = asRecord(okxRouteCostSlippageReadiness.executionQuality)
  const paperCostEvidence = asRecord(okxRouteCostSlippageReadiness.paperCostEvidence)
  const paperFutureTelemetry = asRecord(okxRouteCostSlippageReadiness.paperFutureTelemetry)
  const blockers = readStringArray(okxRouteCostSlippageReadiness.blockers)
  const artifactAllowsExecution =
    readBoolean(okxRouteCostSlippageReadiness.promotionEligible) === true ||
    readBoolean(okxRouteCostSlippageReadiness.paperTradingAllowed) === true ||
    readBoolean(okxRouteCostSlippageReadiness.liveTradingAllowed) === true ||
    readBoolean(okxRouteCostSlippageReadiness.executionAllowed) === true
  const reasonStatus: ReasonChainStatus = status === 'blocked'
    ? 'blocked'
    : status === 'watch_only'
      ? 'observation_only'
      : 'not_available'

  return {
    component: 'OKX route-cost/slippage readiness',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: status === 'blocked'
      ? `OKX route-cost/slippage readiness is blocked: routeBudgetRuntimeVerified=${readBoolean(readiness?.routeCostBudgetRuntimeVerified) ?? false}, paperTelemetry=${readBoolean(readiness?.paperExecutionTelemetryAvailable) ?? false}.`
      : `OKX route-cost/slippage readiness status=${status ?? 'missing'}; remains diagnostic only.`,
    evidencePaths: [
      sourceArtifacts.okxRouteCostSlippageReadiness,
      sourceArtifacts.routeCostBudget,
      sourceArtifacts.feeSnapshot,
      sourceArtifacts.feeSnapshotRefresh,
      'scripts/build_okx_route_cost_slippage_readiness.ts',
    ],
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['okx_route_cost_slippage_readiness_must_not_authorize_execution'] : []),
      ...(status ? [`okx_route_cost_slippage_readiness_status:${status}`] : ['okx_route_cost_slippage_readiness_status_missing']),
      ...blockers.slice(0, 24).map(blocker => `okx_route_cost_slippage:${blocker}`),
    ]),
    metrics: {
      status,
      researchOnly: readBoolean(okxRouteCostSlippageReadiness.researchOnly),
      diagnosticOnly: readBoolean(okxRouteCostSlippageReadiness.diagnosticOnly),
      promotionEligible: readBoolean(okxRouteCostSlippageReadiness.promotionEligible),
      paperTradingAllowed: readBoolean(okxRouteCostSlippageReadiness.paperTradingAllowed),
      liveTradingAllowed: readBoolean(okxRouteCostSlippageReadiness.liveTradingAllowed),
      executionAllowed: readBoolean(okxRouteCostSlippageReadiness.executionAllowed),
      publicOrderbookUsableForResearch: readBoolean(readiness?.publicOrderbookUsableForResearch),
      runtimeFeeSnapshotUsableForResearch: readBoolean(readiness?.runtimeFeeSnapshotUsableForResearch),
      routeCostBudgetRuntimeVerified: readBoolean(readiness?.routeCostBudgetRuntimeVerified),
      routeCostBudgetFresh: readBoolean(readiness?.routeCostBudgetFresh),
      paperExecutionTelemetryAvailable: readBoolean(readiness?.paperExecutionTelemetryAvailable),
      promotionGradeRouteCostEvidence: readBoolean(readiness?.promotionGradeRouteCostEvidence),
      orderbookStatus: readString(orderbook?.status),
      orderbookRowsBuilt: readNumber(orderbook?.rowsBuilt),
      orderbookBlockedRows: readNumber(orderbook?.blockedRows),
      orderbookMaxSpreadBps: readNumber(orderbook?.maxSpreadBps),
      orderbookMinDepth5Usd: readNumber(orderbook?.minDepth5Usd),
      requiredOrderbookSymbols: readStringArray(orderbook?.requiredOrderbookSymbols),
      requiredOrderbookPassedSymbols: readStringArray(orderbook?.requiredOrderbookPassedSymbols),
      requiredOrderbookBlockedSymbols: readStringArray(orderbook?.requiredOrderbookBlockedSymbols),
      requiredOrderbookMissingSymbols: readStringArray(orderbook?.requiredOrderbookMissingSymbols),
      requiredOrderbookAllPass: readBoolean(orderbook?.requiredOrderbookAllPass),
      feeSnapshotSource: readString(feeSnapshot?.source),
      feeSnapshotVerifiedByRuntime: readBoolean(feeSnapshot?.verifiedByRuntime),
      feeSnapshotStale: readBoolean(feeSnapshot?.stale),
      routeBudgetFeeSnapshotSource: readString(routeCostBudget?.feeSnapshotSource),
      routeBudgetFeeSnapshotVerifiedByRuntime: readBoolean(routeCostBudget?.feeSnapshotVerifiedByRuntime),
      routeBudgetFeeSnapshotMatchesRuntimeFeeSnapshot: readBoolean(routeCostBudget?.feeSnapshotMatchesRuntimeFeeSnapshot),
      routeBudgetFresh: !readBoolean(routeCostBudget?.stale),
      routeBudgetRoutesOverBudget: readStringArray(routeCostBudget?.routesOverBudget),
      selectedSafeResearchRoute: readString(routeCostBudget?.selectedSafeResearchRoute),
      recentOrderCount: readNumber(executionQuality?.recentOrderCount),
      slippageViolationCount: readNumber(executionQuality?.slippageViolationCount),
      completePredictedOpenEvidenceCoveragePct: readNumber(paperCostEvidence?.completePredictedOpenEvidenceCoveragePct),
      tradesWithExchangeReconciledCostEvidence: readNumber(paperCostEvidence?.tradesWithExchangeReconciledCostEvidence),
      paperFutureTelemetryStatus: readString(paperFutureTelemetry?.status),
      paperFutureTelemetryGapStatus: readString(paperFutureTelemetry?.telemetryGapStatus),
      paperFutureTelemetryMonitoringAgeMinutes: readNumber(paperFutureTelemetry?.telemetryGapMonitoringAgeMinutes),
      paperFutureTelemetryLatestClosedAt: readString(paperFutureTelemetry?.telemetryGapLatestClosedAt),
      paperFutureTelemetryLatestClosedBeforeMonitoringStart: readBoolean(paperFutureTelemetry?.telemetryGapLatestClosedBeforeMonitoringStart),
      paperFutureClosedRowsAfterMonitoringStart: readNumber(paperFutureTelemetry?.telemetryGapFutureClosedRowsAfterMonitoringStart),
      paperFutureRowsMissingPaperFillTelemetry: readNumber(paperFutureTelemetry?.telemetryGapFutureRowsMissingPaperFillTelemetry),
      paperFutureNewOpenRowsMissingPredictedOpenEvidence: readNumber(paperFutureTelemetry?.telemetryGapFutureNewOpenRowsMissingPredictedOpenEvidence),
    },
    nextActions: readStringArray(okxRouteCostSlippageReadiness.nextActions).length > 0
      ? readStringArray(okxRouteCostSlippageReadiness.nextActions)
      : [
          'Refresh OKX order-book snapshots and runtime fee snapshots.',
          'Keep route-cost/slippage readiness diagnostic-only until paper execution telemetry and release gates pass.',
        ],
  }
}

function buildAiScientistCryptoIntakeReason(
  aiScientistCryptoCandidateIntake: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!aiScientistCryptoCandidateIntake) {
    return {
      component: 'AI-Scientist crypto intake',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No AI-Scientist crypto candidate intake artifact is present.',
      evidencePaths: [
        sourceArtifacts.aiScientistCryptoCandidateIntake,
        '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl',
        resolve(process.env.OPENALICE_DATA_ROOT ?? 'data'),
        'scripts/build_ai_scientist_crypto_candidate_intake.ts',
      ],
      blockingReasons: [
        'ai_scientist_crypto_candidate_intake_missing',
        'ai_scientist_candidates_not_openalice_validated',
      ],
      metrics: {
        status: null,
        candidatesFound: 0,
        warehouseStatus: null,
      },
      nextActions: [
        'Run corepack pnpm research:ai-scientist:crypto-intake to monitor AI-Scientist candidates and external data warehouse state.',
        'Keep AI-Scientist outputs research-only until OpenAlice independently validates PIT, WFO, FDR, route cost, slippage, risk, trial ledger, prospective evidence, and paper telemetry.',
      ],
    }
  }

  const status = readString(aiScientistCryptoCandidateIntake.status)
  const counts = asRecord(aiScientistCryptoCandidateIntake.counts)
  const warehouse = asRecord(aiScientistCryptoCandidateIntake.externalDataWarehouse)
  const blockers = readStringArray(aiScientistCryptoCandidateIntake.blockers)
  const candidates = Array.isArray(aiScientistCryptoCandidateIntake.candidates)
    ? aiScientistCryptoCandidateIntake.candidates.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const topCandidate = candidates[0] ?? null
  const topEvidence = asRecord(topCandidate?.evidence)
  const topMetrics = asRecord(topCandidate?.metrics)
  const topPit = asRecord(topCandidate?.pitAndData)
  const topSafety = asRecord(topCandidate?.safety)
  const artifactAllowsExecution =
    readBoolean(aiScientistCryptoCandidateIntake.promotionEligible) === true ||
    readBoolean(aiScientistCryptoCandidateIntake.paperTradingAllowed) === true ||
    readBoolean(aiScientistCryptoCandidateIntake.liveTradingAllowed) === true
  const candidateSafetyViolation = candidates.some(candidate => readBoolean(asRecord(candidate.safety)?.safetyViolation) === true)
  const reasonStatus: ReasonChainStatus = status === 'research_only_blocked'
    ? 'observation_only'
    : status === 'blocked_missing_inputs' || status === 'blocked_no_candidates'
      ? 'blocked'
      : 'not_available'

  return {
    component: 'AI-Scientist crypto intake',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: candidates.length > 0
      ? `AI-Scientist crypto intake found ${candidates.length} research candidate(s); top=${readString(topCandidate?.candidateId) ?? 'unknown'} remains second-validation-only.`
      : `AI-Scientist crypto intake is blocked: status=${status ?? 'missing'}.`,
    evidencePaths: [
      sourceArtifacts.aiScientistCryptoCandidateIntake,
      '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl',
      readString(aiScientistCryptoCandidateIntake.warehouseRoot) ?? resolve(process.env.OPENALICE_DATA_ROOT ?? 'data'),
      'scripts/build_ai_scientist_crypto_candidate_intake.ts',
    ],
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['ai_scientist_intake_artifact_must_not_authorize_execution'] : []),
      ...(candidateSafetyViolation ? ['ai_scientist_candidate_safety_violation'] : []),
      ...(status ? [`ai_scientist_intake_status:${status}`] : ['ai_scientist_intake_status_missing']),
      ...blockers.slice(0, 24).map(blocker => `ai_scientist_intake:${blocker}`),
      'ai_scientist_outputs_require_openalice_second_validation',
      'ai_scientist_outputs_are_not_trading_authority',
    ]),
    metrics: {
      status,
      researchOnly: readBoolean(aiScientistCryptoCandidateIntake.researchOnly),
      diagnosticOnly: readBoolean(aiScientistCryptoCandidateIntake.diagnosticOnly),
      promotionEligible: readBoolean(aiScientistCryptoCandidateIntake.promotionEligible),
      paperTradingAllowed: readBoolean(aiScientistCryptoCandidateIntake.paperTradingAllowed),
      liveTradingAllowed: readBoolean(aiScientistCryptoCandidateIntake.liveTradingAllowed),
      aiScientistRoot: readString(aiScientistCryptoCandidateIntake.aiScientistRoot),
      warehouseRoot: readString(aiScientistCryptoCandidateIntake.warehouseRoot),
      warehouseStatus: readString(warehouse?.status),
      warehouseRootExists: readBoolean(warehouse?.rootExists),
      runDirsScanned: readNumber(counts?.runDirsScanned),
      sourceFilesScanned: readNumber(counts?.sourceFilesScanned),
      candidatesFound: readNumber(counts?.candidatesFound),
      runsWithTargetProof: readNumber(counts?.runsWithTargetProof),
      runsWithFinalHoldout: readNumber(counts?.runsWithFinalHoldout),
      runsWithWalkForward: readNumber(counts?.runsWithWalkForward),
      runsWithFundingFeatures: readNumber(counts?.runsWithFundingFeatures),
      safetyViolations: readNumber(counts?.safetyViolations),
      targetReached: readNumber(counts?.targetReached),
      topRunId: readString(topCandidate?.runId),
      topFamily: readString(topCandidate?.family),
      topCandidateId: readString(topCandidate?.candidateId),
      topTargetProofStatus: readString(topEvidence?.targetProofStatus),
      topImprovementStatus: readString(topEvidence?.improvementStatus),
      topProofStatus: readString(topEvidence?.proofStatus),
      topTargetReached: readBoolean(topEvidence?.targetReached),
      topFinalHoldoutPresent: readBoolean(topEvidence?.finalHoldoutPresent),
      topWalkForwardPresent: readBoolean(topEvidence?.walkForwardPresent),
      topValidationDirectionalAccuracy: readNumber(topMetrics?.validationDirectionalAccuracy),
      topValidationHighConfidencePrecision: readNumber(topMetrics?.validationHighConfidencePrecision),
      topValidationHighConfidenceCoverage: readNumber(topMetrics?.validationHighConfidenceCoverage),
      topMeanFinalHoldoutDirectionalAccuracy: readNumber(topMetrics?.meanFinalHoldoutDirectionalAccuracy),
      topFoldPassRate: readNumber(topMetrics?.foldPassRate),
      topHoldoutNotUsedForSelection: readBoolean(topPit?.holdoutNotUsedForSelection),
      topFundingFeatureActive: readBoolean(topPit?.fundingFeatureActive),
      topFundingAvailableTimePolicy: readString(topPit?.fundingAvailableTimePolicy),
      topOpenAlicePitAuditPassed: readBoolean(topPit?.openAlicePitAuditPassed),
      topSafetyViolation: readBoolean(topSafety?.safetyViolation),
      topOpenAliceIntakeDecision: readString(topCandidate?.openAliceIntakeDecision),
    },
    nextActions: readStringArray(aiScientistCryptoCandidateIntake.nextActions).length > 0
      ? readStringArray(aiScientistCryptoCandidateIntake.nextActions)
      : [
          'Keep monitoring AI-Scientist crypto runs, but import only locked-source candidates into OpenAlice research incubation.',
          'Prioritize candidates that include walk-forward folds, final holdout, leakage controls, funding available-time policy, and explicit safety flags.',
        ],
  }
}

function buildAiScientistSecondValidationQueueReason(
  aiScientistSecondValidationQueue: UnknownRecord | null,
  aiScientistCandidateSourceManifest: UnknownRecord | null,
  aiScientistSecondValidationReadiness: UnknownRecord | null,
  aiScientistPitReproductionPlan: UnknownRecord | null,
  aiScientistPitRebuildQueue: UnknownRecord | null,
  aiScientistOhlcvNativeRebuildPlan: UnknownRecord | null,
  aiScientistOhlcvDailySupplementPlan: UnknownRecord | null,
  aiScientistOhlcvNativeRows: UnknownRecord | null,
  aiScientistPitNativeRebuildStatus: UnknownRecord | null,
  aiScientistPitInputDataset: UnknownRecord | null,
  aiScientistPitContractStatus: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!aiScientistSecondValidationQueue) {
    return {
      component: 'AI-Scientist second-validation queue',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No OpenAlice second-validation queue exists for AI-Scientist crypto candidates.',
      evidencePaths: [
        sourceArtifacts.aiScientistSecondValidationQueue,
        sourceArtifacts.aiScientistCandidateSourceManifest,
        sourceArtifacts.aiScientistSecondValidationReadiness,
        sourceArtifacts.aiScientistPitReproductionPlan,
        sourceArtifacts.aiScientistPitRebuildQueue,
        sourceArtifacts.aiScientistOhlcvNativeRebuildPlan,
        sourceArtifacts.aiScientistOhlcvDailySupplementPlan,
        sourceArtifacts.aiScientistOhlcvNativeRows,
        sourceArtifacts.aiScientistPitNativeRebuildStatus,
        sourceArtifacts.aiScientistPitInputDataset,
        sourceArtifacts.aiScientistPitContractStatus,
        sourceArtifacts.aiScientistCryptoCandidateIntake,
        'scripts/build_ai_scientist_openalice_second_validation_queue.ts',
        'scripts/build_ai_scientist_openalice_candidate_source_manifest.ts',
        'scripts/build_ai_scientist_openalice_second_validation_readiness.ts',
        'scripts/build_ai_scientist_openalice_pit_reproduction_plan.ts',
        'scripts/build_ai_scientist_openalice_pit_rebuild_queue.ts',
        'scripts/build_ai_scientist_openalice_ohlcv_native_rebuild_plan.ts',
        'scripts/build_ai_scientist_openalice_ohlcv_daily_supplement_plan.ts',
        'scripts/build_ai_scientist_openalice_pit_native_rebuild_status.ts',
        'scripts/build_ai_scientist_openalice_pit_input_dataset.ts',
        'scripts/build_ai_scientist_openalice_pit_contract_status.ts',
      ],
      blockingReasons: [
        'ai_scientist_second_validation_queue_missing',
        'ai_scientist_candidates_not_openalice_validated',
      ],
      metrics: {
        status: null,
        queuedCandidates: 0,
        requiredGateCount: 0,
      },
      nextActions: [
        'Run corepack pnpm research:ai-scientist:second-validation-queue to expand intake candidates into OpenAlice validation work.',
        'Keep queue rows research-only until OpenAlice validation artifacts exist for every required gate.',
      ],
    }
  }

  const status = readString(aiScientistSecondValidationQueue.status)
  const counts = asRecord(aiScientistSecondValidationQueue.counts)
  const queue = Array.isArray(aiScientistSecondValidationQueue.queue)
    ? aiScientistSecondValidationQueue.queue.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const topQueued = queue[0] ?? null
  const blockers = readStringArray(aiScientistSecondValidationQueue.blockers)
  const sourceManifestStatus = readString(aiScientistCandidateSourceManifest?.status)
  const sourceManifestCounts = asRecord(aiScientistCandidateSourceManifest?.counts)
  const sourceManifestAllowsExecution =
    readBoolean(aiScientistCandidateSourceManifest?.promotionEligible) === true ||
    readBoolean(aiScientistCandidateSourceManifest?.paperTradingAllowed) === true ||
    readBoolean(aiScientistCandidateSourceManifest?.liveTradingAllowed) === true ||
    readBoolean(aiScientistCandidateSourceManifest?.executionAllowed) === true
  const sourceManifestBlockers = readStringArray(aiScientistCandidateSourceManifest?.blockers)
  const readinessStatus = readString(aiScientistSecondValidationReadiness?.status)
  const readinessCounts = asRecord(aiScientistSecondValidationReadiness?.counts)
  const readinessAllowsExecution =
    readBoolean(aiScientistSecondValidationReadiness?.promotionEligible) === true ||
    readBoolean(aiScientistSecondValidationReadiness?.paperTradingAllowed) === true ||
    readBoolean(aiScientistSecondValidationReadiness?.liveTradingAllowed) === true ||
    readBoolean(aiScientistSecondValidationReadiness?.executionAllowed) === true
  const readinessBlockers = readStringArray(aiScientistSecondValidationReadiness?.blockers)
  const pitPlanStatus = readString(aiScientistPitReproductionPlan?.status)
  const pitPlanCounts = asRecord(aiScientistPitReproductionPlan?.counts)
  const pitPlanAllowsExecution =
    readBoolean(aiScientistPitReproductionPlan?.promotionEligible) === true ||
    readBoolean(aiScientistPitReproductionPlan?.paperTradingAllowed) === true ||
    readBoolean(aiScientistPitReproductionPlan?.liveTradingAllowed) === true ||
    readBoolean(aiScientistPitReproductionPlan?.executionAllowed) === true
  const pitPlanBlockers = readStringArray(aiScientistPitReproductionPlan?.blockers)
  const pitRebuildQueueStatus = readString(aiScientistPitRebuildQueue?.status)
  const pitRebuildQueueCounts = asRecord(aiScientistPitRebuildQueue?.counts)
  const pitRebuildQueueAllowsExecution =
    readBoolean(aiScientistPitRebuildQueue?.promotionEligible) === true ||
    readBoolean(aiScientistPitRebuildQueue?.paperTradingAllowed) === true ||
    readBoolean(aiScientistPitRebuildQueue?.liveTradingAllowed) === true ||
    readBoolean(aiScientistPitRebuildQueue?.executionAllowed) === true
  const pitRebuildQueueBlockers = readStringArray(aiScientistPitRebuildQueue?.blockers)
  const ohlcvNativeRebuildPlanStatus = readString(aiScientistOhlcvNativeRebuildPlan?.status)
  const ohlcvNativeRebuildPlanCounts = asRecord(aiScientistOhlcvNativeRebuildPlan?.counts)
  const ohlcvNativeRebuildPlanAllowsExecution =
    readBoolean(aiScientistOhlcvNativeRebuildPlan?.promotionEligible) === true ||
    readBoolean(aiScientistOhlcvNativeRebuildPlan?.paperTradingAllowed) === true ||
    readBoolean(aiScientistOhlcvNativeRebuildPlan?.liveTradingAllowed) === true ||
    readBoolean(aiScientistOhlcvNativeRebuildPlan?.executionAllowed) === true
  const ohlcvNativeRebuildPlanBlockers = readStringArray(aiScientistOhlcvNativeRebuildPlan?.blockers)
  const ohlcvDailySupplementStatus = readString(aiScientistOhlcvDailySupplementPlan?.status)
  const ohlcvDailySupplementCounts = asRecord(aiScientistOhlcvDailySupplementPlan?.counts)
  const ohlcvDailySupplementAllowsExecution =
    readBoolean(aiScientistOhlcvDailySupplementPlan?.promotionEligible) === true ||
    readBoolean(aiScientistOhlcvDailySupplementPlan?.paperTradingAllowed) === true ||
    readBoolean(aiScientistOhlcvDailySupplementPlan?.liveTradingAllowed) === true ||
    readBoolean(aiScientistOhlcvDailySupplementPlan?.executionAllowed) === true
  const ohlcvDailySupplementBlockers = readStringArray(aiScientistOhlcvDailySupplementPlan?.blockers)
  const ohlcvNativeRowsStatus = readString(aiScientistOhlcvNativeRows?.status)
  const ohlcvNativeRowsCounts = asRecord(aiScientistOhlcvNativeRows?.counts)
  const ohlcvNativeRowsAllowsExecution =
    readBoolean(aiScientistOhlcvNativeRows?.promotionEligible) === true ||
    readBoolean(aiScientistOhlcvNativeRows?.paperTradingAllowed) === true ||
    readBoolean(aiScientistOhlcvNativeRows?.liveTradingAllowed) === true ||
    readBoolean(aiScientistOhlcvNativeRows?.executionAllowed) === true
  const ohlcvNativeRowsBlockers = readStringArray(aiScientistOhlcvNativeRows?.blockers)
  const pitNativeRebuildStatus = readString(aiScientistPitNativeRebuildStatus?.status)
  const pitNativeRebuildCounts = asRecord(aiScientistPitNativeRebuildStatus?.counts)
  const pitNativeRebuildAllowsExecution =
    readBoolean(aiScientistPitNativeRebuildStatus?.promotionEligible) === true ||
    readBoolean(aiScientistPitNativeRebuildStatus?.paperTradingAllowed) === true ||
    readBoolean(aiScientistPitNativeRebuildStatus?.liveTradingAllowed) === true ||
    readBoolean(aiScientistPitNativeRebuildStatus?.executionAllowed) === true
  const pitNativeRebuildBlockers = readStringArray(aiScientistPitNativeRebuildStatus?.blockers)
  const pitInputDatasetStatus = readString(aiScientistPitInputDataset?.status)
  const pitInputDatasetCounts = asRecord(aiScientistPitInputDataset?.counts)
  const pitInputDatasetAllowsExecution =
    readBoolean(aiScientistPitInputDataset?.promotionEligible) === true ||
    readBoolean(aiScientistPitInputDataset?.paperTradingAllowed) === true ||
    readBoolean(aiScientistPitInputDataset?.liveTradingAllowed) === true ||
    readBoolean(aiScientistPitInputDataset?.executionAllowed) === true
  const pitInputDatasetBlockers = readStringArray(aiScientistPitInputDataset?.blockers)
  const pitContractStatus = readString(aiScientistPitContractStatus?.status)
  const pitContractCounts = asRecord(aiScientistPitContractStatus?.counts)
  const pitContractCoverage = asRecord(aiScientistPitContractStatus?.coverage)
  const pitContractAllowsExecution =
    readBoolean(aiScientistPitContractStatus?.promotionEligible) === true ||
    readBoolean(aiScientistPitContractStatus?.paperTradingAllowed) === true ||
    readBoolean(aiScientistPitContractStatus?.liveTradingAllowed) === true ||
    readBoolean(aiScientistPitContractStatus?.executionAllowed) === true
  const pitContractBlockers = readStringArray(aiScientistPitContractStatus?.blockers)
  const artifactAllowsExecution =
    readBoolean(aiScientistSecondValidationQueue.promotionEligible) === true ||
    readBoolean(aiScientistSecondValidationQueue.paperTradingAllowed) === true ||
    readBoolean(aiScientistSecondValidationQueue.liveTradingAllowed) === true ||
    readBoolean(aiScientistSecondValidationQueue.executionAllowed) === true
  const rowAllowsExecution = queue.some(row =>
    readBoolean(row.promotionEligible) === true ||
    readBoolean(row.paperTradingAllowed) === true ||
    readBoolean(row.liveTradingAllowed) === true ||
    readBoolean(row.executionAllowed) === true)
  const reasonStatus: ReasonChainStatus = status === 'queued_research_only'
    ? 'observation_only'
    : status === 'blocked_missing_intake' || status === 'blocked_no_candidates'
      ? 'blocked'
      : 'not_available'

  return {
    component: 'AI-Scientist second-validation queue',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: queue.length > 0
      ? `AI-Scientist second-validation queue has ${queue.length} research-only candidate(s); top=${readString(topQueued?.candidateId) ?? 'unknown'} has no trading authority.`
      : `AI-Scientist second-validation queue is blocked: status=${status ?? 'missing'}.`,
    evidencePaths: [
      sourceArtifacts.aiScientistSecondValidationQueue,
      sourceArtifacts.aiScientistCandidateSourceManifest,
      sourceArtifacts.aiScientistSecondValidationReadiness,
      sourceArtifacts.aiScientistPitReproductionPlan,
      sourceArtifacts.aiScientistPitRebuildQueue,
      sourceArtifacts.aiScientistOhlcvNativeRebuildPlan,
      sourceArtifacts.aiScientistOhlcvDailySupplementPlan,
      sourceArtifacts.aiScientistOhlcvNativeRows,
      sourceArtifacts.aiScientistPitNativeRebuildStatus,
      sourceArtifacts.aiScientistPitInputDataset,
      sourceArtifacts.aiScientistPitContractStatus,
      sourceArtifacts.aiScientistCryptoCandidateIntake,
      'scripts/build_ai_scientist_openalice_second_validation_queue.ts',
      'scripts/build_ai_scientist_openalice_candidate_source_manifest.ts',
      'scripts/build_ai_scientist_openalice_second_validation_readiness.ts',
      'scripts/build_ai_scientist_openalice_pit_reproduction_plan.ts',
      'scripts/build_ai_scientist_openalice_pit_rebuild_queue.ts',
      'scripts/build_ai_scientist_openalice_ohlcv_native_rebuild_plan.ts',
      'scripts/build_ai_scientist_openalice_ohlcv_daily_supplement_plan.ts',
      'scripts/materialize_ai_scientist_ohlcv_native_rows.ts',
      'scripts/build_ai_scientist_openalice_pit_native_rebuild_status.ts',
      'scripts/build_ai_scientist_openalice_pit_input_dataset.ts',
      'scripts/build_ai_scientist_openalice_pit_contract_status.ts',
    ],
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['ai_scientist_second_validation_queue_must_not_authorize_execution'] : []),
      ...(rowAllowsExecution ? ['ai_scientist_second_validation_queue_row_must_not_authorize_execution'] : []),
      ...(sourceManifestAllowsExecution ? ['ai_scientist_source_manifest_must_not_authorize_execution'] : []),
      ...(readinessAllowsExecution ? ['ai_scientist_readiness_must_not_authorize_execution'] : []),
      ...(pitPlanAllowsExecution ? ['ai_scientist_pit_reproduction_plan_must_not_authorize_execution'] : []),
      ...(pitRebuildQueueAllowsExecution ? ['ai_scientist_pit_rebuild_queue_must_not_authorize_execution'] : []),
      ...(ohlcvNativeRebuildPlanAllowsExecution ? ['ai_scientist_ohlcv_native_rebuild_plan_must_not_authorize_execution'] : []),
      ...(ohlcvDailySupplementAllowsExecution ? ['ai_scientist_ohlcv_daily_supplement_plan_must_not_authorize_execution'] : []),
      ...(ohlcvNativeRowsAllowsExecution ? ['ai_scientist_ohlcv_native_rows_must_not_authorize_execution'] : []),
      ...(pitNativeRebuildAllowsExecution ? ['ai_scientist_pit_native_rebuild_status_must_not_authorize_execution'] : []),
      ...(pitInputDatasetAllowsExecution ? ['ai_scientist_pit_input_dataset_must_not_authorize_execution'] : []),
      ...(pitContractAllowsExecution ? ['ai_scientist_pit_contract_status_must_not_authorize_execution'] : []),
      ...(status ? [`ai_scientist_second_validation_queue_status:${status}`] : ['ai_scientist_second_validation_queue_status_missing']),
      ...(sourceManifestStatus ? [`ai_scientist_source_manifest_status:${sourceManifestStatus}`] : ['ai_scientist_source_manifest_missing']),
      ...(readinessStatus ? [`ai_scientist_second_validation_readiness_status:${readinessStatus}`] : ['ai_scientist_second_validation_readiness_missing']),
      ...(pitPlanStatus ? [`ai_scientist_pit_reproduction_plan_status:${pitPlanStatus}`] : ['ai_scientist_pit_reproduction_plan_missing']),
      ...(pitRebuildQueueStatus ? [`ai_scientist_pit_rebuild_queue_status:${pitRebuildQueueStatus}`] : ['ai_scientist_pit_rebuild_queue_missing']),
      ...(ohlcvNativeRebuildPlanStatus ? [`ai_scientist_ohlcv_native_rebuild_plan_status:${ohlcvNativeRebuildPlanStatus}`] : ['ai_scientist_ohlcv_native_rebuild_plan_missing']),
      ...(ohlcvDailySupplementStatus ? [`ai_scientist_ohlcv_daily_supplement_plan_status:${ohlcvDailySupplementStatus}`] : ['ai_scientist_ohlcv_daily_supplement_plan_missing']),
      ...(ohlcvNativeRowsStatus ? [`ai_scientist_ohlcv_native_rows_status:${ohlcvNativeRowsStatus}`] : ['ai_scientist_ohlcv_native_rows_missing']),
      ...(pitNativeRebuildStatus ? [`ai_scientist_pit_native_rebuild_status:${pitNativeRebuildStatus}`] : ['ai_scientist_pit_native_rebuild_status_missing']),
      ...(pitInputDatasetStatus ? [`ai_scientist_pit_input_dataset_status:${pitInputDatasetStatus}`] : ['ai_scientist_pit_input_dataset_missing']),
      ...(pitContractStatus ? [`ai_scientist_pit_contract_status:${pitContractStatus}`] : ['ai_scientist_pit_contract_status_missing']),
      ...blockers.slice(0, 24).map(blocker => `ai_scientist_second_validation_queue:${blocker}`),
      ...sourceManifestBlockers.slice(0, 12).map(blocker => `ai_scientist_source_manifest:${blocker}`),
      ...readinessBlockers.slice(0, 12).map(blocker => `ai_scientist_second_validation_readiness:${blocker}`),
      ...pitPlanBlockers.slice(0, 12).map(blocker => `ai_scientist_pit_reproduction_plan:${blocker}`),
      ...pitRebuildQueueBlockers.slice(0, 12).map(blocker => `ai_scientist_pit_rebuild_queue:${blocker}`),
      ...ohlcvNativeRebuildPlanBlockers.slice(0, 12).map(blocker => `ai_scientist_ohlcv_native_rebuild_plan:${blocker}`),
      ...ohlcvDailySupplementBlockers.slice(0, 12).map(blocker => `ai_scientist_ohlcv_daily_supplement_plan:${blocker}`),
      ...ohlcvNativeRowsBlockers.slice(0, 12).map(blocker => `ai_scientist_ohlcv_native_rows:${blocker}`),
      ...pitNativeRebuildBlockers.slice(0, 12).map(blocker => `ai_scientist_pit_native_rebuild:${blocker}`),
      ...pitInputDatasetBlockers.slice(0, 12).map(blocker => `ai_scientist_pit_input_dataset:${blocker}`),
      ...pitContractBlockers.slice(0, 12).map(blocker => `ai_scientist_pit_contract_status:${blocker}`),
      'ai_scientist_openalice_second_validation_not_completed',
      'ai_scientist_outputs_are_not_trading_authority',
    ]),
    metrics: {
      status,
      researchOnly: readBoolean(aiScientistSecondValidationQueue.researchOnly),
      diagnosticOnly: readBoolean(aiScientistSecondValidationQueue.diagnosticOnly),
      promotionEligible: readBoolean(aiScientistSecondValidationQueue.promotionEligible),
      paperTradingAllowed: readBoolean(aiScientistSecondValidationQueue.paperTradingAllowed),
      liveTradingAllowed: readBoolean(aiScientistSecondValidationQueue.liveTradingAllowed),
      executionAllowed: readBoolean(aiScientistSecondValidationQueue.executionAllowed),
      intakeCandidates: readNumber(counts?.intakeCandidates),
      queuedCandidates: readNumber(counts?.queuedCandidates),
      blockedSafetyViolations: readNumber(counts?.blockedSafetyViolations),
      requiredGateCount: readNumber(counts?.requiredGateCount),
      candidateSuppliedUnverifiedGateCount: readNumber(counts?.candidateSuppliedUnverifiedGateCount),
      missingGateCount: readNumber(counts?.missingGateCount),
      topQueueStatus: readString(topQueued?.queueStatus),
      topRunId: readString(topQueued?.runId),
      topFamily: readString(topQueued?.family),
      topCandidateId: readString(topQueued?.candidateId),
      topExecutionAllowed: readBoolean(topQueued?.executionAllowed),
      topRequiredGateCount: Array.isArray(topQueued?.requiredValidationGates)
        ? topQueued.requiredValidationGates.length
        : null,
      sourceManifestStatus,
      sourceManifestCandidatesLocked: readNumber(sourceManifestCounts?.candidatesLocked),
      sourceManifestSourceFilesExpected: readNumber(sourceManifestCounts?.sourceFilesExpected),
      sourceManifestSourceFilesPresent: readNumber(sourceManifestCounts?.sourceFilesPresent),
      sourceManifestSourceFilesMissing: readNumber(sourceManifestCounts?.sourceFilesMissing),
      readinessStatus,
      readinessCandidatesReadyForReproduction: readNumber(readinessCounts?.candidatesReadyForOpenAliceReproduction),
      readinessTotalGates: readNumber(readinessCounts?.totalGates),
      readinessMissingOpenAliceEvidenceGates: readNumber(readinessCounts?.missingOpenAliceEvidenceGates),
      readinessCandidateSuppliedUnverifiedGates: readNumber(readinessCounts?.candidateSuppliedUnverifiedGates),
      pitReproductionPlanStatus: pitPlanStatus,
      pitReproductionCandidatesPlanned: readNumber(pitPlanCounts?.candidatesPlanned),
      pitReproductionCandidatesReady: readNumber(pitPlanCounts?.candidatesReadyForOpenAlicePitReproduction),
      pitReproductionCsvInputFiles: readNumber(pitPlanCounts?.csvInputFiles),
      pitReproductionCsvFilesWithAvailableAt: readNumber(pitPlanCounts?.csvFilesWithExplicitAvailableAt),
      pitReproductionCsvFilesWithObservedOrFetchedAt: readNumber(pitPlanCounts?.csvFilesWithObservedOrFetchedAt),
      pitReproductionWarehouseLinkedInputs: readNumber(pitPlanCounts?.openAliceWarehouseLinkedInputs),
      pitRebuildQueueStatus,
      pitRebuildTasks: readNumber(pitRebuildQueueCounts?.rebuildTasks),
      pitRebuildOpenTasks: readNumber(pitRebuildQueueCounts?.openTasks),
      pitRebuildMissingEventTimeTasks: readNumber(pitRebuildQueueCounts?.missingEventTimeTasks),
      pitRebuildMissingAvailableAtTasks: readNumber(pitRebuildQueueCounts?.missingAvailableAtTasks),
      pitRebuildMissingObservedOrFetchedAtTasks: readNumber(pitRebuildQueueCounts?.missingObservedOrFetchedAtTasks),
      pitRebuildIncompleteWarehouseLineageTasks: readNumber(pitRebuildQueueCounts?.incompleteWarehouseLineageTasks),
      ohlcvNativeRebuildPlanStatus,
      ohlcvNativeRebuildMaterializationCandidateTasks: readNumber(ohlcvNativeRebuildPlanCounts?.materializationCandidateTasks),
      ohlcvNativeRebuildOhlcvTasksAssessed: readNumber(ohlcvNativeRebuildPlanCounts?.ohlcvTasksAssessed),
      ohlcvNativeRebuildMissingArchiveMonths: readNumber(ohlcvNativeRebuildPlanCounts?.missingArchiveMonths),
      ohlcvNativeRebuildMatchedZipFiles: readNumber(ohlcvNativeRebuildPlanCounts?.matchedZipFiles),
      ohlcvDailySupplementStatus,
      ohlcvDailySupplementEntries: readNumber(ohlcvDailySupplementCounts?.uniqueSupplementEntries),
      ohlcvDailySupplementLocal: (readNumber(ohlcvDailySupplementCounts?.localExists) ?? 0) + (readNumber(ohlcvDailySupplementCounts?.downloaded) ?? 0),
      ohlcvDailySupplementRemoteAvailable: readNumber(ohlcvDailySupplementCounts?.remoteAvailable),
      ohlcvDailySupplementRemoteMissing: readNumber(ohlcvDailySupplementCounts?.remoteMissing),
      ohlcvDailySupplementFailed: readNumber(ohlcvDailySupplementCounts?.failed),
      ohlcvDailySupplementNotChecked: readNumber(ohlcvDailySupplementCounts?.notChecked),
      ohlcvNativeRowsStatus,
      ohlcvNativeRowsWritten: readNumber(ohlcvNativeRowsCounts?.rowsWritten),
      ohlcvNativeRowsTasksMaterialized: readNumber(ohlcvNativeRowsCounts?.tasksMaterialized),
      ohlcvNativeRowsPromotionGradeRows: readNumber(ohlcvNativeRowsCounts?.promotionGradeRows),
      ohlcvNativeRowsDistinctSymbols: readNumber(ohlcvNativeRowsCounts?.distinctSymbols),
      pitNativeRebuildStatus,
      pitNativeRebuildAssessedTasks: readNumber(pitNativeRebuildCounts?.assessedTasks),
      pitNativeRebuildAutoEligibleTasks: readNumber(pitNativeRebuildCounts?.autoRebuildEligibleTasks),
      pitNativeRebuildCollectorUpgradeTasks: readNumber(pitNativeRebuildCounts?.requiredCollectorUpgradeTasks),
      pitNativeRebuildRawKlineManifestWithPromotionGradeTimeFieldsTasks: readNumber(pitNativeRebuildCounts?.rawKlineManifestWithPromotionGradeTimeFieldsTasks),
      pitNativeRebuildDerivativesPitUsableTasks: readNumber(pitNativeRebuildCounts?.derivativesPitUsableTasks),
      pitInputDatasetStatus,
      pitInputRowsNormalized: readNumber(pitInputDatasetCounts?.rowsNormalized),
      pitInputRowsRead: readNumber(pitInputDatasetCounts?.rowsRead),
      pitInputPromotionGradeRows: readNumber(pitInputDatasetCounts?.promotionGradeRows),
      pitInputDistinctSymbols: readNumber(pitInputDatasetCounts?.distinctSymbols),
      pitInputObservedAtBasis: aiScientistPitInputDataset ? 'source_file_mtime_recovered' : null,
      pitInputAvailableAtBasis: aiScientistPitInputDataset ? 'derived_bar_close_time' : null,
      pitContractStatus,
      pitContractRowsScanned: readNumber(pitContractCounts?.rowsScanned),
      pitContractRowExplicitAvailableAt: readNumber(pitContractCounts?.rowsWithRowExplicitAvailableAt),
      pitContractRowExplicitObservedOrFetchedAt: readNumber(pitContractCounts?.rowsWithRowExplicitObservedOrFetchedAt),
      pitContractPromotionGradeRows: readNumber(pitContractCounts?.rowsPromotionGrade),
      pitContractRowExplicitAvailableAtPct: readNumber(pitContractCoverage?.rowExplicitAvailableAtPct),
      pitContractRowExplicitObservedOrFetchedAtPct: readNumber(pitContractCoverage?.rowExplicitObservedOrFetchedAtPct),
      pitContractPromotionGradePct: readNumber(pitContractCoverage?.promotionGradePct),
    },
    nextActions: readStringArray(aiScientistSecondValidationQueue.nextActions).length > 0
      ? readStringArray(aiScientistSecondValidationQueue.nextActions)
      : [
          'Select at most one queued candidate for OpenAlice reproduction with locked manifests and PIT-safe features.',
          'Do not treat candidate-supplied walk-forward or holdout metrics as OpenAlice proof.',
        ],
  }
}

function buildOhlcvCollectorPitContractReason(
  collectorPitStatus: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!collectorPitStatus) {
    return {
      component: 'OHLCV collector PIT contract',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No row-explicit OKX OHLCV collector PIT contract artifact is present.',
      evidencePaths: [
        sourceArtifacts.ohlcvCollectorPitContractStatus,
        DEFAULT_COLLECTOR_PIT_ROWS_PATH,
        'scripts/accumulate_live_data.ts',
        'scripts/accumulate_5m_data.ts',
        'scripts/lib/ohlcv_collector_pit.ts',
        'scripts/build_openalice_ohlcv_collector_pit_contract_status.ts',
      ],
      blockingReasons: [
        'ohlcv_collector_pit_contract_status_missing',
        'row_explicit_collector_pit_monitor_missing',
      ],
      metrics: {
        status: null,
        rowsScanned: 0,
      },
      nextActions: [
        'Run OKX public OHLCV collectors to append row-explicit observedAt/fetchedAt/availableAt sidecar rows.',
        'Run scripts/build_openalice_ohlcv_collector_pit_contract_status.ts after collection.',
      ],
    }
  }

  const status = readString(collectorPitStatus.status)
  const counts = asRecord(collectorPitStatus.counts)
  const coverage = asRecord(collectorPitStatus.coverage)
  const blockers = readStringArray(collectorPitStatus.blockers)
  const allowsExecution =
    readBoolean(collectorPitStatus.promotionEligible) === true ||
    readBoolean(collectorPitStatus.paperTradingAllowed) === true ||
    readBoolean(collectorPitStatus.liveTradingAllowed) === true ||
    readBoolean(collectorPitStatus.executionAllowed) === true
  const rowsScanned = readNumber(counts?.rowsScanned) ?? 0
  const reasonStatus: ReasonChainStatus = status === 'ready_for_pit_audit_research_only'
    ? 'observation_only'
    : status?.startsWith('blocked') === true
      ? 'blocked'
      : 'not_available'

  return {
    component: 'OHLCV collector PIT contract',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: rowsScanned > 0
      ? `OKX OHLCV collector PIT sidecar has ${rowsScanned} row-explicit research row(s); promotion-grade rows remain unavailable.`
      : `OKX OHLCV collector PIT contract is blocked: status=${status ?? 'missing'}.`,
    evidencePaths: [
      sourceArtifacts.ohlcvCollectorPitContractStatus,
      readString(asRecord(collectorPitStatus.sourceArtifacts)?.collectorPitRows) ?? DEFAULT_COLLECTOR_PIT_ROWS_PATH,
      'scripts/accumulate_live_data.ts',
      'scripts/accumulate_5m_data.ts',
      'scripts/lib/ohlcv_collector_pit.ts',
      'scripts/build_openalice_ohlcv_collector_pit_contract_status.ts',
    ],
    blockingReasons: uniqueStrings([
      ...(allowsExecution ? ['ohlcv_collector_pit_status_must_not_authorize_execution'] : []),
      ...(status ? [`ohlcv_collector_pit_status:${status}`] : ['ohlcv_collector_pit_status_missing']),
      ...blockers.slice(0, 16).map(blocker => `ohlcv_collector_pit:${blocker}`),
      'ohlcv_collector_pit_research_only_not_trading_authority',
    ]),
    metrics: {
      status,
      researchOnly: readBoolean(collectorPitStatus.researchOnly),
      diagnosticOnly: readBoolean(collectorPitStatus.diagnosticOnly),
      promotionEligible: readBoolean(collectorPitStatus.promotionEligible),
      paperTradingAllowed: readBoolean(collectorPitStatus.paperTradingAllowed),
      liveTradingAllowed: readBoolean(collectorPitStatus.liveTradingAllowed),
      executionAllowed: readBoolean(collectorPitStatus.executionAllowed),
      rowsScanned,
      rowParseErrors: readNumber(counts?.rowParseErrors),
      rowsWithEventTime: readNumber(counts?.rowsWithEventTime),
      rowsWithAvailableAt: readNumber(counts?.rowsWithAvailableAt),
      rowsWithObservedAt: readNumber(counts?.rowsWithObservedAt),
      rowsWithFetchedAt: readNumber(counts?.rowsWithFetchedAt),
      rowExplicitAvailableAt: readNumber(counts?.rowsWithRowExplicitAvailableAt),
      rowExplicitObservedOrFetchedAt: readNumber(counts?.rowsWithRowExplicitObservedOrFetchedAt),
      rowsPromotionGrade: readNumber(counts?.rowsPromotionGrade),
      rowsWithQualityBlockers: readNumber(counts?.rowsWithQualityBlockers),
      distinctSymbols: readNumber(counts?.distinctSymbols),
      distinctInstIds: readNumber(counts?.distinctInstIds),
      distinctTimeframes: readNumber(counts?.distinctTimeframes),
      distinctCollectionRuns: readNumber(counts?.distinctCollectionRuns),
      rowExplicitAvailableAtPct: readNumber(coverage?.rowExplicitAvailableAtPct),
      rowExplicitObservedOrFetchedAtPct: readNumber(coverage?.rowExplicitObservedOrFetchedAtPct),
      promotionGradePct: readNumber(coverage?.promotionGradePct),
    },
    nextActions: readStringArray(collectorPitStatus.nextActions).length > 0
      ? readStringArray(collectorPitStatus.nextActions)
      : [
          'Keep appending collector sidecar rows and build a separate PIT audit before promotion-grade labeling.',
        ],
  }
}

function buildStrategyDefectMonitorReason(
  strategyDefectMonitor: UnknownRecord | null,
  strategyDefectRegistry: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!strategyDefectMonitor) {
    return {
      component: 'Strategy defect monitor',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No strategy defect monitor artifact is present.',
      evidencePaths: [
        sourceArtifacts.strategyDefectMonitor,
        sourceArtifacts.strategyDefectRegistry,
        '/Users/kino/Downloads/openalice_strategy_improvement.md',
        'scripts/build_strategy_defect_monitor.ts',
        'scripts/build_strategy_defect_registry.ts',
      ],
      blockingReasons: [
        'strategy_defect_monitor_missing',
        'strategy_defects_not_machine_monitored',
      ],
      metrics: {
        status: null,
        blockedFindings: null,
      },
      nextActions: [
        'Run corepack pnpm research:strategy:defect-monitor after strategy or evidence changes.',
        'Track spread/slippage, PIT carry data, microstructure noise, exits, sizing, and stale-data gates as explicit findings.',
      ],
    }
  }

  const status = readString(strategyDefectMonitor.status)
  const summary = asRecord(strategyDefectMonitor.summary)
  const blockers = readStringArray(strategyDefectMonitor.blockers)
  const registryStatus = readString(strategyDefectRegistry?.status)
  const registrySummary = asRecord(strategyDefectRegistry?.summary)
  const registryBlockers = readStringArray(strategyDefectRegistry?.blockers)
  const registryAllowsExecution =
    readBoolean(strategyDefectRegistry?.promotionEligible) === true ||
    readBoolean(strategyDefectRegistry?.paperTradingAllowed) === true ||
    readBoolean(strategyDefectRegistry?.liveTradingAllowed) === true
  const findings = Array.isArray(strategyDefectMonitor.findings)
    ? strategyDefectMonitor.findings.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const blockedFindings = findings.filter(finding => readString(finding.status) === 'blocked')
  const topBlocked = blockedFindings[0] ?? null
  const artifactAllowsExecution =
    readBoolean(strategyDefectMonitor.promotionEligible) === true ||
    readBoolean(strategyDefectMonitor.paperTradingAllowed) === true ||
    readBoolean(strategyDefectMonitor.liveTradingAllowed) === true
  const reasonStatus: ReasonChainStatus = status === 'watch_only'
    ? 'observation_only'
    : status === 'blocked'
      ? 'blocked'
      : 'not_available'

  return {
    component: 'Strategy defect monitor',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: status === 'blocked'
      ? `Strategy defect monitor is blocked: ${readNumber(summary?.blocked) ?? blockedFindings.length} finding(s) still block strategy profitability evidence.`
      : `Strategy defect monitor status=${status ?? 'missing'}; continue watch-only research.`,
    evidencePaths: [
      sourceArtifacts.strategyDefectMonitor,
      sourceArtifacts.strategyDefectRegistry,
      '/Users/kino/Downloads/openalice_strategy_improvement.md',
      'scripts/build_strategy_defect_monitor.ts',
      'scripts/build_strategy_defect_registry.ts',
    ],
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['strategy_defect_monitor_must_not_authorize_execution'] : []),
      ...(registryAllowsExecution ? ['strategy_defect_registry_must_not_authorize_execution'] : []),
      ...(status ? [`strategy_defect_monitor_status:${status}`] : ['strategy_defect_monitor_status_missing']),
      ...(registryStatus ? [`strategy_defect_registry_status:${registryStatus}`] : ['strategy_defect_registry_missing']),
      ...blockers.slice(0, 24).map(blocker => `strategy_defect:${blocker}`),
      ...registryBlockers.slice(0, 16).map(blocker => `strategy_defect_registry:${blocker}`),
    ]),
    metrics: {
      status,
      researchOnly: readBoolean(strategyDefectMonitor.researchOnly),
      diagnosticOnly: readBoolean(strategyDefectMonitor.diagnosticOnly),
      promotionEligible: readBoolean(strategyDefectMonitor.promotionEligible),
      paperTradingAllowed: readBoolean(strategyDefectMonitor.paperTradingAllowed),
      liveTradingAllowed: readBoolean(strategyDefectMonitor.liveTradingAllowed),
      findings: readNumber(summary?.findings),
      pass: readNumber(summary?.pass),
      blocked: readNumber(summary?.blocked),
      watch: readNumber(summary?.watch),
      p0Blocked: readNumber(summary?.p0Blocked),
      p1Blocked: readNumber(summary?.p1Blocked),
      p2Blocked: readNumber(summary?.p2Blocked),
      registryStatus,
      registryDefects: readNumber(registrySummary?.defects),
      registryOpen: readNumber(registrySummary?.open),
      registryPartial: readNumber(registrySummary?.partial),
      registryWatch: readNumber(registrySummary?.watch),
      registryPass: readNumber(registrySummary?.pass),
      registryUnknown: readNumber(registrySummary?.unknown),
      registryP0OpenOrPartial: readNumber(registrySummary?.p0OpenOrPartial),
      registryP1OpenOrPartial: readNumber(registrySummary?.p1OpenOrPartial),
      registryMonitorCovered: readNumber(registrySummary?.monitorCovered),
      registryMonitorUncovered: readNumber(registrySummary?.monitorUncovered),
      topBlockedId: readString(topBlocked?.id),
      topBlockedSeverity: readString(topBlocked?.severity),
      topBlockedTitle: readString(topBlocked?.title),
      topBlockedBlockers: readStringArray(topBlocked?.blockers),
      benchmarkLessons: uniqueStrings(
        blockedFindings
          .flatMap(finding => readStringArray(finding.benchmarkLessons))
          .slice(0, 20),
      ),
    },
    nextActions: readStringArray(strategyDefectMonitor.nextActions).length > 0
      ? readStringArray(strategyDefectMonitor.nextActions)
      : [
          'Fix P0/P1 strategy defects in smallest testable slices.',
          'Refresh the monitor and reason-chain after each strategy improvement.',
        ],
  }
}

function buildStrategyQualityGateCoverageReason(
  strategyQualityGateCoverage: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!strategyQualityGateCoverage) {
    return {
      component: 'Strategy quality gate coverage',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No strategy quality gate coverage artifact is present, so uncovered P0/P1 defect monitors are not audited.',
      evidencePaths: [
        sourceArtifacts.strategyQualityGateCoverage,
        sourceArtifacts.strategyDefectRegistry,
        sourceArtifacts.strategyDefectMonitor,
        'scripts/build_strategy_quality_gate_coverage.ts',
      ],
      blockingReasons: [
        'strategy_quality_gate_coverage_missing',
        'p0_p1_defect_monitor_coverage_not_machine_audited',
      ],
      metrics: {
        status: null,
        p0p1OpenOrPartialUncovered: null,
      },
      nextActions: [
        'Run npm run research:strategy:quality-gate-coverage after refreshing the defect registry and monitor.',
        'Convert uncovered P0/P1 defects into focused monitors before claiming strategy quality has improved.',
      ],
    }
  }

  const status = readString(strategyQualityGateCoverage.status)
  const summary = asRecord(strategyQualityGateCoverage.summary)
  const blockers = readStringArray(strategyQualityGateCoverage.blockers)
  const uncoveredDefects = Array.isArray(strategyQualityGateCoverage.uncoveredDefects)
    ? strategyQualityGateCoverage.uncoveredDefects.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const repairQueues = Array.isArray(strategyQualityGateCoverage.repairQueues)
    ? strategyQualityGateCoverage.repairQueues.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const blockedQueues = repairQueues.filter(queue => readString(queue.status) === 'blocked')
  const topUncovered = uncoveredDefects[0] ?? null
  const artifactAllowsExecution =
    readBoolean(strategyQualityGateCoverage.promotionEligible) === true ||
    readBoolean(strategyQualityGateCoverage.paperTradingAllowed) === true ||
    readBoolean(strategyQualityGateCoverage.liveTradingAllowed) === true ||
    readBoolean(strategyQualityGateCoverage.executionAllowed) === true
  const reasonStatus: ReasonChainStatus = status === 'watch_only'
    ? 'observation_only'
    : status === 'blocked'
      ? 'blocked'
      : 'not_available'

  return {
    component: 'Strategy quality gate coverage',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: status === 'blocked'
      ? `Strategy quality gate coverage is blocked: ${readNumber(summary?.p0p1OpenOrPartialUncovered) ?? uncoveredDefects.length} uncovered P0/P1 open-or-partial defect(s) still lack monitors.`
      : `Strategy quality gate coverage status=${status ?? 'missing'}; defect monitors are coverage-audited but not trading evidence.`,
    evidencePaths: [
      sourceArtifacts.strategyQualityGateCoverage,
      sourceArtifacts.strategyDefectRegistry,
      sourceArtifacts.strategyDefectMonitor,
      'scripts/build_strategy_quality_gate_coverage.ts',
    ],
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['strategy_quality_gate_coverage_must_not_authorize_execution'] : []),
      ...(status ? [`strategy_quality_gate_coverage_status:${status}`] : ['strategy_quality_gate_coverage_status_missing']),
      ...blockers.slice(0, 24).map(blocker => `strategy_quality_gate_coverage:${blocker}`),
    ]),
    metrics: {
      status,
      researchOnly: readBoolean(strategyQualityGateCoverage.researchOnly),
      diagnosticOnly: readBoolean(strategyQualityGateCoverage.diagnosticOnly),
      promotionEligible: readBoolean(strategyQualityGateCoverage.promotionEligible),
      paperTradingAllowed: readBoolean(strategyQualityGateCoverage.paperTradingAllowed),
      liveTradingAllowed: readBoolean(strategyQualityGateCoverage.liveTradingAllowed),
      executionAllowed: readBoolean(strategyQualityGateCoverage.executionAllowed),
      defects: readNumber(summary?.defects),
      monitorFindings: readNumber(summary?.monitorFindings),
      openOrPartial: readNumber(summary?.openOrPartial),
      p0OpenOrPartial: readNumber(summary?.p0OpenOrPartial),
      p1OpenOrPartial: readNumber(summary?.p1OpenOrPartial),
      p0p1OpenOrPartial: readNumber(summary?.p0p1OpenOrPartial),
      monitorCovered: readNumber(summary?.monitorCovered),
      monitorUncovered: readNumber(summary?.monitorUncovered),
      p0p1OpenOrPartialCovered: readNumber(summary?.p0p1OpenOrPartialCovered),
      p0p1OpenOrPartialUncovered: readNumber(summary?.p0p1OpenOrPartialUncovered),
      p0OpenOrPartialUncovered: readNumber(summary?.p0OpenOrPartialUncovered),
      p1OpenOrPartialUncovered: readNumber(summary?.p1OpenOrPartialUncovered),
      coveragePct: readNumber(summary?.coveragePct),
      p0p1OpenOrPartialCoveragePct: readNumber(summary?.p0p1OpenOrPartialCoveragePct),
      blockedRepairQueues: readNumber(summary?.blockedRepairQueues),
      quantBenchmarkStatus: readString(summary?.quantBenchmarkStatus),
      blockedRepairQueueIds: blockedQueues
        .map(queue => readString(queue.queueId))
        .filter((item): item is string => item != null),
      topUncoveredDefectId: readString(topUncovered?.id),
      topUncoveredPriority: readString(topUncovered?.priority),
      topUncoveredLayer: readString(topUncovered?.layer),
      topUncoveredRepairQueueId: readString(topUncovered?.repairQueueId),
      topUncoveredBlockers: readStringArray(topUncovered?.blockers),
    },
    nextActions: readStringArray(strategyQualityGateCoverage.nextActions).length > 0
      ? readStringArray(strategyQualityGateCoverage.nextActions)
      : [
          'Convert uncovered P0/P1 defects into focused monitors.',
          'Refresh strategy_quality_gate_coverage before judging strategy improvement progress.',
        ],
  }
}

function buildQuantFrameworkBenchmarkReason(
  quantFrameworkBenchmarkReport: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!quantFrameworkBenchmarkReport) {
    return {
      component: 'Quant framework benchmark',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No quant-framework benchmark artifact is present, so external framework lessons are not mapped to OpenAlice defects.',
      evidencePaths: [
        sourceArtifacts.quantFrameworkBenchmarkReport,
        sourceArtifacts.strategyDefectRegistry,
        sourceArtifacts.openAliceDataCatalog,
        'scripts/build_quant_framework_benchmark_report.ts',
      ],
      blockingReasons: [
        'quant_framework_benchmark_report_missing',
        'framework_lessons_not_machine_mapped_to_strategy_defects',
      ],
      metrics: {
        status: null,
        frameworks: null,
        capabilities: null,
      },
      nextActions: [
        'Run npm run research:quant-framework:benchmark to map framework lessons into OpenAlice capability gaps.',
        'Keep benchmark output diagnostic-only; it can prioritize repairs but cannot authorize trading.',
      ],
    }
  }

  const status = readString(quantFrameworkBenchmarkReport.status)
  const summary = asRecord(quantFrameworkBenchmarkReport.summary)
  const blockers = readStringArray(quantFrameworkBenchmarkReport.blockers)
  const capabilities = Array.isArray(quantFrameworkBenchmarkReport.capabilities)
    ? quantFrameworkBenchmarkReport.capabilities.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const blockedCapabilities = capabilities.filter(capability => readString(capability.status) === 'blocked')
  const missingEvidenceCapabilities = capabilities.filter(capability => readString(capability.status) === 'missing_evidence')
  const topBlocked = blockedCapabilities[0] ?? missingEvidenceCapabilities[0] ?? null
  const topBlockedEvidence = asRecord(topBlocked?.currentEvidence)
  const artifactAllowsExecution =
    readBoolean(quantFrameworkBenchmarkReport.promotionEligible) === true ||
    readBoolean(quantFrameworkBenchmarkReport.paperTradingAllowed) === true ||
    readBoolean(quantFrameworkBenchmarkReport.liveTradingAllowed) === true
  const reasonStatus: ReasonChainStatus = status === 'watch_only'
    ? 'observation_only'
    : status === 'blocked'
      ? 'blocked'
      : 'not_available'

  return {
    component: 'Quant framework benchmark',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: status === 'blocked'
      ? `Quant-framework benchmark is blocked: ${readNumber(summary?.blockedCapabilities) ?? blockedCapabilities.length} capability gap(s) remain open.`
      : `Quant-framework benchmark status=${status ?? 'missing'}; use it only as diagnostic repair guidance.`,
    evidencePaths: [
      sourceArtifacts.quantFrameworkBenchmarkReport,
      sourceArtifacts.strategyDefectRegistry,
      sourceArtifacts.openAliceDataCatalog,
      'scripts/build_quant_framework_benchmark_report.ts',
    ],
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['quant_framework_benchmark_must_not_authorize_execution'] : []),
      ...(status ? [`quant_framework_benchmark_status:${status}`] : ['quant_framework_benchmark_status_missing']),
      ...blockers.slice(0, 24).map(blocker => `quant_framework_benchmark:${blocker}`),
    ]),
    metrics: {
      status,
      researchOnly: readBoolean(quantFrameworkBenchmarkReport.researchOnly),
      diagnosticOnly: readBoolean(quantFrameworkBenchmarkReport.diagnosticOnly),
      promotionEligible: readBoolean(quantFrameworkBenchmarkReport.promotionEligible),
      paperTradingAllowed: readBoolean(quantFrameworkBenchmarkReport.paperTradingAllowed),
      liveTradingAllowed: readBoolean(quantFrameworkBenchmarkReport.liveTradingAllowed),
      frameworks: readNumber(summary?.frameworks),
      capabilities: readNumber(summary?.capabilities),
      blockedCapabilities: readNumber(summary?.blockedCapabilities),
      watchCapabilities: readNumber(summary?.watchCapabilities),
      missingEvidenceCapabilities: readNumber(summary?.missingEvidenceCapabilities),
      relatedOpenOrPartialDefects: readNumber(summary?.relatedOpenOrPartialDefects),
      p0RelatedOpenOrPartialDefects: readNumber(summary?.p0RelatedOpenOrPartialDefects),
      dataCatalogStatus: readString(summary?.dataCatalogStatus),
      reasonChainActionability: readString(summary?.reasonChainActionability),
      benchmarkCapabilityIds: capabilities
        .map(capability => readString(capability.capabilityId))
        .filter((item): item is string => item != null),
      blockedCapabilityIds: blockedCapabilities
        .map(capability => readString(capability.capabilityId))
        .filter((item): item is string => item != null),
      missingEvidenceCapabilityIds: missingEvidenceCapabilities
        .map(capability => readString(capability.capabilityId))
        .filter((item): item is string => item != null),
      topBlockedCapabilityId: readString(topBlocked?.capabilityId),
      topBlockedPriority: readString(topBlocked?.priority),
      topBlockedRelatedDefectIds: readStringArray(topBlockedEvidence?.relatedDefectIds),
      topBlockedOpenOrPartialDefectIds: readStringArray(topBlockedEvidence?.openOrPartialDefectIds),
    },
    nextActions: readStringArray(quantFrameworkBenchmarkReport.nextActions).length > 0
      ? readStringArray(quantFrameworkBenchmarkReport.nextActions)
      : [
          'Use the benchmark-to-defect map to prioritize P0 repairs without weakening gates.',
          'Keep external framework lessons as requirements for OpenAlice evidence, not trading permission.',
        ],
  }
}

function buildCryptoFactorFamilyReason(
  cryptoFactorFamilyReport: UnknownRecord | null,
  runtimeFeeSnapshotRefresh: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  const runtimeFeeStatus = readString(runtimeFeeSnapshotRefresh?.status)
  const runtimeFeeBlockers = readStringArray(runtimeFeeSnapshotRefresh?.blockers)

  if (!cryptoFactorFamilyReport) {
    return {
      component: 'Crypto factor family',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No base crypto factor-family diagnostic artifact is present.',
      evidencePaths: [
        sourceArtifacts.cryptoFactorFamilyReport,
        sourceArtifacts.feeSnapshotRefresh,
      ],
      blockingReasons: uniqueStrings([
        'crypto_factor_family_report_missing',
        ...(runtimeFeeSnapshotRefresh ? [] : ['runtime_fee_snapshot_refresh_missing']),
        ...(runtimeFeeStatus === 'blocked' ? ['runtime_fee_snapshot_blocked'] : []),
        ...runtimeFeeBlockers.slice(0, 8).map(reason => `runtime_fee:${reason}`),
      ]),
      metrics: {
        status: null,
        bestCandidateId: null,
        configsEvaluated: null,
        runtimeFeeSnapshotRefreshStatus: runtimeFeeStatus,
        runtimeFeeSnapshotWritten: readBoolean(runtimeFeeSnapshotRefresh?.snapshotWritten),
      },
      nextActions: [
        'Run corepack pnpm research:crypto-factor-family to refresh the research-only base factor diagnostic.',
        'Keep base factor diagnostics out of paper/live execution until WFO, runtime fees, and prospective gates pass.',
      ],
    }
  }

  const best = asRecord(cryptoFactorFamilyReport.best)
  const bestWfo = asRecord(best?.wfo)
  const reportBlockers = readStringArray(cryptoFactorFamilyReport.blockers)
  const bestBlockers = readStringArray(best?.blockers)
  const wfoBlockers = readStringArray(bestWfo?.blockers)
  const promotionEligible = readBoolean(cryptoFactorFamilyReport.promotionEligible) === true
  const paperTradingAllowed = readBoolean(cryptoFactorFamilyReport.paperTradingAllowed) === true
  const liveTradingAllowed = readBoolean(cryptoFactorFamilyReport.liveTradingAllowed) === true
  const wfoStatus = readString(bestWfo?.status)
  const candidateVerdict = readString(best?.candidateVerdict)
  const failedWindowRatio = readNumber(bestWfo?.failedWindowRatio)
  const failWindowRatioThreshold = readNumber(bestWfo?.failWindowRatioThreshold)
  const status: ReasonChainStatus = best
    ? (wfoStatus === 'pass' && candidateVerdict === 'promising_diagnostic' ? 'observation_only' : 'not_available')
    : 'not_available'

  return {
    component: 'Crypto factor family',
    status,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: best
      ? `Base crypto factor-family diagnostic best is ${readString(best.candidateId) ?? 'unknown'}; verdict=${candidateVerdict ?? 'missing'}, WFO=${wfoStatus ?? 'missing'}.`
      : 'Base crypto factor-family diagnostic found no usable candidate.',
    evidencePaths: [
      sourceArtifacts.cryptoFactorFamilyReport,
      sourceArtifacts.feeSnapshotRefresh,
    ],
    blockingReasons: uniqueStrings([
      ...(promotionEligible || paperTradingAllowed || liveTradingAllowed
        ? ['crypto_factor_family_artifact_must_not_authorize_execution']
        : []),
      ...(best ? [] : ['crypto_factor_family_best_candidate_missing']),
      ...(candidateVerdict && candidateVerdict !== 'promising_diagnostic'
        ? [`crypto_factor_family_verdict:${candidateVerdict}`]
        : []),
      ...(wfoStatus && wfoStatus !== 'pass' ? [`crypto_factor_family_wfo_status:${wfoStatus}`] : []),
      ...(failedWindowRatio != null && failWindowRatioThreshold != null && failedWindowRatio > failWindowRatioThreshold
        ? [`crypto_factor_family_wfo_failed_window_ratio:${round(failedWindowRatio, 6)}>${round(failWindowRatioThreshold, 6)}`]
        : []),
      ...wfoBlockers.slice(0, 8).map(reason => `crypto_factor_family_wfo:${reason}`),
      ...bestBlockers.slice(0, 10).map(reason => `crypto_factor_family:${reason}`),
      ...reportBlockers.slice(0, 10).map(reason => `crypto_factor_family_report:${reason}`),
      ...(runtimeFeeSnapshotRefresh ? [] : ['runtime_fee_snapshot_refresh_missing']),
      ...(runtimeFeeStatus === 'blocked' ? ['runtime_fee_snapshot_blocked'] : []),
      ...runtimeFeeBlockers.slice(0, 8).map(reason => `runtime_fee:${reason}`),
    ]),
    metrics: {
      generatedAt: readString(cryptoFactorFamilyReport.generatedAt),
      researchOnly: readBoolean(cryptoFactorFamilyReport.researchOnly),
      promotionEligible,
      paperTradingAllowed,
      liveTradingAllowed,
      symbolsLoaded: Array.isArray(cryptoFactorFamilyReport.symbolsLoaded)
        ? cryptoFactorFamilyReport.symbolsLoaded.length
        : null,
      commonPeriods: readNumber(cryptoFactorFamilyReport.commonPeriods),
      configsEvaluated: readNumber(cryptoFactorFamilyReport.configsEvaluated),
      bestCandidateId: readString(best?.candidateId),
      bestFactor: readString(best?.factor),
      bestLookbackHours: readNumber(best?.lookbackHours),
      bestForwardHours: readNumber(best?.forwardHours),
      bestVerdict: candidateVerdict,
      bestMeanIc: readNumber(best?.meanIc),
      bestIcIr: readNumber(best?.icIr),
      bestWinRate: readNumber(best?.winRate),
      bestNetAfterRouteCostPct: readNumber(best?.netAfterRouteCostPct),
      bestRouteCostPct: readNumber(best?.routeCostPct),
      bestWfoStatus: wfoStatus,
      bestWfoWindowCount: readNumber(bestWfo?.windowCount),
      bestWfoPassedWindows: readNumber(bestWfo?.passedWindows),
      bestWfoFailedWindows: readNumber(bestWfo?.failedWindows),
      bestWfoFailedWindowRatio: failedWindowRatio,
      bestWfoFailWindowRatioThreshold: failWindowRatioThreshold,
      bestWfoDirectionStable: readBoolean(bestWfo?.directionStable),
      routeCostSource: readString(asRecord(cryptoFactorFamilyReport.routeCost)?.source),
      routeCostRuntimeVerified: readBoolean(asRecord(cryptoFactorFamilyReport.routeCost)?.runtimeVerified),
      runtimeFeeSnapshotRefreshStatus: runtimeFeeStatus,
      runtimeFeeSnapshotWritten: readBoolean(runtimeFeeSnapshotRefresh?.snapshotWritten),
    },
      nextActions: [
        'Treat base crypto factor-family results as research-only diagnostics until WFO passes across locked windows.',
        runtimeFeeStatus === 'runtime_verified'
          ? 'Keep runtime fee snapshots fresh and rebuild route-cost-adjusted factor diagnostics before any promotion review.'
          : 'Fix OKX private auth and runtime fee snapshot before trusting route-cost-adjusted factor economics.',
        'Do not promote this line without prospective, trial-ledger, BY-FDR, PIT, and paper-execution evidence.',
      ],
  }
}

function buildAllocatorReason(
  paperGateStatus: UnknownRecord | null,
  paperExecutorStatus: UnknownRecord | null,
  phaseReadiness: UnknownRecord | null,
  productionRiskPolicy: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  const portfolioPlan = asRecord(paperExecutorStatus?.portfolioPlan)
  const phasePaper = asRecord(phaseReadiness?.paper)
  const finalAllowPaperTrading = readBoolean(paperGateStatus?.finalAllowPaperTrading) === true
  const championLoaded = readBoolean(paperGateStatus?.championLoaded) === true
  const policyVersionMatch = readBoolean(paperGateStatus?.policyVersionMatch) === true
  const executorEnabled = readBoolean(paperGateStatus?.paperExecutorEnabled) === true
  const targetSymbolCount = readNumber(portfolioPlan?.targetSymbolCount) ?? 0
  const executionPlanKind = readString(paperExecutorStatus?.executionPlanKind)
  const productionRiskPolicyStatus = readString(productionRiskPolicy?.status)
  const productionRiskPolicyMode = readString(productionRiskPolicy?.mode)
  const paperExecutionAllowedByRiskPolicy =
    readBoolean(productionRiskPolicy?.paperExecutionAllowedByThisArtifact) === true
  const liveExecutionAllowedByRiskPolicy =
    readBoolean(productionRiskPolicy?.liveExecutionAllowedByThisArtifact) === true
  const riskPolicyBlockers = readStringArray(productionRiskPolicy?.blockers)
  const productionRiskPolicyReady =
    productionRiskPolicy != null &&
    productionRiskPolicyStatus === 'ready_deny_only' &&
    productionRiskPolicyMode === 'fail_closed_deny_only' &&
    riskPolicyBlockers.length === 0 &&
    !paperExecutionAllowedByRiskPolicy &&
    !liveExecutionAllowedByRiskPolicy
  const productionRiskPolicyBlockingReasons = [
    ...(productionRiskPolicy == null ? ['production_risk_policy_missing'] : []),
    ...(productionRiskPolicy != null && productionRiskPolicyStatus !== 'ready_deny_only'
      ? [`production_risk_policy_not_ready:${productionRiskPolicyStatus ?? 'missing'}`]
      : []),
    ...(productionRiskPolicy != null && productionRiskPolicyMode !== 'fail_closed_deny_only'
      ? [`production_risk_policy_mode_invalid:${productionRiskPolicyMode ?? 'missing'}`]
      : []),
    ...(paperExecutionAllowedByRiskPolicy || liveExecutionAllowedByRiskPolicy
      ? ['production_risk_policy_must_not_authorize_execution']
      : []),
    ...riskPolicyBlockers.map(reason => `production_risk_policy:${reason}`),
  ]
  const available =
    finalAllowPaperTrading &&
    championLoaded &&
    policyVersionMatch &&
    executorEnabled &&
    targetSymbolCount > 0 &&
    productionRiskPolicyReady
  const blockingReasons = available
    ? []
    : uniqueStrings([
        ...readStringArray(paperGateStatus?.blockingReasons),
        ...readStringArray(phasePaper?.blockingReasons),
        ...readStringArray(paperExecutorStatus?.blockingReasons),
        ...productionRiskPolicyBlockingReasons,
        ...(championLoaded ? [] : ['champion_not_loaded']),
        ...(policyVersionMatch ? [] : ['policy_version_not_matched']),
        ...(executorEnabled ? [] : ['paper_executor_disabled']),
        ...(targetSymbolCount > 0 ? [] : ['nonflat_target_missing']),
      ])
  return {
    component: 'Allocator',
    status: available ? 'available' : 'blocked',
    usableForPromotion: available,
    usableForPaperExecution: available,
    summary: available
      ? 'Allocator has a non-flat paper execution plan.'
      : 'Allocator is blocked: release/paper gates do not authorize a non-flat portfolio target.',
    evidencePaths: [
      sourceArtifacts.paperGateStatus,
      sourceArtifacts.paperExecutorStatus,
      sourceArtifacts.phaseReadiness,
      sourceArtifacts.productionRiskPolicy,
    ],
    blockingReasons,
    metrics: {
      finalAllowPaperTrading,
      championLoaded,
      policyVersionMatch,
      paperExecutorEnabled: executorEnabled,
      executionPlanKind,
      targetSymbolCount,
      rebalanceEntryCount: readNumber(portfolioPlan?.rebalanceEntryCount),
      walletOperationCount: readNumber(portfolioPlan?.walletOperationCount),
      productionRiskPolicyStatus,
      productionRiskPolicyMode,
      productionRiskPolicyReady,
      paperExecutionAllowedByRiskPolicy,
      liveExecutionAllowedByRiskPolicy,
      productionRiskPolicyRuleCounts: {
        deny: readNumber(productionRiskPolicy?.denyRuleCount),
        cooldown: readNumber(productionRiskPolicy?.cooldownRuleCount),
        downweight: readNumber(productionRiskPolicy?.downweightRuleCount),
        shadowOnly: readNumber(productionRiskPolicy?.shadowOnlyRuleCount),
      },
      productionRiskPolicySourceTrust: readString(productionRiskPolicy?.sourceEvidenceTrustObserved),
      blockingReasonBuckets: bucketAllocatorBlockingReasons(blockingReasons),
    },
    nextActions: available
      ? ['Keep allocator capped by release gate and paper execution journal reconciliation.']
      : [
          'Do not allocate capital until research and paper gates pass.',
          'Keep production_risk_policy.latest.json as a deny-only brake; it cannot authorize execution.',
          'Publish a clean champion registry and non-flat portfolio target only after P1/P2 evidence gates pass.',
          'Require allocator artifact with correlation constraints, turnover limits, and route-cost-aware sizing before paper execution.',
        ],
  }
}

function buildSchedulerSecurityReason(
  schedulerSecurityAudit: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!schedulerSecurityAudit) {
    return {
      component: 'Scheduler security',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No scheduler security audit artifact is present.',
      evidencePaths: [
        sourceArtifacts.schedulerSecurityAudit,
        'scripts/audit_scheduler_security.ts',
        'scripts/cron_scheduler_security_audit.sh',
      ],
      blockingReasons: ['scheduler_security_audit_missing'],
      metrics: {
        status: null,
        findingCount: 0,
        failFindingCount: 0,
        runtimeFeeAuthOkxCredentialPresence: null,
      },
      nextActions: [
        'Run scripts/cron_scheduler_security_audit.sh so scheduler/env blockers are visible in runtime truth.',
        'Keep scheduler audit fail-closed; do not infer private-auth cron readiness from repo .env alone.',
      ],
    }
  }

  const status = readString(schedulerSecurityAudit.status)
  const findings = Array.isArray(schedulerSecurityAudit.findings)
    ? schedulerSecurityAudit.findings.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const failFindings = findings.filter(finding => readString(finding.severity) === 'fail')
  const checks = asRecord(schedulerSecurityAudit.checks)
  const envFile = asRecord(checks?.envFile)
  const internalCronJobs = asRecord(checks?.internalCronJobs)
  const requiredJobs = asRecord(internalCronJobs?.requiredJobs)
  const runtimeFeeAuthJob = asRecord(requiredJobs?.runtime_fee_auth_tick_4h)
  const okxCredentialPresence = asRecord(envFile?.okxCredentialPresence)
  const failChecks = failFindings
    .map(finding => readString(finding.check))
    .filter((item): item is string => item != null)
  const blocked = status !== 'pass' || failFindings.length > 0

  return {
    component: 'Scheduler security',
    status: blocked ? 'blocked' : 'available',
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: blocked
      ? `Scheduler security audit is failing with ${failFindings.length} fail finding(s); private-auth cron readiness is not established.`
      : 'Scheduler security audit passed; this only means scheduler surfaces are clean enough to keep collecting evidence.',
    evidencePaths: [
      sourceArtifacts.schedulerSecurityAudit,
      'scripts/audit_scheduler_security.ts',
      'scripts/cron_scheduler_security_audit.sh',
    ],
    blockingReasons: uniqueStrings([
      ...(status ? [`scheduler_security_status:${status}`] : ['scheduler_security_status_missing']),
      ...failChecks.map(check => `scheduler_security:${check}`),
    ]),
    metrics: {
      status,
      generatedAt: readString(schedulerSecurityAudit.generatedAt),
      findingCount: findings.length,
      failFindingCount: failFindings.length,
      runtimeFeeAuthJobEnabledHits: readNumber(runtimeFeeAuthJob?.enabledHits),
      envFilePath: readString(envFile?.path),
      envFileExists: readBoolean(envFile?.exists),
      envFileMode: readString(envFile?.mode),
      envFileOwnedByCurrentUser: readBoolean(envFile?.ownedByCurrentUser),
      envFileRestricted: readBoolean(envFile?.restricted),
      runtimeFeeAuthOkxCredentialPresence: okxCredentialPresence
        ? {
            apiKey: readBoolean(okxCredentialPresence.apiKey),
            secret: readBoolean(okxCredentialPresence.secret),
            password: readBoolean(okxCredentialPresence.password),
          }
        : null,
      failChecks,
    },
    nextActions: blocked
      ? [
          'Sync or explicitly point launchd/internal cron to the intended OKX env tuple before relying on runtime_fee_auth_tick.',
          'Rerun scheduler security audit after env sync; the audit reports only credential presence, not raw secrets.',
          'Keep paper/live disabled until OKX auth, runtime fees, WFO, FDR/PIT, and paper evidence gates pass.',
        ]
      : [
          'Keep scheduler security audit scheduled; it cannot authorize execution by itself.',
          'Rerun OKX private-auth diagnosis and runtime fee snapshot after any credential or env-file change.',
        ],
  }
}

function buildGoalCompletionAuditReason(
  goalCompletionAudit: UnknownRecord | null,
  sourceArtifacts: Record<string, string>,
): SystemStatusReason {
  if (!goalCompletionAudit) {
    return {
      component: 'Goal completion audit',
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      summary: 'No OpenAlice goal completion audit artifact is present.',
      evidencePaths: [
        sourceArtifacts.goalCompletionAudit,
        'scripts/build_openalice_goal_completion_audit.ts',
      ],
      blockingReasons: [
        'openalice_goal_completion_audit_missing',
        'objective_progress_not_machine_audited',
      ],
      metrics: {
        goalComplete: false,
        goalChecklistCompletionPct: null,
      },
      nextActions: [
        'Run npm run status:goal-completion after refreshing research/data/gate artifacts.',
        'Keep this audit diagnostic-only; it cannot authorize paper/live or mark the user goal complete.',
      ],
    }
  }

  const status = readString(goalCompletionAudit.status)
  const summary = asRecord(goalCompletionAudit.summary)
  const observedGateState = asRecord(goalCompletionAudit.observedGateState)
  const items = Array.isArray(goalCompletionAudit.items)
    ? goalCompletionAudit.items.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const blockedItems = items.filter(item => readString(item.status) === 'blocked' || readString(item.status) === 'missing')
  const topBlocked = blockedItems[0] ?? null
  const blockers = readStringArray(goalCompletionAudit.blockers)
  const artifactAllowsExecution =
    readBoolean(goalCompletionAudit.promotionEligible) === true ||
    readBoolean(goalCompletionAudit.paperTradingAllowed) === true ||
    readBoolean(goalCompletionAudit.liveTradingAllowed) === true
  const goalComplete = readBoolean(goalCompletionAudit.goalComplete) === true
  const reasonStatus: ReasonChainStatus = goalComplete
    ? 'available'
    : status === 'blocked'
      ? 'blocked'
      : status === 'watch_only'
        ? 'observation_only'
        : 'not_available'

  return {
    component: 'Goal completion audit',
    status: reasonStatus,
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: goalComplete
      ? 'OpenAlice goal audit says objective is complete, but execution still requires the dedicated release/execution gates.'
      : `OpenAlice goal audit is blocked: ${readNumber(summary?.requiredBlocked) ?? blockedItems.length} required item(s) blocked, ${readNumber(summary?.requiredMissing) ?? 0} missing.`,
    evidencePaths: [
      sourceArtifacts.goalCompletionAudit,
      sourceArtifacts.openAliceDataCatalog,
      sourceArtifacts.strategyDefectRegistry,
      sourceArtifacts.quantFrameworkBenchmarkReport,
      sourceArtifacts.ethCarryProspectiveEvidenceStatus,
      sourceArtifacts.aiScientistSecondValidationReadiness,
      'scripts/build_openalice_goal_completion_audit.ts',
    ],
    blockingReasons: uniqueStrings([
      ...(artifactAllowsExecution ? ['goal_completion_audit_must_not_authorize_execution'] : []),
      ...(status ? [`goal_completion_audit_status:${status}`] : ['goal_completion_audit_status_missing']),
      ...(goalComplete ? [] : ['openalice_user_goal_not_complete']),
      ...blockers.slice(0, 24).map(blocker => `goal_completion:${blocker}`),
    ]),
    metrics: {
      status,
      goalComplete,
      objective: readString(goalCompletionAudit.objective),
      effectiveActionability: readString(goalCompletionAudit.effectiveActionability),
      overallPlanCompletionPct: readNumber(goalCompletionAudit.overallPlanCompletionPct),
      goalChecklistCompletionPct: readNumber(goalCompletionAudit.goalChecklistCompletionPct),
      items: readNumber(summary?.items),
      requiredItems: readNumber(summary?.requiredItems),
      requiredPass: readNumber(summary?.requiredPass),
      requiredBlocked: readNumber(summary?.requiredBlocked),
      requiredMissing: readNumber(summary?.requiredMissing),
      dataCatalogStatus: readString(summary?.dataCatalogStatus),
      dataCatalogComplete: readNumber(summary?.dataCatalogComplete),
      dataCatalogDatasets: readNumber(summary?.dataCatalogDatasets),
      strategyDefectStatus: readString(summary?.strategyDefectStatus),
      quantFrameworkStatus: readString(summary?.quantFrameworkStatus),
      ethCarryProspectiveStatus: readString(summary?.ethCarryProspectiveStatus),
      aiScientistReadinessStatus: readString(summary?.aiScientistReadinessStatus),
      schedulerSecurityStatus: readString(summary?.schedulerSecurityStatus),
      topBlockedItemId: readString(topBlocked?.id),
      topBlockedItemTitle: readString(topBlocked?.title),
      topBlockedItemCompletionPct: readNumber(topBlocked?.completionPct),
      topBlockedItemBlockers: readStringArray(topBlocked?.blockers),
      reasonChainPaperTradingAllowed: readBoolean(observedGateState?.reasonChainPaperTradingAllowed),
      reasonChainLiveTradingAllowed: readBoolean(observedGateState?.reasonChainLiveTradingAllowed),
      reasonChainCanPromote: readBoolean(observedGateState?.reasonChainCanPromote),
      releaseGateAllowPaperTrading: readBoolean(observedGateState?.releaseGateAllowPaperTrading),
      releaseGateAllowLiveTrading: readBoolean(observedGateState?.releaseGateAllowLiveTrading),
      paperGateFinalAllowPaperTrading: readBoolean(observedGateState?.paperGateFinalAllowPaperTrading),
    },
    nextActions: readStringArray(goalCompletionAudit.nextActions).length > 0
      ? readStringArray(goalCompletionAudit.nextActions)
      : [
          'Refresh the goal completion audit after every data, strategy, AI-Scientist, or gate change.',
          'Use blocked checklist items to choose the next repair slice instead of forcing paper/live.',
        ],
  }
}

function readLiquidityConditionedPivot(candidateSummary: UnknownRecord | null): {
  candidateId: string
  strategy: string | null
  netAfterRouteCostPct: number | null
  wfoStatus: string | null
  failedWindowRatio: number | null
  signalPeriods: number | null
  commonPeriods: number | null
  blockers: string[]
} | null {
  const topCandidates = Array.isArray(candidateSummary?.topCandidates)
    ? candidateSummary.topCandidates.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const bestByTier = Array.isArray(candidateSummary?.bestByTier)
    ? candidateSummary.bestByTier
      .map(asRecord)
      .map(item => asRecord(item?.candidate))
      .filter((item): item is UnknownRecord => item != null)
    : []
  const candidates = [...topCandidates, ...bestByTier]
  const best = candidates.find(candidate => readString(candidate.sourceKind) === 'liquidity_conditioned_factor')
  if (!best) return null
  const metrics = asRecord(best.metrics)
  return {
    candidateId: readString(best.candidateId) ?? 'liquidity_conditioned_factor_candidate',
    strategy: readString(best.strategy),
    netAfterRouteCostPct: readNumber(metrics?.netAfterRouteCostPct),
    wfoStatus: readString(metrics?.rankIcWfoStatus),
    failedWindowRatio: readNumber(metrics?.rankIcWfoFailedWindowRatio),
    signalPeriods: readNumber(metrics?.signalPeriods),
    commonPeriods: readNumber(metrics?.commonPeriods),
    blockers: readStringArray(best.whyNotTradable),
  }
}

function buildCpBridgeReason(
  cpBridge: UnknownRecord | null,
  cpTraceLines: string[],
  sourceArtifacts: Record<string, string>,
  generatedAt: string,
): SystemStatusReason {
  const mode = readString(cpBridge?.mode)
  const signals = Array.isArray(cpBridge?.signals) ? cpBridge.signals : []
  const generatedAtMs = Date.parse(generatedAt)
  const signalRecords = signals.map(asRecord).filter((signal): signal is UnknownRecord => signal != null)
  const positiveTargets = signalRecords.filter(signal =>
    readNumber(signal.target_position_pct) != null &&
    (readNumber(signal.target_position_pct) ?? 0) !== 0
  ).length
  const zeroTargetSignalCount = signalRecords.filter(signal =>
    readNumber(signal.target_position_pct) === 0
  ).length
  const ticketIntentSignalCount = mode === 'ticket' ? positiveTargets : 0
  const modeTargetConsistency = classifyCpModeTargetConsistency(mode, positiveTargets, zeroTargetSignalCount, signalRecords.length)
  const currentPayloadTtl = summarizeCpPayloadTtl(signalRecords, generatedAtMs)
  const traceSummary = summarizeCpTrace(cpTraceLines, generatedAt)
  const observationOnly = mode === 'observation' || positiveTargets === 0
  const bridgeGeneratedAt = readString(cpBridge?.generatedAt) ?? readString(cpBridge?.generated_at)
  const bridgeUpdatedAt = readString(cpBridge?.updatedAt) ?? readString(cpBridge?.updated_at)
  return {
    component: 'CP bridge',
    status: observationOnly ? 'observation_only' : 'blocked',
    usableForPromotion: false,
    usableForPaperExecution: false,
    summary: observationOnly
      ? 'CP bridge is observation/log-only; target_position_pct=0 signals are not executable.'
      : 'CP bridge has non-observation input, but OpenAlice execution is still fail-closed until the paper execution pipeline is wired.',
    evidencePaths: [
      sourceArtifacts.cpBridge,
      sourceArtifacts.cpTrace,
      'scripts/intake_currencypurchases_signals.ts',
    ],
    blockingReasons: [
      ...(mode ? [`cp_bridge_mode:${mode}`] : ['cp_bridge_payload_missing']),
      ...(positiveTargets === 0 ? ['cp_bridge_positive_targets_missing'] : []),
      ...(modeTargetConsistency !== 'consistent'
        ? [`cp_bridge_mode_target_mismatch:${modeTargetConsistency}`]
        : []),
      'cp_ticket_mode_execution_pipeline_pending',
      ...traceSummary.latestRejectReasons.map(reason => `cp_trace_recent_reject:${reason}`),
    ],
    metrics: {
      mode,
      signalCount: signals.length,
      positiveTargets,
      zeroTargetSignalCount,
      ticketIntentSignalCount,
      modeTargetConsistency,
      ticketExecutionCapability: 'not_wired',
      paperExecutionAllowedByCpBridge: false,
      bridgeGeneratedAt,
      bridgeUpdatedAt,
      cpCycleId: readString(cpBridge?.cp_cycle_id) ?? readString(cpBridge?.cpCycleId),
      cpTruthStatus: readString(cpBridge?.cp_truth_status) ?? readString(cpBridge?.cpTruthStatus),
      bridgeSource: readString(cpBridge?.source),
      maxSignalAgeMs: maxNumber([
        currentPayloadTtl.currentPayloadMaxAgeMs,
        traceSummary.maxSignalAgeMs,
      ]),
      currentPayloadMaxAgeMs: currentPayloadTtl.currentPayloadMaxAgeMs,
      currentPayloadFreshSignalCount: currentPayloadTtl.currentPayloadFreshSignalCount,
      currentPayloadTtlExpiredSignalCount: currentPayloadTtl.currentPayloadTtlExpiredSignalCount,
      currentPayloadInvalidTimestampCount: currentPayloadTtl.currentPayloadInvalidTimestampCount,
      currentPayloadInvalidTtlCount: currentPayloadTtl.currentPayloadInvalidTtlCount,
      ttlExpiredSignalCount: traceSummary.ttlExpiredSignalCount,
      latestTraceAgeMs: traceSummary.latestTraceAgeMs,
      traceLinesScanned: traceSummary.lines,
      recentStaleAlerts: traceSummary.staleAlerts,
      recentLoggedObservations: traceSummary.loggedObservations,
      latestRejectReasons: traceSummary.latestRejectReasons,
    },
    nextActions: [
      'Keep observation signals in the evidence ledger; do not route them to orders.',
      'Before ticket mode can execute paper, wire a paper execution plan path with release-gate and TTL checks.',
      'Refresh CP bridge signals so TTL-expired/stale observations do not pollute current decision context.',
    ],
  }
}

function buildPlanCompletion(input: {
  strategyPromotion: UnknownRecord | null
  releaseGateStatus: UnknownRecord | null
  paperGateStatus: UnknownRecord | null
  paperExecutorStatus: UnknownRecord | null
  p1CostModelDiagnostics: UnknownRecord | null
  p1GateEffectiveness: UnknownRecord | null
  p1TrialLedger: UnknownRecord | null
  p1StoplossRiskPolicy: UnknownRecord | null
  metaLabelingShadowReadiness: UnknownRecord | null
  prospectiveEvidenceStatus: UnknownRecord | null
  dirtyWorktreeAudit: UnknownRecord | null
  runtimeManifestCoverage: UnknownRecord | null
  externalDerivativesCollect: UnknownRecord | null
  paperPolicyShadowSettle: UnknownRecord | null
  sourceArtifacts: Record<string, string>
}): PlanCompletionPhase[] {
  const dirtyCounts = asRecord(input.dirtyWorktreeAudit?.counts)
  const dirtyTotal = readNumber(dirtyCounts?.total)
  const dirtyClean = dirtyTotal === 0
  const promotionCriticalScope = asRecord(input.dirtyWorktreeAudit?.promotionCriticalScope)
  const promotionCriticalDirtyTotal = readNumber(promotionCriticalScope?.dirtyTotal)
  const promotionCriticalSourceCodeDirtyTotal = readNumber(promotionCriticalScope?.sourceCodeDirtyTotal)
  const promotionCriticalDocsOrReadmeDirtyTotal = readNumber(promotionCriticalScope?.docsOrReadmeDirtyTotal)
  const promotionCriticalScopeClean = readBoolean(promotionCriticalScope?.clean) === true
  const runtimeManifestCoverageStatus = readString(input.runtimeManifestCoverage?.status)
  const runtimeManifestCoverageBlockers = readStringArray(input.runtimeManifestCoverage?.blockingReasons)
  const runtimeManifestCoverageOk = runtimeManifestCoverageStatus === 'complete'
  const routeCostShadowEligibility = asRecord(input.p1CostModelDiagnostics?.routeCostShadowEligibility)
  const routeCostShadowBlockers = readStringArray(routeCostShadowEligibility?.blockers)
  const routeCostShadowRouteBudgetStatus = readString(routeCostShadowEligibility?.routeBudgetStatus)
  const externalRows = readNumber(input.externalDerivativesCollect?.appendedRows) ?? 0
  const externalDryRun = readBoolean(input.externalDerivativesCollect?.dryRun) === true
  const externalErrorSummary = readErrorSummary(input.externalDerivativesCollect?.errorSummary)
  const externalErrorCount = Object.values(externalErrorSummary).reduce((sum, count) => sum + count, 0)
  const externalCollectorHealthy = externalRows > 0 && !externalDryRun && externalErrorCount === 0
  const newWindow = asRecord(input.p1CostModelDiagnostics?.newWindow)
  const newWindowClosed = readNumber(newWindow?.closedTrades) ?? 0
  const newWindowStatus = readString(newWindow?.status)
  const newWindowReason = readString(newWindow?.reason)
  const openPositionReadiness = asRecord(input.p1CostModelDiagnostics?.openPositionReadiness)
  const openPositionReadinessStatus = readString(openPositionReadiness?.status)
  const openPositionTotal = readNumber(openPositionReadiness?.totalOpenPositions) ?? 0
  const openPositionNew = readNumber(openPositionReadiness?.newOpenPositions) ?? 0
  const openPositionProducerGuard = readNumber(openPositionReadiness?.producerGuardOpenPositions) ?? 0
  const openPositionMissing = readNumber(openPositionReadiness?.missingPredictedOpenEvidence) ?? 0
  const openPositionLegacyMissing = readNumber(openPositionReadiness?.legacyMissingPredictedOpenEvidence) ?? 0
  const openPositionNewMissing = readNumber(openPositionReadiness?.newMissingPredictedOpenEvidence) ?? 0
  const openPositionTransitionalDirtyMissing = readNumber(openPositionReadiness?.transitionalDirtyMissingPredictedOpenEvidence) ?? 0
  const openPositionProducerGuardMissing = readNumber(openPositionReadiness?.producerGuardMissingPredictedOpenEvidence) ?? 0
  const openPositionNewMissingByField = readFieldCountBlockers(
    openPositionReadiness?.newMissingPredictedOpenEvidenceByField,
  )
  const openPositionLegacy = readNumber(openPositionReadiness?.legacyOpenPositions) ?? 0
  const trialStatus = readString(input.p1TrialLedger?.status)
  const trialReadinessGaps = asRecord(input.p1TrialLedger?.readinessGaps)
  const trialLedgerBlockerSummary = readStringArray(trialReadinessGaps?.blockerSummary)
  const gateStatus = readString(input.p1GateEffectiveness?.gateStatus)
  const gateStratifiedSummary = asRecord(asRecord(input.p1GateEffectiveness?.stratifiedDiagnostics)?.summary)
  const gateCostCoverageAttribution = asRecord(input.p1GateEffectiveness?.costCoverageAttribution)
  const gateStratifiedItems = readNumber(gateStratifiedSummary?.items) ?? 0
  const gateStratifiedCostCoverageRequired = readNumber(gateStratifiedSummary?.costCoverageRequired) ?? 0
  const gateStratifiedCollectMoreData = readNumber(gateStratifiedSummary?.collectMoreData) ?? 0
  const gateStratifiedKeepBlocked = readNumber(gateStratifiedSummary?.keepBlocked) ?? 0
  const gateCostCoveragePatchTargets = Array.isArray(gateCostCoverageAttribution?.topPatchTargets)
    ? gateCostCoverageAttribution.topPatchTargets.length
    : null
  const gateCostCoverageCohorts = Array.isArray(gateCostCoverageAttribution?.cohorts)
    ? gateCostCoverageAttribution.cohorts.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const producerGuardMissingCostTargets = readProducerGuardMissingCostTargets(gateCostCoverageAttribution?.topPatchTargets)
  const producerGuardMissingCompletePredictedOpenEvidence = gateCostCoverageCohorts
    .reduce((sum, cohort) => sum + (readNumber(cohort.producerGuardMissingCompletePredictedOpenEvidence) ?? 0), 0)
  const releaseFailedChecks = readStringArray(input.releaseGateStatus?.failedChecks)
  const paperBlocks = readStringArray(asRecord(input.strategyPromotion?.paperGate)?.hardBlocks)
  const researchBlocks = readStringArray(asRecord(input.strategyPromotion?.researchGate)?.hardBlocks)
  const stoplossRiskSummary = asRecord(input.p1StoplossRiskPolicy?.summary)
  const stoplossRiskStatus = readString(input.p1StoplossRiskPolicy?.status)
  const stoplossRiskBlockedBy = readStringArray(stoplossRiskSummary?.promotionBlockedBy)
  const stoplossRiskReviewedItems = readNumber(stoplossRiskSummary?.reviewedItems) ?? 0
  const stoplossAttributionComplete = !paperBlocks.some(reason => reason.includes('stop_loss_attribution'))
  const metaStatus = readString(input.metaLabelingShadowReadiness?.status)
  const metaTrainingAllowed = readBoolean(input.metaLabelingShadowReadiness?.trainingAllowed) === true
  const metaBlockers = readStringArray(input.metaLabelingShadowReadiness?.blockers)
  const prospectiveEvidenceStatus = readString(input.prospectiveEvidenceStatus?.status)
  const prospectiveCounts = asRecord(input.prospectiveEvidenceStatus?.counts)
  const prospectiveMetrics = asRecord(input.prospectiveEvidenceStatus?.metrics)
  const prospectiveThresholds = asRecord(input.prospectiveEvidenceStatus?.thresholds)
  const prospectiveOpenEvents = readNumber(prospectiveCounts?.openEvents) ?? 0
  const prospectiveClosedOutcomes = readNumber(prospectiveMetrics?.closedOutcomes) ?? 0
  const prospectiveMinClosedOutcomes = readNumber(prospectiveThresholds?.minClosedOutcomes) ?? 100
  const prospectiveBlockers = readStringArray(input.prospectiveEvidenceStatus?.blockers)

  return [
    {
      phase: 'P0',
      completionPct: 76,
      status: dirtyClean ? 'partial' : 'blocked',
      items: [
        {
          id: 'P0-A',
          title: 'Evidence manifest and dirty quarantine',
          status: dirtyClean ? 'done' : 'blocked',
          completionPct: dirtyClean ? 100 : 65,
          evidencePaths: [
            input.sourceArtifacts.dirtyWorktreeAudit,
            input.sourceArtifacts.runtimeManifestCoverage,
          ].filter(Boolean),
          blockers: [
            ...(dirtyClean ? [] : [`dirty_worktree_entries:${dirtyTotal ?? 'unknown'}`]),
            ...(promotionCriticalScopeClean || promotionCriticalDirtyTotal == null
              ? []
              : [`promotion_critical_scope_dirty:${promotionCriticalDirtyTotal}`]),
            ...(promotionCriticalSourceCodeDirtyTotal && promotionCriticalSourceCodeDirtyTotal > 0
              ? [`promotion_critical_source_code_dirty:${promotionCriticalSourceCodeDirtyTotal}`]
              : []),
            ...(promotionCriticalDocsOrReadmeDirtyTotal && promotionCriticalDocsOrReadmeDirtyTotal > 0
              ? [`promotion_critical_docs_or_readme_dirty:${promotionCriticalDocsOrReadmeDirtyTotal}`]
              : []),
            ...(runtimeManifestCoverageOk ? [] : [
              `runtime_manifest_coverage_status:${runtimeManifestCoverageStatus ?? 'missing'}`,
              ...runtimeManifestCoverageBlockers.slice(0, 8).map(reason => `runtime_manifest:${reason}`),
            ]),
          ],
          nextActions: dirtyClean
            ? [
                'Keep promotion artifacts generated from a clean worktree.',
                'Keep runtime_manifest_coverage.latest.json complete for key status artifacts.',
              ]
            : [
                'Finish dirty quarantine batches; regenerate dirty audit until counts.total=0 and manifest evidenceTrust=pass.',
                'Use promotionCriticalScope to separate executable trading-code dirtiness from docs/readme/archive churn.',
                'Ensure all key runtime status artifacts have sidecar manifests with matching artifactHash.',
              ],
        },
        {
          id: 'P0-B',
          title: 'Shadow settle idempotency',
          status: input.paperPolicyShadowSettle ? 'done' : 'partial',
          completionPct: input.paperPolicyShadowSettle ? 90 : 55,
          evidencePaths: [input.sourceArtifacts.paperPolicyShadowSettle],
          blockers: input.paperPolicyShadowSettle ? [] : ['paper_policy_shadow_settle_report_missing'],
          nextActions: ['Keep repeated settle runs at appendedOutcomes=0 for duplicate shadowId cases.'],
        },
        {
          id: 'P0-C',
          title: 'External derivatives append-only collection',
          status: externalCollectorHealthy ? 'done' : 'partial',
          completionPct: externalCollectorHealthy ? 85 : externalRows > 0 && !externalDryRun ? 70 : 45,
          evidencePaths: [input.sourceArtifacts.externalDerivativesCollect],
          blockers: externalCollectorHealthy
            ? []
            : [
                ...(externalRows > 0 && !externalDryRun ? [] : ['external_derivatives_rows_not_appended']),
                ...(externalDryRun ? ['external_derivatives_last_run_dry_run'] : []),
                ...formatErrorSummaryBlockers('external_derivatives_collect_error', externalErrorSummary),
              ],
          nextActions: externalErrorCount > 0
            ? ['Fix external derivatives collector network/proxy errors before treating funding/carry data refresh as healthy.']
            : ['Keep UTC append-only collection running for funding, premiumIndex, OI, OI history, and long/short.'],
        },
        {
          id: 'P0-D',
          title: 'Hard block 100x production path',
          status: existsSync('src/domain/trading/production-leverage-guard.ts') ? 'done' : 'partial',
          completionPct: existsSync('src/domain/trading/production-leverage-guard.ts') ? 85 : 45,
          evidencePaths: ['src/domain/trading/production-leverage-guard.ts'],
          blockers: existsSync('src/domain/trading/production-leverage-guard.ts') ? [] : ['production_leverage_guard_not_found'],
          nextActions: ['Keep 100x out of production; require tests across all order-entry paths.'],
        },
        {
          id: 'P0-E',
          title: 'New trade context and predicted-open cost coverage',
          status: newWindowClosed > 0 && newWindowStatus === 'ok' ? 'done' : 'partial',
          completionPct: newWindowClosed > 0 && newWindowStatus === 'ok' ? 90 : 55,
          evidencePaths: [input.sourceArtifacts.p1CostModelDiagnostics],
          blockers: newWindowClosed > 0 && newWindowStatus === 'ok'
            ? []
            : [
                `p1_cost_new_window_status:${newWindowStatus ?? 'missing'}`,
                ...(newWindowReason ? [`p1_cost_new_window_reason:${newWindowReason}`] : []),
                `p1_cost_new_window_closed:${newWindowClosed}`,
                ...(openPositionReadinessStatus && openPositionReadinessStatus !== 'ok' && openPositionReadinessStatus !== 'insufficient_data'
                  ? [`p1_open_position_readiness:${openPositionReadinessStatus}`]
                  : []),
                ...(openPositionTotal > 0 ? [`p1_open_positions:${openPositionTotal}`] : []),
                ...(openPositionNew > 0 ? [`p1_open_positions_new:${openPositionNew}`] : []),
                ...(openPositionProducerGuard > 0 ? [`p1_open_positions_producer_guard:${openPositionProducerGuard}`] : []),
                ...(openPositionMissing > 0 ? [`p1_open_positions_missing_predicted_open_evidence:${openPositionMissing}`] : []),
                ...(openPositionLegacyMissing > 0 ? [`p1_open_positions_legacy_missing_predicted_open_evidence:${openPositionLegacyMissing}`] : []),
                ...(openPositionNewMissing > 0 ? [`p1_open_positions_new_missing_predicted_open_evidence:${openPositionNewMissing}`] : []),
                ...(openPositionTransitionalDirtyMissing > 0
                  ? [`p1_open_positions_transitional_dirty_missing_predicted_open_evidence:${openPositionTransitionalDirtyMissing}`]
                  : []),
                ...(openPositionProducerGuardMissing > 0
                  ? [`p1_open_positions_producer_guard_missing_predicted_open_evidence:${openPositionProducerGuardMissing}`]
                  : []),
                ...openPositionNewMissingByField.map(item =>
                  openPositionProducerGuardMissing > 0
                    ? `p1_open_positions_new_missing_field:${item.field}:${item.count}`
                    : `p1_open_positions_transitional_dirty_missing_field:${item.field}:${item.count}`),
                ...(openPositionLegacy > 0 ? [`p1_open_positions_legacy_will_close_dirty:${openPositionLegacy}`] : []),
              ],
          nextActions: [
            'Refresh P1 evidence after new post-enforcement closed trades; require complete decision-time context and cost fields.',
            openPositionProducerGuardMissing > 0
              ? 'Fix producer-guard open-position evidence gaps before any new close can be considered clean.'
              : 'Let transitional dirty opens close into explicit quarantine/dirty-close evidence; do not backfill account JSON.',
          ],
        },
      ],
    },
    {
      phase: 'P1',
      completionPct: 52,
      status: 'blocked',
      items: [
        {
          id: 'P1-A',
          title: 'Trial ledger and BY FDR readiness',
          status: trialStatus === 'valid' ? 'partial' : 'blocked',
          completionPct: trialStatus === 'valid' ? 70 : 45,
          evidencePaths: [input.sourceArtifacts.p1TrialLedger, input.sourceArtifacts.p1TrialSourceCoverage],
          blockers: [
            `trial_ledger_status:${trialStatus ?? 'missing'}`,
            ...trialLedgerBlockerSummary.map(reason => `trial_ledger_readiness:${reason}`),
            ...paperBlocks
              .filter(reason => reason.includes('trial_ledger') && !reason.includes('trial_ledger_readiness:')),
          ],
          nextActions: [
            'Use trial_source_coverage.latest.json to patch the largest missing p-value/FDR/PIT source families first.',
            'Complete registered trial universe including failed trials, p-values, raw_m, effective_m, and BY_raw_m primary FDR.',
          ],
        },
        {
          id: 'P1-B',
          title: 'Gate effectiveness accept-vs-skip',
          status: gateStatus === 'useful' ? 'partial' : 'blocked',
          completionPct: gateStratifiedItems > 0 ? 45 : gateStatus === 'useful' ? 70 : 35,
          evidencePaths: [input.sourceArtifacts.p1GateEffectiveness],
          blockers: [
            `p1_gate_status:${gateStatus ?? 'missing'}`,
            ...(gateStratifiedCostCoverageRequired > 0
              ? [`p1_gate_stratified_cost_coverage_required:${gateStratifiedCostCoverageRequired}/${gateStratifiedItems}`]
              : []),
            ...(gateCostCoveragePatchTargets != null && gateCostCoveragePatchTargets > 0
              ? [`p1_gate_cost_coverage_patch_targets:${gateCostCoveragePatchTargets}`]
              : []),
            ...(producerGuardMissingCostTargets > 0
              ? [`p1_gate_producer_guard_missing_cost_targets:${producerGuardMissingCostTargets}`]
              : []),
            ...(producerGuardMissingCompletePredictedOpenEvidence > 0
              ? [`p1_gate_producer_guard_missing_complete_predicted_open_evidence:${producerGuardMissingCompletePredictedOpenEvidence}`]
              : []),
            ...(gateStratifiedKeepBlocked > 0
              ? [`p1_gate_stratified_keep_blocked:${gateStratifiedKeepBlocked}/${gateStratifiedItems}`]
              : []),
            ...(gateStratifiedCollectMoreData > 0
              ? [`p1_gate_stratified_collect_more_data:${gateStratifiedCollectMoreData}/${gateStratifiedItems}`]
              : []),
          ],
          nextActions: gateStratifiedCostCoverageRequired > 0
            ? [
                producerGuardMissingCostTargets > 0 || producerGuardMissingCompletePredictedOpenEvidence > 0
                  ? 'Patch producer-guard cost/context writers before using new accept-vs-skip rows as promotion evidence.'
                  : 'Keep legacy/transitional cost gaps quarantined; collect post-guard rows with complete predicted-open evidence.',
                'Fill predicted-cost coverage for accepted trades before using accept-vs-skip as a selector.',
                `Review ${gateStratifiedItems} stratified gate buckets; ${gateStratifiedCostCoverageRequired} currently require cost coverage.`,
              ]
            : ['Collect enough valid shadow outcomes so accept group beats skip group after cost and fill adjustment.'],
        },
        {
          id: 'P1-C',
          title: 'Cost model diagnostics',
          status: readBoolean(input.p1CostModelDiagnostics?.quarantine) || routeCostShadowBlockers.length > 0 ? 'blocked' : 'partial',
          completionPct: readBoolean(input.p1CostModelDiagnostics?.quarantine) || routeCostShadowBlockers.length > 0 ? 45 : 65,
          evidencePaths: [input.sourceArtifacts.p1CostModelDiagnostics, input.sourceArtifacts.routeCostBudget],
          blockers: [
            ...readStringArray(input.p1CostModelDiagnostics?.quarantineReasons),
            ...(routeCostShadowRouteBudgetStatus
              ? [`route_cost_shadow_budget_status:${routeCostShadowRouteBudgetStatus}`]
              : []),
            ...routeCostShadowBlockers,
          ],
          nextActions: [
            'Add exchange-reconciled cost samples and predicted-vs-realized cost bias diagnostics.',
            'Keep route-cost shadow eligibility diagnostic-only until selected route cost is inside budget and net edge clears break-even.',
          ],
        },
        {
          id: 'P1-D',
          title: 'Stop-loss cluster attribution and risk policy',
          status: paperBlocks.some(reason => reason.includes('stop_loss_cluster') || reason.includes('stoploss_risk_policy')) ? 'blocked' : 'partial',
          completionPct: stoplossRiskStatus === 'blocked' && stoplossAttributionComplete ? 65 : stoplossAttributionComplete ? 60 : 50,
          evidencePaths: [
            input.sourceArtifacts.strategyPromotion,
            input.sourceArtifacts.p1MfeMaeStoploss,
            input.sourceArtifacts.p1StoplossRiskPolicy,
          ],
          blockers: [
            ...paperBlocks.filter(
              reason => reason.includes('stop_loss_cluster') ||
                reason.includes('stop_loss_attribution') ||
                reason.includes('stoploss_risk_policy'),
            ),
            ...(stoplossRiskStatus ? [] : ['p1_stoploss_risk_policy_missing']),
          ],
          nextActions: stoplossRiskStatus === 'blocked'
            ? [
                `Review ${stoplossRiskReviewedItems} stop-loss risk-policy items; keep block/cooldown/shadow_only recommendations fail-closed.`,
                ...stoplossRiskBlockedBy.slice(0, 3).map(reason => `Resolve or keep blocked: ${reason}`),
              ]
            : ['Use MFE/MAE, spread, liquidity, slippage, and regime buckets to isolate the stop-loss loss cluster.'],
        },
      ],
    },
    {
      phase: 'P1.5',
      completionPct: input.metaLabelingShadowReadiness ? 25 : 15,
      status: metaTrainingAllowed ? 'partial' : input.metaLabelingShadowReadiness ? 'blocked' : 'not_started',
      items: [{
        id: 'P1.5-A',
        title: 'Meta-labeling shadow-only outperform-skip model',
        status: metaTrainingAllowed ? 'partial' : input.metaLabelingShadowReadiness ? 'blocked' : 'not_started',
        completionPct: input.metaLabelingShadowReadiness ? 25 : 15,
        evidencePaths: [input.sourceArtifacts.metaLabelingShadowReadiness],
        blockers: input.metaLabelingShadowReadiness
          ? [
              `meta_labeling_status:${metaStatus ?? 'missing'}`,
              ...metaBlockers.slice(0, 12),
            ]
          : ['requires_p1_shadow_outcomes', 'requires_pit_safe_features'],
        nextActions: metaTrainingAllowed
          ? ['Freeze the P1 evidence window before shadow-only training; keep the model out of execution and leverage control.']
          : ['Train only shadow models first; main label must be outperform_skip_after_cost, not stop-loss avoidance.'],
      }],
    },
    {
      phase: 'P2',
      completionPct: 10,
      status: 'blocked',
      items: [{
        id: 'P2-A',
        title: 'Prospective locked OOS and promotion-grade statistics',
        status: 'blocked',
        completionPct: input.prospectiveEvidenceStatus
          ? Math.min(35, 12 + Math.round(prospectiveClosedOutcomes / Math.max(1, prospectiveMinClosedOutcomes) * 20))
          : 10,
        evidencePaths: [
          input.sourceArtifacts.releaseGateStatus,
          input.sourceArtifacts.strategyPromotion,
          input.sourceArtifacts.prospectiveEvidenceStatus,
        ],
        blockers: uniqueStrings([
          ...releaseFailedChecks,
          ...researchBlocks,
          ...(input.prospectiveEvidenceStatus ? [] : ['prospective_evidence_status_missing']),
          ...(prospectiveOpenEvents > 0 ? [] : ['prospective_open_observations_missing']),
          `prospective_evidence_status:${prospectiveEvidenceStatus ?? 'missing'}`,
          ...prospectiveBlockers.slice(0, 12).map(reason => `prospective_evidence:${reason}`),
        ]),
        nextActions: [
          'Keep prospective observation capture and settle running from the scheduler; do not convert open observations into execution evidence.',
          'Lock rules, collect future-only evidence, then require WFO/PBO/DSR/FDR plus bootstrap block-size sensitivity.',
        ],
      }],
    },
    {
      phase: 'P3',
      completionPct: 5,
      status: 'not_started',
      items: [{
        id: 'P3-A',
        title: 'Portfolio sleeve allocation and marginal utility',
        status: 'not_started',
        completionPct: 5,
        evidencePaths: [],
        blockers: ['requires_p2_surviving_candidates', 'requires_low_correlation_sleeves'],
        nextActions: ['Only add sleeves that improve marginal utility after cost, correlation, and drawdown constraints.'],
      }],
    },
  ]
}

function weightedPlanCompletion(phases: PlanCompletionPhase[]): number {
  const weights: Record<PlanCompletionPhase['phase'], number> = {
    P0: 0.35,
    P1: 0.35,
    'P1.5': 0.1,
    P2: 0.15,
    P3: 0.05,
  }
  const value = phases.reduce((sum, phase) => sum + phase.completionPct * weights[phase.phase], 0)
  return Math.round(value)
}

function buildSourceArtifactPaths(runtimeDir: string): Record<string, string> {
  const root = resolve(runtimeDir)
  return {
    strategyPromotion: join(root, 'strategy_promotion.latest.json'),
    releaseGateStatus: join(root, 'release_gate_status.json'),
    phaseReadiness: join(root, 'phase_readiness.latest.json'),
    paperGateStatus: join(root, 'paper_gate_status.json'),
    paperExecutorStatus: join(root, 'paper_executor_status.latest.json'),
    p1CostModelDiagnostics: join(root, 'p1_trading_evidence', 'cost_model_diagnostics.latest.json'),
    p1GateEffectiveness: join(root, 'p1_trading_evidence', 'gate_effectiveness_report.latest.json'),
    p1TrialLedger: join(root, 'p1_trading_evidence', 'trial_ledger.latest.json'),
    p1TrialSourceCoverage: join(root, 'p1_trading_evidence', 'trial_source_coverage.latest.json'),
    p1MfeMaeStoploss: join(root, 'p1_trading_evidence', 'mfe_mae_stoploss_report.latest.json'),
    p1StoplossRiskPolicy: join(root, 'p1_trading_evidence', 'stoploss_risk_policy.latest.json'),
    productionRiskPolicy: join(root, 'production_risk_policy.latest.json'),
    liveDataFreshness: join(root, 'live_data_freshness.latest.json'),
    routeCostBudget: join(root, 'route_cost_budget.latest.json'),
    feeSnapshot: join(root, 'fee_snapshot.latest.json'),
    feeSnapshotRefresh: join(root, 'fee_snapshot_refresh.latest.json'),
    openAliceDataCatalog: join(root, 'openalice_data_catalog.latest.json'),
    openAliceDownloadMonitor: join(root, 'openalice_download_monitor.latest.json'),
    okxPublicConnectivityDiagnosis: join(root, 'okx_public_connectivity_diagnosis.latest.json'),
    okxPrivateAuthDiagnosis: join(root, 'okx_private_auth_diagnosis.latest.json'),
    researchIncubationPlan: resolve(root, '..', 'research', 'research_incubation_plan.latest.json'),
    researchLineRetirement: resolve(root, '..', 'research', 'research_line_retirement.latest.json'),
    nextResearchHypothesisPlan: resolve(root, '..', 'research', 'next_research_hypothesis_plan.latest.json'),
    ethCarryResearchEvidenceStatus: resolve(root, '..', 'research', 'eth_carry_research_evidence_status.latest.json'),
    ethCarrySignalDiagnostics: resolve(root, '..', 'research', 'eth_carry_signal_diagnostics.latest.json'),
    ethCarryConfluenceCandidateStatus: resolve(root, '..', 'research', 'eth_carry_confluence_candidate_status.latest.json'),
    ethCarryConfluenceValidation: resolve(root, '..', 'research', 'eth_carry_confluence_validation.latest.json'),
    ethCarryConfluenceTrialStatus: resolve(root, '..', 'research', 'eth_carry_confluence_trial_status.latest.json'),
    ethCarryConfluenceRefinementSweep: resolve(root, '..', 'research', 'eth_carry_confluence_refinement_sweep.latest.json'),
    ethCarryDataGapStatus: resolve(root, '..', 'research', 'eth_carry_data_gap_status.latest.json'),
    ethCarryProspectiveEvidenceStatus: resolve(root, '..', 'research', 'eth_carry_prospective_evidence_status.latest.json'),
    ethCarryProspectiveWatchdog: join(root, 'eth_carry_prospective_watchdog.latest.json'),
    okxRouteCostSlippageReadiness: join(root, 'okx_route_cost_slippage_readiness.latest.json'),
    aiScientistCryptoCandidateIntake: resolve(root, '..', 'research', 'ai_scientist_crypto_candidate_intake.latest.json'),
    aiScientistSecondValidationQueue: resolve(root, '..', 'research', 'ai_scientist_openalice_second_validation_queue.latest.json'),
    aiScientistCandidateSourceManifest: resolve(root, '..', 'research', 'ai_scientist_openalice_candidate_source_manifest.latest.json'),
    aiScientistSecondValidationReadiness: resolve(root, '..', 'research', 'ai_scientist_openalice_second_validation_readiness.latest.json'),
    aiScientistPitReproductionPlan: resolve(root, '..', 'research', 'ai_scientist_openalice_pit_reproduction_plan.latest.json'),
    aiScientistPitRebuildQueue: resolve(root, '..', 'research', 'ai_scientist_openalice_pit_rebuild_queue.latest.json'),
    aiScientistOhlcvNativeRebuildPlan: resolve(root, '..', 'research', 'ai_scientist_openalice_ohlcv_native_rebuild_plan.latest.json'),
    aiScientistOhlcvDailySupplementPlan: resolve(root, '..', 'research', 'ai_scientist_openalice_ohlcv_daily_supplement_plan.latest.json'),
    aiScientistOhlcvNativeRows: resolve(root, '..', 'research', 'ai_scientist_openalice_ohlcv_native_rows.latest.json'),
    aiScientistPitNativeRebuildStatus: resolve(root, '..', 'research', 'ai_scientist_openalice_pit_native_rebuild_status.latest.json'),
    aiScientistPitInputDataset: resolve(root, '..', 'research', 'ai_scientist_openalice_pit_input_dataset.latest.json'),
    aiScientistPitContractStatus: resolve(root, '..', 'research', 'ai_scientist_openalice_pit_contract_status.latest.json'),
    ohlcvCollectorPitContractStatus: resolve(root, '..', 'research', 'openalice_ohlcv_collector_pit_contract_status.latest.json'),
    strategyDefectMonitor: resolve(root, '..', 'research', 'strategy_defect_monitor.latest.json'),
    strategyDefectRegistry: resolve(root, '..', 'research', 'strategy_defect_registry.latest.json'),
    strategyQualityGateCoverage: resolve(root, '..', 'research', 'strategy_quality_gate_coverage.latest.json'),
    quantFrameworkBenchmarkReport: resolve(root, '..', 'research', 'quant_framework_benchmark_report.latest.json'),
    researchCandidateSummary: resolve(root, '..', 'research', 'candidate_ranking.latest.json'),
    cryptoFactorFamilyReport: resolve(root, '..', 'research', 'crypto_factor_family.live_accumulated.latest.json'),
    liquidityConditionedFactorReport: resolve(root, '..', 'research', 'liquidity_conditioned_factor_report.live_accumulated.latest.json'),
    prospectiveEvidenceStatus: resolve(root, '..', 'research', 'rank_ic_prospective_evidence_status.live_accumulated_fwd72_median_filter.latest.json'),
    liquidityConditionedProspectiveEvidenceStatus: resolve(root, '..', 'research', 'liquidity_conditioned_prospective_evidence_status.live_accumulated.latest.json'),
    metaLabelingShadowReadiness: join(root, 'meta_labeling_shadow_readiness.latest.json'),
    dirtyWorktreeAudit: join(root, 'dirty_worktree_audit.latest.json'),
    externalDerivativesCollect: join(root, 'external_derivatives_data_collect.latest.json'),
    paperPolicyShadowSettle: join(root, 'paper_policy_shadow_settle.latest.json'),
    schedulerSecurityAudit: join(root, 'scheduler_security_audit.latest.json'),
    goalCompletionAudit: join(root, 'openalice_goal_completion_audit.latest.json'),
    runtimeManifestCoverage: join(root, 'runtime_manifest_coverage.latest.json'),
    cpTrace: join(root, 'cp_signal_trace.ndjson'),
    icRuntimeStatus: join(root, 'ic_monitor_status.latest.json'),
    cryptoDlSidecarStatus: join(root, 'crypto_dl_sidecar_status.latest.json'),
    signalHealthStatus: join(root, 'signal_health.latest.json'),
    replayGateStatus: join(root, 'replay_gate.latest.json'),
    implementationShortfallStatus: join(root, 'implementation_shortfall.latest.json'),
  }
}

function findCheck(releaseGateStatus: UnknownRecord | null, name: string): UnknownRecord | null {
  const checks = Array.isArray(releaseGateStatus?.checks) ? releaseGateStatus.checks : []
  return asRecord(checks.find(check => readString(asRecord(check)?.name) === name))
}

function summarizeCpTrace(lines: string[], generatedAt: string): {
  lines: number
  staleAlerts: number
  loggedObservations: number
  maxSignalAgeMs: number | null
  ttlExpiredSignalCount: number
  latestTraceAgeMs: number | null
  latestRejectReasons: string[]
} {
  const rejectReasons: string[] = []
  let staleAlerts = 0
  let loggedObservations = 0
  let maxSignalAgeMs: number | null = null
  let ttlExpiredSignalCount = 0
  let latestTraceTimestampMs: number | null = null
  const generatedAtMs = Date.parse(generatedAt)
  for (const line of lines) {
    const item = asRecord(parseJsonLine(line))
    if (!item) continue
    const timestamp = readString(item.timestamp)
    const timestampMs = timestamp ? Date.parse(timestamp) : NaN
    if (Number.isFinite(timestampMs)) latestTraceTimestampMs = Math.max(latestTraceTimestampMs ?? timestampMs, timestampMs)
    if (readString(item.step) === 'stale' && readString(item.status) === 'alert') staleAlerts++
    if (readString(item.step) === 'observation' && readString(item.status) === 'logged') loggedObservations++
    const meta = asRecord(item.meta)
    const ageMs = readNumber(meta?.ageMs)
    if (ageMs != null) maxSignalAgeMs = Math.max(maxSignalAgeMs ?? ageMs, ageMs)
    const reason = readString(meta?.reason)
    if (reason) {
      rejectReasons.push(reason)
      if (reason === 'ttl_expired') ttlExpiredSignalCount++
    }
  }
  return {
    lines: lines.length,
    staleAlerts,
    loggedObservations,
    maxSignalAgeMs,
    ttlExpiredSignalCount,
    latestTraceAgeMs: Number.isFinite(generatedAtMs) && latestTraceTimestampMs != null
      ? Math.max(0, generatedAtMs - latestTraceTimestampMs)
      : null,
    latestRejectReasons: [...new Set(rejectReasons.slice(-10))],
  }
}

function classifyCpModeTargetConsistency(
  mode: string | null,
  positiveTargets: number,
  zeroTargetSignalCount: number,
  signalCount: number,
): 'consistent' | 'missing_payload' | 'observation_nonzero_target' | 'ticket_zero_positive_targets' | 'unknown_mode' {
  if (!mode) return 'missing_payload'
  if (mode === 'observation') return positiveTargets > 0 ? 'observation_nonzero_target' : 'consistent'
  if (mode === 'ticket') return positiveTargets === 0 && zeroTargetSignalCount === signalCount
    ? 'ticket_zero_positive_targets'
    : 'consistent'
  return 'unknown_mode'
}

function summarizeCpPayloadTtl(signals: UnknownRecord[], generatedAtMs: number): {
  currentPayloadMaxAgeMs: number | null
  currentPayloadFreshSignalCount: number
  currentPayloadTtlExpiredSignalCount: number
  currentPayloadInvalidTimestampCount: number
  currentPayloadInvalidTtlCount: number
} {
  let currentPayloadMaxAgeMs: number | null = null
  let currentPayloadFreshSignalCount = 0
  let currentPayloadTtlExpiredSignalCount = 0
  let currentPayloadInvalidTimestampCount = 0
  let currentPayloadInvalidTtlCount = 0
  for (const signal of signals) {
    const asOf = readString(signal.as_of)
    const asOfMs = asOf ? Date.parse(asOf) : NaN
    const ttlMs = readNumber(signal.ttl_ms)
    if (!Number.isFinite(asOfMs) || !Number.isFinite(generatedAtMs)) {
      currentPayloadInvalidTimestampCount += 1
      continue
    }
    if (ttlMs == null || ttlMs <= 0) {
      currentPayloadInvalidTtlCount += 1
      continue
    }
    const ageMs = Math.max(0, generatedAtMs - asOfMs)
    currentPayloadMaxAgeMs = Math.max(currentPayloadMaxAgeMs ?? ageMs, ageMs)
    if (ageMs > ttlMs) currentPayloadTtlExpiredSignalCount += 1
    else currentPayloadFreshSignalCount += 1
  }
  return {
    currentPayloadMaxAgeMs,
    currentPayloadFreshSignalCount,
    currentPayloadTtlExpiredSignalCount,
    currentPayloadInvalidTimestampCount,
    currentPayloadInvalidTtlCount,
  }
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null
  }
}

function readTailLinesIfExists(path: string, limit: number): string[] {
  try {
    const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean)
    return lines.slice(-limit)
  } catch {
    return []
  }
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
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

function readErrorSummary(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) out[key] = raw
  }
  return out
}

function formatErrorSummaryBlockers(prefix: string, summary: Record<string, number>): string[] {
  return Object.entries(summary)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${prefix}:${key}:${count}`)
}

function readFieldCountBlockers(value: unknown): Array<{ field: string; count: number }> {
  if (!Array.isArray(value)) return []
  return value
    .map(item => {
      const record = asRecord(item)
      const field = readString(record?.field)
      const count = readNumber(record?.missingPositions)
      return field && count != null && count > 0 ? { field, count } : null
    })
    .filter((item): item is { field: string; count: number } => item != null)
}

function readProducerGuardMissingCostTargets(value: unknown): number {
  if (!Array.isArray(value)) return 0
  return value
    .map(asRecord)
    .filter((item): item is UnknownRecord => item != null)
    .filter(item =>
      readString(item.producerGuardStatus) === 'producer_guard_enforced' &&
      (readNumber(item.missingPredictedCost) ?? 0) > 0,
    )
    .length
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function summarizeIcDecay(blockingReasons: string[]): {
  decayedFactorCount: number
  decayedSymbolCount: number
  decayedPairCount: number
  decayedSymbols: string[]
  decayedFactors: string[]
} {
  const symbols = new Set<string>()
  const factors = new Set<string>()
  let decayedPairCount = 0
  for (const reason of blockingReasons) {
    const match = /^symbol:([^:]+):factor:([^:]+):ic_decay_status:decayed$/.exec(reason)
    if (!match) continue
    symbols.add(match[1])
    factors.add(match[2])
    decayedPairCount++
  }
  return {
    decayedFactorCount: factors.size,
    decayedSymbolCount: symbols.size,
    decayedPairCount,
    decayedSymbols: [...symbols].sort(),
    decayedFactors: [...factors].sort(),
  }
}

function bucketAllocatorBlockingReasons(blockingReasons: string[]): Record<string, number> {
  const buckets = {
    paper_gate: 0,
    promotion_release: 0,
    paper_quality: 0,
    p1_evidence_trust: 0,
    allocator_state: 0,
    config_disabled: 0,
    other: 0,
  }
  for (const reason of blockingReasons) {
    const bucket = classifyAllocatorBlockingReason(reason)
    buckets[bucket]++
  }
  return buckets
}

function classifyAllocatorBlockingReason(reason: string): AllocatorBlockerBucket {
  if (
    reason.includes('p1_evidence_trust') ||
    reason.includes('production_risk_policy') ||
    reason.includes('trial_ledger') ||
    reason.includes('fdr') ||
    reason.includes('pit_') ||
    reason.includes('source_eligibility')
  ) return 'p1_evidence_trust'
  if (
    reason.includes('promotion_v2_global_release') ||
    reason.includes('release_gate') ||
    reason === 'release_gate_not_approved' ||
    reason.includes('wfo') ||
    reason.includes('significance') ||
    reason.includes('pbo')
  ) return 'promotion_release'
  if (
    reason.includes('p1_gate') ||
    reason.includes('p1_cost') ||
    reason.includes('cost_') ||
    reason.includes('gross_to_cost') ||
    reason.includes('net_edge') ||
    reason.includes('expectancy') ||
    reason.includes('benchmark') ||
    reason.includes('stop_loss') ||
    reason.includes('stoploss') ||
    reason.includes('paper_days') ||
    reason.includes('paper_trades') ||
    reason.includes('execution_recent')
  ) return 'paper_quality'
  if (
    reason.includes('paper_research') ||
    reason.includes('paper_release') ||
    reason.includes('gate_expired:paper') ||
    reason.includes('blocks_paper_orders')
  ) return 'paper_gate'
  if (
    reason.includes('executor_disabled') ||
    reason.includes('enable') ||
    reason.includes('disabled') ||
    reason.includes('config')
  ) return 'config_disabled'
  if (
    reason.includes('champion') ||
    reason.includes('policy_version') ||
    reason.includes('nonflat_target') ||
    reason.includes('target_missing') ||
    reason.includes('allocator')
  ) return 'allocator_state'
  return 'other'
}

function maxNumber(values: Array<number | null>): number | null {
  const finiteValues = values.filter((value): value is number => value != null && Number.isFinite(value))
  return finiteValues.length > 0 ? Math.max(...finiteValues) : null
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function renderSystemStatusReasonChainMarkdown(report: SystemStatusReasonChainReport): string {
  const lines: string[] = []
  lines.push('# System Status Reason Chain')
  lines.push('')
  lines.push(`Generated: \`${report.generatedAt}\``)
  lines.push(`Declared status: \`${report.declaredStatus}\``)
  lines.push(`Effective actionability: \`${report.effectiveActionability}\``)
  lines.push(`Overall plan completion: ${report.overallPlanCompletionPct}%`)
  lines.push('')
  lines.push('## Reason Chain')
  lines.push('')
  lines.push('| component | status | promotion | paper execution | summary |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const reason of report.reasonChain) {
    lines.push(
      `| ${reason.component} | ${reason.status} | ${reason.usableForPromotion} | ` +
      `${reason.usableForPaperExecution} | ${reason.summary} |`,
    )
  }
  lines.push('')
  lines.push('## Completion')
  lines.push('')
  for (const phase of report.planCompletion) {
    lines.push(`- ${phase.phase}: ${phase.completionPct}% (${phase.status})`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseSystemStatusReasonChainArgs(argv)
  const report = await runSystemStatusReasonChain(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderSystemStatusReasonChainMarkdown(report))
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
