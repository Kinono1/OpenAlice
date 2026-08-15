import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import {
  PROMOTION_V2_SCHEMA_VERSION,
  sha256Hex,
  type FeeSnapshot,
  type RouteBudget,
  type RouteCostBudget,
  type RouteName,
  type SchemaMeta,
} from '../src/runtime/promotion_v2.js'

type UnknownRecord = Record<string, unknown>
type RefreshStatus = 'ready_for_research' | 'blocked'

interface CliArgs {
  feeSnapshotPath: string
  outputPath: string | null
  statusPath: string | null
  estimatedRoundTripCostPct: number | null
  dryRun: boolean
  json: boolean
}

export interface RuntimeRouteCostBudgetRefreshReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: RefreshStatus
  dryRun: boolean
  sourceArtifacts: {
    feeSnapshotPath: string
    outputPath: string | null
    statusPath: string | null
  }
  feeSnapshot: {
    exists: boolean
    source: string | null
    verifiedByRuntime: boolean | null
    sourceFetchedAt: string | null
    expiresAt: string | null
    stale: boolean
    makerFeeBps: number | null
    takerFeeBps: number | null
    hashMatchesEmbeddedSnapshot: boolean | null
  }
  assumptions: {
    formulaSource: 'promotion_v2_runtime_bundle_equivalent'
    defaultEstimatedRoundTripCostBps: number
    estimatedRoundTripCostPct: number | null
    maxAllowedCostBps: number
  }
  routeSummary: {
    routeCount: number
    routesOverBudget: RouteName[]
    selectedSafeResearchRoute: RouteName | null
  }
  routeCostBudget: RouteCostBudget | null
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  outputHash: string | null
}

const DEFAULT_FEE_SNAPSHOT_PATH = 'data/runtime/fee_snapshot.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/runtime/route_cost_budget.latest.json'
const DEFAULT_STATUS_PATH = 'data/runtime/route_cost_budget_refresh.latest.json'
const DEFAULT_ROUTE_MAX_COST_BPS = 20
const DEFAULT_ESTIMATED_ROUND_TRIP_COST_BPS = 28

async function main(): Promise<void> {
  const args = parseRuntimeRouteCostBudgetArgs(process.argv.slice(2))
  const report = await runRuntimeRouteCostBudgetRefresh(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseRuntimeRouteCostBudgetArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    feeSnapshotPath: raw.get('feeSnapshotPath') ?? DEFAULT_FEE_SNAPSHOT_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    statusPath: parseNullablePath(raw.get('statusPath') ?? DEFAULT_STATUS_PATH),
    estimatedRoundTripCostPct: parseOptionalNonNegativeNumber(raw.get('estimatedRoundTripCostPct'), 'estimatedRoundTripCostPct'),
    dryRun: parseBool(raw.get('dryRun'), false),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runRuntimeRouteCostBudgetRefresh(
  args: CliArgs,
): Promise<RuntimeRouteCostBudgetRefreshReport> {
  const startedAt = new Date()
  const feeSnapshot = asRecord(await readJsonIfExists(args.feeSnapshotPath))
  const report = buildRuntimeRouteCostBudgetRefreshReport({
    generatedAt: new Date().toISOString(),
    asOfMs: Date.now(),
    args,
    feeSnapshot,
  })

  if (!args.dryRun && args.outputPath && report.routeCostBudget) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    const payload = `${JSON.stringify(report.routeCostBudget, null, 2)}\n`
    await writeFile(outputPath, payload, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'runtime_route_cost_budget_publish',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: 'warn',
      recordsIn: 1,
      recordsOut: Object.keys(report.routeCostBudget.routes).length,
      artifactHash: sha256Hex(payload),
    })
  }

  if (!args.dryRun && args.statusPath) {
    const statusPath = resolve(args.statusPath)
    await mkdir(dirname(statusPath), { recursive: true })
    const withoutHash = `${JSON.stringify({ ...report, outputHash: null }, null, 2)}\n`
    const outputHash = sha256Hex(withoutHash)
    const finalPayload = `${JSON.stringify({ ...report, outputHash }, null, 2)}\n`
    await writeFile(statusPath, finalPayload, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'runtime_route_cost_budget_refresh_status',
      artifactPath: statusPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'ready_for_research' ? 'warn' : 'fail',
      recordsIn: report.feeSnapshot.exists ? 1 : 0,
      recordsOut: report.routeSummary.routeCount,
      errorClass: report.blockers[0] ?? null,
      artifactHash: sha256Hex(finalPayload),
    })
    return { ...report, outputHash }
  }

  return report
}

export function buildRuntimeRouteCostBudgetRefreshReport(input: {
  generatedAt: string
  asOfMs: number
  args: CliArgs
  feeSnapshot: UnknownRecord | null
}): RuntimeRouteCostBudgetRefreshReport {
  const feeSnapshot = input.feeSnapshot
  const sourceFetchedAt = readString(feeSnapshot?.sourceFetchedAt)
  const expiresAt = readString(feeSnapshot?.expiresAt)
  const makerFeeBps = readNumber(feeSnapshot?.makerFeeBps)
  const takerFeeBps = readNumber(feeSnapshot?.takerFeeBps)
  const stale = isExpired(expiresAt, input.asOfMs)
  const feeSnapshotAllowsExecution = artifactAllowsExecution(feeSnapshot)
  const blockers = uniqueStrings([
    ...(feeSnapshot ? [] : ['fee_snapshot_missing']),
    ...(readString(feeSnapshot?.source) === 'api' ? [] : [`fee_snapshot_source_not_api:${readString(feeSnapshot?.source) ?? 'missing'}`]),
    ...(readBoolean(feeSnapshot?.verifiedByRuntime) === true ? [] : ['fee_snapshot_not_runtime_verified']),
    ...(sourceFetchedAt ? [] : ['fee_snapshot_source_fetched_at_missing']),
    ...(expiresAt ? [] : ['fee_snapshot_expires_at_missing']),
    ...(stale ? ['fee_snapshot_stale'] : []),
    ...(isValidFeeBps(makerFeeBps) ? [] : ['fee_snapshot_maker_fee_invalid']),
    ...(isValidFeeBps(takerFeeBps) ? [] : ['fee_snapshot_taker_fee_invalid']),
    ...(makerFeeBps != null && takerFeeBps != null && takerFeeBps < makerFeeBps ? ['fee_snapshot_taker_fee_below_maker_fee'] : []),
    ...(feeSnapshotAllowsExecution ? ['fee_snapshot_artifact_must_not_authorize_execution'] : []),
  ])
  const status: RefreshStatus = blockers.length === 0 ? 'ready_for_research' : 'blocked'
  const routeCostBudget = status === 'ready_for_research'
    ? buildRuntimeRouteCostBudget(input.generatedAt, feeSnapshot as FeeSnapshot, input.args.estimatedRoundTripCostPct)
    : null
  const routeEntries = routeCostBudget
    ? Object.values(routeCostBudget.routes)
    : []
  const routesOverBudget = routeEntries
    .filter(route => route.totalExpectedCostBps > route.maxAllowedCostBps)
    .map(route => route.route)
  const selectedSafeResearchRoute = routeEntries
    .filter(route => route.totalExpectedCostBps <= route.maxAllowedCostBps)
    .sort((left, right) => left.totalExpectedCostBps - right.totalExpectedCostBps)[0]?.route ?? null
  const hashMatchesEmbeddedSnapshot = routeCostBudget && feeSnapshot
    ? sha256Hex(JSON.stringify(feeSnapshot)) === sha256Hex(JSON.stringify(routeCostBudget.feeSnapshot))
    : null

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status,
    dryRun: input.args.dryRun,
    sourceArtifacts: {
      feeSnapshotPath: resolve(input.args.feeSnapshotPath),
      outputPath: input.args.outputPath ? resolve(input.args.outputPath) : null,
      statusPath: input.args.statusPath ? resolve(input.args.statusPath) : null,
    },
    feeSnapshot: {
      exists: feeSnapshot != null,
      source: readString(feeSnapshot?.source),
      verifiedByRuntime: readBoolean(feeSnapshot?.verifiedByRuntime),
      sourceFetchedAt,
      expiresAt,
      stale,
      makerFeeBps,
      takerFeeBps,
      hashMatchesEmbeddedSnapshot,
    },
    assumptions: {
      formulaSource: 'promotion_v2_runtime_bundle_equivalent',
      defaultEstimatedRoundTripCostBps: DEFAULT_ESTIMATED_ROUND_TRIP_COST_BPS,
      estimatedRoundTripCostPct: input.args.estimatedRoundTripCostPct,
      maxAllowedCostBps: DEFAULT_ROUTE_MAX_COST_BPS,
    },
    routeSummary: {
      routeCount: routeEntries.length,
      routesOverBudget,
      selectedSafeResearchRoute,
    },
    routeCostBudget,
    blockers,
    nextActions: buildNextActions(status),
    safetyNotes: [
      'This script only refreshes a diagnostic route-cost budget from an already-written runtime fee snapshot.',
      'It does not fetch credentials, place orders, cancel orders, modify leverage, mutate best_config.json, or authorize paper/live execution.',
      'The budget can remove stale fee-snapshot mismatch diagnostics, but promotion still requires PIT/WFO/FDR/prospective labels, risk simulation, and paper execution telemetry.',
    ],
    outputHash: null,
  }
}

export function buildRuntimeRouteCostBudget(
  generatedAt: string,
  feeSnapshot: FeeSnapshot,
  estimatedRoundTripCostPct: number | null,
): RouteCostBudget {
  const estimatedBps = Math.max(
    estimatedRoundTripCostPct == null
      ? DEFAULT_ESTIMATED_ROUND_TRIP_COST_BPS
      : estimatedRoundTripCostPct * 100,
    0,
  )
  const makeRoute = (
    route: RouteBudget['route'],
    feeBps: number,
    spreadBps: number,
    slippageBps: number,
    adverseSelectionBufferBps: number,
    queueMissBufferBps: number,
  ): RouteBudget => {
    const totalExpectedCostBps = feeBps + spreadBps + slippageBps + adverseSelectionBufferBps + queueMissBufferBps
    return {
      route,
      feeBps,
      spreadBps,
      slippageBps,
      adverseSelectionBufferBps,
      queueMissBufferBps,
      fundingBps: 0,
      totalExpectedCostBps,
      maxAllowedCostBps: DEFAULT_ROUTE_MAX_COST_BPS,
      breakEvenEdgeBps: totalExpectedCostBps,
    }
  }

  return {
    schemaMeta: makeSchemaMeta('route_cost_budget', generatedAt, 'runtime:route-cost-budget'),
    generatedAt,
    feeSnapshot,
    routes: {
      passive_passive: makeRoute('passive_passive', feeSnapshot.makerFeeBps * 2, 2, 4, 5, 3),
      passive_taker: makeRoute('passive_taker', feeSnapshot.makerFeeBps + feeSnapshot.takerFeeBps, 4, 8, 3, 2),
      taker_taker: makeRoute('taker_taker', feeSnapshot.takerFeeBps * 2, 6, Math.max(0, estimatedBps - 20), 2, 0),
      twap: makeRoute('twap', feeSnapshot.takerFeeBps * 2, 4, Math.max(0, estimatedBps - 18), 3, 0),
    },
  }
}

function makeSchemaMeta(schemaName: string, generatedAt: string, createdBy: string): SchemaMeta {
  return {
    schemaName,
    schemaVersion: PROMOTION_V2_SCHEMA_VERSION,
    createdBy,
    createdAt: generatedAt,
    codeCommit: process.env.OPENALICE_CODE_COMMIT ?? process.env.GIT_COMMIT ?? 'unknown-local',
  }
}

function buildNextActions(status: RefreshStatus): string[] {
  return status === 'ready_for_research'
    ? [
        'Run OKX route-cost/slippage readiness so it can compare this budget against the current runtime fee snapshot.',
        'Keep paper/live disabled until route-cost evidence is joined with paper execution telemetry and release gates pass.',
      ]
    : [
        'Refresh runtime fee_snapshot.latest.json from OKX private fee metadata before rebuilding route_cost_budget.latest.json.',
        'Do not publish paper/live targets from stale, missing, manual, or unverified fee snapshots.',
      ]
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as unknown
  } catch {
    return null
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg?.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(key, next)
      index += 1
    } else {
      out.set(key, 'true')
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : value
}

function parseOptionalNonNegativeNumber(value: string | undefined, name: string): number | null {
  if (value == null || value.trim() === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }
  return parsed
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function isValidFeeBps(value: number | null): boolean {
  return value != null && value >= 0 && value <= 1000
}

function isExpired(value: string | null, asOfMs: number): boolean {
  if (!value) return true
  const parsed = Date.parse(value)
  return !Number.isFinite(parsed) || parsed <= asOfMs
}

function artifactAllowsExecution(root: UnknownRecord | null): boolean {
  return readBoolean(root?.promotionEligible) === true ||
    readBoolean(root?.paperTradingAllowed) === true ||
    readBoolean(root?.liveTradingAllowed) === true ||
    readBoolean(root?.executionAllowed) === true ||
    readBoolean(root?.promotionAllowedByThisArtifact) === true ||
    readBoolean(root?.paperTradingAllowedByThisArtifact) === true ||
    readBoolean(root?.liveTradingAllowedByThisArtifact) === true
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim() !== ''))]
}

function renderConsoleSummary(report: RuntimeRouteCostBudgetRefreshReport): string {
  return [
    `Runtime route-cost budget: ${report.status}`,
    `fee=${report.feeSnapshot.source ?? 'missing'} verified=${report.feeSnapshot.verifiedByRuntime ?? false} stale=${report.feeSnapshot.stale}`,
    `routes=${report.routeSummary.routeCount} overBudget=${report.routeSummary.routesOverBudget.join(',') || 'none'} safeRoute=${report.routeSummary.selectedSafeResearchRoute ?? 'none'}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `topBlockers=${report.blockers.slice(0, 10).join(',')}` : 'topBlockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
