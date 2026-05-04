import type { SignificanceGateResult } from './statistical_significance.js'
import type { RiskSimulationResult } from './risk_simulation.js'

export type ReleaseGateStatus = 'pass' | 'warn' | 'fail' | 'skipped'

export interface SlippageGateDecision {
  action: 'monitor' | 'reduce_or_pause'
  consecutiveBreaches: number
  requiredConsecutiveDays: number
  breachedDates: string[]
  latestDriftMultiplier: number | null
}

export interface RampUpStageLike {
  allocationPct: number
}

export interface RampUpEvaluation {
  decision: 'stay' | 'promote' | 'rollback'
  reason:
    | 'promotion_ready'
    | 'insufficient_sample'
    | 'drawdown_breach'
    | 'max_stage_reached'
    | 'min_stage_reached'
  currentStage: RampUpStageLike
  targetStage: RampUpStageLike
  drawdownBreached: boolean
}

export interface WfoWindowLike {
  degradationRate: number
}

export interface WfoResultLike {
  overallPassed: boolean
  failedWindows: number
  windows: WfoWindowLike[]
}

export interface RegimeShiftGateInput {
  triggered: boolean
  severity: 'none' | 'watch' | 'high'
  reason?: string
}

export interface EconomicsGateInput {
  grossExpectancyPct: number
  netExpectancyPct: number
  feeExpectancyDragPct: number
  slippageExpectancyDragPct: number
  fundingExpectancyDragPct: number
  totalCostsPaid: number
  costDragPctOfInitialCapital: number
  averageHoldingHours: number
  medianHoldingHours: number
  tradeCount: number
}

export interface StrategyPlanEvidenceGateInput {
  crossAssetRegimeConsistency?: {
    available: boolean
    result?: {
      consistent?: boolean
      highConfidenceCount?: number
      disagreementCount?: number
      anchorDisagreement?: boolean
      reasons?: string[]
    }
    reason?: string | null
  }
  alphaFactorAdmission?: {
    available: boolean
    totalCandidates?: number
    acceptedCount?: number
    admissionGatePassedCount?: number
    admissionGateFailedCount?: number
    runtimeAcceptedAdmissionGateFailedCount?: number
    reason?: string | null
  }
  rollingSharpeUniverseSelection?: {
    available: boolean
    required?: boolean
    selection?: {
      longSymbols?: string[]
      shortSymbols?: string[]
      scores?: unknown[]
    }
    reason?: string | null
  }
  stableCorrelationClustering?: {
    available: boolean
    clusters?: Array<{ symbols: string[] }>
    reason?: string | null
  }
  regimeIdentityTracking?: {
    available: boolean
    effectiveSampleSize?: number
    reason?: string | null
  }
  sessionAwareSlippageEstimate?: {
    available: boolean
    tradeCount?: number
    reason?: string | null
  }
}

export interface ReleaseGateCheck {
  name:
    | 'wfo'
    | 'significance'
    | 'risk_simulation'
    | 'economics'
    | 'strategy_plan_evidence'
    | 'execution_quality'
    | 'ramp_up'
    | 'regime_shift'
  status: ReleaseGateStatus
  summary: string
  metrics: Record<string, number | string | boolean | null>
}

export interface ReleaseGateThresholds {
  wfoWarnAverageDegradation: number
  wfoFailAverageDegradation: number
  wfoFailWindowRatio: number
  pboMax: number
  pboMinTrials: number
  dsrMin: number
  fdrQMax: number
  maxCostDragPctOfInitialCapital: number
  minAverageHoldingHours: number
}

export interface ReleaseGateInput {
  wfo?: Pick<WfoResultLike, 'overallPassed' | 'failedWindows' | 'windows'>
  significance?: SignificanceGateResult
  riskSimulation?: RiskSimulationResult
  economics?: EconomicsGateInput
  strategyPlanEvidence?: StrategyPlanEvidenceGateInput
  executionQuality?: SlippageGateDecision
  rampUp?: RampUpEvaluation
  regimeShift?: RegimeShiftGateInput
  thresholds?: Partial<ReleaseGateThresholds>
}

export interface ReleaseGateResult {
  checks: ReleaseGateCheck[]
  failedChecks: ReleaseGateCheck['name'][]
  warningChecks: ReleaseGateCheck['name'][]
  hardFail: boolean
  allowPaperTrading: boolean
  allowLiveTrading: boolean
}

const DEFAULT_THRESHOLDS: ReleaseGateThresholds = {
  wfoWarnAverageDegradation: 0.3,
  wfoFailAverageDegradation: 0.4,
  wfoFailWindowRatio: 0.3,
  pboMax: 0.1,
  pboMinTrials: 20,
  dsrMin: 0.95,
  fdrQMax: 0.05,
  maxCostDragPctOfInitialCapital: 15,
  minAverageHoldingHours: 4,
}

export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...input.thresholds,
  }

  const checks: ReleaseGateCheck[] = []
  checks.push(evaluateWfoCheck(input.wfo, thresholds))
  checks.push(evaluateSignificanceCheck(input.significance, thresholds))
  checks.push(evaluateRiskSimulationCheck(input.riskSimulation))
  checks.push(evaluateEconomicsCheck(input.economics, thresholds))
  checks.push(evaluateStrategyPlanEvidenceCheck(input.strategyPlanEvidence))
  checks.push(evaluateExecutionCheck(input.executionQuality))
  checks.push(evaluateRampUpCheck(input.rampUp))
  checks.push(evaluateRegimeShiftCheck(input.regimeShift))

  const failedChecks = checks.filter((check) => check.status === 'fail').map((check) => check.name)
  const warningChecks = checks.filter((check) => check.status === 'warn').map((check) => check.name)

  const paperBlockingNames: ReleaseGateCheck['name'][] = [
    'wfo',
    'significance',
    'risk_simulation',
    'economics',
    'strategy_plan_evidence',
  ]
  const liveBlockingNames: ReleaseGateCheck['name'][] = [
    'wfo',
    'significance',
    'risk_simulation',
    'economics',
    'strategy_plan_evidence',
    'execution_quality',
    'ramp_up',
    'regime_shift',
  ]
  const requiredLiveCheckNames: ReleaseGateCheck['name'][] = [
    'execution_quality',
    'ramp_up',
    'regime_shift',
  ]

  const allowPaperTrading = !checks.some(
    (check) => paperBlockingNames.includes(check.name) && check.status === 'fail',
  )
  const significanceIndeterminate = checks.some(
    (check) =>
      check.name === 'significance' &&
      check.status === 'warn' &&
      check.metrics.pboStatus === 'indeterminate',
  )
  const allowLiveTrading = !checks.some(
    (check) => liveBlockingNames.includes(check.name) && check.status === 'fail',
  ) && !checks.some(
    (check) => requiredLiveCheckNames.includes(check.name) && check.status === 'skipped',
  ) && !significanceIndeterminate

  return {
    checks,
    failedChecks,
    warningChecks,
    hardFail: failedChecks.length > 0,
    allowPaperTrading,
    allowLiveTrading,
  }
}

function evaluateRiskSimulationCheck(
  riskSimulation: RiskSimulationResult | undefined,
): ReleaseGateCheck {
  if (!riskSimulation) {
    return {
      name: 'risk_simulation',
      status: 'skipped',
      summary: 'Risk simulation not provided; skipping gate.',
      metrics: {},
    }
  }

  const failed = !riskSimulation.gatePassed
  return {
    name: 'risk_simulation',
    status: failed ? 'fail' : 'pass',
    summary: failed
      ? 'Risk simulation gate failed.'
      : 'Risk simulation gate passed.',
    metrics: {
      method: riskSimulation.method,
      simulations: riskSimulation.simulations,
      horizonBars: riskSimulation.horizonBars,
      profitProbability: riskSimulation.profitProbability,
      minProfitProbability: riskSimulation.minProfitProbability,
      riskOfRuin: riskSimulation.riskOfRuin,
      maxRuinProbability: riskSimulation.maxRuinProbability,
    },
  }
}

function evaluateWfoCheck(
  wfo: ReleaseGateInput['wfo'],
  thresholds: ReleaseGateThresholds,
): ReleaseGateCheck {
  if (!wfo) {
    return {
      name: 'wfo',
      status: 'skipped',
      summary: 'WFO not provided; skipping gate.',
      metrics: {},
    }
  }

  const windowCount = wfo.windows.length
  const finiteDegradation = wfo.windows
    .map((window) => window.degradationRate)
    .filter((value) => Number.isFinite(value))
  const averageDegradation =
    finiteDegradation.length > 0
      ? finiteDegradation.reduce((sum, value) => sum + value, 0) / finiteDegradation.length
      : null
  const failedWindowRatio = windowCount > 0 ? wfo.failedWindows / windowCount : 0

  const failed =
    !wfo.overallPassed ||
    (averageDegradation !== null && averageDegradation > thresholds.wfoFailAverageDegradation) ||
    failedWindowRatio > thresholds.wfoFailWindowRatio

  if (failed) {
    return {
      name: 'wfo',
      status: 'fail',
      summary: 'WFO gate failed.',
      metrics: {
        overallPassed: wfo.overallPassed,
        failedWindows: wfo.failedWindows,
        windowCount,
        failedWindowRatio,
        averageDegradation,
        failAverageDegradationThreshold: thresholds.wfoFailAverageDegradation,
        failWindowRatioThreshold: thresholds.wfoFailWindowRatio,
      },
    }
  }

  const warned =
    (averageDegradation !== null && averageDegradation > thresholds.wfoWarnAverageDegradation) ||
    failedWindowRatio > thresholds.wfoFailWindowRatio / 2

  return {
    name: 'wfo',
    status: warned ? 'warn' : 'pass',
    summary: warned ? 'WFO gate passed with warnings.' : 'WFO gate passed.',
    metrics: {
      overallPassed: wfo.overallPassed,
      failedWindows: wfo.failedWindows,
      windowCount,
      failedWindowRatio,
      averageDegradation,
      warnAverageDegradationThreshold: thresholds.wfoWarnAverageDegradation,
      failAverageDegradationThreshold: thresholds.wfoFailAverageDegradation,
      failWindowRatioThreshold: thresholds.wfoFailWindowRatio,
    },
  }
}

function evaluateSignificanceCheck(
  significance: SignificanceGateResult | undefined,
  thresholds: ReleaseGateThresholds,
): ReleaseGateCheck {
  if (!significance) {
    return {
      name: 'significance',
      status: 'fail',
      summary: 'Significance stats not provided; failing gate.',
      metrics: {
        fdrStatus: 'missing',
        trialLedgerStatus: 'fail',
        trialLedgerBlocks: 'trial_ledger_missing',
      },
    }
  }

  const pbo = significance.pboResult.pbo
  const dsrProbability = significance.dsrResult.dsrProbability
  const candidateTrialCount = significance.candidateTrialCount
    ?? significance.dsrResult.trialCount
    ?? significance.pboResult.logits.length
  const hasEnoughPboTrials = candidateTrialCount >= thresholds.pboMinTrials
  const pboStatus = !hasEnoughPboTrials
    ? 'indeterminate'
    : pbo <= thresholds.pboMax
      ? 'pass'
      : 'fail'
  const fdrQ = significance.fdrQ ?? null
  const fdrStatus = fdrQ === null
    ? 'missing'
    : fdrQ < thresholds.fdrQMax
      ? 'pass'
      : 'fail'
  const trialLedger = significance.trialLedger ?? null
  const trialLedgerBlocks = evaluateTrialLedgerBlocks(trialLedger, candidateTrialCount)
  const trialLedgerStatus = trialLedgerBlocks.length === 0 ? 'pass' : 'fail'
  const fdrDiagnostics = significance.fdrDiagnostics ?? null
  const spaBootstrapDirectionStable = fdrDiagnostics?.method === 'spa'
    ? fdrDiagnostics.bootstrapDirectionStable ?? null
    : null
  const spaBootstrapStatus = fdrDiagnostics?.method === 'spa'
    ? spaBootstrapDirectionStable === true
      ? 'pass'
      : spaBootstrapDirectionStable === false
        ? 'fail'
        : 'missing'
    : 'not_applicable'
  const dsrStatus = dsrProbability == null
    ? 'low_sample'
    : dsrProbability >= thresholds.dsrMin
      ? 'pass'
      : 'fail'
  const failed = pboStatus === 'fail' ||
    dsrStatus === 'fail' ||
    fdrStatus !== 'pass' ||
    trialLedgerStatus === 'fail' ||
    spaBootstrapStatus === 'fail' ||
    spaBootstrapStatus === 'missing'
  const lowSampleDsrFailed = dsrStatus === 'low_sample'
  const status: ReleaseGateStatus = failed || lowSampleDsrFailed ? 'fail' : pboStatus === 'indeterminate' ? 'warn' : 'pass'
  const warned = status === 'warn'

  return {
    name: 'significance',
    status,
    summary: lowSampleDsrFailed
      ? 'Statistical significance gate failed due to low DSR sample.'
      : failed
        ? 'Statistical significance gate failed.'
        : warned
          ? 'Statistical significance gate is indeterminate because candidate trials are insufficient.'
          : 'Statistical significance gate passed.',
    metrics: {
      pbo,
      pboMax: thresholds.pboMax,
      pboMinTrials: thresholds.pboMinTrials,
      pboStatus,
      dsrValue: significance.dsrResult.dsrValue,
      dsrProbability,
      dsrProbabilityMin: thresholds.dsrMin,
      dsrStatus,
      dsrDiagnosticQuality: significance.dsrResult.diagnosticQuality ?? null,
      dsrIndependentBets: significance.dsrResult.independentBets ?? null,
      dsrMinimumIndependentBets: significance.dsrResult.minimumIndependentBets ?? null,
      dsrBlockedReason: significance.dsrResult.blockedReason ?? null,
      fdrQ,
      fdrQMax: thresholds.fdrQMax,
      fdrStatus,
      trialLedgerStatus,
      trialLedgerBlocks: trialLedgerBlocks.join(','),
      trialLedgerRawM: trialLedger?.rawM ?? null,
      trialLedgerEffectiveM: trialLedger?.effectiveM ?? null,
      trialLedgerRawMComplete: trialLedger?.rawMComplete ?? null,
      trialLedgerIncludesFailedTrials: trialLedger?.includesFailedTrials ?? null,
      trialLedgerFailedTrialCount: trialLedger?.failedTrialCount ?? null,
      trialLedgerSurvivingTrialCount: trialLedger?.survivingTrialCount ?? null,
      trialLedgerFdrMethodPrimary: trialLedger?.fdrMethodPrimary ?? null,
      fdrMethod: fdrDiagnostics?.method ?? null,
      spaBootstrapStatus,
      spaBootstrapDirectionStable,
      spaUnstableBootstrapCandidateIndexes: fdrDiagnostics?.unstableBootstrapCandidateIndexes?.join(',') ?? null,
      spaBlockSizeSet: fdrDiagnostics?.blockSizeSet?.join(',') ?? null,
      candidateCount: significance.pboResult.logits.length,
      candidateTrialCount,
    },
  }
}

function evaluateTrialLedgerBlocks(
  trialLedger: SignificanceGateResult['trialLedger'] | null | undefined,
  candidateTrialCount: number,
): string[] {
  if (!trialLedger) return ['trial_ledger_missing']

  const blocks: string[] = []
  if (!trialLedger.rawMComplete) blocks.push('trial_ledger_raw_m_incomplete')
  if (!trialLedger.includesFailedTrials) blocks.push('trial_ledger_missing_failed_trials')
  if (!Number.isFinite(trialLedger.rawM) || trialLedger.rawM <= 0) {
    blocks.push('trial_ledger_raw_m_invalid')
  } else if (trialLedger.rawM < candidateTrialCount) {
    blocks.push('trial_ledger_raw_m_below_candidate_trial_count')
  }
  if (!Number.isFinite(trialLedger.survivingTrialCount) || trialLedger.survivingTrialCount < 0) {
    blocks.push('trial_ledger_surviving_count_invalid')
  }
  if (!Number.isFinite(trialLedger.failedTrialCount) || trialLedger.failedTrialCount < 0) {
    blocks.push('trial_ledger_failed_count_invalid')
  }
  if (
    Number.isFinite(trialLedger.rawM) &&
    Number.isFinite(trialLedger.survivingTrialCount) &&
    Number.isFinite(trialLedger.failedTrialCount) &&
    trialLedger.failedTrialCount + trialLedger.survivingTrialCount > trialLedger.rawM
  ) {
    blocks.push('trial_ledger_counts_exceed_raw_m')
  }
  if (trialLedger.fdrMethodPrimary && trialLedger.fdrMethodPrimary !== 'BY_raw_m') {
    blocks.push('trial_ledger_primary_fdr_not_by_raw_m')
  }
  return blocks
}

function evaluateExecutionCheck(
  executionQuality: SlippageGateDecision | undefined,
): ReleaseGateCheck {
  if (!executionQuality) {
    return {
      name: 'execution_quality',
      status: 'skipped',
      summary: 'Execution quality gate not provided; skipping gate.',
      metrics: {},
    }
  }

  const failed = executionQuality.action === 'reduce_or_pause'
  return {
    name: 'execution_quality',
    status: failed ? 'fail' : 'pass',
    summary: failed
      ? 'Execution quality gate triggered reduce_or_pause.'
      : 'Execution quality gate is healthy.',
    metrics: {
      action: executionQuality.action,
      consecutiveBreaches: executionQuality.consecutiveBreaches,
      requiredConsecutiveDays: executionQuality.requiredConsecutiveDays,
      latestDriftMultiplier: executionQuality.latestDriftMultiplier,
    },
  }
}

function evaluateEconomicsCheck(
  economics: EconomicsGateInput | undefined,
  thresholds: ReleaseGateThresholds,
): ReleaseGateCheck {
  if (!economics) {
    return {
      name: 'economics',
      status: 'skipped',
      summary: 'Economics gate not provided; skipping gate.',
      metrics: {},
    }
  }

  const totalExpectancyDragPct =
    economics.feeExpectancyDragPct
    + economics.slippageExpectancyDragPct
    + economics.fundingExpectancyDragPct
  const costsConsumeEdge = economics.grossExpectancyPct <= totalExpectancyDragPct
  const failed =
    economics.netExpectancyPct <= 0
    || economics.costDragPctOfInitialCapital > thresholds.maxCostDragPctOfInitialCapital
    || costsConsumeEdge

  const warned =
    !failed
    && economics.averageHoldingHours < thresholds.minAverageHoldingHours

  return {
    name: 'economics',
    status: failed ? 'fail' : warned ? 'warn' : 'pass',
    summary: failed
      ? 'Economics gate failed.'
      : warned
        ? 'Economics gate passed with holding-time warning.'
        : 'Economics gate passed.',
    metrics: {
      grossExpectancyPct: economics.grossExpectancyPct,
      netExpectancyPct: economics.netExpectancyPct,
      feeExpectancyDragPct: economics.feeExpectancyDragPct,
      slippageExpectancyDragPct: economics.slippageExpectancyDragPct,
      fundingExpectancyDragPct: economics.fundingExpectancyDragPct,
      totalExpectancyDragPct,
      totalCostsPaid: economics.totalCostsPaid,
      costDragPctOfInitialCapital: economics.costDragPctOfInitialCapital,
      maxCostDragPctOfInitialCapital: thresholds.maxCostDragPctOfInitialCapital,
      averageHoldingHours: economics.averageHoldingHours,
      medianHoldingHours: economics.medianHoldingHours,
      minAverageHoldingHours: thresholds.minAverageHoldingHours,
      tradeCount: economics.tradeCount,
      costsConsumeEdge,
    },
  }
}

function evaluateStrategyPlanEvidenceCheck(
  evidence: StrategyPlanEvidenceGateInput | undefined,
): ReleaseGateCheck {
  if (!evidence) {
    return {
      name: 'strategy_plan_evidence',
      status: 'skipped',
      summary: 'Strategy-plan evidence not provided; skipping gate.',
      metrics: {},
    }
  }

  const failures: string[] = []
  const advisories: string[] = []
  const crossAsset = evidence.crossAssetRegimeConsistency
  const alphaAdmission = evidence.alphaFactorAdmission
  const rollingUniverse = evidence.rollingSharpeUniverseSelection
  const stableClustering = evidence.stableCorrelationClustering
  const regimeIdentity = evidence.regimeIdentityTracking
  const sessionSlippage = evidence.sessionAwareSlippageEstimate

  if (crossAsset?.available === true) {
    if (!crossAsset.result) {
      advisories.push('cross_asset_regime_result_missing')
    } else if (crossAsset.result.consistent === false) {
      failures.push('cross_asset_regime_inconsistent')
    }
  } else if (crossAsset) {
    advisories.push('cross_asset_regime_unavailable')
  }

  const runtimeAcceptedAdmissionFailures =
    finiteNumberOrNull(alphaAdmission?.runtimeAcceptedAdmissionGateFailedCount)
  const alphaAdmissionFailureCount = finiteNumberOrNull(alphaAdmission?.admissionGateFailedCount)
  if (alphaAdmission?.available === true) {
    if (runtimeAcceptedAdmissionFailures !== null && runtimeAcceptedAdmissionFailures > 0) {
      failures.push('runtime_accepted_alpha_failed_admission')
    } else if (runtimeAcceptedAdmissionFailures === null && (alphaAdmissionFailureCount ?? 0) > 0) {
      advisories.push('alpha_admission_failures_runtime_scope_unknown')
    } else if ((alphaAdmissionFailureCount ?? 0) > 0) {
      advisories.push('alpha_pool_contains_shadow_admission_failures')
    }
  } else if (alphaAdmission) {
    advisories.push('alpha_factor_admission_unavailable')
  }

  const longCount = rollingUniverse?.selection?.longSymbols?.length ?? 0
  const shortCount = rollingUniverse?.selection?.shortSymbols?.length ?? 0
  const selectedUniverseCount = longCount + shortCount
  if (rollingUniverse?.available === true) {
    if (rollingUniverse.required === true && selectedUniverseCount === 0) {
      failures.push('required_rolling_sharpe_universe_empty')
    } else if (selectedUniverseCount === 0) {
      advisories.push('rolling_sharpe_universe_empty')
    }
  } else if (rollingUniverse) {
    advisories.push('rolling_sharpe_universe_unavailable')
  }

  const stableClusterCount = stableClustering?.clusters?.length ?? 0
  if (stableClustering?.available === false) {
    advisories.push('stable_correlation_clustering_unavailable')
  }

  if (regimeIdentity?.available === false) {
    advisories.push('regime_identity_tracking_unavailable')
  }

  if (sessionSlippage?.available === false) {
    advisories.push('session_aware_slippage_unavailable')
  }

  const failed = failures.length > 0
  const warned = !failed && advisories.length > 0
  return {
    name: 'strategy_plan_evidence',
    status: failed ? 'fail' : warned ? 'warn' : 'pass',
    summary: failed
      ? `Strategy-plan evidence gate failed: ${failures.join(', ')}.`
      : warned
        ? `Strategy-plan evidence gate passed with advisories: ${advisories.join(', ')}.`
        : 'Strategy-plan evidence gate passed.',
    metrics: {
      failureCount: failures.length,
      advisoryCount: advisories.length,
      failures: failures.join(',') || null,
      advisories: advisories.join(',') || null,
      crossAssetAvailable: crossAsset?.available ?? null,
      crossAssetConsistent: crossAsset?.result?.consistent ?? null,
      crossAssetHighConfidenceCount: finiteNumberOrNull(crossAsset?.result?.highConfidenceCount),
      crossAssetDisagreementCount: finiteNumberOrNull(crossAsset?.result?.disagreementCount),
      crossAssetAnchorDisagreement: crossAsset?.result?.anchorDisagreement ?? null,
      alphaAdmissionAvailable: alphaAdmission?.available ?? null,
      alphaTotalCandidates: finiteNumberOrNull(alphaAdmission?.totalCandidates),
      alphaAcceptedCount: finiteNumberOrNull(alphaAdmission?.acceptedCount),
      alphaAdmissionGatePassedCount: finiteNumberOrNull(alphaAdmission?.admissionGatePassedCount),
      alphaAdmissionGateFailedCount: alphaAdmissionFailureCount,
      runtimeAcceptedAdmissionGateFailedCount: runtimeAcceptedAdmissionFailures,
      rollingSharpeUniverseAvailable: rollingUniverse?.available ?? null,
      rollingSharpeUniverseRequired: rollingUniverse?.required ?? false,
      rollingSharpeLongCount: longCount,
      rollingSharpeShortCount: shortCount,
      rollingSharpeSelectedCount: selectedUniverseCount,
      rollingSharpeScoreCount: rollingUniverse?.selection?.scores?.length ?? null,
      stableCorrelationClusteringAvailable: stableClustering?.available ?? null,
      stableCorrelationClusterCount: stableClusterCount,
      regimeIdentityAvailable: regimeIdentity?.available ?? null,
      regimeIdentityEffectiveSampleSize: finiteNumberOrNull(regimeIdentity?.effectiveSampleSize),
      sessionAwareSlippageAvailable: sessionSlippage?.available ?? null,
      sessionAwareSlippageTradeCount: finiteNumberOrNull(sessionSlippage?.tradeCount),
    },
  }
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function evaluateRampUpCheck(rampUp: RampUpEvaluation | undefined): ReleaseGateCheck {
  if (!rampUp) {
    return {
      name: 'ramp_up',
      status: 'skipped',
      summary: 'Ramp-up status not provided; skipping gate.',
      metrics: {},
    }
  }

  if (rampUp.decision === 'rollback') {
    return {
      name: 'ramp_up',
      status: 'fail',
      summary: 'Ramp-up gate requested rollback.',
      metrics: {
        decision: rampUp.decision,
        reason: rampUp.reason,
        currentStage: rampUp.currentStage.allocationPct,
        targetStage: rampUp.targetStage.allocationPct,
        drawdownBreached: rampUp.drawdownBreached,
      },
    }
  }

  if (rampUp.decision === 'stay' && rampUp.reason === 'insufficient_sample') {
    return {
      name: 'ramp_up',
      status: 'warn',
      summary: 'Ramp-up sample is still insufficient.',
      metrics: {
        decision: rampUp.decision,
        reason: rampUp.reason,
        currentStage: rampUp.currentStage.allocationPct,
        targetStage: rampUp.targetStage.allocationPct,
        drawdownBreached: rampUp.drawdownBreached,
      },
    }
  }

  return {
    name: 'ramp_up',
    status: 'pass',
    summary: 'Ramp-up gate passed.',
    metrics: {
      decision: rampUp.decision,
      reason: rampUp.reason,
      currentStage: rampUp.currentStage.allocationPct,
      targetStage: rampUp.targetStage.allocationPct,
      drawdownBreached: rampUp.drawdownBreached,
    },
  }
}

function evaluateRegimeShiftCheck(
  regimeShift: RegimeShiftGateInput | undefined,
): ReleaseGateCheck {
  if (!regimeShift) {
    return {
      name: 'regime_shift',
      status: 'skipped',
      summary: 'Regime-shift gate not provided; skipping gate.',
      metrics: {},
    }
  }

  if (regimeShift.triggered && regimeShift.severity === 'high') {
    return {
      name: 'regime_shift',
      status: 'fail',
      summary: 'Regime-shift gate blocked live trading.',
      metrics: {
        triggered: regimeShift.triggered,
        severity: regimeShift.severity,
        reason: regimeShift.reason ?? null,
      },
    }
  }

  if (regimeShift.triggered && regimeShift.severity === 'watch') {
    return {
      name: 'regime_shift',
      status: 'warn',
      summary: 'Regime-shift gate raised a watch warning.',
      metrics: {
        triggered: regimeShift.triggered,
        severity: regimeShift.severity,
        reason: regimeShift.reason ?? null,
      },
    }
  }

  return {
    name: 'regime_shift',
    status: 'pass',
    summary: 'Regime-shift gate passed.',
    metrics: {
      triggered: regimeShift.triggered,
      severity: regimeShift.severity,
      reason: regimeShift.reason ?? null,
    },
  }
}
