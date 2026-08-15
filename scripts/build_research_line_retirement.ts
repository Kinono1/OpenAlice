import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

export type ResearchLineRetirementVerdict =
  | 'retire_current_line'
  | 'no_active_line'
  | 'keep_incubating'
  | 'insufficient_evidence'

export interface ResearchLineRetirementArgs {
  incubationPlanPath: string
  candidateSummaryPath: string
  cryptoFactorFamilyPath: string
  liquidityConditionedFactorPath: string
  rankIcProspectiveStatusPath: string
  liquidityProspectiveStatusPath: string
  outputPath: string | null
  json: boolean
}

export interface ResearchLineRetirementCandidate {
  lineId: string
  sourcePath: string
  candidateId: string
  family: string | null
  strategy: string | null
  status: 'active' | 'rejected' | 'diagnostic'
  netAfterRouteCostPct: number | null
  wfoStatus: string | null
  wfoWindowCount: number | null
  wfoFailedWindowRatio: number | null
  wfoFailWindowRatioThreshold: number | null
  wfoDirectionStable: boolean | null
  runtimeFeeVerified: boolean | null
  killTriggers: string[]
  blockers: string[]
}

export interface ResearchLineRetirementReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionAllowed: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  policyMutationAllowed: false
  verdict: ResearchLineRetirementVerdict
  lineHealth: 'retired' | 'no_active_line' | 'incubating' | 'unknown'
  inputs: {
    incubationPlanPath: string
    candidateSummaryPath: string
    cryptoFactorFamilyPath: string
    liquidityConditionedFactorPath: string
    rankIcProspectiveStatusPath: string
    liquidityProspectiveStatusPath: string
  }
  summary: {
    activeIncubationCandidates: number
    rejectedDiagnostics: number
    wfoKilledDiagnostics: number
    diagnosticLinesReviewed: number
    retirementRecommendedLines: number
    openProspectiveEvents: number
    closedProspectiveEvents: number
    earliestNextLabelDueTime: string | null
  }
  primaryLine: ResearchLineRetirementCandidate | null
  retiredLines: ResearchLineRetirementCandidate[]
  watchLines: ResearchLineRetirementCandidate[]
  blockers: string[]
  requiredBeforeReactivation: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_INCUBATION_PLAN_PATH = 'data/research/research_incubation_plan.latest.json'
const DEFAULT_CANDIDATE_SUMMARY_PATH = 'data/research/candidate_ranking.latest.json'
const DEFAULT_CRYPTO_FACTOR_FAMILY_PATH = 'data/research/crypto_factor_family.live_accumulated.latest.json'
const DEFAULT_LIQUIDITY_CONDITIONED_FACTOR_PATH = 'data/research/liquidity_conditioned_factor_report.live_accumulated.latest.json'
const DEFAULT_RANK_IC_PROSPECTIVE_STATUS_PATH =
  'data/research/rank_ic_prospective_evidence_status.live_accumulated_fwd72_median_filter.latest.json'
const DEFAULT_LIQUIDITY_PROSPECTIVE_STATUS_PATH =
  'data/research/liquidity_conditioned_prospective_evidence_status.live_accumulated.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/research_line_retirement.latest.json'
const DEFAULT_MIN_WFO_WINDOWS = 3

export function parseResearchLineRetirementArgs(argv: string[]): ResearchLineRetirementArgs {
  const raw = parseRawArgs(argv)
  return {
    incubationPlanPath: raw.get('incubationPlanPath') ??
      raw.get('incubationPlan') ??
      DEFAULT_INCUBATION_PLAN_PATH,
    candidateSummaryPath: raw.get('candidateSummaryPath') ??
      raw.get('candidateSummary') ??
      DEFAULT_CANDIDATE_SUMMARY_PATH,
    cryptoFactorFamilyPath: raw.get('cryptoFactorFamilyPath') ??
      raw.get('cryptoFactorFamily') ??
      DEFAULT_CRYPTO_FACTOR_FAMILY_PATH,
    liquidityConditionedFactorPath: raw.get('liquidityConditionedFactorPath') ??
      raw.get('liquidityConditionedFactor') ??
      DEFAULT_LIQUIDITY_CONDITIONED_FACTOR_PATH,
    rankIcProspectiveStatusPath: raw.get('rankIcProspectiveStatusPath') ??
      DEFAULT_RANK_IC_PROSPECTIVE_STATUS_PATH,
    liquidityProspectiveStatusPath: raw.get('liquidityProspectiveStatusPath') ??
      DEFAULT_LIQUIDITY_PROSPECTIVE_STATUS_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runResearchLineRetirement(
  args: ResearchLineRetirementArgs,
): Promise<ResearchLineRetirementReport> {
  const startedAt = new Date()
  const inputPaths = {
    incubationPlanPath: resolve(args.incubationPlanPath),
    candidateSummaryPath: resolve(args.candidateSummaryPath),
    cryptoFactorFamilyPath: resolve(args.cryptoFactorFamilyPath),
    liquidityConditionedFactorPath: resolve(args.liquidityConditionedFactorPath),
    rankIcProspectiveStatusPath: resolve(args.rankIcProspectiveStatusPath),
    liquidityProspectiveStatusPath: resolve(args.liquidityProspectiveStatusPath),
  }
  const report = buildResearchLineRetirementReport({
    inputs: inputPaths,
    incubationPlan: await readJsonIfExists(inputPaths.incubationPlanPath),
    candidateSummary: await readJsonIfExists(inputPaths.candidateSummaryPath),
    cryptoFactorFamily: await readJsonIfExists(inputPaths.cryptoFactorFamilyPath),
    liquidityConditionedFactor: await readJsonIfExists(inputPaths.liquidityConditionedFactorPath),
    rankIcProspectiveStatus: await readJsonIfExists(inputPaths.rankIcProspectiveStatusPath),
    liquidityProspectiveStatus: await readJsonIfExists(inputPaths.liquidityProspectiveStatusPath),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'research_line_retirement',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.verdict === 'keep_incubating' ? 'warn' : 'fail',
      recordsIn: report.summary.diagnosticLinesReviewed,
      recordsOut: report.summary.retirementRecommendedLines,
      errorClass: report.verdict,
    })
  }

  return report
}

export function buildResearchLineRetirementReport(input: {
  inputs: ResearchLineRetirementReport['inputs']
  incubationPlan?: unknown
  candidateSummary?: unknown
  cryptoFactorFamily?: unknown
  liquidityConditionedFactor?: unknown
  rankIcProspectiveStatus?: unknown
  liquidityProspectiveStatus?: unknown
  generatedAt?: string
}): ResearchLineRetirementReport {
  const incubation = asRecord(input.incubationPlan)
  const candidateSummary = asRecord(input.candidateSummary)
  const cryptoFactor = asRecord(input.cryptoFactorFamily)
  const liquidityFactor = asRecord(input.liquidityConditionedFactor)
  const rankProspective = asRecord(input.rankIcProspectiveStatus)
  const liquidityProspective = asRecord(input.liquidityProspectiveStatus)
  const activeCandidates = readRecords(incubation?.candidates)
    .map(candidate => lineFromIncubationCandidate(candidate, input.inputs.incubationPlanPath))
  const rejectedDiagnostics = readRecords(incubation?.rejectedDiagnostics)
    .map(diagnostic => lineFromRejectedDiagnostic(diagnostic))
  const candidateSummaryDiagnostics = readCandidateSummaryDiagnostics(candidateSummary, input.inputs.candidateSummaryPath)
  const factorDiagnostics = [
    lineFromFactorReport(cryptoFactor, input.inputs.cryptoFactorFamilyPath, 'crypto_factor_family'),
    lineFromFactorReport(liquidityFactor, input.inputs.liquidityConditionedFactorPath, 'liquidity_conditioned_factor'),
  ].filter((item): item is ResearchLineRetirementCandidate => item != null)
  const linesByKey = new Map<string, ResearchLineRetirementCandidate>()
  for (const line of [
    ...activeCandidates,
    ...rejectedDiagnostics,
    ...candidateSummaryDiagnostics,
    ...factorDiagnostics,
  ]) {
    const key = `${line.sourcePath}|${line.candidateId}|${line.family ?? ''}|${line.strategy ?? ''}`
    const previous = linesByKey.get(key)
    if (!previous || retirementRank(line) > retirementRank(previous)) {
      linesByKey.set(key, line)
    }
  }
  const lines = [...linesByKey.values()].sort(compareLines)
  const retiredLines = lines.filter(line => shouldRetire(line))
  const watchLines = lines.filter(line => !shouldRetire(line))
  const activeIncubationCount = readNumber(incubation?.incubationCandidatesFound) ?? activeCandidates.length
  const rejectedCount = rejectedDiagnostics.length
  const wfoKilledCount = rejectedDiagnostics.filter(line => line.killTriggers.length > 0).length
  const openProspectiveEvents =
    (readNumber(asRecord(rankProspective?.counts)?.openEvents) ?? 0) +
    (readNumber(asRecord(liquidityProspective?.counts)?.openEvents) ?? 0)
  const closedProspectiveEvents =
    (readNumber(asRecord(rankProspective?.counts)?.closedEvents) ?? 0) +
    (readNumber(asRecord(liquidityProspective?.counts)?.closedEvents) ?? 0)
  const earliestNextLabelDueTime = earliestIsoString([
    readString(asRecord(rankProspective?.latestOpen)?.labelDueTime),
    readString(asRecord(liquidityProspective?.latestOpen)?.labelDueTime),
  ])
  const verdict = chooseVerdict({
    activeIncubationCount,
    retiredLines,
    lines,
    incubation,
  })
  const primaryLine = retiredLines[0] ?? activeCandidates[0] ?? lines[0] ?? null
  const blockers = uniqueStrings([
    ...(input.incubationPlan ? [] : ['research_incubation_plan_missing']),
    ...(input.candidateSummary ? [] : ['candidate_summary_missing']),
    ...(input.cryptoFactorFamily ? [] : ['crypto_factor_family_report_missing']),
    ...(input.liquidityConditionedFactor ? [] : ['liquidity_conditioned_factor_report_missing']),
    ...(input.rankIcProspectiveStatus ? [] : ['rank_ic_prospective_status_missing']),
    ...(input.liquidityProspectiveStatus ? [] : ['liquidity_conditioned_prospective_status_missing']),
    ...(activeIncubationCount > 0 ? [] : ['no_active_incubation_candidate']),
    ...(retiredLines.length > 0
      ? retiredLines.slice(0, 8).flatMap(line =>
          line.killTriggers.map(trigger => `retired_line:${line.lineId}:${trigger}`),
        )
      : ['no_retirement_recommendation']),
    ...readStringArray(asRecord(incubation?.lineDecision)?.hardBlockers).slice(0, 12)
      .map(blocker => `line_decision:${blocker}`),
  ])

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    policyMutationAllowed: false,
    verdict,
    lineHealth: verdict === 'retire_current_line'
      ? 'retired'
      : verdict === 'no_active_line'
        ? 'no_active_line'
        : verdict === 'keep_incubating'
          ? 'incubating'
          : 'unknown',
    inputs: {
      incubationPlanPath: resolve(input.inputs.incubationPlanPath),
      candidateSummaryPath: resolve(input.inputs.candidateSummaryPath),
      cryptoFactorFamilyPath: resolve(input.inputs.cryptoFactorFamilyPath),
      liquidityConditionedFactorPath: resolve(input.inputs.liquidityConditionedFactorPath),
      rankIcProspectiveStatusPath: resolve(input.inputs.rankIcProspectiveStatusPath),
      liquidityProspectiveStatusPath: resolve(input.inputs.liquidityProspectiveStatusPath),
    },
    summary: {
      activeIncubationCandidates: activeIncubationCount,
      rejectedDiagnostics: rejectedCount,
      wfoKilledDiagnostics: wfoKilledCount,
      diagnosticLinesReviewed: lines.length,
      retirementRecommendedLines: retiredLines.length,
      openProspectiveEvents,
      closedProspectiveEvents,
      earliestNextLabelDueTime,
    },
    primaryLine,
    retiredLines,
    watchLines,
    blockers,
    requiredBeforeReactivation: [
      'new_alpha_hypothesis_or_materially_different_feature_set',
      'runtime_verified_non_stale_route_costs',
      'wfo_failed_window_ratio_lte_threshold_and_direction_stable',
      'complete_trial_ledger_with_by_fdr',
      'pit_audit_pass',
      'prospective_closed_outcomes_gte_100_across_3_non_overlapping_windows',
      'paper_execution_evidence_after_release_gate',
    ],
    nextActions: buildNextActions({ verdict, primaryLine, earliestNextLabelDueTime }),
    safetyNotes: [
      'This artifact is diagnostic-only and cannot mutate candidate registries, best_config.json, paper policies, or orders.',
      'Retirement means stop broad parameter search on this line unless there is a new hypothesis or material feature/data change.',
      'Positive netAfterRouteCostPct is not enough to keep a line alive when WFO is failed across locked windows.',
      'Open prospective events are not promotion evidence until settled into route-cost-adjusted closed labels.',
    ],
  }
}

function lineFromIncubationCandidate(
  candidate: Record<string, unknown>,
  sourcePath: string,
): ResearchLineRetirementCandidate {
  const metrics = asRecord(candidate.metrics)
  const fee = asRecord(candidate.feeSnapshot)
  const line = {
    lineId: sanitizeLineId(readString(candidate.candidateId) ?? 'incubation_candidate'),
    sourcePath,
    candidateId: readString(candidate.candidateId) ?? 'incubation_candidate',
    family: readString(candidate.factor),
    strategy: readString(candidate.route),
    status: 'active' as const,
    netAfterRouteCostPct: readNumber(metrics?.netAfterRouteCostPct),
    wfoStatus: readString(metrics?.wfoStatus),
    wfoWindowCount: readNumber(metrics?.wfoWindowCount),
    wfoFailedWindowRatio: readNumber(metrics?.wfoFailedWindowRatio),
    wfoFailWindowRatioThreshold: readNumber(metrics?.wfoFailWindowRatioThreshold),
    wfoDirectionStable: readBool(metrics?.wfoDirectionStable),
    runtimeFeeVerified: readBool(fee?.verifiedByRuntime),
    killTriggers: [] as string[],
    blockers: readStringArray(candidate.blockers),
  }
  return {
    ...line,
    killTriggers: buildKillTriggers(line),
  }
}

function lineFromRejectedDiagnostic(diagnostic: Record<string, unknown>): ResearchLineRetirementCandidate {
  const candidateId = readString(diagnostic.candidateId) ?? 'rejected_diagnostic'
  const killTriggers = readStringArray(diagnostic.killTriggers)
  const sourcePath = readString(diagnostic.sourcePath) ?? 'unknown'
  return {
    lineId: sanitizeLineId(candidateId),
    sourcePath,
    candidateId,
    family: inferFamily(candidateId, sourcePath),
    strategy: null,
    status: 'rejected',
    netAfterRouteCostPct: readNumber(diagnostic.netAfterRouteCostPct),
    wfoStatus: readString(diagnostic.reason) === 'wfo_kill_condition_met' ? 'fail' : null,
    wfoWindowCount: null,
    wfoFailedWindowRatio: parseRatioFromTriggers(killTriggers),
    wfoFailWindowRatioThreshold: parseThresholdFromTriggers(killTriggers),
    wfoDirectionStable: killTriggers.includes('primary:wfo_direction_not_stable') ? false : null,
    runtimeFeeVerified: null,
    killTriggers,
    blockers: [readString(diagnostic.reason)].filter((item): item is string => item != null),
  }
}

function lineFromFactorReport(
  report: Record<string, unknown> | null,
  sourcePath: string,
  family: string,
): ResearchLineRetirementCandidate | null {
  if (!report) return null
  const best = asRecord(report.best)
  if (!best) return null
  const wfo = asRecord(best.wfo)
  const routeCost = asRecord(report.routeCost)
  const candidateId = readString(best.candidateId) ?? readString(best.configId) ?? `${family}_best`
  const line = {
    lineId: sanitizeLineId(candidateId),
    sourcePath,
    candidateId,
    family,
    strategy: readString(best.factor) ?? readString(best.liquidityBucket),
    status: 'diagnostic' as const,
    netAfterRouteCostPct: readNumber(best.netAfterRouteCostPct),
    wfoStatus: readString(wfo?.status),
    wfoWindowCount: readNumber(wfo?.windowCount),
    wfoFailedWindowRatio: readNumber(wfo?.failedWindowRatio),
    wfoFailWindowRatioThreshold: readNumber(wfo?.failWindowRatioThreshold),
    wfoDirectionStable: readBool(wfo?.directionStable),
    runtimeFeeVerified: readBool(routeCost?.runtimeVerified),
    killTriggers: [] as string[],
    blockers: uniqueStrings([
      ...readStringArray(best.blockers),
      ...readStringArray(wfo?.blockers),
      ...readStringArray(report.blockers),
    ]),
  }
  return {
    ...line,
    killTriggers: buildKillTriggers(line),
  }
}

function readCandidateSummaryDiagnostics(
  summary: Record<string, unknown> | null,
  sourcePath: string,
): ResearchLineRetirementCandidate[] {
  const topCandidates = readRecords(summary?.topCandidates)
  const bestByTierCandidates = readRecords(summary?.bestByTier)
    .map(item => asRecord(item.candidate))
    .filter((item): item is Record<string, unknown> => item != null)
  return [...topCandidates, ...bestByTierCandidates]
    .filter(candidate => {
      const sourceKind = readString(candidate.sourceKind)
      return sourceKind === 'liquidity_conditioned_factor' || sourceKind === 'crypto_factor_family'
    })
    .map(candidate => {
      const metrics = asRecord(candidate.metrics)
      const whyNotTradable = readStringArray(candidate.whyNotTradable)
      const candidateId = readString(candidate.candidateId) ?? 'candidate_summary_line'
      const failedRatio = readNumber(metrics?.rankIcWfoFailedWindowRatio)
      const line = {
        lineId: sanitizeLineId(candidateId),
        sourcePath: readString(candidate.sourcePath) ?? sourcePath,
        candidateId,
        family: readString(candidate.family),
        strategy: readString(candidate.strategy),
        status: 'diagnostic' as const,
        netAfterRouteCostPct: readNumber(metrics?.netAfterRouteCostPct),
        wfoStatus: readString(metrics?.rankIcWfoStatus),
        wfoWindowCount: readNumber(metrics?.rankIcWfoWindowCount),
        wfoFailedWindowRatio: failedRatio,
        wfoFailWindowRatioThreshold: failedRatio == null ? null : 0.3,
        wfoDirectionStable: whyNotTradable.includes('wfo_direction_or_net_not_stable') ? false : null,
        runtimeFeeVerified: readBool(metrics?.feeSnapshotVerifiedByRuntime),
        killTriggers: [] as string[],
        blockers: whyNotTradable,
      }
      return {
        ...line,
        killTriggers: buildKillTriggers(line),
      }
    })
}

function shouldRetire(line: ResearchLineRetirementCandidate): boolean {
  return line.killTriggers.some(trigger =>
    trigger.includes('wfo_failed_window_ratio') ||
    trigger.includes('wfo_direction_not_stable') ||
    trigger.includes('net_after_route_cost_non_positive'),
  )
}

function buildKillTriggers(line: Pick<
  ResearchLineRetirementCandidate,
  'wfoWindowCount' | 'wfoFailedWindowRatio' | 'wfoFailWindowRatioThreshold' | 'wfoDirectionStable' | 'netAfterRouteCostPct' | 'blockers'
>): string[] {
  const triggers: string[] = []
  const enoughWfoWindows = (line.wfoWindowCount ?? 0) >= DEFAULT_MIN_WFO_WINDOWS
  if (
    enoughWfoWindows &&
    line.wfoFailedWindowRatio != null &&
    line.wfoFailWindowRatioThreshold != null &&
    line.wfoFailedWindowRatio > line.wfoFailWindowRatioThreshold
  ) {
    triggers.push(`wfo_failed_window_ratio:${formatMaybe(line.wfoFailedWindowRatio)}>${formatMaybe(line.wfoFailWindowRatioThreshold)}`)
  }
  if (enoughWfoWindows && line.wfoDirectionStable === false) {
    triggers.push('wfo_direction_not_stable')
  }
  if (
    line.netAfterRouteCostPct != null &&
    line.netAfterRouteCostPct <= 0 &&
    !line.blockers.some(blocker => blocker.includes('insufficient_data'))
  ) {
    triggers.push(`net_after_route_cost_non_positive:${formatMaybe(line.netAfterRouteCostPct)}`)
  }
  return uniqueStrings([
    ...triggers,
    ...line.blockers.filter(blocker =>
      blocker.includes('wfo_failed_window_ratio') ||
      blocker.includes('wfo_direction_or_net_not_stable'),
    ),
  ])
}

function chooseVerdict(input: {
  activeIncubationCount: number
  retiredLines: ResearchLineRetirementCandidate[]
  lines: ResearchLineRetirementCandidate[]
  incubation: Record<string, unknown> | null
}): ResearchLineRetirementVerdict {
  const lineHealth = readString(asRecord(input.incubation?.lineDecision)?.lineHealth)
  if (input.retiredLines.length > 0 && input.activeIncubationCount === 0) return 'retire_current_line'
  if (input.activeIncubationCount === 0) return 'no_active_line'
  if (lineHealth === 'incubate') return 'keep_incubating'
  if (input.lines.length === 0) return 'insufficient_evidence'
  return input.retiredLines.length > 0 ? 'retire_current_line' : 'insufficient_evidence'
}

function buildNextActions(input: {
  verdict: ResearchLineRetirementVerdict
  primaryLine: ResearchLineRetirementCandidate | null
  earliestNextLabelDueTime: string | null
}): string[] {
  if (input.verdict === 'retire_current_line') {
    return [
      `Retire the current research line ${input.primaryLine?.candidateId ?? 'unknown'} from active incubation until reactivation requirements are met.`,
      'Stop broad parameter expansion on the same RankIC/liquidity-conditioned reversal line; require a new hypothesis or materially different feature/data set.',
      input.earliestNextLabelDueTime
        ? `Settle already-open prospective observations after ${input.earliestNextLabelDueTime}; do not use open labels as promotion evidence.`
        : 'Settle any already-open prospective observations only after label due time.',
      'Shift next research effort to regime segmentation or a different alpha hypothesis with a pre-registered kill rule.',
    ]
  }
  if (input.verdict === 'no_active_line') {
    return [
      'No active line is currently available; keep OKX data and prospective ledgers fresh while selecting a new hypothesis.',
      'Do not restart random search from retired diagnostics without a new falsifiable market-structure reason.',
    ]
  }
  if (input.verdict === 'keep_incubating') {
    return [
      `Keep incubating ${input.primaryLine?.candidateId ?? 'the active candidate'} in live-only observation mode.`,
      'Do not enable paper/live until WFO, FDR, PIT, prospective labels, and paper execution evidence pass.',
    ]
  }
  return [
    'Regenerate research incubation, candidate summary, factor diagnostics, and prospective status before making a line decision.',
  ]
}

function compareLines(left: ResearchLineRetirementCandidate, right: ResearchLineRetirementCandidate): number {
  return retirementRank(right) - retirementRank(left) ||
    (right.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) -
      (left.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) ||
    left.candidateId.localeCompare(right.candidateId)
}

function retirementRank(line: ResearchLineRetirementCandidate): number {
  let score = 0
  if (shouldRetire(line)) score += 100
  if (line.status === 'rejected') score += 20
  if (line.status === 'active') score += 10
  if (line.runtimeFeeVerified === true) score += 5
  score += Math.min(10, Math.max(0, line.killTriggers.length * 2))
  return score
}

async function readJsonIfExists(path: string): Promise<unknown> {
  const resolved = resolve(path)
  if (!existsSync(resolved)) return null
  return JSON.parse(await readFile(resolved, 'utf-8'))
}

function readRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => item != null)
    : []
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
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(value => value.trim().length > 0)))
}

function parseRatioFromTriggers(triggers: string[]): number | null {
  for (const trigger of triggers) {
    const match = trigger.match(/wfo_failed_window_ratio:([0-9.]+)>/)
    if (match?.[1]) return Number(match[1])
  }
  return null
}

function parseThresholdFromTriggers(triggers: string[]): number | null {
  for (const trigger of triggers) {
    const match = trigger.match(/wfo_failed_window_ratio:[0-9.]+>([0-9.]+)/)
    if (match?.[1]) return Number(match[1])
  }
  return null
}

function inferFamily(candidateId: string, sourcePath: string): string | null {
  if (candidateId.includes('rank_ic') || sourcePath.includes('rank_ic')) return 'rank_ic'
  if (candidateId.includes('liq_') || sourcePath.includes('liquidity_conditioned')) return 'liquidity_conditioned_factor'
  if (candidateId.includes('factor_') || sourcePath.includes('crypto_factor')) return 'crypto_factor_family'
  return null
}

function sanitizeLineId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96) || 'research_line'
}

function earliestIsoString(values: Array<string | null>): string | null {
  const valid = values
    .filter((value): value is string => value != null)
    .map(value => ({ value, time: Date.parse(value) }))
    .filter(item => Number.isFinite(item.time))
    .sort((left, right) => left.time - right.time)
  return valid[0]?.value ?? null
}

function formatMaybe(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'null'
  return Number(value.toFixed(6)).toString()
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const tokens = argv.filter(token => token !== '--')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token?.startsWith('--')) continue
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
  return !normalized || normalized === 'null' || normalized === 'false' || normalized === 'none'
    ? null
    : raw
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function renderConsoleSummary(report: ResearchLineRetirementReport): string {
  return [
    `research line retirement: verdict=${report.verdict}, lineHealth=${report.lineHealth}`,
    `reviewed=${report.summary.diagnosticLinesReviewed}, retired=${report.summary.retirementRecommendedLines}, active=${report.summary.activeIncubationCandidates}`,
    `primary=${report.primaryLine?.candidateId ?? 'none'}`,
    `blockers=${report.blockers.slice(0, 12).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseResearchLineRetirementArgs(process.argv.slice(2))
  runResearchLineRetirement(args)
    .then(report => {
      if (args.json) console.log(JSON.stringify(report, null, 2))
      else console.log(renderConsoleSummary(report))
    })
    .catch(error => {
      console.error('build_research_line_retirement failed:', error)
      process.exit(1)
    })
}
