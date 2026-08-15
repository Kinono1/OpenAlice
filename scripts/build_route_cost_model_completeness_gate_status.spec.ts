import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildRouteCostModelCompletenessGateStatus,
  parseRouteCostModelCompletenessGateStatusArgs,
  runRouteCostModelCompletenessGateStatus,
} from './build_route_cost_model_completeness_gate_status.js'

describe('build_route_cost_model_completeness_gate_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseRouteCostModelCompletenessGateStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      routeCostBudgetPath: 'data/runtime/route_cost_budget.latest.json',
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:route-cost-model-completeness-gate']).toContain('build_route_cost_model_completeness_gate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_route_cost_model_completeness_gate_status.ts')
  })

  it('reports watch when route cost budget exists but has incomplete coverage', () => {
    const report = buildRouteCostModelCompletenessGateStatus({
      generatedAt: '2026-05-08T07:00:00.000Z',
      routeCostBudget: {
        feeSnapshot: {
          source: 'api',
          verifiedByRuntime: true,
        },
        routes: {
          passive_passive: {
            route: 'passive_passive',
            feeBps: 4,
            spreadBps: 2,
            slippageBps: 4,
            adverseSelectionBufferBps: 5,
            totalExpectedCostBps: 18,
            maxAllowedCostBps: 20,
          },
          taker_taker: {
            route: 'taker_taker',
            feeBps: 10,
            spreadBps: 6,
            slippageBps: 0,
            adverseSelectionBufferBps: 0,
            totalExpectedCostBps: 16,
            maxAllowedCostBps: 20,
          },
        },
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-08T07:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'watch',
    })
    expect(report.checks.routesModeled).toBe(2)
    expect(report.checks.slippageTracked).toBe(false)
    expect(report.checks.adverseSelectionTracked).toBe(false)
    expect(report.blockers).toContain('slippage_not_tracked_all_routes:1/2')
    expect(report.blockers).toContain('adverse_selection_not_tracked:1/2')
  })

  it('reports pass when all routes are fully modeled', () => {
    const report = buildRouteCostModelCompletenessGateStatus({
      generatedAt: '2026-05-08T07:00:00.000Z',
      routeCostBudget: {
        feeSnapshot: {
          source: 'api',
          verifiedByRuntime: true,
        },
        routes: {
          passive_passive: {
            route: 'passive_passive',
            feeBps: 4,
            spreadBps: 2,
            slippageBps: 4,
            adverseSelectionBufferBps: 5,
            totalExpectedCostBps: 18,
            maxAllowedCostBps: 20,
          },
          taker_taker: {
            route: 'taker_taker',
            feeBps: 10,
            spreadBps: 6,
            slippageBps: 8,
            adverseSelectionBufferBps: 2,
            totalExpectedCostBps: 26,
            maxAllowedCostBps: 30,
          },
        },
      },
    })

    expect(report).toMatchObject({
      status: 'pass',
      researchOnly: true,
      diagnosticOnly: true,
      executionAllowed: false,
    })
    expect(report.checks.routesModeled).toBe(2)
    expect(report.checks.slippageTracked).toBe(true)
    expect(report.checks.adverseSelectionTracked).toBe(true)
    expect(report.checks.allRoutesModeled).toBe(true)
    expect(report.blockers).toEqual([])
  })

  it('reports blocked when route cost budget is missing', () => {
    const report = buildRouteCostModelCompletenessGateStatus({
      generatedAt: '2026-05-08T07:00:00.000Z',
      routeCostBudget: null,
    })

    expect(report.status).toBe('blocked')
    expect(report.blockers).toContain('route_cost_budget_missing')
    expect(report.blockers).toContain('no_routes_modeled')
  })

  it('reports blocker when fee snapshot is not runtime verified', () => {
    const report = buildRouteCostModelCompletenessGateStatus({
      generatedAt: '2026-05-08T07:00:00.000Z',
      routeCostBudget: {
        feeSnapshot: {
          source: 'manual_override',
          verifiedByRuntime: false,
        },
        routes: {
          passive_passive: {
            feeBps: 4,
            spreadBps: 2,
            slippageBps: 4,
            adverseSelectionBufferBps: 5,
            totalExpectedCostBps: 18,
            maxAllowedCostBps: 20,
          },
        },
      },
    })

    expect(report.status).toBe('watch')
    expect(report.blockers).toContain('fee_snapshot_not_runtime_verified:manual_override')
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-route-cost-completeness-'))
    const budgetPath = join(root, 'route_cost_budget.latest.json')
    const outputPath = join(root, 'route_cost_model_completeness_gate_status.latest.json')
    await mkdir(root, { recursive: true })
    await writeFile(budgetPath, JSON.stringify({
      feeSnapshot: {
        source: 'api',
        verifiedByRuntime: true,
      },
      routes: {
        passive_passive: {
          feeBps: 4,
          spreadBps: 2,
          slippageBps: 4,
          adverseSelectionBufferBps: 5,
          totalExpectedCostBps: 18,
          maxAllowedCostBps: 20,
        },
      },
    }), 'utf-8')

    const report = await runRouteCostModelCompletenessGateStatus({
      outputPath,
      routeCostBudgetPath: budgetPath,
      json: false,
    })

    expect(report.status).toBe('pass')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      status: 'pass',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'route_cost_model_completeness_gate_status',
      businessStatus: 'pass',
      recordsIn: 1,
      recordsOut: 1,
    })
  })
})
