import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { PROMOTION_V2_SCHEMA_VERSION } from '../src/runtime/promotion_v2.js'
import { describe, expect, it } from 'vitest'
import {
  buildRuntimeRouteCostBudget,
  buildRuntimeRouteCostBudgetRefreshReport,
  parseRuntimeRouteCostBudgetArgs,
  runRuntimeRouteCostBudgetRefresh,
} from './build_runtime_route_cost_budget.js'

describe('build_runtime_route_cost_budget', () => {
  it('parses defaults and keeps package scripts wired before route-cost readiness', () => {
    expect(parseRuntimeRouteCostBudgetArgs([
      '--output',
      'null',
      '--statusPath',
      'none',
      '--json',
      'true',
    ])).toMatchObject({
      feeSnapshotPath: 'data/runtime/fee_snapshot.latest.json',
      outputPath: null,
      statusPath: null,
      estimatedRoundTripCostPct: null,
      dryRun: false,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:okx:runtime-route-cost-budget']).toContain('build_runtime_route_cost_budget.ts')
    expect(scripts['research:eth-carry:prospective-tick']).toMatch(
      /build_runtime_route_cost_budget\.ts && tsx scripts\/build_okx_route_cost_slippage_readiness\.ts/,
    )
    expect(scripts['status:research-evidence']).toMatch(
      /build_runtime_route_cost_budget\.ts && tsx scripts\/build_okx_route_cost_slippage_readiness\.ts/,
    )
  })

  it('builds the same route formula from a runtime-verified fee snapshot without granting execution authority', () => {
    const feeSnapshot = makeFeeSnapshot()
    const report = buildRuntimeRouteCostBudgetRefreshReport({
      generatedAt: '2026-05-07T10:20:00.000Z',
      asOfMs: Date.parse('2026-05-07T10:20:00.000Z'),
      args: makeArgs(),
      feeSnapshot,
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-07T10:20:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'ready_for_research',
      feeSnapshot: {
        source: 'api',
        verifiedByRuntime: true,
        stale: false,
        makerFeeBps: 2,
        takerFeeBps: 5,
        hashMatchesEmbeddedSnapshot: true,
      },
      routeSummary: {
        routeCount: 4,
        routesOverBudget: ['passive_taker', 'taker_taker', 'twap'],
        selectedSafeResearchRoute: 'passive_passive',
      },
      blockers: [],
    })
    expect(report.routeCostBudget).toMatchObject({
      schemaMeta: {
        schemaName: 'route_cost_budget',
        schemaVersion: PROMOTION_V2_SCHEMA_VERSION,
        createdBy: 'runtime:route-cost-budget',
        createdAt: '2026-05-07T10:20:00.000Z',
      },
      generatedAt: '2026-05-07T10:20:00.000Z',
      feeSnapshot,
      routes: {
        passive_passive: {
          feeBps: 4,
          spreadBps: 2,
          slippageBps: 4,
          adverseSelectionBufferBps: 5,
          queueMissBufferBps: 3,
          totalExpectedCostBps: 18,
          maxAllowedCostBps: 20,
        },
        passive_taker: {
          feeBps: 7,
          totalExpectedCostBps: 24,
          maxAllowedCostBps: 20,
        },
        taker_taker: {
          feeBps: 10,
          slippageBps: 8,
          totalExpectedCostBps: 26,
          maxAllowedCostBps: 20,
        },
        twap: {
          feeBps: 10,
          slippageBps: 10,
          totalExpectedCostBps: 27,
          maxAllowedCostBps: 20,
        },
      },
    })
  })

  it('blocks stale, manual, or execution-authorizing fee snapshots instead of writing a budget', () => {
    const report = buildRuntimeRouteCostBudgetRefreshReport({
      generatedAt: '2026-05-07T10:20:00.000Z',
      asOfMs: Date.parse('2026-05-07T10:20:00.000Z'),
      args: makeArgs(),
      feeSnapshot: {
        ...makeFeeSnapshot(),
        source: 'manual_override',
        verifiedByRuntime: false,
        expiresAt: '2026-05-07T09:20:00.000Z',
        executionAllowed: true,
      },
    })

    expect(report).toMatchObject({
      status: 'blocked',
      routeCostBudget: null,
      routeSummary: {
        routeCount: 0,
        selectedSafeResearchRoute: null,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'fee_snapshot_source_not_api:manual_override',
      'fee_snapshot_not_runtime_verified',
      'fee_snapshot_stale',
      'fee_snapshot_artifact_must_not_authorize_execution',
    ]))
  })

  it('supports explicit estimated round-trip cost input for taker and twap routes', () => {
    const budget = buildRuntimeRouteCostBudget('2026-05-07T10:20:00.000Z', makeFeeSnapshot(), 0.5)

    expect(budget.routes.taker_taker).toMatchObject({
      slippageBps: 30,
      totalExpectedCostBps: 48,
      breakEvenEdgeBps: 48,
    })
    expect(budget.routes.twap).toMatchObject({
      slippageBps: 32,
      totalExpectedCostBps: 49,
      breakEvenEdgeBps: 49,
    })
  })

  it('writes the route budget artifact plus refresh manifest while keeping the status diagnostic-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-route-budget-'))
    const feeSnapshotPath = join(root, 'fee_snapshot.latest.json')
    const outputPath = join(root, 'route_cost_budget.latest.json')
    const statusPath = join(root, 'route_cost_budget_refresh.latest.json')
    await mkdir(root, { recursive: true })
    const feeSnapshot = {
      ...makeFeeSnapshot(),
      sourceFetchedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }
    await writeJson(feeSnapshotPath, feeSnapshot)

    const report = await runRuntimeRouteCostBudgetRefresh({
      ...makeArgs(),
      feeSnapshotPath,
      outputPath,
      statusPath,
    })

    expect(report.status).toBe('ready_for_research')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      schemaMeta: {
        schemaName: 'route_cost_budget',
        schemaVersion: PROMOTION_V2_SCHEMA_VERSION,
        createdBy: 'runtime:route-cost-budget',
      },
      feeSnapshot,
      routes: {
        passive_passive: {
          totalExpectedCostBps: 18,
        },
      },
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'runtime_route_cost_budget_publish',
      businessStatus: 'warn',
      recordsIn: 1,
      recordsOut: 4,
    })
    expect(JSON.parse(await readFile(statusPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'ready_for_research',
    })
    expect(JSON.parse(await readFile(`${statusPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'runtime_route_cost_budget_refresh_status',
      businessStatus: 'warn',
    })
  })
})

function makeArgs() {
  return {
    feeSnapshotPath: 'data/runtime/fee_snapshot.latest.json',
    outputPath: null,
    statusPath: null,
    estimatedRoundTripCostPct: null,
    dryRun: false,
    json: false,
  }
}

function makeFeeSnapshot() {
  return {
    venue: 'okx',
    symbol: 'cross_sectional_universe',
    instrumentType: 'crypto_perpetual',
    accountTier: 'runtime_api_max_fee:okx:swap:symbols=3',
    makerFeeBps: 2,
    takerFeeBps: 5,
    source: 'api',
    sourceFetchedAt: '2026-05-07T10:00:00.000Z',
    expiresAt: '2026-05-08T10:00:00.000Z',
    verifiedByRuntime: true,
    fundingIntervalHours: 8,
    fundingCapBps: 0,
    fundingFloorBps: 0,
  } as const
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}
