import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type RequirementStatus = 'pass' | 'blocked'
type IncubationPlanStatus = 'active_incubation' | 'no_incubation_candidates'
type ResearchLineHealth = 'incubate' | 'kill_condition_met' | 'no_viable_line'

interface CliArgs {
  researchRoot: string
  candidateSummaryPath: string
  systemStatusPath: string
  okxAuthPath: string
  feeSnapshotStatusPath: string
  liquidityProspectiveStatusPath: string
  rankIcProspectiveStatusPath: string
  outputPath: string | null
  maxCandidates: number
  minSignalPeriods: number
  minPeriods: number
  minCommonPeriods: number
  minWfoWindowCount: number
  json: boolean
}

interface SourceFile {
  path: string
  value: unknown
}

export interface IncubationRequirement {
  code: string
  label: string
  status: RequirementStatus
  current: string | number | boolean | null
  required: string | number | boolean
  blocker: string | null
}

export interface ResearchIncubationCandidate {
  rank: number
  incubationId: string
  sourcePath: string
  candidateId: string
  factor: string | null
  lookbackHours: number | null
  secondaryLookbackHours: number | null
  forwardHours: number | null
  mtfWeight: number | null
  route: string | null
  priorityScore: number
  status: 'incubating_diagnostic_only'
  selectionReason: string
  metrics: {
    observations: number | null
    forwardHours: number | null
    periods: number | null
    signalPeriods: number | null
    commonPeriods: number | null
    meanIc: number | null
    icIr: number | null
    grossLongShortSpreadPct: number | null
    netAfterRouteCostPct: number | null
    grossToPairCostRatio: number | null
    pairRoundTripCostPct: number | null
    positiveAfterCost: boolean
    routeCostValidationStatus: string | null
    wfoStatus: string | null
    wfoWindowCount: number | null
    wfoPassedWindows: number | null
    wfoFailedWindows: number | null
    wfoFailedWindowRatio: number | null
    wfoFailWindowRatioThreshold: number | null
    wfoDirectionStable: boolean | null
  }
  feeSnapshot: {
    source: string | null
    verifiedByRuntime: boolean | null
    stale: boolean | null
    sourceFetchedAt: string | null
    expiresAt: string | null
  }
  blockers: string[]
  promotionRequirements: IncubationRequirement[]
  nextCheckCommands: string[]
  killCriteria: string[]
}

export interface ResearchLineDecision {
  verdict: 'continue_incubation_no_execution' | 'no_viable_line'
  lineHealth: ResearchLineHealth
  killTriggers: string[]
  randomSearchAllowed: false
  promotionAllowed: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  primaryCandidateId: string | null
  primaryRoute: string | null
  hardBlockers: string[]
  rationale: string[]
  pauseConditions: string[]
  continueConditions: string[]
  nextReview: {
    afterLabelDueTime: string | null
    afterOkxAuthStatus: 'auth_available'
    requiredClosedOutcomes: number
    requiredClosedWindows: number
  }
  sourceArtifacts: {
    systemStatusPath: string
    okxAuthPath: string
    feeSnapshotStatusPath: string
    liquidityProspectiveStatusPath: string
    rankIcProspectiveStatusPath: string
  }
  evidenceSnapshot: {
    effectiveActionability: string | null
    okxAuthStatus: string | null
    runtimeFeeStatus: string | null
    runtimeFeeRows: number | null
    liquidityOpenEvents: number | null
    liquidityClosedEvents: number | null
    rankIcOpenEvents: number | null
    rankIcClosedEvents: number | null
    earliestNextLabelDueTime: string | null
  }
}

export interface ResearchIncubationPlanReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionAllowed: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  planStatus: IncubationPlanStatus
  researchRoot: string
  candidateSummaryPath: string
  sourceFilesScanned: number
  routeCostDiagnosticsFound: number
  incubationCandidatesFound: number
  executionPolicy: {
    paperOrdersAllowed: false
    liveOrdersAllowed: false
    policyMutationAllowed: false
    reason: string
  }
  thresholds: {
    minSignalPeriods: number
    minPeriods: number
    minCommonPeriods: number
    minWfoWindowCount: number
    requiredWfoStatus: 'pass'
    requireRuntimeVerifiedFees: true
    requirePositiveRouteCostAdjustedNet: true
    requireCompleteTrialLedger: true
    requireByFdr: true
    requirePitAudit: true
  }
  candidateSummary: {
    present: boolean
    candidateRowsFound: number | null
    focusRecommendations: string[]
  }
  lineDecision: ResearchLineDecision
  candidates: ResearchIncubationCandidate[]
  rejectedDiagnostics: Array<{
    sourcePath: string
    candidateId: string
    reason: string
    netAfterRouteCostPct: number | null
    routeCostValidationStatus: string | null
    killTriggers?: string[]
  }>
  globalNextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_RESEARCH_ROOT = 'data/research'
const DEFAULT_CANDIDATE_SUMMARY_PATH = 'data/research/candidate_ranking.latest.json'
const DEFAULT_SYSTEM_STATUS_PATH = 'data/runtime/system_status_reason_chain.latest.json'
const DEFAULT_OKX_AUTH_PATH = 'data/runtime/okx_private_auth_diagnosis.latest.json'
const DEFAULT_FEE_SNAPSHOT_STATUS_PATH = 'data/runtime/fee_snapshot_refresh.latest.json'
const DEFAULT_LIQUIDITY_PROSPECTIVE_STATUS_PATH =
  'data/research/liquidity_conditioned_prospective_evidence_status.live_accumulated.latest.json'
const DEFAULT_RANK_IC_PROSPECTIVE_STATUS_PATH =
  'data/research/rank_ic_prospective_evidence_status.live_accumulated_fwd72_median_filter.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/research_incubation_plan.latest.json'
const DEFAULT_MAX_CANDIDATES = 5
const DEFAULT_MIN_SIGNAL_PERIODS = 30
const DEFAULT_MIN_PERIODS = 30
const DEFAULT_MIN_COMMON_PERIODS = 1_000
const DEFAULT_MIN_WFO_WINDOW_COUNT = 3

async function main(): Promise<void> {
  const args = parseResearchIncubationPlanArgs(process.argv.slice(2))
  const report = await runResearchIncubationPlan(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseResearchIncubationPlanArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    researchRoot: raw.get('researchRoot') ?? raw.get('root') ?? DEFAULT_RESEARCH_ROOT,
    candidateSummaryPath: raw.get('candidateSummaryPath') ??
      raw.get('candidateSummary') ??
      DEFAULT_CANDIDATE_SUMMARY_PATH,
    systemStatusPath: raw.get('systemStatusPath') ?? DEFAULT_SYSTEM_STATUS_PATH,
    okxAuthPath: raw.get('okxAuthPath') ?? DEFAULT_OKX_AUTH_PATH,
    feeSnapshotStatusPath: raw.get('feeSnapshotStatusPath') ?? DEFAULT_FEE_SNAPSHOT_STATUS_PATH,
    liquidityProspectiveStatusPath: raw.get('liquidityProspectiveStatusPath') ??
      DEFAULT_LIQUIDITY_PROSPECTIVE_STATUS_PATH,
    rankIcProspectiveStatusPath: raw.get('rankIcProspectiveStatusPath') ??
      DEFAULT_RANK_IC_PROSPECTIVE_STATUS_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxCandidates: parsePositiveInteger(raw.get('maxCandidates'), DEFAULT_MAX_CANDIDATES, 'maxCandidates'),
    minSignalPeriods: parsePositiveInteger(
      raw.get('minSignalPeriods'),
      DEFAULT_MIN_SIGNAL_PERIODS,
      'minSignalPeriods',
    ),
    minPeriods: parsePositiveInteger(raw.get('minPeriods'), DEFAULT_MIN_PERIODS, 'minPeriods'),
    minCommonPeriods: parsePositiveInteger(
      raw.get('minCommonPeriods'),
      DEFAULT_MIN_COMMON_PERIODS,
      'minCommonPeriods',
    ),
    minWfoWindowCount: parsePositiveInteger(
      raw.get('minWfoWindowCount'),
      DEFAULT_MIN_WFO_WINDOW_COUNT,
      'minWfoWindowCount',
    ),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runResearchIncubationPlan(
  args: CliArgs,
): Promise<ResearchIncubationPlanReport> {
  const startedAt = new Date()
  const researchRoot = resolve(args.researchRoot)
  const candidateSummaryPath = resolve(args.candidateSummaryPath)
  const statusPaths = {
    systemStatusPath: resolve(args.systemStatusPath),
    okxAuthPath: resolve(args.okxAuthPath),
    feeSnapshotStatusPath: resolve(args.feeSnapshotStatusPath),
    liquidityProspectiveStatusPath: resolve(args.liquidityProspectiveStatusPath),
    rankIcProspectiveStatusPath: resolve(args.rankIcProspectiveStatusPath),
  }
  const files = await loadResearchArtifacts(researchRoot)
  const [
    candidateSummary,
    systemStatus,
    okxAuth,
    feeSnapshotStatus,
    liquidityProspectiveStatus,
    rankIcProspectiveStatus,
  ] = await Promise.all([
    readJsonIfExists(candidateSummaryPath),
    readJsonIfExists(statusPaths.systemStatusPath),
    readJsonIfExists(statusPaths.okxAuthPath),
    readJsonIfExists(statusPaths.feeSnapshotStatusPath),
    readJsonIfExists(statusPaths.liquidityProspectiveStatusPath),
    readJsonIfExists(statusPaths.rankIcProspectiveStatusPath),
  ])
  const report = buildResearchIncubationPlanReport({
    files,
    researchRoot,
    candidateSummaryPath,
    statusPaths,
    candidateSummary,
    systemStatus,
    okxAuth,
    feeSnapshotStatus,
    liquidityProspectiveStatus,
    rankIcProspectiveStatus,
    maxCandidates: args.maxCandidates,
    thresholds: {
      minSignalPeriods: args.minSignalPeriods,
      minPeriods: args.minPeriods,
      minCommonPeriods: args.minCommonPeriods,
      minWfoWindowCount: args.minWfoWindowCount,
    },
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'research_incubation_plan',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.planStatus === 'active_incubation' ? 'warn' : 'fail',
      recordsIn: report.routeCostDiagnosticsFound,
      recordsOut: report.incubationCandidatesFound,
      errorClass: report.planStatus === 'active_incubation'
        ? 'incubation_candidates_require_more_evidence'
        : 'no_incubation_candidates',
    })
  }

  return report
}

export function buildResearchIncubationPlanReport(input: {
  files: SourceFile[]
  researchRoot: string
  candidateSummaryPath: string
  statusPaths?: Partial<ResearchLineDecision['sourceArtifacts']>
  candidateSummary?: unknown
  systemStatus?: unknown
  okxAuth?: unknown
  feeSnapshotStatus?: unknown
  liquidityProspectiveStatus?: unknown
  rankIcProspectiveStatus?: unknown
  generatedAt?: string
  maxCandidates?: number
  thresholds?: Partial<Pick<
    ResearchIncubationPlanReport['thresholds'],
    'minSignalPeriods' | 'minPeriods' | 'minCommonPeriods' | 'minWfoWindowCount'
  >>
}): ResearchIncubationPlanReport {
  const thresholds = {
    minSignalPeriods: input.thresholds?.minSignalPeriods ?? DEFAULT_MIN_SIGNAL_PERIODS,
    minPeriods: input.thresholds?.minPeriods ?? DEFAULT_MIN_PERIODS,
    minCommonPeriods: input.thresholds?.minCommonPeriods ?? DEFAULT_MIN_COMMON_PERIODS,
    minWfoWindowCount: input.thresholds?.minWfoWindowCount ?? DEFAULT_MIN_WFO_WINDOW_COUNT,
    requiredWfoStatus: 'pass' as const,
    requireRuntimeVerifiedFees: true as const,
    requirePositiveRouteCostAdjustedNet: true as const,
    requireCompleteTrialLedger: true as const,
    requireByFdr: true as const,
    requirePitAudit: true as const,
  }
  const filesByPath = new Map(input.files.map(file => [resolve(file.path), file.value]))
  const routeCostDiagnostics = input.files
    .map(file => extractRouteCostDiagnostic(file, thresholds, filesByPath))
    .filter((value): value is ResearchIncubationCandidate | RejectedDiagnostic => value != null)
  const incubationCandidates = routeCostDiagnostics
    .filter((value): value is ResearchIncubationCandidate => 'priorityScore' in value)
    .sort(compareCandidates)
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    }))
    .slice(0, input.maxCandidates ?? DEFAULT_MAX_CANDIDATES)
  const rejectedDiagnostics = routeCostDiagnostics
    .filter((value): value is RejectedDiagnostic => !('priorityScore' in value))
    .sort(compareRejectedDiagnostics)
    .slice(0, 20)
  const summaryRoot = asRecord(input.candidateSummary)
  const lineDecision = buildResearchLineDecision({
    candidates: incubationCandidates,
    rejectedDiagnostics,
    systemStatus: input.systemStatus,
    okxAuth: input.okxAuth,
    feeSnapshotStatus: input.feeSnapshotStatus,
    liquidityProspectiveStatus: input.liquidityProspectiveStatus,
    rankIcProspectiveStatus: input.rankIcProspectiveStatus,
    statusPaths: {
      systemStatusPath: resolve(input.statusPaths?.systemStatusPath ?? DEFAULT_SYSTEM_STATUS_PATH),
      okxAuthPath: resolve(input.statusPaths?.okxAuthPath ?? DEFAULT_OKX_AUTH_PATH),
      feeSnapshotStatusPath: resolve(input.statusPaths?.feeSnapshotStatusPath ?? DEFAULT_FEE_SNAPSHOT_STATUS_PATH),
      liquidityProspectiveStatusPath: resolve(
        input.statusPaths?.liquidityProspectiveStatusPath ?? DEFAULT_LIQUIDITY_PROSPECTIVE_STATUS_PATH,
      ),
      rankIcProspectiveStatusPath: resolve(
        input.statusPaths?.rankIcProspectiveStatusPath ?? DEFAULT_RANK_IC_PROSPECTIVE_STATUS_PATH,
      ),
    },
  })

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    planStatus: incubationCandidates.length > 0 ? 'active_incubation' : 'no_incubation_candidates',
    researchRoot: resolve(input.researchRoot),
    candidateSummaryPath: resolve(input.candidateSummaryPath),
    sourceFilesScanned: input.files.length,
    routeCostDiagnosticsFound: routeCostDiagnostics.length,
    incubationCandidatesFound: incubationCandidates.length,
    executionPolicy: {
      paperOrdersAllowed: false,
      liveOrdersAllowed: false,
      policyMutationAllowed: false,
      reason: 'Incubation artifacts are for evidence collection only; promotion gates and execution gates remain authoritative.',
    },
    thresholds,
    candidateSummary: {
      present: summaryRoot != null,
      candidateRowsFound: readNumber(summaryRoot?.candidateRowsFound),
      focusRecommendations: readStringArray(summaryRoot?.focusRecommendations).slice(0, 10),
    },
    lineDecision,
    candidates: incubationCandidates,
    rejectedDiagnostics,
    globalNextActions: buildGlobalNextActions(incubationCandidates),
    safetyNotes: [
      'This artifact cannot authorize paper or live orders.',
      'A positive diagnostic netAfterRouteCostPct is only a money-smell until sample size, WFO, runtime fees, trial ledger, BY FDR, and PIT requirements pass.',
      'Manual fee snapshots are acceptable for prioritizing research, not for promotion.',
      'Do not write best_config.json from this artifact; use the release gate and optimizer hard gates only.',
    ],
  }
}

type RejectedDiagnostic = {
  sourcePath: string
  candidateId: string
  reason: string
  netAfterRouteCostPct: number | null
  routeCostValidationStatus: string | null
  killTriggers?: string[]
}

function extractRouteCostDiagnostic(
  file: SourceFile,
  thresholds: ResearchIncubationPlanReport['thresholds'],
  filesByPath: Map<string, unknown>,
): ResearchIncubationCandidate | RejectedDiagnostic | null {
  const root = asRecord(file.value)
  if (!root || root.researchOnly !== true || root.promotionEligible !== false) return null
  const candidate = asRecord(root.candidate)
  const route = asRecord(root.bestDiagnosticRoute)
  if (!candidate || !route) return null
  if (readString(root.routeCostValidationStatus) == null) return null

  const candidateId = readString(candidate.candidateId) ?? 'rank_ic_route_cost_candidate'
  const netAfterRouteCostPct = readNumber(route.netAfterRouteCostPct)
  const positiveAfterCost = readBool(route.positiveAfterCost) === true ||
    (netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) > 0
  const routeCostValidationStatus = readString(root.routeCostValidationStatus)
  const blockers = uniqueStrings(readStringArray(root.blockers))
  const feeSnapshot = asRecord(root.feeSnapshot)

  if (blockers.includes('non_hourly_rank_ic_cadence_research_only')) {
    return {
      sourcePath: file.path,
      candidateId,
      reason: 'non_hourly_rank_ic_cadence_research_only',
      netAfterRouteCostPct,
      routeCostValidationStatus,
    }
  }

  if (!file.path.replaceAll('\\', '/').includes('/rank_ic_route_cost_validation.live_accumulated')) {
    return {
      sourcePath: file.path,
      candidateId,
      reason: 'not_live_accumulated_route_cost_diagnostic',
      netAfterRouteCostPct,
      routeCostValidationStatus,
    }
  }

  if (!positiveAfterCost) {
    return {
      sourcePath: file.path,
      candidateId,
      reason: 'route_cost_adjusted_net_not_positive',
      netAfterRouteCostPct,
      routeCostValidationStatus,
    }
  }

  if (
    readString(feeSnapshot?.source) === 'manual_override' ||
    readBool(feeSnapshot?.verifiedByRuntime) !== true ||
    readBool(feeSnapshot?.stale) === true
  ) {
    return {
      sourcePath: file.path,
      candidateId,
      reason: 'fee_snapshot_not_runtime_verified',
      netAfterRouteCostPct,
      routeCostValidationStatus,
    }
  }

  const rankIcReportPath = readString(root.rankIcReportPath)
  const rankIcReport = rankIcReportPath ? asRecord(filesByPath.get(resolve(rankIcReportPath))) : null
  const wfo = asRecord(rankIcReport?.wfo) ??
    asRecord(asRecord(root.rankIcReport)?.wfo) ??
    asRecord(root.wfo)
  const wfoWindowCount = readNumber(wfo?.windowCount) ??
    inferWindowCountFromBlockers(blockers)
  const metrics = {
    observations: readNumber(candidate.observations),
    forwardHours: readNumber(candidate.forwardHours),
    periods: readNumber(candidate.periods),
    signalPeriods: readNumber(candidate.signalPeriods),
    commonPeriods: readNumber(candidate.commonPeriods),
    meanIc: readNumber(candidate.meanIc),
    icIr: readNumber(candidate.icIr),
    grossLongShortSpreadPct: readNumber(route.grossLongShortSpreadPct),
    netAfterRouteCostPct,
    grossToPairCostRatio: readNumber(route.grossToPairCostRatio),
    pairRoundTripCostPct: readNumber(route.pairRoundTripCostPct),
    positiveAfterCost,
    routeCostValidationStatus,
    wfoStatus: readString(candidate.wfoStatus),
    wfoWindowCount,
    wfoPassedWindows: readNumber(wfo?.passedWindows),
    wfoFailedWindows: readNumber(wfo?.failedWindows),
    wfoFailedWindowRatio: readNumber(wfo?.failedWindowRatio),
    wfoFailWindowRatioThreshold: readNumber(wfo?.failWindowRatioThreshold),
    wfoDirectionStable: readBool(wfo?.directionStable),
  }
  const requirements = buildRequirements({
    metrics,
    feeSnapshot,
    blockers,
    thresholds,
  })

  const incubationCandidate: ResearchIncubationCandidate = {
    rank: 0,
    incubationId: sha256Hex(`${file.path}|${candidateId}`).slice(0, 16),
    sourcePath: file.path,
    candidateId,
    factor: readString(candidate.factor),
    lookbackHours: readNumber(candidate.lookbackHours),
    secondaryLookbackHours: readNumber(candidate.secondaryLookbackHours),
    forwardHours: readNumber(candidate.forwardHours),
    mtfWeight: readNumber(candidate.mtfWeight),
    route: readString(route.route),
    priorityScore: scoreIncubationCandidate(file.path, metrics, requirements),
    status: 'incubating_diagnostic_only',
    selectionReason: 'positive_route_cost_adjusted_money_smell_needs_live_only_incubation',
    metrics,
    feeSnapshot: {
      source: readString(feeSnapshot?.source),
      verifiedByRuntime: readBool(feeSnapshot?.verifiedByRuntime),
      stale: readBool(feeSnapshot?.stale),
      sourceFetchedAt: readString(feeSnapshot?.sourceFetchedAt),
      expiresAt: readString(feeSnapshot?.expiresAt),
    },
    blockers,
    promotionRequirements: requirements,
    nextCheckCommands: buildNextCheckCommands(metrics.forwardHours),
    killCriteria: buildKillCriteria(metrics),
  }
  const killTriggers = buildLineKillTriggers(incubationCandidate)
  if (killTriggers.length > 0) {
    return {
      sourcePath: file.path,
      candidateId,
      reason: 'wfo_kill_condition_met',
      netAfterRouteCostPct,
      routeCostValidationStatus,
      killTriggers,
    }
  }

  return incubationCandidate
}

function buildRequirements(input: {
  metrics: ResearchIncubationCandidate['metrics']
  feeSnapshot: Record<string, unknown> | null
  blockers: string[]
  thresholds: ResearchIncubationPlanReport['thresholds']
}): IncubationRequirement[] {
  const feeSource = readString(input.feeSnapshot?.source)
  const feeVerified = readBool(input.feeSnapshot?.verifiedByRuntime)
  const feeStale = readBool(input.feeSnapshot?.stale)
  const completeTrialLedger = !input.blockers.some(blocker =>
    blocker.includes('trial_ledger') || blocker.includes('fdr'),
  )
  const pitReady = !input.blockers.some(blocker => blocker.includes('pit'))

  return [
    numericRequirement(
      'live_only_signal_periods',
      'Collect enough live-only signal periods',
      input.metrics.signalPeriods,
      input.thresholds.minSignalPeriods,
      '>=',
      `rank_ic_signal_periods_low:${input.metrics.signalPeriods ?? 0}<${input.thresholds.minSignalPeriods}`,
    ),
    numericRequirement(
      'live_only_periods',
      'Collect enough live-only periods',
      input.metrics.periods,
      input.thresholds.minPeriods,
      '>=',
      `rank_ic_periods_low:${input.metrics.periods ?? 0}<${input.thresholds.minPeriods}`,
    ),
    numericRequirement(
      'common_periods',
      'Collect enough common cross-sectional periods',
      input.metrics.commonPeriods,
      input.thresholds.minCommonPeriods,
      '>=',
      `rank_ic_common_periods_low:${input.metrics.commonPeriods ?? 0}<${input.thresholds.minCommonPeriods}`,
    ),
    {
      code: 'wfo_status',
      label: 'Pass internal RankIC WFO',
      status: input.metrics.wfoStatus === input.thresholds.requiredWfoStatus ? 'pass' : 'blocked',
      current: input.metrics.wfoStatus,
      required: input.thresholds.requiredWfoStatus,
      blocker: input.metrics.wfoStatus === input.thresholds.requiredWfoStatus
        ? null
        : `rank_ic_wfo_status:${input.metrics.wfoStatus ?? 'missing'}`,
    },
    numericRequirement(
      'wfo_window_count',
      'Keep at least the minimum WFO windows',
      input.metrics.wfoWindowCount,
      input.thresholds.minWfoWindowCount,
      '>=',
      `rank_ic_wfo_windows_low:${input.metrics.wfoWindowCount ?? 0}<${input.thresholds.minWfoWindowCount}`,
    ),
    {
      code: 'runtime_fee_snapshot',
      label: 'Use runtime-verified non-stale fees',
      status: feeVerified === true && feeSource !== 'manual_override' && feeStale !== true ? 'pass' : 'blocked',
      current: `${feeSource ?? 'missing'}|verified=${feeVerified ?? false}|stale=${feeStale ?? 'missing'}`,
      required: 'runtime_verified_non_manual_non_stale',
      blocker: feeVerified === true && feeSource !== 'manual_override' && feeStale !== true
        ? null
        : 'fee_snapshot_not_runtime_verified',
    },
    {
      code: 'route_cost_adjusted_net',
      label: 'Remain positive after route cost',
      status: input.metrics.positiveAfterCost && (input.metrics.netAfterRouteCostPct ?? 0) > 0 ? 'pass' : 'blocked',
      current: input.metrics.netAfterRouteCostPct,
      required: '>0',
      blocker: input.metrics.positiveAfterCost && (input.metrics.netAfterRouteCostPct ?? 0) > 0
        ? null
        : 'route_cost_net_after_cost_non_positive',
    },
    {
      code: 'trial_ledger_complete',
      label: 'Complete trial ledger before promotion',
      status: completeTrialLedger ? 'pass' : 'blocked',
      current: completeTrialLedger,
      required: true,
      blocker: completeTrialLedger ? null : 'not_trial_ledger_fdr_validated',
    },
    {
      code: 'by_fdr_ready',
      label: 'BY FDR promotion evidence ready',
      status: completeTrialLedger ? 'pass' : 'blocked',
      current: completeTrialLedger,
      required: true,
      blocker: completeTrialLedger ? null : 'not_trial_ledger_fdr_validated',
    },
    {
      code: 'pit_audit_ready',
      label: 'PIT audit ready',
      status: pitReady ? 'pass' : 'blocked',
      current: pitReady,
      required: true,
      blocker: pitReady ? null : 'pit_audit_not_ready',
    },
    {
      code: 'paper_execution_evidence',
      label: 'Promotion-grade paper evidence exists',
      status: input.blockers.includes('not_paper_execution_evidence') ? 'blocked' : 'pass',
      current: !input.blockers.includes('not_paper_execution_evidence'),
      required: true,
      blocker: input.blockers.includes('not_paper_execution_evidence')
        ? 'not_paper_execution_evidence'
        : null,
    },
  ]
}

function numericRequirement(
  code: string,
  label: string,
  current: number | null,
  required: number,
  operator: '>=',
  blocker: string,
): IncubationRequirement {
  const passed = current != null && operator === '>=' && current >= required
  return {
    code,
    label,
    status: passed ? 'pass' : 'blocked',
    current,
    required,
    blocker: passed ? null : blocker,
  }
}

function scoreIncubationCandidate(
  path: string,
  metrics: ResearchIncubationCandidate['metrics'],
  requirements: IncubationRequirement[],
): number {
  let score = 0
  if (path.includes('live_accumulated')) score += 20
  score += clamp(metrics.netAfterRouteCostPct ?? 0, -1, 20) * 4
  score += clamp(metrics.grossToPairCostRatio ?? 0, 0, 50) * 0.5
  score += clamp(metrics.signalPeriods ?? 0, 0, 100) * 0.2
  score += clamp(metrics.commonPeriods ?? 0, 0, 2_000) / 200
  score += requirements.filter(requirement => requirement.status === 'pass').length * 2
  return round(score, 6)
}

function compareCandidates(left: ResearchIncubationCandidate, right: ResearchIncubationCandidate): number {
  return right.priorityScore - left.priorityScore ||
    Number(right.metrics.positiveAfterCost) - Number(left.metrics.positiveAfterCost) ||
    (right.metrics.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) -
      (left.metrics.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) ||
    (right.metrics.signalPeriods ?? 0) - (left.metrics.signalPeriods ?? 0) ||
    (right.metrics.commonPeriods ?? 0) - (left.metrics.commonPeriods ?? 0) ||
    left.candidateId.localeCompare(right.candidateId)
}

function compareRejectedDiagnostics(left: RejectedDiagnostic, right: RejectedDiagnostic): number {
  const priorityDelta = rejectedReasonPriority(right) - rejectedReasonPriority(left)
  if (priorityDelta !== 0) return priorityDelta
  return (right.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) -
    (left.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) ||
    left.candidateId.localeCompare(right.candidateId)
}

function rejectedReasonPriority(diagnostic: RejectedDiagnostic): number {
  if (diagnostic.reason === 'wfo_kill_condition_met') return 40
  if (diagnostic.reason === 'fee_snapshot_not_runtime_verified') return 30
  if (diagnostic.reason === 'route_cost_adjusted_net_not_positive') return 20
  if (diagnostic.reason === 'non_hourly_rank_ic_cadence_research_only') return 10
  return 0
}

function buildNextCheckCommands(forwardHours: number | null): string[] {
  const suffix = forwardHours != null ? `fwd${forwardHours}` : 'fwd72'
  return [
    `corepack pnpm research:cross-sectional:rank-ic:live-${suffix}`,
    `corepack pnpm research:cross-sectional:route-cost:live-${suffix}`,
    'corepack pnpm fees:runtime:snapshot',
    'corepack pnpm research:candidates:summarize',
    'corepack pnpm research:incubation-plan',
  ]
}

function buildKillCriteria(metrics: ResearchIncubationCandidate['metrics']): string[] {
  const forwardHours = metrics.forwardHours ?? 72
  const ratioText = metrics.wfoFailedWindowRatio != null && metrics.wfoFailWindowRatioThreshold != null
    ? `${formatMaybe(metrics.wfoFailedWindowRatio)}>${formatMaybe(metrics.wfoFailWindowRatioThreshold)}`
    : 'above 0.3'
  return [
    `Retire if netAfterRouteCostPct is <= 0 after reaching ${DEFAULT_MIN_SIGNAL_PERIODS} live-only signal periods.`,
    `Retire if WFO failedWindowRatio remains ${ratioText} after enough windows exist.`,
    'Retire if runtime-verified fees turn the best route negative.',
    `Retire if the effect only appears in a single ${forwardHours}h horizon and does not survive adjacent horizons.`,
  ]
}

function buildLineKillTriggers(primary: ResearchIncubationCandidate | null): string[] {
  if (!primary) return []
  const triggers: string[] = []
  const metrics = primary.metrics
  const enoughWfoWindows = (metrics.wfoWindowCount ?? 0) >= DEFAULT_MIN_WFO_WINDOW_COUNT
  if (
    enoughWfoWindows &&
    metrics.wfoFailedWindowRatio != null &&
    metrics.wfoFailWindowRatioThreshold != null &&
    metrics.wfoFailedWindowRatio > metrics.wfoFailWindowRatioThreshold
  ) {
    triggers.push(
      `primary:wfo_failed_window_ratio:${formatMaybe(metrics.wfoFailedWindowRatio)}>${formatMaybe(metrics.wfoFailWindowRatioThreshold)}`,
    )
  }
  if (enoughWfoWindows && metrics.wfoDirectionStable === false) {
    triggers.push('primary:wfo_direction_not_stable')
  }
  if (
    (metrics.signalPeriods ?? 0) >= DEFAULT_MIN_SIGNAL_PERIODS &&
    (metrics.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) <= 0
  ) {
    triggers.push(`primary:net_after_route_cost_non_positive:${formatMaybe(metrics.netAfterRouteCostPct)}`)
  }
  return uniqueStrings(triggers)
}

function buildGlobalNextActions(candidates: ResearchIncubationCandidate[]): string[] {
  const focus = candidates[0]
  if (!focus) {
    return [
      'No positive route-cost-adjusted diagnostic is ready for incubation; keep collecting live-only data and rerun candidate summary.',
      'Keep paper/live disabled until promotion gates pass.',
    ]
  }
  return [
    `Primary incubation target: ${focus.candidateId} on ${focus.route ?? 'unknown_route'} with netAfterRouteCostPct=${formatMaybe(focus.metrics.netAfterRouteCostPct)}.`,
    'Continue live-only data accumulation without placing paper or live orders from this artifact.',
    focus.feeSnapshot.verifiedByRuntime === true
      ? 'Keep OKX private auth and runtime fee snapshot fresh; rerun route-cost validation before each promotion review.'
      : 'Fix OKX/runtime fee snapshot credentials, then rerun route-cost validation.',
    'After minimum live-only periods are reached, rerun WFO, complete the trial ledger, compute BY FDR, and only then revisit best_config promotion.',
  ]
}

function buildResearchLineDecision(input: {
  candidates: ResearchIncubationCandidate[]
  rejectedDiagnostics?: RejectedDiagnostic[]
  systemStatus?: unknown
  okxAuth?: unknown
  feeSnapshotStatus?: unknown
  liquidityProspectiveStatus?: unknown
  rankIcProspectiveStatus?: unknown
  statusPaths: ResearchLineDecision['sourceArtifacts']
}): ResearchLineDecision {
  const primary = input.candidates[0] ?? null
  const system = asRecord(input.systemStatus)
  const auth = asRecord(input.okxAuth)
  const fee = asRecord(input.feeSnapshotStatus)
  const liquidity = asRecord(input.liquidityProspectiveStatus)
  const rankIc = asRecord(input.rankIcProspectiveStatus)
  const liquidityCounts = asRecord(liquidity?.counts)
  const rankIcCounts = asRecord(rankIc?.counts)
  const liquidityThresholds = asRecord(liquidity?.thresholds)
  const rankIcThresholds = asRecord(rankIc?.thresholds)
  const feeRows = Array.isArray(fee?.perSymbolFees) ? fee.perSymbolFees.length : readNumber(fee?.perSymbolFeesCount)
  const liquidityLatestDue = readString(asRecord(liquidity?.latestOpen)?.labelDueTime)
  const rankIcLatestDue = readString(asRecord(rankIc?.latestOpen)?.labelDueTime)
  const earliestNextLabelDueTime = earliestIsoString([liquidityLatestDue, rankIcLatestDue])
  const requiredClosedOutcomes = Math.max(
    readNumber(liquidityThresholds?.minClosedOutcomes) ?? 100,
    readNumber(rankIcThresholds?.minClosedOutcomes) ?? 100,
  )
  const requiredClosedWindows = Math.max(
    readNumber(liquidityThresholds?.minNonOverlappingWindows) ?? 3,
    readNumber(rankIcThresholds?.minNonOverlappingWindows) ?? 3,
  )
  const primaryBlockedRequirements = primary?.promotionRequirements
    .filter(requirement => requirement.status === 'blocked')
    .map(requirement => requirement.code) ?? []
  const rejectedReasons = uniqueStrings(
    (input.rejectedDiagnostics ?? []).map(diagnostic => diagnostic.reason),
  )
  const killTriggers = buildLineKillTriggers(primary)
  const authStatus = readString(auth?.status)
  const feeStatus = readString(fee?.status)
  const effectiveActionability = readString(system?.effectiveActionability)
  const hardBlockers = uniqueStrings([
    ...(primary
      ? primaryBlockedRequirements.map(code => `primary:${code}`)
      : [
        'no_active_incubation_candidate',
        ...rejectedReasons.map(reason => `rejected_diagnostic:${reason}`),
      ]),
    ...(effectiveActionability && effectiveActionability !== 'paper_or_live_ready'
      ? [`system:${effectiveActionability}`]
      : []),
    ...(authStatus && authStatus !== 'auth_available' ? [`okx_auth:${authStatus}`] : []),
    ...(feeStatus && feeStatus !== 'runtime_verified' ? [`runtime_fee:${feeStatus}`] : []),
    ...readStringArray(auth?.blockers).slice(0, 8).map(blocker => `okx_auth:${blocker}`),
    ...readStringArray(fee?.blockers).slice(0, 8).map(blocker => `runtime_fee:${blocker}`),
    ...readStringArray(liquidity?.blockers).slice(0, 8).map(blocker => `liquidity_prospective:${blocker}`),
    ...readStringArray(rankIc?.blockers).slice(0, 8).map(blocker => `rank_ic_prospective:${blocker}`),
  ])
  const verdict: ResearchLineDecision['verdict'] = primary
    ? 'continue_incubation_no_execution'
    : 'no_viable_line'
  const lineHealth: ResearchLineHealth = primary
    ? killTriggers.length > 0
      ? 'kill_condition_met'
      : 'incubate'
    : 'no_viable_line'

  return {
    verdict,
    lineHealth,
    killTriggers,
    randomSearchAllowed: false,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    primaryCandidateId: primary?.candidateId ?? null,
    primaryRoute: primary?.route ?? null,
    hardBlockers,
    rationale: buildLineDecisionRationale({
      primary,
      rejectedDiagnostics: input.rejectedDiagnostics ?? [],
      authStatus,
      feeStatus,
      feeRows,
      effectiveActionability,
      liquidityClosed: readNumber(liquidityCounts?.closedEvents),
      rankIcClosed: readNumber(rankIcCounts?.closedEvents),
      earliestNextLabelDueTime,
    }),
    pauseConditions: buildLinePauseConditions(primary),
    continueConditions: [
      'Continue only live-only data accumulation and prospective label collection; do not place paper/live orders from this line.',
      'Do not run broad random grid expansion until the current primary candidate either passes WFO/runtime-fee/prospective-label gates or hits its kill criteria.',
      'Rerun this decision after OKX auth becomes auth_available and runtime fee snapshot becomes runtime_verified.',
      `Rerun prospective settlement after ${earliestNextLabelDueTime ?? 'the next labelDueTime'} and require at least ${requiredClosedOutcomes} closed outcomes across ${requiredClosedWindows} non-overlapping windows before promotion review.`,
    ],
    nextReview: {
      afterLabelDueTime: earliestNextLabelDueTime,
      afterOkxAuthStatus: 'auth_available',
      requiredClosedOutcomes,
      requiredClosedWindows,
    },
    sourceArtifacts: input.statusPaths,
    evidenceSnapshot: {
      effectiveActionability,
      okxAuthStatus: authStatus,
      runtimeFeeStatus: feeStatus,
      runtimeFeeRows: feeRows,
      liquidityOpenEvents: readNumber(liquidityCounts?.openEvents),
      liquidityClosedEvents: readNumber(liquidityCounts?.closedEvents),
      rankIcOpenEvents: readNumber(rankIcCounts?.openEvents),
      rankIcClosedEvents: readNumber(rankIcCounts?.closedEvents),
      earliestNextLabelDueTime,
    },
  }
}

function buildLineDecisionRationale(input: {
  primary: ResearchIncubationCandidate | null
  rejectedDiagnostics: RejectedDiagnostic[]
  authStatus: string | null
  feeStatus: string | null
  feeRows: number | null
  effectiveActionability: string | null
  liquidityClosed: number | null
  rankIcClosed: number | null
  earliestNextLabelDueTime: string | null
}): string[] {
  if (!input.primary) {
    const topRejected = input.rejectedDiagnostics[0]
    if (topRejected) {
      return [
        `No active incubation candidate remains; top rejected diagnostic is ${topRejected.candidateId} with reason=${topRejected.reason}.`,
        'Paper/live execution remains disabled by the runtime status artifacts.',
      ]
    }
    return [
      'No positive route-cost-adjusted hourly RankIC diagnostic is available for incubation.',
      'Paper/live execution remains disabled by the runtime status artifacts.',
    ]
  }
  return [
    `Primary candidate ${input.primary.candidateId} has diagnostic netAfterRouteCostPct=${formatMaybe(input.primary.metrics.netAfterRouteCostPct)} on route=${input.primary.route ?? 'unknown'}, but this is research-only.`,
    `Execution actionability is ${input.effectiveActionability ?? 'unknown'}, so the line cannot authorize paper/live orders.`,
    input.authStatus === 'auth_available' && input.feeStatus === 'runtime_verified'
      ? `OKX auth is available and runtime fees are verified with ${input.feeRows ?? 0} fee rows; remaining promotion blockers are strategy evidence gates.`
      : `OKX auth status is ${input.authStatus ?? 'unknown'} and runtime fee status is ${input.feeStatus ?? 'unknown'} with ${input.feeRows ?? 0} fee rows; route-cost promotion remains blocked until runtime fees are verified.`,
    `Prospective labels are still immature: liquidityClosed=${input.liquidityClosed ?? 0}, rankIcClosed=${input.rankIcClosed ?? 0}, nextDue=${input.earliestNextLabelDueTime ?? 'unknown'}.`,
    'WFO, complete trial ledger, BY FDR, PIT, and paper execution evidence remain required before promotion.',
  ]
}

function buildLinePauseConditions(primary: ResearchIncubationCandidate | null): string[] {
  return [
    'Pause random parameter expansion while current blockers are WFO/runtime-fee/prospective-label/evidence-gate blockers rather than search-space coverage blockers.',
    ...(primary?.killCriteria ?? [
      'Retire this line if no positive route-cost-adjusted hourly diagnostic remains after the next full refresh.',
    ]),
  ]
}

async function loadResearchArtifacts(root: string): Promise<SourceFile[]> {
  if (!existsSync(root)) return []
  const paths = await listJsonFiles(root)
  const out: SourceFile[] = []
  for (const path of paths) {
    if (!isRelevantResearchPath(path)) continue
    const parsed = await readJsonIfExists(path)
    if (parsed != null) out.push({ path: resolve(path), value: parsed })
  }
  return out
}

async function listJsonFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const fullPath = resolve(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...await listJsonFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(fullPath)
    }
  }
  return out.sort()
}

function isRelevantResearchPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  return (
    normalized.includes('/rank_ic_route_cost_validation') ||
    normalized.includes('/cross_sectional_rank_ic')
  ) &&
    normalized.endsWith('.json') &&
    !normalized.endsWith('.manifest.json')
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as unknown
  } catch {
    return null
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      out.set(body.slice(0, eq), body.slice(eq + 1))
    } else {
      const next = argv[index + 1]
      if (next != null && !next.startsWith('--')) {
        out.set(body, next)
        index += 1
      } else {
        out.set(body, 'true')
      }
    }
  }
  return out
}

function parseNullablePath(raw: string | undefined): string | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  return !normalized || normalized === 'null' || normalized === 'false' || normalized === 'none'
    ? null
    : raw
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`)
  }
  return parsed
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function readBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function earliestIsoString(values: Array<string | null>): string | null {
  const valid = values
    .filter((value): value is string => value != null)
    .map(value => ({ value, ts: Date.parse(value) }))
    .filter(item => Number.isFinite(item.ts))
    .sort((left, right) => left.ts - right.ts)
  return valid[0]?.value ?? null
}

function inferWindowCountFromBlockers(blockers: string[]): number | null {
  const indexes = blockers.flatMap(blocker => {
    const match = blocker.match(/wfo_window_(\d+)_/)
    return match ? [Number(match[1])] : []
  })
  if (indexes.length === 0) return null
  return Math.max(...indexes) + 1
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function formatMaybe(value: number | null): string {
  return value == null ? 'null' : String(round(value, 6))
}

function renderConsoleSummary(report: ResearchIncubationPlanReport): string {
  const root = report.researchRoot
  return [
    `research incubation plan: status=${report.planStatus}, candidates=${report.incubationCandidatesFound}, routeCostDiagnostics=${report.routeCostDiagnosticsFound}`,
    `executionAllowed=paper:${report.paperTradingAllowed},live:${report.liveTradingAllowed}`,
    ...report.candidates.map(candidate =>
      [
        `${candidate.rank}. ${candidate.candidateId}`,
        `route=${candidate.route ?? 'null'}`,
        `net=${formatMaybe(candidate.metrics.netAfterRouteCostPct)}`,
        `signals=${candidate.metrics.signalPeriods ?? 'null'}/${report.thresholds.minSignalPeriods}`,
        `common=${candidate.metrics.commonPeriods ?? 'null'}/${report.thresholds.minCommonPeriods}`,
        `wfo=${candidate.metrics.wfoStatus ?? 'null'}`,
        `blocked=${candidate.promotionRequirements.filter(req => req.status === 'blocked').map(req => req.code).join('|') || 'none'}`,
        `source=${relative(root, candidate.sourcePath)}`,
      ].join(' | '),
    ),
    ...report.globalNextActions.map(action => `next: ${action}`),
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_research_incubation_plan failed:', error)
    process.exit(1)
  })
}
