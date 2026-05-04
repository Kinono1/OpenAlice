export interface ValidationDecisionSummary {
  schemaVersion: 'validation_decision_summary.v1'
  generatedAt: string | null
  input: {
    family: string | null
    symbol: string | null
    strategy: string | null
  }
  promotion: {
    allowPaperTrading: boolean
    allowLiveTrading: boolean
    failedChecks: string[]
    warningChecks: string[]
    recommendationAction: string | null
  }
  oosPerformance: {
    sharpe: number | null
    sortino: number | null
    totalReturnPct: number | null
    netExpectancyPct: number | null
    maxDrawdownPct: number | null
    tradeCount: number | null
  }
  statistics: {
    passed: boolean | null
    pbo: number | null
    dsrProbability: number | null
    fdrQ: number | null
    candidateTrialCount: number | null
    trialLedgerStatus: string | null
    trialLedgerBlocks: string[]
    trialLedgerRawM: number | null
    trialLedgerEffectiveM: number | null
    trialLedgerRawMComplete: boolean | null
    trialLedgerIncludesFailedTrials: boolean | null
    trialLedgerFdrMethodPrimary: string | null
  }
  sampleReliability: {
    status: 'ok' | 'low_sample' | 'unknown'
    independentBets: number | null
    minimumIndependentBets: number | null
    reason: string | null
  }
  performanceDisplayPolicy: {
    showPnlCurve: boolean
    showEquityCurve: boolean
    severity: 'normal' | 'redacted_low_sample'
    reason: string | null
  }
  turnover: {
    available: boolean
    turnoverPctOfInitialCapital: number | null
    averageTurnoverPctPerTrade: number | null
    totalTurnoverUsd: number | null
  }
  costAdjustedReturn: {
    available: boolean
    totalReturnPct: number | null
    grossExpectancyPct: number | null
    netExpectancyPct: number | null
    costDragPctOfInitialCapital: number | null
  }
  wfo: {
    overallPassed: boolean | null
    windowCount: number
    passedWindows: number
    failedWindows: number
    passRate: number | null
  }
  riskSimulation: {
    gatePassed: boolean | null
    profitProbability: number | null
    riskOfRuin: number | null
    expectedFinalReturnPct: number | null
  }
  factorIcByHorizon: IcEvidenceSummary
  strategySignalIcByHorizon: IcEvidenceSummary
  regimeSplitPerformance: EvidenceAvailabilitySummary
  longShortSideAsymmetry: {
    available: boolean
    longTradeCount: number | null
    shortTradeCount: number | null
    longNetExpectancyPct: number | null
    shortNetExpectancyPct: number | null
  }
  paperExecutionSlippage: {
    available: boolean
    gateStatus: string | null
    reason: string | null
    substitute: string | null
  }
  strategyPlanEvidence: {
    crossAssetRegimeConsistency: {
      available: boolean
      consistent: boolean | null
      reason: string | null
    }
    alphaFactorAdmission: {
      available: boolean
      totalCandidates: number | null
      acceptedCount: number | null
      runtimeAcceptedAdmissionGateFailedCount: number | null
      reason: string | null
    }
    sessionAwareSlippageEstimate: {
      available: boolean
      tradeCount: number | null
      averageEstimatedSlippageBps: number | null
      maxEstimatedSlippageBps: number | null
      dominantSession: string | null
      reason: string | null
    }
  }
  evidenceVerdict: {
    standsUpForPaperPromotion: boolean
    missingCriticalEvidence: string[]
    blockers: string[]
  }
}

export interface EvidenceAvailabilitySummary {
  available: boolean
  reason: string | null
}

export interface IcEvidenceSummary extends EvidenceAvailabilitySummary {
  horizons: Array<{
    horizonBars: number | null
    observations: number | null
    activeSignalObservations: number | null
    pearsonIc: number | null
    meanForwardReturnWhenLongPct: number | null
    meanForwardReturnWhenShortPct: number | null
  }>
}

type UnknownRecord = Record<string, unknown>

export function buildValidationDecisionSummary(report: unknown): ValidationDecisionSummary {
  const root = asRecord(report)
  const selectedMetrics = getRecord(root, ['selectedMetrics'])
  const releaseGate = getRecord(root, ['releaseGate'])
  const validationEvidence = getRecord(root, ['validationEvidence'])
  const strategyPlanEvidence = getRecord(validationEvidence, ['strategyPlanEvidence'])
  const wfo = getRecord(root, ['wfo'])
  const significance = getRecord(root, ['significance'])
  const riskSimulation = getRecord(root, ['riskSimulation'])
  const sampleReliability = summarizeSampleReliability(significance, releaseGate)
  const performanceDisplayPolicy = buildPerformanceDisplayPolicy(sampleReliability)
  const significanceCheck = findReleaseGateCheck(releaseGate, 'significance')
  const significanceCheckMetrics = getRecord(significanceCheck, ['metrics'])
  const trialLedger = getRecord(significance, ['trialLedger'])

  const failedChecks = getStringArray(releaseGate, ['failedChecks'])
  const warningChecks = getStringArray(releaseGate, ['warningChecks'])
  const factorIcByHorizon = summarizeIcEvidence(
    validationEvidence.factorIcByHorizon,
    'Factor-level IC evidence is absent from this validation report.',
  )
  const strategySignalIcByHorizon = summarizeIcEvidence(
    validationEvidence.strategySignalIcByHorizon,
    'Strategy signal IC evidence is absent from this validation report.',
  )
  const paperExecutionSlippage = getRecord(validationEvidence, ['paperExecutionSlippage'])
  const crossAsset = getRecord(strategyPlanEvidence, ['crossAssetRegimeConsistency'])
  const alphaAdmission = getRecord(strategyPlanEvidence, ['alphaFactorAdmission'])
  const sessionAwareSlippage = getRecord(strategyPlanEvidence, ['sessionAwareSlippageEstimate'])

  const missingCriticalEvidence = [
    factorIcByHorizon.available ? null : 'factor_ic_by_horizon_unavailable',
    strategySignalIcByHorizon.available ? null : 'strategy_signal_ic_by_horizon_unavailable',
    getBoolean(paperExecutionSlippage, ['available']) === true
      ? null
      : 'paper_execution_slippage_telemetry_unavailable',
    getBoolean(alphaAdmission, ['available']) === true
      ? null
      : 'alpha_factor_admission_unavailable',
  ].filter((item): item is string => item !== null)
  const allowPaperTrading = getBoolean(releaseGate, ['allowPaperTrading']) === true

  return {
    schemaVersion: 'validation_decision_summary.v1',
    generatedAt: getString(root, ['generatedAt']),
    input: {
      family: getString(root, ['input', 'family']),
      symbol:
        getString(root, ['input', 'symbol']) ??
        getString(root, ['input', 'syntheticSymbol']) ??
        getString(root, ['input', 'leaderSymbol']),
      strategy: getString(root, ['input', 'strategy']),
    },
    promotion: {
      allowPaperTrading,
      allowLiveTrading: getBoolean(releaseGate, ['allowLiveTrading']) === true,
      failedChecks,
      warningChecks,
      recommendationAction: getString(root, ['recommendedCandidate', 'recommendation', 'action']),
    },
    oosPerformance: {
      sharpe: getNumber(selectedMetrics, ['sharpe']),
      sortino: getNumber(selectedMetrics, ['sortino']),
      totalReturnPct: getNumber(selectedMetrics, ['totalReturnPct']),
      netExpectancyPct: getNumber(selectedMetrics, ['netExpectancyPct']),
      maxDrawdownPct: getNumber(selectedMetrics, ['maxDrawdownPct']),
      tradeCount: getNumber(selectedMetrics, ['tradeCount']),
    },
    statistics: {
      passed: getBoolean(significance, ['passed']),
      pbo: getNumber(significance, ['pbo']) ?? getNumber(significance, ['pboResult', 'pbo']),
      dsrProbability:
        getNumber(significance, ['dsrProbability']) ??
        getNumber(significance, ['dsrResult', 'dsrProbability']),
      fdrQ: getNumber(significance, ['fdrQ']),
      candidateTrialCount: getNumber(significance, ['candidateTrialCount']),
      trialLedgerStatus: getString(significanceCheckMetrics, ['trialLedgerStatus']),
      trialLedgerBlocks: parseCsvStringList(getString(significanceCheckMetrics, ['trialLedgerBlocks'])),
      trialLedgerRawM:
        getNumber(significanceCheckMetrics, ['trialLedgerRawM']) ??
        getNumber(trialLedger, ['rawM']),
      trialLedgerEffectiveM:
        getNumber(significanceCheckMetrics, ['trialLedgerEffectiveM']) ??
        getNumber(trialLedger, ['effectiveM']),
      trialLedgerRawMComplete:
        getBoolean(significanceCheckMetrics, ['trialLedgerRawMComplete']) ??
        getBoolean(trialLedger, ['rawMComplete']),
      trialLedgerIncludesFailedTrials:
        getBoolean(significanceCheckMetrics, ['trialLedgerIncludesFailedTrials']) ??
        getBoolean(trialLedger, ['includesFailedTrials']),
      trialLedgerFdrMethodPrimary:
        getString(significanceCheckMetrics, ['trialLedgerFdrMethodPrimary']) ??
        getString(trialLedger, ['fdrMethodPrimary']),
    },
    sampleReliability,
    performanceDisplayPolicy,
    turnover: {
      available: getBoolean(validationEvidence, ['turnover', 'available']) === true,
      turnoverPctOfInitialCapital: getNumber(validationEvidence, ['turnover', 'turnoverPctOfInitialCapital']),
      averageTurnoverPctPerTrade: getNumber(validationEvidence, ['turnover', 'averageTurnoverPctPerTrade']),
      totalTurnoverUsd: getNumber(validationEvidence, ['turnover', 'totalTurnoverUsd']),
    },
    costAdjustedReturn: {
      available: getBoolean(validationEvidence, ['costAdjustedReturn', 'available']) === true,
      totalReturnPct: getNumber(validationEvidence, ['costAdjustedReturn', 'totalReturnPct']),
      grossExpectancyPct: getNumber(validationEvidence, ['costAdjustedReturn', 'grossExpectancyPct']),
      netExpectancyPct: getNumber(validationEvidence, ['costAdjustedReturn', 'netExpectancyPct']),
      costDragPctOfInitialCapital: getNumber(
        validationEvidence,
        ['costAdjustedReturn', 'costDragPctOfInitialCapital'],
      ),
    },
    wfo: summarizeWfo(wfo),
    riskSimulation: {
      gatePassed: getBoolean(riskSimulation, ['gatePassed']),
      profitProbability: getNumber(riskSimulation, ['profitProbability']),
      riskOfRuin: getNumber(riskSimulation, ['riskOfRuin']),
      expectedFinalReturnPct: getNumber(riskSimulation, ['expectedFinalReturnPct']),
    },
    factorIcByHorizon,
    strategySignalIcByHorizon,
    regimeSplitPerformance: summarizeAvailability(
      validationEvidence.regimeSplitPerformance,
      'Regime split performance evidence is absent from this validation report.',
    ),
    longShortSideAsymmetry: summarizeSideAsymmetry(validationEvidence.longShortSideAsymmetry),
    paperExecutionSlippage: {
      available: getBoolean(paperExecutionSlippage, ['available']) === true,
      gateStatus: getString(paperExecutionSlippage, ['gateStatus']),
      reason: getString(paperExecutionSlippage, ['reason']),
      substitute: getString(paperExecutionSlippage, ['substitute']),
    },
    strategyPlanEvidence: {
      crossAssetRegimeConsistency: {
        available: getBoolean(crossAsset, ['available']) === true,
        consistent: getBoolean(crossAsset, ['result', 'consistent']),
        reason: getString(crossAsset, ['reason']),
      },
      alphaFactorAdmission: {
        available: getBoolean(alphaAdmission, ['available']) === true,
        totalCandidates: getNumber(alphaAdmission, ['totalCandidates']),
        acceptedCount: getNumber(alphaAdmission, ['acceptedCount']),
        runtimeAcceptedAdmissionGateFailedCount: getNumber(
          alphaAdmission,
          ['runtimeAcceptedAdmissionGateFailedCount'],
        ),
        reason: getString(alphaAdmission, ['reason']),
      },
      sessionAwareSlippageEstimate: {
        available: getBoolean(sessionAwareSlippage, ['available']) === true,
        tradeCount: getNumber(sessionAwareSlippage, ['tradeCount']),
        averageEstimatedSlippageBps: getNumber(sessionAwareSlippage, ['averageEstimatedSlippageBps']),
        maxEstimatedSlippageBps: getNumber(sessionAwareSlippage, ['maxEstimatedSlippageBps']),
        dominantSession: getString(sessionAwareSlippage, ['dominantSession']),
        reason: getString(sessionAwareSlippage, ['reason']),
      },
    },
    evidenceVerdict: {
      standsUpForPaperPromotion: allowPaperTrading && missingCriticalEvidence.length === 0,
      missingCriticalEvidence,
      blockers: failedChecks,
    },
  }
}

function summarizeSampleReliability(
  significance: UnknownRecord,
  releaseGate: UnknownRecord,
): ValidationDecisionSummary['sampleReliability'] {
  const significanceCheck = findReleaseGateCheck(releaseGate, 'significance')
  const metrics = getRecord(significanceCheck, ['metrics'])
  const dsrResult = getRecord(significance, ['dsrResult'])
  const diagnosticQuality =
    getString(dsrResult, ['diagnosticQuality']) ??
    getString(metrics, ['dsrDiagnosticQuality'])
  const dsrStatus = getString(metrics, ['dsrStatus'])
  const independentBets =
    getNumber(dsrResult, ['independentBets']) ??
    getNumber(metrics, ['dsrIndependentBets'])
  const minimumIndependentBets =
    getNumber(dsrResult, ['minimumIndependentBets']) ??
    getNumber(metrics, ['dsrMinimumIndependentBets'])
  const blockedReason =
    getString(dsrResult, ['blockedReason']) ??
    getString(metrics, ['dsrBlockedReason'])

  if (diagnosticQuality === 'low_sample' || dsrStatus === 'low_sample') {
    return {
      status: 'low_sample',
      independentBets,
      minimumIndependentBets,
      reason: blockedReason ?? 'independent_bets_below_minimum',
    }
  }

  if (diagnosticQuality === 'ok' || dsrStatus === 'pass' || dsrStatus === 'fail') {
    return {
      status: 'ok',
      independentBets,
      minimumIndependentBets,
      reason: null,
    }
  }

  return {
    status: 'unknown',
    independentBets,
    minimumIndependentBets,
    reason: 'dsr_sample_reliability_unavailable',
  }
}

function buildPerformanceDisplayPolicy(
  sampleReliability: ValidationDecisionSummary['sampleReliability'],
): ValidationDecisionSummary['performanceDisplayPolicy'] {
  if (sampleReliability.status === 'low_sample') {
    return {
      showPnlCurve: false,
      showEquityCurve: false,
      severity: 'redacted_low_sample',
      reason: sampleReliability.reason ?? 'independent_bets_below_minimum',
    }
  }

  return {
    showPnlCurve: true,
    showEquityCurve: true,
    severity: 'normal',
    reason: null,
  }
}

function findReleaseGateCheck(releaseGate: UnknownRecord, name: string): UnknownRecord {
  return getRecordArray(releaseGate, ['checks']).find((check) => getString(check, ['name']) === name) ?? {}
}

function parseCsvStringList(value: string | null): string[] {
  return value
    ? value.split(',').map(item => item.trim()).filter(Boolean)
    : []
}

function summarizeWfo(wfo: UnknownRecord): ValidationDecisionSummary['wfo'] {
  const windows = getRecordArray(wfo, ['windows'])
  const passedWindows = windows.filter((window) => getBoolean(window, ['gatePassed']) === true).length
  const failedWindows = getNumber(wfo, ['failedWindows']) ?? Math.max(0, windows.length - passedWindows)
  return {
    overallPassed: getBoolean(wfo, ['overallPassed']),
    windowCount: windows.length,
    passedWindows,
    failedWindows,
    passRate: windows.length > 0 ? passedWindows / windows.length : null,
  }
}

function summarizeIcEvidence(input: unknown, fallbackReason: string): IcEvidenceSummary {
  if (Array.isArray(input)) {
    return {
      available: input.length > 0,
      reason: input.length > 0 ? null : fallbackReason,
      horizons: input.map(normalizeIcHorizon),
    }
  }
  const record = asRecord(input)
  const horizons = getRecordArray(record, ['horizons']).map(normalizeIcHorizon)
  return {
    available: getBoolean(record, ['available']) ?? horizons.length > 0,
    reason: getString(record, ['reason']) ?? (horizons.length > 0 ? null : fallbackReason),
    horizons,
  }
}

function normalizeIcHorizon(input: unknown): IcEvidenceSummary['horizons'][number] {
  const record = asRecord(input)
  return {
    horizonBars: getNumber(record, ['horizonBars']),
    observations: getNumber(record, ['observations']),
    activeSignalObservations: getNumber(record, ['activeSignalObservations']),
    pearsonIc: getNumber(record, ['pearsonIc']),
    meanForwardReturnWhenLongPct: getNumber(record, ['meanForwardReturnWhenLongPct']),
    meanForwardReturnWhenShortPct: getNumber(record, ['meanForwardReturnWhenShortPct']),
  }
}

function summarizeAvailability(input: unknown, fallbackReason: string): EvidenceAvailabilitySummary {
  const record = asRecord(input)
  const explicitAvailable = getBoolean(record, ['available'])
  if (explicitAvailable !== null) {
    return {
      available: explicitAvailable,
      reason: getString(record, ['reason']),
    }
  }
  const hasContent = Object.keys(record).length > 0
  return {
    available: hasContent,
    reason: hasContent ? null : fallbackReason,
  }
}

function summarizeSideAsymmetry(input: unknown): ValidationDecisionSummary['longShortSideAsymmetry'] {
  const record = asRecord(input)
  const long = getRecord(record, ['long'])
  const short = getRecord(record, ['short'])
  return {
    available: Object.keys(long).length > 0 || Object.keys(short).length > 0,
    longTradeCount: getNumber(long, ['tradeCount']),
    shortTradeCount: getNumber(short, ['tradeCount']),
    longNetExpectancyPct: getNumber(long, ['netExpectancyPct']),
    shortNetExpectancyPct: getNumber(short, ['netExpectancyPct']),
  }
}

function getRecord(root: UnknownRecord, path: string[]): UnknownRecord {
  const value = getValue(root, path)
  return asRecord(value)
}

function getRecordArray(root: UnknownRecord, path: string[]): UnknownRecord[] {
  const value = getValue(root, path)
  return Array.isArray(value) ? value.map(asRecord) : []
}

function getStringArray(root: UnknownRecord, path: string[]): string[] {
  const value = getValue(root, path)
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function getString(root: UnknownRecord, path: string[]): string | null {
  const value = getValue(root, path)
  return typeof value === 'string' ? value : null
}

function getNumber(root: UnknownRecord, path: string[]): number | null {
  const value = getValue(root, path)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getBoolean(root: UnknownRecord, path: string[]): boolean | null {
  const value = getValue(root, path)
  return typeof value === 'boolean' ? value : null
}

function getValue(root: UnknownRecord, path: string[]): unknown {
  let current: unknown = root
  for (const key of path) {
    const record = asRecord(current)
    current = record[key]
  }
  return current
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}
