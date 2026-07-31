import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildEthCarryConfluenceRefinementSweepReport,
  parseEthCarryConfluenceRefinementSweepArgs,
  runEthCarryConfluenceRefinementSweep,
} from './build_eth_carry_confluence_refinement_sweep.js'

describe('build_eth_carry_confluence_refinement_sweep', () => {
  it('parses args and is wired into research-only scripts', () => {
    expect(parseEthCarryConfluenceRefinementSweepArgs([
      '--ledgerPath',
      '/tmp/ledger.jsonl',
      '--output',
      'none',
      '--fundingAbsThresholds',
      '0,0.00005',
      '--basisAbsThresholdsPct',
      '0,0.02',
      '--minTotalClosedOutcomes',
      '10',
      '--minVariantClosedOutcomes',
      '3',
      '--minWindowClosedOutcomes',
      '1',
      '--minWindows',
      '2',
      '--minWinRatePct',
      '60',
      '--minMeanNetPct',
      '0.01',
      '--maxFdrQ',
      '0.2',
      '--json',
    ])).toMatchObject({
      ledgerPath: '/tmp/ledger.jsonl',
      outputPath: null,
      fundingAbsThresholds: [0, 0.00005],
      basisAbsThresholdsPct: [0, 0.02],
      minTotalClosedOutcomes: 10,
      minVariantClosedOutcomes: 3,
      minWindowClosedOutcomes: 1,
      minWindows: 2,
      minWinRatePct: 60,
      minMeanNetPct: 0.01,
      maxFdrQ: 0.2,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:confluence-refinement-sweep']).toContain('build_eth_carry_confluence_refinement_sweep.ts')
    expect(scripts['status:research-evidence']).toContain('build_eth_carry_confluence_refinement_sweep.ts')
  })

  it('keeps a small but good-looking refinement blocked by sample size and FDR', () => {
    const report = buildEthCarryConfluenceRefinementSweepReport({
      generatedAt: '2026-05-08T04:00:00.000Z',
      ledgerPath: '/tmp/missing-ledger.jsonl',
      ledgerExists: false,
      ledgerEvents: makeLedgerEvents([
        makeClosedPair('a', 1_000, 0.00008, 0.03, 0.4),
        makeClosedPair('b', 2_000, 0.00007, 0.025, 0.2),
        makeClosedPair('c', 3_000, 0.00006, 0.021, -0.1),
        makeClosedPair('d', 4_000, 0.00002, 0.005, -0.4),
      ]).flat(),
      args: {
        fundingAbsThresholds: [0, 0.00005],
        basisAbsThresholdsPct: [0, 0.02],
        minTotalClosedOutcomes: 10,
        minVariantClosedOutcomes: 3,
        minWindowClosedOutcomes: 1,
        minWindows: 2,
        minWinRatePct: 55,
        minMeanNetPct: 0,
        maxFdrQ: 0.1,
      },
    })

    expect(report).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_missing_inputs',
      evidenceCounts: {
        closedOutcomes: 4,
        matchedClosedRows: 4,
        variantsTested: 4,
      },
      trialLedger: {
        rawM: 4,
        rawMComplete: true,
        includesFailedTrials: true,
        pValuePromotionGrade: false,
      },
    })
    expect(report.bestVariant?.rule).toMatchObject({
      minAbsFundingSpread: 0.00005,
      minAbsBasisSpreadDiffPct: 0.02,
    })
    expect(report.bestVariant?.closedOutcomes).toBe(3)
    expect(report.bestVariant?.meanNetPct ?? 0).toBeGreaterThan(0)
    expect(report.blockers).toEqual(expect.arrayContaining([
      'eth_carry_prospective_ledger_missing',
      'prospective_closed_outcomes_low:4<10',
      'by_fdr_q_not_passed:1>0.1',
      'p_values_research_only_not_promotion_grade',
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
    ]))
  })

  it('can be watch-only when research diagnostics clear while execution remains disabled', () => {
    const strongEvents = Array.from({ length: 12 }, (_, index) =>
      makeClosedPair(`x${index}`, 1_000 + index * 1_000, 0.00008, 0.03, 0.2 + index * 0.001),
    ).flat()
    const weakBaselineEvents = Array.from({ length: 6 }, (_, index) =>
      makeClosedPair(`weak${index}`, 50_000 + index * 1_000, 0.00001, 0.005, -0.2 - index * 0.001),
    ).flat()
    const report = buildEthCarryConfluenceRefinementSweepReport({
      generatedAt: '2026-05-08T04:00:00.000Z',
      ledgerPath: process.cwd(),
      ledgerExists: true,
      ledgerEvents: [...strongEvents, ...weakBaselineEvents],
      args: {
        fundingAbsThresholds: [0, 0.00005],
        basisAbsThresholdsPct: [0, 0.02],
        minTotalClosedOutcomes: 18,
        minVariantClosedOutcomes: 10,
        minWindowClosedOutcomes: 3,
        minWindows: 3,
        minWinRatePct: 55,
        minMeanNetPct: 0,
        maxFdrQ: 0.1,
      },
    })

    expect(report.status).toBe('research_refinement_watch_only')
    expect(report.bestVariant?.fdrPassed).toBe(true)
    expect(report.bestVariant?.wfo.status).toBe('pass_research_only')
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.promotionEligible).toBe(false)
    expect(report.executionAllowed).toBe(false)
    expect(report.blockers).toEqual([
      'p_values_research_only_not_promotion_grade',
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'requires_independent_pit_wfo_fdr_route_cost_risk_and_paper_telemetry',
    ])
  })

  it('writes the sweep artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-refinement-sweep-'))
    const ledgerPath = join(root, 'ledger.jsonl')
    const outputPath = join(root, 'out.json')
    await mkdir(root, { recursive: true })
    await writeFile(ledgerPath, makeLedgerEvents([
      makeClosedPair('a', 1_000, 0.00008, 0.03, 0.4),
      makeClosedPair('b', 2_000, 0.00007, 0.025, 0.2),
      makeClosedPair('c', 3_000, 0.00006, 0.021, -0.1),
      makeClosedPair('d', 4_000, 0.00002, 0.005, -0.4),
    ]).flat().map(event => JSON.stringify(event)).join('\n'), 'utf-8')

    const report = await runEthCarryConfluenceRefinementSweep({
      ledgerPath,
      outputPath,
      fundingAbsThresholds: [0, 0.00005],
      basisAbsThresholdsPct: [0, 0.02],
      minTotalClosedOutcomes: 10,
      minVariantClosedOutcomes: 3,
      minWindowClosedOutcomes: 1,
      minWindows: 2,
      minWinRatePct: 55,
      minMeanNetPct: 0,
      maxFdrQ: 0.1,
      json: false,
    })

    expect(report.evidenceCounts.variantsTested).toBe(4)
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      trialLedger: {
        rawM: 4,
      },
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'eth_carry_confluence_refinement_sweep',
      businessStatus: 'warn',
      recordsOut: 4,
    })
  })
})

function makeLedgerEvents(pairs: Array<[unknown, unknown]>): unknown[] {
  return pairs.flatMap(pair => pair)
}

function makeClosedPair(
  id: string,
  decisionTimeMs: number,
  fundingSpread: number,
  basisSpreadDiffPct: number,
  netPct: number,
): [unknown, unknown] {
  return [
    {
      eventType: 'eth_carry_prospective_decision_open',
      observationId: id,
      decisionTime: new Date(decisionTimeMs).toISOString(),
      decisionBarTime: decisionTimeMs,
      signal: {
        direction: 'short_eth_long_btc',
      },
      pitFeatures: {
        fundingSpread,
        basisSpreadDiffPct,
      },
    },
    {
      eventType: 'eth_carry_prospective_decision_closed',
      observationId: id,
      decisionTime: new Date(decisionTimeMs).toISOString(),
      decisionBarTime: decisionTimeMs,
      label: {
        grossCarryPairReturnPct: netPct + 0.2,
        fundingCashflowPct: 0,
        routeCostPct: 0.2,
        routeCostAdjustedNetPct: netPct,
      },
    },
  ]
}
