import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assertValidTrialRecord,
  trialRecordToJson,
  type TrialRecord,
} from '../src/evidence/trial_registry.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

interface CliArgs {
  walkForwardPath: string
  routeCostPath: string
  outputPath: string | null
  registryDraftPath: string | null
  json: boolean
}

interface LaneRequirement {
  code: string
  status: 'pass' | 'blocked'
  current: number | string | boolean | null
  required: number | string | boolean
  blocker: string | null
}

interface ProspectiveTrialWindow {
  windowIndex: number
  startTime: string
  endTime: string
  trainWindowIndexes: number[]
  threshold: number | null
  periods: number
  signalPeriods: number
  meanIc: number
  icIr: number
  averageLongShortSpreadPct: number | null
  passed: boolean
  blockers: string[]
}

export interface RankIcProspectiveTrialLaneReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  prospectiveOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  laneStatus: 'ready_for_future_collection' | 'blocked_missing_candidate'
  sourceArtifacts: {
    walkForwardPath: string
    routeCostPath: string
  }
  candidate: {
    laneId: string
    candidateId: string
    strategyFamily: 'cross_sectional_rank_ic_walkforward_filter'
    filterId: string
    factor: string | null
    lookbackHours: number | null
    secondaryLookbackHours: number | null
    forwardHours: number | null
    mtfWeight: number | null
    hypothesis: string
    primaryMetric: 'route_cost_adjusted_long_short_spread_pct'
    secondaryMetrics: string[]
  } | null
  currentEvidence: {
    walkForwardVerdict: string | null
    walkForwardWfoStatus: string | null
    walkForwardPassedWindows: number | null
    walkForwardWindowCount: number | null
    walkForwardFailedWindowRatio: number | null
    meanIc: number | null
    icIr: number | null
    averageLongShortSpreadPct: number | null
    retainedPct: number | null
    route: string | null
    netAfterRouteCostPct: number | null
    grossToPairCostRatio: number | null
    feeSnapshotSource: string | null
    feeSnapshotVerifiedByRuntime: boolean | null
  }
  prospectiveProtocol: {
    unit: 'future_1h_decision_period'
    entryPolicy: 'decision_time_filter_then_rank_ic_signal_only'
    labelDelayHours: number | null
    minimumFutureSignalPeriods: number
    minimumFutureValidationWindows: number
    requiresRuntimeVerifiedFees: true
    requiresCompleteTrialUniverseBeforePromotion: true
    requiresPitAuditBeforePromotion: true
    orderExecutionAllowed: false
  }
  requirements: LaneRequirement[]
  registryDraft: TrialRecord | null
  registryDraftJson: Record<string, unknown> | null
  windows: ProspectiveTrialWindow[]
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_WALK_FORWARD_PATH = 'data/research/rank_ic_walkforward_filter_validation.live_accumulated_fwd72.latest.json'
const DEFAULT_ROUTE_COST_PATH = 'data/research/rank_ic_route_cost_validation.live_accumulated_fwd72_median_filter.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/rank_ic_prospective_trial_lane.live_accumulated_fwd72_median_filter.latest.json'
const DEFAULT_REGISTRY_DRAFT_PATH = 'data/research/rank_ic_prospective_trial_lane.live_accumulated_fwd72_median_filter.registry_draft.latest.json'
const MIN_FUTURE_SIGNAL_PERIODS = 100
const MIN_FUTURE_VALIDATION_WINDOWS = 3

async function main(): Promise<void> {
  const args = parseRankIcProspectiveTrialLaneArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runRankIcProspectiveTrialLane(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'rank_ic_prospective_trial_lane',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.laneStatus === 'ready_for_future_collection' ? 'warn' : 'fail',
      recordsIn: report.windows.length,
      recordsOut: report.registryDraft ? 1 : 0,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseRankIcProspectiveTrialLaneArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    walkForwardPath: raw.get('walkForwardPath') ?? raw.get('walkForward') ?? DEFAULT_WALK_FORWARD_PATH,
    routeCostPath: raw.get('routeCostPath') ?? raw.get('routeCost') ?? DEFAULT_ROUTE_COST_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    registryDraftPath: parseNullablePath(raw.get('registryDraftPath') ?? raw.get('registryDraft') ?? DEFAULT_REGISTRY_DRAFT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runRankIcProspectiveTrialLane(
  args: CliArgs,
): Promise<RankIcProspectiveTrialLaneReport> {
  const walkForwardPath = resolve(args.walkForwardPath)
  const routeCostPath = resolve(args.routeCostPath)
  const walkForward = asRecord(await readJsonIfExists(walkForwardPath))
  const routeCost = asRecord(await readJsonIfExists(routeCostPath))
  const report = buildRankIcProspectiveTrialLaneReport({
    walkForwardPath,
    routeCostPath,
    walkForward,
    routeCost,
    generatedAt: new Date().toISOString(),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }
  if (args.registryDraftPath && report.registryDraftJson) {
    const registryDraftPath = resolve(args.registryDraftPath)
    await mkdir(dirname(registryDraftPath), { recursive: true })
    await writeFile(registryDraftPath, `${JSON.stringify(report.registryDraftJson, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildRankIcProspectiveTrialLaneReport(input: {
  walkForwardPath: string
  routeCostPath: string
  walkForward: Record<string, unknown> | null
  routeCost: Record<string, unknown> | null
  generatedAt?: string
}): RankIcProspectiveTrialLaneReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const wfCandidate = asRecord(input.walkForward?.bestWalkForwardCandidate)
  const config = asRecord(input.walkForward?.config)
  const routeCandidate = asRecord(input.routeCost?.candidate)
  const route = asRecord(input.routeCost?.bestDiagnosticRoute)
  const feeSnapshot = asRecord(input.routeCost?.feeSnapshot)
  const laneCandidate = wfCandidate && config
    ? buildLaneCandidate(wfCandidate, config)
    : null
  const currentEvidence = {
    walkForwardVerdict: readString(wfCandidate?.diagnosticVerdict),
    walkForwardWfoStatus: readString(asRecord(wfCandidate?.wfo)?.status),
    walkForwardPassedWindows: readNumber(asRecord(wfCandidate?.wfo)?.passedWindows),
    walkForwardWindowCount: readNumber(asRecord(wfCandidate?.wfo)?.windowCount),
    walkForwardFailedWindowRatio: readNumber(asRecord(wfCandidate?.wfo)?.failedWindowRatio),
    meanIc: readNumber(asRecord(wfCandidate?.aggregate)?.meanIc),
    icIr: readNumber(asRecord(wfCandidate?.aggregate)?.icIr),
    averageLongShortSpreadPct: readNumber(asRecord(wfCandidate?.aggregate)?.averageLongShortSpreadPct),
    retainedPct: readNumber(asRecord(wfCandidate?.aggregate)?.retainedPct),
    route: readString(route?.route),
    netAfterRouteCostPct: readNumber(route?.netAfterRouteCostPct),
    grossToPairCostRatio: readNumber(route?.grossToPairCostRatio),
    feeSnapshotSource: readString(feeSnapshot?.source),
    feeSnapshotVerifiedByRuntime: readBool(feeSnapshot?.verifiedByRuntime),
  }
  const windows = readWindows(wfCandidate)
  const requirements = buildRequirements(currentEvidence)
  const blockers = buildBlockers(input.walkForward, input.routeCost, laneCandidate, currentEvidence, requirements)
  const registryDraft = laneCandidate
    ? buildRegistryDraft({
        candidate: laneCandidate,
        generatedAt,
        evidenceId: evidenceIdFor(input.walkForward, input.routeCost, laneCandidate),
        sourceArtifacts: {
          walkForwardPath: resolve(input.walkForwardPath),
          routeCostPath: resolve(input.routeCostPath),
        },
        currentEvidence,
        blockers,
      })
    : null
  if (registryDraft) assertValidTrialRecord(registryDraft)

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    laneStatus: laneCandidate ? 'ready_for_future_collection' : 'blocked_missing_candidate',
    sourceArtifacts: {
      walkForwardPath: resolve(input.walkForwardPath),
      routeCostPath: resolve(input.routeCostPath),
    },
    candidate: laneCandidate,
    currentEvidence,
    prospectiveProtocol: {
      unit: 'future_1h_decision_period',
      entryPolicy: 'decision_time_filter_then_rank_ic_signal_only',
      labelDelayHours: laneCandidate?.forwardHours ?? readNumber(routeCandidate?.forwardHours),
      minimumFutureSignalPeriods: MIN_FUTURE_SIGNAL_PERIODS,
      minimumFutureValidationWindows: MIN_FUTURE_VALIDATION_WINDOWS,
      requiresRuntimeVerifiedFees: true,
      requiresCompleteTrialUniverseBeforePromotion: true,
      requiresPitAuditBeforePromotion: true,
      orderExecutionAllowed: false,
    },
    requirements,
    registryDraft,
    registryDraftJson: registryDraft ? trialRecordToJson(registryDraft) : null,
    windows,
    blockers,
    nextActions: buildNextActions(laneCandidate),
    notes: [
      'This lane is prospective and diagnostic-only; it cannot authorize paper or live orders.',
      'The registryDraft is intentionally not appended by this script. Append only when the user/operator starts a controlled future evidence-collection campaign.',
      'The draft is excluded from FDR until future outcomes, p-values, complete trial universe, runtime fee evidence, and PIT audit are available.',
      'Current in-sample and walk-forward diagnostics are useful for prioritization, not promotion.',
    ],
  }
}

function buildLaneCandidate(
  wfCandidate: Record<string, unknown>,
  config: Record<string, unknown>,
): NonNullable<RankIcProspectiveTrialLaneReport['candidate']> {
  const filterId = readString(wfCandidate.filterId) ?? 'unknown_filter'
  const factor = readString(config.factor)
  const lookbackHours = readNumber(config.lookbackHours)
  const secondaryLookbackHours = readNumber(config.secondaryLookbackHours)
  const forwardHours = readNumber(config.forwardHours)
  const mtfWeight = readNumber(config.mtfWeight)
  const candidateId = [
    'rank_ic_wf_filter',
    filterId,
    factor ?? 'factor',
    `lb${lookbackHours ?? 'na'}`,
    `sec${secondaryLookbackHours ?? 'na'}`,
    `fwd${forwardHours ?? 'na'}`,
    `mtf${mtfWeight ?? 'na'}`,
  ].join('_')
  const laneId = `prospective_${sha256Hex(candidateId).slice(0, 16)}`
  return {
    laneId,
    candidateId,
    strategyFamily: 'cross_sectional_rank_ic_walkforward_filter',
    filterId,
    factor,
    lookbackHours,
    secondaryLookbackHours,
    forwardHours,
    mtfWeight,
    hypothesis: `A prior-window ${filterId} regime gate improves future cross-sectional ${factor ?? 'rank_ic'} ordering after costs without using future data.`,
    primaryMetric: 'route_cost_adjusted_long_short_spread_pct',
    secondaryMetrics: [
      'rank_ic_mean',
      'rank_ic_ir',
      'walk_forward_failed_window_ratio',
      'route_cost_adjusted_net_pct',
      'retained_regime_pct',
    ],
  }
}

function buildRequirements(input: RankIcProspectiveTrialLaneReport['currentEvidence']): LaneRequirement[] {
  return [
    numericRequirement('walk_forward_windows', input.walkForwardWindowCount, MIN_FUTURE_VALIDATION_WINDOWS, '>='),
    numericRequirement('walk_forward_passed_windows', input.walkForwardPassedWindows, 3, '>='),
    numericRequirement('walk_forward_failed_window_ratio', input.walkForwardFailedWindowRatio, 0.3, '<='),
    {
      code: 'walk_forward_wfo_status',
      status: input.walkForwardWfoStatus === 'pass' ? 'pass' : 'blocked',
      current: input.walkForwardWfoStatus,
      required: 'pass',
      blocker: input.walkForwardWfoStatus === 'pass' ? null : `walk_forward_wfo_status:${input.walkForwardWfoStatus ?? 'missing'}`,
    },
    numericRequirement('route_cost_adjusted_net', input.netAfterRouteCostPct, 0, '>'),
    {
      code: 'runtime_fee_snapshot',
      status: input.feeSnapshotVerifiedByRuntime === true && input.feeSnapshotSource !== 'manual_override' ? 'pass' : 'blocked',
      current: `${input.feeSnapshotSource ?? 'missing'}|verified=${input.feeSnapshotVerifiedByRuntime ?? false}`,
      required: 'runtime_verified_non_manual',
      blocker: input.feeSnapshotVerifiedByRuntime === true && input.feeSnapshotSource !== 'manual_override'
        ? null
        : 'fee_snapshot_not_runtime_verified',
    },
    {
      code: 'future_trial_outcomes',
      status: 'blocked',
      current: 0,
      required: `>=${MIN_FUTURE_SIGNAL_PERIODS}`,
      blocker: 'future_live_only_trial_outcomes_missing',
    },
    {
      code: 'complete_trial_universe',
      status: 'blocked',
      current: false,
      required: true,
      blocker: 'complete_trial_universe_missing',
    },
    {
      code: 'by_fdr_ready',
      status: 'blocked',
      current: false,
      required: true,
      blocker: 'by_fdr_not_ready',
    },
    {
      code: 'pit_audit_ready',
      status: 'blocked',
      current: false,
      required: true,
      blocker: 'pit_audit_not_ready',
    },
  ]
}

function numericRequirement(
  code: string,
  current: number | null,
  required: number,
  operator: '>=' | '<=' | '>',
): LaneRequirement {
  const passed = current != null &&
    (operator === '>=' ? current >= required : operator === '<=' ? current <= required : current > required)
  return {
    code,
    status: passed ? 'pass' : 'blocked',
    current,
    required: `${operator}${required}`,
    blocker: passed ? null : `${code}:${current ?? 'missing'}${operator}${required}`,
  }
}

function buildBlockers(
  walkForward: Record<string, unknown> | null,
  routeCost: Record<string, unknown> | null,
  candidate: RankIcProspectiveTrialLaneReport['candidate'],
  currentEvidence: RankIcProspectiveTrialLaneReport['currentEvidence'],
  requirements: LaneRequirement[],
): string[] {
  const blockers = [
    'prospective_lane_not_execution_evidence',
    'paper_live_execution_disabled',
    ...readStringArray(walkForward?.blockers),
    ...readStringArray(routeCost?.blockers),
    ...requirements.flatMap(requirement => requirement.blocker ? [requirement.blocker] : []),
  ]
  if (!walkForward) blockers.push('walk_forward_artifact_missing')
  if (!routeCost) blockers.push('route_cost_artifact_missing')
  if (!candidate) blockers.push('walk_forward_candidate_missing')
  if (currentEvidence.walkForwardVerdict !== 'walk_forward_improved_candidate') {
    blockers.push(`walk_forward_verdict_not_improved:${currentEvidence.walkForwardVerdict ?? 'missing'}`)
  }
  return uniqueStrings(blockers)
}

function buildRegistryDraft(input: {
  candidate: NonNullable<RankIcProspectiveTrialLaneReport['candidate']>
  generatedAt: string
  evidenceId: string
  sourceArtifacts: RankIcProspectiveTrialLaneReport['sourceArtifacts']
  currentEvidence: RankIcProspectiveTrialLaneReport['currentEvidence']
  blockers: string[]
}): TrialRecord {
  return {
    trialId: `prospective_${input.candidate.laneId}`,
    evidenceId: input.evidenceId,
    trialType: 'diagnostic_factor',
    strategyFamily: input.candidate.strategyFamily,
    candidateId: input.candidate.candidateId,
    hypothesis: input.candidate.hypothesis,
    primaryMetric: input.candidate.primaryMetric,
    secondaryMetrics: input.candidate.secondaryMetrics,
    pValue: null,
    includedInFdr: false,
    fdrFamily: '2026Q2_crypto_evidence_os_v4',
    promotionEligible: false,
    status: 'registered',
    failureCodes: [
      'MISSING_LIVE_ONLY_EVIDENCE',
      'FDR_INPUTS_INCOMPLETE',
      'PIT_AUDIT_NOT_IMPLEMENTED',
      'COST_FRAGILE',
      'WFO_DEGRADED',
    ],
    batchId: 'rank_ic_wf_filter_prospective',
    createdAt: input.generatedAt,
    metadata: {
      source_artifacts: input.sourceArtifacts,
      prospective_only: true,
      order_execution_allowed: false,
      current_walk_forward_wfo_status: input.currentEvidence.walkForwardWfoStatus,
      current_walk_forward_failed_window_ratio: input.currentEvidence.walkForwardFailedWindowRatio,
      current_net_after_route_cost_pct: input.currentEvidence.netAfterRouteCostPct,
      current_fee_snapshot_source: input.currentEvidence.feeSnapshotSource,
      current_fee_snapshot_verified_by_runtime: input.currentEvidence.feeSnapshotVerifiedByRuntime,
      future_min_signal_periods: MIN_FUTURE_SIGNAL_PERIODS,
      future_min_validation_windows: MIN_FUTURE_VALIDATION_WINDOWS,
      p_value_source: 'missing',
      fdr_report_status: 'blocked_inputs_incomplete',
      fdr_report_path_source: 'registry_metadata',
      raw_m_complete: false,
      includes_failed_trials: false,
      fdr_p_values_available: false,
      fdr_missing_p_value_count: 1,
      fdr_p_value_blocked_reason: 'future_live_only_trial_outcomes_missing',
      pit_audit_status: 'blocked',
      pit_audit_blocking_codes: ['PIT_AUDIT_NOT_IMPLEMENTED'],
      pit_audit_promotion_grade: false,
      pit_audit_promotion_grade_source: 'default_fail_closed',
      promotion_decision_source: 'fail_closed_validation_pipeline',
      blockers: input.blockers,
    },
  }
}

function readWindows(wfCandidate: Record<string, unknown> | null): ProspectiveTrialWindow[] {
  const windows = Array.isArray(wfCandidate?.windows) ? wfCandidate.windows : []
  return windows.map(asRecord).filter(isRecordValue).map(window => {
    const filter = asRecord(window.filter)
    const thresholds = asRecord(filter?.thresholds)
    const summary = asRecord(window.summary)
    return {
      windowIndex: readNumber(window.windowIndex) ?? 0,
      startTime: readString(window.startTime) ?? '',
      endTime: readString(window.endTime) ?? '',
      trainWindowIndexes: readNumberArray(window.trainWindowIndexes),
      threshold: readNumber(thresholds?.minMedianReturnPct),
      periods: readNumber(summary?.periods) ?? 0,
      signalPeriods: readNumber(summary?.signalPeriods) ?? 0,
      meanIc: readNumber(summary?.meanIc) ?? 0,
      icIr: readNumber(summary?.icIr) ?? 0,
      averageLongShortSpreadPct: readNumber(summary?.averageLongShortSpreadPct),
      passed: readBool(window.passed) === true,
      blockers: readStringArray(window.blockers),
    }
  })
}

function buildNextActions(candidate: RankIcProspectiveTrialLaneReport['candidate']): string[] {
  if (!candidate) {
    return [
      'Regenerate walk-forward filter validation and route-cost artifacts before creating a prospective lane.',
      'Keep paper/live disabled.',
    ]
  }
  return [
    `Track ${candidate.candidateId} as a future live-only diagnostic lane without placing orders.`,
    'Collect future 1h decision rows, realized forward labels, route-cost fields, and complete predicted-open evidence.',
    'Fix OKX runtime fee authentication before accepting route-cost metrics as promotion-grade.',
    'Only append the registry draft when starting a controlled future evidence campaign; do not append it as promotion evidence.',
    'After enough future rows exist, compute p-values, BY FDR, PIT audit, route-cost validation, and WFO again.',
  ]
}

function evidenceIdFor(
  walkForward: Record<string, unknown> | null,
  routeCost: Record<string, unknown> | null,
  candidate: NonNullable<RankIcProspectiveTrialLaneReport['candidate']>,
): string {
  return `sha256:${sha256Hex(JSON.stringify({
    candidate,
    walkForwardGeneratedAt: walkForward?.generatedAt,
    routeCostGeneratedAt: routeCost?.generatedAt,
    routeCostCandidate: asRecord(routeCost?.candidate)?.candidateId,
  }))}`
}

function renderConsoleSummary(report: RankIcProspectiveTrialLaneReport): string {
  return [
    `rank ic prospective trial lane: status=${report.laneStatus}, candidate=${report.candidate?.candidateId ?? 'none'}`,
    `paper=${report.paperTradingAllowed}, live=${report.liveTradingAllowed}, promotion=${report.promotionEligible}`,
    `wf=${report.currentEvidence.walkForwardWfoStatus}, pass=${report.currentEvidence.walkForwardPassedWindows}/${report.currentEvidence.walkForwardWindowCount}, net=${report.currentEvidence.netAfterRouteCostPct}`,
    `blockers=${report.blockers.slice(0, 12).join('|')}`,
  ].join('\n')
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const tokens = argv.filter(token => token !== '--')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      out.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = tokens[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(body, next)
      index += 1
    } else {
      out.set(body, 'true')
    }
  }
  return out
}

function parseNullablePath(raw: string | undefined): string | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  return !normalized || normalized === 'null' || normalized === 'none' || normalized === 'false'
    ? null
    : raw
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw.trim().toLowerCase())
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  if (!existsSync(path)) return null
  return JSON.parse(await readFile(path, 'utf-8'))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isRecordValue(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value !== null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : []
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_rank_ic_prospective_trial_lane failed:', error)
    process.exit(1)
  })
}
