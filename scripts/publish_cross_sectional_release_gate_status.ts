import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ReleaseGateCheck, ReleaseGateResult } from '../src/backtest/release_gate.js'
import { writeReleaseGateStatus } from '../src/runtime/release_gate_status.js'

interface CliArgs {
  rankIcReportPath: string
  routeCostValidationPath: string
  bestConfigPath: string
  outputPath: string | null
  selectedRoute: string
  expiresInHours: number
  json: boolean
}

interface PublishCrossSectionalReleaseGateResult {
  releaseGate: ReleaseGateResult
  reasonCodes: string[]
  sourceReportPath: string
  expiresAt: string
}

const DEFAULT_RANK_IC_REPORT_PATH = 'data/research/cross_sectional_rank_ic.live_accumulated_fwd24.latest.json'
const DEFAULT_ROUTE_COST_VALIDATION_PATH = 'data/research/rank_ic_route_cost_validation.live_accumulated_fwd24.latest.json'
const DEFAULT_BEST_CONFIG_PATH = 'data/research/best_config.json'
const DEFAULT_OUTPUT_PATH = 'data/runtime/release_gate_status.json'
const DEFAULT_SELECTED_ROUTE = 'passive_passive'
const DEFAULT_EXPIRES_IN_HOURS = 30

const PAPER_BLOCKING_CHECKS: ReleaseGateCheck['name'][] = [
  'wfo',
  'significance',
  'risk_simulation',
  'economics',
  'strategy_plan_evidence',
]

const LIVE_BLOCKING_CHECKS: ReleaseGateCheck['name'][] = [
  ...PAPER_BLOCKING_CHECKS,
  'execution_quality',
  'ramp_up',
  'regime_shift',
]

const REQUIRED_LIVE_CHECKS: ReleaseGateCheck['name'][] = [
  'execution_quality',
  'ramp_up',
  'regime_shift',
]

async function main(): Promise<void> {
  const args = parseCrossSectionalReleaseGateArgs(process.argv.slice(2))
  const result = buildCrossSectionalReleaseGateStatus({
    rankIcReportPath: resolve(args.rankIcReportPath),
    rankIcReport: await readJsonIfExists(args.rankIcReportPath),
    routeCostValidationPath: resolve(args.routeCostValidationPath),
    routeCostValidation: await readJsonIfExists(args.routeCostValidationPath),
    bestConfigPath: resolve(args.bestConfigPath),
    bestConfig: await readJsonIfExists(args.bestConfigPath),
    selectedRoute: args.selectedRoute,
    generatedAt: new Date().toISOString(),
    expiresInHours: args.expiresInHours,
  })

  if (args.outputPath) {
    await writeReleaseGateStatus(result.releaseGate, {
      filePath: resolve(args.outputPath),
      sourceReportPath: result.sourceReportPath,
      expiresAt: result.expiresAt,
      allowTinyCapLiveTrading: false,
      result: result.releaseGate.allowPaperTrading ? 'GO' : 'NO_GO',
      reasonCodes: result.reasonCodes,
      checks: result.releaseGate.checks,
    })
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(renderConsoleSummary(result))
  }
}

export function parseCrossSectionalReleaseGateArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    rankIcReportPath: raw.get('rankIcReportPath') ?? raw.get('rankIc') ?? DEFAULT_RANK_IC_REPORT_PATH,
    routeCostValidationPath: raw.get('routeCostValidationPath') ??
      raw.get('routeCost') ??
      DEFAULT_ROUTE_COST_VALIDATION_PATH,
    bestConfigPath: raw.get('bestConfigPath') ?? raw.get('bestConfig') ?? DEFAULT_BEST_CONFIG_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    selectedRoute: raw.get('selectedRoute') ?? raw.get('route') ?? DEFAULT_SELECTED_ROUTE,
    expiresInHours: parsePositiveNumber(raw.get('expiresInHours'), DEFAULT_EXPIRES_IN_HOURS, 'expiresInHours'),
    json: parseBool(raw.get('json'), false),
  }
}

export function buildCrossSectionalReleaseGateStatus(input: {
  rankIcReportPath: string
  rankIcReport: unknown
  routeCostValidationPath: string
  routeCostValidation: unknown
  bestConfigPath: string
  bestConfig: unknown
  selectedRoute?: string
  generatedAt?: string
  expiresInHours?: number
}): PublishCrossSectionalReleaseGateResult {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const expiresInHours = input.expiresInHours ?? DEFAULT_EXPIRES_IN_HOURS
  const rankIcRoot = asRecord(input.rankIcReport)
  const routeCostRoot = asRecord(input.routeCostValidation)
  const bestConfigRoot = asRecord(input.bestConfig)
  const selectedRoute = input.selectedRoute ?? DEFAULT_SELECTED_ROUTE

  const checks = [
    buildWfoCheck(rankIcRoot),
    buildSignificanceCheck(rankIcRoot),
    buildRiskSimulationCheck(),
    buildEconomicsCheck(routeCostRoot, selectedRoute),
    buildStrategyPlanEvidenceCheck(rankIcRoot, routeCostRoot, bestConfigRoot, selectedRoute),
    skippedCheck('execution_quality', 'Execution quality evidence is not available for cross-sectional release publishing.'),
    skippedCheck('ramp_up', 'Ramp-up evidence is not available for cross-sectional release publishing.'),
    skippedCheck('regime_shift', 'Regime-shift evidence is not available for cross-sectional release publishing.'),
  ]
  const failedChecks = checks
    .filter(check => check.status === 'fail')
    .map(check => check.name)
  const warningChecks = checks
    .filter(check => check.status === 'warn')
    .map(check => check.name)
  const allowPaperTrading = !checks.some(
    check => PAPER_BLOCKING_CHECKS.includes(check.name) && check.status === 'fail',
  )
  const allowLiveTrading = allowPaperTrading &&
    !checks.some(check => LIVE_BLOCKING_CHECKS.includes(check.name) && check.status === 'fail') &&
    !checks.some(check => REQUIRED_LIVE_CHECKS.includes(check.name) && check.status === 'skipped')

  const gate: ReleaseGateResult = {
    checks,
    failedChecks,
    warningChecks,
    hardFail: failedChecks.length > 0,
    allowPaperTrading,
    allowLiveTrading,
  }

  return {
    releaseGate: gate,
    reasonCodes: buildReasonCodes({
      checks,
      rankIcRoot,
      routeCostRoot,
      bestConfigRoot,
      selectedRoute,
    }),
    sourceReportPath: resolve(input.rankIcReportPath),
    expiresAt: new Date(Date.parse(generatedAt) + expiresInHours * 60 * 60 * 1000).toISOString(),
  }
}

function buildWfoCheck(rankIcRoot: Record<string, unknown> | null): ReleaseGateCheck {
  const wfo = asRecord(rankIcRoot?.wfo)
  const best = asRecord(rankIcRoot?.best)
  const testedConfig = asRecord(wfo?.testedConfig) ?? best
  const status = readString(wfo?.status)
  const blockers = readStringArray(wfo?.blockers)
  const passed = status === 'pass' && blockers.length === 0

  if (!rankIcRoot || !wfo) {
    return {
      name: 'wfo',
      status: 'fail',
      summary: 'Cross-sectional RankIC WFO evidence is missing; failing release gate closed.',
      metrics: {
        evidenceSource: 'cross_sectional_rank_ic',
        status: 'missing',
      },
    }
  }

  return {
    name: 'wfo',
    status: passed ? 'pass' : 'fail',
    summary: passed
      ? 'Cross-sectional RankIC WFO gate passed.'
      : 'Cross-sectional RankIC WFO gate failed or is not promotion grade.',
    metrics: {
      evidenceSource: 'cross_sectional_rank_ic',
      reportGeneratedAt: readString(rankIcRoot.generatedAt),
      dataDir: readString(rankIcRoot.dataDir),
      status,
      blockers: blockers.join(',') || null,
      commonPeriods: readNumber(rankIcRoot.commonPeriods),
      configsEvaluated: readNumber(rankIcRoot.configsEvaluated),
      factor: readString(testedConfig?.factor),
      lookbackHours: readNumber(testedConfig?.lookbackHours),
      secondaryLookbackHours: readNumber(testedConfig?.secondaryLookbackHours),
      forwardHours: readNumber(testedConfig?.forwardHours),
      mtfWeight: readNumber(testedConfig?.mtfWeight),
      meanIc: readNumber(testedConfig?.meanIc),
      icIr: readNumber(testedConfig?.icIr),
      periods: readNumber(testedConfig?.periods),
      signalPeriods: readNumber(testedConfig?.signalPeriods),
      averageLongShortSpreadPct: readNumber(testedConfig?.averageLongShortSpreadPct),
      windowCount: readNumber(wfo.windowCount),
      passedWindows: readNumber(wfo.passedWindows),
      failedWindows: readNumber(wfo.failedWindows),
      failedWindowRatio: readNumber(wfo.failedWindowRatio),
      failWindowRatioThreshold: readNumber(wfo.failWindowRatioThreshold),
      directionStable: readBool(wfo.directionStable),
    },
  }
}

function buildSignificanceCheck(rankIcRoot: Record<string, unknown> | null): ReleaseGateCheck {
  const topConfigs = Array.isArray(rankIcRoot?.topConfigs) ? rankIcRoot.topConfigs.length : 0
  const best = asRecord(rankIcRoot?.best)
  const wfo = asRecord(rankIcRoot?.wfo)

  return {
    name: 'significance',
    status: 'fail',
    summary: 'Cross-sectional strategy lacks promotion-grade PBO/DSR/BY-FDR and complete trial-ledger evidence.',
    metrics: {
      evidenceSource: 'cross_sectional_rank_ic',
      pboStatus: 'indeterminate',
      dsrStatus: 'missing',
      fdrStatus: 'missing',
      trialLedgerStatus: 'fail',
      trialLedgerBlocks: 'trial_ledger_missing,cross_sectional_trial_ledger_missing',
      candidateTrialCount: topConfigs,
      candidateCount: topConfigs,
      meanIc: readNumber(best?.meanIc),
      icIr: readNumber(best?.icIr),
      wfoStatus: readString(wfo?.status),
    },
  }
}

function buildRiskSimulationCheck(): ReleaseGateCheck {
  return {
    name: 'risk_simulation',
    status: 'fail',
    summary: 'Cross-sectional release publishing has no promotion-grade risk simulation bound to the selected strategy.',
    metrics: {
      evidenceSource: 'cross_sectional_release_gate',
      riskSimulationStatus: 'missing',
    },
  }
}

function buildEconomicsCheck(
  routeCostRoot: Record<string, unknown> | null,
  selectedRoute: string,
): ReleaseGateCheck {
  const route = selectRoute(routeCostRoot, selectedRoute)
  const feeSnapshot = asRecord(routeCostRoot?.feeSnapshot)
  const blockers = [
    ...readStringArray(routeCostRoot?.blockers),
    ...readStringArray(route?.blockers),
  ]
  const routeStatus = readString(routeCostRoot?.routeCostValidationStatus)
  const netAfterRouteCostPct = readNumber(route?.netAfterRouteCostPct)
  const grossLongShortSpreadPct = readNumber(route?.grossLongShortSpreadPct)
  const pairRoundTripCostPct = readNumber(route?.pairRoundTripCostPct)
  const routeBudgetExceeded = readBool(route?.routeBudgetExceeded) === true
  const positiveAfterCost = readBool(route?.positiveAfterCost) === true && (netAfterRouteCostPct ?? 0) > 0
  const runtimeVerifiedFees = readBool(feeSnapshot?.verifiedByRuntime) === true
  const staleFees = readBool(feeSnapshot?.stale) === true
  const manualFees = readString(feeSnapshot?.source) === 'manual_override'
  const failed = !route ||
    !positiveAfterCost ||
    routeBudgetExceeded ||
    !runtimeVerifiedFees ||
    staleFees ||
    manualFees ||
    routeStatus !== 'positive_after_cost_diagnostic'

  return {
    name: 'economics',
    status: failed ? 'fail' : 'pass',
    summary: failed
      ? 'Route-cost-adjusted cross-sectional economics are not promotion grade.'
      : 'Route-cost-adjusted cross-sectional economics are positive with runtime-verified fees.',
    metrics: {
      evidenceSource: 'rank_ic_route_cost_validation',
      routeCostValidationStatus: routeStatus,
      selectedRoute,
      routeFound: route != null,
      blockers: blockers.join(',') || null,
      grossExpectancyPct: grossLongShortSpreadPct,
      netExpectancyPct: netAfterRouteCostPct,
      feeExpectancyDragPct: pairRoundTripCostPct,
      slippageExpectancyDragPct: 0,
      fundingExpectancyDragPct: 0,
      totalExpectancyDragPct: pairRoundTripCostPct,
      routeBudgetExceeded,
      positiveAfterCost,
      grossToPairCostRatio: readNumber(route?.grossToPairCostRatio),
      pairRoundTripCostPct,
      pairRoundTripCostBps: readNumber(route?.pairRoundTripCostBps),
      totalExpectedCostBpsPerLegRoundTrip: readNumber(route?.totalExpectedCostBpsPerLegRoundTrip),
      maxAllowedCostBpsPerLeg: readNumber(route?.maxAllowedCostBpsPerLeg),
      feeSnapshotSource: readString(feeSnapshot?.source),
      feeSnapshotVerifiedByRuntime: readBool(feeSnapshot?.verifiedByRuntime),
      feeSnapshotStale: readBool(feeSnapshot?.stale),
      feeSnapshotExpiresAt: readString(feeSnapshot?.expiresAt),
    },
  }
}

function buildStrategyPlanEvidenceCheck(
  rankIcRoot: Record<string, unknown> | null,
  routeCostRoot: Record<string, unknown> | null,
  bestConfigRoot: Record<string, unknown> | null,
  selectedRoute: string,
): ReleaseGateCheck {
  const rankBest = asRecord(rankIcRoot?.best)
  const wfoTestedConfig = asRecord(asRecord(rankIcRoot?.wfo)?.testedConfig)
  const routeCandidate = asRecord(routeCostRoot?.candidate)
  const bestConfig = asRecord(bestConfigRoot?.config) ?? asRecord(bestConfigRoot?.bestConfig)
  const bestConfigStatus = readString(bestConfigRoot?.status)
  const noSelectedBestConfig = bestConfigStatus === 'no_passing_config' ||
    bestConfigRoot?.selectedConfig === false ||
    bestConfigRoot?.config === null
  const routeCandidateMismatches = compareStrategyConfig(bestConfig, routeCandidate)
  const dataModes = [
    readString(rankIcRoot?.dataDir)?.includes('live_accumulated') ? 'rank_ic_live_accumulated' : null,
    readString(routeCostRoot?.rankIcReportPath)?.includes('live_accumulated') ? 'route_cost_live_accumulated' : null,
  ].filter((value): value is string => value != null)
  const failures = [
    ...(!rankIcRoot ? ['rank_ic_report_missing'] : []),
    ...(!routeCostRoot ? ['route_cost_validation_missing'] : []),
    ...(!bestConfig || noSelectedBestConfig ? ['best_config_missing_or_no_passing_config'] : []),
    ...routeCandidateMismatches.map(item => `best_config_vs_route_candidate_${item}`),
  ]

  return {
    name: 'strategy_plan_evidence',
    status: failures.length > 0 ? 'fail' : 'warn',
    summary: failures.length > 0
      ? `Cross-sectional strategy evidence is not aligned: ${failures.join(', ')}.`
      : 'Cross-sectional strategy evidence is aligned but remains diagnostic-only.',
    metrics: {
      evidenceSource: 'cross_sectional_release_gate',
      selectedRoute,
      failureCount: failures.length,
      failures: failures.join(',') || null,
      bestConfigStatus,
      bestConfigSelected: bestConfigRoot?.selectedConfig === true,
      bestConfigNoPassingReason: readString(bestConfigRoot?.noPassingConfigReason),
      bestConfigHardGatePassedCount: readNumber(bestConfigRoot?.hardGatePassedCount),
      dataModes: dataModes.join(',') || null,
      bestConfigLookbackHours: readNumber(bestConfig?.lookbackHours),
      bestConfigSecondaryLookbackHours: readNumber(bestConfig?.secondaryLookbackHours ?? bestConfig?.secondaryLookback),
      bestConfigForwardHours: readNumber(bestConfig?.forwardHours),
      bestConfigMtfWeight: readNumber(bestConfig?.mtfWeight),
      rankIcLookbackHours: readNumber(rankBest?.lookbackHours),
      rankIcSecondaryLookbackHours: readNumber(rankBest?.secondaryLookbackHours),
      rankIcForwardHours: readNumber(rankBest?.forwardHours),
      rankIcMtfWeight: readNumber(rankBest?.mtfWeight),
      rankIcWfoSelectionSource: readString(asRecord(rankIcRoot?.wfo)?.selectionSource),
      rankIcWfoLookbackHours: readNumber(wfoTestedConfig?.lookbackHours),
      rankIcWfoSecondaryLookbackHours: readNumber(wfoTestedConfig?.secondaryLookbackHours),
      rankIcWfoForwardHours: readNumber(wfoTestedConfig?.forwardHours),
      rankIcWfoMtfWeight: readNumber(wfoTestedConfig?.mtfWeight),
      routeCandidateLookbackHours: readNumber(routeCandidate?.lookbackHours),
      routeCandidateSecondaryLookbackHours: readNumber(routeCandidate?.secondaryLookbackHours),
      routeCandidateForwardHours: readNumber(routeCandidate?.forwardHours),
      routeCandidateMtfWeight: readNumber(routeCandidate?.mtfWeight),
    },
  }
}

function compareStrategyConfig(
  expected: Record<string, unknown> | null,
  observed: Record<string, unknown> | null,
): string[] {
  if (!expected || !observed) return []
  const fields = [
    ['lookbackHours', readNumber(expected.lookbackHours), readNumber(observed.lookbackHours)],
    [
      'secondaryLookbackHours',
      readNumber(expected.secondaryLookbackHours ?? expected.secondaryLookback),
      readNumber(observed.secondaryLookbackHours),
    ],
    ['forwardHours', readNumber(expected.forwardHours), readNumber(observed.forwardHours)],
    ['mtfWeight', readNumber(expected.mtfWeight), readNumber(observed.mtfWeight)],
  ] as const
  return fields
    .filter(([, left, right]) => left != null && right != null && Math.abs(left - right) > 1e-9)
    .map(([field, left, right]) => `${field}_mismatch:${left}_vs_${right}`)
}

function skippedCheck(name: ReleaseGateCheck['name'], summary: string): ReleaseGateCheck {
  return {
    name,
    status: 'skipped',
    summary,
    metrics: {},
  }
}

function selectRoute(root: Record<string, unknown> | null, selectedRoute: string): Record<string, unknown> | null {
  const routes = Array.isArray(root?.routes) ? root.routes.map(asRecord).filter(isRecordValue) : []
  return routes.find(route => readString(route.route) === selectedRoute) ??
    asRecord(root?.bestDiagnosticRoute) ??
    null
}

function buildReasonCodes(input: {
  checks: ReleaseGateCheck[]
  rankIcRoot: Record<string, unknown> | null
  routeCostRoot: Record<string, unknown> | null
  bestConfigRoot: Record<string, unknown> | null
  selectedRoute: string
}): string[] {
  const codes = input.checks
    .filter(check => check.status === 'fail')
    .map(check => `release_gate_${check.name}_failed`)
  if (!input.rankIcRoot) codes.push('rank_ic_report_missing')
  if (!input.routeCostRoot) codes.push('route_cost_validation_missing')
  if (!input.bestConfigRoot) codes.push('best_config_missing')
  if (
    readString(input.bestConfigRoot?.status) === 'no_passing_config' ||
    input.bestConfigRoot?.selectedConfig === false ||
    input.bestConfigRoot?.config === null
  ) {
    codes.push('best_config_no_passing_config')
  }
  const route = selectRoute(input.routeCostRoot, input.selectedRoute)
  if (!route) codes.push(`route_missing:${input.selectedRoute}`)
  return uniqueStrings(codes)
}

async function readJsonIfExists(path: string): Promise<unknown> {
  const resolved = resolve(path)
  if (!existsSync(resolved)) return null
  return JSON.parse(await readFile(resolved, 'utf-8'))
}

function renderConsoleSummary(result: PublishCrossSectionalReleaseGateResult): string {
  const lines = [
    `cross-sectional release gate: paper=${result.releaseGate.allowPaperTrading}, live=${result.releaseGate.allowLiveTrading}, failed=${result.releaseGate.failedChecks.join('|') || 'none'}`,
    `warnings=${result.releaseGate.warningChecks.join('|') || 'none'}`,
    `reasonCodes=${result.reasonCodes.join('|') || 'none'}`,
    `expiresAt=${result.expiresAt}`,
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

function parsePositiveNumber(raw: string | undefined, fallback: number, fieldName: string): number {
  if (raw == null) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive number.`)
  }
  return parsed
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

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('publish_cross_sectional_release_gate_status failed:', error)
    process.exit(1)
  })
}
