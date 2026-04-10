export type TradingAgentsStage = 'A' | 'B' | 'C' | 'D'
export type TradingAgentsStageStatus = 'pass' | 'fail' | 'inconclusive'

export interface TradingAgentsStageCriterion {
  id: string
  description: string
  status: TradingAgentsStageStatus
  evidence: string
}

export interface TradingAgentsStageAssessment {
  stage: TradingAgentsStage
  label: string
  status: TradingAgentsStageStatus
  criteria: TradingAgentsStageCriterion[]
}

export interface TradingAgentsStageSnapshot {
  currentStage: TradingAgentsStage
  currentStageStatus: TradingAgentsStageStatus
  stages: TradingAgentsStageAssessment[]
  recommendation: string
}

export interface DerivedValidationQuestions {
  donorLeadsNonControls: boolean | null
  controlsAreStrongerThanDonor: boolean | null
  donorSelfPassesThresholds: boolean | null
}

export interface DerivedDonorAggregateMetrics {
  meanPbo: number
  meanDsrProbability: number
  fdrQ: number
  maxFailedWindowRatio: number | null
  meanSharpe: number | null
}

export function buildTradingAgentsStageSnapshot(params: {
  validationRuns: Record<string, unknown> | null
  routeMatrix: Record<string, unknown> | null
  wfoSensitivity: Record<string, unknown> | null
}): TradingAgentsStageSnapshot {
  const stages = [
    assessStageA(params.validationRuns),
    assessStageB(params.validationRuns, params.routeMatrix),
    assessStageC(params.validationRuns, params.routeMatrix, params.wfoSensitivity),
    assessStageD(params.validationRuns),
  ]
  const current = stages.find((stage) => stage.status !== 'pass') ?? stages[stages.length - 1]
  return {
    currentStage: current.stage,
    currentStageStatus: current.status,
    stages,
    recommendation: buildRecommendation(current.stage, current.status),
  }
}

export function deriveValidationQuestions(
  validationRuns: Record<string, unknown>,
): DerivedValidationQuestions {
  const diagnostics = asRecord(validationRuns.diagnostics)
  const questions = asRecord(diagnostics?.questions)
  const directDonorLeads = asBoolean(questions?.donorLeadsNonControls)
  const directControlsStronger = asBoolean(questions?.controlsAreStrongerThanDonor)
  const directDonorSelfPasses = asBoolean(questions?.donorSelfPassesThresholds)
  const donorMetrics = deriveDonorAggregateMetrics(validationRuns)
  const symbols = asArray(validationRuns.symbols)
  const leaders = symbols
    .map((symbol) => asRecord(symbol))
    .filter((symbol): symbol is Record<string, unknown> => Boolean(symbol))
    .map((symbol) => asRecord(symbol.leader))
    .filter((leader): leader is Record<string, unknown> => Boolean(leader))
  const leaderDonor =
    leaders.length > 0 ? leaders.every((leader) => leader.role === 'donor') : null

  return {
    donorLeadsNonControls: directDonorLeads ?? leaderDonor,
    controlsAreStrongerThanDonor:
      directControlsStronger ?? (leaderDonor === null ? null : !leaderDonor),
    donorSelfPassesThresholds:
      directDonorSelfPasses ??
      (donorMetrics
        ? donorMetrics.meanPbo <= 0.2 &&
          donorMetrics.meanDsrProbability >= 0.5 &&
          donorMetrics.fdrQ <= 0.1
        : null),
  }
}

export function deriveDonorAggregateMetrics(
  validationRuns: Record<string, unknown>,
): DerivedDonorAggregateMetrics | null {
  const portfolioDiagnostics = asRecord(asRecord(validationRuns.diagnostics)?.donorOnlyAggregateMetrics)
  const directMeanPbo = asNumber(portfolioDiagnostics?.meanPbo)
  const directMeanDsr = asNumber(portfolioDiagnostics?.meanDsrProbability)
  const directFdr = asNumber(portfolioDiagnostics?.fdrQ)
  const directMaxFailed = asNumber(portfolioDiagnostics?.maxFailedWindowRatio)
  const directSharpe = asNumber(portfolioDiagnostics?.meanSharpe)
  if (directMeanPbo !== null && directMeanDsr !== null && directFdr !== null) {
    return {
      meanPbo: directMeanPbo,
      meanDsrProbability: directMeanDsr,
      fdrQ: directFdr,
      maxFailedWindowRatio: directMaxFailed,
      meanSharpe: directSharpe,
    }
  }

  const donors = extractDonorCandidates(validationRuns)
  if (donors.length < 1) {
    return null
  }
  const pboValues = donors.map((donor) => firstNumber(donor, ['candidateLevelSignificance', 'pbo']) ?? firstNumber(donor, ['significance', 'pbo'])).filter(isFiniteNumber)
  const dsrValues = donors.map((donor) => firstNumber(donor, ['candidateLevelSignificance', 'dsrProbability']) ?? firstNumber(donor, ['significance', 'dsrProbability'])).filter(isFiniteNumber)
  const fdrValues = donors.map((donor) => firstNumber(donor, ['candidateLevelFdr', 'qValue']) ?? firstNumber(donor, ['fdr', 'qValue'])).filter(isFiniteNumber)
  const sharpeValues = donors.map((donor) => firstNumber(donor, ['backtestMetrics', 'sharpe'])).filter(isFiniteNumber)
  const failedWindowRatios = donors.map(extractWfoFailedWindowRatio).filter(isFiniteNumber)

  if (pboValues.length < 1 || dsrValues.length < 1 || fdrValues.length < 1) {
    return null
  }
  return {
    meanPbo: average(pboValues),
    meanDsrProbability: average(dsrValues),
    fdrQ: average(fdrValues),
    maxFailedWindowRatio: failedWindowRatios.length > 0 ? Math.max(...failedWindowRatios) : null,
    meanSharpe: sharpeValues.length > 0 ? average(sharpeValues) : null,
  }
}

function assessStageA(validationRuns: Record<string, unknown> | null): TradingAgentsStageAssessment {
  const criteria: TradingAgentsStageCriterion[] = []
  if (!validationRuns) {
    criteria.push({
      id: 'A0_data_available',
      description: 'Validation runs data available',
      status: 'inconclusive',
      evidence: 'No validation-runs artifact was provided.',
    })
    return { stage: 'A', label: 'Relative Merit', status: 'inconclusive', criteria }
  }

  const questions = deriveValidationQuestions(validationRuns)
  const donorMetrics = deriveDonorAggregateMetrics(validationRuns)
  criteria.push({
    id: 'A1_donor_beats_baseline',
    description: 'Donor beats baseline / leads non-control set',
    status: statusFromNullableBoolean(questions.donorLeadsNonControls),
    evidence:
      questions.donorLeadsNonControls === null
        ? 'No donor leadership signal was available.'
        : questions.donorLeadsNonControls
          ? 'Donor leadership signal is positive.'
          : 'Donor does not lead the non-control set.',
  })
  criteria.push({
    id: 'A2_donor_spa_fdr_passes',
    description: 'Donor FDR q-value is <= 0.10',
    status:
      donorMetrics?.fdrQ === null || donorMetrics?.fdrQ === undefined
        ? 'inconclusive'
        : donorMetrics.fdrQ <= 0.1
          ? 'pass'
          : 'fail',
    evidence:
      donorMetrics?.fdrQ === null || donorMetrics?.fdrQ === undefined
        ? 'No donor FDR aggregate was available.'
        : `donor fdrQ=${donorMetrics.fdrQ.toFixed(4)}`,
  })
  criteria.push({
    id: 'A3_donor_positive_sharpe',
    description: 'Donor retains positive Sharpe',
    status:
      donorMetrics?.meanSharpe === null || donorMetrics?.meanSharpe === undefined
        ? 'inconclusive'
        : donorMetrics.meanSharpe > 0
          ? 'pass'
          : 'fail',
    evidence:
      donorMetrics?.meanSharpe === null || donorMetrics?.meanSharpe === undefined
        ? 'No donor Sharpe aggregate was available.'
        : `donor meanSharpe=${donorMetrics.meanSharpe.toFixed(4)}`,
  })
  criteria.push({
    id: 'A4_donor_self_passes_thresholds',
    description: 'Donor self-passes PBO/DSR/FDR thresholds',
    status: statusFromNullableBoolean(questions.donorSelfPassesThresholds),
    evidence:
      questions.donorSelfPassesThresholds === null
        ? 'Threshold self-pass signal unavailable.'
        : questions.donorSelfPassesThresholds
          ? 'Donor passes self thresholds.'
          : 'Donor fails self thresholds.',
  })
  return { stage: 'A', label: 'Relative Merit', status: stageStatus(criteria), criteria }
}

function assessStageB(
  validationRuns: Record<string, unknown> | null,
  routeMatrix: Record<string, unknown> | null,
): TradingAgentsStageAssessment {
  const criteria: TradingAgentsStageCriterion[] = []
  const championSet = asArray(asRecord(validationRuns?.portfolio)?.championSet)
  const donorChampion = championSet.some((entry) => asRecord(entry)?.role === 'donor')
  const questions = validationRuns ? deriveValidationQuestions(validationRuns) : null
  const rankedProfiles = asArray(routeMatrix?.rankedProfiles)
  const routeHasGo =
    rankedProfiles.some((profile) => asRecord(profile)?.result === 'GO') ||
    asRecord(routeMatrix?.summary)?.goCount !== undefined
  criteria.push({
    id: 'B1_donor_is_champion',
    description: 'Donor appears in the champion set',
    status: championSet.length < 1 ? 'inconclusive' : donorChampion ? 'pass' : 'fail',
    evidence:
      championSet.length < 1
        ? 'Champion set unavailable.'
        : donorChampion
          ? 'Champion set contains a donor lane.'
          : 'Champion set excludes donor lanes.',
  })
  criteria.push({
    id: 'B2_controls_not_stronger',
    description: 'Controls are not stronger than donor',
    status:
      questions === null
        ? 'inconclusive'
        : questions.controlsAreStrongerThanDonor === null
          ? 'inconclusive'
          : questions.controlsAreStrongerThanDonor
            ? 'fail'
            : 'pass',
    evidence:
      questions?.controlsAreStrongerThanDonor === null || questions === null
        ? 'Control-vs-donor comparison unavailable.'
        : questions.controlsAreStrongerThanDonor
          ? 'Control set is stronger than donor.'
          : 'Donor is not dominated by control set.',
  })
  criteria.push({
    id: 'B3_route_matrix_has_go',
    description: 'Route matrix exposes at least one GO profile',
    status: routeMatrix === null ? 'inconclusive' : routeHasGo ? 'pass' : 'fail',
    evidence:
      routeMatrix === null
        ? 'Route matrix unavailable.'
        : routeHasGo
          ? 'Route matrix contains at least one GO profile.'
          : 'Route matrix contains no GO profiles.',
  })
  return { stage: 'B', label: 'Champion Viability', status: stageStatus(criteria), criteria }
}

function assessStageC(
  validationRuns: Record<string, unknown> | null,
  _routeMatrix: Record<string, unknown> | null,
  wfoSensitivity: Record<string, unknown> | null,
): TradingAgentsStageAssessment {
  const criteria: TradingAgentsStageCriterion[] = []
  const donorMetrics = validationRuns ? deriveDonorAggregateMetrics(validationRuns) : null
  const donorProfiles = extractDonorProfiles(wfoSensitivity)
  const stableProfileExists = donorProfiles.some((profile) =>
    (profile.failedWindowRatio ?? 1) <= 0.5 &&
    (profile.averageDegradation ?? 1) <= 0.4 &&
    (profile.medianTradesPerWindow ?? 0) >= 4,
  )
  const wfoImproving = donorProfiles.length >= 2
    ? compareNullableAscending(
        donorProfiles[0].failedWindowRatio,
        donorProfiles[donorProfiles.length - 1].failedWindowRatio,
      )
    : null
  criteria.push({
    id: 'C1_donor_dsr_feasible',
    description: 'Donor DSR probability remains feasible',
    status:
      donorMetrics === null
        ? 'inconclusive'
        : donorMetrics.meanDsrProbability >= 0.5
          ? 'pass'
          : 'fail',
    evidence:
      donorMetrics === null
        ? 'Donor aggregate metrics unavailable.'
        : `meanDsrProbability=${donorMetrics.meanDsrProbability.toFixed(4)}`,
  })
  criteria.push({
    id: 'C2_pbo_declining',
    description: 'Donor PBO is below the failing threshold',
    status:
      donorMetrics === null
        ? 'inconclusive'
        : donorMetrics.meanPbo <= 0.2
          ? 'pass'
          : 'fail',
    evidence:
      donorMetrics === null
        ? 'Donor aggregate metrics unavailable.'
        : `meanPbo=${donorMetrics.meanPbo.toFixed(4)}`,
  })
  criteria.push({
    id: 'C3_wfo_improving',
    description: 'WFO failure density improves under longer OOS profiles',
    status: statusFromNullableBoolean(wfoImproving),
    evidence:
      wfoImproving === null
        ? 'Not enough WFO sensitivity donor profiles to infer improvement.'
        : wfoImproving
          ? 'Longer OOS profile improves failed-window ratio.'
          : 'Longer OOS profile does not improve failed-window ratio.',
  })
  criteria.push({
    id: 'C4_wfo_stable_profile_exists',
    description: 'At least one stable donor profile exists in WFO sensitivity',
    status:
      donorProfiles.length < 1 ? 'inconclusive' : stableProfileExists ? 'pass' : 'fail',
    evidence:
      donorProfiles.length < 1
        ? 'No donor sensitivity profiles available.'
        : stableProfileExists
          ? 'At least one donor sensitivity profile is within acceptable stability bounds.'
          : 'No donor sensitivity profile is within acceptable stability bounds.',
  })
  return { stage: 'C', label: 'Sensitivity Robustness', status: stageStatus(criteria), criteria }
}

function assessStageD(validationRuns: Record<string, unknown> | null): TradingAgentsStageAssessment {
  const criteria: TradingAgentsStageCriterion[] = []
  const portfolio = asRecord(validationRuns?.portfolio)
  const releaseGate = asRecord(portfolio?.releaseGate)
  const result = asString(validationRuns?.result)
  const donorMetrics = validationRuns ? deriveDonorAggregateMetrics(validationRuns) : null
  criteria.push({
    id: 'D1_formal_verdict_go',
    description: 'Formal verdict is GO',
    status: result === null ? 'inconclusive' : result === 'GO' ? 'pass' : 'fail',
    evidence: result === null ? 'Validation result unavailable.' : `result=${result}`,
  })
  criteria.push({
    id: 'D2_release_gate_paper',
    description: 'Portfolio release gate allows paper trading',
    status:
      typeof releaseGate?.allowPaperTrading !== 'boolean'
        ? 'inconclusive'
        : releaseGate.allowPaperTrading
          ? 'pass'
          : 'fail',
    evidence:
      typeof releaseGate?.allowPaperTrading !== 'boolean'
        ? 'Release gate paper flag unavailable.'
        : `allowPaperTrading=${String(releaseGate.allowPaperTrading)}`,
  })
  criteria.push({
    id: 'D3_aggregate_metrics_pass',
    description: 'Aggregate donor metrics pass core thresholds',
    status:
      donorMetrics === null
        ? 'inconclusive'
        : donorMetrics.meanPbo <= 0.2 &&
            donorMetrics.meanDsrProbability >= 0.5 &&
            donorMetrics.fdrQ <= 0.1
          ? 'pass'
          : 'fail',
    evidence:
      donorMetrics === null
        ? 'Donor aggregate metrics unavailable.'
        : `meanPbo=${donorMetrics.meanPbo.toFixed(4)}, meanDsrProbability=${donorMetrics.meanDsrProbability.toFixed(4)}, fdrQ=${donorMetrics.fdrQ.toFixed(4)}`,
  })
  return { stage: 'D', label: 'Admission Gate', status: stageStatus(criteria), criteria }
}

function buildRecommendation(stage: TradingAgentsStage, status: TradingAgentsStageStatus): string {
  if (stage === 'A' && status === 'pass') {
    return 'Relative merit clears the first gate, but the donor still requires downstream governance checks.'
  }
  if (stage === 'A' && status === 'fail') {
    return 'The donor fails at Stage A; treat the lane as non-promotable until terminal governance is materialized.'
  }
  if (stage === 'B' && status === 'fail') {
    return 'The donor does not survive champion/control comparison; keep the lane blocked from promotion.'
  }
  if (stage === 'C' && status === 'fail') {
    return 'The donor remains unstable under sensitivity analysis; allow only diagnostic follow-up.'
  }
  if (stage === 'D' && status === 'fail') {
    return 'The donor does not clear the formal admission gate; do not promote beyond paper governance artifacts.'
  }
  return 'The donor remains inconclusive; keep the lane frozen and collect stronger evidence before any promotion.'
}

function stageStatus(criteria: TradingAgentsStageCriterion[]): TradingAgentsStageStatus {
  if (criteria.some((criterion) => criterion.status === 'fail')) {
    return 'fail'
  }
  if (criteria.every((criterion) => criterion.status === 'pass')) {
    return 'pass'
  }
  return 'inconclusive'
}

function extractDonorCandidates(validationRuns: Record<string, unknown>): Record<string, unknown>[] {
  const symbols = asArray(validationRuns.symbols)
  return symbols.flatMap((symbol) =>
    asArray(asRecord(symbol)?.candidates)
      .map((candidate) => asRecord(candidate))
      .filter((candidate): candidate is Record<string, unknown> => candidate?.role === 'donor'),
  )
}

interface DonorProfile {
  profile: string
  failedWindowRatio: number | null
  averageDegradation: number | null
  medianTradesPerWindow: number | null
}

function extractDonorProfiles(wfoSensitivity: Record<string, unknown> | null): DonorProfile[] {
  return asArray(wfoSensitivity?.profiles).flatMap((profile) => {
    const profileName = asString(asRecord(profile)?.profile) ?? 'unknown'
    return asArray(asRecord(profile)?.candidates)
      .map((candidate) => asRecord(candidate))
      .filter((candidate): candidate is Record<string, unknown> => candidate?.role === 'donor')
      .map((candidate) => ({
        profile: profileName,
        failedWindowRatio: asNumber(candidate.failedWindowRatio),
        averageDegradation: asNumber(candidate.averageDegradation),
        medianTradesPerWindow: asNumber(candidate.medianTradesPerWindow),
      }))
  })
}

function compareNullableAscending(first: number | null, last: number | null): boolean | null {
  if (first === null || last === null) {
    return null
  }
  return last < first
}

function statusFromNullableBoolean(value: boolean | null): TradingAgentsStageStatus {
  return value === null ? 'inconclusive' : value ? 'pass' : 'fail'
}

function firstNumber(record: Record<string, unknown>, path: string[]): number | null {
  let current: unknown = record
  for (const part of path) {
    current = asRecord(current)?.[part]
  }
  return asNumber(current)
}

function extractWfoFailedWindowRatio(record: Record<string, unknown>): number | null {
  const checks = asArray(asRecord(record.releaseGate)?.checks)
  const wfoCheck = checks
    .map((check) => asRecord(check))
    .find((check) => check?.name === 'wfo')
  return asNumber(asRecord(wfoCheck?.metrics)?.failedWindowRatio)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function isFiniteNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value)
}
