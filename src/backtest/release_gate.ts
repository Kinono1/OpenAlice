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

export interface ReleaseGateCheck {
  name:
    | 'wfo'
    | 'significance'
    | 'risk_simulation'
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
  dsrMin: number
}

export interface ReleaseGateInput {
  wfo?: Pick<WfoResultLike, 'overallPassed' | 'failedWindows' | 'windows'>
  significance?: SignificanceGateResult
  riskSimulation?: RiskSimulationResult
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
  pboMax: 0.2,
  dsrMin: 0,
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
  checks.push(evaluateExecutionCheck(input.executionQuality))
  checks.push(evaluateRampUpCheck(input.rampUp))
  checks.push(evaluateRegimeShiftCheck(input.regimeShift))

  const failedChecks = checks.filter((check) => check.status === 'fail').map((check) => check.name)
  const warningChecks = checks.filter((check) => check.status === 'warn').map((check) => check.name)

  const paperBlockingNames: ReleaseGateCheck['name'][] = [
    'wfo',
    'significance',
    'risk_simulation',
  ]
  const liveBlockingNames: ReleaseGateCheck['name'][] = [
    'wfo',
    'significance',
    'risk_simulation',
    'execution_quality',
    'ramp_up',
    'regime_shift',
  ]

  const allowPaperTrading = !checks.some(
    (check) => paperBlockingNames.includes(check.name) && check.status === 'fail',
  )
  const allowLiveTrading = !checks.some(
    (check) => liveBlockingNames.includes(check.name) && check.status === 'fail',
  )

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
      status: 'skipped',
      summary: 'Significance stats not provided; skipping gate.',
      metrics: {},
    }
  }

  const pbo = significance.pboResult.pbo
  const dsr = significance.dsrResult.dsrValue
  const failed = pbo >= thresholds.pboMax || dsr <= thresholds.dsrMin

  return {
    name: 'significance',
    status: failed ? 'fail' : 'pass',
    summary: failed ? 'Statistical significance gate failed.' : 'Statistical significance gate passed.',
    metrics: {
      pbo,
      pboMax: thresholds.pboMax,
      dsrValue: dsr,
      dsrMin: thresholds.dsrMin,
      candidateCount: significance.pboResult.logits.length,
    },
  }
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
