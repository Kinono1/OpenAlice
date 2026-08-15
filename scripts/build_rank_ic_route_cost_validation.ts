import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

interface CliArgs {
  rankIcReportPath: string
  routeCostBudgetPath: string
  feeSnapshotPath: string
  bestConfigPath: string
  outputPath: string | null
  asOf: string | null
  json: boolean
}

interface RankIcCandidateSummary {
  candidateId: string
  factor: string
  barMinutes: number | null
  nonHourlyDiagnosticOnly: boolean
  lookbackHours: number | null
  secondaryLookbackHours: number | null
  forwardHours: number | null
  mtfWeight: number | null
  observations: number | null
  periods: number | null
  signalPeriods: number | null
  commonPeriods: number | null
  meanIc: number | null
  icIr: number | null
  wfoStatus: string | null
  averageLongShortSpreadPct: number | null
  selectionSource: 'best_config_match' | 'rank_ic_economic_best' | 'rank_ic_best'
}

interface RouteCostValidationRow {
  route: string
  totalExpectedCostBpsPerLegRoundTrip: number
  pairRoundTripCostBps: number
  pairRoundTripCostPct: number
  maxAllowedCostBpsPerLeg: number | null
  breakEvenEdgeBpsPerLeg: number | null
  grossLongShortSpreadPct: number | null
  netAfterRouteCostPct: number | null
  grossToPairCostRatio: number | null
  routeBudgetExceeded: boolean
  positiveAfterCost: boolean
  diagnosticEligible: boolean
  blockers: string[]
}

export interface RankIcRouteCostValidationReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  rankIcReportPath: string
  routeCostBudgetPath: string
  feeSnapshotPath: string
  bestConfigPath: string
  candidate: RankIcCandidateSummary | null
  feeSnapshot: {
    source: string | null
    verifiedByRuntime: boolean | null
    sourceFetchedAt: string | null
    expiresAt: string | null
    stale: boolean
    makerFeeBps: number | null
    takerFeeBps: number | null
  } | null
  routeCostValidationStatus:
    | 'positive_after_cost_diagnostic'
    | 'negative_after_cost'
    | 'insufficient_data'
    | 'invalid_inputs'
  routes: RouteCostValidationRow[]
  bestDiagnosticRoute: RouteCostValidationRow | null
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_RANK_IC_REPORT_PATH = 'data/research/cross_sectional_rank_ic.latest.json'
const DEFAULT_ROUTE_COST_BUDGET_PATH = 'data/runtime/route_cost_budget.latest.json'
const DEFAULT_FEE_SNAPSHOT_PATH = 'data/runtime/fee_snapshot.latest.json'
const DEFAULT_BEST_CONFIG_PATH = 'data/research/best_config.json'
const DEFAULT_OUTPUT_PATH = 'data/research/rank_ic_route_cost_validation.latest.json'

async function main(): Promise<void> {
  const args = parseRankIcRouteCostValidationArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runRankIcRouteCostValidation(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'rank_ic_route_cost_validation',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.routeCostValidationStatus === 'positive_after_cost_diagnostic' ? 'warn' : 'fail',
      recordsIn: report.candidate ? 1 : 0,
      recordsOut: report.routes.length,
      errorClass: report.blockers.length > 0 ? report.blockers[0] ?? 'rank_ic_route_cost_blocked' : null,
    })
  }
}

export function parseRankIcRouteCostValidationArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    rankIcReportPath: raw.get('rankIcReportPath') ?? raw.get('rankIc') ?? DEFAULT_RANK_IC_REPORT_PATH,
    routeCostBudgetPath: raw.get('routeCostBudgetPath') ?? raw.get('routeCostBudget') ?? DEFAULT_ROUTE_COST_BUDGET_PATH,
    feeSnapshotPath: raw.get('feeSnapshotPath') ?? raw.get('feeSnapshot') ?? DEFAULT_FEE_SNAPSHOT_PATH,
    bestConfigPath: raw.get('bestConfigPath') ?? raw.get('bestConfig') ?? DEFAULT_BEST_CONFIG_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    asOf: raw.get('asOf') ?? null,
    json: parseBool(raw.get('json'), false),
  }
}

export async function runRankIcRouteCostValidation(
  args: CliArgs,
): Promise<RankIcRouteCostValidationReport> {
  const rankIcReportPath = resolve(args.rankIcReportPath)
  const routeCostBudgetPath = resolve(args.routeCostBudgetPath)
  const feeSnapshotPath = resolve(args.feeSnapshotPath)
  const bestConfigPath = resolve(args.bestConfigPath)
  const report = buildRankIcRouteCostValidationReport({
    rankIcReportPath,
    rankIcReport: await readJsonIfExists(rankIcReportPath),
    routeCostBudgetPath,
    routeCostBudget: await readJsonIfExists(routeCostBudgetPath),
    feeSnapshotPath,
    feeSnapshot: await readJsonIfExists(feeSnapshotPath),
    bestConfigPath,
    bestConfig: await readJsonIfExists(bestConfigPath),
    generatedAt: new Date().toISOString(),
    asOf: args.asOf,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildRankIcRouteCostValidationReport(input: {
  rankIcReportPath: string
  rankIcReport: unknown
  routeCostBudgetPath: string
  routeCostBudget: unknown
  feeSnapshotPath: string
  feeSnapshot: unknown
  bestConfigPath?: string
  bestConfig?: unknown
  generatedAt?: string
  asOf?: string | null
}): RankIcRouteCostValidationReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const asOf = input.asOf ?? generatedAt
  const rankIcRoot = asRecord(input.rankIcReport)
  const routeBudgetRoot = asRecord(input.routeCostBudget)
  const feeSnapshotRoot = asRecord(input.feeSnapshot) ?? asRecord(routeBudgetRoot?.feeSnapshot)
  const bestConfigRoot = asRecord(input.bestConfig)
  const candidate = extractRankIcCandidate(rankIcRoot, extractPreferredConfig(bestConfigRoot))
  const feeSnapshot = extractFeeSnapshot(feeSnapshotRoot, asOf)
  const blockers: string[] = []

  if (!rankIcRoot) blockers.push('rank_ic_report_missing_or_invalid')
  if (!candidate) blockers.push('rank_ic_best_candidate_missing')
  if (candidate?.nonHourlyDiagnosticOnly) blockers.push('non_hourly_rank_ic_cadence_research_only')
  if ((candidate?.commonPeriods ?? 0) < 1_000) blockers.push(`rank_ic_common_periods_low:${candidate?.commonPeriods ?? 0}<1000`)
  if ((candidate?.periods ?? 0) < 30) blockers.push(`rank_ic_periods_low:${candidate?.periods ?? 0}<30`)
  if ((candidate?.signalPeriods ?? 0) < 30) blockers.push(`rank_ic_signal_periods_low:${candidate?.signalPeriods ?? 0}<30`)
  if (candidate?.wfoStatus !== 'pass') blockers.push(`rank_ic_wfo_status:${candidate?.wfoStatus ?? 'missing'}`)
  if (!routeBudgetRoot) blockers.push('route_cost_budget_missing_or_invalid')
  if (!feeSnapshot) blockers.push('fee_snapshot_missing_or_invalid')
  if (feeSnapshot?.stale) blockers.push('fee_snapshot_stale')
  if (feeSnapshot?.source === 'manual_override') blockers.push('fee_snapshot_manual_override')
  if (feeSnapshot?.verifiedByRuntime !== true) blockers.push('fee_snapshot_not_runtime_verified')

  const routes = buildRouteRows(routeBudgetRoot, candidate)
  if (routes.length === 0) blockers.push('route_cost_routes_missing')
  const bestDiagnosticRoute = routes
    .filter(route => route.netAfterRouteCostPct != null)
    .sort((left, right) =>
      Number(right.positiveAfterCost) - Number(left.positiveAfterCost) ||
      Number(left.routeBudgetExceeded) - Number(right.routeBudgetExceeded) ||
      (right.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) - (left.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY),
    )[0] ?? null

  const hasInvalidInputs = blockers.some(blocker =>
    blocker.includes('missing_or_invalid') ||
    blocker === 'route_cost_routes_missing' ||
    blocker === 'rank_ic_best_candidate_missing',
  )
  const hasInsufficientData = blockers.some(blocker =>
    blocker.includes('_low:') ||
    blocker.startsWith('rank_ic_wfo_status:'),
  )
  const anyPositive = routes.some(route => route.positiveAfterCost)
  const routeCostValidationStatus = hasInvalidInputs
    ? 'invalid_inputs'
    : hasInsufficientData
      ? 'insufficient_data'
      : anyPositive
        ? 'positive_after_cost_diagnostic'
        : 'negative_after_cost'

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    rankIcReportPath: resolve(input.rankIcReportPath),
    routeCostBudgetPath: resolve(input.routeCostBudgetPath),
    feeSnapshotPath: resolve(input.feeSnapshotPath),
    bestConfigPath: input.bestConfigPath ? resolve(input.bestConfigPath) : '',
    candidate,
    feeSnapshot,
    routeCostValidationStatus,
    routes,
    bestDiagnosticRoute,
    blockers: uniqueStrings([
      ...blockers,
      ...routes.flatMap(route => route.blockers),
      'not_promotion_grade_route_cost_validated',
      'not_trial_ledger_fdr_validated',
      'not_paper_execution_evidence',
    ]),
    nextActions: buildNextActions(routeCostValidationStatus, bestDiagnosticRoute),
    notes: [
      'This report is diagnostic-only and cannot authorize paper or live execution.',
      'RankIC averageLongShortSpreadPct is treated as gross long-short spread before pair route cost.',
      'Pair route cost is modeled as two single-leg round trips: long leg plus short leg.',
      'Manual or stale fee snapshots keep the result out of promotion even when netAfterRouteCostPct is positive.',
      ...(candidate?.nonHourlyDiagnosticOnly
        ? ['Non-1h RankIC cadence is research-only acceleration and cannot satisfy 1h promotion requirements.']
        : []),
    ],
  }
}

function extractRankIcCandidate(
  root: Record<string, unknown> | null,
  preferredConfig: PreferredRankIcConfig | null,
): RankIcCandidateSummary | null {
  const rankIcBest = asRecord(root?.best)
  if (!rankIcBest) return null
  const topConfigs = Array.isArray(root?.topConfigs) ? root.topConfigs.map(asRecord).filter(isRecordValue) : []
  const preferred = preferredConfig
    ? topConfigs.find(candidate => rankIcConfigMatchesPreferred(candidate, preferredConfig))
    : null
  const economicBest = preferred ? null : selectBestEconomicRankIcCandidate(topConfigs)
  const best = preferred ?? economicBest ?? rankIcBest
  const wfo = asRecord(root?.wfo)
  const factor = readString(best.factor) ?? 'unknown_factor'
  const dataCadence = asRecord(root?.dataCadence)
  const barMinutes = readNumber(dataCadence?.barMinutes)
  const nonHourlyDiagnosticOnly = readBool(dataCadence?.nonHourlyDiagnosticOnly) === true ||
    (barMinutes != null && barMinutes !== 60)
  const lookbackHours = readNumber(best.lookbackHours)
  const secondaryLookbackHours = readNumber(best.secondaryLookbackHours)
  const forwardHours = readNumber(best.forwardHours)
  const mtfWeight = readNumber(best.mtfWeight)
  return {
    candidateId: [
      `rank_ic_${factor}_best`,
      `lb${lookbackHours ?? 'na'}`,
      `sec${secondaryLookbackHours ?? 'na'}`,
      `fwd${forwardHours ?? 'na'}`,
      `mtf${mtfWeight ?? 'na'}`,
    ].join('_'),
    factor,
    barMinutes,
    nonHourlyDiagnosticOnly,
    lookbackHours,
    secondaryLookbackHours,
    forwardHours,
    mtfWeight,
    observations: readNumber(best.observations),
    periods: readNumber(best.periods),
    signalPeriods: readNumber(best.signalPeriods),
    commonPeriods: readNumber(root?.commonPeriods),
    meanIc: readNumber(best.meanIc),
    icIr: readNumber(best.icIr),
    wfoStatus: readString(wfo?.status),
    averageLongShortSpreadPct: readNumber(best.averageLongShortSpreadPct),
    selectionSource: preferred ? 'best_config_match' : economicBest ? 'rank_ic_economic_best' : 'rank_ic_best',
  }
}

function selectBestEconomicRankIcCandidate(topConfigs: Record<string, unknown>[]): Record<string, unknown> | null {
  return topConfigs
    .filter(candidate => readBool(candidate.passed) === true)
    .filter(candidate => readNumber(candidate.averageLongShortSpreadPct) != null)
    .sort((left, right) =>
      (readNumber(right.averageLongShortSpreadPct) ?? Number.NEGATIVE_INFINITY) -
        (readNumber(left.averageLongShortSpreadPct) ?? Number.NEGATIVE_INFINITY) ||
      (readNumber(right.meanIc) ?? Number.NEGATIVE_INFINITY) - (readNumber(left.meanIc) ?? Number.NEGATIVE_INFINITY) ||
      (readNumber(right.icIr) ?? Number.NEGATIVE_INFINITY) - (readNumber(left.icIr) ?? Number.NEGATIVE_INFINITY) ||
      (readNumber(right.observations) ?? 0) - (readNumber(left.observations) ?? 0),
    )[0] ?? null
}

function extractFeeSnapshot(
  root: Record<string, unknown> | null,
  asOf: string,
): RankIcRouteCostValidationReport['feeSnapshot'] {
  if (!root) return null
  const expiresAt = readString(root.expiresAt)
  return {
    source: readString(root.source),
    verifiedByRuntime: readBool(root.verifiedByRuntime),
    sourceFetchedAt: readString(root.sourceFetchedAt),
    expiresAt,
    stale: expiresAt != null && Date.parse(expiresAt) <= Date.parse(asOf),
    makerFeeBps: readNumber(root.makerFeeBps),
    takerFeeBps: readNumber(root.takerFeeBps),
  }
}

interface PreferredRankIcConfig {
  lookbackHours: number | null
  secondaryLookbackHours: number | null
  forwardHours: number | null
  mtfWeight: number | null
}

function extractPreferredConfig(root: Record<string, unknown> | null): PreferredRankIcConfig | null {
  if (
    readString(root?.status) === 'no_passing_config' ||
    root?.selectedConfig === false ||
    root?.config === null
  ) {
    return null
  }
  const config = asRecord(root?.config) ?? asRecord(root?.bestConfig)
  if (!config) return null
  return {
    lookbackHours: readNumber(config.lookbackHours),
    secondaryLookbackHours: readNumber(config.secondaryLookbackHours ?? config.secondaryLookback),
    forwardHours: readNumber(config.forwardHours),
    mtfWeight: readNumber(config.mtfWeight),
  }
}

function rankIcConfigMatchesPreferred(
  candidate: Record<string, unknown>,
  preferred: PreferredRankIcConfig,
): boolean {
  return numbersMatch(readNumber(candidate.lookbackHours), preferred.lookbackHours) &&
    numbersMatch(readNumber(candidate.secondaryLookbackHours), preferred.secondaryLookbackHours) &&
    numbersMatch(readNumber(candidate.forwardHours), preferred.forwardHours) &&
    numbersMatch(readNumber(candidate.mtfWeight), preferred.mtfWeight)
}

function numbersMatch(left: number | null, right: number | null): boolean {
  return left != null && right != null && Math.abs(left - right) <= 1e-9
}

function buildRouteRows(
  root: Record<string, unknown> | null,
  candidate: RankIcCandidateSummary | null,
): RouteCostValidationRow[] {
  const routes = asRecord(root?.routes)
  if (!routes) return []
  return Object.entries(routes).flatMap(([routeName, raw]) => {
    const route = asRecord(raw)
    if (!route) return []
    const totalExpectedCostBps = readNumber(route.totalExpectedCostBps)
    if (totalExpectedCostBps == null) return []
    const maxAllowedCostBps = readNumber(route.maxAllowedCostBps)
    const breakEvenEdgeBps = readNumber(route.breakEvenEdgeBps)
    const pairRoundTripCostBps = totalExpectedCostBps * 2
    const pairRoundTripCostPct = pairRoundTripCostBps / 100
    const grossLongShortSpreadPct = candidate?.averageLongShortSpreadPct ?? null
    const netAfterRouteCostPct = grossLongShortSpreadPct == null
      ? null
      : round(grossLongShortSpreadPct - pairRoundTripCostPct, 6)
    const grossToPairCostRatio = grossLongShortSpreadPct == null || pairRoundTripCostPct <= 0
      ? null
      : round(grossLongShortSpreadPct / pairRoundTripCostPct, 6)
    const routeBudgetExceeded = maxAllowedCostBps != null && totalExpectedCostBps > maxAllowedCostBps
    const positiveAfterCost = (netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) > 0
    const blockers: string[] = []
    if (routeBudgetExceeded) blockers.push(`route_cost_budget_exceeded:${routeName}`)
    if (!positiveAfterCost) blockers.push(`route_net_edge_non_positive:${routeName}`)
    return {
      route: routeName,
      totalExpectedCostBpsPerLegRoundTrip: totalExpectedCostBps,
      pairRoundTripCostBps: round(pairRoundTripCostBps, 6),
      pairRoundTripCostPct: round(pairRoundTripCostPct, 6),
      maxAllowedCostBpsPerLeg: maxAllowedCostBps,
      breakEvenEdgeBpsPerLeg: breakEvenEdgeBps,
      grossLongShortSpreadPct,
      netAfterRouteCostPct,
      grossToPairCostRatio,
      routeBudgetExceeded,
      positiveAfterCost,
      diagnosticEligible: positiveAfterCost && !routeBudgetExceeded,
      blockers,
    }
  })
}

function buildNextActions(
  status: RankIcRouteCostValidationReport['routeCostValidationStatus'],
  bestRoute: RouteCostValidationRow | null,
): string[] {
  const actions = [
    'Keep paper/live disabled; this artifact is route-cost diagnostic only.',
    'Replace manual/stale fee snapshot with runtime-verified maker/taker and spread evidence before using route-cost economics for promotion.',
    'Collect enough future RankIC signal periods and write all registered trials into the trial ledger before BY FDR.',
  ]
  if (bestRoute) {
    actions.unshift(
      `Current cheapest useful route candidate is ${bestRoute.route}: netAfterRouteCostPct=${formatMaybe(bestRoute.netAfterRouteCostPct)}, grossToPairCostRatio=${formatMaybe(bestRoute.grossToPairCostRatio)}.`,
    )
  }
  if (status === 'negative_after_cost') {
    actions.push('Kill or reduce turnover for this candidate unless a runtime route can make netAfterRouteCostPct positive.')
  }
  return actions
}

async function readJsonIfExists(path: string): Promise<unknown> {
  if (!existsSync(path)) return null
  return JSON.parse(await readFile(path, 'utf-8'))
}

function renderConsoleSummary(report: RankIcRouteCostValidationReport): string {
  const lines = [
    `rank-ic route-cost validation: status=${report.routeCostValidationStatus}, paper=${report.paperTradingAllowed}, live=${report.liveTradingAllowed}`,
    `candidate=${report.candidate?.candidateId ?? 'none'}, gross=${formatMaybe(report.candidate?.averageLongShortSpreadPct ?? null)}, wfo=${report.candidate?.wfoStatus ?? 'missing'}`,
    `bestRoute=${report.bestDiagnosticRoute?.route ?? 'none'}, net=${formatMaybe(report.bestDiagnosticRoute?.netAfterRouteCostPct ?? null)}`,
    `blockers=${report.blockers.slice(0, 12).join('|')}`,
  ]
  return lines.join('\n')
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isRecordValue(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value != null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function formatMaybe(value: number | null): string {
  return value == null ? 'null' : String(round(value, 6))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_rank_ic_route_cost_validation failed:', error)
    process.exit(1)
  })
}
