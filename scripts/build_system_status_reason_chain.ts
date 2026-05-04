import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import type { EvidenceManifest } from '../src/runtime/evidence_manifest.js'

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
  component: 'WFO' | 'IC' | 'Allocator' | 'CP bridge'
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
    metaLabelingShadowReadiness: await readJsonIfExists(sourceArtifacts.metaLabelingShadowReadiness),
    icMonitorStatus: await readJsonIfExists(sourceArtifacts.icRuntimeStatus),
    dirtyWorktreeAudit: await readJsonIfExists(sourceArtifacts.dirtyWorktreeAudit),
    runtimeManifestCoverage: await readJsonIfExists(sourceArtifacts.runtimeManifestCoverage),
    externalDerivativesCollect: await readJsonIfExists(sourceArtifacts.externalDerivativesCollect),
    paperPolicyShadowSettle: await readJsonIfExists(sourceArtifacts.paperPolicyShadowSettle),
    cpBridge: await readJsonIfExists(resolve(args.cpBridgePath)),
    cpTraceLines: readTailLinesIfExists(sourceArtifacts.cpTrace, DEFAULT_CP_TRACE_TAIL_LINES),
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
  metaLabelingShadowReadiness?: unknown
  icMonitorStatus?: unknown
  dirtyWorktreeAudit?: unknown
  runtimeManifestCoverage?: unknown
  externalDerivativesCollect?: unknown
  paperPolicyShadowSettle?: unknown
  cpBridge?: unknown
  cpTraceLines?: string[]
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
  const metaLabelingShadowReadiness = asRecord(input.metaLabelingShadowReadiness)
  const dirtyWorktreeAudit = asRecord(input.dirtyWorktreeAudit)
  const runtimeManifestCoverage = asRecord(input.runtimeManifestCoverage)
  const externalDerivativesCollect = asRecord(input.externalDerivativesCollect)
  const paperPolicyShadowSettle = asRecord(input.paperPolicyShadowSettle)
  const cpBridge = asRecord(input.cpBridge)
  const sourceArtifacts = input.sourceArtifacts ?? buildSourceArtifactPaths(DEFAULT_RUNTIME_DIR)

  const reasonChain = [
    buildWfoReason(releaseGateStatus, strategyPromotion, sourceArtifacts),
    buildIcReason(asRecord(input.icMonitorStatus), sourceArtifacts),
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
  }
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
          status: externalRows > 0 && !externalDryRun ? 'done' : 'partial',
          completionPct: externalRows > 0 && !externalDryRun ? 85 : 45,
          evidencePaths: [input.sourceArtifacts.externalDerivativesCollect],
          blockers: externalRows > 0 && !externalDryRun ? [] : ['external_derivatives_rows_not_appended'],
          nextActions: ['Keep UTC append-only collection running for funding, premiumIndex, OI, OI history, and long/short.'],
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
        completionPct: 10,
        evidencePaths: [input.sourceArtifacts.releaseGateStatus, input.sourceArtifacts.strategyPromotion],
        blockers: [...releaseFailedChecks, ...researchBlocks],
        nextActions: ['Lock rules, collect future-only evidence, then require WFO/PBO/DSR/FDR plus bootstrap block-size sensitivity.'],
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
    routeCostBudget: join(root, 'route_cost_budget.latest.json'),
    feeSnapshot: join(root, 'fee_snapshot.latest.json'),
    metaLabelingShadowReadiness: join(root, 'meta_labeling_shadow_readiness.latest.json'),
    dirtyWorktreeAudit: join(root, 'dirty_worktree_audit.latest.json'),
    externalDerivativesCollect: join(root, 'external_derivatives_data_collect.latest.json'),
    paperPolicyShadowSettle: join(root, 'paper_policy_shadow_settle.latest.json'),
    runtimeManifestCoverage: join(root, 'runtime_manifest_coverage.latest.json'),
    cpTrace: join(root, 'cp_signal_trace.ndjson'),
    icRuntimeStatus: join(root, 'ic_monitor_status.latest.json'),
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
