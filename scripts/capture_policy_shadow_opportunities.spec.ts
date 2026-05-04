import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  capturePolicyShadowOpportunities,
  parseShadowCaptureArgs,
} from './capture_policy_shadow_opportunities.js'
import { createBootstrapMarketIntelContext } from '../src/runtime/market_intel_context.js'
import { readPaperPolicyShadowLedger } from '../src/runtime/paper_policy_shadow_ledger.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'shadow-capture-'))
}

describe('capture_policy_shadow_opportunities', () => {
  it('parses conservative shadow-only defaults', () => {
    expect(parseShadowCaptureArgs([
      '--symbols',
      'eth-usdt,btcusdt',
      '--dryRun',
      'true',
      '--routeCostBudgetPath',
      'route_cost_budget.json',
      '--outputPath',
      'null',
    ])).toMatchObject({
      symbols: ['ETH-USDT', 'BTCUSDT'],
      routeCostBudgetPath: 'route_cost_budget.json',
      maxShadowsPerLane: 5,
      maxPerReason: 3,
      maxPerSymbolPerHorizon: 1,
      dryRun: true,
      outputPath: null,
    })
  })

  it('captures bounded shadow opens without mutating paper accounts', async () => {
    const root = await tempRoot()
    const dataDir = join(root, 'market')
    const paperAccountPath = join(root, 'account_vb_spot_1x.json')
    const ledgerPath = join(root, 'shadow.jsonl')
    const outputPath = join(root, 'capture.json')
    const routeCostBudgetPath = join(root, 'route_cost_budget.latest.json')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'BTC_USDT_USDT_5m.csv'), buildBreakoutCsv({ close: 103, volume: 20_000 }))
    await writeFile(routeCostBudgetPath, JSON.stringify(makeRouteCostBudget({
      taker_taker: {
        totalExpectedCostBps: 43,
        maxAllowedCostBps: 20,
        breakEvenEdgeBps: 43,
      },
    })))
    await writeFile(paperAccountPath, '{"sentinel":true}\n')

    const report = await capturePolicyShadowOpportunities({
      dataDir,
      ledgerPath,
      outputPath,
      routeCostBudgetPath,
      symbols: ['BTC-USDT'],
      maxShadowsPerLane: 5,
      maxPerReason: 3,
      maxPerSymbolPerHorizon: 1,
      nearThresholdBandPct: 0.25,
      dryRun: false,
      json: true,
    }, {
      marketIntelContext: buildContext({ riskOff: true }),
      systemFuse: { generatedAt: '2026-05-02T00:00:00.000Z', status: 'risk_off', reason: 'test_risk_off' },
      now: new Date('2026-05-02T00:00:00.000Z'),
    })

    expect(report).toMatchObject({
      mode: 'shadow_only_no_account_mutation',
      counts: {
        symbolsRequested: 1,
        assetsLoaded: 1,
        candidatesSeen: 2,
        recorded: 2,
        duplicateSkipped: 0,
      },
    })
    expect(readFileSync(paperAccountPath, 'utf-8')).toBe('{"sentinel":true}\n')
    const entries = readPaperPolicyShadowLedger(ledgerPath)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      eventType: 'open',
      counterfactualType: 'trade_level_shadow',
      symbol: 'BTC-USDT',
      blockReasons: expect.arrayContaining(['reason_class:risk_off']),
      context: {
        watermark: '2026-05-02T00:00:00.000Z',
        flashContextStatus: 'risk_off',
        featureSchemaVersion: 'paper_open_context.v3',
      },
      quality: {
        confidenceAtOpen: expect.any(Number),
      },
      cost: {
        roundTripCostBpsAtOpen: 43,
        routeCostBpsAtOpen: 43,
        expectedGrossEdgePctAtOpen: 74.4444444444,
        expectedNetEdgePctAtOpen: 74.0144444444,
        expectedEdgeSourceAtOpen: 'volume_breakout_shadow_range_break_pct_x_quality_minus_paper_route_cost',
        matchPriceAtOpen: 103,
        markMatchPenaltyBpsAtOpen: 15,
        markMatchStatusAtOpen: 'stale_or_missing',
        selectedRoute: 'taker_taker',
        routeBudgetStatusAtOpen: 'exceeded',
        routeBudgetTotalExpectedCostBpsAtOpen: 43,
        routeBudgetMaxAllowedCostBpsAtOpen: 20,
        routeBudgetBreakEvenEdgeBpsAtOpen: 43,
        routeCostShadowEligibilityAtOpen: 'not_route_cost_eligible',
        routeCostShadowEligibilityReasonsAtOpen: expect.arrayContaining([
          'route_cost_shadow_eligibility_diagnostic_only',
          'route_cost_budget_exceeded:taker_taker',
        ]),
      },
    })
    expect((entries[0] as { quality: Record<string, unknown> }).quality.roundTripCostBpsAtOpen).toBeUndefined()
    expect(JSON.parse(await readFile(outputPath, 'utf-8')).counts.recorded).toBe(2)
  })

  it('dedupes repeated capture runs for the same bar and policy version', async () => {
    const root = await tempRoot()
    const dataDir = join(root, 'market')
    const ledgerPath = join(root, 'shadow.jsonl')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'BTC_USDT_USDT_5m.csv'), buildBreakoutCsv({ close: 103, volume: 20_000 }))
    const args = {
      dataDir,
      ledgerPath,
      outputPath: null,
      routeCostBudgetPath: join(root, 'missing_route_cost_budget.json'),
      symbols: ['BTC-USDT'],
      maxShadowsPerLane: 5,
      maxPerReason: 3,
      maxPerSymbolPerHorizon: 1,
      nearThresholdBandPct: 0.25,
      dryRun: false,
      json: true,
    }
    const deps = {
      marketIntelContext: buildContext({ riskOff: true }),
      systemFuse: { generatedAt: '2026-05-02T00:00:00.000Z', status: 'risk_off' as const, reason: 'test_risk_off' },
      now: new Date('2026-05-02T00:00:00.000Z'),
    }

    const first = await capturePolicyShadowOpportunities(args, deps)
    const second = await capturePolicyShadowOpportunities(args, deps)

    expect(first.counts.recorded).toBe(2)
    expect(second.counts.recorded).toBe(0)
    expect(second.counts.duplicateSkipped).toBe(2)
    expect(readPaperPolicyShadowLedger(ledgerPath)).toHaveLength(2)
  })

  it('dry-run reports would-record rows without writing ledger or report', async () => {
    const root = await tempRoot()
    const dataDir = join(root, 'market')
    const ledgerPath = join(root, 'shadow.jsonl')
    const outputPath = join(root, 'capture.json')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'BTC_USDT_USDT_5m.csv'), buildBreakoutCsv({ close: 103, volume: 20_000 }))

    const report = await capturePolicyShadowOpportunities({
      dataDir,
      ledgerPath,
      outputPath,
      routeCostBudgetPath: join(root, 'missing_route_cost_budget.json'),
      symbols: ['BTC-USDT'],
      maxShadowsPerLane: 5,
      maxPerReason: 3,
      maxPerSymbolPerHorizon: 1,
      nearThresholdBandPct: 0.25,
      dryRun: true,
      json: true,
    }, {
      marketIntelContext: buildContext({ riskOff: true }),
      systemFuse: { generatedAt: '2026-05-02T00:00:00.000Z', status: 'risk_off', reason: 'test_risk_off' },
      now: new Date('2026-05-02T00:00:00.000Z'),
    })

    expect(report.counts).toMatchObject({
      recorded: 0,
      dryRunWouldRecord: 2,
    })
    expect(existsSync(ledgerPath)).toBe(false)
    expect(existsSync(outputPath)).toBe(true)
  })
})

function buildContext(options: { riskOff?: boolean } = {}) {
  return {
    ...createBootstrapMarketIntelContext(new Date('2026-05-02T00:00:00.000Z')),
    contextGeneration: 42,
    generatedAt: '2026-05-02T00:00:00.000Z',
    validUntil: '2026-05-02T01:00:00.000Z',
    riskMode: options.riskOff ? 'risk_off' as const : 'risk_on' as const,
    allowNewPositionsByLane: {
      cross_sectional: true,
      volume_breakout_1x: true,
      volume_breakout_3x: true,
      microstructure_10x: false,
      microstructure_100x: false,
    },
    coldStartRoundsRemaining: 0,
    sourceEpoch: { flashEpoch: 7, proEpoch: 9, newsEpoch: 11 },
    flashConfidenceByLane: {
      volume_breakout_1x: { confidence: 0.72, confidenceLow: 0.61, confidenceHigh: 0.84 },
      volume_breakout_3x: { confidence: 0.7, confidenceLow: 0.59, confidenceHigh: 0.81 },
    },
    trigger: 'test_market_intel',
  }
}

function buildBreakoutCsv(options: { close: number; volume: number }): string {
  const rows = ['timestamp,datetime,open,high,low,close,volume']
  const start = Date.parse('2026-05-01T00:00:00.000Z')
  for (let index = 0; index < 30; index += 1) {
    const ts = start + index * 300_000
    rows.push(`${ts},${new Date(ts).toISOString()},100,101,99,100,1000`)
  }
  const latestTs = start + 30 * 300_000
  rows.push(`${latestTs},${new Date(latestTs).toISOString()},100,104,99.5,${options.close},${options.volume}`)
  return `${rows.join('\n')}\n`
}

function makeRouteCostBudget(
  routeOverrides: Partial<Record<string, Partial<{
    totalExpectedCostBps: number
    maxAllowedCostBps: number
    breakEvenEdgeBps: number
  }>>> = {},
) {
  const makeRoute = (
    route: 'passive_passive' | 'passive_taker' | 'taker_taker' | 'twap',
    totalExpectedCostBps: number,
  ) => ({
    route,
    feeBps: 4,
    spreadBps: 2,
    slippageBps: Math.max(0, totalExpectedCostBps - 11),
    adverseSelectionBufferBps: 3,
    queueMissBufferBps: 2,
    fundingBps: 0,
    totalExpectedCostBps,
    maxAllowedCostBps: 20,
    breakEvenEdgeBps: totalExpectedCostBps,
    ...(routeOverrides[route] ?? {}),
  })
  return {
    schemaMeta: {
      schemaName: 'route_cost_budget',
      schemaVersion: 'test',
      createdBy: 'test',
      createdAt: '2026-05-02T00:00:00.000Z',
      codeCommit: 'test',
    },
    generatedAt: '2026-05-02T00:00:00.000Z',
    feeSnapshot: {
      venue: 'binance',
      symbol: 'BTCUSDT',
      instrumentType: 'perp',
      accountTier: 'default',
      makerFeeBps: 2,
      takerFeeBps: 6,
      source: 'runtime',
      sourceFetchedAt: '2026-05-02T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      verifiedByRuntime: true,
    },
    routes: {
      passive_passive: makeRoute('passive_passive', 18),
      passive_taker: makeRoute('passive_taker', 25),
      taker_taker: makeRoute('taker_taker', 28),
      twap: makeRoute('twap', 30),
    },
  }
}
