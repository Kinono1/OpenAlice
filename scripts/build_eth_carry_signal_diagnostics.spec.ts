import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildEthCarrySignalDiagnosticsReport,
  parseEthCarrySignalDiagnosticsArgs,
  runEthCarrySignalDiagnostics,
} from './build_eth_carry_signal_diagnostics.js'

describe('build_eth_carry_signal_diagnostics', () => {
  it('parses args and keeps package script wired research-only', () => {
    expect(parseEthCarrySignalDiagnosticsArgs([
      '--featurePath',
      '/tmp/features.json',
      '--ledgerPath',
      '/tmp/ledger.jsonl',
      '--output',
      'none',
      '--minClosedOutcomes',
      '2',
      '--json',
    ])).toMatchObject({
      featurePath: '/tmp/features.json',
      ledgerPath: '/tmp/ledger.jsonl',
      outputPath: null,
      minClosedOutcomes: 2,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:signal-diagnostics']).toContain('build_eth_carry_signal_diagnostics.ts')
    expect(scripts['status:research-evidence']).toContain('build_eth_carry_signal_diagnostics.ts')
  })

  it('attributes closed ETH carry outcomes by direction and signal buckets without enabling trading', () => {
    const openA = makeOpen({
      id: 'obs-a',
      direction: 'short_eth_long_btc',
      fundingSpread: 0.00006,
      basisSpreadDiffPct: -0.02,
    })
    const closedA = makeClosed({
      id: 'obs-a',
      grossPct: -0.9,
      fundingCashflowPct: 0.006,
      routeCostPct: 0.2,
      netPct: -1.094,
    })
    const openB = makeOpen({
      id: 'obs-b',
      direction: 'long_eth_short_btc',
      fundingSpread: -0.00004,
      basisSpreadDiffPct: 0.03,
    })
    const closedB = makeClosed({
      id: 'obs-b',
      grossPct: 0.8,
      fundingCashflowPct: 0.004,
      routeCostPct: 0.2,
      netPct: 0.604,
    })

    const report = buildEthCarrySignalDiagnosticsReport({
      generatedAt: '2026-05-06T15:00:00.000Z',
      featurePath: '/repo/features.json',
      ledgerPath: '/repo/ledger.jsonl',
      featureRows: [{ featureId: 'feature-a' }],
      ledgerExists: true,
      ledgerEvents: [openA, closedA, openB, closedB],
      minClosedOutcomes: 3,
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T15:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'insufficient_closed_outcomes',
      counts: {
        featureRows: 1,
        openEvents: 2,
        closedEvents: 2,
        closedMatchedToOpen: 2,
        closedDiagnosticRows: 2,
        routeCostAdjustedRows: 2,
        fundingCashflowAccountedRows: 2,
      },
      summary: {
        meanGrossPct: -0.05,
        meanNetPct: -0.245,
        winRateGrossPct: 50,
        winRateNetPct: 50,
        bestDirectionByMeanNet: 'long_eth_short_btc',
        worstDirectionByMeanNet: 'short_eth_long_btc',
      },
    })
    expect(report.byDirection).toEqual(expect.arrayContaining([
      expect.objectContaining({
        bucketId: 'long_eth_short_btc',
        count: 1,
        meanNetPct: 0.604,
      }),
      expect.objectContaining({
        bucketId: 'short_eth_long_btc',
        count: 1,
        meanNetPct: -1.094,
      }),
    ]))
    expect(report.byFundingSpreadSign).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucketId: 'funding_spread:negative', meanNetPct: 0.604 }),
      expect.objectContaining({ bucketId: 'funding_spread:positive', meanNetPct: -1.094 }),
    ]))
    expect(report.blockerAttribution).toEqual(expect.arrayContaining([
      'mean_net_non_positive:-0.245',
    ]))
    expect(report.blockers).toEqual(expect.arrayContaining([
      'closed_outcomes_insufficient:2<3',
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
    ]))
  })

  it('writes diagnostics artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-signal-diag-'))
    const featurePath = join(root, 'features.json')
    const ledgerPath = join(root, 'ledger.jsonl')
    const outputPath = join(root, 'diagnostics.json')
    await mkdir(root, { recursive: true })
    await writeFile(featurePath, JSON.stringify({
      carryFeatureRows: [{ featureId: 'feature-a' }],
    }), 'utf-8')
    await writeFile(ledgerPath, [
      JSON.stringify(makeOpen({
        id: 'obs-a',
        direction: 'short_eth_long_btc',
        fundingSpread: 0.00006,
        basisSpreadDiffPct: -0.02,
      })),
      JSON.stringify(makeClosed({
        id: 'obs-a',
        grossPct: -0.9,
        fundingCashflowPct: 0.006,
        routeCostPct: 0.2,
        netPct: -1.094,
      })),
      '',
    ].join('\n'), 'utf-8')

    const report = await runEthCarrySignalDiagnostics({
      featurePath,
      ledgerPath,
      outputPath,
      minClosedOutcomes: 1,
      json: false,
    })

    expect(report).toMatchObject({
      status: 'diagnostic_ready',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      counts: {
        closedDiagnosticRows: 1,
      },
    })
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      status: 'diagnostic_ready',
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'eth_carry_signal_diagnostics',
      businessStatus: 'warn',
      recordsOut: 1,
    })
  })
})

function makeOpen(input: {
  id: string
  direction: 'short_eth_long_btc' | 'long_eth_short_btc'
  fundingSpread: number
  basisSpreadDiffPct: number
}) {
  return {
    eventType: 'eth_carry_prospective_decision_open',
    observationId: input.id,
    decisionTime: '2026-05-06T01:00:00.000Z',
    signal: {
      direction: input.direction,
    },
    pitFeatures: {
      fundingSpread: input.fundingSpread,
      basisSpreadDiffPct: input.basisSpreadDiffPct,
    },
  }
}

function makeClosed(input: {
  id: string
  grossPct: number
  fundingCashflowPct: number
  routeCostPct: number
  netPct: number
}) {
  return {
    eventType: 'eth_carry_prospective_decision_closed',
    observationId: input.id,
    decisionTime: '2026-05-06T01:00:00.000Z',
    closeTime: '2026-05-06T09:00:00.000Z',
    label: {
      grossCarryPairReturnPct: input.grossPct,
      carrySignalProfitableGross: input.grossPct > 0,
      fundingCashflowPct: input.fundingCashflowPct,
      routeCostPct: input.routeCostPct,
      routeCostAdjustedNetPct: input.netPct,
    },
  }
}
