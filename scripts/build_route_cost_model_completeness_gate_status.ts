import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type Status = 'pass' | 'watch' | 'blocked'

interface CliArgs {
  outputPath: string | null
  routeCostBudgetPath: string
  json: boolean
}

interface RouteCostEntry {
  route: string
  feeBps: number | null
  spreadBps: number | null
  slippageBps: number | null
  adverseSelectionBufferBps: number | null
  totalExpectedCostBps: number | null
  maxAllowedCostBps: number | null
}

export interface RouteCostModelCompletenessGateStatus {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: Status
  checks: {
    routesModeled: number
    routesWithFee: number
    routesWithSlippage: number
    routesWithAdverseSelection: number
    routesWithTotalCost: number
    routesWithMaxAllowedCost: number
    slippageTracked: boolean
    adverseSelectionTracked: boolean
    feeSnapshotSource: string | null
    feeSnapshotVerifiedByRuntime: boolean
    allRoutesModeled: boolean
    allSlippageTracked: boolean
    allAdverseSelectionTracked: boolean
  }
  routeDetails: RouteCostEntry[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/route_cost_model_completeness_gate_status.latest.json'

async function main(): Promise<void> {
  const args = parseRouteCostModelCompletenessGateStatusArgs(process.argv.slice(2))
  const report = await runRouteCostModelCompletenessGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseRouteCostModelCompletenessGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    routeCostBudgetPath: raw.get('routeCostBudgetPath') ?? 'data/runtime/route_cost_budget.latest.json',
    json: parseBool(raw.get('json'), false),
  }
}

export async function runRouteCostModelCompletenessGateStatus(args: CliArgs): Promise<RouteCostModelCompletenessGateStatus> {
  const startedAt = new Date()
  const sourcePaths = {
    routeCostBudget: resolve(args.routeCostBudgetPath),
  }
  const routeCostBudget = asRecord(await readJsonIfExists(sourcePaths.routeCostBudget))
  const report = buildRouteCostModelCompletenessGateStatus({
    generatedAt: new Date().toISOString(),
    routeCostBudget,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'route_cost_model_completeness_gate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'pass' ? 'pass' : report.status === 'watch' ? 'warn' : 'fail',
      recordsIn: 1,
      recordsOut: 1,
      errorClass: report.blockers[0] ?? null,
    })
  }
  return report
}

export function buildRouteCostModelCompletenessGateStatus(input: {
  generatedAt?: string
  routeCostBudget: UnknownRecord | null
}): RouteCostModelCompletenessGateStatus {
  const routes = asRecord(input.routeCostBudget?.routes)
  const feeSnapshot = asRecord(input.routeCostBudget?.feeSnapshot)

  const routeEntries: RouteCostEntry[] = []
  if (routes) {
    for (const [routeName, routeValue] of Object.entries(routes)) {
      const route = asRecord(routeValue)
      if (!route) continue
      routeEntries.push({
        route: routeName,
        feeBps: readNumber(route.feeBps),
        spreadBps: readNumber(route.spreadBps),
        slippageBps: readNumber(route.slippageBps),
        adverseSelectionBufferBps: readNumber(route.adverseSelectionBufferBps),
        totalExpectedCostBps: readNumber(route.totalExpectedCostBps),
        maxAllowedCostBps: readNumber(route.maxAllowedCostBps),
      })
    }
  }

  const routesModeled = routeEntries.length
  const routesWithFee = routeEntries.filter(r => r.feeBps != null && r.feeBps > 0).length
  const routesWithSlippage = routeEntries.filter(r => r.slippageBps != null && r.slippageBps > 0).length
  const routesWithAdverseSelection = routeEntries.filter(r => r.adverseSelectionBufferBps != null && r.adverseSelectionBufferBps > 0).length
  const routesWithTotalCost = routeEntries.filter(r => r.totalExpectedCostBps != null && r.totalExpectedCostBps > 0).length
  const routesWithMaxAllowedCost = routeEntries.filter(r => r.maxAllowedCostBps != null && r.maxAllowedCostBps > 0).length

  const slippageTracked = routesModeled > 0 && routesWithSlippage === routesModeled
  const adverseSelectionTracked = routesModeled > 0 && routesWithAdverseSelection === routesModeled
  const allRoutesModeled = routesModeled > 0 && routesWithTotalCost === routesModeled && routesWithMaxAllowedCost === routesModeled

  const feeSnapshotSource = readString(feeSnapshot?.source)
  const feeSnapshotVerifiedByRuntime = readBoolean(feeSnapshot?.verifiedByRuntime) === true

  const budgetMissing = input.routeCostBudget == null
  const blockers = [
    ...(budgetMissing ? ['route_cost_budget_missing'] : []),
    ...(routesModeled === 0 ? ['no_routes_modeled'] : []),
    ...(routesModeled > 0 && routesWithFee < routesModeled
      ? [`routes_missing_fee:${routesModeled - routesWithFee}/${routesModeled}`]
      : []),
    ...(!slippageTracked ? [`slippage_not_tracked_all_routes:${routesWithSlippage}/${routesModeled}`] : []),
    ...(!adverseSelectionTracked ? [`adverse_selection_not_tracked:${routesWithAdverseSelection}/${routesModeled}`] : []),
    ...(!allRoutesModeled ? [`incomplete_total_cost_model:${routesWithTotalCost}/${routesModeled}`] : []),
    ...(!feeSnapshotVerifiedByRuntime ? [`fee_snapshot_not_runtime_verified:${feeSnapshotSource ?? 'missing'}`] : []),
  ]

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: blockers.length === 0 ? 'pass' : budgetMissing ? 'blocked' : routesModeled > 0 ? 'watch' : 'blocked',
    checks: {
      routesModeled,
      routesWithFee,
      routesWithSlippage,
      routesWithAdverseSelection,
      routesWithTotalCost,
      routesWithMaxAllowedCost,
      slippageTracked,
      adverseSelectionTracked,
      feeSnapshotSource,
      feeSnapshotVerifiedByRuntime,
      allRoutesModeled,
      allSlippageTracked: slippageTracked,
      allAdverseSelectionTracked: adverseSelectionTracked,
    },
    routeDetails: routeEntries,
    blockers,
    nextActions: blockers.length === 0
      ? ['Keep route-cost model completeness gate in the research-evidence refresh chain; this is cost evidence only, not trading authorization.']
      : [
          'Ensure every execution route has fee, slippage, adverse selection, and total cost modeled in route_cost_budget.',
          'Verify fee snapshot against runtime API data; do not use manual overrides for promotion evidence.',
        ],
    safetyNotes: [
      'This artifact validates route cost model completeness only; it cannot authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
      'A passing route-cost model does not prove execution quality; it only means costs are modeled, not that they are verified by real fills.',
    ],
  }
}

function renderConsoleSummary(report: RouteCostModelCompletenessGateStatus): string {
  return [
    `Route cost model completeness: ${report.status}`,
    `routes=${report.checks.routesModeled} fee=${report.checks.routesWithFee} slippage=${report.checks.routesWithSlippage} adverse=${report.checks.routesWithAdverseSelection}`,
    `feeSource=${report.checks.feeSnapshotSource ?? 'none'} runtimeVerified=${report.checks.feeSnapshotVerifiedByRuntime}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf-8'))
  } catch {
    return null
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    i += 1
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_route_cost_model_completeness_gate_status failed:', error)
    process.exit(1)
  })
}
